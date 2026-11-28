// La BASE DE DONNÉES que l'application déclare, lue dans `config/database.yml` (#343, ADR 0056).
//
// L'outil s'adapte à l'application (#272) : une application Rails conventionnelle qui déclare
// `adapter: postgresql` en PRODUCTION reçoit un cluster PostgreSQL préparé sur sa graine, sans
// rien changer à son code ; une application `sqlite3` garde le chemin de l'ADR 0004. C'est la
// production qui décide : un `sqlite3` de développement ne dit rien de ce que le paquet exécutera.
//
// La lecture suit ce que Rails fait du fichier, sur le sous-ensemble YAML que les applications
// écrivent : balises ERB retirées d'abord (elles rendent le fichier non-YAML, principe repris de
// RailsBox, `tools/detect/detect.mjs`), ancres `&nom` et fusions `<<: *nom`, connexion unique ou
// bases NOMMÉES (`primary:`, `cache:`… de Rails 6+). Ce qui ne se lit pas n'est pas deviné : c'est
// un refus, en clair, avant le premier `docker build`.

/** Les moteurs que le guest sait faire tourner. */
export const BASES_PRISES_EN_CHARGE = Object.freeze(["sqlite3", "postgresql"]);

const FICHIER = "config/database.yml";

/**
 * @typedef {{ cle: string, valeur: string, ancre: string | null, alias: string | null,
 *             indentation: number, enfants: Noeud[] }} Noeud
 */

/** Retire l'ERB et les commentaires, sans toucher à l'indentation. */
function lignesUtiles(texte) {
  return texte
    .replace(/<%[\s\S]*?%>/g, "")
    .split(/\r?\n/)
    .map((ligne) => ligne.replace(/(^|\s)#.*$/, "").replace(/\s+$/, ""))
    .filter((ligne) => ligne.trim() !== "");
}

/**
 * Construit l'arbre des clés par l'indentation, et la table des ancres.
 *
 * @param {string} texte
 * @returns {{ racine: Noeud[], ancres: Map<string, Noeud> }}
 */
function arbreDuFichier(texte) {
  const racine = [];
  const ancres = new Map();
  const pile = [{ indentation: -1, enfants: racine }];
  for (const ligne of lignesUtiles(texte)) {
    const entree = ligne.trim().match(/^([A-Za-z0-9_-]+|<<):\s*(.*)$/);
    if (entree === null) continue;
    const indentation = ligne.length - ligne.trimStart().length;
    while (pile.at(-1).indentation >= indentation) pile.pop();
    const [, cle, reste] = entree;
    const ancre = reste.match(/^&(\S+)/)?.[1] ?? null;
    const alias = cle === "<<" ? (reste.match(/^\*(\S+)/)?.[1] ?? null) : null;
    const valeur = ancre === null ? reste.trim().replace(/^["']|["']$/g, "") : "";
    const noeud = { cle, valeur, ancre, alias, indentation, enfants: [] };
    pile.at(-1).enfants.push(noeud);
    pile.push(noeud);
    if (ancre !== null) ancres.set(ancre, noeud);
  }
  return { racine, ancres };
}

/** L'adaptateur effectif d'une connexion : le sien, sinon celui qu'elle fusionne. */
function adaptateurEffectif(noeud, ancres, profondeur = 0) {
  if (profondeur > 8) return null;
  const propre = noeud.enfants.find((enfant) => enfant.cle === "adapter");
  if (propre !== undefined) return propre.valeur === "" ? null : propre.valeur;
  for (const fusion of noeud.enfants.filter((enfant) => enfant.cle === "<<")) {
    const cible = fusion.alias === null ? undefined : ancres.get(fusion.alias);
    const herite = cible === undefined ? null : adaptateurEffectif(cible, ancres, profondeur + 1);
    if (herite !== null) return herite;
  }
  return null;
}

/**
 * Les adaptateurs que la PRODUCTION déclare, sans doublon : un seul pour une connexion unique, un
 * par base nommée sinon. Une base dont l'adaptateur ne se lit pas compte pour `null`.
 *
 * @param {string} databaseYml
 * @returns {(string | null)[]}
 */
export function adaptateursDeProduction(databaseYml) {
  const { racine, ancres } = arbreDuFichier(databaseYml);
  const production = racine.find((noeud) => noeud.cle === "production");
  if (production === undefined) return [];
  const unique = adaptateurEffectif(production, ancres);
  if (unique !== null) return [unique];
  const nommees = production.enfants.filter(
    (enfant) => enfant.cle !== "<<" && enfant.valeur === "" && enfant.enfants.length > 0,
  );
  const adaptateurs = nommees.map((base) => adaptateurEffectif(base, ancres));
  return [...new Set(adaptateurs)];
}

/** Une anomalie au format du rapport de refus (`rapport-de-refus.mjs`). */
function anomalie(code, quoi, pourquoi, changer) {
  return { code, fichier: FICHIER, quoi, pourquoi, changer };
}

/**
 * La base de l'application, ou le refus qui dit pourquoi elle n'est pas lisible.
 *
 * @param {{ databaseYml: string | null }} entree contenu de `config/database.yml`, `null` s'il manque
 * @returns {{ base: "sqlite3" | "postgresql" | null,
 *             anomalies: import("./rapport-de-refus.mjs").AnomalieDeLaSource[] }}
 */
export function baseDeDonneesDeLApplication({ databaseYml }) {
  if (databaseYml === null) {
    return {
      base: null,
      anomalies: [
        anomalie(
          "base-de-donnees-absente",
          "l'application n'a pas de fichier config/database.yml.",
          "le coffre prépare la base à la fabrication du paquet, et c'est ce fichier qui dit laquelle.",
          "ajoutez le config/database.yml que Rails génère, avec un adaptateur sqlite3 ou postgresql en production.",
        ),
      ],
    };
  }
  const adaptateurs = adaptateursDeProduction(databaseYml);
  const lisibles = adaptateurs.filter((adaptateur) => adaptateur !== null);
  if (lisibles.length === 0 || lisibles.length !== adaptateurs.length) {
    return {
      base: null,
      anomalies: [
        anomalie(
          "base-de-donnees-indeterminee",
          "la section production ne dit pas son adaptateur de façon lisible (absent, ou calculé par ERB).",
          "le coffre ne devine pas le moteur : une base mal choisie ne démarrerait pas, ou pas avec la bonne garantie.",
          "écrivez « adapter: sqlite3 » ou « adapter: postgresql » dans la section production (ou dans la section qu'elle fusionne).",
        ),
      ],
    };
  }
  const inconnus = lisibles.filter((adaptateur) => !BASES_PRISES_EN_CHARGE.includes(adaptateur));
  if (inconnus.length > 0) {
    return {
      base: null,
      anomalies: [
        anomalie(
          "base-de-donnees-non-prise-en-charge",
          `la production utilise ${inconnus.join(", ")}, que le coffre ne sait pas faire tourner.`,
          "le guest n'embarque que SQLite et PostgreSQL ; un autre moteur échouerait au premier démarrage.",
          "utilisez sqlite3 ou postgresql en production pour cette application.",
        ),
      ],
    };
  }
  if (lisibles.length > 1) {
    return {
      base: null,
      anomalies: [
        anomalie(
          "base-de-donnees-mixte",
          `la production mélange plusieurs moteurs (${lisibles.join(", ")}).`,
          "le coffre prépare UN moteur par application, avec sa garantie de durabilité.",
          "utilisez un seul adaptateur pour toutes les bases de production.",
        ),
      ],
    };
  }
  return { base: /** @type {"sqlite3" | "postgresql"} */ (lisibles[0]), anomalies: [] };
}
