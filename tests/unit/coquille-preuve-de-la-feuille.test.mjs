/**
 * La PREUVE DE LA FEUILLE (#239) : le secteur 1 du volume `coquille`, que le Worker de confiance
 * écrit après une ouverture par le code, et relit après toute ouverture.
 *
 * Les épreuves sur volume ouvrent un VRAI volume v3 scellé, sur le magasin en mémoire des bancs,
 * avec les options exactes du Worker (`public/runtime-worker.mjs`, `ouvrirLeVolume`) : trente-deux
 * secteurs, non transactionnel, sous `IDENTIFIANT_DU_VOLUME_COQUILLE`. Elles établissent ce que le
 * défi du 18/09/2026 avait laissé « non vérifié » : ce que rend la lecture d'un secteur jamais
 * écrit, et le refus exact au neuvième emplacement de l'enveloppe.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { IDENTIFIANT_DU_VOLUME_COQUILLE } from "../../src/coquille/identites-du-coffre.mjs";
import { ouvrirParLeCode } from "../../src/coquille/ouverture-par-le-code.mjs";
import {
  ETATS_DE_LA_PREUVE,
  FORMAT_DE_LA_PREUVE,
  IDENTIFIANTS_MAX,
  SECTEUR_DE_LA_PREUVE,
  encoderLaPreuve,
  feuilleEprouvee,
  inscrireLaPreuve,
  lireLaPreuve,
  lireLaPreuveDuVolume,
  listeApresInscription,
} from "../../src/coquille/preuve-de-la-feuille.mjs";
import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { inventorierEnveloppe } from "../../src/vm/enveloppe-de-cle.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { EMPLACEMENTS_MAX, TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { creerMoyenDeRecuperation } from "../../src/vm/moyen-de-recuperation.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { KEK, VOLUME_A, magasin, poserVolume } from "./support-archive-recuperation.mjs";

const ID = (rang) => rang.toString(16).padStart(16, "0");
const DEK_DE_LA_COQUILLE = new Uint8Array(32).fill(0x3c);

/** Ouvre le volume `coquille` comme le Worker l'ouvre. */
function ouvrirLaCoquille(banc) {
  return openOpfsVolume({
    name: "coquille",
    size: 32 * SECTOR_SIZE,
    cle: DEK_DE_LA_COQUILLE.slice(),
    identifiantVolume: IDENTIFIANT_DU_VOLUME_COQUILLE,
    transactionnel: false,
    openHandle: banc.store.openHandle,
  });
}

/** Le motif du secteur 0, tel que `ecrireEtAcquitter` l'écrit, puis la barrière. */
async function ecrireEtAcquitter(backend) {
  const secteur = Uint8Array.from({ length: SECTOR_SIZE }, (_, index) => (index * 5 + 7) & 0xff);
  await backend.write(0, secteur);
  await backend.flush();
}

test("l'enregistrement : marque, format 1, compte, huit places, et rien d'autre", () => {
  const secteur = encoderLaPreuve([ID(1), ID(0xabcdef)]);
  assert.equal(secteur.length, SECTOR_SIZE);
  assert.deepEqual([...secteur.subarray(0, 8)], [...new TextEncoder().encode("RBVFEUIL")]);
  assert.equal(secteur[8], FORMAT_DE_LA_PREUVE);
  assert.equal(secteur[9], 2);
  assert.ok(
    secteur.subarray(26).every((octet) => octet === 0),
    "le reste du secteur est à zéro",
  );
  assert.deepEqual(lireLaPreuve(secteur), {
    etat: ETATS_DE_LA_PREUVE.inscrite,
    identifiants: [ID(1), ID(0xabcdef)],
  });
  assert.throws(
    () => encoderLaPreuve(Array.from({ length: 9 }, (_, rang) => ID(rang))),
    /au plus 8/,
  );
  assert.throws(() => encoderLaPreuve(["pas-un-identifiant"]), /identifiantEmplacement/);
});

test("un secteur vierge, une marque étrangère, un format à venir, un compte hors borne : aucune feuille", () => {
  assert.deepEqual(lireLaPreuve(new Uint8Array(SECTOR_SIZE)), {
    etat: ETATS_DE_LA_PREUVE.vierge,
    identifiants: [],
  });
  const valide = encoderLaPreuve([ID(7)]);
  const alteres = {
    marque: (s) => (s[0] ^= 0xff),
    format: (s) => (s[8] = FORMAT_DE_LA_PREUVE + 1),
    compte: (s) => (s[9] = IDENTIFIANTS_MAX + 1),
  };
  for (const [nom, alterer] of Object.entries(alteres)) {
    const secteur = valide.slice();
    alterer(secteur);
    assert.deepEqual(
      lireLaPreuve(secteur),
      { etat: ETATS_DE_LA_PREUVE.inconnue, identifiants: [] },
      nom,
    );
  }
  // Le motif du secteur 0 n'est pas une preuve.
  const motif = Uint8Array.from({ length: SECTOR_SIZE }, (_, index) => (index * 5 + 7) & 0xff);
  assert.equal(lireLaPreuve(motif).identifiants.length, 0);
});

test("l'inscription : sans doublon, la plus récente en dernier, huit au plus", () => {
  assert.deepEqual(listeApresInscription([], ID(1)), [ID(1)]);
  assert.deepEqual(listeApresInscription([ID(1), ID(2)], ID(1)), [ID(2), ID(1)]);
  const huit = Array.from({ length: 8 }, (_, rang) => ID(rang + 1));
  const neuf = listeApresInscription(huit, ID(99));
  assert.equal(neuf.length, IDENTIFIANTS_MAX);
  assert.equal(neuf.at(-1), ID(99));
  assert.ok(!neuf.includes(ID(1)), "la plus ancienne sort");
  assert.ok(Object.isFrozen(neuf));
});

test("une feuille est éprouvée si un identifiant inscrit est ENCORE un emplacement de type 4", () => {
  const inventaire = {
    emplacements: [
      { typeKek: TYPES_KEK.phrase, identifiantEmplacement: ID(1) },
      { typeKek: TYPES_KEK.recuperation, identifiantEmplacement: ID(2) },
    ],
  };
  assert.equal(feuilleEprouvee([ID(2)], inventaire), true);
  assert.equal(feuilleEprouvee([ID(9), ID(2)], inventaire), true);
  assert.equal(feuilleEprouvee([], inventaire), false, "rien d'inscrit");
  assert.equal(feuilleEprouvee([ID(3)], inventaire), false, "feuille retirée de l'enveloppe");
  assert.equal(
    feuilleEprouvee([ID(1)], inventaire),
    false,
    "l'identifiant de la PHRASE n'est pas une feuille",
  );
  assert.equal(feuilleEprouvee([ID(2)], { emplacements: [] }), false);
  assert.equal(feuilleEprouvee([ID(2)], null), false);
});

test("VOLUME RÉEL : le secteur 1 d'un volume jamais écrit rend des zéros authentifiés, lus « vierge »", async () => {
  const banc = magasin();
  const neuf = await ouvrirLaCoquille(banc);
  await ecrireEtAcquitter(neuf);
  await neuf.close();
  // Un coffre d'avant la correction : le secteur 0 a été écrit, jamais le secteur 1.
  const rouvert = await ouvrirLaCoquille(banc);
  try {
    const brut = await rouvert.read(SECTEUR_DE_LA_PREUVE * SECTOR_SIZE, SECTOR_SIZE);
    assert.ok(
      brut.every((octet) => octet === 0),
      "un secteur jamais écrit se lit en zéros, sans refus",
    );
    assert.deepEqual(await lireLaPreuveDuVolume(rouvert), {
      etat: ETATS_DE_LA_PREUVE.vierge,
      identifiants: [],
    });
  } finally {
    await rouvert.close();
  }
});

test("VOLUME RÉEL : l'identifiant inscrit sous la barrière survit à la fermeture et se relit", async () => {
  const banc = magasin();
  const premier = await ouvrirLaCoquille(banc);
  const lue = await lireLaPreuveDuVolume(premier);
  const inscrite = await inscrireLaPreuve(premier, lue.identifiants, ID(0x42));
  await ecrireEtAcquitter(premier);
  await premier.close();
  assert.deepEqual(inscrite, [ID(0x42)]);

  const second = await ouvrirLaCoquille(banc);
  try {
    assert.deepEqual(await lireLaPreuveDuVolume(second), {
      etat: ETATS_DE_LA_PREUVE.inscrite,
      identifiants: [ID(0x42)],
    });
    // Réinscrire le même identifiant n'écrit rien.
    const ecritures = [];
    const espion = { write: async (...args) => ecritures.push(args) };
    assert.deepEqual(await inscrireLaPreuve(espion, [ID(0x42)], ID(0x42)), [ID(0x42)]);
    assert.equal(ecritures.length, 0);
  } finally {
    await second.close();
  }
});

test("VOLUME RÉEL : le secteur 0 garde son motif, et la preuve n'écrit QUE le secteur 1", async () => {
  const ecritures = [];
  const espion = { write: async (offset, octets) => ecritures.push([offset, octets.length]) };
  await inscrireLaPreuve(espion, [], ID(5));
  assert.deepEqual(ecritures, [[SECTOR_SIZE, SECTOR_SIZE]]);
});

test("ENVELOPPE RÉELLE : l'ouverture par le code rend l'identifiant qui a ouvert, et il est de type 4", async () => {
  const banc = magasin();
  const { support, code } = await poserVolume(banc);
  const ouverte = await ouvrirParLeCode({
    support,
    identifiantVolume: VOLUME_A,
    code,
    sansEmplacement: () => new Error("aucun"),
  });
  ouverte.dek.fill(0);
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: VOLUME_A });
  assert.match(ouverte.identifiantEmplacement, /^[0-9a-f]{16}$/);
  assert.equal(feuilleEprouvee([ouverte.identifiantEmplacement], inventaire), true);
});

test("ENVELOPPE RÉELLE : le neuvième emplacement est refusé par VAULT_ENVELOPPE_PLEINE, sans rien écrire", async () => {
  const banc = magasin();
  // Une phrase (la clé de pose) et un code : deux emplacements. Six codes de plus : huit.
  const { support } = await poserVolume(banc);
  for (let rang = 0; rang < EMPLACEMENTS_MAX - 2; rang += 1) {
    await creerMoyenDeRecuperation({ support, identifiantVolume: VOLUME_A, kek: KEK });
  }
  const avant = await inventorierEnveloppe({ support, identifiantVolume: VOLUME_A });
  assert.equal(avant.emplacements.length, EMPLACEMENTS_MAX);
  await assert.rejects(
    creerMoyenDeRecuperation({ support, identifiantVolume: VOLUME_A, kek: KEK }),
    (erreur) => erreur.code === ENVELOPPE_ERROR_CODES.pleine,
  );
  const apres = await inventorierEnveloppe({ support, identifiantVolume: VOLUME_A });
  assert.equal(apres.version, avant.version, "aucune version n'a été brûlée");
  assert.equal(apres.emplacements.length, EMPLACEMENTS_MAX);
});

/**
 * Le Worker de confiance ne s'importe pas sous Node (ses imports sont ceux du serveur de la coquille) :
 * ses COUTURES se relisent dans sa source. Elles sont courtes, et c'est leur ORDRE qui compte.
 */
test("WORKER : la preuve est lue et inscrite APRÈS l'ouverture du volume, AVANT sa barrière, et seul un code l'écrit", async () => {
  const source = await readFile(
    new URL("../../public/runtime-worker.mjs", import.meta.url),
    "utf8",
  );
  const debut = source.indexOf("async function deverrouiller(");
  const corps = source.slice(debut, source.indexOf("\n}\n", debut));
  const rang = (texte) => {
    const trouve = corps.indexOf(texte);
    assert.notEqual(trouve, -1, `« ${texte} » absent de deverrouiller`);
    return trouve;
  };
  assert.ok(rang("await ouvrirLeVolume(ouverte.dek)") < rang("await constaterALOuverture("));
  assert.ok(rang("await constaterALOuverture(") < rang("interne.etat = ETATS_DU_VOLUME.ouvert"));
  assert.ok(rang("interne.etat = ETATS_DU_VOLUME.ouvert") < rang("await ecrireEtAcquitter()"));
  assert.match(corps, /feuilleEprouvee: feuilleEprouvee\(\s*interne\.eprouves,/);
  // L'emplacement inscrit est celui d'un CODE, jamais celui d'une phrase ou d'une passkey.
  assert.match(
    source,
    /identifiantEprouve: moyen\.derivePar === "page" \? null : ouverte\.identifiantEmplacement,/,
  );
  assert.match(source, /return \{ dek, kek, version: creee\.version, identifiantEprouve: null \};/);
  // L'inventaire relit la preuve contre l'enveloppe du moment, et seulement coffre ouvert.
  assert.match(
    source,
    /feuilleEprouvee:\s*interne\.etat === ETATS_DU_VOLUME\.ouvert && feuilleEprouvee\(interne\.eprouves, inventaire\),/,
  );
  assert.match(
    source,
    /interne\.etat = ETATS_DU_VOLUME\.verrouille;\n\s*interne\.eprouves = \[\];/,
  );
});
