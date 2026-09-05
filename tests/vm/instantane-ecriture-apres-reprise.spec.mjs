import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { INSTANTANE_MARQUE_APRES, INSTANTANE_MARQUE_AVANT } from "../../src/vm/guest-scenarios.mjs";
import { INSTANTANE_ERROR_CODES } from "../../src/vm/instantane/instantane-errors.mjs";
import { REPOSITORY_ROOT, artefactsV86Absents } from "../../tools/v86-paths.mjs";

// UNE SESSION REPRISE ÉCRIT, ET SON ÉCRITURE SURVIT À UN BOOT À FROID (#65, ADR 0024).
//
// C'est la preuve que le scénario de bout en bout ne peut pas produire, et il faut dire pourquoi :
// l'application de référence expose exactement deux routes, toutes deux en LECTURE (ADR 0004), et
// le pont série ne relaie que du HTTP. Une session Rails reprise ne peut donc rien écrire — c'est
// une propriété de la fixture, pas de la reprise, et la revue de la PR #133 a eu raison de refuser
// qu'on en reste là.
//
// Le guest de la matrice #2 rend, lui, un SHELL sur le port série. Le protocole tient en trois
// exécutions, chacune ouvrant et refermant le volume :
//
//   1. volume NEUF, une marque écrite et VALIDÉE par une barrière, instantané capturé au point de
//      contrôle qui clôt la session ;
//   2. RÉOUVERTURE PAR INSTANTANÉ : la mémoire restaurée relit sa marque, puis en écrit une
//      SECONDE, avec sa propre barrière. La fermeture range la génération ;
//   3. RÉOUVERTURE À FROID : l'instantané, périmé par l'écriture de la session reprise, est ÉCARTÉ
//      avec son motif, et le guest relit LES DEUX marques sur le volume.
//
// Ce que la troisième exécution tient et qu'aucune autre ne tenait :
//
//  - une écriture faite par une mémoire RESTAURÉE est durable au même titre qu'une autre. Si la
//    restauration rendait au guest un cache de pages en désaccord avec le disque, c'est ici que ça
//    se verrait — la marque d'après manquerait, ou celle d'avant aurait disparu ;
//  - l'instantané est bien PÉRIMÉ par cette écriture, et le motif est nommé.
//
// Ce qu'elle ne tient PAS : rien sur Rails, rien sur le budget de reprise, rien sur les durées. Le
// guest est celui de la matrice de compatibilité, pas l'image applicative.

const ARTEFACTS = ["libv86.mjs", "v86.wasm", "seabios.bin", "vgabios.bin", "linux4.iso"];
const VOLUME = "vault-instantane-ecriture-vm";

test.beforeAll(() => {
  const absents = artefactsV86Absents(ARTEFACTS);
  if (absents.length > 0) {
    throw new Error(
      `Artefacts v86 absents (${absents.join(", ")}). Exécuter « npm run vm:fetch » avant « npm run test:vm ».`,
    );
  }
});

/** Ouvre une page NEUVE sur le banc runtime. La fermer ferme son Worker et rend le handle OPFS. */
async function nouvellePage(context) {
  const page = await context.newPage();
  await page.goto("/vm/");
  await expect(page.locator("#etat")).toHaveText("Worker runtime prêt.");
  return page;
}

test("une session REPRISE écrit, et son écriture est retrouvée par un boot à froid", async ({
  context,
}, testInfo) => {
  testInfo.setTimeout(900_000);

  /** Exécute UN scénario dans un Worker NEUF, puis referme tout. */
  async function scenario(nom) {
    const page = await nouvellePage(context);
    try {
      return await page.evaluate((charge) => globalThis.bancVault.executer(charge), {
        scenario: nom,
        volume: VOLUME,
      });
    } finally {
      await page.close();
    }
  }

  // 1. Écrire, valider, capturer.
  const capture = await scenario("instantane-capturer");
  await testInfo.attach("instantane-capturer.json", {
    body: JSON.stringify(capture, null, 2),
    contentType: "application/json",
  });
  expect(capture.failures, "aucune panne de support absorbée").toEqual([]);
  expect(capture.observationsRuntime, "aucune observation du chien de garde").toEqual([]);
  expect(capture.counts.write, "le guest a écrit").toBeGreaterThan(0);
  expect(capture.counts["flush-ack"], "et sa barrière a été acquittée").toBeGreaterThan(0);
  expect(capture.capture.motif, "la capture n'a pas de motif de refus").toBeNull();
  expect(capture.capture.capture, "la capture a abouti").toBe(true);
  expect(capture.capture.violations, "aucune E/S pendant la quiescence").toBe(0);

  // 2. Reprendre, relire, ÉCRIRE.
  const reprise = await scenario("instantane-reprendre");
  await testInfo.attach("instantane-reprendre.json", {
    body: JSON.stringify(reprise, null, 2),
    contentType: "application/json",
  });
  expect(reprise.motif, "l'instantané n'a été écarté par aucun motif").toBeNull();
  expect(reprise.usedSnapshot, "la reprise est bien passée par l'instantané").toBe(true);
  expect(reprise.failures, "aucune panne de support pendant la reprise").toEqual([]);
  expect(reprise.relecture, "la mémoire restaurée retrouve la marque d'avant la capture").toContain(
    INSTANTANE_MARQUE_AVANT,
  );
  // LE POINT DE CETTE SUITE : la session reprise a réellement écrit, et sa barrière est passée.
  expect(reprise.ecriture, "l'écriture de la session reprise a réussi").toContain("rc=0");
  expect(reprise.counts.write, "une session REPRISE écrit dans le volume").toBeGreaterThan(0);
  expect(
    reprise.counts["flush-ack"],
    "et sa barrière est acquittée comme celle de n'importe quelle session",
  ).toBeGreaterThan(0);

  // 3. Boot à FROID : l'instantané est périmé, les deux marques sont sur le volume.
  const froid = await scenario("instantane-froid");
  await testInfo.attach("instantane-froid.json", {
    body: JSON.stringify(froid, null, 2),
    contentType: "application/json",
  });
  expect(froid.usedSnapshot, "un instantané périmé n'est JAMAIS utilisé").toBe(false);
  expect(
    [
      INSTANTANE_ERROR_CODES.ecartGeneration,
      INSTANTANE_ERROR_CODES.ecartRegion,
      INSTANTANE_ERROR_CODES.ecartSequence,
    ],
    "et le motif du rejet est nommé, pas tu",
  ).toContain(froid.motif);
  expect(froid.failures).toEqual([]);
  expect(
    froid.marqueAvant,
    "la marque écrite AVANT la capture est toujours là après le boot à froid",
  ).toContain(INSTANTANE_MARQUE_AVANT);
  expect(
    froid.marqueApres,
    "et celle qu'une mémoire RESTAURÉE a écrite l'est aussi : la reprise ne perd rien",
  ).toContain(INSTANTANE_MARQUE_APRES);

  const releve = {
    mesureLe: new Date().toISOString(),
    moteur: testInfo.project.name,
    volume: VOLUME,
    capture: {
      octets: capture.capture.octets,
      millisecondes: capture.capture.millisecondes,
      ecrituresDuGuest: capture.counts.write,
    },
    reprise: {
      usedSnapshot: reprise.usedSnapshot,
      ouvertureMs: reprise.instantaneMs,
      ecrituresDeLaSessionReprise: reprise.counts.write,
      barrieresAcquittees: reprise.counts["flush-ack"],
    },
    bootFroid: { motifDuRejet: froid.motif, marquesRetrouvees: 2 },
  };
  const corps = `${JSON.stringify(releve, null, 2)}\n`;
  await testInfo.attach("instantane-ecriture-apres-reprise.json", {
    body: corps,
    contentType: "application/json",
  });
  const dossier = join(REPOSITORY_ROOT, "reports", "vm");
  await mkdir(dossier, { recursive: true });
  await writeFile(join(dossier, "instantane-ecriture-apres-reprise.json"), corps);
});
