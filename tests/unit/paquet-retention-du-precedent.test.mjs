// La RÉTENTION du précédent, côté outils (recette QA de la PR #249, Q4 et Q5) : `image:manifest` ne
// retient qu'une version STRICTEMENT antérieure de la MÊME application, et le dit quand il écarte ;
// `app:paquet` dit ce qu'il retire, refuse ce qui casserait, et retire un précédent sur demande.

import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { precedentRetenu } from "../../tools/build-reference-image/manifest.mjs";
import {
  CONTRATS,
  confronterALaRetention,
  courantDevientPrecedent,
  imagesDuContrat,
  retirerLePrecedent,
} from "../../tools/paquet/retention-du-precedent.mjs";
import { deciderLeDephasage } from "../../src/coquille/dephasage.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";

const contrat = (id, version, empreinte = "a") => ({
  application: { id, version, schema: "20260101000002" },
  image: {
    name: `${id}-${version}-${empreinte}.ext4`,
    servi: { name: `${id}-${version}-${empreinte}.ext4.gz` },
  },
  graine: {
    name: `${id}-${version}-graine-${empreinte}.ext4`,
    servi: { name: `${id}-${version}-graine-${empreinte}.ext4.gz` },
  },
});

function dossierAvec(contrats) {
  const dossier = mkdtempSync(join(tmpdir(), "retention-"));
  for (const [nom, valeur] of Object.entries(contrats)) {
    writeFileSync(join(dossier, nom), JSON.stringify(valeur));
    for (const image of imagesDuContrat(valeur)) writeFileSync(join(dossier, image), "x");
  }
  return dossier;
}

test("Q4 : le précédent d'une AUTRE application est écarté, et une ligne le dit", () => {
  const { precedent, ecarte } = precedentRetenu(
    contrat("qa-exemple", "1.0.0"),
    contrat("railsbox-vault-reference", "1.0.0"),
  );
  assert.equal(precedent, null);
  assert.match(ecarte, /AUTRE application/);
  assert.match(ecarte, /--retirer-precedent/);
});

test("Q4 : un précédent de même version, ou plus récent, est écarté ; un antérieur est retenu", () => {
  for (const version of ["1.1.0", "1.2.0", "pas-une-version"]) {
    const { precedent, ecarte } = precedentRetenu(contrat("ref", "1.1.0"), contrat("ref", version));
    assert.equal(precedent, null, version);
    assert.match(ecarte, /n'est pas antérieur/, version);
  }
  const ancien = contrat("ref", "1.0.0");
  assert.deepEqual(precedentRetenu(contrat("ref", "1.1.0"), ancien), {
    precedent: ancien,
    ecarte: null,
  });
  assert.deepEqual(precedentRetenu(contrat("ref", "1.1.0"), null), {
    precedent: null,
    ecarte: null,
  });
});

test("Q4 : un coffre d'une autre application, sur le descripteur que l'outil sert, rend ÉTRANGÈRE", () => {
  // L'outil a écarté le précédent : le descripteur sert qa-exemple seule.
  const descripteur = {
    application: { id: "qa-exemple", version: "1.0.0", schema: "20260101000002" },
  };
  const decision = deciderLeDephasage({
    manifeste: {
      app: { id: "railsbox-vault-reference", version: "1.1.0", schema: "20260919000001" },
    },
    descripteur,
  });
  assert.equal(decision.code, C.applicationEtrangere);
});

test("Q5 : fabriquer comme COURANT la version du précédent le retire, en le disant", () => {
  const dossier = dossierAvec({
    [CONTRATS.courant]: contrat("ref", "1.1.0", "b"),
    [CONTRATS.precedent]: contrat("ref", "1.0.0", "a"),
  });
  try {
    const retention = confronterALaRetention({
      dossier,
      role: CONTRATS.courant,
      id: "ref",
      version: "1.0.0",
    });
    assert.equal(retention.retirerLePrecedent, true);
    assert.match(retention.lignes.join("\n"), /n'est plus un précédent|plus un précédent/);
    // Une fabrication reproductible donne les MÊMES noms : ils sont gardés.
    const neuf = contrat("ref", "1.0.0", "a");
    retirerLePrecedent(dossier, { garder: imagesDuContrat(neuf) });
    const restes = readdirSync(dossier);
    assert.equal(restes.includes(CONTRATS.precedent), false);
    for (const image of imagesDuContrat(neuf)) assert.ok(restes.includes(image), image);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test("Q5 : fabriquer comme PRÉCÉDENT la version du courant est refusé avant toute construction", () => {
  const dossier = dossierAvec({ [CONTRATS.courant]: contrat("ref", "1.0.0") });
  try {
    assert.throws(
      () =>
        confronterALaRetention({ dossier, role: CONTRATS.precedent, id: "ref", version: "1.0.0" }),
      /déjà le paquet COURANT/,
    );
    assert.deepEqual(
      confronterALaRetention({ dossier, role: CONTRATS.precedent, id: "ref", version: "0.9.0" }),
      { retirerLePrecedent: false, lignes: [] },
    );
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test("Q5 : --retirer-precedent retire le contrat et ses images, et le dit ; sans précédent, le dit aussi", () => {
  const courant = contrat("ref", "1.1.0", "b");
  const dossier = dossierAvec({
    [CONTRATS.courant]: courant,
    [CONTRATS.precedent]: contrat("ref", "1.0.0", "a"),
  });
  try {
    const lignes = retirerLePrecedent(dossier);
    assert.match(lignes[0], /précédent retiré : ref 1\.0\.0 \(4 image\(s\)/);
    assert.match(lignes[1], /image:manifest/);
    assert.deepEqual(
      readdirSync(dossier).sort(),
      [CONTRATS.courant, ...imagesDuContrat(courant)].sort(),
    );
    assert.match(retirerLePrecedent(dossier)[0], /aucun paquet précédent/);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});

test("Q5 : --courant-devient-precedent garde les images qui ont installé les coffres, sans rien construire", () => {
  const courant = contrat("ref", "1.0.0", "a");
  const dossier = dossierAvec({
    [CONTRATS.courant]: courant,
    [CONTRATS.precedent]: contrat("ref", "0.9.0", "z"),
  });
  try {
    const lignes = courantDevientPrecedent(dossier);
    assert.match(lignes.join(" "), /ref 1.0.0 devient le paquet précédent/);
    assert.match(lignes.join(" "), /précédent retiré : ref 0.9.0/);
    assert.deepEqual(
      readdirSync(dossier).sort(),
      [CONTRATS.precedent, ...imagesDuContrat(courant)].sort(),
    );
    // La nouvelle version peut maintenant être fabriquée : rien ne la refuse.
    assert.deepEqual(
      confronterALaRetention({ dossier, role: CONTRATS.courant, id: "ref", version: "1.1.0" }),
      { retirerLePrecedent: false, lignes: [] },
    );
    assert.throws(() => courantDevientPrecedent(dossier), /aucun paquet courant/);
  } finally {
    rmSync(dossier, { recursive: true, force: true });
  }
});
