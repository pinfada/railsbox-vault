// S1–S22 : rejeu des épreuves du défi C-K (18/11/2026), sur l'arbre publié du dépôt. Les numéros
// sont ceux du rapport ; S17, S19 et S20 n'y figurent pas et ne sont pas rejoués ici.
import { cpSync, existsSync, mkdirSync } from "node:fs";
import { jusqua, attendre, ORIGINE_APPLICATION, ORIGINE_COQUILLE, PORT_APPLICATION } from "../banc/cadre.mjs";
import { entetesDe, reglesHeadersPubliees } from "../banc/reserve.mjs";
import { attendreEtat, bonjourDuTravailleur, cachesDe, generationApplication, identite, inscription, LIB_V2, majDepuisLaPage, v1, v2 } from "./aide.mjs";

export const epreuves = [];
const ajouter = (id, titre, run, extra = {}) => epreuves.push({ id, titre, run, ...extra });

/** Démarrage nominal : origine v1, contexte, SW installé, page de banc CONTRÔLÉE. */
async function nominal(t, generation = v1()) {
  const origine = await t.origineDe(generation);
  const contexte = await t.contexte();
  const { etat } = await t.installer(contexte);
  t.verifier(etat === "actif", `le SW s'installe et s'active (état: ${etat})`);
  const page = await t.bancControle(contexte);
  t.verifier(await page.evaluate(() => navigator.serviceWorker.controller !== null), "la page de banc est contrôlée par le SW");
  return { origine, contexte, page };
}

ajouter("S1", "SW à la racine sous la CSP de production (classique ET module)", async (t) => {
  for (const type of ["classic", "module"]) {
    const origine = await t.origineDe(v1(), { port: 4293 });
    const contexte = await t.contexte();
    const page = await contexte.newPage();
    await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
    await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
    const r = await page.evaluate((ty) => window.banc.enregistrer({ type: ty }).then((x) => x, (e) => ({ erreur: e.name + ":" + e.message })), type);
    t.mesure(`enregistrement_${type}`, r);
    t.verifier(r.actif === true && r.portee === ORIGINE_COQUILLE + "/", `SW ${type} enregistré à la racine et actif`);
    await contexte.close();
    await origine.arreter();
    t.origines.length = 0;
    t.origine = null;
  }
});

ajouter("S2", "Page rendue par le SW avec ses en-têtes embarqués ; CSP effective ; 0 requête réseau", async (t) => {
  const { origine, contexte } = await nominal(t);
  const page = await contexte.newPage();
  await page.addInitScript(() => {
    window.__violations = [];
    document.addEventListener("securitypolicyviolation", (e) => window.__violations.push(e.violatedDirective));
  });
  origine.vider();
  const reponse = await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
  t.verifier(reponse.fromServiceWorker(), "la navigation est servie par le SW (fromServiceWorker)");
  const attendus = entetesDe(reglesHeadersPubliees(), "/spike/banc.html");
  const recus = reponse.headers();
  const ecarts = Object.entries(attendus).filter(([nom, valeur]) => recus[nom.toLowerCase()] !== valeur);
  t.mesure("ecartsEnTetes", ecarts);
  t.verifier(ecarts.length === 0, "tous les en-têtes de production sont rendus à l'identique par le SW");
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.textContent = "window.__inline = 1";
    document.head.append(s);
  });
  await attendre(300);
  t.verifier((await page.evaluate(() => window.__inline)) === undefined, "un script inline est refusé par la CSP servie par le SW");
  t.verifier((await page.evaluate(() => window.__violations)).some((d) => d.startsWith("script-src")), "la violation script-src est signalée");
  const reseau = origine.requetes((r) => r.chemin !== "/sw-coquille.mjs");
  t.mesure("requetesReseau", reseau.map((r) => r.chemin));
  t.verifier(reseau.length === 0, "aucune requête réseau pour la page et ses modules (hors script du SW)");
});

ajouter("S3", "Worker module : script, import statique, import() dynamique rendus par le SW ; l'origine hostile n'est jamais exécutée", async (t) => {
  const { origine, page } = await nominal(t);
  origine.hostile = true;
  origine.vider();
  const bonjour = await page.evaluate(async () => {
    const w = window.banc.creerTravailleur("?use-scheduling-api");
    const b = await window.banc.dialogue(w, { type: "bonjour" });
    const tardif = await window.banc.dialogue(w, { type: "import-tardif" });
    return { b, tardif };
  });
  t.mesure("worker", bonjour);
  t.verifier(bonjour.b.lib === "lib-v1", "import statique : « lib-v1 » exécuté (pas MAUVAIS), URL avec ?use-scheduling-api");
  t.verifier(bonjour.tardif.ok === true && bonjour.tardif.lib === "tardive-v1", "import() dynamique : « tardive-v1 » exécuté");
  t.verifier(origine.requetes((r) => r.chemin.startsWith("/spike/")).length === 0, "l'origine hostile n'a reçu AUCUNE requête de code");
});

ajouter("S4", "Serveur arrêté : page, Worker, import() servis ; un fetch hors réserve lève TypeError", async (t) => {
  const { origine, contexte } = await nominal(t);
  await origine.arreter();
  const page = await contexte.newPage();
  await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
  await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
  const r = await page.evaluate(async () => {
    const w = window.banc.creerTravailleur();
    const b = await window.banc.dialogue(w, { type: "bonjour" });
    const tardif = await window.banc.dialogue(w, { type: "import-tardif" });
    let hors;
    try {
      await fetch("/artifacts/application.json");
      hors = "reponse";
    } catch (e) {
      hors = e.name;
    }
    return { b, tardif, hors };
  });
  t.mesure("horsLigne", r);
  t.verifier(r.b.lib === "lib-v1" && r.tardif.lib === "tardive-v1", "Worker et import() servis serveur arrêté");
  t.verifier(r.hors === "TypeError", "fetch de /artifacts/** serveur arrêté : TypeError (injoignable = échec réseau)");
});

ajouter("S5", "Entrée du Cache altérée par un écrivain de même origine : refus 503 ; entrée supprimée : refus ; `verifier` les nomme", async (t) => {
  const { page } = await nominal(t);
  await page.evaluate(async () => {
    const c = await caches.open("reserve-pub-0001");
    await c.put("/spike/lib-tardive.mjs", new Response('export const LIB_TARDIVE = "alteree";\n'));
    await c.delete("/spike/lib.mjs");
  });
  const r = await page.evaluate(async () => {
    const a = await fetch("/spike/lib-tardive.mjs");
    const b = await fetch("/spike/lib.mjs");
    const w = window.banc.creerTravailleur();
    const bonjour = await window.banc.dialogue(w, { type: "bonjour" });
    const v = await window.banc.interroger("verifier");
    return { alteree: [a.status, a.headers.get("X-Vault-Refus")], supprimee: [b.status, b.headers.get("X-Vault-Refus")], bonjour, v };
  });
  t.mesure("refus", r);
  t.verifier(r.alteree[0] === 503 && r.alteree[1] === "RESERVE_ALTEREE", "entrée altérée → 503 RESERVE_ALTEREE");
  t.note("Un Worker dont le graphe de modules est refusé : Chromium et WebKit émettent `error`, Firefox n'émet RIEN (délai) — le portail ne peut pas s'appuyer sur l'événement.");
  t.verifier(r.supprimee[0] === 503 && r.supprimee[1] === "RESERVE_INCOMPLETE", "entrée supprimée → 503 RESERVE_INCOMPLETE");
  t.verifier(r.bonjour.erreur === "chargement" || r.bonjour.delai === true, "le Worker dont l'import statique est refusé ne se charge pas (événement `error` ou silence selon le moteur)");
  t.verifier(r.v.alteres.includes("/spike/lib-tardive.mjs") && r.v.manquants.includes("/spike/lib.mjs") && r.v.ok === false, "le message `verifier` nomme l'altérée et la manquante");
});

ajouter("S6", "Mise à jour : v2 installée EN ATTENTE ; page et Worker neuf restent v1 ; un rechargement n'active pas l'attente", async (t) => {
  const { origine, page } = await nominal(t);
  origine.publier(v2());
  const maj = await majDepuisLaPage(page);
  t.mesure("maj", maj);
  t.verifier(await attendreEtat(page, "waiting", "installed"), "la v2 est installée et EN ATTENTE");
  const apres = await page.evaluate(async () => {
    const w = window.banc.creerTravailleur();
    return { page: window.banc.VERSION, worker: await window.banc.dialogue(w, { type: "bonjour" }), ctrl: await window.banc.interroger("version") };
  });
  t.verifier(apres.page === "pub-0001" && apres.worker.lib === "lib-v1" && apres.ctrl.sequence === 1, "page, Worker neuf et contrôleur restent en v1");
  await page.reload();
  await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
  const reload = await page.evaluate(async () => ({ ctrl: await window.banc.interroger("version"), insc: await window.banc.etatDInscription() }));
  t.mesure("apresRechargement", reload);
  t.verifier(reload.ctrl.sequence === 1 && reload.insc.waiting === "installed", "un simple rechargement n'active PAS l'attente (la page revient en v1)");
});

ajouter("S6b", "MUTANT skipWaiting en cours de session → mélange de versions (la page v1, le Worker v2)", async (t) => {
  const { origine, page } = await nominal(t);
  await page.evaluate(() => window.banc.surveillerLesChangements());
  origine.publier(v2({ variante: { skipWaiting: true } }));
  await majDepuisLaPage(page);
  await jusqua(
    () => page.evaluate(async () => (await window.banc.interroger("version", 1000, (await navigator.serviceWorker.getRegistration("/")).active))?.sequence === 2),
    { delaiMs: 15000 },
  );
  const r = await page.evaluate(async () => {
    const w = window.banc.creerTravailleur();
    return { page: window.banc.VERSION, pageSeq: window.banc.SEQUENCE, worker: await window.banc.dialogue(w, { type: "bonjour" }), changements: window.banc.journalDesChangements.length };
  });
  t.mesure("melange", r);
  t.verifier(r.pageSeq === 1 && r.worker.sequence === 2, "MÉLANGE mesuré : page v1, Worker v2 (c'est ce que l'absence de skipWaiting interdit)");
});

ajouter("S7", "Installation qui échoue (empreinte fausse) : ancien SW gardé, update() résolue sans erreur ; le Cache partiel est supprimé (le mutant le laisse)", async (t) => {
  for (const [nom, variante] of [["nominal", {}], ["mutant-cache-partiel", { cachePartielConserve: true }]]) {
    const generation = v1();
    const origine = await t.origineDe(generation);
    const contexte = await t.contexte();
    await t.installer(contexte);
    const page = await t.bancControle(contexte);
    origine.publier(v2({ variante }));
    origine.regler("/spike/lib.mjs", { corps: 'export const LIB = "trafique";\n' });
    const r = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const journal = [];
      reg.addEventListener("updatefound", () => {
        journal.push("updatefound");
        const ver = reg.installing;
        ver.addEventListener("statechange", () => journal.push(ver.state));
      });
      let erreur = null;
      try {
        await reg.update();
      } catch (e) {
        erreur = e.name;
      }
      // Chromium retente l'installation d'un script différent qui vient d'échouer (deuxième
      // `updatefound`) : on attend que plus rien n'installe avant de relever les caches.
      for (let i = 0; i < 80 && (reg.installing || i < 15); i += 1) await new Promise((ok) => setTimeout(ok, 100));
      return { journal, erreur, active: Boolean(reg.active), waiting: Boolean(reg.waiting), caches: await caches.keys(), ctrl: await window.banc.interroger("version") };
    });
    t.mesure(`installation-echouee-${nom}`, r);
    if (nom === "nominal") {
      t.verifier(r.erreur === null && r.journal.includes("redundant") && r.waiting === false, "update() résolue SANS erreur alors que l'installation est rejetée (redundant, pas d'attente)");
      t.verifier(r.ctrl.sequence === 1, "l'ancien SW reste le contrôleur");
      t.verifier(JSON.stringify(r.caches) === JSON.stringify(["reserve-pub-0001"]), "le Cache partiel de la v2 est supprimé par le SW");
    } else {
      t.verifier(r.caches.includes("reserve-pub-0002"), "MUTANT : sans nettoyage, le Cache partiel reste (la garde est donc nécessaire)");
    }
    await contexte.close();
    await origine.arreter();
    t.origines.length = 0;
    t.origine = null;
  }
});

ajouter("S8", "Script du SW en 404, 410, 500 ou réseau coupé : update() rejetée, l'inscription survit", async (t) => {
  const { origine, page } = await nominal(t);
  const cas = {};
  for (const statut of [404, 410, 500]) {
    origine.regler("/sw-coquille.mjs", { statut });
    cas[statut] = await majDepuisLaPage(page);
    origine.regler("/sw-coquille.mjs", null);
  }
  await origine.arreter();
  cas.reseau = await majDepuisLaPage(page);
  t.mesure("cas", cas);
  for (const [nom, r] of Object.entries(cas)) t.verifier(r.ok === false && r.erreur === "TypeError", `update() rejetée en TypeError pour ${nom}`);
  t.verifier((await inscription(page))?.active === "activated", "l'inscription survit : aucun retrait automatique par 404/410");
});

ajouter("S9", "Script du SW servi max-age=1 an : update() voit quand même la v2 (updateViaCache none)", async (t) => {
  const { origine, page } = await nominal(t);
  const an = { "Cache-Control": "public, max-age=31536000" };
  origine.regler("/sw-coquille.mjs", { corps: v1().script, type: "text/javascript", entetes: an });
  await majDepuisLaPage(page);
  origine.regler("/sw-coquille.mjs", { corps: v2().script, type: "text/javascript", entetes: an });
  origine.publier(v2());
  await majDepuisLaPage(page);
  t.verifier(await attendreEtat(page, "waiting", "installed"), "la v2 est vue malgré max-age d'un an");
});

ajouter("S10", "Navigations successives : le script du SW est redemandé SANS passer par le SW — mais pas à chaque navigation (on ne s'y fie pas)", async (t) => {
  const { origine, contexte } = await nominal(t);
  const parNavigation = [];
  for (let i = 0; i < 4; i += 1) {
    await attendre(1200);
    origine.vider();
    const page = await contexte.newPage();
    await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
    await attendre(2500);
    parNavigation.push(origine.requetes((r) => r.chemin === "/sw-coquille.mjs").map((r) => r.destination));
    await page.close();
  }
  t.mesure("requetesDuScriptParNavigation", parNavigation);
  t.verifier(parNavigation.some((r) => r.length >= 1 && r.every((d) => d === "serviceworker" || d === null)), "au moins une navigation redemande le script (destination serviceworker, ou absente sous WebKit), hors SW");
  t.note("Garantie NON acquise : sur Chromium 151 certaines navigations ne redemandent rien (voir requetesDuScriptParNavigation). La DoR impose donc un update() explicite à chaque démarrage.");
});

ajouter("S11", "SW de retrait : inscriptions 0, caches du produit vidés ; la page contrôlée le reste jusqu'à sa navigation", async (t) => {
  const { origine, contexte, page } = await nominal(t);
  await page.evaluate(async () => (await caches.open("autre-cache-sans-rapport")).put("/x", new Response("x")));
  origine.publier(v1({ retrait: true, sequence: 3 }));
  await majDepuisLaPage(page);
  t.verifier(await attendreEtat(page, "waiting", "installed"), "le script de retrait s'installe mais ATTEND (pas d'activation forcée)");
  await page.close();
  const ouverte = await contexte.newPage();
  await ouverte.goto(ORIGINE_COQUILLE + "/spike/sans-coop.html");
  const fin = await jusqua(async () => (await ouverte.evaluate(async () => (await navigator.serviceWorker.getRegistrations()).length)) === 0, { delaiMs: 20000 });
  const r = await ouverte.evaluate(async () => ({ regs: (await navigator.serviceWorker.getRegistrations()).length, caches: await caches.keys(), controleurEncore: navigator.serviceWorker.controller !== null }));
  t.mesure("retrait", r);
  t.verifier(Boolean(fin) && r.regs === 0, "après la fermeture des clients, le retrait désinscrit");
  t.verifier(!r.caches.some((n) => n.startsWith("reserve-")) && r.caches.includes("autre-cache-sans-rapport"), "caches du produit supprimés, autre cache de l'origine conservé");
});

ajouter("S12", "unregister() côté page : renvoie true, le Cache N'est PAS vidé", async (t) => {
  const { page } = await nominal(t);
  const r = await page.evaluate(async () => {
    const reg = await navigator.serviceWorker.getRegistration("/");
    const ok = await reg.unregister();
    return { ok, caches: await caches.keys() };
  });
  t.mesure("unregister", r);
  t.verifier(r.ok === true && r.caches.includes("reserve-pub-0001"), "unregister() seul laisse le Cache de la réserve");
});

ajouter("S13", "Deux origines : le SW de la coquille ne voit rien de l'origine applicative ; le cadre ne peut pas enregistrer sur la coquille", async (t) => {
  const { origine, contexte, page } = await nominal(t);
  const app = await t.origineDe(generationApplication(), { port: PORT_APPLICATION, hote: "localhost", role: "app" });
  const message = page.evaluate(
    (url) =>
      new Promise((ok) => {
        window.addEventListener("message", (e) => e.data?.app && ok(e.data.app));
        const f = document.createElement("iframe");
        f.src = url;
        document.body.append(f);
        setTimeout(() => ok({ delai: true }), 15000);
      }),
    ORIGINE_APPLICATION + "/app.html",
  );
  const sortie = await message;
  t.mesure("cadre", sortie);
  t.verifier(sortie.croise === "SecurityError", "le cadre applicatif ne peut pas enregistrer un SW sur l'origine de la coquille (SecurityError)");
  t.verifier(sortie.sw === "actif", "le cadre enregistre son PROPRE SW sur son origine");
  const journal = await page.evaluate(() => window.banc.interroger("journal"));
  t.mesure("journalDuSW", journal.journal);
  t.verifier(journal.journal.horsOrigine === 0 && journal.journal.refus.length === 0, "le SW de la coquille n'a reçu aucun événement pour l'origine applicative");
  t.verifier(app.requetes((r) => r.chemin === "/app.html").length >= 1, "la navigation du cadre est allée à l'origine applicative (réseau), pas au SW de la coquille");
  void origine;
  void contexte;
});

ajouter("S14", "COOP posé sur la réponse fabriquée par le SW : window.opener null ; témoin sans COOP : opener présent ; cadrage tiers", async (t) => {
  const { contexte } = await nominal(t);
  await t.origineDe(generationApplication(), { port: PORT_APPLICATION, hote: "localhost", role: "app" });
  const depart = await contexte.newPage();
  await depart.goto(ORIGINE_APPLICATION + "/opener.html");
  const ouvrir = async (chemin) => {
    const [popup] = await Promise.all([contexte.waitForEvent("page"), depart.evaluate((u) => void window.open(u), ORIGINE_COQUILLE + chemin)]);
    await popup.waitForLoadState("load");
    const opener = await popup.evaluate(() => window.opener === null);
    await popup.close();
    return opener;
  };
  const avec = await ouvrir("/spike/banc.html");
  const temoin = await ouvrir("/spike/sans-coop.html");
  t.mesure("opener", { avecCoop: avec, sansCoop: temoin });
  t.verifier(avec === true, "avec COOP (réponse du SW) : window.opener === null depuis une origine tierce");
  t.verifier(temoin === false, "témoin sans COOP : window.opener présent (l'en-tête est bien ce qui agit)");
  const cadre = await depart.evaluate(
    (u) =>
      new Promise((ok) => {
        window.addEventListener("message", (e) => e.data?.banc && ok("charge"));
        const f = document.createElement("iframe");
        f.src = u;
        document.body.append(f);
        setTimeout(() => ok("refuse"), 4000);
      }),
    ORIGINE_COQUILLE + "/spike/banc.html",
  );
  t.mesure("cadrageTiers", cadre);
  t.verifier(cadre === "refuse", "encadrement de la coquille par une origine tierce refusé");
});

ajouter("S15", "Réserve réelle : temps d'installation", async (t) => {
  const generation = v1();
  const origine = await t.origineDe(generation);
  const contexte = await t.contexte();
  const page = await contexte.newPage();
  await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
  await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
  const ms = await page.evaluate(async () => {
    const t0 = performance.now();
    await window.banc.enregistrer();
    return Math.round(performance.now() - t0);
  });
  t.mesure("installationMs", ms);
  t.mesure("entrees", generation.entrees);
  t.mesure("octets", generation.taille);
  t.verifier(ms < 15000, `installation de ${generation.entrees} fichiers (${generation.taille} octets) en ${ms} ms`);
  void origine;
});

ajouter("S16", "Vérification complète de la réserve (3 passes) et service de libv86 (hachage compris)", async (t) => {
  const generation = v1();
  const { page } = await nominal(t, generation);
  const libv86 = Object.keys(generation.liste).find((c) => /\/libv86-[0-9a-f]+\.mjs$/.test(c));
  const r = await page.evaluate(async (cheminLib) => {
    const passes = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      const v = await window.banc.interroger("verifier", 20000);
      passes.push({ ms: Math.round(performance.now() - t0), ok: v?.ok });
    }
    const servis = [];
    for (let i = 0; i < 3; i += 1) {
      const t0 = performance.now();
      const reponse = await fetch(cheminLib);
      const octets = (await reponse.arrayBuffer()).byteLength;
      servis.push({ ms: Math.round((performance.now() - t0) * 10) / 10, octets });
    }
    return { passes, servis };
  }, libv86);
  t.mesure("verification", r.passes);
  t.mesure("libv86", { chemin: libv86, servis: r.servis });
  t.verifier(r.passes.every((p) => p.ok === true), "la vérification complète réussit sur la vraie réserve");
  t.verifier(r.servis.every((s) => s.octets === generation.liste[libv86].taille), "libv86 est rendu avec ses octets exacts");
});

ajouter("S18", "La vraie coquille publiée, serveur arrêté : prête, canal de confiance établi, argon2.wasm servi, import() de libv86", async (t) => {
  const generation = v1({ sansFixtures: true });
  const origine = await t.origineDe(generation);
  await t.origineDe(generationApplication(), { port: PORT_APPLICATION, hote: "localhost", role: "app" });
  const contexte = await t.contexte();
  const page = await contexte.newPage();
  await page.goto(ORIGINE_COQUILLE + "/index.html");
  const sw = await page.evaluate(async () => {
    const r = await navigator.serviceWorker.register("/sw-coquille.mjs", { scope: "/", updateViaCache: "none" });
    const ver = r.installing ?? r.waiting ?? r.active;
    await new Promise((ok) => {
      const s = () => ver.state === "activated" && ok();
      ver.addEventListener("statechange", s);
      s();
    });
    return true;
  });
  t.verifier(sw, "SW installé depuis la page PRODUIT (aucune fixture, aucun octet du produit modifié)");
  await origine.arreter();
  await page.goto(ORIGINE_COQUILLE + "/index.html?vue=complete");
  const prete = await jusqua(() => page.evaluate(() => document.documentElement.dataset.coquille === "prete"), { delaiMs: 60000 });
  t.verifier(prete, "data-coquille=prete serveur ARRÊTÉ (la page et tous ses modules viennent du SW)");
  const rapport = await page.evaluate(() => JSON.parse(document.querySelector("#coquille-rapport").textContent));
  t.mesure("rapport", { canalPrivilegie: rapport.canalPrivilegie, etat: rapport.etat });
  t.verifier(rapport.canalPrivilegie === "etabli", "le Worker de confiance démarre (canal privilégié établi)");
  const aux = await page.evaluate(async () => {
    const octets = new Uint8Array(await (await fetch("/vendor/argon2/argon2.wasm")).arrayBuffer());
    const lib = Object.keys(window).length;
    return { argon: octets.byteLength, lib };
  });
  t.verifier(aux.argon === 25725, "argon2.wasm (25 725 o) servi serveur arrêté");
});

ajouter("S21", "context.setOffline(true) avec un SW installé : ce que chaque moteur coupe (mesure, pas d'exigence)", async (t) => {
  const { origine, contexte, page } = await nominal(t);
  await contexte.setOffline(true);
  const r = await page.evaluate(async () => {
    const essai = async (u) => {
      try {
        const reponse = await fetch(u);
        return reponse.status;
      } catch (e) {
        return e.name;
      }
    };
    return { sw: await essai("/spike/lib.mjs"), horsReserve: await essai("/artifacts/application.json") };
  });
  t.mesure("setOffline", r);
  t.note("Mesure : chromium attendu {sw:200, horsReserve:TypeError}; firefox attendu {sw:200, horsReserve:200 (setOffline sans effet)}; webkit attendu {sw:TypeError?}. Les épreuves de ce banc coupent le réseau en ARRÊTANT le serveur.");
  t.verifier(typeof r.sw !== "undefined", "relevé obtenu");
  void origine;
});

ajouter("S22", "Profil persistant, navigateur fermé puis rouvert, origine morte : page et Worker servis par le SW", async (t) => {
  const origine = await t.origineDe(v1());
  const { contexte, dir } = await t.contextePersistant();
  const page = await contexte.newPage();
  await page.goto(ORIGINE_COQUILLE + "/spike/enregistrer.html");
  t.verifier(await jusqua(() => page.evaluate(() => document.documentElement.dataset.enregistrement === "actif"), { delaiMs: 30000 }), "SW installé dans le profil");
  await contexte.close();
  await origine.arreter();
  const { contexte: rouvert } = await t.contextePersistant(dir);
  const t0 = Date.now();
  const p = await rouvert.newPage();
  await p.goto(ORIGINE_COQUILLE + "/spike/banc.html");
  await jusqua(() => p.evaluate(() => document.documentElement.dataset.banc === "pret"));
  const ms = Date.now() - t0;
  const r = await p.evaluate(async () => {
    const w = window.banc.creerTravailleur();
    return { b: await window.banc.dialogue(w, { type: "bonjour" }), tardif: await window.banc.dialogue(w, { type: "import-tardif" }) };
  });
  t.mesure("reouverture", { ms, ...r });
  t.verifier(r.b.lib === "lib-v1" && r.tardif.lib === "tardive-v1", "page, Worker et import() servis par le SW après fermeture/réouverture, origine MORTE");
});
