// Les PHASES de la révocation et la forme d'un ÉTAT (#310, ADR 0049). Module feuille : aucun import
// d'un autre module du modèle, pour que la vue, la table et le magasin le partagent sans cycle.
//
// Un état est une valeur IMMUABLE `{ phase, lecture, sequence, donnees, session, indice, occurrence }`.
// Il n'y a aucune valeur par défaut qui rende une donnée fiable : l'état initial est F0, « rien lu ».

/** Les seize phases. F : coffre non ouvert ; S / R : ouvert, à relire, sans / après révocation. */
export const PHASES = Object.freeze({
  F0: "F0",
  FL: "FL",
  FC: "FC",
  FE: "FE",
  FM: "FM",
  SL: "SL",
  SE: "SE",
  SM: "SM",
  RL: "RL",
  RE: "RE",
  RM: "RM",
  P: "P",
  C: "C",
  V: "V",
  K: "K",
  I: "I",
});

export const LISTE_DES_PHASES = Object.freeze(Object.values(PHASES));

// Les ENSEMBLES de phases ne sont JAMAIS exportés : un `Set` gelé reste muable par `add`, `delete` et
// `clear` (la revue de #315 a fait dire « révoqué » à la phase I). Seuls des PRÉDICATS sont exportés, sur
// des tableaux gelés que personne d'autre ne tient.
const CONNUES = Object.freeze(["FC", "P", "C", "K"]);
const EN_LECTURE = Object.freeze(["FL", "SL", "RL"]);
const APRES_SUCCES = Object.freeze(["RL", "RE", "RM", "K"]);
const FERMEES = Object.freeze(["FE", "SE", "RE", "I"]);

/** L'inventaire est CONNU : `donnees` n'est jamais nul, et seulement là (I5′). */
export const phaseConnue = (phase) => CONNUES.includes(phase);

/** UNE lecture est en vol : `lecture` n'est jamais nul, et seulement là (I13). */
export const phaseEnLecture = (phase) => EN_LECTURE.includes(phase);

/** Après un SUCCÈS acquitté par le Worker de cette instance (I3, I9′) : « révoqué » y est dicible. */
export const phaseApresSucces = (phase) => APRES_SUCCES.includes(phase);

/** La phase FERME : y arriver rend l'effet `consigner` (I20). */
export const phaseFermee = (phase) => FERMEES.includes(phase);

export const SESSION_VIDE = Object.freeze({ moyen: null });

const CLES_D_UN_ETAT = Object.freeze([
  "phase",
  "lecture",
  "sequence",
  "donnees",
  "session",
  "indice",
  "occurrence",
]);

const entierSur = (valeur, minimum) => Number.isSafeInteger(valeur) && valeur >= minimum;

function exigerUnEntier(nom, valeur, minimum) {
  if (!entierSur(valeur, minimum)) {
    throw new TypeError(`« ${nom} » doit être un entier sûr ≥ ${minimum}.`);
  }
}

function exigerLaSession(session) {
  const forme =
    session !== null &&
    typeof session === "object" &&
    Object.isFrozen(session) &&
    "moyen" in session;
  if (!forme || (session.moyen !== null && typeof session.moyen !== "string")) {
    throw new TypeError("« session » doit être un objet gelé { moyen: string | null }.");
  }
}

/** `donnees` : un instantané NORMALISÉ, gelé, dont le constat dépend de la phase (N8, N9). */
function exigerLesDonnees(phase, donnees) {
  const connue = phaseConnue(phase);
  if (!connue) {
    if (donnees !== null) throw new TypeError(`« donnees » doit être nul en ${phase} (I5′).`);
    return;
  }
  const gelee = donnees !== null && typeof donnees === "object" && Object.isFrozen(donnees);
  if (!gelee || donnees.public === null || typeof donnees.public !== "object") {
    throw new TypeError(`« donnees » doit être un instantané gelé en ${phase} (I5′).`);
  }
  exigerUnEntier("donnees.lecture", donnees.lecture, 1);
  const ouvert = phase !== "FC";
  const constat = donnees.constat;
  if (ouvert && (constat === null || typeof constat?.feuilleEprouvee !== "boolean")) {
    throw new TypeError(`le constat de la feuille est obligatoire en ${phase} (N8).`);
  }
  if (!ouvert && constat !== null) {
    throw new TypeError("le constat de la feuille est nul coffre fermé (N8).");
  }
}

/**
 * Construit un état VALIDÉ. Toute incohérence est une erreur de PROGRAMMATION (`TypeError`, D7) :
 * jamais atteignable par une personne, et jamais ignorée en silence.
 */
export function creerEtat({
  phase,
  lecture = null,
  sequence = 0,
  donnees = null,
  session = SESSION_VIDE,
  indice,
  occurrence = 0,
}) {
  if (!LISTE_DES_PHASES.includes(phase)) throw new TypeError(`phase inconnue : ${String(phase)}.`);
  if (typeof indice !== "boolean") throw new TypeError("« indice » doit être un booléen.");
  exigerUnEntier("sequence", sequence, 0);
  exigerUnEntier("occurrence", occurrence, 0);
  const enLecture = phaseEnLecture(phase);
  if (enLecture !== (lecture !== null)) {
    throw new TypeError(`« lecture » est non nul si, et seulement si, la phase lit (${phase}).`);
  }
  if (lecture !== null) {
    exigerUnEntier("lecture", lecture, 1);
    if (lecture > sequence) throw new TypeError("« lecture » dépasse « sequence ».");
  }
  exigerLaSession(session);
  exigerLesDonnees(phase, donnees);
  return Object.freeze({ phase, lecture, sequence, donnees, session, indice, occurrence });
}

/** L'état INITIAL : F0, rien lu, aucune lecture lancée. `indice` est obligatoire (I6, I17′). */
export function etatInitial(indice) {
  return creerEtat({ phase: PHASES.F0, indice });
}

/** Vérifie qu'on tient un état valide, structurellement (pas de registre de module : I12). */
export function exigerUnEtat(etat) {
  const forme = etat !== null && typeof etat === "object" && Object.isFrozen(etat);
  const cles = forme ? Object.keys(etat) : [];
  if (!forme || cles.length !== CLES_D_UN_ETAT.length || !CLES_D_UN_ETAT.every((c) => c in etat)) {
    throw new TypeError("un état de la révocation est attendu.");
  }
  creerEtat(etat);
  return etat;
}
