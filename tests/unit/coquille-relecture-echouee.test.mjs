// Relecture de la PR #308 (REFUSÉ aefe2d1), point 2 : une relecture d'inventaire qui échoue APRÈS une
// révocation confirmée ne laisse ni moyens ni constat de feuille périmés présentés comme actuels.
// Le succès reste confirmé ; les données dépendantes sont invalidées ; l'échec est dit, avec sa reprise.
//
// Chaque épreuve est née rouge, avant le correctif.

import assert from "node:assert/strict";
import { test } from "node:test";

import { creerEtatDeRevocation } from "../../src/coquille/etat-de-la-revocation.mjs";
import { brancherLesGestesDePortabilite } from "../../src/coquille/gestes-de-portabilite.mjs";
import { monterLInterface } from "../../src/coquille/interface-de-deverrouillage.mjs";
import {
  COFFRE,
  ORIGINES_DU_COFFRE,
  PROGRESSION_INITIALE,
  ecranCourant,
  progressionApres,
} from "../../src/coquille/parcours.mjs";
import { ECRANS, MESSAGES } from "../../src/coquille/textes-du-parcours.mjs";
import { pageFactice } from "./support-page-factice.mjs";

const apres = () => new Promise((rendre) => setTimeout(rendre, 0));

// --- Les gestes : le succès tient, la relecture échouée est dite --------------------------------------

async function revoquerPuisRelireEnEchec({ feuilleEprouvee = true } = {}) {
  const page = pageFactice();
  const rapport = { feuilleEprouvee };
  const revocation = creerEtatDeRevocation();
  brancherLesGestesDePortabilite({
    revocation,
    racine: page.racine,
    demander: async () => ({
      versionEnveloppe: 3,
      nombreRetires: 1,
      nombreRestants: 1,
      retires: { recuperation: 1 },
      restants: { phrase: 1 },
      copieDeSauvegardeRetiree: false,
    }),
    rapport: Object.assign(rapport, { portabilite: {} }),
    publier: () => {},
    enregistrer: () => {},
    apresRevocation: async () => {
      throw new Error("inventaire injoignable");
    },
  });
  page.noeud("revoquer-en-urgence").click();
  page.noeud("revoquer-confirmer").click();
  await apres();
  await apres();
  return { page, rapport, revocation };
}

test("relecture échouée : le succès confirmé tient, la révocation n'est PAS dite incertaine", async () => {
  const { page, rapport, revocation } = await revoquerPuisRelireEnEchec();
  assert.equal(revocation.phase(), "repos");
  assert.equal(rapport.portabilite.revocation.nombreRetires, 1);
  assert.match(page.noeud("portabilite-etat").textContent, /^portabilite:revoque:1-retires/);
  assert.doesNotMatch(page.noeud("parcours-incertitude").textContent, /peut-être eu lieu/);
});

test("relecture échouée : le constat de feuille éprouvée est INVALIDÉ, jamais gardé tel quel", async () => {
  const { rapport } = await revoquerPuisRelireEnEchec({ feuilleEprouvee: true });
  assert.equal(rapport.feuilleEprouvee, false);
});

test("relecture échouée : le message honnête dit « révocation faite », « moyens non mis à jour », « rouvrez »", async () => {
  const { page } = await revoquerPuisRelireEnEchec();
  const dit = page.noeud("parcours-incertitude").textContent;
  assert.equal(dit, MESSAGES.relectureEchouee);
  assert.match(dit, /révocation (a été )?faite/i);
  assert.match(dit, /pas pu être mis à jour/);
  assert.match(dit, /Rouvrez votre coffre/);
});

// --- L'interface : une relecture échouée invalide, au lieu de garder l'ancien inventaire --------------

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

function inventaireDe(emplacements) {
  return { present: true, versionEnveloppe: 2, emplacements };
}

const EMPLACEMENT = (typeKek, rang) => ({
  typeKek,
  identifiant: `id-${rang}`,
  parametres: {},
});

async function interfaceAvecDeuxCodes() {
  const noeuds = new Map();
  const racine = {
    querySelector(selecteur) {
      const id = selecteur.slice(1);
      if (!noeuds.has(id)) noeuds.set(id, nœudFactice());
      return noeuds.get(id);
    },
  };
  let panne = false;
  const interfaceDeDeverrouillage = monterLInterface({
    document: {},
    racine,
    demander: async (type) => {
      if (type !== "inventaire") return {};
      if (panne) throw Object.assign(new Error("injoignable"), { code: "VAULT_X" });
      return inventaireDe([EMPLACEMENT(1, 1), EMPLACEMENT(4, 2), EMPLACEMENT(4, 3)]);
    },
    deriverPhrase: async () => ({}),
    deriverPasskey: async () => ({}),
  });
  await interfaceDeDeverrouillage.rafraichirLInventaire();
  return { interfaceDeDeverrouillage, panne: (v) => (panne = v) };
}

test("interface : une relecture qui échoue INVALIDE les moyens et le compte de codes, et le dit au relevé", async () => {
  const { interfaceDeDeverrouillage, panne } = await interfaceAvecDeuxCodes();
  const releve = interfaceDeDeverrouillage.releve;
  assert.equal(releve.nombreDeCodes > 0, true, "l'inventaire d'avant portait des codes");
  panne(true);
  await assert.rejects(interfaceDeDeverrouillage.rafraichirLInventaire());
  assert.equal(releve.inventaire, "autre");
  assert.equal(releve.moyensProposes, null);
  assert.equal(releve.nombreDeCodes, null);
});

test("interface : une relecture qui réussit ensuite rend l'inventaire relu", async () => {
  const { interfaceDeDeverrouillage, panne } = await interfaceAvecDeuxCodes();
  panne(true);
  await assert.rejects(interfaceDeDeverrouillage.rafraichirLInventaire());
  panne(false);
  await interfaceDeDeverrouillage.rafraichirLInventaire();
  assert.equal(interfaceDeDeverrouillage.releve.inventaire, "relu");
  assert.ok(Array.isArray(interfaceDeDeverrouillage.releve.moyensProposes));
});

// --- Le parcours : aucun constat périmé ne sert de garde ----------------------------------------------

const progression = progressionApres(
  progressionApres(PROGRESSION_INITIALE, "feuille", true),
  "etape",
  9,
);

const OUVERT_A_L_ETAPE_9 = {
  pointeur: 9,
  coffre: COFFRE.ouvert,
  moyens: ["phrase", "recuperation"],
  nombreDeCodes: 1,
  feuilleEprouvee: true, // le constat d'AVANT la révocation : la feuille est retirée depuis
  progression,
  origine: ORIGINES_DU_COFFRE.creation,
  revocationFaite: true,
};

test("parcours : une relecture échouée ne laisse PAS le constat d'avant garder le parcours", () => {
  assert.equal(ecranCourant({ ...OUVERT_A_L_ETAPE_9, inventaire: "relu" }), "termine");
  assert.equal(
    ecranCourant({ ...OUVERT_A_L_ETAPE_9, inventaire: "apres-revocation" }),
    "relire-apres-revocation",
    "constat et moyens périmés : l'écran dit de rouvrir, il ne s'en sert pas",
  );
});

test("parcours : l'écran « relire-apres-revocation » dit la vérité et la reprise", () => {
  assert.ok(ECRANS["relire-apres-revocation"], "l'écran existe");
  const texte = `${ECRANS["relire-apres-revocation"].ceQuiVaSePasser} ${ECRANS["relire-apres-revocation"].attendu}`;
  assert.match(texte, /révocation/i);
  assert.match(texte, /Rouvrez votre coffre|rechargez/i);
  assert.doesNotMatch(texte, /rien n'a été révoqué/i);
});
