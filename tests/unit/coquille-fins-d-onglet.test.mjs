/**
 * LES FINS D'ONGLET : ce que la coquille fait de chacune (#170, tranche 2 de #25, ADR 0032).
 *
 * Les gardes sont PURES ou à dépendances INJECTÉES — document, fenêtre, surveillance, terminaison du
 * Worker, rechargement, journal —, et c'est la condition pour qu'une campagne de mutation puisse les
 * atteindre. Le motif est celui de `tools/muter-gardes-coquille.mjs` : « une garde écrite dans
 * `public/main.mjs` ne serait éprouvable que par un navigateur, donc jamais par un enfant borné ».
 *
 * ## Ce que ce fichier éprouve, que le NAVIGATEUR ne peut pas éprouver ici
 *
 * La liste a RÉTRÉCI depuis la revue de sécurité de la PR #177, et c'est une bonne nouvelle : le
 * harnais ne restaurait aucun document parce qu'il tournait sans fenêtre et que sa propre sonde
 * ouvrait un `BroadcastChannel` — bloqueur du bfcache. En Chromium FENÊTRÉ, `pageshow` restauré et
 * le rechargement qui suit sont MESURÉS (`tests/fins-d-onglet/`, projet `chromium-fenetre`).
 *
 * Restent hors de portée de tout navigateur de ce dépôt : le GEL et l'onglet CACHÉ. `freeze`,
 * `resume` et le retour à la visibilité ne tiennent donc que par les épreuves d'ici — événement et
 * horloge injectés — et par les mutants. Les écrire comme des épreuves de navigateur les aurait
 * rendues vertes par vacuité, ce que le dépôt refuse depuis #163.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ACTIONS_DE_FIN,
  EVENEMENTS_DE_FIN,
  EVENEMENTS_JAMAIS_BRANCHES,
  brancherLesFinsDOnglet,
  workerAtteignable,
} from "../../src/coquille/fins-d-onglet.mjs";
import { DECLENCHEURS, surveillanceDInactivite } from "../../src/coquille/verrouillage.mjs";
import { brancherLesGestesDuCycle } from "../../src/coquille/gestes-du-cycle.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Un DOCUMENT et une FENÊTRE feints, qui relèvent ce qu'on leur inscrit et savent le déclencher.
 *
 * Les deux existent séparément parce que la CIBLE fait partie de la décision : `pagehide` et
 * `pageshow` sont des événements de FENÊTRE, `freeze`, `resume` et `visibilitychange` des
 * événements de DOCUMENT. Un écouteur posé sur la mauvaise cible ne se déclenche jamais, et la
 * sonde de navigateur a payé cette leçon avant que ces épreuves existent.
 */
function contexteFeint({ visibilite = "visible" } = {}) {
  const inscrits = [];
  const cible = (nom) => ({
    addEventListener(evenement, geste, options) {
      inscrits.push({ cible: nom, nom: evenement, geste, options });
    },
  });
  const racine = { ...cible("document"), visibilityState: visibilite };
  const fenetre = cible("fenetre");
  return {
    inscrits,
    racine,
    fenetre,
    /** Déclenche tous les écouteurs inscrits sous ce nom, avec l'événement donné. */
    declencher(nom, evenement = {}) {
      for (const inscrit of inscrits.filter((autre) => autre.nom === nom)) inscrit.geste(evenement);
    },
    /** Les noms d'événements réellement inscrits, sans doublon, triés. */
    noms() {
      return [...new Set(inscrits.map(({ nom }) => nom))].sort();
    },
  };
}

/** Une HORLOGE et un ORDONNANCEUR feints, pilotés à la milliseconde. Ceux de #169, en plus court. */
function tempsFeint() {
  let instant = 0;
  let suivant = 1;
  const minuteries = new Map();
  return {
    maintenant: () => instant,
    planifier: (geste, delai) => {
      const identifiant = suivant;
      suivant += 1;
      minuteries.set(identifiant, { geste, echeance: instant + delai });
      return identifiant;
    },
    annuler: (identifiant) => minuteries.delete(identifiant),
    /** Avance l'horloge SANS réveiller personne : c'est le cas d'un onglet gelé ou caché. */
    avancerSansReveil(millisecondes) {
      instant += millisecondes;
    },
    get armees() {
      return minuteries.size;
    },
  };
}

/** Le montage complet : une surveillance sous horloge feinte, et la coquille feinte autour. */
function montage({
  etat = ETATS_DU_VOLUME.ouvert,
  visibilite = "visible",
  delaiMs = 60_000,
  worker = { nom: "worker-de-confiance-feint" },
  mortDuWorker = null,
} = {}) {
  const temps = tempsFeint();
  const verrouillages = [];
  const surveillance = surveillanceDInactivite({
    delaiMs,
    maintenant: temps.maintenant,
    planifier: temps.planifier,
    annuler: temps.annuler,
    verrouiller: () => verrouillages.push(DECLENCHEURS.inactivite),
  });
  const contexte = contexteFeint({ visibilite });
  const terminaisons = [];
  const rechargements = [];
  const journal = [];
  let etatCourant = etat;
  let workerCourant = worker;
  let mortCourante = mortDuWorker;
  brancherLesFinsDOnglet({
    racine: contexte.racine,
    fenetre: contexte.fenetre,
    surveillance,
    // Le CONSTAT porte l'état publié, que la garde refuse d'employer : c'est ce refus-là qui se mute
    // (constat 1 de la revue de sécurité de la PR #177).
    constatDuWorker: () => ({
      worker: workerCourant,
      mortDuWorker: mortCourante,
      etatPublie: etatCourant,
    }),
    tuerLeWorker: () => terminaisons.push(temps.maintenant()),
    recharger: () => rechargements.push(temps.maintenant()),
    journal: (evenement, action) => journal.push(`${evenement}:${action}`),
  });
  surveillance.armer(etat);
  return {
    temps,
    surveillance,
    contexte,
    terminaisons,
    rechargements,
    journal,
    verrouillages,
    poserLEtat(valeur) {
      etatCourant = valeur;
    },
    poserLaMort(valeur) {
      mortCourante = valeur;
    },
    poserLeWorker(valeur) {
      workerCourant = valeur;
    },
  };
}

// --- La TABLE : un événement, une action, et rien d'implicite --------------------------------------

test("la table nomme une action pour CHAQUE événement de fin, et pas une de plus", () => {
  assert.deepEqual(Object.keys(EVENEMENTS_DE_FIN).sort(), [
    "freeze",
    "pagehide",
    "pageshow",
    "resume",
    "visibilitychange",
  ]);
  // Chaque action est une valeur de la table close : un nom hors table ferait décider le
  // branchement par une chaîne que personne n'a écrite.
  const connues = new Set(Object.values(ACTIONS_DE_FIN));
  for (const [evenement, action] of Object.entries(EVENEMENTS_DE_FIN)) {
    assert.ok(connues.has(action.action), `${evenement} porte une action hors table : ${action}`);
  }
});

test("`beforeunload` et `unload` sont NOMMÉS comme jamais branchés, et non pas simplement absents", () => {
  // Une liste d'exclusion vide est indiscernable d'une liste d'exclusion oubliée. C'est le motif de
  // `SIGNAUX_SANS_EFFET` (#169), repris ici pour les deux événements que la coquille refuse.
  assert.deepEqual([...EVENEMENTS_JAMAIS_BRANCHES].sort(), ["beforeunload", "unload"]);
  for (const interdit of EVENEMENTS_JAMAIS_BRANCHES) {
    assert.equal(
      Object.hasOwn(EVENEMENTS_DE_FIN, interdit),
      false,
      `${interdit} est entré dans la table des événements branchés`,
    );
  }
});

test("la coquille écoute les cinq événements de la table, sur la CIBLE de chacun", () => {
  const { contexte } = montage();
  assert.deepEqual(contexte.noms(), [
    "freeze",
    "pagehide",
    "pageshow",
    "resume",
    "visibilitychange",
  ]);
  // `pagehide` et `pageshow` sont des événements de FENÊTRE ; `freeze`, `resume` et
  // `visibilitychange` des événements de DOCUMENT. Un écouteur posé sur la mauvaise cible ne se
  // déclenche jamais — et rien, dans un navigateur, ne le dirait.
  const cibleDe = (nom) => contexte.inscrits.find((inscrit) => inscrit.nom === nom).cible;
  assert.equal(cibleDe("pagehide"), "fenetre");
  assert.equal(cibleDe("pageshow"), "fenetre");
  assert.equal(cibleDe("freeze"), "document");
  assert.equal(cibleDe("resume"), "document");
  assert.equal(cibleDe("visibilitychange"), "document");
});

test("aucun écouteur de `beforeunload` ni de `unload` n'est inscrit par le branchement", () => {
  const { contexte } = montage();
  for (const interdit of EVENEMENTS_JAMAIS_BRANCHES) {
    assert.equal(
      contexte.noms().includes(interdit),
      false,
      `${interdit} est écouté, et il ne devrait jamais l'être`,
    );
  }
});

// --- `pagehide` : il TUE, tout de suite, quel que soit `persisted` ---------------------------------

test("`pagehide` sur un coffre OUVERT termine le Worker, une seule fois, et désarme le délai", () => {
  const montee = montage();
  assert.equal(montee.surveillance.armee(), true);
  montee.contexte.declencher("pagehide", { persisted: false });
  assert.equal(montee.terminaisons.length, 1);
  assert.equal(
    montee.surveillance.armee(),
    false,
    "le délai continue de courir sur un coffre mort",
  );
  assert.equal(montee.temps.armees, 0, "une minuterie survit au départ du document");
  // RIEN d'autre : ni rechargement, ni verrouillage. Aucune tâche asynchrone n'est garantie dans
  // `pagehide`, et « tenter » une fermeture propre qui n'aboutira pas serait moins honnête que de
  // ne rien tenter.
  assert.deepEqual(montee.rechargements, []);
  assert.deepEqual(montee.verrouillages, []);
});

test("`pagehide` tue AUSSI quand `persisted` est vrai : un seul chemin, pas deux", () => {
  // C'est la SEULE chose qui empêche un retour arrière depuis le bfcache de rendre un coffre ouvert
  // sans geste. La coquille ne dépend pas de savoir si le document sera détruit ou mis en cache :
  // s'il est détruit, le Worker mourait de toute façon et l'avance ne coûte rien.
  const montee = montage();
  montee.contexte.declencher("pagehide", { persisted: true });
  assert.equal(montee.terminaisons.length, 1);
  assert.equal(montee.surveillance.armee(), false);
});

test("`pagehide` tue MÊME quand l'état publié n'est pas `ouvert` : le Worker peut tenir une clé", () => {
  // C'EST LE CONSTAT 1 de la revue de sécurité de la PR #177, et l'épreuve qui vivait ici affirmait
  // le contraire : « un coffre verrouillé n'a aucune clé dans le tas d'un Worker ». C'est FAUX
  // pendant tout le déverrouillage. Le Worker reçoit la KEK au message `deverrouiller` ; l'état ne
  // devient `ouvert` qu'après l'ouverture du volume, une écriture acquittée et un aller-retour
  // d'inventaire de plus. Un `pagehide` déposé dans cette fenêtre — reproduit en A/B sur Chromium —
  // laissait vivre un Worker qui tenait déjà la KEK et la DEK, et le coffre finissait de s'ouvrir
  // après le départ du document.
  for (const etat of [
    ETATS_DU_VOLUME.verrouille,
    ETATS_DU_VOLUME.demarrage,
    ETATS_DU_VOLUME.indisponible,
  ]) {
    const montee = montage({ etat });
    montee.contexte.declencher("pagehide", { persisted: false });
    assert.equal(montee.terminaisons.length, 1, `l'état ${etat} a empêché la terminaison`);
  }
});

test("`pagehide` ne tue rien quand le Worker est DÉJÀ mort, ou n'existe pas", () => {
  // La garde ne retient qu'une chose : un Worker inatteignable. Le terminer une seconde fois ne
  // ferait rien de plus, et publier une mort là où elle est déjà constatée mentirait sur l'ordre.
  const mort = montage({ mortDuWorker: { cause: "terminaison" } });
  mort.contexte.declencher("pagehide", { persisted: false });
  assert.deepEqual(mort.terminaisons, []);

  const absent = montage({ worker: null });
  absent.contexte.declencher("pagehide", { persisted: false });
  assert.deepEqual(absent.terminaisons, []);
});

test("la GARDE de `pagehide` reçoit l'état publié, et le REFUSE", () => {
  // La forme de `SIGNAUX_SANS_EFFET` (#169) : le fait est PRÉSENTÉ à la garde plutôt qu'omis, si
  // bien qu'un mutant qui s'en servirait rougit — là où une absence d'appel ne pourrait rien rougir.
  assert.equal(
    workerAtteignable({ worker: {}, mortDuWorker: null, etatPublie: "verrouille" }),
    true,
  );
  assert.equal(workerAtteignable({ worker: {}, mortDuWorker: null, etatPublie: "ouvert" }), true);
  assert.equal(workerAtteignable({ worker: {}, mortDuWorker: { cause: "erreur" } }), false);
  assert.equal(workerAtteignable({ worker: null, mortDuWorker: null }), false);
  assert.equal(workerAtteignable({ mortDuWorker: null }), false);
});

test("`pagehide` ne RÉARME jamais le délai : il n'y a plus rien à verrouiller", () => {
  const montee = montage();
  montee.contexte.declencher("pagehide", { persisted: false });
  montee.poserLEtat(ETATS_DU_VOLUME.verrouille);
  assert.equal(montee.surveillance.armee(), false);
  assert.equal(montee.temps.armees, 0);
});

// --- `pageshow` : il RECHARGE, et seulement s'il est RESTAURÉ --------------------------------------

test("`pageshow` RESTAURÉ recharge la coquille, par le chemin du verrouillage réussi", () => {
  // Un document restauré revient avec tout son DOM — cadre applicatif compris, dont les pixels sont
  // le dernier clair — et un Worker que `pagehide` a tué. L'état vrai est `verrouille`, et le seul
  // document propre est un document neuf.
  const montee = montage();
  montee.contexte.declencher("pageshow", { persisted: true });
  assert.equal(montee.rechargements.length, 1);
});

test("`pageshow` NON restauré ne recharge JAMAIS : ce serait une boucle infinie", () => {
  // C'est le mutant le plus coûteux de la campagne : un rechargement sur tout `pageshow` produirait
  // un document qui se recharge à chaque chargement, indéfiniment, et aucune épreuve de navigateur
  // ne pourrait plus rien mesurer.
  const montee = montage();
  montee.contexte.declencher("pageshow", { persisted: false });
  montee.contexte.declencher("pageshow", {});
  assert.deepEqual(montee.rechargements, []);
});

// --- Le GEL : rien n'est tué, et c'est une décision ------------------------------------------------

test("`freeze` ne tue RIEN et ne verrouille rien : il est seulement inscrit au journal", () => {
  // Un document gelé n'exécute rien, son Worker non plus ; les clés n'y sont ni plus ni moins
  // atteignables (mémoire du processus : hors modèle de menace, ADR 0021 déc. 7). Tuer au gel
  // ferait payer un boot à froid à chaque retour d'un onglet que le navigateur gèle de lui-même.
  const montee = montage();
  montee.contexte.declencher("freeze", {});
  assert.deepEqual(montee.terminaisons, []);
  assert.deepEqual(montee.verrouillages, []);
  assert.deepEqual(montee.rechargements, []);
  assert.equal(montee.surveillance.armee(), true, "le gel a désarmé le délai");
  assert.ok(
    montee.journal.some((ligne) => ligne.startsWith("freeze:")),
    "le gel n'est pas inscrit au journal : rien ne dirait que la coquille l'a vu",
  );
});

// --- Le RETOUR : l'échéance est VÉRIFIÉE, jamais remise à zéro -------------------------------------

test("au `resume`, une échéance DÉPASSÉE verrouille immédiatement, sous `inactivite`", () => {
  // La minuterie d'un onglet gelé ne court pas. Attendre son réveil laisserait le coffre ouvert
  // au-delà de son délai, sans que rien ne le décide — le verdict vient de l'HORLOGE (ADR 0031
  // décision 2), et le retour est le premier instant où on peut la relire.
  const montee = montage({ delaiMs: 60_000 });
  montee.temps.avancerSansReveil(60_001);
  montee.contexte.declencher("resume", {});
  assert.deepEqual(montee.verrouillages, [DECLENCHEURS.inactivite]);
  assert.equal(montee.surveillance.armee(), false);
});

test("au `resume`, une échéance NON dépassée ne verrouille rien et ne déplace pas l'échéance", () => {
  // Le TÉMOIN de la décision : c'est une VÉRIFICATION, jamais une remise à zéro. Si l'échéance
  // bougeait, un onglet qui va et vient repousserait le verrouillage indéfiniment.
  const montee = montage({ delaiMs: 60_000 });
  const echeance = montee.surveillance.echeanceMs();
  montee.temps.avancerSansReveil(59_000);
  montee.contexte.declencher("resume", {});
  assert.deepEqual(montee.verrouillages, []);
  assert.equal(montee.surveillance.armee(), true);
  assert.equal(montee.surveillance.echeanceMs(), echeance, "l'échéance a été repoussée");
});

test("un retour à la VISIBILITÉ vérifie l'échéance ; un passage en arrière-plan ne vérifie rien", () => {
  const visible = montage({ delaiMs: 60_000, visibilite: "visible" });
  visible.temps.avancerSansReveil(60_001);
  visible.contexte.declencher("visibilitychange", {});
  assert.deepEqual(visible.verrouillages, [DECLENCHEURS.inactivite]);

  // L'onglet qui PART en arrière-plan ne vérifie rien : il n'y a rien à rattraper, et le temps
  // continue de courir de toute façon (`visibilite` reste dans `SIGNAUX_SANS_EFFET`).
  const cache = montage({ delaiMs: 60_000, visibilite: "hidden" });
  cache.temps.avancerSansReveil(60_001);
  cache.contexte.declencher("visibilitychange", {});
  assert.deepEqual(cache.verrouillages, []);
  assert.equal(cache.surveillance.armee(), true);
});

test("la vérification ne fait rien sur une surveillance DÉSARMÉE : il n'y a pas d'échéance", () => {
  const montee = montage({ etat: ETATS_DU_VOLUME.verrouille });
  assert.equal(montee.surveillance.armee(), false);
  montee.temps.avancerSansReveil(600_000);
  montee.contexte.declencher("resume", {});
  montee.contexte.declencher("visibilitychange", {});
  assert.deepEqual(montee.verrouillages, []);
});

test("la vérification est le SEUL chemin neuf : `visibilite` reste un signal SANS EFFET", () => {
  // La décision 2 de l'ADR 0031 est intacte, et c'est ce qui le prouve : présenter la visibilité à
  // la surveillance ne repousse toujours rien.
  const montee = montage({ delaiMs: 60_000 });
  const echeance = montee.surveillance.echeanceMs();
  montee.temps.avancerSansReveil(1_000);
  assert.equal(montee.surveillance.signaler("visibilite"), false);
  assert.equal(montee.surveillance.echeanceMs(), echeance);
});

// --- L'ÉCHÉANCE DUE : un verrouillage par DÉLAI refusé pendant un boot n'est pas perdu -------------
//
// C'est le constat 3 de la revue de sécurité de la PR #177, et il demandait de composer DEUX modules
// que les épreuves regardaient jusqu'ici séparément : la surveillance désarme puis appelle le
// verrouillage ; la garde d'ordre de `gestes-du-cycle.mjs` refuse d'entrée pendant un boot ; la
// conduite du refus ré-arme — et ré-armer reposait `dernierSigneMs`. Chaque `resume` ou retour
// visible repoussait donc le délai de dix minutes pendant les deux minutes d'un boot, indéfiniment.
//
// Ces épreuves-ci montent le montage de `public/main.mjs` avec l'horloge injectée : c'est le seul
// endroit du dépôt où les deux modules se rencontrent sous un enfant borné.

/**
 * La coquille FEINTE : une surveillance réelle, les gestes réels du cycle, et un boot qu'on libère
 * à la main. Rien de la page — le document se réduit à ce que le branchement interroge.
 */
function coquilleFeinte({ delaiMs = 60_000, bootQuiEchoue = false } = {}) {
  const temps = tempsFeint();
  const journal = [];
  let verrouillerLeCoffre = null;
  const surveillance = surveillanceDInactivite({
    delaiMs,
    maintenant: temps.maintenant,
    planifier: temps.planifier,
    annuler: temps.annuler,
    verrouiller: () => void verrouillerLeCoffre?.(DECLENCHEURS.inactivite),
  });
  let libererLeBoot = () => {};
  const bootEnVol = new Promise((rendre) => {
    libererLeBoot = rendre;
  });
  const liaison = {
    racine: { querySelector: () => null },
    demander: async (type) => {
      if (type === "application") {
        await bootEnVol;
        if (bootQuiEchoue) throw Object.assign(new Error("boot refusé"), { code: "VAULT_X" });
        return { demarree: true, etat: ETATS_DU_VOLUME.ouvert, barrieres: 0 };
      }
      journal.push(`demande:${type}`);
      return { etat: ETATS_DU_VOLUME.verrouille, barrieres: 0, capture: { retenue: true } };
    },
    cycle: { issueDe: () => null, conclure: () => {}, releve: () => [] },
    rapport: {},
    publier: () => {},
    avantVerrouillage: () => {},
    // La conduite de `public/main.mjs`, recopiée à l'identique : c'est elle qui est éprouvée.
    apresRefusDOrdre: (code, declencheur) => {
      journal.push(`refus-d-ordre:${code}:${declencheur}`);
      if (declencheur === DECLENCHEURS.inactivite) surveillance.noterUnVerrouillageDu();
      surveillance.armer(ETATS_DU_VOLUME.ouvert);
    },
    apresRefusDeVerrouillage: (code, declencheur) => journal.push(`refus:${code}:${declencheur}`),
    apresVerrouillage: (declencheur) => journal.push(`verrouille:${declencheur}`),
    apresDemarrage: () => {
      surveillance.armer(ETATS_DU_VOLUME.ouvert);
      surveillance.jouerLeVerrouillageDu();
    },
  };
  const gestes = brancherLesGestesDuCycle(liaison);
  verrouillerLeCoffre = gestes.verrouillerLeCoffre;
  surveillance.armer(ETATS_DU_VOLUME.ouvert);
  return { temps, surveillance, gestes, journal, libererLeBoot };
}

test("une échéance dépassée PENDANT un boot ne pose AUCUN délai neuf : elle reste DUE", async () => {
  const coquille = coquilleFeinte({ delaiMs: 60_000 });
  const echeance = coquille.surveillance.echeanceMs();
  // Le boot n'est PAS attendu ici : c'est son vol qui est le sujet, et il reste en l'air jusqu'à la
  // fin de l'épreuve. Il est libéré par le `finally` de `demarrer` quand le processus se termine.
  void coquille.gestes.demarrerLApplication();
  await Promise.resolve();

  // L'onglet revient après l'échéance : la vérification verrouille, et l'ordre refuse.
  coquille.temps.avancerSansReveil(60_001);
  assert.equal(coquille.surveillance.verifierLEcheance(), true);
  await Promise.resolve();
  assert.ok(
    coquille.journal.includes(
      `refus-d-ordre:${CODES_REFUS_COQUILLE.etapeHorsOrdre}:${DECLENCHEURS.inactivite}`,
    ),
    "le refus d'ordre n'a pas porté le déclencheur",
  );

  // LE DÉFAUT QUE CETTE ÉPREUVE FERME : l'échéance valait `refus + delai`, c'est-à-dire dix minutes
  // de plus offertes par le refus lui-même, à chaque retour d'onglet.
  assert.equal(coquille.surveillance.armee(), false, "une minuterie neuve a été posée");
  assert.equal(coquille.surveillance.echeanceMs(), null, "une échéance neuve a été posée");
  assert.equal(coquille.surveillance.verrouillageDu(), true, "le verrouillage n'est pas noté DÛ");
  assert.ok(echeance !== null);
});

test("le verrouillage DÛ est joué à la CONCLUSION du boot, sous `inactivite`", async () => {
  const coquille = coquilleFeinte({ delaiMs: 60_000 });
  const boot = coquille.gestes.demarrerLApplication();
  await Promise.resolve();
  coquille.temps.avancerSansReveil(60_001);
  coquille.surveillance.verifierLEcheance();
  await Promise.resolve();

  coquille.libererLeBoot();
  await boot;
  await new Promise((rendre) => setTimeout(rendre, 0));

  assert.ok(
    coquille.journal.includes(`verrouille:${DECLENCHEURS.inactivite}`),
    "le verrouillage dû n'a pas été joué à la conclusion du boot",
  );
  assert.equal(coquille.surveillance.verrouillageDu(), false, "le dû n'est pas retombé");
});

test("un boot qui ÉCHOUE joue quand même le verrouillage DÛ : le rappel est dans le `finally`", async () => {
  // Un dû qui ne se jouerait qu'au succès laisserait un coffre ouvert sans délai après un boot
  // refusé — exactement l'état que le verrouillage existe pour quitter.
  const coquille = coquilleFeinte({ delaiMs: 60_000, bootQuiEchoue: true });
  const boot = coquille.gestes.demarrerLApplication();
  await Promise.resolve();
  coquille.temps.avancerSansReveil(60_001);
  coquille.surveillance.verifierLEcheance();
  await Promise.resolve();

  coquille.libererLeBoot();
  await boot;
  await new Promise((rendre) => setTimeout(rendre, 0));

  assert.ok(coquille.journal.includes(`verrouille:${DECLENCHEURS.inactivite}`));
});

test("le GESTE refusé pendant un boot ne note RIEN : la personne est là, elle recliquera", async () => {
  // La distinction est la décision (ADR 0032, décision 5) : un bouton refusé se reclique ; un délai
  // refusé n'a personne pour recliquer. Le geste reste donc « refusé, pas différé » (ADR 0031).
  const coquille = coquilleFeinte({ delaiMs: 60_000 });
  const boot = coquille.gestes.demarrerLApplication();
  await Promise.resolve();
  const rendu = await coquille.gestes.verrouillerLeCoffre(DECLENCHEURS.geste);
  assert.equal(rendu.horsOrdre, true);
  assert.equal(coquille.surveillance.verrouillageDu(), false, "un geste refusé a été noté DÛ");
  // Et le délai reprend sa course : rien n'était dû, `armer` fait son travail.
  assert.equal(coquille.surveillance.armee(), true);

  coquille.libererLeBoot();
  await boot;
  assert.ok(
    !coquille.journal.some((ligne) => ligne.startsWith("verrouille:")),
    "un geste refusé a été rejoué tout seul",
  );
});

// --- Le CLIQUET : `beforeunload` et `unload` ne sont branchés NULLE PART ---------------------------

/**
 * Les APPELS par lesquels un écouteur de fin d'onglet entre dans un document. Il n'y en a pas
 * d'autre : un écouteur se pose par `addEventListener`, ou par la propriété `on…` du document ou de
 * la fenêtre.
 *
 * Les motifs sont ANCRÉS sur le guillemet ouvrant ou sur `on`, faute de quoi « unload » mordrait
 * sur « beforeunload » et le cliquet compterait deux fois le même défaut en manquant l'autre.
 */
const PORTES = Object.freeze([
  'addEventListener("beforeunload"',
  "addEventListener('beforeunload'",
  "addEventListener(`beforeunload`",
  'addEventListener("unload"',
  "addEventListener('unload'",
  "addEventListener(`unload`",
  "onbeforeunload",
  ".onunload",
]);

/**
 * Les fichiers de PRODUIT que le cliquet balaie, et ils sont plus nombreux qu'à la première
 * rédaction : `public/` ENTIER — modules et documents —, `src/coquille/` et `src/vm/`.
 *
 * Le commentaire disait « il balaie le produit entier » pendant qu'il ne lisait que `public/main.mjs`
 * et `src/coquille/` : ni le Worker de confiance, ni celui de dérivation, ni le document applicatif,
 * ni `src/vm/` n'étaient regardés (constat 5 de la revue de sécurité de la PR #177 ; aucune violation
 * n'y existait, ce qui est exactement ce qu'une absence surveillée doit rester).
 *
 * `public/coquille-epreuve/` est ÉCARTÉ, et c'est une décision : ce banc n'est pas publié
 * (`SOURCES_COQUILLE`), il porte déjà un Service Worker hostile, et ce qu'il sert lui appartient.
 *
 * **La limite du cliquet, écrite** : il compare des FORMES de texte, pas un arbre syntaxique. Un
 * branchement construit par calcul — `addEventListener(nom, …)` avec `nom` calculé — lui échappe,
 * et c'est assumé : ce qu'il défend est une absence contre une réintroduction ordinaire.
 */
async function sourcesDeLaCoquille() {
  const fichiers = [];
  const balayer = async (racine, extensions) => {
    const entrees = await readdir(path.join(REPO_ROOT, ...racine.split("/")), { recursive: true });
    for (const entree of entrees) {
      const chemin = `${racine}/${entree.replaceAll("\\", "/")}`;
      if (chemin.startsWith("public/coquille-epreuve/")) continue;
      if (extensions.some((extension) => chemin.endsWith(extension))) fichiers.push(chemin);
    }
  };
  await balayer("public", [".mjs", ".html"]);
  await balayer("src/coquille", [".mjs"]);
  await balayer("src/vm", [".mjs"]);
  return fichiers;
}

test("aucun `beforeunload` ni `unload` n'est branché dans le produit — le cliquet le surveille", async () => {
  // Le balayage doit VOIR des fichiers, et pas seulement ne rien trouver : un cliquet qui lit une
  // liste vide passe au vert pour la mauvaise raison.
  const balayes = await sourcesDeLaCoquille();
  assert.ok(balayes.includes("public/main.mjs"), "la page de la coquille n'est pas balayée");
  assert.ok(
    balayes.includes("public/runtime-worker.mjs"),
    "le Worker de confiance n'est pas balayé",
  );
  assert.ok(balayes.includes("public/index.html"), "le document de la coquille n'est pas balayé");
  assert.ok(
    balayes.some((chemin) => chemin.startsWith("src/vm/")),
    "src/vm/ n'est pas balayé",
  );
  assert.ok(
    !balayes.some((chemin) => chemin.startsWith("public/coquille-epreuve/")),
    "le banc est balayé alors qu'il est écarté par décision",
  );
  // Une ABSENCE ne se relit pas, elle se surveille : c'est la forme de
  // `tests/unit/coquille-sans-service-worker.test.mjs`, et son en-tête vaut mot pour mot ici — « une
  // affirmation que rien ne relit finit toujours par devenir fausse ».
  //
  // `beforeunload` est le seul événement ANNULABLE de la famille, et le seul usage qu'il offre est
  // de retenir l'utilisateur par une boîte de dialogue : s'y suspendre est ce que la Definition of
  // Ready de #25 interdit. `unload` est obsolète, et tout ce qu'il ferait, `pagehide` le fait.
  const defauts = [];
  for (const fichier of balayes) {
    const source = await readFile(path.join(REPO_ROOT, fichier), "utf8");
    for (const porte of PORTES) {
      if (source.includes(porte)) defauts.push(`${fichier} : ${porte}`);
    }
  }
  assert.deepEqual(
    defauts,
    [],
    "un événement de fin d'onglet interdit est branché dans le produit",
  );
});

test("le cliquet MORD : présenté à un branchement interdit, il le relève", async () => {
  // Un cliquet à vide passe toujours. Celui-ci est confronté à la ligne exacte qu'il doit refuser.
  const contrefacon =
    'racine.addEventListener("beforeunload", (evenement) => evenement.preventDefault());';
  const releves = PORTES.filter((porte) => contrefacon.includes(porte));
  assert.deepEqual(releves, ['addEventListener("beforeunload"']);
  // Et il ne confond pas les deux : « unload » ne mord pas sur « beforeunload ».
  assert.equal(contrefacon.includes('addEventListener("unload"'), false);
});
