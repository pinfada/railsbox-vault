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
    const limite = Date.now() + 25000;
    while (ver && ver.state !== "activated" && ver.state !== "redundant" && Date.now() < limite) await attendre(50);
    if (!ver || ver.state === "redundant") throw new Error("installation rejetée");
    if (ver.state !== "activated") throw new Error("délai d'activation");
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
  retirerLaCopie: (mutants) => portail.retirerLaCopie({ mutants }),
  /** Le portail, avec compteur de créations de Worker, mutants et crochets nommés (pour les épreuves). */
  async ouvrirLePortail({ delaiVerificationMs = 5000, delaiReponseMs = 3000, crochet = null, mutants = {}, garder = true } = {}) {
    window.__crees = 0;
    const crochets = {};
    if (crochet === "alterer-le-worker") {
      crochets.avantCreation = async () => (await caches.open(`reserve-${VERSION}`)).put("/spike/travailleur.mjs", new Response("self.postMessage({altere:true});"));
    } else if (crochet === "alterer-une-lib") {
      crochets.avantCreation = async () => (await caches.open(`reserve-${VERSION}`)).put("/spike/lib.mjs", new Response('export const LIB = "alteree";'));
    } else if (crochet === "supprimer-le-worker") {
      crochets.avantCreation = async () => (await caches.open(`reserve-${VERSION}`)).delete("/spike/travailleur.mjs");
    } else if (crochet === "changer-de-controleur" || crochet === "changer-de-controleur-tard") {
      const changer = async () => {
        await window.publierV2();
        const reg = await navigator.serviceWorker.getRegistration("/");
        const change = new Promise((ok) => navigator.serviceWorker.addEventListener("controllerchange", ok, { once: true }));
        await reg.update();
        await Promise.race([change, attendre(8000)]);
      };
      // « tôt » : entre la vérification et la décision ; « tard » : entre la décision et la création.
      if (crochet === "changer-de-controleur") crochets.apresVerification = changer;
      else crochets.avantCreation = changer;
    }
    const debut = performance.now();
    const r = await portail.ouvrirLePortail({
      sequencePage: SEQUENCE,
      delaiVerificationMs,
      delaiReponseMs,
      mutants,
      crochets,
      creerLeTravailleur: () => {
        window.__crees += 1;
        return this.creerTravailleur();
      },
    });
    const sortie = { autorise: r.autorise, code: r.code, cause: r.cause, detail: r.detail ?? null, fraicheur: r.fraicheur?.id ?? null, ms: Math.round(performance.now() - debut), crees: window.__crees, chronologie: r.observation?.chronologie ?? null, maj: r.observation?.maj ?? null };
    if (r.travailleur && garder) window.__w = r.travailleur;
    return sortie;
  },
};
document.getElementById("etat").textContent = `banc ${VERSION}`;
document.documentElement.dataset.banc = "pret";
if (window.parent !== window) window.parent.postMessage({ banc: "charge" }, "*");
