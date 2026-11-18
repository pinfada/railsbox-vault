// La VUE d'un état : ce que la page a le droit d'AFFIRMER, et rien d'autre (#310, ADR 0049, I21′).
//
// `vueDe(etat)` est une fonction PURE des seules entrées `(phase, donnees, session, indice)` : ni DOM,
// ni miroir, ni horloge. `empreinteDeLEtat` est la sérialisation CANONIQUE de la vue ENTIÈRE : toute
// entrée qui change la vue change l'empreinte, par construction (aucune liste de champs à tenir à la
// main). L'empreinte est l'identité du CONTENU ; la fraîcheur d'un rendu se prouve par `occurrence`.
//
// Les PORTES (`lirePublic`, `lireLeConstat`) ne prennent AUCUNE source : elles lisent l'instantané
// de l'état, jamais un miroir (I5′, I6).

import { PHASES_APRES_SUCCES, PHASES_CONNUES, exigerUnEtat } from "./phases-de-la-revocation.mjs";

/** Les écrans que l'ÉTAT impose : aucune donnée n'en choisit un (§ R3). */
const ECRANS_IMPOSES = Object.freeze({
  F0: "chargement",
  FL: "chargement",
  FE: "relire",
  FM: "modification-en-cours",
  SL: "chargement",
  SE: "relire",
  SM: "modification-en-cours",
  RL: "chargement-apres-revocation",
  RE: "relire-apres-revocation",
  RM: "modification-en-cours-apres-revocation",
  V: "revoquer-en-cours",
  K: "termine",
  I: "revocation-incertaine",
});

/** La région d'annonce persistante : fonction de l'état seul, jamais effacée par un clic (I11). */
const REGIONS = Object.freeze({ V: "revocation-en-cours", I: "revocation-incertaine" });

/** Les phases où le constat de la feuille est CONNU : coffre ouvert et relu (I5′). */
const PHASES_AVEC_CONSTAT = Object.freeze(new Set(["P", "C", "K"]));

/** Les phases SANS envoi dans cette instance (I4) : le seul fait négatif vérifiable. */
const PHASES_SANS_ENVOI = Object.freeze(
  new Set(["F0", "FL", "FC", "FE", "FM", "SL", "SE", "SM", "P", "C"]),
);

/** La vue : un objet gelé, tous champs présents, `null` quand l'état ne sait pas. */
export function vueDe(etat) {
  exigerUnEtat(etat);
  const { phase, donnees, session } = etat;
  const connue = PHASES_CONNUES.has(phase);
  const avecConstat = PHASES_AVEC_CONSTAT.has(phase);
  return Object.freeze({
    moyens: connue ? donnees.public.moyens : null,
    nombreDeCodes: connue ? donnees.public.nombreDeCodes : null,
    feuilleEprouvee: avecConstat ? donnees.constat.feuilleEprouvee : null,
    moyenDOuverture: avecConstat ? session.moyen : null,
    confirmation: phase === "C" ? Object.freeze({ ouverte: true }) : null,
    ecranImpose: ECRANS_IMPOSES[phase] ?? null,
    region: REGIONS[phase] ?? null,
    finDisponible: phase === "P" && etat.indice ? "termine-sans-attestation" : null,
  });
}

/**
 * Sérialisation CANONIQUE : clés triées récursivement, tableaux dans l'ordre, `null` explicite.
 * `undefined`, une fonction ou un nombre non fini sont des erreurs de programmation.
 */
export function canonique(valeur) {
  if (valeur === null || typeof valeur === "boolean" || typeof valeur === "string") {
    return JSON.stringify(valeur);
  }
  if (typeof valeur === "number" && Number.isFinite(valeur)) return JSON.stringify(valeur);
  if (Array.isArray(valeur)) return `[${valeur.map(canonique).join(",")}]`;
  if (typeof valeur === "object" && valeur !== undefined) {
    const corps = Object.keys(valeur)
      .sort()
      .map((cle) => `${JSON.stringify(cle)}:${canonique(valeur[cle])}`);
    return `{${corps.join(",")}}`;
  }
  throw new TypeError("valeur non sérialisable dans la vue.");
}

/** L'identité du CONTENU de la vue (I21′). */
export function empreinteDeLEtat(etat) {
  return canonique(vueDe(etat));
}

/** Ce qui est DICIBLE (I3, I4). `revoque` : cette instance ; jamais l'indice persisté (D4). */
export function affirmationsDe(etat) {
  exigerUnEtat(etat);
  const { phase } = etat;
  return Object.freeze({
    revoque: PHASES_APRES_SUCCES.has(phase),
    peutEtreRevoque: phase === "V" || phase === "I",
    aucunGesteDansCetteSeance: PHASES_SANS_ENVOI.has(phase),
  });
}

/** Ce que la page SAIT : deux classes de données, publiques et constat (§ R3). */
export function connuDe(etat) {
  exigerUnEtat(etat);
  return Object.freeze({
    public: PHASES_CONNUES.has(etat.phase),
    constat: PHASES_AVEC_CONSTAT.has(etat.phase),
  });
}

/** PORTE des données publiques : moyens, nombre de codes, paramètres de dérivation. Aucune source. */
export function lirePublic(etat) {
  exigerUnEtat(etat);
  return PHASES_CONNUES.has(etat.phase) ? etat.donnees.public : null;
}

/** PORTE du constat de la feuille éprouvée : coffre ouvert et relu seulement. Aucune source. */
export function lireLeConstat(etat) {
  exigerUnEtat(etat);
  return PHASES_AVEC_CONSTAT.has(etat.phase) ? etat.donnees.constat : null;
}
