/**
 * Le MAGASIN D'ARTEFACTS (#247, lot D1) : un cache rangé sous l'empreinte, jamais une vérité.
 *
 * Exigé ici : rien n'est servi sans vérification (racine du descripteur, ou `sha256` entier) ; un
 * artefact partiel n'est jamais servi ; une altération de l'OPFS — même tranches ET liste ensemble —
 * est rejetée et oubliée ; l'admission consulte le budget AVANT d'écrire et refuse par une erreur
 * typée ; la purge garde ce qu'on lui nomme.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  AdmissionRefusee,
  TRANCHE_OCTETS,
  creerMagasinDArtefacts,
  empreintesDeTranches,
  racineDesTranches,
} from "../../src/vm/magasin-d-artefacts.mjs";
import { primitivesEnMemoire } from "./magasin-en-memoire.mjs";

const empreinteDe = (octets) => createHash("sha256").update(octets).digest("hex");

function artefact(taille, marque = 7) {
  const octets = new Uint8Array(taille);
  for (let index = 0; index < taille; index += 1) octets[index] = (marque + index) % 251;
  return { octets, sha256: empreinteDe(octets) };
}

const TAILLE = 2 * TRANCHE_OCTETS + 12345;

test("la racine est le SHA-256 de la concaténation des empreintes brutes de tranches", async () => {
  const { octets } = artefact(TAILLE);
  const tranches = await empreintesDeTranches(octets);
  assert.equal(tranches.length, 3);
  assert.equal(tranches[2], empreinteDe(octets.subarray(2 * TRANCHE_OCTETS)));
  const attendue = createHash("sha256")
    .update(Buffer.concat(tranches.map((hex) => Buffer.from(hex, "hex"))))
    .digest("hex");
  assert.equal(await racineDesTranches(tranches), attendue);
});

test("un artefact admis est servi, par la racine comme par le sha256 entier, en lectures de 8 Mio", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  const { octets, sha256 } = artefact(TAILLE);
  const { racine } = await magasin.admettre({ sha256, octets });

  for (const morceau of [
    { sha256, octets: TAILLE, racine },
    { sha256, octets: TAILLE },
  ]) {
    primitives.lectures.length = 0;
    const cible = new Uint8Array(TAILLE);
    assert.equal(await magasin.servir(morceau, cible), true);
    assert.deepEqual(cible, octets);
    assert.ok(primitives.lectures.every((n) => n >= TRANCHE_OCTETS || n === 12345));
  }
});

test("un artefact absent ou partiel n'est jamais servi", async () => {
  const primitives = primitivesEnMemoire();
  const { octets, sha256 } = artefact(TAILLE);
  const magasin = creerMagasinDArtefacts({ primitives });
  assert.equal(await magasin.servir({ sha256, octets: TAILLE }, new Uint8Array(TAILLE)), false);

  primitives.renommer = async () => {
    throw new Error("coupure avant le renommage");
  };
  await assert.rejects(magasin.admettre({ sha256, octets }), /coupure/);
  assert.equal(await magasin.servir({ sha256, octets: TAILLE }, new Uint8Array(TAILLE)), false);
  assert.deepEqual(await primitives.lister(), [], "l'entrée partielle est oubliée");
});

test("une lecture COURTE refuse, même si la cible contient déjà les bons octets", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  const { octets, sha256 } = artefact(TAILLE);
  await magasin.admettre({ sha256, octets });
  primitives.lire = async () => 0;
  assert.equal(await magasin.servir({ sha256, octets: TAILLE }, octets.slice()), false);
});

test("une tranche altérée est rejetée et oubliée, avec ou sans racine", async () => {
  for (const avecRacine of [true, false]) {
    const primitives = primitivesEnMemoire();
    const magasin = creerMagasinDArtefacts({ primitives });
    const { octets, sha256 } = artefact(TAILLE);
    const { racine } = await magasin.admettre({ sha256, octets });
    primitives.fichiers.get(sha256)[TRANCHE_OCTETS + 3] ^= 1;
    const morceau = avecRacine ? { sha256, octets: TAILLE, racine } : { sha256, octets: TAILLE };
    assert.equal(await magasin.servir(morceau, new Uint8Array(TAILLE)), false);
    assert.equal(primitives.fichiers.has(sha256), false);
  }
});

test("réécrire ENSEMBLE une tranche et sa liste ne trompe pas la racine du descripteur", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  const { octets, sha256 } = artefact(TAILLE);
  const { racine } = await magasin.admettre({ sha256, octets });

  const falsifie = primitives.fichiers.get(sha256);
  falsifie[5] ^= 1;
  const tranches = await empreintesDeTranches(falsifie);
  const liste = JSON.stringify({ sha256, octets: TAILLE, tranches });
  primitives.fichiers.set(sha256 + ".tranches", new TextEncoder().encode(liste));

  assert.equal(
    await magasin.servir({ sha256, octets: TAILLE, racine }, new Uint8Array(TAILLE)),
    false,
  );
  assert.equal(primitives.fichiers.has(sha256), false);
});

test("une liste illisible ou d'une autre taille est rejetée", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  const { octets, sha256 } = artefact(TAILLE);
  const { racine } = await magasin.admettre({ sha256, octets });
  primitives.fichiers.set(sha256 + ".tranches", new TextEncoder().encode("{pas du json"));
  assert.equal(
    await magasin.servir({ sha256, octets: TAILLE, racine }, new Uint8Array(TAILLE)),
    false,
  );
});

test("l'admission consulte le budget AVANT d'écrire, et refuse par une erreur typée", async () => {
  const primitives = primitivesEnMemoire();
  const demandes = [];
  const magasin = creerMagasinDArtefacts({
    primitives,
    peutAdmettre: async (n) => {
      demandes.push(n);
      return false;
    },
  });
  const { octets, sha256 } = artefact(TAILLE);
  const refus = await magasin.admettre({ sha256, octets }).catch((e) => e);
  assert.ok(refus instanceof AdmissionRefusee);
  assert.equal(refus.code, "VAULT-ARTEFACTS-ADMISSION-REFUSEE");
  assert.deepEqual(demandes, [TAILLE]);
  assert.deepEqual(primitives.ecritures, []);
});

test("la purge garde les empreintes nommées et oublie les orphelines", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  const a = artefact(1000, 1);
  const b = artefact(1000, 2);
  await magasin.admettre(a);
  await magasin.admettre(b);
  assert.deepEqual(await magasin.purger([a.sha256]), [b.sha256]);
  assert.deepEqual((await primitives.lister()).sort(), [a.sha256, a.sha256 + ".tranches"].sort());
});
