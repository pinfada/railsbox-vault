// Scénarios de RÉSILIENCE du Worker runtime (#15).
//
// Ils vivent dans un module à eux, et pas au milieu de `runtime-worker.mjs`, pour deux raisons :
// ce fichier passait 500 lignes, et surtout `tests/unit/vm-crash-armement.test.mjs` peut désormais
// borner l'armement de l'injecteur par un MODULE entier plutôt que par une plage de texte entre
// deux déclarations. Le chemin de production ne change pas : le Worker runtime importe ces
// scénarios et les exécute, dans le même contexte, avec la même boucle d'ordonnancement.
//
// Aucun de ces scénarios ne construit d'émulateur : aucun artefact v86 n'est chargé, et
// `exigerContexteExecutable` n'est donc pas appelé — ce contrôle porte sur la capacité à faire
// tourner v86, qui n'est pas en jeu. Ce qui est en jeu, c'est ce qu'une coupure laisse sur un
// volume OPFS RÉEL.
//
// Ils se répartissent le travail parce que l'arrêt est RÉEL : c'est la page qui appelle
// `Worker.terminate()`, et un Worker terminé ne rend plus de compte rendu. Le Worker qui coupe rend
// donc son journal AVANT de mourir ; un autre relit ensuite le volume et classe.

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { classerVolume } from "/src/vm/crash-oracle.mjs";
import { armerInjecteur } from "/src/vm/crash-plan.mjs";
import {
  VOLUME_OCTETS,
  blocsAttendus,
  ecrireEtatAncien,
  ecrireEtatNouveau,
  generationsAttendues,
  relireBlocs,
} from "/src/vm/crash-scenario.mjs";
import { createFaultPlan } from "/src/vm/fault-plan.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "/src/vm/storage-errors.mjs";

/**
 * Nom du volume de résilience. Il est FIGÉ, et l'appelant ne le choisit pas.
 *
 * `runResiliencePreparer` commence par EFFACER ce volume. Laisser l'appelant le nommer donnerait à
 * n'importe quel message `postMessage` du contexte le pouvoir de détruire un volume de production —
 * un volume applicatif, un manifeste, une sauvegarde — sans même présenter le jeton du harnais, la
 * suppression étant en amont de tout armement. Les scénarios `opfs-persistence` et `opfs-barrier`
 * du Worker runtime portent la même porte, plus ancienne et plus étroite ; elle est inscrite comme
 * dette dans `SECURITY.md`. Cette tranche-ci ne l'élargit pas.
 */
export const VOLUME_RESILIENCE = "resilience";

const attendre = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Rouvre un volume dont le détenteur précédent est mort sans fermer son handle. Le moteur reprend
 * l'exclusivité quand le Worker disparaît, mais pas forcément AVANT que la page ait démarré le
 * suivant : l'attente est bornée et son coût est PUBLIÉ, jamais masqué par une réussite tardive.
 */
async function rouvrirApresCoupure({ tentatives, attenteMs, journal }) {
  for (let essai = 1; essai <= tentatives; essai += 1) {
    try {
      const backend = await openOpfsVolume({
        name: VOLUME_RESILIENCE,
        journal,
        faults: createFaultPlan(),
      });
      return { backend, essais: essai };
    } catch (erreur) {
      if (!isStorageError(erreur, STORAGE_ERROR_CODES.busy) || essai === tentatives) throw erreur;
      await attendre(attenteMs);
    }
  }
  throw new Error("Inatteignable : la boucle rend ou relance toujours.");
}

/** Prépare l'ANCIEN état du volume, puis referme proprement. Le point de coupure part de là. */
export async function runResiliencePreparer() {
  // `removeOpfsVolume` emporte le journal de génération voisin — c'est une propriété de la primitive
  // elle-même (#16, ADR 0014), pas un geste à répéter ici. Elle compte pour cette matrice : sans
  // elle, la génération laissée par le point précédent serait rejouée sur le volume neuf, et le
  // verdict d'un point dépendrait de son prédécesseur. Ce que ce banc ÉPROUVE, lui, c'est la
  // conséquence : « la même graine rejoue la même matrice », deux fois de suite, dans la spec.
  await removeOpfsVolume(VOLUME_RESILIENCE);
  const journal = new BlockJournal();
  const backend = await openOpfsVolume({
    name: VOLUME_RESILIENCE,
    size: VOLUME_OCTETS,
    journal,
    faults: createFaultPlan(),
  });
  let ancien;
  try {
    ancien = await ecrireEtatAncien(backend);
  } finally {
    await backend.close();
  }
  if (ancien.arret !== null) {
    throw new Error(
      `La préparation de l'ancien état a échoué (${ancien.arret.code}) : la coupure ne mesurerait pas ce qu'elle prétend.`,
    );
  }
  return {
    scenario: "resilience-preparer",
    volume: VOLUME_RESILIENCE,
    ...ancien,
    counts: journal.counts(),
  };
}

/**
 * Écrit le NOUVEL état sous injecteur armé, puis rend la main SANS fermer le volume et SANS
 * franchir de barrière. Le handle exclusif reste ouvert : la page tue ce Worker juste après avoir
 * reçu ce compte rendu, et c'est ce `terminate()` qui est l'arrêt réel.
 */
export async function runResilienceCouper({ point, jeton }) {
  const journal = new BlockJournal();
  const fautes = armerInjecteur(point, { jeton });
  const backend = await openOpfsVolume({
    name: VOLUME_RESILIENCE,
    journal,
    faults: fautes,
  });
  const ecriture = await ecrireEtatNouveau(backend);
  return {
    scenario: "resilience-couper",
    volume: VOLUME_RESILIENCE,
    point,
    ...ecriture,
    // Le journal traverse le port AVANT la mort du Worker : l'oracle en a besoin pour savoir
    // quelles écritures ont été acquittées et lesquelles une barrière a franchies.
    journal: journal.entries().map((entree) => ({ ...entree })),
    fautesTirees: fautes.fired().map((faute) => ({ ...faute })),
    fautesNonTirees: fautes.unfired().map((faute) => ({ ...faute })),
  };
}

/**
 * Rouvre le volume après la coupure, relit les blocs suivis et les classe.
 *
 * `journal` n'a PAS de valeur par défaut : un appel qui l'oublierait doit échouer bruyamment plutôt
 * que de classer sans lui. Sans journal, la règle `SEC-DURABLE-001` de l'oracle est inerte et le
 * taux atomique monte — une amélioration apparente qui serait une perte de mesure.
 */
export async function runResilienceClasser({ journal, tentatives = 60, attenteMs = 50 }) {
  if (!Array.isArray(journal)) {
    throw new Error(
      "Le classement exige le journal de la session coupée. Le Worker qui coupe le publie avant de mourir ; le perdre en route désactiverait la règle SEC-DURABLE-001 en silence.",
    );
  }
  const relecture = new BlockJournal();
  const { backend, essais } = await rouvrirApresCoupure({
    tentatives,
    attenteMs,
    journal: relecture,
  });
  let blocs;
  // Ce que la RÉCUPÉRATION a trouvé et fait, lu AVANT la relecture : c'est la seule occasion de le
  // dire. Une génération écartée en silence serait exactement le succès muet que le dépôt refuse.
  const recuperation = backend.generation?.rapport ?? null;
  try {
    blocs = await relireBlocs(backend);
  } finally {
    await backend.close();
  }
  const rapport = classerVolume({
    blocs: blocsAttendus(blocs),
    journal,
    generations: generationsAttendues(),
  });
  return {
    scenario: "resilience-classer",
    volume: VOLUME_RESILIENCE,
    reouverture: { essais, attenteMs },
    recuperation,
    verdict: rapport.verdict,
    raison: rapport.raison,
    atomique: rapport.atomique,
    journalConsulte: rapport.journalConsulte,
    entreesJournal: rapport.entreesJournal,
    classes: rapport.classes,
    blocs: rapport.blocs.map((bloc) => ({ ...bloc })),
  };
}

/** Les trois scénarios, sous les noms que la page emploie. */
export const RESILIENCE_SCENARIOS = new Map([
  ["resilience-preparer", runResiliencePreparer],
  ["resilience-couper", runResilienceCouper],
  ["resilience-classer", runResilienceClasser],
]);
