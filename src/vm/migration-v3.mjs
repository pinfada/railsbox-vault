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
import { MIGRATION_ERROR_CODES, MigrationError } from "./migration-errors.mjs";
import { isStorageError, STORAGE_ERROR_CODES } from "./storage-errors.mjs";
import { RANG_SECTEUR_DE_VOLUME } from "./scellement.mjs";
import {
  SCEAU_OCTETS,
  decoderSceau,
  dispositionV3,
  EN_TETE_OCTETS,
  MARQUEUR_SCELLEMENT_COMPLET,
  SCELLEMENT_COMPLET_OFFSET,
  decoderEnTeteV3,
  encoderEnTeteV3,
  encoderSceau,
  identifiantVolumeEnTexte,
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
 * un état déjà rangé.
 *
 * Cet état-là est bien le seul parce que l'orchestration SOLDE le journal de génération du volume
 * source avant la conversion — elle reporte dans le volume ce qu'il avait validé, puis l'écarte
 * (`volume-migration.mjs`, geste 7 bis). Cette phrase a longtemps été écrite ici alors qu'aucun
 * code ne la tenait ; la revue de #110 l'a relevé, et deux épreuves la tiennent maintenant.
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
/**
 * FAIL-CLOSED : sous la position journalisée, tout secteur DOIT s'ouvrir.
 *
 * Qu'il ne s'ouvre pas admet deux lectures — « il reste du clair », et le rescéller est juste ;
 * « il porte du chiffré qu'on ne sait plus ouvrir », et le rescéller le détruit — que rien ne
 * distingue. On refuse donc, et ce garde attrape ce que l'ordre sceau-puis-charge ne couvre pas :
 * l'écriture DÉCHIRÉE d'un secteur de charge, moitié clair moitié chiffré.
 */
function assertSecteurNonDeclareConverti(adresse, dejaTraiteJusqua) {
  if (adresse >= dejaTraiteJusqua) return;
  throw new MigrationError(
    MIGRATION_ERROR_CODES.conversionIncoherente,
    `Reprise refusée : le secteur d'adresse ${adresse} est déclaré déjà converti par le journal et ne s'ouvre pas. Le rescéller le détruirait s'il portait du chiffré, et rien ne permet de trancher. Le remède est la sauvegarde exigée avant la migration.`,
    { adresse, dejaTraiteJusqua },
  );
}

async function scellerLaCharge({
  brut,
  disposition,
  scellement,
  generation,
  secteursParTour,
  dejaTraiteJusqua = 0,
  marquerEtape,
}) {
  let secteursScelles = 0;
  let secteursDejaScelles = 0;
  let debut = null;
  let secteurs = 0;

  const vider = async (jusqua) => {
    if (debut === null) return;
    await scellerUneSuite({ brut, disposition, scellement, adresse: debut, secteurs, generation });
    secteursScelles += secteurs;
    debut = null;
    secteurs = 0;
    // La POSITION est journalisée après la barrière de la suite : elle ne déclare donc jamais plus
    // que ce que le support porte. C'est elle que le fail-closed ci-dessous relit à la reprise.
    await marquerEtape({ etape: ETAPES_CONVERSION.scellement, position: jusqua });
  };

  for (let adresse = 0; adresse < disposition.tailleLogique; adresse += SECTOR_SIZE) {
    if (await dejaScelle({ brut, disposition, scellement, adresse, generation })) {
      secteursDejaScelles += 1;
      await vider(adresse);
      continue;
    }
    assertSecteurNonDeclareConverti(adresse, dejaTraiteJusqua);
    if (debut === null) debut = adresse;
    secteurs += 1;
    // La suite est bornée par le lot d'E/S : elle tient en mémoire le temps de deux écritures, et
    // c'est ce nombre-là qui borne cette mémoire, pas la taille du volume.
    if (secteurs === secteursParTour) await vider(adresse + SECTOR_SIZE);
  }
  await vider(disposition.tailleLogique);
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
 * Écrit l'en-tête v3 — SANS la marque de scellement complet — dès que le déplacement est fini.
 *
 * ## Pourquoi pas plus tôt, et pourquoi pas plus tard
 *
 * **Pas plus tôt** : l'en-tête occupe le premier secteur, que le déplacement lit EN DERNIER (il
 * remonte du dernier secteur au premier). L'écrire avant la fin du déplacement détruirait la source
 * de son propre geste.
 *
 * **Pas plus tard** : l'en-tête porte l'identifiant du volume, celui-là même qui entre dans les
 * données associées de chaque secteur scellé. Tant qu'il n'est pas sur le disque, le journal de
 * migration est la SEULE chose qui dise sous quelle identité on scelle — et un journal qui ment
 * fait rescéller du chiffré comme du clair. En le posant avant le premier sceau, on donne à la
 * reprise un second témoin, sur le support lui-même.
 *
 * ## Pourquoi c'est sûr d'annoncer « v3 » avant d'avoir scellé
 *
 * Parce que l'en-tête ne porte PAS encore la marque de scellement complet, et qu'un fichier v3 sans
 * cette marque est refusé par l'ouvreur (`VAULT_STORAGE_VOLUME_INCOMPLET`, tranche (a) de #18). Le
 * fichier ne peut donc pas passer pour un volume utilisable ; il dit exactement ce qu'il est : une
 * conversion en cours.
 */
async function poserLEnTete({ brut, tailleLogique, identifiantVolume }) {
  await brut.write(0, encoderEnTeteV3({ tailleLogique, identifiantVolume }));
  await brut.flush();
}

/** Pose la MARQUE de scellement complet — huit octets — et la rend durable. Dernier geste. */
async function marquerScellementComplet(brut) {
  await brut.write(SCELLEMENT_COMPLET_OFFSET, MARQUEUR_SCELLEMENT_COMPLET);
  await brut.flush();
}

/**
 * RECOUPE l'identifiant du journal avec celui que le support porte, avant de sceller quoi que ce
 * soit.
 *
 * L'empreinte du journal dit qu'il n'a pas été abîmé ; elle ne dit rien de sa VÉRITÉ. Un journal
 * réécrit d'un bloc serait cohérent avec lui-même. L'en-tête v3, lui, a été écrit par la conversion
 * elle-même, à la fin du déplacement et avant le premier sceau : les deux récits doivent coïncider.
 *
 * Deux divergences, un seul verdict — le refus. On ne reprend pas une conversion sur deux récits qui
 * se contredisent : reprendre au récit choisi au hasard rescellerait du chiffré comme du clair.
 */
async function recouperLIdentifiant({ brut, identifiantVolume }) {
  const lu = decoderEnTeteV3(await brut.read(0, EN_TETE_OCTETS));
  if (!lu.valide) {
    throw new MigrationError(
      MIGRATION_ERROR_CODES.conversionIncoherente,
      `Reprise refusée : le journal déclare une conversion au stade du scellement, et le support ne porte pas d'en-tête v3 lisible (${lu.raison}). La conversion pose cet en-tête avant le premier sceau : son absence contredit le journal. Aucun octet n'est écrit.`,
      { raison: lu.raison },
    );
  }
  const porte = identifiantVolumeEnTexte(lu.enTete.identifiantVolume);
  if (porte === identifiantVolume) return;
  throw new MigrationError(
    MIGRATION_ERROR_CODES.conversionIncoherente,
    `Reprise refusée : le journal déclare l'identifiant de volume ${identifiantVolume} et l'en-tête v3 du support en porte un autre (${porte}). Les secteurs déjà scellés le sont sous celui du support ; reprendre sous celui du journal les rescellerait comme s'ils étaient en clair. Aucun octet n'est écrit.`,
    { journal: identifiantVolume, support: porte },
  );
}

/**
 * PREMIER GESTE : allouer, déplacer la charge, poser l'en-tête, puis déclarer le geste franchi.
 *
 * L'ordre des trois barrières est le contrat : le déplacement est durable avant que l'en-tête ne
 * soit posé, et l'en-tête est durable avant que le journal ne déclare qu'on entre dans le
 * scellement. Une reprise qui trouve « scellement » trouve donc toujours l'en-tête.
 */
async function deplacerPuisAnnoncerV3({
  brut,
  disposition,
  secteursParTour,
  position,
  tailleLogique,
  identifiantVolume,
  marquerEtape,
}) {
  if (brut.size() !== disposition.tailleSupport) await brut.retailler(disposition.tailleSupport);
  const secteursDeplaces = await deplacerLaCharge({
    brut,
    disposition,
    secteursParTour,
    depuisPosition: position ?? disposition.tailleLogique,
    marquer: marquerEtape,
  });
  await brut.flush();
  await poserLEnTete({ brut, tailleLogique, identifiantVolume });
  // Une reprise qui referait le déplacement après un scellement partiel lirait la RÉGION — déjà
  // écrite — et l'écrirait par-dessus la charge. Les barrières ci-dessus rendent le déplacement ET
  // l'en-tête durables avant qu'on ne déclare le geste fait.
  await marquerEtape({ etape: ETAPES_CONVERSION.scellement, position: 0 });
  return secteursDeplaces;
}

/** REPRISE au scellement : rien à déplacer, mais les deux récits doivent d'abord se recouper. */
async function reprendreAuScellement({ brut, identifiantVolume }) {
  await recouperLIdentifiant({ brut, identifiantVolume });
  return 0;
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

  const secteursDeplaces =
    depuis === ETAPES_CONVERSION.deplacement
      ? await deplacerPuisAnnoncerV3({
          brut,
          disposition,
          secteursParTour,
          position,
          tailleLogique,
          identifiantVolume,
          marquerEtape,
        })
      : await reprendreAuScellement({ brut, identifiantVolume });

  const scelles = await scellerLaCharge({
    brut,
    disposition,
    scellement,
    generation,
    secteursParTour,
    dejaTraiteJusqua: depuis === ETAPES_CONVERSION.scellement ? (position ?? 0) : 0,
    marquerEtape,
  });
  await marquerScellementComplet(brut);

  return Object.freeze({
    secteursDeplaces,
    ...scelles,
    tailleSupport: disposition.tailleSupport,
  });
}
