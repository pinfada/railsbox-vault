// Les ÉTATS DE FRAÎCHEUR de la réserve (#299, ADR 0048 § 8) : une fonction PURE, qui dit ce qui a été
// OBSERVÉ, jamais plus.
//
// `update()` résolue ne veut pas dire « à jour » (une installation rejetée la laisse résolue sans
// erreur, et elle résout avant la fin de l'installation), et `update()` rejetée ne distingue pas un
// réseau coupé d'un 404 : on n'invente pas ce que le navigateur ne dit pas. La page ne promet jamais
// « à jour » : le plancher est non signé, il ne borne que les révocations CONNUES (§ 9).
//
// PRIORITÉ : le fait connu avant l'incertitude. L'état affiché est le premier de la table ; le journal du
// portail garde les autres.
//
// Les textes sont INDICATIFS (leur rédaction finale passe par la relecture du parcours) : ce qui est gelé
// est le niveau de promesse. « Plus récente » n'est dit que pour l'état 3, et comme une ANNONCE de
// l'origine — la séquence est publiée par l'origine, pas authentifiée.
//
// Les états 1 à 4 viennent du Worker EN ATTENTE : sa séquence, son plancher, son retrait, ou son silence.
// Ce Worker est servi par l'hébergeur, et rien ne l'authentifie (#347). Leur texte n'invite donc jamais
// à l'adopter, et ne l'attribue pas à l'éditeur : il dit que cette version n'est pas vérifiée, et quand
// elle s'appliquera. Ce qui s'applique ne dépend pas de la personne ; le texte ne lui demande rien.

const S_APPLIQUERA =
  "s'appliquera à la prochaine ouverture du coffre, une fois toutes ses fenêtres fermées.";

/** @typedef {{ id: string, rang: number, texte: string, effet: "refuse" | "autorise" | "attend" }} EtatDeFraicheur */

export const ETATS_DE_FRAICHEUR = Object.freeze({
  REVOCATION_CONNUE: Object.freeze({
    id: "revocation-connue",
    rang: 1,
    texte:
      "Une version en attente annonce que celle-ci est retirée. Cette annonce n'est pas vérifiée. " +
      "Cette fenêtre reste ouverte, mais le coffre ne s'ouvrira plus avec cette version. La version " +
      `en attente n'est pas vérifiée non plus ; elle ${S_APPLIQUERA}`,
    effet: "refuse",
  }),
  ATTENTE_MUETTE: Object.freeze({
    id: "attente-muette",
    rang: 2,
    texte:
      "Une autre version de la coquille est en attente, mais elle n'a pas pu être identifiée. " +
      "Impossible de savoir si cette version a été retirée. L'autre version n'est pas vérifiée ; " +
      `elle ${S_APPLIQUERA}`,
    effet: "autorise",
  }),
  MISE_A_JOUR_PRETE: Object.freeze({
    id: "mise-a-jour-prete",
    rang: 3,
    texte:
      "Une nouvelle version de la coquille est disponible, mais elle n'est pas vérifiée : rien ne " +
      `prouve qu'elle vient de l'éditeur. Elle ${S_APPLIQUERA}`,
    effet: "autorise",
  }),
  VERSION_DIFFERENTE: Object.freeze({
    id: "version-differente",
    rang: 4,
    texte:
      "Une version différente de celle-ci est en attente, et elle n'est pas plus récente. Ce n'est pas " +
      `une mise à jour, et elle n'est pas vérifiée. Elle ${S_APPLIQUERA} À vérifier auprès de ` +
      "l'éditeur avant de rouvrir le coffre.",
    effet: "autorise",
  }),
  VERIFICATION_ECHOUEE: Object.freeze({
    id: "verification-echouee",
    rang: 5,
    texte:
      "L'éditeur a publié une version que cette copie n'a pas pu installer. Cette version n'est " +
      "peut-être plus la bonne.",
    effet: "autorise",
  }),
  NON_VERIFIABLE: Object.freeze({
    id: "version-courante-non-verifiable",
    rang: 6,
    texte:
      "Impossible de savoir si cette version a été retirée (hors connexion, ou éditeur injoignable).",
    effet: "autorise",
  }),
  EN_COURS: Object.freeze({
    id: "verification-en-cours",
    rang: 7,
    texte: "Vérification de la version en cours…",
    effet: "attend",
  }),
  VERIFIEE: Object.freeze({
    id: "version-verifiee",
    rang: 8,
    texte: "Version vérifiée auprès de l'éditeur à l'instant (preuve non signée).",
    effet: "autorise",
  }),
});

const E = ETATS_DE_FRAICHEUR;

/**
 * La CAUSE d'une révocation connue : `retrait` (le Worker en attente est un script de retrait) ou `plancher`
 * (il porte un plancher supérieur à la séquence courante) ; `null` si l'attente n'en est pas une.
 * Une attente MUETTE n'est pas identifiée : son plancher est inconnu, elle ne révoque rien.
 *
 * @param {null | { muet?: boolean, plancher?: number, retrait?: boolean }} attente
 * @param {number} sequenceCourante
 * @returns {"retrait" | "plancher" | null}
 */
export function causeDeLaRevocation(attente, sequenceCourante) {
  if (!attente || attente.muet === true) return null;
  if (attente.retrait === true) return "retrait";
  return attente.plancher > sequenceCourante ? "plancher" : null;
}

/**
 * @param {{ maj: "ok" | "rejetee" | "echec" | "delai" | "non-tentee" | "en-cours",
 *           attente: null | { muet?: boolean, sequence?: number, plancher?: number, retrait?: boolean },
 *           sequenceCourante: number }} observation
 * @returns {EtatDeFraicheur}
 */
export function etatDeFraicheur({ maj, attente, sequenceCourante }) {
  if (causeDeLaRevocation(attente, sequenceCourante) !== null) return E.REVOCATION_CONNUE;
  if (attente && attente.muet === true) return E.ATTENTE_MUETTE;
  if (attente)
    return attente.sequence > sequenceCourante ? E.MISE_A_JOUR_PRETE : E.VERSION_DIFFERENTE;
  if (maj === "rejetee") return E.VERIFICATION_ECHOUEE;
  if (maj === "echec" || maj === "delai" || maj === "non-tentee") return E.NON_VERIFIABLE;
  if (maj === "en-cours") return E.EN_COURS;
  return E.VERIFIEE;
}
