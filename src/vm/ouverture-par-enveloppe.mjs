// DÉVERROUILLAGE d'un volume par une clé de déverrouillage (#21, ADR 0020).
//
// C'est une COUCHE AU-DESSUS de l'ouvreur unique (ADR 0009/0014), et pas une modification de
// celui-ci. Le partage des rôles tient en deux phrases :
//
//  - `opfs-volume-open.mjs` ouvre un volume IDENTIFIÉ, et exige une clé de volume en mémoire ;
//  - ce module OBTIENT cette clé en ouvrant l'enveloppe, puis appelle l'ouvreur inchangé.
//
// Aucune ligne de `opfs-volume-ouverture.mjs` ni de `opfs-volume-open.mjs` n'est modifiée par #21.
// C'est délibéré et vérifiable : la tranche #19 travaille en parallèle sur la génération et
// l'ouverture, et une tranche de clés qui déplacerait leurs gestes rendrait les deux irrelisables.
//
// ## D'où vient l'identifiant de volume ATTENDU
//
// Du MANIFESTE, jamais du fichier d'enveloppes ni de l'en-tête v3. C'est la règle de l'ADR 0016, et
// la respecter est ce qui donne un sens au refus `VAULT_ENVELOPPE_IDENTITE` : si l'identifiant
// attendu venait de l'enveloppe elle-même, la confronter à elle-même ne prouverait rien. Le
// manifeste est la source, l'en-tête v3 en est une COPIE que l'ouvreur confronte déjà, et
// l'enveloppe en porte une troisième que ce module confronte ici.
//
// ## La clé de volume ne survit pas à l'ouverture
//
// La DEK développée est un tampon d'octets, et elle n'est nécessaire que le temps d'un appel :
// l'ouvreur l'importe dans WebCrypto (NON EXTRACTIBLE) et n'en garde pas les octets. Ce module
// EFFACE donc le tampon dès que l'ouverture est rendue. Ce n'est pas une garantie — un moteur peut
// avoir copié le tampon —, c'est une réduction de la fenêtre, et elle est gratuite. Ce qui est
// garanti, lui, est ailleurs : aucune fonction de ce module ne RETOURNE la clé de volume à son
// appelant, et aucune ne la journalise.

import { catalogueDeDerivateurs } from "./derivation/derivateurs.mjs";
import { ouvrirEnveloppe, creerEnveloppe, inventorierEnveloppe } from "./enveloppe-de-cle.mjs";
import { emplacementInconnu } from "./enveloppe/enveloppe-errors.mjs";
import { TAILLE_FICHIER_ENVELOPPE } from "./enveloppe/fichier-enveloppe.mjs";
import { tirerCleDeVolume } from "./enveloppe/identite-enveloppe.mjs";
import { MANIFEST_ERROR_CODES, ManifestError } from "./manifest-errors.mjs";
import { openVolumeForWrite, readVolumeManifest } from "./opfs-volume-open.mjs";
import { openOpfsSyncAccess, statOpfsVolume } from "./opfs-sync-access.mjs";
import { enveloppeSidecarName } from "./opfs-sync-access.mjs";
import { parseManifest } from "./volume-manifest.mjs";

/**
 * SUPPORT d'enveloppe adossé à OPFS.
 *
 * Chaque geste ouvre et referme le handle exclusif. C'est délibéré : l'enveloppe est un fichier de
 * seize kilo-octets touché quelques fois dans la vie d'un volume, et garder un handle ouvert
 * dessus le rendrait indisponible à un autre onglet pour rien. Le handle du VOLUME, lui, reste
 * tenu — ce sont deux fichiers, deux durées de vie.
 *
 * @param {string} volume nom du volume ; le voisin est `<volume>.cles`
 * @param {{ openHandle?: Function, stat?: Function }} [primitives]
 */
export function supportEnveloppeOpfs(
  volume,
  { openHandle = openOpfsSyncAccess, stat = statOpfsVolume } = {},
) {
  const nom = enveloppeSidecarName(volume);
  const avecHandle = async (geste) => {
    const handle = await openHandle(nom);
    try {
      return geste(handle);
    } finally {
      handle.close();
    }
  };
  return Object.freeze({
    nom,
    etat: async () => {
      const observe = await stat(nom);
      return { present: observe.present, taille: observe.size };
    },
    lire: (offset, longueur) =>
      avecHandle((handle) => {
        const octets = new Uint8Array(longueur);
        const lus = handle.read(octets, { at: offset });
        if (lus !== longueur) {
          throw new RangeError(
            `Enveloppe « ${nom} » : ${lus} octet(s) lus sur ${longueur} demandés à l'offset ${offset}.`,
          );
        }
        return octets;
      }),
    allouer: (taille) =>
      avecHandle((handle) => {
        handle.truncate(taille);
        handle.flush();
      }),
    ecrire: (offset, octets) =>
      avecHandle((handle) => {
        const ecrits = handle.write(octets, { at: offset });
        if (ecrits !== octets.byteLength) {
          throw new RangeError(
            `Enveloppe « ${nom} » : ${ecrits} octet(s) écrits sur ${octets.byteLength} à l'offset ${offset}.`,
          );
        }
      }),
    barriere: () => avecHandle((handle) => handle.flush()),
  });
}

/**
 * Identifiant de volume DÉCLARÉ par le manifeste voisin, ou refus typé.
 *
 * Le refus est celui du manifeste (`VAULT_MANIFEST_UNIDENTIFIED`), pas celui de l'enveloppe : un
 * volume sans manifeste n'est pas un volume dont l'enveloppe manque, et lui répondre « aucune
 * enveloppe » enverrait créer une clé pour un volume que le produit refuse d'écrire de toute façon.
 */
async function identifiantDeclare(volume, primitives) {
  const octets = await readVolumeManifest(volume, primitives);
  if (octets === null) {
    throw new ManifestError(
      MANIFEST_ERROR_CODES.unidentified,
      `Volume « ${volume} » refusé : aucun manifeste voisin ne l'identifie, donc rien ne dit quelle enveloppe lui appartient. Aucune clé n'est essayée.`,
      { volume },
    );
  }
  const manifeste = parseManifest(octets);
  const identifiant = manifeste.volume?.id;
  if (typeof identifiant !== "string") {
    throw new ManifestError(
      MANIFEST_ERROR_CODES.malformed,
      `Manifeste du volume « ${volume} » sans identifiant de volume : un format v3 en déclare toujours un (ADR 0016). Aucune clé n'est essayée.`,
      { volume },
    );
  }
  return identifiant;
}

/** Efface un tampon de clé. Ce n'est pas une garantie, c'est une fenêtre refermée. */
function effacer(octets) {
  if (octets instanceof Uint8Array) octets.fill(0);
}

/**
 * OUVRE un volume par une clé de déverrouillage.
 *
 * Ordre des gestes, et il est le sujet : le manifeste est lu et son identifiant retenu, l'enveloppe
 * est ouverte et VÉRIFIÉE sous cet identifiant, et seulement alors l'ouvreur unique reçoit la clé de
 * volume. Un volume dont l'enveloppe manque est refusé par `VAULT_ENVELOPPE_ABSENTE` — un code
 * DISTINCT de `VAULT_ENVELOPPE_CLE_REFUSEE`, parce que les deux remèdes n'ont rien de commun.
 *
 * @param {{ name: string, kek: Uint8Array, size?: number, expectations?: object,
 *           versionMinimale?: number | null, support?: object, openVolume?: Function,
 *           stat?: Function, readFile?: Function }} appel
 * @returns {Promise<import("./opfs-block-backend.mjs").OpfsBlockBackend>}
 */
export async function ouvrirVolumeParKek({
  name,
  kek,
  size,
  expectations = {},
  versionMinimale = null,
  support,
  openVolume,
  ...primitives
}) {
  const identifiantVolume = await identifiantDeclare(name, primitives);
  const ouverte = await ouvrirEnveloppe({
    support: support ?? supportEnveloppeOpfs(name),
    identifiantVolume,
    kek,
    versionMinimale,
  });
  try {
    return await openVolumeForWrite({
      name,
      size,
      cle: ouverte.dek,
      expectations,
      ...primitives,
      ...(openVolume === undefined ? {} : { openVolume }),
    });
  } finally {
    effacer(ouverte.dek);
  }
}

/**
 * Choisit l'emplacement à ouvrir dans l'inventaire PUBLIC, et le dérivateur qui le sert.
 *
 * L'inventaire ne demande aucune clé — c'est tout l'intérêt du point 3 des limites de l'ADR 0020 :
 * le fichier porte en clair le type et les paramètres de chaque emplacement, précisément pour qu'un
 * dérivateur puisse lire les siens AVANT de dériver quoi que ce soit.
 *
 * Un type que le catalogue ne sert pas est refusé par `VAULT_DERIVATION_TYPE_INCONNU`, et rien
 * n'est écrit : ce chemin ne fait que lire.
 */
async function emplacementADeriver({ support, identifiantVolume, catalogue, identifiant }) {
  const inventaire = await inventorierEnveloppe({ support, identifiantVolume });
  const vises =
    identifiant === undefined
      ? inventaire.emplacements
      : inventaire.emplacements.filter(
          (candidat) => candidat.identifiantEmplacement === identifiant,
        );
  if (vises.length === 0) {
    throw emplacementInconnu({ volume: identifiantVolume, identifiantEmplacement: identifiant });
  }
  // Le PREMIER emplacement que le catalogue sait servir. Un emplacement d'un type inconnu ne fait
  // pas échouer une enveloppe qui en porte un autre, servable : c'est la compatibilité que le
  // point 5 du contrat demande. Le refus ne tombe que si AUCUN n'est servable.
  let dernierRefus = null;
  for (const emplacement of vises) {
    try {
      return { emplacement, derivateur: catalogue.pour(emplacement.typeKek) };
    } catch (cause) {
      dernierRefus = cause;
    }
  }
  throw dernierRefus;
}

/**
 * OUVRE un volume par un DÉRIVATEUR, plutôt que par une KEK déjà en main (#22, ADR 0021).
 *
 * L'ordre est celui de #21, avec un geste de plus au milieu : le manifeste est lu et son
 * identifiant retenu, l'INVENTAIRE public de l'enveloppe est lu, le dérivateur qui sert le type de
 * l'emplacement dérive la KEK sous l'identité de CET emplacement, et seulement alors l'enveloppe
 * est ouverte et l'ouvreur unique reçoit la clé de volume.
 *
 * Un geste faux ne rend jamais un refus du dérivateur : il rend une AUTRE clé, et c'est
 * `VAULT_ENVELOPPE_CLE_REFUSEE` qui tombe. Un dérivateur ne sait pas qu'une phrase est fausse.
 *
 * @param {{ name: string, derivateur?: object, catalogue?: object, geste?: object,
 *           identifiantEmplacement?: string, size?: number, expectations?: object,
 *           versionMinimale?: number | null, support?: object, openVolume?: Function }} appel
 */
export async function ouvrirVolumeParDerivateur({
  name,
  derivateur,
  catalogue,
  geste = {},
  identifiantEmplacement,
  size,
  expectations = {},
  versionMinimale = null,
  support,
  openVolume,
  ...primitives
}) {
  const identifiantVolume = await identifiantDeclare(name, primitives);
  const supportEmploye = support ?? supportEnveloppeOpfs(name);
  const choisi = await emplacementADeriver({
    support: supportEmploye,
    identifiantVolume,
    catalogue: catalogue ?? catalogueDeDerivateurs({ [derivateur.type]: derivateur }),
    identifiant: identifiantEmplacement,
  });
  const kek = await choisi.derivateur.deriver({
    parametres: choisi.emplacement.parametres,
    identite: {
      identifiantVolume,
      identifiantEmplacement: choisi.emplacement.identifiantEmplacement,
    },
    geste,
  });
  return ouvrirVolumeParKek({
    name,
    kek,
    size,
    expectations,
    versionMinimale,
    support: supportEmploye,
    ...primitives,
    ...(openVolume === undefined ? {} : { openVolume }),
  });
}

/**
 * PRÉPARE un volume neuf : tire sa clé de volume, l'enveloppe sous `kek`, et rend l'identifiant et
 * la clé pour que l'appelant crée le volume.
 *
 * L'ordre est une décision, pas une commodité : l'enveloppe est écrite et sa barrière franchie AVANT
 * que le volume n'existe. Une coupure laisse alors au pire une enveloppe orpheline — un fichier de
 * seize kilo-octets qui ne protège rien —, jamais un volume qu'aucune clé n'ouvre. L'ordre inverse
 * aurait produit exactement le sinistre que #21 doit empêcher.
 *
 * La clé rendue est celle que l'appelant doit passer à l'ouvreur, puis EFFACER : ce module ne peut
 * pas l'effacer pour lui, puisqu'il ne tient pas l'ouverture.
 *
 * @param {{ name: string, identifiantVolume: string, kek: Uint8Array, typeKek?: number,
 *           parametres?: Uint8Array, support?: object }} appel
 * @returns {Promise<{ identifiantVolume: string, dek: Uint8Array, identifiantEmplacement: string }>}
 */
export async function preparerEnveloppeDeVolume({
  name,
  identifiantVolume,
  kek,
  typeKek,
  parametres,
  identifiantEmplacement,
  support,
}) {
  const dek = tirerCleDeVolume();
  const creee = await creerEnveloppe({
    support: support ?? supportEnveloppeOpfs(name),
    identifiantVolume,
    dek,
    kek,
    ...(typeKek === undefined ? {} : { typeKek }),
    ...(parametres === undefined ? {} : { parametres }),
    ...(identifiantEmplacement === undefined ? {} : { identifiantEmplacement }),
  });
  return Object.freeze({
    identifiantVolume,
    dek,
    identifiantEmplacement: creee.identifiantEmplacement,
  });
}

export { TAILLE_FICHIER_ENVELOPPE };
