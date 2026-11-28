// Le Worker du TÉLÉCHARGEMENT ANTICIPÉ (#348) : il range au magasin les artefacts du premier démarrage
// pendant les étapes 1 à 3 du parcours, puis il meurt.
//
// Un Worker À PART, et non le Worker de confiance : il ne détient rien — ni port privilégié, ni clé,
// ni handle de volume — et il hache et décompresse plus de 200 Mio sans prendre le fil de la page
// ni celui qui sert les gestes du coffre. Il ne reçoit AUCUN message : il lit le descripteur public de
// l'origine, comme l'étape 4 le lira, et ne poste qu'un bilan fait de mots (aucun octet, aucune adresse).
//
// Hors connexion, sans descripteur, sans stockage ou sans place, il ne demande rien au réseau ; l'étape
// 4 fait alors ce qu'elle faisait avant lui.

import { lireLeDescripteur } from "/src/coquille/descripteur-applicatif.mjs";
import { adressesDuRuntime } from "/src/coquille/adresses-du-runtime.mjs";
import { TYPE_DU_BILAN } from "/src/coquille/telechargement-anticipe.mjs";
import { admissionSelonLeBudget, ouvrirLeMagasinOpfs } from "/src/vm/magasin-opfs.mjs";
import { prechargerLesArtefacts } from "/src/vm/prechargement-des-artefacts.mjs";
import { bindNavigatorStorage, createStorageBudget } from "/src/vm/storage-budget.mjs";

async function telechargerParAvance() {
  if (navigator.onLine === false) return { issue: "hors-connexion" };
  const lu = await lireLeDescripteur();
  if (!lu.present) return { issue: "sans-descripteur" };
  const runtime = await adressesDuRuntime(lu.descripteur);
  const peutAdmettre = admissionSelonLeBudget(
    createStorageBudget(bindNavigatorStorage(navigator.storage)),
  );
  return prechargerLesArtefacts({
    runtime,
    manifeste: runtime.manifesteV86,
    magasin: ouvrirLeMagasinOpfs({ peutAdmettre }),
    peutAdmettre,
  });
}

telechargerParAvance()
  .catch((erreur) => ({ issue: "echec", erreur: erreur?.name ?? "Error" }))
  .then((bilan) => {
    self.postMessage({ type: TYPE_DU_BILAN, bilan });
    // Il meurt dès son bilan posté : la mémoire de ce qu'il a téléchargé part avec lui.
    self.close();
  });
