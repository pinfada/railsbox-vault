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
  signatureDInstallationInterrompue,
} from "../../src/coquille/application-de-reference.mjs";
import {
  reprendreLInstallation,
  reprendreSiSignatureConfirmee,
} from "../../src/coquille/reprise-installation.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { sansCapacite } from "../../src/coquille/contrat-de-messages.mjs";
import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { daterLaCreation, openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { generationJournalName, manifestSidecarName } from "../../src/vm/opfs-sync-access.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

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

/** L'empreinte qu'un versement feint rend. Sa valeur importe peu ; ce qui compte est qu'elle PASSE. */
const EMPREINTE_FEINTE = "f".repeat(64);

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
        // Le versement rend ce qu'il a écrit ET l'empreinte du fichier qu'il laisse (#181, revue de
        // sécurité de la PR #184) : c'est elle que la datation confrontera.
        return { ecrits: ecrits ?? octets, empreinte: EMPREINTE_FEINTE };
      },
      // DATER la création (#181) : le versement a écrit le fichier entier hors transaction, donc
      // périmé la racine initiale de la naissance. Le geste est INJECTÉ comme les autres — sans
      // quoi cette suite ouvrirait un vrai handle OPFS, ce qu'aucun test unitaire ne peut faire.
      dater: async (options) => {
        gestes.push(`dater:${options.name}:${options.empreinteVersee}`);
        return { etat: "initialisee", racineInitiale: true, motifDeLaRacine: "creation" };
      },
      revoquer: async (nom) => gestes.push(`revoquer:${nom}`),
      inscrire: async (nom) => gestes.push(`inscrire:${nom}`),
    },
  };
}

/**
 * Une clé de volume factice. Elle est effacée par l'installation, et l'épreuve le vérifie.
 *
 * `cleDeVolume` rend une COPIE fraîche à chaque appel — comme le ferait un vrai fournisseur — et
 * jamais le même tableau deux fois : `installerSiNecessaire` appelle `cleDeVolume` UNE fois dans
 * `verserLeDisque`, UNE autre dans `daterLaCreationDuVolume`, et chacun l'efface dans son propre
 * `finally`. Rendre le MÊME tableau aux deux aurait laissé le second effacement masquer l'absence du
 * premier — c'est exactement ce qu'une mutation qui retire le `finally` de `verserLeDisque` a
 * révélé : le mutant survivait, la clé étant de toute façon effacée un peu plus tard, par un autre
 * appelant, sur le même tableau partagé.
 */
function cleFeinte() {
  const rendues = [];
  return {
    rendues,
    cleDeVolume: async () => {
      const octets = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
      rendues.push(octets);
      return octets;
    },
  };
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
    // La création est DATÉE avant que le manifeste ne la déclare (#181) : un volume déclaré complet
    // porte toujours une racine, sans quoi le premier boot le refuserait. Et elle reçoit
    // l'EMPREINTE que le versement a rendue : sans elle, la datation bénirait ce qu'elle trouve.
    `dater:application:${EMPREINTE_FEINTE}`,
    "inscrire:application",
  ]);
  // DEUX copies sont rendues — une pour `verserLeDisque`, une pour `daterLaCreationDuVolume` — et
  // chacune doit être effacée par SON PROPRE appelant : la vérifier sur une seule masquerait
  // l'oubli de l'autre.
  assert.equal(
    cle.rendues.length,
    2,
    "verserLeDisque et daterLaCreationDuVolume appellent chacun cleDeVolume",
  );
  for (const [rang, octets] of cle.rendues.entries()) {
    assert.ok(
      octets.every((octet) => octet === 0),
      `la copie ${rang} de la clé de volume ne survit pas à l'ouverture`,
    );
  }
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

// --- LA FENÊTRE entre le versement et la datation (#181, revue de sécurité de la PR #184) ---------
//
// `installerSiNecessaire` verse le disque hors transaction, FERME le backend, puis date. Entre les
// deux, le fichier de volume n'est tenu par personne, et un adversaire qui sait écrire dans l'OPFS
// (ADR 0019 § 6.9) peut y poser un AUTRE fichier. La datation le bénissait alors sous le motif
// `creation` — celui qui, par construction, ne prouve rien —, l'installation se déclarait réussie, et
// l'ouverture suivante rendait EN CLAIR un état que ce volume n'a jamais produit.
//
// Ces trois épreuves montent le vrai `installerSiNecessaire` sur le vrai `daterLaCreation`, sur le
// double déterministe de #6 : le support est injecté, tout le reste est le produit.

const TAILLE_DEPREUVE = 8 * SECTOR_SIZE;
const ID_DEPREUVE = "aabbccddeeff00112233445566778899";
const CLE_DEPREUVE = Uint8Array.from({ length: 32 }, (_, rang) => rang + 1);

/** Un secteur entier rempli d'un motif reconnaissable. */
function secteurDe(motif) {
  return new Uint8Array(SECTOR_SIZE).fill(motif);
}

/** Le descripteur de ces épreuves : un disque assez petit pour tenir dans un double. */
function descripteurDepreuve() {
  return descripteur({ disque: { nom: "app.ext2", octets: TAILLE_DEPREUVE } });
}

/**
 * FABRIQUE, dans un magasin à part, le fichier d'un volume ÉTRANGER que l'adversaire posera.
 *
 * Il porte le MÊME identifiant et la même clé que le volume applicatif : c'est le pire cas: rien de
 * ce qui vérifie l'identité ou la géométrie ne mordra, et seule la confrontation des empreintes peut
 * refuser. Ses secteurs portent `0xee` et `0xef` — l'état de l'adversaire, exactement comme dans la
 * reproduction du relecteur.
 */
async function fichierEtranger() {
  const autre = createSyncAccessStore();
  const backend = await openOpfsVolume({
    name: "etranger",
    size: TAILLE_DEPREUVE,
    cle: CLE_DEPREUVE,
    identifiantVolume: ID_DEPREUVE,
    openHandle: autre.openHandle,
    transactionnel: false,
  });
  try {
    for (let rang = 0; rang < TAILLE_DEPREUVE / SECTOR_SIZE; rang += 1) {
      await backend.write(rang * SECTOR_SIZE, secteurDe(rang === 0 ? 0xee : 0xef));
    }
    await backend.flush();
  } finally {
    await backend.close();
  }
  return autre.snapshot("etranger");
}

/**
 * Joue l'INSTALLATION réelle sur un magasin double, avec le geste de l'adversaire injecté à
 * l'endroit exact où la fenêtre s'ouvre : entre le versement fermé et la datation.
 *
 * `verser` est le versement du produit sans son flux HTTP — il écrit le fichier entier par le
 * backend, franchit la barrière, et rend l'empreinte SOUS SON EXCLUSIVITÉ, comme
 * `verserFluxDansVolume`.
 */
async function installerAvec({ store, adversaire = null, versement = "complet" }) {
  return installerSiNecessaire({
    descripteur: descripteurDepreuve(),
    cleDeVolume: async () => CLE_DEPREUVE.slice(),
    observer: async (nom) => ({ present: store.sizeOf(nom) > 0, size: store.sizeOf(nom) }),
    ouvrir: (options) =>
      openOpfsVolume({
        ...options,
        identifiantVolume: ID_DEPREUVE,
        openHandle: store.openHandle,
      }),
    verser: async (backend) => {
      for (let rang = 0; rang < TAILLE_DEPREUVE / SECTOR_SIZE; rang += 1) {
        await backend.write(rang * SECTOR_SIZE, secteurDe(0x11));
      }
      await backend.flush();
      // « versement d'avant #181 » : il ne rend qu'un compte, et n'atteste donc rien.
      if (versement === "sans-empreinte") return TAILLE_DEPREUVE;
      return { ecrits: TAILLE_DEPREUVE, empreinte: await backend.empreinteDuFichier() };
    },
    dater: async (options) => {
      if (adversaire !== null) await adversaire();
      return daterLaCreation({ ...options, openHandle: store.openHandle });
    },
    revoquer: async () => {},
    inscrire: async () => {},
  });
}

/** Rouvre le volume applicatif comme le boot le ferait, et rend ses deux premiers secteurs. */
async function ouvrirLApplication(store) {
  const backend = await openOpfsVolume({
    name: "application",
    size: TAILLE_DEPREUVE,
    cle: CLE_DEPREUVE,
    identifiantVolume: ID_DEPREUVE,
    openHandle: store.openHandle,
  });
  try {
    return {
      rapport: backend.generation.rapport,
      s0: await backend.read(0, SECTOR_SIZE),
      s1: await backend.read(SECTOR_SIZE, SECTOR_SIZE),
    };
  } finally {
    await backend.close();
  }
}

test("ÉPREUVE ROUGE — le fichier SUBSTITUÉ entre le versement et la datation est REFUSÉ", async () => {
  // La reproduction du relecteur, mot pour mot : l'adversaire écrit le fichier d'un autre volume
  // ENTRE la fermeture du backend versé et la datation. Rendu attendu avant la correction :
  // `{ installee: true }`, puis une ouverture normale rendant `0xee` / `0xef`.
  const store = createSyncAccessStore();
  const etranger = await fichierEtranger();
  const adversaire = async () => {
    const handle = await store.openHandle("application");
    try {
      handle.truncate(etranger.byteLength);
      handle.write(etranger, { at: 0 });
      handle.flush();
    } finally {
      handle.close();
    }
  };

  const erreur = await installerAvec({ store, adversaire }).then(
    () => null,
    (raison) => raison,
  );
  assert.notEqual(erreur, null, "l'installation ne peut pas se déclarer réussie");
  assert.ok(
    isStorageError(erreur, STORAGE_ERROR_CODES.creationNonConfirmee),
    `refus attendu, reçu ${erreur?.code}`,
  );

  // Et le volume ne s'ouvre PAS : aucune racine n'a été écrite, donc rien ne rend le clair de
  // l'adversaire. C'est la moitié qui compte — un refus qui laisserait le volume ouvrable ne
  // refuserait rien.
  const apres = await ouvrirLApplication(store).then(
    (ouvert) => ouvert,
    (raison) => raison,
  );
  assert.ok(
    apres instanceof Error,
    `le volume substitué ne doit pas s'ouvrir (${apres?.rapport?.etat})`,
  );
});

test("TÉMOIN POSITIF — une installation légitime est datée, et rend ce que le produit a versé", async () => {
  const store = createSyncAccessStore();
  const rendu = await installerAvec({ store });
  assert.equal(rendu.installee, true);

  const ouvert = await ouvrirLApplication(store);
  assert.equal(ouvert.rapport.racineInitiale, false, "chemin normal : une racine décide");
  assert.ok(
    ouvert.s0.every((octet) => octet === 0x11),
    "le volume rend ce que le produit a versé",
  );
  assert.ok(ouvert.s1.every((octet) => octet === 0x11));
});

test("un versement qui n'ATTESTE rien ne fait pas dater : l'installation est REFUSÉE", async () => {
  // La garde qui relève l'appelant d'avant #181. Traiter « aucune empreinte » comme « rien à
  // confronter, donc autorisé » rouvrirait la fenêtre pour quiconque oublie un paramètre.
  const store = createSyncAccessStore();
  const erreur = await installerAvec({ store, versement: "sans-empreinte" }).then(
    () => null,
    (raison) => raison,
  );
  assert.ok(isStorageError(erreur, STORAGE_ERROR_CODES.creationNonConfirmee));
});

// --- LA SIGNATURE d'une installation interrompue, et le geste qui la répare (#173) -----------------
//
// Trois conditions, et les trois ensemble : aucun manifeste, la taille EXACTE que le descripteur
// annonce, un journal qui ne porte QUE la racine de naissance. Ces épreuves montent le vrai
// `installerSiNecessaire`, la vraie `signatureDInstallationInterrompue` et le vrai
// `reprendreLInstallation` sur le double déterministe — le même montage que les trois épreuves de
// la fenêtre de datation, ci-dessus.

/** Observateur qui STATUE sans jamais créer un fichier, sur le store réel. */
function observerDuStore(store) {
  return async (nom) => ({ present: store.sizeOf(nom) > 0, size: store.sizeOf(nom) });
}

/** Ouvre le volume applicatif comme le versement le ferait, SANS le refermer ni le dater. */
async function ouvrirSansAchever(store) {
  return openOpfsVolume({
    name: "application",
    size: TAILLE_DEPREUVE,
    cle: CLE_DEPREUVE,
    identifiantVolume: ID_DEPREUVE,
    openHandle: store.openHandle,
    transactionnel: false,
    clotureParDatation: true,
  });
}

test("signatureDInstallationInterrompue : VRAI à la naissance, avant tout versement", async () => {
  const store = createSyncAccessStore();
  const backend = await ouvrirSansAchever(store);
  await backend.close();

  const signature = await signatureDInstallationInterrompue({
    nom: "application",
    octetsAnnonces: TAILLE_DEPREUVE,
    observer: observerDuStore(store),
    openHandle: store.openHandle,
  });
  assert.equal(signature.interrompue, true, signature.motif);
});

test("signatureDInstallationInterrompue : FAUX si la taille du volume diffère — mutant « taille ignorée »", async () => {
  // Le volume est bien à l'état de naissance seule, mais le descripteur annonce une AUTRE taille :
  // ce n'est pas CE volume-là, et l'ignorer offrirait un geste de réparation sur un volume que
  // personne n'a demandé d'installer sous cette taille.
  const store = createSyncAccessStore();
  const backend = await ouvrirSansAchever(store);
  await backend.close();

  const signature = await signatureDInstallationInterrompue({
    nom: "application",
    octetsAnnonces: TAILLE_DEPREUVE + SECTOR_SIZE,
    observer: observerDuStore(store),
    openHandle: store.openHandle,
  });
  assert.equal(signature.interrompue, false);
  assert.match(signature.motif, /octets/);
});

test("signatureDInstallationInterrompue : FAUX sur un volume déjà EN SERVICE — autre chose", async () => {
  const store = createSyncAccessStore();
  const backend = await ouvrirSansAchever(store);
  await backend.write(0, secteurDe(0x11));
  await backend.flush();
  const empreinte = await backend.empreinteDuFichier();
  await backend.close();
  await daterLaCreation({
    name: "application",
    cle: CLE_DEPREUVE,
    identifiantVolume: ID_DEPREUVE,
    empreinteVersee: empreinte,
    openHandle: store.openHandle,
  });
  const reouvert = await openOpfsVolume({
    name: "application",
    size: TAILLE_DEPREUVE,
    cle: CLE_DEPREUVE,
    identifiantVolume: ID_DEPREUVE,
    openHandle: store.openHandle,
  });
  await reouvert.write(0, secteurDe(0x22));
  await reouvert.flush();
  await reouvert.close();

  const signature = await signatureDInstallationInterrompue({
    nom: "application",
    octetsAnnonces: TAILLE_DEPREUVE,
    observer: observerDuStore(store),
    openHandle: store.openHandle,
  });
  assert.equal(signature.interrompue, false);
});

test("constaterLInstallation : un manifeste PRÉSENT n'est jamais soumis à la signature — mutant « manifeste ignoré »", async () => {
  // Le volume est à l'état de naissance seule ET de la bonne taille — il PORTERAIT la signature s'il
  // était examiné. Mais un manifeste est présent : `installerSiNecessaire` doit rendre « déjà
  // installé » SANS jamais consulter la signature, encore moins refuser.
  const store = createSyncAccessStore();
  const backend = await ouvrirSansAchever(store);
  await backend.close();
  const handle = await store.openHandle(manifestSidecarName("application"));
  handle.write(new Uint8Array([1]), { at: 0 });
  handle.flush();
  handle.close();

  const rendu = await installerSiNecessaire({
    descripteur: descripteurDepreuve(),
    cleDeVolume: async () => CLE_DEPREUVE.slice(),
    observer: observerDuStore(store),
    openHandle: store.openHandle,
  });
  assert.equal(rendu.installee, false);
});

test("le refus « sans manifeste » PORTE la signature dans son contexte", async () => {
  const store = createSyncAccessStore();
  const backend = await ouvrirSansAchever(store);
  await backend.close();

  const erreur = await installerSiNecessaire({
    descripteur: descripteurDepreuve(),
    cleDeVolume: async () => CLE_DEPREUVE.slice(),
    observer: observerDuStore(store),
    openHandle: store.openHandle,
  }).then(
    () => null,
    (raison) => raison,
  );
  assert.ok(erreur instanceof Error);
  assert.equal(erreur.code, CODES_REFUS_COQUILLE.volumeApplicatifSansManifeste);
  assert.equal(erreur.installationInterrompue, true);
});

test("REPRENDRE l'installation : retire le volume orphelin et ses voisins, puis réinstalle", async () => {
  const store = createSyncAccessStore();
  const backend = await ouvrirSansAchever(store);
  await backend.write(0, secteurDe(0x99));
  await backend.flush();
  // Coupure ICI : le versement ferme (comme `verserLeDisque` le fait toujours), mais rien ne
  // date ni n'inscrit le manifeste ensuite. C'est l'installation interrompue.
  await backend.close();
  assert.ok(
    store.sizeOf(generationJournalName("application")) > 0,
    "le journal de naissance existe",
  );
  assert.equal(store.sizeOf(manifestSidecarName("application")) > 0, false, "aucun manifeste");

  // `retirer` remplace `removeOpfsVolume` (qui exige un Worker dédié) par l'équivalent sur le
  // double : la cascade sur les voisins réels est éprouvée ailleurs
  // (`tests/unit/opfs-sync-access.test.mjs`), ce que CETTE épreuve mesure est que le geste retire
  // AVANT de réinstaller, et ne réinstalle QUE le volume nommé.
  const retirerDuStore = async (nom) => {
    for (const cible of [nom, generationJournalName(nom)]) {
      if (store.sizeOf(cible) === 0) continue;
      const handle = await store.openHandle(cible);
      try {
        handle.truncate(0);
        handle.flush();
      } finally {
        handle.close();
      }
    }
  };

  const rendu = await reprendreLInstallation({
    descripteur: descripteurDepreuve(),
    cleDeVolume: async () => CLE_DEPREUVE.slice(),
    retirer: retirerDuStore,
    observer: observerDuStore(store),
    openHandle: store.openHandle,
    ouvrir: (options) =>
      openOpfsVolume({ ...options, identifiantVolume: ID_DEPREUVE, openHandle: store.openHandle }),
    verser: async (backendNeuf) => {
      for (let rang = 0; rang < TAILLE_DEPREUVE / SECTOR_SIZE; rang += 1) {
        await backendNeuf.write(rang * SECTOR_SIZE, secteurDe(0x33));
      }
      await backendNeuf.flush();
      return { ecrits: TAILLE_DEPREUVE, empreinte: await backendNeuf.empreinteDuFichier() };
    },
    dater: async (options) => daterLaCreation({ ...options, openHandle: store.openHandle }),
    revoquer: async () => {},
    inscrire: async () => {},
  });

  assert.equal(rendu.installee, true);
  assert.ok(
    store.sizeOf(manifestSidecarName("application")) === 0,
    "l'inscription est un « inscrire » feint",
  );
  // TÉMOIN : le volume réinstallé rend ce que la RÉINSTALLATION a versé, pas les octets orphelins.
  const relu = await openOpfsVolume({
    name: "application",
    size: TAILLE_DEPREUVE,
    cle: CLE_DEPREUVE,
    identifiantVolume: ID_DEPREUVE,
    openHandle: store.openHandle,
  });
  try {
    assert.ok((await relu.read(0, SECTOR_SIZE)).every((octet) => octet === 0x33));
  } finally {
    await relu.close();
  }
});

test("reprendreSiSignatureConfirmee : REFUSE sans rien retirer si un manifeste est présent", async () => {
  const store = createSyncAccessStore();
  const backend = await ouvrirSansAchever(store);
  await backend.close();
  const handle = await store.openHandle(manifestSidecarName("application"));
  handle.write(new Uint8Array([1]), { at: 0 });
  handle.flush();
  handle.close();
  let retire = false;

  const resultat = await reprendreSiSignatureConfirmee({
    descripteur: descripteurDepreuve(),
    cleDeVolume: async () => CLE_DEPREUVE.slice(),
    observer: observerDuStore(store),
    openHandle: store.openHandle,
    retirer: async () => {
      retire = true;
    },
  });
  assert.equal(resultat.reprise, false);
  assert.match(resultat.motif, /déjà installée/);
  assert.equal(retire, false, "un manifeste présent ne retire RIEN");
});

test("reprendreSiSignatureConfirmee : REFUSE sans rien retirer si la signature ne tient plus", async () => {
  // Le volume est « autre chose » : déjà EN SERVICE. Revérifier ICI est ce qui empêche un bouton
  // resté affiché après coup — un clic tardif, une seconde vue de la page — de retirer un volume
  // qui a cessé d'être orphelin entre-temps.
  const store = createSyncAccessStore();
  const backend = await ouvrirSansAchever(store);
  await backend.write(0, secteurDe(0x11));
  await backend.flush();
  const empreinte = await backend.empreinteDuFichier();
  await backend.close();
  await daterLaCreation({
    name: "application",
    cle: CLE_DEPREUVE,
    identifiantVolume: ID_DEPREUVE,
    empreinteVersee: empreinte,
    openHandle: store.openHandle,
  });
  const reouvert = await openOpfsVolume({
    name: "application",
    size: TAILLE_DEPREUVE,
    cle: CLE_DEPREUVE,
    identifiantVolume: ID_DEPREUVE,
    openHandle: store.openHandle,
  });
  await reouvert.write(0, secteurDe(0x22));
  await reouvert.flush();
  await reouvert.close();
  let retire = false;

  const resultat = await reprendreSiSignatureConfirmee({
    descripteur: descripteurDepreuve(),
    cleDeVolume: async () => CLE_DEPREUVE.slice(),
    observer: observerDuStore(store),
    openHandle: store.openHandle,
    retirer: async () => {
      retire = true;
    },
  });
  assert.equal(resultat.reprise, false);
  assert.match(resultat.motif, /pas la signature/);
  assert.equal(retire, false);
});

test("reprendreSiSignatureConfirmee : REPREND quand la signature tient", async () => {
  const store = createSyncAccessStore();
  const backend = await ouvrirSansAchever(store);
  await backend.write(0, secteurDe(0x99));
  await backend.flush();
  await backend.close();

  const resultat = await reprendreSiSignatureConfirmee({
    descripteur: descripteurDepreuve(),
    cleDeVolume: async () => CLE_DEPREUVE.slice(),
    observer: observerDuStore(store),
    openHandle: store.openHandle,
    retirer: async (nom) => {
      for (const cible of [nom, generationJournalName(nom)]) {
        if (store.sizeOf(cible) === 0) continue;
        const h = await store.openHandle(cible);
        try {
          h.truncate(0);
          h.flush();
        } finally {
          h.close();
        }
      }
    },
    ouvrir: (options) =>
      openOpfsVolume({ ...options, identifiantVolume: ID_DEPREUVE, openHandle: store.openHandle }),
    verser: async (backendNeuf) => {
      for (let rang = 0; rang < TAILLE_DEPREUVE / SECTOR_SIZE; rang += 1) {
        await backendNeuf.write(rang * SECTOR_SIZE, secteurDe(0x44));
      }
      await backendNeuf.flush();
      return { ecrits: TAILLE_DEPREUVE, empreinte: await backendNeuf.empreinteDuFichier() };
    },
    dater: async (options) => daterLaCreation({ ...options, openHandle: store.openHandle }),
    revoquer: async () => {},
    inscrire: async () => {},
  });
  assert.equal(resultat.reprise, true);
  assert.equal(resultat.installation.installee, true);
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
