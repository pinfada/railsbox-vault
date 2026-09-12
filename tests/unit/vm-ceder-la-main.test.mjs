/**
 * CÉDER LA MAIN (#192, correction I1 de la revue de la PR #203).
 *
 * La mort par silence du Worker de confiance venait d'une boucle d'installation qui ne rendait
 * jamais la main à la boucle d'événements : le battement, minuterie du même fil, ne tirait pas.
 * Ce fichier mesure les deux moitiés de la correction sans navigateur : la règle de tranche, et le
 * fait qu'une MINUTERIE tire pendant un versement dont chaque `await` se règle en microtâche.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { TRANCHE_MS, creerCederLaMain } from "../../src/vm/ceder-la-main.mjs";
import { verserFluxDansVolume } from "../../src/vm/versement-de-disque.mjs";

test("la main n'est cédée qu'au-delà d'une tranche, puis la tranche repart", async () => {
  let horloge = 0;
  const planifies = [];
  const ceder = creerCederLaMain({
    maintenant: () => horloge,
    planifier: (geste) => {
      planifies.push(horloge);
      geste();
    },
  });
  assert.equal(await ceder(), false);
  horloge = TRANCHE_MS - 1;
  assert.equal(await ceder(), false);
  horloge = TRANCHE_MS;
  assert.equal(await ceder(), true);
  // La tranche repart de l'instant où la main est revenue : pas de rafale de cessions.
  horloge = TRANCHE_MS + 1;
  assert.equal(await ceder(), false);
  horloge = 2 * TRANCHE_MS;
  assert.equal(await ceder(), true);
  assert.deepEqual(planifies, [TRANCHE_MS, 2 * TRANCHE_MS]);
});

/** Un flux ENTIÈREMENT en mémoire : chaque lecture se règle en microtâche. */
function fluxEnMemoire(morceaux) {
  return new ReadableStream({
    start(controleur) {
      for (const morceau of morceaux) controleur.enqueue(morceau);
      controleur.close();
    },
  });
}

test("une MINUTERIE tire pendant un versement qui ne se règle qu'en microtâches", async (t) => {
  const morceaux = Array.from({ length: 4000 }, () => new Uint8Array(4096));
  t.mock.method(globalThis, "fetch", async () => new Response(fluxEnMemoire(morceaux)));
  // Un support SYNCHRONE et coûteux, comme l'écriture OPFS du Worker : aucune tâche n'y est posée.
  const backend = {
    async write(_offset, octets) {
      const fin = performance.now() + 0.05;
      let somme = 0;
      while (performance.now() < fin) somme += octets[0];
      return somme;
    },
    async flush() {},
  };
  let battements = 0;
  const minuterie = setInterval(() => {
    battements += 1;
  }, 10);
  const debut = performance.now();
  try {
    const verse = await verserFluxDansVolume(backend, "http://exemple.invalid/disque.img");
    assert.equal(verse.ecrits, 4000 * 4096);
  } finally {
    clearInterval(minuterie);
  }
  const dureeMs = performance.now() - debut;
  // Un versement de plus de deux tranches DOIT avoir laissé tirer la minuterie. Sans la cession, le
  // compte est ZÉRO quelle que soit la durée : c'est exactement le silence que la page constatait.
  assert.ok(dureeMs > 3 * TRANCHE_MS, `versement trop court pour mesurer (${dureeMs} ms)`);
  assert.ok(battements > 0, `aucune minuterie n'a tiré en ${Math.round(dureeMs)} ms de versement`);
});

test("le versement par tranches écrit les MÊMES octets, sans jamais couper un mébioctet", async (t) => {
  const MIO = 1 << 20;
  // Des morceaux de flux de tailles arbitraires, dont un bien plus gros qu'une tranche.
  const tailles = [3, MIO - 1, 5 * MIO + 17, 2, 3 * MIO];
  let graine = 7;
  const morceaux = tailles.map((taille) =>
    Uint8Array.from({ length: taille }, () => (graine = (graine * 31 + 11) & 0xff)),
  );
  const attendu = new Uint8Array(tailles.reduce((a, b) => a + b, 0));
  let position = 0;
  for (const morceau of morceaux) {
    attendu.set(morceau, position);
    position += morceau.byteLength;
  }
  t.mock.method(globalThis, "fetch", async () => new Response(fluxEnMemoire(morceaux)));
  const recu = new Uint8Array(attendu.byteLength);
  const ecritures = [];
  const backend = {
    async write(offset, octets) {
      ecritures.push([offset, octets.byteLength]);
      recu.set(octets, offset);
    },
    async flush() {},
  };
  const verse = await verserFluxDansVolume(backend, "http://exemple.invalid/disque.img");
  assert.equal(verse.ecrits, attendu.byteLength);
  assert.deepEqual(recu, attendu);
  for (const [offset, longueur] of ecritures) {
    assert.ok(longueur <= MIO, `écriture de ${longueur} octets`);
    // Une écriture ne franchit aucune frontière absolue d'un mébioctet.
    assert.equal(Math.floor(offset / MIO), Math.floor((offset + longueur - 1) / MIO));
  }
});
