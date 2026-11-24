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

/** Le journal est un diagnostic : sa défaillance ne bloque jamais le rendeur. */
function noter(ctx, code, detail) {
  try {
    ctx.consigner(code, detail);
  } catch {
    // un journal qui lève n'empêche ni la libération ni le successeur
  }
}

/** L'autorisation : l'identité d'objet ET l'occurrence courante, relues À CET INSTANT. */
const autorise = (ctx, t, occ) => ctx.enVol === t && ctx.occurrence() === occ;

function converger(ctx) {
  if (ctx.enVol !== null) return;
  if (ctx.occurrence() === ctx.derniereOccurrenceTraitee) return;
  lancer(ctx);
}

function lancer(ctx) {
  const occ = ctx.occurrence();
  const t = { rang: (ctx.compteur += 1), occurrence: occ, fragment: null, delai: null };
  ctx.enVol = t;
  try {
    t.fragment = ctx.nouveauFragment();
    t.delai = ctx.armer(DELAI_DU_RENDEUR_MS, () => reglerGarde(ctx, t, { delai: true }));
  } catch (erreur) {
    // L'armement (ou le fragment) échoue APRÈS `enVol ← t` : la tentative est réglée en échec.
    noter(ctx, "lancement-en-echec", erreur);
    reglerGarde(ctx, t, { erreur });
    return;
  }
  let promesse;
  try {
    promesse = Promise.resolve(ctx.rendre(occ, t.fragment));
  } catch (erreur) {
    promesse = Promise.reject(erreur);
  }
  promesse.then(
    (valeur) => reglerGarde(ctx, t, { ok: valeur }),
    (erreur) => reglerGarde(ctx, t, { erreur }),
  );
}

/** Le GARDE-FOU : une erreur dans `regler` lui-même ne laisse jamais un rendeur bloqué. */
function reglerGarde(ctx, t, resultat) {
  try {
    regler(ctx, t, resultat);
  } catch (erreur) {
    noter(ctx, "regler-inattendu", erreur);
    liberer(ctx, t);
  }
}

/** Idempotent, réservé au garde-fou : la libération est effective même si le journal lève. */
function liberer(ctx, t) {
  if (ctx.enVol !== t) return;
  try {
    echouer(ctx, t, t.occurrence);
  } catch (erreur) {
    noter(ctx, "repli-en-echec", erreur);
  } finally {
    clore(ctx, t.occurrence);
  }
}

/** La libération UNIQUE, APRÈS tous les effets visibles, puis le successeur, même si tout a levé. */
function clore(ctx, occ) {
  ctx.enVol = null;
  ctx.derniereOccurrenceTraitee = occ;
  converger(ctx);
}

function regler(ctx, t, resultat) {
  if (ctx.enVol !== t) {
    noter(ctx, "tentative-perimee", t.rang);
    return;
  }
  ctx.desarmer(t.delai);
  const occ = t.occurrence;
  try {
    if (ctx.occurrence() !== occ) {
      // JETER : aucun effet visible ; le successeur suit dans le `finally`.
    } else if ("ok" in resultat) publier(ctx, t, occ, resultat.ok);
    else echouer(ctx, t, occ);
  } catch (erreur) {
    noter(ctx, "regler-en-echec", erreur);
    try {
      echouer(ctx, t, occ);
    } catch (repli) {
      noter(ctx, "repli-en-echec", repli);
    }
  } finally {
    clore(ctx, occ);
  }
}

/** Bloc SYNCHRONE : l'estampille est l'UNIQUE acte qui rend le contenu visible, donc le dernier. */
function publier(ctx, t, occ, valeur) {
  const { effets } = ctx;
  if (!autorise(ctx, t, occ)) return;
  effets.remplacerLeContenu(t.fragment);
  if (!autorise(ctx, t, occ)) return;
  effets.retirerLaRegionDErreur();
  if (!autorise(ctx, t, occ)) return;
  effets.demasquer();
  if (!autorise(ctx, t, occ)) return;
  effets.estamper(occ, valeur);
  ctx.occurrencePubliee = occ;
}

function echouer(ctx, t, occ) {
  if (!autorise(ctx, t, occ)) return;
  ctx.effets.masquer();
  if (!autorise(ctx, t, occ)) return;
  ctx.effets.montrerLaRegionDErreur(occ);
}

/**
 * @param {{ occurrence: () => number, nouveauFragment: () => object,
 *           rendre: (occurrence: number, fragment: object) => unknown,
 *           effets: { remplacerLeContenu: Function, retirerLaRegionDErreur: Function,
 *                     demasquer: Function, estamper: (occurrence: number, valeur: unknown) => void,
 *                     masquer: Function, montrerLaRegionDErreur: Function },
 *           armer: (ms: number, fonction: Function) => unknown, desarmer: (poignee: unknown) => void,
 *           consigner: (code: string, detail?: unknown) => void }} dependances
 */
export function creerLeRendeur(dependances) {
  const ctx = {
    ...dependances,
    /** La tentative AUTORISÉE, ou `null`. */
    enVol: null,
    derniereOccurrenceTraitee: null,
    occurrencePubliee: null,
    compteur: 0,
  };
  return Object.freeze({
    /** Appelé par l'effet `vue-a-rendre` : fait converger. */
    reveiller: () => converger(ctx),
    diagnostic: () =>
      Object.freeze({
        enVol: ctx.enVol !== null,
        derniereOccurrenceTraitee: ctx.derniereOccurrenceTraitee,
        occurrencePubliee: ctx.occurrencePubliee,
      }),
  });
}
