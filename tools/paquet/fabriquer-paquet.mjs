// FABRIQUE un paquet applicatif depuis un dossier Rails — dans le dépôt ou hors du dépôt (#236).
//
//   npm run app:paquet -- --source <dossier> [--id <id>] [--version <x.y.z>] [--taille-donnees=<Mio>]
//
// Sans `--source`, la source est `apps/reference` : l'application de référence devient le PREMIER
// paquet, et rien ne la distingue d'une application tierce hormis son `bin/vault-fixture`.
//
// ## Un dossier HORS du dépôt n'est jamais copié dans l'arbre
//
// Il entre par un CONTEXTE DE CONSTRUCTION NOMMÉ de BuildKit (`--build-context application=<dossier>`)
// que le Dockerfile lit par `COPY --from=application`. Le contexte principal reste la racine du
// dépôt — donc l'épinglage, les scripts du guest et `.dockerignore` restent ceux du dépôt —, et
// aucun fichier de l'application n'est recopié sous `apps/`.
//
// ## Ce que la fabrication REFUSE
//
//  - un secret Rails dans la source (`config/master.key`, `config/credentials.yml.enc`, …) : le
//    `secret_key_base` d'un paquet se dérive d'une chaîne publique, comme celui de la référence ;
//  - une identité absente ou mal formée : sans `id` et `version`, rien ne nomme le paquet ;
//  - une application sans migration : sa graine serait une base dont rien ne dit ce qu'elle porte.
//
// Elle dépose dans `artifacts/reference-image/` : les deux images, nommées par leur empreinte, et
// `paquet.json`, le contrat que le manifeste d'image relit ensuite.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { construirePaquet, nomDImage, validerPaquet } from "./contrat-du-paquet.mjs";
import {
  identiteDeLApplication,
  secretsPresents,
  SECRETS_REFUSES,
} from "./identite-de-l-application.mjs";
import { schemaDeLApplication } from "./schema-de-l-application.mjs";

const dossierOutils = dirname(fileURLToPath(import.meta.url));
export const RACINE_DEPOT = resolve(dossierOutils, "..", "..");
const DOSSIER_ARTEFACTS = join(RACINE_DEPOT, "artifacts", "reference-image");
const SOURCES = JSON.parse(
  readFileSync(join(RACINE_DEPOT, "tools", "build-reference-image", "sources.json"), "utf8"),
);

const ETIQUETTE_PAQUET = "railsbox-vault-paquet:local";
const ETIQUETTE_FABRICANT = "railsbox-vault-diskbuilder:local";

/**
 * @param {string[]} arguments_
 * @returns {{ source: string, id: string | null, version: string | null, tailleDonnees: number }}
 */
export function analyserArguments(arguments_) {
  let source = join(RACINE_DEPOT, "apps", "reference");
  let id = null;
  let version = null;
  let tailleDonnees = SOURCES.disk.appDiskMiB;

  for (let rang = 0; rang < arguments_.length; rang += 1) {
    const argument = arguments_[rang];
    const valeurCollee = (prefixe) =>
      argument.startsWith(prefixe) ? argument.slice(prefixe.length) : null;
    if (argument === "--source") source = arguments_[++rang];
    else if (valeurCollee("--source=") !== null) source = valeurCollee("--source=");
    else if (argument === "--id") id = arguments_[++rang];
    else if (valeurCollee("--id=") !== null) id = valeurCollee("--id=");
    else if (argument === "--version") version = arguments_[++rang];
    else if (valeurCollee("--version=") !== null) version = valeurCollee("--version=");
    else if (valeurCollee("--taille-donnees=") !== null) {
      tailleDonnees = Number.parseInt(valeurCollee("--taille-donnees="), 10);
    } else if (argument === "--taille-donnees") {
      tailleDonnees = Number.parseInt(arguments_[++rang], 10);
    } else {
      throw new Error(`option inconnue : ${argument}`);
    }
  }
  if (!Number.isInteger(tailleDonnees) || tailleDonnees < 64) {
    throw new Error(`taille du disque de données invalide : ${tailleDonnees} Mio`);
  }
  return { source: resolve(source), id, version, tailleDonnees };
}

/** Liste les fichiers de la source, en chemins relatifs à barres obliques, sans descendre inutilement. */
function fichiersDeLaSource(source) {
  const trouves = [];
  const ignores = new Set(["node_modules", ".git", "tmp", "log", "vendor", "var"]);
  const parcourir = (dossier, prefixe) => {
    for (const entree of readdirSync(dossier, { withFileTypes: true })) {
      const relatif = prefixe === "" ? entree.name : `${prefixe}/${entree.name}`;
      if (entree.isDirectory()) {
        if (ignores.has(entree.name)) continue;
        parcourir(join(dossier, entree.name), relatif);
      } else {
        trouves.push(relatif);
      }
    }
  };
  parcourir(source, "");
  return trouves;
}

/** LIT ce que la source déclare d'elle-même : `vault-app.json`, puis `vault-invariant.json`. */
function declarationsDeLaSource(source) {
  const lire = (nom) => {
    const chemin = join(source, nom);
    return existsSync(chemin) ? JSON.parse(readFileSync(chemin, "utf8")) : null;
  };
  return { vaultApp: lire("vault-app.json"), invariant: lire("vault-invariant.json") };
}

/** CONTRÔLE la source AVANT le premier `docker build` : secrets, identité, schéma. */
export function examinerLaSource(source, options) {
  if (!existsSync(join(source, "Gemfile"))) {
    throw new Error(
      `Source refusée : ${source} n'a pas de Gemfile — ce n'est pas une application Rails.`,
    );
  }
  const fichiers = fichiersDeLaSource(source);
  const secrets = secretsPresents(fichiers);
  if (secrets.length > 0) {
    throw new Error(
      `Source refusée : elle porte ${secrets.join(", ")}. Un paquet ne contient AUCUN secret ` +
        `(${SECRETS_REFUSES.join(", ")}) ; le secret_key_base se dérive d'une chaîne publique.`,
    );
  }
  const { vaultApp, invariant } = declarationsDeLaSource(source);
  const identite = identiteDeLApplication({ options, vaultApp, invariant });
  const cheminSchema = join(source, "db", "schema.rb");
  const migrations = existsSync(join(source, "db", "migrate"))
    ? readdirSync(join(source, "db", "migrate"))
    : [];
  const schema = schemaDeLApplication({
    schemaRb: existsSync(cheminSchema) ? readFileSync(cheminSchema, "utf8") : null,
    migrations,
  });
  return { ...identite, schema };
}

/** @param {string} etape @param {string[]} arguments_ */
function docker(etape, arguments_) {
  const resultat = spawnSync("docker", arguments_, { stdio: "inherit", cwd: RACINE_DEPOT });
  if (resultat.error)
    throw new Error(`Docker est indisponible (${etape}) : ${resultat.error.message}`);
  if (resultat.status !== 0)
    throw new Error(`échec de l'étape « ${etape} » (code ${resultat.status})`);
}

/** Exporte l'image du paquet et fabrique les deux systèmes de fichiers, en flux. */
function fabriquerLesImages({ tailleDonnees }) {
  return new Promise((resoudre, rejeter) => {
    const creation = spawnSync("docker", ["create", "--platform", "linux/386", ETIQUETTE_PAQUET], {
      encoding: "utf8",
    });
    if (creation.status !== 0) {
      rejeter(new Error(`docker create a échoué : ${creation.stderr}`));
      return;
    }
    const conteneur = creation.stdout.trim();
    const exportation = spawn("docker", ["export", conteneur], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    const fabrication = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "-v",
        `${DOSSIER_ARTEFACTS}:/sortie`,
        "-e",
        `BLOC=${SOURCES.disk.blockSize}`,
        "--entrypoint",
        "/usr/local/bin/fabriquer-paquet",
        ETIQUETTE_FABRICANT,
        String(tailleDonnees),
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );
    exportation.stdout.pipe(fabrication.stdin);
    fabrication.on("close", (code) => {
      spawnSync("docker", ["rm", "-f", conteneur], { stdio: "ignore" });
      if (code === 0) resoudre();
      else rejeter(new Error(`fabrication des images du paquet échouée (code ${code})`));
    });
    fabrication.on("error", rejeter);
  });
}

/** Empreinte et taille d'un fichier. */
function mesurer(chemin) {
  return {
    byteSize: statSync(chemin).size,
    sha256: createHash("sha256").update(readFileSync(chemin)).digest("hex"),
  };
}

/** RENOMME une image fabriquée sous le nom qui porte son empreinte, et retire les anciennes. */
function nommerParEmpreinte(fichierTemporaire, { id, version, suffixe }) {
  const mesure = mesurer(join(DOSSIER_ARTEFACTS, fichierTemporaire));
  const nom = nomDImage({ id, version, sha256: mesure.sha256, suffixe });
  // Les images d'une fabrication PRÉCÉDENTE du même id sont retirées : elles ne sont plus citées
  // par aucun manifeste, et `publier` publierait sinon un artefact que rien ne réclame.
  const motif = new RegExp(`^${id}-.*${suffixe === "" ? "" : `${suffixe}-`}[0-9a-f]{8}\\.ext4$`);
  for (const ancien of readdirSync(DOSSIER_ARTEFACTS)) {
    if (ancien !== nom && motif.test(ancien) && estDuMemeRole(ancien, suffixe, id)) {
      rmSync(join(DOSSIER_ARTEFACTS, ancien));
    }
  }
  renameSync(join(DOSSIER_ARTEFACTS, fichierTemporaire), join(DOSSIER_ARTEFACTS, nom));
  return { name: nom, ...mesure };
}

/** Distingue une image de CODE d'une GRAINE : leurs noms ne diffèrent que par ce segment. */
function estDuMemeRole(nom, suffixe, id) {
  const porteGraine = nom.startsWith(`${id}-`) && nom.includes("-graine-");
  return suffixe === "graine" ? porteGraine : !porteGraine;
}

/**
 * FABRIQUE le paquet et rend son contrat.
 *
 * @param {string[]} arguments_
 */
export async function fabriquerLePaquet(arguments_) {
  const options = analyserArguments(arguments_);
  const identite = examinerLaSource(options.source, { id: options.id, version: options.version });
  console.log(
    `→ source : ${options.source}\n→ identité : ${identite.id} ${identite.version}, schéma ${identite.schema}`,
  );
  mkdirSync(DOSSIER_ARTEFACTS, { recursive: true });

  docker("image du fabricant de systèmes de fichiers", [
    "build",
    "-f",
    "tools/build-reference-image/diskbuilder.Dockerfile",
    "-t",
    ETIQUETTE_FABRICANT,
    ".",
  ]);
  docker("construction du paquet applicatif", [
    "build",
    "--platform",
    "linux/386",
    "-f",
    "tools/build-reference-image/guest.Dockerfile",
    "--target",
    "disque-app",
    // Le contexte NOMMÉ : la source entre ici, et nulle part ailleurs.
    "--build-context",
    `application=${options.source}`,
    "--build-arg",
    `SCHEMA_DE_L_APPLICATION=${identite.schema}`,
    "-t",
    ETIQUETTE_PAQUET,
    ".",
  ]);

  const debut = Date.now();
  await fabriquerLesImages({ tailleDonnees: options.tailleDonnees });
  const image = nommerParEmpreinte("paquet.ext4", { ...identite, suffixe: "" });
  const graine = nommerParEmpreinte("graine.ext4", { ...identite, suffixe: "graine" });

  const verrou = readFileSync(join(options.source, "Gemfile.lock"), "utf8");
  const rails = verrou.match(/^\s+railties \(([^)]+)\)/m)?.[1];
  if (rails === undefined) {
    throw new Error(`version de Rails introuvable dans ${options.source}/Gemfile.lock`);
  }
  const paquet = construirePaquet({
    application: { id: identite.id, version: identite.version, schema: identite.schema },
    image,
    graine: { ...graine, disqueOctets: options.tailleDonnees * 1024 * 1024 },
    exigences: { ruby: SOURCES.ruby.version, rails, debianSuite: SOURCES.debian.suite },
    secretKeyBase: identite.secretKeyBase,
    licence: "MIT (RailsBox Vault) ; gemmes selon le Gemfile.lock de l'application",
    genereLe: new Date().toISOString(),
  });
  const anomalies = validerPaquet(paquet);
  if (anomalies.length > 0) {
    throw new Error(
      `contrat de paquet refusé :\n${anomalies.map((a) => `  · [${a.code}] ${a.message}`).join("\n")}`,
    );
  }
  writeFileSync(
    join(DOSSIER_ARTEFACTS, "paquet.json"),
    `${JSON.stringify(paquet, null, 2)}\n`,
    "utf8",
  );
  const mio = (octets) => (octets / 1024 / 1024).toFixed(1);
  console.log(
    `→ paquet   ${image.name}  ${mio(image.byteSize)} Mio\n` +
      `→ graine   ${graine.name}  ${mio(graine.byteSize)} Mio (disque de données : ${options.tailleDonnees} Mio)\n` +
      `→ contrat  paquet.json (fabrication des images : ${((Date.now() - debut) / 1000).toFixed(0)} s)`,
  );
  return paquet;
}

const executeDirectement =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (executeDirectement) {
  fabriquerLePaquet(process.argv.slice(2)).catch((erreur) => {
    console.error(erreur instanceof Error ? erreur.message : String(erreur));
    process.exit(1);
  });
}
