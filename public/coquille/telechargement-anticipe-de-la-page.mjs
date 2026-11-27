// Le TÉLÉCHARGEMENT ANTICIPÉ, côté page (#348) : lancé dès que la progression du parcours est lue.
//
// Ce module de branchement ne décide rien : `src/coquille/telechargement-anticipe.mjs` dit s'il est
// voulu et ce qui se publie de son bilan. Il crée le Worker qui fait le travail, et ne lui envoie rien.
// Il ne lit ni n'écrit aucune donnée du coffre : le relevé n'apprend qu'une issue et des statuts.

import { moteurProbable } from "/src/coquille/attente-annoncee.mjs";
import {
  bilanPublie,
  telechargementAnticipeVoulu,
} from "/src/coquille/telechargement-anticipe.mjs";

/**
 * @param {{ rapport: object, publier: () => void, navigateur: Navigator, vueComplete: boolean,
 *           creerLeWorker?: () => Worker }} hote
 * @returns {(progression: { etapeAtteinte: number }) => void} à appeler une fois, la progression lue
 */
export function creerLeTelechargementAnticipe({
  rapport,
  publier,
  navigateur,
  vueComplete,
  creerLeWorker = () =>
    new Worker(new URL("./prechargement-worker.mjs", import.meta.url), {
      type: "module",
      name: "telechargement-anticipe",
    }),
}) {
  let lance = false;
  const noter = (releve) => {
    rapport.telechargementAnticipe = releve;
    publier();
  };
  return function lancerSiVoulu({ etapeAtteinte }) {
    if (lance) return;
    lance = true;
    const decision = telechargementAnticipeVoulu({
      etapeAtteinte,
      moteur: moteurProbable(navigateur.userAgent),
      vueComplete,
    });
    if (!decision.voulu) return noter({ issue: `ecarte:${decision.motif}` });
    let worker;
    try {
      worker = creerLeWorker();
    } catch (erreur) {
      // Sans lui, rien ne change : l'étape 4 télécharge, comme avant. L'échec est publié, pas avalé.
      return noter({ issue: `non-lance:${erreur?.name ?? "Error"}` });
    }
    noter({ issue: "en-cours" });
    worker.addEventListener("message", (evenement) => noter(bilanPublie(evenement.data)));
    worker.addEventListener("error", () => noter({ issue: "echec" }));
  };
}
