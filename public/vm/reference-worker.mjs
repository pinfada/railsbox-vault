// Worker runtime de la preuve de reprise (#7). C'est le SEUL contexte autorisé à ouvrir le handle
// exclusif OPFS et à porter v86 (ADR 0002) : la coquille ne reçoit que des données JSON.
//
// Ce fichier n'est plus qu'un AIGUILLAGE : il nomme les phases, les appelle, et met en forme ce
// qu'elles rendent. Les phases elles-mêmes vivent par familles, ce qui borne chaque module bien en
// deçà du plafond de 800 lignes du dépôt et laisse chaque famille se lire d'un bloc :
//
//   reference-worker-boot.mjs             acquisition du runtime et boot vérifié
//   reference-worker-phases-boot.mjs      live, resume, live-couper, resume-arm, resume-fire
//   reference-worker-phases-volume.mjs    prepare, prepare-empty, cleanup, revoke-manifest,
//                                         inspect-volume, digest-volume
//   reference-worker-phases-archive.mjs   export, verify-export, archive-file, import
//   reference-worker-phases-migration.mjs migrate
//   reference-worker-mesures.mjs          instantané de stockage, comptage des lectures
//
// Les phases sont appelées chacune dans un Worker NEUF par le test E2E, pour que « fermer page +
// Worker + handles » soit réel entre elles.
//
// Aucune phase ne se déclare « réussie » d'elle-même : elle rend ce qu'elle a observé, et
// l'assertion vit dans les spécifications de `tests/e2e/`.

import { poserCleDuBanc } from "./cle-du-banc.mjs";
import {
  phaseArchiveFile,
  phaseExportVolume,
  phaseImport,
  phaseVerifyExport,
} from "./reference-worker-phases-archive.mjs";
import {
  phaseLive,
  phaseLiveCouper,
  phaseResume,
  phaseResumeArm,
  phaseResumeFire,
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
  ["full", phaseFull],
]);

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
  // La clé du harnais est posée pour la durée de la phase, et relâchée après elle (ADR 0016).
  // Ce Worker est un BANC : le jeton lui vient de la page, jamais du produit.
  let relacher;
  try {
    relacher = poserCleDuBanc(options.jetonCle);
  } catch (error) {
    self.postMessage({ id, ok: false, error: { name: error.name, message: error.message } });
    return;
  }
  runner(options)
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
          },
        }),
    );
});
