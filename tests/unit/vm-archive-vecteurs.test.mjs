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
 *  1. **la page complète** que le volume porte — créée puis complétée par le chemin de production
 *     de l'ADR 0020, sous des aléas SCRIPTÉS ;
 *  2. **la page EMBARQUÉE** — la même version, filtrée aux seuls emplacements de type 4 et
 *     rescellée par `construireEnveloppeDeRecuperation`. C'est le filtrage lui-même qui est figé :
 *     les deux pages diffèrent, et le vecteur publie les deux ;
 *  3. **l'ENGAGEMENT et son voisin** — l'empreinte du fichier chiffré entier, scellée sous la clé
 *     du domaine `archive` dérivée par HKDF-SHA-256, et les cent quatre-vingts octets que la
 *     restauration dépose à côté du volume ;
 *  4. **l'archive entière** — `writeArchive` doit rendre exactement les octets du vecteur,
 *     en-tête JSON compris, ordre des champs compris.
 *
 * Un ROUGE ici ne se corrige pas en régénérant les vecteurs : soit le format persistant a changé
 * sans version ni ADR, soit le produit et la spécification ont divergé.
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
} from "../../src/vm/enveloppe-de-cle.mjs";
import { construireEnveloppeDeRecuperation } from "../../src/vm/enveloppe-de-recuperation.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { hexEnOctets, octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { aleasScriptes, supportDouble } from "./support-enveloppe-double.mjs";

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
const aleas = (identifiants, nonces) =>
  aleasScriptes({ identifiants, nonces: nonces.map(hexEnOctets), jeton: HARNAIS_ALEAS_JETON });

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
    aleas: aleas([], [NONCES.harnais, NONCES.racineV1]),
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
    aleas: aleas([], [NONCES.recuperation, NONCES.racineV2]),
  });
  // La page NEUVE occupe la page libre, c'est-à-dire la seconde : l'alternance de l'ADR 0020.
  const complete = support.contenu.slice(8192, 16384);
  return { support, creation, complete };
}

test("la page de CRÉATION du vecteur est celle que le produit écrit", async () => {
  const { creation } = await enveloppeComplete();
  assert.equal(octetsEnHex(creation), vecteurs.enveloppe.creation.page);
});

test("la page COMPLÈTE du vecteur — harnais ET récupération — est celle que le produit écrit", async () => {
  const { complete } = await enveloppeComplete();
  assert.equal(octetsEnHex(complete), vecteurs.enveloppe.complete.page);
});

test("la page EMBARQUÉE est la page filtrée et RESCELLÉE, et elle diffère de la complète", async () => {
  const { support } = await enveloppeComplete();
  const construite = await construireEnveloppeDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: KEK.harnais,
    aleas: aleas([], [NONCES.racineEmbarquee]),
  });

  assert.equal(construite.version, vecteurs.enveloppe.embarquee.version);
  assert.equal(construite.emplacements, vecteurs.enveloppe.embarquee.emplacements);
  assert.equal(octetsEnHex(construite.octets), vecteurs.enveloppe.embarquee.page);
  assert.equal(construite.digest, vecteurs.enveloppe.embarquee.empreinte);
  assert.notEqual(
    vecteurs.enveloppe.embarquee.page,
    vecteurs.enveloppe.complete.page,
    "si les deux pages étaient égales, le filtrage ne serait éprouvé par rien",
  );
});

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
