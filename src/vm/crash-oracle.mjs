// Oracle de classement après coupure (#15).
//
// Après réouverture du volume, il répond à une seule question, bloc par bloc : ce que le support
// rend est-il l'ANCIEN état, le NOUVEL état, un MÉLANGE des deux dans le même bloc, ou rien de
// connu ? Puis il en tire un verdict de volume.
//
// `docs/quality-attributes.md` demande qu'« aucun succès silencieux » ne suive une corruption. La
// règle est donc stricte dans les deux sens :
//
//  - un bloc que l'oracle ne sait PAS rattacher est `corrompu`, avec un diagnostic qui dit où et
//    quoi. Il n'est jamais ignoré, ni rangé par défaut dans la classe la plus proche ;
//  - un bloc dont l'écriture a été acquittée PUIS franchie par une barrière, et qui rend pourtant
//    l'ancien état, est `corrompu` lui aussi. C'est `SEC-DURABLE-001` lu à l'envers : le classer
//    « ancien » serait précisément le succès silencieux que le dépôt refuse.
//
// L'oracle ne promet aucune atomicité. Il MESURE. Le taux de points qui laissent « ancien ou
// nouveau » est ce que #16 devra porter à 100 % ; ici il est publié tel qu'il est.

import { JOURNAL_OPERATIONS } from "./block-journal.mjs";

/** Classes d'un bloc relu. */
export const CLASSES = Object.freeze({
  ancien: "ancien",
  nouveau: "nouveau",
  dechire: "dechire",
  corrompu: "corrompu",
});

/** Verdicts d'un volume relu. */
export const VERDICTS = Object.freeze({
  ancien: "ancien",
  nouveau: "nouveau",
  melange: "melange",
  corrompu: "corrompu",
});

function memesOctets(a, b) {
  if (a.byteLength !== b.byteLength) return false;
  for (let index = 0; index < a.byteLength; index += 1) if (a[index] !== b[index]) return false;
  return true;
}

function valider(bloc) {
  const { index, ancien, nouveau, observe } = bloc;
  if (!(ancien instanceof Uint8Array) || !(nouveau instanceof Uint8Array)) {
    throw new TypeError(`Bloc ${index} : les contenus attendus doivent être des Uint8Array.`);
  }
  if (!(observe instanceof Uint8Array)) {
    throw new TypeError(`Bloc ${index} : le contenu relu doit être un Uint8Array.`);
  }
  if (ancien.byteLength !== nouveau.byteLength || observe.byteLength !== ancien.byteLength) {
    throw new RangeError(
      `Bloc ${index} : longueur incohérente — ancien ${ancien.byteLength}, nouveau ${nouveau.byteLength}, relu ${observe.byteLength}. Compléter serait inventer des octets.`,
    );
  }
  if (memesOctets(ancien, nouveau)) {
    throw new Error(
      `Bloc ${index} : ancien et nouveau contenus indiscernables. L'oracle ne peut pas classer un bloc dont les deux états attendus sont identiques ; il rendrait un tirage au sort présenté comme une mesure.`,
    );
  }
}

/**
 * Ce que le JOURNAL dit d'un bloc : son écriture a-t-elle été acquittée, et une barrière l'a-t-elle
 * suivie ? La barrière compte à partir du numéro de séquence de la DERNIÈRE écriture couvrant le
 * bloc : un acquittement antérieur ne rend pas durable une écriture postérieure.
 */
function lireJournal(journal, offset, longueur) {
  let derniereEcriture = -1;
  let dernierAcquittement = -1;
  for (const entree of journal) {
    if (
      entree.operation === JOURNAL_OPERATIONS.write &&
      entree.offset <= offset &&
      entree.offset + entree.length >= offset + longueur
    ) {
      derniereEcriture = entree.seq;
    } else if (entree.operation === JOURNAL_OPERATIONS.flushAck) {
      dernierAcquittement = entree.seq;
    }
  }
  return {
    acquitte: derniereEcriture >= 0,
    durable: derniereEcriture >= 0 && dernierAcquittement > derniereEcriture,
  };
}

/** Classe un bloc à partir de ses seuls octets. Le journal intervient ensuite, jamais avant. */
function classerOctets({ ancien, nouveau, observe }) {
  if (memesOctets(observe, nouveau)) return { classe: CLASSES.nouveau, diagnostic: null };
  if (memesOctets(observe, ancien)) return { classe: CLASSES.ancien, diagnostic: null };

  let depuisAncien = 0;
  let depuisNouveau = 0;
  for (let index = 0; index < observe.byteLength; index += 1) {
    if (observe[index] === nouveau[index]) depuisNouveau += 1;
    else if (observe[index] === ancien[index]) depuisAncien += 1;
    else {
      return {
        classe: CLASSES.corrompu,
        diagnostic: `octet ${index} : 0x${observe[index].toString(16).padStart(2, "0")} relu, alors que l'ancien état porte 0x${ancien[index].toString(16).padStart(2, "0")} et le nouveau 0x${nouveau[index].toString(16).padStart(2, "0")}.`,
      };
    }
  }
  return {
    classe: CLASSES.dechire,
    diagnostic: `${depuisNouveau} octet(s) du nouvel état et ${depuisAncien} de l'ancien dans le même bloc.`,
  };
}

/** Verdict de volume à partir du compte par classe. Les cas sévères l'emportent. */
function verdictDuVolume(classes, total) {
  if (classes.corrompu > 0) {
    return {
      verdict: VERDICTS.corrompu,
      raison: `${classes.corrompu} bloc(s) que l'oracle ne rattache ni à l'ancien état ni au nouveau.`,
    };
  }
  if (classes.dechire > 0) {
    // Un bloc déchiré n'est ni l'ancien état ni le nouveau : au niveau du volume il rejoint
    // « corrompu ». Le compte par classe conserve la distinction — elle n'est pas perdue.
    return {
      verdict: VERDICTS.corrompu,
      raison: `${classes.dechire} bloc(s) déchiré(s) : une partie seulement des octets du bloc a atteint le support.`,
    };
  }
  if (classes.ancien === total) return { verdict: VERDICTS.ancien, raison: null };
  if (classes.nouveau === total) return { verdict: VERDICTS.nouveau, raison: null };
  return {
    verdict: VERDICTS.melange,
    raison: `${classes.nouveau} bloc(s) au nouvel état et ${classes.ancien} à l'ancien cohabitent dans le volume.`,
  };
}

/**
 * Classe un volume relu après coupure.
 *
 * @param {{ blocs: Array<{ index: number, offset: number, ancien: Uint8Array, nouveau: Uint8Array,
 *                          observe: Uint8Array }>,
 *           journal?: readonly object[] }} entree
 *   `journal` est la sortie de `BlockJournal#entries()` de la session COUPÉE, transmise avant sa
 *   mort. Absent, l'oracle classe sur les seuls octets et ne prétend rien sur la durabilité.
 * @returns {{ verdict: string, raison: string | null, atomique: boolean,
 *             classes: Record<string, number>,
 *             blocs: Array<{ index: number, offset: number, classe: string, acquitte: boolean,
 *                            durable: boolean, diagnostic: string | null }> }}
 */
export function classerVolume({ blocs, journal = [] }) {
  if (!Array.isArray(blocs) || blocs.length === 0) {
    throw new RangeError("Aucun bloc à classer : un verdict sur zéro bloc ne mesurerait rien.");
  }

  const classes = { ancien: 0, nouveau: 0, dechire: 0, corrompu: 0 };
  const detail = blocs.map((bloc) => {
    valider(bloc);
    const { acquitte, durable } = lireJournal(journal, bloc.offset, bloc.observe.byteLength);
    let { classe, diagnostic } = classerOctets(bloc);

    if (classe === CLASSES.ancien && durable) {
      classe = CLASSES.corrompu;
      diagnostic =
        "écriture acquittée puis franchie par une barrière de durabilité, pourtant absente du support : SEC-DURABLE-001 ne tient pas sur ce bloc.";
    }

    classes[classe] += 1;
    return Object.freeze({
      index: bloc.index,
      offset: bloc.offset,
      classe,
      acquitte,
      durable,
      diagnostic,
    });
  });

  const { verdict, raison } = verdictDuVolume(classes, detail.length);
  return Object.freeze({
    verdict,
    raison,
    atomique: verdict === VERDICTS.ancien || verdict === VERDICTS.nouveau,
    classes: Object.freeze(classes),
    blocs: Object.freeze(detail),
  });
}
