/**
 * Le VERSEMENT DE LA GRAINE : blocs nuls sautés, empreinte de la source confrontée (#236, ADR 0041).
 *
 * Installer une application, c'est verser dans le volume du coffre l'image d'un disque de données
 * de 512 Mio dont l'essentiel est vide : une base migrée sans enregistrement, un `storage/` sans
 * pièce jointe. Deux choses en découlent, et elles sont mesurées ici :
 *
 *  - **les blocs nuls ne sont pas écrits.** Un volume neuf scellé se relit à zéro (ADR 0041) : les
 *    écrire reviendrait à chiffrer 394 Mio de zéros pour obtenir ce que la lecture rend déjà ;
 *  - **l'empreinte de la SOURCE est confrontée pendant le versement.** Jusqu'ici, le versement
 *    rendait l'empreinte du fichier ÉCRIT, que la datation relisait — mais rien ne comparait jamais
 *    les octets reçus à ce que l'origine déclare. Un écart doit refuser l'installation.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { verserFluxDansVolume } from "../../src/vm/versement-de-disque.mjs";

const MIO = 1024 * 1024;

/** Backend d'essai : retient ce qui a été écrit, et compte les écritures. */
function backendDEssai() {
  const ecritures = [];
  return {
    ecritures,
    octetsEcrits: () => ecritures.reduce((somme, ecriture) => somme + ecriture.octets, 0),
    async write(offset, octets) {
      ecritures.push({ offset, octets: octets.byteLength });
    },
    async flush() {},
  };
}

/** Sert un contenu en flux, par morceaux, comme le ferait une réponse HTTP. */
function servir(contenu, { morceauOctets = 3 * MIO } = {}) {
  return async () => ({
    ok: true,
    body: {
      getReader() {
        let position = 0;
        return {
          async read() {
            if (position >= contenu.byteLength) return { done: true, value: undefined };
            const fin = Math.min(contenu.byteLength, position + morceauOctets);
            const value = contenu.subarray(position, fin);
            position = fin;
            return { done: false, value };
          },
        };
      },
    },
  });
}

/** Une graine d'essai : 8 Mio, dont deux régions non nulles. */
function graineDEssai() {
  const graine = new Uint8Array(8 * MIO);
  graine.fill(0x42, 0, 4096);
  graine.fill(0x7f, 5 * MIO, 5 * MIO + 8192);
  return graine;
}

const empreinteDe = (octets) => createHash("sha256").update(octets).digest("hex");

test("les blocs nuls ne sont pas écrits, et le compte d'octets reçus reste entier", async () => {
  const graine = graineDEssai();
  const backend = backendDEssai();

  const verse = await verserFluxDansVolume(backend, "https://origine.test/graine.ext4", {
    recuperer: servir(graine),
    sauterLesBlocsNuls: true,
  });

  assert.equal(verse.ecrits, graine.byteLength, "tout le flux est LU, même ce qui n'est pas écrit");
  assert.ok(
    backend.octetsEcrits() < graine.byteLength / 4,
    `${backend.octetsEcrits()} octets écrits sur ${graine.byteLength} : les zéros doivent être sautés`,
  );
  assert.ok(backend.octetsEcrits() >= 4096 + 8192, "les régions non nulles sont bien écrites");
});

test("ce qui est écrit l'est au bon décalage, et rien d'autre ne l'est", async () => {
  const graine = graineDEssai();
  const backend = backendDEssai();

  await verserFluxDansVolume(backend, "https://origine.test/graine.ext4", {
    recuperer: servir(graine),
    sauterLesBlocsNuls: true,
  });

  const reconstitue = new Uint8Array(graine.byteLength);
  for (const { offset, octets } of backend.ecritures) {
    reconstitue.fill(1, offset, offset + octets);
  }
  for (const position of [0, 4095, 5 * MIO, 5 * MIO + 8191]) {
    assert.equal(reconstitue[position], 1, `l'octet ${position} devait être écrit`);
  }
  assert.equal(reconstitue[3 * MIO], 0, "un bloc nul n'est pas écrit");
});

test("sans l'option, tout est écrit : le versement d'un disque quelconque ne change pas", async () => {
  const graine = graineDEssai();
  const backend = backendDEssai();

  await verserFluxDansVolume(backend, "https://origine.test/graine.ext4", {
    recuperer: servir(graine),
  });

  assert.equal(backend.octetsEcrits(), graine.byteLength);
});

test("l'empreinte de la source est rendue, et confrontée à celle qu'on attend", async () => {
  const graine = graineDEssai();
  const backend = backendDEssai();

  const verse = await verserFluxDansVolume(backend, "https://origine.test/graine.ext4", {
    recuperer: servir(graine),
    sauterLesBlocsNuls: true,
    empreinteAttendue: empreinteDe(graine),
  });

  assert.equal(verse.empreinteSource, empreinteDe(graine));
});

test("un écart d'empreinte REFUSE le versement, et le dit", async () => {
  const graine = graineDEssai();
  const backend = backendDEssai();

  await assert.rejects(
    verserFluxDansVolume(backend, "https://origine.test/graine.ext4", {
      recuperer: servir(graine),
      sauterLesBlocsNuls: true,
      empreinteAttendue: "0".repeat(64),
    }),
    (erreur) => {
      assert.match(erreur.message, /empreinte/i);
      assert.match(erreur.message, /0{16}/);
      return true;
    },
  );
});

test("un flux tronqué est refusé par l'empreinte, sans qu'un volume s'en croie complet", async () => {
  const graine = graineDEssai();
  const backend = backendDEssai();

  await assert.rejects(
    verserFluxDansVolume(backend, "https://origine.test/graine.ext4", {
      recuperer: servir(graine.subarray(0, 6 * MIO)),
      empreinteAttendue: empreinteDe(graine),
    }),
    /empreinte/i,
  );
});
