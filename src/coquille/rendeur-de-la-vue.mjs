// Le RENDEUR UNIQUE de la vue de la révocation (#265, ADR 0049 § C2, protocole X1.2).
//
// Ce que la personne lit est une PROJECTION autoritaire de l'état, rendue par UN SEUL rendeur :
//  - une tentative AUTORISÉE à la fois (`enVol`), et l'autorisation est l'IDENTITÉ d'OBJET de la tentative
//    (`enVol === t`), jamais un entier relu dans un champ ;
//  - la vue est construite dans un FRAGMENT PRIVÉ (aucun effet visible), puis PUBLIÉE dans un bloc
//    synchrone dont chaque effet visible est précédé d'une relecture de l'autorisation ;
//  - une tâche abandonnée par le délai court encore (JavaScript ne l'interrompt pas), mais n'a plus
//    l'autorisation : elle n'écrit que dans son fragment ;
//  - `enVol` reste occupé pendant TOUT le bloc des effets visibles, et n'est libéré qu'UNE fois, dans un
//    `finally`, suivi de `converger()` : aucune exception (publication, repli, journal, désarmement)
//    n'empêche le successeur ;
//  - au plus UNE tentative par occurrence : une occurrence traitée (publiée, en erreur ou jetée) n'est
//    jamais relancée, donc aucune boucle.
//
// Ce module ne touche ni DOM, ni horloge : tout passe par des dépendances injectées. Il ne sait pas ce
// qu'est une vue.

/**
 * Le délai au-delà duquel une tentative qui ne se règle pas est abandonnée (région d'erreur sûre).
 * La construction d'une vue est SYNCHRONE : ce délai ne borne qu'une anomalie (un rendu qui ne répond
 * jamais). Valeur calibrée sur trois moteurs : voir ADR 0049, note de C2.
 */
export const DELAI_DU_RENDEUR_MS = 2000;

/**
 * @param {{ occurrence: () => number, nouveauFragment: () => object,
 *           rendre: (occurrence: number, fragment: object) => unknown,
 *           effets: { remplacerLeContenu: Function, retirerLaRegionDErreur: Function,
 *                     demasquer: Function, estamper: (occurrence: number, valeur: unknown) => void, masquer: Function,
 *                     montrerLaRegionDErreur: Function },
 *           armer: (ms: number, fonction: Function) => unknown, desarmer: (poignee: unknown) => void,
 *           consigner: (code: string, detail?: unknown) => void }} dependances
 */
export function creerLeRendeur({
  occurrence,
  nouveauFragment,
  rendre,
  effets,
  armer,
  desarmer,
  consigner,
}) {
  /** La tentative AUTORISÉE, ou `null`. */
  let enVol = null;
  let derniereOccurrenceTraitee = null;
  let occurrencePubliee = null;
  let compteur = 0;

  /** Le journal est un diagnostic : sa défaillance ne bloque jamais le rendeur. */
  function noter(code, detail) {
    try {
      consigner(code, detail);
    } catch {
      // un journal qui lève n'empêche ni la libération ni le successeur
    }
  }

  /** L'autorisation : l'identité d'objet ET l'occurrence courante, relues À CET INSTANT. */
  const autorise = (t, occ) => enVol === t && occurrence() === occ;

  function converger() {
    if (enVol !== null) return;
    if (occurrence() === derniereOccurrenceTraitee) return;
    lancer();
  }

  function lancer() {
    const occ = occurrence();
    const t = { rang: (compteur += 1), occurrence: occ, fragment: null, delai: null };
    enVol = t;
    try {
      t.fragment = nouveauFragment();
      t.delai = armer(DELAI_DU_RENDEUR_MS, () => reglerGarde(t, { delai: true }));
    } catch (erreur) {
      // L'armement (ou le fragment) échoue APRÈS `enVol ← t` : la tentative est réglée en échec.
      noter("lancement-en-echec", erreur);
      reglerGarde(t, { erreur });
      return;
    }
    let promesse;
    try {
      promesse = Promise.resolve(rendre(occ, t.fragment));
    } catch (erreur) {
      promesse = Promise.reject(erreur);
    }
    promesse.then(
      (valeur) => reglerGarde(t, { ok: valeur }),
      (erreur) => reglerGarde(t, { erreur }),
    );
  }

  /** Le GARDE-FOU : une erreur dans `regler` lui-même ne laisse jamais un rendeur bloqué. */
  function reglerGarde(t, resultat) {
    try {
      regler(t, resultat);
    } catch (erreur) {
      noter("regler-inattendu", erreur);
      liberer(t);
    }
  }

  /** Idempotent, réservé au garde-fou : la libération est effective même si le journal lève. */
  function liberer(t) {
    if (enVol !== t) return;
    try {
      echouer(t, t.occurrence);
    } catch (erreur) {
      noter("repli-en-echec", erreur);
    } finally {
      enVol = null;
      derniereOccurrenceTraitee = t.occurrence;
      converger();
    }
  }

  function regler(t, resultat) {
    if (enVol !== t) {
      noter("tentative-perimee", t.rang);
      return;
    }
    desarmer(t.delai);
    const occ = t.occurrence;
    try {
      if (occurrence() !== occ) {
        // JETER : aucun effet visible ; le successeur suit dans le `finally`.
      } else if ("ok" in resultat) publier(t, occ, resultat.ok);
      else echouer(t, occ);
    } catch (erreur) {
      noter("regler-en-echec", erreur);
      try {
        echouer(t, occ);
      } catch (repli) {
        noter("repli-en-echec", repli);
      }
    } finally {
      enVol = null;
      derniereOccurrenceTraitee = occ;
      converger();
    }
  }

  /** Bloc SYNCHRONE : l'estampille est l'UNIQUE acte qui rend le contenu visible, donc le dernier. */
  function publier(t, occ, valeur) {
    if (!autorise(t, occ)) return;
    effets.remplacerLeContenu(t.fragment);
    if (!autorise(t, occ)) return;
    effets.retirerLaRegionDErreur();
    if (!autorise(t, occ)) return;
    effets.demasquer();
    if (!autorise(t, occ)) return;
    effets.estamper(occ, valeur);
    occurrencePubliee = occ;
  }

  function echouer(t, occ) {
    if (!autorise(t, occ)) return;
    effets.masquer();
    if (!autorise(t, occ)) return;
    effets.montrerLaRegionDErreur(occ);
  }

  return Object.freeze({
    /** Appelé par l'effet `vue-a-rendre` : fait converger. */
    reveiller: converger,
    diagnostic: () =>
      Object.freeze({
        enVol: enVol !== null,
        derniereOccurrenceTraitee,
        occurrencePubliee,
      }),
  });
}
