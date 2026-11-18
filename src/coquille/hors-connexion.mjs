// Le DÉMARRAGE HORS CONNEXION : quand l'origine est INJOIGNABLE, la dernière version vérifiée fait foi
// (#247, lot D1g ; ADR 0044 § 6, ADR 0046 ; amendement du 04/10/2026 de l'ADR 0042).
//
// ## « Injoignable » est un fait de réseau, et un seul
//
// `fetch` LÈVE un `TypeError` quand il n'a obtenu aucune réponse (hors ligne, DNS, connexion refusée).
// C'est le SEUL cas où le descripteur rangé est consulté. Un délai (`AbortError`), une réponse HTTP —
// 404, 500, 503 —, un descripteur différent ou du HTML de portail captif sont des réponses de
// l'origine, ou l'absence de celle-ci qui ne dit pas « pas de réseau » : l'ADR 0042 s'applique telle
// quelle, l'origine fait foi, et la copie rangée n'est ni lue ni crue. Une origine qui répond mal ne
// donne à personne un droit au repli — sans quoi une réponse d'erreur forgée suffirait à faire
// démarrer l'ancien code.
//
// ## Ce que le repli rend, et ce qui le suit
//
// Le descripteur rangé repasse par `deciderLeDephasage` comme un descripteur servi : sa version est
// confrontée à celle du coffre — une version ANTÉRIEURE à celle déjà migrée dans le volume est
// refusée (`applicationAnterieure`, garde de l'ADR 0042) —, puis les artefacts sont lus au magasin,
// chacun vérifié contre son empreinte épinglée. La personne apprend qu'elle travaille hors connexion,
// avec la date de la dernière vérification.
//
// ## Le rangement : après une acquisition complète, ou pas du tout
//
// Le descripteur n'est rangé qu'une fois TOUS les artefacts acquis et vérifiés, et seulement si le
// magasin les garde tous : ranger une promesse que la réserve ne tient pas ferait échouer un démarrage
// hors connexion au lieu de l'empêcher proprement. Quand la réserve est incomplète, le descripteur
// précédent est OUBLIÉ — il décrit des artefacts que la rétention vient de retirer.

import { deriverCleDeScellementDuDescripteur } from "../vm/derivation/cle-du-descripteur-scelle.mjs";
import { ouvrirLeMagasinOpfs } from "../vm/magasin-opfs.mjs";
import { lireLeDescripteur } from "./descripteur-applicatif.mjs";
import {
  DescripteurRangeRefuse,
  ouvrirLeDescripteurScelle,
  sceller,
} from "./descripteur-scelle.mjs";
import { IDENTIFIANT_DU_COFFRE } from "./identites-du-coffre.mjs";
import { CODES_REFUS_COQUILLE as C, messageDeRefus } from "./refus-de-coquille.mjs";

/**
 * Dérive la clé de scellement depuis la clé du coffre, et efface la clé du coffre dès que c'est fait.
 *
 * @param {() => Promise<Uint8Array>} cleDeVolume
 */
async function cleDeScellement(cleDeVolume) {
  const dek = await cleDeVolume();
  try {
    return await deriverCleDeScellementDuDescripteur({
      cleMaitresse: dek,
      identifiantVolume: IDENTIFIANT_DU_COFFRE,
    });
  } finally {
    dek.fill(0);
  }
}

const sansDescripteur = (code, motif = messageDeRefus(code)) => ({
  present: false,
  horsConnexion: true,
  code,
  motif,
});

/**
 * Le REPLI de `lireLeDescripteur` quand `fetch` a levé un `TypeError` : lit le descripteur rangé, le
 * vérifie sous la clé du coffre, et le rend comme un descripteur lu — marqué `horsConnexion`.
 *
 * Rend toujours un `lu` : `{ present: true, descripteur, horsConnexion: { rangeLe, manifesteV86 } }`,
 * ou `{ present: false, horsConnexion: true, code, motif }` avec un code typé. Un refus ne retombe
 * jamais sur autre chose : pas de descripteur « au mieux ».
 *
 * @param {{ magasin: { lireLeDescripteurScelle(): Promise<Uint8Array | null> } | null,
 *           cleDeVolume: () => Promise<Uint8Array>,
 *           signaler?: (message: string) => void }} entrees
 * @returns {() => Promise<object>}
 */
export function repliHorsConnexion({
  magasin,
  cleDeVolume,
  signaler = (message) => globalThis.console?.warn(message),
}) {
  return async () => {
    const octets = await magasin?.lireLeDescripteurScelle().catch(() => null);
    if (octets === null || octets === undefined) return sansDescripteur(C.horsLigneSansCopie);
    const cle = await cleDeScellement(cleDeVolume);
    try {
      const { descripteur, manifesteV86, rangeLe } = await ouvrirLeDescripteurScelle({
        octets,
        cle,
      });
      return { present: true, descripteur, horsConnexion: { rangeLe, manifesteV86 } };
    } catch (erreur) {
      if (!(erreur instanceof DescripteurRangeRefuse)) throw erreur;
      // Le journal dit POURQUOI (format, sceau, contenu) ; la personne lit une conduite, pas un détail.
      signaler(`${erreur.code} : ${erreur.message}`);
      return sansDescripteur(erreur.code);
    }
  };
}

/**
 * RANGE le descripteur acquis — ou, si la réserve est incomplète, OUBLIE le précédent.
 *
 * Ne lève jamais : le magasin est un cache, et un rangement manqué coûte seulement le hors ligne.
 *
 * @param {{ magasin: object | null, cleDeVolume: () => Promise<Uint8Array>, descripteur: object,
 *           manifesteV86: object, complet: boolean, maintenant?: () => number,
 *           signaler?: (message: string) => void }} entrees
 * @returns {Promise<"range" | "oublie" | "absent" | "echec">}
 */
export async function rangerLeDescripteur({
  magasin,
  cleDeVolume,
  descripteur,
  manifesteV86,
  complet,
  maintenant = Date.now,
  signaler = (message) => globalThis.console?.warn(message),
}) {
  if (!magasin) return "absent";
  try {
    if (complet !== true) {
      await magasin.oublierLeDescripteurScelle();
      return "oublie";
    }
    const octets = await sceller({
      descripteur,
      manifesteV86,
      rangeLe: maintenant(),
      cle: await cleDeScellement(cleDeVolume),
    });
    return (await magasin.ecrireLeDescripteurScelle(octets)) ? "range" : "echec";
  } catch (erreur) {
    signaler(
      `VAULT-ARTEFACTS-DESCRIPTEUR-NON-RANGE : ${erreur?.code ?? erreur?.name ?? "erreur"}.`,
    );
    return "echec";
  }
}

// --- Le câblage du démarrage et du constat de la page --------------------------------------------

/**
 * LIT le descripteur pour un démarrage ou un constat : l'origine d'abord, et seulement si elle est
 * INJOIGNABLE (`TypeError` de `fetch`) le descripteur rangé, vérifié sous la clé du coffre.
 *
 * @param {{ cleDeVolume: () => Promise<Uint8Array>, recuperer?: typeof fetch, magasin?: object | null }} entrees
 */
export function lireLeDescripteurDuDemarrage({
  cleDeVolume,
  recuperer = globalThis.fetch,
  magasin = ouvrirLeMagasinOpfs(),
}) {
  return lireLeDescripteur({
    recuperer,
    repliHorsConnexion: repliHorsConnexion({ magasin, cleDeVolume }),
  });
}

/**
 * Le code du refus que le repli hors connexion impose AVANT toute décision de déphasage, ou `null` :
 *  - l'origine est injoignable et le rangé manque ou n'est pas accepté (`lu.code`) ;
 *  - l'origine est injoignable et le coffre n'a pas de volume : installer demande la graine, que le
 *    magasin ne garde pas, et la garde « pas antérieur à la version migrée » n'a rien à comparer.
 *
 * @param {{ lu: object, manifeste: object | null }} entrees
 */
export function refusDuRepli({ lu, manifeste }) {
  if (lu.horsConnexion === undefined) return null;
  if (lu.present === false) return lu.code;
  return manifeste === null ? C.horsLigneSansCoffre : null;
}

/**
 * Ce que la page et le compte rendu publient du repli : la date de la dernière vérification et la
 * version — des valeurs simples —, ou `null` quand l'origine a répondu.
 *
 * @param {object} lu
 */
export function horsConnexionPublie(lu) {
  if (lu.horsConnexion === undefined || lu.horsConnexion === true || !lu.present) return null;
  return { rangeLe: lu.horsConnexion.rangeLe, version: lu.descripteur.application.version };
}
