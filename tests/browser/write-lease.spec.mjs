import { expect, test } from "@playwright/test";

import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";
import { LEASE_STATES, LEASE_STATUS } from "../../src/vm/write-lease.mjs";

// Preuve de niveau NAVIGATEUR du bail d'écriture unique (#8, `VAULT-PERSIST-002`). Plusieurs pages
// réelles du MÊME contexte — donc de la même origine et de la même partition de stockage — se
// disputent le bail par le VRAI Web Locks et le VRAI handle OPFS exclusif, chacune dans son Worker
// dédié. Aucune VM n'est bootée : la preuve n'exerce que le bail sur OPFS et Web Locks.
//
// Le niveau unitaire (`tests/unit/vm-write-lease.test.mjs`) prouve la machine à états sur une horloge
// injectée ; ce niveau-ci prouve que le transport réel respecte les sémantiques qu'elle suppose :
// exclusivité, relais après fermeture EFFECTIVE du handle, récupération après terminaison brutale.

/** Ouvre un banc de bail dans le contexte donné et attend que son Worker soit prêt. */
async function ouvrirBanc(context) {
  const page = await context.newPage();
  await page.goto("/vm/lease.html");
  await expect(page.locator("#bail-etat")).toHaveText("banc-pret");
  await page.evaluate(() => globalThis.bancBail.pret());
  return page;
}

const etatDe = (page) => page.evaluate(() => globalThis.bancBail.etat());

const acquerir = (page, payload) =>
  page.evaluate((options) => globalThis.bancBail.acquerir(options), payload);

const attendreEtat = (page, state, options) =>
  page.evaluate(({ s, o }) => globalThis.bancBail.attendreEtat(s, o), { s: state, o: options });

const attendreStatut = (page, uiStatus, options) =>
  page.evaluate(({ s, o }) => globalThis.bancBail.attendreStatut(s, o), {
    s: uiStatus,
    o: options,
  });

/** Ce moteur ouvre-t-il un handle OPFS exclusif dans un Worker ? Sinon, le bail n'a pas de support. */
async function porteOpfs(page) {
  const { openCode } = await page.evaluate(() => globalThis.bancBail.capacite());
  return openCode === null;
}

test("le moteur porte OPFS dans un Worker, ou le bail échoue par une erreur typée", async ({
  context,
}, testInfo) => {
  const page = await ouvrirBanc(context);
  const { openCode } = await page.evaluate(() => globalThis.bancBail.capacite());
  await testInfo.attach(`bail-capacite-${testInfo.project.name}.json`, {
    body: JSON.stringify({ openCode }, null, 2),
    contentType: "application/json",
  });

  if (testInfo.project.name === "chromium") {
    expect(openCode).toBeNull();
    return;
  }
  if (openCode !== null) expect(openCode).toBe(STORAGE_ERROR_CODES.unsupported);
});

test("deux onglets simultanés : un seul acquiert le bail", async ({ context }) => {
  const a = await ouvrirBanc(context);
  if (!(await porteOpfs(a))) test.skip(true, "OPFS absent de ce moteur.");
  const b = await ouvrirBanc(context);
  const volume = "bail-simultane";

  await Promise.all([
    acquerir(a, { volume, deadlineMs: 5000 }),
    acquerir(b, { volume, deadlineMs: 5000 }),
  ]);

  // Un seul des deux atteint « détenu » ; l'invariant central est là : jamais deux écrivains.
  await expect
    .poll(async () => {
      const etats = [(await etatDe(a))?.state, (await etatDe(b))?.state];
      return etats.filter((s) => s === LEASE_STATES.held).length;
    })
    .toBe(1);

  const etats = [(await etatDe(a)).state, (await etatDe(b)).state].sort();
  expect(etats).toEqual([LEASE_STATES.held, LEASE_STATES.waiting].sort());
});

test("fermeture propre : le second acquiert après libération effective du handle", async ({
  context,
}, testInfo) => {
  const a = await ouvrirBanc(context);
  if (!(await porteOpfs(a))) test.skip(true, "OPFS absent de ce moteur.");
  const b = await ouvrirBanc(context);
  const volume = "bail-relais";

  await acquerir(a, { volume, deadlineMs: 5000 });
  await attendreEtat(a, LEASE_STATES.held);
  await acquerir(b, { volume, deadlineMs: 5000 });
  await attendreEtat(b, LEASE_STATES.waiting);
  expect((await etatDe(b)).state).toBe(LEASE_STATES.waiting);

  await a.evaluate(() => globalThis.bancBail.liberer());

  // B atteint « détenu » : il n'a pu OUVRIR le handle exclusif qu'APRÈS la fermeture effective de
  // celui de A. La réussite de l'ouverture EST la preuve de la libération, pas un simple événement.
  const snapB = await attendreEtat(b, LEASE_STATES.held);
  expect(snapB.state).toBe(LEASE_STATES.held);
  expect(snapB.sinceRequestMs).toBeLessThan(5000);
  await testInfo.attach("bail-relais-delai.json", {
    body: JSON.stringify({ delaiRelaisMs: snapB.sinceRequestMs }, null, 2),
    contentType: "application/json",
  });
});

test("terminaison brutale du Worker détenteur : le bail est récupéré sous 5 s", async ({
  context,
}, testInfo) => {
  const a = await ouvrirBanc(context);
  if (!(await porteOpfs(a))) test.skip(true, "OPFS absent de ce moteur.");
  const b = await ouvrirBanc(context);
  const volume = "bail-crash";

  await acquerir(a, { volume, deadlineMs: 5000 });
  await attendreEtat(a, LEASE_STATES.held);
  await acquerir(b, { volume, deadlineMs: 5000 });
  await attendreEtat(b, LEASE_STATES.waiting);

  // Terminaison BRUTALE : ni release, ni fermeture propre du handle. Web Locks relâche le verrou à
  // la mort du contexte ; le handle mort est réclamé, et B le rouvre après réessai éventuel.
  await a.evaluate(() => globalThis.bancBail.terminer());

  const snapB = await attendreEtat(b, LEASE_STATES.held, { timeoutMs: 8000 });
  expect(snapB.state).toBe(LEASE_STATES.held);
  expect(snapB.sinceRequestMs).toBeLessThan(5000);
  await testInfo.attach("bail-crash-delai.json", {
    body: JSON.stringify({ delaiRecuperationMs: snapB.sinceRequestMs }, null, 2),
    contentType: "application/json",
  });
});

test("onglet suspendu puis réveillé : aucun double écrivain", async ({ context }) => {
  const a = await ouvrirBanc(context);
  if (!(await porteOpfs(a))) test.skip(true, "OPFS absent de ce moteur.");
  const b = await ouvrirBanc(context);
  const volume = "bail-suspension";

  await acquerir(a, { volume, deadlineMs: 30000 });
  await attendreEtat(a, LEASE_STATES.held);
  await acquerir(b, { volume, deadlineMs: 30000 });
  await attendreEtat(b, LEASE_STATES.waiting);

  // « Suspension » : A tient sans relâcher. Un onglet gelé n'est pas mort ; B doit patienter, jamais
  // devenir un second écrivain. On observe la fenêtre entière : à aucun instant B ne détient.
  await b.waitForTimeout(1500);
  expect((await etatDe(b)).state).toBe(LEASE_STATES.waiting);
  const detenteurs = [(await etatDe(a)).state, (await etatDe(b)).state].filter(
    (s) => s === LEASE_STATES.held,
  );
  expect(detenteurs.length).toBe(1);

  // Réveil et fermeture propre : le relais se fait alors, et alors seulement.
  await a.evaluate(() => globalThis.bancBail.liberer());
  const snapB = await attendreEtat(b, LEASE_STATES.held);
  expect(snapB.state).toBe(LEASE_STATES.held);
});

test("volume différent : aucune contention artificielle", async ({ context }) => {
  const a = await ouvrirBanc(context);
  if (!(await porteOpfs(a))) test.skip(true, "OPFS absent de ce moteur.");
  const b = await ouvrirBanc(context);

  await acquerir(a, { volume: "bail-volume-a", deadlineMs: 5000 });
  await acquerir(b, { volume: "bail-volume-b", deadlineMs: 5000 });

  // Deux volumes, deux verrous, deux fichiers : les deux détiennent EN MÊME TEMPS, sans attente.
  const snapA = await attendreEtat(a, LEASE_STATES.held);
  const snapB = await attendreEtat(b, LEASE_STATES.held);
  expect(snapA.state).toBe(LEASE_STATES.held);
  expect(snapB.state).toBe(LEASE_STATES.held);
  expect(snapB.sinceRequestMs).toBeLessThan(5000);
});

test("l'UI distingue attente, écriture et lecture seule", async ({ context }) => {
  const a = await ouvrirBanc(context);
  if (!(await porteOpfs(a))) test.skip(true, "OPFS absent de ce moteur.");
  const b = await ouvrirBanc(context);
  const volume = "bail-ui";

  await acquerir(a, { volume, deadlineMs: 30000 });
  await attendreEtat(a, LEASE_STATES.held);
  await expect(a.locator("#bail-etat")).toHaveText(LEASE_STATUS.writing);

  await acquerir(b, { volume, deadlineMs: 30000 });
  await attendreEtat(b, LEASE_STATES.waiting);
  await expect(b.locator("#bail-etat")).toHaveText(LEASE_STATUS.waiting);

  await a.evaluate(() => globalThis.bancBail.liberer());
  await attendreEtat(a, LEASE_STATES.free);
  await expect(a.locator("#bail-etat")).toHaveText(LEASE_STATUS.readOnly);
});

test("l'UI affiche le conflit d'un bail refusé au bout du délai, mesuré sous 5 s", async ({
  context,
}, testInfo) => {
  const a = await ouvrirBanc(context);
  if (!(await porteOpfs(a))) test.skip(true, "OPFS absent de ce moteur.");
  const b = await ouvrirBanc(context);
  const volume = "bail-conflit";

  await acquerir(a, { volume, deadlineMs: 30000 });
  await attendreEtat(a, LEASE_STATES.held);

  // B demande avec un budget court : jamais servi, il obtient un REFUS explicite avant 5 s.
  await acquerir(b, { volume, deadlineMs: 800 });
  const snapB = await attendreStatut(b, LEASE_STATUS.conflict, { timeoutMs: 5000 });
  expect(snapB.uiStatus).toBe(LEASE_STATUS.conflict);
  await expect(b.locator("#bail-etat")).toHaveText(LEASE_STATUS.conflict);
  expect(snapB.sinceRequestMs).toBeLessThan(5000);
  expect(snapB.sinceRequestMs).toBeGreaterThanOrEqual(700);
  await testInfo.attach("bail-refus-delai.json", {
    body: JSON.stringify({ delaiRefusMs: snapB.sinceRequestMs }, null, 2),
    contentType: "application/json",
  });

  // A détient toujours : le refus de B n'a jamais produit d'accès concurrent.
  expect((await etatDe(a)).state).toBe(LEASE_STATES.held);
});

test("l'UI affiche l'erreur sur un échec de support pendant l'acquisition", async ({ context }) => {
  const page = await ouvrirBanc(context);
  if (!(await porteOpfs(page))) test.skip(true, "OPFS absent de ce moteur.");

  await acquerir(page, { volume: "bail-erreur", deadlineMs: 5000, injectHandleError: true });
  const snap = await attendreStatut(page, LEASE_STATUS.error, { timeoutMs: 5000 });
  expect(snap.uiStatus).toBe(LEASE_STATUS.error);
  await expect(page.locator("#bail-etat")).toHaveText(LEASE_STATUS.error);
});
