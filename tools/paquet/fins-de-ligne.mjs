// Les FINS DE LIGNE d'une application, normalisées dans l'arbre du paquet (#351).
//
// Un dépôt cloné sous Windows avec `core.autocrlf=true` porte des CRLF dans TOUS ses fichiers texte.
// Le guest est un Linux : le noyau lit le shebang de `bin/rails` jusqu'au saut de ligne, et
// `/usr/bin/env: 'ruby\r': No such file` arrête l'application avant Rails. L'essai réel du
// 28/11/2026 s'y est arrêté.
//
// RailsBox (`tools/build-v86-image/base/app.Dockerfile`, même propriétaire, MIT) ne retire le CR que
// de la PREMIÈRE ligne d'un fichier à shebang. C'est le cas qui casse à coup sûr, mais un script
// sourcé, un YAML lu par une gemme stricte ou un gabarit qui compare des lignes peuvent casser aussi.
// Ici, TOUT fichier texte passe en LF, et ce geste ne vise que la COPIE : la source n'est jamais
// touchée.
//
// Un fichier est du TEXTE s'il ne porte aucun octet nul dans ses 8 premiers Kio : le critère de git
// lui-même, et celui de `secrets-du-contenu.mjs`. Un binaire (PNG, police, base SQLite) n'est jamais
// touché : ses octets 0x0D 0x0A sont des données. Un CR ISOLÉ n'est pas une fin de ligne : il reste.

import { estDuTexte } from "./secrets-du-contenu.mjs";

const CR = 0x0d;
const LF = 0x0a;
const CRLF = Buffer.from([CR, LF]);

/**
 * Rend les octets avec leurs CRLF remplacés par LF, et dit s'il y en avait.
 *
 * @param {Buffer} octets
 * @returns {{ octets: Buffer, normalise: boolean }}
 */
export function finsDeLigneNormalisees(octets) {
  if (!estDuTexte(octets) || !octets.includes(CRLF)) return { octets, normalise: false };
  const sortie = Buffer.allocUnsafe(octets.length);
  let longueur = 0;
  for (let rang = 0; rang < octets.length; rang += 1) {
    if (octets[rang] === CR && octets[rang + 1] === LF) continue;
    sortie[longueur] = octets[rang];
    longueur += 1;
  }
  return { octets: sortie.subarray(0, longueur), normalise: true };
}
