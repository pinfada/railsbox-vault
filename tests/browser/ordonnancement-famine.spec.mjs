// Famine des minuteries sous la boucle d'ordonnancement de Vault (#74, revue de la PR #86).
//
// Le fait que ces épreuves figent, moteur par moteur : quand la boucle de Vault enchaîne les tours
// sans délai — ce que fait v86 pendant un boot —, les minuteries du Worker ne s'exécutent pas
// forcément. Sur WebKit elles sont **affamées** ; sur Chromium et Firefox elles passent. Les
// messages venus de la page, eux, passent partout : le port n'est pas la même source de tâches.
//
// Pourquoi cela compte, et pourquoi c'est ici et pas dans un ADR : le chien de garde du premier tour
// (`VAULT_RUNTIME_NO_TICK`) et les délais de garde des sessions de guest bornent précisément les
// plages où v86 tourne à plein. Posés sur une minuterie seule, ils ne pourraient pas expirer là où
// ils servent. Ils sont donc CADENCÉS PAR LA BOUCLE elle-même, et c'est cette propriété — une
// échéance expire malgré la famine — que ces épreuves exigent sur les trois moteurs.
//
// Aucun artefact v86 n'est nécessaire : aucun émulateur n'est démarré. Six secondes par moteur.

import { expect, test } from "@playwright/test";

const WORKER = "/csp/famine-minuteries-worker.mjs";
const DUREE_BOUCLE_MS = 5000;
/** Pings émis par la page pendant la boucle serrée, pour mesurer la source « port ». */
const PINGS = 5;

/** Fait tourner la boucle serrée dans un Worker et rend son relevé, ou le constat d'un silence. */
function mesurer(page) {
  return page.evaluate(
    async ([adresse, dureeMs, pings]) => {
      const worker = new Worker(adresse, { type: "module", name: "vault-famine" });
      try {
        const releve = new Promise((resolve) => {
          const echeance = setTimeout(() => resolve({ silence: true }), dureeMs + 30000);
          worker.addEventListener("message", (evenement) => {
            clearTimeout(echeance);
            resolve(evenement.data);
          });
          worker.addEventListener("error", (evenement) =>
            resolve({ erreurChargement: evenement.message ?? "sans message" }),
          );
        });
        worker.postMessage({ id: 1, type: "mesurer", payload: { dureeMs } });
        // Les pings partent PENDANT la boucle serrée : c'est ce qui mesure la source « port ».
        for (let rang = 0; rang < pings; rang += 1) {
          await new Promise((resolve) => setTimeout(resolve, dureeMs / (pings + 1)));
          worker.postMessage({ type: "ping" });
        }
        return await releve;
      } finally {
        worker.terminate();
      }
    },
    [WORKER, DUREE_BOUCLE_MS, PINGS],
  );
}

test("une boucle serrée n'affame ni le port ni une échéance cadencée par la boucle", async ({
  page,
}, info) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const reponse = await mesurer(page);
  await info.attach(`famine-${info.project.name}.json`, {
    body: JSON.stringify(reponse, null, 2),
    contentType: "application/json",
  });

  expect(reponse.silence).toBeUndefined();
  expect(reponse.ok).toBe(true);
  const releve = reponse.report;

  // La boucle a bien tourné : sans cela, l'absence de famine ne prouverait rien.
  expect(releve.boucle).toMatch(/^vault/);
  expect(releve.taches).toBeGreaterThan(100);

  // Le port traverse la boucle serrée sur les trois moteurs. C'est ce qui permet à la coquille de
  // parler à un Worker occupé — et ce qui distingue le port des minuteries.
  expect(releve.messagesDeLaPage).toBe(PINGS);

  // LA propriété qui doit tenir partout : une échéance consultée DEPUIS la boucle expire, même là
  // où les minuteries sont affamées. Le chien de garde du runtime en dépend.
  expect(releve.echeanceCadenceeMs).not.toBeNull();
  expect(releve.echeanceCadenceeMs).toBeGreaterThanOrEqual(releve.echeanceCadenceeVisee);
  expect(releve.echeanceCadenceeMs).toBeLessThan(releve.dureeReelleMs);
});

test("les minuteries, elles, ne traversent pas partout — le relevé le dit par moteur", async ({
  page,
  browserName,
}, info) => {
  test.setTimeout(90_000);
  await page.goto("/");
  const reponse = await mesurer(page);
  const releve = reponse.report;
  await info.attach(`minuteries-${info.project.name}.json`, {
    body: JSON.stringify(releve, null, 2),
    contentType: "application/json",
  });

  // Mesuré le 2026-08-26 : Chromium et Firefox exécutent leurs minuteries entre deux messages de
  // port ; WebKit ne les exécute pas du tout tant que la boucle serrée dure. L'épreuve fige le fait
  // OBSERVÉ, moteur par moteur — un moteur qui changerait de comportement doit faire rougir, dans
  // un sens comme dans l'autre : c'est une hypothèse dont dépend la cadence du chien de garde.
  const affameAttendu = browserName === "webkit";
  if (affameAttendu) {
    expect(releve.intervalles, "WebKit affame les minuteries sous boucle serrée").toBe(0);
    expect(releve.minuterieTiree).toBe(false);
    // Et c'est précisément là que la cadence par la boucle gagne son existence.
    expect(releve.echeanceCadenceeMs).not.toBeNull();
  } else {
    expect(releve.intervalles, "les minuteries traversent sur ce moteur").toBeGreaterThan(0);
    expect(releve.minuterieTiree).toBe(true);
  }
});
