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

/**
 * Amène un volume à son DERNIER ÉTAT VALIDÉ, puis rend un accès BRUT à son fichier.
 *
 * Les deux gestes sont indissociables et c'est pourquoi ils vivent dans la même fonction : les
 * séparer est exactement ce qui a produit le défaut décrit en tête de ce fichier. L'ouverture
 * transactionnelle est refermée avant l'ouverture brute — le registre d'exclusivité de #6 refuserait
 * les deux à la fois, et il a raison de le refuser.
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
  try {
    rapport = backend.generation?.rapport ?? null;
  } finally {
    await backend.close();
  }
  return { brut: await ouvrirBrut({ name, openHandle }), rapport };
}
