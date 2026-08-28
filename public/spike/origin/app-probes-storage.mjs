// Sondes portant sur le STOCKAGE et les canaux de l'origine : OPFS, IndexedDB, Web Locks,
// BroadcastChannel et Service Worker. Ce sont les capacités qu'une frontière d'origine partitionne
// et qu'un attribut `sandbox` ne partitionne pas — d'où leur poids dans la matrice de décision.

import {
  CONTROL_CHANNEL_NAME,
  IDB_HOSTILE_KEY,
  IDB_SHELL_KEY,
  OPFS_ENVELOPPE_MARKER,
  OPFS_HOSTILE_MARKER,
  OPFS_VOLUME_MARKER,
  VOLUME_LOCK_NAME,
  openShellDatabase,
  readOpfsMarker,
  transact,
} from "./shell-state.mjs";

export const HOSTILE_MARK = "empreinte-application-hostile";
export const HOSTILE_SERVICE_WORKER = "./app-hostile-sw.mjs";

/**
 * Une capacité ABSENTE du moteur n'est pas une frontière : la confondre avec un refus ferait
 * passer pour sûre une topologie que le navigateur n'a simplement pas pu mettre à l'épreuve.
 * `indisponible` est donc un troisième résultat, distinct de `bloque`.
 */
function indisponible(detail) {
  return { resultat: "indisponible", detail };
}

const STORAGE_PROBES = [
  {
    nom: "lecture-opfs-coquille",
    cible: "coquille",
    intention: "lire le marqueur de volume déposé dans l'OPFS de la coquille",
    async run() {
      if (!navigator.storage?.getDirectory)
        return indisponible("navigator.storage.getDirectory absent");
      const contenu = await readOpfsMarker(OPFS_VOLUME_MARKER);
      return { resultat: "reussi", detail: `marqueur lu : ${contenu}` };
    },
  },
  {
    nom: "lecture-enveloppe-coquille",
    cible: "coquille",
    intention: "lire le fichier d'ENVELOPPE DE CLÉ déposé dans l'OPFS de la coquille (#21)",
    async run() {
      if (!navigator.storage?.getDirectory)
        return indisponible("navigator.storage.getDirectory absent");
      // L'enveloppe est l'actif que #21 ajoute à l'origine de confiance, et il n'est pas le même
      // que le volume : une frontière qui protégerait les octets chiffrés sans protéger la clé qui
      // les ouvre ne protégerait rien. La sonde vise le suffixe RÉEL, `.cles`, pour que ce qu'elle
      // mesure soit ce que le produit dépose.
      const contenu = await readOpfsMarker(OPFS_ENVELOPPE_MARKER);
      return { resultat: "reussi", detail: `enveloppe lue : ${contenu}` };
    },
  },
  {
    nom: "ecriture-opfs-silencieuse",
    // Écrire dans SON PROPRE OPFS n'est pas une compromission : le verdict qui compte est rendu
    // depuis la coquille (`contaminationCoquille`), qui seule sait de quel OPFS il s'agit.
    cible: "origine-propre",
    intention: "déposer un fichier persistant dans l'OPFS joignable",
    async run() {
      if (!navigator.storage?.getDirectory)
        return indisponible("navigator.storage.getDirectory absent");
      const root = await navigator.storage.getDirectory();
      const handle = await root.getFileHandle(OPFS_HOSTILE_MARKER, { create: true });
      const writable = await handle.createWritable();
      await writable.write(HOSTILE_MARK);
      await writable.close();
      return { resultat: "reussi", detail: `${OPFS_HOSTILE_MARKER} écrit dans l'OPFS accessible` };
    },
  },
  {
    nom: "lecture-indexeddb-coquille",
    cible: "coquille",
    intention: "lire la base IndexedDB de la coquille",
    async run() {
      if (!globalThis.indexedDB) return indisponible("indexedDB absent");
      const database = await openShellDatabase();
      const valeur = await transact(database, "readonly", (store) => store.get(IDB_SHELL_KEY));
      database.close();
      if (valeur === undefined) {
        return { resultat: "bloque", detail: "base ouverte mais vide : partition d'origine" };
      }
      return { resultat: "reussi", detail: `enregistrement lu : ${valeur}` };
    },
  },
  {
    nom: "ecriture-indexeddb-silencieuse",
    cible: "origine-propre",
    intention: "persister un enregistrement dans la base joignable",
    async run() {
      if (!globalThis.indexedDB) return indisponible("indexedDB absent");
      const database = await openShellDatabase();
      await transact(database, "readwrite", (store) => store.put(HOSTILE_MARK, IDB_HOSTILE_KEY));
      database.close();
      return { resultat: "reussi", detail: "enregistrement hostile persisté" };
    },
  },
  {
    nom: "observation-verrous-web",
    cible: "coquille",
    intention: "observer et contester le verrou d'écrivain unique",
    async run() {
      if (!navigator.locks) return indisponible("navigator.locks absent");
      const etat = await navigator.locks.query();
      const tenus = [...etat.held, ...etat.pending].map((entree) => entree.name);
      const vu = tenus.includes(VOLUME_LOCK_NAME);
      const acquis = await navigator.locks.request(
        VOLUME_LOCK_NAME,
        { mode: "exclusive", ifAvailable: true },
        (lock) => lock !== null,
      );
      // Acquérir ce NOM sur sa propre origine ne prouve rien : les verrous sont partitionnés par
      // origine. Ce qui compte est de VOIR le verrou de la coquille, donc de partager sa partition.
      if (!vu) {
        return {
          resultat: "bloque",
          detail: `verrou de la coquille invisible ; nom acquis sur l'origine applicative : ${acquis}`,
        };
      }
      return {
        resultat: "reussi",
        detail: `verrou ${VOLUME_LOCK_NAME} visible ; disponible immédiatement : ${acquis}`,
      };
    },
  },
  {
    nom: "ecoute-canal-controle",
    cible: "coquille",
    intention: "écouter le canal de contrôle inter-onglets de la coquille",
    async run(context) {
      if (typeof BroadcastChannel !== "function") return indisponible("BroadcastChannel absent");
      const canal = new BroadcastChannel(CONTROL_CHANNEL_NAME);
      const capture = new Promise((resolved) => {
        canal.addEventListener("message", (event) => resolved(event.data), { once: true });
        setTimeout(() => resolved(null), 1000);
      });
      await context.requestStatus();
      const recu = await capture;
      canal.close();
      if (recu === null) return { resultat: "bloque", detail: "aucune diffusion reçue en 1 s" };
      return { resultat: "reussi", detail: `diffusion captée : ${JSON.stringify(recu)}` };
    },
  },
  {
    nom: "enregistrement-service-worker",
    // La portée obtenue ne dit pas quelle origine elle couvre : le verdict est rendu par la
    // ressource témoin lue depuis l'origine de la coquille (`observerCanary`).
    cible: "origine-propre",
    intention: "enregistrer un Service Worker et mesurer la portée obtenue",
    async run() {
      if (!("serviceWorker" in navigator)) return indisponible("navigator.serviceWorker absent");
      const racine = await tenterEnregistrement({ scope: "/" });
      const defaut = await tenterEnregistrement(undefined);
      if (defaut.scope !== null) {
        return {
          resultat: "reussi",
          detail: `portée obtenue : ${defaut.scope} ; portée racine : ${racine.scope ?? racine.erreur}`,
        };
      }
      return {
        resultat: "bloque",
        detail: `portée par défaut refusée (${defaut.erreur}) ; racine : ${racine.erreur}`,
      };
    },
  },
];

/** @returns {Promise<{ scope: string | null, erreur: string | null }>} */
async function tenterEnregistrement(options) {
  try {
    const registration = await navigator.serviceWorker.register(HOSTILE_SERVICE_WORKER, options);
    return { scope: registration.scope, erreur: null };
  } catch (error) {
    return { scope: null, erreur: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}` };
  }
}

export default STORAGE_PROBES;
