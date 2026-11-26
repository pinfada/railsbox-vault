// Le PORTAIL de la réserve (#299, ADR 0048 § 7) : TOUT OU RIEN, avant tout Worker de confiance et avant
// toute clé. Il s'exécute avant CHAQUE création du Worker — pas une fois par chargement de page : un coffre
// verrouillé puis rouvert dans la même fenêtre repasse par lui, et une révocation connue entre-temps le refuse.
//
// Ordre :
//  1. L'API existe ? `"serviceWorker" in navigator`. Absente : RESERVE_ABSENTE (`api-absente`), SANS lire
//     `.controller`, sans Worker, sans clé.
//  2. Un contrôleur ? Sinon (`reserve-installation.mjs`) : retrait, inscription sans contrôle, première visite.
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
import { sansControleur } from "./reserve-installation.mjs";
import { creerLObservateur } from "./reserve-observateur.mjs";
import { DELAIS_PAR_DEFAUT, interroger } from "./reserve-questions.mjs";

const refuser = (code, cause, extra = {}) => ({ autorise: false, code, cause, ...extra });

/** Observe (identité, vérification, fraîcheur en parallèle, bornées), décide, et répare UNE fois si besoin. */
async function observerEtDecider(ctx, conteneur, controleur) {
  const { d, etatPartage, sequencePage } = ctx;
  const inscription = await conteneur.getRegistration("/").catch(() => undefined);
  if (ctx.observateur === null && inscription) {
    ctx.observateur = creerLObservateur({
      registration: inscription,
      etatPartage,
      surEtat: ctx.surEtat,
      sequenceCourante: sequencePage,
      delaiReponseMs: d.delaiReponseMs,
      delaiDeGraceMs: d.delaiDeGraceMs,
    });
  }
  const [identite, verification, fraiche] = await Promise.all([
    interroger(controleur, "version", d.delaiReponseMs),
    interroger(controleur, "verifier", d.delaiReponseMs),
    ctx.observateur === null
      ? Promise.resolve({ maj: "non-tentee", attente: null, etat: E.NON_VERIFIABLE })
      : ctx.observateur.verifier(d.delaiVerificationMs),
  ]);
  const cause = causeDeLaRevocation(fraiche.attente, sequencePage) ?? etatPartage.cause();
  const decideSur = (verifie) =>
    decider({
      sequencePage,
      identite,
      verification: verifie,
      fraicheur: fraiche.etat,
      causeDeRevocation: cause,
      controleurChange: etatPartage.controleurChange(),
    });
  let decision = decideSur(verification);
  const abimee = decision.code === C.reserveIncomplete || decision.code === C.reserveAlteree;
  if (!decision.autorise && abimee) {
    const reparation = await interroger(controleur, "reparer", d.delaiReparationMs);
    if (reparation?.ok === true) {
      decision = decideSur(await interroger(controleur, "verifier", d.delaiReponseMs));
    }
  }
  return { decision, fraiche };
}

/** 7 — Un Worker qui ne se charge pas ne dit pas pourquoi : le code typé vient d'une NOUVELLE vérification. */
async function refuserApresEchecDuChargement(ctx, conteneur, controleur, erreur, fraicheur) {
  const apres = await interroger(
    conteneur.controller ?? controleur,
    "verifier",
    ctx.d.delaiReponseMs,
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

/** 6 — Poignée de main : rien ne se passe avant que le Worker ait dit QUELLE séquence il exécute. */
async function apresLaCreation(ctx, conteneur, controleur, travailleur, fraicheur, branchement) {
  const { etatPartage, sequencePage } = ctx;
  const annonce = await branchement.annonceDuTravailleur(travailleur, ctx.d.delaiAnnonceMs);
  if (annonce === null || annonce === undefined || annonce.erreur !== undefined) {
    branchement.terminerLeTravailleur(travailleur);
    const erreur = annonce?.erreur ?? "delai";
    return refuserApresEchecDuChargement(ctx, conteneur, controleur, erreur, fraicheur);
  }
  if (annonce.sequence !== sequencePage) {
    branchement.terminerLeTravailleur(travailleur);
    return refuser(C.reserveDivergente, "worker-d-une-autre-version", { fraicheur });
  }
  if (conteneur.controller !== controleur || etatPartage.controleurChange()) {
    branchement.terminerLeTravailleur(travailleur);
    return refuser(C.reserveDivergente, "controleur-change-apres-creation", { fraicheur });
  }
  return { autorise: true, code: null, cause: null, fraicheur, travailleur, annonce };
}

async function ouvrirLePortail(ctx, branchement) {
  const { etatPartage, navigateur } = ctx;
  // 1 — L'API existe-t-elle ? Sans elle, on ne lit RIEN d'elle.
  if (!("serviceWorker" in navigateur)) return refuser(C.reserveAbsente, "api-absente");
  const conteneur = navigateur.serviceWorker;
  // 2 — Un contrôleur ?
  const controleur = conteneur.controller;
  if (!controleur) return sansControleur({ conteneur, etatPartage, delais: ctx.d });
  // 3 et 4 — Observer, décider, réparer.
  const { decision, fraiche } = await observerEtDecider(ctx, conteneur, controleur);
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
  const travailleur = branchement.creerLeTravailleur();
  return apresLaCreation(ctx, conteneur, controleur, travailleur, fraiche.etat, branchement);
}

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
  const ctx = {
    navigateur,
    sequencePage,
    surEtat,
    etatPartage,
    d: { ...DELAIS_PAR_DEFAUT, ...delais },
    observateur: null,
  };
  if ("serviceWorker" in navigateur) {
    // Un changement de contrôleur pendant la vie de la page est une anomalie qui ne se défait pas.
    navigateur.serviceWorker.addEventListener("controllerchange", () =>
      etatPartage.noterLeChangementDeControleur(),
    );
  }
  return {
    /** @param {{ creerLeTravailleur: () => any, annonceDuTravailleur: Function, terminerLeTravailleur: Function }} branchement */
    ouvrirLePortail: (branchement) => ouvrirLePortail(ctx, branchement),
    /** L'état de révocation PARTAGÉ : lecture seule. */
    revocation: {
      connue: () => etatPartage.connue(),
      cause: () => etatPartage.cause(),
      controleurChange: () => etatPartage.controleurChange(),
    },
    /** L'état de fraîcheur tel que l'observateur le tient (ou `null` avant le premier portail). */
    fraicheur: () => ctx.observateur?.etat() ?? null,
  };
}
