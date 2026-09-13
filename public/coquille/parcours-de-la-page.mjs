// Le PARCOURS GUIDÉ, côté page (#193, ADR 0040).
//
// Ce module de branchement ne décide rien : l'écran à montrer, où mène un geste et ce qu'une personne
// lit d'un refus sont dans `src/coquille/parcours.mjs` et `src/coquille/conduites-du-parcours.mjs`.
// Il n'appelle AUCUN geste du Worker de confiance : les boutons sont ceux de l'interface, du cycle et
// de la portabilité, branchés par leurs modules. Il LIT ce que ces modules publient — les relevés et
// les lignes d'état, dont c'est l'objet — et il montre, cache, nomme et annonce.
//
// Il n'importe aucun des quatre autres modules de branchement, et ne leur parle pas : le relevé
// public suffit.

import { annonceDAttente, moteurProbable } from "/src/coquille/attente-annoncee.mjs";
import { conduiteHumaine } from "/src/coquille/conduites-du-parcours.mjs";
import {
  COFFRE,
  ECRANS,
  SOUS_ETATS_DU_CODE,
  attenteDeLaPhrase,
  codeEnFinDeTexte,
  coffreObserve,
  confirmerLaRecopie,
  ecranCourant,
  etapeApres,
  etapeDeLURL,
  etapeSuivante,
  lireLigneDEtat,
  ouSuisJe,
  progressionDuDemarrage,
} from "/src/coquille/parcours.mjs";
import { CODES_REFUS_COQUILLE } from "/src/coquille/refus-de-coquille.mjs";
import { etatDeLaSaisie } from "/src/coquille/saisie-du-code.mjs";

/** Les sections qui regroupent des blocs : cachées quand aucun de leurs blocs n'est montré. */
const SECTIONS = ["deverrouillage", "feuille", "cycle", "portabilite"];

/** Cadence de la progression annoncée pendant un démarrage : assez rare pour un lecteur d'écran. */
const ANNONCE_DE_PROGRESSION_MS = 10_000;

/** Ce que « Où suis-je ? » dit de chaque étape. */
const STATUTS = Object.freeze({
  passee: "étape précédente",
  "en-cours": "vous êtes ici",
  "a-venir": "à venir",
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

  const etat = {
    pointeur: etapeDeLURL(parametres.get("etape")),
    sousEtatDuCode: SOUS_ETATS_DU_CODE.annonce,
    revocationFaite: false,
    coffre: COFFRE.inconnu,
    ecran: null,
    /** L'écran montré au moment du dernier geste : c'est de lui qu'un geste réussi fait avancer. */
    ecranDuGeste: null,
    demarrage: null,
    refusDeRelaisVus: {},
  };

  const attenteDeLaPhraseAnnoncee = attenteDeLaPhrase(
    annonceDAttente({ moyen: "phrase", moteur: moteurProbable(navigateur.userAgent) }).attenteMs,
  );
  const passkeyConnue = typeof globalThis.PublicKeyCredential !== "undefined";

  function dire(id, texte) {
    const cible = noeud(id);
    if (cible !== null && cible.textContent !== texte) cible.textContent = texte;
  }

  function lireJson(id) {
    try {
      return JSON.parse(noeud(id)?.textContent ?? "{}");
    } catch {
      return {};
    }
  }

  function allerA(etape) {
    if (etape === null || etape === etat.pointeur) return;
    etat.pointeur = etape;
    const url = new URL(loc.href);
    url.searchParams.set("etape", String(etape));
    hist.replaceState(hist.state, "", url);
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
    dire(
      "parcours-passkey",
      creation
        ? "Ce navigateur connaît les passkeys (empreinte, visage, code de l'appareil ou clé de " +
            "sécurité). Toutes ne savent pas protéger un coffre : si la vôtre ne le sait pas, " +
            "RailsBox Vault vous le dira, et vous pourrez utiliser une phrase."
        : "Ce coffre s'ouvre aussi avec votre passkey.",
    );
    const suivante = etapeSuivante(ecranId);
    dire("parcours-continuer", suivante === null ? "Continuer" : `Continuer : ${suivante.titre}`);
  }

  function rendreOuSuisJe(ecranId) {
    const liste = noeud("ou-suis-je-liste");
    const lignes = ouSuisJe(ecranId).map(
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

  function rendre({ deplacerLeFocus = true } = {}) {
    const releve = lireJson("deverrouillage-releve");
    const rapport = lireJson("coquille-rapport");
    etat.coffre = coffreObserve({
      etat: rapport.etat,
      texteDesMoyens: noeud("deverrouillage-moyens").textContent,
      moyensProposes: releve.moyensProposes,
      dernierRefus: releve.dernierRefus,
    });
    const ecranId = ecranCourant({
      pointeur: etat.pointeur,
      coffre: etat.coffre,
      moyens: releve.moyensProposes ?? [],
      aRecuperation: (releve.moyensProposes ?? []).includes("recuperation"),
      sousEtatDuCode: etat.sousEtatDuCode,
      revocationFaite: etat.revocationFaite,
      refus: releve.dernierRefus ?? null,
    });
    if (ecranId.startsWith("code-")) allerA(3);
    if (ecranId === "refuse") dire("parcours-refus", conduiteHumaine(releve.dernierRefus));
    const change = ecranId !== etat.ecran;
    etat.ecran = ecranId;
    const ecran = ECRANS[ecranId];
    const visibles = blocsDeLEcran(ecranId, releve);
    dire("parcours-rang", ecran.etape === null ? "" : `Étape ${ecran.etape} sur 9`);
    dire("parcours-titre", ecran.titre);
    dire("parcours-ce-qui-va-se-passer", ecran.ceQuiVaSePasser);
    dire("parcours-attendu", `Ce que vous avez à faire : ${ecran.attendu}`);
    const attente = ecran.attente ?? (visibles.includes("phrase") ? attenteDeLaPhraseAnnoncee : "");
    dire("parcours-attente-annoncee", attente === "" ? "" : `Durée : ${attente}`);
    const suivante = etapeSuivante(ecranId);
    dire("parcours-suivante", suivante === null ? "" : `Étape suivante : ${suivante.titre}.`);
    nommerLesGestes(ecranId);
    montrerLesBlocs(visibles);
    rendreOuSuisJe(ecranId);
    if (change && deplacerLeFocus && !vueComplete) noeud("parcours-titre").focus();
  }

  // --- Ce qui est OBSERVÉ ---------------------------------------------------------------------------

  function refuser(code, texteSansCode = null) {
    dire("parcours-reussite", "");
    dire("parcours-refus", code === null ? (texteSansCode ?? "") : conduiteHumaine(code));
  }

  function reussir(texte) {
    dire("parcours-refus", "");
    dire("parcours-reussite", texte);
  }

  function surOuverture(avant) {
    if (avant === COFFRE.ouvert || etat.coffre !== COFFRE.ouvert) return;
    allerA(etapeApres(etat.ecranDuGeste ?? etat.ecran, "ouverture", etat.pointeur));
    dire("parcours-attente", "");
    reussir("Votre coffre est ouvert.");
  }

  function surLigneDuCycle() {
    const ligne = lireLigneDEtat(noeud("cycle-etat").textContent);
    if (ligne === null) return;
    if (ligne.evenement !== "demarrage-en-cours") arreterLaProgression();
    if (ligne.evenement === "demarrage-en-cours") return demarrerLaProgression();
    if (ligne.evenement === "application-demarree") {
      return reussir("L'application est démarrée : elle s'affiche ci-dessous.");
    }
    if (ligne.evenement === "sans-application")
      return refuser(CODES_REFUS_COQUILLE.applicationAbsente);
    if (ligne.evenement === "verrouillage-en-cours") {
      return dire("parcours-attente", "Verrouillage en cours… Ne fermez pas l'onglet.");
    }
    if (ligne.evenement === "reprise-en-cours") {
      return dire(
        "parcours-attente",
        "Reprise de l'installation en cours… Ne fermez pas l'onglet.",
      );
    }
    if (ligne.evenement.endsWith("-refuse") || ligne.evenement.endsWith("-refusee")) {
      dire("parcours-attente", "");
      return refuser(ligne.code ?? CODES_REFUS_COQUILLE.gesteRompu);
    }
  }

  function surLigneDePortabilite() {
    const ligne = lireLigneDEtat(noeud("portabilite-etat").textContent);
    if (ligne === null || ligne.evenement === "au-repos") return;
    if (ligne.evenement.endsWith("-en-cours")) {
      const quoi = ligne.evenement.startsWith("sauvegarde") ? "Sauvegarde" : "Restauration";
      return dire("parcours-attente", `${quoi} en cours… Ne fermez pas l'onglet.`);
    }
    dire("parcours-attente", "");
    if (ligne.evenement.endsWith("-refusee")) return refuser(ligne.code);
    const rapport = lireJson("coquille-rapport");
    if (ligne.evenement === "sauvegarde-prete") {
      return reussir(
        "Sauvegarde prête. Votre navigateur l'enregistre sous le nom « coffre.rbvault » ; si rien " +
          "ne s'est enregistré, cliquez sur « Enregistrer la sauvegarde ». Pensez à redémarrer " +
          "l'application si vous voulez continuer à l'utiliser.",
      );
    }
    if (ligne.evenement === "restauree") {
      allerA(etapeApres("restaurer", "restauree", etat.pointeur));
      return reussir(
        "Sauvegarde restaurée et vérifiée. Ouvrez maintenant le coffre avec votre code.",
      );
    }
    if (ligne.evenement === "revoque") {
      etat.revocationFaite = true;
      const revocation = rapport.portabilite?.revocation ?? {};
      return reussir(
        `${revocation.nombreRetires ?? 0} moyen(s) retiré(s). Nouveau numéro de version à noter sur ` +
          `votre feuille : ${revocation.versionEnveloppe ?? "?"}.`,
      );
    }
  }

  function surRefusDeDeverrouillage() {
    const texte = noeud("deverrouillage-refus").textContent.trim();
    if (texte === "") return;
    dire("parcours-attente", "");
    const code = codeEnFinDeTexte(texte);
    refuser(code, code === null ? texte : null);
  }

  function surRefusDePortabiliteSansCode() {
    const texte = noeud("portabilite-refus").textContent.trim();
    if (texte !== "" && codeEnFinDeTexte(texte) === null) refuser(null, texte);
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
    const rapport = lireJson("coquille-rapport");
    for (const [code, compte] of Object.entries(rapport.refusDeRequete ?? {})) {
      const vus = etat.refusDeRelaisVus[code] ?? 0;
      etat.refusDeRelaisVus[code] = compte;
      if (compte > vus && etat.ecran === "travailler") refuser(code);
    }
  }

  function surFeuille() {
    const code = noeud("feuille-code").textContent.trim();
    if (code === "" || etat.sousEtatDuCode !== SOUS_ETATS_DU_CODE.annonce) return;
    etat.sousEtatDuCode = SOUS_ETATS_DU_CODE.feuille;
    const version = /\d+/.exec(noeud("feuille-version").textContent)?.[0] ?? "?";
    dire(
      "parcours-consigne-feuille",
      `Numéro de version à noter à côté du code : ${version}. Recopiez les 7 groupes de 4 symboles ` +
        `exactement. Ce code ne sera plus jamais affiché.`,
    );
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
    if (!verdict.confirme) return refuser(null, verdict.message);
    saisie.value = "";
    // Le code QUITTE la page dès qu'il est confirmé : il n'a plus rien à y faire.
    noeud("feuille-code").textContent = "";
    etat.sousEtatDuCode = SOUS_ETATS_DU_CODE.annonce;
    allerA(etapeApres("code-confirmation", "code-confirme", etat.pointeur));
    reussir("Code confirmé. Gardez bien votre feuille, loin de cet appareil.");
  });

  noeud("saisie-code")?.addEventListener("input", () => {
    const lue = etatDeLaSaisie(noeud("saisie-code").value);
    dire(
      "parcours-code-lu",
      lue.symbolesLus === 0
        ? ""
        : lue.envoyable
          ? `Code complet (${lue.decoupe}).`
          : lue.code !== null
            ? conduiteHumaine(lue.code)
            : `${lue.symbolesLus} symbole(s) sur 28 : ${lue.decoupe}`,
    );
  });

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
      dire("parcours-attente", "Ouverture en cours… Ne fermez pas l'onglet.");
    }
  });
  observer("feuille-code", surFeuille);
  observer("cycle-etat", surLigneDuCycle);
  observer("portabilite-etat", surLigneDePortabilite);
  observer("portabilite-refus", surRefusDePortabiliteSansCode);
  observer("coquille-etat", surEtatDeLaCoquille);
  observer("coquille-rapport", surRapport);

  rendre({ deplacerLeFocus: false });
  return Object.freeze({ rendre });
}
