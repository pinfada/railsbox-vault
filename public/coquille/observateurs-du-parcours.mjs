// Les OBSERVATEURS du parcours guidé, côté page (#193, ADR 0040) — scindés de
// `parcours-de-la-page.mjs` quand il a atteint 745 lignes (#250, #251, #252).
//
// Ce module ne décide rien non plus : il LIT ce que les modules de branchement publient — lignes
// d'état, relevés, refus — et en tire la réussite ou la conduite qu'une personne lit, la progression
// d'un démarrage, et le pas de la visite qu'une ouverture fait franchir. Il ne touche ni aux blocs
// montrés, ni au focus : c'est `rendre`, reçu de la page, qui le fait après chaque observation.

import * as accueil from "/src/coquille/accueil-de-la-mise-a-jour.mjs";
import {
  conduiteDUnRefusSansCode,
  conduiteDUnRefusSansCodeConnu,
  conduiteHumaine,
} from "/src/coquille/conduites-du-parcours.mjs";
import {
  COFFRE,
  ECRANS_DE_L_APPLICATION,
  MESSAGES,
  SOUS_ETATS_DU_CODE,
  codeEnFinDeTexte,
  etapeApres,
  lireLigneDEtat,
  progressionDuDemarrage,
  refusDeRelaisAAnnoncer,
} from "/src/coquille/parcours.mjs";
import { CODES_REFUS_COQUILLE } from "/src/coquille/refus-de-coquille.mjs";

/** Les lignes d'un démarrage refusé, dont la conduite se lit dans la réponse publiée (#250). */
const DEMARRAGES_REFUSES = Object.freeze([
  "sans-application",
  "demarrage-refuse",
  "reprise-refusee",
]);

/** Cadence de la progression annoncée pendant un démarrage : assez rare pour un lecteur d'écran. */
const ANNONCE_DE_PROGRESSION_MS = 10_000;

/** Cadence à laquelle la page regarde si la phase d'un démarrage a changé (contre-recette de #249). */
const SONDE_DE_LA_PHASE_MS = 1_000;

/**
 * BRANCHE les observateurs sur les relevés publiés. Chaque relevé qui change peut changer l'écran :
 * l'observateur réagit, puis la page REND.
 *
 * @param {{ noeud: (id: string) => HTMLElement | null, etat: object,
 *           dire: (id: string, texte: string) => void, lireJson: (id: string) => object,
 *           pas: (evenement: string, valeur?: unknown) => void,
 *           allerA: (etape: number | null) => void, rendre: () => void }} page
 */
export function brancherLesObservateurs({ noeud, etat, dire, lireJson, pas, allerA, rendre }) {
  function refuser(code) {
    dire("parcours-reussite", "");
    dire("parcours-refus", conduiteHumaine(code));
  }

  function refuserSansCode(texte) {
    dire("parcours-reussite", "");
    dire("parcours-refus", texte);
  }

  function reussir(texte) {
    dire("parcours-refus", "");
    dire("parcours-reussite", texte);
  }

  function surOuverture(avant) {
    if (avant === COFFRE.ouvert || etat.coffre !== COFFRE.ouvert) return;
    const depuis = etat.ecranDuGeste ?? etat.ecran;
    if (depuis === "choisir") pas("coffre-cree");
    // Ce que l'ouverture PROUVE de la feuille, c'est le Worker qui l'a constaté et publié dans le même
    // relevé que l'état ouvert ; `rendre` l'a déjà retenu en indice (#239).
    const eprouvee = lireJson("coquille-rapport").feuilleEprouvee === true;
    allerA(etapeApres(depuis, "ouverture", etat.pointeur));
    dire("parcours-attente", "");
    reussir(
      eprouvee && depuis === "code-verifier" ? MESSAGES.feuilleEprouvee : MESSAGES.coffreOuvert,
    );
  }

  function surLigneDuCycle() {
    const ligne = lireLigneDEtat(noeud("cycle-etat").textContent);
    if (ligne === null) return;
    if (ligne.evenement !== "demarrage-en-cours") arreterLaProgression();
    if (ligne.evenement !== "application-demarree") etat.referenceDesRefus = null;
    if (ligne.evenement === "demarrage-en-cours") return demarrerLaProgression();
    if (ligne.evenement === "application-demarree") {
      etat.applicationArretee = false;
      const rapport = lireJson("coquille-rapport");
      etat.referenceDesRefus = { ...(rapport.refusDeRequete ?? {}) };
      return reussir(accueil.texteDeDemarrage(rapport));
    }
    // Un démarrage — ou une reprise — refusé : la réponse PUBLIÉE dit laquelle, signature comprise
    // (#250). « Aucune application » n'est lu que d'une origine qui n'en sert aucune.
    if (DEMARRAGES_REFUSES.includes(ligne.evenement)) {
      dire("parcours-attente", "");
      const application = lireJson("coquille-rapport").application;
      return refuser(accueil.codeDuDemarrageRefuse(application, ligne.code ?? null));
    }
    if (ligne.evenement === "verrouillage-en-cours") {
      return dire("parcours-attente", MESSAGES.verrouillageEnCours);
    }
    if (ligne.evenement === "reprise-en-cours") {
      return dire("parcours-attente", MESSAGES.repriseEnCours);
    }
    if (ligne.evenement.endsWith("-refuse") || ligne.evenement.endsWith("-refusee")) {
      dire("parcours-attente", "");
      return refuser(ligne.code ?? CODES_REFUS_COQUILLE.gesteRompu);
    }
  }

  function surLigneDePortabilite() {
    const ligne = lireLigneDEtat(noeud("portabilite-etat").textContent);
    if (ligne === null || ligne.evenement === "au-repos") return;
    if (ligne.evenement === "sauvegarde-en-cours") {
      const cycle = lireLigneDEtat(noeud("cycle-etat").textContent)?.evenement;
      etat.etaitDemarree = cycle === "application-demarree" && !etat.applicationArretee;
      etat.applicationArretee = true;
      etat.referenceDesRefus = null;
      return dire("parcours-attente", MESSAGES.sauvegardeEnCours);
    }
    if (ligne.evenement.endsWith("-en-cours")) {
      return dire("parcours-attente", MESSAGES.restaurationEnCours);
    }
    dire("parcours-attente", "");
    if (ligne.evenement.endsWith("-refusee")) return refuser(ligne.code);
    if (ligne.evenement === "sauvegarde-prete") {
      reussir(accueil.texteDeSauvegardePrete(etat.etaitDemarree === true));
      // Un refus qui TIENT reste affiché après la sauvegarde (Q7) : elle ne l'a pas levé.
      const tient = accueil.refusQuiTient(lireJson("coquille-rapport"));
      return tient === null ? undefined : dire("parcours-refus", conduiteHumaine(tient));
    }
    if (ligne.evenement === "restauree") {
      pas("restauree");
      allerA(etapeApres("restaurer", "restauree", etat.pointeur));
      return reussir(MESSAGES.restauree);
    }
    if (ligne.evenement === "revoque") {
      etat.revocationFaite = true;
      const revocation = lireJson("coquille-rapport").portabilite?.revocation ?? {};
      const retires = revocation.nombreRetires ?? 0;
      return reussir(
        retires === 0
          ? MESSAGES.revoqueSansRien
          : MESSAGES.revoque(retires, revocation.versionEnveloppe ?? "?"),
      );
    }
  }

  function surRefusDeDeverrouillage() {
    const texte = noeud("deverrouillage-refus").textContent.trim();
    if (texte === "") return;
    dire("parcours-attente", "");
    const code = codeEnFinDeTexte(texte);
    if (code !== null) return refuser(code);
    // Un refus sans code n'arrive JAMAIS brut dans l'alerte : il reste sous « détails techniques ».
    refuserSansCode(conduiteDUnRefusSansCode(texte));
  }

  function surRefusDePortabiliteSansCode() {
    const texte = noeud("portabilite-refus").textContent.trim();
    if (texte === "" || codeEnFinDeTexte(texte) !== null) return;
    const connue = conduiteDUnRefusSansCodeConnu(texte);
    if (connue !== null) return refuserSansCode(connue);
    // Un refus de geste écrit aussi sa LIGNE d'état, qui porte le code : c'est elle qui l'a dit.
    const ligne = lireLigneDEtat(noeud("portabilite-etat").textContent);
    if (ligne?.evenement.endsWith("-refusee") !== true)
      refuserSansCode(conduiteDUnRefusSansCode(texte));
  }

  function surEtatDeLaCoquille() {
    const ligne = lireLigneDEtat(noeud("coquille-etat").textContent);
    if (ligne === null) return;
    const verrouillage = lireLigneDEtat(noeud("cycle-etat").textContent);
    if (ligne.evenement === "worker-mort" && verrouillage?.evenement !== "verrouillage-en-cours") {
      return refuser(CODES_REFUS_COQUILLE.workerMort);
    }
    if (ligne.evenement === "indisponible" || ligne.evenement === "capacite-manquante") {
      return refuser(CODES_REFUS_COQUILLE.capaciteManquante);
    }
    if (ligne.evenement === "erreur") refuser(ligne.code ?? CODES_REFUS_COQUILLE.gesteRompu);
  }

  function surRapport() {
    if (!ECRANS_DE_L_APPLICATION.includes(etat.ecran)) return;
    const rapport = lireJson("coquille-rapport");
    const nouveaux = refusDeRelaisAAnnoncer({
      comptes: rapport.refusDeRequete ?? {},
      reference: etat.referenceDesRefus,
    });
    if (nouveaux.length === 0) return;
    etat.referenceDesRefus = { ...(rapport.refusDeRequete ?? {}) };
    refuser(nouveaux[0]);
  }

  function surFeuille() {
    const code = noeud("feuille-code").textContent.trim();
    if (code === "" || etat.sousEtatDuCode !== SOUS_ETATS_DU_CODE.annonce) return;
    etat.sousEtatDuCode = SOUS_ETATS_DU_CODE.feuille;
    etat.nouveauCodeDemande = false;
    const version = /\d+/.exec(noeud("feuille-version").textContent)?.[0] ?? null;
    pas("code-rendu", version === null ? null : Number(version));
    dire("parcours-consigne-feuille", MESSAGES.consigneDeLaFeuille(version ?? "?"));
  }

  // --- La PROGRESSION d'un démarrage : du temps écoulé et des signes de vie réels ---------------------

  function demarrerLaProgression() {
    if (etat.demarrage !== null) return;
    noeud("parcours-attente").style.minHeight = "";
    const recus = () => lireJson("coquille-rapport").mesures?.battements?.recus ?? 0;
    const depart = { instant: performance.now(), battements: recus() };
    const dite = { phase: undefined, a: 0 };
    const annoncer = () => {
      const rapport = lireJson("coquille-rapport");
      // Un CHANGEMENT de phase se dit tout de suite ; sinon, toutes les dix secondes (contre-recette, 1).
      const phase = rapport.mesures?.battements?.phase ?? null;
      if (phase === dite.phase && performance.now() - dite.a < ANNONCE_DE_PROGRESSION_MS) return;
      Object.assign(dite, { phase, a: performance.now() });
      const ecouleMs = performance.now() - depart.instant;
      // UNE durée par chemin, et la PHASE du dernier battement (recette QA de la PR #249, Q2).
      const chemin = accueil.progressionDuChemin({
        chemin: accueil.cheminDuDemarrage(rapport),
        secondes: Math.max(0, Math.round(ecouleMs / 1000)),
        phase,
      });
      const signesDeVie = recus() - depart.battements;
      dire("parcours-attente", chemin ?? progressionDuDemarrage({ ecouleMs, signesDeVie }));
    };
    noeud("parcours-progression").hidden = false;
    annoncer();
    etat.demarrage = setInterval(annoncer, SONDE_DE_LA_PHASE_MS);
  }

  /**
   * La ligne d'attente GARDE la place qu'elle occupait, jusqu'au prochain geste de la personne (#251).
   *
   * Mesuré le 20/09/2026 (`tools/reproduire-le-premier-clic.mjs`) : à l'instant où l'application
   * s'affiche, la ligne de progression se vide, et tout ce qui la suit — `#cycle`, qui porte
   * « Verrouiller mon coffre » — remonte. Une main déjà visée clique alors à côté, sans aucun signe.
   * La place est donc retenue tant que personne n'a agi, puis rendue au premier geste REÇU : le clic
   * est livré d'abord, la page se referme ensuite, et rien ne bouge sous un doigt.
   */
  function retenirLaPlaceDeLAttente() {
    const ligne = noeud("parcours-attente");
    if (ligne === null) return;
    const hauteur = ligne.getBoundingClientRect().height;
    if (hauteur === 0) return;
    ligne.style.minHeight = `${hauteur}px`;
    const rendre = () => {
      ligne.style.minHeight = "";
    };
    for (const type of ["click", "keydown"]) {
      ligne.ownerDocument.addEventListener(type, rendre, { once: true });
    }
  }

  function arreterLaProgression() {
    if (etat.demarrage === null) return;
    clearInterval(etat.demarrage);
    etat.demarrage = null;
    retenirLaPlaceDeLAttente();
    noeud("parcours-progression").hidden = true;
    dire("parcours-attente", "");
  }

  // --- Les observateurs : chaque relevé publié peut changer l'écran ---------------------------------

  function observer(id, reagir) {
    const cible = noeud(id);
    if (cible === null) return;
    new MutationObserver(() => {
      const avant = etat.coffre;
      reagir();
      rendre();
      surOuverture(avant);
      rendre();
    }).observe(cible, { childList: true, characterData: true, subtree: true });
  }

  observer("deverrouillage-moyens", () => {});
  observer("deverrouillage-releve", () => {});
  observer("deverrouillage-refus", surRefusDeDeverrouillage);
  observer("deverrouillage-attente", () => {
    if (noeud("deverrouillage-attente").textContent.trim() !== "") {
      dire("parcours-attente", MESSAGES.ouvertureEnCours);
    }
  });
  observer("feuille-code", surFeuille);
  observer("cycle-etat", surLigneDuCycle);
  observer("portabilite-etat", surLigneDePortabilite);
  observer("portabilite-refus", surRefusDePortabiliteSansCode);
  observer("coquille-etat", surEtatDeLaCoquille);
  observer("coquille-rapport", surRapport);
}
