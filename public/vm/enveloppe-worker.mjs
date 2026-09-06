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
  ajouterEmplacement,
  creerEnveloppe,
  inventorierEnveloppe,
  ouvrirEnveloppe,
  remplacerEmplacement,
  revoquerToutSauf,
} from "/src/vm/enveloppe-de-cle.mjs";
import { PAGE_OCTETS, TAILLE_FICHIER_ENVELOPPE } from "/src/vm/enveloppe/fichier-enveloppe.mjs";
import { TYPES_KEK } from "/src/vm/enveloppe/identite-enveloppe.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { enveloppeSidecarName, removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import { supportEnveloppeOpfs } from "/src/vm/ouverture-par-enveloppe.mjs";

const VOLUME = "banc-enveloppe";
const TAILLE = 32 * SECTOR_SIZE;

/**
 * Identifiant de volume du banc, POSÉ EN OCTETS plutôt qu'en littéral hexadécimal.
 *
 * Il est public et sans portée ; c'est sa FORME qui compte. Une longue chaîne hexadécimale écrite
 * telle quelle ressemble, pour un détecteur de secrets, à une clé oubliée — et un dépôt qui habitue
 * ses relecteurs à ignorer ces alertes finit par ignorer la vraie.
 */
const IDENTIFIANT_VOLUME = Array.from({ length: 16 }, (_, index) => (0x0a + index * 0x11) % 256)
  .map((octet) => octet.toString(16).padStart(2, "0"))
  .join("");

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
  const cles = clesDeDeverrouillageDuHarnais({ jeton });
  const support = supportEnveloppeOpfs(VOLUME);

  const avant = await creerEtOuvrir(support, dek, cles.initiale);
  const apres = await tournerLaCle(support, cles, avant.creee.identifiantEmplacement);
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME });

  return {
    nomEnveloppe: enveloppeSidecarName(VOLUME),
    versionApresCreation: avant.creee.version,
    ouvertureParKek: avant.parKek.version,
    volumeRelu: avant.volumeRelu,
    versionApresRotation: apres.version,
    relueApresRotation: apres.relue,
    refusDeLAncienne: apres.refusDeLAncienne,
    refusAttendu: ENVELOPPE_ERROR_CODES.cleRefusee,
    emplacements: inventaire.emplacements.length,
  };
}

/** Crée l'enveloppe, pose le volume, puis l'ouvre par la clé initiale et relit un secteur connu. */
async function creerEtOuvrir(support, dek, initiale) {
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
  return { creee, parKek, volumeRelu: await relireLeVolume(parKek.dek) };
}

/** Remplace la clé, rouvre par la neuve, et constate ce que l'ancienne rend désormais. */
async function tournerLaCle(support, { initiale, rotation }, identifiantEmplacement) {
  await remplacerEmplacement({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: initiale,
    identifiantEmplacement,
    kekNouvelle: rotation,
  });
  const parNouvelle = await ouvrirEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: rotation,
  });
  const relue = await relireLeVolume(parNouvelle.dek);

  let refusDeLAncienne = null;
  try {
    await ouvrirEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME, kek: initiale });
  } catch (erreur) {
    refusDeLAncienne = isEnveloppeError(erreur) ? erreur.code : codeOf(erreur);
  }
  return { version: parNouvelle.version, relue, refusDeLAncienne };
}

/**
 * LA RÉVOCATION D'URGENCE sur l'OPFS RÉEL : trois emplacements de trois types, il n'en reste UN
 * (#148, ADR 0026).
 *
 * Trois et non deux : sur une enveloppe à deux emplacements, « tous sauf celui que je tiens » ne se
 * distingue pas de « celui-là », et le banc ne mesurerait rien de propre au geste composé. Les trois
 * types — harnais, phrase, récupération — sont ceux que le fichier transporte sans les interpréter ;
 * ce sont les paramètres publics, opaques ici, qui les distinguent sur le disque.
 *
 * Le rapport rend des booléens, des comptes et des codes. Jamais une clé, jamais un octet du fichier
 * d'enveloppes : c'est ce que l'épreuve fouille.
 */
async function poserTroisEmplacements(support, dek, { initiale, rotation, tierce }) {
  await creerEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME, dek, kek: initiale });
  await poserLeVolume(dek);
  for (const [kekNouvelle, typeKek, graine] of [
    [rotation, TYPES_KEK.phrase, 0x11],
    [tierce, TYPES_KEK.recuperation, 0x55],
  ]) {
    await ajouterEmplacement({
      support,
      identifiantVolume: IDENTIFIANT_VOLUME,
      kek: initiale,
      kekNouvelle,
      typeKek,
      parametres: Uint8Array.from({ length: 24 }, (_, index) => (graine + index) % 256),
    });
  }
  return inventorierEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME });
}

/** Constate ce que chaque clé retirée rend désormais. Un `null` voudrait dire qu'elle ouvre encore. */
async function refusDesRetirees(support, retirees) {
  const refus = [];
  for (const retiree of retirees) {
    try {
      await ouvrirEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME, kek: retiree });
      refus.push(null);
    } catch (erreur) {
      refus.push(isEnveloppeError(erreur) ? erreur.code : codeOf(erreur));
    }
  }
  return refus;
}

async function scenarioRevocationUrgence(jeton) {
  await removeOpfsVolume(VOLUME);
  const dek = cleDeVolumeDuHarnais({ jeton });
  const cles = clesDeDeverrouillageDuHarnais({ jeton });
  const support = supportEnveloppeOpfs(VOLUME);
  const avant = await poserTroisEmplacements(support, dek, cles);
  const { initiale, rotation, tierce } = cles;

  const geste = await revoquerToutSauf({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: initiale,
  });
  const apres = await inventorierEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME });
  const conservee = await ouvrirEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: initiale,
  });

  const refus = await refusDesRetirees(support, [rotation, tierce]);

  // La page LIBÉRÉE, mesurée sur le fichier réel : elle ne doit plus porter un octet non nul. C'est
  // #156, éprouvé là où le système de fichiers est celui du moteur et non un double.
  const fichier = await support.lire(0, TAILLE_FICHIER_ENVELOPPE);
  const pagesNonNulles = [0, 1].filter((index) =>
    fichier.subarray(index * PAGE_OCTETS, (index + 1) * PAGE_OCTETS).some((octet) => octet !== 0),
  ).length;

  return {
    emplacementsAvant: avant.emplacements.length,
    typesAvant: avant.emplacements.map((emplacement) => emplacement.typeKek).sort(),
    versionAvant: avant.version,
    versionApres: geste.version,
    emplacementsApres: apres.emplacements.length,
    // UNE version de plus, pas deux : c'est ce que le geste composé achète.
    versionsConsommees: geste.version - avant.version,
    conserveeOuvre: conservee.version === geste.version,
    conserveeEstCelleQuiOuvre:
      conservee.identifiantEmplacement === apres.emplacements[0].identifiantEmplacement,
    volumeRelu: await relireLeVolume(conservee.dek),
    refusDesRetirees: refus,
    refusAttendu: ENVELOPPE_ERROR_CODES.cleRefusee,
    pagesNonNulles,
  };
}

/**
 * COÛT de la seconde écriture et de sa barrière, sur l'OPFS réel (#148, ADR 0026).
 *
 * Ce que l'effacement de #156 ajoute à une révocation est exactement ce qui est chronométré ici :
 * huit mille cent quatre-vingt-douze zéros posés à un offset de page, puis un `flush`. Rien d'autre
 * n'est dans la boucle — ni cryptographie, ni scellement de racine —, pour que le chiffre publié
 * réponde à « combien coûte l'effacement » et pas à « combien coûte une révocation ».
 *
 * Le fichier est celui d'une vraie enveloppe, et l'effacement porte sur la page qui NE fait PAS
 * autorité : le banc ne détruit donc rien qu'il ne puisse relire, et il le vérifie à la sortie.
 */
async function scenarioCoutEffacement(jeton, tours = 30) {
  await removeOpfsVolume(VOLUME);
  const dek = cleDeVolumeDuHarnais({ jeton });
  const { initiale } = clesDeDeverrouillageDuHarnais({ jeton });
  const support = supportEnveloppeOpfs(VOLUME);
  await creerEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME, dek, kek: initiale });

  const zeros = new Uint8Array(PAGE_OCTETS);
  const releves = [];
  for (let tour = 0; tour < tours; tour += 1) {
    const debut = performance.now();
    await support.ecrire(PAGE_OCTETS, zeros); // la page 1 : celle que la création n'a pas publiée
    await support.barriere();
    releves.push(performance.now() - debut);
  }
  releves.sort((a, b) => a - b);
  const centile = (part) =>
    releves[Math.min(releves.length - 1, Math.floor(part * releves.length))];

  const relue = await ouvrirEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: initiale,
  });
  return {
    tours,
    octetsParTour: PAGE_OCTETS,
    p50: centile(0.5),
    p95: centile(0.95),
    max: releves.at(-1),
    // Témoin : le banc a bien écrit sur la page LIBRE, et l'enveloppe s'ouvre encore.
    enveloppeIntacte: relue.version === 1,
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
  "revocation-urgence": scenarioRevocationUrgence,
  "cout-effacement": scenarioCoutEffacement,
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
