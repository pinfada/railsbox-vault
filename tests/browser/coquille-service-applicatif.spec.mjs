// LE CHEMIN SERVI, et sa frontière (#192, ADR 0038) — sur les TROIS moteurs, sans machine virtuelle.
//
// ## L'épreuve rouge, et ce qu'elle mesure exactement
//
// Avant cette tranche, le cadre applicatif ne pouvait RIEN demander au guest : il n'existait aucun
// type pour cela, et une requête bien formée recevait `VAULT_COQUILLE_TYPE_INCONNU` — « je ne sais
// pas de quoi tu parles ». L'étape 4 du cycle de vie encadrait `public/document-applicatif.html`,
// servi par l'origine applicative, et aucune page métier n'apparaissait jamais dans le cadre.
//
// L'épreuve rouge est donc la PREMIÈRE de ce fichier, et elle se lit à l'envers des autres : ce
// qu'elle exige n'est pas un refus quelconque, c'est le refus JUSTE. Sur une coquille dont aucune
// application ne tourne, le cadre doit recevoir `VAULT_COQUILLE_APPLICATION_NON_DEMARREE` : « je
// sais, et il n'y a rien à servir tant que l'application n'est pas lancée ». La différence entre ces
// deux codes EST la tranche, et c'est la seule moitié qui se mesure sans Docker et sans v86.
//
// ## Ce que ce fichier NE prouve PAS, et qui vit ailleurs
//
// Il ne rend AUCUNE page Rails : aucune machine virtuelle ne tourne ici, et aucun guest ne répond.
// Ce que Rails rend réellement dans le cadre — le document, ses trois actifs, le clic, le formulaire
// soumis, la redirection suivie et la mutation relue à froid — est prouvé par
// `tests/e2e/parcours-page-rails.spec.mjs`, sur Chromium, avec l'image de référence. Les deux
// moitiés sont nécessaires : celle-ci mesure la FRONTIÈRE sur trois moteurs, celle-là mesure le
// SERVICE sur un seul.
//
// WebKit est ici comme ailleurs : il n'ouvre aucun volume (`VAULT_STORAGE_UNSUPPORTED`), donc son
// coffre reste `indisponible`. Ce que ces épreuves-ci mesurent n'en dépend pas — le refus du relais
// est calculé sur le TYPE, avant que le moindre état soit consulté, et c'est précisément la
// propriété que l'ADR 0028 exige. Un moteur sans OPFS rend donc les mêmes codes qu'un autre, et
// c'est ce qui rend ce fichier jouable sur les trois.

import { expect, test } from "@playwright/test";

import { NOMBRE_DE_SONDES } from "../../public/coquille-epreuve/marqueurs.mjs";
import { CODES_REFUS_COQUILLE, messageDeRefus } from "../../src/coquille/refus-de-coquille.mjs";
import { GESTES_REFUSES } from "../../src/coquille/admission-applicative.mjs";
import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";

/** La fixture ADVERSAIRE, servie par l'origine applicative : le même attaquant que #161. */
const FIXTURE = "/coquille-epreuve/hostile.html";

/** Ouvre la coquille de produit avec la fixture encadrée. Aucun déverrouillage : il n'en faut pas. */
async function ouvrirLaCoquille(page) {
  const url = new URL("/index.html", SHELL_ORIGIN);
  url.searchParams.set("document-applicatif", FIXTURE);
  await page.goto(url.toString());
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: 60000 });
}

/** Attend la fin des sondes de la fixture et rend son relevé, indexé par nom. */
async function releverLaFixture(portee) {
  await expect(portee.locator("html")).toHaveAttribute("data-hostile", "sondes-terminees", {
    timeout: 60000,
  });
  const sondes = JSON.parse(await portee.locator("#hostile-rapport").textContent());
  return { sondes, parNom: Object.fromEntries(sondes.map((sonde) => [sonde.nom, sonde])) };
}

async function releveDeLaCoquille(page) {
  return JSON.parse(await page.locator("#coquille-rapport").textContent());
}

test("ÉPREUVE ROUGE : le cadre demande `/` et reçoit un refus qui NOMME ce qui manque", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  const { parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));
  const sonde = parNom["relais-requete-bien-formee"];
  await info.attach(`relais-${info.project.name}.json`, {
    body: JSON.stringify(sonde, null, 2),
    contentType: "application/json",
  });

  // « Un refus typé, jamais un silence » : les deux moitiés, séparément.
  expect(sonde.resultat, sonde.detail).toBe("refuse");
  // LE POINT DE LA TRANCHE. `TYPE_INCONNU` est ce que cette même sonde recevait avant #192, et c'est
  // ce que l'issue appelle « ne rien recevoir » : la coquille ne savait pas de quoi on lui parlait.
  expect(
    sonde.code,
    "le cadre reçoit encore « type inconnu » : le chemin servi n'existe pas",
  ).not.toBe(CODES_REFUS_COQUILLE.typeInconnu);
  expect(sonde.code).toBe(CODES_REFUS_COQUILLE.applicationNonDemarree);
  // Le MESSAGE distingue les deux absences, et c'est ce qu'un utilisateur lira : « il n'y a rien à
  // servir tant que le coffre n'a pas été ouvert » n'est pas « cette origine ne sert aucune
  // application ».
  expect(sonde.detail).toBe(messageDeRefus(CODES_REFUS_COQUILLE.applicationNonDemarree));
});

test("le relais refuse, chacune sous SON code, les six façons d'écrire mal une requête", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  const { parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));

  const attendus = [
    // Quatre surfaces que la question d'état n'avait pas : une méthode, un chemin, des en-têtes,
    // un corps. Chacune est un endroit où une application malveillante peut écrire autre chose.
    ["relais-methode-hors-liste", CODES_REFUS_COQUILLE.requeteHttpRefusee],
    ["relais-chemin-absolu", CODES_REFUS_COQUILLE.requeteHttpRefusee],
    ["relais-entete-a-deux-lignes", CODES_REFUS_COQUILLE.requeteHttpRefusee],
    ["relais-corps-sur-un-get", CODES_REFUS_COQUILLE.requeteHttpRefusee],
    // La clôture des champs vaut pour le type neuf comme pour l'ancien : un champ qu'on accepte
    // sans le lire est un champ que la version suivante lira par accident (revue de la PR #166).
    ["relais-champ-hors-contrat", CODES_REFUS_COQUILLE.messageMalforme],
    // Et la RÉPONSE n'est pas une requête : la rejouer vers la coquille ne sert rien.
    ["reponse-relayee-rejouee", CODES_REFUS_COQUILLE.typeInconnu],
  ];
  for (const [nom, code] of attendus) {
    expect(parNom[nom], `${nom} n'a pas de sonde`).toBeDefined();
    expect(parNom[nom].resultat, `${nom} : ${parNom[nom].detail}`).toBe("refuse");
    expect(parNom[nom].code, nom).toBe(code);
  }
});

test("le CANAL DE RELAIS n'est pas atteignable depuis le port restreint, et le refus le dit", async ({
  page,
}) => {
  // Trois vocabulaires, trois canaux. Une application qui pose `vault.relais.requete` sur le port
  // restreint essaie de parler au Worker de confiance sans passer par la coquille — exactement
  // comme celle qui pose un type privilégié —, et elle mérite son propre refus : le laisser tomber
  // dans « type inconnu » rendrait cette tentative indiscernable d'une faute de frappe.
  await ouvrirLaCoquille(page);
  const { parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));
  const sonde = parNom["canal-de-relais-sur-le-port-restreint"];
  expect(sonde.resultat, sonde.detail).toBe("refuse");
  expect(sonde.code).toBe(CODES_REFUS_COQUILLE.canalDeRelaisRefuse);
});

test("les DIX refus de #24 sont inchangés sur le chemin neuf, et le relevé reste BORNÉ", async ({
  page,
}) => {
  // Le type neuf n'a rien relâché : l'adversaire rejoue les dix gestes interdits DANS LE MÊME
  // relevé que les huit sondes de relais, et les dix rendent toujours leur code. C'est ce que
  // « les dix refus inchangés » veut dire, mesuré plutôt qu'affirmé.
  await ouvrirLaCoquille(page);
  const { sondes, parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));
  expect(sondes).toHaveLength(NOMBRE_DE_SONDES);
  for (const refuse of GESTES_REFUSES) {
    const sonde = parNom[`refus-${refuse.type.replace("vault.coquille.", "")}`];
    expect(sonde.resultat, `${refuse.geste} : ${sonde.detail}`).toBe("refuse");
    expect(sonde.code, `${refuse.geste} n'a pas reçu SON code`).toBe(refuse.code);
  }

  // Le RELEVÉ de la coquille ne recopie rien du trafic relayé : il COMPTE. Huit requêtes relayées
  // refusées, et pas un octet de chemin, d'en-tête ou de corps dans le rapport public.
  const releve = await releveDeLaCoquille(page);
  expect(releve.relais.demandees).toBeGreaterThan(0);
  expect(releve.relais.servies).toBe(0);
  expect(releve.relais.octetsRendus).toBe(0);
  const texte = JSON.stringify(releve);
  expect(texte, "un chemin relayé s'est glissé dans le relevé public").not.toContain("/notes/1");
  expect(texte, "un en-tête forgé s'est glissé dans le relevé public").not.toContain("X-Injecte");
});

test("la coquille SERT encore ce qu'elle admettait : le type neuf n'a pas déplacé l'ancien", async ({
  page,
}) => {
  // Un chemin neuf qui casserait l'ancien serait une régression silencieuse : la question d'état
  // est le premier geste admis depuis #161, et elle doit rendre exactement ce qu'elle rendait.
  await ouvrirLaCoquille(page);
  const { parNom } = await releverLaFixture(page.frameLocator("#document-applicatif"));
  expect(parNom["obtention-port-restreint"].resultat).toBe("aboutit");
  expect(parNom["geste-admis-etat"].resultat).toBe("aboutit");
  expect(parNom["gestes-admis-concurrents"].detail).toContain("4/4");
});

test("la SANDBOX du cadre porte TROIS jetons, et pas un quatrième", async ({ page }) => {
  // `allow-forms` est neuf (#192, ADR 0038 décision 4 bis), et il a été ajouté parce qu'un moteur
  // bloquait toute soumission de formulaire AVANT qu'aucune requête ne parte — le relais était
  // correct et n'était jamais appelé. Ce qu'il ajoute est la soumission d'un formulaire, et rien
  // d'autre ; ce qui reste refusé est ce qui compte, et cette épreuve le tient : un quatrième jeton
  // ne peut apparaître sans qu'une revue l'ait lu.
  await ouvrirLaCoquille(page);
  const jetons = await page.locator("#document-applicatif").getAttribute("sandbox");
  expect(jetons.split(/\s+/).filter(Boolean).sort()).toEqual([
    "allow-forms",
    "allow-same-origin",
    "allow-scripts",
  ]);
});

test("le VERROUILLAGE retire le cadre, et plus rien n'est servi ensuite", async ({ page }) => {
  // La moitié mesurable SANS machine virtuelle : après le geste de verrouillage, le cadre est
  // RETIRÉ. Le cadre retiré, aucune réponse ne peut plus lui parvenir — c'est la garde par
  // construction, et c'est elle qui rend l'autre moitié (une réponse EN VOL abandonnée) mesurable
  // seulement là où une réponse met trois cents millisecondes à revenir, c'est-à-dire dans
  // `tests/e2e/parcours-page-rails.spec.mjs`.
  await ouvrirLaCoquille(page);
  await expect(page.locator("#document-applicatif")).toHaveCount(1);

  await page.locator("#verrouiller-le-coffre").click();
  // Le verrouillage se termine par un rechargement de la coquille. Ce qui est exigé ici est que le
  // cadre ait disparu — et il disparaît AVANT le rechargement depuis #192, parce que le cadre porte
  // désormais ce que Rails rend, et non plus une place tenante.
  await expect(page.locator("#document-applicatif")).toHaveCount(0, { timeout: 60000 });
});
