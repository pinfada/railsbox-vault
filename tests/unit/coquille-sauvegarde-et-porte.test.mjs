// La SAUVEGARDE face à la porte unique de C1 (#265, C2-1′ ; revue de #321, point 1) : « inconnu » ne veut
// jamais dire « sans risque », et aucune réponse d'inventaire n'est JAMAIS utilisée hors du magasin. Tant que
// `lirePublic()` est fermé, le geste n'offre pas la sauvegarde : il demande au MAGASIN une relecture (ou dit
// qu'elle est déjà en cours) et la personne réessaie. L'ordre RÉEL est éprouvé au moment de l'offre de
// l'archive, pas lu après la fin du geste. Câblage réel du magasin, vrais gestes de portabilité.

import assert from "node:assert/strict";
import { test } from "node:test";

import { brancherLesGestesDePortabilite } from "../../src/coquille/gestes-de-portabilite.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";
import { monterLeCablage, reponseDInventaire, tourner } from "./support-cablage.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";

const SANS_CODE = reponseDInventaire({ codes: 0 });
const AVEC_CODE = reponseDInventaire({ codes: 1 });
void TYPES_KEK;

/** Les vrais gestes de portabilité, branchés sur le câblage réel : leur propre canal ne sait RIEN lire. */
function branche(p) {
  p.doc.poser(
    ["portabilite-refus", "portabilite-avertissement", "portabilite-etat"].map((id) => [
      "p",
      { id },
    ]),
  );
  const demandes = [];
  const offres = [];
  const texte = (id) => p.doc.getElementById(id).textContent;
  const gestes = brancherLesGestesDePortabilite({
    racine: p.doc,
    demander: async (type) => {
      demandes.push(type);
      if (type === "inventaire") assert.fail("le geste ne lit JAMAIS l'inventaire hors du magasin");
      return { taille: 3, archive: {}, applicationArretee: false };
    },
    modifier: p.cablage.modifier,
    lirePublic: p.cablage.lirePublic,
    relireLInventaire: p.cablage.relireLInventaire,
    causeDeLEchec: p.cablage.causeDeLEchec,
    rapport: p.rapport,
    publier() {},
    // L'ORDRE RÉEL : ce que la page DIT au moment où l'archive est offerte.
    enregistrer: () => offres.push({ avertissement: texte("portabilite-avertissement") }),
  });
  return { gestes, demandes, offres, texte };
}

const inventairesDuMagasin = (p) => p.messages.filter((m) => m === "inventaire").length;

test("[porte fermée] lecture du magasin EN COURS : aucune archive, aucune lecture directe, « en cours de relecture »", async () => {
  const p = monterLeCablage();
  p.cablage.demarrer();
  await tourner();
  assert.equal(p.cablage.lirePublic(), null, "FL : la porte est fermée");
  const { gestes, demandes, offres, texte } = branche(p);
  const rendu = await gestes.sauvegarder();
  assert.deepEqual(demandes, [], "ni sauvegarde, ni inventaire demandés par le geste");
  assert.deepEqual(offres, []);
  assert.equal(inventairesDuMagasin(p), 1, "la seule lecture est celle du magasin");
  assert.equal(rendu.refus, CODES_REFUS_COQUILLE.etapeHorsOrdre);
  assert.match(texte("portabilite-refus"), /en cours de relecture/);
});

test("[course] lecture suspendue, l'état CHANGE, la lecture revient : aucune archive, jamais, sans avertissement perdu", async () => {
  const p = monterLeCablage();
  p.cablage.demarrer();
  await tourner();
  const { gestes, demandes, offres } = branche(p);
  await gestes.sauvegarder();
  p.cablage.appliquer({ type: "worker-mort" });
  await tourner();
  p.attentes.inventaire[0].resoudre({ ...SANS_CODE, feuilleEprouvee: false });
  await tourner();
  assert.equal(p.cablage.etat().phase, "FE", "la lecture tardive n'est pas acceptée");
  await gestes.sauvegarder();
  assert.deepEqual(offres, [], "aucune archive offerte, avertie ou non");
  assert.deepEqual(demandes, []);
});

test("[course] porte fermée puis OUVERTE par le magasin : la sauvegarde suivante est avertie AVANT l'offre de l'archive", async () => {
  const p = monterLeCablage();
  p.cablage.demarrer();
  await tourner();
  const { gestes, demandes, offres } = branche(p);
  await gestes.sauvegarder();
  assert.deepEqual(offres, []);
  await p.repondreALInventaire({ ...SANS_CODE, feuilleEprouvee: false });
  assert.equal(p.cablage.lirePublic().nombreDeCodes, 0, "la porte est ouverte, par le magasin");
  await gestes.sauvegarder();
  assert.deepEqual(demandes, ["sauvegarder"]);
  assert.equal(offres.length, 1);
  assert.match(offres[0].avertissement, /récupération/i, "dit AU MOMENT de l'offre, pas après");
});

test("[porte ouverte] sans moyen de récupération : l'avertissement est dit AVANT l'offre ; avec un code, aucun", async () => {
  const sans = monterLeCablage();
  await sans.jusquAP("phrase", { ...SANS_CODE });
  const a = branche(sans);
  await a.gestes.sauvegarder();
  assert.equal(a.offres.length, 1);
  assert.match(a.offres[0].avertissement, /récupération/i);
  const avec = monterLeCablage();
  await avec.jusquAP("phrase", { ...AVEC_CODE });
  const b = branche(avec);
  await b.gestes.sauvegarder();
  assert.equal(b.offres.length, 1);
  assert.equal(b.offres[0].avertissement, "");
});

test("[échec terminal] lecture ÉCHOUÉE : aucune archive, et la cause consignée par le magasin est rendue (limite WebKit)", async () => {
  const p = monterLeCablage();
  p.cablage.demarrer();
  p.attentes.inventaire[0].rejeter(
    Object.assign(new Error("indisponible"), { code: STORAGE_ERROR_CODES.unsupported }),
  );
  await tourner();
  assert.equal(p.cablage.etat().phase, "FE");
  const { gestes, demandes, offres, texte } = branche(p);
  const rendu = await gestes.sauvegarder();
  assert.deepEqual(demandes, []);
  assert.deepEqual(offres, []);
  assert.equal(rendu.refus, STORAGE_ERROR_CODES.unsupported);
  assert.match(texte("portabilite-refus"), new RegExp(STORAGE_ERROR_CODES.unsupported));
});

test("[doute] après un envoi dont l'issue est inconnue, la porte est fermée : aucune archive", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  p.clic("revoquer-en-urgence");
  await tourner();
  p.clic("revocation-oui");
  p.attentes.revoquerEnUrgence[0].rejeter(Object.assign(new Error("x"), { code: "VAULT_TEST" }));
  await tourner();
  assert.equal(p.cablage.etat().phase, "I");
  const { gestes, demandes, offres } = branche(p);
  await gestes.sauvegarder();
  assert.deepEqual(demandes, []);
  assert.deepEqual(offres, []);
});

test("[relireLInventaire] déjà en cours : rien n'est relancé ; fermé pour de bon : refusé, et dit pourquoi", async () => {
  const p = monterLeCablage();
  p.cablage.demarrer();
  await tourner();
  assert.deepEqual(p.cablage.relireLInventaire(), { demandee: true });
  assert.equal(inventairesDuMagasin(p), 1, "aucune seconde lecture : celle du magasin court déjà");
  p.cablage.appliquer({ type: "worker-mort" });
  await tourner();
  assert.deepEqual(p.cablage.relireLInventaire(), { demandee: false });
});

test("[relireLInventaire] après l'ouverture (SL) la lecture court aussi : demandée, rien n'est relancé", async () => {
  const p = monterLeCablage();
  p.cablage.demarrer();
  await p.repondreALInventaire({ feuilleEprouvee: false });
  p.cablage.appliquer({ type: "coffre-ouvert", moyen: "phrase" });
  assert.equal(p.cablage.etat().phase, "SL");
  assert.deepEqual(p.cablage.relireLInventaire(), { demandee: true });
});
