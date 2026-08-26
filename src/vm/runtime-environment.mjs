// Adaptateur d'environnement du contrôle préalable (#52) : il branche `runtime-preflight.mjs` sur
// le contexte RÉEL — celui du Worker runtime — et rien d'autre. La logique de décision reste dans
// le module injectable ; ici ne vivent que les gestes qui exigent un navigateur.

import { noTick } from "./runtime-errors.mjs";
import { controlerRuntime } from "./runtime-preflight.mjs";

/** Délai laissé à un Worker `blob:` pour donner signe de vie avant d'être déclaré refusé. */
export const DELAI_SIGNE_DE_VIE_MS = 1500;

/**
 * Délai laissé à la boucle de v86 pour effectuer son premier tour. Chromium boote le guest de
 * mesure en 3,5 s environ, compteur au-delà de 1 000 tours ; vingt secondes laissent donc une marge
 * de plus d'un ordre de grandeur à un moteur ou une machine lents.
 */
export const DELAI_PREMIER_TOUR_MS = 20000;

/** Module WebAssembly minimal : l'en-tête vide, huit octets. Il ne fait rien et suffit. */
const MODULE_VIDE = new Uint8Array([0, 0x61, 0x73, 0x6d, 1, 0, 0, 0]);

/**
 * Crée un Worker depuis une URL `blob:` et attend son premier message. La mesure porte sur le SIGNE
 * DE VIE, jamais sur l'absence d'exception : sous `worker-src 'self'`, Chromium ne lève rien à la
 * construction — il rend un objet mort (mesuré, #52).
 */
async function sonderWorkerBlob() {
  let url = null;
  let worker = null;
  try {
    url = URL.createObjectURL(new Blob(["self.postMessage(1)"], { type: "text/javascript" }));
    worker = new Worker(url);
  } catch (erreur) {
    return `refusé à la construction : ${erreur.name}`;
  } finally {
    if (url) URL.revokeObjectURL(url);
  }
  try {
    return await new Promise((resolve) => {
      const echeance = setTimeout(() => resolve("aucun message reçu"), DELAI_SIGNE_DE_VIE_MS);
      worker.addEventListener("message", () => {
        clearTimeout(echeance);
        resolve("vivant");
      });
      worker.addEventListener("error", (evenement) => {
        clearTimeout(echeance);
        resolve(`erreur du Worker : ${evenement.message ?? "sans message"}`);
      });
    });
  } finally {
    worker.terminate();
  }
}

/**
 * Contrôle préalable dans le contexte courant. Rend `null` si l'émulateur peut battre, sinon une
 * `RuntimeError`. Il est BORNÉ : au pire une instanciation WebAssembly et une sonde de Worker de
 * `DELAI_SIGNE_DE_VIE_MS`, et il ne sonde le Worker que lorsque v86 emprunterait ce chemin.
 */
export function controlerContexteCourant() {
  return controlerRuntime({
    href: location.href,
    scheduler: globalThis.scheduler ?? null,
    instancierWasm: () => WebAssembly.instantiate(MODULE_VIDE, {}),
    sonderWorkerBlob,
    workerDisponible: typeof Worker !== "undefined",
  });
}

/**
 * Lève la `RuntimeError` du contrôle préalable, s'il y en a une. C'est le point d'entrée des
 * Workers runtime : ils refusent de démarrer plutôt que de laisser l'émulateur ne jamais battre.
 */
export async function exigerContexteExecutable() {
  const erreur = await controlerContexteCourant();
  if (erreur) throw erreur;
}

/**
 * Chien de garde du PREMIER TOUR de boucle. Le contrôle préalable prédit les pannes connues ;
 * celui-ci attrape celles qu'il n'a pas prédites, en observant le compteur de tours de v86 pendant
 * que le boot se déroule.
 *
 * Il ne remplace pas le délai de garde du boot : un guest peut battre et ne pas atteindre son
 * invite, ce qui est une panne du GUEST et porte déjà un autre nom. Il ne couvre pas non plus un
 * thread de Worker monopolisé — dans ce cas aucune minuterie de ce Worker ne s'exécute, et c'est la
 * garde de la page qui borne l'attente (mesuré sous Firefox, #74).
 *
 * @param {() => number | null} lireTicks accès au compteur de tours, `null` si illisible
 * @param {{ delaiMs?: number, periodeMs?: number }} [options]
 * @returns {{ promesse: Promise<never>, arreter: () => void }}
 */
export function surveillerPremierTour(
  lireTicks,
  { delaiMs = DELAI_PREMIER_TOUR_MS, periodeMs = 250 } = {},
) {
  let minuterie = null;
  let scrutation = null;
  let dernier = null;
  let avance = false;

  const promesse = new Promise((_, reject) => {
    scrutation = setInterval(() => {
      const tours = lireTicks();
      if (typeof tours === "number" && dernier !== null && tours > dernier) avance = true;
      if (typeof tours === "number") dernier = tours;
    }, periodeMs);
    minuterie = setTimeout(() => {
      if (!avance) reject(noTick({ delaiMs, ticks: dernier }));
    }, delaiMs);
  });

  return {
    promesse,
    arreter() {
      if (scrutation !== null) clearInterval(scrutation);
      if (minuterie !== null) clearTimeout(minuterie);
      // Une promesse rejetée que plus personne n'observe deviendrait un rejet non traité, c'est-à-
      // dire exactement le silence que cette issue combat. On la neutralise explicitement.
      promesse.catch(() => {});
    },
  };
}
