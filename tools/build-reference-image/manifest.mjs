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
import { validerPaquet } from "../paquet/contrat-du-paquet.mjs";
import { nomServi } from "../paquet/compression.mjs";
import { comparerVersions, estUneVersion } from "../../src/coquille/dephasage.mjs";

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

/**
 * Version du descripteur. Un lecteur d'une autre version refuse plutôt que de deviner.
 *
 * **v2 depuis #236** : le disque unique (`disque`) a disparu, remplacé par les trois morceaux du
 * paquet applicatif — le `rootfs` et le `paquet`, que la coquille RANGE dans un `hda` composé, et la
 * `graine`, qu'elle VERSE dans le volume de données. Chacun porte désormais son EMPREINTE, que
 * l'installation et le boot confrontent aux octets reçus ; la v1 ne portait que des tailles.
 *
 * Aucune compatibilité v1 n'est portée : aucun déploiement réel n'existe (ADR 0041), et un lecteur
 * qui accepterait les deux formes accepterait aussi un descripteur sans empreinte.
 */
export const DESCRIPTEUR_APPLICATIF_VERSION = 2;

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
  const trouver = (nom, role) => {
    const trouve = manifeste.artifacts.find((candidat) => candidat.name === nom);
    if (trouve === undefined) {
      throw new Error(`Aucun artefact « ${nom} » dans le manifeste : rien à servir pour ${role}.`);
    }
    return trouve;
  };
  // Un MORCEAU servi (#236 T2) : son nom et sa taille transférée sont ceux du fichier gzip ; `octets`
  // et `sha256` restent ceux de l'image DÉCOMPRESSÉE, que l'empreinte d'image et la datation lisent.
  const morceau = (nomImage, nomServi, role) => {
    const image = trouver(nomImage, role);
    if (nomServi === undefined || nomServi === null) {
      return { nom: nomImage, octets: image.byteSize, sha256: image.sha256 };
    }
    return {
      nom: nomServi,
      octets: image.byteSize,
      sha256: image.sha256,
      compression: "gzip",
      transfertOctets: trouver(nomServi, role).byteSize,
    };
  };
  const artefact = (role) => morceau(manifeste.boot[role], manifeste.boot.servis?.[role], role);
  return {
    descripteurVersion: DESCRIPTEUR_APPLICATIF_VERSION,
    application: {
      id: manifeste.application.id,
      version: manifeste.application.version,
      schema: manifeste.application.schema,
    },
    runtime: { version: versionRuntime },
    rootfs: artefact("rootfs"),
    paquet: artefact("paquet"),
    graine: { ...artefact("graine"), disqueOctets: manifeste.donnees.disqueOctets },
    boot: {
      cmdline: manifeste.boot.cmdline,
      memoireOctets: manifeste.boot.memoryMiB * 1024 * 1024,
      kernel: manifeste.boot.kernel,
      initrd: manifeste.boot.initrd,
      bios: manifeste.boot.bios,
      vgaBios: manifeste.boot.vgaBios,
    },
    /** Où les artefacts ci-dessus sont servis. Le chemin est celui de `tools/serve.mjs`. */
    prefixeDesArtefacts: "/artifacts/reference-image/",
    ...(manifeste.precedent === undefined
      ? {}
      : {
          precedent: {
            application: manifeste.precedent.application,
            paquet: morceau(
              manifeste.precedent.paquet,
              manifeste.precedent.servis?.paquet,
              "précédent",
            ),
          },
        }),
  };
}

/**
 * Métadonnées non calculables : rôle, licence et origine de chaque artefact.
 * Une empreinte sans provenance n'est pas une preuve exploitable.
 *
 * @param {Record<string, any>} sources
 * @returns {Record<string, { role: string, license: string, origin: string }>}
 */
export function metadonneesArtefacts(sources, paquet) {
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
    [paquet.image.name]: {
      role: "partition 2 de hda — paquet applicatif : arbre de l'application, bundle i386, cache Bootsnap",
      license: paquet.licence,
      origin: `${construitPar} (cible disque-app), npm run app:paquet`,
    },
    [paquet.graine.name]: {
      role: "graine du volume de données — base SQLite migrée et vide, storage/ vide, marqueur de schéma",
      license: paquet.licence,
      origin: `${construitPar} (cible disque-app), npm run app:paquet`,
    },
    ...firmware,
  };
}

/** Où la fabrication dépose le contrat du paquet applicatif construit (`npm run app:paquet`). */
export const NOM_DU_CONTRAT_DE_PAQUET = "paquet.json";

/**
 * LIT le contrat du paquet déposé par la fabrication, et le REFUSE s'il n'est pas conforme.
 *
 * Sans lui, le manifeste ne peut rien dire : les noms des deux images portent leur empreinte, le
 * schéma vient de la base migrée, et la taille du disque de données est celle que la graine a
 * reçue. Rien de tout cela n'est devinable depuis `sources.json`.
 *
 * @param {string} dossierArtefacts
 */
export function lirePaquetApplicatif(dossierArtefacts) {
  const chemin = join(dossierArtefacts, NOM_DU_CONTRAT_DE_PAQUET);
  if (!existsSync(chemin)) {
    throw new Error(
      `contrat de paquet absent (${chemin}) — fabriquer le paquet d'abord : npm run app:paquet`,
    );
  }
  const paquet = JSON.parse(readFileSync(chemin, "utf8"));
  const anomalies = validerPaquet(paquet);
  if (anomalies.length > 0) {
    const detail = anomalies.map((anomalie) => `  · [${anomalie.code}] ${anomalie.message}`);
    throw new Error(["contrat de paquet refusé :", ...detail].join("\n"));
  }
  return paquet;
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
  const paquet = options.paquet ?? lirePaquetApplicatif(dossierArtefacts);
  const sources = JSON.parse(readFileSync(join(dossierOutils, "sources.json"), "utf8"));
  const invariant = JSON.parse(
    readFileSync(join(RACINE_DEPOT, "apps", "reference", "vault-invariant.json"), "utf8"),
  );
  const verrou = readFileSync(join(RACINE_DEPOT, "apps", "reference", "Gemfile.lock"), "utf8");
  const rails = verrou.match(/^\s+railties \(([^)]+)\)/m)?.[1];
  if (rails === undefined) {
    throw new Error("version de Rails introuvable dans apps/reference/Gemfile.lock");
  }

  const retenu = precedentRetenu(
    paquet,
    options.precedent === undefined ? lirePaquetPrecedent(dossierArtefacts) : options.precedent,
  );
  if (retenu.ecarte !== null) (options.dire ?? console.log)(retenu.ecarte);
  const precedent = retenu.precedent;
  const metadonnees = {
    ...metadonneesArtefacts(sources, paquet),
    ...(precedent === null ? {} : metadonneesArtefacts(sources, precedent)),
  };
  const rootfs = join(dossierArtefacts, "reference-rootfs.ext4");
  const rootfsServi = existsSync(rootfs)
    ? nomServi("reference-rootfs.ext4", empreinteFichier(rootfs).sha256)
    : null;
  const artefacts = [];
  const manquants = [];
  for (const nom of nomsAttendus({ paquet, precedent, rootfsServi })) {
    const chemin = join(dossierArtefacts, nom);
    if (!existsSync(chemin)) {
      manquants.push(nom);
      continue;
    }
    const decrit = metadonnees[nom] ?? metadonneesDUnServi(nom);
    artefacts.push({ name: nom, ...decrit, ...empreinteFichier(chemin) });
  }
  if (manquants.length > 0) {
    throw new Error(motifDesManquants({ manquants, precedent, dossierArtefacts }));
  }

  return construireManifeste({
    sources,
    artefacts,
    invariant,
    paquet,
    precedent,
    rootfsServi,
    rails,
    environnement: options.environnement ?? environnementCourant(),
    genereLe: new Date().toISOString(),
  });
}

/**
 * Les noms que le manifeste doit trouver : l'image de référence, le paquet courant et sa graine, le
 * PRÉCÉDENT et sa graine (rétention 1, #236 T2), et le fichier SERVI — gzip — de chacun.
 */
function nomsAttendus({ paquet, precedent, rootfsServi }) {
  const duPaquet = (contrat) => [
    contrat.image.name,
    contrat.graine.name,
    contrat.image.servi.name,
    contrat.graine.servi.name,
  ];
  return [
    ...ARTEFACTS_ATTENDUS,
    ...(rootfsServi === null ? [] : [rootfsServi]),
    ...duPaquet(paquet),
    ...(precedent === null ? [] : duPaquet(precedent)),
  ];
}

/**
 * Le PRÉCÉDENT RETENU (recette QA de la PR #249, Q4) : un précédent n'est gardé que s'il est une
 * version STRICTEMENT antérieure de la MÊME application (ADR 0042, § 4). Sinon il est ÉCARTÉ — le
 * descripteur sert le courant seul — et une ligne le dit, avec le geste qui retire le contrat.
 *
 * @param {{ application: { id: string, version: string } }} paquet
 * @param {{ application: { id: string, version: string } } | null} precedent
 * @returns {{ precedent: object | null, ecarte: string | null }}
 */
export function precedentRetenu(paquet, precedent) {
  if (precedent === null || precedent === undefined) return { precedent: null, ecarte: null };
  const [courant, ancien] = [paquet.application, precedent.application];
  const nommer = (application) => `${application.id} ${application.version}`;
  const suite =
    ` : le descripteur sert ${nommer(courant)} seul. Pour retirer ce précédent : ` +
    "`npm run app:paquet -- --retirer-precedent`.";
  if (ancien.id !== courant.id) {
    return {
      precedent: null,
      ecarte: `→ précédent écarté : ${nommer(ancien)} est une AUTRE application que ${courant.id}${suite}`,
    };
  }
  const anterieur =
    estUneVersion(ancien.version) &&
    estUneVersion(courant.version) &&
    comparerVersions(ancien.version, courant.version) < 0;
  if (!anterieur) {
    return {
      precedent: null,
      ecarte: `→ précédent écarté : ${nommer(ancien)} n'est pas antérieur à ${courant.version}${suite}`,
    };
  }
  return { precedent, ecarte: null };
}

/**
 * Ce que dit l'outil quand des artefacts manquent : la VRAIE cause (recette QA de la PR #249, Q5). Si
 * seules les images du précédent manquent, construire l'image n'y changerait rien.
 */
function motifDesManquants({ manquants, precedent, dossierArtefacts }) {
  const duPrecedent =
    precedent === null
      ? []
      : [
          precedent.image.name,
          precedent.graine.name,
          precedent.image.servi.name,
          precedent.graine.servi.name,
        ];
  if (manquants.every((nom) => duPrecedent.includes(nom))) {
    const nom = `${precedent.application.id} ${precedent.application.version}`;
    return (
      `le paquet précédent ${nom}, que ${NOM_DU_CONTRAT_PRECEDENT} désigne, n'a plus ses images dans ` +
      `${dossierArtefacts} : ${manquants.join(", ")}\n` +
      "Pour servir la version courante seule : npm run app:paquet -- --retirer-precedent ; pour " +
      "garder ce précédent : le refabriquer (npm run app:paquet -- --precedent --source <sa source>)."
    );
  }
  return (
    `artefacts absents de ${dossierArtefacts} : ${manquants.join(", ")}\n` +
    "Construire l'image d'abord : npm run image:build (le paquet seul : npm run app:paquet)"
  );
}

/** Rôle, licence et origine d'un fichier SERVI : ceux de l'image qu'il compresse. */
function metadonneesDUnServi(nom) {
  return {
    role: `fichier servi, gzip déterministe (#236 T2) de l'image ${nom.replace(/.gz$/, "")}`,
    license: "celle de l'image compressée",
    origin: "tools/paquet/compression.mjs (gzip -9, en-tête sans nom ni date, OS inconnu)",
  };
}

/** Le contrat du paquet PRÉCÉDENT (rétention 1), ou `null` s'il n'a pas été fabriqué. */
export function lirePaquetPrecedent(dossierArtefacts) {
  const chemin = join(dossierArtefacts, NOM_DU_CONTRAT_PRECEDENT);
  if (!existsSync(chemin)) return null;
  const precedent = JSON.parse(readFileSync(chemin, "utf8"));
  const anomalies = validerPaquet(precedent);
  if (anomalies.length > 0) {
    const detail = anomalies.map((anomalie) => `  · [${anomalie.code}] ${anomalie.message}`);
    throw new Error(["contrat du paquet précédent refusé :", ...detail].join("\n"));
  }
  return precedent;
}

/** Où la fabrication `--precedent` dépose le contrat du paquet précédent. */
export const NOM_DU_CONTRAT_PRECEDENT = "paquet-precedent.json";

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
  // Le DESCRIPTEUR SERVI naît du MÊME GESTE que le manifeste, et c'est la décision (#163, ADR 0030).
  //
  // Deux fichiers dérivés du même manifeste doivent naître ensemble, sans quoi l'un des deux finit
  // par décrire une image que l'autre a remplacée. Surtout, un descripteur écrit par un outil DE
  // PLUS serait un outil que la recette d'intégration continue peut oublier d'appeler — et elle
  // l'a oublié : la première rédaction de cette tranche définissait `descripteurApplicatif` sans
  // que personne ne l'appelle, si bien que `reprise.yml` a SAUTÉ le scénario de la coquille et rendu
  // « 8 passed, 1 skipped ». Un vert par vacuité, sur le scénario même que la tranche livrait.
  const cheminDescripteur = options.cheminDescripteur ?? CHEMIN_DESCRIPTEUR_APPLICATIF;
  const versionRuntime =
    options.versionRuntime ??
    JSON.parse(readFileSync(join(RACINE_DEPOT, "package.json"), "utf8")).version;
  mkdirSync(dirname(cheminDescripteur), { recursive: true });
  writeFileSync(
    cheminDescripteur,
    `${JSON.stringify(descripteurApplicatif(manifeste, versionRuntime), null, 2)}\n`,
    "utf8",
  );
  return { chemin, manifeste, cheminDescripteur };
}

const executeDirectement =
  process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (executeDirectement) {
  try {
    const { chemin, manifeste } = ecrireManifeste();
    const mib = (manifeste.totals.byteSize / 1024 / 1024).toFixed(1);
    console.log(`Manifeste écrit : ${chemin}`);
    console.log(`Descripteur applicatif écrit : ${CHEMIN_DESCRIPTEUR_APPLICATIF}`);
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
