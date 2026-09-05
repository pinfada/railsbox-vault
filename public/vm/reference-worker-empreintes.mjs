// Vérification d'empreinte AU CHARGEMENT sur le chemin de boot de l'image de référence (#123).
//
// Extraite de `reference-worker-boot.mjs` : c'est une préoccupation de PROVENANCE, elle s'exerce
// avant que l'émulateur existe, et elle a sa propre raison d'être — l'adresse d'un artefact n'en
// nomme que seize caractères hexadécimaux, le manifeste en épingle soixante-quatre.
//
// Ce que ces vérifications attrapent est l'ACCIDENT : un cache qui garde un artefact à côté d'un
// manifeste d'une autre version, un intermédiaire qui touche le `.wasm` sans toucher au `.mjs`, un
// dépôt partiel, un octet retourné en chemin. Un cache d'un an les rend plus probables, pas moins.
// Ce qu'elles n'attrapent pas est une origine qui ment aux deux du même geste : cette défense-là est
// `verifierEpinglageV86`, sur l'arbre construit à partir d'un commit, avant qu'il ne parte.

import { artefactALAdresse, chargerAdressesV86, verifierOctetsV86 } from "/src/v86-adresses.mjs";

/**
 * Les artefacts que ce banc reçoit, dans l'ordre où `loadRuntime` les rend.
 *
 * Sept URL toutes faites arrivent ici, dont DEUX seulement sont des artefacts v86 : les autres
 * viennent de l'image de référence (#5), qui a son propre manifeste et son propre épinglage.
 * `artefactALAdresse` dit lesquelles relèvent de celui-ci ; ce qui n'en relève pas n'est pas vérifié
 * ICI, et ce n'est pas un silence — c'est un autre épinglage, hors du périmètre de #123.
 */
const TAMPONS_DU_RUNTIME = ["wasm", "bios", "vgaBios", "kernel", "initrd", "rootfs"];

/**
 * Confronte aux 256 bits du manifeste v86 les octets déjà reçus, et REND LE PRIX PAYÉ.
 *
 * Le coût est rendu plutôt que seulement payé : c'est la mesure que la revue de sécurité demande sur
 * le chemin de boot RÉEL, et elle entre dans la décomposition (#60) sous `empreintesV86Ms`. Un prix
 * qu'on ne relève pas ne se discute pas.
 *
 * @param {Record<string, string>} runtime adresses, telles que l'appelant les a reçues
 * @param {Record<string, Uint8Array>} artifacts octets correspondants
 * @returns {Promise<number>} millisecondes passées à hacher
 */
export async function verifierEmpreintesV86(runtime, artifacts) {
  const debut = performance.now();
  const { manifeste } = await chargerAdressesV86();
  for (const cle of TAMPONS_DU_RUNTIME) {
    const artefact = artefactALAdresse(manifeste, runtime[cle]);
    if (artefact !== null) await verifierOctetsV86(artifacts[cle], artefact, runtime[cle]);
  }
  return Number((performance.now() - debut).toFixed(1));
}

/**
 * Vérifie le module de l'émulateur AVANT de l'importer, s'il relève du manifeste v86.
 *
 * `import()` ne rend pas d'octets — le chargeur de modules va les chercher lui-même —, si bien que
 * la vérification passe par une récupération préalable à la même adresse ; la seconde demande est
 * servie par le cache HTTP, que #123 rend long et immuable pour cette adresse-là.
 *
 * Reste ouvert, et il faut le nommer : entre la vérification et l'import, une origine HOSTILE
 * pourrait servir d'autres octets. Cette vérification défend contre l'ACCIDENT, pas contre
 * l'origine — et un accident ne change pas de réponse entre deux requêtes.
 *
 * @param {string} adresse
 * @param {(url: string) => Promise<Uint8Array>} lireOctets
 */
export async function verifierLeModuleV86(adresse, lireOctets) {
  const { manifeste } = await chargerAdressesV86();
  const artefact = artefactALAdresse(manifeste, adresse);
  if (artefact === null) return null;
  return verifierOctetsV86(await lireOctets(adresse), artefact, adresse);
}
