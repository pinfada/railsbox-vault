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
  annoncesRefusees: [],
  requetesRefusees: [],
  etat: ETATS_DU_VOLUME.demarrage,
  barrieres: 0,
};

function publier() {
  noeudRapport.textContent = JSON.stringify(rapport, null, 2);
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
  const decode = decoderMessage(event.data);
  const verdict = evaluerAnnonce({
    canalPrivilegiePret: rapport.canalPrivilegie === "etabli",
    type: decode.ok ? decode.type : null,
    origine: event.origin,
    fenetreEstLeCadre: cadre !== null && event.source === cadre.contentWindow,
    origineAttendue: rapport.origineApplicative,
    dejaOctroye: rapport.portOctroye,
  });
  if (!verdict.accepte) {
    rapport.annoncesRefusees.push({ code: verdict.code, origine: event.origin });
    publier();
    return;
  }
  octroyerLePortRestreint(event.source, rapport.origineApplicative);
});

// --- Étape 3 : le canal privilégié, avant tout document applicatif ---------------------------------

const worker = new Worker(new URL("./runtime-worker.mjs", import.meta.url), {
  type: "module",
  name: "vault-coquille-confiance",
});
const privilegie = new MessageChannel();
let attenteDEtat = null;

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
    if (attenteDEtat) {
      const rendre = attenteDEtat;
      attenteDEtat = null;
      rendre(chargeUtileDEtat({ etat: rapport.etat, barrieres: rapport.barrieres }));
    }
    return;
  }
  if (decode.type === TYPES_PRIVILEGIES.barriere) {
    rapport.barrieres = decode.message.barrieres;
    publier();
    pousserLaBarriere();
    return;
  }
  if (decode.type === TYPES_PRIVILEGIES.refus) {
    rapport.requetesRefusees.push({ code: decode.message.code, recu: "canal-privilegie" });
    publier();
  }
}

/** Aller-retour vers le Worker de confiance. Une seule question en vol à la fois. */
function demanderLEtat() {
  return new Promise((rendre) => {
    attenteDEtat = rendre;
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
    surRequeteApplicative(restreint.port1, event.data),
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
 * Traite un message du document applicatif. Le refus est calculé AVANT toute consultation d'état :
 * il ne dépend que du type reçu, et deux appareils dans des états différents rendent le même code.
 *
 * @param {MessagePort} port
 * @param {unknown} donnee
 */
function surRequeteApplicative(port, donnee) {
  const verdict = evaluerRequete(donnee);
  if (!verdict.admise) {
    rapport.requetesRefusees.push({ code: verdict.code, recu: verdict.recu });
    publier();
    port.postMessage(
      enveloppeDeMessage(TYPES_APPLICATIFS.refus, {
        code: verdict.code,
        message: messageDeRefus(verdict.code),
        recu: verdict.recu,
      }),
    );
    return;
  }
  demanderLEtat().then((charge) => {
    port.postMessage(
      enveloppeDeMessage(TYPES_APPLICATIFS.etatReponse, sansCapacite({ ...charge })),
    );
  });
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
  publier();

  const jeton = parametres.get(PARAMETRE_HARNAIS);
  if (jeton) await deverrouillerParLeHarnais(jeton);

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
