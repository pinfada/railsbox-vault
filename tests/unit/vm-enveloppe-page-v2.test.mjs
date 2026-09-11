import assert from "node:assert/strict";
import test from "node:test";

import {
  EMPLACEMENT_FIXE_OCTETS,
  ENTETE_PAGE_OCTETS,
  ENTETE_PAGE_V2_OCTETS,
  PAGE_OCTETS,
  decoderPage,
  encoderPage,
} from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import {
  DOMAINES_DE_RACINE,
  EMPLACEMENTS_MAX,
  EMPLACEMENT_FORMAT_V1,
  ENVELOPPE_FORMAT_V1,
  ENVELOPPE_FORMAT_V2,
  PARAMETRES_MAX,
  SEL_DE_PAGE_OCTETS,
  TYPES_KEK,
} from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { suiteDOctets } from "./support-enveloppe-double.mjs";

// Ce que la page d'enveloppe **v2** COÛTE, mesuré sur les octets qu'elle rend (#182, T2b).
//
// ## Pourquoi cette épreuve existe
//
// L'ADR 0033 inscrivait un risque dans ses « Risques » : « le sel en clair élargit quatre artefacts
// de 32 octets ; pour la page d'enveloppe de 8 192 octets, cela peut coûter un emplacement dans le
// pire cas ». Le § 6.11 de la spécification y répondait par un calcul — 4 812 sur 8 192, 3 380
// libres — et `fichier-enveloppe.mjs` annonçait que ce fichier-ci le MESURAIT. La revue de la PR
// #187 a relevé que le fichier n'existait pas (constat 6 de la revue de format) : le « MESURÉ » ne
// mesurait rien, et le calcul n'était qu'une multiplication écrite à la main dans un commentaire.
//
// Un calcul juste et un encodeur juste sont deux choses différentes. Un champ oublié dans
// `encoderEmplacement`, un alignement introduit plus tard, un en-tête qui gagnerait deux octets :
// aucun ne ferait bouger la multiplication du commentaire, et tous feraient mentir la conclusion.
// Cette épreuve compose donc la PIRE page que le format autorise — huit emplacements, 512 octets de
// paramètres chacun, la borne exacte de `PARAMETRES_MAX` — et relit les quatre nombres sur les
// octets rendus par `encoderPage`.
//
// ## Ce qu'elle mesure, et ce qu'elle ne prétend pas mesurer
//
// Elle porte sur la DISPOSITION, pas sur le scellement : la racine est une suite d'octets figée, et
// aucune clé n'est dérivée ici. `vm-enveloppe-vecteurs.test.mjs` et `vm-enveloppe-v2-vecteurs.test.mjs`
// tiennent la partie cryptographique ; ce fichier tient la place que les octets prennent.

/** La borne du pire tarif : `PARAMETRES_MAX` octets de paramètres, le maximum qu'un champ déclare. */
const EMPLACEMENT_AU_PIRE_TARIF = EMPLACEMENT_FIXE_OCTETS + PARAMETRES_MAX;

const IDENTIFIANT_VOLUME = "0123456789abcdef0123456789abcdef";

/** Un emplacement au PIRE tarif, distinct de ses voisins par son identifiant. */
function emplacementAuPireTarif(rang) {
  return {
    identifiantEmplacement: `a1b2c3d4e5f6070${rang}`,
    typeKek: TYPES_KEK.phrase,
    formatVersion: EMPLACEMENT_FORMAT_V1,
    parametres: suiteDOctets(0x40 + rang, PARAMETRES_MAX),
    nonce: suiteDOctets(0x10 + rang, 12),
    dekEnveloppee: suiteDOctets(0x20 + rang, 32),
    etiquette: suiteDOctets(0x30 + rang, 16),
  };
}

/** La page la plus LOURDE que le format autorise, dans la version demandée. */
function pageLaPlusLourde(formatVersion) {
  return encoderPage({
    identifiantVolume: IDENTIFIANT_VOLUME,
    version: 1,
    formatVersion,
    racine: {
      nonce: suiteDOctets(0x01, 12),
      chiffre: suiteDOctets(0x02, 32),
      etiquette: suiteDOctets(0x03, 16),
    },
    sel: formatVersion === ENVELOPPE_FORMAT_V2 ? suiteDOctets(0x04, SEL_DE_PAGE_OCTETS) : null,
    domaine: DOMAINES_DE_RACINE.enveloppe,
    emplacements: Array.from({ length: EMPLACEMENTS_MAX }, (_, rang) =>
      emplacementAuPireTarif(rang),
    ),
  });
}

/** La longueur de liste que l'EN-TÊTE déclare, lue sur les octets plutôt que recalculée. */
function longueurDeListeDeclaree(octets) {
  return new DataView(octets.buffer, octets.byteOffset, octets.byteLength).getUint32(40, true);
}

test("la page v2 la plus LOURDE occupe 4 812 des 8 192 octets, et il en reste 3 380", () => {
  // **Le constat 6 de la revue de format.** Les quatre nombres du § 6.11 sont ici RELUS sur une page
  // réellement encodée, pas recalculés : l'en-tête que la disposition v2 déclare, la longueur de
  // liste que l'en-tête publie, leur somme, et ce qui reste après elle.
  const octets = pageLaPlusLourde(ENVELOPPE_FORMAT_V2);
  assert.equal(octets.byteLength, PAGE_OCTETS, "une page fait toujours exactement 8 192 octets");

  const longueurListe = longueurDeListeDeclaree(octets);
  assert.equal(
    longueurListe,
    EMPLACEMENTS_MAX * EMPLACEMENT_AU_PIRE_TARIF,
    "huit emplacements à 72 + 512 octets : la liste pèse 4 672 octets",
  );
  assert.equal(longueurListe, 4672);

  const occupe = ENTETE_PAGE_V2_OCTETS + longueurListe;
  assert.equal(ENTETE_PAGE_V2_OCTETS, 140, "l'en-tête v2 fait 140 octets, sel compris");
  assert.equal(occupe, 4812, "en-tête v2 + pire liste = 4 812 octets");
  assert.equal(PAGE_OCTETS - occupe, 3380, "il reste 3 380 octets libres dans la page");

  // Et ce qui reste est réellement LIBRE, pas seulement compté comme tel : le remplissage est à
  // zéro. Une page qui laisserait la queue de la précédente aurait 3 380 octets de moins à offrir —
  // et, bien pire, un emplacement révoqué encore lisible sur le disque.
  assert.ok(
    octets.subarray(occupe).every((octet) => octet === 0),
    "les 3 380 octets restants sont à ZÉRO : ils sont libres, et rien n'y traîne",
  );
});

test("le sel de la v2 ne coûte AUCUN emplacement : il coûte exactement trente-deux octets", () => {
  // La question que l'ADR 0033 posait — « cela peut coûter un emplacement dans le pire cas » — se
  // tranche en encodant la MÊME page dans les deux versions. L'écart mesuré est le sel, et rien
  // d'autre : aucun alignement, aucun champ de longueur élargi, aucun remplissage.
  const v1 = longueurDeListeDeclaree(pageLaPlusLourde(ENVELOPPE_FORMAT_V1));
  const v2 = longueurDeListeDeclaree(pageLaPlusLourde(ENVELOPPE_FORMAT_V2));
  assert.equal(
    v1,
    v2,
    "la LISTE ne change pas d'un octet entre les deux versions : seul l'en-tête",
  );

  assert.equal(ENTETE_PAGE_OCTETS + v1, 4780, "en v1, la pire page occupait 4 780 octets");
  assert.equal(
    ENTETE_PAGE_V2_OCTETS - ENTETE_PAGE_OCTETS,
    SEL_DE_PAGE_OCTETS,
    "le passage en v2 coûte le sel, et strictement le sel",
  );

  // Combien d'emplacements de plus tiendraient encore : la réponse est cinq, et c'est ce chiffre-là
  // que le § 6.11 publie. Le sel n'en coûterait un que si le plafond passait de huit à quatorze.
  const libre = PAGE_OCTETS - (ENTETE_PAGE_V2_OCTETS + v2);
  assert.equal(Math.floor(libre / EMPLACEMENT_AU_PIRE_TARIF), 5, "cinq emplacements de plus");
  assert.ok(
    ENTETE_PAGE_V2_OCTETS + (EMPLACEMENTS_MAX + 5) * EMPLACEMENT_AU_PIRE_TARIF <= PAGE_OCTETS,
    "treize emplacements au pire tarif tiennent encore dans la page v2",
  );
  assert.ok(
    ENTETE_PAGE_V2_OCTETS + (EMPLACEMENTS_MAX + 6) * EMPLACEMENT_AU_PIRE_TARIF > PAGE_OCTETS,
    "quatorze n'y tiennent plus : c'est là, et pas avant, que le sel coûterait un emplacement",
  );
});

test("la pire page se RELIT : ce qui est mesuré est une page valide, pas une taille", () => {
  // Une mesure faite sur des octets qu'aucun lecteur n'accepterait ne mesurerait rien. La pire page
  // repasse donc par le décodeur, et ses huit emplacements en ressortent entiers.
  const lue = decoderPage(pageLaPlusLourde(ENVELOPPE_FORMAT_V2));
  assert.equal(lue.valide, true, "la pire page est une page valide : CRC, en-tête et liste");
  assert.equal(lue.page.formatVersion, ENVELOPPE_FORMAT_V2);
  assert.equal(lue.page.emplacements.length, EMPLACEMENTS_MAX);
  assert.equal(lue.page.sel.byteLength, SEL_DE_PAGE_OCTETS);
  for (const emplacement of lue.page.emplacements) {
    assert.equal(emplacement.parametres.byteLength, PARAMETRES_MAX);
  }
});

test("`encoderPage` REFUSE de composer une page sans qu'on lui dise dans quelle version", () => {
  // **Le constat 5 de la revue de format.** Le défaut valait `ENVELOPPE_FORMAT_V1`, c'est-à-dire
  // l'ANCIENNE version : un appelant neuf qui oubliait le champ n'obtenait pas un refus mais une
  // page sans sel, indiscernable d'une page v1 voulue. Le défaut est retiré, et l'oubli est
  // désormais un refus TYPÉ — le même code que toute autre page qu'on ne sait pas composer.
  const composerSansVersion = () =>
    encoderPage({
      identifiantVolume: IDENTIFIANT_VOLUME,
      version: 1,
      racine: {
        nonce: suiteDOctets(0x01, 12),
        chiffre: suiteDOctets(0x02, 32),
        etiquette: suiteDOctets(0x03, 16),
      },
      emplacements: [emplacementAuPireTarif(0)],
    });

  assert.throws(composerSansVersion, (erreur) => {
    assert.equal(erreur.code, ENVELOPPE_ERROR_CODES.malforme);
    assert.match(erreur.message, /formatVersion/);
    return true;
  });

  // Et la même page composée avec une version EXPLICITE passe : c'est bien l'absence qui est
  // refusée, pas la forme de l'appel.
  assert.equal(
    encoderPage({
      identifiantVolume: IDENTIFIANT_VOLUME,
      version: 1,
      formatVersion: ENVELOPPE_FORMAT_V2,
      racine: {
        nonce: suiteDOctets(0x01, 12),
        chiffre: suiteDOctets(0x02, 32),
        etiquette: suiteDOctets(0x03, 16),
      },
      sel: suiteDOctets(0x04, SEL_DE_PAGE_OCTETS),
      domaine: DOMAINES_DE_RACINE.enveloppe,
      emplacements: [emplacementAuPireTarif(0)],
    }).byteLength,
    PAGE_OCTETS,
  );
});
