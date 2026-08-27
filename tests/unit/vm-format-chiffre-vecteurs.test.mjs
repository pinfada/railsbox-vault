import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { ALGORITHME } from "../../src/vm/format-chiffre/identite-logique.mjs";
import {
  importerCleDeVolume,
  ouvrirBloc,
  ouvrirRacine,
  scellerBloc,
  scellerRacine,
} from "../../src/vm/format-chiffre/modele-reference.mjs";
import { hexEnOctets, octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";

// Vecteurs FIGÉS du format chiffré (#17, ADR 0015).
//
// Ce fichier a un rôle précis, et un seul : #18 et #19 devront reproduire ces octets À L'IDENTIQUE.
// Un modèle qui changerait — un champ ajouté aux données associées, un ordre d'octets inversé, une
// borne de nonce déplacée — doit faire ROUGIR cette épreuve, parce qu'un tel changement casse la
// compatibilité d'un format persistant. C'est la même règle que `tests/unit/compat-vectors.test.mjs`
// applique à la matrice de compatibilité, transposée à un format.
//
// Les vecteurs sont produits par `node tools/figer-vecteurs-scellement.mjs`, qui écrit ce fichier
// depuis le modèle. Régénérer n'est PAS une correction : c'est un changement de format, qui exige
// une version et un ADR.

const VECTEURS = JSON.parse(
  readFileSync(new URL("../vectors/format-chiffre-v1.json", import.meta.url), "utf8"),
);

/** Reconstruit le contenu d'un vecteur depuis sa RÈGLE, jamais depuis ses octets. */
function contenuDepuisRegle({ longueur, graine }) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 7 + 13 + graine) % 256);
}

test("les vecteurs annoncent l'algorithme et la version que le modèle implémente", () => {
  assert.equal(VECTEURS.specification.algorithme, ALGORITHME);
  assert.equal(VECTEURS.specification.nonceOctets, 12);
  assert.equal(VECTEURS.specification.etiquetteOctets, 16);
  assert.equal(VECTEURS.cle.usage, "TEST");
  assert.ok(
    VECTEURS.avertissement.includes("TEST"),
    "un lecteur qui tomberait sur ce fichier doit savoir en une ligne que la clé n'est pas un secret",
  );
});

test("le contenu de chaque vecteur découle de sa règle publiée, pas seulement de ses octets", () => {
  for (const vecteur of VECTEURS.blocs) {
    const reconstruit = contenuDepuisRegle(vecteur.contenu);
    assert.equal(
      octetsEnHex(reconstruit),
      vecteur.contenu.hex,
      `le contenu du vecteur « ${vecteur.nom} » ne suit pas sa règle`,
    );
  }
});

test("le modèle reproduit OCTET POUR OCTET les blocs scellés figés", async () => {
  const cle = await importerCleDeVolume(hexEnOctets(VECTEURS.cle.hex));

  for (const vecteur of VECTEURS.blocs) {
    const scelle = await scellerBloc({
      cle,
      identite: vecteur.identite,
      contenu: contenuDepuisRegle(vecteur.contenu),
    });
    assert.equal(octetsEnHex(scelle.nonce), vecteur.attendu.nonce, `nonce de « ${vecteur.nom} »`);
    assert.equal(
      octetsEnHex(scelle.chiffre),
      vecteur.attendu.chiffre,
      `chiffré de « ${vecteur.nom} »`,
    );
    assert.equal(
      octetsEnHex(scelle.etiquette),
      vecteur.attendu.etiquette,
      `étiquette de « ${vecteur.nom} »`,
    );
  }
});

test("le modèle rouvre les blocs figés depuis leurs seuls octets publiés", async () => {
  const cle = await importerCleDeVolume(hexEnOctets(VECTEURS.cle.hex));

  for (const vecteur of VECTEURS.blocs) {
    const ouvert = await ouvrirBloc({
      cle,
      identite: vecteur.identite,
      scelle: {
        nonce: hexEnOctets(vecteur.attendu.nonce),
        chiffre: hexEnOctets(vecteur.attendu.chiffre),
        etiquette: hexEnOctets(vecteur.attendu.etiquette),
      },
    });
    assert.equal(octetsEnHex(ouvert), vecteur.contenu.hex, `réouverture de « ${vecteur.nom} »`);
  }
});

test("le modèle reproduit OCTET POUR OCTET les racines scellées figées", async () => {
  const cle = await importerCleDeVolume(hexEnOctets(VECTEURS.cle.hex));

  for (const vecteur of VECTEURS.racines) {
    const entrees = vecteur.entrees.map((entree) => ({
      ...entree,
      etiquette: hexEnOctets(entree.etiquette),
    }));
    const racine = await scellerRacine({ cle, racine: vecteur.racine, entrees });

    assert.equal(octetsEnHex(racine.nonce), vecteur.attendu.nonce, `nonce de « ${vecteur.nom} »`);
    assert.equal(
      octetsEnHex(racine.chiffre),
      vecteur.attendu.chiffre,
      `chiffré de « ${vecteur.nom} »`,
    );
    assert.equal(
      octetsEnHex(racine.etiquette),
      vecteur.attendu.etiquette,
      `étiquette de « ${vecteur.nom} »`,
    );
    assert.equal(
      octetsEnHex(racine.empreinteEntrees),
      vecteur.attendu.empreinteEntrees,
      `empreinte des entrées de « ${vecteur.nom} »`,
    );
    assert.equal(racine.entete.nombreEntrees, vecteur.attendu.nombreEntrees);
    assert.equal(racine.entete.longueurCharge, vecteur.attendu.longueurCharge);
  }
});

test("le modèle rouvre les racines figées depuis leurs seuls octets publiés", async () => {
  const cle = await importerCleDeVolume(hexEnOctets(VECTEURS.cle.hex));

  for (const vecteur of VECTEURS.racines) {
    const entrees = vecteur.entrees.map((entree) => ({
      ...entree,
      etiquette: hexEnOctets(entree.etiquette),
    }));
    const entete = {
      ...vecteur.racine,
      nombreEntrees: vecteur.attendu.nombreEntrees,
      longueurCharge: vecteur.attendu.longueurCharge,
    };
    const ouverte = await ouvrirRacine({
      cle,
      entete,
      scelle: {
        nonce: hexEnOctets(vecteur.attendu.nonce),
        chiffre: hexEnOctets(vecteur.attendu.chiffre),
        etiquette: hexEnOctets(vecteur.attendu.etiquette),
      },
      entrees,
      attentes: {
        volume: vecteur.racine.volume,
        formatVersion: vecteur.racine.formatVersion,
        tailleVolume: vecteur.racine.tailleVolume,
        sequenceMinimale: 0,
      },
    });
    assert.equal(
      octetsEnHex(ouverte.empreinteEntrees),
      vecteur.attendu.empreinteEntrees,
      `réouverture de « ${vecteur.nom} »`,
    );
  }
});

test("les vecteurs couvrent les cinq menaces plutôt qu'un seul cas heureux", () => {
  const couverts = new Set(VECTEURS.blocs.flatMap((vecteur) => vecteur.couvre));
  for (const menace of ["modification", "deplacement", "rejeu", "troncature", "melange"]) {
    assert.ok(
      couverts.has(menace) || VECTEURS.racines.some((r) => r.couvre.includes(menace)),
      `aucun vecteur ne couvre la menace « ${menace} »`,
    );
  }
});
