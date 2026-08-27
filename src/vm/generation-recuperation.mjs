// CONSTAT d'ouverture d'un journal de génération, et compte rendu de ce qui en a été fait
// (#16, ADR 0014).
//
// Ce module ne touche à rien : il LIT les racines, dit ce que l'état trouvé permet, et met en forme
// le rapport que l'ouverture publie. Les gestes qui modifient le journal — écarter, rejouer, vider —
// restent dans `generation-store.mjs`, seul détenteur de l'état.
//
// La séparation a une raison de fond : une récupération se juge sur ce qu'elle CONSTATE avant
// d'agir. Tant que le constat et l'action vivaient dans la même suite d'instructions, rien
// n'empêchait un remède de s'appuyer sur un état déjà modifié par le remède précédent.

import {
  ZONE_ENREGISTREMENTS,
  decoderRacine,
  offsetDeRacine,
  RACINES,
  RACINE_OCTETS,
  racineDeSequence,
} from "./generation-format.mjs";
import { STORAGE_ERROR_CODES, generationRootCorrupt } from "./storage-errors.mjs";

/** États dans lesquels une ouverture peut trouver le journal. */
export const GENERATION_ETATS = Object.freeze({
  /** Aucune génération en attente : le volume EST la dernière génération validée. */
  aucune: "aucune",
  /** Une génération déposée sans validation a été écartée. Le volume n'a pas bougé. */
  ecartee: "ecartee",
  /** Une génération validée manquait au volume : elle a été rejouée. */
  rejouee: "rejouee",
});

/**
 * Relit les deux racines et rend celle qui fait autorité, en distinguant VIERGE et ABÎMÉE.
 *
 * La distinction décide du remède, et `decoderRacine` la fournit déjà : la jeter reviendrait à
 * traiter un secteur de racine illisible comme un secteur jamais écrit. Une racine abîmée peut
 * avoir scellé une génération acquittée ; l'écarter en silence, sous l'étiquette « issue normale
 * d'une coupure », effacerait une écriture durable sans le dire.
 *
 * @returns {{ racine: object | null, abimees: number }}
 */
function racineFaisantAutorite({ journal, tailleVolume }) {
  let retenue = null;
  let abimees = 0;
  for (let rang = 0; rang < RACINES; rang += 1) {
    const secteur = journal.lire(offsetDeRacine(rang), RACINE_OCTETS);
    if (secteur.byteLength < RACINE_OCTETS) continue;
    const lue = decoderRacine(secteur, { tailleVolume });
    if (!lue.valide) {
      // Un secteur VIERGE n'a jamais porté de racine : ce n'est pas une avarie, c'est une place
      // libre — l'état normal du second emplacement tant qu'aucune alternance n'a eu lieu.
      if (!lue.vierge) abimees += 1;
      continue;
    }
    if (retenue === null || lue.racine.sequence > retenue.sequence) retenue = lue.racine;
  }
  return { racine: retenue, abimees };
}

/**
 * CONSTATE ce que l'ouverture trouve : la racine qui fait autorité, le nombre de racines abîmées, et
 * les octets présents au-delà de la zone des racines. Un fichier plus court que cette zone n'a
 * jamais porté de racine : le relire secteur par secteur ne rendrait que des lectures courtes.
 *
 * @returns {{ racine: object | null, abimees: number, chargePresente: number }}
 */
export function constaterOuverture({ journal, tailleVolume }) {
  const taille = journal.taille();
  const lecture =
    taille >= ZONE_ENREGISTREMENTS
      ? racineFaisantAutorite({ journal, tailleVolume })
      : { racine: null, abimees: 0 };
  return { ...lecture, chargePresente: Math.max(0, taille - ZONE_ENREGISTREMENTS) };
}

/**
 * AUCUNE racine ne fait autorité. Trois issues, et le remède dépend de ce qui manque.
 *
 * @param {{ volume: string, abimees: number, chargePresente: number }} constat
 * @returns {"aucune" | "ecarter"} le geste que l'état trouvé autorise
 */
export function remedeSansRacine({ volume, abimees, chargePresente }) {
  // Au moins une racine ABÎMÉE : on ne sait pas ce qui a été validé. Écarter serait peut-être
  // juste — et peut-être une perte d'écriture acquittée. Le refus est le seul état qui ne ment
  // pas. C'est la même règle que pour une charge scellée devenue incohérente : pas de réparation
  // par devinette.
  if (abimees > 0) throw generationRootCorrupt(volume, { abimees, octets: chargePresente });
  // Journal VIERGE et vide : il n'y a RIEN à faire, et surtout rien à écrire. Une ouverture qui
  // écrirait ici ferait échouer un export sur un support saturé — c'est-à-dire le geste même par
  // lequel l'utilisateur libère de la place. La racine initiale sera écrite au premier dépôt,
  // c'est-à-dire quand une écriture aura réellement lieu.
  if (chargePresente === 0) return "aucune";
  // Racines vierges au-dessus d'octets : rien n'a jamais été validé dans ce journal, et ce qui
  // traîne est le reliquat d'une génération déposée puis interrompue. Il est ÉCARTÉ — le volume,
  // lui, est intact.
  return "ecarter";
}

/**
 * Met en forme le rapport d'ouverture. Il est publié, jamais tu : une mise au rebut est une nouvelle.
 *
 * @param {{ volume: string, etat: string, generation: number, sequence: number,
 *           surmemoireMax: number, details: object }} etatFinal
 */
export function poserRapport({ volume, etat, generation, sequence, surmemoireMax, details }) {
  return Object.freeze({
    volume,
    etat,
    code: etat === GENERATION_ETATS.ecartee ? STORAGE_ERROR_CODES.generationDiscarded : null,
    generation,
    sequence,
    racineOffset: offsetDeRacine(racineDeSequence(sequence)),
    prochaineRacineOffset: offsetDeRacine(racineDeSequence(sequence + 1)),
    octetsEcartes: 0,
    enregistrementsRejoues: 0,
    octetsRejoues: 0,
    // SURMÉMOIRE DE POINTE de la récupération, en octets : la plus grande allocation qu'elle a
    // faite pour elle-même. Publiée pour la même raison que l'export et la restauration publient
    // la leur (`docs/quality-attributes.md`) — un budget qu'on ne mesure pas n'est pas tenu, il
    // est supposé. Elle ne suit PAS la taille de la charge : le tampon de relecture est constant.
    surmemoireMaxOctets: surmemoireMax,
    ...details,
  });
}
