// La COMPRESSION des morceaux servis : gzip standard, déterministe (#236 T2, ADR 0041 note du 19/09).
//
// Les trois morceaux d'une application — rootfs, paquet, graine — voyagent en gzip (RFC 1952), que les
// trois moteurs décompressent par `DecompressionStream("gzip")`. Mesuré sur les artefacts réels :
// rootfs 385 → 128 Mio, paquet 137 → 48, graine 512 → 0,5 ; premier démarrage 1 034 → 177 Mio.
//
// DÉTERMINISTE, parce qu'un artefact servi sous une adresse qui porte son empreinte doit se refabriquer
// à l'octet (#212) : niveau 9 fixé, en-tête sans nom ni date (zlib n'en pose pas), et l'octet « OS » de
// l'en-tête forcé à 255 (« inconnu ») — zlib y écrit le système qui compresse, et un même disque
// compressé sous Windows et sous Linux aurait eu deux empreintes. Aucun champ de l'en-tête n'est
// couvert par une somme de contrôle : ce changement n'invalide rien.

import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, openSync, closeSync, writeSync } from "node:fs";
import { stat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGzip } from "node:zlib";

/** Le niveau de compression, fixé : un autre niveau rendrait d'autres octets. */
export const NIVEAU_GZIP = 9;

/** Position de l'octet « OS » dans l'en-tête gzip (RFC 1952, § 2.3). */
const OCTET_OS = 9;

/** « Système inconnu » : la seule valeur qui ne dépend pas de la machine qui compresse. */
const OS_INCONNU = 0xff;

/**
 * COMPRESSE `source` vers `destination` et rend la taille et l'empreinte du fichier COMPRESSÉ.
 *
 * @param {string} source @param {string} destination
 * @returns {Promise<{ byteSize: number, sha256: string }>}
 */
export async function compresserDeterministe(source, destination) {
  await pipeline(
    createReadStream(source),
    createGzip({ level: NIVEAU_GZIP }),
    createWriteStream(destination),
  );
  const descripteur = openSync(destination, "r+");
  try {
    writeSync(descripteur, Uint8Array.of(OS_INCONNU), 0, 1, OCTET_OS);
  } finally {
    closeSync(descripteur);
  }
  return mesurerEnFlux(destination);
}

/**
 * Taille et empreinte d'un fichier, en flux : un rootfs de 385 Mio ne se lit pas d'un bloc.
 *
 * @param {string} chemin
 * @returns {Promise<{ byteSize: number, sha256: string }>}
 */
export async function mesurerEnFlux(chemin) {
  const empreinte = createHash("sha256");
  for await (const morceau of createReadStream(chemin)) empreinte.update(morceau);
  return { byteSize: (await stat(chemin)).size, sha256: empreinte.digest("hex") };
}

/**
 * Le NOM SERVI d'un morceau compressé : le nom de l'image, qui porte déjà le préfixe de son empreinte
 * pour le paquet et la graine, suivi de `.gz`. Le rootfs, dont le nom local est fixe
 * (`reference-rootfs.ext4`, lu par les harnais), reçoit ici le préfixe de SON empreinte : un nom servi
 * désigne toujours un seul contenu.
 *
 * @param {string} nomImage @param {string} sha256Image empreinte de l'image DÉCOMPRESSÉE
 */
export function nomServi(nomImage, sha256Image) {
  const prefixe = sha256Image.slice(0, 8);
  if (nomImage.includes(prefixe)) return `${nomImage}.gz`;
  return nomImage.replace(/(\.ext[234])?$/, (extension) => `-${prefixe}${extension}.gz`);
}
