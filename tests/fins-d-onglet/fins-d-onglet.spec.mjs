// Les FINS D'ONGLET, MESURÉES par moteur (#170, tranche 2 de #25, ADR 0032).
//
// Ce que `pagehide`, `pageshow`, `visibilitychange`, `freeze`/`resume` et `beforeunload` livrent
// RÉELLEMENT à la fermeture, à la navigation, au retour arrière et au gel n'est écrit dans aucune
// norme que trois implémentations liraient pareil. Cette suite le RELÈVE, et
// `docs/compatibility.md` publie ce qu'elle a relevé, daté, avec son exécutant et son canal
// d'observation.
//
// ## Une configuration à elle, et ce n'est pas une commodité
//
// `playwright.fins-d-onglet.config.mjs` retire `--disable-back-forward-cache` du lanceur Chromium.
// Sans ce retrait, la ligne « restauré depuis le bfcache » mesurerait l'argument que Playwright
// pose, pas le moteur — et elle conclurait que le chemin `pageshow` de la coquille ne sert à rien
// sur une observation fabriquée par le harnais.
//
// ## Ce que cette suite ne mesure PAS, et le § Limites de l'ADR 0032 le redit
//
// Ni la mise en veille du système, ni l'éviction d'un onglet sous pression mémoire, ni un `freeze`
// livré SPONTANÉMENT par le moteur, ni la mort du processus de rendu autrement que par ce que le
// protocole de débogage sait provoquer. Chaque absence est ÉCRITE avec son motif, jamais laissée
// en case vide.

import { expect, test } from "../support/test.mjs";

import { ARGUMENTS_RETIRES } from "../../playwright.fins-d-onglet.config.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { sonder } from "../browser/sonde-des-stockages.mjs";
import {
  brancherLaConsole,
  evenementsDe,
  poserLObservateurLeger,
  poserLObservatoire,
  publier,
  recuesParLeTemoin,
  releveLeger,
} from "./observatoire.mjs";

/** Les projets qui tournent AVEC une fenêtre. Le relevé le publie : la mesure en dépend. */
const EN_FENETRE = ["chromium-fenetre"];

/** Le document SUJET : une page statique de la même origine, qui ne fait rien d'autre qu'exister. */
const SUJET = "/coquille-epreuve/fenetre-ouverte.html";
/** La destination d'une navigation sortante. Elle aussi est statique et sans effet. */
const AILLEURS = "/coquille-epreuve/ouvrante.html";
/** Le document TÉMOIN, qui survit au sujet et reçoit ce que celui-ci diffuse. */
const TEMOIN = "/coquille-epreuve/fenetre-ouverte.html?role=temoin";

/** La phrase des épreuves. Elle est PUBLIQUE et sans valeur : c'est un marqueur, pas un secret. */
const PHRASE = "marqueur-de-phrase-des-fins-d-onglet-170-cheval-batterie-agrafe-correcte";

/** L'appât de la sonde : la même forme qu'un secret, pour prouver que la fouille trouve. */
const APPAT = "appat-de-sonde-170-ce-texte-doit-etre-trouve";

const DELAI = 120_000;

/** Le relevé public de la coquille, tel que le nœud le publie. */
async function releve(page) {
  return JSON.parse(await page.locator("#coquille-rapport").textContent());
}

/** Ouvre un TÉMOIN vivant, et rend la page. Il ne navigue plus jusqu'à la fin de l'épreuve. */
async function ouvrirLeTemoin(contexte) {
  const temoin = await contexte.newPage();
  await temoin.goto(TEMOIN);
  await expect(temoin.locator("h1")).toBeVisible();
  return temoin;
}

/**
 * Ouvre la coquille de produit et attend qu'elle se déclare prête.
 *
 * Ce n'est pas le même signal que `#deverrouillage-moyens` de #162 : cette suite mesure un
 * DOCUMENT dans son entier — son Worker de confiance, son cadre applicatif, ses en-têtes —, et ce
 * qui l'intéresse est l'état où un onglet se referme pour de bon.
 */
async function ouvrirLaCoquille(page) {
  // `commit` et non `load`, pour la raison qui vaut aussi pour le retour arrière : ce qu'on attend
  // est le signal de la COQUILLE — `data-coquille="prete"`, écrit par le produit —, pas la fin du
  // chargement de ses sous-ressources. Le cadre applicatif est créé dynamiquement et retient le
  // `load` du document ; sur Firefox, une navigation vers une coquille dont l'onglet précédent
  // vient d'être fermé n'a pas rendu la main avant l'expiration du budget. La ligne suivante est,
  // elle, une vraie attente : elle porte sur ce que le produit publie.
  await page.goto("/index.html", { waitUntil: "commit" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });
}

/** OUVRE le coffre par la phrase. Rend `true` si le moteur y est parvenu. */
async function ouvrirLeCoffre(page) {
  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: DELAI })
    .not.toBe(ETATS_DU_VOLUME.verrouille);
  return (await releve(page)).etat === ETATS_DU_VOLUME.ouvert;
}

/**
 * Ce que le moteur dit du BFCACHE après une navigation de retour, tel qu'il l'expose.
 *
 * Chromium publie `notRestoredReasons` sur l'entrée de navigation ; les deux autres n'exposent rien
 * d'équivalent, et la sonde rend alors `null` — « non exposé par ce moteur », qui n'est pas la même
 * chose que « restauré ».
 */
async function raisonsDeNonRestauration(page) {
  return page.evaluate(() => {
    const entree = performance.getEntriesByType("navigation")[0];
    if (!("notRestoredReasons" in (entree ?? {}))) return { expose: false };
    const brutes = entree.notRestoredReasons;
    // `null` signifie « ce document a été restauré » : l'API ne rend des raisons que pour un
    // document qui ne l'a PAS été. La distinction compte, et « non exposé » en est une troisième.
    if (brutes === null) return { expose: true, restaure: true, raisons: [] };
    const aplatir = (noeud) => {
      if (!noeud) return [];
      const miennes = (noeud.reasons ?? []).map((raison) =>
        typeof raison === "string" ? raison : (raison?.reason ?? JSON.stringify(raison)),
      );
      const enfants = (noeud.children ?? []).flatMap((enfant) => aplatir(enfant));
      return [...miennes, ...enfants];
    };
    // Le BRUT est publié tel quel à côté de la liste aplatie : ce que Chromium nomme « masked »
    // n'est pas une raison, c'est un refus de la dire, et l'aplatir seul le ferait passer pour une.
    let brut;
    try {
      brut = JSON.parse(JSON.stringify(brutes));
    } catch {
      brut = String(brutes);
    }
    return { expose: true, restaure: false, raisons: aplatir(brutes), brut };
  });
}

/** Le nom du moteur, tel que la matrice publiée le nomme. */
function moteurDe(info) {
  return info.project.name;
}

/**
 * Attache un relevé au rapport de l'épreuve ET le publie sous `reports/fins-d-onglet/<moteur>.json`.
 *
 * Les deux, et pas l'un ou l'autre : la pièce jointe se lit dans le rapport d'une exécution qui a
 * rougi, le fichier se rouvre par un relecteur et s'archive par la CI. C'est le second que
 * `docs/compatibility.md` cite.
 */
async function attacher(info, nom, valeur) {
  await info.attach(`${nom}-${moteurDe(info)}.json`, {
    body: JSON.stringify(valeur, null, 2),
    contentType: "application/json",
  });
  await publier(moteurDe(info), nom, valeur);
}

// --- (a) LA MATRICE : quel événement, dans quelle situation, sur quel canal ------------------------

test("ce que le moteur livre à la FERMETURE d'un onglet, et par quel canal on l'observe", async ({
  context,
  page,
}, info) => {
  await poserLObservatoire(context);
  const console_ = brancherLaConsole(page);
  const temoin = await ouvrirLeTemoin(context);

  await page.goto(SUJET);
  await expect(page.locator("h1")).toBeVisible();
  // Le sujet est marqué : le témoin reçoit aussi ses propres événements, et la sonde doit pouvoir
  // les distinguer de ceux du document qui meurt.
  const avant = await recuesParLeTemoin(temoin, "fenetre-ouverte.html");

  await page.close();
  // Le canal du témoin est ASYNCHRONE : la fermeture rend la main avant que le message ait traversé.
  // Attendre un instant fixe mesurerait la machine ; on attend que le témoin se taise.
  await temoin.waitForTimeout(1_000);

  const apres = await recuesParLeTemoin(temoin, "fenetre-ouverte.html");
  const nouvelles = apres.slice(avant.length);
  const releveDuCanal = {
    moteur: moteurDe(info),
    situation: "fermeture par page.close()",
    argumentsRetires: ARGUMENTS_RETIRES[moteurDe(info)],
    parLeTemoin: evenementsDe(nouvelles.filter(({ url }) => !url.includes("role=temoin"))),
    parLaConsole: evenementsDe(console_),
    persisted: nouvelles
      .filter(({ evenement }) => evenement === "pagehide")
      .map(({ persisted }) => persisted),
  };
  // LE TÉMOIN POSITIF DU CANAL, relevé avec le reste : ce que le SUJET avait déjà fait parvenir au
  // témoin AVANT sa fermeture. Le témoin reçoit aussi ses propres événements, et une épreuve qui
  // compterait les deux passerait au vert sur un canal qui ne porte rien du sujet au témoin.
  const duSujetAvant = avant.filter(({ url }) => !url.includes("role=temoin"));
  releveDuCanal.temoinPositifDuCanal = evenementsDe(duSujetAvant);
  await attacher(info, "fermeture", releveDuCanal);

  // AUCUNE assertion sur ce qu'un moteur DOIT livrer à la fermeture : c'est une mesure, et la
  // matrice publie ce qu'elle a vu. Ce qui est EXIGÉ est que le canal porte du sujet au témoin — sans
  // quoi « rien reçu à la fermeture » ne dirait rien du moteur, seulement du harnais.
  expect(
    releveDuCanal.temoinPositifDuCanal,
    "le témoin n'a jamais rien reçu du sujet : le canal d'observation ne mesure rien",
  ).toContain("pageshow");
});

test("ce que le moteur livre à la NAVIGATION sortante, puis au RETOUR ARRIÈRE", async ({
  context,
  page,
}, info) => {
  await poserLObservatoire(context);
  const temoin = await ouvrirLeTemoin(context);

  await page.goto(SUJET);
  await expect(page.locator("h1")).toBeVisible();
  const avantLaNavigation = (await recuesParLeTemoin(temoin, "fenetre-ouverte.html")).length;

  await page.goto(AILLEURS);
  await expect(page.locator("h1")).toBeVisible();
  await temoin.waitForTimeout(500);
  const surLaNavigation = (await recuesParLeTemoin(temoin, "fenetre-ouverte.html")).slice(
    avantLaNavigation,
  );

  await page.goBack({ waitUntil: "commit" });
  await expect(page.locator("h1")).toBeVisible();
  await temoin.waitForTimeout(500);

  // Le retour se lit sur le document REVENU, où `pageshow.persisted` dit s'il a été restauré ou
  // reconstruit. C'est la seule ligne qui distingue un bfcache d'un rechargement.
  const surLeRetour = await page.evaluate(() => globalThis.__finsDOnglet ?? []);
  const raisons = await raisonsDeNonRestauration(page);

  await attacher(info, "navigation-et-retour", {
    moteur: moteurDe(info),
    surLaNavigationSortante: surLaNavigation
      .filter(({ url }) => !url.includes("role=temoin"))
      .map(({ evenement, persisted }) => ({ evenement, persisted })),
    surLeRetour: surLeRetour.map(({ evenement, persisted }) => ({ evenement, persisted })),
    pageshowPersisted: surLeRetour.some(
      ({ evenement, persisted }) => evenement === "pageshow" && persisted === true,
    ),
    notRestoredReasons: raisons,
  });

  // Le seul invariant exigé, et il porte sur la SONDE : un document revenu publie toujours un
  // `pageshow`, restauré ou non. Sans lui, l'épreuve ne saurait pas distinguer « non restauré » de
  // « non observé ».
  expect(evenementsDe(surLeRetour), "aucun pageshow observé sur le document revenu").toContain(
    "pageshow",
  );
});

// --- (b) LE GEL, mesuré par ce que le protocole permet --------------------------------------------

test("le GEL DEMANDÉ par le protocole : ce qu'il livre, et ce qu'il ne gèle pas", async ({
  context,
  page,
  browserName,
}, info) => {
  // `Page.setWebLifecycleState` appartient au protocole de débogage de Chromium. Sur Firefox et
  // WebKit, `freeze`/`resume` n'existent PAS dans le moteur : c'est « non livré, par conception »,
  // et non « non mesuré ». La ligne de la matrice le dit ainsi.
  test.skip(browserName !== "chromium", "freeze/resume n'existent pas dans ce moteur");
  await poserLObservatoire(context);
  await page.goto(SUJET);
  await expect(page.locator("h1")).toBeVisible();

  // DEUX témoins, et il en faut deux :
  //
  //  - une MINUTERIE dont l'échéance tombe pendant le gel demandé. Si elle se réveille à l'heure,
  //    rien n'a été suspendu ;
  //  - un BATTEMENT toutes les 200 ms. C'est le témoin POSITIF de l'observation : s'il bat, la page
  //    exécutait du code, et une absence de `freeze` ne peut pas se lire « le canal n'a rien vu ».
  const DELAI_MINUTERIE_MS = 2_000;
  const DUREE_DU_GEL_MS = 6_000;
  const PERIODE_DU_BATTEMENT_MS = 200;
  await page.evaluate(
    ({ delai, periode }) => {
      globalThis.__minuterie = { poseeMs: Date.now(), reveilMs: null };
      setTimeout(() => {
        globalThis.__minuterie.reveilMs = Date.now();
      }, delai);
      globalThis.__battements = [];
      setInterval(() => globalThis.__battements.push(Date.now()), periode);
    },
    { delai: DELAI_MINUTERIE_MS, periode: PERIODE_DU_BATTEMENT_MS },
  );

  // Un moteur ne GÈLE qu'un onglet CACHÉ. Le harnais essaie donc de le cacher — un second onglet
  // amené au premier plan —, et il RELÈVE ce que le moteur en fait. `Page.setWebLifecycleState`
  // n'admet que `frozen` et `active` : « Unidentified lifecycle state » pour tout autre mot, si
  // bien qu'aucun appel de protocole ne peut cacher l'onglet à sa place.
  const session = await context.newCDPSession(page);
  await session.send("Page.enable");
  const secondOnglet = await context.newPage();
  await secondOnglet.goto(AILLEURS);
  await secondOnglet.bringToFront();
  const visibiliteAvantLeGel = await page.evaluate(() => document.visibilityState);

  const gelMs = Date.now();
  let refusDuProtocole = null;
  try {
    await session.send("Page.setWebLifecycleState", { state: "frozen" });
  } catch (erreur) {
    refusDuProtocole = erreur?.message ?? String(erreur);
  }
  await new Promise((rendre) => setTimeout(rendre, DUREE_DU_GEL_MS));
  await session.send("Page.setWebLifecycleState", { state: "active" }).catch(() => {});
  const degelMs = Date.now();
  // Le réveil en retard, s'il vient, vient APRÈS le dégel : on lui laisse un tour d'horloge.
  await page.waitForTimeout(1_000);

  const apres = await page.evaluate(() => ({
    traces: globalThis.__finsDOnglet ?? [],
    minuterie: globalThis.__minuterie,
    battements: globalThis.__battements ?? [],
  }));

  const trous = apres.battements.map((instant, rang, tous) =>
    rang === 0 ? 0 : instant - tous[rang - 1],
  );
  const plusGrandTrouMs = trous.length === 0 ? null : Math.max(...trous);
  const noms = evenementsDe(apres.traces);
  const releveDuGel = {
    moteur: moteurDe(info),
    protocole: "Page.setWebLifecycleState({ state: 'frozen' }) puis 'active'",
    refusDuProtocole,
    visibiliteAvantLeGel,
    freezeRecu: noms.includes("freeze"),
    resumeRecu: noms.includes("resume"),
    evenements: noms,
    dureeDuGelDemandeMs: degelMs - gelMs,
    battements: {
      periodeMs: PERIODE_DU_BATTEMENT_MS,
      compte: apres.battements.length,
      plusGrandTrouMs,
    },
    minuterie: {
      echeanceMs: DELAI_MINUTERIE_MS,
      reveilApresMs:
        apres.minuterie?.reveilMs == null
          ? null
          : apres.minuterie.reveilMs - apres.minuterie.poseeMs,
      retardMs:
        apres.minuterie?.reveilMs == null
          ? null
          : apres.minuterie.reveilMs - apres.minuterie.poseeMs - DELAI_MINUTERIE_MS,
    },
    // LE VERDICT, et il porte sur le HARNAIS, pas sur le moteur : la page a-t-elle CESSÉ d'exécuter
    // du code pendant le gel demandé ? C'est la seule question à laquelle un battement répond.
    gelEffectif: plusGrandTrouMs !== null && plusGrandTrouMs > DUREE_DU_GEL_MS / 2,
  };
  await attacher(info, "gel", releveDuGel);

  // LE TÉMOIN POSITIF, en premier : la page exécutait du code pendant toute la mesure. Sans lui,
  // « ni freeze ni resume » se lirait « le canal n'a rien vu », et la ligne de la matrice serait
  // une supposition.
  expect(
    apres.battements.length,
    "la page n'a jamais battu : la sonde ne mesure rien, et l'absence de freeze ne prouve rien",
  ).toBeGreaterThan(DUREE_DU_GEL_MS / PERIODE_DU_BATTEMENT_MS / 2);

  // Et l'INVARIANT de cohérence : un `freeze` reçu sans interruption des battements, ou une
  // interruption sans `freeze`, voudrait dire que la sonde et le moteur ne parlent pas du même
  // événement. Les deux vont ensemble, quel que soit le verdict.
  expect(
    releveDuGel.freezeRecu,
    "freeze reçu et battements ininterrompus, ou l'inverse : la sonde et le moteur divergent",
  ).toBe(releveDuGel.gelEffectif);
});

test("un onglet ne devient JAMAIS caché sous ce harnais, et c'est mesuré plutôt que supposé", async ({
  context,
  page,
}, info) => {
  // C'est la MÊME limite que celle du gel, et elle en est la cause : un moteur ne gèle qu'un onglet
  // caché, et aucun moteur ne cache un onglet sous Playwright. La mesurer à part la rend citable
  // par la matrice sans dépendre du protocole de débogage de Chromium — donc sur les TROIS moteurs.
  await poserLObservatoire(context);
  await page.goto(SUJET);
  await expect(page.locator("h1")).toBeVisible();

  const manipulations = [];
  const relever = async (nom) => {
    manipulations.push({
      manipulation: nom,
      visibilite: await page.evaluate(() => document.visibilityState),
      cache: await page.evaluate(() => document.hidden),
    });
  };
  await relever("aucune");

  const secondOnglet = await context.newPage();
  await secondOnglet.goto(AILLEURS);
  await secondOnglet.bringToFront();
  await page.waitForTimeout(500);
  await relever("un second onglet est amené au premier plan");

  const traces = await page.evaluate(() => globalThis.__finsDOnglet ?? []);
  await attacher(info, "onglet-cache-manipule", {
    moteur: moteurDe(info),
    manipulations,
    evenementsDeVisibilite: evenementsDe(traces).filter((nom) => nom === "visibilitychange"),
  });

  // Rien n'est EXIGÉ du moteur : si aucun ne cache réellement un onglet, la ligne de la matrice dit
  // « non simulable », et la vérification d'échéance au retour visible s'éprouve en unitaire avec
  // l'horloge injectée. C'est écrit dans l'ADR 0032, § Limites.
  expect(manipulations).toHaveLength(2);
});

// --- (c) LE BFCACHE : mesuré pour de bon, et le harnais nommé ------------------------------------
//
// ## Ce que la première rédaction mesurait, et qui n'était pas le moteur
//
// Elle concluait « aucun document n'est jamais restauré, sur aucun moteur, témoin positif compris ».
// C'était FAUX, et deux défauts de sonde s'additionnaient (constat 2 de la revue de sécurité de la
// PR #177) :
//
//  - **le mode SANS FENÊTRE.** Chromium ne restaure rien sans fenêtre, et rend `masked` — un refus
//    de dire, pas une raison. Fenêtré, il restaure, y compris sous la politique `no-cache` de la
//    coquille. Les épreuves de cette section sont donc rejouées par le projet `chromium-fenetre` ;
//  - **le `BroadcastChannel` de l'observatoire**, qui est un bloqueur connu du bfcache : fenêtré,
//    `notRestoredReasons` rend `broadcastchannel-message` sur les documents qu'il instrumente. La
//    sonde bloquait sa propre mesure. Cette section emploie donc l'observateur LÉGER, qui ne pose
//    rien de bloquant ; le canal du témoin reste, mais pour les seules lignes de FERMETURE.
//
// **`goBack({ waitUntil: "commit" })`, partout** : une RESTAURATION ne tire aucun `load`, et
// l'attente par défaut expirait exactement sur le cas qu'on cherchait à mesurer.

/** Va en arrière SANS attendre un `load` : un document restauré n'en tire aucun. */
async function retourArriere(page) {
  await page.goBack({ waitUntil: "commit" });
}

test("@bfcache TÉMOIN POSITIF : une page NUE est-elle restaurée par ce moteur", async ({
  context,
  page,
}, info) => {
  // Le témoin qui donne son sens à toutes les autres lignes. Il ne porte que l'observateur LÉGER —
  // deux écouteurs de fenêtre et un compteur —, donc rien qui bloque l'éligibilité.
  await poserLObservateurLeger(context, { marqueDuDocument: "fenetre-ouverte.html" });
  await page.goto(SUJET);
  await expect(page.locator("h1")).toBeVisible();
  await page.goto(AILLEURS);
  await expect(page.locator("h1")).toBeVisible();
  await retourArriere(page);

  const vu = await releveLeger(page);
  const raisons = await raisonsDeNonRestauration(page);
  await attacher(info, "bfcache-temoin-positif", {
    moteur: moteurDe(info),
    fenetre: EN_FENETRE.includes(moteurDe(info)),
    argumentsRetires: ARGUMENTS_RETIRES[moteurDe(info)] ?? [],
    documentSansInstrumentationBloquante: SUJET,
    evenements: vu.traces,
    restaure: vu.restaure,
    chargements: vu.chargements,
    notRestoredReasons: raisons,
  });

  // Le seul invariant : la sonde a bien vu le document revenir. Ce qu'un moteur en fait est une
  // MESURE, publiée par `docs/compatibility.md`, pas une exigence.
  expect(vu.traces.map(({ evenement }) => evenement)).toContain("pageshow");
});

test("@bfcache la coquille, coffre VERROUILLÉ : restaurée, ou reconstruite", async ({
  context,
  page,
}, info) => {
  await poserLObservateurLeger(context, { marqueDuDocument: "/index.html" });
  await ouvrirLaCoquille(page);
  await page.goto(AILLEURS);
  await expect(page.locator("h1")).toBeVisible();
  await retourArriere(page);
  await page.waitForTimeout(1_000);

  const vu = await releveLeger(page);
  const raisons = await raisonsDeNonRestauration(page);
  await attacher(info, "bfcache-coffre-verrouille", {
    moteur: moteurDe(info),
    fenetre: EN_FENETRE.includes(moteurDe(info)),
    evenements: vu.traces,
    restaure: vu.restaure,
    chargements: vu.chargements,
    notRestoredReasons: raisons,
  });

  expect(vu.traces.map(({ evenement }) => evenement)).toContain("pageshow");
});

test("@bfcache un écouteur de `beforeunload` change-t-il l'éligibilité", async ({
  context,
  page,
}, info) => {
  // `beforeunload` est MESURÉ, jamais écouté par le produit. La ligne ne disait rien tant qu'AUCUN
  // document n'était restauré ; fenêtré, elle mesure enfin quelque chose.
  await poserLObservateurLeger(context, { marqueDuDocument: "fenetre-ouverte.html" });
  await context.addInitScript(() => {
    // AUCUNE boîte de dialogue : ni `preventDefault`, ni `returnValue`. Retenir l'utilisateur est
    // précisément l'usage que la Definition of Ready de #25 interdit.
    if (!location.href.includes("fenetre-ouverte.html")) return;
    addEventListener("beforeunload", () => {});
  });
  await page.goto(SUJET);
  await expect(page.locator("h1")).toBeVisible();
  await page.goto(AILLEURS);
  await expect(page.locator("h1")).toBeVisible();
  await retourArriere(page);

  const vu = await releveLeger(page);
  const raisons = await raisonsDeNonRestauration(page);
  await attacher(info, "bfcache-beforeunload", {
    moteur: moteurDe(info),
    fenetre: EN_FENETRE.includes(moteurDe(info)),
    evenements: vu.traces,
    restaure: vu.restaure,
    chargements: vu.chargements,
    notRestoredReasons: raisons,
  });

  expect(vu.traces.map(({ evenement }) => evenement)).toContain("pageshow");
});

test("@bfcache L'ÉPREUVE MAÎTRESSE : coffre OUVERT, retour arrière, la coquille revient VERROUILLÉE", async ({
  context,
  page,
  browserName,
}, info) => {
  // C'est le chemin entier de la tranche, et le seul endroit où il s'observe dans un navigateur :
  // un coffre OUVERT, `pagehide` qui tue le Worker au départ du document, un RETOUR ARRIÈRE que le
  // moteur sert depuis son cache — donc avec le cadre applicatif et ses pixels —, et `pageshow`
  // restauré qui RECHARGE. La coquille revient `verrouille`, en DEUX chargements et pas trois.
  //
  // Tant que la sonde bloquait sa propre restauration, ce chemin n'était tenu que par l'unitaire et
  // par deux mutants. Il est désormais MESURÉ (constat 2 de la revue de la PR #177).
  test.setTimeout(300_000);
  await poserLObservateurLeger(context, { marqueDuDocument: "/index.html" });
  await ouvrirLaCoquille(page);
  const ouvert = await ouvrirLeCoffre(page);
  if (!ouvert) {
    await attacher(info, "bfcache-coffre-ouvert", {
      moteur: moteurDe(info),
      verdict: "indisponible",
      motif: "aucun volume ne s'ouvre sur ce moteur : il n'y a pas de coffre ouvert à mesurer",
    });
    expect(browserName, "un moteur qui n'ouvre rien devrait être WebKit").toBe("webkit");
    return;
  }

  await page.goto(AILLEURS);
  await expect(page.locator("h1")).toBeVisible();
  await retourArriere(page);
  // Le rechargement est posé sur la tâche SUIVANTE : on lui laisse le temps de rejouer le cycle.
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });

  const vu = await releveLeger(page);
  const apres = await releve(page);
  const restaure = vu.restaure;
  await attacher(info, "bfcache-coffre-ouvert", {
    moteur: moteurDe(info),
    fenetre: EN_FENETRE.includes(moteurDe(info)),
    evenements: vu.traces,
    restaure,
    chargements: vu.chargements,
    etatApresLeRetour: apres.etat,
    deverrouillageMs: apres.mesures.deverrouillageMs,
    notRestoredReasons: await raisonsDeNonRestauration(page),
  });

  // CE QUI EST EXIGÉ, restauration ou non : la coquille ne rend JAMAIS un coffre ouvert au retour.
  expect(apres.etat, "un coffre ouvert est revenu par le retour arrière").toBe(
    ETATS_DU_VOLUME.verrouille,
  );
  expect(apres.mesures.deverrouillageMs, "quelque chose a été dérivé sans geste").toBeNull();

  // ET, LÀ OÙ LE MOTEUR RESTAURE POUR DE BON : le chemin `pageshow` restauré → rechargement est
  // celui qui l'a produit, et il tient en DEUX chargements du document de la coquille.
  if (restaure) {
    expect(vu.chargements, "le rechargement a bouclé, ou n'a pas eu lieu").toBe(2);
  }
});

// --- (d) LA CONCLUSION, ÉCRITE D'AVANCE : la garantie n'est aucun de ces écouteurs ----------------
//
// Aucun événement de fin d'onglet n'est une garantie. La garantie est la NON-PERSISTANCE : la KEK et
// la DEK ne vivent que dans le tas d'un Worker, rien n'est écrit nulle part, et un verrouillage qui
// dépendrait d'un événement que le moteur peut ne pas livrer ne serait pas un verrouillage.
//
// Ce que ces deux épreuves mesurent est donc ce qui reste vrai QUOI QU'IL ARRIVE : un onglet fermé
// SANS aucun verrouillage, et un document NEUF du même profil qui lit `verrouille`, remonte son
// interface, ne dérive rien — pendant que la fouille des six stockages ne trouve ni la phrase, ni le
// code, ni son matériau.

test("un onglet FERMÉ sans verrouillage : ce que le document suivant lit, et ce que la fouille trouve", async ({
  context,
  browserName,
}, info) => {
  // UNE seule épreuve pour les deux moitiés, et c'est une décision de coût autant que de sens :
  // elles partagent le geste le plus cher de la suite — ouvrir un coffre pour de bon, Argon2id
  // compris — et la seconde n'a de sens que sur l'état que la première constate. Deux épreuves
  // auraient payé deux ouvertures pour mesurer la même fermeture.
  test.setTimeout(300_000);
  await poserLObservatoire(context);
  const premier = await context.newPage();
  await ouvrirLaCoquille(premier);
  const ouvert = await ouvrirLeCoffre(premier);
  if (!ouvert) {
    // WebKit n'ouvre rien : la ligne est DÉCLARÉE `indisponible`, jamais verte par vacuité. Ce qui
    // est mesuré ici demande un coffre OUVERT à fermer, et il n'y en a pas.
    await attacher(info, "fermeture-sans-verrouillage", {
      moteur: moteurDe(info),
      verdict: "indisponible",
      motif: "aucun volume ne s'ouvre sur ce moteur : il n'y a pas de coffre ouvert à fermer",
      etatLuParLeSecondDocument: (await releve(premier)).etat,
    });
    expect(browserName, "un moteur qui n'ouvre rien devrait être WebKit").toBe("webkit");
    return;
  }

  // Le second onglet est OUVERT AVANT la fermeture du premier, et c'est une précaution mesurée : sur
  // Firefox, un `newPage()` suivi d'une navigation juste après la fermeture d'un onglet qui tenait un
  // volume n'a pas rendu la main — la navigation n'atteignait même pas son `commit`. Ouvrir l'onglet
  // d'abord ne change rien à ce que l'épreuve mesure : ce qui compte est que sa NAVIGATION vers la
  // coquille vienne après la fermeture, et elle vient après.
  const second = await context.newPage();

  // AUCUN verrouillage : ni le bouton, ni le délai. L'onglet est fermé, et rien d'autre.
  await premier.close();

  // Un document NEUF, dans le MÊME contexte — donc le même profil, le même OPFS, les mêmes
  // stockages. C'est ce qu'un utilisateur obtient en rouvrant l'onglet qu'il vient de fermer, et
  // c'est aussi le point de vue de l'adversaire qui copie le profil.
  await ouvrirLaCoquille(second);
  const apres = await releve(second);
  const interfaceRemontee = (await second.locator("#deverrouillage-moyens").textContent()) ?? "";

  const morceaux = await sonder(second, APPAT);
  const releveDeLaSonde = morceaux.map(({ ou, texte }) => ({
    ou,
    caracteres: texte.length,
    porteLAppat: texte.includes(APPAT),
    portelaPhrase: texte.includes(PHRASE),
  }));
  await attacher(info, "fermeture-sans-verrouillage", {
    moteur: moteurDe(info),
    etatLuParLeSecondDocument: apres.etat,
    deverrouillageMs: apres.mesures.deverrouillageMs,
    verrouillage: apres.verrouillage,
    interfaceDeDeverrouillageRemontee: interfaceRemontee.length > 0,
    // L'AVEU voyage avec la mesure : elle dit ce qui n'est pas PERSISTÉ, pas ce qui est EFFACÉ d'un
    // tas. Elle ne peut rien dire de la mémoire d'un processus ni des octets d'une `CryptoKey`.
    ceQueLaSondeMesure: "les six stockages, l'OPFS en texte et en hexadécimal, et le DOM",
    ceQuElleNeMesurePas:
      "la mémoire du processus, le fichier d'échange, les octets d'une CryptoKey",
    sonde: releveDeLaSonde,
  });

  expect(apres.etat, "un coffre est resté ouvert après la fermeture de l'onglet").toBe(
    ETATS_DU_VOLUME.verrouille,
  );
  // Le document neuf n'a rien dérivé de lui-même : le prix se paie sur un geste, jamais sans.
  expect(apres.mesures.deverrouillageMs).toBeNull();
  expect(
    interfaceRemontee.length,
    "l'interface de déverrouillage n'est pas remontée",
  ).toBeGreaterThan(0);

  // TÉMOIN DE FOUILLE, ENSUITE. Sans lui, « rien trouvé » pourrait vouloir dire « rien capturé ».
  const trouves = releveDeLaSonde.filter(({ porteLAppat }) => porteLAppat).map(({ ou }) => ou);
  expect(trouves, "la sonde n'a retrouvé son appât nulle part : elle ne mesure rien").toContain(
    "localStorage",
  );
  expect(trouves).toContain("sessionStorage");
  expect(trouves).toContain("cookies");
  expect(trouves).toContain("opfs");

  // Et le VERDICT : la phrase n'est nulle part. Ce qui reste sur le support est le volume scellé et
  // ses noms de fichiers ; ce que la fermeture emporte est ce qui les OUVRE.
  const porteurs = releveDeLaSonde.filter(({ portelaPhrase }) => portelaPhrase).map(({ ou }) => ou);
  expect(porteurs, "la phrase de déverrouillage a été retrouvée sur l'appareil").toEqual([]);
});

// --- (e) LE TÉMOIN NÉGATIF : la coquille ne se recharge PAS toute seule ---------------------------

test("un `pageshow` NON restauré ne déclenche aucune boucle : la coquille se charge UNE fois", async ({
  context,
  page,
}, info) => {
  // C'est le mutant le plus coûteux de la campagne, et le seul dont l'effet se voie de l'extérieur :
  // un rechargement sur TOUT `pageshow` produirait un document qui se recharge à chaque chargement,
  // indéfiniment. Aucune autre épreuve de ce dépôt ne le verrait — elles attendent toutes un état
  // que la coquille finit par publier, et une coquille qui boucle le publie à chaque tour.
  //
  // Le compteur vit dans `sessionStorage` : c'est le seul stockage qui SURVIT à un rechargement dans
  // le même onglet et meurt avec lui. Il est posé par l'ÉPREUVE, jamais par le produit.
  await context.addInitScript(() => {
    // Le compteur ne compte QUE le document de la coquille. Mesuré : sur Firefox, un `about:blank`
    // créé en chemin — celui d'un cadre avant sa navigation — HÉRITE de l'origine de son parent,
    // donc de son `sessionStorage`, et un compteur naïf y ajoutait deux chargements qui n'en
    // étaient pas. Le filtre est la mesure, pas un contournement.
    if (!location.href.includes("/index.html")) return;
    try {
      const compte = Number(sessionStorage.getItem("fins-d-onglet-chargements") ?? "0");
      sessionStorage.setItem("fins-d-onglet-chargements", String(compte + 1));
    } catch {
      /* un stockage refusé n'est pas le sujet de cette épreuve */
    }
  });

  await ouvrirLaCoquille(page);
  await page.goto(AILLEURS);
  await expect(page.locator("h1")).toBeVisible();
  await page.goBack({ waitUntil: "commit" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });
  // Une boucle se verrait dans les secondes qui suivent : on lui en laisse trois.
  await page.waitForTimeout(3_000);

  const chargements = Number(
    await page.evaluate(() => sessionStorage.getItem("fins-d-onglet-chargements")),
  );
  await attacher(info, "aucune-boucle-de-rechargement", {
    moteur: moteurDe(info),
    // DEUX chargements ATTENDUS et pas un de plus : la coquille au départ, la coquille au retour.
    // La page d'à côté n'est pas la coquille et ne compte pas. Un troisième serait un rechargement
    // que personne n'a demandé.
    chargementsAttendus: 2,
    chargementsComptes: chargements,
  });

  expect(chargements, "la coquille s'est rechargée toute seule : `pageshow` boucle").toBe(2);
});

// --- (f) LE CHEMIN DE `pagehide`, OBSERVÉ dans un navigateur --------------------------------------
//
// Un `pagehide` RÉEL emporte le document : ce qu'il déclenche ne se lit plus depuis lui. Un
// `pagehide` SYNTHÉTIQUE, lui, parcourt exactement le même code — la garde, la terminaison, le
// désarmement, le journal, la publication — et laisse le document en vie pour qu'on le lise. Ce
// n'est pas un raccourci : c'est la seule façon d'observer ce chemin depuis l'intérieur, et
// l'événement est posé par l'ÉPREUVE, jamais par une poignée que le produit rendrait.

test("un `pagehide` sur un coffre OUVERT tue le Worker, et le relevé PUBLIÉ le dit", async ({
  context,
  page,
  browserName,
}, info) => {
  // Constat 4 de la revue de sécurité de la PR #177 : le rappel de journal poussait dans
  // `rapport.journal` sans appeler `publier()`. L'entrée existait donc dans un tableau que personne
  // ne relit — et pour `freeze`, dont « inscrire » est la SEULE action, elle n'aurait jamais été
  // observable. Le rappel publie désormais, synchrone, et cette épreuve le lit.
  test.setTimeout(300_000);
  await poserLObservatoire(context);
  await ouvrirLaCoquille(page);
  const ouvert = await ouvrirLeCoffre(page);
  if (!ouvert) {
    await attacher(info, "pagehide-observe", {
      moteur: moteurDe(info),
      verdict: "indisponible",
      motif: "aucun volume ne s'ouvre sur ce moteur : il n'y a pas de coffre ouvert à tuer",
    });
    expect(browserName).toBe("webkit");
    return;
  }

  await page.evaluate(() => {
    globalThis.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });

  const apres = await releve(page);
  const inscrites = apres.journal.filter((ligne) => ligne.startsWith("fin-d-onglet:"));
  await attacher(info, "pagehide-observe", {
    moteur: moteurDe(info),
    journal: inscrites,
    etatApres: apres.etat,
  });

  // LE CHEMIN ENTIER, lu dans le relevé que la coquille PUBLIE : la garde a laissé passer, le
  // Worker a été terminé, et l'inscription est lisible sans qu'aucun autre geste ait eu lieu.
  expect(inscrites, "aucune entrée `fin-d-onglet:` publiée dans le relevé").toContain(
    "fin-d-onglet:pagehide:tue",
  );
});

test("un `pagehide` PENDANT le déverrouillage tue aussi : l'état n'atteint JAMAIS `ouvert`", async ({
  context,
  page,
  browserName,
}, info) => {
  // C'EST LE CONSTAT 1, rejoué en navigateur. Le Worker reçoit la KEK au message de déverrouillage ;
  // l'état ne devient `ouvert` que bien après. Une garde qui lisait l'état publié laissait donc
  // vivre, pendant toute cette fenêtre, un Worker qui tenait déjà les clés — et le coffre finissait
  // de s'ouvrir APRÈS le départ du document.
  test.setTimeout(300_000);
  await poserLObservatoire(context);
  await ouvrirLaCoquille(page);
  const avant = (await releve(page)).etat;

  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
  // Le `pagehide` part SANS attendre : c'est la fenêtre qu'on mesure, et elle se referme vite.
  await page.evaluate(() => {
    globalThis.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: false }));
  });

  // On laisse tout le temps au déverrouillage d'aboutir, s'il le peut : c'est ce qu'on cherche à
  // exclure. Argon2id coûte jusqu'à deux secondes sur Firefox, l'ouverture du volume davantage.
  await page.waitForTimeout(15_000);
  const apres = await releve(page);
  await attacher(info, "pagehide-pendant-le-deverrouillage", {
    moteur: moteurDe(info),
    etatAvant: avant,
    etatApres: apres.etat,
    journal: apres.journal.filter((ligne) => ligne.startsWith("fin-d-onglet:")),
    workerMort: apres.workerMort,
  });

  expect(apres.etat, "le coffre a fini de s'ouvrir après le départ du document").not.toBe(
    ETATS_DU_VOLUME.ouvert,
  );
  expect(browserName === "webkit" || apres.journal.includes("fin-d-onglet:pagehide:tue")).toBe(
    true,
  );
});
