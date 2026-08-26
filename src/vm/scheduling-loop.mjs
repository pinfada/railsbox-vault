// Boucle d'ordonnancement de v86, fournie par Vault (#74 — option 3′ de l'[ADR 0013]).
//
// v86 arrête son chemin d'ordonnancement à l'ÉVALUATION de son module, sur deux conditions :
// `globalThis.scheduler.postTask` doit être une fonction ET `location.href` doit contenir
// « use-scheduling-api ». Poser cette boucle AVANT l'import de `libv86.mjs` fait donc emprunter à
// v86 NOTRE implémentation, sans blob, sans Worker imbriqué, sans élargir la CSP de la coquille.
//
// Elle est posée TOUJOURS, y compris par-dessus une implémentation native. Ce n'est pas un excès de
// prudence : Firefox EXPOSE `scheduler.postTask`, et c'est précisément son implémentation native
// qui monopolise le thread du Worker dès que v86 démarre (mesuré, ADR 0013). « Poser seulement si
// l'API manque » ne débloquerait donc pas Firefox. Le mode `siNatifAbsent` existe parce que le
// harnais de mesure `npm run test:csp` compare les deux ; il n'est pas ce que le produit utilise.
//
// Elle est posée dans les WORKERS de Vault uniquement, jamais dans une page : v86 vit dans le
// Worker (ADR 0002), et remplacer l'ordonnanceur d'un document changerait le rythme de code qui
// n'est pas le nôtre pour un gain nul. La pose dans un contexte portant `document` est refusée.
//
// Le délai nul passe par un `MessageChannel` et non par `setTimeout` : au-delà de cinq
// imbrications, les moteurs bornent `setTimeout(…, 0)` à quatre millisecondes, ce qui plafonnerait
// la boucle de v86 à 250 tours par seconde. Un message de canal n'est pas bridé de cette façon.
//
// **Mais « pas bridé » n'est que la moitié du fait, et l'autre moitié coûte cher.** Mesuré le
// 2026-08-26 dans un Worker de la coquille, sur les trois moteurs
// (`tests/browser/ordonnancement-famine.spec.mjs`) : pendant une boucle serrée de messages de
// canal, **WebKit n'exécute AUCUNE minuterie** — ni `setInterval`, ni `setTimeout` — tant que la
// boucle dure ; Chromium et Firefox les exécutent. Les messages venus de la page, eux, passent
// partout : le port n'est pas la même source de tâches. Un chien de garde posé sur une minuterie
// seule ne pourrait donc ni échantillonner ni expirer pendant la plage qu'il borne — celle où v86
// tourne à plein. C'est pourquoi cette boucle expose ses BATTEMENTS (`auBattement`) et pourquoi
// `cadencer` s'en sert : une échéance se consulte depuis la boucle elle-même.
//
// Ce que `postTask` posé N'IMPLÉMENTE PAS, et que la plateforme offre : `priority` est ignorée, et
// `signal` n'est honoré que s'il est DÉJÀ abandonné à la prise en charge — une annulation survenant
// ensuite ne l'est pas. v86 n'en passe aucun des deux (`postTask(rappel, { delay })`, valeur de
// retour jetée). Un `delay > 0` retombe sur `setTimeout` du contexte, donc sous le plafond de
// quatre millisecondes après cinq imbrications : cet effet n'est PAS mesuré ici, et v86 ne l'atteint
// pas dans les relevés du dépôt (le compteur d'appels y suit le compteur de tours).
//
// [ADR 0013]: ../../docs/decisions/0013-csp-de-la-coquille-et-boucle-de-v86.md

/** D'où vient la boucle réellement en place après la pose. */
export const SOURCES_BOUCLE = Object.freeze({
  /** Rien n'a été posé : l'implémentation du moteur reste en place. */
  native: "native",
  /** Boucle de Vault posée là où le moteur n'offrait rien. */
  vault: "vault",
  /** Boucle de Vault posée PAR-DESSUS l'implémentation du moteur — le cas de Firefox et Chromium. */
  vaultSurNative: "vault-sur-native",
});

/** Une pose par contexte : un second appel rend la boucle déjà en place, il n'en empile pas. */
const POSEES = new WeakMap();

/** Fautes d'abonnés retenues par boucle. Bornées : un compte rendu n'est pas un journal. */
const MAX_INCIDENTS = 10;

/**
 * Chemin `setTimeout` de la boucle, et sa MESURE (#87).
 *
 * Deux nombres, parce qu'un seul ne dirait rien : le nombre d'appels à `delay > 0` dit si ce chemin
 * est emprunté du tout, l'imbrication maximale dit s'il approche les cinq niveaux au-delà desquels
 * les moteurs bornent le délai à quatre millisecondes. Un chemin jamais emprunté rend `0` et `0` —
 * ce qui est une mesure, pas une absence. L'en-tête de ce module affirmait ce risque depuis #74 sans
 * que rien ne l'observe ; c'est ce que ce compteur corrige.
 *
 * Le niveau reproduit celui que la plateforme compte : une minuterie armée depuis le rappel d'une
 * autre minuterie est un cran plus profonde, une minuterie armée depuis une tâche du canal repart de
 * zéro — le canal n'est pas une minuterie.
 *
 * @param {{ setTimeout: Function }} cible
 */
function creerMinuteries(cible) {
  let appels = 0;
  let imbricationMax = 0;
  /** Niveau d'imbrication de la tâche EN COURS quand elle vient d'une minuterie ; 0 sinon. */
  let courante = 0;

  return {
    differer(tache, delai) {
      appels += 1;
      const profondeur = courante + 1;
      if (profondeur > imbricationMax) imbricationMax = profondeur;
      cible.setTimeout(() => {
        const precedente = courante;
        courante = profondeur;
        try {
          tache();
        } finally {
          courante = precedente;
        }
      }, delai);
    },
    releve: () => ({ appels, imbricationMax }),
  };
}

/**
 * Boucle proprement dite. Elle ne connaît que sa cible : `MessageChannel` et `setTimeout` sont pris
 * SUR elle, ce qui la rend éprouvable sous Node avec un faux contexte.
 *
 * @param {{ MessageChannel: Function, setTimeout: Function }} cible
 */
function creerBoucle(cible) {
  const enAttente = new Map();
  const canal = new cible.MessageChannel();
  const abonnes = new Set();
  const incidents = [];
  const minuteries = creerMinuteries(cible);
  let sequence = 0;
  let appels = 0;

  /**
   * Un battement par tâche exécutée. C'est la seule horloge qui avance quand un moteur affame ses
   * minuteries sous une boucle serrée (mesuré sous WebKit) : sans elle, aucune échéance de ce
   * contexte n'expirerait pendant la plage où v86 tourne à plein.
   *
   * Un abonné fautif ne doit ni emporter l'émulateur, ni disparaître. Sa faute est donc CONSIGNÉE
   * — les comptes rendus la publient par `decrireBoucle` — et le tour suivant a lieu quand même.
   * La relancer hors de la boucle en ferait une exception non attrapée par tour, c'est-à-dire un
   * bruit qui noierait la panne au lieu de la nommer.
   */
  const battre = () => {
    for (const abonne of [...abonnes]) {
      try {
        abonne();
      } catch (erreur) {
        if (incidents.length < MAX_INCIDENTS) incidents.push(String(erreur?.message ?? erreur));
      }
    }
  };

  canal.port1.onmessage = (evenement) => {
    const tache = enAttente.get(evenement.data);
    enAttente.delete(evenement.data);
    if (tache) tache();
    battre();
  };

  const immediat = (tache) => {
    sequence += 1;
    enAttente.set(sequence, tache);
    canal.port2.postMessage(sequence);
  };

  const postTask = (rappel, options = {}) =>
    new Promise((resolve, reject) => {
      // `signal` et `priority` de la plateforme ne sont PAS implémentés (v86 n'en passe aucun).
      // Un signal DÉJÀ abandonné est pourtant décidable sans machinerie : l'ignorer exécuterait une
      // tâche que l'appelant a annulée. Une annulation SURVENANT après la prise en charge, elle,
      // n'est pas honorée — c'est dit dans l'en-tête de ce module et dans l'ADR 0013.
      if (options.signal?.aborted) {
        reject(options.signal.reason ?? new DOMException("Tâche abandonnée", "AbortError"));
        return;
      }
      appels += 1;
      const executer = () => {
        try {
          resolve(rappel());
        } catch (erreur) {
          // Une tâche fautive rejette SA promesse et n'emporte pas la boucle : v86 confie ici le
          // tour suivant de l'émulateur, et une boucle morte ne se distinguerait pas d'un thread
          // monopolisé — la panne même que cette boucle traite.
          reject(erreur);
        }
      };
      const delai = Number(options.delay ?? 0);
      if (Number.isFinite(delai) && delai > 0) minuteries.differer(executer, delai);
      else immediat(executer);
    });

  return {
    postTask,
    appels: () => appels,
    /** Relevé du chemin `setTimeout` : combien de fois emprunté, et jusqu'à quelle imbrication. */
    minuteries: minuteries.releve,
    incidents: () => incidents.slice(),
    auBattement(rappel) {
      abonnes.add(rappel);
      return () => abonnes.delete(rappel);
    },
    fermer() {
      canal.port1.onmessage = null;
      canal.port1.close();
      canal.port2.close();
      enAttente.clear();
      abonnes.clear();
    },
  };
}

/**
 * Cadence robuste : appelle `rappel` au plus une fois par `periodeMs`, et depuis DEUX sources — la
 * minuterie du contexte **et** les battements de la boucle d'ordonnancement.
 *
 * Les deux sont nécessaires, et pour des raisons opposées :
 *
 *  - **la minuterie seule ne suffit pas.** Mesuré le 2026-08-26 dans un Worker de la coquille : sous
 *    WebKit, une boucle serrée de messages de canal donne priorité stricte au port, et ni
 *    `setInterval` ni `setTimeout` ne s'exécutent tant qu'elle dure. Or c'est exactement la plage
 *    qu'un chien de garde doit borner — celle où v86 tourne à plein ;
 *  - **la boucle seule ne suffit pas non plus.** Une boucle qui ne bat pas — la panne que le chien
 *    de garde nomme — ne cadencerait rien. Mais elle n'affame alors plus personne, et la minuterie
 *    reprend la main.
 *
 * Le bridage est PARTAGÉ : deux sources dans la même période ne produisent qu'un rappel.
 *
 * @param {() => void} rappel
 * @param {{ periodeMs?: number, boucle?: { auBattement?: Function } | null, horloge?: () => number,
 *           planifier?: (rappel: () => void, ms: number) => unknown,
 *           annuler?: (identifiant: unknown) => void }} [options]
 * @returns {() => void} arrêt : annule la minuterie et désabonne la boucle
 */
export function cadencer(
  rappel,
  {
    periodeMs = 250,
    boucle = null,
    horloge = () => Date.now(),
    planifier = (fonction, ms) => setTimeout(fonction, ms),
    annuler = (identifiant) => clearTimeout(identifiant),
  } = {},
) {
  let dernier = horloge();
  let minuterie = null;
  let arrete = false;

  const battre = () => {
    if (arrete) return;
    const maintenant = horloge();
    if (maintenant - dernier < periodeMs) return;
    dernier = maintenant;
    rappel();
  };

  // La minuterie se réarme elle-même : un `setInterval` accumulerait ses rappels en retard derrière
  // une plage de famine, et les libérerait tous d'un coup à la sortie.
  const armer = () => {
    minuterie = planifier(() => {
      battre();
      if (!arrete) armer();
    }, periodeMs);
  };
  armer();

  const desabonner =
    typeof boucle?.auBattement === "function" ? boucle.auBattement(battre) : () => {};

  return () => {
    if (arrete) return;
    arrete = true;
    annuler(minuterie);
    desabonner();
  };
}

/**
 * Écrit `scheduler` sur la cible, et VÉRIFIE que l'écriture a pris. Sans ce contrôle, un contexte
 * qui refuse l'affectation laisserait v86 emprunter la boucle du moteur en silence — la panne de
 * #74 — avec en plus un compte rendu affirmant le contraire.
 */
function poserOrdonnanceur(cible, valeur) {
  const refus = [];
  try {
    cible.scheduler = valeur;
  } catch (erreur) {
    refus.push(`affectation : ${erreur.message}`);
  }
  if (cible.scheduler !== valeur) {
    try {
      Object.defineProperty(cible, "scheduler", {
        value: valeur,
        writable: true,
        configurable: true,
        // NON énumérable, comme le `scheduler` natif des moteurs mesurés. L'écart n'a aucun effet
        // connu, mais du code qui énumère le global verrait sinon apparaître une propriété que la
        // plateforme ne lui montre pas — et il est gratuit de ne pas la lui montrer (#87).
        enumerable: false,
      });
    } catch (erreur) {
      refus.push(`defineProperty : ${erreur.message}`);
    }
  }
  if (cible.scheduler !== valeur) {
    throw new Error(
      `La boucle d'ordonnancement de Vault n'a pas pu être posée sur « scheduler » dans ce contexte (${
        refus.join(" ; ") || "écriture sans effet"
      }). v86 emprunterait la boucle du moteur — voir l'ADR 0013 et l'issue #74.`,
    );
  }
}

/** Ordonnanceur de remplacement : notre `postTask`, et les autres membres du natif conservés. */
function composerOrdonnanceur(boucle, natif) {
  const remplacant = { postTask: boucle.postTask };
  // `scheduler.yield` n'est pas ce que v86 emprunte, mais le retirer priverait du code étranger
  // d'une capacité du moteur sans aucune raison mesurée. Il est relayé au natif, sur le natif.
  if (typeof natif?.yield === "function") {
    remplacant.yield = (...arguments_) => natif.yield(...arguments_);
  }
  return remplacant;
}

/**
 * Descripteur rendu à l'appelant : tout ce qu'un compte rendu peut dire de la boucle en place, et
 * le seul geste qui la retire. Il vit à part de la pose parce qu'il n'en est pas : la pose décide,
 * le descripteur OBSERVE.
 */
function creerDescripteur({ cible, boucle, natif, pose }) {
  const descripteur = {
    source: natif ? SOURCES_BOUCLE.vaultSurNative : SOURCES_BOUCLE.vault,
    natifPresent: Boolean(natif),
    appels: boucle.appels,
    /**
     * Relevé du chemin `setTimeout` (#87). Il est publié dans les comptes rendus parce que l'en-tête
     * de ce module affirmait un risque — le plafond de quatre millisecondes après cinq imbrications
     * — que rien ne mesurait. Ces deux nombres le mesurent.
     */
    minuteries: boucle.minuteries,
    /** Fautes d'abonnés aux battements, consignées plutôt que relancées ou perdues. */
    incidents: boucle.incidents,
    /**
     * Abonne un rappel aux battements de la boucle — un par tâche exécutée. C'est ce qui permet à
     * une échéance d'expirer sous un moteur qui affame ses minuteries pendant une boucle serrée.
     * Rend la fonction de désabonnement.
     */
    auBattement: boucle.auBattement,
    // Un descripteur RETIRÉ décrit une boucle qui n'est plus en place. Sans ce drapeau, un compte
    // rendu continuerait d'annoncer « boucle de Vault » après un retrait — exactement le genre de
    // succès simulé que le harnais de mesure de #74 doit rendre impossible.
    retiree: false,
    /**
     * Rend le contexte à son état d'origine — mais SEULEMENT si la boucle en place est encore la
     * nôtre. Un tiers qui aurait posé son ordonnanceur par-dessus se le ferait sinon retirer en
     * silence, puisque le retrait réaffecte le natif ou supprime la propriété. Le refus LÈVE, et ne
     * touche à rien : le retrait redevient possible dès que ce qui est en place est de nouveau à
     * nous (#87).
     */
    retirer() {
      if (descripteur.retiree) return;
      if (cible.scheduler !== pose) {
        throw new Error(
          "Retrait refusé : la boucle d'ordonnancement en place dans ce contexte n'est plus celle de Vault. La retirer emporterait l'ordonnanceur posé par un tiers — voir l'ADR 0013 et l'issue #87.",
        );
      }
      descripteur.retiree = true;
      POSEES.delete(cible);
      boucle.fermer();
      if (natif) cible.scheduler = natif;
      else delete cible.scheduler;
    },
  };
  return descripteur;
}

/**
 * Pose la boucle d'ordonnancement de Vault sur `cible`. À appeler AVANT tout import de
 * `libv86.mjs` : v86 fige son chemin à l'évaluation de son module et ne le révise jamais.
 *
 * @param {{ cible?: object, siNatifAbsent?: boolean }} [options]
 *   `siNatifAbsent` ne pose la boucle que si le contexte n'expose pas `scheduler.postTask`. Ce mode
 *   sert la comparaison du harnais `npm run test:csp` ; il ne débloque PAS Firefox (mesuré).
 * @returns {{ source: string, natifPresent: boolean, appels: () => number | null,
 *             retirer: () => void }}
 *   `appels` compte les tours confiés à NOTRE boucle : il distingue « boucle posée » de « boucle
 *   empruntée par v86 », que rien d'autre ne sépare dans un compte rendu.
 */
export function installerBoucleOrdonnancement({ cible = globalThis, siNatifAbsent = false } = {}) {
  if (cible.document !== undefined) {
    throw new Error(
      "La boucle d'ordonnancement de Vault ne se pose que dans un Worker : v86 y vit (ADR 0002) et remplacer l'ordonnanceur d'une page changerait le rythme de code étranger, sans gain.",
    );
  }
  const deja = POSEES.get(cible);
  if (deja) return deja;

  const natif = typeof cible.scheduler?.postTask === "function" ? cible.scheduler : null;
  if (natif && siNatifAbsent) {
    return {
      source: SOURCES_BOUCLE.native,
      natifPresent: true,
      appels: () => null,
      // Aucune boucle de Vault : aucun battement à offrir. La cadence retombe sur la minuterie
      // seule, ce qui est exact — sans boucle serrée de messages, rien ne l'affame.
      auBattement: () => () => {},
      retirer() {},
    };
  }
  if (typeof cible.MessageChannel !== "function") {
    throw new Error(
      "La boucle d'ordonnancement de Vault exige « MessageChannel » : sans lui, un délai nul retomberait sur « setTimeout », borné à quatre millisecondes après cinq imbrications.",
    );
  }
  if (typeof cible.setTimeout !== "function") {
    throw new Error("La boucle d'ordonnancement de Vault exige « setTimeout » pour les délais.");
  }

  const boucle = creerBoucle(cible);
  const pose = composerOrdonnanceur(boucle, natif);
  try {
    poserOrdonnanceur(cible, pose);
  } catch (erreur) {
    // Une pose refusée ne doit pas laisser un canal de messages ouvert derrière elle : il
    // maintiendrait le contexte en vie pour une boucle que personne n'emprunte.
    boucle.fermer();
    throw erreur;
  }
  const descripteur = creerDescripteur({ cible, boucle, natif, pose });
  POSEES.set(cible, descripteur);
  return descripteur;
}

/**
 * Forme sérialisable de la boucle pour un compte rendu de Worker. `null` quand aucune boucle de
 * Vault n'est en place — parce qu'aucune n'a été posée, ou parce qu'elle a été RETIRÉE. Cette
 * absence doit rester dicible : un objet vide se lirait comme une pose, et un descripteur périmé
 * ferait dire au compte rendu le contraire de ce qui s'est passé.
 */
export function decrireBoucle(descripteur) {
  if (!descripteur || descripteur.retiree) return null;
  const incidents = descripteur.incidents?.() ?? [];
  return {
    source: descripteur.source,
    natifPresent: descripteur.natifPresent,
    appels: descripteur.appels(),
    // Publié même à zéro : « v86 n'emprunte pas le chemin `setTimeout` » est un fait, et c'est
    // celui que #87 demandait de mesurer au lieu de le supposer.
    minuteries: descripteur.minuteries?.() ?? null,
    // Publié même vide : une liste absente se lirait comme « pas d'incident », une liste vide le
    // DIT. Un abonné aux battements qui lève est un défaut de notre code, pas du moteur.
    incidents,
  };
}
