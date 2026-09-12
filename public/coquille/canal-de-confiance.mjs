// Le CANAL PRIVILÉGIÉ et le WORKER DE CONFIANCE (#175 : scission de `public/main.mjs`).
//
// Ce module NE DÉCIDE rien : les refus, l'état du coffre et la conduite après la mort restent dans
// `src/coquille/`. Il tient le Worker, le canal qui y mène, et les deux enveloppes de requête/
// réponse — c'est la même frontière que celle que l'ADR 0028 dessinait déjà dans `main.mjs`, rendue
// SEULE ici.
//
// Il ne parle aux trois autres modules de branchement que par le RELEVÉ (`rapport`, `publier`) et
// par les quelques fonctions que `main.mjs` lui passe explicitement (le pont). Il n'importe aucun
// des trois autres modules de branchement.

import {
  TYPES_PRIVILEGIES,
  TYPES_RELAIS,
  decoderMessage,
  enveloppeDeMessage,
  REPONSES_PRIVILEGIEES,
  enveloppePrivilegiee,
} from "/src/coquille/contrat-de-messages.mjs";
import { chargeUtileDEtat } from "/src/coquille/etat-de-la-coquille.mjs";
import { CAUSES_DE_MORT } from "/src/coquille/mort-du-worker.mjs";
import { DELAI_WORKER_MORT_MS } from "/src/coquille/moyens-de-deverrouillage.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "/src/coquille/refus-de-coquille.mjs";

/**
 * Borne d'une requête RELAYÉE, en millisecondes.
 *
 * Cent cinquante secondes, et l'ordre des deux bornes est le sujet : le pont série s'accorde
 * cent vingt secondes et rend alors un refus TYPÉ, que le Worker traduit. Poser ici une borne plus
 * COURTE ferait gagner la nôtre, et le cadre recevrait « requête refusée » — « sa méthode, son
 * chemin, ses en-têtes ou son corps sortent de ce que le relais admet » — pour une requête
 * parfaitement formée qui a seulement mis trop de temps. Un refus qui décrit un autre événement que
 * le sien est un refus qu'on finit par mal lire (c'est la leçon de `VAULT_COQUILLE_WORKER_MORT`).
 *
 * La borne d'ici ne mord donc que sur un Worker MUET — un cas que le battement du canal privilégié
 * ne couvre pas, ce canal-ci n'en portant aucun —, et elle rend alors `VAULT_COQUILLE_GESTE_ROMPU` :
 * le geste était admis, il n'a pas abouti, et personne ne sait dire pourquoi. C'est exactement ce
 * que ce code dit.
 *
 * Pour mémoire, la plus lente requête mesurée le 12 septembre 2026 sur une page Rails réelle pèse
 * 380,2 ms (la soumission de formulaire, Chromium) : la borne est à quatre cents fois cela.
 */
const DELAI_RELAIS_MS = 150_000;

/**
 * Compte un refus, par code. Rien d'autre n'est retenu de ce que le Worker a envoyé — le même choix
 * que celui de la frontière applicative, motivé par le même incident (revue de la PR #166).
 *
 * @param {Record<string, number>} compteurs
 * @param {string} code
 */
function compter(compteurs, code) {
  compteurs[code] = (compteurs[code] ?? 0) + 1;
}

/**
 * @param {object} config
 * @param {object} config.rapport le relevé public de la coquille, partagé par référence
 * @param {() => void} config.publier republie le relevé
 * @param {{ cycle: { estMort(): boolean, constaterLaMort(cause: string): unknown, refusDeMort(): Error }, verrouillage: { refletDeLEtat(): void, signalerActivite(nom: string): void }, frontiere: { pousserLaBarriere(): void } }} config.pont
 *   le pont vers les trois autres modules de branchement, peuplé par `main.mjs` au fur et à mesure
 *   de leur construction ; chaque clé n'est lue qu'APRÈS que le module correspondant existe.
 */
export function creerCanalDeConfiance({ rapport, publier, pont }) {
  /**
   * Le Worker de confiance est chargé avec `?use-scheduling-api`, et ce n'est PAS décoratif.
   *
   * v86 choisit sa boucle d'ordonnancement à l'évaluation de son module, en inspectant
   * `location.href` du contexte qui l'importe (ADR 0013, § « Mise en œuvre par #74 ») : sans ce
   * marqueur, il retombe sur un Worker imbriqué chargé depuis une URL `blob:` — que la CSP de la
   * coquille refuse (`worker-src 'self'`, ADR 0013).
   */
  const worker = new Worker(new URL("../runtime-worker.mjs?use-scheduling-api", import.meta.url), {
    type: "module",
    name: "vault-coquille-confiance",
  });
  const privilegie = new MessageChannel();
  /**
   * Le CANAL DE RELAIS (#192, ADR 0038), établi dans la MÊME poignée de main que le canal
   * privilégié et jamais confondu avec lui.
   *
   * Pourquoi un troisième canal plutôt qu'un type de plus sur le canal privilégié : celui-ci porte
   * les clés, les enveloppes et les gestes de l'utilisateur, et il est traité EN SÉRIE — une requête
   * HTTP de cent millisecondes y retarderait un déverrouillage, et une requête qui n'aboutirait pas
   * ferait déclarer mort un Worker parfaitement vivant. Le trafic d'une application n'a rien à faire
   * dans cette file, et son vocabulaire n'a rien à faire dans ce dictionnaire.
   *
   * Pourquoi la MÊME poignée de main plutôt qu'un second message : le Worker n'accepte qu'UN seul
   * message sur son canal global, d'UN seul type, UNE seule fois. Ajouter un second message aurait
   * élargi cette porte-là ; transférer un second port dans le message existant ne l'élargit pas.
   */
  const relais = new MessageChannel();

  worker.addEventListener("error", () => pont.cycle.constaterLaMort(CAUSES_DE_MORT.erreur));
  worker.addEventListener("messageerror", () => pont.cycle.constaterLaMort(CAUSES_DE_MORT.erreur));

  /**
   * Les demandes EN VOL vers le Worker, APPARIÉES par leur identifiant de corrélation (#166).
   */
  const demandesEnVol = new Map();

  /** Compteur des corrélations du canal privilégié. Il ne quitte jamais l'origine de confiance. */
  let corrélationSuivante = 0;

  /** Les requêtes RELAYÉES en vol, appariées par corrélation. Elles ne croisent jamais les autres. */
  const relaisEnVol = new Map();

  /** Compteur des corrélations du canal de relais. Il ne quitte jamais l'origine de confiance. */
  let relaisSuivant = 0;

  privilegie.port1.addEventListener("message", (event) => surMessagePrivilegie(event.data));
  privilegie.port1.start();
  relais.port1.addEventListener("message", (event) => surMessageDeRelais(event.data));
  relais.port1.start();
  worker.postMessage(enveloppeDeMessage(TYPES_PRIVILEGIES.canal), [privilegie.port2, relais.port2]);

  /** @param {unknown} donnee */
  function surMessagePrivilegie(donnee) {
    const decode = decoderMessage(donnee);
    if (!decode.ok) return;
    if (decode.type === TYPES_PRIVILEGIES.etatReponse) {
      rapport.etat = decode.message.etat;
      rapport.barrieres = decode.message.barrieres;
      pont.verrouillage.refletDeLEtat();
      publier();
    }
    if (decode.type === TYPES_PRIVILEGIES.deverrouillageReponse) {
      rapport.etat = decode.message.etat;
      rapport.barrieres = decode.message.barrieres;
      pont.verrouillage.refletDeLEtat();
      publier();
    }
    if (decode.type === TYPES_PRIVILEGIES.battement) {
      // Un SIGNE DE VIE, et rien d'autre : il ne règle aucune promesse, il repousse la borne de
      // l'attente qu'il nomme.
      demandesEnVol.get(decode.message.correlation)?.repousser();
      return;
    }
    if (decode.type === TYPES_PRIVILEGIES.barriere) {
      rapport.barrieres = decode.message.barrieres;
      pont.verrouillage.signalerActivite("barriere");
      publier();
      pont.frontiere.pousserLaBarriere();
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
   * @param {string} nomDuType clé de `TYPES_PRIVILEGIES`
   * @param {Record<string, unknown>} corps
   */
  function demanderAuWorker(nomDuType, corps = {}) {
    if (pont.cycle.estMort()) return Promise.reject(pont.cycle.refusDeMort());
    corrélationSuivante += 1;
    const correlation = `c${corrélationSuivante}`;
    return new Promise((rendre, refuser) => {
      let minuterie = null;
      const armer = () => {
        minuterie = setTimeout(() => {
          demandesEnVol.delete(correlation);
          pont.cycle.constaterLaMort(CAUSES_DE_MORT.silence);
          refuser(pont.cycle.refusDeMort());
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
   * Traite ce qui arrive sur le CANAL DE RELAIS. Deux types seulement, et tout le reste est ignoré :
   * ce canal ne comprend pas le vocabulaire privilégié, et c'est ce qui le rend étanche.
   *
   * @param {unknown} donnee
   */
  function surMessageDeRelais(donnee) {
    const decode = decoderMessage(donnee);
    if (!decode.ok) return;
    if (decode.type !== TYPES_RELAIS.reponse && decode.type !== TYPES_RELAIS.refus) return;
    const attente = relaisEnVol.get(decode.message.correlation);
    if (attente === undefined) return;
    relaisEnVol.delete(decode.message.correlation);
    if (decode.type === TYPES_RELAIS.refus) {
      return attente.refuser(
        Object.assign(new Error(decode.message.message ?? "requête relayée refusée"), {
          code: decode.message.code,
        }),
      );
    }
    attente.rendre(decode.message);
  }

  /**
   * RELAIE une requête HTTP jusqu'au guest, et rend ce qu'il a répondu.
   *
   * La borne est CELLE DU RELAIS et non celle de la mort du Worker : une requête HTTP qui n'aboutit
   * pas dit que l'application n'a pas répondu, pas que le Worker est mort. Les confondre ferait
   * déclarer morte, sur une page lente, une coquille dont tout le reste fonctionne — et le
   * verrouillage suivrait.
   *
   * @param {{ methode: string, chemin: string, entetes: [string, string][], corps: string | null }} requete
   */
  function relayerRequete(requete) {
    if (pont.cycle.estMort()) return Promise.reject(pont.cycle.refusDeMort());
    relaisSuivant += 1;
    const correlation = `h${relaisSuivant}`;
    return new Promise((rendre, refuser) => {
      const minuterie = setTimeout(() => {
        relaisEnVol.delete(correlation);
        refuser(
          Object.assign(new Error(messageDeRefus(CODES_REFUS_COQUILLE.gesteRompu)), {
            code: CODES_REFUS_COQUILLE.gesteRompu,
          }),
        );
      }, DELAI_RELAIS_MS);
      const clore = (geste) => (valeur) => {
        clearTimeout(minuterie);
        geste(valeur);
      };
      relaisEnVol.set(correlation, { rendre: clore(rendre), refuser: clore(refuser) });
      relais.port1.postMessage(
        enveloppeDeMessage(TYPES_RELAIS.requete, { ...requete, correlation }),
      );
    });
  }

  /** Le dernier état CONNU, tel que le relevé le publie. Il n'est jamais plus vieux que lui. */
  function rapportDEtat() {
    return { etat: rapport.etat, barrieres: rapport.barrieres };
  }

  /**
   * La demande d'état, sous la forme que le port restreint attend en retour. Elle ne REJETTE
   * jamais (voir le raisonnement original dans l'historique de `main.mjs` avant #175) : un refus du
   * Worker sur la question d'état est un défaut de la coquille, jamais une faute du document
   * applicatif.
   */
  async function demanderLEtat() {
    try {
      const reponse = await demanderAuWorker("etat");
      return chargeUtileDEtat({ etat: reponse.etat, barrieres: reponse.barrieres });
    } catch {
      return chargeUtileDEtat(rapportDEtat());
    }
  }

  /**
   * L'état PRIVILÉGIÉ, avec ce que le port restreint ne reçoit jamais : le constat d'exclusivité.
   */
  async function demanderLEtatPrivilegie() {
    try {
      return await demanderAuWorker("etat");
    } catch {
      return rapportDEtat();
    }
  }

  return {
    worker,
    demanderAuWorker,
    demanderLEtat,
    demanderLEtatPrivilegie,
    relayerRequete,
    rapportDEtat,
    terminerLeWorker: () => worker.terminate(),
    /**
     * Rejette toute demande en vol avec l'erreur que `fabriquerLeRefus` construit — sur les DEUX
     * canaux. Le relais y est inclus depuis #192 : une mort du Worker qui laisserait une requête
     * HTTP en attente laisserait le cadre devant une page qui ne vient jamais, c'est-à-dire le
     * SILENCE que « un refus typé, jamais un silence » interdit.
     */
    rejeterTout(fabriquerLeRefus) {
      for (const [correlation, attente] of demandesEnVol) {
        demandesEnVol.delete(correlation);
        attente.refuser(fabriquerLeRefus());
      }
      for (const [correlation, attente] of relaisEnVol) {
        relaisEnVol.delete(correlation);
        attente.refuser(fabriquerLeRefus());
      }
    },
  };
}
