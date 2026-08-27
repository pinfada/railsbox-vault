// En-têtes de réponse servis par la PRODUCTION, pour chacune des deux origines de l'ADR 0002.
//
// La règle qui gouverne ce module tient en une phrase : **`tools/serve-headers.mjs` est la source
// de vérité**. Les épreuves de frontière du dépôt — `tests/browser/csp-frontiere.spec.mjs`, les
// sondes du spike #35 — mesurent ce que CE module-là sert. Une production qui servirait autre chose
// rendrait ces épreuves muettes sur ce qui est réellement publié. Ici, on n'écrit donc AUCUNE
// politique à la main : on appelle `securityHeaders()` et on rend ce qu'elle rend.
//
// Une seule addition, et elle est décidée par l'ADR 0017, pas par ce fichier :
// `Cross-Origin-Opener-Policy: same-origin` sur l'origine de confiance. L'ADR 0010 l'a RECOMMANDÉE
// en la différant explicitement vers #45, en notant que `tools/serve.mjs` « ne sert jamais COOP
// autrement qu'accompagné de COEP » et que « savoir servir COOP seul est un travail de #45 ». C'est
// ce travail. Il se fait ici, dans la couche de publication, sans toucher au serveur de test — dont
// les mesures existantes ne doivent pas changer de sens sous nos pieds.
//
// COEP reste absent : l'ADR 0010 l'écarte sur mesure, et rien dans #45 ne rouvre cette question.

import { securityHeaders } from "./serve-headers.mjs";

/** Origines de démonstration. L'ADR 0002 les emploie déjà dans sa cartographie des canaux. */
export const ORIGINE_COQUILLE_PAR_DEFAUT = "https://vault.exemple";
export const ORIGINE_APPLICATION_PAR_DEFAUT = "https://app.vault.exemple";

/** Rôles de `tools/serve-headers.mjs`, nommés du point de vue de la publication. */
export const ORIGINES = Object.freeze({
  coquille: "shell",
  application: "app",
});

/**
 * En-tête que la publication AJOUTE à ce que sert le serveur de test, et sa justification.
 *
 * Il n'est posé que sur l'origine de confiance. Sur l'origine applicative il serait sans effet — un
 * document encadré n'est pas un contexte de navigation de plus haut niveau (ADR 0010) — et il
 * violerait la règle de l'ADR 0002 selon laquelle la coquille n'impose rien au territoire
 * applicatif.
 */
export const EN_TETE_AJOUTE_PAR_LA_PUBLICATION = Object.freeze({
  nom: "Cross-Origin-Opener-Policy",
  valeur: "same-origin",
  origine: "coquille",
  decidePar: "ADR 0017, sur la recommandation différée de l'ADR 0010",
});

/**
 * Chemin représentatif d'un arbre, pour interroger `securityHeaders()`.
 *
 * Le rôle `shell` sert sa CSP à tout ce qui n'est ni territoire applicatif (`/spike/origin/app…`)
 * ni sonde de capacités (`/compat…`) — deux préfixes que la publication EXCLUT par ailleurs
 * (`tools/publier-arborescences.mjs`). Interroger la racine rend donc la politique servie à
 * l'intégralité de l'arbre publié, ce que `enTetesUniformes` vérifie au lieu de le supposer.
 */
const CHEMIN_REPRESENTATIF = "/index.html";

/**
 * En-têtes servis à TOUT l'arbre d'une origine.
 *
 * @param {"coquille" | "application"} arbre
 * @param {{ origineApplication?: string }} [options]
 * @returns {Record<string, string>}
 */
export function enTetesDePublication(arbre, { origineApplication } = {}) {
  const role = ORIGINES[arbre];
  if (role === undefined) {
    throw new Error(
      `Arbre inconnu : ${arbre}. Valeurs admises : ${Object.keys(ORIGINES).join(", ")}.`,
    );
  }

  const enTetes = securityHeaders({
    role,
    pathname: CHEMIN_REPRESENTATIF,
    isolation: null,
    appOrigin: origineApplication ?? ORIGINE_APPLICATION_PAR_DEFAUT,
  });

  if (arbre === EN_TETE_AJOUTE_PAR_LA_PUBLICATION.origine) {
    enTetes[EN_TETE_AJOUTE_PAR_LA_PUBLICATION.nom] = EN_TETE_AJOUTE_PAR_LA_PUBLICATION.valeur;
  }

  return enTetes;
}

/**
 * Vérifie que la politique interrogée à la racine vaut pour CHAQUE fichier de l'arbre.
 *
 * `securityHeaders()` dépend du chemin : elle retire la CSP au territoire applicatif et à la sonde
 * de capacités. Si un arbre publié contenait un chemin relevant de l'une de ces exemptions, le
 * fichier `_headers` mentirait — il annoncerait une politique uniforme là où le serveur de test en
 * sert deux. Plutôt que de faire confiance aux exclusions, on remesure.
 *
 * @param {"coquille" | "application"} arbre
 * @param {readonly string[]} chemins chemins relatifs de l'arbre publié
 * @param {{ origineApplication?: string }} [options]
 * @returns {readonly string[]} les chemins dont la politique diffère de celle de la racine
 */
export function cheminsHorsPolitiqueUniforme(arbre, chemins, options = {}) {
  const reference = JSON.stringify(enTetesDePublication(arbre, options));
  const role = ORIGINES[arbre];
  return chemins.filter((chemin) => {
    const mesure = securityHeaders({
      role,
      pathname: `/${chemin}`,
      isolation: null,
      appOrigin: options.origineApplication ?? ORIGINE_APPLICATION_PAR_DEFAUT,
    });
    if (arbre === EN_TETE_AJOUTE_PAR_LA_PUBLICATION.origine) {
      mesure[EN_TETE_AJOUTE_PAR_LA_PUBLICATION.nom] = EN_TETE_AJOUTE_PAR_LA_PUBLICATION.valeur;
    }
    return JSON.stringify(mesure) !== reference;
  });
}

/**
 * Rend le fichier `_headers` que lisent Cloudflare Pages et Netlify.
 *
 * Le format est le même chez les deux : une ligne de motif, puis les en-têtes indentés. Ce n'est
 * pas un standard, c'est une convention partagée — le spike #45 la relève comme telle, et l'ADR
 * 0017 dit ce qu'il faudrait produire à la place pour un reverse proxy.
 *
 * @param {"coquille" | "application"} arbre
 * @param {{ origineApplication?: string }} [options]
 */
export function rendreFichierHeaders(arbre, options = {}) {
  const enTetes = enTetesDePublication(arbre, options);
  const lignes = [
    `# RailsBox Vault — origine « ${arbre} » (ADR 0002, ADR 0017).`,
    "# Généré par `node tools/publier.mjs` depuis `tools/serve-headers.mjs`. Ne pas éditer à la main.",
    "/*",
    ...Object.entries(enTetes).map(([nom, valeur]) => `  ${nom}: ${valeur}`),
  ];
  return `${lignes.join("\n")}\n`;
}

/** Nom du fichier d'en-têtes dans un arbre publié. */
export const FICHIER_HEADERS = "_headers";
