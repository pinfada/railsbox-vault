// LE COURTIER de la coquille de cadre (#192, ADR 0038).
//
// Il est la moitié « document » du mécanisme dont le Service Worker est l'autre moitié. Son rôle
// tient en une phrase : il détient le port restreint que la coquille lui a octroyé, il ne le prête à
// personne, et il relaie les requêtes que le Service Worker lui présente.
//
// ## Pourquoi le document servi est un cadre IMBRIQUÉ
//
// Parce que le port restreint n'est octroyé QU'UNE FOIS (ADR 0028, décision 2, cinquième condition :
// l'unicité). Un document qui naviguerait vers la page Rails perdrait son port et ne pourrait pas en
// redemander — et c'est très bien : cette unicité est une frontière, pas une limitation à contourner.
// Le courtier reste donc immobile, et ce qui navigue est un cadre imbriqué, sur la MÊME origine.
//
// Ce cadre imbriqué est le territoire du guest, et la coquille le sait : elle refuse toute annonce
// venue d'une fenêtre qui n'est pas le cadre qu'elle a créé (`VAULT_COQUILLE_ANNONCE_FENETRE`). Une
// page Rails qui réclamerait son propre port restreint est donc refusée POUR CE MOTIF — c'est le
// contrôle de la fenêtre émettrice, écrit en #161 pour exactement ce cas, et #192 est la première
// tranche où il en existe un.
//
// ## Ce que la page servie peut faire, et pourquoi ce n'est pas un défaut
//
// Le cadre imbriqué est de MÊME ORIGINE que ce courtier : la page Rails peut donc lire ses
// variables et atteindre le port restreint par `parent`. C'est vrai, c'est assumé, et c'est la
// conséquence directe de l'ADR 0018 § 4 — l'origine EST l'identité, et tout le territoire applicatif
// est UN seul domaine de confiance. Ce que la page y gagne est exactement ce que le port admet :
// demander l'état du coffre, et relayer une requête vers son propre guest. Les dix refus tiennent,
// le canal privilégié reste hors d'atteinte, et aucune clé ne traverse. L'épreuve d'application
// malveillante rejoue cela sur le chemin neuf.
//
// ## Ce qu'il ne fait jamais
//
// Il ne transfère jamais le port, ne le confie à aucun message, et ne relaie que ce qui vient d'un
// `MessageChannel` ouvert par le Service Worker de SA propre origine. Un message posté sur `window`
// par la page servie n'est pas une demande de relais : `window` n'est pas ce canal.

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

/**
 * Le sort d'une requête SERVIE. Il n'est pas `null` — `null` veut dire « aucune requête n'est encore
 * revenue » —, et confondre les deux ferait attendre pour toujours une réponse déjà arrivée.
 */
const SERVIE = "servie";

/** Paramètre par lequel une épreuve demande un autre chemin d'entrée. Jamais une autre ORIGINE. */
const PARAMETRE_CHEMIN = "chemin";

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
    // décision 4 refuse un Service Worker dans la frontière de confiance, et une topologie qui n'a
    // pas de frontière n'a rien à servir à travers elle.
    return { installee: false, motif: "meme-origine-que-la-coquille" };
  }
  if (typeof navigator?.serviceWorker?.register !== "function") {
    // Un moteur sans Service Worker DIT qu'il n'en a pas, et le document reste ce qu'il était.
    return { installee: false, motif: "service-worker-indisponible" };
  }

  const courtier = brancherLeCourtier(port, publier);
  installerPuisEncadrer({ document, emplacement, publier, courtier });
  return { installee: true, motif: null };
}

/**
 * ÉCOUTE les demandes du Service Worker et les relaie sur le port restreint.
 *
 * Chaque demande arrive avec SON port de réponse, ouvert par le Service Worker : l'appariement est
 * donc structurel, et aucun identifiant n'a besoin d'être inventé de ce côté-ci. Sur le port
 * RESTREINT, en revanche, la corrélation est exigée par le contrat de la coquille — et c'est ce
 * courtier qui la tient.
 */
function brancherLeCourtier(port, publier) {
  /** Les réponses attendues du port restreint, par corrélation. */
  const enAttente = new Map();
  let correlationSuivante = 0;
  /** Ce qui attend une ANNONCE de barrière. Une liste, parce que rien n'interdit deux attentes. */
  const reveils = [];
  /**
   * Le SORT de la dernière requête relayée : un code de refus, `null` quand elle a été servie,
   * et `undefined` tant qu'aucune n'est revenue.
   *
   * Il ne sert qu'à une chose, et il ne sert qu'ici : décider s'il faut REDEMANDER la première
   * page. Rien d'autre ne le lit, et il ne quitte pas ce document.
   */
  let dernierSort = null;

  port.addEventListener("message", (event) => {
    const decode = decoderMessage(event.data);
    if (!decode.ok) return;
    // L'ANNONCE DE BARRIÈRE réveille l'attente de la première page : le démarrage de l'application
    // acquitte une barrière, et la coquille la POUSSE. Le cadre redemande donc sa page à l'instant
    // où elle devient servable, plutôt qu'au tour d'horloge suivant.
    if (decode.type === TYPES_APPLICATIFS.barriere) {
      for (const reveiller of reveils) reveiller();
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
      dernierSort = decode.message.code;
      return attente({ type: TYPES_DU_CADRE.refus, code: decode.message.code });
    }
    dernierSort = SERVIE;
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
    if (!reponse) return;
    if (demande?.contrat !== CONTRAT_DU_CADRE.id) return;
    if (demande?.version !== CONTRAT_DU_CADRE.version) return;
    if (demande?.type !== TYPES_DU_CADRE.demande) return;
    const chemin = cheminRelayable(demande.chemin);
    if (chemin === null) {
      return reponse.postMessage({ type: TYPES_DU_CADRE.refus, code: "CADRE_CHEMIN_REFUSE" });
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
    sortDeLaDerniereRequete: () => dernierSort,
    surAnnonce: (reveiller) => reveils.push(reveiller),
  };
}

/**
 * ENREGISTRE le Service Worker, attend qu'il CONTRÔLE cette page, puis crée le cadre imbriqué.
 *
 * L'ordre est une condition, pas une précaution : un cadre créé avant que le Service Worker ne
 * contrôle la page verrait sa première navigation partir au réseau, donc au serveur statique, donc
 * à un 404. Attendre le contrôle est ce qui rend la première page servie plutôt que perdue.
 */
function installerPuisEncadrer({ document, emplacement, publier, courtier }) {
  navigator.serviceWorker
    .register("/service-worker-du-cadre.mjs", { type: "module", scope: "/" })
    .then(() => attendreLeControle())
    .then(() => {
      publier({ serviceWorker: "actif" });
      const { cadre, chemin } = encadrerLApplication({ document, emplacement, publier });
      redemanderJusquAuDemarrage({
        cadre,
        chemin,
        sortDeLaDerniereRequete: courtier.sortDeLaDerniereRequete,
        surAnnonce: courtier.surAnnonce,
        publier,
      });
    })
    .catch((erreur) => {
      // Un enregistrement refusé n'est pas une panne de la coquille : c'est un moteur qui ne veut
      // pas, ou une topologie qui ne s'y prête pas. Le document le DIT et reste ce qu'il était.
      publier({ serviceWorker: `refuse:${erreur?.name ?? "inconnu"}` });
    });
}

/** Attend que ce document soit CONTRÔLÉ. `controllerchange` suffit ; `ready` ne le garantit pas. */
function attendreLeControle() {
  if (navigator.serviceWorker.controller !== null) return Promise.resolve();
  return new Promise((resolu) => {
    navigator.serviceWorker.addEventListener("controllerchange", () => resolu(), { once: true });
  });
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
 * L'ATTENTE de la première page : ce qui la réveille, et le repli qui la borne.
 *
 * Elle existe parce que l'ordre du cycle de vie est ainsi fait : la coquille encadre le document
 * applicatif à l'étape 4, et l'application ne DÉMARRE qu'au geste de l'utilisateur qui suit. Entre
 * les deux, le relais répond `VAULT_COQUILLE_APPLICATION_NON_DEMARREE` — c'est la vérité, et le
 * refus le dit. Ce que cette attente ajoute est la seule conduite qui rende le cadre utile :
 * REDEMANDER, jusqu'à ce que l'application réponde.
 *
 * **Ce qui la réveille est l'ANNONCE DE BARRIÈRE**, et non une horloge. Le second geste admis du
 * port restreint est une POUSSÉE : la coquille annonce qu'une barrière de durabilité a été
 * acquittée, et le démarrage de l'application en acquitte une (`annoncerLaBarriere` suit le boot).
 * Le cadre redemande donc sa page dans la milliseconde qui suit le démarrage, sans rien interroger
 * en boucle — exactement le motif pour lequel cette annonce a été admise en #161.
 *
 * **Le repli est LENT, et il l'est devenu par la mesure.** Il a été écrit à deux secondes, et le
 * scénario de bout en bout l'a réfuté le 12 septembre 2026 : une centaine de navigations du cadre
 * imbriqué pendant un boot qui dure cent cinq secondes, et le Worker de confiance a été déclaré
 * MORT PAR SILENCE trois fois de suite — sa borne de trente secondes expirant pendant que le
 * processus se disputait le processeur. À dix secondes, et réveillé par l'annonce, le cadre demande
 * une poignée de fois au lieu de cent.
 *
 * Trente essais de dix secondes couvrent cinq minutes, c'est-à-dire davantage que le boot le plus
 * lent que ce dépôt ait mesuré (p95 = 125,9 s) plus le temps qu'un utilisateur met à taper sa
 * phrase. Au-delà, le cadre cesse de demander et garde ce que le relais lui a rendu : un refus qui
 * se répète pour toujours serait une boucle, pas une attente.
 */
const DELAI_DE_REESSAI_MS = 10_000;
const REESSAIS_MAXIMUM = 30;

/**
 * REDEMANDE la première page tant que l'application n'est pas démarrée.
 *
 * Elle ne devine rien : elle ne réessaie que sur le code qui dit exactement « pas encore », et elle
 * s'arrête au PREMIER sort qui n'est pas celui-là — une réponse servie, ou n'importe quel autre
 * refus, qui appellent tous deux autre chose qu'une attente.
 */
function redemanderJusquAuDemarrage({
  cadre,
  chemin,
  sortDeLaDerniereRequete,
  surAnnonce,
  publier,
}) {
  let essais = 0;
  let finie = false;

  const finir = (attente) => {
    finie = true;
    clearInterval(minuterie);
    publier({ attente });
  };

  const redemander = () => {
    if (finie) return;
    const sort = sortDeLaDerniereRequete();
    if (sort === null) return;
    if (sort !== CODES_REFUS_COQUILLE.applicationNonDemarree) return finir(null);
    essais += 1;
    if (essais > REESSAIS_MAXIMUM) return finir("abandonnee");
    publier({ attente: `application-non-demarree:${essais}` });
    // `location.replace` plutôt qu'une réaffectation de `src` : réaffecter la MÊME valeur ne
    // renavigue pas de façon garantie d'un moteur à l'autre, et ce serait une attente qui n'attend
    // rien. Le cadre imbriqué est de même origine que ce document ; sa fenêtre est donc joignable.
    const fenetre = cadre.contentWindow;
    if (fenetre) fenetre.location.replace(chemin);
    else cadre.src = chemin;
  };

  // L'ANNONCE d'abord : c'est elle qui porte la nouvelle, et elle arrive à l'instant du démarrage.
  surAnnonce(redemander);
  // Le REPLI ensuite : lent, borné, et seul recours si aucune annonce ne vient.
  const minuterie = setInterval(redemander, DELAI_DE_REESSAI_MS);
}
