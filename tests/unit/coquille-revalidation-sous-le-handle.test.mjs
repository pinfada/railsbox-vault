import assert from "node:assert/strict";
import test from "node:test";

import {
  enLectureSeule,
  memesOctets,
  revaliderSousLeHandle,
} from "../../src/coquille/revalidation-sous-le-handle.mjs";
import {
  HARNAIS_ALEAS_JETON,
  ajouterEmplacement,
  creerEnveloppe,
  ouvrirEnveloppe,
  revoquerToutSauf,
} from "../../src/vm/enveloppe-de-cle.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import {
  EMPLACEMENT_FORMAT_V1,
  ENVELOPPE_FORMAT_V1,
  ENVELOPPE_FORMAT_V2,
  TYPES_KEK,
} from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  TAILLE_FICHIER_ENVELOPPE,
  decoderPage,
  offsetDePage,
  PAGE_OCTETS,
} from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import {
  envelopperSousNonce,
  importerCleDeDeverrouillage,
} from "../../src/vm/enveloppe/modele-reference.mjs";
import {
  composerPageAlaMain,
  identifiantDeVolume,
  supportDouble,
  suiteDOctets,
} from "./support-enveloppe-double.mjs";

// LA REVALIDATION SOUS LE HANDLE, passe 2 du déverrouillage (#311, tranche C5 du lot C ; ADR 0020).
//
// Ce que ce fichier établit, sur le vrai code d'enveloppe et le double du support — la préuve
// navigateur est `tests/browser/coquille-course-entre-onglets.spec.mjs` :
//
//  1. la passe 1 est en LECTURE SEULE : aucun geste d'écriture, pas même la migration de page v1 ;
//  2. la passe 2 accepte une enveloppe inchangée et prend la version et la migration de CETTE passe ;
//  3. un emplacement RÉVOQUÉ entre les deux passes est refusé sous `VAULT_ENVELOPPE_CLE_REFUSEE`, par
//     le même parcours qu'une clé inconnue — même nombre d'appels AEAD ;
//  4. le MÊME emplacement ET la MÊME clé de volume sont exigés, chacun pour lui-même ;
//  5. l'ancre de version tient en passe 2 ;
//  6. la clé de volume de la passe 2 est effacée, refus compris ; un refus de l'enveloppe est relancé
//     tel quel et ne touche pas l'ouverture de la passe 1.

const VOLUME = identifiantDeVolume(0x0b);
const DEK = suiteDOctets(0x20, 32);
const AUTRE_DEK = suiteDOctets(0x60, 32);
const KEK_A = suiteDOctets(0x80, 32);
const KEK_B = suiteDOctets(0xa0, 32);
const KEK_INCONNUE = suiteDOctets(0xc0, 32);
const ID_A = "a1a1a1a1a1a1a1a1";
const ID_B = "b2b2b2b2b2b2b2b2";

const aleasId = (identifiant) => ({
  jeton: HARNAIS_ALEAS_JETON,
  tirerIdentifiant: () => identifiant,
});

/** Une enveloppe v2 à UN emplacement. */
async function enveloppe({ dek = DEK, kek = KEK_A, identifiant = ID_A } = {}) {
  const support = supportDouble();
  await creerEnveloppe({
    support,
    identifiantVolume: VOLUME,
    dek,
    kek,
    identifiantEmplacement: identifiant,
    aleas: aleasId(identifiant),
  });
  return support;
}

/** Ce que la passe 1 rend, tel que `deverrouiller` le range dans `ouverte`. */
async function passeUn(support, kek, versionMinimale = null) {
  const ouverte = await ouvrirEnveloppe({
    support: enLectureSeule(support),
    identifiantVolume: VOLUME,
    kek,
    versionMinimale,
  });
  return {
    dek: ouverte.dek,
    kek,
    version: ouverte.version,
    migree: ouverte.migration?.faite === true,
    identifiantEmplacement: ouverte.identifiantEmplacement,
    versionMinimale,
  };
}

const revalider = (support, ouverte, supplement = {}) =>
  revaliderSousLeHandle({ support, identifiantVolume: VOLUME, ouverte, ...supplement });

const refusee = (erreur) => erreur.code === ENVELOPPE_ERROR_CODES.cleRefusee;

/** Compte les appels à `SubtleCrypto.decrypt` pendant un geste, et restaure la primitive. */
async function compterLesDecrypt(geste) {
  const vrai = SubtleCrypto.prototype.decrypt;
  let appels = 0;
  SubtleCrypto.prototype.decrypt = function compter(...args) {
    appels += 1;
    return vrai.apply(this, args);
  };
  try {
    await geste();
  } finally {
    SubtleCrypto.prototype.decrypt = vrai;
  }
  return appels;
}

/** Une page **v1** à un emplacement, comme celles qu'aucun produit n'écrit plus. */
async function enveloppeV1() {
  const parametres = suiteDOctets(0xe0, 8);
  const scelle = await envelopperSousNonce({
    kek: await importerCleDeDeverrouillage(KEK_A),
    emplacement: {
      identifiantVolume: VOLUME,
      identifiantEmplacement: ID_A,
      formatVersion: EMPLACEMENT_FORMAT_V1,
      typeKek: TYPES_KEK.harnais,
      parametres,
    },
    dek: DEK,
    nonce: suiteDOctets(0x10, 12),
  });
  const page = await composerPageAlaMain({
    identifiantVolume: VOLUME,
    version: 7,
    dek: DEK,
    emplacements: [
      {
        identifiantEmplacement: ID_A,
        typeKek: TYPES_KEK.harnais,
        parametres,
        nonce: scelle.nonce,
        dekEnveloppee: scelle.chiffre,
        etiquette: scelle.etiquette,
      },
    ],
    nonce: suiteDOctets(0x99, 12),
    formatVersion: ENVELOPPE_FORMAT_V1,
  });
  const fichier = new Uint8Array(TAILLE_FICHIER_ENVELOPPE);
  fichier.set(page, 0);
  return supportDouble({ octets: fichier });
}

const formatsDesPages = (support) =>
  [0, 1].map((index) => {
    const lue = decoderPage(
      support.contenu.subarray(offsetDePage(index), offsetDePage(index) + PAGE_OCTETS),
    );
    return lue.valide ? `${lue.page.formatVersion}@${lue.page.version}` : null;
  });

test("une enveloppe INCHANGÉE est revalidée, et la version est celle de la passe 2", async () => {
  const support = await enveloppe();
  const ouverte = await passeUn(support, KEK_A);
  ouverte.version = -1; // la passe 2 fait autorité
  ouverte.migree = true;
  await revalider(support, ouverte);
  assert.equal(ouverte.version, 1);
  assert.equal(ouverte.migree, false);
  assert.ok(
    ouverte.dek.some((octet) => octet !== 0),
    "la clé de la passe 1 reste à l'appelant",
  );
});

test("la passe 1 est en LECTURE SEULE : aucune écriture, la migration v1 attend la passe 2", async () => {
  const support = await enveloppeV1();
  const avant = support.contenu;
  const ouverte = await passeUn(support, KEK_A);
  assert.equal(support.gestes, 0, "aucun geste d'écriture, d'allocation ni de barrière");
  assert.deepEqual(support.contenu, avant, "le fichier est octet pour octet celui d'avant");
  assert.equal(ouverte.migree, false, "la migration n'a pas eu lieu hors du handle");

  await revalider(support, ouverte);
  assert.equal(ouverte.migree, true, "la passe 2 migre, SOUS le handle");
  assert.equal(ouverte.version, 8);
  assert.deepEqual(
    formatsDesPages(support).filter((format) => format !== null),
    [`${ENVELOPPE_FORMAT_V1}@7`, `${ENVELOPPE_FORMAT_V2}@8`].sort(),
    "la page v2 est publiée sur la page libre, la v1 reste en repli",
  );
});

test("un emplacement RÉVOQUÉ entre les deux passes est refusé, comme une clé inconnue", async () => {
  const support = await enveloppe();
  await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: KEK_A,
    kekNouvelle: KEK_B,
    identifiantEmplacement: ID_B,
  });
  const ouverte = await passeUn(support, KEK_B);
  const avant = { version: ouverte.version, migree: ouverte.migree };
  // A révoque tout sauf lui-même, avant que B prenne le handle.
  await revoquerToutSauf({ support, identifiantVolume: VOLUME, kek: KEK_A });

  let erreur = null;
  const refusRevoque = await compterLesDecrypt(() =>
    revalider(support, ouverte).catch((cause) => {
      erreur = cause;
    }),
  );
  assert.ok(erreur !== null && refusee(erreur), "refusé sous VAULT_ENVELOPPE_CLE_REFUSEE");
  const refusInconnue = await compterLesDecrypt(() =>
    ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: KEK_INCONNUE }).catch(() => null),
  );
  assert.ok(refusInconnue > 0, "le compteur compte : un refus coûte des appels AEAD");
  assert.equal(
    refusRevoque,
    refusInconnue,
    "même nombre d'appels AEAD pour une clé révoquée et une clé inconnue (ADR 0020)",
  );
  assert.deepEqual({ version: ouverte.version, migree: ouverte.migree }, avant, "aucun effet");
});

test("la MÊME clé de volume est exigée : une enveloppe refaite sous la même clé est refusée", async () => {
  const ancienne = await enveloppe({ dek: DEK });
  const ouverte = await passeUn(ancienne, KEK_A);
  // Même KEK, même identifiant d'emplacement, une AUTRE clé de volume.
  const refaite = await enveloppe({ dek: AUTRE_DEK });
  await assert.rejects(revalider(refaite, ouverte), refusee);
});

test("le MÊME emplacement est exigé : la même clé de volume sous un autre emplacement est refusée", async () => {
  const ancienne = await enveloppe({ identifiant: ID_A });
  const ouverte = await passeUn(ancienne, KEK_A);
  // Même KEK, même clé de volume, un AUTRE emplacement.
  const refaite = await enveloppe({ identifiant: ID_B });
  await assert.rejects(revalider(refaite, ouverte), refusee);
});

test("l'ancre de version tient aussi en passe 2", async () => {
  const support = await enveloppe();
  const ouverte = await passeUn(support, KEK_A);
  ouverte.versionMinimale = 9; // la page est à la version 1 : un retour en arrière
  await assert.rejects(revalider(support, ouverte), (erreur) => erreur.code !== undefined);
});

test("la clé de volume de la passe 2 est effacée, au succès comme au refus", async () => {
  const support = await enveloppe();
  const ouverte = await passeUn(support, KEK_A);
  const rendue = [];
  const ouvrir = async (appel) => {
    const vraie = await ouvrirEnveloppe(appel);
    rendue.push(vraie.dek);
    return vraie;
  };
  await revalider(support, ouverte, { ouvrir });
  assert.ok(
    rendue[0].every((octet) => octet === 0),
    "effacée après un succès",
  );

  const autre = await enveloppe({ identifiant: ID_B });
  await assert.rejects(revalider(autre, ouverte, { ouvrir }), refusee);
  assert.ok(
    rendue[1].every((octet) => octet === 0),
    "effacée aussi quand la comparaison refuse",
  );
});

test("un refus de l'enveloppe est relancé tel quel, sans toucher la passe 1", async () => {
  const support = await enveloppe();
  const ouverte = await passeUn(support, KEK_A);
  const avant = { ...ouverte, dek: Uint8Array.from(ouverte.dek) };
  const refus = Object.assign(new Error("support perdu"), { code: "VAULT_STORAGE_HANDLE_LOST" });
  await assert.rejects(
    revalider(support, ouverte, {
      ouvrir: async () => {
        throw refus;
      },
    }),
    (erreur) => erreur === refus,
  );
  assert.deepEqual(ouverte, avant);
});

test("memesOctets : longueur, égalité, et l'écart du DERNIER octet", () => {
  assert.equal(memesOctets(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 3)), true);
  assert.equal(memesOctets(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2, 4)), false);
  assert.equal(memesOctets(Uint8Array.of(1, 2, 3), Uint8Array.of(1, 2)), false);
  assert.equal(memesOctets(Uint8Array.of(1, 2), Uint8Array.of(1, 2, 0)), false);
});
