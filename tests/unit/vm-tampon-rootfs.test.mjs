import assert from "node:assert/strict";
import test from "node:test";

import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { BLOC_OCTETS, creerTamponRootfs } from "../../src/vm/instantane/tampon-rootfs.mjs";

// TAMPON DE ROOTFS à état DIFFÉRENTIEL (#65, ADR 0024).
//
// Le rootfs du guest de référence vit en RAM. Remis à v86 tel quel, son état capturé serait le
// DISQUE ENTIER — 385 Mio à côté de 250 Mio d'état v86, c'est-à-dire un instantané plus lourd que le
// volume qu'il accélère. Ce tampon ne publie que les blocs RÉELLEMENT ÉCRITS.
//
// Ce que ces épreuves tiennent, et pourquoi chacune :
//
//  - la lecture et l'écriture se comportent comme celles du tampon amont : sans cela, le boot à
//    froid changerait de vitesse, et la référence à laquelle la reprise se compare bougerait ;
//  - l'état ne porte QUE le delta — c'est toute la raison d'être du module ;
//  - un delta reposé sur l'image pristine rend EXACTEMENT le disque de la capture. C'est la
//    propriété dont dépend la correction de la reprise, pas seulement sa taille ;
//  - un delta d'une AUTRE image est refusé : il décrirait d'autres octets aux mêmes index.

const TAILLE = 8 * BLOC_OCTETS;

/** Image pristine déterministe : `octet i = (i * 31 + 7) mod 256`. */
function imagePristine() {
  return Uint8Array.from({ length: TAILLE }, (_, index) => (index * 31 + 7) % 256);
}

function ecrire(tampon, offset, octets) {
  let acquitte = false;
  tampon.set(offset, octets, () => {
    acquitte = true;
  });
  assert.equal(
    acquitte,
    true,
    "l'écriture d'un tampon de rootfs est SYNCHRONE, comme celle de v86",
  );
}

function lire(tampon, offset, longueur) {
  let rendu = null;
  tampon.get(offset, longueur, (octets) => {
    rendu = octets;
  });
  assert.notEqual(rendu, null, "la lecture d'un tampon de rootfs est SYNCHRONE");
  return rendu;
}

test("le tampon rend les octets de l'image, et relit ce qu'il a écrit", () => {
  const image = imagePristine();
  const tampon = creerTamponRootfs(image);
  assert.equal(tampon.byteLength, TAILLE);
  assert.equal(octetsEnHex(lire(tampon, 0, 4)), octetsEnHex(imagePristine().subarray(0, 4)));

  ecrire(tampon, 1000, Uint8Array.from([1, 2, 3, 4]));
  assert.equal(octetsEnHex(lire(tampon, 1000, 4)), "01020304");
});

test("un tampon jamais écrit ne publie AUCUN bloc", () => {
  const tampon = creerTamponRootfs(imagePristine());
  const [longueur, granularite, blocs] = tampon.get_state();
  assert.equal(longueur, TAILLE);
  assert.equal(granularite, BLOC_OCTETS);
  assert.deepEqual(blocs, []);
  assert.equal(tampon.deltaOctets(), 0);
});

test("l'état ne porte QUE les blocs écrits, jamais le disque entier", () => {
  const tampon = creerTamponRootfs(imagePristine());
  ecrire(tampon, 0, Uint8Array.from([9]));
  ecrire(tampon, 5 * BLOC_OCTETS, Uint8Array.from([9]));
  const [, , blocs] = tampon.get_state();
  assert.deepEqual(
    blocs.map(([index]) => index),
    [0, 5],
  );
  assert.equal(tampon.deltaOctets(), 2 * BLOC_OCTETS);
});

test("une écriture À CHEVAL salit les DEUX blocs qu'elle touche", () => {
  const tampon = creerTamponRootfs(imagePristine());
  ecrire(tampon, BLOC_OCTETS - 2, Uint8Array.from([1, 2, 3, 4]));
  const [, , blocs] = tampon.get_state();
  assert.deepEqual(
    blocs.map(([index]) => index),
    [0, 1],
    "un bloc à moitié écrit et non publié rendrait un disque restauré à moitié faux",
  );
});

test("un delta REPOSÉ sur l'image pristine rend EXACTEMENT le disque de la capture", () => {
  const capture = creerTamponRootfs(imagePristine());
  ecrire(
    capture,
    17,
    Uint8Array.from({ length: 300 }, (_, index) => index % 256),
  );
  ecrire(capture, 3 * BLOC_OCTETS + 11, Uint8Array.from([0xaa, 0xbb, 0xcc]));
  const etat = capture.get_state();

  const restaure = creerTamponRootfs(imagePristine());
  restaure.set_state(etat);

  assert.equal(
    octetsEnHex(lire(restaure, 0, TAILLE)),
    octetsEnHex(lire(capture, 0, TAILLE)),
    "le disque restauré doit être celui de la capture, octet pour octet",
  );
});

test("un tampon restauré publie le MÊME delta : une seconde capture ne perd rien", () => {
  const capture = creerTamponRootfs(imagePristine());
  ecrire(capture, 2 * BLOC_OCTETS, Uint8Array.from([1]));
  const restaure = creerTamponRootfs(imagePristine());
  restaure.set_state(capture.get_state());
  assert.deepEqual(
    restaure.get_state()[2].map(([index]) => index),
    [2],
    "un delta qui ne se republierait pas ferait perdre les écritures à la deuxième reprise",
  );
});

test("un delta reposé sur un tampon DÉJÀ SALI est REFUSÉ", () => {
  // Le défaut que la revue a trouvé par sonde : `set_state` vidait l'index des blocs salis puis
  // posait le delta, SANS remettre à pristine les blocs salis qui n'étaient pas dans le delta. Le
  // disque restauré n'était donc pas celui de la capture — il portait, en plus, les écritures du
  // tampon d'accueil. Le tampon ADOPTE son image et n'en garde aucune copie : il ne PEUT pas
  // revenir à pristine. Il refuse donc, plutôt que de rendre un disque à moitié faux.
  const capture = creerTamponRootfs(imagePristine());
  ecrire(capture, 0, Uint8Array.from([1, 2, 3]));
  const etat = capture.get_state();

  const sali = creerTamponRootfs(imagePristine());
  ecrire(sali, 5 * BLOC_OCTETS, Uint8Array.from([9]));
  assert.throws(() => sali.set_state(etat), /sali|refusé/i);

  // TÉMOIN POSITIF : un tampon neuf accepte le même delta.
  const neuf = creerTamponRootfs(imagePristine());
  neuf.set_state(etat);
  assert.equal(octetsEnHex(lire(neuf, 0, 3)), "010203");
});

test("une image DÉJÀ adoptée ne peut pas l'être une seconde fois", () => {
  // L'empreinte de l'image est prise à l'ACQUISITION (ADR 0024). Réemployer le même paquet
  // d'artefacts pour un second boot rendrait cette empreinte fausse : le rootfs aurait été écrit
  // par le premier. Le tampon marque donc l'image qu'il adopte, et refuse la seconde adoption.
  const image = imagePristine();
  creerTamponRootfs(image);
  assert.throws(() => creerTamponRootfs(image), /adoptée/i);
  // TÉMOIN POSITIF : une autre image s'adopte.
  creerTamponRootfs(imagePristine());
});

test("un delta d'une AUTRE géométrie est REFUSÉ, jamais reposé au hasard", () => {
  const tampon = creerTamponRootfs(imagePristine());
  assert.throws(() => tampon.set_state([TAILLE + BLOC_OCTETS, BLOC_OCTETS, []]), /refusé/i);
  assert.throws(() => tampon.set_state([TAILLE, BLOC_OCTETS * 2, []]), /refusé/i);
  // TÉMOIN POSITIF : le delta de la bonne géométrie passe.
  tampon.set_state([TAILLE, BLOC_OCTETS, []]);
});

test("get_buffer et load restent ceux du contrat de v86", () => {
  const tampon = creerTamponRootfs(imagePristine());
  let charge = null;
  tampon.onload = (evenement) => {
    charge = evenement;
  };
  tampon.load();
  assert.notEqual(charge, null, "v86 attend onload même quand rien n'est à charger");
  let tampons = null;
  tampon.get_buffer((valeur) => {
    tampons = valeur;
  });
  assert.equal(tampons.byteLength, TAILLE);
});
