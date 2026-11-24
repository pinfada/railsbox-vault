// La DÉCISION PURE du portail de la réserve (#299, ADR 0048 § 7, étape 4). Un refus porte un code typé ET
// une cause de diagnostic, jamais montrée. Aucun Worker n'est créé tant que `autorise` n'est pas vrai.
//
// Cette décision NE SUFFIT PAS : elle est prise sur ce qui a été observé jusque-là, et une décision
// « autorise » prise avant une attente est périmée à la reprise. La dernière garde (`reserve-portail.mjs`)
// relit l'état de révocation partagé dans le même tour que `new Worker`.

import { CODES_REFUS_COQUILLE as C } from "./refus-de-coquille.mjs";
import { ETATS_DE_FRAICHEUR as E } from "./reserve-fraicheur.mjs";

const refuser = (code, cause, detail) => ({
  autorise: false,
  code,
  cause,
  ...(detail === undefined ? {} : { detail }),
});

/**
 * @param {{ sequencePage: number,
 *           identite: null | { retrait?: boolean, sequence?: number },
 *           verification: null | { manquants?: string[], alteres?: string[] },
 *           fraicheur: { effet: string },
 *           causeDeRevocation: "plancher" | "retrait" | null,
 *           controleurChange: boolean }} observation
 */
export function decider({
  sequencePage,
  identite,
  verification,
  fraicheur,
  causeDeRevocation,
  controleurChange,
}) {
  if (identite === null || identite === undefined)
    return refuser(C.reserveAbsente, "silence-du-sw");
  if (identite.retrait === true) return refuser(C.reservePerimee, "retrait");
  if (controleurChange) return refuser(C.reserveDivergente, "controleur-change");
  if (identite.sequence !== sequencePage) return refuser(C.reserveDivergente, "sequence");
  // Le contrôleur ACTIF porte lui-même un plancher supérieur à la séquence de la page : cette page est révoquée
  // (une version dont l'activation a suivi une révocation, ADR 0048 § 9).
  if (identite.plancher > sequencePage) return refuser(C.reservePerimee, "plancher");
  if (verification === null || verification === undefined) {
    return refuser(C.reserveAbsente, "silence-du-sw");
  }
  if (verification.manquants?.length > 0) {
    return refuser(C.reserveIncomplete, "entrees-manquantes", verification.manquants);
  }
  if (verification.alteres?.length > 0) {
    return refuser(C.reserveAlteree, "entrees-alterees", verification.alteres);
  }
  if (fraicheur === E.REVOCATION_CONNUE) {
    return refuser(C.reservePerimee, causeDeRevocation ?? "plancher");
  }
  return { autorise: true, code: null, cause: null };
}
