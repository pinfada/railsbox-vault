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
// La tranche 1 lisait un JETON DE HARNAIS dans un paramètre d'URL et le passait au Worker de
// confiance. Ce paramètre n'existe plus, et sa disparition est le sujet de la décision 1 de
// l'ADR 0029 : aucun chemin de produit ne franchit plus la porte de `src/vm/cle-de-volume.mjs`,
// et `tests/unit/harnais-portes.test.mjs` rougit si un second y revient.
//
// Ce que la page fait désormais : elle monte l'interface de `src/coquille/interface-de-
// deverrouillage.mjs`, dérive la passkey — `navigator.credentials` n'existe que dans un document
// (ADR 0021, décision 5) —, et courtie le canal privilégié. Elle ne détient aucune clé de volume,
// n'ouvre aucune enveloppe, et n'obtient aucun handle.
//
// ## Aucun cookie
//
// La coquille n'écrit jamais `document.cookie`, et rien de ce qu'elle sert ne pose `Set-Cookie`.
// C'est une propriété ÉPROUVÉE (`tests/browser/coquille-frontiere.spec.mjs`), pas une abstention :
// l'ADR 0017 a établi que sur un domaine propre les deux origines de l'ADR 0002 sont le même SITE,
// et l'ADR 0018 § 5 que `SameSite` ne sépare pas deux sous-domaines d'un même site. Si un cookie
// devenait nécessaire un jour, l'ADR 0028 dit sous quelle forme — préfixe `__Host-`, et rien sur le
// domaine parent.

import {
  GESTES_ADMIS,
  evaluerAnnonce,
  evaluerRequete,
} from "/src/coquille/admission-applicative.mjs";
import {
  TYPES_APPLICATIFS,
  TYPES_PRIVILEGIES,
  decoderMessage,
  enveloppeDeMessage,
  REPONSES_PRIVILEGIEES,
  enveloppePrivilegiee,
  sansCapacite,
} from "/src/coquille/contrat-de-messages.mjs";
import { mesurerLesCapacites } from "/src/coquille/capacites-de-la-coquille.mjs";
import { ISSUES_DETAPE, journalDuCycle } from "/src/coquille/cycle-de-vie.mjs";
import { brancherLesGestesDuCycle } from "/src/coquille/gestes-du-cycle.mjs";
import { ETATS_DU_VOLUME, chargeUtileDEtat } from "/src/coquille/etat-de-la-coquille.mjs";
import { CAUSES_DE_MORT, conduiteApresLaMort } from "/src/coquille/mort-du-worker.mjs";
import { monterLInterface } from "/src/coquille/interface-de-deverrouillage.mjs";
import { DELAI_WORKER_MORT_MS } from "/src/coquille/moyens-de-deverrouillage.mjs";
import { cadreApplicatif } from "/src/coquille/origines-de-la-coquille.mjs";
import { brancherLesFinsDOnglet } from "/src/coquille/fins-d-onglet.mjs";
import {
  DECLENCHEURS,
  brancherLesSignauxDActivite,
  conduiteApresLeVerrouillage,
  conduiteApresUnRefusDeVerrouillage,
  surveillanceDInactivite,
} from "/src/coquille/verrouillage.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "/src/coquille/refus-de-coquille.mjs";
import { derivationsDeLaPage } from "/src/coquille/derivation-dans-la-page.mjs";

/**
 * Paramètre du CHEMIN encadré. En production, ce que la coquille encadre est ce que l'utilisateur
 * demande à l'application — `/commandes/42` aussi bien que `/`. L'ORIGINE, elle, n'est jamais un
 * paramètre : elle est dérivée par `origines-de-la-coquille.mjs`.
 */
const PARAMETRE_CHEMIN = "document-applicatif";

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
  // conclue avec son issue et son horodatage. `journal` reste ce qu'il était — la suite d'événements
  // que les épreuves de #161 et #162 lisent —, et `cycle` dit l'ORDRE, mesuré.
  cycle: [],
  /** Ce que ce moteur sait faire, mesuré DANS ce document et sous la CSP servie. */
  capacites: null,
  /** Ce que la coquille a constaté de l'exclusivité du volume, avant tout document applicatif. */
  exclusivite: null,
  /** Ce que la mort du Worker de confiance a fait constater, quand elle a eu lieu. */
  workerMort: null,
  /**
   * Ce que le VERROUILLAGE a fait, quand il a eu lieu (#169, ADR 0031).
   *
   * Il est publié AVANT le rechargement, et c'est la seule fenêtre où il existe : la coquille se
   * recharge d'elle-même juste après, et le document qui revient est neuf. Ce qu'il porte est une
   * CONDUITE — l'état atteint, le déclencheur, ce qui n'est pas gardé —, jamais un octet du volume.
   */
  verrouillage: null,
  /** Ce que le démarrage de l'application a rendu. Ni octet du volume, ni clé, ni handle. */
  application: null,
  /** Ce que la fermeture propre a rendu : le compte rendu de capture, et rien de l'instantané. */
  fermeture: null,
  // Les refus sont COMPTÉS par code, jamais recopiés.
  //
  // Ils l'étaient : chaque refus poussait dans un tableau non borné le type reçu, et le relevé
  // entier était re-sérialisé à chaque message. La revue de la PR #166 a fait passer ce nœud de
  // 606 à 8 003 678 caractères avec quarante messages, et rejouer trois cents annonces suffisait à
  // faire enfler l'autre tableau. C'était un déni de service de la base de confiance — celle qui
  // tient le handle exclusif du volume —, commandé depuis exactement l'adversaire que l'ADR 0028
  // dit défendre.
  //
  // La correction n'est pas une borne posée sur une recopie : c'est l'absence de recopie. Les
  // codes forment un ensemble CLOS et fini (`refus-de-coquille.mjs`), si bien que ces deux objets
  // ont une taille maximale connue à l'écriture, quoi qu'on leur envoie. `annoncesRefusees` et
  // `requetesRefusees` restent des COMPTES totaux, pour qu'un relevé dise combien de fois sans
  // dire quoi.
  refusDAnnonce: {},
  refusDeRequete: {},
  annoncesRefusees: 0,
  requetesRefusees: 0,
  etat: ETATS_DU_VOLUME.demarrage,
  barrieres: 0,
  // Ce que l'assemblage COÛTE, en millisecondes depuis l'évaluation de ce module. Deux grandeurs,
  // publiées plutôt que promises : l'établissement du canal privilégié — création du Worker de
  // confiance, transfert du port, premier aller-retour — et le chargement du cadre applicatif.
  // Elles diffèrent d'un moteur à l'autre, et l'ADR 0028 publie les trois relevés.
  // `deverrouillageMs` est publié à part parce qu'il ne relève PAS de la coquille : c'est le prix
  // d'Argon2id, de l'OPFS et du moteur, mesuré ailleurs par les ADR 0021 et 0025. Le confondre avec
  // le coût du cadre ferait porter à l'assemblage une attente qui n'est pas la sienne. Depuis #162
  // il porte le délai entre le GESTE de l'utilisateur et l'ouverture, et `annonceMs` celui entre le
  // geste et l'ANNONCE : c'est cet écart-là que l'ADR 0029 publie, parce que c'est lui qui décide
  // si l'annonce arrive avant l'attente ou après.
  mesures: {
    canalPrivilegieMs: null,
    /** Délai entre le GESTE de l'utilisateur et l'ANNONCE peinte. Il doit être petit. */
    annonceApresLeGesteMs: null,
    /** Délai entre le même geste et l'ouverture du coffre. C'est ce que l'annonce prépare. */
    deverrouillageMs: null,
    /**
     * Délai entre le GESTE de verrouillage et l'instant où le coffre est `verrouille` : arrêt de la
     * VM, capture de l'instantané, `close()` des volumes, `terminate()` du Worker.
     *
     * Publiée SANS SEUIL, comme les trois autres. Elle est aussi la seule mesure de ce relevé qui
     * ne survit pas à ce qu'elle mesure : le rechargement la suit immédiatement.
     */
    verrouillageMs: null,
    cadreApplicatifMs: null,
  },
};

/** Origine des mesures : l'évaluation de ce module, c'est-à-dire le premier instant de la coquille. */
const depart = performance.now();

/**
 * Le JOURNAL DU CYCLE. Il date depuis l'évaluation du module, comme les autres mesures du relevé.
 */
const cycle = journalDuCycle({
  maintenant: () => Math.round((performance.now() - depart) * 10) / 10,
});

/** Publie le cycle dans le relevé. Appelé après chaque étape conclue. */
function inscrire(etape, issue, motif = null) {
  cycle.conclure(etape, issue, motif);
  rapport.cycle = cycle.releve();
}

/**
 * ÉTAPE 1 — identités et compatibilité, mesurées ICI et pas dans la sonde.
 *
 * `public/compat.html` est exemptée de la CSP de la coquille pour ne pas mesurer notre politique à
 * la place du moteur (`tools/serve-headers.mjs`). Cette exemption est juste pour une sonde et fausse
 * pour un produit : ce que la coquille doit savoir, c'est ce qu'elle peut faire ELLE, dans son
 * propre document, sous la politique qu'on lui sert réellement. Ce qui manque est NOMMÉ.
 */
const capacites = mesurerLesCapacites(globalThis);
rapport.capacites = {
  presentes: capacites.presentes,
  manquantes: capacites.manquantes,
  suffisante: capacites.suffisante,
};
inscrire(
  "identites",
  capacites.suffisante ? ISSUES_DETAPE.franchie : ISSUES_DETAPE.indisponible,
  capacites.manquantes.length === 0 ? null : capacites.manquantes.join(","),
);

/** @param {string} nom */
function mesurer(nom) {
  rapport.mesures[nom] = Math.round((performance.now() - depart) * 10) / 10;
}

function publier() {
  noeudRapport.textContent = JSON.stringify(rapport, null, 2);
}

/**
 * Compte un refus, par code. Rien d'autre n'est retenu de ce que le guest a envoyé.
 *
 * @param {Record<string, number>} compteurs
 * @param {string} code
 */
function compter(compteurs, code) {
  compteurs[code] = (compteurs[code] ?? 0) + 1;
}

// --- Étape 1 : la coquille refuse d'être encadrée -------------------------------------------------

// `frame-ancestors 'none'` le dit déjà au navigateur, et c'est la vraie défense. Celle-ci existe
// pour le cas où la coquille serait servie sans sa CSP : par un hébergeur qui ignore `_headers`, ou
// — cas réel du dépôt — par le rôle `app` de `tools/serve.mjs`, qui ne sert aucune CSP. Sans elle,
// une coquille encadrée par elle-même créerait un cadre, qui créerait une coquille, indéfiniment.
const encadree = window.top !== window.self;

// --- Étape 2 : l'écouteur de `window`, avant que quoi que ce soit puisse poster --------------------

let cadre = null;
let portRestreint = null;

window.addEventListener("message", (event) => {
  // Une annonce ne TRANSFÈRE rien. Un document qui joindrait un port ou un tampon à son annonce
  // ouvrirait un canal que personne n'a décidé d'ouvrir : la coquille ne s'en servait pas, mais ne
  // le refusait pas non plus, et la revue de #166 l'a relevé. Le refuser d'abord, c'est aussi ne
  // jamais tenir une référence sur ce qui a été transféré.
  if (event.ports.length > 0) {
    return refuserLAnnonce(CODES_REFUS_COQUILLE.capaciteDansUnMessage);
  }
  const decode = decoderMessage(event.data);
  const verdict = evaluerAnnonce({
    canalPrivilegiePret: rapport.canalPrivilegie === "etabli",
    type: decode.ok ? decode.type : null,
    origine: event.origin,
    fenetreEstLeCadre: cadre !== null && event.source === cadre.contentWindow,
    origineAttendue: rapport.origineApplicative,
    dejaOctroye: rapport.portOctroye,
  });
  if (!verdict.accepte) return refuserLAnnonce(verdict.code);
  octroyerLePortRestreint(event.source, rapport.origineApplicative);
});

/** @param {string} code */
function refuserLAnnonce(code) {
  rapport.annoncesRefusees += 1;
  compter(rapport.refusDAnnonce, code);
  publier();
}

// --- Étape 3 : le canal privilégié, avant tout document applicatif ---------------------------------

/**
 * Le Worker de confiance est chargé avec `?use-scheduling-api`, et ce n'est PAS décoratif.
 *
 * v86 choisit sa boucle d'ordonnancement à l'évaluation de son module, en inspectant
 * `location.href` du contexte qui l'importe (ADR 0013, § « Mise en œuvre par #74 ») : sans ce
 * marqueur, il retombe sur un Worker imbriqué chargé depuis une URL `blob:` — que la CSP de la
 * coquille refuse (`worker-src 'self'`, ADR 0013). Le contrôle préalable le voit et refuse de
 * démarrer, sous `VAULT_RUNTIME_WORKER_REFUSED` ; c'est ce que le scénario de bout en bout a
 * trouvé au premier boot réel dans la coquille.
 *
 * Le marqueur est donc porté par le PRODUIT, comme il l'est par chaque banc qui fait tourner
 * l'émulateur (`public/vm/banc.mjs`, `public/vm/reference-banc.mjs`). Il ne demande aucune
 * capacité et n'élargit aucune politique : il dit à v86 d'emprunter la boucle que Vault pose
 * elle-même, y compris sur un moteur qui n'expose pas `scheduler.postTask`.
 */
const worker = new Worker(new URL("./runtime-worker.mjs?use-scheduling-api", import.meta.url), {
  type: "module",
  name: "vault-coquille-confiance",
});
const privilegie = new MessageChannel();

/**
 * La MORT du Worker de confiance, constatée puis conduite (#163, ADR 0030, décision 3).
 *
 * Trois voies, et pas une de plus : `error` et `messageerror` du Worker, le SILENCE au-delà de
 * `DELAI_WORKER_MORT_MS` (`demanderAuWorker`), et le `terminate()` que la coquille appelle
 * elle-même à la fermeture propre. Les écouteurs sont inscrits ICI, à la création du Worker : un
 * Worker qui jette à l'évaluation de son module meurt AVANT que le canal soit établi, et une
 * surveillance armée plus tard ne le verrait pas.
 */
let mortDuWorker = null;

// --- Le VERROUILLAGE : l'état, la règle, les deux déclencheurs (#169, ADR 0031) -------------------

/**
 * Le geste de verrouillage, une fois le cycle branché. Les DEUX déclencheurs empruntent exactement
 * ce chemin — le bouton « Verrouiller » de la coquille et le délai d'inactivité —, et c'est ce qui
 * fait du geste explicite le TÉMOIN POSITIF du délai : une suite qui verrait le premier verrouiller
 * et pas le second mesurerait un déclencheur, jamais un verrouillage.
 */
let verrouillerLeCoffre = null;

/**
 * L'instant du départ du verrouillage, sur l'horloge de la page. Origine de `verrouillageMs`.
 *
 * Le DÉCLENCHEUR, lui, n'est plus une variable de module : il est passé en argument du geste et
 * revient en argument des rappels. Une variable qui survivait à un verrouillage RATÉ faisait publier
 * « inactivite » sur le geste qui le suivait — le relevé mentait sur ce que l'utilisateur avait fait
 * (constat 8 de la revue de sécurité de la PR #174).
 */
let departDuVerrouillage = null;

/**
 * La SURVEILLANCE d'inactivité, sous l'horloge et l'ordonnanceur du navigateur.
 *
 * Elle n'est pas armée ici : `refletDeLEtat` l'arme quand — et seulement quand — le coffre passe à
 * `ouvert`, et la désarme sur tout autre état. Le délai, ses bornes et ce qui compte comme activité
 * vivent dans `src/coquille/verrouillage.mjs`, où une campagne de mutation peut les atteindre.
 */
const surveillance = surveillanceDInactivite({
  maintenant: () => performance.now(),
  planifier: (geste, delai) => setTimeout(geste, delai),
  annuler: (identifiant) => clearTimeout(identifiant),
  verrouiller: () => void verrouillerLeCoffre?.(DECLENCHEURS.inactivite),
});

brancherLesSignauxDActivite({ racine: document, surveillance });

// Les FINS D'ONGLET (#170, ADR 0032). Ce que chaque événement déclenche, et pourquoi, vit dans
// `src/coquille/fins-d-onglet.mjs`, où la campagne de mutation l'atteint : la page ne fait que
// brancher. `coffreOuvert` est lu à CHAQUE événement, jamais retenu — l'état change sous les pieds
// de tout ce qui le mémorise.
brancherLesFinsDOnglet({
  racine: document,
  fenetre: globalThis,
  surveillance,
  coffreOuvert: () => rapport.etat === ETATS_DU_VOLUME.ouvert && mortDuWorker === null,
  tuerLeWorker: () => worker.terminate(),
  recharger: () => rechargerLaCoquille(),
  journal: (evenement, action) => rapport.journal.push(`fin-d-onglet:${evenement}:${action}`),
});

/**
 * REFLÈTE dans la surveillance l'état que le relevé vient de publier.
 *
 * Appelée à chaque endroit où `rapport.etat` change, et à aucun autre : la règle « le délai n'est
 * armé QUE sur un coffre ouvert » ne vaut que si elle est appliquée partout où l'état bouge. Elle
 * est IDEMPOTENTE par construction (`armer` refuse de ré-armer une surveillance qui court déjà) :
 * sans cela, chaque question d'état du document applicatif remettrait le délai à zéro, et un guest
 * qui interroge en boucle rendrait le verrouillage inatteignable.
 */
function refletDeLEtat() {
  surveillance.armer(rapport.etat);
}

/**
 * CONSTATE la mort, une fois, et tient la conduite : refuser tout service jusqu'à un geste
 * explicite. L'interface de déverrouillage est REMONTÉE — montrée, pas actionnée — et rien n'est
 * dérivé tant que personne n'a agi.
 *
 * @param {string} cause une valeur de `CAUSES_DE_MORT`
 */
function constaterLaMort(cause, { offrirLeGesteQuiRouvre = true } = {}) {
  if (mortDuWorker !== null) return mortDuWorker;
  // La surveillance d'inactivité s'arrête ICI, quelle que soit la cause : un coffre dont le Worker
  // est mort n'a plus rien à verrouiller, et une minuterie qui survivrait rechargerait la coquille
  // sous les yeux de qui vient de lire « le Worker ne répond plus ».
  surveillance.desarmer();
  mortDuWorker = conduiteApresLaMort({
    cause,
    etatConnu: rapport.etat,
    barrieres: rapport.barrieres,
  });
  rapport.etat = mortDuWorker.etat;
  rapport.workerMort = {
    cause,
    code: mortDuWorker.code,
    interfaceRemontee: mortDuWorker.interfaceRemontee,
    derivationPermise: mortDuWorker.derivationPermise,
    pousseeDeBarriere: mortDuWorker.pousseeDeBarriere,
    kekRetenue: mortDuWorker.kekRetenue,
  };
  // Toute demande EN VOL reçoit le refus TYPÉ. Sans cela, un geste parti juste avant la mort
  // resterait suspendu pour toujours — le silence que « un refus typé, jamais un silence » interdit,
  // et qui serait ici le plus long de tous : le Worker ne répondra plus jamais.
  for (const [correlation, attente] of demandesEnVol) {
    demandesEnVol.delete(correlation);
    attente.refuser(refusDeMort());
  }
  remonterLInterface();
  // L'ASYMÉTRIE, assumée (ADR 0031, décision 1) : après une mort IMPRÉVUE, la coquille reste
  // affichée avec son relevé et le bouton qui la recharge — l'utilisateur doit voir qu'il s'est
  // passé quelque chose. Après un VERROUILLAGE voulu, elle recharge d'elle-même, et offrir un
  // bouton qui disparaît dans la milliseconde ne dirait rien à personne.
  if (offrirLeGesteQuiRouvre) offrirLaReouverture();
  publier();
  terminer("worker-mort", `coquille:worker-mort:${cause}`);
  return mortDuWorker;
}

/**
 * N'exécute un geste que si le Worker vit. Sinon, le refus TYPÉ, tout de suite : la conduite est
 * déjà décidée, et faire le calcul avant de le découvrir serait payer deux secondes pour rien.
 */
function siVivant(geste) {
  return mortDuWorker === null ? geste() : Promise.reject(refusDeMort());
}

/** Le refus que TOUT geste reçoit une fois la mort constatée. Il porte SON code, pas un autre. */
function refusDeMort() {
  return Object.assign(new Error(messageDeRefus(CODES_REFUS_COQUILLE.workerMort)), {
    code: CODES_REFUS_COQUILLE.workerMort,
  });
}

worker.addEventListener("error", () => constaterLaMort(CAUSES_DE_MORT.erreur));
worker.addEventListener("messageerror", () => constaterLaMort(CAUSES_DE_MORT.erreur));

/**
 * Les demandes EN VOL vers le Worker, APPARIÉES par leur identifiant de corrélation.
 *
 * C'était une FILE tant qu'un seul geste existait : le Worker traite le canal privilégié en série
 * et répond dans l'ordre, si bien que la plus ancienne demande était toujours celle que la
 * prochaine réponse servait. Une variable unique, elle, écrasait la précédente, et la réponse qui
 * lui revenait était jetée faute de destinataire — c'est le SILENCE que la revue de la PR #166 a
 * mesuré.
 *
 * #162 ajoute quatre gestes, dont un qui dure DEUX SECONDES sur le moteur le plus lent. L'ordre ne
 * suffit plus : un refus de dérivation et une demande d'état posée pendant l'attente rendraient
 * deux messages pour deux demandes, mais rien ne dirait lequel sert laquelle. La CORRÉLATION le
 * dit, et c'est la même leçon que celle du port restreint, appliquée à l'autre canal AVANT qu'il
 * ne la répète.
 */
const demandesEnVol = new Map();

/** Compteur des corrélations du canal privilégié. Il ne quitte jamais l'origine de confiance. */
let corrélationSuivante = 0;

privilegie.port1.addEventListener("message", (event) => surMessagePrivilegie(event.data));
privilegie.port1.start();
worker.postMessage(enveloppeDeMessage(TYPES_PRIVILEGIES.canal), [privilegie.port2]);

/** @param {unknown} donnee */
function surMessagePrivilegie(donnee) {
  const decode = decoderMessage(donnee);
  if (!decode.ok) return;
  if (decode.type === TYPES_PRIVILEGIES.etatReponse) {
    rapport.etat = decode.message.etat;
    rapport.barrieres = decode.message.barrieres;
    refletDeLEtat();
    publier();
  }
  if (decode.type === TYPES_PRIVILEGIES.deverrouillageReponse) {
    rapport.etat = decode.message.etat;
    rapport.barrieres = decode.message.barrieres;
    refletDeLEtat();
    publier();
  }
  if (decode.type === TYPES_PRIVILEGIES.battement) {
    // Un SIGNE DE VIE, et rien d'autre : il ne règle aucune promesse, il repousse la borne de
    // l'attente qu'il nomme. Un battement dont la corrélation n'est pas en vol est ignoré — il ne
    // doit prolonger que ce qu'il accompagne.
    demandesEnVol.get(decode.message.correlation)?.repousser();
    return;
  }
  if (decode.type === TYPES_PRIVILEGIES.barriere) {
    rapport.barrieres = decode.message.barrieres;
    // La barrière est SIGNALÉE à la surveillance, qui la refuse : un guest qui écrit en boucle n'est
    // pas une personne. Le lui présenter plutôt que de l'ignorer met le refus à l'endroit où il se
    // mute et s'éprouve — dans `verrouillage.mjs` —, au lieu d'en faire une absence d'appel que rien
    // ne peut rougir.
    surveillance.signaler("barriere");
    publier();
    pousserLaBarriere();
    return;
  }
  if (decode.type === TYPES_PRIVILEGIES.refus) {
    rapport.requetesRefusees += 1;
    compter(rapport.refusDeRequete, decode.message.code);
    publier();
  }
  if (!REPONSES_PRIVILEGIEES.has(decode.type)) return;
  const attente = demandesEnVol.get(decode.message.correlation);
  if (attente === undefined) return;
  demandesEnVol.delete(decode.message.correlation);
  if (decode.type === TYPES_PRIVILEGIES.refus) {
    // Un refus REJETTE la promesse, avec son code intact. Le traduire en une valeur de retour
    // ferait porter à chaque appelant la charge de le reconnaître, et le premier qui l'oublierait
    // afficherait « ouvert » sur un coffre fermé.
    return attente.refuser(
      Object.assign(new Error(decode.message.message ?? "geste refusé"), {
        code: decode.message.code,
      }),
    );
  }
  attente.rendre(decode.message);
}

/**
 * Aller-retour vers le Worker de confiance, sous une corrélation qui n'appartient qu'à lui.
 *
 * `corps` peut porter la `kek` d'une passkey : `enveloppePrivilegiee` est la SEULE porte par
 * laquelle une `CryptoKey` non extractible franchit un port de cette coquille, et elle refuse un
 * type applicatif comme elle refuse une clé extractible.
 *
 * @param {string} nomDuType clé de `TYPES_PRIVILEGIES`
 * @param {Record<string, unknown>} corps
 */
function demanderAuWorker(nomDuType, corps = {}) {
  // Une coquille dont le Worker est mort ne demande plus rien : elle refuse, tout de suite, sous le
  // code de la mort. Poser la question ferait attendre trente secondes une réponse qui ne viendra
  // pas, et la conduite est déjà décidée.
  if (mortDuWorker !== null) return Promise.reject(refusDeMort());
  corrélationSuivante += 1;
  const correlation = `c${corrélationSuivante}`;
  return new Promise((rendre, refuser) => {
    // La borne d'un Worker MORT. Sans elle, une promesse en suspens ne se règle jamais : le
    // `finally` de `surRequeteApplicative` ne se déclenche pas, les trente-deux emplacements se
    // remplissent, et le port restreint se ferme pour de bon. Le refus est TYPÉ, comme tous les
    // autres, et il porte le code de la coquille — jamais un code du Worker, qui n'a rien dit.
    // La borne est REPOUSSABLE : ce qu'elle mesure est l'absence de SIGNE DE VIE, et non l'absence
    // de réponse. Un Worker qui boote une machine virtuelle met des dizaines de secondes à
    // répondre — p95 = 125,9 s au dossier — et bat pendant tout ce temps ; sans cette distinction,
    // la coquille déclarerait mort un Worker vivant exactement pendant le geste le plus long
    // qu'elle porte, et la fermeture propre deviendrait inatteignable dans le cas même pour lequel
    // elle est écrite (constat 1 de la revue de sécurité de la PR #171).
    let minuterie = null;
    const armer = () => {
      minuterie = setTimeout(() => {
        demandesEnVol.delete(correlation);
        // Le SILENCE est l'une des trois causes de mort, et il porte désormais SON code.
        //
        // Il portait `typeInconnu`, dont le message est « Requête hors de la liste d'admission de
        // la coquille » — c'est-à-dire tout autre chose que ce qui s'était produit. Le défaut a été
        // relevé par la Definition of Ready de #25, et il est de la classe qu'on ne voit qu'une
        // fois qu'autre chose a déjà échoué : un refus qui décrit un autre événement que le sien.
        constaterLaMort(CAUSES_DE_MORT.silence);
        refuser(refusDeMort());
      }, DELAI_WORKER_MORT_MS);
    };
    armer();
    const clore = (geste) => (valeur) => {
      clearTimeout(minuterie);
      geste(valeur);
    };
    demandesEnVol.set(correlation, {
      rendre: clore(rendre),
      refuser: clore(refuser),
      repousser: () => {
        clearTimeout(minuterie);
        armer();
      },
    });
    privilegie.port1.postMessage(
      enveloppePrivilegiee(TYPES_PRIVILEGIES[nomDuType], { ...corps, correlation }),
    );
  });
}

/**
 * La demande d'état, sous la forme que le port restreint attend en retour.
 *
 * Elle ne REJETTE jamais, et c'est délibéré. Depuis #162, une réponse du canal privilégié peut être
 * un refus — c'est ainsi que `VAULT_ENVELOPPE_CLE_REFUSEE` remonte d'une dérivation —, et
 * `demanderAuWorker` transforme un refus en promesse rompue. Laisser cette rupture atteindre le
 * document applicatif lui rendrait un SILENCE, ce que « un refus typé, jamais un silence » interdit
 * quatre fois dans ce dossier ; lui rendre le CODE du Worker ferait de sa réponse un oracle sur
 * l'enveloppe, ce que la liste de refus interdit tout autant.
 *
 * Ce qui lui est rendu est donc le dernier état CONNU — celui que le relevé publie déjà, et que
 * chaque réponse du Worker comme chaque annonce de barrière tient à jour. Un refus sur la question
 * d'état est un défaut de la coquille, jamais une faute du document applicatif.
 */
async function demanderLEtat() {
  try {
    const reponse = await demanderAuWorker("etat");
    return chargeUtileDEtat({ etat: reponse.etat, barrieres: reponse.barrieres });
  } catch {
    return chargeUtileDEtat(rapportDEtat());
  }
}

/** Le dernier état CONNU, tel que le relevé le publie. Il n'est jamais plus vieux que lui. */
function rapportDEtat() {
  return { etat: rapport.etat, barrieres: rapport.barrieres };
}

// --- Étape 4 : le port restreint accordé à l'application ------------------------------------------

/**
 * Transfère un port restreint NEUF au document applicatif. Le port privilégié n'est jamais transmis,
 * et le message d'octroi ne porte rien d'autre que le port : ni jeton, ni état, ni identité.
 *
 * @param {WindowProxy} destinataire
 * @param {string} origineCible
 */
function octroyerLePortRestreint(destinataire, origineCible) {
  const restreint = new MessageChannel();
  restreint.port1.addEventListener("message", (event) =>
    surRequeteApplicative(restreint.port1, event),
  );
  restreint.port1.start();
  portRestreint = restreint.port1;
  destinataire.postMessage(enveloppeDeMessage(TYPES_APPLICATIFS.octroi), origineCible, [
    restreint.port2,
  ]);
  rapport.portOctroye = true;
  rapport.journal.push("port-restreint-octroye");
  publier();
}

/**
 * Nombre maximal de requêtes du document applicatif servies EN MÊME TEMPS.
 *
 * Trente-deux, et la valeur se justifie par ce qu'elle borne plutôt que par un usage : un document
 * loyal en a une en vol — il attend sa réponse avant de reposer sa question —, et le seul cas qui
 * en demanderait plusieurs est un rendu qui interroge en parallèle, ce qu'aucun usage relevé ne
 * fait. La borne existe donc contre l'autre cas : sans elle, la file d'appariement grandirait au
 * rythme où le guest poste, ce qui rouvrirait par la porte de derrière le déni de service que le
 * relevé borné ferme par la porte de devant. Au-delà, la coquille REFUSE — elle ne met pas en
 * réserve.
 */
const REQUETES_EN_VOL_MAXIMUM = 32;

/** Les corrélations en vol. Une clé bornée, un ensemble borné : la mémoire l'est aussi. */
const correlationsEnVol = new Set();

/**
 * Traite un message du document applicatif. Le refus est calculé AVANT toute consultation d'état :
 * il ne dépend que du type reçu, et deux appareils dans des états différents rendent le même code.
 *
 * **Chaque requête admise reçoit SA réponse**, appariée par l'identifiant de corrélation qu'elle
 * porte et que la coquille rend tel quel. C'est la correction du constat 2 de la revue de la PR
 * #166 : deux requêtes en vol se disputaient une seule réponse, et l'une des deux restait muette —
 * sur le SEUL geste que la coquille admette, et alors que « un refus typé, jamais un silence » est
 * écrit quatre fois dans le dossier.
 *
 * @param {MessagePort} port
 * @param {MessageEvent} event
 */
function surRequeteApplicative(port, event) {
  // Le port restreint ne reçoit AUCUN transférable. Refusé avant tout décodage : c'est aussi la
  // façon de ne jamais tenir une référence sur ce qui aurait été transféré.
  if (event.ports.length > 0) {
    return refuserLaRequete(port, CODES_REFUS_COQUILLE.capaciteDansUnMessage, null, null);
  }
  const verdict = evaluerRequete(event.data);
  if (!verdict.admise) {
    return refuserLaRequete(port, verdict.code, verdict.recu, verdict.correlation);
  }
  if (correlationsEnVol.has(verdict.correlation)) {
    return refuserLaRequete(
      port,
      CODES_REFUS_COQUILLE.correlationDupliquee,
      verdict.type,
      verdict.correlation,
    );
  }
  if (correlationsEnVol.size >= REQUETES_EN_VOL_MAXIMUM) {
    return refuserLaRequete(
      port,
      CODES_REFUS_COQUILLE.tropDeRequetes,
      verdict.type,
      verdict.correlation,
    );
  }
  correlationsEnVol.add(verdict.correlation);
  // Le message du CADRE est présenté à la surveillance, qui le refuse. Le contrat n'admet aucun
  // « je suis là », et l'origine applicative est supposée hostile : un signal qu'elle pousserait
  // remettrait le délai de verrouillage entre les mains de l'adversaire même que la coquille sépare.
  surveillance.signaler("message-du-cadre");
  demanderLEtat()
    .then((charge) => {
      port.postMessage(
        enveloppeDeMessage(
          TYPES_APPLICATIFS.etatReponse,
          sansCapacite({ correlation: verdict.correlation, ...charge }),
        ),
      );
    })
    // La corrélation est relâchée QUOI QU'IL ARRIVE. Elle l'était dans la branche du succès, donc
    // un échec l'aurait laissée en vol pour toujours : l'identifiant serait devenu inutilisable, et
    // la trente-deuxième requête perdue aurait fermé le port pour de bon. C'est le genre de fuite
    // qu'on ne voit qu'une fois qu'autre chose a déjà échoué.
    .finally(() => correlationsEnVol.delete(verdict.correlation));
}

/**
 * Rend un refus TYPÉ à l'application, et le COMPTE. Ce qui repart est ce que l'émetteur a envoyé,
 * borné ; ce qui reste dans la coquille est un compteur.
 *
 * @param {MessagePort} port
 * @param {string} code
 * @param {string | null} recu
 * @param {string | null} correlation
 */
function refuserLaRequete(port, code, recu, correlation) {
  rapport.requetesRefusees += 1;
  compter(rapport.refusDeRequete, code);
  publier();
  const corps = { code, message: messageDeRefus(code) };
  if (recu !== null) corps.recu = recu;
  if (correlation !== null) corps.correlation = correlation;
  port.postMessage(enveloppeDeMessage(TYPES_APPLICATIFS.refus, corps));
}

/** Pousse l'annonce de barrière vers l'application, si un port lui a été octroyé. */
function pousserLaBarriere() {
  // La poussée CESSE à la mort : il n'y a plus personne pour acquitter une barrière, et annoncer
  // celles d'avant ferait dire « enregistré » à une application sur un coffre qui ne l'est plus.
  if (mortDuWorker !== null) return;
  if (portRestreint === null) return;
  portRestreint.postMessage(
    enveloppeDeMessage(TYPES_APPLICATIFS.barriere, { barrieres: rapport.barrieres }),
  );
}

// --- Démarrage -------------------------------------------------------------------------------------

/** Crée le cadre applicatif. Appelé UNIQUEMENT après l'établissement du canal privilégié. */
function creerLeCadre(url) {
  const element = document.createElement("iframe");
  element.id = "document-applicatif";
  element.title = "document applicatif";
  // `allow-same-origin` est conservé sur une iframe INTER-ORIGINE : il ne rend pas la sandbox
  // contournable, il rend à l'application son propre stockage (ADR 0002, conséquence 3). L'absence
  // de `allow-top-navigation` et de `allow-popups` est voulue.
  element.setAttribute("sandbox", "allow-scripts allow-same-origin");
  element.src = url;
  element.addEventListener("load", () => {
    rapport.cadreApplicatif = "charge";
    mesurer("cadreApplicatifMs");
    publier();
  });
  cadre = element;
  rapport.journal.push("cadre-applicatif-cree");
  emplacementDuCadre.append(element);
}

async function demarrer() {
  if (encadree) {
    return terminer("refusee", "coquille:encadree-refusee");
  }
  // ÉTAPE 1, et son refus. Une capacité EXIGÉE absente rend la coquille inutilisable : il n'y a pas
  // de chemin dégradé, et mener l'utilisateur jusqu'à une phrase saisie pour lui refuser ensuite
  // serait pire que de le dire tout de suite. Le Worker est terminé — rien ne doit tourner dans une
  // coquille qui ne peut rien servir — et la surveillance est neutralisée d'abord : ce
  // `terminate()` n'est pas une mort constatée, c'est un démarrage qui n'a pas eu lieu.
  if (!capacites.suffisante) {
    mortDuWorker = SANS_SURVEILLANCE;
    worker.terminate();
    return terminer(
      "indisponible",
      `coquille:capacite-manquante:${capacites.manquantes.join(",")}`,
    );
  }
  const cible = cadreApplicatif(location.origin, parametres.get(PARAMETRE_CHEMIN));
  rapport.origineApplicative = cible?.origineApplicative ?? null;

  // Le canal est établi quand le Worker a répondu : une promesse tenue, pas un `postMessage` émis.
  // Sa réponse porte aussi ce que l'ÉTAPE 2 a constaté de l'exclusivité du volume, relevé par le
  // Worker à son évaluation — donc avant qu'aucun document applicatif puisse exister.
  const premierEtat = await demanderLEtatPrivilegie();
  // Le Worker a pu MOURIR pendant cette première question — c'est même le cas le plus probable
  // d'une mort : un module qui jette à son évaluation, ou qui ne répond jamais. `constaterLaMort` a
  // alors déjà tenu la conduite ; poursuivre le démarrage écraserait son état par « prête ».
  if (mortDuWorker !== null) return;
  rapport.exclusivite = premierEtat.exclusivite ?? null;
  inscrire("exclusiviteEtCanal", ISSUES_DETAPE.franchie, rapport.exclusivite?.verdict ?? null);
  rapport.canalPrivilegie = "etabli";
  rapport.journal.push("canal-privilegie-etabli");
  mesurer("canalPrivilegieMs");
  publier();

  // L'interface est montée AVANT le cadre applicatif, et l'ordre est celui de l'ADR 0028 : rien de
  // ce que la coquille sert au document applicatif ne dépend du déverrouillage, mais le contraire
  // serait une inversion — un cadre créé d'abord aurait, pendant un instant, un port sur une
  // coquille qui n'a pas fini de se monter.
  interfaceDeDeverrouillage = monterLInterface({
    document,
    racine: document,
    demander: demanderAuWorker,
    // Les deux dérivations sont gardées par la MORT, et pas seulement les questions au Worker.
    // Sans cette garde, une phrase présentée sur un coffre dont l'enveloppe porte déjà un
    // emplacement partirait droit dans Argon2id — deux secondes de calcul pour une KEK que
    // personne ne pourrait plus recevoir. « Ne dérive rien tant que personne n'a agi » se tient
    // ici, à l'entrée du calcul, et pas seulement à l'entrée du canal.
    deriverPhrase: (appel) => siVivant(() => derivations.deriverPhrase(appel)),
    deriverPasskey: (appel) => siVivant(() => derivations.deriverPasskey(appel)),
    agent: navigator.userAgent,
    surEtat: (reponse) => {
      rapport.etat = reponse.etat;
      rapport.barrieres = reponse.barrieres;
      rapport.journal.push("volume-ouvert");
      // C'est ICI que le délai s'arme pour de bon : un coffre vient de s'ouvrir, et la durée que
      // l'ADR 0029 limite 2 laissait à la KEK commence à être bornée.
      refletDeLEtat();
      publier();
    },
    surMesure: (instant) => {
      if (instant === "geste") {
        departDuGeste = performance.now();
        return;
      }
      if (departDuGeste === null) return;
      const ecoule = Math.round((performance.now() - departDuGeste) * 10) / 10;
      rapport.mesures[instant === "annonce" ? "annonceApresLeGesteMs" : "deverrouillageMs"] =
        ecoule;
      publier();
    },
  });
  await interfaceDeDeverrouillage.rafraichirLInventaire();
  await demanderLEtat();
  rapport.journal.push("interface-de-deverrouillage-montee");
  const gestes = brancherLesGestesDuCycle({
    racine: document,
    demander: demanderAuWorker,
    cycle,
    rapport,
    publier,
    // Le chronomètre part au DÉBUT du geste, quel que soit son déclencheur. Un verrouillage
    // déclenché par le délai n'a pas de clic à mesurer, et une mesure qui n'existerait que pour le
    // bouton ne dirait rien du second chemin.
    avantVerrouillage: () => {
      departDuVerrouillage = performance.now();
    },
    // L'ORDRE a refusé, et le geste n'a jamais atteint le Worker : le coffre est légitimement encore
    // ouvert, et ce qu'il faut est RÉARMER le délai que la surveillance venait de désarmer. Rien
    // n'est terminé, rien n'est retiré — il ne s'est rien passé d'autre qu'un « pas maintenant ».
    apresRefusDOrdre: (code) => {
      rapport.verrouillage = { refuse: true, code, horsOrdre: true };
      departDuVerrouillage = null;
      refletDeLEtat();
      publier();
    },
    // Le WORKER a refusé : la conduite est celle de `conduiteApresUnRefusDeVerrouillage`.
    apresRefusDeVerrouillage: (code, declencheur) => acheverUnRefus(code, declencheur),
    // Le `terminate()` vient APRÈS le `close()` que le Worker vient de faire, et c'est la troisième
    // cause de mort — celle que la coquille se donne à elle-même. La conduite est la même que pour
    // les deux autres : refuser tout service jusqu'à un geste explicite.
    apresVerrouillage: (declencheur) => {
      worker.terminate();
      acheverLeVerrouillage(declencheur);
    },
    // L'étape 3 vient de conclure : si le coffre est ouvert, le délai reprend sa course. Sans ce
    // rappel, un boot laissait la surveillance désarmée jusqu'à la prochaine réponse d'état.
    apresDemarrage: () => refletDeLEtat(),
  });
  verrouillerLeCoffre = gestes.verrouillerLeCoffre;

  // ÉTAPE 3, conclue AVANT tout cadre. Au démarrage ordinaire le volume est verrouillé : il n'y a
  // ni backend ni VM, et l'étape est conclue `differee` plutôt que sautée. C'est ce qui rend l'ordre
  // tenable sans mentir — le journal dit ce qui n'a pas eu lieu, et pourquoi le cadre peut suivre.
  inscrire("backendPuisVm", ISSUES_DETAPE.differee, "volume-verrouille");
  publier();

  if (cible === null) return terminer("sans-cadre", "coquille:origine-applicative-indeterminee");
  // ÉTAPE 4. `peutEncadrer` est une GARDE, pas une formalité : elle refuse le cadre tant que
  // l'étape 3 n'a rien conclu, et c'est ce qui empêche l'ordre des huit étapes de redevenir une
  // description.
  if (!cycle.peutEncadrer()) {
    return terminer("erreur", `coquille:erreur:${CODES_REFUS_COQUILLE.etapeHorsOrdre}`);
  }
  creerLeCadre(cible.url);
  inscrire("cadreEtPort", ISSUES_DETAPE.franchie);
  return terminer("prete", "coquille:prete");
}

/**
 * Marque une surveillance NEUTRALISÉE. Ce n'est pas une conduite : c'est l'absence de conduite,
 * posée pour que le `terminate()` d'un démarrage refusé ne se lise pas comme une mort constatée.
 */
const SANS_SURVEILLANCE = Object.freeze({
  cause: "neutralisee",
  etat: ETATS_DU_VOLUME.indisponible,
  code: CODES_REFUS_COQUILLE.capaciteManquante,
});

/**
 * L'état PRIVILÉGIÉ, avec ce que le port restreint ne reçoit jamais : le constat d'exclusivité.
 *
 * `demanderLEtat` rend la charge utile EXACTE du port restreint (`chargeUtileDEtat`, deux champs) ;
 * celle-ci rend la réponse entière du canal privilégié. Les deux existent pour que la frontière soit
 * dans le code et non dans la mémoire de qui l'écrit.
 */
async function demanderLEtatPrivilegie() {
  try {
    return await demanderAuWorker("etat");
  } catch {
    return rapportDEtat();
  }
}

/**
 * ACHÈVE le verrouillage : constate l'état, publie la mesure, PUIS recharge la coquille.
 *
 * L'ordre de ces trois-là est le contrat de cette tranche, autant que celui du Worker :
 *
 *  1. **la conduite est posée** — l'état devient `verrouille`, toute demande en vol reçoit son refus
 *     typé, la poussée de barrière cesse, l'interface de déverrouillage est remontée, et le bouton
 *     « Rouvrir le coffre » n'est PAS offert (c'est l'asymétrie avec la mort : la coquille recharge
 *     d'elle-même, et un bouton qui disparaîtrait dans la milliseconde ne dirait rien) ;
 *  2. **le relevé est publié**, `mesures.verrouillageMs` compris. C'est la seule fenêtre où il
 *     existe : le document qui revient du rechargement est neuf, et son relevé recommence à zéro ;
 *  3. **la coquille recharge**, et c'est ce qui retire le cadre applicatif.
 *
 * **Pourquoi le rechargement, et non un retrait du cadre.** Les pixels du cadre sont le dernier
 * clair de la session ; un coffre verrouillé n'a jamais un cadre affiché. Retirer l'élément et le
 * recréer plus tard demanderait de reformuler l'unicité du port de #161 — `VAULT_COQUILLE_ANNONCE_
 * UNIQUE` refuse un second octroi — en « un port par cadre », c'est-à-dire d'ajouter un compteur
 * dans la base de confiance. Le rechargement rejoue le cycle depuis l'étape 1 et emporte le Worker
 * de toute façon : base de confiance plus petite, et un seul chemin pour deux conduites (#163 le
 * prend déjà pour son bouton « Rouvrir le coffre »).
 *
 * **Ce que le rechargement PERD**, dit plutôt que tu : l'attente annoncée en cours (#162) et le
 * relevé de mesures de la session — `annonceApresLeGesteMs`, `deverrouillageMs`, et `verrouillageMs`
 * lui-même. C'est le prix, et il est écrit dans l'ADR 0031.
 *
 * **Ce n'est PAS une réouverture** : après le rechargement, la coquille est en `verrouille`,
 * l'interface de déverrouillage est remontée, aucune dérivation ne part sans geste, et aucune KEK
 * n'est gardée.
 */
function acheverLeVerrouillage(declencheur) {
  const conduite = conduiteApresLeVerrouillage({ etatConnu: rapport.etat });
  constaterLaMort(conduite.cause, { offrirLeGesteQuiRouvre: conduite.gesteQuiRouvreOffert });
  if (departDuVerrouillage !== null) {
    rapport.mesures.verrouillageMs =
      Math.round((performance.now() - departDuVerrouillage) * 10) / 10;
  }
  rapport.verrouillage = {
    declencheur,
    delaiDInactiviteMs: surveillance.delaiMs,
    etat: conduite.etat,
    // Le vocabulaire est celui de l'ADR 0021 décision 7 : ce qui s'écrit est « le Worker qui
    // détenait les clés est mort ». « Les clés sont effacées » ne s'écrit pas, et ne s'écrira pas.
    workerTermine: true,
    kekRetenue: conduite.kekRetenue,
    derivationPermise: conduite.derivationPermise,
    pousseeDeBarriere: conduite.pousseeDeBarriere,
    reouvertureAutomatique: conduite.reouvertureAutomatique,
    instantaneRetire: conduite.instantaneRetire,
    rechargerLaCoquille: conduite.rechargerLaCoquille,
  };
  terminer("verrouille", `coquille:verrouille:${rapport.verrouillage.declencheur}`);
  if (conduite.rechargerLaCoquille) rechargerLaCoquille();
}

/**
 * ACHÈVE un verrouillage REFUSÉ : le refus est publié AVANT tout, le Worker est terminé, le cadre
 * est retiré, et la coquille NE recharge pas.
 *
 * L'ordre des trois est le contrat de ce chemin-là autant que celui de l'autre. Le refus est écrit
 * d'abord parce qu'il est la seule chose que l'utilisateur ait à apprendre ; le `terminate()` suit
 * parce que le Worker ne sert plus rien — sa KEK est déjà partie par le `finally` de `relacherTout`
 * — ; le cadre part enfin, parce que laisser ses pixels sur un coffre dont l'utilisateur vient de
 * demander le verrouillage est le contraire de la promesse.
 *
 * **Aucun port n'est re-octroyé.** `rapport.portOctroye` reste vrai, si bien que la garde
 * `VAULT_COQUILLE_ANNONCE_UNIQUE` de #161 continue de refuser un second octroi : le cadre part, il
 * ne revient qu'au rechargement, et l'unicité du port n'est pas reformulée pour autant.
 */
function acheverUnRefus(code, declencheur) {
  const conduite = conduiteApresUnRefusDeVerrouillage({ code, etatConnu: rapport.etat });
  rapport.verrouillage = {
    refuse: true,
    codeDuRefus: conduite.codeDuRefus,
    declencheur,
    delaiDInactiviteMs: surveillance.delaiMs,
    workerTermine: conduite.terminerLeWorker,
    cadreRetire: conduite.retirerLeCadre,
    rechargerLaCoquille: conduite.rechargerLaCoquille,
    instantaneGaranti: conduite.instantaneGaranti,
    kekRetenue: conduite.kekRetenue,
  };
  publier();
  if (conduite.terminerLeWorker) worker.terminate();
  constaterLaMort(conduite.cause, { offrirLeGesteQuiRouvre: conduite.gesteQuiRouvreOffert });
  if (conduite.retirerLeCadre) retirerLeCadre();
  terminer("verrouillage-refuse", `coquille:verrouillage-refuse:${code ?? "inconnu"}`);
}

/** RETIRE le cadre applicatif du document. Le port n'est pas re-octroyé : la garde de #161 tient. */
function retirerLeCadre() {
  cadre?.remove();
  cadre = null;
  rapport.cadreApplicatif = "retire";
}

/**
 * RECHARGE la coquille, au tour de boucle SUIVANT.
 *
 * Le report d'un tour n'est pas une temporisation : il laisse le navigateur peindre l'état publié
 * juste au-dessus, et il laisse les observateurs de mutation du document — ceux du DOM, pas ceux du
 * produit — voir le relevé qui décrit ce verrouillage. Sans lui, la navigation partirait dans la
 * même tâche que l'écriture, et la dernière chose que la coquille a à dire serait perdue.
 */
function rechargerLaCoquille() {
  setTimeout(() => location.reload(), 0);
}

/**
 * OFFRE le geste qui ROUVRE : un bouton, révélé par la mort, qui RECHARGE la coquille.
 *
 * « Refuser tout service jusqu'à un geste explicite » n'était pas tenu tant qu'aucun geste ne
 * rouvrait : la coquille refusait, et rien ne la relevait (constat 5 de la revue de la PR #171).
 *
 * Le geste RECHARGE plutôt qu'il ne ressuscite, et c'est une décision : un Worker recréé en place
 * hériterait d'un cadre applicatif dont le port est mort et d'un relevé qui décrit une session
 * finie. Le rechargement rejoue le cycle depuis l'étape 1 — capacités, exclusivité, canal, cadre —
 * et c'est le même chemin que la Definition of Ready de #25 retient pour retirer le cadre au
 * verrouillage : un seul chemin pour deux conduites.
 *
 * Il n'est JAMAIS automatique. Redemander le geste à la place de l'utilisateur est l'autre option
 * de la Definition of Ready de #24, et l'ADR 0030 la range dans les alternatives rejetées.
 */
function offrirLaReouverture() {
  const bouton = document.querySelector("#rouvrir-la-coquille");
  if (bouton === null) return;
  bouton.hidden = false;
  bouton.addEventListener("click", () => location.reload(), { once: true });
}

/**
 * REMONTE l'interface de déverrouillage après une mort. Montrée, pas actionnée : aucun geste n'est
 * déclenché, aucune dérivation n'est lancée, et l'inventaire n'est PAS redemandé — il n'y a plus
 * personne pour le rendre.
 *
 * Si l'interface était déjà montée, elle le reste : la remonter en créerait une seconde, avec deux
 * écouteurs par bouton.
 */
function remonterLInterface() {
  if (interfaceDeDeverrouillage !== null) return;
  interfaceDeDeverrouillage = monterLInterface({
    document,
    racine: document,
    demander: () => Promise.reject(refusDeMort()),
    deriverPhrase: () => Promise.reject(refusDeMort()),
    deriverPasskey: () => Promise.reject(refusDeMort()),
    agent: navigator.userAgent,
  });
}

/** La poignée de l'interface, une fois montée. Elle ne détient aucune clé. */
let interfaceDeDeverrouillage = null;

/**
 * Les deux dérivations que la PAGE fait elle-même (`derivation-dans-la-page.mjs`), liées au canal
 * privilégié de cette coquille. Elles ne détiennent aucune clé non plus : ce qui en sort est une
 * `CryptoKey` non extractible, qui repart aussitôt par `enveloppePrivilegiee`.
 */
const derivations = derivationsDeLaPage({
  demanderAuWorker,
  urlDuWorker: new URL("./derivation-worker.mjs", import.meta.url),
});

/**
 * L'instant du dernier GESTE de l'utilisateur, origine des deux mesures de #162.
 *
 * Elles ne partent PAS de l'évaluation du module, comme les deux autres du relevé : ce qu'elles
 * mesurent est un délai RESSENTI — entre un clic et une phrase à l'écran, entre un clic et un
 * coffre ouvert —, et le compter depuis le chargement de la page y ajouterait tout ce que
 * l'utilisateur a passé à taper.
 */
let departDuGeste = null;

/** @param {string} etat @param {string} texte */
function terminer(etat, texte) {
  document.documentElement.dataset.coquille = etat;
  noeudEtat.textContent = texte;
  publier();
}

demarrer().catch((erreur) => {
  // Une MORT constatée a déjà tenu sa conduite, et elle a déjà écrit l'état de la coquille. Le
  // démarrage qu'elle interrompt remonte ensuite ici — `rafraichirLInventaire` rejette, comme tout
  // geste après la mort —, et écraser « worker-mort » par « erreur » ferait perdre au relevé la
  // seule chose qu'il ait à dire de ce moment-là.
  if (mortDuWorker !== null) return;
  // Un compteur, comme partout ailleurs dans ce relevé : il portait un `push` sur un NOMBRE depuis
  // que la revue de la PR #166 a remplacé les tableaux par des compteurs, si bien que l'unique
  // chemin d'erreur du démarrage levait au lieu de rendre son état. Le défaut ne se voyait qu'au
  // moment où quelque chose d'autre avait déjà échoué.
  rapport.requetesRefusees += 1;
  compter(rapport.refusDeRequete, CODES_REFUS_COQUILLE.typeInconnu);
  terminer("erreur", `coquille:erreur:${String(erreur?.code ?? "demarrage")}`);
});
