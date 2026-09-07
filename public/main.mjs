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
  sansCapacite,
} from "/src/coquille/contrat-de-messages.mjs";
import { ETATS_DU_VOLUME, chargeUtileDEtat } from "/src/coquille/etat-de-la-coquille.mjs";
import { cadreApplicatif } from "/src/coquille/origines-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "/src/coquille/refus-de-coquille.mjs";

/**
 * Paramètre du CHEMIN encadré. En production, ce que la coquille encadre est ce que l'utilisateur
 * demande à l'application — `/commandes/42` aussi bien que `/`. L'ORIGINE, elle, n'est jamais un
 * paramètre : elle est dérivée par `origines-de-la-coquille.mjs`.
 */
const PARAMETRE_CHEMIN = "document-applicatif";

/**
 * Paramètre du geste de déverrouillage du HARNAIS. Sa VALEUR n'est écrite nulle part dans les
 * fichiers publiés : le jeton exact vit dans `src/vm/cle-de-volume.mjs`, derrière la garde que
 * `tests/unit/harnais-portes.test.mjs` surveille. La tranche 2 remplace ce paramètre par une
 * interface de saisie.
 */
const PARAMETRE_HARNAIS = "deverrouillage-harnais";

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
  deverrouillageParHarnais: false,
  // Le JOURNAL des étapes, dans l'ordre où elles ont eu lieu. Il rend l'ordre du cycle de vie
  // OBSERVABLE plutôt que promis : l'épreuve lit une suite, pas une affirmation.
  journal: [],
  gestesAdmis: GESTES_ADMIS.map(({ type }) => type),
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
  // le coût du cadre ferait porter à l'assemblage une attente qui n'est pas la sienne.
  mesures: { canalPrivilegieMs: null, deverrouillageMs: null, cadreApplicatifMs: null },
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

const worker = new Worker(new URL("./runtime-worker.mjs", import.meta.url), {
  type: "module",
  name: "vault-coquille-confiance",
});
const privilegie = new MessageChannel();

/**
 * Les demandes d'état EN VOL vers le Worker, dans l'ordre où elles sont parties.
 *
 * Une FILE, et non une variable : le Worker traite le canal privilégié en série
 * (`runtime-worker.mjs`) et répond dans l'ordre, si bien que la plus ancienne demande est toujours
 * celle que la prochaine réponse sert. Une variable unique écrasait la précédente, et la réponse
 * qui lui revenait était jetée faute de destinataire — c'est le SILENCE que la revue de la PR #166
 * a mesuré sur le seul geste que la coquille admette.
 */
const demandesEnVol = [];

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
    publier();
    const rendre = demandesEnVol.shift();
    if (rendre) rendre(chargeUtileDEtat({ etat: rapport.etat, barrieres: rapport.barrieres }));
    return;
  }
  if (decode.type === TYPES_PRIVILEGIES.barriere) {
    rapport.barrieres = decode.message.barrieres;
    publier();
    pousserLaBarriere();
    return;
  }
  if (decode.type === TYPES_PRIVILEGIES.refus) {
    rapport.requetesRefusees += 1;
    compter(rapport.refusDeRequete, decode.message.code);
    publier();
  }
}

/** Aller-retour vers le Worker de confiance. Chaque demande a sa place dans la file. */
function demanderLEtat() {
  return new Promise((rendre) => {
    demandesEnVol.push(rendre);
    privilegie.port1.postMessage(enveloppeDeMessage(TYPES_PRIVILEGIES.etat));
  });
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
  demanderLEtat().then((charge) => {
    correlationsEnVol.delete(verdict.correlation);
    port.postMessage(
      enveloppeDeMessage(
        TYPES_APPLICATIFS.etatReponse,
        sansCapacite({ correlation: verdict.correlation, ...charge }),
      ),
    );
  });
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
  const cible = cadreApplicatif(location.origin, parametres.get(PARAMETRE_CHEMIN));
  rapport.origineApplicative = cible?.origineApplicative ?? null;

  // Le canal est établi quand le Worker a répondu : une promesse tenue, pas un `postMessage` émis.
  await demanderLEtat();
  rapport.canalPrivilegie = "etabli";
  rapport.journal.push("canal-privilegie-etabli");
  mesurer("canalPrivilegieMs");
  publier();

  const jeton = parametres.get(PARAMETRE_HARNAIS);
  if (jeton) await deverrouillerParLeHarnais(jeton);
  mesurer("deverrouillageMs");

  if (cible === null) return terminer("sans-cadre", "coquille:origine-applicative-indeterminee");
  creerLeCadre(cible.url);
  return terminer("prete", "coquille:prete");
}

/** @param {string} jeton */
async function deverrouillerParLeHarnais(jeton) {
  rapport.deverrouillageParHarnais = true;
  privilegie.port1.postMessage(enveloppeDeMessage(TYPES_PRIVILEGIES.deverrouiller, { jeton }));
  await demanderLEtat();
}

/** @param {string} etat @param {string} texte */
function terminer(etat, texte) {
  document.documentElement.dataset.coquille = etat;
  noeudEtat.textContent = texte;
  publier();
}

demarrer().catch((erreur) => {
  rapport.requetesRefusees.push({
    code: CODES_REFUS_COQUILLE.typeInconnu,
    recu: String(erreur?.code ?? "demarrage"),
  });
  terminer("erreur", "coquille:erreur");
});
