// Le RUBY que l'application demande, confronté au seul Ruby du guest (#342).
//
// ## Provenance
//
// La lecture de la directive et la sémantique de `Gem::Requirement` sont reprises de
// `pinfada/railsbox`, `tools/detect/ruby-requirement.mjs` (`parseRubyDirective`,
// `resolveRubyRequirement`, `satisfiesRubyRequirement`), et la confrontation de
// `checkRubyRequirement` (`tools/detect/detect.mjs`). Même propriétaire, licence MIT des deux
// côtés. La logique est inchangée ; les noms sont passés en français, et le verdict devient une
// anomalie du coffre (`{ code, fichier, quoi, pourquoi, changer }`) au lieu d'un `Finding`.
//
// ## Ce que Bundler fait RÉELLEMENT respecter
//
// Un `.ruby-version` seul n'engage PAS Bundler (il ne parle qu'à rbenv, rvm, chruby). Seule la
// directive `ruby` du Gemfile lève un `Bundler::RubyVersionMismatch`, et elle prend plusieurs formes :
//
//   ruby "3.3.10"                  égalité stricte  → refuse 3.3.12
//   ruby "~> 3.3.10"               série 3.3 depuis 3.3.10 → accepte 3.3.12
//   ruby "~> 3.3"                  toute la série 3.3      → accepte 3.3.12
//   ruby ">= 3.1", "< 3.5"         intervalle              → accepte 3.3.12
//   ruby file: ".ruby-version"     le fichier devient une égalité stricte
//   (aucune directive)             Bundler n'exige rien
//
// Refuser autre chose que ce qui est réellement incompatible serait pire que le défaut : le coffre
// rejetterait des applications qui marchent.

/** Opérateurs de contrainte reconnus par Gem::Requirement. */
const OPERATEURS = Object.freeze(["~>", ">=", "<=", "!=", "=", ">", "<"]);

// `3.3.10p91`, `ruby-3.3.10`, `~> 3.3` : on ne garde que les composants numériques.
const VERSION_RUBY = /^(?:ruby-)?v?(\d+(?:\.\d+){0,2})/;

/**
 * Normalise une version de Ruby quelle que soit sa forme d'écriture.
 * @param {string|null|undefined} brute valeur brute (`ruby-3.3.10`, `~> 3.3`, `3.3.10p91`...)
 * @returns {string|null} version canonique `X.Y.Z`, ou `null` si illisible
 */
export function normaliserVersionRuby(brute) {
  if (typeof brute !== "string") return null;
  const nettoyee = brute
    .trim()
    .replace(/^[~^>=<\s]+/, "")
    .trim();
  const trouvee = VERSION_RUBY.exec(nettoyee);
  return trouvee ? trouvee[1] : null;
}

// Une directive `ruby` occupe toute la ligne ; « ruby » y est suivi d'un blanc ou d'une parenthèse,
// ce qui écarte `ruby_version`, `rubygems` ou un `gem "ruby-vips"` (qui, lui, commence par « gem »).
const LIGNE_DE_DIRECTIVE = /^[ \t]*ruby[ \t(]/;
const ENTRE_GUILLEMETS = /["']([^"']+)["']/g;
const MOT_CLE_FILE = /\bfile:\s*["']([^"']+)["']/;
const LECTURE_DE_FICHIER = /\bFile\.read\(\s*["']([^"']+)["']/;
// Une contrainte commence par un opérateur ou par un chiffre : « .ruby-version » et « jruby » n'en
// sont pas.
const RESSEMBLE_A_UNE_CONTRAINTE = /^\s*(?:~>|>=|<=|!=|=|>|<)?\s*\d/;

/**
 * Retire le commentaire d'une ligne Ruby.
 *
 * Les contraintes de version ne contiennent jamais de « # » : couper au premier dièse hors chaîne
 * suffit, et évite qu'un exemple commenté (`# ruby "3.4.0"`) soit pris pour la directive réelle.
 * @param {string} ligne ligne brute
 * @returns {string} ligne sans commentaire
 */
export function retirerLeCommentaireRuby(ligne) {
  let guillemet = null;
  for (let rang = 0; rang < ligne.length; rang += 1) {
    const caractere = ligne[rang];
    if (guillemet) {
      if (caractere === "\\") rang += 1;
      else if (caractere === guillemet) guillemet = null;
      continue;
    }
    if (caractere === '"' || caractere === "'") {
      guillemet = caractere;
      continue;
    }
    if (caractere === "#") return ligne.slice(0, rang);
  }
  return ligne;
}

/**
 * @typedef {object} DirectiveRuby
 * @property {"litterale"|"fichier"} forme forme de la directive
 * @property {readonly string[]} [contraintes] contraintes littérales (forme `litterale`)
 * @property {string} [chemin] fichier lu (forme `fichier`)
 * @property {string} brute texte de la ligne, pour les messages
 */

/**
 * Lit la directive `ruby` d'un Gemfile.
 * @param {string|null|undefined} gemfile contenu du Gemfile
 * @returns {DirectiveRuby|null} directive trouvée, ou `null` si Bundler n'exige rien
 */
export function lireLaDirectiveRuby(gemfile) {
  if (typeof gemfile !== "string") return null;
  for (const ligneBrute of gemfile.split(/\r?\n/)) {
    const ligne = retirerLeCommentaireRuby(ligneBrute);
    if (!LIGNE_DE_DIRECTIVE.test(ligne)) continue;
    const parFichier = MOT_CLE_FILE.exec(ligne) ?? LECTURE_DE_FICHIER.exec(ligne);
    if (parFichier) return { forme: "fichier", chemin: parFichier[1], brute: ligne.trim() };
    const contraintes = [...ligne.matchAll(ENTRE_GUILLEMETS)]
      .map((trouvee) => trouvee[1].trim())
      .filter((valeur) => RESSEMBLE_A_UNE_CONTRAINTE.test(valeur));
    if (contraintes.length === 0) continue;
    return { forme: "litterale", contraintes: Object.freeze(contraintes), brute: ligne.trim() };
  }
  return null;
}

/**
 * Résout la directive en contraintes littérales, en lisant le fichier désigné.
 * @param {DirectiveRuby|null} directive directive issue de {@link lireLaDirectiveRuby}
 * @param {string|null} fichierDesigne contenu du fichier désigné par `file:`
 * @returns {{contraintes: readonly string[], provenance: string}|null}
 */
export function resoudreLaContrainteRuby(directive, fichierDesigne) {
  if (!directive) return null;
  if (directive.forme === "litterale") {
    return { contraintes: directive.contraintes, provenance: "Gemfile" };
  }
  const brute = typeof fichierDesigne === "string" ? fichierDesigne.trim() : "";
  if (brute === "") return null;
  // Bundler lit le fichier et en fait une ÉGALITÉ stricte : `ruby file:` n'est pas plus permissif
  // que `ruby "3.3.10"`. Le préfixe « ruby- » que posent rbenv et consorts est retiré.
  const version = normaliserVersionRuby(brute.split(/\s+/)[0]);
  if (!version) return null;
  return {
    contraintes: Object.freeze([version]),
    provenance: `Gemfile (file: ${directive.chemin})`,
  };
}

/**
 * Découpe une contrainte en opérateur et version.
 * @param {string} contrainte contrainte littérale (« ~> 3.3.10 », « 3.3.10 »)
 * @returns {{operateur: string, segments: number[]}|null}
 */
function analyserLaContrainte(contrainte) {
  const nette = String(contrainte).trim();
  const operateur = OPERATEURS.find((candidat) => nette.startsWith(candidat)) ?? "=";
  const reste = nette.startsWith(operateur) ? nette.slice(operateur.length) : nette;
  const version = normaliserVersionRuby(reste.trim());
  if (!version) return null;
  return { operateur, segments: version.split(".").map((partie) => Number(partie)) };
}

/** Compare deux listes de segments numériques, en complétant par des zéros. */
function comparerSegments(gauche, droite) {
  const longueur = Math.max(gauche.length, droite.length);
  for (let rang = 0; rang < longueur; rang += 1) {
    const ecart = (gauche[rang] ?? 0) - (droite[rang] ?? 0);
    if (ecart !== 0) return ecart;
  }
  return 0;
}

/**
 * Borne haute exclusive d'une contrainte pessimiste `~>`.
 * `~> 3.3.10` → `< 3.4`, `~> 3.3` → `< 4.0`, `~> 3` → `< 4`.
 */
function bornePessimiste(segments) {
  if (segments.length <= 1) return [segments[0] + 1];
  const borne = segments.slice(0, -1);
  borne[borne.length - 1] += 1;
  return borne;
}

/** Vrai si une version satisfait une contrainte unique. */
function satisfaitUne(version, contrainte) {
  const comparaison = comparerSegments(version, contrainte.segments);
  switch (contrainte.operateur) {
    case "=":
      return comparaison === 0;
    case "!=":
      return comparaison !== 0;
    case ">":
      return comparaison > 0;
    case ">=":
      return comparaison >= 0;
    case "<":
      return comparaison < 0;
    case "<=":
      return comparaison <= 0;
    case "~>":
      return (
        comparaison >= 0 && comparerSegments(version, bornePessimiste(contrainte.segments)) < 0
      );
    default:
      return false;
  }
}

/**
 * Indique si une version de Ruby satisfait TOUTES les contraintes déclarées.
 * @param {string|null|undefined} version version candidate (celle du guest)
 * @param {readonly string[]|null|undefined} contraintes contraintes littérales
 * @returns {boolean|null} verdict, ou `null` si rien n'est vérifiable
 */
export function satisfaitLaContrainteRuby(version, contraintes) {
  const normalisee = normaliserVersionRuby(version);
  if (!normalisee || !Array.isArray(contraintes) || contraintes.length === 0) return null;
  const segments = normalisee.split(".").map((partie) => Number(partie));
  const analysees = contraintes.map(analyserLaContrainte);
  // Une contrainte illisible (« ruby engine », une variable) ne doit pas produire un refus : on
  // préfère laisser passer que bloquer à tort.
  if (analysees.some((contrainte) => contrainte === null)) return null;
  return analysees.every((contrainte) => satisfaitUne(segments, contrainte));
}

/**
 * CONFRONTE la directive `ruby` du Gemfile au Ruby du guest, et rend les anomalies.
 *
 * C'est le refus amont de `checkRubyRequirement` (RailsBox) : sans lui, le désaccord n'éclate qu'au
 * `bundle install` du Dockerfile, plusieurs minutes après le début de la construction.
 *
 * Ajout propre au coffre : `ruby file:` désigne un fichier que Bundler relira DANS le guest. S'il
 * n'entre pas dans le paquet (absent, ignoré par git, exclu), Bundler ne démarrera pas — c'est un
 * refus aussi, et le seul moment utile pour le dire est maintenant.
 *
 * @param {{ gemfile: string, fichiers: readonly string[], lire: (relatif: string) => string,
 *           rubyDuGuest: string }} entree
 * @returns {Array<{ code: string, fichier: string, quoi: string, pourquoi: string, changer: string }>}
 */
export function confronterLeRubyDemande({ gemfile, fichiers, lire, rubyDuGuest }) {
  const directive = lireLaDirectiveRuby(gemfile);
  if (directive === null) return [];
  if (directive.forme === "fichier") {
    const designe = String(directive.chemin).replace(/^\.\//, "");
    if (!fichiers.includes(designe)) {
      return [
        {
          code: "ruby-fichier-absent",
          fichier: "Gemfile",
          quoi: `le Gemfile lit la version de Ruby dans « ${designe} », qui n'entre pas dans le paquet.`,
          pourquoi:
            "Bundler relit ce fichier au démarrage de l'application : sans lui, elle ne démarre pas.",
          changer:
            `ajoutez « ${designe} » à l'application (et ne le faites pas ignorer par git), ` +
            `ou écrivez la version dans le Gemfile : ruby "~> ${rubyDuGuest}".`,
        },
      ];
    }
    return verdict(resoudreLaContrainteRuby(directive, lire(designe)), rubyDuGuest);
  }
  return verdict(resoudreLaContrainteRuby(directive, null), rubyDuGuest);
}

/** L'anomalie d'une contrainte que le Ruby du guest ne satisfait pas, ou rien. */
function verdict(contrainte, rubyDuGuest) {
  if (contrainte === null) return [];
  if (satisfaitLaContrainteRuby(rubyDuGuest, contrainte.contraintes) !== false) return [];
  const declaree = contrainte.contraintes.join(", ");
  const serie = rubyDuGuest.split(".").slice(0, 2).join(".");
  return [
    {
      code: "ruby-incompatible",
      fichier: "Gemfile",
      quoi: `l'application exige Ruby « ${declaree} » (source : ${contrainte.provenance}).`,
      pourquoi:
        `le coffre ne fournit qu'un seul Ruby, ${rubyDuGuest}, compilé dans l'image du guest ; ` +
        "Bundler refuserait de démarrer l'application.",
      changer:
        `relâchez la contrainte pour qu'elle accepte ${rubyDuGuest}, par exemple ` +
        `ruby "~> ${serie}.0" dans le Gemfile, puis vérifiez que l'application fonctionne avec ce Ruby.`,
    },
  ];
}
