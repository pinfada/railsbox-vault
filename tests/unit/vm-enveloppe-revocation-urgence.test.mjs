import assert from "node:assert/strict";
import test from "node:test";

import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import {
  PAGE_OCTETS,
  PAGES,
  TAILLE_FICHIER_ENVELOPPE,
  decoderPage,
  offsetDePage,
} from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  ajouterEmplacement,
  creerEnveloppe,
  inventorierEnveloppe,
  ouvrirEnveloppe,
  remplacerEmplacement,
  revoquerEmplacement,
  revoquerToutSauf,
} from "../../src/vm/enveloppe-de-cle.mjs";
import { identifiantDeVolume, supportDouble, suiteDOctets } from "./support-enveloppe-double.mjs";

// LA RÉVOCATION D'URGENCE, et l'EFFACEMENT DE LA PAGE LIBRE (#148, #156, ADR 0026).
//
// Deux promesses, et elles ne se démontrent pas au même endroit :
//
//  1. **un geste retire tous les emplacements sauf celui que l'on tient**, en une version et une
//     barrière. L'emplacement conservé n'est pas DÉSIGNÉ : c'est celui que la KEK présentée ouvre.
//     On ne garde pas un emplacement qu'on ne sait pas ouvrir, et c'est ce qui empêche de conserver
//     par erreur celui d'un adversaire ;
//  2. **après toute révocation, la page libre ne porte plus les octets des emplacements retirés.**
//     C'est le constat de #156 : l'alternance de pages de l'ADR 0020 laissait la page précédente
//     intacte jusqu'au geste suivant, et une copie du fichier prise au bon moment la portait encore.
//
// L'atomicité de ces gestes, coupure par coupure, est éprouvée dans `vm-enveloppe-coupures.test.mjs`
// — la matrice est le lieu de cette question. Ce fichier-ci mesure l'ÉTAT D'APRÈS, sur les octets
// bruts du fichier entier plutôt que sur ce qu'un inventaire veut bien en dire.

const VOLUME = identifiantDeVolume(0x0a);
const DEK = suiteDOctets(0x20, 32);
const KEK_A = suiteDOctets(0x80, 32);
const KEK_B = suiteDOctets(0xa0, 32);
const KEK_C = suiteDOctets(0xc0, 32);
const KEK_D = suiteDOctets(0x40, 32);

/**
 * Les paramètres publics de chaque emplacement ajouté, distincts et RECONNAISSABLES.
 *
 * Ils tiennent le rôle du sel d'un dérivateur : ce sont les octets qu'une révocation doit faire
 * disparaître du fichier, et une suite reconnaissable est ce qui permet de les chercher.
 */
const PARAMETRES_B = suiteDOctets(0xf0, 24);
const PARAMETRES_C = suiteDOctets(0x60, 24);
const PARAMETRES_D = suiteDOctets(0x30, 24);

/**
 * Enveloppe à QUATRE emplacements, de quatre types distincts — harnais, phrase, webauthn-prf,
 * récupération.
 *
 * Les quatre types comptent : #156 a été mesuré sur le type 4, et sa conclusion valait pour tous,
 * puisque c'est l'alternance de pages qui la produit. Une épreuve qui n'éprouverait que le type 4
 * laisserait croire le contraire.
 */
async function enveloppeAQuatre() {
  const support = supportDouble();
  const creee = await creerEnveloppe({ support, identifiantVolume: VOLUME, dek: DEK, kek: KEK_A });
  const ajouts = [
    { kekNouvelle: KEK_B, typeKek: TYPES_KEK.phrase, parametres: PARAMETRES_B },
    { kekNouvelle: KEK_C, typeKek: TYPES_KEK["webauthn-prf"], parametres: PARAMETRES_C },
    { kekNouvelle: KEK_D, typeKek: TYPES_KEK.recuperation, parametres: PARAMETRES_D },
  ];
  for (const ajout of ajouts) {
    await ajouterEmplacement({ support, identifiantVolume: VOLUME, kek: KEK_A, ...ajout });
  }
  return { support, identifiantEmplacement: creee.identifiantEmplacement };
}

/** Les octets du fichier ENTIER — les deux pages —, en hexadécimal. */
async function fichierEnHex(support) {
  const { taille } = await support.etat();
  assert.equal(taille, TAILLE_FICHIER_ENVELOPPE, "le fichier a changé de taille.");
  return octetsEnHex(await support.lire(0, taille));
}

/**
 * TOUT ce qu'un emplacement pose sur le disque : son identité, ses paramètres, et son scellement.
 *
 * L'épreuve cherche ces cinq suites dans le fichier entier. Chercher les seuls paramètres, comme le
 * faisait la première rédaction de l'épreuve de #155, laisserait passer une DEK enveloppée intacte.
 */
function empreintesDe(emplacement) {
  return Object.freeze({
    identifiant: emplacement.identifiantEmplacement,
    parametres: octetsEnHex(emplacement.parametres),
    nonce: octetsEnHex(emplacement.nonce),
    dekEnveloppee: octetsEnHex(emplacement.dekEnveloppee),
    etiquette: octetsEnHex(emplacement.etiquette),
  });
}

/** Les pages STRUCTURELLEMENT valides d'un fichier, dans l'ordre du fichier. */
function pagesValides(octets) {
  const valides = [];
  for (let index = 0; index < PAGES; index += 1) {
    const lue = decoderPage(
      octets.subarray(offsetDePage(index), offsetDePage(index) + PAGE_OCTETS),
    );
    if (lue.valide) valides.push({ index, page: lue.page });
  }
  return valides;
}

/** Les emplacements tels que la page qui fait autorité les porte, scellement compris. */
function emplacementsDeLAutorite(octets) {
  const valides = pagesValides(octets);
  assert.ok(valides.length > 0, "aucune page valide : le fichier n'est plus un état.");
  return valides.reduce((a, b) => (b.page.version > a.page.version ? b : a)).page.emplacements;
}

/** Ouvre, ou rend le code du refus. Jamais les deux, jamais un « peut-être ». */
async function etatSous(support, kek) {
  try {
    const ouverte = await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek });
    return {
      ouvre: true,
      version: ouverte.version,
      identifiantEmplacement: ouverte.identifiantEmplacement,
    };
  } catch (cause) {
    if (!isEnveloppeError(cause)) throw cause;
    return { ouvre: false, version: null, code: cause.code };
  }
}

/** Assertion centrale : plus AUCUN octet de ces emplacements dans les 16 384 du fichier. */
async function exigerAucunOctetResiduel(support, retires, geste) {
  const fichier = await fichierEnHex(support);
  for (const retire of retires) {
    for (const [champ, empreinte] of Object.entries(retire)) {
      assert.ok(
        !fichier.includes(empreinte),
        `${geste} : « ${champ} » d'un emplacement retiré subsiste dans le fichier — la page libre le garde.`,
      );
    }
  }
}

// --- Le geste composé ---------------------------------------------------------------------------

test("RÉVOQUER TOUT SAUF : trois emplacements retirés en UNE version, et la clé tenue ouvre encore", async () => {
  const { support } = await enveloppeAQuatre();
  const avant = await inventorierEnveloppe({ support, identifiantVolume: VOLUME });
  assert.equal(avant.emplacements.length, 4);
  assert.equal(avant.version, 4);

  const geste = await revoquerToutSauf({ support, identifiantVolume: VOLUME, kek: KEK_A });

  // UNE version de plus, pas trois : c'est toute la raison d'être de l'opération. Trois révocations
  // successives auraient porté le compteur à 7, et laissé deux états intermédiaires derrière elles.
  assert.equal(geste.version, 5);
  assert.equal(geste.nombreEmplacements, 1);

  const conservee = await etatSous(support, KEK_A);
  assert.ok(conservee.ouvre, "la clé que l'on tient n'ouvre plus l'enveloppe qu'elle a réduite.");
  assert.equal(conservee.version, 5);
  for (const [nom, kek] of [
    ["phrase", KEK_B],
    ["webauthn-prf", KEK_C],
    ["récupération", KEK_D],
  ]) {
    const retiree = await etatSous(support, kek);
    assert.equal(
      retiree.ouvre,
      false,
      `la clé « ${nom} » ouvre encore après la révocation d'urgence.`,
    );
    assert.equal(
      retiree.code,
      ENVELOPPE_ERROR_CODES.cleRefusee,
      `refus inattendu pour « ${nom} ».`,
    );
  }
});

test("RÉVOQUER TOUT SAUF : l'emplacement conservé est celui que la KEK a OUVERT, jamais un autre", async () => {
  // Il n'y a PAS de paramètre pour désigner l'emplacement à garder, et c'est la décision : on ne
  // conserve que ce qu'on sait ouvrir. L'épreuve le montre en jouant le même geste sur le même
  // fichier sous deux clés différentes — deux emplacements conservés différents.
  const depart = await enveloppeAQuatre();
  const octets = depart.support.contenu;
  const initiaux = emplacementsDeLAutorite(octets).map(
    (emplacement) => emplacement.identifiantEmplacement,
  );
  assert.equal(new Set(initiaux).size, 4);

  const survivantSous = async (kek) => {
    const support = supportDouble({ octets });
    await revoquerToutSauf({ support, identifiantVolume: VOLUME, kek });
    const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME });
    assert.equal(inventaire.emplacements.length, 1);
    const ouverte = await etatSous(support, kek);
    assert.ok(ouverte.ouvre, "la clé qui a commandé le geste ne rouvre pas l'enveloppe.");
    assert.equal(
      ouverte.identifiantEmplacement,
      inventaire.emplacements[0].identifiantEmplacement,
      "l'emplacement conservé n'est pas celui que cette clé ouvre.",
    );
    return inventaire.emplacements[0];
  };

  const parA = await survivantSous(KEK_A);
  const parC = await survivantSous(KEK_C);
  assert.notEqual(
    parA.identifiantEmplacement,
    parC.identifiantEmplacement,
    "deux clés différentes conservent le même emplacement : le geste ne suit pas la clé présentée.",
  );
  assert.equal(parA.typeKek, TYPES_KEK.harnais);
  assert.equal(parC.typeKek, TYPES_KEK["webauthn-prf"]);
});

test("RÉVOQUER TOUT SAUF : un SEUL emplacement présent est ADMIS, et la version avance quand même", async () => {
  // Il n'y a rien à retirer, et le geste écrit tout de même : c'est l'effacement de la page libre
  // qui le rend utile. Un refus ici ferait de « je révoque tout sauf ma clé » un geste dont l'issue
  // dépend d'un état que l'appelant d'urgence n'a pas à connaître.
  const support = supportDouble();
  await creerEnveloppe({ support, identifiantVolume: VOLUME, dek: DEK, kek: KEK_A });
  const geste = await revoquerToutSauf({ support, identifiantVolume: VOLUME, kek: KEK_A });

  assert.equal(geste.version, 2);
  assert.equal(geste.nombreEmplacements, 1);
  const relue = await etatSous(support, KEK_A);
  assert.ok(relue.ouvre);
  assert.equal(relue.version, 2);
});

test("RÉVOQUER TOUT SAUF : une KEK fausse est refusée comme toute mutation, sans code nouveau", async () => {
  const { support } = await enveloppeAQuatre();
  await assert.rejects(
    () => revoquerToutSauf({ support, identifiantVolume: VOLUME, kek: suiteDOctets(0x11, 32) }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.cleRefusee),
  );
  // Et le fichier n'a pas bougé : un refus n'écrit rien, pas même l'effacement.
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME });
  assert.equal(inventaire.version, 4);
  assert.equal(inventaire.emplacements.length, 4);
});

// --- L'effacement de la page libre (#156) -------------------------------------------------------

test("RÉVOQUER TOUT SAUF : aucun octet des emplacements retirés dans les 16 384 du fichier", async () => {
  const { support } = await enveloppeAQuatre();
  const retires = emplacementsDeLAutorite(support.contenu).slice(1).map(empreintesDe);
  assert.equal(retires.length, 3);
  // Témoin de la fouille : AVANT le geste, ces octets sont bien là. Sans lui, une recherche cassée
  // passerait pour une preuve.
  const avant = await fichierEnHex(support);
  for (const retire of retires) assert.ok(avant.includes(retire.dekEnveloppee));

  await revoquerToutSauf({ support, identifiantVolume: VOLUME, kek: KEK_A });
  await exigerAucunOctetResiduel(support, retires, "révoquer tout sauf");
});

test("RÉVOQUER : aucun octet de l'emplacement retiré dans les 16 384 du fichier", async () => {
  // C'est le constat de #156 posé sur la révocation ORDINAIRE : elle ne réécrivait qu'une page, et
  // l'autre gardait l'emplacement retiré jusqu'au geste suivant.
  const { support } = await enveloppeAQuatre();
  const cible = emplacementsDeLAutorite(support.contenu)[3];
  const retire = empreintesDe(cible);
  assert.ok((await fichierEnHex(support)).includes(retire.dekEnveloppee));

  await revoquerEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: KEK_A,
    identifiantEmplacement: cible.identifiantEmplacement,
  });
  await exigerAucunOctetResiduel(support, [retire], "révoquer");
});

test("REMPLACER : l'ancien emplacement RETIRÉ ne laisse pas ses octets dans la page libre", async () => {
  // `remplacer` retire une clé, lui aussi. La règle est donc la même — tout retrait efface —, et
  // laisser l'ancien scellement dans la page libre ferait de la rotation d'une clé compromise un
  // geste qui ne retire rien pendant une mutation entière.
  const { support } = await enveloppeAQuatre();
  const cible = emplacementsDeLAutorite(support.contenu)[1];
  const retire = empreintesDe(cible);

  await remplacerEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: KEK_A,
    identifiantEmplacement: cible.identifiantEmplacement,
    kekNouvelle: suiteDOctets(0x05, 32),
    typeKek: TYPES_KEK.phrase,
    parametres: suiteDOctets(0x91, 24),
  });
  await exigerAucunOctetResiduel(support, [retire], "remplacer");
});

test("AJOUTER n'efface RIEN : il ne retire aucune clé", async () => {
  // La règle est « tout RETRAIT efface », pas « toute mutation efface ». Un ajout qui écraserait la
  // page libre paierait une écriture et une barrière pour rien, et retirerait au passage le point de
  // reprise que l'alternance offre au geste SUIVANT.
  const { support } = await enveloppeAQuatre();
  const avant = emplacementsDeLAutorite(support.contenu)[2];
  await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: KEK_A,
    kekNouvelle: suiteDOctets(0x07, 32),
  });

  const apres = await fichierEnHex(support);
  assert.ok(
    apres.includes(octetsEnHex(avant.dekEnveloppee)),
    "l'ajout a effacé la page libre : il n'avait rien à retirer.",
  );
  assert.deepEqual(
    pagesValides(support.contenu).map(({ index }) => index),
    [0, 1],
    "l'ajout a rendu une page invalide.",
  );
});

test("EFFACEMENT : la page libérée est mise à ZÉRO en ENTIER, pas seulement sa liste", async () => {
  // Une page dont on n'effacerait que la partie utile laisserait le remplissage de la version
  // d'avant — c'est-à-dire, sur une enveloppe qui a été plus grande, la queue d'emplacements plus
  // anciens encore. L'épreuve mesure les 8192 octets.
  const { support } = await enveloppeAQuatre();
  await revoquerToutSauf({ support, identifiantVolume: VOLUME, kek: KEK_A });

  const octets = support.contenu;
  const valides = pagesValides(octets);
  assert.equal(valides.length, 1, "après une révocation, une seule page fait état — la neuve.");
  const liberee = PAGES - 1 - valides[0].index;
  const libre = octets.subarray(offsetDePage(liberee), offsetDePage(liberee) + PAGE_OCTETS);
  assert.equal(
    libre.reduce((somme, octet) => somme + octet, 0),
    0,
    "la page libérée porte encore des octets non nuls.",
  );
});
