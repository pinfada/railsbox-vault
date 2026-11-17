// La PRÉPARATION d'un démarrage et le CONSTAT de la page, avec le repli hors connexion (#247, D1g).
//
// Scindé de `application-de-reference.mjs` (691 lignes avant D1g, seuil d'alerte de 700) : le fichier ne
// pouvait plus accueillir la lecture du descripteur rangé, son refus typé et son rangement. Ce module
// enchaîne ce que `demarrerLaVm` et `dephasagePourLaPage` font AVANT tout boot : lire le descripteur
// (l'origine d'abord, le rangé seulement si elle est injoignable), décider du déphasage, refuser.

import {
  constaterLeDephasage,
  decisionPubliee,
  preparerLeDemarrage,
} from "./mise-a-jour-applicative.mjs";
import { lireLeDescripteur } from "./descripteur-applicatif.mjs";
import {
  horsConnexionPublie,
  lireLeDescripteurDuDemarrage,
  rangerLeDescripteur,
  refusDuRepli,
} from "./hors-connexion.mjs";
import { CODES_REFUS_COQUILLE as C, messageDeRefus } from "./refus-de-coquille.mjs";
import { ouvrirLeMagasinOpfs } from "../vm/magasin-opfs.mjs";

/** Un démarrage REFUSÉ par le déphasage, avant ou pendant le boot : son code, son message, la décision. */
export function refusDeDemarrage(code, prepare) {
  return { demarree: false, code, motif: messageDeRefus(code), dephasage: prepare.dephasage };
}

/**
 * LIT le descripteur et PRÉPARE le démarrage. Rend `{ lu, prepare }` pour poursuivre, ou `{ rendu }` :
 * la réponse d'un démarrage refusé avant tout boot, qui n'a écrit aucun octet du volume.
 *
 * L'ordre est celui de la défiance : injoignable sans rangé accepté, d'abord ; puis la décision de
 * déphasage (ADR 0042) — qui confronte le rangé à la version du volume ; puis, hors connexion, le
 * coffre sans volume : l'installation demande la graine, que le magasin ne garde pas.
 *
 * @param {{ cleDeVolume: () => Promise<Uint8Array>, nom: string, miseAJour: boolean,
 *           delaiMs: number, lire?: Function, lireManifeste?: Function }} entrees
 *   `lire` et `lireManifeste` sont injectés par les épreuves ; le produit n'en passe aucun.
 */
export async function lireEtPreparer({
  cleDeVolume,
  nom,
  miseAJour,
  delaiMs,
  lire = lireLeDescripteurDuDemarrage,
  lireManifeste,
}) {
  // L'origine d'abord ; le descripteur rangé et scellé seulement si elle est INJOIGNABLE (#247, D1g).
  const lu = await lire({ cleDeVolume });
  if (lu.horsConnexion === true && lu.present === false) {
    return { rendu: refusDeDemarrage(lu.code, {}) };
  }
  // Le DÉPHASAGE est décidé ICI, avant toute installation et tout boot (#236 T2, ADR 0042) : le
  // manifeste du coffre est lu, confronté au descripteur, et un refus rend la main sans qu'un octet
  // du volume ait été écrit.
  const prepare = await preparerLeDemarrage({ lu, nom, miseAJour, delaiMs, lireManifeste });
  if (prepare.sansApplication) return { rendu: { demarree: false, motif: prepare.motif } };
  if (prepare.refus !== undefined) return { rendu: refusDeDemarrage(prepare.refus, prepare) };
  const refus = refusDuRepli({ lu, manifeste: prepare.manifeste });
  if (refus !== null) return { rendu: refusDeDemarrage(refus, prepare) };
  return { lu, prepare };
}

/** La décision publiée d'un refus du repli : aucun coffre, aucune version, un code — et rien à démarrer. */
function refusPublieHorsConnexion(code) {
  return {
    issue: "refus",
    code,
    coffre: null,
    servie: null,
    migration: false,
    plusTard: false,
    reprise: false,
    cible: null,
    horsConnexion: null,
  };
}

/**
 * Ce que la PAGE apprend du déphasage, après le déverrouillage et avant tout boot (#236 T2) : la
 * décision publiée — refus, ou bloc « Mettre à jour l'application » — et, si l'origine est injoignable,
 * la date de la dernière vérification de la version gardée. Rien n'est écrit, rien n'est booté ; le
 * démarrage REDÉCIDE de lui-même, la page n'est pas crue.
 *
 * Sans clé du coffre, pas de repli : le descripteur rangé est scellé sous elle.
 */
export async function constaterPourLaPage({ nom, cleDeVolume, recuperer, magasin, lireManifeste }) {
  const lu =
    cleDeVolume === undefined
      ? await lireLeDescripteur({ recuperer })
      : await lireLeDescripteurDuDemarrage({
          cleDeVolume,
          ...(recuperer === undefined ? {} : { recuperer }),
          ...(magasin === undefined ? {} : { magasin }),
        });
  const { decision, manifeste } = await constaterLeDephasage({
    lu,
    nom,
    ...(lireManifeste === undefined ? {} : { lireManifeste }),
  });
  const refus = refusDuRepli({ lu, manifeste });
  if (refus !== null) return refusPublieHorsConnexion(refus);
  return { ...decisionPubliee(decision), horsConnexion: horsConnexionPublie(lu) };
}

/**
 * Ce qui précède l'inscription de l'intention, une fois TOUT acquis et vérifié : le rangement du
 * descripteur (jamais avant : #247, décision n° 5), sauf hors connexion, où il vient d'être lu du
 * magasin et n'a rien de neuf à y mettre.
 *
 * @param {{ horsConnexion: object | null, cleDeVolume: () => Promise<Uint8Array>,
 *           descripteur: object, runtime: { manifesteV86: object } }} entrees
 */
export function rangementAvantLIntention({
  horsConnexion,
  cleDeVolume,
  descripteur,
  runtime,
  magasin = ouvrirLeMagasinOpfs(),
}) {
  return async ({ reserveComplete }) => {
    if (horsConnexion !== null) return;
    await rangerLeDescripteur({
      magasin,
      cleDeVolume,
      descripteur,
      manifesteV86: runtime.manifesteV86,
      complet: reserveComplete,
    });
  };
}

/** Le refus typé d'un artefact absent hors connexion, ou `null` : toute autre erreur n'est pas de ce module. */
export function refusDeLArtefactAbsent(erreur) {
  return erreur?.code === C.horsLigneArtefactAbsent ? erreur.code : null;
}
