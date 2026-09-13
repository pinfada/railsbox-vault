/**
 * SAUVEGARDER, RESTAURER, RÉVOQUER EN URGENCE — le module du Worker de confiance, TEL QU'IL EST
 * SERVI, sur un magasin en mémoire (#207, ADR 0039).
 *
 * `public/portabilite-du-worker.mjs` est chargé sous Node par le crochet de résolution de
 * `coquille-relais-du-worker.test.mjs` ; seules ses primitives de SUPPORT sont remplacées, par un
 * magasin où les modules réels de `src/vm/` écrivent et relisent. Ce que ces épreuves ne mesurent
 * pas — l'OPFS, le clonage d'un `File` par `postMessage`, la CSP — relève de
 * `tests/browser/coquille-portabilite.spec.mjs` et du scénario de bout en bout.
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
const { IDENTIFIANT_DU_COFFRE, IDENTIFIANT_DU_VOLUME_COQUILLE } =
  await import("../../src/coquille/identites-du-coffre.mjs");
const { ARCHIVE_ERROR_CODES } = await import("../../src/vm/archive-errors.mjs");
const { SECTOR_SIZE } = await import("../../src/vm/block-geometry.mjs");
const { derivateurRecuperation } =
  await import("../../src/vm/derivation/derivateur-recuperation.mjs");
const { ajouterEmplacement, inventorierEnveloppe, ouvrirEnveloppe } =
  await import("../../src/vm/enveloppe-de-cle.mjs");
const { TYPES_KEK } = await import("../../src/vm/enveloppe/identite-enveloppe.mjs");
const { openOpfsVolume } = await import("../../src/vm/opfs-block-backend.mjs");
const { suiteDOctets } = await import("./support-enveloppe-double.mjs");
const {
  KEK,
  MOTIF_DE_RAILS,
  OCTETS_DU_DISQUE,
  installerLeDisque,
  magasin,
  poserLEnveloppe,
  poserLeVolumeCoquille,
  primitivesDe,
  supportDe,
} = await import("./support-coffre-de-la-coquille.mjs");

/** Un Worker de confiance réduit à ce que le module emploie : son état, ses réponses. */
function workerSur(banc, { etat = ETATS_DU_VOLUME.ouvert, kek = KEK, application = null } = {}) {
  const reponses = [];
  const interne = {
    etat,
    kek,
    application,
    barrieres: 0,
    version: null,
    revocation: null,
  };
  const arrets = [];
  const portabilite = brancherLaPortabilite({
    interne,
    support: () => supportDe(banc, "coquille"),
    cleDeVolume: async () => (await import("./support-coffre-de-la-coquille.mjs")).DEK.slice(),
    enBattant: (_correlation, geste) => geste(),
    repondre: (type, correlation, corps) => reponses.push({ type, correlation, corps }),
    repondreAvecArchive: (type, correlation, corps) => reponses.push({ type, correlation, corps }),
    arreterLApplication: async () => {
      arrets.push("arret");
      interne.application = null;
    },
    oublierLeMoyenRetenu: () => {},
    exigerUnVolumeAtteignable: () => {},
    primitives: primitivesDe(banc, { ouvrirLeDisque }),
  });
  return { portabilite, interne, reponses, arrets };
}

/** Un coffre complet de cette version, ouvert : disque, enveloppe, récupération, petit volume. */
async function coffreOuvert() {
  const banc = magasin();
  await installerLeDisque(banc);
  const { code } = await poserLEnveloppe(banc);
  await poserLeVolumeCoquille(banc, IDENTIFIANT_DU_VOLUME_COQUILLE);
  return { banc, code };
}

async function sauvegarde(worker) {
  await worker.portabilite.servir(TYPES_PRIVILEGIES.sauvegarder, {}, "c1");
  return worker.reponses.at(-1).corps;
}

async function echec(promesse) {
  return promesse.then(
    () => assert.fail("le geste devait être refusé"),
    (erreur) => erreur,
  );
}

/** Ouvre le disque restauré PAR LE CODE, et rend un secteur relu. */
async function relireParLeCode(banc, code) {
  const support = supportDe(banc, "coquille");
  const inventaire = await inventorierEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
  });
  const emplacement = inventaire.emplacements.find((e) => e.typeKek === TYPES_KEK.recuperation);
  const kek = await derivateurRecuperation().deriver({
    parametres: emplacement.parametres,
    identite: {
      identifiantVolume: IDENTIFIANT_DU_COFFRE,
      identifiantEmplacement: emplacement.identifiantEmplacement,
    },
    geste: { code },
  });
  const ouverte = await ouvrirEnveloppe({ support, identifiantVolume: IDENTIFIANT_DU_COFFRE, kek });
  const backend = await openOpfsVolume({
    name: "application",
    size: OCTETS_DU_DISQUE,
    cle: ouverte.dek,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    openHandle: banc.store.openHandle,
  });
  try {
    return await backend.read(5 * SECTOR_SIZE, SECTOR_SIZE);
  } finally {
    await backend.close();
  }
}

test("SAUVEGARDER rend un File, sa taille, son empreinte et la cohérence déclarée", async () => {
  const { banc } = await coffreOuvert();
  const worker = workerSur(banc, { application: { fermer: async () => null } });
  const rendu = await sauvegarde(worker);

  assert.equal(worker.reponses.at(-1).type, TYPES_PRIVILEGIES.sauvegarderReponse);
  assert.equal(rendu.archive.constructor.name, "File");
  assert.equal(rendu.archive.size, rendu.taille);
  assert.match(rendu.empreinte, /^[0-9a-f]{64}$/);
  assert.equal(rendu.coherence.kind, "handle-exclusif");
  assert.equal(rendu.recuperationEmportee, true);
  // Le point de contrôle : l'application tournait, elle a été arrêtée AVANT la lecture.
  assert.equal(rendu.applicationArretee, true);
  assert.deepEqual(worker.arrets, ["arret"]);
});

test("SAUVEGARDER puis RESTAURER ailleurs : le disque de Rails se relit, ouvert par le CODE", async () => {
  const { banc, code } = await coffreOuvert();
  const rendu = await sauvegarde(workerSur(banc));

  const ailleurs = magasin();
  const destination = workerSur(ailleurs, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
  await destination.portabilite.servir(
    TYPES_PRIVILEGIES.restaurer,
    { archive: rendu.archive },
    "r1",
  );
  const restauree = destination.reponses.at(-1);

  assert.equal(restauree.type, TYPES_PRIVILEGIES.restaurerReponse);
  assert.equal(restauree.corps.restauree, true);
  assert.equal(restauree.corps.reparee, false);
  assert.equal(restauree.corps.empreinte, restauree.corps.empreinteRelue);
  assert.equal(restauree.corps.etat, ETATS_DU_VOLUME.verrouille);
  assert.equal(restauree.corps.volumeCoquille, "a-naitre");
  // L'enveloppe est posée LÀ OÙ le Worker la lit, et nulle part à côté du disque.
  assert.equal((await ailleurs.stat("coquille.cles")).present, true);
  assert.equal((await ailleurs.stat("application.cles")).present, false);

  const secteur = await relireParLeCode(ailleurs, code);
  assert.ok(
    secteur.every((octet) => octet === MOTIF_DE_RAILS),
    "le disque restauré ne relit pas Rails",
  );
});

test("une archive ALTÉRÉE et une archive TRONQUÉE sont refusées, chacune sous son code, sans rien écrire", async () => {
  const { banc } = await coffreOuvert();
  const rendu = await sauvegarde(workerSur(banc));
  const octets = new Uint8Array(await rendu.archive.arrayBuffer());

  const alteree = octets.slice();
  // Un octet du CONTENU, juste après l'en-tête JSON : la page de récupération, en queue, reste intacte.
  const debutDuContenu = 12 + new DataView(octets.buffer).getUint32(8, false);
  alteree[debutDuContenu + 100] ^= 0x01;
  const tronquee = octets.slice(0, octets.byteLength - 512);

  for (const [fichier, code] of [
    [new File([alteree], "a"), ARCHIVE_ERROR_CODES.digestMismatch],
    [new File([tronquee], "t"), ARCHIVE_ERROR_CODES.truncated],
  ]) {
    const ailleurs = magasin();
    const destination = workerSur(ailleurs, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
    const erreur = await echec(
      destination.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive: fichier }, "r"),
    );
    assert.equal(erreur.code, code);
    for (const nom of ["application", "application.manifest", "coquille.cles"]) {
      assert.equal((await ailleurs.stat(nom)).present, false, `${nom} a été écrit malgré le refus`);
    }
  }
});

test("on ne restaure JAMAIS par-dessus un coffre, ouvert ou non", async () => {
  const { banc } = await coffreOuvert();
  const rendu = await sauvegarde(workerSur(banc));

  const ouvert = workerSur(banc);
  const surOuvert = await echec(
    ouvert.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive: rendu.archive }, "r"),
  );
  assert.equal(surOuvert.code, CODES_REFUS_COQUILLE.emplacementOccupe);

  const verrouille = workerSur(banc, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
  const surVerrouille = await echec(
    verrouille.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive: rendu.archive }, "r"),
  );
  assert.equal(surVerrouille.code, CODES_REFUS_COQUILLE.emplacementOccupe);
});

test("une restauration COUPÉE avant le manifeste se RÉPARE par le même geste", async () => {
  const { banc, code } = await coffreOuvert();
  const rendu = await sauvegarde(workerSur(banc));

  const ailleurs = magasin();
  const premiere = workerSur(ailleurs, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
  await premiere.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive: rendu.archive }, "r1");
  // La coupure : le manifeste n'a jamais été inscrit.
  await ailleurs.retirer("application.manifest");
  assert.equal(
    await premiere.portabilite.constater(),
    "restauration-interrompue",
    "une page de récupération à côté d'un disque sans manifeste est une restauration coupée",
  );

  const reprise = workerSur(ailleurs, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
  await reprise.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive: rendu.archive }, "r2");
  assert.equal(reprise.reponses.at(-1).corps.reparee, true);
  const secteur = await relireParLeCode(ailleurs, code);
  assert.ok(secteur.every((octet) => octet === MOTIF_DE_RAILS));
});

test("une archive SANS récupération est refusée AVANT toute écriture, et la sauvegarde le dit", async () => {
  const banc = magasin();
  await installerLeDisque(banc);
  await poserLEnveloppe(banc, { avecRecuperation: false });
  await poserLeVolumeCoquille(banc, IDENTIFIANT_DU_VOLUME_COQUILLE);
  const rendu = await sauvegarde(workerSur(banc));
  // La sauvegarde ne refuse pas : elle DIT qu'elle n'emporte rien.
  assert.equal(rendu.recuperationEmportee, false);

  const ailleurs = magasin();
  const destination = workerSur(ailleurs, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
  const erreur = await echec(
    destination.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive: rendu.archive }, "r"),
  );
  assert.equal(erreur.code, CODES_REFUS_COQUILLE.archiveSansRecuperation);
  assert.equal((await ailleurs.stat("application")).present, false);
});

test("SAUVEGARDER exige un coffre ouvert ET une application installée", async () => {
  const { banc } = await coffreOuvert();
  const verrouille = workerSur(banc, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
  assert.equal(
    (await echec(verrouille.portabilite.servir(TYPES_PRIVILEGIES.sauvegarder, {}, "s"))).code,
    CODES_REFUS_COQUILLE.volumeVerrouille,
  );

  const sansDisque = magasin();
  await poserLEnveloppe(sansDisque);
  const vide = workerSur(sansDisque);
  assert.equal(
    (await echec(vide.portabilite.servir(TYPES_PRIVILEGIES.sauvegarder, {}, "s"))).code,
    CODES_REFUS_COQUILLE.applicationNonInstallee,
  );
});

test("RÉVOQUER EN URGENCE garde l'emplacement qui a ouvert, et dit ce qui a été retiré", async () => {
  const { banc } = await coffreOuvert();
  const autreKek = suiteDOctets(0x40, 32);
  await ajouterEmplacement({
    support: supportDe(banc, "coquille"),
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek: KEK,
    kekNouvelle: autreKek,
  });
  const worker = workerSur(banc);
  await worker.portabilite.servir(TYPES_PRIVILEGIES.revoquerEnUrgence, {}, "v1");
  const bilan = worker.reponses.at(-1).corps;

  assert.equal(worker.reponses.at(-1).type, TYPES_PRIVILEGIES.revoquerEnUrgenceReponse);
  assert.equal(bilan.nombreRetires, 2);
  assert.equal(bilan.nombreRestants, 1);
  assert.equal(bilan.retires.recuperation, 1);
  const publie = Object.fromEntries(
    Object.entries(bilan).filter(([champ]) => champ !== "etat" && champ !== "barrieres"),
  );
  assert.deepEqual(worker.interne.revocation, publie);
  assert.equal(worker.interne.version, bilan.versionEnveloppe);
  // Aucun identifiant d'emplacement, aucun octet : des noms et des nombres.
  assert.doesNotMatch(JSON.stringify(bilan), /[0-9a-f]{32}/);

  // La KEK retirée n'ouvre plus rien ; celle de la session ouvre encore.
  const support = supportDe(banc, "coquille");
  await assert.rejects(
    ouvrirEnveloppe({ support, identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: autreKek }),
  );
  await ouvrirEnveloppe({ support, identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: KEK });
});

test("un geste de portabilité arrivé pendant un geste LONG est refusé, jamais mis en attente", async () => {
  const { portabilite } = workerSur(magasin());
  assert.equal(portabilite.refusALArrivee(TYPES_PRIVILEGIES.revoquerEnUrgence), null);
  const sortir = portabilite.entrer(TYPES_PRIVILEGIES.application);
  for (const type of [
    TYPES_PRIVILEGIES.revoquerEnUrgence,
    TYPES_PRIVILEGIES.sauvegarder,
    TYPES_PRIVILEGIES.restaurer,
  ]) {
    assert.equal(portabilite.refusALArrivee(type), CODES_REFUS_COQUILLE.gesteEnCours);
  }
  // Un geste qui n'est pas de portabilité n'est pas concerné : le verrouillage a sa propre garde.
  assert.equal(portabilite.refusALArrivee(TYPES_PRIVILEGIES.fermeture), null);
  sortir();
  assert.equal(portabilite.refusALArrivee(TYPES_PRIVILEGIES.revoquerEnUrgence), null);
});

test("un coffre ANTÉRIEUR est refusé par la sauvegarde comme par la restauration", async () => {
  const banc = magasin();
  await poserLEnveloppe(banc);
  await poserLeVolumeCoquille(banc, IDENTIFIANT_DU_COFFRE);
  const worker = workerSur(banc);
  assert.equal(await worker.portabilite.constater(), "anterieur");
  assert.equal(
    (await echec(worker.portabilite.servir(TYPES_PRIVILEGIES.sauvegarder, {}, "s"))).code,
    CODES_REFUS_COQUILLE.coffreAnterieur,
  );
  const verrouille = workerSur(banc, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
  const archive = new File([new Uint8Array(16)], "x");
  assert.equal(
    (await echec(verrouille.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive }, "r")))
      .code,
    CODES_REFUS_COQUILLE.coffreAnterieur,
  );
});
