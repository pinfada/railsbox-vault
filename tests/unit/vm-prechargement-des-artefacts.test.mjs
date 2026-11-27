/**
 * Le TÉLÉCHARGEMENT ANTICIPÉ (#348) et le VERROU des artefacts.
 *
 * Exigé ici : rien n'est demandé au réseau sans magasin, sans stockage, sans place pour TOUT ranger,
 * quand tout y est déjà, ou quand une autre acquisition tient le verrou ; seuls les artefacts absents
 * sont demandés, et l'échec de l'un n'arrête pas les suivants ; ce qui est rangé l'est vérifié, et
 * l'étape 4 le sert sans rien redemander. Le boot attend le verrou, le dit, et ne l'attend pas sans fin.
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { creerMagasinDArtefacts } from "../../src/vm/magasin-d-artefacts.mjs";
import { loadRuntime } from "../../src/vm/acquisition-des-artefacts.mjs";
import {
  ISSUES_DU_PRECHARGEMENT as ISSUES,
  prechargerLesArtefacts,
} from "../../src/vm/prechargement-des-artefacts.mjs";
import {
  NOM_DU_VERROU_DES_ARTEFACTS,
  siLeVerrouEstLibre,
  sousLeVerrouDesArtefacts,
} from "../../src/vm/verrou-des-artefacts.mjs";
import { PHASES_DU_BOOT, phaseDuBoot, poserLaPhase } from "../../src/vm/phase-du-boot.mjs";
import { adresseDe } from "../../src/v86-adresses.mjs";
import { primitivesEnMemoire } from "./magasin-en-memoire.mjs";

const empreinteDe = (octets) => createHash("sha256").update(octets).digest("hex");
const octetsDe = (taille, motif) => new Uint8Array(taille).fill(motif);

const OCTETS = Object.freeze({
  wasm: octetsDe(64, 1),
  bios: octetsDe(32, 2),
  vgaBios: octetsDe(16, 3),
  kernel: octetsDe(48, 4),
  initrd: octetsDe(80, 5),
  rootfs: octetsDe(4096, 6),
  paquet: octetsDe(2048, 7),
});
const pin = (nom) => ({ sha256: empreinteDe(OCTETS[nom]), octets: OCTETS[nom].byteLength });
/** Le wasm est à l'adresse que son manifeste lui donne ; les autres, sous leur nom. */
const URL_DE = (nom) =>
  nom === "wasm" ? adresseDe("v86.wasm", pin("wasm").sha256) : `/artefacts/${nom}`;
const NOM_A_L_ADRESSE = new Map(Object.keys(OCTETS).map((nom) => [URL_DE(nom), nom]));

const MANIFESTE = {
  artifacts: [{ name: "v86.wasm", sha256: pin("wasm").sha256, bytes: OCTETS.wasm.byteLength }],
};

function runtimeDEpreuve() {
  const morceau = (nom) => ({ url: URL_DE(nom), ...pin(nom), compression: null });
  return {
    manifesteV86: MANIFESTE,
    wasm: URL_DE("wasm"),
    bios: URL_DE("bios"),
    vgaBios: URL_DE("vgaBios"),
    kernel: URL_DE("kernel"),
    initrd: URL_DE("initrd"),
    empreintes: {
      bios: pin("bios"),
      vgaBios: pin("vgaBios"),
      kernel: pin("kernel"),
      initrd: pin("initrd"),
    },
    disqueSysteme: { rootfs: morceau("rootfs"), paquet: morceau("paquet") },
  };
}

/** Un `fetch` d'épreuve : il sert OCTETS, compte chaque demande, et refuse ce qu'on lui nomme. */
function origine({ refuses = [] } = {}) {
  const demandes = [];
  const recuperer = async (url) => {
    const nom = NOM_A_L_ADRESSE.get(String(url)) ?? String(url);
    demandes.push(nom);
    if (refuses.includes(nom) || OCTETS[nom] === undefined) {
      return new Response("interdit", { status: 403 });
    }
    return new Response(OCTETS[nom], { status: 200 });
  };
  return { recuperer, demandes };
}

/** Un gestionnaire de verrous d'épreuve : exclusif, avec `ifAvailable` et `signal`. */
function verrousDEpreuve() {
  const tenus = new Set();
  const attentes = [];
  const liberer = (nom) => {
    tenus.delete(nom);
    const suivante = attentes.findIndex((attente) => attente.nom === nom);
    if (suivante >= 0) attentes.splice(suivante, 1)[0].accorder();
  };
  return {
    tenus,
    async request(nom, options, rappel) {
      if (tenus.has(nom)) {
        if (options.ifAvailable) return rappel(null);
        await new Promise((accorder, refuser) => {
          const attente = { nom, accorder };
          attentes.push(attente);
          options.signal?.addEventListener("abort", () => {
            attentes.splice(attentes.indexOf(attente), 1);
            refuser(options.signal.reason);
          });
        });
      }
      tenus.add(nom);
      try {
        return await rappel({ name: nom });
      } finally {
        liberer(nom);
      }
    },
  };
}

function magasinDEpreuve({ peutAdmettre = async () => true } = {}) {
  const magasin = creerMagasinDArtefacts({ primitives: primitivesEnMemoire(), peutAdmettre });
  // La rétention est celle de `magasin-opfs.mjs` : elle ne joue aucun rôle ici.
  return { ...magasin, retenir: async () => [] };
}

/** L'acquisition de l'étape 4 (`loadRuntime`), sous un `fetch` global d'épreuve. */
async function acquerirALEtape4(magasin, reseau) {
  const avant = globalThis.fetch;
  globalThis.fetch = reseau.recuperer;
  try {
    return await loadRuntime(runtimeDEpreuve(), { magasin });
  } finally {
    globalThis.fetch = avant;
  }
}

const precharger = (options) =>
  prechargerLesArtefacts({
    runtime: runtimeDEpreuve(),
    manifeste: MANIFESTE,
    peutAdmettre: async () => true,
    verrous: verrousDEpreuve(),
    ...options,
  });

test("les sept artefacts sont demandés une fois, vérifiés et rangés ; l'étape 4 les SERT sans rien redemander", async () => {
  const magasin = magasinDEpreuve();
  const avant = origine();
  const bilan = await precharger({ magasin, recuperer: avant.recuperer });
  assert.equal(bilan.issue, ISSUES.fait);
  assert.deepEqual(Object.values(bilan.artefacts), Array(7).fill("admis"));
  assert.deepEqual(avant.demandes.sort(), Object.keys(OCTETS).sort());

  const etape4 = origine();
  const acquis = await acquerirALEtape4(magasin, etape4);
  assert.deepEqual(etape4.demandes, [], "l'étape 4 ne demande rien au réseau");
  assert.equal(acquis.reserveComplete, true, "tout est servi par le magasin");
  assert.deepEqual(Object.values(acquis.petitsArtefacts), Array(5).fill("servi"));
  assert.deepEqual(acquis.disqueSysteme.magasin, { rootfs: "servi", paquet: "servi" });
  assert.equal(acquis.transferredBytes, 0);
});

test("tout est déjà au magasin : rien n'est demandé au réseau", async () => {
  const magasin = magasinDEpreuve();
  await precharger({ magasin, recuperer: origine().recuperer });
  const ensuite = origine();
  assert.deepEqual(await precharger({ magasin, recuperer: ensuite.recuperer }), {
    issue: ISSUES.dejaPresent,
  });
  assert.deepEqual(ensuite.demandes, []);
});

test("une préparation INACHEVÉE reprend : seuls les absents sont demandés", async () => {
  const magasin = magasinDEpreuve();
  const coupee = origine({ refuses: ["rootfs", "paquet"] });
  const premier = await precharger({ magasin, recuperer: coupee.recuperer });
  assert.equal(premier.artefacts.rootfs, "echec", "l'échec de l'un n'arrête pas les autres");
  assert.equal(premier.artefacts.paquet, "echec");
  assert.equal(premier.artefacts.initrd, "admis");
  const reprise = origine();
  const second = await precharger({ magasin, recuperer: reprise.recuperer });
  assert.deepEqual(reprise.demandes.sort(), ["paquet", "rootfs"]);
  assert.deepEqual(second.artefacts, { rootfs: "admis", paquet: "admis" });
});

test("un artefact dont les octets ne sont pas ceux de l'épingle n'est PAS rangé", async () => {
  const magasin = magasinDEpreuve();
  const faux = {
    recuperer: async (url) => {
      const nom = NOM_A_L_ADRESSE.get(String(url));
      const octets = nom === "kernel" ? octetsDe(48, 9) : OCTETS[nom];
      return new Response(octets, { status: 200 });
    },
  };
  const bilan = await precharger({ magasin, recuperer: faux.recuperer });
  assert.equal(bilan.artefacts.kernel, "echec");
  assert.equal(await magasin.contient(pin("kernel")), false);
});

test("sans magasin, sans stockage ou sans place : AUCUNE demande au réseau", async () => {
  const sansMagasin = origine();
  assert.deepEqual(await precharger({ magasin: null, recuperer: sansMagasin.recuperer }), {
    issue: ISSUES.sansMagasin,
  });
  const panne = origine();
  const magasinEnPanne = {
    ...magasinDEpreuve(),
    contient: async () => {
      throw Object.assign(new Error("transitoire"), { name: "UnknownError" });
    },
  };
  assert.deepEqual(await precharger({ magasin: magasinEnPanne, recuperer: panne.recuperer }), {
    issue: ISSUES.stockageIndisponible,
  });
  const sansPlace = origine();
  const demandees = [];
  const bilan = await precharger({
    magasin: magasinDEpreuve(),
    recuperer: sansPlace.recuperer,
    peutAdmettre: async (octets) => {
      demandees.push(octets);
      return false;
    },
  });
  assert.deepEqual(bilan, { issue: ISSUES.placeInsuffisante });
  // La place est demandée pour TOUT, une fois, avant le premier octet.
  const total = Object.values(OCTETS).reduce((somme, octets) => somme + octets.byteLength, 0);
  assert.deepEqual(demandees, [total]);
  const mesureEnPanne = await precharger({
    magasin: magasinDEpreuve(),
    recuperer: sansPlace.recuperer,
    peutAdmettre: async () => {
      throw new Error("estimation indisponible");
    },
  });
  assert.deepEqual(mesureEnPanne, { issue: ISSUES.placeInsuffisante });
  assert.deepEqual([...sansMagasin.demandes, ...panne.demandes, ...sansPlace.demandes], []);
});

test("DEUX ONGLETS : le verrou tenu ailleurs fait renoncer le téléchargement anticipé, sans demande", async () => {
  const verrous = verrousDEpreuve();
  const ici = origine();
  let bilan;
  await verrous.request(NOM_DU_VERROU_DES_ARTEFACTS, {}, async () => {
    bilan = await precharger({ magasin: magasinDEpreuve(), recuperer: ici.recuperer, verrous });
  });
  assert.deepEqual(bilan, { issue: ISSUES.occupe });
  assert.deepEqual(ici.demandes, []);
});

test("le boot ATTEND un téléchargement anticipé en cours, le DIT, puis sert ce qu'il a rangé", async () => {
  const verrous = verrousDEpreuve();
  const magasin = magasinDEpreuve();
  let finirLAvance;
  const avance = new Promise((resoudre) => (finirLAvance = resoudre));
  const anticipe = siLeVerrouEstLibre(
    async () => {
      await avance;
      return precharger({ magasin, recuperer: origine().recuperer, verrous: null });
    },
    { verrous },
  );
  poserLaPhase(PHASES_DU_BOOT.preparation);
  const etapes = [];
  const boot = sousLeVerrouDesArtefacts(
    async () => {
      etapes.push("boot sous le verrou");
      return magasin.contient(pin("rootfs"));
    },
    { verrous, quandIlFautAttendre: () => etapes.push("attend") },
  );
  await new Promise((resoudre) => setTimeout(resoudre, 10));
  assert.deepEqual(etapes, ["attend"], "le boot n'a pas commencé sans le verrou");
  finirLAvance();
  assert.equal((await anticipe).issue, ISSUES.fait);
  assert.equal(await boot, true, "le boot trouve ce que le téléchargement anticipé a rangé");
  assert.deepEqual(etapes, ["attend", "boot sous le verrou"]);
  poserLaPhase(null);
});

test("le boot n'attend pas sans fin : passé l'attente maximale, il acquiert sans le verrou", async () => {
  const verrous = verrousDEpreuve();
  verrous.tenus.add(NOM_DU_VERROU_DES_ARTEFACTS);
  const rendu = await sousLeVerrouDesArtefacts(async () => "acquis sans verrou", {
    verrous,
    attenteMaxMs: 20,
  });
  assert.equal(rendu, "acquis sans verrou");
});

test("une erreur du geste, sous le verrou, remonte telle quelle et n'est jamais rejouée", async () => {
  let essais = 0;
  const geste = async () => {
    essais += 1;
    throw Object.assign(new Error("coupé"), { name: "AbortError" });
  };
  const libre = verrousDEpreuve();
  await assert.rejects(sousLeVerrouDesArtefacts(geste, { verrous: libre }), /coupé/);
  assert.equal(essais, 1);
  const occupe = verrousDEpreuve();
  const tenu = occupe.request(
    NOM_DU_VERROU_DES_ARTEFACTS,
    {},
    () => new Promise((resoudre) => setTimeout(resoudre, 10)),
  );
  await assert.rejects(sousLeVerrouDesArtefacts(geste, { verrous: occupe }), /coupé/);
  await tenu;
  assert.equal(essais, 2, "accordé puis en échec : le geste n'est pas rejoué sans le verrou");
});

test("sans `navigator.locks`, les deux gestes s'exécutent sans verrou, comme avant", async () => {
  assert.equal(await sousLeVerrouDesArtefacts(async () => 1, { verrous: null }), 1);
  assert.equal(await siLeVerrouEstLibre(async () => 2, { verrous: null }), 2);
});

test("la PHASE dit le téléchargement seulement quand des octets viennent du réseau", async () => {
  const magasin = magasinDEpreuve();
  await precharger({ magasin, recuperer: origine().recuperer });
  poserLaPhase(PHASES_DU_BOOT.preparation);
  await acquerirALEtape4(magasin, origine());
  assert.equal(
    phaseDuBoot(),
    PHASES_DU_BOOT.preparation,
    "servi par le magasin : aucun téléchargement",
  );
  // Un seul artefact absent suffit à dire le téléchargement.
  const presqueComplet = magasinDEpreuve();
  await precharger({
    magasin: presqueComplet,
    recuperer: origine({ refuses: ["paquet"] }).recuperer,
  });
  poserLaPhase(PHASES_DU_BOOT.preparation);
  await acquerirALEtape4(presqueComplet, origine());
  assert.equal(phaseDuBoot(), PHASES_DU_BOOT.telechargement);
  const autre = magasinDEpreuve();
  await precharger({ magasin: autre, recuperer: origine({ refuses: ["kernel"] }).recuperer });
  poserLaPhase(PHASES_DU_BOOT.preparation);
  await acquerirALEtape4(autre, origine());
  assert.equal(phaseDuBoot(), PHASES_DU_BOOT.telechargement, "un petit artefact aussi");
  poserLaPhase(null);
});

test("le magasin CONTIENT un artefact complet à sa taille, et rien d'autre", async () => {
  const magasin = magasinDEpreuve();
  assert.equal(await magasin.contient(pin("bios")), false);
  await magasin.admettre({ sha256: pin("bios").sha256, octets: OCTETS.bios });
  assert.equal(await magasin.contient(pin("bios")), true);
  assert.equal(await magasin.contient({ ...pin("bios"), octets: 31 }), false, "autre taille");
  assert.equal(
    await magasin.contient({ sha256: "../bios", octets: 32 }),
    false,
    "pas une empreinte",
  );
});
