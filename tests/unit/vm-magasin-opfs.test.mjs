/**
 * Les primitives OPFS du magasin (#247, lot D1b) : voie synchrone et voie asynchrone rendent le
 * même magasin ; chaque poignée synchrone est refermée ; un magasin lent cède au téléchargement.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  DELAI_DU_MAGASIN_MS,
  MARGE_RESERVEE_AU_VOLUME,
  admissionSelonLeBudget,
  bilanDesPurges,
  borneDansLeTemps,
  budgetQuiCedeLeMagasin,
  libererPourLeVolume,
  ouvrirLeMagasinOpfs,
  purgerToutLeMagasin,
} from "../../src/vm/magasin-opfs.mjs";
import { createStorageBudget } from "../../src/vm/storage-budget.mjs";

const empreinteDe = (octets) => createHash("sha256").update(octets).digest("hex");

/** Un faux OPFS : fichiers en mémoire, poignées synchrones comptées. */
function fauxStockage({ synchrone }) {
  const fichiers = new Map();
  const etat = { ouvertes: 0 };
  const absent = () => Object.assign(new Error("absent"), { name: "NotFoundError" });
  const poigneeFichier = (nom) => ({
    kind: "file",
    async getFile() {
      const octets = fichiers.get(nom);
      return new Blob([octets]);
    },
    async createWritable() {
      return {
        async write({ position, data }) {
          const avant = fichiers.get(nom);
          const apres = new Uint8Array(Math.max(avant.byteLength, position + data.byteLength));
          apres.set(avant);
          apres.set(data, position);
          fichiers.set(nom, apres);
        },
        async close() {},
        async abort() {},
      };
    },
    ...(synchrone && {
      async createSyncAccessHandle() {
        etat.ouvertes += 1;
        return {
          read(cible, { at }) {
            const morceau = fichiers.get(nom).subarray(at, at + cible.byteLength);
            cible.set(morceau);
            return morceau.byteLength;
          },
          write(octets, { at }) {
            const avant = fichiers.get(nom);
            const apres = new Uint8Array(Math.max(avant.byteLength, at + octets.byteLength));
            apres.set(avant);
            apres.set(octets, at);
            fichiers.set(nom, apres);
            return octets.byteLength;
          },
          flush() {},
          close() {
            etat.ouvertes -= 1;
          },
        };
      },
    }),
  });
  const dossier = {
    async getFileHandle(nom, { create } = {}) {
      if (!fichiers.has(nom)) {
        if (!create) throw absent();
        fichiers.set(nom, new Uint8Array(0));
      }
      return poigneeFichier(nom);
    },
    async removeEntry(nom) {
      if (!fichiers.delete(nom)) throw absent();
    },
    async *entries() {
      for (const nom of [...fichiers.keys()]) yield [nom, { kind: "file" }];
    },
  };
  const stockage = {
    async getDirectory() {
      return { getDirectoryHandle: async () => dossier };
    },
  };
  return { stockage, fichiers, etat };
}

for (const synchrone of [true, false]) {
  test(`voie ${synchrone ? "synchrone" : "asynchrone"} : admis puis servi, aucune poignée restée ouverte`, async () => {
    const { stockage, fichiers, etat } = fauxStockage({ synchrone });
    const magasin = ouvrirLeMagasinOpfs({ stockage });
    const octets = new Uint8Array(3000).map((_, index) => index % 251);
    const sha256 = empreinteDe(octets);

    await magasin.admettre({ sha256, octets });
    assert.ok(fichiers.has(sha256), "l'artefact est rangé sous son empreinte");
    assert.ok(![...fichiers.keys()].some((nom) => nom.endsWith(".partiel")));

    const cible = new Uint8Array(octets.byteLength);
    assert.equal(await magasin.servir({ sha256, octets: octets.byteLength }, cible), true);
    assert.deepEqual(cible, octets);
    assert.equal(etat.ouvertes, 0);

    await magasin.purger([]);
    assert.equal(fichiers.size, 0);
  });
}

test("sans OPFS, pas de magasin : le boot télécharge", () => {
  assert.equal(ouvrirLeMagasinOpfs({ stockage: {} }), null);
});

test("un magasin trop lent cède : servir rend false, l'admission échoue MAGASIN_LENT", async () => {
  const jamais = new Promise(() => {});
  const lent = borneDansLeTemps({ servir: () => jamais, admettre: () => jamais }, 5);
  assert.equal(await lent.servir({}, new Uint8Array(0)), false);
  await assert.rejects(lent.admettre({}), { code: "MAGASIN_LENT" });
});

test("le délai du magasin est de 20 s : au-delà, le démarrage retombe sur le téléchargement", () => {
  assert.equal(DELAI_DU_MAGASIN_MS, 20_000);
});

test("rétention : garde rootfs, paquet courant et paquet précédent, oublie l'avant-dernier", async () => {
  const { stockage, fichiers } = fauxStockage({ synchrone: true });
  const magasin = ouvrirLeMagasinOpfs({ stockage });
  const morceau = (marque) => {
    const octets = new Uint8Array(1024).fill(marque);
    return { sha256: empreinteDe(octets), octets };
  };
  const [rootfs, v1, v2, v3] = [1, 2, 3, 4].map(morceau);
  // Chaque boot admet ce qu'il vient de télécharger, puis retient.
  const boot = async (paquet) => {
    for (const artefact of [rootfs, paquet]) await magasin.admettre(artefact);
    await magasin.retenir({ rootfs: rootfs.sha256, paquet: paquet.sha256 });
  };
  const presents = () => [rootfs, v1, v2, v3].map((artefact) => fichiers.has(artefact.sha256));

  await boot(v1);
  await boot(v2); // mise à jour v1 → v2
  await boot(v2); // simple réouverture
  assert.deepEqual(presents(), [true, true, true, false], "le précédent survit à une réouverture");

  await boot(v3); // mise à jour v2 → v3
  assert.deepEqual(presents(), [true, false, true, true], "l'avant-dernier est oublié");
});

test("le magasin cède au volume : une réservation à court purge le magasin, puis remesure", async () => {
  let libre = 100;
  const budget = createStorageBudget({ estimate: async () => ({ quota: libre, usage: 0 }) });
  let purges = 0;
  const cede = budgetQuiCedeLeMagasin(budget, async () => {
    purges += 1;
    libre = 1000; // la place que tenait le magasin
    return true;
  });
  assert.equal((await cede.reserve(50)).sufficient, true);
  assert.equal(purges, 0, "pas de purge quand la place suffit");
  assert.equal((await cede.reserve(500)).sufficient, true);
  assert.equal(purges, 1);

  const vide = budgetQuiCedeLeMagasin(budget, async () => false);
  assert.equal((await vide.reserve(5000)).sufficient, false, "rien à purger : le refus reste");
});

test("purgerToutLeMagasin retire le dossier, et ne lève jamais", async () => {
  const retraits = [];
  const stockage = {
    getDirectory: async () => ({
      removeEntry: async (nom, options) => retraits.push([nom, options]),
    }),
  };
  assert.equal(await purgerToutLeMagasin(stockage), true);
  assert.deepEqual(retraits, [["vault-artefacts", { recursive: true }]]);
  const tenu = {
    getDirectory: async () => ({
      removeEntry: async () => {
        throw Object.assign(new Error("tenu"), { name: "NoModificationAllowedError" });
      },
    }),
  };
  const signaux = [];
  const avant = bilanDesPurges().echecs;
  assert.equal(await purgerToutLeMagasin(tenu, (m) => signaux.push(m)), false);
  assert.equal(await purgerToutLeMagasin({}), false);
  assert.equal(bilanDesPurges().echecs, avant + 1, "le dossier tenu est compté");
  assert.equal(bilanDesPurges().derniere, "NoModificationAllowedError");
  assert.equal(signaux.length, 1);
  assert.match(signaux[0], /VAULT-ARTEFACTS-PURGE-ECHOUEE/);
});

test("libererPourLeVolume : purge seulement si la place manque, et ne lève jamais", async () => {
  let libre = 100;
  const stockage = { estimate: async () => ({ quota: libre, usage: 0 }) };
  let purges = 0;
  const purger = async () => {
    purges += 1;
    libre = 10_000;
    return true;
  };
  assert.deepEqual(await libererPourLeVolume(50, { stockage, purger }), { purge: false });
  assert.equal(purges, 0, "la place suffit : le magasin reste");
  assert.deepEqual(await libererPourLeVolume(500, { stockage, purger }), { purge: true });
  assert.equal(purges, 1);
  // Mesure indisponible : rien n'est purgé, rien ne lève.
  assert.deepEqual(await libererPourLeVolume(500, { stockage: {}, purger }), { purge: false });
  assert.equal(purges, 1);
});

test("purgerToutLeMagasin : un dossier déjà absent n'est ni compté ni signalé", async () => {
  const absent = {
    getDirectory: async () => ({
      removeEntry: async () => {
        throw Object.assign(new Error("absent"), { name: "NotFoundError" });
      },
    }),
  };
  const signaux = [];
  const avant = bilanDesPurges().echecs;
  assert.equal(await purgerToutLeMagasin(absent, (m) => signaux.push(m)), false);
  assert.equal(bilanDesPurges().echecs, avant);
  assert.deepEqual(signaux, []);
});

test("budget serré : l'admission est refusée, typée, avant toute écriture", async () => {
  const { stockage, fichiers } = fauxStockage({ synchrone: true });
  const octets = new Uint8Array(4096);
  // Assez pour l'artefact, pas pour l'artefact ET la marge du volume.
  const serre = createStorageBudget({
    estimate: async () => ({ quota: MARGE_RESERVEE_AU_VOLUME, usage: 0 }),
  });
  const magasin = ouvrirLeMagasinOpfs({ stockage, peutAdmettre: admissionSelonLeBudget(serre) });
  await assert.rejects(magasin.admettre({ sha256: empreinteDe(octets), octets }), {
    name: "AdmissionRefusee",
  });
  assert.equal(fichiers.size, 0);

  const large = createStorageBudget({
    estimate: async () => ({ quota: 2 * MARGE_RESERVEE_AU_VOLUME, usage: 0 }),
  });
  assert.equal(await admissionSelonLeBudget(large)(octets.byteLength), true);
  assert.equal(await admissionSelonLeBudget(createStorageBudget({}))(octets.byteLength), false);
});
