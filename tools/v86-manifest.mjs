// Lecture du manifeste des artefacts v86 et vérification d'empreinte. Extrait de `fetch-v86.mjs`
// pour être testable sous Node sans réseau : une empreinte est une règle de provenance, pas de la
// plomberie HTTP.

import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const TAR_BLOCK_SIZE = 512;

/** Empreinte SHA-256 hexadécimale d'un contenu binaire. */
export function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * Compare un contenu au descripteur d'artefact attendu.
 * @param {{ name: string, bytes: number, sha256: string }} artifact
 * @param {Uint8Array | null} content contenu lu, ou `null` si le fichier est absent
 * @returns {{ name: string, status: "ok" | "missing" | "size" | "digest",
 *             expected: string, actual: string }}
 */
export function verifyArtifact(artifact, content) {
  if (content === null) {
    return { name: artifact.name, status: "missing", expected: artifact.sha256, actual: "" };
  }
  if (content.byteLength !== artifact.bytes) {
    return {
      name: artifact.name,
      status: "size",
      expected: String(artifact.bytes),
      actual: String(content.byteLength),
    };
  }
  const actual = sha256(content);
  return {
    name: artifact.name,
    status: actual === artifact.sha256 ? "ok" : "digest",
    expected: artifact.sha256,
    actual,
  };
}

/** Message d'échec explicite pour un verdict de vérification. */
export function describeVerdict(verdict) {
  switch (verdict.status) {
    case "ok":
      return `${verdict.name} : empreinte conforme`;
    case "missing":
      return `${verdict.name} : absent — exécuter « npm run vm:fetch »`;
    case "size":
      return `${verdict.name} : taille inattendue (${verdict.actual} octets au lieu de ${verdict.expected})`;
    case "digest":
      return `${verdict.name} : empreinte SHA-256 inattendue\n  attendue ${verdict.expected}\n  obtenue  ${verdict.actual}`;
    default:
      throw new Error(`Verdict inconnu : ${verdict.status}`);
  }
}

function readOctal(bytes, offset, length) {
  const text = new TextDecoder().decode(bytes.subarray(offset, offset + length));
  const cleaned = text.replace(/\0.*$/s, "").trim();
  return cleaned === "" ? 0 : Number.parseInt(cleaned, 8);
}

function readName(bytes, offset, length) {
  const text = new TextDecoder().decode(bytes.subarray(offset, offset + length));
  return text.replace(/\0.*$/s, "");
}

/**
 * Lecteur tar minimal : suffisant pour un paquet npm, refusant tout ce qu'il ne sait pas lire.
 *
 * Node 22 n'expose aucune API tar et le dépôt n'ajoute pas de dépendance pour cinq fichiers. Les
 * entrées non régulières et les en-têtes illisibles font échouer la lecture au lieu d'être ignorés.
 *
 * @param {Uint8Array} tarBytes archive décompressée
 * @param {Set<string>} wanted chemins recherchés, tels quels
 * @returns {Map<string, Uint8Array>}
 */
export function extractTarEntries(tarBytes, wanted) {
  const found = new Map();
  let offset = 0;

  while (offset + TAR_BLOCK_SIZE <= tarBytes.byteLength) {
    const header = tarBytes.subarray(offset, offset + TAR_BLOCK_SIZE);
    if (header.every((byte) => byte === 0)) break;

    const name = readName(header, 0, 100);
    const size = readOctal(header, 124, 12);
    const typeFlag = String.fromCharCode(header[156]) || "0";

    if (!Number.isInteger(size) || size < 0) {
      throw new Error(`Archive tar illisible : taille invalide pour « ${name} ».`);
    }

    const dataStart = offset + TAR_BLOCK_SIZE;
    if (wanted.has(name)) {
      if (typeFlag !== "0" && typeFlag !== "\0") {
        throw new Error(
          `Entrée tar « ${name} » de type ${typeFlag} : seuls les fichiers sont admis.`,
        );
      }
      if (dataStart + size > tarBytes.byteLength) {
        throw new Error(`Entrée tar « ${name} » tronquée.`);
      }
      found.set(name, tarBytes.subarray(dataStart, dataStart + size));
    }

    offset = dataStart + Math.ceil(size / TAR_BLOCK_SIZE) * TAR_BLOCK_SIZE;
  }

  const missing = [...wanted].filter((name) => !found.has(name));
  if (missing.length > 0) {
    throw new Error(`Entrées absentes de l'archive : ${missing.join(", ")}.`);
  }
  return found;
}

/** Décompresse une archive `.tgz` puis en extrait les entrées demandées. */
export function extractTgzEntries(tgzBytes, wanted) {
  return extractTarEntries(new Uint8Array(gunzipSync(tgzBytes)), wanted);
}

/**
 * Regroupe les artefacts par source à récupérer : une seule archive npm est téléchargée même si
 * elle fournit plusieurs fichiers.
 */
export function planDownloads(artifacts) {
  const tarballs = new Map();
  const direct = [];

  for (const artifact of artifacts) {
    if (artifact.source.kind === "npm-tarball-entry") {
      const group = tarballs.get(artifact.source.url) ?? [];
      group.push(artifact);
      tarballs.set(artifact.source.url, group);
    } else if (artifact.source.kind === "github-raw" || artifact.source.kind === "http") {
      direct.push(artifact);
    } else {
      throw new Error(`Type de source inconnu : ${artifact.source.kind}`);
    }
  }

  return { tarballs, direct };
}
