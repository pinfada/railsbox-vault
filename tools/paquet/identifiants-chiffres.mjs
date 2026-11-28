// Les IDENTIFIANTS CHIFFRÉS de Rails qui arrivent SANS leur clé (#351).
//
// `rails new` écrit `config/credentials.yml.enc` et `config/master.key`, et son `.gitignore` écarte la
// clé : tout dépôt Rails conventionnel versionne donc la moitié chiffrée d'une paire, et rien qui
// l'ouvre. Le refuser obligeait l'application à retirer un fichier de son dépôt pour l'outil.
//
// Ce fichier, sans sa clé, ne contient rien d'utilisable : l'application ne peut pas le déchiffrer, un
// visiteur non plus. Il est donc EXCLU du paquet, et la fabrication le dit. L'exclure évite aussi de
// servir, sous une adresse publique, un chiffré qu'une clé fuitée plus tard ouvrirait.
//
// Une clé PRÉSENTE change tout : la paire s'ouvre, et elle reste REFUSÉE par `secretsPresents`
// (`identite-de-l-application.mjs`), comme avant. Ce module ne retire jamais un fichier dont la clé
// entre dans le paquet.
//
// Deux formes, celles de Rails : la paire maîtresse (`config/credentials.yml.enc` et
// `config/master.key`) et les paires par environnement (`config/credentials/<env>.yml.enc` et
// `config/credentials/<env>.key`).

const MAITRESSE = Object.freeze({
  chiffre: "config/credentials.yml.enc",
  cle: "config/master.key",
});
const PAR_ENVIRONNEMENT = /^config\/credentials\/([^/]+)\.yml\.enc$/;

/** La clé qui ouvre ce fichier chiffré, ou `null` si ce n'en est pas un. */
function cleDe(chemin) {
  if (chemin === MAITRESSE.chiffre) return MAITRESSE.cle;
  const environnement = chemin.match(PAR_ENVIRONNEMENT)?.[1];
  return environnement === undefined ? null : `config/credentials/${environnement}.key`;
}

/**
 * Les fichiers chiffrés de la liste dont la clé N'Y EST PAS : ceux que le paquet exclut.
 *
 * @param {readonly string[]} fichiers chemins relatifs, en barres obliques
 * @returns {string[]}
 */
export function identifiantsChiffresSansCle(fichiers) {
  const presents = new Set(fichiers);
  return fichiers.filter((chemin) => {
    const cle = cleDe(chemin);
    return cle !== null && !presents.has(cle);
  });
}
