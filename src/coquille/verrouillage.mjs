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
 * **DEUX limites, écrites plutôt que tues, et elles vont en sens contraire.**
 *
 * La première est celle qu'on voit : un onglet au premier plan devant un bureau vide ne se distingue
 * pas d'un onglet devant quelqu'un. Le produit n'invente pas de substitut de présence.
 *
 * **La seconde est la plus coûteuse, et c'est le cas NOMINAL du produit** (constat 4 de la revue de
 * sécurité de la PR #174, mesuré : un clic réel, vingt frappes réelles et cinquante mouvements de
 * pointeur DANS le cadre inter-origine produisent zéro `focusin`, zéro `pointerdown` et zéro
 * `keydown` sur le document de la coquille, sur les trois moteurs). **Une personne qui travaille
 * dans l'application est comptée comme absente**, et se fait verrouiller à dix minutes exactement,
 * en pleine frappe. Ce n'est pas un effet de bord : c'est la conséquence directe de « aucun signal
 * du cadre ne compte », et il vaut mieux l'écrire que le découvrir.
 *
 * Ce qui l'atténue : la réouverture coûte une seconde par l'instantané (ADR 0031, décision 3), et le
 * volume tient tout ce que le guest a fait ACQUITTER. Ce qui ne l'atténue pas : ce qui n'était pas
 * acquitté est perdu, comme à toute coupure (ADR 0014) ; et il n'existe aujourd'hui aucun signal de
 * présence que le cadre ne puisse pas forger. La question est ouverte, elle n'est pas oubliée.
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
 * `freeze`, `beforeunload`, `visibilitychange` comme signal d'activité. Elle reste vraie après
 * #170 : les fins d'onglet sont branchées ailleurs, par `fins-d-onglet.mjs`, et **aucune n'est un
 * signal d'ACTIVITÉ** — elles tuent, rechargent ou vérifient, et rien de ce qu'elles font ne
 * repousse une échéance (ADR 0032, décision 1).
 */
export const EVENEMENTS_DACTIVITE = Object.freeze({
  pointerdown: "pointeur",
  pointermove: "pointeur",
  keydown: "clavier",
  focusin: "focus",
});

/**
 * Les DEUX déclencheurs d'un verrouillage, et il n'y en a pas de troisième.
 *
 * Ils sont passés en ARGUMENT du geste, jamais retenus dans une variable de module : une variable
 * qui survit à un verrouillage RATÉ ferait publier « inactivite » sur le geste qui le suit, et le
 * relevé mentirait sur ce que l'utilisateur a fait (constat 8 de la revue de sécurité de la PR
 * #174). Un argument ne survit à rien.
 */
export const DECLENCHEURS = Object.freeze({
  /** Le bouton « Verrouiller » de la coquille. Il est le TÉMOIN POSITIF de l'autre. */
  geste: "geste",
  /** Le délai d'inactivité, à son échéance. Il emprunte exactement le même chemin. */
  inactivite: "inactivite",
});

const DECLENCHEURS_CONNUS = new Set(Object.values(DECLENCHEURS));

/**
 * VALIDE un déclencheur, ou le REFUSE. La liste est close, comme celle des causes de mort : un
 * déclencheur hors table ferait publier au relevé un mot que personne n'a décidé.
 *
 * @param {unknown} declencheur
 */
export function exigerUnDeclencheur(declencheur) {
  if (!DECLENCHEURS_CONNUS.has(declencheur)) {
    throw new Error(
      `Déclencheur de verrouillage inconnu : ${String(declencheur)}. Il n'y en a que deux.`,
    );
  }
  return declencheur;
}

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
 * La conduite à tenir quand un verrouillage est REFUSÉ — c'est-à-dire quand le geste a bien été
 * demandé au Worker de confiance et que celui-ci n'a pas pu le servir.
 *
 * **Un verrouillage refusé ne laisse JAMAIS le coffre ouvert.** C'est le constat 3 de la revue de
 * sécurité de la PR #174, et il était sévère : la première rédaction rendait la main en silence, si
 * bien qu'un refus laissait exactement l'état que le verrouillage existe pour quitter — le coffre
 * `ouvert`, le cadre applicatif affiché, et AUCUN délai, la surveillance s'étant désarmée avant
 * d'appeler le geste. Le coffre restait ouvert pour toujours sans que personne l'ait décidé.
 *
 * Ce qui est fait à la place, et pourquoi :
 *
 *  - **le Worker est TERMINÉ**, sous la cause `terminaison` — la table de l'ADR 0030 décision 3 ne
 *    gagne pas de quatrième cause. À ce point, `relacherTout` a déjà lâché la KEK dans son `finally`
 *    (correction du constat 10 de la PR #171) : le Worker ne sert plus rien, et le garder en vie ne
 *    rendrait que l'illusion d'un coffre ouvert ;
 *  - **le CADRE applicatif est retiré du DOM.** Laisser ses pixels sur un coffre dont l'utilisateur
 *    vient de demander le verrouillage est le contraire de la promesse. Le port, lui, n'est pas
 *    re-octroyé : `VAULT_COQUILLE_ANNONCE_UNIQUE` (garde de #161, mutant n° 5 de l'ADR 0028) refuse
 *    un second octroi, et rien ici ne le contourne — le cadre part, il ne revient qu'au
 *    rechargement ;
 *  - **la coquille NE recharge PAS.** C'est la seule différence avec un verrouillage réussi, et
 *    c'est l'asymétrie de la décision 1 appliquée à un accident : il s'est passé quelque chose, et
 *    l'utilisateur doit pouvoir le lire. Le relevé publie le REFUS et sa cause AVANT tout, et le
 *    bouton « Rouvrir le coffre » de #163 est offert ;
 *  - **le délai est désarmé**, au refus comme au succès : il n'y a plus rien à verrouiller.
 *
 * **Ce que la réouverture coûtera** : un boot à FROID si la capture n'a pas eu lieu. Le refus étant
 * survenu quelque part dans la fermeture propre, l'instantané peut manquer ou décrire un état que
 * le volume n'a pas — et une ouverture qui écarte un instantané le retire (ADR 0024, décision 4).
 * C'est le prix d'un accident, et il est annoncé.
 *
 * @param {{ code?: string | null, etatConnu?: string }} constat
 */
export function conduiteApresUnRefusDeVerrouillage({ code = null, etatConnu } = {}) {
  return Object.freeze({
    ...conduiteApresLeVerrouillage({ etatConnu }),
    /** Le code que le Worker a rendu, ou `null` s'il n'en a rendu aucun. */
    codeDuRefus: code,
    /** Le geste a été demandé et n'a pas abouti. Le relevé le dit avant toute autre chose. */
    refuse: true,
    /** Le Worker est terminé quand même : il ne sert plus rien, et sa KEK est déjà partie. */
    terminerLeWorker: true,
    /** Le cadre applicatif est RETIRÉ du DOM, sans qu'aucun port soit re-octroyé. */
    retirerLeCadre: true,
    /** La coquille ne recharge PAS : il s'est passé quelque chose, et cela doit se lire. */
    rechargerLaCoquille: false,
    /** Le bouton « Rouvrir le coffre » de #163 est offert, comme après toute mort constatée. */
    gesteQuiRouvreOffert: true,
    /** La réouverture peut coûter un boot à froid : la capture n'a peut-être pas eu lieu. */
    instantaneGaranti: false,
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
  /** Un verrouillage par DÉLAI refusé pour cause d'ORDRE, et qui reste DÛ. Voir `noterUnVerrouillageDu`. */
  let verrouillageDu = false;

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
   *
   * **La LIMITE que cela laisse, et elle est asymétrique** : ce contrôle rattrape un réveil trop
   * TÔT — il replanifie le reste — et jamais un réveil trop TARD. Sur un onglet CACHÉ, dont le
   * moteur étire les minuteries à la minute ou davantage, le verrouillage arrive donc APRÈS son
   * échéance, jusqu'au prochain réveil que le moteur consent. Le délai est un PLANCHER, pas une
   * garantie de ponctualité, et aucune épreuve de ce dépôt ne mesure cet étirement (il demanderait
   * plus de dix minutes d'attente réelle). Ce que la coquille peut affirmer est qu'elle ne
   * verrouille jamais AVANT son délai.
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
        verrouillageDu = false;
        return false;
      }
      // Un verrouillage DÛ n'est PAS remplacé par une échéance neuve. Sans cette ligne, le refus
      // d'ordre d'un boot repoussait le délai de dix minutes à chaque tentative : la conduite du
      // refus ré-arme, et ré-armer posait `dernierSigneMs` à l'instant du refus (constat 3 de la
      // revue de sécurité de la PR #177, reproduit sous horloge injectée).
      if (verrouillageDu) return false;
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
    /**
     * VÉRIFIE l'échéance contre l'HORLOGE, et verrouille si elle est dépassée (#170, ADR 0032).
     *
     * C'est le pendant du contrôle de `verifier` ci-dessus, et il rattrape exactement ce que
     * celui-ci ne rattrape pas : un réveil trop TARD, ou pas de réveil du tout. La limite écrite
     * dans l'ADR 0031 disait « le délai est un PLANCHER, pas une ponctualité » ; il le reste, et
     * devient un plancher HONORÉ au premier signe que l'onglet est revenu — un `resume`, ou un
     * retour à la visibilité.
     *
     * **C'est une VÉRIFICATION, jamais une remise à zéro.** `dernierSigneMs` n'est pas touché, et
     * l'échéance ne bouge pas : sans cela, un onglet qui va et vient repousserait le verrouillage
     * indéfiniment, et le délai serait entre les mains de qui change d'onglet plutôt que de qui
     * travaille. `visibilite` reste dans `SIGNAUX_SANS_EFFET` : la décision 2 de l'ADR 0031 est
     * intacte, et c'est ce témoin-là qui le montre.
     *
     * Rend `true` si elle a verrouillé.
     */
    verifierLEcheance() {
      if (minuterie === null) return false;
      if (maintenant() - dernierSigneMs < delai) return false;
      desarmer();
      verrouiller();
      return true;
    },
    /**
     * NOTE qu'un verrouillage par DÉLAI a été refusé pour cause d'ORDRE : il reste DÛ (#170, ADR
     * 0032, décision 5 ; constat 3 de la revue de sécurité de la PR #177).
     *
     * Le drapeau vit dans la SURVEILLANCE, et non dans une variable de `public/main.mjs` : c'est la
     * seule façon qu'une campagne de mutation l'atteigne.
     *
     * **La distinction avec le GESTE est la décision.** Un bouton refusé pendant un boot se
     * reclique : la personne est là, elle vient d'agir, et l'ADR 0031 assume qu'elle recommence. Un
     * DÉLAI refusé, lui, n'a personne pour recliquer — c'est même sa définition —, et le laisser
     * tomber rendrait le verrouillage automatique inatteignable pendant les deux minutes d'un boot.
     *
     * Aucune échéance neuve n'est posée : `armer` refuse tant que le dû n'est pas joué, et la
     * conclusion du boot — succès OU échec — l'appelle.
     */
    noterUnVerrouillageDu() {
      verrouillageDu = true;
      desarmer();
      return true;
    },
    /** Un verrouillage attend-il la conclusion d'un boot ? Le relevé le publie ; il ne porte rien. */
    verrouillageDu: () => verrouillageDu,
    /**
     * JOUE le verrouillage DÛ, s'il y en a un. Rend `true` s'il a été joué.
     *
     * Il est joué UNE fois : le drapeau tombe avant l'appel, si bien qu'un second refus d'ordre le
     * reposerait plutôt que de faire boucler deux verrouillages sur la même échéance.
     */
    jouerLeVerrouillageDu() {
      if (!verrouillageDu) return false;
      verrouillageDu = false;
      verrouiller();
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
  racine.addEventListener("visibilitychange", () => surveillance.signaler("visibilite"), {
    passive: true,
  });
}
