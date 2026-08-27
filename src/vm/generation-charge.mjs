// PARCOURS EN FLUX de la charge d'une génération (#16, ADR 0014, #91 ; #18, ADR 0016).
//
// Une charge est la suite des enregistrements qu'une racine scelle. La relire est le geste le plus
// coûteux de l'ouverture d'un volume, et le seul dont `docs/quality-attributes.md` borne à la fois
// le temps — la dernière génération valide retrouvée en ≤ 60 s — et la surmémoire. Ce module porte
// les deux contraintes : une fenêtre glissante d'un seul tampon, et un refus ferme dès qu'une charge
// scellée ne concorde plus.
//
// Il ne connaît ni le magasin, ni le volume : il reçoit un journal, une racine, un scellement, et
// rend ce qu'il a compté. C'est ce qui rend la mesure de `tests/vm/recuperation-generation.spec.mjs`
// reproductible sans navigateur.
//
// **Depuis #18, le CRC-32 a disparu.** Ce que la charge doit prouver n'est plus une somme mais trois
// choses, dans cet ordre : chaque enregistrement s'ouvre sous son identité logique (donc il est
// intact, à sa place, dans ce volume, sous sa génération), la racine authentifie le NOMBRE et la
// LONGUEUR des entrées trouvées, et l'empreinte de leur suite ordonnée concorde avec celle que la
// racine scelle. Les deux derniers verdicts sont posés APRÈS que l'étiquette de la racine a vérifié
// — c'est l'ordre de l'ADR 0015, et il est ce qui rend « troncature » et « mélange » établis plutôt
// que devinés.

import { decoderSceau } from "./volume-chiffre-format.mjs";
import {
  ENTETE_OCTETS,
  SCEAU_ENREGISTREMENT_OCTETS,
  SURCOUT_ENREGISTREMENT,
  ZONE_ENREGISTREMENTS,
  decoderEnteteEnregistrement,
  longueurPhysiqueDeCharge,
} from "./generation-format.mjs";
import { TAMPON_RELECTURE_OCTETS } from "./generation-plafonds.mjs";
import { generationCorrupt } from "./storage-errors.mjs";

/**
 * FENÊTRE GLISSANTE sur la charge d'un journal. Un seul tampon, rechargé quand il est épuisé.
 *
 * Elle existe pour une raison MESURÉE, pas par élégance. Un parcours qui lirait l'en-tête puis les
 * octets de chaque enregistrement demanderait quatre appels au support par enregistrement sur les
 * deux passes ; sur OPFS réel un appel synchrone coûte ~290 µs, et une charge de 64 Mio découpée en
 * enregistrements de 512 octets réclamait 201,4 s — 3,4 fois le budget de récupération de 60 s de
 * `docs/quality-attributes.md` (relevé dans `reports/vm/recuperation-generation.json`). La fenêtre
 * ramène les lectures à deux passes séquentielles sur la charge, quelle que soit sa granularité, et
 * la même charge entre 39,4 et 71,1 s selon l'état de la machine.
 *
 * Le tampon est PRÊTÉ : chaque tranche rendue vit jusqu'au prochain rechargement, et la retenir
 * serait une faute. C'est le prix d'une surmémoire qui ne suit pas la taille de la charge.
 *
 * @param {{ tampon: Uint8Array, longueurCharge: number,
 *           lire: (cible: Uint8Array, position: number) => number }} options
 */
export function fenetreDeCharge({ tampon, longueurCharge, lire }) {
  let base = 0;
  let remplie = 0;

  const disponible = (position) =>
    position >= base && position < base + remplie ? base + remplie - position : 0;

  return {
    /** Fin de ce que le journal a réellement rendu. Sert à NOMMER une charge tronquée. */
    fin: () => base + remplie,
    /**
     * Rend jusqu'à `maximum` octets à `position`, en rechargeant la fenêtre s'il en manque.
     *
     * `requis` est le minimum INDIVISIBLE : le préfixe d'un enregistrement — en-tête et sceau — ne se
     * lit pas en deux fois, là où le chiffré s'accommode d'une tranche partielle. Une tranche plus
     * courte que `requis` signifie que le journal ne porte plus ce qu'une racine déclare — c'est à
     * l'appelant de le refuser.
     */
    tranche(position, maximum, requis = 1) {
      if (disponible(position) < Math.min(requis, longueurCharge - position)) {
        base = position;
        remplie = lire(
          tampon.subarray(0, Math.min(tampon.byteLength, longueurCharge - base)),
          base,
        );
      }
      const debut = position - base;
      return tampon.subarray(debut, debut + Math.min(maximum, Math.max(0, remplie - debut)));
    },
  };
}

/** Refus TYPÉ d'une charge scellée devenue incohérente. Un doute est un refus, jamais un remède. */
export function chargeIncoherente(volume, racine, reason) {
  return generationCorrupt(volume, { generation: racine.generation, reason });
}

/** Refus TYPÉ d'une charge que le journal ne porte plus entièrement. */
function chargeTronquee(volume, racine, disponible) {
  return chargeIncoherente(
    volume,
    racine,
    `la charge annonce ${longueurPhysiqueDeCharge(racine)} octet(s) sur le support, le journal n'en rend que ${disponible}.`,
  );
}

/** Un tampon plus grand que la charge ne servirait à rien ; plus petit qu'un préfixe, à rien non plus. */
function tailleTampon(longueurPhysique) {
  return Math.max(SURCOUT_ENREGISTREMENT, Math.min(longueurPhysique, TAMPON_RELECTURE_OCTETS));
}

/**
 * Lit le CHIFFRÉ d'un enregistrement, d'un seul tenant.
 *
 * La fenêtre PRÊTE ses tranches : elles ne survivent pas au rechargement suivant. Un déchiffrement,
 * lui, exige des octets contigus. Le chiffré est donc RECOPIÉ dans un tampon à la taille de
 * l'enregistrement — c'est la seule allocation du parcours qui ne soit pas bornée par
 * `TAMPON_RELECTURE_OCTETS`, et l'ADR 0016 l'inscrit dans ses limites plutôt que de la taire.
 */
function lireChiffre(fenetre, position, longueur, volume, racine) {
  const chiffre = new Uint8Array(longueur);
  for (let porte = 0; porte < longueur;) {
    const tranche = fenetre.tranche(position + porte, longueur - porte);
    if (tranche.byteLength === 0) throw chargeTronquee(volume, racine, fenetre.fin());
    chiffre.set(tranche, porte);
    porte += tranche.byteLength;
  }
  return chiffre;
}

/** Lit le préfixe d'un enregistrement — en-tête et sceau —, ou refuse la charge. */
function lirePrefixe(fenetre, position, { volume, racine, tailleVolume, longueurPhysique }) {
  const prefixe = fenetre.tranche(position, SURCOUT_ENREGISTREMENT, SURCOUT_ENREGISTREMENT);
  if (prefixe.byteLength < SURCOUT_ENREGISTREMENT) {
    throw chargeTronquee(volume, racine, fenetre.fin());
  }
  const entete = decoderEnteteEnregistrement(prefixe.subarray(0, ENTETE_OCTETS), { tailleVolume });
  if (entete === null || position + SURCOUT_ENREGISTREMENT + entete.longueur > longueurPhysique) {
    throw chargeIncoherente(
      volume,
      racine,
      `enregistrement illisible à l'octet ${position} d'une charge pourtant scellée.`,
    );
  }
  return {
    entete,
    sceau: decoderSceau(
      prefixe.subarray(ENTETE_OCTETS, ENTETE_OCTETS + SCEAU_ENREGISTREMENT_OCTETS),
    ),
  };
}

/** Confronte la suite d'entrées TROUVÉE à ce que la racine authentifie. Le dernier geste, jamais le premier. */
function ouvrirLaRacine(scellement, racine, entrees, tailleVolume) {
  return scellement.ouvrirRacine(
    {
      sequence: racine.sequence,
      generation: racine.generation,
      tailleVolume: racine.tailleVolume,
      nombreEntrees: racine.nombreEntrees,
      longueurCharge: racine.longueurCharge,
      scellementsCumules: racine.scellementsCumules,
    },
    racine.scelle,
    entrees,
    { tailleVolume, sequenceMinimale: null },
  );
}

/**
 * Parcourt la charge d'une racine, ENREGISTREMENT PAR ENREGISTREMENT, et la refuse si elle ne tient
 * pas.
 *
 * ## L'ordre des gestes, et pourquoi il est ce qu'il est (ADR 0016)
 *
 *  1. lire chaque enregistrement — en-tête, sceau, chiffré — et COLLECTER l'entrée que la racine
 *     authentifie : adresse, longueur, rang (sa position dans la charge), étiquette ;
 *  2. l'OUVRIR sous l'identité reconstruite, si l'appelant veut le clair. La génération vient du
 *     SCEAU, jamais de la racine : une charge cumule plusieurs générations tant qu'aucun point de
 *     contrôle ne l'a vidée, et l'ADR 0016 corrige l'ADR 0015 sur ce point précis ;
 *  3. OUVRIR la racine avec la suite trouvée. C'est là, et seulement là, que troncature et mélange
 *     sont ÉTABLIS — sur un en-tête que l'étiquette a authentifié.
 *
 * Le refus reste ferme : une génération VALIDÉE dont les octets manquent ou ne concordent plus n'est
 * pas réparable par déduction. La rejouer à moitié écrirait dans le volume des octets dont personne
 * ne sait s'ils forment un état cohérent ; l'ignorer perdrait une écriture acquittée.
 *
 * @param {{ journal: import("./generation-journal.mjs").JournalDeGeneration, volume: string,
 *           tailleVolume: number, racine: object,
 *           scellement: import("./scellement.mjs").Scellement,
 *           emettre?: ((offset: number, octets: Uint8Array, generation: number) => unknown)|null }} options
 *   `emettre` reçoit le CLAIR de chaque enregistrement, avec l'offset du VOLUME où il va.
 * @returns {Promise<number>} le nombre d'enregistrements parcourus
 */
export async function parcourirCharge({
  journal,
  volume,
  tailleVolume,
  racine,
  scellement,
  emettre = null,
}) {
  const longueurPhysique = longueurPhysiqueDeCharge(racine);
  const fenetre = fenetreDeCharge({
    tampon: journal.allouer(tailleTampon(longueurPhysique)),
    longueurCharge: longueurPhysique,
    lire: (cible, position) => journal.lireDans(cible, ZONE_ENREGISTREMENTS + position),
  });
  const cadre = { volume, racine, tailleVolume, longueurPhysique };
  const entrees = [];
  let position = 0;

  while (position < longueurPhysique) {
    const { entete, sceau } = lirePrefixe(fenetre, position, cadre);
    const rang = entrees.length;
    entrees.push({
      adresse: entete.offset,
      longueur: entete.longueur,
      rang,
      etiquette: sceau.etiquette,
    });
    position += SURCOUT_ENREGISTREMENT;

    const chiffre = lireChiffre(fenetre, position, entete.longueur, volume, racine);
    // L'enregistrement est OUVERT à chaque passe, y compris celle qui n'émet rien. C'est ce qui
    // garde la promesse de l'ADR 0014 : la première passe vérifie la charge ENTIÈRE sans écrire une
    // ligne dans le volume. Ne l'ouvrir qu'à l'émission laisserait les premiers enregistrements dans
    // le volume quand le dernier serait refusé — exactement le rejeu à moitié que ce magasin
    // interdit. Le prix est un déchiffrement de plus par enregistrement, sur le geste amorti.
    const clair = await scellement.ouvrirBloc(
      { generation: sceau.generation, rang, adresse: entete.offset, longueur: entete.longueur },
      { nonce: sceau.nonce, etiquette: sceau.etiquette, chiffre },
      { generationMinimale: null },
    );
    if (emettre !== null) await emettre(entete.offset, clair, sceau.generation);
    position += entete.longueur;
  }

  await ouvrirLaRacine(scellement, racine, entrees, tailleVolume);
  return entrees.length;
}
