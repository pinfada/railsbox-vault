import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { hexEnOctets, octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { encoderEnTete } from "../../src/vm/instantane/fichier-instantane.mjs";
import { encoderLiaison } from "../../src/vm/instantane/identite-instantane.mjs";
import {
  importerCleDeVolume,
  ouvrirInstantane,
  scellerInstantaneSousNonce,
} from "../../src/vm/instantane/modele-reference.mjs";

// Vecteurs FIGÉS de l'INSTANTANÉ DE REPRISE (#65, ADR 0024).
//
// Ce fichier a un rôle précis, et un seul : le format persistant doit reproduire ces octets À
// L'IDENTIQUE. Un champ déplacé, un ordre d'octets inversé, une étiquette de domaine retouchée ou un
// champ ajouté aux données associées doivent faire ROUGIR cette épreuve — parce qu'un tel changement
// casse la compatibilité d'un fichier qui survit aux sessions.
//
// Les vecteurs sont produits par `node tools/figer-vecteurs-instantane.mjs`, qui POSE LES OCTETS
// LUI-MÊME depuis la table de l'ADR 0024 plutôt que d'appeler `encoderEnTete` et `encoderLiaison`.
// C'est ce qui en fait un SECOND AVIS sur la disposition : le producteur et le vérificateur ne
// partagent pas leur encodeur. Ils partagent en revanche WebCrypto pour le scellement, et cette
// limite est écrite ici plutôt que passée sous silence — les vecteurs prouvent la DISPOSITION et
// les DONNÉES ASSOCIÉES, pas la primitive.
//
// Régénérer n'est PAS une correction : c'est un changement de format, qui exige une version et un
// ADR.

const VECTEURS = JSON.parse(
  readFileSync(new URL("../vectors/instantane-v1.json", import.meta.url), "utf8"),
);

const CLE = hexEnOctets(VECTEURS.cle.hex);

test("le vecteur déclare la clé de TEST, publique et sans entropie", () => {
  assert.equal(
    VECTEURS.cle.hex,
    "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  );
  assert.equal(VECTEURS.specification, "railsbox-vault/instantane-de-reprise/v1");
});

test("les données associées du chemin de production sont celles du vecteur", () => {
  for (const cas of VECTEURS.cas) {
    const liaison = {
      ...cas.liaison,
      empreinteRegion: hexEnOctets(cas.liaison.empreinteRegion),
      empreinteImage: hexEnOctets(cas.liaison.empreinteImage),
    };
    assert.equal(
      octetsEnHex(encoderLiaison(liaison)),
      cas.donneesAssociees,
      `« ${cas.nom} » : les données associées ne sont plus celles du vecteur`,
    );
  }
});

test("l'en-tête du chemin de production est celui du vecteur, octet pour octet", () => {
  for (const cas of VECTEURS.cas) {
    const liaison = {
      ...cas.liaison,
      empreinteRegion: hexEnOctets(cas.liaison.empreinteRegion),
      empreinteImage: hexEnOctets(cas.liaison.empreinteImage),
    };
    const octets = encoderEnTete({
      liaison,
      nonce: hexEnOctets(cas.nonce),
      etiquette: hexEnOctets(cas.etiquette),
    });
    assert.equal(octetsEnHex(octets), cas.enTete, `« ${cas.nom} » : l'en-tête a changé`);
  }
});

test("le scellement du chemin de production rend le chiffré et l'étiquette du vecteur", async () => {
  const cle = await importerCleDeVolume(CLE);
  for (const cas of VECTEURS.cas) {
    const liaison = {
      ...cas.liaison,
      empreinteRegion: hexEnOctets(cas.liaison.empreinteRegion),
      empreinteImage: hexEnOctets(cas.liaison.empreinteImage),
    };
    const scelle = await scellerInstantaneSousNonce({
      cle,
      liaison,
      etat: hexEnOctets(cas.etat),
      nonce: hexEnOctets(cas.nonce),
      attentes: { scellementsCumules: cas.scellementsCumules },
    });
    assert.equal(octetsEnHex(scelle.chiffre), cas.chiffre, `« ${cas.nom} » : chiffré`);
    assert.equal(octetsEnHex(scelle.etiquette), cas.etiquette, `« ${cas.nom} » : étiquette`);

    const rendu = await ouvrirInstantane({ cle, liaison, scelle });
    assert.equal(octetsEnHex(rendu), cas.etat, `« ${cas.nom} » : le clair relu`);
  }
});

test("les cas figés couvrent les axes que l'ADR 0024 nomme", () => {
  const couverts = new Set(VECTEURS.cas.flatMap((cas) => cas.couvre));
  for (const axe of ["volume", "sequence", "generation", "region", "image", "longueur"]) {
    assert.ok(couverts.has(axe), `aucun vecteur ne couvre l'axe « ${axe} »`);
  }
});
