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

/** L'issue d'un constat OUVERT de la revue externe, telle que le registre la cite en preuve. */
const ISSUE_OUVERTE_REELLE = "[#181](https://github.com/pinfada/railsbox-vault/issues/181)";

/** Une issue que le dossier ne cite nulle part : une dette ne s'adosse pas à un numéro inventé. */
const ISSUE_INVENTEE = "[#999999](https://github.com/pinfada/railsbox-vault/issues/999999)";

/**
 * Les SEPT familles de refus que la spécification doit couvrir, code par code : format chiffré,
 * stockage, enveloppe de clé, dérivation des clés de déverrouillage, ARCHIVE et IMPORT depuis #149,
 * et la COQUILLE depuis #161. Les autres familles (`VAULT_MANIFEST_*`, `VAULT_MIGRATION_*`, causes de fraîcheur et de
 * témoin) sont citées dans la spécification sans relever de cette obligation d'exhaustivité —
 * l'épreuve symétrique ci-dessous les contrôle autrement : tout code cité doit exister.
 *
 * **ARCHIVE et IMPORT y entrent parce que #149 les a fait grandir sans que rien ne le remarque.**
 * La tranche a ajouté trois codes — deux à l'archive, un à la restauration — et le § 10 de la
 * spécification est resté en arrière : aucun cliquet ne mordait sur ces deux familles, si bien que
 * la table décrivait encore « une archive v1 » pendant que le produit en lisait deux. C'est le
 * constat de la revue de format de la PR #160, et l'élargissement est sa correction : la
 * spécification autonome de #20 doit décrire TOUS les refus qu'un relecteur externe rencontrera.
 *
 * **COQUILLE y entre pour la raison symétrique** : #161 pose la première famille de refus qui ne
 * parle pas du support mais de la FRONTIÈRE — ce que la coquille de produit refuse au document
 * applicatif. Un relecteur qui ouvre la coquille les rencontre avant même d'ouvrir un volume ; les
 * laisser hors du cliquet aurait reproduit exactement le défaut que #149 avait payé.
 *
 * Le motif exige que le jeton FINISSE par une lettre ou un chiffre : une mention de famille avec son
 * astérisque (`VAULT_STORAGE_GENERATION_*`) ou une préfixe tronqué n'est pas un code, et le prendre
 * pour tel ferait rougir l'épreuve sur de la prose.
 */
const FAMILLES =
  /\bVAULT_(?:CRYPTO|STORAGE|ENVELOPPE|DERIVATION|ARCHIVE|IMPORT|COQUILLE)_[A-Z0-9][A-Z0-9_]*[A-Z0-9]\b/g;

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

test("CHAQUE code de refus des SEPT familles du format apparaît dans la spécification", async () => {
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
  // Les marqueurs de CITATION en début de ligne (« > ») sont retirés avant l'extraction : un renvoi
  // posé dans un encadré d'amendement — la forme que prend chaque révision datée de ce document —
  // est reflué par Prettier comme le reste de la prose, et le « > » de la ligne suivante tombait
  // alors AU MILIEU du nom cité. La garde rougissait sur une mise en page, pas sur un fond.
  const spec = (await lire(SPEC)).replace(/^[ \t]*>[ \t]?/gm, "");
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
    "tests/vectors/archive-v3.json",
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
 *  - « OUVERT » est entré dans ce vocabulaire le 10 septembre 2026, avec la revue externe : ses deux
 *    constats sont reçus et NON corrigés, et aucun des trois mots d'origine ne dit cela. « corrigé »
 *    et « réfuté » seraient faux, « accepté » signifierait que le dépôt garde le défaut — c'est
 *    l'inverse du contrat de #20, qui exige la correction d'un CRITICAL et d'un HIGH avant sa
 *    fermeture. Une ligne « ouvert » est une DETTE NOMMÉE, pas une disposition, et sa preuve
 *    opposable est l'ISSUE elle-même : elle porte le constat, sa reproduction et sa DoR. La garde
 *    l'exige, et exige que le dossier reprenne ce numéro comme pour toute autre ligne ;
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

    // Une sévérité RÉVISÉE porte les deux termes, « proposée → retenue » — le registre l'exige en
    // toutes lettres depuis l'origine, et la garde ne le vérifiait pas : elle refusait la forme, si
    // bien qu'une révision devait s'écrire ailleurs que dans sa colonne. Les DEUX côtés de la
    // flèche restent dans le vocabulaire fermé ; c'est un contrôle de plus, pas un de moins.
    if (!/^(CRITICAL|HIGH|MEDIUM|LOW)( → (CRITICAL|HIGH|MEDIUM|LOW))?$/.test(severite)) {
      defauts.push(`sévérité hors vocabulaire : « ${severite} »`);
    }
    if (!/^(corrigé|accepté|réfuté|ouvert)$/.test(disposition)) {
      defauts.push(`disposition hors vocabulaire : « ${disposition} »`);
    }

    const empreintes = [...preuve.matchAll(/`([0-9a-f]{7,40})`/g)].map((trouve) => trouve[1]);
    const adrs = [...preuve.matchAll(/ADR\s*(\d{4})/g)].map((trouve) => trouve[1]);
    const prs = [...preuve.matchAll(/pinfada\/railsbox-vault\/pull\/(\d+)/g)].map(
      (trouve) => trouve[1],
    );
    // La preuve d'une dette est l'ISSUE, et elle est soumise au même recoupement que le constat :
    // un numéro que le dossier ne reprend nulle part ne serait pas opposable.
    const issuesDeLaPreuve = [...preuve.matchAll(/pinfada\/railsbox-vault\/issues\/(\d+)/g)].map(
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
    for (const numero of issuesDeLaPreuve) {
      if (!numerosDuDossier.has(numero)) {
        defauts.push(`issue #${numero} absente du dossier (spécification § 9.6 ou SECURITY.md)`);
      }
    }
    const preuveOuverte = disposition === "ouvert" && issuesDeLaPreuve.length > 0;
    if (empreintes.length === 0 && adrs.length === 0 && prs.length === 0 && !preuveOuverte) {
      defauts.push(`preuve absente : « ${preuve} »`);
    }
    if (disposition === "corrigé" && prs.length === 0) {
      defauts.push("une disposition « corrigé » doit citer la PR qui corrige");
    }
    // Une dette dont la preuve serait un ADR ou une PR ne serait pas une dette : elle dirait qu'un
    // travail a eu lieu. Ce qu'une ligne « ouvert » doit citer est l'issue qui porte le constat.
    if (disposition === "ouvert" && issuesDeLaPreuve.length === 0) {
      defauts.push("une disposition « ouvert » doit citer l'issue qui porte le constat");
    }
    // Symétrique de la précédente, et le registre l'écrivait déjà sans que rien ne le tienne :
    // « accepté » exige un amendement daté de l'ADR concerné. Une acceptation adossée à une seule
    // empreinte de commit ne dit pas ce que le dépôt a décidé, ni où c'est écrit.
    if (disposition === "accepté" && adrs.length === 0) {
      defauts.push("une disposition « accepté » doit citer l'ADR amendé");
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
    ligne("HIGH", "accepté", PR_REELLE).some((d) => d.includes("doit citer l'ADR")),
    "une acceptation sans ADR amendé doit être refusée",
  );
  // Une sévérité RÉVISÉE : la forme est admise, et les DEUX côtés restent dans le vocabulaire.
  assert.deepEqual(ligne("HIGH → MEDIUM", "accepté", "ADR 0019"), []);
  assert.ok(
    ligne("HIGH → ÉNORME", "accepté", "ADR 0019").some((d) => d.includes("sévérité")),
    "une révision vers un mot hors vocabulaire doit être refusée",
  );
  assert.ok(
    ligne("GRAVE → MEDIUM", "accepté", "ADR 0019").some((d) => d.includes("sévérité")),
    "une révision DEPUIS un mot hors vocabulaire doit l'être aussi",
  );
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

  // « OUVERT » — la dette nommée de la revue externe du 10 septembre 2026. Sa preuve est l'ISSUE,
  // et rien d'autre ne la remplace : ni un ADR — qui dirait qu'une décision a fermé le constat —,
  // ni une PR — qui dirait qu'un code l'a corrigé. Les deux mordent ici, dans les deux sens.
  assert.deepEqual(
    ligne("CRITICAL", "ouvert", ISSUE_OUVERTE_REELLE),
    [],
    "une dette qui cite son issue doit passer",
  );
  assert.ok(
    ligne("CRITICAL", "ouvert", "ADR 0033").some((d) => d.includes("doit citer l'issue")),
    "une dette adossée à un ADR seul doit être refusée",
  );
  assert.ok(
    ligne("CRITICAL", "ouvert", PR_REELLE).some((d) => d.includes("doit citer l'issue")),
    "une dette adossée à une PR seule doit être refusée",
  );
  assert.ok(
    ligne("CRITICAL", "ouvert", ISSUE_INVENTEE).some((d) => d.includes("issue #999999")),
    "une dette adossée à une issue absente du dossier doit être refusée",
  );
});

/**
 * Les invariants dont la PROSE porte une réserve, et ce que la table doit alors dire.
 *
 * Un invariant est décrit deux fois dans `SECURITY.md` : par un paragraphe qui l'explique, et par
 * une ligne de table qui le statue. Rien ne les reliait, et la revue de sécurité de la PR #167 a
 * trouvé les deux en désaccord sur `SEC-RECOVERY-001` — le paragraphe disait « EXERCÉ depuis #162 »,
 * sa fin gardait « aucun chemin de production ne l'OFFRE encore », et la table disait « exercé sous
 * réserve ». Trois affirmations, deux contraires, sur la même ligne du dossier remis à un relecteur.
 *
 * La garde est TEXTUELLE et volontairement étroite : elle ne juge pas la prose, elle refuse qu'un
 * paragraphe garde une formule de RÉSERVE pendant que la table déclare l'invariant exercé tout
 * court. Une réserve qui reste doit se lire des deux côtés, ou disparaître des deux.
 */
const FORMULES_DE_RESERVE = Object.freeze([
  /aucun chemin de production ne l['’]OFFRE encore/i,
  /la réserve qui reste/i,
]);

test("SECURITY.md ne déclare jamais « exercé » un invariant dont la prose garde une réserve", async () => {
  const security = await lire(SECURITY);
  const lignes = security.split("\n");
  const table = lignes.filter((ligne) => /^\|\s*`?SEC-[A-Z]+-\d+/.test(ligne));

  // Le TÉMOIN de CE test est la TABLE : sans lignes lues, il serait vert parce qu'il ne regarde
  // rien. Le témoin des FORMULES, lui, est le test suivant — et il fallait le séparer, parce que la
  // correction de #162 a retiré du dossier les deux formules qu'il aurait cherchées ici : une garde
  // dont le témoin disparaît avec le défaut qu'elle surveille n'est pas une garde.
  assert.ok(table.length >= 7, "aucune ligne de statut lue : la garde ne mesure rien.");

  const contradictions = [];
  for (const ligne of table) {
    const [nom] = ligne.match(/SEC-[A-Z]+-\d+/) ?? [];
    if (nom === undefined) continue;
    const exerceSansReserve = /\*\*exercé\*\*/.test(ligne) && !/sous réserve/.test(ligne);
    if (!exerceSansReserve) continue;
    // Le paragraphe de CET invariant : il commence à sa puce et court jusqu'à la puce suivante.
    const depart = lignes.findIndex((autre) => autre.startsWith("- `" + nom + "`"));
    if (depart < 0) continue;
    let fin = depart + 1;
    while (fin < lignes.length && !/^- `SEC-[A-Z]+-\d+`/.test(lignes[fin])) fin += 1;
    const paragraphe = lignes.slice(depart, fin).join("\n");
    // Une réserve NOMMÉE pour dire qu'elle ne s'applique plus n'est pas une réserve. Sans cette
    // exception, le dossier ne pourrait plus raconter ce qu'il a fermé.
    const cite = FORMULES_DE_RESERVE.some((formule) => formule.test(paragraphe));
    const levee = /est LEVÉE|sont LEVÉES|n'est plus une réserve/.test(paragraphe);
    if (cite && !levee) contradictions.push(nom);
  }
  assert.deepEqual(
    contradictions,
    [],
    "Ces invariants sont déclarés « exercé » par la table pendant que leur paragraphe garde une réserve. Un relecteur lirait deux statuts contraires pour la même chose.",
  );
});

test("le cliquet de cohérence MORD : une table « exercé » sur une prose réservée est relevée", () => {
  // Un cliquet à vide passe toujours. Celui-ci est confronté au dossier tel qu'il était avant la
  // correction — paragraphe réservé, table exercée —, puis au dossier corrigé.
  const reserve = "aucun chemin de production ne l'OFFRE encore à un utilisateur";
  assert.ok(FORMULES_DE_RESERVE.some((formule) => formule.test(reserve)));
  assert.ok(
    !FORMULES_DE_RESERVE.some((formule) => formule.test("la réserve est LEVÉE depuis #162")),
  );
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

  // La table des statuts : au moins une ligne par invariant, un statut dans un vocabulaire fermé,
  // une preuve.
  //
  // « Au moins », et non « exactement », depuis #161. Un invariant peut être exercé contre DEUX
  // choses qui ne sont pas la même — `SEC-ORIGIN-001` l'est contre la coquille du spike et contre
  // celle du produit —, et un statut unique aurait alors couvert une coquille que personne n'avait
  // écrite. Ce que la garde exige en échange est plus fort qu'un compte : quand un invariant porte
  // plusieurs lignes, chacune doit se QUALIFIER, faute de quoi deux statuts contradictoires
  // vaudraient pour la même chose.
  const table = security.split("\n").filter((ligne) => /^\|\s*`?SEC-[A-Z]+-\d+/.test(ligne));
  const lignesPar = new Map(invariants.map((nom) => [nom, []]));
  for (const ligne of table) {
    const [nom] = ligne.match(/SEC-[A-Z]+-\d+/) ?? [];
    lignesPar.get(nom)?.push(ligne);
  }
  assert.deepEqual(
    invariants.filter((nom) => lignesPar.get(nom).length === 0),
    [],
    "chaque invariant doit porter sa ligne de statut dans la table dédiée.",
  );

  // Une qualification est ce qui suit le nom de l'invariant dans la première cellule, avant le
  // séparateur : « — coquille du SPIKE », « — coquille de PRODUIT ».
  const nonQualifies = [];
  for (const [nom, lignes] of lignesPar) {
    if (lignes.length < 2) continue;
    for (const ligne of lignes) {
      const [, premiereCellule] = ligne.split("|");
      if (!/—\s*\S/.test(premiereCellule)) nonQualifies.push(`${nom} : ${ligne.trim()}`);
    }
  }
  assert.deepEqual(
    nonQualifies,
    [],
    "Un invariant à plusieurs lignes doit dire, sur chacune, CONTRE QUOI il est exercé.",
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

test("le README indexe TOUS les ADR de docs/decisions/, sans trou ni ligne inventée", async () => {
  // La revue de format de #155 a relevé que l'ADR 0025 manquait à l'index, et surtout qu'aucune
  // épreuve ne relisait cet index : il pouvait donc se périmer indéfiniment. Le contrôle porte dans
  // les DEUX sens, comme celui des codes de refus — un ADR non indexé est invisible, un lien vers un
  // ADR qui n'existe pas est pire.
  const readme = await lire("README.md");
  const surDisque = readdirSync(path.join(REPO_ROOT, "docs", "decisions"))
    .filter((nom) => /^\d{4}-.*\.md$/.test(nom))
    .sort();
  const indexes = [...readme.matchAll(/docs\/decisions\/(\d{4}-[\w-]+\.md)/g)]
    .map((occurrence) => occurrence[1])
    .sort();
  assert.deepEqual(
    surDisque.filter((nom) => !indexes.includes(nom)),
    [],
    "Ces ADR existent et ne sont pas dans l'index du README.",
  );
  assert.deepEqual(
    indexes.filter((nom) => !surDisque.includes(nom)),
    [],
    "Le README indexe des ADR qui n'existent pas.",
  );
});

test("SECURITY.md dit ce que le moyen de récupération COUVRE et ce qu'il ne couvre pas", async () => {
  // #147 : une liste à DEUX entrées, au même niveau. Sans ce cliquet, la seconde moitié — celle qui
  // dit ce que le produit ne promet pas — est exactement celle qui se perd à la relecture suivante,
  // parce que personne n'aime la relire. Le contrôle porte sur la PRÉSENCE des DIX entrées et sur
  // le vocabulaire qui les sépare, à la manière dont la table des statuts est relue plus haut.
  //
  // Elles étaient huit jusqu'à #148 : les deux dernières entrées « non couvert » sont nées de la
  // révocation d'urgence, et elles disent ce qui reste hors de portée du produit une fois la page
  // libre effacée — le SUPPORT, et le fait qu'une révocation ne rechiffre rien.
  //
  // Elles sont ONZE depuis #149 (ADR 0027) : l'archive emporte la capacité d'ouvrir, ce qui ajoute
  // une entrée « couvert » — et ce qui CHANGE la nature du cliquet. Jusque-là, il exigeait que la
  // réserve « l'archive n'emporte PAS `<volume>.cles` » soit écrite ; désormais il exige que le
  // service ET SON PRIX le soient, dans la même section. Un service rendu dont le coût n'est pas
  // relu est exactement ce qui se met à paraître gratuit.
  const security = await lire(SECURITY);
  const section = security.slice(
    security.indexOf("### Ce que le moyen de récupération COUVRE"),
    security.indexOf("Chaque invariant devra être relié"),
  );
  assert.ok(section.length > 0, "la section « ce que le moyen couvre » a disparu de SECURITY.md.");

  for (const [quoi, entrees] of [
    [
      "couvert",
      [
        "Passkey perdue",
        "Appareil perdu",
        "Phrase oubliée",
        "Emplacement compromis",
        "Une archive porte l'enveloppe de récupération",
      ],
    ],
    [
      "non couvert",
      [
        "Tous les moyens perdus",
        "Archive perdue",
        "Copie du code prise avant la révocation",
        "Retour arrière COMPLET du support",
        "Ce que le SUPPORT garde de l'emplacement retiré",
        "révoquer ne RECHIFFRE PAS",
      ],
    ],
  ]) {
    for (const entree of entrees) {
      assert.ok(section.includes(entree), `l'entrée « ${entree} » (${quoi}) manque à la liste.`);
    }
  }

  // Le vocabulaire qui rend la seconde liste opposable : sans séquestre, et DÉLIBÉRÉ. Une liste qui
  // dirait seulement « pas encore » promettrait un travail à venir là où il y a une décision.
  assert.match(section, /\*\*Couvert\.\*\*/);
  assert.match(section, /\*\*Non couvert\.\*\*/);
  assert.match(section, /aucun séquestre/i, "l'absence de séquestre doit être écrite.");
  assert.match(section, /délibéré/i, "elle doit être présentée comme une DÉCISION, pas un manque.");
  // #149 : ce que l'archive emporte, et ce que cela coûte. Les deux dans la même section, sans quoi
  // le service se relirait seul, comme un gain sans contrepartie.
  assert.match(
    section,
    /l'archive seule n'ouvre rien/i,
    "ce que l'archive emporte doit être dit avec sa borne : elle seule n'ouvre rien.",
  );
  assert.match(
    section,
    /jamais\*\* un emplacement `phrase` ni `webauthn-prf`/,
    "ce que l'archive n'emporte JAMAIS doit être écrit : une phrase secrète ne voyage pas.",
  );
  assert.match(
    section,
    /cible hors ligne/i,
    "le prix du transport — une archive volée offre au code une cible hors ligne — doit être écrit.",
  );
  // #148 : ce que l'effacement de la page libre promet, et ce qu'il ne promet pas. Sans ce cliquet,
  // « aucun octet ne subsiste » se relirait comme une promesse sur le disque, qu'aucune ligne de ce
  // dépôt ne peut tenir.
  assert.match(
    section,
    /fait, non garanti/i,
    "l'effacement de la page libre porte sur le FICHIER, pas sur le support : le dire est la moitié de la promesse.",
  );
  assert.match(
    section,
    /rotation de la clé de volume/i,
    "la seule parade à une copie déjà prise doit être nommée, même hors périmètre.",
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
