// Produit `manifest.json` à partir des artefacts présents sur le disque.
//
// Les artefacts binaires ne sont pas commités ; le manifeste l'est. C'est donc
// lui, et lui seul, qui atteste ce qui a été construit : nom, taille, empreinte,
// licence, origine, versions de la chaîne. `npm run test:vm` s'y réfère pour
// affirmer qu'il a booté l'image décrite, et pas une autre.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import { ARTEFACTS_ATTENDUS, construireManifeste, validerManifeste } from "./manifest-contract.mjs";

const dossierOutils = dirname(fileURLToPath(import.meta.url));
export const RACINE_DEPOT = resolve(dossierOutils, "..", "..");
export const DOSSIER_ARTEFACTS = join(RACINE_DEPOT, "artifacts", "reference-image");
export const CHEMIN_MANIFESTE = join(dossierOutils, "manifest.json");

/**
 * Métadonnées non calculables : rôle, licence et origine de chaque artefact.
 * Une empreinte sans provenance n'est pas une preuve exploitable.
 *
 * @param {Record<string, any>} sources
 * @returns {Record<string, { role: string, license: string, origin: string }>}
 */
export function metadonneesArtefacts(sources) {
  const construitPar = "tools/build-reference-image/guest.Dockerfile";
  const firmware = Object.fromEntries(
    sources.firmware.files.map((fichier) => [
      fichier.name,
      {
        role: fichier.name === "seabios.bin" ? "bios" : "vga-bios",
        license: fichier.license,
        origin: `${sources.firmware.origin} @ ${sources.firmware.commit}`,
      },
    ]),
  );

  return {
    "reference-rootfs.ext4": {
      role: "hda — rootfs du guest",
      license: `Debian ${sources.debian.suite} (licences libres diverses) ; Ruby ${sources.ruby.version} (${sources.ruby.license})`,
      origin: `${construitPar} (cible rootfs)`,
    },
    "reference-rootfs-vmlinuz": {
      role: "noyau Linux, démarré directement par v86",
      license: "GPL-2.0-only (paquet Debian linux-image-686)",
      origin: `${construitPar} (cible rootfs)`,
    },
    "reference-rootfs-initrd": {
      role: "initrd (pilotes ext2/ext4 avant montage de la racine)",
      license: "licences libres diverses (initramfs-tools et modules Debian)",
      origin: `${construitPar} (cible rootfs)`,
    },
    "reference-app.ext2": {
      role: "hdb — volume applicatif : application, bundle, base SQLite, pièce jointe",
      license: "MIT (RailsBox Vault) ; gemmes selon apps/reference/Gemfile.lock",
      origin: `${construitPar} (cible disque-app)`,
    },
    ...firmware,
  };
}

/**
 * @param {string} chemin
 * @returns {{ byteSize: number, sha256: string }}
 */
export function empreinteFichier(chemin) {
  const contenu = readFileSync(chemin);
  return {
    byteSize: statSync(chemin).size,
    sha256: createHash("sha256").update(contenu).digest("hex"),
  };
}

/**
 * @param {{ dossierArtefacts?: string, environnement?: Record<string, string> }} [options]
 * @returns {Record<string, any>}
 */
export function assemblerManifeste(options = {}) {
  const dossierArtefacts = options.dossierArtefacts ?? DOSSIER_ARTEFACTS;
  const sources = JSON.parse(readFileSync(join(dossierOutils, "sources.json"), "utf8"));
  const invariant = JSON.parse(
    readFileSync(join(RACINE_DEPOT, "apps", "reference", "vault-invariant.json"), "utf8"),
  );
  const verrou = readFileSync(join(RACINE_DEPOT, "apps", "reference", "Gemfile.lock"), "utf8");
  const rails = verrou.match(/^\s+railties \(([^)]+)\)/m)?.[1];
  if (rails === undefined) {
    throw new Error("version de Rails introuvable dans apps/reference/Gemfile.lock");
  }

  const metadonnees = metadonneesArtefacts(sources);
  const artefacts = [];
  const manquants = [];
  for (const nom of ARTEFACTS_ATTENDUS) {
    const chemin = join(dossierArtefacts, nom);
    if (!existsSync(chemin)) {
      manquants.push(nom);
      continue;
    }
    artefacts.push({ name: nom, ...metadonnees[nom], ...empreinteFichier(chemin) });
  }
  if (manquants.length > 0) {
    throw new Error(
      `artefacts absents de ${dossierArtefacts} : ${manquants.join(", ")}\n` +
        "Construire l'image d'abord : npm run image:build",
    );
  }

  return construireManifeste({
    sources,
    artefacts,
    invariant,
    rails,
    environnement: options.environnement ?? environnementCourant(),
    genereLe: new Date().toISOString(),
  });
}

/** @returns {Record<string, string>} */
export function environnementCourant() {
  return {
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
  };
}

/**
 * @param {{ dossierArtefacts?: string, chemin?: string, environnement?: Record<string, string> }} [options]
 * @returns {{ chemin: string, manifeste: Record<string, any> }}
 */
export function ecrireManifeste(options = {}) {
  const manifeste = assemblerManifeste(options);
  const anomalies = validerManifeste(manifeste);
  if (anomalies.length > 0) {
    throw new Error(
      `manifeste refusé :\n${anomalies.map((anomalie) => `  · [${anomalie.code}] ${anomalie.message}`).join("\n")}`,
    );
  }
  const chemin = options.chemin ?? CHEMIN_MANIFESTE;
  mkdirSync(dirname(chemin), { recursive: true });
  writeFileSync(chemin, `${JSON.stringify(manifeste, null, 2)}\n`, "utf8");
  return { chemin, manifeste };
}

const executeDirectement =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (executeDirectement) {
  try {
    const { chemin, manifeste } = ecrireManifeste();
    const mib = (manifeste.totals.byteSize / 1024 / 1024).toFixed(1);
    console.log(`Manifeste écrit : ${chemin}`);
    console.log(`  ${manifeste.totals.artifactCount} artefacts, ${mib} Mio au total`);
    for (const artefact of manifeste.artifacts) {
      console.log(`  · ${artefact.name.padEnd(28)} ${String(artefact.byteSize).padStart(12)} octets  ${artefact.sha256}`);
    }
  } catch (erreur) {
    console.error(erreur instanceof Error ? erreur.message : String(erreur));
    process.exit(1);
  }
}
