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
import { STORAGE_ERROR_CODES, StorageError, generationRootCorrupt } from "./storage-errors.mjs";
import { identifiantVolumeEnOctets } from "./volume-chiffre-format.mjs";

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
 * Refuse une racine qui DÉCLARE un autre volume, avant même de vérifier son étiquette.
 *
 * L'identifiant lu ici n'est pas encore authentifié — il ne le sera que par `ouvrirRacine` — et le
 * refus qui suivrait serait de toute façon un `SCEAU_REFUSE`, puisque les données associées
 * porteraient un autre identifiant. Le contrôle sert donc au DIAGNOSTIC, pas à la sécurité : il
 * distingue « ce journal appartient à un autre volume » de « ce journal est abîmé », deux états dont
 * les remèdes n'ont rien de commun.
 *
 * Il vit ici, avec le CONSTAT, plutôt que dans le magasin : c'est un jugement porté sur ce que
 * l'ouverture a trouvé, et il ne touche à aucun état. Une racine ABSENTE ne déclare rien, et le dire
 * ici plutôt qu'à l'appel évite qu'un appelant l'oublie.
 *
 * @param {string} volume nom du volume, tel que l'exploitant le lit
 * @param {string} identifiantAttendu les trente-deux hexadécimaux que le manifeste déclare
 * @param {object | null} racine la racine qui fait autorité, ou `null` s'il n'y en a aucune
 */
export function exigerIdentiteDeVolume(volume, identifiantAttendu, racine) {
  if (racine === null) return;
  const attendu = identifiantVolumeEnOctets(identifiantAttendu);
  if (racine.identifiantVolume.every((octet, index) => octet === attendu[index])) return;
  throw new StorageError(
    STORAGE_ERROR_CODES.identiteVolume,
    `Journal de génération du volume « ${volume} » refusé : sa racine DÉCLARE un autre identifiant de volume que celui du manifeste. La valeur n'est pas authentifiée à ce point — elle est seulement déclarée —, mais l'écart suffit à savoir que ce journal n'est pas celui de ce volume.`,
    { volume, attendu: identifiantAttendu },
  );
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
 * **Le code suit les OCTETS ÉCARTÉS, plus l'état (#144).** Il suivait l'état `ecartee`, et le § 10.2
 * promettait pourtant `VAULT_STORAGE_GENERATION_DISCARDED` « publié, jamais tu » pour toute mise au
 * rebut. Or l'état `rejouee` en écarte aussi : la racine qui fait autorité authentifie une longueur
 * de charge, et ce qui la dépasse dans le fichier n'a été validé par personne. C'est justement le
 * chemin qu'une racine `s` abîmée produit — le témoin étant resté à `s − 1`, l'ouverture est
 * légitime, mais les octets de la génération `s` disparaissaient alors SANS un mot. Il n'y a qu'une
 * règle, et elle se lit d'un trait : des octets écartés portent leur code, quel que soit l'état.
 *
 * L'état `ecartee` n'en perd rien : il n'existe que lorsque `chargePresente > 0`, donc il porte
 * toujours des octets écartés.
 *
 * @param {{ volume: string, etat: string, generation: number, sequence: number,
 *           surmemoireMax: number, details: object }} etatFinal
 */
export function poserRapport({ volume, etat, generation, sequence, surmemoireMax, details }) {
  const octetsEcartes = details.octetsEcartes ?? 0;
  return Object.freeze({
    volume,
    etat,
    code: octetsEcartes > 0 ? STORAGE_ERROR_CODES.generationDiscarded : null,
    generation,
    sequence,
    racineOffset: offsetDeRacine(racineDeSequence(sequence)),
    prochaineRacineOffset: offsetDeRacine(racineDeSequence(sequence + 1)),
    octetsEcartes: 0,
    enregistrementsRejoues: 0,
    octetsRejoues: 0,
    // FORMAT du journal trouvé à l'ouverture (#143). `null` tant qu'aucune racine ne fait autorité.
    // Il est déclaré ici comme les autres champs du rapport : un champ que seul l'appelant fournit
    // finit par manquer un jour, et personne ne le voit — le rapport est justement ce qui empêche un
    // contrôle d'être supposé actif.
    journalFormatAnnonce: null,
    // SURMÉMOIRE DE POINTE de la récupération, en octets : la plus grande allocation qu'elle a
    // faite pour elle-même. Publiée pour la même raison que l'export et la restauration publient
    // la leur (`docs/quality-attributes.md`) — un budget qu'on ne mesure pas n'est pas tenu, il
    // est supposé. Elle ne suit PAS la taille de la charge : le tampon de relecture est constant.
    surmemoireMaxOctets: surmemoireMax,
    ...details,
  });
}
