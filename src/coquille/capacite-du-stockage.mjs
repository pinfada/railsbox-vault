// LA CAPACITÉ DU STOCKAGE vue par le Worker de confiance : une petite MACHINE explicite (#231, revue de
// la PR #305).
//
//     inconnu ──┬─► disponible
//               ├─► indetermine ◄──┐
//               ├─► absent          ├─ réessayables : indetermine ⇄ panne, et vers disponible / absent
//               └─► panne:<code> ◄─┘
//
// Avant elle, un booléen (`stockageIndetermine`) retombait à faux sur la première panne rencontrée au
// réessai, sans rétablir la capacité : « trois `UnknownError`, puis un `QuotaExceededError` » rendait
// `VAULT_STORAGE_UNSUPPORTED` — une absence que rien n'établit — et plus aucune sonde ne partait.
//
// Seules les transitions ÉCRITES existent, et toute autre LÈVE :
//
//  - `inconnu` : avant la première sonde. Il n'est jamais publié — tout ce qui en dépend attend la sonde ;
//  - `disponible` : la sonde a abouti. Terminal pour la sonde (elle n'est pas rejouée) ;
//  - `indetermine` : un `UnknownError` persistant, « inaccessible pour l'instant, cause non établie » ;
//  - `panne` : tout autre rejet, avec son code PRÉCIS ;
//  - `absent` : la fonction manque, ou un refus de capacité déjà typé. Terminal : établi, durable.
//
// `indetermine` et `panne` sont RÉESSAYABLES : un geste ou une demande d'inventaire relance la sonde, et
// elle peut conduire à n'importe quel état, `disponible` compris. `VAULT_STORAGE_UNSUPPORTED` n'est rendu
// que pour `absent`.

import { ETATS_DU_VOLUME } from "./etat-de-la-coquille.mjs";
import { STORAGE_ERROR_CODES } from "../vm/storage-errors.mjs";
import { VERDICTS_DU_STOCKAGE } from "../vm/sonde-du-stockage.mjs";

export const ETATS_DE_CAPACITE = Object.freeze({
  inconnu: "inconnu",
  disponible: "disponible",
  indetermine: "indetermine",
  absent: "absent",
  panne: "panne",
});

const E = ETATS_DE_CAPACITE;
const V = VERDICTS_DU_STOCKAGE;

/** Les verdicts qu'une sonde peut rendre, et l'état qu'ils posent. */
const ETAT_DU_VERDICT = Object.freeze({
  [V.atteignable]: E.disponible,
  [V.absente]: E.absent,
  [V.indetermine]: E.indetermine,
  [V.panne]: E.panne,
});

/** La table des transitions : de quel état, par quels verdicts. Rien d'autre n'est permis. */
const TRANSITIONS = Object.freeze({
  [E.inconnu]: Object.freeze([V.atteignable, V.absente, V.indetermine, V.panne]),
  [E.indetermine]: Object.freeze([V.atteignable, V.absente, V.indetermine, V.panne]),
  [E.panne]: Object.freeze([V.atteignable, V.absente, V.indetermine, V.panne]),
  [E.disponible]: Object.freeze([]),
  [E.absent]: Object.freeze([]),
});

/** @param {{ apiPresente: boolean }} constat */
export function capaciteInitiale({ apiPresente }) {
  return Object.freeze({ etat: apiPresente ? E.inconnu : E.absent });
}

/**
 * Applique le résultat d'une sonde. Lève sur toute transition non écrite.
 *
 * @param {{ etat: string, code?: string }} capacite
 * @param {{ verdict: string, code?: string | null }} sonde
 */
export function apresLaSonde(capacite, { verdict, code = null }) {
  if (!(verdict in ETAT_DU_VERDICT))
    throw new Error(`Verdict de sonde inconnu : ${String(verdict)}.`);
  if (!TRANSITIONS[capacite.etat]?.includes(verdict)) {
    throw new Error(`Transition de capacité non écrite : ${capacite.etat} ← ${verdict}.`);
  }
  if (verdict === V.panne) {
    if (typeof code !== "string" || code === "") {
      throw new Error("Une panne porte son code précis : le refus qui suit le rend tel quel.");
    }
    return Object.freeze({ etat: E.panne, code });
  }
  return Object.freeze({ etat: ETAT_DU_VERDICT[verdict] });
}

/** Seule la capacité `disponible` ouvre un volume. */
export const peutOuvrir = (capacite) => capacite.etat === E.disponible;

/** Un geste ou une demande d'inventaire relance la sonde tant que la capacité est `indetermine` ou `panne`. */
export const reessayable = (capacite) =>
  capacite.etat === E.indetermine || capacite.etat === E.panne;

/**
 * L'état du coffre que la coquille publie. L'indétermination ET la panne se publient `indetermine` :
 * pour la personne, le stockage ne répond pas pour l'instant ; le refus d'un geste dit le détail.
 */
export function etatPublie(capacite) {
  if (capacite.etat === E.absent) return ETATS_DU_VOLUME.indisponible;
  if (capacite.etat === E.indetermine || capacite.etat === E.panne) {
    return ETATS_DU_VOLUME.indetermine;
  }
  return ETATS_DU_VOLUME.verrouille;
}

const MESSAGE_INDETERMINE =
  "Le stockage du navigateur est inaccessible pour l'instant, cause non établie. Le geste n'a pas été tenté : le présenter de nouveau peut aboutir.";
const MESSAGE_ABSENT =
  "Ce navigateur n'offre pas l'accès synchrone à l'OPFS dans un Worker : aucun volume n'est atteignable ici. Le geste n'a pas échoué — il n'a pas pu être tenté.";

/**
 * Le refus qu'un geste reçoit tant que la capacité n'est pas `disponible`, ou `null`. `UNSUPPORTED`
 * n'est rendu que pour une absence ÉTABLIE ; l'indétermination rend `VAULT_STORAGE_INDETERMINE` ; une
 * panne rend SON code.
 *
 * @returns {{ code: string, message: string } | null}
 */
export function refusDeCapacite(capacite) {
  if (capacite.etat === E.absent) {
    return { code: STORAGE_ERROR_CODES.unsupported, message: MESSAGE_ABSENT };
  }
  if (capacite.etat === E.indetermine) {
    return { code: STORAGE_ERROR_CODES.indeterminate, message: MESSAGE_INDETERMINE };
  }
  if (capacite.etat === E.panne) {
    return {
      code: capacite.code,
      message:
        "Le stockage du navigateur est inaccessible pour l'instant : la dernière sonde a rendu une panne (" +
        `${capacite.code}). Le geste n'a pas été tenté ; le présenter de nouveau relance la sonde.`,
    };
  }
  return null;
}

/**
 * Les transitions d'un ÉCHEC DE LECTURE réelle — l'inventaire, un geste —, SURVENU APRÈS une sonde
 * réussie. `disponible` n'est pas un cul-de-sac : la sonde a abouti, une lecture rejette ensuite
 * (revue complète de la PR #305). La machine le traite de façon conservatrice et réessayable : l'état
 * repasse en `indetermine` ou en `panne:<code>`, et la sonde suivante peut tout rétablir. Une absence
 * établie ne change pas (elle est terminale) et une capacité encore `inconnue` n'a rien lu.
 */
const TRANSITIONS_DE_LECTURE = Object.freeze({
  [E.disponible]: Object.freeze([V.indetermine, V.panne]),
  [E.indetermine]: Object.freeze([V.indetermine, V.panne]),
  [E.panne]: Object.freeze([V.indetermine, V.panne]),
});

/**
 * @param {{ etat: string, code?: string }} capacite
 * @param {{ verdict: string, code?: string | null }} echec `indetermine`, ou `panne` avec son code
 */
export function apresUnEchecDeLecture(capacite, { verdict, code = null }) {
  if (!TRANSITIONS_DE_LECTURE[capacite.etat]?.includes(verdict)) {
    throw new Error(`Transition de capacité non écrite : ${capacite.etat} ← lecture ${verdict}.`);
  }
  if (verdict === V.panne) {
    if (typeof code !== "string" || code === "") {
      throw new Error("Une panne porte son code précis : le refus qui suit le rend tel quel.");
    }
    return Object.freeze({ etat: E.panne, code });
  }
  return Object.freeze({ etat: E.indetermine });
}
