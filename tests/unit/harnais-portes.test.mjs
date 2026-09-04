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
 *    sans qu'aucune étiquette n'ait été forgée. `vm-source-de-nonce.test.mjs` l'exécute ;
 *  - **la source d'aléas de l'ENVELOPPE** (`HARNAIS_ALEAS_JETON`, #21) — le même défaut, appliqué à
 *    la clé de volume elle-même : deux DEK enveloppées sous une même clé de déverrouillage, un même
 *    identifiant d'emplacement et un même nonce livrent le ou-exclusif des deux clés de volume.
 *
 * ## Définir une porte, ce n'est pas la franchir
 *
 * Trois modules de `src/` NOMMENT forcément le paramètre qu'ils exposent : ils sont la porte. Ils
 * sont retirés du périmètre par leur chemin, et inscrits dans `DEFINITIONS_DE_PORTE` avec leur
 * motif. Ce qui reste mesuré — et ce qui compte — est qu'AUCUN APPELANT ne fournisse de source :
 * `PORTEURS_DU_NONCE` est vide, et c'est la propriété.
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
  {
    fichier: "tools/figer-vecteurs-disposition.mjs",
    motif:
      "il FIGE les vecteurs de DISPOSITION du dossier de revue (#20, ADR 0016 et 0019) : la même " +
      "clé publique que les vecteurs de l'ADR 0015, sans quoi les deux documents ne parleraient " +
      "pas du même volume. Il n'ouvre aucun volume et n'écrit que sous tests/vectors/.",
  },
  {
    fichier: "tools/figer-vecteurs-instantane.mjs",
    motif:
      "il FIGE les vecteurs de l'ADR 0024, et pour la raison exacte du précédent : la clé " +
      "publique est une donnée du contrat, publiée en hexadécimal dans le document figé. Il " +
      "n'ouvre aucun volume, ne déverrouille aucune enveloppe et n'écrit que sous tests/vectors/.",
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

/**
 * Les modules qui DÉFINISSENT une porte d'aléas : ils ne peuvent pas ne pas nommer leur propre
 * paramètre. Ils sont retirés du périmètre par leur chemin, jamais par une tolérance de motif.
 *
 * @type {{ fichier: string, motif: string }[]}
 */
const DEFINITIONS_DE_PORTE = [
  {
    fichier: "src/vm/scellement.mjs",
    motif: "il définit la porte de nonces du format chiffré (#18), et son jeton.",
  },
  {
    fichier: "src/vm/enveloppe-de-cle.mjs",
    motif:
      "il définit la porte d'aléas de l'enveloppe (#21) — nonce et identifiant d'emplacement — et " +
      "son jeton. Sans elle, le chemin de production ne pourrait pas être confronté aux vecteurs " +
      "figés de l'ADR 0020, c'est-à-dire qu'il n'aurait aucun critère.",
  },
  {
    fichier: "src/vm/enveloppe/modele-reference.mjs",
    motif:
      "spécification exécutable de l'ADR 0020 : ses variantes « sous nonce » existent pour figer " +
      "les vecteurs et pour permettre au produit de les reproduire, exactement comme celles du " +
      "modèle de l'ADR 0015.",
  },
];

const CHEMINS_DE_PORTE = DEFINITIONS_DE_PORTE.map((entree) => entree.fichier);

/**
 * Les outils qui FIGENT des vecteurs. Ils nomment les valeurs tirées parce qu'ils les PUBLIENT :
 * un vecteur reproductible est, par définition, un vecteur dont l'aléa est écrit noir sur blanc.
 * Ils n'ouvrent aucun volume et ne déverrouillent aucune enveloppe — ils écrivent un fichier JSON
 * sous `tests/vectors/`, et c'est tout ce qu'ils savent faire.
 *
 * @type {{ fichier: string, motif: string }[]}
 */
const FIGEURS_DE_VECTEURS = [
  {
    fichier: "tools/figer-vecteurs-enveloppe.mjs",
    motif:
      "il publie les identifiants et les nonces des vecteurs de l'ADR 0020 sous les clés « aleas » " +
      "et « nonces » du document figé. Ce sont des DONNÉES du contrat, pas une source injectée.",
  },
];

const CHEMINS_DE_FIGEUR = FIGEURS_DE_VECTEURS.map((entree) => entree.fichier);

/** Le jeton d'aléas de l'enveloppe (#21). Sa valeur exacte vit dans le module qui le définit. */
const JETON_ALEAS = "HARNAIS_ALEAS_JETON";

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
  const autorises = [...CHEMINS_DE_PORTE, ...PORTEURS_DU_NONCE.map((entree) => entree.fichier)];
  // `tirerNonce:` en position d'argument, et le jeton qui l'autorise : l'un ne va pas sans l'autre
  // depuis la revue de #102, donc chercher les deux ne relève pas deux fois la même chose.
  const coupables = await fichiersQuiMentionnent(/\btirerNonce\s*:|HARNAIS_NONCE_JETON/, autorises);
  assert.deepEqual(
    coupables,
    [],
    "Un nonce répété rend le clair récupérable. Si un appelant en a vraiment besoin, il faut un motif écrit.",
  );
});

test("aucun module hors des épreuves ne remplace la source d'aléas de l'enveloppe (#21)", async () => {
  // Même garde que celle des nonces, sur la porte que #21 ajoute. Le sinistre qu'elle couvre est
  // d'un cran plus grave : ce n'est pas le clair d'un bloc qui fuit, c'est la clé du volume entier.
  const coupables = await fichiersQuiMentionnent(new RegExp(`\\b${JETON_ALEAS}\\b|\\baleas\\s*:`), [
    ...CHEMINS_DE_PORTE,
    ...CHEMINS_DE_FIGEUR,
  ]);
  assert.deepEqual(
    coupables,
    [],
    "Un aléa scripté enveloppe deux clés de volume sous le même nonce. Un motif écrit est exigé.",
  );
});

test("les définitions de porte sont à jour : aucune inscription périmée", async () => {
  for (const { fichier } of [...DEFINITIONS_DE_PORTE, ...FIGEURS_DE_VECTEURS]) {
    const contenu = await readFile(path.join(REPO_ROOT, fichier), "utf8");
    assert.match(
      contenu,
      /\btirerNonce\s*:|HARNAIS_NONCE_JETON|HARNAIS_ALEAS_JETON|\baleas\s*:/,
      `${fichier} est inscrit comme définition de porte, et n'en définit plus.`,
    );
  }
});

test("le modèle de référence n'est pas franchi non plus : sa porte à lui reste aux épreuves", async () => {
  // `format-chiffre/modele-reference.mjs` accepte des nonces sous le nom `nonces` (ADR 0015 : « pour
  // permettre à une implémentation de REPRODUIRE ces vecteurs »). Le produit passe par
  // `scellement.mjs`, qui est gardé ; personne d'autre n'a de raison d'appeler le modèle avec des
  // nonces choisis.
  const coupables = await fichiersQuiMentionnent(/\bnonces\s*:/, [
    ...CHEMINS_DE_PORTE,
    ...CHEMINS_DE_FIGEUR,
    "src/vm/format-chiffre/modele-reference.mjs",
  ]);
  assert.deepEqual(coupables, []);
});
