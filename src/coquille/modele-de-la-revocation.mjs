// Le MODÈLE D'ÉTAT de la révocation d'urgence (#310, ADR 0049) : une machine d'état EXPLICITE, pure,
// sans DOM et sans texte final. Seize phases, vingt-deux événements, 384 cellules (la table de
// l'ADR 0049, lue mot à mot par l'épreuve exhaustive).
//
// `transiter(etat, evenement)` est une fonction PURE : elle rend `{ accepte, etat, effets, annonce }`
// et ne lève que `TypeError` (erreur de programmation, D7). Un événement INTERDIT rend l'état
// inchangé (la même référence), aucun effet, et l'annonce qui dit pourquoi.
//
// Quatre règles de lecture, calculées et non répétées cellule par cellule (éprouvées sur les 384) :
//  - I20   toute arête qui ARRIVE en FE, SE, RE ou I rend `consigner({ evenement, code })` ;
//  - R-AFF″ toute arête qui INCRÉMENTE `occurrence` rend `vue-a-rendre` en dernier, et `masquer` en
//          TÊTE si l'empreinte du contenu change (sauf `masquage-impossible`) ;
//  - I25   `occurrence` augmente de 1 si, et seulement si, phase, instantané, moyen de séance ou
//          indice changent ;
//  - T9    toute arête qui quitte {FC, P, C, K} vers l'extérieur efface `donnees`.

import {
  LISTE_DES_PHASES,
  PHASES_CONNUES,
  PHASES_EN_LECTURE,
  PHASES_FERMEES,
  creerEtat,
  exigerUnEtat,
} from "./phases-de-la-revocation.mjs";
import { empreinteDeLEtat } from "./vue-de-la-revocation.mjs";

/** Les lanceurs à effet PERSISTANT de l'enveloppe : gardés par le pré-vol (I23″). Liste FERMÉE. */
export const LANCEURS_D_ENVELOPPE = Object.freeze(["envoyer", "lancer"]);

const EGAL = Object.freeze({ egal: true, effets: Object.freeze([]) });
const aller = (vers, ...effets) => Object.freeze({ vers, effets: Object.freeze(effets) });
const rester = (...effets) => Object.freeze({ egal: true, effets: Object.freeze(effets) });

const TOUTES = LISTE_DES_PHASES;

/** `=` partout, sauf les phases listées (interdites) et les cellules de `autres`. */
function partout(interdites, autres = {}) {
  const ligne = {};
  for (const phase of TOUTES) if (!interdites.includes(phase)) ligne[phase] = EGAL;
  return Object.freeze({ ...ligne, ...autres });
}

/** La mort du Worker et le délai : des FAITS, valables dans tous les états (e7, e11). */
const MORT = Object.freeze({
  F0: aller("FE"),
  FL: aller("FE"),
  FC: aller("FE"),
  FE: EGAL,
  FM: aller("FE"),
  SL: aller("SE"),
  SE: EGAL,
  SM: aller("SE"),
  RL: aller("RE"),
  RE: EGAL,
  RM: aller("RE"),
  P: aller("SE"),
  C: aller("SE", "oublier"),
  V: aller("I"),
  K: aller("RE"),
  I: EGAL,
});

const ECHEC_DE_L_ENVOI = Object.freeze({ V: aller("I") });

/**
 * LA TABLE. Une ligne par événement ; une cellule par phase ; une cellule ABSENTE est INTERDITE (✗).
 * Les lignes de relecture ne portent que le cas « courante » : une réponse NON courante est interdite
 * partout (I13), et la classe est décidée par `classeDeLaLecture`, pas par la table.
 */
const TABLE = Object.freeze({
  montage: Object.freeze({ F0: aller("FL", "relire") }),
  "coffre-ouvert": Object.freeze({
    F0: aller("SL", "relire"),
    FL: aller("SL", "relire"),
    FC: aller("SL", "relire"),
  }),
  "demander-la-revocation": Object.freeze({ P: aller("C"), C: EGAL }),
  oui: Object.freeze({ C: aller("V", "envoyer") }),
  annuler: Object.freeze({ C: aller("P", "oublier") }),
  "reponse-de-succes": Object.freeze({ V: aller("RL", "noter", "relire") }),
  "refus-type": ECHEC_DE_L_ENVOI,
  "worker-mort": MORT,
  "worker-rompu": ECHEC_DE_L_ENVOI,
  "reponse-malformee": ECHEC_DE_L_ENVOI,
  "erreur-sans-code": ECHEC_DE_L_ENVOI,
  "delai-depasse": MORT,
  "relecture-reussie": Object.freeze({
    FL: aller("FC", "publier"),
    SL: aller("P", "publier"),
    RL: aller("K", "publier"),
  }),
  "relecture-echouee": Object.freeze({ FL: aller("FE"), SL: aller("SE"), RL: aller("RE") }),
  verrouiller: partout(["FM", "SM", "RM", "V"]),
  "changer-d-etape": partout([], { C: aller("P", "oublier") }),
  "terminer-sans-revoquer": Object.freeze({
    P: rester("terminer"),
    C: aller("P", "oublier", "terminer"),
  }),
  "revenir-a-l-application": Object.freeze({
    P: rester("revenir"),
    C: aller("P", "oublier", "revenir"),
    K: rester("revenir"),
    I: rester("revenir"),
  }),
  "modification-lancee": Object.freeze({
    FL: aller("FM", "lancer"),
    FC: aller("FM", "lancer"),
    SL: aller("SM", "lancer"),
    RL: aller("RM", "lancer"),
    P: aller("SM", "lancer"),
    C: aller("SM", "oublier", "lancer"),
    K: aller("RM", "lancer"),
  }),
  "modification-terminee": Object.freeze({
    FM: aller("FL", "relire"),
    SM: aller("SL", "relire"),
    RM: aller("RL", "relire"),
  }),
  "indice-change": partout([]),
  "masquage-impossible": Object.freeze({
    FL: aller("FE"),
    FC: aller("FE"),
    SL: aller("SE"),
    RL: aller("RE"),
    P: aller("SE"),
    C: aller("SE", "oublier"),
    K: aller("RE"),
  }),
});

export const EVENEMENTS = Object.freeze(Object.keys(TABLE));

/** Les gestes de la personne : seuls événements dont `accepte` répond sans charge utile. */
export const EVENEMENTS_DE_GESTE = Object.freeze([
  "demander-la-revocation",
  "oui",
  "annuler",
  "verrouiller",
  "terminer-sans-revoquer",
  "revenir-a-l-application",
  "modification-lancee",
]);

const EFFETS_VIDES = Object.freeze([]);

const entierPositif = (valeur) => Number.isSafeInteger(valeur) && valeur >= 1;

/** `true` ssi la réponse porte l'identifiant de la lecture EN VOL (I13) ; sinon elle est périmée. */
function classeDeLaLecture(etat, evenement) {
  if (!entierPositif(evenement.lecture)) {
    throw new TypeError("« lecture » doit être un entier sûr ≥ 1.");
  }
  return etat.lecture !== null && evenement.lecture === etat.lecture;
}

function exigerUnEvenement(evenement) {
  const type = evenement?.type;
  if (typeof type !== "string" || !EVENEMENTS.includes(type)) {
    throw new TypeError(`événement inconnu : ${String(type)}.`);
  }
  return type;
}

/** La cellule de la table, ou `undefined` (interdit). Valide la charge utile (D7). */
function celluleDe(etat, evenement, type) {
  if (type === "relecture-reussie" || type === "relecture-echouee") {
    return classeDeLaLecture(etat, evenement) ? TABLE[type][etat.phase] : undefined;
  }
  if (type === "indice-change" && typeof evenement.valeur !== "boolean") {
    throw new TypeError("« valeur » doit être un booléen.");
  }
  if (type === "masquage-impossible" && !["envoi", "modification"].includes(evenement.action)) {
    throw new TypeError("« action » doit être « envoi » ou « modification ».");
  }
  return TABLE[type][etat.phase];
}

/** L'annonce d'un geste REFUSÉ : dit pourquoi, sans rien affirmer de faux (I3, I4). */
function annonceDeRefus(etat, type) {
  if (!EVENEMENTS_DE_GESTE.includes(type)) return null;
  const { phase } = etat;
  if (phase === "V") return "demande-refusee-en-cours";
  if (phase === "I") return "demande-refusee-a-verifier";
  if (phase === "K" && type === "demander-la-revocation") return "demande-refusee-deja-faite";
  if (!PHASES_CONNUES.has(phase)) return "demande-refusee-donnees-inconnues";
  return "geste-refuse";
}

function refus(etat, type) {
  return Object.freeze({
    accepte: false,
    etat,
    effets: EFFETS_VIDES,
    annonce: annonceDeRefus(etat, type),
  });
}

/** Le moyen d'ouverture de la séance : un nom, ou `null` (validé, jamais propagé tel quel). */
function moyenValide(moyen) {
  if (moyen === null || moyen === undefined) return null;
  if (typeof moyen !== "string" || moyen.length === 0 || moyen.length > 64) {
    throw new TypeError("« moyen » doit être un nom de moyen ou nul.");
  }
  return moyen;
}

/** Les champs de l'état suivant : la lecture, l'instantané, la séance, l'indice. */
function champsSuivants(etat, evenement, cellule, type) {
  const vers = cellule.vers ?? etat.phase;
  const alloue = cellule.effets.includes("relire");
  const sequence = alloue ? etat.sequence + 1 : etat.sequence;
  let lecture = null;
  if (alloue) lecture = sequence;
  else if (vers === etat.phase && PHASES_EN_LECTURE.has(vers)) lecture = etat.lecture;
  let donnees = null;
  if (type === "relecture-reussie") {
    donnees = Object.freeze({ ...evenement.donnees, lecture: evenement.lecture });
  } else if (PHASES_CONNUES.has(vers) && PHASES_CONNUES.has(etat.phase)) {
    donnees = etat.donnees;
  }
  const session =
    type === "coffre-ouvert"
      ? Object.freeze({ moyen: moyenValide(evenement.moyen) })
      : etat.session;
  const indice = type === "indice-change" ? evenement.valeur : etat.indice;
  return { phase: vers, lecture, sequence, donnees, session, indice };
}

/** `occurrence` : +1 si, et seulement si, ce que la page peut afficher a changé (I25). */
function occurrenceSuivante(etat, suivant) {
  const change =
    suivant.phase !== etat.phase ||
    suivant.donnees !== etat.donnees ||
    suivant.session.moyen !== etat.session.moyen ||
    suivant.indice !== etat.indice;
  return change ? etat.occurrence + 1 : etat.occurrence;
}

function effetMetier(nom, suivant, evenement) {
  if (nom === "relire") return { nom, lecture: suivant.lecture };
  if (nom === "publier") return { nom, lecture: evenement.lecture, donnees: suivant.donnees };
  return { nom };
}

/** Assemble les effets : `masquer` en tête, le métier, `consigner`, `vue-a-rendre` en queue. */
function assemblerLesEffets(etat, suivant, evenement, cellule) {
  const effets = [];
  const type = evenement.type;
  if (type !== "masquage-impossible" && empreinteDeLEtat(suivant) !== empreinteDeLEtat(etat)) {
    effets.push({ nom: "masquer" });
  }
  for (const nom of cellule.effets) effets.push(effetMetier(nom, suivant, evenement));
  if (PHASES_FERMEES.has(suivant.phase) && suivant.phase !== etat.phase) {
    effets.push({
      nom: "consigner",
      evenement: evenement.cause ?? type,
      code: evenement.code ?? null,
    });
  }
  if (suivant.occurrence !== etat.occurrence) effets.push({ nom: "vue-a-rendre" });
  return Object.freeze(effets.map((effet) => Object.freeze(effet)));
}

function annonceDAcceptation(type, evenement) {
  if (type === "annuler") return "annulee";
  if (type === "terminer-sans-revoquer") return "termine-sans-revoquer";
  if (type === "masquage-impossible") {
    return evenement.action === "envoi" ? "envoi-annule-affichage" : "lancement-annule-affichage";
  }
  return null;
}

/**
 * LA transition. Pure. Rend `{ accepte, etat, effets, annonce }`.
 *
 * @param {object} etat un état valide (`creerEtat`)
 * @param {{ type: string, lecture?: number, donnees?: object, valeur?: boolean, moyen?: string,
 *           action?: string, code?: string, cause?: string }} evenement
 */
export function transiter(etat, evenement) {
  exigerUnEtat(etat);
  const type = exigerUnEvenement(evenement);
  const cellule = celluleDe(etat, evenement, type);
  if (cellule === undefined) return refus(etat, type);
  const champs = champsSuivants(etat, evenement, cellule, type);
  const suivant = creerEtat({
    ...champs,
    occurrence: occurrenceSuivante(etat, { ...champs }),
  });
  return Object.freeze({
    accepte: true,
    etat: suivant,
    effets: assemblerLesEffets(etat, suivant, evenement, cellule),
    annonce: annonceDAcceptation(type, evenement),
  });
}

/** Le geste `type` est-il ouvert dans cet état ? (I8 : la même réponse alimente `disabled`.) */
export function accepte(etat, type) {
  if (!EVENEMENTS_DE_GESTE.includes(type)) {
    throw new TypeError(`« accepte » ne répond que pour un geste : ${String(type)}.`);
  }
  return transiter(etat, { type }).accepte;
}
