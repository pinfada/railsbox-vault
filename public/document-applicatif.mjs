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

const noeudEtat = document.querySelector("#document-applicatif-etat");
const noeudRapport = document.querySelector("#document-applicatif-rapport");

const rapport = {
  portRecu: false,
  etat: null,
  barrieres: null,
  refus: [],
};

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
  port.postMessage(enveloppeDeMessage(TYPES_APPLICATIFS.etat));
});

parent.postMessage(enveloppeDeMessage(TYPES_APPLICATIFS.annonce), "*");
document.documentElement.dataset.documentApplicatif = "annonce";
noeudEtat.textContent = "application:annonce";
publier();
