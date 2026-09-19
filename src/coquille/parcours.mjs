// Le PARCOURS GUIDÉ de la coquille (#193, ADR 0040) : un seul chemin, un écran à la fois.
//
// Ce module ne décide AUCUN geste. Les gestes — ouvrir, créer le moyen de récupération, démarrer,
// verrouiller, sauvegarder, restaurer, révoquer — sont ceux de `src/coquille/`, inchangés. Il décide
// des choses d'ORDRE seulement :
//
//  - quel ÉCRAN montrer, d'après ce que la coquille a publié (le coffre, ses moyens), la PROGRESSION
//    de la personne et le moteur ;
//  - où mène chaque geste réussi, et ce que la progression en retient ;
//  - quel TEXTE la page écrit : les textes eux-mêmes sont dans `textes-du-parcours.mjs`, réexportés
//    ici, pour que la page de relecture (`tools/relecture-parcours.mjs`) les reproduise sans dériver.
//
// Il est pur — ni DOM, ni stockage, ni horloge — pour être éprouvé sans navigateur, comme le reste du
// répertoire. La page (`public/coquille/parcours-de-la-page.mjs`) ne fait que l'appliquer.
//
// ## Où vit la progression (revue de la PR #213, constats 1 et 2)
//
// Dans un petit fichier de l'OPFS de l'origine de confiance, `parcours.json`, que la page lit au
// chargement et réécrit à chaque pas. Il porte l'étape atteinte, d'où vient le coffre (créé ici ou
// restauré), deux faits sur le code de récupération (rendu ou non, sa version), et deux INDICES :
// la feuille a-t-elle déjà été éprouvée, la visite est-elle finie. JAMAIS le code :
// `ecrireProgression` ne recopie que ces champs, un par un.
//
// L'URL (`?etape=N`) seule ne suffisait pas. Elle se réécrit à la main : `?etape=4` sautait la
// confirmation. Et un rechargement à l'étape 3 perdait le fait « un code a été rendu » : le parcours
// en faisait créer un SECOND, que le geste ne sait pas ouvrir (#214). Désormais l'URL ne fait que
// DEMANDER une étape, et `etapeAdmise` la ramène à l'étape atteinte. `localStorage` a été écarté : il
// est synchrone, lisible par tout script de l'origine sans API de fichier, et la coquille s'interdit
// d'y écrire (`coquille-deverrouillage.test.mjs`).
//
// ## Ce que l'ordre protège, et ce qu'il ne protège pas (#239)
//
// Il protège la personne contre sa propre perte : on n'avance pas au-delà de l'étape 3 tant que sa
// feuille n'est pas ÉPROUVÉE — tant que le Worker de confiance n'a pas constaté que son code OUVRE ce
// coffre (`preuve-de-la-feuille.mjs`, relevé `feuilleEprouvee`). Le fichier ne prouve rien : il est
// réinscriptible (VULN-04, amendement du 17/09/2026), et son indice ne choisit que le PREMIER
// formulaire d'un coffre verrouillé. L'ordre ne protège pas contre quelqu'un qui tient le
// navigateur : les gardes de sécurité restent dans les gestes du Worker de confiance.
//
// Il ne retient personne vers l'arrière : une ouverture de routine mène à l'application (étape 4),
// et chaque écran des étapes 5 à 9 offre d'y revenir. La VISITE (neuf étapes, une fois, vers
// l'avant) n'est pas l'USAGE (ouvrir, travailler, verrouiller, chaque jour).

import { conduiteHumaine } from "./conduites-du-parcours.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { GROUPES } from "./saisie-du-code.mjs";
import { ECRANS, ETAPES, MESSAGES, texteDAttenteDeLaPhrase } from "./textes-du-parcours.mjs";

export {
  ECRANS,
  ETAPES,
  LIBELLES_DE_LA_PAGE,
  LIBELLES_DES_BLOCS,
  LIMITE_DE_FIREFOX,
  MESSAGES,
  STATUTS,
  texteDAttenteDeLaPhrase,
} from "./textes-du-parcours.mjs";

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
  "feuille-revenir",
  "nouveau-code",
  "feuille",
  "revoir",
  "application",
  "verrouiller",
  "espace-de-travail",
  "sauvegarde",
  "restauration",
  "revocation",
  "sans-revoquer",
  "continuer",
  "retour",
]);

/** D'où vient le coffre de cet appareil, pour le parcours. */
export const ORIGINES_DU_COFFRE = Object.freeze({
  creation: "creation",
  restauration: "restauration",
});

/** Le fichier OPFS de la progression, à la racine de l'origine de confiance. */
export const FICHIER_DE_PROGRESSION = "parcours.json";

/** Le format de `parcours.json`. Le format 1 (avant #239) se relit ; seul le format 2 s'écrit. */
export const FORMAT_DE_PROGRESSION = 2;

/** La progression d'une personne qui n'a encore rien fait. */
export const PROGRESSION_INITIALE = figerProgression({
  etapeAtteinte: 1,
  origine: ORIGINES_DU_COFFRE.creation,
  code: { rendu: false, version: null },
  feuilleEprouvee: false,
  visiteTerminee: false,
});

function figerProgression({ etapeAtteinte, origine, code, feuilleEprouvee, visiteTerminee }) {
  return Object.freeze({
    version: FORMAT_DE_PROGRESSION,
    etapeAtteinte,
    origine,
    code: Object.freeze({ rendu: code.rendu, version: code.version }),
    feuilleEprouvee,
    visiteTerminee,
  });
}

/**
 * Relit la progression écrite. Tout ce qui n'a pas EXACTEMENT sa forme vaut la progression initiale :
 * un fichier abîmé revient au début. Même bien formé, il ne prouve rien du code : ses faits sur le
 * code sont remis à l'initiale (amendement du 17/09/2026, gardé), et `feuilleEprouvee` n'est qu'un
 * INDICE qui choisit un formulaire, jamais un écran de travail (#239).
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
  if (progressionDuFormat1(brut)) {
    // Un fichier d'avant #239 ne sait rien d'une feuille éprouvée : l'indice part à faux, et le
    // coffre demandera son code UNE fois, ce qui inscrira la preuve.
    return figerProgression({
      ...PROGRESSION_INITIALE,
      etapeAtteinte: brut.etapeAtteinte,
      origine: brut.origine,
    });
  }
  if (!progressionBienFormee(brut)) return PROGRESSION_INITIALE;
  return figerProgression({ ...brut, code: PROGRESSION_INITIALE.code });
}

function champsCommunsAdmis(brut, cles, version) {
  if (brut === null || typeof brut !== "object" || Array.isArray(brut)) return false;
  if (Object.keys(brut).sort().join(",") !== cles) return false;
  const { etapeAtteinte, origine, code } = brut;
  if (brut.version !== version || !Number.isInteger(etapeAtteinte) || etapeAtteinte < 1) {
    return false;
  }
  if (etapeAtteinte > ETAPES.length || !Object.values(ORIGINES_DU_COFFRE).includes(origine)) {
    return false;
  }
  if (code === null || typeof code !== "object" || Array.isArray(code)) return false;
  const versionAdmise =
    code.version === null || (Number.isInteger(code.version) && code.version > 0);
  return typeof code.rendu === "boolean" && versionAdmise;
}

function progressionDuFormat1(brut) {
  if (!champsCommunsAdmis(brut, "code,etapeAtteinte,origine,version", 1)) return false;
  const cles = Object.keys(brut.code).sort().join(",");
  return cles === "confirme,rendu,version" && typeof brut.code.confirme === "boolean";
}

function progressionBienFormee(brut) {
  const cles = "code,etapeAtteinte,feuilleEprouvee,origine,version,visiteTerminee";
  if (!champsCommunsAdmis(brut, cles, FORMAT_DE_PROGRESSION)) return false;
  if (Object.keys(brut.code).sort().join(",") !== "rendu,version") return false;
  return typeof brut.feuilleEprouvee === "boolean" && typeof brut.visiteTerminee === "boolean";
}

/** Le texte écrit dans `parcours.json` : les champs, un par un, et rien d'autre. */
export function ecrireProgression(progression) {
  return JSON.stringify(figerProgression(progression));
}

/**
 * Ce qu'un pas du parcours change à la progression. Rend une NOUVELLE progression.
 *
 * @param {object} progression
 * @param {"etape" | "coffre-cree" | "code-rendu" | "feuille" | "visite-terminee" | "restauree"} evenement
 * @param {number | boolean | null} [valeur] l'étape (`etape`), la version du code (`code-rendu`), ou
 *   ce que le Worker a constaté de la feuille (`feuille`)
 */
export function progressionApres(progression, evenement, valeur = null) {
  if (evenement === "etape") {
    const etapeAtteinte = Math.max(progression.etapeAtteinte, valeur);
    return figerProgression({ ...progression, etapeAtteinte });
  }
  // Un coffre NEUF n'hérite de rien : ni d'une feuille éprouvée, ni d'un code d'un coffre abandonné.
  if (evenement === "coffre-cree")
    return figerProgression({ ...PROGRESSION_INITIALE, etapeAtteinte: 3 });
  if (evenement === "code-rendu") {
    return figerProgression({ ...progression, code: { rendu: true, version: valeur } });
  }
  // Ce que le Worker a CONSTATÉ, recopié comme indice : vrai, la feuille a ouvert ce coffre ; faux,
  // aucune feuille présente ne l'a fait (retirée, ou jamais éprouvée). Éprouvée, elle ouvre l'étape 4.
  if (evenement === "feuille") {
    const feuilleEprouvee = valeur === true;
    return figerProgression({
      ...progression,
      feuilleEprouvee,
      etapeAtteinte: feuilleEprouvee
        ? Math.max(progression.etapeAtteinte, 4)
        : progression.etapeAtteinte,
    });
  }
  if (evenement === "visite-terminee") {
    return figerProgression({ ...progression, visiteTerminee: true });
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

/**
 * Les sous-états de l'étape 3 quand la feuille est affichée DANS CETTE PAGE : annoncée, affichée,
 * puis recopiée — le code est encore dans le document, et la personne peut le revoir tant qu'elle n'a
 * pas verrouillé (#239 : la confirmation EST une ouverture par le code, après verrouillage).
 */
export const SOUS_ETATS_DU_CODE = Object.freeze({
  annonce: "annonce",
  feuille: "feuille",
  recopie: "recopie",
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
 * `nombreDeCodes` est le COMPTE des feuilles que le coffre porte (#214). Sans lui, la ligne des
 * moyens dit seulement qu'il en existe une : c'est le repli, et il suffit à tout ce qui précède
 * l'étape 3.
 *
 * `feuilleEprouvee` est ce que le Worker de confiance a CONSTATÉ du coffre ouvert (#239) : un code
 * encore présent dans l'enveloppe l'a ouvert sur cet appareil. C'est la SEULE garde des écrans 4 à 9 ;
 * l'indice de `parcours.json` n'y entre pas.
 *
 * @param {{ pointeur: number | null, coffre: string, moyens?: string[], nombreDeCodes?: number,
 *           feuilleEprouvee?: boolean, progression?: object, sousEtatDuCode?: string,
 *           revocationFaite?: boolean, sansRevoquer?: boolean, phrasePerdue?: boolean,
 *           nouveauCodeDemande?: boolean, refus?: string | null, moteur?: string }} observation
 * @returns {string} une clé de `ECRANS`
 */
export function ecranCourant({
  pointeur,
  coffre,
  moyens = [],
  nombreDeCodes = moyens.includes("recuperation") ? 1 : 0,
  feuilleEprouvee = false,
  progression = PROGRESSION_INITIALE,
  sousEtatDuCode = SOUS_ETATS_DU_CODE.annonce,
  revocationFaite = false,
  sansRevoquer = false,
  phrasePerdue = false,
  nouveauCodeDemande = false,
  refus = null,
  moteur = "chromium",
}) {
  // Une restauration COUPÉE se répare par le même geste (ADR 0039, décision 4) : l'écran qui la
  // montre est celui de la restauration, et non un refus sans issue.
  if (coffre === COFFRE.refuse)
    return refus === CODE_RESTAURATION_INTERROMPUE ? "restaurer" : "refuse";
  if (coffre === COFFRE.absent) return ecranSansCoffre(pointeur);
  if (coffre === COFFRE.verrouille)
    return ecranVerrouille(pointeur, moyens, progression, nouveauCodeDemande, phrasePerdue);
  if (coffre === COFFRE.ouvert) {
    return ecranOuvert({
      pointeur,
      nombreDeCodes,
      feuilleEprouvee,
      progression,
      sousEtatDuCode,
      revocationFaite,
      sansRevoquer,
      nouveauCodeDemande,
      moteur,
    });
  }
  return "chargement";
}

function ecranSansCoffre(pointeur) {
  if (pointeur === 7) return "restaurer";
  if (pointeur === 2) return "choisir";
  return "creer";
}

function ecranVerrouille(pointeur, moyens, progression, nouveauCodeDemande, phrasePerdue) {
  const ouvrableSansCode = moyens.includes("phrase") || moyens.includes("webauthn-prf");
  if (!ouvrableSansCode) return "recuperer";
  // « J'ai oublié ma phrase » montre le formulaire du code SANS déplacer la visite (QA de #244) : ce
  // n'est pas l'étape 8, c'est une ouverture de routine par un autre moyen.
  if (pointeur === 8 || phrasePerdue) return "recuperer";
  // Le PREMIER formulaire d'un coffre verrouillé, choisi par l'indice (#239). Aucune feuille n'a
  // encore été éprouvée ici : c'est le code qui rouvre, et son ouverture inscrit la preuve. Sinon, la
  // phrase et la passkey. Un indice falsifié coûte au pire un détour d'un écran : ouvert par la
  // phrase, un coffre sans preuve retombe sur la vérification. « Je n'ai plus cette feuille » mène à
  // la phrase : un coffre VERROUILLÉ n'affiche aucun code (#214), et la demande ne survit pas à un
  // rechargement.
  if (moyens.includes("recuperation") && !progression.feuilleEprouvee && !nouveauCodeDemande) {
    return "code-verifier";
  }
  return "rouvrir";
}

function ecranOuvert({
  pointeur,
  nombreDeCodes,
  feuilleEprouvee,
  progression,
  sousEtatDuCode,
  revocationFaite,
  sansRevoquer,
  nouveauCodeDemande,
  moteur,
}) {
  // La feuille est DANS cette page : on la recopie, puis on verrouille pour l'éprouver.
  if (sousEtatDuCode === SOUS_ETATS_DU_CODE.feuille) return "code-feuille";
  if (sousEtatDuCode === SOUS_ETATS_DU_CODE.recopie && !feuilleEprouvee) {
    return "code-a-verrouiller";
  }
  // Aucun moyen de récupération, ou « Je n'ai plus cette feuille » : le code se crée à l'annonce.
  // L'annonce ne s'atteint pas autrement — c'est elle qui AJOUTE un emplacement, sur huit (#239).
  // Une feuille qui vient d'OUVRIR ce coffre vaut preuve : la demande tombe (contre-recette de #244).
  if (nombreDeCodes === 0 || (nouveauCodeDemande && !feuilleEprouvee)) return "code-annonce";
  // Un code a été rendu, et aucune feuille n'a encore ouvert ce coffre : on l'éprouve.
  if (!feuilleEprouvee) return "code-a-verifier";
  const parEtape = {
    5: "verrouiller",
    6: "sauvegarder",
    7: "restaurer-ailleurs",
    8: "recuperer-preparer",
    // L'étape 9 est FACULTATIVE (décision du 19/09/2026) : une visite ne détruit pas le moyen
    // d'ouverture quotidien de la personne.
    9: revocationFaite ? "termine" : sansRevoquer ? "termine-sans-revoquer" : "revoquer",
  };
  const choisi = parEtape[pointeur] ?? (progression.visiteTerminee ? "accueil" : "travailler");
  if (moteur === "firefox" && (choisi === "travailler" || choisi === "accueil")) {
    return "travailler-sans-application";
  }
  return choisi;
}

/** Les écrans qui montrent l'APPLICATION : l'étape 4 de la visite, et l'accueil d'après la visite. */
export const ECRANS_DE_L_APPLICATION = Object.freeze(["travailler", "accueil"]);

/** Les écrans d'où « Revenir à mon application » ramène à l'étape 4 : ceux des étapes 5 à 9. */
export const ECRANS_AVEC_RETOUR = Object.freeze([
  "verrouiller",
  "sauvegarder",
  "restaurer-ailleurs",
  "recuperer-preparer",
  "revoquer",
  "termine",
  "termine-sans-revoquer",
]);

/**
 * Où mène un geste réussi, depuis un écran. Rend l'étape atteinte, ou `null` si le geste ne déplace
 * pas la personne.
 *
 * Une ouverture de ROUTINE mène à l'application : l'étape 4. Seules trois ouvertures sont des
 * EXERCICES de la visite, et avancent : celle de l'étape 5 (verrouiller puis rouvrir), celle de
 * l'étape 8 (récupérer par le code) et, depuis l'étape 3, celle qui éprouve la feuille — qui mène à 4
 * elle aussi. « Continuer » depuis l'application mène à la prochaine étape NON jouée.
 *
 * @param {string} ecranId
 * @param {string} evenement
 * @param {number | null} pointeur l'étape montrée avant le geste
 * @param {number} [etapeAtteinte] la plus lointaine étape atteinte, pour « Continuer »
 * @returns {number | null}
 */
export function etapeApres(ecranId, evenement, pointeur, etapeAtteinte = 4) {
  if (evenement === "retour") return ECRANS_AVEC_RETOUR.includes(ecranId) ? 4 : null;
  const transitions = {
    "creer:commencer": 2,
    "creer:j-ai-une-sauvegarde": 7,
    "choisir:ouverture": 3,
    "code-verifier:ouverture": pointeur === 5 ? 6 : 4,
    "travailler:continuer": prochaineEtapeNonJouee(etapeAtteinte),
    "rouvrir:ouverture": pointeur === 5 ? 6 : 4,
    "sauvegarder:continuer": 7,
    "restaurer-ailleurs:continuer": 8,
    "restaurer:restauree": 8,
    "recuperer:ouverture": pointeur === 8 ? 9 : 4,
  };
  const cible = transitions[`${ecranId}:${evenement}`];
  return cible === undefined ? null : cible;
}

/** La prochaine étape que la visite n'a pas encore jouée, depuis l'application. */
function prochaineEtapeNonJouee(etapeAtteinte) {
  return Math.min(Math.max(etapeAtteinte, 5), ETAPES.length);
}

/** Le titre de l'étape qui suit un écran, pour l'annoncer. `null` après la dernière. */
export function etapeSuivante(ecranId) {
  const rang = ECRANS[ecranId]?.etape ?? null;
  if (rang === null || rang >= ETAPES.length) return null;
  return ETAPES[rang];
}

/**
 * « Où suis-je » : les neuf étapes, chacune passée, en cours, à venir — ou non jouée, pour un coffre
 * restauré dont les six premières étapes ont eu lieu ailleurs. Une étape est « passée » quand la
 * visite est allée au-delà ; la visite FINIE, aucune n'est en cours ni à venir (QA de #244 : l'accueil
 * disait « 5 à 9 à venir » sous « La visite est finie »).
 *
 * @param {string} ecranId
 * @param {string} [origine]
 * @param {{ etapeAtteinte?: number, visiteTerminee?: boolean }} [progression]
 * @returns {{ rang: number, titre: string, statut: string }[]}
 */
export function ouSuisJe(ecranId, origine = ORIGINES_DU_COFFRE.creation, progression = {}) {
  const restaure = origine === ORIGINES_DU_COFFRE.restauration;
  const finie = progression.visiteTerminee === true;
  const courante = finie ? 0 : (ECRANS[ecranId]?.etape ?? 0);
  const atteinte = finie ? ETAPES.length + 1 : Math.max(progression.etapeAtteinte ?? 0, courante);
  return ETAPES.map(({ rang, titre }) => {
    if (restaure && rang < 7) return { rang, titre, statut: "non-jouee" };
    if (rang === courante) return { rang, titre, statut: "en-cours" };
    if (rang < atteinte) return { rang, titre, statut: "passee" };
    return { rang, titre, statut: "a-venir" };
  });
}

/**
 * Le rang affiché (« Étape 5 sur 9 ») : seulement pendant la VISITE, et seulement quand l'écran est
 * l'étape en cours. Hors de la visite — une ouverture de routine, l'accueil, la phrase oubliée —, un
 * titre ne porte pas de numéro (QA de #244).
 *
 * @param {string} ecranId
 * @param {number | null} pointeur
 * @param {{ visiteTerminee?: boolean }} progression
 * @returns {number | null}
 */
export function rangAffiche(ecranId, pointeur, progression) {
  const rang = ECRANS[ecranId]?.etape ?? null;
  if (rang === null || progression.visiteTerminee === true || ecranId === "accueil") return null;
  if ((ecranId === "rouvrir" || ecranId === "recuperer") && pointeur !== rang) return null;
  return rang;
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
  // Le bloc de mise à jour (recette QA de la PR #249, Q6) : rien ne s'y clique pendant un geste long.
  "sauvegarder-avant-mise-a-jour",
  "mettre-a-jour-l-application",
  "plus-tard",
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
  return MESSAGES.saisieIncomplete(symbolesLus, SYMBOLES_DE_LA_FEUILLE);
}

/**
 * Les symboles d'un code tel que la feuille le montre : sept groupes de quatre. Le parcours ne
 * l'importe pas du module du code — `vm-derivation-recuperation.test.mjs` nomme ses importateurs,
 * et un de plus serait un endroit de plus où le code pourrait vivre ; l'épreuve du parcours relit
 * « sur 28 ».
 */
const SYMBOLES_DE_LA_FEUILLE = GROUPES * 4;

/**
 * L'attente d'une ouverture par phrase, dite AVANT le clic.
 *
 * @param {number} attenteMs l'attente annoncée par `annonceDAttente` pour ce navigateur
 */
export function attenteDeLaPhrase(attenteMs) {
  const secondes = Math.ceil((attenteMs + SURCOUT_MESURE_DE_L_OUVERTURE_MS) / 1000);
  return texteDAttenteDeLaPhrase(`environ ${secondes} secondes`);
}

/**
 * Ce que le geste entier ajoute à la dérivation seule (#242, défaut 13) : la création annoncée
 * « moins d'une seconde » a été MESURÉE à 1,9 s sous Chrome par la recette QA du 18/09/2026, pour
 * une dérivation dont le p95 publié est de 446 ms (ADR 0021). L'écart — dériver, écrire l'enveloppe,
 * ouvrir le volume, relire l'inventaire — est annoncé avec elle, arrondi à la seconde supérieure.
 */
export const SURCOUT_MESURE_DE_L_OUVERTURE_MS = 1500;

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
