// Le PARCOURS GUIDÉ de la coquille (#193, ADR 0040) : un seul chemin, un écran à la fois.
//
// Ce module ne décide AUCUN geste. Les gestes — ouvrir, créer le moyen de récupération, démarrer,
// verrouiller, sauvegarder, restaurer, révoquer — sont ceux de `src/coquille/`, inchangés. Il décide
// des choses d'ORDRE seulement :
//
//  - quel ÉCRAN montrer, d'après ce que la coquille a publié (le coffre, ses moyens), la PROGRESSION
//    de la personne et le moteur ;
//  - où mène chaque geste réussi, et ce que la progression en retient ;
//  - ce que la page DIT : chaque texte montré à la personne est ici, et nulle part ailleurs, pour que
//    la page de relecture (`tools/relecture-parcours.mjs`) le reproduise sans dériver.
//
// Il est pur — ni DOM, ni stockage, ni horloge — pour être éprouvé sans navigateur, comme le reste du
// répertoire. La page (`public/coquille/parcours-de-la-page.mjs`) ne fait que l'appliquer.
//
// ## Où vit la progression (revue de la PR #213, constats 1 et 2)
//
// Dans un petit fichier de l'OPFS de l'origine de confiance, `parcours.json`, que la page lit au
// chargement et réécrit à chaque pas. Il porte l'étape atteinte, d'où vient le coffre (créé ici ou
// restauré), et trois faits sur le code de récupération : rendu ou non, sa version, confirmé ou non.
// JAMAIS le code : `ecrireProgression` ne recopie que ces champs, un par un.
//
// L'URL (`?etape=N`) seule ne suffisait pas. Elle se réécrit à la main : `?etape=4` sautait la
// confirmation. Et un rechargement à l'étape 3 perdait le fait « un code a été rendu » : le parcours
// en faisait créer un SECOND, que le geste ne sait pas ouvrir (#214). Désormais l'URL ne fait que
// DEMANDER une étape, et `etapeAdmise` la ramène à l'étape atteinte. `localStorage` a été écarté : il
// est synchrone, lisible par tout script de l'origine sans API de fichier, et la coquille s'interdit
// d'y écrire (`coquille-deverrouillage.test.mjs`).
//
// ## Ce que l'ordre protège, et ce qu'il ne protège pas
//
// Il protège la personne contre sa propre perte : on n'avance pas au-delà de l'étape 3 tant que le
// code n'est pas CONFIRMÉ — recopié juste depuis la feuille affichée, ou ouvrant le coffre. Il ne
// protège pas contre quelqu'un qui tient le navigateur : le fichier se réécrit, et les gardes de
// sécurité restent dans les gestes du Worker de confiance.

import { DERIVATION_ERROR_CODES } from "../vm/derivation/derivation-errors.mjs";
import { SYMBOLES_TOTAL } from "../vm/derivation/code-de-recuperation.mjs";
import { conduiteHumaine } from "./conduites-du-parcours.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { VERDICTS, etatDeLaSaisie } from "./saisie-du-code.mjs";

const CODE_RESTAURATION_INTERROMPUE = CODES_REFUS_COQUILLE.restaurationInterrompue;

/**
 * Les refus d'INVENTAIRE : ceux que le Worker rend avant tout geste, et qui disent que le coffre de
 * cet appareil ne s'ouvre pas ici (ADR 0039, décisions 4 et 8).
 */
export const REFUS_D_INVENTAIRE = Object.freeze([
  CODES_REFUS_COQUILLE.coffreAnterieur,
  CODES_REFUS_COQUILLE.disqueDUnAutreCoffre,
  CODES_REFUS_COQUILLE.coffreServiSansManifeste,
  CODES_REFUS_COQUILLE.restaurationInterrompue,
]);

/** Les neuf étapes de la Definition of Ready de #193, dans l'ordre. */
export const ETAPES = Object.freeze([
  Object.freeze({ rang: 1, titre: "Créer votre coffre" }),
  Object.freeze({ rang: 2, titre: "Choisir comment l'ouvrir" }),
  Object.freeze({ rang: 3, titre: "Recevoir et confirmer votre code de récupération" }),
  Object.freeze({ rang: 4, titre: "Travailler dans l'application" }),
  Object.freeze({ rang: 5, titre: "Verrouiller et rouvrir" }),
  Object.freeze({ rang: 6, titre: "Sauvegarder votre coffre" }),
  Object.freeze({ rang: 7, titre: "Restaurer sur un autre appareil" }),
  Object.freeze({ rang: 8, titre: "Récupérer votre coffre avec le code" }),
  Object.freeze({ rang: 9, titre: "Révoquer en urgence" }),
]);

/** Les états du coffre tels que le parcours les distingue. */
export const COFFRE = Object.freeze({
  inconnu: "inconnu",
  absent: "absent",
  verrouille: "verrouille",
  ouvert: "ouvert",
  refuse: "refuse",
});

/**
 * Les BLOCS de gestes que la page porte, chacun marqué `data-bloc` dans `public/index.html`. Un écran
 * n'en montre que quelques-uns ; l'ordre du document est celui du parcours, donc l'ordre du focus.
 */
export const BLOCS = Object.freeze([
  "commencer",
  "ancre",
  "phrase",
  "passkey",
  "perdu",
  "code",
  "feuille-annonce",
  "feuille",
  "confirmation",
  "application",
  "verrouiller",
  "espace-de-travail",
  "sauvegarde",
  "restauration",
  "revocation",
  "continuer",
]);

/**
 * Ce que les blocs portent de VISIBLE : leurs boutons et leurs champs, tels que `public/index.html`
 * les nomme (ou que la page les renomme). La page de relecture les liste ; une épreuve relit qu'ils
 * sont bien ceux du document.
 */
export const LIBELLES_DES_BLOCS = Object.freeze({
  commencer: ["« Commencer »", "« J'ai déjà une sauvegarde »"],
  ancre: ["« Numéro de version noté sur votre feuille (facultatif) » (champ)"],
  phrase: ["« Votre phrase » (champ)", "« Créer mon coffre » ou « Ouvrir mon coffre »"],
  passkey: ["« Créer mon coffre avec une passkey » ou « Ouvrir mon coffre avec ma passkey »"],
  perdu: ["« J'ai oublié ma phrase : utiliser mon code de récupération »"],
  code: ["« Code de récupération » (champ)", "« Ouvrir mon coffre avec le code »"],
  "feuille-annonce": ["« Afficher mon code de récupération »"],
  feuille: ["« J'ai recopié mon code »"],
  confirmation: [
    "« Code recopié depuis votre feuille » (champ)",
    "« Confirmer mon code »",
    "« Revoir mon code »",
  ],
  application: [
    "« Démarrer l'application »",
    "« Reprendre l'installation » (seulement si une installation a été interrompue)",
  ],
  verrouiller: ["« Verrouiller mon coffre »"],
  "espace-de-travail": ["l'application elle-même, une fois démarrée"],
  sauvegarde: ["« Sauvegarder mon coffre »", "« Enregistrer la sauvegarde » (lien)"],
  restauration: [
    "« Fichier de sauvegarde » (champ)",
    "« Restaurer ma sauvegarde sur cet appareil »",
  ],
  revocation: ["« Révoquer tous les autres moyens d'ouvrir ce coffre »"],
  continuer: ["« Continuer : » suivi du titre de l'étape suivante"],
});

const ENVIRON_DEUX_MINUTES =
  "Le premier démarrage installe l'application : comptez environ deux minutes, parfois davantage " +
  "sur un appareil lent ou occupé. Les démarrages suivants sont plus courts. Pendant ce temps, " +
  "l'onglet peut sembler figé : ne le fermez pas. La progression s'affiche sous le bouton.";

const QUELQUES_SECONDES_DE_VERROUILLAGE = "Le verrouillage prend quelques secondes.";

/**
 * La limite de Firefox, dite AVANT toute attente (revue de la PR #213, constat 9 ; ADR 0038) : sous
 * ce moteur, la machine qui porte l'application tourne environ six fois plus lentement, et son
 * démarrage n'a jamais abouti.
 */
export const LIMITE_DE_FIREFOX =
  "Dans cette version de RailsBox Vault, l'application ne démarre pas dans Firefox : elle y " +
  "fonctionne environ six fois plus lentement, et son démarrage n'a jamais abouti. Pour travailler " +
  "dans l'application, utilisez Chrome ou Edge récents.";

/**
 * Ce qu'une personne fait d'un code perdu, tant que remplacer un code n'existe pas (#214). Le coffre
 * est encore vide à l'étape 3 : l'abandonner ne coûte rien, et la conduite dit COMMENT.
 */
const SI_LE_CODE_EST_PERDU =
  "Si vous n'avez pas recopié ce code et que vous n'avez encore rien mis dans ce coffre, " +
  "abandonnez-le et recommencez : dans les réglages du navigateur, effacez les données de ce site, " +
  "rechargez la page, puis créez un nouveau coffre. Remplacer un code perdu n'est pas encore " +
  "possible. Si vous avez déjà mis des données dans ce coffre, n'effacez rien et demandez de l'aide.";

const UN_CODE_A_DEJA_ETE_RENDU =
  "Un code de récupération a déjà été affiché pour ce coffre. Il ne sera plus jamais affiché, et " +
  "RailsBox Vault n'en crée pas un second. Pour continuer, ouvrez votre coffre avec ce code, en le " +
  "lisant sur votre feuille : c'est ainsi que l'on vérifie que votre feuille est juste.";

/**
 * Les écrans. Chacun porte son étape, un titre, ce qui va se passer, ce qui est attendu, l'attente
 * annoncée AVANT le geste quand il dure (`null` sinon), et les blocs qu'il montre.
 */
export const ECRANS = Object.freeze({
  chargement: ecran(null, {
    titre: "Préparation",
    ceQuiVaSePasser: "RailsBox Vault vérifie ce que cet appareil contient déjà.",
    attendu: "Rien : patientez quelques secondes.",
    blocs: [],
  }),
  refuse: ecran(1, {
    titre: "Ce coffre ne peut pas être ouvert ici",
    ceQuiVaSePasser:
      "RailsBox Vault a trouvé sur cet appareil un coffre qu'il ne peut pas ouvrir. Rien n'a été " +
      "modifié. Lisez le message ci-dessous : il dit quoi faire.",
    attendu: "Suivez les indications du message.",
    blocs: [],
  }),
  creer: ecran(1, {
    titre: "Créer votre coffre",
    ceQuiVaSePasser:
      "Votre coffre garde une application et ses données sur cet appareil, dans ce navigateur, " +
      "protégées par un secret que vous seul connaissez. Personne d'autre — pas même les auteurs de " +
      "RailsBox Vault — ne peut l'ouvrir à votre place.",
    attendu:
      "Cliquez sur « Commencer ». Si vous avez déjà une sauvegarde d'un coffre, choisissez plutôt « " +
      "J'ai déjà une sauvegarde ».",
    blocs: ["commencer"],
  }),
  choisir: ecran(2, {
    titre: "Choisir comment l'ouvrir",
    ceQuiVaSePasser:
      "Vous choisissez le secret qui ouvrira votre coffre. Le plus simple est une phrase : plusieurs " +
      "mots, faciles à retenir pour vous et difficiles à deviner pour les autres. Le coffre est créé " +
      "dès que vous cliquez.",
    attendu: "Tapez votre phrase, puis cliquez sur « Créer mon coffre ».",
    blocs: ["phrase", "passkey"],
  }),
  "code-annonce": ecran(3, {
    titre: "Recevoir votre code de récupération",
    ceQuiVaSePasser:
      "Si vous oubliez votre phrase, seul un code de récupération pourra rouvrir votre coffre. Sans " +
      "lui, une phrase oubliée est un coffre perdu, et personne ne peut vous aider. Ce code ne " +
      "s'affichera QU'UNE SEULE FOIS : préparez une feuille de papier et un stylo avant de cliquer.",
    attendu: "Quand vous êtes prêt à écrire, cliquez sur « Afficher mon code de récupération ».",
    blocs: ["feuille-annonce"],
  }),
  "code-feuille": ecran(3, {
    titre: "Recopier votre code de récupération",
    ceQuiVaSePasser:
      "Voici votre code. Il ne sera plus jamais affiché, et rien sur cet appareil n'en garde de copie. " +
      "Recopiez-le à la main, avec le numéro de version, et rangez la feuille ailleurs que près de " +
      "cet appareil.",
    attendu:
      "Recopiez le code et le numéro de version, puis cliquez sur « J'ai recopié mon code ».",
    blocs: ["feuille"],
  }),
  "code-confirmation": ecran(3, {
    titre: "Confirmer votre code de récupération",
    ceQuiVaSePasser:
      "Le code n'est plus affiché. Pour être sûr que votre feuille est juste, retapez-le en le lisant " +
      "sur votre papier. Vous ne pourrez pas continuer tant qu'il n'est pas confirmé.",
    attendu:
      "Tapez les 28 symboles de votre feuille (les tirets et les espaces sont libres), puis cliquez " +
      "sur « Confirmer mon code ». Vous pouvez aussi appuyer sur Entrée.",
    blocs: ["confirmation"],
  }),
  "code-verifier": ecran(3, {
    titre: "Vérifier votre code de récupération",
    ceQuiVaSePasser: UN_CODE_A_DEJA_ETE_RENDU,
    attendu:
      "Tapez le code de votre feuille, puis cliquez sur « Ouvrir mon coffre avec le code ». " +
      SI_LE_CODE_EST_PERDU,
    blocs: ["code"],
  }),
  "code-a-verifier": ecran(3, {
    titre: "Vérifier votre code de récupération",
    ceQuiVaSePasser: UN_CODE_A_DEJA_ETE_RENDU,
    attendu:
      "Cliquez sur « Verrouiller mon coffre », puis ouvrez-le avec le code de votre feuille. " +
      SI_LE_CODE_EST_PERDU,
    attente: QUELQUES_SECONDES_DE_VERROUILLAGE,
    blocs: ["verrouiller"],
  }),
  travailler: ecran(4, {
    titre: "Travailler dans l'application",
    ceQuiVaSePasser:
      "L'application s'exécute entièrement dans votre navigateur. Ce que vous y écrivez est enregistré " +
      "dans votre coffre, sur cet appareil.",
    attendu:
      "Cliquez sur « Démarrer l'application », attendez qu'elle s'affiche, puis utilisez-la. Quand " +
      "vous avez fini, passez à l'étape suivante.",
    attente: ENVIRON_DEUX_MINUTES,
    blocs: ["application", "espace-de-travail", "continuer"],
  }),
  "travailler-sans-application": ecran(4, {
    titre: "Travailler dans l'application",
    ceQuiVaSePasser: LIMITE_DE_FIREFOX,
    attendu:
      "Ouvrez RailsBox Vault dans Chrome ou Edge récents et créez-y votre coffre. Le coffre créé dans " +
      "ce navigateur-ci est encore vide : vous pouvez l'abandonner en effaçant les données de ce site " +
      "dans les réglages du navigateur.",
    blocs: [],
  }),
  verrouiller: ecran(5, {
    titre: "Verrouiller votre coffre",
    ceQuiVaSePasser:
      "Verrouiller arrête l'application, enregistre tout, et referme le coffre : plus rien n'est " +
      "lisible sans votre secret. La page se recharge ensuite. Le coffre se verrouille aussi tout seul " +
      "après un moment sans activité.",
    attendu: "Cliquez sur « Verrouiller mon coffre », puis rouvrez-le avec votre phrase.",
    attente: QUELQUES_SECONDES_DE_VERROUILLAGE,
    blocs: ["verrouiller", "espace-de-travail"],
  }),
  rouvrir: ecran(5, {
    titre: "Rouvrir votre coffre",
    ceQuiVaSePasser:
      "Votre coffre est verrouillé. Il s'ouvre avec la phrase que vous avez choisie. Si vous avez " +
      "noté un numéro de version sur votre feuille, tapez-le : il empêche qu'on vous rende une copie " +
      "plus ancienne de votre coffre sans que vous le sachiez.",
    attendu: "Tapez votre phrase, puis cliquez sur « Ouvrir mon coffre ».",
    blocs: ["ancre", "phrase", "passkey", "perdu"],
  }),
  sauvegarder: ecran(6, {
    titre: "Sauvegarder votre coffre",
    ceQuiVaSePasser:
      "Une sauvegarde est un fichier qui contient tout votre coffre, toujours protégé. L'application " +
      "est arrêtée le temps de la sauvegarde. Le fichier est enregistré par votre navigateur, comme " +
      "un téléchargement : gardez-en une copie ailleurs que sur cet appareil (clé USB, autre " +
      "ordinateur).",
    attendu:
      "Cliquez sur « Sauvegarder mon coffre ». Si le navigateur ne l'enregistre pas tout seul, " +
      "cliquez sur « Enregistrer la sauvegarde ».",
    attente:
      "La sauvegarde prend de quelques secondes à quelques minutes, selon la taille du coffre et " +
      "l'appareil. Ne fermez pas l'onglet.",
    blocs: ["sauvegarde", "continuer"],
  }),
  "restaurer-ailleurs": ecran(7, {
    titre: "Restaurer sur un autre appareil",
    ceQuiVaSePasser:
      "Votre sauvegarde permet de retrouver votre coffre sur un autre appareil, dans un autre " +
      "navigateur ou à une autre adresse. Il s'y ouvrira avec votre code de récupération. On ne " +
      "restaure jamais par-dessus un coffre existant : faites-le là où il n'y en a pas encore.",
    attendu:
      "Sur l'autre appareil, ouvrez RailsBox Vault, choisissez « J'ai déjà une sauvegarde » et donnez " +
      "le fichier. Pour continuer ici, cliquez sur le bouton ci-dessous.",
    blocs: ["continuer"],
  }),
  restaurer: ecran(7, {
    titre: "Restaurer une sauvegarde",
    ceQuiVaSePasser:
      "Le coffre contenu dans la sauvegarde est recopié sur cet appareil, puis vérifié. Rien n'est " +
      "écrit si le fichier est abîmé. Le coffre restauré s'ouvre ensuite avec votre code de " +
      "récupération.",
    attendu:
      "Choisissez le fichier de sauvegarde, puis cliquez sur « Restaurer ma sauvegarde sur cet " +
      "appareil ».",
    attente:
      "La restauration prend de quelques secondes à quelques minutes, selon la taille du coffre et " +
      "l'appareil. Ne fermez pas l'onglet.",
    blocs: ["restauration"],
  }),
  "recuperer-preparer": ecran(8, {
    titre: "Récupérer votre coffre avec le code",
    ceQuiVaSePasser:
      "Si vous avez oublié votre phrase, le code de récupération rouvre votre coffre. Pour vous " +
      "entraîner, verrouillez d'abord le coffre : vous le rouvrirez avec le code.",
    attendu: "Cliquez sur « Verrouiller mon coffre ».",
    attente: QUELQUES_SECONDES_DE_VERROUILLAGE,
    blocs: ["verrouiller"],
  }),
  recuperer: ecran(8, {
    titre: "Récupérer votre coffre avec le code",
    ceQuiVaSePasser:
      "Le code de récupération de votre feuille rouvre votre coffre, même sans la phrase. Le numéro " +
      "de version noté à côté du code protège contre une copie plus ancienne : tapez-le aussi.",
    attendu:
      "Tapez le numéro de version et le code de votre feuille, puis cliquez sur « Ouvrir mon coffre " +
      "avec le code ».",
    blocs: ["ancre", "code"],
  }),
  revoquer: ecran(9, {
    titre: "Révoquer en urgence",
    ceQuiVaSePasser:
      "Si vous pensez que quelqu'un connaît votre phrase ou a trouvé votre feuille, révoquez : tout " +
      "ce qui ouvre ce coffre est retiré, SAUF le moyen que vous venez d'utiliser. Attention : les " +
      "sauvegardes déjà faites restent ouvrables par les anciens moyens. Détruisez-les si elles " +
      "risquent de tomber entre de mauvaises mains, puis faites une nouvelle sauvegarde.",
    attendu:
      "Seulement si c'est nécessaire : cliquez sur « Révoquer tous les autres moyens d'ouvrir ce " +
      "coffre ». Notez ensuite le nouveau numéro de version sur votre feuille.",
    blocs: ["revocation"],
  }),
  termine: ecran(9, {
    titre: "Parcours terminé",
    ceQuiVaSePasser:
      "Seul le moyen que vous avez utilisé pour ouvrir ce coffre l'ouvre désormais. Les sauvegardes " +
      "déjà faites restent ouvrables par les anciens moyens : détruisez-les si elles risquent de " +
      "tomber entre de mauvaises mains, puis faites une nouvelle sauvegarde.",
    attendu:
      "Notez sur votre feuille le numéro de version indiqué ci-dessus. Il n'y a rien d'autre à faire.",
    blocs: [],
  }),
});

/** @param {number | null} rang */
function ecran(rang, { titre, ceQuiVaSePasser, attendu, attente = null, blocs }) {
  return Object.freeze({
    etape: rang,
    titre,
    ceQuiVaSePasser,
    attendu,
    attente,
    blocs: Object.freeze([...blocs]),
  });
}

/**
 * Les MESSAGES que la page écrit en plus des écrans : réussites, attentes en cours, consignes. Ceux
 * qui portent une valeur sont des fonctions ; la page de relecture les appelle avec « N ».
 */
export const MESSAGES = Object.freeze({
  rang: (rang) => `Étape ${rang} sur ${ETAPES.length}`,
  attendu: (texte) => `Ce que vous avez à faire : ${texte}`,
  duree: (texte) => `Durée : ${texte}`,
  suivante: (titre) => `Étape suivante : ${titre}.`,
  continuer: (titre) => (titre === null ? "Continuer" : `Continuer : ${titre}`),
  passkeyALaCreation:
    "Ce navigateur connaît les passkeys (empreinte, visage, code de l'appareil ou clé de " +
    "sécurité). Toutes ne savent pas protéger un coffre : si la vôtre ne le sait pas, RailsBox " +
    "Vault vous le dira, et vous pourrez utiliser une phrase.",
  passkeyALOuverture: "Ce coffre s'ouvre aussi avec votre passkey.",
  consigneDeLaFeuille: (version) =>
    `Numéro de version à noter à côté du code : ${version}. Recopiez les 7 groupes de 4 symboles ` +
    `exactement. Ce code ne sera plus jamais affiché.`,
  recopieIncomplete: (lus, total) => `Il manque des symboles : ${lus} sur ${total}.`,
  recopieDUnAutreCode:
    "Ce code est bien formé, mais ce n'est pas celui qui vient d'être affiché. Relisez votre " +
    "feuille : vous avez peut-être recopié un autre code. Si vous ne l'avez pas noté, cliquez sur « " +
    "Revoir mon code ».",
  codeConfirme: "Code confirmé. Gardez bien votre feuille, loin de cet appareil.",
  saisieIncomplete: (lus, total) => `${lus} symbole(s) sur ${total}.`,
  saisieComplete: "Code complet : aucune faute de recopie détectée.",
  coffreOuvert: "Votre coffre est ouvert.",
  ouvertureEnCours: "Ouverture en cours… Ne fermez pas l'onglet.",
  verrouillageEnCours: "Verrouillage en cours… Ne fermez pas l'onglet.",
  repriseEnCours: "Reprise de l'installation en cours… Ne fermez pas l'onglet.",
  sauvegardeEnCours: "Sauvegarde en cours… Ne fermez pas l'onglet.",
  restaurationEnCours: "Restauration en cours… Ne fermez pas l'onglet.",
  applicationDemarree: "L'application est démarrée : elle s'affiche ci-dessous.",
  demarrageEnCours: (secondes, vie) =>
    `Démarrage en cours depuis ${secondes} seconde(s), sur environ deux minutes. ${vie}`,
  signesDeVie: (nombre) => `Le coffre travaille : ${nombre} signe(s) de vie reçu(s).`,
  premierSigneDeVie: "En attente du premier signe de vie du coffre.",
  sauvegardePrete:
    "Sauvegarde prête. Votre navigateur l'enregistre sous le nom « coffre.rbvault » ; si rien ne " +
    "s'est enregistré, cliquez sur « Enregistrer la sauvegarde ». Pensez à redémarrer " +
    "l'application si vous voulez continuer à l'utiliser.",
  restauree: "Sauvegarde restaurée et vérifiée. Ouvrez maintenant le coffre avec votre code.",
  revoque: (nombre, version) =>
    `${nombre} moyen(s) retiré(s). Nouveau numéro de version à noter sur votre feuille : ${version}.`,
  revoqueSansRien:
    "Aucun autre moyen n'ouvrait ce coffre : rien n'a été retiré, et votre feuille reste juste.",
  codeMasque: "(code masqué)",
});

/** Ce que « Où suis-je ? » dit de chaque étape. */
export const STATUTS = Object.freeze({
  passee: "étape précédente",
  "en-cours": "vous êtes ici",
  "a-venir": "à venir",
  "non-jouee": "non jouée sur cet appareil : le coffre y a été restauré",
});

/** D'où vient le coffre de cet appareil, pour le parcours. */
export const ORIGINES_DU_COFFRE = Object.freeze({
  creation: "creation",
  restauration: "restauration",
});

/** Le fichier OPFS de la progression, à la racine de l'origine de confiance. */
export const FICHIER_DE_PROGRESSION = "parcours.json";

/** La progression d'une personne qui n'a encore rien fait. */
export const PROGRESSION_INITIALE = figerProgression({
  version: 1,
  etapeAtteinte: 1,
  origine: ORIGINES_DU_COFFRE.creation,
  code: { rendu: false, version: null, confirme: false },
});

function figerProgression({ etapeAtteinte, origine, code }) {
  return Object.freeze({
    version: 1,
    etapeAtteinte,
    origine,
    code: Object.freeze({ rendu: code.rendu, version: code.version, confirme: code.confirme }),
  });
}

/**
 * Relit la progression écrite. Tout ce qui n'a pas EXACTEMENT sa forme vaut la progression initiale :
 * un fichier abîmé ou réécrit à la main ne fait jamais sauter une étape.
 *
 * @param {string | null | undefined} texte
 */
export function lireProgression(texte) {
  let brut;
  try {
    brut = JSON.parse(String(texte ?? ""));
  } catch {
    return PROGRESSION_INITIALE;
  }
  if (!progressionBienFormee(brut)) return PROGRESSION_INITIALE;
  return figerProgression(brut);
}

function progressionBienFormee(brut) {
  if (brut === null || typeof brut !== "object" || Array.isArray(brut)) return false;
  if (Object.keys(brut).sort().join(",") !== "code,etapeAtteinte,origine,version") return false;
  const { version, etapeAtteinte, origine, code } = brut;
  if (version !== 1 || !Number.isInteger(etapeAtteinte) || etapeAtteinte < 1) return false;
  if (etapeAtteinte > ETAPES.length || !Object.values(ORIGINES_DU_COFFRE).includes(origine)) {
    return false;
  }
  if (code === null || typeof code !== "object") return false;
  if (Object.keys(code).sort().join(",") !== "confirme,rendu,version") return false;
  const versionAdmise =
    code.version === null || (Number.isInteger(code.version) && code.version > 0);
  return typeof code.rendu === "boolean" && typeof code.confirme === "boolean" && versionAdmise;
}

/** Le texte écrit dans `parcours.json` : les champs, un par un, et rien d'autre. */
export function ecrireProgression(progression) {
  return JSON.stringify(figerProgression(progression));
}

/**
 * Ce qu'un pas du parcours change à la progression. Rend une NOUVELLE progression.
 *
 * @param {object} progression
 * @param {"etape" | "coffre-cree" | "code-rendu" | "code-confirme" | "restauree"} evenement
 * @param {number | null} [valeur] l'étape (`etape`) ou la version du code (`code-rendu`)
 */
export function progressionApres(progression, evenement, valeur = null) {
  if (evenement === "etape") {
    const etapeAtteinte = Math.max(progression.etapeAtteinte, valeur);
    return figerProgression({ ...progression, etapeAtteinte });
  }
  // Un coffre NEUF n'hérite de rien : ni d'une confirmation, ni d'un code d'un coffre abandonné.
  if (evenement === "coffre-cree")
    return figerProgression({ ...PROGRESSION_INITIALE, etapeAtteinte: 3 });
  if (evenement === "code-rendu") {
    return figerProgression({
      ...progression,
      code: { rendu: true, version: valeur, confirme: false },
    });
  }
  if (evenement === "code-confirme") {
    return figerProgression({
      ...progression,
      etapeAtteinte: Math.max(progression.etapeAtteinte, 4),
      code: { ...progression.code, rendu: true, confirme: true },
    });
  }
  if (evenement === "restauree") {
    return figerProgression({
      ...PROGRESSION_INITIALE,
      origine: ORIGINES_DU_COFFRE.restauration,
      etapeAtteinte: 8,
    });
  }
  throw new Error(`Événement de progression inconnu : ${evenement}`);
}

/**
 * L'étape que la page admet : celle que l'URL DEMANDE, jamais au-delà de celle que la personne a
 * atteinte. Sans demande, la personne reprend là où elle en était.
 *
 * @param {number | null} demandee
 * @param {{ etapeAtteinte: number }} progression
 */
export function etapeAdmise(demandee, progression) {
  if (demandee === null) return progression.etapeAtteinte;
  return Math.min(demandee, progression.etapeAtteinte);
}

/**
 * L'état du coffre, lu de ce que la coquille a PUBLIÉ : l'état du relevé, la ligne des moyens et le
 * relevé de l'interface de déverrouillage. Rien n'est demandé au Worker pour le savoir.
 *
 * @param {{ etat?: string | null, texteDesMoyens?: string | null, moyensProposes?: string[],
 *           dernierRefus?: string | null }} releves
 * @returns {string} une valeur de `COFFRE`
 */
export function coffreObserve({
  etat = null,
  texteDesMoyens = "",
  moyensProposes = [],
  dernierRefus = null,
}) {
  if (etat === "ouvert") return COFFRE.ouvert;
  const texte = String(texteDesMoyens ?? "").trim();
  if (texte === "") return COFFRE.inconnu;
  // La ligne que `rafraichirLInventaire` écrit pour un refus d'inventaire, et elle seule.
  if (REFUS_D_INVENTAIRE.includes(dernierRefus) && texte.startsWith("Ce coffre ne peut pas")) {
    return COFFRE.refuse;
  }
  if (moyensProposes.length > 0) return COFFRE.verrouille;
  return COFFRE.absent;
}

/** Les sous-états de l'étape 3 quand la feuille est affichée DANS CETTE PAGE. */
export const SOUS_ETATS_DU_CODE = Object.freeze({
  annonce: "annonce",
  feuille: "feuille",
  confirmation: "confirmation",
});

/**
 * Lit le numéro d'étape de l'URL. Tout ce qui n'est pas un entier de 1 à 9 vaut « aucune étape ».
 *
 * @param {string | null | undefined} texte
 * @returns {number | null}
 */
export function etapeDeLURL(texte) {
  if (typeof texte !== "string" || !/^[1-9]$/.test(texte)) return null;
  return Number(texte);
}

/**
 * L'ÉCRAN à montrer. C'est la seule fonction qui choisit, et elle ne choisit que parmi `ECRANS`.
 *
 * @param {{ pointeur: number | null, coffre: string, moyens?: string[], progression?: object,
 *           sousEtatDuCode?: string, revocationFaite?: boolean, refus?: string | null,
 *           moteur?: string }} observation
 * @returns {string} une clé de `ECRANS`
 */
export function ecranCourant({
  pointeur,
  coffre,
  moyens = [],
  progression = PROGRESSION_INITIALE,
  sousEtatDuCode = SOUS_ETATS_DU_CODE.annonce,
  revocationFaite = false,
  refus = null,
  moteur = "chromium",
}) {
  // Une restauration COUPÉE se répare par le même geste (ADR 0039, décision 4) : l'écran qui la
  // montre est celui de la restauration, et non un refus sans issue.
  if (coffre === COFFRE.refuse)
    return refus === CODE_RESTAURATION_INTERROMPUE ? "restaurer" : "refuse";
  if (coffre === COFFRE.absent) return ecranSansCoffre(pointeur);
  if (coffre === COFFRE.verrouille) return ecranVerrouille(pointeur, moyens, progression);
  if (coffre === COFFRE.ouvert) {
    const aRecuperation = moyens.includes("recuperation");
    const etat = { pointeur, aRecuperation, progression, sousEtatDuCode, revocationFaite, moteur };
    return ecranOuvert(etat);
  }
  return "chargement";
}

function ecranSansCoffre(pointeur) {
  if (pointeur === 7) return "restaurer";
  if (pointeur === 2) return "choisir";
  return "creer";
}

function ecranVerrouille(pointeur, moyens, progression) {
  const ouvrableSansCode = moyens.includes("phrase") || moyens.includes("webauthn-prf");
  if (!ouvrableSansCode) return "recuperer";
  // Un code a été rendu, et rien ne dit qu'il a été recopié juste : c'est lui qui rouvre.
  if (moyens.includes("recuperation") && !progression.code.confirme) return "code-verifier";
  if (pointeur === 8) return "recuperer";
  return "rouvrir";
}

function ecranOuvert({
  pointeur,
  aRecuperation,
  progression,
  sousEtatDuCode,
  revocationFaite,
  moteur,
}) {
  // Aucun moyen de récupération : le premier se crée ici. Ce n'est jamais un SECOND code (#214).
  if (!aRecuperation) return `code-${sousEtatDuCode}`;
  if (!progression.code.confirme) {
    // La feuille est dans cette page : on la recopie. Sinon, un code a été rendu ailleurs, ou avant
    // un rechargement : on le vérifie, on n'en crée pas un autre.
    if (sousEtatDuCode !== SOUS_ETATS_DU_CODE.annonce) return `code-${sousEtatDuCode}`;
    return "code-a-verifier";
  }
  const parEtape = {
    5: "verrouiller",
    6: "sauvegarder",
    7: "restaurer-ailleurs",
    8: "recuperer-preparer",
    9: revocationFaite ? "termine" : "revoquer",
  };
  const choisi = parEtape[pointeur] ?? "travailler";
  return choisi === "travailler" && moteur === "firefox" ? "travailler-sans-application" : choisi;
}

/**
 * Où mène un geste réussi, depuis un écran. Rend l'étape atteinte, ou `null` si le geste ne déplace
 * pas la personne.
 *
 * @param {string} ecranId
 * @param {string} evenement
 * @param {number | null} pointeur l'étape atteinte avant le geste
 * @returns {number | null}
 */
export function etapeApres(ecranId, evenement, pointeur) {
  const transitions = {
    "creer:commencer": 2,
    "creer:j-ai-une-sauvegarde": 7,
    "choisir:ouverture": 3,
    "code-confirmation:code-confirme": 4,
    "code-verifier:ouverture": 4,
    "travailler:continuer": 5,
    "rouvrir:ouverture": pointeur === 5 ? 6 : pointeur,
    "rouvrir:perdu": 8,
    "sauvegarder:continuer": 7,
    "restaurer-ailleurs:continuer": 8,
    "restaurer:restauree": 8,
    "recuperer:ouverture": 9,
  };
  const cible = transitions[`${ecranId}:${evenement}`];
  return cible === undefined ? null : cible;
}

/**
 * Ce qu'une ouverture réussie PROUVE du code : ouvert depuis un écran qui n'offre que le code, le
 * coffre a été ouvert par le code de la feuille, et la feuille est donc juste.
 */
export function ouvertureParLeCode(ecranId) {
  return ecranId === "code-verifier" || ecranId === "recuperer";
}

/** Le titre de l'étape qui suit un écran, pour l'annoncer. `null` après la dernière. */
export function etapeSuivante(ecranId) {
  const rang = ECRANS[ecranId]?.etape ?? null;
  if (rang === null || rang >= ETAPES.length) return null;
  return ETAPES[rang];
}

/**
 * « Où suis-je » : les neuf étapes, chacune passée, en cours, à venir — ou non jouée, pour un coffre
 * restauré dont les six premières étapes ont eu lieu ailleurs.
 *
 * @param {string} ecranId
 * @param {string} [origine]
 * @returns {{ rang: number, titre: string, statut: string }[]}
 */
export function ouSuisJe(ecranId, origine = ORIGINES_DU_COFFRE.creation) {
  const courante = ECRANS[ecranId]?.etape ?? 0;
  const restaure = origine === ORIGINES_DU_COFFRE.restauration;
  return ETAPES.map(({ rang, titre }) => {
    if (rang === courante) return { rang, titre, statut: "en-cours" };
    if (rang > courante) return { rang, titre, statut: "a-venir" };
    return { rang, titre, statut: restaure && rang < 7 ? "non-jouee" : "passee" };
  });
}

/**
 * Lit une LIGNE D'ÉTAT publiée par les gestes (`cycle:demarrage-refuse:VAULT_…`,
 * `portabilite:sauvegarde-prete:1024`, `coquille:worker-mort:silence`).
 *
 * @param {string | null | undefined} texte
 * @returns {{ famille: string, evenement: string, code: string | null, detail: string | null } | null}
 */
export function lireLigneDEtat(texte) {
  const brut = String(texte ?? "").trim();
  const morceaux = brut.split(":");
  if (morceaux.length < 2 || morceaux[0] === "" || morceaux[1] === "") return null;
  const [famille, evenement, ...reste] = morceaux;
  const detail = reste.length === 0 ? null : reste.join(":");
  const code = detail !== null && /^VAULT_[A-Z0-9_]+$/.test(detail) ? detail : null;
  return { famille, evenement, code, detail };
}

/**
 * Le code qu'une conduite technique porte à sa fin, entre parenthèses (`conduiteDeRefus`,
 * `conduiteDePortabilite`).
 *
 * @param {string | null | undefined} texte
 * @returns {string | null}
 */
export function codeEnFinDeTexte(texte) {
  const trouve = /\((VAULT_[A-Z0-9_]+)\)\s*$/.exec(String(texte ?? ""));
  return trouve === null ? null : trouve[1];
}

/**
 * Les boutons d'un GESTE LONG : un second clic pendant qu'il court perd le premier (#215). La page
 * les ferme tant qu'un geste est en cours ; `ouvrir-par-code` n'y est pas, l'interface le tient.
 */
export const GESTES_LONGS = Object.freeze([
  "ouvrir-par-phrase",
  "ouvrir-par-passkey",
  "creer-recuperation",
  "demarrer-application",
  "reprendre-l-installation",
  "verrouiller-le-coffre",
  "sauvegarder-le-coffre",
  "restaurer-le-coffre",
  "revoquer-en-urgence",
]);

/**
 * Un geste est-il EN COURS, d'après ce que les gestes publient ?
 *
 * @param {{ ligneDuCycle?: string | null, ligneDePortabilite?: string | null,
 *           attenteDuDeverrouillage?: string | null }} releves
 */
export function unGesteEstEnCours({
  ligneDuCycle = null,
  ligneDePortabilite = null,
  attenteDuDeverrouillage = null,
}) {
  const enCours = (texte) => lireLigneDEtat(texte)?.evenement.endsWith("-en-cours") === true;
  if (enCours(ligneDuCycle) || enCours(ligneDePortabilite)) return true;
  return String(attenteDuDeverrouillage ?? "").trim() !== "";
}

/**
 * Les refus du RELAIS qui méritent une alerte : seulement ceux comptés APRÈS qu'un démarrage a
 * abouti. Pendant le boot, le cadre montre sa page d'attente et ses requêtes refusées sont normales
 * (revue de la PR #213, constat 6) ; sans démarrage abouti, aucune.
 *
 * @param {{ comptes?: Record<string, number>, reference: Record<string, number> | null }} releves
 * @returns {string[]} les codes dont le compte a augmenté depuis la référence
 */
export function refusDeRelaisAAnnoncer({ comptes = {}, reference }) {
  if (reference === null) return [];
  return Object.entries(comptes)
    .filter(([code, compte]) => compte > (reference[code] ?? 0))
    .map(([code]) => code);
}

/** Un code de récupération tel que la feuille et la découpe l'écrivent : sept groupes de quatre. */
const CODE_EN_CLAIR = /[0-9A-Z]{4}(?:-[0-9A-Z]{4}){6}/g;

/**
 * Un texte que la page peut écrire : tout code de récupération en clair y est MASQUÉ. Aucun message
 * du parcours n'en porte ; cette fonction garde qu'aucun n'en portera (revue de la PR #213,
 * constat 3).
 *
 * @param {string} texte
 */
export function texteSansCode(texte) {
  return String(texte ?? "").replace(CODE_EN_CLAIR, MESSAGES.codeMasque);
}

/**
 * Ce que la région vive dit d'une saisie de code, à chaque frappe : un compte, jamais les symboles.
 * Relire le code à voix haute à chaque frappe le ferait entendre à qui est à côté.
 *
 * @param {{ symbolesLus: number, envoyable: boolean, code: string | null }} etat
 */
export function annonceDeLaSaisie({ symbolesLus, envoyable, code }) {
  if (symbolesLus === 0) return "";
  if (envoyable) return MESSAGES.saisieComplete;
  if (code !== null) return conduiteHumaine(code);
  return MESSAGES.saisieIncomplete(symbolesLus, SYMBOLES_TOTAL);
}

/**
 * Juge la RECOPIE du code : la saisie doit être complète, passer sa somme de contrôle, et être le code
 * qui vient d'être affiché. Les trois refus se disent différemment, parce qu'ils appellent trois
 * gestes différents.
 *
 * @param {string} saisie ce que la personne a tapé
 * @param {string} feuille le code tel qu'il a été affiché
 * @returns {{ confirme: boolean, code: string | null, message: string }}
 */
export function confirmerLaRecopie(saisie, feuille) {
  const etat = etatDeLaSaisie(saisie);
  // La feuille est lue par le MÊME lecteur que la saisie : une seule table de signes, une seule
  // découpe, et le nombre de symboles attendu est celui de la feuille elle-même.
  const affichee = etatDeLaSaisie(feuille);
  if (etat.verdict === VERDICTS.vide || etat.verdict === VERDICTS.incomplet) {
    return {
      confirme: false,
      code: null,
      message: MESSAGES.recopieIncomplete(etat.symbolesLus, affichee.symbolesLus),
    };
  }
  if (!etat.envoyable) {
    return {
      confirme: false,
      code: DERIVATION_ERROR_CODES.codeMalRecopie,
      message: conduiteHumaine(DERIVATION_ERROR_CODES.codeMalRecopie),
    };
  }
  if (etat.decoupe !== affichee.decoupe) {
    return { confirme: false, code: null, message: MESSAGES.recopieDUnAutreCode };
  }
  return { confirme: true, code: null, message: MESSAGES.codeConfirme };
}

/** Le texte de l'attente d'une phrase, pour une durée déjà dite (« moins d'une seconde »). */
export function texteDAttenteDeLaPhrase(duree) {
  return (
    `Après votre clic, le coffre fait un calcul volontairement lent, pour qu'on ne puisse pas deviner ` +
    `votre phrase en essayant. Comptez ${duree} sur ce navigateur ; sur un appareil très occupé, ` +
    `cela peut aller jusqu'à une minute et demie. L'onglet peut sembler figé : ne le fermez pas.`
  );
}

/**
 * L'attente d'une ouverture par phrase, dite AVANT le clic.
 *
 * @param {number} attenteMs l'attente annoncée par `annonceDAttente` pour ce navigateur
 */
export function attenteDeLaPhrase(attenteMs) {
  const duree =
    attenteMs >= 1000
      ? `environ ${Math.round(attenteMs / 1000)} seconde(s)`
      : "moins d'une seconde";
  return texteDAttenteDeLaPhrase(duree);
}

/**
 * La PROGRESSION d'un démarrage, à partir de ce que la page a réellement observé : le temps écoulé et
 * les signes de vie envoyés par le coffre pendant le geste.
 *
 * @param {{ ecouleMs: number, signesDeVie: number }} observation
 */
export function progressionDuDemarrage({ ecouleMs, signesDeVie }) {
  const secondes = Math.max(0, Math.round(ecouleMs / 1000));
  const vie = signesDeVie > 0 ? MESSAGES.signesDeVie(signesDeVie) : MESSAGES.premierSigneDeVie;
  return MESSAGES.demarrageEnCours(secondes, vie);
}
