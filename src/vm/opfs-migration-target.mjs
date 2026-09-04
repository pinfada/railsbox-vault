// Cible OPFS de la MIGRATION (#13, `VAULT-COMPAT-001`). Elle branche l'orchestration pure de
// `volume-migration.mjs` sur le support réel : le backend de blocs de #6 pour le volume, le
// MANIFESTE VOISIN de `opfs-volume-open.mjs` pour son identité, et un second voisin — le JOURNAL DE
// REPRISE — pour ce qu'une migration inachevée doit laisser derrière elle.
//
// Pourquoi un journal voisin plutôt qu'un drapeau dans le manifeste : la migration RÉVOQUE le
// manifeste avant de toucher quoi que ce soit (ADR 0009, geste 4). Une fois révoqué, plus rien ne
// dirait de quel format le volume vient — la reprise serait impossible et il faudrait redemander une
// archive, transformant une interruption en impasse. Le journal porte donc le manifeste SOURCE, la
// chaîne visée et la preuve de sauvegarde retenue.
//
// Les deux voisins vivent dans le même répertoire OPFS que le volume, sous des suffixes RÉSERVÉS par
// la frontière de nommage (`opfs-sync-access.mjs`) : aucun volume ne peut les porter, et la longueur
// maximale d'un nom de volume tient compte du plus long d'entre eux — un volume créable est toujours
// un volume migrable.

import { BlockJournal } from "./block-journal.mjs";
import { MIGRATION_ERROR_CODES, MigrationError } from "./migration-errors.mjs";
import { ouvrirVolumeBrut } from "./opfs-volume-brut.mjs";
import {
  generationJournalName,
  manifestSidecarName,
  migrationJournalName,
  removeOpfsVolume,
  statOpfsVolume,
  instantaneSidecarName,
  temoinSequenceName,
} from "./opfs-sync-access.mjs";
import {
  readSidecarBytes,
  readVolumeManifest,
  revokeVolumeManifest,
  writeSidecarBytes,
} from "./opfs-volume-open.mjs";

/**
 * Construit la cible OPFS attendue par `migrateVolume`.
 *
 * ## Dépassement du plafond de 50 lignes, gardé — décidé par #77, généralisé par #93
 *
 * Cette fabrique compte 75 lignes et le restera. Le plafond du dépôt vise les fonctions qui
 * ENCHAÎNENT des décisions ; celle-ci n'en prend aucune. Ses 75 lignes sont huit paramètres
 * injectables, deux calculs de nom, et un objet littéral de neuf méthodes dont chacune tient sur
 * une ligne de délégation accompagnée de son commentaire. Le seul branchement du corps est le
 * `try/catch` de `readJournal`, qui traduit un refus de taille en refus TYPÉ de migration.
 *
 * La découper reviendrait à répartir un contrat de neuf gestes entre plusieurs fabriques
 * partielles, puis à le recomposer : le lecteur qui veut savoir ce que `migrateVolume` peut demander
 * à sa cible devrait rassembler ce qu'un seul écran lui montre aujourd'hui. La métrique s'en
 * trouverait satisfaite et la lisibilité dégradée — l'inverse de ce que le plafond cherche.
 *
 * #77 avait inscrit cette exception à la main, en laissant la question de fond ouverte : le plafond
 * doit-il compter le littéral rendu par une fabrique, idiome dominant du dépôt ? #93 l'a tranchée
 * et en a fait une MESURE — `estFabriqueDeContrat` dans `tests/unit/mesure-taille-des-fonctions.mjs`.
 * Cette fabrique n'est donc plus une exception nommée : elle est admise parce que son corps hors du
 * littéral fait 19 lignes et qu'aucune de ses neuf méthodes n'en fait plus d'une douzaine. Le jour
 * où l'une de ces deux conditions cède, l'épreuve la redemande — sans qu'une revue ait à y penser.
 *
 * @param {string} volume nom du volume à migrer
 * @param {{ journal?: BlockJournal }} [options] journal du backend, pour publier les compteurs d'E/S
 */
export function createOpfsMigrationTarget(
  volume,
  {
    journal = new BlockJournal(),
    stat = statOpfsVolume,
    readManifest = readVolumeManifest,
    readSidecar = readSidecarBytes,
    revoke = revokeVolumeManifest,
    writeSidecar = writeSidecarBytes,
    removeSidecar = removeOpfsVolume,
    openVolume = ouvrirVolumeBrut,
  } = {},
) {
  const manifeste = manifestSidecarName(volume);
  const journalVoisin = migrationJournalName(volume);
  // Le TROISIÈME voisin (#16) : le journal de GÉNÉRATION du volume source. La migration doit le
  // solder — reporter ce qu'il a validé, puis l'écarter —, sans quoi le volume migré porterait un
  // journal d'un format qu'il ne sait plus lire.
  const generationVoisine = generationJournalName(volume);

  return {
    volume,
    sidecar: manifeste,
    journalSidecar: journalVoisin,
    generationSidecar: generationVoisine,
    journal,
    /** Les octets du journal de GÉNÉRATION du volume source, ou `null` s'il n'y en a pas. */
    readGenerationJournal: () => readSidecar(generationVoisine),
    /**
     * ÉCARTE ce journal, ET le témoin de séquence qui l'accompagne (#19). Idempotent : une reprise
     * les retrouve déjà retirés.
     *
     * Le témoin part avec le journal pour la même raison que sur la restauration : il atteste une
     * séquence du volume d'AVANT la migration, et le volume migré ne l'a jamais atteinte. Le garder
     * ferait refuser, au premier boot suivant, un volume que la migration vient de vérifier.
     */
    removeGenerationJournal: async () => {
      await removeSidecar(generationVoisine);
      await removeSidecar(temoinSequenceName(volume));
      // Et l'INSTANTANÉ (#65, ADR 0024, décision 8). Sa liaison porte la version de format du
      // volume : après une migration, elle serait fausse en plus d'être périmée. Le retirer ici
      // évite qu'un volume migré traîne la RAM invitée d'une session d'avant la migration.
      return removeSidecar(instantaneSidecarName(volume));
    },

    /** Observe le volume SANS le créer : poser une question ne doit rien fabriquer sur le support. */
    inspect() {
      return stat(volume);
    },

    /** Octets du manifeste voisin, ou `null`. Les refus de #10 remontent tels quels. */
    readManifest() {
      return readManifest(volume);
    },

    /**
     * Octets du journal de reprise, ou `null`. Un journal démesuré n'est pas lu : c'est un refus
     * TYPÉ de migration, jamais un journal deviné ni un fichier supprimé pour se faire de la place.
     */
    async readJournal() {
      try {
        return await readSidecar(journalVoisin);
      } catch (cause) {
        if (!(cause instanceof RangeError)) throw cause;
        throw new MigrationError(
          MIGRATION_ERROR_CODES.journalMalformed,
          `Journal de migration illisible : ${cause.message} Il n'est ni supprimé, ni deviné : l'écarter est un geste explicite.`,
          { volume, sidecar: journalVoisin },
        );
      }
    },

    /**
     * Ouvre le FICHIER du volume en exclusivité et en accès BRUT, à sa taille actuelle.
     *
     * Brut depuis #101 : la migration v2 → v3 réécrit les OCTETS — elle agrandit le fichier, décale
     * la charge et scelle chaque secteur. Passer par le backend chiffré serait circulaire : il
     * exigerait un en-tête v3 que la migration a justement pour objet d'écrire.
     *
     * La taille passée est celle qu'on a OBSERVÉE, jamais une taille visée : un volume n'est
     * retaillé que par la conversion elle-même, sous le manifeste déjà révoqué.
     */
    open({ size }) {
      return openVolume({ name: volume, size });
    },

    /** Inscrit le journal de reprise. Il précède la révocation, et lui seul rend la reprise possible. */
    async writeJournal(bytes) {
      await writeSidecar(journalVoisin, bytes);
    },

    /** Retire le manifeste : le volume cesse d'être identifié, donc d'être inscriptible. */
    async revokeManifest() {
      await revoke(volume);
    },

    /** Inscrit le manifeste migré : l'avant-dernier geste, et le seul à rendre le volume valide. */
    async commitManifest(bytes) {
      await writeSidecar(manifeste, bytes);
    },

    /** Retire le journal : dernier geste. Sa présence signale un dernier geste non franchi. */
    async removeJournal() {
      await removeSidecar(journalVoisin);
    },
  };
}
