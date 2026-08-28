import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import {
  PAGE_OCTETS,
  TAILLE_FICHIER_ENVELOPPE,
  decoderPage,
  encoderPage,
  offsetDePage,
} from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import { encoderEmplacements } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  empreinteDesEmplacements,
  importerCleDeDeverrouillage,
  importerCleDeVolume,
  ouvrirRacine,
} from "../../src/vm/enveloppe/modele-reference.mjs";
import {
  HARNAIS_ALEAS_JETON,
  ajouterEmplacement,
  creerEnveloppe,
  ouvrirEnveloppe,
  remplacerEmplacement,
  revoquerEmplacement,
} from "../../src/vm/enveloppe-de-cle.mjs";
import { aleasScriptes, hex, supportDouble, suiteDOctets } from "./support-enveloppe-double.mjs";

// Vecteurs FIGÉS de l'ENVELOPPE DE CLÉ (#21, ADR 0020).
//
// Ce fichier a un rôle précis, et un seul : le CHEMIN DE PRODUCTION doit reproduire ces octets À
// L'IDENTIQUE. Un format qui changerait — un champ déplacé, un ordre d'octets inversé, un champ
// ajouté aux données associées — doit faire ROUGIR cette épreuve, parce qu'un tel changement casse
// la compatibilité d'un format persistant. C'est la règle que #17 applique déjà au format chiffré.
//
// Les vecteurs sont produits par `node tools/figer-vecteurs-enveloppe.mjs`, qui POSE LES OCTETS
// LUI-MÊME depuis la table de l'ADR 0020 plutôt que d'appeler `encoderPage`. C'est ce qui en fait un
// second avis sur la disposition : ici, le producteur et le vérificateur ne partagent pas leur
// encodeur de page. Ils partagent en revanche le modèle de référence pour le SCELLEMENT, et cette
// limite est écrite dans l'ADR plutôt que passée sous silence.
//
// Régénérer n'est PAS une correction : c'est un changement de format, qui exige une version et un ADR.

const VECTEURS = JSON.parse(
  readFileSync(new URL("../vectors/enveloppe-v1.json", import.meta.url), "utf8"),
);

const IDENTIFIANT_VOLUME = VECTEURS.volume.identifiantVolume;
const DEK = hex(VECTEURS.cles.dek.hex);
const KEK = Object.fromEntries(
  VECTEURS.cles.keks.map(({ nom, hex: valeur }) => [nom, hex(valeur)]),
);
const PARAMETRES_PHRASE = hex(VECTEURS.parametres.phrase);
const ETAPES = Object.fromEntries(VECTEURS.etapes.map((etape) => [etape.operation, etape]));

/** La page que le chemin de production vient d'écrire, extraite du support. */
function pageEcrite(support, index) {
  return support.contenu.slice(offsetDePage(index), offsetDePage(index) + PAGE_OCTETS);
}

/**
 * Rejoue les QUATRE opérations sous les aléas figés, et rend la page produite à chaque étape.
 *
 * Les aléas sont consommés dans l'ordre où le chemin de production les demande : un identifiant puis
 * un nonce par emplacement fabriqué, un nonce par racine scellée. Une liste épuisée est une erreur —
 * un vecteur qui reprendrait du vrai aléa ne serait plus un vecteur.
 */
async function rejouerLesQuatreOperations() {
  const support = supportDouble();
  const aleas = aleasScriptes({
    identifiants: VECTEURS.aleas.identifiants,
    nonces: VECTEURS.aleas.nonces.map(hex),
    jeton: HARNAIS_ALEAS_JETON,
  });
  const commun = { support, identifiantVolume: IDENTIFIANT_VOLUME, aleas };
  const pages = {};

  const creee = await creerEnveloppe({ ...commun, dek: DEK, kek: KEK.harnais });
  pages.creer = pageEcrite(support, 0);

  await ajouterEmplacement({
    ...commun,
    kek: KEK.harnais,
    kekNouvelle: KEK.phrase,
    typeKek: 1,
    parametres: PARAMETRES_PHRASE,
  });
  pages.ajouter = pageEcrite(support, 1);

  await remplacerEmplacement({
    ...commun,
    kek: KEK.harnais,
    identifiantEmplacement: creee.identifiantEmplacement,
    kekNouvelle: KEK["webauthn-prf"],
    typeKek: 2,
  });
  pages.remplacer = pageEcrite(support, 0);

  const inventaire = decoderPage(pages.remplacer).page;
  await revoquerEmplacement({
    ...commun,
    kek: KEK["webauthn-prf"],
    identifiantEmplacement: inventaire.emplacements[1].identifiantEmplacement,
  });
  pages.revoquer = pageEcrite(support, 1);

  return { pages, support, reste: aleas.reste() };
}

test("les vecteurs annoncent la disposition que le format implémente", () => {
  assert.equal(VECTEURS.specification.pageOctets, PAGE_OCTETS);
  assert.equal(VECTEURS.specification.pageOctets * 2, TAILLE_FICHIER_ENVELOPPE);
  assert.equal(VECTEURS.specification.marqueur, "VLTKEY01");
  assert.equal(VECTEURS.cles.usage, "TEST");
  assert.ok(
    VECTEURS.avertissement.includes("TEST"),
    "un lecteur qui tomberait sur ce fichier doit savoir en une ligne que les clés ne sont pas des secrets",
  );
});

test("les clés des vecteurs découlent de leur règle publiée, pas seulement de leurs octets", () => {
  assert.equal(octetsEnHex(suiteDOctets(0x20, 32)), VECTEURS.cles.dek.hex);
  for (const { base, hex: valeur } of VECTEURS.cles.keks) {
    assert.equal(octetsEnHex(suiteDOctets(Number(base), 32)), valeur);
  }
});

test("le chemin de PRODUCTION reproduit OCTET POUR OCTET les quatre pages figées", async () => {
  const { pages, reste } = await rejouerLesQuatreOperations();
  for (const [operation, attendu] of Object.entries(ETAPES)) {
    assert.equal(octetsEnHex(pages[operation]), attendu.page, `page de l'étape « ${operation} »`);
  }
  assert.deepEqual(reste, { identifiants: 0, nonces: 0 }, "tous les aléas figés ont été consommés");
});

test("l'encodeur de page reproduit lui aussi les octets posés à la main par l'outil", () => {
  // L'outil transcrit la table de l'ADR sans appeler `encoderPage` ; cette épreuve confronte les
  // deux transcriptions. Sans elle, un offset faux le serait des deux côtés à la fois.
  for (const etape of VECTEURS.etapes) {
    const octets = encoderPage({
      identifiantVolume: IDENTIFIANT_VOLUME,
      version: etape.version,
      racine: {
        nonce: hex(etape.racine.nonce),
        chiffre: hex(etape.racine.chiffre),
        etiquette: hex(etape.racine.etiquette),
      },
      emplacements: etape.emplacements.map((emplacement) => ({
        identifiantEmplacement: emplacement.identifiantEmplacement,
        typeKek: emplacement.typeKek,
        parametres: hex(emplacement.parametres),
        nonce: hex(emplacement.nonce),
        dekEnveloppee: hex(emplacement.dekEnveloppee),
        etiquette: hex(emplacement.etiquette),
      })),
    });
    assert.equal(octetsEnHex(octets), etape.page, `encodage de l'étape « ${etape.nom} »`);
  }
});

test("chaque page figée se relit et rend exactement ce que le vecteur déclare", () => {
  for (const etape of VECTEURS.etapes) {
    const lue = decoderPage(hex(etape.page));
    assert.equal(lue.valide, true, `page de « ${etape.nom} » : ${lue.raison}`);
    assert.equal(lue.page.version, etape.version);
    assert.equal(lue.page.identifiantVolume, IDENTIFIANT_VOLUME);
    assert.equal(lue.page.nombreEmplacements, etape.emplacements.length);
    assert.deepEqual(
      lue.page.emplacements.map((e) => e.identifiantEmplacement),
      etape.emplacements.map((e) => e.identifiantEmplacement),
      `ordre des emplacements de « ${etape.nom} »`,
    );
  }
});

test("l'encodage canonique et l'empreinte figés sont ceux que le modèle calcule", async () => {
  for (const etape of VECTEURS.etapes) {
    const emplacements = etape.emplacements.map((emplacement) => ({
      identifiantEmplacement: emplacement.identifiantEmplacement,
      typeKek: emplacement.typeKek,
      parametres: hex(emplacement.parametres),
      nonce: hex(emplacement.nonce),
      etiquette: hex(emplacement.etiquette),
    }));
    assert.equal(
      octetsEnHex(encoderEmplacements(emplacements)),
      etape.racine.encodageCanonique,
      `encodage canonique de « ${etape.nom} »`,
    );
    assert.equal(
      octetsEnHex(await empreinteDesEmplacements(emplacements)),
      etape.racine.empreinte,
      `empreinte de « ${etape.nom} »`,
    );
  }
});

test("le modèle rouvre chaque racine figée depuis ses seuls octets publiés", async () => {
  const dek = await importerCleDeVolume(DEK);
  for (const etape of VECTEURS.etapes) {
    const page = decoderPage(hex(etape.page)).page;
    const ouverte = await ouvrirRacine({
      dek,
      entete: {
        identifiantVolume: page.identifiantVolume,
        formatVersion: page.formatVersion,
        version: page.version,
        nombreEmplacements: page.nombreEmplacements,
      },
      scelle: page.racine,
      emplacements: page.emplacements,
      attentes: { identifiantVolume: IDENTIFIANT_VOLUME, versionMinimale: null },
    });
    assert.equal(
      octetsEnHex(ouverte.empreinte),
      etape.racine.empreinte,
      `racine de « ${etape.nom} »`,
    );
  }
});

test("chaque page figée rend la DEK figée sous la clé de déverrouillage figée", async () => {
  const attendus = {
    creer: "harnais",
    ajouter: "harnais",
    remplacer: "webauthn-prf",
    revoquer: "webauthn-prf",
  };
  for (const etape of VECTEURS.etapes) {
    const support = supportDouble({ octets: fichierAvecPage(hex(etape.page)) });
    const ouverte = await ouvrirEnveloppe({
      support,
      identifiantVolume: IDENTIFIANT_VOLUME,
      kek: KEK[attendus[etape.operation]],
    });
    assert.equal(octetsEnHex(ouverte.dek), VECTEURS.cles.dek.hex, `DEK de « ${etape.nom} »`);
    assert.equal(ouverte.version, etape.version);
  }
});

test("aucun nonce ne sert DEUX SCELLEMENTS distincts dans les vecteurs", () => {
  // Un emplacement TRAVERSE les étapes sans être rescellé — c'est tout l'objet de #21 : ajouter une
  // clé ne rechiffre rien. Ses octets, nonce compris, reparaissent donc à l'identique d'une page à
  // l'autre, et c'est correct. Ce qui ne le serait pas, c'est qu'un même nonce serve DEUX
  // scellements différents : une racine et un emplacement, ou deux emplacements distincts. C'est ce
  // que cette épreuve mesure, en identifiant chaque scellement par ce qu'il scelle.
  const proprietaires = new Map();
  const relever = (nonce, proprietaire) => {
    const connu = proprietaires.get(nonce);
    assert.ok(
      connu === undefined || connu === proprietaire,
      `nonce ${nonce} partagé par « ${connu} » et « ${proprietaire} »`,
    );
    proprietaires.set(nonce, proprietaire);
  };

  for (const etape of VECTEURS.etapes) {
    relever(etape.racine.nonce, `racine v${etape.version}`);
    for (const emplacement of etape.emplacements) {
      relever(emplacement.nonce, `emplacement ${emplacement.identifiantEmplacement}`);
    }
  }
  assert.equal(
    proprietaires.size,
    VECTEURS.aleas.nonces.length,
    "tous les nonces figés sont employés",
  );
});

test("un emplacement TRAVERSE les étapes sans un octet de changement", () => {
  // L'invariant central de #21, mesuré sur les vecteurs eux-mêmes : la DEK enveloppée d'une clé qui
  // n'est pas touchée est la MÊME avant et après un ajout, un remplacement et une révocation.
  const survivant = ETAPES.ajouter.emplacements[1];
  const apresRemplacement = ETAPES.remplacer.emplacements[1];
  assert.deepEqual(apresRemplacement, survivant, "l'ajout d'une clé a rescellé une autre");

  const intact = ETAPES.remplacer.emplacements[0];
  assert.deepEqual(ETAPES.revoquer.emplacements[0], intact, "une révocation a rescellé un voisin");
});

test("les clés de déverrouillage figées n'ouvrent PAS l'emplacement d'une autre", async () => {
  // Témoin négatif du vecteur lui-même : sans lui, « la DEK sort » ne dirait pas que c'est la bonne
  // clé qui la fait sortir.
  const page = hex(ETAPES.revoquer.page);
  const support = supportDouble({ octets: fichierAvecPage(page) });
  await assert.rejects(
    ouvrirEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME, kek: KEK.phrase }),
    (erreur) => erreur.code === "VAULT_ENVELOPPE_CLE_REFUSEE",
  );
  await importerCleDeDeverrouillage(KEK.phrase);
});

/** Un fichier complet : la page donnée en page 0, la page 1 à zéro — l'état d'une création. */
function fichierAvecPage(page) {
  const octets = new Uint8Array(TAILLE_FICHIER_ENVELOPPE);
  octets.set(page, 0);
  return octets;
}
