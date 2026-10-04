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

async function lireFichier(fichier, position, cible) {
  if (typeof fichier.createSyncAccessHandle === "function") {
    return avecPoigneeSynchrone(fichier, (poignee) => poignee.read(cible, { at: position }));
  }
  const contenu = await fichier.getFile();
  const tranche = await contenu.slice(position, position + cible.byteLength).arrayBuffer();
  cible.set(new Uint8Array(tranche));
  return tranche.byteLength;
}

async function ecrireFichier(fichier, position, octets) {
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
    lire: async (nom, position, cible) => lireFichier(await ouvrir(nom), position, cible),
    ecrire: async (nom, position, octets) =>
      ecrireFichier(await ouvrir(nom, true), position, octets),
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

/** Les purges ÉCHOUÉES depuis le chargement du module : un dossier tenu ne se tait plus (#247, D1c). */
const bilan = { echecs: 0, derniere: null };

/** Lecture seule du bilan des purges échouées : `{ echecs, derniere }` (nom de l'erreur). */
export const bilanDesPurges = () => ({ ...bilan });

/**
 * Vide tout le magasin de l'origine. Rend `false` sans lever si l'OPFS manque ou si une poignée le
 * tient encore : une purge manquée laisse seulement le refus de place du volume s'exprimer. Un
 * dossier absent n'est pas un échec (rien à libérer) ; tout autre refus est COMPTÉ et signalé, sans
 * jamais devenir une panne pour la personne.
 */
export async function purgerToutLeMagasin(
  stockage = globalThis.navigator?.storage,
  signaler = (message) => globalThis.console?.warn(message),
) {
  if (typeof stockage?.getDirectory !== "function") return false;
  try {
    await (await stockage.getDirectory()).removeEntry(DOSSIER_DU_MAGASIN, { recursive: true });
    return true;
  } catch (erreur) {
    if (erreur?.name === "NotFoundError") return false;
    bilan.echecs += 1;
    bilan.derniere = erreur?.name ?? "Error";
    signaler(
      `VAULT-ARTEFACTS-PURGE-ECHOUEE : le magasin n'a pas pu être vidé (${bilan.derniere}, ` +
        `${bilan.echecs} échec(s)) ; le volume garde la priorité, le refus de place reste possible.`,
    );
    return false;
  }
}

/**
 * Le magasin CÈDE AU VOLUME (ADR 0006) : une réservation du volume qui manquerait de place purge
 * d'abord le magasin, puis mesure à nouveau. Le cache ne coûte jamais une écriture de données.
 *
 * @param {ReturnType<typeof import("./storage-budget.mjs").createStorageBudget>} budget
 */
export function budgetQuiCedeLeMagasin(budget, purger = () => purgerToutLeMagasin()) {
  return {
    ...budget,
    async reserve(octets) {
      const premiere = await budget.reserve(octets);
      if (premiere.sufficient !== false || !(await purger())) return premiere;
      return budget.reserve(octets);
    },
  };
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
  const primitives = primitivesOpfs(ouvrirLeDossier);
  const magasin = creerMagasinDArtefacts({
    primitives,
    ...(peutAdmettre ? { peutAdmettre } : {}),
  });
  return {
    ...borneDansLeTemps(magasin, delaiMs),
    retenir: (courants) => retenir(primitives, magasin, courants),
  };
}

/** Le journal de rétention : il ne JUGE rien (l'intégrité vient du descripteur), il retient seulement. */
export const JOURNAL_DE_RETENTION = "retention.json";
const EMPREINTE = /^[0-9a-f]{64}$/;

async function lireLeJournal(primitives) {
  const taille = await primitives.taille(JOURNAL_DE_RETENTION);
  if (!taille || taille > 4096) return [];
  const brut = new Uint8Array(taille);
  await primitives.lire(JOURNAL_DE_RETENTION, 0, brut);
  try {
    const paquets = JSON.parse(new TextDecoder().decode(brut)).paquets;
    return Array.isArray(paquets) ? paquets.filter((e) => EMPREINTE.test(e)).slice(0, 2) : [];
  } catch {
    return [];
  }
}

/**
 * RÉTENTION en usage réel (ADR 0042 § 4) : après une acquisition réussie, garde le rootfs courant,
 * le paquet courant et le paquet PRÉCÉDENT — celui d'avant la dernière mise à jour —, oublie le reste.
 * Un journal altéré ne coûte au pire qu'un téléchargement : il ne sert jamais un octet.
 */
async function retenir(primitives, magasin, { rootfs, paquet }) {
  const [courant, precedent] = await lireLeJournal(primitives);
  const paquets =
    courant && courant !== paquet ? [paquet, courant] : [paquet, precedent].filter(Boolean);
  await primitives.supprimer(JOURNAL_DE_RETENTION);
  await primitives.ecrire(
    JOURNAL_DE_RETENTION,
    0,
    new TextEncoder().encode(JSON.stringify({ paquets })),
  );
  return magasin.purger([rootfs, ...paquets, JOURNAL_DE_RETENTION]);
}
