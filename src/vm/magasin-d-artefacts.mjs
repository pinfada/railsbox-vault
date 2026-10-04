// MAGASIN D'ARTEFACTS : le rootfs et le paquet rangés dans l'OPFS sous leur empreinte (#247, lot D1).
//
// Un CACHE, jamais une vérité. Un artefact n'y entre qu'après avoir été vérifié en flux contre le
// descripteur (`acquisition-du-disque-systeme.mjs`), et n'en sort qu'après une NOUVELLE vérification :
// un adversaire qui écrit dans l'OPFS ne doit rien pouvoir y faire servir.
//
// ## Rangement
//
// Dans `vault-artefacts/` : `<sha256>` (les octets) et `<sha256>.tranches` (JSON : taille, empreinte
// SHA-256 de chaque tranche de 8 Mio). Les octets sont écrits sous `<sha256>.partiel`, puis renommés
// en dernier : seul le nom définitif vaut « complet », et un artefact partiel n'est jamais servi.
//
// ## Vérification au service
//
// - Avec la RACINE du descripteur (SHA-256 de la concaténation des empreintes brutes de tranches,
//   calculée à la fabrication) : la liste rangée est confrontée à la racine, puis chaque tranche lue
//   à son empreinte. La racine vient de l'origine, pas de l'OPFS : réécrire ensemble tranches et
//   liste ne suffit pas.
// - Sans racine : chemin lent, le `sha256` du fichier entier recalculé en flux.
//
// Toute non-conformité supprime l'entrée et rend `false` : l'appelant retélécharge.
//
// Les primitives de stockage et le hachage sont INJECTÉS, comme le reste de `src/vm/`.

import { createSha256Stream } from "./sha256-stream.mjs";

export const TRANCHE_OCTETS = 8 * 1024 * 1024;
export const DOSSIER_DU_MAGASIN = "vault-artefacts";

const SUFFIXE_PARTIEL = ".partiel";
const SUFFIXE_TRANCHES = ".tranches";
const EMPREINTE = /^[0-9a-f]{64}$/;

/** Admission refusée par le budget de stockage : le volume passe avant le cache (ADR 0006). */
export class AdmissionRefusee extends Error {
  constructor(message) {
    super(message);
    this.name = "AdmissionRefusee";
    this.code = "VAULT-ARTEFACTS-ADMISSION-REFUSEE";
  }
}

const versHex = (octets) => Array.from(octets, (o) => o.toString(16).padStart(2, "0")).join("");

function depuisHex(hex) {
  const octets = new Uint8Array(hex.length / 2);
  for (let i = 0; i < octets.length; i += 1)
    octets[i] = Number.parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return octets;
}

/** SHA-256 par WebCrypto, rendu en hexadécimal. */
export async function hacherParWebCrypto(octets) {
  return versHex(new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", octets)));
}

/** Empreintes des tranches de 8 Mio d'une vue — sans copie : chaque tranche est une sous-vue. */
export async function empreintesDeTranches(octets, hacher = hacherParWebCrypto) {
  const empreintes = [];
  for (const [debut, fin] of bornesDesTranches(octets.byteLength)) {
    empreintes.push(await hacher(octets.subarray(debut, fin)));
  }
  return empreintes;
}

/** Les BORNES des tranches de 8 Mio d'un artefact de `octets` octets : `[début, fin[` de chacune. */
export function bornesDesTranches(octets) {
  const bornes = [];
  for (let debut = 0; debut < octets; debut += TRANCHE_OCTETS) {
    bornes.push([debut, Math.min(octets, debut + TRANCHE_OCTETS)]);
  }
  return bornes;
}

/** Ce que la racine hache : la concaténation des empreintes BRUTES (32 octets chacune). */
export function concatenationDesEmpreintes(empreintes) {
  const concatenation = new Uint8Array(empreintes.length * 32);
  empreintes.forEach((hex, index) => concatenation.set(depuisHex(hex), index * 32));
  return concatenation;
}

/** RACINE : SHA-256 de la concaténation des empreintes BRUTES (32 octets chacune) des tranches. */
export async function racineDesTranches(empreintes, hacher = hacherParWebCrypto) {
  return hacher(concatenationDesEmpreintes(empreintes));
}

/**
 * La même définition, SYNCHRONE, pour la fabrication (`tools/`) : un hacheur synchrone (Node
 * `createHash`) rend la liste des empreintes de tranches et la racine, sans copie des octets.
 *
 * @param {Uint8Array} octets
 * @param {(octets: Uint8Array) => string} hacherSync
 */
export function tranchesEtRacineSync(octets, hacherSync) {
  const tranches = bornesDesTranches(octets.byteLength).map(([debut, fin]) =>
    hacherSync(octets.subarray(debut, fin)),
  );
  return { tranches, racine: hacherSync(concatenationDesEmpreintes(tranches)) };
}

/**
 * @param {{ primitives: {
 *             taille(nom: string): Promise<number | null>,
 *             lire(nom: string, position: number, cible: Uint8Array): Promise<number>,
 *             ecrire(nom: string, position: number, octets: Uint8Array): Promise<void>,
 *             renommer(de: string, vers: string): Promise<void>,
 *             supprimer(nom: string): Promise<void>,
 *             lister(): Promise<string[]> },
 *           hacher?: (octets: Uint8Array) => Promise<string>,
 *           peutAdmettre?: (octets: number) => Promise<boolean>,
 *           signaler?: (message: string) => void }} options
 */
export function creerMagasinDArtefacts({
  primitives,
  hacher = hacherParWebCrypto,
  peutAdmettre = async () => true,
  signaler = (message) => globalThis.console?.warn(message),
}) {
  const contexte = { primitives, hacher, peutAdmettre, signaler };
  return {
    /**
     * SERT un artefact rangé dans `cible` (une vue de `morceau.octets` octets), après vérification.
     * Rend `false` — et oublie l'entrée si elle existait — dès qu'il n'est pas conforme.
     *
     * @param {{ sha256: string, octets: number, racine?: string }} morceau
     * @param {Uint8Array} cible
     * @param {{ annule: boolean }} [jeton] posé par l'appelant qui abandonne : plus rien n'est écrit
     */
    servir: (morceau, cible, jeton) => servir(contexte, morceau, cible, jeton),
    /**
     * ADMET un artefact DÉJÀ vérifié contre le descripteur (`octets` est une vue sur le tampon : aucune
     * copie). Le budget est consulté AVANT la première écriture ; un refus est typé (`AdmissionRefusee`).
     * Avec la `racine` du descripteur, des tranches qui ne la donnent pas ne sont PAS rangées
     * (`MAGASIN_RACINE_INCOHERENTE`). Abandonnée (jeton annulé), l'admission ne renomme rien et rend `null`.
     *
     * @param {{ sha256: string, octets: Uint8Array, racine?: string }} artefact
     * @param {{ annule: boolean }} [jeton]
     */
    admettre: (artefact, jeton) => admettre(contexte, artefact, jeton),
    /** RÉTENTION : oublie toute empreinte hors de `garder` (rootfs courant, paquet courant et précédent). */
    purger: (garder) => purger(contexte, garder),
  };
}

async function oublier({ primitives }, sha256) {
  for (const nom of [sha256, sha256 + SUFFIXE_TRANCHES, sha256 + SUFFIXE_PARTIEL]) {
    await primitives.supprimer(nom);
  }
}

async function lireLaListe({ primitives }, sha256, octets) {
  const taille = await primitives.taille(sha256 + SUFFIXE_TRANCHES);
  if (taille === null || taille > 1024 * 1024) return null;
  const brut = new Uint8Array(taille);
  if ((await primitives.lire(sha256 + SUFFIXE_TRANCHES, 0, brut)) !== taille) return null;
  try {
    const liste = JSON.parse(new TextDecoder().decode(brut));
    const attendues = Math.ceil(octets / TRANCHE_OCTETS);
    if (liste.sha256 !== sha256 || liste.octets !== octets) return null;
    if (!Array.isArray(liste.tranches) || liste.tranches.length !== attendues) return null;
    if (!liste.tranches.every((e) => typeof e === "string" && EMPREINTE.test(e))) return null;
    return liste.tranches;
  } catch {
    return null;
  }
}

/** Un jeton jamais annulé : l'appelant qui ne borne pas l'opération dans le temps. */
const SANS_ANNULATION = Object.freeze({ annule: false });

/**
 * Lit et vérifie l'artefact rangé, tranche par tranche, dans un TAMPON PRIVÉ de 8 Mio ; une tranche
 * n'est COPIÉE dans `cible` qu'une fois lue en entier et vérifiée (revue du 04/10/2026, constat 1).
 * Le jeton est testé à chaque tour, et juste avant chaque copie — sans `await` entre les deux : une
 * opération abandonnée par son appelant n'écrit plus RIEN dans `cible`.
 *
 * Sans racine, une tranche ne peut être jugée seule : elle est copiée après lecture, et RIEN n'est
 * servi avant le `digestHex` final. Un `false` laisse alors la plage entière à retélécharger.
 */
async function verserEtVerifier({ primitives, hacher }, morceau, cible, tranches, jeton) {
  const flux = tranches === null ? createSha256Stream() : null;
  const prive = new Uint8Array(Math.min(morceau.octets, TRANCHE_OCTETS));
  for (const [index, [debut, fin]] of bornesDesTranches(morceau.octets).entries()) {
    if (jeton.annule) return false;
    const vue = prive.subarray(0, fin - debut);
    if ((await primitives.lire(morceau.sha256, debut, vue)) !== vue.byteLength) return false;
    if (flux !== null) flux.update(vue);
    else if ((await hacher(vue)) !== tranches[index]) return false;
    if (jeton.annule) return false;
    cible.set(vue, debut);
  }
  return flux === null || flux.digestHex() === morceau.sha256;
}

async function servir(contexte, morceau, cible, jeton = SANS_ANNULATION) {
  const { primitives, hacher } = contexte;
  if (!EMPREINTE.test(morceau.sha256) || cible.byteLength !== morceau.octets) return false;
  if ((await primitives.taille(morceau.sha256)) !== morceau.octets) {
    const restes = (await primitives.lister()).some((nom) => nom.startsWith(morceau.sha256));
    if (restes) await oublier(contexte, morceau.sha256);
    return false;
  }
  let tranches = null;
  if (morceau.racine !== undefined) {
    tranches = await lireLaListe(contexte, morceau.sha256, morceau.octets);
    if (tranches === null || (await racineDesTranches(tranches, hacher)) !== morceau.racine) {
      await oublier(contexte, morceau.sha256);
      return false;
    }
  }
  if (await verserEtVerifier(contexte, morceau, cible, tranches, jeton)) return true;
  // Abandonnée, l'opération n'a rien jugé : l'entrée n'est pas en cause, elle reste rangée.
  if (!jeton.annule) await oublier(contexte, morceau.sha256);
  return false;
}

/**
 * Écrit le `.partiel` tranche par tranche, chacune COPIÉE d'abord dans un tampon privé : ce qui est
 * haché est exactement ce qui est écrit. Le jeton est testé à chaque tour. Rend les empreintes, ou
 * `null` si l'opération a été abandonnée.
 */
async function ecrireLePartiel({ primitives, hacher }, partiel, octets, jeton) {
  const prive = new Uint8Array(Math.min(octets.byteLength, TRANCHE_OCTETS));
  const tranches = [];
  for (const [debut, fin] of bornesDesTranches(octets.byteLength)) {
    if (jeton.annule) return null;
    const vue = prive.subarray(0, fin - debut);
    vue.set(octets.subarray(debut, fin));
    tranches.push(await hacher(vue));
    await primitives.ecrire(partiel, debut, vue);
  }
  return jeton.annule ? null : tranches;
}

/** L'admission refusée parce que les tranches ne donnent pas la racine du descripteur. */
function racineIncoherente(sha256, attendue, obtenue) {
  return Object.assign(
    new Error(
      `Artefact ${sha256} non rangé : racine des tranches ${obtenue}, le descripteur déclare ${attendue}.`,
    ),
    { code: "MAGASIN_RACINE_INCOHERENTE" },
  );
}

async function admettre(contexte, { sha256, octets, racine }, jeton = SANS_ANNULATION) {
  const { primitives, hacher, peutAdmettre, signaler } = contexte;
  if (!EMPREINTE.test(sha256)) throw new TypeError(`Empreinte invalide : ${sha256}`);
  if (!(await peutAdmettre(octets.byteLength))) {
    throw new AdmissionRefusee(
      `Artefact ${sha256} non rangé : ${octets.byteLength} octets refusés par le budget de stockage.`,
    );
  }
  await oublier(contexte, sha256);
  const partiel = sha256 + SUFFIXE_PARTIEL;
  const tranches = await ecrireLePartiel(contexte, partiel, octets, jeton);
  if (tranches === null) return null;
  const calculee = await racineDesTranches(tranches, hacher);
  // Une racine fausse à la fabrication ferait réécrire l'artefact à CHAQUE démarrage, en silence :
  // rien n'est rangé, et le refus est typé et journalisé (revue du 04/10/2026, constat 2).
  if (racine !== undefined && calculee !== racine) {
    await primitives.supprimer(partiel);
    const erreur = racineIncoherente(sha256, racine, calculee);
    signaler(`${erreur.code} : ${erreur.message}`);
    throw erreur;
  }
  const liste = JSON.stringify({ sha256, octets: octets.byteLength, tranches });
  await primitives.ecrire(sha256 + SUFFIXE_TRANCHES, 0, new TextEncoder().encode(liste));
  // EN DERNIER : le nom définitif est le marqueur « complet ».
  if (jeton.annule) return null;
  await primitives.renommer(partiel, sha256);
  return { tranches, racine: calculee };
}

async function purger(contexte, garder) {
  const gardees = new Set(garder);
  const oubliees = new Set();
  for (const nom of await contexte.primitives.lister()) {
    const sha256 = nom.slice(0, 64);
    if (!gardees.has(sha256) && !oubliees.has(sha256)) {
      oubliees.add(sha256);
      await oublier(contexte, sha256);
    }
  }
  return [...oubliees];
}
