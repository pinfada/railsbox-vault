// Les EXÉCUTEURS du magasin de la révocation sont COPIÉS à la création (#310, #315, revue de 49dfa36).
//
// Le défaut : le magasin gardait l'objet de l'appelant et relisait `ctx.executeurs.envoyer` APRÈS la
// garde « instance intacte ». Un accesseur `envoyer` pouvait appeler `terminer()`, avaler la TypeError
// (violation posée) et rendre une fonction qui était appelée quand même.
//
// La règle : à la CRÉATION, chaque exécuteur est copié dans un objet privé gelé par UNE lecture du
// descripteur de propriété PROPRE ; un accesseur, une propriété héritée ou une valeur non fonction est une
// TypeError ; l'objet de l'appelant n'est plus jamais relu. Les lanceurs reçoivent la fonction déjà
// résolue, et la garde est relue juste avant l'appel.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { creerLaRevocation } from "../../src/coquille/magasin-de-la-revocation.mjs";
import { amener, fabriquer, tourner } from "./support-magasin-revocation.mjs";

const NOMS = Object.freeze([
  "envoyer",
  "relire",
  "publier",
  "noter",
  "oublier",
  "terminer",
  "revenir",
  "masquer",
  "consigner",
  "vueARendre",
]);

for (const nom of NOMS) {
  test(`[accesseur] « ${nom} » défini par un accesseur : TypeError à la création, aucun exécuteur lu`, () => {
    const { executeurs } = fabriquer();
    let lectures = 0;
    const fonction = executeurs[nom];
    const piege = { ...executeurs };
    Object.defineProperty(piege, nom, {
      enumerable: true,
      get() {
        lectures += 1;
        return fonction;
      },
    });
    assert.throws(() => creerLaRevocation({ executeurs: piege, indice: false }), TypeError);
    assert.equal(lectures, 0, "l'accesseur a été exécuté");
  });

  test(`[héritée] « ${nom} » hérité d'un prototype : TypeError à la création`, () => {
    const { executeurs } = fabriquer();
    const { [nom]: heritee, ...propres } = executeurs;
    const objet = Object.assign(Object.create({ [nom]: heritee }), propres);
    assert.throws(() => creerLaRevocation({ executeurs: objet, indice: false }), TypeError);
  });

  test(`[valeur] « ${nom} » qui n'est pas une fonction : TypeError à la création`, () => {
    const { executeurs } = fabriquer();
    for (const valeur of [undefined, null, 3, "f", {}]) {
      assert.throws(
        () => creerLaRevocation({ executeurs: { ...executeurs, [nom]: valeur }, indice: false }),
        TypeError,
      );
    }
  });
}

test("[copie] une propriété REMPLACÉE ou SUPPRIMÉE après la création n'est jamais relue", async () => {
  const f = fabriquer();
  let intrus = 0;
  const intruse = () => {
    intrus += 1;
    return true;
  };
  for (const nom of NOMS) f.executeurs[nom] = intruse;
  Object.defineProperty(f.executeurs, "envoyer", {
    configurable: true,
    get() {
      intrus += 1;
      return intruse;
    },
  });
  delete f.executeurs.relire;
  await amener(f, "C");
  f.magasin.appliquer({ type: "oui" });
  await tourner();
  assert.equal(intrus, 0, "un exécuteur substitué après la création a été appelé");
  assert.equal(f.noms("envoyer").length, 1, "l'envoi d'origine n'a pas eu lieu");
  assert.equal(f.magasin.etat().phase, "V");
});

test("[copie] une propriété AJOUTÉE après la création (un exécuteur de plus) est ignorée", async () => {
  const f = fabriquer();
  let ajoutee = 0;
  f.executeurs.supplementaire = () => {
    ajoutee += 1;
  };
  await amener(f, "C");
  assert.equal(ajoutee, 0);
});

test("[Proxy] un Proxy dont `get` viole le verrou n'est jamais lu : aucune lecture après la création", async () => {
  const base = fabriquer();
  let lectures = 0;
  let magasin = null;
  const espion = new Proxy(base.executeurs, {
    get(cible, cle) {
      lectures += 1;
      try {
        magasin?.terminer();
      } catch {
        // le refus est avalé : c'est le scénario de la revue
      }
      return cible[cle];
    },
  });
  magasin = creerLaRevocation({ executeurs: espion, indice: false });
  const lecturesALaCreation = lectures;
  magasin.demarrer();
  base.lectures.get(1)?.resoudre({});
  await tourner();
  assert.equal(lectures, lecturesALaCreation, "le Proxy a été relu après la création");
  assert.equal(
    lecturesALaCreation,
    0,
    "la création a lu les propriétés par `get` au lieu du descripteur",
  );
});

test("[Proxy] un Proxy dont le descripteur est un ACCESSEUR est refusé à la création", () => {
  const { executeurs } = fabriquer();
  const piege = new Proxy(executeurs, {
    getOwnPropertyDescriptor(cible, cle) {
      const descripteur = Reflect.getOwnPropertyDescriptor(cible, cle);
      if (cle !== "envoyer") return descripteur;
      return { configurable: true, enumerable: true, get: () => cible.envoyer };
    },
  });
  assert.throws(() => creerLaRevocation({ executeurs: piege, indice: false }), TypeError);
});

test("[ordre] la garde « transition intacte » est relue en DERNIER : fonction résolue, garde, appel", () => {
  const source = readFileSync(
    new URL("../../src/coquille/magasin-de-la-revocation.mjs", import.meta.url),
    "utf8",
  );
  const debut = source.indexOf("function executerLesEffets(");
  const corps = source.slice(debut, source.indexOf("\n}\n", debut));
  const resolue = corps.indexOf("fonctionDe(");
  const garde = corps.indexOf("transitionIntacte(");
  const appel = corps.indexOf("(ctx, effet, fonction)");
  assert.ok(resolue >= 0 && garde >= 0 && appel >= 0, "executerLesEffets a changé de forme");
  assert.ok(resolue < garde, "la fonction doit être RÉSOLUE avant la garde");
  assert.ok(garde < appel, "la garde doit précéder l'appel");
  const entre = corps.slice(garde, appel);
  assert.doesNotMatch(
    entre,
    /executeurs|\[|fonctionDe\(/,
    "une lecture a lieu entre la garde et l'appel",
  );
});

// --- UN SEUL contrat de récepteur : tous les exécuteurs sont appelés SANS récepteur ---------------------
// (`this === undefined`). Les effets ordinaires recevaient l'objet privé, les lanceurs aucun : l'appelant ne
// pouvait pas savoir sur quoi compter. L'appelant fournit des fonctions liées ou des fermetures.

test("[this] tous les exécuteurs — effets ordinaires ET lanceurs — sont appelés sans récepteur", async () => {
  const recepteurs = new Map();
  const noter = (nom) =>
    function () {
      // eslint-disable-next-line no-invalid-this
      recepteurs.set(nom, [...(recepteurs.get(nom) ?? []), this]);
    };
  const envois = [];
  const lectures = new Map();
  const executeurs = {
    envoyer: function () {
      noter("envoyer").call(this);
      const attente = Promise.withResolvers();
      envois.push(attente);
      return attente.promise;
    },
    relire: function (lecture) {
      noter("relire").call(this);
      const attente = Promise.withResolvers();
      lectures.set(lecture, attente);
      return attente.promise;
    },
    noter: function () {
      noter("noter").call(this);
      return new Promise(() => {});
    },
    masquer: function () {
      noter("masquer").call(this);
      return true;
    },
    publier: noter("publier"),
    oublier: noter("oublier"),
    terminer: noter("terminer"),
    revenir: noter("revenir"),
    consigner: noter("consigner"),
    vueARendre: noter("vueARendre"),
  };
  const magasin = creerLaRevocation({ executeurs, indice: false });
  const lire = async (lecture) => {
    lectures.get(lecture).resolve({
      type: "vault.coquille.inventaire-prive-reponse",
      refus: null,
      present: true,
      feuilleEprouvee: true,
      versionEnveloppe: 3,
      emplacements: [],
    });
    await tourner();
  };
  magasin.demarrer();
  await lire(1);
  magasin.appliquer({ type: "coffre-ouvert", moyen: "phrase" });
  await lire(2);
  magasin.appliquer({ type: "demander-la-revocation" });
  magasin.appliquer({ type: "annuler" }); // oublier
  magasin.appliquer({ type: "demander-la-revocation" });
  magasin.appliquer({ type: "terminer-sans-revoquer" }); // oublier, terminer
  magasin.appliquer({ type: "demander-la-revocation" });
  magasin.appliquer({ type: "oui" }); // masquer, envoyer
  envois[0].resolve({
    type: "vault.coquille.revoquer-en-urgence-reponse",
    versionEnveloppe: 4,
    restants: { phrase: 1 },
    retires: {},
    nombreRetires: 0,
    nombreRestants: 1,
    copieDeSauvegardeRetiree: false,
    etat: "ouvert",
    barrieres: 1,
  });
  await tourner(); // noter, relire
  await lire(magasin.etat().lecture);
  magasin.appliquer({ type: "revenir-a-l-application" }); // revenir
  let recepteurDuLanceur = "jamais appelé";
  magasin.modifier(function () {
    // eslint-disable-next-line no-invalid-this
    recepteurDuLanceur = this;
    return Promise.resolve();
  });
  magasin.appliquer({ type: "worker-mort" }); // consigner
  await tourner();
  const avecRecepteur = [];
  for (const nom of Object.keys(executeurs)) {
    const vus = recepteurs.get(nom);
    assert.ok(vus !== undefined && vus.length > 0, `« ${nom} » n'a pas été appelé par le parcours`);
    if (vus.some((recepteur) => recepteur !== undefined)) avecRecepteur.push(nom);
  }
  assert.deepEqual(avecRecepteur, [], "des exécuteurs ont reçu un récepteur (this)");
  assert.equal(recepteurDuLanceur, undefined, "le lanceur de `modifier` a reçu un récepteur");
});
