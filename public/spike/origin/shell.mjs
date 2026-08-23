// Coquille de confiance du spike #35.
//
// Elle détient le Worker runtime, le canal privilégié vers lui, et n'accorde à l'application
// qu'un `MessagePort` restreint à une seule requête. Elle est écrite comme une coquille
// compétente, PAS comme une coquille durcie : elle n'immobilise pas les intrinsèques du realm à
// la manière de RailsBox Live (ADR 0008 de Live). Ce choix est délibéré — le spike mesure ce que
// la frontière d'origine apporte sans durcissement, et l'ADR 0002 discute le durcissement comme
// mitigation complémentaire, jamais comme substitut.

import {
  MESSAGE_TYPES,
  appDocumentUrl,
  channelTargetOrigin,
  evaluateAppHello,
  expectedAppOrigin,
  isAllowedAppRequest,
  topologyOf,
} from "/src/spike/origin-topology.mjs";
import { measureIsolation } from "./isolation-probe.mjs";
import {
  CONTROL_CHANNEL_NAME,
  SHELL_SECRET,
  describeFailure,
  plantShellState,
} from "./shell-state.mjs";

const parameters = new URL(location.href).searchParams;
const topologyId = parameters.get("topologie");
const isolation = parameters.get("isolation");
const sessionToken = `jeton-${Math.random().toString(36).slice(2, 10)}`;

const statusNode = document.querySelector("#shell-status");
const reportNode = document.querySelector("#shell-report");
const frameSlot = document.querySelector("#app-frame-slot");

const diagnostics = {
  topologie: topologyId,
  origineCoquille: location.origin,
  origineAttendue: null,
  isolationPage: measureIsolation(),
  isolationWorker: null,
  etatDepose: null,
  annoncesRefusees: [],
  requetesRefusees: [],
  violationsCsp: [],
  portEmis: false,
  cadreApplicatif: "non-cree",
};

function publishDiagnostics() {
  reportNode.textContent = JSON.stringify(diagnostics, null, 2);
}

document.addEventListener("securitypolicyviolation", (event) => {
  diagnostics.violationsCsp.push({
    directive: event.effectiveDirective,
    ressource: event.blockedURI,
  });
  publishDiagnostics();
});

// --- Canal privilégié : établi avant l'existence de tout contenu applicatif -------------------

// Sous `require-corp`, un Worker dédié doit porter LUI AUSSI la politique d'intégration : sans
// cela son script est refusé et le runtime ne démarre pas. La contrainte se propage donc à chaque
// artefact du runtime, ce que l'ADR 0002 consigne comme coût d'hébergement.
const runtimeWorkerUrl = new URL("./runtime-worker.mjs", import.meta.url);
if (isolation) runtimeWorkerUrl.searchParams.set("isolation", isolation);
const runtimeWorker = new Worker(runtimeWorkerUrl, { type: "module" });
const privileged = new MessageChannel();
let pendingStatus = null;

privileged.port1.addEventListener("message", (event) => {
  const message = event.data;
  if (message?.type === "vault.unlock-ok") {
    diagnostics.isolationWorker = message.isolation;
    publishDiagnostics();
    return;
  }
  if (message?.type === "vault.runtime-status" && pendingStatus) {
    pendingStatus({ pret: message.pret });
    pendingStatus = null;
  }
});
privileged.port1.start();
runtimeWorker.postMessage({ type: "vault.privileged-channel" }, [privileged.port2]);
privileged.port1.postMessage({ type: "vault.unlock", key: SHELL_SECRET });

const controlChannel = new BroadcastChannel(CONTROL_CHANNEL_NAME);

/** Aller-retour vers le runtime. Le jeton de session traverse le canal privilégié, jamais le port applicatif. */
function askRuntimeStatus() {
  return new Promise((resolved) => {
    pendingStatus = resolved;
    controlChannel.postMessage({ type: "vault.control.heartbeat", jeton: sessionToken });
    privileged.port1.postMessage({ type: "vault.status-request", jeton: sessionToken });
  });
}

// --- Port restreint accordé à l'application ---------------------------------------------------

function onApplicationRequest(port, event) {
  const type = event.data?.type;
  if (!isAllowedAppRequest(type)) {
    diagnostics.requetesRefusees.push(String(type));
    publishDiagnostics();
    port.postMessage({
      type: MESSAGE_TYPES.refusal,
      motif: "requete-non-admise",
      recu: String(type),
    });
    return;
  }
  askRuntimeStatus().then((status) => {
    port.postMessage({ type: MESSAGE_TYPES.statusReply, pret: status.pret });
  });
}

function grantRestrictedPort(target, targetOrigin) {
  const restricted = new MessageChannel();
  restricted.port1.addEventListener("message", (event) =>
    onApplicationRequest(restricted.port1, event),
  );
  restricted.port1.start();
  target.postMessage({ type: MESSAGE_TYPES.channelGrant }, targetOrigin, [restricted.port2]);
  diagnostics.portEmis = true;
  publishDiagnostics();
}

// L'écouteur est inscrit à l'évaluation du module, avant que le moindre document applicatif existe.
let applicationFrame = null;

window.addEventListener("message", (event) => {
  const verdict = evaluateAppHello({
    type: event.data?.type,
    origin: event.origin,
    sourceIsAppFrame: applicationFrame !== null && event.source === applicationFrame.contentWindow,
    expectedOrigin: diagnostics.origineAttendue,
    alreadyGranted: diagnostics.portEmis,
  });

  if (!verdict.accepted) {
    diagnostics.annoncesRefusees.push({
      motif: verdict.reason,
      origine: event.origin,
      type: String(event.data?.type),
    });
    publishDiagnostics();
    return;
  }

  grantRestrictedPort(event.source, channelTargetOrigin(topologyId));
});

// --- Démarrage ---------------------------------------------------------------------------------

// Appâts délibérés : un secret joignable depuis le realm et un secret en stockage clé-valeur.
// Ils ne sont PAS la clé réelle — celle-ci ne quitte ni la fermeture de ce module ni le Worker —
// mais ils représentent l'état qu'une coquille finit toujours par poser sur son origine.
window.__vaultShellSecretBait = SHELL_SECRET;

async function start() {
  if (!topologyId) {
    statusNode.textContent = "coquille:topologie-absente";
    document.documentElement.dataset.shellState = "erreur";
    publishDiagnostics();
    throw new Error("La coquille exige un paramètre ?topologie=… ; aucun défaut n'est supposé.");
  }

  const topology = topologyOf(topologyId);
  diagnostics.origineAttendue = expectedAppOrigin(topologyId);
  diagnostics.etatDepose = await plantShellState();
  publishDiagnostics();

  const frame = document.createElement("iframe");
  frame.id = "app-frame";
  frame.title = "document applicatif";
  if (topology.sandbox !== null) frame.setAttribute("sandbox", topology.sandbox);
  // `?isolationCadre=aucune` sert à mesurer ce qu'une coquille sous `require-corp` fait d'une
  // iframe inter-origine qui n'a PAS opté pour COEP : le cas se produit dès qu'une origine
  // applicative n'est pas maîtrisée par l'éditeur de la coquille.
  const isolationCadre = parameters.get("isolationCadre") === "aucune" ? null : isolation;
  frame.src = appDocumentUrl(topologyId, { isolation: isolationCadre });
  frame.addEventListener("load", () => {
    diagnostics.cadreApplicatif = "charge";
    publishDiagnostics();
  });
  applicationFrame = frame;
  frameSlot.append(frame);

  if (parameters.get("sondeCsp") === "1") probeContentSecurityPolicy();

  statusNode.textContent = "coquille:prete";
  document.documentElement.dataset.shellState = "prete";
  publishDiagnostics();
}

/**
 * Encadre une origine absente de `frame-src` pour rendre la CSP observable. Sans cette sonde, une
 * CSP écrite mais inopérante passerait pour une protection.
 */
function probeContentSecurityPolicy() {
  const forbidden = document.createElement("iframe");
  forbidden.id = "csp-probe-frame";
  forbidden.title = "origine hors liste d'admission";
  forbidden.src = "http://127.0.0.1:4199/interdit.html";
  frameSlot.append(forbidden);
}

start().catch((error) => {
  statusNode.textContent = `coquille:erreur ${describeFailure(error)}`;
  document.documentElement.dataset.shellState = "erreur";
});
