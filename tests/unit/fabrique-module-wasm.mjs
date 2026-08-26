// Fabrique de modules WebAssembly minimaux, pour les épreuves d'isolation (#41) et de garde (#75).
//
// Les modules sont fabriqués ici plutôt que lus dans `vendor/` : une épreuve unitaire ne doit
// dépendre ni du réseau, ni d'artefacts tiers, et surtout elle doit pouvoir exhiber le cas que le
// dépôt ne contient pas — un `v86.wasm` portant une mémoire PARTAGÉE.
//
// Deux épreuves s'en servent : `isolation-inventaire.test.mjs` pour l'analyseur lui-même, et
// `v86-garde-memoire.test.mjs` pour la garde branchée sur `npm run vm:check`. Une fabrique unique
// garantit qu'elles parlent du même octet : deux fabriques divergentes prouveraient deux choses
// différentes en prétendant prouver la même.

/** `\0asm` puis la version, sur quatre octets chacun. */
const EN_TETE = [0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00];

/** Assemble un module minimal à partir de sections déjà encodées. */
export function moduleWasm(...sections) {
  return Uint8Array.from([...EN_TETE, ...sections.flat()]);
}

/** Section « memory » (identifiant 5) portant une seule mémoire. */
export function sectionMemoire(limites) {
  const contenu = [1, ...limites];
  return [5, contenu.length, ...contenu];
}

/** Section « import » (identifiant 2) important `env.memory` avec les limites données. */
export function sectionImportMemoire(limites) {
  const nomModule = [...new TextEncoder().encode("env")];
  const nomChamp = [...new TextEncoder().encode("memory")];
  const contenu = [
    1,
    nomModule.length,
    ...nomModule,
    nomChamp.length,
    ...nomChamp,
    0x02,
    ...limites,
  ];
  return [2, contenu.length, ...contenu];
}

/** Limites non partagées, sans maximum : le cas de `v86.wasm` épinglé par l'ADR 0003. */
export const LIMITES_SIMPLES = Object.freeze([0x00, 1]);
/** Limites PARTAGÉES avec maximum : ce que le drapeau 0x03 encode. */
export const LIMITES_PARTAGEES = Object.freeze([0x03, 1, 2]);
