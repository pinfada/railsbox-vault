// P — PORTAIL (constat MEDIUM 6) : délai et refus si le SW ne répond pas, messages mal formés,
// changement de contrôleur entre vérification et création du Worker, entrée altérée APRÈS le portail,
// quota insuffisant, coupure pendant l'installation. Chaque garde est MUTÉE sur le chemin utilisé
// (`mutants` du portail, `variante` du SW) et l'épreuve nominale rougit sous le mutant.
import { attendre, jusqua, ORIGINE_COQUILLE } from "../banc/cadre.mjs";
import { CODES, decider, ETATS } from "../pages/portail.mjs";
import { v1, v2 } from "./aide.mjs";

export const epreuves = [];
const ajouter = (id, titre, run, extra = {}) => epreuves.push({ id, titre, run, ...extra });
const portail = (page, options = {}) => page.evaluate((o) => window.banc.ouvrirLePortail(o), options);

async function pret(t, generation = v1()) {
  const origine = await t.origineDe(generation);
  const contexte = await t.contexte();
  await t.installer(contexte);
  const page = await t.bancControle(contexte);
  return { origine, contexte, page };
}
async function fermer(t, contexte, origine) {
  await contexte.close();
  await origine.arreter();
  t.origines.length = 0;
  t.origine = null;
}

ajouter("P0", "DÉCISION du portail (fonction pure) : chaque refus a son code et sa cause ; l'ordre des vérifications est celui de la DoR", async (t) => {
  const bon = { controleur: true, sequencePage: 1, identite: { sequence: 1, retrait: false }, verification: { manquants: [], alteres: [] }, fraicheur: ETATS.VERIFIEE, controleurChange: false };
  const cas = {
    "aucun contrôleur": [{ ...bon, controleur: false }, CODES.ABSENTE],
    "SW muet (identité)": [{ ...bon, identite: null }, CODES.ABSENTE],
    "SW de retrait actif": [{ ...bon, identite: { sequence: 1, retrait: true } }, CODES.PERIMEE],
    "contrôleur changé": [{ ...bon, controleurChange: true }, CODES.DIVERGENTE],
    "contrôleur d'une autre version": [{ ...bon, identite: { sequence: 2, retrait: false } }, CODES.DIVERGENTE],
    "SW muet (vérification)": [{ ...bon, verification: null }, CODES.ABSENTE],
    "entrées manquantes": [{ ...bon, verification: { manquants: ["/x"], alteres: [] } }, CODES.INCOMPLETE],
    "entrées altérées": [{ ...bon, verification: { manquants: [], alteres: ["/x"] } }, CODES.ALTEREE],
    "révocation connue": [{ ...bon, fraicheur: ETATS.REVOQUEE }, CODES.PERIMEE],
    "nominal": [bon, null],
    "non vérifiable (autorise)": [{ ...bon, fraicheur: ETATS.NON_VERIFIABLE }, null],
    "échouée (autorise)": [{ ...bon, fraicheur: ETATS.ECHOUEE }, null],
    "prête (autorise)": [{ ...bon, fraicheur: ETATS.PRETE }, null],
  };
  const table = {};
  for (const [nom, [entree, code]] of Object.entries(cas)) {
    const d = decider(entree);
    table[nom] = { autorise: d.autorise, code: d.code, cause: d.cause };
    t.verifier(d.code === code && d.autorise === (code === null), `${nom} → ${code ?? "autorise"}`);
  }
  t.mesure("table", table);
});

ajouter("P1", "SW MUET : le portail rend la main au délai avec VAULT_COQUILLE_RESERVE_ABSENTE (silence-du-sw), jamais un blocage, jamais de Worker", async (t) => {
  const { page } = await pret(t, v1({ faute: { muet: true } }));
  const r = await portail(page, { delaiReponseMs: 600, delaiVerificationMs: 1500 });
  t.mesure("portail", r);
  t.verifier(r.autorise === false && r.code === CODES.ABSENTE && r.cause === "silence-du-sw" && r.crees === 0, "refus typé, aucun Worker");
  t.verifier(r.ms < 4000, `borné dans le temps (${r.ms} ms)`);
});

ajouter("P2", "MESSAGES mal formés ou d'un autre client : aucune réponse, compteur de refus ; un Worker (client « worker ») ne peut pas interroger le SW ; MUTANT messagesDeTousLesClients répond au Worker", async (t) => {
  for (const [nom, variante] of [["nominal", {}], ["mutant-tous-les-clients", { messagesDeTousLesClients: true }]]) {
    const { origine, contexte, page } = await pret(t, v1({ variante }));
    const r = await page.evaluate(async () => {
      const ctrl = navigator.serviceWorker.controller;
      const essai = (envoi) =>
        new Promise((ok) => {
          const canal = new MessageChannel();
          const m = setTimeout(() => ok(null), 400);
          canal.port1.onmessage = (e) => {
            clearTimeout(m);
            ok(e.data);
          };
          try {
            envoi(ctrl, canal.port2);
          } catch (e) {
            clearTimeout(m);
            ok("exception:" + e.name);
          }
        });
      const formes = {
        chaine: (c, p) => c.postMessage("version", [p]),
        tableau: (c, p) => c.postMessage(["version"], [p]),
        nul: (c, p) => c.postMessage(null, [p]),
        typeInconnu: (c, p) => c.postMessage({ type: "activer" }, [p]),
        skipWaiting: (c, p) => c.postMessage({ type: "skipWaiting" }, [p]),
        champEnPlus: (c, p) => c.postMessage({ type: "version", extra: 1 }, [p]),
        sansPort: (c) => c.postMessage({ type: "version" }),
        proto: (c, p) => c.postMessage(JSON.parse('{"type":"version","__proto__":{"x":1}}'), [p]),
        trop: (c, p) => c.postMessage({ type: "version", id: "x".repeat(1000) }, [p]),
      };
      const reponses = {};
      for (const [nom, envoi] of Object.entries(formes)) reponses[nom] = await essai(envoi);
      reponses.valide = await essai((c, p) => c.postMessage({ type: "version" }, [p]));
      const w = window.banc.creerTravailleur();
      const duWorker = await window.banc.dialogue(w, { type: "questionner-sw" }, 4000);
      const journal = await essai((c, p) => c.postMessage({ type: "journal" }, [p]));
      return { reponses, duWorker, refuses: journal?.journal?.messagesRefuses };
    });
    t.mesure(`messages-${nom}`, r);
    const sansReponse = ["chaine", "tableau", "nul", "typeInconnu", "skipWaiting", "sansPort", "proto"];
    const atteignable = !String(r.duWorker.raison ?? "").includes("absent du Worker") && !String(r.duWorker.raison ?? "").includes("pas de contrôleur");
    if (nom === "nominal") {
      t.verifier(sansReponse.every((k) => r.reponses[k] === null) && r.reponses.valide?.sequence === 1 && r.reponses.trop === null && r.reponses.champEnPlus === null, "messages mal formés ou hors liste (dont id de 1000 caractères, champ en plus) : AUCUNE réponse ; le message valide est servi");
      t.verifier(r.refuses >= sansReponse.length + 2, `le SW compte ses refus (${r.refuses})`);
      t.verifier(r.duWorker.ok === false || r.duWorker.reponse === null, `un Worker ne peut pas interroger le SW (${JSON.stringify(r.duWorker)})`);
    } else if (atteignable) {
      t.verifier(r.duWorker.ok === true && r.duWorker.reponse?.sequence === 1, "MUTANT : le Worker est répondu — la garde « fenêtre de premier niveau » est nécessaire");
    } else {
      t.note(`NON ÉPROUVÉ sur ${t.moteur} : un Worker n'y expose pas navigator.serviceWorker (${r.duWorker.raison}) ; la garde « client de type window, premier niveau » n'y est pas atteignable par un Worker et son mutant n'est pas tué par cette épreuve.`);
      t.mesure("gardeWorkerNonEprouvee", true);
    }
    await fermer(t, contexte, origine);
  }
});

ajouter("P3", "CONTRÔLEUR CHANGÉ entre la vérification et la création du Worker : refus DIVERGENTE sans Worker ; MUTANTS (sans re-contrôle / sans poignée de main / les deux) tués", async (t) => {
  const cas = [
    ["nominal-tot", {}, { autorise: false, cause: "controleur-change", crees: 0 }, "changer-de-controleur"],
    ["nominal-tard", {}, { autorise: false, cause: "controleur-change", crees: 0 }, "changer-de-controleur-tard"],
    ["mutant-sans-recontrole", { sansRecontrole: true }, { autorise: false, cause: "worker-d-une-autre-version", crees: 1 }, "changer-de-controleur-tard"],
    ["mutant-sans-les-deux", { sansRecontrole: true, sansPoigneeDeMain: true }, { autorise: true }, "changer-de-controleur-tard"],
  ];
  for (const [nom, mutants, attendu, crochet] of cas) {
    const { origine, contexte, page } = await pret(t);
    await page.exposeFunction("publierV2", () => origine.publier(v2({ variante: { skipWaiting: true } })));
    const r = await portail(page, { delaiVerificationMs: 3000, crochet, mutants });
    t.mesure(`changement-${nom}`, r);
    if (nom === "mutant-sans-les-deux") t.verifier(r.autorise === true, "MUTANT (aucune des deux gardes) : le portail AUTORISE un Worker d'une autre version que la page — l'épreuve nominale le tue");
    else t.verifier(r.autorise === false && r.cause === attendu.cause && r.crees === attendu.crees, `${nom} : ${attendu.cause}, ${attendu.crees} Worker créé`);
    await fermer(t, contexte, origine);
  }
});

ajouter("P4", "ENTRÉE ALTÉRÉE APRÈS LE PORTAIL (Worker, import statique, entrée supprimée) : refus typé, jamais de clé ; MUTANTS (SW sans hachage ; + portail sans poignée de main) tués", async (t) => {
  const scenarios = [
    ["worker-altere", "alterer-le-worker", CODES.ALTEREE],
    ["import-statique-altere", "alterer-une-lib", CODES.ALTEREE],
    ["worker-supprime", "supprimer-le-worker", CODES.INCOMPLETE],
  ];
  for (const [nom, crochet, code] of scenarios) {
    const { origine, contexte, page } = await pret(t);
    const r = await portail(page, { crochet, delaiReponseMs: 500 });
    t.mesure(nom, r);
    t.verifier(r.autorise === false && r.code === code, `${nom} : ${code} (${r.cause})`);
    await fermer(t, contexte, origine);
  }
  // Mutants sur le chemin : SW qui ne hache plus → c'est la poignée de main qui rattrape ; sans elle, le Worker altéré est accepté.
  const { origine, contexte, page } = await pret(t, v1({ variante: { serviceSansHachage: true, serviceSansTaille: true } }));
  const rattrape = await portail(page, { crochet: "alterer-le-worker", delaiReponseMs: 500 });
  t.mesure("sw-sans-hachage", rattrape);
  t.verifier(rattrape.autorise === false && rattrape.cause === "worker-d-une-autre-version", "SW sans hachage : le Worker ALTÉRÉ s'exécute mais la poignée de main (version attendue) refuse — défense en profondeur");
  await fermer(t, contexte, origine);
  const p2 = await pret(t, v1({ variante: { serviceSansHachage: true, serviceSansTaille: true } }));
  const nu = await portail(p2.page, { crochet: "alterer-le-worker", delaiReponseMs: 500, mutants: { sansPoigneeDeMain: true } });
  t.mesure("sw-sans-hachage-et-sans-poignee", nu);
  t.verifier(nu.autorise === true, "MUTANTS cumulés (SW sans hachage + portail sans poignée de main) : un Worker altéré est autorisé — l'épreuve nominale le tue");
  await fermer(t, p2.contexte, p2.origine);
});

ajouter("P5", "QUOTA insuffisant à l'installation : installation rejetée, aucun cache, aucun contrôleur → ABSENTE (aucun-controleur) ; simulé (trois moteurs) et RÉEL par CDP (Chromium)", async (t) => {
  // (a) quota simulé par le SW (DOMException QuotaExceededError dans cache.put)
  {
    const { origine, contexte, page } = await (async () => {
      const origine = await t.origineDe(v1({ faute: { quotaApres: 20 } }));
      const contexte = await t.contexte();
      const page = await contexte.newPage();
      await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
      await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
      return { origine, contexte, page };
    })();
    const r = await page.evaluate(async () => {
      let erreur = null;
      try {
        await window.banc.enregistrer();
      } catch (e) {
        erreur = e.message;
      }
      await window.banc.attendre(500);
      return { erreur, caches: await caches.keys(), insc: await window.banc.etatDInscription() };
    });
    t.mesure("quota-simule", r);
    t.verifier(r.erreur === "installation rejetée" && r.caches.length === 0, "quota simulé : installation rejetée, Cache partiel supprimé");
    await page.reload();
    await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
    const p = await portail(page);
    t.verifier(p.autorise === false && p.code === CODES.ABSENTE && p.cause === "aucun-controleur", "portail : RESERVE_ABSENTE, aucun Worker");
    await fermer(t, contexte, origine);
  }
  // (b) quota RÉEL (Chromium seulement : CDP Storage.overrideQuotaForOrigin)
  if (t.moteur === "chromium") {
    const origine = await t.origineDe(v1());
    const contexte = await t.contexte();
    const page = await contexte.newPage();
    await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
    const cdp = await contexte.newCDPSession(page);
    await cdp.send("Storage.overrideQuotaForOrigin", { origin: ORIGINE_COQUILLE, quotaSize: 800000 });
    const r = await page.evaluate(async () => {
      let erreur = null;
      try {
        await window.banc.enregistrer();
      } catch (e) {
        erreur = e.message;
      }
      await window.banc.attendre(500);
      return { erreur, caches: await caches.keys() };
    });
    t.mesure("quota-reel-cdp", r);
    t.verifier(r.erreur === "installation rejetée", "quota RÉEL de 800 000 octets pour 2,9 Mo de réserve : l'installation est rejetée");
    await fermer(t, contexte, origine);
  } else {
    t.note("quota réel non mesuré hors Chromium (pas d'API de pilotage) : seule l'injection de faute couvre ce moteur");
  }
});

ajouter("P6", "COUPURE pendant l'installation (réseau coupé à la 40e requête) : rejetée, Cache partiel supprimé ; reprise une fois le réseau rendu ; puis navigateur FERMÉ en pleine installation et profil rouvert", async (t) => {
  const origine = await t.origineDe(v1());
  const contexte = await t.contexte();
  const page = await contexte.newPage();
  await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
  await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
  origine.coupureApres(40);
  const r = await page.evaluate(async () => {
    let erreur = null;
    try {
      await window.banc.enregistrer();
    } catch (e) {
      erreur = e.message;
    }
    await window.banc.attendre(500);
    return { erreur, caches: await caches.keys() };
  });
  t.mesure("coupure", r);
  t.verifier(r.erreur === "installation rejetée" && r.caches.length === 0, "coupure en cours d'installation : rejetée, aucun Cache partiel");
  origine.coupureApres(null);
  const reprise = await page.evaluate(() => window.banc.enregistrer().then(() => "ok", (e) => e.message));
  t.verifier(reprise === "ok", "reprise : l'installation aboutit quand le réseau revient");
  await fermer(t, contexte, origine);
  // Navigateur FERMÉ pendant l'installation (un fichier pend).
  const o2 = await t.origineDe(v1());
  const { contexte: c1, dir } = await t.contextePersistant();
  const p1 = await c1.newPage();
  await p1.goto(ORIGINE_COQUILLE + "/spike/banc.html");
  await jusqua(() => p1.evaluate(() => document.documentElement.dataset.banc === "pret"));
  o2.regler("/spike/lib-tardive.mjs", { pendre: true });
  p1.evaluate(() => window.banc.enregistrer().catch(() => {})).catch(() => {});
  await attendre(1500);
  await c1.close().catch(() => {});
  o2.regler("/spike/lib-tardive.mjs", null);
  const { contexte: c2 } = await t.contextePersistant(dir);
  const p2 = await c2.newPage();
  await p2.goto(ORIGINE_COQUILLE + "/spike/banc.html");
  await jusqua(() => p2.evaluate(() => document.documentElement.dataset.banc === "pret"));
  const avant = await p2.evaluate(async () => ({ controleur: navigator.serviceWorker.controller !== null, caches: await caches.keys() }));
  t.mesure("apresFermetureEnInstallation", avant);
  t.verifier(avant.controleur === false, "profil rouvert : aucun contrôleur issu d'une installation inachevée");
  const fin = await p2.evaluate(() => window.banc.enregistrer().then(() => "ok", (e) => e.message));
  const noms = await p2.evaluate(() => caches.keys());
  t.mesure("apresReinstallation", noms);
  t.verifier(fin === "ok" && noms.length === 1 && noms[0] === "reserve-pub-0001", "réinstallation propre : exactement un cache complet");
});
