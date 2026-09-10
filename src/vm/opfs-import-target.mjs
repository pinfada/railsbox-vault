// Cible OPFS de la restauration (#12, `VAULT-PORT-001`). Elle branche l'orchestration pure de
// `volume-import.mjs` sur le support réel : le backend de blocs de #6 pour le volume, et le
// MANIFESTE VOISIN de `opfs-volume-open.mjs` pour son identité.
//
// Pourquoi un fichier voisin, et non un en-tête dans le volume : la géométrie de #6 est un multiple
// de 512 octets destiné à v86 tel quel — le guest monte ces octets comme un disque. Y intercaler un
// manifeste décalerait le système de fichiers du guest. Le manifeste vit donc à côté, sous le nom du
// volume suivi du suffixe réservé, dans le même répertoire OPFS et sous la même validation de
// frontière.
//
// C'est ce voisin qui porte la VALIDITÉ du volume, et l'ordre des gestes en découle : la
// restauration le retire une fois la cible ouverte et avant le premier octet écrit, puis ne le
// réécrit qu'après avoir relu tout le volume. Un volume sans son voisin est un volume non
// identifié — `openVolumeForWrite` refuse alors de l'ouvrir en écriture, par
// `VAULT_MANIFEST_UNIDENTIFIED` (#10). Une restauration interrompue ne peut donc pas se faire passer
// pour un volume valide.
//
// Depuis #149 (ADR 0027), la cible pose un SIXIÈME voisin : le fichier d'enveloppes `<volume>.cles`,
// reconstruit depuis la page que l'archive emporte. Il est écrit APRÈS le contenu relu et AVANT le
// manifeste, pour que l'ordre ci-dessus tienne sa promesse d'un cran plus loin : un volume déclaré
// complet porte toujours de quoi être ouvert.

import { BlockJournal } from "./block-journal.mjs";
import { fichierDEnveloppeDepuisLaPage } from "./enveloppe-de-recuperation.mjs";
import { ouvrirVolumeBrut } from "./opfs-volume-brut.mjs";
import { isManifestError } from "./manifest-errors.mjs";
import {
  engagementSidecarName,
  enveloppeSidecarName,
  generationJournalName,
  manifestSidecarName,
  migrationJournalName,
  removeOpfsVolume,
  instantaneSidecarName,
  temoinSequenceName,
  statOpfsVolume,
} from "./opfs-sync-access.mjs";
import {
  readVolumeManifest,
  revokeVolumeManifest,
  writeSidecarBytes,
} from "./opfs-volume-open.mjs";

/**
 * Octets rendus pour un voisin PRÉSENT mais illisible — trop grand pour être lu sous le budget de
 * surmémoire, ou inaccessible. Ce n'est ni `null` (« pas de voisin »), ni un manifeste :
 * `importArchive` le refusera par `parseManifest` et s'arrêtera SANS rien détruire. L'échec devient
 * un fait observé, il ne disparaît pas.
 */
const VOISIN_ILLISIBLE = new TextEncoder().encode("vault:voisin-illisible");

/**
 * Construit la cible OPFS attendue par `importArchive`.
 *
 * @param {string} volume nom du volume à restaurer
 * @param {{ journal?: BlockJournal }} [options] journal du backend, pour publier les compteurs d'E/S
 */
export function createOpfsImportTarget(
  volume,
  {
    journal = new BlockJournal(),
    stat = statOpfsVolume,
    readManifest = readVolumeManifest,
    revoke = revokeVolumeManifest,
    writeManifest = writeSidecarBytes,
    removeSidecar = removeOpfsVolume,
    openVolume = ouvrirVolumeBrut,
  } = {},
) {
  const sidecar = manifestSidecarName(volume);

  return {
    volume,
    sidecar,
    journal,

    /** Observe la cible SANS la créer : poser une question ne doit rien fabriquer sur le support. */
    async inspect() {
      const etatVolume = await stat(volume);
      let manifestBytes;
      try {
        manifestBytes = await readManifest(volume);
      } catch (cause) {
        // SEULE une erreur de FORMAT devient un fait observé. Un voisin au-delà du plafond de
        // lecture n'est pas un manifeste : le dire à l'orchestration la fait refuser sans rien
        // détruire. Un échec de SUPPORT — volume occupé, handle perdu, OPFS absent — est autre
        // chose, et le convertir ferait remonter « cible non vide » là où l'exploitant doit lire
        // « volume occupé ». Le refus resterait sûr, mais il nommerait la mauvaise cause, donc
        // enverrait vers le mauvais remède. Il est propagé tel quel.
        if (!isManifestError(cause)) throw cause;
        manifestBytes = VOISIN_ILLISIBLE;
      }
      return { present: etatVolume.present, size: etatVolume.size, manifestBytes };
    },

    /**
     * Ouvre le FICHIER du volume en exclusivité, à la taille que l'archive porte, en accès BRUT.
     *
     * **Brut, et c'est la décision 7 de l'ADR 0016 rendue exécutable.** Une archive porte le fichier
     * d'un volume tel quel ; le restaurer, c'est le RECOPIER. Passer par le backend chiffré ferait
     * l'inverse de ce qu'on veut : les octets de l'archive — déjà chiffrés pour un volume v3 —
     * deviendraient la charge en clair d'un volume neuf, et la restauration exigerait une clé pour
     * un geste qui n'en a pas besoin. La tranche (a) de #18 refusait la restauration d'un v3 faute
     * de cette porte.
     *
     * Une restauration réécrit le fichier ENTIER, d'un bloc à l'autre, avec une seule barrière à la
     * fin. Ce n'est pas une génération du guest : la restauration porte déjà son propre protocole
     * d'atomicité — manifeste révoqué avant la première mutation, volume relu depuis le support,
     * manifeste inscrit en dernier (ADR 0009) —, et une restauration interrompue laisse un volume
     * NON IDENTIFIÉ que le boot refuse. Empiler le journal de génération par-dessus doublerait les
     * écritures d'une archive de plusieurs centaines de mébioctets et buterait sur le plafond de
     * charge, sans rien garantir de plus.
     *
     * OUVRIR NE MUTE RIEN, et surtout pas le journal de génération. Une version antérieure de cette
     * tranche le retirait ici, avant même d'acquérir le handle : une ouverture qui échouait pour une
     * raison étrangère à la restauration — un second onglet détenant le volume (#8), un handle
     * perdu, un quota — rendait alors un refus PROPRE, manifeste jamais révoqué, volume en apparence
     * intact… alors que la dernière barrière ACQUITTÉE du guest venait d'être effacée, hors de tout
     * code `VAULT_STORAGE_GENERATION_*`. Le journal est retiré par `discardGeneration`, au premier
     * geste mutant.
     */
    open({ size }) {
      return openVolume({ name: volume, size });
    },

    /** Retire le manifeste : le volume cesse d'être identifié, donc d'être inscriptible. */
    async revokeManifest() {
      await revoke(volume);
    },

    /**
     * Retire le journal de génération du volume ÉCRASÉ, ET son témoin de séquence. Appelé APRÈS
     * `revokeManifest`, jamais avant.
     *
     * Laisser le JOURNAL ferait rejouer, au premier boot suivant, une génération du volume d'AVANT
     * par-dessus le volume restauré — une corruption silencieuse d'un volume pourtant relu et
     * vérifié. Le retirer trop tôt effacerait une écriture acquittée d'un volume que la restauration
     * n'a pas encore touché. L'ordre — révoquer, puis écarter — fait qu'une coupure entre les deux
     * laisse un volume NON IDENTIFIÉ, que le boot refuse : le seul état sûr des deux.
     *
     * Laisser le TÉMOIN (#19, ADR 0019) coûterait l'inverse, et c'est aussi grave : il atteste une
     * séquence du volume d'AVANT, que le volume restauré n'a jamais atteinte. Le boot suivant
     * refuserait alors un volume parfaitement sain, et le message désignerait un retour arrière qui
     * n'a pas eu lieu. Un témoin ne date QUE le volume qu'il accompagne ; réécrire le volume
     * entièrement le prive de son objet, exactement comme le journal.
     */
    async discardGeneration() {
      await removeSidecar(generationJournalName(volume));
      // Et l'ENGAGEMENT d'une restauration ANTÉRIEURE (#181) : il atteste une archive que le volume
      // qu'on écrase ne porte plus. Le laisser ferait vérifier, à la première ouverture, un
      // engagement qui ne parle pas de ces octets-ci — donc un REFUS, exact mais fabriqué par le
      // produit lui-même. Celui de l'archive en cours est posé par `commitEngagement`, plus tard.
      await removeSidecar(engagementSidecarName(volume));
      await removeSidecar(temoinSequenceName(volume));
      // Et l'INSTANTANÉ (#65, ADR 0024, décision 8), pour la raison du témoin, portée d'un cran :
      // il décrit un état MÉMOIRE lié à une génération que le volume restauré n'a jamais portée.
      // Sa liaison le ferait écarter de toute façon ; le retirer ici évite qu'un volume restauré
      // traîne, entre deux ouvertures, 250 Mio de RAM invitée d'une session étrangère.
      return removeSidecar(instantaneSidecarName(volume));
    },

    /**
     * Inscrit le manifeste de l'archive : dernier geste de la restauration. Le JOURNAL DE MIGRATION
     * éventuel est retiré au passage (#13) : le volume vient d'être réécrit intégralement depuis
     * l'archive, si bien qu'un journal laissé par une migration interrompue ne décrit plus aucun
     * octet présent. Le garder le ferait FAIRE AUTORITÉ sur le format de départ à la prochaine
     * migration, et rendrait le volume restauré non migrable jusqu'à un nettoyage manuel.
     */
    /**
     * POSE l'enveloppe de récupération que l'archive emportait, ou RETIRE celle de la cible écrasée
     * (#149, ADR 0027). Appelée APRÈS la relecture du contenu, AVANT le manifeste.
     *
     * ## Ce module est le seul du chemin d'import à nommer le voisin `.cles`, et c'est voulu
     *
     * `volume-import.mjs` orchestre et ne connaît aucun nom de fichier ; c'est ici que vivent tous
     * les voisins d'un volume — manifeste, journaux, témoin, instantané —, et l'enveloppe en est un
     * cinquième. L'épreuve de l'ADR 0020 décision 6, transformée par l'ADR 0027, relit exactement
     * cela.
     *
     * ## Retirer est aussi important que poser
     *
     * `bytes === null` couvre deux cas, et le second est le dangereux : une archive v1, ou une
     * archive v2 d'un volume sans moyen de récupération, écrasant une cible qui portait SA propre
     * enveloppe. Cette enveloppe décrit un volume qui n'existe plus : ses emplacements enveloppent
     * une DEK que le volume restauré n'emploie pas, et sa racine authentifie un AUTRE identifiant de
     * volume. La laisser ferait répondre `VAULT_ENVELOPPE_IDENTITE` à qui essaie sa clé — un
     * diagnostic exact pour une cause qu'on aurait fabriquée soi-même. Le volume restauré se
     * retrouve alors sans enveloppe, ce qui est l'état vrai : `VAULT_ENVELOPPE_ABSENTE` envoie en
     * créer une, et c'est le bon remède.
     */
    async commitRecoveryEnvelope(bytes) {
      const voisin = enveloppeSidecarName(volume);
      if (bytes === null) {
        await removeSidecar(voisin);
        return;
      }
      // La page est RE-VALIDÉE ici, au moment d'écrire : `fichierDEnveloppeDepuisLaPage` refuse une
      // page qui ne serait pas une enveloppe de récupération seule. La vérification a déjà eu lieu
      // dans `volume-import.mjs`, avant toute mutation ; celle-ci est la garde du module qui écrit,
      // et elle tient même si un appelant futur venait par un autre chemin.
      await writeManifest(voisin, fichierDEnveloppeDepuisLaPage(bytes));
    },

    /**
     * DÉPOSE l'ENGAGEMENT que l'archive portait, à côté du volume (#181, ADR 0033).
     *
     * ## Pourquoi la restauration dépose au lieu de vérifier
     *
     * Elle N'A PAS LA CLÉ, et c'est une propriété du § 7.5 qu'on garde : elle recopie des octets
     * chiffrés sans jamais en ouvrir un. Elle vérifie donc ce qu'elle peut sans clé — présence,
     * longueur, cohérence de l'en-tête, version d'archive lue — et laisse la vérification
     * CRYPTOGRAPHIQUE à la première ouverture, qui, elle, tient la clé.
     *
     * ## Il est posé AVANT le manifeste, comme l'enveloppe
     *
     * Le manifeste est ce qui DÉCLARE le volume complet. Un volume déclaré complet doit porter tout
     * ce qu'il faut pour l'ouvrir : son enveloppe, et désormais son engagement. Coupé entre les
     * deux, le volume est non identifié, donc refusé au boot — le seul état sûr des deux.
     */
    async commitEngagement(bytes) {
      // `null` couvre le seul cas où une archive n'engage rien : elle décrit un volume ANTÉRIEUR à
      // v3, qui n'est pas chiffré. RETIRER est alors aussi important que poser — la cible écrasée
      // pouvait porter l'engagement d'une restauration antérieure, qui atteste des octets qui ne
      // sont plus là. `discardGeneration` l'a déjà fait ; ceci est la garde du module qui écrit.
      if (bytes === null) {
        await removeSidecar(engagementSidecarName(volume));
        return;
      }
      await writeManifest(engagementSidecarName(volume), bytes);
    },

    async commitManifest(bytes) {
      await writeManifest(sidecar, bytes);
      await removeSidecar(migrationJournalName(volume));
    },
  };
}
