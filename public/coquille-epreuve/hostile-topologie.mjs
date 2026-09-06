// Les tentatives de TOPOLOGIE de la fixture malveillante (#161).
//
// Ce sont celles que l'ADR 0002 a mesurées sur la coquille du SPIKE, rejouées ici contre la coquille
// de PRODUIT : realm du parent, OPFS, IndexedDB, Web Locks, diffusions, navigation du sommet,
// fenêtre auxiliaire, Service Worker.
//
// Trois résultats, jamais deux : `aboutit`, `refuse`, `indisponible`. Confondre le troisième avec le
// deuxième ferait passer pour sûre une topologie que le moteur n'a simplement pas pu mettre à
// l'épreuve — c'est la leçon du spike #35, et elle vaut mot pour mot ici.
//
// Deux de ces sondes n'ont PAS de témoin positif contre la coquille de produit, et l'ADR 0028 le
// dit : la coquille ne prend aucun verrou nommé et n'ouvre aucun `BroadcastChannel`. Leur témoin
// reste celui du spike (`tests/browser/origin-topology.spec.mjs`, topologie T1a), et c'est une des
// raisons pour lesquelles ce banc doit rester vivant.

import {
  BASE_IDB,
  CANAL_DIFFUSION,
  CLE_IDB_HOSTILE,
  EMPREINTE_HOSTILE,
  ENVELOPPE_DE_LA_COQUILLE,
  MAGASIN_IDB,
  MARQUEUR_OPFS,
  REPERTOIRE_DES_VOLUMES,
  SERVICE_WORKER_HOSTILE,
  VERROU_DE_VOLUME,
  VOLUME_DE_LA_COQUILLE,
} from "./marqueurs.mjs";

function indisponible(detail) {
  return { resultat: "indisponible", detail };
}

/** Ouvre la base de la fixture, en la créant si besoin. */
function ouvrirBase() {
  return new Promise((rendre, refuser) => {
    const requete = indexedDB.open(BASE_IDB, 1);
    requete.onupgradeneeded = () => requete.result.createObjectStore(MAGASIN_IDB);
    requete.onerror = () => refuser(requete.error ?? new Error("ouverture refusée"));
    requete.onsuccess = () => rendre(requete.result);
  });
}

/** @param {IDBDatabase} base */
function transiger(base, mode, geste) {
  return new Promise((rendre, refuser) => {
    const requete = geste(base.transaction(MAGASIN_IDB, mode).objectStore(MAGASIN_IDB));
    requete.onsuccess = () => rendre(requete.result);
    requete.onerror = () => refuser(requete.error ?? new Error("transaction refusée"));
  });
}

/**
 * Lit un fichier du répertoire de volumes de l'OPFS joignable, ou dit pourquoi il ne l'est pas.
 *
 * Le répertoire est celui du produit (`vault-volumes`) : une sonde qui chercherait à la racine
 * conclurait « absent » partout, y compris là où le fichier existe, et le témoin positif serait
 * vert pour une mauvaise raison.
 */
async function lireDansLOpfs(nom) {
  const racine = await navigator.storage.getDirectory();
  const repertoire = await racine.getDirectoryHandle(REPERTOIRE_DES_VOLUMES);
  const handle = await repertoire.getFileHandle(nom);
  return (await handle.getFile()).text();
}

const SONDES_DE_TOPOLOGIE = [
  {
    nom: "acces-dom-coquille",
    cible: "coquille",
    intention: "lire le DOM de la coquille depuis le document encadré",
    run() {
      const titre = parent.document?.title;
      return { resultat: "aboutit", detail: `titre lu : ${titre}` };
    },
  },
  {
    nom: "lecture-volume-opfs-coquille",
    cible: "coquille",
    intention: "lire le volume que le Worker de confiance a ouvert dans l'OPFS de la coquille",
    async run() {
      if (!navigator.storage?.getDirectory) return indisponible("navigator.storage absent");
      const octets = await lireDansLOpfs(VOLUME_DE_LA_COQUILLE);
      return { resultat: "aboutit", detail: `volume lu : ${octets.length} caractère(s)` };
    },
  },
  {
    nom: "lecture-enveloppe-opfs-coquille",
    cible: "coquille",
    intention: "lire `<volume>.cles`, c'est-à-dire la clé qui ouvre le volume",
    async run() {
      if (!navigator.storage?.getDirectory) return indisponible("navigator.storage absent");
      const octets = await lireDansLOpfs(ENVELOPPE_DE_LA_COQUILLE);
      return { resultat: "aboutit", detail: `enveloppe lue : ${octets.length} caractère(s)` };
    },
  },
  {
    nom: "ecriture-opfs-silencieuse",
    // Écrire dans SON PROPRE OPFS n'est pas une compromission. Le verdict est rendu depuis la
    // coquille, seule à savoir de quelle partition il s'agit.
    cible: "origine-propre",
    intention: "déposer un marqueur persistant dans l'OPFS joignable",
    async run() {
      if (!navigator.storage?.getDirectory) return indisponible("navigator.storage absent");
      const racine = await navigator.storage.getDirectory();
      const handle = await racine.getFileHandle(MARQUEUR_OPFS, { create: true });
      const flux = await handle.createWritable();
      await flux.write(EMPREINTE_HOSTILE);
      await flux.close();
      return { resultat: "aboutit", detail: `${MARQUEUR_OPFS} écrit` };
    },
  },
  {
    nom: "ecriture-indexeddb-silencieuse",
    cible: "origine-propre",
    intention: "persister un enregistrement dans la base joignable",
    async run() {
      if (!globalThis.indexedDB) return indisponible("indexedDB absent");
      const base = await ouvrirBase();
      await transiger(base, "readwrite", (magasin) =>
        magasin.put(EMPREINTE_HOSTILE, CLE_IDB_HOSTILE),
      );
      base.close();
      return { resultat: "aboutit", detail: "enregistrement persisté" };
    },
  },
  {
    nom: "observation-verrous-web",
    cible: "coquille",
    intention: "voir les verrous tenus par l'origine de la coquille",
    async run() {
      if (!navigator.locks) return indisponible("navigator.locks absent");
      const etat = await navigator.locks.query();
      const noms = [...etat.held, ...etat.pending].map((entree) => entree.name);
      if (!noms.includes(VERROU_DE_VOLUME)) {
        return { resultat: "refuse", detail: `verrous visibles : ${JSON.stringify(noms)}` };
      }
      return { resultat: "aboutit", detail: `verrou ${VERROU_DE_VOLUME} visible` };
    },
  },
  {
    nom: "ecoute-canal-diffusion",
    cible: "coquille",
    intention: "capter une diffusion de la coquille sur un canal de contrôle",
    async run() {
      if (typeof BroadcastChannel !== "function") return indisponible("BroadcastChannel absent");
      const canal = new BroadcastChannel(CANAL_DIFFUSION);
      const capture = await new Promise((rendre) => {
        canal.addEventListener("message", (event) => rendre(event.data), { once: true });
        setTimeout(() => rendre(null), 1000);
      });
      canal.close();
      if (capture === null) return { resultat: "refuse", detail: "aucune diffusion en 1 s" };
      return { resultat: "aboutit", detail: `diffusion captée : ${JSON.stringify(capture)}` };
    },
  },
  {
    nom: "navigation-du-sommet",
    cible: "coquille",
    intention: "naviguer le document du sommet vers un fragment",
    run() {
      // Un FRAGMENT, jamais une autre page : la sonde doit rendre la navigation OBSERVABLE sans
      // détruire le harnais qui la mesure. C'est déjà la précaution du spike #35.
      top.location.replace(`${top.location.href.split("#")[0]}#navigue-par-lapplication`);
      return { resultat: "aboutit", detail: "top.location.replace n'a pas levé" };
    },
  },
  {
    nom: "ouverture-fenetre-auxiliaire",
    cible: "coquille",
    intention: "ouvrir une fenêtre auxiliaire depuis le document encadré",
    run() {
      const fenetre = window.open("about:blank", "_blank");
      if (!fenetre) return { resultat: "refuse", detail: "window.open a rendu null" };
      fenetre.close();
      return { resultat: "aboutit", detail: "fenêtre auxiliaire ouverte" };
    },
  },
  {
    nom: "enregistrement-service-worker",
    cible: "origine-propre",
    intention: "enregistrer un Service Worker et mesurer la portée obtenue",
    async run() {
      if (!("serviceWorker" in navigator)) return indisponible("navigator.serviceWorker absent");
      const racine = await tenterEnregistrement({ scope: "/" });
      const defaut = await tenterEnregistrement(undefined);
      if (defaut.portee !== null) {
        return {
          resultat: "aboutit",
          detail: `portée obtenue : ${defaut.portee} ; racine : ${racine.portee ?? racine.erreur}`,
        };
      }
      return {
        resultat: "refuse",
        detail: `portée par défaut refusée (${defaut.erreur}) ; racine : ${racine.erreur}`,
      };
    },
  },
];

/** @returns {Promise<{ portee: string | null, erreur: string | null }>} */
async function tenterEnregistrement(options) {
  try {
    const inscription = await navigator.serviceWorker.register(SERVICE_WORKER_HOSTILE, options);
    return { portee: inscription.scope, erreur: null };
  } catch (error) {
    return { portee: null, erreur: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` };
  }
}

export default SONDES_DE_TOPOLOGIE;
