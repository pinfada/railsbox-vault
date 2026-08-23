import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import {
  APP_ORIGIN,
  CANARY_INTERCEPTED,
  CANARY_PATH,
  MESSAGE_TYPES,
  OPAQUE_ORIGIN,
  SHELL_ORIGIN,
  TOPOLOGY_IDS,
  appDocumentUrl,
  channelTargetOrigin,
  evaluateAppHello,
  expectedAppOrigin,
  isAllowedAppRequest,
  topologyOf,
} from "../../src/spike/origin-topology.mjs";
import {
  ISOLATION_REQUIRE_CORP,
  isApplicationTerritory,
  parseServerOptions,
  securityHeaders,
  shellContentSecurityPolicy,
} from "../../tools/serve-headers.mjs";

test("les quatre topologies du spike sont déclarées", () => {
  assert.deepEqual(TOPOLOGY_IDS, [
    "T1a-meme-origine-sans-sandbox",
    "T1b-meme-origine-sandbox-opaque",
    "T2-origine-distincte-sandbox",
    "T3-origine-distincte-opaque",
  ]);
});

test("une topologie inconnue échoue explicitement plutôt que de retomber sur un défaut", () => {
  assert.throws(() => topologyOf("T9-inventee"), /Topologie inconnue : T9-inventee/);
});

test("l'origine attendue distingue même origine, autre origine et origine opaque", () => {
  assert.equal(expectedAppOrigin("T1a-meme-origine-sans-sandbox"), SHELL_ORIGIN);
  assert.equal(expectedAppOrigin("T1b-meme-origine-sandbox-opaque"), OPAQUE_ORIGIN);
  assert.equal(expectedAppOrigin("T2-origine-distincte-sandbox"), APP_ORIGIN);
  assert.equal(expectedAppOrigin("T3-origine-distincte-opaque"), OPAQUE_ORIGIN);
});

test("une origine opaque n'est adressable que par le joker, ce qui est un coût réel", () => {
  assert.equal(channelTargetOrigin("T2-origine-distincte-sandbox"), APP_ORIGIN);
  assert.equal(channelTargetOrigin("T3-origine-distincte-opaque"), "*");
});

test("l'URL du document applicatif suit l'origine de la topologie", () => {
  assert.ok(appDocumentUrl("T1a-meme-origine-sans-sandbox").startsWith(SHELL_ORIGIN));
  assert.ok(appDocumentUrl("T2-origine-distincte-sandbox").startsWith(APP_ORIGIN));
  assert.match(
    appDocumentUrl("T2-origine-distincte-sandbox", { isolation: "require-corp" }),
    /isolation=require-corp$/,
  );
});

test("l'annonce applicative n'est admise que sur trois conditions cumulées", () => {
  const valide = {
    type: MESSAGE_TYPES.appHello,
    origin: APP_ORIGIN,
    sourceIsAppFrame: true,
    expectedOrigin: APP_ORIGIN,
    alreadyGranted: false,
  };
  assert.deepEqual(evaluateAppHello(valide), { accepted: true, reason: "admis" });
  assert.equal(evaluateAppHello({ ...valide, type: "vault.autre" }).reason, "type-inattendu");
  assert.equal(evaluateAppHello({ ...valide, origin: SHELL_ORIGIN }).reason, "origine-inattendue");
  assert.equal(
    evaluateAppHello({ ...valide, sourceIsAppFrame: false }).reason,
    "fenetre-emettrice-inattendue",
  );
  assert.equal(evaluateAppHello({ ...valide, alreadyGranted: true }).reason, "port-deja-emis");
});

test("le port restreint n'admet que la requête d'état", () => {
  assert.equal(isAllowedAppRequest(MESSAGE_TYPES.statusRequest), true);
  assert.equal(isAllowedAppRequest("vault.export-key"), false);
  assert.equal(isAllowedAppRequest(undefined), false);
});

test("la CSP de la coquille nomme chaque capacité et n'autorise que l'origine applicative", () => {
  const politique = shellContentSecurityPolicy(APP_ORIGIN);
  assert.match(politique, /default-src 'none'/);
  assert.match(politique, /frame-ancestors 'none'/);
  assert.match(politique, new RegExp(`frame-src 'self' ${APP_ORIGIN.replace(/[/.]/g, "\\$&")}`));
  assert.doesNotMatch(politique, /unsafe-inline|unsafe-eval/);
});

test("le territoire applicatif est reconnu par son préfixe", () => {
  assert.equal(isApplicationTerritory("/spike/origin/app.html"), true);
  assert.equal(isApplicationTerritory("/spike/origin/app-hostile-sw.mjs"), true);
  assert.equal(isApplicationTerritory("/spike/origin/shell.html"), false);
});

test("les en-têtes distinguent coquille, territoire applicatif et serveur applicatif", () => {
  const coquille = securityHeaders({
    role: "shell",
    pathname: "/spike/origin/shell.html",
    isolation: null,
    appOrigin: APP_ORIGIN,
  });
  assert.ok(coquille["Content-Security-Policy"]);
  assert.equal(coquille["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal(coquille["Cross-Origin-Opener-Policy"], undefined);

  const applicatif = securityHeaders({
    role: "shell",
    pathname: "/spike/origin/app.html",
    isolation: null,
    appOrigin: APP_ORIGIN,
  });
  assert.equal(applicatif["Content-Security-Policy"], undefined);

  const serveurApplicatif = securityHeaders({
    role: "app",
    pathname: "/spike/origin/app.html",
    isolation: ISOLATION_REQUIRE_CORP,
    appOrigin: APP_ORIGIN,
  });
  assert.equal(serveurApplicatif["Cross-Origin-Resource-Policy"], "cross-origin");
  assert.equal(serveurApplicatif["Cross-Origin-Embedder-Policy"], "require-corp");
  assert.equal(serveurApplicatif["Cross-Origin-Opener-Policy"], "same-origin");
});

test("aucun en-tête ne concède la portée racine à un Service Worker applicatif", () => {
  const entetes = securityHeaders({
    role: "shell",
    pathname: "/spike/origin/app-hostile-sw.mjs",
    isolation: null,
    appOrigin: APP_ORIGIN,
  });
  assert.equal(entetes["Service-Worker-Allowed"], undefined);
});

test("un rôle de serveur inconnu échoue au lieu d'être ignoré", () => {
  assert.throws(
    () => securityHeaders({ role: "proxy", pathname: "/", isolation: null, appOrigin: APP_ORIGIN }),
    /Rôle de serveur inconnu/,
  );
  assert.throws(() => parseServerOptions(["--role", "proxy"]), /Rôle inconnu/);
});

test("les options du serveur ont des défauts par rôle et refusent une valeur invalide", () => {
  assert.deepEqual(parseServerOptions([]), {
    role: "shell",
    host: "127.0.0.1",
    port: 4173,
    appOrigin: APP_ORIGIN,
  });
  assert.deepEqual(parseServerOptions(["--role", "app"]), {
    role: "app",
    host: "localhost",
    port: 4174,
    appOrigin: APP_ORIGIN,
  });
  assert.equal(parseServerOptions(["--host", "127.0.0.1", "--port", "5000"]).port, 5000);
  assert.throws(() => parseServerOptions(["--port", "abc"]), /Port invalide/);
  assert.throws(() => parseServerOptions(["--port"]), /L'option --port attend une valeur/);
});

test("le Service Worker hostile recopie les constantes partagées sans dériver", async () => {
  const source = await readFile(
    new URL("../../public/spike/origin/app-hostile-sw.mjs", import.meta.url),
    "utf8",
  );
  assert.ok(source.includes(`"${CANARY_PATH}"`), "le chemin témoin recopié doit rester identique");
  assert.ok(
    source.includes(`"${CANARY_INTERCEPTED}"`),
    "le marqueur d'interception doit coïncider",
  );
});
