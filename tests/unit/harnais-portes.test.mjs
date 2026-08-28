/**
 * Les PORTES DU HARNAIS, et qui les franchit (#18, revue de #102).
 *
 * Deux paramètres du format chiffré sont dangereux au point qu'un seul appelant égaré suffirait à
 * défaire ce que le chiffrement promet :
 *
 *  - **la clé de TEST** (`CLE_DE_TEST`) — trente-deux octets publics sans entropie. Un chemin du
 *    produit qui la passerait à `openOpfsVolume` chiffrerait le volume sous un secret que tout le
 *    monde connaît, sans que rien ne le signale ;
 *  - **la source de nonces** (`tirerNonce`) — deux blocs scellés sous une même clé, une même
 *    identité logique et un même nonce donnent c1 ⊕ c2 = p1 ⊕ p2, et le clair devient récupérable
 *    sans qu'aucune étiquette n'ait été forgée. `vm-source-de-nonce.test.mjs` l'exécute.
 *
 * Les deux ont une garde à l'exécution. Une garde à l'exécution dit « pas par accident » ; elle ne
 * dit pas « personne ». C'est ce fichier qui le dit, et il le MESURE : la revue de #102 a trouvé
 * dans `docs/testing.md` la phrase « aucun module de src/ ne l'importe » alors que deux fichiers le
 * faisaient. Une affirmation que rien ne relit finit toujours par devenir fausse.
 *
 * Ajouter une ligne à l'une des listes ci-dessous demande un motif qui tienne devant une revue.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

/** Tout le code du dépôt, épreuves comprises : une porte se franchit d'où qu'on vienne. */
const RACINES = ["src", "public", "tools", "tests"];

/**
 * Fichiers autorisés à mentionner `CLE_DE_TEST`, hors `tests/`.
 *
 * La liste ne contient QUE le module qui la définit. `src/vm/crash-machine.mjs` en est sorti — il
 * reçoit désormais la clé de l'épreuve qui le fait tourner — et `tools/mesurer-creation-v3.mjs`
 * aussi, qui passe par `cleDeVolumeDuHarnais` sous variable d'environnement.
 *
 * @type {{ fichier: string, motif: string }[]}
 */
const PORTEURS_DE_LA_CLE = [
  {
    fichier: "src/vm/cle-de-volume.mjs",
    motif: "il la DÉFINIT, et c'est aussi lui qui porte la garde du harnais.",
  },
  {
    fichier: "tools/figer-vecteurs-scellement.mjs",
    motif:
      "il FIGE les vecteurs de l'ADR 0015, dont la clé publique est une donnée du contrat : les " +
      "mêmes trente-deux octets y sont d'ailleurs publiés en hexadécimal. Il n'ouvre aucun volume.",
  },
];

/**
 * Fichiers autorisés à REMPLACER la source de nonces, hors `tests/`.
 *
 * Elle est vide, et c'est la propriété : aucun chemin du produit ne fournit de source de nonces.
 * Le module qui définit la porte n'y figure pas non plus — il est retiré du périmètre par son
 * chemin, puisqu'il ne peut pas ne pas nommer son propre paramètre.
 *
 * @type {{ fichier: string, motif: string }[]}
 */
const PORTEURS_DU_NONCE = [];

/** Le module qui définit la porte des nonces : il la nomme forcément. */
const DEFINITION_DU_NONCE = "src/vm/scellement.mjs";

/** Relève tous les modules du périmètre. */
async function modules() {
  const trouves = [];
  for (const racine of RACINES) {
    await parcourir(path.join(REPO_ROOT, racine), trouves);
  }
  return trouves.map((absolu) => path.relative(REPO_ROOT, absolu).split(path.sep).join("/")).sort();
}

async function parcourir(repertoire, trouves) {
  const entrees = await readdir(repertoire, { withFileTypes: true });
  for (const entree of entrees) {
    const complet = path.join(repertoire, entree.name);
    if (entree.isDirectory()) {
      if (entree.name === "node_modules") continue;
      await parcourir(complet, trouves);
      continue;
    }
    if (entree.name.endsWith(".mjs") || entree.name.endsWith(".js")) trouves.push(complet);
  }
}

/** Vrai si le fichier est une ÉPREUVE : les épreuves ont le droit de franchir les deux portes. */
function estUneEpreuve(fichier) {
  return fichier.startsWith("tests/");
}

async function fichiersQuiMentionnent(motif, exclus) {
  const coupables = [];
  for (const fichier of await modules()) {
    if (estUneEpreuve(fichier) || exclus.includes(fichier)) continue;
    const contenu = await readFile(path.join(REPO_ROOT, fichier), "utf8");
    if (motif.test(contenu)) coupables.push(fichier);
  }
  return coupables;
}

test("aucun module hors des épreuves ne tient la clé de TEST", async () => {
  const autorises = PORTEURS_DE_LA_CLE.map((entree) => entree.fichier);
  const coupables = await fichiersQuiMentionnent(/\bCLE_DE_TEST\b/, autorises);
  assert.deepEqual(
    coupables,
    [],
    "Ces fichiers tiennent une clé en dur. Passez-la depuis l'appelant, ou inscrivez-les ci-dessus avec leur motif.",
  );
});

test("les autorisations de la clé sont à jour : aucune inscription périmée", async () => {
  for (const { fichier } of PORTEURS_DE_LA_CLE) {
    const contenu = await readFile(path.join(REPO_ROOT, fichier), "utf8");
    assert.match(
      contenu,
      /\bCLE_DE_TEST\b/,
      `${fichier} est inscrit comme porteur de la clé de TEST, et ne la mentionne plus.`,
    );
  }
});

test("aucun module hors des épreuves ne remplace la source de nonces", async () => {
  const autorises = [DEFINITION_DU_NONCE, ...PORTEURS_DU_NONCE.map((entree) => entree.fichier)];
  // `tirerNonce:` en position d'argument, et le jeton qui l'autorise : l'un ne va pas sans l'autre
  // depuis la revue de #102, donc chercher les deux ne relève pas deux fois la même chose.
  const coupables = await fichiersQuiMentionnent(/\btirerNonce\s*:|HARNAIS_NONCE_JETON/, autorises);
  assert.deepEqual(
    coupables,
    [],
    "Un nonce répété rend le clair récupérable. Si un appelant en a vraiment besoin, il faut un motif écrit.",
  );
});

test("le modèle de référence n'est pas franchi non plus : sa porte à lui reste aux épreuves", async () => {
  // `format-chiffre/modele-reference.mjs` accepte des nonces sous le nom `nonces` (ADR 0015 : « pour
  // permettre à une implémentation de REPRODUIRE ces vecteurs »). Le produit passe par
  // `scellement.mjs`, qui est gardé ; personne d'autre n'a de raison d'appeler le modèle avec des
  // nonces choisis.
  const coupables = await fichiersQuiMentionnent(/\bnonces\s*:/, [
    DEFINITION_DU_NONCE,
    "src/vm/format-chiffre/modele-reference.mjs",
  ]);
  assert.deepEqual(coupables, []);
});
