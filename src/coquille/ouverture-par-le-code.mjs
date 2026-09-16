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
// ## Le court-circuit est ABSENT, et c'est la garde
//
// Toutes les KEK candidates sont essayées, même après qu'une a ouvert. Ce n'est pas pour rendre deux
// refus indiscernables — un refus parcourt la liste entière de toute façon —, c'est pour qu'une
// ouverture qui RÉUSSIT coûte le même nombre d'appels AEAD, que le code qui ouvre soit le premier
// rendu ou le septième. Avec court-circuit, le temps d'un déverrouillage désignerait la feuille
// employée, sur un fichier dont le nombre et le type des emplacements sont publics. C'est le motif de
// `developperDansLaPage`, tenu un cran plus haut.
//
// Ce qui est mesuré est ce nombre d'appels (`tests/unit/coquille-ouverture-par-le-code.test.mjs`
// compte les invocations de `SubtleCrypto.decrypt`) ; ce qui ne l'est pas est le temps interne de
// WebCrypto ni le temps d'horloge, que ce dépôt ne prétend pas maîtriser (ADR 0025, limite 9).

import { derivateurRecuperation } from "../vm/derivation/derivateur-recuperation.mjs";
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
 * inventer ici un troisième refus ajouterait un code que personne n'a demandé. Tout autre refus —
 * une page tronquée, une racine qui ne vérifie pas, un rejeu — remonte tel quel : il dit quelque
 * chose du FICHIER, pas de la clé, et le taire derrière « ce code n'ouvre pas » mentirait.
 *
 * @param {{ support: object, identifiantVolume: string, code: string,
 *           derivateur?: { deriver: Function }, versionMinimale?: number | null,
 *           sansEmplacement: () => Error }} appel
 * @returns {Promise<{ dek: Uint8Array, kek: Uint8Array, version: number,
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

  let ouverte = null;
  let refus = null;
  for (const emplacement of emplacements) {
    const kek = await derivateur.deriver({
      parametres: emplacement.parametres,
      identite: {
        identifiantVolume,
        identifiantEmplacement: emplacement.identifiantEmplacement,
      },
      geste: { code },
    });
    let essai;
    try {
      essai = await ouvrirEnveloppe({ support, identifiantVolume, kek, versionMinimale });
    } catch (cause) {
      if (!isEnveloppeError(cause, ENVELOPPE_ERROR_CODES.cleRefusee)) throw cause;
      refus ??= cause;
      continue;
    }
    // Deux emplacements ne peuvent pas répondre au même code — sels et identifiants diffèrent. Si
    // cela arrivait, la seconde clé de volume serait effacée ici plutôt que laissée dans le tas.
    if (ouverte === null) ouverte = Object.freeze({ ...essai, kek });
    else essai.dek.fill(0);
  }
  if (ouverte === null) throw refus;
  return ouverte;
}
