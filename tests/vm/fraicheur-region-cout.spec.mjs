import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { TRANCHE_REGION_OCTETS } from "../../src/vm/generation-fraicheur.mjs";
import { dispositionV3 } from "../../src/vm/volume-chiffre-format.mjs";

// COÛT de l'empreinte de la région d'authentification, sur OPFS RÉEL (#19, ADR 0019).
//
// L'ADR 0019 ajoute un hachage de la région à l'ouverture d'un volume et à chaque point de contrôle.
// Un coût qu'on ne mesure pas n'est pas tenu, il est supposé — et celui-ci tombe sur le chemin que
// l'[ADR 0005](../../docs/decisions/0005-qualification-de-la-reprise.md) borne : la reprise en moins
// de 60 s.
//
// Ce que ce banc mesure : les lectures OPFS de la région, tranche par tranche, et le hachage
// incrémental qui les absorbe — `empreinteDeRegion`, le chemin de production, sur le vrai support,
// à l'échelle du volume applicatif de 512 Mio (région de 34 Mio, ADR 0016).
//
// Ce qu'il ne mesure PAS : le scellement du volume, qui coûte 87,6 s à cette taille et ne change pas
// d'une milliseconde le coût du hachage — celui-ci ne dépend pas de ce que la région contient. Le
// fichier est alloué à sa taille support et sa région remplie d'un motif déterministe.

const DOSSIER_RAPPORTS = "reports/vm";

/** La taille du volume applicatif. C'est celle dont le coût décide, pas une taille de banc. */
const TAILLE_LOGIQUE = 512 * 1024 * 1024;

/** Budget de reprise de l'ADR 0005, en millisecondes. Le seuil que ce coût ne doit pas entamer. */
const BUDGET_REPRISE_MS = 60_000;

/**
 * Part du budget de reprise au-delà de laquelle l'ADR 0019 exige un amortissement.
 *
 * Un pour cent, et le chiffre est un ENGAGEMENT, pas une observation : au-delà, la fraîcheur cesse
 * d'être un coût qu'on peut ignorer dans le budget de l'ADR 0005, et l'ADR 0019 nomme alors ce qu'il
 * faut faire — empreinte à un seul coup, ou empreinte incrémentale par suites de secteurs.
 */
const PART_ADMISE = 0.01;

test("l'empreinte de région d'un volume de 512 Mio reste sous le pour-cent du budget de reprise", async ({
  page,
}, testInfo) => {
  // Écrire 34 Mio puis les relire trois fois sur OPFS réel : le budget du harnais VM y suffit, mais
  // pas celui d'une épreuve ordinaire.
  testInfo.setTimeout(600_000);
  await page.goto("/vm/recuperation.html");
  await expect(page.locator("#etat")).toHaveText("Banc de récupération prêt.");

  const disposition = dispositionV3(TAILLE_LOGIQUE);
  const mesure = await page.evaluate(
    (options) => globalThis.bancRecuperation.mesurer(options),
    // TROIS répétitions : deux ne disent pas si l'écart entre elles est du bruit ou une tendance,
    // et l'issue en demande au moins deux. L'étendue relative est publiée avec la médiane.
    { mode: "fraicheur", tailleLogique: TAILLE_LOGIQUE, repetitions: 3 },
  );

  expect(mesure.mode).toBe("fraicheur");
  expect(mesure.profil.regionOctets).toBe(disposition.regionOctets);
  expect(mesure.profil.trancheOctets).toBe(TRANCHE_REGION_OCTETS);
  expect(mesure.empreinte.echantillons).toBe(3);

  const releve = {
    mesureLe: new Date().toISOString(),
    environnement: {
      navigateur: testInfo.project.name,
      plateforme: `${process.platform} ${process.arch}`,
      node: process.versions.node,
    },
    support: "OPFS réel (Chromium)",
    budgetRepriseMs: BUDGET_REPRISE_MS,
    partAdmise: PART_ADMISE,
    ...mesure,
    partDuBudget: mesure.empreinte.p95Ms / BUDGET_REPRISE_MS,
  };
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(
    join(DOSSIER_RAPPORTS, "fraicheur-region.json"),
    `${JSON.stringify(releve, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("fraicheur-region.json", {
    body: JSON.stringify(releve, null, 2),
    contentType: "application/json",
  });

  // LA MESURE. Si cette ligne rougit un jour, l'ADR 0019 dit quoi faire avant d'y toucher : amortir,
  // pas relever le seuil.
  expect(mesure.empreinte.p95Ms).toBeLessThanOrEqual(BUDGET_REPRISE_MS * PART_ADMISE);
});
