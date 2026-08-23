// Spike #35 — relevé et décision sur la topologie d'origine de confiance.
//
// Trois familles d'épreuves :
//  1. un relevé par topologie, qui ne juge pas mais consigne le résultat brut de chaque tentative ;
//  2. un témoin positif sur la topologie la plus permissive — sans lui, un relevé « tout bloqué »
//     ne prouverait rien d'autre que des sondes cassées ;
//  3. les assertions strictes sur la topologie retenue.

import { expect, test } from "@playwright/test";

import {
  CANARY_AUTHENTIC,
  CANARY_INTERCEPTED,
  TOPOLOGY_IDS,
  expectedAppOrigin,
} from "../../src/spike/origin-topology.mjs";
import { HOSTILE_MARK } from "../../public/spike/origin/app-probes-storage.mjs";
import {
  NOMBRE_DE_SONDES,
  TOPOLOGIE_RETENUE,
  TOPOLOGIE_TEMOIN,
  contaminationCoquille,
  observerCanary,
  ouvrirCoquille,
  parNom,
  releverCoquille,
  releverSondes,
} from "./origin-helpers.mjs";

for (const topologie of TOPOLOGY_IDS) {
  test(`relevé des tentatives applicatives — ${topologie}`, async ({ page, context }, info) => {
    await ouvrirCoquille(page, topologie);
    const sondes = await releverSondes(page);
    const coquille = await releverCoquille(page);
    const contamination = await contaminationCoquille(page);
    const canary = await observerCanary(context);

    const releve = {
      moteur: info.project.name,
      topologie,
      origineAttendue: expectedAppOrigin(topologie),
      urlSommet: page.url(),
      canary,
      contaminationCoquille: contamination,
      coquille,
      sondes,
    };
    await info.attach(`releve-${info.project.name}-${topologie}.json`, {
      body: JSON.stringify(releve, null, 2),
      contentType: "application/json",
    });

    expect(sondes).toHaveLength(NOMBRE_DE_SONDES);
    for (const sonde of sondes) {
      expect(["reussi", "bloque", "indisponible"], `${sonde.nom} : ${sonde.detail}`).toContain(
        sonde.resultat,
      );
    }
  });
}

test(`témoin positif — ${TOPOLOGIE_TEMOIN} : les tentatives aboutissent réellement`, async ({
  page,
  context,
}) => {
  await ouvrirCoquille(page, TOPOLOGIE_TEMOIN);
  const sondes = parNom(await releverSondes(page));

  // Ces capacités existent sur les trois moteurs mesurés : leur succès est exigé partout.
  for (const nom of [
    "acces-dom-coquille",
    "lecture-appat-realm",
    "lecture-stockage-cle-valeur",
    "empoisonnement-prototype-port",
    "navigation-top-fragment",
    "lecture-indexeddb-coquille",
    "ecriture-indexeddb-silencieuse",
  ]) {
    expect(sondes[nom].resultat, `${nom} : ${sondes[nom].detail}`).toBe("reussi");
  }

  // Celles-ci manquent à certains moteurs (OPFS et Service Worker sont absents du WebKit livré
  // par Playwright sous Windows) : `indisponible` est admis, `bloque` ne l'est pas — un refus en
  // même origine signifierait que la sonde est cassée.
  for (const nom of [
    "lecture-opfs-coquille",
    "ecriture-opfs-silencieuse",
    "observation-verrous-web",
    "ecoute-canal-controle",
    "enregistrement-service-worker",
  ]) {
    expect(["reussi", "indisponible"], `${nom} : ${sondes[nom].detail}`).toContain(
      sondes[nom].resultat,
    );
  }

  const contamination = await contaminationCoquille(page);
  expect(contamination.indexedDb).toBe(HOSTILE_MARK);
  if (sondes["ecriture-opfs-silencieuse"].resultat === "reussi") {
    expect(contamination.opfs).toBe(HOSTILE_MARK);
  }
  if (sondes["enregistrement-service-worker"].resultat === "reussi") {
    expect(await observerCanary(context)).toBe(CANARY_INTERCEPTED);
  }
});

test(`topologie retenue — ${TOPOLOGIE_RETENUE} : aucune tentative n'atteint la coquille`, async ({
  page,
  context,
}) => {
  await ouvrirCoquille(page, TOPOLOGIE_RETENUE);
  const sondes = parNom(await releverSondes(page));

  // Le contrat légitime fonctionne : sans cela, « tout bloqué » signifierait « rien ne marche ».
  expect(sondes["obtention-port-restreint"].resultat).toBe("reussi");

  for (const sonde of Object.values(sondes)) {
    if (sonde.cible !== "coquille") continue;
    expect(["bloque", "indisponible"], `${sonde.nom} : ${sonde.detail}`).toContain(sonde.resultat);
  }

  const contamination = await contaminationCoquille(page);
  expect(contamination.opfs).toMatch(/^absent/);
  expect(contamination.indexedDb).toBe("absent");
  expect(await observerCanary(context)).toBe(CANARY_AUTHENTIC);
  expect(page.url()).not.toContain("hostile");

  const coquille = await releverCoquille(page);
  expect(coquille.origineAttendue).toBe(expectedAppOrigin(TOPOLOGIE_RETENUE));
  expect(coquille.requetesRefusees).toContain("vault.export-key");
  expect(coquille.annoncesRefusees.map((refus) => refus.motif)).toContain(
    "fenetre-emettrice-inattendue",
  );
  expect(coquille.annoncesRefusees.map((refus) => refus.motif)).toContain("port-deja-emis");
});

for (const topologie of TOPOLOGY_IDS) {
  test(`navigation forcée du sommet — ${topologie}`, async ({ page }, info) => {
    await ouvrirCoquille(page, topologie);
    await releverSondes(page);

    const cadre = page.frames().find((frame) => frame.url().includes("/spike/origin/app.html"));
    expect(cadre, "cadre applicatif introuvable").toBeTruthy();
    const appel = await cadre.evaluate(() => {
      try {
        top.location.replace("about:blank");
        return "appel-accepte";
      } catch (error) {
        return `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`;
      }
    });
    await page.waitForTimeout(700);

    const urlFinale = page.url();
    await info.attach(`navigation-${info.project.name}-${topologie}.json`, {
      body: JSON.stringify({ moteur: info.project.name, topologie, appel, urlFinale }, null, 2),
      contentType: "application/json",
    });
    if (topologie === TOPOLOGIE_TEMOIN) {
      expect(urlFinale).toBe("about:blank");
    } else {
      expect(urlFinale).toContain("/spike/origin/shell.html");
    }
  });
}
