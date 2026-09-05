/**
 * La VÉRIFICATION D'EMPREINTE AU CHARGEMENT (#123, constat 2 de la revue de sécurité).
 *
 * L'adresse porte SEIZE caractères hexadécimaux ; le manifeste en épingle SOIXANTE-QUATRE. Ce
 * fichier tient la différence : que les octets reçus soient confrontés aux 256 bits avant de servir
 * à quoi que ce soit, et qu'un octet altéré soit un refus TYPÉ plutôt qu'un émulateur qui part sur
 * des octets d'une autre version — panne qui se déguiserait ensuite en guest lent.
 *
 * Ce que cette vérification couvre, et pourquoi elle ne doublonne pas celle de la publication :
 * elle attrape l'ACCIDENT — un cache qui garde un artefact à côté d'un manifeste d'une autre
 * version, un intermédiaire qui touche le `.wasm` sans toucher au `.mjs`, un dépôt partiel, un octet
 * retourné en chemin. Un cache d'un an rend ces accidents plus probables, pas moins.
 *
 * Ce qu'elle NE couvre PAS : une origine qui ment aux deux du même geste — l'empreinte attendue
 * vient du manifeste servi par cette même origine. Cette défense-là est `verifierEpinglageV86`, sur
 * l'arbre construit à partir d'un commit, avant qu'il ne parte.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CODE_EMPREINTE_V86,
  ErreurEmpreinteV86,
  adresseDe,
  adressesDuManifeste,
  artefactALAdresse,
  empreinteSha256Hex,
  recupererArtefactV86,
  verifierOctetsV86,
} from "../../src/v86-adresses.mjs";

const OCTETS = new TextEncoder().encode("des octets d'émulateur");

/** Le manifeste que l'ADR 0003 publierait pour ces octets-là. */
async function manifestePour(octets) {
  return {
    artifacts: [
      { name: "v86.wasm", bytes: octets.byteLength, sha256: await empreinteSha256Hex(octets) },
    ],
  };
}

/** Une origine qui sert des octets choisis à l'adresse demandée. */
function origineQuiSert(octets, { statut = 200 } = {}) {
  return async () => ({
    ok: statut >= 200 && statut < 300,
    status: statut,
    arrayBuffer: async () => Uint8Array.from(octets).buffer,
  });
}

/** Récupère par la porte unique du chargement, sur une origine simulée. */
function recuperer(manifeste, origine) {
  return recupererArtefactV86("v86.wasm", {
    manifeste,
    adresses: adressesDuManifeste(manifeste),
    fetch: origine,
  });
}

// --- VERT : les octets attendus passent ----------------------------------------------------------

test("des octets conformes au manifeste sont rendus tels quels", async () => {
  const manifeste = await manifestePour(OCTETS);
  assert.deepEqual(await recuperer(manifeste, origineQuiSert(OCTETS)), OCTETS);
});

// --- ROUGE : un octet altéré est un refus TYPÉ ---------------------------------------------------

test("UN OCTET altéré est refusé, et le refus porte de quoi diagnostiquer", async () => {
  // Le cœur de la mesure. Les octets ont la BONNE TAILLE et sont servis à la BONNE ADRESSE : seule
  // l'empreinte les distingue. C'est exactement la forme d'un accident — un octet retourné en
  // chemin, une écriture de cache interrompue — que l'adresse seule ne peut pas voir.
  const manifeste = await manifestePour(OCTETS);
  const altere = Uint8Array.from(OCTETS);
  altere[0] ^= 0x01;

  await assert.rejects(() => recuperer(manifeste, origineQuiSert(altere)), ErreurEmpreinteV86);

  try {
    await recuperer(manifeste, origineQuiSert(altere));
    assert.fail("un octet altéré doit être refusé");
  } catch (erreur) {
    assert.equal(erreur.code, CODE_EMPREINTE_V86);
    assert.equal(erreur.contexte.artefact, "v86.wasm");
    assert.equal(erreur.contexte.adresse, adresseDe("v86.wasm", manifeste.artifacts[0].sha256));
    assert.equal(erreur.contexte.attendu, manifeste.artifacts[0].sha256);
    assert.notEqual(erreur.contexte.mesure, erreur.contexte.attendu);
    assert.match(erreur.message, /soixante-quatre/);
    // Sérialisable : un Worker le renvoie à la page par `postMessage`, comme les erreurs typées du
    // runtime. Un refus qu'on ne peut pas transmettre se perd en « échec inconnu ».
    assert.deepEqual(Object.keys(erreur.toJSON()).sort(), ["code", "contexte", "message"]);
  }
});

test("une réponse TRONQUÉE est refusée sur sa taille, avec le diagnostic qui va avec", async () => {
  // La taille est vérifiée avant l'empreinte, et ce n'est pas une optimisation : « 11 octets au
  // lieu de 24 » est immédiatement actionnable, là où une empreinte qui ne correspond pas ne dit
  // pas POURQUOI. C'est le mode de panne le plus banal d'un réseau.
  const manifeste = await manifestePour(OCTETS);
  try {
    await recuperer(manifeste, origineQuiSert(OCTETS.slice(0, 11)));
    assert.fail("une réponse tronquée doit être refusée");
  } catch (erreur) {
    assert.equal(erreur.code, CODE_EMPREINTE_V86);
    assert.equal(erreur.contexte.attendu, OCTETS.byteLength);
    assert.equal(erreur.contexte.mesure, 11);
    assert.match(erreur.message, /tronquée/);
  }
});

test("une adresse indisponible est refusée par le même type, jamais par un tampon vide", async () => {
  const manifeste = await manifestePour(OCTETS);
  try {
    await recuperer(manifeste, origineQuiSert(OCTETS, { statut: 404 }));
    assert.fail("un 404 doit être refusé");
  } catch (erreur) {
    assert.equal(erreur.code, CODE_EMPREINTE_V86);
    assert.equal(erreur.contexte.statut, 404);
  }
});

// --- Ce que le chemin de boot doit savoir distinguer ---------------------------------------------

test("une adresse qui ne relève PAS de ce manifeste n'est pas vérifiée ici", async () => {
  // Le banc de l'image de référence reçoit sept URL, dont cinq viennent de l'image #5 et ont leur
  // propre épinglage. Prétendre les vérifier avec le manifeste v86 les refuserait toutes ; les
  // ignorer en silence serait pire. `artefactALAdresse` rend `null`, et l'appelant le sait.
  const manifeste = await manifestePour(OCTETS);
  assert.equal(artefactALAdresse(manifeste, "/artifacts/reference-image/seabios.bin"), null);
  assert.equal(
    artefactALAdresse(manifeste, adresseDe("v86.wasm", manifeste.artifacts[0].sha256))?.name,
    "v86.wasm",
  );
});

test("ce sont les 256 BITS qui font foi, pas les seize caractères du nom", async () => {
  // La mesure qui dit ce que cette vérification AJOUTE à l'adressage par empreinte. Des octets dont
  // l'empreinte partagerait les seize premiers caractères de l'attendue seraient servis à une
  // adresse INDISCERNABLE de la bonne — et sont pourtant refusés.
  const attendu = await empreinteSha256Hex(OCTETS);
  const contrefait = `${attendu.slice(0, 16)}${"0".repeat(48)}`;
  assert.notEqual(contrefait, attendu);
  assert.equal(
    adresseDe("v86.wasm", contrefait),
    adresseDe("v86.wasm", attendu),
    "les deux adresses sont indiscernables : l'adresse seule ne suffit donc pas",
  );
  await assert.rejects(
    () => verifierOctetsV86(OCTETS, { name: "v86.wasm", sha256: contrefait }, "/peu/importe"),
    ErreurEmpreinteV86,
  );
});
