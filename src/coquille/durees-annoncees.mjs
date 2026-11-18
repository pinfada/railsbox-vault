// Les DURÉES que le parcours annonce, en un seul endroit (#266 m1, #242 points 4 et 13).
//
// Elles ont quitté `textes-du-parcours.mjs` et `parcours.mjs` — l'un et l'autre au cliquet de taille —
// pour que chaque nombre dit à une personne ait UNE source, relue avec ses mesures. Pur, comme le reste
// du répertoire : ni DOM, ni stockage, ni horloge.

/** L'estimation annoncée d'un premier démarrage : « environ deux minutes ». */
export const ESTIMATION_DU_DEMARRAGE_EN_SECONDES = 120;

/** L'estimation d'un démarrage SUIVANT : « moins de trente secondes » (#266 B2-6). */
export const ESTIMATION_D_UN_DEMARRAGE_SUIVANT_EN_SECONDES = 30;

/** Une durée en clair, sans « (s) » : « 1 seconde », « 45 secondes », « 5 minutes ». */
export function dureeEnClair(secondes) {
  if (secondes < 120) return `${secondes} seconde${secondes > 1 ? "s" : ""}`;
  return `${Math.floor(secondes / 60)} minutes`;
}

/**
 * Ce que le geste entier ajoute à la dérivation seule (#242, défaut 13) : la création annoncée
 * « moins d'une seconde » a été MESURÉE à 1,9 s sous Chrome par la recette QA du 18/09/2026, pour
 * une dérivation dont le p95 publié est de 446 ms (ADR 0021). L'écart — dériver, écrire l'enveloppe,
 * ouvrir le volume, relire l'inventaire — est annoncé avec elle, arrondi à la seconde supérieure.
 */
export const SURCOUT_MESURE_DE_L_OUVERTURE_MS = 1500;

/**
 * Le plafond MESURÉ d'une RÉOUVERTURE (#266 m1) : la recette QA du 03/10/2026 a relevé 11,4 s
 * d'ouverture (`deverrouillageMs: 11393`), 10 à 20 s sur d'autres essais et 6 à 14 s pour une phrase
 * fausse, là où la création mesurait 1,6 s. L'écart n'est pas expliqué : la page annonce la plage
 * relevée, sans en dire la cause.
 */
export const PLAFOND_MESURE_D_UNE_REOUVERTURE_EN_SECONDES = 20;

/**
 * Les DURÉES de la mise à jour, une par chemin (recette QA de la PR #249, Q2), fondées sur les mesures
 * publiées dans `docs/quality-attributes.md` : la mise à jour 1.0.0 → 1.1.0 a pris 165 à 216 s,
 * « Plus tard » 160 à 163 s. Le second est long parce que le disque de l'application est retéléchargé
 * en entier (#247) et que l'application démarre à froid — sauf si un instantané de la version
 * actuelle existe (mesuré 14 s par la contre-recette) : la page ne le sait pas sans coût, d'où la
 * borne HAUTE annoncée (contre-recette QA de la PR #249, défaut 4).
 */
export const DUREE_DE_LA_MISE_A_JOUR = "environ trois à quatre minutes";
export const DUREE_DE_PLUS_TARD = "jusqu'à environ trois minutes";

/** Ce que l'écran annonce quand une mise à jour est proposée ou à reprendre (« Durée : … »). */
export const ATTENTE_DE_LA_MISE_A_JOUR =
  `La mise à jour prend ${DUREE_DE_LA_MISE_A_JOUR} : l'application est téléchargée, démarrée, puis ` +
  "vos données sont mises à jour ; la progression dit l'étape en cours. Garder votre version " +
  `actuelle avec « Plus tard » peut prendre ${DUREE_DE_PLUS_TARD} : l'application (environ 200 ` +
  "Mo) est téléchargée de nouveau, puis elle redémarre entièrement.";

/** Sous la REPRISE seule, « Plus tard » n'existe pas : la « Durée » n'en parle pas (défaut 6). */
export const ATTENTE_DE_LA_REPRISE =
  `La reprise de la mise à jour prend ${DUREE_DE_LA_MISE_A_JOUR} : l'application est téléchargée, ` +
  "démarrée, puis la mise à jour de vos données se termine ; la progression dit l'étape en cours.";

/**
 * Le texte de l'attente d'une phrase, pour une durée déjà dite. À la CRÉATION, la durée est celle qui
 * a été mesurée ; à la RÉOUVERTURE, une plage — jamais « jusqu'à une minute et demie », que personne
 * n'a mesurée (#266 m1).
 *
 * @param {string} duree « environ 2 secondes », ou « de 2 à 20 secondes »
 */
export function texteDAttenteDeLaPhrase(duree) {
  return (
    `Après votre clic, le coffre fait un calcul volontairement lent, pour qu'on ne puisse pas deviner ` +
    `votre phrase en essayant. Comptez ${duree} sur ce navigateur ; plus sur un appareil lent ou ` +
    `occupé. L'onglet peut sembler figé : ne le fermez pas.`
  );
}

/**
 * La durée d'une ouverture par phrase, en clair : mesurée à la création, une plage à la réouverture.
 *
 * @param {number} attenteMs l'attente annoncée par `annonceDAttente` pour ce navigateur
 * @param {{ reouverture?: boolean }} [options]
 */
export function dureeDeLaPhrase(attenteMs, { reouverture = false } = {}) {
  const secondes = Math.ceil((attenteMs + SURCOUT_MESURE_DE_L_OUVERTURE_MS) / 1000);
  return reouverture
    ? `de ${secondes} à ${PLAFOND_MESURE_D_UNE_REOUVERTURE_EN_SECONDES} secondes`
    : `environ ${secondes} secondes`;
}

/** L'attente d'une ouverture par phrase, dite AVANT le clic. */
export function attenteDeLaPhrase(attenteMs, options = {}) {
  return texteDAttenteDeLaPhrase(dureeDeLaPhrase(attenteMs, options));
}
