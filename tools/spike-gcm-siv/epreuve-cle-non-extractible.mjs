/**
 * Ce que la voie composée CONSERVE : la clé de domaine ne sort jamais de `CryptoKey`.
 *
 *     node tools/spike-gcm-siv/epreuve-cle-non-extractible.mjs
 *
 * La première rédaction de ce spike écrivait que « tout AEAD hors WebCrypto exige les octets bruts
 * de la clé ». La revue de la PR #202 l'a réfuté par exécution, et cette épreuve est sa forme
 * exécutable : elle refait la chaîne du produit — DEK importée en matériau HKDF avec le seul usage
 * `deriveKey`, puis `deriveKey` vers une clé **AES-CTR non extractible** — et scelle sous
 * AES-GCM-SIV avec `gcm-siv-webcrypto.mjs`, sans que les octets de la clé de domaine existent
 * jamais côté JavaScript.
 *
 * Ce que cela établit, et ce que cela n'établit pas : le garanti de plate-forme de l'ADR 0033
 * décision 6 et de l'ADR 0036 décision 5 survit à la voie COMPOSÉE ; il ne survit pas à une
 * implémentation logicielle complète — POLYVAL **et** AES en JavaScript ou en WebAssembly —, qui
 * exige les octets, elle. Ce qui existe en octets ici est la clé de chiffrement PAR MESSAGE que la
 * RFC 8452 § 4 impose de dériver à chaque nonce : éphémère, et jamais la clé de domaine.
 *
 * Aucun code de produit : l'épreuve importe la dérivation du produit en LECTURE pour montrer que la
 * forme de clé qu'il produit convient, et n'en change rien.
 */

import {
  deriverCleDeDomaine,
  encoderInfoDeDomaine,
  importerMateriauMaitre,
  selDuDomaine,
} from "../../src/vm/derivation/cle-de-domaine.mjs";

import * as compose from "./gcm-siv-webcrypto.mjs";
import { versHex } from "./octets.mjs";

const constats = [];

function exiger(nom, condition, detail) {
  constats.push({ nom, verdict: condition ? "ok" : "ÉCHEC", detail });
  if (!condition) process.exitCode = 1;
}

const dek = crypto.getRandomValues(new Uint8Array(32));

// 1. La DEK telle que le produit la tient : matériau HKDF, `deriveKey` seul.
const materiau = await importerMateriauMaitre(dek);
exiger(
  "la DEK est un matériau HKDF, et rien d'autre",
  materiau.algorithm.name === "HKDF" &&
    materiau.extractable === false &&
    materiau.usages.length === 1 &&
    materiau.usages[0] === "deriveKey",
  `algorithme ${materiau.algorithm.name}, extractable ${materiau.extractable}, usages ${JSON.stringify(materiau.usages)}`,
);

// 2. Ce que le produit dérive aujourd'hui : une clé AES-GCM non extractible. `deriveKey` sait aussi
//    rendre une clé AES-CTR, qui est la forme dont la voie composée a besoin — même appel, même
//    info, même sel, un seul argument de type qui change.
const info = encoderInfoDeDomaine({
  domaine: "volume",
  identifiantVolume: "0123456789abcdef0123456789abcdef",
  versionDeFormat: 4,
});
const cleAesGcm = await deriverCleDeDomaine({
  cleMaitresse: materiau,
  domaine: "volume",
  sel: selDuDomaine("volume"),
  info,
});
exiger(
  "la clé de domaine du produit est une AES-GCM non extractible",
  cleAesGcm.algorithm.name === "AES-GCM" && cleAesGcm.extractable === false,
  `algorithme ${cleAesGcm.algorithm.name}, extractable ${cleAesGcm.extractable}`,
);

// 3. La MÊME dérivation, vers une clé AES-CTR non extractible. Elle est écrite ici et non dans le
//    produit : ce spike ne livre aucun code de produit.
const cleAesCtr = await crypto.subtle.deriveKey(
  {
    name: "HKDF",
    hash: "SHA-256",
    salt: selDuDomaine("volume"),
    info,
  },
  materiau,
  { name: "AES-CTR", length: 256 },
  false,
  ["encrypt"],
);
exiger(
  "deriveKey rend une clé AES-CTR NON extractible",
  cleAesCtr.algorithm.name === "AES-CTR" &&
    cleAesCtr.extractable === false &&
    cleAesCtr.usages.join() === "encrypt",
  `algorithme ${cleAesCtr.algorithm.name}, extractable ${cleAesCtr.extractable}, usages ${JSON.stringify(cleAesCtr.usages)}`,
);

// 4. Ses octets sont hors d'atteinte : la plate-forme refuse de les rendre.
let refusDExport = null;
try {
  await crypto.subtle.exportKey("raw", cleAesCtr);
} catch (erreur) {
  refusDExport = `${erreur.name} : ${erreur.message}`;
}
exiger(
  "exportKey sur la clé de domaine est REFUSÉ",
  refusDExport !== null,
  refusDExport ?? "ACCEPTÉ",
);

// 5. Et AES-GCM-SIV scelle dessus, aller-retour.
const nonce = crypto.getRandomValues(new Uint8Array(12));
const clair = crypto.getRandomValues(new Uint8Array(512));
const donneesAssociees = crypto.getRandomValues(new Uint8Array(118));
const preparee = await compose.preparerCleMaitresse(cleAesCtr, 32);
const scelle = await compose.sceller(preparee, nonce, clair, donneesAssociees);
const rouvert = await compose.ouvrir(preparee, nonce, scelle, donneesAssociees);
exiger(
  "AES-GCM-SIV scelle et rouvre sous cette CryptoKey",
  versHex(rouvert) === versHex(clair) && scelle.length === clair.length + 16,
  `${scelle.length} octets scellés, clair restitué à l'identique`,
);

for (const { nom, verdict, detail } of constats) {
  console.log(`${verdict === "ok" ? "✓" : "✗"} ${nom.padEnd(56)} ${detail}`);
}
console.log(
  `${constats.filter((c) => c.verdict === "ok").length}/${constats.length} constats — la voie composée conserve le garanti de plate-forme`,
);
