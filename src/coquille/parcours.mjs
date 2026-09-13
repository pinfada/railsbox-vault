// Le PARCOURS GUIDÉ de la coquille (#193, ADR 0040) : un seul chemin, un écran à la fois.
//
// Ce module ne décide AUCUN geste. Les gestes — ouvrir, créer le moyen de récupération, démarrer,
// verrouiller, sauvegarder, restaurer, révoquer — sont ceux de `src/coquille/`, inchangés. Il décide
// deux choses seulement, et elles sont d'ORDRE :
//
//  - quel ÉCRAN montrer, d'après ce que la coquille a publié (le coffre, ses moyens) et l'étape que
//    la personne a atteinte ;
//  - où mène chaque geste réussi.
//
// Il est pur — ni DOM, ni stockage, ni horloge — pour être éprouvé sans navigateur, comme le reste du
// répertoire. La page (`public/coquille/parcours-de-la-page.mjs`) ne fait que l'appliquer.
//
// ## Où vit l'étape atteinte
//
// Dans l'URL (`?etape=N`), et nulle part ailleurs. Le verrouillage RECHARGE la coquille (ADR 0031) :
// sans trace, la personne reviendrait à l'étape 1 après chaque verrouillage. Un stockage du navigateur
// aurait tenu la trace, mais la coquille n'écrit dans aucun (`coquille-deverrouillage.test.mjs`), et
// un numéro d'étape n'a rien à y faire. L'URL survit au rechargement, se lit, et ne porte rien du
// coffre.
//
// ## Ce que l'écran ne fait jamais
//
// Il ne laisse pas avancer au-delà de l'étape 3 tant que le code de récupération n'est pas confirmé
// dans cette page (« sans lui, une phrase oubliée est un coffre perdu »). Un coffre ouvert sans moyen
// de récupération ramène toujours à l'étape 3.

import { DERIVATION_ERROR_CODES } from "../vm/derivation/derivation-errors.mjs";
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
  "sauvegarde",
  "restauration",
  "revocation",
  "continuer",
  "espace-de-travail",
]);

const ENVIRON_DEUX_MINUTES =
  "Le premier démarrage installe l'application : comptez environ deux minutes, parfois davantage " +
  "sur un appareil lent ou occupé. Les démarrages suivants sont plus courts. Pendant ce temps, " +
  "l'onglet peut sembler figé : ne le fermez pas. La progression s'affiche sous le bouton.";

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
      "sur « Confirmer mon code ».",
    blocs: ["confirmation"],
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
  verrouiller: ecran(5, {
    titre: "Verrouiller votre coffre",
    ceQuiVaSePasser:
      "Verrouiller arrête l'application, enregistre tout, et referme le coffre : plus rien n'est " +
      "lisible sans votre secret. La page se recharge ensuite. Le coffre se verrouille aussi tout seul " +
      "après un moment sans activité.",
    attendu: "Cliquez sur « Verrouiller mon coffre », puis rouvrez-le avec votre phrase.",
    attente: "Le verrouillage prend quelques secondes.",
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
    attente: "Le verrouillage prend quelques secondes.",
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
      "Corrigez le numéro de version sur votre feuille. Si vous avez révoqué votre code de " +
      "récupération, créez-en un nouveau.",
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

/** Les sous-états de l'étape 3, tenus en mémoire par la page, jamais ailleurs. */
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
 * @param {{ pointeur: number | null, coffre: string, moyens?: string[], aRecuperation?: boolean,
 *           sousEtatDuCode?: string, revocationFaite?: boolean, refus?: string | null }} observation
 * @returns {string} une clé de `ECRANS`
 */
export function ecranCourant({
  pointeur,
  coffre,
  moyens = [],
  aRecuperation = false,
  sousEtatDuCode = SOUS_ETATS_DU_CODE.annonce,
  revocationFaite = false,
  refus = null,
}) {
  // Une restauration COUPÉE se répare par le même geste (ADR 0039, décision 4) : l'écran qui la
  // montre est celui de la restauration, et non un refus sans issue.
  if (coffre === COFFRE.refuse)
    return refus === CODE_RESTAURATION_INTERROMPUE ? "restaurer" : "refuse";
  if (coffre === COFFRE.absent) return ecranSansCoffre(pointeur);
  if (coffre === COFFRE.verrouille) return ecranVerrouille(pointeur, moyens);
  if (coffre === COFFRE.ouvert) {
    return ecranOuvert({ pointeur, aRecuperation, sousEtatDuCode, revocationFaite });
  }
  return "chargement";
}

function ecranSansCoffre(pointeur) {
  if (pointeur === 7) return "restaurer";
  if (pointeur === 2) return "choisir";
  return "creer";
}

function ecranVerrouille(pointeur, moyens) {
  const ouvrableSansCode = moyens.includes("phrase") || moyens.includes("webauthn-prf");
  if (!ouvrableSansCode || pointeur === 8) return "recuperer";
  return "rouvrir";
}

function ecranOuvert({ pointeur, aRecuperation, sousEtatDuCode, revocationFaite }) {
  if (!aRecuperation || pointeur === 3) return `code-${sousEtatDuCode}`;
  const parEtape = {
    5: "verrouiller",
    6: "sauvegarder",
    7: "restaurer-ailleurs",
    8: "recuperer-preparer",
    9: revocationFaite ? "termine" : "revoquer",
  };
  return parEtape[pointeur] ?? "travailler";
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

/** Le titre de l'étape qui suit un écran, pour l'annoncer. `null` après la dernière. */
export function etapeSuivante(ecranId) {
  const rang = ECRANS[ecranId]?.etape ?? null;
  if (rang === null || rang >= ETAPES.length) return null;
  return ETAPES[rang];
}

/**
 * « Où suis-je » : les neuf étapes, chacune passée, en cours ou à venir, par rapport à l'écran montré.
 *
 * @param {string} ecranId
 * @returns {{ rang: number, titre: string, statut: "passee" | "en-cours" | "a-venir" }[]}
 */
export function ouSuisJe(ecranId) {
  const courante = ECRANS[ecranId]?.etape ?? 0;
  return ETAPES.map(({ rang, titre }) => ({
    rang,
    titre,
    statut: rang < courante ? "passee" : rang === courante ? "en-cours" : "a-venir",
  }));
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
      message: `Il manque des symboles : ${etat.symbolesLus} sur ${affichee.symbolesLus}.`,
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
    return {
      confirme: false,
      code: null,
      message:
        "Ce code est bien formé, mais ce n'est pas celui qui vient d'être affiché. Relisez votre " +
        "feuille : vous avez peut-être recopié un autre code. Si vous ne l'avez pas noté, cliquez sur " +
        "« Revoir mon code ».",
    };
  }
  return { confirme: true, code: null, message: "Code confirmé. Gardez bien votre feuille." };
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
  return (
    `Après votre clic, le coffre fait un calcul volontairement lent, pour qu'on ne puisse pas deviner ` +
    `votre phrase en essayant. Comptez ${duree} sur ce navigateur ; sur un appareil très occupé, ` +
    `cela peut aller jusqu'à une minute et demie. L'onglet peut sembler figé : ne le fermez pas.`
  );
}

/**
 * La PROGRESSION d'un démarrage, à partir de ce que la page a réellement observé : le temps écoulé et
 * les signes de vie envoyés par le coffre pendant le geste.
 *
 * @param {{ ecouleMs: number, signesDeVie: number }} observation
 */
export function progressionDuDemarrage({ ecouleMs, signesDeVie }) {
  const secondes = Math.max(0, Math.round(ecouleMs / 1000));
  const vie =
    signesDeVie > 0
      ? `Le coffre travaille : ${signesDeVie} signe(s) de vie reçu(s).`
      : "En attente du premier signe de vie du coffre.";
  return `Démarrage en cours depuis ${secondes} seconde(s), sur environ deux minutes. ${vie}`;
}
