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
  "seabios.bin",
  "vgabios.bin",
]);

/**
 * Artefacts du PAQUET APPLICATIF, dont les noms portent leur empreinte (#236, ADR 0041) : ils ne
 * peuvent donc pas être énumérés à l'avance. Le manifeste les désigne par leur RÔLE — `boot.paquet`
 * et `boot.graine` —, et la validation exige que ces deux rôles trouvent un artefact.
 *
 * `reference-app.ext4` a disparu avec eux : le disque unique qui portait à la fois le code et les
 * données n'existe plus.
 */
export const ROLES_DU_PAQUET = Object.freeze(["paquet", "graine"]);

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
  paquet,
  precedent = null,
  rootfsServi = null,
  rails,
  environnement,
  genereLe,
}) {
  const tries = [...artefacts].sort((gauche, droite) => gauche.name.localeCompare(droite.name));
  return {
    manifestVersion: VERSION_MANIFESTE,
    generatedAt: genereLe,
    application: {
      id: paquet.application.id,
      version: paquet.application.version,
      // Le SCHÉMA de la base que la graine porte : la dernière migration appliquée à la
      // fabrication. C'est lui que T2 comparera à celui du volume pour décider d'une mise à jour.
      schema: paquet.application.schema,
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
      // `hda` n'est plus UN artefact : la coquille le COMPOSE (MBR calculé, partition 1 = rootfs,
      // partition 2 = paquet ; `src/vm/disque-compose.mjs`). Les deux morceaux gardent leur adresse
      // par empreinte, et une mise à jour de l'application ne retélécharge pas le rootfs.
      rootfs: "reference-rootfs.ext4",
      paquet: paquet.image.name,
      // La GRAINE n'est pas un disque du guest : c'est ce que la coquille verse dans le volume
      // `application` du coffre à l'installation. Le guest la voit ensuite en `hdb` (`/dev/sdb`).
      graine: paquet.graine.name,
      bios: "seabios.bin",
      vgaBios: "vgabios.bin",
      // Les fichiers SERVIS (#236 T2) : chaque morceau voyage en gzip, sous un nom qui porte
      // l'empreinte de l'image décompressée. Absents d'un manifeste d'avant T2.
      ...(rootfsServi === null
        ? {}
        : {
            servis: {
              rootfs: rootfsServi,
              paquet: paquet.image.servi?.name ?? null,
              graine: paquet.graine.servi?.name ?? null,
            },
          }),
    },
    // La RÉTENTION 1 (#236 T2, ADR 0042) : le paquet PRÉCÉDENT, gardé servable pour que « Plus tard »
    // ouvre un coffre sur sa version. Sa graine est gardée aussi : elle fait naître un coffre de cette
    // version, ce que les épreuves de mise à jour exigent.
    ...(precedent === null
      ? {}
      : {
          precedent: {
            application: {
              // L'IDENTITÉ du précédent, que la coquille confronte au courant (QA de #249, Q4).
              id: precedent.application.id,
              version: precedent.application.version,
              schema: precedent.application.schema,
            },
            paquet: precedent.image.name,
            graine: precedent.graine.name,
            servis: { paquet: precedent.image.servi.name, graine: precedent.graine.servi.name },
          },
        }),
    /** Le disque de DONNÉES du coffre : taille fixe, fixée à la fabrication de la graine. */
    donnees: { disqueOctets: paquet.graine.disqueOctets },
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
  for (const champ of ["id", "version", "schema", "invariantRecordId", "attachmentSha256"]) {
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

  if (!Number.isInteger(donnees.donnees?.disqueOctets) || donnees.donnees.disqueOctets <= 0) {
    ajouter("donnees-incompletes", "donnees.disqueOctets absent ou nul");
  }

  for (const role of ["kernel", "initrd", "rootfs", "paquet", "graine", "bios", "vgaBios"]) {
    const nom = donnees.boot?.[role];
    if (!nom) {
      ajouter("boot-incomplet", `boot.${role} absent`);
    } else if (!noms.has(nom)) {
      ajouter("boot-incoherent", `boot.${role} désigne ${nom}, absent des artefacts`);
    }
  }
  if (!donnees.boot?.cmdline) ajouter("boot-incomplet", "boot.cmdline absent");
  const servis = [
    ...Object.values(donnees.boot?.servis ?? {}),
    ...Object.values(donnees.precedent ?? {}).filter((valeur) => typeof valeur === "string"),
    ...Object.values(donnees.precedent?.servis ?? {}),
  ];
  for (const nom of servis) {
    if (!noms.has(nom)) ajouter("servi-incoherent", `${nom} est désigné, absent des artefacts`);
  }

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
