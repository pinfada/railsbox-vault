// L'OBSERVATEUR DE FRAÎCHEUR de la réserve (#299, ADR 0048 § 8) : la page le garde POUR TOUTE SA VIE.
//
// La fraîcheur n'est pas un instantané du portail. `updatefound` sur l'inscription, `statechange` de chaque
// Worker installant et, à chaque `installed`, une question `version` bornée au Worker en attente : l'état
// est recalculé par la même fonction pure, le bandeau est mis à jour, et TOUT calcul de l'état « révocation
// connue » l'ÉCRIT dans l'état partagé (monotone) que chaque portail relit avant `new Worker`. Une
// révocation connue après le délai du portail, ou après l'ouverture de la session, est donc ANNONCÉE sans
// interrompre la session : le Worker de confiance n'est pas terminé, la clé reste utilisable, aucun
// `controllerchange` n'est émis. Ce qu'elle change : plus aucun Worker n'est créé.
//
// Le prototype calculait l'état une fois puis retirait son écouteur : c'était un écart du banc à la
// décision. Il n'existe ICI aucun `removeEventListener`.

import {
  ETATS_DE_FRAICHEUR as E,
  causeDeLaRevocation,
  etatDeFraicheur,
} from "./reserve-fraicheur.mjs";
import { apresUnDelai, interroger } from "./reserve-questions.mjs";

const REGLE = new Set(["installed", "redundant", "activated"]);

/** L'état affiché : une révocation connue ne se défait pas, le bandeau non plus. */
function etatAffiche(ctx) {
  return ctx.etatPartage.connue()
    ? E.REVOCATION_CONNUE
    : etatDeFraicheur({
        maj: ctx.maj,
        attente: ctx.attente,
        sequenceCourante: ctx.sequenceCourante,
      });
}

/** Recalcule l'état, ÉCRIT l'état partagé si c'est une révocation connue, et prévient le bandeau. */
function recalculer(ctx) {
  ctx.etatPartage.noter(causeDeLaRevocation(ctx.attente, ctx.sequenceCourante));
  const etat = etatAffiche(ctx);
  ctx.surEtat(etat);
  return etat;
}

function estUneIdentite(reponse) {
  return (
    reponse !== null &&
    typeof reponse === "object" &&
    Number.isInteger(reponse.sequence) &&
    Number.isInteger(reponse.plancher)
  );
}

/** Identifie le Worker en attente : sa version, son plancher, ou — s'il se tait — « muet », jamais inventé. */
function identifierLAttente(ctx) {
  const enAttente = ctx.registration.waiting;
  if (!enAttente) {
    ctx.attente = null;
    recalculer(ctx);
    return Promise.resolve();
  }
  ctx.identification = interroger(enAttente, "version", ctx.delaiReponseMs).then((reponse) => {
    ctx.attente = estUneIdentite(reponse)
      ? {
          muet: false,
          sequence: reponse.sequence,
          plancher: reponse.plancher,
          retrait: reponse.retrait === true,
        }
      : { muet: true };
    recalculer(ctx);
  });
  return ctx.identification;
}

/** Suit un Worker installant : `installed` l'identifie, `redundant` avant `installed` est un rejet. */
function suivre(ctx, worker) {
  if (!worker || ctx.suivis.has(worker)) return;
  ctx.suivis.add(worker);
  worker.addEventListener("statechange", () => {
    if (worker.state === "installed") {
      ctx.installes.add(worker);
      void identifierLAttente(ctx);
    } else if (worker.state === "redundant") {
      if (!ctx.installes.has(worker)) {
        // Rejeté AVANT d'avoir été installé : une version différente est apparue et n'a pas pu s'installer.
        ctx.installationRejetee = true;
        ctx.maj = "rejetee";
      } else if (ctx.registration.waiting === null) {
        ctx.attente = null;
      }
      recalculer(ctx);
    }
  });
}

/** Une promesse qui se règle quand le Worker n'est plus `installing`. */
function installationReglee(worker) {
  return new Promise((resoudre) => {
    const verifier = () => {
      if (REGLE.has(worker.state)) resoudre("regle");
    };
    worker.addEventListener("statechange", verifier);
    verifier();
  });
}

/**
 * Lance `registration.update()` et OBSERVE son résultat réel, puis attend l'installation qu'il a pu
 * déclencher (`update()` résout AVANT sa fin), bornée par `delaiMs`.
 */
async function verifier(ctx, delaiMs) {
  ctx.maj = "en-cours";
  recalculer(ctx);
  const debut = Date.now();
  const miseAJour = Promise.resolve()
    .then(() => ctx.registration.update())
    .then(
      () => "ok",
      () => "echec",
    );
  let issue = await Promise.race([miseAJour, apresUnDelai(delaiMs, "delai")]);
  if (issue === "ok" && ctx.registration.installing) {
    const restant = Math.max(0, delaiMs - (Date.now() - debut));
    const fin = await Promise.race([
      installationReglee(ctx.registration.installing),
      apresUnDelai(restant, "delai"),
    ]);
    if (fin === "delai") issue = "delai";
  }
  await Promise.race([ctx.identification, apresUnDelai(ctx.delaiReponseMs * 2, null)]);
  ctx.maj = issue === "ok" && ctx.installationRejetee ? "rejetee" : issue;
  return { maj: ctx.maj, attente: ctx.attente, etat: recalculer(ctx) };
}

/**
 * @param {object} o
 * @param {any} o.registration l'inscription de la coquille
 * @param {ReturnType<import("./reserve-etat-partage.mjs").creerEtatPartage>} o.etatPartage
 * @param {(etat: import("./reserve-fraicheur.mjs").EtatDeFraicheur) => void} o.surEtat
 * @param {number} o.sequenceCourante
 * @param {number} o.delaiReponseMs
 */
export function creerLObservateur({
  registration,
  etatPartage,
  surEtat,
  sequenceCourante,
  delaiReponseMs,
}) {
  const ctx = {
    registration,
    etatPartage,
    surEtat,
    sequenceCourante,
    delaiReponseMs,
    maj: "non-tentee",
    /** @type {null | { muet?: boolean, sequence?: number, plancher?: number, retrait?: boolean }} */
    attente: null,
    identification: Promise.resolve(),
    suivis: new WeakSet(),
    installes: new WeakSet(),
    installationRejetee: false,
  };
  registration.addEventListener("updatefound", () => {
    suivre(ctx, registration.installing);
    recalculer(ctx);
  });
  suivre(ctx, registration.installing);
  if (registration.waiting) void identifierLAttente(ctx);
  return {
    verifier: (delaiMs) => verifier(ctx, delaiMs),
    /** L'état affiché, tel que le dernier calcul l'a rendu. */
    etat: () => etatAffiche(ctx),
  };
}
