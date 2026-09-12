// Contournement MESURÉ du blocage Playwright ↔ Firefox suivi dans #178.
//
// Firefox peut avoir entièrement chargé le document tandis que la promesse rendue par `page.goto`
// reste sans fin. Une seconde navigation identique libère alors le suivi de navigation du pilote.
// On ne fait jamais une reprise d'épreuve ici : on ne récupère que cette signature exacte et on
// l'annote, afin que le rapport CI la compte au lieu de la cacher.

export const ANNOTATION_RECUPERATION_FIREFOX = "navigation-firefox-recuperee";
export const DELAI_SONDE_FIREFOX_MS = 5_000;

const PAGE_INSTRUMENTEE = Symbol("navigation Firefox instrumentée");

function apres(delaiMs) {
  return new Promise((resolve) => globalThis.setTimeout(resolve, delaiMs));
}

function rendre(issue) {
  if (issue.reussie) return issue.valeur;
  throw issue.erreur;
}

function urlAbsolue(cible, baseURL) {
  try {
    return new globalThis.URL(cible, baseURL).href;
  } catch {
    return null;
  }
}

/**
 * Vérifie que le navigateur a fini la navigation que le pilote croit encore en cours.
 * Une redirection, un document incomplet ou un Firefox qui ne répond plus ne correspond pas au
 * défaut mesuré : dans ces cas, le `goto` original garde la main et son timeout reste probant.
 */
async function documentDejaCharge(page, cible) {
  try {
    const etat = await page.evaluate(() => ({
      url: globalThis.location.href,
      pret: globalThis.document.readyState,
    }));
    return etat.url === cible && etat.pret === "complete";
  } catch {
    return false;
  }
}

/**
 * Instrumente les navigations d'une page Firefox. Les dépendances temporelles sont injectables
 * pour éprouver le cas bloqué sans faire attendre les tests unitaires.
 */
export function instrumenterNavigationFirefox(
  page,
  {
    browserName,
    baseURL,
    annoter = () => {},
    journaliser = (message) => globalThis.console.warn(message),
    attendre = apres,
    delaiMs = DELAI_SONDE_FIREFOX_MS,
  },
) {
  if (browserName !== "firefox" || page[PAGE_INSTRUMENTEE]) return false;

  const gotoOriginal = page.goto.bind(page);
  Object.defineProperty(page, PAGE_INSTRUMENTEE, { value: true });

  page.goto = async (cible, options) => {
    let issue = null;
    const navigation = gotoOriginal(cible, options).then(
      (valeur) => {
        issue = { reussie: true, valeur };
        return issue;
      },
      (erreur) => {
        issue = { reussie: false, erreur };
        return issue;
      },
    );

    await Promise.race([navigation, attendre(delaiMs)]);
    if (issue) return rendre(issue);

    const cibleAbsolue = urlAbsolue(cible, baseURL || page.url());
    const chargee = cibleAbsolue && (await documentDejaCharge(page, cibleAbsolue));
    // La promesse a pu se résoudre pendant la sonde : ne jamais lancer une seconde navigation saine.
    if (issue) return rendre(issue);
    if (!chargee) return rendre(await navigation);

    const description = `${cibleAbsolue} — page complète mais page.goto sans réponse après ${delaiMs} ms`;
    annoter({ type: ANNOTATION_RECUPERATION_FIREFOX, description });
    journaliser(`[Firefox navigation récupérée] ${description}`);

    // Cette seconde navigation identique est le contournement reproduit en amont. `navigation`
    // possède déjà ses deux gestionnaires : son éventuel rejet d'interruption ne sera pas orphelin.
    return gotoOriginal(cible, options);
  };
  return true;
}
