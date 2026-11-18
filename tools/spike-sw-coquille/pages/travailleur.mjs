// Worker MODULE du spike : stand-in du Worker de confiance. Imports statiques (version, lib) +
// import dynamique tardif — les trois chemins par lesquels du code arrive dans un Worker du produit.
import { SEQUENCE, VERSION } from "./version-reserve.mjs";
import { LIB } from "./lib.mjs";

let cle = null; // stand-in de la clé de session : non extractible, jamais renvoyée
self.onmessage = async ({ data }) => {
  if (data.type === "cle") {
    cle = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, [
      "encrypt",
      "decrypt",
    ]);
    self.postMessage({ type: "cle", ok: true, extractible: cle.extractable });
  } else if (data.type === "utiliser-cle") {
    try {
      const iv = new Uint8Array(12);
      const chiffre = await crypto.subtle.encrypt(
        { name: "AES-GCM", iv },
        cle,
        new TextEncoder().encode("session"),
      );
      const clair = new TextDecoder().decode(
        await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cle, chiffre),
      );
      self.postMessage({ type: "utiliser-cle", ok: clair === "session" });
    } catch {
      self.postMessage({ type: "utiliser-cle", ok: false });
    }
  } else if (data.type === "bonjour") {
    self.postMessage({ type: "bonjour", sequence: SEQUENCE, version: VERSION, lib: LIB });
  } else if (data.type === "import-tardif") {
    try {
      const m = await import("./lib-tardive.mjs");
      self.postMessage({ type: "import-tardif", ok: true, lib: m.LIB_TARDIVE, sequence: SEQUENCE });
    } catch (erreur) {
      self.postMessage({
        type: "import-tardif",
        ok: false,
        erreur: String(erreur?.message).slice(0, 120),
      });
    }
  } else if (data.type === "importer-url") {
    try {
      const m = await import(data.url);
      self.postMessage({ type: "importer-url", ok: true, valeurs: Object.keys(m), V: m.V ?? null });
    } catch (erreur) {
      self.postMessage({
        type: "importer-url",
        ok: false,
        erreur: String(erreur?.message).slice(0, 120),
      });
    }
  } else if (data.type === "fetch") {
    try {
      const r = await fetch(data.url, data.init ?? {});
      self.postMessage({
        type: "fetch",
        ok: true,
        statut: r.status,
        refus: r.headers.get("X-Vault-Refus"),
        octets: (await r.arrayBuffer()).byteLength,
      });
    } catch (erreur) {
      self.postMessage({
        type: "fetch",
        ok: false,
        erreur: String(erreur?.name) + ": " + String(erreur?.message).slice(0, 100),
      });
    }
  } else if (data.type === "questionner-sw") {
    // Un Worker (client de type « worker ») essaie de parler au SW : accepté ? (il ne doit pas l'être)
    try {
      const controleur = navigator.serviceWorker?.controller;
      if (!controleur) {
        self.postMessage({
          type: "questionner-sw",
          ok: false,
          raison: navigator.serviceWorker
            ? "pas de contrôleur dans le Worker"
            : "navigator.serviceWorker absent du Worker",
        });
      } else {
        const canal = new MessageChannel();
        const reponse = await new Promise((ok) => {
          canal.port1.onmessage = (e) => ok(e.data);
          controleur.postMessage({ type: "version" }, [canal.port2]);
          setTimeout(() => ok(null), 1500);
        });
        self.postMessage({ type: "questionner-sw", ok: true, reponse });
      }
    } catch (erreur) {
      self.postMessage({ type: "questionner-sw", ok: false, raison: String(erreur?.name) });
    }
  } else if (data.type === "importscripts") {
    try {
      importScripts(data.url);
      self.postMessage({ type: "importscripts", ok: true });
    } catch (erreur) {
      self.postMessage({ type: "importscripts", ok: false, erreur: String(erreur?.name) });
    }
  }
};
