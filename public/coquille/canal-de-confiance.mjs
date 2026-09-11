// Le CANAL PRIVILÉGIÉ et le WORKER DE CONFIANCE (#175 : scission de `public/main.mjs`).
//
// Ce module NE DÉCIDE rien : les refus, l'état du coffre et la conduite après la mort restent dans
// `src/coquille/`. Il tient le Worker, le canal qui y mène, et les deux enveloppes de requête/
// réponse — c'est la même frontière que celle que l'ADR 0028 dessinait déjà dans `main.mjs`, rendue
// SEULE ici.
//
// Il ne parle aux trois autres modules de branchement que par le RELEVÉ (`rapport`, `publier`) et
// par les quelques fonctions que `main.mjs` lui passe explicitement (le pont). Il n'importe aucun
// des trois autres modules de branchement.

import {
  TYPES_PRIVILEGIES,
  decoderMessage,
  enveloppeDeMessage,
  REPONSES_PRIVILEGIEES,
  enveloppePrivilegiee,
} from "/src/coquille/contrat-de-messages.mjs";
import { chargeUtileDEtat } from "/src/coquille/etat-de-la-coquille.mjs";
import { CAUSES_DE_MORT } from "/src/coquille/mort-du-worker.mjs";
import { DELAI_WORKER_MORT_MS } from "/src/coquille/moyens-de-deverrouillage.mjs";

/**
 * Compte un refus, par code. Rien d'autre n'est retenu de ce que le Worker a envoyé — le même choix
 * que celui de la frontière applicative, motivé par le même incident (revue de la PR #166).
 *
 * @param {Record<string, number>} compteurs
 * @param {string} code
 */
function compter(compteurs, code) {
  compteurs[code] = (compteurs[code] ?? 0) + 1;
}

/**
 * @param {object} config
 * @param {object} config.rapport le relevé public de la coquille, partagé par référence
 * @param {() => void} config.publier republie le relevé
 * @param {{ cycle: { estMort(): boolean, constaterLaMort(cause: string): unknown, refusDeMort(): Error }, verrouillage: { refletDeLEtat(): void, signalerActivite(nom: string): void }, frontiere: { pousserLaBarriere(): void } }} config.pont
 *   le pont vers les trois autres modules de branchement, peuplé par `main.mjs` au fur et à mesure
 *   de leur construction ; chaque clé n'est lue qu'APRÈS que le module correspondant existe.
 */
export function creerCanalDeConfiance({ rapport, publier, pont }) {
  /**
   * Le Worker de confiance est chargé avec `?use-scheduling-api`, et ce n'est PAS décoratif.
   *
   * v86 choisit sa boucle d'ordonnancement à l'évaluation de son module, en inspectant
   * `location.href` du contexte qui l'importe (ADR 0013, § « Mise en œuvre par #74 ») : sans ce
   * marqueur, il retombe sur un Worker imbriqué chargé depuis une URL `blob:` — que la CSP de la
   * coquille refuse (`worker-src 'self'`, ADR 0013).
   */
  const worker = new Worker(new URL("../runtime-worker.mjs?use-scheduling-api", import.meta.url), {
    type: "module",
    name: "vault-coquille-confiance",
  });
  const privilegie = new MessageChannel();

  worker.addEventListener("error", () => pont.cycle.constaterLaMort(CAUSES_DE_MORT.erreur));
  worker.addEventListener("messageerror", () => pont.cycle.constaterLaMort(CAUSES_DE_MORT.erreur));

  /**
   * Les demandes EN VOL vers le Worker, APPARIÉES par leur identifiant de corrélation (#166).
   */
  const demandesEnVol = new Map();

  /** Compteur des corrélations du canal privilégié. Il ne quitte jamais l'origine de confiance. */
  let corrélationSuivante = 0;

  privilegie.port1.addEventListener("message", (event) => surMessagePrivilegie(event.data));
  privilegie.port1.start();
  worker.postMessage(enveloppeDeMessage(TYPES_PRIVILEGIES.canal), [privilegie.port2]);

  /** @param {unknown} donnee */
  function surMessagePrivilegie(donnee) {
    const decode = decoderMessage(donnee);
    if (!decode.ok) return;
    if (decode.type === TYPES_PRIVILEGIES.etatReponse) {
      rapport.etat = decode.message.etat;
      rapport.barrieres = decode.message.barrieres;
      pont.verrouillage.refletDeLEtat();
      publier();
    }
    if (decode.type === TYPES_PRIVILEGIES.deverrouillageReponse) {
      rapport.etat = decode.message.etat;
      rapport.barrieres = decode.message.barrieres;
      pont.verrouillage.refletDeLEtat();
      publier();
    }
    if (decode.type === TYPES_PRIVILEGIES.battement) {
      // Un SIGNE DE VIE, et rien d'autre : il ne règle aucune promesse, il repousse la borne de
      // l'attente qu'il nomme.
      demandesEnVol.get(decode.message.correlation)?.repousser();
      return;
    }
    if (decode.type === TYPES_PRIVILEGIES.barriere) {
      rapport.barrieres = decode.message.barrieres;
      pont.verrouillage.signalerActivite("barriere");
      publier();
      pont.frontiere.pousserLaBarriere();
      return;
    }
    if (decode.type === TYPES_PRIVILEGIES.refus) {
      rapport.requetesRefusees += 1;
      compter(rapport.refusDeRequete, decode.message.code);
      publier();
    }
    if (!REPONSES_PRIVILEGIEES.has(decode.type)) return;
    const attente = demandesEnVol.get(decode.message.correlation);
    if (attente === undefined) return;
    demandesEnVol.delete(decode.message.correlation);
    if (decode.type === TYPES_PRIVILEGIES.refus) {
      return attente.refuser(
        Object.assign(new Error(decode.message.message ?? "geste refusé"), {
          code: decode.message.code,
        }),
      );
    }
    attente.rendre(decode.message);
  }

  /**
   * Aller-retour vers le Worker de confiance, sous une corrélation qui n'appartient qu'à lui.
   *
   * @param {string} nomDuType clé de `TYPES_PRIVILEGIES`
   * @param {Record<string, unknown>} corps
   */
  function demanderAuWorker(nomDuType, corps = {}) {
    if (pont.cycle.estMort()) return Promise.reject(pont.cycle.refusDeMort());
    corrélationSuivante += 1;
    const correlation = `c${corrélationSuivante}`;
    return new Promise((rendre, refuser) => {
      let minuterie = null;
      const armer = () => {
        minuterie = setTimeout(() => {
          demandesEnVol.delete(correlation);
          pont.cycle.constaterLaMort(CAUSES_DE_MORT.silence);
          refuser(pont.cycle.refusDeMort());
        }, DELAI_WORKER_MORT_MS);
      };
      armer();
      const clore = (geste) => (valeur) => {
        clearTimeout(minuterie);
        geste(valeur);
      };
      demandesEnVol.set(correlation, {
        rendre: clore(rendre),
        refuser: clore(refuser),
        repousser: () => {
          clearTimeout(minuterie);
          armer();
        },
      });
      privilegie.port1.postMessage(
        enveloppePrivilegiee(TYPES_PRIVILEGIES[nomDuType], { ...corps, correlation }),
      );
    });
  }

  /** Le dernier état CONNU, tel que le relevé le publie. Il n'est jamais plus vieux que lui. */
  function rapportDEtat() {
    return { etat: rapport.etat, barrieres: rapport.barrieres };
  }

  /**
   * La demande d'état, sous la forme que le port restreint attend en retour. Elle ne REJETTE
   * jamais (voir le raisonnement original dans l'historique de `main.mjs` avant #175) : un refus du
   * Worker sur la question d'état est un défaut de la coquille, jamais une faute du document
   * applicatif.
   */
  async function demanderLEtat() {
    try {
      const reponse = await demanderAuWorker("etat");
      return chargeUtileDEtat({ etat: reponse.etat, barrieres: reponse.barrieres });
    } catch {
      return chargeUtileDEtat(rapportDEtat());
    }
  }

  /**
   * L'état PRIVILÉGIÉ, avec ce que le port restreint ne reçoit jamais : le constat d'exclusivité.
   */
  async function demanderLEtatPrivilegie() {
    try {
      return await demanderAuWorker("etat");
    } catch {
      return rapportDEtat();
    }
  }

  return {
    worker,
    demanderAuWorker,
    demanderLEtat,
    demanderLEtatPrivilegie,
    rapportDEtat,
    terminerLeWorker: () => worker.terminate(),
    /** Rejette toute demande en vol avec l'erreur que `fabriquerLeRefus` construit. */
    rejeterTout(fabriquerLeRefus) {
      for (const [correlation, attente] of demandesEnVol) {
        demandesEnVol.delete(correlation);
        attente.refuser(fabriquerLeRefus());
      }
    },
  };
}
