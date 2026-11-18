// D — ARGON2 ET WORKER DE DÉRIVATION RÉELS derrière le SW (constat MEDIUM 4). Le produit fait
// `fetch` puis `WebAssembly.instantiate(octets)` (src/vm/derivation/argon2-vendu.mjs:90, :144) :
// c'est CE chemin qui est éprouvé. `instantiateStreaming` n'est jamais invoqué ni revendiqué.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { RACINE_DEPOT } from "../banc/reserve.mjs";
import { jusqua } from "../banc/cadre.mjs";
import { v1 } from "./aide.mjs";

export const epreuves = [];
const ajouter = (id, titre, run, extra = {}) => epreuves.push({ id, titre, run, ...extra });

function parcourir(dossier, motif) {
  const sortie = [];
  for (const nom of readdirSync(dossier)) {
    const complet = join(dossier, nom);
    if (statSync(complet).isDirectory()) sortie.push(...parcourir(complet, motif));
    else if (/\.(mjs|js|html)$/.test(nom) && motif.test(readFileSync(complet, "utf8")))
      sortie.push(complet.replace(RACINE_DEPOT, ""));
  }
  return sortie;
}

async function pret(t, generation = v1({ sansFixtures: false })) {
  const origine = await t.origineDe(generation);
  const contexte = await t.contexte();
  await t.installer(contexte);
  const page = await t.bancControle(contexte);
  return { origine, contexte, page };
}
const HACHAGE = {
  variante: "id",
  mot: [1, 2, 3, 4, 5, 6, 7, 8],
  sel: Array.from({ length: 16 }, (_, i) => i + 1),
  iterations: 2,
  memoireKio: 256,
  parallelisme: 1,
  longueur: 32,
};

ajouter(
  "D0",
  "Périmètre : aucun `instantiateStreaming` ni `importScripts` dans le code publié (src/, public/) — seuls `fetch` + `WebAssembly.instantiate(octets)` sont employés",
  async (t) => {
    const streaming = [
      ...parcourir(join(RACINE_DEPOT, "src"), /instantiateStreaming/),
      ...parcourir(join(RACINE_DEPOT, "public"), /instantiateStreaming/),
    ].filter(
      (c) =>
        !c.includes("/spike/") &&
        !c.includes("/csp/") &&
        !c.includes("/vm/") &&
        !c.includes("compat"),
    );
    const importScripts = [
      ...parcourir(join(RACINE_DEPOT, "src"), /importScripts\(/),
      ...parcourir(join(RACINE_DEPOT, "public"), /importScripts\(/),
    ].filter((c) => !c.includes("/spike/") && !c.includes("/csp/"));
    t.mesure("instantiateStreaming", streaming);
    t.mesure("importScripts", importScripts);
    t.verifier(
      streaming.length === 0,
      "aucun appel à instantiateStreaming dans le code publié de la coquille",
    );
    t.verifier(
      importScripts.length === 0,
      "aucun importScripts dans le code publié : hors périmètre, non revendiqué (la garde fermée s'y applique néanmoins, G3)",
    );
  },
);

ajouter(
  "D1",
  "Argon2 : fetch + WebAssembly.instantiate(octets) servis par le SW, serveur ARRÊTÉ et origine hostile ; mêmes octets de sortie que sous Node ; (instantiateStreaming non invoqué)",
  async (t) => {
    const { origine, contexte } = await pret(t);
    origine.hostile = true;
    await origine.arreter();
    const page = await contexte.newPage();
    await page.goto("http://127.0.0.1:4293/spike/banc.html");
    await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
    const r = await page.evaluate(async (appel) => {
      const appels = [];
      const instancier = WebAssembly.instantiate;
      const flux = WebAssembly.instantiateStreaming;
      WebAssembly.instantiate = function (source, ...reste) {
        appels.push(
          source instanceof ArrayBuffer || ArrayBuffer.isView(source)
            ? "instantiate(octets)"
            : "instantiate(module)",
        );
        return instancier.call(WebAssembly, source, ...reste);
      };
      if (flux)
        WebAssembly.instantiateStreaming = function (...a) {
          appels.push("instantiateStreaming");
          return flux.apply(WebAssembly, a);
        };
      const requetes = [];
      const fetchOrig = window.fetch;
      window.fetch = async (...a) => {
        const rep = await fetchOrig(...a);
        requetes.push({
          url: String(a[0]),
          statut: rep.status,
          refus: rep.headers.get("X-Vault-Refus"),
        });
        return rep;
      };
      const { argon2Vendu } = await import("/src/vm/derivation/argon2-vendu.mjs");
      const sortie = await argon2Vendu().hacher({
        ...appel,
        mot: Uint8Array.from(appel.mot),
        sel: Uint8Array.from(appel.sel),
      });
      return { empreinte: Array.from(sortie), appels, requetes };
    }, HACHAGE);
    t.mesure("chemin", { appels: r.appels, requetes: r.requetes });
    t.verifier(
      r.appels.join(",") === "instantiate(octets)",
      "le produit instancie par WebAssembly.instantiate(octets) (instantiateStreaming non invoqué)",
    );
    t.verifier(
      r.requetes.some((x) => x.url.includes("/vendor/argon2/argon2.wasm") && x.statut === 200),
      "l'artefact a été lu par fetch, rendu par le SW (statut 200, serveur arrêté)",
    );
    // Même calcul sous Node, mêmes octets d'artefact : la sortie doit être identique.
    const { argon2Vendu } = await import(`${RACINE_DEPOT}/src/vm/derivation/argon2-vendu.mjs`);
    const reference = await argon2Vendu({
      chargerArtefact: async () =>
        new Uint8Array(readFileSync(join(RACINE_DEPOT, "vendor/argon2/argon2.wasm"))),
    }).hacher({ ...HACHAGE, mot: Uint8Array.from(HACHAGE.mot), sel: Uint8Array.from(HACHAGE.sel) });
    t.verifier(
      JSON.stringify(Array.from(reference)) === JSON.stringify(r.empreinte),
      "la sortie d'Argon2id dans le navigateur (octets du SW) égale celle de Node (octets du disque)",
    );
  },
);

ajouter(
  "D1b",
  "Argon2 : double barrière — entrée altérée (le SW refuse) ; SW sans contrôle de hachage + octets altérés (le produit refuse par son empreinte épinglée)",
  async (t) => {
    for (const [nom, variante] of [
      ["sw-nominal", {}],
      ["sw-sans-hachage", { serviceSansHachage: true, serviceSansTaille: true }],
    ]) {
      const { origine, contexte, page } = await pret(t, v1({ variante }));
      const r = await page.evaluate(async () => {
        const c = await caches.open("reserve-pub-0001");
        const rep = await c.match("/vendor/argon2/argon2.wasm");
        const octets = new Uint8Array(await rep.arrayBuffer());
        octets[100] ^= 0xff; // un bit retourné, même taille
        await c.put("/vendor/argon2/argon2.wasm", new Response(octets));
        const { argon2Vendu } = await import("/src/vm/derivation/argon2-vendu.mjs");
        try {
          await argon2Vendu().hacher({
            variante: "id",
            mot: new Uint8Array(8),
            sel: new Uint8Array(16),
            iterations: 1,
            memoireKio: 64,
            parallelisme: 1,
            longueur: 32,
          });
          return { refuse: false };
        } catch (e) {
          return { refuse: true, code: e.code ?? null, message: String(e.message).slice(0, 120) };
        }
      });
      t.mesure(`argon2-altere-${nom}`, r);
      t.verifier(
        r.refuse === true,
        `${nom} : Argon2 refuse l'artefact altéré (${r.code ?? ""} ${r.message})`,
      );
      if (nom === "sw-nominal")
        t.verifier(/503|n'a pas pu être lu/.test(r.message), "la barrière est celle du SW (503)");
      else
        t.verifier(
          /empreinte|octets/.test(r.message),
          "la barrière est celle du produit (empreinte épinglée) quand le SW ne contrôle plus rien",
        );
      await contexte.close();
      await origine.arreter();
      t.origines.length = 0;
      t.origine = null;
    }
  },
);

ajouter(
  "D2",
  "Worker de dérivation RÉEL (/derivation-worker.mjs, octets du produit) : dérive une KEK non extractible, serveur arrêté, origine hostile",
  async (t) => {
    const { origine, contexte } = await pret(t);
    origine.hostile = true;
    await origine.arreter();
    const page = await contexte.newPage();
    await page.goto("http://127.0.0.1:4293/spike/banc.html");
    await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
    const r = await page.evaluate(async () => {
      const { IDENTIFIANT_DU_COFFRE } = await import("/src/coquille/identites-du-coffre.mjs");
      const w = new Worker("/derivation-worker.mjs", { type: "module", name: "derivation" });
      const t0 = performance.now();
      const reponse = await new Promise((ok) => {
        w.onmessage = (e) =>
          ok({
            ok: e.data.ok,
            code: e.data.code ?? null,
            message: String(e.data.message ?? "").slice(0, 100),
            extractible: e.data.kek?.extractable,
            algo: e.data.kek?.algorithm?.name,
          });
        w.onerror = () => ok({ erreurWorker: true });
        w.postMessage({
          id: 1,
          phrase: "une phrase de parcours assez longue pour la calibration argon",
          identifiantVolume: IDENTIFIANT_DU_COFFRE,
          identifiantEmplacement: "0b".repeat(8),
        });
        setTimeout(() => ok({ delai: true }), 60000);
      });
      return { ...reponse, ms: Math.round(performance.now() - t0) };
    });
    t.mesure("derivation", r);
    t.verifier(
      r.ok === true && r.extractible === false,
      "le Worker de dérivation réel dérive une KEK (CryptoKey non extractible) depuis les octets du SW",
    );
  },
);
