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

/** Le nom du volume que le Worker publie avec l'inventaire : un nom, pas une donnée sensible. */
const sansIdentifiant = null;

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
export function creerLeCablage({
  doc,
  conteneur,
  regionDErreur,
  annonce,
  repereDeFocus,
  demander,
  rapport,
  publierLeRapport,
  indice,
  noterLIndice,
  refleter,
  surRevocationAcquittee,
  surTerminer,
  surRevenir,
  apresPublication = () => {},
  armer = (ms, fonction) => setTimeout(fonction, ms),
  desarmer = (poignee) => clearTimeout(poignee),
}) {
  /** Ce que le canal a rendu pour chaque lecture, tenu jusqu'à son acceptation ou son oubli. */
  const lectures = new Map();
  /** L'identifiant du volume : une constante du coffre, relevée avec l'inventaire accepté. */
  let identifiantVolume = sansIdentifiant;
  /** La dernière réponse de révocation ; lue par `noter`, qui n'est appelé qu'à l'acquit de CETTE demande. */
  const derniere = { reponse: null };
  let revocation = null;

  const affichage = creerLAffichage({
    doc,
    conteneur,
    regionDErreur,
    repereDeFocus,
    surPublication: apresPublication,
  });

  const rendeur = creerLeRendeur({
    occurrence: () => revocation.occurrence(),
    nouveauFragment: affichage.nouveauFragment,
    rendre: (occurrence, fragment) => {
      const projection = projeter(revocation.etat());
      fragment.append(construireLaVue(doc, projection));
      return { empreinte: projection.empreinte };
    },
    effets: affichage.effets,
    armer,
    desarmer,
    consigner: (code, detail) => {
      rapport.rendeur = { dernier: code, detail: String(detail ?? "").slice(0, 120) };
    },
  });

  const executeurs = {
    envoyer: () =>
      demander("revoquerEnUrgence", {}).then((rendu) => {
        derniere.reponse = rendu;
        return rendu;
      }),
    relire: (lecture) =>
      demander("inventaire", {}).then((reponse) => {
        lectures.set(lecture, {
          taille: tailleDeSauvegardeDuMessage(reponse),
          identifiantVolume:
            typeof reponse?.identifiantVolume === "string" ? reponse.identifiantVolume : null,
        });
        return reponse;
      }),
    publier: (lecture, donnees) => {
      const brute = lectures.get(lecture);
      lectures.delete(lecture);
      rapport.feuilleEprouvee = donnees.constat?.feuilleEprouvee === true;
      rapport.tailleDeSauvegarde = brute?.taille ?? null;
      identifiantVolume = brute?.identifiantVolume ?? identifiantVolume;
      refleter(donnees, identifiantVolume);
      publierLeRapport();
    },
    noter: () => {
      surRevocationAcquittee(derniere.reponse);
      return Promise.resolve(noterLIndice());
    },
    oublier: () => {},
    terminer: () => surTerminer(),
    revenir: () => surRevenir(),
    masquer: () => {
      annonce.textContent = "";
      return affichage.masquer();
    },
    consigner: ({ evenement, code }) => {
      rapport.revocation = { evenement, code };
      publierLeRapport();
    },
    vueARendre: () => rendeur.reveiller(),
  };

  revocation = creerLaRevocation({ executeurs, indice });

  /** Dit ce que la table a répondu : l'annonce de l'événement, jamais une phrase écrite ici. */
  function dire(resultat) {
    if (resultat.annonce === null || resultat.annonce === undefined) return resultat;
    annonce.textContent = texteDe(resultat.annonce).corps;
    return resultat;
  }

  /** Un geste de la vue : `appliquer` d'abord, sans rien lire du DOM de décision (C2-2). */
  conteneur.addEventListener("click", (evenement) => {
    const cible = evenement.target?.closest?.("[data-geste]");
    if (cible === null || cible === undefined || !conteneur.contains(cible)) return;
    dire(revocation.appliquer({ type: cible.getAttribute("data-geste") }));
  });

  return Object.freeze({
    revocation,
    demarrer: () => dire(revocation.demarrer()),
    appliquer: (evenement) => dire(revocation.appliquer(evenement)),
    modifier: (lanceur) => dire(revocation.modifier(lanceur)),
    definirLIndice: (valeur) => revocation.definirLIndice(valeur),
    etat: () => revocation.etat(),
    projection: () => revocation.projection(),
    lirePublic: () => lirePublic(revocation.etat()),
    lireLeConstat: () => lireLeConstat(revocation.etat()),
    identifiantDuVolume: () => identifiantVolume,
    terminer: () => revocation.terminer(),
    echecs: () => revocation.echecs(),
    rendeur,
    affichage,
  });
}
