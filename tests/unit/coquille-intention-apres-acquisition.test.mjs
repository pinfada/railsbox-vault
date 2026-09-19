// L'INTENTION d'une mise à jour n'est inscrite qu'APRÈS l'acquisition du disque système (recette QA
// de la PR #249, Q1).
//
// Inscrite avant le téléchargement, elle faisait perdre « Plus tard » à une coupure pendant laquelle
// rien n'avait été migré : la recette l'a vu en coupant à 0,5 s, noyau en cours de téléchargement.
// Le crochet `avantLeBoot` de `bootEtVerifier` n'est appelé qu'une fois le runtime ACQUIS et VÉRIFIÉ ;
// `avantLeBootDuPaquet` y range l'inscription. Ces épreuves exigent les deux moitiés.

import assert from "node:assert/strict";
import { after, test } from "node:test";

import { avantLeBootDuPaquet } from "../../src/coquille/mise-a-jour-applicative.mjs";
import { PHASES_DU_BOOT, phaseDuBoot, poserLaPhase } from "../../src/vm/phase-du-boot.mjs";
import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { createManifest } from "../../src/vm/volume-manifest.mjs";

// Le module de boot POSE la boucle d'ordonnancement à son évaluation ; elle est retirée à la fin,
// sans quoi elle garderait le processus de l'épreuve en vie.
const { bootEtVerifier, preparerLeBoot, boucleOrdonnancement } =
  await import("../../src/vm/boot-de-reference.mjs");
after(() => boucleOrdonnancement.retirer());

const MANIFESTE = { app: { id: "ref" }, runtime: { version: "0.1.0" } };
const M = "20260101000002";
const N = "20260919000001";

/** Un runtime dont l'acquisition échoue : ce que fait une coupure pendant le téléchargement. */
const RUNTIME_INJOIGNABLE = Object.freeze({
  lib: "http://127.0.0.1:9/libv86.mjs",
  wasm: "http://127.0.0.1:9/v86.wasm",
});

test("une acquisition qui échoue n'appelle JAMAIS le crochet : l'intention n'est pas inscrite", async () => {
  let appels = 0;
  await assert.rejects(
    bootEtVerifier({
      phase: "coquille",
      volume: "application",
      manifest: MANIFESTE,
      runtime: RUNTIME_INJOIGNABLE,
      avantLeBoot: async () => {
        appels += 1;
      },
    }),
  );
  assert.equal(appels, 0, "coupé pendant le téléchargement, le coffre ne change pas");
});

test("le crochet est appelé une fois, APRÈS le runtime acquis et AVANT le volume ouvert", async () => {
  const ordre = [];
  const acquis = {
    get V86() {
      ordre.push("runtime-lu");
      return class {};
    },
    artifacts: {},
    empreinteImage: "e",
  };
  const prepare = await preparerLeBoot({
    manifest: MANIFESTE,
    runtimeBundle: acquis,
    avantLeBoot: async () => ordre.push("crochet"),
  });
  ordre.push("prepare-rendu");
  assert.equal(prepare.timeline !== undefined, true);
  // Le runtime est remis en bloc à l'appelant après le crochet : l'ouverture du volume vient ensuite.
  assert.deepEqual(ordre, ["crochet", "runtime-lu", "prepare-rendu"]);
});

test("avantLeBootDuPaquet : rien n'est écrit à la construction ; le crochet inscrit et pose la phase", async () => {
  const ecrits = [];
  const avant = createManifest({
    runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
    app: { id: "ref", version: "1.0.0", schema: M },
    volumeSize: SECTOR_SIZE * 8,
    volume: { id: "0123456789abcdef0123456789abcdef", algorithm: "aes-256-gcm" },
  });
  const prepare = {
    migration: true,
    manifeste: avant,
    descripteur: { application: { id: "ref", version: "1.1.0", schema: N } },
  };
  poserLaPhase(PHASES_DU_BOOT.telechargement);
  const crochet = avantLeBootDuPaquet({
    nom: "application",
    prepare,
    inscrire: async (nom, manifeste) => ecrits.push({ nom, manifeste }),
  });
  assert.equal(ecrits.length, 0, "la construction du crochet n'écrit rien");
  assert.equal(phaseDuBoot(), PHASES_DU_BOOT.telechargement);
  await crochet();
  assert.equal(ecrits.length, 1);
  assert.deepEqual(ecrits[0].manifeste.app.migration, { version: "1.1.0", schema: N });
  assert.equal(phaseDuBoot(), PHASES_DU_BOOT.demarrage);
  poserLaPhase(null);
});

test("le démarrage n'inscrit l'intention QUE par le crochet (cliquet de source)", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../src/coquille/application-de-reference.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(source, /inscrireLIntention\(/, "aucune inscription avant l'acquisition");
  assert.match(source, /avantLeBoot: avantLeBootDuPaquet\(/);
});
