// Spike #46 — deux applications Rails, et ce qu'elles voient l'une de l'autre.
//
// Un seul module sert les deux documents, dans trois phases :
//
//  · `poser`   — l'application A dépose un actif par mécanisme de stockage, puis reste vivante :
//                un verrou Web Locks se relâche avec le contexte qui le tient, et une diffusion
//                n'existe que pendant qu'elle est émise. Une phase A terminée serait une phase A
//                absente, et l'invisibilité mesurée ensuite ne prouverait rien ;
//  · `lire`    — l'application B tente de lire, d'énumérer et de DÉTRUIRE les actifs de A. Elle est
//                écrite comme un script hostile : elle ignore la convention de préfixe, puisque
//                rien dans le navigateur ne la lui impose ;
//  · `annonce` — le document se contente de s'annoncer à la coquille, pour mesurer si la liste
//                d'admission du port restreint distingue une application d'une autre.
//
// Chaque sonde rend `lu`, `invisible` ou `indisponible`. `indisponible` est un troisième résultat,
// jamais confondu avec un refus : une capacité que le moteur ne fournit pas n'est pas une
// frontière, et la confondre avec un refus ferait passer pour sûre une topologie que le navigateur
// n'a simplement pas pu mettre à l'épreuve.

import { ACTIFS_A, CANARY_NOM, CHEMIN_APP_A, SECRET_A } from "./apps-topologie.mjs";

const parametres = new URL(location.href).searchParams;
const application = parametres.get("app") ?? "a";
const phase = parametres.get("phase") ?? "poser";
/** Origine où vit l'application A ; seule la portée d'un Service Worker s'y juge. */
const origineCibleA = parametres.get("origineA") ?? location.origin;

const etatNode = document.querySelector("#etat");
const rapportNode = document.querySelector("#rapport");

/** Ce que la phase `poser` garde vivant : le relâcher terminerait la mesure. */
const vivants = { verrou: null, diffusion: null };

function decrire(erreur) {
  return `${erreur?.name ?? "Error"}: ${erreur?.message ?? String(erreur)}`;
}

function publier(rapport, etat) {
  rapportNode.textContent = JSON.stringify(rapport, null, 2);
  etatNode.textContent = `application-${application}:${etat}`;
  document.documentElement.dataset.appState = etat;
}

// --- Phase « poser » : l'application A dépose un actif par mécanisme --------------------------

async function poserOpfs(rapport) {
  if (!navigator.storage?.getDirectory) {
    rapport.opfs = "indisponible: navigator.storage.getDirectory absent";
    return;
  }
  const racine = await navigator.storage.getDirectory();
  const fichier = await racine.getFileHandle(ACTIFS_A.opfsFichier, { create: true });
  let flux = await fichier.createWritable();
  await flux.write(SECRET_A);
  await flux.close();

  // Le même secret, une seconde fois, sous un répertoire préfixé au nom de l'application : c'est
  // exactement la convention que propose l'option (b) de l'issue #46.
  const repertoire = await racine.getDirectoryHandle(ACTIFS_A.opfsRepertoire, { create: true });
  const sousFichier = await repertoire.getFileHandle(ACTIFS_A.opfsFichierDansRepertoire, {
    create: true,
  });
  flux = await sousFichier.createWritable();
  await flux.write(SECRET_A);
  await flux.close();
  rapport.opfs = "depose";
}

function ouvrirBase(nom, store) {
  return new Promise((resolu, echoue) => {
    const requete = indexedDB.open(nom, 1);
    let creee = false;
    requete.onupgradeneeded = () => {
      creee = true;
      requete.result.createObjectStore(store);
    };
    requete.onsuccess = () => resolu({ base: requete.result, creee });
    requete.onerror = () => echoue(requete.error ?? new Error("ouverture IndexedDB refusée"));
    requete.onblocked = () => echoue(new Error("ouverture IndexedDB bloquée"));
  });
}

function transiger(base, store, mode, executer) {
  return new Promise((resolu, echoue) => {
    const requete = executer(base.transaction(store, mode).objectStore(store));
    requete.onsuccess = () => resolu(requete.result);
    requete.onerror = () => echoue(requete.error ?? new Error("transaction IndexedDB refusée"));
  });
}

async function poserIndexedDb(rapport) {
  if (!globalThis.indexedDB) {
    rapport.indexedDb = "indisponible: indexedDB absent";
    return;
  }
  const { base } = await ouvrirBase(ACTIFS_A.idbNom, ACTIFS_A.idbStore);
  await transiger(base, ACTIFS_A.idbStore, "readwrite", (store) =>
    store.put(SECRET_A, ACTIFS_A.idbCle),
  );
  base.close();
  rapport.indexedDb = "depose";
}

async function poserCache(rapport) {
  if (!globalThis.caches) {
    rapport.cacheStorage = "indisponible: caches absent";
    return;
  }
  const cache = await caches.open(ACTIFS_A.cache);
  await cache.put(new Request(ACTIFS_A.cacheRequete), new Response(SECRET_A));
  rapport.cacheStorage = "depose";
}

async function poserServiceWorker(rapport) {
  if (!("serviceWorker" in navigator)) {
    rapport.serviceWorker = "indisponible: navigator.serviceWorker absent";
    return;
  }
  const inscription = await navigator.serviceWorker.register("./app-a-sw.mjs");
  await navigator.serviceWorker.ready;
  rapport.serviceWorker = `portee ${inscription.scope}`;
}

function poserVerrou(rapport) {
  if (!navigator.locks) {
    rapport.verrou = "indisponible: navigator.locks absent";
    return Promise.resolve();
  }
  return new Promise((acquis, echoue) => {
    navigator.locks
      .request(ACTIFS_A.verrou, { mode: "exclusive" }, () => {
        rapport.verrou = "tenu";
        vivants.verrou = "tenu";
        acquis();
        // Jamais résolue : le verrou reste tenu tant que ce document vit.
        return new Promise(() => {});
      })
      .catch((erreur) => {
        rapport.verrou = decrire(erreur);
        echoue(erreur);
      });
  });
}

function poserDiffusion(rapport) {
  if (typeof BroadcastChannel !== "function") {
    rapport.diffusion = "indisponible: BroadcastChannel absent";
    return;
  }
  const canal = new BroadcastChannel(ACTIFS_A.canal);
  vivants.diffusion = setInterval(() => {
    canal.postMessage({ type: "app-a.battement", secret: SECRET_A });
  }, 150);
  rapport.diffusion = "emise";
}

async function poser() {
  const rapport = {};
  const etapes = [
    ["opfs", () => poserOpfs(rapport)],
    ["indexedDb", () => poserIndexedDb(rapport)],
    ["cacheStorage", () => poserCache(rapport)],
    ["serviceWorker", () => poserServiceWorker(rapport)],
    ["verrou", () => poserVerrou(rapport)],
  ];
  for (const [nom, executer] of etapes) {
    try {
      await executer();
    } catch (erreur) {
      rapport[nom] = decrire(erreur);
    }
  }

  try {
    localStorage.setItem(ACTIFS_A.storageCle, SECRET_A);
    rapport.localStorage = "depose";
  } catch (erreur) {
    rapport.localStorage = decrire(erreur);
  }

  try {
    // `Path=/` porte le cookie à toute l'origine ; le second reste au chemin par défaut, qui est
    // le répertoire du document — c'est-à-dire le préfixe de l'application A.
    document.cookie = `${ACTIFS_A.cookieGlobal}=${SECRET_A}; Path=/; SameSite=Lax`;
    document.cookie = `${ACTIFS_A.cookieChemin}=${SECRET_A}; SameSite=Lax`;
    rapport.cookies = document.cookie;
  } catch (erreur) {
    rapport.cookies = decrire(erreur);
  }

  poserDiffusion(rapport);
  publier(rapport, "actifs-deposes");
  return rapport;
}

// --- Phase « lire » : l'application B tente tout ce qu'un script hostile tenterait -------------

function lu(detail) {
  return { resultat: "lu", detail };
}
function invisible(detail) {
  return { resultat: "invisible", detail };
}
function indisponible(detail) {
  return { resultat: "indisponible", detail };
}

const SONDES = [
  {
    nom: "opfs-fichier-de-a",
    mecanisme: "OPFS",
    intention: "lire à la racine de l'OPFS le fichier déposé par A",
    async run() {
      if (!navigator.storage?.getDirectory)
        return indisponible("navigator.storage.getDirectory absent");
      const racine = await navigator.storage.getDirectory();
      try {
        const handle = await racine.getFileHandle(ACTIFS_A.opfsFichier);
        return lu(`contenu : ${await (await handle.getFile()).text()}`);
      } catch (erreur) {
        return invisible(decrire(erreur));
      }
    },
  },
  {
    nom: "opfs-repertoire-prefixe-de-a",
    mecanisme: "OPFS",
    intention: "ignorer la convention de préfixe et ouvrir le répertoire « app-a »",
    async run() {
      if (!navigator.storage?.getDirectory)
        return indisponible("navigator.storage.getDirectory absent");
      const racine = await navigator.storage.getDirectory();
      try {
        const repertoire = await racine.getDirectoryHandle(ACTIFS_A.opfsRepertoire);
        const handle = await repertoire.getFileHandle(ACTIFS_A.opfsFichierDansRepertoire);
        return lu(`contenu : ${await (await handle.getFile()).text()}`);
      } catch (erreur) {
        return invisible(decrire(erreur));
      }
    },
  },
  {
    nom: "opfs-destruction-des-donnees-de-a",
    mecanisme: "OPFS",
    intention: "effacer le répertoire de A — lire n'est pas le pire",
    async run() {
      if (!navigator.storage?.getDirectory)
        return indisponible("navigator.storage.getDirectory absent");
      const racine = await navigator.storage.getDirectory();
      try {
        await racine.removeEntry(ACTIFS_A.opfsRepertoire, { recursive: true });
      } catch (erreur) {
        return invisible(decrire(erreur));
      }
      try {
        await racine.getDirectoryHandle(ACTIFS_A.opfsRepertoire);
        return invisible("suppression sans effet : le répertoire est toujours là");
      } catch {
        return lu("répertoire « app-a » supprimé : les données de A sont détruites");
      }
    },
  },
  {
    // AVANT la sonde d'ouverture, et cet ordre est une contrainte de mesure. Ouvrir une base
    // absente la CRÉE : une énumération qui suivrait l'ouverture trouverait la base que la sonde
    // précédente vient de fabriquer, et conclurait à une lecture croisée sur deux origines
    // pourtant séparées. L'erreur a été commise, mesurée, puis corrigée ici.
    nom: "indexeddb-enumeration",
    mecanisme: "IndexedDB",
    intention: "énumérer les bases de la partition et y trouver celle de A",
    async run() {
      if (!globalThis.indexedDB?.databases) return indisponible("indexedDB.databases absent");
      const bases = (await indexedDB.databases()).map((entree) => entree.name);
      return bases.includes(ACTIFS_A.idbNom)
        ? lu(`bases énumérées : ${bases.join(", ")}`)
        : invisible(`bases énumérées : ${bases.join(", ") || "aucune"}`);
    },
  },
  {
    nom: "indexeddb-base-de-a",
    mecanisme: "IndexedDB",
    intention: "ouvrir la base nommée par A et y lire son secret",
    async run() {
      if (!globalThis.indexedDB) return indisponible("indexedDB absent");
      let ouverture;
      try {
        ouverture = await ouvrirBase(ACTIFS_A.idbNom, ACTIFS_A.idbStore);
      } catch (erreur) {
        return invisible(decrire(erreur));
      }
      // Ouvrir une base absente la CRÉE : sans ce témoin, « base vide » et « base inexistante »
      // rendraient le même relevé, et la seconde passerait pour une frontière. La base fabriquée
      // par la sonde est effacée, pour ne pas laisser derrière elle une trace que la mesure
      // suivante prendrait pour une donnée de A.
      if (ouverture.creee) {
        ouverture.base.close();
        indexedDB.deleteDatabase(ACTIFS_A.idbNom);
        return invisible("la base n'existait pas dans cette partition : elle vient d'être créée");
      }
      const valeur = await transiger(ouverture.base, ACTIFS_A.idbStore, "readonly", (store) =>
        store.get(ACTIFS_A.idbCle),
      );
      ouverture.base.close();
      return valeur === undefined
        ? invisible("base présente mais vide")
        : lu(`enregistrement lu : ${valeur}`);
    },
  },
  {
    nom: "localstorage-de-a",
    mecanisme: "localStorage",
    intention: "lire la clé posée par A",
    run() {
      if (!globalThis.localStorage) return indisponible("localStorage absent");
      const valeur = localStorage.getItem(ACTIFS_A.storageCle);
      return valeur === null ? invisible("clé absente") : lu(`valeur lue : ${valeur}`);
    },
  },
  {
    nom: "cookie-global-de-a",
    mecanisme: "cookies",
    intention: "lire le cookie que A a posé avec « Path=/ »",
    run() {
      const present = document.cookie.includes(`${ACTIFS_A.cookieGlobal}=`);
      return present
        ? lu(`document.cookie : ${document.cookie}`)
        : invisible(`document.cookie : ${document.cookie || "vide"}`);
    },
  },
  {
    nom: "cookie-de-chemin-de-a",
    mecanisme: "cookies",
    intention: "lire le cookie laissé par A à son chemin par défaut",
    run() {
      const present = document.cookie.includes(`${ACTIFS_A.cookieChemin}=`);
      return present
        ? lu(`document.cookie : ${document.cookie}`)
        : invisible("l'attribut Path retient ce cookie hors du répertoire de B");
    },
  },
  {
    nom: "cookie-de-chemin-par-cadre-imbrique",
    mecanisme: "cookies",
    intention: "contourner l'attribut Path en encadrant un document du répertoire de A",
    async run() {
      const cadre = document.createElement("iframe");
      cadre.title = "document du répertoire de l'application A";
      cadre.src = new URL(`${CHEMIN_APP_A}vide.html`, origineCibleA).toString();
      document.body.append(cadre);
      try {
        await new Promise((resolu, echoue) => {
          cadre.addEventListener("load", resolu, { once: true });
          cadre.addEventListener("error", () => echoue(new Error("cadre non chargé")), {
            once: true,
          });
          setTimeout(() => echoue(new Error("cadre non chargé en 3 s")), 3000);
        });
        const cookies = cadre.contentDocument.cookie;
        return cookies.includes(`${ACTIFS_A.cookieChemin}=`)
          ? lu(`cookie de chemin relu depuis le répertoire de A : ${cookies}`)
          : invisible(`cadre lisible mais cookie absent : ${cookies || "vide"}`);
      } catch (erreur) {
        return invisible(decrire(erreur));
      } finally {
        cadre.remove();
      }
    },
  },
  {
    nom: "verrou-de-a",
    mecanisme: "Web Locks",
    intention: "observer le verrou d'écrivain que A tient, puis le contester",
    async run() {
      if (!navigator.locks) return indisponible("navigator.locks absent");
      const etat = await navigator.locks.query();
      const noms = [...etat.held, ...etat.pending].map((entree) => entree.name);
      if (!noms.includes(ACTIFS_A.verrou)) {
        return invisible(`verrous visibles : ${noms.join(", ") || "aucun"}`);
      }
      const libre = await navigator.locks.request(
        ACTIFS_A.verrou,
        { mode: "exclusive", ifAvailable: true },
        (verrou) => verrou !== null,
      );
      return lu(`verrou ${ACTIFS_A.verrou} visible ; disponible immédiatement : ${libre}`);
    },
  },
  {
    nom: "diffusion-de-a",
    mecanisme: "BroadcastChannel",
    intention: "écouter le canal de contrôle de A",
    async run() {
      if (typeof BroadcastChannel !== "function") return indisponible("BroadcastChannel absent");
      const canal = new BroadcastChannel(ACTIFS_A.canal);
      const recu = await new Promise((resolu) => {
        canal.addEventListener("message", (evenement) => resolu(evenement.data), { once: true });
        setTimeout(() => resolu(null), 1500);
      });
      canal.close();
      return recu === null
        ? invisible("aucune diffusion reçue en 1,5 s")
        : lu(`diffusion captée : ${JSON.stringify(recu)}`);
    },
  },
  {
    nom: "cache-storage-enumeration",
    mecanisme: "Cache Storage",
    intention: "énumérer les caches de la partition et y trouver celui de A",
    async run() {
      if (!globalThis.caches) return indisponible("caches absent");
      const noms = await caches.keys();
      return noms.includes(ACTIFS_A.cache)
        ? lu(`caches énumérés : ${noms.join(", ")}`)
        : invisible(`caches énumérés : ${noms.join(", ") || "aucun"}`);
    },
  },
  {
    nom: "cache-storage-lecture-de-a",
    mecanisme: "Cache Storage",
    intention: "lire la réponse que A a mise en cache",
    async run() {
      if (!globalThis.caches) return indisponible("caches absent");
      const reponse = await caches.match(ACTIFS_A.cacheRequete);
      return reponse ? lu(`réponse lue : ${await reponse.text()}`) : invisible("aucune réponse");
    },
  },
  {
    nom: "service-worker-enumeration-de-a",
    mecanisme: "Service Worker",
    intention: "énumérer les inscriptions de la partition et y trouver la portée de A",
    async run() {
      if (!("serviceWorker" in navigator)) return indisponible("navigator.serviceWorker absent");
      const portees = (await navigator.serviceWorker.getRegistrations()).map((i) => i.scope);
      const attendue = new URL(CHEMIN_APP_A, origineCibleA).toString();
      return portees.includes(attendue)
        ? lu(`portées énumérées : ${portees.join(", ")}`)
        : invisible(`portées énumérées : ${portees.join(", ") || "aucune"}`);
    },
  },
  {
    nom: "service-worker-portee-de-a-reclamee",
    mecanisme: "Service Worker",
    intention: "réclamer la portée de A pour un script servi sous le répertoire de B",
    async run() {
      if (!("serviceWorker" in navigator)) return indisponible("navigator.serviceWorker absent");
      try {
        const inscription = await navigator.serviceWorker.register("./app-b-sw.mjs", {
          scope: CHEMIN_APP_A,
        });
        return lu(`portée obtenue : ${inscription.scope}`);
      } catch (erreur) {
        return invisible(decrire(erreur));
      }
    },
  },
  {
    nom: "canary-de-a-intercepte",
    mecanisme: "Service Worker",
    intention: "vérifier si le Service Worker de A intercepte une requête émise par B",
    async run() {
      const url = new URL(`${CHEMIN_APP_A}${CANARY_NOM}`, origineCibleA).toString();
      try {
        const reponse = await fetch(url, { cache: "no-store" });
        const texte = (await reponse.text()).trim();
        return texte.includes("intercepte")
          ? lu(`ressource témoin servie par le Service Worker de A : ${texte}`)
          : invisible(`ressource témoin authentique : ${texte}`);
      } catch (erreur) {
        return invisible(decrire(erreur));
      }
    },
  },
  {
    // Dernière sonde, et cet ordre est une contrainte de mesure : elle DÉTRUIT l'inscription de A,
    // dont dépendent les deux sondes précédentes.
    nom: "service-worker-desinscription-de-a",
    mecanisme: "Service Worker",
    intention: "désinscrire le Service Worker de A — lui retirer son mode hors ligne",
    async run() {
      if (!("serviceWorker" in navigator)) return indisponible("navigator.serviceWorker absent");
      const attendue = new URL(CHEMIN_APP_A, origineCibleA).toString();
      const inscriptions = await navigator.serviceWorker.getRegistrations();
      const cible = inscriptions.find((inscription) => inscription.scope === attendue);
      if (!cible) return invisible("aucune inscription de A dans cette partition");
      const retiree = await cible.unregister();
      return retiree
        ? lu("inscription de A retirée : son mode hors ligne est éteint")
        : invisible("désinscription refusée");
    },
  },
];

/** Un relevé incomplet est un relevé faux : le nombre de sondes est publié avec elles. */
export const NOMBRE_DE_SONDES = SONDES.length;

async function lire() {
  const releve = [];
  for (const sonde of SONDES) {
    try {
      const issue = await sonde.run();
      releve.push({
        nom: sonde.nom,
        mecanisme: sonde.mecanisme,
        intention: sonde.intention,
        ...issue,
      });
    } catch (erreur) {
      releve.push({
        nom: sonde.nom,
        mecanisme: sonde.mecanisme,
        intention: sonde.intention,
        resultat: "invisible",
        detail: decrire(erreur),
      });
    }
    publier(releve, "sondes-en-cours");
  }
  publier(releve, `sondes-terminees:${releve.length}`);
  return releve;
}

// --- Phase « annonce » : la liste d'admission de la coquille distingue-t-elle A de B ? ---------

async function annoncer() {
  const obtenu = await new Promise((resolu) => {
    window.addEventListener("message", (evenement) => {
      if (evenement.data?.type === "vault.channel-grant" && evenement.ports[0]) resolu(true);
    });
    parent.postMessage({ type: "vault.app-hello" }, "*");
    setTimeout(() => resolu(false), 3000);
  });
  const rapport = { application, portRestreintObtenu: obtenu, origine: location.origin };
  publier(rapport, obtenu ? "port-obtenu" : "port-refuse");
  return rapport;
}

const PHASES = { poser, lire, annonce: annoncer };

const executer = PHASES[phase];
if (!executer) {
  publier({ erreur: `phase inconnue : ${phase}` }, "erreur");
} else {
  window.__rapportApplication = executer().catch((erreur) => {
    publier({ erreur: decrire(erreur) }, "erreur");
    return null;
  });
}
