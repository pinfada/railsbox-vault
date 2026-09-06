// Les deux COMMODITÉS EN MÉMOIRE de l'archive : exporter vers un `Uint8Array`, vérifier un
// `Uint8Array` (#11, #149).
//
// Elles n'ajoutent aucune règle et n'en retirent aucune : elles assemblent un puits et un lecteur
// triviaux au-dessus de `writeArchive` et `readArchive`. Elles vivent à part depuis #149 pour une
// raison de TAILLE et pas de conception — `volume-export.mjs` a franchi le seuil d'alerte de
// `tests/unit/taille-des-fichiers.test.mjs` en accueillant la version 2, et scinder tant que c'est
// un choix libre est exactement ce que ce cliquet demande. La coupure passe où le sens la met : le
// FORMAT et son streaming d'un côté, ce qui tient une archive entière en RAM de l'autre.
//
// Aucun chemin de production ne les emploie, et c'est la propriété qui justifie leur existence :
// une archive de production pèse des centaines de mébioctets, et le budget de surmémoire du dépôt
// (≤ 64 Mio) interdit de la matérialiser. Elles servent aux épreuves et aux doubles déterministes,
// où l'archive fait quelques kio.

import { readArchive, writeArchive } from "./volume-export.mjs";

/**
 * Exporte un volume vers une archive EN MÉMOIRE. Commodité pour les petits volumes (tests, doubles
 * déterministes) : pour un vrai volume, préférer `writeArchive` vers un puits qui n'accumule pas tout
 * en RAM. Le contenu source, lui, reste toujours lu en streaming.
 */
export async function exportVolumeToBytes({
  source,
  manifest,
  consistency,
  recovery = null,
  blockBytes,
}) {
  const chunks = [];
  let total = 0;
  const sink = {
    write(bytes) {
      const copy = bytes.slice();
      chunks.push(copy);
      total += copy.byteLength;
    },
  };
  const result = await writeArchive({ source, sink, manifest, consistency, recovery, blockBytes });
  const archive = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    archive.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { archive, ...result };
}

/**
 * Vérifie une archive tenue EN MÉMOIRE. Recalcule l'empreinte et valide le manifeste ; rend le
 * verdict ou lève un échec typé. Pour une grande archive, préférer `readArchive` sur un lecteur qui
 * ne la tient pas entière en RAM.
 *
 * @param {Uint8Array} bytes
 * @param {{ expectations?: object, blockBytes?: number }} [options]
 */
export async function verifyArchive(
  bytes,
  { expectations = {}, blockBytes, enforceCompatibility = true } = {},
) {
  if (!(bytes instanceof Uint8Array)) {
    throw new TypeError("verifyArchive attend un Uint8Array.");
  }
  const read = (offset, length) => bytes.subarray(offset, offset + length);
  return readArchive({
    read,
    byteLength: bytes.byteLength,
    expectations,
    blockBytes,
    enforceCompatibility,
  });
}
