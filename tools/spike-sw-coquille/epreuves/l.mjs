// L — FRONTIÈRES (constat LOW 7) : refus explicite des requêtes et messages hors origine et hors liste ;
// une requête INTER-ORIGINE du propre client du SW ; méthodes autres que GET.
import {
  attendre,
  ORIGINE_APPLICATION,
  ORIGINE_COQUILLE,
  PORT_APPLICATION,
} from "../banc/cadre.mjs";
import { generationApplication, v1 } from "./aide.mjs";

export const epreuves = [];
const ajouter = (id, titre, run, extra = {}) => epreuves.push({ id, titre, run, ...extra });

ajouter(
  "L1",
  "REQUÊTE INTER-ORIGINE du propre client du SW (page de la réserve SANS CSP) : le SW la REFUSE (HORS_ORIGINE), l'autre origine ne reçoit rien ; MUTANT « hors origine → réseau » la laisse partir",
  async (t) => {
    for (const [nom, variante] of [
      ["nominal", {}],
      ["mutant-hors-origine-au-reseau", { horsOrigineAuReseau: true }],
    ]) {
      const origine = await t.origineDe(v1({ variante }));
      const app = await t.origineDe(generationApplication(), {
        port: PORT_APPLICATION,
        hote: "localhost",
        role: "app",
      });
      const contexte = await t.contexte();
      await t.installer(contexte);
      const page = await contexte.newPage();
      await page.goto(ORIGINE_COQUILLE + "/spike/sans-csp.html");
      const controlee = await page.evaluate(() => navigator.serviceWorker.controller !== null);
      t.verifier(controlee, "la page sans CSP est un client contrôlé du SW");
      const r = await page.evaluate(async (cible) => {
        const sortie = {};
        try {
          const rep = await fetch(cible + "/app-donnee.txt", { mode: "no-cors" });
          sortie.fetchNoCors = { type: rep.type, statut: rep.status };
        } catch (e) {
          sortie.fetchNoCors = { erreur: e.name };
        }
        try {
          const rep = await fetch(cible + "/app-donnee.txt");
          sortie.fetchCors = { statut: rep.status };
        } catch (e) {
          sortie.fetchCors = { erreur: e.name };
        }
        sortie.image = await new Promise((ok) => {
          const i = new Image();
          i.onload = () => ok("charge");
          i.onerror = () => ok("erreur");
          i.src = cible + "/app-donnee.txt";
          setTimeout(() => ok("silence"), 3000);
        });
        try {
          await import(cible + "/app-sw.js");
          sortie.importDistant = "execute";
        } catch (e) {
          sortie.importDistant = e.name;
        }
        const w = new Worker("/spike/travailleur.mjs", { type: "module" });
        sortie.workerDistant = await new Promise((ok) => {
          w.onmessage = (e) => ok(e.data.erreur ?? e.data.statut ?? e.data.refus ?? "recu");
          w.postMessage({
            type: "fetch",
            url: cible + "/app-donnee.txt",
            init: { mode: "no-cors" },
          });
          setTimeout(() => ok("silence"), 3000);
        });
        return sortie;
      }, ORIGINE_APPLICATION);
      await attendre(500);
      const journal = await page
        .evaluate(() => window.banc?.interroger?.("journal") ?? null)
        .catch(() => null);
      const vus = app.requetes((x) => x.chemin === "/app-donnee.txt" || x.chemin === "/app-sw.js");
      t.mesure(`inter-origine-${nom}`, {
        ...r,
        requetesRecuesParLAutreOrigine: vus.length,
        journalDuSW: journal?.journal ?? "banc absent de cette page",
      });
      if (nom === "nominal") {
        t.verifier(
          vus.length === 0,
          "l'autre origine n'a reçu AUCUNE requête (le SW a refusé avant le réseau, ou la page l'a fait)",
        );
      } else {
        t.verifier(
          vus.length > 0,
          "MUTANT : la requête inter-origine part au réseau — la garde « hors origine » est nécessaire quand la CSP du client ne la couvre pas",
        );
      }
      await contexte.close();
      await origine.arreter();
      await app.arreter();
      t.origines.length = 0;
      t.origine = null;
    }
  },
);

ajouter(
  "L2",
  "MÉTHODES : POST sur un chemin listé ou sous /artifacts/ → refus explicite ; la liste ne répond qu'à GET",
  async (t) => {
    const origine = await t.origineDe(v1());
    const contexte = await t.contexte();
    await t.installer(contexte);
    const page = await t.bancControle(contexte);
    origine.vider();
    const r = await page.evaluate(async () => {
      const essai = async (u, init) => {
        try {
          const rep = await fetch(u, init);
          return { statut: rep.status, refus: rep.headers.get("X-Vault-Refus") };
        } catch (e) {
          return { erreur: e.name };
        }
      };
      return {
        postListe: await essai("/spike/lib.mjs", { method: "POST", body: "x" }),
        postArtifacts: await essai("/artifacts/application.json", { method: "POST", body: "x" }),
        putListe: await essai("/spike/lib.mjs", { method: "PUT", body: "x" }),
        headListe: await essai("/spike/lib.mjs", { method: "HEAD" }),
        getListe: await essai("/spike/lib.mjs"),
      };
    });
    t.mesure("methodes", r);
    t.verifier(
      r.postListe.refus === "HORS_LISTE" && r.putListe.refus === "HORS_LISTE",
      "POST/PUT sur un chemin listé → refus HORS_LISTE",
    );
    t.verifier(
      r.postArtifacts.refus === "PASSAGE_METHODE",
      "POST sous /artifacts/ → refus PASSAGE_METHODE",
    );
    t.verifier(r.getListe.statut === 200, "GET listé servi");
    t.verifier(
      origine.requetes((x) => x.chemin.startsWith("/spike/")).length === 0,
      "aucune de ces requêtes n'a atteint l'origine",
    );
  },
);
