import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import {
  ENVELOPPE_FORMAT_V1,
  TYPES_KEK,
  encoderAssociationEmplacement,
  encoderEmplacements,
  encoderEnteteEnveloppe,
} from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  developper,
  empreinteDesEmplacements,
  envelopperSousNonce,
  importerCleDeDeverrouillage,
  importerCleDeVolume,
  ouvrirRacine,
  scellerRacineSousNonce,
} from "../../src/vm/enveloppe/modele-reference.mjs";
import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { suiteDOctets } from "./support-enveloppe-double.mjs";

// Le MODÈLE DE RÉFÉRENCE de l'enveloppe, éprouvé pour lui-même (#21, ADR 0020).
//
// Ce fichier ne mesure pas le produit : il mesure la SPÉCIFICATION. Ce qu'il doit établir tient en
// trois points, et chacun a été payé par une erreur d'un ADR antérieur :
//
//  1. les données associées LIENT réellement ce qu'elles prétendent lier — un emplacement déplacé
//     d'un volume à l'autre, ou d'un identifiant à l'autre, ne se développe pas. Sans cette épreuve,
//     « lier l'identité » ne serait qu'une phrase, et l'ADR 0015 a montré (encodage non préfixé)
//     qu'une phrase suffit rarement ;
//  2. l'ORDRE des vérifications est celui de l'ADR 0015 — authentifier, puis classer. Un verdict
//     posé sur un en-tête que rien ne garantit est une devinette ;
//  3. aucune attente n'est facultative : `undefined` est refusé, `null` dit « aucun contrôle » et
//     le dit à l'appel.

const VOLUME_A = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const VOLUME_B = "ffeeddccbbaa99887766554433221100";
const DEK = suiteDOctets(0x20, 32);
const KEK = suiteDOctets(0x80, 32);
const NONCE = suiteDOctets(0x01, 12);
const EMPLACEMENT = "1111111111111111";

/** L'emplacement canonique de ces épreuves, dont on fera varier UN champ à la fois. */
function description(surcharge = {}) {
  return {
    identifiantVolume: VOLUME_A,
    identifiantEmplacement: EMPLACEMENT,
    formatVersion: ENVELOPPE_FORMAT_V1,
    typeKek: TYPES_KEK.harnais,
    parametres: new Uint8Array(0),
    ...surcharge,
  };
}

async function envelopperCanonique(surcharge = {}) {
  const kek = await importerCleDeDeverrouillage(KEK);
  return {
    kek,
    emplacement: description(surcharge),
    scelle: await envelopperSousNonce({
      kek,
      emplacement: description(surcharge),
      dek: DEK,
      nonce: NONCE,
    }),
  };
}

test("la DEK enveloppée se développe sous la MÊME description, et rend les mêmes octets", async () => {
  const { kek, emplacement, scelle } = await envelopperCanonique();
  const rendue = await developper({
    kek,
    emplacement,
    scelle: { nonce: scelle.nonce, chiffre: scelle.chiffre, etiquette: scelle.etiquette },
  });
  assert.deepEqual(rendue, DEK);
});

test("un champ des données associées suffit à refuser : volume, emplacement, type, paramètres", async () => {
  const { kek, scelle } = await envelopperCanonique();
  const variantes = [
    ["autre volume", { identifiantVolume: VOLUME_B }],
    ["autre emplacement", { identifiantEmplacement: "2222222222222222" }],
    ["autre type de clé", { typeKek: TYPES_KEK.phrase }],
    ["paramètres publics modifiés", { parametres: suiteDOctets(0xf0, 8) }],
    ["autre version de format", { formatVersion: 2 }],
  ];

  for (const [nom, surcharge] of variantes) {
    const rendue = await developper({
      kek,
      emplacement: description(surcharge),
      scelle: { nonce: scelle.nonce, chiffre: scelle.chiffre, etiquette: scelle.etiquette },
    });
    assert.equal(rendue, null, `« ${nom} » a développé la clé de volume`);
  }

  // Témoin positif, dans le même corps : la description d'origine développe toujours.
  assert.deepEqual(
    await developper({
      kek,
      emplacement: description(),
      scelle: { nonce: scelle.nonce, chiffre: scelle.chiffre, etiquette: scelle.etiquette },
    }),
    DEK,
  );
});

test("les paramètres publics du dérivateur sont AUTHENTIFIÉS, pas seulement transportés", async () => {
  // C'est la garde que #22 attend : un adversaire qui ramènerait le coût d'une dérivation à
  // presque rien ne doit pas pouvoir le faire en silence. La preuve tient dans les octets des
  // données associées, qui changent avec les paramètres.
  const sans = encoderAssociationEmplacement(description());
  const avec = encoderAssociationEmplacement(description({ parametres: suiteDOctets(0xf0, 8) }));
  assert.notEqual(octetsEnHex(sans), octetsEnHex(avec));
});

test("l'encodage canonique est INJECTIF : deux listes distinctes ne rendent pas les mêmes octets", async () => {
  // Le piège que l'ADR 0015 a nommé : sans préfixe de longueur, un octet glissé d'un champ au
  // suivant laisse les octets inchangés. On l'éprouve sur le champ de largeur variable.
  const base = {
    identifiantEmplacement: EMPLACEMENT,
    typeKek: TYPES_KEK.phrase,
    nonce: NONCE,
    etiquette: suiteDOctets(0x40, 16),
  };
  const gauche = [{ ...base, parametres: Uint8Array.from([1, 2, 3]) }];
  const droite = [{ ...base, parametres: Uint8Array.from([1, 2]) }];
  assert.notEqual(
    octetsEnHex(encoderEmplacements(gauche)),
    octetsEnHex(encoderEmplacements(droite)),
  );

  // Et l'ORDRE compte : deux permutations de la même paire sont deux enveloppes différentes.
  const autre = {
    ...base,
    identifiantEmplacement: "2222222222222222",
    parametres: Uint8Array.from([9]),
  };
  assert.notEqual(
    octetsEnHex(encoderEmplacements([gauche[0], autre])),
    octetsEnHex(encoderEmplacements([autre, gauche[0]])),
  );
});

test("la LONGUEUR de la liste n'entre PAS dans les données associées, le COMPTE si", () => {
  // C'est ce qui rend le refus de troncature possible : un adversaire rectifie la longueur, pas le
  // compte. Si les deux étaient authentifiés, une amputation tomberait dans « racine refusée » et
  // le diagnostic serait perdu ; si aucun ne l'était, elle passerait.
  const deux = encoderEnteteEnveloppe({
    identifiantVolume: VOLUME_A,
    formatVersion: ENVELOPPE_FORMAT_V1,
    version: 1,
    nombreEmplacements: 2,
  });
  const un = encoderEnteteEnveloppe({
    identifiantVolume: VOLUME_A,
    formatVersion: ENVELOPPE_FORMAT_V1,
    version: 1,
    nombreEmplacements: 1,
  });
  assert.notEqual(octetsEnHex(deux), octetsEnHex(un));
});

/** Une racine scellée sur une liste d'un seul emplacement, prête à être confrontée. */
async function racineCanonique(version = 3) {
  const { scelle } = await envelopperCanonique();
  const emplacements = [
    {
      identifiantEmplacement: EMPLACEMENT,
      typeKek: TYPES_KEK.harnais,
      parametres: new Uint8Array(0),
      nonce: scelle.nonce,
      etiquette: scelle.etiquette,
    },
  ];
  const dek = await importerCleDeVolume(DEK);
  const racine = await scellerRacineSousNonce({
    dek,
    racine: { identifiantVolume: VOLUME_A, formatVersion: ENVELOPPE_FORMAT_V1, version },
    emplacements,
    nonce: suiteDOctets(0x70, 12),
  });
  return { dek, emplacements, racine, version };
}

test("la racine est AUTHENTIFIÉE avant d'être classée : un en-tête bricolé tombe sur l'étiquette", async () => {
  const { dek, emplacements, racine, version } = await racineCanonique();
  const scelle = { nonce: racine.nonce, chiffre: racine.chiffre, etiquette: racine.etiquette };

  // En-tête réécrit pour prétendre venir d'un autre volume : ce n'est PAS un constat d'identité,
  // c'est un sceau qui ne vérifie pas. Prétendre le contraire serait un diagnostic inventé.
  await assert.rejects(
    ouvrirRacine({
      dek,
      entete: { ...racine.entete, identifiantVolume: VOLUME_B },
      scelle,
      emplacements,
      attentes: { identifiantVolume: VOLUME_B, versionMinimale: null },
    }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.racineRefusee),
  );

  // Témoin positif : le même appel sur l'en-tête authentique aboutit.
  const ouverte = await ouvrirRacine({
    dek,
    entete: racine.entete,
    scelle,
    emplacements,
    attentes: { identifiantVolume: VOLUME_A, versionMinimale: version },
  });
  assert.equal(
    octetsEnHex(ouverte.empreinte),
    octetsEnHex(await empreinteDesEmplacements(emplacements)),
  );
});

test("un en-tête AUTHENTIQUE d'un autre volume rend un constat d'identité, pas un sceau refusé", async () => {
  const { dek, emplacements, racine } = await racineCanonique();
  await assert.rejects(
    ouvrirRacine({
      dek,
      entete: racine.entete,
      scelle: { nonce: racine.nonce, chiffre: racine.chiffre, etiquette: racine.etiquette },
      emplacements,
      attentes: { identifiantVolume: VOLUME_B, versionMinimale: null },
    }),
    (erreur) => {
      assert.ok(isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.identite));
      assert.deepEqual(erreur.situations, ["deplacement"]);
      return true;
    },
  );
});

test("aucune attente n'est facultative : « undefined » est refusé, « null » est déclaré", async () => {
  const { dek, emplacements, racine } = await racineCanonique();
  const scelle = { nonce: racine.nonce, chiffre: racine.chiffre, etiquette: racine.etiquette };

  for (const attentes of [{ versionMinimale: null }, { identifiantVolume: VOLUME_A }, {}]) {
    await assert.rejects(
      ouvrirRacine({ dek, entete: racine.entete, scelle, emplacements, attentes }),
      (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.malforme),
      `attentes ${JSON.stringify(Object.keys(attentes))} acceptées alors qu'il en manque une`,
    );
  }
  await ouvrirRacine({
    dek,
    entete: racine.entete,
    scelle,
    emplacements,
    attentes: { identifiantVolume: null, versionMinimale: null },
  });
});

test("une racine sans aucun emplacement est refusée à l'écriture, pas seulement à la lecture", async () => {
  const dek = await importerCleDeVolume(DEK);
  await assert.rejects(
    scellerRacineSousNonce({
      dek,
      racine: { identifiantVolume: VOLUME_A, formatVersion: ENVELOPPE_FORMAT_V1, version: 1 },
      emplacements: [],
      nonce: suiteDOctets(0x70, 12),
    }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.malforme),
  );
});

test("les clés importées ne ressortent pas : ni la KEK, ni la DEK n'est extractible", async () => {
  for (const cle of [await importerCleDeDeverrouillage(KEK), await importerCleDeVolume(DEK)]) {
    assert.equal(cle.extractable, false);
    await assert.rejects(crypto.subtle.exportKey("raw", cle));
  }
});

test("une clé de déverrouillage qui ne fait pas trente-deux octets est refusée, jamais complétée", async () => {
  for (const largeur of [0, 16, 31, 33, 64]) {
    await assert.rejects(
      importerCleDeDeverrouillage(suiteDOctets(0, largeur)),
      (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.malforme),
      `${largeur} octets acceptés comme clé de déverrouillage`,
    );
  }
});

test("AUCUN module de l'enveloppe n'emploie AES-KW", async () => {
  // L'ADR 0015 l'écarte en une ligne, et l'ADR 0020 dit pourquoi cette ligne compte davantage ici :
  // `AES-KW` n'authentifie aucune donnée associée, si bien qu'une DEK enveloppée sous lui serait
  // déplaçable d'un emplacement — ou d'un volume — à l'autre. Une décision qu'aucune épreuve ne
  // relit finit toujours par se défaire, et c'est cette épreuve-là qui la relit.
  const racine = fileURLToPath(new URL("../../src/vm/", import.meta.url));
  const modules = [
    ...(await readdir(path.join(racine, "enveloppe"))).map((nom) => path.join("enveloppe", nom)),
    "enveloppe-de-cle.mjs",
    "ouverture-par-enveloppe.mjs",
  ];
  const coupables = [];
  for (const module of modules) {
    const contenu = await readFile(path.join(racine, module), "utf8");
    // Le NOM peut apparaître dans un commentaire qui l'écarte ; c'est son USAGE qui est interdit.
    if (/["'`]AES-KW["'`]|name:\s*["'`]AES-KW/.test(contenu)) coupables.push(module);
  }
  assert.deepEqual(coupables, []);
});
