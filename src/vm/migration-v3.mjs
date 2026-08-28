// CONVERSION d'un volume v2 en volume v3, EN PLACE (#101, ADR 0016, décision 8).
//
// C'est la première migration du dépôt qui touche les OCTETS. Les deux précédentes réécrivaient un
// manifeste et se contentaient de l'atomicité de l'ADR 0011 ; celle-ci doit agrandir le fichier de
// sa région d'authentification, décaler la charge entière, et sceller chaque secteur.
//
// ## Pourquoi EN PLACE, et pas par un fichier voisin
//
// Un voisin serait plus simple à reprendre — le volume ne serait touché qu'à la recopie finale —,
// mais il exigerait le DOUBLE du quota au moment précis où l'utilisateur migre un volume de
// 512 Mio, c'est-à-dire là où la place manque le plus souvent. Le surcoût de la conversion en place
// est celui du format lui-même : 6,64 %.
//
// ## Deux gestes, et leur ordre est le contrat
//
//  1. **DÉPLACER** — la charge v2 est recopiée de `a` vers `chargeOffset + a`, du DERNIER secteur au
//     premier. Comme `chargeOffset + a > a` toujours, aucune écriture d'un même passage n'atteint un
//     octet qui reste à lire.
//
//     **Il n'est pas pour autant rejouable depuis le début, et une première version de ce module le
//     croyait.** La zone d'arrivée `[chargeOffset, chargeOffset + L)` RECOUVRE la zone de départ
//     `[0, L)` dès que `chargeOffset < L`, c'est-à-dire pour tout volume plus grand que sa propre
//     région — donc pour tous. Un second passage relirait alors, dans le bas du fichier, des octets
//     déjà déplacés au lieu des octets d'origine. `tests/unit/vm-migration-v3.test.mjs` l'a montré
//     avant que ce code ne parte : le clair relu après reprise n'était plus celui du volume.
//
//     La POSITION atteinte est donc journalisée après chaque tour. Elle n'a pas besoin d'être
//     exacte, seulement conservatrice : quand la position vaut `fin`, tous les octets de `[0, fin)`
//     sont encore intacts — les tours déjà faits n'ont écrit qu'au-dessus de `chargeOffset + fin`,
//     et `chargeOffset + fin > fin`. Refaire un tour déjà fait est donc sûr, et c'est ce qui permet
//     de journaliser APRÈS l'écriture plutôt qu'avant.
//  2. **SCELLER** — chaque secteur est relu à sa nouvelle place, scellé, réécrit, et son sceau posé
//     dans la région. Ce geste n'est PAS idempotent — rescéller un secteur déjà scellé chiffrerait
//     du chiffré — mais il est **reprenable sans compteur** : un secteur déjà converti s'OUVRE, un
//     secteur encore en clair ne s'ouvre pas, et la région est à zéro avant conversion. La
//     probabilité qu'un secteur en clair passe pour scellé est celle d'une forgerie GCM, bornée par
//     l'ADR 0015 à ≈ 2^-122,6 — la même borne qui fonde tout le format.
//
// **L'ordre n'est pas seulement souhaitable, il est indispensable** : la région d'authentification
// vit dans `[512, chargeOffset)`, c'est-à-dire DANS la zone d'où le déplacement lit. Sceller avant
// d'avoir fini de déplacer détruirait la source du déplacement. C'est pourquoi l'étape franchie est
// MARQUÉE dans le journal de migration avant d'entrer dans le second geste : une reprise doit savoir
// lequel des deux refaire, et se tromper ici écrirait du clair par-dessus du chiffré.
//
// ## Ce que ce module ne fait pas
//
// Il ne journalise pas, ne révoque rien, n'inscrit aucun manifeste : l'ordre des gestes de l'ADR
// 0011 reste à `volume-migration.mjs`. Il ne connaît pas OPFS non plus — il reçoit un accès BRUT et
// un scellement, ce qui permet de l'éprouver sous Node exactement tel que le Worker l'exécute.

import { SECTOR_SIZE } from "./block-geometry.mjs";
import { isStorageError, STORAGE_ERROR_CODES } from "./storage-errors.mjs";
import { RANG_SECTEUR_DE_VOLUME } from "./scellement.mjs";
import {
  SCEAU_OCTETS,
  decoderSceau,
  dispositionV3,
  encoderEnTeteV3,
  encoderSceau,
  offsetDeCharge,
  offsetDeSceau,
} from "./volume-chiffre-format.mjs";

/**
 * Les deux gestes de la conversion, nommés parce qu'une reprise doit pouvoir dire lequel refaire.
 *
 * Ils sont inscrits dans le JOURNAL DE MIGRATION, pas déduits de l'état du fichier : la taille du
 * fichier dit que le déplacement a commencé, jamais qu'il s'est achevé.
 */
export const ETAPES_CONVERSION = Object.freeze({
  deplacement: "deplacement",
  scellement: "scellement",
});

/**
 * Secteurs déplacés ou scellés par tour.
 *
 * Ce n'est pas un lot de chiffrement — chaque secteur garde son appel et son nonce, comme le format
 * l'exige. C'est un lot d'E/S : il borne la mémoire de la conversion à ce nombre de secteurs plus la
 * région correspondante, au lieu de la laisser suivre la taille du volume.
 */
export const SECTEURS_PAR_TOUR = 512;

/**
 * Génération sous laquelle les secteurs d'un volume MIGRÉ sont scellés.
 *
 * Zéro, comme un volume qui naît : la migration ne rejoue aucune génération du guest, elle convertit
 * un état déjà rangé. Le journal de génération du volume source est écarté par l'orchestration avant
 * la conversion, précisément pour que cet état-là soit le seul.
 */
export const GENERATION_DE_CONVERSION = 0;

/**
 * DÉPLACE la charge v2 vers sa place v3, du dernier secteur au premier.
 *
 * Le sens de parcours est ce qui rend le geste sûr : chaque écriture va plus loin dans le fichier
 * que la lecture qui l'a produite, et les lectures suivantes portent sur des adresses plus basses.
 * Aucune écriture n'atteint donc un octet qui reste à lire.
 */
async function deplacerLaCharge({ brut, disposition, secteursParTour, depuisPosition, marquer }) {
  const tour = secteursParTour * SECTOR_SIZE;
  let deplaces = 0;
  for (let fin = depuisPosition; fin > 0;) {
    const debut = Math.max(0, fin - tour);
    const octets = await brut.read(debut, fin - debut);
    await brut.write(disposition.chargeOffset + debut, octets);
    deplaces += (fin - debut) / SECTOR_SIZE;
    fin = debut;
    // La position est journalisée APRÈS l'écriture, et la barrière la précède : une coupure laisse
    // donc une position au plus ÉGALE à ce qui a réellement été déplacé, jamais au-delà. Refaire un
    // tour déjà fait est sûr — voir l'en-tête —, en sauter un ne le serait pas.
    await brut.flush();
    await marquer({ etape: ETAPES_CONVERSION.deplacement, position: fin });
  }
  return deplaces;
}

/**
 * Vrai si le secteur d'adresse `adresse` est DÉJÀ converti, c'est-à-dire s'il s'ouvre.
 *
 * C'est le seul état dont la reprise a besoin, et il vit dans le fichier plutôt que dans un
 * compteur : un compteur peut mentir après une coupure, un sceau qui vérifie ne le peut pas.
 */
async function dejaScelle({ brut, disposition, scellement, adresse, generation }) {
  const sceau = decoderSceau(await brut.read(offsetDeSceau(disposition, adresse), SCEAU_OCTETS));
  if (sceau.generation !== generation) return false;
  try {
    await scellement.ouvrirBloc(
      {
        generation: sceau.generation,
        rang: RANG_SECTEUR_DE_VOLUME,
        adresse,
        longueur: SECTOR_SIZE,
      },
      {
        nonce: sceau.nonce,
        etiquette: sceau.etiquette,
        chiffre: await brut.read(offsetDeCharge(disposition, adresse), SECTOR_SIZE),
      },
      { generationMinimale: null },
    );
    return true;
  } catch (cause) {
    // SEUL un sceau refusé signifie « pas encore converti ». Tout le reste — support en panne,
    // budget de clé atteint — est un échec réel, et le traiter comme « à convertir » ferait
    // rechiffrer un volume que rien n'obligeait à toucher.
    if (isStorageError(cause, STORAGE_ERROR_CODES.sceauRefuse)) return false;
    throw cause;
  }
}

/**
 * SCELLE une SUITE CONTIGUË de secteurs encore en clair : les sceaux D'ABORD, puis les charges.
 *
 * ## L'ordre est le contrat, et l'ordre inverse perdait le clair
 *
 * La première version écrivait la charge chiffrée puis le sceau. Une coupure entre les deux — un
 * cas sur deux — laissait un secteur CHIFFRÉ sans sceau valide. La reprise le classait alors « pas
 * encore converti », puisque c'est exactement ce qu'un secteur en clair donne, et le RECHIFFRAIT :
 * le clair était perdu, aucune erreur n'était levée, la marque de scellement complet était posée et
 * le manifeste v3 inscrit. Une migration « réussie » sur un volume détruit.
 *
 * Le sceau d'abord renverse l'ambiguïté du bon côté : une coupure laisse du CLAIR sous un sceau qui
 * ne l'ouvre pas, ce que la reprise classe « pas encore converti » — et elle a raison, si bien que
 * le rescellement produit exactement ce qu'il fallait.
 *
 * ## Pourquoi par SUITES, et non secteur par secteur
 *
 * Il faut une barrière entre les sceaux et les charges, sans quoi le support peut matérialiser une
 * charge avant son sceau et l'on retombe sur l'état interdit. Une barrière par secteur ferait un
 * million de barrières pour 512 Mio — des heures. Les sceaux d'une suite d'adresses sont contigus
 * dans la région, et les charges le sont dans la charge : une suite se traite donc en deux
 * écritures et deux barrières, quelle que soit sa longueur.
 *
 * Une coupure au milieu de l'écriture des charges laisse les premiers secteurs convertis et les
 * suivants en clair, tous sous un sceau : `dejaScelle` les distingue un par un.
 *
 * **Ce que cet ordre ne couvre pas**, et qui est nommé plutôt que maquillé : une écriture DÉCHIRÉE
 * à l'intérieur d'un secteur de charge — moitié clair, moitié chiffré — ne se distingue pas d'un
 * secteur encore en clair, et serait rescellée telle quelle. Le remède est la sauvegarde, que la
 * chaîne EXIGE et VÉRIFIE avant de convertir (ADR 0011).
 */
async function scellerUneSuite({ brut, disposition, scellement, adresse, secteurs, generation }) {
  const clair = await brut.read(offsetDeCharge(disposition, adresse), secteurs * SECTOR_SIZE);
  const rescelle = await scellement.rescellerEnSecteurs({ adresse, contenu: clair, generation });

  const charges = new Uint8Array(secteurs * SECTOR_SIZE);
  const sceaux = new Uint8Array(secteurs * SCEAU_OCTETS);
  for (const [index, secteur] of rescelle.secteurs.entries()) {
    charges.set(secteur.scelle.chiffre, index * SECTOR_SIZE);
    sceaux.set(
      encoderSceau({
        nonce: secteur.scelle.nonce,
        etiquette: secteur.scelle.etiquette,
        generation,
      }),
      index * SCEAU_OCTETS,
    );
  }

  await brut.write(offsetDeSceau(disposition, adresse), sceaux);
  await brut.flush();
  await brut.write(offsetDeCharge(disposition, adresse), charges);
  await brut.flush();
}

/**
 * SCELLE toute la charge, en sautant ce qui l'est déjà.
 *
 * Le saut n'est pas une optimisation, c'est la REPRISE : rescéller un secteur déjà converti
 * chiffrerait du chiffré, et le volume serait perdu sans qu'aucune erreur ne soit levée. Les
 * secteurs restants sont regroupés en SUITES contiguës — voir `scellerUneSuite`.
 */
async function scellerLaCharge({ brut, disposition, scellement, generation, secteursParTour }) {
  let secteursScelles = 0;
  let secteursDejaScelles = 0;
  let debut = null;
  let secteurs = 0;

  const vider = async () => {
    if (debut === null) return;
    await scellerUneSuite({ brut, disposition, scellement, adresse: debut, secteurs, generation });
    secteursScelles += secteurs;
    debut = null;
    secteurs = 0;
  };

  for (let adresse = 0; adresse < disposition.tailleLogique; adresse += SECTOR_SIZE) {
    if (await dejaScelle({ brut, disposition, scellement, adresse, generation })) {
      secteursDejaScelles += 1;
      await vider();
      continue;
    }
    if (debut === null) debut = adresse;
    secteurs += 1;
    // La suite est bornée par le lot d'E/S : elle tient en mémoire le temps de deux écritures, et
    // c'est ce nombre-là qui borne cette mémoire, pas la taille du volume.
    if (secteurs === secteursParTour) await vider();
  }
  await vider();
  return { secteursScelles, secteursDejaScelles };
}

/**
 * Convertit un volume v2 en volume v3, sur place.
 *
 * @param {{ brut: object, scellement: import("./scellement.mjs").Scellement,
 *           tailleLogique: number, identifiantVolume: string,
 *           depuis?: string, generation?: number,
 *           marquerEtape: (etape: string) => Promise<void>,
 *           secteursParTour?: number }} options
 *   `brut` est un accès au FICHIER — `size`, `read`, `write`, `retailler`, `flush` — et non un
 *   backend de blocs : la conversion travaille sur des octets, pas sur un volume logique.
 *   `depuis` dit quel geste reprendre, et il vient du JOURNAL, jamais de l'état du fichier.
 * @returns {Promise<{ secteursDeplaces: number, secteursScelles: number,
 *                     secteursDejaScelles: number, tailleSupport: number }>}
 */
/**
 * Écrit l'en-tête v3, EN DERNIER, et le rend durable.
 *
 * Il est le seul octet qui dise « ce fichier est un volume v3 » ; l'écrire avant la fin ferait
 * passer pour v3 un fichier dont la charge est encore en clair, et un lecteur le croirait sur parole
 * jusqu'à ce qu'un sceau le détrompe.
 *
 * Il porte la MARQUE de scellement complet, et ici les deux partent ensemble. À la CRÉATION, elles
 * ne le peuvent pas : l'en-tête doit précéder le scellement — il faut connaître la disposition pour
 * savoir où écrire les sceaux —, si bien que la marque vient après, seule. La conversion, elle,
 * écrit l'en-tête quand tout est déjà scellé. Sans cette marque, l'ouvreur refuserait par
 * `VAULT_STORAGE_VOLUME_INCOMPLET` le volume qu'on vient de migrer.
 */
async function poserLEnTeteEnDernier({ brut, tailleLogique, identifiantVolume }) {
  await brut.write(
    0,
    encoderEnTeteV3({ tailleLogique, identifiantVolume, scellementComplet: true }),
  );
  await brut.flush();
}

export async function convertirEnV3({
  brut,
  scellement,
  tailleLogique,
  identifiantVolume,
  depuis = ETAPES_CONVERSION.deplacement,
  position = null,
  generation = GENERATION_DE_CONVERSION,
  marquerEtape,
  secteursParTour = SECTEURS_PAR_TOUR,
}) {
  const disposition = dispositionV3(tailleLogique);

  let secteursDeplaces = 0;
  if (depuis === ETAPES_CONVERSION.deplacement) {
    if (brut.size() !== disposition.tailleSupport) await brut.retailler(disposition.tailleSupport);
    secteursDeplaces = await deplacerLaCharge({
      brut,
      disposition,
      secteursParTour,
      depuisPosition: position ?? disposition.tailleLogique,
      marquer: marquerEtape,
    });
    await brut.flush();
    // La marque précède le premier sceau, et c'est tout l'enjeu : une reprise qui referait le
    // déplacement après un scellement partiel lirait la RÉGION — déjà écrite — et l'écrirait
    // par-dessus la charge. La barrière ci-dessus rend le déplacement durable avant qu'on ne le
    // déclare fait.
    await marquerEtape({ etape: ETAPES_CONVERSION.scellement, position: 0 });
  }

  const scelles = await scellerLaCharge({
    brut,
    disposition,
    scellement,
    generation,
    secteursParTour,
  });
  await poserLEnTeteEnDernier({ brut, tailleLogique, identifiantVolume });

  return Object.freeze({
    secteursDeplaces,
    ...scelles,
    tailleSupport: disposition.tailleSupport,
  });
}
