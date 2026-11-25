import assert from "node:assert/strict";
import test from "node:test";

import {
  ETATS_DU_VOLUME,
  fermerLesBancs,
  KEK,
  messageDeCode,
  magasin,
  messageDePhrase,
  poserUneEnveloppeV1,
  workerDeverrouillage,
} from "./support-worker-deverrouillage.mjs";
import { installerLeDisque, poserLeVolumeCoquille } from "./support-coffre-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { manifestSidecarName, voisinsDunVolume } from "../../src/vm/opfs-sync-access.mjs";
import { IDENTIFIANT_DU_VOLUME_COQUILLE } from "../../src/coquille/identites-du-coffre.mjs";
import { revoquerToutSauf } from "../../src/vm/enveloppe-de-cle.mjs";
import { IDENTIFIANT_DU_COFFRE } from "../../src/coquille/identites-du-coffre.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { supportDe } from "./support-archive-recuperation.mjs";

// LE DÉVERROUILLAGE DU WORKER DE PRODUIT, EXÉCUTÉ (#311, C5).
//
// `public/runtime-worker-deverrouillage.mjs` est chargé tel qu'il est servi, sur le magasin en mémoire
// et les modules réels de `src/vm/`. Ces épreuves REMPLACENT les relectures de source qui tenaient
// lieu de preuve pour la lecture seule de la passe 1 et pour la revalidation de la passe 2 : ce
// qu'elles mesurent est ce que le chemin de production FAIT — quels octets d'enveloppe changent, et à
// quel moment par rapport à la prise du handle du volume.

test.afterEach(fermerLesBancs);

const ENVELOPPE = "coquille.cles";
const VOLUME = "coquille";
const octets = (banc, nom) => Buffer.from(banc.store.snapshot(nom));

/** Un coffre dont l'enveloppe est en page v1, et dont le petit volume existe déjà. */
async function coffreEnV1(options = {}) {
  const w = await workerDeverrouillage();
  const pose = await poserUneEnveloppeV1(w.banc, options);
  await poserLeVolumeCoquille(w.banc, IDENTIFIANT_DU_VOLUME_COQUILLE);
  return { w, ...pose };
}

/**
 * Déverrouille en RETENANT la prise du handle du volume, et rend ce que l'enveloppe valait à cet
 * instant précis : « avant le handle ».
 */
async function deverrouillerEnRetenant(w, message) {
  const retenue = w.retenir(VOLUME);
  const issue = w.deverrouiller(message).then(
    (valeur) => ({ valeur }),
    (erreur) => ({ erreur }),
  );
  await Promise.race([retenue.atteint, issue.then(() => assert.fail("terminé avant le handle"))]);
  const avantLeHandle = octets(w.banc, ENVELOPPE);
  retenue.relacher();
  return { avantLeHandle, issue: await issue };
}

test("PHRASE sur une page v1 : l'enveloppe n'est PAS écrite avant le handle, la migration vient après", async () => {
  const { w } = await coffreEnV1();
  const initial = octets(w.banc, ENVELOPPE);

  const { avantLeHandle, issue } = await deverrouillerEnRetenant(w, await messageDePhrase());

  assert.deepEqual(
    avantLeHandle,
    initial,
    "aucun octet d'enveloppe écrit avant la prise du handle",
  );
  assert.equal(issue.erreur, undefined, String(issue.erreur?.code ?? issue.erreur));
  const reponse = w.reponses.at(-1).corps;
  assert.equal(reponse.enveloppeMigree, true, "la migration a eu lieu, sous le handle");
  assert.equal(reponse.versionEnveloppe, 8, "la version publiée est celle de la passe 2");
  assert.notDeepEqual(octets(w.banc, ENVELOPPE), initial, "la page v2 est publiée");
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.ouvert);
});

test("CODE sur une page v1 : l'enveloppe n'est PAS écrite avant le handle, la migration vient après", async () => {
  const { w, code } = await coffreEnV1({ avecCode: true });
  const initial = octets(w.banc, ENVELOPPE);

  const { avantLeHandle, issue } = await deverrouillerEnRetenant(w, messageDeCode(code));

  assert.deepEqual(
    avantLeHandle,
    initial,
    "aucun octet d'enveloppe écrit avant la prise du handle",
  );
  assert.equal(issue.erreur, undefined, String(issue.erreur?.code ?? issue.erreur));
  const reponse = w.reponses.at(-1).corps;
  assert.equal(reponse.enveloppeMigree, true);
  assert.equal(reponse.versionEnveloppe, 8);
  assert.notDeepEqual(octets(w.banc, ENVELOPPE), initial);
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.ouvert);
});

test("une enveloppe en page v2 s'ouvre sans migration, sous la même version", async () => {
  const w = await workerDeverrouillage();
  // Création du coffre par le chemin de production : enveloppe v2 version 1, volume né.
  await w.deverrouiller(await messageDePhrase());
  await w.interne.backend.close();
  w.interne.backend = null;
  w.interne.etat = ETATS_DU_VOLUME.verrouille;
  const avant = octets(w.banc, ENVELOPPE);

  await w.deverrouiller(await messageDePhrase());

  const reponse = w.reponses.at(-1).corps;
  assert.equal(reponse.enveloppeMigree, false);
  assert.equal(reponse.versionEnveloppe, 1);
  assert.deepEqual(octets(w.banc, ENVELOPPE), avant, "ouvrir n'écrit pas une enveloppe v2");
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.ouvert);
});

test("un emplacement RÉVOQUÉ entre l'enveloppe et le handle est refusé : rien d'ouvert, handle rendu", async () => {
  const w = await workerDeverrouillage();
  // Un coffre ouvert par A (phrase), qui imprime un code ; A garde son volume jusqu'à sa fermeture.
  await w.deverrouiller(await messageDePhrase());
  const { creerMoyenDeRecuperation } = await import("../../src/vm/moyen-de-recuperation.mjs");
  const support = supportDe(w.banc, VOLUME);
  const moyen = await creerMoyenDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek: KEK,
  });
  const code = moyen.rendre();
  await w.interne.backend.close(); // A ferme : le volume est libre pour B
  w.interne.backend = null;
  w.interne.etat = ETATS_DU_VOLUME.verrouille;

  // B présente le code, retenu avant le handle ; A révoque pendant ce temps.
  const barrieresAvant = w.interne.barrieres;
  const retenue = w.retenir(VOLUME);
  const issue = w.deverrouiller(messageDeCode(code)).then(
    () => ({}),
    (erreur) => ({ erreur }),
  );
  await retenue.atteint;
  await revoquerToutSauf({ support, identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: KEK });
  retenue.relacher();
  const { erreur } = await issue;

  assert.equal(erreur?.code, ENVELOPPE_ERROR_CODES.cleRefusee);
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.verrouille, "jamais ouvert sous une clé révoquée");
  assert.equal(w.interne.backend, null);
  assert.equal(w.interne.barrieres, barrieresAvant, "le secteur de serrure n'a pas été écrit");
  assert.equal(w.banc.store.isOpen(VOLUME), false, "le handle du volume est rendu");
});

test("un second déverrouillage referme d'abord le volume précédent : un seul handle tenu", async () => {
  const w = await workerDeverrouillage();
  await w.deverrouiller(await messageDePhrase());
  const premier = w.interne.backend;
  // Un second geste sur le même Worker referme d'abord le volume précédent (constat 6 de #167), puis
  // rouvre : le volume reste ouvert une seule fois.
  await w.deverrouiller(await messageDePhrase());
  assert.notEqual(w.interne.backend, premier);
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.ouvert);
});

// --- La CRÉATION du coffre : le même verrou que l'ouverture ---------------------------------------------

const AUTRE_KEK = Uint8Array.from({ length: 32 }, (_, i) => 0x70 + i);
const AUTRE_DEK = Uint8Array.from({ length: 32 }, (_, i) => 0x30 + i);

/** Un onglet qui vient de créer son coffre FERME : le Worker meurt, le handle est libre. */
async function fermer(w) {
  const backend = w.interne.backend;
  w.interne.backend = null;
  w.interne.etat = ETATS_DU_VOLUME.verrouille;
  await backend.close();
}

test("CRÉATION : le handle du volume est pris AVANT l'enveloppe, et c'est LUI que l'ouvreur reçoit", async () => {
  const w = await workerDeverrouillage();

  await w.deverrouiller(await messageDePhrase());

  assert.equal(w.ouvertures[0], VOLUME, "le premier handle pris est celui du volume");
  assert.equal(
    w.ouvertures.filter((nom) => nom === VOLUME).length,
    1,
    "le handle pris est celui que l'ouvreur reçoit : aucun trou entre l'enveloppe et la naissance",
  );
  assert.ok(w.ouvertures.indexOf(ENVELOPPE) > 0, "l'enveloppe est écrite sous ce handle");
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.ouvert);
});

test("CRÉATION entre deux onglets : B retardé APRÈS son constat, A crée et ferme — B est refusé, l'enveloppe de A est intacte, A rouvre", async () => {
  const banc = magasin();
  const b = await workerDeverrouillage({ banc });
  const a = await workerDeverrouillage({ banc });

  // B a constaté « pas d'enveloppe » ; il est retenu à sa première prise de handle.
  const retenue = b.retenir("*");
  const issueB = b.deverrouiller(await messageDePhrase({ kek: AUTRE_KEK })).then(
    () => ({}),
    (erreur) => ({ erreur }),
  );
  await retenue.atteint;

  // A crée son coffre, l'ouvre, puis se verrouille : le handle est libre.
  await a.deverrouiller(await messageDePhrase());
  await fermer(a);
  const enveloppeDeA = octets(banc, ENVELOPPE);
  retenue.relacher();
  const { erreur } = await issueB;

  assert.equal(erreur?.code, ENVELOPPE_ERROR_CODES.presente, String(erreur?.code ?? erreur));
  assert.deepEqual(octets(banc, ENVELOPPE), enveloppeDeA, "l'enveloppe de A n'est pas écrasée");
  assert.equal(b.interne.etat, ETATS_DU_VOLUME.verrouille);
  assert.equal(banc.store.isOpen(VOLUME), false, "B a rendu le handle");

  await a.deverrouiller(await messageDePhrase());
  assert.equal(a.interne.etat, ETATS_DU_VOLUME.ouvert, "A rouvre sous sa propre clé");
});

test("CRÉATION entre deux onglets : A tient encore le volume — B est refusé BUSY, l'enveloppe de A est intacte", async () => {
  const banc = magasin();
  const b = await workerDeverrouillage({ banc });
  const a = await workerDeverrouillage({ banc });

  const retenue = b.retenir("*");
  const issueB = b.deverrouiller(await messageDePhrase({ kek: AUTRE_KEK })).then(
    () => ({}),
    (erreur) => ({ erreur }),
  );
  await retenue.atteint;
  await a.deverrouiller(await messageDePhrase());
  const enveloppeDeA = octets(banc, ENVELOPPE);
  retenue.relacher();
  const { erreur } = await issueB;

  assert.equal(erreur?.code, "VAULT_STORAGE_BUSY", String(erreur?.code ?? erreur));
  assert.deepEqual(octets(banc, ENVELOPPE), enveloppeDeA, "l'enveloppe de A n'est pas écrasée");
  assert.equal(a.interne.etat, ETATS_DU_VOLUME.ouvert, "A est intact");
});

test("une enveloppe v1 REMPLACÉE entre les deux passes — même KEK, autre clé de volume — est refusée sans UNE écriture", async () => {
  const { w } = await coffreEnV1();
  const retenue = w.retenir(VOLUME);
  const issue = w.deverrouiller(await messageDePhrase()).then(
    () => ({}),
    (erreur) => ({ erreur }),
  );
  await retenue.atteint;
  // Même KEK, même identifiant d'emplacement, une AUTRE clé de volume : l'enveloppe d'un autre coffre.
  await poserUneEnveloppeV1(w.banc, { dek: AUTRE_DEK });
  const remplacee = octets(w.banc, ENVELOPPE);
  retenue.relacher();
  const { erreur } = await issue;

  assert.equal(erreur?.code, ENVELOPPE_ERROR_CODES.cleRefusee, String(erreur?.code ?? erreur));
  assert.deepEqual(
    octets(w.banc, ENVELOPPE),
    remplacee,
    "un refus n'écrit rien : la migration ne se joue qu'une fois l'identité confirmée",
  );
  assert.equal(w.interne.etat, ETATS_DU_VOLUME.verrouille);
});

test("CRÉATION : un échec AVANT l'ouvreur rend le verrou pris — jamais un handle orphelin", async () => {
  const w = await workerDeverrouillage();
  // Fermer le volume précédent échoue : `ouvrirLeVolume` lève avant que l'ouvreur ait reçu le verrou.
  w.interne.backend = {
    close: async () => {
      throw Object.assign(new Error("fermeture en échec"), { code: "ECHEC_DE_FERMETURE" });
    },
  };
  const erreur = await w.deverrouiller(await messageDePhrase()).then(
    () => null,
    (e) => e,
  );
  w.interne.backend = null;
  assert.equal(erreur?.code, "ECHEC_DE_FERMETURE");
  assert.equal(w.banc.store.isOpen(VOLUME), false, "le verrou de la création est rendu");
});

// --- La création RECONSTATE l'emplacement sous le verrou (revue de la PR #314, constat 1) ----------------

/** Une restauration INTERROMPUE : le disque est versé, ni manifeste ni enveloppe — le coffre n'est pas né. */
async function restaurationInterrompue(banc) {
  await installerLeDisque(banc);
  // Une restauration RETIRE les voisins du volume qu'elle remplace (journal, témoin, instantané) et
  // n'inscrit le manifeste qu'en dernier : ce qui reste est le disque seul.
  for (const voisin of voisinsDunVolume("application")) await banc.retirer(voisin);
  await banc.retirer(manifestSidecarName("application"));
}

test("CRÉATION face à une restauration INTERROMPUE survenue pendant l'attente du handle : refusée, aucune écriture", async () => {
  const banc = magasin();
  const b = await workerDeverrouillage({ banc });
  // B a constaté un emplacement VIDE, puis attend le handle ; A restaure, s'interrompt avant l'enveloppe.
  const retenue = b.retenir("*");
  const issue = b.deverrouiller(await messageDePhrase({ kek: AUTRE_KEK })).then(
    () => ({}),
    (erreur) => ({ erreur }),
  );
  await retenue.atteint;
  await restaurationInterrompue(banc);
  const disque = octets(banc, "application");
  retenue.relacher();
  const { erreur } = await issue;

  assert.equal(
    erreur?.code,
    CODES_REFUS_COQUILLE.restaurationInterrompue,
    String(erreur?.code ?? erreur),
  );
  assert.equal(banc.store.sizeOf(ENVELOPPE), 0, "aucune enveloppe n'est écrite");
  assert.equal(banc.store.sizeOf(VOLUME), 0, "aucun volume ne naît");
  assert.deepEqual(octets(banc, "application"), disque, "le disque versé est intact");
  assert.equal(banc.store.isOpen(VOLUME), false, "le verrou est rendu");
  assert.equal(b.interne.etat, ETATS_DU_VOLUME.verrouille);
});

test("CRÉATION face au disque d'un AUTRE coffre apparu pendant l'attente : refusée, aucune écriture", async () => {
  const banc = magasin();
  const b = await workerDeverrouillage({ banc });
  const retenue = b.retenir("*");
  const issue = b.deverrouiller(await messageDePhrase({ kek: AUTRE_KEK })).then(
    () => ({}),
    (erreur) => ({ erreur }),
  );
  await retenue.atteint;
  await installerLeDisque(banc);
  // Le manifeste d'un AUTRE volume : le disque n'est pas celui d'un coffre de la coquille.
  const { serializeManifest, parseManifest } = await import("../../src/vm/volume-manifest.mjs");
  const lu = parseManifest(banc.lire(manifestSidecarName("application")));
  const manifeste = { ...lu, volume: { ...lu.volume, id: "ff".repeat(16) } };
  await banc.ecrire(manifestSidecarName("application"), serializeManifest(manifeste));
  retenue.relacher();
  const { erreur } = await issue;

  assert.equal(
    erreur?.code,
    CODES_REFUS_COQUILLE.disqueDUnAutreCoffre,
    String(erreur?.code ?? erreur),
  );
  assert.equal(banc.store.sizeOf(ENVELOPPE), 0);
  assert.equal(banc.store.isOpen(VOLUME), false);
});

test("CRÉATION : la clé de volume tirée est EFFACÉE quand la prise du handle est rejetée", async () => {
  const w = await workerDeverrouillage();
  // La clé de volume est tirée par `crypto.getRandomValues` : c'est le tampon qu'on retient.
  const vrai = crypto.getRandomValues.bind(crypto);
  const tirages = [];
  crypto.getRandomValues = (tampon) => {
    const rendu = vrai(tampon);
    if (rendu instanceof Uint8Array && rendu.length === 32) tirages.push(rendu);
    return rendu;
  };
  // Un autre détenteur tient déjà le volume : la prise du handle est rejetée.
  const autre = await w.banc.store.openHandle(VOLUME);
  let erreur;
  try {
    erreur = await w.deverrouiller(await messageDePhrase()).then(
      () => null,
      (e) => e,
    );
  } finally {
    crypto.getRandomValues = vrai;
    autre.close();
  }
  assert.equal(erreur?.code, "VAULT_STORAGE_BUSY", String(erreur?.code ?? erreur));
  const cle = tirages.find((t) => t.length === 32 && t.every((o) => o === 0));
  assert.ok(cle, "une clé de 32 octets a été tirée puis effacée");
  assert.equal(
    tirages.filter((t) => t.some((o) => o !== 0)).length,
    0,
    "aucun tirage de 32 octets ne reste en clair dans le tas",
  );
});

test("CRÉATION face à un disque INSTALLÉ sans enveloppe, apparu pendant l'attente : refusée — jamais une clé neuve pour un disque existant", async () => {
  const banc = magasin();
  const b = await workerDeverrouillage({ banc });
  const retenue = b.retenir("*");
  const issue = b.deverrouiller(await messageDePhrase({ kek: AUTRE_KEK })).then(
    () => ({}),
    (erreur) => ({ erreur }),
  );
  await retenue.atteint;
  await installerLeDisque(banc); // manifeste valide, aucune enveloppe : un « coffre » sans serrure
  const disque = octets(banc, "application");
  retenue.relacher();
  const { erreur } = await issue;

  assert.equal(
    erreur?.code,
    CODES_REFUS_COQUILLE.emplacementOccupe,
    String(erreur?.code ?? erreur),
  );
  assert.equal(banc.store.sizeOf(ENVELOPPE), 0, "aucune enveloppe neuve pour ce disque");
  assert.deepEqual(octets(banc, "application"), disque);
  assert.equal(banc.store.isOpen(VOLUME), false);
});
