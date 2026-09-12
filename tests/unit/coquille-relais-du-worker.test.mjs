/**
 * Le RELAIS côté WORKER DE CONFIANCE (`public/relais-du-worker.mjs`), exécuté sans navigateur ni
 * machine virtuelle (#192 ; revues de la PR #203 : sécurité 3, intégration 7).
 *
 * Le module est chargé TEL QUEL : seuls ses spécificateurs racine (`/src/…`) sont résolus vers le
 * dépôt par un crochet de résolution, exactement ce que le serveur fait pour le navigateur. Le port
 * est un double qui retient ce que le relais poste ; la session guest, un double qui répond.
 *
 * Ce que ce fichier prouve, et qu'aucune épreuve ne produisait :
 *
 *  - un corps que la garde admettait et qu'`atob` refusait faisait JETER le Worker dans son chemin
 *    de refus : trente-deux messages forgés laissaient trente-deux corrélations sans réponse ;
 *  - `VAULT_COQUILLE_REPONSE_HTTP_TROP_GRANDE` et `VAULT_COQUILLE_TROP_DE_REQUETES` sont RENDUS,
 *    et non seulement écrits dans le modèle de menace.
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

const { RELAIS_EN_VOL_MAXIMUM, brancherLeRelaisDuWorker } =
  await import("../../public/relais-du-worker.mjs");
const { TYPES_RELAIS, enveloppeDeMessage } =
  await import("../../src/coquille/contrat-de-messages.mjs");
const { CODES_REFUS_COQUILLE } = await import("../../src/coquille/refus-de-coquille.mjs");
const { PLAFOND_CORPS_DE_REPONSE_OCTETS } = await import("../../src/coquille/relais-http.mjs");

/** Un PORT double : il retient ce que le relais poste, et livre ce qu'on lui envoie. */
function portDouble() {
  const ecouteurs = [];
  const postes = [];
  return {
    postes,
    addEventListener: (_type, ecouteur) => ecouteurs.push(ecouteur),
    start() {},
    postMessage: (message) => postes.push(message),
    livrer: (data) => {
      for (const ecouteur of ecouteurs) ecouteur({ data, ports: [] });
    },
  };
}

/** Une requête relayée, sous l'enveloppe du canal de relais. */
function requete(correlation, champs = {}) {
  return enveloppeDeMessage(TYPES_RELAIS.requete, {
    correlation,
    methode: "GET",
    chemin: "/",
    entetes: {},
    corps: null,
    ...champs,
  });
}

/** Une session qui répond « 200, vide » à tout, et compte ce qu'on lui a demandé. */
function sessionQuiRepond(corps = new Uint8Array(0)) {
  const session = {
    demandes: 0,
    async requeteHttp() {
      session.demandes += 1;
      return { statut: 200, entetes: {}, entetesRepetees: [], corps };
    },
  };
  return session;
}

/** Une réponse « 200, vide » du guest. */
const REPONSE_VIDE = Object.freeze({
  statut: 200,
  entetes: {},
  entetesRepetees: [],
  corps: new Uint8Array(0),
});

/** Laisse le relais finir ce qui est en vol. */
const apresLesPromesses = () => new Promise((regler) => setTimeout(regler, 20));

test("32 corps FORGÉS admis puis refusés par atob : chacun reçoit SON refus, aucun ne jette", async (t) => {
  const rejets = [];
  const surRejet = (raison) => rejets.push(raison);
  process.on("unhandledRejection", surRejet);
  t.after(() => process.off("unhandledRejection", surRejet));

  const port = portDouble();
  const session = sessionQuiRepond();
  brancherLeRelaisDuWorker({ port, sessionCourante: () => session });
  const forges = Array.from({ length: 32 }, (_, rang) => `f${rang}`);
  port.livrer(requete("bon-avant"));
  for (const [rang, correlation] of forges.entries()) {
    port.livrer(requete(correlation, { methode: "POST", corps: rang % 2 === 0 ? "A" : "AAAA=" }));
  }
  port.livrer(requete("bon-apres"));
  await apresLesPromesses();

  assert.deepEqual(rejets, []);
  const parCorrelation = new Map(port.postes.map((message) => [message.correlation, message]));
  assert.equal(port.postes.length, 34, "une réponse par corrélation, ni plus ni moins");
  for (const correlation of forges) {
    const rendu = parCorrelation.get(correlation);
    assert.equal(rendu?.type, TYPES_RELAIS.refus, correlation);
    assert.equal(rendu.code, CODES_REFUS_COQUILLE.requeteHttpRefusee, correlation);
  }
  // Les deux requêtes bien formées sont servies : le banc mesure la garde, pas une panne du montage.
  assert.equal(parCorrelation.get("bon-avant")?.type, TYPES_RELAIS.reponse);
  assert.equal(parCorrelation.get("bon-apres")?.type, TYPES_RELAIS.reponse);
  assert.equal(session.demandes, 2, "aucun corps forgé n'atteint le guest");
});

test("une erreur de la plate-forme portant un `code` étranger rend GESTE_ROMPU, jamais un jet", async () => {
  const port = portDouble();
  brancherLeRelaisDuWorker({
    port,
    sessionCourante: () => ({
      async requeteHttp() {
        throw Object.assign(new Error("panne"), { code: 5 });
      },
    }),
  });
  port.livrer(requete("r1"));
  await apresLesPromesses();
  assert.deepEqual(
    port.postes.map(({ type, code, correlation }) => ({ type, code, correlation })),
    [{ type: TYPES_RELAIS.refus, code: CODES_REFUS_COQUILLE.gesteRompu, correlation: "r1" }],
  );
});

test("une réponse au-delà du plafond est REFUSÉE entière, jamais rendue tronquée (revue #203, 7)", async () => {
  const port = portDouble();
  const trop = new Uint8Array(PLAFOND_CORPS_DE_REPONSE_OCTETS + 1);
  brancherLeRelaisDuWorker({ port, sessionCourante: () => sessionQuiRepond(trop) });
  port.livrer(requete("lourde"));
  await apresLesPromesses();
  assert.equal(port.postes.length, 1);
  assert.equal(port.postes[0].type, TYPES_RELAIS.refus);
  assert.equal(port.postes[0].code, CODES_REFUS_COQUILLE.reponseHttpTropGrande);
  assert.equal(port.postes[0].correlation, "lourde");
  // Au plafond exact, elle passe : la borne est la borne, pas une approximation.
  const juste = portDouble();
  brancherLeRelaisDuWorker({
    port: juste,
    sessionCourante: () => sessionQuiRepond(new Uint8Array(PLAFOND_CORPS_DE_REPONSE_OCTETS)),
  });
  juste.livrer(requete("au-plafond"));
  await apresLesPromesses();
  assert.equal(juste.postes[0].type, TYPES_RELAIS.reponse);
});

test("une rafale au-delà de la borne en vol reçoit TROP_DE_REQUETES, et le guest n'en voit rien", async () => {
  const port = portDouble();
  const reglements = [];
  const session = {
    demandes: 0,
    retenir: true,
    requeteHttp() {
      session.demandes += 1;
      if (!session.retenir) return Promise.resolve(REPONSE_VIDE);
      return new Promise((regler) => reglements.push(regler));
    },
  };
  brancherLeRelaisDuWorker({ port, sessionCourante: () => session });
  for (let rang = 0; rang <= RELAIS_EN_VOL_MAXIMUM; rang += 1) port.livrer(requete(`q${rang}`));
  await apresLesPromesses();

  assert.equal(session.demandes, RELAIS_EN_VOL_MAXIMUM);
  assert.deepEqual(
    port.postes.map(({ code, correlation }) => ({ code, correlation })),
    [{ code: CODES_REFUS_COQUILLE.tropDeRequetes, correlation: `q${RELAIS_EN_VOL_MAXIMUM}` }],
  );
  // Une fois le vol vidé, la requête suivante passe : la borne compte ce qui est EN VOL.
  session.retenir = false;
  for (const regler of reglements) regler(REPONSE_VIDE);
  await apresLesPromesses();
  port.livrer(requete("apres-la-rafale"));
  await apresLesPromesses();
  const apres = port.postes.find(({ correlation }) => correlation === "apres-la-rafale");
  assert.equal(apres?.type, TYPES_RELAIS.reponse);
});
