// La FRONTIÈRE de la coquille de PRODUIT, mise à l'épreuve par une application malveillante
// (#161, tranche 1 de #24, ADR 0028).
//
// Ce que ces épreuves établissent, et que `tests/browser/origin-topology.spec.mjs` n'établit pas :
// le banc du spike #35 mesure quatre topologies sur une coquille « compétente, PAS durcie », qui
// plante des appâts et dont le secret est `SHELL_SECRET`. Ici, la coquille est celle du produit —
// `public/index.html`, `public/main.mjs`, `public/runtime-worker.mjs` —, les ports sont RÉELS, et
// le document encadré est une application malveillante servie par l'ORIGINE APPLICATIVE, comme le
// serait du JavaScript rendu par Rails.
//
// ## Le témoin positif, sans lequel un relevé tout vert ne prouve rien
//
// Il vient en DEUX moitiés, parce que les deux familles de tentatives ne se prouvent pas de la même
// façon :
//
//  - **le contrat** : la même fixture, sur le même port, obtient le geste ADMIS. Un port cassé
//    refuserait tout, y compris ce qu'il doit servir ;
//  - **la topologie** : la MÊME fixture, servie par l'origine de CONFIANCE, obtient ce qu'on lui
//    refuse depuis l'origine applicative — le volume et son enveloppe dans l'OPFS, la portée d'un
//    Service Worker, l'interception de la ressource témoin.
//
// Deux tentatives n'ont PAS de témoin positif contre cette coquille, et l'ADR 0028 le dit : le
// verrou nommé et la diffusion inter-onglets n'existent pas encore dans le produit. Leur témoin
// reste celui du spike, en topologie T1a — une des raisons pour lesquelles ce banc reste vivant.

import { expect, test } from "../support/test.mjs";

import {
  CLE_IDB_HOSTILE,
  BASE_IDB,
  MAGASIN_IDB,
  MARQUEUR_OPFS,
  NOMBRE_DE_SONDES,
  TEMOIN_AUTHENTIQUE,
  TEMOIN_CHEMIN,
  TEMOIN_INTERCEPTE,
} from "../../public/coquille-epreuve/marqueurs.mjs";
import { GESTES_REFUSES } from "../../src/coquille/admission-applicative.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "../../src/coquille/refus-de-coquille.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import {
  CLE_DE_TEST,
  HARNAIS_CLE_ENV,
  HARNAIS_CLE_JETON,
  HARNAIS_CLE_VALEUR,
  clesDeDeverrouillageDuHarnais,
} from "../../src/vm/cle-de-volume.mjs";
import { APP_ORIGIN, SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

/** Chemin de la fixture, servi par les DEUX origines : c'est ce qui rend le témoin comparable. */
const FIXTURE = "/coquille-epreuve/hostile.html";

/**
 * La PHRASE par laquelle ces épreuves ouvrent le volume de la coquille.
 *
 * #161 passait ici le jeton du harnais dans un paramètre d'URL ; #162 le retire (ADR 0029,
 * décision 1), et le déverrouillage emprunte le CHEMIN DE PRODUIT — on tape dans le champ, on
 * clique sur le bouton. C'est plus lent d'une dérivation Argon2id, et c'est le prix d'une suite qui
 * mesure ce que le produit fait plutôt qu'une porte que le produit n'a plus.
 *
 * Elle est PUBLIQUE et sans valeur : c'est un marqueur, pas un secret.
 */
const PHRASE = "marqueur-de-phrase-de-la-frontiere-161-cheval-batterie-agrafe-correcte";

/** Ouvre la coquille de produit, déverrouillée par une PHRASE, et attend qu'elle soit prête. */
async function ouvrirLaCoquille(page, { documentApplicatif = null, deverrouiller = true } = {}) {
  const url = new URL("/index.html", SHELL_ORIGIN);
  if (documentApplicatif) url.searchParams.set("document-applicatif", documentApplicatif);
  await page.goto(url.toString());
  // Le délai est EXPLICITE et large. Sous Firefox, et quand les quinze projets de frontière
  // tournent ensemble, les cinq secondes du défaut de Playwright mesureraient la charge de
  // l'exécutant plutôt que la coquille.
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: 60000 });
  if (deverrouiller) await deverrouillerParLaPhrase(page);
  return relevéDeLaCoquille(page);
}

/**
 * Déverrouille par le geste d'un utilisateur, et attend que l'état ait BOUGÉ.
 *
 * « Bougé » et non « ouvert » : sur un moteur sans OPFS synchrone dans un Worker (WebKit), l'état
 * devient `indisponible`, ce qui est la conduite juste et non un échec (ADR 0028). Ces épreuves-ci
 * mesurent une frontière d'ORIGINE, pas un déverrouillage ; ce qu'elles demandent au volume est
 * qu'il existe là où le moteur le permet.
 */
async function deverrouillerParLaPhrase(page) {
  await page.locator("#saisie-phrase").fill(PHRASE);
  await page.locator("#ouvrir-par-phrase").click();
  await expect
    .poll(async () => (await relevéDeLaCoquille(page)).etat, { timeout: 60000 })
    .not.toBe(ETATS_DU_VOLUME.verrouille);
}

async function relevéDeLaCoquille(page) {
  return JSON.parse(await page.locator("#coquille-rapport").textContent());
}

/** Attend la fin des sondes de la fixture et rend son relevé, indexé par nom. */
async function releverLaFixture(portee) {
  await expect(portee.locator("html")).toHaveAttribute("data-hostile", "sondes-terminees", {
    timeout: 60000,
  });
  const sondes = JSON.parse(await portee.locator("#hostile-rapport").textContent());
  return { sondes, parNom: Object.fromEntries(sondes.map((sonde) => [sonde.nom, sonde])) };
}

/** Lit, DEPUIS l'origine de la coquille, ce que la fixture a cru persister. */
function contaminationDeLaCoquille(page) {
  return page.evaluate(
    async (noms) => {
      const releve = {};
      try {
        const racine = await navigator.storage.getDirectory();
        const handle = await racine.getFileHandle(noms.opfs);
        releve.opfs = await (await handle.getFile()).text();
      } catch (error) {
        releve.opfs = `absent (${error?.name ?? "Error"})`;
      }
      try {
        releve.indexedDb = await new Promise((rendre, refuser) => {
          const requete = indexedDB.open(noms.base, 1);
          requete.onupgradeneeded = () => requete.result.createObjectStore(noms.magasin);
          requete.onerror = () => refuser(requete.error ?? new Error("ouverture refusée"));
          requete.onsuccess = () => {
            const lecture = requete.result
              .transaction(noms.magasin, "readonly")
              .objectStore(noms.magasin)
              .get(noms.cle);
            lecture.onsuccess = () => rendre(lecture.result ?? "absent");
            lecture.onerror = () => refuser(lecture.error ?? new Error("lecture refusée"));
          };
        });
      } catch (error) {
        releve.indexedDb = `absent (${error?.name ?? "Error"})`;
      }
      return releve;
    },
    { opfs: MARQUEUR_OPFS, base: BASE_IDB, magasin: MAGASIN_IDB, cle: CLE_IDB_HOSTILE },
  );
}

/** Lit la ressource témoin depuis un client NEUF : seul un client neuf traverse un SW fraîchement inscrit. */
async function lireLeTemoin(context, origine) {
  const victime = await context.newPage();
  await victime.goto(`${origine}${TEMOIN_CHEMIN}`);
  const servi = (await victime.locator("body").innerText()).trim();
  await victime.close();
  return servi;
}

// --- L'ordre du cycle de vie ----------------------------------------------------------------------

test("le canal privilégié est établi AVANT que le cadre applicatif existe", async ({ page }) => {
  const releve = await ouvrirLaCoquille(page);

  // Le journal est une SUITE observée, pas une affirmation. La garde qui la tient est
  // `evaluerAnnonce`, dont la première condition est l'existence du canal — et la campagne de
  // mutation de `tools/muter-gardes-coquille.mjs` montre qu'elle sait rougir.
  expect(releve.journal.indexOf("canal-privilegie-etabli")).toBe(0);
  expect(releve.journal.indexOf("cadre-applicatif-cree")).toBeGreaterThan(0);
  expect(releve.canalPrivilegie).toBe("etabli");
});

test("le document applicatif LOYAL obtient son port et l'état : la coquille SERT ce qu'elle admet", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  const cadre = page.frameLocator("#document-applicatif");
  await expect(cadre.locator("html")).toHaveAttribute("data-document-applicatif", "servi", {
    timeout: 30000,
  });
  const rapport = JSON.parse(await cadre.locator("#document-applicatif-rapport").textContent());
  expect(rapport.portRecu).toBe(true);
  expect(Object.values(ETATS_DU_VOLUME)).toContain(rapport.etat);
  // Et rien d'autre : de la coquille, le document n'a REÇU que l'état et le compte de barrières.
  // `portRecu`, `refus` et `questions` sont ce que le document sait de LUI-MÊME — un booléen, une
  // liste de codes qu'il a reçus, et depuis #163 le compte de ses propres questions, le geste-requête
  // étant devenu rejouable. Aucun des trois ne vient d'un message de la coquille.
  //
  // `coquilleDeCadre` est la sixième clé, depuis #192, et elle est de la même nature que les trois
  // précédentes : ce que le document sait de LUI-MÊME. Elle dit si la coquille de cadre s'est
  // installée, sous quel motif sinon, ce que son Service Worker est devenu, quel chemin il a
  // encadré, combien de requêtes il a relayées et ce qu'il attend. Aucun de ces six champs ne vient
  // d'un message de la coquille — et la liste qui suit est EXACTE, de sorte qu'un septième champ ne
  // puisse pas apparaître là sans qu'une revue l'ait lu.
  expect(Object.keys(rapport).sort()).toEqual([
    "barrieres",
    "coquilleDeCadre",
    "etat",
    "portRecu",
    "questions",
    "refus",
  ]);
  expect(Object.keys(rapport.coquilleDeCadre).sort()).toEqual([
    "attente",
    "cadreServi",
    "installee",
    "motif",
    "relayees",
    "serviceWorker",
  ]);
});

test("l'assemblage publie ce qu'il COÛTE : canal privilégié, puis cadre applicatif", async ({
  page,
}, info) => {
  // Une MESURE, pas une assertion de performance : rien ici ne rougit sur un seuil. L'ADR 0028
  // publie les trois relevés, et un seuil posé sur un exécutant partagé mesurerait la machine.
  const releve = await ouvrirLaCoquille(page);
  // « Prête » dit que le cadre est CRÉÉ ; sa mesure n'existe qu'une fois qu'il est CHARGÉ. Attendre
  // l'attribut plutôt que la clé : la clé est là dès le départ, avec la valeur `null`.
  await expect
    .poll(async () => (await relevéDeLaCoquille(page)).mesures.cadreApplicatifMs, {
      timeout: 30000,
    })
    .not.toBeNull();
  const apres = await relevéDeLaCoquille(page);
  await info.attach(`mesures-${info.project.name}.json`, {
    body: JSON.stringify({ moteur: info.project.name, ...apres.mesures }, null, 2),
    contentType: "application/json",
  });

  expect(releve.mesures.canalPrivilegieMs).toBeGreaterThanOrEqual(0);
  // L'ORDRE se lit aussi dans les mesures : le cadre ne peut pas être chargé avant que le canal
  // soit établi, puisqu'il n'est même pas créé avant.
  expect(apres.mesures.cadreApplicatifMs).toBeGreaterThanOrEqual(apres.mesures.canalPrivilegieMs);
});

// --- L'application malveillante --------------------------------------------------------------------

test("l'application malveillante reçoit un refus TYPÉ sur chacun des dix gestes interdits", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page, { documentApplicatif: FIXTURE });
  const { sondes, parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));
  await info.attach(`hostile-${info.project.name}.json`, {
    body: JSON.stringify(sondes, null, 2),
    contentType: "application/json",
  });

  // Relevé COMPLET : un relevé incomplet est un relevé faux.
  expect(sondes).toHaveLength(NOMBRE_DE_SONDES);

  // TÉMOIN POSITIF du contrat : la même fixture, sur le même port, obtient le geste admis.
  expect(parNom["obtention-port-restreint"].resultat).toBe("aboutit");
  expect(parNom["geste-admis-etat"].resultat).toBe("aboutit");

  for (const refuse of GESTES_REFUSES) {
    const sonde = parNom[`refus-${refuse.type.replace("vault.coquille.", "")}`];
    expect(sonde, `${refuse.geste} n'a pas de sonde`).toBeDefined();
    // « Un refus typé, jamais un silence » : les deux moitiés sont exigées séparément.
    expect(sonde.resultat, `${refuse.geste} : ${sonde.detail}`).toBe("refuse");
    expect(sonde.code, `${refuse.geste} n'a pas reçu SON code`).toBe(refuse.code);
  }
});

test("l'encodage du contrat est refusé strictement, et le canal privilégié n'est pas réclamable", async ({
  page,
}) => {
  await ouvrirLaCoquille(page, { documentApplicatif: FIXTURE });
  const { parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));

  const attendus = [
    ["type-privilegie-sur-port-restreint", CODES_REFUS_COQUILLE.portPrivilegie],
    ["message-non-objet", CODES_REFUS_COQUILLE.messageMalforme],
    ["contrat-etranger", CODES_REFUS_COQUILLE.contratRefuse],
    ["version-etrangere", CODES_REFUS_COQUILLE.contratRefuse],
    ["type-inconnu", CODES_REFUS_COQUILLE.typeInconnu],
    // Depuis la revue de la PR #166 : le décodage n'était strict que sur l'ENVELOPPE, et servait
    // une réponse à un message portant des champs qu'aucun contrat ne nomme. Un champ qu'on accepte
    // sans le lire est un champ que la version suivante lira par accident.
    ["champ-en-trop", CODES_REFUS_COQUILLE.messageMalforme],
    ["correlation-absente", CODES_REFUS_COQUILLE.correlationAbsente],
    ["correlation-dupliquee", CODES_REFUS_COQUILLE.correlationDupliquee],
    // Un transférable vers la coquille n'était ni employé, ni refusé. Un canal qu'on n'a pas décidé
    // d'ouvrir doit être fermé nommément.
    ["transferable-sur-le-port-restreint", CODES_REFUS_COQUILLE.capaciteDansUnMessage],
  ];
  for (const [nom, code] of attendus) {
    expect(parNom[nom].resultat, `${nom} : ${parNom[nom].detail}`).toBe("refuse");
    expect(parNom[nom].code, nom).toBe(code);
  }
});

test("sauvegarder, restaurer et révoquer sont REFUSÉS au document applicatif (#207)", async ({
  page,
}) => {
  // Les trois gestes du canal privilégié, posés sur le port restreint avec une corrélation valable.
  // Le refus est celui du canal privilégié, calculé sur le TYPE, et aucune archive n'aboutit.
  await ouvrirLaCoquille(page, { documentApplicatif: FIXTURE });
  const { sondes, parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));
  const portabilite = sondes.filter(({ nom }) => nom.startsWith("portabilite-"));
  expect(portabilite.map(({ nom }) => nom).sort()).toEqual([
    "portabilite-restaurer",
    "portabilite-revoquer-en-urgence",
    "portabilite-sauvegarder",
  ]);
  for (const sonde of portabilite) {
    expect(sonde.resultat, `${sonde.nom} : ${sonde.detail}`).toBe("refuse");
    expect(parNom[sonde.nom].code, sonde.nom).toBe(CODES_REFUS_COQUILLE.portPrivilegie);
  }
});

test("chaque requête admise reçoit SA réponse, même quand plusieurs sont en vol", async ({
  page,
}) => {
  // Constat 2 de la revue de la PR #166 : deux requêtes d'état postées coup sur coup rendaient une
  // seule réponse, l'autre restant MUETTE — sur le seul geste que la coquille admette, et alors que
  // « un refus typé, jamais un silence » est écrit quatre fois dans le dossier. La sonde poste
  // quatre requêtes SANS attendre et exige quatre réponses appariées par leur corrélation.
  await ouvrirLaCoquille(page, { documentApplicatif: FIXTURE });
  const { parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));
  expect(
    parNom["gestes-admis-concurrents"].resultat,
    parNom["gestes-admis-concurrents"].detail,
  ).toBe("aboutit");
  expect(parNom["gestes-admis-concurrents"].detail).toContain("4/4");
});

test("le jeton du harnais est PUBLIC, lisible d'ici, et ne sert à rien — nulle part", async ({
  page,
}) => {
  // Constat 1 de la revue de la PR #166. Le jeton du harnais est dans l'arbre publié : sans étape de
  // construction, une constante que le produit compare existe forcément dans le code servi. La
  // réponse n'est pas de la cacher — c'est de montrer que la connaître ne donne rien.
  //
  // Depuis #162 (ADR 0029, décision 1), elle ne donne rien même à qui atteindrait le canal
  // privilégié : AUCUN chemin de produit ne franchit plus la porte du harnais, et le type
  // `deverrouiller` ne connaît plus de jeton. Ce que la fixture mesure ici reste donc valable, et
  // l'affirmation qu'il porte s'est élargie plutôt que réduite.
  await ouvrirLaCoquille(page, { documentApplicatif: FIXTURE, deverrouiller: false });
  const { parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));

  // TÉMOIN POSITIF : la fixture a bien mis la main sur le jeton. Sans lui, les trois refus suivants
  // ne prouveraient rien — ils pourraient venir d'un jeton jamais lu.
  expect(parNom["lecture-du-jeton-du-harnais"].resultat).toBe("aboutit");
  // Et c'est bien LE jeton qu'elle a lu, à la longueur près : un témoin qui se contenterait de
  // « quelque chose a été lu » serait vert sur une chaîne vide, donc vert pour rien.
  expect(parNom["lecture-du-jeton-du-harnais"].detail).toBe(
    `jeton lu (${HARNAIS_CLE_JETON.length} caractères)`,
  );

  expect(parNom["jeton-du-harnais-sur-le-port-restreint"].resultat).toBe("refuse");
  expect(parNom["jeton-du-harnais-sur-le-port-restreint"].code).toBe(
    CODES_REFUS_COQUILLE.portPrivilegie,
  );
  expect(parNom["jeton-du-harnais-sur-window"].resultat).toBe("refuse");
  // `Referrer-Policy: no-referrer` (ADR 0022) : le document encadré ne sait même pas d'où il l'est,
  // donc où rejouer le jeton en paramètre. Ce n'est pas la frontière, c'est une porte de moins.
  expect(parNom["url-de-la-coquille-inconnue"].resultat).toBe("refuse");

  // Et le verdict qui compte : l'état de la coquille n'a pas bougé. Aucun geste n'a été fait dans
  // ce scénario ; rien de ce que la fixture a tenté ne l'a déverrouillée.
  const releve = await relevéDeLaCoquille(page);
  expect(
    Object.keys(releve),
    "le relevé ne doit plus porter le témoin d'un déverrouillage par harnais",
  ).not.toContain("deverrouillageParHarnais");
  // « pas ouvert », et non « verrouillé » : sur un moteur sans OPFS synchrone dans un Worker, la
  // première question d'état rend `indisponible` — l'absence est un ÉTAT, pas un échec de geste
  // (ADR 0028). Exiger `verrouille` ferait rougir WebKit sur sa conduite juste.
  expect(releve.etat).not.toBe(ETATS_DU_VOLUME.ouvert);
});

test("mille messages hostiles ne font pas enfler le relevé de la coquille", async ({ page }) => {
  // Constat 3 de la revue de la PR #166 : quarante messages dont le seul champ `type` faisait
  // 200 000 caractères faisaient passer `#coquille-rapport` de 606 à 8 003 678 caractères. Le
  // relevé recopiait les octets du guest et se re-sérialisait entier à chaque refus.
  await ouvrirLaCoquille(page, { documentApplicatif: FIXTURE });
  // Attendre la fin des sondes AVANT de chercher le cadre : sur Firefox et WebKit, le document
  // encadré n'est pas encore chargé quand la coquille se dit prête, et `page.frames()` ne le
  // connaît donc pas. Chercher trop tôt mesurerait la vitesse du moteur.
  await expect(page.frameLocator("#document-applicatif").locator("html")).toHaveAttribute(
    "data-hostile",
    "sondes-terminees",
    { timeout: 60000 },
  );
  const cadre = page.frames().find((frame) => frame.url().startsWith(APP_ORIGIN));
  const avant = await relevéDeLaCoquille(page);
  const tailleAvant = (await page.locator("#coquille-rapport").textContent()).length;

  const ENVOYES = 1000;
  await cadre.evaluate((combien) => {
    const port = globalThis.__portHostile;
    for (let index = 0; index < combien; index += 1) {
      port.postMessage({
        contrat: "railsbox-vault-coquille",
        version: 1,
        type: "x".repeat(200000),
      });
    }
  }, ENVOYES);

  // Attendre que la coquille ait TOUT traité, plutôt que dormir : les moteurs ne drainent pas leur
  // file à la même vitesse, et un délai fixe mesurerait le plus lent des trois.
  await expect
    .poll(async () => (await relevéDeLaCoquille(page)).requetesRefusees, { timeout: 30000 })
    .toBeGreaterThanOrEqual(avant.requetesRefusees + ENVOYES);

  const tailleApres = (await page.locator("#coquille-rapport").textContent()).length;
  const apres = await relevéDeLaCoquille(page);

  // Les mille messages sont COMPTÉS — et rien d'eux n'est retenu : le relevé ne grandit pas. Deux
  // cents millions de caractères sont entrés dans la coquille ; elle en a gardé un entier par code.
  expect(apres.refusDeRequete[CODES_REFUS_COQUILLE.messageMalforme]).toBeGreaterThanOrEqual(
    ENVOYES,
  );
  // DEUX bornes, et elles ne disent pas la même chose. Le PLAFOND dit que le relevé a une taille
  // maximale connue à l'écriture : ses champs sont un ensemble CLOS, et aucune donnée du guest n'y
  // entre. Il est passé de 2 048 à 4 096 caractères avec #163, qui ajoute au relevé le journal des
  // huit étapes, les capacités mesurées et le constat d'exclusivité — des champs bornés, écrits par
  // la coquille et jamais par ce qu'elle reçoit. La borne du DELTA, elle, est celle qui mesure la
  // propriété : deux cents millions de caractères sont entrés, et le relevé n'a pas bougé de deux
  // cents. C'est elle qui rougirait si une recopie revenait.
  expect(tailleApres).toBeLessThan(4096);
  expect(tailleApres - tailleAvant).toBeLessThan(200);
});

test("un second port et une iframe imbriquée usurpatrice sont refusés", async ({ page }) => {
  await ouvrirLaCoquille(page, { documentApplicatif: FIXTURE });
  const { parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));
  expect(parNom["second-port-reclame"].resultat).toBe("refuse");
  expect(parNom["usurpation-iframe-imbriquee"].resultat).toBe("refuse");

  // Le relevé de la coquille est lu APRÈS les sondes, jamais avant : « prête » dit que la coquille
  // a créé le cadre, pas que le document encadré a fini de s'annoncer. Le lire trop tôt mesurerait
  // la vitesse du moteur — Firefox et WebKit y sont plus lents que Chromium — au lieu de la garde.
  const releve = await relevéDeLaCoquille(page);
  expect(releve.portOctroye).toBe(true);
  const motifs = new Set(Object.keys(releve.refusDAnnonce));
  expect(motifs.has(CODES_REFUS_COQUILLE.annonceUnique)).toBe(true);
  // Un seul port a été octroyé, quoi qu'il ait été tenté.
  expect(releve.journal.filter((etape) => etape === "port-restreint-octroye")).toHaveLength(1);
});

test("aucune tentative de topologie n'aboutit depuis l'origine applicative", async ({
  page,
  context,
}) => {
  await ouvrirLaCoquille(page, { documentApplicatif: FIXTURE });
  const { parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));

  for (const nom of [
    "acces-dom-coquille",
    "lecture-volume-opfs-coquille",
    "lecture-enveloppe-opfs-coquille",
    "observation-verrous-web",
    "ecoute-canal-diffusion",
    "navigation-du-sommet",
    "ouverture-fenetre-auxiliaire",
  ]) {
    expect(parNom[nom].resultat, `${nom} : ${parNom[nom].detail}`).not.toBe("aboutit");
  }

  // Ce que la fixture a cru persister est arrivé dans SA partition. Le verdict se rend de l'autre
  // côté : la fixture ne sait pas de quel OPFS elle parle, la coquille le sait.
  const contamination = await contaminationDeLaCoquille(page);
  expect(contamination.opfs).toMatch(/^absent/);
  expect(contamination.indexedDb).toBe("absent");

  // Et la ressource témoin de l'origine de confiance reste servie par le serveur.
  expect(await lireLeTemoin(context, SHELL_ORIGIN)).toBe(TEMOIN_AUTHENTIQUE);
});

test("le trafic du port est FOUILLÉ : aucun octet de clé ne le franchit, dans aucun sens", async ({
  page,
}, info) => {
  // Constat 5 de la revue de la PR #166 : `sansCapacite` refuse des CONSTRUCTEURS, pas des secrets
  // — il laisserait passer une clé rendue en hexadécimal, qui est une donnée. La garantie « aucune
  // clé ne franchit le port » ne vaut donc que si quelqu'un FOUILLE le trafic, comme
  // `deverrouillage-frontiere.spec.mjs` le fait depuis #22. La fixture enregistre tout ce qui passe,
  // dans les deux sens ; l'épreuve cherche dedans.
  await ouvrirLaCoquille(page, { documentApplicatif: FIXTURE, deverrouiller: true });
  const cadre = page.frameLocator("#document-applicatif");
  await releverLaFixture(cadre);
  const journal = JSON.parse(await cadre.locator("#hostile-journal").textContent());
  const trafic = journal.join("\n");
  await info.attach(`journal-du-port-${info.project.name}.json`, {
    body: JSON.stringify(journal, null, 2),
    contentType: "application/json",
  });

  // TÉMOIN DE FOUILLE. Sans lui, « rien trouvé » pourrait vouloir dire « rien capturé » : la
  // recherche doit d'abord montrer qu'elle sait trouver ce qui EST là.
  expect(trafic).toContain("vault.coquille.etat-reponse");
  expect(trafic.length).toBeGreaterThan(200);

  // Les octets RÉELS que le Worker de confiance détient : la clé de volume de TEST du harnais, et
  // les trois clés de déverrouillage. Ce sont ceux-là qu'un adversaire chercherait.
  // La garde du harnais se présente autrement sous Node que dans un Worker : ici, c'est la variable
  // d'environnement du processus, et l'épreuve la pose pour elle-même. C'est la porte documentée par
  // `src/vm/cle-de-volume.mjs`, franchie par une épreuve — le seul contexte qui en ait le droit.
  process.env[HARNAIS_CLE_ENV] = HARNAIS_CLE_VALEUR;
  const cles = clesDeDeverrouillageDuHarnais();
  const aChercher = [CLE_DE_TEST, cles.initiale, cles.rotation, cles.tierce];
  for (const octets of aChercher) {
    const hexadecimal = [...octets].map((octet) => octet.toString(16).padStart(2, "0")).join("");
    expect(trafic).not.toContain(hexadecimal);
    // Et la même chose en base 64 : une clé recodée reste une clé.
    expect(trafic).not.toContain(Buffer.from(octets).toString("base64"));
  }
});

// --- Le témoin positif, en MÊME origine ---------------------------------------------------------

test("témoin positif : la même fixture, servie par l'origine de confiance, obtient ce qu'on lui refuse", async ({
  page,
  context,
}, info) => {
  // La coquille est ouverte d'abord, sous une PHRASE : c'est elle qui pose le volume et son
  // enveloppe dans l'OPFS de l'origine de confiance. Sans cela, « fichier absent » de l'autre côté
  // ne dirait rien — il n'y aurait rien à trouver nulle part.
  const avant = await ouvrirLaCoquille(page);
  const volumeOuvert = avant.etat === ETATS_DU_VOLUME.ouvert;

  await page.goto(`${SHELL_ORIGIN}${FIXTURE}`);
  const { sondes, parNom } = await releverLaFixture(page);
  await info.attach(`temoin-${info.project.name}.json`, {
    body: JSON.stringify({ etatDeLaCoquille: avant.etat, sondes }, null, 2),
    contentType: "application/json",
  });

  // Le DOM et la fenêtre auxiliaire aboutissent : les sondes ne sont pas cassées.
  expect(parNom["acces-dom-coquille"].resultat).toBe("aboutit");
  expect(parNom["ouverture-fenetre-auxiliaire"].resultat).toBe("aboutit");

  // Le volume et son ENVELOPPE — la clé qui l'ouvre — sont lisibles en même origine. C'est le
  // témoin qui donne son sens au refus mesuré depuis l'origine applicative.
  if (volumeOuvert) {
    expect(parNom["lecture-volume-opfs-coquille"].resultat).toBe("aboutit");
    expect(parNom["lecture-enveloppe-opfs-coquille"].resultat).toBe("aboutit");
  } else {
    // Une capacité ABSENTE du moteur n'est pas une frontière : le relevé le dit au lieu de le taire.
    expect(avant.etat).toBe(ETATS_DU_VOLUME.indisponible);
  }

  // Ce que la fixture persiste atterrit cette fois DANS la partition de la coquille.
  const contamination = await contaminationDeLaCoquille(page);
  expect(contamination.indexedDb).toBe("empreinte-application-malveillante");

  // Et son Service Worker répond à la place du serveur de confiance, sur sa portée.
  if (parNom["enregistrement-service-worker"].resultat === "aboutit") {
    expect(await lireLeTemoin(context, SHELL_ORIGIN)).toBe(TEMOIN_INTERCEPTE);
  }
});

test("témoin de sonde : sur SON origine, la fixture obtient bien une portée de Service Worker", async ({
  page,
}) => {
  // Sans ce témoin, « portée refusée » depuis l'origine applicative pourrait venir d'une sonde
  // cassée plutôt que d'une frontière. L'ADR 0002 accorde à l'application SA portée : la mesurer
  // ici dit que la sonde sait aboutir.
  await page.goto(`${APP_ORIGIN}${FIXTURE}`);
  const { parNom } = await releverLaFixture(page);
  expect(parNom["enregistrement-service-worker"].resultat).toBe("aboutit");
  expect(parNom["enregistrement-service-worker"].detail).toContain(APP_ORIGIN);
});

// --- Aucun cookie ---------------------------------------------------------------------------------

test("la coquille ne pose AUCUN cookie, sur aucune des deux origines", async ({
  page,
  context,
}) => {
  const reponses = [];
  page.on("response", (reponse) => reponses.push(reponse));

  await ouvrirLaCoquille(page, { documentApplicatif: FIXTURE });
  await releverLaFixture(page.frameLocator("#document-applicatif"));

  // 1. Le bocal du contexte, après un cycle complet : vide.
  expect(await context.cookies()).toEqual([]);

  // 2. `document.cookie`, des DEUX côtés de la frontière.
  expect(await page.evaluate(() => document.cookie)).toBe("");
  const cadre = page.frames().find((frame) => frame.url().startsWith(APP_ORIGIN));
  expect(await cadre.evaluate(() => document.cookie)).toBe("");

  // 3. La sonde RÉSEAU : aucune réponse servie ne porte `Set-Cookie`. Les deux premières mesures
  //    diraient « aucun cookie » même si un cookie `HttpOnly` avait été posé ; celle-ci ne le
  //    dirait pas.
  const avecCookie = [];
  for (const reponse of reponses) {
    const entetes = await reponse.allHeaders();
    if (entetes["set-cookie"]) avecCookie.push(reponse.url());
  }
  expect(avecCookie).toEqual([]);
});

// --- CSP et en-têtes sur les documents NEUFS ------------------------------------------------------

test("les documents NEUFS de la coquille portent la CSP et le durcissement, sans exemption", async ({
  request,
}) => {
  // #24 l'exige nommément : « `csp-frontiere` et `entetes-durcissement` doivent porter sur les
  // documents NEUFS de la coquille sans exemption ajoutée ». Les chemins sont ceux que la
  // publication sert.
  for (const chemin of [
    "/index.html",
    "/main.mjs",
    "/runtime-worker.mjs",
    "/src/coquille/contrat-de-messages.mjs",
    "/src/coquille/admission-applicative.mjs",
  ]) {
    const entetes = (await request.get(`${SHELL_ORIGIN}${chemin}`)).headers();
    expect(entetes["content-security-policy"], chemin).toContain("default-src 'none'");
    expect(entetes["content-security-policy"], chemin).toContain("frame-ancestors 'none'");
    expect(entetes["content-security-policy"], chemin).toContain(`frame-src 'self' ${APP_ORIGIN}`);
    expect(entetes["referrer-policy"], chemin).toBe("no-referrer");
    expect(entetes["permissions-policy"], chemin).toBe("camera=(), microphone=(), geolocation=()");
  }
});

// --- Les DIX REFUS, avant et après un verrouillage (#169, ADR 0031) --------------------------------
//
// « Le code ne dépend QUE du type reçu » est écrit au § 10.5 de la spécification et tenu par
// `evaluerRequete`, qui ne prend aucun état en argument (ADR 0028, décision 2). Cette épreuve le
// MESURE là où la question se pose vraiment : sur un coffre VERROUILLÉ, sur le même coffre OUVERT, et
// sur un coffre RE-VERROUILLÉ par le geste de #169. Une différence entre les trois relevés ferait de
// la liste de refus un ORACLE — un document applicatif apprendrait, sans y avoir droit, si un volume
// est ouvert.

/**
 * L'état qu'un coffre FERMÉ publie, et celui qu'un moteur sans OPFS synchrone publie à sa place.
 *
 * Les deux sont affirmés, jamais l'un au détriment de l'autre : `not.toBe(ouvert)` laisserait passer
 * les deux, et exiger `verrouille` partout ferait rougir WebKit sur sa conduite juste — `verrouille`
 * dit « il faut un geste », `indisponible` dit « ce moteur ne sait pas ». C'est la convention de
 * `coquille-deverrouillage.spec.mjs`, reprise ici parce que le verrouillage la rencontre.
 */
async function exigerLEtatFerme(page) {
  const etat = (await relevéDeLaCoquille(page)).etat;
  expect([ETATS_DU_VOLUME.verrouille, ETATS_DU_VOLUME.indisponible]).toContain(etat);
  return etat;
}

/**
 * VERROUILLE, puis attend que le RECHARGEMENT ait eu lieu — et le prouve par un document NEUF.
 *
 * L'attente ne peut pas porter sur ce que la page affiche : `#deverrouillage-moyens` est déjà rempli
 * par la session en cours, et `data-coquille` repasse par « prete » sur la même valeur qu'avant. Une
 * épreuve qui s'y fierait lirait le relevé de la session PRÉCÉDENTE et croirait mesurer la nouvelle.
 *
 * Ce qui distingue les deux documents est qu'un témoin posé dans le premier n'existe pas dans le
 * second. Il est posé par l'ÉPREUVE, sur `globalThis`, et le produit n'en sait rien.
 */
async function verrouillerEtAttendreLeRechargement(page) {
  await page.evaluate(() => {
    globalThis.__documentDAvantLeVerrouillage = true;
  });
  await page.locator("#verrouiller-le-coffre").click();
  await expect
    .poll(
      async () => {
        try {
          return await page.evaluate(() => globalThis.__documentDAvantLeVerrouillage === undefined);
        } catch {
          // Le contexte d'exécution est détruit pendant la navigation : c'est le rechargement en
          // cours, pas un défaut. La question se repose au tour suivant.
          return false;
        }
      },
      { timeout: 60000 },
    )
    .toBe(true);
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: 60000 });
}

/**
 * Tente les dix gestes interdits DEPUIS le cadre, et rend le code reçu pour chacun.
 *
 * L'attente de `sondes-terminees` n'est pas une précaution : la fixture obtient son port en
 * ANNONÇANT sa présence et en attendant l'octroi, ce qui est une suite d'allers-retours entre deux
 * origines. L'interroger avant qu'elle l'ait rendrait « le cadre n'a pas obtenu son port » — un
 * verdict sur la vitesse de l'exécutant, pas sur la frontière.
 */
async function dixRefusDepuisLeCadre(page, types) {
  await expect(page.frameLocator("#document-applicatif").locator("html")).toHaveAttribute(
    "data-hostile",
    "sondes-terminees",
    { timeout: 60000 },
  );
  // Le cadre est atteint par SON ÉLÉMENT, et non par une recherche d'URL dans la liste des frames :
  // la fixture crée elle-même une iframe IMBRIQUÉE pour sa sonde d'usurpation, et une recherche par
  // URL peut rendre celle-là — qui n'a jamais obtenu de port, et pour cause. L'épreuve mesurerait
  // alors l'usurpatrice en croyant mesurer l'application encadrée.
  const cadre = await (await page.locator("#document-applicatif").elementHandle()).contentFrame();
  expect(cadre, "le cadre hostile n'est pas là : rien à mesurer").not.toBeNull();
  return cadre.evaluate(async (listeDeTypes) => {
    const port = globalThis.__portHostile;
    if (!port) return { sansPort: true };
    const codes = {};
    for (const type of listeDeTypes) {
      codes[type] = await new Promise((rendre) => {
        const ecouteur = (evenement) => {
          if (evenement.data?.type !== "vault.coquille.refus") return;
          port.removeEventListener("message", ecouteur);
          // Le CODE **et** le MESSAGE : le § 10.5 dit « identiques », et deux refus qui
          // partageraient leur code en divergeant d'un mot seraient un oracle de plus, mesuré à
          // l'octet près plutôt qu'à la table (constat 10 de la revue de la PR #174).
          rendre(`${evenement.data.code}␟${evenement.data.message ?? ""}`);
        };
        port.addEventListener("message", ecouteur);
        port.postMessage({ contrat: "railsbox-vault-coquille", version: 1, type });
        setTimeout(() => {
          port.removeEventListener("message", ecouteur);
          rendre("silence");
        }, 5_000);
      });
    }
    return { codes };
  }, types);
}

test("les DIX refus sont identiques sur un coffre verrouillé, ouvert, puis verrouillé par le geste", async ({
  page,
}, info) => {
  const types = GESTES_REFUSES.map(({ type }) => type);
  // Le témoin de la mesure : chacun des dix rend SON code ET le message que la table lui donne.
  // Sans ce témoin, trois relevés de silences seraient « identiques » eux aussi.
  const attendus = Object.fromEntries(
    GESTES_REFUSES.map(({ type, code }) => [type, `${code}␟${messageDeRefus(code)}`]),
  );

  // (1) Coffre FERMÉ : rien n'a jamais été ouvert dans cette session. L'état est `verrouille`, ou
  // `indisponible` sur un moteur qui n'a jamais rien pu ouvrir — l'un dit « il faut un geste »,
  // l'autre « ce moteur ne sait pas », et la suite DÉCLARE lequel plutôt que d'exiger le premier.
  await ouvrirLaCoquille(page, { documentApplicatif: FIXTURE, deverrouiller: false });
  const etatFerme = await exigerLEtatFerme(page);
  const surVerrouille = await dixRefusDepuisLeCadre(page, types);
  expect(surVerrouille.sansPort, "le cadre n'a pas obtenu son port").toBeUndefined();

  // (2) Le MÊME coffre, OUVERT. Sur un moteur sans OPFS synchrone dans un Worker, l'état devient
  // `indisponible` et non `ouvert` : la mesure garde tout son sens — deux états différents doivent
  // rendre les mêmes dix codes —, et la suite le DÉCLARE plutôt que de passer au vert par vacuité.
  await deverrouillerParLaPhrase(page);
  const etatOuvert = (await relevéDeLaCoquille(page)).etat;
  const surOuvert = await dixRefusDepuisLeCadre(page, types);

  // (3) VERROUILLÉ par le geste de #169. La coquille se recharge, un cadre neuf reçoit un port neuf.
  await verrouillerEtAttendreLeRechargement(page);
  await expect
    .poll(async () => (await relevéDeLaCoquille(page)).cadreApplicatif, { timeout: 60000 })
    .toBe("charge");
  const etatApres = await exigerLEtatFerme(page);
  const surReVerrouille = await dixRefusDepuisLeCadre(page, types);

  await info.attach(`dix-refus-verrouillage-${info.project.name}.json`, {
    body: JSON.stringify(
      {
        etats: { avant: etatFerme, ouvert: etatOuvert, apres: etatApres },
        surVerrouille: surVerrouille.codes,
        surOuvert: surOuvert.codes,
        surReVerrouille: surReVerrouille.codes,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  // Chacun des dix rend SON code et SON message, et les mêmes dans les trois états.
  expect(surVerrouille.codes).toEqual(attendus);
  expect(surOuvert.codes).toEqual(attendus);
  expect(surReVerrouille.codes).toEqual(attendus);
  // Le coffre est revenu à son état FERMÉ, celui-là même d'où il était parti. Sur un moteur qui sait
  // ouvrir, c'est `verrouille` ; sur celui qui ne sait pas, c'est `indisponible` — et l'égalité avec
  // l'état de départ dit que le verrouillage n'a rien inventé.
  expect(etatApres, "le coffre n'est pas revenu à son état fermé après le geste").toBe(etatFerme);
});
