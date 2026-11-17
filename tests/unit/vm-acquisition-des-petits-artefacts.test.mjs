/**
 * Les ARTEFACTS DU DÉMARRAGE autres que le disque — wasm, BIOS, VGA BIOS, noyau, initrd — passent par
 * le magasin, chacun vérifié contre son empreinte épinglée (#247, D1g ; décision du superviseur n° 1).
 *
 * `libv86` n'en fait pas partie : un module ES ne peut pas être exécuté depuis l'OPFS sous la CSP du
 * Worker (`script-src 'self'`, pas de `blob:`). Il est dit, pas oublié : ADR 0045.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { acquerirLesPetitsArtefacts } from "../../src/vm/acquisition-des-artefacts.mjs";
import { creerMagasinDArtefacts } from "../../src/vm/magasin-d-artefacts.mjs";
import { primitivesEnMemoire } from "./magasin-en-memoire.mjs";

const sha = (octets) => createHash("sha256").update(octets).digest("hex");
const NOMS = ["wasm", "bios", "vgaBios", "kernel", "initrd"];

function contenu(nom, taille = 5000) {
  const marque = NOMS.indexOf(nom) + 11;
  return Uint8Array.from({ length: taille }, (_, i) => (marque * 7 + i) % 251);
}

/** Cinq artefacts, leurs épingles et un « réseau » qui les sert en comptant les requêtes. */
function monde({ epingles = true } = {}) {
  const runtime = {};
  const pins = {};
  const serveur = new Map();
  for (const nom of NOMS) {
    const octets = contenu(nom);
    runtime[nom] = `/artifacts/x/${nom}.bin`;
    serveur.set(runtime[nom], octets);
    pins[nom] = epingles ? { sha256: sha(octets), octets: octets.byteLength } : null;
  }
  const requetes = [];
  const recuperer = async (url, options) => {
    requetes.push({ url, options });
    const octets = serveur.get(url);
    if (octets === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => octets.slice().buffer };
  };
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  return { runtime, pins, serveur, requetes, recuperer, primitives, magasin };
}

const acquerir = (m, surcharge = {}) =>
  acquerirLesPetitsArtefacts({
    runtime: m.runtime,
    pins: m.pins,
    magasin: m.magasin,
    recuperer: m.recuperer,
    ...surcharge,
  });

test("premier démarrage : les cinq sont téléchargés, vérifiés, puis admis au magasin", async () => {
  const m = monde();
  const acquis = await acquerir(m);
  assert.equal(m.requetes.length, 5);
  for (const nom of NOMS) {
    assert.deepEqual(acquis.octets[nom], contenu(nom));
    assert.equal(acquis.magasin[nom], "admis");
    assert.ok(m.primitives.fichiers.has(m.pins[nom].sha256));
  }
  assert.equal(acquis.transfereOctets, 5 * 5000);
  assert.equal(acquis.complet, true);
});

test("réouverture : les cinq sont servis par le magasin, AUCUNE requête", async () => {
  const m = monde();
  await acquerir(m);
  m.requetes.length = 0;
  const acquis = await acquerir(m);
  assert.equal(m.requetes.length, 0);
  assert.equal(acquis.transfereOctets, 0);
  assert.deepEqual(Object.values(acquis.magasin), Array(5).fill("servi"));
  for (const nom of NOMS) assert.deepEqual(acquis.octets[nom], contenu(nom));
  assert.equal(acquis.complet, true);
});

test("un artefact altéré dans l'OPFS est refusé et retéléchargé : le démarrage ne le sert pas", async () => {
  const m = monde();
  await acquerir(m);
  m.primitives.fichiers.get(m.pins.kernel.sha256)[17] ^= 0x40;
  m.requetes.length = 0;
  const acquis = await acquerir(m);
  assert.deepEqual(
    acquis.octets.kernel,
    contenu("kernel"),
    "les octets du descripteur, pas ceux de l'OPFS",
  );
  assert.deepEqual(
    m.requetes.map((r) => r.url),
    [m.runtime.kernel],
  );
  assert.equal(acquis.magasin.kernel, "admis");
});

test("un artefact reçu dont l'empreinte n'est pas l'épingle est REFUSÉ, et n'est pas rangé", async () => {
  const m = monde();
  const faux = contenu("bios").slice();
  faux[0] ^= 1;
  m.serveur.set(m.runtime.bios, faux);
  await assert.rejects(acquerir(m), /bios.*empreinte/i);
  assert.ok(!m.primitives.fichiers.has(m.pins.bios.sha256));
});

test("un artefact reçu d'une autre taille que l'épingle est refusé", async () => {
  const m = monde();
  m.serveur.set(m.runtime.initrd, contenu("initrd", 4999));
  await assert.rejects(acquerir(m), /initrd.*(octets|taille)/i);
});

test("une réponse HTTP en échec est un refus nommé, pas un tampon vide", async () => {
  const m = monde();
  m.serveur.delete(m.runtime.vgaBios);
  await assert.rejects(acquerir(m), /vgaBios.*indisponible \(404\)/);
});

// --- Hors connexion : seul le magasin répond ------------------------------------------------------

test("hors connexion : tout vient du magasin, et fetch n'est JAMAIS appelé", async () => {
  const m = monde();
  await acquerir(m);
  m.requetes.length = 0;
  const acquis = await acquerir(m, {
    horsConnexion: true,
    recuperer: () => assert.fail("aucune requête hors connexion"),
  });
  assert.deepEqual(Object.values(acquis.magasin), Array(5).fill("servi"));
  assert.equal(acquis.transfereOctets, 0);
});

for (const [titre, abimer] of [
  ["absent du magasin", (m) => m.primitives.fichiers.delete(m.pins.wasm.sha256)],
  ["altéré dans le magasin", (m) => (m.primitives.fichiers.get(m.pins.wasm.sha256)[3] ^= 1)],
]) {
  test(`hors connexion, un artefact ${titre} : refus typé, rien n'est téléchargé`, async () => {
    const m = monde();
    await acquerir(m);
    abimer(m);
    await assert.rejects(
      acquerir(m, { horsConnexion: true, recuperer: () => assert.fail("aucune requête") }),
      { code: "VAULT_COQUILLE_HORS_LIGNE_ARTEFACT_ABSENT" },
    );
  });
}

test("hors connexion, un artefact sans épingle ne peut pas être vérifié : refus typé", async () => {
  const m = monde({ epingles: false });
  await assert.rejects(
    acquerir(m, { horsConnexion: true, recuperer: () => assert.fail("aucune requête") }),
    { code: "VAULT_COQUILLE_HORS_LIGNE_ARTEFACT_ABSENT" },
  );
});

// --- Sans épingle, ou sans place : le démarrage en ligne marche, mais la réserve est incomplète ----

test("sans épingle (descripteur ancien) : téléchargé comme avant, rien n'est rangé, réserve incomplète", async () => {
  const m = monde({ epingles: false });
  const acquis = await acquerir(m);
  assert.equal(m.requetes.length, 5);
  assert.deepEqual(Object.values(acquis.magasin), Array(5).fill("sans-empreinte"));
  assert.equal(acquis.complet, false);
  assert.equal(m.primitives.fichiers.size, 0);
});

test("une admission refusée par le budget ne fait pas échouer le démarrage : réserve incomplète", async () => {
  const m = monde();
  m.magasin = creerMagasinDArtefacts({
    primitives: m.primitives,
    peutAdmettre: async () => false,
  });
  const acquis = await acquerir(m);
  assert.equal(acquis.magasin.kernel, "VAULT-ARTEFACTS-ADMISSION-REFUSEE");
  assert.equal(acquis.complet, false);
  assert.deepEqual(acquis.octets.kernel, contenu("kernel"));
});

test("sans magasin (pas d'OPFS) : téléchargé et vérifié, réserve incomplète", async () => {
  const m = monde();
  const acquis = await acquerir(m, { magasin: null });
  assert.deepEqual(Object.values(acquis.magasin), Array(5).fill("absent"));
  assert.equal(acquis.complet, false);
});

test("hors connexion sans magasin : refus typé", async () => {
  const m = monde();
  await assert.rejects(acquerir(m, { magasin: null, horsConnexion: true }), {
    code: "VAULT_COQUILLE_HORS_LIGNE_ARTEFACT_ABSENT",
  });
});

test("le code de l'artefact absent est celui du registre de la coquille (deux modules, une chaîne)", async () => {
  const { CODE_ARTEFACT_ABSENT_HORS_CONNEXION } =
    await import("../../src/vm/artefact-absent-hors-connexion.mjs");
  const { CODES_REFUS_COQUILLE } = await import("../../src/coquille/refus-de-coquille.mjs");
  assert.equal(CODES_REFUS_COQUILLE.horsLigneArtefactAbsent, CODE_ARTEFACT_ABSENT_HORS_CONNEXION);
});
