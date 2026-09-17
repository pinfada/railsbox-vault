/**
 * La TABLE DE PARTITIONS du disque système composé (#236, ADR 0041).
 *
 * La coquille ne télécharge plus un rootfs, mais DEUX morceaux qu'elle range dans un seul disque :
 * partition 1 = le rootfs à l'octet près, partition 2 = le paquet applicatif. Ce que le noyau lit
 * pour les trouver tient dans 512 octets, et ces 512 octets sont calculés — donc mesurables ici,
 * sans Docker, sans v86 et sans réseau.
 *
 * Ce qui est exigé : les décalages alignés sur 1 Mio, la signature `55AA`, le type Linux (`0x83`)
 * des deux entrées, la cohérence des champs LBA avec les tailles annoncées, un CHS qui ne ment pas
 * plus que ne le permet la géométrie historique, et le REFUS d'un disque qui déborderait des
 * bornes d'une table MBR.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ALIGNEMENT_OCTETS,
  MBR_OCTETS,
  SECTEUR_OCTETS,
  TYPE_LINUX,
  chsDe,
  composerDisqueSysteme,
  ecrireTableDePartitions,
  entreesDeLaTable,
} from "../../src/vm/disque-compose.mjs";

const MIO = 1024 * 1024;

test("le plan range rootfs et paquet à des décalages alignés sur 1 Mio", () => {
  const plan = composerDisqueSysteme({ rootfsOctets: 385 * MIO, paquetOctets: 140 * MIO });

  assert.equal(plan.rootfs.debut, ALIGNEMENT_OCTETS);
  assert.equal(plan.rootfs.octets, 385 * MIO);
  assert.equal(plan.paquet.debut % ALIGNEMENT_OCTETS, 0);
  assert.ok(plan.paquet.debut >= plan.rootfs.debut + plan.rootfs.octets);
  assert.equal(plan.paquet.octets, 140 * MIO);
  assert.equal(plan.octets, plan.paquet.debut + plan.paquet.octets);
});

test("une taille qui n'est pas multiple d'un secteur est arrondie en réservant le secteur entamé", () => {
  const plan = composerDisqueSysteme({ rootfsOctets: 385 * MIO + 3, paquetOctets: SECTEUR_OCTETS });

  assert.equal(plan.paquet.debut % ALIGNEMENT_OCTETS, 0);
  assert.ok(
    plan.paquet.debut >= plan.rootfs.debut + plan.rootfs.octets,
    "le paquet ne peut pas commencer dans le dernier secteur du rootfs",
  );
});

test("la table porte deux partitions Linux et la signature 55AA", () => {
  const plan = composerDisqueSysteme({ rootfsOctets: 8 * MIO, paquetOctets: 4 * MIO });
  const mbr = ecrireTableDePartitions(plan);

  assert.equal(mbr.byteLength, MBR_OCTETS);
  assert.equal(mbr[510], 0x55);
  assert.equal(mbr[511], 0xaa);

  const entrees = entreesDeLaTable(mbr);
  assert.equal(entrees.length, 4);
  assert.equal(entrees[0].type, TYPE_LINUX);
  assert.equal(entrees[1].type, TYPE_LINUX);
  assert.equal(entrees[2].type, 0);
  assert.equal(entrees[3].type, 0);
});

test("les champs LBA des entrées décrivent exactement le plan", () => {
  const plan = composerDisqueSysteme({ rootfsOctets: 385 * MIO, paquetOctets: 140 * MIO });
  const [rootfs, paquet] = entreesDeLaTable(ecrireTableDePartitions(plan));

  assert.equal(rootfs.premierSecteur, plan.rootfs.debut / SECTEUR_OCTETS);
  assert.equal(rootfs.secteurs, plan.rootfs.octets / SECTEUR_OCTETS);
  assert.equal(paquet.premierSecteur, plan.paquet.debut / SECTEUR_OCTETS);
  assert.equal(paquet.secteurs, plan.paquet.octets / SECTEUR_OCTETS);
});

test("la première partition est amorçable, la seconde ne l'est pas", () => {
  const plan = composerDisqueSysteme({ rootfsOctets: 8 * MIO, paquetOctets: 4 * MIO });
  const [rootfs, paquet] = entreesDeLaTable(ecrireTableDePartitions(plan));

  assert.equal(rootfs.amorcable, 0x80);
  assert.equal(paquet.amorcable, 0x00);
});

test("le CHS sature à sa valeur maximale au-delà de ce que la géométrie historique décrit", () => {
  // Au-delà de 1024 cylindres — environ 8 Gio sous la géométrie 255 × 63 —, un CHS ne peut plus
  // décrire le secteur : la convention est (1023, 254, 63). Un CHS qui continuerait de compter
  // mentirait à l'outil qui le lirait.
  assert.deepEqual(chsDe(1024 * 255 * 63), { cylindre: 1023, tete: 254, secteur: 63 });
  assert.deepEqual(chsDe(16 * 1024 * 1024), { cylindre: 1023, tete: 254, secteur: 63 });
});

test("le CHS d'une entrée est celui de son premier et de son dernier secteur", () => {
  const plan = composerDisqueSysteme({ rootfsOctets: 385 * MIO, paquetOctets: 140 * MIO });
  const [, paquet] = entreesDeLaTable(ecrireTableDePartitions(plan));
  const premier = plan.paquet.debut / SECTEUR_OCTETS;

  assert.deepEqual(paquet.chsDebut, chsDe(premier));
  assert.deepEqual(paquet.chsFin, chsDe(premier + plan.paquet.octets / SECTEUR_OCTETS - 1));
});

test("le CHS des petits disques décrit réellement le secteur", () => {
  const plan = composerDisqueSysteme({ rootfsOctets: 4 * MIO, paquetOctets: 4 * MIO });
  const [rootfs] = entreesDeLaTable(ecrireTableDePartitions(plan));

  // 2048 secteurs, géométrie 255 têtes × 63 secteurs : cylindre 0, tête 32, secteur 33.
  assert.deepEqual(rootfs.chsDebut, { cylindre: 0, tete: 32, secteur: 33 });
});

test("un disque dont un morceau dépasse la borne d'une table MBR est refusé", () => {
  assert.throws(
    () => composerDisqueSysteme({ rootfsOctets: 3 * 1024 * 1024 * 1024 * 1024, paquetOctets: MIO }),
    /table MBR/i,
  );
});

test("une taille absente, nulle ou non entière est refusée", () => {
  for (const cas of [
    { rootfsOctets: 0, paquetOctets: MIO },
    { rootfsOctets: MIO, paquetOctets: 0 },
    { rootfsOctets: 1.5, paquetOctets: MIO },
    { rootfsOctets: MIO, paquetOctets: -MIO },
    { rootfsOctets: MIO },
  ]) {
    assert.throws(() => composerDisqueSysteme(cas), /taille/i, JSON.stringify(cas));
  }
});

test("la table est écrite dans le tampon fourni, sans toucher au reste", () => {
  const plan = composerDisqueSysteme({ rootfsOctets: 4 * MIO, paquetOctets: 4 * MIO });
  const tampon = new Uint8Array(plan.octets);
  tampon.fill(0x5a, MBR_OCTETS, MBR_OCTETS + 16);

  ecrireTableDePartitions(plan, tampon);

  assert.equal(tampon[510], 0x55);
  assert.equal(tampon[511], 0xaa);
  assert.equal(tampon[MBR_OCTETS], 0x5a, "l'octet qui suit la table n'est pas touché");
});
