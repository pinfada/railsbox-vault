// LA REVALIDATION SOUS LE HANDLE du déverrouillage (#311, tranche C5 du lot C ; ADR 0020, 0026, 0029).
//
// ## La course que ce module ferme
//
// Le Worker de confiance ouvre l'enveloppe — et obtient la clé de volume — AVANT de prendre le handle
// exclusif du volume : la clé de volume est nécessaire à l'ouvreur, et l'enveloppe ne peut pas se
// lire sous un handle qu'on n'a pas. Entre les deux, un AUTRE onglet qui tient le volume peut
// révoquer l'emplacement, puis fermer. Le premier onglet prenait alors le handle libre et ouvrait le
// volume sous une KEK que l'enveloppe refuse déjà : « coffre ouvert », clé révoquée, et toute
// révocation ultérieure depuis cette session échouait. Le spike `spike/c1-course-onglets` @ `3ca0c6c`
// l'a démontré ; `tests/browser/coquille-course-entre-onglets.spec.mjs` le rejoue sur le Worker de
// produit.
//
// ## Le remède : deux passes
//
//  1. **passe 1, hors handle, en LECTURE SEULE** (`enLectureSeule`) : elle obtient la clé de volume.
//     Elle n'écrit rien — pas même la migration de page v1→v2, qui est une écriture d'enveloppe ;
//  2. **passe 2, SOUS le handle** (`revaliderSousLeHandle`, appelée par l'ouvreur dès le handle pris
//     et AVANT toute écriture ou tout accès authentifié) : l'enveloppe est rouverte sous la même KEK,
//     et deux choses sont exigées — le MÊME emplacement, la MÊME clé de volume — AVANT toute écriture
//     (la migration d'une page v1 ne se joue qu'ensuite, sous le handle). Tant que ce Worker
//     tient le handle, aucun autre onglet ne peut plus retirer une clé : tout geste qui en retire une
//     (`revoquerToutSauf`, `ajouterEmplacement` du moyen de récupération) exige un coffre ouvert,
//     donc un handle tenu.
//
// ## Ce que ce module ne fait PAS
//
// Il ne retire pas la clé de volume à qui l'a déjà eue : « révoquer ne rechiffre pas », limite 12 de
// `SECURITY.md`, et la rotation de la clé de volume reste hors périmètre. Il ne ferme pas non plus la
// course entre deux CRÉATIONS (ou une création et une restauration) d'un coffre neuf : aucune clé n'y
// est retirée à personne, et c'est une autre issue.

import { ouvrirEnveloppe } from "../vm/enveloppe-de-cle.mjs";
import { cleRefusee } from "../vm/enveloppe/enveloppe-errors.mjs";

/**
 * Le support de la PASSE 1 : l'enveloppe se LIT, elle ne s'écrit pas.
 *
 * `ouvrirEnveloppe` migre une page v1 en l'écrivant, et une écriture faite avant la prise du handle
 * est exactement ce que #311 interdit : un onglet en retard pouvait republier l'ANCIENNE liste
 * d'emplacements par-dessus une révocation. L'écriture refusée ici est avalée par la migration, qui
 * rend « non faite » — la passe 2 la rejoue sous le handle.
 *
 * @template {{ allouer: Function, ecrire: Function, barriere: Function }} S
 * @param {S} support
 * @returns {S}
 */
export function enLectureSeule(support) {
  const refuser = () => {
    throw new Error("L'enveloppe est en lecture seule avant la prise du handle du volume (#311).");
  };
  return Object.freeze({ ...support, allouer: refuser, ecrire: refuser, barriere: refuser });
}

/** Égalité sans court-circuit : le temps ne dépend pas du rang du premier octet qui diffère. */
export function memesOctets(a, b) {
  let ecart = a.length ^ b.length;
  for (let index = 0; index < a.length; index += 1) ecart |= a[index] ^ (b[index] ?? 0);
  return ecart === 0;
}

/** Le même emplacement ET la même clé de volume, ou le refus d'une clé inconnue. */
function exigerLaMemeIdentite(sous, ouverte, identifiantVolume) {
  if (
    sous.identifiantEmplacement !== ouverte.identifiantEmplacement ||
    !memesOctets(sous.dek, ouverte.dek)
  ) {
    throw cleRefusee({ volume: identifiantVolume });
  }
}

/**
 * REVALIDE, sous le handle exclusif, ce que la passe 1 a obtenu.
 *
 * ## En LECTURE SEULE d'abord, et la migration seulement après (revue de la PR #314, constat 2)
 *
 * `ouvrirEnveloppe` migre une page v1 en l'ÉCRIVANT, avant de rendre la main : une revalidation qui
 * l'appelait telle quelle écrivait — deux écritures, deux barrières — sur une enveloppe qu'elle allait
 * ensuite REFUSER (une page v1 sous la même KEK, mais une autre clé de volume). La passe 2 ouvre donc
 * l'enveloppe sur un support en lecture seule, compare, et ne migre — sous le handle, sur le support
 * réel — que si l'identité est confirmée. Un refus n'écrit jamais.
 *
 * Le refus d'une clé révoquée est celui de l'enveloppe (`VAULT_ENVELOPPE_CLE_REFUSEE`), le même que
 * pour une clé inconnue et par le même parcours ; une divergence d'emplacement ou de clé de volume est
 * refusée sous ce code aussi. Chaque clé de volume rendue par cette passe est effacée quoi qu'il
 * arrive ; celle de la passe 1 reste à l'appelant. En cas de succès, `ouverte.version` et
 * `ouverte.migree` prennent les valeurs de cette passe, l'autoritaire.
 *
 * `ouvrir` est la couture des épreuves — l'ouverture d'enveloppe réelle par défaut — : elle permet de
 * dire ce que devient la clé de chaque ouverture, qu'aucun appelant ne revoit.
 *
 * @param {{ support: object, identifiantVolume: string, ouvrir?: typeof ouvrirEnveloppe,
 *           ouverte: { kek: unknown, dek: Uint8Array, identifiantEmplacement: string,
 *                      versionMinimale: number | null, version: number, migree: boolean } }} appel
 */
export async function revaliderSousLeHandle({
  support,
  identifiantVolume,
  ouverte,
  ouvrir = ouvrirEnveloppe,
}) {
  const appel = { identifiantVolume, kek: ouverte.kek, versionMinimale: ouverte.versionMinimale };
  const rendues = [];
  try {
    let sous = await ouvrir({ ...appel, support: enLectureSeule(support) });
    rendues.push(sous.dek);
    exigerLaMemeIdentite(sous, ouverte, identifiantVolume);
    // Une page v1 : l'identité est confirmée, la migration se joue SOUS le handle.
    if (sous.migration !== null) {
      sous = await ouvrir({ ...appel, support });
      rendues.push(sous.dek);
      exigerLaMemeIdentite(sous, ouverte, identifiantVolume);
    }
    ouverte.version = sous.version;
    ouverte.migree = sous.migration?.faite === true;
  } finally {
    for (const dek of rendues) dek.fill(0);
  }
}
