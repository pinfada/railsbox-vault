#!/usr/bin/env node

// Produit un inventaire CycloneDX des dépendances npm verrouillées. Le document porte une date et
// un UUID propres à chaque génération : ses octets ne sont pas reproductibles. Cet inventaire
// couvre l'outillage JavaScript ; il ne prétend pas être le SBOM de l'image Rails ni des artefacts
// vendus, qui restent à produire au moment de la publication finale.
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const racine = fileURLToPath(new URL("../", import.meta.url));
const sortie = resolve(racine, "reports", "supply-chain", "npm.cdx.json");
const npmCli = process.env.npm_execpath;
if (!npmCli) {
  throw new Error("Lancez ce générateur par `npm run security:sbom:npm`.");
}
const resultat = spawnSync(
  process.execPath,
  [
    npmCli,
    "sbom",
    "--sbom-format",
    "cyclonedx",
    "--package-lock-only",
    "--include=dev",
    "--include=optional",
    "--include=peer",
  ],
  {
    cwd: racine,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    shell: false,
    timeout: 60_000,
  },
);

if (resultat.error) throw resultat.error;
if (resultat.status !== 0) {
  process.stderr.write(resultat.stderr);
  process.exit(resultat.status ?? 1);
}

// Relire avant d'écrire empêche de déposer un message ou une sortie partielle sous le nom de SBOM.
const sbom = JSON.parse(resultat.stdout);
if (sbom.bomFormat !== "CycloneDX" || !Array.isArray(sbom.components)) {
  throw new Error("npm n'a pas produit un inventaire CycloneDX exploitable.");
}

// Vérifier l'exhaustivité contre le verrou : un JSON valide mais amputé n'est pas un inventaire.
const verrou = JSON.parse(await readFile(resolve(racine, "package-lock.json"), "utf8"));
if (!verrou.packages || typeof verrou.packages !== "object") {
  throw new Error("Le verrou npm ne décrit pas ses paquets.");
}
const presents = new Set(
  sbom.components.map((c) => `${c.group ? `${c.group}/` : ""}${c.name}@${c.version}`),
);
for (const [chemin, paquet] of Object.entries(verrou.packages)) {
  if (!chemin) continue;
  // Ce dépôt n'utilise ni workspace ni lien : ne pas les omettre silencieusement s'ils apparaissent.
  if (paquet.link || !paquet.version || !chemin.includes("node_modules/")) {
    throw new Error(`Entrée du verrou non prise en charge : ${chemin}`);
  }
  const nom = paquet.name ?? chemin.split("node_modules/").at(-1);
  if (!presents.has(`${nom}@${paquet.version}`)) {
    throw new Error(`SBOM incomplet : ${nom}@${paquet.version} absent.`);
  }
}

await mkdir(dirname(sortie), { recursive: true });
await writeFile(sortie, `${JSON.stringify(sbom, null, 2)}\n`, "utf8");
process.stdout.write(`Inventaire npm CycloneDX : ${sortie}\n`);
