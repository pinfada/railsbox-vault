/**
 * Les artefacts COMPRESSÉS (gzip, #236 T2 ; ADR 0041, note du 19/09/2026) et la garde « volume
 * neuf » (constat 8 de la revue de la PR #237).
 *
 * Les trois morceaux d'une application voyagent en gzip standard ; `octets` et `sha256` restent ceux
 * de l'image DÉCOMPRESSÉE. Éprouvé ici : la décompression rend l'image exacte et son empreinte, la
 * taille transférée est exigée à l'octet, une bombe de décompression est arrêtée à la taille de
 * l'image, l'absence de `DecompressionStream` est un refus TYPÉ, et
 * aucun versement qui n'écrit pas les zéros n'atteint un volume qui n'est pas neuf.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import test from "node:test";

import { acquerirLeDisqueSysteme } from "../../src/vm/acquisition-du-disque-systeme.mjs";
import { ouvrirLeFluxDArtefact } from "../../src/vm/flux-d-artefact.mjs";
import { RUNTIME_ERROR_CODES } from "../../src/vm/runtime-errors.mjs";
import { verserFluxDansVolume } from "../../src/vm/versement-de-disque.mjs";

const MIO = 1024 * 1024;
const empreinteDe = (octets) => createHash("sha256").update(octets).digest("hex");

/** Une image d'essai de 4 Mio, presque vide, comme une graine. */
function imageDEssai() {
  const image = new Uint8Array(4 * MIO);
  image.fill(0x11, 0, 4096);
  image.fill(0x22, 3 * MIO, 3 * MIO + 8192);
  return image;
}

/** Sert des octets par une vraie `Response`, et retient le mode de cache demandé. */
function servir(octets, demandes = []) {
  return async (url, init) => {
    demandes.push({ url, cache: init?.cache });
    return new Response(octets);
  };
}

function volumeEnMemoire(taille, { naissance = true, prerempli = 0 } = {}) {
  const octets = new Uint8Array(taille).fill(prerempli);
  const ecritures = [];
  return {
    naissance,
    octets,
    ecritures,
    async write(offset, morceau) {
      ecritures.push(offset);
      octets.set(morceau, offset);
    },
    async flush() {},
  };
}

test("une graine gzip se décompresse en flux : image exacte, empreinte de l'image, transfert compté", async () => {
  const image = imageDEssai();
  const gz = gzipSync(image, { level: 9 });
  assert.ok(gz.byteLength < 64 * 1024, "une graine vide se compresse à presque rien");
  const volume = volumeEnMemoire(image.byteLength);
  const verse = await verserFluxDansVolume(volume, "/artifacts/r/graine-abcdef12.ext4.gz", {
    recuperer: servir(gz),
    compression: "gzip",
    transfertOctets: gz.byteLength,
    empreinteAttendue: empreinteDe(image),
    sauterLesBlocsNuls: true,
    octetsMax: image.byteLength,
  });
  assert.deepEqual(volume.octets, image);
  assert.equal(verse.ecrits, image.byteLength);
  assert.equal(verse.empreinteSource, empreinteDe(image));
  assert.equal(verse.transferes, gz.byteLength);
});

test("un transfert qui n'a pas la taille annoncée est refusé, dans les deux sens", async () => {
  const image = imageDEssai();
  const gz = gzipSync(image);
  for (const annonce of [gz.byteLength - 1, gz.byteLength + 1]) {
    await assert.rejects(
      verserFluxDansVolume(volumeEnMemoire(image.byteLength), "/a/g.gz", {
        recuperer: servir(gz),
        compression: "gzip",
        transfertOctets: annonce,
        octetsMax: image.byteLength,
      }),
      /octets compressés reçus/,
    );
  }
});

test("une BOMBE de décompression est arrêtée à la taille de l'image annoncée", async () => {
  const bombe = gzipSync(new Uint8Array(32 * MIO));
  const volume = volumeEnMemoire(4 * MIO);
  await assert.rejects(
    verserFluxDansVolume(volume, "/a/g.gz", {
      recuperer: servir(bombe),
      compression: "gzip",
      transfertOctets: bombe.byteLength,
      sauterLesBlocsNuls: true,
      octetsMax: 4 * MIO,
    }),
    /plus de 4194304 octets décompressés/,
  );
});

test("sans DecompressionStream, un artefact compressé est un refus TYPÉ, avant tout réseau", async () => {
  const demandes = [];
  await assert.rejects(
    ouvrirLeFluxDArtefact(
      { url: "/a/p.gz", compression: "gzip", transfertOctets: 10, sha256: "0".repeat(64) },
      { nom: "paquet", recuperer: servir(new Uint8Array(10), demandes), portee: {} },
    ),
    (erreur) => erreur.code === RUNTIME_ERROR_CODES.decompressionUnavailable,
  );
  assert.equal(demandes.length, 0);
});

test("une compression inconnue est refusée, jamais devinée", async () => {
  await assert.rejects(
    ouvrirLeFluxDArtefact(
      { url: "/a/p.zst", compression: "zstd", transfertOctets: 10 },
      { nom: "paquet", recuperer: servir(new Uint8Array(10)) },
    ),
    /compression inconnue/,
  );
});

test("le disque système se compose de morceaux gzip : mêmes octets, mêmes empreintes", async () => {
  const rootfs = new Uint8Array(2 * MIO).fill(0x5a);
  const paquet = imageDEssai();
  const gzRootfs = gzipSync(rootfs);
  const gzPaquet = gzipSync(paquet);
  const servis = new Map([
    ["/r.gz", gzRootfs],
    ["/p.gz", gzPaquet],
  ]);
  const acquis = await acquerirLeDisqueSysteme({
    rootfs: {
      url: "/r.gz",
      octets: rootfs.byteLength,
      sha256: empreinteDe(rootfs),
      compression: "gzip",
      transfertOctets: gzRootfs.byteLength,
    },
    paquet: {
      url: "/p.gz",
      octets: paquet.byteLength,
      sha256: empreinteDe(paquet),
      compression: "gzip",
      transfertOctets: gzPaquet.byteLength,
    },
    recuperer: async (url) => new Response(servis.get(url)),
  });
  assert.deepEqual(acquis.vues.rootfs, rootfs);
  assert.deepEqual(acquis.vues.paquet, paquet);
  assert.equal(acquis.mesures.transfereOctets, gzRootfs.byteLength + gzPaquet.byteLength);
});

test("CONSTAT 8 : sauter les zéros sur un volume HABITÉ est refusé, rien n'est écrit", async () => {
  const image = imageDEssai();
  for (const naissance of [false, "absent"]) {
    const habite = volumeEnMemoire(image.byteLength, { naissance, prerempli: 0xaa });
    // Un backend qui ne DIT pas sa naissance n'est pas neuf.
    if (naissance === "absent") delete habite.naissance;
    await assert.rejects(
      verserFluxDansVolume(habite, "/a/g", { recuperer: servir(image), sauterLesBlocsNuls: true }),
      /volume NEUF/,
    );
    assert.equal(habite.ecritures.length, 0);
  }
});

test("un versement PLEIN, qui écrit tout, reste permis sur un volume habité", async () => {
  const image = imageDEssai();
  const habite = volumeEnMemoire(image.byteLength, { naissance: false, prerempli: 0xaa });
  await verserFluxDansVolume(habite, "/a/g", { recuperer: servir(image) });
  assert.deepEqual(habite.octets, image);
});
