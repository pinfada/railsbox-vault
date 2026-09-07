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
import { ETATS_DU_VOLUME, chargeUtileDEtat } from "/src/coquille/etat-de-la-coquille.mjs";
import { monterLInterface } from "/src/coquille/interface-de-deverrouillage.mjs";
import { DELAI_PASSKEY_MS, DELAI_WORKER_MORT_MS } from "/src/coquille/moyens-de-deverrouillage.mjs";
import { cadreApplicatif } from "/src/coquille/origines-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "/src/coquille/refus-de-coquille.mjs";
import {
  derivateurWebauthnPrf,
  enregistrerEmplacementPrf,
} from "/src/vm/derivation/derivateur-webauthn-prf.mjs";
import { TYPES_KEK } from "/src/vm/enveloppe/identite-enveloppe.mjs";
import { octetsEnHex } from "/src/vm/format-chiffre/octets.mjs";

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
    publier();
  }
  if (decode.type === TYPES_PRIVILEGIES.deverrouillageReponse) {
    rapport.etat = decode.message.etat;
    rapport.barrieres = decode.message.barrieres;
    publier();
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
  corrélationSuivante += 1;
  const correlation = `c${corrélationSuivante}`;
  return new Promise((rendre, refuser) => {
    // La borne d'un Worker MORT. Sans elle, une promesse en suspens ne se règle jamais : le
    // `finally` de `surRequeteApplicative` ne se déclenche pas, les trente-deux emplacements se
    // remplissent, et le port restreint se ferme pour de bon. Le refus est TYPÉ, comme tous les
    // autres, et il porte le code de la coquille — jamais un code du Worker, qui n'a rien dit.
    const minuterie = setTimeout(() => {
      demandesEnVol.delete(correlation);
      refuser(
        Object.assign(
          new Error(
            "Le Worker de confiance n'a pas répondu dans le délai : il est bloqué ou il est mort.",
          ),
          { code: CODES_REFUS_COQUILLE.typeInconnu },
        ),
      );
    }, DELAI_WORKER_MORT_MS);
    const clore = (geste) => (valeur) => {
      clearTimeout(minuterie);
      geste(valeur);
    };
    demandesEnVol.set(correlation, { rendre: clore(rendre), refuser: clore(refuser) });
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

  // L'interface est montée AVANT le cadre applicatif, et l'ordre est celui de l'ADR 0028 : rien de
  // ce que la coquille sert au document applicatif ne dépend du déverrouillage, mais le contraire
  // serait une inversion — un cadre créé d'abord aurait, pendant un instant, un port sur une
  // coquille qui n'a pas fini de se monter.
  interfaceDeDeverrouillage = monterLInterface({
    document,
    racine: document,
    demander: demanderAuWorker,
    deriverPhrase,
    deriverPasskey,
    agent: navigator.userAgent,
    surEtat: (reponse) => {
      rapport.etat = reponse.etat;
      rapport.barrieres = reponse.barrieres;
      rapport.journal.push("volume-ouvert");
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
  publier();

  if (cible === null) return terminer("sans-cadre", "coquille:origine-applicative-indeterminee");
  creerLeCadre(cible.url);
  return terminer("prete", "coquille:prete");
}

/** La poignée de l'interface, une fois montée. Elle ne détient aucune clé. */
let interfaceDeDeverrouillage = null;

/**
 * L'instant du dernier GESTE de l'utilisateur, origine des deux mesures de #162.
 *
 * Elles ne partent PAS de l'évaluation du module, comme les deux autres du relevé : ce qu'elles
 * mesurent est un délai RESSENTI — entre un clic et une phrase à l'écran, entre un clic et un
 * coffre ouvert —, et le compter depuis le chargement de la page y ajouterait tout ce que
 * l'utilisateur a passé à taper.
 */
let departDuGeste = null;

/**
 * DÉRIVE la KEK d'une phrase dans un WORKER DÉDIÉ, et rend ce que le Worker de confiance attend.
 *
 * C'est la décision 5 de l'ADR 0029, réécrite après la revue de sécurité de la PR #167. Argon2id est
 * un appel WebAssembly SYNCHRONE : le fil qui le porte ne dispatche plus aucun message pendant deux
 * secondes sur le moteur le plus lent. Le porter dans le Worker de CONFIANCE laissait donc le
 * document applicatif sans réponse — et la première correction, qui sortait la question d'état de la
 * file de promesses de ce Worker, ne pouvait rien : il n'y a pas de file qui tienne quand le fil est
 * pris.
 *
 * **C'est la PAGE qui crée ce Worker, et non le Worker de confiance.** Les deux étaient possibles ;
 * celui-ci a trois motifs, dont un seul suffirait :
 *
 *  - il ne demande AUCUNE capacité nouvelle. Un Worker imbriqué en exigerait une que
 *    `docs/compatibility.md` ne mesure sur aucun des trois moteurs, et #162 n'a pas à ajouter une
 *    ligne au dossier de portabilité pour un calcul ;
 *  - il donne UNE seule forme aux deux moyens dérivés hors du Worker de confiance. La passkey l'est
 *    déjà, parce que `navigator.credentials` n'existe que dans un document ; la phrase le devient, et
 *    le Worker de confiance reçoit dans les deux cas exactement la même chose — une `CryptoKey` non
 *    extractible, par la même porte, sous la même garde ;
 *  - il RÉDUIT ce que le Worker de confiance fait. Il gardait un calcul qui n'avait besoin d'aucun
 *    de ses handles : ni l'OPFS, ni l'enveloppe, ni la clé de volume n'entrent dans une dérivation.
 *
 * Ce qui ne change pas : la phrase ne quitte pas l'origine de CONFIANCE. Elle franchit un port de
 * plus, à l'intérieur de la même origine — c'est la limite 4 de l'ADR 0021, inchangée dans sa nature
 * et dite une fois de plus.
 */
async function deriverPhrase({ inventaire, phrase }) {
  const existant = (inventaire?.emplacements ?? []).find(
    (emplacement) => emplacement.typeKek === TYPES_KEK.phrase,
  );
  const identite =
    existant === undefined
      ? await demanderAuWorker("preparation", { moyen: "phrase" })
      : {
          identifiantVolume: inventaire.identifiantVolume,
          identifiantEmplacement: existant.identifiantEmplacement,
          parametresHex: existant.parametresHex,
        };
  const rendu = await dansLeWorkerDeDerivation({ ...identite, phrase });
  return {
    kek: rendu.kek,
    parametresHex: rendu.parametresHex,
    identifiantEmplacement: identite.identifiantEmplacement,
  };
}

/**
 * Fait tourner UN Worker de dérivation, et le laisse mourir.
 *
 * Un Worker par geste : il se ferme lui-même après avoir répondu (`self.close()`), et son tas — la
 * phrase comprise — s'en va avec lui. C'est plus franc qu'un effacement, que le langage ne permet
 * pas sur une `string` (ADR 0021, décision 7), et c'est un effet du découpage plutôt qu'une promesse.
 * `terminate()` est appelé de ce côté-ci aussi : un Worker qui n'a pas répondu ne doit pas survivre à
 * l'attente de sa réponse.
 */
function dansLeWorkerDeDerivation(appel) {
  const worker = new Worker(new URL("./derivation-worker.mjs", import.meta.url), {
    type: "module",
    name: "vault-derivation",
  });
  return new Promise((rendre, refuser) => {
    const finir = (geste) => {
      worker.terminate();
      geste();
    };
    worker.addEventListener("message", (event) => {
      const rendu = event.data ?? {};
      if (rendu.ok) return finir(() => rendre(rendu));
      finir(() =>
        refuser(
          Object.assign(new Error(rendu.message ?? "dérivation refusée"), { code: rendu.code }),
        ),
      );
    });
    worker.addEventListener("error", (event) => {
      finir(() =>
        refuser(
          Object.assign(new Error(`Le Worker de dérivation a échoué : ${event.message}`), {
            code: CODES_REFUS_COQUILLE.typeInconnu,
          }),
        ),
      );
    });
    worker.postMessage(appel);
  });
}

/**
 * DÉRIVE la KEK d'une passkey, DANS LA PAGE, et rend ce que le Worker attend.
 *
 * `navigator.credentials` n'existe pas dans un Worker (ADR 0021, décision 5) : cet appel DOIT
 * partir d'un document, et c'est la seule dérivation que la coquille fasse elle-même. Ce qui repart
 * vers le Worker est la `CryptoKey` NON EXTRACTIBLE ; la sortie PRF brute ne quitte jamais cette
 * page, et aucune variable de ce module ne la retient.
 *
 * Deux chemins, et ils ne se confondent pas :
 *
 *  - le coffre EXISTE et porte un emplacement `webauthn-prf` : une ASSERTION refait la KEK sous les
 *    paramètres publics déjà écrits, que le Worker a rendus en hexadécimal ;
 *  - le coffre n'existe pas : un ENREGISTREMENT crée la passkey, et la page rend les paramètres
 *    publics avec la clé, pour que le Worker pose l'enveloppe sous exactement cet emplacement.
 */
async function deriverPasskey({ inventaire }) {
  const existant = (inventaire?.emplacements ?? []).find(
    (emplacement) => emplacement.typeKek === TYPES_KEK["webauthn-prf"],
  );
  const derivateur = derivateurWebauthnPrf();
  if (existant !== undefined) {
    const kek = await derivateur.deriver({
      parametres: octetsDeLHex(existant.parametresHex),
      identite: {
        identifiantVolume: inventaire.identifiantVolume,
        identifiantEmplacement: existant.identifiantEmplacement,
      },
      // La BORNE est celle de la coquille, aux DEUX appels. Sans elle, un moteur sans
      // authentificateur laisse la promesse en suspens une MINUTE — le défaut de la première
      // exécution de #162 en intégration continue : `#deverrouillage-refus` restait vide pendant que
      // la page attendait le délai par défaut du module.
      geste: { delaiMs: DELAI_PASSKEY_MS },
    });
    return { kek };
  }
  const enregistre = await enregistrerEmplacementPrf({
    rpId: location.hostname,
    nomUtilisateur: "vault",
    identifiantUtilisateur: crypto.getRandomValues(new Uint8Array(16)),
    delaiMs: DELAI_PASSKEY_MS,
  });
  // L'identité de l'emplacement est DEMANDÉE au Worker de confiance, et non recopiée ici : la KEK y
  // est liée par son info HKDF (ADR 0021), et l'identifiant de volume que le Worker pose est la
  // seule vérité sur ce point. La page en tenait une COPIE, avec un cliquet pour la surveiller ; la
  // demander est plus court, et ne peut pas diverger.
  const prepare = await demanderAuWorker("preparation", { moyen: "webauthn-prf" });
  const kek = await derivateur.deriver({
    parametres: enregistre.parametres,
    identite: {
      identifiantVolume: prepare.identifiantVolume,
      identifiantEmplacement: prepare.identifiantEmplacement,
    },
    geste: {},
  });
  return {
    kek,
    parametresHex: octetsEnHex(enregistre.parametres),
    identifiantEmplacement: prepare.identifiantEmplacement,
  };
}

/** Relit une chaîne hexadécimale en octets. La page n'importe pas le décodeur du format pour cela. */
function octetsDeLHex(hex) {
  return Uint8Array.from(String(hex).match(/../g) ?? [], (paire) => Number.parseInt(paire, 16));
}

/** @param {string} etat @param {string} texte */
function terminer(etat, texte) {
  document.documentElement.dataset.coquille = etat;
  noeudEtat.textContent = texte;
  publier();
}

demarrer().catch((erreur) => {
  // Un compteur, comme partout ailleurs dans ce relevé : il portait un `push` sur un NOMBRE depuis
  // que la revue de la PR #166 a remplacé les tableaux par des compteurs, si bien que l'unique
  // chemin d'erreur du démarrage levait au lieu de rendre son état. Le défaut ne se voyait qu'au
  // moment où quelque chose d'autre avait déjà échoué.
  rapport.requetesRefusees += 1;
  compter(rapport.refusDeRequete, CODES_REFUS_COQUILLE.typeInconnu);
  terminer("erreur", `coquille:erreur:${String(erreur?.code ?? "demarrage")}`);
});
