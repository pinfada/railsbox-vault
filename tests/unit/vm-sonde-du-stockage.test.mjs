import assert from "node:assert/strict";
import test from "node:test";

import {
  DELAI_ENTRE_ESSAIS_MS,
  ESSAIS_DE_LA_SONDE,
  VERDICTS_DU_STOCKAGE,
  classerLaLectureEnEchec,
  classerLeRejetDeRacine,
  sonderLeStockage,
  sonderLeStockageEnDetail,
} from "../../src/vm/sonde-du-stockage.mjs";

// La SONDE du stockage (#231, revue de la PR #305). WebKit 26.6+ rejette `getDirectory()` par un
// `UnknownError` — « The operation failed for an unknown transient reason (e.g. out of memory). » — en
// contexte éphémère. Le moteur parle d'une raison TRANSITOIRE : ce rejet ne PROUVE pas que l'OPFS est
// absente. La sonde réessaie donc un nombre BORNÉ de fois ; si le rejet persiste, le verdict est
// `indetermine` — jamais `absente` —, et rien n'est figé : une nouvelle sonde peut le lever.

function rejet(nom, message = "The operation failed for an unknown transient reason.") {
  const erreur = new Error(message);
  erreur.name = nom;
  return erreur;
}

/** Un `storage` double dont chaque appel suit le script : une erreur à lever, ou `null` pour réussir. */
function stockageScripte(script) {
  const journal = { appels: 0 };
  return {
    journal,
    storage: {
      getDirectory: async () => {
        const etape = script[Math.min(journal.appels, script.length - 1)];
        journal.appels += 1;
        if (etape !== null) throw etape;
        return {};
      },
    },
  };
}

function minuteurDouble() {
  const attentes = [];
  return { attentes, attendre: async (ms) => attentes.push(ms) };
}

test("la sonde réussit du premier coup : atteignable, aucun délai", async () => {
  const { storage, journal } = stockageScripte([null]);
  const { attentes, attendre } = minuteurDouble();
  assert.equal(await sonderLeStockage({ storage, attendre }), VERDICTS_DU_STOCKAGE.atteignable);
  assert.equal(journal.appels, 1);
  assert.deepEqual(attentes, []);
});

test("un UnknownError TRANSITOIRE puis une réussite : atteignable, rien de figé", async () => {
  const { storage, journal } = stockageScripte([
    rejet("UnknownError"),
    rejet("UnknownError"),
    null,
  ]);
  const { attentes, attendre } = minuteurDouble();
  assert.equal(await sonderLeStockage({ storage, attendre }), VERDICTS_DU_STOCKAGE.atteignable);
  assert.equal(journal.appels, 3);
  assert.deepEqual(attentes, [DELAI_ENTRE_ESSAIS_MS, DELAI_ENTRE_ESSAIS_MS]);
});

test("un UnknownError PERSISTANT : indéterminé après un nombre BORNÉ d'essais, jamais « absente »", async () => {
  const { storage, journal } = stockageScripte([rejet("UnknownError")]);
  const { attentes, attendre } = minuteurDouble();
  const verdict = await sonderLeStockage({ storage, attendre });
  assert.equal(verdict, VERDICTS_DU_STOCKAGE.indetermine);
  assert.notEqual(verdict, VERDICTS_DU_STOCKAGE.absente);
  assert.equal(journal.appels, ESSAIS_DE_LA_SONDE);
  assert.equal(attentes.length, ESSAIS_DE_LA_SONDE - 1, "pas de délai après le dernier essai");
  assert.ok(
    attentes.reduce((somme, ms) => somme + ms, 0) <= 500,
    "le coût en délai est borné : quelques centaines de millisecondes au plus",
  );
});

test("la sonde est RÉESSAYABLE : une seconde sonde après l'indéterminé peut réussir", async () => {
  const { storage } = stockageScripte([
    rejet("UnknownError"),
    rejet("UnknownError"),
    rejet("UnknownError"),
    null,
  ]);
  const { attendre } = minuteurDouble();
  assert.equal(await sonderLeStockage({ storage, attendre }), VERDICTS_DU_STOCKAGE.indetermine);
  assert.equal(await sonderLeStockage({ storage, attendre }), VERDICTS_DU_STOCKAGE.atteignable);
});

test("les refus de capacité DÉJÀ typés sont une absence, sans réessai", async () => {
  for (const nom of ["SecurityError", "TypeMismatchError"]) {
    const { storage, journal } = stockageScripte([rejet(nom)]);
    const { attentes, attendre } = minuteurDouble();
    assert.equal(await sonderLeStockage({ storage, attendre }), VERDICTS_DU_STOCKAGE.absente, nom);
    assert.equal(journal.appels, 1, nom);
    assert.deepEqual(attentes, [], nom);
  }
});

test("tout AUTRE rejet est une panne, sans réessai : ni absente ni indéterminée", async () => {
  for (const nom of ["QuotaExceededError", "InvalidStateError", "NotAllowedError", "Error"]) {
    const { storage, journal } = stockageScripte([rejet(nom)]);
    const { attentes, attendre } = minuteurDouble();
    assert.equal(await sonderLeStockage({ storage, attendre }), VERDICTS_DU_STOCKAGE.panne, nom);
    assert.equal(journal.appels, 1, nom);
    assert.deepEqual(attentes, [], nom);
  }
  const { storage } = stockageScripte(["une chaîne, pas une erreur"]);
  assert.equal(await sonderLeStockage({ storage }), VERDICTS_DU_STOCKAGE.panne);
});

test("une fonction getDirectory absente est une absence, sans appel", async () => {
  for (const storage of [{}, undefined]) {
    assert.equal(await sonderLeStockage({ storage }), VERDICTS_DU_STOCKAGE.absente);
  }
});

test("un UnknownError devenu autre chose en cours de route : le dernier verdict gagne", async () => {
  const { storage } = stockageScripte([rejet("UnknownError"), rejet("QuotaExceededError")]);
  const { attendre } = minuteurDouble();
  assert.equal(await sonderLeStockage({ storage, attendre }), VERDICTS_DU_STOCKAGE.panne);
});

test("le classement du rejet de racine : trois familles, et rien d'autre", () => {
  assert.equal(classerLeRejetDeRacine(rejet("UnknownError")), "indetermine");
  assert.equal(classerLeRejetDeRacine(rejet("SecurityError")), "absente");
  assert.equal(classerLeRejetDeRacine(rejet("TypeMismatchError")), "absente");
  assert.equal(classerLeRejetDeRacine(rejet("QuotaExceededError")), "panne");
  assert.equal(classerLeRejetDeRacine(undefined), "panne");
  assert.equal(classerLeRejetDeRacine({ name: "UnknownError" }), "indetermine");
});

test("le DÉTAIL de la sonde : un verdict, et le code précis d'une panne — rien d'autre", async () => {
  const code = async (nom) =>
    (await sonderLeStockageEnDetail({ storage: stockageScripte([rejet(nom)]).storage })).code;
  assert.equal(await code("QuotaExceededError"), "VAULT_STORAGE_QUOTA_EXCEEDED");
  assert.equal(await code("InvalidStateError"), "VAULT_STORAGE_HANDLE_LOST");
  assert.equal(await code("Error"), "VAULT_STORAGE_SUPPORT_FAILURE");

  const { attendre } = minuteurDouble();
  const attendus = [
    ["atteignable", [null]],
    ["indetermine", [rejet("UnknownError")]],
    ["absente", [rejet("SecurityError")]],
  ];
  for (const [verdict, script] of attendus) {
    const rendu = await sonderLeStockageEnDetail({
      storage: stockageScripte(script).storage,
      attendre,
    });
    assert.deepEqual(rendu, { verdict, code: null }, "seule une panne porte un code");
  }
  assert.deepEqual(await sonderLeStockageEnDetail({ storage: {} }), {
    verdict: "absente",
    code: null,
  });
});

// --- Une LECTURE réelle en échec, après une sonde réussie (revue complète de la PR #305) -------------------

test("classerLaLectureEnEchec : l'UnknownError — brut ou déjà traduit — est indéterminé", () => {
  assert.deepEqual(classerLaLectureEnEchec(rejet("UnknownError")), {
    verdict: "indetermine",
    code: null,
  });
  // `toStorageError` range un nom inconnu sous SUPPORT_FAILURE et garde le nom dans `context.cause`.
  const traduit = Object.assign(new Error("x"), {
    code: "VAULT_STORAGE_SUPPORT_FAILURE",
    context: { cause: "UnknownError" },
  });
  assert.deepEqual(classerLaLectureEnEchec(traduit), { verdict: "indetermine", code: null });
  const deja = Object.assign(new Error("x"), { code: "VAULT_STORAGE_INDETERMINE" });
  assert.deepEqual(classerLaLectureEnEchec(deja), { verdict: "indetermine", code: null });
});

test("classerLaLectureEnEchec : une panne du support rend son code PRÉCIS", () => {
  assert.deepEqual(classerLaLectureEnEchec(rejet("QuotaExceededError")), {
    verdict: "panne",
    code: "VAULT_STORAGE_QUOTA_EXCEEDED",
  });
  assert.deepEqual(classerLaLectureEnEchec(rejet("InvalidStateError")), {
    verdict: "panne",
    code: "VAULT_STORAGE_HANDLE_LOST",
  });
  const typee = Object.assign(new Error("x"), { code: "VAULT_STORAGE_QUOTA_EXCEEDED" });
  assert.deepEqual(classerLaLectureEnEchec(typee), {
    verdict: "panne",
    code: "VAULT_STORAGE_QUOTA_EXCEEDED",
  });
  const nonClassee = Object.assign(new Error("x"), { code: "VAULT_STORAGE_SUPPORT_FAILURE" });
  assert.deepEqual(classerLaLectureEnEchec(nonClassee), {
    verdict: "panne",
    code: "VAULT_STORAGE_SUPPORT_FAILURE",
  });
});

test("classerLaLectureEnEchec : une erreur du DOMAINE n'est jamais avalée en panne de stockage", () => {
  // Un refus d'enveloppe, un coffre refusé, un bug : la page doit le voir tel quel.
  for (const erreur of [
    Object.assign(new Error("x"), { code: "VAULT_ENVELOPPE_ILLISIBLE" }),
    Object.assign(new Error("x"), { code: "VAULT_COQUILLE_COFFRE_ANTERIEUR" }),
    Object.assign(new Error("x"), { code: "VAULT_STORAGE_BUSY" }),
    new TypeError("bug"),
    rejet("NotFoundError"),
    rejet("SecurityError"),
    undefined,
    "une chaîne",
  ]) {
    assert.equal(
      classerLaLectureEnEchec(erreur),
      null,
      String(erreur?.code ?? erreur?.name ?? erreur),
    );
  }
});
