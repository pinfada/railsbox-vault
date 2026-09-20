// UN PREMIER DÉMARRAGE INTERROMPU (#250) : reconnu dès le premier échec, dit avec des mots vrais, et
// jamais « reprendre » sur un volume qui a porté des données.
//
// Le montage est celui de `coquille-application.test.mjs` : le VRAI `installerSiNecessaire`, le VRAI
// versement (`verserFluxDansVolume`, blocs nuls sautés) et la VRAIE datation, sur le double
// déterministe ; seul le réseau est feint. Chaque état du volume y reçoit sa décision — installer,
// reprendre, refuser — dans une table.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { installerSiNecessaire } from "../../src/coquille/application-de-reference.mjs";
import {
  echecDInstallationReconnu,
  echecDUnArtefactDuDemarrage,
  echecDuPremierBoot,
  installationJamaisDemarree,
} from "../../src/coquille/installation-interrompue.mjs";
import { reprendreSiSignatureConfirmee } from "../../src/coquille/reprise-installation.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import {
  codeDuDemarrageRefuse,
  demarrerEstPossible,
  gestesDAbri,
  installationInachevee,
} from "../../src/coquille/accueil-de-la-mise-a-jour.mjs";
import { CONDUITE_GENERIQUE, conduiteHumaine } from "../../src/coquille/conduites-du-parcours.mjs";
import { reponseDeDemarrageRefuse } from "../../src/coquille/mise-a-jour-applicative.mjs";
import { marquerLAcquisitionDesArtefacts } from "../../src/vm/acquisition-des-artefacts.mjs";
import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { daterLaCreation, openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { generationJournalName, manifestSidecarName } from "../../src/vm/opfs-sync-access.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { verserFluxDansVolume } from "../../src/vm/versement-de-disque.mjs";

const NOM = "application";
const TAILLE = 8 * SECTOR_SIZE;
const ID = "aabbccddeeff00112233445566778899";
const CLE = Uint8Array.from({ length: 32 }, (_, rang) => rang + 1);

/** La graine : des secteurs NULS (sautés au versement) et des secteurs pleins. */
const GRAINE = (() => {
  const octets = new Uint8Array(TAILLE);
  octets.fill(0x5a, 0, 2 * SECTOR_SIZE);
  octets.fill(0x6b, 5 * SECTOR_SIZE, 6 * SECTOR_SIZE);
  return octets;
})();
const EMPREINTE = createHash("sha256").update(GRAINE).digest("hex");

function descripteur() {
  return {
    descripteurVersion: 2,
    application: { id: "installation-interrompue", version: "1.0.0", schema: "20260101000002" },
    runtime: { version: "0.1.0" },
    rootfs: { nom: "r.ext4", octets: 4096, sha256: "a".repeat(64) },
    paquet: { nom: "p.ext4", octets: 4096, sha256: "b".repeat(64) },
    graine: { nom: "graine.ext4", octets: TAILLE, sha256: EMPREINTE, disqueOctets: TAILLE },
    boot: {
      cmdline: "root=/dev/sda1 rw console=ttyS0 init=/opt/vault/guest-init.sh",
      memoireOctets: 33554432,
      kernel: "k",
      initrd: "i",
      bios: "seabios.bin",
      vgaBios: "vgabios.bin",
    },
    prefixeDesArtefacts: "/artifacts/essai/",
  };
}

/** Un corps de réponse qui rend `morceaux`, puis se COUPE si `coupure` est vrai. */
function corps(morceaux, { coupure = false } = {}) {
  let rang = 0;
  return new ReadableStream({
    pull(controleur) {
      if (rang < morceaux.length) return controleur.enqueue(morceaux[rang++]);
      if (coupure) return controleur.error(new TypeError("network error"));
      return controleur.close();
    },
  });
}

/** Ce que l'origine SERT pour la graine, dans chaque cas éprouvé. */
const REPONSES = Object.freeze({
  refusee403: () => new Response("interdit", { status: 403 }),
  absente404: () => new Response("absent", { status: 404 }),
  panne503: () => new Response("panne", { status: 503 }),
  coupee: () => new Response(corps([GRAINE.subarray(0, 3 * SECTOR_SIZE)], { coupure: true })),
  empreinteFausse: () => {
    const fausse = GRAINE.slice();
    fausse[5 * SECTOR_SIZE] ^= 0xff;
    return new Response(corps([fausse]));
  },
  tronquee: () => new Response(corps([GRAINE.subarray(0, 6 * SECTOR_SIZE)])),
  servie: () => new Response(corps([GRAINE])),
});

function observerDuStore(store) {
  return async (nom) => ({ present: store.sizeOf(nom) > 0, size: store.sizeOf(nom) });
}

/** Les primitives RÉELLES sur le double ; le réseau rend `reponse()`, le manifeste s'écrit au store. */
function primitives(store, reponse) {
  const manifestes = new Map();
  return {
    manifestes,
    options: {
      descripteur: descripteur(),
      cleDeVolume: async () => CLE.slice(),
      observer: observerDuStore(store),
      openHandle: store.openHandle,
      ouvrir: (options) =>
        openOpfsVolume({ ...options, identifiantVolume: ID, openHandle: store.openHandle }),
      verser: (backend, url, options) =>
        verserFluxDansVolume(backend, url, { ...options, recuperer: async () => reponse() }),
      dater: (options) => daterLaCreation({ ...options, openHandle: store.openHandle }),
      revoquer: async () => {},
      inscrire: async (nom) => {
        const handle = await store.openHandle(manifestSidecarName(nom));
        handle.write(new TextEncoder().encode("{}"), { at: 0 });
        handle.flush();
        handle.close();
        manifestes.set(nom, true);
      },
      lireLeManifeste: async (nom) => (manifestes.has(nom) ? MANIFESTE_LISIBLE : null),
    },
  };
}

/** Un manifeste que `parseManifest` accepte, pour les cas « installé ». */
const MANIFESTE_LISIBLE = await (async () => {
  const { createManifest, serializeManifest, VOLUME_ALGORITHM } =
    await import("../../src/vm/volume-manifest.mjs");
  return serializeManifest(
    createManifest({
      runtime: { version: "0.1.0", artifact: null, minWriter: "0.1.0" },
      app: { id: "installation-interrompue", version: "1.0.0", schema: "20260101000002" },
      volumeSize: TAILLE,
      identity: { algorithm: "sha-256", digest: null },
      volume: { id: ID, algorithm: VOLUME_ALGORITHM },
    }),
  );
})();

async function echecDe(promesse) {
  return promesse.then(
    () => null,
    (raison) => raison,
  );
}

// --- Le PREMIER échec est reconnu tout de suite, pour chaque manière d'échouer --------------------

for (const cas of [
  "refusee403",
  "absente404",
  "panne503",
  "coupee",
  "empreinteFausse",
  "tronquee",
]) {
  test(`graine ${cas} : le PREMIER démarrage rend l'installation reconnue, jamais « aucune application »`, async () => {
    const store = createSyncAccessStore();
    const { options } = primitives(store, REPONSES[cas]);
    const erreur = await echecDe(installerSiNecessaire(options));

    assert.notEqual(erreur, null, "l'installation a échoué");
    assert.equal(erreur.code, C.volumeApplicatifSansManifeste);
    assert.equal(erreur.installationInterrompue, true, erreur.motifDeLaSignature ?? "");
    assert.equal(store.sizeOf(manifestSidecarName(NOM)), 0, "aucun manifeste n'est écrit");
    // Ce que la page en dira : l'installation inachevée, avec « Reprendre l'installation ».
    const reponse = reponseDeDemarrageRefuse({
      motif: erreur.message,
      code: erreur.code,
      installationInterrompue: erreur.installationInterrompue,
      motifDeLaSignature: erreur.motifDeLaSignature,
    });
    assert.equal(codeDuDemarrageRefuse(reponse), C.installationInachevee);

    // Le démarrage SUIVANT reconnaît le même état, et la reprise — l'origine servant de nouveau —
    // retire puis installe jusqu'au manifeste.
    const second = await echecDe(installerSiNecessaire(options));
    assert.equal(second.installationInterrompue, true);
    const { options: guerie, manifestes } = primitives(store, REPONSES.servie);
    const reprise = await reprendreSiSignatureConfirmee({
      ...guerie,
      retirer: retirerDuStore(store),
    });
    assert.equal(reprise.reprise, true, reprise.motif);
    assert.equal(manifestes.has(NOM), true);
  });
}

test("une reprise qui échoue ENCORE (l'origine refuse toujours) est redite, bouton compris", async () => {
  const store = createSyncAccessStore();
  const { options } = primitives(store, REPONSES.refusee403);
  await echecDe(installerSiNecessaire(options));
  const reprise = await reprendreSiSignatureConfirmee({
    ...options,
    retirer: retirerDuStore(store),
  });
  assert.deepEqual(
    { reprise: reprise.reprise, code: reprise.code, reconnue: reprise.installationInterrompue },
    { reprise: false, code: C.volumeApplicatifSansManifeste, reconnue: true },
  );
});

test("une reprise qui échoue sur un refus TYPÉ le laisse remonter : seul l'échec reconnu est redit", async () => {
  const store = createSyncAccessStore();
  const { options } = primitives(store, REPONSES.refusee403);
  await echecDe(installerSiNecessaire(options));
  const { options: guerie } = primitives(store, REPONSES.servie);
  const typee = Object.assign(new Error("création non confirmée"), {
    code: STORAGE_ERROR_CODES.creationNonConfirmee,
  });
  const erreur = await echecDe(
    reprendreSiSignatureConfirmee({
      ...guerie,
      retirer: retirerDuStore(store),
      dater: async () => {
        throw typee;
      },
    }),
  );
  assert.equal(erreur, typee);
});

/** `removeOpfsVolume` sur le double : le volume et son journal, rien d'autre. */
function retirerDuStore(store) {
  return async (nom) => {
    for (const cible of [nom, generationJournalName(nom)]) {
      if (store.sizeOf(cible) === 0) continue;
      const handle = await store.openHandle(cible);
      handle.truncate(0);
      handle.flush();
      handle.close();
    }
  };
}

// --- LA TABLE : chaque état du volume → installer, reprendre, ou refuser --------------------------

/** Installe entièrement (manifeste compris), puis rend le store. */
async function volumeInstalle() {
  const store = createSyncAccessStore();
  const monte = primitives(store, REPONSES.servie);
  const rendu = await installerSiNecessaire(monte.options);
  assert.equal(rendu.installee, true);
  return { store, monte };
}

/** Un volume qui a SERVI : un boot a validé une génération (une écriture puis une barrière). */
async function servir(store) {
  const reouvert = await openOpfsVolume({
    name: NOM,
    size: TAILLE,
    cle: CLE,
    identifiantVolume: ID,
    openHandle: store.openHandle,
  });
  await reouvert.write(0, new Uint8Array(SECTOR_SIZE).fill(0x22));
  await reouvert.flush();
  await reouvert.close();
}

async function sansManifeste(store, monte) {
  const handle = await store.openHandle(manifestSidecarName(NOM));
  handle.truncate(0);
  handle.flush();
  handle.close();
  monte.manifestes.delete(NOM);
}

const TABLE = [
  {
    etat: "aucun volume",
    preparer: async () => {
      const store = createSyncAccessStore();
      return { store, monte: primitives(store, REPONSES.servie) };
    },
    attendu: "installer",
  },
  {
    etat: "volume installé, manifeste lisible",
    preparer: volumeInstalle,
    attendu: "rien",
  },
  {
    etat: "graine refusée : volume né, rien versé",
    preparer: async () => {
      const store = createSyncAccessStore();
      const monte = primitives(store, REPONSES.refusee403);
      await echecDe(installerSiNecessaire(monte.options));
      return { store, monte };
    },
    attendu: "reprendre",
  },
  {
    etat: "installé, jamais démarré, manifeste perdu",
    preparer: async () => {
      const { store, monte } = await volumeInstalle();
      await sansManifeste(store, monte);
      return { store, monte };
    },
    attendu: "reprendre",
  },
  {
    etat: "a SERVI (génération validée), manifeste perdu — AMBIGU",
    preparer: async () => {
      const { store, monte } = await volumeInstalle();
      await servir(store);
      await sansManifeste(store, monte);
      return { store, monte };
    },
    attendu: "refuser",
  },
  {
    etat: "volume sans journal — AMBIGU",
    preparer: async () => {
      const { store, monte } = await volumeInstalle();
      await sansManifeste(store, monte);
      const handle = await store.openHandle(generationJournalName(NOM));
      handle.truncate(0);
      handle.flush();
      handle.close();
      return { store, monte };
    },
    attendu: "refuser",
  },
];

for (const { etat, preparer, attendu } of TABLE) {
  test(`TABLE — ${etat} → ${attendu}`, async () => {
    const { store, monte } = await preparer();
    const avant = store.sizeOf(NOM);
    const erreur = await echecDe(
      installerSiNecessaire({ ...monte.options, verser: verserQuiTemoigne }),
    );
    const decision =
      erreur === null
        ? versements > 0
          ? "installer"
          : "rien"
        : erreur.code === C.volumeApplicatifSansManifeste && erreur.installationInterrompue
          ? "reprendre"
          : erreur.code === C.volumeApplicatifSansManifeste
            ? "refuser"
            : `erreur ${erreur.code}`;
    versements = 0;
    assert.equal(decision, attendu);
    if (attendu === "refuser" || attendu === "rien") {
      // La GARDE : rien n'est écrasé, et la reprise elle-même REFUSE sans rien retirer.
      assert.equal(store.sizeOf(NOM), avant);
      const reprise = await reprendreSiSignatureConfirmee({
        ...monte.options,
        retirer: async () => assert.fail("rien ne doit être retiré"),
      });
      assert.equal(reprise.reprise, false);
    }
  });
}

let versements = 0;
async function verserQuiTemoigne(backend, url, options) {
  versements += 1;
  return verserFluxDansVolume(backend, url, {
    ...options,
    recuperer: async () => REPONSES.servie(),
  });
}

// --- La traduction ne touche pas aux refus TYPÉS --------------------------------------------------

test("un refus TYPÉ du support (datation non confirmée) garde son code : il n'est pas traduit", async () => {
  const store = createSyncAccessStore();
  const { options } = primitives(store, REPONSES.refusee403);
  await echecDe(installerSiNecessaire(options));
  const typee = Object.assign(new Error("création non confirmée"), {
    code: STORAGE_ERROR_CODES.creationNonConfirmee,
  });
  const rendue = await echecDInstallationReconnu({
    erreur: typee,
    nom: NOM,
    octets: TAILLE,
    observer: observerDuStore(store),
    openHandle: store.openHandle,
  });
  assert.equal(rendue, typee);
});

test("un échec AVANT la création du volume remonte tel quel : il n'y a rien à reconnaître", async () => {
  const store = createSyncAccessStore();
  const brute = new Error("quota");
  const rendue = await echecDInstallationReconnu({
    erreur: brute,
    nom: NOM,
    octets: TAILLE,
    observer: observerDuStore(store),
    openHandle: store.openHandle,
  });
  assert.equal(rendue, brute);
});

// --- Le PREMIER BOOT : noyau, initrd, rootfs, paquet ----------------------------------------------

const ECHECS_DU_BOOT = {
  noyau: "Artefact /artifacts/essai/k indisponible (403).",
  initrd: "Artefact /artifacts/essai/i indisponible (404).",
  rootfs: "Artefact rootfs refusé : empreinte 00, le descripteur déclare aa.",
  paquet: "Artefact paquet (/artifacts/essai/p.ext4) indisponible (503).",
  "paquet coupé": "network error",
};

for (const [morceau, message] of Object.entries(ECHECS_DU_BOOT)) {
  test(`premier boot, ${morceau} non acquis, volume jamais démarré → installation inachevée`, async () => {
    const rendu = await echecDuPremierBoot(new Error(message), {
      nom: NOM,
      jamaisDemarree: async () => true,
    });
    assert.equal(rendu.code, C.installationInachevee);
    assert.equal(rendu.installationInterrompue, true);
    assert.equal(rendu.installee, true);
    assert.match(rendu.motif, /n'a pas pu se terminer/);
    const publiee = reponseDeDemarrageRefuse(rendu);
    assert.equal(publiee.installee, true);
    assert.equal(installationInachevee({ application: publiee }), true);
    assert.equal(demarrerEstPossible({ application: publiee }), false);
    assert.deepEqual(gestesDAbri({ application: publiee }), ["verrouiller"]);
  });
}

test("premier boot échoué sur un volume qui a DÉJÀ démarré : l'erreur remonte, jamais « inachevée »", async () => {
  const rendu = await echecDuPremierBoot(new Error("Artefact k indisponible (403)."), {
    nom: NOM,
    jamaisDemarree: async () => false,
  });
  assert.equal(rendu, null);
});

test("un échec de boot TYPÉ (stockage, fraîcheur) garde son code", async () => {
  const rendu = await echecDuPremierBoot(
    Object.assign(new Error("fraîcheur"), { code: STORAGE_ERROR_CODES.generationDiscarded }),
    { nom: NOM, jamaisDemarree: async () => true },
  );
  assert.equal(rendu, null);
});

test("installationJamaisDemarree : VRAI après l'installation, FAUX dès qu'une génération est validée", async () => {
  const { store } = await volumeInstalle();
  const mesurer = () =>
    installationJamaisDemarree({
      nom: NOM,
      observer: observerDuStore(store),
      openHandle: store.openHandle,
    });
  assert.equal(await mesurer(), true);
  await servir(store);
  assert.equal(await mesurer(), false);
});

// --- Ce que la PAGE en lit --------------------------------------------------------------------------

test("la page ne lit « aucune application » que d'une origine qui n'en sert aucune", () => {
  assert.equal(codeDuDemarrageRefuse({ demarree: false }), C.applicationAbsente);
  assert.equal(
    codeDuDemarrageRefuse({ demarree: false, code: C.applicationAbsente }),
    C.applicationAbsente,
  );
  assert.equal(
    codeDuDemarrageRefuse({
      demarree: false,
      code: C.volumeApplicatifSansManifeste,
      installationInterrompue: true,
    }),
    C.installationInachevee,
  );
  assert.equal(
    codeDuDemarrageRefuse({
      demarree: false,
      code: C.volumeApplicatifSansManifeste,
      installationInterrompue: false,
    }),
    C.volumeApplicatifSansManifeste,
  );
  assert.equal(codeDuDemarrageRefuse(null, C.gesteRompu), C.gesteRompu);
  // L'état AMBIGU laisse « Démarrer », sans « Reprendre », et offre de mettre le coffre à l'abri.
  const ambigu = {
    application: {
      demarree: false,
      code: C.volumeApplicatifSansManifeste,
      installationInterrompue: false,
    },
  };
  assert.equal(installationInachevee(ambigu), false);
  assert.deepEqual(gestesDAbri(ambigu), ["verrouiller"]);
  assert.deepEqual(
    gestesDAbri({ application: { demarree: false, code: C.applicationAbsente } }),
    [],
  );
  assert.deepEqual(gestesDAbri({ application: { demarree: true } }), []);
});

/** Le marquage que l'acquisition pose sur un échec sans code, tel que `preparerLeBoot` le pose. */
const marqueDAcquisition = (erreur) =>
  Object.assign(new Error(erreur.message), { artefactDuDemarrage: true, cause: erreur });

// --- Le DÉMARRAGE d'un coffre QUI A SERVI, dont un artefact est refusé (#255) ------------------------
//
// Symétrique du précédent, et c'est le seul point qui les sépare : le volume a DÉJÀ démarré. Rien n'est
// inachevé, rien n'est à reprendre — l'adresse n'a pas fourni l'application, et c'est tout ce qui s'est
// passé. Le fourre-tout « l'opération n'a pas abouti, sans cause identifiée » ne doit plus jamais sortir
// de ce chemin : le contrôle QA du 20/09/2026 l'y a lu en 1,0 s sur un rootfs en 403.

for (const [morceau, message] of Object.entries(ECHECS_DU_BOOT)) {
  test(`démarrage, ${morceau} non acquis, volume qui a SERVI → l'adresse n'a pas fourni l'application`, async () => {
    const rendu = await echecDUnArtefactDuDemarrage(marqueDAcquisition(new Error(message)), {
      nom: NOM,
      jamaisDemarree: async () => false,
    });
    assert.equal(rendu.code, C.artefactDuDemarrageRefuse);
    // JAMAIS une installation interrompue : c'est ce drapeau, et lui seul, qui montre « Reprendre ».
    assert.equal(rendu.installationInterrompue, false);
    assert.match(rendu.motif, /n'a pas pu être acquis/);
    const publiee = reponseDeDemarrageRefuse(rendu);
    assert.equal(installationInachevee({ application: publiee }), false);
    assert.equal(codeDuDemarrageRefuse(publiee), C.artefactDuDemarrageRefuse);
    // Sauvegarder ET verrouiller : les données sont là, et la sauvegarde se fait sans démarrer.
    assert.deepEqual(gestesDAbri({ application: publiee }), ["verrouiller", "sauvegarde"]);
    // La conduite NOMME l'adresse, et ne renvoie ni au rechargement ni au fourre-tout.
    const conduite = conduiteHumaine(C.artefactDuDemarrageRefuse);
    assert.notEqual(conduite, CONDUITE_GENERIQUE);
    assert.match(conduite, /Cette adresse n'a pas pu fournir l'application/);
    assert.match(conduite, /Vos données sont intactes/);
    assert.doesNotMatch(conduite, /Rechargez la page/);
  });
}

test("#255 : un volume JAMAIS démarré reste l'affaire de #250 — l'installation inachevée", async () => {
  const rendu = await echecDUnArtefactDuDemarrage(
    marqueDAcquisition(new Error(ECHECS_DU_BOOT.rootfs)),
    { nom: NOM, jamaisDemarree: async () => true },
  );
  assert.equal(rendu, null);
});

test("#255 : un échec qui n'est PAS une acquisition d'artefact remonte tel quel", async () => {
  const rendu = await echecDUnArtefactDuDemarrage(new Error("le guest a cessé de battre"), {
    nom: NOM,
    jamaisDemarree: async () => false,
  });
  assert.equal(rendu, null);
});

test("#255 : un échec d'acquisition TYPÉ garde son code", async () => {
  const typee = Object.assign(new Error("quota"), {
    code: STORAGE_ERROR_CODES.quotaExceeded,
    artefactDuDemarrage: true,
  });
  assert.equal(
    await echecDUnArtefactDuDemarrage(typee, { nom: NOM, jamaisDemarree: async () => false }),
    null,
  );
});

/** Ce que l'acquisition a jeté, rendu plutôt que relevé : l'épreuve le LIT, elle ne meurt pas avec. */
async function jetePar(acquerir) {
  try {
    await marquerLAcquisitionDesArtefacts(acquerir);
  } catch (erreur) {
    return erreur;
  }
  return null;
}

test("#255 : l'acquisition MARQUE ses échecs sans code, et laisse les autres intacts", async () => {
  const brute = new Error("Artefact rootfs indisponible (403).");
  const marquee = await jetePar(() => {
    throw brute;
  });
  assert.equal(marquee.artefactDuDemarrage, true);
  assert.equal(marquee.message, brute.message);
  // Le détail technique ne se perd pas : l'erreur d'origine reste sous `cause`.
  assert.equal(marquee.cause, brute);
  const typee = Object.assign(new Error("capacité"), { code: C.capaciteManquante });
  assert.equal(
    await jetePar(() => {
      throw typee;
    }),
    typee,
  );
  // Ce qui réussit passe sans être touché.
  assert.deepEqual(await marquerLAcquisitionDesArtefacts(async () => ({ V86: null })), {
    V86: null,
  });
});
