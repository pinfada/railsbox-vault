/**
 * Contrôle de taille des unités : **aucune fonction de `src/` ni de `public/vm/` ne dépasse
 * 50 lignes sans être une fabrique de contrat conforme, ou sans être inscrite ici avec son motif.**
 *
 * Le dépôt appliquait déjà ce plafond à la main — `src/vm/crash-plan.mjs` porte le commentaire
 * « Séparé pour rester sous la barre des 50 lignes » — mais rien ne le mesurait. L'issue #77 a dû
 * relever ses dépassements à la lecture, et sa table s'est révélée incomplète et déjà périmée :
 * `bootEtVerifier` y valait 93 lignes, en valait 102 au rattachement de #87, et 119 au moment de
 * cette mesure. Une convention qu'aucune épreuve ne mesure dérive sans que personne le voie.
 *
 * ## Comment la mesure est faite
 *
 * Par `tests/unit/mesure-taille-des-fonctions.mjs`, qui applique `max-lines-per-function` d'ESLint
 * en surcharge sur la configuration réelle du dépôt — donc sans l'y activer. C'est délibéré :
 * activée dans `eslint.config.mjs`, la règle ne se tairait qu'au prix d'un `eslint-disable` par
 * dépassement, c'est-à-dire d'une justification dispersée dans trente fichiers et invisible d'un
 * seul regard. Inscrite ici, la liste des exceptions se lit d'un bloc, chacune porte son motif, et
 * aucune ne peut grandir en silence.
 *
 * Les lignes sont comptées comme la règle les compte : commentaires et lignes vides compris, de
 * l'accolade ouvrante à l'accolade fermante. Ce sont les chiffres de #77.
 *
 * ## La convention des fabriques de contrat (#93)
 *
 * #77 avait tranché un cas à la main — `createOpfsMigrationTarget`, gardé à 75 lignes — en notant
 * que la question de fond restait ouverte : le plafond doit-il compter le littéral rendu par une
 * fabrique, idiome dominant du dépôt ? #93 la tranche, et l'inscrit dans une MESURE plutôt que dans
 * une liste : le plafond vise l'enchaînement de décisions, pas la déclaration d'un contrat.
 *
 * Le prédicat vit dans `estFabriqueDeContrat`, avec ses trois conditions et leur raison. Une
 * fabrique qui les remplit n'a plus besoin d'être inscrite ici — c'est pourquoi `JUSTIFIEES` est
 * vide : le seul dépassement que le dépôt avait justifié à la main est désormais admis par la
 * règle, et cinq autres avec lui.
 *
 * ## Deux natures d'inscription
 *
 * `JUSTIFIEES` porte les dépassements que le dépôt a examinés et **décidé de garder** alors que la
 * convention ne les couvre pas ; leur motif est un argument, et l'issue qui l'a tranché est citée.
 * `DETTE_ANTERIEURE` porte les dépassements que le relevé de #77 a découverts **hors de son
 * périmètre** : ils ne sont pas justifiés, ils sont seulement datés et bornés, et #93 les solde.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  PLAFOND,
  estFabriqueDeContrat,
  mesurerTexte,
  relever,
} from "./mesure-taille-des-fonctions.mjs";

/**
 * Dépassements EXAMINÉS et gardés alors que la convention des fabriques ne les couvre pas. Ajouter
 * une ligne ici demande un motif qui tienne devant une revue : « c'est long » n'en est pas un.
 *
 * Vide depuis #93. `createOpfsMigrationTarget`, seule entrée de cette liste depuis #77, est
 * désormais admise par la mesure : son corps hors du littéral fait 19 lignes, et aucune de ses neuf
 * méthodes n'en fait plus d'une douzaine. L'argument de #77 n'a pas changé — il est devenu une
 * règle, ce qui le rend applicable aux cinq fabriques de la même forme sans les inscrire une à une.
 *
 * @type {{ fichier: string, fonction: string, lignes: number, motif: string }[]}
 */
const JUSTIFIEES = [];

/**
 * Dépassements ANTÉRIEURS à #77 et hors de son périmètre, relevés le 2026-08-27 sur `main`
 * (01f601a). Ils ne sont pas justifiés : ils sont inscrits pour cesser de croître, et #93 les
 * solde. Une entrée ne se met à jour vers le HAUT que si la revue l'accepte explicitement.
 */
const DETTE_ANTERIEURE = [
  {
    fichier: "src/vm/sync-access-double.mjs",
    fonction: "Function 'createSyncAccessStore'",
    lignes: 202,
  },
  {
    fichier: "src/vm/reference-guest-session.mjs",
    fonction: "Function 'createReferenceGuestSession'",
    lignes: 179,
  },
  { fichier: "src/vm/storage-budget.mjs", fonction: "Function 'createStorageBudget'", lignes: 155 },
  { fichier: "src/vm/guest-session.mjs", fonction: "Function 'createGuestSession'", lignes: 142 },
  {
    fichier: "src/vm/v86-buffer-adapter.mjs",
    fonction: "Function 'createV86BufferAdapter'",
    lignes: 140,
  },
  {
    fichier: "src/vm/write-lease-arbiter.mjs",
    fonction: "Function 'createLeaseArbiter'",
    lignes: 124,
  },
  { fichier: "src/vm/volume-export.mjs", fonction: "Async function 'readArchive'", lignes: 107 },
  {
    fichier: "public/vm/opfs-runtime-worker.mjs",
    fonction: "Async function 'scenarioAdaptateur'",
    lignes: 96,
  },
  {
    fichier: "public/vm/runtime-worker.mjs",
    fonction: "Async function 'runOpfsPersistence'",
    lignes: 93,
  },
  { fichier: "src/vm/scheduling-loop.mjs", fonction: "Function 'creerBoucle'", lignes: 87 },
  {
    fichier: "src/vm/write-lease-transport.mjs",
    fonction: "Function 'acquireWriteLease'",
    lignes: 85,
  },
  {
    fichier: "src/vm/opfs-scenarios.mjs",
    fonction: "Async function 'observePersistence'",
    lignes: 84,
  },
  {
    fichier: "src/vm/serial-protocol.mjs",
    fonction: "Function 'creerAssembleurReponses'",
    lignes: 72,
  },
  {
    fichier: "src/vm/v86-flush-bridge.mjs",
    fonction: "Function 'installDurabilityBridge'",
    lignes: 72,
  },
  {
    fichier: "public/vm/runtime-worker.mjs",
    fonction: "Async function 'runOpfsBarrier'",
    lignes: 71,
  },
  {
    fichier: "src/vm/opfs-scenarios.mjs",
    fonction: "Async function 'auditPersistenceReport'",
    lignes: 65,
  },
  { fichier: "src/vm/serial-protocol.mjs", fonction: "Method 'traiterLigne'", lignes: 65 },
  { fichier: "src/vm/crash-report.mjs", fonction: "Function 'resumerMatrice'", lignes: 62 },
  { fichier: "public/vm/runtime-worker.mjs", fonction: "Async function 'run'", lignes: 60 },
  {
    fichier: "src/vm/block-journal.mjs",
    fonction: "Function 'auditDurabilityBarriers'",
    lignes: 59,
  },
  { fichier: "src/vm/volume-import.mjs", fonction: "Async function 'importArchive'", lignes: 58 },
  { fichier: "src/vm/volume-export.mjs", fonction: "Async function 'writeArchive'", lignes: 57 },
  { fichier: "src/vm/crash-oracle.mjs", fonction: "Function 'classerVolume'", lignes: 53 },
];

const INSCRITES = [...JUSTIFIEES, ...DETTE_ANTERIEURE];

/** Clé d'identité d'une fonction : son fichier et son étiquette ESLint (nature + nom). */
const cle = ({ fichier, fonction }) => `${fichier} — ${fonction}`;

const releve = await relever();
const fabriques = releve.filter(estFabriqueDeContrat);

test("le relevé porte bien sur du code, et chaque fonction relevée est identifiable", () => {
  assert.ok(releve.length > 0, "aucun dépassement relevé : le périmètre ou la règle est inopérant");

  const doublons = releve.map(cle).filter((valeur, index, tout) => tout.indexOf(valeur) !== index);
  assert.deepEqual(
    [...new Set(doublons)],
    [],
    "deux fonctions partagent fichier et étiquette : l'inscription ne pourrait plus les distinguer",
  );
});

test("les deux mesures se rejoignent sur chaque fonction relevée", () => {
  const orphelines = releve
    .filter((fonction) => fonction.horsLitteral === null)
    .map((f) => `${f.fichier}:${f.ligne} — ${f.fonction}`);

  assert.deepEqual(
    orphelines,
    [],
    "La forme du corps n'a pas pu être appariée à ces dépassements : l'instrument est cassé, " +
      "et une fonction qu'il ne sait pas mesurer ne doit surtout pas passer pour conforme.",
  );
});

test("aucune fonction de plus de 50 lignes n'échappe à la convention ni à la liste", () => {
  const admises = new Set([...INSCRITES.map(cle), ...fabriques.map(cle)]);
  const surprises = releve
    .filter((fonction) => !admises.has(cle(fonction)))
    .map((f) => `${f.fichier}:${f.ligne} — ${f.fonction} : ${f.lignes} lignes`);

  assert.deepEqual(
    surprises,
    [],
    "Découpez ces fonctions, ou inscrivez-les dans ce fichier avec leur motif :",
  );
});

test("aucune exception inscrite n'a grandi au-delà de la taille relevée", () => {
  const mesures = new Map(releve.map((fonction) => [cle(fonction), fonction.lignes]));
  const debordements = INSCRITES.filter(
    (inscrite) => (mesures.get(cle(inscrite)) ?? 0) > inscrite.lignes,
  ).map(
    (inscrite) =>
      `${cle(inscrite)} : ${mesures.get(cle(inscrite))} lignes, inscrite à ${inscrite.lignes}`,
  );

  assert.deepEqual(
    debordements,
    [],
    "La liste est un cliquet : une exception ne grandit pas sans que la revue l'accepte.",
  );
});

test("aucune exception inscrite n'est périmée", () => {
  const aInscrire = new Set(releve.filter((f) => !estFabriqueDeContrat(f)).map(cle));
  const perimees = INSCRITES.filter((inscrite) => !aInscrire.has(cle(inscrite))).map(cle);

  assert.deepEqual(
    perimees,
    [],
    "Ces fonctions sont passées sous le plafond, ont disparu, ou sont désormais admises comme " +
      "fabriques de contrat : retirez leur inscription.",
  );
});

test("la convention discrimine : elle n'admet ni tout, ni rien", () => {
  assert.ok(
    fabriques.length > 0,
    "aucune fabrique de contrat admise : le prédicat n'admet rien, la convention est lettre morte",
  );
  assert.ok(
    fabriques.length < releve.length,
    "toutes les fonctions relevées sont admises : le prédicat n'exclut rien, le plafond est mort",
  );
});

// --- La convention elle-même, éprouvée sur des exemples ---------------------------------------
//
// Un prédicat qu'aucun exemple n'éprouve n'est qu'une intention. Chacun de ces fragments isole UNE
// condition et vérifie qu'elle décide, plutôt que de faire confiance à la lecture du prédicat.

/** Fabrique canonique : quelques gestes, puis un littéral de méthodes courtes. */
const FABRIQUE_CANONIQUE = `export function creerContrat(options) {
  const etat = options.etat;
${"  // une ligne de corps\n".repeat(10)}  return {
${"    membre() {\n      return etat;\n    },\n".repeat(15)}  };
}
`;

test("une fabrique de contrat est admise même très au-delà du plafond", async () => {
  const [mesure] = await mesurerTexte(FABRIQUE_CANONIQUE);

  assert.ok(
    mesure.lignes > PLAFOND,
    "le fragment doit dépasser le plafond pour prouver quoi que ce soit",
  );
  assert.ok(mesure.horsLitteral <= PLAFOND);
  assert.equal(estFabriqueDeContrat(mesure), true);
});

test("un littéral de DONNÉES n'est pas un contrat : la fonction qui l'assemble se mesure", async () => {
  const source = `export function resumer(entrees) {
  const total = entrees.length;
  return {
${"    champ: total,\n".repeat(60)}  };
}
`;
  const [mesure] = await mesurerTexte(source);

  assert.equal(mesure.rendUnContrat, false);
  assert.equal(estFabriqueDeContrat(mesure), false);
});

test("une fabrique dont le corps enchaîne des décisions n'est pas admise", async () => {
  const source = `export function creerContrat(options) {
${"  if (options.a) options.b = 1;\n".repeat(60)}  return {
    membre() {
      return options;
    },
  };
}
`;
  const [mesure] = await mesurerTexte(source);

  assert.ok(mesure.rendUnContrat);
  assert.ok(mesure.horsLitteral > PLAFOND);
  assert.equal(estFabriqueDeContrat(mesure), false);
});

test("une fabrique dont une méthode dépasse le plafond n'est pas admise non plus", async () => {
  const source = `export function creerContrat(options) {
  return {
    membre() {
${"      options.a = 1;\n".repeat(60)}    },
  };
}
`;
  const releveFixture = await mesurerTexte(source);
  const fabrique = releveFixture.find((f) => f.fonction.includes("creerContrat"));

  assert.ok(fabrique.horsLitteral <= PLAFOND, "le corps hors du littéral tient sous le plafond");
  assert.ok(fabrique.plusGrandeMethode > PLAFOND);
  assert.equal(estFabriqueDeContrat(fabrique), false);
  assert.ok(
    releveFixture.some((f) => f.fonction === "Method 'membre'"),
    "la méthode trop longue est relevée pour elle-même : c'est elle qui se découpe",
  );
});
