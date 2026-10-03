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
  for (let debut = 0; debut < octets.byteLength; debut += TRANCHE_OCTETS) {
    empreintes.push(
      await hacher(octets.subarray(debut, Math.min(octets.byteLength, debut + TRANCHE_OCTETS))),
    );
  }
  return empreintes;
}

/** RACINE : SHA-256 de la concaténation des empreintes BRUTES (32 octets chacune) des tranches. */
export async function racineDesTranches(empreintes, hacher = hacherParWebCrypto) {
  const concatenation = new Uint8Array(empreintes.length * 32);
  empreintes.forEach((hex, index) => concatenation.set(depuisHex(hex), index * 32));
  return hacher(concatenation);
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
 *           peutAdmettre?: (octets: number) => Promise<boolean> }} options
 */
export function creerMagasinDArtefacts({
  primitives,
  hacher = hacherParWebCrypto,
  peutAdmettre = async () => true,
}) {
  const contexte = { primitives, hacher, peutAdmettre };
  return {
    /**
     * SERT un artefact rangé dans `cible` (une vue de `morceau.octets` octets), après vérification.
     * Rend `false` — et oublie l'entrée si elle existait — dès qu'il n'est pas conforme.
     *
     * @param {{ sha256: string, octets: number, racine?: string }} morceau
     * @param {Uint8Array} cible
     */
    servir: (morceau, cible) => servir(contexte, morceau, cible),
    /**
     * ADMET un artefact DÉJÀ vérifié contre le descripteur (`octets` est une vue sur le tampon : aucune
     * copie). Le budget est consulté AVANT la première écriture ; un refus est typé (`AdmissionRefusee`).
     *
     * @param {{ sha256: string, octets: Uint8Array }} artefact
     */
    admettre: (artefact) => admettre(contexte, artefact),
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

/** Lit et vérifie l'artefact rangé DANS `cible` (gros appels de 8 Mio). Rend `true` s'il est conforme. */
async function verserEtVerifier({ primitives, hacher }, morceau, cible, tranches) {
  const flux = tranches === null ? createSha256Stream() : null;
  for (let debut = 0, index = 0; debut < morceau.octets; debut += TRANCHE_OCTETS, index += 1) {
    const vue = cible.subarray(debut, Math.min(morceau.octets, debut + TRANCHE_OCTETS));
    if ((await primitives.lire(morceau.sha256, debut, vue)) !== vue.byteLength) return false;
    if (flux !== null) flux.update(vue);
    else if ((await hacher(vue)) !== tranches[index]) return false;
  }
  return flux === null || flux.digestHex() === morceau.sha256;
}

async function servir(contexte, morceau, cible) {
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
  if (await verserEtVerifier(contexte, morceau, cible, tranches)) return true;
  await oublier(contexte, morceau.sha256);
  return false;
}

async function admettre(contexte, { sha256, octets }) {
  const { primitives, hacher, peutAdmettre } = contexte;
  if (!EMPREINTE.test(sha256)) throw new TypeError(`Empreinte invalide : ${sha256}`);
  if (!(await peutAdmettre(octets.byteLength))) {
    throw new AdmissionRefusee(
      `Artefact ${sha256} non rangé : ${octets.byteLength} octets refusés par le budget de stockage.`,
    );
  }
  await oublier(contexte, sha256);
  const partiel = sha256 + SUFFIXE_PARTIEL;
  for (let debut = 0; debut < octets.byteLength; debut += TRANCHE_OCTETS) {
    const fin = Math.min(octets.byteLength, debut + TRANCHE_OCTETS);
    await primitives.ecrire(partiel, debut, octets.subarray(debut, fin));
  }
  const tranches = await empreintesDeTranches(octets, hacher);
  const liste = JSON.stringify({ sha256, octets: octets.byteLength, tranches });
  await primitives.ecrire(sha256 + SUFFIXE_TRANCHES, 0, new TextEncoder().encode(liste));
  // EN DERNIER : le nom définitif est le marqueur « complet ».
  await primitives.renommer(partiel, sha256);
  return { tranches, racine: await racineDesTranches(tranches, hacher) };
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
