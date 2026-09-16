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
const { FICHIER_DE_SAUVEGARDE } = await import("../../src/coquille/portabilite-du-coffre.mjs");
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
const { voisinsDunVolume } = await import("../../src/vm/opfs-sync-access.mjs");
const { construireEnveloppeDeRecuperation } =
  await import("../../src/vm/enveloppe-de-recuperation.mjs");
const { ouvrirVolumeBrut } = await import("../../src/vm/opfs-volume-brut.mjs");
const { createOpfsArchiveSink } = await import("../../src/vm/opfs-archive-sink.mjs");
const { backendSource, writeArchive } = await import("../../src/vm/volume-export.mjs");
const A = await import("./support-archive-recuperation.mjs");
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
function workerSur(
  banc,
  { etat = ETATS_DU_VOLUME.ouvert, kek = KEK, application = null, primitives = null } = {},
) {
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
    primitives: primitives ?? primitivesDe(banc, { ouvrirLeDisque }),
  });
  return { portabilite, interne, reponses, arrets };
}

/** Une COUPURE : ce qu'une fermeture d'onglet fait d'un geste, au rang choisi. */
function coupure() {
  return Object.assign(new Error("COUPURE"), { code: "COUPURE" });
}

/**
 * Les primitives du banc, dont `retirer` suit l'ordre du support réel (`removeOpfsVolume` : les
 * voisins, puis le volume) et se COUPE au `rang`-ième fichier retiré.
 */
function primitivesCoupeesAuRetrait(banc, rang) {
  const base = primitivesDe(banc, { ouvrirLeDisque });
  let retraits = 0;
  return {
    ...base,
    async retirer(nom) {
      for (const fichier of [...voisinsDunVolume(nom), nom]) {
        retraits += 1;
        if (retraits === rang) throw coupure();
        await banc.retirer(fichier);
      }
    },
  };
}

/** Une restauration réelle, COUPÉE juste avant le manifeste : l'état que la réparation reprend. */
async function restaurationCoupeeAvantLeManifeste(banc, archive) {
  const base = primitivesDe(banc, { ouvrirLeDisque });
  const primitives = {
    ...base,
    cibleDImport: (nom) => ({
      ...base.cibleDImport(nom),
      commitManifest: async () => {
        throw coupure();
      },
    }),
  };
  const worker = workerSur(banc, { etat: ETATS_DU_VOLUME.verrouille, kek: null, primitives });
  const erreur = await echec(
    worker.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive }, "coupee"),
  );
  assert.equal(erreur.code, "COUPURE");
  assert.equal(await worker.portabilite.constater(), "restauration-interrompue");
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

/** La KEK que le CODE dérive, sur l'enveloppe que ce magasin porte. */
async function kekDuCode(banc, code) {
  const inventaire = await inventorierEnveloppe({
    support: supportDe(banc, "coquille"),
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

/** Ouvre le disque restauré PAR LE CODE, et rend un secteur relu. */
async function relireParLeCode(banc, code) {
  const support = supportDe(banc, "coquille");
  const kek = await kekDuCode(banc, code);
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

test("une RÉPARATION coupée à CHAQUE rang ne laisse jamais un coffre sans disque, et le même geste la reprend", async () => {
  // Revue de la PR #208, constat 3 : la réparation retirait `application` puis `coquille`. Coupée
  // entre les deux, elle laissait l'enveloppe du domaine `recuperation` SANS disque — un « coffre »
  // que le code ouvrait, et sur lequel la restauration était ensuite refusée.
  const { banc, code } = await coffreOuvert();
  const { archive } = await sauvegarde(workerSur(banc));
  let rangsCoupes = 0;

  for (let rang = 1; rang < 100; rang += 1) {
    const ailleurs = magasin();
    await restaurationCoupeeAvantLeManifeste(ailleurs, archive);
    const reparation = workerSur(ailleurs, {
      etat: ETATS_DU_VOLUME.verrouille,
      kek: null,
      primitives: primitivesCoupeesAuRetrait(ailleurs, rang),
    });
    const erreur = await reparation.portabilite
      .servir(TYPES_PRIVILEGIES.restaurer, { archive }, `r${rang}`)
      .then(
        () => null,
        (e) => e,
      );
    if (erreur === null) break;
    rangsCoupes += 1;
    assert.equal(erreur.code, "COUPURE");

    const etat = await reparation.portabilite.constater();
    assert.ok(
      etat === "restauration-interrompue" || etat === "vide",
      `rang ${rang} : la réparation coupée laisse l'état « ${etat} »`,
    );
    const reprise = workerSur(ailleurs, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
    await reprise.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive }, `reprise${rang}`);
    assert.equal(reprise.reponses.at(-1).corps.restauree, true, `rang ${rang}`);
    const secteur = await relireParLeCode(ailleurs, code);
    assert.ok(
      secteur.every((octet) => octet === MOTIF_DE_RAILS),
      `rang ${rang} : le disque repris ne relit pas Rails`,
    );
  }
  // Deux volumes, chacun avec ses cinq voisins : douze retraits, chacun coupé une fois.
  assert.equal(rangsCoupes, 2 * (1 + voisinsDunVolume("application").length));
});

/**
 * Une archive COHÉRENTE d'un AUTRE volume : identifiant tiré, sa propre page de récupération. Toutes
 * les gardes de `importArchive` l'acceptent — c'est l'identité du COFFRE qu'elle ne porte pas.
 */
async function archiveDUnAutreVolume() {
  const source = A.magasin();
  const pose = await A.poserVolume(source, { nom: "etranger", identifiantVolume: A.VOLUME_A });
  const recovery = await construireEnveloppeDeRecuperation({
    support: pose.support,
    identifiantVolume: A.VOLUME_A,
    kek: A.KEK,
  });
  const brut = await ouvrirVolumeBrut({ name: "etranger", openHandle: source.store.openHandle });
  const handle = await source.store.openHandle("sortie");
  try {
    await writeArchive({
      source: backendSource(brut),
      sink: createOpfsArchiveSink(handle, { volume: "sortie" }),
      manifest: A.descripteurDeManifeste(A.VOLUME_A),
      consistency: { kind: "handle-exclusif", detail: "épreuve" },
      cle: A.DEK.slice(),
      recovery,
    });
    handle.flush();
  } finally {
    handle.close();
    await brut.close();
  }
  return new File([source.store.snapshot("sortie")], "etranger.rbvault");
}

test("une archive d'un AUTRE coffre est refusée AVANT tout octet écrit, et l'emplacement reste vide", async () => {
  // Revue de la PR #208, constat 5 : elle était « restaurée », puis l'emplacement était muré sous
  // `VAULT_COQUILLE_COFFRE_ANTERIEUR`, dont la conduite ne décrivait pas la cause.
  const archive = await archiveDUnAutreVolume();
  const ailleurs = magasin();
  const destination = workerSur(ailleurs, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
  const erreur = await echec(
    destination.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive }, "r"),
  );
  assert.equal(erreur.code, "VAULT_COQUILLE_ARCHIVE_D_UN_AUTRE_COFFRE");
  for (const nom of [
    "application",
    "application.manifest",
    "application.engagement",
    "coquille.cles",
  ]) {
    assert.equal((await ailleurs.stat(nom)).present, false, `${nom} a été écrit malgré le refus`);
  }
  assert.equal(await destination.portabilite.constater(), "vide");
  assert.equal(destination.reponses.length, 0, "aucune réponse de restauration");
});

test("un coffre restauré, SERVI, dont le manifeste se perd n'est jamais réparé : ses écritures survivent", async () => {
  // Revue de la PR #208, constat 6 : il était pris pour une restauration coupée, et « le même
  // geste » effaçait tout ce qui avait été écrit depuis la restauration.
  const { banc, code } = await coffreOuvert();
  const { archive } = await sauvegarde(workerSur(banc));
  const ailleurs = magasin();
  const premiere = workerSur(ailleurs, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
  await premiere.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive }, "r1");

  // Le coffre sert : ouvert par le code, le volume `coquille` naît, Rails écrit sur le disque.
  const kek = await kekDuCode(ailleurs, code);
  const ouverte = await ouvrirEnveloppe({
    support: supportDe(ailleurs, "coquille"),
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek,
  });
  const disque = await openOpfsVolume({
    name: "application",
    size: OCTETS_DU_DISQUE,
    cle: ouverte.dek,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    openHandle: ailleurs.store.openHandle,
  });
  await disque.write(5 * SECTOR_SIZE, new Uint8Array(SECTOR_SIZE).fill(0x77));
  await disque.flush();
  await disque.close();
  await poserLeVolumeCoquille(ailleurs, IDENTIFIANT_DU_VOLUME_COQUILLE);
  // Puis le manifeste se perd : un effacement partiel, une extension, un support.
  await ailleurs.retirer("application.manifest");

  const reprise = workerSur(ailleurs, { etat: ETATS_DU_VOLUME.verrouille, kek: null });
  assert.equal(await reprise.portabilite.constater(), "coffre-servi-sans-manifeste");
  const erreur = await echec(
    reprise.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive }, "r2"),
  );
  assert.equal(erreur.code, CODES_REFUS_COQUILLE.coffreServiSansManifeste);

  const relu = await openOpfsVolume({
    name: "application",
    size: OCTETS_DU_DISQUE,
    cle: ouverte.dek,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    openHandle: ailleurs.store.openHandle,
  });
  try {
    const secteur = await relu.read(5 * SECTOR_SIZE, SECTOR_SIZE);
    assert.ok(
      secteur.every((octet) => octet === 0x77),
      "l'écriture postérieure a été effacée",
    );
  } finally {
    await relu.close();
  }
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

test("aucune COPIE de sauvegarde ne survit au geste qui l'a créée, qu'il aboutisse ou échoue", async () => {
  // Revue de la PR #208, constat 4 : `coquille-sauvegarde` restait dans l'OPFS « jusqu'à la
  // sauvegarde suivante », et survivait à la révocation d'urgence.
  const { banc } = await coffreOuvert();
  const rendu = await sauvegarde(workerSur(banc));
  assert.equal((await banc.stat(FICHIER_DE_SAUVEGARDE)).present, false, "copie après succès");
  // L'archive rendue ne dépend pas de la copie retirée : elle se relit entière.
  assert.equal((await rendu.archive.arrayBuffer()).byteLength, rendu.taille);

  const base = primitivesDe(banc, { ouvrirLeDisque });
  const coupeeEnEcrivant = workerSur(banc, {
    primitives: {
      ...base,
      async ouvrirLePuits(nom) {
        const ouvert = await base.ouvrirLePuits(nom);
        let blocs = 0;
        const { puits } = ouvert;
        return {
          ...ouvert,
          puits: {
            get offset() {
              return puits.offset;
            },
            async write(octets) {
              blocs += 1;
              if (blocs === 2) throw coupure();
              return puits.write(octets);
            },
          },
        };
      },
    },
  });
  const erreur = await echec(
    coupeeEnEcrivant.portabilite.servir(TYPES_PRIVILEGIES.sauvegarder, {}, "s2"),
  );
  assert.equal(erreur.code, "COUPURE");
  assert.equal((await banc.stat(FICHIER_DE_SAUVEGARDE)).present, false, "copie après échec");
});

test("une copie RÉSIDUELLE est retirée par la révocation d'urgence : le code révoqué n'ouvre plus rien", async () => {
  const { banc, code } = await coffreOuvert();
  // La coupure entre la copie et son retrait — l'onglet fermé à cet instant — laisse un résidu.
  const base = primitivesDe(banc, { ouvrirLeDisque });
  let retraitsDeLaCopie = 0;
  const coupeeAuRetrait = workerSur(banc, {
    primitives: {
      ...base,
      async retirer(nom) {
        if (nom === FICHIER_DE_SAUVEGARDE) {
          retraitsDeLaCopie += 1;
          if (retraitsDeLaCopie === 2) throw coupure();
        }
        return base.retirer(nom);
      },
    },
  });
  await coupeeAuRetrait.portabilite.servir(TYPES_PRIVILEGIES.sauvegarder, {}, "s").catch(() => {});
  assert.equal((await banc.stat(FICHIER_DE_SAUVEGARDE)).present, true, "le résidu est posé");

  // Ouvert par la PHRASE, le coffre révoque tout sauf elle : le code est retiré, ET le résidu.
  const worker = workerSur(banc);
  await worker.portabilite.servir(TYPES_PRIVILEGIES.revoquerEnUrgence, {}, "v");
  const bilan = worker.reponses.at(-1).corps;
  assert.equal(bilan.retires.recuperation, 1);
  assert.equal(bilan.copieDeSauvegardeRetiree, true);
  assert.equal((await banc.stat(FICHIER_DE_SAUVEGARDE)).present, false, "le résidu survit");

  // Le code révoqué n'ouvre rien de ce que l'appareil porte encore.
  await assert.rejects(relireParLeCode(banc, code));
});

test("portabilité et second boot pendant un geste LONG sont refusés, jamais mis en attente (#215)", async () => {
  const { portabilite } = workerSur(magasin());
  assert.equal(portabilite.refusALArrivee(TYPES_PRIVILEGIES.revoquerEnUrgence), null);
  const sortir = portabilite.entrer(TYPES_PRIVILEGIES.application);
  for (const type of [
    TYPES_PRIVILEGIES.application,
    TYPES_PRIVILEGIES.reprendreInstallation,
    TYPES_PRIVILEGIES.revoquerEnUrgence,
    TYPES_PRIVILEGIES.sauvegarder,
    TYPES_PRIVILEGIES.restaurer,
  ]) {
    assert.equal(portabilite.refusALArrivee(type), CODES_REFUS_COQUILLE.gesteEnCours);
  }
  // Le verrouillage a sa propre garde, contrairement au second démarrage.
  assert.equal(portabilite.refusALArrivee(TYPES_PRIVILEGIES.fermeture), null);
  sortir();
  assert.equal(portabilite.refusALArrivee(TYPES_PRIVILEGIES.application), null);
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

test("la restauration refuse un objet DÉGUISÉ en File, avant de rien lire (revue #208, constat 8)", async () => {
  const destination = workerSur(magasin(), { etat: ETATS_DU_VOLUME.verrouille, kek: null });
  const lu = [];
  const deguise = {
    constructor: { name: "File" },
    size: 64,
    slice: (...bornes) => {
      lu.push(bornes);
      return new Blob([new Uint8Array(64)]);
    },
  };
  const erreur = await echec(
    destination.portabilite.servir(TYPES_PRIVILEGIES.restaurer, { archive: deguise }, "r"),
  );
  assert.equal(erreur.code, CODES_REFUS_COQUILLE.messageMalforme);
  assert.deepEqual(lu, [], "l'objet déguisé a été lu");
});
