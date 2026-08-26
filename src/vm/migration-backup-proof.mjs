// PREUVE DE SAUVEGARDE exigée avant une migration de format (#13, `VAULT-COMPAT-001`, ADR 0011).
//
// `docs/release-policy.md` exige un « export de sauvegarde obligatoire avant migration
// irréversible ». Ce module en fait un CONTRÔLE et non une phrase : l'archive présentée est relue
// par #11, son empreinte confrontée à celle du volume TEL QU'IL EST, son application et sa taille
// comparées. Une sauvegarde annoncée n'est pas une sauvegarde.
//
// Il tient aussi l'ARBITRAGE entre les preuves recevables, avant et pendant la migration : ce qui
// suffit à l'engager (geste 3) et ce qui est finalement retenu puis inscrit au journal (geste 5).
//
// Ce que ce module NE contrôle PAS : l'AUTHENTICITÉ de l'archive — elle n'est ni signée ni chiffrée
// (jalon 4) —, ni qu'elle soit toujours là demain.

import { MIGRATION_ERROR_CODES, MigrationError } from "./migration-errors.mjs";
import { createSha256Stream } from "./sha256-stream.mjs";
import { readArchive } from "./volume-export.mjs";

/**
 * Les deux preuves qu'une migration accepte à son ENGAGEMENT. Il n'y en a pas de troisième.
 *
 * Une REPRISE, elle, ne redemande rien : elle se fonde sur la preuve déjà retenue et inscrite dans
 * le journal. Ce n'est donc pas une troisième preuve, mais la MÊME, relue — et elle n'est acceptée
 * que si le journal qui la porte s'accorde avec le manifeste présent et la géométrie du support
 * (`manifesteSource`). Un journal seul ne vaut pas autorisation de migrer.
 */
export const EVIDENCE_KINDS = Object.freeze({
  /** Une archive #11 relue, dont le contenu est celui du volume à cet instant. */
  verifiedBackup: "sauvegarde-verifiee",
  /** Un exploitant nommé assume la migration sans sauvegarde. Inscrit dans le journal. */
  namedConsent: "consentement-nomme",
});

/** Consentement NOMMÉ, ou `null` s'il n'y en a pas. Un consentement anonyme n'en est pas un. */
export function consentementNomme(consent) {
  const nom = consent?.acknowledgedBy;
  if (typeof nom !== "string" || nom.trim() === "") return null;
  return {
    kind: EVIDENCE_KINDS.namedConsent,
    acknowledgedBy: nom,
    reason: typeof consent.reason === "string" ? consent.reason : null,
  };
}

/** RELIT le volume depuis le support et rend son empreinte, en flux. */
async function empreinteDuVolume({ backend, blockBytes }) {
  const hash = createSha256Stream();
  const taille = backend.size();
  let offset = 0;
  while (offset < taille) {
    const length = Math.min(blockBytes, taille - offset);
    const bytes = await backend.read(offset, length);
    if (!(bytes instanceof Uint8Array) || bytes.byteLength !== length) {
      throw new TypeError(
        `Relecture de volume incohérente : ${bytes?.byteLength} octet(s) rendus sur ${length} à l'offset ${offset}.`,
      );
    }
    hash.update(bytes);
    offset += length;
  }
  return hash.digestHex();
}

function sauvegardeNonConforme(detail, context) {
  return new MigrationError(
    MIGRATION_ERROR_CODES.backupMismatch,
    `Migration refusée : ${detail} L'archive présentée ne permettrait pas de revenir à l'état actuel de ce volume.`,
    context,
  );
}

/**
 * VÉRIFIE qu'une archive est bien la sauvegarde de CE volume, dans son état COURANT. Ce que le code
 * contrôle, exactement : l'archive est structurellement valide et son empreinte de contenu est
 * recalculée par #11 ; le volume est relu depuis le support et empreinté ; les deux empreintes
 * coïncident ; l'application et la taille du volume coïncident aussi. Ce qu'il ne contrôle pas :
 * l'AUTHENTICITÉ de l'archive — elle n'est ni signée ni chiffrée (jalon 4) —, ni qu'elle soit
 * toujours là demain.
 */
async function verifierSauvegarde({ backend, backup, manifest, blockBytes, expectations }) {
  const source = backup?.source;
  if (!source || typeof source.read !== "function" || !Number.isInteger(source.byteLength)) {
    throw new TypeError("Une sauvegarde attend une source { byteLength, read(offset, length) }.");
  }
  const verdict = await readArchive({
    read: (offset, length) => source.read(offset, length),
    byteLength: source.byteLength,
    blockBytes,
    expectations: { supportedFormat: expectations.supportedFormat },
  });
  if (verdict.manifest.app.id !== manifest.app.id) {
    throw sauvegardeNonConforme("la sauvegarde décrit une autre application.", {
      backupApp: verdict.manifest.app.id,
      volumeApp: manifest.app.id,
    });
  }
  if (verdict.contentLength !== backend.size()) {
    throw sauvegardeNonConforme(
      `la sauvegarde porte ${verdict.contentLength} octet(s) et le volume ${backend.size()}.`,
      { backupLength: verdict.contentLength, volumeSize: backend.size() },
    );
  }
  const courant = await empreinteDuVolume({ backend, blockBytes });
  if (courant !== verdict.contentDigest) {
    throw sauvegardeNonConforme(
      `le volume porte l'empreinte ${courant} et la sauvegarde ${verdict.contentDigest}.`,
      { volumeDigest: courant, backupDigest: verdict.contentDigest },
    );
  }
  return {
    kind: EVIDENCE_KINDS.verifiedBackup,
    contentDigest: courant,
    archiveLength: verdict.archiveLength,
    archiveFormatVersion: verdict.manifest.formatVersion,
  };
}

/**
 * GESTE 3 — EXIGER UNE PREUVE, avant d'ouvrir quoi que ce soit. Une REPRISE, elle, s'appuie sur la
 * preuve déjà retenue et inscrite dans le journal : redemander une archive au moment de la reprise
 * transformerait une interruption en impasse.
 */
export function assertPreuveDisponible({ journal, backup, consentement, fromVersion, toVersion }) {
  if (journal !== null || backup !== null || consentement !== null) return;
  throw new MigrationError(
    MIGRATION_ERROR_CODES.backupRequired,
    `Migration refusée : « export de sauvegarde obligatoire avant migration irréversible » (docs/release-policy.md). Fournir une archive de sauvegarde à vérifier, ou un consentement explicite nommé. Aucune ouverture n'est tentée.`,
    { fromVersion, toVersion },
  );
}

/**
 * GESTE 5 — la preuve RETENUE : celle du journal en reprise, sinon l'archive vérifiée, sinon le
 * consentement. `async` parce qu'un seul de ces trois chemins relit le support : la signature doit
 * annoncer l'attente que l'appelant subit dans tous les cas, pas celle du chemin le plus court.
 */
export async function retenirPreuve({
  journal,
  backup,
  consentement,
  backend,
  source,
  blockBytes,
  expectations,
}) {
  if (journal !== null) return journal.evidence;
  if (backup !== null) {
    return verifierSauvegarde({ backend, backup, manifest: source, blockBytes, expectations });
  }
  return consentement;
}
