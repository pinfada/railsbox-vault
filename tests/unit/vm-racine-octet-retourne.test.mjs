/**
 * UN OCTET RETOURNÉ dans une racine : ce que l'ouverture REND, offset par offset (#182, PR #186).
 *
 * ## Ce que le relevé du relecteur a trouvé
 *
 * La revue de sécurité de la PR #186 a retourné le bit 7 de CHACUN des 215 premiers octets des deux
 * emplacements de racine d'un volume v4, et relevé le refus rendu à l'ouverture :
 *
 * ```
 *  143  VAULT_STORAGE_SCEAU_REFUSE          16-20,68-73,76-207
 *   44  VAULT_STORAGE_GENERATION_CORRUPT    0-15,24-51
 *   16  VAULT_STORAGE_IDENTITE_VOLUME       52-67
 *    7  VAULT_STORAGE_SUPPORT_FAILURE       21-23,74-75,208-209
 *    5  ACCEPTÉE                            210-214           (la réserve)
 * ```
 *
 * Les sept `SUPPORT_FAILURE` sont la conduite exactement INVERSE de celle qu'il faut : l'exploitant
 * lit « le support OPFS a refusé l'opération », donc « mon disque est en panne », là où la
 * spécification veut « restaurez une sauvegarde » (§ 10.2). Les offsets **208-209** sont les octets
 * de poids fort de `scellementsCumulesJournal`, le champ que la v4 ajoute — le défaut est ancien,
 * et cette tranche lui ajoutait deux octets.
 *
 * ## Ce que cette suite mesure, et pourquoi elle balaie TOUT plutôt que six offsets
 *
 * Elle rejoue le balayage entier. Un contrôle posé sur les deux octets que la v4 ajoute aurait
 * laissé les cinq autres, et surtout il n'aurait rien dit du PROCHAIN champ de soixante-quatre bits
 * qu'une version ultérieure ajoutera. Ce qui est exigé ici est une PROPRIÉTÉ : **aucun octet de la
 * racine ne fait rendre une panne de support**, et la réserve — et elle seule — est acceptée.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { generationJournalName } from "../../src/vm/opfs-sync-access.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";
import { RACINE_ENTETE_V5_OCTETS, offsetDeRacine } from "../../src/vm/generation-format.mjs";

const NOM = "retourne";
const TAILLE = 4 * SECTOR_SIZE;
const IDENTIFIANT = "0123456789abcdef0123456789abcdef";

/** Le dernier octet de l'en-tête d'une racine v5, réserve exclue. */
const DERNIER_CHAMP = RACINE_ENTETE_V5_OCTETS;

/** Fabrique un volume v4 avec sa racine de naissance, et rend les octets du journal. */
async function volumeNeuf() {
  const store = createSyncAccessStore();
  const backend = await openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT,
    openHandle: store.openHandle,
    transactionnel: false,
  });
  await backend.close();
  return {
    store,
    volume: store.snapshot(NOM),
    journal: store.snapshot(generationJournalName(NOM)),
  };
}

/** Repose le volume et son journal, l'octet `offset` de la racine 0 retourné sur le bit 7. */
async function ouvrirAvecUnOctetRetourne(origine, offset) {
  const store = createSyncAccessStore();
  const journal = origine.journal.slice();
  journal[offsetDeRacine(0) + offset] ^= 0x80;
  await poser(store, NOM, origine.volume);
  await poser(store, generationJournalName(NOM), journal);

  try {
    const backend = await openOpfsVolume({
      name: NOM,
      size: TAILLE,
      cle: CLE_DE_TEST,
      identifiantVolume: IDENTIFIANT,
      openHandle: store.openHandle,
    });
    await backend.close();
    return null;
  } catch (cause) {
    return cause.code ?? cause.name;
  }
}

async function poser(store, nom, octets) {
  const handle = await store.openHandle(nom);
  try {
    handle.truncate(octets.byteLength);
    handle.write(octets, { at: 0 });
    handle.flush();
  } finally {
    handle.close();
  }
}

test("AUCUN octet retourné dans une racine ne fait rendre une panne de SUPPORT", async () => {
  const origine = await volumeNeuf();
  const pannes = [];
  const verdicts = new Map();
  for (let offset = 0; offset < DERNIER_CHAMP; offset += 1) {
    const code = await ouvrirAvecUnOctetRetourne(origine, offset);
    verdicts.set(offset, code);
    if (code === STORAGE_ERROR_CODES.supportFailure) pannes.push(offset);
  }

  assert.deepEqual(
    pannes,
    [],
    "Ces offsets rendent « le support a refusé l'opération » pour une racine ABÎMÉE : l'exploitant " +
      "lit une panne de disque là où la spécification veut « restaurez une sauvegarde » (§ 10.2), " +
      "et un adversaire y gagne un oracle sur le champ qu'il a touché.",
  );

  // Et RIEN n'est accepté : un octet retourné dans un champ de la racine est toujours un refus.
  const acceptes = [...verdicts].filter(([, code]) => code === null).map(([offset]) => offset);
  assert.deepEqual(
    acceptes,
    [],
    "un octet retourné dans un CHAMP de la racine est toujours refusé",
  );
});

test("les deux octets que la v4 AJOUTE se comportent comme les autres", async () => {
  // Le champ `scellementsCumulesJournal` vit à l'offset 202 ; ses octets de poids fort sont 208 et
  // 209, et c'est là que le relevé du relecteur trouvait `SUPPORT_FAILURE`. Ils doivent rendre le
  // refus d'une racine ABÎMÉE, comme `sequence` et `scellementsCumulesVolume` le font désormais.
  const origine = await volumeNeuf();
  for (const offset of [208, 209]) {
    assert.equal(
      await ouvrirAvecUnOctetRetourne(origine, offset),
      STORAGE_ERROR_CODES.generationRootCorrupt,
      `offset ${offset} : le compteur du journal hors bornes est une racine abîmée`,
    );
  }
});

test("la RÉSERVE, elle, reste acceptée — et c'est un corollaire écrit, pas un oubli", async () => {
  // Au-delà du dernier champ, la racine porte une réserve NULLE que rien n'authentifie : la
  // modifier ne change rien, et c'est déjà écrit au § 6.7. L'épreuve le CONSTATE ici pour que le
  // balayage ci-dessus ne soit pas lu comme « tout octet du secteur est authentifié ».
  const origine = await volumeNeuf();
  for (const offset of [DERNIER_CHAMP, DERNIER_CHAMP + 1, DERNIER_CHAMP + 4]) {
    assert.equal(
      await ouvrirAvecUnOctetRetourne(origine, offset),
      null,
      `offset ${offset} : la réserve n'est pas authentifiée, et le § 6.7 le dit`,
    );
  }
});
