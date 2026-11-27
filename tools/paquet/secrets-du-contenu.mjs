// Les SECRETS lus dans le CONTENU des fichiers qui entrent dans un paquet (#342).
//
// ## Provenance
//
// Les deux signaux sont repris de `pinfada/railsbox`, `tools/detect/env-secrets.mjs`
// (`ENV_SECRET_NAME_HINTS`, `TOKEN_VALUE_PATTERNS`, `secretNameHint`, `looksLikeSecretValue`). Même
// propriétaire, licence MIT des deux côtés. Les listes et les motifs sont inchangés ; les noms sont
// passés en français.
//
//   · le NOM de la clé annonce un secret (`…SECRET…`, `…TOKEN…`, `…PASSWORD…`) ;
//   · la VALEUR a la forme d'un jeton émis par un service connu, quel que soit le nom.
//
// RailsBox les applique au bloc `env:` de `railsbox.yml`. Le coffre les applique aux LIGNES des
// fichiers qui entrent dans le paquet : `identite-de-l-application.mjs` ne regarde que les NOMS de
// fichiers, et un mot de passe dans `config/database.yml` ou un jeton dans `db/seeds.rb` entraient
// dans une image servie publiquement, que tout visiteur télécharge et monte hors ligne.
//
// ## Où chaque signal s'applique
//
//  - la FORME DE JETON s'applique PARTOUT : un `sk_live_…` n'est pas moins publié dans `app/` que
//    dans `config/` ;
//  - le NOM de clé ne s'applique que là où Rails range ce qui ouvre l'application — `config/` et les
//    graines (`db/seeds.rb`, `db/seeds/`). Ailleurs, `validates :password` ou un mot de passe de
//    test ne sont pas des secrets, et un refus qui crie partout n'est plus lu (même règle que le
//    motif « nom qui annonce un secret » de `identite-de-l-application.mjs`).
//
// Une valeur qui n'est PAS dans le fichier n'est pas un secret : `<%= ENV["…"] %>`, `#{…}`, une
// valeur vide ou nulle passent.
//
// ## La dérogation NOMME son fichier et sa clé
//
// Comme `env_assume_public:` de RailsBox : une graine de démonstration porte légitimement un
// `password: "demo1234"`. `vault-app.json` le dit, une entrée par couple fichier et clé :
// `"secretsAssumesPublics": [{ "fichier": "db/seeds.rb", "cle": "password" }]`. Ni joker ni
// dérogation globale. Une valeur à FORME DE JETON n'est jamais couverte : elle n'a pas l'air
// d'une démonstration, et la dérogation ne porte que sur le nom.
//
// La valeur suspecte n'est JAMAIS recopiée dans le rapport : il part dans des journaux.

/**
 * Fragments de noms qui annoncent un secret (RailsBox, `ENV_SECRET_NAME_HINTS`). Comparés en
 * MAJUSCULES et en sous-chaîne. « KEY » seul serait trop large (PUBLIC_KEY, KEYBOARD).
 */
export const INDICES_DE_NOM_SECRET = Object.freeze([
  "MASTER_KEY",
  "SECRET",
  "PASSWORD",
  "TOKEN",
  "API_KEY",
  "PRIVATE_KEY",
  "CREDENTIALS",
  "ACCESS_KEY",
  "ENCRYPTION_KEY",
  "SIGNING_KEY",
]);

/**
 * Préfixes de jetons émis par des services répandus (RailsBox, `TOKEN_VALUE_PATTERNS`). Chaque
 * motif est ancré : une valeur qui COMMENCE par « sk- » suivi de vingt caractères est un jeton
 * jusqu'à preuve du contraire.
 */
const MOTIFS_DE_JETON = Object.freeze([
  /^gh[pousr]_[A-Za-z0-9]{20,}$/,
  /^github_pat_[A-Za-z0-9_]{20,}$/,
  /^[sr]k_(live|test)_[A-Za-z0-9]{10,}$/,
  /^sk-[A-Za-z0-9_-]{20,}$/,
  /^(AKIA|ASIA)[0-9A-Z]{16}$/,
  /^xox[abprs]-[A-Za-z0-9-]{10,}$/,
  /^glpat-[A-Za-z0-9_-]{15,}$/,
  /^AIza[A-Za-z0-9_-]{30,}$/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
]);

/** Une clé privée PEM se reconnaît à sa ligne d'ouverture, où qu'elle soit dans la ligne. */
const CLE_PRIVEE_PEM = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;

const LITTERAL_ENTRE_GUILLEMETS = /"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'/g;
const AFFECTATION_YAML = /^\s*(?:-\s+)?["']?([A-Za-z0-9_.-]+)["']?\s*:(?:\s+(.*))?$/;
const AFFECTATION_RUBY = /([A-Za-z_][A-Za-z0-9_]*)["']?\s*(?:=>|=(?![=~>])|:)\s*(["'])(.*?)\2/g;

const CODE = "secret-dans-le-contenu";
const POURQUOI =
  "le paquet est servi publiquement : tout visiteur peut télécharger l'image et lire ce fichier.";

/**
 * Le nom de cette clé annonce-t-il un secret ?
 * @param {string} nom
 * @returns {string|null} fragment reconnu, ou `null`
 */
export function indiceDeNomSecret(nom) {
  const majuscules = String(nom).toUpperCase();
  return INDICES_DE_NOM_SECRET.find((indice) => majuscules.includes(indice)) ?? null;
}

/**
 * La valeur porte-t-elle le préfixe d'un jeton connu ?
 * @param {unknown} valeur
 */
export function ressembleAUnJeton(valeur) {
  const texte = typeof valeur === "string" ? valeur.trim() : "";
  if (texte === "") return false;
  return MOTIFS_DE_JETON.some((motif) => motif.test(texte));
}

/** Vrai si le NOM de clé s'applique à ce fichier : `config/` et les graines. */
function zoneDeConfiguration(chemin) {
  return chemin.startsWith("config/") || chemin === "db/seeds.rb" || chemin.startsWith("db/seeds/");
}

/** Vrai si le fichier est lu comme du YAML (clé: valeur, sans guillemets obligatoires). */
function estYaml(chemin) {
  return /\.ya?ml$/i.test(chemin);
}

/**
 * Vrai si la valeur est ÉCRITE dans le fichier : ni vide, ni nulle, ni lue ailleurs (`ENV`, ERB,
 * interpolation), ni une construction YAML (ancre, alias, étiquette, bloc).
 */
function valeurEcrite(brute) {
  const valeur = String(brute ?? "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .trim();
  if (valeur === "" || /^(~|null|nil)$/i.test(valeur)) return false;
  if (/^[&*!|>]/.test(valeur)) return false;
  return !/<%|#\{|\bENV\b/.test(valeur);
}

/** La valeur d'une ligne YAML, sans son commentaire de fin. */
function valeurYaml(brute) {
  return String(brute ?? "").replace(/(^|\s+)#.*$/, "");
}

/** Les valeurs candidates d'une ligne : ses littéraux entre guillemets, et sa valeur YAML. */
function valeursCandidates(ligne, yaml) {
  const valeurs = [...ligne.matchAll(LITTERAL_ENTRE_GUILLEMETS)].map((t) => t[1] ?? t[2]);
  if (yaml) {
    const affectation = AFFECTATION_YAML.exec(ligne);
    if (affectation?.[2] !== undefined) valeurs.push(valeurYaml(affectation[2]).trim());
  }
  return valeurs;
}

/** Les clés de la ligne dont le nom annonce un secret ET dont la valeur est écrite. */
function clesSecretes(ligne, yaml) {
  if (yaml) {
    const affectation = AFFECTATION_YAML.exec(ligne);
    if (affectation === null || affectation[2] === undefined) return [];
    const [, cle, valeur] = affectation;
    return indiceDeNomSecret(cle) !== null && valeurEcrite(valeurYaml(valeur)) ? [cle] : [];
  }
  return [...ligne.matchAll(AFFECTATION_RUBY)]
    .filter(([, cle, , valeur]) => indiceDeNomSecret(cle) !== null && valeurEcrite(valeur))
    .map(([, cle]) => cle);
}

/** Vrai si `{ fichier, cle }` est NOMMÉ par la dérogation — comparaison exacte, aucun joker. */
function assumeePublique(assumesPublics, fichier, cle) {
  return (Array.isArray(assumesPublics) ? assumesPublics : []).some(
    (entree) => entree?.fichier === fichier && entree?.cle === cle,
  );
}

function constatDeJeton(fichier, ligne) {
  return {
    code: CODE,
    fichier,
    ligne,
    quoi: `ligne ${ligne} : une valeur a la forme d'un jeton ou d'une clé privée émis par un service connu.`,
    pourquoi: POURQUOI,
    changer:
      "retirez cette valeur du fichier. Si le jeton est réel, faites-le révoquer par le service qui " +
      "l'a émis : il a peut-être déjà circulé. Aucune dérogation ne couvre un jeton.",
  };
}

function constatDeNom(fichier, ligne, cle) {
  return {
    code: CODE,
    fichier,
    ligne,
    cle,
    quoi: `ligne ${ligne} : la clé « ${cle} » porte une valeur écrite en clair.`,
    pourquoi: POURQUOI,
    changer:
      `retirez la valeur, ou faites-la lire dans l'environnement (<%= ENV["…"] %>) ; une base ` +
      "SQLite n'a pas de mot de passe. Si c'est une valeur de démonstration sans portée réelle, " +
      "déclarez-la publique dans vault-app.json : " +
      `"secretsAssumesPublics": [{ "fichier": "${fichier}", "cle": "${cle}" }].`,
  };
}

/** Le constat d'UNE ligne, ou `null` : le jeton d'abord, il n'est jamais dérogé. */
function constatDeLaLigne({ chemin, ligne, rang, yaml, nomCompte, assumesPublics }) {
  if (CLE_PRIVEE_PEM.test(ligne) || valeursCandidates(ligne, yaml).some(ressembleAUnJeton)) {
    return constatDeJeton(chemin, rang);
  }
  if (!nomCompte) return null;
  const cle = clesSecretes(ligne, yaml).find((c) => !assumeePublique(assumesPublics, chemin, c));
  return cle === undefined ? null : constatDeNom(chemin, rang, cle);
}

/**
 * Les secrets ÉCRITS dans le contenu d'un fichier, un constat par ligne au plus.
 *
 * @param {{ chemin: string, contenu: string,
 *           assumesPublics?: ReadonlyArray<{ fichier: string, cle: string }> }} entree
 * @returns {Array<{ code: string, fichier: string, ligne: number, cle?: string, quoi: string,
 *                   pourquoi: string, changer: string }>}
 */
export function secretsDuContenu({ chemin, contenu, assumesPublics = [] }) {
  const relatif = String(chemin).replaceAll("\\", "/");
  const yaml = estYaml(relatif);
  const nomCompte = zoneDeConfiguration(relatif);
  const constats = [];
  String(contenu)
    .split(/\r?\n/)
    .forEach((ligne, index) => {
      const constat = constatDeLaLigne({
        chemin: relatif,
        ligne,
        rang: index + 1,
        yaml,
        nomCompte,
        assumesPublics,
      });
      if (constat !== null) constats.push(constat);
    });
  return constats;
}

/**
 * Vrai si ces octets sont du TEXTE : aucun octet nul dans les 8 premiers Kio (le critère de git).
 * Une image ou une police n'est pas lue ligne à ligne.
 * @param {Uint8Array} octets
 */
export function estDuTexte(octets) {
  return !octets.subarray(0, 8192).includes(0);
}
