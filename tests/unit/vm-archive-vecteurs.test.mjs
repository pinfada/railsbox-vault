/**
 * LE CHEMIN DE PRODUCTION REPRODUIT LES VECTEURS D'ARCHIVE V3 (#181, ADR 0033 ; #149, ADR 0027).
 *
 * `tests/vectors/archive-v3.json` est un CONTRAT : la disposition d'une archive v3, l'ENGAGEMENT
 * qu'elle porte et la page d'enveloppe qu'elle emporte y sont figés, octet pour octet, par un outil
 * qui pose ces octets lui-même (`tools/figer-vecteurs-archive.mjs`). Cette suite confronte le
 * produit à ce contrat.
 *
 * Elle mesure quatre choses, de la plus petite à la plus grande :
 *
 *  1. **la page complète** que le volume porte, et la page EMBARQUÉE qu'il en tire — toutes deux
 *     en **version 1**, celle qu'une archive écrite AVANT T2b emporte. Depuis #182 le produit écrit
 *     des pages v2 : ces trois pages-ci changent donc de rôle et deviennent des vecteurs de
 *     COMPATIBILITÉ, exactement comme `enveloppe-v1.json`. Ce que cette suite en exige est double —
 *     le modèle les reproduit toujours depuis les CLÉS, et une archive qui les porte se RESTAURE et
 *     s'OUVRE encore. Les pages v2 que le produit écrit aujourd'hui sont figées dans
 *     `tests/vectors/enveloppe-v2.json` ;
 *  3. **l'ENGAGEMENT et son voisin** — l'empreinte du fichier chiffré entier, scellée sous la clé
 *     du domaine `archive` dérivée par HKDF-SHA-256, et les cent quatre-vingts octets que la
 *     restauration dépose à côté du volume ;
 *  4. **l'archive entière** — `writeArchive` doit rendre exactement les octets du vecteur,
 *     en-tête JSON compris, ordre des champs compris.
 *
 * Un ROUGE ici ne se corrige pas en régénérant les vecteurs : soit le format persistant a changé
 * sans version ni ADR, soit le produit et la spécification ont divergé.
 *
 * **`archive-v3.json` n'a pas bougé d'un octet en T2b**, et c'est une propriété, pas une chance :
 * la version d'ARCHIVE reste 3 parce que rien de la disposition d'archive ne change. Seule la page
 * d'enveloppe qu'elle transporte a une version à elle, et le lecteur de section les accepte toutes
 * les deux — c'est ce qui fait qu'une archive d'avant T2b se restaure encore.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { exportVolumeToBytes } from "../../src/vm/archive-en-memoire.mjs";
import {
  HARNAIS_ENGAGEMENT_JETON,
  decoderFichierDEngagement,
  donneesAssocieesDeLEngagement,
  encoderFichierDEngagement,
  ouvrirEngagement,
  scellerEngagement,
} from "../../src/vm/archive-engagement.mjs";
import { DOMAINES, encoderInfoDeDomaine } from "../../src/vm/derivation/cle-de-domaine.mjs";
import {
  HARNAIS_ALEAS_JETON,
  ajouterEmplacement,
  creerEnveloppe,
  ouvrirEnveloppe,
} from "../../src/vm/enveloppe-de-cle.mjs";
import {
  construireEnveloppeDeRecuperation,
  exigerEnveloppeDeRecuperationSeule,
  fichierDEnveloppeDepuisLaPage,
} from "../../src/vm/enveloppe-de-recuperation.mjs";
import { decoderPage } from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import {
  DOMAINES_DE_RACINE,
  EMPLACEMENT_FORMAT_V1,
  ENVELOPPE_FORMAT_V1,
  ENVELOPPE_FORMAT_V2,
  TYPES_KEK,
} from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  envelopperSousNonce,
  importerCleDeDeverrouillage,
} from "../../src/vm/enveloppe/modele-reference.mjs";
import { hexEnOctets, octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { aleasScriptes, composerPageAlaMain, supportDouble } from "./support-enveloppe-double.mjs";

const vecteurs = JSON.parse(
  await readFile(new URL("../vectors/archive-v3.json", import.meta.url), "utf8"),
);

const IDENTIFIANT_VOLUME = vecteurs.volume.identifiantVolume;
const DEK = hexEnOctets(vecteurs.cles.dek.hex);
const KEK = Object.fromEntries(
  vecteurs.cles.keks.map((entree) => [entree.nom, hexEnOctets(entree.hex)]),
);
const NONCES = vecteurs.aleas.nonces;
const IDENTIFIANTS = vecteurs.aleas.identifiants;

/** Les aléas du vecteur, dans leur ordre de consommation. Le jeton du harnais est exigé. */
const aleas = (identifiants, nonces, sels = []) =>
  aleasScriptes({
    identifiants,
    nonces: nonces.map(hexEnOctets),
    sels,
    jeton: HARNAIS_ALEAS_JETON,
  });

/**
 * Rejoue le chemin de production jusqu'à l'enveloppe COMPLÈTE du vecteur : création sous le harnais,
 * puis ajout d'un emplacement de type 4 dont l'identifiant est FOURNI — c'est ce que fait un moyen
 * de récupération (ADR 0021 : l'info HKDF lie l'identifiant, qui doit exister avant la clé).
 */
async function enveloppeComplete() {
  const support = supportDouble();
  await creerEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    dek: DEK,
    kek: KEK.harnais,
    typeKek: TYPES_KEK.harnais,
    identifiantEmplacement: IDENTIFIANTS.harnais,
    aleas: aleas([], [NONCES.harnais, NONCES.racineV1], [SEL_CREATION]),
  });
  const creation = support.contenu.slice(0, 8192);

  await ajouterEmplacement({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: KEK.harnais,
    kekNouvelle: KEK.recuperation,
    typeKek: TYPES_KEK.recuperation,
    parametres: hexEnOctets(vecteurs.aleas.parametresRecuperation),
    identifiantEmplacement: IDENTIFIANTS.recuperation,
    aleas: aleas([], [NONCES.recuperation, NONCES.racineV2], [SEL_COMPLETE]),
  });
  // La page NEUVE occupe la page libre, c'est-à-dire la seconde : l'alternance de l'ADR 0020.
  const complete = support.contenu.slice(8192, 16384);
  return { support, creation, complete };
}

/** Les sels FIGÉS des deux pages que le chemin de production écrit ici, en v2. */
const SEL_CREATION = hexEnOctets("aa".repeat(32));
const SEL_COMPLETE = hexEnOctets("bb".repeat(32));

test("les trois pages du vecteur sont des pages v1, et elles se relisent", () => {
  // Le fait qui donne son rôle à ces octets : ils décrivent une archive écrite AVANT T2b. Si le
  // produit se remettait à écrire des pages v1, cette suite cesserait de mesurer une compatibilité
  // et se remettrait à mesurer le présent, sans que rien ne le dise.
  for (const [nom, figee] of Object.entries(vecteurs.enveloppe)) {
    const lue = decoderPage(hexEnOctets(figee.page));
    assert.equal(lue.valide, true, `page « ${nom} » : ${lue.raison}`);
    assert.equal(lue.page.formatVersion, ENVELOPPE_FORMAT_V1, `page « ${nom} »`);
    assert.equal(lue.page.sel, null, "une page v1 ne porte pas de sel");
    assert.equal(lue.page.domaine, null, "une page v1 ne déclare aucun domaine de racine");
  }
  assert.notEqual(
    vecteurs.enveloppe.embarquee.page,
    vecteurs.enveloppe.complete.page,
    "si les deux pages étaient égales, le filtrage ne serait éprouvé par rien",
  );
});

test("le MODÈLE reproduit les trois pages figées depuis les CLÉS, octet pour octet", async () => {
  // Le contrat de format, refait depuis les clés plutôt que depuis les chiffrés publiés : chaque
  // emplacement est ré-enveloppé sous sa KEK, chaque racine rescellée sous la DEK.
  const keks = { [TYPES_KEK.harnais]: KEK.harnais, [TYPES_KEK.recuperation]: KEK.recuperation };
  for (const [nom, figee] of Object.entries(vecteurs.enveloppe)) {
    const page = decoderPage(hexEnOctets(figee.page)).page;
    const emplacements = [];
    for (const emplacement of page.emplacements) {
      const scelle = await envelopperSousNonce({
        kek: await importerCleDeDeverrouillage(keks[emplacement.typeKek]),
        emplacement: {
          identifiantVolume: IDENTIFIANT_VOLUME,
          identifiantEmplacement: emplacement.identifiantEmplacement,
          formatVersion: EMPLACEMENT_FORMAT_V1,
          typeKek: emplacement.typeKek,
          parametres: emplacement.parametres,
        },
        dek: DEK,
        nonce: emplacement.nonce,
      });
      emplacements.push({
        identifiantEmplacement: emplacement.identifiantEmplacement,
        typeKek: emplacement.typeKek,
        parametres: emplacement.parametres,
        nonce: scelle.nonce,
        dekEnveloppee: scelle.chiffre,
        etiquette: scelle.etiquette,
      });
    }
    const refaite = await composerPageAlaMain({
      identifiantVolume: IDENTIFIANT_VOLUME,
      version: page.version,
      dek: DEK,
      emplacements,
      nonce: page.racine.nonce,
      formatVersion: ENVELOPPE_FORMAT_V1,
    });
    assert.equal(octetsEnHex(refaite), figee.page, `page « ${nom} »`);
  }
});

test("la page EMBARQUÉE figée se RESTAURE encore, et s'ouvre par le code de récupération", async () => {
  // La propriété qui compte pour un utilisateur : une archive faite avant T2b s'ouvre encore. La
  // section est acceptée par la garde de format, posée en `<volume>.cles`, et le déverrouillage par
  // le CODE de récupération la migre en v2 au passage.
  const page = hexEnOctets(vecteurs.enveloppe.embarquee.page);
  const declare = exigerEnveloppeDeRecuperationSeule(page);
  assert.equal(declare.version, vecteurs.enveloppe.embarquee.version);
  assert.equal(declare.emplacements, vecteurs.enveloppe.embarquee.emplacements);

  const support = supportDouble({ octets: fichierDEnveloppeDepuisLaPage(page) });
  const ouverte = await ouvrirEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: KEK.recuperation,
  });
  assert.equal(octetsEnHex(ouverte.dek), vecteurs.cles.dek.hex, "la DEK sort de la page restaurée");
  assert.equal(ouverte.migration.faite, true, "et la page v1 restaurée est migrée en v2");
  assert.equal(ouverte.migration.vers, ENVELOPPE_FORMAT_V2);
});

test("le produit écrit aujourd'hui une page EMBARQUÉE en v2, du domaine « recuperation »", async () => {
  // Ce que la tranche T2b change : la racine de la page embarquée n'est plus scellée sous la DEK.
  // Les OCTETS de cette page sont figés dans `tests/vectors/enveloppe-v2.json` ; ce qui est mesuré
  // ici est le FAIT, sur l'enveloppe même du vecteur d'archive.
  const { support } = await enveloppeComplete();
  const construite = await construireEnveloppeDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: KEK.harnais,
    aleas: aleas([], [NONCES.racineEmbarquee], [SEL_EMBARQUE]),
  });

  const page = decoderPage(construite.octets).page;
  assert.equal(page.formatVersion, ENVELOPPE_FORMAT_V2);
  assert.equal(page.domaine, DOMAINES_DE_RACINE.recuperation);
  assert.deepEqual(Array.from(page.sel), Array.from(SEL_EMBARQUE), "le sel est écrit EN CLAIR");
  assert.equal(construite.emplacements, vecteurs.enveloppe.embarquee.emplacements);
  assert.equal(construite.version, vecteurs.enveloppe.embarquee.version);
  assert.notEqual(
    octetsEnHex(construite.octets),
    vecteurs.enveloppe.embarquee.page,
    "une page v2 ne peut pas être égale à la page v1 figée : le format a changé",
  );
});

/** Le sel FIGÉ de la page embarquée v2, pour que l'épreuve ne dépende d'aucun tirage. */
const SEL_EMBARQUE = hexEnOctets("cc".repeat(32));

test("l'INFO et les DONNÉES ASSOCIÉES de l'engagement sont celles du vecteur, octet pour octet", () => {
  // La dérivation du domaine `archive` (ADR 0033, décision 3) et ce que l'engagement scelle
  // (Definition of Ready de #181, décision 2) sont deux ENCODAGES : ils se figent, et le produit
  // doit les reproduire. Le vecteur les publie tous les deux en hexadécimal.
  assert.equal(
    octetsEnHex(
      encoderInfoDeDomaine({
        domaine: DOMAINES.archive,
        identifiantVolume: vecteurs.engagement.descripteur.identifiantVolume,
        versionDeFormat: vecteurs.engagement.descripteur.versionDArchive,
      }),
    ),
    vecteurs.engagement.info,
  );
  assert.equal(
    octetsEnHex(donneesAssocieesDeLEngagement(vecteurs.engagement.descripteur)),
    vecteurs.engagement.donneesAssociees,
  );
});

test("l'ENGAGEMENT du vecteur est celui que le produit scelle, sous le même sel et le même nonce", async () => {
  const scelle = await scellerEngagement({
    cleMaitresse: DEK,
    empreinteDuContenu: hexEnOctets(vecteurs.archive.empreinteDuContenu),
    descripteur: vecteurs.engagement.descripteur,
    sel: hexEnOctets(vecteurs.engagement.sel),
    nonce: hexEnOctets(vecteurs.engagement.nonce),
  });
  assert.equal(octetsEnHex(scelle.chiffre), vecteurs.engagement.chiffre);
  assert.equal(octetsEnHex(scelle.etiquette), vecteurs.engagement.etiquette);
  // Et il OUVRE : un vecteur qui ne se relit pas ne prouverait que l'accord de deux encodeurs.
  const ouvert = await ouvrirEngagement({ cleMaitresse: DEK, engagement: scelle });
  assert.equal(octetsEnHex(ouvert), vecteurs.archive.empreinteDuContenu);
});

test("le SEL est TIRÉ : deux scellements du MÊME contenu n'ont ni le même sel ni la même clé", async () => {
  // Les vecteurs figent l'encodage SOUS UN SEL DONNÉ ; ils ne disent rien de la façon dont le
  // produit l'obtient. Or c'est le tirage qui rend la clé du domaine `archive` à USAGE UNIQUE, donc
  // ce qui autorise « une archive, une clé, un scellement, AUCUN compteur » (ADR 0033 décision 3,
  // ADR 0034 décision 2). Une constante à la place du tirage ferait exactement ce que la règle
  // interdit, et rien ne le voyait (constat 5 de la revue de format de la PR #184).
  const appel = {
    cleMaitresse: DEK,
    empreinteDuContenu: hexEnOctets(vecteurs.archive.empreinteDuContenu),
    descripteur: vecteurs.engagement.descripteur,
  };
  const premier = await scellerEngagement(appel);
  const second = await scellerEngagement(appel);

  assert.equal(premier.sel.byteLength, 32, "un sel de domaine fait 32 octets");
  assert.notEqual(
    octetsEnHex(premier.sel),
    octetsEnHex(second.sel),
    "le sel est TIRÉ, pas constant",
  );
  assert.notEqual(octetsEnHex(premier.nonce), octetsEnHex(second.nonce));
  // Et ce n'est pas seulement le sel qui change : la CLÉ en dépend, donc le chiffré et l'étiquette.
  assert.notEqual(octetsEnHex(premier.chiffre), octetsEnHex(second.chiffre));
  assert.notEqual(octetsEnHex(premier.etiquette), octetsEnHex(second.etiquette));

  // Les deux OUVRENT, et sur la même empreinte : deux sels distincts ne sont pas deux contenus.
  for (const scelle of [premier, second]) {
    const ouvert = await ouvrirEngagement({ cleMaitresse: DEK, engagement: scelle });
    assert.equal(octetsEnHex(ouvert), vecteurs.archive.empreinteDuContenu);
  }
});

test("le VOISIN « .engagement » du vecteur fait 180 octets, et il se relit", async () => {
  const scelle = await scellerEngagement({
    cleMaitresse: DEK,
    empreinteDuContenu: hexEnOctets(vecteurs.archive.empreinteDuContenu),
    descripteur: vecteurs.engagement.descripteur,
    sel: hexEnOctets(vecteurs.engagement.sel),
    nonce: hexEnOctets(vecteurs.engagement.nonce),
  });
  const octets = encoderFichierDEngagement(scelle);
  assert.equal(octets.byteLength, vecteurs.engagement.voisinOctets);
  assert.equal(octetsEnHex(octets), vecteurs.engagement.voisin);

  const relu = decoderFichierDEngagement(hexEnOctets(vecteurs.engagement.voisin));
  assert.equal(relu.valide, true, relu.raison ?? "");
  assert.deepEqual({ ...relu.engagement.descripteur }, vecteurs.engagement.descripteur);
});

test("l'ARCHIVE entière du vecteur est celle que `writeArchive` produit, octet pour octet", async () => {
  const contenu = Uint8Array.from(
    { length: vecteurs.volume.tailleFichier },
    (_, index) => (index * 7 + 13) % 256,
  );
  const { archive, headerLength, archiveLength } = await exportVolumeToBytes({
    source: {
      size: contenu.byteLength,
      read: async (offset, longueur) => contenu.slice(offset, offset + longueur),
    },
    manifest: vecteurs.archive.enTete.manifest,
    consistency: vecteurs.archive.enTete.content.consistency,
    cle: DEK,
    // Le SEL et le NONCE de l'engagement sont FIGÉS, sous le jeton du harnais : le produit les tire,
    // et un vecteur reproductible est un vecteur dont l'aléa est écrit noir sur blanc.
    engagementFige: {
      jeton: HARNAIS_ENGAGEMENT_JETON,
      sel: hexEnOctets(vecteurs.engagement.sel),
      nonce: hexEnOctets(vecteurs.engagement.nonce),
    },
    recovery: {
      octets: hexEnOctets(vecteurs.enveloppe.embarquee.page),
      digest: vecteurs.enveloppe.embarquee.empreinte,
      version: vecteurs.enveloppe.embarquee.version,
      emplacements: vecteurs.enveloppe.embarquee.emplacements,
    },
  });

  assert.equal(headerLength, vecteurs.archive.longueurEnTete);
  assert.equal(archiveLength, vecteurs.archive.longueurTotale);
  assert.equal(octetsEnHex(archive), vecteurs.archive.hex);
});

test("l'ARCHIVE d'un volume ANTÉRIEUR est celle que le produit écrit, octet pour octet", async () => {
  // La forme que la revue de format de la PR #184 a trouvée écrite et exigée nulle part décrite
  // (constat 2) : une archive v3 d'un volume v2 déclare « engagement: null », EXPLICITEMENT. Sans
  // clé, sans identifiant de volume, sans section de récupération — et sans authentification, ce
  // que le § 7.5 dit désormais. C'est ce qui garde possible la sauvegarde que l'ADR 0011 exige
  // AVANT une migration v2 → v3.
  const publie = vecteurs.archiveDeVolumeAnterieur;
  const contenu = Uint8Array.from(
    { length: publie.volume.tailleFichier },
    (_, index) => (index * 11 + 5) % 256,
  );
  const { archive, headerLength, archiveLength } = await exportVolumeToBytes({
    source: {
      size: contenu.byteLength,
      read: async (offset, longueur) => contenu.slice(offset, offset + longueur),
    },
    manifest: publie.enTete.manifest,
    consistency: publie.enTete.content.consistency,
  });

  assert.equal(headerLength, publie.longueurEnTete);
  assert.equal(archiveLength, publie.longueurTotale);
  assert.equal(octetsEnHex(archive), publie.hex);
});

test("les offsets publiés sont ceux que la disposition impose", () => {
  const { longueurEnTete, offsetDuContenu, offsetDeLaRecuperation, longueurTotale } =
    vecteurs.archive;
  assert.equal(offsetDuContenu, vecteurs.specification.preambuleOctets + longueurEnTete);
  assert.equal(offsetDeLaRecuperation, offsetDuContenu + vecteurs.volume.tailleFichier);
  assert.equal(
    longueurTotale,
    offsetDeLaRecuperation + vecteurs.archive.enTete.recovery.length,
    "taille de l'archive = 12 + H + N + R",
  );
});
