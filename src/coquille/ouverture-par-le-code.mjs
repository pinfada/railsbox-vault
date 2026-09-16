// OUVRIR une enveloppe PAR UN CODE de récupération : ESSAYER chaque emplacement, sans en choisir un
// (#214 ; ADR 0020, ADR 0021, ADR 0025).
//
// ## Pourquoi ce module existe, et pourquoi il n'est pas dans `src/vm/`
//
// L'enveloppe ESSAIE déjà : `developperDansLaPage` (`../vm/enveloppe/etat-de-lenveloppe.mjs`)
// parcourt les huit emplacements d'une page sous UNE clé, sans court-circuit. Ce que
// `ouvrirEnveloppe` ne sait pas faire, et ne doit pas apprendre, c'est CONSTRUIRE les clés : la KEK
// d'un code dépend du sel ET de l'identifiant de son emplacement (ADR 0021), si bien qu'un coffre
// portant N emplacements de type 4 présente N clés candidates pour un seul code. Les dériver est le
// travail de l'appelant ; les essayer TOUTES, sans en choisir une, est ce que ce module tient.
//
// Il vit du côté COQUILLE parce que c'est une règle de conduite, pas une règle de format : le
// fichier d'enveloppes n'a jamais posé « au plus un code » — l'ADR 0025, limite 10, écrit qu'« rien
// n'empêche d'en créer plusieurs », et l'archive les emporte tous
// (`../vm/enveloppe-de-recuperation.mjs`). Aucune ligne de `src/vm/` ne change avec #214.
//
// ## Le défaut qu'il ferme
//
// Le Worker de confiance CHOISISSAIT : `emplacements.find((c) => c.typeKek === 4)`. Un second
// « afficher un nouveau code » — que le rechargement de la page rend ordinaire, puisque le porteur
// de session ne survit pas au Worker — posait un second emplacement valable, et le code rendu était
// ensuite dérivé sous le sel et l'identifiant du PREMIER : KEK fausse, `VAULT_ENVELOPPE_CLE_REFUSEE`
// sur un code que le produit venait lui-même d'imprimer. Le même `find` vivait dans le banc de
// référence. Les deux appellent désormais cette fonction-ci : une divergence entre le produit et son
// banc est exactement ce qui a laissé le défaut vivre.
//
// ## Le court-circuit est ABSENT, QUEL QUE SOIT le refus, et c'est la garde
//
// Toutes les KEK candidates sont essayées, même après qu'une a ouvert, et même après qu'une a été
// REFUSÉE pour une autre raison qu'une clé fausse. Aucun refus ne sort de la boucle. La revue de
// sécurité de la PR #219 l'a mesuré : un `REJEU` n'arrive qu'avec la BONNE clé, si bien qu'un refus
// levé dans la boucle coûtait un essai au premier code rendu et sept au septième — le temps d'un
// refus désignait la feuille employée (constat 1). Et une dérivation refusée hors du `try` — un
// emplacement de type 4 écrit par un produit plus récent — masquait les emplacements suivants
// (constat 2). Le motif est celui de `developperDansLaPage`, tenu un cran plus haut : le coût d'une
// ouverture, réussie ou refusée, ne dépend pas du rang de l'emplacement qui a répondu.
//
// Les refus sont RETENUS pendant la boucle et tranchés après elle, dans cet ordre :
//
//  1. un refus du FICHIER — tout refus de l'enveloppe autre que « clé refusée » (`REJEU`, racine qui
//     ne vérifie pas, page tronquée…), ou une erreur inattendue. Il l'emporte même sur un succès :
//     une ancre de version plus haute que la page est précisément ce qui doit empêcher d'ouvrir, et
//     la clé de volume de l'essai qui avait ouvert est alors effacée avant de lever ;
//  2. un succès ;
//  3. un refus d'un EMPLACEMENT — sa dérivation refusée (`PARAMETRES_REFUSES`) : il dit quelque chose
//     de cet emplacement-là, pas du fichier, et ne masque donc pas le code qu'un autre accepte ;
//  4. « clé refusée », le refus de toujours d'un code étranger bien formé.
//
// Le code, lui, est décodé et CONTRÔLÉ une fois, avant la boucle : un code mal recopié reste refusé
// après la seule lecture de l'inventaire, sans qu'aucune clé soit dérivée ni essayée (ADR 0025,
// décision 2).
//
// Ce qui est mesuré est ce nombre d'appels (`tests/unit/coquille-ouverture-par-le-code.test.mjs`
// compte les invocations de `SubtleCrypto.decrypt`) ; ce qui ne l'est pas est le temps interne de
// WebCrypto ni le temps d'horloge, que ce dépôt ne prétend pas maîtriser (ADR 0025, limite 9).
//
// ## Ce qui est effacé, et ce qui ne l'est pas
//
// Les seize octets décodés du contrôle préalable et la clé de volume d'un essai non retenu sont mis
// à zéro : « fait, non garanti » (ADR 0021, décision 7) — le moteur a pu copier ces octets. Les KEK
// des essais qui n'ouvrent pas ne le sont PAS, parce qu'il n'y a rien à effacer : le dérivateur
// `recuperation` rend une `CryptoKey` non extractible (`deriverKek`), dont les octets ne sont
// jamais dans le tas JavaScript. Un dérivateur injecté qui rendrait des octets verrait sa KEK non
// retenue effacée de la même façon.

import { decoderCode } from "../vm/derivation/code-de-recuperation.mjs";
import { derivateurRecuperation } from "../vm/derivation/derivateur-recuperation.mjs";
import { effacer } from "../vm/derivation/derivateur.mjs";
import { isDerivationError } from "../vm/derivation/derivation-errors.mjs";
import { inventorierEnveloppe, ouvrirEnveloppe } from "../vm/enveloppe-de-cle.mjs";
import { ENVELOPPE_ERROR_CODES, isEnveloppeError } from "../vm/enveloppe/enveloppe-errors.mjs";
import { TYPES_KEK } from "../vm/enveloppe/identite-enveloppe.mjs";

/**
 * Les emplacements de RÉCUPÉRATION d'un inventaire, dans l'ordre du fichier. Jamais le premier seul.
 *
 * @param {{ emplacements?: { typeKek: number }[] }} inventaire
 */
export function emplacementsDeRecuperation(inventaire) {
  const emplacements = inventaire?.emplacements ?? [];
  return emplacements.filter((candidat) => candidat.typeKek === TYPES_KEK.recuperation);
}

/**
 * OUVRE l'enveloppe sous le code présenté, en essayant CHAQUE emplacement de récupération.
 *
 * Le refus d'un coffre sans aucun emplacement de type 4 appartient à l'APPELANT : le Worker de
 * confiance le rend typé pour la coquille, le banc de référence le rend bavard pour l'épreuve, et
 * inventer ici un troisième refus ajouterait un code que personne n'a demandé. Les autres refus
 * sont ceux des modules appelés, jamais repliés sur « ce code n'ouvre pas », et tranchés après la
 * boucle dans l'ordre que l'en-tête de ce fichier décrit.
 *
 * @param {{ support: object, identifiantVolume: string, code: string,
 *           derivateur?: { deriver: Function }, versionMinimale?: number | null,
 *           sansEmplacement: () => Error }} appel
 * @returns {Promise<{ dek: Uint8Array, kek: CryptoKey | Uint8Array, version: number,
 *                     identifiantEmplacement: string, migration: object | null }>}
 */
export async function ouvrirParLeCode({
  support,
  identifiantVolume,
  code,
  derivateur = derivateurRecuperation(),
  versionMinimale = null,
  sansEmplacement,
}) {
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume });
  const emplacements = emplacementsDeRecuperation(inventaire);
  if (emplacements.length === 0) throw sansEmplacement();
  // Contrôle UNIQUE de la somme, avant toute dérivation : les octets rendus ne servent qu'à ça.
  effacer(decoderCode(code));

  let ouverte = null;
  const refus = { fichier: null, emplacement: null, cle: null };
  for (const emplacement of emplacements) {
    let kek = null;
    try {
      kek = await derivateur.deriver({
        parametres: emplacement.parametres,
        identite: {
          identifiantVolume,
          identifiantEmplacement: emplacement.identifiantEmplacement,
        },
        geste: { code },
      });
      const essai = await ouvrirEnveloppe({ support, identifiantVolume, kek, versionMinimale });
      // Deux emplacements ne peuvent pas répondre au même code — sels et identifiants diffèrent.
      // Si cela arrivait, la seconde clé de volume serait effacée ici plutôt que laissée dans le tas.
      if (ouverte === null) {
        ouverte = Object.freeze({ ...essai, kek });
        kek = null;
      } else essai.dek.fill(0);
    } catch (cause) {
      retenirLeRefus(refus, cause);
    } finally {
      effacer(kek);
    }
  }
  if (refus.fichier !== null) {
    ouverte?.dek.fill(0);
    throw refus.fichier;
  }
  if (ouverte !== null) return ouverte;
  throw refus.emplacement ?? refus.cle;
}

/** Range un refus d'essai dans sa classe, en gardant le PREMIER de chacune. */
function retenirLeRefus(refus, cause) {
  if (isEnveloppeError(cause, ENVELOPPE_ERROR_CODES.cleRefusee)) refus.cle ??= cause;
  else if (isDerivationError(cause)) refus.emplacement ??= cause;
  else refus.fichier ??= cause;
}
