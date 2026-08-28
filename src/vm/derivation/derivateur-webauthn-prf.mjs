// Le dérivateur `webauthn-prf` : l'extension `prf`, puis HKDF (#22, ADR 0021, décision 4).
//
// ## Le sel est par EMPLACEMENT, et la clé aussi
//
// L'extension `prf` évalue une fonction pseudo-aléatoire propre à la créance sur une entrée que le
// site choisit. Cette entrée — le SEL — est tirée à l'enregistrement, trente-deux octets, et vit
// dans les paramètres publics de l'emplacement. Deux emplacements de la MÊME passkey ont donc deux
// sels, et la sortie PRF diffère avant même HKDF ; HKDF y ajoute l'identité de l'emplacement, si
// bien que même un authentificateur qui ignorerait le sel ne rendrait pas deux fois la même KEK.
//
// ## `signCount` n'est pas une fraîcheur, et ce module ne le lit pas
//
// L'ADR 0015 l'a déjà écrit : le compteur de signatures est FACULTATIF en CTAP2, et la plupart des
// authentificateurs de plateforme le laissent à zéro. Un produit qui refuserait une assertion dont
// le compteur n'a pas augmenté refuserait la majorité des passkeys modernes, et un produit qui
// l'accepterait comme preuve de fraîcheur croirait tenir une garantie qu'aucun authentificateur ne
// promet. Ce module ne lit pas `response.signCount` — l'épreuve unitaire le montre en dérivant deux
// fois sous des compteurs DÉCROISSANTS et en vérifiant que les deux KEK sont la même.
//
// **Ce qui tient lieu de fraîcheur** est ailleurs, et c'est celui de l'ADR 0020 : la KEK n'ouvre
// que si elle développe la DEK de son emplacement, et la version de l'enveloppe est monotone. Le
// rejeu du FICHIER reste la limite nommée par l'ADR 0020, que #23 fermera.
//
// ## Ce qui n'est PAS vérifié ici, et qui est vérifié par la cryptographie
//
// Ce module ne vérifie ni la signature de l'assertion, ni l'origine, ni le défi. Ce n'est pas un
// oubli : Vault n'est pas un serveur qui AUTHENTIFIE un utilisateur, c'est un coffre qui DÉRIVE une
// clé. La question n'est pas « ce navigateur dit-il vrai ? » mais « la clé développe-t-elle la
// DEK ? », et à cette question-là c'est l'étiquette AES-GCM de l'enveloppe qui répond, sans faire
// confiance à personne. Un attaquant capable de forger une assertion sans l'authentificateur
// n'obtiendrait pas pour autant la sortie PRF, qui est la seule chose dont la clé dépend.

import { deriverKekPourEmplacement } from "./derivateur.mjs";
import { annulee, prfIgnoree, prfIndisponible } from "./derivation-errors.mjs";
import {
  SEL_PRF_OCTETS,
  decoderParametresPublics,
  encoderParametresPublics,
} from "./parametres-publics.mjs";
import { TYPES_KEK } from "../enveloppe/identite-enveloppe.mjs";
import { hexEnOctets, octetsEnHex } from "../format-chiffre/octets.mjs";

/** Délai laissé à l'utilisateur, en millisecondes. Au-delà, le moteur rend `NotAllowedError`. */
export const DELAI_MS = 60000;

/**
 * Algorithmes de signature demandés à l'enregistrement : ES256 puis RS256.
 *
 * Vault ne vérifie aucune signature (voir l'en-tête), mais `create` en exige la liste. Les deux
 * valeurs sont celles que la spécification WebAuthn nomme comme minimum interopérable.
 */
const ALGORITHMES = Object.freeze([
  Object.freeze({ type: "public-key", alg: -7 }),
  Object.freeze({ type: "public-key", alg: -257 }),
]);

/**
 * `residentKey` et `userVerification`, tranchés ici plutôt que laissés au défaut du moteur.
 *
 *  - `residentKey: "required"` — la créance est DÉCOUVRABLE. Sans elle, déverrouiller exigerait de
 *    connaître d'avance l'identifiant de créance ; il est justement dans les paramètres publics,
 *    donc dans un fichier que l'utilisateur peut avoir perdu avec son appareil. Une passkey
 *    découvrable rend le volume ouvrable depuis un appareil neuf qui a la même passkey
 *    synchronisée ;
 *  - `userVerification: "required"` — un geste de VÉRIFICATION (biométrie, code) est exigé. Une
 *    simple présence rendrait la clé dérivable par quiconque tient l'appareil déverrouillé, ce qui
 *    reviendrait à ranger la clé à côté du coffre.
 */
export const CONDUITE_ENREGISTREMENT = Object.freeze({
  residentKey: "required",
  userVerification: "required",
  requireResidentKey: true,
});

/** Vrai si l'échec vient d'un refus, d'une fermeture ou d'un temps écoulé. */
function estAnnulation(cause) {
  return cause?.name === "NotAllowedError" || cause?.name === "AbortError";
}

/**
 * Vrai si l'échec vient du MOTEUR ou de l'authentificateur, et non du code appelant.
 *
 * Il en existe plus que `NotAllowedError`, et le relevé des trois moteurs l'a montré plutôt que la
 * lecture de la spécification : sans authentificateur, Firefox rend `UnknownError` (« The operation
 * failed for an unknown transient reason ») là où WebKit rend une créance dépourvue de résultat
 * `prf`. Laisser remonter une `DOMException` brute ferait sortir du produit une erreur dont le
 * `code` est un entier hérité, que rien dans ce dépôt ne sait lire — et un refus de sécurité qui se
 * perd en route est un refus qui n'existe pas.
 */
function estEchecDePlateforme(cause) {
  return typeof cause?.name === "string" && typeof DOMException !== "undefined"
    ? cause instanceof DOMException
    : false;
}

/** Rend `navigator.credentials`, ou refuse — un moteur sans WebAuthn n'est pas un moteur lent. */
function exigerCredentials(credentials) {
  const trouve = credentials ?? globalThis.navigator?.credentials ?? null;
  if (!trouve || typeof trouve.create !== "function" || typeof trouve.get !== "function") {
    throw prfIndisponible("ce moteur n'expose pas « navigator.credentials ».");
  }
  return trouve;
}

/** Les octets d'un `BufferSource`, quelle que soit la forme que le moteur a rendue. */
function octetsDe(source) {
  if (source instanceof Uint8Array) return source;
  if (source instanceof ArrayBuffer) return new Uint8Array(source);
  if (ArrayBuffer.isView(source)) {
    return new Uint8Array(source.buffer, source.byteOffset, source.byteLength);
  }
  return null;
}

/**
 * ENREGISTRE une créance et rend les paramètres publics d'un emplacement `webauthn-prf`.
 *
 * C'est le point (a) du contrat de #22 : si l'extension n'est pas là, l'emplacement N'EST PAS créé
 * et rien n'est dégradé en un autre moyen. Le refus tombe AVANT que quoi que ce soit ne soit écrit
 * dans le fichier d'enveloppes — l'appelant n'a reçu aucun paramètre, il n'a donc rien à écrire.
 *
 * @param {{ credentials?: object, rpId: string, nomUtilisateur: string,
 *           identifiantUtilisateur: Uint8Array, nomAffiche?: string, defi?: Uint8Array }} appel
 */
export async function enregistrerEmplacementPrf({
  credentials,
  rpId,
  nomUtilisateur,
  identifiantUtilisateur,
  nomAffiche = nomUtilisateur,
  defi = crypto.getRandomValues(new Uint8Array(32)),
}) {
  const api = exigerCredentials(credentials);
  const creance = await creerLaCreance(api, {
    rpId,
    nomUtilisateur,
    identifiantUtilisateur,
    nomAffiche,
    defi,
  });
  const identifiantCredential = octetsEnHex(creanceAvecPrf(creance, rpId));
  return Object.freeze({
    typeKek: TYPES_KEK["webauthn-prf"],
    identifiantCredential,
    parametres: encoderParametresPublics(TYPES_KEK["webauthn-prf"], {
      rpId,
      identifiantCredential,
      sel: octetsEnHex(crypto.getRandomValues(new Uint8Array(SEL_PRF_OCTETS))),
    }),
  });
}

/** Demande la créance à l'authentificateur, et traduit tout échec de plate-forme en refus typé. */
async function creerLaCreance(
  api,
  { rpId, nomUtilisateur, identifiantUtilisateur, nomAffiche, defi },
) {
  try {
    return await api.create({
      publicKey: {
        challenge: defi,
        rp: { id: rpId, name: "RailsBox Vault" },
        user: { id: identifiantUtilisateur, name: nomUtilisateur, displayName: nomAffiche },
        pubKeyCredParams: [...ALGORITHMES],
        authenticatorSelection: { ...CONDUITE_ENREGISTREMENT },
        timeout: DELAI_MS,
        // L'extension est DEMANDÉE ici. Un moteur qui l'ignore rendra `prf` absent des résultats,
        // et c'est exactement ce que `creanceAvecPrf` refuse.
        extensions: { prf: {} },
      },
    });
  } catch (cause) {
    // `NotAllowedError` à l'ENREGISTREMENT couvre deux situations que le navigateur ne départage
    // pas : l'utilisateur a refusé, ou aucun authentificateur n'a répondu dans le délai. Le refus
    // rendu est donc celui de l'ANNULATION — la cause n'est pas établie, et prétendre le contraire
    // dirait « votre appareil ne sait pas faire » à quelqu'un qui a simplement fermé la fenêtre.
    if (estAnnulation(cause)) throw annulee({ rpId, nom: cause.name, geste: "enregistrement" });
    // Tout autre échec de plate-forme est rendu comme une INDISPONIBILITÉ, en NOMMANT l'erreur du
    // moteur dans le contexte. Le remède est le même — créer l'emplacement sur un autre moyen —, et
    // prétendre distinguer davantage reviendrait à inventer une cause que le navigateur ne donne pas.
    if (estEchecDePlateforme(cause)) {
      throw prfIndisponible(`le moteur a interrompu la création de la créance (${cause.name}).`, {
        rpId,
        nom: cause.name,
        message: cause.message,
      });
    }
    throw cause;
  }
}

/** Exige que l'extension ait été ACTIVÉE, et rend les octets de l'identifiant de créance. */
function creanceAvecPrf(creance, rpId) {
  const resultats = creance?.getClientExtensionResults?.() ?? {};
  if (resultats.prf?.enabled !== true) {
    throw prfIndisponible(
      resultats.prf === undefined
        ? "l'authentificateur n'a rendu aucun résultat pour l'extension « prf » : elle n'est pas prise en charge ici."
        : "l'authentificateur a rendu « prf » sans l'activer (« enabled » n'est pas vrai).",
      { rpId, resultat: resultats.prf ?? null },
    );
  }
  const identifiant = octetsDe(creance.rawId);
  if (identifiant === null || identifiant.byteLength === 0) {
    throw prfIndisponible("l'authentificateur n'a rendu aucun identifiant de créance.");
  }
  return identifiant;
}

/** Demande l'assertion, en traduisant l'annulation en son propre refus. */
async function assertion(api, valeurs, geste) {
  try {
    return await api.get({
      publicKey: {
        challenge: geste?.defi ?? crypto.getRandomValues(new Uint8Array(32)),
        rpId: valeurs.rpId,
        allowCredentials: [{ type: "public-key", id: hexEnOctets(valeurs.identifiantCredential) }],
        userVerification: CONDUITE_ENREGISTREMENT.userVerification,
        timeout: geste?.delaiMs ?? DELAI_MS,
        extensions: { prf: { eval: { first: hexEnOctets(valeurs.sel) } } },
      },
      ...(geste?.signal === undefined ? {} : { signal: geste.signal }),
    });
  } catch (cause) {
    if (estAnnulation(cause)) throw annulee({ rpId: valeurs.rpId, nom: cause.name });
    // Même règle qu'à l'enregistrement, avec l'autre remède : ici l'emplacement est légitime, et
    // ce qui manque est la SORTIE de l'extension. Le fait observable est le même dans les deux cas —
    // aucune sortie PRF n'est revenue —, et c'est ce que le refus dit.
    if (estEchecDePlateforme(cause)) {
      throw prfIgnoree(
        `le moteur a interrompu l'assertion (${cause.name}) et n'a rendu aucune sortie.`,
        { rpId: valeurs.rpId, nom: cause.name, message: cause.message },
      );
    }
    throw cause;
  }
}

/** Extrait la sortie PRF, ou refuse : point (b) du contrat de #22. */
function sortiePrf(resultat, rpId) {
  const resultats = resultat?.getClientExtensionResults?.() ?? {};
  const premier = octetsDe(resultats.prf?.results?.first);
  if (premier === null) {
    throw prfIgnoree(
      "l'extension « prf » a été demandée et l'assertion n'en rend aucune sortie. C'est un authentificateur ou un moteur qui ne la sert pas, et non une clé fausse.",
      { rpId, resultat: resultats.prf ?? null },
    );
  }
  if (premier.byteLength !== 32) {
    throw prfIgnoree(
      `la sortie de l'extension fait ${premier.byteLength} octets au lieu de 32. Une sortie plus courte donnerait une clé plus faible sans que rien ne le signale : elle est refusée, jamais complétée.`,
      { rpId, longueur: premier.byteLength },
    );
  }
  return Uint8Array.from(premier);
}

/**
 * Le DÉRIVATEUR `webauthn-prf`. Il est SANS ÉTAT : aucun compteur d'échec, aucune mémoire d'une
 * annulation, aucun repli vers un autre moyen. Point (c) et (d) du contrat de #22.
 *
 * @param {{ credentials?: object }} [primitives]
 */
export function derivateurWebauthnPrf({ credentials } = {}) {
  return Object.freeze({
    type: TYPES_KEK["webauthn-prf"],
    deriver: async ({ parametres, identite, geste }) => {
      const valeurs = decoderParametresPublics(TYPES_KEK["webauthn-prf"], parametres);
      const api = exigerCredentials(credentials);
      const resultat = await assertion(api, valeurs, geste);
      // `resultat.response.signCount` n'est PAS lu. Voir l'en-tête de ce fichier.
      return deriverKekPourEmplacement({
        materiau: sortiePrf(resultat, valeurs.rpId),
        sel: hexEnOctets(valeurs.sel),
        identite,
      });
    },
  });
}
