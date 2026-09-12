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
  {
    fichier: "tools/figer-vecteurs-volume-v4.mjs",
    motif:
      "il FIGE les vecteurs du format v4 et de sa hiérarchie de clés (#182, ADR 0033), et la " +
      "même clé publique y est une donnée du contrat : elle y est publiée en hexadécimal comme " +
      "clé MAÎTRESSE, et c'est d'elle que le vérificateur redérive les clés de domaine. Il " +
      "n'ouvre aucun volume et n'écrit que sous tests/vectors/.",
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
  {
    fichier: "tools/figer-vecteurs-enveloppe-v2.mjs",
    motif:
      "même chose pour la page v2 de #182 : il publie les identifiants, les nonces et — depuis la " +
      "v2 — les SELS des deux domaines sous la clé « aleas » du document figé. Ce sont des DONNÉES " +
      "du contrat : un relecteur doit pouvoir refaire HKDF avec sa propre bibliothèque, et il lui " +
      "faut pour cela le sel autant que l'info. Il n'ouvre aucune enveloppe et ne DÉVELOPPE aucune " +
      "DEK.",
  },
  {
    fichier: "tools/figer-vecteurs-archive.mjs",
    motif:
      "même chose pour l'ADR 0027 (#149) : il publie les identifiants, les nonces et les " +
      "paramètres publics de l'archive v2 sous la clé « aleas » du document figé. Il n'ouvre " +
      "aucune enveloppe et ne DÉVELOPPE aucune DEK — il scelle sous des nonces publiés, et écrit " +
      "un fichier JSON sous tests/vectors/.",
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

/**
 * Fichiers autorisés à ouvrir un magasin de générations SANS fraîcheur.
 *
 * **Aucun n'est dans `src/`, et c'est la propriété** — la seconde épreuve ci-dessous l'exige
 * séparément, pour qu'une inscription future ne puisse pas l'éroder en silence. Depuis le constat
 * #143, le format du journal qu'une session écrit suit sa source de fraîcheur : une session sans
 * source écrit le journal de #18, donc scelle ses enregistrements sous l'étiquette de domaine d'un
 * BLOC DU VOLUME, donc REPRODUIT #143 pour les octets qu'elle écrit aujourd'hui. Le couplage est
 * décidé et écrit (ADR 0019 amendé) ; ce qui le rend sûr est que le chemin du produit ne le franchit
 * pas — et cela se MESURE ici plutôt que de se lire dans une phrase.
 *
 * `src/vm/crash-machine.mjs` est sorti de cette liste à la faveur du constat : la machine jetable de
 * #15 fournit désormais une source de fraîcheur, si bien que sa matrice mesure de nouveau le chemin
 * de scellement que le produit emprunte. Une revue avait relevé qu'elle ne le mesurait plus.
 *
 * `public/vm/recuperation-worker.mjs` en est sorti à son tour (#196) : #186 a fait passer
 * `FORMAT_VOLUME_COURANT` à 4, et `formatEcritSousFraicheur` REFUSE désormais d'écrire une racine
 * sans fraîcheur pour ce format — la mesure rougissait sur `main` pour la raison exacte que ce
 * fichier vient de nommer. Le banc ouvre maintenant sa propre région et son propre témoin, comme le
 * ferait `opfs-generation-voisins.mjs` pour le produit ; ce que cela ajoute à la durée mesurée est
 * publié dans `docs/quality-attributes.md`, en face du relevé d'avant #186.
 *
 * Ce qui reste est un BANC DE MESURE hors navigateur, pour la même grandeur — `tools/mesurer-
 * generations.mjs` compare trois MÉCANISMES candidats de l'ADR 0014 sur un volume synthétique sans
 * clé de produit ; il n'ouvre jamais ce qu'il écrit et ne sert aucun volume. Lui donner une source de
 * fraîcheur ajouterait à la mesure le hachage de la région, c'est-à-dire déplacerait la grandeur
 * mesurée sans que le relevé le dise, pour une comparaison que #182 n'a jamais requalifiée.
 *
 * @type {{ fichier: string, motif: string }[]}
 */
const OUVREURS_SANS_FRAICHEUR = [
  {
    fichier: "tools/mesurer-generations.mjs",
    motif:
      "banc de MESURE hors navigateur des trois mécanismes candidats de l'ADR 0014, sur un volume " +
      "synthétique en mémoire, sans clé de produit. Il n'ouvre jamais ce qu'il écrit et ne sert " +
      "aucun volume ; lui donner une fraîcheur ajouterait le hachage de la région à une comparaison " +
      "qui porte sur le coût du JOURNAL, pas sur celui de la région.",
  },
];

test("aucun OUVREUR SANS FRAÎCHEUR n'est un module de src/", async () => {
  // La liste ci-dessus peut accueillir un banc ; elle ne doit jamais accueillir un module de `src/`.
  // C'est là que vit le chemin du produit, et un magasin sans fraîcheur y rouvrirait le constat #143
  // pour les octets qu'il écrit. La distinction est portée par une épreuve à part, et non par la
  // prudence de qui ajoute une ligne.
  const dansSrc = OUVREURS_SANS_FRAICHEUR.filter(({ fichier }) => fichier.startsWith("src/"));
  assert.deepEqual(
    dansSrc.map(({ fichier }) => fichier),
    [],
    "Un module de src/ ouvre un magasin sans fraîcheur : il écrit le journal de #18, et scelle ses enregistrements dans l'espace d'identités du volume.",
  );
});

test("seuls des BANCS DE MESURE ouvrent un magasin sans fraîcheur, et ils sont inscrits", async () => {
  // Le motif vise l'ARGUMENT tel qu'il s'écrit à l'appel — `fraicheur: null` —, pas la mention : les
  // modules du format expliquent longuement ce que `fraicheur: null` veut dire dans une racine
  // décodée, et leur interdire le mot rendrait la garde impossible à documenter. C'est pourquoi le
  // motif exige la virgule ou l'accolade qui suit un argument réel.
  const autorises = OUVREURS_SANS_FRAICHEUR.map((entree) => entree.fichier);
  const coupables = await fichiersQuiMentionnent(/\bfraicheur\s*:\s*null\s*[,}]/, autorises);
  assert.deepEqual(
    coupables,
    [],
    "Un magasin sans fraîcheur écrit le journal de #18 : ses enregistrements repassent sous l'étiquette de domaine d'un secteur de volume, et le constat #143 est rouvert pour ce qu'il écrit. Si un banc en a vraiment besoin, il faut un motif écrit.",
  );
});

test("les autorisations d'ouverture sans fraîcheur sont à jour : aucune inscription périmée", async () => {
  for (const { fichier } of OUVREURS_SANS_FRAICHEUR) {
    const contenu = await readFile(path.join(REPO_ROOT, fichier), "utf8");
    assert.match(
      contenu,
      /\bfraicheur\s*:\s*null\s*[,}]/,
      `${fichier} est inscrit comme ouvreur sans fraîcheur, et n'en ouvre plus.`,
    );
  }
});

test("le balayage de la fraîcheur MORD : un appel sans source est relevé", async () => {
  // Un balayage à vide passe toujours. Celui-ci est donc confronté au texte qu'il doit refuser et
  // à celui qu'il doit laisser passer — la PROSE des modules de format, qui parle abondamment de
  // `fraicheur: null` sans jamais ouvrir quoi que ce soit.
  const motif = /\bfraicheur\s*:\s*null\s*[,}]/;
  assert.ok(motif.test("GenerationStore.ouvrir({ volume, fraicheur: null, handle });"));
  assert.ok(motif.test("await ouvrir({\n  fraicheur: null,\n  volume,\n});"));
  assert.ok(
    !motif.test(
      "// le décodeur le dit par `fraicheur: null`, et la racine suivante en portera une",
    ),
    "la PROSE qui cite l'argument ne doit pas être prise pour un appel",
  );
});

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

/**
 * Les APPELANTS de la porte du harnais, hors épreuves — ceux qui obtiennent réellement la clé de
 * TEST ou les clés de déverrouillage de TEST (revue de la PR #166, constat 6).
 *
 * Les gardes précédentes surveillaient la clé LITTÉRALE (`CLE_DE_TEST`), les sources de nonces et
 * d'aléas, et la fraîcheur. Aucune n'énumérait les appelants de `cleDeVolumeDuHarnais` et de
 * `clesDeDeverrouillageDuHarnais` — si bien que #161 a fait franchir cette porte au PREMIER fichier
 * de PRODUIT publié du dépôt sans qu'aucun cliquet ne bouge.
 *
 * **Il n'y en a de nouveau AUCUN de produit, et c'est ce que #162 a livré.** L'inscription de
 * `public/runtime-worker.mjs` portait la date de sa sortie — « Provisoire : #162 le retire » —, et
 * l'épreuve du bas EXIGE désormais que la liste des appelants de produit soit VIDE. Ce n'est pas la
 * même propriété qu'« un seul » : celle-là tolérait qu'il en reste un, celle-ci n'en tolère aucun,
 * et c'est ce que le passage de `SEC-ORIGIN-001` à « exercé sans réserve » suppose.
 *
 * Ce qui reste sont des BANCS et des outils de mesure, qui n'ont jamais prétendu être autre chose.
 *
 * @type {{ fichier: string, produit?: boolean, motif: string }[]}
 */
const APPELANTS_DU_HARNAIS = [
  {
    fichier: "public/vm/cle-du-banc.mjs",
    motif: "distributeur de clés des bancs de `public/vm/`, qui n'ouvre rien lui-même.",
  },
  {
    fichier: "public/vm/enveloppe-worker.mjs",
    motif: "banc de l'enveloppe de clé (#21, ADR 0020).",
  },
  {
    fichier: "public/vm/engagement-worker.mjs",
    motif:
      "banc de l'engagement d'archive (#181, ADR 0034) : il rejoue le mélange de la revue externe sur l'OPFS réel, et il lui faut donc la clé de volume de TEST — celle-là même sous laquelle il scelle l'engagement qu'il vérifiera ensuite.",
  },
  {
    fichier: "public/vm/opfs-runtime-worker.mjs",
    motif: "banc du backend OPFS (#6).",
  },
  {
    fichier: "public/vm/reference-worker-phases-enveloppe.mjs",
    motif: "phases d'enveloppe du banc de reprise (#7).",
  },
  {
    fichier: "public/vm/reference-worker-phases-recuperation.mjs",
    motif: "phases de récupération du banc de reprise (#147, #149).",
  },
  {
    fichier: "tools/mesurer-creation-v3.mjs",
    motif: "banc de MESURE de la création d'un volume v3, hors navigateur.",
  },
  {
    fichier: "tools/vm/mesurer-boot.mjs",
    motif: "banc de MESURE du boot, hors navigateur.",
  },
  {
    fichier: "tools/mesurer-migration-v4.mjs",
    motif:
      "banc de MESURE de la migration v3 → v4 (#182). Il fabrique un volume v3 en mémoire et le " +
      "convertit ; il n'ouvre aucun volume du support et n'écrit nulle part. Le chiffre qu'il rend " +
      "est publié dans docs/quality-attributes.md.",
  },
];

const MOTIF_DU_HARNAIS = /\b(?:cleDeVolumeDuHarnais|clesDeDeverrouillageDuHarnais)\s*\(/;

test("seuls des appelants INSCRITS franchissent la porte du harnais", async () => {
  // `src/vm/cle-de-volume.mjs` est retiré du périmètre par son chemin, comme les définitions de
  // porte plus haut : il DÉFINIT les deux fonctions, et `clesDeDeverrouillageDuHarnais` appelle
  // `cleDeVolumeDuHarnais` pour rejouer la même garde. Il ne peut pas ne pas se nommer.
  const autorises = [
    ...APPELANTS_DU_HARNAIS.map((entree) => entree.fichier),
    ...CHEMINS_DE_PORTE,
    "src/vm/cle-de-volume.mjs",
  ];
  const coupables = await fichiersQuiMentionnent(MOTIF_DU_HARNAIS, autorises);
  assert.deepEqual(
    coupables,
    [],
    "Ces fichiers obtiennent la clé de TEST sans être inscrits. Un chemin de produit qui la " +
      "recevrait chiffrerait sous un secret que tout le monde connaît.",
  );
});

test("les inscriptions à la porte du harnais sont à jour : aucune périmée", async () => {
  const perimees = [];
  for (const entree of APPELANTS_DU_HARNAIS) {
    const contenu = await readFile(path.join(REPO_ROOT, entree.fichier), "utf8");
    if (!MOTIF_DU_HARNAIS.test(contenu)) perimees.push(entree.fichier);
  }
  assert.deepEqual(perimees, [], "Ces inscriptions ne couvrent plus rien : retirez-les.");
});

test("AUCUN appelant de PRODUIT ne franchit la porte du harnais (#162, ADR 0029)", () => {
  // #161 en avait laissé un, inscrit avec la date de sa sortie ; #162 l'a retiré, et la propriété
  // se durcit avec lui : « un seul » devient « aucun ». Un chemin de produit derrière cette porte
  // chiffrerait sous trente-deux octets publics, et c'est ce que `SEC-ORIGIN-001` ne peut pas dire
  // « exercé » en portant.
  const produit = APPELANTS_DU_HARNAIS.filter((entree) => entree.produit === true);
  assert.deepEqual(
    produit.map((entree) => entree.fichier),
    [],
    "Un chemin de PRODUIT derrière cette porte demande un ADR, pas une ligne de liste.",
  );
});

test("les fichiers de PRODUIT de la coquille ne nomment plus la porte du harnais", async () => {
  // La garde du dessus porte sur la LISTE ; celle-ci porte sur les FICHIERS, et les deux ne se
  // remplacent pas : une liste peut être juste et un fichier avoir été oublié dans un balayage
  // trop étroit. Ces trois-là sont le chemin de produit de la coquille, nommés un par un.
  for (const fichier of ["public/main.mjs", "public/runtime-worker.mjs", "public/index.html"]) {
    const contenu = await readFile(path.join(REPO_ROOT, fichier), "utf8");
    assert.ok(
      !MOTIF_DU_HARNAIS.test(contenu),
      `${fichier} appelle de nouveau la porte du harnais : le déverrouillage est un geste de l'utilisateur depuis #162.`,
    );
  }
});
