// Relecture de la PR #308 (REFUSÉ 25254ab) : réglée par CONCEPTION. Un état unique, posé de façon
// synchrone AVANT l'envoi, lu de façon synchrone par chaque gestionnaire de sortie ; un avertissement
// d'incertitude qui vit HORS du bloc de la révocation et qu'un clic n'efface pas.
//
// Chaque épreuve est née rouge, avant le correctif.

import assert from "node:assert/strict";
import { test } from "node:test";

import { creerEtatDeRevocation } from "../../src/coquille/etat-de-la-revocation.mjs";
import { brancherUnGesteDuParcours } from "../../src/coquille/geste-du-parcours.mjs";
import { brancherLesGestesDePortabilite } from "../../src/coquille/gestes-de-portabilite.mjs";
import {
  MESSAGES_EFFACES_AU_CLIC,
  effacerLesMessagesDeGeste,
} from "../../src/coquille/messages-de-geste.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { MESSAGES } from "../../src/coquille/textes-du-parcours.mjs";
import { pageFactice } from "./support-page-factice.mjs";

const apres = () => new Promise((rendre) => setTimeout(rendre, 0));

/** Une page, un état de révocation, et un Worker dont on tient la réponse. */
function monter() {
  const page = pageFactice();
  const revocation = creerEtatDeRevocation();
  const vus = [];
  let finir = null;
  brancherLesGestesDePortabilite({
    revocation,
    racine: page.racine,
    demander: (type) => {
      if (type !== "revoquerEnUrgence") return Promise.resolve({});
      // L'instant de l'ENVOI : ce que la page savait déjà, de façon synchrone.
      vus.push({
        phase: revocation.phase(),
        region: page.noeud("parcours-incertitude").textContent,
        sansRevoquerFerme: revocation.sortieFermee("parcours-sans-revoquer"),
      });
      return new Promise((rendre, refuser) => {
        finir = { rendre, refuser };
      });
    },
    rapport: {},
    publier: () => {},
    enregistrer: () => {},
  });
  const region = () => page.noeud("parcours-incertitude").textContent;
  return { page, revocation, vus, finir: () => finir, region };
}

function confirmer(m) {
  m.page.noeud("revoquer-en-urgence").click();
  m.page.noeud("revoquer-confirmer").click();
}

// --- A. Un état unique, posé AVANT l'envoi ----------------------------------------------------------

test("A : l'état « en vol » est posé AVANT l'envoi, dans le tour de boucle de « Oui »", () => {
  const m = monter();
  confirmer(m); // synchrone : on ne laisse passer AUCUN tour
  assert.equal(m.vus.length, 1, "le message est parti dans le même tour");
  assert.equal(m.vus[0].phase, "en-vol", "l'état est posé avant l'envoi");
  assert.equal(m.vus[0].sansRevoquerFerme, true);
  assert.equal(m.revocation.enVol(), true);
});

test("A : le succès lève l'état ; un échec le rend INCERTAIN ; un succès ultérieur le lève", async () => {
  const m = monter();
  confirmer(m);
  m.finir().rendre({ nombreRetires: 1, nombreRestants: 1, retires: {}, restants: {} });
  await apres();
  assert.equal(m.revocation.phase(), "repos");
  confirmer(m);
  m.finir().refuser({ code: "VAULT_X" });
  await apres();
  assert.equal(m.revocation.phase(), "incertaine");
  confirmer(m);
  m.finir().rendre({ nombreRetires: 1, nombreRestants: 1, retires: {}, restants: {} });
  await apres();
  assert.equal(m.revocation.phase(), "repos", "une révocation qui aboutit lève le doute");
  assert.equal(m.region(), "");
});

for (const [nom, erreur] of [
  ["un refus typé", { code: "VAULT_X" }],
  ["le Worker mort", { code: CODES_REFUS_COQUILLE.workerMort }],
  ["une erreur sans code", new Error("réseau")],
]) {
  test(`A : après ${nom}, l'état est « incertaine »`, async () => {
    const m = monter();
    confirmer(m);
    m.finir().refuser(erreur);
    await apres();
    assert.equal(m.revocation.phase(), "incertaine");
  });
}

/** Un gestionnaire branché comme la page le fait, sur un nœud factice sans `disabled` consulté. */
function gestionnaire(revocation, id) {
  const page = pageFactice();
  const appels = { faire: 0, rendre: 0 };
  brancherUnGesteDuParcours({
    noeud: page.noeud,
    id,
    faire: () => (appels.faire += 1),
    rendre: () => (appels.rendre += 1),
    revocation,
  });
  // `emettre` livre l'événement SANS regarder `disabled` : un `dispatchEvent()` synthétique.
  return { appels, livrer: () => page.noeud(id).emettre("click") };
}

const SORTIES = [
  "parcours-sans-revoquer",
  "parcours-retour-application",
  "parcours-continuer",
  "parcours-commencer",
];

for (const id of SORTIES) {
  test(`A : en vol, le gestionnaire de « ${id} » ne fait rien, même livré par un événement synthétique`, () => {
    const revocation = creerEtatDeRevocation();
    revocation.commencer();
    const g = gestionnaire(revocation, id);
    g.livrer();
    assert.deepEqual(g.appels, { faire: 0, rendre: 0 });
  });
}

test("A : après une issue incertaine, SEUL « Terminer sans révoquer » reste fermé dans son gestionnaire", () => {
  const revocation = creerEtatDeRevocation();
  revocation.commencer();
  revocation.douter();
  const sans = gestionnaire(revocation, "parcours-sans-revoquer");
  sans.livrer();
  assert.deepEqual(sans.appels, { faire: 0, rendre: 0 });
  const retour = gestionnaire(revocation, "parcours-retour-application");
  retour.livrer();
  assert.deepEqual(retour.appels, { faire: 1, rendre: 1 }, "la sortie qui ne dit rien est permise");
});

test("A : hors révocation, les gestionnaires agissent", () => {
  const g = gestionnaire(creerEtatDeRevocation(), "parcours-sans-revoquer");
  g.livrer();
  assert.deepEqual(g.appels, { faire: 1, rendre: 1 });
});

test("A : ordre des événements — la sortie livrée APRÈS « Oui » mais AVANT tout rendu n'affirme rien", async () => {
  const m = monter();
  const sans = gestionnaire(m.revocation, "parcours-sans-revoquer");
  // Un appui sur « Terminer sans révoquer » est maintenu pendant que « Oui » part : le rendu qui
  // poserait `disabled` est DIFFÉRÉ (`pression-du-bouton.mjs`), le `click` arrive ensuite.
  confirmer(m);
  sans.livrer(); // le `click` retenu est livré : aucun rendu n'a eu lieu entre-temps
  assert.deepEqual(sans.appels, { faire: 0, rendre: 0 });
  m.finir().refuser({ code: CODES_REFUS_COQUILLE.workerMort });
  await apres();
  sans.livrer();
  assert.deepEqual(sans.appels, { faire: 0, rendre: 0 }, "fermé aussi après l'issue incertaine");
});

// --- B. Un avertissement qui vit HORS du bloc, qu'un clic n'efface pas ------------------------------

test("B : en vol, la région persistante (hors du bloc) dit « en cours » dès l'envoi", () => {
  const m = monter();
  confirmer(m);
  assert.equal(m.vus[0].region, MESSAGES.revocationEnCours, "dit AVANT l'envoi");
  assert.equal(m.region(), MESSAGES.revocationEnCours);
});

test("B : après une issue incertaine, la région dit « a peut-être eu lieu » et « Rouvrez votre coffre »", async () => {
  const m = monter();
  confirmer(m);
  m.finir().refuser({ code: CODES_REFUS_COQUILLE.workerMort });
  await apres();
  assert.equal(m.region(), MESSAGES.revocationIncertaine);
  assert.match(m.region(), /peut-être eu lieu/);
  assert.match(m.region(), /Rouvrez votre coffre/);
  assert.doesNotMatch(m.region(), /refus/i);
});

test("B : le nettoyage des messages au clic n'efface PAS la région d'incertitude", () => {
  const effaces = [];
  effacerLesMessagesDeGeste((id, texte) => effaces.push([id, texte]));
  assert.deepEqual(effaces.map(([id]) => id).sort(), ["parcours-refus", "parcours-reussite"]);
  assert.ok(!MESSAGES_EFFACES_AU_CLIC.includes("parcours-incertitude"));
  assert.ok(effaces.every(([, texte]) => texte === ""));
});
