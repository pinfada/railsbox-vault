// La RÉTENTION du paquet précédent, côté fabrication (recette QA de la PR #249, Q5).
//
// `artifacts/reference-image/` porte au plus deux contrats : `paquet.json` (le courant, servi) et
// `paquet-precedent.json` (la rétention 1, pour « Plus tard »). La recette a montré trois fautes de
// l'outil : fabriquer une version déjà retenue comme précédent en retirait les images SANS le dire ;
// `image:manifest` répondait ensuite « construire l'image d'abord », ce qui n'était pas la cause ; et
// aucun geste ne retirait un précédent pour servir une version seule. Ce module porte les trois
// réponses : dire, refuser ce qui casserait, et retirer sur demande.

import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

/** Les deux contrats qu'un dossier d'artefacts peut porter. */
export const CONTRATS = Object.freeze({
  courant: "paquet.json",
  precedent: "paquet-precedent.json",
});

/** Le contrat `nom` du dossier, ou `null` s'il n'existe pas ou ne se lit pas. */
export function lireContrat(dossier, nom) {
  const chemin = join(dossier, nom);
  if (!existsSync(chemin)) return null;
  try {
    return JSON.parse(readFileSync(chemin, "utf8"));
  } catch {
    return null;
  }
}

/** Les fichiers d'images qu'un contrat désigne : brutes et servies, code et graine. */
export function imagesDuContrat(contrat) {
  return [
    contrat?.image?.name,
    contrat?.image?.servi?.name,
    contrat?.graine?.name,
    contrat?.graine?.servi?.name,
  ].filter((nom) => typeof nom === "string" && nom !== "");
}

const nommer = (contrat) => `${contrat.application.id} ${contrat.application.version}`;

/**
 * RETIRE le précédent : son contrat et ses images — sauf celles que `garder` nomme, qu'un courant
 * fabriqué à l'identique partage. Rend les lignes qui disent ce qui a été retiré.
 *
 * @param {string} dossier @param {{ garder?: string[] }} [options]
 */
export function retirerLePrecedent(dossier, { garder = [] } = {}) {
  const precedent = lireContrat(dossier, CONTRATS.precedent);
  if (precedent === null) {
    return ["→ aucun paquet précédent à retirer : le descripteur sert déjà une version seule."];
  }
  const retirees = imagesDuContrat(precedent).filter(
    (nom) => !garder.includes(nom) && existsSync(join(dossier, nom)),
  );
  for (const nom of retirees) rmSync(join(dossier, nom));
  rmSync(join(dossier, CONTRATS.precedent));
  return [
    `→ précédent retiré : ${nommer(precedent)} (${retirees.length} image(s) et ${CONTRATS.precedent})`,
    "→ suite : `npm run image:manifest` — le descripteur servira la version courante seule.",
  ];
}

/**
 * CONFRONTE une fabrication à ce que le dossier retient déjà, AVANT de construire quoi que ce soit.
 *
 *  - Fabriquer un PRÉCÉDENT de la même application et de la même version que le courant retirerait
 *    les images du courant : refusé, avec le geste qui convient.
 *  - Fabriquer un COURANT de la même application et de la même version que le précédent retire les
 *    images du précédent (même préfixe) : ce précédent n'en serait plus un — il sera retiré avec
 *    son contrat, et la fabrication le DIT.
 *
 * @param {{ dossier: string, role: string, id: string, version: string }} fabrication
 * @returns {{ retirerLePrecedent: boolean, lignes: string[] }}
 */
export function confronterALaRetention({ dossier, role, id, version }) {
  const autre = lireContrat(
    dossier,
    role === CONTRATS.precedent ? CONTRATS.courant : CONTRATS.precedent,
  );
  const meme = autre?.application?.id === id && autre?.application?.version === version;
  if (!meme) return { retirerLePrecedent: false, lignes: [] };
  if (role === CONTRATS.precedent) {
    throw new Error(
      `refus : ${id} ${version} est déjà le paquet COURANT — un précédent est une version ` +
        "ANTÉRIEURE de la même application : fabriquez-le avec une version plus ancienne " +
        "(`--version`), ou fabriquez d'abord le nouveau paquet courant.",
    );
  }
  return {
    retirerLePrecedent: true,
    lignes: [
      `→ ${CONTRATS.precedent} désignait ${id} ${version}, la version que vous fabriquez : ce n'est ` +
        "plus un précédent. Il est retiré avec ses images ; le descripteur servira cette version seule.",
    ],
  };
}
