// Les PRIMITIVES OPFS du magasin d'artefacts (#247, lot D1b), sous `vault-artefacts/` de l'origine
// de confiance. Chaque opération ouvre puis REFERME sa poignée : le magasin ne garde jamais une
// poignée exclusive au-delà d'un appel. Accès synchrone dans le Worker quand il existe, sinon la
// voie asynchrone (`getFile` / `createWritable`).

import { DOSSIER_DU_MAGASIN, creerMagasinDArtefacts } from "./magasin-d-artefacts.mjs";

/** Au-delà, le magasin cède : la lecture rend « absent », l'admission est abandonnée (D1a). */
export const DELAI_DU_MAGASIN_MS = 20_000;

const estAbsent = (erreur) =>
  erreur?.name === "NotFoundError" || erreur?.name === "TypeMismatchError";

async function avecPoigneeSynchrone(fichier, agir) {
  const poignee = await fichier.createSyncAccessHandle();
  try {
    return agir(poignee);
  } finally {
    poignee.close();
  }
}

/**
 * @param {() => Promise<FileSystemDirectoryHandle>} dossier le dossier du magasin, ouvert à la demande
 */
export function primitivesOpfs(dossier) {
  const ouvrir = async (nom, creer = false) =>
    (await dossier()).getFileHandle(nom, { create: creer });
  const primitives = {
    async taille(nom) {
      try {
        return (await (await ouvrir(nom)).getFile()).size;
      } catch (erreur) {
        if (estAbsent(erreur)) return null;
        throw erreur;
      }
    },
    async lire(nom, position, cible) {
      const fichier = await ouvrir(nom);
      if (typeof fichier.createSyncAccessHandle === "function") {
        return avecPoigneeSynchrone(fichier, (poignee) => poignee.read(cible, { at: position }));
      }
      const tranche = await (
        await fichier.getFile()
      )
        .slice(position, position + cible.byteLength)
        .arrayBuffer();
      cible.set(new Uint8Array(tranche));
      return tranche.byteLength;
    },
    async ecrire(nom, position, octets) {
      const fichier = await ouvrir(nom, true);
      if (typeof fichier.createSyncAccessHandle === "function") {
        await avecPoigneeSynchrone(fichier, (poignee) => {
          let ecrits = 0;
          while (ecrits < octets.byteLength) {
            ecrits += poignee.write(octets.subarray(ecrits), { at: position + ecrits });
          }
          poignee.flush();
        });
        return;
      }
      const flux = await fichier.createWritable({ keepExistingData: true });
      try {
        await flux.write({ type: "write", position, data: octets });
        await flux.close();
      } catch (erreur) {
        await flux.abort().catch(() => {});
        throw erreur;
      }
    },
    async renommer(de, vers) {
      const fichier = await ouvrir(de);
      if (typeof fichier.move === "function") {
        await fichier.move(vers);
        return;
      }
      const taille = (await fichier.getFile()).size;
      const copie = new Uint8Array(taille);
      await primitives.lire(de, 0, copie);
      await primitives.ecrire(vers, 0, copie);
      await primitives.supprimer(de);
    },
    async supprimer(nom) {
      try {
        await (await dossier()).removeEntry(nom);
      } catch (erreur) {
        if (!estAbsent(erreur)) throw erreur;
      }
    },
    async lister() {
      const noms = [];
      for await (const [nom, entree] of (await dossier()).entries()) {
        if (entree.kind === "file") noms.push(nom);
      }
      return noms;
    },
  };
  return primitives;
}

function avantLEcheance(promesse, delaiMs, quandEchu) {
  let minuterie;
  const echeance = new Promise((resoudre, rejeter) => {
    minuterie = setTimeout(() => {
      try {
        resoudre(quandEchu());
      } catch (erreur) {
        rejeter(erreur);
      }
    }, delaiMs);
  });
  return Promise.race([promesse, echeance]).finally(() => clearTimeout(minuterie));
}

/**
 * Borne `servir` et `admettre` dans le temps : un magasin lent ne retarde jamais le boot au-delà de
 * `delaiMs` — on retombe sur le téléchargement (servir rend `false`, admettre échoue `MAGASIN_LENT`).
 */
export function borneDansLeTemps(magasin, delaiMs = DELAI_DU_MAGASIN_MS) {
  return {
    ...magasin,
    servir: (morceau, cible) =>
      avantLEcheance(magasin.servir(morceau, cible), delaiMs, () => false),
    admettre: (artefact) =>
      avantLEcheance(magasin.admettre(artefact), delaiMs, () => {
        throw Object.assign(new Error("Magasin d'artefacts trop lent : admission abandonnée."), {
          code: "MAGASIN_LENT",
        });
      }),
  };
}

/**
 * Ce que le magasin laisse TOUJOURS libre pour le volume : le cache cède au volume (ADR 0006), jamais
 * l'inverse. Une admission qui entamerait cette marge est refusée.
 */
export const MARGE_RESERVEE_AU_VOLUME = 256 * 1024 * 1024;

/**
 * La règle d'admission tirée du budget de stockage (`createStorageBudget`). Une estimation
 * indisponible refuse : sans mesure, on ne parie pas la place du volume sur un cache.
 *
 * @param {{ reserve(octets: number): Promise<{ sufficient: boolean | null }> }} budget
 */
export function admissionSelonLeBudget(budget, marge = MARGE_RESERVEE_AU_VOLUME) {
  return async (octets) => (await budget.reserve(octets + marge)).sufficient === true;
}

/**
 * Ouvre le magasin réel sur l'OPFS de l'origine, ou rend `null` si l'OPFS manque (le boot télécharge).
 *
 * @param {{ stockage?: StorageManager, delaiMs?: number,
 *           peutAdmettre?: (octets: number) => Promise<boolean> }} [options]
 */
export function ouvrirLeMagasinOpfs({
  stockage = globalThis.navigator?.storage,
  delaiMs = DELAI_DU_MAGASIN_MS,
  peutAdmettre,
} = {}) {
  if (typeof stockage?.getDirectory !== "function") return null;
  let dossier;
  const ouvrirLeDossier = () =>
    (dossier ??= stockage
      .getDirectory()
      .then((racine) => racine.getDirectoryHandle(DOSSIER_DU_MAGASIN, { create: true })));
  const magasin = creerMagasinDArtefacts({
    primitives: primitivesOpfs(ouvrirLeDossier),
    ...(peutAdmettre ? { peutAdmettre } : {}),
  });
  return borneDansLeTemps(magasin, delaiMs);
}
