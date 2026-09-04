// Le dérivateur `phrase` : Argon2id RFC 9106, puis HKDF (#22, ADR 0021, décision 3).
//
// ## La calibration, et pourquoi c'est la RFC qui la fixe
//
// La RFC 9106 § 4 publie DEUX jeux recommandés. Le second — m = 64 Mio, t = 3, p = 4 — est retenu
// tel quel, et il sert à la fois de calibration ET de PLANCHER. Ce n'est pas de la paresse : un
// plancher que le dépôt inventerait plus bas que la RFC serait un plancher que le dépôt aurait
// choisi pour aller plus vite, c'est-à-dire exactement ce que le contrat de #22 interdit. Les
// mesures sur les trois moteurs (`docs/quality-attributes.md`) ont confirmé que ce coût tient dans
// un déverrouillage interactif ; s'il ne l'avait pas fait, c'est le PRODUIT qui aurait dû changer,
// pas le plancher.
//
// Le plancher est vérifié à DEUX moments et pour deux raisons distinctes :
//
//  - à l'écriture des paramètres, pour qu'un emplacement ne puisse pas naître affaibli ;
//  - à la LECTURE, avant de dériver, parce que ces octets viennent d'un fichier. L'ADR 0020 les
//    authentifie — une altération sera vue —, mais l'ordre des vérifications de l'ADR 0015 vaut
//    ici aussi : on ne dérive pas sous des paramètres qu'on n'a pas encore jugés admissibles.
//
// ## Il y a aussi un PLAFOND, et il ferme l'autre moitié de la même porte
//
// Le plancher regarde vers le bas : un adversaire qui écrit `<volume>.cles` ne peut pas rendre la
// dérivation bon marché. Il ne regardait pas vers le haut, et le même adversaire pouvait y écrire
// un coût démesuré : le Worker de confiance repartait calculer pendant des heures à chaque
// tentative de déverrouillage, sans que rien ne le dise ni ne l'annule. Les deux bornes sont donc
// vérifiées par la MÊME garde, aux deux mêmes moments, et sous le même refus — c'est la même
// question, « ces paramètres décrivent-ils une dérivation admissible ? », et le même remède.
//
// ## La NFC est appliquée, et elle est ÉCRITE
//
// Une phrase est une suite de caractères Unicode, et « é » s'écrit de deux façons qu'aucun clavier
// ne distingue à l'œil. Sans normalisation, une phrase tapée sur un clavier de macOS n'ouvrirait
// pas ce qu'une phrase tapée sur un clavier de Windows a fermé, et le produit dirait « clé
// refusée » à quelqu'un qui a tapé la bonne phrase. NFC est appliquée, et le dire est la moitié du
// travail : une normalisation silencieuse est une transformation du secret que l'utilisateur ne
// peut pas prévoir.
//
// Ce qui n'est PAS fait, et qui est hors périmètre par le contrat de #22 : aucune espace n'est
// rognée, aucune casse n'est modifiée, et la « force » de la phrase n'est pas évaluée. Rogner une
// espace finale changerait le secret sans le dire ; l'évaluer est l'affaire de l'interface (#24).

import { effacer, deriverKekPourEmplacement } from "./derivateur.mjs";
import { parametresRefuses, phraseRefusee } from "./derivation-errors.mjs";
import { ARGON2_VERSION, argon2Vendu } from "./argon2-vendu.mjs";
import {
  SEL_PHRASE_OCTETS,
  decoderParametresPublics,
  encoderParametresPublics,
} from "./parametres-publics.mjs";
import { TYPES_KEK } from "../enveloppe/identite-enveloppe.mjs";
import { hexEnOctets, octetsEnHex } from "../format-chiffre/octets.mjs";

/** Numéro de la variante Argon2id dans `argon2.h`. Il entre dans les paramètres publics. */
export const ARGON2ID = 2;

/**
 * PLANCHER de coût : la deuxième option recommandée par la RFC 9106 § 4, mot pour mot.
 *
 * Aucun emplacement ne naît en dessous, et aucun emplacement lu en dessous n'est dérivé. Le
 * franchir vers le HAUT est permis — un exploitant qui veut payer plus le peut —, vers le bas
 * jamais.
 */
export const PLANCHER_RFC9106 = Object.freeze({
  memoireKio: 65536,
  iterations: 3,
  parallelisme: 4,
  version: ARGON2_VERSION,
});

/**
 * PLAFOND de coût, et il ferme l'attaque SYMÉTRIQUE de celle que ferme le plancher.
 *
 * Le plancher empêche un adversaire qui écrit `<volume>.cles` d'AFFAIBLIR la dérivation. Rien
 * n'empêchait le même adversaire de la rendre démesurée : `memoireKio = 1048576`,
 * `iterations = 100000`, `parallelisme = 255` tiennent dans soixante-neuf octets encodés, très en
 * dessous du plafond de 512 de l'ADR 0020, et le Worker de confiance serait parti calculer pendant
 * des heures à chaque tentative de déverrouillage — un déni de service DURABLE, réécrit dans le
 * fichier, que l'utilisateur ne peut ni voir ni annuler.
 *
 * Les trois bornes sont MESURÉES, pas devinées. Le coût d'Argon2 est linéaire en mémoire × passes,
 * vérifié sur l'artefact vendu (×2 et ×4 pour ×2 et ×4 du produit), et le moteur le plus lent de la
 * matrice est Firefox : 2 141 ms pour la calibration (64 Mio, 3 passes) selon les mesures de
 * l'ADR 0021. Le pire cas admissible — 1 Gio, 10 passes — vaut 53,3 fois ce produit, soit environ
 * **114 secondes sur Firefox** et une vingtaine de secondes sur les deux autres. C'est long, et
 * c'est le point : la borne rend le pire cas MESURABLE et récupérable, là où `iterations = 100000`
 * valait vingt heures. Les voies, elles, ne coûtent pas — elles découpent la même mémoire —, et
 * seize est la largeur au-delà de laquelle aucun moteur n'a de parallélisme à offrir.
 */
export const PLAFOND_ADMISSIBLE = Object.freeze({
  memoireKio: 1048576,
  iterations: 10,
  parallelisme: 16,
});

/** CALIBRATION retenue. Elle vaut le plancher : voir l'en-tête, et les mesures de l'ADR 0021. */
export const CALIBRATION_PHRASE = Object.freeze({
  memoireKio: PLANCHER_RFC9106.memoireKio,
  iterations: PLANCHER_RFC9106.iterations,
  parallelisme: PLANCHER_RFC9106.parallelisme,
});

/** Tire un sel d'emplacement : seize octets, la largeur que la RFC 9106 recommande. */
export function tirerSelDePhrase() {
  return octetsEnHex(crypto.getRandomValues(new Uint8Array(SEL_PHRASE_OCTETS)));
}

/** Refuse un jeu de coûts hors des bornes. Le message NOMME le champ, et de quel côté il sort. */
function exigerLesBornes(valeurs) {
  for (const champ of ["memoireKio", "iterations", "parallelisme"]) {
    if (valeurs[champ] < PLANCHER_RFC9106[champ]) {
      throw parametresRefuses(
        `« ${champ} » vaut ${valeurs[champ]}, sous le plancher de ${PLANCHER_RFC9106[champ]} que la RFC 9106 § 4 recommande. Un coût plus bas rendrait un volume volé cassable, et ce dépôt ne descend jamais sous la RFC pour aller plus vite.`,
        { champ, plancher: PLANCHER_RFC9106[champ], recu: valeurs[champ] },
      );
    }
    if (valeurs[champ] > PLAFOND_ADMISSIBLE[champ]) {
      throw parametresRefuses(
        `« ${champ} » vaut ${valeurs[champ]}, au-delà du plafond de ${PLAFOND_ADMISSIBLE[champ]}. Un coût démesuré écrit dans le fichier n'est pas une clé plus forte : c'est un déni de service durable du Worker de confiance, qui repartirait calculer pendant des heures à chaque tentative.`,
        { champ, plafond: PLAFOND_ADMISSIBLE[champ], recu: valeurs[champ] },
      );
    }
  }
  if (valeurs.version !== ARGON2_VERSION) {
    throw parametresRefuses(
      `la version d'Argon2 vaut 0x${valeurs.version.toString(16)} au lieu de 0x13, la seule que la RFC 9106 définit.`,
      { attendu: ARGON2_VERSION, recu: valeurs.version },
    );
  }
  if (valeurs.variante !== ARGON2ID) {
    throw parametresRefuses(
      `la variante vaut ${valeurs.variante} au lieu de ${ARGON2ID} (Argon2id). Argon2d est vulnérable aux canaux auxiliaires et Argon2i n'est pas servi par ce dépôt (voir argon2-vendu.mjs).`,
      { attendu: ARGON2ID, recu: valeurs.variante },
    );
  }
  return valeurs;
}

/**
 * ÉCRIT les paramètres publics d'un emplacement `phrase`, entre le plancher de la RFC et le plafond.
 *
 * @param {{ sel: string, memoireKio?: number, iterations?: number, parallelisme?: number }} appel
 * @returns {Uint8Array} au plus 512 octets, prêts à entrer dans les données associées (ADR 0020)
 */
export function parametresDePhrase({ sel, ...couts }) {
  const valeurs = {
    version: ARGON2_VERSION,
    variante: ARGON2ID,
    ...CALIBRATION_PHRASE,
    ...couts,
    sel,
  };
  exigerLesBornes(valeurs);
  return encoderParametresPublics(TYPES_KEK.phrase, valeurs);
}

/** Exige une phrase. Une chaîne vide ou blanche n'est pas une phrase, et le dire n'est pas un oracle. */
function exigerLaPhrase(phrase) {
  if (typeof phrase !== "string") {
    throw phraseRefusee(`ce n'est pas une chaîne de caractères (${typeof phrase}).`);
  }
  if (phrase.trim().length === 0) {
    throw phraseRefusee("elle est vide, ou ne contient que des blancs.");
  }
  // NFC, et RIEN d'autre : ni rognage, ni changement de casse. Voir l'en-tête de ce fichier.
  return new TextEncoder().encode(phrase.normalize("NFC"));
}

/**
 * Le DÉRIVATEUR `phrase`.
 *
 * @param {{ argon2?: { hacher: Function } }} [primitives]
 * @returns {{ type: number, deriver: Function }}
 */
export function derivateurPhrase({ argon2 = argon2Vendu() } = {}) {
  return Object.freeze({
    type: TYPES_KEK.phrase,
    deriver: async ({ parametres, identite, geste }) => {
      const valeurs = exigerLesBornes(decoderParametresPublics(TYPES_KEK.phrase, parametres));
      const mot = exigerLaPhrase(geste?.phrase);
      try {
        const materiau = await argon2.hacher({
          variante: "id",
          mot,
          sel: hexEnOctets(valeurs.sel),
          memoireKio: valeurs.memoireKio,
          iterations: valeurs.iterations,
          parallelisme: valeurs.parallelisme,
          longueur: 32,
        });
        // Le SEL public sert aussi de sel HKDF : il est déjà propre à l'emplacement, et en tirer
        // un second n'ajouterait aucune entropie tout en ajoutant un champ à authentifier.
        return await deriverKekPourEmplacement({
          materiau,
          sel: hexEnOctets(valeurs.sel),
          identite,
        });
      } finally {
        effacer(mot);
      }
    },
  });
}
