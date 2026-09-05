// Le dérivateur `recuperation` : HKDF-SHA-256 SEUL, sans étirement (#147, ADR 0025, décision 1).
//
// ## Pourquoi il n'y a pas d'Argon2id ici, et pourquoi ce n'est pas un affaiblissement
//
// L'ADR 0021 fait étirer la phrase parce qu'une phrase humaine est FAIBLE : elle porte quelques
// dizaines de bits au mieux, et les 64 Mio de la RFC 9106 sont ce qui rend une recherche hors ligne
// coûteuse à l'échelle de cette faiblesse. C'est une COMPENSATION, et sa contrainte est honorée ici
// plutôt que contournée : un code de récupération porte cent vingt-huit bits tirés de
// `crypto.getRandomValues`, et cent vingt-huit bits n'ont aucune faiblesse à compenser. Multiplier
// 2^128 par le coût d'un étirement ne change rien à un nombre qui est déjà hors de portée ; le
// payer coûterait en revanche 2 136 ms sur Firefox (mesure de l'ADR 0021) à chaque fois qu'un
// utilisateur ouvre son coffre par le seul moyen qui lui reste.
//
// La comparaison utile est celle-ci : une phrase de vingt-cinq bits étirée à 2^21 opérations vaut
// 2^46 ; un code de cent vingt-huit bits sans étirement vaut 2^128. L'étirement n'est pas ce qui
// fait la force d'un secret — c'est ce qui rattrape son absence.
//
// ## Le matériau : SHA-256 des seize octets, et pourquoi cet élargissement n'ajoute RIEN
//
// `deriverKek` exige trente-deux octets (garde n° 11 de la campagne de mutation de l'ADR 0021, et
// elle n'est pas affaiblie ici). Le code en fait seize. Le matériau remis à HKDF est donc le
// SHA-256 des seize octets — une fonction déterministe et publique, qui satisfait la LARGEUR du
// contrat sans y toucher.
//
// **Cet élargissement n'ajoute aucune entropie, et le dire est la moitié du travail** : l'image de
// 2^128 codes par SHA-256 compte au plus 2^128 valeurs, et l'entropie reste celle des seize octets
// tirés. Ce que le SHA-256 achète est la conformité au contrat de largeur, pas une clé plus forte.
// HKDF, lui, fait ici exactement ce que l'ADR 0021 décrit : il extrait puis étend, sous le sel de
// l'emplacement et sous une info qui lie le volume ET l'emplacement.
//
// ## L'ordre des gestes
//
// Les paramètres publics sont relus et JUGÉS avant tout — ils viennent d'un fichier —, puis l'info
// est calculée, puis seulement le code est décodé. C'est l'ordre de l'ADR 0021 : un identifiant
// malformé venu du manifeste doit faire tomber le refus AVANT qu'un secret n'existe dans le tas.
//
// La somme de contrôle, elle, est vérifiée par `decoderCode`, c'est-à-dire avant qu'aucune
// primitive ne soit appelée. Un code mal recopié rend `VAULT_DERIVATION_CODE_MAL_RECOPIE` ; un code
// bien formé mais ÉTRANGER rend une KEK, et c'est l'enveloppe qui le refuse, indiscernablement
// d'une clé révoquée. Un dérivateur ne sait pas, et ne peut pas savoir, qu'un code est faux.

import { CODE_OCTETS, decoderCode } from "./code-de-recuperation.mjs";
import { deriverKek, effacer, infoDeLEmplacement } from "./derivateur.mjs";
import { parametresRefuses } from "./derivation-errors.mjs";
import {
  SEL_RECUPERATION_OCTETS,
  decoderParametresPublics,
  encoderParametresPublics,
} from "./parametres-publics.mjs";
import { TYPES_KEK } from "../enveloppe/identite-enveloppe.mjs";
import { hexEnOctets, octetsEnHex } from "../format-chiffre/octets.mjs";

/**
 * Version du MOYEN de récupération : la forme du code, sa somme de contrôle, et la façon dont son
 * matériau est obtenu. Distincte de la version de DÉRIVATION de l'ADR 0021, qui vit dans l'info
 * HKDF, et distincte de la version du format d'enveloppe.
 */
export const RECUPERATION_VERSION = 1;

/** Tire le sel HKDF d'un emplacement de récupération : trente-deux octets, par emplacement. */
export function tirerSelDeRecuperation() {
  return octetsEnHex(crypto.getRandomValues(new Uint8Array(SEL_RECUPERATION_OCTETS)));
}

/**
 * Exige une version que ce dérivateur sait lire.
 *
 * Ces octets viennent d'un FICHIER. L'ADR 0020 les authentifie — une altération sera vue —, mais
 * l'ordre des vérifications de l'ADR 0015 vaut ici aussi : on ne dérive pas sous des paramètres
 * qu'on n'a pas encore jugés admissibles. Une version qu'on ne sait pas lire n'est jamais devinée.
 */
function exigerLaVersion(version) {
  if (version !== RECUPERATION_VERSION) {
    throw parametresRefuses(
      `la version du moyen de récupération vaut ${version} au lieu de ${RECUPERATION_VERSION}, la seule que ce Vault sait lire. Une version plus récente vient d'un produit plus récent, jamais d'un code faux.`,
      { attendu: RECUPERATION_VERSION, recu: version },
    );
  }
  return version;
}

/**
 * ÉCRIT les paramètres publics d'un emplacement de récupération.
 *
 * @param {{ sel: string, version?: number }} appel sel en hexadécimal minuscule, 32 octets
 * @returns {Uint8Array} bien en dessous du plafond de 512 octets de l'ADR 0020
 */
export function parametresDeRecuperation({ sel, version = RECUPERATION_VERSION }) {
  exigerLaVersion(version);
  return encoderParametresPublics(TYPES_KEK.recuperation, { version, sel });
}

/**
 * Le MATÉRIAU remis à HKDF : le SHA-256 des seize octets du code.
 *
 * Le tampon reçu est mis à ZÉRO dès que l'empreinte existe, y compris si le calcul échoue. C'est la
 * conduite « fait, non garanti » de la décision 7 de l'ADR 0021 : une fenêtre refermée, pas une
 * promesse — le moteur a pu copier ces octets, et rien dans le langage ne l'en empêche.
 *
 * @param {Uint8Array} octets les seize octets du code ; ils sont EFFACÉS
 * @returns {Promise<Uint8Array>} trente-deux octets
 */
export async function materiauDuCode(octets) {
  if (!(octets instanceof Uint8Array) || octets.byteLength !== CODE_OCTETS) {
    throw parametresRefuses(
      `le code à élargir fait ${octets?.byteLength ?? "une largeur inconnue"} octet(s) au lieu de ${CODE_OCTETS}.`,
      { attendu: CODE_OCTETS },
    );
  }
  try {
    return new Uint8Array(await crypto.subtle.digest("SHA-256", octets));
  } finally {
    effacer(octets);
  }
}

/**
 * Le DÉRIVATEUR `recuperation`. Il est SANS ÉTAT : aucun compteur d'essai, aucune mémoire d'un
 * refus, aucun repli vers un autre moyen.
 *
 * @returns {{ type: number, deriver: Function }}
 */
export function derivateurRecuperation() {
  return Object.freeze({
    type: TYPES_KEK.recuperation,
    deriver: async ({ parametres, identite, geste }) => {
      const valeurs = decoderParametresPublics(TYPES_KEK.recuperation, parametres);
      exigerLaVersion(valeurs.version);
      // L'info AVANT le secret : un identifiant malformé, venu du manifeste, doit faire tomber le
      // refus avant que les seize octets du code n'existent. Voir `infoDeLEmplacement`.
      const info = infoDeLEmplacement(identite);
      // Le SEL public sert aussi de sel HKDF : il est déjà propre à l'emplacement, et en tirer un
      // second n'ajouterait aucune entropie tout en ajoutant un champ à authentifier (ADR 0021).
      return deriverKek({
        materiau: await materiauDuCode(decoderCode(geste?.code)),
        sel: hexEnOctets(valeurs.sel),
        info,
      });
    },
  });
}
