import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { daterLaCreation } from "../../src/vm/opfs-datation-de-creation.mjs";
import {
  DOMAINES,
  VERSIONS_DE_FORMAT_DE_DOMAINE,
  encoderInfoDeDomaine,
} from "../../src/vm/derivation/cle-de-domaine.mjs";
import {
  ajouterEmplacement,
  creerEnveloppe,
  ouvrirEnveloppe,
  revoquerEmplacement,
} from "../../src/vm/enveloppe-de-cle.mjs";
import { construireEnveloppeDeRecuperation } from "../../src/vm/enveloppe-de-recuperation.mjs";
import {
  EMPLACEMENT_FORMAT_V1,
  ENVELOPPE_FORMAT_V1,
  TYPES_KEK,
} from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { TAILLE_FICHIER_ENVELOPPE } from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import {
  envelopperSousNonce,
  importerCleDeDeverrouillage,
} from "../../src/vm/enveloppe/modele-reference.mjs";
import { ouvrirPourExport } from "../../src/vm/export-du-fichier.mjs";
import { capturerInstantane } from "../../src/vm/instantane-de-reprise.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { exportVolumeToBytes } from "../../src/vm/archive-en-memoire.mjs";
import { CONSISTENCY_KINDS } from "../../src/vm/volume-export.mjs";
import { createManifest } from "../../src/vm/volume-manifest.mjs";
import { FORMAT_VOLUME_V3, FORMAT_VOLUME_V4 } from "../../src/vm/volume-chiffre-format.mjs";
import {
  composerPageAlaMain,
  identifiantDeVolume,
  supportDouble,
  suiteDOctets,
} from "./support-enveloppe-double.mjs";
import { NOM as NOM_V3, poserUnV3Reel } from "./support-volume-v3.mjs";
import { supportInstantaneDouble } from "./support-instantane-double.mjs";

// LE BUDGET DE CLÉ, DOMAINE PAR DOMAINE, MESURÉ SUR UNE SESSION COMPLÈTE (#182 ; ADR 0033,
// décision 4 ; § 4.5 de la spécification).
//
// ## Ce que la revue externe a réfuté, et ce que ce fichier rétablit
//
// Le § 4.5 affirmait compter « toutes les invocations sous une clé », et c'est l'exigence du § 8.3
// de NIST SP 800-38D. Le relecteur a montré que c'était faux, en une ligne de JSON :
//
//     { "memeCle": true, "compteurVolumeA": 1, "compteurVolumeB": 1, "sommeReelle": 2 }
//
// Les compteurs étaient locaux à une instance de `Scellement` ; deux volumes partageaient la DEK ;
// l'enveloppe et l'export scellaient hors de tout compteur. La phrase était une affirmation que
// rien ne mesurait — la forme même du défaut.
//
// **Ce fichier est la mesure.** Il intercepte `crypto.subtle.deriveKey` et `crypto.subtle.importKey`
// pour ÉTIQUETER chaque `CryptoKey` par sa provenance, puis compte les invocations de
// `crypto.subtle.encrypt` PAR CLÉ sur une session complète du produit : création d'un volume,
// versement, datation, ouverture transactionnelle, versement d'un secteur, instantané de reprise,
// enveloppe de clé, moyen de récupération, export avec archive, révocation.
//
// ## Les trois assertions, et pourquoi il en faut trois
//
//  1. **aucune invocation sous la DEK.** C'est le résultat attendu des deux tranches, et il est
//     mesuré sur les CLÉS réellement présentées à `encrypt`, pas sur les appelants ;
//  2. **les quatre domaines à USAGE UNIQUE n'ont JAMAIS deux invocations sous la même clé.** C'est
//     la condition qui rend leur budget de 1 valable — l'ADR 0033 l'appelle « la condition qui rend
//     le régime valable, et elle est écrite pour être relue » ;
//  3. **les deux domaines à COMPTEUR ont une clé par (volume, domaine), et une seule.** Deux volumes
//     sous la même DEK n'y partagent aucune clé, et le budget de chacun est celui de SA clé.

const IDENTIFIANT_A = identifiantDeVolume(0x0a);
const IDENTIFIANT_B = identifiantDeVolume(0x0b);
const TAILLE = 8 * SECTOR_SIZE;
const KEK = suiteDOctets(0x80, 32);
const KEK_RECUPERATION = suiteDOctets(0xa0, 32);
const KEK_PAGE_V1 = suiteDOctets(0xc0, 32);
const IDENTIFIANT_EMPLACEMENT_V1 = "1234123412341234";

/**
 * SONDE UNIVERSELLE : elle étiquette chaque clé par sa provenance, et compte les `encrypt` par clé.
 *
 * L'étiquette d'une clé DÉRIVÉE vient de son `info`, recalculée ici par l'encodeur DU PRODUIT pour
 * chaque (domaine, volume) attendu : la reconnaître à un sous-texte reviendrait à deviner, et un
 * encodage à champs préfixés ne se lit pas à l'œil.
 *
 * L'étiquette d'une clé IMPORTÉE vient de ses OCTETS : une clé importée depuis la DEK est nommée
 * `dek-directe`, et c'est elle que la tranche a pour objet de faire disparaître des `encrypt`.
 */
function sonde({ dek, volumes }) {
  const attendus = [];
  for (const domaine of Object.values(DOMAINES)) {
    for (const identifiantVolume of volumes) {
      attendus.push({
        etiquette: `${domaine}@${identifiantVolume.slice(0, 4)}`,
        info: encoderInfoDeDomaine({
          domaine,
          identifiantVolume,
          versionDeFormat: VERSIONS_DE_FORMAT_DE_DOMAINE[domaine],
        }),
        domaine,
      });
    }
  }
  const memes = (a, b) =>
    a instanceof Uint8Array &&
    b instanceof Uint8Array &&
    a.byteLength === b.byteLength &&
    a.every((octet, index) => octet === b[index]);

  const vraiEncrypt = crypto.subtle.encrypt.bind(crypto.subtle);
  const vraiDerive = crypto.subtle.deriveKey.bind(crypto.subtle);
  const vraiImport = crypto.subtle.importKey.bind(crypto.subtle);
  /** @type {WeakMap<CryptoKey, { etiquette: string, domaine: string | null }>} */
  const provenance = new WeakMap();
  /** @type {{ etiquette: string, domaine: string | null, invocations: number }[]} */
  const compteurs = [];

  const inscrire = (cle, etiquette, domaine) => {
    const entree = { etiquette, domaine, invocations: 0 };
    compteurs.push(entree);
    provenance.set(cle, entree);
  };

  crypto.subtle.deriveKey = async (...arguments_) => {
    const cle = await vraiDerive(...arguments_);
    const trouve = attendus.find((attendu) => memes(arguments_[0]?.info, attendu.info));
    inscrire(cle, trouve?.etiquette ?? "derivee-inconnue", trouve?.domaine ?? null);
    return cle;
  };
  crypto.subtle.importKey = async (...arguments_) => {
    const cle = await vraiImport(...arguments_);
    const brut = arguments_[0] === "raw" ? arguments_[1] : null;
    const nom = arguments_[2]?.name ?? arguments_[2];
    if (nom === "AES-GCM") {
      inscrire(cle, memes(brut, dek) ? "dek-directe" : "kek", null);
    }
    return cle;
  };
  crypto.subtle.encrypt = async (algorithme, cle, donnees) => {
    const entree = provenance.get(cle);
    if (entree === undefined) {
      compteurs.push({ etiquette: "clé-non-tracée", domaine: null, invocations: 1 });
    } else {
      entree.invocations += 1;
    }
    return vraiEncrypt(algorithme, cle, donnees);
  };

  return {
    /** Les clés AYANT SERVI à chiffrer, avec leur compte. Une clé jamais employée ne dit rien. */
    get employees() {
      return compteurs.filter((entree) => entree.invocations > 0);
    },
    rendre() {
      crypto.subtle.encrypt = vraiEncrypt;
      crypto.subtle.deriveKey = vraiDerive;
      crypto.subtle.importKey = vraiImport;
    },
  };
}

/** Un secteur entier rempli d'un motif reconnaissable. */
function secteurDe(motif) {
  return new Uint8Array(SECTOR_SIZE).fill(motif);
}

/**
 * UNE SESSION COMPLÈTE du produit, sur DEUX volumes qui partagent la même DEK.
 *
 * Les deux volumes sont le cœur du constat : `application-de-reference.mjs` donne la même clé au
 * volume de coquille et au volume applicatif. Ce que la v4 change n'est pas ce partage — il n'est
 * pas jugé — mais sa conséquence : deux identifiants, donc deux jeux de clés dérivées.
 */
async function sessionComplete(store) {
  // 1. CRÉATION du volume A, hors transaction : le versement, puis la datation.
  const verse = await openOpfsVolume({
    name: "a",
    size: TAILLE,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT_A,
    openHandle: store.openHandle,
    transactionnel: false,
    // Ce versement sera DATÉ : `daterLaCreation` est sa clôture (#182, T2b).
    clotureParDatation: true,
  });
  for (let rang = 0; rang < 4; rang += 1) {
    await verse.write(rang * SECTOR_SIZE, secteurDe(0x40 + rang));
  }
  await verse.flush();
  const empreinte = await verse.empreinteDuFichier();
  const scellementsVerses = verse.scellementsCumules;
  await verse.close();
  await daterLaCreation({
    name: "a",
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT_A,
    openHandle: store.openHandle,
    empreinteVersee: empreinte,
    scellementsVerses,
  });

  // 2. OUVERTURE TRANSACTIONNELLE du volume A : un dépôt dans le journal, une barrière, un
  //    point de contrôle à la fermeture. C'est là que les DEUX domaines à compteur travaillent.
  const backend = await openOpfsVolume({
    name: "a",
    size: TAILLE,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT_A,
    openHandle: store.openHandle,
  });
  await backend.write(SECTOR_SIZE, secteurDe(0x99));
  await backend.flush();
  await backend.close();

  // 2 bis. DÉVERROUILLER puis VERROUILLER hors transaction — le cycle de la COQUILLE, c'est-à-dire
  //    le troisième chemin hors transaction. Il écrit son secteur de serrure et clôt par une racine,
  //    et c'est le chemin que la tranche AJOUTE : l'omettre de la session laissait la mesure muette
  //    précisément là où le § 4.5 déclare l'écart fermé (revue de sécurité de la PR #187, constat 8).
  const coquille = await openOpfsVolume({
    name: "a",
    size: TAILLE,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT_A,
    openHandle: store.openHandle,
    transactionnel: false,
  });
  await coquille.write(2 * SECTOR_SIZE, secteurDe(0x77));
  await coquille.flush();
  await coquille.close();

  // 3. LE SECOND VOLUME, sous la MÊME DEK. C'est le test minimal du relecteur.
  const second = await openOpfsVolume({
    name: "b",
    size: TAILLE,
    cle: CLE_DE_TEST,
    identifiantVolume: IDENTIFIANT_B,
    openHandle: store.openHandle,
  });
  await second.write(0, secteurDe(0x11));
  await second.flush();
  await second.close();

  // 4. L'INSTANTANÉ DE REPRISE : une capture, un scellement, une clé à usage unique.
  await capturerInstantane({
    scellement: await Scellement.ouvrir({
      volume: IDENTIFIANT_A,
      cleOctets: CLE_DE_TEST,
      formatVersion: FORMAT_VOLUME_V4,
    }),
    volume: IDENTIFIANT_A,
    etatPresent: {
      sequence: 1,
      generation: 1,
      empreinteRegion: suiteDOctets(0x01, 32),
      empreinteImage: suiteDOctets(0x02, 32),
      formatVolume: FORMAT_VOLUME_V4,
    },
    etat: suiteDOctets(0x30, 256),
    support: supportInstantaneDouble(),
  });

  // 5. L'ENVELOPPE DE CLÉ : création, ajout d'un moyen de récupération, ouverture, révocation.
  const enveloppe = supportDouble();
  const creee = await creerEnveloppe({
    support: enveloppe,
    identifiantVolume: IDENTIFIANT_A,
    dek: CLE_DE_TEST,
    kek: KEK,
  });
  await ajouterEmplacement({
    support: enveloppe,
    identifiantVolume: IDENTIFIANT_A,
    kek: KEK,
    kekNouvelle: KEK_RECUPERATION,
    typeKek: TYPES_KEK.recuperation,
  });
  await ouvrirEnveloppe({ support: enveloppe, identifiantVolume: IDENTIFIANT_A, kek: KEK });

  // 6. L'EXPORT : la page de récupération rescellée, puis l'archive et son engagement.
  const recuperation = await construireEnveloppeDeRecuperation({
    support: enveloppe,
    identifiantVolume: IDENTIFIANT_A,
    kek: KEK,
  });
  const contenu = store.snapshot("a");
  await exportVolumeToBytes({
    source: {
      size: contenu.byteLength,
      read: (offset, longueur) => contenu.slice(offset, offset + longueur),
    },
    manifest: createManifest({
      formatVersion: FORMAT_VOLUME_V4,
      runtime: { version: "1.4.2", artifact: null, minWriter: "1.0.0" },
      app: { id: "railsbox-vault-reference", version: "1.0.0" },
      volumeSize: TAILLE,
      identity: { algorithm: "sha-256", digest: null },
      volume: { id: IDENTIFIANT_A, algorithm: "aes-256-gcm" },
    }),
    consistency: { kind: CONSISTENCY_KINDS.exclusiveHandle, detail: "banc de budget" },
    cle: CLE_DE_TEST,
    recovery: recuperation,
  });

  await revoquerEmplacement({
    support: enveloppe,
    identifiantVolume: IDENTIFIANT_A,
    kek: KEK,
    identifiantEmplacement: creee.identifiantEmplacement,
  });

  // 7. LA MIGRATION D'UNE PAGE v1, sur une enveloppe écrite AVANT cette tranche. C'est le geste que
  //    toute enveloppe en service subira une fois, et il scelle une racine v2 sous une clé neuve du
  //    domaine `enveloppe`. Il lit la racine v1 sous la clé de volume — mais avec l'usage `decrypt`
  //    seul, si bien qu'aucune invocation d'`encrypt` ne peut en descendre : c'est justement ce que
  //    cette mesure-ci vérifie plutôt que de le supposer.
  await migrerUnePageV1(IDENTIFIANT_A);
}

/**
 * Le fichier d'une enveloppe portant une page **v1**, composé AVANT que la sonde ne soit posée.
 *
 * La page est composée par le modèle de référence de l'ADR 0020, c'est-à-dire par le chemin qui a
 * écrit toutes les pages v1 en service. Elle est composée HORS MESURE, et c'est indispensable : une
 * racine v1 se scelle sous la clé de volume elle-même, si bien que la composer dans la session
 * ferait compter au HARNAIS le scellement que la tranche a pour objet de faire disparaître du
 * PRODUIT. Ce qui est mesuré est la MIGRATION, pas la fabrication de la pièce à conviction.
 */
async function fichierDUneEnveloppeV1(identifiantVolume) {
  const emplacement = await envelopperSousNonce({
    kek: await importerCleDeDeverrouillage(KEK_PAGE_V1),
    emplacement: {
      identifiantVolume,
      identifiantEmplacement: IDENTIFIANT_EMPLACEMENT_V1,
      formatVersion: EMPLACEMENT_FORMAT_V1,
      typeKek: TYPES_KEK.harnais,
      parametres: suiteDOctets(0xe1, 8),
    },
    dek: CLE_DE_TEST,
    nonce: suiteDOctets(0x51, 12),
  });
  const page = await composerPageAlaMain({
    identifiantVolume,
    version: 3,
    dek: CLE_DE_TEST,
    emplacements: [
      {
        identifiantEmplacement: IDENTIFIANT_EMPLACEMENT_V1,
        typeKek: TYPES_KEK.harnais,
        parametres: suiteDOctets(0xe1, 8),
        nonce: emplacement.nonce,
        dekEnveloppee: emplacement.chiffre,
        etiquette: emplacement.etiquette,
      },
    ],
    nonce: suiteDOctets(0x52, 12),
    formatVersion: ENVELOPPE_FORMAT_V1,
  });
  const octets = new Uint8Array(TAILLE_FICHIER_ENVELOPPE);
  octets.set(page, 0);
  return octets;
}

/** Ouvre l'enveloppe v1 préparée, ce qui la MIGRE — le geste que toute enveloppe en service subira. */
async function migrerUnePageV1(identifiantVolume) {
  const migree = await ouvrirEnveloppe({
    support: supportDouble({ octets: ENVELOPPE_V1.slice() }),
    identifiantVolume,
    kek: KEK_PAGE_V1,
  });
  assert.equal(migree.migration?.faite, true, "la page v1 de la session DOIT avoir migré");
}

/**
 * L'EXPORT D'UN VOLUME v3, mesuré à part — et c'est le seul segment de ce fichier qui ne soit pas un
 * chemin du format v4.
 *
 * Il est ici parce que la revue de sécurité de la PR #187 (constat 8) a raison sur le fond : une
 * sonde exhaustive jouée sur une session partielle ne prouve l'exhaustivité que de cette session. Il
 * est mesuré SÉPARÉMENT parce qu'il scelle sous la clé de volume elle-même — c'est l'unique
 * exception nommée du cliquet anti-DEK —, et fondre les deux mesures ferait disparaître l'assertion
 * qui compte : sur les chemins v4, le compte est ZÉRO, sans exception et sans nuance.
 */
async function exporterUnV3(store) {
  const ouvert = await ouvrirPourExport({
    name: NOM_V3,
    cle: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V3,
    openHandle: store.openHandle,
  });
  await ouvert.brut.close();
}

/** La pièce à conviction de la migration, composée avant toute mesure. Voir la fonction ci-dessus. */
const ENVELOPPE_V1 = await fichierDUneEnveloppeV1(IDENTIFIANT_A);

const MESURE = await (async () => {
  const store = createSyncAccessStore();
  const espion = sonde({ dek: CLE_DE_TEST, volumes: [IDENTIFIANT_A, IDENTIFIANT_B] });
  try {
    await sessionComplete(store);
    return espion.employees.map((entree) => ({ ...entree }));
  } finally {
    espion.rendre();
  }
})();

const MESURE_V3 = await (async () => {
  // Le volume v3 est PRODUIT hors mesure, comme la page v1 : sa fabrication passe par la migration
  // v2 → v3, qui scelle elle aussi sous la clé v3. Les compter ici ferait passer le coût de la pièce
  // à conviction pour celui du geste mesuré.
  const store = createSyncAccessStore();
  await poserUnV3Reel(store);
  const espion = sonde({ dek: CLE_DE_TEST, volumes: [IDENTIFIANT_A, IDENTIFIANT_B] });
  try {
    await exporterUnV3(store);
    return espion.employees.map((entree) => ({ ...entree }));
  } finally {
    espion.rendre();
  }
})();

/** Les comptes d'un domaine, dans l'ordre où ses clés ont été employées. */
const comptesDe = (domaine) =>
  MESURE.filter((entree) => entree.domaine === domaine).map((entree) => entree.invocations);

test("la session mesurée est RÉELLE : elle a chiffré, et sous plusieurs clés", () => {
  // Une mesure à vide passerait toutes les assertions qui suivent. Celle-ci dit qu'il y a eu du
  // travail, et que ce travail s'est réparti — c'est le préalable de tout le reste.
  const total = MESURE.reduce((somme, entree) => somme + entree.invocations, 0);
  assert.ok(total > 30, `seulement ${total} invocation(s) de chiffrement sur la session`);
  assert.ok(MESURE.length >= 8, `seulement ${MESURE.length} clé(s) employée(s)`);
});

test("AUCUNE invocation de `encrypt` sous la clé de volume elle-même", () => {
  // Le résultat attendu des deux tranches, mesuré sur les CLÉS présentées à WebCrypto — pas sur les
  // appelants, pas sur le texte des modules. C'est ce que le cliquet anti-DEK ne peut PAS dire.
  const directes = MESURE.filter((entree) => entree.etiquette === "dek-directe");
  assert.deepEqual(
    directes,
    [],
    "une clé AES-GCM importée depuis les octets de la DEK a chiffré : l'ADR 0033 l'interdit",
  );
});

test("l'EXPORT D'UN v3 est le seul endroit où la clé de volume chiffre, et il est COMPTÉ", () => {
  // **Revue de sécurité de la PR #187, constat 8**, et sa conséquence sur le constat 4. La session
  // mesurée plus haut ne portait aucun chemin v3, si bien que « zéro sous la clé de volume » était
  // vrai de ce qu'elle jouait et muet sur ce qu'elle ne jouait pas. Ce segment-ci joue l'export d'un
  // v3 RÉEL — produit par la migration v2 → v3, le seul geste du dépôt qui en écrive un — et mesure
  // ce qu'il scelle.
  //
  // Le compte n'est pas nul, et il ne doit pas l'être : ouvrir un v3 fait écrire une racine v3 par
  // le magasin, et rejouer une charge rescelle des secteurs. Ce qui est exigé ici est qu'il soit
  // ENTIÈREMENT attribué à la clé de volume — aucune clé de domaine n'existe dans un v3 — et
  // qu'aucune clé de provenance inconnue n'y chiffre.
  const directes = MESURE_V3.filter((entree) => entree.etiquette === "dek-directe");
  assert.ok(directes.length > 0, "un export de v3 SCELLE : la mesure ne peut pas être vide");
  assert.deepEqual(
    MESURE_V3.filter((entree) => entree.etiquette !== "dek-directe"),
    [],
    "un volume v3 n'a AUCUNE clé de domaine : tout ce qui chiffre est la clé de volume elle-même",
  );

  // Le compte exact — trois au plancher, plus un par secteur rejoué — est mesuré par
  // `vm-migration-source-v3.test.mjs`, avec la racine v3 qui le PUBLIE. Ici, ce qui importe est le
  // PLANCHER : l'empreinte de région, la racine de clôture, le témoin.
  const total = directes.reduce((somme, entree) => somme + entree.invocations, 0);
  assert.equal(
    total,
    3,
    "le PLANCHER : l'empreinte de région, la racine de clôture, le témoin — et rien à rejouer ici",
  );
});

test("AUCUNE clé employée n'échappe à la sonde : tout ce qui chiffre est nommé", () => {
  // Sans cette assertion, un chemin qui fabriquerait une clé autrement — `unwrapKey`, une clé
  // importée sous un autre format — chiffrerait sans être compté, et la mesure serait creuse.
  assert.deepEqual(
    MESURE.filter(
      (entree) => entree.etiquette === "clé-non-tracée" || entree.etiquette === "derivee-inconnue",
    ),
    [],
    "une clé de provenance inconnue a chiffré",
  );
});

test("les QUATRE domaines à USAGE UNIQUE : une clé, un scellement, jamais deux", () => {
  // La condition qui rend le budget de 1 valable (ADR 0033, décision 4). Deux invocations sous une
  // même clé à usage unique voudraient dire que le sel a été réemployé — c'est-à-dire que le régime
  // est faux, et qu'aucun compteur ne le dirait puisqu'il n'y en a pas.
  for (const domaine of [
    DOMAINES.instantane,
    DOMAINES.enveloppe,
    DOMAINES.archive,
    DOMAINES.recuperation,
  ]) {
    const comptes = comptesDe(domaine);
    assert.ok(comptes.length > 0, `le domaine « ${domaine} » n'a été employé par personne`);
    assert.deepEqual(
      comptes,
      comptes.map(() => 1),
      `le domaine « ${domaine} » a chiffré plusieurs fois sous une même clé : ${comptes.join(", ")}`,
    );
  }
});

test("les DEUX domaines à COMPTEUR : une clé par volume, réemployée, et jamais partagée", () => {
  // L'autre moitié du constat du relecteur : deux volumes sous la MÊME DEK. Chaque domaine à
  // compteur a une clé par VOLUME — la même matière d'une session à l'autre, puisque son sel est
  // vide et son info fixe —, et le budget de chacune est celui de CETTE clé.
  //
  // Ce que la sonde compte est l'objet `CryptoKey`, et une session en dérive un neuf : les
  // invocations sont donc REGROUPÉES par étiquette, qui nomme le couple (domaine, volume). C'est ce
  // couple qui décide de la matière, et c'est lui que le budget suit.
  const parEtiquette = new Map();
  for (const entree of MESURE) {
    parEtiquette.set(
      entree.etiquette,
      (parEtiquette.get(entree.etiquette) ?? 0) + entree.invocations,
    );
  }
  for (const domaine of [DOMAINES.volume, DOMAINES.journal]) {
    const etiquettes = [...parEtiquette.keys()].filter((nom) => nom.startsWith(`${domaine}@`));
    assert.deepEqual(
      etiquettes.slice().sort(),
      [`${domaine}@${IDENTIFIANT_A.slice(0, 4)}`, `${domaine}@${IDENTIFIANT_B.slice(0, 4)}`].sort(),
      `le domaine « ${domaine} » doit avoir UNE clé par volume, et deux volumes ont travaillé`,
    );
  }
  const volumeA = parEtiquette.get(`${DOMAINES.volume}@${IDENTIFIANT_A.slice(0, 4)}`);
  const volumeB = parEtiquette.get(`${DOMAINES.volume}@${IDENTIFIANT_B.slice(0, 4)}`);
  assert.ok(
    volumeA > 1 && volumeB > 1,
    `la clé du domaine « volume » est RÉEMPLOYÉE — c'est ce qui lui vaut un compteur (${volumeA}, ${volumeB})`,
  );
  assert.notEqual(
    `${DOMAINES.volume}@${IDENTIFIANT_A.slice(0, 4)}`,
    `${DOMAINES.volume}@${IDENTIFIANT_B.slice(0, 4)}`,
    "deux volumes sous la même DEK ne partagent AUCUNE clé — c'est le test minimal du relecteur",
  );
});

test("le § 4.5 est VRAI : chaque clé employée relève d'un domaine, et d'un seul", () => {
  // La phrase que la revue externe a réfutée — « toutes les invocations sous une clé » — redevient
  // vraie dès lors que toute clé qui chiffre porte un domaine et un volume. Les KEK sont l'exception
  // nommée : elles n'enveloppent QUE la DEK, elles ne descendent pas d'elle, et l'ADR 0020 les régit.
  for (const entree of MESURE) {
    assert.ok(
      entree.domaine !== null || entree.etiquette === "kek",
      `la clé « ${entree.etiquette} » chiffre sans relever d'aucun domaine`,
    );
  }
  const domainesEmployes = new Set(
    MESURE.filter((entree) => entree.domaine !== null).map((entree) => entree.domaine),
  );
  assert.deepEqual(
    [...domainesEmployes].sort(),
    Object.values(DOMAINES).slice().sort(),
    "la session complète emploie les SIX domaines : si l'un manque, la mesure ne le couvre pas",
  );
});

test("la TABLE du § 4.5 est celle que la session produit, poste par poste", () => {
  // La spécification publie une table ; elle vient d'ici, et elle y renvoie. Ce qui est épinglé
  // n'est pas un nombre d'invocations — il dépend du banc — mais la FORME du relevé : quels
  // domaines ont une clé par volume, lesquels ont une clé par artefact, et combien d'artefacts
  // cette session a scellés.
  const parDomaine = new Map();
  for (const entree of MESURE.filter((mesure) => mesure.domaine !== null)) {
    const courant = parDomaine.get(entree.domaine) ?? { cles: 0, invocations: 0 };
    parDomaine.set(entree.domaine, {
      cles: courant.cles + 1,
      invocations: courant.invocations + entree.invocations,
    });
  }
  // QUATRE pages d'enveloppe ont été écrites — créer, ajouter, révoquer, et la page v2 que la
  // MIGRATION publie à la place d'une v1 —, une page de récupération, une capture et une archive.
  // Chacune sous SA clé, et une seule fois sous elle.
  assert.equal(parDomaine.get(DOMAINES.enveloppe).cles, 4, "quatre pages d'enveloppe écrites");
  assert.equal(parDomaine.get(DOMAINES.enveloppe).invocations, 4, "une invocation par page");
  assert.equal(parDomaine.get(DOMAINES.recuperation).invocations, 1, "une page embarquée");
  assert.equal(parDomaine.get(DOMAINES.archive).invocations, 1, "un engagement d'archive");
  assert.equal(parDomaine.get(DOMAINES.instantane).invocations, 1, "une capture de reprise");
  // Et les domaines à compteur portent l'essentiel du travail : c'est ce qui justifie qu'eux seuls
  // aient un compteur, et les quatre autres aucun.
  assert.ok(
    parDomaine.get(DOMAINES.volume).invocations >
      10 * parDomaine.get(DOMAINES.enveloppe).invocations,
    "le domaine `volume` porte l'essentiel des scellements d'une session",
  );
});
