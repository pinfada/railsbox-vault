/**
 * Le ROUTAGE du Service Worker de la coquille de cadre (#192, ADR 0038 ; revue de sécurité de la
 * PR #203, constats 1 et 2) : aucune requête n'est servie par le courtier d'un autre coffre.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CODES_DU_ROUTAGE,
  ISSUES_DU_ROUTAGE,
  elaguerLesLiaisons,
  routerLaRequete,
} from "../../src/coquille/routage-du-cadre.mjs";

const A = { id: "courtier-a", porte: true };
const B = { id: "courtier-b", porte: true };
const LEURRE = { id: "onglet-a-la-main", porte: false };
const MUET = { id: "document-qui-se-charge", porte: null };

/** Une navigation du cadre imbriqué. */
const navigationDuCadre = (presences) =>
  routerLaRequete({
    mode: "navigate",
    destination: "iframe",
    clientId: "",
    liaisons: new Map(),
    presences,
  });

/** Une sous-ressource du client `clientId`. */
const sousRessource = (clientId, liaisons, presences) =>
  routerLaRequete({ mode: "cors", destination: "style", clientId, liaisons, presences });

test("un seul coffre : la navigation du cadre est relayée par SON courtier", () => {
  assert.deepEqual(navigationDuCadre([A]), { issue: ISSUES_DU_ROUTAGE.relayer, courtier: A.id });
});

test("deux coffres : une navigation n'est JAMAIS servie par le premier courtier venu (constat 1)", () => {
  for (const presences of [
    [A, B],
    [B, A],
  ]) {
    assert.deepEqual(navigationDuCadre(presences), {
      issue: ISSUES_DU_ROUTAGE.refus,
      code: CODES_DU_ROUTAGE.courtiersMultiples,
    });
  }
});

test("un onglet SANS port n'est pas un courtier, et il ne prive pas le coffre de son relais (constat 2)", () => {
  assert.deepEqual(navigationDuCadre([LEURRE, A]), {
    issue: ISSUES_DU_ROUTAGE.relayer,
    courtier: A.id,
  });
  assert.deepEqual(navigationDuCadre([A, LEURRE]), {
    issue: ISSUES_DU_ROUTAGE.relayer,
    courtier: A.id,
  });
  // Seul, il ne sert rien : le Service Worker s'efface comme hors de toute coquille.
  assert.deepEqual(navigationDuCadre([LEURRE]), { issue: ISSUES_DU_ROUTAGE.reseau });
});

test("un candidat qui n'a pas répondu n'est ni ignoré ni servi au hasard", () => {
  assert.deepEqual(navigationDuCadre([A, MUET]), {
    issue: ISSUES_DU_ROUTAGE.refus,
    code: CODES_DU_ROUTAGE.courtierIncertain,
  });
  assert.deepEqual(navigationDuCadre([MUET]), {
    issue: ISSUES_DU_ROUTAGE.refus,
    code: CODES_DU_ROUTAGE.courtierIncertain,
  });
});

test("aucune coquille : le Service Worker s'efface, et la requête part au réseau", () => {
  assert.deepEqual(navigationDuCadre([]), { issue: ISSUES_DU_ROUTAGE.reseau });
  assert.deepEqual(sousRessource("x", new Map(), []), { issue: ISSUES_DU_ROUTAGE.reseau });
});

test("une navigation de PREMIER RANG n'est jamais relayée : un onglet n'est dans aucun coffre", () => {
  for (const presences of [[A], [A, B], []]) {
    assert.deepEqual(
      routerLaRequete({
        mode: "navigate",
        destination: "document",
        clientId: "",
        liaisons: new Map(),
        presences,
      }),
      { issue: ISSUES_DU_ROUTAGE.reseau },
    );
  }
});

test("une sous-ressource suit la LIAISON de son client, même quand deux coffres sont ouverts", () => {
  const liaisons = new Map([
    ["client-du-cadre-a", A.id],
    ["client-du-cadre-b", B.id],
  ]);
  assert.deepEqual(sousRessource("client-du-cadre-a", liaisons, [B, A]), {
    issue: ISSUES_DU_ROUTAGE.relayer,
    courtier: A.id,
  });
  assert.deepEqual(sousRessource("client-du-cadre-b", liaisons, [A, B]), {
    issue: ISSUES_DU_ROUTAGE.relayer,
    courtier: B.id,
  });
});

test("un client SANS liaison, ou lié à un courtier disparu, reçoit un refus — jamais un autre courtier", () => {
  const liaisons = new Map([["client-du-cadre-b", B.id]]);
  // Un onglet de l'origine applicative, hors de tout coffre, pendant qu'un coffre est ouvert.
  assert.deepEqual(sousRessource("onglet", liaisons, [A]), {
    issue: ISSUES_DU_ROUTAGE.refus,
    code: CODES_DU_ROUTAGE.clientSansCourtier,
  });
  // Le cadre de B, dont le coffre s'est refermé, pendant que A est ouvert.
  assert.deepEqual(sousRessource("client-du-cadre-b", liaisons, [A]), {
    issue: ISSUES_DU_ROUTAGE.refus,
    code: CODES_DU_ROUTAGE.clientSansCourtier,
  });
  // Et lié à un document qui a répondu « sans port » : ce n'est pas un courtier.
  assert.deepEqual(
    sousRessource("client-du-leurre", new Map([["client-du-leurre", LEURRE.id]]), [LEURRE, A]),
    { issue: ISSUES_DU_ROUTAGE.refus, code: CODES_DU_ROUTAGE.clientSansCourtier },
  );
});

test("un chemin RÉSERVÉ demandé par l'application servie rend un refus lisible (revue #203, constat 5)", () => {
  const liaisons = new Map([["client-du-cadre-a", A.id]]);
  const refus = { issue: ISSUES_DU_ROUTAGE.refus, code: CODES_DU_ROUTAGE.cheminReserve };
  // La page servie navigue son cadre vers `/index.html` : jamais le document de la coquille.
  assert.deepEqual(
    routerLaRequete({
      mode: "navigate",
      destination: "iframe",
      clientId: "",
      liaisons,
      presences: [A],
      reserve: true,
    }),
    refus,
  );
  // Elle charge `/cadre/contrat-du-cadre.mjs` : refusé aussi.
  assert.deepEqual(
    routerLaRequete({
      mode: "cors",
      destination: "script",
      clientId: "client-du-cadre-a",
      liaisons,
      presences: [A],
      reserve: true,
    }),
    refus,
  );
});

test("la coquille de cadre, elle, obtient toujours ses propres chemins du réseau", () => {
  const reseau = { issue: ISSUES_DU_ROUTAGE.reseau };
  // Le courtier d'un SECOND coffre s'encadre pendant que le premier est ouvert.
  assert.deepEqual(
    routerLaRequete({
      mode: "navigate",
      destination: "iframe",
      clientId: "",
      liaisons: new Map(),
      presences: [A],
      reserve: true,
      cheminDuCourtier: true,
    }),
    reseau,
  );
  // Le courtier charge ses modules : son client n'est lié à aucun courtier.
  assert.deepEqual(
    routerLaRequete({
      mode: "cors",
      destination: "script",
      clientId: "courtier-en-chargement",
      liaisons: new Map(),
      presences: [],
      reserve: true,
    }),
    reseau,
  );
  // Un onglet ouvert à la main sur `/index.html` voit ce que l'hébergeur sert.
  assert.deepEqual(
    routerLaRequete({
      mode: "navigate",
      destination: "document",
      clientId: "",
      liaisons: new Map(),
      presences: [A],
      reserve: true,
    }),
    reseau,
  );
  // Et sans aucun coffre ouvert, un banc encadré sur l'origine applicative passe.
  assert.deepEqual(
    routerLaRequete({
      mode: "navigate",
      destination: "iframe",
      clientId: "",
      liaisons: new Map(),
      presences: [],
      reserve: true,
    }),
    reseau,
  );
});

// --- L'ÉLAGAGE des liaisons (#257) -----------------------------------------------------------------
//
// Le document Rails était servi à 200, puis ses sous-ressources refusées CADRE_CLIENT_SANS_COURTIER :
// la liaison apprise à la navigation était élaguée à la requête suivante, parce que le client
// fraîchement navigué ne figurait pas encore dans clients.matchAll().

test("un client navigué il y a 450 ms, encore absent de matchAll, GARDE sa liaison (#257)", () => {
  const liaisons = new Map([["cadre-neuf", "courtier-a"]]);
  const elague = elaguerLesLiaisons({ liaisons, vus: new Set(), vivants: new Set(["courtier-a"]) });
  assert.equal(elague.liaisons.get("cadre-neuf"), "courtier-a");
  // Et la sous-ressource qui suit est RELAYÉE, non refusée.
  assert.deepEqual(
    routerLaRequete({
      mode: "no-cors",
      destination: "script",
      clientId: "cadre-neuf",
      liaisons: elague.liaisons,
      presences: [A],
    }),
    { issue: ISSUES_DU_ROUTAGE.relayer, courtier: "courtier-a" },
  );
});

test("un client VU puis disparu de matchAll perd sa liaison", () => {
  const liaisons = new Map([["cadre", "courtier-a"]]);
  const vu = elaguerLesLiaisons({ liaisons, vus: new Set(), vivants: new Set(["cadre"]) });
  assert.ok(vu.vus.has("cadre"));
  const disparu = elaguerLesLiaisons({ ...vu, vivants: new Set() });
  assert.equal(disparu.liaisons.has("cadre"), false);
  assert.equal(disparu.vus.has("cadre"), false);
});

test("l'élagage rend de NOUVELLES collections et ne touche pas à celles qu'il reçoit", () => {
  const liaisons = new Map([["cadre", "courtier-a"]]);
  const vus = new Set(["cadre"]);
  const elague = elaguerLesLiaisons({ liaisons, vus, vivants: new Set() });
  assert.equal(liaisons.get("cadre"), "courtier-a");
  assert.ok(vus.has("cadre"));
  assert.notEqual(elague.liaisons, liaisons);
  assert.notEqual(elague.vus, vus);
});
