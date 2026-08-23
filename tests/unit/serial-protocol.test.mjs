import assert from "node:assert/strict";
import { test } from "node:test";

import {
  MAGIC,
  TAILLE_TRANCHE,
  base64Depuis,
  construireTramesRequete,
  creerAssembleurLignes,
  creerAssembleurReponses,
  decouperReponseHttp,
  octetsDepuisBase64,
} from "../../tools/vm/serial-protocol.mjs";

const encodeur = new TextEncoder();

test("une requête sans corps tient en deux trames", () => {
  const trames = construireTramesRequete("7", { method: "GET", path: "/vault/health" });

  assert.equal(trames.tranches.length, 0);
  assert.equal(trames.cloture, `${MAGIC} FIN 7`);
  const descripteur = JSON.parse(
    new TextDecoder().decode(octetsDepuisBase64(trames.ouverture.split(" ")[3])),
  );
  assert.deepEqual(descripteur, {
    method: "GET",
    path: "/vault/health",
    headers: [],
    bodyLength: 0,
  });
});

test("un corps plus long qu'une tranche est découpé en tranches acquittables", () => {
  const corps = new Uint8Array(TAILLE_TRANCHE + 10).fill(65);
  const trames = construireTramesRequete("a1", { method: "POST", path: "/x", body: corps });

  assert.equal(trames.tranches.length, 2);
  const recompose = trames.tranches
    .map((trame) => octetsDepuisBase64(trame.split(" ")[3]))
    .reduce((accumule, morceau) => [...accumule, ...morceau], []);
  assert.deepEqual(new Uint8Array(recompose), corps);
});

test("un identifiant de requête non alphanumérique est refusé", () => {
  assert.throws(() => construireTramesRequete("id avec espace", { method: "GET", path: "/" }), TypeError);
});

test("l'assembleur de lignes ne rend que des lignes complètes", () => {
  const recues = [];
  const assembleur = creerAssembleurLignes((ligne) => recues.push(ligne));

  assembleur.ajouter("pre");
  assembleur.ajouter("miere\r\nsec");
  assert.deepEqual(recues, ["premiere"]);
  assert.equal(assembleur.reste(), "sec");

  assembleur.ajouter("onde\n\ntroisieme\n");
  assert.deepEqual(recues, ["premiere", "seconde", "troisieme"]);
});

test("une réponse découpée en tranches est réassemblée à l'octet près", () => {
  const assembleur = creerAssembleurReponses();
  const charge = encodeur.encode("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n\r\n{\"a\":1}");

  assert.equal(assembleur.traiterLigne(`${MAGIC} RSB 3 ${charge.byteLength}`), null);
  assert.equal(assembleur.traiterLigne(`${MAGIC} DAT 3 ${base64Depuis(charge.subarray(0, 8))}`), null);
  assert.equal(assembleur.traiterLigne(`${MAGIC} DAT 3 ${base64Depuis(charge.subarray(8))}`), null);

  const evenement = assembleur.traiterLigne(`${MAGIC} END 3`);
  assert.equal(evenement.type, "reponse");
  assert.deepEqual(evenement.octets, charge);
});

test("une réponse tronquée est une erreur, jamais une réponse partielle", () => {
  const assembleur = creerAssembleurReponses();
  assembleur.traiterLigne(`${MAGIC} RSB 4 100`);
  assembleur.traiterLigne(`${MAGIC} DAT 4 ${base64Depuis(encodeur.encode("court"))}`);

  const evenement = assembleur.traiterLigne(`${MAGIC} END 4`);
  assert.equal(evenement.type, "erreur");
  assert.equal(evenement.libelle, "reponse-tronquee");
});

test("une tranche qui déborde de la taille annoncée est refusée", () => {
  const assembleur = creerAssembleurReponses();
  assembleur.traiterLigne(`${MAGIC} RSB 5 2`);

  const evenement = assembleur.traiterLigne(`${MAGIC} DAT 5 ${base64Depuis(encodeur.encode("beaucoup"))}`);
  assert.equal(evenement.type, "erreur");
  assert.equal(evenement.libelle, "reponse-plus-longue-qu-annoncee");
});

test("une trame ERR du guest est remontée avec son code et son libellé", () => {
  const assembleur = creerAssembleurReponses();

  const evenement = assembleur.traiterLigne(`${MAGIC} ERR 6 7 application-injoignable`);
  assert.deepEqual(evenement, {
    type: "erreur",
    id: "6",
    code: 7,
    libelle: "application-injoignable",
  });
});

test("une ligne hors protocole est un journal, pas une réponse", () => {
  const assembleur = creerAssembleurReponses();

  assert.deepEqual(assembleur.traiterLigne("[init] montage du disque applicatif"), {
    type: "journal",
    texte: "[init] montage du disque applicatif",
  });
});

test("la réponse HTTP est découpée en statut, en-têtes et corps", () => {
  const brut = encodeur.encode(
    "HTTP/1.1 409 Conflict\r\nContent-Type: application/json; charset=utf-8\r\nX-Vide: \r\n\r\n{\"status\":\"divergent\"}",
  );

  const reponse = decouperReponseHttp(brut);
  assert.equal(reponse.statut, 409);
  assert.equal(reponse.message, "Conflict");
  assert.equal(reponse.entetes["content-type"], "application/json; charset=utf-8");
  assert.equal(new TextDecoder().decode(reponse.corps), '{"status":"divergent"}');
});

test("une réponse sans séparation d'en-tête est refusée explicitement", () => {
  assert.throws(
    () => decouperReponseHttp(encodeur.encode("HTTP/1.1 200 OK")),
    /sans séparation en-tête\/corps/,
  );
});
