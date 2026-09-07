// Les MOYENS que la coquille propose, d'après l'inventaire de l'enveloppe (#162, ADR 0029).
//
// « Un seul emplacement à la fois, choisi par le TYPE » : la coquille lit l'inventaire PUBLIC du
// fichier d'enveloppes — le canal auxiliaire assumé de l'[ADR 0020](../../docs/decisions/0020-enveloppe-de-cle.md),
// point 3 des limites — et n'offre que les moyens qui s'y trouvent. **Elle ne devine jamais.**
//
// ## Pourquoi lire l'inventaire plutôt que tout proposer
//
// Une coquille qui offrirait les trois moyens sans regarder ferait dériver une phrase pendant deux
// secondes sur un coffre qui n'a jamais eu d'emplacement `phrase`, pour finir sur
// `VAULT_ENVELOPPE_CLE_REFUSEE` — un refus qui dit « cette clé n'ouvre rien » là où la vérité est
// « ce moyen n'existe pas ici ». L'inventaire est en clair précisément pour que ce cas n'arrive
// pas : « le fichier porte en clair le type et les paramètres de chaque emplacement, précisément
// pour qu'un dérivateur puisse lire les siens AVANT de dériver quoi que ce soit »
// (`ouverture-par-enveloppe.mjs`).
//
// ## Le canal auxiliaire, assumé et borné
//
// Ce que l'inventaire révèle à qui lit le fichier : combien d'emplacements, et de quels types. Le
// choix est celui de l'ADR 0020, et l'ADR 0025 l'a réexaminé pour le type `recuperation` — « si le
// canal auxiliaire élargi devenait inacceptable, la sortie n'est pas de masquer le type : ce serait
// de ne pas créer d'emplacement de récupération sur ce volume ». Cette tranche ne l'élargit pas :
// elle lit ce qui est déjà lisible, DANS l'origine de confiance, et n'en fait rien franchir vers
// l'origine applicative — la réponse d'état du port restreint ne porte toujours que deux champs.

import { TEXTE_TROP_ANCIEN } from "./feuille-de-recuperation.mjs";
import { TYPES_KEK, nomDuTypeKek } from "../vm/enveloppe/identite-enveloppe.mjs";

/**
 * Les trois moyens que CETTE coquille sait servir, et le nom sous lequel elle les désigne.
 *
 * Les noms sont ceux des types de l'ADR 0020, repris tels quels : `phrase`, `webauthn-prf`,
 * `recuperation`. Les renommer pour l'affichage aurait fait exister deux vocabulaires pour la même
 * chose, et un relevé d'épreuve n'aurait plus parlé la langue du fichier qu'il décrit.
 *
 * `harnais` (type 3) n'y est PAS, et c'est la décision 1 de l'ADR 0029 : le jeton de harnais quitte
 * le chemin de produit avec cette tranche. Une enveloppe qui n'aurait qu'un emplacement de ce type
 * est donc annoncée comme non servable, exactement comme un type venu du futur.
 */
export const MOYENS_SERVIS = Object.freeze({
  [TYPES_KEK.phrase]: Object.freeze({
    nom: "phrase",
    typeKek: TYPES_KEK.phrase,
    /** La dérivation a lieu DANS le Worker de confiance : Argon2id gèlerait le fil de la page. */
    derivePar: "worker",
    libelle: "une phrase de déverrouillage",
  }),
  [TYPES_KEK["webauthn-prf"]]: Object.freeze({
    nom: "webauthn-prf",
    typeKek: TYPES_KEK["webauthn-prf"],
    /** `navigator.credentials` n'existe pas dans un Worker (ADR 0021, décision 5). */
    derivePar: "page",
    libelle: "une passkey",
  }),
  [TYPES_KEK.recuperation]: Object.freeze({
    nom: "recuperation",
    typeKek: TYPES_KEK.recuperation,
    derivePar: "worker",
    libelle: "un code de récupération",
  }),
});

/** Les noms des moyens servis, pour qu'un appelant n'ait pas à parcourir la table. */
export const NOMS_SERVIS = Object.freeze(
  Object.values(MOYENS_SERVIS)
    .map((moyen) => moyen.nom)
    .sort(),
);

/** Le moyen servi qui porte ce nom, ou `null`. Aucune approximation, aucun repli. */
export function moyenParNom(nom) {
  return Object.values(MOYENS_SERVIS).find((moyen) => moyen.nom === nom) ?? null;
}

/**
 * Ce que la coquille propose, à partir de l'inventaire.
 *
 * Elle rend TROIS choses, et les trois sont nécessaires :
 *
 *  - `moyens` — ce qu'elle offre, dans l'ordre de l'enveloppe. Un type présent deux fois n'est
 *    offert qu'une : l'utilisateur choisit un MOYEN, pas un emplacement, et deux boutons « phrase »
 *    ne lui apprendraient rien qu'il puisse employer ;
 *  - `inconnus` — les types présents que cette coquille ne sert pas. Ils ne font pas échouer les
 *    autres (c'est la compatibilité du point 5 du contrat de #22), mais ils sont DITS : un coffre
 *    dont un moyen est illisible ici est un coffre dont l'utilisateur doit savoir quelque chose ;
 *  - `avertissement` — la phrase à afficher quand il y a des inconnus, ou `null`.
 *
 * Le champ de version s'appelle `versionEnveloppe` et non `version` : le corps d'un message du
 * contrat ne peut pas porter `version` sans recouvrir celle du CONTRAT, et `enveloppeDeMessage`
 * refuse désormais un corps qui essaierait.
 *
 * @param {{ emplacements: { typeKek: number, identifiantEmplacement: string }[],
 *           versionEnveloppe: number }} inventaire
 */
export function moyensProposes(inventaire) {
  const emplacements = inventaire?.emplacements ?? [];
  const moyens = [];
  const inconnus = [];
  const vus = new Set();
  for (const emplacement of emplacements) {
    const servi = MOYENS_SERVIS[emplacement.typeKek];
    if (servi === undefined) {
      inconnus.push(
        Object.freeze({
          typeKek: emplacement.typeKek,
          // Le NOM du type quand l'ADR 0020 en réserve un — `harnais` en est un —, `null` quand la
          // valeur ne désigne rien de connu. Les deux cas se disent différemment à l'utilisateur.
          nom: nomDuTypeKek(emplacement.typeKek),
        }),
      );
      continue;
    }
    if (vus.has(servi.nom)) continue;
    vus.add(servi.nom);
    moyens.push(
      Object.freeze({ ...servi, identifiantEmplacement: emplacement.identifiantEmplacement }),
    );
  }
  return Object.freeze({
    versionEnveloppe: inventaire?.versionEnveloppe ?? null,
    moyens: Object.freeze(moyens),
    inconnus: Object.freeze(inconnus),
    aUnMoyenDeRecuperation: vus.has("recuperation"),
    avertissement: inconnus.length === 0 ? null : TEXTE_TROP_ANCIEN,
  });
}
