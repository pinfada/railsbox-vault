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
import {
  STORAGE_ERROR_CODES,
  StorageError,
  generationRootCorrupt,
  volumeSansRacine,
} from "./storage-errors.mjs";
import { FRAICHEUR_ETATS } from "./generation-fraicheur.mjs";
import { identifiantVolumeEnOctets } from "./volume-chiffre-format.mjs";

/** États dans lesquels une ouverture peut trouver le journal. */
export const GENERATION_ETATS = Object.freeze({
  /** Aucune génération en attente : le volume EST la dernière génération validée. */
  aucune: "aucune",
  /** Une génération déposée sans validation a été écartée. Le volume n'a pas bougé. */
  ecartee: "ecartee",
  /** Une génération validée manquait au volume : elle a été rejouée. */
  rejouee: "rejouee",
  /**
   * Aucune racine ne faisait autorité, et une autorisation — création, migration, ou engagement
   * d'archive vérifié — a fait écrire la RACINE INITIALE (#181).
   *
   * Il est distinct de `aucune`, qui décrit une ouverture où rien n'a été écrit : ici l'ouverture
   * ÉCRIT, et un geste nouveau sur ce chemin se publie plutôt que de se faire en silence.
   */
  initialisee: "initialisee",
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
 * SÉQUENCE présentée au modèle AVANT la toute première racine d'un volume.
 *
 * Une séquence doit croître STRICTEMENT à chaque écriture de racine (ADR 0015), et la racine
 * initiale porte la séquence ZÉRO : il faut donc lui présenter quelque chose de plus petit. Ce
 * n'est pas une séquence qui a existé — aucune racine ne l'a jamais portée —, c'est la borne au
 * départ de laquelle zéro est un successeur.
 */
export const SEQUENCE_AVANT_LA_PREMIERE_RACINE = -1;

/**
 * L'AUTORISATION d'écrire la racine initiale, exigée à la construction, `null` compris (#181).
 *
 * Le magasin ne connaît ni la création, ni l'archive : il reçoit un collaborateur qui SAIT juger, ou
 * `null` pour DÉCLARER que rien n'autorise une ouverture sans racine. La règle est celle que
 * `construireGarde` applique déjà à la fraîcheur, et pour le même motif : jusqu'à #19, une
 * dépendance oubliée valait « aucun contrôle », c'est-à-dire une défaillance ouverte et silencieuse.
 * Ici, un défaut valant « autorisé » rouvrirait le défaut CRITICAL de #181.
 *
 * Le collaborateur expose `autoriser()`, qui rend `{ consommer }` — appelé UNE FOIS la racine
 * initiale durable — ou `null` s'il ne peut pas autoriser. Il peut aussi LEVER un refus typé plus
 * précis, et c'est ce que fait l'engagement d'archive quand il est présent mais n'ouvre pas.
 */
export function construireAutorisation(options) {
  if (options.sansRacine === undefined) {
    throw new TypeError(
      "GenerationStore : « sansRacine » est obligatoire, « null » compris. Il DÉCLARE ce qui autorise une ouverture sans racine — une création, ou l'engagement d'une archive restaurée. Un oubli valant « autorisé » rouvrirait le défaut de #181.",
    );
  }
  if (options.sansRacine === null) return null;
  if (typeof options.sansRacine.autoriser !== "function") {
    throw new TypeError("GenerationStore : « sansRacine » expose « autoriser() », ou vaut null.");
  }
  return options.sansRacine;
}

/**
 * L'AUTORISATION d'un geste du PRODUIT qui vient d'écrire le fichier de volume lui-même : une
 * CRÉATION, ou une MIGRATION (#181).
 *
 * Elle n'a rien à vérifier, et il faut dire pourquoi ce n'est pas une facilité : celui qui vient
 * d'écrire le fichier entier SAIT que ces octets sont les siens. La preuve n'est nécessaire que pour
 * un fichier venu d'ailleurs, et c'est ce que l'engagement d'archive apporte.
 *
 * @param {"creation" | "migration"} motif ce que le rapport d'ouverture publiera
 */
export function autorisationDeCreation(motif = "creation") {
  return { autoriser: async () => ({ motif, consommer: async () => {} }) };
}

/**
 * AUCUNE racine n'est LISIBLE : le refus tombe avant toute autorisation.
 *
 * Il est séparé de `remedeSansRacine` parce qu'il ne dépend de RIEN d'autre que du constat, et
 * parce qu'il doit tomber AVANT qu'une autorisation ne soit demandée : vérifier un engagement coûte
 * l'empreinte de tout le fichier, et un journal dont on ne sait plus ce qu'il a validé est refusé
 * de toute façon.
 *
 * On ne sait pas ce qui a été validé. Écarter serait peut-être juste — et peut-être une perte
 * d'écriture acquittée. Le refus est le seul état qui ne ment pas. C'est la même règle que pour une
 * charge scellée devenue incohérente : pas de réparation par devinette.
 */
export function exigerRacineLisible({ volume, abimees, chargePresente }) {
  if (abimees > 0) throw generationRootCorrupt(volume, { abimees, octets: chargePresente });
}

/**
 * AUCUNE racine ne fait autorité. Le remède dépend de ce qui l'AUTORISE, et non plus de ce qui
 * traîne dans le journal (#181).
 *
 * ## Ce qui a changé, et pourquoi le remède « aucune » a quitté le produit
 *
 * Cette fonction rendait « aucune » sur un journal vierge et vide : l'ouverture continuait, et le
 * volume était accepté tel quel. C'était l'état légitime d'une création — le § 7.1 finissait par
 * `VLTSEAL1`, pas par une racine — et c'était aussi, exactement, l'état qu'une restauration
 * laissait derrière elle. La revue externe du 10 septembre 2026 s'en est servie : un mélange de
 * secteurs authentiques venus de deux états du même volume passait pour un volume neuf.
 *
 * Depuis #181, **aucun volume légitime n'est sans racine**. La création en écrit une avant
 * `VLTSEAL1`, la migration v2 → v3 aussi, et un volume restauré en reçoit une à sa première
 * ouverture — sur présentation de l'engagement que l'archive portait. Un volume sans racine que
 * rien n'autorise est donc REFUSÉ.
 *
 * ## L'objection que cette règle lève, nommée pour ne pas être redécouverte
 *
 * La rédaction précédente justifiait « aucune » ainsi : « une ouverture qui écrirait ici ferait
 * échouer un export sur un support saturé — c'est-à-dire le geste même par lequel l'utilisateur
 * libère de la place ». Elle ne vaut plus. Une ouverture n'écrit une racine que si une autorisation
 * l'y invite, donc uniquement après une RESTAURATION — un geste qui vient précisément d'écrire un
 * fichier de volume entier, et qui a donc déjà échoué si le support était saturé. Une création,
 * elle, écrit sa racine pendant qu'elle alloue le fichier.
 *
 * @param {{ volume: string, abimees: number, chargePresente: number, autorisee: boolean }} constat
 *   `autorisee` dit qu'une CRÉATION ou un ENGAGEMENT vérifié autorise l'écriture de la racine
 *   initiale. Il est OBLIGATOIRE : un défaut valant « autorisé » rouvrirait le défaut de #181.
 * @returns {"racine-initiale" | "ecarter-puis-racine-initiale"} le geste que l'état trouvé autorise
 */
export function remedeSansRacine({ volume, abimees, chargePresente, autorisee }) {
  // La branche du refus survit telle quelle, et elle passe EN PREMIER : une racine abîmée est
  // refusée quelle que soit l'autorisation présentée.
  exigerRacineLisible({ volume, abimees, chargePresente });
  if (typeof autorisee !== "boolean") {
    throw new TypeError(
      `Ouverture du volume « ${volume} » : « autorisee » est obligatoire, et c'est un booléen. Un défaut valant « autorisé » rendrait de nouveau ouvrable un volume sans racine (#181).`,
    );
  }
  if (!autorisee) throw volumeSansRacine(volume, { chargePresente });
  // Racines vierges au-dessus d'octets : rien n'a jamais été validé dans ce journal, et ce qui
  // traîne est le reliquat d'une génération déposée puis interrompue. Il est ÉCARTÉ — le volume,
  // lui, est intact — puis la racine initiale est écrite par-dessus.
  return chargePresente === 0 ? "racine-initiale" : "ecarter-puis-racine-initiale";
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
 * toujours des octets écartés. **Et cela est désormais EXIGÉ plutôt que supposé** : depuis que le
 * code suit un champ que l'APPELANT fournit, l'invariant « ecartee ⇒ DISCARDED » ne tenait plus que
 * par la discipline de deux appelants, et un oubli aurait rendu un rapport `ecartee` muet — sans
 * qu'aucune épreuve le voie, `octetsEcartes` valant zéro par défaut. Un rapport est justement ce qui
 * empêche un contrôle d'être supposé actif : il refuse l'incohérence au lieu de la publier. Relevé
 * en revue.
 *
 * @param {{ volume: string, etat: string, generation: number, sequence: number,
 *           surmemoireMax: number, details: object }} etatFinal
 */
export function rapportDuMagasin(etatPublie, etat, details) {
  const { volume, generation, sequence, surmemoireMax } = etatPublie;
  return poserRapport({
    volume,
    etat,
    generation,
    sequence,
    surmemoireMax,
    details: {
      // Publiés pour la même raison que la surmémoire : un contrôle qu'on ne publie pas finit par
      // être supposé actif. `non-fournie` dit qu'aucune fraîcheur n'est prétendue ; `migree` dit
      // qu'une racine d'avant #19 a été trouvée et que la suivante portera l'empreinte.
      fraicheurRegion: etatPublie.fraicheurRegion ?? FRAICHEUR_ETATS.nonFournie,
      // Format que la racine trouvée DÉCLARE, et le nom le dit : le champ n'est pas authentifié
      // (§ 6.7), un adversaire le choisit, et il ne vaut comme état de migration que sur un journal
      // que rien n'a touché. C'est une DÉCLARATION, pas un constat (#143).
      journalFormatAnnonce: etatPublie.journalFormatAnnonce,
      temoinSequence: etatPublie.temoinSequence,
      voisinIgnore: etatPublie.voisinIgnore ?? false,
      ...details,
    },
  });
}

export function poserRapport({ volume, etat, generation, sequence, surmemoireMax, details }) {
  const octetsEcartes = details.octetsEcartes ?? 0;
  if (etat === GENERATION_ETATS.ecartee && octetsEcartes <= 0) {
    throw new TypeError(
      `Rapport d'ouverture du volume « ${volume} » : l'état « ecartee » déclare une mise au rebut et ne porte aucun octet écarté. Publier ce rapport rendrait « code: null » sur une génération écartée, ce que le § 10.2 interdit — le code est publié, jamais tu.`,
    );
  }
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
    // La RACINE INITIALE (#181) : vrai quand cette ouverture en a écrit une, et le MOTIF qui l'y a
    // autorisée — « creation », « migration » ou « engagement ». Déclarés ici comme les autres
    // champs du rapport, et publiés pour la raison que la DoR de #181 impose : une ouverture qui
    // ÉCRIT est un geste nouveau sur ce chemin, et il ne se fait jamais en silence.
    racineInitiale: false,
    motifDeLaRacine: null,
    // Un VOISIN D'ENGAGEMENT trouvé alors qu'une racine faisait déjà autorité, et VIDÉ à cette
    // occasion (#181, revue de sécurité de la PR #184, constat 9). Il n'est jamais consulté sur ce
    // chemin — la décision 5 de l'ADR 0034 le dit —, mais un voisin qu'on ignore sans le dire finit
    // par être cru actif, et un reliquat qu'on laisse finit par être cru voulu. Ici, il est écarté,
    // et l'ouverture le publie.
    voisinIgnore: false,
    // SURMÉMOIRE DE POINTE de la récupération, en octets : la plus grande allocation qu'elle a
    // faite pour elle-même. Publiée pour la même raison que l'export et la restauration publient
    // la leur (`docs/quality-attributes.md`) — un budget qu'on ne mesure pas n'est pas tenu, il
    // est supposé. Elle ne suit PAS la taille de la charge : le tampon de relecture est constant.
    surmemoireMaxOctets: surmemoireMax,
    ...details,
  });
}
