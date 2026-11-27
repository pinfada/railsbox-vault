// Les trois GARDES de la source ajoutées par #342, jouées ensemble avant le premier `docker build`.
//
//  1. les liens symboliques (`liens-de-la-source.mjs`) — en PREMIER : les deux autres gardes lisent
//     des fichiers, et lire un lien, c'est lire sa cible. Un lien n'est donc jamais lu ;
//  2. le Ruby demandé (`ruby-demande.mjs`), confronté au Ruby du guest que donne `sources.json` ;
//  3. les secrets dans le contenu (`secrets-du-contenu.mjs`), sur les fichiers texte retenus.
//
// Elles portent sur la liste UNIQUE des fichiers qui entreront dans le paquet
// (`exclusions-de-la-source.mjs`) : ce qui n'entre pas n'est pas examiné, et ce qui entre l'est.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { liensSymboliques } from "./liens-de-la-source.mjs";
import { confronterLeRubyDemande } from "./ruby-demande.mjs";
import { estDuTexte, secretsDuContenu } from "./secrets-du-contenu.mjs";

/**
 * Toutes les anomalies des trois gardes, dans l'ordre liens, Ruby, secrets.
 *
 * @param {{ source: string, fichiers: readonly string[], vaultApp: Record<string, any> | null,
 *           rubyDuGuest: string }} entree
 * @returns {import("./rapport-de-refus.mjs").AnomalieDeLaSource[]}
 */
export function gardesDeLaSource({ source, fichiers, vaultApp, rubyDuGuest }) {
  const liens = liensSymboliques(source, fichiers);
  const sontDesLiens = new Set(liens.map(({ fichier }) => fichier));
  const lisibles = fichiers.filter((relatif) => !sontDesLiens.has(relatif));
  const lire = (relatif) => readFileSync(join(source, relatif), "utf8");

  const ruby = lisibles.includes("Gemfile")
    ? confronterLeRubyDemande({ gemfile: lire("Gemfile"), fichiers: lisibles, lire, rubyDuGuest })
    : [];

  const assumesPublics = vaultApp?.secretsAssumesPublics ?? [];
  const secrets = lisibles.flatMap((relatif) => {
    const octets = readFileSync(join(source, relatif));
    if (!estDuTexte(octets)) return [];
    return secretsDuContenu({ chemin: relatif, contenu: octets.toString("utf8"), assumesPublics });
  });

  return [...liens, ...ruby, ...secrets];
}
