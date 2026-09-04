import assert from "node:assert/strict";
import test from "node:test";

import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import {
  EN_TETE_OCTETS,
  MARQUEUR_COMPLET,
  tailleDeFichier,
} from "../../src/vm/instantane/fichier-instantane.mjs";
import { INSTANTANE_ERROR_CODES } from "../../src/vm/instantane/instantane-errors.mjs";
import {
  capturerInstantane,
  ouvrirInstantaneDeReprise,
} from "../../src/vm/instantane-de-reprise.mjs";
import { CoupureDeCapture, supportInstantaneDouble } from "./support-instantane-double.mjs";

// CONDUITE de l'instantané de reprise (#65, ADR 0024, décisions 2 et 4).
//
// C'est le chemin de PRODUCTION : il écrit le fichier, le relit, confronte sa liaison à l'état
// présent, et — c'est le point de l'ADR — **écarte et RETIRE** dès qu'un écart apparaît, sans jamais
// laisser croire à une reprise.
//
// Chaque garde est éprouvée avec son TÉMOIN POSITIF : le même fichier, sous l'état qui l'a produit,
// doit rendre l'état v86. Sans témoin, une garde qui refuserait TOUT passerait pour une garde qui
// refuse ce qu'il faut.

const VOLUME_TEXTE = "0123456789abcdef0123456789abcdef";
const REGION = Uint8Array.from({ length: 32 }, (_, index) => (index * 3 + 1) % 256);
const IMAGE = Uint8Array.from({ length: 32 }, (_, index) => (index * 5 + 7) % 256);
const ETAT = Uint8Array.from({ length: 8192 }, (_, index) => (index * 11 + 3) % 256);

function etatPresent(remplacements = {}) {
  return {
    sequence: 42,
    generation: 17,
    empreinteRegion: REGION,
    empreinteImage: IMAGE,
    formatVolume: 3,
    ...remplacements,
  };
}

async function scellement() {
  return Scellement.ouvrir({
    volume: VOLUME_TEXTE,
    cleOctets: CLE_DE_TEST,
    formatVersion: 3,
  });
}

/** Capture un instantané nominal et rend le support qui le porte. */
async function supportAvecInstantane(options = {}) {
  const support = supportInstantaneDouble(options);
  const capture = await capturerInstantane({
    scellement: await scellement(),
    volume: "donnees",
    etatPresent: etatPresent(),
    etat: ETAT,
    support,
  });
  return { support, capture };
}

function ouvrir(support, remplacements = {}) {
  return scellement().then((scelle) =>
    ouvrirInstantaneDeReprise({
      scellement: scelle,
      volume: "donnees",
      etatPresent: etatPresent(remplacements),
      support,
    }),
  );
}

test("une capture écrit l'en-tête, le corps, PUIS la marque — et dans cet ordre", async () => {
  const { support, capture } = await supportAvecInstantane();
  assert.equal(capture.octets, tailleDeFichier(ETAT.byteLength));
  assert.equal(support.contenu.byteLength, tailleDeFichier(ETAT.byteLength));
  assert.equal(
    octetsEnHex(support.contenu.subarray(EN_TETE_OCTETS + ETAT.byteLength)),
    octetsEnHex(MARQUEUR_COMPLET),
  );

  const gestes = support.journal.map((entree) => entree.geste);
  const derniereBarriereAvantMarque = gestes.lastIndexOf("barriere", gestes.lastIndexOf("ecrire"));
  assert.ok(
    derniereBarriereAvantMarque !== -1,
    "une barrière doit précéder l'écriture de la marque : une marque posée avant attesterait d'un état qui n'est peut-être jamais arrivé au disque",
  );
  assert.equal(gestes[gestes.length - 1], "barriere", "la marque est elle-même rendue durable");
});

test("TÉMOIN POSITIF : l'instantané capturé se rouvre et rend l'état v86", async () => {
  const { support } = await supportAvecInstantane();
  const rapport = await ouvrir(support);
  assert.equal(rapport.motif, null, rapport.motif ?? "");
  assert.equal(rapport.utilise, true);
  assert.equal(octetsEnHex(rapport.etat), octetsEnHex(ETAT));
  assert.equal((await support.etat()).present, true, "un instantané valide n'est PAS retiré");
});

test("un support vide n'est pas un refus : c'est l'absence, et elle se dit", async () => {
  const support = supportInstantaneDouble();
  const rapport = await ouvrir(support);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, "absent");
  assert.equal(rapport.etat, null);
});

test("chaque ÉCART de liaison écarte l'instantané, le RETIRE, et nomme son motif", async () => {
  const ecarts = [
    [{ sequence: 43 }, INSTANTANE_ERROR_CODES.ecartSequence],
    [{ generation: 18 }, INSTANTANE_ERROR_CODES.ecartGeneration],
    [
      { empreinteRegion: Uint8Array.from(REGION, (octet) => octet ^ 1) },
      INSTANTANE_ERROR_CODES.ecartRegion,
    ],
    [
      { empreinteImage: Uint8Array.from(IMAGE, (octet) => octet ^ 1) },
      INSTANTANE_ERROR_CODES.ecartImage,
    ],
  ];

  for (const [remplacement, code] of ecarts) {
    const { support } = await supportAvecInstantane();
    const rapport = await ouvrir(support, remplacement);
    assert.equal(rapport.utilise, false, `${code} : l'instantané ne doit pas être utilisé`);
    assert.equal(rapport.motif, code);
    assert.equal(rapport.etat, null, "aucun état n'est rendu");
    assert.equal((await support.etat()).present, false, `${code} : le fichier doit être RETIRÉ`);
  }
});

test("un instantané d'un AUTRE volume est écarté et retiré", async () => {
  const { support } = await supportAvecInstantane();
  const autre = await Scellement.ouvrir({
    volume: "fedcba9876543210fedcba9876543210",
    cleOctets: CLE_DE_TEST,
    formatVersion: 3,
  });
  const rapport = await ouvrirInstantaneDeReprise({
    scellement: autre,
    volume: "donnees",
    etatPresent: etatPresent(),
    support,
  });
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.ecartVolume);
  assert.equal((await support.etat()).present, false);
});

test("une coupure AVANT la marque laisse un instantané INCOMPLET, écarté et retiré", async () => {
  // Gestes de la capture, dans l'ordre : 1 allouer, 2 écrire l'en-tête, 3 écrire le corps,
  // 4 barrière, 5 écrire la MARQUE, 6 barrière. Couper avant le cinquième laisse donc exactement
  // l'état que le plan de panne doit produire : le corps sur le support, et pas de marque.
  const coupe = supportInstantaneDouble({ couperAvant: 5 });
  await assert.rejects(
    capturerInstantane({
      scellement: await scellement(),
      volume: "donnees",
      etatPresent: etatPresent(),
      etat: ETAT,
      support: coupe,
    }),
    (erreur) => erreur instanceof CoupureDeCapture && erreur.rang === 5,
  );
  assert.equal(
    (await coupe.etat()).present,
    true,
    "le fichier reste sur le support, sans sa marque",
  );

  const rapport = await ouvrir(coupe);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.incomplet);
  assert.equal((await coupe.etat()).present, false, "un instantané incomplet est RETIRÉ");
});

test("un octet du corps retourné refuse le sceau, et l'instantané est retiré", async () => {
  const { support } = await supportAvecInstantane();
  const octets = support.contenu;
  octets[EN_TETE_OCTETS + 100] ^= 1;
  const abime = supportInstantaneDouble({ octets });

  const rapport = await ouvrir(abime);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.sceauRefuse);
  assert.equal((await abime.etat()).present, false);
});

test("un fichier qui n'est pas un instantané est écarté sans être interprété", async () => {
  const support = supportInstantaneDouble({
    octets: new Uint8Array(tailleDeFichier(64)).fill(0xaa),
  });
  const rapport = await ouvrir(support);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.malforme);
  assert.equal((await support.etat()).present, false);
});

test("un fichier plus court que son en-tête est écarté", async () => {
  const support = supportInstantaneDouble({ octets: new Uint8Array(EN_TETE_OCTETS - 8) });
  const rapport = await ouvrir(support);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.malforme);
});

test("un corps plus court que la longueur DÉCLARÉE est INCOMPLET, jamais complété de zéros", async () => {
  const { support } = await supportAvecInstantane();
  const tronque = supportInstantaneDouble({
    octets: support.contenu.subarray(0, EN_TETE_OCTETS + ETAT.byteLength - 512),
  });
  const rapport = await ouvrir(tronque);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.incomplet);
});

test("la capture consomme EXACTEMENT un scellement du budget de clé", async () => {
  const scelle = await scellement();
  const avant = scelle.scellementsCumules;
  await capturerInstantane({
    scellement: scelle,
    volume: "donnees",
    etatPresent: etatPresent(),
    etat: ETAT,
    support: supportInstantaneDouble(),
  });
  assert.equal(scelle.scellementsCumules, avant + 1, "un scellement par capture, ADR 0024 § 3");
});
