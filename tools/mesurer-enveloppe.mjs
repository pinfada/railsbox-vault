#!/usr/bin/env node
// Mesure le coût des opérations d'ENVELOPPE DE CLÉ (#21, ADR 0020).
//
//     node tools/mesurer-enveloppe.mjs [--repetitions 200]
//
// Ce que la mesure établit, et ce qu'elle n'établit pas :
//
//  - elle établit l'ORDRE DE GRANDEUR du déverrouillage sous les primitives de WebCrypto, sur UNE
//    machine et UN moteur (Node). C'est ce que l'ADR 0020 publie, et rien de plus ;
//  - elle n'établit RIEN sur le coût de #22 : dériver une KEK d'une phrase secrète par Argon2id est
//    délibérément coûteux, de plusieurs ordres de grandeur au-dessus de ce qui est mesuré ici. La
//    mesure de #21 porte sur l'enveloppe SEULE, une KEK étant déjà en main ;
//  - elle n'établit rien sur le TEMPS D'HORLOGE d'un refus par rapport à un succès. L'enveloppe
//    garantit que le nombre d'appels AEAD est le même pour une clé révoquée et une clé inconnue —
//    ce que `tests/unit/vm-enveloppe-operations.test.mjs` compte —, pas que WebCrypto y consacre la
//    même durée.
//
// Le pire cas est mesuré exprès : une enveloppe PLEINE, dont la clé présentée occupe le DERNIER
// emplacement, puisque l'ouverture les essaie tous sans court-circuit.

import { performance } from "node:perf_hooks";

import {
  EMPLACEMENTS_MAX,
  ajouterEmplacement,
  creerEnveloppe,
  ouvrirEnveloppe,
  revoquerEmplacement,
} from "../src/vm/enveloppe-de-cle.mjs";

const IDENTIFIANT_VOLUME = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";
const cle = (base) => Uint8Array.from({ length: 32 }, (_, index) => (base + index) % 256);

/** Support en mémoire : la mesure porte sur la cryptographie, pas sur le disque. */
function support() {
  let contenu = null;
  return {
    etat: async () => ({ present: contenu !== null, taille: contenu?.byteLength ?? 0 }),
    lire: async (offset, longueur) => contenu.slice(offset, offset + longueur),
    allouer: async (taille) => {
      contenu = new Uint8Array(taille);
    },
    ecrire: async (offset, octets) => contenu.set(octets, offset),
    barriere: async () => {},
  };
}

function repetitions() {
  const rang = process.argv.indexOf("--repetitions");
  return rang === -1 ? 200 : Number.parseInt(process.argv[rang + 1], 10);
}

async function chronometrer(nom, tours, geste) {
  const echantillons = [];
  for (let tour = 0; tour < tours; tour += 1) {
    const debut = performance.now();
    await geste();
    echantillons.push(performance.now() - debut);
  }
  echantillons.sort((a, b) => a - b);
  return {
    nom,
    tours,
    medianeMs: Number(echantillons[Math.floor(tours / 2)].toFixed(4)),
    p95Ms: Number(echantillons[Math.floor(tours * 0.95)].toFixed(4)),
    maxMs: Number(echantillons.at(-1).toFixed(4)),
  };
}

async function main() {
  const tours = repetitions();
  const dek = cle(0x20);
  const kekPremiere = cle(0x80);
  const kekDerniere = cle(0x40);
  const kekInconnue = cle(0x11);

  const plein = support();
  const creee = await creerEnveloppe({
    support: plein,
    identifiantVolume: IDENTIFIANT_VOLUME,
    dek,
    kek: kekPremiere,
  });
  for (let rang = 1; rang < EMPLACEMENTS_MAX; rang += 1) {
    await ajouterEmplacement({
      support: plein,
      identifiantVolume: IDENTIFIANT_VOLUME,
      kek: kekPremiere,
      kekNouvelle: rang === EMPLACEMENTS_MAX - 1 ? kekDerniere : cle(rang),
    });
  }

  const seule = support();
  const seuleCreee = await creerEnveloppe({
    support: seule,
    identifiantVolume: IDENTIFIANT_VOLUME,
    dek,
    kek: kekPremiere,
  });

  const mesures = [
    await chronometrer("ouvrir — un seul emplacement", tours, () =>
      ouvrirEnveloppe({ support: seule, identifiantVolume: IDENTIFIANT_VOLUME, kek: kekPremiere }),
    ),
    await chronometrer(`ouvrir — ${EMPLACEMENTS_MAX} emplacements, clé au DERNIER`, tours, () =>
      ouvrirEnveloppe({ support: plein, identifiantVolume: IDENTIFIANT_VOLUME, kek: kekDerniere }),
    ),
    await chronometrer(`refus — ${EMPLACEMENTS_MAX} emplacements, clé inconnue`, tours, () =>
      ouvrirEnveloppe({
        support: plein,
        identifiantVolume: IDENTIFIANT_VOLUME,
        kek: kekInconnue,
      }).catch(() => {}),
    ),
    await chronometrer("créer", tours, () =>
      creerEnveloppe({
        support: support(),
        identifiantVolume: IDENTIFIANT_VOLUME,
        dek,
        kek: kekPremiere,
      }),
    ),
  ];

  const rotation = support();
  await creerEnveloppe({
    support: rotation,
    identifiantVolume: IDENTIFIANT_VOLUME,
    dek,
    kek: kekPremiere,
  });
  mesures.push(
    await chronometrer("ajouter puis révoquer", Math.min(tours, 50), async () => {
      const ajoutee = cle(0x55);
      await ajouterEmplacement({
        support: rotation,
        identifiantVolume: IDENTIFIANT_VOLUME,
        kek: kekPremiere,
        kekNouvelle: ajoutee,
      });
      await revoquerEmplacement({
        support: rotation,
        identifiantVolume: IDENTIFIANT_VOLUME,
        kek: kekPremiere,
        identifiantEmplacement: (
          await ouvrirEnveloppe({
            support: rotation,
            identifiantVolume: IDENTIFIANT_VOLUME,
            kek: ajoutee,
          })
        ).identifiantEmplacement,
      });
    }),
  );

  process.stdout.write(
    `${JSON.stringify(
      {
        environnement: {
          moteur: `node ${process.version}`,
          plateforme: `${process.platform} ${process.arch}`,
        },
        emplacementsMax: EMPLACEMENTS_MAX,
        premierEmplacement: creee.identifiantEmplacement.length,
        enveloppeSeule: seuleCreee.version,
        mesures,
      },
      null,
      2,
    )}\n`,
  );
}

await main();
