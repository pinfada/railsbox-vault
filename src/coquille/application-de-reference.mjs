// L'ÉTAPE 3 du cycle de vie, DANS le Worker de confiance : le backend, puis la VM (#163, ADR 0030).
//
// Jusqu'ici, faire booter Rails sur un volume OPFS était un BANC — `public/vm/reference-banc.mjs` et
// ses phases, pilotés par `tests/e2e/`. La table d'avancement de `docs/architecture.md` le disait
// sans détour : « étape 3 — banc, la VM n'est pas dans la coquille ». Ce module l'y amène, et il
// n'en réécrit rien : le boot est celui de `src/vm/boot-de-reference.mjs`, déplacé et non recopié.
//
// ## Ce que la coquille APPORTE, et que le banc n'avait pas
//
//  - **la clé.** Le banc ouvre le volume du guest sous le jeton du harnais (`cle-du-banc.mjs`) ; la
//    coquille l'ouvre sous la clé développée de son enveloppe (ADR 0020, #162). C'est la seule
//    différence entre les deux chemins, et c'est pour elle que `ouvrirLeVolumeDuGuest` est injecté ;
//  - **l'ordre.** Un boot demandé avant l'ouverture du backend est refusé par
//    `VAULT_COQUILLE_ETAPE_HORS_ORDRE` (`cycle-de-vie.mjs`), et non découvert à mi-chemin ;
//  - **l'installation.** Un coffre neuf ne contient pas l'application : la coquille l'y VERSE au
//    premier démarrage, dans un volume qui naît ANONYME et ne devient identifié qu'une fois le
//    disque écrit et flushé — la règle de `phasePrepare`, tenue ici aussi.
//
// ## Deux volumes, un seul coffre — et pourquoi
//
// La coquille tient le volume `coquille` depuis #161 : trente-deux secteurs, l'état et le compte de
// barrières. Le disque de l'application est un AUTRE volume, `application`, et ce n'est pas une
// commodité :
//
//  - un volume déclare sa taille à sa NAISSANCE et ne grandit pas (`opfs-volume-ouverture.mjs`,
//    « fournie, elle doit correspondre exactement »). Le coffre est créé au premier geste de
//    déverrouillage, bien avant qu'on sache si une application sera installée ;
//  - l'ADR 0018 range déjà les applications par volume, et c'est la forme vers laquelle #24 va ;
//  - les deux sont scellés sous la MÊME clé de volume, développée de la MÊME enveloppe, avec des
//    identifiants de volume DISTINCTS — sans quoi un secteur de l'un se rejouerait dans l'autre
//    (ADR 0015, données associées). `identites-du-coffre.mjs` les nomme (ADR 0039).
//
// L'identifiant du volume applicatif était TIRÉ à sa création par l'ouvreur. Depuis le 13/09/2026
// (#207, ADR 0039), il est celui du COFFRE — la constante que l'enveloppe authentifie —, et le
// volume `coquille` a reçu une constante distincte : jamais deux volumes sous la même clé et le
// même identifiant. Le manifeste voisin en reste la source à la lecture (ADR 0016).

import { CODES_REFUS_COQUILLE, messageDeRefus } from "./refus-de-coquille.mjs";
import {
  ADRESSE_DESCRIPTEUR,
  DESCRIPTEUR_VERSION_ATTENDUE,
  formeDuDescripteur,
  lireLeDescripteur,
} from "./descripteur-applicatif.mjs";
import { IDENTIFIANT_DU_COFFRE } from "./identites-du-coffre.mjs";
import { daterLaCreation, openOpfsVolume } from "../vm/opfs-block-backend.mjs";
import {
  manifestSidecarName,
  openOpfsSyncAccess,
  statOpfsVolume,
} from "../vm/opfs-sync-access.mjs";
import {
  openVolumeForWrite,
  readVolumeManifest,
  revokeVolumeManifest,
  writeVolumeManifest,
} from "../vm/opfs-volume-open.mjs";
import { chargerAdressesV86, exigerAdresse } from "../v86-adresses.mjs";
import { verserFluxDansVolume } from "../vm/versement-de-disque.mjs";
import {
  codeDuRefusDuGuest,
  avantLeBootDuPaquet,
  constaterLeDephasage,
  decisionPubliee,
  miseAJourPubliee,
  preparerLeDemarrage,
  suivreLeConstat,
} from "./mise-a-jour-applicative.mjs";
import { VOLUME_ALGORITHM, createManifest } from "../vm/volume-manifest.mjs";
import {
  echecDInstallationReconnu,
  echecDuPremierBoot,
  manifesteEstLisible,
  signatureDInstallationInterrompue,
} from "./installation-interrompue.mjs";

/**
 * La LECTURE et la FORME du descripteur vivent dans `descripteur-applicatif.mjs` depuis #236 ; elles
 * sont RÉEXPORTÉES ici parce que ce module reste l'entrée du chemin de démarrage, et qu'une épreuve
 * n'a pas à connaître la coupe interne pour exiger un refus.
 */
export { ADRESSE_DESCRIPTEUR, DESCRIPTEUR_VERSION_ATTENDUE, formeDuDescripteur, lireLeDescripteur };

/** La signature (#173) et la lecture du manifeste vivent dans `installation-interrompue.mjs` (#250). */
export { manifesteEstLisible, signatureDInstallationInterrompue };

/** Nom du volume qui porte le disque de l'application. Voir l'en-tête : ce n'est pas `coquille`. */
export const NOM_DU_VOLUME_APPLICATIF = "application";

/** @param {string} code @param {string} message */
function refus(code, message) {
  return Object.assign(new Error(message), { code });
}

/**
 * Le DESCRIPTEUR DE MANIFESTE que le volume applicatif doit déclarer (`SEC-UPDATE-001`).
 *
 * `minWriter` est la version en cours, le choix le plus strict — c'est celui du banc, et deux
 * chemins qui écrivent le même format n'ont pas à en choisir deux.
 *
 * @param {object} descripteur
 */
export function descripteurDeManifeste(descripteur) {
  return {
    runtime: {
      version: descripteur.runtime.version,
      artifact: null,
      minWriter: descripteur.runtime.version,
    },
    // Le SCHÉMA de la graine installée (#236 T2, ADR 0042) : un coffre né depuis T2 le dit, et la
    // décision de déphasage n'a rien à déduire pour lui.
    app: {
      id: descripteur.application.id,
      version: descripteur.application.version,
      schema: descripteur.application.schema,
    },
  };
}

/**
 * Les adresses que le boot doit récupérer : deux artefacts v86 épinglés par empreinte (#123), cinq
 * de l'image de référence servis sous leur nom.
 *
 * @param {object} descripteur
 * @param {{ recuperer?: typeof fetch }} [options]
 */
export async function adressesDuRuntime(descripteur, { recuperer = globalThis.fetch } = {}) {
  const { adresses } = await chargerAdressesV86({ fetch: recuperer });
  const prefixe = descripteur.prefixeDesArtefacts;
  const morceau = (cle) => ({
    url: `${prefixe}${descripteur[cle].nom}`,
    octets: descripteur[cle].octets,
    sha256: descripteur[cle].sha256,
    compression: descripteur[cle].compression ?? null,
    transfertOctets: descripteur[cle].transfertOctets ?? null,
  });
  return {
    lib: exigerAdresse(adresses, "libv86.mjs"),
    wasm: exigerAdresse(adresses, "v86.wasm"),
    bios: `${prefixe}${descripteur.boot.bios}`,
    vgaBios: `${prefixe}${descripteur.boot.vgaBios}`,
    kernel: `${prefixe}${descripteur.boot.kernel}`,
    initrd: `${prefixe}${descripteur.boot.initrd}`,
    // Les DEUX morceaux du disque système, avec leur empreinte : le boot les range aux décalages
    // du plan (`src/vm/disque-compose.mjs`) et refuse celui dont les octets ne correspondent pas.
    disqueSysteme: { rootfs: morceau("rootfs"), paquet: morceau("paquet") },
  };
}

/**
 * INSTALLE l'application dans son volume, si elle ne s'y trouve pas encore.
 *
 * L'ordre est celui de `phasePrepare`, et il est le contrat : le volume naît ANONYME — son manifeste
 * n'est inscrit qu'une fois le disque écrit ET flushé —, si bien qu'une installation interrompue
 * laisse un volume non identifié, donc non ouvrable en écriture. Un demi-disque qui se croirait
 * complet serait bien pire qu'une installation à refaire.
 *
 * **Trois issues, et pas une de plus :**
 *
 *  - le manifeste voisin est là → `{ installee: false }`. Réinstaller effacerait ce que le guest a
 *    écrit depuis, ce qu'aucun geste de démarrage n'a le droit de faire ;
 *  - rien n'existe → le disque est versé, puis le volume devient identifié ;
 *  - **le fichier de volume existe SANS manifeste → REFUS**, `VAULT_COQUILLE_VOLUME_APPLICATIF_SANS_MANIFESTE`.
 *    C'est le cas que la première rédaction traitait comme un volume neuf : elle versait le disque
 *    par-dessus, sans un geste et sans un mot. Un volume anonyme est soit une installation
 *    interrompue, soit autre chose ; dans les deux cas, l'écraser est une décision que la coquille
 *    n'a pas à prendre seule. Ce qu'il faudra pour l'identifier ou le réparer est une question
 *    ouverte, et elle est nommée dans l'ADR 0030 plutôt que tranchée ici.
 *
 * Les quatre primitives du support sont INJECTÉES, comme celles de `exclusivite-du-volume.mjs` :
 * sans elles, cette fonction ne serait mesurable que par un navigateur portant un demi-gibioctet
 * d'artefacts, donc jamais par une campagne de mutation.
 *
 * @param {{ descripteur: object, cleDeVolume: () => Promise<Uint8Array>, observer?: Function,
 *           ouvrir?: Function, verser?: Function, revoquer?: Function, inscrire?: Function,
 *           openHandle?: Function }} options
 */
export async function installerSiNecessaire({
  descripteur,
  cleDeVolume,
  observer = statOpfsVolume,
  ouvrir = openOpfsVolume,
  dater = daterLaCreation,
  verser = verserFluxDansVolume,
  revoquer = revokeVolumeManifest,
  inscrire = writeVolumeManifest,
  openHandle = openOpfsSyncAccess,
  lireLeManifeste = readVolumeManifest,
}) {
  const nom = NOM_DU_VOLUME_APPLICATIF;
  // La taille du VOLUME est celle du disque de données, pas celle du fichier de graine : la graine
  // est l'image d'un disque de cette taille exactement, et le volume déclare la sienne à sa
  // naissance, sans jamais grandir (`opfs-volume-ouverture.mjs`).
  const octets = descripteur.graine.disqueOctets;
  if (await constaterLInstallation({ nom, octets, observer, openHandle, lireLeManifeste })) {
    return { installee: false, volume: nom, octets };
  }

  // Rien n'existe : le manifeste est révoqué d'abord, pour que rien ne puisse ouvrir un volume à
  // demi versé entre-temps.
  await revoquer(nom);
  try {
    return await installerDansUnVolumeNeuf({
      descripteur,
      cleDeVolume,
      ouvrir,
      dater,
      verser,
      inscrire,
      nom,
      octets,
    });
  } catch (erreur) {
    // Un échec APRÈS la création du volume laisse ce que le démarrage suivant trouverait : il est
    // reconnu tout de suite, signature comprise (#250), au lieu de remonter nu.
    throw await echecDInstallationReconnu({ erreur, nom, octets, observer, openHandle });
  }
}

/**
 * VERSE, DATE, puis INSCRIT le manifeste — l'installation proprement dite, sur un volume qui n'existe
 * pas encore. Extraite de `installerSiNecessaire` pour que tout échec y soit reconnu (#250).
 */
async function installerDansUnVolumeNeuf({
  descripteur,
  cleDeVolume,
  ouvrir,
  dater,
  verser,
  inscrire,
  nom,
  octets,
}) {
  const verse = await verserLeDisque({ descripteur, cleDeVolume, ouvrir, verser, nom, octets });
  if (verse.ecrits !== descripteur.graine.octets) {
    throw refus(
      CODES_REFUS_COQUILLE.applicationAbsente,
      `Graine tronquée : ${verse.ecrits} octets reçus sur ${descripteur.graine.octets}.`,
    );
  }
  await daterLaCreationDuVolume({
    dater,
    cleDeVolume,
    nom,
    identifiantVolume: verse.identifiantVolume,
    empreinteVersee: verse.empreinte,
    scellementsVerses: verse.scellements,
  });
  await inscrireLeManifeste({
    inscrire,
    nom,
    descripteur,
    octets,
    identifiantVolume: verse.identifiantVolume,
  });
  return { installee: true, volume: nom, octets, ecrits: verse.ecrits };
}

/**
 * INSCRIT le manifeste, DERNIER geste de l'installation : le volume devient identifié, donc
 * ouvrable en écriture. Tout ce qui précède laisse un volume ANONYME, et c'est ce qui rend une
 * installation interrompue reconnaissable.
 */
async function inscrireLeManifeste({ inscrire, nom, descripteur, octets, identifiantVolume }) {
  const descripteurManifeste = descripteurDeManifeste(descripteur);
  await inscrire(
    nom,
    createManifest({
      runtime: descripteurManifeste.runtime,
      app: descripteurManifeste.app,
      volumeSize: octets,
      identity: { algorithm: "sha-256", digest: null },
      volume: { id: identifiantVolume, algorithm: VOLUME_ALGORITHM },
    }),
  );
}

/**
 * CONSTATE ce que le support porte déjà, et rend `true` si l'application est installée.
 *
 * Extrait de `installerSiNecessaire` : les deux issues qui n'installent RIEN se jugent sur le seul
 * état observé, et elles se lisent mieux ensemble. Un volume ANONYME est refusé plutôt qu'écrasé —
 * c'est soit une installation interrompue, soit autre chose, et l'écraser est une décision que la
 * coquille n'a pas à prendre seule (constat 7 de la revue de la PR #171). La SIGNATURE de laquelle
 * il s'agit accompagne le refus, dans son contexte — jamais dans son message, qui reste identique
 * dans les deux cas : c'est le geste (#173), pas ce module, qui décide quoi en faire.
 */
async function constaterLInstallation({ nom, octets, observer, openHandle, lireLeManifeste }) {
  const manifesteExistant = await observer(manifestSidecarName(nom));
  const manifesteLisible =
    manifesteExistant.present && (await manifesteEstLisible(nom, lireLeManifeste));
  if (manifesteLisible) return true;
  const volumeExistant = await observer(nom);
  if (!volumeExistant.present) return false;
  const signature = await signatureDInstallationInterrompue({
    nom,
    octetsAnnonces: octets,
    observer,
    openHandle,
  });
  throw Object.assign(
    refus(
      CODES_REFUS_COQUILLE.volumeApplicatifSansManifeste,
      manifesteExistant.present
        ? `Le volume « ${nom} » porte un manifeste voisin illisible : la coquille ne l'écrase pas pour installer.`
        : `Le volume « ${nom} » existe sans manifeste : la coquille ne l'écrase pas pour installer.`,
    ),
    {
      installationInterrompue: signature.interrompue,
      motifDeLaSignature: signature.motif,
      tailleDuVolume: volumeExistant.size,
    },
  );
}

/**
 * OUVRE le volume NEUF et y verse le disque, en flux. Rend les octets écrits, l'EMPREINTE du fichier
 * que le versement a laissée, et l'IDENTIFIANT que l'ouvreur a tiré : c'est lui, et non un
 * identifiant réinventé, que le manifeste devra déclarer.
 */
async function verserLeDisque({ descripteur, cleDeVolume, ouvrir, verser, nom, octets }) {
  const backend = await ouvrirLeVolumeNeuf({ ouvrir, cleDeVolume, nom, octets });
  try {
    const verse = await verserLaGraine(backend, descripteur, verser);
    // Un versement qui ne rend qu'un COMPTE n'atteste RIEN de ce qu'il a écrit : c'est le contrat
    // d'avant #181, et la datation le refusera par `VAULT_STORAGE_CREATION_NON_CONFIRMEE`. On ne le
    // rattrape pas ici — relire le fichier à sa place fabriquerait exactement l'attestation que ce
    // versement-là n'a pas donnée, et la garde ne vaudrait plus rien.
    return {
      identifiantVolume: backend.identifiantVolume,
      ecrits: typeof verse === "number" ? verse : verse.ecrits,
      empreinte: typeof verse === "number" ? null : (verse.empreinte ?? null),
      // Ce que le versement a CONSOMMÉ sous la clé du volume. Un versement d'avant cette garde n'en
      // rend pas, et la datation retombera alors sur les compteurs de la racine de naissance : elle
      // SOUS-comptera, comme avant, plutôt que de rendre un nombre inventé.
      scellements: typeof verse === "number" ? null : (verse.scellements ?? null),
    };
  } finally {
    await backend.close();
  }
}

/**
 * VERSE la graine, et TRADUIT l'échec du versement en refus TYPÉ.
 *
 * Le versement lève sur deux manques, et l'un est neuf (#236) : les octets reçus n'ont pas
 * l'empreinte que l'origine déclare. Sans cette traduction, l'exception remonterait nue jusqu'au
 * canal privilégié, qui la réduit à « démarrage refusé » sans code — la coquille dirait à la
 * personne que quelque chose a échoué sans dire QUOI, là où l'installation d'une application absente
 * ou altérée a déjà son code et sa conduite (`applicationAbsente`).
 */
async function verserLaGraine(backend, descripteur, verser) {
  try {
    return await verser(backend, `${descripteur.prefixeDesArtefacts}${descripteur.graine.nom}`, {
      // L'EMPREINTE de la graine est confrontée PENDANT le versement, sur les octets reçus : un
      // écart refuse l'installation au lieu de sceller dans le coffre une base que l'origine n'a
      // pas produite. Jusqu'à #236, l'empreinte du fichier écrit était rendue mais celle de la
      // SOURCE n'était comparée à rien.
      empreinteAttendue: descripteur.graine.sha256,
      // Une graine COMPRESSÉE (gzip, #236 T2) se décompresse en flux ; son empreinte et sa taille
      // restent celles de l'image décompressée, qui BORNE aussi la décompression (anti-bombe).
      compression: descripteur.graine.compression ?? null,
      transfertOctets: descripteur.graine.transfertOctets ?? null,
      octetsMax: descripteur.graine.octets,
      // Un volume neuf scellé se relit à ZÉRO (ADR 0041) : les blocs nuls de la graine n'ont donc
      // pas à être écrits. Sur 512 Mio dont 0,4 utile, c'est l'essentiel de l'installation.
      sauterLesBlocsNuls: true,
    });
  } catch (erreur) {
    if (erreur?.code !== undefined) throw erreur;
    throw refus(
      CODES_REFUS_COQUILLE.applicationAbsente,
      `L'application n'a pas pu être installée : ${erreur.message}`,
    );
  }
}

/**
 * OUVRE le volume NEUF, sous une clé effacée QUOI QU'IL ARRIVE.
 *
 * Elle ne l'était que sur le chemin du succès, si bien qu'un `VAULT_STORAGE_BUSY` laissait ses
 * octets en clair dans le tas du Worker : c'est le constat 5 de la revue de la PR #167, dont la
 * correction manquait ici (constat 9 de la revue de la PR #171).
 */
async function ouvrirLeVolumeNeuf({ ouvrir, cleDeVolume, nom, octets }) {
  const cle = await cleDeVolume();
  try {
    return await ouvrir({
      name: nom,
      size: octets,
      cle,
      // Le volume NAÎT sous l'identité du COFFRE, celle que l'enveloppe authentifie (#207,
      // ADR 0039) : son archive peut ainsi emporter la page de récupération qui l'ouvre ailleurs.
      identifiantVolume: IDENTIFIANT_DU_COFFRE,
      transactionnel: false,
      // Ce versement sera DATÉ : `daterLaCreation` est sa clôture, et une racine écrite à la
      // fermeture lui ferait trouver un journal « en service » (#182, T2b).
      clotureParDatation: true,
    });
  } finally {
    cle.fill(0);
  }
}

/**
 * DATE la création du volume applicatif (#181), une fois son disque versé ENTIER.
 *
 * Le versement écrit le fichier hors transaction, donc change la RÉGION D'AUTHENTIFICATION : la
 * racine initiale que la naissance a écrite date une région qui n'est plus là. Ce geste la réécrit
 * sur la région finale, et c'est l'avant-dernier geste de l'installation — le manifeste, qui DÉCLARE
 * le volume, vient encore après.
 *
 * **Sans lui, le volume est REFUSÉ au premier boot** par la garde de fraîcheur (ADR 0019) : un oubli
 * coûte un refus, jamais un silence.
 *
 * Il vient APRÈS le contrôle de troncature : un disque versé à moitié n'a pas de création à dater,
 * et l'installation s'arrête sans avoir déclaré quoi que ce soit.
 *
 * **Il porte l'EMPREINTE que le versement a rendue** (#181, revue de sécurité de la PR #184) : le
 * versement a fermé le fichier, ce geste le rouvre, et l'intervalle n'appartient à personne. Sans
 * cette empreinte la datation bénirait ce qu'elle trouve — y compris le fichier qu'un adversaire
 * OPFS aurait posé entre les deux —, et l'installation se déclarerait réussie sur un volume qui
 * rendrait ensuite un état que ce produit n'a jamais produit. Une empreinte absente ou discordante
 * REFUSE (`VAULT_STORAGE_CREATION_NON_CONFIRMEE`), et l'installation s'arrête là.
 *
 * La clé est effacée QUOI QU'IL ARRIVE, comme partout ailleurs sur ce chemin.
 */
async function daterLaCreationDuVolume({
  dater,
  cleDeVolume,
  nom,
  identifiantVolume,
  empreinteVersee,
  scellementsVerses = null,
}) {
  const cle = await cleDeVolume();
  try {
    return await dater({
      name: nom,
      cle,
      identifiantVolume,
      empreinteVersee,
      scellementsVerses,
    });
  } finally {
    cle.fill(0);
  }
}

/**
 * L'OUVREUR du volume applicatif pour la coquille : la clé vient de l'ENVELOPPE, et ne survit pas à
 * l'ouverture.
 *
 * `openVolumeForWrite` refuse d'abord le volume qui n'est pas identifié, d'un format futur ou d'une
 * autre application (`SEC-UPDATE-001`), puis ouvre sous la clé. Les octets de celle-ci sont effacés
 * dès que l'ouvreur a rendu la main — la même réduction de fenêtre que `ouverture-par-enveloppe.mjs`
 * pratique, et avec la même réserve : c'est FAIT, ce n'est pas GARANTI (ADR 0021, décision 7).
 *
 * @param {{ cleDeVolume: () => Promise<Uint8Array> }} options
 */
export function ouvreurSousLEnveloppe({ cleDeVolume }) {
  return async ({ name, journal, expectations }) => {
    const cle = await cleDeVolume();
    try {
      return await openVolumeForWrite({ name, journal, cle, expectations });
    } finally {
      cle.fill(0);
    }
  };
}

/**
 * Budget d'un boot Rails dans la coquille. Généreux, et pour la raison du banc : un i386 émulé
 * démarre en dizaines de secondes, et `docs/quality-attributes.md` publie p95 = 125,9 s, hors
 * budget. Une borne serrée ferait échouer un démarrage pour la lenteur de la machine plutôt que
 * pour un défaut du produit.
 */
export const DELAI_BOOT_MS = 300_000;

/**
 * Copie SUPERFICIELLE d'un objet, ne gardant que ses valeurs SIMPLES.
 *
 * C'est le cœur de la liste fermée, et la première rédaction l'avait manqué : elle nommait les
 * champs publiés mais les recopiait TELS QUELS, si bien que la profondeur et la nature de leur
 * contenu échappaient à la coquille. Le scénario de bout en bout l'a montré à la réouverture —
 * `sansCapacite` a refusé la réponse sous `VAULT_COQUILLE_CAPACITE_DANS_UN_MESSAGE`, sur un compte
 * rendu de boot qui portait, quelque part, autre chose qu'une donnée simple.
 *
 * Ce que cette fonction garantit, et que « nommer les champs » ne garantissait pas : ce qui repart a
 * une profondeur de DEUX, et ne contient que des nombres, des chaînes, des booléens et des `null`.
 * Un tampon, une vue, une fonction ou un objet imbriqué sont laissés derrière — silencieusement, et
 * c'est voulu : ce n'est pas un refus, c'est une projection.
 */
function valeursSimples(objet) {
  if (objet === null || objet === undefined || typeof objet !== "object") return null;
  const rendu = {};
  for (const [cle, valeur] of Object.entries(objet)) {
    const nature = typeof valeur;
    if (valeur === null || nature === "number" || nature === "string" || nature === "boolean") {
      rendu[cle] = valeur;
    }
  }
  return rendu;
}

/**
 * Ce que le démarrage PUBLIE sur le canal privilégié. Une liste FERMÉE en largeur ET en profondeur.
 *
 * C'est la leçon du relevé borné de la revue de la PR #166 : le compte rendu de boot porte une
 * trentaine de champs, dont le journal du guest et les observations du runtime, et les reposter en
 * bloc ferait grossir un message de la base de confiance au rythme de ce que le guest imprime. Ce
 * qui repart est ce qu'une épreuve doit pouvoir asserter, rien de plus — et chaque champ composé
 * passe par `valeursSimples`, de sorte qu'aucune structure venue du support ne franchisse le canal
 * avec une forme que personne n'a décidée.
 */
export function compteRenduPublie(rendu) {
  return {
    volume: rendu.volume,
    volumeOctets: rendu.volumeBytes,
    bootMs: rendu.bootMilliseconds,
    santeMs: rendu.healthMilliseconds,
    instantaneUtilise: rendu.usedSnapshot,
    instantane: valeursSimples(rendu.instantane),
    decomposition: valeursSimples(rendu.timeline),
    counts: valeursSimples(rendu.counts),
    generation: valeursSimples(rendu.generation),
    recuperation: valeursSimples(rendu.recuperation),
    invariantStatut: rendu.invariantHttpStatus,
    // Le STATUT du verdict, et non le verdict entier : ce que deux boots doivent rendre identique
    // est déjà publié à côté, sous `enregistrementObserve` et `pieceJointeObservee`, et un verdict
    // rendu par Rails est une structure dont la forme appartient au guest.
    invariantVerdict: valeursSimples(rendu.invariantVerdict),
    enregistrementObserve: rendu.observedRecordId,
    pieceJointeObservee: rendu.observedAttachmentSha256,
    boucleOrdonnancement: valeursSimples(rendu.boucleOrdonnancement),
    rythme: valeursSimples(rendu.rythme),
    // Un COMPTE, pas la liste : une panne de support absorbée doit se voir ; son contenu appartient
    // au diagnostic du Worker, pas au relevé.
    pannes: rendu.failures.length,
    // Ce que le déphasage a décidé et ce que le guest a fait du schéma (#236 T2), à plat.
    miseAJour: miseAJourPubliee(rendu.miseAJourApplicative, rendu.schema),
  };
}

/**
 * INSTALLE si nécessaire, et TRADUIT le refus « sans manifeste » en résultat plutôt qu'en exception
 * — extrait de `demarrerLaVm` pour rester sous le plafond de fonction de #93.
 *
 * Rend soit le compte rendu BRUT de `installerSiNecessaire` (aucun champ `demarree`), soit
 * `{ demarree: false, ... }` avec la SIGNATURE (#173) que l'appelant (le Worker) publiera sur le
 * canal privilégié. Toute AUTRE exception continue de remonter telle quelle.
 */
async function installerOuTraduireLeRefus({ descripteur, cleDeVolume }) {
  try {
    return await installerSiNecessaire({ descripteur, cleDeVolume });
  } catch (erreur) {
    if (erreur?.code !== CODES_REFUS_COQUILLE.volumeApplicatifSansManifeste) throw erreur;
    return {
      demarree: false,
      motif: erreur.message,
      code: erreur.code,
      installationInterrompue: erreur.installationInterrompue ?? false,
      motifDeLaSignature: erreur.motifDeLaSignature ?? null,
    };
  }
}

/**
 * DÉMARRE la machine virtuelle sur le volume applicatif, et rend la poignée de fermeture.
 *
 * Elle ne contrôle PAS l'ordre : c'est le Worker de confiance qui exige un backend ouvert avant
 * d'appeler ceci (`cycle-de-vie.mjs`, `exigerLeBackend`). Elle ne contrôle pas non plus l'état — un
 * module qui déciderait à la fois de l'ordre et du boot rendrait la garde inséparable de ce qu'elle
 * garde.
 *
 * L'absence de descripteur rend `{ demarree: false }` avec son motif, jamais une exception : sur une
 * origine qui ne sert aucune application, il n'y a rien à démarrer, et ce n'est pas une panne.
 *
 * @param {{ cleDeVolume: () => Promise<Uint8Array>, reprendreParInstantane?: boolean,
 *           bootTimeoutMs?: number }} options
 */
export async function demarrerLaVm({
  cleDeVolume,
  reprendreParInstantane = true,
  bootTimeoutMs = DELAI_BOOT_MS,
  miseAJour = false,
}) {
  const lu = await lireLeDescripteur();
  // Le DÉPHASAGE est décidé ICI, avant toute installation et tout boot (#236 T2, ADR 0042) : le
  // manifeste du coffre est lu, confronté au descripteur, et un refus rend la main sans qu'un octet
  // du volume ait été écrit.
  const prepare = await preparerLeDemarrage({
    lu,
    nom: NOM_DU_VOLUME_APPLICATIF,
    miseAJour,
    delaiMs: bootTimeoutMs,
  });
  if (prepare.sansApplication) return { demarree: false, motif: prepare.motif };
  if (prepare.refus !== undefined) return refusDeDemarrage(prepare.refus, prepare);
  const descripteur = prepare.descripteur;
  const installation = await installerOuTraduireLeRefus({ descripteur, cleDeVolume });
  if (installation.demarree === false) return installation;
  const rendu = await booterLePaquet({ descripteur, prepare, cleDeVolume, reprendreParInstantane });
  if (rendu.demarree === false) return rendu;
  // Le manifeste SUIT ce que le guest a constaté, après un boot réussi et jamais avant.
  const manifesteSuivi = await suivreLeConstat({
    nom: NOM_DU_VOLUME_APPLICATIF,
    manifeste: prepare.manifeste,
    application: descripteur.application,
    constat: rendu.schema ?? null,
  });
  // `fermer` et `requeteHttp` sont des fonctions : retirées par DESTRUCTURATION, jamais par oubli,
  // car le compte rendu franchit le canal privilégié et `sansCapacite` les refuserait.
  const { fermer, requeteHttp, ...compte } = rendu;
  const miseAJourApplicative = {
    ...prepare.dephasage,
    jouee: prepare.miseAJour,
    manifeste: manifesteSuivi,
  };
  return {
    demarree: true,
    installation,
    fermer,
    requeteHttp,
    compte: { ...compte, miseAJourApplicative },
  };
}

/**
 * Ce que la PAGE apprend du déphasage, après le déverrouillage et avant tout boot (#236 T2) : la
 * décision publiée, que l'accueil montre — refus, ou bloc « Mettre à jour l'application ». Rien n'est
 * écrit, rien n'est booté ; le démarrage REDÉCIDE de lui-même, la page n'est pas crue.
 */
export async function dephasagePourLaPage() {
  const lu = await lireLeDescripteur();
  const { decision } = await constaterLeDephasage({ lu, nom: NOM_DU_VOLUME_APPLICATIF });
  return decisionPubliee(decision);
}

/**
 * BOOTE le paquet choisi, et traduit le REFUS du guest (#236 T2) en réponse typée plutôt qu'en
 * exception : un guest qui refuse de lancer Rails n'est pas une panne, c'est une décision dite.
 */
async function booterLePaquet({ descripteur, prepare, cleDeVolume, reprendreParInstantane }) {
  // Importé ICI et non à l'évaluation du Worker : il POSE la boucle d'ordonnancement de v86
  // (ADR 0013), qu'une coquille qui ne démarre rien n'a pas à porter.
  const { bootEtVerifier } = await import("../vm/boot-de-reference.mjs");
  try {
    return await bootEtVerifier({
      phase: "coquille",
      volume: NOM_DU_VOLUME_APPLICATIF,
      cmdline: prepare.cmdline,
      memoryBytes: descripteur.boot.memoireOctets,
      runtime: await adressesDuRuntime(descripteur),
      manifest: descripteurDeManifeste(descripteur),
      // Aucune ATTENTE d'invariant : la coquille publie le VERDICT de Rails, `tests/e2e/` l'asserte.
      expected: {},
      bootTimeoutMs: prepare.delaiMs,
      reprendreParInstantane,
      // ARME la capture, à la FERMETURE seulement (ADR 0024, décision 6).
      capturerInstantane: true,
      garderLaSessionOuverte: true,
      ouvrirLeVolumeDuGuest: ouvreurSousLEnveloppe({ cleDeVolume }),
      avantLeBoot: avantLeBootDuPaquet({ nom: NOM_DU_VOLUME_APPLICATIF, prepare }),
    });
  } catch (erreur) {
    const code = codeDuRefusDuGuest(erreur);
    if (code !== null) return refusDeDemarrage(code, prepare);
    // Un artefact du boot non acquis sur un volume jamais démarré : installation INACHEVÉE (#250).
    const inachevee = await echecDuPremierBoot(erreur, { nom: NOM_DU_VOLUME_APPLICATIF });
    if (inachevee !== null) return inachevee;
    throw erreur;
  }
}

/** Un démarrage REFUSÉ par le déphasage, avant ou pendant le boot : son code, son message, la décision. */
function refusDeDemarrage(code, prepare) {
  return { demarree: false, code, motif: messageDeRefus(code), dephasage: prepare.dephasage };
}
