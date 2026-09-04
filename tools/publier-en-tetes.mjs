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

import { PREFIXE_EPINGLAGE_V86, securityHeaders } from "./serve-headers.mjs";

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

/**
 * La SEULE dimension que la politique publiée s'autorise à faire varier selon le chemin (ADR 0023).
 *
 * Ce n'est pas une commodité : c'est ce qui permet de remplacer le cliquet « politique uniforme »
 * par un cliquet « uniforme HORS cette dimension » sans l'affaiblir. Toute divergence de CSP, de
 * COOP, de `Referrer-Policy` ou de `Permissions-Policy` entre deux chemins d'un même arbre reste
 * refusée par `cheminsHorsUniformite`, et une seconde dimension non uniforme demanderait un ADR.
 */
export const DIMENSION_NON_UNIFORME = "Cache-Control";

/**
 * Blocs du fichier `_headers`, un par NATURE D'ARTEFACT servie dans l'arbre (ADR 0023).
 *
 * `motif` est le motif du format `_headers` ; `cheminRepresentatif` est un chemin que ce motif
 * attrape, et par lequel `securityHeaders()` est INTERROGÉE — la valeur n'est jamais recopiée ici.
 * L'ordre compte : la règle la plus générale d'abord, la plus précise ensuite, la dernière
 * l'emportant chez les hébergeurs qui cumulent.
 *
 * @type {readonly { arbre: string, motif: string, cheminRepresentatif: string, nature: string,
 *                   justification: string }[]}
 */
export const REGLES_DE_CACHE = Object.freeze([
  Object.freeze({
    arbre: "coquille",
    motif: "/*",
    cheminRepresentatif: CHEMIN_REPRESENTATIF,
    nature: "Coquille de confiance et ses modules",
    justification:
      "Ils changent à chaque version, et leur URL ne nomme pas la version : ils doivent être " +
      "REVALIDÉS avant réemploi. `no-cache` autorise le stockage — c'est ce que `no-store` " +
      "interdisait —, il n'autorise pas le réemploi muet.",
  }),
  Object.freeze({
    arbre: "coquille",
    motif: `${PREFIXE_EPINGLAGE_V86}*`,
    cheminRepresentatif: `${PREFIXE_EPINGLAGE_V86}MANIFEST.json`,
    nature: "Épinglage v86 (ADR 0003)",
    justification:
      "Les octets épinglés par empreinte, le manifeste qui les épingle et les licences du code " +
      "redistribué ne changent QU'ENSEMBLE, à la montée de version de l'émulateur. Une seule " +
      "règle les tient donc dans une seule fenêtre de fraîcheur, ce qui interdit qu'un manifeste " +
      "frais décrive des octets d'hier.",
  }),
  Object.freeze({
    arbre: "application",
    motif: "/*",
    cheminRepresentatif: CHEMIN_REPRESENTATIF,
    nature: "Territoire applicatif (ADR 0002)",
    justification:
      "Ce que cette origine sert en production porte les cookies de session Rails et vient du " +
      "guest. `no-store` y reste servi, mais comme une DÉCISION : ce que nous servons de cette " +
      "origine ne doit pas s'attarder dans un cache partagé, et ce que le guest sert de la sienne " +
      "reste gouverné par ses propres en-têtes.",
  }),
]);

/** Règles de cache d'un arbre, dans l'ordre où elles seront écrites. */
export function reglesDeCacheDe(arbre) {
  return REGLES_DE_CACHE.filter((regle) => regle.arbre === arbre);
}

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
 * En-têtes servis à un CHEMIN de l'arbre d'une origine.
 *
 * Le chemin par défaut est la racine, et c'est ce que rend le bloc `/*` du fichier `_headers`.
 * Depuis l'ADR 0023, un second appel avec le chemin représentatif d'une autre nature d'artefact
 * rend la politique de cache de cette nature — le reste des en-têtes ne varie pas, et le cliquet
 * de `cheminsHorsUniformite` refuse qu'il se mette à varier.
 *
 * @param {"coquille" | "application"} arbre
 * @param {{ origineCoquille?: string, origineApplication?: string }} [options]
 * @param {string} [chemin] chemin absolu servi, `/index.html` par défaut
 * @returns {Record<string, string>}
 */
export function enTetesDePublication(arbre, options = {}, chemin = CHEMIN_REPRESENTATIF) {
  const role = exigerArbreConnu(arbre);
  const enTetes = securityHeaders({
    role,
    pathname: chemin,
    isolation: null,
    appOrigin: origines(options).origineApplication,
  });
  return ajouterLesEnTetesDePublication(enTetes, arbre, options);
}

/**
 * Analyse le format `_headers` de Cloudflare Pages et de Netlify : une ligne de motif commençant
 * par `/`, puis des lignes indentées `Nom: valeur`. Les lignes vides et les `#` sont des
 * commentaires.
 *
 * Il vit dans le module qui ÉCRIT le format, et non dans le serveur qui l'applique : c'est ce qui
 * permet aux cliquets ci-dessous de vérifier l'aller-retour sans dépendre d'un socket, et à
 * `tools/publier-servir.mjs` de servir exactement ce que la publication a écrit. Ce module reste la
 * seule définition ; `publier-servir.mjs` la réexporte pour ses appelants historiques.
 *
 * @param {string} texte
 * @returns {{ motif: string, enTetes: [string, string][] }[]}
 */
export function analyserHeaders(texte) {
  const regles = [];
  for (const ligne of texte.split("\n")) {
    const nue = ligne.trim();
    if (nue === "" || nue.startsWith("#")) continue;
    if (!ligne.startsWith(" ") && !ligne.startsWith("\t")) {
      regles.push({ motif: nue, enTetes: [] });
      continue;
    }
    const separateur = nue.indexOf(":");
    if (separateur < 0 || regles.length === 0) continue;
    regles.at(-1).enTetes.push([nue.slice(0, separateur).trim(), nue.slice(separateur + 1).trim()]);
  }
  return regles;
}

/**
 * En-têtes qu'un chemin reçoit d'un jeu de règles : les motifs qui correspondent sont appliqués
 * dans l'ordre du fichier, la dernière valeur l'emportant.
 *
 * @param {{ motif: string, enTetes: [string, string][] }[]} regles
 * @param {string} chemin
 * @param {readonly string[]} retires
 */
export function enTetesPour(regles, chemin, retires = []) {
  const exclus = new Set(retires.map((nom) => nom.toLowerCase()));
  const resultat = {};
  for (const { motif, enTetes } of regles) {
    const correspond = motif.endsWith("/*")
      ? chemin.startsWith(motif.slice(0, -1))
      : motif === chemin;
    if (!correspond) continue;
    for (const [nom, valeur] of enTetes) {
      if (!exclus.has(nom.toLowerCase())) resultat[nom] = valeur;
    }
  }
  return resultat;
}

/** Signature d'un jeu d'en-têtes, hors la seule dimension déclarée non uniforme. */
function signatureHorsDimension(enTetes) {
  const compares = Object.entries(enTetes).filter(([nom]) => nom !== DIMENSION_NON_UNIFORME);
  return JSON.stringify(Object.fromEntries(compares));
}

/**
 * Cliquet n°1 — UNIFORMITÉ HORS LA DIMENSION DÉCLARÉE.
 *
 * `securityHeaders()` dépend du chemin : elle retire la CSP, `Referrer-Policy` et
 * `Permissions-Policy` au territoire applicatif et à la sonde de capacités, et depuis l'ADR 0023
 * elle fait varier `Cache-Control` par nature d'artefact. Ce cliquet refuse toute divergence SAUF
 * celle-là. Il n'est pas affaibli par l'ADR 0023 : il compare exactement le même jeu d'en-têtes
 * qu'avant, moins un, et un `compat.html` qui se glisserait dans l'arbre est encore refusé pour sa
 * CSP alors que sa politique de cache, elle, est celle de la racine.
 *
 * @param {"coquille" | "application"} arbre
 * @param {readonly string[]} chemins chemins relatifs de l'arbre publié
 * @param {{ origineCoquille?: string, origineApplication?: string }} [options]
 * @returns {readonly string[]}
 */
export function cheminsHorsUniformite(arbre, chemins, options = {}) {
  const reference = signatureHorsDimension(enTetesDePublication(arbre, options));
  return chemins.filter(
    (chemin) =>
      signatureHorsDimension(enTetesDePublication(arbre, options, `/${chemin}`)) !== reference,
  );
}

/**
 * Cliquet n°2 — FIDÉLITÉ DU FICHIER PRODUIT.
 *
 * L'uniformité seule ne suffit plus : un fichier `_headers` peut être uniforme hors cache ET
 * annoncer, pour un chemin, une politique de cache que la source de vérité ne sert pas — il suffit
 * qu'un bloc manque, que son motif soit mal écrit, ou qu'une nature d'artefact soit apparue sans
 * que la table la déclare. Ce cliquet relit donc le fichier PRODUIT avec l'analyseur qui le sert, et
 * exige qu'il rende à chaque chemin exactement ce que `securityHeaders()` lui servirait.
 *
 * `texteHeaders` est injectable pour que l'épreuve puisse lui présenter un fichier amputé : un
 * cliquet dont on ne peut pas montrer le refus est un cliquet décoratif.
 *
 * @param {"coquille" | "application"} arbre
 * @param {readonly string[]} chemins
 * @param {{ origineCoquille?: string, origineApplication?: string }} [options]
 * @param {string} [texteHeaders]
 * @returns {readonly string[]}
 */
export function cheminsHorsFideliteDuFichier(
  arbre,
  chemins,
  options = {},
  texteHeaders = rendreFichierHeaders(arbre, options),
) {
  const regles = analyserHeaders(texteHeaders);
  return chemins.filter((chemin) => {
    const servis = enTetesDePublication(arbre, options, `/${chemin}`);
    const rendus = enTetesPour(regles, `/${chemin}`);
    return Object.entries(servis).some(([nom, valeur]) => rendus[nom] !== valeur);
  });
}

/**
 * Chemins que le fichier `_headers` ne décrirait pas fidèlement — la réunion des deux cliquets.
 *
 * C'est ce que `tools/publier.mjs` appelle avant d'écrire un arbre ; le nom est celui de l'ADR 0017,
 * conservé parce que la propriété tenue est la même en substance : ce qui est annoncé est ce qui est
 * servi. L'ADR 0023 en a seulement déplacé la frontière, d'« une seule politique » à « une politique
 * par nature, et rien d'autre qui varie ».
 *
 * @param {"coquille" | "application"} arbre
 * @param {readonly string[]} chemins
 * @param {{ origineCoquille?: string, origineApplication?: string }} [options]
 * @returns {readonly string[]}
 */
export function cheminsHorsPolitiqueUniforme(arbre, chemins, options = {}) {
  const dissidents = new Set([
    ...cheminsHorsUniformite(arbre, chemins, options),
    ...cheminsHorsFideliteDuFichier(arbre, chemins, options),
  ]);
  return chemins.filter((chemin) => dissidents.has(chemin));
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
  const lignes = [
    `# RailsBox Vault — arbre « ${arbre} » (ADR 0002, ADR 0017, ADR 0023).`,
    "# Généré par `node tools/publier.mjs` depuis `tools/serve-headers.mjs`. Ne pas éditer à la main.",
    // Dans l'empreinte, délibérément : voir ci-dessus.
    `${MARQUE_ORIGINE}${origineDeLArbre(arbre, options)}`,
  ];
  for (const regle of reglesDeCacheDe(arbre)) {
    const enTetes = enTetesDePublication(arbre, options, regle.cheminRepresentatif);
    // La nature est nommée dans un octet SERVI : un exploitant qui relit le fichier doit pouvoir
    // dire pourquoi deux blocs, sans avoir le dépôt sous les yeux. La justification, elle, reste
    // dans `REGLES_DE_CACHE` — c'est un argument, pas une ligne de configuration.
    lignes.push(`# nature: ${regle.nature}`, regle.motif);
    // Chaque bloc porte TOUS les en-têtes, pas seulement celui qui change. Cloudflare Pages et
    // Netlify cumulent les règles qui correspondent, la dernière l'emportant ; rien ne garantit
    // qu'un troisième hébergeur le fasse, et un bloc précis réduit à `Cache-Control` retirerait
    // alors la CSP aux artefacts v86 chez celui-là. Le fichier rend le même résultat sous les deux
    // sémantiques, au prix de quelques lignes répétées.
    lignes.push(...Object.entries(enTetes).map(([nom, valeur]) => `  ${nom}: ${valeur}`));
  }
  return `${lignes.join("\n")}\n`;
}

/** Nom du fichier d'en-têtes dans un arbre publié. */
export const FICHIER_HEADERS = "_headers";
