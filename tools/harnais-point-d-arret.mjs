// LE POINT D'ARRÊT D'ÉPREUVE des courses entre onglets (#311, C5) — un harnais du serveur de TEST.
//
// ## Ce qu'il fait
//
// Une course entre deux onglets ne se rejoue que si un Worker de produit peut être RETENU à un
// instant précis : après qu'il a lu l'enveloppe, avant qu'il prenne le handle du volume. Le produit
// n'a — et ne doit avoir — aucun crochet pour cela. Ce harnais sert, à la place du module
// `/src/vm/opfs-sync-access.mjs`, une copie dont `openOpfsSyncAccess` — LA porte de tout handle
// exclusif — attend un signal quand l'épreuve l'a « armé ». Sans armement, la copie se comporte
// exactement comme l'original.
//
// ## Pourquoi un serveur, et pas `page.route`
//
// `page.route` et `context.route` interceptent le module d'un Worker dédié sous Chromium ; sous
// Firefox, mesuré le 19/11/2026, le gestionnaire n'est JAMAIS appelé (deux essais, les deux
// formes). Un moteur dont on ne peut pas retenir le Worker n'est pas mesuré — ou l'est par un
// serveur qui sert le module instrumenté, ce qui marche partout.
//
// ## Ce qui le BORNE (même discipline que `--harnais-e2e-hors-ligne`)
//
//  - il n'est actif que par l'ARGUMENT `--harnais-point-d-arret`, que seule
//    `playwright.course-onglets.config.mjs` passe, au seul serveur de la coquille ;
//  - AUCUNE variable d'environnement n'est lue : un `npm start` dont l'environnement porterait un
//    nom de banc ne change pas un octet de ce qu'il sert ;
//  - il ne touche qu'UN chemin, et la transformation est REFUSÉE (la réponse est coupée, l'épreuve échoue) si le
//    module n'a plus la déclaration visée : un point d'arrêt qui ne s'applique pas ne mesure rien.
//
// ## Le protocole, sur un `BroadcastChannel`
//
//  - `{ armer: "<nom>" | "*" }` : le prochain `openOpfsSyncAccess` de ce nom — ou le premier, pour
//    `"*"` — s'arrête, après avoir émis `{ atteint: "<nom>" }` ;
//  - `"desarmer"` : retire l'armement des Workers qui ne l'ont pas consommé. L'épreuve l'envoie dès
//    que la pause voulue est atteinte, pour qu'un AUTRE onglet ne soit pas retenu à son tour ;
//  - `"reprendre"` : relâche la pause.

export const FANION_DU_HARNAIS = "--harnais-point-d-arret";
export const CHEMIN_INSTRUMENTE = "/src/vm/opfs-sync-access.mjs";
export const CANAL_DU_HARNAIS = "harnais-point-d-arret";

const DECLARATION = "export async function openOpfsSyncAccess(name) {";

const PAUSE = `
const __canal = new BroadcastChannel(${JSON.stringify(CANAL_DU_HARNAIS)});
let __arme = null;
let __reprendre = null;
__canal.onmessage = ({ data }) => {
  if (data === "desarmer") __arme = null;
  else if (data === "reprendre") __reprendre?.();
  else if (typeof data?.armer === "string") __arme = data.armer;
};
export async function openOpfsSyncAccess(name) {
  if (__arme !== null && (__arme === "*" || __arme === name)) {
    __arme = null;
    await new Promise((reprise) => {
      __reprendre = reprise;
      __canal.postMessage({ atteint: name });
    });
  }
  return openOpfsSyncAccessOrigine(name);
}
`;

/**
 * La copie instrumentée d'une source de `opfs-sync-access.mjs`.
 *
 * @param {string} source
 * @returns {string}
 * @throws {Error} si la déclaration visée n'apparaît pas EXACTEMENT une fois
 */
export function instrumenter(source) {
  if (source.split(DECLARATION).length !== 2) {
    throw new Error("point d'arrêt inapplicable : la déclaration de openOpfsSyncAccess a changé");
  }
  return source.replace(DECLARATION, "async function openOpfsSyncAccessOrigine(name) {") + PAUSE;
}

/** Le harnais est-il demandé ? L'ARGUMENT seul le dit : `argv`, jamais l'environnement. */
export function harnaisDemande(argv) {
  return argv.includes(FANION_DU_HARNAIS);
}
