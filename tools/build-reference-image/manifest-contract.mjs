// Contrat du manifeste de l'image de référence.
//
// Le manifeste est la seule pièce de la construction qui soit commitée : les
// artefacts binaires ne le sont pas. C'est donc lui qui porte la preuve — nom,
// taille, empreinte, licence, origine, versions — et c'est lui que le test VM
// compare à ce qu'il a réellement booté.
//
// Fonctions pures, sans accès disque, afin que `tests/unit/reference-manifest.test.mjs`
// puisse exercer aussi bien un manifeste conforme qu'un manifeste amputé.

export const VERSION_MANIFESTE = 1;

/**
 * Artefacts que la construction doit produire. Un manifeste auquel il en manque
 * un est refusé : une image sans initrd ou sans BIOS ne démarre pas, et le
 * découvrir au boot coûte plus cher que de le refuser ici.
 */
export const ARTEFACTS_ATTENDUS = Object.freeze([
  "reference-rootfs.ext4",
  "reference-rootfs-vmlinuz",
  "reference-rootfs-initrd",
  "reference-app.ext2",
  "seabios.bin",
  "vgabios.bin",
]);

/**
 * @typedef {{ name: string, role: string, byteSize: number, sha256: string,
 *   license: string, origin: string }} Artefact
 * @typedef {{ code: string, message: string }} Anomalie
 */

/**
 * @param {{
 *   sources: Record<string, any>,
 *   artefacts: Artefact[],
 *   invariant: Record<string, any>,
 *   rails: string,
 *   environnement: Record<string, string>,
 *   genereLe: string,
 * }} entrees
 * @returns {Record<string, any>}
 */
export function construireManifeste({
  sources,
  artefacts,
  invariant,
  rails,
  environnement,
  genereLe,
}) {
  const tries = [...artefacts].sort((gauche, droite) => gauche.name.localeCompare(droite.name));
  return {
    manifestVersion: VERSION_MANIFESTE,
    generatedAt: genereLe,
    application: {
      id: invariant.application.id,
      version: invariant.application.version,
      invariantRecordId: invariant.record.id,
      attachmentSha256: invariant.attachment.sha256,
    },
    toolchain: {
      ruby: sources.ruby.version,
      rails,
      debianSuite: sources.debian.suite,
      images: Object.fromEntries(
        Object.entries(sources.images).map(([nom, image]) => [
          nom,
          `${image.reference}@${image.digest}`,
        ]),
      ),
    },
    boot: {
      cmdline: sources.guest.cmdline,
      memoryMiB: sources.guest.memoryMiB,
      kernel: "reference-rootfs-vmlinuz",
      initrd: "reference-rootfs-initrd",
      hda: "reference-rootfs.ext4",
      hdb: "reference-app.ext2",
      bios: "seabios.bin",
      vgaBios: "vgabios.bin",
    },
    environment: environnement,
    artifacts: tries,
    totals: {
      artifactCount: tries.length,
      byteSize: tries.reduce((somme, artefact) => somme + artefact.byteSize, 0),
    },
  };
}

/**
 * @param {unknown} manifeste
 * @returns {Anomalie[]}
 */
export function validerManifeste(manifeste) {
  /** @type {Anomalie[]} */
  const anomalies = [];
  const ajouter = (code, message) => anomalies.push({ code, message });

  if (typeof manifeste !== "object" || manifeste === null) {
    ajouter("manifeste-invalide", "le manifeste n'est pas un objet");
    return anomalies;
  }
  const donnees = /** @type {Record<string, any>} */ (manifeste);

  if (donnees.manifestVersion !== VERSION_MANIFESTE) {
    ajouter(
      "version-inattendue",
      `manifestVersion ${JSON.stringify(donnees.manifestVersion)} au lieu de ${VERSION_MANIFESTE}`,
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}T/.test(donnees.generatedAt ?? "")) {
    ajouter("horodatage-absent", "generatedAt absent ou mal formé");
  }
  for (const champ of ["id", "version", "invariantRecordId", "attachmentSha256"]) {
    if (!donnees.application?.[champ])
      ajouter("application-incomplete", `application.${champ} absent`);
  }
  for (const champ of ["ruby", "rails", "debianSuite"]) {
    if (!donnees.toolchain?.[champ]) ajouter("chaine-incomplete", `toolchain.${champ} absent`);
  }

  const artefacts = Array.isArray(donnees.artifacts) ? donnees.artifacts : [];
  const noms = new Set(artefacts.map((artefact) => artefact?.name));
  for (const attendu of ARTEFACTS_ATTENDUS) {
    if (!noms.has(attendu))
      ajouter("artefact-manquant", `artefact absent du manifeste : ${attendu}`);
  }
  for (const artefact of artefacts) {
    const nom = artefact?.name ?? "(sans nom)";
    if (!/^[0-9a-f]{64}$/.test(artefact?.sha256 ?? "")) {
      ajouter("empreinte-invalide", `${nom} : sha256 absent ou mal formé`);
    }
    if (!Number.isInteger(artefact?.byteSize) || artefact.byteSize <= 0) {
      ajouter("taille-invalide", `${nom} : byteSize absent ou nul`);
    }
    if (!artefact?.license) ajouter("licence-absente", `${nom} : license absente`);
    if (!artefact?.origin) ajouter("origine-absente", `${nom} : origin absente`);
  }

  const attendu = artefacts.reduce((somme, artefact) => somme + (artefact?.byteSize ?? 0), 0);
  if (donnees.totals?.byteSize !== attendu) {
    ajouter(
      "total-incoherent",
      `totals.byteSize ${donnees.totals?.byteSize} au lieu de ${attendu}`,
    );
  }

  for (const role of ["kernel", "initrd", "hda", "hdb", "bios", "vgaBios"]) {
    const nom = donnees.boot?.[role];
    if (!nom) {
      ajouter("boot-incomplet", `boot.${role} absent`);
    } else if (!noms.has(nom)) {
      ajouter("boot-incoherent", `boot.${role} désigne ${nom}, absent des artefacts`);
    }
  }
  if (!donnees.boot?.cmdline) ajouter("boot-incomplet", "boot.cmdline absent");

  return anomalies;
}

/**
 * Compare le manifeste à ce qui est réellement présent sur le disque.
 *
 * @param {Record<string, any>} manifeste
 * @param {Map<string, { byteSize: number, sha256: string }>} observes
 * @returns {Anomalie[]}
 */
export function comparerArtefacts(manifeste, observes) {
  /** @type {Anomalie[]} */
  const differences = [];
  for (const artefact of manifeste.artifacts ?? []) {
    const observe = observes.get(artefact.name);
    if (observe === undefined) {
      differences.push({ code: "artefact-absent", message: `${artefact.name} : absent du disque` });
      continue;
    }
    if (observe.sha256 !== artefact.sha256) {
      differences.push({
        code: "empreinte-differente",
        message: `${artefact.name} : sha256 ${observe.sha256} au lieu de ${artefact.sha256}`,
      });
    }
    if (observe.byteSize !== artefact.byteSize) {
      differences.push({
        code: "taille-differente",
        message: `${artefact.name} : ${observe.byteSize} octets au lieu de ${artefact.byteSize}`,
      });
    }
  }
  return differences;
}
