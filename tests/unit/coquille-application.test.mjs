/**
 * L'ÉTAPE 2 et l'ÉTAPE 3 du cycle assemblé, mesurées sans navigateur (#163, ADR 0030).
 *
 *  - le CONSTAT d'exclusivité du volume, et ce qu'il rend de chaque situation du support ;
 *  - la lecture du DESCRIPTEUR d'application servi par l'origine de confiance, et son refus d'une
 *    version qu'il ne connaît pas.
 *
 * Les deux ne touchent le support que par des primitives INJECTÉES : c'est ce qui les rend
 * atteignables par `tools/muter-gardes-cycle-de-vie.mjs`, et une garde qu'aucune mutation ne peut
 * atteindre est une garde qu'on croit sur parole.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  VERDICTS_DEXCLUSIVITE,
  constaterLExclusivite,
} from "../../src/coquille/exclusivite-du-volume.mjs";
import {
  ADRESSE_DESCRIPTEUR,
  adressesDuRuntime,
  descripteurDeManifeste,
  lireLeDescripteur,
} from "../../src/coquille/application-de-reference.mjs";

// --- L'ÉTAPE 2 : le constat d'exclusivité ---------------------------------------------------------

/** Un support qui répond ce qu'on lui dit de répondre. Rien n'est ouvert pour de vrai. */
function support({ present = true, ouvre = true, codeDeRefus = "VAULT_STORAGE_BUSY" } = {}) {
  let ferme = false;
  return {
    observer: async () => ({ present, size: 0 }),
    ouvrir: async () => {
      if (!ouvre) throw Object.assign(new Error("occupé"), { code: codeDeRefus });
      return {
        close() {
          ferme = true;
        },
      };
    },
    aFerme: () => ferme,
  };
}

test("un volume libre rend « disponible », et le handle pris est RELÂCHÉ", async () => {
  const double = support();
  const constat = await constaterLExclusivite({
    volume: "coquille",
    peutOuvrir: true,
    observer: double.observer,
    ouvrir: double.ouvrir,
  });
  assert.equal(constat.verdict, VERDICTS_DEXCLUSIVITE.disponible);
  // Le relâcher n'est pas une politesse : une réservation tenue jusqu'au déverrouillage ferait
  // rendre `VAULT_STORAGE_BUSY` à l'ouverture qui la suit — la coquille se refuserait le volume à
  // elle-même.
  assert.equal(double.aFerme(), true);
});

test("un volume tenu ailleurs rend « refusee », avec le code du support", async () => {
  const double = support({ ouvre: false });
  const constat = await constaterLExclusivite({
    volume: "coquille",
    peutOuvrir: true,
    observer: double.observer,
    ouvrir: double.ouvrir,
  });
  assert.equal(constat.verdict, VERDICTS_DEXCLUSIVITE.refusee);
  assert.equal(constat.code, "VAULT_STORAGE_BUSY");
});

test("un volume ABSENT n'est pas un refus, et rien n'est créé pour le savoir", async () => {
  let ouvertures = 0;
  const constat = await constaterLExclusivite({
    volume: "coquille",
    peutOuvrir: true,
    observer: async () => ({ present: false, size: 0 }),
    ouvrir: async () => {
      ouvertures += 1;
      return { close() {} };
    },
  });
  assert.equal(constat.verdict, VERDICTS_DEXCLUSIVITE.sansVolume);
  assert.equal(ouvertures, 0, "ouvrir pour poser la question CRÉERAIT le fichier");
});

test("un moteur sans OPFS synchrone rend « indisponible » sans rien demander au support", async () => {
  let observations = 0;
  const constat = await constaterLExclusivite({
    volume: "coquille",
    peutOuvrir: false,
    observer: async () => {
      observations += 1;
      return { present: true, size: 0 };
    },
    ouvrir: async () => ({ close() {} }),
  });
  assert.equal(constat.verdict, VERDICTS_DEXCLUSIVITE.indisponible);
  assert.equal(observations, 0);
});

test("un support qui refuse de RÉPONDRE rend « inconnue » : ni oui, ni non", async () => {
  const constat = await constaterLExclusivite({
    volume: "coquille",
    peutOuvrir: true,
    observer: async () => {
      throw Object.assign(new Error("support muet"), { code: "VAULT_STORAGE_SUPPORT_FAILURE" });
    },
    ouvrir: async () => ({ close() {} }),
  });
  assert.equal(constat.verdict, VERDICTS_DEXCLUSIVITE.inconnue);
  assert.equal(constat.code, "VAULT_STORAGE_SUPPORT_FAILURE");
});

test("un handle qui refuse de se FERMER ne transforme pas le constat en refus", async () => {
  const constat = await constaterLExclusivite({
    volume: "coquille",
    peutOuvrir: true,
    observer: async () => ({ present: true, size: 0 }),
    ouvrir: async () => ({
      close() {
        throw new Error("fermeture refusée");
      },
    }),
  });
  // Il a été OBTENU, et c'est la question posée. En faire un refus enverrait l'utilisateur fermer
  // un onglet qui n'existe pas.
  assert.equal(constat.verdict, VERDICTS_DEXCLUSIVITE.disponible);
});

// --- L'ÉTAPE 3 : le descripteur d'application -----------------------------------------------------

/** Un descripteur minimal, de la forme que `tools/build-reference-image/manifest.mjs` écrit. */
function descripteur(champs = {}) {
  return {
    descripteurVersion: 1,
    application: { id: "railsbox-vault-reference", version: "1.0.0" },
    runtime: { version: "0.1.0" },
    disque: { nom: "reference-app.ext2", octets: 524288000 },
    boot: {
      cmdline: "root=/dev/sda rw console=ttyS0",
      memoireOctets: 536870912,
      kernel: "reference-rootfs-vmlinuz",
      initrd: "reference-rootfs-initrd",
      rootfs: "reference-rootfs.ext4",
      bios: "seabios.bin",
      vgaBios: "vgabios.bin",
    },
    prefixeDesArtefacts: "/artifacts/reference-image/",
    ...champs,
  };
}

/** Un `fetch` qui rend ce qu'on lui dit, à l'adresse qu'on attend. */
function serveur({ statut = 200, corps = descripteur(), json = true } = {}) {
  const demandes = [];
  const recuperer = async (adresse) => {
    demandes.push(adresse);
    return {
      ok: statut >= 200 && statut < 300,
      status: statut,
      json: async () => {
        if (!json) throw new SyntaxError("ce n'est pas du JSON");
        return corps;
      },
    };
  };
  return { recuperer, demandes };
}

test("le descripteur est lu à l'adresse que l'origine de confiance sert", async () => {
  const { recuperer, demandes } = serveur();
  const lu = await lireLeDescripteur({ recuperer });
  assert.equal(lu.present, true);
  assert.deepEqual(demandes, [ADRESSE_DESCRIPTEUR]);
});

test("une origine SANS application n'est pas une panne : elle rend son motif", async () => {
  const { recuperer } = serveur({ statut: 404 });
  const lu = await lireLeDescripteur({ recuperer });
  assert.equal(lu.present, false);
  assert.match(lu.motif, /404/);
});

test("un descripteur d'une AUTRE version est refusé, jamais deviné", async () => {
  const { recuperer } = serveur({ corps: descripteur({ descripteurVersion: 2 }) });
  const lu = await lireLeDescripteur({ recuperer });
  assert.equal(lu.present, false);
  assert.match(lu.motif, /version/);
});

test("un descripteur illisible est une absence, pas une exception qui remonte", async () => {
  const { recuperer } = serveur({ json: false });
  const lu = await lireLeDescripteur({ recuperer });
  assert.equal(lu.present, false);
  assert.match(lu.motif, /illisible/);
});

test("un réseau qui refuse est une absence nommée, et non un démarrage qui jette", async () => {
  const lu = await lireLeDescripteur({
    recuperer: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  assert.equal(lu.present, false);
  assert.match(lu.motif, /inatteignable/);
});

test("le manifeste du volume applicatif DÉCLARE l'application et le plus ancien runtime autorisé", () => {
  const manifeste = descripteurDeManifeste(descripteur());
  assert.equal(manifeste.app.id, "railsbox-vault-reference");
  // `minWriter` est la version en cours, le choix le plus strict : c'est celui du banc, et deux
  // chemins qui écrivent le même format n'ont pas à en choisir deux (`SEC-UPDATE-001`).
  assert.equal(manifeste.runtime.minWriter, manifeste.runtime.version);
});

test("les adresses du runtime mêlent l'épinglage v86 et les artefacts de l'image, sans les confondre", async () => {
  const manifesteV86 = {
    artifacts: [
      { name: "libv86.mjs", sha256: "a".repeat(64) },
      { name: "v86.wasm", sha256: "b".repeat(64) },
    ],
  };
  const adresses = await adressesDuRuntime(descripteur(), {
    recuperer: async () => ({ ok: true, status: 200, json: async () => manifesteV86 }),
  });
  // Les deux artefacts v86 sont adressés PAR EMPREINTE (#123) : leur URL nomme ce qu'ils sont.
  assert.match(adresses.lib, /^\/vendor\/v86\/artefacts\//);
  assert.match(adresses.wasm, /^\/vendor\/v86\/artefacts\//);
  // Les cinq autres viennent de l'image de référence, qui a son propre manifeste et son propre
  // épinglage : les servir sous le préfixe v86 les ferait vérifier contre le mauvais manifeste.
  assert.equal(adresses.kernel, "/artifacts/reference-image/reference-rootfs-vmlinuz");
  assert.equal(adresses.rootfs, "/artifacts/reference-image/reference-rootfs.ext4");
});
