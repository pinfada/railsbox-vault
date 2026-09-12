/**
 * AES-GCM-SIV (RFC 8452) COMPOSÉ sur WebCrypto, sans une ligne de code tiers — instrument de mesure
 * du spike #185.
 *
 * Il répond à une question précise : le dépôt peut-il obtenir SIV sans dépendance, en n'employant
 * que ce que les trois moteurs exposent déjà ? Oui, et c'est le COÛT de ce « oui » qu'il s'agit de
 * mesurer.
 *
 * Le chiffrement d'un bloc isolé (AES-ECB, dont WebCrypto ne veut pas) s'obtient par AES-CTR : un
 * seul bloc de clair nul sous le compteur B rend E_K(B). En revanche, les DEUX suites de compteurs
 * d'AES-GCM-SIV — les six blocs de dérivation et les blocs de flot — incrémentent leurs QUATRE
 * PREMIERS octets en petit-boutiste, là où AES-CTR de WebCrypto incrémente les derniers bits en
 * gros-boutiste. Aucune des deux suites ne se replie donc sur un appel unique : chaque bloc de seize
 * octets coûte un appel à `crypto.subtle`. C'est la mesure que le banc publie.
 *
 * **Ce module ne détient JAMAIS les octets d'une clé de domaine.** Il accepte une `CryptoKey`
 * AES-CTR non extractible, telle que `crypto.subtle.deriveKey` la rend, et c'est le point que la
 * revue de la PR #202 a établi par exécution : la voie composée est le seul chemin connu vers SIV
 * qui conserve le garanti de plate-forme. Voir `epreuve-cle-non-extractible.mjs`.
 *
 * Ce module ne chiffre rien du produit et n'est importé par aucun module de `src/`.
 */

import { concatener } from "./octets.mjs";
import { polyval } from "./polyval.mjs";

const BLOC = 16;
const ZERO_BLOC = new Uint8Array(BLOC);

/** Compteur d'appels à `crypto.subtle`, remis à zéro par le banc avant chaque mesure. */
export const compteurAppels = { importKey: 0, encrypt: 0 };

/** @returns {number} le total d'appels depuis la dernière remise à zéro */
export function totalAppels() {
  return compteurAppels.importKey + compteurAppels.encrypt;
}

export function remettreCompteurAZero() {
  compteurAppels.importKey = 0;
  compteurAppels.encrypt = 0;
}

async function importerCleAesCtr(cleBrute) {
  compteurAppels.importKey += 1;
  return crypto.subtle.importKey("raw", cleBrute, "AES-CTR", false, ["encrypt"]);
}

/**
 * Importe une fois pour toutes la clé maîtresse d'un domaine. Le produit importe sa clé de domaine
 * à l'ouverture, pas à chaque secteur : compter cet import par scellement gonflerait la mesure d'un
 * appel que le chemin réel ne paie pas.
 *
 * Une `CryptoKey` AES-CTR déjà dérivée — non extractible — est acceptée telle quelle : c'est ainsi
 * que le produit la tiendrait s'il adoptait cette voie.
 */
export async function preparerCleMaitresse(cleOuOctets, longueurEnOctets = 32) {
  if (cleOuOctets instanceof Uint8Array) {
    return { cle: await importerCleAesCtr(cleOuOctets), longueur: cleOuOctets.length };
  }
  return { cle: cleOuOctets, longueur: longueurEnOctets };
}

/**
 * E_K(bloc) par AES-CTR. La promesse de `crypto.subtle` est rendue TELLE QUELLE, sans enveloppe
 * `async` et sans `.then` : la revue de la PR #202 a mesuré que WebKit paie un tour de reprise —
 * de l'ordre du tic d'horloge de Windows, 15,4 ms — par promesse enveloppée, et que trente-neuf
 * enveloppes enchaînées faisaient à elles seules les 598 ms par secteur d'une première rédaction
 * de ce module. Le coût n'était ni celui d'AES ni celui de la lecture des octets : c'était celui
 * de l'écriture. L'appelant lit le résultat dans SA fonction asynchrone, qui existe déjà.
 */
function chiffrerUnBloc(cle, bloc) {
  compteurAppels.encrypt += 1;
  return crypto.subtle.encrypt({ name: "AES-CTR", counter: bloc, length: 32 }, cle, ZERO_BLOC);
}

/**
 * Le PLANCHER de la voie composée : les trente-neuf chiffrements de bloc, sans POLYVAL ni copie.
 *
 * Il existe pour que le verdict ne dépende pas de la qualité de la multiplication de `polyval.mjs`.
 * Ce qu'il mesure est la part qu'aucune implémentation de SIV composée sur WebCrypto ne peut
 * descendre EN NOMBRE D'APPELS — trente-neuf `encrypt` sur les quarante appels du scellement, le
 * quarantième étant l'`importKey` de la clé de message, qui n'est pas rejoué ici.
 *
 * @param {{cle: CryptoKey}} clePreparee
 * @param {number} nombre
 * @param {boolean} vagues émettre les appels indépendants ensemble plutôt qu'à la file
 */
export async function plancherDAppels(clePreparee, nombre, vagues = false) {
  const blocs = [];
  for (let indice = 0; indice < nombre; indice += 1) {
    const bloc = new Uint8Array(BLOC);
    bloc[0] = indice & 0xff;
    blocs.push(bloc);
  }
  if (vagues) {
    await Promise.all(blocs.map((bloc) => chiffrerUnBloc(clePreparee.cle, bloc)));
    return;
  }
  for (const bloc of blocs) await chiffrerUnBloc(clePreparee.cle, bloc);
}

function blocDeDerivation(indice, nonce) {
  const bloc = new Uint8Array(BLOC);
  new DataView(bloc.buffer).setUint32(0, indice, true);
  bloc.set(nonce, 4);
  return bloc;
}

/**
 * Émet une suite de chiffrements de bloc, à la file ou en une vague.
 *
 * Les blocs d'une même suite sont INDÉPENDANTS — les six blocs de dérivation, puis les blocs de
 * flot —, si bien que les émettre ensemble ne change pas un octet du résultat. Ce que cela change
 * est le nombre de tours d'attente : la revue de la PR #202 a mesuré un gain de × 2,47 sous Firefox
 * et × 13,0 sous WebKit, et de × 0,99 sous Chromium, où le coût est du calcul et non de l'attente.
 */
async function emettre(cle, blocs, vagues) {
  if (vagues) {
    const sorties = await Promise.all(blocs.map((bloc) => chiffrerUnBloc(cle, bloc)));
    return sorties.map((sortie) => new Uint8Array(sortie));
  }
  const sorties = [];
  for (const bloc of blocs) sorties.push(new Uint8Array(await chiffrerUnBloc(cle, bloc)));
  return sorties;
}

/**
 * Dérivation des clés par message (RFC 8452, § 4) : deux blocs pour la clé d'authentification,
 * quatre de plus pour une clé de chiffrement de 256 bits.
 */
async function deriverClesDeMessage(cleMaitresse, nonce, vagues) {
  const prete =
    cleMaitresse instanceof Uint8Array ? await preparerCleMaitresse(cleMaitresse) : cleMaitresse;
  const nombreDeBlocs = prete.longueur === 32 ? 6 : 4;
  const blocs = [];
  for (let indice = 0; indice < nombreDeBlocs; indice += 1)
    blocs.push(blocDeDerivation(indice, nonce));
  const chiffres = await emettre(prete.cle, blocs, vagues);
  const moities = chiffres.map((chiffre) => chiffre.subarray(0, 8));
  return {
    cleAuthentification: concatener(moities.slice(0, 2)),
    cleChiffrement: concatener(moities.slice(2)),
  };
}

/** Entrée de POLYVAL : données associées rembourrées, clair rembourré, puis les deux longueurs en bits. */
function entreeDePolyval(donneesAssociees, clair) {
  const remplir = (octets) => {
    const reste = octets.length % BLOC;
    if (reste === 0) return octets;
    const rembourre = new Uint8Array(octets.length + (BLOC - reste));
    rembourre.set(octets);
    return rembourre;
  };
  const longueurs = new Uint8Array(BLOC);
  const vue = new DataView(longueurs.buffer);
  vue.setBigUint64(0, BigInt(donneesAssociees.length) * 8n, true);
  vue.setBigUint64(8, BigInt(clair.length) * 8n, true);
  return concatener([remplir(donneesAssociees), remplir(clair), longueurs]);
}

/** Le flot de clé : le compteur initial est l'étiquette, bit de poids fort du dernier octet à 1. */
async function flotDeCle(cleChiffrementAes, etiquette, longueur, vagues) {
  const initial = Uint8Array.from(etiquette);
  initial[15] |= 0x80;
  const depart = new DataView(initial.buffer).getUint32(0, true);
  const nombre = Math.ceil(longueur / BLOC);
  const blocs = [];
  for (let indice = 0; indice < nombre; indice += 1) {
    const compteur = Uint8Array.from(initial);
    new DataView(compteur.buffer).setUint32(0, (depart + indice) >>> 0, true);
    blocs.push(compteur);
  }
  const sorties = await emettre(cleChiffrementAes, blocs, vagues);
  return concatener(sorties).subarray(0, longueur);
}

function ouExclusif(gauche, droite) {
  const sortie = new Uint8Array(gauche.length);
  for (let i = 0; i < gauche.length; i += 1) sortie[i] = gauche[i] ^ droite[i];
  return sortie;
}

/**
 * Scelle un clair sous AES-GCM-SIV. Rend `chiffré ‖ étiquette`, comme la RFC.
 *
 * @param {Uint8Array|{cle: CryptoKey, longueur: number}} cleMaitresse octets bruts, ou clé préparée
 * @param {Uint8Array} nonce 12 octets
 * @param {Uint8Array} clair
 * @param {Uint8Array} donneesAssociees
 * @param {{vagues?: boolean}} options
 */
export async function sceller(
  cleMaitresse,
  nonce,
  clair,
  donneesAssociees = new Uint8Array(0),
  { vagues = false } = {},
) {
  const { cleAuthentification, cleChiffrement } = await deriverClesDeMessage(
    cleMaitresse,
    nonce,
    vagues,
  );
  const somme = polyval(cleAuthentification, entreeDePolyval(donneesAssociees, clair));
  for (let i = 0; i < 12; i += 1) somme[i] ^= nonce[i];
  somme[15] &= 0x7f;

  const cleChiffrementAes = await importerCleAesCtr(cleChiffrement);
  const etiquette = new Uint8Array(await chiffrerUnBloc(cleChiffrementAes, somme));
  const flot = await flotDeCle(cleChiffrementAes, etiquette, clair.length, vagues);
  return concatener([ouExclusif(clair, flot), etiquette]);
}

/**
 * Ouvre un scellement AES-GCM-SIV. Lève si l'étiquette recalculée diffère — la comparaison n'est pas
 * à temps constant, et ce module n'a pas à l'être : il mesure, il ne protège rien.
 */
export async function ouvrir(
  cleMaitresse,
  nonce,
  scelle,
  donneesAssociees = new Uint8Array(0),
  { vagues = false } = {},
) {
  if (scelle.length < BLOC) throw new Error("AES-GCM-SIV : scellement plus court qu'une étiquette");
  const chiffre = scelle.subarray(0, scelle.length - BLOC);
  const etiquette = scelle.subarray(scelle.length - BLOC);

  const { cleAuthentification, cleChiffrement } = await deriverClesDeMessage(
    cleMaitresse,
    nonce,
    vagues,
  );
  const cleChiffrementAes = await importerCleAesCtr(cleChiffrement);
  const flot = await flotDeCle(cleChiffrementAes, etiquette, chiffre.length, vagues);
  const clair = ouExclusif(chiffre, flot);

  const somme = polyval(cleAuthentification, entreeDePolyval(donneesAssociees, clair));
  for (let i = 0; i < 12; i += 1) somme[i] ^= nonce[i];
  somme[15] &= 0x7f;
  const attendue = new Uint8Array(await chiffrerUnBloc(cleChiffrementAes, somme));

  let ecart = 0;
  for (let i = 0; i < BLOC; i += 1) ecart |= attendue[i] ^ etiquette[i];
  if (ecart !== 0) throw new Error("AES-GCM-SIV : étiquette invalide");
  return clair;
}
