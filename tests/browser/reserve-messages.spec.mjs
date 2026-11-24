// Les MESSAGES du SW de la coquille, vus d'un VRAI client (#299, ADR 0048 § 7) : seules les fenêtres de
// premier niveau de la coquille sont écoutées ; un Worker contrôlé qui écrit au SW n'obtient AUCUNE réponse.
//
// **Chromium n'expose pas `navigator.serviceWorker` aux Workers dédiés** : la garde « client `window` » y est
// inatteignable par cette épreuve. L'exception est déclarée PAR PROJET (`test.skip(browserName === "chromium", …)`),
// jamais par ce que la page affiche, et elle ne dispense pas du kill du mutant : son épreuve unitaire
// (`tests/unit/reserve-sw-messages-et-retrait.test.mjs`) rougit sous la même mutation, et celle-ci rougit sous
// Firefox et WebKit.

import { expect, test } from "@playwright/test";

import {
  Origine,
  fabriquerGeneration,
  ouvrirUnNavigateur,
  portDe,
  visiter,
} from "./support-reserve.mjs";

const MESSAGER = `
self.onmessage = async () => {
  const conteneur = self.navigator.serviceWorker;
  if (!conteneur || !conteneur.controller) { self.postMessage({ api: Boolean(conteneur), reponse: null }); return; }
  const canal = new MessageChannel();
  const reponse = new Promise((resoudre) => {
    canal.port1.onmessage = (e) => resoudre(e.data);
    setTimeout(() => resoudre(null), 1500);
  });
  conteneur.controller.postMessage({ type: "version" }, [canal.port2]);
  self.postMessage({ api: true, reponse: await reponse });
};
`;

let origine;
let navigateur;
test.beforeEach(async ({ browserName }) => {
  origine = new Origine({ port: portDe(browserName, 5) });
  origine.publier(
    fabriquerGeneration({ sequence: 1, surcharges: { "/messager-worker.mjs": MESSAGER } }),
  );
  await origine.demarrer();
});
test.afterEach(async () => {
  await navigateur?.fermer();
  navigateur = null;
  await origine.arreter();
});

test("un Worker contrôlé qui écrit au SW n'obtient AUCUNE réponse ; la fenêtre de la coquille, si (garde « client window »)", async ({
  browserName,
}) => {
  test.skip(
    browserName === "chromium",
    "mesuré : Chromium n'expose pas navigator.serviceWorker aux Workers dédiés (ADR 0048 § 7)",
  );
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  const depuisLaFenetre = await page.evaluate(
    () =>
      new Promise((resoudre) => {
        const canal = new MessageChannel();
        canal.port1.onmessage = (e) => resoudre(e.data);
        navigator.serviceWorker.controller.postMessage({ type: "version" }, [canal.port2]);
        setTimeout(() => resoudre(null), 2000);
      }),
  );
  expect(depuisLaFenetre?.sequence, "la fenêtre de premier niveau est écoutée").toBe(1);
  const depuisUnWorker = await page.evaluate(
    () =>
      new Promise((resoudre) => {
        const travailleur = new Worker("/messager-worker.mjs", { type: "module" });
        travailleur.onmessage = (e) => resoudre(e.data);
        travailleur.onerror = () => resoudre({ erreur: "chargement" });
        travailleur.postMessage("go");
        setTimeout(() => resoudre({ erreur: "delai" }), 6000);
      }),
  );
  expect(depuisUnWorker.api, "ce moteur expose l'API au Worker : l'épreuve n'est pas vide").toBe(
    true,
  );
  expect(depuisUnWorker.reponse, "le Worker n'obtient AUCUNE réponse").toBeNull();
});
