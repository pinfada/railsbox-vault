import assert from "node:assert/strict";
import { test } from "node:test";

import { createSerialHttpClient } from "../../src/vm/serial-http-client.mjs";
import { base64Depuis } from "../../src/vm/serial-protocol.mjs";

const encodeur = new TextEncoder();
const MAGIC = "@VLT1";

/** Construit les lignes de réponse du guest pour une réponse HTTP brute. */
function tramesReponse(id, brut) {
  const payload = base64Depuis(encodeur.encode(brut));
  return [
    `${MAGIC} RSB ${id} ${brut.length}`,
    `${MAGIC} DAT ${id} ${payload}`,
    `${MAGIC} END ${id}`,
  ];
}

const OK_JSON = 'HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{"ok":true}';

test("une requête GET émet l'ouverture puis la clôture et résout la réponse décodée", async () => {
  const envoyees = [];
  const client = createSerialHttpClient({ send: (ligne) => envoyees.push(ligne) });

  const promesse = client.request("GET", "/vault/health");
  // L'identifiant de la première requête est `r1` : le guest répond sur cet identifiant.
  for (const ligne of tramesReponse("r1", OK_JSON)) client.ingest(`${ligne}\n`);

  const reponse = await promesse;
  assert.equal(reponse.statut, 200);
  assert.equal(reponse.entetes["content-type"], "application/json");
  assert.equal(new TextDecoder().decode(reponse.corps), '{"ok":true}');

  // Un GET n'a pas de corps : ouverture (REQ) puis clôture (FIN), et rien entre les deux.
  assert.equal(envoyees.length, 2);
  assert.match(envoyees[0], /^@VLT1 REQ r1 /);
  assert.match(envoyees[1], /^@VLT1 FIN r1\n$/);
});

test("une requête avec corps attend l'ACK de chaque tranche avant la clôture", async () => {
  const envoyees = [];
  let ackDéclenché = false;
  const client = createSerialHttpClient({
    send: (ligne) => {
      envoyees.push(ligne);
      // Le guest acquitte la tranche de corps dès qu'il la reçoit.
      if (ligne.startsWith("@VLT1 BOD")) {
        ackDéclenché = true;
        queueMicrotask(() => client.ingest("@VLT1 ACK r1\n"));
      }
    },
  });

  const promesse = client.request("POST", "/x", { body: encodeur.encode("charge utile") });
  await new Promise((r) => setTimeout(r, 5));
  for (const ligne of tramesReponse("r1", OK_JSON)) client.ingest(`${ligne}\n`);
  await promesse;

  assert.ok(ackDéclenché, "une tranche de corps a bien été émise");
  const ordre = envoyees.map((l) => l.split(" ")[1]);
  assert.deepEqual(ordre, ["REQ", "BOD", "FIN"]);
});

test("une erreur du pont rejette la requête sans succès silencieux", async () => {
  const client = createSerialHttpClient({ send: () => {} });
  const promesse = client.request("GET", "/vault/health");
  client.ingest("@VLT1 ERR r1 7 application-injoignable\n");
  await assert.rejects(promesse, /application-injoignable.*code 7/);
});

test("l'absence de réponse déclenche le délai de garde", async () => {
  const client = createSerialHttpClient({ send: () => {} });
  await assert.rejects(client.request("GET", "/lent", { timeoutMs: 20 }), /aucune réponse/);
});

test("une ligne applicative est relayée à onLog, jamais interprétée comme réponse", async () => {
  const journaux = [];
  const client = createSerialHttpClient({ send: () => {}, onLog: (t) => journaux.push(t) });
  client.ingest("[init] montage du disque applicatif\n");
  assert.deepEqual(journaux, ["[init] montage du disque applicatif"]);
});
