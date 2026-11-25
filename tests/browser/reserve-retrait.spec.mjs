// Le RETRAIT et la MIGRATION de la réserve (#299, ADR 0048 § 11) sur l'arbre PUBLIÉ, trois moteurs :
// script de retrait (onglets actifs, attente, réseau coupé), geste de la personne BORNÉ à la coquille
// (une inscription distincte et un cache d'un autre nom survivent), migration de préfixe et d'URL.
// Critères 7 et 12.

import { expect, test } from "@playwright/test";

import { fabriquerLeScriptDeRetrait } from "../../tools/publier-reserve.mjs";
import {
  Origine,
  attendreLaCoquille,
  avecUnAjout,
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

let origine;
let navigateur;
test.beforeEach(async ({ browserName }) => {
  origine = new Origine({ port: portDe(browserName, 3) });
  origine.publier(fabriquerGeneration({ sequence: 1 }));
  await origine.demarrer();
});
test.afterEach(async () => {
  await navigateur?.fermer();
  navigateur = null;
  await origine.arreter();
});

/** Une inscription DISTINCTE (autre portée) et un cache d'un AUTRE nom, que le retrait ne doit jamais toucher. */
async function poserLesTemoins(page) {
  origine.regler("/autre/sw.js", {
    corps: "self.addEventListener('fetch', () => {});\n",
    type: "text/javascript; charset=utf-8",
  });
  return page.evaluate(async () => {
    await navigator.serviceWorker.register("/autre/sw.js", { scope: "/autre/" });
    await (await caches.open("autre-cache")).put("/temoin", new Response("t"));
    const inscriptions = await navigator.serviceWorker.getRegistrations();
    return inscriptions.map((i) => new URL(i.scope).pathname).sort();
  });
}
const temoinsVivants = (page) =>
  page.evaluate(async () => ({
    inscriptions: (await navigator.serviceWorker.getRegistrations())
      .map((i) => new URL(i.scope).pathname)
      .sort(),
    caches: (await caches.keys()).filter((n) => !n.startsWith("reserve-")),
  }));

test("GESTE « Retirer la copie » : l'inscription de la coquille et les `reserve-*` partent ; une inscription distincte et un cache d'un autre nom SURVIVENT (critère 7)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  expect(await poserLesTemoins(page)).toEqual(["/", "/autre/"]);
  const [issue, encore] = await page.evaluate(async () => {
    const { retirerLaCopie } = await import("/src/coquille/reserve-retrait.mjs");
    const premiere = await retirerLaCopie({ conteneur: navigator.serviceWorker, caches });
    // Idempotent : rejouable après une interruption, sans erreur ni effet de plus.
    return [premiere, await retirerLaCopie({ conteneur: navigator.serviceWorker, caches })];
  });
  expect(issue.desinscrite).toBe(true);
  expect(issue.caches).toHaveLength(1);
  expect(encore).toEqual({ desinscrite: false, caches: [] });
  const apres = await temoinsVivants(page);
  expect(apres.inscriptions, "l'inscription distincte survit").toContain("/autre/");
  expect(apres.inscriptions).not.toContain("/");
  expect(apres.caches, "le cache d'un autre nom survit").toEqual(["autre-cache"]);
});

test("SCRIPT DE RETRAIT par l'origine : onglet actif non interrompu, onglet neuf REFUSÉ (PERIMEE/retrait), puis tous clients fermés → caches vidés, désinscription, témoins intacts (critère 7)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  const avant = await visiter(page, origine);
  await poserLesTemoins(page);
  origine.publier(fabriquerGeneration({ sequence: 1, retrait: true }));
  await majDepuisLaPage(page);
  expect(
    await jusqua(async () => (await etatDeLInscription(page)).attente === "installed", {
      delaiMs: 20_000,
    }),
  ).toBe(true);
  // L'onglet en session continue sans mélange (R1).
  const enSession = await lireLeReleve(page);
  expect(enSession.rapport.canalPrivilegie).toBe(avant.rapport.canalPrivilegie);
  expect((await etatDeLInscription(page)).changements).toBe(0);
  // Un onglet neuf voit « révocation connue » et refuse.
  const neuf = await navigateur.page();
  await aller(neuf, `${origine.origine}/index.html`);
  const refus = await attendreLaCoquille(neuf);
  expect(refus.rapport.reserve.refus).toEqual({
    code: "VAULT_COQUILLE_RESERVE_PERIMEE",
    cause: "retrait",
  });
  expect(refus.workers).toBe(0);
  // Tous les clients disparaissent : le retrait s'applique.
  await page.close();
  await neuf.close();
  let sonde = null;
  const retire = await jusqua(
    async () => {
      await sonde?.close();
      sonde = await navigateur.page();
      await sonde.goto(`${origine.origine}/autre/vide`).catch(() => {});
      const etat = await sonde.evaluate(async () => ({
        caches: (await caches.keys()).filter((n) => n.startsWith("reserve-")),
      }));
      return etat.caches.length === 0;
    },
    { delaiMs: 40_000, pasMs: 500 },
  );
  expect(retire, "les caches `reserve-*` sont supprimés").toBe(true);
  const temoins = await temoinsVivants(sonde);
  expect(temoins.caches, "un cache d'un autre nom survit").toEqual(["autre-cache"]);
  expect(temoins.inscriptions, "l'inscription distincte survit").toContain("/autre/");
});

test("RETRAIT INTERROMPU entre la suppression des caches et la désinscription : l'état final est SÛR, le geste suivant termine le retrait (critère 7, ADR 0048 § 11)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  await poserLesTemoins(page);
  // Un script de retrait COUPÉ : il vide les caches, puis échoue au lieu de se désinscrire.
  origine.publier(
    fabriquerGeneration({
      sequence: 1,
      retrait: true,
      transformerLeScript: (texte) =>
        texte.replace("await self.registration.unregister();", 'throw new Error("coupure");'),
    }),
  );
  await majDepuisLaPage(page);
  expect(
    await jusqua(async () => (await etatDeLInscription(page)).attente === "installed", {
      delaiMs: 20_000,
    }),
  ).toBe(true);
  await page.close();
  // Tous les clients ont disparu : le retrait s'applique, et il est coupé à mi-chemin.
  let sonde = null;
  const coupe = await jusqua(
    async () => {
      await sonde?.close();
      sonde = await navigateur.page();
      await sonde.goto(`${origine.origine}/autre/vide`).catch(() => {});
      return (
        (
          await sonde.evaluate(async () =>
            (await caches.keys()).filter((n) => n.startsWith("reserve-")),
          )
        ).length === 0
      );
    },
    { delaiMs: 40_000, pasMs: 500 },
  );
  expect(coupe, "les caches `reserve-*` sont partis").toBe(true);
  // ÉTAT SÛR : aucun cache servable ; l'autre cache et l'autre inscription sont intacts.
  const temoins = await temoinsVivants(sonde);
  expect(temoins.caches).toEqual(["autre-cache"]);
  expect(temoins.inscriptions).toContain("/autre/");
  await sonde.close();
  // La page ne démarre pas sur ce reste : elle refuse (PERIMEE/retrait) ou n'a plus de SW sain — jamais un Worker.
  const neuve = await navigateur.page();
  await neuve.goto(`${origine.origine}/index.html`).catch(() => {});
  await jusqua(
    async () => (await lireLeReleve(neuve).catch(() => ({}))).coquille === "reserve-refusee",
    { delaiMs: 40_000 },
  );
  const apres = await lireLeReleve(neuve);
  expect(apres.coquille).toBe("reserve-refusee");
  expect(apres.workers, "aucun Worker").toBe(0);
  expect(apres.rapport.canalPrivilegie).toBe("absent");
  // LE GESTE SUIVANT termine le retrait : idempotent, les témoins survivent.
  const geste = await neuve.evaluate(async () => {
    const { retirerLaCopie } = await import("/src/coquille/reserve-retrait.mjs");
    return retirerLaCopie({ conteneur: navigator.serviceWorker, caches });
  });
  expect(geste.caches, "plus aucun cache à retirer").toEqual([]);
  const final = await temoinsVivants(neuve);
  expect(final.inscriptions, "l'inscription de la coquille est partie").not.toContain("/");
  expect(final.inscriptions).toContain("/autre/");
  expect(final.caches).toEqual(["autre-cache"]);
  // L'éditeur republie une version saine : la coquille repart de zéro.
  origine.publier(fabriquerGeneration({ sequence: 2 }));
  await neuve.close();
  let depart = null;
  const repart = await jusqua(
    async () => {
      await depart?.close();
      depart = await navigateur.page();
      await depart.goto(`${origine.origine}/index.html`).catch(() => {});
      const releve = await attendreLaCoquille(depart).catch(() => null);
      return releve?.coquille === "prete";
    },
    { delaiMs: 60_000, pasMs: 700 },
  );
  expect(repart, "après le retrait et une version saine, la coquille démarre").toBe(true);
});

test("RÉSEAU COUPÉ : le script de retrait n'est jamais vu, l'ancienne version est servie et dit « non vérifiable » (limite écrite, R2)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  origine.publier(fabriquerGeneration({ sequence: 1, retrait: true }));
  await origine.arreter();
  const hors = await navigateur.page();
  await hors.goto(`${origine.origine}/index.html`).catch(() => {});
  const releve = await attendreLaCoquille(hors);
  expect(releve.rapport.reserve.refus, "l'ancienne version est servie").toBeNull();
  expect(releve.rapport.reserve.fraicheur).toBe("version-courante-non-verifiable");
  await origine.demarrer();
});

test("MIGRATION DE PRÉFIXE : les anciens préfixes NOMMÉS sont supprimés à l'activation, un autre cache jamais (critère 12)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  await page.evaluate(async () => {
    for (const nom of ["coquille-v1-abc", "coquille-v2-abc", "autre-cache"])
      await (await caches.open(nom)).put("/x", new Response("x"));
  });
  origine.publier(
    fabriquerGeneration({
      sequence: 2,
      prefixesAnciens: ["coquille-v1-"],
      surcharges: {
        "/coquille/promesse-de-l-entree.mjs": avecUnAjout(
          "/coquille/promesse-de-l-entree.mjs",
          "\n// p\n",
        ),
      },
    }),
  );
  await majDepuisLaPage(page);
  expect(
    await jusqua(async () => (await etatDeLInscription(page)).attente === "installed", {
      delaiMs: 20_000,
    }),
  ).toBe(true);
  await page.close();
  let sonde = null;
  const fait = await jusqua(
    async () => {
      await sonde?.close();
      sonde = await navigateur.page();
      await sonde.goto(`${origine.origine}/index.html`).catch(() => {});
      await attendreLaCoquille(sonde);
      return !(await sonde.evaluate(async () => (await caches.keys()).includes("coquille-v1-abc")));
    },
    { delaiMs: 40_000, pasMs: 500 },
  );
  expect(fait).toBe(true);
  const restants = (await sonde.evaluate(() => caches.keys())).sort();
  expect(restants).toContain("coquille-v2-abc");
  expect(restants).toContain("autre-cache");
  expect(restants.filter((n) => n.startsWith("reserve-"))).toHaveLength(1);
});

test("MIGRATION D'URL : à l'ancienne URL, un script de migration (le retrait) ; la page publiée enregistre la NOUVELLE URL après le retrait (critère 12)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  const page = await navigateur.page();
  await visiter(page, origine);
  expect((await etatDeLInscription(page)).script).toMatch(/\/sw-coquille\.mjs$/);
  // v2 : la page publiée vise une autre URL ; l'ancienne URL sert le script de migration.
  const nouvelle = "/sw-coquille-2.mjs";
  const identite = (await import("node:fs")).readFileSync(
    new URL("../../src/coquille/reserve-identite.mjs", import.meta.url),
    "utf8",
  );
  const generation = fabriquerGeneration({
    sequence: 2,
    surcharges: {
      "/src/coquille/reserve-identite.mjs": identite.replace('"/sw-coquille.mjs"', `"${nouvelle}"`),
    },
  });
  origine.publier(generation);
  origine.scripts.set("/sw-coquille.mjs", Buffer.from(fabriquerLeScriptDeRetrait()));
  origine.scripts.set(nouvelle, Buffer.from(generation.script));
  await majDepuisLaPage(page);
  expect(
    await jusqua(async () => (await etatDeLInscription(page)).attente === "installed", {
      delaiMs: 20_000,
    }),
  ).toBe(true);
  await page.close();
  let neuve = null;
  const migree = await jusqua(
    async () => {
      await neuve?.close();
      neuve = await navigateur.page();
      await neuve.goto(`${origine.origine}/index.html`).catch(() => {});
      await attendreLaCoquille(neuve).catch(() => {});
      const etat = await etatDeLInscription(neuve).catch(() => ({}));
      return (
        typeof etat.script === "string" &&
        etat.script.endsWith(nouvelle) &&
        etat.actif === "activated"
      );
    },
    { delaiMs: 60_000, pasMs: 700 },
  );
  expect(migree, "après le retrait, la page enregistre la nouvelle URL").toBe(true);
  const releve = await lireLeReleve(neuve);
  expect(releve.rapport.reserve.sequence).toBe(2);
});
