// Scénario d'écriture éprouvé par les coupures de #15.
//
// Un seul module, employé des DEUX côtés de la preuve : par la machine jetable de `crash-machine.mjs`
// sous Node, et par le Worker runtime sur un volume OPFS réel dans Chromium. Si les deux côtés
// écrivaient leur propre suite de blocs, une différence de verdict ne dirait pas si elle vient du
// support ou du scénario.
//
// La suite est délibérément simple et entièrement dérivée : une suite de blocs alignés au secteur,
// dont l'ANCIEN et le NOUVEAU contenu sont deux motifs déterministes de `block-fixture.mjs`. Les
// deux graines de motif sont choisies pour que les blocs diffèrent OCTET PAR OCTET — l'oracle
// classe alors sans zone d'ombre, et une épreuve unitaire le vérifie plutôt que de le supposer.

import { SECTOR_SIZE } from "./block-geometry.mjs";
import { buildPattern } from "./block-fixture.mjs";

/** Un bloc suivi vaut un secteur : la plus petite unité que le matériel émulé sait adresser. */
export const BLOC_OCTETS = SECTOR_SIZE;

/** Nombre de blocs suivis, donc d'écritures du scénario. */
export const BLOCS_SUIVIS = 24;

/** Une barrière tous les huit blocs : le scénario en émet donc trois. */
export const BARRIERE_TOUS_LES = 8;

/** Taille du volume de résilience. Jetable, et sans rapport avec un volume de produit. */
export const VOLUME_OCTETS = 32 * BLOC_OCTETS;

/**
 * Graines des deux motifs. `buildPattern` rend `(i * 31 + graine * 97 + 11) % 256` : deux graines
 * qui diffèrent de 1000 décalent CHAQUE octet de `97 000 mod 256 = 232`, donc d'une valeur non
 * nulle. Aucun octet ne coïncide entre l'ancien et le nouveau contenu d'un même bloc.
 */
const GRAINE_ANCIEN = 1000;
const GRAINE_NOUVEAU = 2000;

/** Offset du bloc suivi de rang `index`. */
export function offsetDuBloc(index) {
  return index * BLOC_OCTETS;
}

/** Ancien contenu du bloc `index` : ce que la relecture doit rendre si la coupure a tout annulé. */
export function contenuAncien(index) {
  return buildPattern(BLOC_OCTETS, GRAINE_ANCIEN + index);
}

/** Nouveau contenu du bloc `index` : ce que la relecture doit rendre si tout a abouti. */
export function contenuNouveau(index) {
  return buildPattern(BLOC_OCTETS, GRAINE_NOUVEAU + index);
}

/** Profil que ce scénario émet réellement, à donner à `planifierCoupures`. */
export function profilDuScenario(points) {
  return Object.freeze({
    points,
    lectures: 0,
    ecritures: BLOCS_SUIVIS,
    barrieres: Math.ceil(BLOCS_SUIVIS / BARRIERE_TOUS_LES),
    tailleBloc: BLOC_OCTETS,
  });
}

/**
 * Écrit un état complet, bloc par bloc, avec une barrière tous les `BARRIERE_TOUS_LES` blocs.
 *
 * L'écriture s'arrête à la PREMIÈRE erreur typée du stockage — c'est la coupure — et l'erreur est
 * rapportée, jamais avalée. Toute autre erreur remonte : une panne de programmation ne doit pas se
 * déguiser en point de coupure.
 *
 * @param {object} backend backend de blocs ouvert
 * @param {(index: number) => Uint8Array} contenu
 * @returns {Promise<{ ecritures: number, barrieres: number,
 *                     arret: { code: string, message: string } | null }>}
 */
export async function ecrireEtat(backend, contenu) {
  let ecritures = 0;
  let barrieres = 0;
  try {
    for (let index = 0; index < BLOCS_SUIVIS; index += 1) {
      await backend.write(offsetDuBloc(index), contenu(index));
      ecritures += 1;
      if ((index + 1) % BARRIERE_TOUS_LES === 0) {
        await backend.flush();
        barrieres += 1;
      }
    }
  } catch (erreur) {
    if (typeof erreur.code !== "string" || !erreur.code.startsWith("VAULT_STORAGE_")) throw erreur;
    return { ecritures, barrieres, arret: { code: erreur.code, message: erreur.message } };
  }
  return { ecritures, barrieres, arret: null };
}

/** Écrit l'ancien état. Employé pour préparer le volume avant la coupure. */
export function ecrireEtatAncien(backend) {
  return ecrireEtat(backend, contenuAncien);
}

/** Écrit le nouvel état. C'est l'écriture que la coupure interrompt. */
export function ecrireEtatNouveau(backend) {
  return ecrireEtat(backend, contenuNouveau);
}

/**
 * Relit les blocs suivis. Rendue séparément des contenus attendus : sur le chemin navigateur, la
 * relecture traverse un `postMessage`, et un `Uint8Array` le traverse là où une fonction ne le
 * ferait pas.
 * @returns {Promise<Array<{ index: number, offset: number, observe: Uint8Array }>>}
 */
export async function relireBlocs(backend) {
  const blocs = [];
  for (let index = 0; index < BLOCS_SUIVIS; index += 1) {
    const offset = offsetDuBloc(index);
    blocs.push({ index, offset, observe: await backend.read(offset, BLOC_OCTETS) });
  }
  return blocs;
}

/**
 * Complète une relecture avec les deux contenus attendus, forme d'entrée de `classerVolume`.
 * @param {Array<{ index: number, offset: number, observe: Uint8Array }>} relecture
 */
export function blocsAttendus(relecture) {
  return relecture.map(({ index, offset, observe }) => ({
    index,
    offset,
    ancien: contenuAncien(index),
    nouveau: contenuNouveau(index),
    observe: observe instanceof Uint8Array ? observe : new Uint8Array(observe),
  }));
}
