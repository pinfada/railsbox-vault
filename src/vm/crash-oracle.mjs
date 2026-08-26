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
  // Discernabilité OCTET PAR OCTET, et non seulement « les deux blocs diffèrent quelque part ».
  // Un seul octet commun suffit à fausser le verdict dans le sens qui arrange : avec
  // ancien [7,7,9,9] et nouveau [7,7,1,1], un support qui n'a écrit que les deux premiers octets
  // du nouvel état rend [7,7,9,9] — identique à l'ancien état, donc classé « ancien » et compté
  // ATOMIQUE, alors que c'est une déchirure. La propriété que le scénario de #15 garantit est donc
  // une PRÉCONDITION de l'instrument, vérifiée à chaque appel plutôt que supposée.
  const commun = ancien.findIndex((octet, position) => octet === nouveau[position]);
  if (commun !== -1) {
    throw new Error(
      `Bloc ${index} : ancien et nouveau contenus indiscernables à l'octet ${commun} (0x${ancien[commun].toString(16).padStart(2, "0")} des deux côtés). L'oracle exige qu'ils diffèrent en CHAQUE octet : un seul octet commun rend un bloc partiellement écrit indistinguable d'un bloc intact, et le compterait atomique.`,
    );
  }
}

/**
 * Ce que le JOURNAL dit d'un bloc : son écriture a-t-elle été acquittée, et une barrière l'a-t-elle
 * franchie ?
 *
 * `durable` demande qu'il EXISTE une écriture couvrant le bloc antérieure à un acquittement, et non
 * que la DERNIÈRE écriture le soit. La nuance décide du verdict : une génération qui écrit, franchit
 * sa barrière, puis réécrit le même bloc sans barrière — le régime même de #16 : journal, copie —
 * laisse une version acquittée ET barriérée. Si elle a disparu du support, `SEC-DURABLE-001` ne
 * tient pas, quoi qu'ait fait l'écriture suivante. Ne regarder que la dernière rendrait ce cas
 * invisible, et l'oracle classerait « ancien », donc atomique.
 */
function lireJournal(journal, offset, longueur) {
  let premiereEcriture = -1;
  let dernierAcquittement = -1;
  for (const entree of journal) {
    if (
      entree.operation === JOURNAL_OPERATIONS.write &&
      entree.offset <= offset &&
      entree.offset + entree.length >= offset + longueur
    ) {
      if (premiereEcriture === -1) premiereEcriture = entree.seq;
    } else if (entree.operation === JOURNAL_OPERATIONS.flushAck) {
      dernierAcquittement = entree.seq;
    }
  }
  return {
    acquitte: premiereEcriture >= 0,
    durable: premiereEcriture >= 0 && dernierAcquittement > premiereEcriture,
  };
}

/**
 * Classe un bloc à partir de ses seuls octets. Le journal intervient ensuite, jamais avant.
 *
 * `valider` garantit qu'aucun octet n'est commun aux deux états attendus : chaque octet relu
 * appartient donc à AU PLUS un des deux, et l'ordre des comparaisons ci-dessous n'introduit aucun
 * biais. Sans cette précondition, tester `nouveau` en premier ferait pencher tout octet ambigu du
 * côté qui arrange.
 */
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

/** Classe un bloc unique : octets d'abord, journal ensuite. Aucun compteur n'est muté ici. */
function classerBloc(bloc, journal, journalConsulte) {
  valider(bloc);
  const { acquitte, durable } = journalConsulte
    ? lireJournal(journal, bloc.offset, bloc.observe.byteLength)
    : { acquitte: null, durable: null };
  const octets = classerOctets(bloc);

  // La règle `SEC-DURABLE-001` lue à l'envers. Elle ne s'applique QUE si le journal a été consulté :
  // sans lui, « durable » est inconnu, pas faux, et présumer que non ferait passer une violation
  // pour un ancien état légitime.
  if (octets.classe === CLASSES.ancien && durable === true) {
    return Object.freeze({
      index: bloc.index,
      offset: bloc.offset,
      classe: CLASSES.corrompu,
      acquitte,
      durable,
      diagnostic:
        "écriture acquittée puis franchie par une barrière de durabilité, pourtant absente du support : SEC-DURABLE-001 ne tient pas sur ce bloc.",
    });
  }
  return Object.freeze({
    index: bloc.index,
    offset: bloc.offset,
    classe: octets.classe,
    acquitte,
    durable,
    diagnostic: octets.diagnostic,
  });
}

/**
 * Classe un volume relu après coupure.
 *
 * @param {{ blocs: Array<{ index: number, offset: number, ancien: Uint8Array, nouveau: Uint8Array,
 *                          observe: Uint8Array }>,
 *           journal?: readonly object[], sansJournal?: boolean }} entree
 *   `journal` est la sortie de `BlockJournal#entries()` de la session COUPÉE, transmise avant sa
 *   mort. Il est OBLIGATOIRE : sans lui la règle `SEC-DURABLE-001` ci-dessus est inerte, et son
 *   absence ferait monter le taux atomique sans que rien ne le dise. Un appelant qui ne veut classer
 *   que des octets — l'épreuve unitaire de l'oracle — doit poser `sansJournal: true`, et le rapport
 *   le republie : « acquitté » et « durable » valent alors `null`, jamais `false`.
 * @returns {{ verdict: string, raison: string | null, atomique: boolean,
 *             journalConsulte: boolean, entreesJournal: number,
 *             classes: Record<string, number>,
 *             blocs: Array<{ index: number, offset: number, classe: string,
 *                            acquitte: boolean | null, durable: boolean | null,
 *                            diagnostic: string | null }> }}
 */
export function classerVolume({ blocs, journal, sansJournal = false }) {
  if (!Array.isArray(blocs) || blocs.length === 0) {
    throw new RangeError("Aucun bloc à classer : un verdict sur zéro bloc ne mesurerait rien.");
  }
  if (sansJournal && journal !== undefined) {
    throw new Error(
      "Classer « sansJournal » avec un journal serait ambigu : il faut vouloir l'un ou l'autre.",
    );
  }
  if (!sansJournal && !Array.isArray(journal)) {
    throw new Error(
      "L'oracle exige le journal de la session coupée. Sans lui, la règle SEC-DURABLE-001 est inerte et le taux atomique monte sans raison. Poser « sansJournal: true » pour ne classer que des octets, et l'assumer.",
    );
  }

  const journalConsulte = !sansJournal;
  const entrees = journalConsulte ? journal : [];
  const detail = blocs.map((bloc) => classerBloc(bloc, entrees, journalConsulte));

  const classes = Object.freeze(
    detail.reduce((compte, bloc) => ({ ...compte, [bloc.classe]: compte[bloc.classe] + 1 }), {
      ancien: 0,
      nouveau: 0,
      dechire: 0,
      corrompu: 0,
    }),
  );
  const { verdict, raison } = verdictDuVolume(classes, detail.length);
  return Object.freeze({
    verdict,
    raison,
    atomique: verdict === VERDICTS.ancien || verdict === VERDICTS.nouveau,
    // Publiés pour que « la règle SEC-DURABLE a-t-elle seulement pu se déclencher ? » soit une
    // question à laquelle le compte rendu répond, et non une hypothèse du lecteur.
    journalConsulte,
    entreesJournal: entrees.length,
    classes,
    blocs: Object.freeze(detail),
  });
}
