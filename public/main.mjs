// La COQUILLE DE PRODUIT (#161, ADR 0028).
//
// Elle détient le Worker de confiance et le canal privilégié qui y mène, encadre le document
// applicatif sur l'origine distincte de l'ADR 0002, et ne lui accorde qu'un `MessagePort` transféré
// une fois, après vérification de l'ordre, du type, de l'origine et de la fenêtre émettrice.
//
// Elle est NEUVE. La structure vient du banc du spike #35 — canal privilégié avant tout document,
// port transféré, vérification triple —, le contrat n'en vient pas : l'ADR 0002 réserve nommément à
// #24 la forme des messages, la liste d'admission, le protocole du canal privilégié, la stratégie de
// reprise, les cookies et la géométrie OPFS. Le banc reste vivant et inchangé ; il demeure le témoin
// des quatre topologies (`tests/browser/origin-topology.spec.mjs`).
//
// ## Ce fichier ASSEMBLE, il ne décide rien (#175)
//
// Jusqu'à #175, ce fichier portait à lui seul le canal privilégié, la frontière applicative, le
// cycle de démarrage et le verrouillage — 1 022 lignes sans aucun cliquet de taille sur `public/`.
// Il est désormais scindé en quatre modules de BRANCHEMENT, un par sujet, sous `public/coquille/` :
//
//  - `canal-de-confiance.mjs` — le Worker de confiance et le canal privilégié qui y mène ;
//  - `frontiere-applicative.mjs` — le cadre, le port restreint accordé à l'application, les refus ;
//  - `cycle-de-la-page.mjs` — le déroulé des huit étapes, la mort du Worker, le bouton « Rouvrir » ;
//  - `verrouillage-et-fins-d-onglet.mjs` — la surveillance d'inactivité et les quatre fins d'onglet.
//
// Ces quatre modules NE S'IMPORTENT PAS entre eux : ils ne se parlent que par le RELEVÉ public
// (`rapport`, partagé par référence) et par le petit pont de fonctions que CE fichier assemble ci-
// dessous, au fur et à mesure que chaque module existe. Les DÉCISIONS — refus, conduite après une
// mort ou un verrouillage, forme des messages — restent entièrement dans `src/coquille/`, qui n'a
// pas bougé : scinder la page ne déplace aucune décision, elle déplace seulement où le branchement
// est écrit.
//
// ## L'ordre, qui n'est pas une convention
//
// 1. la coquille refuse de s'exécuter encadrée ;
// 2. l'écouteur de `window` est inscrit à l'évaluation du module, avant que quoi que ce soit puisse
//    poster ;
// 3. le Worker de confiance est créé et le canal privilégié établi ;
// 4. ALORS SEULEMENT le cadre applicatif est créé.
//
// Ce n'est pas un ordre déclaré : une annonce reçue avant l'étape 3 est refusée par
// `VAULT_COQUILLE_CANAL_ABSENT`, et `evaluerAnnonce` contrôle cette condition la première.
//
// ## Le DÉVERROUILLAGE est un geste de l'utilisateur (#162, ADR 0029)
//
// Ce que la page fait : elle monte l'interface de `src/coquille/interface-de-deverrouillage.mjs`,
// dérive la passkey — `navigator.credentials` n'existe que dans un document (ADR 0021, décision 5)
// —, et courtie le canal privilégié. Elle ne détient aucune clé de volume, n'ouvre aucune enveloppe,
// et n'obtient aucun handle. Aucun des quatre modules de branchement n'en détient davantage.
//
// ## Aucun cookie
//
// La coquille n'écrit jamais `document.cookie`, et rien de ce qu'elle sert ne pose `Set-Cookie`
// (`tests/browser/coquille-frontiere.spec.mjs`).

import { GESTES_ADMIS } from "/src/coquille/admission-applicative.mjs";
import { ETATS_DU_VOLUME } from "/src/coquille/etat-de-la-coquille.mjs";
import { creerCanalDeConfiance } from "./coquille/canal-de-confiance.mjs";
import { creerFrontiereApplicative } from "./coquille/frontiere-applicative.mjs";
import { creerVerrouillageEtFinsDOnglet } from "./coquille/verrouillage-et-fins-d-onglet.mjs";
import { creerCycle } from "./coquille/cycle-de-la-page.mjs";

const parametres = new URL(location.href).searchParams;
const noeudEtat = document.querySelector("#coquille-etat");
const noeudRapport = document.querySelector("#coquille-rapport");
const emplacementDuCadre = document.querySelector("#cadre-applicatif");

/** Le relevé public de la coquille. Il ne porte aucune donnée du volume. */
const rapport = {
  origineCoquille: location.origin,
  origineApplicative: null,
  canalPrivilegie: "absent",
  cadreApplicatif: "non-cree",
  portOctroye: false,
  // Le JOURNAL des étapes, dans l'ordre où elles ont eu lieu. Il rend l'ordre du cycle de vie
  // OBSERVABLE plutôt que promis : l'épreuve lit une suite, pas une affirmation.
  journal: [],
  gestesAdmis: GESTES_ADMIS.map(({ type }) => type),
  // Le CYCLE DE VIE assemblé (#163, ADR 0030) : les huit étapes de `docs/architecture.md`, chacune
  // conclue avec son issue et son horodatage.
  cycle: [],
  /** Ce que ce moteur sait faire, mesuré DANS ce document et sous la CSP servie. */
  capacites: null,
  /** Ce que la coquille a constaté de l'exclusivité du volume, avant tout document applicatif. */
  exclusivite: null,
  /** Ce que la mort du Worker de confiance a fait constater, quand elle a eu lieu. */
  workerMort: null,
  /**
   * Ce que le VERROUILLAGE a fait, quand il a eu lieu (#169, ADR 0031). Publié AVANT le
   * rechargement, et c'est la seule fenêtre où il existe.
   */
  verrouillage: null,
  /** Ce que le démarrage de l'application a rendu. Ni octet du volume, ni clé, ni handle. */
  application: null,
  /** Ce que la fermeture propre a rendu : le compte rendu de capture, et rien de l'instantané. */
  fermeture: null,
  /**
   * Ce que le RELAIS HTTP a fait (#192, ADR 0038). Quatre COMPTES, et pas un octet de ce qui a
   * transité : la coquille courtise le trafic de l'application, elle ne le lit pas. `octetsRendus`
   * mesure le base64 rendu au cadre — c'est ce que la frontière a réellement fait franchir, et donc
   * ce que `docs/quality-attributes.md` publie.
   */
  relais: { demandees: 0, servies: 0, abandonnees: 0, octetsRendus: 0 },
  // Les refus sont COMPTÉS par code, jamais recopiés (revue de la PR #166).
  refusDAnnonce: {},
  refusDeRequete: {},
  annoncesRefusees: 0,
  requetesRefusees: 0,
  etat: ETATS_DU_VOLUME.demarrage,
  barrieres: 0,
  // Ce que l'assemblage COÛTE, en millisecondes depuis l'évaluation de ce module.
  mesures: {
    canalPrivilegieMs: null,
    /** Délai entre le GESTE de l'utilisateur et l'ANNONCE peinte. Il doit être petit. */
    annonceApresLeGesteMs: null,
    /** Délai entre le même geste et l'ouverture du coffre. C'est ce que l'annonce prépare. */
    deverrouillageMs: null,
    /** Délai entre le GESTE de verrouillage et l'instant où le coffre est `verrouille`. */
    verrouillageMs: null,
    cadreApplicatifMs: null,
  },
};

/** Origine des mesures : l'évaluation de ce module, c'est-à-dire le premier instant de la coquille. */
const depart = performance.now();

/** @param {string} nom */
function mesurer(nom) {
  rapport.mesures[nom] = Math.round((performance.now() - depart) * 10) / 10;
}

function publier() {
  noeudRapport.textContent = JSON.stringify(rapport, null, 2);
}

/** @param {string} etat @param {string} texte */
function terminer(etat, texte) {
  document.documentElement.dataset.coquille = etat;
  noeudEtat.textContent = texte;
  publier();
}

// --- Étape 1 : la coquille refuse d'être encadrée -------------------------------------------------

// `frame-ancestors 'none'` le dit déjà au navigateur, et c'est la vraie défense. Celle-ci existe
// pour le cas où la coquille serait servie sans sa CSP.
const encadree = window.top !== window.self;

// --- L'ASSEMBLAGE : chaque module de branchement existe, puis rejoint le pont ---------------------
//
// Le PONT ne porte que des fonctions, jamais une donnée du volume : c'est le fil qui permet à un
// module de branchement d'appeler une opération d'un autre, sans que l'un importe l'autre. Chaque
// clé n'est lue qu'après que le module qu'elle nomme a rejoint le pont — la lecture est toujours
// PARESSEUSE (une fermeture, jamais une valeur capturée), et aucun module n'appelle le pont pendant
// sa propre construction : seuls des gestes plus tardifs (un message, un geste de l'utilisateur, une
// fin d'onglet) le font.
const pont = {};

// Étape 2 : l'écouteur de `window`, avant que quoi que ce soit puisse poster.
pont.frontiere = creerFrontiereApplicative({ rapport, publier, mesurer, emplacementDuCadre, pont });

// Étape 3 : le canal privilégié, avant tout document applicatif.
pont.canal = creerCanalDeConfiance({ rapport, publier, pont });

// Le verrouillage et les fins d'onglet, branchés dès que le Worker existe.
pont.verrouillage = creerVerrouillageEtFinsDOnglet({ rapport, publier, terminer, pont });

// Le cycle, qui orchestre les trois autres et conclut les huit étapes.
pont.cycle = creerCycle({
  rapport,
  publier,
  mesurer,
  terminer,
  depart,
  encadree,
  parametres,
  pont,
});

pont.cycle.demarrer();
