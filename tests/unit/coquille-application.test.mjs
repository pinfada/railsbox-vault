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
  compteRenduPublie,
  descripteurDeManifeste,
  formeDuDescripteur,
  installerSiNecessaire,
  lireLeDescripteur,
} from "../../src/coquille/application-de-reference.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { sansCapacite } from "../../src/coquille/contrat-de-messages.mjs";

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

// --- La FORME du descripteur, champ par champ -----------------------------------------------------

test("un descripteur complet est admis", () => {
  assert.deepEqual(formeDuDescripteur(descripteur()), { valide: true, motif: null });
});

test("chaque champ hors forme est refusé, et le refus NOMME le champ", () => {
  // La version seule ne suffit pas : un descripteur d'une version connue fournit six URL, une ligne
  // de commande de noyau et deux grandeurs d'allocation au Worker de confiance (constat 11 de la
  // revue de la PR #171). `connect-src 'self'` est la SECONDE barrière, pas la première.
  const cas = [
    [{ prefixeDesArtefacts: "https://ailleurs.test/" }, /préfixe/],
    [{ prefixeDesArtefacts: "/artifacts/../etc/" }, /préfixe/],
    [{ disque: { nom: "../../etc/passwd", octets: 1024 } }, /nom de disque/],
    [{ disque: { nom: "app.ext2", octets: 0 } }, /taille/],
    [{ disque: { nom: "app.ext2", octets: 1e13 } }, /taille/],
    [{ boot: { ...descripteur().boot, memoireOctets: -1 } }, /mémoire/],
    [{ boot: { ...descripteur().boot, cmdline: "root=/dev/sda `rm -rf /`" } }, /ligne de commande/],
    [{ boot: { ...descripteur().boot, kernel: "../vmlinuz" } }, /kernel/],
  ];
  for (const [champs, motif] of cas) {
    const verdict = formeDuDescripteur(descripteur(champs));
    assert.equal(verdict.valide, false, JSON.stringify(champs));
    assert.match(verdict.motif, motif);
  }
});

// --- L'INSTALLATION : trois issues, et pas une de plus ---------------------------------------------

/** Un support d'installation dont chaque geste est observable. Rien n'est écrit pour de vrai. */
function supportDInstallation({ manifeste = false, volume = false, ecrits = null } = {}) {
  const gestes = [];
  const octets = descripteur().disque.octets;
  return {
    gestes,
    primitives: {
      observer: async (nom) => ({
        present: nom.endsWith(".manifest") ? manifeste : volume,
        size: 0,
      }),
      ouvrir: async (options) => {
        gestes.push(`ouvrir:${options.name}`);
        return {
          identifiantVolume: "0011223344556677889900aabbccddee",
          close: async () => gestes.push("close"),
        };
      },
      verser: async () => {
        gestes.push("verser");
        return ecrits ?? octets;
      },
      revoquer: async (nom) => gestes.push(`revoquer:${nom}`),
      inscrire: async (nom) => gestes.push(`inscrire:${nom}`),
    },
  };
}

/** Une clé de volume factice. Elle est effacée par l'installation, et l'épreuve le vérifie. */
function cleFeinte() {
  const octets = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
  return { octets, cleDeVolume: async () => octets };
}

test("un manifeste voisin PRÉSENT n'est pas réinstallé : rien n'est ouvert ni versé", async () => {
  const support = supportDInstallation({ manifeste: true, volume: true });
  const rendu = await installerSiNecessaire({
    descripteur: descripteur(),
    cleDeVolume: cleFeinte().cleDeVolume,
    ...support.primitives,
  });
  assert.equal(rendu.installee, false);
  assert.deepEqual(support.gestes, [], "réinstaller effacerait ce que le guest a écrit depuis");
});

test("un fichier de volume SANS manifeste est REFUSÉ, jamais écrasé", async () => {
  // Un volume anonyme est soit une installation interrompue, soit autre chose. L'écraser est une
  // décision que la coquille n'a pas à prendre seule (constat 7 de la revue de la PR #171).
  const support = supportDInstallation({ manifeste: false, volume: true });
  const erreur = await installerSiNecessaire({
    descripteur: descripteur(),
    cleDeVolume: cleFeinte().cleDeVolume,
    ...support.primitives,
  }).then(
    () => null,
    (raison) => raison,
  );
  assert.notEqual(erreur, null, "l'installation par-dessus un volume anonyme doit être refusée");
  assert.equal(erreur.code, CODES_REFUS_COQUILLE.volumeApplicatifSansManifeste);
  assert.deepEqual(support.gestes, []);
});

test("un volume ABSENT est installé, et le manifeste est inscrit EN DERNIER", async () => {
  const support = supportDInstallation();
  const cle = cleFeinte();
  const rendu = await installerSiNecessaire({
    descripteur: descripteur(),
    cleDeVolume: cle.cleDeVolume,
    ...support.primitives,
  });
  assert.equal(rendu.installee, true);
  // Le volume naît ANONYME : son manifeste n'est inscrit qu'une fois le disque écrit ET le backend
  // fermé. Une installation interrompue laisse donc un volume non identifié — reconnaissable.
  assert.deepEqual(support.gestes, [
    "revoquer:application",
    "ouvrir:application",
    "verser",
    "close",
    "inscrire:application",
  ]);
  assert.ok(
    cle.octets.every((octet) => octet === 0),
    "la clé de volume ne survit pas à l'ouverture",
  );
});

test("un versement TRONQUÉ ne produit pas un volume qui se croit complet", async () => {
  const support = supportDInstallation({ ecrits: 4096 });
  const erreur = await installerSiNecessaire({
    descripteur: descripteur(),
    cleDeVolume: cleFeinte().cleDeVolume,
    ...support.primitives,
  }).then(
    () => null,
    (raison) => raison,
  );
  assert.notEqual(erreur, null);
  assert.match(erreur.message, /tronqué/);
  assert.ok(!support.gestes.includes("inscrire:application"), "un volume tronqué reste ANONYME");
});

// --- Ce que le démarrage PUBLIE : une liste FERMÉE --------------------------------------------------

test("le compte rendu publié est une liste FERMÉE : ce que le boot rend en plus n'en sort pas", () => {
  // Le compte rendu de boot porte une trentaine de champs, dont le journal du guest et les
  // observations du runtime. Les reposter en bloc ferait grossir un message de la base de confiance
  // au rythme de ce que le guest imprime (constat 8 de la revue de la PR #171).
  const publie = compteRenduPublie({
    volume: "application",
    volumeBytes: 1024,
    bootMilliseconds: 1,
    healthMilliseconds: 2,
    usedSnapshot: false,
    instantane: null,
    timeline: {},
    counts: {},
    generation: {},
    recuperation: null,
    invariantHttpStatus: 200,
    invariantVerdict: {},
    observedRecordId: null,
    observedAttachmentSha256: null,
    boucleOrdonnancement: {},
    rythme: {},
    failures: [],
    // Ce que le boot rend EN PLUS, et qui ne doit pas franchir le canal.
    guestLog: ["une ligne", "deux lignes"],
    observationsRuntime: [{ beaucoup: "de choses" }],
    conforming: true,
    transferredBytes: 999,
  });
  assert.deepEqual(Object.keys(publie).sort(), [
    "bootMs",
    "boucleOrdonnancement",
    "counts",
    "decomposition",
    "enregistrementObserve",
    "generation",
    "instantane",
    "instantaneUtilise",
    "invariantStatut",
    "invariantVerdict",
    "pannes",
    "pieceJointeObservee",
    "recuperation",
    "rythme",
    "santeMs",
    "volume",
    "volumeOctets",
  ]);
  // Les pannes sont un COMPTE, pas la liste : une panne absorbée doit se voir, son contenu
  // appartient au diagnostic du Worker.
  assert.equal(publie.pannes, 0);
});

test("le compte rendu publié FRANCHIT `sansCapacite`, instantané compris", () => {
  // C'est l'épreuve qui manquait, et son absence a coûté un boot de douze minutes : à la
  // réouverture, le compte rendu portait un instantané et des rapports du support dont la forme
  // n'avait été décidée par personne, et `sansCapacite` a refusé la réponse entière sous
  // `VAULT_COQUILLE_CAPACITE_DANS_UN_MESSAGE`. Nommer les champs ne suffisait pas : il fallait
  // borner leur PROFONDEUR et leur nature.
  const publie = compteRenduPublie({
    volume: "application",
    volumeBytes: 536870912,
    bootMilliseconds: 90123.4,
    healthMilliseconds: 88000,
    usedSnapshot: true,
    // Un instantané REPRIS porte une liaison — un objet — et un état qui peut être un tampon.
    instantane: {
      utilise: true,
      motif: null,
      millisecondes: 848,
      liaison: { volume: "abc", sequence: 3, generation: 2 },
      etat: new Uint8Array(8),
    },
    timeline: { acquisitionRuntimeMs: 12, healthMs: 88000, imbrique: { profond: 1 } },
    counts: { write: 42, flush: 2, "flush-ack": 2 },
    generation: { deposeeMaxOctets: 1024, valideeMaxOctets: 512 },
    recuperation: { etat: "verifiee", temoinSequence: 3, details: { encore: "un objet" } },
    invariantHttpStatus: 200,
    invariantVerdict: { status: "conforming", observed: { record: { id: "x" } } },
    observedRecordId: "x",
    observedAttachmentSha256: "y",
    boucleOrdonnancement: { source: "vault-postTask", appels: 12345 },
    rythme: { ticks: 1, fenetreMs: 2 },
    failures: [],
    guestLog: ["une ligne"],
  });
  assert.doesNotThrow(() => sansCapacite(publie));
  // Ce qui a été laissé derrière : la liaison, l'état, et tout objet imbriqué.
  assert.equal(publie.instantane.utilise, true);
  assert.equal(publie.instantane.liaison, undefined);
  assert.equal(publie.instantane.etat, undefined);
  assert.equal(publie.timeline, undefined);
  assert.equal(publie.decomposition.imbrique, undefined);
  assert.equal(publie.recuperation.details, undefined);
  assert.equal(publie.invariantVerdict.observed, undefined);
  assert.equal(publie.invariantVerdict.status, "conforming");
});
