// L'ENGAGEMENT D'ARCHIVE : ce qu'une archive v3 promet, et sous quelle clé (#181, ADR 0033).
//
// La revue externe du 10 septembre 2026 a montré qu'une archive non authentifiée suffit à rendre un
// état que le volume n'a JAMAIS produit : chaque secteur reste authentique isolément, et leur
// combinaison ne correspond à aucun état validé. Le SHA-256 public d'une archive est recalculable
// par quiconque tient le fichier ; il atteste contre l'accident, pas contre un adversaire.
//
// L'engagement referme cela. Il scelle, sous une clé propre au domaine `archive`, l'empreinte du
// FICHIER CHIFFRÉ ENTIER que l'archive transporte, avec l'identité et la géométrie du volume.
//
// ## Ce qu'il scelle, champ par champ
//
//     clair            = SHA-256(fichier chiffré ENTIER), 32 octets
//     donnéesAssociées = LP("railsbox-vault/archive/engagement/v1")   étiquette de domaine
//                      ‖ LP("aes-256-gcm")                             nom d'algorithme
//                      ‖ U32BE(versionDArchive)                        3
//                      ‖ LP(identifiantVolume)                         32 hexadécimaux minuscules
//                      ‖ U64BE(tailleSupport)                          géométrie : le FICHIER
//                      ‖ U64BE(tailleLogique)                          géométrie : ce que v86 voit
//                      ‖ U32BE(tailleDeSecteur)                        512
//                      ‖ U32BE(versionDeRecuperation)                  0 sans moyen de récupération
//                      ‖ U64BE(longueurDuContenu)                      longueur des sections
//                      ‖ U64BE(longueurDeLaRecuperation)
//
// Chaque champ est de largeur FIXE ou préfixé de sa longueur, comme au § 5.1 de la spécification :
// une concaténation non préfixée n'est injective que par une propriété du contenu.
//
// **La longueur de l'EN-TÊTE n'y est pas, et c'est une nécessité d'encodage, pas un oubli.**
// L'engagement vit DANS l'en-tête JSON ; y sceller la longueur de cet en-tête la rendrait fonction
// d'elle-même. Ce que l'en-tête déclare et que l'engagement couvre — version, identité, géométrie,
// version de récupération, longueurs des sections — est authentifié ; ce qu'il déclare d'autre ne
// l'est pas, et le § 7.5 le dit sans le maquiller.
//
// ## Pourquoi AES-GCM, et pas HMAC-SHA-256
//
// Sous une clé à USAGE UNIQUE dérivée avec un sel tiré, GCM authentifie exactement aussi bien et
// n'introduit AUCUNE primitive neuve. L'ADR 0015 n'admet qu'un algorithme ; en ajouter un second
// coûterait une famille de vecteurs, un nom dans le manifeste et une question d'agilité de plus.
//
// ## Une archive, une clé, un scellement, aucun compteur
//
// Le domaine `archive` est un domaine à usage unique de l'ADR 0033 : son sel est TIRÉ à chaque
// archive et écrit en clair, la clé qui en descend ne scelle qu'un objet, et le budget de clé du
// § 4.5 n'a rien à compter ici. C'est la condition qui rend le régime valable, et elle est écrite
// pour être relue.

import {
  ALGORITHME,
  ALGORITHME_WEBCRYPTO,
  EMPREINTE_OCTETS,
  ETIQUETTE_BITS,
  ETIQUETTE_OCTETS,
  NONCE_OCTETS,
} from "./format-chiffre/identite-logique.mjs";
import {
  chainePrefixee,
  concatenerListe,
  entierEnOctets,
  hexEnOctets,
  octetsEnHex,
} from "./format-chiffre/octets.mjs";
import {
  DOMAINES,
  SEL_DE_DOMAINE_OCTETS,
  deriverCleDeDomaine,
  encoderInfoDeDomaine,
  tirerSelDeDomaine,
} from "./derivation/cle-de-domaine.mjs";
import { SECTOR_SIZE } from "./block-geometry.mjs";
import { FORMAT_VOLUME_V3 } from "./volume-chiffre-format.mjs";
import { ARCHIVE_ERROR_CODES, ArchiveError } from "./archive-errors.mjs";

/**
 * Jeton exigé pour FIGER le sel et le nonce d'un engagement. Valeur exacte : une valeur approchante
 * n'ouvre rien.
 *
 * Le sel porte l'UNICITÉ de la clé du domaine `archive` (ADR 0033, décision 3) : deux archives
 * scellées sous le même sel et le même nonce partagent une clé ET un nonce, ce qui est la collision
 * que la séparation par domaine avait justement pour objet de borner. Aucun chemin du produit ne
 * fige quoi que ce soit — `scellerEngagement` tire les deux.
 *
 * Seuls l'outil qui FIGE les vecteurs de #181 et les épreuves qui y confrontent le produit ont une
 * raison de l'importer ; `tests/unit/harnais-portes.test.mjs` tient cette liste.
 */
export const HARNAIS_ENGAGEMENT_JETON = "vault/harnais-engagement-archive/vecteurs-181";

const REFUS_ENGAGEMENT =
  `Le sel et le nonce d'un engagement d'archive ne se figent que dans le harnais, et l'appel doit ` +
  `présenter le jeton ${HARNAIS_ENGAGEMENT_JETON}. Deux archives scellées sous le même sel et le ` +
  `même nonce partagent une clé et un nonce, c'est-à-dire la collision que la séparation par ` +
  `domaine borne. Aucun chemin du produit n'en fige : le défaut tire de crypto.getRandomValues.`;

/**
 * Vérifie la porte du harnais et rend le sel et le nonce à employer, ou `null` pour « tirés ».
 *
 * @param {{ jeton?: string, sel?: Uint8Array, nonce?: Uint8Array } | undefined} fige
 */
export function exigerEngagementAdmis(fige) {
  if (fige === undefined || fige === null) return null;
  if (fige.jeton !== HARNAIS_ENGAGEMENT_JETON) throw new Error(REFUS_ENGAGEMENT);
  return Object.freeze({ sel: fige.sel, nonce: fige.nonce });
}

/** Étiquette de domaine de l'OBJET scellé. Elle sépare l'engagement de tout autre scellement. */
export const ETIQUETTE_DOMAINE_ENGAGEMENT = "railsbox-vault/archive/engagement/v1";

/** Marqueur du voisin `<volume>.engagement`. Huit octets ASCII, jamais modifiés. */
export const ENGAGEMENT_MARQUEUR = Uint8Array.from([
  0x56, 0x4c, 0x54, 0x45, 0x4e, 0x47, 0x30, 0x31,
]); // "VLTENG01"

/** Version du FICHIER voisin d'engagement. Distincte de la version d'archive. */
export const ENGAGEMENT_FICHIER_VERSION = 1;

/**
 * Disposition du voisin `<volume>.engagement`, à largeur FIXE.
 *
 * Tout ce qui précède le sel est exactement ce que les données associées encodent : le fichier est
 * SELF-DESCRIPTIF, et ses déclarations sont authentifiées par l'étiquette GCM — les modifier fait
 * échouer l'ouverture, jamais dériver le verdict.
 */
const CHAMPS = Object.freeze({
  marqueur: 0,
  versionDuFichier: 8,
  versionDArchive: 12,
  identifiantVolume: 16,
  tailleSupport: 48,
  tailleLogique: 56,
  tailleDeSecteur: 64,
  versionDeRecuperation: 68,
  longueurDuContenu: 72,
  longueurDeLaRecuperation: 80,
  sel: 88,
  nonce: 120,
  chiffre: 132,
  etiquette: 164,
});

/** Largeur du voisin d'engagement : cent quatre-vingts octets, ni plus ni moins. */
export const ENGAGEMENT_FICHIER_OCTETS = CHAMPS.etiquette + ETIQUETTE_OCTETS;

/** Largeur de l'identifiant de volume tel qu'il est écrit dans le voisin : 32 ASCII hexadécimaux. */
const IDENTIFIANT_TEXTE_OCTETS = 32;

const encodeur = new TextEncoder();
const decodeur = new TextDecoder();

/**
 * Les DONNÉES ASSOCIÉES de l'engagement, octet par octet.
 *
 * Elles sont dérivées du descripteur, jamais reçues encodées : deux encodages du même descripteur
 * divergeraient au premier champ ajouté, et c'est l'archive qui deviendrait invérifiable.
 *
 * @param {{ versionDArchive: number, identifiantVolume: string, tailleSupport: number,
 *           tailleLogique: number, tailleDeSecteur: number, versionDeRecuperation: number,
 *           longueurDuContenu: number, longueurDeLaRecuperation: number }} descripteur
 * @returns {Uint8Array}
 */
export function donneesAssocieesDeLEngagement(descripteur) {
  const champs = exigerDescripteur(descripteur);
  return concatenerListe([
    chainePrefixee(ETIQUETTE_DOMAINE_ENGAGEMENT),
    chainePrefixee(ALGORITHME),
    entierEnOctets(champs.versionDArchive, 4),
    chainePrefixee(champs.identifiantVolume),
    entierEnOctets(champs.tailleSupport, 8),
    entierEnOctets(champs.tailleLogique, 8),
    entierEnOctets(champs.tailleDeSecteur, 4),
    entierEnOctets(champs.versionDeRecuperation, 4),
    entierEnOctets(champs.longueurDuContenu, 8),
    entierEnOctets(champs.longueurDeLaRecuperation, 8),
  ]);
}

/** Valide un descripteur d'engagement. Une faute de programmation n'est pas un état de format. */
function exigerDescripteur(descripteur) {
  if (!descripteur || typeof descripteur !== "object") {
    throw new TypeError("Un descripteur d'engagement est un objet.");
  }
  if (!/^[0-9a-f]{32}$/.test(descripteur.identifiantVolume ?? "")) {
    throw new TypeError(
      `« identifiantVolume » doit être 32 hexadécimaux minuscules, reçu ${JSON.stringify(descripteur.identifiantVolume)}.`,
    );
  }
  for (const nom of [
    "versionDArchive",
    "tailleSupport",
    "tailleLogique",
    "tailleDeSecteur",
    "versionDeRecuperation",
    "longueurDuContenu",
    "longueurDeLaRecuperation",
  ]) {
    const valeur = descripteur[nom];
    if (!Number.isSafeInteger(valeur) || valeur < 0) {
      throw new TypeError(`« ${nom} » doit être un entier non négatif, reçu ${valeur}.`);
    }
  }
  return descripteur;
}

/** La clé du domaine `archive` pour ce volume et cette version d'archive. Usage unique, sel tiré. */
async function cleDuDomaineArchive({ cleMaitresse, sel, identifiantVolume, versionDArchive }) {
  return deriverCleDeDomaine({
    cleMaitresse,
    sel,
    info: encoderInfoDeDomaine({
      domaine: DOMAINES.archive,
      identifiantVolume,
      versionDeFormat: versionDArchive,
    }),
  });
}

/**
 * SCELLE l'engagement d'une archive : le clair est l'empreinte du fichier chiffré entier.
 *
 * @param {{ cleMaitresse: Uint8Array, empreinteDuContenu: Uint8Array,
 *           descripteur: object, sel?: Uint8Array, nonce?: Uint8Array }} appel
 *   `sel` et `nonce` ne sont fournis QUE par les vecteurs figés : le produit les tire.
 * @returns {Promise<{ sel: Uint8Array, nonce: Uint8Array, chiffre: Uint8Array,
 *                     etiquette: Uint8Array, descripteur: object }>}
 */
export async function scellerEngagement({
  cleMaitresse,
  empreinteDuContenu,
  descripteur,
  sel = tirerSelDeDomaine(),
  nonce = crypto.getRandomValues(new Uint8Array(NONCE_OCTETS)),
}) {
  if (
    !(empreinteDuContenu instanceof Uint8Array) ||
    empreinteDuContenu.byteLength !== EMPREINTE_OCTETS
  ) {
    throw new TypeError(
      `L'engagement scelle une empreinte SHA-256 de ${EMPREINTE_OCTETS} octets, reçu ${empreinteDuContenu?.byteLength}.`,
    );
  }
  const donneesAssociees = donneesAssocieesDeLEngagement(descripteur);
  const cle = await cleDuDomaineArchive({
    cleMaitresse,
    sel,
    identifiantVolume: descripteur.identifiantVolume,
    versionDArchive: descripteur.versionDArchive,
  });
  const brut = new Uint8Array(
    await crypto.subtle.encrypt(
      {
        name: ALGORITHME_WEBCRYPTO,
        iv: nonce,
        additionalData: donneesAssociees,
        tagLength: ETIQUETTE_BITS,
      },
      cle,
      empreinteDuContenu,
    ),
  );
  return Object.freeze({
    sel,
    nonce,
    chiffre: brut.subarray(0, brut.byteLength - ETIQUETTE_OCTETS),
    etiquette: brut.subarray(brut.byteLength - ETIQUETTE_OCTETS),
    descripteur: Object.freeze({ ...descripteur }),
  });
}

/**
 * OUVRE un engagement et rend l'empreinte qu'il scelle, ou `null` si l'étiquette ne vérifie pas.
 *
 * `null` dit « cet engagement n'ouvre pas », et c'est tout ce qu'il dit : la cause — étiquette
 * forgée, sel modifié, descripteur contredit, mauvaise clé — n'est pas distinguable, et prétendre
 * la distinguer serait un canal auxiliaire. Toute autre défaillance est propagée : une clé du
 * mauvais type ou un moteur en panne est une faute, pas un refus de sécurité.
 *
 * @returns {Promise<Uint8Array | null>} l'empreinte scellée, ou `null`
 */
export async function ouvrirEngagement({ cleMaitresse, engagement }) {
  const donneesAssociees = donneesAssocieesDeLEngagement(engagement.descripteur);
  const cle = await cleDuDomaineArchive({
    cleMaitresse,
    sel: engagement.sel,
    identifiantVolume: engagement.descripteur.identifiantVolume,
    versionDArchive: engagement.descripteur.versionDArchive,
  });
  const brut = new Uint8Array(engagement.chiffre.byteLength + engagement.etiquette.byteLength);
  brut.set(engagement.chiffre, 0);
  brut.set(engagement.etiquette, engagement.chiffre.byteLength);
  try {
    return new Uint8Array(
      await crypto.subtle.decrypt(
        {
          name: ALGORITHME_WEBCRYPTO,
          iv: engagement.nonce,
          additionalData: donneesAssociees,
          tagLength: ETIQUETTE_BITS,
        },
        cle,
        brut,
      ),
    );
  } catch (erreur) {
    if (erreur?.name === "OperationError") return null;
    throw erreur;
  }
}

/**
 * Le DESCRIPTEUR que l'archive et le volume doivent tous deux décrire, dérivé de la géométrie.
 *
 * Il vit ici plutôt que dans l'export : c'est la même arithmétique à l'écriture et à la
 * vérification, et deux copies divergeraient sans que rien ne le dise.
 */
export function descripteurDEngagement({
  versionDArchive,
  identifiantVolume,
  tailleSupport,
  tailleLogique,
  versionDeRecuperation = 0,
  longueurDuContenu,
  longueurDeLaRecuperation = 0,
}) {
  return Object.freeze({
    versionDArchive,
    identifiantVolume,
    tailleSupport,
    tailleLogique,
    tailleDeSecteur: SECTOR_SIZE,
    versionDeRecuperation,
    longueurDuContenu,
    longueurDeLaRecuperation,
  });
}

/** Forme JSON de l'engagement, telle que l'en-tête d'archive la porte. Hexadécimal minuscule. */
export function engagementEnJson(engagement) {
  return {
    algorithm: ALGORITHME,
    salt: octetsEnHex(engagement.sel),
    nonce: octetsEnHex(engagement.nonce),
    ciphertext: octetsEnHex(engagement.chiffre),
    tag: octetsEnHex(engagement.etiquette),
  };
}

/**
 * RELIT la forme JSON d'un engagement portée par l'en-tête d'archive, ou dit pourquoi elle n'en est
 * pas une. Le descripteur, lui, vient de l'en-tête et non de ce champ : l'engagement ne redéclare
 * pas la géométrie que l'archive déclare déjà, il la SCELLE.
 *
 * @returns {{ valide: boolean, raison?: string, engagement?: object }}
 */
export function engagementDepuisJson(json, descripteur) {
  if (!json || typeof json !== "object" || Array.isArray(json)) {
    return { valide: false, raison: "l'engagement déclaré n'est pas un objet." };
  }
  if (json.algorithm !== ALGORITHME) {
    return {
      valide: false,
      raison: `algorithme d'engagement non pris en charge : ${JSON.stringify(json.algorithm)}.`,
    };
  }
  const largeurs = [
    ["salt", SEL_DE_DOMAINE_OCTETS],
    ["nonce", NONCE_OCTETS],
    ["ciphertext", EMPREINTE_OCTETS],
    ["tag", ETIQUETTE_OCTETS],
  ];
  const octets = {};
  for (const [champ, largeur] of largeurs) {
    const hex = json[champ];
    if (typeof hex !== "string" || !new RegExp(`^[0-9a-f]{${largeur * 2}}$`).test(hex)) {
      return {
        valide: false,
        raison: `« ${champ} » doit être ${largeur * 2} hexadécimaux minuscules.`,
      };
    }
    octets[champ] = hexEnOctets(hex);
  }
  return {
    valide: true,
    engagement: Object.freeze({
      sel: octets.salt,
      nonce: octets.nonce,
      chiffre: octets.ciphertext,
      etiquette: octets.tag,
      descripteur: Object.freeze({ ...descripteur }),
    }),
  };
}

/**
 * EXIGE qu'une archive de volume ANTÉRIEUR à v3 déclare `engagement: null`, explicitement.
 *
 * **Ce que cette branche laisse, et il faut le dire.** Un adversaire qui réécrit le manifeste d'une
 * archive de volume v3 en manifeste v2 — en accordant `volumeSize` à la longueur du contenu, sans
 * quoi la géométrie refuse — obtient une archive sans engagement qui se restaure. Le volume qu'elle
 * pose n'est pas ouvrable pour autant, et DEUX refus le tiennent, chacun sur son chemin : la
 * restauration ne dépose AUCUN voisin d'engagement, si bien qu'une ouverture directe du volume est
 * refusée par `VAULT_STORAGE_VOLUME_SANS_RACINE` — c'est celui qui tient le fond, et il tombe avant
 * tout clair ; et sur le chemin du produit, la garde de manifeste vient en AMONT et refuse par
 * `VAULT_MANIFEST_MIGRATION_REQUIRED` avant même d'ouvrir. La première rédaction ne nommait que le
 * second (constat 8 de la revue de sécurité de la PR #184). Ce que cet adversaire gagne est un déni
 * de service qu'il avait déjà — il tenait l'archive.
 */
function exigerEngagementNul(header, manifest) {
  if (manifest.formatVersion >= FORMAT_VOLUME_V3) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.engagementAbsent,
      `Restauration refusée : cette archive v${header.archiveFormatVersion} décrit un volume au format v${manifest.formatVersion}, qui ne déclare aucun identifiant. Un engagement scelle l'identité du volume qu'il couvre ; sans elle, il ne couvre rien. Aucun octet n'est écrit sur la cible.`,
      { formatVersion: manifest.formatVersion },
    );
  }
  if (Object.hasOwn(header, "engagement") && header.engagement === null) return null;
  throw new ArchiveError(
    ARCHIVE_ERROR_CODES.engagementAbsent,
    `Restauration refusée : cette archive décrit un volume au format v${manifest.formatVersion}, qui n'est pas chiffré et ne peut donc porter aucun engagement — elle doit déclarer « engagement: null », explicitement. Un champ absent et un champ nul ne disent pas la même chose. Aucun octet n'est écrit sur la cible.`,
    { formatVersion: manifest.formatVersion },
  );
}

/**
 * ENCODE le voisin `<volume>.engagement` : cent quatre-vingts octets à largeur fixe.
 *
 * Le voisin porte le descripteur EN CLAIR — c'est ce qui permet à l'ouverture de reconstruire les
 * données associées sans rien supposer —, et l'étiquette GCM le rend infalsifiable : un adversaire
 * qui change un champ obtient un engagement qui n'ouvre pas, donc un REFUS.
 */
export function encoderFichierDEngagement(engagement) {
  const octets = new Uint8Array(ENGAGEMENT_FICHIER_OCTETS);
  const d = exigerDescripteur(engagement.descripteur);
  octets.set(ENGAGEMENT_MARQUEUR, CHAMPS.marqueur);
  octets.set(entierEnOctets(ENGAGEMENT_FICHIER_VERSION, 4), CHAMPS.versionDuFichier);
  octets.set(entierEnOctets(d.versionDArchive, 4), CHAMPS.versionDArchive);
  octets.set(encodeur.encode(d.identifiantVolume), CHAMPS.identifiantVolume);
  octets.set(entierEnOctets(d.tailleSupport, 8), CHAMPS.tailleSupport);
  octets.set(entierEnOctets(d.tailleLogique, 8), CHAMPS.tailleLogique);
  octets.set(entierEnOctets(d.tailleDeSecteur, 4), CHAMPS.tailleDeSecteur);
  octets.set(entierEnOctets(d.versionDeRecuperation, 4), CHAMPS.versionDeRecuperation);
  octets.set(entierEnOctets(d.longueurDuContenu, 8), CHAMPS.longueurDuContenu);
  octets.set(entierEnOctets(d.longueurDeLaRecuperation, 8), CHAMPS.longueurDeLaRecuperation);
  octets.set(engagement.sel, CHAMPS.sel);
  octets.set(engagement.nonce, CHAMPS.nonce);
  octets.set(engagement.chiffre, CHAMPS.chiffre);
  octets.set(engagement.etiquette, CHAMPS.etiquette);
  return octets;
}

/** Lit un entier gros-boutiste de `longueur` octets. */
function entier(octets, position, longueur) {
  let valeur = 0;
  for (let index = 0; index < longueur; index += 1)
    valeur = valeur * 256 + octets[position + index];
  return valeur;
}

/**
 * DÉCODE le voisin d'engagement, ou dit pourquoi il n'en est pas un.
 *
 * Comme `decoderEnTeteV3`, ce décodage ne LÈVE pas : il rend `{ valide, raison }`. L'appelant décide
 * du code de refus, et la distinction « absent » / « illisible » lui appartient — elle ne se juge
 * pas ici, où l'on ne sait pas si le fichier existe.
 *
 * @returns {{ valide: boolean, raison?: string, engagement?: object }}
 */
export function decoderFichierDEngagement(octets) {
  if (!(octets instanceof Uint8Array) || octets.byteLength !== ENGAGEMENT_FICHIER_OCTETS) {
    return {
      valide: false,
      raison: `un engagement fait ${ENGAGEMENT_FICHIER_OCTETS} octets, celui-ci en porte ${octets?.byteLength ?? 0}.`,
    };
  }
  for (let index = 0; index < ENGAGEMENT_MARQUEUR.byteLength; index += 1) {
    if (octets[index] !== ENGAGEMENT_MARQUEUR[index]) {
      return { valide: false, raison: "le marqueur d'engagement est absent." };
    }
  }
  const versionDuFichier = entier(octets, CHAMPS.versionDuFichier, 4);
  if (versionDuFichier !== ENGAGEMENT_FICHIER_VERSION) {
    return {
      valide: false,
      raison: `version de fichier d'engagement non prise en charge : ${versionDuFichier}.`,
    };
  }
  const identifiantVolume = decodeur.decode(
    octets.subarray(CHAMPS.identifiantVolume, CHAMPS.identifiantVolume + IDENTIFIANT_TEXTE_OCTETS),
  );
  if (!/^[0-9a-f]{32}$/.test(identifiantVolume)) {
    return {
      valide: false,
      raison: "l'identifiant de volume n'est pas 32 hexadécimaux minuscules.",
    };
  }
  return {
    valide: true,
    engagement: Object.freeze({
      sel: octets.slice(CHAMPS.sel, CHAMPS.sel + SEL_DE_DOMAINE_OCTETS),
      nonce: octets.slice(CHAMPS.nonce, CHAMPS.nonce + NONCE_OCTETS),
      chiffre: octets.slice(CHAMPS.chiffre, CHAMPS.chiffre + EMPREINTE_OCTETS),
      etiquette: octets.slice(CHAMPS.etiquette, CHAMPS.etiquette + ETIQUETTE_OCTETS),
      descripteur: Object.freeze({
        versionDArchive: entier(octets, CHAMPS.versionDArchive, 4),
        identifiantVolume,
        tailleSupport: entier(octets, CHAMPS.tailleSupport, 8),
        tailleLogique: entier(octets, CHAMPS.tailleLogique, 8),
        tailleDeSecteur: entier(octets, CHAMPS.tailleDeSecteur, 4),
        versionDeRecuperation: entier(octets, CHAMPS.versionDeRecuperation, 4),
        longueurDuContenu: entier(octets, CHAMPS.longueurDuContenu, 8),
        longueurDeLaRecuperation: entier(octets, CHAMPS.longueurDeLaRecuperation, 8),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------------------------
// L'ENGAGEMENT VU DEPUIS LE CONTENEUR : ce que l'export scelle, ce que la lecture relit.
//
// Ces deux gestes vivaient dans `volume-export.mjs`, que #181 a fait franchir le plafond de
// 800 lignes. Ils sont ici parce qu'ils appartiennent à l'ENGAGEMENT : ils décident quel
// descripteur il scelle et sous quelle identité, et les laisser dans le codec d'archive aurait
// mis cette décision-là dans le module qui compte des offsets.
// ---------------------------------------------------------------------------------------------

/**
 * SCELLE l'engagement de l'archive (#181, ADR 0033).
 *
 * Le geste vit ici, dans l'export, parce que c'est le seul endroit du chemin d'archive qui tient à
 * la fois la clé maîtresse et l'empreinte du contenu. Il EXIGE les deux : une archive v3 sans
 * engagement n'existe pas, et un export qui en produirait une refabriquerait le défaut que #181
 * ferme.
 *
 * L'identifiant de volume vient du MANIFESTE, jamais du fichier : c'est lui que la restauration
 * confronte à l'en-tête v3 du contenu (`assertIdentiteDeLArchive`), si bien que les deux sources
 * sont déjà accordées quand l'engagement est vérifié.
 */
export async function scellerLEngagementDeLArchive({
  base,
  cle,
  digest,
  contentLength,
  recovery,
  versionDArchive,
  fige,
}) {
  const identifiantVolume = base.volume?.id ?? null;
  // Un volume ANTÉRIEUR à v3 n'est pas chiffré : il n'a ni clé, ni identifiant. Son archive ne peut
  // donc porter aucun engagement, et l'exiger rendrait la SAUVEGARDE — donc la migration v2 → v3,
  // qui l'exige avant de muter (ADR 0011) — impossible. Elle porte `null`, EXPLICITE : un champ
  // absent et un champ nul ne disent pas la même chose, exactement comme pour `recovery`.
  if (identifiantVolume === null) return exigerVolumeAnterieur(base);
  if (!(cle instanceof Uint8Array)) {
    throw new TypeError(
      "writeArchive attend « cle » : la clé de volume, sous laquelle l'engagement de l'archive est scellé (#181). Une archive de volume v3 sans engagement n'existe pas.",
    );
  }
  return scellerEngagement({
    ...(fige ?? {}),
    cleMaitresse: cle,
    empreinteDuContenu: hexEnOctets(digest),
    descripteur: descripteurDEngagement({
      versionDArchive,
      identifiantVolume,
      tailleSupport: contentLength,
      tailleLogique: base.geometry.volumeSize,
      versionDeRecuperation: recovery === null ? 0 : recovery.descripteur.envelopeVersion,
      longueurDuContenu: contentLength,
      longueurDeLaRecuperation: recovery === null ? 0 : recovery.octets.byteLength,
    }),
  });
}

/**
 * REFUSE un manifeste v3 sans identifiant, et rend `null` pour un volume antérieur.
 *
 * Le refus est impossible à atteindre par #10 — un manifeste v3 déclare toujours son bloc `volume`
 * — et il est écrit malgré tout : la garde qui ne vaut que par une propriété d'un autre module est
 * exactement celle qu'une tranche future défait sans le voir.
 */
function exigerVolumeAnterieur(base) {
  if (base.formatVersion >= FORMAT_VOLUME_V3) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.engagementAbsent,
      `Export refusé : le manifeste décrit un volume au format v${base.formatVersion}, qui ne déclare aucun identifiant. Un engagement d'archive scelle l'identité du volume qu'il couvre ; sans elle, il ne couvre rien.`,
      { formatVersion: base.formatVersion },
    );
  }
  return null;
}

/**
 * LIT l'engagement que l'en-tête déclare, et reconstruit le DESCRIPTEUR qu'il scelle.
 *
 * Le descripteur n'est jamais relu du champ `engagement` : il est DÉRIVÉ de ce que l'archive
 * déclare par ailleurs — version d'archive, identité et géométrie du manifeste, version de
 * l'enveloppe embarquée, longueurs des sections — et toutes ces valeurs viennent d'être accordées
 * entre elles. Un adversaire qui touche à l'une d'elles change les données associées, donc obtient
 * un engagement qui n'ouvrira pas. Le laisser se déclarer lui-même aurait produit un engagement qui
 * s'accorde toujours à lui-même, c'est-à-dire à rien.
 *
 * Un volume d'un format ANTÉRIEUR à v3 ne déclare aucun identifiant : il n'a pas d'archive v3, et
 * le refus le dit plutôt que de sceller sous une identité vide.
 */
export function lireLEngagementDeLArchive({ header, manifest, contentLength, recovery }) {
  const identifiantVolume = manifest.volume?.id ?? null;
  if (identifiantVolume === null) return exigerEngagementNul(header, manifest);
  if (!Object.hasOwn(header, "engagement")) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.engagementAbsent,
      `Restauration refusée : cette archive v${header.archiveFormatVersion} ne déclare aucun engagement. L'engagement est ce qui rend une archive AUTHENTIFIÉE ; une archive qui n'en porte pas n'atteste que contre l'accident, et c'est exactement le défaut de #181. Aucun octet n'est écrit sur la cible.`,
      { archiveFormatVersion: header.archiveFormatVersion },
    );
  }
  const descripteur = descripteurDEngagement({
    versionDArchive: header.archiveFormatVersion,
    identifiantVolume,
    tailleSupport: contentLength,
    tailleLogique: manifest.geometry.volumeSize,
    versionDeRecuperation: recovery === null ? 0 : recovery.envelopeVersion,
    longueurDuContenu: contentLength,
    longueurDeLaRecuperation: recovery === null ? 0 : recovery.length,
  });
  const lu = engagementDepuisJson(header.engagement, descripteur);
  if (!lu.valide) {
    throw new ArchiveError(
      ARCHIVE_ERROR_CODES.engagementAbsent,
      `Restauration refusée : l'engagement déclaré par cette archive est illisible — ${lu.raison} Aucun octet n'est écrit sur la cible.`,
      { archiveFormatVersion: header.archiveFormatVersion },
    );
  }
  return lu.engagement;
}
