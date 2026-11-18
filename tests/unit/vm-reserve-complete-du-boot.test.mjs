/**
 * La réserve COMPLÈTE, telle que le BOOT la calcule (#247, D1g ; revue de #298, constat 2 du second tour).
 *
 * `reserveComplete` autorise à ranger le descripteur scellé : vrai, il promet un démarrage hors connexion que la
 * réserve doit tenir tout entière — les cinq petits artefacts ET le rootfs ET le paquet. Elle était calculée DEUX fois :
 * la fonction exportée `reserveTientTout` (éprouvée, mutée) et une copie dans `loadRuntime` (exécutée par le boot,
 * jamais mutée). Il n'y en a plus qu'une, et cette épreuve traverse `loadRuntime` — le chemin de production — avec
 * un vrai magasin en mémoire, un faux réseau et un disque système dont on dicte les statuts.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { adresseDe } from "../../src/v86-adresses.mjs";
import { loadRuntime } from "../../src/vm/acquisition-des-artefacts.mjs";
import { creerMagasinDArtefacts } from "../../src/vm/magasin-d-artefacts.mjs";
import { primitivesEnMemoire } from "./magasin-en-memoire.mjs";

const sha = (octets) => createHash("sha256").update(octets).digest("hex");
const octetsDe = (marque, taille = 64) =>
  Uint8Array.from({ length: taille }, (_, i) => (marque + i) % 251);

/** Un runtime complet : le wasm est épinglé par le manifeste v86, les quatre autres par `empreintes`. */
function monde() {
  const wasm = octetsDe(1);
  const manifesteV86 = {
    artifacts: [{ name: "v86.wasm", bytes: wasm.byteLength, sha256: sha(wasm) }],
  };
  const fichiers = new Map([[adresseDe("v86.wasm", sha(wasm)), wasm]]);
  const empreintes = {};
  const runtime = {
    wasm: adresseDe("v86.wasm", sha(wasm)),
    manifesteV86,
    disqueSysteme: { rootfs: { sha256: "a".repeat(64) }, paquet: { sha256: "b".repeat(64) } },
  };
  for (const [rang, nom] of ["bios", "vgaBios", "kernel", "initrd"].entries()) {
    const octets = octetsDe(10 + rang);
    runtime[nom] = `/artifacts/x/${nom}.bin`;
    fichiers.set(runtime[nom], octets);
    empreintes[nom] = { sha256: sha(octets), octets: octets.byteLength };
  }
  runtime.empreintes = empreintes;
  return { runtime, fichiers };
}

/** Un disque système dont les statuts du magasin sont dictés ; il ne télécharge rien. */
const disque = (rootfs, paquet) => async () => ({
  vues: { rootfs: new Uint8Array(1), paquet: new Uint8Array(1) },
  tampon: new Uint8Array(2),
  mesures: { magasin: { rootfs, paquet }, transfereOctets: 0 },
  empreintesVerifiees: {},
});

async function reserveComplete({ rootfs, paquet, avecMagasin = true }) {
  const { runtime, fichiers } = monde();
  const reseau = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const octets = fichiers.get(url);
    if (octets === undefined) return { ok: false, status: 404 };
    return { ok: true, status: 200, arrayBuffer: async () => octets.slice().buffer };
  };
  try {
    const base = creerMagasinDArtefacts({ primitives: primitivesEnMemoire() });
    // `retenir` vient de `ouvrirLeMagasinOpfs` : ici une rétention qui ne purge rien.
    const magasin = avecMagasin ? { ...base, retenir: async () => [] } : null;
    const charge = await loadRuntime(runtime, {
      magasin,
      acquerirLeDisque: disque(rootfs, paquet),
    });
    return charge.reserveComplete;
  } finally {
    globalThis.fetch = reseau;
  }
}

test("les cinq petits ET le rootfs ET le paquet dans la réserve : complète (servi ou admis)", async () => {
  assert.equal(await reserveComplete({ rootfs: "admis", paquet: "servi" }), true);
  assert.equal(await reserveComplete({ rootfs: "servi", paquet: "admis" }), true);
});

test("un paquet ou un rootfs hors de la réserve : incomplète — le descripteur ne sera pas rangé", async () => {
  assert.equal(await reserveComplete({ rootfs: "admis", paquet: "absent" }), false);
  assert.equal(await reserveComplete({ rootfs: "echec", paquet: "servi" }), false);
  assert.equal(
    await reserveComplete({ rootfs: "VAULT-ARTEFACTS-ADMISSION-REFUSEE", paquet: "admis" }),
    false,
  );
});

test("un petit artefact hors de la réserve (pas de magasin) : incomplète, même disque complet", async () => {
  assert.equal(
    await reserveComplete({ rootfs: "servi", paquet: "servi", avecMagasin: false }),
    false,
  );
});
