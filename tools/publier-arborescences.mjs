// Ce qui est publié sur chacune des DEUX origines de l'ADR 0002, et ce qui ne l'est pas.
//
// `docs/release-policy.md` exige que « les surfaces de mesure soient exclues de l'artefact publié »
// et ajoute que « la liste des chemins publiés est une décision de publication, tranchée par #45 ».
// C'est ce module qui la porte : chaque inclusion nomme sa raison d'être servie, chaque exclusion
// nomme le banc qu'elle retire. Une surface qui n'est ni incluse ni exclue est une SURPRISE, et
// `tests/unit/publication-arborescences.test.mjs` échoue dessus — c'est la seule manière qu'une
// liste écrite à la main ne dérive pas en silence à mesure que le dépôt grandit.
//
// Deux arborescences, jamais une. L'ADR 0002 fait vivre le document applicatif sur une origine
// distincte de la coquille ; les mélanger ici reviendrait à publier la frontière à plat.

import { ORIGINES } from "./publier-en-tetes.mjs";

/**
 * Sources d'un arbre. `depuis` est un chemin du dépôt, `vers` sa place dans l'arbre publié.
 *
 * `optionnel` distingue deux natures d'absence. Les artefacts v86 ne sont pas versionnés
 * (`vendor/v86/artefacts/` est ignoré par git, récupéré par `npm run vm:fetch`) : leur absence dans
 * un clone vierge est normale, elle n'est pas un défaut du dépôt. Elle reste en revanche une
 * publication INCOMPLÈTE, et l'inventaire le dit — voir `runtimeComplet`.
 *
 * @typedef {{ depuis: string, vers: string, role: string, optionnel?: boolean }} Source
 */

/** @type {readonly Source[]} */
export const SOURCES_COQUILLE = Object.freeze([
  Object.freeze({
    depuis: "public/index.html",
    vers: "index.html",
    role: "Document de la coquille de confiance. Servi sous la CSP stricte de l'ADR 0013.",
  }),
  Object.freeze({
    depuis: "public/main.mjs",
    vers: "main.mjs",
    role: "Script de page de la coquille : il crée le Worker runtime et n'a aucun accès au volume.",
  }),
  Object.freeze({
    depuis: "public/runtime-worker.mjs",
    vers: "runtime-worker.mjs",
    role: "Worker runtime. Il détiendra le handle OPFS exclusif et la clé de session (ADR 0002).",
  }),
  Object.freeze({
    depuis: "src/runtime-contract.mjs",
    vers: "src/runtime-contract.mjs",
    role: "Contrat page ↔ Worker, chargé tel quel par les deux (le serveur expose `/src/`).",
  }),
  Object.freeze({
    depuis: "src/vm",
    vers: "src/vm",
    role: "Modules du runtime de volume : blocs, journal, manifeste, export, import, migration.",
  }),
  Object.freeze({
    depuis: "vendor/v86/artefacts",
    vers: "vendor/v86/artefacts",
    optionnel: true,
    role: "Émulateur v86 épinglé par l'ADR 0003. Non versionné : `npm run vm:fetch` le récupère.",
  }),
  Object.freeze({
    depuis: "vendor/v86/MANIFEST.json",
    vers: "vendor/v86/MANIFEST.json",
    role: "Épinglage des artefacts v86 : c'est lui qui rend leur provenance vérifiable.",
  }),
  Object.freeze({
    depuis: "vendor/v86/LICENSE-v86.txt",
    vers: "vendor/v86/LICENSE-v86.txt",
    role: "Licence BSD-2-Clause de v86, exigée par sa redistribution.",
  }),
  Object.freeze({
    depuis: "vendor/v86/LICENSE-bios.txt",
    vers: "vendor/v86/LICENSE-bios.txt",
    role: "Licence LGPL des BIOS redistribués avec l'émulateur.",
  }),
  Object.freeze({
    depuis: "vendor/argon2/argon2.wasm",
    vers: "vendor/argon2/argon2.wasm",
    role:
      "Argon2 de référence compilé en WebAssembly (#22, ADR 0021). Contrairement aux artefacts " +
      "v86 il est VERSIONNÉ : il est chargé à chaque déverrouillage par phrase, et un binaire " +
      "récupéré à la construction ferait dépendre l'ouverture d'un coffre d'un réseau.",
  }),
  Object.freeze({
    depuis: "vendor/argon2/MANIFEST.json",
    vers: "vendor/argon2/MANIFEST.json",
    role: "Épinglage de l'artefact Argon2id : provenance, version et empreinte, vérifiées deux fois.",
  }),
  Object.freeze({
    depuis: "vendor/argon2/LICENSE-argon2-browser.txt",
    vers: "vendor/argon2/LICENSE-argon2-browser.txt",
    role: "Licence MIT de l'empaquetage qui publie le binaire.",
  }),
  Object.freeze({
    depuis: "vendor/argon2/LICENSE-phc-winner-argon2.txt",
    vers: "vendor/argon2/LICENSE-phc-winner-argon2.txt",
    role: "Licence CC0-1.0 / Apache-2.0 de l'implémentation de référence redistribuée.",
  }),
]);

/**
 * Le territoire applicatif ne publie AUCUN artefact de ce dépôt, et ce n'est pas un oubli.
 *
 * L'ADR 0002 : « en production le HTML applicatif est produit par le guest et relayé par le proxy ».
 * Ce que l'origine applicative doit donc porter aujourd'hui, c'est sa CONFIGURATION — les en-têtes
 * de `_headers` — et rien d'autre. Le document ci-dessous est une PLACE TENANTE déclarée : il
 * existe pour que la frontière soit joignable et mesurable (le témoin d'en-têtes encadre quelque
 * chose), il porte sa propre marque, et il n'est le produit de personne.
 *
 * @type {readonly Source[]} */
export const SOURCES_APPLICATION = Object.freeze([]);

/**
 * Contenu de la place tenante de l'origine applicative. Généré, pas copié : rien dans `public/` ne
 * lui correspond, et il ne faut pas qu'un banc finisse par en tenir lieu.
 */
export const PLACE_TENANTE_APPLICATION = `<!doctype html>
<html lang="fr" data-vault-place-tenante="true">
  <head>
    <meta charset="utf-8" />
    <title>Territoire applicatif — RailsBox Vault</title>
  </head>
  <body>
    <main>
      <h1>Territoire applicatif</h1>
      <p id="place-tenante" role="status">
        Cette origine sert les documents rendus par le guest et relayés par le proxy (ADR 0002).
        Aucun artefact de ce dépôt n'y est publié : ce document est une place tenante, présente pour
        que la frontière d'origine soit joignable et que le témoin d'en-têtes ait quelque chose à
        encadrer.
      </p>
    </main>
  </body>
</html>
`;

/**
 * Surfaces de `public/` et de `src/` délibérément RETIRÉES de la publication, avec leur motif.
 *
 * Le préfixe est comparé tel quel au chemin du dépôt, séparateurs `/`. Un préfixe qui ne se termine
 * pas par `/` désigne un fichier.
 */
export const EXCLUSIONS = Object.freeze([
  Object.freeze({
    prefixe: "public/csp/",
    motif:
      "Banc de la frontière CSP (#52, ADR 0013) : il sert des politiques ÉLARGIES pour les mesurer.",
  }),
  Object.freeze({
    prefixe: "public/spike/",
    motif:
      "Bancs des spikes #35 et #41. `public/spike/origin/` contient un document HOSTILE et un " +
      "Service Worker qui intercepte : le publier reviendrait à servir l'adversaire depuis " +
      "l'origine de confiance.",
  }),
  Object.freeze({
    prefixe: "public/vm/",
    motif:
      "Bancs de la machine virtuelle (#4, #6, #14, #16, #73…) : ils ouvrent des volumes, simulent " +
      "des coupures et exposent des commandes que le produit n'expose pas.",
  }),
  Object.freeze({
    prefixe: "public/compat.html",
    motif:
      "Sonde de capacités #2. Elle est EXEMPTÉE de la CSP de la coquille " +
      "(`tools/serve-headers.mjs`) : servie depuis l'origine de confiance, elle y ferait un trou.",
  }),
  Object.freeze({
    prefixe: "public/compat.mjs",
    motif: "Script de page de la sonde de capacités #2.",
  }),
  Object.freeze({
    prefixe: "public/compat-worker.mjs",
    motif: "Worker de la sonde de capacités #2.",
  }),
  Object.freeze({
    prefixe: "src/compat/",
    motif: "Contrat et vecteurs de la sonde de capacités #2 : rien du produit ne les importe.",
  }),
  Object.freeze({
    prefixe: "src/spike/",
    motif:
      "Contrats des bancs de spike, dont la topologie de mesure `origin-topology.mjs` " +
      "(ports 4173/4174, documents hostiles). Ce n'est pas la topologie de production.",
  }),
]);

/** Racines du dépôt dont chaque fichier doit être soit publié, soit explicitement exclu. */
export const RACINES_SOUS_INVENTAIRE = Object.freeze(["public", "src"]);

/** @param {string} chemin chemin du dépôt, séparateurs `/` */
export function motifDExclusion(chemin) {
  const exclusion = EXCLUSIONS.find(
    ({ prefixe }) => chemin === prefixe || chemin.startsWith(prefixe),
  );
  return exclusion ? exclusion.motif : null;
}

/** @param {string} chemin chemin du dépôt, séparateurs `/` */
export function estPublie(chemin) {
  return SOURCES_COQUILLE.some(
    ({ depuis }) => chemin === depuis || chemin.startsWith(`${depuis}/`),
  );
}

/**
 * Les deux arbres, dans l'ordre où ils sont construits. `origine` renvoie à la table d'en-têtes,
 * unique source de vérité de ce qui est servi.
 */
export const ARBRES = Object.freeze([
  Object.freeze({
    nom: "coquille",
    origine: ORIGINES.coquille,
    sources: SOURCES_COQUILLE,
    placeTenante: null,
    role: "Coquille de confiance et runtime (ADR 0002, origine de confiance).",
  }),
  Object.freeze({
    nom: "application",
    origine: ORIGINES.application,
    sources: SOURCES_APPLICATION,
    placeTenante: Object.freeze({ vers: "index.html", contenu: PLACE_TENANTE_APPLICATION }),
    role: "Territoire applicatif (ADR 0002, origine applicative). Aucun artefact du dépôt.",
  }),
]);

/** @param {string} nom */
export function arbre(nom) {
  const trouve = ARBRES.find((candidat) => candidat.nom === nom);
  if (!trouve) {
    const noms = ARBRES.map((candidat) => candidat.nom).join(", ");
    throw new Error(`Arbre inconnu : ${nom}. Valeurs admises : ${noms}.`);
  }
  return trouve;
}
