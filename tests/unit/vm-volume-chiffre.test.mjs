// Le CHEMIN DE PRODUCTION reproduit les vecteurs de l'ADR 0015, et refuse les cinq altérations
// (#18, ADR 0016).
//
// Deux moitiés, et la première est la plus importante.
//
//  1. **Les vecteurs figés sont reproduits OCTET POUR OCTET par le scellement du produit** —
//     `src/vm/scellement.mjs`, celui qu'emploient le backend, le journal et le point de contrôle.
//     Ce n'est pas le modèle de référence qui est éprouvé ici : c'est le fait que la couche de
//     production n'ajoute, ne retire et ne réordonne rien. Le nonce lui est fourni par la source
//     injectable dont l'ADR 0015 prévoit l'usage (« permettre à une implémentation (#18) de
//     REPRODUIRE ces vecteurs ») ; aucun chemin du produit ne l'injecte.
//  2. **Cinq refus sur le chemin de production**, et un témoin positif avant eux : sans lui, une
//     couche qui refuserait TOUT passerait pour sûre.
//
// S'y ajoutent les pannes injectées à chaque geste du scellement — écrire la charge, écrire le
// sceau, relire l'un, relire l'autre — parce qu'un chiffrement qui rendrait des zéros sur une
// lecture courte serait pire que pas de chiffrement du tout.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { hexEnOctets, octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { CRYPTO_ERROR_CODES } from "../../src/vm/format-chiffre/crypto-errors.mjs";
import { BUDGET_SCELLEMENTS_PAR_CLE } from "../../src/vm/format-chiffre/identite-logique.mjs";
import { exigerCleDeVolume } from "../../src/vm/cle-de-volume.mjs";
import { HARNAIS_NONCE_JETON, Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { VolumeChiffre } from "../../src/vm/volume-chiffre.mjs";
import {
  SCEAU_OCTETS,
  dispositionV3,
  offsetDeCharge,
  offsetDeSceau,
} from "../../src/vm/volume-chiffre-format.mjs";

const VECTEURS = JSON.parse(
  readFileSync(new URL("../vectors/format-chiffre-v1.json", import.meta.url), "utf8"),
);

const CLE = hexEnOctets(VECTEURS.cle.hex);

/** Reconstruit le contenu d'un vecteur depuis sa RÈGLE, comme le fait l'épreuve du modèle. */
function contenuDepuisRegle({ longueur, graine }) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 7 + 13 + graine) % 256);
}

/** Source de nonces qui rend une suite FIGÉE, puis refuse. L'épuisement est une erreur, pas un zéro. */
function noncesFiges(hex) {
  const suite = [...hex];
  return () => {
    const prochain = suite.shift();
    if (prochain === undefined)
      throw new Error("Aucun nonce figé ne reste : l'épreuve en attendait moins.");
    return hexEnOctets(prochain);
  };
}

/** Support en mémoire, avec une panne programmable par geste. Aucune faute n'est simulée après coup. */
function supportDouble(taille) {
  const octets = new Uint8Array(taille);
  let panne = null;
  const declencher = (geste, offset, longueur) => {
    if (panne === null || panne.geste !== geste) return;
    if (panne.dans !== undefined && (offset + longueur <= panne.dans || offset > panne.dans))
      return;
    panne = null;
    throw new Error(`panne programmée sur « ${geste} »`);
  };
  return {
    octets,
    programmer(nouvelle) {
      panne = nouvelle;
    },
    lireSupport(offset, longueur) {
      declencher("lire", offset, longueur);
      return octets.slice(offset, offset + longueur);
    },
    ecrireSupport(offset, source) {
      declencher("ecrire", offset, source.byteLength);
      octets.set(source, offset);
    },
  };
}

async function scellementDeVecteurs(nonces) {
  return Scellement.ouvrir({
    volume: "volume-de-vecteur",
    cleOctets: CLE,
    formatVersion: 3,
    scellementsCumules: 0,
    // La source de nonces ne s'installe que sous jeton (revue de #102). Ce fichier est l'usage
    // pour lequel la porte existe : reproduire les nonces que les vecteurs de l'ADR 0015 figent.
    tirerNonce: nonces,
    jetonNonce: HARNAIS_NONCE_JETON,
  });
}

test("le scellement du produit reproduit OCTET POUR OCTET les cinq blocs figés", async () => {
  const scellement = await scellementDeVecteurs(
    noncesFiges(VECTEURS.blocs.map((bloc) => bloc.attendu.nonce)),
  );

  for (const vecteur of VECTEURS.blocs) {
    const scelle = await scellement.scellerBloc(
      vecteur.identite,
      contenuDepuisRegle(vecteur.contenu),
    );
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
  assert.equal(
    scellement.scellementsCumules,
    VECTEURS.blocs.length,
    "le budget compte chaque bloc",
  );
});

test("le RESCELLEMENT du point de contrôle reproduit le vecteur d'un secteur de volume", async () => {
  // Le premier vecteur EST un secteur de volume : rang 0, adresse 0, 512 octets, génération 1. Le
  // geste du point de contrôle doit donc rendre exactement ses octets — sans quoi un volume rangé
  // ne serait pas relisible par le format que les vecteurs figent.
  const vecteur = VECTEURS.blocs[0];
  const scellement = await scellementDeVecteurs(noncesFiges([vecteur.attendu.nonce]));

  const rescelle = await scellement.rescellerEnSecteurs({
    adresse: 0,
    contenu: contenuDepuisRegle(vecteur.contenu),
    generation: vecteur.identite.generation,
  });

  assert.equal(rescelle.secteurs.length, 1);
  assert.equal(rescelle.secteurs[0].identite.rang, 0, "un secteur de volume a le rang épinglé");
  assert.equal(octetsEnHex(rescelle.secteurs[0].scelle.etiquette), vecteur.attendu.etiquette);
  assert.equal(octetsEnHex(rescelle.secteurs[0].scelle.chiffre), vecteur.attendu.chiffre);
});

test("le scellement du produit reproduit OCTET POUR OCTET les deux racines figées", async () => {
  const scellement = await scellementDeVecteurs(
    noncesFiges(VECTEURS.racines.map((racine) => racine.attendu.nonce)),
  );
  scellement.reprendreDepuis(VECTEURS.racines[0].racine.scellementsCumules);

  let sequencePrecedente = null;
  for (const vecteur of VECTEURS.racines) {
    const entrees = vecteur.entrees.map((entree) => ({
      ...entree,
      etiquette: hexEnOctets(entree.etiquette),
    }));
    const scelle = await scellement.scellerRacine(
      {
        sequence: vecteur.racine.sequence,
        generation: vecteur.racine.generation,
        tailleVolume: vecteur.racine.tailleVolume,
      },
      entrees,
      { sequencePrecedente },
    );
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
    assert.equal(scelle.entete.nombreEntrees, vecteur.attendu.nombreEntrees);
    assert.equal(scelle.entete.longueurCharge, vecteur.attendu.longueurCharge);
    sequencePrecedente = vecteur.racine.sequence;
  }
});

// --------------------------------------------------------------------- le volume, bout en bout

const TAILLE = 16 * SECTOR_SIZE;

async function volumeDouble({ identifiant = "0".repeat(32), cleOctets = CLE } = {}) {
  const disposition = dispositionV3(TAILLE);
  const support = supportDouble(disposition.tailleSupport);
  const scellement = await Scellement.ouvrir({
    volume: identifiant,
    cleOctets,
    formatVersion: 3,
  });
  const volume = new VolumeChiffre({
    volume: "eprouve",
    scellement,
    disposition,
    lireSupport: support.lireSupport,
    ecrireSupport: support.ecrireSupport,
  });
  return { disposition, support, scellement, volume };
}

/** Motif reconnaissable : un secteur de zéros ne prouverait pas qu'on a lu le bon. */
function motif(graine) {
  return Uint8Array.from({ length: SECTOR_SIZE }, (_, index) => (index * 31 + graine) % 256);
}

test("TÉMOIN POSITIF : ce qui a été scellé se relit à l'identique", async () => {
  const { volume } = await volumeDouble();
  const attendu = motif(7);
  await volume.ecrireSecteurs(2 * SECTOR_SIZE, attendu, 4);
  assert.deepEqual(await volume.lireSecteurs(2 * SECTOR_SIZE, SECTOR_SIZE), attendu);
});

test("REFUS 1 — un octet du chiffré modifié : aucun clair, aucun zéro, une erreur typée", async () => {
  const { volume, support, disposition } = await volumeDouble();
  await volume.ecrireSecteurs(SECTOR_SIZE, motif(1), 4);
  support.octets[offsetDeCharge(disposition, SECTOR_SIZE) + 100] ^= 0x01;

  await assert.rejects(
    () => volume.lireSecteurs(SECTOR_SIZE, SECTOR_SIZE),
    (erreur) => {
      assert.ok(isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse), erreur.message);
      assert.equal(erreur.context.cause, CRYPTO_ERROR_CODES.sealRejected);
      return true;
    },
  );
});

test("REFUS 2 — un secteur valide DÉPLACÉ à une autre adresse est refusé", async () => {
  const { volume, support, disposition } = await volumeDouble();
  await volume.ecrireSecteurs(0, motif(2), 4);

  // Le quadruplet complet — charge et sceau — est recopié à l'adresse voisine. Rien n'est abîmé :
  // c'est un secteur authentique, présenté ailleurs.
  const charge = support.octets.slice(
    offsetDeCharge(disposition, 0),
    offsetDeCharge(disposition, 0) + SECTOR_SIZE,
  );
  const sceau = support.octets.slice(
    offsetDeSceau(disposition, 0),
    offsetDeSceau(disposition, 0) + SCEAU_OCTETS,
  );
  support.octets.set(charge, offsetDeCharge(disposition, SECTOR_SIZE));
  support.octets.set(sceau, offsetDeSceau(disposition, SECTOR_SIZE));

  await assert.rejects(
    () => volume.lireSecteurs(SECTOR_SIZE, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
  );
});

test("REFUS 3 — un secteur valide relu sous un AUTRE VOLUME ou un AUTRE FORMAT est refusé", async () => {
  const { support, disposition } = await volumeDouble({ identifiant: "a".repeat(32) });
  const premier = new VolumeChiffre({
    volume: "eprouve",
    scellement: await Scellement.ouvrir({
      volume: "a".repeat(32),
      cleOctets: CLE,
      formatVersion: 3,
    }),
    disposition,
    lireSupport: support.lireSupport,
    ecrireSupport: support.ecrireSupport,
  });
  await premier.ecrireSecteurs(0, motif(3), 4);

  for (const [nom, autre] of [
    ["autre volume", { volume: "b".repeat(32), formatVersion: 3 }],
    ["autre format", { volume: "a".repeat(32), formatVersion: 4 }],
  ]) {
    const second = new VolumeChiffre({
      volume: "eprouve",
      scellement: await Scellement.ouvrir({ ...autre, cleOctets: CLE }),
      disposition,
      lireSupport: support.lireSupport,
      ecrireSupport: support.ecrireSupport,
    });
    await assert.rejects(
      () => second.lireSecteurs(0, SECTOR_SIZE),
      (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
      `« ${nom} » aurait dû être refusé`,
    );
  }
});

test("REFUS 4 — un secteur relu sous une AUTRE GÉNÉRATION que celle de son sceau est refusé", async () => {
  const { volume, support, disposition } = await volumeDouble();
  await volume.ecrireSecteurs(0, motif(4), 4);

  // La génération vit dans le sceau, à côté du nonce : la changer là est exactement ce qu'un
  // attaquant ferait pour faire relire un secteur sous une autre identité.
  const position = offsetDeSceau(disposition, 0) + 12 + 16;
  support.octets[position] = 9;

  await assert.rejects(
    () => volume.lireSecteurs(0, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
  );
});

test("REFUS 5 — un secteur EN CLAIR, jamais scellé, est refusé : pas de secteur vierge en v3", async () => {
  const { volume, support, disposition } = await volumeDouble();
  const enClair = motif(5);
  support.octets.set(enClair, offsetDeCharge(disposition, 3 * SECTOR_SIZE));
  // Le sceau reste à ZÉRO, comme le laisserait un attaquant qui zérote la région.

  await assert.rejects(
    () => volume.lireSecteurs(3 * SECTOR_SIZE, SECTOR_SIZE),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
  );
});

test("REFUS 6 — une RACINE altérée refuse la génération, et le refus est établi", async () => {
  const scellement = await Scellement.ouvrir({
    volume: "c".repeat(32),
    cleOctets: CLE,
    formatVersion: 3,
  });
  const entrees = [{ adresse: 0, longueur: 512, rang: 0, etiquette: new Uint8Array(16) }];
  const scelle = await scellement.scellerRacine(
    { sequence: 1, generation: 1, tailleVolume: TAILLE },
    entrees,
    { sequencePrecedente: null },
  );

  const abimee = { ...scelle, etiquette: Uint8Array.from(scelle.etiquette) };
  abimee.etiquette[0] ^= 0x01;

  await assert.rejects(
    () =>
      scellement.ouvrirRacine(scelle.entete, abimee, entrees, {
        volume: "c".repeat(32),
        formatVersion: 3,
        tailleVolume: TAILLE,
        sequenceMinimale: null,
      }),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
  );
});

test("REFUS 7 — un volume v3 SANS CLÉ est refusé par un code typé, jamais lu en clair", () => {
  // Le produit ne fabrique aucune clé de volume avant #21 (ADR 0016, décision 6). Le refus est
  // explicite, il nomme l'issue, et il tombe AVANT toute lecture.
  assert.throws(
    () => exigerCleDeVolume("donnees", null),
    (erreur) => {
      assert.ok(isStorageError(erreur, STORAGE_ERROR_CODES.cleRequise), erreur.message);
      assert.match(erreur.message, /#21/);
      return true;
    },
  );
  assert.throws(
    () => exigerCleDeVolume("donnees", undefined),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.cleRequise),
  );
  assert.doesNotThrow(() => exigerCleDeVolume("donnees", CLE));
});

// ------------------------------------------------------------------ pannes à chaque geste

const GESTES = [
  { nom: "écriture de la CHARGE chiffrée", geste: "ecrire", zone: "charge" },
  { nom: "écriture du SCEAU", geste: "ecrire", zone: "sceau" },
];

for (const cas of GESTES) {
  test(`une panne pendant l'${cas.nom} est une erreur typée, et rien n'est relisible`, async () => {
    const { volume, support, disposition } = await volumeDouble();
    const adresse = 5 * SECTOR_SIZE;
    const dans =
      cas.zone === "charge"
        ? offsetDeCharge(disposition, adresse)
        : offsetDeSceau(disposition, adresse);
    support.programmer({ geste: cas.geste, dans });

    await assert.rejects(() => volume.ecrireSecteurs(adresse, motif(8), 4));
    await assert.rejects(
      () => volume.lireSecteurs(adresse, SECTOR_SIZE),
      (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse),
      "un secteur à moitié écrit doit être REFUSÉ, jamais rendu",
    );
  });
}

for (const zone of ["charge", "sceau"]) {
  test(`une panne pendant la lecture de la ${zone} remonte, sans rendre d'octets`, async () => {
    const { volume, support, disposition } = await volumeDouble();
    const adresse = 6 * SECTOR_SIZE;
    await volume.ecrireSecteurs(adresse, motif(9), 4);
    support.programmer({
      geste: "lire",
      dans:
        zone === "charge"
          ? offsetDeCharge(disposition, adresse)
          : offsetDeSceau(disposition, adresse),
    });
    await assert.rejects(() => volume.lireSecteurs(adresse, SECTOR_SIZE));
  });
}

test("le budget de clé refuse le scellement AVANT de produire le moindre octet", async () => {
  const scellement = await Scellement.ouvrir({
    volume: "d".repeat(32),
    cleOctets: CLE,
    formatVersion: 3,
    scellementsCumules: BUDGET_SCELLEMENTS_PAR_CLE,
  });
  await assert.rejects(
    () => scellement.scellerBloc({ generation: 1, rang: 0, adresse: 0, longueur: 512 }, motif(1)),
    (erreur) => {
      assert.ok(isStorageError(erreur, STORAGE_ERROR_CODES.budgetDeCle), erreur.message);
      assert.equal(erreur.context.cause, CRYPTO_ERROR_CODES.keyBudget);
      return true;
    },
  );
});

test("sceller un volume ENTIER ne laisse aucun secteur sans sceau", async () => {
  const { volume, disposition } = await volumeDouble();
  const scelles = await volume.scellerTout(1);
  assert.equal(scelles, disposition.secteurs);

  // Chaque secteur se relit, et rend des zéros — parce qu'un volume neuf EST à zéro, pas parce que
  // la lecture aurait échoué en silence.
  for (let adresse = 0; adresse < disposition.tailleLogique; adresse += SECTOR_SIZE) {
    assert.deepEqual(await volume.lireSecteurs(adresse, SECTOR_SIZE), new Uint8Array(SECTOR_SIZE));
  }
});
