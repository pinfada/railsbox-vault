// L'ACQUISITION des artefacts du démarrage : ce que le boot va chercher AVANT d'ouvrir quoi que ce
// soit — module v86, wasm, BIOS, noyau, initrd, rootfs, paquet (#255).
//
// Scindé de `boot-de-reference.mjs` (700 lignes, seuil d'alerte) : ce module ne boote rien, il
// TÉLÉCHARGE et CONFRONTE aux empreintes du descripteur. Et c'est ici, au seul endroit qui sait de
// quoi il parle, que les échecs d'acquisition sont MARQUÉS — plus loin, la coquille ne savait plus
// distinguer « cette adresse n'a pas servi l'application » d'une panne quelconque, et rendait le
// fourre-tout que le projet a banni ailleurs (#240, #244 ; contrôle QA du 20/09/2026, rootfs en 403).

import { acquerirLeDisqueSysteme } from "./acquisition-du-disque-systeme.mjs";
import { verifierEmpreintesV86, verifierLeModuleV86 } from "./empreintes-du-runtime-v86.mjs";
import { empreinteDeLImage } from "./instantane-du-boot.mjs";
import { exigerContexteExecutable } from "./runtime-environment.mjs";

/**
 * MARQUE un échec d'ACQUISITION, et laisse passer tout le reste.
 *
 * Une acquisition refusée, coupée ou altérée jette une erreur ORDINAIRE, sans code : c'est ce
 * marquage, et lui seul, qui permet à la coquille de dire ensuite que l'adresse n'a pas fourni
 * l'application. Les erreurs TYPÉES nomment déjà ce qui s'est passé et ressortent intactes ;
 * l'erreur d'origine reste sous `cause`, où le détail technique se relit.
 *
 * @param {() => Promise<unknown>} acquerir
 */
export async function marquerLAcquisitionDesArtefacts(acquerir) {
  try {
    return await acquerir();
  } catch (erreur) {
    if (erreur?.code !== undefined) throw erreur;
    throw Object.assign(new Error(erreur?.message ?? "cause inconnue"), {
      artefactDuDemarrage: true,
      cause: erreur,
    });
  }
}

async function fetchBytes(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Artefact ${url} indisponible (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/**
 * Charge les tampons du runtime. Les DONNÉES n'en font PAS partie : elles vivent dans OPFS.
 *
 * Le disque système (`hda`) n'est plus un artefact mais une COMPOSITION : le rootfs et le paquet
 * applicatif, chacun servi sous son empreinte, rangés aux décalages d'un tampon partitionné
 * (#236, ADR 0041). Les deux morceaux restent exposés comme artefacts — ce sont eux, et non le
 * disque composé, que l'empreinte d'image et la liaison d'un instantané nomment.
 */
async function loadRuntime(runtime) {
  const [wasm, bios, vgaBios, kernel, initrd] = await Promise.all([
    fetchBytes(runtime.wasm),
    fetchBytes(runtime.bios),
    fetchBytes(runtime.vgaBios),
    fetchBytes(runtime.kernel),
    fetchBytes(runtime.initrd),
  ]);
  const disqueSysteme = await acquerirLeDisqueSysteme(runtime.disqueSysteme);
  const artifacts = {
    wasm,
    bios,
    vgaBios,
    kernel,
    initrd,
    rootfs: disqueSysteme.vues.rootfs,
    paquet: disqueSysteme.vues.paquet,
    // Ce que v86 reçoit en `hda` : le disque ENTIER, table de partitions comprise. Il n'entre pas
    // dans l'empreinte d'image — ses deux morceaux y sont déjà, et la table est calculée.
    disqueSysteme: disqueSysteme.tampon,
  };
  const transferredBytes =
    wasm.byteLength +
    bios.byteLength +
    vgaBios.byteLength +
    kernel.byteLength +
    initrd.byteLength +
    disqueSysteme.mesures.transfereOctets;
  const empreintesV86Ms = await verifierEmpreintesV86(runtime, artifacts);
  return { artifacts, transferredBytes, empreintesV86Ms, disqueSysteme: disqueSysteme.mesures };
}

/** Importe la classe V86, ses octets AYANT ÉTÉ confrontés au manifeste (#123). */
async function importV86(libUrl) {
  await verifierLeModuleV86(libUrl, fetchBytes);
  const module = await import(libUrl);
  return module.V86;
}

/**
 * Acquiert TOUT ce qui vient du réseau : la classe V86 et les tampons du runtime. Chaque échec sans
 * code en ressort MARQUÉ, quel que soit l'appelant — le boot comme la reprise hors ligne (#255).
 */
export function acquerirRuntime(runtime) {
  return marquerLAcquisitionDesArtefacts(() => acquerirLesArtefacts(runtime));
}

async function acquerirLesArtefacts(runtime) {
  await exigerContexteExecutable();
  const V86 = await importV86(runtime.lib);
  const { artifacts, transferredBytes, empreintesV86Ms, disqueSysteme } =
    await loadRuntime(runtime);
  // L'EMPREINTE DE L'IMAGE est prise ICI, sur les octets tout juste acquis, et jamais plus tard.
  // Le rootfs est un tampon que le guest ÉCRIT (#65) : le hacher après un boot donnerait l'empreinte
  // d'une session, pas celle d'une image. Le défaut est tombé sur le scénario de bout en bout de
  // #65 — la reprise écartait l'instantané au motif ECART_IMAGE, sur la même image exactement.
  return {
    V86,
    artifacts,
    transferredBytes,
    empreintesV86Ms,
    disqueSysteme,
    empreinteImage: await empreinteDeLImage(artifacts),
  };
}
