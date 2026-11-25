/**
 * BANC du DÉVERROUILLAGE du Worker de confiance, TEL QU'IL EST SERVI (#311, C5).
 *
 * `public/runtime-worker-deverrouillage.mjs` est chargé sous Node par le crochet de résolution qu'
 * emploie déjà `coquille-portabilite-du-worker.test.mjs` : ses imports `/src/…` sont ceux du serveur.
 * Seules ses PORTES sont remplacées — le support d'enveloppe, le handle exclusif —, par le magasin en
 * mémoire où les modules réels de `src/vm/` écrivent et relisent. Ce que ce banc exécute est le
 * chemin de production : `deverrouiller`, `creerLeCoffre`, `ouvrirLExistante`, l'ouvreur de volume,
 * la revalidation. Aucune épreuve ne relit la SOURCE de ce module.
 *
 * Il fournit aussi le point d'arrêt déterministe des courses : `retenir(nom)` fait attendre la
 * prochaine prise de handle de ce nom, jusqu'à `relacher()` — le pendant exact du harnais navigateur.
 */

import { registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { identifiantDeVolume, suiteDOctets } from "./support-enveloppe-double.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

registerHooks({
  resolve(specifier, context, suivant) {
    if (specifier.startsWith("/src/")) {
      return suivant(pathToFileURL(join(RACINE, specifier)).href, context);
    }
    return suivant(specifier, context);
  },
});

/**
 * Une INSTANCE du module : le module garde son contexte en variables de module — le Worker n'en a
 * qu'un —, si bien que deux « onglets » dans un même processus sont deux évaluations du même fichier.
 * La chaîne de requête fait de chacune une URL distincte, donc une évaluation distincte ; leurs
 * imports `/src/…` restent partagés, comme le sont ceux de deux Workers qui ne partagent que l'OPFS.
 */
let instances = 0;
const chargerLeModule = () =>
  import(`../../public/runtime-worker-deverrouillage.mjs?instance=${(instances += 1)}`);
const { ETATS_DU_VOLUME } = await import("../../src/coquille/etat-de-la-coquille.mjs");
const { ETATS_DE_L_EMPLACEMENT, constaterLEmplacement } =
  await import("../../src/coquille/portabilite-du-coffre.mjs");
const { EN_TETE_OCTETS } = await import("../../src/vm/volume-chiffre-format.mjs");
const { IDENTIFIANT_DU_COFFRE } = await import("../../src/coquille/identites-du-coffre.mjs");
const { derivateurRecuperation } =
  await import("../../src/vm/derivation/derivateur-recuperation.mjs");
const { parametresDeRecuperation, tirerSelDeRecuperation } =
  await import("../../src/vm/derivation/derivateur-recuperation.mjs");
const { preparerEmplacementDerive } =
  await import("../../src/vm/derivation/emplacement-derive.mjs");
const { encoderCode, tirerCodeDeRecuperation } =
  await import("../../src/vm/derivation/code-de-recuperation.mjs");
const { TAILLE_FICHIER_ENVELOPPE } = await import("../../src/vm/enveloppe/fichier-enveloppe.mjs");
const { EMPLACEMENT_FORMAT_V1, ENVELOPPE_FORMAT_V1, TYPES_KEK } =
  await import("../../src/vm/enveloppe/identite-enveloppe.mjs");
const { envelopperSousNonce, importerCleDeDeverrouillage } =
  await import("../../src/vm/enveloppe/modele-reference.mjs");
const { toStorageError } = await import("../../src/vm/opfs-error-mapping.mjs");
const { composerPageAlaMain } = await import("./support-enveloppe-double.mjs");
const { KEK, DEK, magasin, supportDe } = await import("./support-archive-recuperation.mjs");

export {
  ETATS_DE_L_EMPLACEMENT,
  ETATS_DU_VOLUME,
  IDENTIFIANT_DU_COFFRE,
  KEK,
  DEK,
  magasin,
  supportDe,
};

/** Les bancs créés : le registre des volumes ouverts est celui du PROCESSUS, il faut le rendre. */
const crees = [];

/** Referme les volumes que les bancs ont laissés ouverts : à appeler après chaque épreuve. */
export async function fermerLesBancs() {
  for (const w of crees.splice(0)) {
    const backend = w.interne.backend;
    w.interne.backend = null;
    await backend?.close().catch(() => {});
  }
}

/** La KEK de la page, telle que la coquille la remet : une CryptoKey NON extractible. */
export const kekDeLaPage = (octets = KEK) => importerCleDeDeverrouillage(octets);

/**
 * Le banc : un magasin, un Worker réduit à son état, des réponses collectées, et un point d'arrêt.
 * Plusieurs bancs peuvent partager un même `banc` : ce sont alors plusieurs onglets d'une origine.
 *
 * @param {{ banc?: object, emplacement?: string }} options
 */
export async function workerDeverrouillage({ banc = magasin() } = {}) {
  const { brancherLeDeverrouillage, deverrouiller } = await chargerLeModule();
  const reponses = [];
  const refus = [];
  const ouvertures = [];
  const interne = {
    etat: ETATS_DU_VOLUME.verrouille,
    kek: null,
    backend: null,
    eprouves: [],
    version: null,
    barrieres: 0,
    application: null,
    revocation: null,
  };
  /** @type {{ nom: string, promesse: Promise<void>, relacher: () => void, atteint: Promise<void> } | null} */
  let retenue = null;

  const ouvrirLeHandle = async (nom) => {
    ouvertures.push(nom);
    if (retenue !== null && (retenue.nom === "*" || retenue.nom === nom)) {
      const courante = retenue;
      retenue = null;
      courante.signaler();
      await courante.promesse;
    }
    // Comme `openOpfsSyncAccess` : un refus du support est un refus TYPÉ (`VAULT_STORAGE_BUSY`…).
    return banc.store
      .openHandle(nom)
      .catch((cause) => Promise.reject(toStorageError(cause, { operation: "open", volume: nom })));
  };

  brancherLeDeverrouillage({
    interne,
    support: () => supportDe({ ...banc, store: { openHandle: ouvrirLeHandle } }, "coquille"),
    repondre: (type, correlation, corps) => reponses.push({ type, correlation, corps }),
    repondreCode: (code, correlation) => reponses.push({ code, correlation }),
    repondreRefus: (erreur, correlation) => refus.push({ erreur, correlation }),
    // Le VRAI constat de l'emplacement, sur le magasin : sous le verrou, il se refait à chaque appel.
    constater: () =>
      constaterLEmplacement({
        observer: banc.stat,
        lireEnTete: async (nom) =>
          banc.store.sizeOf(nom) > 0 ? banc.store.snapshot(nom).subarray(0, EN_TETE_OCTETS) : null,
        lireVoisin: async (nom) => banc.lire(nom),
      }),
    annoncerLaBarriere: () => {},
    exigerUnVolumeAtteignable: () => {},
    volume: "coquille",
    ouvrirLeHandle,
  });

  const rendu = {
    banc,
    interne,
    reponses,
    refus,
    ouvertures,
    deverrouiller: (message, correlation = "c") => deverrouiller(message, correlation),
    /** Retient la PROCHAINE prise de handle de ce nom (`"*"` : la première), jusqu'à `relacher()`. */
    retenir(nom) {
      let relacher;
      let signaler;
      const promesse = new Promise((fin) => {
        relacher = fin;
      });
      const atteint = new Promise((fin) => {
        signaler = fin;
      });
      retenue = { nom, promesse, relacher, signaler, atteint };
      return { atteint, relacher };
    },
  };
  crees.push(rendu);
  return rendu;
}

/** Un message de déverrouillage par la PHRASE : la KEK arrive déjà dérivée, comme la page la remet. */
export async function messageDePhrase({
  kek = KEK,
  identifiant = "a1a1a1a1a1a1a1a1",
  versionMinimale,
} = {}) {
  return {
    moyen: "phrase",
    kek: await kekDeLaPage(kek),
    parametresHex: "",
    identifiantEmplacement: identifiant,
    ...(versionMinimale === undefined ? {} : { versionMinimale }),
  };
}

/** Un message de déverrouillage par le CODE. */
export const messageDeCode = (code, versionMinimale) => ({
  moyen: "recuperation",
  code,
  ...(versionMinimale === undefined ? {} : { versionMinimale }),
});

// --- Une enveloppe en page v1 ---------------------------------------------------------------------

const ID_PHRASE = "a1a1a1a1a1a1a1a1";

/**
 * Pose, sur `coquille.cles`, une enveloppe en page **v1** : un emplacement `harnais` sous la KEK de la
 * page et, au choix, un emplacement de RÉCUPÉRATION sous un code rendu une fois. C'est le chemin que
 * `ouvrirEnveloppe` migre en écrivant — donc celui qu'il ne faut PAS prendre avant le handle.
 *
 * @param {{ ecrire: Function }} banc
 * @param {{ avecCode?: boolean, dek?: Uint8Array, kek?: Uint8Array, version?: number }} options
 * @returns {Promise<{ code: string | null, identifiantPhrase: string }>}
 */
export async function poserUneEnveloppeV1(
  banc,
  { avecCode = false, dek = DEK, kek = KEK, version = 7 } = {},
) {
  const emplacements = [];
  const sceller = async ({ cle, identifiantEmplacement, typeKek, parametres, rang }) => {
    const scelle = await envelopperSousNonce({
      kek: cle,
      emplacement: {
        identifiantVolume: IDENTIFIANT_DU_COFFRE,
        identifiantEmplacement,
        formatVersion: EMPLACEMENT_FORMAT_V1,
        typeKek,
        parametres,
      },
      dek,
      nonce: suiteDOctets(0x10 * (rang + 1), 12),
    });
    emplacements.push({
      identifiantEmplacement,
      typeKek,
      parametres,
      nonce: scelle.nonce,
      dekEnveloppee: scelle.chiffre,
      etiquette: scelle.etiquette,
    });
  };
  await sceller({
    cle: await importerCleDeDeverrouillage(kek),
    identifiantEmplacement: ID_PHRASE,
    typeKek: TYPES_KEK.harnais,
    parametres: suiteDOctets(0xe0, 8),
    rang: 0,
  });
  let code = null;
  if (avecCode) {
    code = encoderCode(tirerCodeDeRecuperation());
    const parametres = parametresDeRecuperation({ sel: tirerSelDeRecuperation() });
    const prepare = await preparerEmplacementDerive({
      identifiantVolume: IDENTIFIANT_DU_COFFRE,
      derivateur: derivateurRecuperation(),
      parametres,
      geste: { code },
    });
    await sceller({
      cle: prepare.kek,
      identifiantEmplacement: prepare.identifiantEmplacement,
      typeKek: prepare.typeKek,
      parametres,
      rang: 1,
    });
  }
  const page = await composerPageAlaMain({
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
    version,
    dek,
    emplacements,
    nonce: suiteDOctets(0x99, 12),
    formatVersion: ENVELOPPE_FORMAT_V1,
  });
  const fichier = new Uint8Array(TAILLE_FICHIER_ENVELOPPE);
  fichier.set(page, 0);
  await banc.ecrire("coquille.cles", fichier);
  return { code, identifiantPhrase: ID_PHRASE };
}

export { identifiantDeVolume };
