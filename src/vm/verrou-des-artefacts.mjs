// Le VERROU des artefacts du démarrage : une seule acquisition à la fois par origine (#348).
//
// Deux acquisitions peuvent désormais courir sur la même origine : le TÉLÉCHARGEMENT ANTICIPÉ, lancé
// pendant les étapes 1 à 3 du parcours, et l'acquisition du boot, à l'étape 4 — dans cet onglet ou
// dans un autre. Le magasin les supporte déjà (un `.partiel` disputé coûte un téléchargement, jamais
// un octet servi : ADR 0044, amendement D1g), mais les laisser courir ensemble paierait deux fois le
// même téléchargement. Un verrou Web Locks de l'origine les met en file :
//
//  - le téléchargement anticipé ne PREND le verrou que s'il est libre (`ifAvailable`) : un autre onglet
//    qui télécharge déjà, ou qui démarre, le fait renoncer sans rien demander au réseau ;
//  - l'acquisition du boot ATTEND le verrou, puis sert du magasin ce que le téléchargement anticipé
//    vient d'y ranger. Son attente est BORNÉE : au-delà, elle acquiert sans lui, comme avant (#348).
//
// Le verrou ne protège rien de ce qui est vérifié : il évite un travail double, et c'est tout. Un moteur
// sans `navigator.locks` acquiert sans verrou, comme avant.

/** Le nom du verrou, partagé par tous les contextes de l'origine. */
export const NOM_DU_VERROU_DES_ARTEFACTS = "vault-artefacts-acquisition";

/**
 * L'attente au-delà de laquelle le boot acquiert SANS le verrou : un téléchargement anticipé bloqué
 * dans un autre onglet ne doit pas tenir un démarrage indéfiniment. Cinq minutes : plus que les 207 Mio
 * d'un premier démarrage à 10 Mbit/s (environ 170 s), sans être un plafond mesuré.
 */
export const ATTENTE_MAX_DU_VERROU_MS = 300_000;

const OCCUPE = Symbol("verrou occupé");

/**
 * Exécute `geste` sous le verrou des artefacts, en l'ATTENDANT au besoin — l'acquisition du boot.
 *
 * `quandIlFautAttendre` est appelé une fois, seulement si le verrou est tenu ailleurs : le boot y dit
 * qu'il télécharge. Passé `attenteMaxMs`, le geste s'exécute sans le verrou ; une erreur du geste,
 * elle, remonte toujours telle quelle — jamais rejouée.
 *
 * @template T
 * @param {() => Promise<T>} geste
 * @param {{ verrous?: LockManager | null, attenteMaxMs?: number,
 *           quandIlFautAttendre?: () => void }} [options]
 * @returns {Promise<T>}
 */
export async function sousLeVerrouDesArtefacts(
  geste,
  {
    verrous = globalThis.navigator?.locks ?? null,
    attenteMaxMs = ATTENTE_MAX_DU_VERROU_MS,
    quandIlFautAttendre = () => {},
  } = {},
) {
  if (typeof verrous?.request !== "function") return geste();
  const immediat = await verrous.request(
    NOM_DU_VERROU_DES_ARTEFACTS,
    { ifAvailable: true },
    (verrou) => (verrou === null ? OCCUPE : geste()),
  );
  if (immediat !== OCCUPE) return immediat;
  quandIlFautAttendre();
  let accorde = false;
  try {
    return await verrous.request(
      NOM_DU_VERROU_DES_ARTEFACTS,
      { signal: AbortSignal.timeout(attenteMaxMs) },
      () => {
        accorde = true;
        return geste();
      },
    );
  } catch (erreur) {
    if (accorde) throw erreur;
    // Le verrou n'a pas été accordé à temps : le boot acquiert sans lui, comme avant #348.
    return geste();
  }
}

/**
 * Exécute `geste` sous le verrou s'il est LIBRE, sinon rend `null` sans l'exécuter — le téléchargement
 * anticipé, qui cède toujours la place.
 *
 * @template T
 * @param {() => Promise<T>} geste
 * @param {{ verrous?: LockManager | null }} [options]
 * @returns {Promise<T | null>}
 */
export async function siLeVerrouEstLibre(
  geste,
  { verrous = globalThis.navigator?.locks ?? null } = {},
) {
  if (typeof verrous?.request !== "function") return geste();
  return verrous.request(NOM_DU_VERROU_DES_ARTEFACTS, { ifAvailable: true }, (verrou) =>
    verrou === null ? null : geste(),
  );
}
