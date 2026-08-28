// Spike #46 — frontière entre deux applications Rails.
//
// Trois topologies sont mesurées côte à côte, et la première est le TÉMOIN NÉGATIF des deux
// autres :
//
//  · `meme-origine-prefixe-de-chemin` — les deux applications partagent l'origine applicative de
//    l'ADR 0002 et ne sont séparées que par un préfixe de chemin. Les lectures croisées doivent y
//    ABOUTIR. Si elles n'aboutissaient pas, les refus des topologies suivantes ne prouveraient
//    rien : ils pourraient venir de sondes cassées ;
//  · `origine-par-application` — chaque application a son origine, sur un hôte distinct. Aucune
//    lecture croisée ne doit y aboutir ;
//  · `origine-par-port` — deux origines qui ne diffèrent que par le port. Elle existe pour dire ce
//    que la voie la moins chère laisse passer : le port fait partie de l'origine, et pas du bocal
//    de cookies.
//
// Les trois moteurs de la matrice #2 sont exécutés, toujours : une frontière de sécurité ne
// s'applique pas de la même façon d'un moteur à l'autre, et la mesurer sur un seul publierait une
// garantie que les deux autres ne tiennent peut-être pas.

import { expect, test } from "@playwright/test";

import {
  ACTIFS_A,
  CANARY_NOM,
  CHEMIN_APP_A,
  CHEMIN_APP_B,
  ORIGINE_APPLICATIVE,
  ORIGINE_APPLICATIVE_B,
  SECRET_A,
  TOPOLOGIES_APPS,
  urlApplication,
} from "../../public/spike/origin/apps-topologie.mjs";
import { APP_ORIGIN, SHELL_ORIGIN, SHELL_PATH } from "../../src/spike/origin-topology.mjs";

/** Nombre de sondes exécutées par l'application B : un relevé incomplet est un relevé faux. */
const NOMBRE_DE_SONDES = 17;

/**
 * Ce que chaque sonde doit rendre lorsque les deux applications PARTAGENT l'origine.
 *
 * Les trois `invisible` ne sont pas des frontières d'application : ce sont les seuls endroits où
 * le navigateur borne quelque chose par CHEMIN, et l'ADR 0018 doit dire précisément ce qu'ils
 * couvrent — et ce qu'ils ne couvrent pas.
 */
const ATTENDU_MEME_ORIGINE = Object.freeze({
  "opfs-fichier-de-a": "lu",
  "opfs-repertoire-prefixe-de-a": "lu",
  "opfs-destruction-des-donnees-de-a": "lu",
  "indexeddb-base-de-a": "lu",
  "indexeddb-enumeration": "lu",
  "localstorage-de-a": "lu",
  "cookie-global-de-a": "lu",
  // L'attribut `Path` retient bien le cookie hors du répertoire de B…
  "cookie-de-chemin-de-a": "invisible",
  // …et un simple cadre de MÊME ORIGINE ouvert sur le répertoire de A le rend de nouveau lisible.
  "cookie-de-chemin-par-cadre-imbrique": "lu",
  "verrou-de-a": "lu",
  "diffusion-de-a": "lu",
  "cache-storage-enumeration": "lu",
  "cache-storage-lecture-de-a": "lu",
  "service-worker-enumeration-de-a": "lu",
  // La portée d'un Service Worker est bornée par le répertoire de SON script : B ne peut pas
  // inscrire le sien sur la portée de A. C'est le seul refus par chemin que le navigateur oppose.
  "service-worker-portee-de-a-reclamee": "invisible",
  // Un document de B n'est contrôlé par aucun Service Worker de A : ses requêtes ne sont pas
  // interceptées, même vers une URL de la portée de A.
  "canary-de-a-intercepte": "invisible",
  // Mais l'INSCRIPTION, elle, appartient à l'origine : B la retire.
  "service-worker-desinscription-de-a": "lu",
});

function joindre(info, nom, valeur) {
  return info.attach(`${nom}-${info.project.name}.json`, {
    body: JSON.stringify(valeur, null, 2),
    contentType: "application/json",
  });
}

/**
 * Ouvre l'application A, lui fait déposer un actif par mécanisme, et laisse sa page OUVERTE :
 * un verrou Web Locks se relâche avec le contexte qui le tient, et une diffusion n'existe que
 * pendant qu'elle est émise. La page est rendue à l'appelant, qui la ferme après la mesure.
 */
async function poserApplicationA(context, topologieId) {
  const page = await context.newPage();
  await page.goto(urlApplication(topologieId, "a", { phase: "poser" }));
  await expect(page.locator("html")).toHaveAttribute("data-app-state", "actifs-deposes", {
    timeout: 20000,
  });
  const depots = JSON.parse(await page.locator("#rapport").textContent());
  return { page, depots };
}

/** Ouvre l'application B et relève ce qu'elle voit de A. */
async function lireDepuisApplicationB(context, topologieId) {
  const page = await context.newPage();
  await page.goto(
    urlApplication(topologieId, "b", {
      phase: "lire",
      origineA: TOPOLOGIES_APPS[topologieId].origineA,
    }),
  );
  await expect(page.locator("#etat")).toHaveText(/sondes-terminees/, { timeout: 30000 });
  const sondes = JSON.parse(await page.locator("#rapport").textContent());
  await page.close();
  return sondes;
}

/** Contenu réellement servi pour une URL, lu depuis un client NEUF. */
async function servi(context, url) {
  const page = await context.newPage();
  await page.goto(url);
  const texte = (await page.locator("body").innerText()).trim();
  await page.close();
  return texte;
}

function parNom(sondes) {
  return Object.fromEntries(sondes.map((sonde) => [sonde.nom, sonde]));
}

/**
 * Compare un relevé à une table d'attentes en laissant passer `indisponible`.
 *
 * Une capacité absente du moteur n'est pas une frontière ; c'est un trou dans la mesure, et il
 * doit se voir comme tel plutôt que d'être compté comme un refus. Les écarts sont rendus, jamais
 * avalés.
 */
function ecarts(sondes, attendu) {
  return sondes
    .filter((sonde) => sonde.resultat !== "indisponible")
    .filter((sonde) => sonde.resultat !== attendu[sonde.nom])
    .map(
      (sonde) =>
        `${sonde.nom} : ${sonde.resultat} au lieu de ${attendu[sonde.nom]} — ${sonde.detail}`,
    );
}

test("le contrat du spike #46 déclare la MÊME origine applicative que l'ADR 0002", () => {
  // Les deux contrats vivent dans deux modules — `src/spike/origin-topology.mjs` n'est pas
  // importable par un document servi ET par Node avec la même spécification. Cette épreuve est ce
  // qui les empêche de diverger en silence.
  expect(ORIGINE_APPLICATIVE).toBe(APP_ORIGIN);
  expect(ORIGINE_APPLICATIVE_B).not.toBe(APP_ORIGIN);
});

test("témoin négatif : sur une même origine, un préfixe de chemin n'isole rien", async ({
  context,
}, info) => {
  const topologie = "meme-origine-prefixe-de-chemin";
  const { page: pageA, depots } = await poserApplicationA(context, topologie);
  await joindre(info, "depots-application-a-meme-origine", depots);

  // Le Service Worker de A intercepte SA ressource témoin, et seulement elle : la portée est le
  // répertoire de son script. C'est mesuré AVANT que B ne retire l'inscription.
  const temoinA = await servi(context, `${ORIGINE_APPLICATIVE}${CHEMIN_APP_A}${CANARY_NOM}`);
  const temoinB = await servi(context, `${ORIGINE_APPLICATIVE}${CHEMIN_APP_B}${CANARY_NOM}`);

  const sondes = await lireDepuisApplicationB(context, topologie);
  await pageA.close();
  await joindre(info, "sondes-meme-origine", { temoinA, temoinB, sondes });

  expect(sondes).toHaveLength(NOMBRE_DE_SONDES);
  expect(depots.opfs === "depose" || depots.opfs.startsWith("indisponible")).toBe(true);
  expect(depots.localStorage).toBe("depose");
  expect(ecarts(sondes, ATTENDU_MEME_ORIGINE)).toEqual([]);

  // Le témoin doit être POSITIF : si rien n'était lu, les refus de la topologie suivante ne
  // prouveraient rien. Au moins huit mécanismes traversent, moteurs les plus pauvres compris.
  expect(sondes.filter((sonde) => sonde.resultat === "lu").length).toBeGreaterThanOrEqual(8);

  // Le contenu lu est bien celui de A, pas une chaîne vide qui ressemblerait à un succès.
  const index = parNom(sondes);
  expect(index["localstorage-de-a"].detail).toContain(SECRET_A);
  expect(index["cookie-global-de-a"].detail).toContain(ACTIFS_A.cookieGlobal);

  // La portée du Service Worker, elle, EST bornée par le chemin : c'est le seul mécanisme du
  // navigateur qui le soit, et l'ADR 0018 ne doit pas le confondre avec une isolation.
  expect(temoinA).toContain("intercepte-par-app-a");
  expect(temoinB).toBe("canary-authentique");
});

test("une origine par application : aucune lecture croisée n'aboutit", async ({
  context,
}, info) => {
  const topologie = "origine-par-application";
  const { page: pageA, depots } = await poserApplicationA(context, topologie);
  await joindre(info, "depots-application-a-origines-distinctes", depots);

  const sondes = await lireDepuisApplicationB(context, topologie);
  await pageA.close();
  await joindre(info, "sondes-origines-distinctes", sondes);

  expect(sondes).toHaveLength(NOMBRE_DE_SONDES);
  // Le dépôt a bien eu lieu : sans cette vérification, « rien n'est lu » se confondrait avec
  // « rien n'avait été écrit ».
  expect(depots.localStorage).toBe("depose");

  const abouties = sondes.filter((sonde) => sonde.resultat === "lu");
  expect(abouties.map((sonde) => `${sonde.nom} — ${sonde.detail}`)).toEqual([]);
});

test("deux origines qui ne diffèrent que par le port partagent leurs cookies", async ({
  context,
}, info) => {
  // Le port fait partie de l'origine et ne fait PAS partie du bocal de cookies. Une « origine par
  // application » obtenue par le port seul isolerait donc tout SAUF les cookies — c'est-à-dire
  // tout sauf la session Rails. La mesure existe pour que personne n'ait à le croire sur parole.
  const topologie = "origine-par-port";
  const { page: pageA, depots } = await poserApplicationA(context, topologie);
  const sondes = await lireDepuisApplicationB(context, topologie);
  await pageA.close();
  await joindre(info, "sondes-port-different", { depots, sondes });

  expect(sondes).toHaveLength(NOMBRE_DE_SONDES);
  expect(depots.localStorage).toBe("depose");

  const index = parNom(sondes);
  expect(index["cookie-global-de-a"].resultat).toBe("lu");
  expect(index["cookie-global-de-a"].detail).toContain(SECRET_A);

  const abouties = sondes
    .filter((sonde) => sonde.resultat === "lu")
    .map((sonde) => sonde.nom)
    .sort();
  expect(abouties).toEqual(["cookie-global-de-a"]);
});

// --- Ce que la coquille distingue, et ce qu'elle ne distingue pas ------------------------------

/** Encadre un document applicatif donné dans la coquille du spike #35 et relève les deux rapports. */
async function encadrer(page, documentApplicatif) {
  const url = new URL(SHELL_PATH, SHELL_ORIGIN);
  url.searchParams.set("topologie", "T2-origine-distincte-sandbox");
  url.searchParams.set("documentApplicatif", documentApplicatif);
  await page.goto(url.toString());
  await expect(page.locator("html")).toHaveAttribute("data-shell-state", "prete");
  const cadre = page.frameLocator("#app-frame");
  await expect(cadre.locator("#etat")).toHaveText(/port-(obtenu|refuse)/, { timeout: 20000 });
  return {
    application: JSON.parse(await cadre.locator("#rapport").textContent()),
    coquille: JSON.parse(await page.locator("#shell-report").textContent()),
  };
}

test("la coquille accorde le même port restreint à A et à B : elle ne les distingue pas", async ({
  page,
}, info) => {
  const a = await encadrer(
    page,
    urlApplication("meme-origine-prefixe-de-chemin", "a", {
      phase: "annonce",
    }),
  );
  const b = await encadrer(
    page,
    urlApplication("meme-origine-prefixe-de-chemin", "b", {
      phase: "annonce",
    }),
  );
  await joindre(info, "admission-coquille", { a, b });

  expect(a.application.portRestreintObtenu).toBe(true);
  expect(b.application.portRestreintObtenu).toBe(true);
  expect(a.coquille.portEmis).toBe(true);
  expect(b.coquille.portEmis).toBe(true);

  // Les deux annonces portent la MÊME origine : c'est le seul critère d'identité dont la coquille
  // dispose, et il ne sépare pas deux applications d'une même origine applicative.
  expect(a.application.origine).toBe(b.application.origine);
  expect(a.coquille.origineAttendue).toBe(b.coquille.origineAttendue);
  expect(a.coquille.annoncesRefusees).toEqual([]);
  expect(b.coquille.annoncesRefusees).toEqual([]);
});
