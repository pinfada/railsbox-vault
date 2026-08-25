import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { expect, test } from "@playwright/test";

import { ISOLATION_HOST, PORT_ISOLE, PORT_NU } from "../../playwright.isolation.config.mjs";
import { REPOSITORY_ROOT } from "../../tools/v86-paths.mjs";

// Spike #41 — l'isolation multi-origine (COOP/COEP) est-elle NÉCESSAIRE au runtime v86 épinglé, et
// que coûte-t-elle quand on la pose ? Ce fichier MESURE ; il n'arbitre que ce qui rendrait la
// mesure fausse :
//
//  1. le témoin d'isolation — la condition « isolée » doit réellement être isolée et la condition
//     « nue » réellement nue. Sans lui, deux colonnes identiques ne prouveraient rien ;
//  2. l'égalité du travail — les deux conditions doivent faire faire au guest la même chose. Les
//     barrières et les écritures sont déterministes et comparées à l'identique ; les lectures
//     varient d'une exécution à l'autre (lecture anticipée du noyau, mesurée par le spike #4) et
//     sont donc comparées avec une tolérance déclarée.
//
// Les deux conditions sont ENTRELACÉES, et l'ordre est inversé un tour sur deux. Mesurer d'abord
// tous les essais nus puis tous les essais isolés confondrait l'effet cherché avec l'échauffement
// de la machine : la première version de ce fichier procédait ainsi et rendait un écart qui n'a pas
// survécu à l'entrelacement. L'ordre effectif est publié dans le rapport.
//
// Aucun seuil de performance n'est affirmé : transformer une durée observée sur un poste de bureau
// en assertion serrée rendrait la suite instable sans rien prouver de plus. L'écart mesuré est
// publié, il n'est pas jugé par le harnais.

const ECHAUFFEMENT = 1;
const ESSAIS = Number(process.env.VAULT_ISOLATION_ESSAIS ?? 4);
/** Tolérance sur le nombre de lectures entre les deux conditions. Voir le spike #4. */
const TOLERANCE_LECTURES = 0.1;
/** Un Worker qui ne répond pas dans ce délai est un moteur non mesurable, pas une suite bloquée. */
const DELAI_CAPACITES_MS = 30_000;
/**
 * Un guest qui n'atteint pas son invite dans ce délai l'est aussi. Cinquante fois le boot mesuré
 * sous Chromium : au-delà, ce n'est plus une lenteur, c'est un autre défaut — et le pouls du Worker
 * dit lequel.
 */
const DELAI_MESURE_MS = 180_000;

/** `non` rejoue le protocole en blocs, celui dont le spike publie le faux résultat. */
const ENTRELACER = (process.env.VAULT_ISOLATION_ENTRELACEMENT ?? "oui") !== "non";

const CONDITIONS = Object.freeze([
  { nom: "nu", port: PORT_NU },
  { nom: "isole", port: PORT_ISOLE },
]);

function percentile(valeurs, ratio) {
  if (valeurs.length === 0) return null;
  const triees = [...valeurs].sort((a, b) => a - b);
  const index = Math.min(triees.length - 1, Math.max(0, Math.ceil(ratio * triees.length) - 1));
  return Number(triees[index].toFixed(1));
}

function ecartPourcent(reference, compare) {
  if (reference === null || compare === null || reference === 0) return null;
  return Number((((compare - reference) / reference) * 100).toFixed(1));
}

/**
 * Temps processeur du processus de rendu, via le protocole DevTools. Il englobe les threads du
 * processus, Worker dédié compris — c'est donc la mesure CPU la plus proche du coût réel du
 * runtime. Elle n'existe que sous Chromium ; ailleurs elle vaut `null`, ce qui est un RÉSULTAT
 * déclaré et non un trou comblé par une approximation.
 *
 * Elle est échantillonnée AUTOUR DE CHAQUE ESSAI, jamais autour d'un bloc : les deux conditions
 * vivant sur deux origines, Chromium leur donne deux processus de rendu, et un compteur cumulé
 * traversant une navigation ne mesurerait plus rien.
 */
async function ouvrirCompteurCpu(page, moteur) {
  if (moteur !== "chromium") return null;
  const session = await page.context().newCDPSession(page);
  await session.send("Performance.enable");
  const lire = async () => {
    const { metrics } = await session.send("Performance.getMetrics");
    const valeur = (nom) => metrics.find((metrique) => metrique.name === nom)?.value ?? null;
    return { processTime: valeur("ProcessTime"), threadTime: valeur("ThreadTime") };
  };
  const depart = await lire();
  return {
    async fermer() {
      const arrivee = await lire();
      await session.detach();
      const delta = (nom) =>
        depart[nom] === null || arrivee[nom] === null
          ? null
          : Number((arrivee[nom] - depart[nom]).toFixed(3));
      return {
        processTimeSecondes: delta("processTime"),
        threadTimeSecondes: delta("threadTime"),
      };
    },
  };
}

/** Relevé de capacités, ou raison typée si le Worker ne répond pas du tout sur ce moteur. */
async function releverCapacites(page) {
  try {
    return await page.evaluate(
      (delai) =>
        Promise.race([
          globalThis.bancIsolation.capacites(),
          new Promise((_, rejeter) =>
            setTimeout(() => rejeter(new Error("le Worker runtime n'a pas répondu")), delai),
          ),
        ]),
      DELAI_CAPACITES_MS,
    );
  } catch (erreur) {
    return {
      isolation: null,
      raisonNonMesurable: `Worker runtime injoignable sur ce moteur : ${erreur.message}`,
    };
  }
}

/** Un essai complet, ou une raison typée : un guest qui ne démarre pas n'est pas un échec de suite. */
async function executerEssai(page) {
  try {
    return {
      rapport: await page.evaluate(
        (delai) =>
          Promise.race([
            globalThis.bancIsolation.mesurer({}),
            new Promise((_, rejeter) =>
              setTimeout(() => rejeter(new Error("le guest n'a rien rendu")), delai),
            ),
          ]),
        DELAI_MESURE_MS,
      ),
      raison: null,
    };
  } catch (erreur) {
    return { rapport: null, raison: `Essai impossible sur ce moteur : ${erreur.message}` };
  }
}

/**
 * Ordre des essais.
 *
 * Par défaut les conditions sont ENTRELACÉES et leur ordre inversé un tour sur deux : c'est le
 * protocole retenu. `VAULT_ISOLATION_ENTRELACEMENT=non` rejoue au contraire le protocole fautif —
 * tous les essais d'une condition, puis tous ceux de l'autre. Il n'est pas conservé par nostalgie :
 * il a produit un écart net et faux, et un témoin négatif qu'on ne peut plus reproduire n'est
 * qu'une anecdote. Le mode employé est publié dans le rapport.
 */
function sequenceDesEssais() {
  const tours = ECHAUFFEMENT + ESSAIS;
  const sequence = [];
  if (!ENTRELACER) {
    for (const condition of CONDITIONS) {
      for (let tour = 0; tour < tours; tour += 1) sequence.push({ tour, condition });
    }
    return sequence;
  }
  for (let tour = 0; tour < tours; tour += 1) {
    const ordre = tour % 2 === 0 ? CONDITIONS : [...CONDITIONS].reverse();
    for (const condition of ordre) sequence.push({ tour, condition });
  }
  return sequence;
}

function nouvelEtat(condition) {
  return {
    url: `http://${ISOLATION_HOST}:${condition.port}/spike/isolation/`,
    isolationDocument: null,
    isolationWorker: null,
    mesurable: null,
    raisonNonMesurable: null,
    poulsAuSilence: null,
    memoireDetailleeDocument: null,
    bootMs: null,
    chargementMs: null,
    etapes: null,
    counts: null,
    countsEssais: [],
    cpu: null,
    memoire: null,
    memoireDetaillee: null,
    brut: { boots: [], chargements: [], cpu: [], parEtape: new Map() },
  };
}

function accumuler(etat, rapport, cpu) {
  etat.brut.boots.push(rapport.bootMs);
  etat.brut.chargements.push(rapport.chargementMs);
  if (cpu) etat.brut.cpu.push(cpu);
  etat.countsEssais.push(rapport.counts);
  etat.memoireDetaillee = rapport.memoireDetaillee;
  for (const etape of rapport.etapes) {
    if (!etat.brut.parEtape.has(etape.label)) {
      etat.brut.parEtape.set(etape.label, {
        mesuree: etape.mesuree,
        octets: etape.octets,
        ms: [],
        debits: [],
      });
    }
    const agregat = etat.brut.parEtape.get(etape.label);
    agregat.ms.push(etape.millisecondes);
    if (etape.mioParSeconde !== null) agregat.debits.push(etape.mioParSeconde);
  }
}

function resumer(etat) {
  const { boots, chargements, cpu, parEtape } = etat.brut;
  delete etat.brut;
  if (boots.length === 0) return etat;
  etat.bootMs = { essais: boots, p50: percentile(boots, 0.5), p95: percentile(boots, 0.95) };
  etat.chargementMs = {
    essais: chargements,
    p50: percentile(chargements, 0.5),
    p95: percentile(chargements, 0.95),
  };
  etat.counts = etat.countsEssais.at(-1);
  etat.cpu =
    cpu.length === 0
      ? null
      : {
          source: "Chrome DevTools Protocol, Performance.getMetrics, un relevé par essai",
          processTimeSecondesEssais: cpu.map((mesure) => mesure.processTimeSecondes),
          processTimeSecondesP50: percentile(
            cpu.map((mesure) => mesure.processTimeSecondes).filter((valeur) => valeur !== null),
            0.5,
          ),
        };
  etat.etapes = Object.fromEntries(
    [...parEtape].map(([label, agregat]) => [
      label,
      {
        mesuree: agregat.mesuree,
        octets: agregat.octets,
        msEssais: agregat.ms,
        msP50: percentile(agregat.ms, 0.5),
        msP95: percentile(agregat.ms, 0.95),
        mioParSecondeP50: percentile(agregat.debits, 0.5),
      },
    ]),
  );
  return etat;
}

test("coût de l'isolation multi-origine sur le runtime v86 épinglé", async ({ page }, testInfo) => {
  const moteur = testInfo.project.name;
  const etats = Object.fromEntries(
    CONDITIONS.map((condition) => [condition.nom, nouvelEtat(condition)]),
  );
  const ordreEssais = [];

  for (const { tour, condition } of sequenceDesEssais()) {
    const etat = etats[condition.nom];
    await page.goto(etat.url);
    await expect(page.locator("#etat")).toHaveText("Worker runtime prêt.");

    if (etat.isolationDocument === null) {
      etat.isolationDocument = await page.evaluate(() =>
        globalThis.bancIsolation.isolationDocument(),
      );
      const capacites = await releverCapacites(page);
      etat.isolationWorker = capacites.isolation;
      etat.mesurable = capacites.raisonNonMesurable === null;
      etat.raisonNonMesurable = capacites.raisonNonMesurable;
      etat.memoireDetailleeDocument = await page.evaluate(() =>
        globalThis.bancIsolation.memoireDetaillee(),
      );
    }
    if (!etat.mesurable) continue;

    const compteurCpu = await ouvrirCompteurCpu(page, moteur);
    const { rapport, raison } = await executerEssai(page);
    const cpu = compteurCpu ? await compteurCpu.fermer() : null;
    if (!rapport) {
      etat.mesurable = false;
      etat.raisonNonMesurable = raison;
      // Le pouls distingue « le guest ne démarre pas » de « le thread du Worker ne rend plus la
      // main ». Sans lui, les deux se lisent « rien n'est revenu », et un seul se corrige.
      etat.poulsAuSilence = await page.evaluate(() => globalThis.bancIsolation.poulsRecu());
      continue;
    }
    if (tour < ECHAUFFEMENT) continue;
    ordreEssais.push({ tour, condition: condition.nom });
    accumuler(etat, rapport, cpu);
    etat.memoire = await page.evaluate(() => globalThis.bancIsolation.memoire());
  }

  const nu = resumer(etats.nu);
  const isole = resumer(etats.isole);
  const comparable = nu.mesurable && isole.mesurable && nu.bootMs && isole.bootMs;
  const ecarts = comparable
    ? {
        bootP50Pourcent: ecartPourcent(nu.bootMs.p50, isole.bootMs.p50),
        chargementP50Pourcent: ecartPourcent(nu.chargementMs.p50, isole.chargementMs.p50),
        cpuP50Pourcent:
          nu.cpu && isole.cpu
            ? ecartPourcent(nu.cpu.processTimeSecondesP50, isole.cpu.processTimeSecondesP50)
            : null,
        etapesP50Pourcent: Object.fromEntries(
          Object.keys(nu.etapes).map((label) => [
            label,
            ecartPourcent(nu.etapes[label].msP50, isole.etapes[label].msP50),
          ]),
        ),
      }
    : null;

  const mesures = {
    spike: 41,
    moteur,
    navigateur: await page.evaluate(() => navigator.userAgent),
    date: new Date().toISOString(),
    echauffement: ECHAUFFEMENT,
    essais: ESSAIS,
    protocole: ENTRELACER ? "conditions entrelacées" : "conditions en blocs (protocole fautif)",
    ordreEssais,
    conditions: { nu, isole },
    ecarts,
  };
  const corps = `${JSON.stringify(mesures, null, 2)}\n`;
  await testInfo.attach("cout-isolation.json", { body: corps, contentType: "application/json" });
  // Le même relevé est écrit sur disque, comme `reports/compat/` et `reports/vm/` : un rapport
  // Playwright n'est pas un endroit où l'on retrouve une mesure six mois plus tard.
  const dossier = join(REPOSITORY_ROOT, "reports", "isolation");
  await mkdir(dossier, { recursive: true });
  // Le protocole fautif écrit son propre fichier : il ne doit pas écraser la mesure retenue, et le
  // spike doit pouvoir citer les deux côte à côte.
  const nom = ENTRELACER ? `cout-isolation-${moteur}` : `cout-isolation-blocs-${moteur}`;
  await writeFile(join(dossier, `${nom}.json`), corps);

  // Témoin d'isolation du DOCUMENT : il vaut sur les trois moteurs, y compris ceux qui ne peuvent
  // pas porter le runtime. C'est lui qui prouve que les deux colonnes ne sont pas la même
  // condition servie deux fois.
  expect(nu.isolationDocument.crossOriginIsolated).toBe(false);
  expect(nu.isolationDocument.secureContext).toBe(true);
  expect(isole.isolationDocument.crossOriginIsolated).toBe(true);
  expect(isole.isolationDocument.secureContext).toBe(true);

  // Témoin d'isolation du WORKER : `crossOriginIsolated` ne se déduit pas d'un contexte à l'autre.
  // Il n'est vérifié que là où le Worker répond — son silence est déjà un résultat consigné.
  if (nu.isolationWorker) {
    expect(nu.isolationWorker.crossOriginIsolated).toBe(false);
    expect(nu.isolationWorker.sharedArrayBuffer).toBe("constructeur-absent");
  }
  if (isole.isolationWorker) {
    expect(isole.isolationWorker.crossOriginIsolated).toBe(true);
    expect(isole.isolationWorker.sharedArrayBuffer).toBe("alloue");
  }

  // Un moteur non mesurable doit dire pourquoi, en toutes lettres. Sans cette exigence, un runtime
  // qui ne démarre plus se lirait comme un moteur « non concerné ».
  for (const releve of [nu, isole]) {
    expect(releve.mesurable || (releve.raisonNonMesurable?.length ?? 0) > 0).toBe(true);
  }

  if (!comparable) return;

  // Égalité du travail : sans elle, l'écart de durée ne mesure que la différence des charges.
  expect(isole.counts.write).toBe(nu.counts.write);
  expect(isole.counts.flush).toBe(nu.counts.flush);
  expect(isole.counts["flush-ack"]).toBe(nu.counts["flush-ack"]);
  expect(Math.abs(isole.counts.read - nu.counts.read)).toBeLessThanOrEqual(
    Math.ceil(nu.counts.read * TOLERANCE_LECTURES),
  );

  expect(nu.bootMs.essais).toHaveLength(ESSAIS);
  expect(isole.bootMs.essais).toHaveLength(ESSAIS);
  expect(isole.bootMs.p50).toBeGreaterThan(0);
  // Le résultat central du spike, posé comme assertion : le runtime v86 épinglé démarre, écrit et
  // franchit ses barrières SANS isolation multi-origine ni `SharedArrayBuffer`. Si un jour il ne le
  // fait plus, cette ligne rougit et l'ADR 0010 doit être rouvert.
  expect(nu.bootMs.p50).toBeGreaterThan(0);
  expect(nu.counts.write).toBeGreaterThan(0);
  expect(nu.counts.flush).toBeGreaterThan(0);
  expect(nu.etapes["ecriture-disque"].mioParSecondeP50).toBeGreaterThan(0);
  expect(nu.etapes["lecture-disque"].mioParSecondeP50).toBeGreaterThan(0);
});
