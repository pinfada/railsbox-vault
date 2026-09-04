// SUPPORT OPFS du voisin `<volume>.instantane` (#65, ADR 0024).
//
// C'est la seule pièce de l'instantané qui touche un `FileSystemSyncAccessHandle`. Elle n'interprète
// aucun octet : elle alloue, lit, écrit, franchit une barrière, ferme et retire — et traduit chaque
// compte rendu du support en état contractuel, parce qu'une valeur de retour se lit, elle ne se
// compare pas à la va-vite (#73).
//
// **Le handle est saisi PARESSEUSEMENT et rendu tôt.** Contrairement au journal de génération et au
// témoin, qui vivent sur le chemin critique de chaque barrière et sont donc tenus pour la session,
// l'instantané n'est touché que deux fois : une lecture à l'ouverture, une écriture à la fermeture.
// Tenir un sixième handle exclusif entre les deux coûterait un verrou permanent sur un fichier dont
// personne n'a besoin pendant que le guest tourne.
//
// **`retirer` ferme AVANT de supprimer**, et l'ordre n'est pas négociable : OPFS refuse de retirer
// une entrée dont un handle d'accès synchrone est ouvert, et l'inverse laisserait le fichier en
// place avec un refus que l'appelant traiterait comme une gêne — c'est-à-dire un instantané périmé
// qui survit exactement là où l'ADR 0024 exige qu'il parte.

import {
  decodeSupportCount,
  readCountFailure,
  toStorageError,
  writeCountFailure,
} from "../opfs-error-mapping.mjs";
import {
  instantaneSidecarName,
  openOpfsSyncAccess,
  removeOpfsVolume,
  statOpfsVolume,
} from "../opfs-sync-access.mjs";

/**
 * Construit le support OPFS d'un instantané. Rien n'est ouvert avant le premier geste.
 *
 * @param {string} volume nom du volume — le nom du voisin en est DÉRIVÉ, jamais reçu
 * @param {{ openHandle?: Function, supprimer?: Function, observer?: Function }} [injections] points
 *   d'injection du support : le vrai OPFS en production, un double déterministe ailleurs
 */
export function supportInstantaneOpfs(
  volume,
  { openHandle = openOpfsSyncAccess, supprimer = removeOpfsVolume, observer = statOpfsVolume } = {},
) {
  const nom = instantaneSidecarName(volume);
  let handle = null;

  const saisir = async () => {
    if (handle !== null) return handle;
    try {
      handle = await openHandle(nom);
    } catch (cause) {
      throw toStorageError(cause, { operation: "open-instantane", volume: nom });
    }
    return handle;
  };

  const fermer = () => {
    if (handle === null) return;
    try {
      handle.close();
    } finally {
      handle = null;
    }
  };

  return {
    nom,

    /**
     * Présence et taille. Un fichier VIDE est un instantané absent, jamais un instantané nul.
     *
     * **Tant qu'aucun handle n'est saisi, la question passe par l'OBSERVATION** — `statOpfsVolume`,
     * qui ouvre avec `create: false` de bout en bout. `openOpfsSyncAccess`, lui, CRÉE : poser la
     * question par une saisie fabriquait un `<volume>.instantane` vide sur tout support qui n'en
     * avait pas, prenait au passage un verrou exclusif dont personne n'avait l'usage, et laissait
     * derrière elle un fichier de zéro octet que rien ne vient jamais retirer. Or la question est
     * posée à CHAQUE ouverture de volume : c'était donc un fichier de plus par volume, toujours.
     *
     * Une fois le handle saisi — après une allocation, une écriture —, l'état vient de LUI : c'est
     * la source la plus fraîche, et l'observation décrirait le fichier d'avant la troncature.
     */
    async etat() {
      if (handle === null) {
        const { present, size } = await observer(nom);
        return { present: present && size > 0, taille: size };
      }
      const taille = handle.getSize();
      return { present: taille > 0, taille };
    },

    /**
     * Lit `longueur` octets. Une lecture COURTE est rendue TELLE QUELLE : c'est à l'appelant de la
     * refuser, et la compléter de zéros ferait passer un fichier tronqué pour un fichier entier.
     * Un code d'échec casté en non signé, lui, n'est pas une lecture courte — c'est une panne, et
     * elle est typée.
     */
    async lire(offset, longueur) {
      const cible = new Uint8Array(longueur);
      const lus = await this.lireDans(cible, offset);
      return lus === longueur ? cible : cible.subarray(0, lus);
    },

    /**
     * Lit DANS un tampon déjà alloué, et rend le nombre d'octets lus.
     *
     * C'est le geste qui borne la mémoire d'une reprise : l'appelant alloue UN tampon de
     * `longueurEtat + 16` et y fait tomber le corps, là où un `lire` lui aurait rendu un second
     * tampon de 253 Mo à recopier. Même contrat, même raison que `JournalDeGeneration.lireDans`.
     */
    async lireDans(cible, offset) {
      const longueur = cible.byteLength;
      const lus = (await saisir()).read(cible, { at: offset });
      if (decodeSupportCount(lus, longueur).kind === "errno") {
        throw readCountFailure(lus, {
          requested: longueur,
          volume: nom,
          offset,
          operation: "read-instantane",
        });
      }
      return lus;
    },

    /**
     * Ramène le fichier à `taille` EXACTEMENT, avant toute écriture.
     *
     * La troncature n'est pas une commodité d'allocation : un instantané antérieur plus long
     * laisserait sa queue derrière celui-ci, et sa propre marque de complétude tomberait au-delà de
     * la nouvelle. Le fichier se relirait alors comme complet alors qu'il serait un mélange de deux
     * captures.
     */
    async allouer(taille) {
      // L'échec est TYPÉ comme ceux de la lecture et de l'écriture : c'est le geste qui RÉSERVE la
      // place d'un quart de gibioctet, et c'est donc le premier à rencontrer un quota épuisé. Le
      // laisser remonter le `name` brut du moteur aurait rendu « QuotaExceededError » là où le
      // dépôt promet un état contractuel nommé.
      try {
        (await saisir()).truncate(taille);
      } catch (cause) {
        throw toStorageError(cause, { operation: "allocate-instantane", volume: nom, taille });
      }
    },

    /** Écrit. Tout compte qui n'est pas exact est un échec TYPÉ, jamais avalé (#73). */
    async ecrire(offset, octets) {
      const echec = writeCountFailure((await saisir()).write(octets, { at: offset }), {
        requested: octets.byteLength,
        volume: nom,
        offset,
        operation: "write-instantane",
      });
      if (echec !== null) throw echec;
      return octets.byteLength;
    },

    /** Barrière du voisin. Son retour vaut durabilité de ce qui a été écrit avant elle. */
    async barriere() {
      try {
        (await saisir()).flush();
      } catch (cause) {
        throw toStorageError(cause, { operation: "flush-instantane", volume: nom });
      }
    },

    /** FERME puis SUPPRIME. L'ordre est imposé par OPFS, et il est écrit en tête de ce module. */
    async retirer() {
      fermer();
      return supprimer(nom);
    },

    /** Rend le handle sans supprimer. À appeler quand l'instantané est GARDÉ. */
    fermer,
  };
}
