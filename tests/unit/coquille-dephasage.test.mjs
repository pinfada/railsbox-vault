/**
 * Le DÉPHASAGE DE VERSIONS : le schéma décide AVANT le boot (#236 T2, ADR 0042).
 *
 * Une décision pure : le manifeste du coffre, le descripteur servi, une issue. Chaque ligne de la
 * table de `src/coquille/dephasage.mjs` a son épreuve, et les gardes du descripteur neuves (rétention
 * 1, morceaux compressés, schéma servi) les leurs.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  ISSUES_DU_DEPHASAGE as I,
  PAQUETS_SERVIS,
  comparerSchemas,
  comparerVersions,
  deciderLeDephasage,
  estUneVersion,
  paquetADemarrer,
} from "../../src/coquille/dephasage.mjs";
import { formeDuDescripteur } from "../../src/coquille/descripteur-applicatif.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";

const M = "20260101000002";
const N = "20260919000001";
const E = (lettre) => lettre.repeat(64);

/** Un descripteur v2 admis : 1.1.0 (schéma N) courant, 1.0.0 (schéma M) précédent. */
function descripteur(surcharge = {}) {
  return {
    descripteurVersion: 2,
    application: { id: "ref", version: "1.1.0", schema: N },
    runtime: { version: "0.1.0" },
    rootfs: { nom: "rootfs.ext4", octets: 4096, sha256: E("a") },
    paquet: { nom: "ref-1.1.0.ext4", octets: 4096, sha256: E("b") },
    graine: { nom: "graine.ext4", octets: 8192, sha256: E("c"), disqueOctets: 8192 },
    precedent: {
      application: { version: "1.0.0", schema: M },
      paquet: { nom: "ref-1.0.0.ext4", octets: 4096, sha256: E("d") },
    },
    boot: {
      cmdline: "root=/dev/sda1 init=/opt/vault/guest-init.sh",
      memoireOctets: 1 << 29,
      kernel: "k",
      initrd: "i",
      bios: "b",
      vgaBios: "v",
    },
    prefixeDesArtefacts: "/artifacts/reference-image/",
    ...surcharge,
  };
}

const manifeste = (app) => ({ app });

test("les schémas se comparent en ENTIERS, comme ActiveRecord", () => {
  assert.ok(comparerSchemas("9", M) < 0);
  assert.ok(comparerSchemas(N, M) > 0);
  assert.equal(comparerSchemas(M, M), 0);
  assert.equal(comparerSchemas("007", "7"), 0);
  assert.ok(comparerSchemas("10", "9") > 0);
});

test("aucun volume : la voie d'installation de T1, inchangée", () => {
  const decision = deciderLeDephasage({ manifeste: null, descripteur: descripteur() });
  assert.equal(decision.issue, I.installer);
  assert.deepEqual(paquetADemarrer(decision), {
    paquet: PAQUETS_SERVIS.courant,
    application: null,
    miseAJour: false,
  });
});

test("même version, même schéma : ouvrir le paquet courant, sans geste", () => {
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.1.0", schema: N }),
    descripteur: descripteur(),
  });
  assert.equal(decision.issue, I.ouvrir);
  assert.equal(paquetADemarrer(decision, { miseAJour: true }).miseAJour, false);
});

test("un coffre d'une AUTRE application est refusé, avant tout schéma", () => {
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "autre", version: "1.1.0", schema: N }),
    descripteur: descripteur(),
  });
  assert.equal(decision.code, C.applicationEtrangere);
  assert.deepEqual(paquetADemarrer(decision, { miseAJour: true }), {
    refus: C.applicationEtrangere,
  });
});

test("une origine sans application ne sert pas ce coffre : refus, données intactes", () => {
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.0.0", schema: M }),
    descripteur: null,
  });
  assert.equal(decision.issue, I.refus);
  assert.equal(decision.code, C.applicationNonServie);
  assert.equal(decision.coffre.id, "ref");
});

test("schéma servi ANTÉRIEUR : refus, même si le geste de mise à jour est reçu", () => {
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.2.0", schema: "20261001000001" }),
    descripteur: descripteur(),
  });
  assert.equal(decision.code, C.applicationAnterieure);
  assert.deepEqual(paquetADemarrer(decision, { miseAJour: true }), {
    refus: C.applicationAnterieure,
  });
});

test("retour arrière : un coffre MIS À JOUR refuse l'origine qui sert l'ancien paquet", () => {
  const ancienne = descripteur({
    application: { id: "ref", version: "1.0.0", schema: M },
    paquet: { nom: "ref-1.0.0.ext4", octets: 4096, sha256: E("d") },
    precedent: undefined,
  });
  delete ancienne.precedent;
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.1.0", schema: N }),
    descripteur: ancienne,
  });
  assert.equal(decision.code, C.applicationAnterieure);
});

test("schéma SUPÉRIEUR : la mise à jour est PROPOSÉE, jamais faite d'office", () => {
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.0.0", schema: M }),
    descripteur: descripteur(),
  });
  assert.equal(decision.issue, I.miseAJour);
  assert.equal(decision.migration, true);
  assert.equal(decision.plusTard, true);
  // Sans geste : le PRÉCÉDENT, sur la version du coffre.
  assert.deepEqual(paquetADemarrer(decision), {
    paquet: PAQUETS_SERVIS.precedent,
    application: { version: "1.0.0", schema: M },
    miseAJour: false,
  });
  // Le geste seul fait booter le courant, et migrer.
  assert.deepEqual(paquetADemarrer(decision, { miseAJour: true }), {
    paquet: PAQUETS_SERVIS.courant,
    application: { id: "ref", version: "1.1.0", schema: N },
    miseAJour: true,
  });
});

test("sans le précédent servi, « Plus tard » est impossible : démarrer sans geste est refusé", () => {
  const sansPrecedent = descripteur();
  delete sansPrecedent.precedent;
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.0.0", schema: M }),
    descripteur: sansPrecedent,
  });
  assert.equal(decision.issue, I.miseAJour);
  assert.equal(decision.plusTard, false);
  assert.deepEqual(paquetADemarrer(decision), { refus: C.applicationNonServie });
  assert.equal(paquetADemarrer(decision, { miseAJour: true }).paquet, PAQUETS_SERVIS.courant);
});

test("un précédent d'une AUTRE version que le coffre n'ouvre pas le coffre", () => {
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "0.9.0", schema: "20250101000001" }),
    descripteur: descripteur(),
  });
  assert.equal(decision.issue, I.miseAJour);
  assert.equal(decision.plusTard, false);
});

test("schéma ÉGAL, version différente : mise à jour SANS migration, même geste", () => {
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.1.0-rc", schema: N }),
    descripteur: descripteur(),
  });
  assert.equal(decision.issue, I.miseAJour);
  assert.equal(decision.migration, false);
});

test("coffre de T1 SANS schéma : celui du paquet de même version, courant ou précédent", () => {
  const precedent = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.0.0" }),
    descripteur: descripteur(),
  });
  assert.equal(precedent.issue, I.miseAJour);
  assert.equal(precedent.coffre.schema, M);
  assert.equal(precedent.coffre.schemaDeduit, true);
  const courant = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.1.0" }),
    descripteur: descripteur(),
  });
  assert.equal(courant.issue, I.ouvrir);
  assert.equal(courant.coffre.schemaDeduit, true);
});

test("coffre de T1 SANS schéma et sans paquet de sa version : refus explicite", () => {
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "0.5.0" }),
    descripteur: descripteur(),
  });
  assert.equal(decision.code, C.schemaDuCoffreInconnu);
});

test("un schéma DÉCLARÉ prime sur la version : il n'est jamais remplacé par une déduction", () => {
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.0.5", schema: M }),
    descripteur: descripteur(),
  });
  assert.equal(decision.issue, I.miseAJour);
  assert.equal(decision.coffre.schemaDeduit, false);
  assert.equal(decision.migration, true);
});

test("LA TABLE version × schéma, en entier : neuf cases, neuf issues (précédence SemVer)", () => {
  // Le coffre est en 1.1.0, schéma N. On fait varier ce que l'origine sert.
  const [BAS, HAUT] = ["20260101000001", "20261001000001"];
  const cases = [
    ["1.0.9", BAS, C.applicationAnterieure],
    ["1.0.9", N, C.applicationAnterieure], // le retour arrière, même à schéma égal (TUF)
    ["1.0.9", HAUT, C.applicationAnterieure],
    ["1.1.0", BAS, C.schemaDivergent],
    ["1.1.0", N, I.ouvrir], // rien à proposer
    ["1.1.0", HAUT, C.schemaDivergent],
    ["1.2.0", BAS, C.applicationAnterieure],
    ["1.2.0", N, "sans-migration"],
    ["1.2.0", HAUT, "avec-migration"],
  ];
  for (const [version, schema, attendu] of cases) {
    const servi = descripteur({ application: { id: "ref", version, schema } });
    delete servi.precedent;
    const decision = deciderLeDephasage({
      manifeste: manifeste({ id: "ref", version: "1.1.0", schema: N }),
      descripteur: servi,
    });
    const obtenu =
      decision.issue === I.refus
        ? decision.code
        : decision.issue === I.miseAJour
          ? decision.migration
            ? "avec-migration"
            : "sans-migration"
          : decision.issue;
    assert.equal(obtenu, attendu, `servi ${version} / ${schema}`);
  }
});

test("la précédence SemVer 2.0.0 : pré-version avant publication, identifiants un à un", () => {
  const ordre = [
    "1.0.0-alpha",
    "1.0.0-alpha.1",
    "1.0.0-alpha.beta",
    "1.0.0-beta",
    "1.0.0-beta.2",
    "1.0.0-beta.11",
    "1.0.0-rc.1",
    "1.0.0",
    "1.0.1",
    "1.10.0",
  ];
  for (let rang = 1; rang < ordre.length; rang += 1) {
    assert.ok(
      comparerVersions(ordre[rang - 1], ordre[rang]) < 0,
      `${ordre[rang - 1]} < ${ordre[rang]}`,
    );
    assert.ok(comparerVersions(ordre[rang], ordre[rang - 1]) > 0);
  }
  assert.equal(comparerVersions("1.0.0+build.1", "1.0.0+build.2"), 0);
  assert.equal(estUneVersion("1.0"), false);
  assert.equal(estUneVersion("01.0.0"), false);
});

test("une version de coffre qui n'est pas un SemVer n'est pas devinée : refus", () => {
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "v1", schema: M }),
    descripteur: descripteur(),
  });
  assert.equal(decision.code, C.schemaDuCoffreInconnu);
});

test("MIGRATION INTERROMPUE : seule la reprise est proposée, ni « Plus tard » ni le précédent", () => {
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.0.0", schema: M, migration: N }),
    descripteur: descripteur(),
  });
  assert.equal(decision.issue, I.miseAJour);
  assert.equal(decision.reprise, true);
  assert.equal(decision.plusTard, false);
  assert.deepEqual(paquetADemarrer(decision), { refus: C.applicationNonServie });
  assert.equal(paquetADemarrer(decision, { miseAJour: true }).paquet, PAQUETS_SERVIS.courant);
});

test("MIGRATION INTERROMPUE : une origine qui sert un schéma sous la cible est refusée", () => {
  const ancienne = descripteur({
    application: { id: "ref", version: "1.0.0", schema: M },
    paquet: { nom: "ref-1.0.0.ext4", octets: 4096, sha256: E("d") },
  });
  delete ancienne.precedent;
  const decision = deciderLeDephasage({
    manifeste: manifeste({ id: "ref", version: "1.0.0", schema: M, migration: N }),
    descripteur: ancienne,
  });
  assert.equal(decision.code, C.applicationAnterieure);
});

test("DESCRIPTEUR : le schéma servi est exigé, en chiffres", () => {
  for (const schema of [undefined, "", "v2", "2026-09-19"]) {
    const forme = formeDuDescripteur(
      descripteur({ application: { id: "ref", version: "1.1.0", schema } }),
    );
    assert.equal(forme.valide, false, JSON.stringify(schema));
    assert.match(forme.motif, /schéma/);
  }
  assert.equal(formeDuDescripteur(descripteur()).valide, true);
});

test("DESCRIPTEUR : le précédent est contrôlé comme un paquet, et ne peut être plus récent", () => {
  const cas = [
    [{ application: { version: "1.1.0", schema: M } }, /égale ou plus récente/],
    [{ application: { version: "1.2.0", schema: M } }, /égale ou plus récente/],
    [{ application: { version: "1.0.0", schema: "20270101000001" } }, /plus récent/],
    [{ paquet: { nom: "../x", octets: 4096, sha256: E("d") } }, /nom d'artefact/],
    [{ paquet: { nom: "p", octets: 4096, sha256: "abc" } }, /empreinte/],
    [{ paquet: { nom: "p", octets: 0, sha256: E("d") } }, /taille/],
    [{ application: { version: "1.0.0" } }, /schéma/],
  ];
  for (const [surcharge, motif] of cas) {
    const base = descripteur();
    const forme = formeDuDescripteur({
      ...base,
      precedent: { ...base.precedent, ...surcharge },
    });
    assert.equal(forme.valide, false, JSON.stringify(surcharge));
    assert.match(forme.motif, motif);
  }
  const sansPrecedent = descripteur();
  delete sansPrecedent.precedent;
  assert.equal(formeDuDescripteur(sansPrecedent).valide, true, "la rétention est facultative");
});

test("DESCRIPTEUR : un morceau COMPRESSÉ déclare gzip et sa taille transférée, sinon refus", () => {
  for (const cle of ["rootfs", "paquet", "graine"]) {
    const base = descripteur();
    const avec = (ajout) => formeDuDescripteur({ ...base, [cle]: { ...base[cle], ...ajout } });
    assert.equal(avec({ compression: "gzip", transfertOctets: 1024 }).valide, true, cle);
    assert.match(avec({ compression: "gzip" }).motif, /transférée/);
    assert.match(avec({ compression: "zstd", transfertOctets: 1 }).motif, /compression inconnue/);
  }
});
