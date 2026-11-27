// LE CADRE NE PEUT RIEN ENVOYER HORS DE SON ORIGINE (#341, ADR 0052) — sur les TROIS moteurs.
//
// ## Le montage
//
// Une application HOSTILE (`public/coquille-epreuve/sorties-hostiles.mjs`) tente chaque voie de
// sortie connue vers une ORIGINE TIERCE que cette épreuve démarre elle-même et qui relève tout ce
// qu'elle reçoit. La preuve est ce que l'origine tierce a REÇU, jamais ce que la page croit avoir
// fait : un moteur qui fermerait une voie sans le dire la fermerait quand même, et un moteur qui en
// laisserait passer une en levant une violation l'aurait laissée passer.
//
// Deux montages, et chacun a son rôle :
//
//  - **le RELAIS** : une coquille simulée (`coquille-simulee.mjs`) octroie un port au VRAI courtier,
//    qui enregistre le VRAI Service Worker du cadre ; la page hostile est rendue par la coquille
//    simulée comme Rails la rendrait, AVEC une CSP permissive en en-tête et en `<meta>`. Ce qui est
//    éprouvé est donc le chemin de production, de bout en bout, sans machine virtuelle ;
//  - **le TÉMOIN POSITIF** : la même page, sous la même sandbox, servie par l'hébergeur sans relais
//    et sans politique. Chaque voie que la politique doit fermer y ABOUTIT. Sans lui, un relevé
//    vide ne prouverait rien — une page qui ne tenterait rien, ou une origine tierce injoignable,
//    rendraient le même vide.
//
// Les deux voies que la SANDBOX ferme déjà (`fenetre`, `navigation-du-sommet`) sont tentées dans
// les deux montages et doivent y rester fermées : la politique du cadre ne les couvre pas, et une
// sandbox élargie demain les rouvrirait. L'épreuve le dirait.

import { createServer } from "node:http";

import { expect, test } from "../support/test.mjs";

import {
  FERMEE_PAR,
  PREFIXE_DE_FUITE,
  VOIE_INTERNE,
  VOIES_DE_SORTIE,
  VOIES_INTERNES,
} from "../../public/coquille-epreuve/sorties-du-cadre.mjs";
import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

/** Le temps laissé, après « tentées », à une sortie tardive — la navigation du cadre comprise. */
const GRACE_APRES_TENTATIVES_MS = 4000;

/** Les voies que la page tente après avoir posé son relevé : elles le détruiraient. */
const TENTEES_APRES_LE_RELEVE = ["navigation-du-cadre", "desinscription"];

const FERMEES_PAR_LA_CSP = VOIES_DE_SORTIE.filter((voie) => voie.fermeePar === FERMEE_PAR.csp).map(
  ({ nom }) => nom,
);
const FERMEES_PAR_LA_SANDBOX = VOIES_DE_SORTIE.filter(
  (voie) => voie.fermeePar === FERMEE_PAR.sandbox,
).map(({ nom }) => nom);
/** Les RÉSIDUELS connus (ADR 0052) : tentés, publiés, non exigés. */
const RESIDUELLES = VOIES_DE_SORTIE.filter((voie) => voie.fermeePar === FERMEE_PAR.aucune).map(
  ({ nom }) => nom,
);

/** Ce que l'origine tierce rend, par voie : assez pour que le moteur aille au bout. */
const TYPES_RENDUS = {
  script: "text/javascript",
  feuille: "text/css",
  eventsource: "text/event-stream",
};

/** L'ORIGINE TIERCE instrumentée : elle relève le nom de chaque voie qui l'atteint. */
function demarrerLOrigineTierce() {
  const recues = new Set();
  const relever = (url) => {
    const chemin = new URL(url, "http://tiers.invalid").pathname;
    if (chemin.startsWith(PREFIXE_DE_FUITE)) recues.add(chemin.slice(PREFIXE_DE_FUITE.length));
    return chemin.slice(PREFIXE_DE_FUITE.length);
  };
  const serveur = createServer((requete, reponse) => {
    const nom = relever(requete.url);
    requete.resume();
    reponse.writeHead(200, {
      "content-type": TYPES_RENDUS[nom] ?? "text/html; charset=utf-8",
      "access-control-allow-origin": "*",
    });
    reponse.end(nom === "eventsource" ? "data: fuite\n\n" : "");
  });
  serveur.on("upgrade", (requete, socket) => {
    relever(requete.url);
    socket.destroy();
  });
  return new Promise((resolu) => {
    serveur.listen(0, "127.0.0.1", () => {
      resolu({
        origine: `http://127.0.0.1:${serveur.address().port}`,
        recues,
        arreter: () => new Promise((fin) => serveur.close(() => fin())),
      });
    });
  });
}

let tiers;

test.beforeAll(async () => {
  tiers = await demarrerLOrigineTierce();
});

test.afterAll(async () => {
  await tiers?.arreter();
});

test.beforeEach(() => {
  tiers.recues.clear();
});

function ouvrir(page, mode) {
  const url = new URL("/coquille-epreuve/coquille-simulee.html", SHELL_ORIGIN);
  url.searchParams.set("mode", mode);
  url.searchParams.set("tiers", tiers.origine);
  return page.goto(url.href);
}

test("TÉMOIN POSITIF : sans la politique du cadre, chaque voie atteint l'origine tierce", async ({
  page,
}, info) => {
  await ouvrir(page, "temoin");
  await expect
    .poll(() => [...FERMEES_PAR_LA_CSP, ...RESIDUELLES].filter((nom) => !tiers.recues.has(nom)), {
      message: "voies qui n'ont PAS atteint l'origine tierce sans la politique",
      timeout: 30000,
    })
    .toEqual([]);
  await info.attach(`temoin-${info.project.name}.json`, {
    body: JSON.stringify([...tiers.recues].sort(), null, 2),
    contentType: "application/json",
  });
  // La sandbox ferme les siennes, politique ou non.
  expect(FERMEES_PAR_LA_SANDBOX.filter((nom) => tiers.recues.has(nom))).toEqual([]);
});

test("ÉPREUVE ROUGE : servie par le relais, l'application n'atteint AUCUNE origine tierce", async ({
  page,
}, info) => {
  await ouvrir(page, "relais");
  const application = page.frameLocator("#document-applicatif").frameLocator("#application-servie");
  await expect(application.locator("html")).toHaveAttribute("data-sorties", "tentees", {
    timeout: 60000,
  });
  // Le relevé est lu AVANT la navigation du cadre, tentée une seconde après « tentées » : Chromium
  // remplace un cadre dont la navigation est refusée par sa page d'erreur, sans qu'aucune requête
  // parte. Ce qui compte est l'origine tierce, pas le document qui reste.
  const rapport = JSON.parse(await application.locator("#sorties-rapport").textContent());
  // L'épreuve attend une ABSENCE : il lui faut une fenêtre, et celle-ci couvre cette navigation.
  await page.waitForTimeout(GRACE_APRES_TENTATIVES_MS);
  await info.attach(`relais-${info.project.name}.json`, {
    body: JSON.stringify({ recues: [...tiers.recues].sort(), rapport }, null, 2),
    contentType: "application/json",
  });

  // Chaque voie a bien été TENTÉE : un relevé vide ne vaut que si rien n'a été épargné.
  expect(rapport.tentees.sort()).toEqual(
    VOIES_DE_SORTIE.map(({ nom }) => nom)
      .filter((nom) => !TENTEES_APRES_LE_RELEVE.includes(nom))
      .sort(),
  );
  expect(
    [...tiers.recues].filter((nom) => !RESIDUELLES.includes(nom)).sort(),
    "voies qui ont atteint l'origine tierce",
  ).toEqual([]);
  // Le RÉSIDUEL est publié, jamais tu : mesuré le 27/11/2026, la désinscription ouvre une sortie
  // sous Chromium et WebKit, pas sous Firefox (ADR 0052, limites).
  for (const nom of RESIDUELLES) {
    info.annotations.push({
      type: "residuel",
      description: `${nom} : ${tiers.recues.has(nom) ? "OUVERTE" : "fermée"} (${info.project.name})`,
    });
  }

  // Le CONTRE-TÉMOIN : ce que l'application adresse à SA PROPRE origine est relayé, sous la même
  // politique. Une politique qui fermerait tout fermerait aussi l'application.
  const relayes = JSON.parse(await page.locator("#relayes").textContent());
  for (const voie of VOIES_INTERNES) {
    expect(
      relayes.some((ligne) => ligne.endsWith(`${VOIE_INTERNE}${voie}`)),
      `${VOIE_INTERNE}${voie} n'a pas été relayé : ${JSON.stringify(relayes)}`,
    ).toBe(true);
  }
});
