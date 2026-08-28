// Le CATALOGUE des dérivateurs : quel type de clé de déverrouillage ce déploiement sait servir.
//
// Il existe pour le point 5 du contrat de #22, et il n'a qu'une décision à porter : **un type
// d'emplacement que ce catalogue ne sert pas est un REFUS TYPÉ, jamais une tentative.**
//
// C'est une question de compatibilité et non de sécurité, et elle se pose dès qu'une version
// ultérieure ajoutera un moyen (des codes de secours, #23). Un lecteur qui « essaierait quand
// même » sur un type qu'il ne connaît pas dériverait sous des paramètres qu'il interprète de
// travers, obtiendrait une clé fausse, et l'utilisateur lirait « clé refusée » là où la vérité est
// « ce Vault est trop ancien pour ce coffre ». Les deux remèdes n'ont rien de commun : l'un est de
// retaper une phrase, l'autre est de mettre à jour.
//
// Le catalogue ne CRÉE aucun dérivateur : il en reçoit. C'est ce qui laisse une épreuve en poser un
// déterministe, et le Worker de confiance poser les vrais avec leurs primitives.

import { nomDuTypeKek } from "../enveloppe/identite-enveloppe.mjs";
import { typeInconnu } from "./derivation-errors.mjs";

/**
 * @param {Record<number, { type: number, deriver: Function }>} derivateurs indexés par type de KEK
 * @returns {{ pour: (typeKek: number) => object, types: readonly number[] }}
 */
export function catalogueDeDerivateurs(derivateurs) {
  const table = new Map();
  for (const [cle, derivateur] of Object.entries(derivateurs)) {
    const type = Number(cle);
    if (derivateur.type !== type) {
      throw new Error(
        `Catalogue incohérent : le dérivateur inscrit sous le type ${type} déclare le type ${derivateur.type}.`,
      );
    }
    table.set(type, derivateur);
  }
  return Object.freeze({
    types: Object.freeze([...table.keys()]),
    pour: (typeKek) => {
      const trouve = table.get(typeKek);
      if (trouve === undefined) {
        throw typeInconnu({
          typeKek,
          nom: nomDuTypeKek(typeKek),
          servis: [...table.keys()],
        });
      }
      return trouve;
    },
  });
}
