// Origine CONTRÔLABLE du spike D1h : sert une `Generation` (banc/reserve.mjs) sous les en-têtes de
// PRODUCTION (`_headers` de l'arbre publié, relu par `analyserHeaders`), et sait mentir, tarder,
// rediriger, tomber. « Réseau coupé » = `arreter()` : les sockets sont détruites, le port refuse.
//
// L'origine HOSTILE de la revue : après `hostile = true`, tout fichier de la réserve répond « MAUVAIS »
// (même type, mêmes en-têtes) — SAUF le script du SW, que le navigateur redemande de toute façon.

import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";

import { RACINE_DEPOT, CHEMIN_DU_SW, arbreDeBase, entetesDe, estEnPassage, reglesHeadersPubliees, typeDe } from "./reserve.mjs";

export const MAUVAIS = "export const V = 'MAUVAIS';\n";

export class Origine {
  constructor({ port, hote = "127.0.0.1", role = "coquille" }) {
    this.role = role;
    this.port = port;
    this.hote = hote;
    this.origine = `http://${hote}:${port}`;
    this.generation = null;
    this.hostile = false;
    /** Réglages par chemin : { delaiMs, pendre, statut, redirection, type, corps } */
    this.regles = new Map();
    this.journal = [];
    this.sockets = new Set();
    this.serveur = null;
    this.enTetes = reglesHeadersPubliees();
  }
  publier(generation) {
    this.generation = generation;
  }
  regler(chemin, reglage) {
    if (reglage === null) this.regles.delete(chemin);
    else this.regles.set(chemin, reglage);
  }
  requetes(filtre = () => true) {
    return this.journal.filter(filtre);
  }
  vider() {
    this.journal.length = 0;
  }
  async demarrer() {
    this.serveur = createServer((requete, reponse) => this.#traiter(requete, reponse));
    this.serveur.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.on("close", () => this.sockets.delete(socket));
    });
    await new Promise((ok, ko) => {
      this.serveur.once("error", ko);
      this.serveur.listen(this.port, this.hote, ok);
    });
  }
  async arreter() {
    if (!this.serveur) return;
    for (const socket of this.sockets) socket.destroy();
    await new Promise((ok) => this.serveur.close(ok));
    this.serveur = null;
  }
  async #traiter(requete, reponse) {
    const url = new URL(requete.url ?? "/", this.origine);
    // Le chemin BRUT (avant toute normalisation du serveur) : c'est ce que voit une origine réelle.
    const brut = (requete.url ?? "/").split("?")[0];
    const chemin = brut === "/" ? "/index.html" : brut;
    this.journal.push({
      methode: requete.method,
      chemin: brut,
      requete: url.search,
      destination: requete.headers["sec-fetch-dest"] ?? null,
      mode: requete.headers["sec-fetch-mode"] ?? null,
      site: requete.headers["sec-fetch-site"] ?? null,
      cacheControl: requete.headers["cache-control"] ?? null,
      range: requete.headers.range ?? null,
      t: Date.now(),
    });
    const reglage = this.regles.get(brut) ?? this.regles.get(chemin);
    if (reglage?.pendre) return; // l'origine accepte la connexion et ne répond jamais
    if (reglage?.delaiMs) await new Promise((r) => setTimeout(r, reglage.delaiMs));
    if (reglage?.statut) {
      reponse.writeHead(reglage.statut, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("statut imposé");
      return;
    }
    if (reglage?.redirection) {
      reponse.writeHead(302, { Location: reglage.redirection }).end();
      return;
    }
    const entetesProduction =
      this.role === "app"
        ? { "Content-Security-Policy": "frame-ancestors http://127.0.0.1:4293", "X-Content-Type-Options": "nosniff", "Cache-Control": "no-store" }
        : { ...entetesDe(this.enTetes, brut), ...(this.regles.get(brut)?.entetes ?? {}) };
    if (reglage?.corps !== undefined) {
      reponse.writeHead(200, { "Content-Type": reglage.type ?? typeDe(chemin), ...entetesProduction }).end(reglage.corps);
      return;
    }
    if (brut === CHEMIN_DU_SW) {
      reponse.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", ...entetesProduction }).end(this.generation.script);
      return;
    }
    // /artifacts/** : le répertoire d'artefacts du dépôt (image de référence), comme `tools/serve.mjs`.
    if (brut.startsWith("/artifacts/") && !brut.includes("..")) {
      try {
        const complet = join(RACINE_DEPOT, decodeURIComponent(brut.slice(1)));
        const taille = statSync(complet).size;
        reponse.writeHead(200, { "Content-Type": typeDe(complet), "Content-Length": taille, ...entetesProduction });
        createReadStream(complet).pipe(reponse);
        return;
      } catch {
        /* retombe sur 404 */
      }
    }
    const fichier = this.generation?.fichiers.get(chemin);
    if (fichier) {
      const corps = this.hostile && !chemin.startsWith("/artifacts/") ? Buffer.from(MAUVAIS) : fichier;
      reponse.writeHead(200, { "Content-Type": typeDe(chemin), "Content-Length": corps.byteLength, ...entetesProduction }).end(corps);
      return;
    }
    // Passage nommé : les artefacts de VM de l'arbre publié (pas dans la réserve).
    const publie = arbreDeBase().get(chemin);
    if (publie && estEnPassage(chemin)) {
      const taille = statSync(publie.disque).size;
      reponse.writeHead(200, { "Content-Type": typeDe(chemin), "Content-Length": taille, ...entetesProduction });
      createReadStream(publie.disque).pipe(reponse);
      return;
    }
    reponse.writeHead(404, { "Content-Type": "text/plain", "Cache-Control": "no-store" }).end("Not found");
  }
}
