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
import { CLE_DE_TEST } from "./cle-de-volume.mjs";
import { classerVolume } from "./crash-oracle.mjs";
import { armerInjecteur, planifierCoupures } from "./crash-plan.mjs";
import {
  VOLUME_OCTETS,
  blocsAttendus,
  ecrireEtatAncien,
  generationsAttendues,
  ecrireEtatNouveau,
  profilDuScenario,
  relireBlocs,
} from "./crash-scenario.mjs";
import { createFaultPlan } from "./fault-plan.mjs";
import { GenerationStore } from "./generation-store.mjs";
import { OpfsBlockBackend } from "./opfs-block-backend.mjs";
import { generationJournalName } from "./opfs-sync-access.mjs";
import { Scellement } from "./scellement.mjs";
import { createSyncAccessStore } from "./sync-access-double.mjs";
import {
  FORMAT_VOLUME_V3,
  MARQUEUR_SCELLEMENT_COMPLET,
  SCELLEMENT_COMPLET_OFFSET,
  dispositionV3,
  encoderEnTeteV3,
} from "./volume-chiffre-format.mjs";

/**
 * Identifiant du volume jetable. FIXE, et c'est la condition de la mesure : il entre dans les
 * données associées de chaque secteur, si bien qu'un identifiant tiré à chaque démarrage ferait
 * refuser tout ce que la session précédente a scellé — la machine mesurerait alors sa propre mise
 * en place au lieu d'une coupure.
 */
const IDENTIFIANT_JETABLE = "15c0ffee15c0ffee15c0ffee15c0ffee";

/**
 * Ouvre — ou fait naître — le volume v3 de la machine jetable, et rend son backend.
 *
 * Ce que `openOpfsVolume` fait en production est refait ici À LA MAIN, pour la raison écrite en tête
 * de ce fichier : la table d'exclusivité vaut pour un contexte, et une machine qui meurt emporte le
 * sien. Les gestes sont les mêmes — poser l'en-tête, sceller tous les secteurs —, et ils passent par
 * l'accès BRUT, donc sans consommer de faute programmée : les coupures de #15 visent les gestes du
 * GUEST, et les compter ici déplacerait les points de mesure.
 */
async function ouvrirVolumeJetable({ support, nom, taille, journal, faults }) {
  const handle = await support.openHandle(nom);
  const disposition = dispositionV3(taille);
  const neuf = handle.getSize() === 0;
  if (neuf) {
    handle.truncate(disposition.tailleSupport);
    handle.write(
      encoderEnTeteV3({ tailleLogique: taille, identifiantVolume: IDENTIFIANT_JETABLE }),
      { at: 0 },
    );
    handle.flush();
  }
  const backend = new OpfsBlockBackend({
    name: nom,
    handle,
    size: taille,
    disposition,
    scellement: await Scellement.ouvrir({
      volume: IDENTIFIANT_JETABLE,
      cleOctets: CLE_DE_TEST,
      formatVersion: FORMAT_VOLUME_V3,
    }),
    journal,
    faults,
    flushDelay: 0,
  });
  if (neuf) {
    await backend.chiffre.scellerTout(0);
    await backend.barriereSupportBrute();
    // La MARQUE de scellement complet, posée en dernier comme l'ouvreur la pose. Cette machine ne
    // la relit pas — elle rouvre son volume à la main —, mais reproduire les gestes de l'ouvreur
    // sans reproduire celui-là ferait diverger le fichier de #15 de celui du produit.
    handle.write(MARQUEUR_SCELLEMENT_COMPLET, { at: SCELLEMENT_COMPLET_OFFSET });
    handle.flush();
  }
  return backend;
}

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
    async demarrer({ faults = createFaultPlan(), muterMagasin = null } = {}) {
      if (backend !== null) {
        throw new Error("La machine tourne déjà : la faire redémarrer masquerait la coupure.");
      }
      journal = new BlockJournal();
      backend = await ouvrirVolumeJetable({ support, nom, taille, journal, faults });
      // Le journal de génération est ouvert et RÉCUPÉRÉ ici, comme le fait `openOpfsVolume` en
      // production : c'est ce geste qui rejoue la dernière génération validée ou écarte celle qui ne
      // l'est pas. Sans lui, la machine jetable éprouverait un backend qui n'est pas celui du
      // produit, et sa mesure ne dirait plus rien du produit.
      const journalGeneration = await support.openHandle(generationJournalName(nom));
      const magasin = await GenerationStore.ouvrir({
        volume: nom,
        handle: journalGeneration,
        tailleVolume: taille,
        scellement: backend.chiffre.scellement,
        lireVolume: (offset, longueur) => backend.lireSupportBrut(offset, longueur),
        ecrireVolume: (offset, octets, generation) =>
          backend.ecrireSupportBrut(offset, octets, generation),
        barriereVolume: () => backend.barriereSupportBrute(),
      });
      // `muterMagasin` n'est PAS un point d'extension du produit : c'est la porte par laquelle une
      // épreuve remplace le magasin par un MUTANT, pour vérifier que l'oracle sait le voir. Une
      // mesure qui ne rougirait sur aucun mutant ne mesurerait rien — c'est exactement ce que la
      // revue de #16 a démontré sur la cadence précédente. `openOpfsVolume` n'expose rien de tel.
      backend.installerGeneration(muterMagasin === null ? magasin : muterMagasin(magasin));
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
      // Le journal de génération meurt avec la machine, et sans fermeture : c'est précisément ce qui
      // laisse une génération non validée derrière elle. L'oublier ferait de la coupure une
      // fermeture propre déguisée, exactement comme l'oubli du volume lui-même.
      support.abandon(generationJournalName(nom));
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
export async function rejouerCoupure(point, { jeton, muterMagasin = null } = {}) {
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
  // La mutation éventuelle ne porte QUE sur la session coupée. L'appliquer à la préparation
  // fabriquerait un ancien état incomplet, et l'épreuve mesurerait sa propre mise en place ; à la
  // relecture, elle empêcherait la récupération de faire son travail.
  const coupee = await machine.demarrer({ faults: fautes, muterMagasin });
  const ecriture = await ecrireEtatNouveau(coupee);
  const journal = machine.journal.entries();
  machine.arreterBrutalement();

  const relue = await machine.demarrer();
  const relecture = await relireBlocs(relue);
  await machine.arreterProprement();

  const rapport = classerVolume({
    blocs: blocsAttendus(relecture),
    journal,
    generations: generationsAttendues(),
  });
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
 * Rejoue le scénario SANS aucune coupure : l'ancien état, puis le nouveau, jusqu'au bout.
 *
 * C'est le TÉMOIN POSITIF de la mesure. La matrice de coupures ne peut pas produire le verdict
 * `nouveau` — aucun de ses trois genres ne tombe après l'acquittement de la dernière barrière, ce
 * que `tests/unit/vm-crash-cadence.test.mjs` démontre par le calcul. Sans ce témoin, l'extrême haut
 * de la suite des générations ne serait jamais exercé, et un oracle devenu incapable de le rendre
 * passerait inaperçu.
 *
 * La machine est arrêtée BRUTALEMENT ici aussi : ce qu'on veut voir, c'est que la dernière
 * génération validée survit à la mort du détenteur, pas qu'une fermeture propre la range.
 */
export async function rejouerSansCoupure() {
  const machine = creerMachineJetable();

  const preparation = await machine.demarrer();
  const ancien = await ecrireEtatAncien(preparation);
  if (ancien.arret !== null) {
    throw new Error(`La préparation de l'ancien état a échoué (${ancien.arret.code}).`);
  }
  await machine.arreterProprement();

  const complete = await machine.demarrer();
  const ecriture = await ecrireEtatNouveau(complete);
  const journal = machine.journal.entries();
  machine.arreterBrutalement();

  const relue = await machine.demarrer();
  const relecture = await relireBlocs(relue);
  await machine.arreterProprement();

  const rapport = classerVolume({
    blocs: blocsAttendus(relecture),
    journal,
    generations: generationsAttendues(),
  });
  return Object.freeze({
    ...rapport,
    ecritures: ecriture.ecritures,
    barrieres: ecriture.barrieres,
    arret: ecriture.arret,
  });
}

/**
 * Rejoue la matrice d'une graine. Les points sont indépendants : chacun repart d'un support neuf,
 * sans quoi le verdict d'un point dépendrait de celui du précédent.
 *
 * @param {number} graine
 * @param {{ points: number, jeton?: string }} options
 */
export async function rejouerMatrice(graine, { points, jeton, muterMagasin = null } = {}) {
  const suite = planifierCoupures(graine, profilDuScenario(points));
  const resultats = [];
  for (const point of suite) {
    resultats.push(await rejouerCoupure(point, { jeton, muterMagasin }));
  }
  return resultats;
}
