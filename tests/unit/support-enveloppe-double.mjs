/**
 * DOUBLE DÉTERMINISTE du support d'une enveloppe de clé (#21, ADR 0020).
 *
 * Il rejoue exactement le contrat que `supportEnveloppeOpfs` tient sur OPFS — `etat`, `lire`,
 * `allouer`, `ecrire`, `barriere` — sans OPFS, sans Worker et sans navigateur. C'est ce qui permet
 * d'éprouver l'ATOMICITÉ à chaque rang sous Node : couper une écriture réelle demanderait de tuer un
 * processus, couper ici demande une graine.
 *
 * Trois sinistres, et ils ne décrivent pas le même événement :
 *
 *  - `couperAvant` — le geste de rang `n` n'a AUCUN effet, puis tout s'arrête. C'est l'onglet fermé
 *    entre deux appels ;
 *  - `couperApres` — le geste de rang `n` porte ENTIÈREMENT, puis tout s'arrête. C'est l'onglet
 *    fermé juste après un appel qui a rendu ;
 *  - `dechirerA` — le geste de rang `n` n'écrit qu'une PARTIE de ses octets, puis tout s'arrête.
 *    C'est l'écriture déchirée que le support peut produire de lui-même, et le seul des trois qui
 *    laisse une page à moitié neuve.
 *
 * Sans les trois, la matrice de coupures ne dirait rien de deux tiers des états atteignables.
 *
 * **`octetsDeDechirure` existe parce qu'une déchirure à mi-page ne déchire rien d'intéressant.** La
 * liste des emplacements d'une enveloppe ordinaire tient dans les premières centaines d'octets d'une
 * page de 8192 : couper à 4096 écrit donc la page NEUVE en entier, et le sinistre devient un
 * synonyme de « coupure après ». La mesure l'a montré sur une mutation de garde, qui a survécu là où
 * elle devait mourir. Une déchirure qui coupe DANS l'en-tête laisse au contraire un mélange — la
 * version neuve au-dessus de l'ancienne liste — que seule l'étiquette de la racine démasque.
 */

/** Coupure simulée. Elle porte le rang et la nature du geste, pour que l'épreuve puisse le dire. */
export class CoupureSimulee extends Error {
  constructor(rang, geste, mode) {
    super(`Coupure simulée : ${mode} le geste ${rang} (${geste}).`);
    this.name = "CoupureSimulee";
    this.rang = rang;
    this.geste = geste;
    this.mode = mode;
  }
}

/**
 * @param {{ octets?: Uint8Array | null, couperAvant?: number | null, couperApres?: number | null,
 *           dechirerA?: number | null, octetsDeDechirure?: number | null }} options
 */
export function supportDouble({
  octets = null,
  couperAvant = null,
  couperApres = null,
  dechirerA = null,
  octetsDeDechirure = null,
} = {}) {
  let contenu = octets === null ? null : Uint8Array.from(octets);
  const journal = [];
  let rang = 0;

  const avant = (geste) => {
    rang += 1;
    journal.push({ rang, geste });
    if (couperAvant === rang) throw new CoupureSimulee(rang, geste, "avant");
    return rang;
  };
  const apres = (courant, geste) => {
    if (couperApres === courant) throw new CoupureSimulee(courant, geste, "après");
  };

  return {
    /** Nombre de gestes que ce support a vus. Sert à borner la matrice de coupures. */
    get gestes() {
      return journal.length;
    },
    /** Les octets tels qu'ils sont, y compris à moitié écrits. Jamais une copie embellie. */
    get contenu() {
      return contenu === null ? null : Uint8Array.from(contenu);
    },
    etat: async () => ({ present: contenu !== null, taille: contenu?.byteLength ?? 0 }),
    lire: async (offset, longueur) => {
      if (contenu === null) throw new RangeError("Enveloppe absente : rien à lire.");
      if (offset + longueur > contenu.byteLength) {
        throw new RangeError(`Lecture hors bornes : ${longueur} octets à ${offset}.`);
      }
      return contenu.slice(offset, offset + longueur);
    },
    allouer: async (taille) => {
      const courant = avant("allouer");
      const neuf = new Uint8Array(taille);
      if (contenu !== null) neuf.set(contenu.subarray(0, Math.min(taille, contenu.byteLength)));
      contenu = neuf;
      apres(courant, "allouer");
    },
    ecrire: async (offset, aEcrire) => {
      const courant = avant("ecrire");
      if (contenu === null) throw new RangeError("Enveloppe absente : rien à écrire.");
      const longueur =
        dechirerA === courant
          ? (octetsDeDechirure ?? Math.floor(aEcrire.byteLength / 2))
          : aEcrire.byteLength;
      contenu.set(aEcrire.subarray(0, longueur), offset);
      if (dechirerA === courant) throw new CoupureSimulee(courant, "ecrire", "déchirure");
      apres(courant, "ecrire");
    },
    barriere: async () => {
      const courant = avant("barriere");
      apres(courant, "barriere");
    },
  };
}

/**
 * Aléas SCRIPTÉS : identifiants et nonces tirés d'une liste, dans l'ordre.
 *
 * C'est la seule façon de confronter le chemin de production à des vecteurs figés — et c'est
 * exactement pour cela que la porte de `enveloppe-de-cle.mjs` exige un jeton. Une liste épuisée est
 * une ERREUR, jamais un retour au tirage réel : un vecteur qui reprendrait silencieusement de
 * l'aléa cesserait d'être un vecteur.
 */
export function aleasScriptes({ identifiants = [], nonces = [], jeton }) {
  const idsRestants = [...identifiants];
  const noncesRestants = [...nonces];
  return {
    jeton,
    tirerIdentifiant: () => {
      if (idsRestants.length === 0) throw new Error("Aléas scriptés épuisés : identifiants.");
      return idsRestants.shift();
    },
    tirerNonce: () => {
      if (noncesRestants.length === 0) throw new Error("Aléas scriptés épuisés : nonces.");
      return noncesRestants.shift();
    },
    /** Ce qui n'a pas été consommé : un vecteur qui laisse des aléas n'a pas fait ce qu'il annonce. */
    reste: () => ({ identifiants: idsRestants.length, nonces: noncesRestants.length }),
  };
}

/** Suite d'octets déterministe des vecteurs : `octet i = base + i`. */
export function suiteDOctets(base, longueur) {
  return Uint8Array.from({ length: longueur }, (_, index) => (base + index) % 256);
}

/** Relit une chaîne hexadécimale minuscule. Aucune tolérance de forme. */
export function hex(chaine) {
  const octets = new Uint8Array(chaine.length / 2);
  for (let index = 0; index < octets.length; index += 1) {
    octets[index] = Number.parseInt(chaine.slice(index * 2, index * 2 + 2), 16);
  }
  return octets;
}
