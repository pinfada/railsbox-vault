// CONVERSION d'un volume v3 en volume v4, EN PLACE (#182, ADR 0033, décision 5).
//
// C'est la migration la plus lourde que ce dépôt ait tentée : **chaque secteur est RESCELLÉ** sous
// la clé du domaine `volume` de la v4, parce qu'aucune clé ne traverse une version de format
// (ADR 0033, décision 3, champ 4 de l'info). Pour un volume de 512 Mio, cela fait 2^20 ouvertures
// sous la clé v3 et 2^20 scellements sous la clé v4.
//
// C'est aussi le SEUL geste du produit qui tienne les deux clés à la fois, et c'est pourquoi il est
// l'unique exception nommée du cliquet anti-DEK que T2b posera.
//
// ## Ce qui ne bouge pas, et pourquoi la conversion est si courte
//
// La GÉOMÉTRIE est celle de v3 : même en-tête d'un secteur, même région de 34 octets par secteur,
// même charge à la même place. Il n'y a donc RIEN à déplacer — contrairement à v2 → v3, dont la
// moitié du code était le déplacement de la charge et sa reprise. Deux gestes seulement :
//
//  1. **RESCELLER** chaque secteur : l'ouvrir sous la clé v3, le sceller sous la clé v4, écrire son
//     sceau puis sa charge ;
//  2. **POSER L'EN-TÊTE v4**, en dernier, avec sa marque de scellement complet.
//
// ## Le problème que v2 → v3 n'avait pas, et comment il est fermé
//
// En v2 → v3, l'un des deux états d'un secteur — le clair — était RESCELLABLE à l'infini : une
// coupure pouvait laisser du clair sous un sceau qui ne l'ouvrait pas, et la reprise avait raison de
// le rescéller. Ici, les deux états sont des chiffrés sous deux clés différentes, et **le sceau et
// la charge doivent changer ENSEMBLE**. Aucun ordre d'écriture ne suffit à lui seul :
//
//  - sceau v4 d'abord, puis charge : une coupure entre les deux laisse une charge v3 sous un sceau
//    v4. La charge s'ouvrirait encore sous la clé v3 — mais son sceau v3 a été écrasé, et il est le
//    nonce et l'étiquette sans lesquels rien ne s'ouvre ;
//  - charge d'abord, puis sceau : une coupure laisse une charge v4 sous un sceau v3, et le sceau v4
//    n'existe nulle part. Le secteur est perdu.
//
// La réponse est une **ÉCRITURE ANTICIPÉE**, et elle est bon marché : avant de toucher la suite de
// secteurs en vol, la conversion inscrit dans le journal de migration les SCEAUX v3 de cette suite —
// trente-quatre octets par secteur, 6,6 % de ce qu'elle réécrit. Elle écrit ensuite les sceaux v4,
// puis les charges v4. Une reprise dispose alors, pour chaque secteur de la suite en vol, des DEUX
// sceaux possibles, et peut trancher :
//
//     ouvre sous (clé v4, sceau du support)      → converti, il n'y a rien à faire
//     ouvre sous (clé v3, sceau v3 journalisé)   → charge encore v3, sceau déjà v4 : rescéller
//     ouvre sous (clé v3, sceau du support)      → rien n'a encore été écrit : convertir
//     n'ouvre sous aucun des trois               → écriture DÉCHIRÉE : REFUS, la sauvegarde
//
// Le dernier cas est le FAIL-CLOSED de v2 → v3, à l'identique : une ambiguïté qu'on ne sait pas
// trancher ne se tranche pas au hasard, et la chaîne de migration EXIGE et VÉRIFIE une sauvegarde
// avant de convertir (ADR 0011).
//
// **La reprise ne relit JAMAIS le volume entier** : elle reprend au rang journalisé, et ne rejoue
// que la suite en vol. C'est la condition d'abandon écrite dans la DoR de #182, et elle est tenue.
//
// ## Ce que ce module ne fait pas
//
// Il ne journalise pas, ne révoque rien, n'inscrit aucun manifeste : l'ordre des gestes de l'ADR
// 0011 reste à `volume-migration.mjs`. Il ne connaît pas OPFS non plus — il reçoit un accès BRUT et
// deux scellements, ce qui permet de l'éprouver sous Node exactement tel que le Worker l'exécute.

import { SECTOR_SIZE } from "./block-geometry.mjs";
import { MIGRATION_ERROR_CODES, MigrationError } from "./migration-errors.mjs";
import { isStorageError, STORAGE_ERROR_CODES } from "./storage-errors.mjs";
import { RANG_SECTEUR_DE_VOLUME } from "./scellement.mjs";
import { octetsEnHex, hexEnOctets } from "./format-chiffre/octets.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_V3,
  FORMAT_VOLUME_V4,
  SCEAU_OCTETS,
  decoderEnTeteV3,
  decoderEnTeteV4,
  decoderSceau,
  dispositionDuVolume,
  encoderEnTeteV4,
  encoderSceau,
  identifiantVolumeEnTexte,
  offsetDeCharge,
  offsetDeSceau,
} from "./volume-chiffre-format.mjs";

/**
 * Les deux gestes de la conversion, nommés parce qu'une reprise doit pouvoir dire lequel refaire.
 *
 * `rescellement` couvre toute la charge ; `enTete` est le dernier geste, celui qui déclare le
 * fichier v4. Ils sont inscrits dans le JOURNAL DE MIGRATION, jamais déduits de l'état du fichier :
 * l'en-tête v3 reste en place jusqu'au bout, et il ne dit donc rien de l'avancement.
 */
export const ETAPES_V4 = Object.freeze({
  rescellement: "rescellement-v4",
  enTete: "en-tete-v4",
});

/**
 * Secteurs rescellés par tour.
 *
 * Ce n'est pas un lot de chiffrement — chaque secteur garde son appel et son nonce, comme le format
 * l'exige. C'est un lot d'E/S, et il borne DEUX choses : la mémoire de la conversion, et la taille
 * de l'écriture anticipée que le journal porte (512 × 34 = 17 408 octets).
 */
export const SECTEURS_PAR_TOUR = 512;

/**
 * Génération sous laquelle les secteurs d'un volume converti en v4 sont rescellés.
 *
 * **Celle du secteur v3, conservée.** La conversion ne rejoue aucune génération du guest et n'en
 * invente aucune : elle change la CLÉ, pas l'histoire. Conserver la génération garde vraie la
 * propriété que la fraîcheur de l'ADR 0019 relit — l'empreinte de région est rescellée par la racine
 * initiale que la migration écrit ensuite — et évite d'avoir à réécrire la génération de chaque
 * sceau, qui est authentifiée dans les données associées.
 */
export function generationDuSecteur(sceau) {
  return sceau.generation;
}

/** Dit si un secteur s'ouvre sous une clé et un sceau donnés, sans rien écrire. */
async function souvreSous({ scellement, adresse, sceau, chiffre }) {
  try {
    return await scellement.ouvrirBloc(
      {
        generation: sceau.generation,
        rang: RANG_SECTEUR_DE_VOLUME,
        adresse,
        longueur: SECTOR_SIZE,
      },
      { nonce: sceau.nonce, etiquette: sceau.etiquette, chiffre },
      { generationMinimale: null },
    );
  } catch (cause) {
    // SEUL un sceau refusé signifie « pas cet état-là ». Tout le reste — support en panne, budget de
    // clé atteint — est un échec réel, et le traiter comme « à convertir » ferait rescéller un
    // volume que rien n'obligeait à toucher.
    if (isStorageError(cause, STORAGE_ERROR_CODES.sceauRefuse)) return null;
    throw cause;
  }
}

/**
 * L'ÉCRITURE ANTICIPÉE d'une suite : les sceaux v3 des secteurs qu'on s'apprête à écraser.
 *
 * Elle voyage dans le journal de migration, en hexadécimal, parce que le journal est un JSON réécrit
 * d'un bloc — donc atomique — et qu'ouvrir un voisin de plus aurait coûté un nom, un balayage
 * d'orphelins et une place dans l'archive pour dix-sept kilo-octets.
 *
 * **Ces octets ne sont pas un secret** : un sceau est un nonce et une étiquette, et les deux vivent
 * déjà en clair dans la région d'authentification du volume. Ce qu'ils portent est la capacité de
 * RELIRE un secteur v3 dont le sceau a été écrasé — c'est-à-dire exactement ce qu'une reprise doit
 * pouvoir faire, et rien de plus : sans la clé, ils n'ouvrent rien.
 */
export function encoderTampon({ rang, secteurs, sceaux }) {
  return Object.freeze({ rang, secteurs, sceauxV3: octetsEnHex(sceaux) });
}

/** Relit l'écriture anticipée d'une suite, ou `null` si le journal n'en porte pas pour ce rang. */
export function decoderTampon(tampon, rang) {
  if (tampon === null || tampon === undefined) return null;
  if (tampon.rang !== rang) return null;
  const sceaux = hexEnOctets(tampon.sceauxV3);
  if (sceaux.byteLength !== tampon.secteurs * SCEAU_OCTETS) {
    throw new MigrationError(
      MIGRATION_ERROR_CODES.conversionIncoherente,
      `Reprise refusée : l'écriture anticipée du journal déclare ${tampon.secteurs} secteur(s) et porte ${sceaux.byteLength} octet(s) de sceaux au lieu de ${tampon.secteurs * SCEAU_OCTETS}. Sans elle, les secteurs de la suite en vol dont le sceau a été écrasé ne se relisent plus. Aucun octet n'est écrit.`,
      { rang, secteurs: tampon.secteurs, octets: sceaux.byteLength },
    );
  }
  return Object.freeze({ rang, secteurs: tampon.secteurs, sceaux });
}

/**
 * TROUVE le clair d'un secteur, quel que soit l'état où la coupure l'a laissé.
 *
 * Les trois états sont essayés dans l'ordre du moins coûteux au plus improbable, et le verdict de
 * chacun est une OUVERTURE réussie — jamais une déduction sur la taille, la position ou un compteur.
 * La probabilité qu'un état passe pour un autre est celle d'une forgerie GCM, bornée par l'ADR 0015
 * à ≈ 2^-122,6 : la même borne qui fonde tout le format.
 *
 * @returns {Promise<{ etat: string, clair: Uint8Array, generation: number } | null>}
 *   `null` dit « aucun des trois », c'est-à-dire une écriture DÉCHIRÉE.
 *   `repris` dit si la suite est celle qui était EN VOL à la coupure. Hors reprise, deux des trois
 *   états sont impossibles, et les sonder coûterait une ouverture GCM par secteur pour rien.
 */
async function etatDuSecteur({ brut, disposition, v3, v4, adresse, sceauV3Anticipe, repris }) {
  const sceauDuSupport = decoderSceau(
    await brut.read(offsetDeSceau(disposition, adresse), SCEAU_OCTETS),
  );
  const chiffre = await brut.read(offsetDeCharge(disposition, adresse), SECTOR_SIZE);

  // **Une suite qui n'est PAS reprise est entièrement v3, et il n'y a rien à chercher d'autre.**
  // Rien n'y a été écrit : ni sceau, ni charge. Sonder la clé v4 y coûterait une ouverture GCM par
  // secteur — 2^20 pour 512 Mio — pour un état que le journal exclut. Ce n'est pas une optimisation
  // prudente, c'est une conséquence de l'ordre des barrières : les octets d'une suite ne changent
  // qu'APRÈS que son écriture anticipée est durable, et c'est elle qui marque la suite « reprise ».
  if (repris) {
    const dejaV4 = await souvreSous({ scellement: v4, adresse, sceau: sceauDuSupport, chiffre });
    if (dejaV4 !== null) {
      return { etat: "converti", clair: dejaV4, generation: sceauDuSupport.generation };
    }
  }

  const encoreV3 = await souvreSous({ scellement: v3, adresse, sceau: sceauDuSupport, chiffre });
  if (encoreV3 !== null) {
    return { etat: "intact", clair: encoreV3, generation: sceauDuSupport.generation };
  }

  // Le sceau v3 a été écrasé par un sceau v4 dont la charge n'a pas suivi : c'est l'état que
  // l'écriture anticipée existe pour rattraper, et le SEUL qu'elle rattrape.
  if (sceauV3Anticipe !== null) {
    const parLeTampon = await souvreSous({
      scellement: v3,
      adresse,
      sceau: sceauV3Anticipe,
      chiffre,
    });
    if (parLeTampon !== null) {
      return { etat: "sceau-devance", clair: parLeTampon, generation: sceauV3Anticipe.generation };
    }
  }
  return null;
}

/**
 * EXIGE que l'écriture anticipée reprise décrive bien la suite qu'on s'apprête à traiter.
 *
 * Un tampon d'une AUTRE longueur que la suite ne couvrirait pas tous ses secteurs, et ceux qu'il ne
 * couvre pas seraient jugés « déchirés » alors qu'ils sont intacts. Le refuser vaut mieux que de le
 * tronquer : reprendre sur un tampon partiel, c'est reprendre sur un récit incomplet.
 */
function exigerTamponDeLaSuite(tampon, secteurs, rang) {
  if (tampon === null) return null;
  if (tampon.secteurs === secteurs) return tampon;
  throw new MigrationError(
    MIGRATION_ERROR_CODES.conversionIncoherente,
    `Reprise refusée : le journal porte une écriture anticipée de ${tampon.secteurs} secteur(s) pour le rang ${rang}, et la suite reprise en compte ${secteurs}. Les deux récits se contredisent sur ce qui était en vol. Aucun octet n'est écrit.`,
    { rang, journal: tampon.secteurs, suite: secteurs },
  );
}

/** Refus FAIL-CLOSED d'un secteur qu'aucun des trois états n'explique. */
function secteurIndechiffrable(adresse) {
  return new MigrationError(
    MIGRATION_ERROR_CODES.conversionIncoherente,
    `Conversion refusée : le secteur d'adresse ${adresse} ne s'ouvre ni sous la clé du volume v${FORMAT_VOLUME_V3}, ni sous celle de la v${FORMAT_VOLUME_V4}, ni sous le sceau que le journal avait mis de côté. C'est la signature d'une écriture DÉCHIRÉE — un secteur à moitié réécrit —, et rien ne permet de le trancher : le rescéller détruirait ce qu'il porte. Le remède est la sauvegarde que la chaîne exige et vérifie avant de convertir.`,
    { adresse },
  );
}

/**
 * RESCELLE une SUITE de secteurs : écriture anticipée, puis sceaux, puis charges.
 *
 * ## L'ordre, et ce que chaque barrière achète
 *
 *  1. les sceaux v3 de la suite sont JOURNALISÉS et rendus durables. Tant que ce geste n'a pas
 *     abouti, rien n'a été écrit dans le volume : une reprise trouve la suite intacte ;
 *  2. les sceaux v4 sont écrits, puis une barrière. Une coupure ici laisse des charges v3 sous des
 *     sceaux v4 — l'état que le tampon rattrape ;
 *  3. les charges v4 sont écrites, puis une barrière. Une coupure ici laisse une suite MIXTE, que
 *     `etatDuSecteur` démêle secteur par secteur ;
 *  4. le rang atteint est journalisé. Il ne déclare donc jamais plus que ce que le support porte.
 *
 * Une barrière par SECTEUR aurait fait un million de barrières pour 512 Mio — des heures. Les sceaux
 * d'une suite d'adresses sont contigus dans la région, et les charges le sont dans la charge : une
 * suite se traite donc en deux écritures et deux barrières, quelle que soit sa longueur.
 */
/**
 * CALCULE les octets v4 d'UN secteur de la suite : son état, puis son rescellement.
 *
 * Rendu séparément du parcours de la suite parce que c'est ici que vit la seule décision du geste —
 * trois états s'ouvrent, le quatrième est une déchirure — et qu'un secteur DÉJÀ converti n'a rien à
 * rescéller : ses octets sont les bons, et les rescéller consommerait un scellement pour rien.
 */
async function octetsV4DuSecteur({ brut, disposition, v3, v4, adresse, sceauV3Anticipe, repris }) {
  const etat = await etatDuSecteur({
    brut,
    disposition,
    v3,
    v4,
    adresse,
    sceauV3Anticipe,
    repris,
  });
  if (etat === null) throw secteurIndechiffrable(adresse);
  if (etat.etat === "converti") {
    return {
      dejaConverti: true,
      charge: await brut.read(offsetDeCharge(disposition, adresse), SECTOR_SIZE),
      sceau: await brut.read(offsetDeSceau(disposition, adresse), SCEAU_OCTETS),
    };
  }
  const scelle = await v4.scellerBloc(
    { generation: etat.generation, rang: RANG_SECTEUR_DE_VOLUME, adresse, longueur: SECTOR_SIZE },
    etat.clair,
  );
  return {
    dejaConverti: false,
    charge: scelle.chiffre,
    sceau: encoderSceau({
      nonce: scelle.nonce,
      etiquette: scelle.etiquette,
      generation: etat.generation,
    }),
  };
}

/**
 * ASSEMBLE les octets v4 de toute la suite, secteur par secteur, en DEUX tampons.
 *
 * Deux tampons et non deux mille écritures : les sceaux d'une suite d'adresses sont contigus dans la
 * région, et les charges le sont dans la charge. Un secteur déjà converti y est RECOPIÉ tel quel,
 * pour que l'écriture de la suite reste UNE écriture — la découper autour des secteurs déjà faits
 * rendrait le nombre de barrières dépendant de l'endroit où la coupure est tombée.
 */
async function assemblerLaSuite({
  brut,
  disposition,
  v3,
  v4,
  adresse,
  secteurs,
  sceauxV3,
  repris,
}) {
  const charges = new Uint8Array(secteurs * SECTOR_SIZE);
  const sceaux = new Uint8Array(secteurs * SCEAU_OCTETS);
  let rescelles = 0;
  let dejaConvertis = 0;

  for (let index = 0; index < secteurs; index += 1) {
    const octets = await octetsV4DuSecteur({
      brut,
      disposition,
      v3,
      v4,
      adresse: adresse + index * SECTOR_SIZE,
      sceauV3Anticipe: decoderSceau(sceauxV3.subarray(index * SCEAU_OCTETS)),
      repris,
    });
    charges.set(octets.charge, index * SECTOR_SIZE);
    sceaux.set(octets.sceau, index * SCEAU_OCTETS);
    if (octets.dejaConverti) dejaConvertis += 1;
    else rescelles += 1;
  }
  return { charges, sceaux, rescelles, dejaConvertis };
}

/**
 * D'où viennent les sceaux v3 d'une suite : du JOURNAL sur une reprise, de la RÉGION sinon.
 *
 * L'ordre n'est pas une préférence. Sur une suite reprise, la région peut déjà avoir reçu des sceaux
 * v4 : la lire donnerait ceux-là, et l'écriture anticipée ne rattraperait plus rien. Hors reprise,
 * rien n'a été écrit et la région les porte encore intacts.
 */
async function sceauxV3DeLaSuite({ brut, disposition, adresse, secteurs, tampon }) {
  if (tampon !== null) return tampon.sceaux;
  return brut.read(offsetDeSceau(disposition, adresse), secteurs * SCEAU_OCTETS);
}

async function rescellerUneSuite({
  brut,
  disposition,
  v3,
  v4,
  adresse,
  secteurs,
  tampon,
  marquerEtape,
}) {
  const rang = adresse / SECTOR_SIZE;
  const sceauxV3 = await sceauxV3DeLaSuite({ brut, disposition, adresse, secteurs, tampon });

  // 1. L'ÉCRITURE ANTICIPÉE, avant le premier octet écrit dans le volume. Réécrite telle quelle sur
  // une reprise : la réinscrire coûte un journal, l'omettre coûterait la suite si la reprise
  // elle-même était coupée.
  await marquerEtape({
    etape: ETAPES_V4.rescellement,
    position: rang,
    tampon: encoderTampon({ rang, secteurs, sceaux: sceauxV3 }),
  });

  const assemblee = await assemblerLaSuite({
    brut,
    disposition,
    v3,
    v4,
    adresse,
    secteurs,
    sceauxV3,
    repris: tampon !== null,
  });

  // 2. LES SCEAUX v4, puis la barrière. 3. LES CHARGES v4, puis la barrière.
  await brut.write(offsetDeSceau(disposition, adresse), assemblee.sceaux);
  await brut.flush();
  await brut.write(offsetDeCharge(disposition, adresse), assemblee.charges);
  await brut.flush();

  // 4. LE RANG ATTEINT. Le tampon est VIDÉ du même geste : la suite est durable, il n'a plus rien à
  // rattraper, et le laisser ferait rejouer une reprise sur des sceaux qui n'ouvrent plus rien.
  await marquerEtape({
    etape: ETAPES_V4.rescellement,
    position: rang + secteurs,
    tampon: null,
  });
  return { rescelles: assemblee.rescelles, dejaConvertis: assemblee.dejaConvertis };
}

/**
 * RESCELLE toute la charge, suite par suite, en reprenant au rang journalisé.
 *
 * Le rang de reprise n'est pas une optimisation : c'est ce qui rend la reprise possible SANS relire
 * le volume entier. En dessous de lui, tout secteur est converti — et la première suite reprise est
 * la seule dont l'état soit incertain, parce qu'elle est celle qui était en vol.
 */
async function rescellerLaCharge({
  brut,
  disposition,
  v3,
  v4,
  secteursParTour,
  depuisRang,
  tampon,
  marquerEtape,
}) {
  let rescelles = 0;
  let dejaConvertis = 0;
  const secteursTotal = disposition.tailleLogique / SECTOR_SIZE;

  for (let rang = depuisRang; rang < secteursTotal; rang += secteursParTour) {
    const secteurs = Math.min(secteursParTour, secteursTotal - rang);
    const compte = await rescellerUneSuite({
      brut,
      disposition,
      v3,
      v4,
      adresse: rang * SECTOR_SIZE,
      secteurs,
      // La suite REPRISE est la seule qui reçoive l'écriture anticipée du journal : c'est la seule
      // dont des sceaux ont pu être écrasés sans que leur charge suive.
      tampon: rang === depuisRang ? exigerTamponDeLaSuite(tampon, secteurs, rang) : null,
      marquerEtape,
    });
    rescelles += compte.rescelles;
    dejaConvertis += compte.dejaConvertis;
  }
  return { secteursRescelles: rescelles, secteursDejaConvertis: dejaConvertis };
}

/**
 * RECOUPE l'identifiant du journal avec celui que le support porte, avant de sceller quoi que ce
 * soit.
 *
 * L'empreinte du journal dit qu'il n'a pas été abîmé ; elle ne dit rien de sa VÉRITÉ. Un journal
 * réécrit d'un bloc serait cohérent avec lui-même. L'en-tête, lui, a été écrit par la création ou
 * par la migration précédente : les deux récits doivent coïncider.
 *
 * Il est lu en v3 OU en v4 : la conversion pose son en-tête v4 en DERNIER, si bien qu'une reprise
 * qui trouve encore l'en-tête v3 est normale, et qu'une reprise qui trouve déjà le v4 reprend un
 * dernier geste interrompu.
 */
function recouperLIdentifiant({ octets, identifiantVolume }) {
  const lu = decoderEnTeteV4(octets).valide ? decoderEnTeteV4(octets) : decoderEnTeteV3(octets);
  if (!lu.valide) {
    throw new MigrationError(
      MIGRATION_ERROR_CODES.conversionIncoherente,
      `Conversion refusée : le support ne porte pas d'en-tête de volume lisible (${lu.raison}). Une conversion vers v${FORMAT_VOLUME_V4} part d'un volume v${FORMAT_VOLUME_V3} valide, pas d'un fichier dont on ignore la disposition. Aucun octet n'est écrit.`,
      { raison: lu.raison },
    );
  }
  const porte = identifiantVolumeEnTexte(lu.enTete.identifiantVolume);
  if (porte === identifiantVolume) return lu.enTete;
  throw new MigrationError(
    MIGRATION_ERROR_CODES.conversionIncoherente,
    `Conversion refusée : le manifeste déclare l'identifiant de volume ${identifiantVolume} et l'en-tête du support en porte un autre (${porte}). L'identifiant entre dans l'INFO HKDF de la clé du domaine « volume » : rescéller sous celui du manifeste tirerait une clé qui n'ouvre aucun des secteurs déjà là. Aucun octet n'est écrit.`,
    { manifeste: identifiantVolume, support: porte },
  );
}

/**
 * POSE l'en-tête v4, marque de scellement complet comprise. DERNIER geste de la conversion.
 *
 * **Pas plus tôt.** L'en-tête est le seul endroit du fichier qui dise quelle version le volume
 * porte, et le poser avant la fin du rescellement ferait passer pour v4 un volume dont la moitié des
 * secteurs est encore scellée sous la clé v3. Contrairement à v2 → v3, il n'y a aucune raison de le
 * poser tôt : l'identifiant de volume est déjà sur le support, écrit par l'en-tête v3, et la reprise
 * y trouve donc son second témoin sans qu'on ait rien à avancer.
 *
 * La MARQUE est posée du même geste, et c'est sûr : à ce point tous les secteurs sont v4.
 */
async function poserLEnTeteV4({ brut, tailleLogique, identifiantVolume }) {
  await brut.write(
    0,
    encoderEnTeteV4({ tailleLogique, identifiantVolume, scellementComplet: true }),
  );
  await brut.flush();
}

/**
 * Convertit un volume v3 en volume v4, sur place.
 *
 * @param {{ brut: object, scellementV3: import("./scellement.mjs").Scellement,
 *           scellementV4: import("./scellement.mjs").Scellement,
 *           tailleLogique: number, identifiantVolume: string,
 *           depuis?: string, position?: number | null, tampon?: object | null,
 *           marquerEtape: (avancement: object) => Promise<void>,
 *           secteursParTour?: number }} options
 *   `brut` est un accès au FICHIER — `size`, `read`, `write`, `flush` — et non un backend de blocs :
 *   la conversion travaille sur des octets, pas sur un volume logique.
 *   `depuis` et `position` viennent du JOURNAL, jamais de l'état du fichier.
 * @returns {Promise<{ secteursRescelles: number, secteursDejaConvertis: number,
 *                     tailleSupport: number }>}
 */
export async function convertirEnV4({
  brut,
  scellementV3,
  scellementV4,
  tailleLogique,
  identifiantVolume,
  depuis = ETAPES_V4.rescellement,
  position = null,
  tampon = null,
  marquerEtape,
  secteursParTour = SECTEURS_PAR_TOUR,
}) {
  const disposition = dispositionDuVolume(tailleLogique);
  if (brut.size() !== disposition.tailleSupport) {
    throw new MigrationError(
      MIGRATION_ERROR_CODES.conversionIncoherente,
      `Conversion refusée : le fichier fait ${brut.size()} octets et la disposition d'un volume de ${tailleLogique} octets en impose ${disposition.tailleSupport}. La v${FORMAT_VOLUME_V4} ne change pas la géométrie : un fichier d'une autre taille n'est pas le volume qu'on croit convertir.`,
      { observee: brut.size(), attendue: disposition.tailleSupport },
    );
  }
  recouperLIdentifiant({ octets: await brut.read(0, EN_TETE_OCTETS), identifiantVolume });

  // Une reprise au DERNIER geste n'a plus rien à rescéller : toute la charge est v4, et seul
  // l'en-tête manque. Reprendre au rescellement dans ce cas serait un balayage complet pour rien.
  const secteursTotal = disposition.tailleLogique / SECTOR_SIZE;
  const depuisRang = depuis === ETAPES_V4.enTete ? secteursTotal : (position ?? 0);
  const compte = await rescellerLaCharge({
    brut,
    disposition,
    v3: scellementV3,
    v4: scellementV4,
    secteursParTour,
    depuisRang,
    tampon: decoderTampon(tampon, depuisRang),
    marquerEtape,
  });

  await marquerEtape({ etape: ETAPES_V4.enTete, position: secteursTotal, tampon: null });
  await poserLEnTeteV4({ brut, tailleLogique, identifiantVolume });

  return Object.freeze({ ...compte, tailleSupport: disposition.tailleSupport });
}
