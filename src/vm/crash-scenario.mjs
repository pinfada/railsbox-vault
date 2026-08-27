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

/**
 * Nombre de blocs SUIVIS, c'est-à-dire jugés par l'oracle. Vingt-quatre blocs DISTINCTS, comme #15.
 *
 * ### Pourquoi pas huit blocs réécrits trois fois
 *
 * Cette tranche a d'abord essayé une cadence où huit blocs étaient réécrits trois fois avec le MÊME
 * contenu, pour que toute génération validée soit l'un des deux états que l'oracle de #15 savait
 * juger. La revue l'a réfutée PAR MUTATION, et le contre-exemple est conservé ici parce qu'il vaut
 * mieux qu'une justification : avec un contenu identique d'une passe à l'autre, les générations 2 et
 * 3 ne publient RIEN de nouveau. Un magasin muté qui les acquitte au guest puis les perd à la
 * réouverture laisse donc exactement le même volume qu'un magasin correct — et la matrice restait à
 * 100 % sur les trois graines. La preuve était creuse.
 *
 * Le remède n'est pas de fabriquer un scénario que l'oracle sait juger, mais d'apprendre à l'oracle à
 * juger le scénario. `classerVolume` reçoit désormais la SUITE DES GÉNÉRATIONS attendues — voir
 * `generationsAttendues` — et refuse tout état qui n'en est pas exactement une. Il est ainsi
 * strictement PLUS discriminant qu'en #15, et la mutation ci-dessus le fait rougir
 * (`tests/unit/vm-crash-mutation.test.mjs`).
 */
export const BLOCS_SUIVIS = 24;

/** Une seule passe : chaque bloc suivi est écrit une fois, avec un contenu qui lui est propre. */
export const PASSES = 1;

/** Écritures émises par le scénario : c'est ce chiffre qui borne les points de coupure. */
export const ECRITURES = BLOCS_SUIVIS * PASSES;

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

/** Nombre de barrières émises par le scénario. */
export const BARRIERES = Math.ceil(ECRITURES / BARRIERE_TOUS_LES);

/**
 * Suite des états qu'une génération VALIDÉE de ce scénario doit avoir publiés, du plus vide au plus
 * complet : `[[], [0..7], [0..15], [0..23]]`.
 *
 * Elle est dérivée du SCÉNARIO — quels blocs chaque écriture touche, où tombent les barrières — et
 * de rien d'autre. Elle ne demande jamais au mécanisme ce qu'il a fait : c'est la liste de ce qu'il
 * DEVAIT faire, et l'oracle refuse tout état qui n'en est pas exactement un membre.
 */
export function generationsAttendues() {
  const suite = [[]];
  for (let barriere = 1; barriere <= BARRIERES; barriere += 1) {
    const jusque = Math.min(barriere * BARRIERE_TOUS_LES, ECRITURES);
    suite.push(Array.from({ length: jusque }, (_, rang) => rang % BLOCS_SUIVIS));
  }
  return Object.freeze(suite.map((etat) => Object.freeze([...new Set(etat)])));
}

/**
 * Profil que ce scénario émet réellement, à donner à `planifierCoupures`.
 *
 * Ces quatre nombres — et eux seuls — décident de la matrice de coupures. Ils sont INCHANGÉS depuis
 * #15 : vingt-quatre écritures, trois barrières, des blocs de 512 octets. C'est ce qui permet de
 * comparer le relevé de #16 à celui de #15 point pour point.
 */
export function profilDuScenario(points) {
  return Object.freeze({
    points,
    lectures: 0,
    ecritures: ECRITURES,
    barrieres: BARRIERES,
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
    for (let rang = 0; rang < ECRITURES; rang += 1) {
      // Chaque passe réécrit les MÊMES blocs avec le MÊME contenu : une génération validée porte
      // donc toujours l'état complet, et non un tiers de celui-ci. Voir `BLOCS_SUIVIS`.
      const index = rang % BLOCS_SUIVIS;
      await backend.write(offsetDuBloc(index), contenu(index));
      ecritures += 1;
      if ((rang + 1) % BARRIERE_TOUS_LES === 0) {
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
