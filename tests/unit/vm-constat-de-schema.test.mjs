/**
 * Le CONSTAT DE SCHÉMA que le guest imprime avant Rails (#236 T2, ADR 0042) : ce que le Worker en lit,
 * et le REFUS qui arrête le boot sans attendre une santé qui ne viendra jamais.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { MOTIFS_DE_SCHEMA, creerVeilleurDeSchema } from "../../src/vm/constat-de-schema.mjs";

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

test("un marqueur absent se relit null, et une ligne interminable ne grossit pas sans borne", () => {
  const veilleur = creerVeilleurDeSchema();
  veilleur.ingererSerie("x".repeat(100_000));
  veilleur.ingererSerie(`\n[schema] volume=absent paquet=${N} attendu=absent intention=${N}\n`);
  assert.equal(veilleur.constat().volume, null);
  assert.equal(veilleur.constat().intention, N);
});
