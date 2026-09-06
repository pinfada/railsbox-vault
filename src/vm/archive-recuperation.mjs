// La SECTION DE RÉCUPÉRATION d'une archive v2 : des octets OPAQUES et leur empreinte (#149, ADR 0027).
//
// Ce module tient la moitié « conteneur » de ce que l'ADR 0027 ajoute à l'archive de l'ADR 0008 :
// la forme du descripteur que l'en-tête déclare, la normalisation de ce que l'export reçoit, et la
// vérification de l'empreinte à la relecture. Il ne sait RIEN de ce que ces octets contiennent —
// ni page, ni emplacement, ni type de clé, ni voisin d'enveloppe. C'est délibéré, et c'est la moitié de
// la propriété que l'ADR 0027 conserve de l'ADR 0020 décision 6 : la construction de l'enveloppe
// vit dans UN module qui tient la clé de volume (`enveloppe-de-recuperation.mjs`), et le chemin
// d'archive reste aveugle.
//
// La disposition d'une archive v2 est celle de la v1 avec une section de plus, en queue :
//
//   [ marqueur 8 o ][ longueur d'en-tête 4 o ][ en-tête JSON H o ][ contenu N o ][ récupération R o ]
//
// La section est en QUEUE, et non entre l'en-tête et le contenu : l'export reste une écriture
// séquentielle en un seul passage, et la restauration continue de lire le contenu à un offset
// qu'elle connaît dès l'en-tête. Une section intercalée aurait décalé le contenu de tous les
// lecteurs, y compris ceux d'une archive v1, pour ranger 8 kio.
//
// `recovery: null` est ADMIS et signifiant : le volume exporté n'a aucun moyen de récupération, et
// l'archive ne s'ouvrira nulle part ailleurs. C'est un fait à dire à l'exploitant, pas un défaut à
// taire ni un refus à opposer — refuser exporterait moins que ce que l'utilisateur possède.

import { ARCHIVE_ERROR_CODES, ArchiveError } from "./archive-errors.mjs";
import { createSha256Stream } from "./sha256-stream.mjs";

/**
 * Plafond de la section, en octets. Il est posé ICI, sans importer la taille d'une page
 * d'enveloppe : ce module reste aveugle au contenu, et une borne empruntée au format d'enveloppe
 * lui ferait connaître ce qu'il transporte. 64 kio laissent huit fois la place d'une page, et
 * bornent une allocation faite avant toute vérification.
 */
export const MAX_RECOVERY_BYTES = 64 * 1024;

/** Refus typé d'une section altérée : l'empreinte recalculée diffère de celle inscrite. */
function alteree(message, contexte) {
  return new ArchiveError(
    ARCHIVE_ERROR_CODES.recuperationAlteree,
    `Section de récupération altérée : ${message}`,
    contexte,
  );
}

/** Refus typé d'une section dont la DÉCLARATION est inadmissible. */
function refusee(message, contexte) {
  return new ArchiveError(
    ARCHIVE_ERROR_CODES.recuperationRefusee,
    `Section de récupération refusée : ${message}`,
    contexte,
  );
}

/** SHA-256 des octets, en hexadécimal minuscule. */
export function empreinteDeSection(octets) {
  const hash = createSha256Stream();
  hash.update(octets);
  return hash.digestHex();
}

/**
 * NORMALISE ce que l'export reçoit, et rend les octets à écrire avec le descripteur à déclarer.
 *
 * L'empreinte est RECALCULÉE ici, et confrontée à celle que l'appelant annonce quand il en annonce
 * une. L'archive ne doit jamais inscrire une empreinte qu'elle n'a pas vérifiée : elle serait alors
 * la seule chose qu'un import ne pourrait pas contrôler, puisqu'il n'a que l'archive.
 *
 * @param {{ octets: Uint8Array, digest?: string, version: number, emplacements: number } | null} recovery
 * @returns {{ octets: Uint8Array, descripteur: object } | null}
 */
export function normaliserRecuperation(recovery) {
  if (recovery === null || recovery === undefined) return null;
  const octets = recovery.octets;
  if (!(octets instanceof Uint8Array) || octets.byteLength === 0) {
    throw new TypeError(
      "L'enveloppe de récupération d'un export est un Uint8Array non vide d'octets opaques.",
    );
  }
  if (octets.byteLength > MAX_RECOVERY_BYTES) {
    throw refusee(
      `${octets.byteLength} octets à écrire, pour un plafond de ${MAX_RECOVERY_BYTES}.`,
      { length: octets.byteLength, plafond: MAX_RECOVERY_BYTES },
    );
  }
  entierPositif("version", recovery.version);
  entierPositif("emplacements", recovery.emplacements);

  const digest = empreinteDeSection(octets);
  if (typeof recovery.digest === "string" && recovery.digest !== digest) {
    throw alteree(
      `l'empreinte annoncée (${recovery.digest}) n'est pas celle des octets remis (${digest}).`,
      { annoncee: recovery.digest, calculee: digest },
    );
  }
  return {
    octets,
    descripteur: {
      length: octets.byteLength,
      digest,
      envelopeVersion: recovery.version,
      slots: recovery.emplacements,
    },
  };
}

function entierPositif(nom, valeur) {
  if (!Number.isInteger(valeur) || valeur < 1) {
    throw new TypeError(
      `L'enveloppe de récupération d'un export doit déclarer « ${nom} » comme un entier ≥ 1, reçu ${JSON.stringify(valeur)}.`,
    );
  }
}

/**
 * VALIDE le descripteur porté par l'en-tête d'une archive v2, et rend `null` si l'archive n'en
 * déclare pas.
 *
 * Le contrôle est STRICT : une déclaration à moitié plausible est refusée plutôt que complétée.
 * L'en-tête est la seule chose qu'on croit avant d'avoir vérifié quoi que ce soit, et lui laisser
 * une valeur négociable ferait dépendre l'arithmétique de la disposition d'un champ qu'on n'a pas
 * regardé.
 */
export function validerDescripteurDeRecuperation(recovery) {
  if (recovery === null || recovery === undefined) return null;
  if (typeof recovery !== "object" || Array.isArray(recovery)) {
    throw refusee("le descripteur de l'en-tête n'est pas un objet.", {});
  }
  if (!Number.isInteger(recovery.length) || recovery.length < 1) {
    throw refusee(`longueur inadmissible : ${JSON.stringify(recovery.length)}.`, {
      length: recovery.length ?? null,
    });
  }
  if (recovery.length > MAX_RECOVERY_BYTES) {
    throw refusee(
      `longueur de ${recovery.length} octets au-delà du plafond de ${MAX_RECOVERY_BYTES}.`,
      {
        length: recovery.length,
        plafond: MAX_RECOVERY_BYTES,
      },
    );
  }
  if (typeof recovery.digest !== "string" || !/^[0-9a-f]{64}$/.test(recovery.digest)) {
    throw refusee(
      "empreinte absente ou hors forme (SHA-256 en hexadécimal minuscule attendu).",
      {},
    );
  }
  if (!Number.isInteger(recovery.envelopeVersion) || recovery.envelopeVersion < 1) {
    throw refusee(
      `version d'enveloppe inadmissible : ${JSON.stringify(recovery.envelopeVersion)}.`,
      { envelopeVersion: recovery.envelopeVersion ?? null },
    );
  }
  if (!Number.isInteger(recovery.slots) || recovery.slots < 1) {
    throw refusee(`nombre d'emplacements inadmissible : ${JSON.stringify(recovery.slots)}.`, {
      slots: recovery.slots ?? null,
    });
  }
  return Object.freeze({
    length: recovery.length,
    digest: recovery.digest,
    envelopeVersion: recovery.envelopeVersion,
    slots: recovery.slots,
  });
}

/**
 * LIT la section et confronte son empreinte à celle que l'en-tête déclare. Rend les octets.
 *
 * Elle est lue en UNE fois, et c'est admissible ici et nulle part ailleurs dans ce chemin : la
 * longueur est bornée par `MAX_RECOVERY_BYTES` AVANT la lecture, si bien que l'allocation ne dépend
 * pas d'un nombre que l'archive a choisi. Le contenu du volume, lui, reste lu par blocs.
 *
 * @param {{ read: Function, byteLength: number, offset: number, descripteur: object }} appel
 * @returns {Promise<Uint8Array>}
 */
export async function lireEtVerifierLaRecuperation({ read, byteLength, offset, descripteur }) {
  const fin = offset + descripteur.length;
  if (byteLength < fin) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.truncated,
      `Archive tronquée : la section de récupération déclare ${descripteur.length} octet(s) à l'offset ${offset}, et l'archive n'en compte que ${byteLength}.`,
      { offset, length: descripteur.length, byteLength },
    );
  }
  const octets = await read(offset, descripteur.length);
  if (!(octets instanceof Uint8Array) || octets.byteLength !== descripteur.length) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.truncated,
      `Archive tronquée : lecture courte de la section de récupération — ${octets?.byteLength} octet(s) rendus sur ${descripteur.length} à ${offset}.`,
      { offset, length: descripteur.length, obtained: octets?.byteLength ?? null },
    );
  }
  const calculee = empreinteDeSection(octets);
  if (calculee !== descripteur.digest) {
    throw alteree(`recalculée ${calculee}, inscrite ${descripteur.digest}.`, {
      computed: calculee,
      declared: descripteur.digest,
    });
  }
  return octets;
}
