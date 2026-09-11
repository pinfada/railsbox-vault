import assert from "node:assert/strict";
import test from "node:test";

import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import {
  DOMAINES,
  SEL_VIDE,
  VERSIONS_DE_FORMAT_DE_DOMAINE,
  deriverCleDeDomaine,
  encoderInfoDeDomaine,
  importerMateriauMaitre,
} from "../../src/vm/derivation/cle-de-domaine.mjs";
import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import {
  infoDeDomaineDeReference,
  infoSansPrefixes,
  okmDeReference,
} from "./modele-derivation.mjs";

// L'INJECTIVITÉ de l'info HKDF, par MUTATION et non par affirmation (#182, ADR 0033, décision 3).
//
// L'ADR 0033 fait dépendre une propriété de sécurité de CHAQUE champ de l'info :
//
//   | Champ                        | Ce qu'il empêche                                                |
//   | ---------------------------- | --------------------------------------------------------------- |
//   | étiquette du schéma          | qu'une future hiérarchie tire les mêmes clés sous la même DEK   |
//   | domaine                      | qu'un secteur et une racine d'enveloppe partagent une clé        |
//   | identifiant de volume        | que la coquille et l'application partagent une clé               |
//   | version de format du domaine | qu'un artefact v3 et un artefact v4 se lisent sous la même clé   |
//   | algorithme                   | qu'un second AEAD réinterprète un chiffré produit par le premier |
//
// Une table pareille se vérifie en RETIRANT chaque champ, jamais en la relisant. Ce fichier tient
// les deux moitiés que le patron de `vm-format-chiffre-identite.test.mjs` impose :
//
//  1. **deux identités qui ne diffèrent que d'UN champ tirent des clés DISTINCTES** — pour chaque
//     champ, un par un ;
//  2. **l'info privée de ses préfixes de longueur fait COLLISIONNER deux identités distinctes**, et
//     c'est ce que le préfixe achète. Le dépôt refuse depuis #18 une sûreté qui tiendrait à une
//     propriété du CONTENU — « tant qu'aucun domaine ne contient de barre oblique » — plutôt qu'à
//     une propriété de l'ENCODAGE.
//
// Le SECOND MODÈLE, écrit à la main dans `modele-derivation.mjs`, est ce qui rend la mesure
// crédible : deux appels du même encodeur s'accordent toujours, y compris quand il est faux.

const VOLUME = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";

const IDENTITE = Object.freeze({
  domaine: DOMAINES.volume,
  identifiantVolume: VOLUME,
  versionDeFormat: VERSIONS_DE_FORMAT_DE_DOMAINE[DOMAINES.volume],
});

/** Les trente-deux octets que l'identité présentée tire de la clé de TEST, sous le sel vide. */
async function okm(identite, info = encoderInfoDeDomaine(identite)) {
  return okmDeReference({ materiau: CLE_DE_TEST, sel: SEL_VIDE, info });
}

test("le produit et le SECOND MODÈLE écrivent la MÊME info, octet pour octet", () => {
  for (const domaine of Object.values(DOMAINES)) {
    const identite = {
      domaine,
      identifiantVolume: VOLUME,
      versionDeFormat: VERSIONS_DE_FORMAT_DE_DOMAINE[domaine],
    };
    assert.equal(
      octetsEnHex(encoderInfoDeDomaine(identite)),
      octetsEnHex(infoDeDomaineDeReference(identite)),
      `« ${domaine} » : les deux transcriptions divergent`,
    );
  }
});

test("l'info porte les CINQ champs de l'ADR 0033, et chacun s'y lit", () => {
  const info = new TextDecoder().decode(encoderInfoDeDomaine(IDENTITE));
  assert.match(info, /railsbox-vault\/derivation-de-domaine\/v1/);
  assert.match(info, /volume/);
  assert.match(info, new RegExp(VOLUME));
  assert.match(info, /aes-256-gcm/);
  // La version, elle, est BINAIRE : elle se lit dans les octets, pas dans le texte.
  assert.deepEqual(
    [...encoderInfoDeDomaine(IDENTITE)].slice(-17, -13),
    [0, 0, 0, VERSIONS_DE_FORMAT_DE_DOMAINE[DOMAINES.volume]],
    "la version de format du domaine est un U32BE, juste avant LP(algorithme)",
  );
});

test("chaque CHAMP de l'info sépare : deux identités qui n'en diffèrent que d'un tirent DEUX clés", async () => {
  const reference = await okm(IDENTITE);

  const ecarts = [
    ["domaine", { ...IDENTITE, domaine: DOMAINES.journal }],
    ["identifiantVolume", { ...IDENTITE, identifiantVolume: "0f1e2d3c4b5a69788796a5b4c3d2e1f1" }],
    ["versionDeFormat", { ...IDENTITE, versionDeFormat: IDENTITE.versionDeFormat + 1 }],
  ];

  for (const [champ, identite] of ecarts) {
    assert.notEqual(
      octetsEnHex(await okm(identite)),
      octetsEnHex(reference),
      `un écart de « ${champ} » doit tirer une AUTRE clé`,
    );
  }

  // L'ÉTIQUETTE DU SCHÉMA et l'ALGORITHME sont constants dans le produit : on ne peut pas les faire
  // varier par un paramètre. On les fait donc varier dans le SECOND MODÈLE, qui les pose à la main —
  // c'est exactement l'usage pour lequel il existe.
  const info = infoDeDomaineDeReference(IDENTITE);
  for (const [champ, mutee] of [
    [
      "étiquette du schéma",
      remplacerTexte(info, "derivation-de-domaine/v1", "derivation-de-domaine/v2"),
    ],
    ["algorithme", remplacerTexte(info, "aes-256-gcm", "aes-256-gcx")],
  ]) {
    assert.notEqual(
      octetsEnHex(mutee),
      octetsEnHex(info),
      `la mutation de « ${champ} » n'a rien changé`,
    );
    assert.notEqual(
      octetsEnHex(await okm(IDENTITE, mutee)),
      octetsEnHex(reference),
      `un écart de « ${champ} » doit tirer une AUTRE clé`,
    );
  }
});

/** Remplace un texte de MÊME longueur dans une suite d'octets. Aucun décalage : seul le contenu change. */
function remplacerTexte(octets, avant, apres) {
  assert.equal(
    avant.length,
    apres.length,
    "la mutation doit garder la longueur, sinon elle décale",
  );
  const hex = octetsEnHex(octets);
  const cible = octetsEnHex(new TextEncoder().encode(avant));
  const index = hex.indexOf(cible);
  assert.notEqual(index, -1, `« ${avant} » est introuvable dans l'info`);
  const mute =
    hex.slice(0, index) +
    octetsEnHex(new TextEncoder().encode(apres)) +
    hex.slice(index + cible.length);
  return Uint8Array.from(mute.match(/../g).map((paire) => Number.parseInt(paire, 16)));
}

test("SANS ses préfixes de longueur, l'info fait COLLISIONNER deux identités distinctes", async () => {
  // C'est la mutation qui donne son prix au préfixe, et le patron est celui de #18 sur l'identité
  // d'un bloc. Les deux identités ci-dessous sont RÉELLEMENT distinctes — un domaine et un
  // identifiant de volume différents — et leur concaténation NON PRÉFIXÉE est la même suite
  // d'octets : la frontière entre les deux champs a disparu.
  const gauche = { domaine: "volume", identifiantVolume: "ab", versionDeFormat: 4 };
  const droite = { domaine: "volumeab", identifiantVolume: "", versionDeFormat: 4 };

  assert.notDeepEqual(gauche, droite, "les deux identités doivent être distinctes");
  assert.equal(
    octetsEnHex(infoSansPrefixes(gauche)),
    octetsEnHex(infoSansPrefixes(droite)),
    "sans préfixes, les deux identités rendent la MÊME info : c'est la collision",
  );
  assert.equal(
    octetsEnHex(
      await okmDeReference({
        materiau: CLE_DE_TEST,
        sel: SEL_VIDE,
        info: infoSansPrefixes(gauche),
      }),
    ),
    octetsEnHex(
      await okmDeReference({
        materiau: CLE_DE_TEST,
        sel: SEL_VIDE,
        info: infoSansPrefixes(droite),
      }),
    ),
    "et donc la MÊME clé, ce qui est exactement ce que le préfixe empêche",
  );

  // AVEC les préfixes — l'encodage du produit —, les deux identités ne collisionnent plus.
  assert.notEqual(
    octetsEnHex(infoDeDomaineDeReference(gauche)),
    octetsEnHex(infoDeDomaineDeReference(droite)),
    "le préfixe de longueur rend l'encodage injectif",
  );
});

test("le produit DÉRIVE bien ce que le second modèle calcule : scellé sous l'une, ouvert sous l'autre", async () => {
  // La clé du produit est NON EXTRACTIBLE : on ne peut pas comparer ses octets. Ce qu'on peut faire
  // est SCELLER sous elle et OUVRIR sous la clé que le second modèle a calculée. Une seule des deux
  // voit les octets, et l'égalité est pourtant établie.
  const info = encoderInfoDeDomaine(IDENTITE);
  const duProduit = await deriverCleDeDomaine({
    cleMaitresse: CLE_DE_TEST,
    domaine: IDENTITE.domaine,
    sel: SEL_VIDE,
    info,
  });
  const duModele = await crypto.subtle.importKey(
    "raw",
    await okmDeReference({
      materiau: CLE_DE_TEST,
      sel: SEL_VIDE,
      info: infoDeDomaineDeReference(IDENTITE),
    }),
    "AES-GCM",
    false,
    ["decrypt"],
  );

  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const clair = Uint8Array.from({ length: 64 }, (_, index) => index);
  const scelle = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, duProduit, clair),
  );
  const relu = new Uint8Array(
    await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, tagLength: 128 }, duModele, scelle),
  );
  assert.deepEqual(relu, clair);
});

test("le matériau maître est le MÊME objet pour tous les domaines d'une session", async () => {
  // Il est importé UNE fois et réemployé : la clé maîtresse n'a pas à traverser deux importations,
  // et surtout ses OCTETS n'ont pas à être conservés par la session (ADR 0033, décision 6).
  const materiau = await importerMateriauMaitre(CLE_DE_TEST);
  const cles = [];
  for (const domaine of [DOMAINES.volume, DOMAINES.journal]) {
    cles.push(
      await deriverCleDeDomaine({
        cleMaitresse: materiau,
        domaine,
        sel: SEL_VIDE,
        info: encoderInfoDeDomaine({
          domaine,
          identifiantVolume: VOLUME,
          versionDeFormat: VERSIONS_DE_FORMAT_DE_DOMAINE[domaine],
        }),
      }),
    );
  }
  assert.equal(cles.length, 2);
  for (const cle of cles) {
    assert.equal(cle.algorithm.name, "AES-GCM");
    assert.equal(cle.extractable, false);
  }

  // Une clé AES présentée comme matériau maître est REFUSÉE : elle ne dérive rien, et le dire vaut
  // mieux que de laisser la plate-forme lever un message qu'on devrait traduire.
  await assert.rejects(() =>
    deriverCleDeDomaine({
      cleMaitresse: cles[0],
      domaine: DOMAINES.volume,
      sel: SEL_VIDE,
      info: encoderInfoDeDomaine(IDENTITE),
    }),
  );
});

test("le DOMAINE déclaré est RECOUPÉ avec l'info : présenter l'info d'un autre est refusé", async () => {
  // Revue de sécurité de la PR #186, constat 5. L'en-tête du module promettait « le régime est une
  // propriété du DOMAINE, et il est vérifié ici » ; en fait le domaine ne décidait que de la largeur
  // du sel, et l'info — le seul champ qui sépare les clés — n'était jamais confrontée à lui.
  const identifiantVolume = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  const infoDuJournal = encoderInfoDeDomaine({
    domaine: DOMAINES.journal,
    identifiantVolume,
    versionDeFormat: VERSIONS_DE_FORMAT_DE_DOMAINE[DOMAINES.journal],
  });

  await assert.rejects(
    () =>
      deriverCleDeDomaine({
        cleMaitresse: CLE_DE_TEST,
        domaine: DOMAINES.volume,
        sel: SEL_VIDE,
        info: infoDuJournal,
      }),
    (erreur) => {
      assert.match(erreur.message, /ne décrit pas le domaine/);
      return true;
    },
    "annoncer « volume » et présenter l'info de « journal » rendait la CLÉ DU JOURNAL",
  );
});

test("un domaine à USAGE UNIQUE ne se dérive pas sous le régime de sel d'un domaine à compteur", async () => {
  // La conséquence qui COMPTE, et c'est la symétrique de la précédente : `domaine: "volume"` admet
  // un sel VIDE. Sans recoupement, un appelant dérivait donc la clé d'`instantane` ou d'`archive`
  // SANS SEL — c'est-à-dire une clé CONSTANTE pour tous les artefacts d'un volume, exactement le
  // régime que la décision 4 de l'ADR 0033 refuse, par la garde qui prétendait l'interdire.
  const identifiantVolume = "0f1e2d3c4b5a69788796a5b4c3d2e1f0";
  for (const domaine of [DOMAINES.instantane, DOMAINES.archive]) {
    const info = encoderInfoDeDomaine({
      domaine,
      identifiantVolume,
      versionDeFormat: VERSIONS_DE_FORMAT_DE_DOMAINE[domaine],
    });
    await assert.rejects(
      () =>
        deriverCleDeDomaine({
          cleMaitresse: CLE_DE_TEST,
          domaine: DOMAINES.volume,
          sel: SEL_VIDE,
          info,
        }),
      `le domaine « ${domaine} » ne doit pas se dériver sous un sel vide`,
    );
  }
});
