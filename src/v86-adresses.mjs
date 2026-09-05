// L'ADRESSE d'un artefact v86 est DÉRIVÉE de son empreinte, et de rien d'autre (#123, ADR 0003).
//
// L'ADR 0003 épingle les cinq artefacts par SHA-256 dans `vendor/v86/MANIFEST.json`. Tant que ce
// SHA-256 ne vivait que dans le manifeste, `/vendor/v86/artefacts/v86.wasm` rendait d'autres octets
// à la MÊME adresse après une montée de version : c'est le fait 2 de l'ADR 0023, et c'est lui qui
// interdisait `immutable`, dont la sémantique est « ces octets ne changeront jamais à cette URL ».
//
// Ce module lève la contradiction en portant l'empreinte DANS le nom. Il est la seule définition de
// la forme d'adresse — dépôt, serveur de développement, publication et navigateur en dérivent tous,
// et `tests/unit/v86-adresses.test.mjs` refuse qu'une adresse d'artefact soit écrite en dur
// ailleurs.
//
// Il est PUBLIÉ (`tools/publier-arborescences.mjs`) : un chargeur de la coquille doit pouvoir
// dériver l'adresse sans emporter d'outil du dépôt, et c'est la « dérivation publiée du manifeste »
// que l'issue #123 autorise en face du manifeste lui-même.
//
// Il ne calcule AUCUNE empreinte : celles des artefacts sont des données du manifeste, et celle du
// manifeste est calculée par qui le publie. Un module de dérivation qui hacherait lui-même pourrait
// rendre une adresse que personne n'a épinglée.

/** Préfixe d'URL sous lequel les artefacts ADRESSÉS PAR EMPREINTE sont servis. */
export const PREFIXE_ADRESSES_V86 = "/vendor/v86/artefacts/";

/**
 * Adresse du manifeste d'épinglage. Elle NE nomme PAS son empreinte, et c'est la décision : c'est
 * lui l'indirection, celui qu'on interroge pour apprendre les autres adresses. Une adresse stable
 * revalidée (`no-cache`) est ce qui permet à toutes les autres d'être immuables.
 */
export const ADRESSE_MANIFESTE_V86 = "/vendor/v86/MANIFEST.json";

/**
 * Nombre de caractères hexadécimaux du SHA-256 inscrits dans le nom, soit 64 bits.
 *
 * Ce n'est pas une frontière de sécurité, et il ne faut pas le lire comme telle : l'empreinte qui
 * FAIT FOI est celle du manifeste, sur ses 256 bits, et c'est elle que `npm run vm:check` et
 * `verifierEpinglageV86` confrontent aux octets. Ce préfixe ne sert qu'à séparer deux versions d'un
 * même artefact dans l'espace des URL — cinq artefacts, quelques dizaines de versions sur la vie du
 * projet —, et sur cette population 64 bits rendent une collision accidentelle indiscernable de
 * zéro. Un adversaire qui saurait forger une collision tronquée n'y gagnerait rien : il lui
 * faudrait encore satisfaire l'empreinte PLEINE, qui est vérifiée là où les octets sont lus.
 */
export const LONGUEUR_EMPREINTE_DANS_LADRESSE = 16;

/** Nom de la copie du manifeste ADRESSÉE PAR EMPREINTE, publiée à côté des octets qu'elle nomme. */
const BASE_MANIFESTE_EPINGLE = "MANIFEST";
const EXTENSION_MANIFESTE_EPINGLE = ".json";

/** Empreinte hexadécimale pleine → le préfixe qui entre dans un nom d'adresse. */
export function empreinteDansLAdresse(sha256) {
  if (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(
      `Empreinte SHA-256 attendue en 64 caractères hexadécimaux minuscules : « ${sha256} ».`,
    );
  }
  return sha256.slice(0, LONGUEUR_EMPREINTE_DANS_LADRESSE);
}

/**
 * Découpe un nom d'artefact en base et extension, sur le DERNIER point.
 *
 * L'extension est conservée telle quelle, et ce n'est pas cosmétique : c'est elle qui décide du
 * `Content-Type` servi (`.wasm` → `application/wasm`, `.mjs` → module ES). Une forme d'adresse qui
 * la perdrait ferait refuser le module par le moteur et l'instanciation WebAssembly par le
 * navigateur, sans que rien dans la chaîne de publication ne le dise.
 */
function decouper(nom) {
  const point = nom.lastIndexOf(".");
  if (point <= 0) throw new Error(`Nom d'artefact sans extension : « ${nom} ».`);
  return { base: nom.slice(0, point), extension: nom.slice(point) };
}

/**
 * Nom de fichier d'un artefact, empreinte comprise : `v86.wasm` + `8a96…` → `v86-8a969d64….wasm`.
 *
 * La forme retenue est un SUFFIXE, pas un répertoire `<empreinte>/`. Trois raisons, écrites dans
 * l'amendement de l'ADR 0023 :
 *  - à longueur d'URL ÉGALE — dix-sept caractères de plus dans les deux cas —, le suffixe garde le
 *    nom de l'artefact en tête ;
 *  - l'inventaire de l'ADR 0017 trie ses chemins : par suffixe, les deux versions d'un artefact se
 *    suivent et un ré-épinglage se lit sur deux lignes voisines ; par répertoire, elles sont
 *    dispersées au hasard des empreintes ;
 *  - l'empreinte lie exactement UN fichier, ce que `immutable` promet. Un répertoire nommé par une
 *    empreinte suggère un espace de noms partagé, et rien n'y empêcherait un second fichier d'être
 *    servi un an sous une adresse qui ne décrit pas ses octets.
 */
export function nomAdresse(nom, sha256) {
  const { base, extension } = decouper(nom);
  return `${base}-${empreinteDansLAdresse(sha256)}${extension}`;
}

/** Adresse HTTP complète d'un artefact. */
export function adresseDe(nom, sha256) {
  return `${PREFIXE_ADRESSES_V86}${nomAdresse(nom, sha256)}`;
}

/** Nom de fichier de la copie du manifeste adressée par SA propre empreinte. */
export function nomAdresseDuManifeste(sha256) {
  return `${BASE_MANIFESTE_EPINGLE}-${empreinteDansLAdresse(sha256)}${EXTENSION_MANIFESTE_EPINGLE}`;
}

/** Adresse HTTP de cette copie. */
export function adresseDuManifesteEpingle(sha256) {
  return `${PREFIXE_ADRESSES_V86}${nomAdresseDuManifeste(sha256)}`;
}

/**
 * Empreinte tronquée lue DANS un nom de fichier, ou `null` si le nom n'en porte pas.
 *
 * C'est le sens inverse de `nomAdresse`, et c'est lui qui rend le cliquet MESURABLE : « aucun
 * chemin servi sous le préfixe immuable n'est là sans nommer son empreinte » se vérifie en relisant
 * le nom, jamais en faisant confiance à qui l'a écrit.
 */
export function empreinteDeLAdresse(nomDeFichier) {
  const trouve = /-([0-9a-f]{16})\.[^./]+$/.exec(nomDeFichier);
  return trouve === null ? null : trouve[1];
}

/** Noms de fichiers d'un manifeste, indexés par le nom d'artefact que l'ADR 0003 lui donne. */
export function nomsDuManifeste(manifeste) {
  return new Map(manifeste.artifacts.map(({ name, sha256 }) => [name, nomAdresse(name, sha256)]));
}

/** Adresses HTTP d'un manifeste, mêmes clés. */
export function adressesDuManifeste(manifeste) {
  return new Map(manifeste.artifacts.map(({ name, sha256 }) => [name, adresseDe(name, sha256)]));
}

/**
 * Charge le manifeste d'épinglage et rend les adresses qu'il dicte — la porte du NAVIGATEUR.
 *
 * `cache: "no-store"` sur cette requête et sur elle seule : le manifeste est l'indirection, et une
 * copie gardée par le moteur désignerait des adresses qui ne sont plus servies. Les artefacts, eux,
 * sont demandés sans consigne — c'est tout l'objet de #123 que le cache les garde.
 */
export async function chargerAdressesV86({ fetch: recuperer = globalThis.fetch } = {}) {
  const reponse = await recuperer(ADRESSE_MANIFESTE_V86, { cache: "no-store" });
  if (!reponse.ok) {
    throw new Error(
      `Manifeste d'épinglage v86 indisponible (${reponse.status}) à ${ADRESSE_MANIFESTE_V86}. ` +
        `Exécuter « npm run vm:fetch ».`,
    );
  }
  const manifeste = await reponse.json();
  return { manifeste, adresses: adressesDuManifeste(manifeste) };
}

/**
 * Adresse d'un artefact nommé, ou un refus qui NOMME ce qui manque.
 *
 * Un `Map.get` rendrait `undefined`, et l'appelant construirait une URL terminée par « undefined »
 * dont le 404 enverrait chercher un artefact absent là où c'est le NOM demandé qui est faux.
 */
export function exigerAdresse(adresses, nom) {
  const adresse = adresses.get(nom);
  if (adresse === undefined) {
    throw new Error(
      `Artefact « ${nom} » absent du manifeste d'épinglage. Artefacts déclarés : ` +
        `${[...adresses.keys()].join(", ")}.`,
    );
  }
  return adresse;
}

// --- Vérification d'empreinte AU CHARGEMENT (#123, constat 2 de la revue de sécurité) -------------
//
// L'adresse porte SEIZE caractères hexadécimaux ; le manifeste en épingle SOIXANTE-QUATRE. Vérifier
// à la lecture, c'est confronter les octets reçus aux 256 bits — ce que l'adresse seule ne fait pas.
//
// Ce que cette vérification attrape, et que celle de la PUBLICATION n'attrape pas, c'est
// l'ACCIDENT : un cache qui garde une version d'un artefact à côté d'un manifeste d'une autre, un
// intermédiaire qui touche le `.wasm` sans toucher au `.mjs`, un dépôt partiel qui n'a poussé
// qu'une moitié de l'arbre, un octet retourné en chemin. Un cache d'un an rend ces accidents PLUS
// probables, pas moins : ce qui est corrompu une fois est gardé pour un an, sans revalidation, et
// `immutable` supprime jusqu'au rechargement forcé comme geste de récupération.
//
// Ce qu'elle n'attrape PAS, et il faut le dire : l'empreinte attendue vient du manifeste servi par
// la MÊME origine. Une origine qui ment aux deux du même geste passe. Ce n'est pas une défense
// contre l'hébergeur — celle-là est `verifierEpinglageV86`, sur l'arbre construit à partir d'un
// commit, avant qu'il ne parte. C'est le raisonnement que `verifierEpinglageArgon2` tient déjà pour
// l'artefact voisin, et le code du dépôt le suit là-bas depuis #22 : les deux vérifications
// couvrent le même octet à deux moments, et aucune ne remplace l'autre.

/** Code du refus typé, sur le modèle de `src/vm/runtime-errors.mjs`. */
export const CODE_EMPREINTE_V86 = "VAULT_V86_EMPREINTE";

/**
 * Refus typé : un code stable, un message français, un contexte sérialisable.
 *
 * Il est défini ICI plutôt qu'ajouté à `RUNTIME_ERROR_CODES`, pour la raison qui a fait définir
 * `argon2Indisponible` dans son propre module : c'est une erreur de PROVENANCE d'artefact vendu, pas
 * une erreur du runtime — elle se produit avant qu'il existe, et elle survit à sa réécriture.
 */
export class ErreurEmpreinteV86 extends Error {
  constructor(message, contexte) {
    super(message);
    this.name = "ErreurEmpreinteV86";
    this.code = CODE_EMPREINTE_V86;
    this.contexte = Object.freeze({ ...contexte });
  }

  toJSON() {
    return { code: this.code, message: this.message, contexte: this.contexte };
  }
}

/** Empreinte SHA-256 hexadécimale d'octets, par la primitive du moteur. */
export async function empreinteSha256Hex(octets) {
  const condensat = new Uint8Array(await crypto.subtle.digest("SHA-256", octets));
  let hexadecimal = "";
  for (const octet of condensat) hexadecimal += octet.toString(16).padStart(2, "0");
  return hexadecimal;
}

/**
 * Confronte des octets reçus au descripteur que l'ADR 0003 épingle, ou REFUSE.
 *
 * La taille est vérifiée d'abord, et ce n'est pas une optimisation : une réponse tronquée est le
 * mode de panne le plus banal d'un réseau, et son diagnostic — « 1 048 576 octets au lieu de
 * 2 096 474 » — est immédiatement actionnable là où une empreinte qui ne correspond pas ne dit pas
 * POURQUOI. Elle est ensuite redondante avec l'empreinte, et c'est très bien.
 *
 * @param {Uint8Array} octets
 * @param {{ name: string, bytes: number, sha256: string }} artefact descripteur du manifeste
 * @param {string} adresse adresse à laquelle ces octets ont été reçus, pour le diagnostic
 * @throws {ErreurEmpreinteV86}
 */
export async function verifierOctetsV86(octets, artefact, adresse) {
  if (typeof artefact?.bytes === "number" && octets.byteLength !== artefact.bytes) {
    throw new ErreurEmpreinteV86(
      `L'artefact ${artefact.name} reçu à ${adresse} fait ${octets.byteLength} octets au lieu des ` +
        `${artefact.bytes} qu'épingle vendor/v86/MANIFEST.json : réponse tronquée, ou octets d'une ` +
        `autre version.`,
      { artefact: artefact.name, adresse, attendu: artefact.bytes, mesure: octets.byteLength },
    );
  }
  const mesure = await empreinteSha256Hex(octets);
  if (mesure !== artefact.sha256) {
    throw new ErreurEmpreinteV86(
      `L'artefact ${artefact.name} reçu à ${adresse} n'a pas l'empreinte SHA-256 qu'épingle ` +
        `vendor/v86/MANIFEST.json. L'adresse en nomme les seize premiers caractères ; ce sont les ` +
        `soixante-quatre qui font foi.`,
      { artefact: artefact.name, adresse, attendu: artefact.sha256, mesure },
    );
  }
  return octets;
}

/**
 * Le descripteur que le manifeste sert à une ADRESSE, ou `null` si l'adresse n'en relève pas.
 *
 * Le sens inverse de la dérivation, et il a un usage précis : un chargeur qui reçoit des URL toutes
 * faites — le banc de l'image de référence en reçoit sept, dont deux seulement sont des artefacts
 * v86 — doit pouvoir dire lesquelles il sait vérifier, sans deviner. Ce qui ne relève pas de ce
 * manifeste n'est pas vérifié ici, et ce n'est pas un silence : c'est un autre épinglage.
 */
export function artefactALAdresse(manifeste, adresse) {
  return (
    manifeste.artifacts.find((artefact) => adresseDe(artefact.name, artefact.sha256) === adresse) ??
    null
  );
}

/**
 * Récupère un artefact v86 À SON ADRESSE et refuse si ses 256 bits ne sont pas ceux du manifeste.
 *
 * C'est la porte unique du chargement : les trois chargeurs de bancs l'empruntent, et l'épreuve
 * d'inspection de source exige qu'ils le fassent. Aucun `options.cache` n'est imposé — un banc qui
 * MESURE des transferts pose `no-store`, un chargeur de production ne pose rien et laisse le cache
 * d'un an travailler.
 *
 * @param {string} nom nom d'artefact de l'ADR 0003, « v86.wasm » par exemple
 * @param {{ manifeste: object, adresses: Map<string, string>, fetch?: typeof globalThis.fetch,
 *           requete?: RequestInit }} contexte
 */
export async function recupererArtefactV86(
  nom,
  { manifeste, adresses, fetch: recuperer = globalThis.fetch, requete = {} },
) {
  const adresse = exigerAdresse(adresses, nom);
  const reponse = await recuperer(adresse, requete);
  if (!reponse.ok) {
    throw new ErreurEmpreinteV86(
      `L'artefact ${nom} est indisponible à ${adresse} (${reponse.status}). Exécuter ` +
        `« npm run vm:fetch », ou vérifier que l'arbre publié porte bien cette adresse.`,
      { artefact: nom, adresse, statut: reponse.status },
    );
  }
  const octets = new Uint8Array(await reponse.arrayBuffer());
  const artefact = manifeste.artifacts.find((candidat) => candidat.name === nom);
  return verifierOctetsV86(octets, artefact, adresse);
}
