// Le RELAIS HTTP, côté WORKER DE CONFIANCE (#192, ADR 0038).
//
// Il est à part de `public/runtime-worker.mjs`, et pas pour une raison de taille : le Worker de
// confiance tient les clés, l'enveloppe et le volume, et ce module-ci ne tient que le trafic d'une
// application. Les mêler ferait cohabiter dans un même fichier ce qui ne doit jamais se croiser —
// et c'est déjà la raison pour laquelle le canal de relais n'est pas le canal privilégié.
//
// Ce qu'il détient, et qui ne franchit aucun port :
//
//  - la PORTE HTTP de la session guest (`requeteHttp`), rendue par le boot et jamais postée ;
//  - le BOCAL À COOKIES de la session Rails. Il meurt avec le Worker, donc au verrouillage, à la
//    mort du Worker et à la fermeture de l'onglet — sans qu'aucun code n'ait à s'en souvenir.
//
// Ce qu'il ne détient pas : ni KEK, ni DEK, ni handle, ni descripteur. Il ne sait rien du coffre au
// delà d'une seule question — « une application tourne-t-elle ? » —, à laquelle il répond par un
// refus typé quand la réponse est non.

import {
  TYPES_RELAIS,
  correlationAdmise,
  decoderMessage,
  enveloppeDeMessage,
  estTypePrivilegie,
} from "/src/coquille/contrat-de-messages.mjs";
import {
  CODES_REFUS_COQUILLE,
  codeDeRefusAdmis,
  messageDeRefus,
} from "/src/coquille/refus-de-coquille.mjs";
import {
  PLAFOND_CORPS_DE_REPONSE_OCTETS,
  creerBocalDeCookies,
  emplacementRendu,
  entetesDeReponseRendues,
  evaluerRequeteRelayee,
} from "/src/coquille/relais-http.mjs";
import { base64Depuis, octetsDepuisBase64 } from "/src/vm/serial-protocol.mjs";

/**
 * L'ORIGINE sous laquelle le relais interroge le guest.
 *
 * `127.0.0.1` sans port : c'est l'hôte que le pont série présente à Puma
 * (`tools/build-reference-image/guest/serial-bridge.py`), donc celui que Rails emploie pour composer
 * ses `Location`. La constante existe pour que la RÉÉCRITURE de ces `Location` compare la même
 * origine que celle qu'elle a posée — deux valeurs différentes feraient rendre `null` à toute
 * redirection, c'est-à-dire perdre le formulaire.
 */
export const ORIGINE_DU_GUEST = "http://127.0.0.1";

/**
 * Les en-têtes que le relais POSE lui-même sur chaque requête, dans cet ordre.
 *
 * Aucun ne vient du cadre. `Origin` et `Referer` en sont délibérément absents — le motif est écrit
 * en tête de `src/coquille/relais-http.mjs`, et il tient à la protection anti-CSRF de Rails.
 */
export const ENTETES_POSES_PAR_LE_RELAIS = Object.freeze([
  ["Host", "127.0.0.1"],
  ["User-Agent", "railsbox-vault-relais"],
]);

/**
 * Requêtes relayées EN VOL au plus.
 *
 * Seize : cinq fois ce qu'une page de l'application de référence demande à la fois (un document et
 * trois sous-ressources), et assez peu pour qu'un cadre en boucle ne noie ni le pont série, ni la
 * mémoire du Worker. La mesure du 12 septembre 2026 dit d'ailleurs que le parallélisme n'achète
 * rien — trois actifs demandés ensemble coûtent 186,9 ms, contre 189,5 ms en série — puisque le fil
 * série les sérialise de toute façon. La borne n'est donc pas un réglage de performance : c'est une
 * borne de mémoire.
 */
export const RELAIS_EN_VOL_MAXIMUM = 16;

/**
 * BRANCHE le relais sur son port.
 *
 * @param {object} config
 * @param {MessagePort} config.port le port du canal de relais, transféré par la coquille
 * @param {() => ({ requeteHttp: Function } | null)} config.sessionCourante
 *   rend la session de l'application quand elle tourne, `null` sinon. C'est une FONCTION et non une
 *   valeur : la session naît et meurt pendant la vie du Worker, et un module qui en aurait capturé
 *   une servirait une VM arrêtée.
 * @returns {{ oublierLaSession(): void }} ce que le Worker appelle quand il relâche tout
 */
export function brancherLeRelaisDuWorker({ port, sessionCourante }) {
  let enVol = 0;
  /**
   * Le BOCAL À COOKIES, ici et nulle part ailleurs : il appartient au relais, pas au coffre.
   *
   * Il meurt avec le Worker — donc au verrouillage, à la mort du Worker et à la fermeture de
   * l'onglet — sans qu'aucun code n'ait à s'en souvenir. `oublierLaSession` le vide en plus, pour
   * le cas où le Worker survivrait à une fermeture : ce que l'utilisateur croit fermé ne doit rien
   * laisser derrière qui rouvre une session Rails.
   */
  let bocal = creerBocalDeCookies();

  port.addEventListener("message", (event) => surMessage(event));
  port.start();

  /** @param {MessageEvent} event */
  function surMessage(event) {
    const correlation = correlationAdmise(event.data?.correlation);
    const decode = decoderMessage(event.data);
    if (!decode.ok) return refuser(decode.code, correlation);
    // Un type PRIVILÉGIÉ posé ici est refusé nommément : trois vocabulaires, trois canaux, et aucun
    // ne se parle sur celui d'un autre.
    if (estTypePrivilegie(decode.type)) {
      return refuser(CODES_REFUS_COQUILLE.portPrivilegie, correlation);
    }
    if (decode.type !== TYPES_RELAIS.requete) {
      return refuser(CODES_REFUS_COQUILLE.typeInconnu, correlation);
    }
    if (correlation === null) return refuser(CODES_REFUS_COQUILLE.correlationAbsente, null);
    relayer(decode.message, correlation).catch((erreur) =>
      refuser(erreur?.code ?? CODES_REFUS_COQUILLE.gesteRompu, correlation),
    );
  }

  /**
   * POSTE un refus. Il ne jette jamais : un code hors de l'ensemble clos devient
   * `VAULT_COQUILLE_GESTE_ROMPU`, parce qu'un refus qui jette est une corrélation sans réponse.
   *
   * @param {unknown} codeRecu @param {string | null} correlation
   */
  function refuser(codeRecu, correlation) {
    const code = codeDeRefusAdmis(codeRecu);
    port.postMessage(
      enveloppeDeMessage(TYPES_RELAIS.refus, {
        code,
        message: messageDeRefus(code),
        ...(correlation === null ? {} : { correlation }),
      }),
    );
  }

  /**
   * RELAIE une requête jusqu'à Rails, et rend ce qu'il a répondu — filtré.
   *
   * L'ordre des contrôles n'est pas indifférent : l'absence d'application vient EN PREMIER, avant la
   * forme de la requête. Une requête mal formée posée sur une coquille qui ne sert rien doit
   * apprendre qu'il n'y a rien à servir, et non ce que le relais aurait accepté — le second serait
   * un oracle sur la grammaire du relais, offert gratuitement avant même qu'un coffre soit ouvert.
   */
  async function relayer(message, correlation) {
    const session = sessionCourante();
    if (session === null) {
      return refuser(CODES_REFUS_COQUILLE.applicationNonDemarree, correlation);
    }
    const requete = evaluerRequeteRelayee(message);
    if (!requete.ok) return refuser(CODES_REFUS_COQUILLE.requeteHttpRefusee, correlation);
    if (enVol >= RELAIS_EN_VOL_MAXIMUM) {
      return refuser(CODES_REFUS_COQUILLE.tropDeRequetes, correlation);
    }

    const reponse = await interroger(session, requete);
    if (reponse.corps.byteLength > PLAFOND_CORPS_DE_REPONSE_OCTETS) {
      return refuser(CODES_REFUS_COQUILLE.reponseHttpTropGrande, correlation);
    }
    // Le cookie est DÉPOSÉ ici et nulle part ailleurs : le bocal ne quitte pas ce Worker, et il
    // meurt avec lui. C'est la propriété de la KEK de session, obtenue de la même façon.
    bocal.deposer(reponse.entetesRepetees);

    port.postMessage(
      enveloppeDeMessage(TYPES_RELAIS.reponse, {
        correlation,
        statut: reponse.statut,
        entetes: entetesPubliees(reponse.entetes),
        corps: base64Depuis(reponse.corps),
      }),
    );
  }

  /** Compose la requête du guest et l'émet, en comptant ce qui est en vol. */
  async function interroger(session, requete) {
    const corps = requete.corps === null ? null : octetsDepuisBase64(requete.corps);
    const entetes = ENTETES_POSES_PAR_LE_RELAIS.map((paire) => [...paire]);
    for (const [nom, valeur] of requete.entetes) entetes.push([nom, valeur]);
    const cookie = bocal.entete();
    if (cookie !== null) entetes.push(["Cookie", cookie]);
    if (corps !== null) entetes.push(["Content-Length", String(corps.byteLength)]);
    enVol += 1;
    try {
      return await session.requeteHttp(requete.methode, requete.chemin, {
        headers: entetes,
        body: corps,
      });
    } finally {
      enVol -= 1;
    }
  }

  /**
   * Les en-têtes RENDUS, `Location` réécrite.
   *
   * Une redirection HORS du guest n'est pas rendue : le cadre ne navigue pas vers le web ouvert sur
   * l'ordre d'une application. L'en-tête part, le statut reste — le cadre affiche alors une
   * redirection sans destination, ce qui est exactement ce qui s'est passé.
   */
  function entetesPubliees(entetes) {
    const rendus = entetesDeReponseRendues(entetes);
    if (rendus.location === undefined) return rendus;
    const chemin = emplacementRendu(rendus.location, ORIGINE_DU_GUEST);
    if (chemin === null) delete rendus.location;
    else rendus.location = chemin;
    return rendus;
  }

  return {
    /** Le coffre se referme : le bocal repart NEUF, et la session Rails avec lui. */
    oublierLaSession() {
      bocal.vider();
      bocal = creerBocalDeCookies();
    },
  };
}
