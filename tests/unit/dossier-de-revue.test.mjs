/**
 * Le DOSSIER DE REVUE et ce qui le tient (#20, moitié 1).
 *
 * #20 n'est pas une tranche de code : c'est une revue par un tiers. Le dépôt ne peut pas se relire
 * lui-même, mais il peut rendre la revue POSSIBLE — et surtout empêcher le dossier de pourrir entre
 * le jour où il est écrit et le jour où quelqu'un le lit. Quatre propriétés, et chacune a déjà été
 * fausse quelque part dans ce dépôt :
 *
 *  - **le script de vérification est INDÉPENDANT du produit.** `tools/verifier-vecteurs.mjs` rejoue
 *    les vecteurs avec `node:crypto` seul. S'il importait `src/vm/`, il emprunterait précisément les
 *    encodages qu'il prétend vérifier, et un relecteur externe n'apprendrait rien de son verdict
 *    vert. La garde est une inspection de source, sur le modèle de
 *    `tests/unit/harnais-portes.test.mjs` — dont l'en-tête rappelle qu'« une affirmation que rien ne
 *    relit finit toujours par devenir fausse » ;
 *  - **la spécification est EXHAUSTIVE sur les refus.** Un code de refus que le code produit et que
 *    la spécification ne mentionne pas est un comportement qu'un relecteur rencontrera sans avoir
 *    été prévenu — c'est-à-dire, de son point de vue, un défaut du format ;
 *  - **les renvois aux épreuves DÉSIGNENT des fichiers qui existent.** La spécification renvoie
 *    chaque affirmation au test qui l'exerce ; un chemin périmé transforme cette discipline en
 *    décor ;
 *  - **`SECURITY.md` statue sur chaque invariant.** Un statut sans preuve est une promesse ; une
 *    preuve sans statut est un silence. La table des statuts relie les deux, et chaque invariant
 *    porte l'un ou l'autre, jamais entre les deux.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const SPEC = "docs/format-de-volume-v3.md";
const VERIFICATEUR = "tools/verifier-vecteurs.mjs";
const SECURITY = "SECURITY.md";

/**
 * Empreinte d'un commit RÉEL de ce dépôt, relue de `.git`. Les témoins POSITIFS de la garde du
 * registre en ont besoin ; l'écrire en dur la ferait périmer au premier rebase.
 */
const COMMIT_TEMOIN =
  "`" +
  execFileSync("git", ["rev-parse", "--short=7", "HEAD"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  }).trim() +
  "`";

/** Une empreinte qui n'est PAS un commit : celle que la revue a employée pour montrer le défaut. */
const DEADBEE = "`deadbee`";

/** La PR de cette correction, telle que le registre la cite. Le dossier la reprend. */
const PR_REELLE = "[PR #146](https://github.com/pinfada/railsbox-vault/pull/146)";

/** Une PR que le dossier ne cite nulle part : la garde doit la refuser. */
const PR_INVENTEE = "[PR #999999](https://github.com/pinfada/railsbox-vault/pull/999999)";

/**
 * Les quatre familles de refus que la spécification doit couvrir, code par code : format chiffré,
 * stockage, enveloppe de clé, dérivation des clés de déverrouillage. Les autres familles
 * (`VAULT_MANIFEST_*`, `VAULT_MIGRATION_*`, causes de fraîcheur et de témoin) sont citées dans la
 * spécification sans relever de cette obligation d'exhaustivité — l'épreuve symétrique ci-dessous
 * les contrôle autrement : tout code cité doit exister.
 *
 * Le motif exige que le jeton FINISSE par une lettre ou un chiffre : une mention de famille avec son
 * astérisque (`VAULT_STORAGE_GENERATION_*`) ou une préfixe tronqué n'est pas un code, et le prendre
 * pour tel ferait rougir l'épreuve sur de la prose.
 */
const FAMILLES = /\bVAULT_(?:CRYPTO|STORAGE|ENVELOPPE|DERIVATION)_[A-Z0-9][A-Z0-9_]*[A-Z0-9]\b/g;

/** Tout code de refus du dépôt, toutes familles confondues. Même règle de fin de jeton. */
const TOUS_LES_CODES = /\bVAULT_[A-Z][A-Z0-9_]*[A-Z0-9]\b/g;

/** Où les codes de refus sont DÉFINIS : le code de production, jamais les épreuves. */
const RACINES_DE_CODE = ["src"];

async function lire(relatif) {
  return readFile(path.join(REPO_ROOT, relatif), "utf8");
}

/** Rend une liste triée, sans doublon, de ce qu'un motif trouve dans un texte. */
function codesDe(texte, motif) {
  return [...new Set(texte.match(motif) ?? [])].sort();
}

async function parcourir(repertoire, trouves) {
  for (const entree of await readdir(repertoire, { withFileTypes: true })) {
    const complet = path.join(repertoire, entree.name);
    if (entree.isDirectory()) {
      if (entree.name === "node_modules") continue;
      await parcourir(complet, trouves);
      continue;
    }
    if (entree.name.endsWith(".mjs")) trouves.push(complet);
  }
}

/** Tous les codes de refus que `src/` produit, famille par famille. */
async function codesDuCode(motif) {
  const fichiers = [];
  for (const racine of RACINES_DE_CODE) await parcourir(path.join(REPO_ROOT, racine), fichiers);
  const codes = new Set();
  for (const fichier of fichiers) {
    const contenu = await readFile(fichier, "utf8");
    for (const code of contenu.match(motif) ?? []) codes.add(code);
  }
  return [...codes].sort();
}

/** Chaque fichier cité par la spécification doit exister ; rend le relevé. */
async function fichiersCites(spec, motif) {
  const chemins = [...new Set(spec.match(motif) ?? [])].sort();
  const manquants = [];
  for (const chemin of chemins) {
    try {
      await readFile(path.join(REPO_ROOT, chemin), "utf8");
    } catch {
      manquants.push(chemin);
    }
  }
  return { chemins, manquants };
}

test("le vérificateur de vecteurs n'importe RIEN de src/ : son verdict est indépendant", async () => {
  const source = await lire(VERIFICATEUR);
  // Le motif vise l'IMPORT, pas la mention : l'en-tête du fichier explique justement pourquoi il
  // n'importe pas `src/vm/`, et interdire le mot rendrait la garde impossible à documenter.
  const imports = [...source.matchAll(/^\s*(?:import|export)[^\n]*?from\s+["']([^"']+)["']/gm)].map(
    (occurrence) => occurrence[1],
  );
  const interdits = imports.filter((cible) => !cible.startsWith("node:"));
  assert.deepEqual(
    interdits,
    [],
    `${VERIFICATEUR} doit se contenter de « node: ». Un import du produit lui ferait emprunter les encodages qu'il vérifie.`,
  );
  assert.ok(
    !/\bawait\s+import\s*\(/.test(source) && !/\brequire\s*\(/.test(source),
    `${VERIFICATEUR} ne doit charger aucun module à l'exécution : la garde ne lirait plus rien.`,
  );
});

test("le vérificateur de vecteurs sait tourner, et il est lancé par une seule commande", async () => {
  const source = await lire(VERIFICATEUR);
  assert.match(
    source,
    /node tools\/verifier-vecteurs\.mjs/,
    "le fichier doit publier la commande qu'un relecteur tape, sans quoi le dossier suppose un mode d'emploi qu'il ne donne pas.",
  );
});

test("le vérificateur de vecteurs tourne VERT en une commande, sans le produit", () => {
  // L'inspection de source dit « il n'emprunte rien au produit » ; cette épreuve dit « il rend un
  // verdict vert ». Les deux se complètent : une source propre sur des vecteurs faux resterait verte
  // sans rien vérifier, et des vecteurs justes sous un script cassé ne serviraient à aucun relecteur.
  const sortie = execFileSync(process.execPath, [VERIFICATEUR], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  assert.doesNotMatch(sortie, /ROUGE/, "le vérificateur a rendu un verdict rouge.");
  assert.match(sortie, /vertes?/, "le vérificateur doit compter ses vérifications vertes.");
});

test("CHAQUE code de refus des quatre familles du format apparaît dans la spécification", async () => {
  const spec = await lire(SPEC);
  const attendus = await codesDuCode(FAMILLES);
  assert.ok(attendus.length > 0, "aucun code relevé : la recherche elle-même est cassée.");

  const absents = attendus.filter((code) => !spec.includes(code));
  assert.deepEqual(
    absents,
    [],
    `Ces codes existent dans src/ et ne sont nulle part dans ${SPEC}. Un relecteur les rencontrerait sans avoir été prévenu.`,
  );
});

test("la spécification n'invente aucun code que le produit ne produit pas", async () => {
  const spec = await lire(SPEC);
  const connus = new Set(await codesDuCode(TOUS_LES_CODES));
  // Un code cité par la spécification et absent du code est l'erreur symétrique : elle promet un
  // refus qui n'existe pas. Les codes RETIRÉS par une décision doivent donc être écrits comme tels —
  // nommés dans une phrase qui dit leur retrait —, jamais listés comme s'ils existaient. Le contrôle
  // porte sur TOUTES les familles, pas seulement les quatre de l'exhaustivité : la spécification ne
  // cite aucun code qu'elle n'ait lu quelque part dans src/.
  const cites = codesDe(spec, TOUS_LES_CODES);
  const inventes = cites.filter((code) => !connus.has(code));
  assert.deepEqual(
    inventes,
    [],
    `${SPEC} cite des codes que src/ ne produit pas. Une spécification qui promet un refus inexistant est pire qu'une lacune.`,
  );
});

test("chaque épreuve que la spécification cite existe réellement", async () => {
  const spec = await lire(SPEC);
  const { chemins, manquants } = await fichiersCites(
    spec,
    /\btests\/[\w./-]+\.(?:test|spec)\.mjs\b/g,
  );
  assert.ok(
    chemins.length >= 20,
    `seulement ${chemins.length} renvois d'épreuve : la spécification n'en cite pas assez pour être opposable.`,
  );
  assert.deepEqual(
    manquants,
    [],
    "Ces épreuves sont citées par la spécification et n'existent pas.",
  );
});

test("les NOMS d'épreuve que la spécification cite se retrouvent dans le fichier cité", async () => {
  const spec = await lire(SPEC);
  // Forme retenue dans la spécification : `chemin` › « nom exact du test ». Le nom est cité entre
  // guillemets français pour qu'une recherche textuelle suffise à le retrouver.
  const renvois = [
    ...spec.matchAll(/`(tests\/[\w./-]+\.(?:test|spec)\.mjs)`\s*›\s*«\s*([^»]+?)\s*»/g),
  ];
  assert.ok(
    renvois.length >= 20,
    `seulement ${renvois.length} renvois nommés : trop peu pour que la discipline soit tenue.`,
  );

  // Prettier reflue la prose à cent colonnes : un nom de test peut donc être coupé par un retour à
  // la ligne dans la spécification alors qu'il tient sur une seule ligne dans l'épreuve. Les deux
  // côtés sont normalisés — suites d'espaces réduites à une —, sans quoi la garde rougirait sur une
  // question de mise en page au lieu de rougir sur une question de fond.
  const aplati = (valeur) => valeur.replace(/\s+/g, " ").trim();
  const introuvables = [];
  for (const [, chemin, nom] of renvois) {
    const contenu = aplati(await lire(chemin));
    if (!contenu.includes(aplati(nom))) introuvables.push(`${chemin} › « ${aplati(nom)} »`);
  }
  assert.deepEqual(
    introuvables,
    [],
    "Ces noms de test sont cités par la spécification et ne figurent plus dans le fichier cité.",
  );
});

test("la spécification porte une section « Questions au relecteur » complète", async () => {
  const spec = await lire(SPEC);
  assert.match(
    spec,
    /Questions au relecteur/,
    "les questions ouvertes des ADR doivent être rassemblées dans une section nommée.",
  );
  for (const adr of ["0015", "0016", "0019", "0020", "0021"]) {
    assert.ok(
      spec.includes(adr),
      `la section des questions doit porter les questions de l'ADR ${adr}, avec la position du dépôt.`,
    );
  }
});

test("le dossier remis au relecteur est complet : spec, vecteurs, script, gabarit, registre", async () => {
  const attendus = [
    "docs/format-de-volume-v3.md",
    "docs/revue-externe/gabarit-de-constat.md",
    "docs/revue-externe/registre.md",
    "SECURITY.md",
    "tests/vectors/format-chiffre-v1.json",
    "tests/vectors/disposition-v3.json",
    "tests/vectors/enveloppe-v1.json",
    "tests/vectors/derivation-v1.json",
    "tools/verifier-vecteurs.mjs",
  ];
  const manquants = [];
  for (const chemin of attendus) {
    try {
      await lire(chemin);
    } catch {
      manquants.push(chemin);
    }
  }
  assert.deepEqual(manquants, [], "Le dossier de revue est incomplet.");
});

test("les vecteurs de disposition annoncent le format que le code écrit", async () => {
  const vecteurs = JSON.parse(await lire("tests/vectors/disposition-v3.json"));
  // Cette épreuve relie les vecteurs au CODE plutôt qu'à la spécification : le jour où le format du
  // journal ou la taille de la racine bouge sous une version, elle rougit avant le relecteur.
  const { GENERATION_FORMAT, RACINE_ENTETE_OCTETS } =
    await import("../../src/vm/generation-format.mjs");
  const { SCEAU_OCTETS, FORMAT_VOLUME_V3 } = await import("../../src/vm/volume-chiffre-format.mjs");
  const { TEMOIN_OCTETS } = await import("../../src/vm/generation-fraicheur.mjs");

  assert.equal(vecteurs.specification.formatVolume, FORMAT_VOLUME_V3);
  assert.equal(vecteurs.specification.formatJournal, GENERATION_FORMAT);
  assert.equal(vecteurs.specification.sceauOctets, SCEAU_OCTETS);
  assert.equal(vecteurs.specification.racineEnteteOctets, RACINE_ENTETE_OCTETS);
  assert.equal(vecteurs.specification.temoinOctets, TEMOIN_OCTETS);
});

/**
 * DÉFAUTS d'un registre de constats, ligne par ligne. Pure, pour que l'épreuve puisse la MORDRE.
 *
 * La revue du format persistant a montré que la garde précédente ne faisait pas ce que le registre
 * disait d'elle : elle contrôlait la FORME d'une URL, si bien qu'une ligne entièrement inventée —
 * une issue qui n'existe pas, une empreinte qui n'est pas un commit — passait au vert. Une garde qui
 * ne tient pas sa promesse est pire qu'une garde absente, parce que le document s'appuie dessus par
 * écrit.
 *
 * Ce qui est exigé désormais, et rien de plus — le registre le dit dans les mêmes termes :
 *
 *  - le CONSTAT cite une issue de CE dépôt, et son numéro est repris par la spécification (§ 9.6) ou
 *    par `SECURITY.md`. Le recoupement est INTERNE, et il faut le dire : il ne prouve pas qu'un
 *    tiers a envoyé le constat, il prouve que le registre et le dossier parlent des mêmes numéros ;
 *  - la SÉVÉRITÉ et la DISPOSITION appartiennent au vocabulaire fermé du gabarit ;
 *  - la PREUVE d'une disposition « corrigé » est le NUMÉRO DE PR, et son numéro doit être repris par
 *    le dossier. Ce n'est pas l'empreinte d'un commit, et c'est une correction : ce dépôt fusionne
 *    par « rebase and merge », si bien que GitHub RÉÉCRIT les empreintes en les portant sur `main`.
 *    Une garde adossée à une empreinte rougirait donc dans un clone frais dès la fusion — la
 *    première rédaction de cette garde citait déjà une empreinte périmée par un simple rebasage.
 *    Un numéro de PR, lui, ne bouge pas ;
 *  - une EMPREINTE reste ADMISE en plus, jamais requise : si une ligne en cite une, elle doit être un
 *    commit de ce dépôt. Ce contrôle-là est le seul que rien de rédactionnel ne puisse satisfaire, et
 *    il garde toute sa valeur tant que l'empreinte citée existe encore ;
 *  - chaque ADR cité doit être un fichier de `docs/decisions/`.
 *
 * Tout est HORS LIGNE : `git cat-file` lit le dépôt local, aucune requête réseau n'est faite. Une
 * garde qui appellerait GitHub ne serait pas rejouable par un relecteur hors ligne, et rougirait
 * pour une raison étrangère au registre.
 *
 * @param {string} registre le texte de `docs/revue-externe/registre.md`
 * @param {{ commitExiste: (sha: string) => boolean, adrExiste: (numero: string) => boolean,
 *           numerosDuDossier: Set<string> }} monde
 * @returns {string[]} un défaut par manquement, vide si le registre est opposable
 */
function defautsDuRegistre(registre, { commitExiste, adrExiste, numerosDuDossier, prsDuDossier }) {
  const defauts = [];
  const lignes = registre
    .split("\n")
    .filter((ligne) => ligne.trimStart().startsWith("|") && !/^\s*\|[\s|:-]+\|\s*$/.test(ligne))
    .slice(1);

  for (const ligne of lignes) {
    const cellules = ligne
      .split("|")
      .slice(1, -1)
      .map((cellule) => cellule.trim());
    if (cellules.length !== 4) {
      defauts.push(`${cellules.length} colonne(s) au lieu de 4 : ${ligne.trim()}`);
      continue;
    }
    const [constat, severite, disposition, preuve] = cellules;

    const issue = constat.match(/github\.com\/pinfada\/railsbox-vault\/issues\/(\d+)/);
    if (issue === null) {
      defauts.push(`aucune issue de ce dépôt citée : ${constat}`);
    } else if (!numerosDuDossier.has(issue[1])) {
      defauts.push(`issue #${issue[1]} absente du dossier (spécification § 9.6 ou SECURITY.md)`);
    }

    if (!/^(CRITICAL|HIGH|MEDIUM|LOW)$/.test(severite)) {
      defauts.push(`sévérité hors vocabulaire : « ${severite} »`);
    }
    if (!/^(corrigé|accepté|réfuté)$/.test(disposition)) {
      defauts.push(`disposition hors vocabulaire : « ${disposition} »`);
    }

    const empreintes = [...preuve.matchAll(/`([0-9a-f]{7,40})`/g)].map((trouve) => trouve[1]);
    const adrs = [...preuve.matchAll(/ADR\s*(\d{4})/g)].map((trouve) => trouve[1]);
    const prs = [...preuve.matchAll(/pinfada\/railsbox-vault\/pull\/(\d+)/g)].map(
      (trouve) => trouve[1],
    );
    // Une empreinte est ADMISE, jamais requise — mais si elle est là, elle doit désigner un commit.
    for (const sha of empreintes) {
      if (!commitExiste(sha)) defauts.push(`« ${sha} » n'est pas un commit de ce dépôt`);
    }
    for (const numero of adrs) {
      if (!adrExiste(numero)) defauts.push(`l'ADR ${numero} n'existe pas dans docs/decisions/`);
    }
    for (const numero of prs) {
      if (!prsDuDossier.has(numero)) {
        defauts.push(`PR #${numero} absente du dossier (spécification § 9.6 ou SECURITY.md)`);
      }
    }
    if (empreintes.length === 0 && adrs.length === 0 && prs.length === 0) {
      defauts.push(`preuve absente : « ${preuve} »`);
    }
    if (disposition === "corrigé" && prs.length === 0) {
      defauts.push("une disposition « corrigé » doit citer la PR qui corrige");
    }
  }
  return defauts;
}

/** Vrai si `sha` désigne un COMMIT de ce dépôt. Hors ligne : `git cat-file` lit `.git`. */
function commitExiste(sha) {
  try {
    execFileSync("git", ["cat-file", "-e", `${sha}^{commit}`], {
      cwd: REPO_ROOT,
      stdio: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

/** Vrai si un fichier de `docs/decisions/` porte ce numéro d'ADR. */
function adrExiste(numero) {
  return readdirSync(path.join(REPO_ROOT, "docs", "decisions")).some((nom) =>
    nom.startsWith(`${numero}-`),
  );
}

/**
 * Ce que le DOSSIER — la spécification et `SECURITY.md` — cite comme issues et comme PR.
 *
 * Les deux recoupements sont INTERNES et de même nature : ils établissent que le registre et le
 * dossier parlent des mêmes numéros, pas qu'un tiers a envoyé le constat. Ils sont construits
 * ensemble pour que la règle reste une, et rendus au monde de la garde plutôt que lus par elle : une
 * fonction pure se MORD, une fonction qui lit des fichiers se contourne.
 */
async function dossier() {
  const texte = `${await lire(SPEC)}\n${await lire(SECURITY)}`;
  const numeros = (quoi) =>
    new Set(
      [...texte.matchAll(new RegExp(`pinfada/railsbox-vault/${quoi}/(\\d+)`, "g"))].map(
        (occurrence) => occurrence[1],
      ),
    );
  return {
    commitExiste,
    adrExiste,
    numerosDuDossier: numeros("issues"),
    prsDuDossier: numeros("pull"),
  };
}

test("le registre porte ses quatre colonnes, et chaque ligne est OPPOSABLE", async () => {
  const registre = await lire("docs/revue-externe/registre.md");
  for (const colonne of ["constat", "sévérité", "disposition", "preuve"]) {
    assert.match(
      registre.toLowerCase(),
      new RegExp(`\\|[^\\n]*${colonne}`, "i"),
      `le registre doit porter une colonne « ${colonne} ».`,
    );
  }
  const defauts = defautsDuRegistre(registre, await dossier());
  assert.deepEqual(defauts, [], "Ces lignes du registre ne sont pas opposables.");
});

test("la garde du registre MORD : une ligne inventée est refusée sur chacun de ses défauts", async () => {
  // C'est l'épreuve que la revue du format persistant réclamait, et elle rejoue SA reproduction :
  // une issue qui n'existe pas, une empreinte qui n'est pas un commit — et, depuis que la preuve
  // d'une correction est un numéro de PR, une PR que le dossier ne cite nulle part. La garde
  // d'origine rendait VERT sur cette ligne-là. Sans ce contrôle négatif, rien ne dirait que la
  // nouvelle mord : un balayage à vide passe toujours.
  const monde = await dossier();
  const inventee = [
    "| Constat | Sévérité | Disposition | Preuve |",
    "| ------- | -------- | ----------- | ------ |",
    "| [#999999](https://github.com/pinfada/railsbox-vault/issues/999999) — inventé | CRITICAL | corrigé | " +
      PR_INVENTEE +
      " ; " +
      DEADBEE +
      " |",
  ].join("\n");

  const defauts = defautsDuRegistre(inventee, monde);
  assert.ok(
    defauts.some((defaut) => defaut.includes("deadbee")),
    `l'empreinte inventée doit être refusée : ${JSON.stringify(defauts)}`,
  );
  assert.ok(
    defauts.some((defaut) => defaut.includes("issue #999999")),
    `l'issue inventée doit être refusée : ${JSON.stringify(defauts)}`,
  );
  assert.ok(
    defauts.some((defaut) => defaut.includes("PR #999999")),
    `la PR inventée doit être refusée : ${JSON.stringify(defauts)}`,
  );

  // TÉMOIN POSITIF de la garde elle-même, sur le MÊME chemin de code : le registre réel passe. Une
  // garde qui refuserait tout serait aussi inutile qu'une garde qui accepte tout.
  const reelle = await lire("docs/revue-externe/registre.md");
  assert.deepEqual(defautsDuRegistre(reelle, monde), []);
});

test("la garde du registre refuse une sévérité, une disposition ou une preuve hors règle", async () => {
  // Chaque branche du vocabulaire fermé est mordue une fois : sans cela, une seule d'entre elles
  // pourrait cesser de mordre sans que rien ne le dise.
  const monde = await dossier();
  const entete = [
    "| Constat | Sévérité | Disposition | Preuve |",
    "| ------- | -------- | ----------- | ------ |",
  ];
  const ligne = (severite, disposition, preuve) =>
    defautsDuRegistre(
      [
        ...entete,
        `| [#143](https://github.com/pinfada/railsbox-vault/issues/143) — x | ${severite} | ${disposition} | ${preuve} |`,
      ].join("\n"),
      monde,
    );

  assert.ok(ligne("GRAVE", "corrigé", PR_REELLE).some((d) => d.includes("sévérité")));
  assert.ok(ligne("HIGH", "classé", PR_REELLE).some((d) => d.includes("disposition")));
  assert.ok(ligne("HIGH", "accepté", "aucune").some((d) => d.includes("preuve absente")));
  assert.ok(ligne("HIGH", "accepté", "ADR 9999").some((d) => d.includes("ADR 9999")));
  assert.ok(
    ligne("HIGH", "corrigé", "ADR 0016").some((d) => d.includes("doit citer la PR")),
    "une correction sans PR doit être refusée",
  );
  // Une EMPREINTE est admise en plus d'une PR, jamais à sa place — et elle doit exister.
  assert.deepEqual(ligne("HIGH", "corrigé", `${PR_REELLE} ; ${COMMIT_TEMOIN}`), []);
  assert.ok(
    ligne("HIGH", "corrigé", `${PR_REELLE} ; ${DEADBEE}`).some((d) => d.includes("deadbee")),
    "une empreinte citée doit exister, même quand elle n'est pas requise",
  );
  assert.deepEqual(ligne("HIGH", "corrigé", PR_REELLE), []);
});

test("SECURITY.md statue sur CHAQUE invariant, et la preuve citée existe", async () => {
  const security = await lire(SECURITY);

  // Les sept invariants du dépôt, ni plus ni moins : une ligne manquante est un silence, une ligne
  // en trop est un invariant qui n'existe pas.
  const invariants = [...new Set(security.match(/SEC-[A-Z]+-\d+/g) ?? [])].sort();
  assert.deepEqual(invariants, [
    "SEC-BLOCK-001",
    "SEC-DURABLE-001",
    "SEC-GEN-001",
    "SEC-KEY-001",
    "SEC-ORIGIN-001",
    "SEC-RECOVERY-001",
    "SEC-UPDATE-001",
  ]);

  // La table des statuts : une ligne par invariant, un statut dans un vocabulaire fermé, une preuve.
  const table = security.split("\n").filter((ligne) => /^\|\s*`?SEC-[A-Z]+-\d+/.test(ligne));
  assert.equal(
    table.length,
    invariants.length,
    "chaque invariant doit porter sa ligne de statut dans la table dédiée.",
  );

  const statutsAdmis = /exercé sous réserve|exercé|non exercé/i;
  const manquants = [];
  for (const ligne of table) {
    if (!statutsAdmis.test(ligne)) manquants.push(ligne.trim());
  }
  assert.deepEqual(
    manquants,
    [],
    "Ces lignes de statut n'emploient pas le vocabulaire « exercé / exercé sous réserve / non exercé ».",
  );

  // La preuve citée par la table doit exister : même discipline que pour la spécification.
  const { manquants: epreuvesManquantes } = await fichiersCites(
    table.join("\n"),
    /\btests\/[\w./-]+\.(?:test|spec)\.mjs\b/g,
  );
  assert.deepEqual(
    epreuvesManquantes,
    [],
    "La table des statuts cite des épreuves qui n'existent pas.",
  );
});

test("SECURITY.md cite LITTÉRALEMENT la politique de cache qu'il décrit", async () => {
  // Le constat 4 de la revue de sécurité de #123 : `docs/release-policy.md`, l'ADR 0017 et l'ADR
  // 0023 avaient tous trois été amendés sur la politique de cache, et le document où le dépôt
  // STATUE sur sa posture était le seul resté en arrière — il affirmait encore que `immutable` est
  // refusé, sur un préfixe qui n'existait plus. Le cliquet « statue sur chaque invariant » ne mord
  // pas sur la VÉRACITÉ du récit ; celui-ci le fait, sur les deux valeurs qui sont réellement
  // servies, en les faisant venir de la source de vérité plutôt que d'une copie.
  const security = await lire(SECURITY);
  const { NATURES_DARTEFACT, POLITIQUES_DE_CACHE, POLITIQUE_DABSENCE, PREFIXE_EPINGLAGE_V86 } =
    await import("../../tools/serve-headers.mjs");

  const attendus = [
    [PREFIXE_EPINGLAGE_V86, "le préfixe sous lequel le cache long est servi"],
    [
      POLITIQUES_DE_CACHE[NATURES_DARTEFACT.epinglageV86],
      "la politique de cache des artefacts v86",
    ],
    [POLITIQUE_DABSENCE, "la politique servie pour une ABSENCE"],
  ];
  for (const [valeur, quoi] of attendus) {
    assert.ok(
      security.includes(valeur),
      `SECURITY.md ne cite pas « ${valeur} » (${quoi}) : son récit de cache a divergé de ce que ` +
        "`tools/serve-headers.mjs` sert réellement.",
    );
  }
});
