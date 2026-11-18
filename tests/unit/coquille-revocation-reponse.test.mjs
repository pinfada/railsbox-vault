// Ce que la page tient pour VRAI d'une réponse du Worker (#310, ADR 0049) : le contrat du SUCCÈS de
// la révocation (R8.6) et la normalisation de l'INVENTAIRE (N1′-N12). Le canal ne garantit que la
// corrélation : type, forme, bornes et immutabilité sont à la charge de ces deux fonctions, TOTALES.

import assert from "node:assert/strict";
import { test } from "node:test";

import { TYPES_PRIVILEGIES } from "../../src/coquille/contrat-de-messages.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import {
  codeDeLErreur,
  evenementDeLaReponse,
  normaliserLInventaire,
} from "../../src/coquille/reponse-de-la-revocation.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { reponseDInventaire } from "./support-revocation.mjs";

const succes = (surcharge = {}) => ({
  type: TYPES_PRIVILEGIES.revoquerEnUrgenceReponse,
  versionEnveloppe: 4,
  restants: { phrase: 1 },
  retires: { recuperation: 2 },
  nombreRetires: 2,
  nombreRestants: 1,
  copieDeSauvegardeRetiree: false,
  etat: "ouvert",
  barrieres: 3,
  ...surcharge,
});

const ok = (valeur) => ({ ok: true, valeur });

test("[R8.6] une réponse conforme est un SUCCÈS ; le succès « sans rien à retirer » en est un aussi", () => {
  assert.equal(evenementDeLaReponse(ok(succes())), "reponse-de-succes");
  assert.equal(
    evenementDeLaReponse(ok(succes({ retires: {}, nombreRetires: 0 }))),
    "reponse-de-succes",
  );
  assert.equal(
    evenementDeLaReponse(ok(succes({ retires: { recuperation: 7 }, nombreRetires: 7 }))),
    "reponse-de-succes",
  );
});

const HORS_CONTRAT = Object.freeze([
  ["type absent", { type: undefined }],
  ["autre type de message", { type: TYPES_PRIVILEGIES.inventaireReponse }],
  ["version nulle", { versionEnveloppe: 0 }],
  ["version non entière", { versionEnveloppe: 1.5 }],
  ["version hors des entiers sûrs", { versionEnveloppe: 2 ** 60 }],
  ["retirés négatifs", { nombreRetires: -1, retires: {} }],
  ["retirés non entiers", { nombreRetires: 1.5 }],
  ["retirés au-delà de sept", { nombreRetires: 8, retires: { recuperation: 8 } }],
  ["aucun restant", { nombreRestants: 0, restants: {} }],
  ["deux restants (le Worker en conserve UN)", { nombreRestants: 2, restants: { phrase: 2 } }],
  ["restants incohérents avec leur compte", { restants: { phrase: 2 } }],
  ["retirés incohérents avec leur compte", { retires: { recuperation: 1 } }],
  ["restants non entiers", { restants: { phrase: "1" } }],
  [
    "trop de clés dans les restants",
    { restants: Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`m${i}`, 1])) },
  ],
  ["restants : un compte nul", { restants: { phrase: 1, autre: 0 } }],
  ["restants en tableau", { restants: [1] }],
  ["copie de sauvegarde non booléenne", { copieDeSauvegardeRetiree: "oui" }],
  ["coffre non ouvert", { etat: "verrouille" }],
  ["barrières négatives", { barrieres: -1 }],
  ["barrières absentes", { barrieres: undefined }],
]);

for (const [nom, surcharge] of HORS_CONTRAT) {
  test(`[R8.6] « succès » hors contrat → réponse malformée : ${nom}`, () => {
    assert.equal(evenementDeLaReponse(ok(succes(surcharge))), "reponse-malformee");
  });
}

test("[R8.6] un succès qui n'est pas un objet est malformé ; aucune entrée ne fait lever la fonction", () => {
  for (const valeur of [null, undefined, "ok", 42, [], () => 1, true]) {
    assert.equal(evenementDeLaReponse(ok(valeur)), "reponse-malformee");
  }
  for (const resultat of [null, undefined, "x", 3, [], {}, { ok: "oui" }, { valeur: succes() }]) {
    assert.equal(evenementDeLaReponse(resultat), "reponse-malformee");
  }
  const piege = {
    get ok() {
      throw new Error("piège");
    },
  };
  assert.equal(evenementDeLaReponse(piege), "reponse-malformee");
  const retors = {
    ok: true,
    get valeur() {
      throw new Error("piège");
    },
  };
  assert.equal(evenementDeLaReponse(retors), "reponse-malformee");
  const proxy = new Proxy(
    {},
    {
      get() {
        throw new Error("piège");
      },
      has() {
        throw new Error("piège");
      },
    },
  );
  assert.equal(evenementDeLaReponse(ok(proxy)), "reponse-malformee");
  const cyclique = succes();
  cyclique.restants = cyclique;
  assert.equal(evenementDeLaReponse(ok(cyclique)), "reponse-malformee");
});

test("[R8.6] chaque champ du succès est lu UNE seule fois", () => {
  const lectures = new Map();
  const espion = new Proxy(succes(), {
    get(cible, cle) {
      lectures.set(cle, (lectures.get(cle) ?? 0) + 1);
      return cible[cle];
    },
  });
  assert.equal(evenementDeLaReponse(ok(espion)), "reponse-de-succes");
  for (const [cle, nombre] of lectures)
    assert.equal(nombre, 1, `« ${String(cle)} » lu ${nombre} fois`);
  assert.ok(lectures.size >= 9);
});

test("[R8.6] les échecs : mort, rompu, refus typé, erreur sans code — jamais « refusée » ni succès", () => {
  const echec = (erreur) => evenementDeLaReponse({ ok: false, erreur });
  assert.equal(
    echec(Object.assign(new Error("x"), { code: CODES_REFUS_COQUILLE.workerMort })),
    "worker-mort",
  );
  assert.equal(
    echec(Object.assign(new Error("x"), { code: CODES_REFUS_COQUILLE.gesteRompu })),
    "worker-rompu",
  );
  assert.equal(echec(Object.assign(new Error("x"), { code: "VAULT_AUTRE" })), "refus-type");
  assert.equal(echec(new Error("sans code")), "erreur-sans-code");
  for (const erreur of [
    null,
    undefined,
    "texte",
    3,
    { code: "" },
    { code: 5 },
    { code: "x".repeat(200) },
  ]) {
    assert.equal(echec(erreur), "erreur-sans-code", `erreur ${String(erreur)}`);
  }
  assert.equal(
    echec({
      get code() {
        throw new Error("piège");
      },
    }),
    "erreur-sans-code",
  );
});

test("[R8.6] `codeDeLErreur` : une chaîne non vide et bornée, lue sous try, sinon null", () => {
  assert.equal(codeDeLErreur({ code: "VAULT_X" }), "VAULT_X");
  assert.equal(codeDeLErreur(null), null);
  assert.equal(codeDeLErreur({ code: "" }), null);
  assert.equal(
    codeDeLErreur({
      get code() {
        throw new Error("piège");
      },
    }),
    null,
  );
});

// --- L'inventaire -----------------------------------------------------------------------------------

const normaliser = (reponse, ouvert = true) => normaliserLInventaire(reponse, { ouvert });

function profondementGele(valeur) {
  if (valeur === null || typeof valeur !== "object") return true;
  return Object.isFrozen(valeur) && Object.values(valeur).every(profondementGele);
}

test("[N11] une réponse conforme donne un instantané GELÉ, publique + constat, sans alias ni clé en trop", () => {
  const reponse = reponseDInventaire({ codes: 2, feuille: true });
  const resultat = normaliser(reponse);
  assert.equal(resultat.ok, true);
  const { public: publique, constat } = resultat.donnees;
  assert.deepEqual(publique.moyens, ["phrase", "recuperation"]);
  assert.equal(publique.nombreDeCodes, 2);
  assert.equal(publique.present, true);
  assert.equal(publique.versionEnveloppe, 3);
  assert.equal(publique.parametres.length, 3);
  assert.deepEqual(constat, { feuilleEprouvee: true });
  assert.ok(profondementGele(resultat.donnees), "gel superficiel");
  assert.ok(!("tailleDeSauvegarde" in publique) && !("identifiantVolume" in publique));
  assert.deepEqual(Object.keys(publique).sort(), [
    "moyens",
    "nombreDeCodes",
    "parametres",
    "present",
    "refus",
    "typesInconnus",
    "versionEnveloppe",
  ]);
  for (const emplacement of publique.parametres) {
    assert.ok(!reponse.emplacements.includes(emplacement), "alias vers l'entrée");
  }
});

test("[N11] muter l'entrée APRÈS la copie ne change pas l'instantané", () => {
  const reponse = reponseDInventaire();
  const resultat = normaliser(reponse);
  const avant = JSON.stringify(resultat.donnees);
  reponse.emplacements[0].typeKek = 255;
  reponse.emplacements.push({ typeKek: 1 });
  reponse.feuilleEprouvee = false;
  assert.equal(JSON.stringify(resultat.donnees), avant);
});

const MALFORMEES = Object.freeze([
  ["autre type de message", (r) => ({ ...r, type: TYPES_PRIVILEGIES.revoquerEnUrgenceReponse })],
  ["type absent", (r) => ({ ...r, type: undefined })],
  ["`present` non booléen", (r) => ({ ...r, present: "oui" })],
  ["`refus` absent", (r) => ({ ...r, refus: undefined })],
  [
    "`refus` sans code conforme",
    (r) => ({ ...r, present: false, emplacements: [], refus: { code: "interdit" } }),
  ],
  ["`refus` en tableau", (r) => ({ ...r, present: false, emplacements: [], refus: [] })],
  ["refus avec des emplacements", (r) => ({ ...r, refus: { code: "VAULT_REFUS" } })],
  ["absent avec des emplacements", (r) => ({ ...r, present: false })],
  [
    "plus de huit emplacements",
    (r) => ({
      ...r,
      emplacements: Array.from({ length: 9 }, (_, i) => ({
        typeKek: TYPES_KEK.phrase,
        identifiantEmplacement: `${i}`.padStart(16, "0"),
        parametresHex: "00",
      })),
    }),
  ],
  ["`emplacements` non tableau", (r) => ({ ...r, emplacements: {} })],
  [
    "`typeKek` hors de [0, 255]",
    (r) => ({ ...r, emplacements: [{ ...r.emplacements[0], typeKek: 256 }] }),
  ],
  [
    "`typeKek` non entier",
    (r) => ({ ...r, emplacements: [{ ...r.emplacements[0], typeKek: 1.5 }] }),
  ],
  [
    "identifiant de mauvaise longueur",
    (r) => ({ ...r, emplacements: [{ ...r.emplacements[0], identifiantEmplacement: "abcd" }] }),
  ],
  [
    "identifiant non hexadécimal",
    (r) => ({
      ...r,
      emplacements: [{ ...r.emplacements[0], identifiantEmplacement: "z".repeat(16) }],
    }),
  ],
  [
    "identifiants en double",
    (r) => ({ ...r, emplacements: [r.emplacements[0], { ...r.emplacements[0] }] }),
  ],
  [
    "paramètres de longueur impaire",
    (r) => ({ ...r, emplacements: [{ ...r.emplacements[0], parametresHex: "abc" }] }),
  ],
  [
    "paramètres au-delà de 1024 caractères",
    (r) => ({ ...r, emplacements: [{ ...r.emplacements[0], parametresHex: "00".repeat(513) }] }),
  ],
  [
    "paramètres absents d'un moyen dérivé par la page",
    (r) => ({
      ...r,
      emplacements: [{ typeKek: TYPES_KEK.phrase, identifiantEmplacement: "11".repeat(8) }],
    }),
  ],
  [
    "paramètres présents pour un code de récupération",
    (r) => ({
      ...r,
      emplacements: [
        {
          typeKek: TYPES_KEK.recuperation,
          identifiantEmplacement: "22".repeat(8),
          parametresHex: "00",
        },
      ],
    }),
  ],
  ["version nulle", (r) => ({ ...r, versionEnveloppe: 0 })],
  ["version absente", (r) => ({ ...r, versionEnveloppe: undefined })],
  ["constat absent coffre ouvert", (r) => ({ ...r, feuilleEprouvee: undefined })],
  ["constat non booléen coffre ouvert", (r) => ({ ...r, feuilleEprouvee: "true" })],
  ["emplacement non objet", (r) => ({ ...r, emplacements: [null] })],
]);

for (const [nom, deformer] of MALFORMEES) {
  test(`[N1′-N9] réponse hors contrat → { ok: false } : ${nom}`, () => {
    assert.deepEqual(normaliser(deformer(reponseDInventaire())), { ok: false });
  });
}

test("[N8] le constat : booléen OBLIGATOIRE coffre ouvert ; IGNORÉ (nul) coffre fermé, même si la réponse dit vrai", () => {
  assert.deepEqual(normaliser(reponseDInventaire({ feuille: false }), true).donnees.constat, {
    feuilleEprouvee: false,
  });
  assert.equal(normaliser(reponseDInventaire({ feuille: true }), false).donnees.constat, null);
  const sansConstat = { ...reponseDInventaire(), feuilleEprouvee: undefined };
  assert.equal(
    normaliser(sansConstat, false).ok,
    true,
    "un coffre fermé n'a pas de constat à fournir",
  );
  assert.equal(normaliser(sansConstat, true).ok, false, "jamais « faux par défaut » coffre ouvert");
});

test("[N9] un coffre OUVERT dont l'enveloppe est absente ou refusée est incohérent ; fermé, un refus est une donnée publique", () => {
  const vide = {
    ...reponseDInventaire(),
    present: false,
    emplacements: [],
    feuilleEprouvee: undefined,
    versionEnveloppe: null,
  };
  assert.equal(normaliser(vide, true).ok, false);
  assert.deepEqual(normaliser(vide, false).donnees.public.moyens, []);
  assert.equal(normaliser(vide, false).donnees.public.present, false);
  const refuse = {
    ...vide,
    refus: { code: "VAULT_COQUILLE_RESTAURATION_INTERROMPUE", message: "texte du Worker" },
  };
  assert.equal(normaliser(refuse, true).ok, false);
  const donnees = normaliser(refuse, false).donnees;
  assert.deepEqual(donnees.public.refus, { code: "VAULT_COQUILLE_RESTAURATION_INTERROMPUE" });
  assert.ok(
    !JSON.stringify(donnees).includes("texte du Worker"),
    "le message du Worker est propagé",
  );
});

test("[N6] un type inconnu n'est jamais un moyen : il est compté à part", () => {
  const reponse = reponseDInventaire();
  reponse.emplacements.push({
    typeKek: 200,
    identifiantEmplacement: "33".repeat(8),
    parametresHex: "00",
  });
  const publique = normaliser(reponse).donnees.public;
  assert.deepEqual(publique.moyens, ["phrase", "recuperation"]);
  assert.deepEqual(publique.typesInconnus, [200]);
});

test("[N4] la taille est bornée AVANT toute itération : un `length` énorme ne boucle pas", () => {
  let acces = 0;
  const tableau = new Proxy([], {
    get(cible, cle) {
      acces += 1;
      return cle === "length" ? 2 ** 31 : cible[cle];
    },
  });
  assert.deepEqual(normaliser({ ...reponseDInventaire(), emplacements: tableau }), { ok: false });
  assert.ok(acces <= 3, `${acces} accès au tableau : il a été parcouru`);
});

test("[N1′] chaque propriété est lue UNE fois ; un piège qui lève donne { ok: false } ; aucune levée", () => {
  const lectures = new Map();
  const espion = new Proxy(reponseDInventaire(), {
    get(cible, cle) {
      lectures.set(cle, (lectures.get(cle) ?? 0) + 1);
      return cible[cle];
    },
  });
  assert.equal(normaliser(espion).ok, true);
  for (const [cle, nombre] of lectures)
    assert.equal(nombre, 1, `« ${String(cle)} » lu ${nombre} fois`);
  const piege = new Proxy(reponseDInventaire(), {
    get() {
      throw new Error("piège");
    },
  });
  assert.deepEqual(normaliser(piege), { ok: false });
  const accesseur = {
    ...reponseDInventaire(),
    get present() {
      throw new Error("piège");
    },
  };
  assert.deepEqual(normaliser(accesseur), { ok: false });
  for (const valeur of [null, undefined, 3, "x", [], () => 1])
    assert.deepEqual(normaliser(valeur), { ok: false });
});

test("[N1′] aucun `Proxy` n'est rejeté sur sa nature : un Proxy transparent valide PASSE, copie indépendante", () => {
  const cible = reponseDInventaire({ codes: 2 });
  const transparent = new Proxy(cible, {});
  const resultat = normaliser(transparent);
  assert.equal(resultat.ok, true);
  const avant = JSON.stringify(resultat.donnees);
  cible.emplacements.length = 0;
  assert.equal(JSON.stringify(resultat.donnees), avant);
});

test("[N10] la taille de sauvegarde n'est jamais propagée comme vérité", () => {
  const reponse = { ...reponseDInventaire(), tailleDeSauvegarde: 123456 };
  assert.ok(!JSON.stringify(normaliser(reponse).donnees).includes("123456"));
});

test("[N12] `ouvert` vient de la PHASE : un non-booléen est une erreur de programmation (TypeError)", () => {
  assert.throws(() => normaliserLInventaire(reponseDInventaire(), {}), TypeError);
  assert.throws(() => normaliserLInventaire(reponseDInventaire()), TypeError);
  assert.throws(() => normaliserLInventaire(reponseDInventaire(), { ouvert: "oui" }), TypeError);
});
