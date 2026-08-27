// PARCOURS EN FLUX de la charge d'une génération (#16, ADR 0014, #91).
//
// Une charge est la suite des enregistrements qu'une racine scelle. La relire est le geste le plus
// coûteux de l'ouverture d'un volume, et le seul dont `docs/quality-attributes.md` borne à la fois
// le temps — la dernière génération valide retrouvée en ≤ 60 s — et la surmémoire. Ce module porte
// les deux contraintes : une fenêtre glissante d'un seul tampon, et un refus ferme dès qu'une charge
// scellée ne concorde plus.
//
// Il ne connaît ni le magasin, ni le volume : il reçoit un journal, une racine, et rend ce qu'il a
// compté. C'est ce qui rend la mesure de `tests/vm/recuperation-generation.spec.mjs` reproductible
// sans navigateur.

import {
  ENTETE_OCTETS,
  ZONE_ENREGISTREMENTS,
  crc32,
  decoderEnteteEnregistrement,
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
     * `requis` est le minimum INDIVISIBLE : un en-tête d'enregistrement ne se lit pas en deux fois,
     * là où les octets d'un enregistrement s'accommodent d'une tranche partielle. Une tranche plus
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
    `la charge annonce ${racine.longueurCharge} octet(s), le journal n'en rend que ${disponible}.`,
  );
}

/** Vérifie ce que la racine SCELLE : le compte des enregistrements, puis la somme de contrôle. */
function verifierSceau(volume, racine, enregistrements, somme) {
  if (enregistrements !== racine.enregistrements) {
    throw chargeIncoherente(
      volume,
      racine,
      `la racine annonce ${racine.enregistrements} enregistrement(s), la charge en porte ${enregistrements}.`,
    );
  }
  if (somme !== racine.sommeCharge) {
    throw chargeIncoherente(
      volume,
      racine,
      "la somme de contrôle de la charge ne concorde pas avec celle que la racine scelle.",
    );
  }
}

/** Un tampon plus grand que la charge ne servirait à rien ; plus petit qu'un en-tête, à rien non plus. */
function tailleTampon(racine) {
  return Math.max(ENTETE_OCTETS, Math.min(racine.longueurCharge, TAMPON_RELECTURE_OCTETS));
}

/**
 * Parcourt la charge d'une racine, ENREGISTREMENT PAR ENREGISTREMENT, et la refuse si elle ne
 * tient pas.
 *
 * Le parcours ne tient jamais plus qu'un tampon de `TAMPON_RELECTURE_OCTETS` : la somme de
 * contrôle est déjà incrémentale, et un enregistrement plus grand que le tampon est lu par
 * tranches. C'est le même régime que l'export et la restauration (`docs/quality-attributes.md` :
 * surmémoire de streaming ≤ 64 Mio), que la récupération ne tenait pas — elle lisait la charge
 * d'un seul tenant, soit ~128 Mio au plafond avec les tranches rejouées (#91).
 *
 * Le refus reste ferme : une génération VALIDÉE dont les octets manquent ou ne concordent plus
 * n'est pas réparable par déduction. La rejouer à moitié écrirait dans le volume des octets dont
 * personne ne sait s'ils forment un état cohérent ; l'ignorer perdrait une écriture acquittée.
 * Reste à le dire, avec un code que l'exploitant peut chercher.
 *
 * @param {{ journal: import("./generation-journal.mjs").JournalDeGeneration, volume: string,
 *           tailleVolume: number, racine: object,
 *           emettre?: ((offset: number, octets: Uint8Array) => unknown) | null }} options
 *   `emettre` est appelé pour chaque tranche, avec l'offset du VOLUME où elle va. Le tampon lui est
 *   PRÊTÉ : il est réécrit dès la tranche suivante, et le retenir serait une faute.
 * @returns {number} le nombre d'enregistrements parcourus
 */
export function parcourirCharge({ journal, volume, tailleVolume, racine, emettre = null }) {
  const fenetre = fenetreDeCharge({
    tampon: journal.allouer(tailleTampon(racine)),
    longueurCharge: racine.longueurCharge,
    lire: (cible, position) => journal.lireDans(cible, ZONE_ENREGISTREMENTS + position),
  });
  let position = 0;
  let enregistrements = 0;
  let somme = 0;

  while (position < racine.longueurCharge) {
    const entete = fenetre.tranche(position, ENTETE_OCTETS, ENTETE_OCTETS);
    if (entete.byteLength < ENTETE_OCTETS) throw chargeTronquee(volume, racine, fenetre.fin());
    const decode = decoderEnteteEnregistrement(entete, { tailleVolume });
    if (decode === null || position + ENTETE_OCTETS + decode.longueur > racine.longueurCharge) {
      throw chargeIncoherente(
        volume,
        racine,
        `enregistrement illisible à l'octet ${position} d'une charge pourtant scellée.`,
      );
    }
    // L'en-tête entre dans la somme AVANT qu'un rechargement ne déplace la fenêtre.
    somme = crc32(entete, somme);
    position += ENTETE_OCTETS;
    for (let porte = 0; porte < decode.longueur;) {
      const tranche = fenetre.tranche(position + porte, decode.longueur - porte);
      if (tranche.byteLength === 0) throw chargeTronquee(volume, racine, fenetre.fin());
      somme = crc32(tranche, somme);
      if (emettre !== null) emettre(decode.offset + porte, tranche);
      porte += tranche.byteLength;
    }
    position += decode.longueur;
    enregistrements += 1;
  }

  verifierSceau(volume, racine, enregistrements, somme);
  return enregistrements;
}
