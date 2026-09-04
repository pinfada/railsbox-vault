// Modèle de référence de l'INSTANTANÉ DE REPRISE (#65, ADR 0024).
//
// Spécification exécutable, pas chemin de production : il scelle et ouvre en mémoire, et les
// vecteurs qu'il produit (`tests/vectors/instantane-v1.json`) sont ce que le chemin de production
// doit reproduire octet pour octet. Même rapport qu'entre l'ADR 0015 et #18.
//
// **Deux gestes, et un seul scellement par capture.** L'ADR 0024, décision 3, l'impose : les
// données associées SONT la liaison, le clair EST l'état v86, et il n'y a pas de second sceau pour
// l'en-tête. Le prix — le verdict n'arrive qu'après avoir traversé le corps entier — est payé par
// les écarts bon marché que le chemin de production constate AVANT, sur l'en-tête en clair.
//
// La clé est REÇUE. Ce module ne dérive rien, ne conserve rien et n'ouvre aucune enveloppe : la DEK
// vient de l'ADR 0020, et le chemin qui la développe est celui de `ouverture-par-enveloppe.mjs`.

import {
  ALGORITHME_WEBCRYPTO,
  ETIQUETTE_BITS,
  ETIQUETTE_OCTETS,
  NONCE_OCTETS,
  tirerNonce,
  verifierAlgorithme,
} from "../format-chiffre/identite-logique.mjs";
import { BUDGET_SCELLEMENTS_PAR_CLE } from "../format-chiffre/identite-logique.mjs";
import { encoderLiaison, exigerLiaison } from "./identite-instantane.mjs";
import { budgetDeCle, malforme, sceauRefuse } from "./instantane-errors.mjs";

export { importerCleDeVolume } from "../format-chiffre/modele-reference.mjs";

function exigerOctets(nom, valeur, longueur) {
  if (!(valeur instanceof Uint8Array) || valeur.byteLength !== longueur) {
    throw malforme(`« ${nom} » doit faire ${longueur} octets.`, { champ: nom, attendu: longueur });
  }
  return valeur;
}

/**
 * Le budget de clé est PRÉSENTÉ, jamais supposé.
 *
 * Une capture consomme un scellement, et le § 8.3 de NIST SP 800-38D compte « all instances of the
 * authenticated encryption function ». L'omettre aurait fait un compteur faux plutôt qu'un budget
 * économisé — c'est la règle que l'ADR 0015 pose déjà pour les blocs et les racines.
 */
function exigerBudget(scellementsCumules) {
  if (scellementsCumules === undefined) {
    throw malforme(
      "« attentes.scellementsCumules » est obligatoire. Une capture consomme un scellement sous la clé de volume, et un compteur oublié n'est pas un budget économisé : c'est un budget faux.",
      { champ: "scellementsCumules" },
    );
  }
  if (!Number.isSafeInteger(scellementsCumules) || scellementsCumules < 0) {
    throw malforme(`« attentes.scellementsCumules » doit être un entier naturel.`, {
      champ: "scellementsCumules",
    });
  }
  if (scellementsCumules >= BUDGET_SCELLEMENTS_PAR_CLE) {
    throw budgetDeCle({ scellementsCumules, budget: BUDGET_SCELLEMENTS_PAR_CLE });
  }
  return scellementsCumules;
}

/**
 * Le CORPS SCELLÉ, tel que GCM le produit et le consomme : chiffré puis étiquette, dans UN tampon.
 *
 * `chiffre` et `etiquette` en sont des VUES, jamais des copies, et c'est une correction de revue :
 * un état de 253 Mo, la sortie de `encrypt` (253 Mo + 16) et une copie du chiffré faisaient TROIS
 * fois l'état. Avec la RAM invitée (512 Mio) et le tampon de rootfs (385 Mio), le pic dépassait le
 * budget publié de 1,5 Gio de `docs/quality-attributes.md`.
 *
 * Le corps est aussi ce que l'ouverture reçoit — un seul tampon, lu d'un trait, étiquette à la
 * queue. Il n'y a donc plus de `assembler` : reconstituer chiffré‖étiquette côté lecture coûtait la
 * même copie, dans l'autre sens.
 */
function vuesDuCorps(brut) {
  const corps = brut instanceof Uint8Array ? brut : new Uint8Array(brut);
  return {
    corps,
    chiffre: corps.subarray(0, corps.byteLength - ETIQUETTE_OCTETS),
    etiquette: corps.subarray(corps.byteLength - ETIQUETTE_OCTETS),
  };
}

/**
 * Scelle un instantané SOUS UN NONCE DONNÉ.
 *
 * Même avertissement que `scellerBlocSousNonce` de l'ADR 0015, et il vaut encore ici : le chemin
 * normal est `scellerInstantane`, qui tire son nonce. Cette variante existe pour figer des vecteurs
 * reproductibles et pour permettre au chemin de production de les reproduire.
 *
 * @param {{ cle: CryptoKey, liaison: object, etat: Uint8Array, nonce: Uint8Array,
 *           attentes: { scellementsCumules: number } }} appel
 * @returns {Promise<{ nonce: Uint8Array, corps: Uint8Array, chiffre: Uint8Array,
 *                     etiquette: Uint8Array }>} `chiffre` et `etiquette` sont des VUES de `corps`
 */
export async function scellerInstantaneSousNonce({ cle, liaison, etat, nonce, attentes = {} }) {
  verifierAlgorithme(liaison?.algorithme);
  exigerBudget(attentes.scellementsCumules);
  exigerOctets("nonce", nonce, NONCE_OCTETS);
  const exigee = exigerLiaison(liaison);
  if (!(etat instanceof Uint8Array)) {
    throw malforme("« etat » doit être une suite d'octets.");
  }
  if (etat.byteLength !== exigee.longueurEtat) {
    throw malforme(
      `« etat » fait ${etat.byteLength} octets alors que la liaison en déclare ${exigee.longueurEtat}. Une longueur devinée n'est pas une longueur, et celle-ci entre dans les données associées.`,
      { recu: etat.byteLength, declare: exigee.longueurEtat },
    );
  }

  const brut = await crypto.subtle.encrypt(
    {
      name: ALGORITHME_WEBCRYPTO,
      iv: nonce,
      additionalData: encoderLiaison(exigee),
      tagLength: ETIQUETTE_BITS,
    },
    cle,
    etat,
  );
  return Object.freeze({ nonce, ...vuesDuCorps(brut) });
}

/** Scelle un instantané avec un nonce TIRÉ. C'est le chemin normal. */
export async function scellerInstantane({ cle, liaison, etat, attentes = {} }) {
  return scellerInstantaneSousNonce({ cle, liaison, etat, nonce: tirerNonce(), attentes });
}

/**
 * OUVRE un instantané sous la liaison que l'appelant présente.
 *
 * Il n'y a rien à « classer » après coup, contrairement à une racine : la liaison est ENTIÈREMENT
 * dans les données associées, si bien qu'un écart quelconque tombe dans l'étiquette. Le verdict est
 * donc UN — `SCEAU_REFUSE` — et il ne prétend pas nommer la cause : un octet altéré, un en-tête
 * forgé, un corps déplacé ou une autre clé sont indiscernables. Les écarts que le chemin de
 * production sait nommer, il les nomme AVANT, sur l'en-tête en clair (ADR 0024, décision 4).
 *
 * @param {{ cle: CryptoKey, liaison: object, nonce: Uint8Array, corps: Uint8Array }} appel
 *   `corps` est le tampon UNIQUE que la capture a produit : chiffré puis étiquette. Le recevoir
 *   d'un seul tenant évite la recopie que sa reconstitution coûterait, sur un objet de 253 Mo.
 * @returns {Promise<Uint8Array>} l'état v86, ou un refus
 */
export async function ouvrirInstantane({ cle, liaison, nonce, corps }) {
  verifierAlgorithme(liaison?.algorithme);
  const exigee = exigerLiaison(liaison);
  exigerOctets("nonce", nonce, NONCE_OCTETS);
  if (!(corps instanceof Uint8Array) || corps.byteLength < ETIQUETTE_OCTETS) {
    throw malforme(
      `« corps » doit porter le chiffré ET son étiquette, soit au moins ${ETIQUETTE_OCTETS} octets.`,
    );
  }

  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: ALGORITHME_WEBCRYPTO,
          iv: nonce,
          additionalData: encoderLiaison(exigee),
          tagLength: ETIQUETTE_BITS,
        },
        cle,
        corps,
      ),
    );
  } catch (erreur) {
    // Seule une `OperationError` signifie « l'étiquette ne vérifie pas » ; tout le reste — clé du
    // mauvais type, moteur en panne — est une faute de programmation ou une panne, et la traiter
    // comme un refus de sécurité effacerait un bogue derrière un message rassurant. C'est la règle
    // du modèle de l'ADR 0015, reprise sans l'affaiblir.
    if (erreur?.name !== "OperationError") throw erreur;
    throw sceauRefuse({
      volume: exigee.volume,
      sequence: exigee.sequence,
      generation: exigee.generation,
    });
  }
}
