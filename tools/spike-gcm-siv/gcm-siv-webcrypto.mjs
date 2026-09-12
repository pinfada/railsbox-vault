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
 */
export async function preparerCleMaitresse(cleBrute) {
  const cle = await importerCleAesCtr(cleBrute);
  return { cle, longueur: cleBrute.length };
}

/**
 * E_K(bloc) par AES-CTR : un bloc de clair nul sous ce compteur rend exactement le flot, donc le
 * chiffré du bloc de compteur. La longueur de compteur est sans effet — un seul bloc, aucune
 * incrémentation.
 */
async function chiffrerUnBloc(cle, bloc) {
  compteurAppels.encrypt += 1;
  const sortie = await crypto.subtle.encrypt(
    { name: "AES-CTR", counter: bloc, length: 32 },
    cle,
    ZERO_BLOC,
  );
  return new Uint8Array(sortie);
}

/**
 * Le PLANCHER de la voie sans dépendance : N chiffrements d'un bloc isolé, sans POLYVAL ni copie.
 *
 * Il existe pour que le verdict ne dépende pas de la qualité de la multiplication de `polyval.mjs`,
 * qui est écrite pour être relue et non pour être rapide. Ce que cette série mesure est la part
 * qu'AUCUNE implémentation de SIV composée sur WebCrypto ne peut descendre : le coût fixe d'un
 * appel à `crypto.subtle`, multiplié par le nombre de blocs que les deux suites de compteurs
 * d'AES-GCM-SIV imposent.
 */
export async function plancherDAppels(clePreparee, nombre) {
  const bloc = new Uint8Array(BLOC);
  for (let indice = 0; indice < nombre; indice += 1) {
    bloc[0] = indice & 0xff;
    await chiffrerUnBloc(clePreparee.cle, bloc);
  }
}

function blocDeDerivation(indice, nonce) {
  const bloc = new Uint8Array(BLOC);
  new DataView(bloc.buffer).setUint32(0, indice, true);
  bloc.set(nonce, 4);
  return bloc;
}

/**
 * Dérivation des clés par message (RFC 8452, § 4) : deux blocs pour la clé d'authentification,
 * quatre de plus pour une clé de chiffrement de 256 bits.
 */
async function deriverClesDeMessage(cleMaitresse, nonce) {
  const prete =
    cleMaitresse instanceof Uint8Array ? await preparerCleMaitresse(cleMaitresse) : cleMaitresse;
  const cleAes = prete.cle;
  const nombreDeBlocs = prete.longueur === 32 ? 6 : 4;
  const moities = [];
  for (let indice = 0; indice < nombreDeBlocs; indice += 1) {
    const chiffre = await chiffrerUnBloc(cleAes, blocDeDerivation(indice, nonce));
    moities.push(chiffre.subarray(0, 8));
  }
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
async function flotDeCle(cleChiffrementAes, etiquette, longueur) {
  const compteur = Uint8Array.from(etiquette);
  compteur[15] |= 0x80;
  const vue = new DataView(compteur.buffer);
  const depart = vue.getUint32(0, true);
  const blocs = [];
  const nombre = Math.ceil(longueur / BLOC);
  for (let indice = 0; indice < nombre; indice += 1) {
    vue.setUint32(0, (depart + indice) >>> 0, true);
    blocs.push(await chiffrerUnBloc(cleChiffrementAes, compteur));
  }
  return concatener(blocs).subarray(0, longueur);
}

function ouExclusif(gauche, droite) {
  const sortie = new Uint8Array(gauche.length);
  for (let i = 0; i < gauche.length; i += 1) sortie[i] = gauche[i] ^ droite[i];
  return sortie;
}

/**
 * Scelle un clair sous AES-GCM-SIV. Rend `chiffré ‖ étiquette`, comme la RFC.
 *
 * @param {Uint8Array|{cle: CryptoKey, longueur: number}} cleMaitresse octets bruts, ou clé déjà préparée
 * @param {Uint8Array} nonce 12 octets
 * @param {Uint8Array} clair
 * @param {Uint8Array} donneesAssociees
 */
export async function sceller(cleMaitresse, nonce, clair, donneesAssociees = new Uint8Array(0)) {
  const { cleAuthentification, cleChiffrement } = await deriverClesDeMessage(cleMaitresse, nonce);
  const somme = polyval(cleAuthentification, entreeDePolyval(donneesAssociees, clair));
  for (let i = 0; i < 12; i += 1) somme[i] ^= nonce[i];
  somme[15] &= 0x7f;

  const cleChiffrementAes = await importerCleAesCtr(cleChiffrement);
  const etiquette = await chiffrerUnBloc(cleChiffrementAes, somme);
  const flot = await flotDeCle(cleChiffrementAes, etiquette, clair.length);
  return concatener([ouExclusif(clair, flot), etiquette]);
}

/**
 * Ouvre un scellement AES-GCM-SIV. Lève si l'étiquette recalculée diffère — la comparaison n'est pas
 * à temps constant, et ce module n'a pas à l'être : il mesure, il ne protège rien.
 */
export async function ouvrir(cleMaitresse, nonce, scelle, donneesAssociees = new Uint8Array(0)) {
  if (scelle.length < BLOC) throw new Error("AES-GCM-SIV : scellement plus court qu'une étiquette");
  const chiffre = scelle.subarray(0, scelle.length - BLOC);
  const etiquette = scelle.subarray(scelle.length - BLOC);

  const { cleAuthentification, cleChiffrement } = await deriverClesDeMessage(cleMaitresse, nonce);
  const cleChiffrementAes = await importerCleAesCtr(cleChiffrement);
  const flot = await flotDeCle(cleChiffrementAes, etiquette, chiffre.length);
  const clair = ouExclusif(chiffre, flot);

  const somme = polyval(cleAuthentification, entreeDePolyval(donneesAssociees, clair));
  for (let i = 0; i < 12; i += 1) somme[i] ^= nonce[i];
  somme[15] &= 0x7f;
  const attendue = await chiffrerUnBloc(cleChiffrementAes, somme);

  let ecart = 0;
  for (let i = 0; i < BLOC; i += 1) ecart |= attendue[i] ^ etiquette[i];
  if (ecart !== 0) throw new Error("AES-GCM-SIV : étiquette invalide");
  return clair;
}
