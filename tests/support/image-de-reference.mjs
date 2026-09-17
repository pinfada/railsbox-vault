// Ce que les scénarios lisent du MANIFESTE D'IMAGE pour piloter le banc (#236, ADR 0041).
//
// Chaque scénario de bout en bout construisait ces objets à la main, et chacun répétait les mêmes
// six lignes. Le passage au paquet applicatif les aurait fait diverger un à un : le disque unique
// `boot.hdb` n'existe plus, `hda` est COMPOSÉ de deux artefacts, et le disque de données naît d'une
// GRAINE. Un seul endroit les dérive désormais du manifeste.

/** @param {Record<string, any>} manifeste @param {string} nom */
function artefact(manifeste, nom) {
  const trouve = manifeste.artifacts.find((candidat) => candidat.name === nom);
  if (trouve === undefined) {
    throw new Error(`artefact « ${nom} » absent du manifeste d'image`);
  }
  return trouve;
}

const PREFIXE = "/artifacts/reference-image/";

/**
 * Les DEUX morceaux du disque système, avec leur empreinte : l'acquisition les range aux décalages
 * du plan et refuse celui dont les octets ne correspondent pas.
 *
 * @param {Record<string, any>} manifeste
 */
export function disqueSystemeDuManifeste(manifeste) {
  const morceau = (role) => {
    const nom = manifeste.boot[role];
    const { byteSize, sha256 } = artefact(manifeste, nom);
    return { url: `${PREFIXE}${nom}`, octets: byteSize, sha256 };
  };
  return { rootfs: morceau("rootfs"), paquet: morceau("paquet") };
}

/**
 * Le RUNTIME que `acquerirRuntime` attend : les artefacts v86 épinglés, les tampons de l'image, et
 * le disque système composé.
 *
 * @param {Record<string, any>} manifeste
 * @param {Map<string, string>} adressesV86
 */
export function runtimeDuManifeste(manifeste, adressesV86) {
  return {
    lib: adressesV86.get("libv86.mjs"),
    wasm: adressesV86.get("v86.wasm"),
    bios: `${PREFIXE}${manifeste.boot.bios}`,
    vgaBios: `${PREFIXE}${manifeste.boot.vgaBios}`,
    kernel: `${PREFIXE}${manifeste.boot.kernel}`,
    initrd: `${PREFIXE}${manifeste.boot.initrd}`,
    disqueSysteme: disqueSystemeDuManifeste(manifeste),
  };
}

/**
 * La GRAINE : ce que le banc verse dans le volume de données, et la taille que ce volume déclare.
 *
 * `appDiskBytes` est la taille du DISQUE (celle du volume), et non celle du fichier servi : les deux
 * coïncident aujourd'hui — la graine est l'image d'un disque entier — mais le volume tient sa taille
 * de `donnees.disqueOctets`, qui est ce que la fabrication a fixé.
 *
 * @param {Record<string, any>} manifeste
 */
export function graineDuManifeste(manifeste) {
  const graine = artefact(manifeste, manifeste.boot.graine);
  return {
    appDiskUrl: `${PREFIXE}${graine.name}`,
    appDiskBytes: manifeste.donnees.disqueOctets,
    fichierOctets: graine.byteSize,
    sha256: graine.sha256,
  };
}
