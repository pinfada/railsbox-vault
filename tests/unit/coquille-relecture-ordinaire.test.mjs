// Relecture de la PR #308 (REFUSÉ bdff381) : une relecture d'inventaire échouée SANS révocation
// n'annonce pas de révocation ; l'absence de cause vaut « non relu », jamais « relu ».
//
// La CAUSE de l'invalidation est portée par le relevé : `releve.inventaire` vaut `relu`,
// `apres-revocation` (une révocation a été ACQUITTÉE) ou `autre` (tout autre échec : un
// déverrouillage ordinaire, par exemple). Chaque épreuve est née rouge, avant le correctif.

import assert from "node:assert/strict";
import { test } from "node:test";

import { ecranDuParcours } from "../../src/coquille/ecran-du-parcours.mjs";
import { creerEtatDeRevocation } from "../../src/coquille/etat-de-la-revocation.mjs";
import { brancherLesGestesDePortabilite } from "../../src/coquille/gestes-de-portabilite.mjs";
import { monterLInterface } from "../../src/coquille/interface-de-deverrouillage.mjs";
import {
  COFFRE,
  PROGRESSION_INITIALE,
  ecranCourant,
  progressionApres,
} from "../../src/coquille/parcours.mjs";
import { ECRANS } from "../../src/coquille/textes-du-parcours.mjs";
import { pageFactice } from "./support-page-factice.mjs";

const apres = () => new Promise((rendre) => setTimeout(rendre, 0));

const progression = progressionApres(
  progressionApres(PROGRESSION_INITIALE, "feuille", true),
  "etape",
  9,
);

/** Ce que la page observe : un coffre OUVERT, une feuille éprouvée AVANT, une relecture échouée. */
function observer({ inventaire, revocationFaite = false, pointeur = 4 }) {
  const etat = {
    progressionLue: true,
    pointeur,
    progression,
    sousEtatDuCode: "annonce",
    revocationFaite,
    sansRevoquer: false,
    phrasePerdue: false,
    nouveauCodeDemande: false,
  };
  const releve = { moyensProposes: ["phrase", "recuperation"], nombreDeCodes: 1 };
  if (inventaire !== undefined) releve.inventaire = inventaire;
  const rapport = { etat: "ouvert", feuilleEprouvee: true };
  const ecran = ecranDuParcours({
    etat,
    releve,
    rapport,
    texteDesMoyens: "Ce coffre s'ouvre par : une phrase",
    moteur: "chromium",
  });
  return { ecran, etat };
}

const dit = (ecranId) =>
  `${ECRANS[ecranId].titre} ${ECRANS[ecranId].ceQuiVaSePasser} ${ECRANS[ecranId].attendu}`;

test("relecture échouée SANS révocation (revocationFaite: false) : un écran qui ne parle PAS de révocation", () => {
  const { ecran, etat } = observer({ inventaire: "autre", revocationFaite: false });
  assert.equal(etat.coffre, COFFRE.ouvert);
  assert.equal(ecran, "relire");
  assert.doesNotMatch(dit(ecran), /révoc/i, "aucune révocation n'a été acquittée");
  assert.match(dit(ecran), /Rouvrez votre coffre|rechargez/i, "la reprise est dite");
});

test("relecture échouée APRÈS une révocation acquittée : l'écran le dit", () => {
  const { ecran } = observer({
    inventaire: "apres-revocation",
    revocationFaite: true,
    pointeur: 9,
  });
  assert.equal(ecran, "relire-apres-revocation");
  assert.match(dit(ecran), /La révocation a été faite/);
});

test("inventaire relu : le parcours suit son cours, aucun écran « relire »", () => {
  const { ecran } = observer({ inventaire: "relu" });
  assert.doesNotMatch(ecran, /^relire/);
});

test("branchement : un relevé SANS la cause vaut « non relu » — jamais le constat d'avant", () => {
  const { ecran } = observer({ inventaire: undefined });
  assert.equal(ecran, "relire");
});

test("ecranCourant : l'absence de `inventaire` n'a PAS de valeur par défaut dangereuse", () => {
  const ouvert = {
    pointeur: 9,
    coffre: COFFRE.ouvert,
    moyens: ["phrase", "recuperation"],
    nombreDeCodes: 1,
    feuilleEprouvee: true,
    progression,
    revocationFaite: true,
  };
  assert.equal(ecranCourant(ouvert), "relire", "absence = non relu, pas le constat périmé");
  assert.equal(ecranCourant({ ...ouvert, inventaire: "relu" }), "termine");
});

// --- Les causes, portées par l'interface -----------------------------------------------------------------

function nœudFactice() {
  return {
    value: "",
    textContent: "",
    hidden: false,
    disabled: false,
    dataset: {},
    style: {},
    addEventListener() {},
    setAttribute() {},
    removeAttribute() {},
    classList: { toggle() {}, add() {}, remove() {} },
  };
}

async function interfaceLue() {
  const noeuds = new Map();
  const racine = {
    querySelector(selecteur) {
      const id = selecteur.slice(1);
      if (!noeuds.has(id)) noeuds.set(id, nœudFactice());
      return noeuds.get(id);
    },
  };
  let panne = false;
  const i = monterLInterface({
    document: {},
    racine,
    demander: async (type) => {
      if (type !== "inventaire") return {};
      if (panne) throw Object.assign(new Error("injoignable"), { code: "VAULT_X" });
      return {
        present: true,
        versionEnveloppe: 2,
        emplacements: [{ typeKek: 1, identifiant: "id-1", parametres: {} }],
      };
    },
    deriverPhrase: async () => ({}),
    deriverPasskey: async () => ({}),
  });
  await i.rafraichirLInventaire();
  return { i, panne: (v) => (panne = v) };
}

test("interface : un échec de relecture ORDINAIRE a pour cause « autre »", async () => {
  const { i, panne } = await interfaceLue();
  assert.equal(i.releve.inventaire, "relu");
  panne(true);
  await assert.rejects(i.rafraichirLInventaire());
  assert.equal(i.releve.inventaire, "autre");
});

test("interface : un échec de relecture APRÈS une révocation acquittée a pour cause « apres-revocation »", async () => {
  const { i, panne } = await interfaceLue();
  panne(true);
  await assert.rejects(i.rafraichirLInventaire("apres-revocation"));
  assert.equal(i.releve.inventaire, "apres-revocation");
  panne(false);
  await i.rafraichirLInventaire();
  assert.equal(i.releve.inventaire, "relu");
});

test("gestes : la relecture qui suit une révocation acquittée porte la cause « apres-revocation »", async () => {
  const page = pageFactice();
  const causes = [];
  brancherLesGestesDePortabilite({
    revocation: creerEtatDeRevocation(),
    racine: page.racine,
    demander: async () => ({
      versionEnveloppe: 3,
      nombreRetires: 1,
      nombreRestants: 1,
      retires: {},
      restants: {},
    }),
    rapport: { portabilite: {} },
    publier: () => {},
    enregistrer: () => {},
    apresRevocation: async (cause) => {
      causes.push(cause);
    },
  });
  page.noeud("revoquer-en-urgence").click();
  page.noeud("revoquer-confirmer").click();
  await apres();
  await apres();
  assert.deepEqual(causes, ["apres-revocation"]);
});
