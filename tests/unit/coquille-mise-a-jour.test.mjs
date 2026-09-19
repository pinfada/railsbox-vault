/**
 * La MISE À JOUR côté Worker de confiance (#236 T2, ADR 0042) : ce qui est lu avant le boot, le paquet
 * choisi, l'intention inscrite sous le seul geste, et le manifeste qui SUIT le constat du guest —
 * jamais avant, jamais au-delà de ce que le guest a dit.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FACTEUR_DU_DELAI_DE_MIGRATION,
  codeDuRefusDuGuest,
  descripteurDuPaquet,
  inscrireLIntention,
  lireLeManifesteDuCoffre,
  ligneDeCommande,
  miseAJourPubliee,
  preparerLeDemarrage,
  reponseDeDemarrageRefuse,
  suivreLeConstat,
} from "../../src/coquille/mise-a-jour-applicative.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { createManifest, parseManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";

const M = "20260101000002";
const N = "20260919000002";
const E = (lettre) => lettre.repeat(64);

function descripteur() {
  return {
    descripteurVersion: 2,
    application: { id: "ref", version: "1.1.0", schema: N },
    runtime: { version: "0.1.0" },
    rootfs: { nom: "r", octets: 4096, sha256: E("a") },
    paquet: { nom: "p110", octets: 4096, sha256: E("b") },
    graine: { nom: "g", octets: 8192, sha256: E("c"), disqueOctets: 8192 },
    precedent: {
      application: { version: "1.0.0", schema: M },
      paquet: { nom: "p100", octets: 4096, sha256: E("d") },
    },
    boot: { cmdline: "root=/dev/sda1 init=/opt/vault/guest-init.sh", memoireOctets: 1 << 29 },
    prefixeDesArtefacts: "/artifacts/reference-image/",
  };
}

function manifeste(app) {
  return createManifest({
    runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
    app,
    volumeSize: SECTOR_SIZE * 8,
    volume: { id: "0123456789abcdef0123456789abcdef", algorithm: "aes-256-gcm" },
  });
}

const lu = (d = descripteur()) => ({ present: true, descripteur: d });

test("le manifeste illisible ou absent n'est pas deviné : la voie d'installation en décide", async () => {
  assert.equal(await lireLeManifesteDuCoffre("application", { lire: async () => null }), null);
  assert.equal(
    await lireLeManifesteDuCoffre("application", { lire: async () => new Uint8Array([1, 2]) }),
    null,
  );
  assert.equal(
    await lireLeManifesteDuCoffre("application", {
      lire: async () => {
        throw new Error("support");
      },
    }),
    null,
  );
  const octets = serializeManifest(manifeste({ id: "ref", version: "1.0.0", schema: M }));
  const relu = await lireLeManifesteDuCoffre("application", { lire: async () => octets });
  assert.equal(relu.app.schema, M);
});

test("« Plus tard » : le PRÉCÉDENT est booté, avec le schéma attendu sur la ligne de commande", async () => {
  const prepare = await preparerLeDemarrage({
    lu: lu(),
    nom: "application",
    delaiMs: 1000,
    lireManifeste: async () => manifeste({ id: "ref", version: "1.0.0", schema: M }),
  });
  assert.equal(prepare.descripteur.paquet.nom, "p100");
  assert.deepEqual(prepare.descripteur.application, { id: "ref", version: "1.0.0", schema: M });
  assert.equal(prepare.descripteur.precedent, undefined, "le précédent ne se sert pas lui-même");
  assert.equal(prepare.miseAJour, false);
  assert.equal(prepare.migration, false);
  assert.equal(prepare.delaiMs, 1000);
  assert.match(prepare.cmdline, new RegExp(` vault\\.schema=${M}$`));
  assert.doesNotMatch(
    prepare.cmdline,
    /vault\.migrer/,
    "« Plus tard » n'autorise aucune migration",
  );
});

test("le GESTE : le courant est booté, la migration annoncée, le délai doublé", async () => {
  const prepare = await preparerLeDemarrage({
    lu: lu(),
    nom: "application",
    miseAJour: true,
    delaiMs: 1000,
    lireManifeste: async () => manifeste({ id: "ref", version: "1.0.0", schema: M }),
  });
  assert.equal(prepare.descripteur.paquet.nom, "p110");
  assert.equal(prepare.migration, true);
  assert.equal(prepare.delaiMs, 1000 * FACTEUR_DU_DELAI_DE_MIGRATION);
  // L'AUTORISATION de migrer n'est posée que sous le geste (revue de #249, constat 4).
  assert.match(prepare.cmdline, / vault\.migrer=1$/);
});

test("un refus de déphasage rend son code et la décision, sans descripteur à booter", async () => {
  const prepare = await preparerLeDemarrage({
    lu: lu(),
    nom: "application",
    miseAJour: true,
    delaiMs: 1,
    lireManifeste: async () => manifeste({ id: "autre", version: "1.0.0", schema: M }),
  });
  assert.equal(prepare.refus, C.applicationEtrangere);
  assert.equal(prepare.descripteur, undefined);
  assert.equal(prepare.dephasage.code, C.applicationEtrangere);
});

test("aucune application servie et aucun coffre : rien à démarrer, sans refus typé", async () => {
  const prepare = await preparerLeDemarrage({
    lu: { present: false, motif: "aucun descripteur servi (404)" },
    nom: "application",
    delaiMs: 1,
    lireManifeste: async () => null,
  });
  assert.deepEqual(prepare, { sansApplication: true, motif: "aucun descripteur servi (404)" });
});

test("aucune application servie mais un coffre existe : APPLICATION_NON_SERVIE", async () => {
  const prepare = await preparerLeDemarrage({
    lu: { present: false, motif: "absent" },
    nom: "application",
    delaiMs: 1,
    lireManifeste: async () => manifeste({ id: "ref", version: "1.0.0", schema: M }),
  });
  assert.equal(prepare.refus, C.applicationNonServie);
});

test("l'INTENTION n'est inscrite que sous le geste qui migre, et une seule fois", async () => {
  const ecrits = [];
  const inscrire = async (nom, m) => ecrits.push(parseManifest(serializeManifest(m)));
  const avant = manifeste({ id: "ref", version: "1.0.0", schema: M });
  const sansGeste = { migration: false, manifeste: avant, descripteur: descripteur() };
  assert.equal(
    await inscrireLIntention({ nom: "application", prepare: sansGeste, inscrire }),
    false,
  );
  const geste = { migration: true, manifeste: avant, descripteur: descripteur() };
  assert.equal(await inscrireLIntention({ nom: "application", prepare: geste, inscrire }), true);
  assert.deepEqual(ecrits[0].app.migration, { version: "1.1.0", schema: N });
  assert.equal(ecrits[0].app.schema, M, "l'intention ne déplace pas le constat");
  const deja = { ...geste, manifeste: ecrits[0] };
  assert.equal(await inscrireLIntention({ nom: "application", prepare: deja, inscrire }), false);
  assert.equal(ecrits.length, 1);
});

test("l'intention d'un coffre de T1 inscrit aussi le schéma DÉDUIT (revue de #249, constat 5)", async () => {
  const ecrits = [];
  const prepare = {
    migration: true,
    schemaDeduit: M,
    manifeste: manifeste({ id: "ref", version: "1.0.0" }),
    descripteur: descripteur(),
  };
  await inscrireLIntention({
    nom: "application",
    prepare,
    inscrire: async (nom, m) => ecrits.push(m),
  });
  assert.equal(ecrits[0].app.schema, M);
  assert.deepEqual(ecrits[0].app.migration, { version: "1.1.0", schema: N });
});

test("le manifeste SUIT une migration jouée : version et schéma, intention effacée", async () => {
  const ecrits = [];
  const avant = parseManifest(
    serializeManifest({
      ...manifeste({ id: "ref", version: "1.0.0", schema: M }),
      app: { id: "ref", version: "1.0.0", schema: M, migration: { version: "1.1.0", schema: N } },
    }),
  );
  const suivi = await suivreLeConstat({
    nom: "application",
    manifeste: avant,
    application: { version: "1.1.0", schema: N },
    constat: { volume: M, refus: null, migration: { jouee: true, de: M, vers: N, ms: 1 } },
    inscrire: async (nom, m) => ecrits.push(m),
  });
  assert.equal(suivi.ecrit, true);
  assert.deepEqual(ecrits[0].app, { id: "ref", version: "1.1.0", schema: N });
});

test("le manifeste NE suit PAS : reprise par instantané, refus, ou schéma qui n'est pas celui du paquet", async () => {
  const avant = manifeste({ id: "ref", version: "1.0.0", schema: M });
  const inscrire = async () => assert.fail("rien ne doit être écrit");
  const application = { version: "1.1.0", schema: N };
  for (const constat of [
    null,
    { volume: M, refus: "divergent", migration: null },
    { volume: M, refus: null, migration: { jouee: false, schema: M } },
  ]) {
    const suivi = await suivreLeConstat({
      nom: "application",
      manifeste: avant,
      application,
      constat,
      inscrire,
    });
    assert.equal(suivi.ecrit, false, JSON.stringify(constat));
  }
});

test("un coffre de T1 sans schéma reçoit le sien au premier boot qui le constate", async () => {
  const ecrits = [];
  const suivi = await suivreLeConstat({
    nom: "application",
    manifeste: manifeste({ id: "ref", version: "1.0.0" }),
    application: { version: "1.0.0", schema: M },
    constat: { volume: M, refus: null, migration: { jouee: false, schema: M } },
    inscrire: async (nom, m) => ecrits.push(m),
  });
  assert.equal(suivi.ecrit, true);
  assert.equal(ecrits[0].app.schema, M);
  assert.equal(ecrits[0].app.version, "1.0.0");
});

test("déjà à jour : rien n'est réécrit", async () => {
  const suivi = await suivreLeConstat({
    nom: "application",
    manifeste: manifeste({ id: "ref", version: "1.1.0", schema: N }),
    application: { version: "1.1.0", schema: N },
    constat: { volume: N, refus: null, migration: { jouee: false, schema: N } },
    inscrire: async () => assert.fail("rien ne doit être écrit"),
  });
  assert.deepEqual(suivi, { ecrit: false, motif: "déjà à jour" });
});

test("les refus du GUEST reçoivent leur code de coquille ; une panne n'en reçoit aucun", () => {
  assert.equal(codeDuRefusDuGuest({ motifDeSchema: "anterieur" }), C.schemaDivergent);
  assert.equal(codeDuRefusDuGuest({ motifDeSchema: "divergent" }), C.schemaDivergent);
  assert.equal(codeDuRefusDuGuest({ motifDeSchema: "migration-echouee" }), C.migrationEchouee);
  assert.equal(
    codeDuRefusDuGuest({ motifDeSchema: "marqueur-invalide" }),
    C.marqueurDeSchemaInvalide,
  );
  assert.equal(codeDuRefusDuGuest({ motifDeSchema: "parametre-double" }), C.parametreDuGuestRefuse);
  assert.equal(
    codeDuRefusDuGuest({ motifDeSchema: "migration-non-autorisee" }),
    C.migrationNonAutorisee,
  );
  assert.equal(codeDuRefusDuGuest(new Error("panne")), null);
});

test("la ligne de commande n'accueille qu'un schéma en chiffres, jamais une chaîne servie", () => {
  assert.equal(ligneDeCommande("root=/dev/sda1", N), `root=/dev/sda1 vault.schema=${N}`);
  assert.equal(ligneDeCommande("root=/dev/sda1", null), "root=/dev/sda1");
  assert.equal(ligneDeCommande("root=/dev/sda1", "1 init=/bin/sh"), "root=/dev/sda1");
});

test("le descripteur du courant est rendu tel quel", () => {
  const d = descripteur();
  assert.equal(descripteurDuPaquet(d, "courant"), d);
});

test("la réponse d'un démarrage refusé porte le code, la signature et la décision quand elles existent", () => {
  assert.deepEqual(reponseDeDemarrageRefuse({ motif: "rien" }), {
    demarree: false,
    motif: "rien",
    code: C.applicationAbsente,
  });
  const refus = reponseDeDemarrageRefuse({
    motif: "m",
    code: C.applicationAnterieure,
    dephasage: { issue: "refus" },
  });
  assert.deepEqual(refus.dephasage, { issue: "refus" });
  const signature = reponseDeDemarrageRefuse({
    motif: "m",
    code: C.volumeApplicatifSansManifeste,
    installationInterrompue: true,
    motifDeLaSignature: null,
  });
  assert.equal(signature.installationInterrompue, true);
});

test("ce que le démarrage publie de la mise à jour est à PLAT", () => {
  assert.equal(miseAJourPubliee(undefined, null), null);
  const publie = miseAJourPubliee(
    {
      issue: "mettre-a-jour",
      jouee: true,
      coffre: { version: "1.0.0", schema: M },
      servie: { version: "1.1.0", schema: N },
      manifeste: { ecrit: true },
    },
    { volume: M, migration: { jouee: true, de: M, vers: N, ms: 42 } },
  );
  assert.deepEqual(publie, {
    issue: "mettre-a-jour",
    geste: true,
    versionDuCoffre: "1.0.0",
    schemaDuCoffre: M,
    versionServie: "1.1.0",
    schemaServi: N,
    constatDuGuest: true,
    schemaDesDonnees: M,
    migrationJouee: true,
    migrationDe: M,
    migrationVers: N,
    migrationMs: 42,
    manifesteEcrit: true,
  });
  for (const valeur of Object.values(publie)) assert.notEqual(typeof valeur, "object");
});
