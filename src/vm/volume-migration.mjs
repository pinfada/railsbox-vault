// MIGRATION DE FORMAT d'un volume, et REPRISE après interruption (#13, `VAULT-COMPAT-001`).
//
// `docs/release-policy.md` exige quatre choses d'une migration de volume : « lecture d'une version
// connue avant toute écriture », « export de sauvegarde obligatoire avant migration irréversible »,
// « refus explicite d'un format futur ou d'un downgrade dangereux » et « reprise déterministe après
// interruption de migration ». #10 a donné la première et la troisième ; ce module ajoute les deux
// autres, et exécute la migration elle-même. La décision est l'ADR 0011.
//
// L'ordre des gestes est le cœur du contrat, et il n'est pas négociable :
//
//   1. LIRE — l'état du volume, son journal de reprise éventuel et son manifeste. Les refus de #10
//      (format futur, application étrangère, volume non identifié) remontent ici, TELS QUELS, avant
//      que quoi que ce soit ne soit ouvert ;
//   2. PLANIFIER — la chaîne va d'un format au SUIVANT, une étape enregistrée à la fois. Un saut
//      sans étape est refusé (`VAULT_MIGRATION_NO_PATH`), un retour en arrière aussi
//      (`VAULT_MIGRATION_DOWNGRADE_REFUSED`) ;
//   3. EXIGER UNE PREUVE — sauvegarde vérifiée ou consentement nommé, sinon refus
//      (`VAULT_MIGRATION_BACKUP_REQUIRED`). Sans preuve, la cible n'est même pas ouverte ;
//   4. OUVRIR — le handle exclusif est pris. Comme à la restauration (ADR 0009), l'ouverture
//      PRÉCÈDE la révocation : une ouverture ratée ne doit pas rendre inutilisable un volume intact ;
//   5. VÉRIFIER LA SAUVEGARDE — s'il en est fourni une, l'archive est relue et son empreinte
//      confrontée à celle du volume TEL QU'IL EST. Une sauvegarde annoncée n'est pas une sauvegarde ;
//   6. JOURNALISER — le journal voisin `<volume>.migration` porte le manifeste SOURCE, la chaîne
//      visée et la preuve retenue. Il est écrit AVANT la révocation : sans lui, une interruption
//      effacerait la seule trace de ce qu'était le volume, et la reprise serait impossible ;
//   7. RÉVOQUER — le manifeste est retiré. À partir de cet instant `openVolumeForWrite` refuse le
//      volume par `VAULT_MANIFEST_UNIDENTIFIED` : une migration interrompue ne peut pas se faire
//      passer pour un volume valide ;
//   8. APPLIQUER puis franchir une BARRIÈRE ;
//   9. INSCRIRE le manifeste cible, puis le RELIRE depuis le support — écrire n'est pas persister.
//      Une relecture divergente le retire et lève `VAULT_MIGRATION_VERIFICATION_FAILED` ;
//  10. RETIRER LE JOURNAL — dernier geste. Sa présence signale une migration dont le dernier geste
//      n'a pas été franchi : soit elle a été coupée en chemin, soit elle a abouti sans pouvoir se
//      relire. Le distinguer est le travail de `rienAMigrer`, pas une lecture de la seule présence.
//
// La fermeture du handle n'est PAS un de ces gestes : c'est la restitution de ce que le geste 4
// avait pris. Elle est tentée quoi qu'il arrive, et si elle rate elle ne REMPLACE pas l'erreur qui a
// fait échouer la migration — elle lui est jointe en `cause`. Sinon le diagnostic, donc le remède,
// serait perdu au moment précis où le volume est laissé non identifié.
//
// Ce que ce module NE fait PAS : descendre d'un format (l'ADR 0007 refuse le downgrade), migrer une
// application (les migrations métier de Rails sont distinctes), construire une génération
// copy-on-write (#16), ni chiffrer ou authentifier le manifeste (jalon 4). Il est PUR de tout
// support : la `target` est injectée — un double déterministe sous Node,
// `src/vm/opfs-migration-target.mjs` dans le Worker.

import { MIGRATION_ERROR_CODES, MigrationError } from "./migration-errors.mjs";
import { MANIFEST_ERROR_CODES, ManifestError } from "./manifest-errors.mjs";
import { MIGRATION_JOURNAL_SUFFIX, migrationJournalName } from "./opfs-sync-access.mjs";
import { createSha256Stream } from "./sha256-stream.mjs";
import { readArchive } from "./volume-export.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  MIN_WRITER_FORMAT_VERSION,
  assertReadable,
  createManifest,
  parseManifest,
  serializeManifest,
} from "./volume-manifest.mjs";

/** Marqueur du journal de reprise : il n'est jamais confondu avec un manifeste. */
export const MIGRATION_JOURNAL_MAGIC = "railsbox-vault/volume-migration";

/** Version du format du JOURNAL. Comme les autres formats persistants, un entier indépendant. */
export const MIGRATION_JOURNAL_VERSION = 1;

/** Bloc de streaming par défaut : identique à l'export, très en deçà du budget de 64 Mio. */
export const DEFAULT_MIGRATION_BLOCK_BYTES = 4 * 1024 * 1024;

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

// Le nom du journal appartient à la frontière de nommage du support : il est défini une fois, dans
// `opfs-sync-access.mjs`, et réexporté ici pour les appelants de la migration.
export { MIGRATION_JOURNAL_SUFFIX, migrationJournalName };

/**
 * ÉTAPES ENREGISTRÉES, une par PAS de version. Il n'existe aucun chemin direct d'un format vers un
 * format lointain : migrer, c'est traverser chaque format intermédiaire, dans l'ordre, avec un
 * manifeste valide à chaque palier. C'est ce qui rend la chaîne vérifiable au lieu d'être crue.
 *
 * `apply` reçoit le manifeste du palier courant et rend celui du palier suivant. Il reçoit aussi le
 * backend ouvert : aucune étape enregistrée n'écrit aujourd'hui dans le volume, mais l'ordre des
 * gestes ci-dessus est celui de #12 précisément pour qu'une étape future qui en écrirait n'ait pas
 * à réinventer sa sûreté.
 */
const STEPS = Object.freeze([
  Object.freeze({
    from: 1,
    to: MIN_WRITER_FORMAT_VERSION,
    summary:
      "v2 : le volume DÉCLARE `runtime.minWriter`, le plus ancien runtime autorisé à l'écrire, au lieu que chaque ouverture le devine à partir du seul majeur SemVer.",
    apply({ manifest }) {
      return createManifest({
        formatVersion: MIN_WRITER_FORMAT_VERSION,
        runtime: {
          version: manifest.runtime.version,
          artifact: manifest.runtime.artifact,
          // Traduction EXACTE de la règle v1 — « un runtime de majeur inférieur est refusé » —, et
          // non une valeur inventée : le plus ancien écrivain qu'elle admettait était le plancher
          // du majeur du runtime qui a écrit le volume.
          minWriter: plancherDuMajeur(manifest.runtime.version),
        },
        app: manifest.app,
        volumeSize: manifest.geometry.volumeSize,
        // `identity` est reconduite telle quelle : la migration ne touche aucun octet du volume,
        // donc ce que le digest attestait (l'état au moment de son inscription, ADR 0009) reste
        // exactement aussi vrai — ni plus, ni moins.
        identity: manifest.identity,
      });
    },
  }),
]);

for (const etape of STEPS) {
  if (etape.to !== etape.from + 1) {
    throw new Error(`Étape de migration non contiguë : ${etape.from} → ${etape.to}.`);
  }
}

/** Plancher SemVer du majeur d'une version déjà validée : « 2.7.3 » → « 2.0.0 ». */
function plancherDuMajeur(version) {
  const majeur = /^(\d+)\./.exec(version);
  if (majeur === null) throw new TypeError(`Version de runtime inattendue : ${version}.`);
  return `${majeur[1]}.0.0`;
}

/** Les étapes enregistrées, pour la documentation et les vecteurs de test par version. */
export function migrationSteps() {
  return STEPS;
}

/**
 * Chaîne d'étapes menant de `from` à `to`, un PAS à la fois. Rend une liste vide si le volume est
 * déjà au format visé.
 *
 * @throws {MigrationError} `VAULT_MIGRATION_DOWNGRADE_REFUSED` si `to` précède `from`,
 *   `VAULT_MIGRATION_NO_PATH` si une étape manque à la chaîne.
 */
export function planMigration(from, to) {
  if (!Number.isInteger(from) || from < 1 || !Number.isInteger(to) || to < 1) {
    throw new TypeError(`Versions de format invalides : ${JSON.stringify({ from, to })}.`);
  }
  if (to < from) {
    throw new MigrationError(
      MIGRATION_ERROR_CODES.downgradeRefused,
      `Migration refusée : le volume est au format ${from} et ${to} lui est antérieur. Une migration ne descend jamais ; revenir en arrière suppose de restaurer une sauvegarde.`,
      { from, to },
    );
  }
  const chaine = [];
  let courant = from;
  while (courant < to) {
    const etape = STEPS.find((candidate) => candidate.from === courant);
    if (etape === undefined) {
      throw new MigrationError(
        MIGRATION_ERROR_CODES.noPath,
        `Migration refusée : aucune étape enregistrée ne part du format ${courant} vers ${courant + 1}. La chaîne ${from} → ${to} est interrompue et ne sera pas devinée.`,
        { from, to, missingFrom: courant },
      );
    }
    chaine.push(etape);
    courant = etape.to;
  }
  return chaine;
}

// --- Journal de reprise --------------------------------------------------------------------------

/** Sérialise le journal de reprise. Déterministe, comme le manifeste. */
function serialiserJournal({ from, to, sourceManifest, evidence }) {
  return new TextEncoder().encode(
    JSON.stringify({
      magic: MIGRATION_JOURNAL_MAGIC,
      journalVersion: MIGRATION_JOURNAL_VERSION,
      from,
      to,
      sourceManifest,
      evidence,
    }),
  );
}

function journalMalforme(detail, context = {}) {
  return new MigrationError(
    MIGRATION_ERROR_CODES.journalMalformed,
    `Journal de migration illisible : ${detail} Il n'est ni supprimé, ni deviné : l'écarter est un geste explicite.`,
    context,
  );
}

/**
 * Analyse le journal de reprise, ou lève un refus typé. Un journal présent mais illisible fait
 * REFUSER la migration : il signale une migration inachevée dont on ignore l'état de départ, et
 * passer outre reviendrait à réinventer une identité pour le volume.
 */
export function parseJournal(input) {
  let brut;
  try {
    brut = JSON.parse(input instanceof Uint8Array ? new TextDecoder().decode(input) : input);
  } catch {
    throw journalMalforme("JSON invalide.");
  }
  if (!brut || typeof brut !== "object" || brut.magic !== MIGRATION_JOURNAL_MAGIC) {
    throw journalMalforme("marqueur absent ou inconnu.", { magic: brut?.magic ?? null });
  }
  if (brut.journalVersion !== MIGRATION_JOURNAL_VERSION) {
    throw journalMalforme("version de journal non prise en charge.", {
      journalVersion: brut.journalVersion ?? null,
    });
  }
  if (!Number.isInteger(brut.from) || !Number.isInteger(brut.to) || brut.to < brut.from) {
    throw journalMalforme("chaîne de versions absente ou incohérente.", {
      from: brut.from ?? null,
      to: brut.to ?? null,
    });
  }
  if (!brut.evidence || !Object.values(EVIDENCE_KINDS).includes(brut.evidence.kind)) {
    throw journalMalforme("preuve de sauvegarde absente ou inconnue.", {
      kind: brut.evidence?.kind ?? null,
    });
  }
  let sourceManifest;
  try {
    sourceManifest = parseManifest(brut.sourceManifest);
  } catch (cause) {
    throw journalMalforme(`manifeste source invalide (${cause.message}).`);
  }
  return Object.freeze({
    from: brut.from,
    to: brut.to,
    sourceManifest,
    evidence: Object.freeze({ ...brut.evidence }),
  });
}

// --- Preuve de sauvegarde ------------------------------------------------------------------------

/** Consentement NOMMÉ, ou `null` s'il n'y en a pas. Un consentement anonyme n'en est pas un. */
function consentementNomme(consent) {
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

// --- Orchestration -------------------------------------------------------------------------------

const MEMBRES_CIBLE = [
  "inspect",
  "readManifest",
  "readJournal",
  "open",
  "writeJournal",
  "revokeManifest",
  "commitManifest",
  "removeJournal",
];

/** Valide les collaborateurs injectés. Une faute de programmation n'est pas un état de format. */
function assertContract(target, blockBytes) {
  for (const membre of MEMBRES_CIBLE) {
    if (typeof target?.[membre] !== "function") {
      throw new TypeError(`migrateVolume attend une cible exposant « ${membre} ».`);
    }
  }
  if (!Number.isInteger(blockBytes) || blockBytes <= 0) {
    throw new RangeError(`Taille de bloc invalide : ${blockBytes}.`);
  }
}

/** Rend `true` si les deux suites d'octets sont identiques. */
function memesOctets(a, b) {
  if (!(a instanceof Uint8Array) || !(b instanceof Uint8Array) || a.byteLength !== b.byteLength) {
    return false;
  }
  for (let i = 0; i < a.byteLength; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

/**
 * GESTE 1 — LIRE. L'état du support, le journal de reprise éventuel et le manifeste courant, dans
 * cet ordre. Rien n'est ouvert ici : les refus de #10 doivent tomber avant toute prise de handle.
 */
async function lireEtat(target, expectations) {
  const support = await target.inspect();
  const journalBytes = await target.readJournal();
  const journal = journalBytes === null ? null : parseJournal(journalBytes);
  const manifestBytes = await target.readManifest();
  const courant = manifestBytes === null ? null : parseManifest(manifestBytes);
  if (courant !== null) assertReadable(courant, expectations);
  return { support, journal, courant };
}

/**
 * Manifeste dont PART la migration : celui du volume, ou — si le manifeste a déjà été révoqué par
 * une migration interrompue — celui que le journal a conservé. Sans l'un ni l'autre, le volume n'a
 * pas d'identité, et une identité ne se devine pas.
 *
 * Un journal n'est PAS une autorité supérieure au volume. Rien ne garantit qu'un journal trouvé à
 * côté d'un volume décrive CE volume : ni la restauration (#12) ni la préparation d'un volume neuf
 * ne retirent le voisin `.migration`, si bien qu'un journal PÉRIMÉ peut survivre à la recréation du
 * volume qu'il prétend décrire. Quand les deux sont présents, ils doivent donc coïncider OCTET POUR
 * OCTET — c'est ce qu'une interruption entre la journalisation (geste 6) et la révocation (geste 7)
 * laisse derrière elle. Toute divergence fait refuser : préférer le journal reviendrait à laisser un
 * voisin réécrire l'identité d'un volume parfaitement sain.
 */
function manifesteSource({ support, journal, courant }, expectations) {
  if (journal !== null && courant !== null) {
    const attendu = serializeManifest(courant);
    const porte = serializeManifest(journal.sourceManifest);
    if (!memesOctets(attendu, porte)) {
      throw journalMalforme(
        "il décrit un volume dont le manifeste n'est pas celui présent à côté de lui.",
        {
          volumeFormatVersion: courant.formatVersion,
          journalSourceFormatVersion: journal.sourceManifest.formatVersion,
        },
      );
    }
  }
  const source = journal === null ? courant : journal.sourceManifest;
  if (source === null) {
    throw new ManifestError(
      MANIFEST_ERROR_CODES.unidentified,
      "Migration refusée : le volume ne porte ni manifeste identifiable, ni journal de reprise. Rien ne dit de quel format il vient, et une identité ne se devine pas.",
      { volumeSize: support.size ?? null },
    );
  }
  if (journal !== null) assertReadable(source, expectations);
  assertGeometrieDuSupport(source, support);
  return source;
}

/**
 * La géométrie déclarée par le manifeste source doit décrire le support RÉEL, sinon la migration
 * inscrirait une taille qui ne correspond à aucun octet présent. Le contrôle précède l'ouverture :
 * un volume dont on ne sait pas la taille ne se retaille pas, il se refuse.
 */
function assertGeometrieDuSupport(source, support) {
  if (source.geometry.volumeSize === support.size) return;
  throw new MigrationError(
    MIGRATION_ERROR_CODES.geometryMismatch,
    `Migration refusée : le manifeste de départ décrit un volume de ${source.geometry.volumeSize} octet(s) et le support en porte ${support.size}. Un volume n'est jamais retaillé par une migration, et une géométrie ne se devine pas.`,
    { manifestVolumeSize: source.geometry.volumeSize, supportSize: support.size ?? null },
  );
}

/**
 * GESTE 3 — EXIGER UNE PREUVE, avant d'ouvrir quoi que ce soit. Une REPRISE, elle, s'appuie sur la
 * preuve déjà retenue et inscrite dans le journal : redemander une archive au moment de la reprise
 * transformerait une interruption en impasse.
 */
function assertPreuveDisponible({ journal, backup, consentement, fromVersion, toVersion }) {
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
async function retenirPreuve({
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

/**
 * GESTES 6 à 9 — la partie MUTANTE, dans son ordre non négociable : journaliser, révoquer,
 * appliquer, franchir la barrière, inscrire, relire. Une relecture divergente retire le manifeste
 * inscrit : le volume reste NON IDENTIFIÉ plutôt que présenté comme migré.
 */
async function muter({ target, backend, chaine, source, toVersion, evidence }) {
  // 6. JOURNALISER — avant la révocation, sinon la reprise n'aurait plus de point de départ.
  await target.writeJournal(
    serialiserJournal({
      from: source.formatVersion,
      to: toVersion,
      sourceManifest: source,
      evidence,
    }),
  );

  // 7. RÉVOQUER — à partir d'ici, `openVolumeForWrite` refuse le volume.
  await target.revokeManifest();

  // 8. APPLIQUER, puis franchir la barrière de durabilité.
  let manifest = source;
  for (const etape of chaine) manifest = etape.apply({ manifest, backend });
  await backend.flush();

  // 9. INSCRIRE, puis RELIRE depuis le support : écrire n'est pas persister.
  const octets = serializeManifest(manifest);
  await target.commitManifest(octets);
  const relu = await target.readManifest();
  if (!memesOctets(relu, octets)) {
    await target.revokeManifest();
    throw new MigrationError(
      MIGRATION_ERROR_CODES.verificationFailed,
      `Migration refusée : le manifeste relu depuis le support ne rend pas les octets inscrits. Le volume reste NON IDENTIFIÉ plutôt que présenté comme migré ; le journal de reprise subsiste.`,
      { expectedBytes: octets.byteLength, observedBytes: relu?.byteLength ?? null },
    );
  }
  return manifest;
}

/**
 * Migre un volume vers le format `toVersion`, ou REPREND une migration interrompue.
 *
 * @param {{
 *   target: object,
 *   expectations?: object,
 *   toVersion?: number,
 *   backup?: { source: { byteLength: number, read: Function } } | null,
 *   consent?: { acknowledgedBy: string, reason?: string } | null,
 *   blockBytes?: number,
 * }} args
 * @returns {Promise<object>} compte rendu de la migration
 * @throws {ManifestError} volume non identifié, format futur, application étrangère (#10, tels quels)
 * @throws {MigrationError} chaîne absente, downgrade, sauvegarde manquante ou non conforme,
 *   journal illisible, manifeste relu divergent
 */
export async function migrateVolume({
  target,
  expectations = {},
  toVersion = expectations.supportedFormat?.current ?? MANIFEST_FORMAT_VERSION,
  backup = null,
  consent = null,
  blockBytes = DEFAULT_MIGRATION_BLOCK_BYTES,
}) {
  assertContract(target, blockBytes);

  // 1. LIRE. L'état du support, le journal éventuel, puis le manifeste courant.
  const etat = await lireEtat(target, expectations);
  const { support, journal, courant } = etat;

  // Le volume porte DÉJÀ le format visé : rien à migrer.
  if (courant !== null && courant.formatVersion === toVersion) {
    return rienAMigrer({ target, courant, journal, toVersion });
  }

  const source = manifesteSource(etat, expectations);

  // 2. PLANIFIER. Un PAS à la fois, jamais un saut ; jamais une descente.
  const chaine = planMigration(source.formatVersion, toVersion);

  // 3. EXIGER UNE PREUVE — avant d'ouvrir quoi que ce soit.
  const consentement = consentementNomme(consent);
  assertPreuveDisponible({
    journal,
    backup,
    consentement,
    fromVersion: source.formatVersion,
    toVersion,
  });

  // 4 à 10. OUVRIR, vérifier, muter, refermer, retirer le journal.
  return executerMigration({
    target,
    support,
    journal,
    source,
    chaine,
    toVersion,
    backup,
    consentement,
    blockBytes,
    expectations,
  });
}

/**
 * Le volume porte déjà le format visé. Un journal resté derrière lui signale une migration
 * interrompue APRÈS l'inscription du manifeste — elle a abouti ; il suffit de le retirer. C'est ce
 * qui rend `migrateVolume` idempotente.
 */
async function rienAMigrer({ target, courant, journal, toVersion }) {
  if (journal !== null) {
    // Le journal n'est retiré que s'il est BIEN le reliquat de la migration qui a produit ce
    // manifeste. Un journal visant un autre format porte sur autre chose — un volume recréé depuis,
    // par exemple — et l'effacer supprimerait l'indice d'une migration inachevée.
    if (journal.to !== courant.formatVersion) {
      throw journalMalforme(
        `il vise le format ${journal.to} alors que le volume porte le format ${courant.formatVersion} : il n'est pas le reliquat de cette migration.`,
        { journalTo: journal.to, volumeFormatVersion: courant.formatVersion },
      );
    }
    await target.removeJournal();
  }
  return rapport({
    migrated: false,
    resumed: journal !== null,
    fromVersion: courant.formatVersion,
    toVersion,
    manifest: courant,
    evidence: journal?.evidence ?? null,
    steps: [],
  });
}

/**
 * GESTES 4 à 10 — la partie qui tient un HANDLE. Elle est isolée pour que la fermeture du backend
 * soit gouvernée par un seul `finally`, et pour que le retrait du journal reste ce qu'il doit être :
 * le dernier geste, franchi seulement si tout ce qui précède a abouti.
 */
async function executerMigration({
  target,
  support,
  journal,
  source,
  chaine,
  toVersion,
  backup,
  consentement,
  blockBytes,
  expectations,
}) {
  // 4. OUVRIR. Comme à la restauration, l'ouverture précède la révocation : une ouverture ratée ne
  //    doit pas rendre inutilisable un volume parfaitement intact.
  const backend = await target.open({ size: support.size });
  let migre = null;
  let echec = null;
  try {
    // 5. VÉRIFIER LA SAUVEGARDE, s'il en est fourni une.
    const evidence = await retenirPreuve({
      journal,
      backup,
      consentement,
      backend,
      source,
      blockBytes,
      expectations,
    });

    // 6 à 9. JOURNALISER, RÉVOQUER, APPLIQUER, INSCRIRE puis RELIRE.
    const manifest = await muter({ target, backend, chaine, source, toVersion, evidence });

    migre = rapport({
      migrated: true,
      resumed: journal !== null,
      fromVersion: source.formatVersion,
      toVersion,
      manifest,
      evidence,
      steps: chaine,
    });
  } catch (cause) {
    echec = cause;
  }

  // Le handle est rendu QUOI QU'IL ARRIVE, mais une fermeture qui rate ne masque rien.
  const fermeture = await fermer(backend);
  if (echec !== null) throw joindreFermeture(echec, fermeture);
  if (fermeture !== null) throw fermeture;

  // 10. RETIRER LE JOURNAL — dernier geste : sa présence signale une migration dont il n'a pas été
  //     franchi.
  await target.removeJournal();
  return migre;
}

/**
 * Rend le handle et rapporte l'échec de la fermeture PLUTÔT que de le laisser remonter seul. Une
 * fermeture n'est pas un geste de la migration : c'est la restitution de ce qu'elle avait pris.
 * @returns {Promise<Error | null>} l'erreur de fermeture, ou `null` si le handle a été rendu
 */
async function fermer(backend) {
  try {
    await backend.close();
    return null;
  } catch (cause) {
    return cause;
  }
}

/**
 * JOINT une fermeture ratée à l'erreur qui a fait échouer la migration, sans la remplacer. Le
 * diagnostic d'une migration est celui de ce qui l'a interrompue ; une fermeture qui rate ensuite
 * est une circonstance. La substituer ferait lire « fermeture impossible » là où le volume a été
 * laissé NON IDENTIFIÉ par la barrière — et le remède (reprendre depuis le journal) ne se
 * déduirait plus du message.
 *
 * La fermeture prend la place que la plateforme lui donne, `cause`, et seulement si elle est libre :
 * une erreur qui porte déjà la sienne ne se la fait pas réécrire.
 */
function joindreFermeture(echec, fermeture) {
  if (fermeture === null) return echec;
  if (echec instanceof Error && echec.cause === undefined) echec.cause = fermeture;
  return echec;
}

/** Compte rendu d'une migration. Extrait pour que l'orchestration reste lisible d'un œil. */
function rapport({ migrated, resumed, fromVersion, toVersion, manifest, evidence, steps }) {
  return {
    migrated,
    resumed,
    fromVersion,
    toVersion,
    manifest,
    evidence,
    steps: steps.map((etape) => ({ from: etape.from, to: etape.to, summary: etape.summary })),
  };
}
