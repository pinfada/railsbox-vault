// L'INSTALLATION INTERROMPUE, reconnue dès son PREMIER échec (#173 ; #250, ADR 0037 note du 19/09/2026).
//
// Scindé de `application-de-reference.mjs` (700 lignes, seuil d'alerte) : la SIGNATURE et la lecture
// du manifeste y vivaient ; elles viennent ici avec les deux constats neufs de #250.
//
// ## Ce que #250 a mesuré, contre l'hypothèse de l'issue
//
// La signature de l'ADR 0037 TIENT avec le versement qui saute les blocs nuls : une graine refusée
// (403), une graine gzip de 64 Mio, puis un verrouillage et une réouverture laissent un volume qui
// la porte (`tests/browser/coquille-installation-interrompue.spec.mjs`). Ce qui enfermait le coffre
// était ailleurs, et en trois endroits :
//
//  1. le PREMIER échec remontait NU — `applicationAbsente`, « aucune application n'est livrée » —
//     alors que l'origine en sert une ; la signature n'était mesurée qu'au démarrage SUIVANT ;
//  2. la page traduisait toute réponse « sans application » par cette même phrase, sans lire le code
//     ni la signature que la réponse portait ;
//  3. un échec d'ACQUISITION au premier boot (noyau, initrd, rootfs, paquet), sur un volume installé
//     et jamais démarré, remontait sans code : « l'opération a été refusée ».
//
// Ce module ne DÉCIDE d'aucun retrait : il MESURE, et rend un refus typé. Le seul geste qui écrase
// reste `reprendreSiSignatureConfirmee`, qui revérifie tout sous sa propre exclusivité.

import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { constaterCreationSeule } from "../vm/opfs-datation-de-creation.mjs";
import {
  engagementSidecarName,
  generationJournalName,
  instantaneSidecarName,
  openOpfsSyncAccess,
  statOpfsVolume,
  temoinSequenceName,
} from "../vm/opfs-sync-access.mjs";
import { ouvrirVolumeBrut } from "../vm/opfs-volume-brut.mjs";
import {
  EN_TETE_OCTETS,
  decoderEnTeteV4,
  dispositionDuVolume,
} from "../vm/volume-chiffre-format.mjs";
import { parseManifest } from "../vm/volume-manifest.mjs";

/**
 * La SIGNATURE d'une installation interrompue (#173, #264) : elle décide si « Reprendre
 * l'installation » est proposé. Or ce geste RETIRE le volume `application`, qui est le disque des
 * DONNÉES (`hdb` : la base SQLite et les pièces jointes, ADR 0041). Une signature vraie à tort
 * efface donc les données de l'utilisateur : chaque condition ci-dessous est là pour l'empêcher.
 *
 * Aucun manifeste n'a jamais été inscrit : c'est le contexte de l'appel, `constaterLInstallation` n'y
 * arrive que dans ce cas. Ensuite, DEUX chemins, selon le journal de génération.
 *
 * **Chemin 1, le journal porte des octets** (#173), mesuré en rejouant une interruption sur le double
 * (`tests/unit/vm-dater-la-creation.test.mjs`, `tests/unit/coquille-application.test.mjs`). Deux
 * conditions, ensemble :
 *  - le journal ne porte que la racine de naissance (`constaterCreationSeule`). C'est ce qui garantit
 *    qu'aucune donnée n'est écrasée : un boot qui a validé une génération y a laissé une autre racine
 *    (ADR 0037, note du 19/09/2026) ;
 *  - le volume déclare la taille EXACTE que le descripteur annonce.
 *
 * **Chemin 2, le journal est absent ou vide** (#264, `naissanceCoupeeAvantSaRacine`) : la naissance
 * a été coupée avant d'écrire sa racine. Six conditions, toutes ensemble :
 *  - l'engagement d'archive est absent ou vide ;
 *  - le témoin de séquence est absent ou vide ;
 *  - l'instantané de reprise est absent ou vide ;
 *  - l'en-tête v4 est lisible et déclare la taille annoncée par le descripteur ;
 *  - le fichier fait exactement la taille support que cette taille donne ;
 *  - la marque `VLTSEAL1` est ABSENTE.
 *
 * Il suffit qu'une condition manque pour rendre « autre chose ». Le refus reste alors tel quel, et
 * aucun geste n'est proposé : écraser un volume dont on n'est pas SÛR qu'il vient d'une installation
 * interrompue serait la décision que #171 a justement retirée à la coquille. Une mesure qui LÈVE rend
 * aussi « autre chose », jamais une signature.
 *
 * **Risque résiduel, chemin 2.** Aucun de ces états n'est authentifié : la marque est dans l'en-tête
 * en clair, à l'offset 64, et les voisins sont de simples fichiers. Un attaquant qui peut déjà écrire
 * dans l'OPFS de l'origine peut fabriquer TOUS ces états à la fois : vider le journal, l'engagement,
 * le témoin et l'instantané, puis effacer la marque. La coquille proposera alors « Reprendre » sur le
 * volume des données. La perte est la même que le `removeEntry` dont cet attaquant dispose déjà ; elle
 * est simplement déclenchée par un geste de l'interface. Seule une marque AUTHENTIFIÉE fermerait ce
 * chemin, et elle reste hors de la PR de #264
 * (`tests/unit/coquille-installation-interrompue.test.mjs`, « RISQUE RÉSIDUEL consigné »).
 *
 * @param {{ nom: string, octetsAnnonces: number, observer: Function, openHandle: Function,
 *           constaterCreation?: Function }} options
 * @returns {Promise<{ interrompue: boolean, motif: string | null, tailleLogique: number | null }>}
 */
export async function signatureDInstallationInterrompue({
  nom,
  octetsAnnonces,
  observer,
  openHandle,
  constaterCreation = constaterCreationSeule,
}) {
  if (await journalJamaisEcrit(nom, observer)) {
    return naissanceCoupeeAvantSaRacine({ nom, octetsAnnonces, observer, openHandle });
  }
  let creation;
  try {
    creation = await constaterCreation({ name: nom, openHandle, observer });
  } catch (erreur) {
    return {
      interrompue: false,
      motif: `la mesure du journal a échoué : ${erreur?.message ?? "cause inconnue"}`,
      tailleLogique: null,
    };
  }
  if (!creation.creationSeule) {
    return { interrompue: false, motif: creation.motif, tailleLogique: creation.tailleLogique };
  }
  if (creation.tailleLogique !== octetsAnnonces) {
    return {
      interrompue: false,
      motif:
        `le volume déclare ${creation.tailleLogique} octets, le descripteur en annonce ` +
        `${octetsAnnonces} : ce n'est pas CE volume-là`,
      tailleLogique: creation.tailleLogique,
    };
  }
  return { interrompue: true, motif: null, tailleLogique: creation.tailleLogique };
}

/** Le journal de génération est absent ou vide : aucune racine n'y a JAMAIS été écrite. */
async function journalJamaisEcrit(nom, observer) {
  const journal = await observer(generationJournalName(nom));
  return !journal.present || journal.size === 0;
}

/**
 * La NAISSANCE coupée avant sa racine initiale (#264) : un rechargement pendant le PREMIER démarrage,
 * mesuré par la recette QA du 03/10/2026 — volume alloué à sa taille, journal et engagement à 0 octet.
 *
 * La naissance alloue le fichier et pose son en-tête, retire les voisins orphelins (ce qui laisse
 * `.gen` et `.engagement` présents et VIDES), scelle chaque secteur — 19 s mesurés pour 512 Mio —,
 * écrit la racine initiale, puis pose la marque `VLTSEAL1` en DERNIER (`opfs-volume-ouverture.mjs`).
 * Une coupure pendant le scellement laisse donc un en-tête SANS marque. Or l'ouverture REFUSE tout
 * volume sans marque (`creationInachevee`) : aucun guest n'a pu y écrire, et le reprendre n'écrase rien.
 *
 * Les SIX conditions, ensemble, en plus du journal vide déjà constaté : un engagement vide (une
 * restauration en dépose un), un témoin et un instantané vides (`tracesDeService`), un en-tête v4
 * lisible qui déclare la taille annoncée par le descripteur, un fichier de la taille support exacte
 * que cette taille donne, et la marque ABSENTE. Un volume dont le journal a été vidé APRÈS sa
 * naissance porte la marque, et reste refusé. Si sa marque a aussi été effacée, le témoin qu'un boot
 * a écrit le fait encore refuser.
 */
async function naissanceCoupeeAvantSaRacine({ nom, octetsAnnonces, observer, openHandle }) {
  const engagement = await observer(engagementSidecarName(nom));
  if (engagement.present && engagement.size > 0) {
    return refusDeLaSignature("un engagement d'archive est déposé : ce n'est pas une naissance");
  }
  for (const trace of tracesDeService(nom)) {
    const voisin = await observer(trace);
    if (voisin.present && voisin.size > 0) {
      return refusDeLaSignature(`« ${trace} » porte des octets : ce volume a servi`);
    }
  }
  let lu;
  let tailleDuFichier;
  try {
    const brut = await ouvrirVolumeBrut({ name: nom, openHandle });
    try {
      lu = decoderEnTeteV4(await brut.read(0, EN_TETE_OCTETS));
      tailleDuFichier = brut.size();
    } finally {
      await brut.close();
    }
  } catch (erreur) {
    return refusDeLaSignature(
      `la lecture de l'en-tête a échoué : ${erreur?.message ?? "cause inconnue"}`,
    );
  }
  if (!lu.valide) return refusDeLaSignature(`aucun journal de génération, et ${lu.raison}`);
  const { tailleLogique, scellementComplet } = lu.enTete;
  if (tailleLogique !== octetsAnnonces) {
    return refusDeLaSignature(
      `le volume déclare ${tailleLogique} octets, le descripteur en annonce ` +
        `${octetsAnnonces} : ce n'est pas CE volume-là`,
      tailleLogique,
    );
  }
  if (tailleDuFichier !== dispositionDuVolume(octetsAnnonces).tailleSupport) {
    return refusDeLaSignature(
      `le fichier fait ${tailleDuFichier} octets, pas la taille support de ce volume`,
      tailleLogique,
    );
  }
  if (scellementComplet) {
    return refusDeLaSignature(
      "aucun journal de génération lisible, sur un volume dont la création s'est achevée",
      tailleLogique,
    );
  }
  return { interrompue: true, motif: null, tailleLogique };
}

/**
 * Les voisins qu'un volume qui a SERVI laisse non vides, et qu'une naissance coupée laisse vides : le
 * TÉMOIN de séquence, réécrit à chaque racine validée (`opfs-generation-voisins.mjs`), et l'INSTANTANÉ
 * de reprise, écrit à la fermeture d'une session (`instantane/support-opfs.mjs`). Les mêmes que les traces de
 * service de `portabilite-du-coffre.mjs`, dérivées des mêmes noms.
 *
 * VIDES, pas absents : la naissance les OUVRE pour en retirer un orphelin (`retirerVoisinsOrphelins`,
 * `opfs-volume-ouverture.mjs`), et `openOpfsSyncAccess` les crée alors à 0 octet, AVANT le scellement.
 * Exiger leur absence refuserait la naissance coupée elle-même, sur le vrai support.
 */
function tracesDeService(nom) {
  return [temoinSequenceName(nom), instantaneSidecarName(nom)];
}

function refusDeLaSignature(motif, tailleLogique = null) {
  return { interrompue: false, motif, tailleLogique };
}

/**
 * Rend `true` si le manifeste voisin est présent ET LISIBLE — un objet JSON que `parseManifest`
 * accepte, pas seulement un fichier non vide (#188, revue de sécurité, MEDIUM-2).
 *
 * Un manifeste est le DERNIER geste de `installerSiNecessaire` : une coupure pendant son écriture
 * laisse un sidecar tronqué, donc non vide, donc PRÉSENT au sens de `observer(...).size > 0` — le
 * seul critère que cette fonction employait avant cette correction. Le confondre avec « installée »
 * rendait « l'application est déjà installée : rien à reprendre » sur le volume dont la coupure est
 * la plus tardive, donc pas la moins probable — précisément le cas que #173 promet de réparer et
 * laissait dehors.
 */
export async function manifesteEstLisible(nom, lireLeManifeste) {
  let octets;
  try {
    octets = await lireLeManifeste(nom);
  } catch {
    return false;
  }
  if (octets === null) return false;
  try {
    parseManifest(octets);
    return true;
  } catch {
    return false;
  }
}

/**
 * TRADUIT l'échec d'ACQUISITION d'une installation COMMENCÉE (#250) : graine refusée, coupée,
 * tronquée, ou d'une empreinte fausse — les échecs sans code, et `applicationAbsente` que le
 * versement lève sur la troncature et l'empreinte.
 *
 * Un refus TYPÉ du support — la datation qui ne confirme pas la création (#181), un quota — n'est
 * PAS traduit : il nomme déjà ce qui s'est passé, et sa conduite existe. Le démarrage suivant le
 * reconnaîtra comme avant, par `constaterLInstallation`.
 *
 * Le volume a été CRÉÉ : l'échec laisse donc exactement ce que le démarrage suivant trouverait, et
 * c'est ce constat-là — le refus « sans manifeste », avec sa signature — qui est rendu TOUT DE SUITE,
 * au lieu de « aucune application n'est livrée ». La cause reste dans le message, pour le détail
 * technique. Un volume qui n'existe pas (l'échec est survenu avant sa création) n'a rien à
 * reconnaître : l'erreur d'origine remonte telle quelle.
 *
 * @param {{ erreur: unknown, nom: string, octets: number, observer: Function,
 *           openHandle: Function }} options
 * @returns {Promise<unknown>} l'erreur à lever
 */
export async function echecDInstallationReconnu({ erreur, nom, octets, observer, openHandle }) {
  const acquisition =
    erreur?.code === undefined || erreur?.code === CODES_REFUS_COQUILLE.applicationAbsente;
  if (!acquisition) return erreur;
  const volume = await observer(nom);
  if (!volume.present) return erreur;
  const signature = await signatureDInstallationInterrompue({
    nom,
    octetsAnnonces: octets,
    observer,
    openHandle,
  });
  return Object.assign(
    new Error(
      `L'installation du volume « ${nom} » n'a pas pu se terminer : ` +
        `${erreur?.message ?? "cause inconnue"}`,
    ),
    {
      code: CODES_REFUS_COQUILLE.volumeApplicatifSansManifeste,
      installationInterrompue: signature.interrompue,
      motifDeLaSignature: signature.motif,
      tailleDuVolume: volume.size,
    },
  );
}

/**
 * Le PREMIER boot d'une installation achevée a échoué SANS code (#250) : un artefact du boot — noyau,
 * initrd, rootfs, paquet — refusé, coupé ou d'une empreinte fausse. Le volume est-il resté tel que
 * l'installation l'a laissé, jamais démarré ?
 *
 * Le boot acquiert ses artefacts AVANT d'ouvrir le volume (`preparerLeBoot`) : un échec d'acquisition
 * le laisse intact, avec la seule racine de naissance que la datation a réécrite. Une mesure qui lève
 * rend `false` : ce n'est alors pas une installation inachevée qu'on reconnaît, et l'erreur d'origine
 * remonte.
 *
 * @param {{ nom: string, observer?: Function, openHandle?: Function,
 *           constaterCreation?: Function }} options
 */
export async function installationJamaisDemarree({
  nom,
  observer = statOpfsVolume,
  openHandle = openOpfsSyncAccess,
  constaterCreation = constaterCreationSeule,
}) {
  try {
    const constat = await constaterCreation({ name: nom, openHandle, observer });
    return constat.creationSeule === true;
  } catch {
    return false;
  }
}

/**
 * Ce que devient un démarrage dont un ARTEFACT n'a pas été acquis, sur un volume QUI A SERVI (#255) :
 * la réponse typée, ou `null` — l'erreur d'origine remonte alors telle quelle.
 *
 * Trois conditions, et les trois ensemble : l'échec n'a PAS de code ; il vient de l'ACQUISITION, que
 * `marquerLAcquisitionDesArtefacts` a marquée à sa source ; et le volume a DÉJÀ démarré. La réponse dit
 * l'adresse en défaut, les données intactes, et n'offre JAMAIS « Reprendre l'installation » — la garde
 * que le contrôle QA du 20/09/2026 a vérifiée, et qui doit rester tenue par ce chemin-ci comme par
 * l'ancien : ce qui manquait n'était pas la garde, c'étaient les mots.
 *
 * @param {unknown} erreur
 * @param {{ nom: string, jamaisDemarree?: typeof installationJamaisDemarree }} options
 */
export async function echecDUnArtefactDuDemarrage(
  erreur,
  { nom, jamaisDemarree = installationJamaisDemarree },
) {
  if (erreur?.code !== undefined || erreur?.artefactDuDemarrage !== true) return null;
  // Un volume JAMAIS démarré est l'affaire de #250 : là, il y a quelque chose à reprendre.
  if (await jamaisDemarree({ nom })) return null;
  return {
    demarree: false,
    code: CODES_REFUS_COQUILLE.artefactDuDemarrageRefuse,
    motif: `Un artefact du démarrage n'a pas pu être acquis : ${erreur?.message ?? "cause inconnue"}`,
    // JAMAIS une installation interrompue : c'est ce drapeau qui montre « Reprendre l'installation »,
    // et une reprise écraserait les données que ce volume porte (#250, garde).
    installationInterrompue: false,
  };
}

/**
 * Ce que devient un boot ÉCHOUÉ (#250) : la RÉPONSE d'une installation inachevée, ou `null` — l'erreur
 * d'origine remonte alors telle quelle.
 *
 * Deux conditions, et les deux ensemble : l'échec n'a PAS de code — un artefact du boot (noyau,
 * initrd, rootfs, paquet) refusé, coupé, d'une empreinte fausse ou trop grand ; un code typé, du
 * stockage ou de la fraîcheur, dit déjà ce qui s'est passé — ET le volume n'a jamais démarré. La
 * réponse dit l'installation inachevée, rien de perdu, et « Reprendre l'installation » redémarre : le
 * volume porte déjà son manifeste, et le Worker ne retire JAMAIS un volume identifié.
 *
 * @param {unknown} erreur
 * @param {{ nom: string, jamaisDemarree?: typeof installationJamaisDemarree }} options
 */
export async function echecDuPremierBoot(
  erreur,
  { nom, jamaisDemarree = installationJamaisDemarree },
) {
  if (erreur?.code !== undefined) return null;
  if (!(await jamaisDemarree({ nom }))) return null;
  return {
    demarree: false,
    code: CODES_REFUS_COQUILLE.installationInachevee,
    motif: `L'installation n'a pas pu se terminer : ${erreur?.message ?? "cause inconnue"}`,
    installationInterrompue: true,
    installee: true,
  };
}
