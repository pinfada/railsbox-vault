// L'INTERFACE de déverrouillage face au magasin de la révocation (#265, ADR 0049, C2-1′ et C2-3) : ce que
// la dérivation lit, ce que l'ouverture dit, ce que la création d'une feuille déclenche. Un DOM factice,
// les VRAIS modules, des « ancienne source présente » : le miroir et le texte du DOM portent d'autres
// données que l'état, et l'interface ne doit lire que l'état.

import assert from "node:assert/strict";
import { test } from "node:test";

import { monterLInterface } from "../../src/coquille/interface-de-deverrouillage.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { etatDeLaPhase } from "./support-revocation.mjs";
import { lirePublic } from "../../src/coquille/vue-de-la-revocation.mjs";
import { documentFactice } from "./support-dom-factice.mjs";

const IDS = [
  ["p", "deverrouillage-moyens"],
  ["p", "deverrouillage-avertissement"],
  ["p", "deverrouillage-sans-recuperation"],
  ["p", "deverrouillage-attente"],
  ["p", "deverrouillage-refus"],
  ["p", "deverrouillage-etat"],
  ["pre", "deverrouillage-releve"],
  ["input", "ancre-version"],
  ["p", "ancre-aveu"],
  ["input", "saisie-phrase"],
  ["p", "phrase-conseil"],
  ["p", "phrase-aide"],
  ["button", "ouvrir-par-phrase"],
  ["button", "ouvrir-par-passkey"],
  ["input", "saisie-code"],
  ["p", "code-decoupe"],
  ["p", "code-verdict"],
  ["button", "ouvrir-par-code"],
  ["button", "creer-recuperation"],
  ["p", "feuille-code"],
  ["p", "feuille-version"],
  ["p", "feuille-consigne"],
  ["p", "version-a-noter"],
];

const PHRASE = "une phrase assez longue pour ces épreuves";

function monter({ phase = "FC", moyen = null, portes = {}, demander } = {}) {
  const doc = documentFactice();
  doc.poser(IDS.map(([nom, id]) => [nom, { id }]));
  const etat = etatDeLaPhase(phase, { moyen });
  const appels = { derive: [], demande: [], ouvert: [], modifier: 0 };
  const interfaceMontee = monterLInterface({
    document: doc,
    racine: doc,
    demander:
      demander ??
      (async (type, corps) => {
        appels.demande.push([type, corps]);
        if (type === "deverrouiller") return { etat: "ouvert", versionEnveloppe: 3 };
        if (type === "creerRecuperation") {
          return { code: "ABCD-EFGH-JKMN-PQRS-TVWX-0123-4567", versionEnveloppe: 4 };
        }
        return {};
      }),
    deriverPhrase: async (appel) => {
      appels.derive.push(appel);
      return { kek: {}, parametresHex: "ab", identifiantEmplacement: "cd" };
    },
    deriverPasskey: async () => ({}),
    portes: {
      lirePublic: () => lirePublic(etat),
      identifiantDuVolume: () => "coffre",
      coffreOuvert: (m) => appels.ouvert.push(m),
      modifier: (lanceur) => {
        appels.modifier += 1;
        void lanceur().catch(() => {});
        return { accepte: true, annonce: null };
      },
      ...portes,
    },
  });
  return { doc, interfaceMontee, appels, etat };
}

const attendre = () => new Promise((rendre) => setTimeout(rendre, 20));

test("[C2-1′] la dérivation lit l'ÉTAT : un miroir périmé ne lui prête aucun paramètre", async () => {
  const { doc, appels, etat } = monter({ phase: "FC" });
  // « Ancienne source présente » : le texte du DOM et le relevé portent d'autres moyens.
  doc.getElementById("deverrouillage-moyens").textContent = "Ce coffre s'ouvre par : une passkey.";
  doc.getElementById("deverrouillage-releve").textContent = JSON.stringify({
    moyensProposes: ["webauthn-prf"],
  });
  doc.getElementById("saisie-phrase").value = PHRASE;
  doc.getElementById("ouvrir-par-phrase").click();
  await attendre();
  assert.equal(appels.derive.length, 1);
  const { inventaire } = appels.derive[0];
  const public_ = lirePublic(etat);
  assert.equal(inventaire.present, public_.present);
  assert.equal(inventaire.identifiantVolume, "coffre", "la constante du coffre vient de la porte");
  assert.deepEqual(
    inventaire.emplacements.map((e) => e.typeKek),
    public_.parametres.map((e) => e.typeKek),
  );
  assert.ok(inventaire.emplacements.some((e) => typeof e.parametresHex === "string"));
});

test("[C2-1′] l'ouverture est DITE au magasin avec son moyen, et ne relit rien elle-même", async () => {
  const { doc, appels } = monter({ phase: "FC" });
  doc.getElementById("saisie-phrase").value = PHRASE;
  doc.getElementById("ouvrir-par-phrase").click();
  await attendre();
  assert.deepEqual(appels.ouvert, ["phrase"]);
  assert.equal(
    appels.demande.filter(([type]) => type === "inventaire").length,
    0,
    "aucune lecture d'inventaire hors du magasin",
  );
  assert.match(doc.getElementById("deverrouillage-etat").textContent, /Coffre ouvert/);
});

test("[C2-1′] la page ne sait pas encore (null) : aucune dérivation, et le texte dit d'attendre", async () => {
  const { doc, appels } = monter({ portes: { lirePublic: () => null } });
  doc.getElementById("saisie-phrase").value = PHRASE;
  doc.getElementById("ouvrir-par-phrase").click();
  await attendre();
  assert.equal(appels.derive.length, 0);
  assert.match(doc.getElementById("deverrouillage-refus").textContent, /pas fini d'être lu/);
});

test("[mort] sans inventaire parce que le Worker est MORT : le refus typé de la mort, pas « patientez »", async () => {
  const mort = Object.assign(new Error("mort"), { code: CODES_REFUS_COQUILLE.workerMort });
  const { doc, appels } = monter({
    portes: { lirePublic: () => null },
    demander: async () => {
      throw mort;
    },
  });
  doc.getElementById("saisie-phrase").value = PHRASE;
  doc.getElementById("ouvrir-par-phrase").click();
  await attendre();
  assert.equal(appels.derive.length, 0);
  assert.match(
    doc.getElementById("deverrouillage-refus").textContent,
    new RegExp(CODES_REFUS_COQUILLE.workerMort),
  );
});

test("[ADR 0039] un coffre dont l'inventaire est REFUSÉ ne dérive rien : le refus est rendu tout de suite", async () => {
  const refuse = {
    present: true,
    refus: { code: CODES_REFUS_COQUILLE.coffreAnterieur },
    parametres: [],
    versionEnveloppe: null,
  };
  const { doc, appels } = monter({ portes: { lirePublic: () => refuse } });
  doc.getElementById("saisie-phrase").value = PHRASE;
  doc.getElementById("ouvrir-par-phrase").click();
  await attendre();
  assert.equal(appels.derive.length, 0);
  assert.match(
    doc.getElementById("deverrouillage-refus").textContent,
    new RegExp(CODES_REFUS_COQUILLE.coffreAnterieur),
  );
});

test("[refleter] les miroirs sont écrits d'après l'instantané accepté, et le refus d'inventaire dit son message", () => {
  const { doc, interfaceMontee, etat } = monter({ phase: "FC" });
  interfaceMontee.refleter(etat.donnees, "coffre");
  assert.deepEqual(interfaceMontee.releve.moyensProposes, ["phrase", "recuperation"]);
  assert.equal(interfaceMontee.releve.nombreDeCodes, 1);
  assert.match(doc.getElementById("deverrouillage-moyens").textContent, /Ce coffre s'ouvre par/);
  const refus = {
    ...etat.donnees,
    public: { ...etat.donnees.public, refus: { code: CODES_REFUS_COQUILLE.coffreAnterieur } },
  };
  interfaceMontee.refleter(refus, "coffre");
  assert.equal(interfaceMontee.releve.dernierRefus, CODES_REFUS_COQUILLE.coffreAnterieur);
  assert.match(doc.getElementById("deverrouillage-refus").textContent, /13\/09\/2026/);
});

test("[C2-3] créer une feuille ÉCRIT l'enveloppe : le geste passe par `modifier`, puis la feuille s'affiche", async () => {
  const { doc, appels } = monter({ phase: "P", moyen: "phrase" });
  doc.getElementById("creer-recuperation").click();
  await attendre();
  assert.equal(appels.modifier, 1);
  assert.deepEqual(
    appels.demande.map(([type]) => type),
    ["creerRecuperation"],
  );
  assert.match(doc.getElementById("feuille-version").textContent, /Version d'enveloppe : 4/);
  assert.match(doc.getElementById("feuille-code").textContent, /ABCD/);
});

test("[C2-3] `modifier` REFUSE (affichage non protégé, envoi en vol) : le canal n'est jamais appelé", async () => {
  const { doc, appels } = monter({
    phase: "P",
    moyen: "phrase",
    portes: { modifier: () => ({ accepte: false, annonce: "lancement-annule-affichage" }) },
  });
  doc.getElementById("creer-recuperation").click();
  await attendre();
  assert.equal(appels.demande.length, 0);
  assert.equal(doc.getElementById("feuille-code").textContent, "");
});

test("[C2-3] un refus du Worker pendant la création est dit, sans feuille", async () => {
  const refus = Object.assign(new Error("plein"), { code: "VAULT_ENVELOPPE_PLEINE" });
  const { doc } = monter({
    phase: "P",
    moyen: "phrase",
    demander: async () => {
      throw refus;
    },
  });
  doc.getElementById("creer-recuperation").click();
  await attendre();
  assert.match(doc.getElementById("deverrouillage-refus").textContent, /VAULT_ENVELOPPE_PLEINE/);
  assert.equal(doc.getElementById("feuille-code").textContent, "");
});
