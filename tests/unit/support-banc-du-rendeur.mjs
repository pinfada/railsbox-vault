// Un BANC pour le rendeur unique (#265) : promesses contrôlées, horloge factice, effets visibles tracés.
// Rien ici ne décide : le banc OBSERVE, les épreuves jugent.

import { creerLeRendeur } from "../../src/coquille/rendeur-de-la-vue.mjs";

/** Laisse passer tous les micro-tâches en attente. */
export const vider = () => new Promise((rendre) => setImmediate(rendre));

/**
 * @param {{ occurrence?: number, defaillances?: Record<string, Function> }} options
 *   `defaillances` : nom d'effet ou de dépendance → fonction qui LÈVE quand elle est appelée.
 */
export function banc({ occurrence = 1, defaillances = {} } = {}) {
  const b = {
    occ: occurrence,
    visible: [],
    consigne: [],
    taches: [],
    minuteries: [],
    fragments: 0,
    rendeur: null,
    enVolVuAuxEffets: [],
    armements: 0,
  };
  const defaille = (nom) => defaillances[nom]?.();
  const effet = (nom, ...details) => {
    b.enVolVuAuxEffets.push([nom, b.rendeur?.diagnostic().enVol ?? null]);
    defaille(nom);
    b.visible.push([nom, ...details].join(":"));
  };
  b.avancer = (fois = 1) => {
    for (let i = 0; i < fois; i += 1) b.occ += 1;
    b.rendeur.reveiller();
  };
  b.rendeur = creerLeRendeur({
    occurrence: () => b.occ,
    nouveauFragment: () => ({ id: (b.fragments += 1) }),
    rendre: (occ, fragment) => {
      const tache = { occ, fragment, regle: false };
      b.taches.push(tache);
      // Garde-fou du banc : un rendeur qui boucle ne fait pas tourner l'épreuve sans fin.
      if (b.taches.length > 50) return new Promise(() => {});
      defaille("rendre-synchrone");
      if (defaillances["rendre-pret"]) return defaillances["rendre-pret"](tache);
      return new Promise((ok, ko) => {
        tache.ok = (valeur = "ok") => ok(valeur);
        tache.ko = (erreur = new Error("rendu rejeté")) => ko(erreur);
      });
    },
    effets: {
      remplacerLeContenu: (fragment) => effet("remplacer", fragment.id),
      retirerLaRegionDErreur: () => effet("retirer-erreur"),
      demasquer: () => effet("demasquer"),
      estamper: (occ) => effet("estampe", occ),
      masquer: () => effet("masquer"),
      montrerLaRegionDErreur: (occ) => effet("erreur", occ),
    },
    armer: (ms, fonction) => {
      b.armements += 1;
      defaille("armer");
      const minuterie = { ms, fonction, annulee: false };
      b.minuteries.push(minuterie);
      return minuterie;
    },
    desarmer: (minuterie) => {
      defaille("desarmer");
      if (minuterie) minuterie.annulee = true;
    },
    consigner: (code, detail) => {
      b.consigne.push(code);
      defaille("consigner");
      void detail;
    },
  });
  /** Déclenche la minuterie d'une tentative (la n-ième armée). */
  b.expirer = (rang = b.minuteries.length - 1) => b.minuteries[rang].fonction();
  b.lancements = () => b.taches.length;
  b.lancementsDe = (occ) => b.taches.filter((tache) => tache.occ === occ).length;
  return b;
}
