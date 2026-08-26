// Mesure #52 — sous quelle configuration la boucle d'ordonnancement de v86 bat-elle ?
//
// Six relevés par moteur : deux politiques de CSP (`worker-src 'self'` et `worker-src 'self'
// blob:`) croisées avec trois configurations du contexte du Worker (marqueur d'URL, sans marqueur,
// cale `scheduler.postTask` fournie par Vault). Le relevé publie le compteur de tours de v86, ce
// qui distingue « guest lent » de « émulateur qui ne bat pas ».
//
// Ce fichier MESURE. Il n'asserte que deux choses, et pour deux raisons opposées :
//   1. le relevé est bien formé — sans quoi un tableau vide se lirait comme un moteur muet ;
//   2. la configuration retenue par l'ADR 0013 démarre bien un guest sur au moins un moteur — sans
//      témoin positif, six échecs ne prouveraient qu'un banc cassé.
// Tout le reste est consigné dans l'ADR, pas transformé en échec : un moteur qui ne démarre pas
// est un fait de compatibilité, pas une régression du dépôt.

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { CSP_HOST, PORT_BLOB, PORT_STRICT } from "../../playwright.csp.config.mjs";

// Même convention que la sonde de capacités #2 : un rapport par moteur, hors dépôt, archivable en
// artefact de CI. Un relevé qui ne survit pas à l'exécution ne peut pas être recopié dans un ADR.
const dossierRapports = fileURLToPath(new URL("../../reports/csp/", import.meta.url));

const POLITIQUES = [
  { nom: "worker-src 'self'", port: PORT_STRICT },
  { nom: "worker-src 'self' blob:", port: PORT_BLOB },
];

const CONFIGURATIONS = ["marqueur-url", "sans-marqueur", "cale-si-absente", "cale-forcee"];

/** Délai borné du boot dans le Worker de mesure. Un guest qui bat atteint son invite bien avant. */
const BOOT_TIMEOUT_MS = 60_000;

/** Vrai si le moteur a réellement fait tourner l'émulateur, indépendamment de l'invite atteinte. */
function aBattu(releve) {
  return typeof releve?.ticks === "number" && releve.ticks > 0;
}

test("relevé de la boucle d'ordonnancement sur les deux politiques", async ({ page }, info) => {
  const releves = [];

  for (const politique of POLITIQUES) {
    for (const configuration of CONFIGURATIONS) {
      await page.goto(`http://${CSP_HOST}:${politique.port}/csp/ordonnancement.html`);
      await page.waitForFunction(() => Boolean(globalThis.bancOrdonnancement));
      const brut = await page.evaluate(
        ([nom, bootTimeoutMs]) => globalThis.bancOrdonnancement.mesurer(nom, { bootTimeoutMs }),
        [configuration, BOOT_TIMEOUT_MS],
      );
      releves.push({ politique: politique.nom, ...brut });
    }
  }

  await info.attach(`ordonnancement-${info.project.name}.json`, {
    body: JSON.stringify({ moteur: info.project.name, releves }, null, 2),
    contentType: "application/json",
  });

  // Tableau lisible : c'est cette forme qui est recopiée dans l'ADR 0013.
  const tableau = releves.map((entree) => ({
    politique: entree.politique,
    configuration: entree.configuration,
    schedulerPostTask: entree.releve?.schedulerPostTask ?? null,
    cheminAttendu: entree.releve?.cheminAttendu ?? null,
    workerBlob: entree.releve?.workerBlob ?? null,
    wasm: entree.releve?.wasm ?? null,
    ticks: entree.releve?.ticks ?? null,
    invite: entree.releve?.invite ?? false,
    bootMs: entree.releve?.bootMs ?? null,
    dureeTotaleMs: entree.releve?.dureeTotaleMs ?? null,
    erreur: entree.releve?.erreur?.message ?? entree.echec?.message ?? null,
    incidents: entree.releve?.incidents?.map((i) => `${i.type}: ${i.message}`) ?? [],
    silence: entree.silence ?? null,
  }));
  const serialise = JSON.stringify({ moteur: info.project.name, tableau, releves }, null, 2);
  await info.attach(`tableau-${info.project.name}.json`, {
    body: serialise,
    contentType: "application/json",
  });
  await mkdir(dossierRapports, { recursive: true });
  await writeFile(`${dossierRapports}${info.project.name}.json`, serialise, "utf8");

  expect(releves).toHaveLength(POLITIQUES.length * CONFIGURATIONS.length);
  for (const entree of releves) {
    // Le banc rend TOUJOURS un verdict : soit le Worker a répondu, soit son silence est constaté et
    // daté. Un silence est une mesure — c'est ainsi que le thread monopolisé de Firefox (#74) est
    // consigné — mais une entrée sans l'un ni l'autre signalerait un banc cassé.
    const decide = Boolean(entree.releve) || Boolean(entree.echec) || entree.silence === true;
    expect(decide, `${entree.politique} / ${entree.configuration}`).toBe(true);
  }

  // Garde d'anti-vacuité : si AUCUNE configuration d'une politique n'avait produit de relevé, le
  // tableau serait fait de silences et ne dirait rien du moteur. Chaque politique doit avoir fait
  // parler le Worker au moins une fois.
  for (const politique of POLITIQUES) {
    const parlantes = releves.filter(
      (entree) => entree.politique === politique.nom && Boolean(entree.releve),
    );
    expect(parlantes.length, `aucun relevé sous ${politique.nom}`).toBeGreaterThan(0);
  }
});

test("témoin positif : la configuration retenue fait battre l'émulateur", async ({
  page,
  browserName,
}, info) => {
  // Le témoin n'est exigé que sur le moteur de référence, et il est écarté AVANT de mesurer :
  // Firefox et WebKit ont des empêchements MESURÉS et étrangers à la CSP (#74 pour l'un, absence de
  // `scheduler.postTask` pour l'autre), consignés dans l'ADR 0013 par le relevé ci-dessus plutôt que
  // transformés en échec de ce dépôt. Les rejouer ici ne coûterait que deux minutes d'attente.
  test.skip(browserName !== "chromium", "écart de moteur consigné dans l'ADR 0013");

  await page.goto(`http://${CSP_HOST}:${PORT_STRICT}/csp/ordonnancement.html`);
  await page.waitForFunction(() => Boolean(globalThis.bancOrdonnancement));
  const brut = await page.evaluate(
    ([bootTimeoutMs]) => globalThis.bancOrdonnancement.mesurer("marqueur-url", { bootTimeoutMs }),
    [BOOT_TIMEOUT_MS],
  );
  await info.attach(`temoin-${info.project.name}.json`, {
    body: JSON.stringify(brut, null, 2),
    contentType: "application/json",
  });

  expect(aBattu(brut.releve)).toBe(true);
  expect(brut.releve.invite).toBe(true);
});
