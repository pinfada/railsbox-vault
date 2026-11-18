// Relecture de la PR #308 (REFUSÉ 13b01fa) : pendant une révocation EN VOL, aucun geste n'affirme
// que rien n'a été révoqué ni ne quitte l'étape ; après une issue incertaine, aucune alerte ni
// annonce ne dit « refusée ».
//
// Chaque épreuve est née rouge, avant le correctif. Les observateurs sont les VRAIS modules de la
// page (`public/coquille/observateurs-du-parcours.mjs`), importés par le cran de résolution.

import assert from "node:assert/strict";
import { test } from "node:test";

import { creerEtatDeRevocation } from "../../src/coquille/etat-de-la-revocation.mjs";
import { brancherLesGestesDePortabilite } from "../../src/coquille/gestes-de-portabilite.mjs";
import { poserLaSortie } from "../../src/coquille/sortie-de-la-revocation.mjs";
import { montrerLesBlocs } from "../../src/coquille/blocs-montres.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { pageFactice } from "./support-page-factice.mjs";
import { importerLaPage } from "./support-page-reelle.mjs";

const apres = () => new Promise((rendre) => setTimeout(rendre, 0));
const EN_COURS = "portabilite:revocation-en-cours";

// --- Les gestes publient « en cours », puis « incertaine » : jamais « refusée » ---------------------

function monterEnVol() {
  const page = pageFactice();
  const rapport = {};
  let finir = null;
  brancherLesGestesDePortabilite({
    revocation: creerEtatDeRevocation(),
    racine: page.racine,
    demander: (type) =>
      type === "revoquerEnUrgence"
        ? new Promise((rendre, refuser) => {
            finir = { rendre, refuser };
          })
        : Promise.resolve({}),
    rapport,
    publier: () => {},
    enregistrer: () => {},
  });
  const dit = (id) => page.noeud(id).textContent;
  return { page, rapport, dit, finir: () => finir };
}

async function enVol() {
  const m = monterEnVol();
  m.page.noeud("revoquer-en-urgence").click();
  m.page.noeud("revoquer-confirmer").click();
  await apres();
  return m;
}

test("en vol : la ligne de portabilité dit « en cours », que la page lit pour fermer ses gestes", async () => {
  const m = await enVol();
  assert.equal(m.dit("portabilite-etat"), EN_COURS);
});

for (const [nom, erreur, code] of [
  ["un refus typé", { code: "VAULT_X" }, "VAULT_X"],
  ["le Worker mort", { code: CODES_REFUS_COQUILLE.workerMort }, CODES_REFUS_COQUILLE.workerMort],
  ["une erreur sans code", new Error("réseau"), CODES_REFUS_COQUILLE.gesteRompu],
]) {
  test(`après ${nom} : ligne « incertaine » avec son code, aucun texte « refus », diagnostic gardé au relevé`, async () => {
    const m = await enVol();
    m.finir().refuser(erreur);
    await apres();
    assert.equal(m.dit("portabilite-etat"), `portabilite:revocation-incertaine:${code}`);
    assert.doesNotMatch(m.dit("portabilite-etat"), /refus/);
    assert.equal(m.dit("portabilite-refus"), "", "aucune conduite « refusé » n'est écrite");
    assert.match(m.dit("parcours-incertitude"), /peut-être eu lieu/);
    assert.doesNotMatch(m.dit("parcours-incertitude"), /refus/i);
    assert.doesNotMatch(m.dit("revocation-etat"), /refus/i);
    assert.equal(m.rapport.portabilite.revocation.code, code, "le code reste au relevé");
    assert.equal(m.rapport.portabilite.revocation.incertaine, true);
  });
}

// --- La sortie de l'étape 9 -----------------------------------------------------------------------

function sortie(revocation) {
  const sans = { disabled: false };
  const retour = { disabled: false };
  poserLaSortie({
    noeud: (id) =>
      ({ "parcours-sans-revoquer": sans, "parcours-retour-application": retour })[id] ?? null,
    revocation,
  });
  return { sans: sans.disabled, retour: retour.disabled };
}

function etatEn(phase) {
  const r = creerEtatDeRevocation();
  if (phase !== "repos") r.commencer();
  if (phase === "incertaine") r.douter();
  return r;
}

test("en vol : « Terminer sans révoquer » ET « Revenir à mon application » sont fermés (disabled, en plus de la garde)", () => {
  assert.deepEqual(sortie(etatEn("en-vol")), { sans: true, retour: true });
});

test("après une issue incertaine : « Terminer sans révoquer » reste fermé, la sortie qui ne dit rien est rouverte", () => {
  assert.deepEqual(sortie(etatEn("incertaine")), { sans: true, retour: false });
});

test("hors révocation, les deux sorties sont ouvertes", () => {
  assert.deepEqual(sortie(etatEn("repos")), { sans: false, retour: false });
});

test("la page ferme la sortie à chaque rendu des blocs (montrerLesBlocs)", () => {
  const page = pageFactice();
  page.bloc.dataset = { bloc: "revocation" };
  const sans = { disabled: false };
  const retour = { disabled: false };
  const noeud = (id) =>
    ({
      "parcours-sans-revoquer": sans,
      "parcours-retour-application": retour,
    })[id] ?? (id.startsWith("revo") ? page.noeud(id) : null);
  montrerLesBlocs({
    doc: { querySelectorAll: () => [page.bloc] },
    noeud,
    visibles: ["revocation"],
    vueComplete: false,
    dire: () => {},
    releve: { moyenDOuverture: "phrase", moyensProposes: ["phrase"], nombreDeCodes: 0 },
    revocation: etatEn("en-vol"),
  });
  assert.equal(sans.disabled, true);
  assert.equal(retour.disabled, true);
});

// --- Les observateurs de la page : aucune alerte « refusée » ------------------------------------

class ObservateurFactice {
  static actifs = new Map();
  constructor(rappel) {
    this.rappel = rappel;
  }
  observe(cible) {
    ObservateurFactice.actifs.set(cible, this.rappel);
  }
}

async function monterLesObservateurs() {
  globalThis.MutationObserver = ObservateurFactice;
  ObservateurFactice.actifs.clear();
  const { brancherLesObservateurs } = await importerLaPage(
    "public/coquille/observateurs-du-parcours.mjs",
  );
  const noeuds = new Map();
  const noeud = (id) => {
    if (!["portabilite-etat", "coquille-rapport", "cycle-etat"].includes(id)) return null;
    if (!noeuds.has(id)) noeuds.set(id, { id, textContent: "" });
    return noeuds.get(id);
  };
  const dits = new Map();
  const etat = { coffre: "verrouille", ecran: "revoquer", ecranDuGeste: null, pointeur: 9 };
  const avertissements = [];
  const console_ = console.warn;
  console.warn = (texte) => avertissements.push(String(texte));
  brancherLesObservateurs({
    noeud,
    etat,
    dire: (id, texte) => dits.set(id, texte),
    lireJson: () => ({ portabilite: { revocation: { nombreRetires: 0 } } }),
    pas: () => {},
    allerA: () => {},
    rendre: () => {},
  });
  const ligne = (texte) => {
    noeud("portabilite-etat").textContent = texte;
    ObservateurFactice.actifs.get(noeud("portabilite-etat"))();
  };
  return { ligne, dits, etat, avertissements, fin: () => (console.warn = console_) };
}

test("observateur : « en cours » d'une révocation ne dit pas « restauration en cours »", async () => {
  const o = await monterLesObservateurs();
  try {
    o.ligne(EN_COURS);
    assert.doesNotMatch(String(o.dits.get("parcours-attente") ?? ""), /estaur/);
  } finally {
    o.fin();
  }
});

test("observateur : une issue incertaine ne dit PAS « refusée » en alerte : le code va en console, la région persistante dit le reste", async () => {
  const o = await monterLesObservateurs();
  try {
    o.ligne(`portabilite:revocation-incertaine:${CODES_REFUS_COQUILLE.workerMort}`);
    assert.equal(o.dits.get("parcours-refus"), undefined, "aucune alerte de refus n'est écrite");
    assert.ok(o.avertissements.some((t) => t.includes(CODES_REFUS_COQUILLE.workerMort)));
  } finally {
    o.fin();
  }
});
