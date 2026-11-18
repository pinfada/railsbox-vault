// Le PORTAIL de la réserve (#299, ADR 0048 § 7) : TOUT OU RIEN, avant tout Worker de confiance et avant
// toute clé. Il s'exécute avant CHAQUE création du Worker — pas une fois par chargement de page : un coffre
// verrouillé puis rouvert dans la même fenêtre repasse par lui, et une révocation connue entre-temps le refuse.
//
// Ordre :
//  1. L'API existe ? `"serviceWorker" in navigator`. Absente : RESERVE_ABSENTE (`api-absente`), SANS lire
//     `.controller`, sans Worker, sans clé.
//  2. Un contrôleur ? Sinon l'inscription ACTIVE : un script de retrait → PERIMEE ; sinon ABSENTE. Jamais
//     d'inscription : première visite, ce n'est pas un refus — le SW est inscrit, la page se recharge.
//  3. En parallèle, chacun borné : identité (`version`), vérification complète (`verifier`), fraîcheur.
//  4. Décision pure (`reserve-decision.mjs`). Entrées manquantes ou altérées : EN LIGNE, `reparer` les
//     refait (chaque entrée vérifiée avant d'être écrite), UNE fois, puis on réessaie.
//  5. DERNIÈRE GARDE, synchrone : dans le même tour que `new Worker`, relire l'état de révocation PARTAGÉ et
//     le contrôleur (identité d'objet, drapeau `controllerchange`), SANS AUCUN `await` entre cette lecture
//     et la création. JavaScript n'exécute aucun gestionnaire d'événement entre deux instructions
//     synchrones : ce qui a été observé avant cette lecture est vu. L'absence d'`await` EST la garde.
//  6. Poignée de main : le Worker annonce la séquence qu'il exécute ; la page la compare avant tout secret.
//  7. Un Worker qui ne se charge pas : re-vérification pour nommer ALTEREE ou INCOMPLETE — JAMAIS depuis
//     l'événement `error`, que Firefox n'émet pas quand le graphe de modules d'un Worker est refusé.
//
// Ce que cette garde ne ferme pas : la fraîcheur est non signée, donc bornée aux révocations CONNUES (§ 9).

import { CODES_REFUS_COQUILLE as C } from "./refus-de-coquille.mjs";
import { decider } from "./reserve-decision.mjs";
import { creerEtatPartage } from "./reserve-etat-partage.mjs";
import { ETATS_DE_FRAICHEUR as E, causeDeLaRevocation } from "./reserve-fraicheur.mjs";
import { URL_DU_SW } from "./reserve-identite.mjs";
import { creerLObservateur } from "./reserve-observateur.mjs";
import { DELAIS_PAR_DEFAUT, apresUnDelai, interroger } from "./reserve-questions.mjs";

const refuser = (code, cause, extra = {}) => ({ autorise: false, code, cause, ...extra });

/**
 * La RÉSERVE de la page : un état de révocation, un observateur et des portails, partagés par toute la vie de
 * la page.
 *
 * @param {object} o
 * @param {any} o.navigateur `navigator`
 * @param {number} o.sequencePage la séquence de publication que la page porte (`reserve-publiee.mjs`)
 * @param {Partial<typeof DELAIS_PAR_DEFAUT>} [o.delais]
 * @param {(etat: import("./reserve-fraicheur.mjs").EtatDeFraicheur) => void} [o.surEtat] le bandeau
 * @param {ReturnType<typeof creerEtatPartage>} [o.etatPartage] pour les épreuves ; la page n'en crée qu'UN
 */
export function creerLaReserveDeLaPage({
  navigateur,
  sequencePage,
  delais = {},
  surEtat = () => {},
  etatPartage = creerEtatPartage(),
}) {
  const d = { ...DELAIS_PAR_DEFAUT, ...delais };
  let observateur = null;
  if ("serviceWorker" in navigateur) {
    // Un changement de contrôleur pendant la vie de la page est une anomalie qui ne se défait pas.
    navigateur.serviceWorker.addEventListener("controllerchange", () =>
      etatPartage.noterLeChangementDeControleur(),
    );
  }

  const observateurDe = (inscription) => {
    if (observateur === null && inscription) {
      observateur = creerLObservateur({
        registration: inscription,
        etatPartage,
        surEtat,
        sequenceCourante: sequencePage,
        delaiReponseMs: d.delaiReponseMs,
      });
    }
    return observateur;
  };

  /** Sans contrôleur : retrait lu sur l'inscription active, sinon première visite ou refus. */
  async function sansControleur(conteneur) {
    const inscription = await conteneur.getRegistration("/").catch(() => undefined);
    if (inscription?.active) {
      const identite = await interroger(inscription.active, "version", d.delaiReponseMs);
      if (identite?.retrait === true) {
        etatPartage.noter("retrait");
        return refuser(C.reservePerimee, "retrait", { fraicheur: E.REVOCATION_CONNUE });
      }
      return refuser(C.reserveAbsente, "inscription-sans-controle", {
        fraicheur: E.NON_VERIFIABLE,
      });
    }
    return premiereInstallation(conteneur, inscription);
  }

  /** « Préparation hors connexion, une seule fois » : inscrire, attendre l'activation (bornée), recharger. */
  async function premiereInstallation(conteneur, existante) {
    const impossible = refuser(C.reserveAbsente, "installation-impossible", {
      fraicheur: E.NON_VERIFIABLE,
    });
    let inscription;
    try {
      inscription =
        existante ?? (await conteneur.register(URL_DU_SW, { scope: "/", updateViaCache: "none" }));
    } catch {
      return impossible;
    }
    const worker = inscription?.installing ?? inscription?.waiting ?? inscription?.active;
    if (!worker) return impossible;
    const issue = await Promise.race([
      new Promise((resoudre) => {
        const verifier = () => {
          if (worker.state === "activated") resoudre("activee");
          else if (worker.state === "redundant") resoudre("redondante");
        };
        worker.addEventListener("statechange", verifier);
        verifier();
      }),
      apresUnDelai(d.delaiInstallationInitialeMs, "delai"),
    ]);
    return issue === "activee"
      ? { autorise: false, recharger: true, cause: "premiere-installation" }
      : impossible;
  }

  /** `verifier` puis, si la réserve est abîmée et que le réseau répond, UNE réparation et un réessai. */
  async function decider1(controleur, observation) {
    const [identite, verification] = observation.reponses;
    return decider({
      sequencePage,
      identite,
      verification,
      fraicheur: observation.fraicheur,
      causeDeRevocation: observation.cause,
      controleurChange: etatPartage.controleurChange(),
    });
  }

  async function ouvrirLePortail({
    creerLeTravailleur,
    annonceDuTravailleur,
    terminerLeTravailleur,
  }) {
    // 1 — L'API existe-t-elle ? Sans elle, on ne lit RIEN d'elle.
    if (!("serviceWorker" in navigateur)) return refuser(C.reserveAbsente, "api-absente");
    const conteneur = navigateur.serviceWorker;

    // 2 — Un contrôleur ?
    const controleur = conteneur.controller;
    if (!controleur) return sansControleur(conteneur);

    // 3 — Identité, vérification complète et fraîcheur, EN PARALLÈLE, chacune bornée.
    const inscription = await conteneur.getRegistration("/").catch(() => undefined);
    const suivi = observateurDe(inscription);
    const [identite, verification, fraiche] = await Promise.all([
      interroger(controleur, "version", d.delaiReponseMs),
      interroger(controleur, "verifier", d.delaiReponseMs),
      suivi === null
        ? Promise.resolve({ maj: "non-tentee", attente: null, etat: E.NON_VERIFIABLE })
        : suivi.verifier(d.delaiVerificationMs),
    ]);
    const cause = causeDeLaRevocation(fraiche.attente, sequencePage) ?? etatPartage.cause();
    let observation = { reponses: [identite, verification], fraicheur: fraiche.etat, cause };

    // 4 — Décision pure ; réparation vérifiée, une fois, si la réserve est abîmée.
    let decision = await decider1(controleur, observation);
    if (
      !decision.autorise &&
      (decision.code === C.reserveIncomplete || decision.code === C.reserveAlteree)
    ) {
      const reparation = await interroger(controleur, "reparer", d.delaiReparationMs);
      if (reparation?.ok === true) {
        const apres = await interroger(controleur, "verifier", d.delaiReponseMs);
        observation = { ...observation, reponses: [identite, apres] };
        decision = await decider1(controleur, observation);
      }
    }
    if (!decision.autorise) {
      if (decision.cause === "retrait") etatPartage.noter("retrait");
      return { ...decision, fraicheur: fraiche.etat };
    }

    // 5 — DERNIÈRE GARDE. Aucun `await` entre ces lectures et `creerLeTravailleur()` : ce qui a été observé
    // avant est vu, rien ne peut s'intercaler.
    if (etatPartage.connue()) {
      return refuser(C.reservePerimee, etatPartage.cause(), { fraicheur: E.REVOCATION_CONNUE });
    }
    if (conteneur.controller !== controleur || etatPartage.controleurChange()) {
      return refuser(C.reserveDivergente, "controleur-change", { fraicheur: fraiche.etat });
    }
    const travailleur = creerLeTravailleur();

    // 6 — Poignée de main : rien ne se passe avant que le Worker ait dit QUELLE séquence il exécute.
    const annonce = await annonceDuTravailleur(travailleur, d.delaiAnnonceMs);
    if (annonce?.erreur !== undefined || annonce === null || annonce === undefined) {
      terminerLeTravailleur(travailleur);
      return refuserApresEchecDuChargement(
        controleur,
        conteneur,
        annonce?.erreur ?? "delai",
        fraiche.etat,
      );
    }
    if (annonce.sequence !== sequencePage) {
      terminerLeTravailleur(travailleur);
      return refuser(C.reserveDivergente, "worker-d-une-autre-version", {
        fraicheur: fraiche.etat,
      });
    }
    if (conteneur.controller !== controleur || etatPartage.controleurChange()) {
      terminerLeTravailleur(travailleur);
      return refuser(C.reserveDivergente, "controleur-change-apres-creation", {
        fraicheur: fraiche.etat,
      });
    }
    return {
      autorise: true,
      code: null,
      cause: null,
      fraicheur: fraiche.etat,
      travailleur,
      annonce,
    };
  }

  /** 7 — Un Worker qui ne se charge pas ne dit pas pourquoi : le code typé vient d'une NOUVELLE vérification. */
  async function refuserApresEchecDuChargement(controleur, conteneur, erreur, fraicheur) {
    const apres = await interroger(
      conteneur.controller ?? controleur,
      "verifier",
      d.delaiReponseMs,
    );
    if (apres === null) return refuser(C.reserveAbsente, "silence-du-sw", { fraicheur });
    if (apres.alteres?.length > 0) {
      return refuser(C.reserveAlteree, "entree-alteree-apres-le-portail", {
        detail: apres.alteres,
        fraicheur,
      });
    }
    if (apres.manquants?.length > 0) {
      return refuser(C.reserveIncomplete, "entree-absente-apres-le-portail", {
        detail: apres.manquants,
        fraicheur,
      });
    }
    return refuser(C.reserveAbsente, `worker-${erreur}`, { fraicheur });
  }

  return {
    ouvrirLePortail,
    /** L'état de révocation PARTAGÉ : lecture seule. */
    revocation: {
      connue: () => etatPartage.connue(),
      cause: () => etatPartage.cause(),
      controleurChange: () => etatPartage.controleurChange(),
    },
    /** L'état de fraîcheur tel que l'observateur le tient (ou `null` avant le premier portail). */
    fraicheur: () => observateur?.etat() ?? null,
  };
}
