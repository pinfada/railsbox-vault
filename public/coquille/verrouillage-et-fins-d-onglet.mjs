// Le VERROUILLAGE et les FINS D'ONGLET (#175 : scission de `public/main.mjs`).
//
// Ce module tient la surveillance d'inactivité (#169, ADR 0031), les deux gestes qui en dépendent —
// le geste explicite et le délai — et les quatre événements de fin d'onglet (#170, ADR 0032). Il ne
// décide d'aucune conduite lui-même : `src/coquille/verrouillage.mjs` et `src/coquille/fins-d-
// onglet.mjs` restent seuls maîtres de ce qui se passe. Il ne parle aux trois autres modules de
// branchement que par le RELEVÉ et par le pont que `main.mjs` lui passe.

import {
  DECLENCHEURS,
  brancherLesSignauxDActivite,
  conduiteApresLeVerrouillage,
  conduiteApresUnRefusDeVerrouillage,
  surveillanceDInactivite,
} from "/src/coquille/verrouillage.mjs";
import { brancherLesFinsDOnglet } from "/src/coquille/fins-d-onglet.mjs";

/**
 * @param {object} config
 * @param {object} config.rapport
 * @param {() => void} config.publier
 * @param {(etat: string, texte: string) => void} config.terminer conclut la coquille avec son état
 *   et son texte publics — même fonction que celle que `demarrer()` (module du cycle) appelle.
 * @param {{ canal: { worker: Worker, terminerLeWorker(): void }, cycle: { constaterLaMort(cause: string, options?: { offrirLeGesteQuiRouvre?: boolean }): unknown, mortDuWorkerActuel(): unknown }, frontiere: { retirerLeCadre(): void } }} config.pont
 */
export function creerVerrouillageEtFinsDOnglet({ rapport, publier, terminer, pont }) {
  /** Le geste de verrouillage, une fois le cycle branché (#169, ADR 0031). */
  let verrouillerLeCoffre = null;

  /** L'instant du départ du verrouillage, sur l'horloge de la page. Origine de `verrouillageMs`. */
  let departDuVerrouillage = null;

  const surveillance = surveillanceDInactivite({
    maintenant: () => performance.now(),
    planifier: (geste, delai) => setTimeout(geste, delai),
    annuler: (identifiant) => clearTimeout(identifiant),
    verrouiller: () => void verrouillerLeCoffre?.(DECLENCHEURS.inactivite),
  });

  brancherLesSignauxDActivite({ racine: document, surveillance });

  /** RECHARGE la coquille, au tour de boucle SUIVANT. */
  function rechargerLaCoquille() {
    setTimeout(() => location.reload(), 0);
  }

  brancherLesFinsDOnglet({
    racine: document,
    fenetre: globalThis,
    surveillance,
    constatDuWorker: () => ({
      worker: pont.canal.worker,
      mortDuWorker: pont.cycle.mortDuWorkerActuel(),
      etatPublie: rapport.etat,
    }),
    tuerLeWorker: () => pont.canal.terminerLeWorker(),
    recharger: () => rechargerLaCoquille(),
    journal: (evenement, action) => {
      rapport.journal.push(`fin-d-onglet:${evenement}:${action}`);
      publier();
    },
  });

  /** REFLÈTE dans la surveillance l'état que le relevé vient de publier. */
  function refletDeLEtat() {
    surveillance.armer(rapport.etat);
  }

  /** ACHÈVE le verrouillage : constate l'état, publie la mesure, PUIS recharge la coquille. */
  function acheverLeVerrouillage(declencheur) {
    const conduite = conduiteApresLeVerrouillage({ etatConnu: rapport.etat });
    pont.cycle.constaterLaMort(conduite.cause, {
      offrirLeGesteQuiRouvre: conduite.gesteQuiRouvreOffert,
    });
    // Le CADRE est retiré ICI, avant le rechargement (#192).
    //
    // Le rechargement l'emportait déjà — c'est ce que l'ADR 0031 décide —, mais il a lieu au tour de
    // boucle suivant, et entre les deux le cadre reste peint et le relais reste en vol. Tant que
    // celui-ci ne servait qu'une question d'état, l'écart ne se voyait pas ; depuis que le cadre
    // porte ce que Rails rend, il vaut une page métier affichée après le verrouillage. Le retrait
    // est donc un geste du verrouillage, et non une conséquence du rechargement.
    pont.frontiere.retirerLeCadre();
    if (departDuVerrouillage !== null) {
      rapport.mesures.verrouillageMs =
        Math.round((performance.now() - departDuVerrouillage) * 10) / 10;
    }
    rapport.verrouillage = {
      declencheur,
      delaiDInactiviteMs: surveillance.delaiMs,
      etat: conduite.etat,
      workerTermine: true,
      kekRetenue: conduite.kekRetenue,
      derivationPermise: conduite.derivationPermise,
      pousseeDeBarriere: conduite.pousseeDeBarriere,
      reouvertureAutomatique: conduite.reouvertureAutomatique,
      instantaneRetire: conduite.instantaneRetire,
      rechargerLaCoquille: conduite.rechargerLaCoquille,
    };
    terminer("verrouille", `coquille:verrouille:${rapport.verrouillage.declencheur}`);
    if (conduite.rechargerLaCoquille) rechargerLaCoquille();
  }

  /** ACHÈVE un verrouillage REFUSÉ : le refus est publié AVANT tout, le Worker est terminé, le
   * cadre est retiré, et la coquille NE recharge pas. */
  function acheverUnRefus(code, declencheur) {
    const conduite = conduiteApresUnRefusDeVerrouillage({ code, etatConnu: rapport.etat });
    rapport.verrouillage = {
      refuse: true,
      codeDuRefus: conduite.codeDuRefus,
      declencheur,
      delaiDInactiviteMs: surveillance.delaiMs,
      workerTermine: conduite.terminerLeWorker,
      cadreRetire: conduite.retirerLeCadre,
      rechargerLaCoquille: conduite.rechargerLaCoquille,
      instantaneGaranti: conduite.instantaneGaranti,
      kekRetenue: conduite.kekRetenue,
    };
    publier();
    if (conduite.terminerLeWorker) pont.canal.terminerLeWorker();
    pont.cycle.constaterLaMort(conduite.cause, {
      offrirLeGesteQuiRouvre: conduite.gesteQuiRouvreOffert,
    });
    if (conduite.retirerLeCadre) pont.frontiere.retirerLeCadre();
    terminer("verrouillage-refuse", `coquille:verrouillage-refuse:${code ?? "inconnu"}`);
  }

  return {
    surveillance,
    refletDeLEtat,
    signalerActivite: (nom) => surveillance.signaler(nom),
    rechargerLaCoquille,
    definirGesteDeVerrouillage: (geste) => {
      verrouillerLeCoffre = geste;
    },
    gestesDeVerrouillage: () => ({
      avantVerrouillage: () => {
        departDuVerrouillage = performance.now();
      },
      apresRefusDOrdre: (code, declencheur) => {
        rapport.verrouillage = { refuse: true, code, horsOrdre: true, declencheur };
        departDuVerrouillage = null;
        if (declencheur === DECLENCHEURS.inactivite) surveillance.noterUnVerrouillageDu();
        refletDeLEtat();
        publier();
      },
      apresRefusDeVerrouillage: (code, declencheur) => acheverUnRefus(code, declencheur),
      apresVerrouillage: (declencheur) => {
        pont.canal.terminerLeWorker();
        acheverLeVerrouillage(declencheur);
      },
      apresDemarrage: () => {
        refletDeLEtat();
        surveillance.jouerLeVerrouillageDu();
      },
    }),
  };
}
