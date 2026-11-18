// L'AFFICHAGE de la révocation sur le DOM RÉEL (#265, ADR 0049 § C2, C2-11b, C2-12, C2-13, R-1 à R-9) :
// la règle CSS « masqué sans estampille », le masquage VÉRIFIÉ, la publication d'un seul geste et le
// rendeur unique face à des points de suspension contrôlés, sur les trois moteurs.
//
// La page est la coquille réelle, dont on neutralise le script (`main.mjs` rendu vide) : il reste son
// HTML et son CSS — le conteneur, l'espace réservé, la région d'erreur —, sur lesquels on importe les
// VRAIS modules de `src/coquille/`. Aucun Worker n'est démarré : ce que l'on mesure ici est le DOM.

import { expect, test } from "../support/test.mjs";

import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

/** Charge la page sans son script, et pose un banc dans le document. */
async function preparer(page) {
  await page.route("**/main.mjs", (route) =>
    route.fulfill({ status: 200, contentType: "text/javascript", body: "" }),
  );
  await page.goto(new URL("/index.html", SHELL_ORIGIN).toString());
  await page.evaluate(async () => {
    const { creerLAffichage } = await import("/src/coquille/affichage-de-la-revocation.mjs");
    const { creerLeRendeur } = await import("/src/coquille/rendeur-de-la-vue.mjs");
    const conteneur = document.getElementById("affichage");
    const regionDErreur = document.getElementById("affichage-erreur");
    const repereDeFocus = document.getElementById("parcours-titre");
    const affichage = creerLAffichage({ doc: document, conteneur, regionDErreur, repereDeFocus });
    const banc = { occ: 1, taches: [], minuteries: [], consigne: [] };
    banc.nouvelleVue = (texte) => ({ empreinte: `vue:${texte}`, texte });
    banc.rendeur = creerLeRendeur({
      occurrence: () => banc.occ,
      nouveauFragment: affichage.nouveauFragment,
      rendre: (occ, fragment) => {
        const tache = { occ, fragment };
        banc.taches.push(tache);
        return new Promise((ok, ko) => {
          tache.ok = () => {
            const p = document.createElement("p");
            p.id = "contenu";
            p.textContent = `occurrence ${occ}`;
            fragment.append(p);
            ok({ empreinte: `vue:${occ}` });
          };
          tache.ko = () => ko(new Error("rejet"));
        });
      },
      effets: {
        ...affichage.effets,
        masquer: () => void affichage.masquer(),
      },
      armer: (ms, fonction) => {
        const minuterie = { ms, fonction };
        banc.minuteries.push(minuterie);
        return minuterie;
      },
      desarmer: () => {},
      consigner: (code) => banc.consigne.push(code),
    });
    Object.assign(globalThis, {
      __banc: banc,
      __affichage: affichage,
      __module: { creerLAffichage },
    });
  });
}

const visible = (page, id) =>
  page.evaluate((cible) => {
    const e = document.getElementById(cible);
    return (
      e !== null &&
      e.isConnected &&
      getComputedStyle(e).display !== "none" &&
      !e.closest("[hidden]")
    );
  }, id);

const instantane = (page) =>
  page.evaluate(() => {
    const c = document.getElementById("affichage");
    return {
      html: c.innerHTML,
      vue: c.getAttribute("data-vue"),
      occurrence: c.getAttribute("data-occurrence"),
      cache: c.hidden,
      erreur: document.getElementById("affichage-erreur").hidden,
    };
  });

test("[C2-11b] sans script, rien n'est affirmé : conteneur masqué, espace réservé visible — par la règle CSS seule", async ({
  page,
}) => {
  await preparer(page);
  expect(await visible(page, "affichage")).toBe(false);
  expect(await visible(page, "affichage-attente")).toBe(true);
  // Un contenu écrit SANS estampille, et même `hidden` retiré : la règle CSS le garde masqué.
  await page.evaluate(() => {
    const c = document.getElementById("affichage");
    c.textContent = "ce coffre s'ouvre par une phrase";
    c.hidden = false;
  });
  expect(await visible(page, "affichage"), "sans `data-vue`, jamais visible").toBe(false);
  expect(await visible(page, "affichage-attente")).toBe(true);
  await page.evaluate(() => document.getElementById("affichage").setAttribute("data-vue", "e"));
  expect(await visible(page, "affichage")).toBe(true);
  expect(await visible(page, "affichage-attente"), "l'espace réservé cède la place").toBe(false);
});

test("[C2-11g] l'espace réservé et la région d'erreur n'affirment jamais que l'affichage est « à jour »", async ({
  page,
}) => {
  await preparer(page);
  const textes = await page.evaluate(() => [
    document.getElementById("affichage-attente").textContent,
    document.getElementById("affichage-erreur").textContent,
  ]);
  for (const texte of textes) {
    expect(texte.trim().length).toBeGreaterThan(10);
    expect(texte).not.toMatch(/(?<!pas )(?<!plus )à jour/i);
  }
});

test("[R-3] la publication produit UN seul lot de mutations et estampille en dernier", async ({
  page,
}) => {
  await preparer(page);
  const lots = await page.evaluate(
    () =>
      new Promise((rendre) => {
        const c = document.getElementById("affichage");
        const lots = [];
        new MutationObserver((lot) =>
          lots.push(lot.map((m) => `${m.type}:${m.attributeName ?? ""}`)),
        ).observe(c, {
          attributes: true,
          childList: true,
          subtree: true,
        });
        const { effets, nouveauFragment } = globalThis.__affichage;
        const f = nouveauFragment();
        f.append(document.createElement("p"));
        effets.remplacerLeContenu(f);
        effets.retirerLaRegionDErreur();
        effets.demasquer();
        effets.estamper(3, { empreinte: "vue:3" });
        setTimeout(() => rendre(lots), 0);
      }),
  );
  expect(lots.length, "un seul lot").toBe(1);
  expect(lots[0].at(-1)).toBe("attributes:data-vue");
});

const SABOTAGES = Object.freeze({
  "(a) le retrait de l'estampille lève": "a",
  "(b) `hidden` sans effet": "b",
  "(c) conteneur détaché": "c",
  "(d) les trois ensemble": "d",
});

for (const [nom, cle] of Object.entries(SABOTAGES)) {
  test(`[C2-13] masquer ${nom} : false, et aucune affirmation visible`, async ({ page }) => {
    await preparer(page);
    const { rendu, visibleApres } = await page.evaluate((sabotage) => {
      const { effets, masquer } = globalThis.__affichage;
      const c = document.getElementById("affichage");
      const f = document.createDocumentFragment();
      f.append(document.createElement("p"));
      effets.remplacerLeContenu(f);
      effets.demasquer();
      effets.estamper(1, { empreinte: "e" });
      const sansRetrait = () => {
        c.removeAttribute = () => {
          throw new Error("retrait");
        };
      };
      const sansHidden = () => {
        Object.defineProperty(c, "hidden", { get: () => false, set: () => {}, configurable: true });
        c.setAttribute = () => {};
      };
      if (sabotage === "a") sansRetrait();
      if (sabotage === "b") sansHidden();
      if (sabotage === "c") c.remove();
      if (sabotage === "d") {
        sansRetrait();
        sansHidden();
        c.remove();
      }
      const rendu = masquer();
      const visibleApres =
        c.isConnected && getComputedStyle(c).display !== "none" && c.hasAttribute("data-vue");
      return { rendu, visibleApres };
    }, cle);
    expect(rendu).toBe(false);
    expect(visibleApres).toBe(false);
  });
}

test("[C2-13] (e) référence absente : masquer rend false sans lever", async ({ page }) => {
  await preparer(page);
  const rendu = await page.evaluate(() =>
    globalThis.__module
      .creerLAffichage({ doc: document, conteneur: null, regionDErreur: null })
      .masquer(),
  );
  expect(rendu).toBe(false);
});

test("[R-8] masquer rend true ssi le masquage est établi (relu, pas supposé)", async ({ page }) => {
  await preparer(page);
  const rendu = await page.evaluate(() => {
    const { effets, masquer } = globalThis.__affichage;
    const f = document.createDocumentFragment();
    f.append(document.createElement("p"));
    effets.remplacerLeContenu(f);
    effets.demasquer();
    effets.estamper(1, { empreinte: "e" });
    return masquer();
  });
  expect(rendu).toBe(true);
  expect(await visible(page, "affichage")).toBe(false);
  expect(await visible(page, "affichage-attente")).toBe(true);
});

// --- le rendeur unique sur le DOM réel, points de suspension contrôlés --------------------------------

const publier = async (page, rang) => {
  await page.evaluate((i) => globalThis.__banc.taches[i].ok(), rang);
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
};

test("[S-a/O-a] A abandonné par le délai, B publié, A reprend et réussit : le DOM visible est identique", async ({
  page,
}) => {
  await preparer(page);
  await page.evaluate(() => {
    const b = globalThis.__banc;
    b.rendeur.reveiller();
    b.occ += 1;
    b.minuteries[0].fonction();
  });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  await publier(page, 1);
  const avant = await instantane(page);
  expect(avant.vue).toBe("vue:2");
  expect(avant.occurrence).toBe("2");
  await publier(page, 0);
  expect(await instantane(page)).toEqual(avant);
  expect(await page.evaluate(() => globalThis.__banc.consigne)).toContain("tentative-perimee");
});

test("[S-b/O-b] A reprend et REJETTE tard : ni masquage, ni région d'erreur", async ({ page }) => {
  await preparer(page);
  await page.evaluate(() => {
    const b = globalThis.__banc;
    b.rendeur.reveiller();
    b.occ += 1;
    b.minuteries[0].fonction();
  });
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  await publier(page, 1);
  const avant = await instantane(page);
  await page.evaluate(() => globalThis.__banc.taches[0].ko());
  await page.evaluate(() => new Promise((r) => setTimeout(r, 0)));
  expect(await instantane(page)).toEqual(avant);
  expect(avant.erreur).toBe(true);
});

test("[R-d/S-k] un rendu qui ne se règle jamais : région d'erreur de l'occurrence ; la publication suivante la retire", async ({
  page,
}) => {
  await preparer(page);
  await page.evaluate(() => {
    const b = globalThis.__banc;
    b.rendeur.reveiller();
    b.minuteries[0].fonction();
  });
  expect(await visible(page, "affichage-erreur")).toBe(true);
  expect(await visible(page, "affichage")).toBe(false);
  expect(
    await page.evaluate(() =>
      document.getElementById("affichage-erreur").getAttribute("data-erreur"),
    ),
  ).toBe("1");
  await page.evaluate(() => {
    globalThis.__banc.occ += 1;
    globalThis.__banc.rendeur.reveiller();
  });
  await publier(page, 1);
  expect(await visible(page, "affichage-erreur")).toBe(false);
  expect(await visible(page, "affichage")).toBe(true);
});

test("[R-9] le focus resté dans le contenu remplacé revient au repère stable", async ({ page }) => {
  await preparer(page);
  await page.evaluate(() => {
    const b = globalThis.__banc;
    b.rendeur.reveiller();
  });
  await publier(page, 0);
  await page.evaluate(() => {
    const c = document.getElementById("affichage");
    const bouton = document.createElement("button");
    bouton.id = "geste-temporaire";
    bouton.textContent = "geste";
    c.append(bouton);
    bouton.focus();
  });
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("geste-temporaire");
  await page.evaluate(() => {
    globalThis.__banc.occ += 1;
    globalThis.__banc.rendeur.reveiller();
  });
  await publier(page, 1);
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("parcours-titre");
});
