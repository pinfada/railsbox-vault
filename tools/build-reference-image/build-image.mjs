// Construit l'image de référence : rootfs bootable, disque applicatif, noyau,
// initrd et micrologiciels, puis écrit le manifeste.
//
// La construction refuse de commencer si un artefact n'est pas épinglé ou si un
// secret est requis (`verify-pinning.mjs`).
//
// Elle n'écrit jamais sur le disque de l'hôte autre chose que
// `artifacts/reference-image/` : l'archive du rootfs est transmise en flux du
// `docker export` au conteneur fabricant de systèmes de fichiers, sans fichier
// intermédiaire de 1,5 Gio sur un montage lié Windows.
//
// Options : --sans-cache, --seulement=rootfs|app|firmware, --taille-app=<Mio>
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { ecrireManifeste, DOSSIER_ARTEFACTS, RACINE_DEPOT } from "./manifest.mjs";
import { verifierEpinglage } from "./verify-pinning.mjs";

const dossierOutils = dirname(fileURLToPath(import.meta.url));
const sources = JSON.parse(readFileSync(join(dossierOutils, "sources.json"), "utf8"));

const ETIQUETTES = {
  rootfs: "railsbox-vault-reference-rootfs:local",
  app: "railsbox-vault-reference-app:local",
  fabricant: "railsbox-vault-diskbuilder:local",
};

const options = analyserArguments(process.argv.slice(2));

/**
 * @param {string[]} arguments_
 * @returns {{ sansCache: boolean, seulement: string | null, tailleApp: number }}
 */
function analyserArguments(arguments_) {
  let sansCache = false;
  let seulement = null;
  let tailleApp = sources.disk.appDiskMiB;

  for (const argument of arguments_) {
    if (argument === "--sans-cache") sansCache = true;
    else if (argument.startsWith("--seulement=")) seulement = argument.slice("--seulement=".length);
    else if (argument.startsWith("--taille-app=")) tailleApp = Number.parseInt(argument.slice(13), 10);
    else {
      console.error(`option inconnue : ${argument}`);
      process.exit(64);
    }
  }
  if (!Number.isInteger(tailleApp) || tailleApp < 64) {
    console.error(`taille du disque applicatif invalide : ${tailleApp}`);
    process.exit(64);
  }
  return { sansCache, seulement, tailleApp };
}

/**
 * @param {string} etape
 * @param {string[]} arguments_
 */
function executer(etape, arguments_) {
  const debut = Date.now();
  const resultat = spawnSync("docker", arguments_, { stdio: "inherit", cwd: RACINE_DEPOT });
  if (resultat.error) {
    echouer(`Docker est indisponible (${etape}) : ${resultat.error.message}`, 127);
  }
  if (resultat.status !== 0) {
    echouer(`échec de l'étape « ${etape} » (code ${resultat.status})`, resultat.status ?? 1);
  }
  return Date.now() - debut;
}

/**
 * @param {string} message
 * @param {number} code
 * @returns {never}
 */
function echouer(message, code) {
  console.error(message);
  process.exit(code);
}

/** Vérifie l'épinglage avant tout appel à Docker. */
function verifier() {
  const { anomalies, fichiers } = verifierEpinglage();
  if (anomalies.length > 0) {
    console.error("Construction refusée : la chaîne n'est pas entièrement épinglée.");
    for (const anomalie of anomalies) console.error(`  · [${anomalie.code}] ${anomalie.message}`);
    process.exit(1);
  }
  console.log(`→ épinglage vérifié (${fichiers.length} Dockerfiles, sources.json conforme)`);
}

/** Télécharge les micrologiciels et vérifie leur empreinte. */
async function recupererMicrologiciels() {
  for (const fichier of sources.firmware.files) {
    const destination = join(DOSSIER_ARTEFACTS, fichier.name);
    if (existsSync(destination) && empreinte(destination) === fichier.sha256) {
      console.log(`→ ${fichier.name} déjà présent et conforme`);
      continue;
    }
    console.log(`→ téléchargement de ${fichier.name}…`);
    const reponse = await fetch(fichier.url);
    if (!reponse.ok) {
      echouer(`téléchargement refusé (${reponse.status}) : ${fichier.url}`, 1);
    }
    const contenu = Buffer.from(await reponse.arrayBuffer());
    const obtenue = createHash("sha256").update(contenu).digest("hex");
    if (obtenue !== fichier.sha256) {
      echouer(
        `empreinte inattendue pour ${fichier.name} : ${obtenue} au lieu de ${fichier.sha256}`,
        1,
      );
    }
    if (contenu.byteLength !== fichier.byteSize) {
      echouer(`taille inattendue pour ${fichier.name} : ${contenu.byteLength} octets`, 1);
    }
    writeFileSync(destination, contenu);
  }
}

/**
 * @param {string} chemin
 * @returns {string}
 */
function empreinte(chemin) {
  return createHash("sha256").update(readFileSync(chemin)).digest("hex");
}

/**
 * Exporte une image et fabrique un système de fichiers, en flux.
 *
 * @param {{ etiquette: string, nom: string, type: string, sousArbre: string, tailleMiB?: number }} parametres
 * @returns {Promise<number>} durée en millisecondes
 */
function fabriquerDisque({ etiquette, nom, type, sousArbre, tailleMiB }) {
  const debut = Date.now();
  return new Promise((resoudre, rejeter) => {
    const creation = spawnSync("docker", ["create", "--platform", "linux/386", etiquette], {
      encoding: "utf8",
    });
    if (creation.status !== 0) {
      rejeter(new Error(`docker create a échoué : ${creation.stderr}`));
      return;
    }
    const conteneur = creation.stdout.trim();

    const exportation = spawn("docker", ["export", conteneur], { stdio: ["ignore", "pipe", "inherit"] });
    const fabrication = spawn(
      "docker",
      [
        "run",
        "--rm",
        "-i",
        "-v",
        `${DOSSIER_ARTEFACTS}:/sortie`,
        "-e",
        `MARGE_POURCENT=${sources.disk.rootfsMarginPercent}`,
        "-e",
        `MARGE_MIB=${sources.disk.rootfsMarginMiB}`,
        "-e",
        `BLOC=${sources.disk.blockSize}`,
        ETIQUETTES.fabricant,
        nom,
        type,
        sousArbre,
        ...(tailleMiB ? [String(tailleMiB)] : []),
      ],
      { stdio: ["pipe", "inherit", "inherit"] },
    );

    exportation.stdout.pipe(fabrication.stdin);

    fabrication.on("close", (code) => {
      spawnSync("docker", ["rm", "-f", conteneur], { stdio: "ignore" });
      if (code === 0) resoudre(Date.now() - debut);
      else rejeter(new Error(`fabrication de ${nom}.${type} échouée (code ${code})`));
    });
    fabrication.on("error", rejeter);
  });
}

async function principal() {
  verifier();
  mkdirSync(DOSSIER_ARTEFACTS, { recursive: true });

  /** @type {Record<string, number>} */
  const durees = {};
  const cache = options.sansCache ? ["--no-cache"] : [];
  const cible = (nom) => options.seulement === null || options.seulement === nom;

  if (cible("firmware")) await recupererMicrologiciels();

  if (cible("rootfs") || cible("app")) {
    durees.fabricant = executer("image du fabricant de systèmes de fichiers", [
      "build",
      "-f",
      "tools/build-reference-image/diskbuilder.Dockerfile",
      "-t",
      ETIQUETTES.fabricant,
      ".",
    ]);
  }

  if (cible("rootfs")) {
    durees.rootfsDocker = executer("construction du rootfs i386", [
      "build",
      "--platform",
      "linux/386",
      ...cache,
      "-f",
      "tools/build-reference-image/guest.Dockerfile",
      "--target",
      "rootfs",
      "-t",
      ETIQUETTES.rootfs,
      ".",
    ]);
    durees.rootfsDisque = await fabriquerDisque({
      etiquette: ETIQUETTES.rootfs,
      nom: "reference-rootfs",
      type: sources.disk.rootfsFilesystem,
      sousArbre: ".",
    });
  }

  if (cible("app")) {
    durees.appDocker = executer("construction du disque applicatif", [
      "build",
      "--platform",
      "linux/386",
      ...cache,
      "-f",
      "tools/build-reference-image/guest.Dockerfile",
      "--target",
      "disque-app",
      "-t",
      ETIQUETTES.app,
      ".",
    ]);
    durees.appDisque = await fabriquerDisque({
      etiquette: ETIQUETTES.app,
      nom: "reference-app",
      type: sources.disk.appDiskFilesystem,
      sousArbre: "app",
      tailleMiB: options.tailleApp,
    });
  }

  const { chemin, manifeste } = ecrireManifeste();
  console.log(`\n→ manifeste écrit : ${chemin}`);
  for (const artefact of manifeste.artifacts) {
    const mib = (artefact.byteSize / 1024 / 1024).toFixed(1).padStart(8);
    console.log(`   ${artefact.name.padEnd(28)} ${mib} Mio  ${artefact.sha256.slice(0, 16)}…`);
  }
  console.log(`   total : ${(manifeste.totals.byteSize / 1024 / 1024).toFixed(1)} Mio`);

  console.log("\n→ durées mesurées");
  for (const [etape, duree] of Object.entries(durees)) {
    console.log(`   ${etape.padEnd(16)} ${(duree / 1000).toFixed(0)} s`);
  }
  const disponible = statSync(DOSSIER_ARTEFACTS).isDirectory();
  if (!disponible) echouer("dossier d'artefacts introuvable après construction", 1);
}

principal().catch((erreur) => {
  console.error(erreur instanceof Error ? erreur.message : String(erreur));
  process.exit(1);
});
