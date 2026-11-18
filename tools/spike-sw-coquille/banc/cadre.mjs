// Cadre d'épreuves du spike D1h : un mini-lanceur, volontairement sans dépendance (pas de plan de test
// à apprendre). Une épreuve = { id, titre, groupe, moteurs?, run(t) }. `t.verifier(vrai, message)`
// enregistre une assertion ; une épreuve est « ok » si toutes ses assertions tiennent et qu'elle n'a
// pas jeté. `t.mesure(nom, valeur)` garde ce qui doit apparaître dans la sortie brute.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { chromium, firefox, webkit } from "@playwright/test";

import { Origine } from "./serveur.mjs";
import { fabriquerGeneration } from "./reserve.mjs";

export const MOTEURS = { chromium, firefox, webkit };
export const PORT_COQUILLE = 4293;
export const PORT_APPLICATION = 4294;
export const ORIGINE_COQUILLE = `http://127.0.0.1:${PORT_COQUILLE}`;
export const ORIGINE_APPLICATION = `http://localhost:${PORT_APPLICATION}`;

export const attendre = (ms) => new Promise((r) => setTimeout(r, ms));

/** Réessaie `fonction` jusqu'à ce qu'elle rende une valeur « vraie », puis la rend (ou `null`). */
export async function jusqua(fonction, { delaiMs = 15000, pasMs = 100 } = {}) {
  const limite = Date.now() + delaiMs;
  let derniere = null;
  while (Date.now() < limite) {
    try {
      derniere = await fonction();
      if (derniere) return derniere;
    } catch {
      /* contexte détruit pendant une navigation : on repose la question */
    }
    await attendre(pasMs);
  }
  return null;
}

export class Epreuve {
  constructor({ moteur, nom, navigateur, versions }) {
    this.moteur = moteur;
    this.nom = nom;
    this.navigateur = navigateur;
    this.versions = versions;
    this.assertions = [];
    this.mesures = {};
    this.origine = null;
    this.contextes = [];
    this.origines = [];
    this.dossiers = [];
    this.notes = [];
  }
  verifier(condition, message) {
    this.assertions.push({ ok: Boolean(condition), message });
    return Boolean(condition);
  }
  mesure(nom, valeur) {
    this.mesures[nom] = valeur;
  }
  note(texte) {
    this.notes.push(texte);
  }
  /** Démarre l'origine de la coquille avec `generation` et rend l'`Origine`. */
  async origineDe(generation, options = {}) {
    const origine = new Origine({ port: options.port ?? PORT_COQUILLE, hote: options.hote ?? "127.0.0.1", role: options.role });
    origine.publier(generation);
    await origine.demarrer();
    this.origines.push(origine);
    this.origine ??= origine;
    return origine;
  }
  async contexte(options = {}) {
    const contexte = await this.navigateur.newContext({ serviceWorkers: "allow", ...options });
    this.contextes.push(contexte);
    return contexte;
  }
  /** Un contexte PERSISTANT (profil sur disque) : fermé puis rouvert pour les épreuves de redémarrage. */
  async contextePersistant(dossier = null) {
    const dir = dossier ?? mkdtempSync(join(tmpdir(), "spike-d1h-"));
    this.dossiers.push(dir);
    const contexte = await MOTEURS[this.moteur].launchPersistentContext(dir, { serviceWorkers: "allow" });
    this.contextes.push(contexte);
    return { contexte, dir };
  }
  /** Ouvre `chemin`, enregistre le SW depuis la page d'amorce, attend l'activation. */
  async installer(contexte, chemin = "/spike/enregistrer.html") {
    const page = await contexte.newPage();
    await page.goto(ORIGINE_COQUILLE + chemin, { waitUntil: "commit" });
    const etat = await jusqua(() => page.evaluate(() => document.documentElement.dataset.enregistrement), { delaiMs: 30000 });
    return { page, etat };
  }
  /** Rend une page du banc, CONTRÔLÉE par le SW (navigation neuve après l'activation). */
  async bancControle(contexte, { query = "" } = {}) {
    const page = await contexte.newPage();
    await page.goto(`${ORIGINE_COQUILLE}/spike/banc.html${query}`);
    await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
    return page;
  }
  async nettoyer() {
    for (const contexte of this.contextes) await contexte.close().catch(() => {});
    for (const origine of this.origines) await origine.arreter().catch(() => {});
    for (const dossier of this.dossiers) rmSync(dossier, { recursive: true, force: true });
  }
}

export { fabriquerGeneration };
