/**
 * Le VERDICT d'épinglage de la chaîne de publication, depuis que DEUX artefacts sont vendus (#22).
 *
 * v86 (ADR 0003) et Argon2id (ADR 0021) sont vendus pour des raisons différentes et vérifiés par le
 * même code. Ce qui les fond en un seul verdict est ce que ces épreuves mesurent, et le défaut
 * qu'elles ferment n'était visible que sur la conjonction :
 *
 *  - `v86.verifie || argon2.verifie` rendait « épinglage conforme » alors que le manifeste
 *    d'Argon2 était ABSENT de l'arbre, du moment que celui de v86 était vérifié. Un OU sur deux
 *    vérifications indépendantes ne vérifie rien : il suffit qu'une des deux passe ;
 *  - `v86.motif ?? argon2.motif` perdait le second motif, si bien qu'un arbre à qui les deux
 *    manquaient n'en nommait qu'un ;
 *  - l'épinglage n'était calculé que si l'arbre portait `vendor/v86`. Un arbre qui publierait
 *    l'artefact Argon2id SANS publier l'émulateur n'aurait donc vu son épinglage vérifié nulle
 *    part — la vérification la plus importante des deux, puisque ce binaire étire un secret.
 *
 * Les arbres sont écrits dans un répertoire temporaire : ces épreuves ne dépendent ni d'une
 * construction préalable ni de la présence des artefacts v86, qui ne sont pas versionnés.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ARBRES } from "../../tools/publier-arborescences.mjs";
import { empreinte } from "../../tools/publier-inventaire.mjs";
import { epinglagesAttendus, fusionnerEpinglages } from "../../tools/publier.mjs";

const OCTETS_V86 = new TextEncoder().encode("des octets d'émulateur");
const OCTETS_ARGON2 = new TextEncoder().encode("des octets d'Argon2id");

/** Écrit un manifeste vendu et l'artefact qu'il épingle, à leurs places dans un arbre publié. */
async function poserEpinglage(racine, { dossier, sousDossier, nom, octets }) {
  const cible = join(racine, "vendor", dossier, ...(sousDossier === null ? [] : [sousDossier]));
  await mkdir(cible, { recursive: true });
  await writeFile(join(cible, nom), octets);
  await writeFile(
    join(racine, "vendor", dossier, "MANIFEST.json"),
    JSON.stringify({ artifacts: [{ name: nom, sha256: empreinte(octets) }] }),
    "utf8",
  );
}

/**
 * Un arbre publié complet : les deux manifestes, les deux artefacts, tout conforme.
 *
 * @param {{ sans?: string[] }} [manque] les manifestes à NE PAS écrire
 */
async function arbreVendu({ sans = [], sansArtefacts = [] } = {}) {
  const racine = await mkdtemp(join(tmpdir(), "vault-epinglage-"));
  const poses = [
    { dossier: "v86", sousDossier: "artefacts", nom: "v86.wasm", octets: OCTETS_V86 },
    { dossier: "argon2", sousDossier: null, nom: "argon2.wasm", octets: OCTETS_ARGON2 },
  ];
  for (const pose of poses) {
    if (sans.includes(pose.dossier)) continue;
    await poserEpinglage(racine, pose);
    if (sansArtefacts.includes(pose.dossier)) {
      await rm(join(racine, "vendor", pose.dossier, pose.sousDossier ?? pose.nom), {
        recursive: true,
        force: true,
      });
    }
  }
  return racine;
}

const LES_DEUX = Object.freeze({ v86: true, argon2: true });

test("un arbre qui porte les deux manifestes conformes rend un épinglage vérifié", async () => {
  const racine = await arbreVendu();
  try {
    const verdict = await fusionnerEpinglages(racine, empreinte, LES_DEUX);
    assert.deepEqual(verdict, {
      attendus: 2,
      verifie: true,
      motif: null,
      ecarts: [],
      rupture: false,
    });
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("un manifeste ABSENT rompt l'épinglage, même quand l'autre est vérifié", async () => {
  // Le défaut d'origine, mesuré des deux côtés pour qu'aucun des deux ne puisse à lui seul faire
  // passer le verdict. Avec un OU, l'un des deux cas rendait « conforme ».
  for (const manquant of ["argon2", "v86"]) {
    const racine = await arbreVendu({ sans: [manquant] });
    try {
      const verdict = await fusionnerEpinglages(racine, empreinte, LES_DEUX);
      assert.equal(verdict.verifie, false, `${manquant} absent : le verdict se dit vérifié`);
      assert.equal(verdict.rupture, true, "un manifeste absent est une RUPTURE, pas une lacune");
      assert.match(verdict.motif, new RegExp(`^${manquant} : manifeste absent$`));
    } finally {
      await rm(racine, { recursive: true, force: true });
    }
  }
});

test("les DEUX motifs sont remontés quand les deux manquent, jamais le premier seul", async () => {
  const racine = await arbreVendu({ sans: ["v86", "argon2"] });
  try {
    const verdict = await fusionnerEpinglages(racine, empreinte, LES_DEUX);
    assert.equal(verdict.motif, "v86 : manifeste absent ; argon2 : manifeste absent");
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("un artefact substitué est un ÉCART qui NOMME son épinglage", async () => {
  const racine = await arbreVendu();
  try {
    await writeFile(join(racine, "vendor", "argon2", "argon2.wasm"), "d'autres octets");
    const verdict = await fusionnerEpinglages(racine, empreinte, LES_DEUX);
    assert.equal(verdict.rupture, true);
    assert.deepEqual(
      verdict.ecarts.map(({ epinglage, artefact, motif }) => ({ epinglage, artefact, motif })),
      [{ epinglage: "argon2", artefact: "argon2.wasm", motif: "empreinte" }],
    );
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("des ARTEFACTS absents ne sont pas une rupture : c'est l'incomplétude de l'inventaire", async () => {
  // Les artefacts v86 ne sont pas versionnés (`npm run vm:fetch` les récupère). Leur absence dans
  // un clone vierge est une INCOMPLÉTUDE, que l'inventaire porte et que `--tolerer-incomplet`
  // tolère ; la confondre avec une substitution refuserait un dépôt sain comme un dépôt attaqué.
  const racine = await arbreVendu({ sansArtefacts: ["v86"] });
  try {
    const verdict = await fusionnerEpinglages(racine, empreinte, LES_DEUX);
    assert.equal(verdict.verifie, false);
    assert.equal(verdict.rupture, false);
    assert.equal(verdict.motif, "v86 : artefacts absents de l'arbre publié");
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("un arbre qui n'attend aucun épinglage n'en rend aucun motif", async () => {
  // L'origine applicative ne publie aucun artefact de ce dépôt (ADR 0002). Lui répondre
  // « manifeste absent » ferait passer une propriété pour un défaut.
  const racine = await arbreVendu({ sans: ["v86", "argon2"] });
  try {
    const verdict = await fusionnerEpinglages(racine, empreinte, { v86: false, argon2: false });
    assert.deepEqual(verdict, {
      attendus: 0,
      verifie: false,
      motif: null,
      ecarts: [],
      rupture: false,
    });
  } finally {
    await rm(racine, { recursive: true, force: true });
  }
});

test("l'épinglage attendu est déduit artefact par artefact, jamais de la présence de v86", async () => {
  const coquille = ARBRES.find(({ nom }) => nom === "coquille");
  assert.deepEqual(epinglagesAttendus(coquille), LES_DEUX, "la coquille publie les deux artefacts");

  const application = ARBRES.find(({ nom }) => nom === "application");
  assert.deepEqual(epinglagesAttendus(application), { v86: false, argon2: false });

  // Le cœur du constat : un arbre qui publierait Argon2id SANS l'émulateur doit voir l'épinglage
  // d'Argon2id vérifié. Il ne l'était pas — la vérification entière était conditionnée à `vendor/v86`.
  assert.deepEqual(epinglagesAttendus({ sources: [{ depuis: "vendor/argon2/argon2.wasm" }] }), {
    v86: false,
    argon2: true,
  });
});
