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
import { conduiteHumaine } from "./conduites-du-parcours.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { GROUPES, VERDICTS, etatDeLaSaisie } from "./saisie-du-code.mjs";
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
  "nouveau-code",
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
 * `nombreDeCodes` est le COMPTE des feuilles que le coffre porte (#214). Sans lui, la ligne des
 * moyens dit seulement qu'il en existe une : c'est le repli, et il suffit à tout ce qui précède
 * l'étape 3.
 *
 * @param {{ pointeur: number | null, coffre: string, moyens?: string[], nombreDeCodes?: number,
 *           progression?: object, sousEtatDuCode?: string, revocationFaite?: boolean,
 *           nouveauCodeDemande?: boolean, refus?: string | null, moteur?: string }} observation
 * @returns {string} une clé de `ECRANS`
 */
export function ecranCourant({
  pointeur,
  coffre,
  moyens = [],
  nombreDeCodes = moyens.includes("recuperation") ? 1 : 0,
  progression = PROGRESSION_INITIALE,
  sousEtatDuCode = SOUS_ETATS_DU_CODE.annonce,
  revocationFaite = false,
  nouveauCodeDemande = false,
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
    return ecranOuvert({
      pointeur,
      nombreDeCodes,
      progression,
      sousEtatDuCode,
      revocationFaite,
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
  nombreDeCodes,
  progression,
  sousEtatDuCode,
  revocationFaite,
  nouveauCodeDemande,
  moteur,
}) {
  // Aucun moyen de récupération : le premier se crée ici.
  if (nombreDeCodes === 0) return `code-${sousEtatDuCode}`;
  if (!progression.code.confirme) {
    // La feuille est dans cette page : on la recopie. Sinon, un code a été rendu ailleurs, ou avant
    // un rechargement : on le VÉRIFIE d'abord — c'est la feuille que l'on a qui compte.
    if (sousEtatDuCode !== SOUS_ETATS_DU_CODE.annonce) return `code-${sousEtatDuCode}`;
    // « Je n'ai plus cette feuille » : le parcours revient à l'annonce, et le geste qui suit AJOUTE
    // un second code. L'ancien reste valable tant qu'il n'est pas révoqué (#214, ADR 0025).
    return nouveauCodeDemande ? "code-annonce" : "code-a-verifier";
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
