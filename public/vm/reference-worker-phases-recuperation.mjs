// Phases de MOYEN DE RÉCUPÉRATION du banc de référence (#147, ADR 0025 ; #149, ADR 0027).
//
// Elles permettent au scénario de bout en bout de faire ce qu'aucun autre niveau ne peut faire :
// poser un moyen de récupération sur un volume RÉEL, l'emporter dans une archive, restaurer cette
// archive sur une AUTRE ORIGINE, et y ouvrir le volume par le code — puis y recréer une phrase
// secrète, comme un utilisateur le ferait après avoir perdu son appareil.
//
// ## Le CODE franchit le port, et c'est parce que c'est un BANC
//
// En production, le code est rendu une fois à l'interface (#24) et n'existe ensuite que sur une
// feuille de papier. Ici, l'épreuve doit le RETAPER sur une autre origine : elle a donc besoin de le
// recevoir. Le banc le rend une fois, exactement comme le produit, et le scénario le transporte —
// c'est le rôle que joue l'utilisateur dans la vraie vie. Aucun module de `src/` ne conserve le
// code, ne le journalise ni ne sait le régénérer, et `tests/unit/vm-derivation-recuperation.test.mjs`
// le mesure.
//
// ## Ce que ces phases ne prouvent pas
//
// Elles ne mesurent aucun coût de dérivation — c'est le banc de #22
// (`public/vm/deverrouillage-banc.mjs`) qui le chronomètre — et elles ne se déclarent jamais
// « réussies » : elles rendent ce qu'elles ont observé, et l'assertion vit dans
// `tests/e2e/archive-recuperation-inter-origine.spec.mjs`.

import { clesDeDeverrouillageDuHarnais } from "/src/vm/cle-de-volume.mjs";
import { argon2Vendu } from "/src/vm/derivation/argon2-vendu.mjs";
import {
  CALIBRATION_PHRASE,
  derivateurPhrase,
  parametresDePhrase,
  tirerSelDePhrase,
} from "/src/vm/derivation/derivateur-phrase.mjs";
import { derivateurRecuperation } from "/src/vm/derivation/derivateur-recuperation.mjs";
import { preparerEmplacementDerive } from "/src/vm/derivation/emplacement-derive.mjs";
import {
  ajouterEmplacement,
  inventorierEnveloppe,
  ouvrirEnveloppe,
} from "/src/vm/enveloppe-de-cle.mjs";
import { isEnveloppeError } from "/src/vm/enveloppe/enveloppe-errors.mjs";
import { TYPES_KEK } from "/src/vm/enveloppe/identite-enveloppe.mjs";
import { construireEnveloppeDeRecuperation } from "/src/vm/enveloppe-de-recuperation.mjs";
import { creerMoyenDeRecuperation } from "/src/vm/moyen-de-recuperation.mjs";
import {
  enveloppeSidecarName,
  manifestSidecarName,
  openOpfsSyncAccess,
  statOpfsVolume,
} from "/src/vm/opfs-sync-access.mjs";
import { readVolumeManifest } from "/src/vm/opfs-volume-open.mjs";
import { supportEnveloppeOpfs } from "/src/vm/ouverture-par-enveloppe.mjs";
import { parseManifest } from "/src/vm/volume-manifest.mjs";
import { poserCleDeveloppee } from "./cle-du-banc.mjs";

/** La clé de déverrouillage de TEST sous laquelle le banc pose ses enveloppes. */
function kekDuHarnais(jetonCle) {
  return clesDeDeverrouillageDuHarnais({ jeton: jetonCle }).initiale;
}

/** Identifiant de volume DÉCLARÉ par le manifeste voisin. Jamais celui de l'enveloppe (ADR 0016). */
async function identifiantDeclare(volume) {
  const octets = await readVolumeManifest(volume);
  if (octets === null)
    throw new Error(`Volume « ${volume} » sans manifeste : rien ne l'identifie.`);
  return parseManifest(octets).volume?.id;
}

/**
 * DÉRIVE la KEK d'un code de récupération, en lisant l'inventaire PUBLIC de l'enveloppe.
 *
 * L'inventaire ne demande aucune clé : le fichier porte en clair le type et les paramètres de
 * chaque emplacement, précisément pour qu'un dérivateur puisse lire les siens avant de dériver
 * (ADR 0020, limite 3). Un volume restauré depuis une archive n'a QU'UN emplacement, de type 4 —
 * mais rien n'oblige à le supposer, et le chercher coûte une comparaison.
 */
async function kekDuCode({ support, identifiantVolume, code }) {
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume });
  const emplacement = inventaire.emplacements.find(
    (candidat) => candidat.typeKek === TYPES_KEK.recuperation,
  );
  if (emplacement === undefined) {
    throw new Error(
      `Volume « ${identifiantVolume} » : son enveloppe ne porte aucun emplacement de récupération (${inventaire.emplacements.length} emplacement(s), types ${inventaire.emplacements.map((e) => e.typeKek).join(", ")}).`,
    );
  }
  const kek = await derivateurRecuperation().deriver({
    parametres: emplacement.parametres,
    identite: {
      identifiantVolume,
      identifiantEmplacement: emplacement.identifiantEmplacement,
    },
    geste: { code },
  });
  return { kek, identifiantEmplacement: emplacement.identifiantEmplacement };
}

/**
 * POSE un moyen de récupération sur l'enveloppe d'un volume, et rend le code UNE fois.
 *
 * L'ordre du produit est tenu par `creerMoyenDeRecuperation` et non par cette phase : l'enveloppe
 * est écrite et sa barrière franchie AVANT que le code n'existe sous une forme rendue (ADR 0025).
 */
export async function phaseRecuperationCreer({ volume, jetonCle }) {
  const identifiantVolume = await identifiantDeclare(volume);
  const moyen = await creerMoyenDeRecuperation({
    support: supportEnveloppeOpfs(volume),
    identifiantVolume,
    kek: kekDuHarnais(jetonCle),
  });
  return {
    phase: "recuperation-creer",
    volume,
    identifiantEmplacement: moyen.identifiantEmplacement,
    typeKek: moyen.typeKek,
    version: moyen.version,
    // Le banc rend le code parce que l'épreuve doit le retaper sur une AUTRE origine. Voir l'en-tête.
    code: moyen.rendre(),
  };
}

/**
 * OUVRE l'enveloppe d'un volume PAR LE CODE, et rend ce qu'elle a rendu — jamais un octet de clé.
 *
 * `versionMinimale` est la version notée sur la feuille de récupération (#149, ADR 0027,
 * décision 3) : la phase la transmet telle quelle, et rapporte le refus `VAULT_ENVELOPPE_REJEU`
 * quand la page est antérieure.
 */
export async function phaseRecuperationOuvrir({ volume, code, versionMinimale = null }) {
  const identifiantVolume = await identifiantDeclare(volume);
  const support = supportEnveloppeOpfs(volume);
  try {
    const derive = await kekDuCode({ support, identifiantVolume, code });
    const ouverte = await ouvrirEnveloppe({
      support,
      identifiantVolume,
      kek: derive.kek,
      versionMinimale,
    });
    // La clé développée est effacée ici même : cette phase ne boote rien, et rien n'en a besoin.
    poserCleDeveloppee(ouverte.dek)();
    return {
      phase: "recuperation-ouvrir",
      volume,
      ouverte: true,
      code: null,
      versionMinimale,
      version: ouverte.version,
      identifiantEmplacement: ouverte.identifiantEmplacement,
    };
  } catch (erreur) {
    return {
      phase: "recuperation-ouvrir",
      volume,
      ouverte: false,
      code: isEnveloppeError(erreur) ? erreur.code : (erreur.code ?? null),
      message: erreur.message,
      versionMinimale,
    };
  }
}

/**
 * RECRÉE un emplacement `phrase` sur un volume restauré, en présentant la KEK du CODE.
 *
 * C'est le geste qui referme le cycle de la Definition of Ready : l'utilisateur a perdu son
 * appareil, il a restauré son archive ailleurs, il l'a ouverte par le code, et il se redonne un
 * moyen quotidien. Le code, lui, reste valable — rien ici ne le révoque, et l'urgence de #148 est
 * un autre geste.
 */
export async function phaseRecuperationAjouterPhrase({ volume, code, phrase }) {
  const identifiantVolume = await identifiantDeclare(volume);
  const support = supportEnveloppeOpfs(volume);
  const derive = await kekDuCode({ support, identifiantVolume, code });
  const parametres = parametresDePhrase({ sel: tirerSelDePhrase(), ...CALIBRATION_PHRASE });
  const prepare = await preparerEmplacementDerive({
    identifiantVolume,
    derivateur: derivateurPhrase({ argon2: argon2Vendu() }),
    parametres,
    geste: { phrase },
  });
  const ajoute = await ajouterEmplacement({
    support,
    identifiantVolume,
    kek: derive.kek,
    kekNouvelle: prepare.kek,
    typeKek: prepare.typeKek,
    parametres,
    identifiantEmplacement: prepare.identifiantEmplacement,
  });
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume });
  return {
    phase: "recuperation-ajouter-phrase",
    volume,
    version: ajoute.version,
    identifiantEmplacement: prepare.identifiantEmplacement,
    emplacements: inventaire.emplacements.map((emplacement) => emplacement.typeKek),
  };
}

/**
 * INSTALLE la clé développée PAR LE CODE, pour la durée de la phase que l'appelant enchaîne.
 *
 * Le pendant de `installerCleParKek` (#21) pour la porte de #23. C'est ce qui permet au scénario de
 * bout en bout de BOOTER RAILS sur un volume restauré, ouvert par le seul code de récupération —
 * la phrase de la tranche, exécutée jusqu'au bout.
 */
export async function installerCleParCode({ volume, code, versionMinimale = null }) {
  const identifiantVolume = await identifiantDeclare(volume);
  const support = supportEnveloppeOpfs(volume);
  const derive = await kekDuCode({ support, identifiantVolume, code });
  const ouverte = await ouvrirEnveloppe({
    support,
    identifiantVolume,
    kek: derive.kek,
    versionMinimale,
  });
  return { relacher: poserCleDeveloppee(ouverte.dek), version: ouverte.version };
}

/**
 * CONSTRUIT l'enveloppe de récupération qu'un export emportera, ou rend `null`.
 *
 * Elle vit ICI et non dans les phases d'archive, pour la raison qui fait toute la décision 2 de
 * l'ADR 0027 : sa construction exige la CLÉ DE VOLUME, donc une enveloppe ouverte. Les phases
 * d'archive reçoivent des octets et une empreinte, et n'en savent rien de plus.
 */
export async function enveloppeDeRecuperationPourExport({ volume, jetonCle }) {
  const identifiantVolume = await identifiantDeclare(volume);
  return construireEnveloppeDeRecuperation({
    support: supportEnveloppeOpfs(volume),
    identifiantVolume,
    kek: kekDuHarnais(jetonCle),
  });
}

/**
 * SONDE DE NON-PERSISTANCE : le code de récupération ne se dépose nulle part sur l'origine.
 *
 * Ce que la sonde couvre, exactement : le fichier d'enveloppes `<volume>.cles` (seize kilo-octets),
 * le manifeste voisin, et les deux premiers mébioctets du volume. Ce que ce ne sont PAS des
 * cachettes crédibles — la mémoire du Worker, un `IndexedDB` d'une extension, le presse-papier de
 * l'utilisateur — n'est pas couvert, et l'écrire vaut mieux que de laisser croire à une preuve
 * d'absence universelle. Ce qu'elle établit est ce qui compte : le chemin d'ouverture par le code
 * n'écrit le code dans aucun des fichiers que le produit possède.
 *
 * Les TROIS formes sont cherchées : celle que le produit rend, la même sans tirets, et la même en
 * minuscules. Un code déposé sous une forme normalisée resterait un code déposé.
 */
export async function phaseSondeDuCode({ volume, code, fenetreOctets = 2 * 1024 * 1024 }) {
  const formes = [code, code.replaceAll("-", ""), code.toLowerCase()];
  const aiguilles = formes.map((forme) => new TextEncoder().encode(forme));
  const fichiers = [
    { nom: enveloppeSidecarName(volume), plafond: Number.POSITIVE_INFINITY },
    { nom: manifestSidecarName(volume), plafond: Number.POSITIVE_INFINITY },
    { nom: volume, plafond: fenetreOctets },
  ];

  const trouves = [];
  const examines = [];
  for (const { nom, plafond } of fichiers) {
    const observe = await statOpfsVolume(nom);
    if (!observe.present || observe.size === 0) {
      examines.push({ fichier: nom, octets: 0, present: false });
      continue;
    }
    const lus = Math.min(observe.size, plafond);
    const handle = await openOpfsSyncAccess(nom);
    let octets;
    try {
      octets = new Uint8Array(lus);
      handle.read(octets, { at: 0 });
    } finally {
      handle.close();
    }
    examines.push({ fichier: nom, octets: lus, present: true });
    if (aiguilles.some((aiguille) => contient(octets, aiguille))) trouves.push(nom);
  }
  return { phase: "sonde-du-code", volume, examines, trouves, formes: formes.length };
}

/** Recherche naïve d'une suite d'octets. Le volume sondé se compte en mébioctets, pas en gibioctets. */
function contient(foin, aiguille) {
  if (aiguille.byteLength === 0 || aiguille.byteLength > foin.byteLength) return false;
  for (let debut = 0; debut + aiguille.byteLength <= foin.byteLength; debut += 1) {
    let egal = true;
    for (let rang = 0; rang < aiguille.byteLength; rang += 1) {
      if (foin[debut + rang] !== aiguille[rang]) {
        egal = false;
        break;
      }
    }
    if (egal) return true;
  }
  return false;
}
