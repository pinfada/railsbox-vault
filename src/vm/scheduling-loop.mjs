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
// la boucle de v86 à 250 tours par seconde. Un message de canal n'est pas bridé.
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

/**
 * Boucle proprement dite. Elle ne connaît que sa cible : `MessageChannel` et `setTimeout` sont pris
 * SUR elle, ce qui la rend éprouvable sous Node avec un faux contexte.
 *
 * @param {{ MessageChannel: Function, setTimeout: Function }} cible
 */
function creerBoucle(cible) {
  const enAttente = new Map();
  const canal = new cible.MessageChannel();
  let sequence = 0;
  let appels = 0;

  canal.port1.onmessage = (evenement) => {
    const tache = enAttente.get(evenement.data);
    enAttente.delete(evenement.data);
    if (tache) tache();
  };

  const immediat = (tache) => {
    sequence += 1;
    enAttente.set(sequence, tache);
    canal.port2.postMessage(sequence);
  };

  const postTask = (rappel, options = {}) =>
    new Promise((resolve, reject) => {
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
      if (Number.isFinite(delai) && delai > 0) cible.setTimeout(executer, delai);
      else immediat(executer);
    });

  return {
    postTask,
    appels: () => appels,
    fermer() {
      canal.port1.onmessage = null;
      canal.port1.close();
      canal.port2.close();
      enAttente.clear();
    },
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
        enumerable: true,
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
    return { source: SOURCES_BOUCLE.native, natifPresent: true, appels: () => null, retirer() {} };
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
  try {
    poserOrdonnanceur(cible, composerOrdonnanceur(boucle, natif));
  } catch (erreur) {
    // Une pose refusée ne doit pas laisser un canal de messages ouvert derrière elle : il
    // maintiendrait le contexte en vie pour une boucle que personne n'emprunte.
    boucle.fermer();
    throw erreur;
  }
  const descripteur = {
    source: natif ? SOURCES_BOUCLE.vaultSurNative : SOURCES_BOUCLE.vault,
    natifPresent: Boolean(natif),
    appels: boucle.appels,
    // Un descripteur RETIRÉ décrit une boucle qui n'est plus en place. Sans ce drapeau, un compte
    // rendu continuerait d'annoncer « boucle de Vault » après un retrait — exactement le genre de
    // succès simulé que le harnais de mesure de #74 doit rendre impossible.
    retiree: false,
    retirer() {
      if (descripteur.retiree) return;
      descripteur.retiree = true;
      POSEES.delete(cible);
      boucle.fermer();
      if (natif) cible.scheduler = natif;
      else delete cible.scheduler;
    },
  };
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
  return {
    source: descripteur.source,
    natifPresent: descripteur.natifPresent,
    appels: descripteur.appels(),
  };
}
