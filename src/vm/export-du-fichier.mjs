// OUVRIR un volume POUR L'EXPORTER : récupérer d'abord, copier ensuite (#101, ADR 0008, ADR 0014).
//
// Un export copie le FICHIER du volume. Cela suffisait tant que le fichier portait tout l'état ;
// depuis #16 il ne le porte plus entièrement. Une génération **validée** vit dans le journal voisin
// `<volume>.gen` jusqu'à ce qu'une ouverture transactionnelle la REJOUE dans le volume. Entre les
// deux, le guest a reçu son acquittement et le fichier ne porte pas encore l'écriture.
//
// **Copier le fichier tel quel dans cet intervalle produit une archive à laquelle il manque une
// écriture acquittée** — et rien ne le signale : l'archive est cohérente, son empreinte vérifie, sa
// restauration réussit, et l'écriture a disparu. C'est la définition même d'une perte silencieuse,
// et `SEC-DURABLE-001` l'interdit.
//
// Le défaut a été trouvé PAR EXÉCUTION, par `tests/e2e/restauration-inter-origine.spec.mjs` : le
// fichier restauré sur l'origine B était byte-exact avec celui de A, et leurs CLAIRS différaient.
// Il n'existait pas avant #101 : le chemin d'export d'alors ouvrait le volume par `openOpfsVolume`,
// donc récupérait sans le vouloir. Le passage à l'accès brut — nécessaire pour ne pas exporter en
// clair un volume chiffré — a retiré cette récupération avec le reste.
//
// **Conséquence sur la clé, et il faut la dire.** Rejouer une génération validée exige de DÉCHIFFRER
// ses enregistrements et de RESCELLER les secteurs : l'export d'un volume v3 demande donc la clé,
// même si l'archive qu'il produit n'en porte pas et même si la restauration, elle, n'en demande
// aucune. Exporter sans clé serait possible — il suffirait de copier le fichier — mais reviendrait
// à choisir de perdre en silence ce qui a été acquitté.

import { BlockJournal } from "./block-journal.mjs";
import { openOpfsVolume } from "./opfs-block-backend.mjs";
import { ouvrirVolumeBrut } from "./opfs-volume-brut.mjs";
import { MIN_VOLUME_FORMAT_VERSION } from "./volume-manifest.mjs";
import {
  EN_TETE_OCTETS,
  decoderEnTeteV3,
  identifiantVolumeEnTexte,
  tailleDeFichier,
} from "./volume-chiffre-format.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";

/**
 * Amène un volume à son DERNIER ÉTAT VALIDÉ, puis rend un accès BRUT à son fichier.
 *
 * Les deux gestes sont indissociables et c'est pourquoi ils vivent dans la même fonction : les
 * séparer est exactement ce qui a produit le défaut décrit en tête de ce fichier. L'ouverture
 * transactionnelle est refermée avant l'ouverture brute — le registre d'exclusivité de #6 refuserait
 * les deux à la fois, et il a raison de le refuser.
 *
 * ## Le BAIL est rompu entre les deux, et il faut le dire
 *
 * `close()` rend le handle exclusif ; `ouvrirVolumeBrut` en reprend un. Entre les deux, le fichier
 * n'est tenu par personne, et un autre contexte de la même origine pourrait s'en saisir. L'archive
 * déclare pourtant `handle-exclusif`, c'est-à-dire « aucun autre contexte n'écrit dans l'origine ».
 * La revue de #110 a relevé la contradiction : soit on tient le bail, soit on déclare moins.
 *
 * **On ne peut pas tenir le bail** : `createSyncAccessHandle` est exclusif par fichier et le rendre
 * est la seule façon d'en laisser prendre un autre ; il n'existe pas de passation. Ce qui reste est
 * donc de RE-CONSTATER, après la reprise du bail, que le fichier est bien celui qu'on vient de
 * récupérer — sa TAILLE et l'identifiant de son en-tête. Ce contrôle n'est pas une preuve
 * d'exclusivité et ne prétend pas l'être : il attrape le remplacement et le retaillage, pas une
 * écriture au milieu du fichier. La topologie de l'ADR 0002 — un seul Worker de confiance par
 * origine — est ce qui rend l'intervalle inoffensif en pratique ; ce contrôle est ce qui rend son
 * franchissement VISIBLE plutôt que silencieux.
 *
 * @param {{ name: string, cle: Uint8Array,
 *           openHandle?: (name: string) => Promise<FileSystemSyncAccessHandle>,
 *           recuperer?: typeof openOpfsVolume, ouvrirBrut?: typeof ouvrirVolumeBrut }} options
 *   `recuperer` et `ouvrirBrut` sont les points d'injection des épreuves, qui vérifient l'ORDRE.
 * @returns {Promise<{ brut: object, rapport: object | null }>} `rapport` est celui de la
 *   récupération, publié tel quel : une génération écartée ou rejouée est une nouvelle, pas un
 *   détail d'implémentation.
 */
export async function ouvrirPourExport({
  name,
  cle,
  formatVersion = MIN_VOLUME_FORMAT_VERSION,
  openHandle,
  recuperer = openOpfsVolume,
  ouvrirBrut = ouvrirVolumeBrut,
}) {
  // Un volume d'un format ANTÉRIEUR n'a pas de récupération possible : son fichier ne s'ouvre pas
  // par l'ouvreur v3, faute d'en-tête. Ce n'est pas une exception de commodité, c'est le seul état
  // atteignable — un tel volume n'est pas inscriptible par ce runtime
  // (`VAULT_MANIFEST_MIGRATION_REQUIRED`), donc il ne peut pas porter une génération que ce runtime
  // aurait validée sans l'appliquer. Le sauvegarder avant migration copie donc le fichier tel quel,
  // ce qui est exactement ce qu'il est.
  if (formatVersion < MIN_VOLUME_FORMAT_VERSION) {
    return { brut: await ouvrirBrut({ name, openHandle }), rapport: null };
  }

  const backend = await recuperer({ name, cle, journal: new BlockJournal(), openHandle });
  // Le rapport est relevé AVANT la fermeture — une machine fermée n'en rend plus — et la fermeture
  // a lieu quoi qu'il arrive : un backend laissé ouvert garderait le nom occupé, et l'ouverture
  // brute qui suit échouerait sur `VAULT_STORAGE_BUSY` pour une raison qui n'est pas la sienne.
  let rapport;
  let taille;
  let identifiant;
  try {
    rapport = backend.generation?.rapport ?? null;
    // Relevés AVANT la fermeture, tant que le bail est encore tenu : c'est à cet état-là que le
    // fichier repris sera confronté.
    taille = tailleDeFichier({ formatVersion, tailleLogique: backend.size() });
    identifiant = await identifiantDeLEnTete(backend);
  } finally {
    await backend.close();
  }
  const brut = await ouvrirBrut({ name, openHandle });
  await constaterQueRienNAChange({ brut, taille, identifiant });
  return { brut, rapport };
}

/** Identifiant que porte l'en-tête v3 du fichier, relu par l'accès brut du backend ouvert. */
async function identifiantDeLEnTete(backend) {
  const lu = decoderEnTeteV3(await backend.lireSupportBrut(0, EN_TETE_OCTETS));
  return lu.valide ? identifiantVolumeEnTexte(lu.enTete.identifiantVolume) : null;
}

/**
 * CONSTATE que le fichier repris est celui qu'on vient de refermer. Voir l'en-tête de
 * `ouvrirPourExport` pour ce que ce contrôle attrape, et ce qu'il n'attrape pas.
 */
async function constaterQueRienNAChange({ brut, taille, identifiant }) {
  const refus = (detail, contexte) =>
    new StorageError(
      STORAGE_ERROR_CODES.identiteVolume,
      `Export refusé : ${detail} Le fichier a changé entre la récupération et la copie, et l'archive ne décrirait pas le volume qu'elle prétend porter.`,
      contexte,
    );

  if (brut.size() !== taille) {
    throw refus(`le volume faisait ${taille} octet(s) et en porte ${brut.size()}.`, {
      volume: brut.name,
      attendue: taille,
      observee: brut.size(),
    });
  }
  if (identifiant === null) return;
  const lu = decoderEnTeteV3(await brut.read(0, EN_TETE_OCTETS));
  const porte = lu.valide ? identifiantVolumeEnTexte(lu.enTete.identifiantVolume) : null;
  if (porte === identifiant) return;
  throw refus(`son en-tête portait l'identifiant ${identifiant} et porte maintenant ${porte}.`, {
    volume: brut.name,
    attendu: identifiant,
    porte,
  });
}
