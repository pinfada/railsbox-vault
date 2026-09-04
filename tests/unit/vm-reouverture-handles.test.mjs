import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

// BANC DE MESURE de la réouverture après coupure (#129).
//
// Il répond à une question que `tests/vm/resilience-arrets.spec.mjs` posait sans jamais la mesurer :
// **combien de handles exclusifs un volume v3 tient-il pendant une session, et dans quel ordre
// sont-ils saisis ?** L'assertion `reouverture.essais === 1` de cette suite tenait pour acquis qu'il
// n'y en avait qu'un ; depuis #19 elle rougissait deux nuits sur trois.
//
// La mesure se fait sous Node, sur le double déterministe, parce que le NOMBRE de handles et leur
// ORDRE d'acquisition sont une propriété de l'ouvreur — `src/vm/opfs-volume-ouverture.mjs` — et pas
// du moteur. Ce que le double ne peut PAS mesurer, et ne prétend pas mesurer, c'est le DÉLAI que
// Chromium met à rendre l'exclusivité d'un fichier après la mort d'un Worker : `abandon` la rend ici
// sur-le-champ. Ce délai-là ne s'observe que sur le vrai support, et c'est le relevé `reouverture`
// de la suite VM qui le publie.

const TAILLE = 64 * SECTOR_SIZE;

/** Les trois voisins qu'une session tient. Écrits en toutes lettres : c'est la mesure elle-même. */
const HANDLES_DE_SESSION = ["mesure", "mesure.gen", "mesure.temoin"];

/**
 * Support instrumenté : le double, plus le JOURNAL des saisies et des restitutions de handles.
 *
 * C'est la seule chose que ce banc ajoute au double, et c'est celle qui manquait : `isOpen` dit
 * l'état à un instant, le journal dit l'ORDRE — et l'ordre est la moitié de la question.
 */
function supportInstrumente(configuration = {}) {
  const store = createSyncAccessStore(configuration);
  const gestes = [];
  const openHandle = async (nom) => {
    let handle;
    try {
      handle = await store.openHandle(nom);
    } catch (cause) {
      gestes.push({ nom, geste: "refuse" });
      throw cause;
    }
    gestes.push({ nom, geste: "saisi" });
    return tracerFermeture(handle, nom, gestes);
  };
  const noms = (geste) => gestes.filter((g) => g.geste === geste).map((g) => g.nom);
  return { store, openHandle, gestes, noms };
}

/** Enveloppe un handle pour dater sa restitution, sans rien changer au reste de sa surface. */
function tracerFermeture(handle, nom, gestes) {
  return new Proxy(handle, {
    get(cible, propriete) {
      if (propriete !== "close") return Reflect.get(cible, propriete);
      return () => {
        gestes.push({ nom, geste: "rendu" });
        return cible.close();
      };
    },
  });
}

/** Ouvre un volume de mesure sur le support donné. La clé est celle des épreuves. */
function ouvrir(openHandle, options = {}) {
  return openOpfsVolume({ name: "mesure", cle: CLE_DE_TEST, openHandle, ...options });
}

test("MESURE — une session de volume v3 tient TROIS handles, saisis dans un ordre fixe", async () => {
  const { openHandle, noms } = supportInstrumente();

  const backend = await ouvrir(openHandle, { size: TAILLE });

  // Le volume, son journal de génération (#16), son témoin de séquence (#19). L'enveloppe de clé
  // (#21) n'en fait PAS partie : `supportEnveloppeOpfs` ouvre et referme son handle à chaque geste,
  // et le banc de résilience ne passe pas par elle — il reçoit la clé du harnais.
  assert.deepEqual(noms("saisi"), HANDLES_DE_SESSION);
  assert.deepEqual(noms("rendu"), [], "les trois sont TENUS, aucun n'est rendu en cours de route");

  await backend.close();
  assert.deepEqual(new Set(noms("rendu")), new Set(HANDLES_DE_SESSION));
});

test("MESURE — un SEUL des trois handles encore tenu suffit à rendre « busy »", async () => {
  for (const retenu of HANDLES_DE_SESSION) {
    const { store, openHandle } = supportInstrumente();
    const backend = await ouvrir(openHandle, { size: TAILLE });
    await backend.close();

    // Un détenteur fantôme : le handle que la session morte n'a pas encore rendu.
    const fantome = await store.openHandle(retenu);
    await assert.rejects(
      () => ouvrir(openHandle),
      (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.busy),
      `« ${retenu} » encore tenu doit refuser l'ouverture, pas la laisser passer`,
    );
    fantome.close();

    // Et le refus n'est pas définitif : le fantôme parti, la réouverture aboutit du premier coup.
    const rouvert = await ouvrir(openHandle);
    await rouvert.close();
  }
});

test("MESURE — un refus sur le DERNIER handle a déjà saisi puis rendu les deux premiers", async () => {
  const { store, openHandle, noms } = supportInstrumente();
  const backend = await ouvrir(openHandle, { size: TAILLE });
  await backend.close();

  const fantome = await store.openHandle("mesure.temoin");
  const avant = noms("saisi").length;
  await assert.rejects(
    () => ouvrir(openHandle),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.busy),
  );
  fantome.close();

  // L'essai perdu a coûté DEUX saisies et DEUX restitutions, plus un refus. C'est ce que chaque
  // `essai` de `rouvrirApresCoupure` paie tant que le dernier voisin n'est pas rendu — et c'est
  // pourquoi la réouverture aboutit quand le PLUS LENT des trois est rendu, pas le premier.
  assert.deepEqual(noms("saisi").slice(avant), ["mesure", "mesure.gen"]);
  assert.deepEqual(noms("refuse"), ["mesure.temoin"]);
  assert.equal(
    store.isOpen("mesure"),
    false,
    "un refus tardif ne laisse aucun handle derrière lui",
  );
  assert.equal(store.isOpen("mesure.gen"), false);
});
