/**
 * Le COMPTE des épreuves reprises (#178).
 *
 * Le défaut que cet outil corrige est un mensonge par silence : `retries: 2` rend « 280 passed »
 * là où huit épreuves ont trébuché deux fois chacune. L'outil doit donc compter les ESSAIS, jamais
 * croire le statut annoncé — et un rapport illisible ne doit jamais devenir « zéro reprise ».
 *
 * Les rapports d'épreuve sont réduits à ce que l'outil lit : l'arbre `suites` / `specs` / `tests` /
 * `results` de Playwright, et rien d'autre.
 */

import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  composerReleve,
  enMarkdown,
  lireRapport,
  releverReprises,
} from "../../tools/compter-reprises.mjs";

/** Une épreuve jouée `essais` fois dans un projet donné, au format du rapport JSON de Playwright. */
function epreuve({ titre, ligne, projet, essais, statut }) {
  return {
    title: titre,
    file: "tests/browser/exemple.spec.mjs",
    line: ligne,
    tests: [
      {
        projectName: projet,
        status: statut,
        results: Array.from({ length: essais }, (_, retry) => ({ retry, status: "passed" })),
      },
    ],
  };
}

/** Un rapport minimal : une suite de fichier portant les specs données. */
function rapport(specs, sousSuites = []) {
  return {
    suites: [
      {
        title: "exemple.spec.mjs",
        file: "tests/browser/exemple.spec.mjs",
        specs,
        suites: sousSuites,
      },
    ],
  };
}

async function ecrireRapport(contenu) {
  const dossier = await mkdtemp(path.join(tmpdir(), "reprises-"));
  const chemin = path.join(dossier, "rapport.json");
  await writeFile(chemin, JSON.stringify(contenu), "utf8");
  return chemin;
}

test("zéro reprise : chaque épreuve n'a qu'un essai, et le relevé le dit", async () => {
  const chemin = await ecrireRapport(
    rapport([
      epreuve({ titre: "une", ligne: 10, projet: "firefox", essais: 1, statut: "expected" }),
      epreuve({ titre: "deux", ligne: 20, projet: "chromium", essais: 1, statut: "expected" }),
    ]),
  );

  const releve = releverReprises(await lireRapport(chemin));

  assert.equal(releve.jouees, 2);
  assert.deepEqual(releve.reprises, []);
  assert.equal(releve.essaisSupplementaires, 0);
  assert.match(enMarkdown(releve), /Aucune épreuve reprise : les 2 épreuves/);
});

test("une reprise : deux essais comptent une épreuve reprise et un essai supplémentaire", async () => {
  const chemin = await ecrireRapport(
    rapport([
      epreuve({ titre: "verte", ligne: 10, projet: "chromium", essais: 1, statut: "expected" }),
      epreuve({ titre: "reprise", ligne: 42, projet: "firefox", essais: 2, statut: "flaky" }),
    ]),
  );

  const releve = releverReprises(await lireRapport(chemin));

  assert.equal(releve.jouees, 2);
  assert.equal(releve.reprises.length, 1);
  assert.equal(releve.reprises[0].titre, "reprise");
  assert.equal(releve.reprises[0].projet, "firefox");
  assert.equal(releve.reprises[0].essais, 2);
  assert.equal(releve.essaisSupplementaires, 1);

  const markdown = enMarkdown(releve);
  assert.match(markdown, /\*\*1 épreuve\(s\) reprise\(s\)\*\* sur 2 jouée\(s\)/);
  assert.match(markdown, /exemple\.spec\.mjs:42/);
  assert.match(markdown, /verte au 2ᵉ essai/);
  // La règle est nommée dans le relevé lui-même : sans elle, « flaky » se lit comme « vert ».
  assert.match(markdown, /n'est pas verte : elle est tolérée/);
});

test("une épreuve reprise DEUX fois compte trois essais, et le nom du moteur suit", async () => {
  const chemin = await ecrireRapport(
    rapport([
      epreuve({
        titre: "deux fois",
        ligne: 164,
        projet: "frontiere-coquille-firefox",
        essais: 3,
        statut: "flaky",
      }),
    ]),
  );

  const releve = releverReprises(await lireRapport(chemin));

  assert.equal(releve.reprises[0].essais, 3);
  assert.equal(releve.essaisSupplementaires, 2);
  assert.match(enMarkdown(releve), /frontiere-coquille-firefox \| 3 \| verte au 3ᵉ essai/);
});

test("une épreuve ROUGE après toutes ses reprises reste comptée, et son issue le dit", async () => {
  const chemin = await ecrireRapport(
    rapport([
      epreuve({ titre: "perdue", ligne: 7, projet: "firefox", essais: 3, statut: "unexpected" }),
    ]),
  );

  const releve = releverReprises(await lireRapport(chemin));

  assert.equal(releve.reprises.length, 1);
  assert.match(enMarkdown(releve), /ROUGE après 3 essais/);
});

test("les suites imbriquées sont parcourues : un describe ne cache pas une reprise", async () => {
  const chemin = await ecrireRapport(
    rapport(
      [
        epreuve({
          titre: "au premier niveau",
          ligne: 1,
          projet: "chromium",
          essais: 1,
          statut: "expected",
        }),
      ],
      [
        {
          title: "un describe",
          specs: [
            epreuve({ titre: "au fond", ligne: 99, projet: "webkit", essais: 2, statut: "flaky" }),
          ],
        },
      ],
    ),
  );

  const releve = releverReprises(await lireRapport(chemin));

  assert.equal(releve.jouees, 2);
  assert.equal(releve.reprises.length, 1);
  assert.equal(releve.reprises[0].titre, "au fond");
});

test("un rapport illisible LÈVE : une absence de mesure n'est jamais un zéro reprise", async () => {
  await assert.rejects(() => lireRapport(path.join(tmpdir(), "rapport-qui-n-existe-pas.json")));
});

test("aucun rapport lu : le relevé dit qu'il n'a rien mesuré, il ne publie pas zéro", () => {
  const texte = composerReleve([], ["playwright-report/rapport.json : ENOENT"]);

  assert.match(texte, /Aucun rapport lu : le compte des reprises n'a PAS été mesuré/);
  assert.doesNotMatch(texte, /Aucune épreuve reprise/);
  assert.match(texte, /Rapport\(s\) non lu\(s\)/);
});

test("un rapport lu ET un rapport manquant : le compte est publié, l'absence aussi", () => {
  const texte = composerReleve(
    [{ essais: 1, statut: "expected" }],
    ["autre-rapport.json : ENOENT"],
  );

  assert.match(texte, /Aucune épreuve reprise : les 1 épreuves/);
  assert.match(texte, /autre-rapport\.json/);
});
