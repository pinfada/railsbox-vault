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
// public suffit.

import { annonceDAttente, moteurProbable } from "/src/coquille/attente-annoncee.mjs";
import {
  conduiteDUnRefusSansCode,
  conduiteDUnRefusSansCodeConnu,
  conduiteHumaine,
} from "/src/coquille/conduites-du-parcours.mjs";
import {
  COFFRE,
  ECRANS,
  FICHIER_DE_PROGRESSION,
  GESTES_LONGS,
  LIMITE_DE_FIREFOX,
  MESSAGES,
  PROGRESSION_INITIALE,
  SOUS_ETATS_DU_CODE,
  STATUTS,
  annonceDeLaSaisie,
  attenteDeLaPhrase,
  codeEnFinDeTexte,
  coffreObserve,
  confirmerLaRecopie,
  ecranCourant,
  ecrireProgression,
  etapeAdmise,
  etapeApres,
  etapeDeLURL,
  etapeSuivante,
  lireLigneDEtat,
  lireProgression,
  ouSuisJe,
  ouvertureParLeCode,
  progressionApres,
  progressionDuDemarrage,
  refusDeRelaisAAnnoncer,
  texteSansCode,
  unGesteEstEnCours,
} from "/src/coquille/parcours.mjs";
import { CODES_REFUS_COQUILLE } from "/src/coquille/refus-de-coquille.mjs";
import { etatDeLaSaisie } from "/src/coquille/saisie-du-code.mjs";

/** Les sections qui regroupent des blocs : cachées quand aucun de leurs blocs n'est montré. */
const SECTIONS = ["deverrouillage", "feuille", "cycle", "portabilite"];

/** Cadence de la progression annoncée pendant un démarrage : assez rare pour un lecteur d'écran. */
const ANNONCE_DE_PROGRESSION_MS = 10_000;

/** Entrée dans un champ vaut le clic sur le bouton qu'il sert (revue de la PR #213, constat 12). */
const ENTREE_VAUT = Object.freeze({
  "saisie-phrase": ["ouvrir-par-phrase"],
  "saisie-code": ["ouvrir-par-code"],
  "ancre-version": ["ouvrir-par-code", "ouvrir-par-phrase"],
  "parcours-confirmation-code": ["parcours-confirmer-code"],
});

/**
 * @param {{ document: Document, location: Location, history: History, navigateur: Navigator }} hote
 */
export function creerParcoursDeLaPage({ document: doc, location: loc, history: hist, navigateur }) {
  const noeud = (id) => doc.getElementById(id);
  const parametres = new URL(loc.href).searchParams;
  const vueComplete = parametres.get("vue") === "complete";
  doc.documentElement.dataset.vue = vueComplete ? "complete" : "parcours";
  if (vueComplete) noeud("details-techniques").open = true;

  const moteur = moteurProbable(navigateur.userAgent);
  const etat = {
    progression: PROGRESSION_INITIALE,
    progressionLue: false,
    pointeur: null,
    sousEtatDuCode: SOUS_ETATS_DU_CODE.annonce,
    revocationFaite: false,
    coffre: COFFRE.inconnu,
    ecran: null,
    /** L'écran montré au moment du dernier geste : c'est de lui qu'un geste réussi fait avancer. */
    ecranDuGeste: null,
    demarrage: null,
    /** Les refus du relais comptés quand l'application a démarré ; `null` tant qu'elle ne l'est pas. */
    referenceDesRefus: null,
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
    dire("parcours-continuer", MESSAGES.continuer(etapeSuivante(ecranId)?.titre ?? null));
  }

  function rendreOuSuisJe(ecranId) {
    const liste = noeud("ou-suis-je-liste");
    const lignes = ouSuisJe(ecranId, etat.progression.origine).map(
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
      progression: etat.progression,
      sousEtatDuCode: etat.sousEtatDuCode,
      revocationFaite: etat.revocationFaite,
      refus: releve.dernierRefus ?? null,
      moteur,
    });
  }

  function rendre({ deplacerLeFocus = true } = {}) {
    const releve = lireJson("deverrouillage-releve");
    const ecranId = ecranAMontrer(releve, lireJson("coquille-rapport"));
    const ecran = ECRANS[ecranId];
    if (ecran.etape === 3) allerA(3);
    if (ecran.etape === 4 && etat.pointeur === 3) allerA(4);
    if (ecranId === "refuse") dire("parcours-refus", conduiteHumaine(releve.dernierRefus));
    const precedent = etat.ecran;
    etat.ecran = ecranId;
    const visibles = blocsDeLEcran(ecranId, releve);
    dire("parcours-rang", ecran.etape === null ? "" : MESSAGES.rang(ecran.etape));
    dire("parcours-titre", ecran.titre);
    dire("parcours-ce-qui-va-se-passer", ecran.ceQuiVaSePasser);
    dire("parcours-attendu", MESSAGES.attendu(ecran.attendu));
    const limite = moteur === "firefox" && (ecranId === "creer" || ecranId === "choisir");
    dire("parcours-limite", limite ? LIMITE_DE_FIREFOX : "");
    const attente = ecran.attente ?? (visibles.includes("phrase") ? attenteDeLaPhraseAnnoncee : "");
    dire("parcours-attente-annoncee", attente === "" ? "" : MESSAGES.duree(attente));
    const suivante = etapeSuivante(ecranId);
    dire("parcours-suivante", suivante === null ? "" : MESSAGES.suivante(suivante.titre));
    // Le code tapé ne survit pas à son champ : un champ vidé par un geste vide aussi son annonce.
    if ((noeud("saisie-code")?.value ?? "") === "") dire("parcours-code-lu", "");
    nommerLesGestes(ecranId);
    montrerLesBlocs(visibles);
    rendreOuSuisJe(ecranId);
    fermerLesGestesEnCours();
    // Le focus suit un CHANGEMENT d'écran, jamais le premier affichage (ADR 0040, § 5).
    const premierAffichage = precedent === null || precedent === "chargement";
    if (precedent !== ecranId && !premierAffichage && deplacerLeFocus && !vueComplete) {
      noeud("parcours-titre").focus();
    }
  }

  // --- Ce qui est OBSERVÉ ---------------------------------------------------------------------------

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
    // Ouvert par le code de la feuille : la feuille est juste, c'est la meilleure des confirmations.
    if (ouvertureParLeCode(depuis)) pas("code-confirme");
    allerA(etapeApres(depuis, "ouverture", etat.pointeur));
    dire("parcours-attente", "");
    reussir(MESSAGES.coffreOuvert);
  }

  function surLigneDuCycle() {
    const ligne = lireLigneDEtat(noeud("cycle-etat").textContent);
    if (ligne === null) return;
    if (ligne.evenement !== "demarrage-en-cours") arreterLaProgression();
    if (ligne.evenement !== "application-demarree") etat.referenceDesRefus = null;
    if (ligne.evenement === "demarrage-en-cours") return demarrerLaProgression();
    if (ligne.evenement === "application-demarree") {
      etat.referenceDesRefus = { ...(lireJson("coquille-rapport").refusDeRequete ?? {}) };
      return reussir(MESSAGES.applicationDemarree);
    }
    if (ligne.evenement === "sans-application")
      return refuser(CODES_REFUS_COQUILLE.applicationAbsente);
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
      return dire("parcours-attente", MESSAGES.sauvegardeEnCours);
    }
    if (ligne.evenement.endsWith("-en-cours")) {
      return dire("parcours-attente", MESSAGES.restaurationEnCours);
    }
    dire("parcours-attente", "");
    if (ligne.evenement.endsWith("-refusee")) return refuser(ligne.code);
    if (ligne.evenement === "sauvegarde-prete") return reussir(MESSAGES.sauvegardePrete);
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
    if (etat.ecran !== "travailler") return;
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
    const version = /\d+/.exec(noeud("feuille-version").textContent)?.[0] ?? null;
    pas("code-rendu", version === null ? null : Number(version));
    dire("parcours-consigne-feuille", MESSAGES.consigneDeLaFeuille(version ?? "?"));
  }

  // --- La PROGRESSION d'un démarrage : du temps écoulé et des signes de vie réels ---------------------

  function demarrerLaProgression() {
    if (etat.demarrage !== null) return;
    const recus = () => lireJson("coquille-rapport").mesures?.battements?.recus ?? 0;
    const depart = { instant: performance.now(), battements: recus() };
    const annoncer = () =>
      dire(
        "parcours-attente",
        progressionDuDemarrage({
          ecouleMs: performance.now() - depart.instant,
          signesDeVie: recus() - depart.battements,
        }),
      );
    noeud("parcours-progression").hidden = false;
    annoncer();
    etat.demarrage = setInterval(annoncer, ANNONCE_DE_PROGRESSION_MS);
  }

  function arreterLaProgression() {
    if (etat.demarrage === null) return;
    clearInterval(etat.demarrage);
    etat.demarrage = null;
    noeud("parcours-progression").hidden = true;
    dire("parcours-attente", "");
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
  geste("parcours-phrase-perdue", () => allerA(etapeApres("rouvrir", "perdu", etat.pointeur)));
  geste("parcours-continuer", () => allerA(etapeApres(etat.ecran, "continuer", etat.pointeur)));
  geste("parcours-code-recopie", () => {
    etat.sousEtatDuCode = SOUS_ETATS_DU_CODE.confirmation;
  });
  geste("parcours-revoir-code", () => {
    etat.sousEtatDuCode = SOUS_ETATS_DU_CODE.feuille;
  });
  geste("parcours-confirmer-code", () => {
    const saisie = noeud("parcours-confirmation-code");
    const verdict = confirmerLaRecopie(saisie.value, noeud("feuille-code").textContent);
    if (!verdict.confirme) return refuserSansCode(verdict.message);
    saisie.value = "";
    // Le code QUITTE la page dès qu'il est confirmé : il n'a plus rien à y faire.
    dire("feuille-code", "");
    etat.sousEtatDuCode = SOUS_ETATS_DU_CODE.annonce;
    pas("code-confirme");
    allerA(etapeApres("code-confirmation", "code-confirme", etat.pointeur));
    reussir(verdict.message);
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
