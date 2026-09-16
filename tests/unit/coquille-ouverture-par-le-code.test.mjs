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
import {
  DERIVATION_ERROR_CODES,
  isDerivationError,
} from "../../src/vm/derivation/derivation-errors.mjs";
import { encoderParametresPublics } from "../../src/vm/derivation/parametres-publics.mjs";
import { creerMoyenDeRecuperation } from "../../src/vm/moyen-de-recuperation.mjs";
import { ajouterEmplacement, inventorierEnveloppe } from "../../src/vm/enveloppe-de-cle.mjs";
import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { EMPLACEMENTS_MAX, TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { KEK, VOLUME_A, magasin, poserVolume } from "./support-archive-recuperation.mjs";
import { suiteDOctets } from "./support-enveloppe-double.mjs";

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
    "sur une page v2, un succès ne coûte qu'UNE ouverture de racine de plus qu'un refus : les " +
      "tentatives, elles, sont au même nombre. La première ouverture d'une page v1 y ajoute sa " +
      "migration et sa relecture (mesuré : 11 decrypt au succès, 6 au refus, une seule migration " +
      "quel que soit le rang)",
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

// --- Revue de sécurité de la PR #219 : AUCUN refus ne sort de la boucle (constats 1, 2) ----------

/** Compte les lectures du support d'enveloppe pendant un geste. */
function supportCompte(support) {
  const compte = { lectures: 0 };
  const lire = (...args) => {
    compte.lectures += 1;
    return support.lire(...args);
  };
  return { support: Object.freeze({ ...support, lire }), compte };
}

test("le coût d'un REJEU ne dépend pas du RANG de l'emplacement qui l'a rendu", async () => {
  // Constat 1 : un REJEU n'arrive qu'avec la BONNE clé. S'il sortait de la boucle, ouvrir sous une
  // ancre trop haute coûterait un essai au premier code et sept au septième — un oracle du rang.
  const { support, codes } = await coffreAvecCodes(7);
  const refus = [];
  const cout = async (code) =>
    appelsAead(() => ouvrir(support, code, 99).catch((erreur) => refus.push(erreur)));

  const parLePremier = await cout(codes[0]);
  const parLeDernier = await cout(codes[6]);

  assert.equal(refus.length, 2, "les deux ouvertures sont refusées");
  for (const erreur of refus) {
    assert.ok(
      isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.rejeu),
      `le refus est un REJEU quel que soit le rang (reçu ${erreur?.code})`,
    );
  }
  assert.equal(
    parLePremier,
    parLeDernier,
    "le coût d'un REJEU dépend du RANG de l'emplacement : il désigne la feuille employée",
  );
  assert.ok(parLePremier >= 7 * EMPLACEMENTS_MAX, "les sept clés doivent être toutes essayées");
});

test("un type 4 aux paramètres ILLISIBLES ne masque pas un code valable posé après lui", async () => {
  // Constat 2 : un emplacement écrit par un produit plus récent (octet de version 2) fait refuser SA
  // dérivation. Ce refus dit quelque chose de CET emplacement, pas du fichier : les suivants restent
  // essayés, et le code qui leur répond ouvre.
  const banc = magasin();
  const { support } = await poserVolume(banc, { avecRecuperation: false });
  await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek: KEK,
    kekNouvelle: suiteDOctets(0x40, 32),
    typeKek: TYPES_KEK.recuperation,
    parametres: encoderParametresPublics(TYPES_KEK.recuperation, {
      version: 2,
      sel: "ab".repeat(32),
    }),
    identifiantEmplacement: "0123456789abcdef",
  });
  const moyen = await creerMoyenDeRecuperation({ support, identifiantVolume: VOLUME_A, kek: KEK });
  const code = moyen.rendre();

  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME_A });
  assert.equal(emplacementsDeRecuperation(inventaire).length, 2, "l'illisible est le PREMIER");

  const ouverte = await ouvrir(support, code);
  assert.equal(ouverte.dek.byteLength, 32, "le code valable ouvre malgré l'emplacement illisible");
  assert.equal(ouverte.identifiantEmplacement, moyen.identifiantEmplacement);

  const autre = await coffreAvecCodes(1);
  await assert.rejects(
    () => ouvrir(support, autre.codes[0]),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses),
    "sans succès, le refus ÉTABLI de l'emplacement illisible l'emporte sur « clé refusée »",
  );
});

test("un code MAL RECOPIÉ : une seule lecture de l'enveloppe, zéro déchiffrement", async () => {
  const { support: reel, codes } = await coffreAvecCodes(3);
  const mal = `${codes[1].slice(0, -1)}${codes[1].endsWith("0") ? "1" : "0"}`;

  const inventaire = supportCompte(reel);
  await inventorierEnveloppe({ support: inventaire.support, identifiantVolume: VOLUME_A });

  const essai = supportCompte(reel);
  let refus = null;
  const appels = await appelsAead(() =>
    ouvrir(essai.support, mal).catch((erreur) => {
      refus = erreur;
    }),
  );

  assert.ok(
    isDerivationError(refus, DERIVATION_ERROR_CODES.codeMalRecopie),
    `le refus est « mal recopié » (reçu ${refus?.code})`,
  );
  assert.equal(appels, 0, "aucune clé n'est essayée pour un code dont la somme ne vérifie pas");
  assert.equal(
    essai.compte.lectures,
    inventaire.compte.lectures,
    "le refus tombe après l'inventaire et avant toute ouverture",
  );
});
