import { expect, test } from "../support/test.mjs";

import { VERDICTS_DURABLES, verdictsAttendus } from "./persistance-attendue.mjs";

// Preuve de niveau NAVIGATEUR de la couche de conduite (#42, `VAULT-PERSIST-001`). La conduite est
// PURE ; ce que le navigateur seul peut prouver, c'est son RENDU accessible dans un vrai DOM — le rôle
// ARIA, l'état de coquille et la promesse de durabilité effectivement posés — et que l'invariant tient
// sur le verdict RÉEL rendu par le vrai `navigator.storage`.
//
// Les branches de logique (chaque verdict, chaque choix) restent prouvées de façon exhaustive par les
// doubles de `tests/unit/vm-persistence-conduct.test.mjs` : les rejouer ici n'apprendrait rien de plus
// que le rendu DOM déjà vérifié.

async function ouvrirBanc(page) {
  await page.goto("/vm/conduite.html");
  await expect(page.locator("#etat")).toHaveText("Banc conduite prêt.");
}

test("un octroi rend un état durable-garanti lisible dans le DOM, en région polie", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);
  const rendu = await page.evaluate(() =>
    globalThis.bancConduite.conduire(globalThis.bancConduite.VERDICTS.granted, {
      userGesture: true,
    }),
  );
  await testInfo.attach("conduite-octroi.json", {
    body: JSON.stringify(rendu, null, 2),
    contentType: "application/json",
  });

  expect(rendu.domShellState).toBe("DURABLE_GARANTI");
  expect(rendu.domDurability).toBe("GARANTIE");
  expect(rendu.durableGuaranteed).toBe(true);
  expect(rendu.domRole).toBe("status");
  expect(rendu.domText.toLowerCase()).toContain("durable");
});

test("un refus rend un état volatile qualifié, non durable, sans jamais promettre le faux", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);
  const rendu = await page.evaluate(() =>
    globalThis.bancConduite.conduire(globalThis.bancConduite.VERDICTS.denied, {
      userGesture: true,
    }),
  );
  await testInfo.attach("conduite-refus.json", {
    body: JSON.stringify(rendu, null, 2),
    contentType: "application/json",
  });

  expect(rendu.domShellState).toBe("POURSUITE_VOLATILE_QUALIFIEE");
  expect(rendu.domDurability).toBe("NON_GARANTIE");
  expect(rendu.durableGuaranteed).toBe(false);
  expect(rendu.domRole).toBe("status");
  // Le texte réutilisé de #9 nomme le refus et offre l'arrêt.
  expect(rendu.domText).toMatch(/persistance/i);
  expect(rendu.domText).toMatch(/arrêter|arrêt/i);
});

test("une attente pendante halte la décision : jamais durable, jamais volatile confirmé", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);
  const rendu = await page.evaluate(() =>
    globalThis.bancConduite.conduire(globalThis.bancConduite.VERDICTS.pending, {
      userGesture: true,
      stance: globalThis.bancConduite.STANCE.proceed,
    }),
  );
  await testInfo.attach("conduite-pendant.json", {
    body: JSON.stringify(rendu, null, 2),
    contentType: "application/json",
  });

  expect(rendu.domShellState).toBe("ATTENTE_RESOLUTION");
  expect(rendu.domDurability).toBe("INCONNUE");
  expect(rendu.durableGuaranteed).toBe(false);
});

// Marquée `@verdict-de-persistance` : voir le commentaire jumeau de `storage-budget.spec.mjs`.
test(
  "le vrai navigator.storage : l'invariant durable ⟹ accordé tient sur le verdict réel",
  { tag: "@verdict-de-persistance" },
  async ({ page }, testInfo) => {
    await ouvrirBanc(page);
    const rendu = await page.evaluate(() => globalThis.bancConduite.depuisNavigateur());
    await testInfo.attach("conduite-navigateur.json", {
      body: JSON.stringify(rendu, null, 2),
      contentType: "application/json",
    });

    // Le verdict ATTENDU de ce projet : sans oracle, l'épreuve serait verte par vacuité (#168).
    expect(verdictsAttendus(testInfo.project.name)).toContain(rendu.verdictState);

    if (rendu.durableGuaranteed === true) {
      // La durabilité garantie n'est atteignable QUE derrière un octroi réel.
      expect(VERDICTS_DURABLES).toContain(rendu.verdictState);
      expect(rendu.domShellState).toBe("DURABLE_GARANTI");
      expect(rendu.domDurability).toBe("GARANTIE");
    } else {
      expect(rendu.domDurability).not.toBe("GARANTIE");
      expect(rendu.domShellState).not.toBe("DURABLE_GARANTI");
    }

    // L'invite non tranchée HALTE la décision : l'ADR 0006 refuse de la ranger avec les refus, et le
    // banc rend maintenant ce verdict-là au lieu de se bloquer sur `persist()` (#168).
    if (rendu.verdictState === "pending") {
      expect(rendu.domShellState).toBe("ATTENTE_RESOLUTION");
      expect(rendu.domDurability).toBe("INCONNUE");
    }
  },
);
