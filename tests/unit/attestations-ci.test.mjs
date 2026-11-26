// CLIQUET des attestations de lot (#328, refus de la relecture 2 de #329).
//
// Un résultat de matrice AGRÉGÉ ne prouve pas qu'un lot a été joué : GitHub ne garantit pas de décompte
// par entrée. Chaque lot de mutation et chaque tranche navigateur dépose donc une attestation
// distincte, et le job final EXIGE exactement les lots attendus, chacun une fois, avec un compte non vide.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  TRANCHES_NAVIGATEUR,
  attestationMutations,
  attestationNavigateur,
  verifierMutations,
  verifierNavigateur,
} from "../../tools/attestations-ci.mjs";
import { LOTS } from "../../tools/rejouer-les-campagnes.mjs";

const ligne = (entree) => {
  const [nom, tranche] = entree.split("@");
  return { nom, ...(tranche ? { tranche } : {}), ok: true, mutants: 5, tues: 5, survivants: 0 };
};
const rapportLot = (i) => ({ ok: true, campagnes: LOTS[i - 1].map(ligne) });
const tous = () => LOTS.map((_, k) => attestationMutations(k + 1, rapportLot(k + 1)));

test("les attestations complètes des lots sont acceptées", () => {
  assert.deepEqual(verifierMutations(tous()), []);
});

test("un lot manquant, en double ou inattendu fait échouer la vérification", () => {
  const a = tous();
  assert.match(verifierMutations(a.slice(1)).join("\n"), /lot 1.*absent/u);
  assert.match(verifierMutations([...a, a[0]]).join("\n"), /lot 1.*2 fois/u);
  assert.match(
    verifierMutations([...a, { ...a[0], lot: LOTS.length + 1 }]).join("\n"),
    /inattendu/u,
  );
  assert.match(verifierMutations([]).join("\n"), /lot 1.*absent/u);
});

test("un compte vide, un survivant, un lot en échec ou des entrées différentes sont refusés", () => {
  const vide = tous();
  vide[1] = attestationMutations(2, { ok: true, campagnes: [] });
  assert.match(verifierMutations(vide).join("\n"), /lot 2/u);

  const zero = tous();
  zero[0] = attestationMutations(1, {
    ok: true,
    campagnes: LOTS[0].map((e) => ({ ...ligne(e), mutants: 0, tues: 0 })),
  });
  assert.match(verifierMutations(zero).join("\n"), /lot 1.*vide|lot 1.*0 mutant/u);

  const survivant = tous();
  survivant[2] = attestationMutations(3, {
    ok: false,
    campagnes: LOTS[2].map((e) => ({ ...ligne(e), tues: 4, survivants: 1, ok: false })),
  });
  assert.match(verifierMutations(survivant).join("\n"), /lot 3.*survivant/u);

  const autres = tous();
  autres[3] = attestationMutations(4, { ok: true, campagnes: rapportLot(1).campagnes });
  assert.match(verifierMutations(autres).join("\n"), /lot 4.*entrées/u);

  const faux = tous();
  faux[0] = { ...faux[0], tues: faux[0].mutants - 1, survivants: 0 };
  assert.match(verifierMutations(faux).join("\n"), /lot 1/u);
});

const stats = (o = {}) => ({ stats: { expected: 300, unexpected: 0, flaky: 0, skipped: 3, ...o } });
const navigateur = () =>
  Array.from({ length: TRANCHES_NAVIGATEUR }, (_, k) => attestationNavigateur(k + 1, stats()));

test("les attestations des tranches navigateur sont exigées une par une", () => {
  assert.equal(TRANCHES_NAVIGATEUR, 2);
  assert.deepEqual(verifierNavigateur(navigateur()), []);
  assert.match(verifierNavigateur(navigateur().slice(1)).join("\n"), /tranche 1.*absente/u);
  assert.match(
    verifierNavigateur([...navigateur(), navigateur()[0]]).join("\n"),
    /tranche 1.*2 fois/u,
  );
  assert.match(verifierNavigateur([]).join("\n"), /tranche 2.*absente/u);
  const vide = navigateur();
  vide[1] = attestationNavigateur(2, stats({ expected: 0 }));
  assert.match(verifierNavigateur(vide).join("\n"), /tranche 2.*vide/u);
  const rouge = navigateur();
  rouge[0] = attestationNavigateur(1, stats({ unexpected: 1 }));
  assert.match(verifierNavigateur(rouge).join("\n"), /tranche 1.*échec/u);
  assert.throws(() => attestationNavigateur(1, {}), /rapport/u);
});

test("le CLI refuse un dossier d'attestations vide ou incomplet avec un code non nul", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dossier = mkdtempSync(join(tmpdir(), "attest-"));
  const lancer = () =>
    spawnSync(process.execPath, ["tools/attestations-ci.mjs", "verifier", "mutations", dossier], {
      encoding: "utf8",
      cwd: new URL("../..", import.meta.url),
    });
  assert.equal(lancer().status, 1, "dossier vide");
  for (const a of tous().slice(1)) {
    mkdirSync(join(dossier, `lot-${a.lot}`));
    writeFileSync(join(dossier, `lot-${a.lot}`, `mutations-lot-${a.lot}.json`), JSON.stringify(a));
  }
  const incomplet = lancer();
  assert.equal(incomplet.status, 1);
  assert.match(incomplet.stderr, /lot 1.*absent/u);
  const a = tous()[0];
  mkdirSync(join(dossier, "lot-1"));
  writeFileSync(join(dossier, "lot-1", "mutations-lot-1.json"), JSON.stringify(a));
  assert.equal(lancer().status, 0);
});
