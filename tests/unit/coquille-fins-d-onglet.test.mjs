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
 * La sonde de `tests/fins-d-onglet/` a MESURÉ, sur les trois moteurs, que sous Playwright **aucun
 * document n'est jamais restauré depuis le bfcache** — témoin positif compris, une page nue sans
 * instrumentation — et qu'**aucun onglet ne devient jamais caché**, si bien que ni `pageshow`
 * restauré, ni `visibilitychange` vers `visible`, ni `freeze`, ni `resume` ne sont livrés par un
 * moteur dans ce harnais.
 *
 * Ce sont donc ces épreuves-ci, et elles seules, qui tiennent ces quatre chemins : elles injectent
 * l'événement et l'horloge, et la campagne de mutation les rougit. Les écrire comme des épreuves de
 * navigateur les aurait rendues vertes par vacuité, ce que le dépôt refuse depuis #163.
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
} from "../../src/coquille/fins-d-onglet.mjs";
import { DECLENCHEURS, surveillanceDInactivite } from "../../src/coquille/verrouillage.mjs";
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
function montage({ etat = ETATS_DU_VOLUME.ouvert, visibilite = "visible", delaiMs = 60_000 } = {}) {
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
  brancherLesFinsDOnglet({
    racine: contexte.racine,
    fenetre: contexte.fenetre,
    surveillance,
    coffreOuvert: () => etatCourant === ETATS_DU_VOLUME.ouvert,
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

test("`pagehide` sur un coffre qui n'est PAS ouvert ne tue rien", () => {
  // Un coffre verrouillé, en démarrage ou indisponible n'a aucune clé dans le tas d'un Worker : le
  // terminer ferait payer un redémarrage pour rien, et publierait une mort là où il n'y en a pas.
  const montee = montage({ etat: ETATS_DU_VOLUME.verrouille });
  montee.contexte.declencher("pagehide", { persisted: false });
  assert.deepEqual(montee.terminaisons, []);
  assert.deepEqual(montee.rechargements, []);
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

/** Les fichiers de PRODUIT que le cliquet balaie : la page de la coquille, et `src/coquille/`. */
async function sourcesDeLaCoquille() {
  const fichiers = ["public/main.mjs"];
  const entrees = await readdir(path.join(REPO_ROOT, "src", "coquille"), { recursive: true });
  for (const entree of entrees) {
    if (entree.endsWith(".mjs")) fichiers.push(`src/coquille/${entree.replaceAll("\\", "/")}`);
  }
  return fichiers;
}

test("aucun `beforeunload` ni `unload` n'est branché dans le produit — le cliquet le surveille", async () => {
  // Une ABSENCE ne se relit pas, elle se surveille : c'est la forme de
  // `tests/unit/coquille-sans-service-worker.test.mjs`, et son en-tête vaut mot pour mot ici — « une
  // affirmation que rien ne relit finit toujours par devenir fausse ».
  //
  // `beforeunload` est le seul événement ANNULABLE de la famille, et le seul usage qu'il offre est
  // de retenir l'utilisateur par une boîte de dialogue : s'y suspendre est ce que la Definition of
  // Ready de #25 interdit. `unload` est obsolète, et tout ce qu'il ferait, `pagehide` le fait.
  const defauts = [];
  for (const fichier of await sourcesDeLaCoquille()) {
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
