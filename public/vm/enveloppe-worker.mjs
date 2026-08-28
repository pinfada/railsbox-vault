// Worker de confiance du banc d'ENVELOPPE DE CLÉ (#21, ADR 0020).
//
// C'est le SEUL contexte autorisé à ouvrir un handle exclusif, et donc le seul à voir une clé de
// volume. Il rend à la page des données JSON, jamais une clé, jamais un fichier d'enveloppes,
// jamais un handle — et l'épreuve `tests/browser/enveloppe-frontiere.spec.mjs` FOUILLE ce qu'il rend
// à la recherche des octets des clés de TEST, au lieu de le croire sur parole.
//
// Aucun scénario ne rend « réussi » de lui-même : il rend ce qu'il a observé. Une capacité absente
// devient une erreur typée remontée à la page, jamais un repli silencieux.

import { SECTOR_SIZE } from "/src/vm/block-geometry.mjs";
import { cleDeVolumeDuHarnais, clesDeDeverrouillageDuHarnais } from "/src/vm/cle-de-volume.mjs";
import { ENVELOPPE_ERROR_CODES, isEnveloppeError } from "/src/vm/enveloppe/enveloppe-errors.mjs";
import {
  creerEnveloppe,
  inventorierEnveloppe,
  ouvrirEnveloppe,
  remplacerEmplacement,
} from "/src/vm/enveloppe-de-cle.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { enveloppeSidecarName, removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import { supportEnveloppeOpfs } from "/src/vm/ouverture-par-enveloppe.mjs";

const VOLUME = "banc-enveloppe";
const TAILLE = 32 * SECTOR_SIZE;
const IDENTIFIANT_VOLUME = "0a1b2c3d4e5f60718293a4b5c6d7e8f9";

/** Code d'une erreur typée, ou `null` si l'opération a réussi — ce qui est parfois un échec. */
function codeOf(error) {
  return typeof error?.code === "string" ? error.code : null;
}

/** Contenu déterministe d'un secteur, pour que la relecture prouve quelque chose. */
function secteur(graine) {
  return Uint8Array.from({ length: SECTOR_SIZE }, (_, index) => (index * 7 + graine) & 0xff);
}

function memesOctets(gauche, droite) {
  if (gauche.byteLength !== droite.byteLength) return false;
  for (let index = 0; index < gauche.byteLength; index += 1) {
    if (gauche[index] !== droite[index]) return false;
  }
  return true;
}

/** Écrit un secteur connu dans un volume neuf scellé sous `dek`, puis referme. */
async function poserLeVolume(dek) {
  const backend = await openOpfsVolume({
    name: VOLUME,
    size: TAILLE,
    cle: dek,
    identifiantVolume: IDENTIFIANT_VOLUME,
    transactionnel: false,
  });
  try {
    await backend.write(0, secteur(3));
    await backend.flush();
  } finally {
    await backend.close();
  }
}

/** Relit le secteur connu sous la clé développée. C'est ce qui prouve que la DEK est LA bonne. */
async function relireLeVolume(dek) {
  const backend = await openOpfsVolume({
    name: VOLUME,
    size: TAILLE,
    cle: dek,
    identifiantVolume: IDENTIFIANT_VOLUME,
    transactionnel: false,
  });
  try {
    return memesOctets(await backend.read(0, SECTOR_SIZE), secteur(3));
  } finally {
    await backend.close();
  }
}

/**
 * Cycle complet sur l'OPFS RÉEL : créer, ouvrir par KEK, relire le volume, remplacer la KEK, rouvrir
 * par la neuve, refuser l'ancienne.
 *
 * Chaque étape rend un BOOLÉEN ou un CODE, jamais une clé ni un octet du fichier d'enveloppes. Le
 * rapport est ce qui franchit le port, et il est fouillé par l'épreuve.
 */
async function scenarioCycle(jeton) {
  await removeOpfsVolume(VOLUME);
  const dek = cleDeVolumeDuHarnais({ jeton });
  const { initiale, rotation } = clesDeDeverrouillageDuHarnais({ jeton });
  const support = supportEnveloppeOpfs(VOLUME);

  const creee = await creerEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    dek,
    kek: initiale,
  });
  await poserLeVolume(dek);

  const parKek = await ouvrirEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: initiale,
  });
  const volumeRelu = await relireLeVolume(parKek.dek);

  await remplacerEmplacement({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: initiale,
    identifiantEmplacement: creee.identifiantEmplacement,
    kekNouvelle: rotation,
  });

  const parNouvelle = await ouvrirEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: rotation,
  });
  const relueApresRotation = await relireLeVolume(parNouvelle.dek);

  let refusDeLAncienne = null;
  try {
    await ouvrirEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME, kek: initiale });
  } catch (erreur) {
    refusDeLAncienne = isEnveloppeError(erreur) ? erreur.code : codeOf(erreur);
  }

  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME });
  return {
    nomEnveloppe: enveloppeSidecarName(VOLUME),
    versionApresCreation: creee.version,
    ouvertureParKek: parKek.version,
    volumeRelu,
    versionApresRotation: parNouvelle.version,
    relueApresRotation,
    refusDeLAncienne,
    refusAttendu: ENVELOPPE_ERROR_CODES.cleRefusee,
    emplacements: inventaire.emplacements.length,
  };
}

/** Un volume sans enveloppe : le refus doit dire « aucune enveloppe », pas « clé invalide ». */
async function scenarioSansEnveloppe(jeton) {
  const { initiale } = clesDeDeverrouillageDuHarnais({ jeton });
  await removeOpfsVolume(VOLUME);
  try {
    await ouvrirEnveloppe({
      support: supportEnveloppeOpfs(VOLUME),
      identifiantVolume: IDENTIFIANT_VOLUME,
      kek: initiale,
    });
    return { code: null, distinctDuRefusDeCle: false };
  } catch (erreur) {
    const code = isEnveloppeError(erreur) ? erreur.code : codeOf(erreur);
    return { code, distinctDuRefusDeCle: code !== ENVELOPPE_ERROR_CODES.cleRefusee };
  }
}

/** Ce que CE moteur offre au Worker. Un refus est enregistré avec son code — une mesure, pas un aveu. */
async function scenarioCapacite() {
  const measurement = {
    workerGetDirectory: typeof globalThis.navigator?.storage?.getDirectory,
    workerCreateSyncAccessHandle:
      typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle,
    openCode: null,
    openMessage: null,
  };
  try {
    await removeOpfsVolume(VOLUME);
    const support = supportEnveloppeOpfs(VOLUME);
    await support.allouer(0);
  } catch (error) {
    measurement.openCode = codeOf(error);
    measurement.openMessage = error.message;
  }
  return measurement;
}

const SCENARIOS = {
  capacite: scenarioCapacite,
  cycle: scenarioCycle,
  "sans-enveloppe": scenarioSansEnveloppe,
};

self.addEventListener("message", async (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== "run") return;
  const scenario = SCENARIOS[payload?.scenario ?? "cycle"];
  if (!scenario) {
    self.postMessage({
      id,
      ok: false,
      error: { code: "VAULT_BANC_SCENARIO_INCONNU", message: `Scénario ${payload?.scenario}` },
    });
    return;
  }
  try {
    self.postMessage({ id, ok: true, report: await scenario(payload?.jetonCle) });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: { code: codeOf(error), message: error?.message ?? String(error) },
    });
  }
});
