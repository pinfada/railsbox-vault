// Worker runtime de la preuve de reprise (#7). C'est le SEUL contexte autorisé à ouvrir le handle
// exclusif OPFS et à porter v86 (ADR 0002) : la coquille ne reçoit que des données JSON.
//
// Ce fichier n'est plus qu'un AIGUILLAGE : il nomme les phases, les appelle, et met en forme ce
// qu'elles rendent. Les phases elles-mêmes vivent par familles, ce qui borne chaque module bien en
// deçà du plafond de 800 lignes du dépôt et laisse chaque famille se lire d'un bloc :
//
//   reference-worker-boot.mjs             acquisition du runtime et boot vérifié
//   reference-worker-phases-boot.mjs      live, resume, live-couper, live-capturer,
//                                         resume-instantane, resume-arm, resume-fire
//   reference-worker-phases-volume.mjs    prepare, prepare-empty, cleanup, revoke-manifest,
//                                         inspect-volume, digest-volume
//   reference-worker-phases-archive.mjs   export, verify-export, archive-file, import
//   reference-worker-phases-migration.mjs migrate
//   reference-worker-phases-enveloppe.mjs enveloppe-creer, enveloppe-remplacer, enveloppe-ouvrir,
//                                         enveloppe-retirer (#21, ADR 0020)
//   reference-worker-mesures.mjs          instantané de stockage, comptage des lectures
//
// Une option traverse toutes les phases depuis #21 : `deverrouillerPar`. Quand elle nomme une clé,
// l'enveloppe du volume est ouverte AVANT la phase et la clé développée est installée pour sa durée
// seulement. C'est ce qui permet de booter Rails sur un volume ouvert par une CLÉ DE
// DÉVERROUILLAGE, et pas par le jeton du harnais.
//
// Les phases sont appelées chacune dans un Worker NEUF par le test E2E, pour que « fermer page +
// Worker + handles » soit réel entre elles.
//
// Aucune phase ne se déclare « réussie » d'elle-même : elle rend ce qu'elle a observé, et
// l'assertion vit dans les spécifications de `tests/e2e/`.

import { poserCleDuBanc } from "./cle-du-banc.mjs";
import {
  installerCleParKek,
  phaseEnveloppeCreer,
  phaseEnveloppeOuvrir,
  phaseEnveloppeRemplacer,
  phaseEnveloppeRetirer,
} from "./reference-worker-phases-enveloppe.mjs";
import {
  phaseArchiveFile,
  phaseExportVolume,
  phaseImport,
  phaseVerifyExport,
} from "./reference-worker-phases-archive.mjs";
import {
  phaseLive,
  phaseLiveCapturer,
  phaseLiveCouper,
  phaseResume,
  phaseResumeArm,
  phaseResumeFire,
  phaseResumeInstantane,
} from "./reference-worker-phases-boot.mjs";
import { phaseMigrate } from "./reference-worker-phases-migration.mjs";
import {
  phaseCleanup,
  phaseDigestVolume,
  phaseInspectVolume,
  phasePrepare,
  phasePrepareEmpty,
  phaseRevokeManifest,
} from "./reference-worker-phases-volume.mjs";

/** Feasibilité : prepare puis live dans un même Worker. Le test E2E n'utilise pas cette phase. */
async function phaseFull(options) {
  const prepare = await phasePrepare(options);
  const live = await phaseLive(options);
  return { phase: "full", prepare, live };
}

const PHASES = new Map([
  ["prepare", phasePrepare],
  ["prepare-empty", phasePrepareEmpty],
  ["cleanup", phaseCleanup],
  ["live", phaseLive],
  ["live-couper", phaseLiveCouper],
  ["live-capturer", phaseLiveCapturer],
  ["resume-instantane", phaseResumeInstantane],
  ["resume", phaseResume],
  ["resume-arm", phaseResumeArm],
  ["resume-fire", phaseResumeFire],
  ["export", phaseExportVolume],
  ["verify-export", phaseVerifyExport],
  ["revoke-manifest", phaseRevokeManifest],
  ["inspect-volume", phaseInspectVolume],
  ["digest-volume", phaseDigestVolume],
  ["archive-file", phaseArchiveFile],
  ["import", phaseImport],
  ["migrate", phaseMigrate],
  ["enveloppe-creer", phaseEnveloppeCreer],
  ["enveloppe-remplacer", phaseEnveloppeRemplacer],
  ["enveloppe-ouvrir", phaseEnveloppeOuvrir],
  ["enveloppe-retirer", phaseEnveloppeRetirer],
  ["full", phaseFull],
]);

/**
 * Exécute une phase, éventuellement sous une clé de volume DÉVELOPPÉE d'une enveloppe (#21).
 *
 * Quand `deverrouillerPar` nomme une clé, l'enveloppe est ouverte AVANT la phase et la clé
 * développée est installée pour sa durée seulement, puis effacée. C'est ce qui permet au scénario de
 * bout en bout de booter Rails sur un volume ouvert par une clé de déverrouillage plutôt que par le
 * jeton du harnais — sans quoi la rotation ne serait démontrée à aucun niveau où elle compte.
 *
 * **L'option ne s'appelle PAS `kek`, et ce n'est pas un détail de nom.** Elle l'a été, et le
 * scénario de bout en bout l'a réfuté : `enveloppe-ouvrir` prend elle aussi une `kek` — celle
 * qu'elle doit ESSAYER, y compris quand on attend un refus. Un préambule qui ouvrait l'enveloppe
 * sous cette même clé faisait échouer la phase AVANT qu'elle ne s'exécute, si bien que l'épreuve du
 * refus de l'ancienne clé ne pouvait pas être écrite. Deux intentions distinctes méritent deux noms
 * distincts.
 */
async function executerPhase(runner, options) {
  if (!options.deverrouillerPar) return runner(options);
  const installee = await installerCleParKek({ ...options, kek: options.deverrouillerPar });
  try {
    const rapport = await runner(options);
    return { ...rapport, enveloppe: { kek: options.deverrouillerPar, version: installee.version } };
  } finally {
    installee.relacher();
  }
}

self.addEventListener("message", (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== "run") {
    self.postMessage({ id, ok: false, error: { message: `Message inattendu : ${type}` } });
    return;
  }
  const options = payload ?? {};
  const runner = PHASES.get(options.phase ?? "full");
  if (!runner) {
    self.postMessage({ id, ok: false, error: { message: `Phase inconnue : ${options.phase}` } });
    return;
  }
  // Le jeton du harnais vaut pour la durée de la phase, et pour elle seule (ADR 0016). Ce Worker
  // est un BANC : il le reçoit de la page, jamais du produit.
  const relacher = poserCleDuBanc(options.jetonCle);
  executerPhase(runner, options)
    .finally(relacher)
    .then(
      (report) => self.postMessage({ id, ok: true, report }),
      (error) =>
        self.postMessage({
          id,
          ok: false,
          // Le CONTEXTE traverse le port au même titre que le code (#73). Sans lui, un échec de
          // support arrive en CI réduit à une phrase : ni offset, ni quota, ni errno — c'est-à-dire
          // sans rien de ce qui permet de le diagnostiquer. Il ne porte que des nombres et des noms.
          error: {
            name: error.name,
            code: error.code ?? null,
            message: error.message,
            context: error.context ?? null,
            // Le TRANSCRIPT SÉRIE d'un `BootTimeout`, quand il y en a un. Sans lui, « Rails n'a pas
            // répondu » arrive côté test sans une ligne de ce que le guest a dit — c'est-à-dire
            // exactement le silence que #52 combat, déplacé d'un cran. Il ne porte que la sortie
            // console du guest de référence, publique et déterministe.
            transcript: typeof error.transcript === "string" ? error.transcript : null,
          },
        }),
    );
});
