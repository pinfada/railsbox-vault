import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { DOMAINES, encoderInfoDeDomaine } from "../../src/vm/derivation/cle-de-domaine.mjs";
import {
  encoderEnteteRacine,
  encoderIdentiteBloc,
  encoderIdentiteEnregistrement,
} from "../../src/vm/format-chiffre/identite-logique.mjs";
import { hexEnOctets, octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { GENERATION_FORMAT_DEUX_COMPTEURS } from "../../src/vm/generation-format.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import {
  FORMAT_VOLUME_V4,
  encoderEnTeteV4,
  encoderSceau,
} from "../../src/vm/volume-chiffre-format.mjs";

// Vecteurs FIGÉS du format de volume v4 et de sa hiérarchie de clés (#182, ADR 0033, 0035).
//
// Ce fichier confronte le CHEMIN DE PRODUCTION aux octets figés ; `tools/verifier-vecteurs.mjs`,
// lui, les redérive depuis la spécification écrite sans importer une ligne de `src/`. Les deux sont
// nécessaires et ne mesurent pas la même chose : le vérificateur dit que la SPÉCIFICATION suffit à
// reproduire les octets, celui-ci dit que le PRODUIT les reproduit encore.
//
// Régénérer n'est PAS une correction : c'est un changement de format persistant, qui exige une
// version et un ADR.

const VECTEURS = JSON.parse(
  readFileSync(new URL("../vectors/volume-v4.json", import.meta.url), "utf8"),
);

test("le document annonce ce que la v4 est : volume 4, journal 5, racine à 210 octets", () => {
  assert.equal(VECTEURS.formatVolume, FORMAT_VOLUME_V4);
  assert.equal(VECTEURS.formatJournal, GENERATION_FORMAT_DEUX_COMPTEURS);
  assert.equal(VECTEURS.cleMaitresse.hex, octetsEnHex(CLE_DE_TEST));
});

test("l'ANCRAGE du document est celui que la RFC 5869 publie, sel VIDE et info VIDE", () => {
  // Il vient avant tout le reste : sans lui, redériver les clés du format ne prouverait que
  // l'accord du fichier avec lui-même. C'est le cas 3, celui du sel vide — exactement le régime des
  // domaines à compteur.
  assert.equal(VECTEURS.ancrage.okm, VECTEURS.ancrage.attenduParLaRfc);
  assert.equal(VECTEURS.ancrage.sel, "");
  assert.equal(VECTEURS.ancrage.info, "");
});

test("l'INFO de chaque domaine est celle que le produit encode, octet pour octet", () => {
  for (const [nom, domaine] of Object.entries(VECTEURS.derivation.domaines)) {
    assert.equal(
      octetsEnHex(
        encoderInfoDeDomaine({
          domaine: nom,
          identifiantVolume: VECTEURS.derivation.identifiantVolume,
          versionDeFormat: domaine.versionDeFormatDuDomaine,
        }),
      ),
      domaine.info,
      `« ${nom} » : l'info a changé`,
    );
    assert.equal(domaine.sel, "", "un domaine à compteur a le sel VIDE");
  }
  assert.notEqual(
    VECTEURS.derivation.domaines[DOMAINES.volume].okm,
    VECTEURS.derivation.domaines[DOMAINES.journal].okm,
    "deux domaines d'un MÊME volume tirent des clés distinctes",
  );
});

test("l'EN-TÊTE v4 du chemin de production est celui du vecteur, octet pour octet", () => {
  assert.equal(
    octetsEnHex(
      encoderEnTeteV4({
        tailleLogique: VECTEURS.volume.tailleLogique,
        identifiantVolume: VECTEURS.volume.identifiant,
        scellementComplet: VECTEURS.enTete.scellementComplet,
      }),
    ),
    VECTEURS.enTete.hex,
  );
});

test("les DONNÉES ASSOCIÉES du vecteur sont celles que le produit encode", () => {
  assert.equal(
    octetsEnHex(encoderIdentiteBloc(VECTEURS.secteur.identite)),
    VECTEURS.secteur.donneesAssociees,
    "un secteur du volume",
  );
  assert.equal(
    octetsEnHex(encoderIdentiteEnregistrement(VECTEURS.enregistrement.identite)),
    VECTEURS.enregistrement.donneesAssociees,
    "un enregistrement du journal",
  );
  const associeesDeLaRacine = encoderEnteteRacine(VECTEURS.racine.entete);
  assert.equal(
    octetsEnHex(associeesDeLaRacine),
    VECTEURS.racine.donneesAssociees,
    "une racine à onze champs",
  );
  assert.equal(
    associeesDeLaRacine.byteLength,
    144,
    "144 octets pour un identifiant de trente-deux caractères : c'est un contrat",
  );
  assert.equal(VECTEURS.racine.donneesAssocieesOctets, associeesDeLaRacine.byteLength);
});

test("le SECTEUR figé s'ouvre sous la clé du domaine `volume`, et rend le clair publié", async () => {
  const scellement = await scellementDuVecteur();
  const clair = await scellement.ouvrirBloc(
    {
      generation: VECTEURS.secteur.identite.generation,
      rang: VECTEURS.secteur.identite.rang,
      adresse: VECTEURS.secteur.identite.adresse,
      longueur: VECTEURS.secteur.identite.longueur,
    },
    sceauDuVecteur(VECTEURS.secteur),
  );
  assert.equal(octetsEnHex(clair), VECTEURS.secteur.clair.hex);

  // Et il ne s'ouvre PAS comme un enregistrement : deux magasins, deux clés ET deux étiquettes.
  await assert.rejects(() =>
    scellement.ouvrirEnregistrement(
      {
        generation: VECTEURS.secteur.identite.generation,
        rang: VECTEURS.secteur.identite.rang,
        adresse: VECTEURS.secteur.identite.adresse,
        longueur: VECTEURS.secteur.identite.longueur,
      },
      sceauDuVecteur(VECTEURS.secteur),
    ),
  );
});

test("l'ENREGISTREMENT figé s'ouvre sous la clé du domaine `journal`, et sous elle seule", async () => {
  const scellement = await scellementDuVecteur();
  const identite = {
    generation: VECTEURS.enregistrement.identite.generation,
    rang: VECTEURS.enregistrement.identite.rang,
    adresse: VECTEURS.enregistrement.identite.adresse,
    longueur: VECTEURS.enregistrement.identite.longueur,
  };
  const clair = await scellement.ouvrirEnregistrement(
    identite,
    sceauDuVecteur(VECTEURS.enregistrement),
  );
  assert.equal(octetsEnHex(clair), VECTEURS.enregistrement.clair.hex);
  await assert.rejects(() =>
    scellement.ouvrirBloc(identite, sceauDuVecteur(VECTEURS.enregistrement)),
  );
});

test("la RACINE figée s'ouvre, et elle scelle l'empreinte de ses entrées", async () => {
  const scellement = await scellementDuVecteur();
  const entrees = VECTEURS.racine.entrees.map((entree) => ({
    ...entree,
    etiquette: hexEnOctets(entree.etiquette),
  }));
  const ouverte = await scellement.ouvrirRacine(
    {
      sequence: VECTEURS.racine.entete.sequence,
      generation: VECTEURS.racine.entete.generation,
      tailleVolume: VECTEURS.racine.entete.tailleVolume,
      nombreEntrees: VECTEURS.racine.entete.nombreEntrees,
      longueurCharge: VECTEURS.racine.entete.longueurCharge,
      scellementsCumulesVolume: VECTEURS.racine.entete.scellementsCumulesVolume,
      scellementsCumulesJournal: VECTEURS.racine.entete.scellementsCumulesJournal,
    },
    {
      nonce: hexEnOctets(VECTEURS.racine.nonce),
      chiffre: hexEnOctets(VECTEURS.racine.chiffre),
      etiquette: hexEnOctets(VECTEURS.racine.etiquette),
    },
    entrees,
    { tailleVolume: VECTEURS.racine.entete.tailleVolume, sequenceMinimale: null },
  );
  assert.equal(octetsEnHex(ouverte.empreinteEntrees), VECTEURS.racine.empreinteEntrees);
});

test("le SCEAU figé du secteur est celui que le produit encode", () => {
  assert.equal(
    octetsEnHex(
      encoderSceau({
        nonce: hexEnOctets(VECTEURS.secteur.nonce),
        etiquette: hexEnOctets(VECTEURS.secteur.etiquette),
        generation: VECTEURS.secteur.identite.generation,
      }),
    ),
    VECTEURS.secteur.sceauHex,
  );
});

/** Le scellement du volume que les vecteurs décrivent, sous la clé maîtresse PUBLIÉE. */
function scellementDuVecteur() {
  return Scellement.ouvrir({
    volume: VECTEURS.volume.identifiant,
    cleOctets: hexEnOctets(VECTEURS.cleMaitresse.hex),
    formatVersion: FORMAT_VOLUME_V4,
  });
}

function sceauDuVecteur(objet) {
  return {
    nonce: hexEnOctets(objet.nonce),
    etiquette: hexEnOctets(objet.etiquette),
    chiffre: hexEnOctets(objet.chiffre),
  };
}
