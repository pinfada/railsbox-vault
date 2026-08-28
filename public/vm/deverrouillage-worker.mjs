// Worker de confiance du banc de DÉVERROUILLAGE (#22, ADR 0021).
//
// Il fait ce que le Worker d'enveloppe de #21 faisait, avec une clé DÉRIVÉE à la place d'une clé de
// harnais : poser un volume, l'ouvrir sous une KEK obtenue d'une phrase ou d'une passkey, relire un
// secteur connu, et rendre à la page des données JSON — jamais une clé, jamais un octet du fichier
// d'enveloppes.
//
// ## Où chaque dérivation se fait, et pourquoi ce n'est pas au même endroit
//
// C'est une décision de l'ADR 0021, forcée par la plate-forme et non par un goût :
//
//  - **`phrase` est dérivée ICI.** Argon2id calibré coûte quelques centaines de millisecondes de
//    calcul continu ; le faire sur le fil de la page gèlerait l'interface à chaque tentative. La
//    phrase franchit donc le port page → Worker, à l'intérieur de l'origine de CONFIANCE. Ce n'est
//    pas la frontière que `SEC-ORIGIN-001` protège — celle-là sépare l'origine applicative de
//    celle-ci, et rien de ce message ne la traverse ;
//  - **`webauthn-prf` est dérivée dans la PAGE.** `navigator.credentials` n'existe pas dans un
//    Worker : l'appel DOIT partir d'un document. Le Worker reçoit alors la `CryptoKey` déjà
//    dérivée, par clone structuré — elle est non extractible, donc ce qui franchit le port est un
//    handle opaque et non un secret. La sortie PRF brute, elle, ne quitte jamais la page.
//
// Aucun scénario ne rend « réussi » de lui-même : il rend ce qu'il a observé, et l'épreuve juge.

import { SECTOR_SIZE } from "/src/vm/block-geometry.mjs";
import { argon2Vendu } from "/src/vm/derivation/argon2-vendu.mjs";
import {
  CALIBRATION_PHRASE,
  derivateurPhrase,
  parametresDePhrase,
} from "/src/vm/derivation/derivateur-phrase.mjs";
import { preparerEmplacementDerive } from "/src/vm/derivation/emplacement-derive.mjs";
import { creerEnveloppe, ouvrirEnveloppe } from "/src/vm/enveloppe-de-cle.mjs";
import { isEnveloppeError } from "/src/vm/enveloppe/enveloppe-errors.mjs";
import { TYPES_KEK } from "/src/vm/enveloppe/identite-enveloppe.mjs";
import { octetsEnHex, hexEnOctets } from "/src/vm/format-chiffre/octets.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import { supportEnveloppeOpfs } from "/src/vm/ouverture-par-enveloppe.mjs";

const VOLUME = "banc-deverrouillage";
const TAILLE = 32 * SECTOR_SIZE;

/** Identifiant de volume du banc, POSÉ EN OCTETS : un long littéral hexadécimal ressemble à une clé. */
const IDENTIFIANT_VOLUME = octetsEnHex(
  Uint8Array.from({ length: 16 }, (_, index) => (0x0a + index * 0x11) % 256),
);

/** Sel public de l'emplacement `phrase` du banc. Public par construction (ADR 0020). */
const SEL = octetsEnHex(Uint8Array.from({ length: 16 }, (_, index) => (0x0e + index) % 256));

const argon2 = argon2Vendu();

function codeOf(error) {
  return typeof error?.code === "string" ? error.code : null;
}

/** Contenu déterministe d'un secteur : c'est ce qui rend la relecture probante. */
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

async function poserLeVolume(dek) {
  const backend = await openOpfsVolume({
    name: VOLUME,
    size: TAILLE,
    cle: dek,
    identifiantVolume: IDENTIFIANT_VOLUME,
    transactionnel: false,
  });
  try {
    await backend.write(0, secteur(11));
    await backend.flush();
  } finally {
    await backend.close();
  }
}

async function relireLeVolume(dek) {
  const backend = await openOpfsVolume({
    name: VOLUME,
    size: TAILLE,
    cle: dek,
    identifiantVolume: IDENTIFIANT_VOLUME,
    transactionnel: false,
  });
  try {
    return memesOctets(await backend.read(0, SECTOR_SIZE), secteur(11));
  } finally {
    await backend.close();
  }
}

/** Rejoue les vecteurs REJOUABLES de la RFC 9106 avec l'artefact servi depuis `/vendor/`. */
async function scenarioVecteurs({ vecteurs }) {
  const rendus = [];
  for (const cas of vecteurs) {
    const obtenu = await argon2.hacher({
      variante: cas.variante,
      mot: hexEnOctets(cas.motDePasseHex),
      sel: hexEnOctets(cas.selHex),
      secret: hexEnOctets(cas.secretHex),
      donneesAssociees: hexEnOctets(cas.donneesAssocieesHex),
      memoireKio: cas.memoireKio,
      iterations: cas.iterations,
      parallelisme: cas.parallelisme,
      longueur: cas.longueur,
    });
    rendus.push({
      section: cas.section,
      variante: cas.variante,
      empreinteHex: octetsEnHex(obtenu),
    });
  }
  return { rendus };
}

/** Pose l'enveloppe et le volume sous une phrase, et rend l'identité de l'emplacement créé. */
async function poserSousPhrase(support, derivateur, parametres, phrase) {
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const prepare = await preparerEmplacementDerive({
    identifiantVolume: IDENTIFIANT_VOLUME,
    derivateur,
    parametres,
    geste: { phrase },
  });
  const creee = await creerEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    dek,
    kek: prepare.kek,
    typeKek: TYPES_KEK.phrase,
    parametres,
    identifiantEmplacement: prepare.identifiantEmplacement,
  });
  await poserLeVolume(dek);
  dek.fill(0);
  return {
    version: creee.version,
    identite: {
      identifiantVolume: IDENTIFIANT_VOLUME,
      identifiantEmplacement: creee.identifiantEmplacement,
    },
  };
}

/** Le refus que rend une phrase FAUSSE. C'est celui de l'enveloppe, jamais celui du dérivateur. */
async function refusDUneFausse(support, derivateur, parametres, identite, phrase) {
  const fausse = await derivateur.deriver({ parametres, identite, geste: { phrase } });
  try {
    await ouvrirEnveloppe({ support, identifiantVolume: IDENTIFIANT_VOLUME, kek: fausse });
  } catch (erreur) {
    return isEnveloppeError(erreur) ? erreur.code : codeOf(erreur);
  }
  return null;
}

/** Un cycle complet sous une phrase : créer, ouvrir, relire, puis refuser une phrase fausse. */
async function scenarioPhrase({ phrase }) {
  await removeOpfsVolume(VOLUME);
  const derivateur = derivateurPhrase({ argon2 });
  const support = supportEnveloppeOpfs(VOLUME);
  const parametres = parametresDePhrase({ sel: SEL, ...CALIBRATION_PHRASE });
  const pose = await poserSousPhrase(support, derivateur, parametres, phrase);

  const debut = performance.now();
  const juste = await derivateur.deriver({
    parametres,
    identite: pose.identite,
    geste: { phrase },
  });
  const coutDerivationMs = performance.now() - debut;
  const ouverte = await ouvrirEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek: juste,
  });
  const volumeRelu = await relireLeVolume(ouverte.dek);
  ouverte.dek.fill(0);

  return {
    version: pose.version,
    volumeRelu,
    refusDeLaFausse: await refusDUneFausse(
      support,
      derivateur,
      parametres,
      pose.identite,
      `${phrase} pas`,
    ),
    coutDerivationMs: Math.round(coutDerivationMs),
  };
}

/**
 * CRÉE une enveloppe et son volume sous une KEK dérivée DANS LA PAGE (passkey).
 *
 * La page a fait l'appel WebAuthn — seul un document le peut — et n'envoie ici que la `CryptoKey`
 * non extractible, par clone structuré. Ce Worker ne voit ni la sortie PRF, ni les octets de la KEK.
 */
async function scenarioPrfCreer({ kek, parametres, identifiantEmplacement }) {
  await removeOpfsVolume(VOLUME);
  const support = supportEnveloppeOpfs(VOLUME);
  const dek = crypto.getRandomValues(new Uint8Array(32));
  const creee = await creerEnveloppe({
    support,
    identifiantVolume: IDENTIFIANT_VOLUME,
    dek,
    kek,
    typeKek: TYPES_KEK["webauthn-prf"],
    parametres: new Uint8Array(parametres),
    identifiantEmplacement,
  });
  await poserLeVolume(dek);
  dek.fill(0);
  return { version: creee.version, identifiantEmplacement: creee.identifiantEmplacement };
}

/** OUVRE ce volume sous une KEK dérivée dans la page, et relit le secteur connu. */
async function scenarioPrfOuvrir({ kek }) {
  const ouverte = await ouvrirEnveloppe({
    support: supportEnveloppeOpfs(VOLUME),
    identifiantVolume: IDENTIFIANT_VOLUME,
    kek,
  });
  const volumeRelu = await relireLeVolume(ouverte.dek);
  ouverte.dek.fill(0);
  return { volumeRelu, version: ouverte.version };
}

/** Chronomètre la dérivation calibrée. Le coût est le sujet, pas un effet de bord. */
async function scenarioMesure({ phrase, tours }) {
  const derivateur = derivateurPhrase({ argon2 });
  const parametres = parametresDePhrase({ sel: SEL, ...CALIBRATION_PHRASE });
  const identite = {
    identifiantVolume: IDENTIFIANT_VOLUME,
    identifiantEmplacement: "0102030405060708",
  };
  const echantillons = [];
  for (let tour = 0; tour < tours; tour += 1) {
    const debut = performance.now();
    await derivateur.deriver({ parametres, identite, geste: { phrase } });
    echantillons.push(performance.now() - debut);
  }
  echantillons.sort((gauche, droite) => gauche - droite);
  const rang = (part) =>
    echantillons[Math.min(echantillons.length - 1, Math.floor(part * echantillons.length))];
  return {
    tours,
    memoireKio: CALIBRATION_PHRASE.memoireKio,
    iterations: CALIBRATION_PHRASE.iterations,
    parallelisme: CALIBRATION_PHRASE.parallelisme,
    p50Ms: Math.round(rang(0.5)),
    p95Ms: Math.round(rang(0.95)),
    maxMs: Math.round(echantillons.at(-1)),
  };
}

/** Ce que CE moteur offre au Worker. Un refus est enregistré avec son code — une mesure, pas un aveu. */
async function scenarioCapacite() {
  const measurement = {
    workerGetDirectory: typeof globalThis.navigator?.storage?.getDirectory,
    workerCreateSyncAccessHandle:
      typeof globalThis.FileSystemFileHandle?.prototype?.createSyncAccessHandle,
    credentialsDansLeWorker: typeof globalThis.navigator?.credentials,
    openCode: null,
    argon2Code: null,
  };
  try {
    await removeOpfsVolume(VOLUME);
    await supportEnveloppeOpfs(VOLUME).allouer(0);
  } catch (error) {
    measurement.openCode = codeOf(error);
  }
  try {
    // L'artefact est-il servi et conforme ? La question est indépendante d'OPFS, et sa réponse
    // décide si les vecteurs peuvent être rejoués sur ce moteur.
    await argon2.hacher({
      variante: "id",
      mot: new Uint8Array(8),
      sel: new Uint8Array(16),
      memoireKio: 32,
      iterations: 1,
      parallelisme: 1,
      longueur: 32,
    });
  } catch (error) {
    measurement.argon2Code = codeOf(error);
  }
  return measurement;
}

const SCENARIOS = {
  capacite: scenarioCapacite,
  vecteurs: scenarioVecteurs,
  phrase: scenarioPhrase,
  mesure: scenarioMesure,
  "prf-creer": scenarioPrfCreer,
  "prf-ouvrir": scenarioPrfOuvrir,
};

self.addEventListener("message", async (event) => {
  const { id, type, payload } = event.data ?? {};
  if (type !== "run") return;
  const scenario = SCENARIOS[payload?.scenario];
  if (!scenario) {
    self.postMessage({
      id,
      ok: false,
      error: { code: "VAULT_BANC_SCENARIO_INCONNU", message: `Scénario ${payload?.scenario}` },
    });
    return;
  }
  try {
    self.postMessage({ id, ok: true, report: await scenario(payload ?? {}) });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: { code: codeOf(error), message: error?.message ?? String(error) },
    });
  }
});
