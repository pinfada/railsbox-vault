import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { digestHex } from "../../src/vm/block-fixture.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import {
  CRC_OFFSET,
  ENTETE_PAGE_OCTETS,
  PAGE_OCTETS,
  TAILLE_FICHIER_ENVELOPPE,
  decoderPage,
  offsetDePage,
  sommeDePage,
} from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import { EMPLACEMENTS_MAX, TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  ajouterEmplacement,
  creerEnveloppe,
  inventorierEnveloppe,
  ouvrirEnveloppe,
  remplacerEmplacement,
  revoquerEmplacement,
} from "../../src/vm/enveloppe-de-cle.mjs";
import { supportEnveloppeOpfs } from "../../src/vm/ouverture-par-enveloppe.mjs";
import { supportDouble, suiteDOctets } from "./support-enveloppe-double.mjs";

// Preuve unitaire des CINQ OPÉRATIONS de l'enveloppe et de leurs REFUS (#21, ADR 0020).
//
// Chaque épreuve négative porte son TÉMOIN POSITIF dans le même corps : un refus n'apprend rien si
// l'on n'a pas montré, sur le même fichier et à la même ligne, que le geste légitime aboutit. C'est
// la discipline que `tests/browser/origin-topology.spec.mjs` applique déjà à la frontière d'origine,
// et que #14 a payé cher pour l'avoir oubliée sur un oracle.
//
// Les octets sont manipulés à la main là où il le faut — retirer un emplacement en RECTIFIANT la
// longueur déclarée mais pas le compte authentifié, par exemple. C'est le seul moyen d'atteindre les
// états qu'un adversaire atteindrait : passer par l'encodeur du produit ne produirait que des
// fichiers cohérents, c'est-à-dire ne mesurerait rien.

const VOLUME_A = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const VOLUME_B = "ffeeddccbbaa99887766554433221100";

const DEK_A = suiteDOctets(0x20, 32);
const KEK_UN = suiteDOctets(0x80, 32);
const KEK_DEUX = suiteDOctets(0xa0, 32);
const KEK_TROIS = suiteDOctets(0xc0, 32);
const KEK_JAMAIS_VUE = suiteDOctets(0x11, 32);

/** Fabrique une enveloppe neuve à un emplacement, sur un support en mémoire. */
async function enveloppeNeuve({ identifiantVolume = VOLUME_A, dek = DEK_A, kek = KEK_UN } = {}) {
  const support = supportDouble();
  const creee = await creerEnveloppe({ support, identifiantVolume, dek, kek });
  return { support, identifiantVolume, dek, kek, ...creee };
}

/** Fabrique une enveloppe à DEUX emplacements : le cas où la révocation est permise. */
async function enveloppeADeux() {
  const base = await enveloppeNeuve();
  await ajouterEmplacement({
    support: base.support,
    identifiantVolume: base.identifiantVolume,
    kek: base.kek,
    kekNouvelle: KEK_DEUX,
    typeKek: TYPES_KEK.phrase,
    parametres: suiteDOctets(0xf0, 8),
  });
  return base;
}

/** La page qui fait autorité, en octets. */
function pageAutoritaire(octets) {
  const pages = [0, 1]
    .map((index) =>
      decoderPage(octets.subarray(offsetDePage(index), offsetDePage(index) + PAGE_OCTETS)),
    )
    .map((lue, index) => ({ index, lue }))
    .filter(({ lue }) => lue.valide);
  const meilleure = pages.reduce((a, b) => (b.lue.page.version > a.lue.page.version ? b : a));
  return { index: meilleure.index, octets: octetsDePage(octets, meilleure.index) };
}

function octetsDePage(fichier, index) {
  return fichier.slice(offsetDePage(index), offsetDePage(index) + PAGE_OCTETS);
}

/** Frontières de chaque emplacement dans une page, telles que le format les impose. */
function tranchesDEmplacements(page) {
  const vue = new DataView(page.buffer, page.byteOffset, page.byteLength);
  const fin = ENTETE_PAGE_OCTETS + vue.getUint32(40, true);
  const tranches = [];
  let curseur = ENTETE_PAGE_OCTETS;
  while (curseur < fin) {
    const total = 72 + vue.getUint16(curseur + 10, true);
    tranches.push(page.slice(curseur, curseur + total));
    curseur += total;
  }
  return tranches;
}

/**
 * Réécrit la LISTE d'une page sans toucher au compte AUTHENTIFIÉ de son en-tête.
 *
 * C'est exactement le geste d'un adversaire soigneux : il rectifie ce que le format lui permet de
 * rectifier — la longueur déclarée et la somme de contrôle, toutes deux hors des données associées —
 * et laisse intact ce qu'il ne peut pas forger, à savoir le compte AUTHENTIFIÉ et l'étiquette de la
 * racine. Passer par l'encodeur du produit rectifierait AUSSI le compte, et l'épreuve mesurerait
 * alors un fichier cohérent au lieu d'une falsification.
 *
 * La somme de contrôle est recalculée sans hésiter : elle ne prétend à AUCUNE résistance à un
 * adversaire (ADR 0020), et une épreuve qui la laisserait fausse mesurerait une déchirure de support
 * au lieu d'une falsification délibérée.
 */
function reecrireListe(page, morceaux) {
  const octets = Uint8Array.from(page);
  const vue = new DataView(octets.buffer);
  octets.fill(0, ENTETE_PAGE_OCTETS, PAGE_OCTETS);
  let curseur = ENTETE_PAGE_OCTETS;
  for (const morceau of morceaux) {
    octets.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  const longueurListe = curseur - ENTETE_PAGE_OCTETS;
  vue.setUint32(40, longueurListe, true);
  return rescellerLaSomme(octets, longueurListe);
}

/** Recalcule la somme de contrôle d'une page dont les octets viennent d'être remaniés. */
function rescellerLaSomme(octets, longueurListe = new DataView(octets.buffer).getUint32(40, true)) {
  new DataView(octets.buffer).setUint32(CRC_OFFSET, sommeDePage(octets, longueurListe), true);
  return octets;
}

/** Un fichier complet portant `page` en page 0 ; la page 1 reste à zéro. */
function fichierAvec(page, seconde = null) {
  const octets = new Uint8Array(TAILLE_FICHIER_ENVELOPPE);
  octets.set(page, offsetDePage(0));
  if (seconde !== null) octets.set(seconde, offsetDePage(1));
  return octets;
}

const refusDe = (code) => (erreur) => isEnveloppeError(erreur, code);

// --- Le geste normal ---------------------------------------------------------------------------

test("créer puis ouvrir : la clé de volume revient telle quelle, sous la clé de déverrouillage", async () => {
  const { support, kek } = await enveloppeNeuve();
  const ouverte = await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek });

  assert.deepEqual(ouverte.dek, DEK_A);
  assert.equal(ouverte.version, 1);
});

test("un fichier neuf occupe exactement deux pages, et sa taille ne change plus jamais", async () => {
  const { support, kek } = await enveloppeADeux();
  assert.equal(support.contenu.byteLength, TAILLE_FICHIER_ENVELOPPE);

  await remplacerEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek,
    identifiantEmplacement: (await inventorierEnveloppe({ support, identifiantVolume: VOLUME_A }))
      .emplacements[0].identifiantEmplacement,
    kekNouvelle: KEK_TROIS,
  });
  assert.equal(support.contenu.byteLength, TAILLE_FICHIER_ENVELOPPE);
});

test("ajouter une clé n'en rescelle aucune autre : les octets du voisin sont les mêmes", async () => {
  const { support, kek } = await enveloppeNeuve();
  const avant = tranchesDEmplacements(pageAutoritaire(support.contenu).octets);

  await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek,
    kekNouvelle: KEK_DEUX,
  });
  const apres = tranchesDEmplacements(pageAutoritaire(support.contenu).octets);

  assert.equal(apres.length, avant.length + 1);
  assert.deepEqual(apres[0], avant[0], "l'emplacement existant a été réécrit par un simple ajout");
  assert.deepEqual(
    (await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: KEK_DEUX })).dek,
    DEK_A,
    "la clé ajoutée ouvre la MÊME clé de volume",
  );
});

test("remplacer change l'identifiant d'emplacement, et l'ancienne clé n'ouvre plus", async () => {
  const { support, kek, identifiantEmplacement } = await enveloppeADeux();
  await remplacerEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek,
    identifiantEmplacement,
    kekNouvelle: KEK_TROIS,
  });

  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME_A });
  assert.notEqual(inventaire.emplacements[0].identifiantEmplacement, identifiantEmplacement);
  assert.deepEqual(
    (await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: KEK_TROIS })).dek,
    DEK_A,
    "témoin positif : la clé neuve ouvre",
  );
  await assert.rejects(
    ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek }),
    refusDe(ENVELOPPE_ERROR_CODES.cleRefusee),
  );
});

test("le compteur de version croît STRICTEMENT à chaque opération", async () => {
  const { support, kek, identifiantEmplacement } = await enveloppeNeuve();
  const versions = [1];
  versions.push(
    (await ajouterEmplacement({ support, identifiantVolume: VOLUME_A, kek, kekNouvelle: KEK_DEUX }))
      .version,
  );
  versions.push(
    (
      await remplacerEmplacement({
        support,
        identifiantVolume: VOLUME_A,
        kek,
        identifiantEmplacement,
        kekNouvelle: KEK_TROIS,
      })
    ).version,
  );
  versions.push(
    (
      await revoquerEmplacement({
        support,
        identifiantVolume: VOLUME_A,
        kek: KEK_TROIS,
        identifiantEmplacement: (
          await inventorierEnveloppe({ support, identifiantVolume: VOLUME_A })
        ).emplacements[1].identifiantEmplacement,
      })
    ).version,
  );
  assert.deepEqual(versions, [1, 2, 3, 4]);
});

// --- Les refus, chacun avec son témoin positif -------------------------------------------------

test("aucune enveloppe : le refus DIT qu'il n'y en a pas, et ne dit pas « clé invalide »", async () => {
  const support = supportDouble();
  await assert.rejects(
    ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: KEK_UN }),
    (erreur) => {
      assert.equal(erreur.code, ENVELOPPE_ERROR_CODES.absente);
      assert.notEqual(erreur.code, ENVELOPPE_ERROR_CODES.cleRefusee);
      return true;
    },
  );

  // Témoin positif : sur le MÊME support, une enveloppe créée s'ouvre.
  await creerEnveloppe({ support, identifiantVolume: VOLUME_A, dek: DEK_A, kek: KEK_UN });
  assert.deepEqual(
    (await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: KEK_UN })).dek,
    DEK_A,
  );
});

test("clé RÉVOQUÉE et clé INCONNUE rendent le même refus, indiscernable", async () => {
  const { support, kek, identifiantEmplacement } = await enveloppeADeux();
  await revoquerEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek: KEK_DEUX,
    identifiantEmplacement,
  });

  const refus = [];
  for (const essai of [kek, KEK_JAMAIS_VUE]) {
    await assert.rejects(
      ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: essai }),
      (erreur) => {
        refus.push(erreur.toJSON());
        return isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.cleRefusee);
      },
    );
  }
  assert.deepEqual(refus[0], refus[1], "les deux refus diffèrent : la révocation est observable");
  assert.deepEqual(
    (await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: KEK_DEUX })).dek,
    DEK_A,
    "témoin positif : la clé restée valable ouvre encore",
  );
});

test("les deux refus font EXACTEMENT le même nombre d'appels AEAD", async () => {
  // Ce qui est mesuré : le nombre d'invocations de `SubtleCrypto.decrypt`, donc l'absence de
  // court-circuit. Ce qui ne l'est PAS : le temps interne de WebCrypto, les effets de cache, ni le
  // temps d'horloge — ce dépôt ne les maîtrise pas et ne prétend rien à leur sujet (ADR 0020).
  const { support, kek, identifiantEmplacement } = await enveloppeADeux();
  await revoquerEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek: KEK_DEUX,
    identifiantEmplacement,
  });

  const comptes = [];
  const vrai = SubtleCrypto.prototype.decrypt;
  for (const essai of [kek, KEK_JAMAIS_VUE]) {
    let appels = 0;
    SubtleCrypto.prototype.decrypt = function compter(...args) {
      appels += 1;
      return vrai.apply(this, args);
    };
    try {
      await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: essai }).catch(() => {});
    } finally {
      SubtleCrypto.prototype.decrypt = vrai;
    }
    comptes.push(appels);
  }
  assert.equal(
    comptes[0],
    comptes[1],
    "le nombre de tentatives trahit laquelle des deux clés c'est",
  );
  assert.ok(comptes[0] > 0, "aucun appel : la mesure ne mesure rien");
});

test("une ouverture RÉUSSIE ne dit pas QUEL emplacement a répondu", async () => {
  // La campagne de mutation de #21 a établi que l'absence de court-circuit ne sert PAS à rendre les
  // deux échecs indiscernables — un échec parcourt la liste entière de toute façon. Ce qu'elle sert
  // est ici : sans elle, une ouverture qui aboutit au premier emplacement coûterait un appel AEAD
  // et une qui aboutit au dernier en coûterait huit, si bien que le TEMPS d'un succès désignerait
  // la clé employée. La garde est donc réelle, mais pas là où on la croyait, et c'est la mutation
  // qui l'a dit.
  const { support, kek } = await enveloppeNeuve();
  const derniere = suiteDOctets(0x44, 32);
  for (let rang = 1; rang < EMPLACEMENTS_MAX; rang += 1) {
    await ajouterEmplacement({
      support,
      identifiantVolume: VOLUME_A,
      kek,
      kekNouvelle: rang === EMPLACEMENTS_MAX - 1 ? derniere : suiteDOctets(rang, 32),
    });
  }

  const comptes = [];
  const vrai = SubtleCrypto.prototype.decrypt;
  for (const essai of [kek, derniere]) {
    let appels = 0;
    SubtleCrypto.prototype.decrypt = function compter(...args) {
      appels += 1;
      return vrai.apply(this, args);
    };
    try {
      await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: essai });
    } finally {
      SubtleCrypto.prototype.decrypt = vrai;
    }
    comptes.push(appels);
  }
  assert.equal(
    comptes[0],
    comptes[1],
    "le coût d'un succès dépend du RANG de l'emplacement : il désigne la clé employée",
  );
  assert.ok(comptes[0] >= EMPLACEMENTS_MAX, "la liste entière doit être parcourue");
});

test("emplacement d'un AUTRE volume glissé dans la liste : mélange, avant toute clé de volume rendue", async () => {
  const cible = await enveloppeADeux();
  const etranger = await enveloppeNeuve({
    identifiantVolume: VOLUME_B,
    dek: suiteDOctets(0x60, 32),
    kek: KEK_TROIS,
  });

  const page = pageAutoritaire(cible.support.contenu).octets;
  const sien = tranchesDEmplacements(page);
  const autre = tranchesDEmplacements(pageAutoritaire(etranger.support.contenu).octets)[0];
  const falsifie = supportDouble({ octets: fichierAvec(reecrireListe(page, [sien[0], autre])) });

  await assert.rejects(
    ouvrirEnveloppe({ support: falsifie, identifiantVolume: VOLUME_A, kek: cible.kek }),
    refusDe(ENVELOPPE_ERROR_CODES.melange),
  );
  // Témoin positif : la MÊME page, sans la substitution, s'ouvre.
  assert.deepEqual(
    (
      await ouvrirEnveloppe({
        support: supportDouble({ octets: fichierAvec(page) }),
        identifiantVolume: VOLUME_A,
        kek: cible.kek,
      })
    ).dek,
    DEK_A,
  );
});

test("fichier d'un AUTRE volume présenté sous cet identifiant : identité, et rien n'est rendu", async () => {
  const etranger = await enveloppeNeuve({
    identifiantVolume: VOLUME_B,
    dek: suiteDOctets(0x60, 32),
    kek: KEK_TROIS,
  });
  const support = supportDouble({ octets: etranger.support.contenu });

  await assert.rejects(
    ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: KEK_TROIS }),
    refusDe(ENVELOPPE_ERROR_CODES.identite),
  );
  // Témoin positif : sous SON identifiant, le même fichier et la même clé ouvrent.
  assert.deepEqual(
    (await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_B, kek: KEK_TROIS })).dek,
    suiteDOctets(0x60, 32),
  );
});

test("liste TRONQUÉE avec longueur rectifiée : le compte authentifié la démasque", async () => {
  const { support, kek } = await enveloppeADeux();
  const page = pageAutoritaire(support.contenu).octets;
  const tranches = tranchesDEmplacements(page);
  assert.equal(tranches.length, 2, "le fichier de départ doit porter deux emplacements");

  const ampute = supportDouble({ octets: fichierAvec(reecrireListe(page, [tranches[0]])) });
  await assert.rejects(
    ouvrirEnveloppe({ support: ampute, identifiantVolume: VOLUME_A, kek }),
    refusDe(ENVELOPPE_ERROR_CODES.troncature),
  );
  assert.deepEqual(
    (await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek })).dek,
    DEK_A,
    "témoin positif : le fichier intact s'ouvre",
  );
});

test("liste RÉORDONNÉE : le compte est juste, l'empreinte ne l'est pas", async () => {
  const { support, kek } = await enveloppeADeux();
  const page = pageAutoritaire(support.contenu).octets;
  const [premier, second] = tranchesDEmplacements(page);

  const permute = supportDouble({ octets: fichierAvec(reecrireListe(page, [second, premier])) });
  await assert.rejects(
    ouvrirEnveloppe({ support: permute, identifiantVolume: VOLUME_A, kek }),
    refusDe(ENVELOPPE_ERROR_CODES.melange),
  );
  assert.deepEqual(
    (await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek })).dek,
    DEK_A,
    "témoin positif : l'ordre d'origine s'ouvre",
  );
});

test("racine ALTÉRÉE d'un octet : refus de racine, sans diagnostic inventé", async () => {
  const { support, kek } = await enveloppeADeux();
  const page = Uint8Array.from(pageAutoritaire(support.contenu).octets);
  page[88] ^= 0x01; // premier octet de l'étiquette de la racine
  rescellerLaSomme(page); // l'adversaire recalcule la somme : elle ne lui résiste pas, et ne le prétend pas

  await assert.rejects(
    ouvrirEnveloppe({
      support: supportDouble({ octets: fichierAvec(page) }),
      identifiantVolume: VOLUME_A,
      kek,
    }),
    (erreur) => {
      assert.ok(isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.racineRefusee));
      assert.deepEqual([...erreur.situations].sort(), ["deplacement", "modification"]);
      return true;
    },
  );
});

test("VERSION ANTÉRIEURE rejouée : refusée sous un minimum, servie sans minimum, et le dire", async () => {
  const { support, kek } = await enveloppeNeuve();
  const ancien = Uint8Array.from(support.contenu);
  await ajouterEmplacement({ support, identifiantVolume: VOLUME_A, kek, kekNouvelle: KEK_DEUX });
  assert.equal((await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek })).version, 2);

  const remis = supportDouble({ octets: ancien });
  await assert.rejects(
    ouvrirEnveloppe({ support: remis, identifiantVolume: VOLUME_A, kek, versionMinimale: 2 }),
    refusDe(ENVELOPPE_ERROR_CODES.rejeu),
  );
  // Sans minimum, le retour arrière COMPLET du fichier n'est pas détecté, et l'ADR 0020 le dit.
  assert.equal(
    (await ouvrirEnveloppe({ support: remis, identifiantVolume: VOLUME_A, kek })).version,
    1,
  );
});

test("une page ANCIENNE mais valide ne l'emporte jamais sur la page courante", async () => {
  const { support, kek } = await enveloppeNeuve();
  const v1 = pageAutoritaire(support.contenu).octets;
  await ajouterEmplacement({ support, identifiantVolume: VOLUME_A, kek, kekNouvelle: KEK_DEUX });
  const v2 = pageAutoritaire(support.contenu).octets;

  for (const octets of [fichierAvec(v1, v2), fichierAvec(v2, v1)]) {
    const melange = supportDouble({ octets });
    assert.equal(
      (await ouvrirEnveloppe({ support: melange, identifiantVolume: VOLUME_A, kek })).version,
      2,
      "l'ordre des pages dans le fichier ne doit jamais décider de l'autorité",
    );
  }
});

test("deux pages illisibles : ILLISIBLE, distinct d'une enveloppe absente", async () => {
  const support = supportDouble({ octets: new Uint8Array(TAILLE_FICHIER_ENVELOPPE) });
  await assert.rejects(
    ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: KEK_UN }),
    refusDe(ENVELOPPE_ERROR_CODES.illisible),
  );
});

test("révoquer le DERNIER emplacement est refusé, et rien n'est écrit", async () => {
  const { support, kek, identifiantEmplacement } = await enveloppeNeuve();
  const avant = support.contenu;

  await assert.rejects(
    revoquerEmplacement({ support, identifiantVolume: VOLUME_A, kek, identifiantEmplacement }),
    refusDe(ENVELOPPE_ERROR_CODES.dernierEmplacement),
  );
  assert.deepEqual(support.contenu, avant, "un refus a tout de même écrit sur le support");

  // Témoin positif : avec une seconde clé, la même révocation aboutit.
  await ajouterEmplacement({ support, identifiantVolume: VOLUME_A, kek, kekNouvelle: KEK_DEUX });
  await revoquerEmplacement({ support, identifiantVolume: VOLUME_A, kek, identifiantEmplacement });
  await assert.rejects(
    ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek }),
    refusDe(ENVELOPPE_ERROR_CODES.cleRefusee),
  );
});

test("révoquer un emplacement INCONNU est refusé, et n'en crée aucun pour l'occasion", async () => {
  const { support, kek } = await enveloppeADeux();
  const avant = support.contenu;
  await assert.rejects(
    revoquerEmplacement({
      support,
      identifiantVolume: VOLUME_A,
      kek,
      identifiantEmplacement: "0000000000000000",
    }),
    refusDe(ENVELOPPE_ERROR_CODES.emplacementInconnu),
  );
  assert.deepEqual(support.contenu, avant);
});

test("l'enveloppe est PLEINE au-delà du plafond, et le refus tombe avant d'écrire", async () => {
  const { support, kek } = await enveloppeNeuve();
  for (let rang = 1; rang < EMPLACEMENTS_MAX; rang += 1) {
    await ajouterEmplacement({
      support,
      identifiantVolume: VOLUME_A,
      kek,
      kekNouvelle: suiteDOctets(rang, 32),
    });
  }
  const avant = support.contenu;
  await assert.rejects(
    ajouterEmplacement({
      support,
      identifiantVolume: VOLUME_A,
      kek,
      kekNouvelle: suiteDOctets(0x33, 32),
    }),
    refusDe(ENVELOPPE_ERROR_CODES.pleine),
  );
  assert.deepEqual(support.contenu, avant);
  assert.equal(
    (await inventorierEnveloppe({ support, identifiantVolume: VOLUME_A })).emplacements.length,
    EMPLACEMENTS_MAX,
  );
});

test("une révocation ne laisse AUCUN octet de l'emplacement retiré dans la page publiée", async () => {
  const { support, identifiantEmplacement } = await enveloppeADeux();
  const retire = tranchesDEmplacements(pageAutoritaire(support.contenu).octets)[0];

  await revoquerEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek: KEK_DEUX,
    identifiantEmplacement,
  });
  const publiee = pageAutoritaire(support.contenu).octets;
  const enHex = Buffer.from(publiee).toString("hex");
  assert.equal(
    enHex.includes(Buffer.from(retire.subarray(24, 56)).toString("hex")),
    false,
    "la DEK enveloppée de l'emplacement révoqué survit dans la page",
  );
});

// --- Le volume n'est pas touché ---------------------------------------------------------------

test("le fichier de VOLUME est identique à l'octet après ajout, remplacement et révocation", async () => {
  const taille = 8 * SECTOR_SIZE;
  const store = createSyncAccessStore();
  const nom = "coffre";
  const stat = async (fichier) => ({
    present: store.sizeOf(fichier) > 0,
    size: store.sizeOf(fichier),
  });

  const backend = await openOpfsVolume({
    name: nom,
    size: taille,
    cle: DEK_A,
    identifiantVolume: VOLUME_A,
    openHandle: store.openHandle,
    transactionnel: false,
  });
  await backend.write(
    0,
    Uint8Array.from({ length: SECTOR_SIZE }, (_, i) => (i * 5 + 1) & 0xff),
  );
  await backend.flush();
  await backend.close();

  const support = supportEnveloppeOpfs(nom, { openHandle: store.openHandle, stat });
  const creee = await creerEnveloppe({
    support,
    identifiantVolume: VOLUME_A,
    dek: DEK_A,
    kek: KEK_UN,
  });
  const empreinteAvant = await digestHex(store.snapshot(nom));

  await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek: KEK_UN,
    kekNouvelle: KEK_DEUX,
  });
  await remplacerEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek: KEK_UN,
    identifiantEmplacement: creee.identifiantEmplacement,
    kekNouvelle: KEK_TROIS,
  });
  await revoquerEmplacement({
    support,
    identifiantVolume: VOLUME_A,
    kek: KEK_TROIS,
    identifiantEmplacement: (await inventorierEnveloppe({ support, identifiantVolume: VOLUME_A }))
      .emplacements[1].identifiantEmplacement,
  });

  assert.equal(await digestHex(store.snapshot(nom)), empreinteAvant);
  assert.deepEqual(
    (await ouvrirEnveloppe({ support, identifiantVolume: VOLUME_A, kek: KEK_TROIS })).dek,
    DEK_A,
    "après trois rotations, la clé de volume est toujours la même",
  );
});
