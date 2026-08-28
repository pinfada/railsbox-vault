// Phases d'ENVELOPPE DE CLÉ du banc de référence (#21, ADR 0020).
//
// Elles permettent au scénario de bout en bout de faire ce qu'aucun autre niveau ne peut faire :
// booter une vraie application Rails sur un volume ouvert PAR UNE CLÉ DE DÉVERROUILLAGE, fermer
// entièrement le navigateur, remplacer la clé, et rouvrir par la neuve pendant que l'ancienne est
// refusée.
//
// Le partage des rôles avec les phases de volume est net : celles-ci CRÉENT et BOOTENT ; celles-là
// gèrent l'enveloppe. La jonction se fait par `poserCleDeveloppee`, qui installe pour la durée d'une
// phase la clé développée — et l'efface à la sortie.
//
// Aucune phase ne se déclare « réussie » d'elle-même : elle rend ce qu'elle a observé, et
// l'assertion vit dans `tests/e2e/enveloppe-rotation-boot-froid.spec.mjs`.

import { clesDeDeverrouillageDuHarnais } from "/src/vm/cle-de-volume.mjs";
import { ENVELOPPE_ERROR_CODES, isEnveloppeError } from "/src/vm/enveloppe/enveloppe-errors.mjs";
import {
  creerEnveloppe,
  inventorierEnveloppe,
  ouvrirEnveloppe,
  remplacerEmplacement,
} from "/src/vm/enveloppe-de-cle.mjs";
import { enveloppeSidecarName, removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import { supportEnveloppeOpfs } from "/src/vm/ouverture-par-enveloppe.mjs";
import { readVolumeManifest } from "/src/vm/opfs-volume-open.mjs";
import { parseManifest } from "/src/vm/volume-manifest.mjs";
import { cleDuBanc, poserCleDeveloppee } from "./cle-du-banc.mjs";

/**
 * Les deux clés de déverrouillage de TEST, nommées.
 *
 * Elles viennent de `src/vm/cle-de-volume.mjs`, sous le MÊME jeton que la clé de volume : c'est le
 * seul module que `tests/unit/harnais-portes.test.mjs` surveille, et y garder tout le matériel de
 * clé en dur vaut mieux que d'en semer dans les bancs.
 */
function kekNommee(nom, jeton) {
  const cles = clesDeDeverrouillageDuHarnais({ jeton });
  if (nom === "initiale") return cles.initiale;
  if (nom === "rotation") return cles.rotation;
  throw new Error(`Clé de déverrouillage inconnue du banc : ${nom}`);
}

/** Identifiant de volume DÉCLARÉ par le manifeste voisin. Jamais celui de l'enveloppe (ADR 0016). */
async function identifiantDeclare(volume) {
  const octets = await readVolumeManifest(volume);
  if (octets === null)
    throw new Error(`Volume « ${volume} » sans manifeste : rien ne l'identifie.`);
  return parseManifest(octets).volume?.id;
}

/**
 * CRÉE l'enveloppe d'un volume déjà préparé, autour de la clé sous laquelle il a été scellé.
 *
 * L'ordre du produit — enveloppe d'abord, volume ensuite — n'est pas celui du BANC, et il faut le
 * dire : le banc prépare son volume à partir de l'image de référence sous la clé du harnais, puis
 * enveloppe cette même clé. Ce que le scénario mesure ensuite est le DÉVERROUILLAGE et la ROTATION,
 * pas l'ordre de création, qui est éprouvé au niveau unitaire.
 */
export async function phaseEnveloppeCreer({ volume, jetonCle }) {
  const identifiantVolume = await identifiantDeclare(volume);
  const creee = await creerEnveloppe({
    support: supportEnveloppeOpfs(volume),
    identifiantVolume,
    dek: cleDuBanc(),
    kek: kekNommee("initiale", jetonCle),
  });
  return {
    phase: "enveloppe-creer",
    volume,
    enveloppe: enveloppeSidecarName(volume),
    identifiantEmplacement: creee.identifiantEmplacement,
    version: creee.version,
  };
}

/** REMPLACE la clé d'un emplacement. Après ce geste, l'ancienne n'ouvre plus rien. */
export async function phaseEnveloppeRemplacer({ volume, emplacement, jetonCle }) {
  const identifiantVolume = await identifiantDeclare(volume);
  const remplacement = await remplacerEmplacement({
    support: supportEnveloppeOpfs(volume),
    identifiantVolume,
    kek: kekNommee("initiale", jetonCle),
    identifiantEmplacement: emplacement,
    kekNouvelle: kekNommee("rotation", jetonCle),
  });
  return { phase: "enveloppe-remplacer", volume, ...remplacement };
}

/**
 * OUVRE l'enveloppe sous une clé nommée et rend ce qu'elle a rendu — sans la clé.
 *
 * C'est la phase qui répond à « l'ancienne clé est-elle refusée ? ». Elle rend un CODE, jamais un
 * octet de clé : le port ne transporte que des données JSON (ADR 0002).
 */
export async function phaseEnveloppeOuvrir({ volume, kek = "initiale", jetonCle }) {
  const identifiantVolume = await identifiantDeclare(volume);
  try {
    const ouverte = await ouvrirEnveloppe({
      support: supportEnveloppeOpfs(volume),
      identifiantVolume,
      kek: kekNommee(kek, jetonCle),
    });
    const inventaire = await inventorierEnveloppe({
      support: supportEnveloppeOpfs(volume),
      identifiantVolume,
    });
    // La clé développée est effacée ici même : cette phase ne boote rien, et rien n'en a besoin.
    poserCleDeveloppee(ouverte.dek)();
    return {
      phase: "enveloppe-ouvrir",
      volume,
      kek,
      ouverte: true,
      code: null,
      version: ouverte.version,
      identifiantEmplacement: ouverte.identifiantEmplacement,
      emplacements: inventaire.emplacements.length,
    };
  } catch (erreur) {
    return {
      phase: "enveloppe-ouvrir",
      volume,
      kek,
      ouverte: false,
      code: isEnveloppeError(erreur) ? erreur.code : (erreur.code ?? null),
      refusDeCle: isEnveloppeError(erreur, ENVELOPPE_ERROR_CODES.cleRefusee),
    };
  }
}

/**
 * INSTALLE la clé développée d'une enveloppe pour la durée de la phase que l'appelant enchaîne.
 *
 * C'est la jonction entre l'enveloppe et le boot : l'aiguillage du Worker l'appelle AVANT la phase
 * quand `kek` est nommée, et relâche APRÈS. Elle rend la fonction de relâchement, jamais la clé.
 *
 * @returns {Promise<{ relacher: () => void, version: number }>}
 */
export async function installerCleParKek({ volume, kek, jetonCle }) {
  const identifiantVolume = await identifiantDeclare(volume);
  const ouverte = await ouvrirEnveloppe({
    support: supportEnveloppeOpfs(volume),
    identifiantVolume,
    kek: kekNommee(kek, jetonCle),
  });
  return { relacher: poserCleDeveloppee(ouverte.dek), version: ouverte.version };
}

/** Retire le fichier d'enveloppes SEUL, pour éprouver le refus « aucune enveloppe » sur un vrai volume. */
export async function phaseEnveloppeRetirer({ volume }) {
  const retire = await removeOpfsVolume(enveloppeSidecarName(volume));
  return { phase: "enveloppe-retirer", volume, retire };
}
