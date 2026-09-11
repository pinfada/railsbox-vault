// La DÉRIVATION PAR DOMAINE sous la clé maîtresse (ADR 0033, décisions 1, 3 et 6 ; #182, #181).
//
// L'ADR 0033 décide que la DEK devient une clé MAÎTRESSE : plus rien n'est scellé sous elle
// directement, chaque domaine scelle sous une clé AEAD de 256 bits qui en descend par HKDF-SHA-256.
// Ce module est le seul endroit qui fabrique une telle clé.
//
// **Les SIX domaines de l'ADR 0033, au complet depuis T2b.** `archive` est venu avec #181 ;
// `volume`, `journal` et `instantane` avec le format de volume v4 (T2a) ; `enveloppe` et
// `recuperation` avec la page d'enveloppe v2 (T2b). Plus aucun domaine n'est en attente, et plus
// aucun artefact du produit n'est scellé sous la DEK elle-même.
//
// ## Ce que l'info encode, et pourquoi chaque champ y est
//
//     info = LP("railsbox-vault/derivation-de-domaine/v1")   étiquette du SCHÉMA de dérivation
//          ‖ LP(domaine)                                      « volume », « journal », …
//          ‖ LP(identifiantVolume)                            32 hexadécimaux MINUSCULES
//          ‖ U32BE(versionDeFormatDuDomaine)                  la version du format que ce domaine scelle
//          ‖ LP("aes-256-gcm")                                l'algorithme, comme dans les données associées
//
// Les champs sont PRÉFIXÉS DE LEUR LONGUEUR, jamais joints par un séparateur : une concaténation non
// préfixée n'est injective que tant que les champs ne contiennent pas le séparateur, c'est-à-dire
// par une propriété du CONTENU et non de l'ENCODAGE. Le dépôt refuse ce genre de sûreté depuis #18,
// et ce qui vaut pour l'identité d'un bloc vaut a fortiori pour l'identité d'une CLÉ.
//
// **La version est celle du format DU DOMAINE, pas celle du volume.** Un même volume a plusieurs
// formats sous lui : le volume v4, le fichier d'instantané v2, l'archive v3. Lier chaque clé à la
// version du volume ferait bouger la clé d'instantané à chaque version de volume.
//
// ## Le sel porte l'unicité, l'info porte la séparation
//
// Deux régimes, et un seul critère : _la clé est-elle réemployée ?_
//
//  - **domaine à COMPTEUR** (`volume`, `journal`) — la clé DOIT être la même entre deux gestes, sans
//    quoi un secteur écrit hier ne se relirait pas aujourd'hui. **Sel = chaîne VIDE**, zéro octet.
//    Le § 2.2 de la RFC 5869 dit ce que cela vaut : un sel absent est traité comme `HashLen` octets
//    nuls, et l'extraction reste correcte parce que l'IKM — la DEK — est déjà uniformément aléatoire
//    sur 256 bits. Un sel constant n'aurait rien ajouté, et aurait ajouté un champ à authentifier.
//    Le cas 3 de la RFC 5869 est précisément le vecteur d'un sel vide : la dérivation reste
//    VECTORISABLE sans une ligne du produit, ce que `tools/verifier-vecteurs.mjs` exige ;
//  - **domaine à USAGE UNIQUE** (`instantane`, `enveloppe`, `archive`, `recuperation`) — l'artefact
//    est RÉÉCRIT ENTIER à chaque geste et ne porte qu'UN scellement. Son sel est TIRÉ — trente-deux
//    octets de `crypto.getRandomValues` — et écrit EN CLAIR dedans. Une clé neuve par artefact, un
//    scellement sous cette clé, et aucun compteur.
//
// **Le régime est une propriété du DOMAINE, et il est vérifié ici.** Un sel de trente-deux octets
// présenté pour le domaine `volume` rendrait une clé fraîche à chaque ouverture, c'est-à-dire un
// volume illisible ; un sel vide présenté pour `archive` rendrait la même clé pour toutes les
// archives d'un volume, c'est-à-dire le régime que la décision 4 refuse. Les deux sont des fautes
// d'appelant, et les deux sont refusées AVANT qu'aucun matériau ne soit importé.
//
// **Le sel en clair n'est pas authentifié, et il n'a pas à l'être.** Un adversaire qui le change
// obtient une clé différente, donc une ouverture qui échoue : le sel se protège par sa conséquence,
// exactement comme le nonce.

import { chainePrefixee, concatenerListe, entierEnOctets } from "../format-chiffre/octets.mjs";
import { ALGORITHME, CLE_OCTETS } from "../format-chiffre/identite-logique.mjs";
import { parametresRefuses } from "./derivation-errors.mjs";

/** Étiquette du SCHÉMA de dérivation. Elle sépare cette hiérarchie de toute autre sous la même DEK. */
export const ETIQUETTE_SCHEMA_DE_DOMAINE = "railsbox-vault/derivation-de-domaine/v1";

/**
 * Les SIX domaines de l'ADR 0033, décision 2. La liste est close : elle n'attend plus rien.
 *
 * `enveloppe` et `recuperation` produisent tous deux une PAGE d'enveloppe, et c'est pourquoi ils
 * partagent une version de format — la 2 — sans partager de clé : l'info porte le nom du domaine,
 * et deux noms distincts tirent deux clés distinctes. La page dit dans son en-tête lequel des deux
 * a scellé sa racine, sans quoi la page qu'une archive emporte cesserait d'être lisible une fois
 * restaurée en `<volume>.cles` (ADR 0027).
 */
export const DOMAINES = Object.freeze({
  volume: "volume",
  journal: "journal",
  instantane: "instantane",
  enveloppe: "enveloppe",
  archive: "archive",
  recuperation: "recuperation",
});

/** Les deux régimes de clé de l'ADR 0033, décision 3. Un domaine en a UN, et il ne change pas. */
export const REGIMES = Object.freeze({ compteur: "compteur", usageUnique: "usage-unique" });

/**
 * Le régime de CHAQUE domaine. C'est ce qui décide de la largeur du sel, et rien d'autre ne la
 * décide : un appelant ne choisit pas d'être à usage unique, son domaine l'est ou ne l'est pas.
 */
export const REGIMES_DE_DOMAINE = Object.freeze({
  [DOMAINES.volume]: REGIMES.compteur,
  [DOMAINES.journal]: REGIMES.compteur,
  [DOMAINES.instantane]: REGIMES.usageUnique,
  [DOMAINES.enveloppe]: REGIMES.usageUnique,
  [DOMAINES.archive]: REGIMES.usageUnique,
  [DOMAINES.recuperation]: REGIMES.usageUnique,
});

/**
 * Version du format que chaque domaine scelle, telle que l'ADR 0033, décision 3, la tabule.
 *
 * Elle est PUBLIÉE ici et non devinée par l'appelant : le domaine `volume` et le domaine `journal`
 * suivent la version du format de VOLUME — donc 4 —, tandis que l'instantané et l'archive ont la
 * leur. Un appelant qui passerait la version du volume pour l'archive tirerait une clé neuve à
 * chaque version de volume, et les archives déjà écrites cesseraient de s'ouvrir.
 */
export const VERSIONS_DE_FORMAT_DE_DOMAINE = Object.freeze({
  [DOMAINES.volume]: 4,
  [DOMAINES.journal]: 4,
  [DOMAINES.instantane]: 2,
  [DOMAINES.enveloppe]: 2,
  [DOMAINES.archive]: 3,
  [DOMAINES.recuperation]: 2,
});

/** Largeur du sel d'un domaine à USAGE UNIQUE : trente-deux octets tirés, écrits en clair. */
export const SEL_DE_DOMAINE_OCTETS = 32;

/** Le sel d'un domaine à COMPTEUR : la chaîne VIDE, zéro octet (RFC 5869, § 2.2). */
export const SEL_VIDE = Object.freeze(new Uint8Array(0));

/** Largeur de la clé maîtresse et de chaque clé dérivée. Celle de l'ADR 0015, jamais redécidée ici. */
export const CLE_DE_DOMAINE_OCTETS = CLE_OCTETS;

const DOMAINES_CONNUS = new Set(Object.values(DOMAINES));

function exigerDomaine(domaine) {
  if (!DOMAINES_CONNUS.has(domaine)) {
    throw parametresRefuses(`Domaine de dérivation inconnu : ${JSON.stringify(domaine)}.`, {
      champ: "domaine",
      connus: [...DOMAINES_CONNUS],
    });
  }
  return domaine;
}

/** Exige une chaîne de trente-deux hexadécimaux MINUSCULES : l'identifiant d'un volume. */
function identifiantDeVolume(valeur) {
  if (typeof valeur !== "string" || !/^[0-9a-f]{32}$/.test(valeur)) {
    throw parametresRefuses(
      `« identifiantVolume » doit être 32 hexadécimaux minuscules, reçu ${JSON.stringify(valeur)}.`,
      { champ: "identifiantVolume" },
    );
  }
  return valeur;
}

/**
 * L'INFO que HKDF reçoit pour un domaine, octet par octet.
 *
 * Elle est calculée AVANT qu'aucune clé n'existe, comme `infoDeLEmplacement` de l'ADR 0021 : un
 * identifiant malformé doit faire refuser la dérivation avant qu'un matériau ne soit importé.
 *
 * @param {{ domaine: string, identifiantVolume: string, versionDeFormat: number }} appel
 *   `versionDeFormat` est la version du format DU DOMAINE, jamais celle du volume.
 * @returns {Uint8Array}
 */
export function encoderInfoDeDomaine({ domaine, identifiantVolume, versionDeFormat }) {
  exigerDomaine(domaine);
  identifiantDeVolume(identifiantVolume);
  if (!Number.isSafeInteger(versionDeFormat) || versionDeFormat < 0) {
    throw parametresRefuses(
      `« versionDeFormat » doit être un entier non négatif, reçu ${JSON.stringify(versionDeFormat)}.`,
      { champ: "versionDeFormat" },
    );
  }
  return concatenerListe([
    chainePrefixee(ETIQUETTE_SCHEMA_DE_DOMAINE),
    chainePrefixee(domaine),
    chainePrefixee(identifiantVolume),
    entierEnOctets(versionDeFormat, 4),
    chainePrefixee(ALGORITHME),
  ]);
}

/** TIRE le sel d'un domaine à usage unique. Trente-deux octets, écrits en clair dans l'artefact. */
export function tirerSelDeDomaine() {
  return crypto.getRandomValues(new Uint8Array(SEL_DE_DOMAINE_OCTETS));
}

/**
 * Le sel que ce domaine EXIGE : vide s'il est à compteur, tiré s'il est à usage unique.
 *
 * Une seule fonction pour les deux régimes, et c'est le point : un appelant ne choisit pas le sel de
 * son domaine, il le demande. Le cas par cas était l'endroit où la règle se serait perdue.
 */
export function selDuDomaine(domaine) {
  return REGIMES_DE_DOMAINE[exigerDomaine(domaine)] === REGIMES.compteur
    ? SEL_VIDE
    : tirerSelDeDomaine();
}

/** Largeur de sel qu'un domaine admet, selon son régime. Zéro ou trente-deux, jamais autre chose. */
function largeurDeSelAttendue(domaine) {
  return REGIMES_DE_DOMAINE[domaine] === REGIMES.compteur ? 0 : SEL_DE_DOMAINE_OCTETS;
}

/**
 * IMPORTE la clé maîtresse en MATÉRIAU HKDF, et c'est la décision 6 de l'ADR 0033.
 *
 * ```js
 * // Avant la v4 : la DEK était importée en clé AES-GCM, et « encrypt » lui était ouvert.
 * importKey("raw", dek, "AES-GCM", false, ["encrypt", "decrypt"]);
 * // En v4 : la DEK est importée en matériau HKDF, et « encrypt » n'existe pas pour elle.
 * importKey("raw", dek, "HKDF", false, ["deriveKey"]);
 * ```
 *
 * Une `CryptoKey` dont les usages ne portent pas `encrypt` fait REJETER `crypto.subtle.encrypt` par
 * la spécification WebCrypto elle-même. Au vocabulaire de la décision 7 de l'ADR 0021, c'est un
 * **GARANTI** et non un « fait, non garanti » : un appelant distrait obtient une exception, pas un
 * chiffré. `tests/unit/vm-hierarchie-de-cles.test.mjs` l'exécute plutôt que de l'affirmer, et les
 * trois moteurs le rejouent par `tests/browser/hierarchie-de-cles-frontiere.spec.mjs`.
 *
 * @param {Uint8Array} cleMaitresse exactement `CLE_DE_DOMAINE_OCTETS` octets
 * @returns {Promise<CryptoKey>} matériau HKDF non extractible, `deriveKey` seul
 */
export async function importerMateriauMaitre(cleMaitresse) {
  if (!(cleMaitresse instanceof Uint8Array) || cleMaitresse.byteLength !== CLE_DE_DOMAINE_OCTETS) {
    throw parametresRefuses(
      `la clé maîtresse fait ${cleMaitresse?.byteLength ?? "une largeur inconnue"} octet(s) au lieu de ${CLE_DE_DOMAINE_OCTETS}.`,
      { attendu: CLE_DE_DOMAINE_OCTETS },
    );
  }
  return crypto.subtle.importKey("raw", cleMaitresse, "HKDF", false, ["deriveKey"]);
}

/**
 * DÉRIVE la clé d'un domaine : HKDF-SHA-256 sur la clé maîtresse, puis import AES-GCM **non
 * extractible**.
 *
 * Deux appels de WebCrypto seulement — pas de `deriveBits` suivi d'un `importKey`, qui ferait
 * exister les octets de la clé dans le tas JavaScript pour rien.
 *
 * @param {{ cleMaitresse: Uint8Array | CryptoKey, domaine: string, sel: Uint8Array,
 *           info: Uint8Array }} appel
 *   `cleMaitresse` est soit les octets de la DEK — importés ici en matériau HKDF —, soit un matériau
 *   DÉJÀ importé : une session qui dérive plusieurs domaines l'importe UNE fois et ne garde jamais
 *   les octets. `domaine` décide de la largeur de sel admise, ET il est RECOUPÉ avec l'`info`.
 * @returns {Promise<CryptoKey>} AES-GCM 256, non extractible, `encrypt` et `decrypt`
 */
export async function deriverCleDeDomaine({ cleMaitresse, domaine, sel, info }) {
  exigerDomaine(domaine);
  exigerInfoDuDomaine(domaine, info);
  const largeur = largeurDeSelAttendue(domaine);
  if (!(sel instanceof Uint8Array) || sel.byteLength !== largeur) {
    throw parametresRefuses(
      `le domaine « ${domaine} » est ${REGIMES_DE_DOMAINE[domaine]} : son sel fait ${largeur} octet(s), reçu ${sel?.byteLength ?? "une largeur inconnue"}. Un domaine à compteur dont le sel serait tiré rendrait une clé neuve à chaque ouverture, donc un artefact illisible ; un domaine à usage unique dont le sel serait vide rendrait la même clé pour tous ses artefacts.`,
      { champ: "sel", domaine, attendu: largeur, regime: REGIMES_DE_DOMAINE[domaine] },
    );
  }
  const base =
    cleMaitresse instanceof Uint8Array
      ? await importerMateriauMaitre(cleMaitresse)
      : exigerMateriauMaitre(cleMaitresse);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: sel, info },
    base,
    { name: "AES-GCM", length: CLE_DE_DOMAINE_OCTETS * 8 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * RECOUPE le `domaine` déclaré avec le champ de domaine que l'`info` porte (#182, revue de sécurité
 * de la PR #186, constat 5).
 *
 * ## Ce que l'en-tête de ce module promettait, et ne tenait pas
 *
 * « Le régime est une propriété du DOMAINE, et il est vérifié ici. » En fait `domaine` ne décidait
 * que de la LARGEUR DU SEL ; l'`info` — le seul champ qui sépare réellement deux clés — était reçue
 * telle quelle et n'était jamais confrontée à lui. Un appelant pouvait donc annoncer `volume` et
 * présenter l'info de `journal` : il obtenait la clé du journal, à l'octet près.
 *
 * La conséquence qui compte n'est pas celle-là, mais sa SYMÉTRIQUE : `domaine: "volume"` admet un
 * sel VIDE, si bien qu'un appelant pouvait dériver la clé d'un domaine à USAGE UNIQUE —
 * `instantane`, `archive` — **sans sel**, c'est-à-dire une clé constante pour tous les artefacts
 * d'un volume. C'est exactement le régime que la décision 4 de l'ADR 0033 refuse, et il était
 * atteignable par la garde qui prétendait l'interdire.
 *
 * ## Pourquoi le PRÉFIXE suffit, et pourquoi on ne reconstruit pas l'info entière
 *
 * L'info est `LP(schéma) ‖ LP(domaine) ‖ LP(identifiant) ‖ U32BE(version) ‖ LP(algorithme)`. Les
 * deux premiers champs ne dépendent que du domaine : les recalculer ici ne demande rien à
 * l'appelant, et cela rend `domaine` AUTORITAIRE sur le seul champ qui décide du régime de sel. Les
 * trois autres appartiennent à l'appelant — un identifiant, une version de format —, et les exiger
 * ici obligerait `deriverCleDeDomaine` à les connaître, donc à cesser d'être la primitive qu'elle
 * est. L'injectivité de l'encodage fait le reste : un préfixe égal sur des champs préfixés en
 * longueur ne peut pas décrire un autre domaine.
 */
function exigerInfoDuDomaine(domaine, info) {
  const prefixe = concatenerListe([
    chainePrefixee(ETIQUETTE_SCHEMA_DE_DOMAINE),
    chainePrefixee(domaine),
  ]);
  const concorde =
    info instanceof Uint8Array &&
    info.byteLength >= prefixe.byteLength &&
    prefixe.every((octet, index) => octet === info[index]);
  if (concorde) return;
  throw parametresRefuses(
    `l'« info » présentée ne décrit pas le domaine « ${domaine} ». Le domaine déclaré décide de la largeur de sel admise ; l'info décide de la CLÉ. Les laisser diverger permettrait de dériver la clé d'un domaine sous le régime de sel d'un autre — par exemple une clé à usage unique SANS sel, donc constante pour tous les artefacts d'un volume (ADR 0033, décision 4).`,
    { champ: "info", domaine },
  );
}

/**
 * Refuse un matériau qui n'est pas celui qu'`importerMateriauMaitre` rend.
 *
 * Une clé AES-GCM présentée ici ferait échouer `deriveKey` avec un message de plate-forme ; le refus
 * typé dit à l'appelant ce qu'il a confondu, et il le dit AVANT l'appel.
 */
function exigerMateriauMaitre(cle) {
  if (cle?.algorithm?.name !== "HKDF" || !cle.usages?.includes("deriveKey")) {
    throw parametresRefuses(
      `« cleMaitresse » doit être les octets de la DEK ou le matériau HKDF qu'« importerMateriauMaitre » rend. Une clé AES-GCM ne dérive rien : depuis l'ADR 0033, décision 6, la DEK n'est plus importée comme une clé de chiffrement.`,
      { champ: "cleMaitresse", algorithme: cle?.algorithm?.name ?? null },
    );
  }
  return cle;
}
