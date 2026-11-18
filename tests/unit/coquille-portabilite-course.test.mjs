/**
 * LA RESTAURATION ET LA COURSE ENTRE ONGLETS (#311, C5 ; revue de sécurité de la PR #314, constat 1).
 *
 * `public/portabilite-du-worker.mjs` est chargé tel qu'il est servi (crochet de résolution de
 * `coquille-portabilite-du-worker.test.mjs`), sur le magasin en mémoire et les modules réels de
 * `src/vm/`. Le POINT D'ARRÊT est le pendant exact de celui des navigateurs : la première prise de
 * handle du Worker de B s'arrête, jusqu'à ce que l'épreuve la relâche.
 *
 * Ce qu'elles établissent : une restauration admise sur un emplacement vide, suspendue, ne peut pas
 * reprendre après qu'un autre onglet a CRÉÉ son coffre et écraser son enveloppe. La restauration prend
 * l'exclusion du volume `coquille` — le verrou de l'ouverture — AVANT d'écrire `coquille.cles`, revalide
 * sous ce verrou que l'emplacement est toujours vide, et ne le relâche qu'après.
 */

import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

registerHooks({
  resolve(specifier, context, suivant) {
    if (specifier.startsWith("/src/")) {
      return suivant(pathToFileURL(join(RACINE, specifier)).href, context);
    }
    return suivant(specifier, context);
  },
});

const { brancherLaPortabilite, ouvrirLeDisque } =
  await import("../../public/portabilite-du-worker.mjs");
const { TYPES_PRIVILEGIES } = await import("../../src/coquille/contrat-de-messages.mjs");
const { CODES_REFUS_COQUILLE } = await import("../../src/coquille/refus-de-coquille.mjs");
const { ETATS_DU_VOLUME } = await import("../../src/coquille/etat-de-la-coquille.mjs");
const { ETATS_DE_L_EMPLACEMENT, constaterLEmplacement } =
  await import("../../src/coquille/portabilite-du-coffre.mjs");
const { IDENTIFIANT_DU_COFFRE, IDENTIFIANT_DU_VOLUME_COQUILLE } =
  await import("../../src/coquille/identites-du-coffre.mjs");
const { derivateurRecuperation } =
  await import("../../src/vm/derivation/derivateur-recuperation.mjs");
const { inventorierEnveloppe, ouvrirEnveloppe } = await import("../../src/vm/enveloppe-de-cle.mjs");
const { TYPES_KEK } = await import("../../src/vm/enveloppe/identite-enveloppe.mjs");
const { openOpfsVolume } = await import("../../src/vm/opfs-block-backend.mjs");
const { STORAGE_ERROR_CODES } = await import("../../src/vm/storage-errors.mjs");
const { SECTOR_SIZE } = await import("../../src/vm/block-geometry.mjs");
const {
  DEK,
  KEK,
  installerLeDisque,
  magasin,
  poserLEnveloppe,
  poserLeVolumeCoquille,
  primitivesDe,
  supportDe,
} = await import("./support-coffre-de-la-coquille.mjs");

const VOLUME = "coquille";
const ENVELOPPE = "coquille.cles";
const octets = (banc, nom) => Buffer.from(banc.store.snapshot(nom));

/**
 * Un banc dont la PREMIÈRE prise de handle, une fois armé, s'arrête jusqu'à `relacher()`. Il ne
 * retient que le Worker de B : celui de A écrit sur le banc d'origine, sans point d'arrêt.
 */
function bancRetenu(banc) {
  let retenue = null;
  const openHandle = async (nom) => {
    if (retenue !== null) {
      const courante = retenue;
      retenue = null;
      courante.signaler(nom);
      await courante.promesse;
    }
    return banc.store.openHandle(nom);
  };
  return {
    banc: { ...banc, store: { ...banc.store, openHandle } },
    retenir() {
      let relacher;
      let signaler;
      const promesse = new Promise((fin) => {
        relacher = fin;
      });
      const atteint = new Promise((fin) => {
        signaler = fin;
      });
      retenue = { promesse, signaler };
      return { atteint, relacher };
    },
  };
}

/** Un Worker de confiance réduit à ce que le module emploie, sur ce banc. */
function workerSur(banc, { etat = ETATS_DU_VOLUME.verrouille, kek = null } = {}) {
  const reponses = [];
  const interne = { etat, kek, application: null, barrieres: 0, version: null, revocation: null };
  const portabilite = brancherLaPortabilite({
    interne,
    support: () => supportDe(banc, VOLUME),
    cleDeVolume: async () => DEK.slice(),
    enBattant: (_correlation, geste) => geste(),
    repondre: (type, correlation, corps) => reponses.push({ type, correlation, corps }),
    repondreAvecArchive: (type, correlation, corps) => reponses.push({ type, correlation, corps }),
    arreterLApplication: async () => {},
    oublierLeMoyenRetenu: () => {},
    exigerUnVolumeAtteignable: () => {},
    primitives: primitivesDe(banc, { ouvrirLeDisque }),
  });
  return { portabilite, interne, reponses };
}

/** L'archive d'un coffre complet, avec SA récupération : ce que B veut restaurer. */
async function archiveDeB() {
  const source = magasin();
  await installerLeDisque(source);
  const { code } = await poserLEnveloppe(source);
  await poserLeVolumeCoquille(source, IDENTIFIANT_DU_VOLUME_COQUILLE);
  const worker = workerSur(source, { etat: ETATS_DU_VOLUME.ouvert, kek: KEK });
  await worker.portabilite.servir(TYPES_PRIVILEGIES.sauvegarder, {}, "s");
  return { archive: worker.reponses.at(-1).corps.archive, code };
}

/** La KEK que ce CODE dérive sur l'enveloppe de ce magasin. */
async function kekDuCode(banc, code) {
  const inventaire = await inventorierEnveloppe({
    support: supportDe(banc, VOLUME),
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
  });
  const emplacement = inventaire.emplacements.find((e) => e.typeKek === TYPES_KEK.recuperation);
  return derivateurRecuperation().deriver({
    parametres: emplacement.parametres,
    identite: {
      identifiantVolume: IDENTIFIANT_DU_COFFRE,
      identifiantEmplacement: emplacement.identifiantEmplacement,
    },
    geste: { code },
  });
}

/** Le code de A ouvre-t-il ENCORE l'enveloppe de ce magasin ? */
async function leCodeOuvre(banc, code) {
  try {
    await ouvrirEnveloppe({
      support: supportDe(banc, VOLUME),
      identifiantVolume: IDENTIFIANT_DU_COFFRE,
      kek: await kekDuCode(banc, code),
    });
    return true;
  } catch {
    return false;
  }
}

/** B restaure ; il est retenu à sa première prise de handle. Rend de quoi dérouler la course. */
async function restaurationRetenue() {
  const { archive } = await archiveDeB();
  const emplacement = magasin(); // vide : B y est admis
  const retenu = bancRetenu(emplacement);
  const b = workerSur(retenu.banc);
  const retenue = retenu.retenir();
  const issue = b.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive }, "r").then(
    () => ({}),
    (erreur) => ({ erreur }),
  );
  await retenue.atteint;
  return { emplacement, retenue, issue, b };
}

/** A crée son coffre sur l'emplacement — enveloppe, récupération, petit volume — et rend son code. */
async function aCreeSonCoffre(emplacement) {
  const { code } = await poserLEnveloppe(emplacement);
  await poserLeVolumeCoquille(emplacement, IDENTIFIANT_DU_VOLUME_COQUILLE);
  return code;
}

test("RESTAURATION : B suspendu après son constat, A crée et ferme — B est refusé, l'enveloppe de A est intacte, son code ouvre", async () => {
  const { emplacement, retenue, issue } = await restaurationRetenue();
  const codeDeA = await aCreeSonCoffre(emplacement);
  const enveloppeDeA = octets(emplacement, ENVELOPPE);

  retenue.relacher();
  const { erreur } = await issue;

  assert.equal(
    erreur?.code,
    CODES_REFUS_COQUILLE.emplacementOccupe,
    String(erreur?.code ?? erreur),
  );
  assert.deepEqual(octets(emplacement, ENVELOPPE), enveloppeDeA, "l'enveloppe de A est intacte");
  assert.equal(
    await leCodeOuvre(emplacement, codeDeA),
    true,
    "le code antérieur de A ouvre encore",
  );
  assert.equal((await emplacement.stat("application")).present, false, "aucun disque n'est versé");
  assert.equal(emplacement.store.isOpen(VOLUME), false, "B a rendu le handle");
});

test("RESTAURATION : B suspendu, A tient encore son volume — B est refusé BUSY, l'enveloppe de A est intacte", async () => {
  const { emplacement, retenue, issue } = await restaurationRetenue();
  const codeDeA = await aCreeSonCoffre(emplacement);
  // A OUVERT : il tient le handle du petit volume.
  const tenu = await openOpfsVolume({
    name: VOLUME,
    size: 32 * SECTOR_SIZE,
    cle: DEK,
    identifiantVolume: IDENTIFIANT_DU_VOLUME_COQUILLE,
    openHandle: emplacement.store.openHandle,
    transactionnel: false,
  });
  try {
    const enveloppeDeA = octets(emplacement, ENVELOPPE);
    retenue.relacher();
    const { erreur } = await issue;

    assert.equal(erreur?.code, STORAGE_ERROR_CODES.busy, String(erreur?.code ?? erreur));
    assert.deepEqual(octets(emplacement, ENVELOPPE), enveloppeDeA);
    assert.equal(await leCodeOuvre(emplacement, codeDeA), true);
    assert.equal((await emplacement.stat("application")).present, false);
  } finally {
    await tenu.close();
  }
});

test("RESTAURATION : sans course, elle réussit — et laisse le volume `coquille` libre pour la première ouverture", async () => {
  const { archive, code } = await archiveDeB();
  const emplacement = magasin();
  const b = workerSur(emplacement);

  await b.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive }, "r");

  assert.equal(b.reponses.at(-1).corps.restauree, true);
  assert.equal(emplacement.store.isOpen(VOLUME), false, "le verrou est relâché après l'import");
  assert.equal(await leCodeOuvre(emplacement, code), true, "l'enveloppe de l'archive est posée");
  assert.equal(
    await b.portabilite.constater(),
    ETATS_DE_L_EMPLACEMENT.coffre,
    "un fichier `coquille` vide que le verrou a pu créer n'est pas un volume",
  );
});

test("un fichier `coquille` de taille NULLE n'est pas un volume : l'emplacement est vide", async () => {
  // `openOpfsSyncAccess` CRÉE le fichier qu'il ouvre : tout verrou pris avant la naissance du volume,
  // ou tout échec d'une ouverture, en laisse un vide. Le compter pour un volume ferait lire une
  // restauration interrompue — et refuser la création — là où il n'y a rien.
  const present = { present: true, size: 0 };
  const absent = { present: false, size: 0 };
  const etat = await constaterLEmplacement({
    observer: async (nom) => (nom === VOLUME ? present : absent),
    lireEnTete: async () => new Uint8Array(0),
    lireVoisin: async () => null,
  });
  assert.equal(etat, ETATS_DE_L_EMPLACEMENT.vide);
});

test("RÉPARATION : un volume `coquille` résiduel est VIDÉ par son handle, puis la restauration aboutit", async () => {
  const { archive, code } = await archiveDeB();
  // Un résidu : le petit volume existe, sans enveloppe ni disque — ce qu'une création coupée laisse.
  const emplacement = magasin();
  await poserLeVolumeCoquille(emplacement, IDENTIFIANT_DU_VOLUME_COQUILLE);
  assert.ok(emplacement.store.sizeOf(VOLUME) > 0);
  const b = workerSur(emplacement);
  assert.equal(await b.portabilite.constater(), ETATS_DE_L_EMPLACEMENT.restaurationInterrompue);

  await b.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive }, "r");

  assert.equal(b.reponses.at(-1).corps.reparee, true);
  assert.equal(emplacement.store.sizeOf(VOLUME), 0, "le résidu est vidé : il naîtra neuf");
  assert.equal(emplacement.store.isOpen(VOLUME), false);
  assert.equal(await leCodeOuvre(emplacement, code), true);
  assert.equal(await b.portabilite.constater(), ETATS_DE_L_EMPLACEMENT.coffre);
});
