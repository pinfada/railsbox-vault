// La révocation d'urgence se confirme en DEUX temps (#265).
//
// Avant : un clic sur « Révoquer tous les autres moyens… » envoyait `revoquerEnUrgence` au Worker,
// sans rien demander. La révocation est irréversible. Après : le premier clic ouvre une confirmation
// (« Annuler » y a le focus), et seul « Oui, révoquer » appelle le Worker. La confirmation est une aide
// à la personne, PAS une garde de sécurité : le message au Worker n'a pas de paramètre (ADR 0039, § 5)
// et la garde reste dans le Worker, inchangée.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { oublierLaConfirmation } from "../../src/coquille/confirmation-en-deux-temps.mjs";
import { brancherLesGestesDePortabilite } from "../../src/coquille/gestes-de-portabilite.mjs";
import { GESTES_LONGS } from "../../src/coquille/parcours.mjs";
import { MESSAGES } from "../../src/coquille/textes-du-parcours.mjs";

/** Une page factice : des nœuds qui retiennent leurs écouteurs, leur `hidden` et le focus. */
function pageFactice() {
  const noeuds = new Map();
  const page = { actif: null };
  const nouveau = (id) => {
    const ecouteurs = new Map();
    const attributs = new Map();
    const noeud = {
      id,
      hidden: id === "revocation-confirmation",
      disabled: false,
      textContent: "",
      addEventListener: (type, fn) => ecouteurs.set(type, [...(ecouteurs.get(type) ?? []), fn]),
      setAttribute: (nom, valeur) => attributs.set(nom, String(valeur)),
      getAttribute: (nom) => attributs.get(nom) ?? null,
      focus: () => {
        page.actif = id;
      },
      emettre: (type, evenement = {}) => {
        for (const fn of ecouteurs.get(type) ?? []) fn({ preventDefault() {}, ...evenement });
      },
      click: () => {
        if (!noeud.disabled && !noeud.hidden) noeud.emettre("click");
      },
    };
    return noeud;
  };
  page.racine = {
    querySelector(selecteur) {
      const id = selecteur.slice(1);
      if (id === "sauvegarde-lien") return null;
      if (!noeuds.has(id)) noeuds.set(id, nouveau(id));
      return noeuds.get(id);
    },
  };
  page.noeud = (id) => page.racine.querySelector(`#${id}`);
  return page;
}

function monter({ refuser = false } = {}) {
  const page = pageFactice();
  const envoyes = [];
  const rapport = {};
  brancherLesGestesDePortabilite({
    racine: page.racine,
    demander: async (type) => {
      envoyes.push(type);
      if (refuser) throw { code: "VAULT_X" };
      return { nombreRetires: 1, nombreRestants: 1, retires: {}, restants: {} };
    },
    rapport,
    publier: () => {},
    enregistrer: () => {},
  });
  const revocations = () => envoyes.filter((type) => type === "revoquerEnUrgence").length;
  return { page, revocations, rapport };
}

const apres = () => new Promise((rendre) => setTimeout(rendre, 0));

test("un seul clic sur « Révoquer… » n'appelle pas le Worker : il ouvre la confirmation, focus sur « Annuler »", async () => {
  const { page, revocations } = monter();
  page.noeud("revoquer-en-urgence").click();
  await apres();
  assert.equal(revocations(), 0, "un clic ne révoque rien");
  assert.equal(page.noeud("revocation-confirmation").hidden, false, "la confirmation est montrée");
  assert.equal(page.noeud("revoquer-en-urgence").getAttribute("aria-expanded"), "true");
  assert.equal(page.actif, "revoquer-annuler", "le focus arrive sur le geste sûr");
});

test("« Annuler » referme sans rien appeler et rend le focus au geste qui a demandé", async () => {
  const { page, revocations } = monter();
  page.noeud("revoquer-en-urgence").click();
  page.noeud("revoquer-annuler").click();
  await apres();
  assert.equal(revocations(), 0);
  assert.equal(page.noeud("revocation-confirmation").hidden, true);
  assert.equal(page.noeud("revoquer-en-urgence").getAttribute("aria-expanded"), "false");
  assert.equal(page.actif, "revoquer-en-urgence");
});

test("« Échap » annule comme « Annuler »", async () => {
  const { page, revocations } = monter();
  page.noeud("revoquer-en-urgence").click();
  page.noeud("revocation-confirmation").emettre("keydown", { key: "Escape" });
  await apres();
  assert.equal(revocations(), 0);
  assert.equal(page.noeud("revocation-confirmation").hidden, true);
  assert.equal(page.actif, "revoquer-en-urgence");
});

test("« Oui, révoquer » appelle le Worker UNE fois, même cliqué deux fois", async () => {
  const { page, revocations } = monter();
  page.noeud("revoquer-en-urgence").click();
  const confirmer = page.noeud("revoquer-confirmer");
  confirmer.emettre("click");
  confirmer.emettre("click");
  await apres();
  assert.equal(revocations(), 1);
  assert.equal(page.noeud("revocation-confirmation").hidden, true);
});

test("la confirmation fermée, un clic sur « Oui » (écouteur resté, état périmé) ne révoque rien", async () => {
  const { page, revocations } = monter();
  page.noeud("revoquer-confirmer").emettre("click");
  await apres();
  assert.equal(revocations(), 0, "sans demande préalable, rien ne part");
  page.noeud("revoquer-en-urgence").click();
  page.noeud("revoquer-annuler").click();
  page.noeud("revoquer-confirmer").emettre("click");
  await apres();
  assert.equal(revocations(), 0, "après « Annuler », rien ne part non plus");
});

test("un refus du Worker est dit, et le focus reste sur le geste qui a demandé", async () => {
  const { page, revocations, rapport } = monter({ refuser: true });
  page.noeud("revoquer-en-urgence").click();
  page.noeud("revoquer-confirmer").click();
  await apres();
  assert.equal(revocations(), 1);
  assert.deepEqual(rapport.portabilite.revocation, { refus: "VAULT_X" });
  assert.equal(page.actif, "revoquer-en-urgence");
});

test("le texte de confirmation dit l'irréversible, ce qui est retiré et ce qui reste", () => {
  const texte = MESSAGES.confirmationDeRevocation("recuperation", ["phrase", "recuperation"]);
  assert.match(texte, /irréversible/);
  assert.match(texte, /Votre phrase ne fonctionnera plus/);
  assert.match(texte, /le code de votre feuille/, "ce qui reste");
  assert.match(texte, /sauvegardes déjà faites ne changent pas/);
  assert.match(texte, /restent ouvrables par les anciens moyens/, "ce que les sauvegardes gardent");
  assert.match(texte, /Annuler/);
  assert.doesNotMatch(texte, /passkey/, "un coffre sans passkey n'entend pas parler de passkey");
});

test("la page ordonne « Terminer sans révoquer » AVANT « Révoquer » dans le DOM, sans `order` CSS", async () => {
  const html = await readFile(new URL("../../public/index.html", import.meta.url), "utf8");
  const sans = html.indexOf('data-bloc="sans-revoquer"');
  const revoque = html.indexOf('data-bloc="revocation"');
  assert.ok(sans !== -1 && revoque !== -1);
  assert.ok(sans < revoque, "l'ordre de tabulation est l'ordre du DOM");
  const css = await readFile(
    new URL("../../public/coquille/parcours.css", import.meta.url),
    "utf8",
  );
  const regles = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, , corps]) =>
    /\border\s*:/.test(corps),
  );
  for (const [, selecteur] of regles) {
    assert.doesNotMatch(
      selecteur,
      /portabilite|revocation|revoquer/,
      "aucun `order` ne les sépare",
    );
  }
});

test("une demande dont le geste a quitté l'écran est oubliée, sans bruit, sans rendre le focus", () => {
  const page = pageFactice();
  const noeud = page.noeud;
  const liaison = {
    noeud: page.noeud,
    declencheur: "revoquer-en-urgence",
    panneau: "revocation-confirmation",
  };
  oublierLaConfirmation(liaison); // fermée : rien à faire
  assert.equal(noeud("revocation-confirmation").hidden, true);
  noeud("revocation-confirmation").hidden = false;
  noeud("revoquer-en-urgence").setAttribute("aria-expanded", "true");
  oublierLaConfirmation(liaison);
  assert.equal(noeud("revocation-confirmation").hidden, true);
  assert.equal(noeud("revoquer-en-urgence").getAttribute("aria-expanded"), "false");
  assert.equal(page.actif, null, "le focus n'est pas déplacé");
});

test("pendant un geste long, ni « Révoquer… » ni « Oui, révoquer » ne s'offrent (boutons fermés)", () => {
  assert.ok(GESTES_LONGS.includes("revoquer-en-urgence"));
  assert.ok(GESTES_LONGS.includes("revoquer-confirmer"));
  assert.ok(
    !GESTES_LONGS.includes("revoquer-annuler"),
    "annuler ne touche à rien : il reste ouvert",
  );
});
