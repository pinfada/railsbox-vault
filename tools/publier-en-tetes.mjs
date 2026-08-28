// En-têtes de réponse servis par la PRODUCTION, pour chacune des deux origines de l'ADR 0002.
//
// La règle qui gouverne ce module tient en une phrase : **`tools/serve-headers.mjs` est la source
// de vérité**. Les épreuves de frontière du dépôt — `tests/browser/csp-frontiere.spec.mjs`, les
// sondes du spike #35 — mesurent ce que CE module-là sert. Une production qui servirait autre chose
// rendrait ces épreuves muettes sur ce qui est réellement publié. Ici, on n'écrit donc AUCUNE
// politique de la coquille à la main : on appelle `securityHeaders()` et on rend ce qu'elle rend.
//
// DEUX en-têtes seulement sont ajoutés à ce que sert le serveur de test, un par origine, chacun
// décidé par l'ADR 0017 et non par ce fichier : voir `EN_TETES_AJOUTES_PAR_LA_PUBLICATION`. Le
// cliquet de `tests/unit/publication-arborescences.test.mjs` échoue sur un troisième.
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
 * Les DEUX en-têtes que la publication ajoute à ce que sert le serveur de test.
 *
 * Chacun est posé sur une seule origine, et pour une raison qui ne vaut que là. Ajouter une entrée
 * ici demande un ADR : le cliquet unitaire compare cette table à l'écart réellement mesuré entre
 * `securityHeaders()` et ce qui est publié, et refuse tout ajout non déclaré.
 *
 * @type {readonly { arbre: string, nom: string, valeur: (o: object) => string,
 *                   decidePar: string, motif: string }[]}
 */
export const EN_TETES_AJOUTES_PAR_LA_PUBLICATION = Object.freeze([
  Object.freeze({
    arbre: "coquille",
    nom: "Cross-Origin-Opener-Policy",
    valeur: () => "same-origin",
    decidePar: "ADR 0017 § 3, sur la recommandation différée de l'ADR 0010",
    motif:
      "Il retire à la future détentrice de clés la relation d'OUVERTURE inter-fenêtres, que la " +
      "partition d'origine ne couvre pas et que `frame-ancestors` ne couvre pas non plus. Il n'est " +
      "pas posé sur l'origine applicative : un document encadré n'est pas un contexte de " +
      "navigation de plus haut niveau, l'en-tête y serait sans effet.",
  }),
  Object.freeze({
    arbre: "application",
    nom: "Content-Security-Policy",
    valeur: ({ origineCoquille }) => `frame-ancestors ${origineCoquille}`,
    decidePar: "ADR 0017 § 3 bis",
    motif:
      "Sans lui, le document applicatif est encadrable par N'IMPORTE QUEL site — son origine porte " +
      "les cookies de session Rails, son stockage et son Service Worker. Cette directive ne " +
      "contraint RIEN de ce que le guest rend : elle ne gouverne pas ce que le document charge, " +
      "seulement QUI a le droit de l'encadrer. Elle ne rouvre donc pas ce que l'ADR 0002 " +
      "s'interdit — imposer une politique au contenu applicatif —, et c'est pourquoi elle est " +
      "SEULE : ni `default-src`, ni `script-src`, ni `connect-src` n'accompagnent " +
      "`frame-ancestors`, et le témoin d'en-têtes vérifie cette solitude.",
  }),
]);

/**
 * Chemin représentatif d'un arbre, pour interroger `securityHeaders()`.
 *
 * Le rôle `shell` sert sa CSP à tout ce qui n'est ni territoire applicatif (`/spike/origin/app…`)
 * ni sonde de capacités (`/compat…`) — deux préfixes que la publication EXCLUT par ailleurs
 * (`tools/publier-arborescences.mjs`). Interroger la racine rend donc la politique servie à
 * l'intégralité de l'arbre publié, ce que `cheminsHorsPolitiqueUniforme` vérifie au lieu de le
 * supposer.
 */
const CHEMIN_REPRESENTATIF = "/index.html";

/** @param {{ origineCoquille?: string, origineApplication?: string }} options */
function origines(options) {
  return {
    origineCoquille: options.origineCoquille ?? ORIGINE_COQUILLE_PAR_DEFAUT,
    origineApplication: options.origineApplication ?? ORIGINE_APPLICATION_PAR_DEFAUT,
  };
}

/** Origine que l'arbre nommé occupe lui-même. */
export function origineDeLArbre(arbre, options = {}) {
  const { origineCoquille, origineApplication } = origines(options);
  return arbre === "coquille" ? origineCoquille : origineApplication;
}

function exigerArbreConnu(arbre) {
  const role = ORIGINES[arbre];
  if (role === undefined) {
    throw new Error(
      `Arbre inconnu : ${arbre}. Valeurs admises : ${Object.keys(ORIGINES).join(", ")}.`,
    );
  }
  return role;
}

/** Applique les additions de la table à un jeu d'en-têtes déjà rendu par `securityHeaders()`. */
function ajouterLesEnTetesDePublication(enTetes, arbre, options) {
  for (const ajout of EN_TETES_AJOUTES_PAR_LA_PUBLICATION) {
    if (ajout.arbre === arbre) enTetes[ajout.nom] = ajout.valeur(origines(options));
  }
  return enTetes;
}

/**
 * En-têtes servis à TOUT l'arbre d'une origine.
 *
 * @param {"coquille" | "application"} arbre
 * @param {{ origineCoquille?: string, origineApplication?: string }} [options]
 * @returns {Record<string, string>}
 */
export function enTetesDePublication(arbre, options = {}) {
  const role = exigerArbreConnu(arbre);
  const enTetes = securityHeaders({
    role,
    pathname: CHEMIN_REPRESENTATIF,
    isolation: null,
    appOrigin: origines(options).origineApplication,
  });
  return ajouterLesEnTetesDePublication(enTetes, arbre, options);
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
 * @param {{ origineCoquille?: string, origineApplication?: string }} [options]
 * @returns {readonly string[]} les chemins dont la politique diffère de celle de la racine
 */
export function cheminsHorsPolitiqueUniforme(arbre, chemins, options = {}) {
  const reference = JSON.stringify(enTetesDePublication(arbre, options));
  const role = exigerArbreConnu(arbre);
  return chemins.filter((chemin) => {
    const mesure = securityHeaders({
      role,
      pathname: `/${chemin}`,
      isolation: null,
      appOrigin: origines(options).origineApplication,
    });
    return JSON.stringify(ajouterLesEnTetesDePublication(mesure, arbre, options)) !== reference;
  });
}

/** Préfixe de la ligne qui inscrit l'origine de l'arbre dans un octet PUBLIÉ. */
export const MARQUE_ORIGINE = "# origine: ";

/**
 * Rend le fichier `_headers` que lisent Cloudflare Pages et Netlify.
 *
 * Le format est le même chez les deux : une ligne de motif, puis les en-têtes indentés. Ce n'est
 * pas un standard, c'est une convention partagée — le spike #45 la relève comme telle, et l'ADR
 * 0017 dit ce qu'il faudrait produire à la place pour un reverse proxy.
 *
 * ## Pourquoi l'origine de l'arbre est écrite ICI, et pas seulement dans l'inventaire
 *
 * La revue de sécurité de #45 a mesuré que deux constructions d'origines de coquille différentes
 * rendaient la MÊME empreinte de racine : le `_headers` de la coquille ne porte l'origine
 * applicative que par `frame-src`, et sa PROPRE origine n'apparaissait que dans `inventaire.json`,
 * fichier explicitement hors de sa propre empreinte. Une bascule d'origine — c'est-à-dire une
 * MIGRATION au sens de l'ADR 0009, où l'OPFS de l'ancienne origine devient inatteignable — passait
 * donc inaperçue à la comparaison d'empreintes du § 7 de l'ADR 0017.
 *
 * Cette ligne de commentaire est un octet servi comme les autres : elle entre dans l'empreinte du
 * fichier, donc dans l'empreinte de racine. Deux origines rendent désormais deux racines, et
 * `tests/unit/publication-arborescences.test.mjs` le vérifie sur les deux arbres.
 *
 * @param {"coquille" | "application"} arbre
 * @param {{ origineCoquille?: string, origineApplication?: string }} [options]
 */
export function rendreFichierHeaders(arbre, options = {}) {
  const enTetes = enTetesDePublication(arbre, options);
  const lignes = [
    `# RailsBox Vault — arbre « ${arbre} » (ADR 0002, ADR 0017).`,
    "# Généré par `node tools/publier.mjs` depuis `tools/serve-headers.mjs`. Ne pas éditer à la main.",
    // Dans l'empreinte, délibérément : voir ci-dessus.
    `${MARQUE_ORIGINE}${origineDeLArbre(arbre, options)}`,
    "/*",
    ...Object.entries(enTetes).map(([nom, valeur]) => `  ${nom}: ${valeur}`),
  ];
  return `${lignes.join("\n")}\n`;
}

/** Nom du fichier d'en-têtes dans un arbre publié. */
export const FICHIER_HEADERS = "_headers";
