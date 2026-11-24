// Un CÂBLAGE de la révocation sur un DOM factice (#265) : le VRAI module `cablage-de-la-revocation.mjs`, un
// faux canal (`demander`) dont chaque réponse est tenue par l'épreuve, et un compteur de messages posés.

import { creerLeCablage } from "../../src/coquille/cablage-de-la-revocation.mjs";
import { SUCCES, differe, tourner } from "./support-magasin-revocation.mjs";
import { reponseDInventaire } from "./support-revocation.mjs";
import { documentFactice } from "./support-dom-factice.mjs";

export { SUCCES, differe, tourner, reponseDInventaire };

/** La page : conteneur masqué, région d'erreur, annonce, repère de focus — le HTML statique de `index.html`. */
export function pageDeLaRevocation() {
  const doc = documentFactice();
  doc.poser([
    ["h2", { id: "parcours-titre", tabindex: "-1" }, "Titre"],
    ["div", { id: "affichage", hidden: true }],
    ["p", { id: "affichage-attente" }, "Préparation de l'affichage de votre coffre…"],
    ["p", { id: "affichage-erreur", hidden: true }, "L'affichage n'a pas pu être actualisé."],
    ["p", { id: "affichage-annonce" }],
  ]);
  return doc;
}

/**
 * @param {{ indice?: boolean, inventaire?: object, reponses?: Record<string, Function>,
 *           masquerEchoue?: boolean }} options
 */
export function monterLeCablage(options = {}) {
  const doc = pageDeLaRevocation();
  const messages = [];
  const attentes = { inventaire: [], revoquerEnUrgence: [], creerRecuperation: [], restaurer: [] };
  const rapport = { feuilleEprouvee: false, tailleDeSauvegarde: null, portabilite: {} };
  const journal = { notes: 0, termine: 0, revenu: 0, miroirs: [], succes: [], publications: 0 };
  const demander = (type, corps = {}) => {
    messages.push(type);
    if (options.reponses?.[type]) return options.reponses[type](corps);
    const d = differe();
    (attentes[type] ??= []).push(d);
    return d.promesse;
  };
  const conteneur = doc.getElementById("affichage");
  if (options.masquerEchoue) {
    conteneur.removeAttribute = () => {
      throw new Error("retrait");
    };
    Object.defineProperty(conteneur, "hidden", {
      get: () => false,
      set: () => {},
      configurable: true,
    });
    conteneur.setAttribute = (nom, valeur) => {
      if (nom === "hidden") return;
      return Object.getPrototypeOf(conteneur).setAttribute.call(conteneur, nom, valeur);
    };
  }
  const cablage = creerLeCablage({
    doc,
    conteneur,
    regionDErreur: doc.getElementById("affichage-erreur"),
    annonce: doc.getElementById("affichage-annonce"),
    repereDeFocus: doc.getElementById("parcours-titre"),
    demander,
    rapport,
    publierLeRapport: () => (journal.publications += 1),
    indice: options.indice ?? false,
    noterLIndice: () => {
      journal.notes += 1;
      return options.noterRejette ? Promise.reject(new Error("écriture")) : Promise.resolve();
    },
    refleter: (donnees, identifiantVolume) => journal.miroirs.push([donnees, identifiantVolume]),
    surRevocationAcquittee: (rendu) => journal.succes.push(rendu),
    surTerminer: () => (journal.termine += 1),
    surRevenir: () => (journal.revenu += 1),
  });
  const repondreALInventaire = async (surcharge = {}, rang = null) => {
    const d = rang === null ? attentes.inventaire.at(-1) : attentes.inventaire[rang];
    d.resoudre({ ...reponseDInventaire(), ...surcharge });
    await tourner();
  };
  /** Monte, lit l'inventaire fermé, ouvre le coffre, lit l'inventaire ouvert : l'état P. */
  const jusquAP = async (moyen = "phrase", surcharge = {}) => {
    cablage.demarrer();
    await repondreALInventaire({ feuilleEprouvee: false });
    cablage.appliquer({ type: "coffre-ouvert", moyen });
    await repondreALInventaire({ ...surcharge });
  };
  const clic = (id) => {
    const bouton = doc.getElementById(id);
    bouton.click?.();
    return bouton;
  };
  /** Un clic qui ARRIVE même sur un bouton `aria-disabled` (comme `dispatchEvent`). */
  const clicSynthetique = (id) => doc.getElementById(id).dispatchEvent(new doc.Evenement("click"));
  return {
    doc,
    cablage,
    rapport,
    journal,
    messages,
    attentes,
    conteneur,
    repondreALInventaire,
    jusquAP,
    clic,
    clicSynthetique,
    texte: () => conteneur.textContent,
    estampille: () => conteneur.getAttribute("data-vue"),
  };
}
