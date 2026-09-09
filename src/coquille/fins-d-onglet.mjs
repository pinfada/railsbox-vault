// LES FINS D'ONGLET : ce que le moteur livre, et ce que la coquille en fait (#170, ADR 0032).
//
// ## La conclusion, écrite AVANT les écouteurs
//
// **Aucun de ces écouteurs n'est une garantie.** La garantie est la NON-PERSISTANCE : la KEK et la
// DEK ne vivent que dans le tas d'un Worker, rien n'est écrit nulle part, et un verrouillage qui
// dépendrait d'un événement que le moteur peut ne pas livrer ne serait pas un verrouillage. Ce que
// ce module ajoute est une AVANCE — quelques millisecondes gagnées sur une mort que la fermeture de
// l'onglet obtient de toute façon — et une VISIBILITÉ : un retour arrière ne rend jamais un cadre
// applicatif dont le Worker est mort.
//
// Le corollaire est écrit là où il compte : **fermer l'onglet n'est pas verrouiller.** Sans capture
// ni `close()`, ce qui n'était pas acquitté est perdu (ADR 0014, comme à toute coupure) et la
// réouverture est un boot à FROID si aucun instantané cohérent n'existe (ADR 0024, décision 4). Le
// bouton « Verrouiller » reste le chemin qui paie une seconde au lieu de cent.
//
// ## Ce que la table porte, et ce qu'elle refuse
//
// Cinq événements, une action pour chacun, et DEUX que la coquille ne branche jamais :
//
//  - **`beforeunload`** est le seul événement ANNULABLE de la famille, et le seul usage qu'il offre
//    est de RETENIR l'utilisateur par une boîte de dialogue — s'y suspendre est ce que la Definition
//    of Ready de #25 interdit. Son écouteur rend en outre le document inéligible au bfcache sur
//    certains moteurs, une propriété dont la coquille ne doit pas DÉPENDRE ;
//  - **`unload`** est obsolète, et tout ce qu'il ferait, `pagehide` le fait.
//
// Ils sont NOMMÉS plutôt qu'omis — une liste d'exclusion vide est indiscernable d'une liste
// d'exclusion oubliée —, et `tests/unit/coquille-fins-d-onglet.test.mjs` tient un cliquet qui
// balaie `public/main.mjs` et tout `src/coquille/` pour qu'aucun ne s'y glisse.
//
// ## Pourquoi ces gardes vivent ICI, et tout injecté
//
// Le motif de `tools/muter-gardes-coquille.mjs`, tranche après tranche : « une garde écrite dans
// `public/main.mjs` ne serait éprouvable que par un navigateur, donc jamais par un enfant borné ».
// Il vaut deux fois pour cette tranche-ci : la sonde de `tests/fins-d-onglet/` a MESURÉ que sous
// Playwright aucun document n'est jamais restauré depuis le bfcache et qu'aucun onglet ne devient
// jamais caché. Quatre des cinq chemins ne sont donc atteignables QUE par une épreuve qui injecte
// l'événement — et une garde qu'aucune mutation ne peut atteindre est une garde qu'on croit sur
// parole.
//
// Aucune variable de module : ni le document, ni la fenêtre, ni la surveillance, ni l'état du
// coffre. C'est la leçon du constat 8 de la revue de sécurité de la PR #174 — une variable qui
// survit à un geste raté fait mentir le geste suivant.

/**
 * Les ACTIONS qu'une fin d'onglet peut déclencher. La liste est CLOSE : une action hors table ferait
 * décider le branchement par une chaîne que personne n'a écrite.
 */
export const ACTIONS_DE_FIN = Object.freeze({
  /** Terminer le Worker de confiance, SYNCHRONE, sans rien attendre. */
  tuer: "tuer",
  /** Recharger la coquille, par le chemin du verrouillage réussi (ADR 0031, décision 1). */
  recharger: "recharger",
  /** Comparer l'horloge à l'échéance, et verrouiller si elle est dépassée. */
  verifier: "verifier",
  /** Inscrire au relevé, et rien d'autre. Voir n'est pas agir. */
  inscrire: "inscrire",
});

/**
 * Les CINQ événements branchés, l'action de chacun, et la CIBLE sur laquelle il se pose.
 *
 * **La cible fait partie de la décision.** `pagehide` et `pageshow` sont des événements de FENÊTRE ;
 * `freeze`, `resume` et `visibilitychange` des événements de DOCUMENT, qui ne remontent pas jusqu'à
 * la fenêtre. Un écouteur posé sur la mauvaise cible ne se déclenche jamais, et rien, dans un
 * navigateur, ne le dirait : la sonde de `tests/fins-d-onglet/` a conclu « ce moteur ne gèle pas »
 * sur cette erreur-là avant qu'elle soit corrigée.
 *
 *  - **`pagehide` → tuer.** Sur un coffre `ouvert`, `terminate()` immédiat, **quel que soit
 *    `event.persisted`**, sans capture et sans `close()` : aucune tâche asynchrone n'est garantie
 *    dans `pagehide`, et le dire est plus honnête que de « tenter » une fermeture propre qui
 *    n'aboutira pas. Un seul chemin, parce que la coquille ne dépend pas de savoir si le document
 *    sera détruit ou mis en cache — s'il est détruit, le Worker mourait de toute façon ; s'il est
 *    mis en cache, c'est la SEULE chose qui empêche un retour arrière de rendre un coffre ouvert
 *    sans geste ;
 *  - **`pageshow` → recharger, et SEULEMENT si `persisted`.** Un document restauré revient avec tout
 *    son DOM — cadre applicatif compris, dont les pixels sont le dernier clair — et un Worker que
 *    `pagehide` a tué : l'état vrai est `verrouille`, et le seul document propre est un document
 *    neuf. Recharger sur tout `pageshow` serait une boucle infinie ;
 *  - **`freeze` → inscrire, et rien de plus.** Un document gelé n'exécute rien, son Worker non plus ;
 *    les clés n'y sont ni plus ni moins atteignables (mémoire du processus : hors modèle de menace,
 *    ADR 0021 décision 7). Tuer au gel coûterait l'instantané et ferait payer un boot à froid à
 *    chaque retour d'un onglet que le navigateur gèle de lui-même — « un verrouillage qui coûte deux
 *    minutes est un verrouillage qu'on désactive » ;
 *  - **`resume` et `visibilitychange` vers `visible` → vérifier.** Ce que le gel CHANGE est que la
 *    minuterie du délai ne court pas pendant lui : attendre son réveil laisserait le coffre ouvert
 *    au-delà de son échéance sans que rien ne le décide. Le retour est le premier instant où
 *    l'horloge peut être relue.
 */
export const EVENEMENTS_DE_FIN = Object.freeze({
  pagehide: Object.freeze({ cible: "fenetre", action: ACTIONS_DE_FIN.tuer }),
  pageshow: Object.freeze({ cible: "fenetre", action: ACTIONS_DE_FIN.recharger }),
  freeze: Object.freeze({ cible: "document", action: ACTIONS_DE_FIN.inscrire }),
  resume: Object.freeze({ cible: "document", action: ACTIONS_DE_FIN.verifier }),
  visibilitychange: Object.freeze({ cible: "document", action: ACTIONS_DE_FIN.verifier }),
});

/**
 * Les DEUX événements que la coquille ne branche JAMAIS, nommés plutôt qu'omis.
 *
 * Le motif de chacun est dans l'en-tête de ce fichier ; le cliquet qui les surveille est dans
 * `tests/unit/coquille-fins-d-onglet.test.mjs`, et il balaie le produit entier, pas ce module seul.
 */
export const EVENEMENTS_JAMAIS_BRANCHES = Object.freeze(["beforeunload", "unload"]);

/**
 * Le geste de `pagehide` : le Worker meurt MAINTENANT, et le délai est désarmé.
 *
 * L'ordre compte. Le `terminate()` d'abord, parce qu'il est la seule chose que le moteur puisse
 * encore garantir dans cette tâche-ci ; le désarmement ensuite, pour qu'aucune minuterie ne survive
 * à un document mis en cache.
 *
 * `persisted` est INSCRIT au journal et n'est jamais CONSULTÉ : le relevé dit ce que le moteur a
 * annoncé, et la conduite ne s'en sert pas. Écrire le premier sans employer le second est la façon
 * dont cette décision se lit dans un journal.
 */
function gesteDeFin({ surveillance, coffreOuvert, tuerLeWorker, journal }) {
  return (evenement) => {
    if (!coffreOuvert()) {
      journal("pagehide", "coffre-non-ouvert");
      return;
    }
    tuerLeWorker();
    surveillance.desarmer();
    journal("pagehide", evenement?.persisted === true ? "tue-persiste" : "tue");
  };
}

/**
 * Le geste de `pageshow` : le rechargement, et RIEN d'autre, sur un document RESTAURÉ.
 *
 * **Un `pageshow` non restauré n'écrit RIEN au journal**, et c'est une décision : il en arrive un à
 * CHAQUE chargement, si bien que l'inscrire mettrait « le document s'est chargé » en tête du journal
 * du cycle, avant l'étape 1. Le journal du cycle dit ce qui ARRIVE, pas ce qui arrive toujours —
 * `tests/browser/coquille-frontiere.spec.mjs` › « le canal privilégié est établi AVANT que le cadre
 * applicatif existe » lit sa première entrée, et elle lui appartient.
 */
function gesteDeRetour({ recharger, journal }) {
  return (evenement) => {
    if (evenement?.persisted !== true) return;
    journal("pageshow", "restaure-recharge");
    recharger();
  };
}

/** Le geste du GEL : vu, inscrit, et rien de plus. Voir n'est pas agir. */
function gesteDeGel({ journal }) {
  return () => journal("freeze", "sans-effet");
}

/**
 * Le geste du RETOUR : l'échéance est relue sur l'horloge, et jamais remise à zéro.
 *
 * Un onglet qui PART en arrière-plan n'a rien à rattraper : le temps continue de courir de toute
 * façon, et `visibilite` reste un signal SANS EFFET (ADR 0031, décision 2, intacte).
 *
 * **Le journal n'est écrit que si l'échéance était DÉPASSÉE**, pour le motif de `gesteDeRetour` : un
 * `visibilitychange` arrive à chaque aller-retour entre onglets, et l'inscrire à chaque fois ferait
 * grossir sans borne un relevé que la coquille PUBLIE dans son document. Le journal du cycle dit ce
 * qui arrive, pas ce qui arrive toujours.
 */
function gesteDeVerification({ racine, surveillance, journal }, nom) {
  return () => {
    if (nom === "visibilitychange" && racine.visibilityState !== "visible") return;
    if (surveillance.verifierLEcheance()) journal(nom, "echeance-depassee");
  };
}

/**
 * BRANCHE les fins d'onglet sur le document et la fenêtre de la coquille.
 *
 * Les écouteurs sont PASSIFS — ils n'annulent rien et ne peuvent rien annuler : aucun des cinq n'est
 * annulable, et c'est précisément ce qui distingue la famille de `beforeunload`.
 *
 * @param {{
 *   racine: Document,
 *   fenetre: Window,
 *   surveillance: { desarmer: () => void, verifierLEcheance: () => boolean },
 *   coffreOuvert: () => boolean,
 *   tuerLeWorker: () => void,
 *   recharger: () => void,
 *   journal?: (evenement: string, action: string) => void,
 * }} liaison
 */
export function brancherLesFinsDOnglet({ journal = () => {}, ...reste }) {
  const liaison = { ...reste, journal };
  const cibles = { document: liaison.racine, fenetre: liaison.fenetre };
  const gestes = {
    pagehide: gesteDeFin(liaison),
    pageshow: gesteDeRetour(liaison),
    freeze: gesteDeGel(liaison),
    resume: gesteDeVerification(liaison, "resume"),
    visibilitychange: gesteDeVerification(liaison, "visibilitychange"),
  };
  for (const [evenement, { cible }] of Object.entries(EVENEMENTS_DE_FIN)) {
    cibles[cible].addEventListener(evenement, gestes[evenement], { passive: true });
  }
}
