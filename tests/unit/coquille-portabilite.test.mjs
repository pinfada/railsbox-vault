/**
 * Les DÉCISIONS de portabilité de la coquille, et la dérogation d'archive du contrat (#207, ADR 0039).
 *
 * Fonctions pures, primitives injectées : ce que `tools/muter-gardes-coquille.mjs` mute se mesure ici.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHAMP_DE_L_ARCHIVE,
  TYPES_PRIVILEGIES,
  enveloppeDeMessage,
  enveloppePrivilegiee,
  estUneArchive,
} from "../../src/coquille/contrat-de-messages.mjs";
import {
  IDENTIFIANT_DU_COFFRE,
  IDENTIFIANT_DU_VOLUME_COQUILLE,
} from "../../src/coquille/identites-du-coffre.mjs";
import {
  ETATS_DE_L_EMPLACEMENT,
  bilanDeRevocation,
  cibleDuCoffre,
  constaterLEmplacement,
  decisionDeRestauration,
  declareLeVolumeDuCoffre,
  enTeteDArchive,
  refusDOuverture,
  refusPendantUnGesteLong,
} from "../../src/coquille/portabilite-du-coffre.mjs";
import { brancherLesGestesDePortabilite } from "../../src/coquille/gestes-de-portabilite.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { exportVolumeToBytes } from "../../src/vm/archive-en-memoire.mjs";
import { construireEnveloppeDeRecuperation } from "../../src/vm/enveloppe-de-recuperation.mjs";
import { manifestSidecarName } from "../../src/vm/opfs-sync-access.mjs";
import { ARCHIVE_MAGIC, PREAMBLE_BYTES } from "../../src/vm/volume-export.mjs";
import { EN_TETE_OCTETS } from "../../src/vm/volume-chiffre-format.mjs";
import { parseManifest, serializeManifest } from "../../src/vm/volume-manifest.mjs";
import { identifiantDeVolume } from "./support-enveloppe-double.mjs";
import {
  KEK,
  installerLeDisque,
  magasin,
  poserLEnveloppe,
  poserLeVolumeCoquille,
} from "./support-coffre-de-la-coquille.mjs";
import { DEK, sourceDuVolume } from "./support-archive-recuperation.mjs";

function primitives(banc) {
  return {
    observer: banc.stat,
    lireEnTete: async (nom) =>
      banc.store.sizeOf(nom) > 0 ? banc.store.snapshot(nom).subarray(0, EN_TETE_OCTETS) : null,
    lireVoisin: async (nom) => banc.lire(nom),
  };
}

const constater = (banc) => constaterLEmplacement(primitives(banc));

test("un emplacement VIDE est vide, et un coffre de cette version est un coffre", async () => {
  const banc = magasin();
  assert.equal(await constater(banc), ETATS_DE_L_EMPLACEMENT.vide);
  await installerLeDisque(banc);
  await poserLEnveloppe(banc);
  await poserLeVolumeCoquille(banc, IDENTIFIANT_DU_VOLUME_COQUILLE);
  assert.equal(await constater(banc), ETATS_DE_L_EMPLACEMENT.coffre);
});

test("un coffre créé par la coquille d'AVANT est reconnu à son volume coquille", async () => {
  const banc = magasin();
  await poserLEnveloppe(banc);
  await poserLeVolumeCoquille(banc, IDENTIFIANT_DU_COFFRE);
  assert.equal(await constater(banc), ETATS_DE_L_EMPLACEMENT.anterieur);
});

test("un disque dont le manifeste déclare un AUTRE volume n'est pas un coffre antérieur : il a son propre état", async () => {
  // Revue de la PR #208, constat 5 : `COFFRE_ANTERIEUR` recouvrait trois causes. Il n'en garde
  // qu'une — le volume `coquille` sous l'ancienne identité ; un manifeste d'un autre volume, ou d'un
  // autre format, est un disque que cette coquille n'a ni installé ni restauré.
  const banc = magasin();
  await installerLeDisque(banc);
  await poserLEnveloppe(banc);
  await poserLeVolumeCoquille(banc, IDENTIFIANT_DU_VOLUME_COQUILLE);
  const manifeste = parseManifest(banc.lire(manifestSidecarName("application")));
  const autre = { ...manifeste, volume: { ...manifeste.volume, id: identifiantDeVolume(0x33) } };
  await banc.ecrire(manifestSidecarName("application"), serializeManifest(autre));
  assert.equal(await constater(banc), "disque-d-un-autre-coffre");

  const autreFormat = { ...manifeste, formatVersion: manifeste.formatVersion - 1 };
  await banc.ecrire(manifestSidecarName("application"), serializeManifest(autreFormat));
  assert.equal(await constater(banc), "disque-d-un-autre-coffre");
});

/**
 * Un disque tel qu'une restauration le laisse avant son manifeste : ni journal de génération, ni
 * témoin, ni instantané — `createOpfsImportTarget` les retire, et seule une ouverture les écrit.
 */
async function disqueRestaureSansManifeste(banc) {
  await installerLeDisque(banc);
  for (const voisin of ["application.manifest", "application.gen", "application.temoin"]) {
    await banc.retirer(voisin);
  }
}

test("une restauration COUPÉE est reconnue, et une installation coupée ne l'est PAS", async () => {
  // Disque sans enveloppe ni manifeste : coupée avant l'enveloppe.
  const avantLEnveloppe = magasin();
  await disqueRestaureSansManifeste(avantLEnveloppe);
  assert.equal(await constater(avantLEnveloppe), ETATS_DE_L_EMPLACEMENT.restaurationInterrompue);

  // Disque sans manifeste, enveloppe du domaine `enveloppe` : c'est une INSTALLATION coupée, que la
  // reprise de #173 connaît. La portabilité ne la réclame pas.
  const installation = magasin();
  await installerLeDisque(installation);
  await installation.retirer(manifestSidecarName("application"));
  await poserLEnveloppe(installation);
  assert.equal(await constater(installation), ETATS_DE_L_EMPLACEMENT.coffre);

  // Disque sans manifeste, enveloppe du domaine `recuperation` : la page d'une archive, jamais mutée.
  const apresLEnveloppe = magasin();
  await disqueRestaureSansManifeste(apresLEnveloppe);
  await poserLaPageDeRecuperation(apresLEnveloppe);
  assert.equal(await constater(apresLEnveloppe), ETATS_DE_L_EMPLACEMENT.restaurationInterrompue);
});

/** Pose sur `coquille.cles` la page de récupération d'une archive, jamais mutée. */
async function poserLaPageDeRecuperation(banc) {
  const { support } = await poserLEnveloppe(magasin());
  const page = await construireEnveloppeDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek: KEK,
  });
  const fichier = new Uint8Array(4 * page.octets.byteLength);
  fichier.set(page.octets, 0);
  await banc.ecrire("coquille.cles", fichier);
}

test("la même signature, plus UNE trace de service, est un coffre servi : jamais réparé", async () => {
  // Revue de la PR #208, constat 6. Chaque trace, seule, suffit.
  const traces = {
    "le volume coquille": (banc) => poserLeVolumeCoquille(banc, IDENTIFIANT_DU_VOLUME_COQUILLE),
    "le journal de génération": (banc) => banc.ecrire("application.gen", new Uint8Array([1])),
    "le témoin": (banc) => banc.ecrire("application.temoin", new Uint8Array([1])),
    "l'instantané": (banc) => banc.ecrire("application.instantane", new Uint8Array([1])),
  };
  for (const [nom, poser] of Object.entries(traces)) {
    for (const avecLaPage of [true, false]) {
      const banc = magasin();
      await disqueRestaureSansManifeste(banc);
      if (avecLaPage) await poserLaPageDeRecuperation(banc);
      await poser(banc);
      assert.equal(
        await constater(banc),
        ETATS_DE_L_EMPLACEMENT.coffreServiSansManifeste,
        `${nom}, ${avecLaPage ? "à côté de la page" : "sans enveloppe"}`,
      );
    }
  }
  assert.equal(
    refusDOuverture(ETATS_DE_L_EMPLACEMENT.coffreServiSansManifeste),
    CODES_REFUS_COQUILLE.coffreServiSansManifeste,
  );
  assert.deepEqual(decisionDeRestauration(ETATS_DE_L_EMPLACEMENT.coffreServiSansManifeste), {
    code: CODES_REFUS_COQUILLE.coffreServiSansManifeste,
    reparer: false,
  });
});

test("ce que l'ouverture et la restauration font de chaque état", () => {
  const E = ETATS_DE_L_EMPLACEMENT;
  assert.equal(refusDOuverture(E.vide), null);
  assert.equal(refusDOuverture(E.coffre), null);
  assert.equal(refusDOuverture(E.anterieur), CODES_REFUS_COQUILLE.coffreAnterieur);
  assert.equal(
    refusDOuverture(E.restaurationInterrompue),
    CODES_REFUS_COQUILLE.restaurationInterrompue,
  );
  assert.deepEqual(decisionDeRestauration(E.vide), { code: null, reparer: false });
  assert.deepEqual(decisionDeRestauration(E.restaurationInterrompue), {
    code: null,
    reparer: true,
  });
  assert.deepEqual(decisionDeRestauration(E.coffre), {
    code: CODES_REFUS_COQUILLE.emplacementOccupe,
    reparer: false,
  });
  assert.deepEqual(decisionDeRestauration(E.anterieur), {
    code: CODES_REFUS_COQUILLE.coffreAnterieur,
    reparer: false,
  });
  assert.equal(refusDOuverture(E.disqueDUnAutreCoffre), CODES_REFUS_COQUILLE.disqueDUnAutreCoffre);
  assert.deepEqual(decisionDeRestauration(E.disqueDUnAutreCoffre), {
    code: CODES_REFUS_COQUILLE.disqueDUnAutreCoffre,
    reparer: false,
  });
});

test("pendant un geste long, portabilité et nouveaux gestes longs sont refusés", () => {
  assert.equal(refusPendantUnGesteLong(TYPES_PRIVILEGIES.revoquerEnUrgence, 0), null);
  assert.equal(
    refusPendantUnGesteLong(TYPES_PRIVILEGIES.revoquerEnUrgence, 1),
    CODES_REFUS_COQUILLE.gesteEnCours,
  );
  assert.equal(refusPendantUnGesteLong(TYPES_PRIVILEGIES.inventaire, 3), null);
  for (const type of [TYPES_PRIVILEGIES.application, TYPES_PRIVILEGIES.reprendreInstallation]) {
    assert.equal(refusPendantUnGesteLong(type, 0), null);
    assert.equal(refusPendantUnGesteLong(type, 1), CODES_REFUS_COQUILLE.gesteEnCours);
  }
});

test("l'en-tête d'une archive dit si elle emporte une récupération, et ne devine rien d'illisible", async () => {
  const banc = magasin();
  await installerLeDisque(banc);
  const { support } = await poserLEnveloppe(banc);
  const manifest = parseManifest(banc.lire(manifestSidecarName("application")));
  const ecrire = async (recovery) =>
    (
      await exportVolumeToBytes({
        source: sourceDuVolume(banc, "application"),
        manifest,
        consistency: { kind: "handle-exclusif" },
        cle: DEK,
        recovery,
      })
    ).archive;
  const recovery = await construireEnveloppeDeRecuperation({
    support,
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    kek: KEK,
  });
  assert.deepEqual(enTeteDArchive(await ecrire(recovery)), {
    lisible: true,
    duCoffre: true,
    emporteUneRecuperation: true,
  });
  assert.deepEqual(enTeteDArchive(await ecrire(null)), {
    lisible: true,
    duCoffre: true,
    emporteUneRecuperation: false,
  });
  const illisible = { lisible: false, duCoffre: false, emporteUneRecuperation: false };
  assert.deepEqual(enTeteDArchive(new Uint8Array(64)), illisible);
  assert.deepEqual(enTeteDArchive((await ecrire(recovery)).subarray(0, 40)), illisible);
});

/** Un préambule et un en-tête JSON d'archive, sans contenu : ce que `enTeteDArchive` lit. */
function teteDArchive(entete) {
  const json = new TextEncoder().encode(JSON.stringify(entete));
  const tete = new Uint8Array(PREAMBLE_BYTES + json.byteLength);
  tete.set(ARCHIVE_MAGIC, 0);
  new DataView(tete.buffer).setUint32(ARCHIVE_MAGIC.byteLength, json.byteLength, false);
  tete.set(json, PREAMBLE_BYTES);
  return tete;
}

test("l'en-tête d'une archive dit si elle décrit le volume du COFFRE : son identifiant et son format", async () => {
  const banc = magasin();
  await installerLeDisque(banc);
  const manifest = parseManifest(banc.lire(manifestSidecarName("application")));
  const recovery = { format: "descripteur" };
  assert.equal(enTeteDArchive(teteDArchive({ manifest, recovery })).duCoffre, true);

  const autreVolume = {
    ...manifest,
    volume: { ...manifest.volume, id: identifiantDeVolume(0x44) },
  };
  const autreFormat = { ...manifest, formatVersion: manifest.formatVersion - 1 };
  for (const [nom, manifeste] of [
    ["un autre identifiant", autreVolume],
    ["un autre format", autreFormat],
    ["aucun volume", { ...manifest, volume: null }],
    ["aucun manifeste", undefined],
  ]) {
    const lu = enTeteDArchive(teteDArchive({ manifest: manifeste, recovery }));
    assert.deepEqual(lu, { lisible: true, duCoffre: false, emporteUneRecuperation: true }, nom);
  }
  assert.equal(declareLeVolumeDuCoffre(manifest), true);
  assert.equal(declareLeVolumeDuCoffre(null), false);
});

test("la cible du coffre pose l'enveloppe là où le Worker la lit, et refuse une archive qui n'en porte pas", async () => {
  const ecrites = [];
  const base = { commitRecoveryEnvelope: async () => ecrites.push("a-cote-du-disque"), open: 1 };
  const cible = cibleDuCoffre(base, { ecrireLEnveloppe: async (octets) => ecrites.push(octets) });
  assert.equal(cible.open, 1, "les autres gestes de la cible sont ceux de createOpfsImportTarget");
  const page = new Uint8Array([1, 2, 3]);
  await cible.commitRecoveryEnvelope(page);
  assert.deepEqual(ecrites, [page]);
  await assert.rejects(cible.commitRecoveryEnvelope(null), {
    code: CODES_REFUS_COQUILLE.archiveSansRecuperation,
  });
});

test("le bilan d'une révocation porte des noms et des nombres, et compte juste", () => {
  const bilan = bilanDeRevocation({
    avant: { emplacements: [{ typeKek: 1 }, { typeKek: 2 }, { typeKek: 4 }, { typeKek: 1 }] },
    apres: { version: 9, emplacements: [{ typeKek: 4 }] },
  });
  assert.deepEqual(bilan, {
    versionEnveloppe: 9,
    restants: { recuperation: 1 },
    retires: { phrase: 2, "webauthn-prf": 1 },
    nombreRetires: 3,
    nombreRestants: 1,
  });
});

test("une ARCHIVE franchit le canal privilégié sur deux types, et nulle part ailleurs", () => {
  const archive = new File([new Uint8Array(8)], "coffre.rbvault");
  for (const type of [TYPES_PRIVILEGIES.sauvegarderReponse, TYPES_PRIVILEGIES.restaurer]) {
    assert.equal(
      enveloppePrivilegiee(type, { [CHAMP_DE_L_ARCHIVE]: archive })[CHAMP_DE_L_ARCHIVE],
      archive,
    );
    assert.ok(enveloppePrivilegiee(type, { [CHAMP_DE_L_ARCHIVE]: new Blob(["x"]) }));
  }
  const capacite = { code: CODES_REFUS_COQUILLE.capaciteDansUnMessage };
  // Sur un autre type du canal privilégié : refusée.
  assert.throws(
    () => enveloppePrivilegiee(TYPES_PRIVILEGIES.etatReponse, { [CHAMP_DE_L_ARCHIVE]: archive }),
    capacite,
  );
  // Sous un autre constructeur : refusée, même sur le bon type.
  assert.throws(
    () =>
      enveloppePrivilegiee(TYPES_PRIVILEGIES.restaurer, {
        [CHAMP_DE_L_ARCHIVE]: new Uint8Array(8).buffer,
      }),
    capacite,
  );
  // Sous un autre NOM de champ : refusée, `sansCapacite` s'applique.
  assert.throws(
    () => enveloppePrivilegiee(TYPES_PRIVILEGIES.restaurer, { fichier: archive }),
    capacite,
  );
  // Hors du canal privilégié : `enveloppeDeMessage` n'a aucune dérogation.
  assert.throws(() => enveloppeDeMessage(TYPES_PRIVILEGIES.restaurer, { archive }), capacite);
});

test("la dérogation d'archive juge ce qu'EST la valeur, pas le nom de son constructeur (revue #208, constat 8)", () => {
  const capacite = { code: CODES_REFUS_COQUILLE.capaciteDansUnMessage };
  const deguises = [
    { constructor: { name: "File" }, slice: () => null, size: 8 },
    { constructor: { name: "Blob" }, slice: () => null, size: 8 },
    Object.create(null, { constructor: { value: { name: "File" } } }),
  ];
  for (const deguise of deguises) {
    assert.throws(
      () => enveloppePrivilegiee(TYPES_PRIVILEGIES.restaurer, { [CHAMP_DE_L_ARCHIVE]: deguise }),
      capacite,
    );
  }
  // Un vrai `File` et un vrai `Blob` restent admis — `File` hérite de `Blob`.
  assert.ok(estUneArchive(new File(["x"], "a")));
  assert.ok(estUneArchive(new Blob(["x"])));
  assert.equal(estUneArchive(deguises[0]), false);
});

/** Une page réduite à ce que les gestes emploient : des nœuds dont on garde chaque texte dit. */
function pageEnregistree(journal) {
  const noeuds = new Map();
  return {
    querySelector(selecteur) {
      const id = selecteur.slice(1);
      if (id === "sauvegarde-lien") return null;
      if (!noeuds.has(id)) {
        const noeud = { addEventListener() {} };
        Object.defineProperty(noeud, "textContent", {
          set(texte) {
            journal.push({ dit: id, texte });
          },
        });
        noeuds.set(id, noeud);
      }
      return noeuds.get(id);
    },
  };
}

test("chaque geste PUBLIE son relevé avant de dire son état final (revue #208, constat 7)", async () => {
  const journal = [];
  const rapport = {};
  const reponses = {
    inventaire: { present: false },
    sauvegarder: { taille: 3, archive: null, applicationArretee: false },
    restaurer: { versionEnveloppe: 2, etat: "verrouille" },
    revoquerEnUrgence: { nombreRetires: 1, nombreRestants: 1, retires: {}, restants: {} },
  };
  const gestes = brancherLesGestesDePortabilite({
    racine: pageEnregistree(journal),
    demander: async (type) => {
      if (type === "restaurer" && reponses.refuser) throw { code: "VAULT_X" };
      return reponses[type];
    },
    rapport,
    publier: () => journal.push({ publie: JSON.parse(JSON.stringify(rapport.portabilite)) }),
    enregistrer: () => {},
  });

  await gestes.sauvegarder();
  await gestes.restaurer({ name: "archive" });
  await gestes.revoquer();
  reponses.refuser = true;
  await gestes.restaurer({ name: "archive" });

  const finals = /^portabilite:(sauvegarde-prete|restauree|revoque|restauration-refusee)/;
  const etats = journal
    .map((entree, rang) => ({ ...entree, rang }))
    .filter((entree) => entree.dit === "portabilite-etat" && finals.test(entree.texte));
  assert.equal(etats.length, 4);
  const geste = { "sauvegarde-prete": "sauvegarde", restauree: "restauration" };
  for (const { texte, rang } of etats) {
    const precedent = journal[rang - 1];
    const nom = texte.split(":")[1].replace(/-refusee$/, "");
    const cle = geste[nom] ?? (nom === "revoque" ? "revocation" : nom);
    assert.ok(precedent.publie !== undefined, `« ${texte} » dit avant la publication`);
    assert.notEqual(precedent.publie[cle], null, `« ${texte} » : le relevé publié ne le porte pas`);
  }
});
