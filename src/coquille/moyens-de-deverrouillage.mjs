// Les MOYENS que la coquille propose, d'après l'inventaire de l'enveloppe (#162, ADR 0029).
//
// « Un seul emplacement à la fois, choisi par le TYPE » : la coquille lit l'inventaire PUBLIC du
// fichier d'enveloppes — le canal auxiliaire assumé de l'[ADR 0020](../../docs/decisions/0020-enveloppe-de-cle.md),
// point 3 des limites — et n'offre que les moyens qui s'y trouvent. **Elle ne devine jamais.**
//
// ## Pourquoi lire l'inventaire plutôt que tout proposer
//
// Une coquille qui offrirait les trois moyens sans regarder ferait dériver une phrase pendant deux
// secondes sur un coffre qui n'a jamais eu d'emplacement `phrase`, pour finir sur
// `VAULT_ENVELOPPE_CLE_REFUSEE` — un refus qui dit « cette clé n'ouvre rien » là où la vérité est
// « ce moyen n'existe pas ici ». L'inventaire est en clair précisément pour que ce cas n'arrive
// pas : « le fichier porte en clair le type et les paramètres de chaque emplacement, précisément
// pour qu'un dérivateur puisse lire les siens AVANT de dériver quoi que ce soit »
// (`ouverture-par-enveloppe.mjs`).
//
// ## Le canal auxiliaire, assumé et borné
//
// Ce que l'inventaire révèle à qui lit le fichier : combien d'emplacements, et de quels types. Le
// choix est celui de l'ADR 0020, et l'ADR 0025 l'a réexaminé pour le type `recuperation` — « si le
// canal auxiliaire élargi devenait inacceptable, la sortie n'est pas de masquer le type : ce serait
// de ne pas créer d'emplacement de récupération sur ce volume ». Cette tranche ne l'élargit pas :
// elle lit ce qui est déjà lisible, DANS l'origine de confiance, et n'en fait rien franchir vers
// l'origine applicative — la réponse d'état du port restreint ne porte toujours que deux champs.

import { TEXTE_TROP_ANCIEN } from "./feuille-de-recuperation.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { TYPES_KEK, nomDuTypeKek } from "../vm/enveloppe/identite-enveloppe.mjs";

/**
 * Les trois moyens que CETTE coquille sait servir, et le nom sous lequel elle les désigne.
 *
 * Les noms sont ceux des types de l'ADR 0020, repris tels quels : `phrase`, `webauthn-prf`,
 * `recuperation`. Les renommer pour l'affichage aurait fait exister deux vocabulaires pour la même
 * chose, et un relevé d'épreuve n'aurait plus parlé la langue du fichier qu'il décrit.
 *
 * `harnais` (type 3) n'y est PAS, et c'est la décision 1 de l'ADR 0029 : le jeton de harnais quitte
 * le chemin de produit avec cette tranche. Une enveloppe qui n'aurait qu'un emplacement de ce type
 * est donc annoncée comme non servable, exactement comme un type venu du futur.
 */
export const MOYENS_SERVIS = Object.freeze({
  [TYPES_KEK.phrase]: Object.freeze({
    nom: "phrase",
    typeKek: TYPES_KEK.phrase,
    /**
     * Dérivée dans un Worker DÉDIÉ que la page crée (ADR 0029, décision 5 réécrite).
     *
     * Elle l'était dans le Worker de CONFIANCE, et c'était le mauvais fil : `argon2Vendu` appelle le
     * module WebAssembly de façon SYNCHRONE, si bien que le Worker de confiance ne dispatchait plus
     * aucun message pendant deux secondes — y compris la question d'état que la coquille relaie pour
     * le document applicatif. Du point de vue de ce module, la phrase se dérive donc là où la passkey
     * se dérive : hors du Worker de confiance, qui n'en reçoit qu'une `CryptoKey`.
     */
    derivePar: "page",
    libelle: "une phrase de déverrouillage",
  }),
  [TYPES_KEK["webauthn-prf"]]: Object.freeze({
    nom: "webauthn-prf",
    typeKek: TYPES_KEK["webauthn-prf"],
    /** `navigator.credentials` n'existe pas dans un Worker (ADR 0021, décision 5). */
    derivePar: "page",
    libelle: "une passkey",
  }),
  [TYPES_KEK.recuperation]: Object.freeze({
    nom: "recuperation",
    typeKek: TYPES_KEK.recuperation,
    derivePar: "worker",
    libelle: "un code de récupération",
  }),
});

/**
 * La BORNE que la coquille laisse à un geste de passkey, en millisecondes (#162, ADR 0029, déc. 6).
 *
 * `derivateur-webauthn-prf.mjs` en propose une d'une MINUTE — c'est le maximum que la spécification
 * WebAuthn suggère, et un maximum n'est pas une promesse. Une coquille qui l'adopterait resterait
 * MUETTE pendant soixante secondes quand aucun authentificateur ne répond, et une interface muette
 * pendant une minute est indiscernable d'un plantage : l'utilisateur ferme l'onglet avant le refus.
 *
 * Trente secondes, et le chiffre se justifie dans les deux sens : c'est largement de quoi toucher un
 * lecteur d'empreinte, taper un code, ou aller chercher une clé posée à côté de soi ; et c'est assez
 * court pour que le refus TYPÉ arrive pendant que l'utilisateur regarde encore l'écran. Au-delà, la
 * conduite est celle de l'ADR 0021 : `VAULT_DERIVATION_ANNULEE`, sans pénalité et sans compteur —
 * recommencer coûte exactement la même chose, et l'épreuve de #22 le mesure.
 *
 * La limite est écrite dans l'ADR : un authentificateur qu'on va chercher dans un tiroir dépassera
 * cette borne, et l'utilisateur devra recommencer.
 */
export const DELAI_PASSKEY_MS = 30000;

/**
 * La BORNE au-delà de laquelle la coquille tient le Worker de confiance pour MORT, en millisecondes.
 *
 * Elle ne sert pas à masquer une lenteur, et c'est un point sur lequel cette tranche s'est reprise.
 * Une première rédaction bornait la question d'état à deux cent cinquante millisecondes pour
 * survivre à une dérivation qui bloquait le fil du Worker : c'était traiter le symptôme. La famine
 * est levée à sa racine — la dérivation vit dans un Worker DÉDIÉ (décision 5 de l'ADR 0029) —, et ce
 * qui reste ici couvre autre chose : un Worker qui ne répond PLUS DU TOUT.
 *
 * Sans borne, une promesse en suspens ne se règle jamais : le `finally` qui relâche l'identifiant de
 * corrélation ne se déclenche pas, les trente-deux emplacements se remplissent, et le port restreint
 * se ferme pour de bon — exactement le déni de service que l'ADR 0028 déclare écarté. La première
 * rédaction l'avait corrigé pour le REJET, pas pour l'ABSENCE de réponse (constat 11 de la revue de
 * sécurité de la PR #167).
 *
 * Trente secondes : un ordre de grandeur au-dessus du plus long geste que ce canal porte — ouvrir
 * une enveloppe, ouvrir un volume, écrire et franchir une barrière —, et assez bas pour qu'un Worker
 * mort soit constaté du vivant de l'onglet. Au-delà, le refus est TYPÉ, jamais un silence.
 */
export const DELAI_WORKER_MORT_MS = 30000;

/**
 * La CADENCE du battement que le Worker de confiance émet pendant un geste long (#163, ADR 0030).
 *
 * Elle est un ordre de grandeur SOUS `DELAI_WORKER_MORT_MS`, et c'est tout ce qui la justifie : la
 * borne ne doit pas expirer sur une hésitation d'ordonnancement, et il faut plusieurs battements
 * manqués — six ici — avant qu'un Worker vivant soit pris pour mort. Une cadence proche de la borne
 * ferait dépendre le verdict d'un seul battement, donc du hasard d'un tour de boucle.
 *
 * Ce qu'elle ne rend pas plus lent : rien. Un battement est un message vide sur un canal qui n'en
 * porte aucun autre pendant ce temps-là.
 */
export const DELAI_BATTEMENT_MS = 5000;

/** Les noms des moyens servis, pour qu'un appelant n'ait pas à parcourir la table. */
export const NOMS_SERVIS = Object.freeze(
  Object.values(MOYENS_SERVIS)
    .map((moyen) => moyen.nom)
    .sort(),
);

/**
 * EXIGE une KEK opaque venue de la page, et rien d'autre.
 *
 * C'est la moitié ARRIVANTE de la dérogation à `sansCapacite` : `enveloppePrivilegiee` décide ce qui
 * a le droit de PARTIR, celle-ci ce qui a le droit d'ARRIVER, et une seule des deux laisserait le
 * canal ouvert dans le sens qu'elle ne garde pas.
 *
 * Elle vit ICI, et non dans `public/runtime-worker.mjs`, pour la raison qui gouverne tout ce
 * répertoire : ce qui est ici peut être MUTÉ et éprouvé sans démarrer un navigateur. Elle était
 * là-bas, et la revue de sécurité de la PR #167 l'a relevé — la garde n'avait ni épreuve ni mutant,
 * et l'ADR affirmait pourtant qu'elle ne faisait pas double emploi avec l'autre.
 *
 * Les DEUX conditions comptent, et se manquent différemment : un objet qui n'est pas une `CryptoKey`
 * n'est pas une clé du tout, et une `CryptoKey` EXTRACTIBLE est un secret que du code peut relire —
 * la laisser passer rendrait la dérogation aussi large que ce qu'elle prétend interdire.
 *
 * @param {unknown} kek
 * @returns {CryptoKey} la clé, telle quelle, si elle est admissible
 */
export function exigerKekDeLaPage(kek) {
  if (kek?.constructor?.name !== "CryptoKey") {
    throw refusDeLaKek(`ce n'est pas une CryptoKey (${kek?.constructor?.name ?? typeof kek})`);
  }
  if (kek.extractable !== false) {
    throw refusDeLaKek("cette CryptoKey est EXTRACTIBLE : ses octets se relisent");
  }
  return kek;
}

/** @param {string} quoi */
function refusDeLaKek(quoi) {
  const erreur = new Error(
    `Une passkey ou une phrase présente une CryptoKey NON EXTRACTIBLE, jamais des octets de clé : ${quoi}.`,
  );
  erreur.code = CODES_REFUS_COQUILLE.capaciteDansUnMessage;
  return erreur;
}

/** Le moyen servi qui porte ce nom, ou `null`. Aucune approximation, aucun repli. */
export function moyenParNom(nom) {
  return Object.values(MOYENS_SERVIS).find((moyen) => moyen.nom === nom) ?? null;
}

/**
 * Ce que la coquille propose, à partir de l'inventaire.
 *
 * Elle rend TROIS choses, et les trois sont nécessaires :
 *
 *  - `moyens` — ce qu'elle offre, dans l'ordre de l'enveloppe. Un type présent deux fois n'est
 *    offert qu'une : l'utilisateur choisit un MOYEN, pas un emplacement, et deux boutons « phrase »
 *    ne lui apprendraient rien qu'il puisse employer ;
 *  - `inconnus` — les types présents que cette coquille ne sert pas. Ils ne font pas échouer les
 *    autres (c'est la compatibilité du point 5 du contrat de #22), mais ils sont DITS : un coffre
 *    dont un moyen est illisible ici est un coffre dont l'utilisateur doit savoir quelque chose ;
 *  - `avertissement` — la phrase à afficher quand il y a des inconnus, ou `null`.
 *
 * Le champ de version s'appelle `versionEnveloppe` et non `version` : le corps d'un message du
 * contrat ne peut pas porter `version` sans recouvrir celle du CONTRAT, et `enveloppeDeMessage`
 * refuse désormais un corps qui essaierait.
 *
 * @param {{ emplacements: { typeKek: number, identifiantEmplacement: string }[],
 *           versionEnveloppe: number }} inventaire
 */
export function moyensProposes(inventaire) {
  const emplacements = inventaire?.emplacements ?? [];
  const moyens = [];
  const inconnus = [];
  const vus = new Set();
  for (const emplacement of emplacements) {
    const servi = MOYENS_SERVIS[emplacement.typeKek];
    if (servi === undefined) {
      inconnus.push(
        Object.freeze({
          typeKek: emplacement.typeKek,
          // Le NOM du type quand l'ADR 0020 en réserve un — `harnais` en est un —, `null` quand la
          // valeur ne désigne rien de connu. Les deux cas se disent différemment à l'utilisateur.
          nom: nomDuTypeKek(emplacement.typeKek),
        }),
      );
      continue;
    }
    if (vus.has(servi.nom)) continue;
    vus.add(servi.nom);
    moyens.push(
      Object.freeze({ ...servi, identifiantEmplacement: emplacement.identifiantEmplacement }),
    );
  }
  return Object.freeze({
    versionEnveloppe: inventaire?.versionEnveloppe ?? null,
    moyens: Object.freeze(moyens),
    inconnus: Object.freeze(inconnus),
    aUnMoyenDeRecuperation: vus.has("recuperation"),
    avertissement: inconnus.length === 0 ? null : TEXTE_TROP_ANCIEN,
  });
}
