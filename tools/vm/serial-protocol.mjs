// Codec du pont série `@VLT1`, côté hôte.
//
// Le guest n'a pas de réseau émulé : une requête HTTP vers Rails traverse le
// port série sous forme de lignes ASCII. Ce module ne connaît ni v86 ni Node :
// il transforme des requêtes en lignes et des lignes en réponses, ce qui le rend
// vérifiable par `tests/unit/serial-protocol.test.mjs` sans démarrer de VM.
//
// Le protocole est décrit en tête de
// `tools/build-reference-image/guest/serial-bridge.py`, qui en est l'autre
// moitié. Son principe est repris de RailsBox Live (MIT, commit
// a36baf0bcbdec65ca3749ba1fb6d7b94e4abd594) et volontairement réduit : ni
// horloge, ni environnement, ni redémarrage.

export const MAGIC = "@VLT1";

/** Multiple de 4 : chaque tranche base64 reste décodable isolément. */
export const TAILLE_TRANCHE = 8000;

/**
 * @typedef {{ method: string, path: string, headers?: [string, string][], body?: Uint8Array | null }} Requete
 */

/**
 * Construit les lignes d'une requête, dans l'ordre d'émission.
 *
 * Les tranches de corps sont rendues séparément : l'appelant n'envoie la
 * suivante qu'après l'`ACK` de la précédente, ce qui borne les octets en vol et
 * évite le débordement du tampon d'entrée du tty du guest.
 *
 * @param {string} identifiant
 * @param {Requete} requete
 * @returns {{ ouverture: string, tranches: string[], cloture: string }}
 */
export function construireTramesRequete(identifiant, requete) {
  if (!/^[0-9a-zA-Z_-]+$/.test(identifiant)) {
    throw new TypeError(`identifiant de requête invalide : ${identifiant}`);
  }
  const corps = requete.body ?? new Uint8Array(0);
  const descripteur = {
    method: requete.method,
    path: requete.path,
    headers: requete.headers ?? [],
    bodyLength: corps.byteLength,
  };
  const encode = base64Depuis(new TextEncoder().encode(JSON.stringify(descripteur)));

  const tranches = [];
  for (let debut = 0; debut < corps.byteLength; debut += TAILLE_TRANCHE) {
    const morceau = corps.subarray(debut, Math.min(debut + TAILLE_TRANCHE, corps.byteLength));
    tranches.push(`${MAGIC} BOD ${identifiant} ${base64Depuis(morceau)}`);
  }

  return {
    ouverture: `${MAGIC} REQ ${identifiant} ${encode}`,
    tranches,
    cloture: `${MAGIC} FIN ${identifiant}`,
  };
}

/**
 * Découpe un flux d'octets série en lignes complètes.
 *
 * @param {(ligne: string) => void} surLigne
 * @returns {{ ajouter: (texte: string) => void, reste: () => string }}
 */
export function creerAssembleurLignes(surLigne) {
  let tampon = "";
  return {
    ajouter(texte) {
      tampon += texte;
      let coupure = tampon.indexOf("\n");
      while (coupure !== -1) {
        const ligne = tampon.slice(0, coupure).replace(/\r$/, "");
        tampon = tampon.slice(coupure + 1);
        if (ligne !== "") surLigne(ligne);
        coupure = tampon.indexOf("\n");
      }
    },
    reste: () => tampon,
  };
}

/**
 * @typedef {{ type: "journal", texte: string }
 *   | { type: "ack", id: string }
 *   | { type: "reponse", id: string, octets: Uint8Array }
 *   | { type: "erreur", id: string, code: number, libelle: string }
 *   | null} Evenement
 */

/**
 * Réassemble les réponses du guest.
 *
 * Un `RSB` annonce la taille BRUTE de la réponse : le tampon est alloué une
 * seule fois, à la taille exacte, et chaque tranche y est décodée au vol. Une
 * tranche qui déborderait de la taille annoncée est une erreur, pas une
 * troncature silencieuse.
 *
 * @returns {{ traiterLigne: (ligne: string) => Evenement }}
 */
export function creerAssembleurReponses() {
  /** @type {Map<string, { octets: Uint8Array, position: number }>} */
  const enCours = new Map();

  return {
    traiterLigne(ligne) {
      if (!ligne.startsWith(`${MAGIC} `)) return { type: "journal", texte: ligne };

      const [, verbe, identifiant, ...reste] = ligne.split(" ");
      switch (verbe) {
        case "LOG":
          return { type: "journal", texte: [identifiant, ...reste].join(" ") };
        case "ACK":
          return { type: "ack", id: identifiant };
        case "RSB": {
          const taille = Number.parseInt(reste[0] ?? "", 10);
          if (!Number.isInteger(taille) || taille < 0) {
            return { type: "erreur", id: identifiant, code: 56, libelle: "taille-annoncee-invalide" };
          }
          enCours.set(identifiant, { octets: new Uint8Array(taille), position: 0 });
          return null;
        }
        case "DAT": {
          const entree = enCours.get(identifiant);
          if (entree === undefined) {
            return { type: "erreur", id: identifiant, code: 56, libelle: "tranche-sans-entete" };
          }
          const morceau = octetsDepuisBase64(reste[0] ?? "");
          if (entree.position + morceau.byteLength > entree.octets.byteLength) {
            enCours.delete(identifiant);
            return { type: "erreur", id: identifiant, code: 56, libelle: "reponse-plus-longue-qu-annoncee" };
          }
          entree.octets.set(morceau, entree.position);
          entree.position += morceau.byteLength;
          return null;
        }
        case "END": {
          const entree = enCours.get(identifiant);
          enCours.delete(identifiant);
          if (entree === undefined) {
            return { type: "erreur", id: identifiant, code: 56, libelle: "fin-sans-entete" };
          }
          if (entree.position !== entree.octets.byteLength) {
            return { type: "erreur", id: identifiant, code: 56, libelle: "reponse-tronquee" };
          }
          return { type: "reponse", id: identifiant, octets: entree.octets };
        }
        case "ERR": {
          enCours.delete(identifiant);
          return {
            type: "erreur",
            id: identifiant,
            code: Number.parseInt(reste[0] ?? "0", 10),
            libelle: reste.slice(1).join(" ") || "sans-libelle",
          };
        }
        default:
          return { type: "journal", texte: ligne };
      }
    },
  };
}

/**
 * Sépare une réponse HTTP brute en statut, en-têtes et corps.
 *
 * @param {Uint8Array} octets
 * @returns {{ statut: number, message: string, entetes: Record<string, string>, corps: Uint8Array }}
 */
export function decouperReponseHttp(octets) {
  const separation = indexDeSeparation(octets);
  if (separation === -1) throw new Error("réponse HTTP sans séparation en-tête/corps");

  const tete = new TextDecoder("utf-8").decode(octets.subarray(0, separation));
  const [ligneStatut, ...lignesEntetes] = tete.split("\r\n");
  const correspondance = ligneStatut.match(/^HTTP\/\d(?:\.\d)?\s+(\d{3})\s*(.*)$/);
  if (correspondance === null) throw new Error(`ligne de statut illisible : ${ligneStatut}`);

  /** @type {Record<string, string>} */
  const entetes = {};
  for (const ligne of lignesEntetes) {
    const position = ligne.indexOf(":");
    if (position === -1) continue;
    entetes[ligne.slice(0, position).trim().toLowerCase()] = ligne.slice(position + 1).trim();
  }

  return {
    statut: Number.parseInt(correspondance[1], 10),
    message: correspondance[2],
    entetes,
    corps: octets.subarray(separation + 4),
  };
}

/**
 * @param {Uint8Array} octets
 * @returns {number}
 */
function indexDeSeparation(octets) {
  for (let index = 0; index + 3 < octets.byteLength; index += 1) {
    if (
      octets[index] === 13 &&
      octets[index + 1] === 10 &&
      octets[index + 2] === 13 &&
      octets[index + 3] === 10
    ) {
      return index;
    }
  }
  return -1;
}

/**
 * @param {Uint8Array} octets
 * @returns {string}
 */
export function base64Depuis(octets) {
  let binaire = "";
  for (const octet of octets) binaire += String.fromCharCode(octet);
  return btoa(binaire);
}

/**
 * @param {string} texte
 * @returns {Uint8Array}
 */
export function octetsDepuisBase64(texte) {
  const binaire = atob(texte);
  const octets = new Uint8Array(binaire.length);
  for (let index = 0; index < binaire.length; index += 1) octets[index] = binaire.charCodeAt(index);
  return octets;
}
