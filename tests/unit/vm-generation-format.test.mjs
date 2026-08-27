import assert from "node:assert/strict";
import test from "node:test";

import {
  ENTETE_OCTETS,
  GENERATION_FORMAT,
  RACINES,
  RACINE_ENTETE_OCTETS,
  PAGE_HOTE_OCTETS,
  RACINE_OCTETS,
  crc32,
  decoderRacine,
  encoderEnteteEnregistrement,
  encoderRacine,
  offsetDeRacine,
  racineDeSequence,
} from "../../src/vm/generation-format.mjs";

// Format de l'enregistrement de validation d'une génération (#16, ADR 0014).
//
// Ces épreuves fixent ce qu'un support doit rendre pour qu'une génération soit VALIDÉE. La règle est
// stricte dans un seul sens : tout doute est un refus. Un en-tête dont la somme ne tombe pas juste
// n'est pas « probablement bon » — il n'est pas une racine.

const TAILLE_VOLUME = 16384;

function racineValide(surcharge = {}) {
  return {
    sequence: 5,
    generation: 3,
    tailleVolume: TAILLE_VOLUME,
    enregistrements: 2,
    longueurCharge: 1024,
    sommeCharge: 0x12345678,
    ...surcharge,
  };
}

test("une racine encodée tient dans un seul secteur et se relit à l'identique", () => {
  const octets = encoderRacine(racineValide());
  assert.equal(octets.byteLength, RACINE_OCTETS);
  assert.ok(RACINE_OCTETS <= 512, "la commutation doit tenir dans une écriture d'un seul secteur");

  const relue = decoderRacine(octets, { tailleVolume: TAILLE_VOLUME });
  assert.equal(relue.valide, true);
  assert.equal(relue.racine.sequence, 5);
  assert.equal(relue.racine.generation, 3);
  assert.equal(relue.racine.enregistrements, 2);
  assert.equal(relue.racine.longueurCharge, 1024);
  assert.equal(relue.racine.sommeCharge, 0x12345678);
  assert.equal(relue.racine.format, GENERATION_FORMAT);
});

test("un seul octet retourné dans l'en-tête invalide la racine au lieu de l'arrondir", () => {
  const octets = encoderRacine(racineValide());
  for (const position of [0, 8, 16, 24, 32, 40, 47]) {
    const abimee = Uint8Array.from(octets);
    abimee[position] ^= 0x01;
    const relue = decoderRacine(abimee, { tailleVolume: TAILLE_VOLUME });
    assert.equal(relue.valide, false, `l'octet ${position} doit invalider la racine`);
    assert.match(relue.raison, /\S/);
  }
});

test("une racine dont l'en-tête est tronqué par une déchirure n'est jamais une racine", () => {
  const octets = encoderRacine(racineValide());
  for (const atteints of [8, 40, RACINE_ENTETE_OCTETS - 1]) {
    const tronquee = new Uint8Array(RACINE_OCTETS);
    tronquee.set(octets.subarray(0, atteints));
    const relue = decoderRacine(tronquee, { tailleVolume: TAILLE_VOLUME });
    assert.equal(relue.valide, false, `${atteints} octet(s) atteints doivent invalider la racine`);
  }
});

test("une déchirure AU-DELÀ de l'en-tête ne fait rien perdre, et le format le dit", () => {
  // Le reste du secteur est une réserve de zéros : elle ne porte aucune information. Une racine dont
  // seuls les soixante premiers octets ont atteint le support est donc COMPLÈTE, et la traiter comme
  // abîmée refuserait une génération parfaitement validée. C'est une propriété du format, pas un
  // trou de la vérification — et elle est écrite ici pour ne pas être découverte en production.
  const octets = encoderRacine(racineValide());
  const partielle = new Uint8Array(RACINE_OCTETS);
  partielle.set(octets.subarray(0, RACINE_ENTETE_OCTETS));
  const relue = decoderRacine(partielle, { tailleVolume: TAILLE_VOLUME });
  assert.equal(relue.valide, true);
  assert.equal(relue.racine.generation, 3);
  assert.deepEqual(
    [...octets.subarray(RACINE_ENTETE_OCTETS)],
    [...new Uint8Array(RACINE_OCTETS - RACINE_ENTETE_OCTETS)],
  );
});

test("une racine écrite pour un autre volume est refusée, pas adoptée", () => {
  const octets = encoderRacine(racineValide());
  const relue = decoderRacine(octets, { tailleVolume: TAILLE_VOLUME * 2 });
  assert.equal(relue.valide, false);
  assert.match(relue.raison, /taille/i);
});

test("un secteur vierge est une absence de racine, pas une corruption", () => {
  const relue = decoderRacine(new Uint8Array(RACINE_OCTETS), { tailleVolume: TAILLE_VOLUME });
  assert.equal(relue.valide, false);
  assert.equal(relue.vierge, true);
});

test("les deux racines alternent, et une validation n'écrase jamais celle qui fait autorité", () => {
  assert.equal(RACINES, 2);
  assert.equal(racineDeSequence(1), 1 % RACINES);
  assert.notEqual(racineDeSequence(1), racineDeSequence(2));
  assert.equal(offsetDeRacine(0), 0);
  // Une PAGE HÔTE sépare les deux emplacements, pas un secteur : refuser l'atomicité sectorielle
  // tout en supposant qu'une écriture n'abîme pas le secteur voisin de la même page serait
  // incohérent. L'hypothèse qui reste — deux pages distinctes ne tombent pas ensemble — est écrite
  // dans l'ADR 0014.
  assert.equal(offsetDeRacine(1), PAGE_HOTE_OCTETS);
  assert.ok(PAGE_HOTE_OCTETS > RACINE_OCTETS);
});

test("l'en-tête d'un enregistrement porte son offset logique et sa longueur", () => {
  const entete = encoderEnteteEnregistrement({ offset: 4096, longueur: 512 });
  assert.equal(entete.byteLength, ENTETE_OCTETS);
  assert.notEqual(crc32(entete), 0);
});

test("la somme de contrôle est incrémentale : crc(A||B) se poursuit depuis crc(A)", () => {
  const a = Uint8Array.from([1, 2, 3, 4, 5]);
  const b = Uint8Array.from([9, 8, 7]);
  const ensemble = Uint8Array.from([...a, ...b]);
  assert.equal(crc32(b, crc32(a)), crc32(ensemble));
});

test("la somme de contrôle distingue deux charges qui ne diffèrent que par un octet", () => {
  const a = new Uint8Array(512).fill(7);
  const b = Uint8Array.from(a);
  b[300] = 8;
  assert.notEqual(crc32(a), crc32(b));
});
