// Coquille du banc de résilience (#15).
//
// C'est ELLE qui exécute l'arrêt réel : `Worker.terminate()`, appelé pendant que le Worker qui
// vient d'écrire tient encore le handle exclusif du volume OPFS, sans fermeture et sans barrière.
// Un backend ne peut pas se tuer lui-même de façon crédible ; la page le peut.
//
// La coquille n'ouvre aucun volume et ne voit jamais un handle. Elle planifie, elle tue, elle
// recueille des comptes rendus. Le jeton du harnais n'est transmis qu'au Worker qui coupe : ni le
// Worker qui prépare l'ancien état, ni celui qui relit ne peuvent armer quoi que ce soit.

import { HARNAIS_CLE_JETON } from "/src/vm/cle-de-volume.mjs";
import { HARNAIS_RESILIENCE_JETON } from "/src/vm/crash-harness.mjs";
import { planifierCoupures } from "/src/vm/crash-plan.mjs";
import { resumerMatrice } from "/src/vm/crash-report.mjs";
import { profilDuScenario } from "/src/vm/crash-scenario.mjs";

const etat = document.querySelector("#etat");
const rapport = document.querySelector("#rapport");

/**
 * Branche un Worker runtime et rend de quoi lui parler. `?use-scheduling-api` est repris de
 * `banc.mjs` : v86 choisit sa boucle en inspectant `location.href`, et ces Workers sont les mêmes
 * que ceux du produit, même si aucun scénario de résilience ne construit d'émulateur.
 */
function brancher(nom) {
  const worker = new Worker("/vm/runtime-worker.mjs?use-scheduling-api", {
    type: "module",
    name: nom,
  });
  const enCours = new Map();
  let compteur = 0;

  worker.addEventListener("message", (event) => {
    const { id, ok, report, error } = event.data ?? {};
    const attente = enCours.get(id);
    if (!attente) return;
    enCours.delete(id);
    if (ok) attente.resolve(report);
    else attente.reject(new Error(`${error?.code ?? "sans code"} — ${error?.message ?? "échec"}`));
  });

  worker.addEventListener("error", (event) => {
    for (const attente of enCours.values()) {
      attente.reject(new Error(`Erreur du Worker « ${nom} » : ${event.message}`));
    }
    enCours.clear();
  });

  return {
    worker,
    demander(payload) {
      compteur += 1;
      const id = compteur;
      return new Promise((resolve, reject) => {
        enCours.set(id, { resolve, reject });
        worker.postMessage({
          id,
          type: "run",
          // Jeton de la CLÉ DE VOLUME de TEST, distinct de celui du harnais d'arrêts : les deux
          // gardes protègent des choses différentes et ne se remplacent pas (ADR 0016).
          payload: { ...payload, jetonCle: HARNAIS_CLE_JETON },
        });
      });
    },
  };
}

/**
 * Rejoue UN point : ancien état, coupure, mort du Worker, relecture, classement.
 *
 * @param {{ demander: (payload: object) => Promise<object> }} atelier Worker de longue vie, qui
 *   prépare et relit. Il ne reçoit jamais le jeton du harnais.
 * @param {object} point point de coupure planifié
 */
async function rejouerPoint(atelier, point, fraicheur = []) {
  await atelier.demander({ scenario: "resilience-preparer" });

  const coupeur = brancher("vault-resilience-coupeur");
  let coupe;
  try {
    coupe = await coupeur.demander({
      scenario: "resilience-couper",
      point,
      fraicheur,
      jeton: HARNAIS_RESILIENCE_JETON,
    });
  } finally {
    // L'ARRÊT RÉEL. Le Worker tient encore le handle exclusif : ni `close()`, ni `flush()`, ni
    // fermeture ordonnée. Ce que le volume garde après cela est ce que la coupure a laissé.
    coupeur.worker.terminate();
  }

  const classement = await atelier.demander({
    scenario: "resilience-classer",
    journal: coupe.journal,
  });

  return {
    point,
    verdict: classement.verdict,
    raison: classement.raison,
    atomique: classement.atomique,
    classes: classement.classes,
    blocs: classement.blocs,
    reouverture: classement.reouverture,
    // Ce que la récupération de #16 a trouvé et fait à la réouverture : génération écartée, rejouée,
    // ou rien en attente. Le relayer est ce qui distingue « la coupure n'a rien laissé » de « la
    // génération a été écartée » — deux états que le seul verdict de l'oracle ne sépare pas.
    recuperation: classement.recuperation,
    // Relayés jusqu'au compte rendu : ils disent si la règle `SEC-DURABLE-001` a seulement pu se
    // déclencher. Les perdre en route rendrait un taux atomique plus flatteur, sans le dire.
    journalConsulte: classement.journalConsulte,
    entreesJournal: classement.entreesJournal,
    // Combien d'états l'oracle savait NOMMER. Deux ne dit pas la même chose que quatre.
    generationsAttendues: classement.generationsAttendues,
    ecritures: coupe.ecritures,
    barrieres: coupe.barrieres,
    arret: coupe.arret,
    fautesTirees: coupe.fautesTirees,
    fautesNonTirees: coupe.fautesNonTirees,
    fraicheurTirees: coupe.fraicheurTirees,
    fraicheurNonTirees: coupe.fraicheurNonTirees,
  };
}

/**
 * Rejoue la matrice d'une graine sur le vrai support et rend son compte rendu.
 * @param {{ graine?: number, points?: number }} options
 */
async function executerMatrice({ graine = 2026, points = 8 } = {}) {
  const suite = planifierCoupures(graine, profilDuScenario(points));
  const atelier = brancher("vault-resilience-atelier");
  const resultats = [];
  try {
    for (const point of suite) {
      etat.textContent = `Point ${point.index + 1}/${suite.length} — ${point.kind} sur ${point.operation}#${point.occurrence}…`;
      resultats.push(await rejouerPoint(atelier, point));
    }
  } finally {
    atelier.worker.terminate();
  }

  const resume = resumerMatrice({ graine, resultats, support: "OPFS réel (Chromium)" });
  const compteRendu = { resume, resultats };
  etat.textContent = `Terminé : taux « ancien ou nouveau » ${resume.tauxAtomique}.`;
  rapport.textContent = JSON.stringify(compteRendu, null, 2);
  return compteRendu;
}

/**
 * Rejoue UN point nommé explicitement, sans passer par une graine. Sert à éprouver un genre de
 * coupure précis sur le vrai support, là où une matrice ne garantit pas qu'il sera tiré.
 * @param {object} point
 */
async function executerPoint(point, fraicheur = []) {
  const atelier = brancher("vault-resilience-atelier");
  try {
    etat.textContent = `Point isolé — ${point.kind} sur ${point.operation}#${point.occurrence}…`;
    const resultat = await rejouerPoint(atelier, point, fraicheur);
    etat.textContent = `Terminé : verdict « ${resultat.verdict} ».`;
    rapport.textContent = JSON.stringify(resultat, null, 2);
    return resultat;
  } finally {
    atelier.worker.terminate();
  }
}

/**
 * RECLASSE le volume tel qu'il est, sans rien y écrire, avec le journal fourni. Sert au témoin
 * négatif de la règle `SEC-DURABLE-001` : la relecture reste RÉELLE — ce sont les octets qu'une
 * vraie coupure a laissés sur OPFS —, seul le journal est trafiqué pour prétendre qu'un bloc resté
 * à l'ancien état avait été écrit puis franchi par une barrière.
 * @param {object[]} journal
 */
async function reclasserAvec(journal) {
  const atelier = brancher("vault-resilience-atelier");
  try {
    etat.textContent = "Reclassement avec un journal fourni…";
    const classement = await atelier.demander({ scenario: "resilience-classer", journal });
    etat.textContent = `Reclassé : verdict « ${classement.verdict} ».`;
    rapport.textContent = JSON.stringify(classement, null, 2);
    return classement;
  } finally {
    atelier.worker.terminate();
  }
}

globalThis.bancResilience = Object.freeze({ executerMatrice, executerPoint, reclasserAvec });
etat.textContent = "Banc de résilience prêt.";
