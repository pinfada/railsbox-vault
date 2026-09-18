/**
 * Ce qu'un paquet CONTIENT vraiment, relu dans l'image fabriquée (#236, revue de sécurité, 1 et 2).
 *
 * Les épreuves unitaires disent que la liste d'exclusion range les bons chemins. Elles ne disent
 * rien de ce que Docker copie ensuite — et c'est précisément là qu'était le défaut : le balayage de
 * secrets ignorait `.git/`, `vendor/` et `log/` que la copie prenait. Une garde qui n'est mesurée
 * que du côté de la liste laisse l'autre côté libre de diverger.
 *
 * Cette épreuve fabrique donc un paquet RÉEL depuis une source PIÉGÉE — un faux dépôt git portant
 * une ancienne clé dans son historique, un journal, un `node_modules`, un `.env` ignoré par git —
 * puis relit l'image produite avec `debugfs` et exige que rien de tout cela n'y soit.
 *
 * Elle exige Docker, comme `npm run test:vm:reference`, et s'ignore avec son motif sinon.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { fabriquerLePaquet, RACINE_DEPOT } from "../../tools/paquet/fabriquer-paquet.mjs";

const DOSSIER_ARTEFACTS = join(RACINE_DEPOT, "artifacts", "reference-image");

/** Décrit ce qui manque pour fabriquer, ou `null`. Même contrat que les autres suites VM. */
function raisonDIndisponibilite() {
  const docker = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  if (docker.error !== undefined || docker.status !== 0) {
    return "Docker est indisponible : cette épreuve fabrique un paquet réel";
  }
  return null;
}

/**
 * Une source PIÉGÉE : l'application de référence, plus tout ce qui ne doit jamais entrer.
 *
 * Le `.git/` est un vrai dépôt, avec une clé maîtresse dans un commit PUIS retirée : c'est le cas
 * que la revue a reproduit — le fichier n'existe plus dans l'arbre, son contenu vit dans les objets.
 */
function sourcePiegee() {
  const source = mkdtempSync(join(tmpdir(), "vault-source-piegee-"));
  cpSync(join(RACINE_DEPOT, "apps", "reference"), source, { recursive: true });

  const git = (...arguments_) =>
    spawnSync("git", ["-C", source, ...arguments_], { encoding: "utf8" });
  git("init", "-q");
  git("config", "user.email", "source@epreuve.invalid");
  git("config", "user.name", "Source d'épreuve");
  writeFileSync(join(source, "config", "master.key"), "ANCIENNE_CLE_DANS_L_HISTORIQUE_GIT\n");
  git("add", "-A");
  git("commit", "-q", "-m", "avec la cle");
  rmSync(join(source, "config", "master.key"));
  git("add", "-A");
  git("commit", "-q", "-m", "sans la cle");

  // Ce que git IGNORE ne doit pas entrer non plus, même sans motif d'exclusion qui le vise.
  writeFileSync(join(source, ".gitignore"), "secret-ignore-par-git.txt\n");
  writeFileSync(join(source, "secret-ignore-par-git.txt"), "JETON_QUI_NE_DOIT_PAS_SORTIR\n");

  mkdirSync(join(source, "log"), { recursive: true });
  writeFileSync(join(source, "log", "production.log"), "COOKIE_DE_SESSION_DANS_UN_JOURNAL\n");
  mkdirSync(join(source, "node_modules", "paquet-inutile"), { recursive: true });
  writeFileSync(
    join(source, "node_modules", "paquet-inutile", "index.js"),
    "// DEPENDANCE_AMD64_INUTILE\n",
  );
  writeFileSync(
    join(source, "vault-app.json"),
    `${JSON.stringify({ application: { id: "source-piegee", version: "1.0.0" } }, null, 2)}\n`,
  );
  return source;
}

/**
 * Relit l'image ext4 produite, sans la monter : `debugfs` l'extrait dans le conteneur du fabricant,
 * et rend la LISTE de ses chemins puis les chaînes piégées qui s'y trouvent encore.
 *
 * `rdump` plutôt que `ls -R` : `ls` de debugfs ne descend pas, et une liste qui s'arrête à la racine
 * dirait « rien d'interdit » pour la seule raison qu'elle n'a rien regardé. L'extraction permet en
 * plus de chercher le CONTENU — une clé qui vit dans les objets de `.git` n'apparaît dans aucun nom.
 */
function inspecterLImage(nomDeLImage, chainesPiegees) {
  const script =
    `mkdir -p /relu && debugfs -R "rdump / /relu" /sortie/${nomDeLImage} 2>/dev/null; ` +
    `echo "--- CHEMINS"; cd /relu && find . | sed "s|^\\./||"; ` +
    `echo "--- CHAINES"; for chaine in ${chainesPiegees.join(" ")}; do ` +
    `grep -rl "$chaine" /relu 2>/dev/null | head -3; done`;
  const resultat = spawnSync(
    "docker",
    [
      "run",
      "--rm",
      "-v",
      `${DOSSIER_ARTEFACTS}:/sortie:ro`,
      "--entrypoint",
      "/bin/sh",
      "railsbox-vault-diskbuilder:local",
      "-c",
      script,
    ],
    { encoding: "utf8", maxBuffer: 256 * 1024 * 1024 },
  );
  assert.equal(resultat.status, 0, `debugfs a échoué : ${resultat.stderr}`);
  const [, chemins = "", chaines = ""] = resultat.stdout.split(/--- (?:CHEMINS|CHAINES)\n/);
  const listeDesChemins = chemins.split("\n").filter((ligne) => ligne.trim() !== "");
  assert.ok(
    listeDesChemins.length > 100,
    `l'extraction n'a rendu que ${listeDesChemins.length} chemins : l'épreuve ne mesurerait rien`,
  );
  return { chemins: listeDesChemins, porteursDeChaine: chaines.split("\n").filter(Boolean) };
}

const raison = raisonDIndisponibilite();

test(
  "un paquet fabriqué depuis une source piégée ne contient ni .git, ni journaux, ni dépendances, ni fichier ignoré",
  { skip: raison ?? false, timeout: 900_000 },
  async () => {
    const source = sourcePiegee();
    let paquet;
    try {
      paquet = await fabriquerLePaquet(["--source", source, "--taille-donnees", "64"]);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }

    const { chemins, porteursDeChaine } = inspecterLImage(paquet.image.name, [
      "ANCIENNE_CLE_DANS_L_HISTORIQUE_GIT",
      "JETON_QUI_NE_DOIT_PAS_SORTIR",
      "COOKIE_DE_SESSION_DANS_UN_JOURNAL",
      "DEPENDANCE_AMD64_INUTILE",
    ]);

    for (const interdit of [
      /(^|\/)\.git(\/|$)/,
      /(^|\/)node_modules(\/|$)/,
      /(^|\/)log\/production\.log$/,
      /secret-ignore-par-git\.txt$/,
    ]) {
      const trouve = chemins.filter((chemin) => interdit.test(chemin));
      assert.deepEqual(trouve, [], `${interdit} est entré dans le paquet ${paquet.image.name}`);
    }
    // Et le CONTENU, pas seulement les noms : une clé retirée de l'arbre vit dans les objets de Git.
    assert.deepEqual(
      porteursDeChaine,
      [],
      "une chaîne piégée de la source se relit dans l'image du paquet",
    );
    // Le CODE, lui, est bien là : une exclusion qui viderait l'image passerait aussi les gardes
    // ci-dessus, et l'épreuve serait verte par vacuité.
    for (const present of ["Gemfile", "config/application.rb", "app", "db/migrate"]) {
      assert.ok(
        chemins.some((chemin) => chemin === present || chemin.startsWith(`${present}/`)),
        `« ${present} » manque au paquet`,
      );
    }

    // Hygiène : les images de cette épreuve ne restent pas dans les artefacts du dépôt.
    for (const nom of [paquet.image.name, paquet.graine.name]) {
      rmSync(join(DOSSIER_ARTEFACTS, nom), { force: true });
    }
  },
);

test(
  "une source portant une clé d'environnement est REFUSÉE avant toute construction",
  { skip: raison ?? false, timeout: 120_000 },
  async () => {
    const source = sourcePiegee();
    mkdirSync(join(source, "config", "credentials"), { recursive: true });
    writeFileSync(join(source, "config", "credentials", "staging.key"), "CLE_DE_STAGING\n");
    try {
      await assert.rejects(
        fabriquerLePaquet(["--source", source, "--taille-donnees", "64"]),
        /staging\.key/,
      );
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  },
);
