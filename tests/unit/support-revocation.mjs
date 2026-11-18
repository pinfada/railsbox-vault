// Le SUPPORT des épreuves du modèle de la révocation (#310, ADR 0049) : des réponses d'inventaire
// conformes, des instantanés, des états de chaque phase, et les événements de chaque ligne de la table.
//
// Il ne dépend que de l'API publique des modules : un état n'est jamais forgé à la main.

import { TYPES_PRIVILEGIES } from "../../src/coquille/contrat-de-messages.mjs";
import {
  LISTE_DES_PHASES,
  creerEtat,
  phaseConnue,
  phaseEnLecture,
} from "../../src/coquille/phases-de-la-revocation.mjs";
import { normaliserLInventaire } from "../../src/coquille/reponse-de-la-revocation.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";

export { LISTE_DES_PHASES };

const hex = (graine, longueur) =>
  Array.from({ length: longueur }, (_, rang) =>
    ((graine + rang * 7) & 0xff).toString(16).padStart(2, "0"),
  ).join("");

/** Une réponse d'inventaire CONFORME au contrat du Worker (`publierLInventaire`). */
export function reponseDInventaire({ codes = 1, phrase = true, feuille = true } = {}) {
  const emplacements = [];
  if (phrase) {
    emplacements.push({
      typeKek: TYPES_KEK.phrase,
      identifiantEmplacement: hex(1, 8),
      parametresHex: hex(9, 24),
    });
  }
  for (let rang = 0; rang < codes; rang += 1) {
    emplacements.push({
      typeKek: TYPES_KEK.recuperation,
      identifiantEmplacement: hex(40 + rang, 8),
    });
  }
  return {
    type: TYPES_PRIVILEGIES.inventaireReponse,
    refus: null,
    present: true,
    feuilleEprouvee: feuille,
    identifiantVolume: "coffre",
    versionEnveloppe: 3,
    emplacements,
  };
}

/** Un instantané NORMALISÉ, au sens de la phase (le constat n'existe que coffre ouvert). */
export function donneesDeLaPhase(phase, options = {}, lecture = 3) {
  const ouvert = phase !== "FC" && phase !== "FL";
  const normalise = normaliserLInventaire(reponseDInventaire(options), { ouvert });
  return Object.freeze({ ...normalise.donnees, lecture });
}

/** Un état VALIDE de la phase demandée, par l'API publique. */
export function etatDeLaPhase(phase, options = {}) {
  const { indice = false, occurrence = 5, moyen = "phrase", sequence = 7, jeu } = options;
  const connue = phaseConnue(phase);
  const enLecture = phaseEnLecture(phase);
  return creerEtat({
    phase,
    lecture: enLecture ? sequence : null,
    sequence,
    donnees: connue ? donneesDeLaPhase(phase, jeu) : null,
    session: Object.freeze({ moyen }),
    indice,
    occurrence,
  });
}

/** Les phases (hors lecture) vers lesquelles une lecture RÉUSSIE ouvre : FL → coffre fermé. */
export function donneesDeLaLecture(phase, lecture) {
  const normalise = normaliserLInventaire(reponseDInventaire(), { ouvert: phase !== "FL" });
  return normalise.donnees ?? { lecture, public: {}, constat: null };
}

/** L'événement d'une ligne de la table, pour cet état. `classe` : courante / non courante. */
export function evenementDeLaLigne(type, etat, classe = null, variante = 0) {
  if (type === "relecture-reussie" || type === "relecture-echouee") {
    const courante = classe === "courante";
    const ancienne = [1000, 999, 1][variante % 3];
    const lecture = courante ? (etat.lecture ?? 1) : ancienne === etat.lecture ? 998 : ancienne;
    return type === "relecture-reussie"
      ? { type, lecture, donnees: donneesDeLaLecture(etat.phase, lecture) }
      : { type, lecture, code: "VAULT_TEST" };
  }
  const charges = {
    "coffre-ouvert": { moyen: "phrase" },
    "indice-change": { valeur: !etat.indice },
    "masquage-impossible": { action: variante === 1 ? "envoi" : "modification" },
    "refus-type": { code: "VAULT_TEST" },
  };
  return { type, ...(charges[type] ?? {}) };
}

/** Tous les événements à essayer sur un état : chaque ligne, chaque variante. */
export function tousLesEvenements(etat) {
  const simples = [
    "montage",
    "coffre-ouvert",
    "demander-la-revocation",
    "oui",
    "annuler",
    "reponse-de-succes",
    "refus-type",
    "worker-mort",
    "worker-rompu",
    "reponse-malformee",
    "erreur-sans-code",
    "delai-depasse",
    "verrouiller",
    "changer-d-etape",
    "terminer-sans-revoquer",
    "revenir-a-l-application",
    "modification-lancee",
    "modification-terminee",
    "indice-change",
  ].map((type) => evenementDeLaLigne(type, etat));
  const lectures = [];
  for (const type of ["relecture-reussie", "relecture-echouee"]) {
    lectures.push(evenementDeLaLigne(type, etat, "courante"));
    for (const variante of [0, 1, 2])
      lectures.push(evenementDeLaLigne(type, etat, "non courante", variante));
  }
  const masquages = [0, 1].map((variante) =>
    evenementDeLaLigne("masquage-impossible", etat, null, variante),
  );
  const indices = [true, false].map((valeur) => ({ type: "indice-change", valeur }));
  return [
    ...simples.filter((e) => e.type !== "indice-change"),
    ...lectures,
    ...masquages,
    ...indices,
  ];
}
