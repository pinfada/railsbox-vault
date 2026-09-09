// L'OBSERVATOIRE des fins d'onglet : comment on regarde un document qui MEURT (#170, ADR 0032).
//
// ## Le canal d'observation fait partie de la mesure
//
// Un événement livré à un document qui meurt ne se lit pas DEPUIS ce document : le contexte
// d'exécution part avec lui, et une évaluation posée après la fermeture ne trouve plus personne à
// qui parler. Ce que la sonde relève n'est donc jamais « l'événement a été livré » tout court : c'est
// « l'événement a été OBSERVÉ PAR CE CANAL ». Un événement qu'un canal ne rapporte pas n'est pas
// « non livré » — il est « non observé par ce canal », et la sonde change de canal avant de conclure.
//
// Trois canaux, posés ensemble, et leurs verdicts sont publiés côte à côte :
//
//  - **`BroadcastChannel` vers un document TÉMOIN** de la même origine, ouvert par l'épreuve et qui
//    survit au sujet. C'est le canal de référence : il ne dépend ni du protocole de débogage, ni de
//    la survie du document qui émet. Ce qui n'y arrive pas n'est pas arrivé à un document vivant ;
//  - **`console.log`**, relevé par `page.on("console")`. Il traverse le protocole du navigateur, et
//    il PEUT se perdre à la fermeture : c'est précisément ce que la comparaison des deux canaux
//    mesure, plutôt que de le supposer ;
//  - **`globalThis`**, lu depuis le document lui-même quand il vit encore. Inutilisable après une
//    fermeture, il est le seul qui donne l'ordre exact des événements dans le document.
//
// ## L'instrumentation est du côté de l'ÉPREUVE, jamais du produit
//
// C'est le motif de la sonde de #162, repris par l'ADR 0031 : rendre une poignée de test au produit
// — un `globalThis.__finsDOnglet` que la coquille poserait elle-même — rouvrirait la porte que #162
// a fermée pour la commodité d'une épreuve. Tout ce qui suit est posé par `addInitScript`, sur un
// CONTEXTE de navigateur, et le produit n'en sait rien.
//
// ## `beforeunload` n'est armé que sur demande, et c'est une mesure
//
// Poser un écouteur de `beforeunload` rend, sur certains moteurs, le document INÉLIGIBLE au bfcache.
// Une sonde qui l'armerait partout mesurerait donc sa propre instrumentation dans la ligne
// « restauré depuis le bfcache ». Il est armé par un drapeau, et la sonde compare les deux relevés.

import { mkdir, readFile, writeFile } from "node:fs/promises";

/** Le canal, et la clé du témoin. Publics et sans valeur : ce sont des noms, pas des secrets. */
export const CANAL = "fins-d-onglet-170";

/** Les événements de fin d'onglet observés. `beforeunload` n'entre que sur demande. */
export const EVENEMENTS_OBSERVES = Object.freeze([
  "pagehide",
  "pageshow",
  "visibilitychange",
  "freeze",
  "resume",
]);

/**
 * POSE l'observatoire sur tous les documents d'un contexte, AVANT toute navigation.
 *
 * @param {import("@playwright/test").BrowserContext} contexte
 * @param {{ avecBeforeunload?: boolean }} [options]
 */
export async function poserLObservatoire(contexte, { avecBeforeunload = false } = {}) {
  await contexte.addInitScript(
    ({ canal, evenements, avecBeforeunload: armerBeforeunload }) => {
      // Les documents que le navigateur crée en chemin — `about:blank`, la page d'erreur d'une
      // navigation refusée — n'ont ni `BroadcastChannel` utilisable ni origine stable. Une sonde
      // qui y jetterait produirait une erreur de PAGE, que les scénarios de ce dépôt comptent et
      // refusent à juste titre. Rien ici ne jette.
      let diffusion = null;
      try {
        diffusion = new BroadcastChannel(canal);
      } catch {
        /* une origine opaque n'a pas de canal : le relevé se fera par les autres */
      }

      const observations = [];
      globalThis.__finsDOnglet = observations;

      const marquer = (evenement, extra) => {
        const trace = {
          canal: "sujet",
          url: location.href,
          evenement,
          // L'HORLOGE MURALE et l'horloge de la PAGE, toutes deux : leur ÉCART est ce qui dit si le
          // moteur a suspendu le temps de la page pendant un gel. Une seule des deux ne dirait rien.
          horlogeMs: Date.now(),
          pageMs: Math.round(performance.now()),
          visibilite: document.visibilityState,
          ...extra,
        };
        observations.push(trace);
        try {
          diffusion?.postMessage(trace);
        } catch {
          /* un canal fermé n'invalide pas les autres */
        }
        // Le second canal, volontairement le plus fragile : c'est sa fragilité qu'on mesure.
        console.log(`[fins-d-onglet] ${JSON.stringify(trace)}`);
      };

      // LA CIBLE compte, et c'est un piège que la première rédaction a payé : `freeze` et `resume`
      // sont dispatchés sur le DOCUMENT et ne remontent pas à la fenêtre ; un écouteur posé sur
      // `window` ne les voit jamais, et la sonde aurait conclu « ce moteur ne gèle pas » sur une
      // erreur de branchement. `pagehide` et `pageshow` sont, eux, des événements de FENÊTRE.
      const cibleDe = (nom) =>
        nom === "pagehide" || nom === "pageshow" || nom === "beforeunload" ? globalThis : document;

      for (const nom of evenements) {
        cibleDe(nom).addEventListener(nom, (evenement) =>
          marquer(nom, {
            // `persisted` n'existe que sur `pagehide` et `pageshow`. Le relever partout le rendrait
            // `undefined` ailleurs, ce qui se lit comme « faux » dans un tableau. Il est ABSENT
            // quand il n'a pas de sens.
            ...(nom === "pagehide" || nom === "pageshow"
              ? { persisted: evenement.persisted === true }
              : {}),
          }),
        );
      }

      if (armerBeforeunload) {
        // AUCUNE boîte de dialogue : ni `preventDefault`, ni `returnValue`. Ce que la sonde mesure
        // est la LIVRAISON de l'événement et son effet sur l'éligibilité au bfcache — retenir
        // l'utilisateur est précisément l'usage que la Definition of Ready de #25 interdit.
        cibleDe("beforeunload").addEventListener("beforeunload", () => marquer("beforeunload", {}));
      }

      // Le TÉMOIN : tout document de la même origine qui reçoit ce que les autres émettent. Le même
      // script sert de sujet et de témoin ; ce qui les distingue est ce que l'épreuve leur demande.
      const recues = [];
      globalThis.__finsDOngletRecues = recues;
      if (diffusion !== null) {
        diffusion.addEventListener("message", (evenement) => {
          recues.push({ ...evenement.data, canal: "temoin", recuMs: Date.now() });
        });
      }
    },
    { canal: CANAL, evenements: EVENEMENTS_OBSERVES, avecBeforeunload },
  );
}

/**
 * BRANCHE le canal `console`, et rend ce qu'il aura vu.
 *
 * Le tableau est rendu MAINTENANT et rempli plus tard : l'épreuve n'a pas à savoir quand un message
 * arrive, et un message qui arrive après la fermeture de la page y sera quand même.
 *
 * @param {import("@playwright/test").Page} page
 */
export function brancherLaConsole(page) {
  const vues = [];
  page.on("console", (message) => {
    const texte = message.text();
    if (!texte.startsWith("[fins-d-onglet] ")) return;
    try {
      vues.push({ ...JSON.parse(texte.slice("[fins-d-onglet] ".length)), canal: "console" });
    } catch {
      /* un message tronqué par le protocole est une observation, pas un défaut : il est ignoré */
    }
  });
  return vues;
}

/**
 * Ce que le TÉMOIN a reçu, filtré sur une URL de sujet.
 *
 * @param {import("@playwright/test").Page} temoin
 * @param {string} [marqueDeLUrl] un fragment de l'URL du sujet
 */
export async function recuesParLeTemoin(temoin, marqueDeLUrl = "") {
  const recues = await temoin.evaluate(() => globalThis.__finsDOngletRecues ?? []);
  return recues.filter(({ url }) => typeof url === "string" && url.includes(marqueDeLUrl));
}

/** Les noms d'événements observés, dans l'ordre, sans les doublons de canal. */
export function evenementsDe(traces) {
  return traces.map(({ evenement }) => evenement);
}

/**
 * PUBLIE un relevé sous `reports/fins-d-onglet/<moteur>.json`, à côté de `reports/compat/`.
 *
 * Une pièce jointe de rapport Playwright vit dans le rapport et meurt avec lui ; ce que
 * `docs/compatibility.md` cite doit être un FICHIER qu'un relecteur peut rouvrir, et qu'une CI peut
 * archiver. Le dossier est ignoré par git, comme `reports/compat/`.
 *
 * Le fichier est CUMULATIF : chaque épreuve y dépose sa situation sous son nom, et le relevé complet
 * d'un moteur est l'union de ce que la suite a mesuré. Les relevés d'une exécution précédente d'un
 * même moteur sont écrasés situation par situation, jamais fusionnés en silence.
 */
export async function publier(moteur, situation, valeur) {
  const dossier = new URL("../../reports/fins-d-onglet/", import.meta.url);
  await mkdir(dossier, { recursive: true });
  const fichier = new URL(`${moteur}.json`, dossier);
  let releve = {};
  try {
    releve = JSON.parse(await readFile(fichier, "utf8"));
  } catch {
    /* premier relevé de ce moteur */
  }
  releve[situation] = { ...valeur, releveLe: new Date().toISOString() };
  await writeFile(fichier, `${JSON.stringify(releve, null, 2)}\n`, "utf8");
}
