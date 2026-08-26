import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  HARNAIS_RESILIENCE_JETON,
  HARNAIS_RESILIENCE_VALEUR,
} from "../../src/vm/crash-harness.mjs";

// `SECURITY.md` et `docs/architecture.md` affirment qu'AUCUN chemin du produit n'arme l'injecteur
// d'arrêts de #15. Sans ce fichier, la phrase serait une convention de relecture : il suffirait
// qu'un scénario du Worker runtime se mette à transmettre le jeton pour que l'affirmation devienne
// fausse sans que rien ne le dise.
//
// Le contrôle est donc une INSPECTION DES SOURCES, sur le modèle de
// `tests/unit/isolation-inventaire.test.mjs` : il énumère les fichiers servis et vérifie qui nomme
// quoi. Il ne remplace pas la garde de `crash-harness.mjs` — il vérifie que la garde n'est jamais
// ouverte ailleurs que là où c'est voulu.

const RACINE = fileURLToPath(new URL("../..", import.meta.url));

/** Fichiers servis à un navigateur, et sources qu'ils importent. Les tests sont hors périmètre. */
const RACINES_INSPECTEES = ["src", "public"];
const EXTENSIONS = [".mjs", ".js", ".html"];

/** Le jeton n'est TRANSMIS que par le banc de résilience ; la garde, elle, le DÉFINIT. */
const AUTORISES_JETON = new Set(["src/vm/crash-harness.mjs", "public/vm/resilience-banc.mjs"]);

/** L'armement n'est appelé que par la machine jetable de Node et par le Worker qui coupe. */
const AUTORISES_ARMEMENT = new Set([
  "src/vm/crash-plan.mjs",
  "src/vm/crash-machine.mjs",
  "public/vm/runtime-worker.mjs",
]);

function parcourir(repertoire, trouves = []) {
  for (const entree of readdirSync(repertoire)) {
    const chemin = join(repertoire, entree);
    if (statSync(chemin).isDirectory()) {
      parcourir(chemin, trouves);
    } else if (EXTENSIONS.some((extension) => entree.endsWith(extension))) {
      trouves.push(chemin);
    }
  }
  return trouves;
}

function sourcesServies() {
  const fichiers = [];
  for (const racine of RACINES_INSPECTEES) parcourir(join(RACINE, racine), fichiers);
  return fichiers.map((chemin) => ({
    nom: relative(RACINE, chemin).split(sep).join("/"),
    contenu: readFileSync(chemin, "utf8"),
  }));
}

function nommant(motif) {
  return sourcesServies()
    .filter((fichier) => fichier.contenu.includes(motif))
    .map((fichier) => fichier.nom)
    .sort();
}

test("le jeton du harnais n'est nommé que par la garde et par le banc de résilience", () => {
  const parJeton = nommant(HARNAIS_RESILIENCE_JETON);
  const parIdentifiant = nommant("HARNAIS_RESILIENCE_JETON");
  for (const fichier of [...parJeton, ...parIdentifiant]) {
    assert.ok(
      AUTORISES_JETON.has(fichier),
      `${fichier} nomme le jeton du harnais de résilience : SECURITY.md affirme qu'aucun autre chemin ne le transmet.`,
    );
  }
  // Le banc doit bel et bien le transmettre : un contrôle qui passerait parce que PERSONNE ne le
  // nomme ne vérifierait rien.
  assert.ok(parIdentifiant.includes("public/vm/resilience-banc.mjs"));
});

test("la valeur de la variable d'environnement du harnais n'apparaît que dans la garde", () => {
  const nommants = nommant(HARNAIS_RESILIENCE_VALEUR);
  assert.deepEqual(nommants, ["src/vm/crash-harness.mjs"]);
});

test("l'armement n'est appelé que par la machine jetable et par le Worker qui coupe", () => {
  const nommants = nommant("armerInjecteur");
  // Non vide : un contrôle qui passerait parce que PERSONNE n'arme ne vérifierait rien.
  assert.ok(nommants.length >= 2, `armerInjecteur devrait être nommé, trouvé : ${nommants}`);
  for (const fichier of nommants) {
    assert.ok(
      AUTORISES_ARMEMENT.has(fichier),
      `${fichier} appelle armerInjecteur : aucun autre chemin servi ne doit pouvoir injecter une panne.`,
    );
  }
});

test("la coquille du produit ignore tout de la résilience", () => {
  // `public/vm/banc.mjs` est la page du produit — celle des scénarios `barrier`, `filesystem`,
  // `opfs-persistence` et `opfs-barrier`. Elle ne doit connaître ni le jeton, ni les scénarios de
  // coupure : c'est ce qui rend vraie la phrase « aucun chemin du produit ne les transmet ».
  const banc = readFileSync(join(RACINE, "public", "vm", "banc.mjs"), "utf8");
  assert.equal(banc.includes("HARNAIS_RESILIENCE"), false);
  assert.equal(banc.includes("resilience"), false);
});

test("le Worker runtime n'arme qu'UNE fois, et seulement dans le scénario qui coupe", () => {
  const worker = readFileSync(join(RACINE, "public", "vm", "runtime-worker.mjs"), "utf8");
  const appels = worker.match(/armerInjecteur\(/g) ?? [];
  assert.equal(appels.length, 1, "un second armement dans le Worker runtime doit être remarqué");

  // L'unique appel vit dans `runResilienceCouper`, entre sa déclaration et celle du scénario
  // suivant. Un armement glissé dans `runOpfsBarrier` ou `run` tomberait hors de cette plage.
  const debut = worker.indexOf("async function runResilienceCouper");
  const fin = worker.indexOf("async function runResilienceClasser");
  const position = worker.indexOf("armerInjecteur(");
  assert.ok(debut > 0 && fin > debut, "les deux scénarios de résilience doivent être présents");
  assert.ok(position > debut && position < fin, "l'armement doit vivre dans le scénario qui coupe");
});
