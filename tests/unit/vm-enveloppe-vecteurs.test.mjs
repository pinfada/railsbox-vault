import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import {
  PAGE_OCTETS,
  TAILLE_FICHIER_ENVELOPPE,
  decoderPage,
  encoderPage,
} from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import {
  EMPLACEMENT_FORMAT_V1,
  ENVELOPPE_FORMAT_V1,
  ENVELOPPE_FORMAT_V2,
  encoderEmplacements,
  nomDuTypeKek,
} from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  empreinteDesEmplacements,
  envelopperSousNonce,
  importerCleDeDeverrouillage,
  importerCleDeVolume,
  ouvrirRacine,
} from "../../src/vm/enveloppe/modele-reference.mjs";
import { ouvrirEnveloppe } from "../../src/vm/enveloppe-de-cle.mjs";
import {
  composerPageAlaMain,
  hex,
  supportDouble,
  suiteDOctets,
} from "./support-enveloppe-double.mjs";

// Vecteurs FIGÉS de l'ENVELOPPE DE CLÉ, page **v1** (#21, ADR 0020 ; #182, T2b).
//
// ## Ces vecteurs n'ont PAS bougé d'un octet, et ils ont changé de RÔLE
//
// Jusqu'à T2b, ils disaient ce que le chemin de PRODUCTION devait écrire. Depuis T2b, le produit
// n'écrit plus de page v1 : la racine d'une page est scellée sous une clé à usage unique dérivée par
// domaine, et la page passe en v2 (ADR 0033, décisions 2 et 3). Ces quatre pages deviennent donc des
// **vecteurs de MIGRATION**, exactement comme les vecteurs de volume v3 le sont devenus en T2a :
//
//  1. le MODÈLE de référence les reproduit toujours octet pour octet, à partir des CLÉS et des
//     aléas figés — pas seulement à partir des chiffrés publiés. C'est le contrat de format, et il
//     est plus exigeant qu'avant : chaque emplacement est ré-enveloppé sous sa KEK, chaque racine
//     rescellée sous la DEK ;
//  2. le chemin de PRODUCTION doit encore les OUVRIR, et les MIGRER en v2 à la première ouverture
//     réussie. C'est le seul geste que le produit fait encore d'une page v1, et c'est celui dont
//     dépend le volume de quiconque ouvrira un coffre écrit avant T2b.
//
// Un format qui changerait — un champ déplacé, un ordre d'octets inversé, un champ ajouté aux
// données associées — doit faire ROUGIR cette épreuve, parce qu'un tel changement casse la
// compatibilité d'un format persistant. C'est la règle que #17 applique déjà au format chiffré.
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
const ETAPES = Object.fromEntries(VECTEURS.etapes.map((etape) => [etape.operation, etape]));

/**
 * RECONSTRUIT une page figée à partir des CLÉS, pas de ses chiffrés publiés.
 *
 * Chaque emplacement est ré-enveloppé sous la KEK que son type désigne, avec le nonce figé et les
 * données associées du format ; la racine est rescellée sous la DEK, avec le nonce figé. Si l'un des
 * deux encodages bouge d'un octet — une donnée associée, un champ de longueur, un ordre —, la page
 * produite cesse d'être celle qui est publiée.
 *
 * C'est plus exigeant que ce que la version antérieure de cette épreuve mesurait : elle rejouait les
 * quatre opérations du produit, qui n'écrit plus de page v1.
 */
async function reconstruireLaPageFigee(etape) {
  const emplacements = [];
  for (const emplacement of etape.emplacements) {
    const parametres = hex(emplacement.parametres);
    const scelle = await envelopperSousNonce({
      kek: await importerCleDeDeverrouillage(KEK[nomDuTypeKek(emplacement.typeKek)]),
      emplacement: {
        identifiantVolume: IDENTIFIANT_VOLUME,
        identifiantEmplacement: emplacement.identifiantEmplacement,
        formatVersion: EMPLACEMENT_FORMAT_V1,
        typeKek: emplacement.typeKek,
        parametres,
      },
      dek: DEK,
      nonce: hex(emplacement.nonce),
    });
    emplacements.push({
      identifiantEmplacement: emplacement.identifiantEmplacement,
      typeKek: emplacement.typeKek,
      parametres,
      nonce: scelle.nonce,
      dekEnveloppee: scelle.chiffre,
      etiquette: scelle.etiquette,
    });
  }
  return composerPageAlaMain({
    identifiantVolume: IDENTIFIANT_VOLUME,
    version: etape.version,
    dek: DEK,
    emplacements,
    nonce: hex(etape.racine.nonce),
    formatVersion: ENVELOPPE_FORMAT_V1,
  });
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

test("les CLÉS figées reproduisent OCTET POUR OCTET les quatre pages figées", async () => {
  // Le scellement est refait depuis les clés : les chiffrés publiés ne servent qu'à comparer.
  for (const etape of VECTEURS.etapes) {
    assert.equal(
      octetsEnHex(await reconstruireLaPageFigee(etape)),
      etape.page,
      `page de l'étape « ${etape.operation} »`,
    );
  }
});

test("ces pages sont des pages v1, et le produit n'en écrit PLUS aucune", () => {
  // L'assertion qui donne son sens au changement de rôle. Si le produit se remettait à écrire des
  // pages v1, la moitié « migration » de ce fichier deviendrait muette sans que rien ne le dise.
  for (const etape of VECTEURS.etapes) {
    assert.equal(decoderPage(hex(etape.page)).page.formatVersion, ENVELOPPE_FORMAT_V1);
  }
  assert.equal(VECTEURS.specification.enTetePageOctets, 108, "l'en-tête v1 fait 108 octets");
});

test("l'encodeur de page reproduit lui aussi les octets posés à la main par l'outil", () => {
  // L'outil transcrit la table de l'ADR sans appeler `encoderPage` ; cette épreuve confronte les
  // deux transcriptions. Sans elle, un offset faux le serait des deux côtés à la fois.
  for (const etape of VECTEURS.etapes) {
    const octets = encoderPage({
      identifiantVolume: IDENTIFIANT_VOLUME,
      version: etape.version,
      formatVersion: ENVELOPPE_FORMAT_V1,
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
      cleDeRacine: dek,
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

test("chaque page figée rend la DEK figée, et le produit la MIGRE en v2 au passage", async () => {
  // Les deux moitiés du geste que T2b demande d'une page v1, sur les quatre pages du contrat : la
  // DEK sort, et la page est rescellée en v2 sans qu'aucune clé de déverrouillage soit demandée.
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
    assert.deepEqual(
      { ...ouverte.migration },
      {
        de: ENVELOPPE_FORMAT_V1,
        vers: ENVELOPPE_FORMAT_V2,
        faite: true,
        version: etape.version + 1,
        refus: null,
      },
      `migration de « ${etape.nom} »`,
    );
    assert.equal(ouverte.version, etape.version + 1, "la version avance d'un cran, et d'un seul");

    // La page v1 est TOUJOURS là, plus ancienne : c'est le repli qui rend la migration sûre sous
    // coupure, et il disparaîtra de lui-même à la mutation suivante.
    const relue = decoderPage(support.contenu.subarray(0, support.contenu.byteLength / 2));
    const autre = decoderPage(support.contenu.subarray(support.contenu.byteLength / 2));
    const versions = [relue, autre].map((lue) => (lue.valide ? lue.page.formatVersion : null));
    assert.deepEqual(
      versions.slice().sort(),
      [ENVELOPPE_FORMAT_V1, ENVELOPPE_FORMAT_V2],
      `les deux pages de « ${etape.nom} » : la v1 conservée, la v2 publiée`,
    );

    // Et une SECONDE ouverture ne remigre rien : la page qui fait autorité est déjà en v2.
    const encore = await ouvrirEnveloppe({
      support,
      identifiantVolume: IDENTIFIANT_VOLUME,
      kek: KEK[attendus[etape.operation]],
    });
    assert.equal(encore.migration, null, "une page déjà migrée ne se remigre pas");
    assert.equal(encore.version, etape.version + 1);
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
