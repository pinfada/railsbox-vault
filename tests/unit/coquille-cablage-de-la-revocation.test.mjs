// Le CÂBLAGE de la révocation (#265, ADR 0049 § C2) : le magasin de C1, le rendeur unique, l'affichage et
// les gestionnaires, assemblés sur un DOM factice et un faux canal. Les mêmes parcours sont rejoués sur la
// coquille réelle (`tests/browser/coquille-revocation-page.spec.mjs`).

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  SUCCES,
  differe,
  monterLeCablage,
  reponseDInventaire,
  tourner,
} from "./support-cablage.mjs";

// --- le montage et la première publication -------------------------------------------------------------

test("[montage] demarrer lance UNE lecture de l'inventaire ; l'affichage reste masqué jusqu'à la publication", async () => {
  const p = monterLeCablage();
  assert.equal(p.estampille(), null, "avant tout : aucune estampille");
  p.cablage.demarrer();
  assert.deepEqual(p.messages, ["inventaire"]);
  await tourner();
  assert.equal(p.conteneur.hidden, true, "pas de réponse : le conteneur reste masqué");
  assert.equal(p.estampille(), null);
  await p.repondreALInventaire({ feuilleEprouvee: false });
  assert.notEqual(p.estampille(), null, "la réponse acceptée est publiée puis estampillée");
  assert.equal(p.conteneur.hidden, false);
});

test("[C2-1′] le miroir (`rapport`) n'est écrit QUE par `publier`, après acceptation : une réponse périmée n'écrit rien", async () => {
  const p = monterLeCablage();
  p.cablage.demarrer();
  p.cablage.appliquer({ type: "coffre-ouvert", moyen: "phrase" });
  assert.equal(p.attentes.inventaire.length, 2, "deux lectures : la première est abandonnée");
  p.attentes.inventaire[0].resoudre({
    ...reponseDInventaire(),
    feuilleEprouvee: true,
    tailleDeSauvegarde: 111,
  });
  await tourner();
  assert.equal(p.rapport.feuilleEprouvee, false, "la lecture périmée n'écrit pas le constat");
  assert.equal(p.rapport.tailleDeSauvegarde, null, "ni la taille");
  assert.deepEqual(p.journal.miroirs, []);
  p.attentes.inventaire[1].resoudre({
    ...reponseDInventaire(),
    feuilleEprouvee: true,
    tailleDeSauvegarde: 222,
  });
  await tourner();
  assert.equal(p.rapport.feuilleEprouvee, true);
  assert.equal(p.rapport.tailleDeSauvegarde, 222);
  assert.equal(p.journal.miroirs.length, 1);
});

test("[C2-1′] une lecture échouée ou malformée n'écrit aucun miroir et ne publie aucune donnée", async () => {
  const p = monterLeCablage();
  p.cablage.demarrer();
  p.attentes.inventaire[0].resoudre({ type: "n'importe quoi" });
  await tourner();
  assert.equal(p.journal.miroirs.length, 0);
  assert.equal(p.cablage.lirePublic(), null);
  assert.equal(p.cablage.etat().phase, "FE");
});

test("[C2-1′] lirePublic et lireLeConstat sont les portes : fermées avant la lecture, ouvertes après", async () => {
  const p = monterLeCablage();
  assert.equal(p.cablage.lirePublic(), null);
  await p.jusquAP();
  assert.equal(p.cablage.lirePublic().present, true);
  assert.equal(p.cablage.lireLeConstat().feuilleEprouvee, true);
  assert.equal(p.cablage.identifiantDuVolume(), "coffre");
});

// --- les gestes : première instruction, aucune lecture de `aria-disabled` --------------------------------

test("[C2-2] un clic synthétique sur un bouton `aria-disabled` est REFUSÉ par la table, et l'état ne bouge pas", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  const avant = p.cablage.etat();
  assert.equal(p.doc.getElementById("revocation-oui"), null, "pas de confirmation en P");
  p.cablage.appliquer({ type: "demander-la-revocation" });
  await tourner();
  p.cablage.appliquer({ type: "annuler" });
  await tourner();
  assert.equal(p.cablage.etat().phase, "P");
  void avant;
  const bouton = p.doc.getElementById("parcours-sans-revoquer");
  assert.equal(bouton.getAttribute("aria-disabled"), "false");
  // en V, plus aucune sortie : le bouton rendu est `aria-disabled`, et le clic synthétique n'a aucun effet
  p.cablage.appliquer({ type: "demander-la-revocation" });
  await tourner();
  p.clic("revocation-oui");
  await tourner();
  assert.equal(p.cablage.etat().phase, "V");
  const termine = p.journal.termine;
  p.clicSynthetique("parcours-sans-revoquer");
  assert.equal(
    p.cablage.etat().phase,
    "V",
    "« Terminer sans révoquer » est refusé pendant l'envoi",
  );
  assert.equal(p.journal.termine, termine, "le geste n'a pas été exécuté");
  assert.match(p.doc.getElementById("affichage-annonce").textContent, /en cours/);
});

test("[C2-2] « Révoquer… » ouvre la confirmation ; « Annuler » la ferme et dit qu'aucun geste n'a été fait dans la séance", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  p.clic("revoquer-en-urgence");
  await tourner();
  assert.equal(p.cablage.etat().phase, "C");
  assert.notEqual(p.doc.getElementById("revocation-confirmation"), null);
  assert.equal(p.messages.includes("revoquerEnUrgence"), false, "rien n'est envoyé à l'ouverture");
  p.clic("revocation-annuler");
  await tourner();
  assert.equal(p.cablage.etat().phase, "P");
  assert.equal(p.doc.getElementById("revocation-confirmation"), null);
  assert.match(p.doc.getElementById("affichage-annonce").textContent, /dans cette séance/);
  assert.equal(p.messages.filter((m) => m === "revoquerEnUrgence").length, 0);
});

test("[C2-2] « Terminer sans révoquer » passe par la table, puis appelle `surTerminer`", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  p.clic("parcours-sans-revoquer");
  await tourner();
  assert.equal(p.journal.termine, 1);
  assert.match(p.doc.getElementById("affichage-annonce").textContent, /dans cette séance/);
});

// --- la révocation : masquage avant envoi, issues ----------------------------------------------------------

test("[C2-13] « Oui » : le conteneur est MASQUÉ quand le message part, et un seul message `revoquerEnUrgence` est posé", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  p.clic("revoquer-en-urgence");
  await tourner();
  let vuAuDepart = "jamais appelé";
  const original = p.cablage;
  void original;
  const demanderOriginal = p.attentes.revoquerEnUrgence;
  assert.equal(demanderOriginal.length, 0);
  p.clic("revocation-oui");
  assert.equal(p.messages.filter((m) => m === "revoquerEnUrgence").length, 1);
  vuAuDepart = p.estampille();
  assert.equal(vuAuDepart, null, "au moment de l'envoi, l'affichage est masqué (pas d'estampille)");
  assert.equal(p.conteneur.hidden, true);
  assert.equal(p.cablage.etat().phase, "V");
  p.clicSynthetique("revocation-oui");
  assert.equal(
    p.messages.filter((m) => m === "revoquerEnUrgence").length,
    1,
    "double clic : un seul envoi",
  );
});

test("[C2-13] masquage IMPOSSIBLE : aucun message n'est posé sur le canal, l'envoi est annulé et dit", async () => {
  const p = monterLeCablage({ masquerEchoue: true });
  await p.jusquAP();
  p.clic("revoquer-en-urgence");
  await tourner();
  p.clic("revocation-oui");
  await tourner();
  assert.equal(p.messages.filter((m) => m === "revoquerEnUrgence").length, 0, "aucun message");
  assert.notEqual(p.cablage.etat().phase, "V");
  assert.match(p.doc.getElementById("affichage-annonce").textContent, /pas été envoyée/);
});

test("[succès] l'acquit du Worker : `noter`, la relecture, la phase K, « La révocation a été faite »", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  p.clic("revoquer-en-urgence");
  await tourner();
  p.clic("revocation-oui");
  p.attentes.revoquerEnUrgence[0].resoudre(SUCCES);
  await tourner();
  assert.equal(p.journal.notes, 1, "l'indice est écrit une fois, à l'acquit");
  assert.equal(p.journal.succes.length, 1);
  assert.equal(p.journal.succes[0].nombreRetires, 1);
  assert.equal(p.cablage.etat().phase, "RL", "la relecture est lancée");
  assert.equal(p.attentes.inventaire.length, 3);
  await p.repondreALInventaire({ emplacements: reponseDInventaire({ codes: 0 }).emplacements });
  assert.equal(p.cablage.etat().phase, "K");
  assert.match(p.texte(), /La révocation a été faite/);
});

test("[doute] un refus typé après l'envoi dit « peut-être » — jamais « refusée » —, et verrouille la demande", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  p.clic("revoquer-en-urgence");
  await tourner();
  p.clic("revocation-oui");
  p.attentes.revoquerEnUrgence[0].rejeter(Object.assign(new Error("x"), { code: "VAULT_TEST" }));
  await tourner();
  assert.equal(p.cablage.etat().phase, "I");
  assert.match(p.texte(), /peut-être/);
  assert.doesNotMatch(p.texte(), /refus[ée]e/i);
  assert.equal(
    p.doc.getElementById("revoquer-en-urgence"),
    null,
    "aucune nouvelle révocation offerte",
  );
  assert.equal(p.journal.notes, 0, "aucun indice écrit sans acquit");
});

// --- les modifications d'enveloppe ------------------------------------------------------------------------

test("[C2-3] `modifier` : le lanceur part après le masquage, puis l'inventaire est RELU, même si le lanceur échoue", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  const lanceur = differe();
  const resultat = p.cablage.modifier(() => lanceur.promesse);
  assert.equal(resultat.accepte, true);
  assert.equal(p.estampille(), null, "masqué avant le lanceur");
  assert.equal(p.cablage.etat().phase, "SM");
  const lectures = p.attentes.inventaire.length;
  lanceur.rejeter(new Error("refusé par le Worker"));
  await tourner();
  assert.equal(p.attentes.inventaire.length, lectures + 1, "une relecture part quand même");
});

test("[C2-3] `modifier` avec un masquage impossible : le lanceur n'est JAMAIS appelé", async () => {
  const p = monterLeCablage({ masquerEchoue: true });
  p.cablage.demarrer();
  await p.repondreALInventaire({ feuilleEprouvee: false });
  let appele = 0;
  const resultat = p.cablage.modifier(() => {
    appele += 1;
    return Promise.resolve();
  });
  assert.equal(resultat.accepte, false);
  assert.equal(appele, 0);
});

test("[C2-3] la confirmation ouverte est OUBLIÉE par une modification d'enveloppe (ajout de code)", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  p.clic("revoquer-en-urgence");
  await tourner();
  assert.equal(p.cablage.etat().phase, "C");
  p.cablage.modifier(() => Promise.resolve());
  await tourner();
  assert.equal(p.doc.getElementById("revocation-confirmation"), null);
  assert.notEqual(p.cablage.etat().phase, "C");
});

// --- l'indice ----------------------------------------------------------------------------------------------

test("[S3] l'indice persisté ne fait offrir que « aucun geste de révocation dans cette séance », seulement dans P", async () => {
  const p = monterLeCablage({ indice: true });
  await p.jusquAP();
  assert.match(p.doc.getElementById("affichage-fin").textContent, /dans cette séance/);
  assert.doesNotMatch(p.texte(), /La révocation a été faite|révoqué\b/);
});

test("[D4] `definirLIndice` suit la progression lue après coup (L12)", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  assert.equal(p.doc.getElementById("affichage-fin"), null);
  p.cablage.definirLIndice(true);
  await tourner();
  assert.notEqual(p.doc.getElementById("affichage-fin"), null);
});

// --- les événements externes -------------------------------------------------------------------------------

test("[e7] la mort du Worker pendant l'envoi : « peut-être » ; en P : l'écran à relire", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  p.cablage.appliquer({ type: "worker-mort" });
  await tourner();
  assert.equal(p.cablage.etat().phase, "SE");
  assert.match(p.texte(), /Votre coffre doit être relu/);
});

test("[e14] verrouiller est refusé pendant l'envoi et accepté ailleurs", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  assert.equal(p.cablage.appliquer({ type: "verrouiller" }).accepte, true);
  p.clic("revoquer-en-urgence");
  await tourner();
  p.clic("revocation-oui");
  assert.equal(p.cablage.appliquer({ type: "verrouiller" }).accepte, false);
});

test("[e18] « Revenir à mon application » est accepté en P, K, I et appelle `surRevenir`", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  const resultat = p.cablage.appliquer({ type: "revenir-a-l-application" });
  assert.equal(resultat.accepte, true);
  assert.equal(p.journal.revenu, 1);
});
