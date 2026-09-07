/**
 * Le CYCLE DE VIE ASSEMBLÉ dans la coquille (#163, tranche 3 de #24, ADR 0030).
 *
 * Trois familles de gardes, toutes PURES, et c'est la condition pour qu'une campagne de mutation
 * puisse les atteindre — le motif est celui de `tools/muter-gardes-coquille.mjs` : « une garde
 * écrite dans `public/main.mjs` ne serait éprouvable que par un navigateur ».
 *
 *  - l'ORDRE des huit étapes de `docs/architecture.md` § « Cycle de vie de référence », et le refus
 *    de celle qu'on demanderait avant celle dont elle dépend ;
 *  - les CAPACITÉS que la coquille exige de son propre document, sous la CSP servie ;
 *  - la MORT du Worker de confiance : ce qu'on en constate, et la conduite qui en découle.
 *
 * Ce que ce fichier ne mesure pas : ce que le NAVIGATEUR fait de ces décisions. C'est
 * `tests/browser/coquille-cycle-de-vie.spec.mjs`, sur les trois moteurs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ETAPES_DU_CYCLE,
  ISSUES_DETAPE,
  journalDuCycle,
} from "../../src/coquille/cycle-de-vie.mjs";
import {
  CAPACITES_DE_LA_COQUILLE,
  mesurerLesCapacites,
} from "../../src/coquille/capacites-de-la-coquille.mjs";
import {
  CAUSES_DE_MORT,
  conduiteApresLaMort,
  estUneMortDuWorker,
} from "../../src/coquille/mort-du-worker.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";

/** Capture l'exception d'un geste, ou échoue. `assert.throws` ne rend rien à l'appelant. */
function refusDe(geste) {
  try {
    geste();
  } catch (erreur) {
    return erreur;
  }
  throw new assert.AssertionError({ message: "Le geste n'a rien refusé." });
}

/** Horloge déterministe : le journal date ses étapes, et une épreuve ne dépend d'aucune horloge. */
function horlogeFeinte() {
  let instant = 0;
  return () => {
    instant += 10;
    return instant;
  };
}

// --- L'ORDRE des huit étapes ----------------------------------------------------------------------

test("le cycle nomme les huit étapes de l'architecture, dans leur ordre", () => {
  assert.deepEqual(ETAPES_DU_CYCLE, [
    "identites",
    "exclusiviteEtCanal",
    "backendPuisVm",
    "cadreEtPort",
    "ecritureEtBarriere",
    "exportEtMigration",
    "fermeture",
    "reprise",
  ]);
});

test("une étape franchie dans l'ordre est datée et publiée", () => {
  const journal = journalDuCycle({ maintenant: horlogeFeinte() });
  journal.conclure("identites", ISSUES_DETAPE.franchie);
  journal.conclure("exclusiviteEtCanal", ISSUES_DETAPE.franchie);
  const releve = journal.releve();
  assert.deepEqual(
    releve.map(({ etape, issue }) => [etape, issue]),
    [
      ["identites", ISSUES_DETAPE.franchie],
      ["exclusiviteEtCanal", ISSUES_DETAPE.franchie],
    ],
  );
  assert.ok(releve[1].instantMs > releve[0].instantMs, "l'ordre est mesuré, pas affirmé");
});

test("une étape demandée AVANT celle dont elle dépend est refusée, et le refus est typé", () => {
  const journal = journalDuCycle({ maintenant: horlogeFeinte() });
  journal.conclure("identites", ISSUES_DETAPE.franchie);
  const erreur = refusDe(() => journal.conclure("cadreEtPort", ISSUES_DETAPE.franchie));
  assert.equal(erreur.code, CODES_REFUS_COQUILLE.etapeHorsOrdre);
  assert.equal(journal.releve().length, 1, "rien n'est inscrit d'une étape refusée");
});

test("une étape conclue DEUX fois est refusée : le journal est une suite, pas un état", () => {
  const journal = journalDuCycle({ maintenant: horlogeFeinte() });
  journal.conclure("identites", ISSUES_DETAPE.franchie);
  const erreur = refusDe(() => journal.conclure("identites", ISSUES_DETAPE.franchie));
  assert.equal(erreur.code, CODES_REFUS_COQUILLE.etapeHorsOrdre);
});

test("une étape inconnue est refusée plutôt qu'inscrite", () => {
  const journal = journalDuCycle({ maintenant: horlogeFeinte() });
  assert.throws(() => journal.conclure("verrouillage-automatique", ISSUES_DETAPE.franchie));
});

test("une issue hors de la table est refusée : « conclue » n'est pas un mot libre", () => {
  const journal = journalDuCycle({ maintenant: horlogeFeinte() });
  assert.throws(() => journal.conclure("identites", "presque"));
});

test("le CADRE n'est créé qu'une fois l'étape du backend et de la VM CONCLUE, quelle que soit son issue", () => {
  const journal = journalDuCycle({ maintenant: horlogeFeinte() });
  journal.conclure("identites", ISSUES_DETAPE.franchie);
  journal.conclure("exclusiviteEtCanal", ISSUES_DETAPE.franchie);
  assert.equal(journal.peutEncadrer(), false, "aucun cadre tant que l'étape 3 n'a rien conclu");
  // `differee` est l'issue ORDINAIRE au démarrage : le volume est verrouillé, donc il n'y a ni
  // backend ni VM, et c'est cela qu'on inscrit plutôt que de sauter l'étape.
  journal.conclure("backendPuisVm", ISSUES_DETAPE.differee);
  assert.equal(journal.peutEncadrer(), true);
});

test("le DÉMARRAGE de l'application exige un backend OUVERT, et le refus le dit", () => {
  const journal = journalDuCycle({ maintenant: horlogeFeinte() });
  journal.conclure("identites", ISSUES_DETAPE.franchie);
  journal.conclure("exclusiviteEtCanal", ISSUES_DETAPE.franchie);
  const erreur = refusDe(() =>
    journal.exigerLeBackend({ etatDuVolume: ETATS_DU_VOLUME.verrouille }),
  );
  assert.equal(erreur.code, CODES_REFUS_COQUILLE.etapeHorsOrdre);
  assert.doesNotThrow(() => journal.exigerLeBackend({ etatDuVolume: ETATS_DU_VOLUME.ouvert }));
});

test("un moteur qui ne sait pas atteindre un volume ne démarre aucune VM non plus", () => {
  const journal = journalDuCycle({ maintenant: horlogeFeinte() });
  journal.conclure("identites", ISSUES_DETAPE.franchie);
  journal.conclure("exclusiviteEtCanal", ISSUES_DETAPE.franchie);
  const erreur = refusDe(() =>
    journal.exigerLeBackend({ etatDuVolume: ETATS_DU_VOLUME.indisponible }),
  );
  assert.equal(erreur.code, CODES_REFUS_COQUILLE.etapeHorsOrdre);
});

// --- Les CAPACITÉS, mesurées dans le document de la coquille --------------------------------------

/** Une portée qui possède tout ce que la coquille exige. Les épreuves en retirent une chose. */
function porteeComplete() {
  return {
    crypto: { subtle: {}, getRandomValues() {} },
    WebAssembly: { instantiate() {}, Module: function () {} },
    Worker: function () {},
    MessageChannel: function () {},
    structuredClone() {},
    navigator: { storage: { getDirectory() {} }, credentials: {} },
  };
}

test("les capacités exigées sont nommées, et chacune porte le geste qui en dépend", () => {
  for (const capacite of CAPACITES_DE_LA_COQUILLE) {
    assert.equal(typeof capacite.nom, "string");
    assert.equal(typeof capacite.pourquoi, "string");
    assert.equal(typeof capacite.presente, "function");
    assert.equal(typeof capacite.exigee, "boolean");
  }
});

test("une portée complète ne manque de rien", () => {
  const verdict = mesurerLesCapacites(porteeComplete());
  assert.deepEqual(verdict.manquantes, []);
  assert.equal(verdict.suffisante, true);
});

test("une capacité EXIGÉE absente est nommée, et la coquille se déclare insuffisante", () => {
  const portee = porteeComplete();
  delete portee.WebAssembly;
  const verdict = mesurerLesCapacites(portee);
  assert.deepEqual(verdict.manquantes, ["webassembly"]);
  assert.equal(verdict.suffisante, false);
});

test("une capacité FACULTATIVE absente est nommée sans rendre la coquille insuffisante", () => {
  const portee = porteeComplete();
  delete portee.navigator.credentials;
  const verdict = mesurerLesCapacites(portee);
  assert.deepEqual(verdict.manquantes, ["webauthn"]);
  assert.equal(verdict.suffisante, true, "une passkey absente laisse la phrase et le code");
});

test("la sonde ne LÈVE jamais : une portée sans rien rend un verdict, pas une exception", () => {
  const verdict = mesurerLesCapacites({});
  assert.equal(verdict.suffisante, false);
  assert.ok(verdict.manquantes.includes("webassembly"));
});

test("une sonde qui JETTE rend « absente », et non une exception qui remonte au démarrage", () => {
  // Le chaînage optionnel ne suffit pas à mesurer cette garde : `portee?.crypto?.subtle` ne lève
  // sur aucune portée amputée. Ce qui lève, c'est un ACCESSEUR — et un moteur peut en poser un qui
  // refuse : `navigator.storage` est un accesseur, et un navigateur qui bloque le stockage du site
  // peut y jeter `SecurityError`. Une capacité qu'on ne peut pas interroger est une capacité
  // ABSENTE, jamais un démarrage qui échoue.
  const piegee = {
    get crypto() {
      throw new Error("ce navigateur refuse de répondre");
    },
    WebAssembly: { instantiate() {}, Module: function () {} },
    Worker: function () {},
    MessageChannel: function () {},
    structuredClone() {},
    navigator: { storage: { getDirectory() {} }, credentials: {} },
  };
  const verdict = mesurerLesCapacites(piegee);
  assert.deepEqual(verdict.manquantes, ["webcrypto"]);
  assert.equal(verdict.suffisante, false);
});

// --- La MORT du Worker de confiance ---------------------------------------------------------------

test("les trois causes de mort sont nommées, et rien d'autre n'en est une", () => {
  assert.deepEqual(Object.keys(CAUSES_DE_MORT).sort(), ["erreur", "silence", "terminaison"]);
});

test("le refus d'un Worker mort porte SON code, et non celui d'un type inconnu", () => {
  // C'est le défaut relevé par la Definition of Ready de #25 sur `public/main.mjs:296` : la borne
  // rejetait sous `typeInconnu`, dont le message dit « Requête hors de la liste d'admission ».
  const conduite = conduiteApresLaMort({ cause: CAUSES_DE_MORT.silence });
  assert.equal(conduite.code, CODES_REFUS_COQUILLE.workerMort);
  assert.notEqual(conduite.code, CODES_REFUS_COQUILLE.typeInconnu);
});

test("la conduite est : refuser tout service jusqu'à un geste, et ne RIEN dériver", () => {
  for (const cause of Object.values(CAUSES_DE_MORT)) {
    const conduite = conduiteApresLaMort({ cause });
    assert.equal(conduite.etat, ETATS_DU_VOLUME.verrouille, "l'état est celui que #25 nomme");
    assert.equal(conduite.interfaceRemontee, true);
    assert.equal(conduite.derivationPermise, false);
    assert.equal(conduite.pousseeDeBarriere, false);
    assert.equal(conduite.kekRetenue, false, "aucune KEK gardée « pour plus tard »");
  }
});

test("la mort ne remet AUCUN compte à zéro : le relevé de barrières reste ce qu'il était", () => {
  const conduite = conduiteApresLaMort({ cause: CAUSES_DE_MORT.erreur, barrieres: 7 });
  assert.equal(conduite.barrieres, 7);
});

test("un moteur INDISPONIBLE reste indisponible : la mort ne lui invente pas un verrou", () => {
  const conduite = conduiteApresLaMort({
    cause: CAUSES_DE_MORT.erreur,
    etatConnu: ETATS_DU_VOLUME.indisponible,
  });
  assert.equal(conduite.etat, ETATS_DU_VOLUME.indisponible);
});

test("une cause hors table est refusée : on ne constate pas une mort par défaut", () => {
  assert.throws(() => conduiteApresLaMort({ cause: "lenteur" }));
});

test("`estUneMortDuWorker` reconnaît le refus qu'elle a elle-même posé, et lui seul", () => {
  assert.equal(estUneMortDuWorker({ code: CODES_REFUS_COQUILLE.workerMort }), true);
  assert.equal(estUneMortDuWorker({ code: CODES_REFUS_COQUILLE.typeInconnu }), false);
  assert.equal(estUneMortDuWorker(null), false);
});
