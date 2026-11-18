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
  let maj = "non-tentee";
  /** @type {null | { muet?: boolean, sequence?: number, plancher?: number, retrait?: boolean }} */
  let attente = null;
  let identification = Promise.resolve();
  const suivis = new WeakSet();
  const installes = new WeakSet();
  let installationRejetee = false;

  /** Recalcule l'état, ÉCRIT l'état partagé si c'est une révocation connue, et prévient le bandeau. */
  function recalculer() {
    etatPartage.noter(causeDeLaRevocation(attente, sequenceCourante));
    // Une révocation connue ne se défait pas : le bandeau non plus (même nature que l'état partagé).
    const etat = etatPartage.connue()
      ? E.REVOCATION_CONNUE
      : etatDeFraicheur({ maj, attente, sequenceCourante });
    surEtat(etat);
    return etat;
  }

  /** Identifie le Worker en attente : sa version, son plancher, ou — s'il se tait — « muet », jamais inventé. */
  function identifierLAttente() {
    const enAttente = registration.waiting;
    if (!enAttente) {
      attente = null;
      recalculer();
      return Promise.resolve();
    }
    identification = interroger(enAttente, "version", delaiReponseMs).then((reponse) => {
      attente = estUneIdentite(reponse)
        ? {
            muet: false,
            sequence: reponse.sequence,
            plancher: reponse.plancher,
            retrait: reponse.retrait === true,
          }
        : { muet: true };
      recalculer();
    });
    return identification;
  }

  function suivre(worker) {
    if (!worker || suivis.has(worker)) return;
    suivis.add(worker);
    worker.addEventListener("statechange", () => {
      if (worker.state === "installed") {
        installes.add(worker);
        void identifierLAttente();
      } else if (worker.state === "redundant") {
        // Rejeté AVANT d'avoir été installé : une version différente est apparue et n'a pas pu s'installer.
        if (!installes.has(worker)) {
          installationRejetee = true;
          maj = "rejetee";
        } else if (registration.waiting === null) attente = null;
        recalculer();
      }
    });
  }

  registration.addEventListener("updatefound", () => {
    suivre(registration.installing);
    recalculer();
  });
  suivre(registration.installing);
  if (registration.waiting) void identifierLAttente();

  /** Une promesse qui se règle quand le Worker installant n'est plus `installing`. */
  const installationReglee = (worker) =>
    new Promise((resoudre) => {
      const verifier = () => {
        if (REGLE.has(worker.state)) resoudre("regle");
      };
      worker.addEventListener("statechange", verifier);
      verifier();
    });

  return {
    /**
     * Lance `registration.update()` et OBSERVE son résultat réel, puis attend l'installation qu'il a pu
     * déclencher (`update()` résout AVANT sa fin), bornée par `delaiMs`.
     */
    async verifier(delaiMs) {
      maj = "en-cours";
      recalculer();
      const debut = Date.now();
      const miseAJour = Promise.resolve()
        .then(() => registration.update())
        .then(
          () => "ok",
          () => "echec",
        );
      let issue = await Promise.race([miseAJour, apresUnDelai(delaiMs, "delai")]);
      if (issue === "ok" && registration.installing) {
        const restant = Math.max(0, delaiMs - (Date.now() - debut));
        const fin = await Promise.race([
          installationReglee(registration.installing),
          apresUnDelai(restant, "delai"),
        ]);
        if (fin === "delai") issue = "delai";
      }
      await Promise.race([identification, apresUnDelai(delaiReponseMs * 2, null)]);
      maj = issue === "ok" && installationRejetee ? "rejetee" : issue;
      return { maj, attente, etat: recalculer() };
    },
    /** L'état affiché, tel que le dernier calcul l'a rendu. */
    etat: () =>
      etatPartage.connue()
        ? E.REVOCATION_CONNUE
        : etatDeFraicheur({ maj, attente, sequenceCourante }),
  };
}

function estUneIdentite(reponse) {
  return (
    reponse !== null &&
    typeof reponse === "object" &&
    Number.isInteger(reponse.sequence) &&
    Number.isInteger(reponse.plancher)
  );
}
