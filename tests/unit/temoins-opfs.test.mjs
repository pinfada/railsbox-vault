import assert from "node:assert/strict";
import test from "node:test";

import { fouilleImpossible, racineDeLOpfs } from "../../public/spike/origin/racine-opfs.mjs";
import {
  ecarts,
  fouilleOpfsAdmise,
  opfsNonMesures,
  temoinsOpfsToleres,
} from "../support/temoins-opfs.mjs";

// Les TÉMOINS OPFS de la frontière d'origine (#46, #231, revue de la PR #305). Un `UnknownError` de
// `getDirectory()` ne prouve pas que l'OPFS est absente : il ne doit JAMAIS retirer un témoin de la
// comparaison, ni rendre une fouille vide. Il donne `indetermine` — et l'épreuve ÉCHOUE —, sauf dans le
// seul contexte éphémère WebKit que l'épreuve connaît par SA PROPRE fixture (jamais par le nom de
// l'erreur), et alors seulement si A n'a rien pu déposer non plus : un témoin déjà déposé qui
// disparaît reste rouge.

function rejet(nom, message = "boum") {
  const erreur = new Error(message);
  erreur.name = nom;
  return erreur;
}

const ATTENDU = { "opfs-fichier-de-a": "lu", "indexeddb-de-a": "lu" };
const UNKNOWN = "navigator.storage.getDirectory rejeté (UnknownError)";

const opfsIndetermine = {
  nom: "opfs-fichier-de-a",
  mecanisme: "OPFS",
  resultat: "indetermine",
  detail: UNKNOWN,
};

test("racineDeLOpfs : la racine, l'API absente, l'UnknownError et la panne ne se confondent pas", async () => {
  const racine = {};
  assert.equal((await racineDeLOpfs({ getDirectory: async () => racine })).racine, racine);

  const absente = await racineDeLOpfs({});
  assert.equal(absente.absent.resultat, "indisponible");
  assert.match(absente.absent.detail, / absent$/);

  const inconnue = await racineDeLOpfs({
    getDirectory: async () => {
      throw rejet("UnknownError");
    },
  });
  assert.equal(
    inconnue.absent.resultat,
    "indetermine",
    "jamais « indisponible » pour UnknownError",
  );
  assert.equal(inconnue.absent.detail, UNKNOWN);

  for (const nom of ["QuotaExceededError", "InvalidStateError", "Error"]) {
    const panne = await racineDeLOpfs({
      getDirectory: async () => {
        throw rejet(nom, "message");
      },
    });
    assert.equal(panne.absent.resultat, "panne", nom);
    assert.match(panne.absent.detail, new RegExp(`^${nom}: `));
  }
});

test("ecarts : une API absente n'est pas un écart, tout le reste de l'indisponible l'est", () => {
  const absent = {
    nom: "opfs-fichier-de-a",
    mecanisme: "OPFS",
    resultat: "indisponible",
    detail: "navigator.storage.getDirectory absent",
  };
  assert.deepEqual(ecarts([absent], ATTENDU), []);
  const autre = { ...absent, detail: "quelque chose d'inexpliqué" };
  assert.equal(ecarts([autre], ATTENDU).length, 1);
});

test("ecarts : un UnknownError est un ÉCART par défaut — il ne sort jamais de la comparaison", () => {
  assert.equal(ecarts([opfsIndetermine], ATTENDU).length, 1);
  assert.equal(
    ecarts([opfsIndetermine], ATTENDU, {
      contexteEphemereMesure: false,
      depots: { opfs: "indetermine: x" },
    }).length,
    1,
    "hors du contexte éphémère mesuré, même si A n'a rien déposé",
  );
});

test("ecarts : tolérance LIMITÉE au contexte éphémère mesuré ET à l'absence de tout dépôt de A", () => {
  const options = { contexteEphemereMesure: true, depots: { opfs: `indetermine: ${UNKNOWN}` } };
  assert.deepEqual(ecarts([opfsIndetermine], ATTENDU, options), []);

  // Un témoin DÉJÀ DÉPOSÉ qui disparaît reste rouge.
  assert.equal(
    ecarts([opfsIndetermine], ATTENDU, { contexteEphemereMesure: true, depots: { opfs: "depose" } })
      .length,
    1,
  );
  // La tolérance ne vaut que pour un témoin OPFS, et pour le détail MESURÉ.
  const idb = {
    nom: "indexeddb-de-a",
    mecanisme: "IndexedDB",
    resultat: "indetermine",
    detail: UNKNOWN,
  };
  assert.equal(ecarts([idb], ATTENDU, options).length, 1);
  const autreDetail = { ...opfsIndetermine, detail: "autre chose" };
  assert.equal(ecarts([autreDetail], ATTENDU, options).length, 1);
});

test("ecarts : une panne n'est tolérée nulle part", () => {
  const panne = { ...opfsIndetermine, resultat: "panne", detail: "QuotaExceededError: x" };
  assert.equal(ecarts([panne], ATTENDU).length, 1);
  assert.equal(
    ecarts([panne], ATTENDU, { contexteEphemereMesure: true, depots: { opfs: "indetermine: x" } })
      .length,
    1,
  );
});

test("fouilleOpfsAdmise : une fouille IMPOSSIBLE n'est pas une fouille vide", () => {
  const impossible = [{ ou: "opfs", texte: "", impossible: "UnknownError" }];
  // Le moteur ouvre un volume : l'OPFS fonctionne, une fouille impossible est une PANNE.
  const ouvre = fouilleOpfsAdmise({ porte: true, morceaux: impossible });
  assert.equal(ouvre.problemes.length, 1);
  assert.match(ouvre.problemes[0], /impossible/);
  // Le moteur n'ouvre pas de volume (la même épreuve l'a constaté par une ouverture réelle) : la
  // limite est ÉCRITE, et la fouille reste « non réalisée » — jamais « vide ».
  const nonPorte = fouilleOpfsAdmise({ porte: false, morceaux: impossible });
  assert.deepEqual(nonPorte.problemes, []);
  assert.equal(nonPorte.limites.length, 1);
  assert.match(nonPorte.limites[0], /non (réalisée|fouillée)/);
  // Une fouille réalisée ne dit rien de plus.
  const faite = fouilleOpfsAdmise({ porte: true, morceaux: [{ ou: "opfs", texte: "abc" }] });
  assert.deepEqual(faite, { problemes: [], limites: [] });
});

test("opfsNonMesures : une isolation « prouvée » par un témoin OPFS qui n'a pas été mesuré n'en est pas une", () => {
  const lu = { nom: "a", mecanisme: "OPFS", resultat: "lu", detail: "" };
  const invisible = { nom: "b", mecanisme: "OPFS", resultat: "invisible", detail: "NotFoundError" };
  const panne = { nom: "c", mecanisme: "OPFS", resultat: "panne", detail: "QuotaExceededError: x" };
  const autre = { nom: "d", mecanisme: "cookies", resultat: "panne", detail: "x" };
  assert.deepEqual(opfsNonMesures([lu, invisible, autre], {}), []);
  assert.deepEqual(
    opfsNonMesures([lu, invisible, panne, opfsIndetermine], {}).map((s) => s.nom),
    ["c", "opfs-fichier-de-a"],
  );
  // Seul le contexte éphémère WebKit, sans dépôt de A, tolère l'indéterminé — jamais la panne.
  const tolere = { contexteEphemereMesure: true, depots: { opfs: `indetermine: ${UNKNOWN}` } };
  assert.deepEqual(
    opfsNonMesures([panne, opfsIndetermine], tolere).map((s) => s.nom),
    ["c"],
  );
  assert.deepEqual(
    temoinsOpfsToleres([panne, opfsIndetermine], tolere).map((s) => s.nom),
    ["opfs-fichier-de-a"],
  );
  assert.deepEqual(
    temoinsOpfsToleres([opfsIndetermine], {
      contexteEphemereMesure: true,
      depots: { opfs: "depose" },
    }),
    [],
  );
  assert.deepEqual(temoinsOpfsToleres([opfsIndetermine], { depots: tolere.depots }), []);
});

test("fouilleImpossible : l'API absente et l'indéterminé se DISENT, une panne LÈVE — jamais un texte vide muet", () => {
  assert.deepEqual(fouilleImpossible({ resultat: "indisponible", detail: "x absent" }), {
    texte: "",
    impossible: "indisponible",
  });
  assert.deepEqual(fouilleImpossible({ resultat: "indetermine", detail: UNKNOWN }), {
    texte: "",
    impossible: "indetermine",
  });
  assert.throws(
    () => fouilleImpossible({ resultat: "panne", detail: "QuotaExceededError: x" }),
    /QuotaExceededError/,
  );
});
