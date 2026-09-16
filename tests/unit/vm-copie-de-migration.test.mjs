import assert from "node:assert/strict";
import test from "node:test";
import { copierPourMigration } from "../../src/vm/copie-de-migration.mjs";
import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { MIGRATION_ERROR_CODES as C } from "../../src/vm/migration-errors.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { SURCOUT_ENREGISTREMENT, ZONE_ENREGISTREMENTS } from "../../src/vm/generation-format.mjs";

const SOURCE = "12".repeat(16);
const CIBLE = "34".repeat(16);
const TAILLE = 3 * SECTOR_SIZE;
const PANNE = new Error("coupure simulée");

function contenu() {
  return Uint8Array.from({ length: TAILLE }, (_, rang) => (rang * 7 + 9) % 256);
}

// Le double distingue écrit et durable : une coupure perd tout ce qui n'a pas été flushé.
// Les hooks lèvent AVANT ou APRÈS chaque geste, sans changer l'algorithme testé.
function banc() {
  const original = contenu();
  let courant = new Uint8Array(TAILLE);
  let durable = courant.slice();
  const b = { texte: null, gestes: [], buffers: [], hook: () => {} };
  const noter = (geste) => {
    b.gestes.push(geste);
    b.hook(geste);
  };
  const lire = (octets, position, longueur) => {
    const buffer = octets.slice(position, position + longueur);
    b.buffers.push(buffer);
    return buffer;
  };
  b.source = {
    nom: "ancien",
    identifiantVolume: SOURCE,
    backend: {
      size: () => TAILLE,
      read: (position, longueur) => lire(original, position, longueur),
      write: () => assert.fail("La source ne doit jamais être écrite"),
      flush: () => assert.fail("La source ne doit jamais être mutée"),
    },
  };
  b.cible = {
    nom: "copie",
    identifiantVolume: CIBLE,
    backend: {
      size: () => TAILLE,
      read: (position, longueur) => lire(courant, position, longueur),
      relire: (position, longueur) => lire(courant, position, longueur),
      write: (position, octets) => {
        noter(`avant:write:${position}`);
        courant.set(octets, position);
        noter(`apres:write:${position}`);
      },
      flush: () => {
        noter("avant:flush");
        durable = courant.slice();
        noter("apres:flush");
      },
    },
  };
  b.journal = {
    lire: () => b.texte,
    ecrire: (texte) => {
      const position = JSON.parse(texte).position;
      noter(`avant:journal:${position}`);
      b.texte = texte;
      noter(`apres:journal:${position}`);
    },
  };
  b.crash = () => {
    courant = durable.slice();
    b.hook = () => {};
  };
  b.alterer = (position) => {
    courant[position] ^= 1;
  };
  b.verifier = () => {
    assert.deepEqual(original, contenu(), "source intacte");
    assert.deepEqual(durable, original, "copie durable complète");
    assert.ok(
      b.buffers.every((buffer) => buffer.every((octet) => octet === 0)),
      "clair effacé",
    );
  };
  return b;
}

function copier(b, extra = {}) {
  return copierPourMigration({ ...b, blocOctets: SECTOR_SIZE, ...extra });
}

test("copie relue, flush avant journal, source intacte et buffers de clair effacés", async () => {
  const b = banc();
  assert.deepEqual(await copier(b), { copieVerifiee: true, reprise: false, octets: TAILLE });
  assert.deepEqual(b.gestes.slice(0, 8), [
    "avant:journal:0",
    "apres:journal:0",
    "avant:write:0",
    "apres:write:0",
    "avant:flush",
    "apres:flush",
    `avant:journal:${SECTOR_SIZE}`,
    `apres:journal:${SECTOR_SIZE}`,
  ]);
  assert.equal(JSON.parse(b.texte).position, TAILLE, "journal conservé pour la publication");
  b.verifier();
});

// Toutes les frontières, pas seulement « après le premier bloc » : journal initial inclus.
test("chaque interruption reprend depuis la source sans perdre de bloc durable", async (t) => {
  const temoin = banc();
  await copier(temoin);
  for (let rang = 0; rang < temoin.gestes.length; rang += 1) {
    await t.test(`coupure ${rang + 1} : ${temoin.gestes[rang]}`, async () => {
      const b = banc();
      let appel = 0;
      b.hook = () => {
        if (appel++ === rang) throw PANNE;
      };
      await assert.rejects(copier(b), (erreur) => erreur === PANNE);
      const reprise = b.texte !== null;
      b.crash();
      assert.equal((await copier(b)).reprise, reprise);
      b.verifier();
    });
  }
});

test("une écriture partielle est entièrement rejouée depuis le dernier flush journalisé", async () => {
  const b = banc();
  const ecrire = b.cible.backend.write;
  b.cible.backend.write = (position, octets) => {
    ecrire(position, octets.subarray(0, 73));
    b.cible.backend.flush();
    throw PANNE;
  };
  await assert.rejects(copier(b), (erreur) => erreur === PANNE);
  assert.equal(JSON.parse(b.texte).position, 0);
  b.crash();
  b.cible.backend.write = ecrire;
  await copier(b);
  b.verifier();
});

test("un journal falsifié en fin de volume ne vaut jamais preuve de copie", async () => {
  const b = banc();
  b.hook = (geste) => {
    if (geste === "apres:journal:0") throw PANNE;
  };
  await assert.rejects(copier(b), (erreur) => erreur === PANNE);
  b.crash();
  b.texte = JSON.stringify({ ...JSON.parse(b.texte), position: TAILLE });
  await assert.rejects(copier(b), { code: C.conversionIncoherente });
  assert.ok(b.buffers.every((buffer) => buffer.every((octet) => octet === 0)));
});

test("une reprise achevée relit aussi le préfixe déjà copié", async () => {
  const b = banc();
  await copier(b);
  b.alterer(0);
  await assert.rejects(copier(b), { code: C.conversionIncoherente });
});

test("journaux tronqués, étrangers, hors limites ou enrichis : refus sans écriture", async () => {
  const modele = banc();
  await copier(modele);
  const journal = JSON.parse(modele.texte);
  for (const texte of [
    "{",
    "null",
    "[]",
    " ".repeat(4097),
    undefined,
    JSON.stringify({ ...journal, source: "autre" }),
    JSON.stringify({ ...journal, identifiantCible: SOURCE }),
    JSON.stringify({ ...journal, position: 1 }),
    JSON.stringify({ ...journal, position: -SECTOR_SIZE }),
    JSON.stringify({ ...journal, position: TAILLE + SECTOR_SIZE }),
    JSON.stringify({ ...journal, ignorerVerification: true }),
  ]) {
    const b = banc();
    b.texte = texte;
    await assert.rejects(copier(b), { code: C.journalMalformed });
    assert.deepEqual(b.gestes, []);
  }
});

test("source et cible confondues ou géométrie invalide : refus avant journal", async () => {
  for (const modifier of [
    (b) => {
      b.cible.backend = b.source.backend;
    },
    (b) => {
      b.cible.nom = b.source.nom;
    },
    (b) => {
      b.cible.identifiantVolume = SOURCE;
    },
    (b) => {
      b.cible.identifiantVolume = { toString: () => CIBLE };
    },
    (b) => {
      b.cible.backend.size = () => TAILLE + SECTOR_SIZE;
    },
  ]) {
    const b = banc();
    modifier(b);
    await assert.rejects(copier(b), { code: C.conversionIncoherente });
    assert.deepEqual(b.gestes, []);
  }
  for (const blocOctets of [0, 513, 2 ** 30, NaN, Infinity]) {
    const b = banc();
    await assert.rejects(copier(b, { blocOctets }), { code: C.conversionIncoherente });
    assert.deepEqual(b.gestes, []);
  }
});

test("une lecture courte est refusée et son tampon est effacé", async () => {
  const b = banc();
  const court = new Uint8Array(73).fill(19);
  b.source.backend.read = () => court;
  await assert.rejects(copier(b), { code: C.conversionIncoherente });
  assert.ok(court.every((octet) => octet === 0));
  assert.equal(JSON.parse(b.texte).position, 0);
  assert.equal(b.gestes.length, 2, "aucune écriture de cible");
});

test("le dernier bloc plus court est copié et une reprise complète reste idempotente", async () => {
  const b = banc();
  await copier(b, { blocOctets: 2 * SECTOR_SIZE });
  const nombre = b.gestes.length;
  assert.equal((await copier(b, { blocOctets: 2 * SECTOR_SIZE })).reprise, true);
  assert.equal(b.gestes.length, nombre, "aucune réécriture après vérification complète");
  b.verifier();
});

test("deux vrais volumes v4 : nouvelle identité, fermeture, réouverture, même clair", async () => {
  const store = createSyncAccessStore();
  const ouvrir = (name, identifiantVolume) =>
    openOpfsVolume({
      name,
      identifiantVolume,
      size: TAILLE,
      cle: CLE_DE_TEST,
      openHandle: store.openHandle,
    });
  const source = await ouvrir("ancien", SOURCE);
  const cible = await ouvrir("copie", CIBLE);
  try {
    await source.write(0, contenu());
    await source.flush();
    const avant = store.snapshot("ancien");
    const b = banc();
    await copier(b, {
      source: { ...b.source, backend: source },
      cible: { ...b.cible, backend: cible },
    });
    assert.deepEqual(store.snapshot("ancien"), avant, "le fichier source est conservé");
    assert.deepEqual(await cible.read(0, TAILLE), contenu());
  } finally {
    await cible.close();
    await source.close();
  }
  const relu = await ouvrir("copie", CIBLE);
  try {
    assert.deepEqual(await relu.read(0, TAILLE), contenu());
  } finally {
    await relu.close();
  }
  await assert.rejects(ouvrir("copie", SOURCE), { code: "VAULT_STORAGE_IDENTITE_VOLUME" });
});

test("la vérification finale authentifie le journal sur le support, pas son cache de clair", async () => {
  const store = createSyncAccessStore();
  let corrompre = false;
  const openHandle = async (nom) => {
    const handle = await store.openHandle(nom);
    if (nom !== "copie.gen") return handle;
    return {
      ...handle,
      read(tampon, options) {
        const lus = handle.read(tampon, options);
        const position = ZONE_ENREGISTREMENTS + SURCOUT_ENREGISTREMENT;
        if (corrompre && options.at <= position && position < options.at + lus) {
          tampon[position - options.at] ^= 1;
        }
        return lus;
      },
    };
  };
  const cible = await openOpfsVolume({
    name: "copie",
    identifiantVolume: CIBLE,
    size: TAILLE,
    cle: CLE_DE_TEST,
    openHandle,
  });
  try {
    const b = banc();
    const ecrire = b.journal.ecrire;
    b.journal.ecrire = (texte) => {
      ecrire(texte);
      if (JSON.parse(texte).position === TAILLE) corrompre = true;
    };
    await assert.rejects(
      copier(b, {
        cible: { ...b.cible, backend: cible },
        blocOctets: TAILLE,
      }),
      { code: "VAULT_STORAGE_SCEAU_REFUSE" },
    );
  } finally {
    corrompre = false;
    await cible.close();
  }
});
