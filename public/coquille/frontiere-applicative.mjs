// La FRONTIÈRE APPLICATIVE (#175 : scission de `public/main.mjs`) : le cadre, le port restreint
// accordé au document applicatif, et les refus qui gardent l'un et l'autre.
//
// Ce module ADMET ou REFUSE, il ne décide jamais lui-même de la forme du refus : `evaluerAnnonce` et
// `evaluerRequete` (`src/coquille/admission-applicative.mjs`) restent seuls maîtres de la liste
// d'admission. Il ne parle aux trois autres modules de branchement que par le RELEVÉ et par le pont
// que `main.mjs` lui passe.

import { evaluerAnnonce, evaluerRequete } from "/src/coquille/admission-applicative.mjs";
import {
  TYPES_APPLICATIFS,
  decoderMessage,
  enveloppeDeMessage,
  sansCapacite,
} from "/src/coquille/contrat-de-messages.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "/src/coquille/refus-de-coquille.mjs";

/**
 * Nombre maximal de requêtes du document applicatif servies EN MÊME TEMPS. Voir le raisonnement
 * dans l'historique de `main.mjs` avant #175 : la borne existe contre un guest qui poste en boucle,
 * pas pour un usage loyal qui n'a jamais qu'une requête en vol.
 */
const REQUETES_EN_VOL_MAXIMUM = 32;

/**
 * Compte un refus, par code. Le même choix que celui du canal privilégié, motivé par le même
 * incident (revue de la PR #166) : jamais de recopie, seulement un compte.
 *
 * @param {Record<string, number>} compteurs
 * @param {string} code
 */
function compter(compteurs, code) {
  compteurs[code] = (compteurs[code] ?? 0) + 1;
}

/**
 * @param {object} config
 * @param {object} config.rapport
 * @param {() => void} config.publier
 * @param {(nom: string) => void} config.mesurer
 * @param {Element} config.emplacementDuCadre
 * @param {{ canal: { demanderLEtat(): Promise<unknown> }, cycle: { estMort(): boolean }, verrouillage: { signalerActivite(nom: string): void } }} config.pont
 */
export function creerFrontiereApplicative({ rapport, publier, mesurer, emplacementDuCadre, pont }) {
  let cadre = null;
  let portRestreint = null;

  window.addEventListener("message", (event) => {
    // Une annonce ne TRANSFÈRE rien (voir le raisonnement dans l'historique de `main.mjs` avant
    // #175, tiré de la revue de la PR #166).
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

  /**
   * Transfère un port restreint NEUF au document applicatif. Le port privilégié n'est jamais
   * transmis, et le message d'octroi ne porte rien d'autre que le port.
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

  /** Les corrélations en vol. Une clé bornée, un ensemble borné : la mémoire l'est aussi. */
  const correlationsEnVol = new Set();

  /**
   * Traite un message du document applicatif. Le refus est calculé AVANT toute consultation
   * d'état ; chaque requête admise reçoit SA réponse, appariée par corrélation (#166).
   *
   * @param {MessagePort} port
   * @param {MessageEvent} event
   */
  function surRequeteApplicative(port, event) {
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
    pont.verrouillage.signalerActivite("message-du-cadre");
    pont.canal
      .demanderLEtat()
      .then((charge) => {
        port.postMessage(
          enveloppeDeMessage(
            TYPES_APPLICATIFS.etatReponse,
            sansCapacite({ correlation: verdict.correlation, ...charge }),
          ),
        );
      })
      .finally(() => correlationsEnVol.delete(verdict.correlation));
  }

  /**
   * Rend un refus TYPÉ à l'application, et le COMPTE.
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
    if (pont.cycle.estMort()) return;
    if (portRestreint === null) return;
    portRestreint.postMessage(
      enveloppeDeMessage(TYPES_APPLICATIFS.barriere, { barrieres: rapport.barrieres }),
    );
  }

  /** Crée le cadre applicatif. Appelé UNIQUEMENT après l'établissement du canal privilégié. */
  function creerLeCadre(url) {
    const element = document.createElement("iframe");
    element.id = "document-applicatif";
    element.title = "document applicatif";
    // `allow-same-origin` est conservé sur une iframe INTER-ORIGINE : il ne rend pas la sandbox
    // contournable, il rend à l'application son propre stockage (ADR 0002, conséquence 3).
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

  /** RETIRE le cadre applicatif du document. Le port n'est pas re-octroyé : la garde de #161 tient. */
  function retirerLeCadre() {
    cadre?.remove();
    cadre = null;
    rapport.cadreApplicatif = "retire";
  }

  return { creerLeCadre, retirerLeCadre, pousserLaBarriere };
}
