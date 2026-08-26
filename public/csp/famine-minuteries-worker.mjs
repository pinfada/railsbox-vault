// Worker de MESURE (#74, revue de la PR #86) : une boucle serrée de messages de canal affame-t-elle
// les minuteries de ce moteur ?
//
// La question n'est pas théorique. La boucle d'ordonnancement fournie par Vault fait passer chaque
// tour de v86 par un `MessageChannel`. Si un moteur donne priorité stricte aux messages de port sur
// la source « minuteries », alors pendant une plage où v86 enchaîne les tours — un boot de Rails,
// un `mke2fs` — aucun `setInterval` ni `setTimeout` de ce Worker ne s'exécute. Or le chien de garde
// du premier tour et les délais de garde des sessions de guest étaient posés sur des minuteries :
// ils ne pourraient ni échantillonner ni expirer précisément pendant la fenêtre qu'ils bornent.
// C'est le silence de #52 rentrant par une autre porte.
//
// Ce Worker mesure quatre choses pendant une boucle serrée `postTask({delay: 0})` auto-réamorcée :
//
//   1. la boucle tourne-t-elle (nombre de tâches) ;
//   2. les minuteries traversent-elles (`setInterval` et un `setTimeout` unique) ;
//   3. les messages venus de la page traversent-ils (le port n'est pas la même source) ;
//   4. une échéance CADENCÉE PAR LA BOUCLE elle-même expire-t-elle malgré tout — c'est la propriété
//      dont dépend le chien de garde depuis cette revue, et la seule qui doive tenir partout.
//
// Il n'a besoin d'aucun artefact v86 : il ne démarre aucun émulateur.

import { cadencer, installerBoucleOrdonnancement } from "/src/vm/scheduling-loop.mjs";

/** Durée de la boucle serrée. Cinq secondes suffisent : les minuteries mesurées sont bien plus courtes. */
const DUREE_PAR_DEFAUT_MS = 5000;
const PERIODE_INTERVALLE_MS = 250;
const ECHEANCE_MINUTERIE_MS = 500;
/** Échéance cadencée par la boucle. Volontairement plus courte que la boucle serrée. */
const ECHEANCE_CADENCEE_MS = 1000;

let messagesDeLaPage = 0;
self.addEventListener("message", (evenement) => {
  if (evenement.data?.type === "ping") messagesDeLaPage += 1;
});

async function mesurer({ dureeMs = DUREE_PAR_DEFAUT_MS } = {}) {
  const boucle = installerBoucleOrdonnancement();
  messagesDeLaPage = 0;

  let intervalles = 0;
  let minuterieTiree = false;
  let taches = 0;
  let echeanceCadenceeMs = null;

  const debut = performance.now();
  const minuterie = setInterval(() => {
    intervalles += 1;
  }, PERIODE_INTERVALLE_MS);
  const unique = setTimeout(() => {
    minuterieTiree = true;
  }, ECHEANCE_MINUTERIE_MS);

  // L'échéance qui doit tenir même sous famine : elle est consultée depuis la boucle elle-même.
  const arreterCadence = cadencer(
    () => {
      if (echeanceCadenceeMs !== null) return;
      const ecoule = performance.now() - debut;
      if (ecoule >= ECHEANCE_CADENCEE_MS) echeanceCadenceeMs = Number(ecoule.toFixed(0));
    },
    { periodeMs: PERIODE_INTERVALLE_MS, boucle },
  );

  // Boucle serrée : chaque tâche en réarme une autre, sans délai — le pire cas pour les minuteries.
  await new Promise((resolve) => {
    const tour = () => {
      taches += 1;
      if (performance.now() - debut >= dureeMs) {
        resolve();
        return;
      }
      globalThis.scheduler.postTask(tour, { delay: 0 });
    };
    globalThis.scheduler.postTask(tour, { delay: 0 });
  });

  clearInterval(minuterie);
  clearTimeout(unique);
  arreterCadence();
  const dureeReelleMs = Number((performance.now() - debut).toFixed(0));
  boucle.retirer();

  return {
    dureeReelleMs,
    boucle: boucle.source,
    taches,
    // Ce que la boucle serrée laisse passer, et ce qu'elle affame.
    intervalles,
    intervallesAttendus: Math.floor(dureeReelleMs / PERIODE_INTERVALLE_MS),
    minuterieTiree,
    messagesDeLaPage,
    // La propriété qui doit tenir partout : une échéance cadencée par la boucle expire.
    echeanceCadenceeMs,
    echeanceCadenceeVisee: ECHEANCE_CADENCEE_MS,
  };
}

self.addEventListener("message", (evenement) => {
  const { id, type, payload } = evenement.data ?? {};
  if (type !== "mesurer") return;
  mesurer(payload ?? {}).then(
    (report) => self.postMessage({ id, ok: true, report }),
    (error) => self.postMessage({ id, ok: false, error: { message: error.message } }),
  );
});
