import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { nomAdresse } from "../../src/v86-adresses.mjs";
import { CODES_DE_SORTIE, verdictGardeMemoire } from "../../tools/isolation-analyse-wasm.mjs";
import {
  LIMITES_PARTAGEES,
  LIMITES_SIMPLES,
  moduleWasm,
  sectionImportMemoire,
  sectionMemoire,
} from "./fabrique-module-wasm.mjs";

// Le risque résiduel n°2 de l'ADR 0010 nomme exactement ce que ces épreuves ferment : le fait qui
// porte la décision de ne pas imposer l'isolation multi-origine est DATÉ — il vaut pour
// `v86@0.5.432`. Une montée de version vers un artefact déclarant une mémoire WebAssembly partagée
// l'invaliderait « sans aucun autre signal » : ni les empreintes de `vendor/v86/MANIFEST.json`, ni
// la suite VM ne regardent le drapeau de partage.
//
// L'instrument existait déjà (`npm run isolation:inventaire --exiger-v86`, #41). Ce qui manquait
// était son DÉCLENCHEMENT. Il est désormais rattaché à `npm run vm:check`, seul point par lequel un
// artefact v86 entre dans le dépôt.
//
// Deux niveaux d'épreuve, et les deux sont nécessaires :
//
//  1. la fonction de garde, sur des modules fabriqués — c'est là qu'on peut exhiber le cas partagé ;
//  2. la commande `vm:check` elle-même, exécutée sur un dépôt fictif où l'artefact fabriqué est
//     placé LÀ OÙ ELLE REGARDE. Sans ce second niveau, rien ne prouverait le branchement : une
//     fonction correcte qu'aucune commande n'appelle ne garde rien.

const RACINE_DEPOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * Outils réellement copiés dans le dépôt fictif. `fetch-v86.mjs` déduit l'emplacement des artefacts
 * de celui de `tools/` (`v86-paths.mjs`) : déplacer les outils suffit à déplacer ce qu'ils
 * inspectent, sans variable d'environnement ajoutée pour les seuls tests.
 */
const OUTILS = Object.freeze([
  "fetch-v86.mjs",
  "isolation-analyse-wasm.mjs",
  "v86-manifest.mjs",
  "v86-paths.mjs",
]);

/**
 * Modules de `src/` dont les outils dépendent. Depuis #123, `v86-paths.mjs` importe la DÉRIVATION
 * d'adresses : le dépôt fictif doit la porter, sans quoi ce qui échouerait serait un import et non
 * la garde que ces épreuves mesurent.
 */
const MODULES_SOURCE = Object.freeze(["v86-adresses.mjs"]);

const dossiersTemporaires = [];

test.after(async () => {
  for (const dossier of dossiersTemporaires) {
    await rm(dossier, { recursive: true, force: true });
  }
});

/** Dépôt fictif : les outils réels, un manifeste fabriqué, un artefact wasm fabriqué. */
async function depotFictif(octetsWasm, { empreinte, nom = "v86.wasm" } = {}) {
  const racine = await mkdtemp(join(tmpdir(), "vault-garde-"));
  dossiersTemporaires.push(racine);
  await mkdir(join(racine, "tools"), { recursive: true });
  await mkdir(join(racine, "src"), { recursive: true });
  await mkdir(join(racine, "vendor", "v86", "artefacts"), { recursive: true });
  for (const outil of OUTILS) {
    await cp(join(RACINE_DEPOT, "tools", outil), join(racine, "tools", outil));
  }
  for (const module of MODULES_SOURCE) {
    await cp(join(RACINE_DEPOT, "src", module), join(racine, "src", module));
  }
  const sha256 = empreinte ?? createHash("sha256").update(octetsWasm).digest("hex");
  // L'artefact est déposé à l'ADRESSE que le manifeste lui dicte (#123) : c'est là que
  // `fetch-v86.mjs` va le chercher, et un dépôt fictif qui le nommerait autrement mesurerait une
  // absence plutôt que la garde de mémoire partagée.
  await writeFile(join(racine, "vendor", "v86", "artefacts", nomAdresse(nom, sha256)), octetsWasm);
  const manifeste = {
    contract: { id: "railsbox-vault-vendor-v86", version: 1 },
    pins: { npmPackage: "v86@0.5.999-fictif" },
    artifacts: [
      {
        name: nom,
        bytes: octetsWasm.length,
        sha256,
        license: "BSD-2-Clause",
        source: {
          kind: "npm-tarball-entry",
          url: "https://exemple.invalide/v86.tgz",
          entry: `package/build/${nom}`,
        },
      },
    ],
  };
  await writeFile(
    join(racine, "vendor", "v86", "MANIFEST.json"),
    `${JSON.stringify(manifeste, null, 2)}\n`,
  );
  return join(racine, "tools", "fetch-v86.mjs");
}

/** Exécute la commande sans lever : ici le code de sortie EST le résultat mesuré. */
function executer(commande, ...arguments_) {
  return new Promise((resoudre) => {
    execFile(process.execPath, [commande, ...arguments_], (erreur, stdout, stderr) => {
      resoudre({ code: erreur ? erreur.code : 0, sortie: `${stdout}\n${stderr}`, stdout, stderr });
    });
  });
}

test("la garde nomme la mémoire partagée et l'ADR 0010 quand le module en déclare une", () => {
  const verdict = verdictGardeMemoire(moduleWasm(sectionMemoire(LIMITES_PARTAGEES)));

  assert.equal(verdict.statut, "partagee");
  assert.equal(verdict.codeDeSortie, CODES_DE_SORTIE.memoirePartagee);
  assert.match(verdict.message, /mémoire WebAssembly PARTAGÉE/);
  assert.match(verdict.message, /ADR 0010/);
});

test("une mémoire IMPORTÉE partagée est refusée aussi : la déclarer n'est pas la seule voie", () => {
  const verdict = verdictGardeMemoire(moduleWasm(sectionImportMemoire(LIMITES_PARTAGEES)));

  assert.equal(verdict.statut, "partagee");
  assert.equal(verdict.codeDeSortie, CODES_DE_SORTIE.memoirePartagee);
});

test("un module sans mémoire partagée passe la garde, et le verdict dit ce qu'il a lu", () => {
  const verdict = verdictGardeMemoire(moduleWasm(sectionMemoire(LIMITES_SIMPLES)));

  assert.equal(verdict.statut, "conforme");
  assert.equal(verdict.codeDeSortie, CODES_DE_SORTIE.succes);
  assert.match(verdict.message, /non partagée/);
  assert.equal(verdict.analyse.memoiresDeclarees.length, 1);
});

test("un v86.wasm illisible fait échouer la garde plutôt que de la faire passer", () => {
  const verdict = verdictGardeMemoire(Uint8Array.from([0x00, 0x61, 0x00, 0x00, 0, 0, 0, 0]));

  assert.equal(verdict.statut, "illisible");
  assert.notEqual(verdict.codeDeSortie, CODES_DE_SORTIE.succes);
  assert.match(verdict.message, /n'est pas un module WebAssembly/);
});

test("un v86.wasm absent fait échouer la garde : une garde qui n'a rien lu ne garde rien", () => {
  const verdict = verdictGardeMemoire(null);

  assert.equal(verdict.statut, "absent");
  assert.equal(verdict.codeDeSortie, CODES_DE_SORTIE.artefactsAbsents);
  assert.match(verdict.message, /vm:fetch/);
});

test("« vm:check » échoue sur une montée de version fictive portant une mémoire partagée", async () => {
  const commande = await depotFictif(moduleWasm(sectionMemoire(LIMITES_PARTAGEES)));

  const { code, sortie, stdout } = await executer(commande, "--check");

  assert.equal(code, CODES_DE_SORTIE.memoirePartagee);
  assert.match(sortie, /mémoire WebAssembly PARTAGÉE/);
  assert.match(sortie, /ADR 0010/);
  // L'empreinte de cet artefact-là est juste : la garde n'emprunte pas son échec à l'autre
  // vérification, et l'échec désigne bien le drapeau de partage.
  assert.match(stdout, /v86\.wasm : empreinte conforme/);
});

test("« vm:check » rapporte l'empreinte ET la mémoire partagée : aucune n'avale l'autre", async () => {
  const commande = await depotFictif(moduleWasm(sectionMemoire(LIMITES_PARTAGEES)), {
    empreinte: "0".repeat(64),
  });

  const { code, sortie, stdout } = await executer(commande, "--check");

  assert.match(stdout, /empreinte SHA-256 inattendue/);
  assert.match(sortie, /mémoire WebAssembly PARTAGÉE/);
  // Les deux échecs sont dits ; le code de sortie retenu est celui qui rouvre une décision.
  assert.equal(code, CODES_DE_SORTIE.memoirePartagee);
});

test("« vm:check » passe sur un artefact conforme et non partagé", async () => {
  const commande = await depotFictif(moduleWasm(sectionMemoire(LIMITES_SIMPLES)));

  const { code, stdout } = await executer(commande, "--check");

  assert.equal(code, 0);
  assert.match(stdout, /non partagée/);
});

test("« vm:check » échoue si le manifeste ne décrit plus aucun v86.wasm", async () => {
  // Toutes les empreintes sont justes : seul le nom a changé. Renommer l'artefact désarmerait la
  // garde en silence — c'est exactement le genre de montée de version que #75 doit rendre bruyante.
  const commande = await depotFictif(moduleWasm(sectionMemoire(LIMITES_SIMPLES)), {
    nom: "v86-renomme.wasm",
  });

  const { code, sortie, stdout } = await executer(commande, "--check");

  assert.match(stdout, /empreinte conforme/);
  assert.equal(code, CODES_DE_SORTIE.artefactsAbsents);
  assert.match(sortie, /v86\.wasm/);
});
