/**
 * LE CHEMIN DE PRODUCTION REPRODUIT LES VECTEURS DE PAGE **v2** (#182, T2b ; ADR 0020, 0027, 0033).
 *
 * `tests/vectors/enveloppe-v2.json` est un CONTRAT : la disposition d'une page v2, la clé DÉRIVÉE
 * sous laquelle sa racine est scellée, le sel qui la rend fraîche et l'octet qui dit son domaine y
 * sont figés, octet pour octet, par un outil qui pose ces octets lui-même et refait HKDF lui-même
 * (`tools/figer-vecteurs-enveloppe-v2.mjs`).
 *
 * Deux pages, et le choix des deux est le sujet :
 *
 *  1. **la page COMPLÈTE** de `<volume>.cles` — domaine `enveloppe`, deux emplacements ;
 *  2. **la page EMBARQUÉE** qu'une archive emporte — domaine `recuperation`, la même version, la
 *     liste filtrée aux seuls emplacements de type 4 (ADR 0027).
 *
 * Elles ne diffèrent pas seulement par leur liste : elles sont scellées sous DEUX CLÉS DISTINCTES,
 * parce que l'info HKDF porte le nom du domaine. C'est ce que cette suite mesure, et c'est ce qu'un
 * lecteur d'archive doit pouvoir refaire avec sa propre bibliothèque.
 *
 * Un ROUGE ici ne se corrige pas en régénérant les vecteurs : soit le format persistant a changé
 * sans version ni ADR, soit le produit et la spécification ont divergé.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  HARNAIS_ALEAS_JETON,
  ajouterEmplacement,
  creerEnveloppe,
  ouvrirEnveloppe,
} from "../../src/vm/enveloppe-de-cle.mjs";
import { construireEnveloppeDeRecuperation } from "../../src/vm/enveloppe-de-recuperation.mjs";
import {
  DOMAINES_DE_RACINE,
  ENVELOPPE_FORMAT_V2,
  TYPES_KEK,
  encoderEmplacements,
} from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  ENTETE_PAGE_V2_OCTETS,
  PAGE_OCTETS,
  decoderPage,
} from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import { empreinteDesEmplacements } from "../../src/vm/enveloppe/modele-reference.mjs";
import {
  DOMAINES,
  VERSIONS_DE_FORMAT_DE_DOMAINE,
  encoderInfoDeDomaine,
} from "../../src/vm/derivation/cle-de-domaine.mjs";
import { hexEnOctets, octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { aleasScriptes, supportDouble } from "./support-enveloppe-double.mjs";

const VECTEURS = JSON.parse(
  await readFile(new URL("../vectors/enveloppe-v2.json", import.meta.url), "utf8"),
);

const IDENTIFIANT_VOLUME = VECTEURS.volume.identifiantVolume;
const DEK = hexEnOctets(VECTEURS.cles.dek.hex);
const KEK = Object.fromEntries(
  VECTEURS.cles.keks.map((entree) => [entree.nom, hexEnOctets(entree.hex)]),
);
const ALEAS = VECTEURS.aleas;

/** Les aléas du vecteur, dans leur ordre de consommation. Le jeton du harnais est exigé. */
const aleas = (nonces, sels) =>
  aleasScriptes({
    identifiants: [],
    nonces: nonces.map(hexEnOctets),
    sels: sels.map(hexEnOctets),
    jeton: HARNAIS_ALEAS_JETON,
  });

/**
 * Rejoue le chemin de PRODUCTION jusqu'à l'enveloppe du vecteur : création sous le harnais, puis
 * ajout d'un emplacement de type 4 dont l'identifiant est FOURNI — ce que fait un moyen de
 * récupération (ADR 0021 : l'info HKDF lie l'identifiant, qui doit exister avant la clé).
 */
async function enveloppeDuVecteur() {
  const support = supportDouble();
  await creerEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    dek: DEK,
    kek: KEK.harnais,
    typeKek: TYPES_KEK.harnais,
    identifiantEmplacement: ALEAS.identifiants[0],
    // La CRÉATION consomme un nonce d'emplacement, un nonce de racine et un sel. Ses octets ne sont
    // pas figés — c'est la page COMPLÈTE qui l'est —, mais les aléas doivent être fournis pour que
    // rien ne reprenne du tirage réel.
    aleas: aleas([ALEAS.nonces.harnais, "00".repeat(12)], ["11".repeat(32)]),
  });
  await ajouterEmplacement({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: KEK.harnais,
    kekNouvelle: KEK.recuperation,
    typeKek: TYPES_KEK.recuperation,
    parametres: hexEnOctets(ALEAS.parametresRecuperation),
    identifiantEmplacement: ALEAS.identifiants[1],
    aleas: aleas([ALEAS.nonces.recuperation, ALEAS.nonces.racineEnveloppe], [ALEAS.sels.enveloppe]),
  });
  // La page NEUVE occupe la page libre, c'est-à-dire la seconde : l'alternance de l'ADR 0020.
  return { support, complete: support.contenu.slice(PAGE_OCTETS, PAGE_OCTETS * 2) };
}

test("les vecteurs v2 annoncent la disposition que le format implémente", () => {
  assert.equal(VECTEURS.specification.version, ENVELOPPE_FORMAT_V2);
  assert.equal(VECTEURS.specification.pageOctets, PAGE_OCTETS);
  assert.equal(VECTEURS.specification.enTetePageOctets, ENTETE_PAGE_V2_OCTETS);
  assert.equal(VECTEURS.specification.marqueur, "VLTKEY01");
  assert.equal(VECTEURS.cles.usage, "TEST");
  assert.ok(
    VECTEURS.avertissement.includes("TEST"),
    "un lecteur qui tomberait sur ce fichier doit savoir en une ligne que les clés ne sont pas des secrets",
  );
});

test("l'INFO de chaque domaine est celle que l'encodeur du produit calcule, octet pour octet", () => {
  // La séparation des domaines vit ENTIÈREMENT dans cette suite d'octets : deux pages du même
  // volume, à la même version de format, ne diffèrent que par le champ `domaine` de leur info. Si
  // cet encodage bougeait, les deux clés deviendraient une seule sans que rien ne le dise.
  for (const [nom, figee] of Object.entries(VECTEURS.pages)) {
    const domaine = figee.domaine;
    assert.equal(
      octetsEnHex(
        encoderInfoDeDomaine({
          domaine,
          identifiantVolume: IDENTIFIANT_VOLUME,
          versionDeFormat: VERSIONS_DE_FORMAT_DE_DOMAINE[domaine],
        }),
      ),
      figee.info,
      `info du domaine « ${domaine} » (page « ${nom} »)`,
    );
    assert.equal(VERSIONS_DE_FORMAT_DE_DOMAINE[domaine], figee.versionDeFormatDuDomaine);
  }
  assert.notEqual(
    VECTEURS.pages.complete.info,
    VECTEURS.pages.embarquee.info,
    "deux domaines, deux infos : sans cela, une seule clé",
  );
  assert.notEqual(
    VECTEURS.pages.complete.cleDerivee,
    VECTEURS.pages.embarquee.cleDerivee,
    "deux infos, deux clés : c'est la séparation que #182 achète",
  );
});

test("l'octet de DOMAINE figé est celui que le produit écrit", () => {
  assert.equal(VECTEURS.pages.complete.octetDeDomaine, DOMAINES_DE_RACINE.enveloppe);
  assert.equal(VECTEURS.pages.embarquee.octetDeDomaine, DOMAINES_DE_RACINE.recuperation);
  assert.deepEqual(
    [VECTEURS.pages.complete.domaine, VECTEURS.pages.embarquee.domaine],
    [DOMAINES.enveloppe, DOMAINES.recuperation],
  );
});

test("la page COMPLÈTE du vecteur est celle que le chemin de production écrit, octet pour octet", async () => {
  const { complete } = await enveloppeDuVecteur();
  assert.equal(octetsEnHex(complete), VECTEURS.pages.complete.page);
});

test("la page EMBARQUÉE est la page filtrée, RESCELLÉE sous l'autre domaine, et elle diffère", async () => {
  const { support } = await enveloppeDuVecteur();
  const construite = await construireEnveloppeDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: KEK.harnais,
    aleas: aleas([ALEAS.nonces.racineRecuperation], [ALEAS.sels.recuperation]),
  });

  assert.equal(construite.version, VECTEURS.pages.embarquee.version);
  assert.equal(construite.emplacements, VECTEURS.pages.embarquee.emplacements.length);
  assert.equal(octetsEnHex(construite.octets), VECTEURS.pages.embarquee.page);
  assert.notEqual(
    VECTEURS.pages.embarquee.page,
    VECTEURS.pages.complete.page,
    "si les deux pages étaient égales, ni le filtrage ni la séparation des domaines ne seraient éprouvés",
  );
});

test("chaque page figée se relit, et rend le SEL et le DOMAINE que le vecteur déclare", () => {
  for (const [nom, figee] of Object.entries(VECTEURS.pages)) {
    const lue = decoderPage(hexEnOctets(figee.page));
    assert.equal(lue.valide, true, `page « ${nom} » : ${lue.raison}`);
    assert.equal(lue.page.formatVersion, ENVELOPPE_FORMAT_V2);
    assert.equal(lue.page.version, figee.version);
    assert.equal(lue.page.identifiantVolume, IDENTIFIANT_VOLUME);
    assert.equal(octetsEnHex(lue.page.sel), figee.sel, `sel de « ${nom} »`);
    assert.equal(lue.page.domaine, figee.octetDeDomaine, `domaine de « ${nom} »`);
    assert.deepEqual(
      lue.page.emplacements.map((emplacement) => emplacement.identifiantEmplacement),
      figee.emplacements.map((emplacement) => emplacement.identifiantEmplacement),
      `ordre des emplacements de « ${nom} »`,
    );
  }
});

test("l'encodage canonique et l'empreinte figés sont ceux que le modèle calcule", async () => {
  for (const [nom, figee] of Object.entries(VECTEURS.pages)) {
    const emplacements = figee.emplacements.map((emplacement) => ({
      identifiantEmplacement: emplacement.identifiantEmplacement,
      typeKek: emplacement.typeKek,
      parametres: hexEnOctets(emplacement.parametres),
      nonce: hexEnOctets(emplacement.nonce),
      etiquette: hexEnOctets(emplacement.etiquette),
    }));
    assert.equal(
      octetsEnHex(encoderEmplacements(emplacements)),
      figee.racine.encodageCanonique,
      `encodage canonique de « ${nom} »`,
    );
    assert.equal(
      octetsEnHex(await empreinteDesEmplacements(emplacements)),
      figee.racine.empreinte,
      `empreinte de « ${nom} »`,
    );
  }
});

test("la page COMPLÈTE figée rend la DEK figée, sous chacune de ses deux clés de déverrouillage", async () => {
  // Le vecteur ne vaut que s'il OUVRE : une page figée qu'aucune clé ne développe ne prouverait que
  // la stabilité d'un tableau d'octets.
  for (const nom of ["harnais", "recuperation"]) {
    const fichier = new Uint8Array(PAGE_OCTETS * 2);
    fichier.set(hexEnOctets(VECTEURS.pages.complete.page), 0);
    const ouverte = await ouvrirEnveloppe({
      support: supportDouble({ octets: fichier }),
      identifiantVolume: IDENTIFIANT_VOLUME,
      kek: KEK[nom],
    });
    assert.equal(octetsEnHex(ouverte.dek), VECTEURS.cles.dek.hex, `DEK sous la KEK « ${nom} »`);
    assert.equal(ouverte.migration, null, "une page v2 ne se migre pas : elle est déjà à jour");
  }
});

test("la page EMBARQUÉE figée s'ouvre par le CODE de récupération, et par lui seul", async () => {
  // C'est la propriété de l'ADR 0027 : l'archive porte un moyen de récupération et rien d'autre. La
  // clé du harnais ne l'ouvre pas, non parce qu'elle serait mauvaise, mais parce que son emplacement
  // n'y est plus.
  const fichier = new Uint8Array(PAGE_OCTETS * 2);
  fichier.set(hexEnOctets(VECTEURS.pages.embarquee.page), 0);
  const ouverte = await ouvrirEnveloppe({
    support: supportDouble({ octets: fichier }),
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: KEK.recuperation,
  });
  assert.equal(octetsEnHex(ouverte.dek), VECTEURS.cles.dek.hex);

  await assert.rejects(
    ouvrirEnveloppe({
      support: supportDouble({ octets: fichier }),
      identifiantVolume: IDENTIFIANT_VOLUME,
      kek: KEK.harnais,
    }),
    (erreur) => erreur.code === "VAULT_ENVELOPPE_CLE_REFUSEE",
  );
});

test("un SEL retouché d'un octet fait REFUSER la racine : il se protège par sa conséquence", async () => {
  // Le sel n'est pas authentifié, et l'ADR 0033 dit pourquoi : le changer fait dériver une AUTRE
  // clé, donc échouer l'étiquette. C'est la même construction que le nonce. L'épreuve le MESURE, au
  // lieu de le laisser croire — et sur le vecteur figé, pas sur une page fabriquée pour l'occasion.
  const page = hexEnOctets(VECTEURS.pages.complete.page);
  page[VECTEURS.specification.selOffset] ^= 0x01;
  // La somme de contrôle est recalculée : sans cela l'épreuve mesurerait une page DÉCHIRÉE, ce qui
  // est un autre refus. Elle ne prétend à aucune résistance à un adversaire (ADR 0020).
  const fichier = new Uint8Array(PAGE_OCTETS * 2);
  fichier.set(rescellerLaSomme(page), 0);

  await assert.rejects(
    ouvrirEnveloppe({
      support: supportDouble({ octets: fichier }),
      identifiantVolume: IDENTIFIANT_VOLUME,
      kek: KEK.harnais,
    }),
    (erreur) => erreur.code === "VAULT_ENVELOPPE_RACINE_REFUSEE",
  );
});

/** Recalcule le CRC-32 d'une page v2 dont les octets viennent d'être remaniés. */
function rescellerLaSomme(page) {
  const vue = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const longueurListe = vue.getUint32(40, true);
  const utiles = page.slice(0, VECTEURS.specification.enTetePageOctets + longueurListe);
  utiles.fill(0, VECTEURS.specification.crcOffset, VECTEURS.specification.crcOffset + 4);
  let valeur = 0xffffffff;
  for (const octet of utiles) {
    let terme = (valeur ^ octet) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
      terme = terme & 1 ? (0xedb88320 ^ (terme >>> 1)) >>> 0 : terme >>> 1;
    }
    valeur = (terme ^ (valeur >>> 8)) >>> 0;
  }
  vue.setUint32(VECTEURS.specification.crcOffset, (valeur ^ 0xffffffff) >>> 0, true);
  return page;
}
