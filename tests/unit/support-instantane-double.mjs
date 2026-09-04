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

  const avant = (geste) => {
    rang += 1;
    journal.push({ rang, geste });
    if (couperAvant === rang) throw new CoupureDeCapture(rang, geste, "avant");
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
      if (contenu === null) throw new RangeError("Instantané absent : rien à lire.");
      const fin = Math.min(offset + longueur, contenu.byteLength);
      // Une lecture COURTE est rendue telle quelle : c'est à l'appelant de la refuser, et l'éprouver
      // ici vérifie sa garde plutôt que de la contourner.
      return contenu.slice(offset, Math.max(offset, fin));
    },
    allouer: async (taille) => {
      const courant = avant("allouer");
      contenu = new Uint8Array(taille);
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
