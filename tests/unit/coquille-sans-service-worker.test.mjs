/**
 * AUCUN SERVICE WORKER sur l'origine de CONFIANCE (#163, ADR 0030, décision 4).
 *
 * La question était ouverte : l'ADR 0010 la posait nommément — « #24 doit dire si un Service Worker
 * injectant COOP est admissible DANS la frontière » —, parce qu'un hébergeur sans en-têtes (GitHub
 * Pages, écarté par l'ADR 0017) laisserait cette porte-là comme seule façon de servir la politique.
 *
 * **Elle est fermée, et le refus est de fond.** Un Service Worker sur l'origine de confiance
 * interposerait du code PRIVILÉGIÉ entre l'hébergeur et la coquille : il verrait passer chaque
 * requête de la coquille, survivrait à la fermeture de l'onglet, et se mettrait à jour par un chemin
 * distinct de celui du reste. La frontière de l'ADR 0002 sépare deux ORIGINES ; elle ne dit rien
 * d'un tiers installé DANS l'une d'elles, et c'est exactement ce que ce refus empêche d'introduire.
 *
 * Ce que cette épreuve mesure est donc une ABSENCE, et une absence ne se relit pas — elle se
 * surveille. C'est la forme de `tests/unit/harnais-portes.test.mjs`, dont l'en-tête rappelle qu'« une
 * affirmation que rien ne relit finit toujours par devenir fausse ».
 *
 * Ce qu'elle NE dit PAS : que les Service Workers sont interdits partout. Le territoire APPLICATIF
 * en porte un dans le banc du spike #35 (`public/coquille-epreuve/hostile-sw.mjs`), et c'est son
 * droit : ce que le guest sert lui appartient (ADR 0002).
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/**
 * Ce que la coquille de produit SERT depuis l'origine de confiance : sa page, son Worker de
 * confiance, son Worker de dérivation, et les modules de `src/coquille/` qu'ils importent.
 *
 * `public/vm/` et `public/spike/` n'y sont pas : ce sont des bancs, et le banc du spike #35 installe
 * délibérément un Service Worker HOSTILE pour mesurer ce qu'il obtient. Les confondre ferait rougir
 * cette épreuve sur la mesure qui justifie le refus.
 */
const CHEMINS_DE_LA_COQUILLE = [
  "public/main.mjs",
  "public/runtime-worker.mjs",
  "public/derivation-worker.mjs",
  "public/index.html",
  "src/coquille",
];

/** Les appels par lesquels un Service Worker entre dans une origine. Il n'y en a pas d'autre. */
const PORTES = [
  "serviceWorker.register",
  "navigator.serviceWorker",
  "ServiceWorkerContainer",
  "ServiceWorkerRegistration",
];

/** Liste les fichiers d'un chemin, qu'il soit un fichier ou un répertoire. */
async function fichiersDe(relatif) {
  const absolu = path.join(REPO_ROOT, relatif);
  let entrees;
  try {
    entrees = await readdir(absolu, { withFileTypes: true });
  } catch {
    return [relatif];
  }
  const trouves = [];
  for (const entree of entrees) {
    if (entree.isDirectory()) continue;
    trouves.push(path.posix.join(relatif, entree.name));
  }
  return trouves;
}

test("aucun module de la coquille n'installe de Service Worker sur l'origine de confiance", async () => {
  const fautifs = [];
  for (const racine of CHEMINS_DE_LA_COQUILLE) {
    for (const chemin of await fichiersDe(racine)) {
      const contenu = await readFile(path.join(REPO_ROOT, chemin), "utf8");
      for (const porte of PORTES) {
        // Le mot peut figurer dans un COMMENTAIRE — celui-ci en écrit un, l'ADR 0030 aussi. Ce qui
        // est refusé est un APPEL, et la distinction se fait sur la ligne : une ligne de commentaire
        // commence par `//`, `*` ou `<!--` une fois désindentée.
        const lignes = contenu.split("\n").filter((ligne) => ligne.includes(porte));
        const appels = lignes.filter((ligne) => !/^\s*(\/\/|\*|<!--|#)/.test(ligne));
        if (appels.length > 0) fautifs.push(`${chemin} › ${porte}`);
      }
    }
  }
  assert.deepEqual(
    fautifs,
    [],
    "Un Service Worker sur l'origine de confiance est INADMISSIBLE (ADR 0030, décision 4).",
  );
});

test("le balayage MORD : il reconnaît un enregistrement qu'on lui présente", async () => {
  // Un balayage à vide passe toujours. Celui-ci est confronté au texte qu'il doit refuser, et au
  // même texte en commentaire — sans quoi rien ne dirait qu'il sait faire la différence.
  const appel = 'navigator.serviceWorker.register("/sw.mjs");';
  const commentaire = "// navigator.serviceWorker.register est refusé ici (ADR 0030).";
  const estUnAppel = (ligne) => !/^\s*(\/\/|\*|<!--|#)/.test(ligne);
  assert.equal(estUnAppel(appel), true);
  assert.equal(estUnAppel(commentaire), false);
  assert.equal(estUnAppel(` * ${appel}`), false);
});

test("le refus est ÉCRIT là où un relecteur le cherchera", async () => {
  // Une décision qui ne vit que dans une épreuve est une décision qu'on redécouvre. Elle est dans
  // l'ADR de la tranche et dans `SECURITY.md`, et cette ligne-ci refuse qu'elle en disparaisse.
  const adr = await readFile(
    path.join(REPO_ROOT, "docs/decisions/0030-cycle-de-vie-assemble-dans-la-coquille.md"),
    "utf8",
  );
  assert.match(adr, /Service Worker/);
  assert.match(adr, /INADMISSIBLE|inadmissible/);
  const securite = await readFile(path.join(REPO_ROOT, "SECURITY.md"), "utf8");
  assert.match(securite, /Service Worker/);
});
