// Les REFUS TYPÉS du portail de la réserve (#299, ADR 0048 §§ 7 et 13) sur l'arbre PUBLIÉ, trois moteurs :
// entrée altérée, supprimée, SW absent, API absente, SW muet, version périmée, retrait, changement de
// contrôleur — chacun avec son CODE typé, et **zéro Worker, zéro clé, zéro requête de boot** (critères 3, 5
// et 13c ; l'image n'est pas servie ici : le boot Rails est dans `tests/e2e/hors-ligne.spec.mjs`).

import { expect, test } from "@playwright/test";

import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import {
  Origine,
  attendreLaCoquille,
  attendreLeTelechargementAnticipe,
  fabriquerGeneration,
  jusqua,
  lireLeReleve,
  ouvrirUnNavigateur,
  portDe,
  visiter,
} from "./support-reserve.mjs";

/** Un fichier que SEUL le Worker de confiance importe : l'altérer ne casse pas la page, le portail le voit. */
const FICHIER_DU_WORKER = "/battement-du-worker.mjs";
const ESTIMATION_BOOT = (requete) =>
  requete.chemin.startsWith("/artifacts/") || /v86-[0-9a-f]{16}\.wasm$/.test(requete.chemin);

let origine;
let navigateur;
test.beforeEach(async ({ browserName }) => {
  origine = new Origine({ port: portDe(browserName, 1) });
  origine.publier(fabriquerGeneration({ sequence: 1 }));
  await origine.demarrer();
});
test.afterEach(async () => {
  await navigateur?.fermer();
  navigateur = null;
  await origine.arreter();
});

/** Ce qu'un refus doit montrer : état, code, cause, aucun Worker, aucun canal, aucune requête de boot. */
async function exigerLeRefus(page, code, cause) {
  const releve = await attendreLaCoquille(page);
  expect(releve.coquille).toBe("reserve-refusee");
  expect(releve.rapport.reserve.refus).toEqual({ code, cause });
  expect(releve.refus, "le bandeau dit le refus en langage humain").toBe(code);
  expect(releve.workers, "zéro Worker").toBe(0);
  expect(releve.rapport.canalPrivilegie, "zéro canal, zéro clé").toBe("absent");
  expect(origine.requetes(ESTIMATION_BOOT), "zéro requête de boot").toEqual([]);
}

/** Installe v1, puis rend une page NEUVE (la première visite a rechargé). */
async function installer(nomDuMoteur, options) {
  navigateur = await ouvrirUnNavigateur(nomDuMoteur, options);
  const page = await navigateur.page();
  const releve = await visiter(page, origine);
  expect(releve.rapport.reserve.refus).toBeNull();
  // Le TÉLÉCHARGEMENT ANTICIPÉ de cette visite réussie (#348) lit le descripteur : ses requêtes
  // appartiennent à l'installation, pas au refus que l'épreuve mesure ensuite. Il est attendu jusqu'à
  // son bilan, puis le journal de l'origine repart de zéro.
  await attendreLeTelechargementAnticipe(page);
  origine.vider();
  return page;
}

const abimer = (page, chemin, operation) =>
  page.evaluate(
    async ([cheminAbime, genre]) => {
      const nom = (await caches.keys()).find((candidat) => candidat.startsWith("reserve-"));
      const cache = await caches.open(nom);
      const cle = new Request(new URL(cheminAbime, location.origin));
      if (genre === "supprimer") return cache.delete(cle);
      const octets = new Uint8Array(await (await cache.match(cle)).arrayBuffer());
      octets[octets.length - 2] ^= 0xff; // même taille : seule l'empreinte voit l'écart
      return cache.put(cle, new Response(octets));
    },
    [chemin, operation],
  );

test("ENTRÉE ALTÉRÉE, hors connexion : RESERVE_ALTEREE, aucun Worker ; en ligne : réparée, vérifiée, puis la coquille démarre", async ({
  browserName,
}) => {
  const page = await installer(browserName);
  await abimer(page, FICHIER_DU_WORKER, "alterer");
  await origine.arreter();
  const hors = await navigateur.page();
  await hors.goto(`${origine.origine}/index.html`).catch(() => {});
  await exigerLeRefus(hors, C.reserveAlteree, "entrees-alterees");
  await origine.demarrer();
  const en = await navigateur.page();
  origine.vider();
  const releve = await visiter(en, origine);
  expect(releve.rapport.reserve.refus, "en ligne, `reparer` refait l'entrée abîmée").toBeNull();
  expect(origine.requetes((r) => r.chemin === FICHIER_DU_WORKER).length).toBe(1);
  const intact = await en.evaluate(
    async (chemin) => (await fetch(chemin)).status,
    FICHIER_DU_WORKER,
  );
  expect(intact).toBe(200);
});

test("ENTRÉE SUPPRIMÉE, hors connexion : RESERVE_INCOMPLETE, aucun Worker ; en ligne : refaite puis la coquille démarre", async ({
  browserName,
}) => {
  const page = await installer(browserName);
  await abimer(page, FICHIER_DU_WORKER, "supprimer");
  await origine.arreter();
  const hors = await navigateur.page();
  await hors.goto(`${origine.origine}/index.html`).catch(() => {});
  await exigerLeRefus(hors, C.reserveIncomplete, "entrees-manquantes");
  await origine.demarrer();
  const en = await navigateur.page();
  const releve = await visiter(en, origine);
  expect(releve.rapport.reserve.refus).toBeNull();
});

test("SW ABSENT (inscription refusée) : RESERVE_ABSENTE (installation-impossible), aucun Worker", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  await navigateur.contexte.addInitScript(() => {
    navigator.serviceWorker.register = () =>
      Promise.reject(new DOMException("refusé", "SecurityError"));
  });
  const page = await navigateur.page();
  await page.goto(`${origine.origine}/index.html`);
  await exigerLeRefus(page, C.reserveAbsente, "installation-impossible");
});

test("API ABSENTE (`navigator.serviceWorker` retiré) : RESERVE_ABSENTE (api-absente), sans Worker ni clé (critère 3)", async ({
  browserName,
}) => {
  navigateur = await ouvrirUnNavigateur(browserName);
  await navigateur.contexte.addInitScript(() => {
    delete Navigator.prototype.serviceWorker;
  });
  const page = await navigateur.page();
  await page.goto(`${origine.origine}/index.html`);
  await exigerLeRefus(page, C.reserveAbsente, "api-absente");
  expect(await page.evaluate(() => "serviceWorker" in navigator)).toBe(false);
});

test("SW MUET (il ne répond plus aux messages) : RESERVE_ABSENTE (silence-du-sw), aucun Worker", async ({
  browserName,
}) => {
  origine.publier(
    fabriquerGeneration({
      sequence: 1,
      transformerLeScript: (texte) =>
        texte.replace(
          'self.addEventListener("message", (evenement) => {',
          'self.addEventListener("message", (evenement) => {\n  return;',
        ),
    }),
  );
  const page = await installer(browserName).catch(async () => null);
  void page;
  const dernier = navigateur.contexte.pages().at(-1);
  await exigerLeRefus(dernier, C.reserveAbsente, "silence-du-sw");
});

test("VERSION PÉRIMÉE : une version en attente au plancher supérieur → RESERVE_PERIMEE (plancher), aucun Worker", async ({
  browserName,
}) => {
  const page = await installer(browserName);
  void page;
  origine.publier(
    fabriquerGeneration({ sequence: 2, plancher: 2, surcharges: { "/main.mjs": null } }),
  );
  const neuve = await navigateur.page();
  await neuve.goto(`${origine.origine}/index.html`);
  await exigerLeRefus(neuve, C.reservePerimee, "plancher");
});

test("RETRAIT : un script de retrait en attente → RESERVE_PERIMEE (retrait), aucun Worker", async ({
  browserName,
}) => {
  await installer(browserName);
  origine.publier(fabriquerGeneration({ sequence: 1, retrait: true }));
  const neuve = await navigateur.page();
  await neuve.goto(`${origine.origine}/index.html`);
  await exigerLeRefus(neuve, C.reservePerimee, "retrait");
});

test("CHANGEMENT DE CONTRÔLEUR pendant la session (un SW qui se serait donné `skipWaiting` et `claim`) : anomalie dite, session non interrompue", async ({
  browserName,
}) => {
  const page = await installer(browserName);
  const avant = await lireLeReleve(page);
  expect(avant.workers).toBeGreaterThanOrEqual(1);
  origine.publier(
    fabriquerGeneration({
      sequence: 2,
      transformerLeScript: (texte) =>
        texte
          .replace(
            "evenement.waitUntil(installer());",
            "evenement.waitUntil(installer().then(() => self.skipWaiting()));",
          )
          .replace(
            "evenement.waitUntil(CONFIG.retrait ? retirer() : nettoyer());",
            "evenement.waitUntil((CONFIG.retrait ? retirer() : nettoyer()).then(() => self.clients.claim()));",
          ),
    }),
  );
  await page.evaluate(async () => (await navigator.serviceWorker.getRegistration("/")).update());
  expect(
    await jusqua(async () => (await lireLeReleve(page)).refus === C.reserveDivergente, {
      delaiMs: 20_000,
    }),
  ).toBe(true);
  const apres = await lireLeReleve(page);
  expect(apres.rapport.reserve.refus).toEqual({
    code: C.reserveDivergente,
    cause: "controleur-change",
  });
  expect(
    apres.rapport.canalPrivilegie,
    "la session n'est pas interrompue : le canal reste établi",
  ).toBe(avant.rapport.canalPrivilegie);
});
