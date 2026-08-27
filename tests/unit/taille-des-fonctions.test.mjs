/**
 * Contrôle de taille des unités : **aucune fonction de `src/` ni de `public/vm/` ne dépasse
 * 50 lignes sans être inscrite ici, avec son motif.**
 *
 * Le dépôt appliquait déjà ce plafond à la main — `src/vm/crash-plan.mjs` porte le commentaire
 * « Séparé pour rester sous la barre des 50 lignes » — mais rien ne le mesurait. L'issue #77 a dû
 * relever ses dépassements à la lecture, et sa table s'est révélée incomplète et déjà périmée :
 * `bootEtVerifier` y valait 93 lignes, en valait 102 au rattachement de #87, et 119 au moment de
 * cette mesure. Une convention qu'aucune épreuve ne mesure dérive sans que personne le voie.
 *
 * ## Comment la mesure est faite
 *
 * Par `max-lines-per-function` d'ESLint, appliquée en surcharge sur la configuration réelle du
 * dépôt — donc sans l'y activer. C'est délibéré : activée dans `eslint.config.mjs`, la règle ne se
 * tairait qu'au prix d'un `eslint-disable` par dépassement, c'est-à-dire d'une justification
 * dispersée dans trente fichiers et invisible d'un seul regard. Inscrite ici, la liste des
 * exceptions se lit d'un bloc, chacune porte son motif, et aucune ne peut grandir en silence.
 *
 * Les lignes sont comptées comme la règle les compte : commentaires et lignes vides compris, de
 * l'accolade ouvrante à l'accolade fermante. Ce sont les chiffres de #77.
 *
 * ## Ce que l'épreuve refuse
 *
 * 1. une fonction de plus de 50 lignes qui n'est pas inscrite ci-dessous ;
 * 2. une fonction inscrite qui a **grandi** au-delà de la taille relevée — la liste est un cliquet,
 *    jamais un blanc-seing ;
 * 3. une inscription **périmée**, dont la fonction est passée sous le plafond ou a disparu : la
 *    dette soldée sort de la liste dans la PR qui la solde.
 *
 * ## Deux natures d'inscription
 *
 * `JUSTIFIEES` porte les dépassements que le dépôt a examinés et **décidé de garder** ; leur motif
 * est un argument, et l'issue qui l'a tranché est citée. `DETTE_ANTERIEURE` porte les dépassements
 * que le relevé de #77 a découverts **hors de son périmètre** : ils ne sont pas justifiés, ils sont
 * seulement datés et bornés, et #93 les solde.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Plafond du dépôt, en lignes, tel que #77 l'a mesuré. */
const PLAFOND = 50;

/** Code de production servi au navigateur. `tests/` et `tools/` ne sont pas couverts. */
const PERIMETRE = ["src/**/*.mjs", "public/vm/**/*.mjs"];

/**
 * Dépassements EXAMINÉS et gardés. Ajouter une ligne ici demande un motif qui tienne devant une
 * revue : « c'est long » n'en est pas un.
 */
const JUSTIFIEES = [
  {
    fichier: "src/vm/opfs-migration-target.mjs",
    fonction: "Function 'createOpfsMigrationTarget'",
    lignes: 75,
    motif:
      "#77 — fabrique de contrat : huit paramètres injectables et un objet littéral de neuf " +
      "méthodes d'une ligne, chacune une délégation documentée. Aucun branchement sauf un " +
      "try/catch. La découper disperserait le contrat sans retirer une seule décision.",
  },
];

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
    fichier: "src/vm/serial-http-client.mjs",
    fonction: "Function 'createSerialHttpClient'",
    lignes: 97,
  },
  {
    fichier: "public/vm/opfs-runtime-worker.mjs",
    fonction: "Async function 'scenarioAdaptateur'",
    lignes: 96,
  },
  {
    fichier: "src/vm/opfs-import-target.mjs",
    fonction: "Function 'createOpfsImportTarget'",
    lignes: 93,
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
  { fichier: "src/vm/sync-access-double.mjs", fonction: "Function 'makeHandle'", lignes: 75 },
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
  { fichier: "src/vm/crash-machine.mjs", fonction: "Function 'creerMachineJetable'", lignes: 68 },
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
  {
    fichier: "src/vm/runtime-environment.mjs",
    fonction: "Function 'surveillerPremierTour'",
    lignes: 55,
  },
  { fichier: "src/vm/crash-oracle.mjs", fonction: "Function 'classerVolume'", lignes: 53 },
];

const INSCRITES = [...JUSTIFIEES, ...DETTE_ANTERIEURE];

/** Clé d'identité d'une fonction : son fichier et son étiquette ESLint (nature + nom). */
const cle = ({ fichier, fonction }) => `${fichier} — ${fonction}`;

/**
 * Relève les fonctions dépassant le plafond, en surchargeant la configuration réelle du dépôt.
 *
 * @returns {Promise<{ fichier: string, fonction: string, ligne: number, lignes: number }[]>}
 */
async function relever() {
  const eslint = new ESLint({
    cwd: REPO_ROOT,
    overrideConfig: {
      rules: {
        "max-lines-per-function": [
          "error",
          { max: PLAFOND, skipBlankLines: false, skipComments: false, IIFEs: true },
        ],
      },
    },
  });

  const resultats = await eslint.lintFiles(PERIMETRE);
  const releve = [];
  for (const resultat of resultats) {
    const fichier = resultat.filePath
      .replaceAll("\\", "/")
      .slice(REPO_ROOT.replaceAll("\\", "/").length);
    for (const message of resultat.messages) {
      if (message.ruleId !== "max-lines-per-function") continue;
      // « Async function 'x' has too many lines (119). Maximum allowed is 50. » — la nature et le
      // nom forment l'identité, le nombre entre parenthèses la mesure.
      const [fonction] = message.message.split(" has too many lines");
      const lignes = Number(/\((?<n>\d+)\)/u.exec(message.message)?.groups?.n);
      releve.push({ fichier, fonction, ligne: message.line, lignes });
    }
  }
  return releve;
}

const releve = await relever();

test("le relevé porte bien sur du code, et chaque fonction relevée est identifiable", () => {
  assert.ok(releve.length > 0, "aucun dépassement relevé : le périmètre ou la règle est inopérant");

  const doublons = releve.map(cle).filter((valeur, index, tout) => tout.indexOf(valeur) !== index);
  assert.deepEqual(
    [...new Set(doublons)],
    [],
    "deux fonctions partagent fichier et étiquette : l'inscription ne pourrait plus les distinguer",
  );
});

test("aucune fonction de plus de 50 lignes n'échappe à la liste des exceptions", () => {
  const inscrites = new Set(INSCRITES.map(cle));
  const surprises = releve
    .filter((fonction) => !inscrites.has(cle(fonction)))
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
  const mesurees = new Set(releve.map(cle));
  const perimees = INSCRITES.filter((inscrite) => !mesurees.has(cle(inscrite))).map(cle);

  assert.deepEqual(
    perimees,
    [],
    "Ces fonctions sont passées sous le plafond ou ont disparu : retirez leur inscription.",
  );
});
