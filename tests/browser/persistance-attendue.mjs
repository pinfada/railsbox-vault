// Ce que CHAQUE projet de persistance doit obtenir du vrai `navigator.storage.persist()` (#168).
//
// Sans cette table, les deux suites de persistance seraient vertes par VACUITÉ : « le verdict est
// l'un des cinq » reste vrai quel que soit le moteur, et resterait vrai le jour où un moteur
// changerait d'avis. La table dit ce que la MESURE a trouvé, projet par projet ; un verdict
// inattendu rougit, et un projet inconnu lève plutôt que de laisser passer une épreuve sans oracle.
//
// Relevé du 9 septembre 2026 (Playwright 1.62.1, sans fenêtre, dix essais par configuration,
// Windows 11) — voir `docs/compatibility.md` § « Lecture des verdicts notables » :
//
//  - Chromium : `false` en 0–1 ms → refus tranché ;
//  - Firefox NU : la promesse ne rend JAMAIS (au-delà de 15 s d'observation), avec ou sans geste
//    utilisateur préalable → le produit la borne à quatre secondes et rend `pending` ;
//  - Firefox sous préférence d'essai de l'invite : `true` en 6–8 ms, ou `false` en 0–2 ms ;
//  - WebKit : `navigator.storage.persist` est absent → `unsupported`, jamais un refus.

/** Verdicts admis par projet. Plusieurs valeurs quand le moteur peut légitimement rendre l'un ou l'autre. */
const VERDICTS_PAR_PROJET = Object.freeze({
  "persistance-chromium": Object.freeze(["denied"]),
  "persistance-firefox": Object.freeze(["pending"]),
  "persistance-webkit": Object.freeze(["unsupported"]),
  // `already` autant que `granted` : une fois la persistance accordée dans ce navigateur, une
  // seconde demande lit `persisted()` vrai et n'en émet plus. Les deux sont durables, et c'est ce
  // que l'épreuve mesure.
  "persistance-firefox-invite-accordee": Object.freeze(["granted", "already"]),
  "persistance-firefox-invite-refusee": Object.freeze(["denied"]),
});

/**
 * @param {string} nomDuProjet nom du projet Playwright en cours
 * @returns {readonly string[]} les verdicts que ce projet doit obtenir
 */
export function verdictsAttendus(nomDuProjet) {
  const attendus = VERDICTS_PAR_PROJET[nomDuProjet];
  if (attendus === undefined) {
    throw new Error(
      `Aucun verdict de persistance mesuré pour le projet « ${nomDuProjet} ». ` +
        "Une suite de persistance sans oracle serait verte par vacuité : mesurer, puis inscrire.",
    );
  }
  return attendus;
}

/** Les verdicts où la persistance est réellement acquise : la seule porte vers une durabilité. */
export const VERDICTS_DURABLES = Object.freeze(["granted", "already"]);
