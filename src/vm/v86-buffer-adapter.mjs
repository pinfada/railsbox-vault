// Adaptateur entre le contrat de stockage de Vault (`read`/`write`/`flush`/`size`, promesses,
// erreurs typées) et le contrat de tampon disque de v86 (`get`/`set`/`load`, callbacks, aucun canal
// d'erreur). L'écart le plus lourd est celui-là : `get(start, len, fn)` et `set(start, data, fn)`
// n'offrent AUCUN moyen de signaler un échec au périphérique IDE.
//
// Le repli « rendre des zéros » ou « appeler le callback quand même » est interdit par
// `docs/architecture.md` : il transformerait une erreur de support en donnée valide pour le guest.
// L'adaptateur choisit donc l'arrêt explicite : il n'acquitte pas l'opération, marque le volume en
// panne et remonte l'erreur typée à l'appelant, à charge pour lui d'arrêter la VM.
//
// ## La QUIESCENCE (#65, ADR 0024, décision 5 — ADR 0003 amendé)
//
// L'ADR 0003 refusait explicitement les instantanés mémoire, et il disait pourquoi : « hors
// périmètre tant qu'ils ne sont pas liés à une génération du volume ». La condition est remplie
// depuis l'ADR 0024, et l'amendement porte sur DEUX gestes exactement — `get_state` et `set_state`.
// `get_buffer` reste refusé, pour la raison inchangée : un volume Vault ne se recopie pas en un
// `ArrayBuffer` unique.
//
// L'état QUIESCÉ est le filet de la capture. Il refuse de s'établir tant qu'une E/S est en vol, il
// refuse toute E/S tant qu'il dure, et il COMPTE les violations pour que la capture échoue
// proprement plutôt que de produire un fichier « probablement bon ». Il ne prétend pas que le guest
// soit au repos : c'est l'arrêt de l'émulateur qui fait le repos, et l'adaptateur ne voit que les
// E/S qui lui arrivent.
//
// **Aucune E/S refusée n'est acquittée.** Le rappel de v86 n'est pas appelé, et le backend n'est
// pas touché : un acquittement pendant une capture serait exactement le mensonge que
// `SEC-DURABLE-001` interdit.

import { JOURNAL_OPERATIONS } from "./block-journal.mjs";
import { STORAGE_ERROR_CODES, StorageError } from "./storage-errors.mjs";

/**
 * Toute défaillance du support devient une `StorageError` avant d'entrer dans le journal ou dans
 * `onFatal`. La couture est ici, au niveau du module, parce qu'elle ne dépend d'aucun état de
 * l'adaptateur : elle ne fait que refuser qu'une erreur nue traverse la frontière du contrat.
 *
 * @param {unknown} error
 * @returns {StorageError}
 */
function typerEchecDeSupport(error) {
  return error instanceof StorageError
    ? error
    : new StorageError(
        STORAGE_ERROR_CODES.handleLost,
        `Échec non typé du support : ${error?.message ?? error}`,
        {},
      );
}

/** Refus TYPÉ de l'état quiescé. La cause est dans le contexte, jamais devinée par l'appelant. */
function refusDeQuiescence(raison, contexte = {}) {
  return new StorageError(STORAGE_ERROR_CODES.quiesce, raison, contexte);
}

/**
 * L'état QUIESCÉ, tenu à part de l'adaptateur.
 *
 * Il vit ici plutôt que dans le corps de la fabrique pour la raison qui a déjà découpé la moitié du
 * dépôt : le plafond de cinquante lignes vise l'ENCHAÎNEMENT DE DÉCISIONS, et trois décisions —
 * établir, rendre, refuser — forment un objet à part entière. Elles ne dépendent que de `fail`, qui
 * leur est passé.
 *
 * @param {(erreur: StorageError, contexte: object) => void} fail
 */
function creerQuiescence(fail) {
  let actif = false;
  let violations = 0;

  return {
    get actif() {
      return actif;
    },
    get violations() {
      return violations;
    },

    /**
     * ÉTABLIT la quiescence, ou refuse. Deux refus, et ils disent la même chose : on ne capture pas
     * au-dessus d'une E/S. Une écriture EN VOL n'est pas encore chez le support, et la mémoire
     * capturée l'aurait pourtant vue ; une FAUTE déjà retenue veut dire que le support a lâché, et
     * l'état qu'on capturerait ne serait celui de personne.
     */
    etablir({ fatal, inFlight }) {
      if (fatal !== null) {
        throw refusDeQuiescence(
          `Quiescence refusée : l'adaptateur porte déjà la faute ${fatal.code}. Capturer au-dessus d'une faute donnerait un instantané d'un état que personne ne tient.`,
          { cause: fatal.code },
        );
      }
      if (inFlight > 0) {
        throw refusDeQuiescence(
          `Quiescence refusée : ${inFlight} E/S en vol. Une écriture en vol n'est pas encore chez le support, et la mémoire capturée l'aurait pourtant vue.`,
          { inFlight },
        );
      }
      actif = true;
      violations = 0;
      return Object.freeze({ quiesce: true });
    },

    /**
     * REND l'adaptateur au guest, et publie ce que la quiescence a vu. Publier plutôt que lever
     * laisse la capture décider — elle seule sait si elle a déjà écrit quelque chose à défaire.
     */
    reprendre() {
      actif = false;
      const vues = violations;
      violations = 0;
      return Object.freeze({ quiesce: false, violations: vues });
    },

    /**
     * Refuse une E/S présentée PENDANT la quiescence, et rend vrai si elle a été refusée.
     *
     * Elle est comptée, journalisée et remontée à `onFatal` — mais le rappel d'acquittement de v86
     * n'est PAS appelé et le backend n'est PAS touché. C'est la seule conduite qui ne mente ni au
     * guest ni au support : le guest atteindra son délai de garde ATA, ce que l'ADR 0003 a déjà
     * retenu pour une panne de support, et la capture apprendra qu'elle doit échouer.
     */
    refuser(source, contexte) {
      if (!actif) return false;
      violations += 1;
      const refus = refusDeQuiescence(
        `E/S « ${source} » refusée : une capture d'instantané est en cours et l'adaptateur est quiescé. Aucune écriture n'est faite, aucun clair n'est rendu, et rien n'est acquitté — un acquittement pendant une capture serait un mensonge sur la durabilité.`,
        { source, ...contexte },
      );
      fail(refus, { source, ...contexte });
      return true;
    },
  };
}

/** La liaison que l'instantané lie, ou un refus TYPÉ si l'adaptateur n'en tient aucune. */
function liaisonOuRefus(liaisonDeVolume) {
  if (liaisonDeVolume === null) {
    throw new StorageError(
      STORAGE_ERROR_CODES.unsupported,
      "Instantané refusé : cet adaptateur ne tient aucune liaison de volume. Un instantané se lie à un identifiant de volume, une séquence et une génération validées (ADR 0024) ; sans elles, il ne se lierait à rien.",
    );
  }
  return liaisonDeVolume();
}

/** Confronte une liaison PRÉSENTÉE à celle du volume RÉELLEMENT ouvert, ou refuse. */
function confronterLiaisonPresentee(etat, liaison) {
  if (!Array.isArray(etat) || etat.length !== 3) {
    throw new StorageError(
      STORAGE_ERROR_CODES.unsupported,
      `set_state refusé : une liaison d'instantané porte exactement trois valeurs — volume, séquence, génération. Reçu ${Array.isArray(etat) ? `${etat.length} valeur(s)` : typeof etat}.`,
    );
  }
  const [volume, sequence, generation] = etat;
  if (
    volume === liaison.volume &&
    sequence === liaison.sequence &&
    generation === liaison.generation
  ) {
    return;
  }
  throw new StorageError(
    STORAGE_ERROR_CODES.identiteVolume,
    `Restauration refusée : l'instantané est lié au volume ${volume} en séquence ${sequence} et génération ${generation}, le volume ouvert est ${liaison.volume} en séquence ${liaison.sequence} et génération ${liaison.generation}. Aucune instruction n'a encore été exécutée ; le boot à froid ne perd rien.`,
    { attendu: liaison, presente: { volume, sequence, generation } },
  );
}

/**
 * @param {{ backend: import("./memory-block-backend.mjs").MemoryBlockBackend,
 *           onFatal: (error: StorageError) => void,
 *           liaisonDeVolume?: () => { volume: string, sequence: number, generation: number } }} options
 *   `liaisonDeVolume` est ce que l'instantané LIE : l'identifiant du volume, la séquence et la
 *   génération validées. Absente, `get_state` et `set_state` restent refusés comme avant l'ADR 0024
 *   — un banc qui ne capture rien n'a pas à la fournir, et un adaptateur qui l'inventerait scellerait
 *   un instantané lié à un état que personne ne tient.
 */
export function createV86BufferAdapter({ backend, onFatal, liaisonDeVolume = null }) {
  if (typeof onFatal !== "function") {
    throw new TypeError(
      "L'adaptateur exige un gestionnaire onFatal : une erreur de support ne peut pas rester sans destinataire.",
    );
  }

  const journal = backend.journal;
  let fatal = null;
  let inFlight = 0;

  // Retient la PREMIÈRE erreur, journalise, puis prévient le runtime — dans cet ordre : `onFatal`
  // peut arrêter la VM, et le journal doit déjà porter la trace quand il le fait.
  const fail = (error, context) => {
    const typed = typerEchecDeSupport(error);
    if (fatal === null) fatal = typed;
    journal.record(JOURNAL_OPERATIONS.failure, {
      code: typed.code,
      message: typed.message,
      ...context,
    });
    onFatal(typed);
  };

  const quiescence = creerQuiescence(fail);

  // Le contrat est RENDU directement : l'adaptateur n'a jamais eu besoin de se nommer lui-même, et
  // le rendre tel quel laisse voir qu'au-delà des quelques gestes ci-dessus, cette fabrique ne fait
  // que déclarer les neuf membres attendus par `ide.js`.
  return {
    /** Géométrie lue une seule fois par `ide.js` à la construction. */
    byteLength: backend.size(),
    onload: undefined,
    onprogress: undefined,

    /** v86 attend `onload` même quand rien n'est à charger. */
    load() {
      if (typeof this.onload === "function") this.onload({});
    },

    /**
     * @param {number} start
     * @param {number} length
     * @param {(data: Uint8Array) => void} fn
     * @param {{ signal?: AbortSignal }} [options]
     */
    get(start, length, fn, options) {
      if (quiescence.refuser("get", { offset: start, length })) return;
      inFlight += 1;
      backend
        .read(start, length)
        .then((data) => {
          // v86 annule ses E/S en vol lors d'un reset. Le callback reste appelé : c'est `ide.js`
          // qui filtre, et ne pas l'appeler laisserait fuir son identifiant d'opération.
          if (options?.signal?.aborted) {
            journal.record(JOURNAL_OPERATIONS.mark, {
              label: "get-aborted",
              offset: start,
              length,
            });
          }
          fn(data);
        })
        .catch((error) => fail(error, { source: "get", offset: start, length }))
        .finally(() => {
          inFlight -= 1;
        });
    },

    /**
     * @param {number} start
     * @param {Uint8Array} slice
     * @param {() => void} fn
     */
    set(start, slice, fn) {
      if (quiescence.refuser("set", { offset: start, length: slice.byteLength })) return;
      // COPIE OBLIGATOIRE : sur le chemin PIO, `ide.js` passe une vue de son tampon interne
      // (`this.data.subarray(...)`) qu'il réutilise dès l'instruction suivante. Un backend
      // asynchrone qui garderait la vue écrirait des octets déjà remplacés.
      const owned = slice.slice();
      inFlight += 1;
      backend
        .write(start, owned)
        .then(() => fn())
        .catch((error) => fail(error, { source: "set", offset: start, length: owned.byteLength }))
        .finally(() => {
          inFlight -= 1;
        });
    },

    /**
     * Barrière de durabilité. Absente du contrat de tampon amont : c'est le pont installé par
     * `v86-flush-bridge.mjs` qui l'appelle, sur réception d'un ATA FLUSH CACHE.
     * @param {() => void} fn acquittement, appelé seulement si la barrière a abouti
     * @param {(error: StorageError) => void} [onError] permet au pont d'abandonner la commande ATA
     *   au lieu de laisser le guest attendre son délai de garde. L'échec reste aussi fatal côté
     *   runtime : le guest apprend « erreur d'E/S », l'exploitant apprend laquelle.
     */
    flush(fn, onError) {
      if (quiescence.refuser("flush", {})) return;
      inFlight += 1;
      backend
        .flush()
        .then(() => fn())
        .catch((error) => {
          fail(error, { source: "flush" });
          if (typeof onError === "function") onError(error);
        })
        .finally(() => {
          inFlight -= 1;
        });
    },

    /** Snapshot mémoire : hors périmètre du spike #4, refusé explicitement. */
    get_buffer() {
      throw new StorageError(
        STORAGE_ERROR_CODES.unsupported,
        "get_buffer n'est pas fourni : un volume Vault ne se recopie pas en un ArrayBuffer unique.",
      );
    },

    /** ÉTABLIT la quiescence : le premier geste d'une capture (ADR 0024, décision 5). */
    quiescer() {
      return quiescence.etablir({ fatal, inFlight });
    },

    /** REND l'adaptateur au guest, et publie le nombre d'E/S vues pendant la capture. */
    reprendre() {
      return quiescence.reprendre();
    },

    /**
     * Rend la LIAISON du volume, et RIEN du disque (ADR 0024, décisions 3 et 5).
     *
     * v86 appelle ce geste sur le tampon du disque pendant `save_state`. Le contrat amont attend
     * l'état du tampon ; nous rendons trois valeurs — identifiant de volume, séquence et génération
     * validées — parce que le volume est la seule source de vérité et qu'un instantané qui portait
     * les octets du disque en serait une seconde copie, capable de le contredire.
     *
     * Il n'est disponible QUE pendant la quiescence : un instantané pris pendant que l'adaptateur
     * sert encore le guest décrirait un disque en mouvement.
     */
    get_state() {
      // La LIAISON d'abord, la quiescence ensuite, et l'ordre porte un diagnostic : un adaptateur
      // qui ne tient aucune liaison ne produira JAMAIS d'instantané, quiescé ou non, et lui
      // répondre « quiescez d'abord » désignerait un remède qui n'existe pas.
      const liaison = liaisonOuRefus(liaisonDeVolume);
      if (!quiescence.actif) {
        throw refusDeQuiescence(
          "get_state refusé : un instantané ne se prend que sur un adaptateur QUIESCÉ. Hors quiescence, l'état capturé décrirait un disque en mouvement.",
        );
      }
      return [liaison.volume, liaison.sequence, liaison.generation];
    },

    /**
     * CONFRONTE la liaison d'un instantané au volume réellement ouvert, et refuse tout écart.
     *
     * v86 appelle ce geste pendant `restore_state`, avant que le guest n'ait battu une seule fois.
     * L'écart est donc constaté au seul moment où il ne coûte rien : aucune instruction n'a encore
     * été exécutée sur un disque qui n'est pas celui que la mémoire croit tenir.
     *
     * Il n'exige PAS la quiescence, et c'est une asymétrie voulue : la capture se fait sur un
     * émulateur arrêté qu'on quiesce pour s'en assurer, la restauration se fait sur un émulateur
     * qui n'a pas encore démarré — il n'y a rien à quiescer.
     */
    set_state(etat) {
      confronterLiaisonPresentee(etat, liaisonOuRefus(liaisonDeVolume));
    },

    /** État observable par le runtime, jamais par le guest. */
    status() {
      return {
        fatal,
        inFlight,
        quiesce: quiescence.actif,
        violations: quiescence.violations,
      };
    },
  };
}
