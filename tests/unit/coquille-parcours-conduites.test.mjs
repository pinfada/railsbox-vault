/**
 * Le CLIQUET des conduites du parcours (#193, ADR 0040).
 *
 * Chaque code de refus que le parcours peut rencontrer a une conduite écrite pour une personne ; chaque
 * conduite se lit sans vocabulaire interne ; et chaque code de la coquille, de l'archive et de la
 * restauration est soit sur le chemin, soit écarté NOMMÉMENT. Un code neuf qui n'entre dans aucune des
 * deux listes rougit ici : c'est la forme du cliquet du § 10 (`dossier-de-revue.test.mjs`).
 */

import assert from "node:assert/strict";
import test from "node:test";

import { ARCHIVE_ERROR_CODES } from "../../src/vm/archive-errors.mjs";
import { DERIVATION_ERROR_CODES } from "../../src/vm/derivation/derivation-errors.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { IMPORT_ERROR_CODES } from "../../src/vm/import-errors.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";
import { CONDUITES } from "../../src/coquille/interface-de-deverrouillage.mjs";
import { CONDUITES_DE_PORTABILITE } from "../../src/coquille/gestes-de-portabilite.mjs";
import { TOUS_LES_CODES_DE_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import {
  CODES_DU_CHEMIN,
  CODES_HORS_DU_CHEMIN,
  CONDUITES_DU_PARCOURS,
  TOUS_LES_CODES_DU_CHEMIN,
  conduiteHumaine,
} from "../../src/coquille/conduites-du-parcours.mjs";
import { REFUS_D_INVENTAIRE } from "../../src/coquille/parcours.mjs";

/** Les huit gestes du chemin que la DoR nomme, et aucun autre. */
const GESTES = [
  "deverrouillage",
  "cycle",
  "relais",
  "installationInterrompue",
  "verrouillage",
  "sauvegarde",
  "restauration",
  "revocation",
];

/**
 * Ce qu'une conduite pour une personne ne porte jamais : un numéro d'issue, un nom de fichier, un code,
 * le vocabulaire du format (« voisin », « racine », « enveloppe »), ou celui du moteur.
 */
const VOCABULAIRE_INTERNE = [
  /#\d/,
  /\.(mjs|md|json|html)\b/,
  /\bvoisins?\b/i,
  /\bracines?\b/i,
  /VAULT_/,
  /\bWorker\b/i,
  /\bOPFS\b/,
  /\bKEK\b|\bDEK\b/,
  /\bhandle\b/i,
  /\benveloppe\b/i,
  /\bmanifeste\b/i,
  /\bADR\b/,
  /\bcoquille\b/i,
  /\bguest\b|\bVM\b/,
];

const TOUS_LES_CODES_CONNUS = new Set([
  ...TOUS_LES_CODES_DE_COQUILLE,
  ...Object.values(ARCHIVE_ERROR_CODES),
  ...Object.values(DERIVATION_ERROR_CODES),
  ...Object.values(ENVELOPPE_ERROR_CODES),
  ...Object.values(IMPORT_ERROR_CODES),
  ...Object.values(STORAGE_ERROR_CODES),
]);

test("le chemin couvre les huit gestes de la DoR, et chacun a au moins un code", () => {
  assert.deepEqual(Object.keys(CODES_DU_CHEMIN).sort(), [...GESTES].sort());
  for (const geste of GESTES) assert.ok(CODES_DU_CHEMIN[geste].length > 0, geste);
});

test("chaque code du chemin est un VRAI code du dépôt : une faute de frappe ne passe pas", () => {
  for (const code of TOUS_LES_CODES_DU_CHEMIN) {
    assert.ok(TOUS_LES_CODES_CONNUS.has(code), `${code} n'existe dans aucune table de codes`);
  }
  for (const code of Object.keys(CODES_HORS_DU_CHEMIN)) {
    assert.ok(TOUS_LES_CODES_CONNUS.has(code), `${code} (hors du chemin) n'existe pas`);
  }
});

test("CLIQUET : chaque code du chemin a une conduite écrite pour une personne", () => {
  const sansConduite = TOUS_LES_CODES_DU_CHEMIN.filter((code) => !(code in CONDUITES_DU_PARCOURS));
  assert.deepEqual(sansConduite, []);
});

test("aucune conduite orpheline : chaque conduite sert un code du chemin", () => {
  const orphelines = Object.keys(CONDUITES_DU_PARCOURS).filter(
    (code) => !TOUS_LES_CODES_DU_CHEMIN.includes(code),
  );
  assert.deepEqual(orphelines, []);
});

test("CLIQUET : chaque code de la coquille, de l'archive et de la restauration est classé", () => {
  const aClasser = [
    ...TOUS_LES_CODES_DE_COQUILLE,
    ...Object.values(ARCHIVE_ERROR_CODES),
    ...Object.values(IMPORT_ERROR_CODES),
  ];
  const nonClasses = aClasser.filter(
    (code) => !TOUS_LES_CODES_DU_CHEMIN.includes(code) && !(code in CODES_HORS_DU_CHEMIN),
  );
  assert.deepEqual(nonClasses, [], "un code neuf doit entrer dans le chemin ou en être écarté");
  const lesDeux = Object.keys(CODES_HORS_DU_CHEMIN).filter((code) =>
    TOUS_LES_CODES_DU_CHEMIN.includes(code),
  );
  assert.deepEqual(lesDeux, [], "un code ne peut pas être à la fois sur le chemin et écarté");
  for (const [code, motif] of Object.entries(CODES_HORS_DU_CHEMIN)) {
    assert.ok(motif.trim().length > 10, `${code} : l'exclusion porte un motif`);
  }
});

test("CLIQUET : les conduites que la coquille avait déjà écrites sont toutes sur le chemin", () => {
  for (const code of [...Object.keys(CONDUITES), ...Object.keys(CONDUITES_DE_PORTABILITE)]) {
    assert.ok(
      TOUS_LES_CODES_DU_CHEMIN.includes(code),
      `${code} a une conduite technique, pas humaine`,
    );
  }
  for (const code of REFUS_D_INVENTAIRE) {
    assert.ok(CODES_DU_CHEMIN.deverrouillage.includes(code), `${code} : refus d'inventaire`);
  }
});

test("chaque conduite se lit sans vocabulaire interne", () => {
  const fautes = [];
  for (const [code, conduite] of Object.entries(CONDUITES_DU_PARCOURS)) {
    for (const motif of VOCABULAIRE_INTERNE) {
      if (motif.test(conduite)) fautes.push(`${code} : ${motif}`);
    }
  }
  assert.deepEqual(fautes, []);
});

test("le filtre du vocabulaire MORD : il reconnaît ce qu'il doit refuser", () => {
  const exemples = [
    "voir #193",
    "le fichier parcours.mjs",
    "un voisin orphelin",
    "la racine initiale",
    "VAULT_ENVELOPPE_REJEU",
    "le Worker de confiance",
    "l'enveloppe de clés",
    "la coquille refuse",
  ];
  for (const exemple of exemples) {
    assert.ok(
      VOCABULAIRE_INTERNE.some((motif) => motif.test(exemple)),
      `le filtre laisse passer « ${exemple} »`,
    );
  }
  assert.ok(!VOCABULAIRE_INTERNE.some((motif) => motif.test("Rien n'a été perdu.")));
});

test("un code inconnu n'invente pas de conduite : il renvoie au détail technique", () => {
  assert.match(conduiteHumaine("VAULT_INEXISTANT"), /détail technique/);
  assert.match(conduiteHumaine(null), /détail technique/);
  assert.equal(
    conduiteHumaine(ENVELOPPE_ERROR_CODES.cleRefusee),
    CONDUITES_DU_PARCOURS[ENVELOPPE_ERROR_CODES.cleRefusee],
  );
});

test("les trois échecs les plus probables ont la conduite que l'E2E attend", () => {
  assert.match(conduiteHumaine(ENVELOPPE_ERROR_CODES.cleRefusee), /n'ouvre pas ce coffre/);
  assert.match(conduiteHumaine(DERIVATION_ERROR_CODES.codeMalRecopie), /faute de recopie/);
  assert.match(conduiteHumaine(ARCHIVE_ERROR_CODES.digestMismatch), /abîmée ou modifiée/);
});
