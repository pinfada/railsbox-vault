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

import {
  assertPreuveDisponible,
  consentementNomme,
  retenirPreuve,
} from "./migration-backup-proof.mjs";
import { MIGRATION_ERROR_CODES, MigrationError } from "./migration-errors.mjs";
import { ecrituresARejouerV1 } from "./generation-v1-rejeu.mjs";
import { tailleDeFichier } from "./volume-chiffre-format.mjs";
import { journalMalforme, parseJournal, serialiserJournal } from "./migration-journal.mjs";
import { MANIFEST_ERROR_CODES, ManifestError } from "./manifest-errors.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  assertReadable,
  parseManifest,
  serializeManifest,
} from "./volume-manifest.mjs";

/** Bloc de streaming par défaut : identique à l'export, très en deçà du budget de 64 Mio. */
export const DEFAULT_MIGRATION_BLOCK_BYTES = 4 * 1024 * 1024;

// Le JOURNAL DE REPRISE et la PREUVE DE SAUVEGARDE sont deux responsabilités distinctes de
// l'orchestration : elles vivent dans leurs propres modules. Leur surface publique est réexportée
// ici, parce que c'est la migration que les appelants importent.
export {
  MIGRATION_JOURNAL_MAGIC,
  MIGRATION_JOURNAL_SUFFIX,
  MIGRATION_JOURNAL_VERSION,
  migrationJournalName,
  parseJournal,
  serialiserJournal,
} from "./migration-journal.mjs";
export { EVIDENCE_KINDS } from "./migration-backup-proof.mjs";
// La TABLE DES ÉTAPES vit dans son propre module depuis que l'une d'elles réécrit le volume :
// ce qu'un pas fait et l'ordre dans lequel les gestes l'entourent sont deux sujets distincts.
export { migrationSteps, planMigration } from "./migration-etapes.mjs";
import { planMigration } from "./migration-etapes.mjs";

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
function manifesteSource({ support, journal, courant }, expectations, toVersion) {
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
  assertGeometrieDuSupport(source, support, { cible: toVersion, reprise: journal !== null });
  return source;
}

/**
 * La géométrie déclarée par le manifeste source doit décrire le support RÉEL, sinon la migration
 * inscrirait une taille qui ne correspond à aucun octet présent. Le contrôle précède l'ouverture :
 * un volume dont on ne sait pas la taille ne se retaille pas, il se refuse.
 *
 * ## Taille LOGIQUE et taille de FICHIER, et ce qui arrive quand on les confond
 *
 * `geometry.volumeSize` est la taille LOGIQUE — ce que le guest voit. Le support, lui, porte un
 * FICHIER, dont la taille se DÉRIVE du format : jusqu'à v2 les deux coïncidaient, en v3 le fichier
 * porte en plus l'en-tête et la région d'authentification. Comparer la première au second refusait
 * tout volume v3, et la revue de #110 a montré ce que cela coûtait : la conversion agrandit le
 * fichier dès son PREMIER geste, si bien qu'une migration coupée après la moindre écriture laissait
 * un volume au manifeste révoqué, au journal complet — et refusé à la reprise. Ni v2, ni v3, ni
 * reprenable, et toute la machinerie de reprise inatteignable depuis la production.
 *
 * ## Deux tailles admissibles, et seulement en REPRISE
 *
 * Hors reprise, une seule taille est admise : celle du format SOURCE. Un fichier déjà agrandi sans
 * journal n'est pas une migration en cours, c'est un volume dont personne ne sait ce qu'il est.
 *
 * En reprise, le fichier peut être à la taille source — la coupure a précédé le retaillage — ou à
 * celle de la CIBLE. Les deux sont des états atteignables du même geste, et refuser le second
 * refuserait précisément la reprise qu'on prétend offrir.
 */
function assertGeometrieDuSupport(source, support, { cible, reprise }) {
  const logique = source.geometry.volumeSize;
  const admissibles = [
    tailleDeFichier({ formatVersion: source.formatVersion, tailleLogique: logique }),
  ];
  if (reprise) {
    admissibles.push(tailleDeFichier({ formatVersion: cible, tailleLogique: logique }));
  }
  if (admissibles.includes(support.size)) return;
  throw new MigrationError(
    MIGRATION_ERROR_CODES.geometryMismatch,
    `Migration refusée : le manifeste de départ décrit un volume LOGIQUE de ${logique} octet(s), dont le fichier devrait en faire ${admissibles.join(" ou ")}, et le support en porte ${support.size}. Un volume n'est jamais retaillé par une migration, et une géométrie ne se devine pas.`,
    {
      manifestVolumeSize: logique,
      expectedFileSizes: admissibles,
      supportSize: support.size ?? null,
    },
  );
}

/**
 * REPORTE dans le volume la dernière génération validée du journal SOURCE, puis ÉCARTE ce journal.
 *
 * ## Pourquoi ce geste existe, et pourquoi il est ici
 *
 * Depuis #16 le fichier du volume ne porte pas tout son état : une génération VALIDÉE vit dans le
 * voisin `<volume>.gen` jusqu'à ce qu'une ouverture la reporte. Une migration qui l'ignore fait deux
 * dégâts, tous deux nommés par la revue de #110 : elle PERD une écriture acquittée, et elle laisse
 * derrière elle un journal d'un format que le volume migré ne sait plus lire — si bien que le volume
 * tout juste migré ne s'ouvre plus, sous un code qui envoie restaurer une sauvegarde alors que les
 * données sont intactes.
 *
 * ## L'ordre, qui est le contrat
 *
 * Le report ÉCRIT dans le volume : il vient donc après la révocation du manifeste (geste 7), comme
 * toute mutation. Il vient avant la conversion, et il le faut : le report vise des adresses du
 * volume V2, que la conversion déplace. Le journal est écarté ensuite, et une coupure entre les deux
 * est sans conséquence — reporter deux fois les mêmes octets aux mêmes adresses ne change rien.
 *
 * ## Ce qui protège de reporter APRÈS la conversion
 *
 * Le geste ne s'exécute que si le fichier est encore à sa taille SOURCE. Une reprise qui trouve un
 * fichier déjà agrandi sait que la conversion a commencé, donc que le journal a déjà été soldé.
 */
async function solderLeJournalDeGeneration({ target, backend, source }) {
  if (typeof target.readGenerationJournal !== "function") return null;
  const tailleSource = tailleDeFichier({
    formatVersion: source.formatVersion,
    tailleLogique: source.geometry.volumeSize,
  });
  if (backend.size() !== tailleSource) return null;

  const octets = await target.readGenerationJournal();
  // Pas de voisin : rien à reporter et rien à écarter. On ne demande pas au support un retrait qui
  // n'a pas lieu d'être — un geste inutile dans la trace est un geste qu'une revue doit expliquer.
  if (octets === null || octets === undefined) return null;

  const { generation, ecritures } = ecrituresARejouerV1({
    octets,
    tailleVolume: source.geometry.volumeSize,
  });
  for (const ecriture of ecritures) await backend.write(ecriture.offset, ecriture.octets);
  // La barrière AVANT le retrait : écarter un journal dont le report n'est pas durable perdrait
  // exactement ce qu'on cherchait à sauver.
  if (ecritures.length > 0) await backend.flush();
  await target.removeGenerationJournal();
  return Object.freeze({ generation, ecritures: ecritures.length });
}

/**
 * Applique la chaîne, un PAS à la fois, et route l'avancement vers le pas qu'il décrit.
 *
 * L'avancement journalisé porte son `from` et son `to`, et c'est indispensable : le donner au
 * premier pas de la chaîne — ce que faisait la première version — le faisait consommer par une
 * étape qui n'en avait pas l'usage, si bien que le pas suivant recevait « rien de commencé » et
 * redéplaçait la charge par-dessus une région déjà scellée. Chaque pas ne voit donc que son propre
 * avancement, et ce qu'il journalise est étiqueté de son propre `from`/`to`.
 */
async function appliquerLaChaine({ chaine, source, backend, cle, avancement, marquerAvancement }) {
  let manifest = source;
  for (const etape of chaine) {
    const pourCePas =
      avancement !== null && avancement.from === etape.from && avancement.to === etape.to
        ? avancement
        : null;
    manifest = await etape.apply({
      manifest,
      backend,
      cle,
      avancement: pourCePas,
      marquerAvancement: (progress) =>
        marquerAvancement({ ...progress, from: etape.from, to: etape.to }),
    });
  }
  return manifest;
}

/**
 * GESTES 6 à 9 — la partie MUTANTE, dans son ordre non négociable : journaliser, révoquer,
 * appliquer, franchir la barrière, inscrire, relire. Une relecture divergente retire le manifeste
 * inscrit : le volume reste NON IDENTIFIÉ plutôt que présenté comme migré.
 */
async function muter({ target, backend, chaine, source, toVersion, evidence, cle, avancement }) {
  /**
   * Réécrit le journal avec l'AVANCEMENT d'une étape qui écrit.
   *
   * Il est réécrit ENTIER, et non modifié : le journal est un petit fichier remplacé d'un bloc, si
   * bien qu'une coupure y laisse l'ancien contenu ou le nouveau, jamais un mélange. C'est la même
   * propriété que l'ADR 0011 exige déjà du manifeste.
   */
  const marquerAvancement = (progress) =>
    target.writeJournal(
      serialiserJournal({
        from: source.formatVersion,
        to: toVersion,
        sourceManifest: source,
        evidence,
        progress,
      }),
    );

  // 6. JOURNALISER — avant la révocation, sinon la reprise n'aurait plus de point de départ.
  await marquerAvancement(avancement);

  // 7. RÉVOQUER — à partir d'ici, `openVolumeForWrite` refuse le volume.
  await target.revokeManifest();

  // 7 bis. REPORTER puis ÉCARTER le journal de génération du volume SOURCE.
  await solderLeJournalDeGeneration({ target, backend, source });

  // 8. APPLIQUER, puis franchir la barrière de durabilité.
  const manifest = await appliquerLaChaine({
    chaine,
    source,
    backend,
    cle,
    avancement,
    marquerAvancement,
  });
  await backend.flush();

  // 9. INSCRIRE, puis RELIRE depuis le support : écrire n'est pas persister.
  await inscrireEtRelire(target, manifest);
  return manifest;
}

/**
 * INSCRIT le manifeste cible et le RELIT depuis le support. Écrire n'est pas persister.
 *
 * Une relecture divergente le RETIRE : le volume reste non identifié plutôt que présenté comme
 * migré, et le journal de reprise subsiste pour qu'une seconde tentative sache d'où repartir.
 */
async function inscrireEtRelire(target, manifest) {
  const octets = serializeManifest(manifest);
  await target.commitManifest(octets);
  const relu = await target.readManifest();
  if (memesOctets(relu, octets)) return;
  await target.revokeManifest();
  throw new MigrationError(
    MIGRATION_ERROR_CODES.verificationFailed,
    `Migration refusée : le manifeste relu depuis le support ne rend pas les octets inscrits. Le volume reste NON IDENTIFIÉ plutôt que présenté comme migré ; le journal de reprise subsiste.`,
    { expectedBytes: octets.byteLength, observedBytes: relu?.byteLength ?? null },
  );
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
  cle = null,
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

  const source = manifesteSource(etat, expectations, toVersion);

  // 2. PLANIFIER. Un PAS à la fois, jamais un saut ; jamais une descente.
  const chaine = planMigration(source.formatVersion, toVersion);

  // 3. EXIGER UNE PREUVE — avant d'ouvrir quoi que ce soit.
  const consentement = exigerUnePreuve({ journal, backup, consent, chaine, source, toVersion });

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
    cle,
    blockBytes,
    expectations,
  });
}

/**
 * GESTE 3 — EXIGER une preuve, et rendre le consentement nommé qu'on a pu en tirer.
 *
 * Le contrôle précède toute ouverture : un volume qu'on n'a pas le droit de migrer ne doit pas voir
 * son handle pris.
 */
function exigerUnePreuve({ journal, backup, consent, chaine, source, toVersion }) {
  const consentement = consentementNomme(consent);
  assertPreuveDisponible({
    journal,
    backup,
    consentement,
    chaine,
    fromVersion: source.formatVersion,
    toVersion,
  });
  return consentement;
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
 * GESTES 4 à 10 — la partie qui tient un HANDLE. Elle est isolée pour que la restitution du backend
 * soit gouvernée en un seul endroit, et pour que le retrait du journal reste ce qu'il doit être : le
 * dernier geste, franchi seulement si tout ce qui précède a abouti.
 *
 * @param {object} plan tout ce que `migrateVolume` a établi avant d'ouvrir quoi que ce soit :
 *   `target`, `support`, `journal`, `source`, `chaine`, `toVersion`, `backup`, `consentement`,
 *   `blockBytes`, `expectations`. Il est transmis tel quel à `retenirPreuve`, qui n'y prend que les
 *   champs dont dépend la preuve.
 */
async function executerMigration(plan) {
  const { target, support, journal, source, chaine, toVersion, cle } = plan;

  // 4. OUVRIR. Comme à la restauration, l'ouverture précède la révocation : une ouverture ratée ne
  //    doit pas rendre inutilisable un volume parfaitement intact.
  const backend = await target.open({ size: support.size });
  let migre = null;
  let echec = null;
  try {
    // 5. VÉRIFIER LA SAUVEGARDE, s'il en est fourni une.
    const evidence = await retenirPreuve({ ...plan, backend });

    // 6 à 9. JOURNALISER, RÉVOQUER, APPLIQUER, INSCRIRE puis RELIRE.
    const manifest = await muter({
      target,
      backend,
      chaine,
      source,
      toVersion,
      evidence,
      cle,
      // L'AVANCEMENT vient du journal trouvé sur le support, jamais de l'état du fichier : la taille
      // d'un fichier dit qu'une conversion a commencé, jamais où elle en était.
      avancement: journal?.progress ?? null,
    });

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
  await rendreHandle(backend, echec);

  // 10. RETIRER LE JOURNAL — dernier geste : sa présence signale une migration dont il n'a pas été
  //     franchi.
  await target.removeJournal();
  return migre;
}

/**
 * Rend le handle, puis TRANCHE ce qui doit remonter. La fermeture n'est pas un geste de la
 * migration : c'est la restitution de ce que le geste 4 avait pris.
 *
 * - une fermeture ratée par-dessus une erreur en cours est JOINTE en `cause`, jamais substituée. Le
 *   diagnostic d'une migration est celui de ce qui l'a interrompue ; la substituer ferait lire
 *   « fermeture impossible » là où le volume a été laissé NON IDENTIFIÉ par la barrière, et le
 *   remède — reprendre depuis le journal — ne se déduirait plus du message. La place n'est prise
 *   que si elle est libre : une erreur qui porte déjà sa `cause` ne se la fait pas réécrire ;
 * - une fermeture ratée SEULE remonte telle quelle : affirmer « migré » sans avoir pu rendre le
 *   handle serait affirmer un état que personne n'a constaté.
 *
 * @param {Error | null} echec l'erreur déjà survenue, ou `null` si tout a abouti jusqu'ici
 */
async function rendreHandle(backend, echec) {
  let fermeture = null;
  try {
    await backend.close();
  } catch (cause) {
    fermeture = cause;
  }
  if (echec === null) {
    if (fermeture !== null) throw fermeture;
    return;
  }
  if (fermeture !== null && echec instanceof Error && echec.cause === undefined) {
    echec.cause = fermeture;
  }
  throw echec;
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
