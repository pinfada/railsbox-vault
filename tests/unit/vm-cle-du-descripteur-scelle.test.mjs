/**
 * La CLÉ de scellement du descripteur rangé (#247, D1g ; ADR 0045) : HKDF-SHA-256 sous la clé du
 * coffre, dans un domaine dédié, rendue en HMAC-SHA-256 NON EXTRACTIBLE.
 *
 * Le vecteur est calculé par `node:crypto`, avec une info écrite à la main : le module n'est pas
 * jugé par sa propre transcription.
 */

import assert from "node:assert/strict";
import { createHmac, hkdfSync } from "node:crypto";
import test from "node:test";

import {
  DOMAINE_DU_DESCRIPTEUR,
  VERSION_DE_FORMAT_DU_DESCRIPTEUR,
  deriverCleDeScellementDuDescripteur,
  encoderInfoDuDescripteur,
} from "../../src/vm/derivation/cle-du-descripteur-scelle.mjs";
import {
  DOMAINES,
  deriverCleDeDomaine,
  encoderInfoDeDomaine,
  SEL_VIDE,
} from "../../src/vm/derivation/cle-de-domaine.mjs";

const IDENTIFIANT = "00112233445566778899aabbccddeeff";
const DEK = Uint8Array.from({ length: 32 }, (_, i) => i + 1);
const AUTRE_DEK = Uint8Array.from({ length: 32 }, (_, i) => 200 - i);

const lp = (texte) => {
  const octets = new TextEncoder().encode(texte);
  return Buffer.concat([Buffer.from([octets.length >> 8, octets.length & 0xff]), octets]);
};

/** L'info, écrite à la main : étiquette, domaine, identifiant, version U32BE, algorithme. */
function infoAttendue(version = 1) {
  const u32 = Buffer.alloc(4);
  u32.writeUInt32BE(version);
  return Buffer.concat([
    lp("railsbox-vault/derivation-de-domaine/v1"),
    lp("descripteur"),
    lp(IDENTIFIANT),
    u32,
    lp("hmac-sha-256"),
  ]);
}

const sceau = async (cle, donnees) =>
  Buffer.from(await crypto.subtle.sign("HMAC", cle, donnees)).toString("hex");

test("l'info du domaine « descripteur » est celle de l'ADR 0033, champ par champ", () => {
  const info = encoderInfoDuDescripteur({ identifiantVolume: IDENTIFIANT });
  assert.equal(DOMAINE_DU_DESCRIPTEUR, "descripteur");
  assert.equal(VERSION_DE_FORMAT_DU_DESCRIPTEUR, 1);
  assert.deepEqual(Buffer.from(info), infoAttendue());
});

test("la clé dérivée est celle que HKDF-SHA-256 de node:crypto donne, sel vide", async () => {
  const cle = await deriverCleDeScellementDuDescripteur({
    cleMaitresse: DEK,
    identifiantVolume: IDENTIFIANT,
  });
  const attendue = Buffer.from(hkdfSync("sha256", DEK, Buffer.alloc(0), infoAttendue(), 32));
  const donnees = Buffer.from("un descripteur");
  assert.equal(
    await sceau(cle, donnees),
    createHmac("sha256", attendue).update(donnees).digest("hex"),
  );
});

test("la clé est un HMAC SHA-256 non extractible, signer et vérifier seulement", async () => {
  const cle = await deriverCleDeScellementDuDescripteur({
    cleMaitresse: DEK,
    identifiantVolume: IDENTIFIANT,
  });
  assert.equal(cle.algorithm.name, "HMAC");
  assert.equal(cle.algorithm.hash.name, "SHA-256");
  assert.equal(cle.extractable, false);
  assert.deepEqual([...cle.usages].sort(), ["sign", "verify"]);
  await assert.rejects(crypto.subtle.exportKey("raw", cle));
});

test("une autre clé de coffre, un autre identifiant, une autre version : une autre clé", async () => {
  const donnees = Buffer.from("même charge");
  const base = await sceau(
    await deriverCleDeScellementDuDescripteur({
      cleMaitresse: DEK,
      identifiantVolume: IDENTIFIANT,
    }),
    donnees,
  );
  const autreCoffre = await sceau(
    await deriverCleDeScellementDuDescripteur({
      cleMaitresse: AUTRE_DEK,
      identifiantVolume: IDENTIFIANT,
    }),
    donnees,
  );
  const autreIdentifiant = await sceau(
    await deriverCleDeScellementDuDescripteur({
      cleMaitresse: DEK,
      identifiantVolume: "ff".repeat(16),
    }),
    donnees,
  );
  assert.notEqual(autreCoffre, base);
  assert.notEqual(autreIdentifiant, base);
  assert.notDeepEqual(
    Buffer.from(encoderInfoDuDescripteur({ identifiantVolume: IDENTIFIANT, versionDeFormat: 2 })),
    Buffer.from(encoderInfoDuDescripteur({ identifiantVolume: IDENTIFIANT })),
  );
});

test("séparation : l'info du descripteur n'est celle d'aucun des six domaines AEAD", () => {
  const info = Buffer.from(encoderInfoDuDescripteur({ identifiantVolume: IDENTIFIANT }));
  for (const domaine of Object.values(DOMAINES)) {
    const autre = Buffer.from(
      encoderInfoDeDomaine({ domaine, identifiantVolume: IDENTIFIANT, versionDeFormat: 1 }),
    );
    assert.notDeepEqual(info, autre, domaine);
  }
  assert.ok(
    !Object.values(DOMAINES).includes(DOMAINE_DU_DESCRIPTEUR),
    "hors de la liste AEAD close",
  );
});

test("séparation : la clé AEAD du domaine volume n'est pas la clé HMAC du descripteur", async () => {
  const aead = await deriverCleDeDomaine({
    cleMaitresse: DEK,
    domaine: DOMAINES.volume,
    sel: SEL_VIDE,
    info: encoderInfoDeDomaine({
      domaine: DOMAINES.volume,
      identifiantVolume: IDENTIFIANT,
      versionDeFormat: 1,
    }),
  });
  assert.equal(aead.algorithm.name, "AES-GCM");
});

test("la clé accepte le matériau HKDF déjà importé, et refuse une clé AES-GCM ou une largeur fausse", async () => {
  const materiau = await crypto.subtle.importKey("raw", DEK, "HKDF", false, ["deriveKey"]);
  const cle = await deriverCleDeScellementDuDescripteur({
    cleMaitresse: materiau,
    identifiantVolume: IDENTIFIANT,
  });
  assert.equal(cle.algorithm.name, "HMAC");
  const aes = await crypto.subtle.importKey("raw", DEK, "AES-GCM", false, ["encrypt"]);
  await assert.rejects(
    deriverCleDeScellementDuDescripteur({ cleMaitresse: aes, identifiantVolume: IDENTIFIANT }),
    { code: "VAULT_DERIVATION_PARAMETRES_REFUSES" },
  );
  await assert.rejects(
    deriverCleDeScellementDuDescripteur({
      cleMaitresse: new Uint8Array(16),
      identifiantVolume: IDENTIFIANT,
    }),
    { code: "VAULT_DERIVATION_PARAMETRES_REFUSES" },
  );
  await assert.rejects(
    deriverCleDeScellementDuDescripteur({ cleMaitresse: DEK, identifiantVolume: "pas-un-id" }),
    { code: "VAULT_DERIVATION_PARAMETRES_REFUSES" },
  );
});
