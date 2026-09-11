// Le CYCLE de la page — démarrage, mort du Worker, bouton « Rouvrir » (#175 : scission de
// `public/main.mjs`).
//
// Ce module tient le déroulé des huit étapes de `docs/architecture.md`, la constatation de la mort
// du Worker (#163, ADR 0030) et le geste qui rouvre après elle (#171). Il ne décide d'aucune
// conduite lui-même : `src/coquille/` reste seul maître. Il ne parle aux trois autres modules de
// branchement que par le RELEVÉ et par le pont que `main.mjs` lui passe.

import { ISSUES_DETAPE, journalDuCycle } from "/src/coquille/cycle-de-vie.mjs";
import { brancherLesGestesDuCycle } from "/src/coquille/gestes-du-cycle.mjs";
import { ETATS_DU_VOLUME } from "/src/coquille/etat-de-la-coquille.mjs";
import { mesurerLesCapacites } from "/src/coquille/capacites-de-la-coquille.mjs";
import { conduiteApresLaMort } from "/src/coquille/mort-du-worker.mjs";
import { monterLInterface } from "/src/coquille/interface-de-deverrouillage.mjs";
import { cadreApplicatif } from "/src/coquille/origines-de-la-coquille.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "/src/coquille/refus-de-coquille.mjs";
import { derivationsDeLaPage } from "/src/coquille/derivation-dans-la-page.mjs";

/** Paramètre du CHEMIN encadré (voir le raisonnement dans l'historique de `main.mjs` avant #175). */
const PARAMETRE_CHEMIN = "document-applicatif";

/**
 * @param {object} config
 * @param {object} config.rapport
 * @param {() => void} config.publier
 * @param {(nom: string) => void} config.mesurer
 * @param {(etat: string, texte: string) => void} config.terminer
 * @param {number} config.depart origine des mesures, l'évaluation du module
 * @param {boolean} config.encadree
 * @param {URLSearchParams} config.parametres
 * @param {{ canal: object, frontiere: object, verrouillage: object }} config.pont
 */
export function creerCycle({
  rapport,
  publier,
  mesurer,
  terminer,
  depart,
  encadree,
  parametres,
  pont,
}) {
  /** Le JOURNAL DU CYCLE. Il date depuis l'évaluation du module, comme les autres mesures. */
  const cycle = journalDuCycle({
    maintenant: () => Math.round((performance.now() - depart) * 10) / 10,
  });

  /** Publie le cycle dans le relevé. Appelé après chaque étape conclue. */
  function inscrire(etape, issue, motif = null) {
    cycle.conclure(etape, issue, motif);
    rapport.cycle = cycle.releve();
  }

  /**
   * ÉTAPE 1 — identités et compatibilité, mesurées ICI et pas dans la sonde (voir le raisonnement
   * dans l'historique de `main.mjs` avant #175).
   */
  const capacites = mesurerLesCapacites(globalThis);
  rapport.capacites = {
    presentes: capacites.presentes,
    manquantes: capacites.manquantes,
    suffisante: capacites.suffisante,
  };
  inscrire(
    "identites",
    capacites.suffisante ? ISSUES_DETAPE.franchie : ISSUES_DETAPE.indisponible,
    capacites.manquantes.length === 0 ? null : capacites.manquantes.join(","),
  );

  /** Ce que la mort du Worker de confiance a fait constater, quand elle a eu lieu. */
  let mortDuWorker = null;

  /** La poignée de l'interface, une fois montée. Elle ne détient aucune clé. */
  let interfaceDeDeverrouillage = null;

  /** L'instant du dernier GESTE de l'utilisateur, origine des deux mesures de #162. */
  let departDuGeste = null;

  /**
   * Les deux dérivations que la PAGE fait elle-même, liées au canal privilégié de cette coquille.
   */
  const derivations = derivationsDeLaPage({
    demanderAuWorker: pont.canal.demanderAuWorker,
    urlDuWorker: new URL("../derivation-worker.mjs", import.meta.url),
  });

  function estMort() {
    return mortDuWorker !== null;
  }

  /** Le dernier constat de mort, TEL QUEL (`null` si le Worker vit). */
  function mortDuWorkerActuel() {
    return mortDuWorker;
  }

  /** Le refus que TOUT geste reçoit une fois la mort constatée. Il porte SON code, pas un autre. */
  function refusDeMort() {
    return Object.assign(new Error(messageDeRefus(CODES_REFUS_COQUILLE.workerMort)), {
      code: CODES_REFUS_COQUILLE.workerMort,
    });
  }

  /**
   * N'exécute un geste que si le Worker vit. Sinon, le refus TYPÉ, tout de suite.
   */
  function siVivant(geste) {
    return mortDuWorker === null ? geste() : Promise.reject(refusDeMort());
  }

  /**
   * CONSTATE la mort, une fois, et tient la conduite : refuser tout service jusqu'à un geste
   * explicite.
   *
   * @param {string} cause une valeur de `CAUSES_DE_MORT`
   */
  function constaterLaMort(cause, { offrirLeGesteQuiRouvre = true } = {}) {
    if (mortDuWorker !== null) return mortDuWorker;
    pont.verrouillage.surveillance.desarmer();
    mortDuWorker = conduiteApresLaMort({
      cause,
      etatConnu: rapport.etat,
      barrieres: rapport.barrieres,
    });
    rapport.etat = mortDuWorker.etat;
    rapport.workerMort = {
      cause,
      code: mortDuWorker.code,
      interfaceRemontee: mortDuWorker.interfaceRemontee,
      derivationPermise: mortDuWorker.derivationPermise,
      pousseeDeBarriere: mortDuWorker.pousseeDeBarriere,
      kekRetenue: mortDuWorker.kekRetenue,
    };
    pont.canal.rejeterTout(refusDeMort);
    remonterLInterface();
    if (offrirLeGesteQuiRouvre) offrirLaReouverture();
    publier();
    terminer("worker-mort", `coquille:worker-mort:${cause}`);
    return mortDuWorker;
  }

  /**
   * REMONTE l'interface de déverrouillage après une mort. Montrée, pas actionnée.
   */
  function remonterLInterface() {
    if (interfaceDeDeverrouillage !== null) return;
    interfaceDeDeverrouillage = monterLInterface({
      document,
      racine: document,
      demander: () => Promise.reject(refusDeMort()),
      deriverPhrase: () => Promise.reject(refusDeMort()),
      deriverPasskey: () => Promise.reject(refusDeMort()),
      agent: navigator.userAgent,
    });
  }

  /**
   * OFFRE le geste qui ROUVRE : un bouton, révélé par la mort, qui RECHARGE la coquille.
   */
  function offrirLaReouverture() {
    const bouton = document.querySelector("#rouvrir-la-coquille");
    if (bouton === null) return;
    bouton.hidden = false;
    bouton.addEventListener("click", () => location.reload(), { once: true });
  }

  /**
   * Marque une surveillance NEUTRALISÉE. Ce n'est pas une conduite : c'est l'absence de conduite.
   */
  const SANS_SURVEILLANCE = Object.freeze({
    cause: "neutralisee",
    etat: ETATS_DU_VOLUME.indisponible,
    code: CODES_REFUS_COQUILLE.capaciteManquante,
  });

  async function demarrer() {
    if (encadree) {
      return terminer("refusee", "coquille:encadree-refusee");
    }
    if (!capacites.suffisante) {
      mortDuWorker = SANS_SURVEILLANCE;
      pont.canal.terminerLeWorker();
      return terminer(
        "indisponible",
        `coquille:capacite-manquante:${capacites.manquantes.join(",")}`,
      );
    }
    const cible = cadreApplicatif(location.origin, parametres.get(PARAMETRE_CHEMIN));
    rapport.origineApplicative = cible?.origineApplicative ?? null;

    const premierEtat = await pont.canal.demanderLEtatPrivilegie();
    if (mortDuWorker !== null) return;
    rapport.exclusivite = premierEtat.exclusivite ?? null;
    inscrire("exclusiviteEtCanal", ISSUES_DETAPE.franchie, rapport.exclusivite?.verdict ?? null);
    rapport.canalPrivilegie = "etabli";
    rapport.journal.push("canal-privilegie-etabli");
    mesurer("canalPrivilegieMs");
    publier();

    interfaceDeDeverrouillage = monterLInterface({
      document,
      racine: document,
      demander: pont.canal.demanderAuWorker,
      deriverPhrase: (appel) => siVivant(() => derivations.deriverPhrase(appel)),
      deriverPasskey: (appel) => siVivant(() => derivations.deriverPasskey(appel)),
      agent: navigator.userAgent,
      surEtat: (reponse) => {
        rapport.etat = reponse.etat;
        rapport.barrieres = reponse.barrieres;
        rapport.journal.push("volume-ouvert");
        pont.verrouillage.refletDeLEtat();
        publier();
      },
      surMesure: (instant) => {
        if (instant === "geste") {
          departDuGeste = performance.now();
          return;
        }
        if (departDuGeste === null) return;
        const ecoule = Math.round((performance.now() - departDuGeste) * 10) / 10;
        rapport.mesures[instant === "annonce" ? "annonceApresLeGesteMs" : "deverrouillageMs"] =
          ecoule;
        publier();
      },
    });
    await interfaceDeDeverrouillage.rafraichirLInventaire();
    await pont.canal.demanderLEtat();
    rapport.journal.push("interface-de-deverrouillage-montee");
    const gestes = brancherLesGestesDuCycle({
      racine: document,
      demander: pont.canal.demanderAuWorker,
      cycle,
      rapport,
      publier,
      ...pont.verrouillage.gestesDeVerrouillage(),
    });
    pont.verrouillage.definirGesteDeVerrouillage(gestes.verrouillerLeCoffre);

    inscrire("backendPuisVm", ISSUES_DETAPE.differee, "volume-verrouille");
    publier();

    if (cible === null) return terminer("sans-cadre", "coquille:origine-applicative-indeterminee");
    if (!cycle.peutEncadrer()) {
      return terminer("erreur", `coquille:erreur:${CODES_REFUS_COQUILLE.etapeHorsOrdre}`);
    }
    pont.frontiere.creerLeCadre(cible.url);
    inscrire("cadreEtPort", ISSUES_DETAPE.franchie);
    return terminer("prete", "coquille:prete");
  }

  return {
    demarrer() {
      return demarrer().catch((erreur) => {
        if (mortDuWorker !== null) return;
        rapport.requetesRefusees += 1;
        rapport.refusDeRequete[CODES_REFUS_COQUILLE.typeInconnu] =
          (rapport.refusDeRequete[CODES_REFUS_COQUILLE.typeInconnu] ?? 0) + 1;
        terminer("erreur", `coquille:erreur:${String(erreur?.code ?? "demarrage")}`);
      });
    },
    estMort,
    mortDuWorkerActuel,
    constaterLaMort,
    refusDeMort,
    siVivant,
  };
}
