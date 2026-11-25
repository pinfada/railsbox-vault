/**
 * La garde de l'interface de déverrouillage sur un inventaire REFUSÉ ou INCONNU (#231, revue de la PR
 * #305, relecteur 2) : `ouvrirParLaPhrase` ne juge aucune phrase et ne dérive RIEN quand l'inventaire
 * porte un refus.
 *
 * Elle n'était éprouvée que par le navigateur, donc jamais par la campagne de mutation. Cette suite
 * MONTE la vraie `monterLInterface` sur un document minimal (des nœuds qui retiennent ce qu'on y écrit
 * et les écouteurs qu'on y pose) et exécute le geste : clic sur « ouvrir par la phrase », phrase
 * présentée, inventaire refusé. Sans la garde, la phrase serait jugée sous la politique de CRÉATION ou
 * dérivée — et la dérivation partirait, coûteuse, sur un stockage qui ne répond pas.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { monterLInterface } from "../../src/coquille/interface-de-deverrouillage.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

const PHRASE_ADMISE = "une phrase de déverrouillage assez longue pour la politique";
const NOEUDS_INERTES = new Set([
  "setAttribute",
  "removeAttribute",
  "toggleAttribute",
  "focus",
  "append",
  "replaceChildren",
]);

/** Un nœud qui retient ce qu'on écrit, et les écouteurs, sans rien d'un vrai DOM. */
function noeud() {
  const ecouteurs = new Map();
  const propre = {
    textContent: "",
    value: "",
    disabled: false,
    addEventListener: (type, fonction) => ecouteurs.set(type, fonction),
    declencher: (type) => ecouteurs.get(type)?.(),
  };
  return new Proxy(propre, {
    get: (cible, nom) =>
      nom in cible ? cible[nom] : NOEUDS_INERTES.has(nom) ? () => {} : undefined,
  });
}

/** Une racine dont `querySelector("#x")` rend toujours le MÊME nœud pour le même identifiant. */
function racine() {
  const noeuds = new Map();
  return {
    noeuds,
    querySelector: (selecteur) => {
      if (!noeuds.has(selecteur)) noeuds.set(selecteur, noeud());
      return noeuds.get(selecteur);
    },
  };
}

async function monter(inventaire) {
  const dom = racine();
  const demandes = [];
  const derivations = [];
  const interface_ = monterLInterface({
    document: {},
    racine: dom,
    demander: async (type, corps) => {
      demandes.push(type);
      return type === "inventaire" ? inventaire : corps;
    },
    deriverPhrase: async (appel) => {
      derivations.push(appel);
      return {};
    },
    deriverPasskey: async () => ({}),
  });
  await interface_.rafraichirLInventaire();
  return { dom, demandes, derivations, interface_ };
}

async function cliquerSurLaPhrase(dom) {
  dom.querySelector("#saisie-phrase").value = PHRASE_ADMISE;
  dom.querySelector("#ouvrir-par-phrase").declencher("click");
  // Le gestionnaire est asynchrone : on laisse passer les microtâches qu'il enchaîne.
  await new Promise((resolve) => setTimeout(resolve, 20));
}

const REFUS_DU_STOCKAGE = {
  code: STORAGE_ERROR_CODES.indeterminate,
  message: "le stockage du navigateur est inaccessible pour l'instant",
};

test("un inventaire INCONNU : la phrase n'est ni jugée ni dérivée, et le refus typé est rendu", async () => {
  const { dom, demandes, derivations, interface_ } = await monter({
    present: false,
    versionEnveloppe: null,
    emplacements: [],
    inconnu: true,
    refus: REFUS_DU_STOCKAGE,
  });
  await cliquerSurLaPhrase(dom);

  assert.deepEqual(derivations, [], "aucune dérivation ne part sur un stockage qui ne répond pas");
  assert.deepEqual(demandes, ["inventaire"], "aucune ouverture n'est demandée au Worker");
  assert.equal(interface_.releve.dernierRefus, STORAGE_ERROR_CODES.indeterminate);
  assert.equal(
    dom.querySelector("#saisie-phrase").value,
    PHRASE_ADMISE,
    "la phrase reste dans le champ : rien n'a été consommé, la personne ne la retape pas",
  );
  assert.ok(
    dom
      .querySelector("#deverrouillage-refus")
      .textContent.includes(STORAGE_ERROR_CODES.indeterminate),
    "le refus affiché porte le code typé du stockage",
  );
});

test("un inventaire REFUSÉ (coffre antérieur) : la phrase n'est ni jugée ni dérivée, le refus du coffre est rendu", async () => {
  const code = ENVELOPPE_ERROR_CODES.illisible;
  const { dom, demandes, derivations, interface_ } = await monter({
    present: true,
    versionEnveloppe: 1,
    emplacements: [],
    refus: { code, message: "ce coffre est d'une version antérieure" },
  });
  await cliquerSurLaPhrase(dom);

  assert.deepEqual(
    derivations,
    [],
    "aucune dérivation ne part sur un coffre refusé à l'inventaire",
  );
  assert.deepEqual(demandes, ["inventaire"]);
  assert.equal(interface_.releve.dernierRefus, code);
  assert.equal(dom.querySelector("#saisie-phrase").value, PHRASE_ADMISE);
});

test("un refus d'inventaire PRIME sur la politique de phrase de création : une phrase courte ne le masque pas", async () => {
  // Un inventaire sans coffre MAIS refusé (restauration coupée) : sans la garde, la phrase serait jugée
  // sous la politique de CRÉATION et le refus d'inventaire serait remplacé par « phrase trop faible ».
  const code = ENVELOPPE_ERROR_CODES.illisible;
  const { dom, derivations, interface_ } = await monter({
    present: false,
    versionEnveloppe: null,
    emplacements: [],
    refus: { code, message: "le fichier d'enveloppes est illisible" },
  });
  dom.querySelector("#saisie-phrase").value = "court";
  dom.querySelector("#ouvrir-par-phrase").declencher("click");
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.deepEqual(derivations, []);
  assert.equal(interface_.releve.dernierRefus, code, "le refus rendu est celui de l'inventaire");
  assert.ok(dom.querySelector("#deverrouillage-refus").textContent.includes(code));
});

test("contre-épreuve : un inventaire SANS refus laisse partir la dérivation", async () => {
  const { dom, derivations } = await monter({
    present: true,
    versionEnveloppe: 2,
    emplacements: [],
  });
  await cliquerSurLaPhrase(dom);
  assert.equal(
    derivations.length,
    1,
    "sans refus, la phrase est dérivée : la garde ne bloque pas tout",
  );
});
