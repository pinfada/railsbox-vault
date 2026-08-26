// Diagnostic du Worker runtime sous la CSP de la coquille (#52, ADR 0013).
//
// Ce que ces épreuves ferment : un contexte qui ne peut pas faire battre v86 doit produire une
// RAISON TYPÉE dans un délai borné. Avant elles, le Worker rendait un `Error` sans code sur une
// condition devinée — il affirmait « la CSP refuse le Worker imbriqué » sans l'avoir jamais
// observé — et l'émulateur, privé de boucle, ne battait pas pendant les quatre minutes du délai de
// garde du guest avant d'être déclaré « invite du guest non atteinte ».
//
// Elles n'ont besoin d'aucun artefact v86 : le contrôle préalable précède le chargement des
// artefacts. Elles s'exécutent donc sur les trois moteurs dans `npm run check`.

import { expect, test } from "@playwright/test";

const RUNTIME_SANS_MARQUEUR = "/vm/runtime-worker.mjs";
const RUNTIME_AVEC_MARQUEUR = "/vm/runtime-worker.mjs?use-scheduling-api";

/** Délai accordé au Worker pour répondre. Au-delà, la réponse est un SILENCE — le défaut de #52. */
const DELAI_REPONSE_MS = 15000;

/**
 * Envoie un message au Worker runtime et rend sa réponse, ou le constat d'un silence. La promesse
 * n'est jamais rejetée : un Worker muet est le résultat que ces épreuves doivent pouvoir nommer.
 */
function interroger(page, url, type) {
  return page.evaluate(
    async ([adresse, message, delaiMs]) => {
      const debut = performance.now();
      const worker = new Worker(adresse, { type: "module", name: "vault-diagnostic" });
      const ecoule = () => Number((performance.now() - debut).toFixed(0));
      try {
        return await new Promise((resolve) => {
          const echeance = setTimeout(
            () => resolve({ silence: true, millisecondes: ecoule() }),
            delaiMs,
          );
          worker.addEventListener("message", (evenement) => {
            clearTimeout(echeance);
            resolve({ silence: false, millisecondes: ecoule(), ...evenement.data });
          });
          worker.addEventListener("error", (evenement) => {
            clearTimeout(echeance);
            resolve({
              silence: false,
              millisecondes: ecoule(),
              erreurChargement: evenement.message ?? "sans message",
            });
          });
          worker.postMessage({ id: 1, type: message });
        });
      } finally {
        worker.terminate();
      }
    },
    [url, type, DELAI_REPONSE_MS],
  );
}

test("sans « use-scheduling-api », le contrôle nomme le Worker imbriqué refusé", async ({
  page,
}, info) => {
  await page.goto("/");
  const reponse = await interroger(page, RUNTIME_SANS_MARQUEUR, "controler");
  await info.attach(`controle-sans-marqueur-${info.project.name}.json`, {
    body: JSON.stringify(reponse, null, 2),
    contentType: "application/json",
  });

  expect(reponse.silence).toBe(false);
  expect(reponse.ok).toBe(true);
  expect(reponse.report.diagnostic?.code).toBe("VAULT_RUNTIME_WORKER_REFUSED");
  // Depuis que la boucle de Vault est posée dans tout Worker runtime (#74), la cause du repli ne
  // dépend plus du moteur : `scheduler.postTask` est toujours là, et la seule raison restante de
  // ne pas l'emprunter est l'URL du Worker. La raison le dit, sur les trois moteurs.
  expect(reponse.report.boucleOrdonnancement.source).toMatch(/^vault/);
  expect(reponse.report.diagnostic.context.raison).toMatch(/use-scheduling-api/);
  // Et l'observation dit ce qui a été MESURÉ du Worker `blob:`, pas ce qu'on en supposait.
  expect(reponse.report.diagnostic.context.observation).not.toBe("vivant");
});

test("avec « use-scheduling-api », les trois moteurs peuvent exécuter le runtime", async ({
  page,
}, info) => {
  await page.goto("/");
  const reponse = await interroger(page, RUNTIME_AVEC_MARQUEUR, "controler");
  await info.attach(`controle-avec-marqueur-${info.project.name}.json`, {
    body: JSON.stringify(reponse, null, 2),
    contentType: "application/json",
  });

  expect(reponse.silence).toBe(false);
  expect(reponse.ok).toBe(true);

  // Avant #74, ce verdict dépendait du moteur : WebKit n'expose pas `scheduler.postTask` et se
  // voyait refusé ici. La boucle posée par Vault supprime cette dépendance — et l'épreuve le dit
  // sans nommer aucun moteur, pour qu'un moteur qui régresserait la fasse rougir.
  expect(reponse.report.diagnostic).toBe(null);
  expect(reponse.report.schedulerPostTask).toBe(true);
  expect(reponse.report.boucleOrdonnancement.source).toMatch(/^vault/);
});

test("un scénario lancé sans boucle d'ordonnancement est REFUSÉ, pas laissé en silence", async ({
  page,
}, info) => {
  await page.goto("/");
  const reponse = await interroger(page, RUNTIME_SANS_MARQUEUR, "run");
  await info.attach(`refus-run-${info.project.name}.json`, {
    body: JSON.stringify(reponse, null, 2),
    contentType: "application/json",
  });

  expect(reponse.silence).toBe(false);
  expect(reponse.ok).toBe(false);
  expect(reponse.error.code).toBe("VAULT_RUNTIME_WORKER_REFUSED");
  // Borne explicite : le refus arrive en quelques secondes, là où le délai de garde du guest
  // attendrait quatre minutes avant de nommer une cause qui n'est pas la bonne.
  expect(reponse.millisecondes).toBeLessThan(DELAI_REPONSE_MS);
});
