// IDENTITÉ d'une application à empaqueter, et REFUS de ses secrets (#236, ADR 0041).
//
// Une application extérieure au dépôt n'a ni `vault-invariant.json` ni place dans `sources.json` :
// elle dit qui elle est, ou l'appelant le dit pour elle. Trois sources, dans cet ordre :
//
//   1. les options de la ligne de commande (`--id`, `--version`) — le dernier mot appartient à qui
//      fabrique ;
//   2. `vault-app.json` à la racine de l'application — ce que l'application déclare d'elle-même ;
//   3. `vault-invariant.json`, pour l'application de RÉFÉRENCE seule, par continuité : son identité
//      vit là depuis #5, et la déplacer romprait le manifeste d'image.
//
// ## Pourquoi le secret est refusé ICI, et pas seulement dans le Dockerfile
//
// `verify-pinning.mjs` refuse déjà un secret dans l'arbre du dépôt. Une application EXTÉRIEURE
// n'est pas dans l'arbre du dépôt : elle arrive par un contexte de construction nommé, et sa
// `config/master.key` entrerait dans une image publiée sous une adresse immuable, que tout visiteur
// télécharge. Le `secret_key_base` d'un paquet se DÉRIVE d'une chaîne publique, comme celui de la
// référence — c'est la règle, et c'est elle que ce module fait respecter avant le premier
// `docker build`.

/**
 * MOTIFS de fichiers qu'un paquet ne peut pas contenir (#236, revue de sécurité, constat 2).
 *
 * C'était une liste FERMÉE de trois chemins, et `config/credentials/staging.key` la traversait : une
 * application Rails a une clé PAR ENVIRONNEMENT, et rien n'oblige à les nommer `production`. Une
 * énumération de chemins ne peut pas suivre ce que les applications inventent ; des motifs, si.
 *
 * Chaque entrée porte son motif, pour que le refus explique ce qu'il refuse plutôt que d'opposer une
 * liste.
 */
export const SECRETS_REFUSES = Object.freeze([
  { motif: /^config\/master\.key$/i, quoi: "la clé maîtresse de Rails" },
  { motif: /^config\/credentials\.yml\.enc$/i, quoi: "les identifiants chiffrés de Rails" },
  {
    motif: /^config\/credentials\/[^/]+\.(key|yml\.enc)$/i,
    quoi: "une clé ou des identifiants chiffrés d'environnement",
  },
  { motif: /(^|\/)\.env($|\.)/i, quoi: "un fichier d'environnement" },
  { motif: /\.(pem|p12|pfx|jks|keystore)$/i, quoi: "une clé ou un magasin de certificats" },
  { motif: /(^|\/)id_(rsa|dsa|ecdsa|ed25519)$/i, quoi: "une clé SSH privée" },
  {
    // Sous `config/`, un nom qui porte « secret » ou « key » est traité comme un secret : c'est là
    // que Rails range ce qui ouvre l'application. Le reste de l'arbre n'est pas visé — `KeyboardController`
    // n'est pas une clé, et un refus qui crie partout n'est plus lu.
    motif:
      /^config\/(?:.*\/)?[^/]*(secret|_key|key_|\bkey)[^/]*\.(key|pem|yml|yaml|json|txt|rb|enc)$/i,
    quoi: "un fichier de configuration dont le nom annonce un secret",
  },
]);

/** Les motifs, en clair, pour un message de refus qui dit ce qu'il refuse. */
export const SECRETS_REFUSES_LIBELLES = Object.freeze(SECRETS_REFUSES.map(({ quoi }) => quoi));

/** Identifiant d'application : minuscules, chiffres et tirets. Il entre dans un nom de fichier. */
const IDENTIFIANT = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** Version : trois nombres, éventuellement suivis d'un qualificatif. Elle entre aussi dans un nom. */
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/** Ce dont la référence dérive son `secret_key_base`, et ce qu'un paquet muet hérite par défaut. */
export const DERIVATION_PAR_DEFAUT =
  "dérivé d'une chaîne publique documentée par l'application (jamais de master.key ni de credentials.yml.enc)";

/**
 * Chemins de secret PRÉSENTS dans une liste de fichiers de la source.
 *
 * La comparaison se fait sur des chemins normalisés en barres obliques : la source peut être lue
 * sous Windows, et `config\master.key` est le même fichier que `config/master.key`.
 *
 * @param {string[]} fichiers
 * @returns {string[]}
 */
export function secretsPresents(fichiers) {
  return fichiers
    .map((fichier) => String(fichier).replaceAll("\\", "/").replace(/^\.\//, ""))
    .filter((chemin) => SECRETS_REFUSES.some(({ motif }) => motif.test(chemin)));
}

/**
 * RÉSOUT l'identité de l'application, champ par champ, dans l'ordre des trois sources.
 *
 * Champ par champ, et non source par source : `--version` seul sur une application qui déclare son
 * `id` doit fonctionner, sans obliger à redire ce que le fichier dit déjà.
 *
 * @param {{ options?: { id?: string, version?: string },
 *           vaultApp?: Record<string, any> | null,
 *           invariant?: Record<string, any> | null }} sources
 * @returns {{ id: string, version: string, secretKeyBase: { derivation: string } }}
 */
export function identiteDeLApplication({ options = {}, vaultApp = null, invariant = null }) {
  const id = options.id ?? vaultApp?.application?.id ?? invariant?.application?.id;
  const version =
    options.version ?? vaultApp?.application?.version ?? invariant?.application?.version;

  if (!id || !version) {
    throw new Error(
      "Identité de l'application introuvable : passer --id et --version, ou poser un vault-app.json " +
        "à la racine de la source ({ application: { id, version } }).",
    );
  }
  if (!IDENTIFIANT.test(id)) {
    throw new Error(
      `Identifiant d'application refusé : « ${id} ». Minuscules, chiffres et tirets, 2 à 64 caractères.`,
    );
  }
  if (!VERSION.test(version)) {
    throw new Error(`Version d'application refusée : « ${version} ». Trois nombres, ex. 1.0.0.`);
  }
  return {
    id,
    version,
    secretKeyBase: {
      derivation: vaultApp?.secretKeyBase?.derivation ?? DERIVATION_PAR_DEFAUT,
    },
  };
}
