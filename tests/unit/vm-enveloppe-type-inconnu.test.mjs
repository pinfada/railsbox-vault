/**
 * Un TYPE DE CLÉ INCONNU est une entrée VALIDE de la page (#147, amendement à l'ADR 0020).
 *
 * La revue de format de la PR #155 a mesuré ce que la première rédaction de #147 affirmait à
 * tort. `exigerTypeKek` gardait les deux chemins, écriture ET lecture ; un lecteur rencontrant un
 * type qu'il ne réserve pas — ce qui arrive à tout lecteur d'avant #147 devant un emplacement
 * `recuperation`, et arrivera à celui d'aujourd'hui devant le type 5 — levait donc
 * `VAULT_ENVELOPPE_MALFORME` depuis l'encodage canonique de la liste. Deux conséquences :
 *
 *  1. **plus aucun moyen n'ouvrait**, la phrase comprise, dès que les DEUX pages portaient le type
 *    inconnu. Le refus ne disait pas « je ne sais pas servir ce moyen », il disait « ce fichier est
 *    malformé » — et les deux remèdes n'ont rien de commun ;
 *  2. **le repli sur l'autre page devenait silencieux.** `lireEtat` traite un `MALFORME` comme un
 *    refus de page et essaie la suivante : le lecteur rendait l'état d'AVANT, et une écriture
 *    ultérieure écrasait la page qui portait le type inconnu, sans erreur et sans faire avancer le
 *    compteur de version. C'est le défaut le plus grave des deux, parce qu'il est SILENCIEUX.
 *
 * L'ADR 0021 promet le contraire en toutes lettres — « une enveloppe qui porte un emplacement d'un
 * type inconnu ET un emplacement servable s'ouvre par le second » —, et c'est cette promesse que
 * les épreuves ci-dessous tiennent.
 *
 * **Le partage est celui-ci, et il est le sujet du fichier** : la LECTURE accepte tout octet
 * (`exigerOctetDeTypeKek`) ; l'ÉCRITURE d'un emplacement NEUF exige un type réservé
 * (`exigerTypeKek`), parce qu'on n'écrit jamais un moyen qu'on ne sait pas servir.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { catalogueDeDerivateurs } from "../../src/vm/derivation/derivateurs.mjs";
import {
  DERIVATION_ERROR_CODES,
  isDerivationError,
} from "../../src/vm/derivation/derivation-errors.mjs";
import {
  ajouterEmplacement,
  creerEnveloppe,
  inventorierEnveloppe,
  ouvrirEnveloppe,
  revoquerEmplacement,
} from "../../src/vm/enveloppe-de-cle.mjs";
import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { offsetDePage } from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import {
  ENVELOPPE_FORMAT_V1,
  NONCE_OCTETS,
  TYPES_KEK,
  exigerOctetDeTypeKek,
  exigerTypeKek,
  nomDuTypeKek,
} from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { envelopperSousNonce } from "../../src/vm/enveloppe/modele-reference.mjs";
import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import {
  composerPageAlaMain,
  identifiantDeVolume,
  supportDouble,
  suiteDOctets,
} from "./support-enveloppe-double.mjs";

const VOLUME = identifiantDeVolume(0x30);

/** Le type que ce dépôt ne réserve pas, et qui joue le rôle d'un moyen venu d'une version future. */
const TYPE_FUTUR = 99;

/** Une KEK déterministe. Ce fichier mesure le FORMAT, pas une dérivation. */
async function kek(graine) {
  return crypto.subtle.importKey("raw", suiteDOctets(graine, 32), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/**
 * Pose une enveloppe portant un emplacement `phrase` PUIS un emplacement de type INCONNU.
 *
 * Elle est SCELLÉE, pas bricolée : retourner l'octet de type dans le fichier ne mesurerait rien,
 * puisque ce type entre dans les données associées de la DEK enveloppée ET dans l'empreinte que la
 * racine scelle — la page serait simplement refusée, et pour la mauvaise raison. La fabrique fait
 * donc ce qu'un produit d'une version ULTÉRIEURE ferait : elle enveloppe, scelle et encode la page
 * elle-même, par les primitives du modèle de référence. Seule la garde de l'ÉCRITURE de
 * `enveloppe-de-cle.mjs` — celle qui refuse un type non réservé — est ainsi contournée, et c'est
 * exactement ce qu'on veut simuler.
 *
 * Une SEULE page porte le type inconnu, l'autre garde l'état antérieur : c'est la configuration
 * dans laquelle l'ancienne garde repliait silencieusement, et c'est donc celle qui mord.
 */
async function enveloppeAvecUnTypeFutur() {
  const support = supportDouble();
  const dek = suiteDOctets(0x40, 32);
  await creerEnveloppe({
    support,
    identifiantVolume: VOLUME,
    dek,
    kek: await kek(0x50),
    typeKek: TYPES_KEK.phrase,
    parametres: suiteDOctets(0x11, 24),
    identifiantEmplacement: "1111111111111111",
  });

  const emplacements = [];
  for (const [identifiantEmplacement, typeKek, base, graine] of [
    ["1111111111111111", TYPES_KEK.phrase, 0x11, 0x50],
    ["2222222222222222", TYPE_FUTUR, 0x22, 0x60],
  ]) {
    const parametres = suiteDOctets(base, 24);
    const scelle = await envelopperSousNonce({
      kek: await kek(graine),
      emplacement: {
        identifiantVolume: VOLUME,
        identifiantEmplacement,
        formatVersion: ENVELOPPE_FORMAT_V1,
        typeKek,
        parametres,
      },
      dek,
      nonce: suiteDOctets(base, NONCE_OCTETS),
    });
    emplacements.push({
      identifiantEmplacement,
      typeKek,
      parametres,
      nonce: scelle.nonce,
      dekEnveloppee: scelle.chiffre,
      etiquette: scelle.etiquette,
    });
  }
  const page = await composerPageAlaMain({
    identifiantVolume: VOLUME,
    version: 2,
    dek,
    emplacements,
    nonce: suiteDOctets(0x99, NONCE_OCTETS),
  });
  // La page LIBRE, celle que la création n'a pas écrite : l'ordre de l'ADR 0020 est respecté.
  await support.ecrire(offsetDePage(1), page);
  await support.barriere();
  return { support, dek };
}

test("un type INCONNU tient sur l'octet du format : la lecture l'accepte, l'écriture le refuse", () => {
  assert.equal(nomDuTypeKek(TYPE_FUTUR), null, "le type d'épreuve doit être non réservé.");
  assert.equal(exigerOctetDeTypeKek(TYPE_FUTUR), TYPE_FUTUR);
  assert.throws(
    () => exigerTypeKek(TYPE_FUTUR),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.malforme),
    "on n'ÉCRIT jamais un emplacement d'un type qu'on ne sait pas servir.",
  );
  // La borne qui reste est celle du CHAMP, et elle n'est pas une politique.
  for (const hors of [-1, 256, 1.5, "4", null]) {
    assert.throws(
      () => exigerOctetDeTypeKek(hors),
      (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.malforme),
      `${JSON.stringify(hors)} ne tient pas sur un octet`,
    );
  }
});

test("une enveloppe portant un type inconnu S'OUVRE encore par son emplacement servable", async () => {
  const { support, dek } = await enveloppeAvecUnTypeFutur();
  const ouverte = await ouvrirEnveloppe({
    support,
    identifiantVolume: VOLUME,
    kek: await kek(0x50),
  });
  assert.deepEqual(ouverte.dek, dek, "la phrase n'ouvre plus une enveloppe qu'elle protège.");
  assert.equal(
    ouverte.version,
    2,
    "l'ouverture a rendu l'état COURANT, et non celui d'avant : aucun repli silencieux.",
  );
});

test("l'inventaire PUBLIC montre le type inconnu par son NUMÉRO, sans lui inventer un nom", async () => {
  const { support } = await enveloppeAvecUnTypeFutur();
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME });
  assert.equal(inventaire.version, 2);
  assert.deepEqual(
    inventaire.emplacements.map((emplacement) => emplacement.typeKek),
    [TYPES_KEK.phrase, TYPE_FUTUR],
  );
  assert.equal(
    nomDuTypeKek(TYPE_FUTUR),
    null,
    "un type que le dépôt ne réserve pas n'a pas de nom, et n'en reçoit pas un approchant.",
  );
});

test("le refus d'un type inconnu tombe au CHOIX du dérivateur, jamais à la lecture de la page", async () => {
  const { support } = await enveloppeAvecUnTypeFutur();
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME });
  const catalogue = catalogueDeDerivateurs({});
  assert.throws(
    () => catalogue.pour(TYPE_FUTUR),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.typeInconnu),
    "le remède est de mettre à jour, et c'est ce refus-là qui le dit.",
  );
  // Et le FICHIER n'a pas été touché par ce refus : il ne fait que lire.
  const taille = (await support.etat()).taille;
  const avant = octetsEnHex(await support.lire(0, taille));
  try {
    catalogue.pour(inventaire.emplacements[1].typeKek);
  } catch {
    /* le refus est mesuré ci-dessus ; ici on mesure l'absence d'écriture */
  }
  assert.equal(octetsEnHex(await support.lire(0, taille)), avant);
});

test("AUCUN repli silencieux : une page courante VALIDE portant un type inconnu fait autorité", async () => {
  // Le défaut mesuré par la revue, dans sa forme la plus dangereuse. Sous l'ancienne garde, la page
  // courante était jugée malformée, `lireEtat` repliait sur la précédente, et l'écriture suivante
  // écrasait la page neuve SANS faire avancer le compteur — une régression d'état, silencieuse.
  const { support } = await enveloppeAvecUnTypeFutur();
  const ajoute = await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: await kek(0x50),
    kekNouvelle: await kek(0x70),
    typeKek: TYPES_KEK.phrase,
    parametres: suiteDOctets(0x33, 12),
    identifiantEmplacement: "3333333333333333",
  });
  assert.equal(ajoute.version, 3, "le compteur doit AVANCER : partir de 2, jamais de 1.");
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME });
  assert.equal(inventaire.version, 3);
  assert.deepEqual(
    inventaire.emplacements.map((emplacement) => emplacement.typeKek),
    [TYPES_KEK.phrase, TYPE_FUTUR, TYPES_KEK.phrase],
    "l'emplacement de type inconnu a été REPORTÉ tel quel, ni perdu ni réécrit.",
  );
  assert.ok(await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: await kek(0x70) }));
});

test("un emplacement de type inconnu se RÉVOQUE, sans qu'on sache le servir", async () => {
  // C'est ce dont #148 aura besoin : retirer un moyen qu'on ne sait pas ouvrir reste possible,
  // parce que la révocation ne demande que de tenir UNE clé valable de l'enveloppe.
  const { support } = await enveloppeAvecUnTypeFutur();
  const retire = await revoquerEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: await kek(0x50),
    identifiantEmplacement: "2222222222222222",
  });
  assert.equal(retire.nombreEmplacements, 1);
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME });
  assert.deepEqual(
    inventaire.emplacements.map((emplacement) => emplacement.typeKek),
    [TYPES_KEK.phrase],
  );
});

test("ÉCRIRE un emplacement d'un type inconnu reste refusé, aux trois opérations", async () => {
  const support = supportDouble();
  const commun = {
    identifiantVolume: VOLUME,
    dek: suiteDOctets(0x40, 32),
    kek: await kek(0x50),
    typeKek: TYPE_FUTUR,
    parametres: suiteDOctets(0x11, 8),
  };
  await assert.rejects(
    () => creerEnveloppe({ support, ...commun }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.malforme),
  );
  await creerEnveloppe({ ...commun, support, typeKek: TYPES_KEK.phrase });
  await assert.rejects(
    async () =>
      ajouterEmplacement({
        support,
        identifiantVolume: VOLUME,
        kek: await kek(0x50),
        kekNouvelle: await kek(0x60),
        typeKek: TYPE_FUTUR,
        parametres: suiteDOctets(0x22, 8),
      }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.malforme),
    "un moyen qu'on ne sait pas servir ne s'écrit pas, même à côté d'un moyen valable.",
  );
});
