// L'épreuve EXHAUSTIVE de la table de transitions de la révocation (#310, ADR 0049, D6).
//
// La table est lue MOT À MOT dans l'ADR : 24 lignes × 16 colonnes = 384 cellules. Une cellule absente,
// ou en trop, fait échouer l'épreuve ; chaque cellule est ensuite rejouée sur `transiter`, état et
// événement construits par l'API publique. Chaque message nomme la cellule : « [P × oui] ».

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { transiter } from "../../src/coquille/modele-de-la-revocation.mjs";
import { evenementDeLaLigne, etatDeLaPhase, LISTE_DES_PHASES } from "./support-revocation.mjs";

const ADR = new URL(
  "../../docs/decisions/0049-le-modele-d-etat-de-la-revocation.md",
  import.meta.url,
);

const LIGNES_ATTENDUES = Object.freeze([
  ["e0", "montage", null],
  ["e1", "coffre-ouvert", null],
  ["e2", "demander-la-revocation", null],
  ["e3", "oui", null],
  ["e4", "annuler", null],
  ["e5", "reponse-de-succes", null],
  ["e6", "refus-type", null],
  ["e7", "worker-mort", null],
  ["e8", "worker-rompu", null],
  ["e9", "reponse-malformee", null],
  ["e10", "erreur-sans-code", null],
  ["e11", "delai-depasse", null],
  ["e12", "relecture-reussie", "courante"],
  ["e12", "relecture-reussie", "non courante"],
  ["e13", "relecture-echouee", "courante"],
  ["e13", "relecture-echouee", "non courante"],
  ["e14", "verrouiller", null],
  ["e16", "changer-d-etape", null],
  ["e17", "terminer-sans-revoquer", null],
  ["e18", "revenir-a-l-application", null],
  ["e19", "modification-lancee", null],
  ["e20", "modification-terminee", null],
  ["e21", "indice-change", null],
  ["e22", "masquage-impossible", null],
]);

const METIER = new Set([
  "envoyer",
  "relire",
  "publier",
  "noter",
  "oublier",
  "terminer",
  "revenir",
  "lancer",
]);
const GRAMMAIRE = /^(✗|—|=|→[A-Z0-9]{2}|→[A-Z])(?: \[([a-z-]+(?:, [a-z-]+)*)\])?$/;

/** Lit la table de l'ADR : { lignes: [{ id, type, classe, cellules[16] }], entete }. */
function lireLaTable() {
  const texte = readFileSync(ADR, "utf8");
  const debut = texte.indexOf("<!-- table-de-transitions:debut -->");
  const fin = texte.indexOf("<!-- table-de-transitions:fin -->");
  assert.ok(debut >= 0 && fin > debut, "les marqueurs de la table sont absents de l'ADR 0049");
  const lignes = texte
    .slice(debut, fin)
    .split("\n")
    .filter((l) => l.startsWith("|"));
  const decouper = (l) =>
    l
      .split("|")
      .slice(1, -1)
      .map((c) => c.trim());
  const entete = decouper(lignes[0]).slice(1);
  const corps = lignes.slice(2).map((ligne) => {
    const [libelle, ...cellules] = decouper(ligne);
    const trouve = /^(e\d+) `([a-z0-9-]+)`(?: (courante|non courante))?$/.exec(libelle);
    assert.ok(trouve, `libellé de ligne illisible : « ${libelle} »`);
    return { id: trouve[1], type: trouve[2], classe: trouve[3] ?? null, cellules };
  });
  return { entete, corps };
}

function lireUneCellule(texte) {
  const trouve = GRAMMAIRE.exec(texte);
  assert.ok(trouve, `cellule illisible : « ${texte} »`);
  const signe = trouve[1];
  return { signe, effets: trouve[2] === undefined ? [] : trouve[2].split(", ") };
}

const table = lireLaTable();

test("la table de l'ADR 0049 est COMPLÈTE : 16 colonnes, 24 lignes attendues, 384 cellules lisibles", () => {
  assert.deepEqual(
    table.entete,
    LISTE_DES_PHASES,
    "les colonnes ne sont pas les seize phases, dans l'ordre",
  );
  assert.deepEqual(
    table.corps.map(({ id, type, classe }) => [id, type, classe]),
    LIGNES_ATTENDUES,
    "les lignes de la table ne sont pas les vingt-quatre attendues, dans l'ordre",
  );
  let cellules = 0;
  for (const ligne of table.corps) {
    assert.equal(
      ligne.cellules.length,
      16,
      `la ligne ${ligne.id} ${ligne.type} n'a pas seize cellules`,
    );
    for (const texte of ligne.cellules) {
      lireUneCellule(texte);
      cellules += 1;
    }
  }
  assert.equal(cellules, 384);
});

test("une cellule « — » n'existe que pour une lecture COURANTE sans lecture en vol (26 cellules)", () => {
  let tirets = 0;
  for (const ligne of table.corps) {
    ligne.cellules.forEach((texte, rang) => {
      if (texte !== "—") return;
      tirets += 1;
      assert.equal(
        ligne.classe,
        "courante",
        `[${LISTE_DES_PHASES[rang]} × ${ligne.type}] « — » hors d'une ligne courante`,
      );
      assert.ok(
        !["FL", "SL", "RL"].includes(LISTE_DES_PHASES[rang]),
        `[${LISTE_DES_PHASES[rang]} × ${ligne.type}] une lecture y est en vol`,
      );
    });
  }
  assert.equal(tirets, 26);
});

function rejouer(ligne, phase, texte, variante) {
  const etat = etatDeLaPhase(phase, variante.options);
  const nom = `[${phase} × ${ligne.type}${ligne.classe === null ? "" : ` ${ligne.classe}`}]`;
  const cellule = lireUneCellule(texte);
  // « — » : la classe « courante » n'existe pas ; on rejoue avec l'identifiant d'une lecture DÉJÀ acceptée.
  const classe = cellule.signe === "—" ? "non courante" : ligne.classe;
  const evenement = evenementDeLaLigne(ligne.type, etat, classe, variante.rang);
  const resultat = transiter(etat, evenement);
  if (cellule.signe === "✗" || cellule.signe === "—") {
    assert.equal(resultat.accepte, false, `${nom} devrait être INTERDIT`);
    assert.equal(resultat.etat, etat, `${nom} interdit : l'état doit rester la MÊME référence`);
    assert.deepEqual(resultat.effets, [], `${nom} interdit : aucun effet`);
    return;
  }
  assert.equal(resultat.accepte, true, `${nom} devrait être ACCEPTÉ (${texte})`);
  const attendue = cellule.signe === "=" ? phase : cellule.signe.slice(1);
  assert.equal(resultat.etat.phase, attendue, `${nom} : phase suivante (${texte})`);
  const metier = resultat.effets
    .map(({ nom: effet }) => effet)
    .filter((effet) => METIER.has(effet));
  assert.deepEqual(metier, cellule.effets, `${nom} : effets métier, dans l'ordre (${texte})`);
}

for (const ligne of LIGNES_ATTENDUES.map(([id, type, classe]) => ({ id, type, classe }))) {
  test(`cellule par cellule : ${ligne.id} ${ligne.type}${ligne.classe === null ? "" : ` (${ligne.classe})`}`, () => {
    const lue = table.corps.find((l) => l.id === ligne.id && l.classe === ligne.classe);
    assert.ok(lue, `la ligne ${ligne.id} ${ligne.type} manque dans l'ADR`);
    const variantes =
      ligne.classe === "non courante" || ligne.type === "masquage-impossible" ? [0, 1, 2] : [0];
    const ecarts = [];
    for (const rang of variantes) {
      LISTE_DES_PHASES.forEach((phase, colonne) => {
        for (const indice of [false, true]) {
          try {
            rejouer(lue, phase, lue.cellules[colonne], { rang, options: { indice } });
          } catch (erreur) {
            ecarts.push(erreur.message.split("\n")[0]);
          }
        }
      });
    }
    const uniques = [...new Set(ecarts)];
    assert.equal(
      uniques.length,
      0,
      `${uniques.length} cellule(s) en écart :\n${uniques.join("\n")}`,
    );
  });
}
