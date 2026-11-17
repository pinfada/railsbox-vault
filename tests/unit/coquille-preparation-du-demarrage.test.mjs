/**
 * La PRÉPARATION du démarrage avec le repli hors connexion (#247, D1g) : l'ordre des refus avant tout
 * boot, le rangement du descripteur après l'acquisition, et le crochet qui précède l'intention.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  lireEtPreparer,
  rangementAvantLIntention,
  refusDeDemarrage,
  refusDeLArtefactAbsent,
} from "../../src/coquille/preparation-du-demarrage.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import { creerMagasinDArtefacts } from "../../src/vm/magasin-d-artefacts.mjs";
import { reserveTientTout } from "../../src/vm/acquisition-des-artefacts.mjs";
import { primitivesEnMemoire } from "./magasin-en-memoire.mjs";
import { descripteurDEpreuve } from "./support-coffre-de-la-coquille.mjs";

const MANIFESTE_V86 = { artifacts: [{ name: "v86.wasm", bytes: 10, sha256: "8".repeat(64) }] };
const luRange = () => ({
  present: true,
  descripteur: descripteurDEpreuve(),
  horsConnexion: { rangeLe: 42, manifesteV86: MANIFESTE_V86 },
});
const coffre = (version) => async () => ({
  app: { id: "railsbox-vault-reference", version, schema: "20260815120000" },
});
const preparer = ({ lu, lireManifeste }) => {
  const appels = [];
  return {
    appels,
    resultat: lireEtPreparer({
      cleDeVolume: async () => new Uint8Array(32),
      nom: "application",
      miseAJour: false,
      delaiMs: 1000,
      lire: async () => lu,
      lireManifeste: async (...args) => (appels.push(args), lireManifeste(...args)),
    }),
  };
};

test("injoignable sans rangé accepté : refus typé AVANT toute lecture du volume", async () => {
  const lu = { present: false, horsConnexion: true, code: C.horsLigneSansCopie, motif: "x" };
  const { appels, resultat } = preparer({ lu, lireManifeste: coffre("1.0.0") });
  const { rendu } = await resultat;
  assert.equal(rendu.demarree, false);
  assert.equal(rendu.code, C.horsLigneSansCopie);
  assert.equal(appels.length, 0, "le manifeste du volume n'est pas lu");
});

test("injoignable, rangé accepté, volume à la même version : le démarrage continue sur le rangé", async () => {
  const { resultat } = preparer({ lu: luRange(), lireManifeste: coffre("1.0.0") });
  const { lu, prepare, rendu } = await resultat;
  assert.equal(rendu, undefined);
  assert.equal(lu.horsConnexion.rangeLe, 42);
  assert.equal(prepare.descripteur.application.version, "1.0.0");
});

test("injoignable, rangé ANTÉRIEUR au volume : refus de l'ADR 0042, rien ne démarre", async () => {
  const { resultat } = preparer({ lu: luRange(), lireManifeste: coffre("1.1.0") });
  const { rendu } = await resultat;
  assert.equal(rendu.code, C.applicationAnterieure);
});

test("injoignable, rangé accepté, AUCUN volume : refus typé — installer demande la graine", async () => {
  const { resultat } = preparer({ lu: luRange(), lireManifeste: async () => null });
  const { rendu } = await resultat;
  assert.equal(rendu.code, C.horsLigneSansCoffre);
});

test("l'origine répond 500 : « sans application », jamais un code hors ligne", async () => {
  const lu = { present: false, motif: "aucun descripteur servi (500)" };
  const { resultat } = preparer({ lu, lireManifeste: async () => null });
  const { rendu } = await resultat;
  assert.deepEqual(rendu, { demarree: false, motif: "aucun descripteur servi (500)" });
});

test("refusDeDemarrage : un code, son message, la décision", () => {
  const refus = refusDeDemarrage(C.horsLigneSansCoffre, { dephasage: { issue: "refus" } });
  assert.equal(refus.demarree, false);
  assert.equal(refus.code, C.horsLigneSansCoffre);
  assert.match(refus.motif, /injoignable/);
  assert.deepEqual(refus.dephasage, { issue: "refus" });
});

test("refusDeLArtefactAbsent : le code hors ligne, et seulement lui", () => {
  assert.equal(
    refusDeLArtefactAbsent(Object.assign(new Error("x"), { code: C.horsLigneArtefactAbsent })),
    C.horsLigneArtefactAbsent,
  );
  for (const autre of [
    new Error("x"),
    Object.assign(new Error("x"), { code: "AUTRE" }),
    null,
    undefined,
  ]) {
    assert.equal(refusDeLArtefactAbsent(autre), null);
  }
});

// --- Le rangement avant l'intention ---------------------------------------------------------------

function rangement({ horsConnexion = null, magasin }) {
  return rangementAvantLIntention({
    horsConnexion,
    cleDeVolume: async () => new Uint8Array(32).fill(1),
    descripteur: descripteurDEpreuve(),
    runtime: { manifesteV86: MANIFESTE_V86 },
    magasin,
  });
}

test("en ligne, réserve complète : le descripteur est rangé", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  await rangement({ magasin })({ reserveComplete: true });
  assert.ok(primitives.fichiers.has("descripteur.scelle"));
});

test("en ligne, réserve INCOMPLÈTE : rien n'est rangé et l'ancien est oublié", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  await rangement({ magasin })({ reserveComplete: true });
  await rangement({ magasin })({ reserveComplete: false });
  assert.equal(primitives.fichiers.has("descripteur.scelle"), false);
});

test("hors connexion, rien n'est rangé : le descripteur vient du magasin", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  await rangement({ magasin, horsConnexion: { rangeLe: 1 } })({ reserveComplete: true });
  assert.equal(primitives.fichiers.size, 0);
  assert.equal(primitives.ecritures.length, 0);
});

// --- La réserve tient-elle tout ? -----------------------------------------------------------------

test("reserveTientTout : les cinq petits ET le rootfs ET le paquet, servis ou admis", () => {
  const tient = { complet: true };
  assert.equal(reserveTientTout(tient, { magasin: { rootfs: "admis", paquet: "servi" } }), true);
  assert.equal(
    reserveTientTout(tient, {
      magasin: { rootfs: "admis", paquet: "VAULT-ARTEFACTS-ADMISSION-REFUSEE" },
    }),
    false,
  );
  assert.equal(reserveTientTout(tient, { magasin: { rootfs: "absent", paquet: "servi" } }), false);
  assert.equal(
    reserveTientTout({ complet: false }, { magasin: { rootfs: "servi", paquet: "servi" } }),
    false,
  );
});
