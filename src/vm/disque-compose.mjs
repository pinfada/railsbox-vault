// COMPOSITION du disque système du guest : rootfs + paquet applicatif dans un seul `hda` (#236,
// ADR 0041).
//
// Jusqu'à cette tranche, `hda` était le rootfs nu — un système de fichiers sans table de
// partitions, monté par `root=/dev/sda`. Le code de l'application vivait sur `hdb`, mêlé à ses
// données, si bien que remplacer l'application, c'était perdre les données.
//
// Le paquet devient donc une SECONDE PARTITION du même disque, et les données passent seules sur
// `hdb` :
//
//   secteur 0        table de partitions MBR (512 octets), calculée ici ;
//   1 Mio            partition 1, le rootfs, À L'OCTET PRÈS — les mêmes octets qu'avant, servis
//                    sous la même empreinte, mis en cache sous la même adresse immuable ;
//   après le rootfs  partition 2, le paquet applicatif, aligné sur 1 Mio.
//
// ## Pourquoi une table calculée, et pas un disque partitionné fabriqué en amont
//
// Un disque partitionné fabriqué par la construction serait UN artefact : sa mise à jour
// retéléchargerait le rootfs entier (385 Mio) pour changer 140 Mio d'application, et son empreinte
// changerait à chaque nouvelle version de l'application. Chaque morceau garde donc son adresse par
// empreinte (ADR 0023), et c'est la coquille qui les range — 512 octets de table, calculés sans
// rien télécharger de plus.
//
// ## Ce module ne touche à rien
//
// Il ne télécharge pas, n'alloue pas de demi-gibioctet et ne connaît ni v86 ni OPFS : il rend un
// PLAN (des décalages) et écrit 512 octets. C'est ce qui le rend mesurable par une suite unitaire
// sans Docker, sans navigateur et sans image construite.

/** Taille d'un secteur. Celle d'un disque IDE émulé par v86, et l'unité de tous les champs LBA. */
export const SECTEUR_OCTETS = 512;

/** Taille de la table de partitions, en tête du disque : un secteur. */
export const MBR_OCTETS = 512;

/**
 * ALIGNEMENT des partitions : 1 Mio, la convention des outils de partitionnement depuis 2009.
 *
 * Il est aussi multiple de la taille de bloc du delta de `tampon-rootfs.mjs` (4096) et de celle des
 * systèmes de fichiers fabriqués : aucune partition ne commence au milieu d'un bloc que le tampon
 * salit, et aucun bloc du delta ne chevauche deux partitions.
 */
export const ALIGNEMENT_OCTETS = 1024 * 1024;

/** Type de partition « Linux ». Le noyau ne s'y fie pas pour monter, mais un outil humain, si. */
export const TYPE_LINUX = 0x83;

/** Géométrie CHS historique, celle que tout BIOS suppose : 255 têtes, 63 secteurs par piste. */
const TETES = 255;
const SECTEURS_PAR_PISTE = 63;

/** Au-delà de 1024 cylindres, un CHS ne décrit plus rien : la convention est (1023, 254, 63). */
const CHS_SATURE = Object.freeze({ cylindre: 1023, tete: 254, secteur: 63 });

/** Bornes d'une table MBR : les champs LBA sont des entiers de 32 bits non signés. */
const SECTEURS_MAX = 0xffffffff;

/** Décalage de la première entrée de partition, et taille d'une entrée. */
const PREMIERE_ENTREE = 446;
const OCTETS_PAR_ENTREE = 16;

/** @param {unknown} valeur @param {string} nom */
function exigerTaille(valeur, nom) {
  if (!Number.isInteger(valeur) || valeur <= 0) {
    throw new Error(
      `Taille de ${nom} invalide : ${String(valeur)} octets attendus entiers et > 0.`,
    );
  }
  return valeur;
}

/** Arrondit une position au multiple supérieur d'`alignement`. */
function alignerVersLeHaut(position, alignement) {
  return Math.ceil(position / alignement) * alignement;
}

/**
 * PLAN du disque : où chaque morceau commence, combien il pèse, et ce que le disque entier pèse.
 *
 * Les tailles sont celles des FICHIERS servis, à l'octet près. La partition, elle, est décrite en
 * secteurs : un fichier dont la taille n'est pas multiple d'un secteur occupe le secteur entamé
 * tout entier, et le morceau suivant commence après — sans quoi deux partitions se partageraient
 * un secteur, que le noyau écrirait pour l'une en salissant l'autre.
 *
 * @param {{ rootfsOctets: number, paquetOctets: number, alignementOctets?: number }} entrees
 */
export function composerDisqueSysteme({
  rootfsOctets,
  paquetOctets,
  alignementOctets = ALIGNEMENT_OCTETS,
}) {
  exigerTaille(rootfsOctets, "rootfs");
  exigerTaille(paquetOctets, "paquet");

  const rootfs = { debut: alignementOctets, octets: rootfsOctets };
  const debutDuPaquet = alignerVersLeHaut(rootfs.debut + rootfs.octets, alignementOctets);
  const paquet = { debut: debutDuPaquet, octets: paquetOctets };
  const octets = alignerVersLeHaut(paquet.debut + paquet.octets, SECTEUR_OCTETS);

  if (octets / SECTEUR_OCTETS > SECTEURS_MAX) {
    throw new Error(
      `Disque système refusé : ${octets} octets dépassent ce qu'une table MBR peut décrire (${SECTEURS_MAX} secteurs).`,
    );
  }
  return { rootfs, paquet, octets, alignementOctets };
}

/** Nombre de secteurs qu'un morceau occupe : le secteur entamé compte entier. */
function secteursDe(octets) {
  return Math.ceil(octets / SECTEUR_OCTETS);
}

/**
 * CHS d'un secteur logique, saturé quand la géométrie ne le décrit plus.
 *
 * @param {number} lba
 */
export function chsDe(lba) {
  const cylindre = Math.floor(lba / (TETES * SECTEURS_PAR_PISTE));
  if (cylindre > 1023) return { ...CHS_SATURE };
  return {
    cylindre,
    tete: Math.floor(lba / SECTEURS_PAR_PISTE) % TETES,
    secteur: (lba % SECTEURS_PAR_PISTE) + 1,
  };
}

/** Écrit une entrée de partition de 16 octets à `position`. */
function ecrireEntree(vue, position, { amorcable, premierSecteur, secteurs }) {
  const debut = chsDe(premierSecteur);
  const fin = chsDe(premierSecteur + secteurs - 1);
  vue.setUint8(position, amorcable);
  vue.setUint8(position + 1, debut.tete);
  vue.setUint8(position + 2, ((debut.cylindre >> 2) & 0xc0) | debut.secteur);
  vue.setUint8(position + 3, debut.cylindre & 0xff);
  vue.setUint8(position + 4, TYPE_LINUX);
  vue.setUint8(position + 5, fin.tete);
  vue.setUint8(position + 6, ((fin.cylindre >> 2) & 0xc0) | fin.secteur);
  vue.setUint8(position + 7, fin.cylindre & 0xff);
  vue.setUint32(position + 8, premierSecteur, true);
  vue.setUint32(position + 12, secteurs, true);
}

/**
 * ÉCRIT la table de partitions du plan, dans le tampon fourni ou dans un tampon neuf de 512 octets.
 *
 * Rien d'autre n'est touché : le code d'amorçage (les 446 premiers octets) reste à zéro — v86
 * démarre le noyau directement, sans amorceur — et les octets qui suivent la table appartiennent au
 * rootfs, qui les a déjà écrits ou les écrira.
 *
 * @param {ReturnType<typeof composerDisqueSysteme>} plan
 * @param {Uint8Array} [tampon]
 */
export function ecrireTableDePartitions(plan, tampon = new Uint8Array(MBR_OCTETS)) {
  if (tampon.byteLength < MBR_OCTETS) {
    throw new Error(
      `Table de partitions refusée : ${tampon.byteLength} octets pour ${MBR_OCTETS}.`,
    );
  }
  const vue = new DataView(tampon.buffer, tampon.byteOffset, MBR_OCTETS);
  ecrireEntree(vue, PREMIERE_ENTREE, {
    // Amorçable : v86 démarre le noyau directement, mais un disque dont aucune partition n'est
    // marquée est un disque qu'un outil humain croit incomplet.
    amorcable: 0x80,
    premierSecteur: plan.rootfs.debut / SECTEUR_OCTETS,
    secteurs: secteursDe(plan.rootfs.octets),
  });
  ecrireEntree(vue, PREMIERE_ENTREE + OCTETS_PAR_ENTREE, {
    amorcable: 0x00,
    premierSecteur: plan.paquet.debut / SECTEUR_OCTETS,
    secteurs: secteursDe(plan.paquet.octets),
  });
  vue.setUint8(510, 0x55);
  vue.setUint8(511, 0xaa);
  return tampon;
}

/** Décode le CHS d'une entrée : trois octets, dont deux bits de cylindre logés dans le secteur. */
function lireChs(vue, position) {
  const tete = vue.getUint8(position);
  const secteurEtCylindre = vue.getUint8(position + 1);
  return {
    cylindre: ((secteurEtCylindre & 0xc0) << 2) | vue.getUint8(position + 2),
    tete,
    secteur: secteurEtCylindre & 0x3f,
  };
}

/**
 * RELIT les quatre entrées d'une table. Exportée parce qu'une table qu'on écrit sans jamais la
 * relire est une table dont on suppose la forme.
 *
 * @param {Uint8Array} tampon
 */
export function entreesDeLaTable(tampon) {
  const vue = new DataView(tampon.buffer, tampon.byteOffset, MBR_OCTETS);
  const entrees = [];
  for (let index = 0; index < 4; index += 1) {
    const position = PREMIERE_ENTREE + index * OCTETS_PAR_ENTREE;
    entrees.push({
      amorcable: vue.getUint8(position),
      chsDebut: lireChs(vue, position + 1),
      type: vue.getUint8(position + 4),
      chsFin: lireChs(vue, position + 5),
      premierSecteur: vue.getUint32(position + 8, true),
      secteurs: vue.getUint32(position + 12, true),
    });
  }
  return entrees;
}
