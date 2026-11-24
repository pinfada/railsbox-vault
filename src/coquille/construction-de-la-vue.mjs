// La CONSTRUCTION de la vue de la révocation (#265, ADR 0049 § C2, C2-11) : un fragment PRIVÉ fait de la
// SEULE projection de l'état. Aucun miroir, aucune ligne de texte, aucun nœud déjà présent n'y entre : la
// fonction ne reçoit que `doc` (pour créer des nœuds) et la projection. C'est ce qui rend « toute
// affirmation visible est une fonction de la vue » vérifiable.
//
// L'ORDRE du DOM est l'ordre visuel ET l'ordre de tabulation : « Terminer sans révoquer » d'abord (c'est
// le choix par défaut, ADR 0043), « Révoquer… » ensuite, en contour (`data-danger`), jamais en principal.
// Les boutons ne sont jamais `disabled` : `aria-disabled` est DÉRIVÉ de `projeter().gestes`, et ne
// décide de rien — le gestionnaire appelle `appliquer`, que la table refuse ou accepte.
//
// Les sections portent `data-bloc` : la page (le parcours) en montre ou en cache selon l'écran. Cela ne
// change aucun CONTENU, seulement la visibilité de ce que la vue a déjà écrit.

import { MESSAGES } from "./textes-du-parcours.mjs";
import {
  avertissementDeRevocation,
  confirmationDeRevocation,
  texteDe,
} from "./textes-de-la-revocation.mjs";

/** `enfant` ajouté à `parent` ; `texte` écrit en texte brut, jamais interprété. */
function noeud(doc, nom, { id, texte, attributs = {} } = {}) {
  const element = doc.createElement(nom);
  if (id !== undefined) element.id = id;
  if (texte !== undefined) element.textContent = texte;
  for (const [cle, valeur] of Object.entries(attributs)) element.setAttribute(cle, valeur);
  return element;
}

function bouton(doc, { id, libelle, geste, projection, attributs = {} }) {
  const b = noeud(doc, "button", {
    id,
    texte: libelle,
    attributs: { type: "button", ...attributs },
  });
  b.setAttribute("data-geste", geste);
  b.setAttribute("aria-disabled", String(!projection.gestes[geste].ouvert));
  return b;
}

function bloc(doc, nom, ...enfants) {
  const section = noeud(doc, "div", { attributs: { "data-bloc": nom } });
  section.append(...enfants);
  return section;
}

function exigerUneProjection(projection) {
  const valide =
    projection !== null &&
    typeof projection === "object" &&
    projection.vue !== null &&
    typeof projection.vue === "object" &&
    projection.gestes !== null &&
    typeof projection.gestes === "object" &&
    "ecranImpose" in projection.vue;
  if (!valide) throw new TypeError("une projection de la révocation est attendue.");
}

function ecritLaRegion(doc, vue) {
  if (vue.region === null) return null;
  const { corps } = texteDe(vue.region);
  return noeud(doc, "p", {
    id: "affichage-region",
    texte: corps,
    attributs: { role: "status", "data-region": vue.region },
  });
}

function ecritLEcranImpose(doc, vue) {
  if (vue.ecranImpose === null) return null;
  const { titre, corps } = texteDe(vue.ecranImpose);
  const panneau = noeud(doc, "div", {
    id: "affichage-impose",
    attributs: { "data-bloc": "impose", "data-impose": vue.ecranImpose },
  });
  panneau.append(noeud(doc, "h3", { id: "affichage-titre", texte: titre }));
  panneau.append(noeud(doc, "p", { id: "affichage-corps", texte: corps }));
  return panneau;
}

function ecritLaFin(doc, vue) {
  if (vue.finDisponible === null) return null;
  const { titre, corps } = texteDe(vue.finDisponible);
  const fin = noeud(doc, "div", { id: "affichage-fin", attributs: { "data-bloc": "fin" } });
  fin.append(noeud(doc, "h3", { id: "affichage-fin-titre", texte: titre }));
  fin.append(noeud(doc, "p", { id: "affichage-fin-corps", texte: corps }));
  return fin;
}

function ecritLeCompte(doc, vue) {
  const codes = vue.nombreDeCodes;
  if (codes === null || codes <= 0) return null;
  return bloc(
    doc,
    "vue-codes",
    noeud(doc, "p", { id: "parcours-codes", texte: MESSAGES.codesDejaRendus(codes) }),
  );
}

function ecritLaConfirmation(doc, vue, projection) {
  const options = { codes: vue.nombreDeCodes };
  const panneau = noeud(doc, "div", {
    id: "revocation-confirmation",
    attributs: { role: "group", "aria-labelledby": "revocation-confirmation-titre" },
  });
  panneau.append(
    noeud(doc, "h3", { id: "revocation-confirmation-titre", texte: "Confirmer la révocation" }),
    noeud(doc, "p", {
      id: "revocation-confirmation-texte",
      texte: confirmationDeRevocation(vue.moyenDOuverture, vue.moyens, options),
    }),
  );
  const gestes = noeud(doc, "p");
  gestes.append(
    bouton(doc, {
      id: "revocation-annuler",
      libelle: "Annuler",
      geste: "annuler",
      projection,
      attributs: { "data-focus-initial": "" },
    }),
    bouton(doc, {
      id: "revocation-oui",
      libelle: "Oui, révoquer les autres moyens",
      geste: "oui",
      projection,
      attributs: { "data-danger": "" },
    }),
  );
  panneau.append(gestes);
  return panneau;
}

/** Les gestes de l'étape de révocation : sortie par défaut d'abord, révocation ensuite (ADR 0043). */
function ecritLesGestes(doc, vue, projection) {
  const sortie = bloc(
    doc,
    "sans-revoquer",
    noeud(doc, "p").appendChild(
      bouton(doc, {
        id: "parcours-sans-revoquer",
        libelle: "Terminer sans révoquer",
        geste: "terminer-sans-revoquer",
        projection,
        attributs: { "data-principal-de-la-vue": "" },
      }),
    ).parentNode,
  );
  const revocation = bloc(doc, "revocation");
  revocation.append(
    noeud(doc, "p", {
      id: "parcours-avertissement-revocation",
      texte: avertissementDeRevocation(vue.moyenDOuverture, vue.moyens, {
        codes: vue.nombreDeCodes,
      }),
    }),
  );
  const demande = noeud(doc, "p");
  demande.append(
    bouton(doc, {
      id: "revoquer-en-urgence",
      libelle: "Révoquer tous les autres moyens d'ouvrir ce coffre",
      geste: "demander-la-revocation",
      projection,
      attributs: { "data-danger": "" },
    }),
  );
  revocation.append(demande);
  if (vue.confirmation !== null) revocation.append(ecritLaConfirmation(doc, vue, projection));
  return [sortie, revocation];
}

/**
 * @param {Document} doc sert à CRÉER des nœuds, jamais à en lire
 * @param {object} projection le résultat de `projeter(etat)`
 * @returns {DocumentFragment} un fragment neuf, jamais attaché
 */
export function construireLaVue(doc, projection) {
  exigerUneProjection(projection);
  const { vue } = projection;
  const fragment = doc.createDocumentFragment();
  const morceaux = [
    ecritLaRegion(doc, vue),
    ecritLEcranImpose(doc, vue),
    ecritLaFin(doc, vue),
    ecritLeCompte(doc, vue),
    ...(vue.moyenDOuverture !== null ? ecritLesGestes(doc, vue, projection) : []),
  ];
  for (const morceau of morceaux) if (morceau !== null) fragment.append(morceau);
  return fragment;
}
