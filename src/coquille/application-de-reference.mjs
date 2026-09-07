// L'ÉTAPE 3 du cycle de vie, DANS le Worker de confiance : le backend, puis la VM (#163, ADR 0030).
//
// Jusqu'ici, faire booter Rails sur un volume OPFS était un BANC — `public/vm/reference-banc.mjs` et
// ses phases, pilotés par `tests/e2e/`. La table d'avancement de `docs/architecture.md` le disait
// sans détour : « étape 3 — banc, la VM n'est pas dans la coquille ». Ce module l'y amène, et il
// n'en réécrit rien : le boot est celui de `src/vm/boot-de-reference.mjs`, déplacé et non recopié.
//
// ## Ce que la coquille APPORTE, et que le banc n'avait pas
//
//  - **la clé.** Le banc ouvre le volume du guest sous le jeton du harnais (`cle-du-banc.mjs`) ; la
//    coquille l'ouvre sous la clé développée de son enveloppe (ADR 0020, #162). C'est la seule
//    différence entre les deux chemins, et c'est pour elle que `ouvrirLeVolumeDuGuest` est injecté ;
//  - **l'ordre.** Un boot demandé avant l'ouverture du backend est refusé par
//    `VAULT_COQUILLE_ETAPE_HORS_ORDRE` (`cycle-de-vie.mjs`), et non découvert à mi-chemin ;
//  - **l'installation.** Un coffre neuf ne contient pas l'application : la coquille l'y VERSE au
//    premier démarrage, dans un volume qui naît ANONYME et ne devient identifié qu'une fois le
//    disque écrit et flushé — la règle de `phasePrepare`, tenue ici aussi.
//
// ## Deux volumes, un seul coffre — et pourquoi
//
// La coquille tient le volume `coquille` depuis #161 : trente-deux secteurs, l'état et le compte de
// barrières. Le disque de l'application est un AUTRE volume, `application`, et ce n'est pas une
// commodité :
//
//  - un volume déclare sa taille à sa NAISSANCE et ne grandit pas (`opfs-volume-ouverture.mjs`,
//    « fournie, elle doit correspondre exactement »). Le coffre est créé au premier geste de
//    déverrouillage, bien avant qu'on sache si une application sera installée ;
//  - l'ADR 0018 range déjà les applications par volume, et c'est la forme vers laquelle #24 va ;
//  - les deux sont scellés sous la MÊME clé de volume, développée de la MÊME enveloppe, avec des
//    identifiants de volume DISTINCTS — sans quoi un secteur de l'un se rejouerait dans l'autre
//    (ADR 0015, données associées).
//
// L'identifiant du volume applicatif n'est pas une constante : il est TIRÉ à sa création par
// l'ouvreur et inscrit dans son manifeste voisin, qui en est ensuite la source (ADR 0016).

import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { openOpfsVolume } from "../vm/opfs-block-backend.mjs";
import { manifestSidecarName, statOpfsVolume } from "../vm/opfs-sync-access.mjs";
import {
  openVolumeForWrite,
  revokeVolumeManifest,
  writeVolumeManifest,
} from "../vm/opfs-volume-open.mjs";
import { chargerAdressesV86, exigerAdresse } from "../v86-adresses.mjs";
import { verserFluxDansVolume } from "../vm/versement-de-disque.mjs";
import { VOLUME_ALGORITHM, createManifest } from "../vm/volume-manifest.mjs";

/**
 * Où l'origine de CONFIANCE sert le descripteur de son application.
 *
 * Il est écrit par `tools/build-reference-image/manifest.mjs`, dérivé du manifeste d'image, et il ne
 * porte que du public : des noms d'artefacts, des tailles, une ligne de commande. La coquille ne
 * peut pas lire `tools/` — son origine ne sert que `public/`, `src/`, `vendor/` et `artifacts/` —,
 * et le lui faire passer par un paramètre d'URL rouvrirait exactement la porte que #162 a fermée.
 */
export const ADRESSE_DESCRIPTEUR = "/artifacts/application.json";

/** Version de descripteur que ce module sait lire. Une autre est refusée, jamais devinée. */
export const DESCRIPTEUR_VERSION_ATTENDUE = 1;

/**
 * Le NOM d'un artefact servi : une lettre ou un chiffre, puis des caractères de nom de fichier.
 *
 * Il entre dans une URL que le Worker de confiance va chercher. La CSP `connect-src 'self'` est la
 * SECONDE barrière — elle refuserait une origine étrangère —, mais une garde qui n'existe que dans
 * l'en-tête n'est pas une garde du produit : un nom porteur de `..` ou d'une barre oblique ferait
 * sortir la requête de son préfixe sans que la politique y voie quoi que ce soit.
 */
const NOM_DARTEFACT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/** Le PRÉFIXE servi : un chemin absolu, sans remontée, sans schéma, sans autorité. */
const PREFIXE_SERVI = /^\/[A-Za-z0-9][A-Za-z0-9._/-]{0,127}\/$/;

/**
 * La LIGNE DE COMMANDE du guest, sur un alphabet clos et bornée.
 *
 * Elle est passée telle quelle à l'émulateur, qui la donne au noyau. Elle ne peut donc pas être
 * libre : ce qu'un descripteur y glisserait, c'est un `init=` de son choix.
 */
const LIGNE_DE_COMMANDE = /^[A-Za-z0-9 ._:/=,+-]{1,512}$/;

/** Bornes des deux grandeurs. Elles sont larges, et leur seul rôle est de refuser l'absurde. */
const TAILLE_DISQUE_MAX = 8 * 1024 * 1024 * 1024;
const MEMOIRE_MAX = 4 * 1024 * 1024 * 1024;

/** @param {unknown} valeur @param {number} plafond */
function entierBorne(valeur, plafond) {
  return Number.isInteger(valeur) && valeur > 0 && valeur <= plafond;
}

/**
 * CONTRÔLE la forme d'un descripteur, champ par champ.
 *
 * La version seule ne suffit pas, et c'est le constat 11 de la revue de sécurité de la PR #171 : un
 * descripteur d'une version connue mais aux champs libres fournit six URL, une ligne de commande de
 * noyau et deux grandeurs d'allocation au Worker de confiance. Le descripteur est servi par
 * l'origine de confiance elle-même — ce n'est pas l'adversaire de `SEC-ORIGIN-001` — mais une
 * donnée qui traverse une frontière se contrôle à l'entrée, pas à la source.
 *
 * Rend un MOTIF plutôt qu'un booléen : l'appelant le publie, et « descripteur refusé » sans dire
 * quel champ enverrait chercher au mauvais endroit.
 *
 * @param {unknown} descripteur
 * @returns {{ valide: boolean, motif: string | null }}
 */
export function formeDuDescripteur(descripteur) {
  const refus = (motif) => ({ valide: false, motif });
  if (typeof descripteur !== "object" || descripteur === null)
    return refus("descripteur illisible");
  if (descripteur.descripteurVersion !== DESCRIPTEUR_VERSION_ATTENDUE) {
    return refus(`version de descripteur inconnue : ${String(descripteur.descripteurVersion)}`);
  }
  if (typeof descripteur.application?.id !== "string" || descripteur.application.id.length === 0) {
    return refus("identité d'application absente");
  }
  if (typeof descripteur.runtime?.version !== "string") return refus("version de runtime absente");
  if (!PREFIXE_SERVI.test(String(descripteur.prefixeDesArtefacts ?? ""))) {
    return refus("préfixe d'artefacts hors du chemin servi");
  }
  if (String(descripteur.prefixeDesArtefacts).includes("..")) {
    return refus("préfixe d'artefacts porteur d'une remontée");
  }
  if (!NOM_DARTEFACT.test(String(descripteur.disque?.nom ?? ""))) {
    return refus("nom de disque applicatif refusé");
  }
  if (!entierBorne(descripteur.disque?.octets, TAILLE_DISQUE_MAX)) {
    return refus("taille de disque applicatif hors bornes");
  }
  if (!entierBorne(descripteur.boot?.memoireOctets, MEMOIRE_MAX)) {
    return refus("mémoire du guest hors bornes");
  }
  if (!LIGNE_DE_COMMANDE.test(String(descripteur.boot?.cmdline ?? ""))) {
    return refus("ligne de commande du guest refusée");
  }
  for (const cle of ["kernel", "initrd", "rootfs", "bios", "vgaBios"]) {
    if (!NOM_DARTEFACT.test(String(descripteur.boot?.[cle] ?? ""))) {
      return refus(`nom d'artefact refusé : ${cle}`);
    }
  }
  return { valide: true, motif: null };
}

/** Nom du volume qui porte le disque de l'application. Voir l'en-tête : ce n'est pas `coquille`. */
export const NOM_DU_VOLUME_APPLICATIF = "application";

/** @param {string} code @param {string} message */
function refus(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * LIT le descripteur servi, ou dit ce qui manque.
 *
 * L'absence n'est PAS une erreur : `npm run check` tourne sans les artefacts de l'image de
 * référence, et la coquille doit alors se déclarer sans application plutôt qu'échouer. C'est la même
 * règle que l'état `indisponible` — nommer l'absence au lieu de la traiter comme une panne.
 *
 * @param {{ recuperer?: typeof fetch }} [options]
 * @returns {Promise<{ present: boolean, descripteur?: object, motif?: string }>}
 */
export async function lireLeDescripteur({ recuperer = globalThis.fetch } = {}) {
  let reponse;
  try {
    reponse = await recuperer(ADRESSE_DESCRIPTEUR, { cache: "no-store" });
  } catch (erreur) {
    return { present: false, motif: `descripteur inatteignable : ${erreur.message}` };
  }
  if (!reponse.ok) {
    return { present: false, motif: `aucun descripteur servi (${reponse.status})` };
  }
  let descripteur;
  try {
    descripteur = await reponse.json();
  } catch {
    return { present: false, motif: "descripteur illisible" };
  }
  const forme = formeDuDescripteur(descripteur);
  if (!forme.valide) return { present: false, motif: forme.motif };
  return { present: true, descripteur };
}

/**
 * Le DESCRIPTEUR DE MANIFESTE que le volume applicatif doit déclarer (`SEC-UPDATE-001`).
 *
 * `minWriter` est la version en cours, le choix le plus strict — c'est celui du banc, et deux
 * chemins qui écrivent le même format n'ont pas à en choisir deux.
 *
 * @param {object} descripteur
 */
export function descripteurDeManifeste(descripteur) {
  return {
    runtime: {
      version: descripteur.runtime.version,
      artifact: null,
      minWriter: descripteur.runtime.version,
    },
    app: { id: descripteur.application.id, version: descripteur.application.version },
  };
}

/**
 * Les adresses que le boot doit récupérer : deux artefacts v86 épinglés par empreinte (#123), cinq
 * de l'image de référence servis sous leur nom.
 *
 * @param {object} descripteur
 * @param {{ recuperer?: typeof fetch }} [options]
 */
export async function adressesDuRuntime(descripteur, { recuperer = globalThis.fetch } = {}) {
  const { adresses } = await chargerAdressesV86({ fetch: recuperer });
  const prefixe = descripteur.prefixeDesArtefacts;
  return {
    lib: exigerAdresse(adresses, "libv86.mjs"),
    wasm: exigerAdresse(adresses, "v86.wasm"),
    bios: `${prefixe}${descripteur.boot.bios}`,
    vgaBios: `${prefixe}${descripteur.boot.vgaBios}`,
    kernel: `${prefixe}${descripteur.boot.kernel}`,
    initrd: `${prefixe}${descripteur.boot.initrd}`,
    rootfs: `${prefixe}${descripteur.boot.rootfs}`,
  };
}

/**
 * INSTALLE l'application dans son volume, si elle ne s'y trouve pas encore.
 *
 * L'ordre est celui de `phasePrepare`, et il est le contrat : le volume naît ANONYME — son manifeste
 * n'est inscrit qu'une fois le disque écrit ET flushé —, si bien qu'une installation interrompue
 * laisse un volume non identifié, donc non ouvrable en écriture. Un demi-disque qui se croirait
 * complet serait bien pire qu'une installation à refaire.
 *
 * **Trois issues, et pas une de plus :**
 *
 *  - le manifeste voisin est là → `{ installee: false }`. Réinstaller effacerait ce que le guest a
 *    écrit depuis, ce qu'aucun geste de démarrage n'a le droit de faire ;
 *  - rien n'existe → le disque est versé, puis le volume devient identifié ;
 *  - **le fichier de volume existe SANS manifeste → REFUS**, `VAULT_COQUILLE_VOLUME_APPLICATIF_SANS_MANIFESTE`.
 *    C'est le cas que la première rédaction traitait comme un volume neuf : elle versait le disque
 *    par-dessus, sans un geste et sans un mot. Un volume anonyme est soit une installation
 *    interrompue, soit autre chose ; dans les deux cas, l'écraser est une décision que la coquille
 *    n'a pas à prendre seule. Ce qu'il faudra pour l'identifier ou le réparer est une question
 *    ouverte, et elle est nommée dans l'ADR 0030 plutôt que tranchée ici.
 *
 * Les quatre primitives du support sont INJECTÉES, comme celles de `exclusivite-du-volume.mjs` :
 * sans elles, cette fonction ne serait mesurable que par un navigateur portant un demi-gibioctet
 * d'artefacts, donc jamais par une campagne de mutation.
 *
 * @param {{ descripteur: object, cleDeVolume: () => Promise<Uint8Array>, observer?: Function,
 *           ouvrir?: Function, verser?: Function, revoquer?: Function, inscrire?: Function }} options
 */
export async function installerSiNecessaire({
  descripteur,
  cleDeVolume,
  observer = statOpfsVolume,
  ouvrir = openOpfsVolume,
  verser = verserFluxDansVolume,
  revoquer = revokeVolumeManifest,
  inscrire = writeVolumeManifest,
}) {
  const nom = NOM_DU_VOLUME_APPLICATIF;
  const octets = descripteur.disque.octets;
  const manifesteExistant = await observer(manifestSidecarName(nom));
  if (manifesteExistant.present) return { installee: false, volume: nom, octets };

  const volumeExistant = await observer(nom);
  if (volumeExistant.present) {
    throw refus(
      CODES_REFUS_COQUILLE.volumeApplicatifSansManifeste,
      `Le volume « ${nom} » existe sans manifeste : la coquille ne l'écrase pas pour installer.`,
    );
  }

  // Rien n'existe : le manifeste est révoqué d'abord, pour que rien ne puisse ouvrir un volume à
  // demi versé entre-temps.
  await revoquer(nom);
  const verse = await verserLeDisque({ descripteur, cleDeVolume, ouvrir, verser, nom, octets });
  if (verse.ecrits !== octets) {
    throw refus(
      CODES_REFUS_COQUILLE.applicationAbsente,
      `Disque applicatif tronqué : ${verse.ecrits} octets écrits sur ${octets}.`,
    );
  }
  // DERNIER geste : le volume devient identifié, donc ouvrable en écriture. Tout ce qui précède
  // laisse un volume ANONYME, et c'est ce qui rend une installation interrompue reconnaissable.
  const descripteurManifeste = descripteurDeManifeste(descripteur);
  await inscrire(
    nom,
    createManifest({
      runtime: descripteurManifeste.runtime,
      app: descripteurManifeste.app,
      volumeSize: octets,
      identity: { algorithm: "sha-256", digest: null },
      volume: { id: verse.identifiantVolume, algorithm: VOLUME_ALGORITHM },
    }),
  );
  return { installee: true, volume: nom, octets, ecrits: verse.ecrits };
}

/**
 * OUVRE le volume NEUF et y verse le disque, en flux. Rend les octets écrits et l'IDENTIFIANT que
 * l'ouvreur a tiré : c'est lui, et non un identifiant réinventé, que le manifeste devra déclarer.
 */
async function verserLeDisque({ descripteur, cleDeVolume, ouvrir, verser, nom, octets }) {
  const cle = await cleDeVolume();
  // La clé est effacée QUOI QU'IL ARRIVE à l'ouverture. Elle ne l'était que sur le chemin du
  // succès, si bien qu'un `VAULT_STORAGE_BUSY` laissait ses octets en clair dans le tas du Worker :
  // c'est le constat 5 de la revue de la PR #167, dont la correction manquait ici (constat 9 de la
  // revue de la PR #171).
  let backend;
  try {
    backend = await ouvrir({ name: nom, size: octets, cle, transactionnel: false });
  } finally {
    cle.fill(0);
  }
  try {
    return {
      identifiantVolume: backend.identifiantVolume,
      ecrits: await verser(backend, `${descripteur.prefixeDesArtefacts}${descripteur.disque.nom}`),
    };
  } finally {
    await backend.close();
  }
}

/**
 * L'OUVREUR du volume applicatif pour la coquille : la clé vient de l'ENVELOPPE, et ne survit pas à
 * l'ouverture.
 *
 * `openVolumeForWrite` refuse d'abord le volume qui n'est pas identifié, d'un format futur ou d'une
 * autre application (`SEC-UPDATE-001`), puis ouvre sous la clé. Les octets de celle-ci sont effacés
 * dès que l'ouvreur a rendu la main — la même réduction de fenêtre que `ouverture-par-enveloppe.mjs`
 * pratique, et avec la même réserve : c'est FAIT, ce n'est pas GARANTI (ADR 0021, décision 7).
 *
 * @param {{ cleDeVolume: () => Promise<Uint8Array> }} options
 */
export function ouvreurSousLEnveloppe({ cleDeVolume }) {
  return async ({ name, journal, expectations }) => {
    const cle = await cleDeVolume();
    try {
      return await openVolumeForWrite({ name, journal, cle, expectations });
    } finally {
      cle.fill(0);
    }
  };
}

/**
 * Budget d'un boot Rails dans la coquille. Généreux, et pour la raison du banc : un i386 émulé
 * démarre en dizaines de secondes, et `docs/quality-attributes.md` publie p95 = 125,9 s, hors
 * budget. Une borne serrée ferait échouer un démarrage pour la lenteur de la machine plutôt que
 * pour un défaut du produit.
 */
export const DELAI_BOOT_MS = 300_000;

/**
 * Ce que le démarrage PUBLIE sur le canal privilégié. Une liste FERMÉE, et c'est la leçon du relevé
 * borné de la revue de la PR #166 : le compte rendu de boot porte une trentaine de champs, dont le
 * journal du guest et les observations du runtime, et les reposter en bloc ferait grossir un message
 * de la base de confiance au rythme de ce que le guest imprime. Ce qui repart est ce qu'une épreuve
 * doit pouvoir asserter, rien de plus.
 */
export function compteRenduPublie(rendu) {
  return {
    volume: rendu.volume,
    volumeOctets: rendu.volumeBytes,
    bootMs: rendu.bootMilliseconds,
    santeMs: rendu.healthMilliseconds,
    instantaneUtilise: rendu.usedSnapshot,
    instantane: rendu.instantane,
    decomposition: rendu.timeline,
    counts: rendu.counts,
    generation: rendu.generation,
    recuperation: rendu.recuperation,
    invariantStatut: rendu.invariantHttpStatus,
    invariantVerdict: rendu.invariantVerdict,
    enregistrementObserve: rendu.observedRecordId,
    pieceJointeObservee: rendu.observedAttachmentSha256,
    boucleOrdonnancement: rendu.boucleOrdonnancement,
    rythme: rendu.rythme,
    // Un COMPTE, pas la liste : une panne de support absorbée doit se voir ; son contenu appartient
    // au diagnostic du Worker, pas au relevé.
    pannes: rendu.failures.length,
  };
}

/**
 * DÉMARRE la machine virtuelle sur le volume applicatif, et rend la poignée de fermeture.
 *
 * Elle ne contrôle PAS l'ordre : c'est le Worker de confiance qui exige un backend ouvert avant
 * d'appeler ceci (`cycle-de-vie.mjs`, `exigerLeBackend`). Elle ne contrôle pas non plus l'état — un
 * module qui déciderait à la fois de l'ordre et du boot rendrait la garde inséparable de ce qu'elle
 * garde.
 *
 * L'absence de descripteur rend `{ demarree: false }` avec son motif, jamais une exception : sur une
 * origine qui ne sert aucune application, il n'y a rien à démarrer, et ce n'est pas une panne.
 *
 * @param {{ cleDeVolume: () => Promise<Uint8Array>, reprendreParInstantane?: boolean,
 *           bootTimeoutMs?: number }} options
 */
export async function demarrerLaVm({
  cleDeVolume,
  reprendreParInstantane = true,
  bootTimeoutMs = DELAI_BOOT_MS,
}) {
  const lu = await lireLeDescripteur();
  if (!lu.present) return { demarree: false, motif: lu.motif };
  const descripteur = lu.descripteur;
  const installation = await installerSiNecessaire({ descripteur, cleDeVolume });
  // Le module de boot est importé ICI, et non à l'évaluation du Worker de confiance : il POSE la
  // boucle d'ordonnancement de v86 à son évaluation (ADR 0013), et une coquille qui ne démarre
  // aucune application n'a aucune raison de la porter. L'ordre reste juste — la boucle est posée
  // avant que le module de l'émulateur soit importé, ce qui est la seule contrainte.
  const { bootEtVerifier } = await import("../vm/boot-de-reference.mjs");
  const rendu = await bootEtVerifier({
    phase: "coquille",
    volume: NOM_DU_VOLUME_APPLICATIF,
    cmdline: descripteur.boot.cmdline,
    memoryBytes: descripteur.boot.memoireOctets,
    runtime: await adressesDuRuntime(descripteur),
    manifest: descripteurDeManifeste(descripteur),
    // Aucune ATTENTE d'invariant n'est déclarée ici, et c'est délibéré : le contrat applicatif vit
    // dans `apps/reference/vault-invariant.json`, que l'origine de confiance ne sert pas. La
    // coquille publie donc le VERDICT que Rails a rendu, et l'assertion vit dans `tests/e2e/` —
    // ce qui est déjà la règle du banc : « aucune phase ne se déclare réussie d'elle-même ».
    expected: {},
    bootTimeoutMs,
    reprendreParInstantane,
    // Ce drapeau ARME la capture ; il ne la déclenche pas. Sous `garderLaSessionOuverte`, la
    // fonction construite n'est appelée que par `fermer()` — donc à la FERMETURE, dans l'ordre de
    // l'ADR 0024 décision 6. Capturer au boot lierait l'instantané à l'état du démarrage plutôt
    // qu'à celui de la session que l'utilisateur vient de finir.
    capturerInstantane: true,
    garderLaSessionOuverte: true,
    ouvrirLeVolumeDuGuest: ouvreurSousLEnveloppe({ cleDeVolume }),
  });
  const { fermer, ...compte } = rendu;
  return { demarree: true, installation, fermer, compte };
}
