#!/usr/bin/env node
// SPIKE D1h — rejoue les épreuves du Service Worker de la coquille (#299, révision du défi C-K).
//
//   node tools/spike-sw-coquille/rejouer.mjs [--moteurs=chromium,firefox,webkit] [--epreuves=S1,A1,G*]
//                                           [--sortie=docs/mesures/spike-sw-coquille-d1h] [--json]
//
// Prérequis : `npm ci`, `npx playwright install chromium firefox webkit`, `npm run vm:fetch`, et
// l'arbre publié : voir README.md (commande `tools/publier.mjs` exacte, ports 4293/4294).
// Sortie brute : un JSON daté par exécution (versions de moteur, assertions, mesures).

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";

import { Epreuve, MOTEURS } from "./banc/cadre.mjs";

const ICI = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const option = (nom, defaut) =>
  argv
    .find((a) => a.startsWith(`--${nom}=`))
    ?.split("=")
    .slice(1)
    .join("=") ?? defaut;
const moteurs = option("moteurs", "chromium,firefox,webkit").split(",").filter(Boolean);
const filtre = option("epreuves", "*").split(",");
const dossierSortie = resolve(
  option("sortie", join(ICI, "../../docs/mesures/spike-sw-coquille-d1h")),
);

const groupes = ["s", "a", "f", "g", "d", "r", "p", "l", "m", "b"];
const toutes = [];
for (const g of groupes) {
  try {
    const module = await import(`./epreuves/${g}.mjs`);
    toutes.push(...module.epreuves);
  } catch (erreur) {
    if (
      erreur?.code !== "ERR_MODULE_NOT_FOUND" ||
      !String(erreur.message).includes(`epreuves/${g}.mjs`)
    )
      throw erreur;
  }
}
const correspond = (id) =>
  filtre.some((f) =>
    f === "*" ? true : f.endsWith("*") ? id.startsWith(f.slice(0, -1)) : id === f,
  );
const aJouer = toutes.filter((e) => correspond(e.id));

const resultats = [];
const versions = {};
for (const nom of moteurs) {
  for (const epreuve of aJouer) {
    if (epreuve.moteurs && !epreuve.moteurs.includes(nom)) continue;
    // UN NAVIGATEUR PAR ÉPREUVE : Firefox gardait un état de connexion après un serveur arrêté et
    // laissait les épreuves suivantes en délai (mesuré). Le coût est de l'ordre de la seconde.
    const navigateur = await MOTEURS[nom].launch({ headless: true });
    versions[nom] = navigateur.version();
    const t = new Epreuve({ moteur: nom, nom: epreuve.id, navigateur, versions });
    const debut = Date.now();
    let erreur = null;
    try {
      await Promise.race([
        epreuve.run(t),
        new Promise((_, ko) =>
          setTimeout(
            () => ko(new Error(`délai d'épreuve dépassé (${epreuve.delaiMs ?? 120000} ms)`)),
            epreuve.delaiMs ?? 120000,
          ),
        ),
      ]);
    } catch (e) {
      erreur = String(e?.stack ?? e)
        .split("\n")
        .slice(0, 4)
        .join(" | ");
    }
    await t.nettoyer();
    const ok = erreur === null && t.assertions.length > 0 && t.assertions.every((a) => a.ok);
    resultats.push({
      id: epreuve.id,
      titre: epreuve.titre,
      moteur: nom,
      ok,
      ms: Date.now() - debut,
      erreur,
      assertions: t.assertions,
      mesures: t.mesures,
      notes: t.notes,
    });
    process.stdout.write(
      `${ok ? "OK  " : "ÉCHEC"} ${epreuve.id.padEnd(6)} ${nom.padEnd(8)} ${String(Date.now() - debut).padStart(6)} ms  ${epreuve.titre}\n`,
    );
    if (!ok) {
      for (const a of t.assertions.filter((x) => !x.ok))
        process.stdout.write(`        ✗ ${a.message}\n`);
      if (erreur) process.stdout.write(`        ! ${erreur}\n`);
    }
    await navigateur.close().catch(() => {});
  }
}

const horodatage = new Date().toISOString();
const rapport = {
  contrat: "spike-sw-coquille-d1h/1",
  horodatage,
  machine: {
    plateforme: `${os.platform()} ${os.arch()}`,
    noyau: os.release(),
    node: process.version,
  },
  moteurs: versions,
  filtre,
  total: resultats.length,
  ok: resultats.filter((r) => r.ok).length,
  resultats,
};
mkdirSync(dossierSortie, { recursive: true });
const nom = `${horodatage.slice(0, 10)}-${moteurs.join("+")}-${filtre.join("+").replace(/\*/g, "tout")}.json`;
writeFileSync(join(dossierSortie, nom), JSON.stringify(rapport, null, 2) + "\n");
process.stdout.write(
  `\n${rapport.ok}/${rapport.total} épreuves ok — ${join(dossierSortie, nom)}\n`,
);
process.exit(rapport.ok === rapport.total ? 0 : 1);
