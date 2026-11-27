// Les LIMITES d'un hébergeur, contrôlées sur l'arbre publié AVANT tout envoi (#45, ADR 0017).
//
// Une limite d'hébergeur ne se découvre pas à l'envoi : un fichier de plus de 25 Mio fait échouer
// `wrangler pages deploy` APRÈS la construction, la vérification et l'approbation humaine. Ce module
// les rend mesurables hors de tout compte, par PROFIL : l'hébergeur n'est pas choisi par ce dépôt
// (décision du mainteneur), seules ses limites publiées le sont.
//
// Un dépassement est un REFUS (code de sortie dédié de `tools/publier.mjs`) ; un AVERTISSEMENT ne
// l'est jamais. Les valeurs sont celles de la documentation de l'hébergeur au 26/11/2026 ; elles sont
// à revérifier le jour du choix (`docs/release-policy.md`).

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { FICHIER_HEADERS } from "./publier-en-tetes.mjs";
import { relever } from "./publier-inventaire.mjs";

const MIO = 1024 * 1024;

/**
 * @typedef {{ octetsParFichier: number | null, avertirAuDela: number | null, fichiers: number | null,
 *             reglesHeaders: number | null, longueurLigneHeaders: number | null, source: string }} Profil
 * @type {Readonly<Record<string, Readonly<Profil>>>}
 */
export const PROFILS = Object.freeze({
  "cloudflare-pages": Object.freeze({
    octetsParFichier: 25 * MIO,
    avertirAuDela: null,
    fichiers: 20_000,
    reglesHeaders: 100,
    longueurLigneHeaders: 2000,
    source: "https://developers.cloudflare.com/pages/platform/limits",
  }),
  // Aucune limite par fichier PUBLIÉE : seul un avertissement au-delà de 10 Mio (forum Netlify, une
  // parole d'employé, pas une garantie).
  netlify: Object.freeze({
    octetsParFichier: null,
    avertirAuDela: 10 * MIO,
    fichiers: null,
    reglesHeaders: null,
    longueurLigneHeaders: null,
    source: "https://answers.netlify.com/t/what-is-the-maximum-allowed-object-size/145182",
  }),
});

/** Le profil nommé, ou une erreur d'usage qui liste les profils connus. */
export function profilNomme(nom) {
  const profil = PROFILS[nom];
  if (profil === undefined) {
    throw new Error(
      `Profil d'hébergeur inconnu : « ${nom} ». Profils : ${Object.keys(PROFILS).join(", ")}.`,
    );
  }
  return profil;
}

/**
 * Les RÈGLES d'un `_headers` : une par ligne de motif, c'est-à-dire non indentée, hors commentaire.
 * Les lignes indentées sont les en-têtes d'une règle, et ne comptent pas.
 *
 * @param {string} texte
 */
export function reglesDuFichierHeaders(texte) {
  return texte
    .split("\n")
    .filter((ligne) => ligne.trim() !== "" && !ligne.startsWith("#") && !/^\s/.test(ligne));
}

/**
 * Mesure un arbre publié contre un profil. Pur sur ses entrées : `fichiers` est le relevé
 * `{ chemin, octets }` et `headers` le texte du `_headers`.
 *
 * @param {{ fichiers: readonly { chemin: string, octets: number }[], headers: string | null,
 *           profil: Readonly<Profil> }} entree
 */
export function mesurerLesLimites({ fichiers, headers, profil }) {
  const depassements = [];
  const avertissements = [];
  const total = fichiers.reduce((somme, { octets }) => somme + octets, 0);

  if (profil.octetsParFichier !== null) {
    for (const { chemin, octets } of fichiers) {
      if (octets > profil.octetsParFichier) {
        depassements.push({
          regle: "octets-par-fichier",
          chemin,
          mesure: octets,
          limite: profil.octetsParFichier,
        });
      }
    }
  }
  if (profil.avertirAuDela !== null) {
    for (const { chemin, octets } of fichiers) {
      if (octets > profil.avertirAuDela) {
        avertissements.push({
          regle: "octets-par-fichier",
          chemin,
          mesure: octets,
          limite: profil.avertirAuDela,
        });
      }
    }
  }
  if (profil.fichiers !== null && fichiers.length > profil.fichiers) {
    depassements.push({
      regle: "nombre-de-fichiers",
      chemin: null,
      mesure: fichiers.length,
      limite: profil.fichiers,
    });
  }
  if (headers !== null) {
    const regles = reglesDuFichierHeaders(headers);
    if (profil.reglesHeaders !== null && regles.length > profil.reglesHeaders) {
      depassements.push({
        regle: "regles-headers",
        chemin: FICHIER_HEADERS,
        mesure: regles.length,
        limite: profil.reglesHeaders,
      });
    }
    if (profil.longueurLigneHeaders !== null) {
      for (const ligne of headers.split("\n")) {
        if (ligne.length > profil.longueurLigneHeaders) {
          depassements.push({
            regle: "longueur-ligne-headers",
            chemin: FICHIER_HEADERS,
            mesure: ligne.length,
            limite: profil.longueurLigneHeaders,
          });
        }
      }
    }
  }
  return { depassements, avertissements, fichiers: fichiers.length, octets: total };
}

/** Relève un arbre publié sur le disque et le mesure. */
export async function controlerLesLimites(racine, profil) {
  const fichiers = await relever(racine, []);
  const headers = await readFile(join(racine, FICHIER_HEADERS), "utf8").catch(() => null);
  return mesurerLesLimites({ fichiers, headers, profil });
}

const fmtMio = (octets) => `${(octets / MIO).toFixed(1)} Mio`;

/** Le rapport lisible, un dépassement ou avertissement par ligne, fichier nommé. */
export function decrireLesLimites(nomProfil, arbre, resultat) {
  const unite = (e) =>
    e.regle === "octets-par-fichier"
      ? `${fmtMio(e.mesure)} > ${fmtMio(e.limite)}`
      : `${e.mesure} > ${e.limite}`;
  const lignes = [
    `Limites « ${nomProfil} » — arbre « ${arbre} » : ${resultat.fichiers} fichiers, ${fmtMio(resultat.octets)}`,
  ];
  for (const e of resultat.depassements) {
    lignes.push(`  DÉPASSEMENT  ${e.regle}  ${e.chemin ?? "(arbre)"}  ${unite(e)}`);
  }
  for (const e of resultat.avertissements) {
    lignes.push(`  avertissement  ${e.regle}  ${e.chemin}  ${unite(e)}`);
  }
  if (resultat.depassements.length === 0) lignes.push("  aucun dépassement");
  return lignes.join("\n");
}
