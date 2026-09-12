/**
 * Le COURTIER de la coquille de cadre (`public/cadre/courtier-du-cadre.mjs`), exécuté sous Node avec
 * un Service Worker, un port restreint et un cadre DOUBLES (revue d'intégration de la PR #203,
 * constat 1 ; revue de sécurité, constat 2).
 *
 * Ce que ce fichier prouve :
 *
 *  - pendant un boot, le cadre ne pose AUCUNE requête sur le port restreint, quel que soit le nombre
 *    de fois où le Service Worker le sollicite : il rend « en attente », que le Service Worker change
 *    en page lisible ;
 *  - l'annonce de démarrage réveille l'attente, et la première page est servie APRÈS le démarrage,
 *    sans horloge, sans essai compté, sans abandon définitif — même après une attente très longue ;
 *  - un document sans port répond « sans port » à la question de présence, et devient courtier
 *    seulement une fois le port reçu.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

registerHooks({
  resolve(specifier, context, suivant) {
    if (specifier.startsWith("/src/")) {
      return suivant(pathToFileURL(join(RACINE, specifier)).href, context);
    }
    return suivant(specifier, context);
  },
});

/** Un émetteur minimal : ce que `navigator.serviceWorker` et un `MessagePort` offrent ici. */
function emetteur() {
  const ecouteurs = new Map();
  return {
    addEventListener(type, ecouteur) {
      if (!ecouteurs.has(type)) ecouteurs.set(type, []);
      ecouteurs.get(type).push(ecouteur);
    },
    emettre(type, evenement) {
      for (const ecouteur of ecouteurs.get(type) ?? []) ecouteur(evenement);
    },
  };
}

const serviceWorker = Object.assign(emetteur(), {
  controller: {},
  register: async () => ({}),
});
Object.defineProperty(globalThis, "navigator", {
  value: { serviceWorker },
  configurable: true,
});
// Le courtier est ENCADRÉ par une origine distincte : la lecture du parent JETTE.
globalThis.parent = {
  get location() {
    throw new Error("origine distincte");
  },
};
globalThis.location = { href: "http://localhost:4180/document-applicatif.html", origin: "x" };

const { monterLaCoquilleDeCadre } = await import("../../public/cadre/courtier-du-cadre.mjs");
const { CONTRAT_DU_CADRE, TYPES_DU_CADRE } =
  await import("../../public/cadre/contrat-du-cadre.mjs");
const { TYPES_APPLICATIFS, enveloppeDeMessage } =
  await import("../../src/coquille/contrat-de-messages.mjs");
const { CODES_REFUS_COQUILLE } = await import("../../src/coquille/refus-de-coquille.mjs");

/** Le Service Worker DEMANDE quelque chose au courtier ; rend la réponse du courtier. */
function demanderAuCourtier(type, champs = {}) {
  return new Promise((rendre) => {
    const reponse = { postMessage: rendre };
    serviceWorker.emettre("message", {
      data: { contrat: CONTRAT_DU_CADRE.id, version: CONTRAT_DU_CADRE.version, type, ...champs },
      ports: [reponse],
    });
  });
}

const relayer = (chemin = "/") =>
  demanderAuCourtier(TYPES_DU_CADRE.demande, { methode: "GET", chemin, entetes: {}, corps: null });

const attendre = (ms = 5) => new Promise((regler) => setTimeout(regler, ms));

test("un document SANS port répond « sans port », puis « avec port » une fois courtier", async () => {
  const avant = await demanderAuCourtier(TYPES_DU_CADRE.presence);
  assert.deepEqual(
    { type: avant.type, porte: avant.porte },
    { type: TYPES_DU_CADRE.presenceReponse, porte: false },
  );
});

test("pendant un boot, le cadre n'émet AUCUNE requête ; la première page est servie après le démarrage", async () => {
  const port = Object.assign(emetteur(), { postes: [], start() {} });
  port.postMessage = (message) => port.postes.push(message);
  const repondre = (type, champs) =>
    port.emettre("message", { data: enveloppeDeMessage(type, champs) });
  const navigations = [];
  const cadre = {
    contentWindow: {
      location: { pathname: "/", search: "", replace: (chemin) => navigations.push(chemin) },
    },
    setAttribute() {},
  };
  const faits = [];
  const montee = monterLaCoquilleDeCadre({
    port,
    document: { createElement: () => cadre },
    emplacement: { append() {} },
    publier: (fait) => faits.push(fait),
  });
  assert.deepEqual(montee, { installee: true, motif: null });
  await attendre();

  // Il est COURTIER, désormais.
  const presence = await demanderAuCourtier(TYPES_DU_CADRE.presence);
  assert.equal(presence.porte, true);

  // 1. La première page : UNE question, que la coquille refuse parce que rien ne tourne encore.
  const premiere = relayer("/");
  assert.equal(port.postes.length, 1);
  repondre(TYPES_APPLICATIFS.refus, {
    code: CODES_REFUS_COQUILLE.applicationNonDemarree,
    message: "…",
    correlation: port.postes[0].correlation,
  });
  assert.equal((await premiere).type, TYPES_DU_CADRE.attente);

  // 2. Le BOOT : le Service Worker sollicite le courtier deux cents fois — rechargements, actifs,
  //    impatience de l'utilisateur. Rien ne part sur le port : ni coquille, ni Worker, ni guest.
  for (let rang = 0; rang < 200; rang += 1) {
    const rendu = await relayer(rang % 2 === 0 ? "/" : "/vault.css");
    assert.equal(rendu.type, TYPES_DU_CADRE.attente);
    assert.ok(rendu.depuisMs >= 0);
  }
  assert.equal(port.postes.length, 1, "une requête est partie pendant le boot");
  assert.deepEqual(navigations, [], "le cadre a renavigué sans annonce");

  // 3. Le DÉMARRAGE : la coquille pousse l'annonce de barrière. Le cadre redemande SA page, une fois.
  repondre(TYPES_APPLICATIFS.barriere, { barrieres: 2 });
  assert.deepEqual(navigations, ["/"]);
  const servie = relayer("/");
  assert.equal(port.postes.length, 2);
  repondre(TYPES_APPLICATIFS.requeteHttpReponse, {
    correlation: port.postes[1].correlation,
    statut: 200,
    entetes: { "content-type": "text/html" },
    corps: "PGgxPk9LPC9oMT4=",
  });
  const rendue = await servie;
  assert.equal(rendue.type, TYPES_DU_CADRE.reponse);
  assert.equal(rendue.statut, 200);
  // Aucun abandon n'a été publié, et l'attente est levée.
  assert.equal(
    faits.some((fait) => fait.attente === "abandonnee"),
    false,
  );
  assert.deepEqual(faits.at(-1), { attente: null });

  // 4. Une fois démarrée, une annonce de plus ne renavigue pas le cadre sous les pieds du lecteur.
  repondre(TYPES_APPLICATIFS.barriere, { barrieres: 3 });
  assert.deepEqual(navigations, ["/"]);
});
