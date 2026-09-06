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
import {
  CoupureSimulee,
  identifiantDeVolume,
  supportDouble,
  suiteDOctets,
} from "./support-enveloppe-double.mjs";

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
 *
 * L'emplacement CONSERVÉ par `revoquerToutSauf` est ici celui du harnais (type 3), et les types
 * RETIRÉS puis fouillés sont donc 1, 2 et 4. « Le type 4 comme les types 1/2/3 » se lirait de
 * travers : c'est l'épreuve du conservé — « l'emplacement conservé est celui que la KEK a OUVERT » —
 * qui fait retirer le type 3, sous KEK_C.
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

  // Et l'effacement a bien eu lieu : c'est la SEULE raison d'admettre le geste quand il n'y a rien à
  // retirer. Sans cette assertion, l'épreuve accepterait un geste qui ne ferait qu'avancer un
  // compteur.
  const valides = pagesValides(support.contenu);
  assert.equal(valides.length, 1, "les deux pages font état : la libérée n'a pas été effacée.");
  const liberee = PAGES - 1 - valides[0].index;
  assert.equal(
    support.contenu
      .subarray(offsetDePage(liberee), offsetDePage(liberee) + PAGE_OCTETS)
      .reduce((somme, octet) => somme + octet, 0),
    0,
  );
});

test("RÉVOQUER TOUT SAUF : une KEK fausse est refusée comme toute mutation, sans code nouveau", async () => {
  const { support } = await enveloppeAQuatre();
  // Ce qui est mesuré est le FICHIER, pas l'inventaire : deux entiers d'une page ne disent rien de
  // l'effacement, et c'est justement l'effacement qu'un refus ne doit pas déclencher. La revue de la
  // PR #158 a relevé que la première rédaction promettait plus que ce qu'elle regardait.
  const avant = await fichierEnHex(support);
  const gestesAvant = support.gestes;

  await assert.rejects(
    () => revoquerToutSauf({ support, identifiantVolume: VOLUME, kek: suiteDOctets(0x11, 32) }),
    (erreur) => isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.cleRefusee),
  );

  assert.equal(await fichierEnHex(support), avant, "un refus a écrit dans le fichier.");
  assert.equal(
    support.gestes - gestesAvant,
    0,
    "un refus a porté un geste au support : ni écriture, ni barrière ne doivent partir.",
  );
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
  // La page qui va être LIBÉRÉE par l'ajout, et le scellement de sa racine : cette empreinte-là
  // n'existe QUE dans cette page — la page neuve rescellera la sienne sous un autre nonce. Chercher
  // un emplacement n'aurait rien mesuré, puisque la page neuve le porte aussi : la revue de la
  // PR #158 a relevé que la première rédaction ne pouvait pas rougir.
  const libereePar = (octets) => {
    const valides = pagesValides(octets);
    const autorite = valides.reduce((a, b) => (b.page.version > a.page.version ? b : a));
    return octetsEnHex(autorite.page.racine.etiquette);
  };
  const etiquetteQuiSeraLiberee = libereePar(support.contenu);

  await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: KEK_A,
    kekNouvelle: suiteDOctets(0x07, 32),
  });

  const apres = await fichierEnHex(support);
  assert.notEqual(
    libereePar(support.contenu),
    etiquetteQuiSeraLiberee,
    "l'ajout n'a pas publié de page neuve : l'épreuve ne mesure pas ce qu'elle croit.",
  );
  assert.ok(
    apres.includes(etiquetteQuiSeraLiberee),
    "l'ajout a effacé la page libérée : il n'avait rien à retirer.",
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

test("DEUX emplacements sous la MÊME KEK : le geste conserve celui de plus BAS RANG, et il est déterministe", async () => {
  // Inatteignable en production — l'info HKDF d'un dérivateur lie l'identifiant d'emplacement
  // (ADR 0021), donc deux emplacements ne partagent jamais une KEK —, mais atteignable au harnais,
  // qui pose la KEK telle quelle. Le comportement est donc ÉCRIT plutôt que laissé à découvrir :
  // `developperDansLaPage` retient le PREMIER emplacement qui ouvre, sans court-circuit, et le
  // filtre suit. Constat de la revue de la PR #158.
  const support = supportDouble();
  await creerEnveloppe({ support, identifiantVolume: VOLUME, dek: DEK, kek: KEK_A });
  await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: KEK_A,
    kekNouvelle: KEK_A, // la MÊME clé, un second emplacement
    typeKek: TYPES_KEK.phrase,
    parametres: PARAMETRES_B,
  });
  const rangs = emplacementsDeLAutorite(support.contenu).map(
    (emplacement) => emplacement.identifiantEmplacement,
  );
  assert.equal(rangs.length, 2);

  await revoquerToutSauf({ support, identifiantVolume: VOLUME, kek: KEK_A });
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME });
  assert.equal(inventaire.emplacements.length, 1);
  assert.equal(
    inventaire.emplacements[0].identifiantEmplacement,
    rangs[0],
    "le geste n'a pas conservé l'emplacement de plus bas rang : le résultat dépendrait de l'ordre de lecture.",
  );
  assert.equal(inventaire.emplacements[0].typeKek, TYPES_KEK.harnais);
});

test("LIMITE : une coupure ENTRE les deux barrières laisse la page ancienne lisible jusqu'à la mutation SUIVANTE", async () => {
  // La limite que la revue de la PR #158 a trouvée, et que l'ADR 0026 écrit plutôt que de la laisser
  // découvrir. L'effacement n'est pas atomique avec la publication — il ne peut pas l'être, et il
  // n'a pas à l'être : la page ancienne n'est plus un point de reprise. Mais si la session s'arrête
  // entre la barrière qui publie et l'écriture des zéros, RIEN ne rejoue l'effacement. Aucune
  // réparation n'est jouée à l'ouverture : ouvrir une enveloppe est une LECTURE, et un ouvreur qui
  // écrirait déplacerait la fenêtre sans la fermer, puisque la réparation elle-même peut être coupée.
  //
  // Les trois assertions sont donc, dans l'ordre : la serrure tient, les octets restent, la mutation
  // suivante les emporte. La deuxième est POSITIVE — c'est une limite qu'on fixe, pas un défaut
  // qu'on tolère en silence.
  const { support: pose } = await enveloppeAQuatre();
  const initial = pose.contenu;
  const retires = emplacementsDeLAutorite(initial).slice(1).map(empreintesDe);

  // Rang 3 : le premier geste de l'effacement. Les deux premiers — écrire la page neuve, barrière —
  // ont porté ; la page neuve est publiée.
  const coupe = supportDouble({ octets: initial, couperAvant: 3 });
  await assert.rejects(
    () => revoquerToutSauf({ support: coupe, identifiantVolume: VOLUME, kek: KEK_A }),
    (cause) => cause instanceof CoupureSimulee,
  );

  const support = supportDouble({ octets: coupe.contenu });
  const conservee = await etatSous(support, KEK_A);
  assert.ok(conservee.ouvre, "la coupure a emporté l'état publié.");
  assert.equal(conservee.version, 5, "la révocation a reculé.");
  for (const kek of [KEK_B, KEK_C, KEK_D]) {
    const retiree = await etatSous(support, kek);
    assert.equal(
      retiree.ouvre,
      false,
      "une clé retirée ouvre encore : la SERRURE serait en défaut.",
    );
    assert.equal(retiree.code, ENVELOPPE_ERROR_CODES.cleRefusee);
  }

  // La limite elle-même, mesurée : la page ancienne porte encore les cinq champs de chaque
  // emplacement retiré. Une réouverture ne les efface pas — elle ne lit rien d'autre que l'état.
  const apresCoupure = await fichierEnHex(support);
  for (const retire of retires) {
    for (const [champ, empreinte] of Object.entries(retire)) {
      assert.ok(
        apresCoupure.includes(empreinte),
        `« ${champ} » a disparu : quelque chose rejoue l'effacement, et l'ADR 0026 décrit une limite qui n'existe plus.`,
      );
    }
  }

  // Et ce qui la referme : la mutation SUIVANTE, quelle qu'elle soit, réécrit cette page entière.
  await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: KEK_A,
    kekNouvelle: suiteDOctets(0x07, 32),
  });
  await exigerAucunOctetResiduel(support, retires, "la mutation qui suit une coupure");
});
