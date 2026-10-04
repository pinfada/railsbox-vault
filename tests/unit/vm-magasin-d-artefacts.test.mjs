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
import { borneDansLeTemps } from "../../src/vm/magasin-opfs.mjs";
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

// --- Revue de sécurité du 04/10/2026 ---------------------------------------------------------------

test("une lecture qui se dit COURTE refuse, même si les octets reçus sont les bons", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  const { octets, sha256 } = artefact(TAILLE);
  await magasin.admettre({ sha256, octets });
  const lire = primitives.lire;
  primitives.lire = async (...args) => (await lire(...args)) - 1;
  assert.equal(await magasin.servir({ sha256, octets: TAILLE }, new Uint8Array(TAILLE)), false);
});

const attendre = (ms) => new Promise((resoudre) => setTimeout(resoudre, ms));

/** Primitives LENTES : chaque lecture attend `ms` avant de rendre ses octets. */
function ralentir(primitives, ms) {
  const lire = primitives.lire;
  primitives.lire = async (nom, position, cible) => {
    await attendre(ms);
    return lire(nom, position, cible);
  };
}

test("une tranche n'est copiée dans la cible qu'APRÈS vérification : l'altérée n'y entre jamais", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  const { octets, sha256 } = artefact(TAILLE);
  const { racine } = await magasin.admettre({ sha256, octets });
  primitives.fichiers.get(sha256).fill(0xfe, TRANCHE_OCTETS, 2 * TRANCHE_OCTETS);

  const cible = new Uint8Array(TAILLE);
  assert.equal(await magasin.servir({ sha256, octets: TAILLE, racine }, cible), false);
  assert.ok(
    cible.subarray(TRANCHE_OCTETS, 2 * TRANCHE_OCTETS).every((o) => o !== 0xfe),
    "aucun octet de la tranche altérée n'a touché la cible",
  );
});

test("servir abandonné à l'échéance n'écrit plus rien : la cible garde les octets téléchargés", async () => {
  for (const avecRacine of [false, true]) {
    const primitives = primitivesEnMemoire();
    const magasin = creerMagasinDArtefacts({ primitives });
    const { octets, sha256 } = artefact(TAILLE);
    const { racine } = await magasin.admettre({ sha256, octets });
    // L'OPFS ALTÉRÉ — sans racine, rien ne le voit avant le digest final — et LENT.
    if (!avecRacine) primitives.fichiers.get(sha256).fill(0xfe);
    ralentir(primitives, 15);
    const borne = borneDansLeTemps(magasin, 5);
    const cible = new Uint8Array(TAILLE);
    const morceau = avecRacine ? { sha256, octets: TAILLE, racine } : { sha256, octets: TAILLE };

    assert.equal(await borne.servir(morceau, cible), false);
    cible.set(octets); // l'appelant télécharge par-dessus toute la plage
    await attendre(150); // l'opération abandonnée a eu le temps de parcourir toutes ses tranches

    assert.ok(!cible.includes(0xfe), "aucun octet de l'OPFS après l'échéance");
    assert.equal(empreinteDe(cible), sha256, "le tampon final est celui du descripteur");
    assert.ok(primitives.fichiers.has(sha256), "un abandon ne juge pas l'entrée : elle reste");
  }
});

test("sans racine, un sha256 final faux rend false et oublie l'entrée : l'appelant retélécharge", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  const { octets, sha256 } = artefact(TAILLE);
  await magasin.admettre({ sha256, octets });
  primitives.fichiers.get(sha256)[TAILLE - 1] ^= 1;
  assert.equal(await magasin.servir({ sha256, octets: TAILLE }, new Uint8Array(TAILLE)), false);
  assert.equal(primitives.fichiers.has(sha256), false);
});

test("une racine incohérente à l'admission : rien n'est rangé, refus typé et journalisé", async () => {
  const primitives = primitivesEnMemoire();
  const journal = [];
  const magasin = creerMagasinDArtefacts({ primitives, signaler: (m) => journal.push(m) });
  const { octets, sha256 } = artefact(TAILLE);
  await assert.rejects(magasin.admettre({ sha256, octets, racine: "0".repeat(64) }), {
    code: "MAGASIN_RACINE_INCOHERENTE",
  });
  assert.deepEqual(await primitives.lister(), [], "ni octets, ni liste, ni partiel");
  assert.equal(journal.length, 1);
  assert.match(journal[0], /MAGASIN_RACINE_INCOHERENTE/);

  const racine = await racineDesTranches(await empreintesDeTranches(octets));
  const admis = await magasin.admettre({ sha256, octets, racine });
  assert.equal(admis.racine, racine, "la bonne racine est admise");
  assert.ok(primitives.fichiers.has(sha256));
});

test("une admission abandonnée (jeton annulé) cesse d'écrire et ne renomme rien", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  const { octets, sha256 } = artefact(TAILLE);
  const jeton = { annule: false };
  const ecrire = primitives.ecrire;
  primitives.ecrire = async (...args) => {
    await ecrire(...args);
    jeton.annule = true;
  };
  assert.equal(await magasin.admettre({ sha256, octets }, jeton), null);
  assert.equal(primitives.fichiers.has(sha256), false);
  assert.equal(primitives.ecritures.length, 1, "plus aucune écriture après l'annulation");
});
