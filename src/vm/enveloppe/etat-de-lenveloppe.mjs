// L'ÉTAT d'une enveloppe de clé : lire les deux pages, juger laquelle fait autorité, écrire (#21,
// ADR 0020 ; #148, ADR 0026).
//
// Ce module tient la moitié « support » de l'enveloppe, et `enveloppe-de-cle.mjs` en tient la moitié
// « opérations ». La frontière est nette : ici, on ne fabrique aucun emplacement et on ne scelle
// aucune racine ; on lit des octets, on décide de quel état ils portent, et on en pose.
//
// Trois choses vivent ici, et les trois sont des règles de CONDUITE plutôt que de cryptographie :
//
//  1. **la précédence des refus** — les deux pages sont jugées, et le refus rendu est le plus
//     ÉTABLI des deux, jamais le premier venu ;
//  2. **la règle d'autorité et son repli** — la page la plus récente qui s'ouvre l'emporte, mais une
//     clé REFUSÉE sur la page courante n'autorise aucun repli : c'est le sens d'une révocation.
//     C'est la première des deux corrections trouvées par exécution dans l'ADR 0020 ;
//  3. **l'ordre des écritures** — écrire TOUJOURS la page qui ne fait pas autorité, franchir la
//     barrière qui publie, puis seulement effacer la page qui vient d'être libérée.
//
// La séparation date de #148 : ajouter l'effacement de la page libre a porté `enveloppe-de-cle.mjs`
// au-delà du seuil d'alerte de `tests/unit/taille-des-fichiers.test.mjs`, et scinder tant que c'est
// un choix libre est exactement ce que ce cliquet demande. Aucune ligne n'a changé au passage :
// c'est un déplacement, et les épreuves de #21 le disent en restant vertes.

import {
  ENVELOPPE_ERROR_CODES,
  cleRefusee,
  enveloppeAbsente,
  enveloppeIllisible,
  isEnveloppeError,
  rejeu,
} from "./enveloppe-errors.mjs";
import {
  PAGES,
  PAGE_OCTETS,
  TAILLE_FICHIER_ENVELOPPE,
  decoderPage,
  offsetDePage,
} from "./fichier-enveloppe.mjs";
import { developper, ouvrirRacine } from "./modele-reference.mjs";
import { cleDOuvertureDeRacine } from "./cle-de-racine.mjs";
import { EMPLACEMENT_FORMAT_V1, ENVELOPPE_FORMAT_V2 } from "./identite-enveloppe.mjs";

/** Précédence des refus : le plus ÉTABLI l'emporte sur le moins établi. Voir l'ADR 0020. */
const PRECEDENCE = Object.freeze([
  ENVELOPPE_ERROR_CODES.identite,
  ENVELOPPE_ERROR_CODES.melange,
  ENVELOPPE_ERROR_CODES.troncature,
  ENVELOPPE_ERROR_CODES.racineRefusee,
  ENVELOPPE_ERROR_CODES.cleRefusee,
  ENVELOPPE_ERROR_CODES.illisible,
]);

/**
 * Retient le refus le plus établi parmi ceux qu'ont produits les deux pages.
 *
 * Sans cette règle, une page abîmée masquerait le diagnostic de l'autre selon l'ordre de lecture —
 * c'est-à-dire selon rien. `identite` et `melange` disent quelque chose du FICHIER ; `cleRefusee` ne
 * dit rien de plus que « pas avec cette clé ».
 */
function refusLePlusEtabli(refus) {
  for (const code of PRECEDENCE) {
    const trouve = refus.find((erreur) => isEnveloppeError(erreur, code));
    if (trouve !== undefined) return trouve;
  }
  return refus[0] ?? enveloppeIllisible();
}

/** Lit le fichier entier, ou refuse. Un fichier absent n'est PAS un fichier vide. */
export async function lireFichier(support, contexte) {
  const etat = await support.etat();
  if (!etat.present || etat.taille === 0) throw enveloppeAbsente(contexte);
  if (etat.taille < TAILLE_FICHIER_ENVELOPPE) {
    throw enveloppeIllisible({
      ...contexte,
      taille: etat.taille,
      attendu: TAILLE_FICHIER_ENVELOPPE,
    });
  }
  return support.lire(0, TAILLE_FICHIER_ENVELOPPE);
}

/**
 * Essaie TOUS les emplacements d'une page, sans court-circuit, et rend la DEK du premier qui ouvre.
 *
 * **Ce que l'absence de court-circuit achète, et ce qu'elle n'achète pas.** Elle n'achète PAS
 * l'indiscernabilité des deux refus : un échec parcourt la liste entière de toute façon, puisqu'il
 * n'y a jamais de correspondance. La campagne de mutation de l'ADR 0020 l'a établi en rétablissant
 * le court-circuit sans qu'aucune épreuve de refus ne bronche — la première rédaction de ce
 * commentaire se trompait.
 *
 * Elle achète ceci, qui est réel : **une ouverture qui RÉUSSIT coûte le même nombre d'appels, que
 * la clé occupe le premier ou le dernier emplacement.** Avec court-circuit, un succès au premier
 * coûterait un appel et un succès au huitième en coûterait huit ; le temps d'un déverrouillage
 * désignerait la clé employée, sur un fichier dont le nombre d'emplacements est public.
 *
 * Ce qui est mesuré est ce nombre d'appels (`vm-enveloppe-operations.test.mjs` compte les
 * invocations de `SubtleCrypto.decrypt`, à l'échec comme au succès) ; ce qui ne l'est pas est le
 * temps interne de WebCrypto, que ce dépôt ne prétend pas maîtriser.
 */
async function developperDansLaPage(page, kek) {
  let trouve = null;
  for (const emplacement of page.emplacements) {
    const dek = await developper({
      kek,
      emplacement: {
        identifiantVolume: page.identifiantVolume,
        identifiantEmplacement: emplacement.identifiantEmplacement,
        // La version de format d'un EMPLACEMENT ne suit pas celle de la page, et vaut toujours 1 :
        // voir `EMPLACEMENT_FORMAT_V1`. La faire suivre obligerait la migration d'une page v1 en v2
        // à réenvelopper la DEK sous CHAQUE clé de déverrouillage, alors qu'on n'en détient qu'une.
        formatVersion: EMPLACEMENT_FORMAT_V1,
        typeKek: emplacement.typeKek,
        parametres: emplacement.parametres,
      },
      scelle: {
        nonce: emplacement.nonce,
        chiffre: emplacement.dekEnveloppee,
        etiquette: emplacement.etiquette,
      },
    });
    if (dek !== null && trouve === null) {
      trouve = { dek, identifiantEmplacement: emplacement.identifiantEmplacement };
    }
  }
  return trouve;
}

/**
 * Ouvre UNE page : développe la DEK, puis vérifie la racine AVANT de rendre quoi que ce soit.
 *
 * L'ordre est le sujet de la décision 3 de l'ADR 0020. La DEK obtenue au premier temps ne sert qu'à
 * VÉRIFIER — elle n'est rendue qu'une fois la racine authentifiée, l'identité de volume confrontée,
 * le compte des emplacements confronté et l'empreinte de la suite ordonnée confrontée. Un fichier
 * réordonné, tronqué ou portant un emplacement d'un autre volume est donc refusé avant que la clé
 * du volume n'atteigne quoi que ce soit d'autre que la vérification.
 */
async function ouvrirPage(page, kek, identifiantVolume) {
  const trouve = await developperDansLaPage(page, kek);
  if (trouve === null) throw cleRefusee({ volume: identifiantVolume, version: page.version });

  // La clé de la RACINE dépend de la version de la page : la DEK elle-même en v1, une clé à usage
  // unique dérivée avec le sel que la page porte en v2. C'est `cle-de-racine.mjs` qui le sait, et
  // lui seul — voir son en-tête pour les deux domaines et pour l'ordre « authentifier, puis
  // classer » qui décide de l'identifiant employé.
  const cleRacine = await cleDOuvertureDeRacine({ dek: trouve.dek, page });
  await ouvrirRacine({
    cleDeRacine: cleRacine,
    entete: {
      identifiantVolume: page.identifiantVolume,
      formatVersion: page.formatVersion,
      version: page.version,
      nombreEmplacements: page.nombreEmplacements,
    },
    scelle: page.racine,
    emplacements: page.emplacements,
    attentes: { identifiantVolume, versionMinimale: null },
  });
  return Object.freeze({ ...trouve, version: page.version });
}

/**
 * Les pages STRUCTURELLEMENT valides, de la plus récente à la plus ancienne.
 *
 * Le classement se fait sur la version DÉCLARÉE, qui n'est pas encore authentifiée à ce stade. Ce
 * n'est pas un oubli : il n'existe aucun moyen de trier deux pages sans les lire, et l'autorité
 * qu'on leur accorde ici ne va pas plus loin que l'ORDRE DES ESSAIS. Une page qui mentirait sur sa
 * version serait essayée d'abord, puis refusée par son étiquette.
 *
 * L'égalité de version est départagée par l'index, pour que le résultat ne dépende jamais de
 * l'ordre de lecture. Deux pages de même version ne devraient pas exister — le compteur croît
 * strictement —, et un fichier qui en porterait deux est précisément le cas où l'on ne veut pas
 * d'un verdict tiré au sort.
 */
function pagesDeLaPlusRecente(octets) {
  const lues = [];
  for (let index = 0; index < PAGES; index += 1) {
    const lue = decoderPage(
      octets.subarray(offsetDePage(index), offsetDePage(index) + PAGE_OCTETS),
    );
    lues.push({ index, ...lue });
  }
  return refuserLaRetrogradation(
    lues
      .filter((lue) => lue.valide)
      .sort((a, b) => b.page.version - a.page.version || a.index - b.index),
  );
}

/**
 * REFUSE qu'une page **v1** fasse autorité AU-DESSUS d'une page **v2** (#182, T2b).
 *
 * ## Ce que cette règle refuse, et ce qu'elle ne touche pas
 *
 * Après la migration de page, le fichier porte les DEUX formats : la v2 en version N + 1, la v1 en
 * version N. C'est voulu — la v1 est le repli qui rend la migration sûre sous coupure, et la
 * mutation suivante l'écrasera. Le classement par version suffit donc au cas honnête.
 *
 * Il ne suffit PAS au cas hostile. Qui peut écrire dans l'origine de confiance peut composer une
 * page v1 portant une version ARBITRAIREMENT GRANDE et la recalculer sa somme de contrôle : elle
 * passerait devant la v2, et l'ouverture se ferait sous une racine scellée directement sous la DEK.
 * Le format serait rétrogradé par une écriture, sans décision, sans ADR et sans que rien ne le dise
 * — le mécanisme exact que l'ADR 0011 refuse pour le volume.
 *
 * La règle est donc : **une page v1 n'est candidate que si elle est STRICTEMENT PLUS ANCIENNE que
 * la plus récente des pages v2 valides.** Elle reste le repli qu'elle doit être, et elle cesse
 * d'être une autorité.
 *
 * ## Pourquoi elle n'écarte PAS la v1 dès qu'une v2 existe
 *
 * Parce que la sûreté de la migration en dépend. Une page v2 structurellement valide dont la racine
 * ne s'ouvrirait pas — un défaut de notre côté, ou une page forgée — rendrait alors le volume
 * INOUVRABLE, là où le repli sur la v1 le sauve. Entre « refuser un peu moins » et « risquer de
 * perdre le volume », l'ADR 0020 a déjà tranché une fois, et il tranche de même ici.
 */
function refuserLaRetrogradation(candidates) {
  const versionV2 = candidates
    .filter((candidate) => candidate.page.formatVersion >= ENVELOPPE_FORMAT_V2)
    .reduce((haute, candidate) => Math.max(haute, candidate.page.version), -1);
  if (versionV2 === -1) return candidates;
  return candidates.filter(
    (candidate) =>
      candidate.page.formatVersion >= ENVELOPPE_FORMAT_V2 || candidate.page.version < versionV2,
  );
}

/**
 * ÉTAT COMPLET de l'enveloppe : la page qui fait autorité, sa DEK, et l'index de la page libre.
 *
 * ## La règle de repli, et pourquoi elle n'est PAS « la page qui s'ouvre »
 *
 * La première écriture de ce module retenait, parmi les DEUX pages, celle de plus grande version qui
 * s'ouvrait sous la clé présentée. C'était faux, et l'épreuve
 * `vm-enveloppe-operations.test.mjs` l'a montré en trois lignes : après une révocation, la page
 * PRÉCÉDENTE porte toujours l'emplacement révoqué, elle est parfaitement valide, et la clé révoquée
 * l'ouvrait. **La révocation ne révoquait rien.** L'alternance de pages, qui donne l'atomicité,
 * conserve exprès l'état d'avant — et un déverrouillage qui accepte l'état d'avant annule toute
 * mutation de sécurité.
 *
 * La règle correcte distingue deux natures de refus sur la page la plus récente :
 *
 *  - **`VAULT_ENVELOPPE_CLE_REFUSEE`** — la page est cohérente et signée, la clé n'y a pas
 *    d'emplacement. C'est l'ÉTAT COURANT, et il dit non. Aucun repli : refuser ici est le sens même
 *    d'une révocation ;
 *  - **tout autre refus** — racine qui ne vérifie pas, liste tronquée, réordonnée, autre volume. La
 *    page n'est pas un état auquel on puisse se fier ; c'est ce qu'une coupure laisse derrière elle,
 *    et l'on retombe sur la page précédente. C'est là, et là seulement, que l'alternance opère.
 *
 * Ce que cette règle ne couvre PAS est écrit dans l'ADR 0020 : un adversaire qui EFFACE la page
 * courante fait retomber le lecteur sur la précédente, donc ressuscite une clé révoquée. Il faut un
 * ancrage monotone hors du fichier pour le refuser, et `versionMinimale` est le point où il se
 * branchera (#23). Sans ancrage, ce retour arrière n'est pas détecté, et le dire vaut mieux que de
 * laisser croire qu'une révocation résiste à qui peut écrire dans l'origine de confiance.
 */
export async function lireEtat({ support, identifiantVolume, kek, versionMinimale = null }) {
  const octets = await lireFichier(support, { volume: identifiantVolume });
  const candidates = pagesDeLaPlusRecente(octets);
  if (candidates.length === 0) throw enveloppeIllisible({ volume: identifiantVolume });

  const refus = [];
  for (const candidate of candidates) {
    let ouverte;
    try {
      ouverte = await ouvrirPage(candidate.page, kek, identifiantVolume);
    } catch (cause) {
      if (!isEnveloppeError(cause)) throw cause;
      // Une clé qui n'ouvre pas l'état COURANT est refusée là, sans repli : voir ci-dessus.
      if (isEnveloppeError(cause, ENVELOPPE_ERROR_CODES.cleRefusee)) throw cause;
      refus.push(cause);
      continue;
    }
    if (versionMinimale !== null && ouverte.version < versionMinimale) {
      throw rejeu({ version: ouverte.version, minimale: versionMinimale });
    }
    return Object.freeze({
      index: candidate.index,
      page: candidate.page,
      ...ouverte,
      pageLibre: PAGES - 1 - candidate.index,
    });
  }
  throw refusLePlusEtabli(refus);
}

/**
 * PUBLIE une page : elle est écrite là où elle ne fait pas autorité, puis la barrière la publie.
 *
 * L'ordre n'est pas une commodité. Écrire la page qui fait autorité détruirait l'état courant avant
 * que le nouveau ne soit durable, et une coupure ne laisserait alors NI l'un NI l'autre — l'état que
 * #21 interdit.
 */
export async function publier(support, index, octets) {
  await support.ecrire(offsetDePage(index), octets);
  await support.barriere();
}

/**
 * EFFACE la page qui vient de perdre l'autorité : huit mille cent quatre-vingt-douze zéros, puis
 * une seconde barrière (#148, #156, ADR 0026).
 *
 * ## Ce que l'ordre achète, rang par rang
 *
 * L'appel vient APRÈS `publier`, jamais avant, et cet ordre est la décision :
 *
 *  - **avant la première barrière**, une coupure laisse la page ancienne intacte et autoritaire.
 *    Rien ne change à la matrice de coupures : l'enveloppe porte tous les emplacements, ou le seul
 *    retenu, jamais un sous-ensemble ;
 *  - **après la première barrière**, la page neuve est complète et durable. La page ancienne n'est
 *    plus un point de reprise, et l'effacer ne retire donc aucune protection. Une coupure PENDANT
 *    l'effacement laisse une page déchirée que `lireEtat` écarte déjà par sa somme de contrôle et sa
 *    racine, au profit de la neuve.
 *
 * ## Ce qu'il ne promet PAS, et le mot est choisi
 *
 * La promesse porte sur le FICHIER tel que le produit le relit, pas sur le support. Un système de
 * fichiers à copie sur écriture, un SSD qui remappe ses blocs, un instantané pris entre les deux
 * barrières peuvent conserver les anciens octets sans que rien ici ne puisse l'empêcher ni même
 * l'observer. C'est un « fait, non garanti », dans les termes de la décision 7 de l'ADR 0021, et
 * `SECURITY.md` le porte dans sa liste « non couvert » sous cette forme.
 */
export async function effacerLaPageLiberee(support, index) {
  await support.ecrire(offsetDePage(index), new Uint8Array(PAGE_OCTETS));
  await support.barriere();
}
