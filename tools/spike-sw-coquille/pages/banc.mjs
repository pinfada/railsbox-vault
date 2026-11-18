// Page du banc : une API minimale pour les épreuves (`window.banc`). Rien ici n'est du produit.
import { SEQUENCE, VERSION } from "/spike/version-reserve.mjs";
import * as portail from "/spike/portail.mjs";

const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
window.banc = {
  VERSION,
  SEQUENCE,
  portail,
  journalDesChangements: [],
  controleur() {
    const c = navigator.serviceWorker.controller;
    return c ? { etat: c.state, script: c.scriptURL } : null;
  },
  async enregistrer(options = {}) {
    const registration = await navigator.serviceWorker.register("/sw-coquille.mjs", { scope: "/", updateViaCache: "none", ...options });
    const ver = registration.installing ?? registration.waiting ?? registration.active;
    if (ver && ver.state !== "activated") {
      await new Promise((ok, ko) => {
        const sur = () => {
          if (ver.state === "activated") ok();
          if (ver.state === "redundant") ko(new Error("installation rejetée"));
        };
        ver.addEventListener("statechange", sur);
        sur();
      });
    }
    return { portee: registration.scope, actif: Boolean(registration.active) };
  },
  async etatDInscription() {
    const r = await navigator.serviceWorker.getRegistration("/");
    if (!r) return null;
    return { installing: r.installing?.state ?? null, waiting: r.waiting?.state ?? null, active: r.active?.state ?? null };
  },
  interroger: (type, delai = 3000, cible) => portail.interroger(cible ?? navigator.serviceWorker.controller, type, delai),
  async interrogerAttente(type, delai = 3000) {
    const r = await navigator.serviceWorker.getRegistration("/");
    return r?.waiting ? portail.interroger(r.waiting, type, delai) : "pas-d-attente";
  },
  creerTravailleur(query = "") {
    return new Worker("/spike/travailleur.mjs" + query, { type: "module", name: "spike-confiance" });
  },
  async dialogue(travailleur, message, delai = 5000) {
    return new Promise((resoudre) => {
      const m = setTimeout(() => resoudre({ delai: true }), delai);
      travailleur.addEventListener("message", (e) => {
        clearTimeout(m);
        resoudre(e.data);
      }, { once: true });
      travailleur.addEventListener("error", () => {
        clearTimeout(m);
        resoudre({ erreur: "chargement" });
      }, { once: true });
      travailleur.postMessage(message);
    });
  },
  surveillerLesChangements() {
    navigator.serviceWorker.addEventListener("controllerchange", () => this.journalDesChangements.push(Date.now()));
  },
  attendre,
};
document.getElementById("etat").textContent = `banc ${VERSION}`;
document.documentElement.dataset.banc = "pret";
if (window.parent !== window) window.parent.postMessage({ banc: "charge" }, "*");
