// ÉCRITURE PAR UNE SESSION REPRISE, sur OPFS réel (#65, ADR 0024 ; revue de la PR #133).
//
// ## Ce que ces trois scénarios prouvent, et pourquoi ils ne vivent pas dans le scénario Rails
//
// L'ADR 0024 affirme qu'un instantané rend une session dont les écritures SUIVANTES sont durables
// comme celles de n'importe quelle session. Le scénario de bout en bout ne peut pas le montrer :
// l'application de référence expose exactement deux routes, toutes deux en lecture (ADR 0004), et
// le pont série ne sait relayer que du HTTP. Une session Rails reprise ne peut donc rien écrire —
// c'est une propriété de la FIXTURE, pas de la reprise.
//
// Le guest de la matrice #2, lui, rend un SHELL sur le port série. Une session reprise y écrit un
// bloc, franchit une barrière, et la fermeture range la génération. Un boot À FROID relit ensuite
// le volume, et c'est là que la preuve se joue : les deux marques doivent y être, celle d'avant la
// capture et celle qu'une mémoire restaurée a écrite.
//
// ## Trois exécutions, trois volumes ouverts et refermés
//
// Chaque scénario ouvre le volume, l'utilise, le referme. Rien n'est tenu entre eux : c'est le
// support qui porte l'état, et une preuve qui garderait un handle ouvert entre la capture et la
// reprise ne dirait rien de ce qu'un onglet fermé laisse derrière lui.

import { BlockJournal } from "/src/vm/block-journal.mjs";
import { createFaultPlan } from "/src/vm/fault-plan.mjs";
import {
  INSTANTANE_MARQUE_APRES,
  INSTANTANE_MARQUE_AVANT,
  INSTANTANE_OFFSET_APRES,
  INSTANTANE_OFFSET_AVANT,
  etapeLectureMarque,
  etapesEcritureMarque,
  runSteps,
} from "/src/vm/guest-scenarios.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import { createSha256Stream } from "/src/vm/sha256-stream.mjs";
import { createV86BufferAdapter } from "/src/vm/v86-buffer-adapter.mjs";
import { cleDuBanc } from "./cle-du-banc.mjs";
import {
  capturerApresPointDeControle,
  ouvrirInstantanePourReprise,
} from "./reference-worker-instantane.mjs";

/** Taille du volume. Assez pour deux marques éloignées, assez peu pour que l'épreuve reste courte. */
const VOLUME_OCTETS = 16 * 1024 * 1024;

/** La marque d'AVANT la capture, écrite par une session ordinaire. */
const AVANT = {
  marque: INSTANTANE_MARQUE_AVANT,
  offset: INSTANTANE_OFFSET_AVANT,
  etiquette: "avant",
};
/** La marque d'APRÈS la reprise, écrite par une mémoire RESTAURÉE. C'est elle qui est en cause. */
const APRES = {
  marque: INSTANTANE_MARQUE_APRES,
  offset: INSTANTANE_OFFSET_APRES,
  etiquette: "apres",
};

/** Écrit une marque, barrière comprise, et rend la sortie de la dernière étape. */
async function ecrireLaMarque(session, marque) {
  const resultats = await runSteps(session, etapesEcritureMarque(marque));
  return resultats.at(-1).output;
}

/** Relit une marque depuis le disque du guest. */
async function relireLaMarque(session, marque) {
  const etape = etapeLectureMarque(marque);
  const resultat = await session.shell(etape.command, { label: etape.label });
  return resultat.output;
}

/**
 * EMPREINTE de l'image de ce guest : les artefacts réellement acquis, dans un ordre fixe.
 *
 * Le rootfs de l'image Rails n'existe pas ici — le système vient du cédérom —, si bien que la liste
 * canonique de `reference-worker-instantane.mjs` ne s'applique pas. C'est la seule différence : le
 * procédé est le même, et l'empreinte est prise sur les OCTETS ACQUIS, jamais sur un manifeste que
 * celui qui la présente aurait écrit.
 */
async function empreinteDuGuest(artifacts) {
  const flux = createSha256Stream();
  for (const nom of ["wasm", "bios", "vgaBios", "cdrom"]) {
    const partiel = createSha256Stream();
    partiel.update(artifacts[nom]);
    flux.update(new TextEncoder().encode(`${nom}:`));
    flux.update(partiel.digest());
  }
  return flux.digest();
}

/** Ouvre le volume — en le créant au premier passage, en le RETROUVANT ensuite. */
async function ouvrirLeVolume({ volume, neuf }) {
  if (neuf) await removeOpfsVolume(volume);
  const journal = new BlockJournal();
  const backend = await openOpfsVolume({
    name: volume,
    size: VOLUME_OCTETS,
    journal,
    faults: createFaultPlan(),
    cle: cleDuBanc(),
  });
  return { journal, backend };
}

/**
 * Arme la session AVEC la liaison de volume : sans elle, `get_state` refuse et aucune capture n'est
 * possible. C'est la seule différence avec l'armement des scénarios de barrière.
 */
function armerPourInstantane({ V86, artifacts, backend, journal, creerSession }) {
  const failures = [];
  const adapter = createV86BufferAdapter({
    backend,
    onFatal: (error) => failures.push(error.toJSON()),
    liaisonDeVolume: () => ({
      volume: backend.identifiantVolume,
      sequence: backend.generation?.sequenceValidee ?? 0,
      generation: backend.generation?.generationValidee ?? 0,
    }),
  });
  return { adapter, failures, session: creerSession({ V86, artifacts, adapter, journal }) };
}

/** 1. Volume NEUF, marque écrite et validée, instantané capturé au point de contrôle. */
async function capturerApresUneEcriture({ deps, volume }) {
  const { V86, artifacts, transferredBytes } = await deps.acquerirRuntime();
  const empreinteImage = await empreinteDuGuest(artifacts);
  const { journal, backend } = await ouvrirLeVolume({ volume, neuf: true });
  const { adapter, failures, session } = armerPourInstantane({
    V86,
    artifacts,
    backend,
    journal,
    creerSession: deps.creerSession,
  });

  const observations = [];
  try {
    const boot = await deps.booter(session, null, observations);
    const ecriture = await ecrireLaMarque(session, AVANT);
    const capture = await capturerApresPointDeControle({
      backend,
      session,
      adapter,
      volume,
      empreinteImage,
    });
    return {
      scenario: "instantane-capturer",
      bootMilliseconds: boot.bootMilliseconds,
      transferredBytes,
      ecriture,
      capture,
      counts: journal.counts(),
      failures,
      observationsRuntime: observations,
    };
  } finally {
    session.stop();
    await backend.close();
  }
}

/** 2. REPRISE par l'instantané, puis ÉCRITURE PAR LA SESSION REPRISE. Le cœur de la preuve. */
async function reprendreEtEcrire({ deps, volume }) {
  const { V86, artifacts } = await deps.acquerirRuntime();
  const empreinteImage = await empreinteDuGuest(artifacts);
  const { journal, backend } = await ouvrirLeVolume({ volume, neuf: false });
  const instantane = await ouvrirInstantanePourReprise({ backend, volume, empreinteImage });
  const { failures, session } = armerPourInstantane({
    V86,
    artifacts,
    backend,
    journal,
    creerSession: deps.creerSession,
  });

  const observations = [];
  try {
    const etat = instantane.utilise ? instantane.etat : null;
    const boot = await deps.booter(session, etat, observations);
    // L'état est LÂCHÉ dès la restauration : il pèse la mémoire du guest, et la suite n'en a plus
    // l'usage.
    instantane.etat = null;
    const relecture = await relireLaMarque(session, AVANT);
    const ecriture = await ecrireLaMarque(session, APRES);
    return {
      scenario: "instantane-reprendre",
      bootMilliseconds: boot.bootMilliseconds,
      usedSnapshot: instantane.utilise,
      motif: instantane.motif,
      instantaneMs: instantane.millisecondes,
      relecture,
      ecriture,
      counts: journal.counts(),
      failures,
      observationsRuntime: observations,
    };
  } finally {
    session.stop();
    // La fermeture RANGE la génération validée : c'est elle qui rend durable ce que la session
    // reprise vient d'écrire, exactement comme pour une session ordinaire.
    await backend.close();
  }
}

/** 3. Boot À FROID : l'instantané est périmé, et les DEUX marques doivent être sur le volume. */
async function relireAFroid({ deps, volume }) {
  const { V86, artifacts } = await deps.acquerirRuntime();
  const empreinteImage = await empreinteDuGuest(artifacts);
  const { journal, backend } = await ouvrirLeVolume({ volume, neuf: false });
  // La reprise est DEMANDÉE, et un refus est attendu : la session précédente a écrit, donc
  // l'instantané décrit un volume qui n'existe plus. La demander est la seule façon de prouver
  // qu'il est ÉCARTÉ plutôt que simplement ignoré.
  const instantane = await ouvrirInstantanePourReprise({ backend, volume, empreinteImage });
  instantane.etat = null;
  const { failures, session } = armerPourInstantane({
    V86,
    artifacts,
    backend,
    journal,
    creerSession: deps.creerSession,
  });

  const observations = [];
  try {
    const boot = await deps.booter(session, null, observations);
    const avant = await relireLaMarque(session, AVANT);
    const apres = await relireLaMarque(session, APRES);
    return {
      scenario: "instantane-froid",
      bootMilliseconds: boot.bootMilliseconds,
      usedSnapshot: instantane.utilise,
      motif: instantane.motif,
      marqueAvant: avant,
      marqueApres: apres,
      counts: journal.counts(),
      failures,
      observationsRuntime: observations,
    };
  } finally {
    session.stop();
    await backend.close();
  }
}

/**
 * Les trois scénarios, liés aux primitives du Worker runtime.
 *
 * Elles sont INJECTÉES plutôt qu'importées : l'acquisition du runtime, la boucle d'ordonnancement et
 * la garde de boot appartiennent au Worker, et une seconde boucle installée depuis ce module-ci
 * ferait battre l'émulateur sur une autre que celle que le produit pose.
 */
export function creerScenariosInstantane(deps) {
  const volume = (options) => options.volume ?? "guest-instantane";
  return [
    [
      "instantane-capturer",
      (options) => capturerApresUneEcriture({ deps, volume: volume(options) }),
    ],
    ["instantane-reprendre", (options) => reprendreEtEcrire({ deps, volume: volume(options) })],
    ["instantane-froid", (options) => relireAFroid({ deps, volume: volume(options) })],
  ];
}

/** Taille du volume de ces scénarios, telle que la spécification la publie dans son relevé. */
export const VOLUME_INSTANTANE_OCTETS = VOLUME_OCTETS;
