// SOLDE le journal de génération du volume SOURCE d'une migration, quel que soit son format (#182).
//
// Une migration ne peut pas se contenter de recopier le fichier : depuis #16, une génération VALIDÉE
// vit dans le voisin `<volume>.gen` jusqu'à ce qu'une ouverture la reporte. Ce module tient les deux
// façons de la reprendre — celle d'une source en CLAIR, et celle d'une source CHIFFRÉE — parce que
// c'est la MÊME décision prise deux fois, et que les tenir loin l'une de l'autre est exactement ce
// qui a laissé la seconde appliquer le lecteur de la première.
//
// Ce module existe à cause de deux constats de la revue de la PR #186 — le CRITICAL de format n° 1
// et le HIGH de format n° 4 —, et il les referme par le MÊME geste, parce qu'ils avaient la même
// cause : la migration traitait le voisin `.gen` d'un volume chiffré comme un fichier à recopier,
// là où c'est un JOURNAL qu'il faut OUVRIR.
//
// ## Ce que le code faisait, et pourquoi aucun volume v3 réel ne passait
//
// `reporterLeJournalDeGeneration` appliquait `ecrituresARejouerV1` — le lecteur du journal de
// FORMAT 1, celui d'un volume v2 en clair, validé par un CRC-32 — au `.gen` de la source, quelle que
// soit sa version de format. Or le marqueur `VLTGEN01` est partagé par les formats 1 à 5 : un
// journal de format 4, celui qu'un volume v3 écrit, franchissait le contrôle de marqueur puis
// échouait au CRC — que le format 4 a justement remplacé par une étiquette GCM. La migration levait
// `VAULT_MIGRATION_JOURNAL_MALFORMED`.
//
// Depuis #181, TOUT volume v3 légitime porte une racine, donc un `.gen`. Et depuis #182 l'en-tête v3
// est refusé à l'ouverture en nommant la migration comme seul remède. Les deux règles se refermaient
// l'une sur l'autre : un volume v3 produit par ce dépôt n'était **ni ouvrable ni migrable**, et le
// remède que le message de refus lui indiquait ne fonctionnait pas.
//
// ## Sous quelle clé le `.gen` d'un volume v3 se lit, puisque la question se pose
//
// Sous la DEK ELLE-MÊME, directement. Un volume v3 n'a pas de clé maîtresse : `Scellement.ouvrir`
// avec `formatVersion` 3 emprunte `#sousLaCleMaitresse`, qui importe la DEK en clé AES-GCM et donne
// la même clé aux deux domaines — donc un seul budget, partagé (ADR 0016, ADR 0019). C'est le régime
// que la v4 remplace, et c'est l'unique appelant qui reste de ce chemin dans le produit : la
// MIGRATION. Le cliquet anti-DEK de T2b n'a donc qu'une exception à inscrire, et elle porte un nom.
//
// ## Pourquoi le VRAI magasin, et non un lecteur de plus
//
// Ouvrir la source par `GenerationStore` rend trois choses d'un seul geste, qu'un lecteur dédié
// aurait fallu réécrire — et donc laisser diverger :
//
//  1. la CHARGE ACQUITTÉE est appliquée au volume AVANT le rescellement, jamais perdue : c'est la
//     raison d'être du report, et le format 1 n'était que la manière v2 de le faire ;
//  2. les TROIS cas de l'ouverture de #181 s'appliquent à la source — racine, engagement, refus —,
//     et c'est le constat de format n° 4 : la migration DATAIT d'une racine neuve un volume v3 sans
//     racine, c'est-à-dire l'état exact que `VAULT_STORAGE_VOLUME_SANS_RACINE` refuse. La moitié
//     « restauration » du CRITICAL de #181 redevenait franchissable par le seul chemin que le
//     produit v4 laisse à une archive v3 ;
//  3. la FRAÎCHEUR de région et le témoin de séquence sont confrontés comme à toute ouverture : un
//     volume dont la région ne concorde plus ne rend aucun clair, fût-il authentique.
//
// Le magasin écrit une racine v3 en refermant. Elle est éphémère — le geste suivant de la migration
// retire le `.gen` entier —, et c'est voulu : la source reste, à chaque instant de ce solde, un
// volume v3 dans un état que son propre format admet. Une coupure ici ne laisse donc pas un état
// intermédiaire à inventer, mais un v3 ordinaire qu'une seconde tentative rouvrira de la même façon.

import { createFaultPlan } from "./fault-plan.mjs";
import { ecrituresARejouerV1 } from "./generation-v1-rejeu.mjs";
import { ouvrirGeneration } from "./opfs-generation-voisins.mjs";
import { MOTIFS_DE_RACINE_INITIALE, autorisationSansRacine } from "./opfs-racine-initiale.mjs";
import { createSha256Stream } from "./sha256-stream.mjs";
import { VolumeChiffre } from "./volume-chiffre.mjs";
import { dispositionDuVolume, tailleDeFichier } from "./volume-chiffre-format.mjs";
import { MIN_VOLUME_FORMAT_VERSION } from "./volume-manifest.mjs";

/** Bloc de relecture de l'empreinte du fichier : quatre mébioctets, comme l'export et l'ouverture. */
const EMPREINTE_BLOC_OCTETS = 4 * 1024 * 1024;

/**
 * ADAPTATEUR qui donne à l'engagement et à la fraîcheur ce qu'ils demandent d'un backend, à partir
 * du seul accès BRUT que la migration tient.
 *
 * Il n'expose AUCUN octet de plus que le backend chiffré n'en expose : `lireRegionAuth` est borné à
 * la région d'authentification, et l'empreinte est calculée ici plutôt que rendue en octets — un
 * appelant n'obtient qu'un verdict, jamais du chiffré (voir `empreinteDuFichier` du backend OPFS,
 * dont ceci est le pendant pour un accès brut).
 */
function adaptateurDeSource({ brut, scellement, identifiantVolume, tailleLogique }) {
  const disposition = dispositionDuVolume(tailleLogique);
  // La COUCHE CHIFFRÉE est celle du produit, montée sur l'accès brut : `lireSupportBrut` et
  // `ecrireSupportBrut` sont, pour le magasin, des gestes en CLAIR à des adresses LOGIQUES — c'est
  // elle qui ouvre et rescelle. Les câbler sur les octets du fichier, comme le fait le poseur de
  // racine initiale (qui, lui, n'écrit aucune charge), aurait fait recopier une charge par-dessus
  // la région d'authentification.
  const chiffre = new VolumeChiffre({
    volume: identifiantVolume,
    scellement,
    disposition,
    lireSupport: (offset, longueur) => brut.read(offset, longueur),
    ecrireSupport: (offset, octets) => brut.write(offset, octets),
  });
  return {
    disposition,
    identifiantVolume,
    lireRegionAuth: (offset, longueur) => brut.read(offset, longueur),
    lireSupportBrut: (adresse, longueur) => chiffre.lireSecteurs(adresse, longueur),
    ecrireSupportBrut: (adresse, octets, generation) =>
      chiffre.ecrireSecteurs(adresse, octets, generation),
    barriereSupportBrute: () => brut.flush(),
    async empreinteDuFichier({ blocOctets = EMPREINTE_BLOC_OCTETS } = {}) {
      const taille = disposition.tailleSupport;
      const hachage = createSha256Stream();
      for (let offset = 0; offset < taille; offset += blocOctets) {
        hachage.update(await brut.read(offset, Math.min(blocOctets, taille - offset)));
      }
      return hachage.digestHex();
    },
  };
}

/**
 * OUVRE le journal de génération de la source CHIFFRÉE, applique ce qu'il porte, et le referme.
 *
 * C'est une OUVERTURE au sens du § 7.3 : elle passe par les mêmes gestes, dans le même ordre, et
 * elle refuse les mêmes états. La migration n'est pas un chemin privilégié — elle est le dernier
 * chemin qui reste à un volume v3, ce qui est une raison de plus de ne rien lui passer.
 *
 * @param {{ name: string, brut: object, scellement: object, tailleLogique: number,
 *           identifiantVolume: string, cle: Uint8Array,
 *           openHandle: (name: string) => Promise<FileSystemSyncAccessHandle> }} options
 *   `brut` est le contrat de `ouvrirVolumeBrut` : `read`, `write`, `flush`.
 * @returns {Promise<object>} le rapport d'ouverture de la source, publié par la migration
 */
export async function solderLaSourceChiffreeSurAccesBrut({
  name,
  brut,
  scellement,
  tailleLogique,
  identifiantVolume,
  cle,
  openHandle,
}) {
  const backend = adaptateurDeSource({ brut, scellement, identifiantVolume, tailleLogique });
  const magasin = await ouvrirGeneration({
    name,
    size: tailleLogique,
    backend,
    scellement,
    openHandle,
    seuilPointDeControle: undefined,
    fautesFraicheur: createFaultPlan(),
    // Le motif `engagement` est le SEUL admissible ici, et c'est le constat de format n° 4 : la
    // migration ne tient pas ce fichier-là, elle le TROUVE. `creation` et `migration` disent « ces
    // octets sont les miens, je viens de les écrire » — ce qui est vrai du volume que la conversion
    // PRODUIT, et faux de celui qu'elle CONSOMME. Présenter `migration` ici rendrait de nouveau
    // ouvrable un v3 sans racine, c'est-à-dire un mélange d'états authentiques : exactement ce que
    // la revue externe du 10 septembre 2026 avait trouvé.
    sansRacine: autorisationSansRacine({
      name,
      motif: MOTIFS_DE_RACINE_INITIALE.engagement,
      backend,
      cle,
      openHandle,
    }),
  });
  try {
    return magasin.rapport;
  } finally {
    magasin.close();
  }
}

/**
 * REPORTE dans le volume la dernière génération validée du journal SOURCE, puis ÉCARTE ce journal.
 *
 * ## Pourquoi ce geste existe, et pourquoi il est ici
 *
 * Depuis #16 le fichier du volume ne porte pas tout son état : une génération VALIDÉE vit dans le
 * voisin `<volume>.gen` jusqu'à ce qu'une ouverture la reporte. Une migration qui l'ignore fait deux
 * dégâts, tous deux nommés par la revue de #110 : elle PERD une écriture acquittée, et elle laisse
 * derrière elle un journal d'un format que le volume migré ne sait plus lire — si bien que le volume
 * tout juste migré ne s'ouvre plus, sous un code qui envoie restaurer une sauvegarde alors que les
 * données sont intactes.
 *
 * ## L'ordre, qui est le contrat
 *
 * Le report ÉCRIT dans le volume : il vient donc après la révocation du manifeste (geste 7), comme
 * toute mutation. Il vient avant la conversion, et il le faut : le report vise des adresses du
 * volume V2, que la conversion déplace. Le journal est écarté ensuite, et une coupure entre les deux
 * est sans conséquence — reporter deux fois les mêmes octets aux mêmes adresses ne change rien.
 *
 * ## Ce qui protège de reporter APRÈS la conversion
 *
 * Le REPORT ne s'exécute que si le fichier est encore à sa taille SOURCE. Une reprise qui trouve un
 * fichier déjà agrandi sait que la conversion a commencé, donc que le journal a déjà été soldé.
 *
 * ## Le RETRAIT, lui, est INCONDITIONNEL (#65)
 *
 * La première version sortait avant de le demander dès qu'il n'y avait rien à reporter. C'était
 * raisonner sur le seul `<volume>.gen`, alors que le même geste emporte le témoin de séquence (#19)
 * et l'instantané de reprise (#65, ADR 0024, décision 8) — deux voisins qui, eux, existent
 * précisément quand le journal est absent, c'est-à-dire après une fermeture PROPRE. Un instantané
 * survivait donc à la migration qui vient de récrire chaque secteur sous un autre format.
 *
 * Sa liaison l'aurait fait refuser, puisqu'elle porte la version de format du volume. Mais s'en
 * remettre à cela revient à laisser sur le support la RAM invitée d'une session d'avant la
 * migration en pariant que personne ne saura la lire. Le geste est idempotent : le demander pour
 * rien coûte un appel, ne pas le demander laisse un fichier qui n'aurait pas dû survivre.
 */
export async function solderLeJournalDeGeneration({ target, backend, source }) {
  if (typeof target.removeGenerationJournal !== "function") return null;
  // Le REPORT d'abord : il peut refuser (journal altéré), et ce refus doit remonter AVANT tout
  // retrait — écarter les voisins d'une migration qu'on s'apprête à interrompre les perdrait.
  const reporte = await reporterLeJournalDeGeneration({ target, backend, source });
  await target.removeGenerationJournal();
  return reporte;
}

/**
 * Rejoue dans le volume la dernière génération validée du journal SOURCE, s'il y en a une.
 *
 * **Ce chemin ne sert QUE les sources en clair — v1 et v2** (CRITICAL de la revue de format de la
 * PR #186). Le lecteur qu'il emploie est celui du journal de FORMAT 1, validé par un CRC-32 ; le
 * commentaire de tête de `generation-v1-rejeu.mjs` le dit lui-même, « un volume v2 qui a réellement
 * servi porte un voisin `.gen` au format 1 ». L'appliquer à une source CHIFFRÉE était un défaut
 * exact : le marqueur `VLTGEN01` est partagé par les formats 1 à 5, si bien qu'un journal de
 * format 4 franchissait le contrôle de marqueur puis échouait au CRC — que ce format a justement
 * remplacé par une étiquette GCM. Une source chiffrée passe par `solderLaSourceChiffree`, qui
 * l'OUVRE au lieu de la recopier.
 */
async function reporterLeJournalDeGeneration({ target, backend, source }) {
  if (source.formatVersion >= MIN_VOLUME_FORMAT_VERSION) return null;
  if (typeof target.readGenerationJournal !== "function") return null;
  const tailleSource = tailleDeFichier({
    formatVersion: source.formatVersion,
    tailleLogique: source.geometry.volumeSize,
  });
  if (backend.size() !== tailleSource) return null;

  const octets = await target.readGenerationJournal();
  if (octets === null || octets === undefined) return null;

  const { generation, ecritures } = ecrituresARejouerV1({
    octets,
    tailleVolume: source.geometry.volumeSize,
  });
  for (const ecriture of ecritures) await backend.write(ecriture.offset, ecriture.octets);
  // La barrière AVANT le retrait : écarter un journal dont le report n'est pas durable perdrait
  // exactement ce qu'on cherchait à sauver.
  if (ecritures.length > 0) await backend.flush();
  return Object.freeze({ generation, ecritures: ecritures.length });
}

/**
 * GESTE 5 bis — OUVRIR la source CHIFFRÉE, comme le § 7.3 ouvre un volume (#182, revue de la PR #186).
 *
 * ## Pourquoi la migration OUVRE sa source au lieu de la recopier
 *
 * Une source v1 ou v2 est du clair : son journal se REPORTE, et c'est tout ce qu'il y a à en dire.
 * Une source v3 est un volume CHIFFRÉ en service, avec sa racine, sa fraîcheur et, peut-être, une
 * génération validée que le fichier ne porte pas encore. Elle se lit par le seul geste qui sache
 * lire un tel volume — son MAGASIN DE GÉNÉRATIONS —, et ce geste rend trois choses que deux
 * constats de revue réclamaient séparément :
 *
 *  1. la charge ACQUITTÉE est appliquée avant le rescellement, jamais perdue (CRITICAL de format
 *     n° 1 : le lecteur de format 1 la faisait échouer au CRC, et la migration refusait TOUT v3
 *     légitime — qui, depuis #181, porte toujours une racine) ;
 *  2. les TROIS cas de #181 s'appliquent à la SOURCE (HIGH de format n° 4) : racine → ouverture
 *     normale ; pas de racine mais un engagement d'archive → vérifié sous la clé, empreinte du
 *     fichier entier, AVANT tout clair, puis consommé ; ni l'un ni l'autre →
 *     `VAULT_STORAGE_VOLUME_SANS_RACINE`. La migration datait jusqu'ici d'une racine neuve un
 *     volume que l'ouverture aurait refusé, par le seul chemin qui reste à une archive v3 ;
 *  3. la FRAÎCHEUR de région est confrontée, comme à toute ouverture.
 *
 * ## Sa PLACE dans la chaîne, et pourquoi elle est avant le journal de reprise
 *
 * Il vient après la preuve de sauvegarde et AVANT le geste 6 : un refus laisse donc le volume
 * intact ET son manifeste en place — c'est la même règle que l'ouverture au geste 4, « une ouverture
 * ratée ne doit pas rendre inutilisable un volume parfaitement intact ». Le placer après la
 * révocation aurait rendu non identifié un volume que le produit vient de refuser d'ouvrir.
 *
 * ## Une REPRISE ne le rejoue pas, et c'est un refus de détruire
 *
 * La présence d'un journal de reprise atteste que la conversion a commencé : le fichier n'est plus
 * la source, il est un entre-deux dont certaines suites sont déjà v4. Rouvrir « la source » y
 * appliquerait une charge v3 par-dessus des secteurs rescellés — la faute exacte que le
 * discriminant `dejaFranchi` a déjà corrigée un cran plus bas. Le solde a eu lieu avant la première
 * inscription du journal ; il n'y a rien à refaire.
 */
export async function solderLaSourceChiffree({ target, backend, source, cle, reprise }) {
  if (source.formatVersion < MIN_VOLUME_FORMAT_VERSION) return null;
  if (reprise) return null;
  const identifiantVolume = source.volume?.id ?? null;
  if (identifiantVolume === null) return null;
  if (typeof target.solderLaSourceChiffree !== "function") {
    throw new TypeError(
      "migrateVolume : cette cible ne sait pas ouvrir un volume source CHIFFRÉ. Son journal ne serait pas lu — une écriture acquittée serait perdue en silence — et son engagement ne serait pas vérifié (#182, revue de la PR #186).",
    );
  }
  return target.solderLaSourceChiffree({
    brut: backend,
    tailleLogique: source.geometry.volumeSize,
    identifiantVolume,
    formatVersion: source.formatVersion,
    cle,
  });
}
