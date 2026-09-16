/**
 * OUVRIR PAR UN CODE quand le coffre en porte PLUSIEURS (#214).
 *
 * Le produit rend un second code dès que la page est rechargée à l'étape 3 — le porteur de session
 * ne survit pas au Worker —, et ce second code était refusé : `deriverLeCode` CHOISISSAIT le premier
 * emplacement de type 4 et dérivait sous son sel. Ces épreuves posent les emplacements avec les
 * modules RÉELS, sur le magasin en mémoire de `support-archive-recuperation.mjs`, et mesurent ce que
 * le Worker et le banc de référence appellent tous deux : `ouvrirParLeCode`.
 *
 * Ce qu'elles ne mesurent pas : l'OPFS, le port privilégié, le temps d'horloge d'un refus. Le premier
 * relève de `tests/e2e/`, le deuxième de `tests/browser/deverrouillage-frontiere.spec.mjs`, le
 * troisième de personne — l'ADR 0025, limite 9, le dit déjà.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  emplacementsDeRecuperation,
  ouvrirParLeCode,
} from "../../src/coquille/ouverture-par-le-code.mjs";
import { creerMoyenDeRecuperation } from "../../src/vm/moyen-de-recuperation.mjs";
import { inventorierEnveloppe } from "../../src/vm/enveloppe-de-cle.mjs";
import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { EMPLACEMENTS_MAX } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { KEK, VOLUME_A, magasin, poserVolume } from "./support-archive-recuperation.mjs";

/** Le refus que l'appelant fournit quand l'enveloppe ne porte aucun emplacement de récupération. */
function sansEmplacement() {
  const erreur = new Error("Aucun emplacement de récupération dans cette enveloppe.");
  erreur.code = "REFUS_DE_L_APPELANT";
  return erreur;
}

/** Un coffre neuf, et autant de codes de récupération rendus que le produit en rendrait. */
async function coffreAvecCodes(nombre) {
  const banc = magasin();
  const { support, code } = await poserVolume(banc);
  const codes = [code];
  for (let rang = 1; rang < nombre; rang += 1) {
    const moyen = await creerMoyenDeRecuperation({
      support,
      identifiantVolume: VOLUME_A,
      kek: KEK,
    });
    codes.push(moyen.rendre());
  }
  return { support, codes };
}

/** Ouvre sous un code, comme le Worker de confiance et le banc de référence le font. */
async function ouvrir(support, code, versionMinimale = null) {
  return ouvrirParLeCode({
    support,
    identifiantVolume: VOLUME_A,
    code,
    versionMinimale,
    sansEmplacement,
  });
}

/** Compte les appels à `SubtleCrypto.decrypt` pendant un geste, et restaure la primitive. */
async function appelsAead(geste) {
  const vrai = SubtleCrypto.prototype.decrypt;
  let appels = 0;
  SubtleCrypto.prototype.decrypt = function compter(...args) {
    appels += 1;
    return vrai.apply(this, args);
  };
  try {
    await geste();
  } finally {
    SubtleCrypto.prototype.decrypt = vrai;
  }
  return appels;
}

test("deux codes rendus ouvrent le coffre, dans les DEUX ordres", async () => {
  const { support, codes } = await coffreAvecCodes(2);
  assert.notEqual(codes[0], codes[1], "deux créations rendent deux codes distincts");

  const second = await ouvrir(support, codes[1]);
  assert.equal(second.dek.byteLength, 32, "le SECOND code ouvre : c'est le défaut de #214");
  const premier = await ouvrir(support, codes[0]);
  assert.equal(premier.dek.byteLength, 32, "le PREMIER code ouvre encore : rien n'a été révoqué");
  assert.deepEqual([...premier.dek], [...second.dek], "les deux feuilles ouvrent le MÊME coffre");
  assert.notEqual(
    premier.identifiantEmplacement,
    second.identifiantEmplacement,
    "chaque code a son emplacement, son sel et son identifiant",
  );
});

test("sept codes : le SEPTIÈME ouvre, et l'enveloppe est pleine", async () => {
  const { support, codes } = await coffreAvecCodes(7);
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME_A });
  assert.equal(emplacementsDeRecuperation(inventaire).length, 7, "sept emplacements de type 4");
  assert.equal(
    inventaire.emplacements.length,
    EMPLACEMENTS_MAX,
    "la place sur huit est prise : la phrase du harnais et sept codes",
  );

  const ouverte = await ouvrir(support, codes[6]);
  assert.equal(ouverte.dek.byteLength, 32, "le dernier rendu ouvre comme le premier");
});

test("un code ÉTRANGER bien formé est refusé après avoir essayé CHAQUE emplacement", async () => {
  const { support, codes } = await coffreAvecCodes(3);
  const autre = await coffreAvecCodes(1);

  await assert.rejects(
    () => ouvrir(support, autre.codes[0]),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.cleRefusee),
    "le refus reste celui d'aujourd'hui : aucun code neuf n'est inventé",
  );

  const refuse = await appelsAead(() => ouvrir(support, autre.codes[0]).catch(() => {}));
  const ouvert = await appelsAead(() => ouvrir(support, codes[0]));
  assert.ok(
    refuse >= 3 * 4,
    `un refus essaie les trois emplacements sur les quatre clés de la page (${refuse} appels)`,
  );
  assert.equal(
    ouvert - refuse,
    1,
    "un succès ne coûte qu'UNE ouverture de racine de plus qu'un refus : les tentatives, elles, " +
      "sont au même nombre",
  );
});

test("le coût d'une ouverture ne dit pas QUELLE feuille a ouvert", async () => {
  // La garde du court-circuit est ici, et nulle part ailleurs : sans elle, ouvrir avec le premier
  // code rendu coûterait une tentative et ouvrir avec le septième en coûterait sept, si bien que le
  // temps d'un déverrouillage désignerait la feuille employée.
  const { support, codes } = await coffreAvecCodes(7);
  const parLePremier = await appelsAead(() => ouvrir(support, codes[0]));
  const parLeDernier = await appelsAead(() => ouvrir(support, codes[6]));

  assert.equal(
    parLePremier,
    parLeDernier,
    "le coût d'un succès dépend du RANG de l'emplacement : il désigne la feuille employée",
  );
  assert.ok(parLePremier >= 7 * EMPLACEMENTS_MAX, "les sept clés doivent être toutes essayées");
});

test("aucun emplacement de récupération : le refus de l'APPELANT, jamais un code neuf", async () => {
  const banc = magasin();
  const { support } = await poserVolume(banc, { avecRecuperation: false });

  await assert.rejects(
    () => ouvrir(support, "0000-0000-0000-0000-0000-0000-0000"),
    (erreur) => erreur.code === "REFUS_DE_L_APPELANT",
    "le module n'invente pas de refus : celui du Worker et celui du banc restent les leurs",
  );
});

test("une ancre de version plus haute que la page refuse par REJEU, non par clé refusée", async () => {
  const { support, codes } = await coffreAvecCodes(2);

  await assert.rejects(
    () => ouvrir(support, codes[1], 99),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.rejeu),
    "ce qui dit quelque chose du FICHIER remonte tel quel, et n'est pas replié sur un refus de clé",
  );
});
