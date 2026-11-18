// Relecture de la PR #308 (REFUSÉ 0b15250) : ce que la confirmation de la révocation dit des
// feuilles, la révocation EN VOL, ses trois issues, et la demande périmée.
//
// Chaque épreuve est née rouge, avant le correctif.

import assert from "node:assert/strict";
import { test } from "node:test";

import { brancherLesGestesDePortabilite } from "../../src/coquille/gestes-de-portabilite.mjs";
import { suivreLaConfirmationDeRevocation } from "../../src/coquille/confirmation-de-la-revocation.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { MESSAGES } from "../../src/coquille/textes-du-parcours.mjs";
import { pageFactice } from "./support-page-factice.mjs";

// --- 1. La confirmation ne dit « rien » que si rien ne part -----------------------------------------

/** Ce que le Worker retire (`revoquerToutSauf`) : tout emplacement, sauf celui de la séance. */
function cequiPart({ moyen, types, codes }) {
  const autresTypes = types.filter((type) => type !== moyen && type !== "recuperation");
  const autresFeuilles =
    (types.includes("recuperation") ? codes : 0) - (moyen === "recuperation" ? 1 : 0);
  return { autresTypes, autresFeuilles };
}

const CAS = [
  { moyen: "recuperation", types: ["recuperation"], codes: 1 },
  { moyen: "recuperation", types: ["recuperation"], codes: 2 },
  { moyen: "recuperation", types: ["phrase", "recuperation"], codes: 1 },
  { moyen: "recuperation", types: ["phrase", "recuperation"], codes: 2 },
  { moyen: "recuperation", types: ["phrase", "webauthn-prf", "recuperation"], codes: 3 },
  { moyen: "phrase", types: ["phrase", "recuperation"], codes: 2 },
  { moyen: "phrase", types: ["phrase"], codes: 0 },
  { moyen: "webauthn-prf", types: ["phrase", "webauthn-prf", "recuperation"], codes: 2 },
];

for (const cas of CAS) {
  test(`la confirmation dit la vérité : ouvert par ${cas.moyen}, ${cas.types.join("+")}, ${cas.codes} code(s)`, () => {
    const options = { codes: cas.codes };
    const texte = MESSAGES.confirmationDeRevocation(cas.moyen, cas.types, options);
    const avertissement = MESSAGES.avertissementDeRevocation(cas.moyen, cas.types, options);
    const { autresTypes, autresFeuilles } = cequiPart(cas);
    const quelqueChosePart = autresTypes.length + autresFeuilles > 0;
    for (const [nom, dit] of [
      ["confirmation", texte],
      ["avertissement", avertissement],
    ]) {
      assert.equal(
        /rien ne sera retiré/.test(dit),
        !quelqueChosePart,
        `${nom} : « rien ne sera retiré » ne se dit que si rien ne part — ${dit}`,
      );
      if (autresFeuilles > 0) {
        const nomme =
          cas.moyen === "recuperation" ? /autres (codes|feuilles)/ : /codes de récupération/;
        assert.match(dit, nomme, `${nom} : les feuilles qui partent sont nommées`);
      }
    }
  });
}

test("la page transmet le nombre de codes : la confirmation RÉELLE annonce le retrait de l'autre feuille", () => {
  const page = pageFactice();
  const dits = new Map();
  suivreLaConfirmationDeRevocation({
    noeud: page.noeud,
    dire: (id, texte) => dits.set(id, texte),
    releve: { moyenDOuverture: "recuperation", moyensProposes: ["recuperation"], nombreDeCodes: 2 },
  });
  const texte = dits.get("revocation-confirmation-texte");
  assert.match(texte, /autres (codes|feuilles)/);
  assert.doesNotMatch(texte, /rien ne sera retiré/);
  const seule = new Map();
  suivreLaConfirmationDeRevocation({
    noeud: page.noeud,
    dire: (id, t) => seule.set(id, t),
    releve: { moyenDOuverture: "recuperation", moyensProposes: ["recuperation"], nombreDeCodes: 1 },
  });
  assert.match(seule.get("revocation-confirmation-texte"), /rien ne sera retiré/);
});

// --- 2. La révocation EN VOL ---------------------------------------------------------------------

/** Un Worker dont la réponse à la révocation est SUSPENDUE jusqu'à ce que l'épreuve la rende. */
function monterEnVol() {
  const page = pageFactice();
  const envoyes = [];
  let finir = null;
  brancherLesGestesDePortabilite({
    racine: page.racine,
    demander: (type) => {
      envoyes.push(type);
      if (type !== "revoquerEnUrgence") return Promise.resolve({});
      return new Promise((rendre, refuser) => {
        finir = { rendre, refuser };
      });
    },
    rapport: {},
    publier: () => {},
    enregistrer: () => {},
  });
  return {
    page,
    envois: () => envoyes.filter((type) => type === "revoquerEnUrgence").length,
    finir: () => finir,
    etat: () => page.noeud("revocation-etat").textContent,
  };
}
const apres = () => new Promise((rendre) => setTimeout(rendre, 0));

async function confirmerSansReponse() {
  const m = monterEnVol();
  m.page.noeud("revoquer-en-urgence").click();
  m.page.noeud("revoquer-confirmer").click();
  await apres();
  assert.equal(m.envois(), 1, "« Oui » a envoyé UN message");
  return m;
}

test("en vol : le geste est désactivé, la confirmation ne se rouvre pas, l'état dit « en cours »", async () => {
  const m = await confirmerSansReponse();
  assert.equal(m.page.noeud("revoquer-en-urgence").getAttribute("aria-disabled"), "true");
  m.page.noeud("revoquer-en-urgence").click();
  await apres();
  assert.equal(m.page.noeud("revocation-confirmation").hidden, true, "pas de réouverture");
  assert.match(m.etat(), /en cours/);
  assert.match(m.etat(), /ne peut plus être annulée/);
});

test("en vol : aucun second message, quoi qu'on clique, et jamais « Rien n'a été révoqué »", async () => {
  const m = await confirmerSansReponse();
  for (const id of ["revoquer-en-urgence", "revoquer-confirmer", "revoquer-annuler"]) {
    m.page.noeud(id).emettre("click");
  }
  m.page.noeud("revocation-confirmation").emettre("keydown", { key: "Escape" });
  await apres();
  assert.equal(m.envois(), 1, "aucun second message");
  assert.doesNotMatch(m.etat(), /Rien n'a été révoqué/);
});

test("issue : le SUCCÈS rend le geste, efface « en cours » et n'annonce rien d'autre", async () => {
  const m = await confirmerSansReponse();
  m.finir().rendre({ nombreRetires: 1, nombreRestants: 1, retires: {}, restants: {} });
  await apres();
  assert.equal(m.page.noeud("revoquer-en-urgence").getAttribute("aria-disabled"), null);
  assert.equal(m.etat(), "");
});

test("issue : un REFUS typé est dit « refusée », le geste est rendu, aucun second message n'est parti", async () => {
  const m = await confirmerSansReponse();
  m.finir().refuser({ code: "VAULT_X" });
  await apres();
  assert.match(m.etat(), /refusée/);
  assert.doesNotMatch(m.etat(), /en cours|Rien n'a été révoqué/);
  assert.equal(m.page.noeud("revoquer-en-urgence").getAttribute("aria-disabled"), null);
  assert.equal(m.envois(), 1);
});

for (const [nom, erreur] of [
  ["le Worker est mort (aucune réponse)", { code: CODES_REFUS_COQUILLE.workerMort }],
  ["le Worker a jeté sans refus à nommer", { code: CODES_REFUS_COQUILLE.gesteRompu }],
  ["une erreur sans code", new Error("réseau")],
]) {
  test(`issue : ${nom} — l'état dit que la révocation a PEUT-ÊTRE eu lieu, jamais qu'elle n'a pas eu lieu`, async () => {
    const m = await confirmerSansReponse();
    m.finir().refuser(erreur);
    await apres();
    assert.match(m.etat(), /peut-être eu lieu/);
    assert.match(m.etat(), /Rouvrez votre coffre/);
    assert.doesNotMatch(m.etat(), /en cours|Rien n'a été révoqué|refusée/);
    assert.equal(m.page.noeud("revoquer-en-urgence").getAttribute("aria-disabled"), null);
    assert.equal(m.envois(), 1);
  });
}

test("après l'issue, une NOUVELLE demande reste possible, et envoie un message de plus, volontaire", async () => {
  const m = await confirmerSansReponse();
  m.finir().refuser({ code: "VAULT_X" });
  await apres();
  m.page.noeud("revoquer-en-urgence").click();
  m.page.noeud("revoquer-confirmer").click();
  await apres();
  assert.equal(m.envois(), 2);
});

// --- 3. La demande périmée ------------------------------------------------------------------------

test("quand le bloc de la révocation est caché, la demande ouverte est oubliée à l'appel suivant", () => {
  const page = pageFactice();
  const releve = { moyenDOuverture: "phrase", moyensProposes: ["phrase"], nombreDeCodes: 0 };
  const suivre = () =>
    suivreLaConfirmationDeRevocation({ noeud: page.noeud, dire: () => {}, releve });
  page.noeud("revocation-confirmation").hidden = false;
  page.noeud("revoquer-en-urgence").setAttribute("aria-expanded", "true");
  suivre();
  assert.equal(
    page.noeud("revocation-confirmation").hidden,
    false,
    "bloc visible : rien à oublier",
  );
  page.bloc.hidden = true;
  suivre();
  assert.equal(page.noeud("revocation-confirmation").hidden, true);
  assert.equal(page.noeud("revoquer-en-urgence").getAttribute("aria-expanded"), "false");
});

test("la page appelle `suivreLaConfirmationDeRevocation` APRÈS avoir montré les blocs, à chaque rendu", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(
    new URL("../../public/coquille/parcours-de-la-page.mjs", import.meta.url),
    "utf8",
  );
  const montre = source.indexOf("montrerLesBlocs(\n      applicationVisible");
  const suit = source.indexOf("suivreLaConfirmationDeRevocation({ noeud, dire, releve })");
  assert.ok(montre !== -1, "la page montre les blocs dans `rendre`");
  assert.ok(suit !== -1, "la page appelle la confirmation");
  assert.ok(montre < suit, "l'oubli lit l'état des blocs APRÈS qu'ils ont été montrés ou cachés");
  assert.match(source, /suivreLaConfirmationDeRevocation\(\{ noeud, dire, releve \}\)/);
  assert.ok(
    source.includes(
      'import { suivreLaConfirmationDeRevocation } from "/src/coquille/confirmation-de-la-revocation.mjs"',
    ),
  );
});
