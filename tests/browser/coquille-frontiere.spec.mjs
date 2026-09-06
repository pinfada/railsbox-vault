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

import { expect, test } from "@playwright/test";

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
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { HARNAIS_CLE_JETON } from "../../src/vm/cle-de-volume.mjs";
import { APP_ORIGIN, SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

/** Chemin de la fixture, servi par les DEUX origines : c'est ce qui rend le témoin comparable. */
const FIXTURE = "/coquille-epreuve/hostile.html";

/** Ouvre la coquille de produit, déverrouillée par le harnais, et attend qu'elle soit prête. */
async function ouvrirLaCoquille(page, { documentApplicatif = null } = {}) {
  const url = new URL("/index.html", SHELL_ORIGIN);
  url.searchParams.set("deverrouillage-harnais", HARNAIS_CLE_JETON);
  if (documentApplicatif) url.searchParams.set("document-applicatif", documentApplicatif);
  await page.goto(url.toString());
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete");
  return relevéDeLaCoquille(page);
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
  // Et rien d'autre : la réponse ne porte que l'état et le compte de barrières.
  expect(Object.keys(rapport).sort()).toEqual(["barrieres", "etat", "portRecu", "refus"]);
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
  ];
  for (const [nom, code] of attendus) {
    expect(parNom[nom].resultat, `${nom} : ${parNom[nom].detail}`).toBe("refuse");
    expect(parNom[nom].code, nom).toBe(code);
  }
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
  const motifs = new Set(releve.annoncesRefusees.map(({ code }) => code));
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

// --- Le témoin positif, en MÊME origine ---------------------------------------------------------

test("témoin positif : la même fixture, servie par l'origine de confiance, obtient ce qu'on lui refuse", async ({
  page,
  context,
}, info) => {
  // La coquille est ouverte d'abord, sous le geste du harnais : c'est elle qui pose le volume et son
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
