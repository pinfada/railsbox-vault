// Le CÂBLAGE de la révocation d'urgence (#265, ADR 0049 § C2) : il assemble, pour UN document, le magasin
// de C1 (l'état), le rendeur unique (ce que la personne lit), l'affichage (les effets visibles) et les
// gestionnaires. Il vit dans `src/coquille/` — et non dans `public/` — pour la raison qui gouverne ce
// répertoire : la campagne de mutation ne rejoue que Node, et une garde écrite dans la page ne serait
// jamais éprouvée. Le DOM n'y entre que par des nœuds INJECTÉS.
//
// Ce que ce module garantit, et pourquoi :
//  - C2-1′  la page ne lit une donnée du coffre que par `lirePublic` / `lireLeConstat` ; le miroir
//           (`rapport.feuilleEprouvee`, `tailleDeSauvegarde`, les relevés de l'interface) n'est écrit que
//           par l'effet `publier`, c'est-à-dire APRÈS l'acceptation d'une lecture COURANTE ;
//  - C2-2   chaque geste de la vue appelle `appliquer` en PREMIÈRE instruction synchrone, et ne lit ni
//           `disabled` ni `aria-disabled` pour décider : la table refuse ou accepte, et la personne lit
//           pourquoi ;
//  - C2-3   toute modification d'enveloppe passe par `modifier` (pré-vol, relecture, oubli de la
//           confirmation) ;
//  - C2-4   `envoyer` est le seul appel de `revoquerEnUrgence` ; l'indice n'est écrit qu'à `noter`.

import { construireLaVue } from "./construction-de-la-vue.mjs";
import { creerLAffichage } from "./affichage-de-la-revocation.mjs";
import { tailleDeSauvegardeDuMessage } from "./contrat-de-messages.mjs";
import { creerLaRevocation } from "./magasin-de-la-revocation.mjs";
import { projeter } from "./projection-de-la-revocation.mjs";
import { creerLeRendeur } from "./rendeur-de-la-vue.mjs";
import { texteDe } from "./textes-de-la-revocation.mjs";
import { lireLeConstat, lirePublic } from "./vue-de-la-revocation.mjs";

/** Les exécuteurs de C1 : des fonctions SANS récepteur, qui ne lisent jamais l'état de la page. */
function creerLesExecuteurs(ctx) {
  const { liaison, lectures, derniere } = ctx;
  return {
    envoyer: () =>
      liaison.demander("revoquerEnUrgence", {}).then((rendu) => {
        derniere.reponse = rendu;
        return rendu;
      }),
    relire: (lecture) =>
      liaison.demander("inventaire", {}).then((reponse) => {
        lectures.set(lecture, {
          taille: tailleDeSauvegardeDuMessage(reponse),
          identifiantVolume:
            typeof reponse?.identifiantVolume === "string" ? reponse.identifiantVolume : null,
        });
        return reponse;
      }),
    publier: (lecture, donnees) => publierLeMiroir(ctx, lecture, donnees),
    noter: () => {
      liaison.surRevocationAcquittee(derniere.reponse);
      return Promise.resolve(liaison.noterLIndice());
    },
    oublier: () => {},
    terminer: () => liaison.surTerminer(),
    revenir: () => liaison.surRevenir(),
    masquer: () => {
      liaison.annonce.textContent = "";
      return ctx.affichage.masquer();
    },
    consigner: ({ evenement, code }) => {
      liaison.rapport.revocation = { evenement, code };
      liaison.publierLeRapport();
    },
    vueARendre: () => {
      ctx.rendeur.reveiller();
      // Les abonnés sont prévenus APRÈS la transition : l'un d'eux peut appeler `appliquer`.
      queueMicrotask(() => ctx.abonnes.forEach((abonne) => abonne()));
    },
  };
}

/** L'effet `publier` : le SEUL écrivain des miroirs, appelé après l'acceptation d'une lecture courante. */
function publierLeMiroir(ctx, lecture, donnees) {
  const { liaison, lectures } = ctx;
  const brute = lectures.get(lecture);
  lectures.delete(lecture);
  liaison.rapport.feuilleEprouvee = donnees.constat?.feuilleEprouvee === true;
  liaison.rapport.tailleDeSauvegarde = brute?.taille ?? null;
  ctx.identifiantVolume = brute?.identifiantVolume ?? ctx.identifiantVolume;
  liaison.refleter(donnees, ctx.identifiantVolume);
  liaison.publierLeRapport();
}

/** Dit ce que la table a répondu : l'annonce de l'événement, jamais une phrase écrite ici. */
function dire(ctx, resultat) {
  if (resultat.annonce === null || resultat.annonce === undefined) return resultat;
  ctx.liaison.annonce.textContent = texteDe(resultat.annonce).corps;
  return resultat;
}

/** Un geste de la vue : `appliquer` d'abord, sans rien lire du DOM de décision (C2-2). */
function brancherLesGestes(ctx) {
  const { conteneur } = ctx.liaison;
  conteneur.addEventListener("click", (evenement) => {
    const cible = evenement.target?.closest?.("[data-geste]");
    if (cible === null || cible === undefined || !conteneur.contains(cible)) return;
    dire(ctx, ctx.revocation.appliquer({ type: cible.getAttribute("data-geste") }));
  });
}

/** Une promesse réglée quand l'état vérifie `predicat` : tout de suite, ou au premier changement qui le vérifie. */
function attendre(ctx, predicat) {
  return new Promise((rendre) => {
    const verifier = () => {
      if (!predicat(ctx.revocation.etat())) return;
      ctx.abonnes.delete(verifier);
      rendre();
    };
    ctx.abonnes.add(verifier);
    verifier();
  });
}

function creerLeRendeurDeLaPage(ctx) {
  const { liaison, affichage } = ctx;
  return creerLeRendeur({
    occurrence: () => ctx.revocation.occurrence(),
    nouveauFragment: affichage.nouveauFragment,
    rendre: (occurrence, fragment) => {
      const projection = projeter(ctx.revocation.etat());
      fragment.append(construireLaVue(liaison.doc, projection));
      return { empreinte: projection.empreinte };
    },
    effets: affichage.effets,
    armer: liaison.armer ?? ((ms, fonction) => setTimeout(fonction, ms)),
    desarmer: liaison.desarmer ?? ((poignee) => clearTimeout(poignee)),
    consigner: (code, detail) => {
      liaison.rapport.rendeur = { dernier: code, detail: String(detail ?? "").slice(0, 120) };
    },
  });
}

/**
 * @param {object} liaison
 * @param {Document} liaison.doc sert à CRÉER des nœuds
 * @param {Element} liaison.conteneur le conteneur d'affichage (masqué par défaut, par le CSS)
 * @param {Element} liaison.regionDErreur la région d'erreur sûre, hors du conteneur
 * @param {Element} liaison.annonce la ligne qui dit le résultat d'un geste, hors du conteneur
 * @param {Element} liaison.repereDeFocus le repère stable où le focus revient
 * @param {(type: string, corps?: object) => Promise<any>} liaison.demander le canal privilégié
 * @param {object} liaison.rapport le relevé public de la coquille (miroirs écrits par `publier`)
 * @param {() => void} liaison.publierLeRapport
 * @param {boolean} liaison.indice l'indice persisté (D4 : il ne dit jamais « révoqué »)
 * @param {() => Promise<void> | void} liaison.noterLIndice écrit `progression.revocationFaite`
 * @param {(donnees: object, identifiantVolume: string | null) => void} liaison.refleter miroirs de l'interface
 * @param {(rendu: object) => void} liaison.surRevocationAcquittee diagnostic et lien de sauvegarde
 * @param {() => void} liaison.surTerminer
 * @param {() => void} liaison.surRevenir
 * @param {() => void} [liaison.apresPublication] la page remet les blocs d'écran en place
 */
export function creerLeCablage(liaison) {
  const ctx = {
    liaison,
    /** Ce que le canal a rendu pour chaque lecture, tenu jusqu'à son acceptation ou son oubli. */
    lectures: new Map(),
    /** L'identifiant du volume : une constante du coffre, relevée avec l'inventaire accepté. */
    identifiantVolume: null,
    /** La dernière réponse de révocation ; lue par `noter`, appelé à l'acquit de CETTE demande. */
    derniere: { reponse: null },
    revocation: null,
    abonnes: new Set(),
    affichage: creerLAffichage({
      doc: liaison.doc,
      conteneur: liaison.conteneur,
      regionDErreur: liaison.regionDErreur,
      repereDeFocus: liaison.repereDeFocus,
      surPublication: liaison.apresPublication ?? (() => {}),
    }),
    rendeur: null,
  };
  ctx.rendeur = creerLeRendeurDeLaPage(ctx);
  ctx.revocation = creerLaRevocation({
    executeurs: creerLesExecuteurs(ctx),
    indice: liaison.indice,
  });
  brancherLesGestes(ctx);
  const { revocation } = ctx;
  return Object.freeze({
    revocation,
    demarrer: () => dire(ctx, revocation.demarrer()),
    appliquer: (evenement) => dire(ctx, revocation.appliquer(evenement)),
    /** L'ouverture est DITE au magasin, qui relit l'inventaire : une ouverture peut migrer la page. */
    coffreOuvert: (moyen) => dire(ctx, revocation.appliquer({ type: "coffre-ouvert", moyen })),
    modifier: (lanceur) => dire(ctx, revocation.modifier(lanceur)),
    definirLIndice: (valeur) => revocation.definirLIndice(valeur),
    abonner: (abonne) => ctx.abonnes.add(abonne),
    attendre: (predicat) => attendre(ctx, predicat),
    etat: () => revocation.etat(),
    projection: () => revocation.projection(),
    lirePublic: () => lirePublic(revocation.etat()),
    lireLeConstat: () => lireLeConstat(revocation.etat()),
    identifiantDuVolume: () => ctx.identifiantVolume,
    terminer: () => revocation.terminer(),
    echecs: () => revocation.echecs(),
    rendeur: ctx.rendeur,
    affichage: ctx.affichage,
  });
}
