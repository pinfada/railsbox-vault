// Le PARCOURS GUIDÉ, côté page (#193, ADR 0040).
//
// Ce module de branchement ne décide rien : l'écran à montrer, où mène un geste, ce que la progression
// en retient et ce qu'une personne lit sont dans `src/coquille/parcours.mjs` et
// `src/coquille/conduites-du-parcours.mjs`. Il n'appelle AUCUN geste du Worker de confiance : les
// boutons sont ceux de l'interface, du cycle et de la portabilité, branchés par leurs modules. Il LIT
// ce que ces modules publient — les relevés et les lignes d'état, dont c'est l'objet — et il montre,
// cache, nomme, ferme les boutons d'un geste en cours et annonce.
//
// Il écrit UNE chose hors du document : la progression, dans `parcours.json` à la racine de l'OPFS de
// l'origine de confiance (voir `parcours.mjs`). Jamais le code, jamais la phrase. En vue complète —
// le paramètre de HARNAIS des épreuves de frontière — il n'écrit rien : la progression y reste en
// mémoire, parce que ces épreuves jouent les gestes dans des ordres que le parcours n'offre pas.
//
// Il n'importe aucun des quatre autres modules de branchement, et ne leur parle pas : le relevé
// public suffit. Ses OBSERVATEURS de ces relevés vivent à part, dans `observateurs-du-parcours.mjs`
// (scission du 19/09/2026, #250) ; ce module garde l'écran, la progression et les gestes.

import { annonceDAttente, moteurProbable } from "/src/coquille/attente-annoncee.mjs";
import * as accueil from "/src/coquille/accueil-de-la-mise-a-jour.mjs";
import { conduiteHumaine } from "/src/coquille/conduites-du-parcours.mjs";
import {
  COFFRE,
  ECRANS,
  ECRANS_DE_L_APPLICATION,
  ETAPES,
  FICHIER_DE_PROGRESSION,
  GESTES_LONGS,
  LIBELLES_DE_LA_PAGE,
  LIMITE_DE_FIREFOX,
  MESSAGES,
  PROGRESSION_INITIALE,
  SOUS_ETATS_DU_CODE,
  STATUTS,
  annonceDeLaSaisie,
  attenteDeLaPhrase,
  coffreObserve,
  ecranCourant,
  ecrireProgression,
  etapeAdmise,
  etapeApres,
  etapeDeLURL,
  etapeSuivante,
  lireLigneDEtat,
  lireProgression,
  ouSuisJe,
  progressionApres,
  rangAffiche,
  texteSansCode,
  unGesteEstEnCours,
} from "/src/coquille/parcours.mjs";
import { brancherLesObservateurs } from "./observateurs-du-parcours.mjs";
import { etatDeLaSaisie } from "/src/coquille/saisie-du-code.mjs";

/** Les sections qui regroupent des blocs : cachées quand aucun de leurs blocs n'est montré. */
const SECTIONS = ["deverrouillage", "feuille", "cycle", "portabilite"];

/** Entrée dans un champ vaut le clic sur le bouton qu'il sert (revue de la PR #213, constat 12). */
const ENTREE_VAUT = Object.freeze({
  "saisie-phrase": ["ouvrir-par-phrase"],
  "saisie-code": ["ouvrir-par-code"],
  "ancre-version": ["ouvrir-par-code", "ouvrir-par-phrase"],
});

/**
 * @param {{ document: Document, location: Location, history: History, navigateur: Navigator }} hote
 */
export function creerParcoursDeLaPage({ document: doc, location: loc, history: hist, navigateur }) {
  const noeud = (id) => doc.getElementById(id);
  const parametres = new URL(loc.href).searchParams;
  const vueComplete = parametres.get("vue") === "complete";
  doc.documentElement.dataset.vue = vueComplete ? "complete" : "parcours";
  // Désactiver le bouton pendant le boot peut déjà renvoyer le focus au body.
  // Garder sa provenance, mais laisser tout autre geste de focus prendre la main.
  let dernierFocusSurDemarrage = false;
  doc.addEventListener("focusin", (evenement) => {
    if (evenement.target === doc.body || evenement.target === doc.documentElement) return;
    dernierFocusSurDemarrage = evenement.target === noeud("demarrer-application");
  });
  if (vueComplete) noeud("details-techniques").open = true;

  const moteur = moteurProbable(navigateur.userAgent);
  const etat = {
    progression: PROGRESSION_INITIALE,
    progressionLue: false,
    pointeur: null,
    sousEtatDuCode: SOUS_ETATS_DU_CODE.annonce,
    /** « Je n'ai plus cette feuille » : vrai jusqu'au prochain code affiché (#214). */
    nouveauCodeDemande: false,
    revocationFaite: false,
    /** « Terminer sans révoquer » (l'étape 9 est facultative) ; « J'ai oublié ma phrase ». */
    sansRevoquer: false,
    phrasePerdue: false,
    coffre: COFFRE.inconnu,
    ecran: null,
    /** L'écran montré au moment du dernier geste : c'est de lui qu'un geste réussi fait avancer. */
    ecranDuGeste: null,
    demarrage: null,
    /** Les refus du relais comptés quand l'application a démarré ; `null` tant qu'elle ne l'est pas. */
    referenceDesRefus: null,
    /** La sauvegarde ARRÊTE l'application sans que la ligne du cycle le dise : « Démarrer » reste
     *  offert au retour après l'étape 6 (#239). Vrai d'une sauvegarde au prochain démarrage. */
    applicationArretee: false,
  };

  const attenteDeLaPhraseAnnoncee = attenteDeLaPhrase(
    annonceDAttente({ moyen: "phrase", moteur }).attenteMs,
  );
  const passkeyConnue = typeof globalThis.PublicKeyCredential !== "undefined";

  /** La seule écriture du parcours dans le document : jamais un code de récupération en clair. */
  function dire(id, texte) {
    const cible = noeud(id);
    const propre = texteSansCode(texte);
    if (cible !== null && cible.textContent !== propre) cible.textContent = propre;
  }

  function lireJson(id) {
    try {
      return JSON.parse(noeud(id)?.textContent ?? "{}");
    } catch {
      return {};
    }
  }

  // --- La PROGRESSION : lue une fois, réécrite à chaque pas --------------------------------------------

  let ecritureEnCours = Promise.resolve();

  async function fichierDeProgression(creer) {
    const racine = await navigateur.storage.getDirectory();
    return racine.getFileHandle(FICHIER_DE_PROGRESSION, { create: creer });
  }

  async function chargerLaProgression() {
    if (vueComplete || typeof navigateur.storage?.getDirectory !== "function") {
      return PROGRESSION_INITIALE;
    }
    try {
      const fichier = await (await fichierDeProgression(false)).getFile();
      dire("parcours-progression-etat", "progression:lue");
      return lireProgression(await fichier.text());
    } catch (erreur) {
      // Aucun fichier : une personne qui commence. Toute autre erreur est DITE, et la progression
      // initiale est la lecture prudente — elle ne fait sauter aucune étape.
      const nom = erreur?.name ?? "Error";
      dire(
        "parcours-progression-etat",
        nom === "NotFoundError" ? "progression:absente" : `progression:illisible:${nom}`,
      );
      return PROGRESSION_INITIALE;
    }
  }

  function persister() {
    if (vueComplete || typeof navigateur.storage?.getDirectory !== "function") return;
    const texte = ecrireProgression(etat.progression);
    ecritureEnCours = ecritureEnCours.then(async () => {
      try {
        const flux = await (await fichierDeProgression(true)).createWritable();
        await flux.write(texte);
        await flux.close();
        dire("parcours-progression-etat", "progression:ecrite");
      } catch (erreur) {
        // Non écrite, la progression reste en mémoire : un rechargement ramènera à une étape plus
        // prudente, jamais plus loin. L'échec est publié, pas avalé.
        dire("parcours-progression-etat", `progression:non-ecrite:${erreur?.name ?? "Error"}`);
      }
    });
  }

  function pas(evenement, valeur = null) {
    etat.progression = progressionApres(etat.progression, evenement, valeur);
    persister();
  }

  function reecrireLURL(etape) {
    const url = new URL(loc.href);
    if (url.searchParams.get("etape") === String(etape)) return;
    url.searchParams.set("etape", String(etape));
    hist.replaceState(hist.state, "", url);
  }

  function allerA(etape) {
    if (etape === null) return;
    if (etape > etat.progression.etapeAtteinte) pas("etape", etape);
    if (etape === etat.pointeur) return;
    etat.pointeur = etape;
    reecrireLURL(etape);
  }

  // --- Ce qui est MONTRÉ ----------------------------------------------------------------------------

  function blocsDeLEcran(ecranId, releve) {
    const moyens = releve.moyensProposes ?? [];
    return ECRANS[ecranId].blocs.filter((bloc) => {
      if (ecranId === "rouvrir" && bloc === "phrase") return moyens.includes("phrase");
      // L'annonce n'offre de revenir, et de faire de la place par la révocation, qu'à un coffre qui
      // porte déjà un code : celui où l'on est venu dire « je n'ai plus cette feuille » (#239).
      if (ecranId === "code-annonce" && (bloc === "feuille-revenir" || bloc === "revocation")) {
        return (releve.nombreDeCodes ?? 0) > 0;
      }
      if (bloc === "passkey") {
        return ecranId === "choisir" ? passkeyConnue : moyens.includes("webauthn-prf");
      }
      return true;
    });
  }

  function montrerLesBlocs(visibles) {
    for (const element of doc.querySelectorAll("[data-bloc]")) {
      element.hidden = !vueComplete && !visibles.includes(element.dataset.bloc);
    }
    for (const id of SECTIONS) {
      const section = noeud(id);
      if (section === null) continue;
      section.hidden =
        !vueComplete && ![...section.querySelectorAll("[data-bloc]")].some((bloc) => !bloc.hidden);
    }
  }

  function nommerLesGestes(ecranId) {
    const creation = ecranId === "choisir";
    dire("ouvrir-par-phrase", creation ? "Créer mon coffre" : "Ouvrir mon coffre");
    dire(
      "ouvrir-par-passkey",
      creation ? "Créer mon coffre avec une passkey" : "Ouvrir mon coffre avec ma passkey",
    );
    dire("parcours-passkey", creation ? MESSAGES.passkeyALaCreation : MESSAGES.passkeyALOuverture);
    dire("parcours-continuer", MESSAGES.continuer(etapeAContinuer(ecranId)?.titre ?? null));
  }

  /**
   * L'étape où « Continuer » mène : depuis l'application, la prochaine étape NON jouée (#239) ;
   * ailleurs, celle qui suit l'écran.
   */
  function etapeAContinuer(ecranId) {
    const cible = etapeApres(ecranId, "continuer", etat.pointeur, etat.progression.etapeAtteinte);
    return ecranId === "travailler" && cible !== null ? ETAPES[cible - 1] : etapeSuivante(ecranId);
  }

  function rendreOuSuisJe(ecranId) {
    const liste = noeud("ou-suis-je-liste");
    const lignes = ouSuisJe(ecranId, etat.progression.origine, etat.progression).map(
      ({ rang, titre, statut }) => `${rang}. ${titre} — ${STATUTS[statut]}`,
    );
    const actuelles = [...liste.children].map((element) => element.textContent);
    if (actuelles.join("\n") === lignes.join("\n")) return;
    liste.replaceChildren(
      ...lignes.map((texte) => {
        const element = doc.createElement("li");
        element.textContent = texte;
        return element;
      }),
    );
  }

  /** Les boutons d'un geste long sont FERMÉS tant qu'un geste est en cours (#215). */
  function fermerLesGestesEnCours() {
    if (vueComplete) return;
    const enCours = unGesteEstEnCours({
      ligneDuCycle: noeud("cycle-etat")?.textContent,
      ligneDePortabilite: noeud("portabilite-etat")?.textContent,
      attenteDuDeverrouillage: noeud("deverrouillage-attente")?.textContent,
    });
    for (const id of GESTES_LONGS) {
      const bouton = noeud(id);
      if (bouton !== null && bouton.disabled !== enCours) bouton.disabled = enCours;
    }
  }

  /**
   * L'aide est un conteneur neutre, et un repli nommé seulement quand Rails est prêt (revue de la PR
   * #216, constat 7). Ses paragraphes sont DÉPLACÉS d'un conteneur à l'autre, jamais recréés : leurs
   * identifiants restent ceux que `dire` écrit. Le focus posé sur le résumé qui disparaît revient au
   * titre, pour ne pas tomber au document.
   */
  function mettreLAideEnForme(enRepli) {
    const actuelle = noeud("parcours-aide");
    if ((actuelle.tagName === "DETAILS") === enRepli) return;
    const remplacante = doc.createElement(enRepli ? "details" : "div");
    remplacante.id = "parcours-aide";
    const paragraphes = [...actuelle.children].filter((enfant) => enfant.tagName !== "SUMMARY");
    if (enRepli) {
      const resume = doc.createElement("summary");
      resume.textContent = LIBELLES_DE_LA_PAGE.aideDeLEtape;
      // Chromium n'expose pas le résumé comme nom du groupe : le repli est nommé explicitement.
      remplacante.setAttribute("aria-label", LIBELLES_DE_LA_PAGE.aideDeLEtape);
      remplacante.append(resume);
    }
    const focusDedans = actuelle.contains(doc.activeElement);
    remplacante.append(...paragraphes);
    actuelle.replaceWith(remplacante);
    if (focusDedans) noeud("parcours-titre").focus();
  }

  function ecranAMontrer(releve, rapport) {
    etat.coffre = coffreObserve({
      etat: rapport.etat,
      texteDesMoyens: noeud("deverrouillage-moyens").textContent,
      moyensProposes: releve.moyensProposes,
      dernierRefus: releve.dernierRefus,
    });
    if (!etat.progressionLue) return "chargement";
    return ecranCourant({
      pointeur: etat.pointeur,
      coffre: etat.coffre,
      moyens: releve.moyensProposes ?? [],
      nombreDeCodes: releve.nombreDeCodes,
      // Le CONSTAT du Worker, jamais l'indice du fichier : c'est la garde des étapes 4 à 9 (#239).
      feuilleEprouvee: rapport.feuilleEprouvee === true,
      progression: etat.progression,
      sousEtatDuCode: etat.sousEtatDuCode,
      revocationFaite: etat.revocationFaite,
      sansRevoquer: etat.sansRevoquer,
      phrasePerdue: etat.phrasePerdue,
      nouveauCodeDemande: etat.nouveauCodeDemande,
      refus: releve.dernierRefus ?? null,
      moteur,
    });
  }

  function rendre({ deplacerLeFocus = true } = {}) {
    const releve = lireJson("deverrouillage-releve");
    const rapport = lireJson("coquille-rapport");
    const ecranId = ecranAMontrer(releve, rapport);
    const ecran = ECRANS[ecranId];
    retenirLesIndices(ecranId, rapport);
    // Verrouillé, le coffre n'affiche aucun code : la feuille part avant même le rechargement (#239).
    if (etat.coffre === COFFRE.verrouille && etat.sousEtatDuCode !== SOUS_ETATS_DU_CODE.annonce) {
      etat.sousEtatDuCode = SOUS_ETATS_DU_CODE.annonce;
      dire("feuille-code", "");
    }
    // La vérification renouvelée à chaque session suspend la reprise sans oublier sa destination.
    // L'écran reste celui du code, même si le fichier demandait une étape ultérieure.
    const verification =
      ecranId === "code-verifier" ||
      ecranId === "code-a-verifier" ||
      ecranId === "code-a-verrouiller";
    if (ecran.etape === 3 && !(verification && etat.pointeur > 3)) allerA(3);
    if (ecran.etape === 4 && etat.pointeur === 3) allerA(4);
    if (ecranId === "refuse") dire("parcours-refus", conduiteHumaine(releve.dernierRefus));
    const precedent = etat.ecran;
    etat.ecran = ecranId;
    const visibles = blocsDeLEcran(ecranId, releve);
    const rang = rangAffiche(ecranId, etat.pointeur, etat.progression);
    dire("parcours-rang", rang === null ? "" : MESSAGES.rang(rang));
    dire("parcours-titre", ecran.titre);
    dire("parcours-ce-qui-va-se-passer", ecran.ceQuiVaSePasser);
    const surLApplication = ECRANS_DE_L_APPLICATION.includes(ecranId);
    const dephasage = surLApplication ? accueil.attenduSousLeDephasage(rapport) : null;
    dire("parcours-attendu", MESSAGES.attendu(dephasage ?? ecran.attendu));
    // Recette QA de la PR #249 : la version toujours dite (Q3), aucun geste impossible offert (Q7).
    dire("version-de-l-application", accueil.versionAffichee(rapport));
    noeud("demarrer-application").hidden = !vueComplete && !accueil.demarrerEstPossible(rapport);
    const limite = moteur === "firefox" && (ecranId === "creer" || ecranId === "choisir");
    dire("parcours-limite", limite ? LIMITE_DE_FIREFOX : "");
    // Le COMPTE des feuilles, là où la personne décide d'en demander une de plus (#214).
    const codes = releve.nombreDeCodes ?? 0;
    const compteDit = codes > 0 && (ecranId === "code-annonce" || ecranId === "code-a-verifier");
    dire("parcours-codes", compteDit ? MESSAGES.codesDejaRendus(codes) : "");
    const attente =
      (surLApplication ? accueil.attenteDuDephasage(rapport.dephasage) : null) ??
      ecran.attente ??
      (visibles.includes("phrase") ? attenteDeLaPhraseAnnoncee : "");
    dire("parcours-attente-annoncee", attente === "" ? "" : MESSAGES.duree(attente));
    const suivante = etapeSuivante(ecranId);
    dire("parcours-suivante", suivante === null ? "" : MESSAGES.suivante(suivante.titre));
    // Le code tapé ne survit pas à son champ : un champ vidé par un geste vide aussi son annonce.
    if ((noeud("saisie-code")?.value ?? "") === "") dire("parcours-code-lu", "");
    nommerLesGestes(ecranId);
    dire(
      "parcours-avertissement-revocation",
      MESSAGES.avertissementDeRevocation(releve.moyenDOuverture),
    );
    montrerLesBlocs(visibles);
    // Replier seulement les conseils quand Rails est prêt. Le cadre reste à sa place :
    // le déplacer rechargerait son document et lui ferait perdre le port restreint.
    const demarree =
      lireLigneDEtat(noeud("cycle-etat").textContent)?.evenement === "application-demarree" &&
      !etat.applicationArretee;
    direLEspaceDeTravail(demarree, rapport);
    const travailPret = !vueComplete && ECRANS_DE_L_APPLICATION.includes(ecranId) && demarree;
    const modeTravail = String(travailPret);
    if (doc.documentElement.dataset.travailPret !== modeTravail) {
      const focusSurDemarrage =
        doc.activeElement === noeud("demarrer-application") ||
        (doc.activeElement === doc.body && dernierFocusSurDemarrage);
      doc.documentElement.dataset.travailPret = modeTravail;
      mettreLAideEnForme(travailPret);
      if (travailPret && focusSurDemarrage) noeud("parcours-titre").focus();
    }
    rendreOuSuisJe(ecranId);
    fermerLesGestesEnCours();
    // Le focus suit un CHANGEMENT d'écran, jamais le premier affichage (ADR 0040, § 5).
    const premierAffichage = precedent === null || precedent === "chargement";
    if (precedent !== ecranId && !premierAffichage && deplacerLeFocus && !vueComplete) {
      noeud("parcours-titre").focus();
    }
  }

  /**
   * Ce que la page RETIENT de ce qu'elle observe, en indices de `parcours.json` (#239) : le constat du
   * Worker sur la feuille — relu seulement coffre OUVERT, seul moment où il existe —, et la fin de la
   * visite. Aucun des deux n'ouvre un écran : le premier choisit le formulaire d'un coffre verrouillé,
   * le second fait de l'étape 4 l'accueil.
   */
  function retenirLesIndices(ecranId, rapport) {
    if (!etat.progressionLue) return;
    const constat = rapport.feuilleEprouvee === true;
    if (etat.coffre === COFFRE.ouvert && constat !== etat.progression.feuilleEprouvee) {
      pas("feuille", constat);
    }
    const fin = ecranId === "termine" || ecranId === "termine-sans-revoquer";
    if (fin && !etat.progression.visiteTerminee) pas("visite-terminee");
  }

  /** Le cadre replié dit qu'il attend son démarrage, au lieu d'un rectangle blanc (#242, défaut 11). */
  function direLEspaceDeTravail(demarree, rapport) {
    const espace = noeud("cycle-description")?.closest("[data-bloc]");
    const valeur = demarree ? "demarree" : "attente";
    if (espace !== null && espace !== undefined && espace.dataset.application !== valeur) {
      espace.dataset.application = valeur;
    }
    dire(
      "cycle-description",
      demarree ? MESSAGES.applicationAffichee : accueil.texteDeLEspaceEnAttente(rapport),
    );
  }

  // --- Les gestes PROPRES au parcours : aucun ne parle au Worker -------------------------------------

  function geste(id, faire) {
    noeud(id)?.addEventListener("click", () => {
      faire();
      rendre();
    });
  }

  geste("parcours-commencer", () => allerA(etapeApres("creer", "commencer", etat.pointeur)));
  geste("parcours-j-ai-une-sauvegarde", () =>
    allerA(etapeApres("creer", "j-ai-une-sauvegarde", etat.pointeur)),
  );
  // La phrase oubliée ouvre le formulaire du code sans rien marquer de la visite (QA de #244).
  geste("parcours-phrase-perdue", () => {
    etat.phrasePerdue = true;
  });
  geste("parcours-sans-revoquer", () => {
    etat.sansRevoquer = true;
  });
  geste("parcours-continuer", () =>
    allerA(etapeApres(etat.ecran, "continuer", etat.pointeur, etat.progression.etapeAtteinte)),
  );
  // « Revenir à mon application » (#239) : aucun geste du Worker, l'étape 4 seulement. L'application
  // démarrée le reste ; arrêtée, « Démarrer » choisit entre installation, instantané et boot à froid.
  geste("parcours-retour-application", () =>
    allerA(etapeApres(etat.ecran, "retour", etat.pointeur)),
  );
  // « Je n'ai plus cette feuille » : aucun geste n'est envoyé au Worker ici. L'écran revient à
  // l'annonce, où la personne prépare son papier, et c'est le bouton d'avant qui crée le code.
  geste("parcours-nouveau-code", () => {
    etat.nouveauCodeDemande = true;
  });
  geste("parcours-garder-ma-feuille", () => {
    etat.nouveauCodeDemande = false;
  });
  // La recopie n'est plus JUGÉE ici (#239) : la feuille s'éprouve en ouvrant le coffre, verrouillé,
  // par son code. Le code reste dans le document jusqu'au verrouillage, qui recharge la page.
  geste("parcours-code-recopie", () => {
    etat.sousEtatDuCode = SOUS_ETATS_DU_CODE.recopie;
  });
  geste("parcours-revoir-code", () => {
    etat.sousEtatDuCode = SOUS_ETATS_DU_CODE.feuille;
  });

  noeud("saisie-code")?.addEventListener("input", () => {
    dire("parcours-code-lu", annonceDeLaSaisie(etatDeLaSaisie(noeud("saisie-code").value)));
  });

  for (const [champ, boutons] of Object.entries(ENTREE_VAUT)) {
    noeud(champ)?.addEventListener("keydown", (evenement) => {
      if (evenement.key !== "Enter" || evenement.isComposing) return;
      const cible = boutons
        .map(noeud)
        .find(
          (bouton) => bouton !== null && !bouton.disabled && bouton.closest("[hidden]") === null,
        );
      if (cible === undefined) return;
      evenement.preventDefault();
      cible.click();
    });
  }

  // Tout clic sur un bouton efface le message précédent, et retient l'écran d'où part le geste.
  doc.querySelector("main")?.addEventListener(
    "click",
    (event) => {
      if (!(event.target instanceof Element) || event.target.closest("button") === null) return;
      etat.ecranDuGeste = etat.ecran;
      dire("parcours-refus", "");
      dire("parcours-reussite", "");
    },
    { capture: true },
  );

  // --- Les observateurs : chaque relevé publié peut changer l'écran (`observateurs-du-parcours.mjs`) -

  brancherLesObservateurs({ noeud, etat, dire, lireJson, pas, allerA, rendre });

  rendre({ deplacerLeFocus: false });
  void chargerLaProgression().then((progression) => {
    etat.progression = progression;
    etat.progressionLue = true;
    const demandee = etapeDeLURL(parametres.get("etape"));
    etat.pointeur = etapeAdmise(demandee, progression);
    // Une étape demandée au-delà de la progression est RAMENÉE, et l'URL le dit.
    if (demandee !== null && demandee !== etat.pointeur) reecrireLURL(etat.pointeur);
    rendre({ deplacerLeFocus: false });
  });
  return Object.freeze({ rendre });
}
