// Les INVARIANTS du modèle de la révocation (#310, ADR 0049), éprouvés EXACTEMENT sur le graphe
// quotienté (16 phases) : arêtes calculées par `transiter`, prédicats écrits ICI à partir des noms de
// phase — jamais lus dans l'ADR ni déduits de la table (D6, preuve indépendante).
//
// Chaque message nomme l'invariant et l'arête : « [I4] (V × reponse-de-succes → RL) ».

import assert from "node:assert/strict";
import { isDeepStrictEqual } from "node:util";
import { test } from "node:test";

import { CLES_DE_TEXTE } from "../../src/coquille/cles-de-la-revocation.mjs";
import {
  EVENEMENTS_DE_GESTE,
  LANCEURS_D_ENVELOPPE,
  accepte,
  transiter,
} from "../../src/coquille/modele-de-la-revocation.mjs";
import {
  creerEtat,
  etatInitial,
  exigerUnEtat,
} from "../../src/coquille/phases-de-la-revocation.mjs";
import { projeter } from "../../src/coquille/projection-de-la-revocation.mjs";
import {
  affirmationsDe,
  canonique,
  empreinteDeLEtat,
  lireLeConstat,
  lirePublic,
  vueDe,
} from "../../src/coquille/vue-de-la-revocation.mjs";
import { LISTE_DES_PHASES, etatDeLaPhase, tousLesEvenements } from "./support-revocation.mjs";

// --- Les prédicats, écrits à la main -----------------------------------------------------------------
const CONNUES = ["FC", "P", "C", "K"];
const EN_LECTURE = ["FL", "SL", "RL"];
const APRES_ENVOI = ["V", "I", "RL", "RE", "RM", "K"];
const APRES_SUCCES = ["RL", "RE", "RM", "K"];
const FERMEES = ["FE", "SE", "RE", "I"];
const SANS_ENVOI = LISTE_DES_PHASES.filter((p) => !APRES_ENVOI.includes(p));

/** Toutes les arêtes : chaque phase (représentant), chaque événement, indice faux puis vrai. */
function toutesLesAretes() {
  const aretes = [];
  for (const indice of [false, true]) {
    for (const phase of LISTE_DES_PHASES) {
      const avant = etatDeLaPhase(phase, { indice });
      for (const evenement of tousLesEvenements(avant)) {
        const resultat = transiter(avant, evenement);
        aretes.push({ de: phase, evenement, avant, ...resultat });
      }
    }
  }
  return aretes;
}
const ARETES = toutesLesAretes();
const ACCEPTEES = ARETES.filter((a) => a.accepte);
/** Un graphe trivial (tout en boucle) satisferait n'importe quelle fermeture : on exige du mouvement. */
function grapheNonTrivial() {
  const mouvements = ACCEPTEES.filter((a) => a.de !== a.etat.phase).length;
  assert.ok(
    mouvements >= 60,
    `[graphe] ${mouvements} arêtes seulement changent de phase : fermeture vide`,
  );
}
const nom = (a) => `(${a.de} × ${a.evenement.type}${a.accepte ? ` → ${a.etat.phase}` : " ✗"})`;

/** L'accessibilité depuis F0 par les arêtes acceptées, en ignorant éventuellement une arête. */
function atteignables(ignorer = () => false) {
  const vus = new Set(["F0"]);
  let change = true;
  while (change) {
    change = false;
    for (const arete of ACCEPTEES) {
      if (ignorer(arete) || !vus.has(arete.de) || vus.has(arete.etat.phase)) continue;
      vus.add(arete.etat.phase);
      change = true;
    }
  }
  return vus;
}

test("[accessibilité] les seize phases sont atteignables depuis F0, et d'elles seules", () => {
  assert.deepEqual([...atteignables()].sort(), [...LISTE_DES_PHASES].sort());
});

test("[I1] un seul envoi : V n'est atteint que par (C × oui), l'effet `envoyer` que par lui", () => {
  for (const arete of ACCEPTEES) {
    const entreEnV = arete.etat.phase === "V" && arete.de !== "V";
    assert.equal(
      entreEnV,
      arete.de === "C" && arete.evenement.type === "oui",
      `[I1] ${nom(arete)}`,
    );
    const envoie = arete.effets.some((effet) => effet.nom === "envoyer");
    assert.equal(
      envoie,
      arete.de === "C" && arete.evenement.type === "oui",
      `[I1] effet envoyer ${nom(arete)}`,
    );
  }
  assert.ok(ACCEPTEES.some((a) => a.de === "C" && a.evenement.type === "oui"));
});

test("[I4] après un envoi : l'ensemble {V, I, RL, RE, RM, K} est FERMÉ, et rien n'y entre que (C × oui)", () => {
  grapheNonTrivial();
  for (const arete of ACCEPTEES) {
    const dedans = APRES_ENVOI.includes(arete.de);
    const arrive = APRES_ENVOI.includes(arete.etat.phase);
    if (dedans) assert.ok(arrive, `[I4] une arête QUITTE l'ensemble : ${nom(arete)}`);
    if (!dedans && arrive) {
      assert.ok(
        arete.de === "C" && arete.evenement.type === "oui",
        `[I4] naissance hors de (C × oui) : ${nom(arete)}`,
      );
    }
  }
});

test("[I4] `aucunGesteDansCetteSeance` ⇔ phase hors de l'ensemble après-envoi", () => {
  for (const phase of LISTE_DES_PHASES) {
    assert.equal(
      affirmationsDe(etatDeLaPhase(phase)).aucunGesteDansCetteSeance,
      SANS_ENVOI.includes(phase),
      `[I4] ${phase}`,
    );
  }
});

test("[I9′] provenance : sans l'arête (V × succès → RL), AUCUN état « après succès » n'est atteignable", () => {
  const sans = atteignables((a) => a.de === "V" && a.evenement.type === "reponse-de-succes");
  for (const phase of APRES_SUCCES)
    assert.ok(!sans.has(phase), `[I9′] ${phase} atteint sans succès`);
  assert.ok(atteignables().has("K"));
});

test("[I9′] fermeture : toute arête qui sort de « après succès » y reste ; aucune naissance parallèle", () => {
  grapheNonTrivial();
  for (const arete of ACCEPTEES) {
    const dedans = APRES_SUCCES.includes(arete.de);
    const arrive = APRES_SUCCES.includes(arete.etat.phase);
    if (dedans) assert.ok(arrive, `[I9′] sortie de l'ensemble : ${nom(arete)}`);
    if (!dedans && arrive) {
      assert.ok(
        arete.de === "V" && arete.evenement.type === "reponse-de-succes",
        `[I9′] naissance : ${nom(arete)}`,
      );
    }
  }
});

test("[I3] `revoque` ⇔ phase après succès, pour les seize phases ; `peutEtreRevoque` ⇔ V ou I", () => {
  for (const phase of LISTE_DES_PHASES) {
    const affirmations = affirmationsDe(etatDeLaPhase(phase));
    assert.equal(affirmations.revoque, APRES_SUCCES.includes(phase), `[I3] revoque en ${phase}`);
    assert.equal(
      affirmations.peutEtreRevoque,
      phase === "V" || phase === "I",
      `[I3] peutEtreRevoque en ${phase}`,
    );
  }
});

test("[I3] le catalogue : étiquettes fermées ; aucune clé « refusée », « rien » ni « tous ouvrent toujours »", () => {
  const etiquettes = new Set(["aucune", "revoque", "peut-etre", "seance", "non-lancee"]);
  for (const [cle, { affirme }] of Object.entries(CLES_DE_TEXTE)) {
    assert.ok(etiquettes.has(affirme), `[I3] étiquette inconnue pour ${cle}`);
    assert.doesNotMatch(
      cle,
      /refus(ee)?$|^rien|tous-|ouvrent-toujours/,
      `[I3] clé interdite : ${cle}`,
    );
  }
  assert.ok(!("refusee" in CLES_DE_TEXTE) && !("rien" in CLES_DE_TEXTE));
  assert.equal(
    CLES_DE_TEXTE.termine?.affirme,
    "revoque",
    "[I3] la clé « termine » doit dire « révoqué »",
  );
  assert.equal(CLES_DE_TEXTE["revocation-incertaine"]?.affirme, "peut-etre");
  assert.equal(CLES_DE_TEXTE["termine-sans-attestation"]?.affirme, "aucune");
  assert.ok(Object.keys(CLES_DE_TEXTE).length >= 20, "[I3] catalogue trop petit");
});

test("[I3] toute clé produite (annonce, écran, région, fin) existe au catalogue ; « revoque » seulement après succès", () => {
  for (const arete of ARETES) {
    if (arete.annonce !== null)
      assert.ok(arete.annonce in CLES_DE_TEXTE, `[I3] annonce hors catalogue : ${arete.annonce}`);
  }
  for (const indice of [false, true]) {
    for (const phase of LISTE_DES_PHASES) {
      const vue = vueDe(etatDeLaPhase(phase, { indice }));
      for (const cle of [vue.ecranImpose, vue.region, vue.finDisponible].filter(
        (c) => c !== null,
      )) {
        assert.ok(cle in CLES_DE_TEXTE, `[I3] clé de vue hors catalogue : ${cle} (${phase})`);
        if (CLES_DE_TEXTE[cle].affirme === "revoque") {
          assert.ok(APRES_SUCCES.includes(phase), `[I3] « révoqué » dit en ${phase} (${cle})`);
        }
      }
    }
  }
});

test("[I13] une lecture en vol ⇔ phase de lecture ; allocation strictement croissante, jamais réutilisée", () => {
  for (const arete of ACCEPTEES) {
    const { etat, avant } = arete;
    assert.equal(etat.lecture !== null, EN_LECTURE.includes(etat.phase), `[I13] ${nom(arete)}`);
    assert.ok(etat.sequence >= avant.sequence, `[I13] sequence décroît ${nom(arete)}`);
    const alloue =
      etat.lecture !== null && (arete.de !== etat.phase || avant.lecture !== etat.lecture);
    if (alloue) {
      assert.equal(etat.lecture, avant.sequence + 1, `[I13] allocation ${nom(arete)}`);
      assert.equal(etat.sequence, avant.sequence + 1, `[I13] sequence ${nom(arete)}`);
    }
  }
});

test("[I13] un résultat n'est accepté qu'avec l'identifiant COURANT, une seule fois (le doublon est refusé)", () => {
  for (const phase of EN_LECTURE) {
    const avant = etatDeLaPhase(phase);
    for (const type of ["relecture-reussie", "relecture-echouee"]) {
      const courante = tousLesEvenements(avant).find(
        (e) => e.type === type && e.lecture === avant.lecture,
      );
      const premiere = transiter(avant, courante);
      assert.equal(premiere.accepte, true, `[I13] ${phase} × ${type} courante`);
      assert.equal(
        transiter(premiere.etat, courante).accepte,
        false,
        `[I13] doublon accepté (${phase} × ${type})`,
      );
      for (const autre of tousLesEvenements(avant).filter(
        (e) => e.type === type && e.lecture !== avant.lecture,
      )) {
        assert.equal(
          transiter(avant, autre).accepte,
          false,
          `[I13] lecture ${autre.lecture} acceptée en ${phase}`,
        );
      }
    }
  }
});

test("[I14] toute arête qui change de phase abandonne la lecture : nulle, ou NEUVE", () => {
  grapheNonTrivial();
  for (const arete of ACCEPTEES.filter((a) => a.de !== a.etat.phase)) {
    const { lecture } = arete.etat;
    assert.ok(lecture === null || lecture > arete.avant.sequence, `[I14] ${nom(arete)}`);
  }
});

test("[I15] C n'est atteint que depuis P (e2) ; toute arête qui le quitte, sauf `oui`, porte `oublier`", () => {
  grapheNonTrivial();
  for (const arete of ACCEPTEES) {
    if (arete.etat.phase === "C" && arete.de !== "C") {
      assert.ok(
        arete.de === "P" && arete.evenement.type === "demander-la-revocation",
        `[I15] entrée ${nom(arete)}`,
      );
    }
    if (arete.de === "C" && arete.etat.phase !== "C" && arete.evenement.type !== "oui") {
      assert.ok(
        arete.effets.some((e) => e.nom === "oublier"),
        `[I15] sans oublier : ${nom(arete)}`,
      );
    }
  }
});

test("[I20] toute arête qui ARRIVE en FE, SE, RE ou I rend `consigner({ evenement, code })`, et seulement elles", () => {
  grapheNonTrivial();
  for (const arete of ACCEPTEES) {
    const consigne = arete.effets.filter((e) => e.nom === "consigner");
    const arrive = FERMEES.includes(arete.etat.phase) && arete.de !== arete.etat.phase;
    assert.equal(consigne.length, arrive ? 1 : 0, `[I20] ${nom(arete)}`);
    if (arrive) {
      assert.equal(
        consigne[0].evenement,
        arete.evenement.cause ?? arete.evenement.type,
        `[I20] événement ${nom(arete)}`,
      );
      assert.equal(consigne[0].code, arete.evenement.code ?? null, `[I20] code ${nom(arete)}`);
    }
  }
});

test("[I22′] R-AFF″ : `vue-a-rendre` en dernier ssi l'occurrence augmente ; `masquer` en tête ssi l'empreinte change", () => {
  grapheNonTrivial();
  for (const arete of ACCEPTEES) {
    const noms = arete.effets.map((e) => e.nom);
    const augmente = arete.etat.occurrence > arete.avant.occurrence;
    assert.equal(noms.at(-1) === "vue-a-rendre", augmente, `[I22′] vue-a-rendre ${nom(arete)}`);
    assert.equal(
      noms.filter((n) => n === "vue-a-rendre").length,
      augmente ? 1 : 0,
      `[I22′] doublon ${nom(arete)}`,
    );
    const change = empreinteDeLEtat(arete.etat) !== empreinteDeLEtat(arete.avant);
    const masque = noms[0] === "masquer" && arete.evenement.type !== "masquage-impossible";
    assert.equal(
      masque,
      change && arete.evenement.type !== "masquage-impossible",
      `[I22′] masquer ${nom(arete)}`,
    );
    assert.ok(noms.indexOf("masquer") <= 0, `[I22′] masquer n'est pas en tête ${nom(arete)}`);
    const consigner = noms.indexOf("consigner");
    if (consigner >= 0 && augmente)
      assert.ok(consigner < noms.indexOf("vue-a-rendre"), `[I22′] ordre ${nom(arete)}`);
  }
});

test("[I25] `occurrence` : +1 exactement si phase, instantané, moyen ou indice changent ; 0 sinon, et sur un refus", () => {
  grapheNonTrivial();
  for (const arete of ARETES) {
    const { avant } = arete;
    if (!arete.accepte) {
      assert.equal(arete.etat, avant, `[I25] refus ${nom(arete)}`);
      continue;
    }
    const change =
      arete.etat.phase !== avant.phase ||
      arete.etat.donnees !== avant.donnees ||
      arete.etat.session.moyen !== avant.session.moyen ||
      arete.etat.indice !== avant.indice;
    assert.equal(arete.etat.occurrence - avant.occurrence, change ? 1 : 0, `[I25] ${nom(arete)}`);
  }
});

test("[I25] P → C → P : trois occurrences distinctes pour deux empreintes de P égales ; (P, faux) → vrai → faux idem", () => {
  const p1 = etatDeLaPhase("P", { occurrence: 1 });
  const c = transiter(p1, { type: "demander-la-revocation" }).etat;
  const p3 = transiter(c, { type: "annuler" }).etat;
  assert.deepEqual([p1.occurrence, c.occurrence, p3.occurrence], [1, 2, 3]);
  assert.equal(empreinteDeLEtat(p1), empreinteDeLEtat(p3), "l'empreinte de P doit revenir");
  const vrai = transiter(p1, { type: "indice-change", valeur: true }).etat;
  const faux = transiter(vrai, { type: "indice-change", valeur: false }).etat;
  assert.deepEqual([vrai.occurrence, faux.occurrence], [2, 3]);
  assert.equal(empreinteDeLEtat(p1), empreinteDeLEtat(faux));
});

/** T9 : les dix-huit arêtes qui quittent {FC, P, C, K} vers l'extérieur de l'ensemble. */
const T9 = Object.freeze([
  ["FC", "coffre-ouvert", "SL"],
  ["FC", "modification-lancee", "FM"],
  ["FC", "worker-mort", "FE"],
  ["FC", "delai-depasse", "FE"],
  ["FC", "masquage-impossible", "FE"],
  ["P", "modification-lancee", "SM"],
  ["P", "worker-mort", "SE"],
  ["P", "delai-depasse", "SE"],
  ["P", "masquage-impossible", "SE"],
  ["C", "oui", "V"],
  ["C", "modification-lancee", "SM"],
  ["C", "worker-mort", "SE"],
  ["C", "delai-depasse", "SE"],
  ["C", "masquage-impossible", "SE"],
  ["K", "modification-lancee", "RM"],
  ["K", "worker-mort", "RE"],
  ["K", "delai-depasse", "RE"],
  ["K", "masquage-impossible", "RE"],
]);

test("[T9] les dix-huit arêtes qui quittent {FC, P, C, K} effacent `donnees` et masquent en tête", () => {
  assert.equal(T9.length, 18);
  const sortantes = ACCEPTEES.filter(
    (a) => CONNUES.includes(a.de) && !CONNUES.includes(a.etat.phase),
  );
  const vues = new Set(sortantes.map((a) => `${a.de}|${a.evenement.type}|${a.etat.phase}`));
  assert.deepEqual(
    [...vues].sort(),
    T9.map(([de, type, vers]) => `${de}|${type}|${vers}`).sort(),
    "[T9] liste des arêtes",
  );
  for (const [de, type, vers] of T9) {
    const arete = ACCEPTEES.find(
      (a) => a.de === de && a.evenement.type === type && a.etat.phase === vers,
    );
    assert.ok(arete, `[T9] arête absente (${de} × ${type} → ${vers})`);
    assert.equal(arete.etat.donnees, null, `[T9] donnees non effacées ${nom(arete)}`);
    assert.equal(lirePublic(arete.etat), null, `[T9] porte publique ouverte ${nom(arete)}`);
    assert.equal(lireLeConstat(arete.etat), null, `[T9] porte du constat ouverte ${nom(arete)}`);
    if (type !== "masquage-impossible")
      assert.equal(arete.effets[0].nom, "masquer", `[T9] masquer en tête ${nom(arete)}`);
  }
});

test("[T9] contre-épreuve : P ↔ C conserve le MÊME objet `donnees` (aucune relecture inventée)", () => {
  const p = etatDeLaPhase("P");
  const c = transiter(p, { type: "demander-la-revocation" }).etat;
  assert.equal(c.phase, "C");
  assert.equal(c.donnees, p.donnees);
  for (const type of [
    "annuler",
    "changer-d-etape",
    "terminer-sans-revoquer",
    "revenir-a-l-application",
  ]) {
    assert.equal(transiter(c, { type }).etat.donnees, p.donnees, `[T9] ${type}`);
  }
});

test("[I5′] `donnees` non nul ⇔ phase connue ; les portes n'ont AUCUNE source et suivent l'état", () => {
  assert.equal(lirePublic.length, 1);
  assert.equal(lireLeConstat.length, 1);
  for (const phase of LISTE_DES_PHASES) {
    const etat = etatDeLaPhase(phase);
    assert.equal(etat.donnees !== null, CONNUES.includes(phase), `[I5′] donnees en ${phase}`);
    assert.equal(
      lirePublic(etat) !== null,
      CONNUES.includes(phase),
      `[I5′] porte publique en ${phase}`,
    );
    assert.equal(
      lireLeConstat(etat) !== null,
      ["P", "C", "K"].includes(phase),
      `[I5′] porte du constat en ${phase}`,
    );
    // Une « source » passée en trop est IGNORÉE : la porte ne la lit jamais.
    assert.equal(
      lirePublic(etat, { moyens: ["fausse"] }),
      lirePublic(etat),
      `[I5′] source lue en ${phase}`,
    );
  }
});

test("[I6] aucune valeur par défaut qui réactive des données : état initial F0, `indice` obligatoire", () => {
  assert.equal(etatInitial(false).phase, "F0");
  assert.equal(etatInitial(false).donnees, null);
  assert.throws(() => etatInitial(), TypeError);
  assert.throws(() => creerEtat({ phase: "P" }), TypeError);
  assert.throws(() => etatInitial("vrai"), TypeError);
});

test("[I8] les gestes ouverts de la projection sont EXACTEMENT ceux de la table", () => {
  for (const phase of LISTE_DES_PHASES) {
    const etat = etatDeLaPhase(phase);
    const gestes = projeter(etat).gestes;
    assert.deepEqual(
      Object.keys(gestes).sort(),
      [...EVENEMENTS_DE_GESTE].sort(),
      `[I8] gestes en ${phase}`,
    );
    for (const type of EVENEMENTS_DE_GESTE) {
      assert.equal(gestes[type].ouvert, accepte(etat, type), `[I8] ${phase} × ${type}`);
      assert.equal(
        gestes[type].ouvert,
        transiter(etat, { type }).accepte,
        `[I8] table ${phase} × ${type}`,
      );
      assert.equal(
        gestes[type].raison === null,
        gestes[type].ouvert,
        `[I8] raison ${phase} × ${type}`,
      );
    }
  }
});

/** I17′ : les 32 cellules « 16 phases × indice », écrites à la main d'après la revue. */
const ECRANS = Object.freeze({
  F0: ["chargement", null],
  FL: ["chargement", null],
  FC: [null, null],
  FE: ["relire", null],
  FM: ["modification-en-cours", null],
  SL: ["chargement", null],
  SE: ["relire", null],
  SM: ["modification-en-cours", null],
  RL: ["chargement-apres-revocation", null],
  RE: ["relire-apres-revocation", null],
  RM: ["modification-en-cours-apres-revocation", null],
  P: [null, null],
  C: [null, null],
  V: ["revoquer-en-cours", "revocation-en-cours"],
  K: ["termine", null],
  I: ["revocation-incertaine", "revocation-incertaine"],
});

test("[I17′] 16 phases × indice : l'état prime ; seule (P, vrai) propose une fin ; la région ne dépend pas de l'indice", () => {
  for (const phase of LISTE_DES_PHASES) {
    for (const indice of [false, true]) {
      const projection = projeter(etatDeLaPhase(phase, { indice }));
      const [ecran, region] = ECRANS[phase];
      assert.equal(projection.ecranImpose, ecran, `[I17′] écran (${phase}, ${indice})`);
      assert.equal(projection.region, region, `[I17′] région (${phase}, ${indice})`);
      const fin = phase === "P" && indice ? "termine-sans-attestation" : null;
      assert.equal(projection.finDisponible, fin, `[I17′] fin (${phase}, ${indice})`);
    }
    if (phase !== "P") {
      const faux = vueDe(etatDeLaPhase(phase, { indice: false }));
      const vrai = vueDe(etatDeLaPhase(phase, { indice: true }));
      assert.deepEqual(vrai, faux, `[I17′] la vue de ${phase} dépend de l'indice`);
    }
  }
  assert.notDeepEqual(
    vueDe(etatDeLaPhase("P", { indice: true })),
    vueDe(etatDeLaPhase("P", { indice: false })),
  );
});

test("[I21′] l'empreinte est la sérialisation de la vue ENTIÈRE : bijection sur le produit des ENTRÉES", () => {
  const jeux = [{}, { codes: 0 }, { codes: 2 }, { phrase: false }, { feuille: false }];
  const echantillon = [];
  for (const phase of LISTE_DES_PHASES) {
    for (const indice of [false, true]) {
      for (const moyen of ["phrase", "webauthn-prf", null]) {
        for (const jeu of jeux) echantillon.push(etatDeLaPhase(phase, { indice, moyen, jeu }));
      }
    }
  }
  const vues = echantillon.map((etat) => vueDe(etat));
  const empreintes = echantillon.map((etat) => empreinteDeLEtat(etat));
  for (let i = 0; i < echantillon.length; i += 1) {
    for (let j = i + 1; j < echantillon.length; j += 1) {
      assert.equal(
        isDeepStrictEqual(vues[i], vues[j]),
        empreintes[i] === empreintes[j],
        `[I21′] bijection ${i}/${j}`,
      );
    }
  }
  assert.ok(
    new Set(empreintes).size > 20,
    "[I21′] trop peu de vues distinctes pour prouver quoi que ce soit",
  );
});

test("[I21′] couverture et perturbation : chaque champ de la vue est dans l'empreinte, et la change", () => {
  const etat = etatDeLaPhase("C", { indice: true });
  const vue = vueDe(etat);
  assert.deepEqual(
    JSON.parse(canonique(vue)),
    JSON.parse(JSON.stringify(vue)),
    "[I21′] la sérialisation omet un champ",
  );
  assert.ok(Object.keys(vue).length >= 8);
  for (const cle of Object.keys(vue)) {
    const perturbee = { ...vue, [cle]: vue[cle] === "x#" ? "y#" : "x#" };
    assert.notEqual(
      canonique(perturbee),
      canonique(vue),
      `[I21′] le champ ${cle} n'entre pas dans l'empreinte`,
    );
  }
  assert.equal(
    canonique({ b: 1, a: [2, { d: null, c: true }] }),
    canonique({ a: [2, { c: true, d: null }], b: 1 }),
    "[I21′] déterminisme",
  );
  assert.throws(() => canonique({ a: undefined }), TypeError);
  assert.notEqual(
    empreinteDeLEtat(etatDeLaPhase("P", { indice: true })),
    empreinteDeLEtat(etatDeLaPhase("P", { indice: false })),
  );
});

test("[I24] e21 ne change que `indice` (et l'occurrence, par la règle) : ni instantané, ni séance, ni lecture", () => {
  for (const phase of LISTE_DES_PHASES) {
    const avant = etatDeLaPhase(phase);
    const apres = transiter(avant, { type: "indice-change", valeur: true });
    assert.equal(apres.accepte, true, `[I24] e21 refusé en ${phase}`);
    assert.equal(apres.etat.phase, phase);
    assert.equal(apres.etat.donnees, avant.donnees, `[I24] donnees ${phase}`);
    assert.equal(apres.etat.session, avant.session, `[I24] session ${phase}`);
    assert.equal(apres.etat.lecture, avant.lecture, `[I24] lecture ${phase}`);
    assert.equal(apres.etat.sequence, avant.sequence, `[I24] sequence ${phase}`);
    assert.equal(apres.etat.indice, true);
    const effets = apres.effets.map((e) => e.nom);
    assert.deepEqual(
      effets,
      phase === "P" ? ["masquer", "vue-a-rendre"] : ["vue-a-rendre"],
      `[I24] effets en ${phase}`,
    );
  }
});

test("[I23″] la liste fermée des lanceurs d'enveloppe ; seules (C × oui) et e19 depuis 7 sources en portent un", () => {
  assert.deepEqual([...LANCEURS_D_ENVELOPPE], ["envoyer", "lancer"]);
  const portent = ACCEPTEES.filter((a) =>
    a.effets.some((e) => LANCEURS_D_ENVELOPPE.includes(e.nom)),
  );
  const cles = new Set(portent.map((a) => `${a.de}|${a.evenement.type}`));
  assert.deepEqual([...cles].sort(), [
    "C|modification-lancee",
    "C|oui",
    "FC|modification-lancee",
    "FL|modification-lancee",
    "K|modification-lancee",
    "P|modification-lancee",
    "RL|modification-lancee",
    "SL|modification-lancee",
  ]);
});

test("[D7] une erreur de programmation est une TypeError, avant toute transition ; un refus rend la MÊME référence", () => {
  const etat = etatDeLaPhase("P");
  assert.throws(() => transiter(etat, { type: "inconnu" }), TypeError);
  assert.throws(() => transiter(etat, null), TypeError);
  assert.throws(() => transiter({ phase: "P" }, { type: "oui" }), TypeError);
  assert.throws(() => transiter(etat, { type: "indice-change", valeur: "oui" }), TypeError);
  assert.throws(() => transiter(etat, { type: "masquage-impossible", action: "x" }), TypeError);
  assert.throws(() => transiter(etat, { type: "relecture-reussie", lecture: "1" }), TypeError);
  assert.throws(() => transiter(etat, { type: "relecture-echouee", lecture: 0 }), TypeError);
  assert.throws(() => accepte(etat, "worker-mort"), TypeError);
  assert.equal(transiter(etat, { type: "oui" }).etat, etat);
});

test("[I13] une lecture réussie sans instantané valide, ou au constat incohérent, est une erreur de programmation (N8, N9)", () => {
  const sl = etatDeLaPhase("SL");
  const fl = etatDeLaPhase("FL");
  assert.throws(() => transiter(sl, { type: "relecture-reussie", lecture: sl.lecture }), TypeError);
  const ouvert = tousLesEvenements(sl).find(
    (e) => e.type === "relecture-reussie" && e.lecture === sl.lecture,
  );
  const ferme = tousLesEvenements(fl).find(
    (e) => e.type === "relecture-reussie" && e.lecture === fl.lecture,
  );
  assert.throws(
    () => transiter(fl, { ...ferme, donnees: ouvert.donnees }),
    TypeError,
    "constat non nul coffre fermé",
  );
  assert.throws(
    () => transiter(sl, { ...ouvert, donnees: ferme.donnees }),
    TypeError,
    "constat absent coffre ouvert",
  );
});

test("[e22] l'annonce d'une bascule dit ce qui n'est PAS parti : « envoi » → seance, « modification » → non-lancee", () => {
  const c = etatDeLaPhase("C");
  const envoi = transiter(c, { type: "masquage-impossible", action: "envoi" });
  const modification = transiter(c, { type: "masquage-impossible", action: "modification" });
  assert.equal(envoi.annonce, "envoi-annule-affichage");
  assert.equal(modification.annonce, "lancement-annule-affichage");
  assert.equal(CLES_DE_TEXTE[envoi.annonce].affirme, "seance");
  assert.equal(CLES_DE_TEXTE[modification.annonce].affirme, "non-lancee");
  assert.ok(
    envoi.effets.every((e) => e.nom !== "masquer"),
    "e22 ne rejoue pas le masquage qui vient d'échouer",
  );
  assert.equal(envoi.etat.phase, "SE");
  assert.equal(affirmationsDe(envoi.etat).aucunGesteDansCetteSeance, true);
});

test("[session] `coffre-ouvert` pose le moyen d'ouverture (validé) ; la vue ne le donne que dans P, C, K", () => {
  const ouvert = transiter(etatDeLaPhase("FC"), { type: "coffre-ouvert", moyen: "phrase" }).etat;
  assert.equal(ouvert.session.moyen, "phrase");
  assert.equal(vueDe(ouvert).moyenDOuverture, null, "SL ne connaît pas encore ses données");
  for (const phase of LISTE_DES_PHASES) {
    const moyen = vueDe(etatDeLaPhase(phase, { moyen: "webauthn-prf" })).moyenDOuverture;
    assert.equal(
      moyen,
      ["P", "C", "K"].includes(phase) ? "webauthn-prf" : null,
      `[session] ${phase}`,
    );
  }
  assert.equal(transiter(etatDeLaPhase("FC"), { type: "coffre-ouvert" }).etat.session.moyen, null);
  assert.throws(
    () => transiter(etatDeLaPhase("FC"), { type: "coffre-ouvert", moyen: 3 }),
    TypeError,
  );
  assert.throws(
    () => transiter(etatDeLaPhase("FC"), { type: "coffre-ouvert", moyen: "" }),
    TypeError,
  );
});

test("[creerEtat] un état incohérent est une erreur de programmation : chaque règle de forme est éprouvée", () => {
  const donnees = etatDeLaPhase("P").donnees;
  const base = {
    phase: "P",
    lecture: null,
    sequence: 3,
    donnees,
    session: Object.freeze({ moyen: null }),
    indice: false,
    occurrence: 1,
  };
  assert.ok(creerEtat(base), "l'état de référence doit être valide");
  const invalides = [
    ["phase inconnue", { phase: "Z", donnees: null }],
    ["indice non booléen", { indice: 0 }],
    ["séquence négative", { sequence: -1 }],
    ["séquence non entière", { sequence: 1.5 }],
    ["occurrence négative", { occurrence: -1 }],
    ["occurrence non entière", { occurrence: 0.5 }],
    ["lecture en vol hors d'une phase de lecture", { lecture: 1 }],
    ["phase de lecture sans lecture", { phase: "SL", donnees: null }],
    ["lecture au-delà de la séquence", { phase: "SL", donnees: null, lecture: 9 }],
    ["lecture nulle", { phase: "SL", donnees: null, lecture: 0 }],
    ["données dans une phase inconnue", { phase: "SE" }],
    ["phase connue sans données", { donnees: null }],
    ["données non gelées", { donnees: { ...donnees } }],
    [
      "données sans partie publique",
      { donnees: Object.freeze({ constat: donnees.constat, lecture: 3 }) },
    ],
    [
      "données sans identifiant de lecture",
      { donnees: Object.freeze({ public: donnees.public, constat: donnees.constat }) },
    ],
    [
      "constat absent coffre ouvert",
      { donnees: Object.freeze({ public: donnees.public, constat: null, lecture: 3 }) },
    ],
    [
      "constat non booléen",
      {
        donnees: Object.freeze({
          public: donnees.public,
          constat: Object.freeze({ feuilleEprouvee: "oui" }),
          lecture: 3,
        }),
      },
    ],
    ["constat présent coffre fermé", { phase: "FC" }],
    ["session non gelée", { session: { moyen: null } }],
    ["session sans moyen", { session: Object.freeze({}) }],
    ["moyen de session non textuel", { session: Object.freeze({ moyen: 3 }) }],
  ];
  for (const [nom, surcharge] of invalides) {
    assert.throws(() => creerEtat({ ...base, ...surcharge }), TypeError, nom);
  }
  assert.throws(
    () => exigerUnEtat({ ...creerEtat(base) }),
    TypeError,
    "un état non gelé est refusé",
  );
  assert.throws(
    () => exigerUnEtat(Object.freeze({ phase: "P" })),
    TypeError,
    "un état incomplet est refusé",
  );
  assert.throws(
    () => exigerUnEtat(Object.freeze({ ...creerEtat(base), en_trop: 1 })),
    TypeError,
    "clé en trop",
  );
  assert.throws(() => exigerUnEtat(null), TypeError);
  assert.throws(
    () => exigerUnEtat(Object.freeze({ ...creerEtat(base), indice: "oui" })),
    TypeError,
  );
});

test("[annonces] un geste REFUSÉ dit pourquoi, sans rien affirmer de faux ; un geste accepté ne dit que ce qui est vrai", () => {
  const refus = (phase, type) => transiter(etatDeLaPhase(phase), { type });
  for (const type of [
    "oui",
    "annuler",
    "demander-la-revocation",
    "terminer-sans-revoquer",
    "verrouiller",
  ]) {
    if (type === "verrouiller") {
      assert.equal(refus("V", type).annonce, "demande-refusee-en-cours");
      continue;
    }
    assert.equal(refus("V", type).annonce, "demande-refusee-en-cours", `V × ${type}`);
    assert.equal(refus("I", type).annonce, "demande-refusee-a-verifier", `I × ${type}`);
  }
  assert.equal(refus("K", "demander-la-revocation").annonce, "demande-refusee-deja-faite");
  assert.equal(refus("K", "oui").annonce, "geste-refuse");
  for (const phase of ["F0", "FL", "FE", "FM", "SL", "SE", "SM", "RL", "RE", "RM"]) {
    assert.equal(
      refus(phase, "oui").annonce,
      "demande-refusee-donnees-inconnues",
      `${phase} × oui`,
    );
  }
  assert.equal(refus("FC", "oui").annonce, "geste-refuse", "FC connaît ses données publiques");
  assert.equal(refus("P", "oui").annonce, "geste-refuse");
  assert.equal(refus("P", "annuler").annonce, "geste-refuse");
  assert.equal(
    refus("P", "worker-rompu").annonce,
    null,
    "un fait n'est pas un geste : aucune annonce",
  );
  assert.equal(transiter(etatDeLaPhase("C"), { type: "annuler" }).annonce, "annulee");
  assert.equal(
    transiter(etatDeLaPhase("P"), { type: "terminer-sans-revoquer" }).annonce,
    "termine-sans-revoquer",
  );
  assert.equal(transiter(etatDeLaPhase("P"), { type: "demander-la-revocation" }).annonce, null);
  assert.equal(transiter(etatDeLaPhase("P"), { type: "revenir-a-l-application" }).annonce, null);
});

test("[I5′] `connu` : les données publiques en FC, P, C, K ; le constat en P, C, K seulement", () => {
  for (const phase of LISTE_DES_PHASES) {
    const { connu } = projeter(etatDeLaPhase(phase));
    assert.equal(connu.public, CONNUES.includes(phase), `[I5′] connu.public en ${phase}`);
    assert.equal(connu.constat, ["P", "C", "K"].includes(phase), `[I5′] connu.constat en ${phase}`);
  }
});

test("[relecture] la lecture acceptée porte son identifiant : `donnees.lecture` ; le constat suit la phase d'arrivée", () => {
  for (const phase of EN_LECTURE) {
    const avant = etatDeLaPhase(phase);
    const evenement = tousLesEvenements(avant).find(
      (e) => e.type === "relecture-reussie" && e.lecture === avant.lecture,
    );
    const apres = transiter(avant, evenement).etat;
    assert.equal(apres.donnees.lecture, avant.lecture, `[relecture] ${phase}`);
    assert.equal(
      apres.donnees.constat === null,
      phase === "FL",
      `[relecture] constat en ${apres.phase}`,
    );
    assert.equal(apres.lecture, null, `[relecture] ${phase} : la lecture n'est pas libérée`);
  }
});

test("[vue] le CONTENU de la vue : moyens, codes, constat, moyen d'ouverture, confirmation — connus, ou nuls", () => {
  for (const phase of LISTE_DES_PHASES) {
    const etat = etatDeLaPhase(phase, { jeu: { codes: 2, feuille: false } });
    const vue = vueDe(etat);
    const connue = CONNUES.includes(phase);
    assert.deepEqual(
      vue.moyens,
      connue ? ["phrase", "recuperation"] : null,
      `[vue] moyens en ${phase}`,
    );
    assert.equal(vue.nombreDeCodes, connue ? 2 : null, `[vue] nombreDeCodes en ${phase}`);
    const constat = ["P", "C", "K"].includes(phase);
    assert.equal(vue.feuilleEprouvee, constat ? false : null, `[vue] feuilleEprouvee en ${phase}`);
    assert.equal(
      vue.moyenDOuverture,
      constat ? "phrase" : null,
      `[vue] moyenDOuverture en ${phase}`,
    );
    assert.deepEqual(
      vue.confirmation,
      phase === "C" ? { ouverte: true } : null,
      `[vue] confirmation en ${phase}`,
    );
    assert.deepEqual(
      lirePublic(etat)?.moyens ?? null,
      vue.moyens,
      `[vue] la porte publique diffère de la vue en ${phase}`,
    );
    assert.equal(
      lireLeConstat(etat)?.feuilleEprouvee ?? null,
      vue.feuilleEprouvee,
      `[vue] la porte du constat diffère en ${phase}`,
    );
  }
});
