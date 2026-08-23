// Exécute la suite Minitest de l'application Rails de référence dans une image
// Docker épinglée par digest.
//
// Pourquoi Docker et pas le Ruby de la machine : la fixture promet Ruby 3.3.12
// et un `Gemfile.lock` résolu pour la plateforme `ruby`. Un Ruby local d'une
// autre version, ou une gemme native précompilée pour une autre plateforme,
// ferait passer des tests qui échoueraient dans la VM.
//
// Ce que cette suite NE prouve PAS : le comportement sous i386. L'image de test
// est amd64 pour rester en minutes ; seul `npm run test:vm` exerce le guest réel.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const racineDepot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dossierApplication = join(racineDepot, "apps", "reference");
const dockerfile = join(racineDepot, "tools", "build-reference-image", "app-test.Dockerfile");
const etiquette = "railsbox-vault-reference-test:local";

/**
 * @param {string[]} arguments_
 * @param {string} etape
 */
function docker(arguments_, etape) {
  const resultat = spawnSync("docker", arguments_, { stdio: "inherit" });
  if (resultat.error) {
    console.error(
      `Docker est indisponible (${etape}) : ${resultat.error.message}\n` +
        "Voir docs/development.md, section « Application Rails de référence ».",
    );
    process.exit(127);
  }
  if (resultat.status !== 0) {
    process.exit(resultat.status ?? 1);
  }
}

docker(
  [
    "build",
    "--platform",
    "linux/amd64",
    "-f",
    dockerfile,
    "-t",
    etiquette,
    dossierApplication,
  ],
  "construction de l'image de test",
);

const commande = process.argv.slice(2);
docker(
  [
    "run",
    "--rm",
    "--platform",
    "linux/amd64",
    "-v",
    `${dossierApplication}:/application`,
    "-w",
    "/application",
    etiquette,
    ...(commande.length > 0 ? commande : ["bundle", "exec", "ruby", "bin/rails", "test"]),
  ],
  "exécution de la suite",
);
