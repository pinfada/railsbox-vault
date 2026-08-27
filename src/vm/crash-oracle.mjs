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

/**
 * Nom du verdict d'une génération de rang `rang` sur `dernier` générations attendues.
 *
 * Les deux extrêmes gardent les noms de #15 — `ancien` quand rien n'a été publié, `nouveau` quand
 * tout l'a été — parce que ce sont les mêmes états, et qu'un relevé doit rester comparable.
 */
export function verdictDeGeneration(rang, dernier) {
  if (rang === 0) return VERDICTS.ancien;
  if (rang === dernier) return VERDICTS.nouveau;
  return `generation-${rang}`;
}

/** Vrai si `verdict` nomme une génération validée — donc un volume laissé dans un état admissible. */
export function estVerdictAtomique(verdict) {
  return (
    verdict === VERDICTS.ancien ||
    verdict === VERDICTS.nouveau ||
    /^generation-[1-9][0-9]*$/.test(verdict)
  );
}

/** Vrai si `verdict` est un verdict que cet oracle sait produire. */
export function estVerdictConnu(verdict) {
  return (
    estVerdictAtomique(verdict) || verdict === VERDICTS.melange || verdict === VERDICTS.corrompu
  );
}

function memeEnsemble(observes, attendus) {
  return observes.size === attendus.length && attendus.every((index) => observes.has(index));
}

/**
 * Contrôle la SUITE DE GÉNÉRATIONS attendue, et refuse tout ce qui n'en est pas une.
 *
 * C'est le garde-fou de l'oracle contre son propre appelant. Sans lui, la liste des états acceptés
 * serait un paramètre libre : un scénario pourrait y glisser un état de plus — celui que son
 * mécanisme produit — et faire passer un mélange pour une génération. La suite doit donc partir de
 * l'ensemble VIDE, croître STRICTEMENT par inclusion, et finir sur la totalité des blocs suivis.
 * Ces trois règles n'admettent qu'une seule suite pour un scénario donné, et elle est dérivée du
 * SCÉNARIO — quels blocs chaque passe touche, où tombent les barrières —, jamais du mécanisme.
 */
function validerGenerations(generations, indices) {
  if (!Array.isArray(generations) || generations.length < 2) {
    throw new Error(
      "L'oracle exige la suite des générations attendues : au moins l'état sans aucune génération validée et l'état où toutes le sont.",
    );
  }
  if (generations[0].length !== 0) {
    throw new Error(
      "La première génération attendue doit être VIDE : c'est l'état d'un volume dont aucune barrière n'a été acquittée.",
    );
  }
  for (let rang = 1; rang < generations.length; rang += 1) {
    const precedent = new Set(generations[rang - 1]);
    const courant = generations[rang];
    if (
      courant.length <= precedent.size ||
      !generations[rang - 1].every((i) => courant.includes(i))
    ) {
      throw new Error(
        `Génération attendue ${rang} : une génération publie tout ce que la précédente publiait, et strictement plus. Une suite qui ne croît pas ferait accepter des états qu'aucune barrière n'a produits.`,
      );
    }
  }
  const derniere = generations[generations.length - 1];
  if (!memeEnsemble(indices, derniere)) {
    throw new Error(
      `La dernière génération attendue doit couvrir les ${indices.size} bloc(s) suivis, elle en couvre ${derniere.length}.`,
    );
  }
}

/**
 * Verdict de volume. Les cas sévères l'emportent ; sinon l'ensemble des blocs PUBLIÉS doit
 * correspondre EXACTEMENT à l'une des générations attendues.
 *
 * « Exactement » est le mot qui compte : un bloc de plus ou de moins qu'une génération n'est pas une
 * génération, c'est un mélange. C'est ce qui distingue cet oracle de celui de #15, qui ne connaissait
 * que les deux extrêmes et rangeait donc toute génération intermédiaire — pourtant légitime — dans
 * `melange`, en même temps qu'il aurait accepté n'importe quel sous-ensemble d'un scénario dont les
 * générations se recouvrent.
 */
function verdictDuVolume(classes, detail, generations) {
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
  const publies = new Set(
    detail.filter((bloc) => bloc.classe === CLASSES.nouveau).map((bloc) => bloc.index),
  );
  const rang = generations.findIndex((attendus) => memeEnsemble(publies, attendus));
  if (rang !== -1) {
    return { verdict: verdictDeGeneration(rang, generations.length - 1), raison: null };
  }
  return {
    verdict: VERDICTS.melange,
    raison: `${publies.size} bloc(s) publiés ne forment aucune des ${generations.length} générations attendues : ${[...publies].join(", ") || "aucun"}.`,
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
 * Refuse une demande de classement mal formée, AVANT que le moindre bloc soit classé.
 *
 * Séparé de `classerVolume` pour que les quatre refus se lisent d'un bloc, chacun avec l'argument
 * qui le motive, sans que le travail de l'oracle soit repoussé vingt lignes plus bas. L'ORDRE des
 * contrôles fait partie du contrat : un appelant qui en viole deux lit toujours le même message, et
 * l'inverser changerait le diagnostic rendu à scénario identique.
 *
 * @param {{ blocs: unknown, journal: unknown, generations: unknown, sansJournal: boolean }} demande
 */
function validerDemande({ blocs, journal, generations, sansJournal }) {
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
  if (!sansJournal && generations === undefined) {
    throw new Error(
      "L'oracle exige la suite des générations attendues du scénario. Sans elle, il ne connaît que les deux extrêmes, et un mécanisme qui acquitte une génération puis la perd rend le MÊME verdict qu'un mécanisme correct.",
    );
  }
}

/**
 * Classe un volume relu après coupure.
 *
 * @param {{ blocs: Array<{ index: number, offset: number, ancien: Uint8Array, nouveau: Uint8Array,
 *                          observe: Uint8Array }>,
 *           journal?: readonly object[], generations?: readonly (readonly number[])[],
 *           sansJournal?: boolean }} entree
 *   `journal` est la sortie de `BlockJournal#entries()` de la session COUPÉE, transmise avant sa
 *   mort. Il est OBLIGATOIRE : sans lui la règle `SEC-DURABLE-001` ci-dessus est inerte, et son
 *   absence ferait monter le taux atomique sans que rien ne le dise. Un appelant qui ne veut classer
 *   que des octets — l'épreuve unitaire de l'oracle — doit poser `sansJournal: true`, et le rapport
 *   le republie : « acquitté » et « durable » valent alors `null`, jamais `false`.
 *
 *   `generations` est la suite des états qu'une génération VALIDÉE doit avoir publiés, du plus vide
 *   au plus complet. Elle est OBLIGATOIRE dès que le journal l'est. Un scénario dont les générations
 *   se recouvrent — même contenu réécrit d'une passe à l'autre — ne produit qu'un seul état
 *   observable, et un oracle qui ne connaîtrait que les deux extrêmes ne verrait alors AUCUNE
 *   différence entre un mécanisme qui valide les trois générations et un mécanisme qui perd les deux
 *   dernières après les avoir acquittées. La suite est dérivée du scénario, jamais du mécanisme, et
 *   `validerGenerations` refuse toute suite qui ne croît pas strictement.
 * @returns {{ verdict: string, raison: string | null, atomique: boolean,
 *             journalConsulte: boolean, entreesJournal: number, generationsAttendues: number,
 *             classes: Record<string, number>,
 *             blocs: Array<{ index: number, offset: number, classe: string,
 *                            acquitte: boolean | null, durable: boolean | null,
 *                            diagnostic: string | null }> }}
 */
export function classerVolume({ blocs, journal, generations, sansJournal = false }) {
  validerDemande({ blocs, journal, generations, sansJournal });

  const indices = new Set(blocs.map((bloc) => bloc.index));
  // Sans suite fournie — classement d'octets seuls —, les deux extrêmes suffisent : c'est
  // exactement l'oracle de #15, et le rapport publie qu'il n'a jugé que deux états.
  const attendues = generations ?? [[], [...indices]];
  validerGenerations(attendues, indices);

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
  const { verdict, raison } = verdictDuVolume(classes, detail, attendues);
  return Object.freeze({
    verdict,
    raison,
    atomique: estVerdictAtomique(verdict),
    // Publiés pour que « la règle SEC-DURABLE a-t-elle seulement pu se déclencher ? » et « combien
    // d'états l'oracle savait-il nommer ? » soient des questions auxquelles le compte rendu répond,
    // et non des hypothèses du lecteur.
    journalConsulte,
    entreesJournal: entrees.length,
    generationsAttendues: attendues.length,
    classes,
    blocs: Object.freeze(detail),
  });
}
