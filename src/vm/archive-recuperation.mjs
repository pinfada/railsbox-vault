// La SECTION DE RÉCUPÉRATION d'une archive v2 : des octets OPAQUES et leur empreinte (#149, ADR 0027).
//
// Ce module tient la moitié « conteneur » de ce que l'ADR 0027 ajoute à l'archive de l'ADR 0008 :
// la forme du descripteur que l'en-tête déclare, la normalisation de ce que l'export reçoit, la
// vérification de l'empreinte à la relecture, et — depuis la revue de format de la PR #160 — la
// GARDE DE FORME de la section, dans les DEUX sens.
//
// ## Un seul validateur, appelé aux trois portes
//
// La première rédaction ne gardait la forme qu'à l'IMPORT : `writeArchive` acceptait d'écrire
// n'importe quels octets sous l'étiquette « enveloppe de récupération », et `verifyArchive` rendait
// un verdict vert sur une section de cent octets de bourrage. Une archive ainsi produite se
// vérifiait, se transportait, et n'était refusée qu'au moment de restaurer — c'est-à-dire au pire
// endroit et au pire moment. `exigerEnveloppeDeRecuperationSeule` est donc appelée ICI, à
// l'écriture comme à la lecture, et l'import n'ajoute plus que les CONFRONTATIONS qu'il est seul à
// pouvoir faire — l'en-tête contre la page, et l'identité du manifeste contre celle que la racine
// authentifie.
//
// Ce que ce module ne sait toujours pas : le voisin d'enveloppe, où il vit, comment il s'écrit. Il
// valide une FORME et rend des octets ; la construction, elle, vit dans UN module qui tient la clé
// de volume (`enveloppe-de-recuperation.mjs`), et c'est la moitié de l'ADR 0020 décision 6 que
// l'ADR 0027 conserve.
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
import { exigerEnveloppeDeRecuperationSeule } from "./enveloppe-de-recuperation.mjs";
import { createSha256Stream } from "./sha256-stream.mjs";

/**
 * Plafond de la section, en octets. **Ce n'est pas la taille admissible d'une section**, c'est la
 * borne d'une ALLOCATION faite avant toute vérification.
 *
 * Les deux étages sont distincts et c'est voulu. Ici, on décide combien d'octets on accepte de
 * LIRE sur la foi d'un nombre que l'archive a choisi — 64 kio, huit fois la place d'une page, et
 * rien qu'un lecteur ne puisse tenir. Ensuite, `exigerEnveloppeDeRecuperationSeule` exige la
 * taille EXACTE d'une page et refuse tout le reste. Confondre les deux ferait dépendre la borne
 * d'allocation du format d'enveloppe, c'est-à-dire ferait bouger un plafond de lecture le jour où
 * une page changerait de taille.
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
  // La FORME, à l'écriture comme à la lecture. Une archive ne doit pas pouvoir naître avec une
  // section que la restauration refusera : le défaut serait alors découvert au moment de
  // restaurer, sur un utilisateur qui croit tenir une sauvegarde ouvrable.
  const page = exigerEnveloppeDeRecuperationSeule(octets);
  accorderLeDescripteurEtLaPage(page, {
    envelopeVersion: recovery.version,
    slots: recovery.emplacements,
  });

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
 * @returns {Promise<{ octets: Uint8Array, page: object }>}
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
  // L'empreinte D'ABORD, la forme ENSUITE, et l'ordre est significatif : une section abîmée en
  // transport et une section FORGÉE n'appellent pas le même remède — réexporter dans un cas,
  // se méfier de la provenance dans l'autre. Juger la forme la première ferait rendre
  // « refusée » à ce qui n'est qu'« altérée ».
  const page = exigerEnveloppeDeRecuperationSeule(octets);
  accorderLeDescripteurEtLaPage(page, descripteur);
  return { octets, page };
}

/**
 * ACCORDE ce que l'en-tête déclare de la section et ce que la page en porte réellement.
 *
 * Une archive qui déclarerait une version d'enveloppe plus récente que celle qu'elle porte
 * tromperait l'ancre de la décision 3 de l'ADR 0027 : elle ferait accepter sans consentement une
 * sauvegarde antérieure à la feuille de récupération. Le nombre d'emplacements suit la même règle,
 * pour la même raison : l'en-tête est une DÉCLARATION, jamais une source.
 */
function accorderLeDescripteurEtLaPage(page, descripteur) {
  const porte = { envelopeVersion: page.version, slots: page.emplacements };
  if (descripteur.envelopeVersion === porte.envelopeVersion && descripteur.slots === porte.slots) {
    return;
  }
  throw refusee(
    `le descripteur annonce une enveloppe en version ${descripteur.envelopeVersion} portant ${descripteur.slots} emplacement(s), et la page en porte ${porte.slots} en version ${porte.envelopeVersion}.`,
    { declare: { ...descripteur }, porte },
  );
}
