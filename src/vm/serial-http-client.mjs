// Client HTTP au-dessus du pont série `@VLT1`. Le guest de l'image de référence n'a pas de réseau
// émulé : une requête vers Rails traverse ttyS0 sous forme de lignes ASCII, dont le codec vit dans
// `serial-protocol.mjs`. Ce module y ajoute la seule chose que le codec ne porte pas : la CONDUITE
// d'un échange — ouverture, acquittement de chaque tranche de corps, clôture, puis attente de la
// réponse, avec un délai de garde.
//
// Il ne connaît ni v86 ni Node : il reçoit une fonction `send(ligne)` et se nourrit du texte série
// par `ingest(texte)`. Le harnais Node du boot de référence et le Worker de la preuve de reprise
// (#7) partagent ainsi exactement le même code d'échange, vérifiable sans démarrer de VM.

import {
  construireTramesRequete,
  creerAssembleurLignes,
  creerAssembleurReponses,
  decouperReponseHttp,
} from "./serial-protocol.mjs";

/** Délai de garde par défaut d'une requête, en millisecondes. */
export const DEFAULT_REQUEST_TIMEOUT_MS = 120_000;

/**
 * @param {{ send: (ligne: string) => void, onLog?: (texte: string) => void }} options
 *   `send` émet une ligne (sans le `\n` final, ajouté ici) vers le guest.
 *   `onLog` reçoit toute ligne applicative relayée telle quelle par le pont.
 */
export function createSerialHttpClient({ send, onLog = () => {} }) {
  if (typeof send !== "function") {
    throw new TypeError("createSerialHttpClient exige une fonction send.");
  }

  const reponses = creerAssembleurReponses();
  /** @type {Map<string, { resolve: (v: any) => void, reject: (e: Error) => void }>} */
  const enAttente = new Map();
  /** @type {Map<string, () => void>} */
  const acquittements = new Map();
  let compteur = 0;

  const lignes = creerAssembleurLignes((ligne) => {
    const evenement = reponses.traiterLigne(ligne);
    if (evenement === null) return;
    if (evenement.type === "journal") {
      onLog(evenement.texte);
      return;
    }
    if (evenement.type === "ack") {
      acquittements.get(evenement.id)?.();
      return;
    }
    const attente = enAttente.get(evenement.id);
    if (attente === undefined) return;
    enAttente.delete(evenement.id);
    if (evenement.type === "erreur") {
      attente.reject(
        new Error(`le pont a refusé la requête : ${evenement.libelle} (code ${evenement.code})`),
      );
    } else {
      attente.resolve(decouperReponseHttp(evenement.octets));
    }
  });

  return {
    /** Nourrit le client d'un fragment de texte série déjà décodé. */
    ingest(texte) {
      lignes.ajouter(texte);
    },

    /** Nombre de requêtes encore en vol. */
    pendingCount() {
      return enAttente.size;
    },

    /**
     * Émet une requête HTTP et rend la réponse décodée.
     *
     * @param {string} methode
     * @param {string} chemin
     * @param {{ headers?: [string, string][], body?: Uint8Array | null, timeoutMs?: number }} [reglages]
     * @returns {Promise<{ statut: number, message: string, entetes: Record<string, string>, corps: Uint8Array }>}
     */
    async request(methode, chemin, reglages = {}) {
      const identifiant = `r${(compteur += 1)}`;
      const delaiMs = reglages.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
      const trames = construireTramesRequete(identifiant, {
        method: methode,
        path: chemin,
        headers: reglages.headers ?? [
          ["Host", "127.0.0.1"],
          ["Accept", "application/json"],
          ["User-Agent", "railsbox-vault-reprise"],
        ],
        body: reglages.body ?? null,
      });

      const promesse = new Promise((resolve, reject) => {
        const minuterie = setTimeout(() => {
          enAttente.delete(identifiant);
          reject(new Error(`aucune réponse à ${methode} ${chemin} en ${delaiMs} ms`));
        }, delaiMs);
        enAttente.set(identifiant, {
          resolve: (valeur) => {
            clearTimeout(minuterie);
            resolve(valeur);
          },
          reject: (erreur) => {
            clearTimeout(minuterie);
            reject(erreur);
          },
        });
      });

      send(`${trames.ouverture}\n`);
      for (const tranche of trames.tranches) {
        const acquitte = new Promise((resolve) => acquittements.set(identifiant, resolve));
        send(`${tranche}\n`);
        await acquitte;
        acquittements.delete(identifiant);
      }
      send(`${trames.cloture}\n`);
      return promesse;
    },
  };
}
