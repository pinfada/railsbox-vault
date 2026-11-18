#!/usr/bin/env node
// Synthèse des sorties brutes : une table `épreuve × moteur` (dernier résultat daté de chaque couple).
//   node tools/spike-sw-coquille/synthese.mjs [dossier-de-sorties]
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dossier = resolve(process.argv[2] ?? join(dirname(fileURLToPath(import.meta.url)), "sorties"));
const dernier = new Map();
const versions = {};
for (const nom of readdirSync(dossier).filter((n) => n.endsWith(".json")).sort()) {
  const rapport = JSON.parse(readFileSync(join(dossier, nom), "utf8"));
  Object.assign(versions, rapport.moteurs);
  for (const r of rapport.resultats) dernier.set(`${r.id}|${r.moteur}`, { ...r, fichier: nom, horodatage: rapport.horodatage });
}
const ids = [...new Set([...dernier.values()].map((r) => r.id))].sort((a, b) => a.localeCompare(b, "fr", { numeric: true }));
const moteurs = ["chromium", "firefox", "webkit"];
process.stdout.write(`Moteurs : ${moteurs.map((m) => `${m} ${versions[m] ?? "?"}`).join(", ")}\n\n| Épreuve | ${moteurs.join(" | ")} |\n| --- | --- | --- | --- |\n`);
let ok = 0;
let total = 0;
for (const id of ids) {
  const cellules = moteurs.map((m) => {
    const r = dernier.get(`${id}|${m}`);
    if (!r) return "—";
    total += 1;
    if (r.ok) ok += 1;
    return r.ok ? "✓" : "✗";
  });
  process.stdout.write(`| ${id} | ${cellules.join(" | ")} |\n`);
}
process.stdout.write(`\n${ok}/${total} couples épreuve×moteur au vert.\n`);
