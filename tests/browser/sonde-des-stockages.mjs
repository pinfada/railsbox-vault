// La SONDE des SIX STOCKAGES : ce qui reste sur l'appareil quand tout est fini (#22, #162, #170).
//
// Elle dépose un APPÂT dans chaque stockage, puis fouille TOUT ce que l'origine de confiance porte :
// `localStorage`, `sessionStorage`, les cookies, IndexedDB, le Cache Storage et l'OPFS ENTIER — ce
// dernier en texte ET en hexadécimal —, plus le DOM et les deux sens des ports quand un
// enregistreur les a relevés.
//
// **Elle rend du TEXTE, pas un verdict**, comme celle de #22. Le verdict est l'affaire de
// l'épreuve, qui y cherche des marqueurs qu'elle connaît, et qui vérifie d'abord que la fouille
// TROUVE ce qui s'y trouve : une recherche qui ne trouve jamais rien peut n'être qu'une recherche
// cassée, et c'est le TÉMOIN POSITIF qui l'écarte.
//
// ## Pourquoi elle vit ici, et non dans une suite
//
// #162 la joue sur une coquille OUVERTE, #169 après un VERROUILLAGE, #170 après une FERMETURE
// d'onglet sans verrouillage. Trois suites, une seule fouille : deux copies auraient divergé au
// premier stockage ajouté, et la plus ancienne serait restée verte en fouillant moins.
//
// ## L'AVEU, qui voyage avec elle
//
// Elle mesure ce qui n'est pas **persisté**, pas ce qui est **effacé d'un tas**. Elle ne peut rien
// dire de la mémoire d'un processus, d'un fichier d'échange, ni des octets d'une `CryptoKey` — que,
// par construction, aucun code de cette origine ne peut lire (ADR 0021, décision 7).

/**
 * Dépose l'appât, fouille les six stockages, et rend ce qu'elle a lu.
 *
 * @param {import("@playwright/test").Page} page
 * @param {string} appat un marqueur PUBLIC, sans valeur : c'est un témoin, pas un secret
 * @param {{ noeudsARetirer?: string[] }} [options] identifiants de nœuds du DOM où le secret est
 *   délibérément écrit, retirés avant la lecture du document : la fouille vérifie qu'il n'a pas
 *   ESSAIMÉ ailleurs, pas qu'il n'est nulle part
 */
export async function sonder(page, appat, { noeudsARetirer = [] } = {}) {
  return page.evaluate(
    async ({ marqueur, noeudsARetirer }) => {
      const morceaux = [];
      const note = (ou, texte) => morceaux.push({ ou, texte });

      try {
        localStorage.setItem("vault-appat", marqueur);
        sessionStorage.setItem("vault-appat", marqueur);
      } catch {
        /* un stockage refusé n'invalide pas les autres */
      }
      document.cookie = `vault-appat=${encodeURIComponent(marqueur)}; path=/`;
      try {
        const cache = await caches.open("vault-appat");
        await cache.put(new Request("/vault-appat"), new Response(marqueur));
      } catch {
        /* Cache Storage peut manquer : la sonde le dira par une chaîne vide */
      }
      await new Promise((rendre) => {
        if (!globalThis.indexedDB) return rendre();
        const requete = indexedDB.open("vault-appat", 1);
        requete.onupgradeneeded = () => requete.result.createObjectStore("appat");
        requete.onsuccess = () => {
          const base = requete.result;
          const transaction = base.transaction("appat", "readwrite");
          transaction.objectStore("appat").put(marqueur, "cle");
          transaction.oncomplete = () => {
            base.close();
            rendre();
          };
          transaction.onerror = () => rendre();
        };
        requete.onerror = () => rendre();
      });
      try {
        const racine = await navigator.storage.getDirectory();
        const fichier = await racine.getFileHandle("vault-appat.txt", { create: true });
        const flux = await fichier.createWritable();
        await flux.write(marqueur);
        await flux.close();
      } catch {
        /* OPFS peut manquer (WebKit) : la sonde le dira */
      }

      const lireStockage = (stockage) => {
        if (!stockage) return "";
        const lignes = [];
        for (let index = 0; index < stockage.length; index += 1) {
          const cle = stockage.key(index);
          lignes.push(`${cle}=${stockage.getItem(cle)}`);
        }
        return lignes.join("\n");
      };
      note("localStorage", lireStockage(globalThis.localStorage));
      note("sessionStorage", lireStockage(globalThis.sessionStorage));
      note("cookies", document.cookie);

      let indexedDb = "";
      if (globalThis.indexedDB?.databases) {
        const lignes = [];
        for (const { name } of await indexedDB.databases()) {
          if (!name) continue;
          lignes.push(name);
          lignes.push(
            await new Promise((rendre) => {
              const requete = indexedDB.open(name);
              requete.onsuccess = () => {
                const base = requete.result;
                const magasins = [...base.objectStoreNames];
                if (magasins.length === 0) {
                  base.close();
                  return rendre("");
                }
                const transaction = base.transaction(magasins, "readonly");
                const lus = [];
                for (const magasin of magasins) {
                  const tout = transaction.objectStore(magasin).getAll();
                  tout.onsuccess = () => lus.push(JSON.stringify(tout.result));
                }
                transaction.oncomplete = () => {
                  base.close();
                  rendre(lus.join("\n"));
                };
                transaction.onerror = () => rendre("");
              };
              requete.onerror = () => rendre("");
            }),
          );
        }
        indexedDb = lignes.join("\n");
      }
      note("indexedDB", indexedDb);

      let cacheStorage = "";
      if (globalThis.caches) {
        const lignes = [];
        for (const nom of await caches.keys()) {
          const cache = await caches.open(nom);
          for (const requete of await cache.keys()) {
            lignes.push(requete.url, await (await cache.match(requete)).text());
          }
        }
        cacheStorage = lignes.join("\n");
      }
      note("cacheStorage", cacheStorage);

      // L'OPFS ENTIER, fichiers de volume et d'enveloppes compris, en texte ET en hexadécimal.
      let opfs = "";
      if (navigator.storage?.getDirectory) {
        const lignes = [];
        const parcourir = async (repertoire, prefixe) => {
          for await (const [nom, poignee] of repertoire.entries()) {
            lignes.push(`${prefixe}${nom}`);
            if (poignee.kind === "directory") {
              await parcourir(poignee, `${prefixe}${nom}/`);
              continue;
            }
            const octets = new Uint8Array(await (await poignee.getFile()).arrayBuffer());
            lignes.push(new TextDecoder("latin1").decode(octets));
            let hex = "";
            for (const octet of octets) hex += octet.toString(16).padStart(2, "0");
            lignes.push(hex);
          }
        };
        await parcourir(await navigator.storage.getDirectory(), "");
        opfs = lignes.join("\n");
      }
      note("opfs", opfs);

      // Les DEUX SENS des ports — privilégié ET restreint —, relevés au niveau de la plate-forme.
      note("ports-envois", globalThis.__traficDesPorts.envois.join("\n"));
      note("ports-recus", globalThis.__traficDesPorts.recus.join("\n"));
      // Ce que le DOM montre, moins les nœuds où le code est délibérément écrit : la feuille est le
      // seul endroit où il vive, et la sonde vérifie qu'il n'a pas essaimé ailleurs dans la page.
      for (const identifiant of noeudsARetirer) {
        document.querySelector(`#${identifiant}`)?.remove();
      }
      note("dom", document.documentElement.outerHTML);
      return morceaux;
    },
    { marqueur: appat, noeudsARetirer },
  );
}
