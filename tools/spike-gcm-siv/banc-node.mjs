/**
 * Banc du spike #185 sous Node.
 *
 *     node tools/spike-gcm-siv/banc-node.mjs [--essais=400]
 *
 * Node n'est PAS le moteur qui décide : l'ADR 0015 a mesuré qu'il est ~2,8 fois plus lent par appel
 * à `crypto.subtle` que Chromium, et le verdict du spike se prend sur le banc navigateur. Celui-ci
 * sert de contrôle — il tourne sans Playwright, il est reproductible en une commande, et l'écart
 * entre les deux dit si une dérive vient du moteur ou du code.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { arch, cpus, platform, release } from "node:os";
import { fileURLToPath } from "node:url";

import { mesurer } from "./banc-commun.mjs";
import { chargerCandidate } from "./candidate/charger.mjs";
import { RACINE_CANDIDATE } from "./candidate/emplacement.mjs";

const dossierDeRapport = fileURLToPath(new URL("../../reports/spike-gcm-siv/", import.meta.url));

function lireEssais() {
  const argument = process.argv.slice(2).find((valeur) => valeur.startsWith("--essais="));
  return argument ? Number.parseInt(argument.slice("--essais=".length), 10) : 7;
}

async function candidatePourLeBanc() {
  const chargee = await chargerCandidate();
  if (!chargee.disponible) return { module: null, identite: null, raison: chargee.raison };
  const module = await import(
    new URL("aes.js", `file:///${RACINE_CANDIDATE.replaceAll("\\", "/")}`).href
  );
  return { module, identite: chargee.identite, raison: null };
}

const { module, identite, raison } = await candidatePourLeBanc();
const mesure = await mesurer({ essais: lireEssais(), candidate: module });

const rapport = {
  contrat: { id: "railsbox-vault-spike-gcm-siv-banc", version: 1 },
  moteur: `node ${process.version}`,
  machine: {
    plateforme: platform(),
    version: release(),
    architecture: arch(),
    processeur: cpus()[0]?.model ?? "inconnu",
    coeurs: cpus().length,
  },
  releveLe: new Date().toISOString(),
  ...mesure,
  candidate: identite ?? `absente (${raison})`,
};

await mkdir(dossierDeRapport, { recursive: true });
await writeFile(
  `${dossierDeRapport}banc-node.json`,
  `${JSON.stringify(rapport, null, 2)}\n`,
  "utf8",
);

console.log(`moteur : ${rapport.moteur} — candidate : ${rapport.candidate}`);
console.log(
  `appels à crypto.subtle par scellement SIV composé : ${mesure.appelsSubtleParScellementSiv}`,
);
for (const serie of mesure.series) {
  console.log(
    `${serie.nom.padEnd(26)} médiane ${serie.mediane.toFixed(1).padStart(8)} µs/scellement   étendue ${(serie.etendueRelative * 100).toFixed(0)} %`,
  );
}
console.log(`rapport : reports/spike-gcm-siv/banc-node.json`);
