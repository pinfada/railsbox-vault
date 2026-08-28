/**
 * Cliquet : **aucun bloc `run:` d'un workflow n'interpole une valeur contrôlée de l'extérieur.**
 *
 * ## Ce que la règle empêche
 *
 * `${{ … }}` est substitué par le moteur d'Actions **avant** que le shell ne voie la ligne. Une
 * valeur qui contient une apostrophe, un `$(…)` ou un saut de ligne cesse alors d'être une donnée
 * et devient du code exécuté sur l'exécutant. Les sources dangereuses sont celles qu'un humain — ou
 * un tiers — remplit : `inputs.*` d'un `workflow_dispatch`, et `github.event.*`, qui porte les
 * titres de PR, noms de branche et corps de commentaires.
 *
 * Dans ce dépôt, l'exécutant concerné est **celui qui produit l'arborescence publiée et affiche son
 * empreinte de racine** (`.github/workflows/publication.yml`). Une exécution arbitraire y ruinerait
 * la seule défense que #45 apporte contre une publication altérée : la comparaison hors bande.
 * L'ADR 0017 dit que l'inventaire n'est pas une signature ; encore faut-il que l'empreinte affichée
 * vienne bien de l'arbre déposé.
 *
 * ## Ce qui reste permis, et pourquoi
 *
 * Les interpolations HORS d'un `run:` — `env:`, `with:`, `if:`, `concurrency:` — ne traversent pas
 * un shell : le moteur les passe comme valeurs. Le remède est donc toujours le même, et il est
 * mécanique : déclarer la valeur dans `env:`, puis la lire `"$VARIABLE"` dans le `run:`.
 *
 * ## Pourquoi une analyse textuelle plutôt qu'un analyseur YAML
 *
 * Le dépôt n'a aucune dépendance YAML, et en ajouter une pour un cliquet de six lignes serait une
 * dépendance de plus dans la chaîne de publication — exactement ce que cette épreuve protège. Le
 * balayage suit l'indentation des blocs `run:`, ce que le format des workflows du dépôt rend
 * fiable ; l'épreuve de sensibilité ci-dessous vérifie que le balayage MORD sur un cas connu, sans
 * quoi un relevé vide ne prouverait rien.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DOSSIER_WORKFLOWS = path.join(REPO_ROOT, ".github", "workflows");

/** Contextes qu'un tiers ou un opérateur remplit, et qui n'ont donc rien à faire dans un shell. */
const CONTEXTES_INTERDITS = [
  "inputs.",
  "github.event.",
  "github.head_ref",
  "env.VAULT_INJECTION_TEMOIN",
];

/**
 * Relève les lignes appartenant à un bloc `run:` et portant une interpolation interdite.
 *
 * Un bloc `run:` commence à une ligne `run: |` ou `run: >` et court tant que l'indentation reste
 * strictement supérieure à celle du `run:`. La forme d'une seule ligne (`run: commande`) est
 * couverte par le même passage.
 *
 * @param {string} texte contenu d'un fichier de workflow
 * @returns {{ ligne: number, texte: string, contexte: string }[]}
 */
export function interpolationsDansRun(texte) {
  const lignes = texte.split("\n");
  const trouvees = [];
  let indentationDuRun = null;

  const signaler = (index, ligne) => {
    for (const contexte of CONTEXTES_INTERDITS) {
      if (new RegExp(`\\$\\{\\{\\s*${contexte.replace(".", "\\.")}`, "u").test(ligne)) {
        trouvees.push({ ligne: index + 1, texte: ligne.trim(), contexte });
        return;
      }
    }
  };

  for (const [index, ligne] of lignes.entries()) {
    const indentation = ligne.length - ligne.trimStart().length;
    if (indentationDuRun !== null) {
      if (ligne.trim() !== "" && indentation <= indentationDuRun) indentationDuRun = null;
      else {
        signaler(index, ligne);
        continue;
      }
    }
    const debut = /^(?<espaces>\s*)-?\s*run:(?<reste>.*)$/u.exec(ligne);
    if (debut === null) continue;
    signaler(index, debut.groups.reste);
    indentationDuRun = debut.groups.espaces.length;
  }
  return trouvees;
}

async function workflows() {
  const noms = (await readdir(DOSSIER_WORKFLOWS)).filter((nom) => nom.endsWith(".yml"));
  return Promise.all(
    noms.map(async (nom) => ({
      nom,
      texte: await readFile(path.join(DOSSIER_WORKFLOWS, nom), "utf8"),
    })),
  );
}

const releve = await workflows();

test("le relevé porte bien sur les workflows du dépôt", () => {
  assert.ok(releve.length >= 4, `seulement ${releve.length} workflow(s) relevé(s)`);
  assert.ok(
    releve.some(({ nom }) => nom === "publication.yml"),
    "la chaîne de publication n'est pas couverte par ce cliquet",
  );
});

test("aucun bloc `run:` n'interpole une entrée ou un événement", () => {
  const fautes = releve.flatMap(({ nom, texte }) =>
    interpolationsDansRun(texte).map(
      ({ ligne, texte: source, contexte }) => `${nom}:${ligne} — ${contexte} dans « ${source} »`,
    ),
  );

  assert.deepEqual(
    fautes,
    [],
    "Ces interpolations sont substituées AVANT le shell : une valeur bien choisie y devient du " +
      'code. Déclarez la valeur dans `env:` et lisez-la « "$VARIABLE" » dans le `run:`.',
  );
});

test("le balayage MORD : un `run:` fautif est détecté, sur la bonne ligne", () => {
  const fautif = [
    "jobs:",
    "  publier:",
    "    steps:",
    "      - name: Construction",
    "        run: |",
    '          node tools/publier.mjs --commit "${{ inputs.commit }}"',
    "          echo fini",
    "      - name: Suite",
    "        run: echo sans interpolation",
  ].join("\n");

  const trouvees = interpolationsDansRun(fautif);
  assert.equal(trouvees.length, 1);
  assert.equal(trouvees[0].ligne, 6);
  assert.equal(trouvees[0].contexte, "inputs.");
});

test("le balayage mord aussi sur un `run:` d'une seule ligne", () => {
  const fautif = ["      - run: echo ${{ github.event.pull_request.title }}"].join("\n");
  assert.equal(interpolationsDansRun(fautif).length, 1);
});

test("le balayage ne mord PAS hors d'un `run:` : `env:`, `with:` et `if:` sont le remède", () => {
  const correct = [
    "    env:",
    "      VAULT_COMMIT: ${{ inputs.commit || github.sha }}",
    "    steps:",
    "      - name: Construction",
    "        if: inputs.rollback-vers != ''",
    "        uses: actions/upload-artifact@v4",
    "        with:",
    "          name: ${{ inputs.commit }}",
    "        run: |",
    '          node tools/publier.mjs --commit "$VAULT_COMMIT"',
  ].join("\n");

  assert.deepEqual(interpolationsDansRun(correct), []);
});

test("la sortie du bloc `run:` se fait à la désindentation, pas à la première ligne vide", () => {
  const correct = [
    "      - name: Construction",
    "        run: |",
    '          echo "$VAULT_COMMIT"',
    "",
    "          echo suite",
    "      - name: Autre étape",
    "        with:",
    "          valeur: ${{ inputs.commit }}",
  ].join("\n");

  assert.deepEqual(interpolationsDansRun(correct), []);
});
