// ACQUISITION du runtime et BOOT VÉRIFIÉ du guest.
//
// Ce module ne connaît que le boot : acquérir ce qui vient du réseau, ouvrir le volume EN ÉCRITURE
// par le seul chemin qui exige son identité (`SEC-UPDATE-001`), faire démarrer Rails, l'interroger,
// et rendre ce qui a été observé. Il ne décide rien : aucune phase ne se déclare « réussie »
// d'elle-même, l'assertion vit dans les spécifications de `tests/e2e/`.
//
// ## Pourquoi il vit dans `src/` depuis #163
//
// Il a été écrit pour le banc de reprise (#7, #13) et a vécu sous `public/vm/reference-worker-boot.mjs`
// tant que le boot était un banc. La tranche 3 de #24 l'amène DANS le produit : le Worker de
// confiance de la coquille boote la même image, sur le même volume OPFS, par le même chemin — c'est
// l'étape 3 du cycle de vie de `docs/architecture.md`, « le Worker ouvre le backend, puis seulement
// la VM ». Le laisser sous `public/vm/` aurait fait importer un banc par un chemin de production ;
// le recopier en aurait fait deux versions qui divergent au premier correctif.
//
// **Ce qui a changé en le déplaçant, et rien d'autre** : `ouvrirLeVolumeDuGuest` est désormais
// INJECTÉ. Le banc l'ouvre sous le jeton du harnais (`cle-du-banc.mjs`), la coquille sous la clé
// développée de son enveloppe (ADR 0020) — deux provenances de clé, un seul chemin de boot. Sans
// cette injection, ce module aurait gardé un import vers un banc, c'est-à-dire l'inverse du
// déplacement.
//
// Son nom ne contient plus « worker » : la configuration ESLint en déduisait un contexte de Worker,
// et il est désormais partagé — le banc l'exécute dans un Worker, la coquille aussi, mais rien ici
// n'appelle un global qui manque à la page (voir `eslint.config.mjs`).

import { BlockJournal } from "./block-journal.mjs";
import { openVolumeForWrite } from "./opfs-volume-open.mjs";
import { createReferenceGuestSession } from "./reference-guest-session.mjs";
import {
  consignerRejetsNonTraites,
  executerSousGarde,
  exigerContexteExecutable,
  mesurerRythme,
} from "./runtime-environment.mjs";
import { decrireBoucle, installerBoucleOrdonnancement } from "./scheduling-loop.mjs";
import { createBootTimeline } from "./decomposition-du-boot.mjs";
import { verifierEmpreintesV86, verifierLeModuleV86 } from "./empreintes-du-runtime-v86.mjs";
import { createV86BufferAdapter } from "./v86-buffer-adapter.mjs";
import {
  capturerApresPointDeControle,
  empreinteDeLImage,
  ouvrirInstantanePourReprise,
} from "./instantane-du-boot.mjs";
import {
  MANIFEST_FORMAT_VERSION,
  MIN_VOLUME_FORMAT_VERSION,
  createManifest,
} from "./volume-manifest.mjs";

/**
 * La boucle d'ordonnancement de v86 est posée À L'ÉVALUATION de ce module — donc au démarrage du
 * Worker, avant `importV86` et avant le contrôle préalable. v86 fige son chemin d'ordonnancement à
 * l'évaluation de SON module et ne le révise jamais : posée plus tard, elle n'aurait aucun effet
 * (ADR 0013, § « Mise en œuvre par #74 »).
 */
export const boucleOrdonnancement = installerBoucleOrdonnancement();

/**
 * Rejets non traités du Worker, consignés dès son évaluation. `libv86.mjs` jette la valeur de
 * retour de `scheduler.postTask` : une exception dans un tour de boucle rejette une promesse que
 * rien n'attend, arrête l'émulateur sans bruit, et se déguise ensuite en délai de garde du guest.
 */
const lireRejets = consignerRejetsNonTraites();

/**
 * Identités du volume, telles qu'un scénario les déclare. Elles servent DEUX fois : à inscrire le
 * manifeste quand le volume est créé, et à l'exiger quand il est rouvert en écriture.
 * `SEC-UPDATE-001` n'admet aucun volume anonyme, donc aucune phase écrivante sans descripteur.
 *
 * `supportedFormat` est facultatif et n'est PAS une capacité du produit : c'est le moyen, pour un
 * scénario, de faire tourner ce runtime avec la plage de formats d'un runtime ANTÉRIEUR et de
 * vérifier qu'un volume d'un format plus récent lui est bien refusé (#13). Le refus prouvé est
 * celui de la règle de compatibilité, pas celui d'un binaire publié plus tôt — aucune release
 * n'en a encore produit.
 */
export function attentesDe(manifest) {
  if (!manifest?.app?.id || !manifest?.runtime?.version) {
    throw new Error(
      "Descripteur de manifeste requis : un volume ne s'ouvre en écriture que s'il est identifié (SEC-UPDATE-001).",
    );
  }
  const attentes = {
    app: { id: manifest.app.id },
    runtime: { version: manifest.runtime.version },
  };
  if (manifest.supportedFormat) attentes.supportedFormat = manifest.supportedFormat;
  return attentes;
}

/**
 * Construit le manifeste qu'une phase de CRÉATION inscrit. Le descripteur porte le format visé : un
 * scénario de migration doit pouvoir fabriquer un volume au format ANTÉRIEUR, sans quoi il n'aurait
 * rien à migrer. Sans indication, le format courant du runtime s'applique.
 */
export function manifesteDuDescripteur(manifest, volumeSize, volume) {
  const formatVersion = Number.isInteger(manifest.formatVersion)
    ? manifest.formatVersion
    : MANIFEST_FORMAT_VERSION;
  return createManifest({
    formatVersion,
    runtime: manifest.runtime,
    app: manifest.app,
    volumeSize,
    identity: { algorithm: "sha-256", digest: null },
    // Le bloc `volume` n'existe qu'à partir du format v3 (ADR 0016), et son identifiant est celui
    // que le volume PORTE — tiré à sa création et inscrit dans son en-tête. Le réinventer ici
    // donnerait un manifeste qui décrit un autre volume que celui qui vient d'être écrit.
    ...(formatVersion >= MIN_VOLUME_FORMAT_VERSION && volume !== undefined ? { volume } : {}),
  });
}

/**
 * Le contexte est contrôlé AVANT toute construction d'émulateur, et son refus porte un code de
 * `src/vm/runtime-errors.mjs` (#52). Sans ce contrôle, un contexte privé de boucle d'ordonnancement
 * ne produirait aucune exception : l'émulateur ne battrait simplement jamais.
 *
 * La garde du premier tour couvre ici DEUX phases, et c'est le point délicat de ce chemin :
 * `createReferenceGuestSession.boot()` rend la main juste après `emulator.run()`, avant que le
 * guest ait dit quoi que ce soit. Une garde arrêtée là n'aurait pas eu le temps de prendre deux
 * échantillons, et un émulateur qui ne bat pas serait retombé sur `awaitHealth`, dont l'expiration
 * accuse le GUEST — exactement la cause fausse que #52 combat. La garde couvre donc le boot ET
 * l'attente de santé, et rend le compte rendu de cette dernière.
 */
function booterEtAttendreSante(session, { bootTimeoutMs, timeline, observations, etatARestaurer }) {
  return executerSousGarde(
    () => session.ticks(),
    async () => {
      await session.boot({ etatARestaurer });
      timeline.marquer("bootRendu");
      return session.awaitHealth({ totalTimeoutMs: bootTimeoutMs });
    },
    {
      onObservation: (observation) => observations.push(observation),
      decrireBoucle: () => decrireBoucle(boucleOrdonnancement),
      // Cadencée par la boucle autant que par la minuterie : sous un moteur qui affame ses
      // minuteries pendant que la boucle tourne, une garde posée sur `setTimeout` n'expirerait pas
      // dans la plage qu'elle borne (mesuré, voir `src/vm/scheduling-loop.mjs`).
      boucle: boucleOrdonnancement,
    },
  );
}

async function fetchBytes(url) {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Artefact ${url} indisponible (${response.status}).`);
  }
  return new Uint8Array(await response.arrayBuffer());
}

/** Charge les tampons du runtime. Le disque applicatif n'en fait PAS partie : il vit dans OPFS. */
async function loadRuntime(runtime) {
  const [wasm, bios, vgaBios, kernel, initrd, rootfs] = await Promise.all([
    fetchBytes(runtime.wasm),
    fetchBytes(runtime.bios),
    fetchBytes(runtime.vgaBios),
    fetchBytes(runtime.kernel),
    fetchBytes(runtime.initrd),
    fetchBytes(runtime.rootfs),
  ]);
  const artifacts = { wasm, bios, vgaBios, kernel, initrd, rootfs };
  const transferredBytes = Object.values(artifacts).reduce((total, a) => total + a.byteLength, 0);
  const empreintesV86Ms = await verifierEmpreintesV86(runtime, artifacts);
  return { artifacts, transferredBytes, empreintesV86Ms };
}

/** Importe la classe V86, ses octets AYANT ÉTÉ confrontés au manifeste (#123). */
async function importV86(libUrl) {
  await verifierLeModuleV86(libUrl, fetchBytes);
  const module = await import(libUrl);
  return module.V86;
}

/** Acquiert TOUT ce qui vient du réseau : la classe V86 et les tampons du runtime. */
export async function acquerirRuntime(runtime) {
  await exigerContexteExecutable();
  const V86 = await importV86(runtime.lib);
  const { artifacts, transferredBytes, empreintesV86Ms } = await loadRuntime(runtime);
  // L'EMPREINTE DE L'IMAGE est prise ICI, sur les octets tout juste acquis, et jamais plus tard.
  // Le rootfs est un tampon que le guest ÉCRIT (#65) : le hacher après un boot donnerait l'empreinte
  // d'une session, pas celle d'une image. Le défaut est tombé sur le scénario de bout en bout de
  // #65 — la reprise écartait l'instantané au motif ECART_IMAGE, sur la même image exactement.
  return {
    V86,
    artifacts,
    transferredBytes,
    empreintesV86Ms,
    empreinteImage: await empreinteDeLImage(artifacts),
  };
}

/** Écritures du guest exigées avant d'annoncer une mutation. Une seule ne prouverait pas grand-chose. */
const ECRITURES_AVANT_COUPURE = 8;

/**
 * Surveille le journal d'E/S et prévient DÈS que le guest a muté le volume et qu'une barrière a été
 * acquittée. Le guet est un intervalle, non un abonnement : le journal de blocs est une trace, pas
 * un émetteur, et lui ajouter un canal d'événements pour un seul banc de mesure serait une frontière
 * de plus dans le chemin de production.
 *
 * @param {import("/src/vm/block-journal.mjs").BlockJournal} journal
 * @param {(etat: object) => void} prevenir appelé UNE fois
 */
function guetterMutation(journal, prevenir) {
  const minuterie = setInterval(() => {
    const counts = journal.counts();
    if ((counts.write ?? 0) < ECRITURES_AVANT_COUPURE) return;
    if ((counts["flush-ack"] ?? 0) < 1) return;
    clearInterval(minuterie);
    prevenir({ counts });
  }, 200);
  return { arreter: () => clearInterval(minuterie) };
}

/**
 * MONTAGE : ouvre le volume en écriture et pose la session guest dessus. Rien n'est encore booté au
 * retour — l'émulateur est construit, pas lancé.
 *
 * Le volume est ouvert EN ÉCRITURE pour le guest, mais son identité et sa compatibilité ont déjà
 * été exigées par `attentesDe` AVANT l'acquisition du runtime : un volume sans manifeste
 * (restauration ou migration interrompue, préparation incomplète), d'un format antérieur non migré
 * ou d'un format plus récent que ce runtime est refusé sans qu'un seul octet ait été téléchargé,
 * pas découvert par Rails sur un système de fichiers tronqué (`SEC-UPDATE-001`).
 *
 * @param {{ volume: string, attentes: object, timeline: object, ouvrirLeVolumeDuGuest: Function,
 *           guest: { V86: Function, artifacts: object, cmdline: string, memoryBytes: number } }} options
 */
async function ouvrirVolumeEtSession({ volume, attentes, timeline, guest, ouvrirLeVolumeDuGuest }) {
  const journal = new BlockJournal();
  const failures = [];
  const backend = await ouvrirLeVolumeDuGuest({
    name: volume,
    journal,
    expectations: attentes,
  });
  // Ce que la RÉCUPÉRATION de #16 a trouvé et fait, lu AVANT le premier octet du guest. C'est la
  // seule occasion de le lire : le point de contrôle qui suivra remettra le magasin à zéro. Une
  // génération écartée ou rejouée doit arriver jusqu'au compte rendu, sans quoi un boot qui repart
  // d'un état d'avant serait indistinguable d'un boot qui repart d'un état d'après.
  const recuperation = backend.generation?.rapport ?? null;
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error.toJSON()),
    // La LIAISON que `get_state` rendra pendant une capture, et que `set_state` confrontera pendant
    // une restauration (#65, ADR 0024). Elle est lue à CHAQUE appel, jamais capturée à la
    // construction : la séquence avance à chaque racine écrite, et une liaison figée décrirait un
    // état que le volume a déjà quitté.
    liaisonDeVolume: () => ({
      volume: backend.identifiantVolume,
      sequence: backend.generation?.sequenceValidee ?? 0,
      generation: backend.generation?.generationValidee ?? 0,
    }),
  });
  const guestLog = [];
  const session = createReferenceGuestSession({
    V86: guest.V86,
    artifacts: guest.artifacts,
    appAdapter: adapter,
    journal,
    cmdline: guest.cmdline,
    memoryBytes: guest.memoryBytes,
    onJournal: (ligne) => {
      if (guestLog.length < 200) guestLog.push(ligne);
    },
    onSerial: (fragment) => timeline.ingererSerie(fragment),
    // Les attentes de la session se cadencent aussi sur la boucle : sans cela, un moteur qui affame
    // ses minuteries pendant que la boucle tourne laisserait un boot sans issue rester suspendu,
    // sans jamais rendre de `BootTimeout` (WebKit, mesuré).
    boucle: boucleOrdonnancement,
  });
  return { journal, backend, failures, recuperation, session, guestLog, adapter };
}

/**
 * DÉROULÉ : boot sous garde, attente de santé, interrogation de l'invariant, puis fermeture.
 *
 * Le `try/finally` est le cœur de cette phase et la raison de sa séparation : quoi qu'il arrive au
 * boot, le guet s'arrête, la session s'arrête et le backend se ferme. Rien de ce qui précède ni de
 * ce qui suit ne doit pouvoir s'intercaler dans cette garantie.
 *
 * @returns {Promise<{ health: object, invariant: object, rythme: object, boucle: object,
 *                     observations: object[], started: number }>}
 */
async function deroulerBootEtInvariant({
  montage,
  surMutation,
  bootTimeoutMs,
  timeline,
  etatARestaurer = null,
  capturerApres = null,
  garderLaSessionOuverte = false,
}) {
  // Guet de MUTATION : il prévient l'appelant dès que le guest a réellement muté le volume ET
  // qu'une barrière a été acquittée. C'est le seul instant où couper prouve quelque chose — couper
  // avant la première barrière ne mesurerait qu'un volume jamais touché. Il ne coupe RIEN lui-même :
  // la coupure est la mort du Worker, décidée par la page.
  const guet = surMutation === null ? null : guetterMutation(montage.journal, surMutation);
  let commun;
  try {
    commun = await observerLeBoot({ montage, bootTimeoutMs, timeline, etatARestaurer });
  } catch (erreur) {
    // Le chemin d'ÉCHEC ferme TOUJOURS, et sans capturer : un instantané pris sur un boot qui vient
    // d'échouer décrirait un état dont personne n'a constaté qu'il vaut quelque chose.
    await fermerLeMontage({ montage, guet, capturerApres: null });
    throw erreur;
  }
  // La coquille de produit GARDE la session ouverte (#163) : l'étape 7 du cycle de vie — arrêter la
  // VM, capturer, `close()`, puis `terminate()` — est un geste à part, et l'instantané se prend au
  // moment de la fermeture, dans l'ordre de l'ADR 0024. Le banc, lui, ne passe jamais ce drapeau :
  // son `finally` d'origine reste le sien, phase par phase.
  if (garderLaSessionOuverte) {
    // `fermer` est IDEMPOTENT : un second appel ne referme rien et ne rend rien de neuf. Sans cela,
    // deux gestes de fermeture — celui de l'utilisateur et celui d'un chemin d'erreur — feraient
    // `close()` deux fois sur le même backend, et le second rendrait `VAULT_STORAGE_CLOSED` pour une
    // fermeture qui s'était pourtant bien passée (constat 10 de la revue de la PR #171).
    let fermee = null;
    return {
      ...commun,
      capture: null,
      fermer: ({ capturer = true } = {}) => {
        if (fermee !== null) return fermee;
        fermee = fermerLeMontage({ montage, guet, capturerApres: capturer ? capturerApres : null });
        return fermee;
      },
    };
  }
  const capture = await fermerLeMontage({ montage, guet, capturerApres });
  return { ...commun, capture, fermer: null };
}

/**
 * OBSERVE le boot : santé de Rails, rythme de la boucle, invariant applicatif. Rien n'est fermé ici
 * — la fermeture appartient à l'appelant, qui doit la tenir aussi bien sur l'échec que sur le
 * succès, et la mêler à l'observation rendait cette garantie difficile à lire.
 */
async function observerLeBoot({ montage, bootTimeoutMs, timeline, etatARestaurer }) {
  const { session } = montage;
  const started = performance.now();
  const observations = [];
  const health = await booterEtAttendreSante(session, {
    bootTimeoutMs,
    timeline,
    observations,
    etatARestaurer,
  });
  timeline.marquer("santePrete");
  // Rythme de la boucle sur la fenêtre boot → santé de Rails. C'est l'instrument qui rend
  // comparables deux exécutions de l'IMAGE DE RÉFÉRENCE avec des boucles d'ordonnancement
  // différentes (#74) : `healthMilliseconds` seul ne dirait pas si l'émulateur a battu plus vite.
  const rythme = mesurerRythme({ ticks: session.ticks(), fenetreMs: performance.now() - started });
  const boucle = decrireBoucle(boucleOrdonnancement);
  const invariant = await lireInvariant(session);
  timeline.marquer("invariantRendu");
  return { health, invariant, rythme, boucle, observations, started };
}

/**
 * FERME le montage : capture d'abord si on la demande, puis arrêt de la session, puis fermeture du
 * backend. L'ordre est le protocole de l'ADR 0024 — point de contrôle, liaison lue ensuite, arrêt,
 * quiescence, scellement —, et il ne se réordonne pas : capturer après `close()` serait impossible,
 * le volume n'étant plus ouvert.
 *
 * Le `try/finally` est la garantie que ce module doit : quoi qu'il arrive à la capture, le guet
 * s'arrête, la session s'arrête et le backend se ferme.
 */
async function fermerLeMontage({ montage, guet, capturerApres }) {
  try {
    return capturerApres === null ? null : await capturerApres();
  } finally {
    guet?.arreter();
    montage.session.stop();
    await montage.backend.close();
  }
}

/**
 * COMPTE RENDU : la trentaine de champs que le banc et les spécifications lisent. C'est de la mise
 * en forme, pas une phase — aucune E/S, aucune décision de boot. Le seul verdict calculé ici,
 * `conforming`, ne fait que rapprocher ce que l'invariant a répondu de ce que le scénario attendait ;
 * il n'ASSERTE rien, l'assertion vivant dans `tests/e2e/`.
 */
/**
 * Ce que le GUEST a demandé au journal de génération pendant ce boot (#91).
 *
 * `recuperation` dit ce qu'une OUVERTURE a trouvé ; ces deux chiffres-ci disent ce que le guest a
 * produit, et ils ne mesurent PAS la même chose :
 *
 *  - `deposeeMaxOctets` est la grandeur que `PLAFOND_CHARGE_OCTETS` borne — tout ce qui s'est
 *    accumulé depuis un point de contrôle, barrière ou pas. C'est elle qui calibre le plafond ;
 *  - `valideeMaxOctets` est la plus grande GÉNÉRATION, c'est-à-dire ce qu'une barrière a scellé.
 *
 * L'écart entre les deux dit à quelle fréquence le guest franchit réellement une barrière.
 *
 * Les deux se lisent APRÈS la fermeture du backend, et c'est licite : `close()` range la génération
 * validée puis ferme le handle, mais le magasin reste attaché au backend et ses hautes eaux sont des
 * compteurs, pas des ressources. Un volume non transactionnel rend `null`, qui se distingue d'un
 * zéro « aucune écriture ».
 */
function releverGeneration(backend) {
  return {
    deposeeMaxOctets: backend.generation?.chargeMaxDeposeeOctets ?? null,
    valideeMaxOctets: backend.generation?.chargeMaxValideeOctets ?? null,
  };
}

/**
 * Décomposition du temps de reprise (#60), à laquelle #123 ajoute le prix des vérifications
 * d'empreinte. Extraite pour que `assemblerCompteRendu` reste sous le plafond de la convention.
 */
function decomposition({ timeline, mesures, health }) {
  return timeline.decomposer({
    healthMs: health.durationMs,
    empreintesV86Ms: mesures.empreintesV86Ms,
  });
}

function assemblerCompteRendu({ identite, mesures, montage, deroule, timeline }) {
  const { invariant, health } = deroule;
  const observed = invariant.verdict.observed ?? {};
  const conforming =
    invariant.statut === 200 &&
    invariant.verdict.status === "conforming" &&
    observed.record?.id === identite.expected.recordId &&
    observed.attachment?.sha256 === identite.expected.attachmentSha256;

  return {
    phase: identite.phase,
    volume: identite.volume,
    volumeBytes: montage.backend.size?.() ?? null,
    bootMilliseconds: Number((performance.now() - deroule.started).toFixed(1)),
    healthMilliseconds: health.durationMs,
    rythme: deroule.rythme,
    boucleOrdonnancement: deroule.boucle,
    timeline: decomposition({ timeline, mesures, health }),
    transferredBytes: mesures.transferredBytes,
    memoryBytes: mesures.memoryBytes,
    // `usedSnapshot` dit ce que CE BOOT a fait, jamais ce qu'il aurait pu faire : un boot qui a
    // écarté un instantané le publie à `false`, avec son motif dans `instantane`.
    usedSnapshot: mesures.instantane?.utilise === true,
    instantane: mesures.instantane,
    capture: deroule.capture,
    online: mesures.online,
    sante: health.sante,
    invariantStatus: invariant.verdict.status,
    invariantHttpStatus: invariant.statut,
    // Le VERDICT ENTIER, et pas seulement son statut : c'est l'objet que deux chemins de boot
    // doivent rendre IDENTIQUE pour que « équivalence » veuille dire quelque chose (#65, ADR 0024).
    // Un statut seul serait « conforme des deux côtés », ce qui ne dit rien de ce qui a été relu.
    invariantVerdict: invariant.verdict,
    observedRecordId: observed.record?.id ?? null,
    observedAttachmentSha256: observed.attachment?.sha256 ?? null,
    conforming,
    recuperation: montage.recuperation,
    generation: releverGeneration(montage.backend),
    counts: montage.journal.counts(),
    // Ce que la FERMETURE du volume a dû attendre (#132) : les E/S que le guest avait encore en
    // vol quand elle a commencé. Sans ce chiffre, « la course n'arrive plus » ne se distingue
    // pas de « la course n'est pas tombée cette fois ».
    fermetureEnVol: montage.backend.enVolALaFermeture,
    failures: montage.failures,
    observationsRuntime: [...deroule.observations, ...lireRejets()],
    guestLog: montage.guestLog,
  };
}

/**
 * Interroge l'invariant applicatif et rend ce que Rails a répondu, statut compris.
 *
 * Extraite du déroulé (#65) pour que son `try/finally` — la seule garantie que le guet s'arrête, que
 * la session s'arrête et que le backend se ferme — reste lisible d'un bloc.
 */
async function lireInvariant(session) {
  const reponse = await session.request("GET", "/vault/invariant");
  return {
    statut: reponse.statut,
    verdict: JSON.parse(new TextDecoder().decode(reponse.corps)),
  };
}

/**
 * MONTE le volume et la session, puis OUVRE l'instantané si le banc en demande un.
 *
 * Les deux gestes vont ensemble parce que le second a besoin du premier : l'instantané se lie à la
 * racine validée du volume, et il n'y a pas de racine avant l'ouverture.
 */
async function monterEtOuvrirLInstantane({
  volume,
  attentes,
  timeline,
  guest,
  empreinteImage,
  reprendreParInstantane,
  ouvrirLeVolumeDuGuest,
}) {
  const montage = await ouvrirVolumeEtSession({
    volume,
    attentes,
    timeline,
    guest,
    ouvrirLeVolumeDuGuest,
  });
  // L'instantané est OUVERT avant le boot, et son état n'est restauré que s'il est utilisable. Un
  // instantané écarté ne fait donc rien d'autre que retarder le boot du temps de sa lecture — et ce
  // temps est publié, comme le motif de son rejet.
  const instantane = reprendreParInstantane
    ? await ouvrirInstantanePourReprise({ backend: montage.backend, volume, empreinteImage })
    : null;
  timeline.marquer("instantaneOuvert");
  return { montage, instantane };
}

/**
 * Rend la fonction de CAPTURE que le déroulé appellera après l'invariant, ou `null`.
 *
 * `null` n'est pas un défaut silencieux : c'est « ce boot ne capture pas », et le déroulé le lit
 * comme tel. Une capture demandée sans être possible se serait vue par une exception ; une capture
 * non demandée doit se voir par une absence.
 */
function captureDemandee({ options, montage, empreinteImage }) {
  if (options.capturerInstantane !== true) return null;
  return () =>
    capturerApresPointDeControle({
      backend: montage.backend,
      session: montage.session,
      adapter: montage.adapter,
      volume: options.volume,
      empreinteImage,
    });
}

/**
 * PRÉAMBULE d'un boot : exiger l'identité, poser la décomposition, acquérir le runtime.
 *
 * L'identité est exigée EN PREMIER, avant même le réseau : `SEC-UPDATE-001` n'admet aucun volume
 * anonyme, et le refuser ici épargne l'acquisition d'un runtime qui n'aurait servi à rien. La
 * décomposition (#60) pose ses jalons DÈS l'entrée, pour dater aussi cette acquisition.
 */
async function preparerLeBoot({ manifest, runtime, runtimeBundle = null }) {
  const attentes = attentesDe(manifest);
  const timeline = createBootTimeline();
  timeline.marquer("debut");
  const acquis = runtimeBundle ?? (await acquerirRuntime(runtime));
  timeline.marquer("runtimePret");
  return { attentes, timeline, ...acquis, online: navigator.onLine };
}

/**
 * Le compte rendu d'instantané, SANS l'état v86.
 *
 * Il pèse 250 Mio et n'a rien à faire dans un message structuré que la page lit : `postMessage` le
 * recopierait, et la trace de Playwright le garderait. Ce qui reste est ce qu'une épreuve doit
 * pouvoir asserter — `utilise`, le motif, la durée d'ouverture.
 */
function sansLEtat(instantane) {
  return instantane === null ? null : { ...instantane, etat: undefined };
}

/**
 * L'OUVREUR par défaut : celui qui exige une clé de volume déjà en mémoire.
 *
 * Il n'en fabrique aucune, et c'est le point : `openVolumeForWrite` refuse un volume sans manifeste
 * compatible AVANT d'ouvrir quoi que ce soit (`SEC-UPDATE-001`), puis passe la clé qu'on lui donne.
 * D'où elle vient est la seule chose qui distingue le banc du produit — jeton de harnais d'un côté,
 * enveloppe de clé de l'autre —, et c'est pour cela que ce paramètre existe.
 *
 * @param {{ name: string, journal: object, expectations: object, cle?: Uint8Array }} options
 */
function ouvrirSousLeManifeste({ name, journal, expectations, cle }) {
  if (!(cle instanceof Uint8Array)) {
    throw new Error(
      "Aucune clé de volume : `bootEtVerifier` n'en fabrique pas. Injectez `ouvrirLeVolumeDuGuest`.",
    );
  }
  return openVolumeForWrite({ name, journal, cle, expectations });
}

/**
 * Ouvre le volume OPFS, boote Rails dessus, attend `/vault/health`, vérifie l'invariant et rend le
 * compte rendu. Le seul boot possible est un boot à froid complet : il n'existe aucun chemin
 * d'instantané mémoire dans ce Worker.
 *
 * `runtimeBundle` permet de fournir un runtime DÉJÀ acquis (reprise hors ligne : l'acquisition a eu
 * lieu en ligne, le boot a lieu réseau coupé).
 *
 * La fonction n'est plus qu'un ORDONNANCEMENT depuis #77 : exigence d'identité, acquisition du
 * runtime, puis les trois gestes qui suivent, chacun dans sa fonction — `ouvrirVolumeEtSession`,
 * `deroulerBootEtInvariant`, `assemblerCompteRendu`. Les trois premiers sont des phases, le dernier
 * est de la mise en forme, et les mêler rendait la garantie du `try/finally` difficile à lire.
 */
export async function bootEtVerifier(options) {
  const { attentes, timeline, V86, artifacts, empreinteImage, ...mesuresDAcquisition } =
    await preparerLeBoot(options);

  const { montage, instantane } = await monterEtOuvrirLInstantane({
    volume: options.volume,
    attentes,
    timeline,
    guest: { V86, artifacts, cmdline: options.cmdline, memoryBytes: options.memoryBytes },
    empreinteImage,
    reprendreParInstantane: options.reprendreParInstantane === true,
    ouvrirLeVolumeDuGuest: options.ouvrirLeVolumeDuGuest ?? ouvrirSousLeManifeste,
  });

  const deroule = await deroulerBootEtInvariant({
    montage,
    surMutation: options.surMutation ?? null,
    bootTimeoutMs: options.bootTimeoutMs,
    timeline,
    etatARestaurer: instantane?.utilise ? instantane.etat : null,
    capturerApres: captureDemandee({ options, montage, empreinteImage }),
    garderLaSessionOuverte: options.garderLaSessionOuverte === true,
  });
  // L'état v86 est LÂCHÉ dès que la restauration a eu lieu : il pèse 250 Mio, et le boot qui suit
  // tient déjà la mémoire du guest (512 Mio), le rootfs (385 Mio) et les artefacts du runtime. Le
  // budget navigateur de `docs/quality-attributes.md` est de 1,5 Gio.
  if (instantane !== null) instantane.etat = null;

  const compteRendu = assemblerCompteRendu({
    identite: { phase: options.phase, volume: options.volume, expected: options.expected },
    mesures: {
      ...mesuresDAcquisition,
      memoryBytes: options.memoryBytes,
      instantane: sansLEtat(instantane),
    },
    montage,
    deroule,
    timeline,
  });
  // `fermer` est une FONCTION : `sansCapacite` la refuse, et c'est voulu. Elle ne peut donc pas
  // franchir un port par inadvertance — la poignée de fermeture reste du côté qui tient le handle.
  return deroule.fermer === null ? compteRendu : { ...compteRendu, fermer: deroule.fermer };
}
