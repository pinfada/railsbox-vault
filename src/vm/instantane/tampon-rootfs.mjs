// TAMPON DE ROOTFS ÉPHÉMÈRE, à état DIFFÉRENTIEL (#65, ADR 0024).
//
// Le rootfs du guest de référence (`hda`) vit en RAM : les écritures du guest y restent, et rien
// n'est écrit sur le réseau ni sur OPFS. Jusqu'à #65, il était remis à v86 comme
// `{ buffer: ArrayBuffer }`, ce dont v86 fait un `SyncBuffer` — dont `get_state()` rend **le disque
// entier**. Sur l'image de référence, cela ajouterait **385 Mio** à chaque instantané, à côté de
// 250 Mio d'état v86 : l'instantané pèserait plus que le volume qu'il accélère.
//
// Ce tampon tient le même contrat de lecture et d'écriture, à la vitesse près d'un `SyncBuffer` — la
// mémoire est la même, les vues rendues sont les mêmes —, et il ne rend dans son état que les BLOCS
// RÉELLEMENT ÉCRITS depuis le chargement de l'image. Un rootfs restauré est donc l'image PRISTINE
// plus le delta de la session capturée.
//
// ## Pourquoi ce n'est PAS un cache, et pourquoi ça compte
//
// Le delta n'est pas une optimisation qu'on pourrait perdre sans dommage : sans lui, restaurer un
// instantané sur un rootfs pristine ferait diverger la mémoire du guest — qui croit tenir ses
// écritures en cache de page — et le disque qu'elle relira à la première éviction. Le tampon rend
// donc obligatoirement l'un des deux : le disque entier, ou le disque pristine PLUS la trace exacte
// de ce qui a été écrit. Il rend la seconde, parce que la première ne tient pas dans le budget.
//
// ## La granularité est celle de v86, pas la nôtre
//
// Les blocs font `BLOC_OCTETS` octets. Trop gros, un secteur écrit en salit trop ; trop petit, la
// table de blocs coûte plus que les octets qu'elle décrit. 4096 est la taille de page du guest et
// l'unité d'écriture d'ext4 : c'est la granularité à laquelle le guest salit réellement.

/** Taille d'un bloc du delta. La page du guest, et l'unité d'écriture d'ext4. */
export const BLOC_OCTETS = 4096;

/**
 * Images DÉJÀ adoptées. Un tampon écrit DANS son image — il n'en garde aucune copie —, si bien
 * qu'une image réemployée pour un second boot ne serait plus pristine.
 *
 * Ce n'est pas une précaution abstraite : l'empreinte de l'image d'un instantané est prise à
 * l'ACQUISITION du runtime (ADR 0024), avant le premier battement du guest. Réemployer le paquet
 * d'artefacts d'un boot pour un autre rendrait cette empreinte fausse — elle décrirait une image
 * que le rootfs n'est plus. La réadoption est donc REFUSÉE, plutôt que laissée à la vigilance de
 * l'appelant.
 *
 * Un `WeakSet` : la marque disparaît avec l'image, et ne retient rien.
 */
const ADOPTEES = new WeakSet();

/**
 * Construit le tampon de rootfs éphémère.
 *
 * @param {Uint8Array} image les octets PRISTINE du rootfs. Ils sont adoptés, non recopiés : le
 *   Worker vient de les télécharger et n'en garde pas d'autre référence.
 * @param {{ blocOctets?: number }} [options]
 */
export function creerTamponRootfs(image, { blocOctets = BLOC_OCTETS } = {}) {
  if (ADOPTEES.has(image)) {
    throw new Error(
      "Image de rootfs déjà adoptée par un tampon : elle a été écrite par un guest, elle n'est plus pristine, et l'empreinte d'image prise à l'acquisition ne la décrirait plus. Acquérir le runtime une seconde fois est le geste correct.",
    );
  }
  ADOPTEES.add(image);
  const memoire = image;
  /** Index des blocs écrits DEPUIS le chargement. C'est tout l'état que ce tampon publie. */
  const salis = new Set();

  const salir = (debut, longueur) => {
    const premier = Math.floor(debut / blocOctets);
    const dernier = Math.floor((debut + longueur - 1) / blocOctets);
    for (let bloc = premier; bloc <= dernier; bloc += 1) salis.add(bloc);
  };

  return {
    byteLength: memoire.byteLength,
    onload: undefined,
    onprogress: undefined,

    /** v86 attend `onload` même quand rien n'est à charger : les octets sont déjà là. */
    load() {
      if (typeof this.onload === "function") this.onload({ buffer: memoire.buffer });
    },

    /**
     * Lecture SYNCHRONE, comme celle d'un `SyncBuffer`. La vue est rendue telle quelle : `ide.js`
     * recopie ce dont il a besoin, et c'est déjà ce que fait le tampon amont.
     */
    get(start, length, fn) {
      fn(memoire.subarray(start, start + length));
    },

    set(start, slice, fn) {
      memoire.set(slice, start);
      salir(start, slice.byteLength);
      fn();
    },

    get_buffer(fn) {
      fn(memoire.buffer);
    },

    /**
     * L'état : la longueur, puis les blocs ÉCRITS, chacun avec son index.
     *
     * La forme — un tableau de paires `[index, octets]` — est celle que le sérialiseur d'état de v86
     * accepte : il traverse les tableaux et transforme chaque tableau typé en référence de tampon.
     * C'est aussi, à peu de choses près, celle que ses propres tampons asynchrones emploient.
     */
    get_state() {
      const blocs = [];
      for (const bloc of salis) {
        const debut = bloc * blocOctets;
        blocs.push([bloc, memoire.slice(debut, Math.min(debut + blocOctets, memoire.byteLength))]);
      }
      return [memoire.byteLength, blocOctets, blocs];
    },

    /**
     * REPOSE un delta sur l'image pristine.
     *
     * La longueur et la granularité sont CONFRONTÉES, jamais adoptées : un delta produit sur une
     * autre image, ou sous une autre granularité, décrirait d'autres octets aux mêmes index. Ce
     * refus est le dernier filet — l'empreinte d'image de la liaison (ADR 0024) l'a normalement
     * déjà refusé —, et un dernier filet qui se tairait ne servirait à rien.
     */
    set_state(etat) {
      const [longueur, granularite, blocs] = etat;
      if (longueur !== memoire.byteLength || granularite !== blocOctets) {
        throw new Error(
          `Delta de rootfs refusé : il décrit ${longueur} octets par blocs de ${granularite}, ce tampon en porte ${memoire.byteLength} par blocs de ${blocOctets}.`,
        );
      }
      // Le tampon d'accueil doit être PRISTINE, et ce refus est une correction : reposer un delta
      // sur un tampon déjà sali laissait en place les blocs salis que le delta ne recouvre pas. Le
      // disque restauré portait alors, EN PLUS de la capture, les écritures du tampon d'accueil —
      // un disque à moitié faux, que rien ne signalait. Le tampon ADOPTE son image et n'en garde
      // aucune copie : il ne peut pas revenir à pristine, il ne peut que refuser.
      if (salis.size > 0) {
        throw new Error(
          `Delta de rootfs refusé : ce tampon porte déjà ${salis.size} bloc(s) écrit(s). Un delta reposé par-dessus laisserait en place ceux que le delta ne recouvre pas, et le disque restauré ne serait pas celui de la capture.`,
        );
      }
      for (const [bloc, octets] of blocs) {
        memoire.set(octets, bloc * blocOctets);
        salis.add(bloc);
      }
    },

    /** Ce que le delta pèse, en octets. Publié : la taille d'un instantané se mesure, pas se suppose. */
    deltaOctets() {
      return salis.size * blocOctets;
    },
  };
}
