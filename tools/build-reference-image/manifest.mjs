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
 * Le DESCRIPTEUR D'APPLICATION, servi par l'origine de confiance (#163, ADR 0030).
 *
 * Le manifeste ci-dessus vit dans `tools/` : il atteste ce qui a été CONSTRUIT, et il est commité.
 * La coquille de produit, elle, ne peut lire que ce que son origine sert — `public/`, `src/`,
 * `vendor/` et `artifacts/` (`tools/serve.mjs`). Sans un descripteur servi, elle ne saurait ni la
 * taille du disque à installer, ni la ligne de commande du guest, ni l'identité que le manifeste du
 * volume doit déclarer : elle devrait les recevoir d'un harnais, c'est-à-dire du chemin que #162 a
 * précisément fermé.
 *
 * Il ne porte AUCUN secret : des noms d'artefacts, des tailles et une ligne de commande, tous déjà
 * publics dans le manifeste. Il n'entre dans aucune archive et ne décrit aucun volume d'utilisateur.
 */
export const CHEMIN_DESCRIPTEUR_APPLICATIF = join(RACINE_DEPOT, "artifacts", "application.json");

/** Version du descripteur. Un lecteur d'une autre version refuse plutôt que de deviner. */
export const DESCRIPTEUR_APPLICATIF_VERSION = 1;

/**
 * Dérive le descripteur applicatif du manifeste d'image, sans rien y ajouter qui ne s'y trouve.
 *
 * `runtime.version` vient de `package.json` : c'est le plus ancien runtime autorisé à écrire le
 * volume (`minWriter`, format v2), et le banc déclare déjà la version en cours — le choix le plus
 * strict. Le recopier ici garde les deux chemins sur la même règle.
 *
 * @param {Record<string, any>} manifeste
 * @param {string} versionRuntime
 */
export function descripteurApplicatif(manifeste, versionRuntime) {
  const disque = manifeste.artifacts.find((artefact) => artefact.name === manifeste.boot.hdb);
  if (disque === undefined) {
    throw new Error(
      `Aucun artefact « ${manifeste.boot.hdb} » dans le manifeste : rien à installer.`,
    );
  }
  return {
    descripteurVersion: DESCRIPTEUR_APPLICATIF_VERSION,
    application: { id: manifeste.application.id, version: manifeste.application.version },
    runtime: { version: versionRuntime },
    disque: { nom: manifeste.boot.hdb, octets: disque.byteSize },
    boot: {
      cmdline: manifeste.boot.cmdline,
      memoireOctets: manifeste.boot.memoryMiB * 1024 * 1024,
      kernel: manifeste.boot.kernel,
      initrd: manifeste.boot.initrd,
      rootfs: manifeste.boot.hda,
      bios: manifeste.boot.bios,
      vgaBios: manifeste.boot.vgaBios,
    },
    /** Où les artefacts ci-dessus sont servis. Le chemin est celui de `tools/serve.mjs`. */
    prefixeDesArtefacts: "/artifacts/reference-image/",
  };
}

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
      console.log(
        `  · ${artefact.name.padEnd(28)} ${String(artefact.byteSize).padStart(12)} octets  ${artefact.sha256}`,
      );
    }
  } catch (erreur) {
    console.error(erreur instanceof Error ? erreur.message : String(erreur));
    process.exit(1);
  }
}
