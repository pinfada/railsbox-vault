/**
 * Le CÂBLAGE du démarrage hors connexion (#247, D1g) : ce que la page constate avant le démarrage, et
 * ce que le démarrage refuse avant tout boot. La mécanique du descripteur scellé est éprouvée à part
 * (`coquille-hors-connexion.test.mjs`) ; ici, le contrat entre le repli et la décision de déphasage.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { dephasagePourLaPage } from "../../src/coquille/application-de-reference.mjs";
import {
  horsConnexionPublie,
  refusDuRepli,
  rangerLeDescripteur,
} from "../../src/coquille/hors-connexion.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import { creerMagasinDArtefacts } from "../../src/vm/magasin-d-artefacts.mjs";
import { primitivesEnMemoire } from "./magasin-en-memoire.mjs";
import { descripteurDEpreuve } from "./support-coffre-de-la-coquille.mjs";

const DEK = new Uint8Array(32).fill(3);
const MANIFESTE_V86 = { artifacts: [{ name: "v86.wasm", bytes: 10, sha256: "8".repeat(64) }] };
const RANGE_LE = Date.UTC(2026, 10, 9, 8, 30, 0);
const reseauCoupe = async () => {
  throw new TypeError("Failed to fetch");
};
const cleDeVolume = async () => DEK.slice();
const coffre = (version) => async () => ({
  app: { id: "railsbox-vault-reference", version, schema: "20260815120000" },
});

async function magasinRange(version = "1.0.0") {
  const magasin = creerMagasinDArtefacts({ primitives: primitivesEnMemoire() });
  const descripteur = descripteurDEpreuve();
  descripteur.application.version = version;
  await rangerLeDescripteur({
    magasin,
    cleDeVolume,
    descripteur,
    manifesteV86: MANIFESTE_V86,
    complet: true,
    maintenant: () => RANGE_LE,
  });
  return magasin;
}

const constat = ({ magasin, manifeste, recuperer = reseauCoupe }) =>
  dephasagePourLaPage({
    cleDeVolume,
    recuperer,
    magasin,
    lireManifeste: manifeste,
  });

test("la page : hors connexion, un coffre à la même version s'ouvre, avec la date et la version", async () => {
  const publie = await constat({
    magasin: await magasinRange("1.0.0"),
    manifeste: coffre("1.0.0"),
  });
  assert.equal(publie.issue, "ouvrir");
  assert.deepEqual(publie.horsConnexion, { rangeLe: RANGE_LE, version: "1.0.0" });
});

test("la page : hors connexion, un rangé ANTÉRIEUR au volume est refusé (anti-retour), date incluse", async () => {
  const publie = await constat({
    magasin: await magasinRange("1.0.0"),
    manifeste: coffre("1.1.0"),
  });
  assert.equal(publie.issue, "refus");
  assert.equal(publie.code, C.applicationAnterieure);
  assert.deepEqual(publie.horsConnexion, { rangeLe: RANGE_LE, version: "1.0.0" });
});

test("la page : hors connexion sans volume, refus typé — installer demande la graine", async () => {
  const publie = await constat({ magasin: await magasinRange(), manifeste: async () => null });
  assert.equal(publie.issue, "refus");
  assert.equal(publie.code, C.horsLigneSansCoffre);
});

test("la page : hors connexion sans descripteur rangé, refus typé et jamais « installer »", async () => {
  const magasin = creerMagasinDArtefacts({ primitives: primitivesEnMemoire() });
  const publie = await constat({ magasin, manifeste: coffre("1.0.0") });
  assert.equal(publie.issue, "refus");
  assert.equal(publie.code, C.horsLigneSansCopie);
});

test("la page : un rangé altéré donne le refus typé, pas de décision sur sa foi", async () => {
  const magasin = await magasinRange();
  const octets = await magasin.lireLeDescripteurScelle();
  octets[40] ^= 1;
  await magasin.ecrireLeDescripteurScelle(octets);
  const publie = await constat({ magasin, manifeste: coffre("1.0.0") });
  assert.equal(publie.code, C.horsLigneDescripteurRefuse);
  assert.equal(publie.horsConnexion, null, "aucune date n'est affichée pour un rangé refusé");
});

test("la page : l'origine répond — pas de repli, pas de date, le rangé est ignoré", async () => {
  const servi = descripteurDEpreuve();
  const recuperer = async () => ({ ok: true, status: 200, json: async () => servi });
  const publie = await constat({
    magasin: await magasinRange("0.1.0"),
    manifeste: coffre("1.0.0"),
    recuperer,
  });
  assert.equal(publie.issue, "ouvrir");
  assert.equal(publie.horsConnexion, null);
});

test("la page : une origine qui répond 500 n'ouvre PAS le repli — l'origine fait foi", async () => {
  const recuperer = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const publie = await constat({
    magasin: await magasinRange("1.0.0"),
    manifeste: coffre("1.0.0"),
    recuperer,
  });
  assert.equal(publie.issue, "refus");
  assert.equal(publie.code, C.applicationNonServie);
  assert.equal(publie.horsConnexion, null);
});

// --- refusDuRepli, horsConnexionPublie ------------------------------------------------------------

test("refusDuRepli : aucune garde quand l'origine a répondu", () => {
  assert.equal(refusDuRepli({ lu: { present: true, descripteur: {} }, manifeste: null }), null);
  assert.equal(refusDuRepli({ lu: { present: false, motif: "x" }, manifeste: null }), null);
});

test("refusDuRepli : le code du repli quand il n'y a pas de descripteur accepté", () => {
  const lu = { present: false, horsConnexion: true, code: C.horsLigneSansCopie };
  assert.equal(refusDuRepli({ lu, manifeste: {} }), C.horsLigneSansCopie);
});

test("refusDuRepli : hors connexion sans volume, c'est horsLigneSansCoffre ; avec volume, rien", () => {
  const lu = { present: true, descripteur: {}, horsConnexion: { rangeLe: 1, manifesteV86: {} } };
  assert.equal(refusDuRepli({ lu, manifeste: null }), C.horsLigneSansCoffre);
  assert.equal(refusDuRepli({ lu, manifeste: { app: {} } }), null);
});

test("horsConnexionPublie : date et version seulement, ou null", () => {
  const descripteur = descripteurDEpreuve();
  assert.deepEqual(
    horsConnexionPublie({
      present: true,
      descripteur,
      horsConnexion: { rangeLe: 42, manifesteV86: MANIFESTE_V86 },
    }),
    { rangeLe: 42, version: "1.0.0" },
  );
  assert.equal(horsConnexionPublie({ present: true, descripteur }), null);
  assert.equal(horsConnexionPublie({ present: false, horsConnexion: true, code: "X" }), null);
});
