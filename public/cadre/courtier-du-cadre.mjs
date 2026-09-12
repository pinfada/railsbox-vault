// LE COURTIER de la coquille de cadre (#192, ADR 0038).
//
// Il est la moitié « document » du mécanisme dont le Service Worker est l'autre moitié. Son rôle
// tient en une phrase : il détient le port restreint que la coquille lui a octroyé, il ne le prête à
// personne, et il relaie les requêtes que le Service Worker lui présente — une fois l'application
// démarrée, et pas avant.
//
// ## Pourquoi le document servi est un cadre IMBRIQUÉ
//
// Parce que le port restreint n'est octroyé QU'UNE FOIS (ADR 0028, décision 2, cinquième condition :
// l'unicité). Un document qui naviguerait vers la page Rails perdrait son port et ne pourrait pas en
// redemander. Le courtier reste donc immobile, et ce qui navigue est un cadre imbriqué, sur la MÊME
// origine. La coquille refuse toute annonce venue d'une autre fenêtre que le cadre qu'elle a créé
// (`VAULT_COQUILLE_ANNONCE_FENETRE`) : une page Rails qui réclamerait son propre port est refusée.
//
// ## Ce que la page servie peut faire, et pourquoi ce n'est pas un défaut
//
// Le cadre imbriqué est de MÊME ORIGINE que ce courtier : la page Rails peut lire ses variables et
// atteindre le port restreint par `parent`. C'est la conséquence de l'ADR 0018 § 4 — l'origine EST
// l'identité. Ce qu'elle y gagne est exactement ce que le port admet ; les dix refus tiennent.
//
// ## L'ATTENTE du démarrage (revue d'intégration de la PR #203, constat 1)
//
// Le cadre est créé à l'étape 4 du cycle ; l'application ne démarre qu'au geste de l'utilisateur qui
// suit, parfois des minutes plus tard. Ce courtier REDEMANDAIT la page toutes les dix secondes,
// trente fois, puis abandonnait POUR TOUJOURS : l'utilisateur restait devant un 504 en texte brut,
// sans geste pour en sortir. Il fait désormais ceci :
//
//  1. il pose UNE question — la première page — pour savoir si l'application tourne déjà ;
//  2. tant qu'elle ne tourne pas, il ne relaie RIEN : le Service Worker reçoit « en attente » et
//     rend une page qui le dit, depuis combien de temps, avec un geste ;
//  3. l'ANNONCE DE BARRIÈRE que la coquille pousse au démarrage le réveille : il repose la question,
//     et le cadre se remplace de lui-même. Aucune horloge, aucun essai compté, aucun abandon
//     définitif — une annonce réveille l'attente quel que soit ce qui s'est passé avant.

import { CONTRAT_DU_CADRE, TYPES_DU_CADRE, origineDistincteDuParent } from "./contrat-du-cadre.mjs";
import {
  TYPES_APPLICATIFS,
  decoderMessage,
  enveloppeDeMessage,
} from "/src/coquille/contrat-de-messages.mjs";
import { cheminRelayable } from "/src/coquille/relais-http.mjs";
import { CODES_REFUS_COQUILLE } from "/src/coquille/refus-de-coquille.mjs";

/** Chemin de l'application que le cadre imbriqué demande d'abord. */
const CHEMIN_INITIAL_PAR_DEFAUT = "/";

/** Paramètre par lequel une épreuve demande un autre chemin d'entrée. Jamais une autre ORIGINE. */
const PARAMETRE_CHEMIN = "chemin";

/** Les trois états de l'application, vus du courtier. */
const APPLICATION = Object.freeze({
  /** On ne sait pas : la prochaine requête est relayée, et son sort le dira. */
  inconnue: "inconnue",
  /** Le relais a répondu « pas encore » : rien n'est relayé jusqu'à la prochaine annonce. */
  enAttente: "en-attente",
  /** Une requête a été servie : tout est relayé. */
  demarree: "demarree",
});

/**
 * Le PORT détenu par ce document, ou `null`. C'est la seule chose que la question de présence du
 * Service Worker consulte (revue de sécurité de la PR #203, constat 2) : un document sur le chemin
 * du courtier qui ne détient aucun port n'est PAS un courtier, et il le dit.
 */
let portDetenu = null;

// La réponse à la PRÉSENCE est branchée à l'évaluation du module, AVANT tout port : un onglet ouvert
// à la main sur ce chemin doit répondre « sans port » plutôt que se taire — un silence rendrait le
// candidat INCERTAIN, et le routage refuserait de servir le vrai coffre.
navigator.serviceWorker?.addEventListener("message", (event) => {
  const [reponse] = event.ports;
  if (!reponse || !estDuContratDuCadre(event.data)) return;
  if (event.data.type !== TYPES_DU_CADRE.presence) return;
  reponse.postMessage(
    enveloppeDuCadre(TYPES_DU_CADRE.presenceReponse, { porte: portDetenu !== null }),
  );
});

// Les messages du Service Worker ne sont DISTRIBUÉS qu'une fois la file du client ouverte : un
// `addEventListener` ne l'ouvre pas partout (Firefox la garde fermée jusqu'à `startMessages`).
navigator.serviceWorker?.startMessages?.();

function estDuContratDuCadre(donnee) {
  return donnee?.contrat === CONTRAT_DU_CADRE.id && donnee?.version === CONTRAT_DU_CADRE.version;
}

function enveloppeDuCadre(type, champs = {}) {
  return { contrat: CONTRAT_DU_CADRE.id, version: CONTRAT_DU_CADRE.version, type, ...champs };
}

/**
 * MONTE la coquille de cadre sur un port restreint fraîchement octroyé.
 *
 * @param {object} config
 * @param {MessagePort} config.port le port restreint, détenu par l'appelant et jamais transféré
 * @param {Document} config.document
 * @param {Element} config.emplacement où le cadre imbriqué est inséré
 * @param {(fait: Record<string, unknown>) => void} config.publier ce que le relevé du document dit
 * @returns {{ installee: boolean, motif: string | null }}
 */
export function monterLaCoquilleDeCadre({ port, document, emplacement, publier }) {
  if (!origineDistincteDuParent(globalThis)) {
    // Le TÉMOIN POSITIF en même origine passe par ici, et rien ne s'y installe : l'ADR 0030
    // décision 4 refuse un Service Worker dans la frontière de confiance.
    return { installee: false, motif: "meme-origine-que-la-coquille" };
  }
  if (typeof navigator?.serviceWorker?.register !== "function") {
    return { installee: false, motif: "service-worker-indisponible" };
  }
  portDetenu = port;
  const courtier = brancherLeCourtier(port, publier);
  installerPuisEncadrer({ document, emplacement, publier, courtier });
  return { installee: true, motif: null };
}

/**
 * ÉCOUTE les demandes du Service Worker et les relaie sur le port restreint — ou répond « en
 * attente » tant que l'application ne tourne pas.
 */
function brancherLeCourtier(port, publier) {
  /** Les réponses attendues du port restreint, par corrélation. */
  const enAttente = new Map();
  let correlationSuivante = 0;
  let application = APPLICATION.inconnue;
  /** L'instant où l'attente a commencé, pour que la page dise depuis combien de temps. */
  let attendDepuis = null;
  /** Ce que réveille l'annonce de barrière : la redemande de la page du cadre. */
  let surDemarrage = () => {};

  const entrerEnAttente = () => {
    if (application !== APPLICATION.enAttente) attendDepuis = performance.now();
    application = APPLICATION.enAttente;
    publier({ attente: "application-non-demarree" });
  };

  port.addEventListener("message", (event) => {
    const decode = decoderMessage(event.data);
    if (!decode.ok) return;
    // L'ANNONCE DE BARRIÈRE : le démarrage en acquitte une, et la coquille la pousse. Le courtier
    // redevient « inconnu » et redemande la page — une fois, et c'est son sort qui dira la suite.
    if (decode.type === TYPES_APPLICATIFS.barriere) {
      if (application !== APPLICATION.demarree) {
        application = APPLICATION.inconnue;
        surDemarrage();
      }
      return;
    }
    if (
      decode.type !== TYPES_APPLICATIFS.requeteHttpReponse &&
      decode.type !== TYPES_APPLICATIFS.refus
    ) {
      return;
    }
    const attente = enAttente.get(decode.message.correlation);
    if (attente === undefined) return;
    enAttente.delete(decode.message.correlation);
    if (decode.type === TYPES_APPLICATIFS.refus) {
      if (decode.message.code === CODES_REFUS_COQUILLE.applicationNonDemarree) {
        entrerEnAttente();
        return attente({
          type: TYPES_DU_CADRE.attente,
          depuisMs: performance.now() - attendDepuis,
        });
      }
      return attente({ type: TYPES_DU_CADRE.refus, code: decode.message.code });
    }
    application = APPLICATION.demarree;
    publier({ attente: null });
    attente({
      type: TYPES_DU_CADRE.reponse,
      statut: decode.message.statut,
      entetes: decode.message.entetes,
      corps: decode.message.corps,
    });
  });

  navigator.serviceWorker.addEventListener("message", (event) => {
    const demande = event.data;
    const [reponse] = event.ports;
    if (!reponse || !estDuContratDuCadre(demande)) return;
    if (demande.type !== TYPES_DU_CADRE.demande) return;
    const chemin = cheminRelayable(demande.chemin);
    if (chemin === null) {
      return reponse.postMessage({ type: TYPES_DU_CADRE.refus, code: "CADRE_CHEMIN_REFUSE" });
    }
    // Tant que l'application ne tourne pas, RIEN ne part sur le port : ni la coquille, ni le Worker
    // de confiance, ni le guest ne voient passer une requête qui ne peut pas aboutir.
    if (application === APPLICATION.enAttente) {
      return reponse.postMessage({
        type: TYPES_DU_CADRE.attente,
        depuisMs: performance.now() - attendDepuis,
      });
    }

    correlationSuivante += 1;
    const correlation = `r${correlationSuivante}`;
    enAttente.set(correlation, (rendue) => reponse.postMessage(rendue));
    publier({ relayees: correlationSuivante });
    port.postMessage(
      enveloppeDeMessage(TYPES_APPLICATIFS.requeteHttp, {
        correlation,
        methode: demande.methode,
        chemin,
        entetes: demande.entetes ?? {},
        corps: demande.corps ?? null,
      }),
    );
  });

  return {
    /** Pose ce que l'annonce de démarrage réveille. */
    surDemarrage: (reveiller) => {
      surDemarrage = reveiller;
    },
  };
}

/**
 * ENREGISTRE le Service Worker, attend qu'il CONTRÔLE cette page, puis crée le cadre imbriqué.
 *
 * L'ordre est une condition : un cadre créé avant que le Service Worker ne contrôle la page verrait
 * sa première navigation partir au réseau, donc à un 404.
 */
function installerPuisEncadrer({ document, emplacement, publier, courtier }) {
  navigator.serviceWorker
    .register("/service-worker-du-cadre.mjs", { type: "module", scope: "/" })
    .then((enregistrement) => attendreLeControle(enregistrement))
    .then(() => {
      publier({ serviceWorker: "actif" });
      const { cadre, chemin } = encadrerLApplication({ document, emplacement, publier });
      courtier.surDemarrage(() => redemander(cadre, chemin));
    })
    .catch((erreur) => {
      publier({ serviceWorker: `refuse:${erreur?.name ?? "inconnu"}` });
    });
}

/** Attend que ce document soit CONTRÔLÉ. `controllerchange` suffit ; `ready` ne le garantit pas. */
function attendreLeControle(enregistrement) {
  if (navigator.serviceWorker.controller !== null) return Promise.resolve();
  const controle = new Promise((resolu) => {
    navigator.serviceWorker.addEventListener("controllerchange", () => resolu(), { once: true });
  });
  // Un Service Worker DÉJÀ actif — un autre coffre l'a enregistré — ne réclame pas ce document de
  // lui-même : on le lui demande. Un Service Worker encore en installation le fera à son activation.
  enregistrement?.active?.postMessage(enveloppeDuCadre(TYPES_DU_CADRE.reclamer));
  return controle;
}

/** CRÉE le cadre imbriqué qui portera ce que le guest rend. */
function encadrerLApplication({ document, emplacement, publier }) {
  const demande = new URL(location.href).searchParams.get(PARAMETRE_CHEMIN);
  const chemin = cheminRelayable(demande) ?? CHEMIN_INITIAL_PAR_DEFAUT;
  const cadre = document.createElement("iframe");
  cadre.id = "application-servie";
  cadre.title = "application servie par le guest";
  cadre.setAttribute("width", "100%");
  cadre.setAttribute("height", "480");
  cadre.src = chemin;
  emplacement.append(cadre);
  publier({ cadreServi: chemin });
  return { cadre, chemin };
}

/**
 * REDEMANDE la page du cadre : celle qu'il affiche si elle est de cette origine, la page d'entrée
 * sinon. `location.replace` plutôt qu'une réaffectation de `src`, qui ne renavigue pas de façon
 * garantie d'un moteur à l'autre quand la valeur est la même.
 */
function redemander(cadre, cheminInitial) {
  const fenetre = cadre.contentWindow;
  if (!fenetre) {
    cadre.src = cheminInitial;
    return;
  }
  fenetre.location.replace(cheminCourant(fenetre) ?? cheminInitial);
}

/** Le chemin que le cadre affiche, s'il est lisible et relayable ; `null` sinon. */
function cheminCourant(fenetre) {
  try {
    return cheminRelayable(`${fenetre.location.pathname}${fenetre.location.search}`);
  } catch {
    return null;
  }
}
