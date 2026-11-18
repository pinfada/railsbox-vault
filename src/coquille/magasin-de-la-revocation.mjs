// Le MAGASIN de la révocation (#310, ADR 0049) : tient l'état d'UNE instance (un document), affecte
// l'état PUIS exécute les effets, et POSSÈDE les issues asynchrones (envoi, lecture, modification).
//
// Ce que le magasin garantit :
//  - I2   l'état est affecté AVANT l'envoi (l'exécuteur d'`envoyer` y lit déjà V) ;
//  - I23″ aucune MODIFICATION D'ENVELOPPE sans masquage établi : pour `envoyer` et `lancer`, `masquer()`
//         est exécuté AVANT d'affecter l'état cible ; non établi → l'état cible n'est jamais affecté,
//         le lanceur n'est pas appelé, `masquage-impossible` ferme (R5 § V2) ;
//  - R-c  les événements de RÉPONSE (succès, refus, lecture, fin de modification) ne sont PAS appelables
//         de l'extérieur : le magasin les produit lui-même, depuis les promesses qu'il a obtenues ;
//  - I16′ l'affectation est la seule étape qui ouvre une porte : aucun effet ne le fait ;
//  - I19′ la défaillance d'un effet de miroir, de diagnostic, d'affichage ou de navigation ne change ni
//         l'état ni les portes ; celle d'un LANCEUR est la transition de la table qui lui correspond ;
//  - I20′ la défaillance de `consigner` est inscrite dans un journal interne borné, sans récursion.
//
// Aucun état de module : deux instances sont indépendantes (I1). Aucun DOM, aucune horloge.

import { LANCEURS_D_ENVELOPPE, accepte, transiter } from "./modele-de-la-revocation.mjs";
import { etatInitial } from "./phases-de-la-revocation.mjs";
import { projeter } from "./projection-de-la-revocation.mjs";
import {
  codeDeLErreur,
  evenementDeLaReponse,
  normaliserLInventaire,
} from "./reponse-de-la-revocation.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { empreinteDeLEtat } from "./vue-de-la-revocation.mjs";

/** Tous requis, tous des fonctions, validés à la CRÉATION : jamais d'état affecté sans exécuteur. */
const EXECUTEURS_REQUIS = Object.freeze([
  "envoyer",
  "relire",
  "publier",
  "noter",
  "oublier",
  "terminer",
  "revenir",
  "masquer",
  "consigner",
  "vueARendre",
]);

const EXECUTEUR_DE = Object.freeze({
  envoyer: "envoyer",
  relire: "relire",
  publier: "publier",
  noter: "noter",
  oublier: "oublier",
  terminer: "terminer",
  revenir: "revenir",
  masquer: "masquer",
  consigner: "consigner",
  "vue-a-rendre": "vueARendre",
});

/** Ce que l'appelant EXTÉRIEUR peut appliquer. Les issues sont produites par le magasin seul (R-c). */
const EVENEMENTS_PUBLICS = Object.freeze(
  new Set([
    "coffre-ouvert",
    "demander-la-revocation",
    "oui",
    "annuler",
    "verrouiller",
    "changer-d-etape",
    "terminer-sans-revoquer",
    "revenir-a-l-application",
    "worker-mort",
  ]),
);

const TAILLE_DU_JOURNAL = 64;

function verifierLesExecuteurs(executeurs) {
  if (executeurs === null || typeof executeurs !== "object") {
    throw new TypeError("« executeurs » est obligatoire.");
  }
  for (const nom of EXECUTEURS_REQUIS) {
    if (typeof executeurs[nom] !== "function") {
      throw new TypeError(`l'exécuteur « ${nom} » est obligatoire et doit être une fonction.`);
    }
  }
}

// --- Le journal interne (I20′) : aucun exécuteur, aucune récursion ----------------------------------

function messageDe(erreur) {
  try {
    return String(erreur?.message ?? erreur).slice(0, 200);
  } catch {
    return "erreur illisible";
  }
}

function journaliser(ctx, effet, erreur) {
  ctx.rang += 1;
  ctx.journal.push(Object.freeze({ rang: ctx.rang, effet, message: messageDe(erreur) }));
  if (ctx.journal.length > TAILLE_DU_JOURNAL) {
    ctx.journal.shift();
    ctx.perdus += 1;
  }
}

/** Appelle un exécuteur ; toute défaillance (synchrone ou rejet) est consignée, jamais propagée. */
function appeler(ctx, nom, ...arguments_) {
  try {
    const rendu = ctx.executeurs[EXECUTEUR_DE[nom] ?? nom](...arguments_);
    if (rendu !== null && typeof rendu === "object" && typeof rendu.then === "function") {
      rendu.then(undefined, (erreur) => journaliser(ctx, nom, erreur));
    }
    return rendu;
  } catch (erreur) {
    journaliser(ctx, nom, erreur);
    return undefined;
  }
}

// --- Les issues asynchrones : produites par le magasin, mises en file -------------------------------

/** Un événement INTERNE (issue d'une promesse) : en file si on applique, sinon traité tout de suite. */
function enfiler(ctx, evenement) {
  if (ctx.termine) return;
  ctx.file.push(evenement);
  if (!ctx.enApplication) vider(ctx);
}

/** Si une défaillance interne survient en V, le doute l'emporte (conservateur). */
function forcerLeDoute(ctx) {
  if (ctx.etat.phase !== "V") return;
  try {
    const resultat = transiter(ctx.etat, { type: "erreur-sans-code" });
    if (resultat.accepte) ctx.etat = resultat.etat;
  } catch (erreur) {
    journaliser(ctx, "interne", erreur);
  }
}

function vider(ctx) {
  while (ctx.file.length > 0 && !ctx.termine) {
    const evenement = ctx.file.shift();
    ctx.enApplication = true;
    try {
      traiter(ctx, evenement);
    } catch (erreur) {
      journaliser(ctx, "interne", erreur);
      forcerLeDoute(ctx);
    } finally {
      ctx.enApplication = false;
    }
  }
}

/** Lance, protège contre l'exception SYNCHRONE : elle devient un rejet. */
function demarrer(fonction, ...arguments_) {
  try {
    return Promise.resolve(fonction(...arguments_));
  } catch (erreur) {
    return Promise.reject(erreur);
  }
}

function evenementDEchec(type, erreur) {
  return { type, code: codeDeLErreur(erreur) };
}

/** L'ENVOI : l'issue de la promesse est classée par `evenementDeLaReponse`, jamais par l'appelant. */
function lancerEnvoyer(ctx) {
  demarrer(ctx.executeurs.envoyer).then(
    (valeur) => enfiler(ctx, { type: evenementDeLaReponse({ ok: true, valeur }) }),
    (erreur) => enfiler(ctx, evenementDEchec(evenementDeLaReponse({ ok: false, erreur }), erreur)),
  );
}

/** La LECTURE : la normalisation est faite ICI ; un échec devient `relecture-echouee` (I19). */
function lancerRelire(ctx, effet) {
  const { lecture } = effet;
  const ouvert = ctx.etat.phase === "SL" || ctx.etat.phase === "RL";
  demarrer(ctx.executeurs.relire, lecture).then(
    (valeur) => {
      const normalise = normaliserLInventaire(valeur, { ouvert });
      enfiler(
        ctx,
        normalise.ok
          ? { type: "relecture-reussie", lecture, donnees: normalise.donnees }
          : { type: "relecture-echouee", lecture, cause: "normalisation-echouee" },
      );
    },
    (erreur) => enfiler(ctx, { ...evenementDEchec("relecture-echouee", erreur), lecture }),
  );
}

/** La MODIFICATION : toute issue relance la lecture (e20) ; une mort du Worker est e7. */
function lancerModification(ctx) {
  const lanceur = ctx.lanceur;
  ctx.lanceur = null;
  const fin = (erreur) =>
    codeDeLErreur(erreur) === CODES_REFUS_COQUILLE.workerMort
      ? evenementDEchec("worker-mort", erreur)
      : { type: "modification-terminee" };
  demarrer(lanceur).then(
    () => enfiler(ctx, { type: "modification-terminee" }),
    (erreur) => enfiler(ctx, fin(erreur)),
  );
}

/** `noter` : l'indice n'est appliqué que si AUCUNE remise à zéro n'a été demandée depuis (rang). */
function lancerNoter(ctx) {
  const rang = ctx.rangIndice;
  demarrer(ctx.executeurs.noter).then(
    () => {
      if (ctx.rangIndice === rang) enfiler(ctx, { type: "indice-change", valeur: true });
    },
    (erreur) => journaliser(ctx, "noter", erreur),
  );
}

const LANCEURS = Object.freeze({
  envoyer: lancerEnvoyer,
  relire: lancerRelire,
  lancer: lancerModification,
  noter: lancerNoter,
});

// --- Les effets --------------------------------------------------------------------------------------

function executerUnEffet(ctx, effet) {
  const lanceur = LANCEURS[effet.nom];
  if (lanceur !== undefined) {
    try {
      lanceur(ctx, effet);
    } catch (erreur) {
      journaliser(ctx, effet.nom, erreur);
    }
    return;
  }
  if (effet.nom === "masquer") masquerVerifie(ctx);
  else if (effet.nom === "publier") appeler(ctx, "publier", effet.lecture, effet.donnees);
  else if (effet.nom === "consigner") {
    appeler(ctx, "consigner", { evenement: effet.evenement, code: effet.code });
  } else appeler(ctx, effet.nom);
}

function executerLesEffets(ctx, effets, dejaMasque) {
  for (const effet of effets) {
    if (effet.nom === "masquer" && dejaMasque) continue;
    executerUnEffet(ctx, effet);
  }
}

/** Le masquage est-il ÉTABLI ? Seul `true` vaut oui : faux, exception, non-booléen → non (I23″). */
function masquerVerifie(ctx) {
  try {
    if (ctx.executeurs.masquer() === true) return true;
    journaliser(ctx, "masquer", "masquage non établi");
  } catch (erreur) {
    journaliser(ctx, "masquer", erreur);
  }
  return false;
}

/** Le pré-vol a échoué : on N'affecte PAS l'état cible, on ferme depuis l'état SOURCE (e22). */
function basculer(ctx, evenement) {
  const action = evenement.type === "oui" ? "envoi" : "modification";
  const resultat = transiter(ctx.etat, { type: "masquage-impossible", action });
  if (resultat.accepte) {
    ctx.etat = resultat.etat;
    executerLesEffets(ctx, resultat.effets, true);
  }
  return Object.freeze({ ...resultat, accepte: false });
}

function traiter(ctx, evenement) {
  const resultat = transiter(ctx.etat, evenement);
  if (!resultat.accepte) return resultat;
  const garde = resultat.effets.some((effet) => LANCEURS_D_ENVELOPPE.includes(effet.nom));
  if (garde && !masquerVerifie(ctx)) {
    ctx.lanceur = null;
    return basculer(ctx, evenement);
  }
  ctx.etat = resultat.etat;
  executerLesEffets(ctx, resultat.effets, garde);
  return resultat;
}

// --- L'API publique ----------------------------------------------------------------------------------

function exigerVivant(ctx) {
  if (ctx.termine) throw new TypeError("l'instance est terminée.");
}

/** Une entrée EXTÉRIEURE : refuse la réentrance, traite, puis vide la file des issues. */
function entrer(ctx, travail) {
  exigerVivant(ctx);
  if (ctx.enApplication) throw new TypeError("réentrance refusée.");
  ctx.enApplication = true;
  let rendu;
  try {
    rendu = travail();
  } finally {
    ctx.enApplication = false;
  }
  vider(ctx);
  return rendu;
}

const resume = (resultat) =>
  Object.freeze({ accepte: resultat.accepte, annonce: resultat.annonce });

function appliquerPublic(ctx, evenement) {
  if (!EVENEMENTS_PUBLICS.has(evenement?.type)) {
    throw new TypeError(`événement non appelable de l'extérieur : ${String(evenement?.type)}.`);
  }
  return entrer(ctx, () => resume(traiter(ctx, evenement)));
}

function modifierPublic(ctx, lanceur) {
  if (typeof lanceur !== "function") throw new TypeError("« lanceur » doit être une fonction.");
  return entrer(ctx, () => {
    ctx.lanceur = lanceur;
    const resultat = traiter(ctx, { type: "modification-lancee" });
    ctx.lanceur = null;
    return resume(resultat);
  });
}

function definirLIndice(ctx, valeur) {
  if (typeof valeur !== "boolean") throw new TypeError("« indice » doit être un booléen.");
  return entrer(ctx, () => {
    ctx.rangIndice += 1;
    return resume(traiter(ctx, { type: "indice-change", valeur }));
  });
}

/**
 * @param {{ executeurs: object, indice: boolean }} options `indice` : booléen OBLIGATOIRE
 */
export function creerLaRevocation({ executeurs, indice } = {}) {
  verifierLesExecuteurs(executeurs);
  const ctx = {
    executeurs,
    etat: etatInitial(indice),
    termine: false,
    enApplication: false,
    file: [],
    lanceur: null,
    rangIndice: 0,
    rang: 0,
    journal: [],
    perdus: 0,
  };
  return Object.freeze({
    etat: () => ctx.etat,
    projection: () => projeter(ctx.etat),
    empreinte: () => empreinteDeLEtat(ctx.etat),
    occurrence: () => ctx.etat.occurrence,
    accepte: (type) => accepte(ctx.etat, type),
    demarrer: () => entrer(ctx, () => resume(traiter(ctx, { type: "montage" }))),
    appliquer: (evenement) => appliquerPublic(ctx, evenement),
    modifier: (lanceur) => modifierPublic(ctx, lanceur),
    definirLIndice: (valeur) => definirLIndice(ctx, valeur),
    terminer: () => {
      ctx.termine = true;
      ctx.file.length = 0;
    },
    echecs: () => Object.freeze({ entrees: Object.freeze([...ctx.journal]), perdus: ctx.perdus }),
  });
}
