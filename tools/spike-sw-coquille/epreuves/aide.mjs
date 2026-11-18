// Aides communes des épreuves (générations nommées, requêtes de page).
import { fabriquerGeneration } from "../banc/reserve.mjs";
import { jusqua, ORIGINE_COQUILLE } from "../banc/cadre.mjs";

export const LIB_V2 = {
  "/spike/lib.mjs": 'export const LIB = "lib-v2";\n',
  "/spike/lib-tardive.mjs": 'export const LIB_TARDIVE = "tardive-v2";\n',
};
export const v1 = (options = {}) => fabriquerGeneration({ sequence: 1, ...options });
export const v2 = (options = {}) =>
  fabriquerGeneration({ sequence: 2, surcharges: LIB_V2, ...options });

/** Demande à l'inscription de chercher une mise à jour (peut rejeter : on rend la forme observable). */
export function majDepuisLaPage(page) {
  return page.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration("/");
    const t0 = performance.now();
    try {
      await r.update();
      return {
        ok: true,
        ms: Math.round(performance.now() - t0),
        installing: r.installing?.state ?? null,
        waiting: r.waiting?.state ?? null,
      };
    } catch (e) {
      return { ok: false, erreur: e?.name, ms: Math.round(performance.now() - t0) };
    }
  });
}
export const inscription = (page) => page.evaluate(() => window.banc.etatDInscription());
export const attendreEtat = (page, cle, valeur, delaiMs = 20000) =>
  jusqua(async () => (await inscription(page))?.[cle] === valeur, { delaiMs });
export const identite = (page) => page.evaluate(() => window.banc.interroger("version"));
export const cachesDe = (page) => page.evaluate(() => caches.keys());
export const controleurChanges = (page) =>
  page.evaluate(() => window.banc.journalDesChangements.length);
export async function bonjourDuTravailleur(page, query = "") {
  return page.evaluate(async (q) => {
    const w = window.banc.creerTravailleur(q);
    const r = await window.banc.dialogue(w, { type: "bonjour" });
    window.__w = w;
    return r;
  }, query);
}
/** Génération de l'origine APPLICATIVE (autre origine) pour S13/S14/L. */
export function generationApplication() {
  const app = `<!doctype html><meta charset="utf-8"><title>app</title><p id="m">app</p><script>
(async () => {
  const sortie = {};
  try { await navigator.serviceWorker.register('/app-sw.js'); await navigator.serviceWorker.ready; sortie.sw = 'actif'; } catch (e) { sortie.sw = 'erreur:' + e.name; }
  try { await navigator.serviceWorker.register('http://127.0.0.1:4293/sw-coquille.mjs', { scope: 'http://127.0.0.1:4293/' }); sortie.croise = 'accepte'; } catch (e) { sortie.croise = e.name; }
  try { await fetch('/app-donnee.txt'); sortie.donnee = 'ok'; } catch (e) { sortie.donnee = e.name; }
  try { const r = await fetch('http://127.0.0.1:4293/spike/lib.mjs', { mode: 'no-cors' }); sortie.versCoquille = r.type; } catch (e) { sortie.versCoquille = e.name; }
  parent.postMessage({ app: sortie }, '*');
})();
</script>`;
  const swApp = `const vus = []; self.addEventListener('fetch', (e) => { vus.push(new URL(e.request.url).href); });
self.addEventListener('message', async (e) => { const c = await self.clients.matchAll({ includeUncontrolled: true }); e.ports[0].postMessage({ vus, clients: c.map((x) => x.url) }); });`;
  const opener = `<!doctype html><meta charset="utf-8"><title>opener</title><p>opener</p>`;
  return {
    fichiers: new Map([
      ["/app.html", Buffer.from(app)],
      ["/app-sw.js", Buffer.from(swApp)],
      ["/app-donnee.txt", Buffer.from("donnee")],
      ["/opener.html", Buffer.from(opener)],
    ]),
    script: Buffer.alloc(0),
  };
}
export { ORIGINE_COQUILLE };
