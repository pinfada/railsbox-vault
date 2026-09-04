/**
 * DOUBLE DÉTERMINISTE du support d'un instantané de reprise (#65, ADR 0024).
 *
 * Il rejoue le contrat que le voisin `<volume>.instantane` tient sur OPFS — `etat`, `lire`,
 * `allouer`, `ecrire`, `barriere`, `retirer` — sans OPFS, sans Worker et sans navigateur. Même rôle
 * et même raison d'être que `support-enveloppe-double.mjs` : couper une écriture réelle demanderait
 * de tuer un processus, couper ici demande un rang.
 *
 * Deux sinistres suffisent ici, là où l'enveloppe en demandait trois. L'enveloppe écrit des PAGES
 * qui se remplacent, si bien qu'une déchirure à mi-page laisse un mélange que seule l'étiquette
 * démasque ; l'instantané, lui, est écrit d'un trait puis MARQUÉ, et le seul état intermédiaire qui
 * l'intéresse est « le corps est là, la marque n'y est pas ». `couperAvant` sur le geste de marque
 * le produit exactement.
 */

/** Coupure simulée. Elle porte le rang et la nature du geste, pour que l'épreuve puisse le dire. */
export class CoupureDeCapture extends Error {
  constructor(rang, geste, mode) {
    super(`Coupure simulée : ${mode} le geste ${rang} (${geste}).`);
    this.name = "CoupureDeCapture";
    this.rang = rang;
    this.geste = geste;
    this.mode = mode;
  }
}

/**
 * @param {{ octets?: Uint8Array | null, couperAvant?: number | null,
 *           couperApres?: number | null }} options
 */
export function supportInstantaneDouble({
  octets = null,
  couperAvant = null,
  couperApres = null,
} = {}) {
  let contenu = octets === null ? null : Uint8Array.from(octets);
  const journal = [];
  let rang = 0;
  let coupureAvant = couperAvant;

  const avant = (geste) => {
    rang += 1;
    journal.push({ rang, geste });
    if (coupureAvant === rang) throw new CoupureDeCapture(rang, geste, "avant");
    return rang;
  };
  const apres = (courant, geste) => {
    if (couperApres === courant) throw new CoupureDeCapture(courant, geste, "après");
  };

  return {
    /** Les gestes vus, dans l'ordre. Sert à borner une matrice de coupures. */
    get journal() {
      return journal.map((entree) => ({ ...entree }));
    },
    /** Les octets tels qu'ils sont, y compris à moitié écrits. Jamais une copie embellie. */
    get contenu() {
      return contenu === null ? null : Uint8Array.from(contenu);
    },
    etat: async () => ({ present: contenu !== null, taille: contenu?.byteLength ?? 0 }),
    lire: async (offset, longueur) => {
      journal.push({ rang: rang, geste: "lire", longueur });
      if (contenu === null) throw new RangeError("Instantané absent : rien à lire.");
      const fin = Math.min(offset + longueur, contenu.byteLength);
      // Une lecture COURTE est rendue telle quelle : c'est à l'appelant de la refuser, et l'éprouver
      // ici vérifie sa garde plutôt que de la contourner.
      return contenu.slice(offset, Math.max(offset, fin));
    },
    /**
     * Lit DANS un tampon déjà alloué, et rend le nombre d'octets lus.
     *
     * C'est le geste qui rend la lecture du corps bornée en mémoire : l'appelant alloue UN tampon
     * de `longueurEtat + 16` et y fait tomber le corps, plutôt que de recevoir un second tampon de
     * 253 Mo qu'il faudrait ensuite recopier.
     */
    lireDans: async (cible, offset) => {
      journal.push({ rang: rang, geste: "lireDans", longueur: cible.byteLength });
      if (contenu === null) throw new RangeError("Instantané absent : rien à lire.");
      const lus = Math.max(0, Math.min(cible.byteLength, contenu.byteLength - offset));
      cible.set(contenu.subarray(offset, offset + lus));
      return lus;
    },
    /**
     * ARME une coupure sur le geste de rang `n`, en repartant du geste COURANT.
     *
     * Elle existe pour les scénarios en deux temps — une capture réussie, puis une seconde coupée —
     * que le constructeur seul ne sait pas décrire : son `couperAvant` compte depuis le premier
     * geste du support, pas depuis le premier geste de la seconde capture.
     */
    couperAvant(rangRelatif) {
      coupureAvant = rang + rangRelatif;
    },

    /**
     * TRONQUE le fichier à `taille`, comme un vrai support.
     *
     * Agrandir CONSERVE le préfixe, et ce n'est pas un détail de fidélité : c'est ce qui laisse en
     * place, au milieu du corps d'une capture plus grande, la marque de complétude de la
     * précédente. Une version antérieure de ce double rendait un tampon neuf de zéros, et le
     * scénario du mélange de deux captures n'était alors pas descriptible — le double était plus
     * clément que le support qu'il imite.
     */
    allouer: async (taille) => {
      const courant = avant("allouer");
      const neuf = new Uint8Array(taille);
      if (contenu !== null) neuf.set(contenu.subarray(0, Math.min(taille, contenu.byteLength)));
      contenu = neuf;
      apres(courant, "allouer");
    },
    ecrire: async (offset, aEcrire) => {
      const courant = avant("ecrire");
      if (contenu === null) throw new RangeError("Instantané non alloué : rien à écrire.");
      contenu.set(aEcrire, offset);
      apres(courant, "ecrire");
      return aEcrire.byteLength;
    },
    barriere: async () => {
      const courant = avant("barriere");
      apres(courant, "barriere");
    },
    retirer: async () => {
      const courant = avant("retirer");
      contenu = null;
      apres(courant, "retirer");
      return true;
    },
  };
}
