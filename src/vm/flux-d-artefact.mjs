// Le FLUX d'un artefact servi, décompressé s'il le faut (#236 T2, #241, ADR 0041 note du 19/09/2026).
//
// Les trois morceaux d'une application — rootfs, paquet, graine — sont PRÉCOMPRESSÉS à la fabrication
// en gzip standard (RFC 1952, déterministe : `gzip -n`, niveau fixé) et servis tels quels, en
// `application/octet-stream`, SANS `Content-Encoding` : c'est ce module, et non le navigateur, qui
// décompresse, par `DecompressionStream("gzip")` — livré par les trois moteurs. Un en-tête
// `Content-Encoding` ferait décoder le navigateur d'abord : `DecompressionStream` recevrait l'image
// brute et la REFUSERAIT (en-tête gzip absent) — un refus propre, mais une panne permanente chez un
// hébergeur qui ajoute l'en-tête (revue de sécurité de la PR #249, LOW).
//
// Ce qui ne change pas, et c'est voulu : `octets` et `sha256` décrivent l'image DÉCOMPRESSÉE, que
// l'appelant hache au fil de l'eau comme avant. Ce module ne garde que ce qui est propre au
// transport : la taille COMPRESSÉE annoncée (`transfertOctets`) est exigée à l'octet, et la
// décompression est bornée par l'appelant (« plus d'octets que l'image annonce » — l'anti-bombe).
//
// Le mode de cache ne change PAS (`no-store`, comme avant) : les caches HTTP des moteurs refusent ou
// bornent des entrées de cette taille (Firefox : 50 Mo ; Chromium : un huitième du cache). Un magasin
// d'artefacts OPFS adressé par empreinte est le chantier qui les remplacera (hors #236).

import { RUNTIME_ERROR_CODES, RuntimeError } from "./runtime-errors.mjs";

/** La seule compression admise. Absente, l'artefact est servi brut. */
export const COMPRESSION_GZIP = "gzip";

/** Un flux qui COMPTE ce qui le traverse et refuse de dépasser `plafond`. */
function compteur(plafond, nom) {
  let vu = 0;
  const flux = new TransformStream({
    transform(morceau, controleur) {
      vu += morceau.byteLength;
      if (vu > plafond) {
        controleur.error(
          new Error(`Artefact ${nom} refusé : plus de ${plafond} octets compressés reçus.`),
        );
        return;
      }
      controleur.enqueue(morceau);
    },
  });
  return { flux, vu: () => vu };
}

/**
 * OUVRE le flux d'un artefact et rend son LECTEUR — décompressé si le morceau le déclare — et une
 * fonction qui CLÔT le transport : elle exige, une fois le flux lu jusqu'au bout, que la taille
 * transférée soit celle que le descripteur annonce.
 *
 * @param {{ url: string, compression?: string | null, transfertOctets?: number | null,
 *           sha256?: string }} morceau
 * @param {{ nom: string, recuperer?: typeof fetch, portee?: typeof globalThis }} options
 * @returns {Promise<{ lecteur: ReadableStreamDefaultReader<Uint8Array>,
 *                     clore: (recus: number) => number }>} `clore` reçoit les octets DÉCOMPRESSÉS
 *   lus par l'appelant et rend les octets TRANSFÉRÉS
 */
export async function ouvrirLeFluxDArtefact(
  morceau,
  { nom, recuperer = globalThis.fetch, portee = globalThis },
) {
  const compression = morceau.compression ?? null;
  if (compression !== null && compression !== COMPRESSION_GZIP) {
    throw new Error(
      `Artefact ${nom} refusé : compression inconnue ${JSON.stringify(compression)}.`,
    );
  }
  if (compression !== null && typeof portee.DecompressionStream !== "function") {
    throw new RuntimeError(
      RUNTIME_ERROR_CODES.decompressionUnavailable,
      `Ce navigateur ne sait pas décompresser l'artefact ${nom} (DecompressionStream absent).`,
      { artefact: nom },
    );
  }
  const reponse = await recuperer(morceau.url, { cache: "no-store" });
  if (!reponse.ok || reponse.body === null) {
    throw new Error(`Artefact ${nom} (${morceau.url}) indisponible (${reponse.status}).`);
  }
  // Brut, le flux est lu tel quel : ce qui est transféré est ce que l'appelant a reçu.
  if (compression === null) return { lecteur: reponse.body.getReader(), clore: (recus) => recus };
  const plafond = morceau.transfertOctets;
  const compte = compteur(plafond, nom);
  const lecteur = reponse.body
    .pipeThrough(compte.flux)
    .pipeThrough(new portee.DecompressionStream(COMPRESSION_GZIP))
    .getReader();
  return {
    lecteur,
    clore: () => {
      // Le flux a été lu jusqu'au bout : le compte est définitif.
      if (compte.vu() !== plafond) {
        throw new Error(
          `Artefact ${nom} refusé : ${compte.vu()} octets compressés reçus, le descripteur en annonce ${plafond}.`,
        );
      }
      return compte.vu();
    },
  };
}
