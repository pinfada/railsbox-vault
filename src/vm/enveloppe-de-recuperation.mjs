// L'ENVELOPPE DE RÉCUPÉRATION qu'une archive emporte (#149, ADR 0027).
//
// L'ADR 0020, décision 6, disait « l'archive n'emporte pas l'enveloppe », et sa condition d'abandon 3
// prévoyait sa révision « si #23 tranche que l'archive doit porter une enveloppe de récupération ».
// C'est fait, et ce module est le SEUL endroit du dépôt qui construise cette enveloppe.
//
// ## Ce qui reste vrai, et qui est la raison d'être de ce fichier
//
// **Le coffre et sa clé ne voyagent pas ensemble.** L'archive porte une page qui ne contient QUE des
// emplacements de type 4 — la DEK enveloppée sous une KEK dérivée d'un CODE de récupération —, et le
// code, lui, n'entre jamais dans l'archive : il est sur une feuille de papier, chez l'utilisateur.
// Qui vole l'archive n'ouvre rien. Qui tient l'archive ET le code ouvre le volume, et c'est
// exactement la propriété que la tranche 3 de #23 livre.
//
// Une page de récupération ne porte donc JAMAIS un emplacement `phrase` ni `webauthn-prf` : une
// phrase secrète sort de l'appareil avec l'archive et devient attaquable hors ligne, sans limite de
// tentatives et sans le compteur d'un système d'exploitation ; une créance WebAuthn est liée à
// l'appareil et ne servirait à rien ailleurs. La règle est structurelle — la construction FILTRE —
// et elle est relue à l'import par `exigerEnveloppeDeRecuperationSeule`, sur une page qui pourrait
// avoir été forgée.
//
// ## Pourquoi ce module TIENT la DEK, et pourquoi les modules d'archive ne la voient pas
//
// Filtrer la liste des emplacements change la liste, et la racine de l'ADR 0020 authentifie la
// suite ORDONNÉE des emplacements sous la DEK. Une page filtrée doit donc être RESCELLÉE, ce qui
// exige la clé de volume — donc une enveloppe ouverte. Ce module la reçoit par une KEK valable,
// l'emploie le temps d'un scellement, et rend des OCTETS. `volume-export.mjs` ne reçoit que ces
// octets et leur empreinte : il ne sait pas ce qu'ils sont, il ne connaît pas le voisin `.cles`, et
// l'épreuve `vm-archive-recuperation.test.mjs` le relit.
//
// ## La VERSION portée est celle de l'enveloppe au moment de l'export
//
// Elle n'est pas remise à 1, et ce n'est pas un détail : c'est elle que l'ancre de la décision 3 de
// l'ADR 0027 compare à la feuille de récupération. Une page qui repartirait de 1 ferait de chaque
// restauration un retour arrière indétectable.
//
// ## Le domaine `recuperation`, et pourquoi ce n'est pas le domaine `enveloppe` (#182, T2b)
//
// L'ADR 0033, décision 2, sépare les deux : `enveloppe` scelle la racine de `<volume>.cles`,
// `recuperation` celle de la page qu'une archive emporte. Deux domaines, deux infos HKDF, deux
// clés — alors même que les deux pages ont la même version de format, la 2.
//
// La séparation est utile, et il faut dire de quoi : une archive VOYAGE. Elle quitte l'appareil,
// elle est copiée, elle est conservée. La clé qui scelle sa page ne scelle rien d'autre, et surtout
// rien qui soit resté sur la machine — si bien qu'un adversaire qui obtiendrait cette clé
// n'obtiendrait pas l'autorité sur l'enveloppe LOCALE. C'est la même raison qui a fait donner un
// domaine propre au journal plutôt qu'au volume.
//
// La page RESTAURÉE porte donc, dans son en-tête, l'octet de domaine `recuperation` : c'est ce qui
// permet au premier déverrouillage du volume restauré de dériver la bonne clé. La première MUTATION
// de cette enveloppe écrira une page du domaine `enveloppe`, sans geste particulier — `composerPage`
// n'écrit que celui-là.

import { ARCHIVE_ERROR_CODES, ArchiveError } from "./archive-errors.mjs";
import { exigerAleasAdmis } from "./enveloppe-de-cle.mjs";
import { lireEtat } from "./enveloppe/etat-de-lenveloppe.mjs";
import {
  PAGES,
  PAGE_OCTETS,
  TAILLE_FICHIER_ENVELOPPE,
  decoderPage,
  encoderPage,
} from "./enveloppe/fichier-enveloppe.mjs";
import { ENVELOPPE_FORMAT_V2, TYPES_KEK, nomDuTypeKek } from "./enveloppe/identite-enveloppe.mjs";
import { OCTET_DOMAINE_RECUPERATION, cleNeuveDeRacineV2 } from "./enveloppe/cle-de-racine.mjs";
import {
  importerCleDeDeverrouillage,
  scellerRacineSousNonce,
} from "./enveloppe/modele-reference.mjs";
import { createSha256Stream } from "./sha256-stream.mjs";

/** Le seul type d'emplacement qu'une archive emporte. Nommé une fois, comparé partout. */
export const TYPE_EMBARQUE = TYPES_KEK.recuperation;

export { PAGE_OCTETS, TAILLE_FICHIER_ENVELOPPE };

/** Refus typé d'une section de récupération. Il vit dans la famille de l'ARCHIVE, pas de l'enveloppe. */
function refuser(message, contexte) {
  return new ArchiveError(
    ARCHIVE_ERROR_CODES.recuperationRefusee,
    `Enveloppe de récupération refusée : ${message}`,
    contexte,
  );
}

/**
 * CONSTRUIT la page d'enveloppe qu'une archive emportera, ou rend `null`.
 *
 * `null` n'est pas un échec : c'est le constat qu'un volume n'a AUCUN moyen de récupération, et il
 * doit remonter tel quel jusqu'à l'exploitant — une archive sans enveloppe ne s'ouvrira nulle part
 * ailleurs, et c'est une chose à dire, pas à taire.
 *
 * @param {{ support: object, identifiantVolume: string, kek: Uint8Array | CryptoKey,
 *           aleas?: object }} appel
 * @returns {Promise<{ octets: Uint8Array, digest: string, version: number,
 *                     emplacements: number } | null>}
 * @throws {import("./enveloppe/enveloppe-errors.mjs").EnveloppeError} `VAULT_ENVELOPPE_ABSENTE` si
 *   le volume n'a pas d'enveloppe du tout, `VAULT_ENVELOPPE_CLE_REFUSEE` si la KEK n'ouvre rien
 */
export async function construireEnveloppeDeRecuperation({
  support,
  identifiantVolume,
  kek,
  aleas,
}) {
  const sources = exigerAleasAdmis(aleas);
  const etat = await lireEtat({
    support,
    identifiantVolume,
    kek: await importerCleDeDeverrouillage(kek),
  });
  const emplacements = etat.page.emplacements.filter(
    (emplacement) => emplacement.typeKek === TYPE_EMBARQUE,
  );
  if (emplacements.length === 0) return null;

  const octets = await rescellerLaPageFiltree({
    identifiantVolume,
    dek: etat.dek,
    version: etat.version,
    emplacements,
    sources,
  });
  return Object.freeze({
    octets,
    digest: empreinte(octets),
    version: etat.version,
    emplacements: emplacements.length,
  });
}

/**
 * RESCELLE la liste FILTRÉE en une page v2 du domaine `recuperation`.
 *
 * Recopier la racine de la page complète authentifierait une liste qui n'est plus celle-là, et la
 * page embarquée serait refusée par `VAULT_ENVELOPPE_MELANGE` au premier déverrouillage.
 *
 * La clé est celle du domaine `recuperation`, à USAGE UNIQUE, avec un sel TIRÉ ici et écrit en clair
 * dans la page. Elle ne scelle que cette page-là : le budget de ce domaine vaut 1, et aucune archive
 * ne partage sa clé avec une autre (ADR 0033, décision 4).
 */
async function rescellerLaPageFiltree({ identifiantVolume, dek, version, emplacements, sources }) {
  const cleDeRacine = await cleNeuveDeRacineV2({
    dek,
    identifiantVolume,
    domaine: OCTET_DOMAINE_RECUPERATION,
    sel: sources.tirerSel(),
  });
  const racine = await scellerRacineSousNonce({
    cleDeRacine: cleDeRacine.cle,
    racine: { identifiantVolume, formatVersion: ENVELOPPE_FORMAT_V2, version },
    emplacements,
    nonce: sources.tirerNonce(),
  });
  return encoderPage({
    identifiantVolume,
    version,
    formatVersion: ENVELOPPE_FORMAT_V2,
    racine: { nonce: racine.nonce, chiffre: racine.chiffre, etiquette: racine.etiquette },
    sel: cleDeRacine.sel,
    domaine: cleDeRacine.domaine,
    emplacements,
  });
}

/** SHA-256 des octets d'une page, en hexadécimal minuscule. C'est l'empreinte que l'en-tête déclare. */
function empreinte(octets) {
  const hash = createSha256Stream();
  hash.update(octets);
  return hash.digestHex();
}

/**
 * EXIGE qu'une section de récupération soit une page d'enveloppe lisible ne portant QUE des
 * emplacements de type 4, et rend ce qu'elle déclare.
 *
 * Appelée à l'import, sur des octets qui viennent d'un fichier que n'importe qui a pu écrire. Elle
 * ne vérifie AUCUNE cryptographie — la racine n'est vérifiable que sous la DEK, qu'on n'a pas à ce
 * moment-là — et ne le prétend pas : elle refuse une page qu'on ne sait pas lire, et une page qui
 * ferait voyager autre chose qu'un moyen de récupération. C'est une garde de FORMAT, et le premier
 * déverrouillage du volume restauré est ce qui juge le reste.
 *
 * @param {Uint8Array} octets exactement une page
 * @returns {{ version: number, identifiantVolume: string, emplacements: number }}
 * @throws {ArchiveError} `VAULT_ARCHIVE_RECUPERATION_REFUSEE`
 */
export function exigerEnveloppeDeRecuperationSeule(octets) {
  if (!(octets instanceof Uint8Array) || octets.byteLength !== PAGE_OCTETS) {
    throw refuser(
      `une page d'enveloppe fait exactement ${PAGE_OCTETS} octets, la section en porte ${octets?.byteLength ?? "aucun"}.`,
      { length: octets?.byteLength ?? null, attendu: PAGE_OCTETS },
    );
  }
  const lue = decoderPage(octets);
  if (!lue.valide) {
    throw refuser(`la section n'est pas une page d'enveloppe lisible (${lue.raison}).`, {
      raison: lue.raison,
    });
  }
  const etrangers = lue.page.emplacements.filter(
    (emplacement) => emplacement.typeKek !== TYPE_EMBARQUE,
  );
  if (etrangers.length > 0) {
    const types = [...new Set(etrangers.map((emplacement) => emplacement.typeKek))];
    throw refuser(
      `elle porte ${etrangers.length} emplacement(s) d'un autre type que ${TYPE_EMBARQUE} (${types.map((type) => `${type} « ${nomDuTypeKek(type) ?? "inconnu"} »`).join(", ")}). Une archive n'emporte jamais une phrase secrète ni une passkey.`,
      { types },
    );
  }
  return Object.freeze({
    version: lue.page.version,
    identifiantVolume: lue.page.identifiantVolume,
    emplacements: lue.page.emplacements.length,
  });
}

/**
 * Rend le FICHIER `<volume>.cles` que la restauration doit poser : la page embarquée en page 0, et
 * une page à ZÉRO en page 1.
 *
 * La page libre est à zéro et non recopiée. Une seconde copie de la page embarquée ne servirait
 * rien — l'alternance protège une MUTATION, et il n'y en a pas eu — et surtout, la première
 * mutation du volume restauré écrira sur la page 1 : lui laisser un état antérieur valide
 * offrirait un point de repli à ce qui doit précisément ne plus en avoir.
 *
 * @param {Uint8Array} page
 * @returns {Uint8Array} exactement `TAILLE_FICHIER_ENVELOPPE` octets
 */
export function fichierDEnveloppeDepuisLaPage(page) {
  exigerEnveloppeDeRecuperationSeule(page);
  const fichier = new Uint8Array(PAGE_OCTETS * PAGES);
  fichier.set(page, 0);
  return fichier;
}
