import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { copierPourMigration } from "../../src/vm/copie-de-migration.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { inventorierEnveloppe, ouvrirEnveloppe } from "../../src/vm/enveloppe-de-cle.mjs";
import { argon2Vendu } from "../../src/vm/derivation/argon2-vendu.mjs";
import { derivateurPhrase } from "../../src/vm/derivation/derivateur-phrase.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  IDENTIFIANT_DU_COFFRE,
  IDENTIFIANT_DU_VOLUME_COQUILLE,
} from "../../src/coquille/identites-du-coffre.mjs";
import { magasin, supportDe } from "./support-archive-recuperation.mjs";

// La fixture contient seulement le petit volume coquille, PAS un disque Rails ni des notes.
// Ce test prouve sa copie et la conservation de l'enveloppe, pas une migration de coffre complète.
const FIXTURE = new URL("../fixtures/coffre-anterieur/coffre-anterieur.json", import.meta.url);
const PHRASE = "une phrase de coffre antérieur, pour la fixture de #207";

async function chargerHistorique() {
  const banc = magasin();
  const { fichiers } = JSON.parse(await readFile(FIXTURE, "utf8"));
  for (const [nom, base64] of Object.entries(fichiers)) {
    await banc.ecrire(nom, new Uint8Array(Buffer.from(base64, "base64")));
  }
  return { ...banc, noms: Object.keys(fichiers) };
}

async function ouvrirAvecLaPhrase(banc) {
  const support = supportDe(banc, "coquille");
  const inventaire = await inventorierEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
  });
  const emplacement = inventaire.emplacements.find((e) => e.typeKek === TYPES_KEK.phrase);
  assert.ok(emplacement, "le moyen historique est inventorié, sans recréer d'enveloppe");
  const argon2 = argon2Vendu({
    chargerArtefact: async () =>
      new Uint8Array(await readFile(new URL("../../vendor/argon2/argon2.wasm", import.meta.url))),
  });
  const kek = await derivateurPhrase({ argon2 }).deriver({
    parametres: emplacement.parametres,
    identite: {
      identifiantVolume: IDENTIFIANT_DU_COFFRE,
      identifiantEmplacement: emplacement.identifiantEmplacement,
    },
    geste: { phrase: PHRASE },
  });
  assert.equal(kek.extractable, false, "la KEK reste une clé WebCrypto non extractible");
  return ouvrirEnveloppe({ support, identifiantVolume: IDENTIFIANT_DU_COFFRE, kek });
}

test("la fixture historique se copie sous l'identité actuelle sans changer son moyen d'ouverture", async () => {
  const banc = await chargerHistorique();
  const ouverte = await ouvrirAvecLaPhrase(banc);
  const ouvrir = (name, identifiantVolume, size) =>
    openOpfsVolume({
      name,
      identifiantVolume,
      size,
      cle: ouverte.dek,
      openHandle: banc.store.openHandle,
    });
  let source;
  let cible;
  let clair;
  try {
    source = await ouvrir("coquille", IDENTIFIANT_DU_COFFRE);
    clair = await source.read(0, source.size());
    const avant = banc.noms.map((nom) => [nom, banc.store.snapshot(nom)]);
    cible = await ouvrir("copie-historique", IDENTIFIANT_DU_VOLUME_COQUILLE, source.size());
    let texte = null;
    const resultat = await copierPourMigration({
      source: { nom: "coquille", identifiantVolume: IDENTIFIANT_DU_COFFRE, backend: source },
      cible: {
        nom: "copie-historique",
        identifiantVolume: IDENTIFIANT_DU_VOLUME_COQUILLE,
        backend: cible,
      },
      journal: {
        lire: () => texte,
        ecrire: (valeur) => {
          texte = valeur;
        },
      },
    });
    assert.equal(resultat.copieVerifiee, true);
    for (const [nom, octets] of avant) {
      assert.deepEqual(banc.store.snapshot(nom), octets, `original conservé : ${nom}`);
    }
    await cible.close();
    cible = await ouvrir("copie-historique", IDENTIFIANT_DU_VOLUME_COQUILLE);
    assert.deepEqual(await cible.read(0, cible.size()), clair);
    const rouverte = await ouvrirAvecLaPhrase(banc);
    try {
      assert.deepEqual(rouverte.dek, ouverte.dek, "la phrase retrouve toujours la même clé");
    } finally {
      rouverte.dek.fill(0);
    }
  } finally {
    ouverte.dek.fill(0);
    clair?.fill(0);
    try {
      await cible?.close();
    } finally {
      await source?.close();
    }
  }
});
