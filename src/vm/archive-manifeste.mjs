// L'ACCORD du MANIFESTE et du CONTENEUR d'archive (#10, #11, #18 ADR 0016).
//
// Une archive dit deux fois la même chose : son manifeste décrit un volume, son descripteur de
// contenu décrit des octets. Ce module répond à une seule question — **les deux se recoupent-ils ?**
// — et il y répond aux deux bouts : à l'ÉCRITURE, où la source doit correspondre au manifeste qu'on
// s'apprête à inscrire ; à la LECTURE, où le contenu déclaré doit correspondre au manifeste que
// l'archive porte.
//
// Extrait de `volume-export.mjs` par #181, qui a fait franchir à ce fichier le seuil d'alerte de
// `tests/unit/taille-des-fichiers.test.mjs`. La coupure passe où le sens la met : le CODEC du
// conteneur d'un côté — préambule, longueurs, offsets, empreintes —, l'accord du manifeste de
// l'autre. Les deux gestes ci-dessous ne comptent pas un octet ; ils comparent des DÉCLARATIONS.

import { ARCHIVE_ERROR_CODES, ArchiveError } from "./archive-errors.mjs";
import { tailleDeFichier } from "./volume-chiffre-format.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  createManifest,
  parseManifest,
  assertReadable,
} from "./volume-manifest.mjs";

/** Erreur typée de conteneur méconnaissable. */
function malformed(message, context) {
  return new ArchiveError(ARCHIVE_ERROR_CODES.malformed, `Archive malformée : ${message}`, context);
}

/**
 * Rend un manifeste GELÉ identique à `base`, mais dont `identity.digest` porte l'empreinte donnée.
 *
 * Le bloc `volume` du format v3 est reporté TEL QUEL : l'identifiant d'un volume est immuable, et
 * l'archive doit décrire le volume qu'elle porte — pas un volume neuf. Il est absent des formats
 * antérieurs, et `createManifest` refuserait de l'y inscrire.
 */
export function withContentDigest(base, digest) {
  return createManifest({
    formatVersion: base.formatVersion,
    runtime: base.runtime,
    app: base.app,
    volumeSize: base.geometry.volumeSize,
    identity: { algorithm: base.identity.algorithm, digest },
    ...(base.volume === undefined ? {} : { volume: base.volume }),
  });
}

/**
 * Analyse le manifeste fourni et l'accorde à la source. Séparé des contrôles ci-dessus parce que le
 * refus qu'il porte est d'une AUTRE NATURE : un manifeste qui décrit un autre volume que celui qu'on
 * s'apprête à lire est un état de format, refusé par un code typé, et non une faute d'appel.
 */
export function accorderManifesteEtSource(manifest, source) {
  // Le manifeste est validé par #10 (objet, octets ou chaîne acceptés) avant tout usage.
  const base = parseManifest(manifest);
  // La source porte le FICHIER, et le manifeste déclare la géométrie LOGIQUE. Jusqu'à v2 les deux
  // coïncidaient ; en v3 le fichier porte en plus l'en-tête et la région d'authentification, et
  // c'est `tailleDeFichier` qui fait le pont (ADR 0016, décision 7). Comparer la source à la
  // géométrie logique refuserait tout volume chiffré ; ne rien comparer laisserait passer une
  // archive dont le contenu ne correspond à aucun volume descriptible.
  const attendue = tailleDeFichier({
    formatVersion: base.formatVersion,
    tailleLogique: base.geometry.volumeSize,
  });
  if (attendue !== source.size) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.geometryMismatch,
      `Export refusé : le manifeste décrit un volume de ${base.geometry.volumeSize} octet(s) au format v${base.formatVersion}, dont le fichier fait ${attendue} octet(s), mais la source en porte ${source.size}.`,
      {
        manifestVolumeSize: base.geometry.volumeSize,
        formatVersion: base.formatVersion,
        expectedFileSize: attendue,
        sourceSize: source.size,
      },
    );
  }
  return base;
}

/**
 * Accorde le manifeste porté par l'en-tête avec le descripteur de contenu qui l'accompagne, et rend
 * le manifeste validé. Extrait parce que ces contrôles répondent à UNE SEULE question — l'archive
 * dit-elle deux fois la même chose ? — et parce que leur ORDRE est significatif : #10 tranche
 * d'abord la validité du manifeste, la compatibilité ensuite, la concordance interne en dernier.
 */
export function accorderManifesteEtContenu(header, { expectations, enforceCompatibility }) {
  // Manifeste validé par #10 : objet à moitié valide impossible, refus typé propagé.
  const manifest = parseManifest(header.manifest);
  // La compatibilité est vérifiée PAR DÉFAUT, avec ou sans attentes fournies : un contrôle qui ne
  // s'exécute que si l'appelant pense à le demander n'est pas un contrôle. Sans attentes, la plage
  // de formats de ce runtime (`DEFAULT_SUPPORTED_FORMAT`) s'applique déjà. La dérogation existe pour
  // un outil de DIAGNOSTIC — lire un conteneur qu'on ne saurait pas ouvrir en écriture —, mais elle
  // doit être demandée, nommément.
  if (enforceCompatibility) {
    assertReadable(manifest, expectations);
  }

  const contentLength = header.content.length;
  // Le contenu d'une archive est un FICHIER de volume : jusqu'à v2 il coïncidait avec la géométrie
  // logique, en v3 il porte en plus l'en-tête et la région d'authentification (ADR 0016). La
  // longueur attendue est donc DÉRIVÉE du format déclaré, jamais lue de l'en-tête — sans quoi une
  // archive pourrait s'auto-déclarer cohérente.
  //
  // **Un format FUTUR échappe à ce contrôle, et il le faut.** La disposition d'un format qu'on ne
  // connaît pas ne se devine pas : lui appliquer la règle du nôtre inventerait une incohérence là
  // où il n'y a qu'une ignorance, et l'outil de DIAGNOSTIC — seul à pouvoir arriver ici, par une
  // dérogation nommée — recevrait « archive incohérente » au lieu de « format que je ne sais pas
  // lire ». Sans la dérogation, `assertReadable` a déjà refusé plus haut.
  const attendue =
    manifest.formatVersion > MANIFEST_FORMAT_VERSION
      ? contentLength
      : tailleDeFichier({
          formatVersion: manifest.formatVersion,
          tailleLogique: manifest.geometry.volumeSize,
        });
  if (contentLength !== attendue) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.geometryMismatch,
      `Longueur de contenu (${contentLength}) incohérente avec la géométrie du manifeste : un volume de ${manifest.geometry.volumeSize} octet(s) au format v${manifest.formatVersion} occupe un fichier de ${attendue} octet(s).`,
      {
        contentLength,
        volumeSize: manifest.geometry.volumeSize,
        formatVersion: manifest.formatVersion,
        expectedFileSize: attendue,
      },
    );
  }
  if (manifest.identity.digest !== header.content.digest) {
    throw malformed("le digest du manifeste et celui de l'en-tête divergent.", {
      manifestDigest: manifest.identity.digest,
      headerDigest: header.content.digest,
    });
  }
  return manifest;
}
