// La CLÉ sous laquelle la racine d'une page d'enveloppe est scellée (#182, T2b ; ADR 0033,
// décisions 2, 3 et 4 ; ADR 0020, décision 3 ; ADR 0027).
//
// Un seul endroit du dépôt répond à la question « sous quelle clé cette page-là ? ». Deux auraient
// fini par diverger, et la divergence se serait payée en enveloppes illisibles — c'est-à-dire en
// volumes perdus.
//
// ## Deux régimes, et le format de la page décide
//
//  - **page v1** — la racine est scellée sous la DEK elle-même, directement. C'est ce que le produit
//    faisait avant T2b, et c'est ce qu'il faut encore savoir RELIRE. La clé est importée par
//    `page-v1-lecture.mjs` avec le seul usage `decrypt` : ce chemin ne peut pas produire de v1 ;
//  - **page v2** — la racine est scellée sous une clé à USAGE UNIQUE, dérivée de la DEK par
//    HKDF-SHA-256 pour un domaine, un volume et la version 2 de la page. Le sel est TIRÉ à chaque
//    écriture de page et écrit en clair dans l'en-tête.
//
// ## Deux domaines, et pourquoi la page doit dire lequel
//
// L'ADR 0033, décision 2, sépare `enveloppe` — la page de `<volume>.cles` — et `recuperation` — la
// page qu'une archive emporte, rescellée à l'export sur la liste filtrée (ADR 0027). Ce sont deux
// clés, parce que l'info porte le nom du domaine.
//
// Or la restauration POSE la page de récupération en page 0 de `<volume>.cles`, et le premier
// déverrouillage du volume restauré doit l'ouvrir. Un lecteur qui supposerait `enveloppe` dériverait
// la mauvaise clé et refuserait une page parfaitement valide ; un lecteur qui essaierait les deux
// ferait dépendre son verdict de l'ordre des essais. La page le DIT donc, dans un octet de son
// en-tête, et cet octet se protège par sa conséquence exactement comme le sel.
//
// ## L'identifiant employé est celui que la PAGE déclare, pas celui que l'appelant attend
//
// C'est l'ordre de l'ADR 0015, transposé : on AUTHENTIFIE d'abord, on CLASSE ensuite. Dériver avec
// l'identifiant attendu ferait échouer l'étiquette d'une page venue d'un autre volume, et le refus
// rendu serait « racine refusée » — un diagnostic qui ne dit rien — là où `ouvrirRacine` sait dire
// « cette page décrit un autre volume ». La DEK, elle, vient de la page elle-même : un emplacement
// que la KEK présentée a ouvert. Il n'y a donc rien à gagner à mentir sur l'identifiant.

import {
  DOMAINES,
  VERSIONS_DE_FORMAT_DE_DOMAINE,
  deriverCleDeDomaine,
  encoderInfoDeDomaine,
  tirerSelDeDomaine,
} from "../derivation/cle-de-domaine.mjs";
import { malforme } from "./enveloppe-errors.mjs";
import {
  DOMAINES_DE_RACINE,
  ENVELOPPE_FORMAT_V1,
  ENVELOPPE_FORMAT_V2,
  nomDuDomaineDeRacine,
} from "./identite-enveloppe.mjs";
import { importerCleDeRacineV1 } from "./page-v1-lecture.mjs";

/** L'octet d'en-tête d'un domaine de racine, à partir de son nom de domaine de dérivation. */
const OCTET_PAR_DOMAINE = Object.freeze({
  [DOMAINES.enveloppe]: DOMAINES_DE_RACINE.enveloppe,
  [DOMAINES.recuperation]: DOMAINES_DE_RACINE.recuperation,
});

/** Le nom de domaine de dérivation que porte l'octet d'en-tête d'une page v2. */
const DOMAINE_PAR_OCTET = Object.freeze({
  [DOMAINES_DE_RACINE.enveloppe]: DOMAINES.enveloppe,
  [DOMAINES_DE_RACINE.recuperation]: DOMAINES.recuperation,
});

/** Octet d'en-tête du domaine `enveloppe` : celui d'une page de `<volume>.cles`. */
export const OCTET_DOMAINE_ENVELOPPE = DOMAINES_DE_RACINE.enveloppe;

/** Octet d'en-tête du domaine `recuperation` : celui de la page qu'une archive emporte. */
export const OCTET_DOMAINE_RECUPERATION = DOMAINES_DE_RACINE.recuperation;

/**
 * TIRE le sel d'une page v2 et DÉRIVE la clé sous laquelle sa racine sera scellée.
 *
 * **Le sel est TIRÉ, et le chemin de production ne peut pas le fournir.** Un appelant qui le
 * pourrait pourrait le répéter, et deux pages scellées sous la même clé et le même nonce sont
 * exactement la collision que la séparation par domaine a pour objet de borner. Le seul appelant
 * capable d'en présenter un est le HARNAIS, par la porte de `enveloppe-de-cle.mjs` — la même que
 * celle du nonce, avec le même jeton, pour que la règle tienne à un seul endroit.
 *
 * @param {{ dek: Uint8Array, identifiantVolume: string, domaine?: number,
 *           sel?: Uint8Array }} appel
 *   `domaine` est l'OCTET d'en-tête, `OCTET_DOMAINE_ENVELOPPE` par défaut.
 * @returns {Promise<{ cle: CryptoKey, sel: Uint8Array, domaine: number }>}
 */
export async function cleNeuveDeRacineV2({
  dek,
  identifiantVolume,
  domaine = OCTET_DOMAINE_ENVELOPPE,
  sel = tirerSelDeDomaine(),
}) {
  const nom = exigerDomaineDeRacine(domaine);
  return Object.freeze({
    cle: await deriver({ dek, identifiantVolume, nom, sel }),
    sel,
    domaine,
  });
}

/**
 * REND la clé qui OUVRE la racine d'une page déjà écrite, quelle que soit sa version.
 *
 * @param {{ dek: Uint8Array, page: object }} appel `page` est ce que `decoderPage` a rendu.
 * @returns {Promise<CryptoKey>}
 */
export async function cleDOuvertureDeRacine({ dek, page }) {
  if (page.formatVersion === ENVELOPPE_FORMAT_V1) return importerCleDeRacineV1(dek);
  if (page.formatVersion !== ENVELOPPE_FORMAT_V2) {
    throw malforme(`Format d'enveloppe inconnu : ${page.formatVersion}.`, {
      formatVersion: page.formatVersion,
    });
  }
  return deriver({
    dek,
    identifiantVolume: page.identifiantVolume,
    nom: exigerDomaineDeRacine(page.domaine),
    sel: page.sel,
  });
}

/** Le nom de domaine que désigne un octet d'en-tête, ou un refus TYPÉ. */
function exigerDomaineDeRacine(octet) {
  const nom = DOMAINE_PAR_OCTET[octet];
  if (nom === undefined) {
    throw malforme(
      `« domaine » vaut ${octet}, qui ne désigne aucun domaine de racine (${Object.entries(
        DOMAINES_DE_RACINE,
      )
        .map(([cle, valeur]) => `${valeur} « ${cle} »`)
        .join(", ")}).`,
      { domaine: octet, nom: nomDuDomaineDeRacine(octet) },
    );
  }
  return nom;
}

/** L'octet d'en-tête d'un nom de domaine. Exporté pour que l'export de récupération le nomme. */
export function octetDuDomaine(nom) {
  const octet = OCTET_PAR_DOMAINE[nom];
  if (octet === undefined) {
    throw malforme(`« ${nom} » n'est pas un domaine de racine de page d'enveloppe.`, { nom });
  }
  return octet;
}

/** Le geste commun : une info de domaine, un sel, une clé. Deux appels de WebCrypto, pas plus. */
function deriver({ dek, identifiantVolume, nom, sel }) {
  return deriverCleDeDomaine({
    cleMaitresse: dek,
    domaine: nom,
    sel,
    info: encoderInfoDeDomaine({
      domaine: nom,
      identifiantVolume,
      versionDeFormat: VERSIONS_DE_FORMAT_DE_DOMAINE[nom],
    }),
  });
}
