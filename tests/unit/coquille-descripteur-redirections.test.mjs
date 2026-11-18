/**
 * Une RÉPONSE de l'origine n'ouvre JAMAIS le repli hors connexion — redirection comprise (#247, D1g ;
 * ADR 0042, ADR 0046 ; revue de sécurité de #298, constat 1).
 *
 * `fetch` suit les redirections par défaut, et une BOUCLE de redirections lève un `TypeError` : le
 * même signal que « pas de réseau ». Une origine qui répond par une boucle de 302 faisait donc
 * accepter le descripteur rangé — c'est-à-dire faire démarrer l'ancien code — alors qu'elle avait
 * répondu. Ces épreuves parlent à de VRAIS serveurs HTTP (le `fetch` de Node, `redirect` comme le
 * produit le demande) : un faux `fetch` rendrait exactement ce que l'on veut qu'il rende.
 */

import assert from "node:assert/strict";
import { createServer } from "node:http";
import test from "node:test";

import {
  ADRESSE_DESCRIPTEUR,
  lireLeDescripteur,
} from "../../src/coquille/descripteur-applicatif.mjs";
import { descripteurDEpreuve } from "./support-coffre-de-la-coquille.mjs";

/** Démarre un serveur local ; `servir(req, res, compteur)` répond. Rend l'origine et de quoi l'arrêter. */
async function serveur(servir) {
  const compteur = { requetes: 0 };
  const http = createServer((req, res) => {
    compteur.requetes += 1;
    servir(req, res);
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  const origine = `http://127.0.0.1:${http.address().port}`;
  return {
    origine,
    compteur,
    arreter: () => new Promise((resolve) => (http.closeAllConnections(), http.close(resolve))),
  };
}

/** Le `fetch` du produit, mais adressé à une origine d'épreuve : les OPTIONS passent telles quelles. */
const recupererChez = (origine) => (adresse, options) => fetch(origine + adresse, options);

/** Le repli : s'il est appelé, l'épreuve le sait — et il rend un descripteur « rangé » reconnaissable. */
function repli() {
  const etat = { appels: 0 };
  const repliHorsConnexion = async () => {
    etat.appels += 1;
    return { present: true, descripteur: descripteurDEpreuve(), horsConnexion: { rangeLe: 1 } };
  };
  return { etat, repliHorsConnexion };
}

test("une BOUCLE de 302 est une réponse de l'origine : le repli reste fermé, la raison est dite", async (t) => {
  const boucle = await serveur((req, res) => {
    res.writeHead(302, { location: req.url }).end();
  });
  t.after(boucle.arreter);
  const { etat, repliHorsConnexion } = repli();

  const lu = await lireLeDescripteur({
    recuperer: recupererChez(boucle.origine),
    repliHorsConnexion,
  });

  assert.equal(etat.appels, 0, "le repli n'est pas ouvert par une origine qui répond");
  assert.equal(lu.present, false);
  assert.equal(lu.horsConnexion, undefined, "rien n'est lu au rangé");
  assert.match(lu.motif, /redirig/i, "le motif dit que l'origine a redirigé");
  assert.equal(boucle.compteur.requetes, 1, "la redirection n'est pas suivie, pas même une fois");
});

test("un 301 vers une AUTRE origine n'est pas suivi : l'autre origine n'est jamais contactée", async (t) => {
  const ailleurs = await serveur((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(descripteurDEpreuve()));
  });
  t.after(ailleurs.arreter);
  const origine = await serveur((req, res) => {
    res.writeHead(301, { location: `${ailleurs.origine}${req.url}` }).end();
  });
  t.after(origine.arreter);
  const { etat, repliHorsConnexion } = repli();

  const lu = await lireLeDescripteur({ recuperer: recupererChez(origine.origine), repliHorsConnexion });

  assert.equal(etat.appels, 0);
  assert.equal(lu.present, false, "un descripteur servi par une autre origine n'est pas l'application");
  assert.match(lu.motif, /redirig/i);
  assert.equal(ailleurs.compteur.requetes, 0, "la redirection n'est pas suivie");
});

test("une redirection opaque (`opaqueredirect`, ce que le navigateur rend en mode manuel) n'ouvre pas le repli", async () => {
  const { etat, repliHorsConnexion } = repli();
  const opaque = async () => ({ type: "opaqueredirect", status: 0, ok: false, url: "" });

  const lu = await lireLeDescripteur({ recuperer: opaque, repliHorsConnexion });

  assert.equal(etat.appels, 0);
  assert.equal(lu.present, false);
  assert.match(lu.motif, /redirig/i);
});

test("le produit demande `redirect: manual` : c'est ce qui rend la boucle observable sans erreur de réseau", async () => {
  const demandes = [];
  const recuperer = async (adresse, options) => {
    demandes.push({ adresse, options });
    return { ok: false, status: 404, json: async () => ({}) };
  };
  await lireLeDescripteur({ recuperer });
  assert.equal(demandes.length, 1);
  assert.equal(demandes[0].adresse, ADRESSE_DESCRIPTEUR);
  assert.equal(demandes[0].options.redirect, "manual");
});

// --- Les témoins : ce que le correctif ne doit PAS casser ------------------------------------------

test("témoin : une origine qui sert le descripteur directement est lue", async (t) => {
  const droite = await serveur((req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(descripteurDEpreuve()));
  });
  t.after(droite.arreter);
  const { etat, repliHorsConnexion } = repli();

  const lu = await lireLeDescripteur({ recuperer: recupererChez(droite.origine), repliHorsConnexion });

  assert.equal(lu.present, true);
  assert.equal(etat.appels, 0);
});

test("témoin : une origine qui REFUSE la connexion (TypeError réel) ouvre le repli", async () => {
  // Un port qui vient d'être libéré : rien n'écoute, la connexion est refusée.
  const mort = await serveur(() => {});
  const origine = mort.origine;
  await mort.arreter();
  const { etat, repliHorsConnexion } = repli();

  const lu = await lireLeDescripteur({ recuperer: recupererChez(origine), repliHorsConnexion });

  assert.equal(etat.appels, 1, "pas de réponse du tout : c'est le seul cas du repli");
  assert.equal(lu.present, true);
});
