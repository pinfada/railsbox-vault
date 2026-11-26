// LA CAPACITÉ DU STOCKAGE, tenue par le Worker de confiance (#231, revues de la PR #305).
//
// Le Worker ne sait pas, au démarrage, s'il peut ouvrir un volume : WebKit 26.6+ expose
// `navigator.storage.getDirectory` mais le REJETTE (`UnknownError`) en contexte éphémère, rejet que le
// moteur dit « transitoire ». La capacité est une machine explicite (`src/coquille/capacite-du-stockage.mjs`),
// que seules la SONDE et un ÉCHEC DE LECTURE font changer, par les transitions écrites.
//
// RIEN n'est figé. Un message présenté tant que la capacité est réessayable relance la sonde
// (`reessayerLaSonde`) : si elle aboutit, le coffre redevient `verrouille` sans rechargement. Et
// `disponible` n'est pas un cul-de-sac : une lecture réelle qui rejette APRÈS une sonde réussie
// (`noterUnEchecDeLecture`) la fait repasser en `indetermine` ou en `panne:<code>`.
//
// La sonde est ASYNCHRONE et SANS `await` au niveau du module — un `await` de premier niveau fait perdre
// ses premiers messages à un Worker module (mesuré sur les trois moteurs, `docs/compatibility.md`), et la
// poignée de main de la coquille serait muette. Sa première promesse (`premiereSonde`) est ATTENDUE par
// tout ce qui en dépend : `surMessagePrivilegie` (l'inventaire et chaque geste) et `publierLEtat` (qui
// attend d'abord, lit l'état ensuite).

import {
  ETATS_DE_CAPACITE,
  apresLaSonde,
  apresUnEchecDeLecture,
  capaciteInitiale,
  etatPublie,
  peutOuvrir,
  refusDeCapacite,
  reessayable,
} from "/src/coquille/capacite-du-stockage.mjs";
import { ETATS_DU_VOLUME } from "/src/coquille/etat-de-la-coquille.mjs";
import { classerLaLectureEnEchec, sonderLeStockageEnDetail } from "/src/vm/sonde-du-stockage.mjs";

/**
 * @param {{ interne: { etat: string }, apiPresente: boolean }} contexte `interne.etat` est tenu à jour
 */
export function creerLaCapaciteDuWorker({ interne, apiPresente }) {
  let capacite = capaciteInitiale({ apiPresente });
  /** Une seule sonde à la fois : les messages qui la réclament partagent sa promesse. */
  let sondeEnCours = null;

  function appliquerLaSonde({ verdict, code }) {
    capacite = apresLaSonde(capacite, { verdict, code });
    interne.etat = etatPublie(capacite);
  }

  /**
   * Lance la sonde, ou rend celle qui court. Elle n'est appelée qu'avant la première conclusion et tant
   * que la capacité est réessayable : une absence ÉTABLIE et une capacité `disponible` ne se resondent
   * pas, et la machine (`apresLaSonde`) LÈVE sur toute autre transition.
   */
  function reessayerLaSonde() {
    sondeEnCours ??= sonderLeStockageEnDetail()
      .then(appliquerLaSonde)
      .finally(() => {
        sondeEnCours = null;
      });
    return sondeEnCours;
  }

  /**
   * Note l'échec d'une LECTURE réelle — l'inventaire, un geste — survenu APRÈS une sonde réussie. Si
   * c'est celui du stockage (`classerLaLectureEnEchec`), la capacité repasse en `indetermine` ou en
   * `panne:<code>` et l'état publié suit. Rend vrai quand l'échec a été noté. Un volume OUVERT n'est pas
   * touché (sa panne a ses propres refus), et toute erreur du domaine reste ce qu'elle est.
   */
  function noterUnEchecDeLecture(erreur) {
    const echec = classerLaLectureEnEchec(erreur);
    if (echec === null || interne.etat === ETATS_DU_VOLUME.ouvert) return false;
    capacite = apresUnEchecDeLecture(capacite, echec);
    interne.etat = etatPublie(capacite);
    return true;
  }

  /** Le corps d'un inventaire INCONNU : jamais « aucun coffre », toujours le refus typé qui le dit. */
  function corpsDInventaireInconnu() {
    const refus = refusDeCapacite({ etat: ETATS_DE_CAPACITE.indetermine });
    return {
      present: false,
      versionEnveloppe: null,
      emplacements: [],
      inconnu: true,
      refus: { code: refus.code, message: refus.message },
    };
  }

  return Object.freeze({
    premiereSonde: apiPresente ? reessayerLaSonde() : Promise.resolve(),
    reessayerLaSonde,
    noterUnEchecDeLecture,
    corpsDInventaireInconnu,
    peutOuvrir: () => peutOuvrir(capacite),
    reessayable: () => reessayable(capacite),
    refus: () => refusDeCapacite(capacite),
    etatPublie: () => etatPublie(capacite),
  });
}
