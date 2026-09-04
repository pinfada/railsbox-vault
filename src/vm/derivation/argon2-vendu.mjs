// L'ARTEFACT Argon2 VENDU, et son instanciation (#22, ADR 0021).
//
// `vendor/argon2/argon2.wasm` est l'implémentation de RÉFÉRENCE d'Argon2 (phc-winner-argon2, celle
// de la RFC 9106) compilée en WebAssembly, telle que la publie `argon2-browser@1.18.0`. Elle est
// versionnée dans le dépôt — contrairement aux artefacts v86 — parce qu'elle est chargée à chaque
// déverrouillage : un artefact téléchargé à la construction ferait dépendre l'ouverture d'un coffre
// d'un réseau, et un artefact téléchargé à l'exécution serait un CDN, que l'ADR 0013 interdit.
//
// ## Ce que ce module N'IMPORTE PAS, et pourquoi c'est le sujet
//
// Il n'importe **aucune ligne de la colle Emscripten** publiée avec le binaire. Cette colle fait
// cent pages, elle cherche son `.wasm` par `fetch` ou par `require("fs")` selon un environnement
// qu'elle devine, et elle serait, en volume, la plus grosse dépendance tierce de ce dépôt.
//
// Le module tiers exige exactement DEUX importations et rien d'autre — `emscripten_memcpy_big` et
// `emscripten_resize_heap` —, et elles tiennent en quinze lignes. Les écrire ici réduit l'artefact
// tiers à ce qu'il doit être : **un binaire vérifiable par empreinte**, sans code tiers autour.
// `vendor/argon2/MANIFEST.json` publie les noms minifiés de ses exportations, pour qu'un relecteur
// n'ait pas à les redécouvrir.
//
// ## L'empreinte est vérifiée AVANT instanciation, et c'est la moitié utile de l'épinglage
//
// `SEC-UPDATE-001` demande un runtime « identifié et vérifié ». Un manifeste que personne ne relit
// à l'exécution n'identifie rien : ce module recalcule le SHA-256 des octets chargés et refuse tout
// écart par `VAULT_DERIVATION_ARGON2_INDISPONIBLE`, avant d'instancier quoi que ce soit.
// `publier:check` vérifie la même empreinte sur l'arbre publié ; les deux mesurent le même octet à
// deux moments, et aucune ne remplace l'autre.
//
// ## La croissance du tas est GÉOMÉTRIQUE, et ce n'est pas une optimisation
//
// La première version faisait croître la mémoire jusqu'à la taille exactement demandée. À 64 Mio —
// la calibration retenue —, l'allocateur du module réclame le tas par petits pas, chaque
// `Memory.grow` recopie le tampon, et la dérivation ne rendait plus la main en deux minutes. Le
// défaut a été trouvé par EXÉCUTION, pas par relecture : la même mesure prise à 19 Mio passait en
// 72 ms et ne montrait rien. Doubler à chaque fois, comme le fait la colle d'Emscripten, ramène la
// dérivation calibrée à quelques centaines de millisecondes.
//
// ## La chaîne PHC n'est PAS demandée, et c'est une propriété de sécurité
//
// `argon2_hash_ext` sait écrire, en plus de l'étiquette brute, la chaîne PHC qui la porte —
// « $argon2id$v=19$m=…$<sel>$<étiquette> ». Cette étiquette-là EST le matériau remis à HKDF, et la
// chaîne la donne en base64. Une première version fournissait le tampon parce que l'API le
// proposait ; le tampon n'était rendu à `free` qu'à la fin, jamais mis à zéro, et la base64 du
// matériau restait donc dans le tas du module — un singleton dont la mémoire vit aussi longtemps
// que le Worker — jusqu'à ce qu'un allocataire suivant repasse dessus. Une épreuve SONDE le tas
// après `hacher` et exige son absence.
//
// Le remède n'est pas de l'effacer mieux : c'est de ne pas la demander. L'implémentation de
// référence teste `if (encoded && encodedlen)`, et un pointeur NUL lui fait sauter tout l'encodage.
// Le produit n'a jamais eu l'emploi de cette chaîne — il relit ses paramètres dans les octets
// publics de l'emplacement (ADR 0020), pas dans une chaîne PHC.
//
// ## Argon2i n'est pas servi, et c'est MESURÉ
//
// Le binaire calcule Argon2d et Argon2id à la vitesse attendue et reproduit leurs vecteurs RFC 9106
// à l'octet. Argon2**i** est juste, et pathologiquement lent : **14,9 s pour m = 32 Kio, t = 1,
// p = 1**, là où Argon2id coûte 2 ms sur les mêmes paramètres — cinq ordres de grandeur. Le vecteur
// de la RFC 9106 § 5.2 (m = 32 Kio, t = 3, p = 4) ne rend pas la main dans un budget d'épreuve.
// `hacher` refuse donc la variante `i` : la laisser passer reviendrait à offrir un chemin qui
// paraît normal et gèle l'onglet. Le produit n'en a aucun besoin — il emploie Argon2id, que la
// RFC 9106 recommande par défaut.

import { argon2Indisponible } from "./derivation-errors.mjs";

/** Chemin SERVI de l'artefact. `tools/serve.mjs` expose `vendor/` en lecture seule depuis #4. */
export const ARGON2_ARTEFACT_URL = "/vendor/argon2/argon2.wasm";

/** Taille épinglée par `vendor/argon2/MANIFEST.json`. */
export const ARGON2_ARTEFACT_OCTETS = 25725;

/** Empreinte épinglée par `vendor/argon2/MANIFEST.json`. Recalculée à chaque chargement. */
export const ARGON2_ARTEFACT_SHA256 =
  "0c2149886c13e4eae4a6ca25ee71d47423c5c8740a874cf04ff816d1b2c901d7";

/** Les trois variantes d'Argon2, telles que `argon2.h` les numérote. */
const VARIANTES = Object.freeze({ d: 0, i: 1, id: 2 });

/** Les variantes que ce dépôt a MESURÉES et accepte de servir. Voir l'en-tête sur Argon2i. */
const VARIANTES_SERVIES = Object.freeze(["d", "id"]);

/** Version d'Argon2 : 0x13, la seule que la RFC 9106 définit. */
export const ARGON2_VERSION = 0x13;

/** Plafond de croissance du tas WebAssembly, celui de la colle d'Emscripten : 2 Gio − 64 Kio. */
const TAS_MAX = 2147418112;

const PAGE = 65536;

/** Charge l'artefact depuis l'origine de confiance. Aucun autre hôte n'est joignable (ADR 0013). */
async function chargerParFetch() {
  const reponse = await fetch(ARGON2_ARTEFACT_URL);
  if (!reponse.ok) throw new Error(`${reponse.status} ${reponse.statusText}`);
  return new Uint8Array(await reponse.arrayBuffer());
}

/** Confronte les octets chargés à l'épinglage. Un écart d'un bit est un refus. */
async function verifierEmpreinte(octets) {
  if (octets.byteLength !== ARGON2_ARTEFACT_OCTETS) {
    throw argon2Indisponible(
      `l'artefact fait ${octets.byteLength} octets au lieu des ${ARGON2_ARTEFACT_OCTETS} épinglés.`,
      { attendu: ARGON2_ARTEFACT_OCTETS, mesure: octets.byteLength },
    );
  }
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", octets));
  let mesure = "";
  for (const octet of digest) mesure += octet.toString(16).padStart(2, "0");
  if (mesure !== ARGON2_ARTEFACT_SHA256) {
    throw argon2Indisponible(
      "son empreinte SHA-256 n'est pas celle qu'épingle vendor/argon2/MANIFEST.json.",
      { attendu: ARGON2_ARTEFACT_SHA256, mesure },
    );
  }
  return octets;
}

/** Instancie le module et rend ses exportations, sous les deux importations qu'il réclame. */
async function instancier(octets) {
  const etat = { memoire: null, vue: null };
  const rafraichir = () => {
    etat.vue = new Uint8Array(etat.memoire.buffer);
  };
  const importations = {
    a: {
      // `emscripten_memcpy_big(dest, src, n)` : une recopie interne au tas, jamais un accès dehors.
      a: (destination, source, nombre) => {
        etat.vue.copyWithin(destination, source, source + nombre);
      },
      // `emscripten_resize_heap(octets)` : croissance GÉOMÉTRIQUE — voir l'en-tête de ce fichier.
      b: (demande) => {
        const ancien = etat.memoire.buffer.byteLength;
        const vise = Math.min(Math.max(demande >>> 0, ancien * 2), TAS_MAX);
        const pages = Math.ceil((vise - ancien) / PAGE);
        if (pages <= 0) return 1;
        try {
          etat.memoire.grow(pages);
          rafraichir();
          return 1;
        } catch {
          return 0;
        }
      },
    },
  };
  const { instance } = await WebAssembly.instantiate(octets, importations);
  etat.memoire = instance.exports.c;
  rafraichir();
  instance.exports.d(); // __wasm_call_ctors
  return { etat, exports: instance.exports };
}

/** Exige une suite d'octets, ou rend une suite vide quand le champ est facultatif. */
function octetsOuVide(valeur, nom) {
  if (valeur === undefined || valeur === null) return new Uint8Array(0);
  if (!(valeur instanceof Uint8Array)) {
    throw argon2Indisponible(`« ${nom} » n'est pas une suite d'octets.`, { champ: nom });
  }
  return valeur;
}

/**
 * MOTEUR Argon2 adossé à l'artefact vendu.
 *
 * L'instanciation est PARESSEUSE et partagée : le module fait vingt-cinq kilo-octets, mais son tas
 * grandit jusqu'à la mémoire de la calibration, et en réinstancier un par dérivation ferait payer
 * cette croissance à chaque tentative de phrase.
 *
 * @param {{ chargerArtefact?: () => Promise<Uint8Array> }} [primitives]
 */
export function argon2Vendu({ chargerArtefact = chargerParFetch } = {}) {
  let promesse = null;

  const moteur = async () => {
    if (promesse === null) {
      promesse = (async () => {
        let octets;
        try {
          octets = await chargerArtefact();
        } catch (cause) {
          throw argon2Indisponible(
            `l'artefact ${ARGON2_ARTEFACT_URL} n'a pas pu être lu (${cause?.message ?? cause}).`,
            { url: ARGON2_ARTEFACT_URL },
          );
        }
        return instancier(await verifierEmpreinte(octets));
      })().catch((cause) => {
        // Un chargement raté ne condamne pas le suivant : l'artefact peut revenir (réseau, cache),
        // et garder une promesse rejetée transformerait un incident en panne définitive.
        promesse = null;
        throw cause;
      });
    }
    return promesse;
  };

  return Object.freeze({ hacher: (appel) => hacher(moteur, appel) });
}

/** Écrit des octets dans le tas du module et rend leur adresse. */
function poser(etat, exports, octets) {
  const adresse = exports.f(Math.max(octets.byteLength, 1));
  if (adresse === 0) throw argon2Indisponible("le module n'a plus de mémoire à allouer.");
  etat.vue.set(octets, adresse);
  return adresse;
}

/**
 * HACHE par Argon2. Rend `longueur` octets, ou refuse — jamais une valeur approchante.
 *
 * @param {() => Promise<object>} moteur
 * @param {{ variante: string, mot: Uint8Array, sel: Uint8Array, secret?: Uint8Array,
 *           donneesAssociees?: Uint8Array, memoireKio: number, iterations: number,
 *           parallelisme: number, longueur: number }} appel
 */
async function hacher(moteur, appel) {
  if (!VARIANTES_SERVIES.includes(appel.variante)) {
    throw argon2Indisponible(
      `la variante Argon2${appel.variante} n'est pas servie par ce dépôt. Argon2i est JUSTE dans l'artefact vendu mais pathologiquement lent — 14,9 s pour 32 Kio, cinq ordres de grandeur au-dessus d'Argon2id sur les mêmes paramètres —, et un chemin qui gèle l'onglet vaut moins qu'un refus. Le produit emploie Argon2id, que la RFC 9106 recommande par défaut.`,
      { variante: appel.variante, servies: VARIANTES_SERVIES },
    );
  }
  const { etat, exports } = await moteur();
  const secret = octetsOuVide(appel.secret, "secret");
  const associees = octetsOuVide(appel.donneesAssociees, "donneesAssociees");
  const adresses = {
    mot: poser(etat, exports, appel.mot),
    sel: poser(etat, exports, appel.sel),
    secret: secret.byteLength === 0 ? 0 : poser(etat, exports, secret),
    associees: associees.byteLength === 0 ? 0 : poser(etat, exports, associees),
    empreinte: exports.f(appel.longueur),
    // NUL, délibérément : voir l'en-tête de ce fichier. Aucune chaîne PHC n'est demandée, donc
    // aucune base64 de l'étiquette n'est écrite dans le tas.
    encode: 0,
  };

  try {
    return lireEmpreinte(etat, exports, appel, adresses);
  } finally {
    // Les deux tampons qui portent un secret sont mis à zéro AVANT d'être rendus au module : `free`
    // ne les efface pas, et les octets d'un étirement de phrase resteraient sinon dans le tas
    // jusqu'au prochain allocataire. Fenêtre refermée, pas garantie — le tas est une `ArrayBuffer`
    // ordinaire, et le moteur a pu la déplacer.
    etat.vue.fill(0, adresses.empreinte, adresses.empreinte + appel.longueur);
    etat.vue.fill(0, adresses.mot, adresses.mot + appel.mot.byteLength);
    for (const adresse of Object.values(adresses)) if (adresse !== 0) exports.g(adresse);
  }
}

/** Appelle `argon2_hash_ext` et relit l'étiquette produite, ou refuse sur le code rendu. */
function lireEmpreinte(etat, exports, appel, adresses) {
  const code = exports.l(
    appel.iterations,
    appel.memoireKio,
    appel.parallelisme,
    adresses.mot,
    appel.mot.byteLength,
    adresses.sel,
    appel.sel.byteLength,
    adresses.empreinte,
    appel.longueur,
    adresses.encode,
    0, // `encodedlen` : nul avec un pointeur nul, ce qui fait sauter l'encodage PHC en entier.
    VARIANTES[appel.variante],
    adresses.secret,
    appel.secret?.byteLength ?? 0,
    adresses.associees,
    appel.donneesAssociees?.byteLength ?? 0,
    ARGON2_VERSION,
  );
  if (code !== 0) {
    throw argon2Indisponible(`le module a refusé les paramètres (code ${code}).`, { code });
  }
  return etat.vue.slice(adresses.empreinte, adresses.empreinte + appel.longueur);
}
