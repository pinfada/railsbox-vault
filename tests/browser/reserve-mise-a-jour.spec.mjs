// La MISE À JOUR de la réserve (#299, ADR 0048 §§ 5, 6 et 8) sur l'arbre PUBLIÉ, trois moteurs : deux
// onglets sans mélange de versions, application après la disparition de TOUS les clients, aucun
// `controllerchange`, identité de cache par contenu, révocation observée en session et annoncée.
// Critères 4, 5 (observation tardive), 8 (collision, même contenu et plancher relevé).

import { expect, test } from "@playwright/test";

import {
  Origine,
  attendreLaCoquille,
  avecUnAjout,
  contenuVu,
  etatDeLInscription,
  fabriquerGeneration,
  jusqua,
  lireLeReleve,
  majDepuisLaPage,
  ouvrirUnNavigateur,
  portDe,
  visiter,
  aller,
} from "./support-reserve.mjs";

const FICHIER = "/coquille/promesse-de-l-entree.mjs";
let origine;
let navigateur;
test.beforeEach(async ({ browserName }) => {
  origine = new Origine({ port: portDe(browserName, 2) });
  origine.publier(fabriquerGeneration({ sequence: 1 }));
  await origine.demarrer();
});
test.afterEach(async () => {
  await navigateur?.fermer();
  navigateur = null;
  await origine.arreter();
});

const v2 = (options = {}) =>
  fabriquerGeneration({
    sequence: 2,
    surcharges: { [FICHIER]: avecUnAjout(FICHIER, "\n// v2\n") },
    ...options,
  });

test("DEUX ONGLETS : v2 attend, aucun `controllerchange`, aucun mélange ; elle ne s'applique qu'APRÈS la fermeture de TOUS les clients (critère 4)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const onglet1 = await navigateur.page();
  await visiter(onglet1, origine);
  const onglet2 = await navigateur.page();
  await visiter(onglet2, origine);

  origine.publier(v2());
  expect(await majDepuisLaPage(onglet1)).toBe(true);
  expect(
    await jusqua(async () => (await etatDeLInscription(onglet1)).attente === "installed", {
      delaiMs: 20_000,
    }),
  ).toBe(true);
  for (const onglet of [onglet1, onglet2]) {
    const etat = await etatDeLInscription(onglet);
    expect(etat.changements, "aucun controllerchange").toBe(0);
    expect(await contenuVu(onglet, FICHIER), "toujours la v1").not.toContain("// v2");
  }
  // L'onglet 1 est en SESSION : un import tardif reste v1.
  expect(
    await onglet1.evaluate(
      async () =>
        (await import("/coquille/promesse-de-l-entree.mjs")) &&
        (await (await fetch("/coquille/promesse-de-l-entree.mjs")).text()),
    ),
  ).not.toContain("// v2");

  // Fermer l'onglet 2 seul : toujours v1, et un onglet NEUF la voit « en attente » (annonce de l'éditeur).
  await onglet2.close();
  const onglet3 = await navigateur.page();
  const releve3 = await visiter(onglet3, origine);
  expect(releve3.rapport.reserve.fraicheur).toBe("mise-a-jour-prete");
  expect(await contenuVu(onglet3, FICHIER)).not.toContain("// v2");
  expect((await etatDeLInscription(onglet1)).changements).toBe(0);

  // Fermer TOUS les clients : la v2 s'applique, et le cache de la v1 est supprimé à l'activation.
  await onglet1.close();
  await onglet3.close();
  let vue = "";
  let neuve = null;
  const appliquee = await jusqua(
    async () => {
      await neuve?.close();
      neuve = await navigateur.page();
      await neuve.goto(`${origine.origine}/index.html`).catch(() => {});
      await attendreLaCoquille(neuve);
      vue = await contenuVu(neuve, FICHIER);
      return vue.includes("// v2");
    },
    { delaiMs: 40_000, pasMs: 500 },
  );
  expect(appliquee, "la v2 s'applique quand plus aucun client de la v1 n'existe").toBe(true);
  const etat = await etatDeLInscription(neuve);
  expect(etat.changements, "aucun controllerchange, même à l'application").toBe(0);
  expect(await jusqua(async () => (await etatDeLInscription(neuve)).caches.length === 1)).toBe(
    true,
  );
  const releve = await lireLeReleve(neuve);
  expect(releve.rapport.reserve.sequence).toBe(2);
  expect(releve.rapport.reserve.refus).toBeNull();
});

test("COLLISION : même séquence, contenu différent, clients ouverts — le cache actif est INTACT, le nouveau a son propre nom (critère 8a)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  const avant = await etatDeLInscription(page);
  expect(avant.caches).toHaveLength(1);
  origine.publier(
    fabriquerGeneration({
      sequence: 1,
      surcharges: { [FICHIER]: avecUnAjout(FICHIER, "\n// autre contenu\n") },
    }),
  );
  await majDepuisLaPage(page);
  expect(
    await jusqua(async () => (await etatDeLInscription(page)).attente === "installed", {
      delaiMs: 20_000,
    }),
  ).toBe(true);
  const apres = await etatDeLInscription(page);
  expect(apres.caches, "deux caches, deux noms").toHaveLength(2);
  expect(apres.caches).toContain(avant.caches[0]);
  expect(await contenuVu(page, FICHIER)).not.toContain("autre contenu");
  const verdict = await page.evaluate(async () => {
    const actif = navigator.serviceWorker.controller;
    return new Promise((resoudre) => {
      const canal = new MessageChannel();
      canal.port1.onmessage = (e) => resoudre(e.data);
      actif.postMessage({ type: "verifier" }, [canal.port2]);
    });
  });
  expect(verdict.ok, "l'actif est intact").toBe(true);
});

test("MÊME CONTENU, plancher relevé : même cache, rien n'est réinstallé (critère 8b) ; et un plancher supérieur est une révocation CONNUE, annoncée sans interrompre la session (critère 5)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  const releve = await visiter(page, origine);
  const avant = await etatDeLInscription(page);
  origine.publier(fabriquerGeneration({ sequence: 1, plancher: 1 }));
  await majDepuisLaPage(page);
  expect(
    await jusqua(async () => (await etatDeLInscription(page)).attente === "installed", {
      delaiMs: 20_000,
    }),
  ).toBe(true);
  const apres = await etatDeLInscription(page);
  expect(apres.caches, "même identité, même cache").toEqual(avant.caches);
  // Plancher SUPÉRIEUR à la séquence courante : révocation connue, annoncée, session ininterrompue.
  origine.publier(
    fabriquerGeneration({
      sequence: 3,
      plancher: 3,
      surcharges: { [FICHIER]: avecUnAjout(FICHIER, "\n// rev\n") },
    }),
  );
  await majDepuisLaPage(page);
  expect(
    await jusqua(async () => (await lireLeReleve(page)).bandeau === "revocation-connue", {
      delaiMs: 20_000,
    }),
  ).toBe(true);
  const region = await page.locator("#reserve-etat").getAttribute("role");
  expect(region).toBe("alert");
  await expect(page.locator("#reserve-etat")).toContainText("retirée par son éditeur");
  const apresRev = await lireLeReleve(page);
  expect(apresRev.rapport.reserve.revocation).toBe("plancher");
  expect(apresRev.rapport.canalPrivilegie, "la session n'est pas interrompue").toBe(
    releve.rapport.canalPrivilegie,
  );
  expect(apresRev.workers).toBe(releve.workers);
  expect((await etatDeLInscription(page)).changements).toBe(0);
  // Un onglet NEUF refuse : RESERVE_PERIMEE, aucun Worker.
  const neuf = await navigateur.page();
  await aller(neuf, `${origine.origine}/index.html`);
  const refus = await attendreLaCoquille(neuf);
  expect(refus.rapport.reserve.refus).toEqual({
    code: "VAULT_COQUILLE_RESERVE_PERIMEE",
    cause: "plancher",
  });
  expect(refus.workers).toBe(0);
});
