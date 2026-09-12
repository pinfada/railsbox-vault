// Le document applicatif LOYAL : ce que la coquille encadre quand personne n'attaque (#161).
//
// Il existe pour deux raisons, et aucune n'est décorative. La première : une frontière dont un seul
// côté est éprouvé n'est pas éprouvée — sans document loyal, rien ne dirait que la coquille SERT ce
// qu'elle admet, et un relevé où tout est refusé passerait pour une réussite. La seconde : le
// contrat a besoin d'un exemple lisible de ce qu'un éditeur d'application doit écrire.
//
// ## L'annonce est postée avec `"*"`, et c'est délibéré
//
// Elle ne porte rien : ni jeton, ni identité, ni donnée. Ce que `targetOrigin` protège est le
// CONTENU d'un message, et il n'y a pas de contenu. La vérification, elle, se fait de l'autre
// côté — la coquille compare l'origine, la fenêtre émettrice et le type avant d'octroyer quoi que
// ce soit (ADR 0018 § 4 : l'origine EST l'identité). Un document applicatif ne connaît d'ailleurs
// pas l'origine de sa coquille : la deviner à partir de la sienne serait supposer la topologie de
// déploiement depuis le territoire du guest, exactement ce que l'ADR 0002 refuse.

import {
  TYPES_APPLICATIFS,
  decoderMessage,
  enveloppeDeMessage,
} from "/src/coquille/contrat-de-messages.mjs";
import { monterLaCoquilleDeCadre } from "/cadre/courtier-du-cadre.mjs";

const noeudEtat = document.querySelector("#document-applicatif-etat");
const boutonEtat = document.querySelector("#document-applicatif-demander");
const noeudRapport = document.querySelector("#document-applicatif-rapport");
const emplacementDeLApplication = document.querySelector("#application-servie-emplacement");

const rapport = {
  portRecu: false,
  etat: null,
  barrieres: null,
  /** Le nombre de questions d'état posées. Un compte, jamais la liste de ce qui a été demandé. */
  questions: 0,
  refus: [],
  /**
   * Ce que la COQUILLE DE CADRE (#192) a fait de ce document : installée ou non, sous quel motif,
   * avec quel sort pour son Service Worker, et combien de requêtes elle a relayées. Des faits et
   * des comptes ; jamais un octet de ce qui a transité.
   */
  coquilleDeCadre: {
    installee: false,
    motif: null,
    serviceWorker: "non-demande",
    cadreServi: null,
    relayees: 0,
    // L'ATTENTE de la première page, quand il y en a une. Elle est déclarée ICI plutôt que
    // seulement ajoutée à son arrivée : un relevé dont la FORME change en cours de route est un
    // relevé qu'une épreuve ne peut pas borner, et `tests/browser/coquille-frontiere.spec.mjs`
    // exige la liste exacte de ces six champs.
    attente: null,
  },
};

/** Compteur des corrélations de ce document. Il ne quitte jamais l'origine applicative. */
let correlationSuivante = 0;

function publier() {
  noeudRapport.textContent = JSON.stringify(rapport, null, 2);
}

/** @param {MessagePort} port */
function ecouterLePort(port) {
  port.addEventListener("message", (event) => {
    const decode = decoderMessage(event.data);
    if (!decode.ok) return;
    if (decode.type === TYPES_APPLICATIFS.etatReponse) {
      rapport.etat = decode.message.etat;
      rapport.barrieres = decode.message.barrieres;
    } else if (decode.type === TYPES_APPLICATIFS.barriere) {
      rapport.barrieres = decode.message.barrieres;
    } else if (decode.type === TYPES_APPLICATIFS.refus) {
      rapport.refus.push(decode.message.code);
    }
    publier();
    noeudEtat.textContent = `application:etat:${rapport.etat ?? "inconnu"}`;
    document.documentElement.dataset.documentApplicatif = "servi";
  });
  port.start();
}

window.addEventListener("message", (event) => {
  const decode = decoderMessage(event.data);
  if (!decode.ok || decode.type !== TYPES_APPLICATIFS.octroi) return;
  const [port] = event.ports;
  if (!port) return;
  rapport.portRecu = true;
  publier();
  ecouterLePort(port);
  // La COQUILLE DE CADRE est montée sur le port, et seulement sur lui (#192, ADR 0038). Elle ne le
  // transfère jamais : ce qu'elle en fait, c'est poster des requêtes relayées et lire leurs
  // réponses, exactement comme ce document pose déjà sa question d'état.
  const montee = monterLaCoquilleDeCadre({
    port,
    document,
    emplacement: emplacementDeLApplication,
    publier: (faits) => {
      Object.assign(rapport.coquilleDeCadre, faits);
      publier();
    },
  });
  rapport.coquilleDeCadre.installee = montee.installee;
  rapport.coquilleDeCadre.motif = montee.motif;
  publier();
  demanderLEtat(port);
  // Le geste-requête est REJOUABLE, et c'est ce qu'un éditeur d'application écrira : l'état d'un
  // coffre change — il s'ouvre, il se referme, son Worker meurt —, et un document qui ne
  // demanderait qu'une fois afficherait pour toujours ce qu'il a appris au démarrage. C'est aussi
  // ce qui rend LISIBLE, depuis le cadre, la conduite de la coquille après la mort de son Worker :
  // la question rend `verrouille`, et non un silence (#163, ADR 0030, décision 3).
  boutonEtat?.addEventListener("click", () => demanderLEtat(port));
});

/**
 * DEMANDE l'état, sous une corrélation neuve.
 *
 * Chaque requête porte son identifiant de CORRÉLATION, et la coquille le rend tel quel : c'est ce
 * qui apparie N réponses à N requêtes, et ce qui interdit qu'une question reste muette quand
 * plusieurs sont en vol. Le réemployer ferait rendre `VAULT_COQUILLE_CORRELATION_DUPLIQUEE`.
 *
 * @param {MessagePort} port
 */
function demanderLEtat(port) {
  correlationSuivante += 1;
  rapport.questions += 1;
  publier();
  port.postMessage(
    enveloppeDeMessage(TYPES_APPLICATIFS.etat, { correlation: `etat-${correlationSuivante}` }),
  );
}

parent.postMessage(enveloppeDeMessage(TYPES_APPLICATIFS.annonce), "*");
document.documentElement.dataset.documentApplicatif = "annonce";
noeudEtat.textContent = "application:annonce";
publier();
