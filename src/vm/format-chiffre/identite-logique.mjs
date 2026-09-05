// Identité logique, nonces et bornes du format chiffré (#17, ADR 0015).
//
// Ce module ne chiffre rien. Il définit les OCTETS que le scellement lie : le nonce, qui doit être
// unique sous une clé, et les données associées, qui doivent nommer sans ambiguïté l'endroit d'où un
// bloc vient. Il est pur — aucune clé, aucun état durable, aucune E/S — pour qu'un relecteur externe
// (#20) puisse en juger sans exécuter quoi que ce soit.
//
// ## Le nonce est TIRÉ AU HASARD, et c'est une correction, pas une préférence
//
// La première version de cet ADR dérivait le nonce de (génération, rang) et justifiait son unicité
// par « une reprise ouvre une génération NEUVE ». Une revue l'a réfutée PAR EXÉCUTION contre
// `generation-store.mjs` : la génération n'avance que dans `valider()`, `#recuperer()` la remet à
// celle de la racine qui fait autorité, `#vider()` incrémente la SÉQUENCE en CONSERVANT la
// génération, et la branche « racines vierges au-dessus d'une charge » remet les deux à ZÉRO. Les
// octets étant scellés au DÉPÔT, une génération déposée puis écartée rend son numéro à la tentative
// suivante. Le pire cas ne demande aucune panne : une FERMETURE PROPRE avec un dépôt non validé
// suffit. `tests/unit/vm-format-chiffre-reprise.test.mjs` le rejoue sur le magasin réel.
//
// La leçon est plus générale que le défaut : **dans un système conçu pour survivre aux coupures et
// exposé au retour arrière du support, tout nonce déterministe dérivé d'un état DURABLE — génération,
// séquence, « époque », compteur — est réémis dès que cet état recule.** L'aléa est la seule
// construction dont l'unicité ne dépend d'aucun état.
//
// Douze octets de `crypto.getRandomValues`, donc, conformément au § 8.2.2 de NIST SP 800-38D
// (construction fondée sur un générateur approuvé). Le nonce est STOCKÉ avec chaque objet scellé :
// il n'est plus dérivable de rien, et c'est le prix de sa correction.
//
// Le domaine — bloc du volume, enregistrement du journal, racine, liste d'entrées — reste dans les
// DONNÉES ASSOCIÉES, où il sépare les espaces sans avoir à consommer des bits de nonce.
//
// ## Un domaine PAR MAGASIN, et pourquoi le rang ne suffisait pas (#143)
//
// La première version de ce module donnait la même étiquette — « bloc » — à un secteur du volume et
// à un enregistrement du journal, et comptait sur le RANG pour les séparer. Une pré-revue adverse
// l'a réfutée sur les vecteurs livrés : le format épingle le rang 0 pour un secteur du volume, et le
// premier enregistrement de chaque charge porte le rang 0 puisque son rang est sa position dans la
// charge. Deux objets de magasins différents portaient donc, dans le cas NOMINAL, les mêmes données
// associées au-dessus de deux clairs différents.
//
// La leçon vaut au-delà du cas : **une identité logique doit nommer le MAGASIN d'où elle vient, pas
// seulement la place qu'elle y occupe.** Une place ne sépare que ce qui vit dans le même espace.
//
// ## Ce qui borne alors la probabilité de collision
//
// Sur 96 bits, `N` tirages entrent en collision avec une probabilité majorée par `N² / 2^97`. Le
// § 8.3 de SP 800-38D plafonne à 2^32 les invocations sous une clé, ce qui donne 2^-33. Ce dépôt
// retient un budget **plus conservateur**, et la raison est propre à son modèle de menace : le
// compteur cumulé vit dans la racine, donc il peut RECULER par retour arrière du support, et le
// nombre réel d'invocations peut alors dépasser le nombre compté. La moitié du plafond garde un
// ordre de grandeur de marge.

import { algorithmeInconnu, budgetDeCle, malforme, ordreInvalide } from "./crypto-errors.mjs";
import { chainePrefixee, concatener, concatenerListe, entierEnOctets } from "./octets.mjs";

/** Nom de l'unique algorithme admis par la v1 de cette spécification. Épinglé, pas devinable. */
export const ALGORITHME = "aes-256-gcm";

/** Nom du même algorithme dans l'API WebCrypto du W3C. */
export const ALGORITHME_WEBCRYPTO = "AES-GCM";

/** Version de la SPÉCIFICATION cryptographique, distincte de la version du format de volume. */
export const SPECIFICATION_VERSION = 1;

export const CLE_OCTETS = 32;
export const NONCE_OCTETS = 12;
export const ETIQUETTE_OCTETS = 16;

/** Longueur d'étiquette en bits : le maximum admis par SP 800-38D § 5.2.1.2. */
export const ETIQUETTE_BITS = ETIQUETTE_OCTETS * 8;

/** Empreinte de la liste des entrées d'une génération : SHA-256, comme l'empreinte du manifeste. */
export const EMPREINTE_OCTETS = 32;

/** Identifiant de volume : seize octets aléatoires, inscrits à la création et jamais modifiés. */
export const IDENTIFIANT_VOLUME_OCTETS = 16;

const GENERATION_OCTETS = 6;
const RANG_OCTETS = 5;

/** Plus grande génération représentable par le format (2^48 - 1). */
export const GENERATION_MAX = 2 ** (GENERATION_OCTETS * 8) - 1;

/** Plus grand rang d'entrée représentable par le format (2^40 - 1). */
export const RANG_MAX = 2 ** (RANG_OCTETS * 8) - 1;

/**
 * Plafond du § 8.3 de NIST SP 800-38D : « The total number of invocations of the authenticated
 * encryption function shall not exceed 2^32 […] with the given key. » Publié pour que le budget
 * retenu ci-dessous se lise comme un ÉCART DÉLIBÉRÉ et non comme une valeur tombée du ciel.
 */
export const LIMITE_NIST_INVOCATIONS = 2 ** 32;

/**
 * Budget de scellements sous une même clé de volume : la MOITIÉ du plafond NIST.
 *
 * Deux raisons de descendre. D'abord la collision : sur 96 bits tirés au hasard, `N² / 2^97` vaut
 * 2^-33 à 2^32 tirages et **2^-35** à 2^31. Ensuite, et c'est la raison propre à ce dépôt, le
 * compteur cumulé est authentifié dans la RACINE : un retour arrière du support le fait reculer, et
 * le nombre réel d'invocations sous la clé peut alors dépasser le nombre compté. Un budget serré
 * garde un ordre de grandeur de marge devant cet écart, qu'aucune mesure ne borne aujourd'hui.
 * C'est une question ouverte pour la revue externe (#20).
 */
export const BUDGET_SCELLEMENTS_PAR_CLE = 2 ** 31;

/**
 * Étiquette de domaine d'un BLOC du volume. Elle entre dans les données associées, jamais dans le
 * nonce.
 *
 * Un « bloc » est ici un objet du magasin VOLUME : un secteur de la charge, l'empreinte de la
 * région d'authentification, le témoin de séquence. Un enregistrement du journal n'en est PAS un —
 * voir `ETIQUETTE_DOMAINE_ENREGISTREMENT` et le constat #143 qui l'a imposé.
 */
export const ETIQUETTE_DOMAINE_BLOC = "railsbox-vault/format-chiffre/v1/bloc";

/**
 * Étiquette de domaine d'un ENREGISTREMENT du journal de génération (#143).
 *
 * **Pourquoi une étiquette par magasin, et non un rang réservé.** Le rang ne sépare rien : le format
 * épingle le rang 0 pour un secteur du volume, et le premier enregistrement de chaque charge porte
 * le rang 0 parce que son rang EST sa position dans la charge. Dans le cas nominal d'une écriture
 * alignée sur un secteur, les deux objets partagent alors volume, version de format, génération,
 * rang, adresse et longueur — donc des données associées identiques octet pour octet, au-dessus de
 * deux clairs différents. Épisser dans la région et la charge du volume le sceau et le chiffré d'un
 * enregistrement faisait rendre au lecteur de volume le clair du journal, sans aucune clé.
 *
 * Décaler les rangs d'enregistrement de un aurait fermé le cas observé sans fermer la classe : deux
 * magasins seraient restés dans le même espace d'identités, séparés par une convention que rien
 * n'aurait relue. L'étiquette, elle, sépare les espaces par construction et à tout rang.
 *
 * L'espace de noms reste `v1` : la version d'une spécification nomme la FORME de ses encodages —
 * champs, largeurs, ordre, préfixes —, et celle-ci ne bouge pas. Ajouter un domaine à côté des trois
 * qui existaient n'invalide aucun octet déjà scellé sous les autres, et `SPECIFICATION_VERSION` reste
 * donc 1. Ce qui change de version est le format du JOURNAL, seul magasin dont les octets bougent
 * (ADR 0019 amendé).
 */
export const ETIQUETTE_DOMAINE_ENREGISTREMENT = "railsbox-vault/format-chiffre/v1/enregistrement";

/** Étiquette de domaine d'une racine de génération. */
export const ETIQUETTE_DOMAINE_RACINE = "railsbox-vault/format-chiffre/v1/racine";

/** Étiquette de domaine de l'empreinte de la liste des entrées d'une génération. */
export const ETIQUETTE_DOMAINE_ENTREES = "railsbox-vault/format-chiffre/v1/entrees";

function entierBorne(nom, valeur, maximum) {
  if (!Number.isSafeInteger(valeur) || valeur < 0 || valeur > maximum) {
    throw malforme(`« ${nom} » doit être un entier de 0 à ${maximum}, reçu ${valeur}.`, {
      champ: nom,
      valeur,
      maximum,
    });
  }
  return valeur;
}

function identifiant(nom, valeur) {
  if (typeof valeur !== "string" || valeur.length === 0 || valeur.length > 0xff) {
    throw malforme(`« ${nom} » doit être une chaîne non vide d'au plus 255 caractères.`, {
      champ: nom,
    });
  }
  return valeur;
}

/**
 * Tire un nonce. Aucun état, aucun compteur, aucune dérivation : c'est tout l'intérêt.
 *
 * `crypto.getRandomValues` est le générateur de l'API Web Cryptography ; la construction relève du
 * § 8.2.2 de SP 800-38D. Un appelant ne doit JAMAIS réemployer un nonce rendu ici, ni le dériver
 * d'autre chose : c'est la seule obligation, et elle ne dépend d'aucun état durable.
 *
 * @returns {Uint8Array} exactement `NONCE_OCTETS` octets
 */
export function tirerNonce() {
  return crypto.getRandomValues(new Uint8Array(NONCE_OCTETS));
}

/**
 * Rend la forme TEXTUELLE d'un identifiant de volume à partir de ses seize octets.
 *
 * La règle de conversion est fixée ici plutôt que laissée à l'usage, parce que sans elle #18 ne
 * pourrait pas reproduire les vecteurs : le disque porte seize octets bruts, les données associées
 * portent une CHAÎNE, et deux conventions différentes donneraient deux étiquettes différentes pour
 * le même volume. La forme retenue est l'hexadécimal MINUSCULE sans séparateur, trente-deux
 * caractères.
 */
export function identifiantVolumeEnTexte(octets) {
  if (!(octets instanceof Uint8Array) || octets.byteLength !== IDENTIFIANT_VOLUME_OCTETS) {
    throw malforme(
      `un identifiant de volume fait exactement ${IDENTIFIANT_VOLUME_OCTETS} octets.`,
      { attendu: IDENTIFIANT_VOLUME_OCTETS },
    );
  }
  let texte = "";
  for (const octet of octets) texte += octet.toString(16).padStart(2, "0");
  return texte;
}

/**
 * Données associées d'un objet ADRESSÉ, sous l'étiquette de domaine de SON magasin.
 *
 * Chaque champ est de largeur fixe ou préfixé de sa longueur, si bien que deux identités distinctes
 * ne peuvent pas rendre la même chaîne d'octets. C'est la condition pour que « lier l'identité »
 * veuille dire quelque chose : une concaténation non préfixée permettrait de déplacer un caractère
 * d'un champ à l'autre sans changer les octets, donc de déplacer un bloc sans que l'étiquette
 * bronche. `tests/unit/vm-format-chiffre-identite.test.mjs` éprouve ce cas précis en réencodant sans
 * les préfixes et en montrant la collision que le préfixe évite.
 *
 * L'étiquette est le PREMIER champ, et c'est ce qui sépare les magasins : deux objets qui
 * partageraient les six champs suivants — le cas nominal d'un secteur du volume et du premier
 * enregistrement de sa charge — ne rendent tout de même pas la même chaîne (#143).
 */
function encoderIdentiteAdressee(
  etiquetteDeDomaine,
  { volume, formatVersion, generation, rang, adresse, longueur },
) {
  identifiant("volume", volume);
  entierBorne("formatVersion", formatVersion, 0xffffffff);
  entierBorne("generation", generation, GENERATION_MAX);
  entierBorne("rang", rang, RANG_MAX);
  entierBorne("adresse", adresse, Number.MAX_SAFE_INTEGER);
  entierBorne("longueur", longueur, 0xffffffff);

  return concatener(
    chainePrefixee(etiquetteDeDomaine),
    chainePrefixee(ALGORITHME),
    entierEnOctets(formatVersion, 4),
    chainePrefixee(volume),
    entierEnOctets(generation, 8),
    entierEnOctets(rang, 8),
    entierEnOctets(adresse, 8),
    entierEnOctets(longueur, 4),
  );
}

/**
 * Données associées d'un BLOC DU VOLUME : l'identité logique COMPLÈTE, encodée sans ambiguïté.
 *
 * Un bloc est un secteur de la charge, l'empreinte de la région d'authentification ou le témoin de
 * séquence. Ces octets-là n'ont pas changé depuis l'ADR 0015, et c'est délibéré :
 * `tests/vectors/format-chiffre-v1.json` reste valide, et un volume déjà scellé se relit sans
 * migration (#143).
 *
 * @param {{ volume: string, formatVersion: number, generation: number, rang: number,
 *           adresse: number, longueur: number }} identite
 */
export function encoderIdentiteBloc(identite) {
  return encoderIdentiteAdressee(ETIQUETTE_DOMAINE_BLOC, identite);
}

/**
 * Données associées d'un ENREGISTREMENT du journal de génération (#143).
 *
 * Même forme que celle d'un bloc, à l'étiquette de domaine près — et c'est tout l'objet : la forme
 * commune garde une seule règle d'encodage à relire, l'étiquette distincte garde les deux magasins
 * dans deux espaces d'identités disjoints. Le rang y reste la POSITION de l'enregistrement dans sa
 * charge, en base zéro : il ordonne, il ne sépare plus rien.
 *
 * @param {{ volume: string, formatVersion: number, generation: number, rang: number,
 *           adresse: number, longueur: number }} identite
 */
export function encoderIdentiteEnregistrement(identite) {
  return encoderIdentiteAdressee(ETIQUETTE_DOMAINE_ENREGISTREMENT, identite);
}

/**
 * Données associées d'une racine : ce que la génération AFFIRME d'elle-même.
 *
 * L'en-tête est en CLAIR sur le support et authentifié ici. Ce qu'il révèle est écrit dans
 * l'ADR 0015 : le nombre d'entrées d'une génération, la longueur de sa charge et le rang de la
 * génération. C'est un canal auxiliaire sur le VOLUME d'écriture, assumé et nommé, pas une fuite
 * découverte après coup.
 *
 * @param {{ volume: string, formatVersion: number, sequence: number, generation: number,
 *           tailleVolume: number, nombreEntrees: number, longueurCharge: number,
 *           scellementsCumules: number }} entete
 */
export function encoderEnteteRacine({
  volume,
  formatVersion,
  sequence,
  generation,
  tailleVolume,
  nombreEntrees,
  longueurCharge,
  scellementsCumules,
}) {
  identifiant("volume", volume);
  entierBorne("formatVersion", formatVersion, 0xffffffff);
  entierBorne("sequence", sequence, RANG_MAX);
  entierBorne("generation", generation, GENERATION_MAX);
  entierBorne("tailleVolume", tailleVolume, Number.MAX_SAFE_INTEGER);
  entierBorne("nombreEntrees", nombreEntrees, 0xffffffff);
  entierBorne("longueurCharge", longueurCharge, Number.MAX_SAFE_INTEGER);
  entierBorne("scellementsCumules", scellementsCumules, Number.MAX_SAFE_INTEGER);

  return concatener(
    chainePrefixee(ETIQUETTE_DOMAINE_RACINE),
    chainePrefixee(ALGORITHME),
    entierEnOctets(formatVersion, 4),
    chainePrefixee(volume),
    entierEnOctets(sequence, 8),
    entierEnOctets(generation, 8),
    entierEnOctets(tailleVolume, 8),
    entierEnOctets(nombreEntrees, 4),
    entierEnOctets(longueurCharge, 8),
    entierEnOctets(scellementsCumules, 8),
  );
}

/**
 * Encodage canonique de la SUITE des entrées d'une génération, dont la racine scelle l'empreinte.
 *
 * Chaque entrée y porte son adresse, sa longueur, son rang et l'ÉTIQUETTE de son bloc scellé — pas
 * le chiffré. La raison est bon marché et se dit : sous une même clé, un même nonce et une même
 * identité, deux chiffrés distincts partageant une étiquette constituent une forgerie GCM, bornée
 * par 2^-122,6 (voir l'ADR 0015). La racine dit donc QUELS blocs composent la génération ; chaque
 * bloc dit qu'il est intact. Aucune des deux vérifications ne remplace l'autre.
 *
 * Le nonce n'y figure pas : il est conservé avec l'enregistrement, et l'étiquette le couvre déjà —
 * une étiquette ne vérifie que sous le nonce qui l'a produite.
 *
 * @param {Array<{ adresse: number, longueur: number, rang: number, etiquette: Uint8Array }>} entrees
 */
export function encoderEntrees(entrees) {
  if (!Array.isArray(entrees)) {
    throw malforme("« entrees » doit être un tableau.");
  }
  const morceaux = [chainePrefixee(ETIQUETTE_DOMAINE_ENTREES), entierEnOctets(entrees.length, 4)];
  for (const [index, entree] of entrees.entries()) {
    const { adresse, longueur, rang, etiquette } = entree ?? {};
    entierBorne(`entrees[${index}].adresse`, adresse, Number.MAX_SAFE_INTEGER);
    entierBorne(`entrees[${index}].longueur`, longueur, 0xffffffff);
    entierBorne(`entrees[${index}].rang`, rang, RANG_MAX);
    if (!(etiquette instanceof Uint8Array) || etiquette.byteLength !== ETIQUETTE_OCTETS) {
      throw malforme(`« entrees[${index}].etiquette » doit faire ${ETIQUETTE_OCTETS} octets.`, {
        index,
      });
    }
    morceaux.push(
      entierEnOctets(adresse, 8),
      entierEnOctets(longueur, 4),
      entierEnOctets(rang, 8),
      etiquette,
    );
  }
  // `concatenerListe`, et non `concatener(...morceaux)` : le nombre de morceaux suit le nombre
  // d'entrées, et l'étalement dépasse la pile d'appel au plafond de charge de l'ADR 0014. Le défaut
  // est tombé par exécution sur `tests/vm/recuperation-generation.spec.mjs` ; les octets produits
  // sont inchangés, ce que les vecteurs figés vérifient.
  return concatenerListe(morceaux);
}

/**
 * Exige des rangs STRICTEMENT CROISSANTS dans la liste d'entrées d'une génération.
 *
 * Depuis que le nonce est tiré au hasard, le rang ne porte plus l'unicité — mais l'ORDRE, lui, est
 * devenu une propriété du format : la racine scelle une SUITE, et deux permutations des mêmes
 * entrées sont deux générations différentes. Exiger la croissance stricte rend l'ordre canonique
 * plutôt que conventionnel, et refuse du même geste le doublon de rang, qui n'a aucun sens dans un
 * journal indexé par position.
 */
export function verifierRangsCroissants(entrees) {
  let precedent = null;
  for (const [index, entree] of entrees.entries()) {
    const rang = entree?.rang;
    if (precedent !== null && rang <= precedent) {
      throw ordreInvalide(
        `l'entrée ${index} porte le rang ${rang}, qui ne dépasse pas le rang ${precedent} de l'entrée précédente.`,
        { index, rang, precedent },
      );
    }
    precedent = rang;
  }
  return entrees;
}

/**
 * Refuse un scellement au-delà du budget de la clé. Rendu tel quel sous la limite, pour qu'un
 * appelant puisse l'employer comme compteur sans dupliquer la règle.
 *
 * Le compteur inclut les RACINES : le § 8.3 compte « all instances of the authenticated encryption
 * function », et une racine en est une.
 */
export function verifierBudgetDeCle(scellementsCumules) {
  entierBorne("scellementsCumules", scellementsCumules, Number.MAX_SAFE_INTEGER);
  if (scellementsCumules >= BUDGET_SCELLEMENTS_PAR_CLE) {
    throw budgetDeCle({ scellementsCumules, budget: BUDGET_SCELLEMENTS_PAR_CLE });
  }
  return scellementsCumules;
}

/** Refuse un nom d'algorithme autre que l'unique nom admis. L'agilité passe par une version, pas ici. */
export function verifierAlgorithme(nom) {
  if (nom !== undefined && nom !== ALGORITHME) {
    throw algorithmeInconnu({ presente: nom, admis: ALGORITHME });
  }
  return ALGORITHME;
}
