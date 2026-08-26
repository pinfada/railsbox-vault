// Adaptateur d'environnement du contrôle préalable (#52) : il branche `runtime-preflight.mjs` sur
// le contexte RÉEL — celui du Worker runtime — et rien d'autre. La logique de décision reste dans
// le module injectable ; ici ne vivent que les gestes qui exigent un navigateur.

import { noTick, ticksUnreadable, unhandledRejection } from "./runtime-errors.mjs";
import { controlerRuntime } from "./runtime-preflight.mjs";
import { cadencer } from "./scheduling-loop.mjs";

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

/** Rejets non traités retenus par contexte. Bornés : un compte rendu n'est pas un journal. */
const MAX_REJETS = 20;

/**
 * Consigne les promesses rejetées que personne n'observe dans ce contexte.
 *
 * Ce n'est pas de la prudence générale : `libv86.mjs` appelle `scheduler.postTask(rappel, …)` et
 * **jette la valeur de retour**. Une exception levée dans le rappel de tour rejette donc une
 * promesse que rien n'attend — l'émulateur s'arrête, aucun `try` du dépôt n'est traversé, et le
 * délai de garde suivant accuse le GUEST. C'est le silence de #52, à l'intérieur de la boucle.
 *
 * @param {{ addEventListener?: Function }} [cible]
 * @returns {() => Record<string, unknown>[]} lecture des observations accumulées
 */
export function consignerRejetsNonTraites(cible = globalThis) {
  const observations = [];
  cible.addEventListener?.("unhandledrejection", (evenement) => {
    if (observations.length >= MAX_REJETS) return;
    const cause = evenement?.reason;
    const raison = String(cause?.message ?? cause ?? "sans raison").slice(0, 300);
    observations.push(unhandledRejection({ raison }).toJSON());
  });
  return () => observations.slice();
}

/**
 * Rythme observé de la boucle de v86 sur une fenêtre donnée, à partir de son compteur de tours.
 *
 * C'est l'instrument de comparaison de #74 : remplacer la boucle d'ordonnancement de v86 change le
 * rythme de TOUT l'émulateur, et une durée de boot seule ne dirait pas si l'émulateur a tourné plus
 * vite ou si le guest a eu moins à faire. Deux précautions valent d'être dites :
 *
 *  - un compteur ILLISIBLE rend `null`, jamais `0`. Le premier dit « l'instrument a disparu »
 *    (`VAULT_RUNTIME_TICKS_UNREADABLE`), le second dirait « l'émulateur n'a pas battu » ;
 *  - une fenêtre nulle ou absente ne produit pas de division : elle produit une absence de mesure.
 *
 * @param {{ ticks: number | null, fenetreMs: number | null }} mesure
 * @returns {{ ticks: number | null, fenetreMs: number | null, ticksParSeconde: number | null }}
 */
export function mesurerRythme({ ticks, fenetreMs }) {
  const toursLisibles = typeof ticks === "number" && Number.isFinite(ticks);
  const fenetreLisible = typeof fenetreMs === "number" && Number.isFinite(fenetreMs);
  const mesurable = toursLisibles && fenetreLisible && fenetreMs > 0;
  return {
    ticks: toursLisibles ? ticks : null,
    fenetreMs: fenetreLisible ? Number(fenetreMs.toFixed(0)) : null,
    ticksParSeconde: mesurable ? Number(((ticks * 1000) / fenetreMs).toFixed(1)) : null,
  };
}

/**
 * Chien de garde du PREMIER TOUR de boucle. Le contrôle préalable prédit les pannes connues ;
 * celui-ci attrape celles qu'il n'a pas prédites, en observant le compteur de tours de v86 pendant
 * que la phase surveillée se déroule.
 *
 * Trois issues, et une seule est fatale :
 *
 *  - le compteur AVANCE — la garde se tait, l'émulateur bat ;
 *  - le compteur est LISIBLE et FIGÉ — `VAULT_RUNTIME_NO_TICK`, la seule panne que cette garde sait
 *    nommer ;
 *  - le compteur n'est JAMAIS lisible — la garde se tait aussi, et consigne
 *    `VAULT_RUNTIME_TICKS_UNREADABLE`. Faire échouer un émulateur sain parce que notre instrument a
 *    disparu remplacerait un défaut d'observation par une panne inventée.
 *
 * Elle ne remplace pas le délai de garde du boot : un guest peut battre et ne pas atteindre son
 * invite, ce qui est une panne du GUEST et porte déjà un autre nom. Elle ne couvre pas non plus un
 * thread de Worker monopolisé — dans ce cas aucune minuterie de ce Worker ne s'exécute, et c'est la
 * garde de l'appelant qui borne l'attente (mesuré sous Firefox, #74).
 *
 * @param {() => number | null} lireTicks accès au compteur de tours, `null` si illisible
 * @param {{ delaiMs?: number, periodeMs?: number,
 *           onObservation?: (o: Record<string, unknown>) => void,
 *           decrireBoucle?: () => Record<string, unknown> | null,
 *           boucle?: object | null, horloge?: () => number,
 *           cadence?: (rappel: () => void) => () => void }} [options]
 *   `decrireBoucle` rend la boucle d'ordonnancement posée par Vault (#74), consignée dans le
 *   contexte de `VAULT_RUNTIME_NO_TICK` : le nombre de tâches qu'elle a reçues dit si v86 l'a
 *   empruntée, et c'est ce qui sépare « boucle ignorée » de « panne ailleurs ».
 *   `boucle` est ce même descripteur : la garde s'abonne à ses BATTEMENTS, faute de quoi elle
 *   n'expirerait pas sous un moteur qui affame ses minuteries pendant qu'elle tourne.
 * @returns {{ promesse: Promise<never>, arreter: () => void,
 *             observations: () => Record<string, unknown>[] }}
 */
export function surveillerPremierTour(
  lireTicks,
  {
    delaiMs = DELAI_PREMIER_TOUR_MS,
    periodeMs = 250,
    onObservation = () => {},
    decrireBoucle = () => null,
    boucle = null,
    horloge = () => Date.now(),
    cadence = (rappel) => cadencer(rappel, { periodeMs, boucle }),
  } = {},
) {
  let dernier = null;
  let avance = false;
  let arreterCadence = () => {};
  const observations = [];
  const debut = horloge();

  const promesse = new Promise((_, reject) => {
    // UNE seule mécanique : l'échantillonnage ET l'échéance sont consultés à chaque battement de
    // cadence. L'échéance n'est donc plus portée par un `setTimeout` — sous un moteur qui affame ses
    // minuteries pendant que la boucle tourne (WebKit, mesuré), elle n'expirerait jamais dans la
    // plage qu'elle borne.
    const battement = () => {
      const tours = lireTicks();
      if (typeof tours === "number") {
        if (dernier !== null && tours > dernier) avance = true;
        dernier = tours;
      }
      if (horloge() - debut < delaiMs) return;

      arreterCadence();
      if (avance) return;
      if (dernier === null) {
        const observation = ticksUnreadable({ delaiMs }).toJSON();
        observations.push(observation);
        onObservation(observation);
        return;
      }
      reject(noTick({ delaiMs, ticks: dernier, boucle: decrireBoucle() }));
    };
    arreterCadence = cadence(battement);
  });

  return {
    promesse,
    observations: () => observations.slice(),
    arreter() {
      arreterCadence();
      // Une promesse rejetée que plus personne n'observe deviendrait un rejet non traité, c'est-à-
      // dire exactement le silence que cette issue combat. On la neutralise explicitement.
      promesse.catch(() => {});
    },
  };
}

/**
 * Exécute une PHASE entière sous le chien de garde du premier tour.
 *
 * La phase, et non la première attente : sur le chemin de l'image de référence, `boot()` rend la
 * main juste après `emulator.run()`, avant que le guest ait dit quoi que ce soit. Une garde annulée
 * là n'aurait pas eu le temps de prendre deux échantillons, et un émulateur qui ne bat pas serait
 * retombé sur le délai de garde suivant, dont l'expiration accuse le GUEST — le symptôme même de
 * #52. L'appelant confie donc ici tout ce qui doit être couvert.
 *
 * @template T
 * @param {() => number | null} lireTicks
 * @param {() => Promise<T>} travail
 * @param {{ delaiMs?: number, periodeMs?: number,
 *           onObservation?: (o: Record<string, unknown>) => void,
 *           decrireBoucle?: () => Record<string, unknown> | null,
 *           boucle?: object | null, horloge?: () => number,
 *           cadence?: (rappel: () => void) => () => void }} [options]
 *   `decrireBoucle` rend la boucle d'ordonnancement posée par Vault (#74), consignée dans le
 *   contexte de `VAULT_RUNTIME_NO_TICK` : le nombre de tâches qu'elle a reçues dit si v86 l'a
 *   empruntée, et c'est ce qui sépare « boucle ignorée » de « panne ailleurs ».
 *   `boucle` est ce même descripteur : la garde s'abonne à ses BATTEMENTS, faute de quoi elle
 *   n'expirerait pas sous un moteur qui affame ses minuteries pendant qu'elle tourne.
 * @returns {Promise<T>}
 */
export async function executerSousGarde(lireTicks, travail, options = {}) {
  const garde = surveillerPremierTour(lireTicks, options);
  try {
    return await Promise.race([travail(), garde.promesse]);
  } finally {
    garde.arreter();
  }
}
