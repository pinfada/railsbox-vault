// CONDUITE de l'instantané de reprise : capturer, relire, écarter (#65, ADR 0024).
//
// C'est le chemin de production. Il ne connaît ni OPFS, ni v86, ni le magasin de générations : il
// reçoit un SUPPORT — `etat`, `lire`, `allouer`, `ecrire`, `barriere`, `retirer` — et un SCELLEMENT,
// exactement comme `enveloppe-de-cle.mjs` reçoit le sien. C'est ce qui permet d'éprouver sous Node
// le code que le Worker exécute sur le vrai voisin `<volume>.instantane`.
//
// ## La phrase qui gouverne ce module
//
// **Le volume est la seule source de vérité.** Un instantané n'accélère que s'il décrit EXACTEMENT
// l'état présent ; sinon il est écarté, RETIRÉ du support, et le boot à froid s'exécute. Aucun
// chemin de ce fichier ne rend un état partiel, un état d'un autre volume, ou un état dont on ne
// sait pas s'il est complet. Aucune donnée n'est perdue par un refus : le pire coût est un boot.
//
// ## Pourquoi l'ouverture rend un RAPPORT et ne lève pas
//
// Tous les refus mènent au même geste — retirer, puis booter à froid — et l'appelant a besoin du
// MOTIF pour le publier, pas d'une exception à trier. Un contrôle qu'on ne publie pas finit par
// être supposé actif (ADR 0019) : le motif entre donc dans le compte rendu de boot, à côté de
// `usedSnapshot`.
//
// Le RETRAIT lui-même ne peut pas faire échouer une ouverture. Un support qui refuse de retirer un
// fichier périmé est une gêne — le fichier sera réécarté à la prochaine ouverture —, pas une raison
// de refuser un boot à froid qui, lui, ne dépend pas de ce fichier.
//
// ## L'ordre des contrôles, et pourquoi il est l'INVERSE de celui de l'ADR 0015
//
// L'ADR 0015 authentifie d'abord et classe ensuite, pour que chaque verdict soit ÉTABLI. Ici les
// cinq écarts de liaison sont constatés AVANT le sceau, sur un en-tête non authentifié — donc ce
// sont des diagnostics, et le code le dit : `ECART_SEQUENCE` veut dire « l'en-tête DÉCLARE une
// autre séquence », jamais « un adversaire a reculé le volume ». Comme tous les écarts mènent au
// même remède, la nuance ne coûte aucune sûreté, et elle épargne de déchiffrer 250 Mio pour
// apprendre ce que douze octets disaient déjà.

import { egalesEnTempsConstant, octetsEnHex } from "./format-chiffre/octets.mjs";
import {
  EN_TETE_OCTETS,
  MARQUEUR_COMPLET,
  MARQUE_OCTETS,
  decoderEnTete,
  encoderEnTete,
  marqueCompleteEcrite,
  offsetDeLaMarque,
  offsetDuCorps,
  tailleDeFichier,
} from "./instantane/fichier-instantane.mjs";
import { INSTANTANE_FORMAT, exigerLiaison } from "./instantane/identite-instantane.mjs";
import {
  ecartDeLiaison,
  incomplet,
  malforme,
  sceauRefuse,
} from "./instantane/instantane-errors.mjs";

/** Motif publié quand il n'y a simplement pas d'instantané. L'absence n'est pas un refus. */
export const MOTIF_ABSENT = "absent";

/** Construit la liaison à partir de l'état PRÉSENT du volume et de la longueur de l'état v86. */
function liaisonDe(scellement, etatPresent, longueurEtat) {
  return exigerLiaison({
    volume: scellement.volume,
    formatInstantane: INSTANTANE_FORMAT,
    formatVolume: etatPresent.formatVolume ?? scellement.formatVersion,
    sequence: etatPresent.sequence,
    generation: etatPresent.generation,
    empreinteRegion: etatPresent.empreinteRegion,
    empreinteImage: etatPresent.empreinteImage,
    longueurEtat,
  });
}

/**
 * CAPTURE un instantané, et l'ordre des gestes est le contrat.
 *
 * Allouer, écrire l'en-tête, écrire le corps, **barrière**, écrire la marque, **barrière**. La
 * marque vient après la première barrière parce qu'elle atteste que le corps est sur le support :
 * une marque posée avant attesterait d'un état qui n'est peut-être jamais arrivé jusqu'au disque.
 * Une coupure entre les deux laisse un fichier sans marque, donc INCOMPLET, donc écarté — un faux
 * refus sans perte, contre un faux succès qui coûterait un état mémoire incohérent.
 *
 * `allouer` remet le fichier à sa taille exacte AVANT tout : un instantané antérieur plus long
 * laisserait sa queue derrière celui-ci, et sa propre marque de complétude tomberait au-delà de la
 * nouvelle — un fichier qui se lirait comme complet alors qu'il est un mélange de deux captures.
 *
 * @param {{ scellement: import("./scellement.mjs").Scellement, volume: string,
 *           etatPresent: object, etat: Uint8Array, support: object }} appel
 * @returns {Promise<{ octets: number, liaison: object }>}
 */
export async function capturerInstantane({ scellement, volume, etatPresent, etat, support }) {
  if (!(etat instanceof Uint8Array)) {
    throw malforme("l'état v86 à capturer doit être une suite d'octets.", { volume });
  }
  const liaison = liaisonDe(scellement, etatPresent, etat.byteLength);
  // Le SCELLEMENT du volume porte la clé et le compteur : la capture passe par lui, jamais par une
  // clé recopiée. C'est ce qui garde le budget de clé en UN seul endroit (ADR 0016, décision 6).
  const scelle = await scellement.scellerInstantane(liaison, etat);

  const total = tailleDeFichier(etat.byteLength);
  await support.allouer(total);
  await support.ecrire(
    0,
    encoderEnTete({ liaison, nonce: scelle.nonce, etiquette: scelle.etiquette }),
  );
  await support.ecrire(offsetDuCorps(), scelle.chiffre);
  await support.barriere();
  await support.ecrire(offsetDeLaMarque(etat.byteLength), MARQUEUR_COMPLET);
  await support.barriere();

  return Object.freeze({ octets: total, liaison });
}

/** Lit exactement `longueur` octets, ou refuse. Une lecture courte n'est jamais complétée de zéros. */
async function lireExactement(support, offset, longueur, quoi) {
  const octets = await support.lire(offset, longueur);
  if (!(octets instanceof Uint8Array) || octets.byteLength !== longueur) {
    throw incomplet(
      `${quoi} : ${octets?.byteLength ?? 0} octet(s) rendus sur ${longueur} demandés à l'offset ${offset}.`,
      { offset, demande: longueur },
    );
  }
  return octets;
}

/**
 * Confronte la liaison DÉCLARÉE par l'en-tête à l'état présent, champ par champ.
 *
 * ## La SÉQUENCE se compare par un RECUL, pas par une égalité — et c'est une correction
 *
 * La première version de cette garde exigeait l'égalité stricte, et l'exécution l'a réfutée : la
 * SÉQUENCE compte les écritures de RACINE, **y compris la racine vide que toute récupération
 * écrit** (ADR 0014 — « le vidage qui clôt une récupération écrit une racine neuve »). Elle avance
 * donc d'un cran à CHAQUE OUVERTURE, avant même que le guest ait battu. Un instantané lié à
 * l'égalité de séquence était périmé à la première réouverture : il n'aurait jamais servi une seule
 * fois.
 *
 * Ce qu'un instantané doit détecter est une ÉCRITURE du volume, et deux champs la mesurent
 * exactement : la GÉNÉRATION VALIDÉE, qui n'avance qu'à une barrière acquittée du guest, et
 * l'EMPREINTE DE RÉGION, qui change dès qu'un secteur est rescellé. Ils restent comparés par
 * ÉGALITÉ.
 *
 * La séquence garde alors la propriété qu'elle est seule à porter : elle ne RECULE pas. Une
 * séquence présente inférieure à celle que l'instantané déclare décrit un journal ramené en arrière
 * — le cas que l'ADR 0019 nomme —, et l'instantané est écarté. C'est une garde de moins que
 * l'égalité, et une garde de plus que rien.
 *
 * L'ordre des champs est celui du coût croissant du remède, pas celui de la table du format.
 */
function confronterLiaison(declaree, presente, volume) {
  if (declaree.volume !== presente.volume) {
    throw ecartDeLiaison("volume", {
      declare: declaree.volume,
      present: presente.volume,
      volume,
    });
  }
  // La VERSION DE FORMAT DE VOLUME, confrontée par ÉGALITÉ. Elle entre dans les données associées,
  // donc le sceau la refuserait de toute façon — mais par un `SCEAU_REFUSE`, qui ne nomme pas la
  // cause et n'arrive qu'après avoir traversé le corps entier. Un instantané d'un volume migré
  // depuis la capture décrit une mémoire qui a vu une autre disposition : le dire coûte quatre
  // octets de comparaison.
  if (declaree.formatVolume !== presente.formatVolume) {
    throw ecartDeLiaison("formatVolume", {
      declare: declaree.formatVolume,
      present: presente.formatVolume,
      volume,
    });
  }
  if (presente.sequence < declaree.sequence) {
    throw ecartDeLiaison("sequence", {
      declare: `au moins ${declaree.sequence}`,
      present: presente.sequence,
      volume,
    });
  }
  if (declaree.generation !== presente.generation) {
    throw ecartDeLiaison("generation", {
      declare: declaree.generation,
      present: presente.generation,
      volume,
    });
  }
  const empreintes = [
    ["empreinteRegion", declaree.empreinteRegion, presente.empreinteRegion],
    ["empreinteImage", declaree.empreinteImage, presente.empreinteImage],
  ];
  for (const [champ, declare, present] of empreintes) {
    if (egalesEnTempsConstant(declare, present)) continue;
    // Les DEUX empreintes sont publiées en hexadécimal, et ce n'est pas une fuite : une empreinte
    // SHA-256 est déjà ce que la racine du volume porte en clair chiffré, et sans les deux valeurs
    // un « les empreintes diffèrent » n'apprend rien à qui doit décider POURQUOI.
    throw ecartDeLiaison(champ, {
      declare: octetsEnHex(declare),
      present: octetsEnHex(present),
      volume,
    });
  }
}

/**
 * LIT un instantané et rend l'état v86, ou refuse par un état typé.
 *
 * Elle ne retire rien : le retrait est la CONDUITE, et les séparer garde la lecture lisible d'un
 * bloc. Elle n'est PAS exportée — offrir un chemin qui lit sans écarter serait offrir le moyen de
 * garder un instantané que la liaison vient de refuser.
 */
async function lireInstantane({ scellement, volume, etatPresent, support }) {
  const { present, taille } = await support.etat();
  if (!present || taille === 0) return null;
  if (taille < EN_TETE_OCTETS + MARQUE_OCTETS) {
    throw malforme(
      `le fichier fait ${taille} octet(s), moins que l'en-tête et la marque d'un instantané.`,
      { volume, taille },
    );
  }

  const lu = decoderEnTete(await lireExactement(support, 0, EN_TETE_OCTETS, "en-tête"));
  if (!lu.valide) throw malforme(lu.raison, { volume, taille });

  const attendue = liaisonDe(scellement, etatPresent, lu.liaison.longueurEtat);
  confronterLiaison(lu.liaison, attendue, volume);

  // **Il n'y a PAS de contrôle « la taille du fichier vaut celle que l'en-tête déclare » ici**, et
  // son absence est un RÉSULTAT, pas un oubli : la campagne de mutation de #65 a montré qu'un tel
  // contrôle SURVIVAIT à son retrait, c'est-à-dire qu'aucun état atteignable ne le distinguait de
  // la marque de complétude. Un fichier plus COURT que sa déclaration ne rend pas sa marque — la
  // lecture qui suit est courte, et le refus tombe deux lignes plus bas. Un fichier plus LONG porte
  // une queue que personne ne lit : ni le corps, borné par la longueur déclarée, ni le sceau, qui
  // ne couvre que lui. Garder une garde que rien ne peut faire échouer aurait donné une ligne de
  // plus à lire et une confiance de plus à ne pas mériter.
  const marque = await support.lire(offsetDeLaMarque(lu.liaison.longueurEtat), MARQUE_OCTETS);
  if (!marqueCompleteEcrite(marque)) {
    throw incomplet("la marque de complétude n'est pas posée — la capture n'a pas abouti.", {
      volume,
    });
  }

  const chiffre = await lireExactement(
    support,
    offsetDuCorps(),
    lu.liaison.longueurEtat,
    "corps de l'instantané",
  );
  return scellement
    .ouvrirInstantane(lu.liaison, { nonce: lu.nonce, etiquette: lu.etiquette, chiffre })
    .then(
      (etat) => Object.freeze({ etat, liaison: lu.liaison }),
      (cause) => {
        // Le modèle rend déjà un `SCEAU_REFUSE` typé ; les autres causes sont des fautes de
        // programmation ou des pannes, et les habiller en refus effacerait un bogue.
        throw cause?.code === undefined ? sceauRefuse({ volume }) : cause;
      },
    );
}

/** Retire l'instantané sans jamais masquer la raison qui a conduit là. */
async function retirerSansMasquer(support) {
  try {
    await support.retirer();
  } catch {
    // Un support qui refuse de retirer un fichier périmé est une gêne, pas une raison de refuser
    // un boot à froid : le fichier sera réécarté à la prochaine ouverture.
  }
}

/**
 * CONDUITE de l'ouverture : lire, et écarter en retirant dès qu'un écart apparaît.
 *
 * @returns {Promise<{ utilise: boolean, etat: Uint8Array | null, liaison: object | null,
 *                     motif: string | null, message: string | null }>}
 *   `motif` vaut `null` quand l'instantané est utilisable, `"absent"` quand il n'y en a pas, et le
 *   code du refus sinon. Il est PUBLIÉ dans le compte rendu de boot : un contrôle qu'on ne publie
 *   pas finit par être supposé actif.
 */
export async function ouvrirInstantaneDeReprise({ scellement, volume, etatPresent, support }) {
  try {
    const ouvert = await lireInstantane({ scellement, volume, etatPresent, support });
    if (ouvert === null) {
      return Object.freeze({
        utilise: false,
        etat: null,
        liaison: null,
        motif: MOTIF_ABSENT,
        message: null,
      });
    }
    return Object.freeze({
      utilise: true,
      etat: ouvert.etat,
      liaison: ouvert.liaison,
      motif: null,
      message: null,
    });
  } catch (refus) {
    await retirerSansMasquer(support);
    return Object.freeze({
      utilise: false,
      etat: null,
      liaison: null,
      // Un refus sans code n'existe pas sur ce chemin : `lireInstantane` ne laisse passer que des
      // états typés. S'il en passait un, le publier sous son nom vaut mieux que de le taire.
      motif: refus?.code ?? refus?.name ?? "inconnu",
      message: refus?.message ?? null,
    });
  }
}
