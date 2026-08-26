// Machine jetable du chemin UNITAIRE de #15 : elle démarre, écrit, meurt, redémarre.
//
// Elle exécute le VRAI backend de production (`OpfsBlockBackend`) au-dessus du double calibré de
// `sync-access-double.mjs`. Deux points méritent d'être dits plutôt que devinés :
//
//  - elle construit le backend directement, sans passer par `openOpfsVolume`. Ce n'est pas un
//    raccourci : la table d'exclusivité de ce module vaut pour UN contexte, et une machine qui meurt
//    emporte son contexte. Passer par la porte laisserait le nom occupé par un volume dont le
//    détenteur n'existe plus, et le redémarrage échouerait sur `VAULT_STORAGE_BUSY` pour une raison
//    qui n'a rien à voir avec la coupure ;
//  - un arrêt brutal n'appelle NI `close()` NI `flush()`. La fermeture d'un
//    `FileSystemSyncAccessHandle` matérialise les écritures en attente : l'appeler ferait de la
//    coupure une fermeture propre déguisée.
//
// Ce que ce chemin ne mesure PAS : la perte d'une écriture non barriérée. Le double matérialise
// chaque octet accepté, donc une coupure « entre écriture et barrière » y rend le nouvel état. Le
// support réel est le seul juge de cette question, et c'est `tests/vm/resilience-arrets.spec.mjs`
// qui l'interroge.

import { BlockJournal } from "./block-journal.mjs";
import { classerVolume } from "./crash-oracle.mjs";
import { armerInjecteur, planifierCoupures } from "./crash-plan.mjs";
import {
  VOLUME_OCTETS,
  blocsAttendus,
  ecrireEtatAncien,
  ecrireEtatNouveau,
  profilDuScenario,
  relireBlocs,
} from "./crash-scenario.mjs";
import { createFaultPlan } from "./fault-plan.mjs";
import { OpfsBlockBackend } from "./opfs-block-backend.mjs";
import { createSyncAccessStore } from "./sync-access-double.mjs";

/**
 * Crée une machine jetable et son support. Le support survit aux morts de la machine : c'est ce
 * qui permet de relire après coupure.
 *
 * @param {{ nom?: string, taille?: number }} [options]
 */
export function creerMachineJetable({ nom = "resilience", taille = VOLUME_OCTETS } = {}) {
  const support = createSyncAccessStore();
  let backend = null;
  let journal = null;

  return {
    /** Démarre la machine et ouvre le volume. Le plan de fautes est celui du point rejoué. */
    async demarrer({ faults = createFaultPlan() } = {}) {
      if (backend !== null) {
        throw new Error("La machine tourne déjà : la faire redémarrer masquerait la coupure.");
      }
      const handle = await support.openHandle(nom);
      if (handle.getSize() === 0) handle.truncate(taille);
      journal = new BlockJournal();
      backend = new OpfsBlockBackend({
        name: nom,
        handle,
        size: taille,
        journal,
        faults,
        flushDelay: 0,
      });
      return backend;
    },

    /** Journal de la session en cours. À lire AVANT l'arrêt : une machine morte n'en rend plus. */
    get journal() {
      return journal;
    },

    /** Arrêt propre : la barrière du support est franchie par la fermeture du handle. */
    async arreterProprement() {
      await backend.close();
      backend = null;
    },

    /** Arrêt brutal : ni fermeture, ni barrière. L'exclusivité est reprise, comme après une mort. */
    arreterBrutalement() {
      support.abandon(nom);
      backend = null;
    },

    /** Copie du fichier, hors backend. Utile pour un diagnostic, jamais pour un verdict. */
    instantane: () => support.snapshot(nom),
  };
}

/**
 * Rejoue UN point de coupure de bout en bout : ancien état, coupure pendant l'écriture du nouvel
 * état, mort de la machine, réouverture, classement.
 *
 * @param {import("./crash-plan.mjs").CrashPoint} point
 * @param {{ jeton?: string }} [options]
 */
export async function rejouerCoupure(point, { jeton } = {}) {
  const machine = creerMachineJetable();

  const preparation = await machine.demarrer();
  const ancien = await ecrireEtatAncien(preparation);
  if (ancien.arret !== null) {
    throw new Error(
      `La préparation de l'ancien état a échoué (${ancien.arret.code}) : le point ${point.index} ne mesurerait pas ce qu'il prétend.`,
    );
  }
  await machine.arreterProprement();

  const fautes = armerInjecteur(point, { jeton });
  const coupee = await machine.demarrer({ faults: fautes });
  const ecriture = await ecrireEtatNouveau(coupee);
  const journal = machine.journal.entries();
  machine.arreterBrutalement();

  const relue = await machine.demarrer();
  const relecture = await relireBlocs(relue);
  await machine.arreterProprement();

  const rapport = classerVolume({ blocs: blocsAttendus(relecture), journal });
  return Object.freeze({
    point,
    ...rapport,
    ecritures: ecriture.ecritures,
    barrieres: ecriture.barrieres,
    arret: ecriture.arret,
    fautesTirees: fautes.fired(),
    fautesNonTirees: fautes.unfired(),
    // Les octets RÉELLEMENT relus, pour qu'un appelant puisse rejuger le même support avec un autre
    // journal. C'est ce qui permet au témoin négatif de #15 d'exercer la règle `SEC-DURABLE-001`
    // sur une relecture réelle plutôt que sur des octets fabriqués.
    relecture: Object.freeze(relecture),
  });
}

/**
 * Rejoue la matrice d'une graine. Les points sont indépendants : chacun repart d'un support neuf,
 * sans quoi le verdict d'un point dépendrait de celui du précédent.
 *
 * @param {number} graine
 * @param {{ points: number, jeton?: string }} options
 */
export async function rejouerMatrice(graine, { points, jeton } = {}) {
  const suite = planifierCoupures(graine, profilDuScenario(points));
  const resultats = [];
  for (const point of suite) {
    resultats.push(await rejouerCoupure(point, { jeton }));
  }
  return resultats;
}
