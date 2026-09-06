// LE MOTEUR d'une campagne de mutation, partagé par les outils qui en portent une TABLE.
//
//     import { campagneDeMutation } from "./moteur-de-mutation.mjs";
//
// Une suite verte ne prouve rien tant qu'on n'a pas montré qu'elle sait rougir. Une campagne RETIRE
// réellement une garde du source, relance l'épreuve qui devrait la couvrir, puis restaure. Ce module
// tient la MÉTHODE ; chaque outil tient sa table, parce que ce sont les gardes qui changent et non
// la façon de les éprouver.
//
// Trois règles y sont écrites une fois pour toutes, et chacune a été payée par une exécution :
//
//  1. **la mutation a lieu dans une COPIE temporaire, jamais dans `src/`** — les fichiers d'épreuve
//     de `npm run test:unit` s'exécutent en parallèle, et une garde retirée dans le dépôt serait vue
//     par les épreuves voisines (#65) ;
//  2. **un mutant n'est tué que si l'épreuve PASSAIT avant qu'on le pose** — sinon un fichier
//     d'épreuve absent, ou une suite déjà rouge, compterait pour une preuve (revue de #65) ;
//  3. **un enfant qui s'arrête sans rendre de verdict est NON CONCLUANT** — signal, tas épuisé,
//     processus non démarré. Compter cela pour une mise à mort reviendrait à croire qu'une garde est
//     éprouvée parce que la retirer fait planter le processus (la CI de #147 l'a trouvé).
//
// L'extraction date de #148 : la table de la révocation d'urgence aurait été la TROISIÈME copie du
// même moteur. `tools/muter-gardes-instantane.mjs` (#65, ADR 0024) garde la sienne pour l'instant —
// la déplacer sans que sa tranche y touche ferait porter à #148 un remaniement qu'aucune épreuve de
// #148 ne couvre.

import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("../", import.meta.url));

/** Ce que la copie emporte : le code, les épreuves, les vecteurs et les outils qu'elles importent. */
const RECOPIES = ["src", "tests", "tools", "public", "package.json"];

/** Recopie le dépôt utile dans un répertoire temporaire, et rend son chemin. */
function copierLeDepot(etiquette) {
  const atelier = mkdtempSync(join(tmpdir(), `vault-mutation-${etiquette}-`));
  for (const entree of RECOPIES) {
    cpSync(join(RACINE, entree), join(atelier, entree), { recursive: true });
  }
  return atelier;
}

/**
 * Rejoue des épreuves DANS l'atelier, et rend le CODE DE SORTIE observé.
 *
 * `NODE_TEST_CONTEXT` est retiré de l'environnement de l'enfant : hérité, il ferait sortir un
 * `node --test` avec le code 0 quoi qu'il arrive, et un mutant vivant passerait pour mort.
 */
function rejouer(atelier, epreuves) {
  const environnement = { ...process.env };
  delete environnement.NODE_TEST_CONTEXT;
  const resultat = spawnSync(
    process.execPath,
    [`--max-old-space-size=${TAS_MAXIMAL_MO}`, "--test", "--test-timeout=60000", ...epreuves],
    { cwd: atelier, encoding: "utf8", env: environnement },
  );
  const sortie = `${resultat.stdout ?? ""}${resultat.stderr ?? ""}`;
  return {
    status: resultat.status,
    signal: resultat.signal,
    memoireEpuisee: /heap out of memory|Allocation failed|FATAL ERROR/i.test(sortie),
  };
}

/**
 * Plafond du TAS d'un enfant, en mégaoctets.
 *
 * Il existe parce que la CI a trouvé ce que la campagne ne pouvait pas voir : sous un mutant, une
 * épreuve confrontait deux tableaux de 65 536 entrées, et la construction du diff par `assert`
 * atteignait 4,2 Go — assez pour faire tuer le runner entier. Le mutant était alors compté « tué »
 * par un plantage mémoire, pas par une assertion.
 *
 * 512 Mo est plus du double de ce que la plus grosse des suites de ce dépôt consomme (234 Mo
 * relevés), et deux ordres de grandeur sous ce qu'un emballement atteint. La borne ne rend donc
 * aucune épreuve légitime plus fragile ; elle transforme un emballement en fait OBSERVABLE.
 */
const TAS_MAXIMAL_MO = 512;

/**
 * Applique une mutation dans l'atelier, rejoue, remet le fichier d'origine.
 *
 * L'épreuve est d'abord jouée SANS mutation : un mutant n'est tué que si l'épreuve PASSAIT avant
 * qu'on le pose. C'est la garde que la revue de #65 a exigée, et elle vaut ici pour la même raison.
 */
function eprouver(atelier, mutation) {
  const chemin = join(atelier, mutation.fichier);
  const original = readFileSync(chemin, "utf8");
  const identite = { nom: mutation.nom, garde: mutation.garde };
  const occurrences = original.split(mutation.avant).length - 1;
  if (occurrences !== 1) {
    return {
      ...identite,
      applicable: false,
      tue: false,
      raison: `le texte à retirer apparaît ${occurrences} fois dans ${mutation.fichier} — la mutation ne décrit pas ce qu'elle croit décrire.`,
    };
  }

  const base = rejouer(atelier, mutation.epreuves);
  if (base.status !== 0) {
    return {
      ...identite,
      applicable: false,
      tue: false,
      raison: `l'épreuve ne passe pas AVANT la mutation (${decrire(base)}) : elle ne peut rien mesurer.`,
    };
  }

  try {
    writeFileSync(chemin, original.replace(mutation.avant, mutation.apres), "utf8");
    if (!seLit(chemin)) {
      return {
        ...identite,
        applicable: false,
        tue: false,
        raison: `le fichier muté NE SE LIT PLUS (erreur de syntaxe) : n'importe quelle épreuve le tuerait, et la garde ne serait pas mesurée pour autant.`,
      };
    }
    const mute = rejouer(atelier, mutation.epreuves);
    // NON CONCLUANT, et jamais « tuée ». Un enfant terminé par un SIGNAL, non démarré, ou qui a
    // épuisé son tas n'a pas rendu de verdict : il s'est arrêté. Compter cela pour une mise à mort
    // reviendrait à croire qu'une garde est éprouvée parce que la retirer fait planter le
    // processus — c'est la faute que la garde de #65 visait (« un mutant n'est tué que si l'épreuve
    // PASSAIT avant qu'on le pose »), sous une autre forme, et la CI l'a trouvée avant nous.
    if (mute.status === null || mute.signal !== null || mute.memoireEpuisee) {
      return {
        ...identite,
        applicable: true,
        tue: false,
        raison: `NON CONCLUANT : l'enfant s'est arrêté sans rendre de verdict (${decrire(mute)}). Un mutant n'est tué que par une épreuve qui ROUGIT.`,
      };
    }
    return { ...identite, applicable: true, tue: mute.status !== 0, raison: null };
  } finally {
    writeFileSync(chemin, original, "utf8");
  }
}

/**
 * Le fichier muté SE LIT-IL encore ? Un `node --check`, avant de rejouer quoi que ce soit.
 *
 * La garde vient de la revue de #148, qui a trouvé une mutation dont le remplacement ouvrait une
 * accolade sans la fermer. Le moteur compte tout code de sortie non nul pour une mise à mort : ce
 * mutant-là était donc tué par N'IMPORTE QUELLE épreuve, y compris une qui n'approche pas la garde,
 * et la campagne le comptait dans son score. C'est le pendant exact des deux gardes déjà écrites
 * plus haut — « l'épreuve passait-elle AVANT ? », « l'enfant a-t-il rendu un verdict ? » — sur un
 * troisième bord : **la mutation décrit-elle encore un programme ?**
 *
 * Le verdict est « non applicable », comme un texte-ancre absent, et jamais « tuée ».
 */
function seLit(chemin) {
  try {
    execFileSync(process.execPath, ["--check", chemin], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/** Dit en clair COMMENT un enfant s'est terminé. Trois états, et les confondre coûte cher. */
function decrire({ status, signal, memoireEpuisee }) {
  if (memoireEpuisee) return `tas de ${TAS_MAXIMAL_MO} Mo épuisé`;
  if (signal !== null && signal !== undefined) return `tué par le signal ${signal}`;
  if (status === null) return "enfant non démarré";
  return `code ${status}`;
}

/**
 * Rejoue une campagne entière. `mutations` est la table de l'outil appelant ; `etiquette` ne sert
 * qu'à nommer l'atelier temporaire, pour qu'un diagnostic dise de quelle campagne il parle.
 *
 * @param {{ mutations: Array<object>, etiquette?: string }} plan
 */
export function campagneDeMutation({ mutations, etiquette = "gardes" }) {
  const atelier = copierLeDepot(etiquette);
  try {
    return { resultats: mutations.map((mutation) => eprouver(atelier, mutation)) };
  } finally {
    rmSync(atelier, { recursive: true, force: true });
  }
}
