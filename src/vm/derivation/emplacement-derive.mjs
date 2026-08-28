// PRÉPARER un emplacement dont la clé est DÉRIVÉE (#22, ADR 0021).
//
// ## L'ordre des deux tirages, et l'amendement qu'il porte à l'ADR 0020
//
// L'info d'HKDF lie l'identifiant d'EMPLACEMENT (décision 2 de l'ADR 0021). Une KEK ne peut donc
// pas être dérivée avant que l'emplacement n'ait un identifiant — or #21 tirait cet identifiant à
// l'INTÉRIEUR de `creerEnveloppe`, au moment de sceller. Les deux ne tiennent pas ensemble, et le
// défaut est apparu en écrivant la première épreuve, pas en relisant l'ADR.
//
// L'ADR 0021 amende donc l'ADR 0020 d'une ligne : `creerEnveloppe`, `ajouterEmplacement` et
// `remplacerEmplacement` acceptent un `identifiantEmplacement` FOURNI. Le défaut ne change pas — il
// est toujours tiré à l'intérieur —, et l'unicité reste garantie par le tirage : ce module tire
// avec `crypto.getRandomValues`, comme #21 le faisait, et l'enveloppe refuse un identifiant déjà
// présent. Ce qui change est seulement QUI tire, et il fallait que ce soit celui qui dérive.
//
// La conséquence vaut d'être dite : **remplacer une clé re-dérive**. L'ADR 0020 fait déjà changer
// l'identifiant d'emplacement à chaque remplacement, pour que le même nom ne désigne pas deux
// secrets successifs ; la KEK étant liée à cet identifiant, elle change forcément avec lui. Ce
// n'est pas un coût nouveau : remplacer une clé, c'est justement en fabriquer une autre.

import { tirerIdentifiantEmplacement } from "../enveloppe/identite-enveloppe.mjs";

/**
 * Tire l'identifiant d'un emplacement neuf, puis DÉRIVE sa KEK sous cette identité.
 *
 * Rien n'est écrit : ce module ne touche à aucun support. L'appelant reçoit de quoi appeler
 * `creerEnveloppe` ou `ajouterEmplacement`, et c'est lui qui décide si l'emplacement existe.
 *
 * @param {{ identifiantVolume: string, derivateur: { type: number, deriver: Function },
 *           parametres: Uint8Array, geste: object }} appel
 * @returns {Promise<{ identifiantEmplacement: string, kek: CryptoKey, typeKek: number,
 *                     parametres: Uint8Array }>}
 */
export async function preparerEmplacementDerive({
  identifiantVolume,
  derivateur,
  parametres,
  geste,
}) {
  const identifiantEmplacement = tirerIdentifiantEmplacement();
  const kek = await derivateur.deriver({
    parametres,
    identite: { identifiantVolume, identifiantEmplacement },
    geste,
  });
  return Object.freeze({
    identifiantEmplacement,
    kek,
    typeKek: derivateur.type,
    parametres,
  });
}
