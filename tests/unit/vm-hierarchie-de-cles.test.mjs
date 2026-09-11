import assert from "node:assert/strict";
import test from "node:test";

import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import {
  DOMAINES,
  REGIMES_DE_DOMAINE,
  SEL_DE_DOMAINE_OCTETS,
  deriverCleDeDomaine,
  encoderInfoDeDomaine,
  importerMateriauMaitre,
  selDuDomaine,
} from "../../src/vm/derivation/cle-de-domaine.mjs";
import { hierarchieDeVolume } from "../../src/vm/derivation/hierarchie-de-volume.mjs";
import {
  importerCleDeVolume,
  ouvrirBloc,
  scellerBlocSousNonce,
} from "../../src/vm/format-chiffre/modele-reference.mjs";
import { FORMAT_VOLUME_V4 } from "../../src/vm/volume-chiffre-format.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { CRYPTO_ERROR_CODES, isCryptoError } from "../../src/vm/format-chiffre/crypto-errors.mjs";

// L'ÉPREUVE ROUGE de la revue externe du 10 septembre 2026, et ce qu'elle mesure (#182, ADR 0033).
//
// Le relecteur n'a pas argumenté : il a exécuté, et il a publié une ligne de JSON.
//
//     { "memeCle": true, "compteurVolumeA": 1, "compteurVolumeB": 1, "sommeReelle": 2 }
//
// Deux volumes — la coquille et l'application (ADR 0030) — partagent la DEK. Chacun tient son propre
// compteur de scellements, chacun compte 1, et la somme des invocations sous la CLÉ vaut 2. Le § 4.5
// affirmait compter « toutes les invocations sous une clé », ce qu'exige le § 8.3 de NIST SP 800-38D ;
// il comptait en réalité par instance de `Scellement`. La borne de 2^-35 publiée par la
// spécification était calculée pour 2^31 invocations sous UNE clé, et rien ne bornait le nombre réel.
//
// Ce fichier mesure les deux moitiés de la réparation de l'ADR 0033 :
//
//  1. **le constat**, tel qu'il était — sous la clé de volume de la v3, deux volumes distincts
//     emploient LITTÉRALEMENT la même clé AES, et l'épreuve le montre en ouvrant sous l'une ce qui a
//     été scellé sous l'autre, à données associées IDENTIQUES ;
//  2. **ce que la v4 en fait** — deux volumes, même DEK, deux clés de domaine distinctes : le même
//     chiffré, sous les mêmes données associées, ne s'ouvre plus. Chaque compteur est alors celui de
//     SA clé, et « 1 » est exhaustif au lieu d'être une moitié.
//
// Il ne prouve pas que les compteurs ne reculent pas : ils vivent toujours dans la racine (§ 9.1,
// #144), et l'ADR 0033 le range dans « fait, mais non garanti ».

const VOLUME_A = "00000000000000000000000000000a0a";
const VOLUME_B = "00000000000000000000000000000b0b";

/** Des données associées IDENTIQUES pour les deux volumes : seule la CLÉ peut alors les séparer. */
const IDENTITE_COMMUNE = Object.freeze({
  volume: VOLUME_A,
  formatVersion: FORMAT_VOLUME_V4,
  generation: 7,
  rang: 0,
  adresse: 4096,
  longueur: 512,
});

const NONCE = Uint8Array.from({ length: 12 }, (_, index) => index + 1);
const CLAIR = Uint8Array.from({ length: 512 }, (_, index) => (index * 7) % 251);

/** Scelle le même clair, sous le même nonce et les mêmes données associées, sous la clé fournie. */
function scellerLeTemoin(cle) {
  return scellerBlocSousNonce({
    cle,
    identite: IDENTITE_COMMUNE,
    contenu: CLAIR,
    nonce: NONCE,
    attentes: { scellementsCumules: 0 },
  });
}

test("le constat du relecteur : sous la v3, deux volumes emploient LITTÉRALEMENT la même clé", async () => {
  // La clé de volume de la v3 EST la DEK : deux volumes qui la partagent n'ont qu'une clé pour deux.
  const cleDuVolumeA = await importerCleDeVolume(CLE_DE_TEST);
  const cleDuVolumeB = await importerCleDeVolume(CLE_DE_TEST);

  const scelle = await scellerLeTemoin(cleDuVolumeA);
  const relu = await ouvrirBloc({
    cle: cleDuVolumeB,
    identite: IDENTITE_COMMUNE,
    scelle,
    attentes: { generationMinimale: null },
  });

  assert.deepEqual(
    relu,
    CLAIR,
    "ce que le volume A a scellé s'ouvre sous la clé du volume B : c'est une seule clé, et la somme des deux compteurs est le nombre réel d'invocations sous elle",
  );
});

test("la v4 sépare les clés : la même DEK, deux volumes, et le témoin ne traverse plus", async () => {
  const a = await hierarchieDeVolume({
    cleMaitresse: CLE_DE_TEST,
    identifiantVolume: VOLUME_A,
    formatVersion: FORMAT_VOLUME_V4,
  });
  const b = await hierarchieDeVolume({
    cleMaitresse: CLE_DE_TEST,
    identifiantVolume: VOLUME_B,
    formatVersion: FORMAT_VOLUME_V4,
  });

  const scelle = await scellerLeTemoin(a.cleVolume);
  await assert.rejects(
    () =>
      ouvrirBloc({
        cle: b.cleVolume,
        identite: IDENTITE_COMMUNE,
        scelle,
        attentes: { generationMinimale: null },
      }),
    (cause) => isCryptoError(cause, CRYPTO_ERROR_CODES.sealRejected),
    "deux volumes sous la même DEK ne partagent plus aucune clé de domaine",
  );

  // Et le volume A se relit sous SA clé : la séparation n'est pas une panne déguisée.
  const relu = await ouvrirBloc({
    cle: a.cleVolume,
    identite: IDENTITE_COMMUNE,
    scelle,
    attentes: { generationMinimale: null },
  });
  assert.deepEqual(relu, CLAIR);
});

test("le domaine `volume` et le domaine `journal` d'un MÊME volume ne partagent pas non plus leur clé", async () => {
  const { cleVolume, cleJournal } = await hierarchieDeVolume({
    cleMaitresse: CLE_DE_TEST,
    identifiantVolume: VOLUME_A,
    formatVersion: FORMAT_VOLUME_V4,
  });
  const scelle = await scellerLeTemoin(cleVolume);
  await assert.rejects(
    () =>
      ouvrirBloc({
        cle: cleJournal,
        identite: IDENTITE_COMMUNE,
        scelle,
        attentes: { generationMinimale: null },
      }),
    (cause) => isCryptoError(cause, CRYPTO_ERROR_CODES.sealRejected),
  );
});

test("deux compteurs à 1, et chacun est celui de SA clé : la somme réelle n'est plus 2", async () => {
  const a = await Scellement.ouvrir({
    volume: VOLUME_A,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V4,
  });
  const b = await Scellement.ouvrir({
    volume: VOLUME_B,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V4,
  });

  const identite = { generation: 1, rang: 0, adresse: 0, longueur: 512 };
  const scelleParA = await a.scellerBloc(identite, CLAIR);
  await b.scellerBloc(identite, CLAIR);

  assert.equal(a.scellementsCumulesVolume, 1);
  assert.equal(b.scellementsCumulesVolume, 1);

  // Ce que ces deux « 1 » valent désormais : le chiffré de A ne s'ouvre pas sous la clé de B, donc
  // rien d'autre que A n'a consommé le budget de la clé de A. « 1 » est exhaustif.
  await assert.rejects(
    () => b.ouvrirBloc(identite, scelleParA),
    (cause) => isStorageError(cause, STORAGE_ERROR_CODES.sceauRefuse),
  );
});

test("les deux compteurs d'un volume sont DISTINCTS : un dépôt au journal ne consomme pas le budget du volume", async () => {
  const scellement = await Scellement.ouvrir({
    volume: VOLUME_A,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V4,
  });
  const identite = { generation: 1, rang: 0, adresse: 0, longueur: 512 };

  await scellement.scellerBloc(identite, CLAIR);
  assert.equal(scellement.scellementsCumulesVolume, 1);
  assert.equal(scellement.scellementsCumulesJournal, 0);

  await scellement.scellerEnregistrement(identite, CLAIR);
  assert.equal(scellement.scellementsCumulesVolume, 1);
  assert.equal(scellement.scellementsCumulesJournal, 1);
});

test("le régime de sel suit le domaine : vide pour les domaines à compteur, tiré pour les autres", async () => {
  assert.equal(REGIMES_DE_DOMAINE[DOMAINES.volume], "compteur");
  assert.equal(REGIMES_DE_DOMAINE[DOMAINES.journal], "compteur");
  assert.equal(REGIMES_DE_DOMAINE[DOMAINES.instantane], "usage-unique");
  assert.equal(REGIMES_DE_DOMAINE[DOMAINES.archive], "usage-unique");

  assert.equal(selDuDomaine(DOMAINES.volume).byteLength, 0);
  assert.equal(selDuDomaine(DOMAINES.journal).byteLength, 0);
  assert.equal(selDuDomaine(DOMAINES.instantane).byteLength, SEL_DE_DOMAINE_OCTETS);

  // Un sel de la MAUVAISE largeur pour son régime est refusé avant qu'aucune clé n'existe.
  await assert.rejects(() =>
    deriverCleDeDomaine({
      cleMaitresse: CLE_DE_TEST,
      domaine: DOMAINES.volume,
      sel: new Uint8Array(SEL_DE_DOMAINE_OCTETS),
      info: encoderInfoDeDomaine({
        domaine: DOMAINES.volume,
        identifiantVolume: VOLUME_A,
        versionDeFormat: FORMAT_VOLUME_V4,
      }),
    }),
  );
  await assert.rejects(() =>
    deriverCleDeDomaine({
      cleMaitresse: CLE_DE_TEST,
      domaine: DOMAINES.archive,
      sel: new Uint8Array(0),
      info: encoderInfoDeDomaine({
        domaine: DOMAINES.archive,
        identifiantVolume: VOLUME_A,
        versionDeFormat: 3,
      }),
    }),
  );
});

test("la DEK importée en matériau HKDF : WebCrypto REFUSE de chiffrer avec elle (ADR 0033, décision 6)", async () => {
  const materiau = await importerMateriauMaitre(CLE_DE_TEST);

  assert.equal(materiau.algorithm.name, "HKDF");
  assert.deepEqual(materiau.usages, ["deriveKey"]);
  assert.equal(materiau.extractable, false);

  // Ce n'est pas une discipline, c'est la plate-forme : une CryptoKey dont les usages ne portent pas
  // « encrypt » fait rejeter `crypto.subtle.encrypt` par la spécification WebCrypto elle-même.
  await assert.rejects(
    () => crypto.subtle.encrypt({ name: "AES-GCM", iv: NONCE }, materiau, CLAIR),
    "la DEK ne peut pas chiffrer : c'est un GARANTI, pas un « fait, non garanti »",
  );
});
