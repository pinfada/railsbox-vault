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
import { openOpfsSyncAccess, statOpfsVolume } from "../vm/opfs-sync-access.mjs";
import { parseManifest } from "../vm/volume-manifest.mjs";

/**
 * La SIGNATURE d'une installation interrompue (#173), mesurée en rejouant une interruption sur le
 * double (`tests/unit/vm-dater-la-creation.test.mjs`, `tests/unit/coquille-application.test.mjs`) :
 * TROIS conditions, et les trois ensemble — aucun manifeste jamais inscrit (déjà le contexte de cet
 * appel : `constaterLInstallation` n'y arrive que dans ce cas), un volume de la taille EXACTE que le
 * descripteur annonce, et un journal de génération qui ne porte que la racine de naissance
 * (`constaterCreationSeule`). Manquer l'une ou l'autre rend « autre chose » : le refus reste tel
 * quel, sans geste proposé — écraser un volume dont on n'est pas SÛR qu'il vient d'une installation
 * interrompue serait la décision que #171 a justement retirée à la coquille.
 *
 * Le troisième pilier est aussi ce qui garantit qu'aucune DONNÉE n'est jamais écrasée : un volume sur
 * lequel un boot a validé une génération ne porte plus la seule racine de naissance (ADR 0037, note du
 * 19/09/2026). Une mesure qui LÈVE rend « autre chose », jamais une signature.
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
