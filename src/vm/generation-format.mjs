// Format du journal de génération (#16, ADR 0014).
//
// Une génération est l'ensemble des écritures comprises entre deux barrières acquittées. Elle est
// déposée dans un fichier VOISIN du volume — `<volume>.gen` — puis VALIDÉE par l'écriture d'une
// RACINE : un seul secteur, qui nomme la génération et scelle la charge.
//
// Deux propriétés gouvernent tout ce fichier.
//
//  - **La commutation tient dans une écriture d'un seul secteur.** `RACINE_OCTETS` vaut 512, la plus
//    petite unité que le matériel émulé adresse. L'atomicité sectorielle du support n'est pas
//    SUPPOSÉE pour autant : la racine porte l'ÉTIQUETTE de son propre en-tête, si bien qu'une racine
//    écrite à moitié est DÉTECTÉE et refusée. C'est une hypothèse écrite, et éprouvée par
//    `tests/unit/vm-generation-format.test.mjs`, pas une hypothèse subie.
//  - **Les racines ALTERNENT.** Chaque écriture de racine porte un numéro de SÉQUENCE monotone et
//    occupe l'emplacement `sequence % RACINES`. Une validation interrompue ne peut donc PAS détruire
//    la racine qui fait autorité — ce qui serait la perte d'une écriture acquittée, c'est-à-dire une
//    violation de `SEC-DURABLE-001`. « Pas », et non « jamais » : la propriété repose sur une
//    hypothèse, écrite dans l'ADR 0014 — deux PAGES HÔTES distinctes ne sont pas abîmées ensemble.
//    C'est pourquoi les deux emplacements sont séparés par `PAGE_HOTE_OCTETS`, et non par un secteur.
//
// ## Le format v3 (#18, ADR 0016) : le CRC-32 a cédé la place à une ÉTIQUETTE
//
// L'ADR 0014 disait de sa somme de contrôle qu'elle « ne prétend RIEN contre un altérateur
// volontaire, qui la recalculerait sans difficulté », et qu'elle laissait la place à
// `SEC-BLOCK-001`. #18 la prend. Trois changements, tous décidés par l'ADR 0016 :
//
//  - **le format du journal passe de 1 à 2.** C'est la barrière de version : un runtime qui ne
//    connaît que v1 refuse cette racine par « Format de journal de génération inconnu », sans avoir
//    à comprendre ce qui a changé ;
//  - **la racine passe de 60 à 136 octets** dans le MÊME secteur, et son CRC-32 est remplacé par le
//    nonce, le chiffré (l'empreinte scellée des entrées) et l'étiquette. Recalculer exige désormais
//    la clé ;
//  - **un enregistrement porte un SCEAU de 34 octets** entre son en-tête et sa charge — la même
//    forme que la région d'authentification du volume, génération comprise. L'ADR 0015 en annonçait
//    28 en supposant que la génération d'un enregistrement était celle de sa racine ; l'ADR 0016
//    montre que c'est faux, puisque le journal n'est vidé qu'au point de contrôle et qu'une charge
//    porte donc plusieurs générations.
//
// ## Le format 3 (#19, ADR 0019) : la racine date aussi la RÉGION du volume
//
// L'ADR 0015 nommait un résidu que #18 n'a pas fermé : un secteur du volume ramené en arrière —
// chiffré, nonce, étiquette et génération remis ensemble — est authentique, parce que son sceau et
// son identité viennent du même endroit. #19 le ferme en ajoutant à la racine l'EMPREINTE SCELLÉE
// de la région d'authentification. La racine passe de 136 à 202 octets, dans le même secteur, et le
// format du journal de 2 à 3 — exactement le chemin que l'ADR 0016 avait prévu pour ce cas.
//
// Une racine de format 2, laissée par #18, reste LISIBLE : elle ne scelle aucune empreinte, le
// décodeur le dit par `fraicheur: null`, et la première racine écrite ensuite porte l'empreinte.
//
// ## Le format 4 (#143) : un enregistrement n'est plus un bloc du volume
//
// La pré-revue adverse de #20 a montré qu'un enregistrement du journal et un secteur du volume à la
// même adresse, même génération, rang 0 — le cas NOMINAL — portaient des données associées
// identiques octet pour octet. La correction est une étiquette de domaine PAR MAGASIN
// (`identite-logique.mjs`), et elle change ce que la charge d'un journal porte : le format passe
// donc de 3 à 4, exactement comme l'ADR 0019 l'a fait passer de 2 à 3.
//
// **Aucun octet de la RACINE ne bouge**, et aucun octet du VOLUME non plus : les données associées
// d'un secteur, d'une racine, de l'empreinte de région et du témoin sont inchangées, et les vecteurs
// de l'ADR 0015 restent valides. Ce qui change est le seul magasin dont l'ADR 0016 décrit la charge.
//
// **Un journal de format 3 est REJOUÉ une fois**, sous l'ancien encodage — une génération validée y
// vit jusqu'à ce qu'une ouverture la reporte dans le volume, et la refuser perdrait une écriture
// acquittée. Le vidage qui termine toute récupération écrit ensuite une racine de format 4.
//
// **Le champ de format n'est pas authentifié, et il faut dire ce que cela laisse.** Les formats 3 et
// 4 ont la même disposition : aucune garde de cohérence ne peut les distinguer comme celle qui
// distingue 2 de 3. Retourner ce champ fait donc ouvrir les enregistrements sous l'autre étiquette,
// qui ne vérifie pas : le résultat est un REFUS (`VAULT_STORAGE_GENERATION_CORRUPT`), jamais un
// clair. Sur une racine VIDE — l'état d'un journal au repos —, le retournement ne change rien,
// puisque aucun enregistrement n'est ouvert. Ce qui interdit de rejouer un VRAI journal de format 3
// à côté d'un volume plus récent reste ce qui l'interdisait déjà : le plancher de séquence du témoin
// et l'empreinte de région que sa racine scelle.
//
// La **longueur de charge** que la racine authentifie est celle des CLAIRS (ADR 0015,
// `enteteDeRacine`). La longueur PHYSIQUE de la charge s'en déduit — `longueurCharge +
// nombreEntrees × SURCOUT_ENREGISTREMENT` — plutôt que d'être stockée : deux grandeurs stockées
// peuvent diverger, une grandeur dérivée ne le peut pas.

import { SECTOR_SIZE } from "./block-geometry.mjs";
import { FRAICHEUR_OCTETS } from "./generation-fraicheur.mjs";
import {
  EMPREINTE_OCTETS,
  ETIQUETTE_OCTETS,
  IDENTIFIANT_VOLUME_OCTETS,
  NONCE_OCTETS,
} from "./format-chiffre/identite-logique.mjs";
import { SCEAU_OCTETS } from "./volume-chiffre-format.mjs";

/** Marqueur d'une racine de génération. Huit octets, jamais modifiés. */
const MAGIC = Uint8Array.from([0x56, 0x4c, 0x54, 0x47, 0x45, 0x4e, 0x30, 0x31]); // "VLTGEN01"

/**
 * Version du format du journal de génération, ÉCRITE par ce runtime. Distincte du format du
 * manifeste (#10) et de celui du VOLUME, qui reste v3.
 *
 * **2 depuis #18** : la racine est scellée, plus sommée. **3 depuis #19** : elle scelle en outre
 * l'empreinte de la région d'authentification du volume (ADR 0019). **4 depuis #143** : les
 * ENREGISTREMENTS de la charge sont scellés sous leur propre étiquette de domaine, distincte de
 * celle des secteurs du volume. Un runtime antérieur refuse cette racine comme un format inconnu, ce
 * qui est exactement le comportement voulu — il ouvrirait les enregistrements sous l'ancienne
 * étiquette, c'est-à-dire dans l'espace d'identités du volume.
 */
export const GENERATION_FORMAT = 4;

/**
 * Formats de journal que ce runtime sait LIRE. Trois, et l'écart entre lire et écrire est le sujet.
 *
 * #19 ajoute à la racine l'empreinte scellée de la région d'authentification (ADR 0019), donc un
 * champ. L'ADR 0016 avait prévu le cas et nommé sa réserve — « la réserve du secteur de racine
 * (376 octets libres) l'accueille sous une version de format » —, si bien que le secteur ne change
 * pas de taille et que seule la version bouge.
 *
 * Un volume scellé par #18 porte une racine de format 2, sans ce champ. Il reste OUVRABLE : ce
 * runtime la décode, constate qu'elle ne scelle aucune empreinte, et ne prétend donc aucune
 * fraîcheur pour cette ouverture-là. La MIGRATION est immédiate et sans geste d'exploitation — toute
 * récupération se termine par un vidage, qui écrit une racine neuve : la propriété est acquise dès la
 * première réouverture. Ce que cette fenêtre laisse ouvert, et pour cette ouverture seulement, est
 * écrit dans l'ADR 0019.
 *
 * Ce que ce runtime n'écrit JAMAIS est une racine de format 3 : elle porterait une empreinte de
 * région tout en remettant les enregistrements dans l'espace d'identités du volume (#143), et cette
 * combinaison-là n'a aucune raison d'exister.
 *
 * Il écrit ENCORE le format 2, et il faut le dire au lieu de l'affirmer disparu — une revue a relevé
 * qu'une phrase antérieure de ce fichier prétendait le contraire deux lignes au-dessus de la
 * fonction qui l'écrit. Une session qui ne tient AUCUNE source de fraîcheur écrit le journal de #18,
 * enregistrements compris : voir `formatEcritSousFraicheur`. Aucun chemin du produit n'ouvre ainsi,
 * et ce n'est pas cette phrase qui le garantit mais
 * `tests/unit/harnais-portes.test.mjs` › « aucun OUVREUR SANS FRAÎCHEUR n'est un module de src/ ».
 */
export const GENERATION_FORMAT_SANS_FRAICHEUR = 2;

/**
 * Dernier format dont les ENREGISTREMENTS portent l'identité d'un BLOC DU VOLUME (#143).
 *
 * Un journal de format 3 est LU et REJOUÉ une fois, sous l'ancien encodage, puis remplacé par le
 * format 4 au vidage qui termine toute récupération. Le refuser aurait perdu une écriture acquittée
 * — une génération validée vit dans le journal jusqu'à ce qu'une ouverture la reporte dans le volume
 * —, et le lire sous le NOUVEL encodage l'aurait refusée par « sceau refusé », donc par
 * `VAULT_STORAGE_GENERATION_CORRUPT` : « restaurer une sauvegarde » pour un volume intact. C'est le
 * défaut que la revue de #110 a nommé sur le format 1, et `generation-v1-rejeu.mjs` en est le
 * précédent.
 */
export const GENERATION_FORMAT_IDENTITE_DE_BLOC = 3;

/**
 * Format d'une racine qui publie les DEUX compteurs — celui du volume et celui du journal (#182,
 * ADR 0033, décision 4). C'est le format qu'écrit un volume v4, et lui seul.
 *
 * **Pourquoi un NUMÉRO de plus, alors que l'ADR 0033 range « le format 4 du journal » parmi ce qui
 * ne change pas.** Ce que l'ADR y range est la DISPOSITION du journal — l'emplacement des racines,
 * la forme d'un enregistrement, son sceau — et elle ne bouge pas d'un octet. Ce qui bouge est la
 * RACINE, qui gagne huit octets dans sa réserve, et ce module tient une règle plus ancienne que
 * l'ADR : **un numéro de format dit ce que porte la racine.** Une racine à deux compteurs relue
 * comme une racine à un seul rendrait un compteur de journal nul sans que rien ne le signale, et
 * une racine à un compteur relue comme une racine à deux lirait de la réserve. Laisser les deux
 * sous le numéro 4 aurait donc fait deux racines différentes sous un seul nom. L'ADR 0033 reçoit
 * sa note datée sur ce point, et l'ADR 0035 l'écrit.
 *
 * Le champ de format reste NON AUTHENTIFIÉ, comme il l'a toujours été — mais il ne peut plus mentir
 * en silence : les données associées de la racine comptent onze champs à partir de la v4, donc une
 * racine relue sous le mauvais nombre de compteurs ne VÉRIFIE pas.
 */
export const GENERATION_FORMAT_DEUX_COMPTEURS = 5;

export const GENERATION_FORMATS_LUS = Object.freeze([
  GENERATION_FORMAT_SANS_FRAICHEUR,
  GENERATION_FORMAT_IDENTITE_DE_BLOC,
  GENERATION_FORMAT,
  GENERATION_FORMAT_DEUX_COMPTEURS,
]);

/** Vrai si la racine d'un journal de ce format publie les DEUX compteurs de l'ADR 0033. */
export function racinePorteDeuxCompteurs(format) {
  return format >= GENERATION_FORMAT_DEUX_COMPTEURS;
}

/**
 * Vrai si les enregistrements d'un journal de ce format portent l'identité d'un BLOC DU VOLUME.
 *
 * La règle vit ICI, dans le module du format, et nulle part ailleurs : le lecteur de charge la
 * consulte, il ne la rejoue pas. Deux endroits qui décideraient de la même chose finiraient par
 * décider deux choses différentes.
 */
export function enregistrementsSousIdentiteDeBloc(format) {
  return format <= GENERATION_FORMAT_IDENTITE_DE_BLOC;
}

/** Formats dont la racine porte l'empreinte de région de l'ADR 0019. */
function racinePorteFraicheur(format) {
  return format > GENERATION_FORMAT_SANS_FRAICHEUR;
}

/**
 * Format de journal qu'ÉCRIT une session, selon qu'elle tient une fraîcheur de région ou non.
 *
 * **Un numéro de format dit DEUX choses ensemble** : ce que porte la racine, et sous quelle
 * étiquette de domaine les enregistrements de sa charge sont scellés. Elles vont ensemble parce que
 * ce runtime n'écrit qu'une seule combinaison en production — 4 —, et parce que la seule autre qu'il
 * sache écrire, 2, existe pour une raison unique : fabriquer le journal de #18, celui que le chemin
 * de compatibilité doit savoir relire. Les découpler aurait demandé un champ de plus dans la racine
 * pour un état qu'aucun volume de production n'atteint.
 *
 * L'ouvreur du produit fournit TOUJOURS une source de fraîcheur (`opfs-volume-ouverture.mjs`), donc
 * écrit toujours du 4 ; seuls des bancs et des outils de mesure déclarent `fraicheur: null`. C'est
 * ce que `tests/unit/vm-journal-format-4.test.mjs` épingle par le chemin d'ouverture réel, pour que
 * la propriété ne dépende pas de la lecture de cette phrase.
 *
 * Le format qu'une session écrit ne change JAMAIS en cours de session : toute récupération se
 * termine par un vidage, qui réécrit la racine et tronque la charge. Un journal MIXTE — des
 * enregistrements sous deux étiquettes de domaine — n'existe donc à aucun instant.
 */
export function formatEcritSousFraicheur(fraicheurTenue, formatDeVolume = 3) {
  if (formatDeVolume >= FORMAT_DE_VOLUME_A_DEUX_COMPTEURS) {
    // **Un volume v4 qui ne tiendrait aucune fraîcheur est REFUSÉ, et non dégradé en format 2.**
    // Les données associées d'une racine comptent onze champs à partir de la v4 — le nombre suit la
    // version de VOLUME, qui est authentifiée —, tandis qu'une racine de format 2 n'a pas de place
    // sur le disque pour le second compteur. La combinaison n'a donc aucun encodage possible, et
    // l'écrire produirait une racine que personne ne pourrait relire. Aucun chemin du produit n'y
    // mène : l'ouvreur fournit toujours une source de fraîcheur, et
    // `tests/unit/harnais-portes.test.mjs` le tient.
    if (!fraicheurTenue) {
      throw new RangeError(
        `Un volume au format ${formatDeVolume} ne peut pas écrire de racine sans fraîcheur de région : sa racine publie deux compteurs, et le format ${GENERATION_FORMAT_SANS_FRAICHEUR} n'a pas de place pour le second. Ouvrir un volume v4 exige une source de fraîcheur (ADR 0019, ADR 0033).`,
      );
    }
    return GENERATION_FORMAT_DEUX_COMPTEURS;
  }
  return fraicheurTenue ? GENERATION_FORMAT : GENERATION_FORMAT_SANS_FRAICHEUR;
}

/**
 * Version de format de VOLUME à partir de laquelle la racine publie deux compteurs.
 *
 * Elle est ici, et non importée de `volume-chiffre-format.mjs`, pour la raison qui tient ce module à
 * part : il ne connaît que le journal, et une dépendance vers la disposition du volume en ferait un
 * module de volume. Les deux nombres sont confrontés par
 * `tests/unit/vm-generation-format.test.mjs`, qui les lit des deux côtés.
 */
export const FORMAT_DE_VOLUME_A_DEUX_COMPTEURS = 4;

/** Une racine occupe un secteur entier : c'est l'unité de la commutation. */
export const RACINE_OCTETS = SECTOR_SIZE;

/** Nombre de racines. Deux suffisent : valider n'écrase jamais la racine qui fait autorité. */
export const RACINES = 2;

/**
 * Octets qu'occupe une racine de format 2 dans son secteur : 136 sur 512. Détail dans l'ADR 0016.
 *
 * marqueur 8 + format 4 + secteur 4 + séquence 8 + génération 8 + taille du volume 8 + nombre
 * d'entrées 4 + longueur de charge 8 + identifiant de volume 16 + scellements cumulés 8 + nonce 12
 * + chiffré 32 + étiquette 16.
 */
export const RACINE_ENTETE_V2_OCTETS = 136;

/**
 * Octets qu'occupe une racine v3 de format 3 ou 4 : 202 sur 512, la réserve restant à zéro.
 *
 * Les formats 3 et 4 ont EXACTEMENT la même disposition : #143 ne change aucun octet de la racine,
 * seulement l'étiquette de domaine sous laquelle les enregistrements de la charge sont scellés.
 *
 * Les 136 premiers sont ceux de #18, inchangés. Les 66 suivants sont la FRAÎCHEUR de l'ADR 0019 :
 * le sceau de l'empreinte de région (nonce 12 + étiquette 16 + génération 6) puis son chiffré (32).
 * C'est la même forme de sceau que partout ailleurs dans le format — deux encodages du même objet
 * finissent toujours par diverger.
 */
export const RACINE_ENTETE_OCTETS = RACINE_ENTETE_V2_OCTETS + FRAICHEUR_OCTETS;

/** Largeur d'un compteur cumulé dans la racine : huit octets, comme celui de #18. */
const COMPTEUR_OCTETS = 8;

/**
 * Octets qu'occupe une racine de format 5 : 210 sur 512, la réserve restant à zéro.
 *
 * Les 202 premiers sont ceux du format 4, INCHANGÉS — ce qui est déjà sur un support se relit à la
 * même place. Les huit derniers sont `scellementsCumulesJournal`, le compteur de la clé du domaine
 * `journal` (#182, ADR 0033, décision 4). Le compteur du volume, lui, reste à l'offset 68 : il ne
 * change que de NOM, `scellementsCumules` devenant `scellementsCumulesVolume`.
 */
export const RACINE_ENTETE_V5_OCTETS = RACINE_ENTETE_OCTETS + COMPTEUR_OCTETS;

/** Sceau d'un enregistrement : la MÊME forme que celle de la région du volume (ADR 0016). */
export const SCEAU_ENREGISTREMENT_OCTETS = SCEAU_OCTETS;

/**
 * ÉCART entre deux emplacements de racine. Une page hôte, pas un secteur.
 *
 * La raison est une exigence de cohérence, relevée en revue de #90. Ce format REFUSE de supposer
 * l'atomicité sectorielle — la racine porte l'étiquette de son propre en-tête, précisément
 * pour qu'une écriture déchirée soit détectée. Placer les deux racines dans la même page de 4 Kio
 * reviendrait alors à supposer gratuitement une propriété du même ordre : qu'une écriture qui abîme
 * un secteur ne peut pas abîmer son voisin immédiat. Rien ne le garantit — un support qui réécrit
 * une page entière pour modifier un secteur les emporte tous les deux.
 *
 * Les écarter d'une page ne PROUVE rien non plus : l'hypothèse devient « deux pages distinctes ne
 * tombent pas ensemble », et elle est ÉCRITE dans l'ADR 0014 au lieu d'être subie. C'est pourquoi
 * l'alternance des racines se dit « ne peut PAS détruire, sous cette hypothèse » et non « ne peut
 * JAMAIS détruire ».
 */
export const PAGE_HOTE_OCTETS = 4096;

/** Premier octet de la zone des enregistrements, après les deux racines. */
export const ZONE_ENREGISTREMENTS = RACINES * PAGE_HOTE_OCTETS;

/** En-tête d'un enregistrement : offset logique sur 64 bits, longueur sur 32, réserve sur 32. */
export const ENTETE_OCTETS = 16;

/**
 * Surcoût FIXE d'un enregistrement sur le support : son en-tête et son sceau.
 *
 * Il est fixe, et c'est ce qui permet de dériver la longueur PHYSIQUE d'une charge de ce que la
 * racine authentifie — le nombre d'entrées et la longueur des clairs — au lieu de la stocker.
 */
export const SURCOUT_ENREGISTREMENT = ENTETE_OCTETS + SCEAU_ENREGISTREMENT_OCTETS;

/** Emplacement de la racine de rang `rang`. Une PAGE HÔTE les sépare, pas un secteur. */
export function offsetDeRacine(rang) {
  return rang * PAGE_HOTE_OCTETS;
}

/** Emplacement qu'occupe la racine de séquence `sequence`. L'alternance protège la précédente. */
export function racineDeSequence(sequence) {
  return sequence % RACINES;
}

function ecrireEntier64(vue, position, valeur) {
  if (!Number.isSafeInteger(valeur) || valeur < 0) {
    throw new RangeError(`Entier non représentable dans une racine de génération : ${valeur}.`);
  }
  vue.setUint32(position, valeur >>> 0, true);
  vue.setUint32(position + 4, Math.floor(valeur / 2 ** 32), true);
}

function lireEntier64(vue, position) {
  return vue.getUint32(position, true) + vue.getUint32(position + 4, true) * 2 ** 32;
}

/** Longueur PHYSIQUE d'une charge, dérivée de ce que la racine authentifie. Jamais stockée. */
export function longueurPhysiqueDeCharge({ nombreEntrees, longueurCharge }) {
  return longueurCharge + nombreEntrees * SURCOUT_ENREGISTREMENT;
}

/**
 * Encode une racine SCELLÉE dans un secteur complet.
 *
 * Les champs d'en-tête et le sceau sont écrits ensemble mais ne jouent pas le même rôle : les
 * premiers sont les DONNÉES ASSOCIÉES que le scellement authentifie (sauf marqueur, format et
 * taille de secteur, qui localisent et n'autorisent pas), le second est le verdict. L'appelant a
 * déjà scellé ; ce module ne fait qu'écrire.
 *
 * @param {{ format: number, sequence: number, generation: number, tailleVolume: number,
 *           nombreEntrees: number, longueurCharge: number, identifiantVolume: Uint8Array,
 *           scellementsCumulesVolume: number, scellementsCumulesJournal?: number,
 *           nonce: Uint8Array, chiffre: Uint8Array, etiquette: Uint8Array,
 *           fraicheur: Uint8Array }} racine
 *   `fraicheur` est OBLIGATOIRE : une racine sans empreinte de région désarmerait la fraîcheur de
 *   l'ADR 0019, et un champ facultatif aurait fini par manquer sans que personne le voie.
 *   `format` est celui que la SESSION écrit (`formatEcritSousFraicheur`) : c'est lui qui décide si
 *   le second compteur est inscrit, et l'omettre écrirait une racine de v3 sur un volume v4.
 * @returns {Uint8Array} exactement `RACINE_OCTETS` octets
 */
/**
 * CONTRÔLE les largeurs qu'une racine porte, et EXIGE que la fraîcheur soit décidée.
 *
 * `null` déclare l'absence, `undefined` est un oubli — et un oubli aurait écrit une racine d'avant
 * l'ADR 0019 sans que personne le décide. C'est la règle des attentes de l'ADR 0015.
 */
function exigerLesOctetsDUneRacine({ identifiantVolume, nonce, chiffre, etiquette, fraicheur }) {
  exigerOctets("identifiantVolume", identifiantVolume, IDENTIFIANT_VOLUME_OCTETS);
  exigerOctets("nonce", nonce, NONCE_OCTETS);
  exigerOctets("chiffre", chiffre, EMPREINTE_OCTETS);
  exigerOctets("etiquette", etiquette, ETIQUETTE_OCTETS);
  if (fraicheur === undefined) {
    throw new RangeError(
      "« fraicheur » d'une racine est obligatoire : les octets de l'empreinte de région, ou « null » pour déclarer qu'aucune n'est scellée. Un oubli aurait écrit une racine d'avant l'ADR 0019 sans que personne le décide.",
    );
  }
  if (fraicheur !== null) exigerOctets("fraicheur", fraicheur, FRAICHEUR_OCTETS);
}

export function encoderRacine({
  format,
  sequence,
  generation,
  tailleVolume,
  nombreEntrees,
  longueurCharge,
  identifiantVolume,
  scellementsCumulesVolume,
  scellementsCumulesJournal,
  nonce,
  chiffre,
  etiquette,
  fraicheur,
}) {
  exigerLesOctetsDUneRacine({ identifiantVolume, nonce, chiffre, etiquette, fraicheur });

  const octets = new Uint8Array(RACINE_OCTETS);
  const vue = new DataView(octets.buffer);
  octets.set(MAGIC, 0);
  // La VERSION suit ce que la racine porte réellement, et non l'inverse : écrire « format 3 » sur
  // une racine sans empreinte ferait échouer la relecture sur un champ absent, et écrire
  // « format 2 » sur une racine qui en porte une la rendrait invisible. Depuis #182, la session
  // fournit le format qu'elle écrit — le nombre de COMPTEURS suit la version du VOLUME, que ce
  // module ne connaît pas — et la fraîcheur le CONTREDIT plutôt que de le décider : une racine sans
  // empreinte ne peut être que du format de #18.
  const formatEcrit = fraicheur === null ? GENERATION_FORMAT_SANS_FRAICHEUR : exigerFormat(format);
  vue.setUint32(8, formatEcrit, true);
  vue.setUint32(12, SECTOR_SIZE, true);
  ecrireEntier64(vue, 16, sequence);
  ecrireEntier64(vue, 24, generation);
  ecrireEntier64(vue, 32, tailleVolume);
  vue.setUint32(40, nombreEntrees, true);
  ecrireEntier64(vue, 44, longueurCharge);
  octets.set(identifiantVolume, 52);
  ecrireEntier64(vue, 68, scellementsCumulesVolume);
  octets.set(nonce, 76);
  octets.set(chiffre, 88);
  octets.set(etiquette, 120);
  if (fraicheur !== null) octets.set(fraicheur, RACINE_ENTETE_V2_OCTETS);
  if (racinePorteDeuxCompteurs(formatEcrit)) {
    ecrireLeCompteurDuJournal(vue, formatEcrit, scellementsCumulesJournal);
  }
  return octets;
}

/**
 * ÉCRIT le second compteur, celui du domaine `journal`, à la suite de la fraîcheur (#182).
 *
 * Il est OBLIGATOIRE sur une racine de format 5 : depuis #182 le journal a sa propre clé, donc son
 * propre budget, et une racine qui ne le publierait pas rendrait ce budget invérifiable — c'est-à-dire
 * referait exactement le défaut que #182 corrige.
 */
function ecrireLeCompteurDuJournal(vue, format, scellementsCumulesJournal) {
  if (!Number.isSafeInteger(scellementsCumulesJournal) || scellementsCumulesJournal < 0) {
    throw new RangeError(
      `« scellementsCumulesJournal » d'une racine de format ${format} est obligatoire : depuis #182 le journal a sa propre clé, donc son propre budget, et une racine qui ne le publierait pas rendrait ce budget invérifiable.`,
    );
  }
  ecrireEntier64(vue, RACINE_ENTETE_OCTETS, scellementsCumulesJournal);
}

/** Refuse un format de racine que ce runtime n'écrit pas. Un format deviné écrirait des octets muets. */
function exigerFormat(format) {
  if (format === GENERATION_FORMAT || format === GENERATION_FORMAT_DEUX_COMPTEURS) return format;
  throw new RangeError(
    `Format de racine inadmissible à l'écriture : ${format}. Ce runtime écrit ${GENERATION_FORMAT} pour un volume v3 et ${GENERATION_FORMAT_DEUX_COMPTEURS} pour un volume v4, et ${GENERATION_FORMAT_SANS_FRAICHEUR} quand aucune fraîcheur n'est tenue.`,
  );
}

function exigerOctets(nom, valeur, longueur) {
  if (!(valeur instanceof Uint8Array) || valeur.byteLength !== longueur) {
    throw new RangeError(`« ${nom} » d'une racine fait ${longueur} octets.`);
  }
  return valeur;
}

/**
 * Vrai si la place du SECOND compteur est entièrement nulle — l'état que laisse une racine de #143.
 *
 * Une racine trop courte pour porter ce champ n'a rien à cacher : elle est vierge de ce point de
 * vue, et la longueur est déjà jugée plus haut.
 */
function placeDuSecondCompteurVierge(octets) {
  const fin = Math.min(octets.byteLength, RACINE_ENTETE_V5_OCTETS);
  for (let index = RACINE_ENTETE_OCTETS; index < fin; index += 1) {
    if (octets[index] !== 0) return false;
  }
  return true;
}

/** Vrai si la zone de fraîcheur est entièrement nulle — l'état que laisse une racine de #18. */
function reserveVierge(octets) {
  const fin = Math.min(octets.byteLength, RACINE_ENTETE_OCTETS);
  for (let index = RACINE_ENTETE_V2_OCTETS; index < fin; index += 1) {
    if (octets[index] !== 0) return false;
  }
  return true;
}

function magicPresent(octets) {
  return MAGIC.every((attendu, position) => octets[position] === attendu);
}

/**
 * Vrai si le secteur n'a JAMAIS porté de racine.
 *
 * Le contrôle porte sur l'en-tête COMMUN aux deux formats, et non sur les 202 octets d'une racine de
 * format 3 : une racine de format 2, laissée par #18, a ses 66 derniers octets à zéro, et juger sur
 * la longueur du format le plus récent aurait rendu « vierge » un secteur portant une racine
 * parfaitement valide. Un secteur vierge est une place libre ; une racine illisible est une avarie.
 * Les confondre déciderait du mauvais remède.
 */
function secteurVierge(octets) {
  for (let index = 0; index < RACINE_ENTETE_V2_OCTETS; index += 1) {
    if (octets[index] !== 0) return false;
  }
  return true;
}

/**
 * Relit une racine, sans rien vérifier de cryptographique.
 *
 * **Ce que ce module rend est une racine PLAUSIBLE, jamais une racine AUTHENTIQUE.** Il refuse ce
 * qu'on peut refuser sans clé — secteur vierge, marqueur absent, format inconnu, autre taille de
 * secteur, autre taille de volume — et rend le sceau à l'appelant, à qui il revient de le
 * présenter à `ouvrirRacine`. La distinction est celle de l'ADR 0015 : classer avant d'avoir
 * vérifié l'étiquette serait deviner.
 *
 * @param {Uint8Array} octets un secteur relu du journal
 * @param {{ tailleVolume: number }} attentes
 * @returns {{ valide: boolean, vierge: boolean, racine: object | null, raison: string | null }}
 */
function refusDeRacine(raison, vierge = false) {
  return { valide: false, vierge, racine: null, raison };
}

/**
 * Les contrôles qu'on peut faire SANS CLÉ : forme, marqueur, version, géométrie. Rendus séparément
 * du décodage lui-même pour que chacun tienne d'un regard — et parce que la frontière entre « ce
 * qu'un module de format peut refuser » et « ce que seule l'étiquette refuse » est la décision
 * centrale de l'ADR 0015, pas un détail d'organisation.
 *
 * @returns {{ valide: false } | { valide: true, format: number, vue: DataView }}
 */
/**
 * Ce qu'un FORMAT DÉCLARÉ contredit dans les octets qui l'entourent, ou `null` s'il ne contredit rien.
 *
 * Le champ de format n'est PAS authentifié, et ces deux contrôles sont ce qui l'empêche de mentir en
 * silence. Ils sont le même geste, à deux versions de distance : ce runtime n'écrit jamais un format
 * au-dessus d'octets qu'il ne devrait pas y avoir, si bien qu'un bit retourné dans ce champ — un
 * seul suffit à faire passer 3 pour 2, ou 5 pour 4 — se voit ici.
 *
 * Sans le premier, un adversaire désarmerait la fraîcheur de l'ADR 0019 en touchant un bit qu'aucune
 * étiquette ne couvre (#19). Sans le second, il masquerait un compteur de journal que plus rien ne
 * relirait (#182). Ce qui rend le champ inoffensif est cette cohérence, plus le témoin de séquence
 * quand il en atteste une, plus — depuis la v4 — le fait que les données associées d'une racine
 * comptent onze champs.
 */
function incoherenceDuFormat(octets, format) {
  if (racinePorteFraicheur(format) && octets.byteLength < RACINE_ENTETE_OCTETS) {
    return "Secteur de racine trop court pour porter la fraîcheur de sa région.";
  }
  if (racinePorteDeuxCompteurs(format) && octets.byteLength < RACINE_ENTETE_V5_OCTETS) {
    return "Secteur de racine trop court pour porter le second compteur.";
  }
  if (!racinePorteDeuxCompteurs(format) && !placeDuSecondCompteurVierge(octets)) {
    return `Racine déclarée au format ${format}, à un seul compteur, alors que la place du second compteur n'est pas nulle : un des deux ment.`;
  }
  if (format === GENERATION_FORMAT_SANS_FRAICHEUR && !reserveVierge(octets)) {
    return `Racine déclarée au format ${GENERATION_FORMAT_SANS_FRAICHEUR} alors que sa réserve porte une fraîcheur de région : un des deux ment.`;
  }
  return null;
}

function controlerSansCle(octets, { tailleVolume }) {
  if (!(octets instanceof Uint8Array) || octets.byteLength < RACINE_ENTETE_V2_OCTETS) {
    return refusDeRacine("Secteur de racine trop court pour porter un en-tête.");
  }
  if (secteurVierge(octets)) {
    return refusDeRacine("Secteur vierge : aucune racine n'y a jamais été écrite.", true);
  }
  if (!magicPresent(octets)) return refusDeRacine("Marqueur de racine absent.");

  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const format = vue.getUint32(8, true);
  if (!GENERATION_FORMATS_LUS.includes(format)) {
    return refusDeRacine(`Format de journal de génération inconnu : ${format}.`);
  }
  const incoherence = incoherenceDuFormat(octets, format);
  if (incoherence !== null) return refusDeRacine(incoherence);
  if (vue.getUint32(12, true) !== SECTOR_SIZE) {
    return refusDeRacine("Racine écrite avec une autre taille de secteur.");
  }
  const declaree = lireEntier64(vue, 32);
  if (declaree !== tailleVolume) {
    return refusDeRacine(
      `Racine écrite pour un volume de ${declaree} octets, présenté avec une taille de ${tailleVolume}.`,
    );
  }
  return { valide: true, format, vue };
}

export function decoderRacine(octets, attentes) {
  const controle = controlerSansCle(octets, attentes);
  if (!controle.valide) return controle;
  const { format, vue } = controle;
  return {
    valide: true,
    vierge: false,
    raison: null,
    racine: Object.freeze({
      format,
      sequence: lireEntier64(vue, 16),
      generation: lireEntier64(vue, 24),
      tailleVolume: lireEntier64(vue, 32),
      nombreEntrees: vue.getUint32(40, true),
      longueurCharge: lireEntier64(vue, 44),
      identifiantVolume: octets.slice(52, 52 + IDENTIFIANT_VOLUME_OCTETS),
      scellementsCumulesVolume: lireEntier64(vue, 68),
      // `null` DIT que cette racine ne publie pas le compteur du journal — un volume v3 n'en a
      // qu'un —, et l'appelant doit en décider. Zéro aurait été un compteur comme un autre.
      scellementsCumulesJournal: racinePorteDeuxCompteurs(format)
        ? lireEntier64(vue, RACINE_ENTETE_OCTETS)
        : null,
      scelle: Object.freeze({
        nonce: octets.slice(76, 76 + NONCE_OCTETS),
        chiffre: octets.slice(88, 88 + EMPREINTE_OCTETS),
        etiquette: octets.slice(120, 120 + ETIQUETTE_OCTETS),
      }),
      // `null` DIT qu'aucune empreinte n'est scellée, et l'appelant doit en décider — il ne peut pas
      // le confondre avec une empreinte de zéros, qui serait une empreinte comme une autre.
      fraicheur: racinePorteFraicheur(format)
        ? octets.slice(RACINE_ENTETE_V2_OCTETS, RACINE_ENTETE_OCTETS)
        : null,
    }),
  };
}

/**
 * En-tête d'un enregistrement du journal : où ces octets iront dans le volume, et combien.
 * @param {{ offset: number, longueur: number }} entree
 */
export function encoderEnteteEnregistrement({ offset, longueur }) {
  const octets = new Uint8Array(ENTETE_OCTETS);
  const vue = new DataView(octets.buffer);
  ecrireEntier64(vue, 0, offset);
  vue.setUint32(8, longueur, true);
  vue.setUint32(12, 0, true);
  return octets;
}

/** Relit un en-tête d'enregistrement. Rend `null` si les champs sont hors de tout volume plausible. */
export function decoderEnteteEnregistrement(octets, { tailleVolume }) {
  if (!(octets instanceof Uint8Array) || octets.byteLength < ENTETE_OCTETS) return null;
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const offset = lireEntier64(vue, 0);
  const longueur = vue.getUint32(8, true);
  if (longueur === 0 || offset + longueur > tailleVolume) return null;
  return Object.freeze({ offset, longueur });
}
