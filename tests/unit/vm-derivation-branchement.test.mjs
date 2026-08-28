/**
 * Le BRANCHEMENT : la couche d'ouverture accepte un DÉRIVATEUR à la place d'une KEK (#22, ADR 0021).
 *
 * Point 4 du contrat de #22, et il tient en quatre propriétés qu'on peut manquer séparément :
 *
 *  1. **un dérivateur ouvre un volume** — la couche lit le manifeste, retient l'identifiant de
 *    volume, lit l'inventaire PUBLIC de l'enveloppe (type et paramètres, sans clé), dérive, et
 *    seulement alors passe la clé de volume à l'ouvreur unique, INCHANGÉ ;
 *  2. **un geste faux ne devient jamais un refus du dérivateur** — c'est l'enveloppe qui tranche,
 *    par `VAULT_ENVELOPPE_CLE_REFUSEE`, et l'ouvreur n'est pas appelé ;
 *  3. **un type inconnu est refusé, et le fichier n'est PAS modifié** — l'empreinte du fichier
 *    d'enveloppes avant et après le refus est la même, octet pour octet ;
 *  4. **le chemin harnais est intact** — un emplacement `harnais` s'ouvre encore sous une KEK brute,
 *    exactement comme #21 le livrait.
 *
 * Aucune ligne de `opfs-volume-ouverture.mjs` ni de `opfs-volume-open.mjs` n'est touchée : l'ouvreur
 * est appelé par un double, et l'épreuve vérifie CE QU'IL REÇOIT.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DERIVATION_ERROR_CODES,
  isDerivationError,
} from "../../src/vm/derivation/derivation-errors.mjs";
import { catalogueDeDerivateurs } from "../../src/vm/derivation/derivateurs.mjs";
import { preparerEmplacementDerive } from "../../src/vm/derivation/emplacement-derive.mjs";
import { ajouterEmplacement, creerEnveloppe } from "../../src/vm/enveloppe-de-cle.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import {
  ouvrirVolumeParDerivateur,
  ouvrirVolumeParKek,
} from "../../src/vm/ouverture-par-enveloppe.mjs";
import { createManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";
import { identifiantDeVolume, supportDouble, suiteDOctets } from "./support-enveloppe-double.mjs";

const VOLUME = identifiantDeVolume(0x30);
const NOM = "volume-de-branchement";
const TAILLE = 8 * 512;
const ATTENTES = { app: { id: "railsbox-vault-reference" }, runtime: { version: "0.1.0" } };

/** Manifeste voisin du volume : la SEULE source de l'identifiant que l'enveloppe doit confirmer. */
const MANIFESTE = serializeManifest(
  createManifest({
    runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
    app: { id: "railsbox-vault-reference", version: "1.0.0" },
    volumeSize: TAILLE,
    identity: { algorithm: "sha-256", digest: null },
    volume: { id: VOLUME, algorithm: "aes-256-gcm" },
  }),
);

/** Les primitives de fichier que la couche emprunte, servies en mémoire. */
const PRIMITIVES = Object.freeze({
  stat: async () => ({ present: true, size: MANIFESTE.byteLength }),
  readFile: async (_nom, taille) => MANIFESTE.subarray(0, taille),
  expectations: ATTENTES,
});

/**
 * DÉRIVATEUR d'épreuve : il rend une KEK déterministe à partir du geste et de l'identité de
 * l'emplacement, sans Argon2 ni WebAuthn.
 *
 * Ce n'est pas un raccourci : ce fichier mesure le BRANCHEMENT, et les deux vrais dérivateurs sont
 * mesurés chez eux. Un dérivateur d'épreuve qui paierait 64 Mio par appel ferait porter à cette
 * suite le prix d'une propriété qu'elle ne mesure pas.
 */
function derivateurDEpreuve(type, { attendu = "ouvre-toi" } = {}) {
  const appels = [];
  return {
    type,
    appels,
    deriver: async ({ parametres, identite, geste }) => {
      appels.push({ parametres: octetsEnHex(parametres), identite, geste });
      const materiau = new TextEncoder().encode(
        `${identite.identifiantVolume}|${identite.identifiantEmplacement}`,
      );
      const base = new Uint8Array(await crypto.subtle.digest("SHA-256", materiau));
      // Un geste faux rend une AUTRE clé, jamais un refus : c'est l'enveloppe qui tranche, et
      // c'est exactement la propriété que l'épreuve suivante mesure.
      if (geste?.mot !== attendu) base[0] ^= 0xff;
      return crypto.subtle.importKey("raw", base, { name: "AES-GCM" }, false, [
        "encrypt",
        "decrypt",
      ]);
    },
  };
}

/** Pose une enveloppe portant UN emplacement du type du dérivateur, et rend son support. */
async function enveloppePosee(derivateur, geste) {
  const support = supportDouble();
  const dek = suiteDOctets(0x40, 32);
  const prepare = await preparerEmplacementDerive({
    identifiantVolume: VOLUME,
    derivateur,
    parametres: suiteDOctets(0x11, 24),
    geste,
  });
  await creerEnveloppe({
    support,
    identifiantVolume: VOLUME,
    dek,
    kek: prepare.kek,
    typeKek: derivateur.type,
    parametres: prepare.parametres,
    identifiantEmplacement: prepare.identifiantEmplacement,
  });
  return { support, dek };
}

/** Les octets du fichier d'enveloppes, pour comparer un avant et un après à l'octet près. */
async function octetsDuFichier(support) {
  const etat = await support.etat();
  return octetsEnHex(await support.lire(0, etat.taille));
}

test("un dérivateur ouvre le volume : l'ouvreur unique reçoit la clé développée, et rien d'autre", async () => {
  const derivateur = derivateurDEpreuve(TYPES_KEK.phrase);
  const { support, dek } = await enveloppePosee(derivateur, { mot: "ouvre-toi" });
  const recu = [];

  const backend = await ouvrirVolumeParDerivateur({
    name: NOM,
    derivateur,
    geste: { mot: "ouvre-toi" },
    support,
    ...PRIMITIVES,
    openVolume: async (appel) => {
      recu.push({ name: appel.name, cle: octetsEnHex(appel.cle) });
      return { ferme: true };
    },
  });

  assert.deepEqual(backend, { ferme: true });
  assert.equal(recu.length, 1);
  assert.equal(recu[0].name, NOM);
  assert.equal(recu[0].cle, octetsEnHex(dek), "l'ouvreur n'a pas reçu la clé de volume enveloppée");
  assert.equal(derivateur.appels.length, 2, "une préparation et un déverrouillage, pas davantage");
  assert.equal(
    derivateur.appels[1].identite.identifiantVolume,
    VOLUME,
    "l'identité dérivée doit venir du MANIFESTE, jamais de l'enveloppe elle-même",
  );
});

test("un geste faux rend VAULT_ENVELOPPE_CLE_REFUSEE, et l'ouvreur n'est jamais appelé", async () => {
  const derivateur = derivateurDEpreuve(TYPES_KEK.phrase);
  const { support } = await enveloppePosee(derivateur, { mot: "ouvre-toi" });
  let appele = false;

  await assert.rejects(
    () =>
      ouvrirVolumeParDerivateur({
        name: NOM,
        derivateur,
        geste: { mot: "sésame" },
        support,
        ...PRIMITIVES,
        openVolume: async () => {
          appele = true;
          return {};
        },
      }),
    (erreur) => erreur.code === "VAULT_ENVELOPPE_CLE_REFUSEE",
  );
  assert.equal(appele, false, "l'ouvreur a été appelé alors qu'aucune clé n'était développée");
});

test("un type d'emplacement INCONNU du catalogue est refusé, et le fichier n'est pas modifié", async () => {
  const pose = derivateurDEpreuve(TYPES_KEK["webauthn-prf"]);
  const { support } = await enveloppePosee(pose, { mot: "ouvre-toi" });
  const avant = await octetsDuFichier(support);

  // Le catalogue ne connaît que la phrase : l'emplacement présent lui est étranger.
  const catalogue = catalogueDeDerivateurs({
    [TYPES_KEK.phrase]: derivateurDEpreuve(TYPES_KEK.phrase),
  });

  await assert.rejects(
    () =>
      ouvrirVolumeParDerivateur({
        name: NOM,
        catalogue,
        geste: { mot: "ouvre-toi" },
        support,
        ...PRIMITIVES,
        openVolume: async () => ({}),
      }),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.typeInconnu),
  );
  assert.equal(await octetsDuFichier(support), avant, "le fichier d'enveloppes a été modifié");
});

test("le catalogue refuse un type qu'il ne sert pas, et sert celui qu'il connaît (témoin)", () => {
  const phrase = derivateurDEpreuve(TYPES_KEK.phrase);
  const catalogue = catalogueDeDerivateurs({ [TYPES_KEK.phrase]: phrase });
  assert.equal(catalogue.pour(TYPES_KEK.phrase), phrase);
  for (const inconnu of [0, TYPES_KEK.harnais, TYPES_KEK["webauthn-prf"], 42]) {
    assert.throws(
      () => catalogue.pour(inconnu),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.typeInconnu),
      `le type ${inconnu} aurait dû être refusé`,
    );
  }
});

test("un identifiant d'emplacement DÉJÀ pris est refusé : deux noms égaux, deux secrets", async () => {
  // Ajoutée par la campagne de mutation. L'amendement de #22 — un identifiant d'emplacement peut
  // être FOURNI — ouvre une porte que le tirage de #21 fermait tout seul : deux emplacements de même
  // nom rendraient `revoquerEmplacement` ambigu et feraient authentifier par la racine une liste
  // dont deux éléments prétendent au même identifiant.
  const derivateur = derivateurDEpreuve(TYPES_KEK.phrase);
  const support = supportDouble();
  const dek = suiteDOctets(0x40, 32);
  const kek = suiteDOctets(0x80, 32);
  const prepare = await preparerEmplacementDerive({
    identifiantVolume: VOLUME,
    derivateur,
    parametres: suiteDOctets(0x11, 24),
    geste: { mot: "ouvre-toi" },
  });
  await creerEnveloppe({
    support,
    identifiantVolume: VOLUME,
    dek,
    kek,
    typeKek: derivateur.type,
    parametres: prepare.parametres,
    identifiantEmplacement: prepare.identifiantEmplacement,
  });

  await assert.rejects(
    () =>
      ajouterEmplacement({
        support,
        identifiantVolume: VOLUME,
        kek,
        kekNouvelle: suiteDOctets(0xa0, 32),
        identifiantEmplacement: prepare.identifiantEmplacement,
      }),
    (erreur) => erreur.code === "VAULT_ENVELOPPE_MALFORME",
  );
  // Témoin : un identifiant LIBRE passe, sur la même enveloppe et la même clé.
  const ajoutee = await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek,
    kekNouvelle: suiteDOctets(0xa0, 32),
    identifiantEmplacement: "0102030405060708",
  });
  assert.equal(ajoutee.nombreEmplacements, 2);
});

test("une CryptoKey qui n'est pas une clé de déverrouillage est refusée, pas essayée", async () => {
  // Ajoutée par la campagne de mutation. Une clé d'un autre algorithme échouerait de toute façon au
  // premier appel de WebCrypto — mais AILLEURS, avec un message de moteur, là où le format doit
  // rendre son propre refus. Le témoin positif est toutes les autres épreuves de ce fichier, qui
  // passent des KEK dérivées légitimes.
  const support = supportDouble();
  const mauvaise = await crypto.subtle.generateKey({ name: "AES-CTR", length: 256 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await assert.rejects(
    () =>
      creerEnveloppe({
        support,
        identifiantVolume: VOLUME,
        dek: suiteDOctets(0x40, 32),
        kek: mauvaise,
      }),
    (erreur) => erreur.code === "VAULT_ENVELOPPE_MALFORME",
  );

  const trop_courte = await crypto.subtle.generateKey({ name: "AES-GCM", length: 128 }, false, [
    "encrypt",
    "decrypt",
  ]);
  await assert.rejects(
    () =>
      creerEnveloppe({
        support,
        identifiantVolume: VOLUME,
        dek: suiteDOctets(0x40, 32),
        kek: trop_courte,
      }),
    (erreur) => erreur.code === "VAULT_ENVELOPPE_MALFORME",
  );
});

test("le chemin HARNAIS de #21 est inchangé : une KEK brute ouvre toujours", async () => {
  const support = supportDouble();
  const dek = suiteDOctets(0x50, 32);
  const kek = suiteDOctets(0x80, 32);
  await creerEnveloppe({ support, identifiantVolume: VOLUME, dek, kek });

  let recue = null;
  await ouvrirVolumeParKek({
    name: NOM,
    kek,
    support,
    ...PRIMITIVES,
    openVolume: async (appel) => {
      recue = octetsEnHex(appel.cle);
      return {};
    },
  });
  assert.equal(recue, octetsEnHex(dek));
});
