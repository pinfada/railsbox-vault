#!/usr/bin/env node
// SPIKE JETABLE (#310, Révision 2, constat 2 / L7). Hors produit, sans PR.
//
//   node tools/spike-c1-course-onglets.mjs [--balayage]
//
// Deux Workers dédiés RÉELS (deux fils, OPFS réel de Chromium), pauses contrôlées par le script.
// A = le Worker qui tient le volume et révoque ; B = celui qui déverrouille avec une clé que A va
// révoquer. Voir `public/spike/c1-course-onglets/worker.mjs` pour ce qui est rejoué.

import { spawn } from "node:child_process";
import { chromium } from "@playwright/test";

const PORT = 4781;
const serveur = spawn("node", ["tools/serve.mjs", "--role", "shell", "--host", "127.0.0.1", "--port", String(PORT)], { stdio: "ignore" });
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
const cle = () => Array.from(crypto.getRandomValues(new Uint8Array(32)), (o) => o.toString(16).padStart(2, "0")).join("");

async function main() {
  for (let i = 0; i < 50; i += 1) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/spike/c1-course-onglets/index.html`)).ok) break; } catch {}
    await attendre(200);
  }
  const navigateur = await chromium.launch();
  const page = await (await navigateur.newContext()).newPage();
  page.on("pageerror", (e) => console.error("pageerror", e.message));
  await page.goto(`http://127.0.0.1:${PORT}/spike/c1-course-onglets/index.html`);
  await page.waitForFunction(() => globalThis.spike);
  const kekA = cle();
  const kekB = cle();

  // Une expérience = une fonction exécutée DANS la page (elle crée ses deux Workers).
  const jouer = (nom, options = {}) =>
    page.evaluate(async ({ nom, kekA, kekB, options }) => {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const A = globalThis.spike.creer();
      const B = globalThis.spike.creer();
      await A.pret; await B.pret;
      const sortie = { nom };
      try {
        sortie.preparation = await A.appel("preparer", { kekA, kekB });
        sortie.A_ouvre = await A.appel("ouvrir", { kek: kekA, pause: false }); // A TIENT le volume
        if (nom === "controle-revoque-avant") {
          sortie.A_revoque = await A.appel("revoquer", { kek: kekA });
          sortie.B_ouvre = await B.appel("ouvrir", { kek: kekB, pause: false });
        } else if (nom === "controle-busy") {
          sortie.B_ouvre = await B.appel("ouvrir", { kek: kekB, pause: false });
        } else if (nom === "course-controlee") {
          const finB = B.appel("ouvrir", { kek: kekB, pause: true });
          await B.evenement("enveloppe-ouverte"); // B tient la DEK, n'a PAS le handle
          sortie.B_sonde_avant = await A.appel("sonder", { kek: kekB });
          sortie.A_revoque = await A.appel("revoquer", { kek: kekA });
          sortie.B_sonde_apres_revocation = await A.appel("sonder", { kek: kekB });
          await A.appel("fermer"); // A relâche le volume
          await B.appel("reprendre");
          sortie.B_ouvre = await finB;
          if (sortie.B_ouvre.ok) {
            sortie.B_lit_le_volume = await B.appel("lire");
            sortie.B_tente_de_revoquer = await B.appel("essayerLaRevocation", { kek: kekB });
            sortie.B_cle_apres = await A.appel("sonder", { kek: kekB });
            sortie.A_cle_apres = await A.appel("sonder", { kek: kekA });
          }
        } else if (nom === "naturelle") {
          const finB = B.appel("ouvrir", { kek: kekB, pause: false });
          await sleep(options.delai);
          const revoc = (async () => { await A.appel("revoquer", { kek: kekA }); await A.appel("fermer"); })();
          sortie.B_ouvre = await finB;
          await revoc;
          sortie.B_sonde_fin = await A.appel("sonder", { kek: kekB });
        }
      } catch (e) {
        sortie.exception = String(e);
      } finally {
        A.tuer(); B.tuer();
      }
      return sortie;
    }, { nom, kekA, kekB, options });

  const resultats = {};
  for (const nom of ["controle-revoque-avant", "controle-busy", "course-controlee"]) {
    resultats[nom] = await jouer(nom);
    console.log(JSON.stringify(resultats[nom]));
  }
  if (process.argv.includes("--chrono")) {
    const mesures = await page.evaluate(async ({ kekA, kekB }) => {
      const sorties = [];
      for (let i = 0; i < 15; i += 1) {
        const A = globalThis.spike.creer(); await A.pret;
        await A.appel("preparer", { kekA, kekB });
        sorties.push(await A.appel("chronometrer", { kek: kekA }));
        A.tuer();
      }
      return sorties;
    }, { kekA, kekB });
    const med = (k) => mesures.map((m) => m[k]).sort((a, b) => a - b)[Math.floor(mesures.length / 2)];
    const max = (k) => Math.max(...mesures.map((m) => m[k]));
    console.log(JSON.stringify({ chrono: { n: mesures.length, medianes: { enveloppeMs: med("enveloppeMs"), fenetreMs: med("fenetreEnveloppeVersVolumeMs"), revocationMs: med("revocationMs"), fermetureMs: med("fermetureMs") }, maxima: { fenetreMs: max("fenetreEnveloppeVersVolumeMs"), revocationMs: max("revocationMs") } } }));
  }
  if (process.argv.includes("--balayage")) {
    const classes = {};
    const tab = (cl) => { classes[cl] = (classes[cl] ?? 0) + 1; };
    const exemples = [];
    for (let delai = 0; delai <= 120; delai += 3) {
      for (let rep = 0; rep < 4; rep += 1) {
        const r = await jouer("naturelle", { delai });
        let cl;
        if (r.exception) cl = `exception`;
        else if (r.B_ouvre?.etape === "enveloppe" && !r.B_ouvre.ok) cl = `B refusé à l'enveloppe (${r.B_ouvre.code})`;
        else if (r.B_ouvre?.etape === "volume" && !r.B_ouvre.ok) cl = `B enveloppe ok puis volume refusé (${r.B_ouvre.code})`;
        else if (r.B_ouvre?.ok && r.B_sonde_fin?.ouvre === false) cl = "COURSE : B ouvre le volume, sa clé est révoquée";
        else if (r.B_ouvre?.ok) cl = "B ouvre le volume, clé encore valable";
        else cl = "autre";
        tab(cl);
        if (cl.startsWith("COURSE") && exemples.length < 3) exemples.push({ delai, r });
      }
    }
    console.log(JSON.stringify({ balayage: classes, exemples }));
  }
  await navigateur.close();
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => serveur.kill());
