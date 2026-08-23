// Vérificateur d'épinglage : refuse la construction si un artefact n'est pas
// épinglé ou si un secret est requis. Appelé par `npm run image:build` avant le
// premier `docker build`, et exécutable seul.
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { analyserDockerfile, analyserSources, digestsDeclares } from "./pinning-contract.mjs";

const dossier = dirname(fileURLToPath(import.meta.url));
const racineDepot = resolve(dossier, "..", "..");

/**
 * @returns {{ anomalies: import("./pinning-contract.mjs").Anomalie[], fichiers: string[] }}
 */
export function verifierEpinglage() {
  const sources = JSON.parse(readFileSync(join(dossier, "sources.json"), "utf8"));
  const digestsConnus = digestsDeclares(sources);

  const anomalies = analyserSources(sources).map((anomalie) => ({
    ...anomalie,
    message: `sources.json : ${anomalie.message}`,
  }));

  const fichiers = readdirSync(dossier)
    .filter((nom) => nom.endsWith(".Dockerfile"))
    .sort();

  if (fichiers.length === 0) {
    anomalies.push({
      code: "aucun-dockerfile",
      ligne: 0,
      message: "aucun Dockerfile trouvé : la vérification n'aurait rien prouvé",
    });
  }

  for (const nom of fichiers) {
    const texte = readFileSync(join(dossier, nom), "utf8");
    for (const anomalie of analyserDockerfile(texte, { digestsConnus })) {
      anomalies.push({ ...anomalie, message: `${nom}:${anomalie.ligne} : ${anomalie.message}` });
    }
  }

  // Un secret peut aussi entrer par l'arbre de l'application plutôt que par le
  // Dockerfile ; la fixture doit rester sans clé maîtresse.
  for (const relatif of [
    "apps/reference/config/master.key",
    "apps/reference/config/credentials.yml.enc",
  ]) {
    try {
      readFileSync(join(racineDepot, relatif));
      anomalies.push({
        code: "secret-commite",
        ligne: 0,
        message: `${relatif} existe : l'application de référence doit rester sans secret`,
      });
    } catch {
      // Absent : c'est l'état attendu.
    }
  }

  return { anomalies, fichiers };
}

const executeDirectement =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (executeDirectement) {
  const { anomalies, fichiers } = verifierEpinglage();
  if (anomalies.length > 0) {
    console.error("Épinglage refusé :");
    for (const anomalie of anomalies) console.error(`  · [${anomalie.code}] ${anomalie.message}`);
    process.exit(1);
  }
  console.log(`Épinglage vérifié : ${fichiers.length} Dockerfile(s), sources.json conforme.`);
}
