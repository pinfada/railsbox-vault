// Importer un module de `public/` tel qu'il est servi, dans Node (voir `support-resolution-absolue.mjs`).

import { register } from "node:module";

let enregistre = false;

/** @param {string} chemin chemin depuis la racine du dépôt, par exemple `public/coquille/x.mjs` */
export async function importerLaPage(chemin) {
  if (!enregistre) {
    register("./support-resolution-absolue.mjs", import.meta.url);
    enregistre = true;
  }
  return import(new URL(`../../${chemin}`, import.meta.url).href);
}
