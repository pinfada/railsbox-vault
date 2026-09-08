// VERROUILLER : l'ÉTAT, la RÈGLE et le DÉLAI (#169, tranche 1 de #25, ADR 0031).
//
// ## La frontière, du côté qui la reçoit
//
// L'ADR 0030 décision 3 a écrit le partage : **#163 possède la DÉTECTION et la CONDUITE** —
// constater qu'un Worker ne répond plus, poser la coquille dans l'état que #25 définit, et le dire
// au cadre —, **#25 possède l'ÉTAT et la RÈGLE** : ce que « verrouillé » veut dire, les
// déclencheurs, le délai. Ce module est ce côté-là. Il ne détecte rien et ne conduit rien : il dit
// ce qu'un verrouillage atteint, quand il se déclenche, et ce qu'il ne promet pas.
//
// **Verrouiller, c'est atteindre volontairement l'état que la mort du Worker atteint par accident.**
// Un seul état, deux chemins — et c'est pourquoi `conduiteApresLeVerrouillage` cite
// `CAUSES_DE_MORT.terminaison` au lieu d'inventer une quatrième cause : le chemin du verrouillage
// EST la fermeture propre de #163, suivie du `terminate()` que la coquille se donne à elle-même.
//
// ## Ce qui se dit, et ce qui ne se dit pas
//
// Le vocabulaire est celui de l'ADR 0021 décision 7 — **garanti**, **fait mais non garanti**,
// **impossible** —, et il interdit une phrase : « les clés sont effacées ». Ce qui s'écrit est « le
// Worker qui détenait les clés est mort ». `interne.kek = null` reste une hygiène du Worker de
// confiance, pas une promesse : effacer une `string` est IMPOSSIBLE en JavaScript, et rien ici ne
// prétendra le contraire. Ce que cette tranche peut affirmer est que le tas qui portait la KEK et la
// DEK est parti avec son Worker, et qu'aucun geste ne réussit plus sans une nouvelle dérivation.
//
// ## Pourquoi ces gardes vivent ICI et non dans `public/main.mjs`
//
// Le motif est celui de `tools/muter-gardes-coquille.mjs`, repris tranche après tranche : « une
// garde écrite dans `public/main.mjs` ne serait éprouvable que par un navigateur, donc jamais par un
// enfant borné — et une garde qu'aucune mutation ne peut atteindre est une garde qu'on croit sur
// parole ». La surveillance reçoit donc son HORLOGE et son ORDONNANCEUR en paramètres : sans cette
// injection, éprouver un délai de dix minutes demanderait dix minutes.

import { CAUSES_DE_MORT } from "./mort-du-worker.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { ETATS_DU_VOLUME } from "./etat-de-la-coquille.mjs";

/**
 * Le DÉLAI d'inactivité par défaut, en millisecondes — **dix minutes**.
 *
 * Il est nommé ici, dans `src/coquille/`, comme `DELAI_PASSKEY_MS` et `DELAI_WORKER_MORT_MS` le sont
 * dans `moyens-de-deverrouillage.mjs` : une durée que le produit tient se lit à côté de son motif,
 * jamais au milieu d'un appel.
 *
 * **Dix minutes, et le chiffre se justifie dans les deux sens.** Plus court, le délai coupe une
 * lecture, un appel téléphonique, un aller-retour à la machine à café — et un verrouillage qui coupe
 * le travail est un verrouillage que l'utilisateur allonge jusqu'à ne plus l'avoir. Plus long, il
 * cesse de borner quoi que ce soit : l'appareil laissé ouvert et l'onglet oublié — les deux
 * adversaires que cette tranche défend — se comptent en dizaines de minutes, pas en heures.
 *
 * Ce qu'il coûte quand il se déclenche est ANNONCÉ et non caché : une réouverture par instantané,
 * mesurée à 252 ms dans le scénario de bout en bout de #163, au lieu des 125,9 s d'un boot à froid.
 * C'est la décision 3 de l'ADR 0031, et c'est elle qui rend ce délai tenable.
 */
export const DELAI_INACTIVITE_MS = 600_000;

/**
 * La borne BASSE, une minute. Sous elle, le délai se déclenche entre deux paragraphes lus : ce n'est
 * plus un verrouillage, c'est une panne. Elle existe aussi pour que la fonction bornée reste
 * employable par une épreuve de navigateur sans que celle-ci ait à attendre dix minutes.
 */
export const DELAI_INACTIVITE_MINIMUM_MS = 60_000;

/**
 * La borne HAUTE, une heure. Au-delà, la KEK redevient retenue « pour la durée de la session » —
 * exactement la limite 2 de l'ADR 0029 que cette tranche ferme —, et le réglage devient un moyen de
 * désactiver le verrouillage en croyant l'ajuster.
 */
export const DELAI_INACTIVITE_MAXIMUM_MS = 3_600_000;

/**
 * Les TROIS signaux qui remettent le délai à zéro. Ils sont observés sur le **document de la
 * coquille**, et sur rien d'autre.
 *
 * Ce qu'ils ne sont pas est le sujet : l'utilisateur travaille dans un cadre INTER-ORIGINE, dont la
 * coquille ne voit ni le pointeur ni les touches. Tout signal que ce cadre pousserait remettrait le
 * délai de verrouillage entre les mains de l'origine dont l'ADR 0028 suppose le code hostile — et le
 * contrat de messages n'admet aucun « je suis là », ni sur le port restreint ni sur le canal
 * privilégié.
 *
 * **La limite, écrite plutôt que tue** : un onglet au premier plan devant un bureau vide ne se
 * distingue pas d'un onglet devant quelqu'un. Le produit n'invente pas de substitut de présence ; il
 * borne une durée sans surveillance, et il le dit.
 */
export const SIGNAUX_DACTIVITE = Object.freeze(["clavier", "focus", "pointeur"]);

/**
 * Les signaux que la coquille reçoit et qui ne remettent RIEN à zéro. Ils sont **nommés** plutôt
 * qu'omis : une liste d'exclusion vide est indiscernable d'une liste d'exclusion oubliée, et une
 * épreuve doit pouvoir les présenter un par un pour montrer qu'ils n'ont pas d'effet.
 *
 *  - `barriere` — le compte de barrières acquittées. **Un guest qui écrit en boucle n'est pas une
 *    personne** : l'activité qu'on borne est celle de l'utilisateur, pas celle de la machine ;
 *  - `message-du-cadre` — toute requête du document applicatif, y compris la seule qu'il ait le
 *    droit de poser. Le compter reviendrait à confier le délai à l'adversaire ;
 *  - `visibilite` — un onglet qui passe en arrière-plan, ou qui en revient. Le temps d'inactivité
 *    **continue de courir** quand `document.hidden` devient vrai, et ne se remet pas à zéro quand il
 *    redevient faux : un onglet rangé pendant dix minutes est exactement le cas que le délai borne.
 */
export const SIGNAUX_SANS_EFFET = Object.freeze(["barriere", "message-du-cadre", "visibilite"]);

/**
 * Les ÉVÉNEMENTS du document de la coquille, et le signal que chacun porte.
 *
 * `focusin` plutôt que `focus` : le second ne remonte pas, et un focus posé sur un champ de saisie
 * n'atteindrait jamais un écouteur de document. `pointermove` est là parce qu'une lecture se fait
 * souvent sans clic, et il ne coûte rien : il pose un nombre.
 *
 * **Ce que cette table ne porte PAS** : aucun événement de cycle de vie de page — `pagehide`,
 * `freeze`, `beforeunload`, `visibilitychange` comme signal d'activité. Les fins d'onglet sont la
 * tranche 2 (#170), et cette tranche ne promet rien à leur sujet.
 */
export const EVENEMENTS_DACTIVITE = Object.freeze({
  pointerdown: "pointeur",
  pointermove: "pointeur",
  keydown: "clavier",
  focusin: "focus",
});

/**
 * Ce signal remet-il le délai à zéro ? La liste est FERMÉE : un nom inconnu ne compte pas davantage
 * qu'un nom explicitement écarté. Une activité qui serait une liste ouverte finirait par accueillir
 * le premier signal commode.
 *
 * @param {unknown} nom
 */
export function estUnSignalDActivite(nom) {
  return SIGNAUX_DACTIVITE.includes(nom);
}

/**
 * VALIDE un délai d'inactivité, ou le REFUSE. C'est la seule porte par laquelle une valeur entre
 * dans la surveillance.
 *
 * Le délai est réglable **par session seulement**, et rien de ce réglage n'est rangé sur l'appareil
 * : ni OPFS, ni `localStorage`, ni cookie. Le motif est l'ADR 0019 § 6.9, repris par le modèle de
 * menace de l'ADR 0028 — ce qu'on range dans l'OPFS de l'origine de confiance, l'adversaire qui y
 * écrit l'ALLONGE, et un délai allongé par un adversaire est un verrouillage désactivé sans que
 * personne le voie. Les cookies sont écartés par ailleurs (ADR 0028, décision 3, éprouvée).
 *
 * **Aucune interface de réglage dans cette tranche**, et c'est un YAGNI écrit : la fonction et ses
 * bornes suffisent à ce que le produit ait une règle. Une interface demanderait de décider où le
 * réglage vit entre deux sessions — c'est-à-dire précisément la question que l'ADR 0019 § 6.9
 * tranche par la négative.
 *
 * @param {unknown} valeur un entier de millisecondes
 * @returns {number} la valeur, si elle tient entre les bornes
 */
export function delaiDInactivite(valeur) {
  if (!Number.isInteger(valeur)) {
    throw new Error(
      `Délai d'inactivité refusé : ${String(valeur)} n'est pas un entier de millisecondes.`,
    );
  }
  if (valeur < DELAI_INACTIVITE_MINIMUM_MS) {
    throw new Error(
      `Délai d'inactivité refusé : ${valeur} ms est sous la borne de ${DELAI_INACTIVITE_MINIMUM_MS} ms.`,
    );
  }
  if (valeur > DELAI_INACTIVITE_MAXIMUM_MS) {
    throw new Error(
      `Délai d'inactivité refusé : ${valeur} ms dépasse la borne de ${DELAI_INACTIVITE_MAXIMUM_MS} ms.`,
    );
  }
  return valeur;
}

/**
 * La CONDUITE à tenir une fois le coffre verrouillé.
 *
 * Elle est le pendant volontaire de `conduiteApresLaMort` (#163), et elle en diffère par UN point,
 * qui est une décision et non un oubli — l'**asymétrie**, écrite dans l'ADR 0031 décision 1 :
 *
 *  - après une MORT (imprévue), la coquille RESTE affichée, avec son relevé et le bouton « Rouvrir
 *    le coffre » : il s'est passé quelque chose, et l'utilisateur doit pouvoir le voir ;
 *  - après un VERROUILLAGE (voulu), la coquille RECHARGE d'elle-même. Les pixels du cadre applicatif
 *    sont le dernier clair de la session, et un coffre verrouillé n'a jamais un cadre affiché.
 *
 * **Le rechargement n'est pas une réouverture.** Il rejoue le cycle depuis l'étape 1 ; la coquille
 * revient en `verrouille`, l'interface de déverrouillage est remontée, aucune dérivation ne part
 * sans geste, et aucune KEK n'est gardée. Ce qu'il PERD est écrit dans l'ADR : l'attente annoncée en
 * cours et le relevé de mesures de #162, qui vivent tous deux dans le document rechargé.
 *
 * `etatConnu` ne sert qu'à UNE chose, exactement comme pour la mort : ne pas inventer un verrou sur
 * un moteur `indisponible`, où rien n'a jamais pu s'ouvrir.
 *
 * @param {{ etatConnu?: string }} constat
 */
export function conduiteApresLeVerrouillage({ etatConnu = ETATS_DU_VOLUME.verrouille } = {}) {
  const etat =
    etatConnu === ETATS_DU_VOLUME.indisponible
      ? ETATS_DU_VOLUME.indisponible
      : ETATS_DU_VOLUME.verrouille;
  return Object.freeze({
    /** Le verrouillage EST la troisième cause de mort : la coquille se la donne à elle-même. */
    cause: CAUSES_DE_MORT.terminaison,
    etat,
    /** Le refus que tout geste reçoit ensuite. Il est celui de #163 : un seul état, deux chemins. */
    code: CODES_REFUS_COQUILLE.workerMort,
    /** Le cadre est retiré par RECHARGEMENT, exécuté par la coquille elle-même. */
    rechargerLaCoquille: true,
    /** Le bouton « Rouvrir le coffre » de #163 n'est PAS offert : la coquille recharge déjà. */
    gesteQuiRouvreOffert: false,
    /** Rien ne repart tout seul. Le prix de la réouverture se paie sur un geste, jamais sans. */
    reouvertureAutomatique: false,
    /** Rien n'est dérivé tant que personne n'a agi — la garde est à l'entrée du CALCUL. */
    derivationPermise: false,
    /** La poussée de barrière cesse : il n'y a plus personne pour en acquitter une. */
    pousseeDeBarriere: false,
    /** Aucune KEK gardée : elle vivait dans le tas du Worker, et il est parti. */
    kekRetenue: false,
    /**
     * L'INSTANTANÉ SURVIT — révision datée de l'ADR 0024 décision 8 (ADR 0031, décision 3).
     *
     * Il est scellé sous la DEK, en un seul AES-256-GCM par capture, exactement comme le volume qui
     * reste, lui, sur l'appareil sans que personne n'appelle cela un défaut du verrouillage.
     * L'asymétrie honnête est écrite comme limite : l'instantané porte la RAM invitée, donc du clair
     * que le volume n'a jamais reçu, sous la même clé. Ce qui le retire n'a pas bougé : la
     * suppression du volume, la restauration (#12), la migration (#13) et toute ouverture qui
     * l'écarte.
     */
    instantaneRetire: false,
  });
}

/**
 * La SURVEILLANCE d'inactivité : elle s'arme sur un coffre ouvert, se laisse repousser par les
 * gestes de la personne, et verrouille à l'échéance.
 *
 * Elle reçoit son horloge et son ordonnanceur : une épreuve pilote alors le TEMPS au lieu d'attendre
 * dix minutes, et la campagne de mutation atteint chacune de ses décisions.
 *
 * @param {{ delaiMs?: number, maintenant: () => number,
 *           planifier: (geste: () => void, delai: number) => unknown,
 *           annuler: (identifiant: unknown) => void, verrouiller: () => void }} liaison
 */
export function surveillanceDInactivite({
  delaiMs = DELAI_INACTIVITE_MS,
  maintenant,
  planifier,
  annuler,
  verrouiller,
}) {
  // La borne est tenue à l'endroit où la valeur ENTRE dans le produit. Posée seulement dans une
  // fonction que personne n'appelle, elle serait décorative.
  const delai = delaiDInactivite(delaiMs);
  let minuterie = null;
  let dernierSigneMs = null;

  const desarmer = () => {
    if (minuterie !== null) annuler(minuterie);
    minuterie = null;
    dernierSigneMs = null;
  };

  /**
   * Ce que la minuterie fait à son réveil. Le verdict ne vient PAS du réveil, il vient de l'HORLOGE :
   * un onglet en arrière-plan voit ses minuteries étirées, un onglet au premier plan les voit
   * parfois se déclencher tôt, et verrouiller sur un réveil ferait dépendre le coffre d'un détail
   * d'ordonnancement.
   */
  const verifier = () => {
    const reste = delai - (maintenant() - dernierSigneMs);
    if (reste > 0) {
      minuterie = planifier(verifier, reste);
      return;
    }
    desarmer();
    verrouiller();
  };

  return Object.freeze({
    /**
     * ARME la surveillance, et seulement sur un coffre `ouvert`. Un coffre en démarrage, verrouillé
     * ou indisponible n'a rien à verrouiller, et une minuterie posée là tuerait un Worker qui ne
     * détient aucune clé.
     *
     * Elle est IDEMPOTENTE, et c'est ce qui fait tenir « aucun message du cadre ne compte » : la
     * page ré-arme à chaque réponse d'état, y compris celles que le document applicatif provoque en
     * posant sa question. Un ré-armement qui repousserait l'échéance rendrait le délai infini pour
     * qui interroge en boucle.
     */
    armer(etat) {
      if (etat !== ETATS_DU_VOLUME.ouvert) {
        desarmer();
        return false;
      }
      if (minuterie !== null) return false;
      dernierSigneMs = maintenant();
      minuterie = planifier(verifier, delai);
      return true;
    },
    /** DÉSARME : le verrouillage l'appelle, et le coffre fermé n'a plus de délai à courir. */
    desarmer,
    /**
     * Enregistre un signe de vie de la PERSONNE. Rend `true` si l'échéance a été repoussée.
     *
     * Un signal reçu sur une surveillance désarmée ne l'arme pas : c'est `armer` qui décide, sur
     * l'état du coffre, et un geste posé sur un coffre verrouillé n'a rien à prolonger.
     */
    signaler(nom) {
      if (minuterie === null) return false;
      if (!estUnSignalDActivite(nom)) return false;
      dernierSigneMs = maintenant();
      return true;
    },
    /** La surveillance court-elle ? */
    armee: () => minuterie !== null,
    /** L'instant, sur l'horloge injectée, où le coffre se verrouillera si rien ne bouge. */
    echeanceMs: () => (dernierSigneMs === null ? null : dernierSigneMs + delai),
    /** Le délai retenu, borné. Le relevé le publie ; il ne porte aucun secret. */
    delaiMs: delai,
  });
}

/**
 * BRANCHE les signaux d'activité sur le document de la coquille.
 *
 * `visibilitychange` est écouté et signalé comme `visibilite` — c'est-à-dire **sans effet**. L'y
 * brancher plutôt que de l'ignorer est une décision : le relevé peut alors dire que la coquille a
 * VU l'onglet passer en arrière-plan et n'a rien remis à zéro, là où une absence d'écouteur ne
 * dirait rien du tout.
 *
 * Les écouteurs sont PASSIFS : ils posent un nombre, et ne doivent retarder aucun défilement.
 *
 * @param {{ racine: Document, surveillance: { signaler: (nom: string) => boolean } }} liaison
 */
export function brancherLesSignauxDActivite({ racine, surveillance }) {
  for (const [evenement, signal] of Object.entries(EVENEMENTS_DACTIVITE)) {
    racine.addEventListener(evenement, () => surveillance.signaler(signal), { passive: true });
  }
  racine.addEventListener("visibilitychange", () => surveillance.signaler("visibilite"));
}
