// Mesure le boot à froid de l'image de référence : durée jusqu'à la route de
// santé et pic de mémoire du processus hôte, sur plusieurs essais.
//
// `docs/quality-attributes.md` exige qu'une mesure publie machine, navigateur,
// volume, nombre d'essais et percentile — une moyenne seule ne suffit pas. Ce
// script produit donc p50 et p95, et écrit l'environnement avec les chiffres.
//
//   node tools/vm/mesurer-boot.mjs [--essais=3]
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { validerManifeste } from "../build-reference-image/manifest-contract.mjs";
import {
  CHEMIN_MANIFESTE,
  RACINE_DEPOT,
  demarrerVm,
  pause,
  raisonDIndisponibilite,
} from "./boot-reference.mjs";

const DOSSIER_RAPPORTS = join(RACINE_DEPOT, "reports", "vm");
const BUDGET_MS = Number.parseInt(process.env.VAULT_VM_BUDGET_MS ?? "1200000", 10);

/**
 * @param {number[]} valeurs
 * @param {number} centile
 * @returns {number}
 */
export function percentile(valeurs, centile) {
  if (valeurs.length === 0) throw new Error("aucune valeur à résumer");
  const triees = [...valeurs].sort((gauche, droite) => gauche - droite);
  // Méthode du plus proche rang : avec trois essais, p95 est la valeur la plus
  // haute. C'est volontairement conservateur, et ce que le petit nombre
  // d'essais permet d'affirmer honnêtement.
  const rang = Math.ceil((centile / 100) * triees.length);
  return triees[Math.min(rang, triees.length) - 1];
}

async function principal() {
  const essais = Number.parseInt(
    process.argv.find((argument) => argument.startsWith("--essais="))?.slice(9) ?? "3",
    10,
  );
  if (!Number.isInteger(essais) || essais < 1) {
    console.error("nombre d'essais invalide");
    process.exit(64);
  }

  const raison = raisonDIndisponibilite();
  if (raison !== null) {
    console.error(`mesure impossible : ${raison}`);
    process.exit(1);
  }

  const manifeste = JSON.parse(await readFile(CHEMIN_MANIFESTE, "utf8"));
  const anomalies = validerManifeste(manifeste);
  if (anomalies.length > 0) {
    console.error(`manifeste invalide :\n${anomalies.map((a) => `  · ${a.message}`).join("\n")}`);
    process.exit(1);
  }

  const releves = [];
  for (let essai = 1; essai <= essais; essai += 1) {
    const rssAvant = process.memoryUsage().rss;
    let rssPic = rssAvant;
    const surveillance = setInterval(() => {
      rssPic = Math.max(rssPic, process.memoryUsage().rss);
    }, 500);

    const vm = await demarrerVm({ manifeste });
    try {
      const { dureeMs, sante } = await vm.attendreSante({ delaiTotalMs: BUDGET_MS });
      const reponse = await vm.requete("GET", "/vault/invariant");
      const verdict = JSON.parse(new TextDecoder().decode(reponse.corps));
      if (reponse.statut !== 200 || verdict.status !== "conforming") {
        throw new Error(`invariant non conforme à l'essai ${essai} : ${verdict.status}`);
      }
      releves.push({
        essai,
        bootFroidMs: dureeMs,
        rssPicOctets: rssPic,
        rssAvantOctets: rssAvant,
        rails: sante.rails,
      });
      console.log(
        `essai ${essai}/${essais} : ${Math.round(dureeMs / 1000)} s, ` +
          `pic RSS ${(rssPic / 1024 / 1024).toFixed(0)} Mio`,
      );
    } finally {
      clearInterval(surveillance);
      await vm.arreter();
    }
    // Laisse le ramasse-miettes libérer la mémoire de l'émulateur précédent :
    // sans cette pause, le pic du second essai inclut le premier.
    await pause(5_000);
  }

  const durees = releves.map((releve) => releve.bootFroidMs);
  const pics = releves.map((releve) => releve.rssPicOctets);
  const rapport = {
    mesureLe: new Date().toISOString(),
    environnement: {
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      cpus: (await import("node:os")).cpus().length,
      memoireTotaleOctets: (await import("node:os")).totalmem(),
    },
    manifeste: {
      generatedAt: manifeste.generatedAt,
      totalByteSize: manifeste.totals.byteSize,
      memoireVmMiB: manifeste.boot.memoryMiB,
    },
    essais: releves,
    resume: {
      nombreDEssais: releves.length,
      bootFroidP50Ms: percentile(durees, 50),
      bootFroidP95Ms: percentile(durees, 95),
      rssPicP50Octets: percentile(pics, 50),
      rssPicP95Octets: percentile(pics, 95),
    },
  };

  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  const chemin = join(DOSSIER_RAPPORTS, "mesures-boot.json");
  writeFileSync(chemin, `${JSON.stringify(rapport, null, 2)}\n`, "utf8");

  console.log(
    `\np50 ${Math.round(rapport.resume.bootFroidP50Ms / 1000)} s · p95 ${Math.round(rapport.resume.bootFroidP95Ms / 1000)} s`,
  );
  console.log(
    `pic RSS p95 ${(rapport.resume.rssPicP95Octets / 1024 / 1024).toFixed(0)} Mio — rapport : ${chemin}`,
  );
}

principal().catch((erreur) => {
  console.error(erreur instanceof Error ? erreur.message : String(erreur));
  process.exit(1);
});
