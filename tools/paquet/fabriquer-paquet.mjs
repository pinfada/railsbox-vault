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
import { tmpdir } from "node:os";
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
  copyFileSync,
  mkdtempSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { construirePaquet, nomDImage, validerPaquet } from "./contrat-du-paquet.mjs";
import { compresserDeterministe, nomServi } from "./compression.mjs";
import {
  identiteDeLApplication,
  secretsPresents,
  SECRETS_REFUSES_LIBELLES,
} from "./identite-de-l-application.mjs";
import { cheminExclu, fichiersRetenus } from "./exclusions-de-la-source.mjs";
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
 * @returns {{ source: string, id: string | null, version: string | null, tailleDonnees: number,
 *             role: string }}
 */
export function analyserArguments(arguments_) {
  let source = join(RACINE_DEPOT, "apps", "reference");
  let id = null;
  let version = null;
  let tailleDonnees = SOURCES.disk.appDiskMiB;
  let role = ROLES_DU_CONTRAT.courant;

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
    } else if (argument === "--precedent") {
      role = ROLES_DU_CONTRAT.precedent;
    } else {
      throw new Error(`option inconnue : ${argument}`);
    }
  }
  if (!Number.isInteger(tailleDonnees) || tailleDonnees < 64) {
    throw new Error(`taille du disque de données invalide : ${tailleDonnees} Mio`);
  }
  return { source: resolve(source), id, version, tailleDonnees, role };
}

/**
 * Les deux CONTRATS qu'un dossier d'artefacts porte (#236 T2, rétention 1) : le paquet COURANT, que
 * le descripteur sert, et le PRÉCÉDENT, gardé servable pour que « Plus tard » ouvre un coffre sur sa
 * version. `--precedent` fabrique le second ; les images de l'un ne retirent jamais celles de l'autre.
 */
export const ROLES_DU_CONTRAT = Object.freeze({
  courant: "paquet.json",
  precedent: "paquet-precedent.json",
});

/**
 * Les fichiers de la source qui ENTRERONT dans le paquet, en chemins relatifs à barres obliques.
 *
 * C'est la liste UNIQUE (#236, revue de sécurité, constat 1) : elle décide de ce que la copie prend,
 * et c'est elle que le balayage de secrets parcourt. Auparavant, le balayage ignorait `.git/`,
 * `vendor/` et `log/` que la copie prenait — les deux listes étaient complémentaires, si bien que
 * tout ce qui n'était pas examiné était exactement ce qui partait dans l'image publiée.
 *
 * Quand la source est un dépôt git, sa propre liste fait foi EN PLUS : un fichier ignoré par git
 * (`.env` local, dump de base, clé posée à la main) n'entre pas, même s'il ne correspond à aucun
 * motif. `git ls-files -co --exclude-standard` rend les fichiers suivis et les non suivis NON
 * ignorés ; c'est exactement « ce que le dépôt reconnaît ».
 */
function fichiersDeLaSource(source) {
  const listeGit = fichiersSelonGit(source);
  if (listeGit !== null) return fichiersRetenus(listeGit);

  const trouves = [];
  const parcourir = (dossier, prefixe) => {
    for (const entree of readdirSync(dossier, { withFileTypes: true })) {
      const relatif = prefixe === "" ? entree.name : `${prefixe}/${entree.name}`;
      if (cheminExclu(relatif)) continue;
      if (entree.isDirectory()) parcourir(join(dossier, entree.name), relatif);
      else trouves.push(relatif);
    }
  };
  parcourir(source, "");
  return trouves;
}

/**
 * Ce que GIT reconnaît dans la source, ou `null` si ce n'en est pas un dépôt.
 *
 * `-c` (suivis) et `-o --exclude-standard` (non suivis mais non ignorés) : ce qui est ignoré par
 * `.gitignore` reste dehors. Une source qui n'est pas un dépôt rend `null`, et le parcours du disque
 * prend le relais — les motifs d'exclusion s'appliquent dans les deux cas.
 */
function fichiersSelonGit(source) {
  const resultat = spawnSync("git", ["-C", source, "ls-files", "-c", "-o", "--exclude-standard"], {
    encoding: "utf8",
  });
  if (resultat.error !== undefined || resultat.status !== 0) return null;
  return resultat.stdout.split("\n").filter((ligne) => ligne.trim() !== "");
}

/**
 * RECOPIE la source filtrée dans un arbre de travail, et rend son chemin.
 *
 * C'est CET arbre que Docker reçoit comme contexte de construction nommé, et lui seul : le
 * `.dockerignore` du dépôt ne peut rien pour un contexte extérieur, et un contexte qu'on ne
 * contrôle pas est un contexte dont on ne sait pas ce qu'il porte.
 */
function preparerLArbreDuPaquet(source, fichiers) {
  const arbre = mkdtempSync(join(tmpdir(), "vault-paquet-"));
  for (const relatif of fichiers) {
    const destination = join(arbre, relatif);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(join(source, relatif), destination);
  }
  return arbre;
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
  // Le balayage porte sur CE QUI ENTRERA, et sur rien d'autre : c'est la correction du constat 1.
  const fichiers = fichiersDeLaSource(source);
  const secrets = secretsPresents(fichiers);
  if (secrets.length > 0) {
    throw new Error(
      `Source refusée : elle porte ${secrets.join(", ")}. Un paquet ne contient AUCUN secret — ` +
        `ni ${SECRETS_REFUSES_LIBELLES.join(", ni ")} ; le secret_key_base se dérive d'une chaîne publique.`,
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
  return { ...identite, schema, fichiers };
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
  // Les images d'une fabrication ANTÉRIEURE du même id ET de la même VERSION sont retirées — brutes
  // et servies : elles ne sont plus citées par aucun manifeste. Une AUTRE version est gardée : c'est
  // peut-être le paquet PRÉCÉDENT de la rétention 1 (#236 T2), sans lequel « Plus tard » n'ouvre rien.
  const prefixe = `${id}-${version}-`;
  const estUneImage = (fichier) => fichier.endsWith(".ext4") || fichier.endsWith(".ext4.gz");
  for (const ancien of readdirSync(DOSSIER_ARTEFACTS)) {
    const memeImage = ancien.startsWith(prefixe) && estUneImage(ancien);
    if (ancien !== nom && memeImage && estDuMemeRole(ancien, suffixe, id)) {
      rmSync(join(DOSSIER_ARTEFACTS, ancien));
    }
  }
  renameSync(join(DOSSIER_ARTEFACTS, fichierTemporaire), join(DOSSIER_ARTEFACTS, nom));
  return { name: nom, ...mesure };
}

/**
 * COMPRESSE une image pour la servir (gzip déterministe, #236 T2) et rend l'image augmentée de son
 * fichier SERVI : nom, taille et empreinte de ce qui voyage.
 */
async function servirCompresse(image) {
  const nom = nomServi(image.name, image.sha256);
  const mesure = await compresserDeterministe(
    join(DOSSIER_ARTEFACTS, image.name),
    join(DOSSIER_ARTEFACTS, nom),
  );
  return { ...image, servi: { name: nom, compression: "gzip", ...mesure } };
}

/** Distingue une image de CODE d'une GRAINE : leurs noms ne diffèrent que par ce segment. */
function estDuMemeRole(nom, suffixe, id) {
  const porteGraine = nom.startsWith(`${id}-`) && nom.includes("-graine-");
  return suffixe === "graine" ? porteGraine : !porteGraine;
}

/**
 * Ce que la fabrication REMPLACE, dit en une ligne, ou `null` si elle ne remplace rien.
 *
 * `paquet.json` est le paquet SERVI : un seul à la fois dans `artifacts/reference-image/`. Fabriquer
 * une application extérieure retire donc la référence, et l'outil le taisait (recette QA du 18/09,
 * défaut 2). La rétention de plusieurs paquets appartient à T2 ; ici, on le DIT, avec l'étape qui
 * reste à faire et le chemin du retour.
 *
 * @param {{ application: { id: string, version: string } } | null} ancien
 * @param {{ application: { id: string, version: string } }} nouveau
 */
export function annonceDeRemplacement(ancien, nouveau) {
  const nommer = ({ application }) => `${application.id} ${application.version}`;
  if (ancien?.application === undefined || nommer(ancien) === nommer(nouveau)) return null;
  return (
    `→ remplace le paquet servi : ${nommer(ancien)} → ${nommer(nouveau)} ; ` +
    "`npm run image:manifest` pour le descripteur ; " +
    "pour revenir à la référence : `npm run app:paquet` sans `--source`"
  );
}

/** Le `paquet.json` en place, ou `null` s'il n'y en a pas (ou s'il est illisible). */
function paquetEnPlace() {
  const chemin = join(DOSSIER_ARTEFACTS, "paquet.json");
  if (!existsSync(chemin)) return null;
  try {
    return JSON.parse(readFileSync(chemin, "utf8"));
  } catch {
    // Un contrat illisible n'est le paquet servi de personne : il est remplacé sans annonce.
    return null;
  }
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

  // L'arbre FILTRÉ, et lui seul, devient le contexte de construction : ce que Docker copie est
  // exactement ce que le balayage de secrets a examiné (revue #237, constat 1).
  const arbreDuPaquet = preparerLArbreDuPaquet(options.source, identite.fichiers);
  console.log(`→ contexte : ${identite.fichiers.length} fichiers retenus (arbre filtré)`);
  try {
    return await fabriquerDepuisLArbre({ options, identite, arbreDuPaquet });
  } finally {
    rmSync(arbreDuPaquet, { recursive: true, force: true });
  }
}

/**
 * FABRIQUE depuis l'arbre filtré. Séparé de `fabriquerLePaquet` pour que le nettoyage de l'arbre
 * tienne dans un `finally` qui ne peut pas être oublié, quoi qu'il arrive à la construction.
 */
async function fabriquerDepuisLArbre({ options, identite, arbreDuPaquet }) {
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
    // Le contexte NOMMÉ : l'arbre FILTRÉ entre ici, et nulle part ailleurs.
    "--build-context",
    `application=${arbreDuPaquet}`,
    "--build-arg",
    `SCHEMA_DE_L_APPLICATION=${identite.schema}`,
    "-t",
    ETIQUETTE_PAQUET,
    ".",
  ]);

  const debut = Date.now();
  await fabriquerLesImages({ tailleDonnees: options.tailleDonnees });
  const image = await servirCompresse(
    nommerParEmpreinte("paquet.ext4", { ...identite, suffixe: "" }),
  );
  const graine = await servirCompresse(
    nommerParEmpreinte("graine.ext4", { ...identite, suffixe: "graine" }),
  );

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
  const remplacement =
    options.role === ROLES_DU_CONTRAT.courant
      ? annonceDeRemplacement(paquetEnPlace(), paquet)
      : null;
  writeFileSync(
    join(DOSSIER_ARTEFACTS, options.role),
    `${JSON.stringify(paquet, null, 2)}\n`,
    "utf8",
  );
  const mio = (octets) => (octets / 1024 / 1024).toFixed(1);
  console.log(
    `→ paquet   ${image.name}  ${mio(image.byteSize)} Mio\n` +
      `→ graine   ${graine.name}  ${mio(graine.byteSize)} Mio (disque de données : ${options.tailleDonnees} Mio)\n` +
      `→ contrat  ${options.role} (fabrication des images : ${((Date.now() - debut) / 1000).toFixed(0)} s)`,
  );
  if (remplacement !== null) console.log(remplacement);
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
