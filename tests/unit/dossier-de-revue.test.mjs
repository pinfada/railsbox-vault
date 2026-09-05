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
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

const SPEC = "docs/format-de-volume-v3.md";
const VERIFICATEUR = "tools/verifier-vecteurs.mjs";
const SECURITY = "SECURITY.md";

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

test("le registre porte ses quatre colonnes, et il est VIDE tant qu'aucun constat n'est reçu", async () => {
  const registre = await lire("docs/revue-externe/registre.md");
  for (const colonne of ["constat", "sévérité", "disposition", "commit"]) {
    assert.match(
      registre.toLowerCase(),
      new RegExp(`\\|[^\\n]*${colonne}`, "i"),
      `le registre doit porter une colonne « ${colonne} ».`,
    );
  }
  const lignes = registre
    .split("\n")
    .filter((ligne) => ligne.trimStart().startsWith("|") && !/^\s*\|[\s|:-]+\|\s*$/.test(ligne));
  assert.equal(
    lignes.length,
    1,
    "Le registre doit ne porter que sa ligne d'en-tête : la moitié 2 de #20 n'a pas eu lieu, et un registre pré-rempli mentirait.",
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
