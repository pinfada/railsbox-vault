/**
 * Le CONSTAT DE SCHÉMA que le guest imprime avant Rails (#236 T2, ADR 0042) : ce que le Worker en lit,
 * et le REFUS qui arrête le boot sans attendre une santé qui ne viendra jamais.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MOTIFS_DE_SCHEMA, creerVeilleurDeSchema } from "../../src/vm/constat-de-schema.mjs";
import { PHASES_DU_BOOT, phaseDuBoot, poserLaPhase } from "../../src/vm/phase-du-boot.mjs";

const M = "20260101000002";
const N = "20260919000002";

test("aucune ligne [schema] : aucun constat (reprise par instantané, image d'avant T2)", () => {
  const veilleur = creerVeilleurDeSchema();
  veilleur.ingererSerie("[init] montage du paquet applicatif\n[init] pont serie actif\n");
  assert.equal(veilleur.constat(), null);
});

test("une migration jouée : de, vers, durée, et chaque migration commise, en fragments quelconques", () => {
  const veilleur = creerVeilleurDeSchema();
  const serie =
    `[schema] volume=${M} paquet=${N} attendu=${M} intention=absent\r\n` +
    `[schema] rails : == 20260919000001 AjouterUneNote: migrating ====\n` +
    `[schema] rails : == 20260919000001 AjouterUneNote: migrated (0.0213s) ====\n` +
    `[schema] rails : == ${N} IndexerLesNotes: migrated (0.0100s) ====\n` +
    `[schema] migration jouee de=${M} vers=${N} ms=41234\n`;
  for (let debut = 0; debut < serie.length; debut += 7) {
    veilleur.ingererSerie(serie.slice(debut, debut + 7));
  }
  assert.deepEqual(veilleur.constat(), {
    volume: M,
    paquet: N,
    attendu: M,
    intention: null,
    refus: null,
    commises: ["20260919000001", N],
    migration: { jouee: true, de: M, vers: N, ms: 41234 },
  });
});

test("rien à migrer : le constat le dit, sans migration jouée", () => {
  const veilleur = creerVeilleurDeSchema();
  veilleur.ingererSerie(`[schema] volume=${N} paquet=${N} attendu=${N} intention=absent\n`);
  veilleur.ingererSerie(`[schema] migration aucune schema=${N}\n`);
  assert.deepEqual(veilleur.constat().migration, { jouee: false, schema: N });
});

test("un REFUS rejette la promesse avec son motif, et le constat le retient", async () => {
  for (const [ligne, motif] of [
    [`[schema] REFUS anterieur volume=${N} paquet=${M}`, MOTIFS_DE_SCHEMA.anterieur],
    [`[schema] REFUS divergent volume=${M} paquet=${N} attendu=${N}`, MOTIFS_DE_SCHEMA.divergent],
    [
      `[schema] REFUS migration-echouee de=${M} vers=${N} code=1`,
      MOTIFS_DE_SCHEMA.migrationEchouee,
    ],
    ["[schema] REFUS nimporte volume=1", "inconnu"],
  ]) {
    const veilleur = creerVeilleurDeSchema();
    veilleur.ingererSerie(`${ligne}\n`);
    await assert.rejects(veilleur.refus, (erreur) => erreur.motifDeSchema === motif);
    assert.equal(veilleur.constat().refus, motif);
  }
});

test("une ligne série privée de son crochet initial se lit encore, une autre tête non (PR #263)", () => {
  // Run 37075639310 : la série du guest arrive hachée, et la ligne décisive est arrivée sans son
  // `[` — `migration` restait null, et `migration-coupee` tombait sur `migration?.jouee`.
  const veilleur = creerVeilleurDeSchema();
  poserLaPhase(null);
  veilleur.ingererSerie(`[schema] volume=${M} paquet=${M} attendu=${M} intention=${N}\n`);
  veilleur.ingererSerie(`schema] migration jouee de=${M} vers=${N} ms=30427\r\n`);
  assert.deepEqual(veilleur.constat().migration, { jouee: true, de: M, vers: N, ms: 30427 });
  // La phase que la page affiche passe elle aussi à « démarrage ».
  assert.equal(phaseDuBoot(), PHASES_DU_BOOT.demarrage);
  poserLaPhase(null);

  // Pas n'importe quoi : un autre préfixe, ou un `schema]` au milieu d'une ligne, ne compte pas.
  for (const ligne of [
    `xschema] migration aucune schema=${N}`,
    `chema] migration aucune schema=${N}`,
    `@VLT1 schema] migration aucune schema=${N}`,
    `[schema]migration aucune schema=${N}`,
  ]) {
    veilleur.ingererSerie(`${ligne}\n`);
    assert.equal(veilleur.constat().migration.jouee, true, ligne);
  }
});

test("un REFUS privé de son crochet initial rejette encore la promesse", async () => {
  const veilleur = creerVeilleurDeSchema();
  veilleur.ingererSerie(`schema] REFUS anterieur volume=${M} paquet=${M} intention=${N}\n`);
  assert.equal(veilleur.constat()?.refus, MOTIFS_DE_SCHEMA.anterieur);
  await assert.rejects(
    veilleur.refus,
    (erreur) => erreur.motifDeSchema === MOTIFS_DE_SCHEMA.anterieur,
  );
});

test("un marqueur absent se relit null, et une ligne interminable ne grossit pas sans borne", () => {
  const veilleur = creerVeilleurDeSchema();
  veilleur.ingererSerie("x".repeat(100_000));
  veilleur.ingererSerie(`\n[schema] volume=absent paquet=${N} attendu=absent intention=${N}\n`);
  assert.equal(veilleur.constat().volume, null);
  assert.equal(veilleur.constat().intention, N);
});
