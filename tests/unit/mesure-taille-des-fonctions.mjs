/**
 * MESURE des fonctions de `src/` et `public/vm/` : leur taille, et la part de cette taille qui
 * n'est qu'une DÉCLARATION DE CONTRAT.
 *
 * Ce module ne décide de rien : il relève, et il expose le prédicat que la convention utilise.
 * `taille-des-fonctions.test.mjs` porte la convention, ses listes d'exceptions et ses épreuves.
 *
 * ## Deux mesures, une seule passe d'ESLint
 *
 * 1. **La taille**, par `max-lines-per-function` d'ESLint, appliquée en surcharge sur la
 *    configuration réelle du dépôt — donc sans l'y activer. C'est elle qui fait autorité sur
 *    l'identité d'une fonction (« Async function 'readArchive' ») comme sur son nombre de lignes.
 * 2. **La forme du corps**, par une règle écrite ici même et branchée dans la même passe. Une règle
 *    en ligne donne accès à l'AST sans ajouter de dépendance et sans écrire un second analyseur :
 *    la mesure porte exactement sur l'arbre qu'ESLint vient de construire.
 *
 * Les deux relevés sont joints par (fichier, ligne), et la jointure est vérifiée : une fonction que
 * la seconde mesure n'a pas retrouvée rend `horsLitteral: null`, ce qui la rend inadmissible. Un
 * instrument cassé ne doit jamais se lire comme une conformité.
 *
 * ## Ce que la seconde mesure compte
 *
 * - `horsLitteral` — les lignes de la fonction, MOINS les lignes INTÉRIEURES au ou aux littéraux
 *   d'objet qu'elle rend. Les accolades du littéral restent comptées : elles appartiennent au corps.
 *   Un littéral rendu est l'argument d'un `return` du corps PROPRE de la fonction — jamais celui
 *   d'une fonction imbriquée, dont la taille est mesurée pour elle-même —, directement
 *   (`return { … }`) ou à travers un seul appel (`return Object.freeze({ … })`).
 * - `rendUnContrat` — vrai si l'un des littéraux rendus déclare au moins une MÉTHODE. Un littéral de
 *   données n'est pas un contrat : la fonction qui l'assemble fait un travail, et ce travail se
 *   mesure comme tout autre.
 * - `plusGrandeMethode` — la plus grande méthode des littéraux rendus, en lignes. Zéro s'il n'y en a
 *   aucune.
 */

import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Plafond du dépôt, en lignes, tel que #77 l'a mesuré. */
export const PLAFOND = 50;

/** Code de production servi au navigateur. `tests/` et `tools/` ne sont pas couverts. */
export const PERIMETRE = ["src/**/*.mjs", "public/vm/**/*.mjs"];

const NOEUDS_FONCTION = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** Vrai si cette propriété d'un littéral déclare un comportement, et non une donnée. */
function estMethode(propriete) {
  if (propriete.type !== "Property") return false;
  if (propriete.method || propriete.kind === "get" || propriete.kind === "set") return true;
  return NOEUDS_FONCTION.has(propriete.value?.type);
}

/**
 * Le noeud dont `max-lines-per-function` compte les lignes : la PROPRIÉTÉ quand la fonction est une
 * méthode, la fonction elle-même sinon. Reproduit `isEmbedded` de la règle d'ESLint, dont c'est la
 * seule subtilité de comptage qui déplace une frontière de ligne.
 */
function noeudCompte(fonction) {
  const parent = fonction.parent;
  if (!parent || parent.value !== fonction) return fonction;
  if (parent.type === "MethodDefinition") return parent;
  if (
    parent.type === "Property" &&
    (parent.method || parent.kind === "get" || parent.kind === "set")
  ) {
    return parent;
  }
  return fonction;
}

/** Nombre de lignes d'un noeud, du premier au dernier caractère, comme la règle les compte. */
function lignesDe(noeud) {
  return noeud.loc.end.line - noeud.loc.start.line + 1;
}

/** Littéraux d'objet rendus par un `return` du corps PROPRE de `fonction`. */
function litterauxRendus(fonction) {
  const rendus = [];
  const visiter = (noeud) => {
    if (noeud === null || typeof noeud !== "object") return;
    if (Array.isArray(noeud)) {
      for (const enfant of noeud) visiter(enfant);
      return;
    }
    if (typeof noeud.type !== "string") return;
    // Une fonction imbriquée porte sa propre mesure : ce qu'elle rend n'appartient pas à ce corps.
    if (noeud !== fonction && NOEUDS_FONCTION.has(noeud.type)) return;
    if (noeud.type === "ReturnStatement" && noeud.argument !== null) {
      const rendu = noeud.argument;
      if (rendu.type === "ObjectExpression") {
        rendus.push(rendu);
      } else if (rendu.type === "CallExpression") {
        for (const argument of rendu.arguments) {
          if (argument.type === "ObjectExpression") rendus.push(argument);
        }
      }
    }
    for (const cle of Object.keys(noeud)) {
      if (cle === "parent" || cle === "loc" || cle === "range") continue;
      visiter(noeud[cle]);
    }
  };
  visiter(fonction.body);
  return rendus;
}

/** Règle en ligne : publie, pour chaque fonction, la forme de son corps. */
const regleFormeDuCorps = {
  create(context) {
    const mesurer = (fonction) => {
      const lignes = lignesDe(noeudCompte(fonction));
      const rendus = litterauxRendus(fonction);
      const methodes = rendus.flatMap((litteral) => litteral.properties.filter(estMethode));
      const interieures = rendus.reduce(
        (total, litteral) => total + Math.max(0, lignesDe(litteral) - 2),
        0,
      );
      context.report({
        node: noeudCompte(fonction),
        message: JSON.stringify({
          lignes,
          horsLitteral: lignes - interieures,
          rendUnContrat: methodes.length > 0,
          plusGrandeMethode: methodes.reduce((max, m) => Math.max(max, lignesDe(m)), 0),
        }),
      });
    };
    return {
      FunctionDeclaration: mesurer,
      FunctionExpression: mesurer,
      ArrowFunctionExpression: mesurer,
    };
  },
};

const REGLE_TAILLE = "max-lines-per-function";
const REGLE_FORME = "taille/forme-du-corps";

const SURCHARGE = {
  plugins: { taille: { rules: { "forme-du-corps": regleFormeDuCorps } } },
  rules: {
    [REGLE_TAILLE]: [
      "error",
      { max: PLAFOND, skipBlankLines: false, skipComments: false, IIFEs: true },
    ],
    [REGLE_FORME]: "error",
  },
};

/**
 * **La convention des fabriques de contrat, telle que le dépôt la mesure.**
 *
 * Le plafond de 50 lignes vise l'ENCHAÎNEMENT DE DÉCISIONS, pas la déclaration d'un contrat. Une
 * clôture qui rend un littéral de méthodes documentées est l'idiome dominant du dépôt, et
 * `max-lines-per-function` compte ce littéral comme du corps de fonction alors qu'il n'enchaîne
 * rien. Une telle fabrique est donc admise au-delà du plafond, mais à trois conditions, et
 * l'ensemble se mesure sans qu'une revue ait à trancher :
 *
 *  1. elle rend un littéral qui déclare au moins une MÉTHODE — un littéral de données n'est pas un
 *     contrat, et la fonction qui l'assemble fait un travail qui se mesure ;
 *  2. son corps HORS de ce littéral tient sous le plafond — au-delà, ce n'est plus une déclaration
 *     entourée de quelques gestes, c'est un module qui se termine par un contrat ;
 *  3. aucune méthode du littéral ne dépasse le plafond — sinon c'est la méthode qui se découpe, et
 *     l'exemption de la fabrique masquerait sa taille.
 */
export function estFabriqueDeContrat(mesure) {
  if (mesure.horsLitteral === null) return false;
  return (
    mesure.rendUnContrat && mesure.horsLitteral <= PLAFOND && mesure.plusGrandeMethode <= PLAFOND
  );
}

/**
 * Rend la mesure de forme qui parle de la MÊME fonction que le dépassement, ou `null`.
 *
 * La taille sert de clé première parce qu'elle est stable : `max-lines-per-function` rapporte à la
 * TÊTE de la fonction — au jeton `=>` pour une flèche — là où la seconde mesure rapporte au nœud
 * compté, et deux fonctions peuvent commencer sur la même ligne (une flèche en valeur par défaut de
 * paramètre, par exemple). La ligne ne départage que des candidates de taille identique.
 */
function apparier(candidates, ligne, lignes) {
  const memeTaille = candidates.filter((mesure) => mesure.lignes === lignes);
  if (memeTaille.length === 1) return memeTaille[0];
  const memeLigne = memeTaille.filter((mesure) => mesure.ligne === ligne);
  return memeLigne.length === 1 ? memeLigne[0] : null;
}

/** Joint les deux mesures d'un résultat ESLint, et rend les fonctions qui dépassent le plafond. */
function joindre(fichier, messages) {
  const formes = messages
    .filter((message) => message.ruleId === REGLE_FORME)
    .map((message) => ({ ligne: message.line, ...JSON.parse(message.message) }));
  const releve = [];
  for (const message of messages) {
    if (message.ruleId !== REGLE_TAILLE) continue;
    // « Async function 'x' has too many lines (119). Maximum allowed is 50. » — la nature et le
    // nom forment l'identité, le nombre entre parenthèses la mesure.
    const [fonction] = message.message.split(" has too many lines");
    const lignes = Number(/\((?<n>\d+)\)/u.exec(message.message)?.groups?.n);
    // Une jointure ambiguë laisse `horsLitteral` nul : la fonction n'est alors pas admissible, et
    // l'épreuve le dit. Un instrument qui doute ne doit jamais se lire comme une conformité.
    const jointe = apparier(formes, message.line, lignes);
    releve.push({
      fichier,
      fonction,
      ligne: message.line,
      lignes,
      horsLitteral: jointe?.horsLitteral ?? null,
      rendUnContrat: jointe?.rendUnContrat ?? false,
      plusGrandeMethode: jointe?.plusGrandeMethode ?? 0,
    });
  }
  return releve;
}

/** Chemin du fichier relatif à la racine du dépôt, en séparateurs POSIX. */
function cheminRelatif(absolu) {
  const racine = REPO_ROOT.replaceAll("\\", "/");
  return absolu.replaceAll("\\", "/").slice(racine.length);
}

/**
 * Relève les fonctions du périmètre qui dépassent le plafond, chacune avec la forme de son corps.
 *
 * @returns {Promise<{ fichier: string, fonction: string, ligne: number, lignes: number,
 *                     horsLitteral: number | null, rendUnContrat: boolean,
 *                     plusGrandeMethode: number }[]>}
 */
export async function relever() {
  const eslint = new ESLint({ cwd: REPO_ROOT, overrideConfig: SURCHARGE });
  const resultats = await eslint.lintFiles(PERIMETRE);
  return resultats.flatMap((resultat) =>
    joindre(cheminRelatif(resultat.filePath), resultat.messages),
  );
}

/**
 * Mesure un fragment de source comme s'il était un module du périmètre. Sert aux épreuves de la
 * convention elle-même : un prédicat qu'aucun exemple n'éprouve n'est qu'une intention.
 */
export async function mesurerTexte(source) {
  const eslint = new ESLint({ cwd: REPO_ROOT, overrideConfig: SURCHARGE });
  const [resultat] = await eslint.lintText(source, { filePath: "src/vm/mesure-fixture.mjs" });
  return joindre("src/vm/mesure-fixture.mjs", resultat.messages);
}
