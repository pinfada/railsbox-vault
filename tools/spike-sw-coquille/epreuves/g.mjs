// G — OCTETS EXÉCUTÉS ET DÉMARRAGE INITIAL (constat HIGH 3) : bootstrap de confiance, puis clients
// effectivement contrôlés ; GARDE FERMÉE pour tout chargement exécutable non épinglé, sans intercepter
// /artifacts/** ; épreuves : aucun contrôleur, premier contrôle, URL inattendue, redirection,
// variantes de requête (query, casse, `//`), types MIME.
import { jusqua, attendre, ORIGINE_COQUILLE, PORT_APPLICATION } from "../banc/cadre.mjs";
import { MAUVAIS } from "../banc/serveur.mjs";
import { generationApplication, v1 } from "./aide.mjs";

export const epreuves = [];
const ajouter = (id, titre, run, extra = {}) => epreuves.push({ id, titre, run, ...extra });

/** Une génération dont l'origine sert AUSSI des fichiers que la liste n'épingle pas (pièges). */
function avecPieges(options = {}) {
  const generation = v1(options);
  for (const [chemin, corps] of [
    ["/spike/inconnu.mjs", MAUVAIS],
    ["/spike/inconnu-worker.mjs", "self.postMessage({ exec: 'MAUVAIS-WORKER' });\n"],
    ["/spike/inconnu.js", "self.__MAUVAIS = 1; globalThis.__MAUVAIS = 1;\n"],
    ["/spike/inconnu.json", '{"V":"MAUVAIS"}'],
  ]) {
    generation.fichiers.set(chemin, Buffer.from(corps));
  }
  return generation;
}
async function pret(t, generation = avecPieges(), { hostile = true, tolerant = true } = {}) {
  const origine = await t.origineDe(generation);
  const contexte = await t.contexte();
  await t.installer(contexte);
  const page = await t.bancControle(contexte);
  origine.hostile = hostile;
  origine.tolerant = tolerant;
  origine.vider();
  return { origine, contexte, page };
}

ajouter("G1", "AUCUN CONTRÔLEUR : première visite — le bootstrap vient de l'origine (écrit), le portail refuse et ne crée aucun Worker", async (t) => {
  const origine = await t.origineDe(v1());
  const contexte = await t.contexte();
  const page = await contexte.newPage();
  await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
  await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
  const r = await page.evaluate(async () => ({ controleur: navigator.serviceWorker.controller !== null, portail: await window.banc.ouvrirLePortail() }));
  t.mesure("premiereVisite", r);
  t.verifier(r.controleur === false && r.portail.autorise === false && r.portail.code === "VAULT_COQUILLE_RESERVE_ABSENTE" && r.portail.crees === 0, "sans contrôleur : VAULT_COQUILLE_RESERVE_ABSENTE (aucun-controleur), aucun Worker créé");
  const reseau = origine.requetes((x) => x.chemin.startsWith("/spike/") || x.chemin === "/src/vm/derivation/argon2-vendu.mjs");
  t.mesure("octetsDuBootstrap", reseau.map((x) => x.chemin));
  t.verifier(reseau.length >= 3, "LIMITE ÉCRITE : page, banc.mjs et leurs imports de la première visite ont été servis par le RÉSEAU, avant tout contrôle (confiance à la première utilisation, pas de garantie d'octets)");
});

ajouter("G2", "PREMIER CONTRÔLE : la page qui enregistre reste non contrôlée ; après navigation, TOUT le code de la vraie coquille vient du SW (aucune requête réseau hors /artifacts, VM et script du SW)", async (t) => {
  const generation = v1({ sansFixtures: true });
  const origine = await t.origineDe(generation);
  await t.origineDe(generationApplication(), { port: PORT_APPLICATION, hote: "localhost", role: "app" });
  const contexte = await t.contexte();
  const page = await contexte.newPage();
  await page.goto(ORIGINE_COQUILLE + "/index.html");
  await attendre(500);
  await page.evaluate(async () => {
    const r = await navigator.serviceWorker.register("/sw-coquille.mjs", { scope: "/", updateViaCache: "none" });
    const ver = r.installing ?? r.waiting ?? r.active;
    await new Promise((ok) => {
      const s = () => ver.state === "activated" && ok();
      ver.addEventListener("statechange", s);
      s();
    });
  });
  const controleeApres = await page.evaluate(() => navigator.serviceWorker.controller !== null);
  t.verifier(controleeApres === false, "la page qui vient d'enregistrer n'est pas contrôlée (pas de claim)");
  origine.hostile = true;
  origine.vider();
  const reponses = [];
  page.on("response", (reponse) => {
    if (reponse.url().startsWith(ORIGINE_COQUILLE)) reponses.push({ chemin: new URL(reponse.url()).pathname, sw: reponse.fromServiceWorker() });
  });
  await page.goto(ORIGINE_COQUILLE + "/index.html?vue=complete");
  const prete = await jusqua(() => page.evaluate(() => document.documentElement.dataset.coquille === "prete"), { delaiMs: 60000 });
  t.verifier(prete, "la coquille réelle devient prête alors que l'origine répond MAUVAIS à tout le code");
  const hors = reponses.filter((r) => !r.sw);
  t.mesure("reponsesSW", reponses.length);
  t.mesure("reponsesHorsSW", hors);
  t.verifier(reponses.length > 20 && hors.every((r) => r.chemin.startsWith("/artifacts/") || r.chemin.startsWith("/vendor/v86/artefacts/") && !r.chemin.includes("libv86")), "toute réponse de code vient du SW ; seules passent /artifacts/** et les artefacts de VM nommés");
  const journal = origine.requetes((x) => x.chemin !== "/sw-coquille.mjs" && !x.chemin.startsWith("/artifacts/") && !x.chemin.startsWith("/vendor/v86/artefacts/"));
  t.mesure("requetesReseauDeCode", journal.map((x) => x.chemin));
  t.verifier(journal.length === 0, "l'origine n'a reçu AUCUNE requête de code après le premier contrôle");
});

ajouter("G3", "URL INATTENDUE : fetch, import(), Worker, wasm, <script>, importScripts d'un fichier que l'origine sert mais que la liste n'épingle pas → refusés, jamais exécutés ; MUTANT « hors liste → réseau » exécute l'origine", async (t) => {
  for (const [nom, variante] of [["nominal", {}], ["mutant-hors-liste-au-reseau", { horsListeAuReseau: true }]]) {
    const { origine, contexte, page } = await pret(t, avecPieges({ variante }));
    const r = await page.evaluate(async () => {
      const sortie = {};
      const attente = (ms) => new Promise((ok) => setTimeout(ok, ms));
      try {
        const rep = await fetch("/spike/inconnu.json");
        sortie.fetch = { statut: rep.status, refus: rep.headers.get("X-Vault-Refus"), corps: (await rep.text()).slice(0, 30) };
      } catch (e) {
        sortie.fetch = { erreur: e.name };
      }
      try {
        const m = await import("/spike/inconnu.mjs");
        sortie.import = { exec: m.V };
      } catch (e) {
        sortie.import = { erreur: e.name };
      }
      sortie.worker = await new Promise((ok) => {
        const w = new Worker("/spike/inconnu-worker.mjs", { type: "module" });
        w.onmessage = (e) => ok({ exec: e.data.exec });
        w.onerror = () => ok({ erreur: "error" });
        setTimeout(() => ok({ silence: true }), 3000);
      });
      try {
        const rep = await fetch("/spike/inconnu.json");
        await WebAssembly.compile(await rep.arrayBuffer());
        sortie.wasm = { compile: true };
      } catch (e) {
        sortie.wasm = { erreur: e.name };
      }
      sortie.script = await new Promise((ok) => {
        const s = document.createElement("script");
        s.src = "/spike/inconnu.js";
        s.onload = () => ok({ charge: true, exec: globalThis.__MAUVAIS === 1 });
        s.onerror = () => ok({ erreur: "onerror" });
        document.head.append(s);
        setTimeout(() => ok({ silence: true }), 3000);
      });
      const w = window.banc.creerTravailleur();
      sortie.importScripts = await window.banc.dialogue(w, { type: "importscripts", url: "/spike/inconnu.js" }, 3000);
      return sortie;
    });
    t.mesure(`resultat-${nom}`, r);
    const mauvais = JSON.stringify(r).includes("MAUVAIS") || r.import.exec || r.worker.exec || r.script.exec || r.importScripts.ok === true;
    if (nom === "nominal") {
      t.verifier(!mauvais, "rien de ce que l'origine sert hors liste n'est exécuté (fetch, import(), Worker, wasm, <script>, importScripts)");
      t.verifier(r.fetch.statut === 503 && r.fetch.refus === "HORS_LISTE", "fetch hors liste → 503 X-Vault-Refus: HORS_LISTE");
      t.verifier(origine.requetes((x) => x.chemin.startsWith("/spike/inconnu")).length === 0, "l'origine n'a reçu AUCUNE de ces requêtes");
    } else {
      t.verifier(Boolean(mauvais), "MUTANT : avec l'ancienne politique « hors liste → réseau », le code de l'origine hostile s'exécute (la garde fermée est nécessaire)");
    }
    await contexte.close();
    await origine.arreter();
    t.origines.length = 0;
    t.origine = null;
  }
});

ajouter("G4", "VARIANTES DE REQUÊTE : query, fragment, casse, `//`, barre finale, %-encodages, antislash, `..`, `%2f` sous /artifacts/ — jamais d'octets de l'origine hostile", async (t) => {
  const { origine, page } = await pret(t);
  const variantes = [
    ["/spike/lib.mjs", "liste"],
    ["/spike/lib.mjs?x=1&y=2", "liste (la clé est le chemin, sans la requête)"],
    ["/spike/lib.mjs#fragment", "liste (le fragment n'est pas envoyé)"],
    ["/spike/./lib.mjs", "liste (dot-segment normalisé par le navigateur)"],
    ["/artifacts/../spike/lib.mjs", "liste (normalisé avant le SW)"],
    ["/artifacts/%2e%2e/spike/lib.mjs", "liste (%2e%2e normalisé par le navigateur — à vérifier par moteur)"],
    ["/Spike/lib.mjs", "refus"],
    ["/spike/LIB.MJS", "refus"],
    ["//spike/lib.mjs", "refus"],
    ["/spike//lib.mjs", "refus"],
    ["/spike/lib.mjs/", "refus"],
    ["/spike/lib.mjs%20", "refus"],
    ["/spike/%6cib.mjs", "refus"],
    ["/spike/lib.mjs%00", "refus"],
    ["/artifacts/..%2fspike/lib.mjs", "refus"],
    ["/artifacts/%2e%2e%2fspike/lib.mjs", "refus"],
    ["/artifacts/x/..\\..\\spike\\lib.mjs", "liste (antislash converti en / par le navigateur)"],
    ["/artifacts/%5c..%5cspike%5clib.mjs", "refus"],
  ];
  const sortie = [];
  for (const [chemin, attendu] of variantes) {
    const r = await page.evaluate(async (c) => {
      const url = location.origin + c;
      try {
        const rep = await fetch(url);
        const corps = await rep.text();
        return { statut: rep.status, refus: rep.headers.get("X-Vault-Refus"), corps: corps.slice(0, 26), mauvais: corps.includes("MAUVAIS") };
      } catch (e) {
        return { erreur: e.name };
      }
    }, chemin);
    sortie.push({ chemin, attendu, ...r });
  }
  t.mesure("variantes", sortie);
  t.verifier(sortie.every((v) => !v.mauvais), "AUCUNE variante ne rend les octets de l'origine hostile");
  const refusees = sortie.filter((v) => v.attendu === "refus");
  t.verifier(refusees.every((v) => v.statut === 503 || v.erreur), "toute variante qui n'est pas EXACTEMENT un chemin listé est refusée (503 ou échec réseau)");
  const reseau = origine.requetes((x) => !x.chemin.startsWith("/artifacts/") && x.chemin !== "/sw-coquille.mjs");
  t.mesure("requetesVersLOrigine", origine.requetes().map((x) => x.chemin));
  t.verifier(reseau.length === 0, "l'origine n'a reçu aucune requête hors /artifacts/");
  const importees = await page.evaluate(async () => {
    const r = {};
    for (const c of ["/spike/lib.mjs?x=1", "/Spike/lib.mjs", "//spike/lib.mjs"]) {
      try {
        r[c] = (await import(location.origin + c)).LIB ?? "sans LIB";
      } catch (e) {
        r[c] = "refuse:" + e.name;
      }
    }
    return r;
  });
  t.mesure("importDynamique", importees);
  t.verifier(importees["/spike/lib.mjs?x=1"] === "lib-v1" && String(importees["/Spike/lib.mjs"]).startsWith("refuse") && String(importees["//spike/lib.mjs"]).startsWith("refuse"), "import() : query servie, casse et `//` refusées");
});

ajouter("G5", "REDIRECTIONS : sous /artifacts/ une redirection n'est jamais suivie ; à l'installation une redirection fait échouer l'installation ; MUTANT redirection suivie", async (t) => {
  for (const [nom, variante] of [["nominal", {}], ["mutant-redirection-suivie", { passageSuitLesRedirections: true }]]) {
    const { origine, contexte, page } = await pret(t, avecPieges({ variante }));
    origine.regler("/artifacts/redir.json", { redirection: "/spike/inconnu.json" });
    const r = await page.evaluate(async () => {
      try {
        const rep = await fetch("/artifacts/redir.json", { signal: AbortSignal.timeout(5000) });
        return { statut: rep.status, refus: rep.headers.get("X-Vault-Refus"), corps: (await rep.text()).slice(0, 30), redirigee: rep.redirected };
      } catch (e) {
        return { erreur: e.name };
      }
    });
    t.mesure(`redirection-${nom}`, r);
    if (nom === "nominal") t.verifier(r.statut === 503 && r.refus === "PASSAGE_REDIRECTION", "redirection sous /artifacts/ → 503 PASSAGE_REDIRECTION");
    else t.verifier(String(r.corps).includes("MAUVAIS") || r.redirigee === true || r.erreur === "TimeoutError", "MUTANT : la redirection est suivie (octets de la cible rendus, ou réponse redirigée que le moteur n'accepte pas) — le refus nominal disparaît");
    await contexte.close();
    await origine.arreter();
    t.origines.length = 0;
    t.origine = null;
  }
  // Installation : une redirection sur un chemin listé fait échouer l'installation (redirect: "error").
  for (const [nom, variante] of [["nominal", {}], ["mutant-install-suit-les-redirections", { installSuitLesRedirections: true }]]) {
    const origine = await t.origineDe(v1());
    const contexte = await t.contexte();
    const { etat } = await t.installer(contexte);
    const page = await t.bancControle(contexte);
    const copie = Buffer.from('export const LIB = "lib-v1";\n');
    origine.generation.fichiers.set("/spike/lib-copie.mjs", copie);
    const v = v1({ sequence: 2, variante });
    v.fichiers.set("/spike/lib-copie.mjs", copie);
    origine.publier(v);
    origine.regler("/spike/lib.mjs", { redirection: "/spike/lib-copie.mjs" });
    const maj = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration("/");
      const journal = [];
      reg.addEventListener("updatefound", () => {
        journal.push("updatefound");
        reg.installing.addEventListener("statechange", (e) => journal.push(e.target.state));
      });
      const fin = await Promise.race([reg.update().then(() => "resolue", (e) => "rejetee:" + e.name), new Promise((ok) => setTimeout(() => ok("pendante"), 8000))]);
      await new Promise((ok) => setTimeout(ok, 2500));
      journal.push("update()=" + fin);
      return journal;
    });
    t.mesure(`installation-redirigee-${nom}`, { etat, maj });
    if (nom === "nominal") t.verifier(maj.includes("redundant") && !maj.includes("installed"), "installation avec une redirection sur un fichier listé : REFUSÉE");
    else t.verifier(maj.includes("installed"), "MUTANT : redirect:follow installe (même octets) — la rigueur de `redirect: error` est observable ; l'empreinte reste la garde d'intégrité");
    await contexte.close();
    await origine.arreter();
    t.origines.length = 0;
    t.origine = null;
  }
});

ajouter("G6", "TYPES MIME et destinations : sous /artifacts/ aucun type exécutable en passage, aucune destination script/worker ; v86.wasm nommé passe en fetch ; fichiers listés rendus avec le bon type", async (t) => {
  const { origine, page } = await pret(t, avecPieges(), { hostile: false, tolerant: false });
  origine.regler("/artifacts/js.json", { corps: "export const V = 1;", type: "text/javascript" });
  origine.regler("/artifacts/m.wasm", { corps: Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]), type: "application/wasm" });
  origine.regler("/artifacts/m.mjs", { corps: "self.__MAUVAIS = 1;", type: "text/javascript" });
  origine.regler("/artifacts/page.html", { corps: "<script>1</script>", type: "text/html" });
  const r = await page.evaluate(async () => {
    const sortie = {};
    const voir = async (nom, u) => {
      try {
        const rep = await fetch(u);
        sortie[nom] = { statut: rep.status, refus: rep.headers.get("X-Vault-Refus"), type: rep.headers.get("Content-Type") };
      } catch (e) {
        sortie[nom] = { erreur: e.name };
      }
    };
    await voir("jsEnDonnee", "/artifacts/js.json");
    await voir("wasmEnDonnee", "/artifacts/m.wasm");
    await voir("htmlEnDonnee", "/artifacts/page.html");
    await voir("descripteur", "/artifacts/application.json");
    await voir("v86Nomme", "/vendor/v86/artefacts/v86-8a969d64cf8f64b8.wasm");
    try {
      sortie.importArtifacts = { exec: (await import("/artifacts/m.mjs")).V };
    } catch (e) {
      sortie.importArtifacts = { erreur: e.name };
    }
    sortie.workerArtifacts = await new Promise((ok) => {
      const w = new Worker("/artifacts/m.mjs", { type: "module" });
      w.onerror = () => ok({ erreur: "error" });
      setTimeout(() => ok({ silence: true }), 2500);
    });
    sortie.scriptArtifacts = await new Promise((ok) => {
      const s = document.createElement("script");
      s.src = "/artifacts/m.mjs";
      s.onload = () => ok({ charge: true, exec: globalThis.__MAUVAIS === 1 });
      s.onerror = () => ok({ erreur: "onerror" });
      document.head.append(s);
      setTimeout(() => ok({ silence: true }), 2500);
    });
    sortie.types = {};
    for (const c of ["/spike/banc.mjs", "/vendor/argon2/argon2.wasm", "/spike/banc.html", "/coquille/parcours.css", "/favicon.ico"]) {
      const rep = await fetch(c);
      sortie.types[c] = [rep.headers.get("Content-Type"), rep.headers.get("X-Content-Type-Options")];
    }
    return sortie;
  });
  t.mesure("mime", r);
  t.verifier(r.jsEnDonnee.refus === "PASSAGE_TYPE_EXECUTABLE" && r.wasmEnDonnee.refus === "PASSAGE_TYPE_EXECUTABLE" && r.htmlEnDonnee.refus === "PASSAGE_TYPE_EXECUTABLE", "sous /artifacts/, un contenu servi avec un type de script, wasm ou HTML est refusé");
  t.verifier(r.descripteur.statut === 200 && r.v86Nomme.statut === 200 && r.v86Nomme.type === "application/wasm", "le descripteur et le v86.wasm NOMMÉ passent (le passage n'intercepte pas les données légitimes)");
  t.verifier(r.importArtifacts.erreur && r.workerArtifacts.erreur && !r.scriptArtifacts.exec, "import(), Worker et <script> sur /artifacts/ sont refusés (destination exécutable)");
  t.verifier(r.types["/spike/banc.mjs"][0].startsWith("text/javascript") && r.types["/vendor/argon2/argon2.wasm"][0] === "application/wasm" && Object.values(r.types).every(([, nosniff]) => nosniff === "nosniff"), "les fichiers listés sont rendus avec le type de leur extension et nosniff");
});

ajouter("G7", "SANS SW (mode qui l'interdit : `serviceWorkers: block`) : la page vient du réseau, le portail refuse (aucun-controleur) et ne crée aucun Worker — Q1, refus par défaut", async (t) => {
  const origine = await t.origineDe(v1());
  const contexte = await t.contexte({ serviceWorkers: "block" });
  const page = await contexte.newPage();
  await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
  await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
  const r = await page.evaluate(async () => {
    let enregistrement;
    try {
      await window.banc.enregistrer();
      enregistrement = "accepte";
    } catch (e) {
      enregistrement = e?.name ?? String(e).slice(0, 40);
    }
    return { enregistrement, controleur: navigator.serviceWorker?.controller ?? null, portail: await window.banc.ouvrirLePortail() };
  });
  t.mesure("sansSW", { enregistrement: r.enregistrement, controleur: r.controleur !== null, portail: r.portail });
  t.verifier(r.portail.autorise === false && r.portail.code === "VAULT_COQUILLE_RESERVE_ABSENTE" && r.portail.crees === 0, `SW interdit (${r.enregistrement}) : RESERVE_ABSENTE, aucun Worker — le refus par défaut a UN seul chemin de code`);
  void origine;
});
