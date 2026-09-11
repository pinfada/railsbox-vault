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
//
// ## L'export d'un volume **v3**, et la boucle qu'il ouvre (#182, T2b, second amendement de la DoR)
//
// Un pas de migration destructif exige une sauvegarde VÉRIFIÉE — `assertPreuveDisponible` refuse
// qu'un consentement nommé en tienne lieu (ADR 0011). Or ce chemin ouvrait TOUT volume de format au
// moins v3 par `openOpfsVolume`, qui refuse un en-tête v3 en renvoyant à la migration. Les deux
// règles se refermaient l'une sur l'autre : **un v3 n'était migrable qu'à condition de détenir déjà
// une archive faite par le runtime précédent.** La PR #186 a mesuré l'écart par une épreuve ; c'est
// ici qu'il se comble.
//
// Le v3 est ouvert par le SEUL lecteur de v3 que ce runtime possède —
// `migration-source-chiffree.mjs`, c'est-à-dire le VRAI magasin de générations monté sur l'accès
// brut. Rien n'est réécrit de ce lecteur, et c'est le point : un second chemin de lecture v3 serait
// un second endroit où les trois cas de #181 pourraient diverger.
//
//  - la **génération validée** que le journal porte encore est appliquée au volume avant la copie,
//    sans quoi l'archive perdrait une écriture acquittée — le défaut même que ce fichier existe pour
//    empêcher ;
//  - les **trois cas de l'ouverture de #181** s'appliquent AVANT tout clair : racine → ouverture
//    normale ; pas de racine mais un engagement d'archive → vérifié sous la clé, empreinte du
//    fichier entier ; ni l'un ni l'autre → `VAULT_STORAGE_VOLUME_SANS_RACINE` ;
//  - **aucun chemin d'ÉCRITURE v3 n'est ouvert à l'appelant** : l'export rend un accès BRUT en
//    lecture, et ne scelle rien sous une clé v3 de son propre chef.
//
// **L'écart qui reste, écrit plutôt que découvert.** Ouvrir un volume v3 n'est pas gratuit : le
// magasin clôt sa récupération en écrivant une racine v3 (`#vider`), et rejouer une charge rescelle
// des secteurs — deux scellements sous la clé v3, c'est-à-dire sous la DEK elle-même. Ils sont le
// prix de l'application de la charge acquittée, ils passent par l'unique exception du cliquet
// anti-DEK (`src/vm/scellement.mjs`, régime `#sousLaCleMaitresse`), et ils sont EXACTEMENT ceux que
// la migration produit déjà sur le même fichier. L'alternative — ne pas ouvrir — perd une écriture
// acquittée ; l'autre — un lecteur v3 dédié qui n'écrirait rien — ne saurait pas appliquer la
// charge, donc rendrait la même perte sous un autre nom. Le second amendement de la DoR demandait
// « aucun scellement sous une clé v3 hors l'engagement d'archive » : ce chemin n'y parvient pas, et
// le dire vaut mieux que de le laisser trouver (§ 7.4 de la spécification, `SECURITY.md`, ADR 0036).

import { BlockJournal } from "./block-journal.mjs";
import { openOpfsVolume } from "./opfs-block-backend.mjs";
import { ouvrirVolumeBrut } from "./opfs-volume-brut.mjs";
import { solderLaSourceChiffreeSurAccesBrut } from "./migration-source-chiffree.mjs";
import { Scellement } from "./scellement.mjs";
import { MIN_VOLUME_FORMAT_VERSION } from "./volume-manifest.mjs";
import {
  EN_TETE_OCTETS,
  FORMAT_VOLUME_V3,
  FORMAT_VOLUME_V4,
  decoderEnTeteV3,
  decoderEnTeteV4,
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
  // Le défaut est le format COURANT, et il l'est depuis que la version 3 a son propre chemin : un
  // appelant qui n'annonce rien exporte un volume de ce runtime, pas un volume à migrer.
  formatVersion = FORMAT_VOLUME_V4,
  openHandle,
  recuperer = openOpfsVolume,
  ouvrirBrut = ouvrirVolumeBrut,
  solder = solderLaSourceChiffreeSurAccesBrut,
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

  // Un v3, lui, PORTE une génération validée que le fichier n'a pas encore : il se solde par le
  // lecteur de la migration, et par lui seul. Voir l'en-tête de ce fichier.
  if (formatVersion === FORMAT_VOLUME_V3) {
    return ouvrirUnV3PourExport({ name, cle, openHandle, ouvrirBrut, solder });
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

/**
 * OUVRE un volume **v3** pour l'exporter : le SOLDE par le lecteur de la migration, puis rend
 * l'accès brut qui a servi à le solder (#182, T2b).
 *
 * ## Le bail n'est PAS rompu ici, contrairement au chemin v4
 *
 * Le chemin v4 ouvre transactionnellement, referme, puis REPREND un handle brut — d'où le contrôle
 * `constaterQueRienNAChange`, qui rend visible ce que l'intervalle laisse passer. Ici il n'y a pas
 * d'intervalle : le magasin de générations est monté SUR l'accès brut déjà tenu, et cet accès reste
 * le même avant et après le solde. Il n'y a donc rien à re-constater, et un contrôle qui comparerait
 * un état à lui-même serait un décor.
 *
 * ## Ce qui est refermé, et ce qui ne l'est pas
 *
 * `solderLaSourceChiffreeSurAccesBrut` referme le magasin — donc les voisins `.gen` et `.temoin` —
 * dans son `finally`. L'accès BRUT au fichier de volume, lui, reste ouvert : c'est celui que
 * l'appelant va lire pour composer l'archive, et le rendre ici l'obligerait à le reprendre, c'est-à-
 * dire à rouvrir l'intervalle que le chemin v4 doit justement surveiller.
 *
 * **Un refus rend le handle.** Un engagement absent, une racine illisible, une région qui ne
 * concorde plus : chacun laisse le volume intact, et aucun ne doit laisser le nom occupé par un
 * accès que personne ne détient.
 */
async function ouvrirUnV3PourExport({ name, cle, openHandle, ouvrirBrut, solder }) {
  const brut = await ouvrirBrut({ name, openHandle });
  try {
    const lu = decoderEnTeteV3(await brut.read(0, EN_TETE_OCTETS));
    if (!lu.valide) {
      throw new StorageError(
        STORAGE_ERROR_CODES.identiteVolume,
        `Export refusé : « ${name} » est annoncé en version 3 et son en-tête n'en porte pas la marque (${lu.raison}). Aucun octet n'est lu au-delà.`,
        { volume: name, raison: lu.raison },
      );
    }
    const identifiantVolume = identifiantVolumeEnTexte(lu.enTete.identifiantVolume);
    const rapport = await solder({
      name,
      brut,
      tailleLogique: lu.enTete.tailleLogique,
      identifiantVolume,
      cle,
      openHandle,
      // Le scellement est celui d'un volume v3 : UN seul compteur, et la clé est la DEK elle-même
      // (`#sousLaCleMaitresse`). C'est l'unique régime qui sache lire ces octets, et il n'est
      // atteignable que par ce chemin et par la migration.
      scellement: await Scellement.ouvrir({
        volume: identifiantVolume,
        cleOctets: cle,
        formatVersion: FORMAT_VOLUME_V3,
      }),
    });
    return { brut, rapport };
  } catch (cause) {
    await brut.close?.();
    throw cause;
  }
}

/**
 * Identifiant que porte l'en-tête du fichier, relu par l'accès brut du backend ouvert.
 *
 * L'en-tête v4, et lui seul : l'export passe par `openOpfsVolume`, qui refuse déjà tout ce qui n'est
 * pas un volume v4 (ADR 0033, décision 5). Un volume v3 s'exporte après sa migration, jamais avant.
 */
async function identifiantDeLEnTete(backend) {
  const lu = decoderEnTeteV4(await backend.lireSupportBrut(0, EN_TETE_OCTETS));
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
  const lu = decoderEnTeteV4(await brut.read(0, EN_TETE_OCTETS));
  const porte = lu.valide ? identifiantVolumeEnTexte(lu.enTete.identifiantVolume) : null;
  if (porte === identifiant) return;
  throw refus(`son en-tête portait l'identifiant ${identifiant} et porte maintenant ${porte}.`, {
    volume: brut.name,
    attendu: identifiant,
    porte,
  });
}
