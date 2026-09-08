// Le cycle de vie ASSEMBLÉ, joué sur la COQUILLE RÉELLE (#163, ADR 0030 ; #169, ADR 0031).
//
// C'est le critère de fermeture de l'issue : « au moins un scénario de `tests/e2e/` joué sur la
// coquille réelle avec son document applicatif encadré, au lieu de `/vm/reference.html` ». Tous les
// autres scénarios de ce dossier partent du BANC ; celui-ci part de `public/index.html`, avec ses
// deux origines réelles, son Worker de confiance, son enveloppe de clé et son cadre applicatif.
//
// ## Ce qu'il prouve, dans l'ordre où il le prouve
//
//  1. la coquille se monte, encadre le document applicatif sur l'origine distincte et lui transfère
//     un port — l'acquis de #161, rejoué ici sous les artefacts réels ;
//  2. un GESTE de l'utilisateur ouvre le coffre par une phrase (Argon2id, #162) ;
//  3. un second geste DÉMARRE l'application : la coquille installe le disque de l'image de
//     référence dans un volume chiffré, ouvre ce volume sous la clé développée de son enveloppe,
//     puis boote v86, le guest, Rails et le pont série DANS le Worker de confiance. Rails écrit, une
//     barrière est acquittée, l'invariant applicatif est relu ;
//  4. un troisième geste VERROUILLE : la VM s'arrête, l'instantané est scellé, les volumes sont
//     fermés, le Worker est terminé, et la coquille SE RECHARGE — elle revient `verrouille`, sans
//     cadre applicatif, sans KEK, et sans que rien ait été dérivé (#169, ADR 0031) ;
//  5. l'INSTANTANÉ est constaté PRÉSENT sur l'OPFS réel après le verrouillage. C'est la révision
//     datée de l'ADR 0024 décision 8 : le verrouillage ne le retire pas ;
//  6. la page est FERMÉE — ce qui tue le Worker, ses handles et sa mémoire — puis rouverte. Une
//     nouvelle dérivation de la même phrase rouvre l'enveloppe, et l'application redémarre SANS
//     être réinstallée : le volume de cinq cents mébioctets a survécu, scellé, l'invariant est
//     retrouvé, et la reprise emprunte l'INSTANTANÉ que le verrouillage a laissé.
//
// ## Ce qu'il ne prouve PAS
//
//  - il ne coupe pas le réseau. `reprise-mutation-boot-froid.spec.mjs` reste le témoin de la reprise
//    HORS LIGNE, sur le banc, et il n'est pas remplacé : les deux vivent côte à côte, l'un mesurant
//    l'assemblage, l'autre l'indépendance au réseau ;
//  - il ne mesure rien d'un authentificateur réel : la passkey n'est pilotable que sous Chromium
//    (ADR 0021), et le moyen employé ici est la PHRASE ;
//  - il tourne sur Chromium seul, comme tous les scénarios de ce dossier. L'assemblage sur les trois
//    moteurs est mesuré ailleurs, sans VM : `tests/browser/coquille-cycle-de-vie.spec.mjs`.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { exigerLesPrealables, expect, test } from "./contexte-persistant.mjs";
import { ISSUES_DETAPE } from "../../src/coquille/cycle-de-vie.mjs";
import { E2E_ORIGIN_COQUILLE, E2E_ORIGIN_COQUILLE_APP } from "../../playwright.e2e.config.mjs";
import { artefactsV86Absents } from "../../tools/v86-paths.mjs";
import { INSTANTANE_SIDECAR_SUFFIX } from "../../src/vm/opfs-sync-access.mjs";

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const CHEMIN_MANIFESTE = join(RACINE, "tools", "build-reference-image", "manifest.json");
const CHEMIN_DESCRIPTEUR = join(RACINE, "artifacts", "application.json");
const CHEMIN_CONTRAT = join(RACINE, "apps", "reference", "vault-invariant.json");
const DOSSIER_IMAGE = join(RACINE, "artifacts", "reference-image");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "e2e");

/**
 * La PHRASE du scénario. Elle n'est un secret d'aucune sorte : elle ouvre un coffre fabriqué par
 * cette épreuve, dans un profil de navigateur que Playwright jette à la fin. Elle est longue parce
 * que la coquille refuse les phrases courtes (`saisie-du-code.mjs` et l'ADR 0021).
 */
const PHRASE = "une phrase de scenario assez longue pour la calibration";

/** Budget d'un boot Rails DANS la coquille, geste compris. Deux minutes ne suffisent pas en CI. */
const BUDGET_DEMARRAGE_MS = 600_000;

/** Budget du geste de déverrouillage : Argon2id calibré, plus l'ouverture du volume. */
const BUDGET_DEVERROUILLAGE_MS = 120_000;

/**
 * Décrit ce qui manque pour jouer ce scénario, ou `null` si tout est là.
 *
 * La condition est EXPLICITE et porte sur des fichiers nommés : jamais un `skip` par défaut. Une
 * suite qui se déclarerait ignorée sans dire pourquoi passerait au vert sur une machine où rien
 * n'aurait été construit — c'est-à-dire exactement là où elle doit parler.
 */
function raisonDIndisponibilite() {
  if (!existsSync(CHEMIN_MANIFESTE)) {
    return "manifeste de l'image absent : « npm run image:build » (puis « npm run vm:fetch »)";
  }
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  const absents = manifeste.artifacts
    .map((artefact) => artefact.name)
    .filter((nom) => !existsSync(join(DOSSIER_IMAGE, nom)));
  if (absents.length > 0) {
    return `artefacts de l'image #5 absents (${absents.join(", ")}) : « npm run image:build »`;
  }
  if (!existsSync(CHEMIN_DESCRIPTEUR)) {
    return `descripteur applicatif absent (${CHEMIN_DESCRIPTEUR}) : « npm run image:manifest »`;
  }
  const manquantsV86 = artefactsV86Absents(["libv86.mjs", "v86.wasm"]);
  if (manquantsV86.length > 0) {
    return `artefacts v86 absents (${manquantsV86.join(", ")}) : « npm run vm:fetch »`;
  }
  return null;
}

const raison = raisonDIndisponibilite();

/** Le relevé public de la coquille, tel que le nœud le publie. */
async function releve(page) {
  return JSON.parse(await page.locator("#coquille-rapport").textContent());
}

/** Ouvre la coquille, attend qu'elle se déclare prête, et rend la page. */
async function ouvrirLaCoquille(contexte) {
  const page = await contexte.newPage();
  const erreurs = [];
  page.on("pageerror", (erreur) => erreurs.push(erreur.message));
  await page.goto(`${E2E_ORIGIN_COQUILLE}/index.html`, { waitUntil: "load" });
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", {
    timeout: 60_000,
  });
  return { page, erreurs };
}

/** OUVRE le coffre par la phrase. C'est le geste de #162, sur le chemin de produit. */
async function ouvrirParLaPhrase(page) {
  await page.fill("#saisie-phrase", PHRASE);
  await page.click("#ouvrir-par-phrase");
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: BUDGET_DEVERROUILLAGE_MS })
    .toBe("ouvert");
}

/** DÉMARRE l'application, et rend ce que la coquille en publie. */
async function demarrerLApplication(page) {
  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).toHaveText("cycle:application-demarree", {
    timeout: BUDGET_DEMARRAGE_MS,
  });
  return (await releve(page)).application;
}

/**
 * La CLÉ sous laquelle ce scénario range le relevé publié JUSTE AVANT le rechargement de la coquille
 * (#169, ADR 0031). Elle appartient à l'ÉPREUVE : le produit n'écrit rien dans `sessionStorage`, et
 * la sonde d'exfiltration le mesure.
 *
 * Le verrouillage se termine par un rechargement, et le relevé qui décrit cette session disparaît
 * avec le document. Un `MutationObserver` posé par `addInitScript` le capture ; son rappel est une
 * microtâche, donc il précède le `setTimeout` qui porte le rechargement. Ce n'est pas une course.
 */
const CLE_DE_CAPTURE = "epreuve-verrouillage-169";

/** ARME la capture, sur le CONTEXTE : elle doit survivre à la navigation du rechargement. */
async function armerLaCapture(contexte) {
  await contexte.addInitScript((cle) => {
    const observateur = new MutationObserver(() => {
      if (document.documentElement.dataset.coquille !== "verrouille") return;
      const noeud = document.querySelector("#coquille-rapport");
      if (noeud !== null) sessionStorage.setItem(cle, noeud.textContent);
    });
    observateur.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-coquille"],
    });
  }, CLE_DE_CAPTURE);
}

/** L'INVENTAIRE de l'OPFS de l'origine de CONFIANCE : les noms et les tailles, jamais le contenu. */
async function inventaireOpfs(page) {
  return page.evaluate(async () => {
    const releve = [];
    const racine = await navigator.storage.getDirectory();
    for await (const [nom, poignee] of racine.entries()) {
      if (poignee.kind !== "file") continue;
      releve.push({ nom, octets: (await poignee.getFile()).size });
    }
    return releve.sort((gauche, droite) => gauche.nom.localeCompare(droite.nom));
  });
}

test("le cycle de vie assemblé boote Rails dans la coquille, se VERROUILLE, et retrouve son invariant", async ({
  context,
}, testInfo) => {
  exigerLesPrealables(raison, "reprise-coquille-boot-froid.spec.mjs");
  test.setTimeout(1_500_000);
  await armerLaCapture(context);

  const contrat = JSON.parse(readFileSync(CHEMIN_CONTRAT, "utf8"));

  // --- 1. La coquille se monte, et encadre le document applicatif sur l'AUTRE origine -------------
  let session = await ouvrirLaCoquille(context);
  // « Prête » dit que le cadre est CRÉÉ. Ce qui suit — le chargement du document, son annonce, le
  // port transféré, la première réponse d'état — est une SUITE d'allers-retours entre deux origines,
  // et l'attendre est ce qui distingue une mesure d'une course. Le document se déclare `servi`
  // quand il a reçu son port ET la réponse à sa question : c'est le dernier maillon.
  await expect(session.page.frameLocator("#document-applicatif").locator("html")).toHaveAttribute(
    "data-document-applicatif",
    "servi",
    { timeout: 30_000 },
  );
  const initial = await releve(session.page);
  expect(initial.origineApplicative, "la coquille encadre l'origine distincte de l'ADR 0002").toBe(
    E2E_ORIGIN_COQUILLE_APP,
  );
  expect(initial.cadreApplicatif).toBe("charge");
  expect(initial.portOctroye).toBe(true);
  expect(initial.cycle.map(({ etape }) => etape)).toEqual([
    "identites",
    "exclusiviteEtCanal",
    "backendPuisVm",
    "cadreEtPort",
  ]);

  // --- 2 et 3. Un geste ouvre le coffre, un second démarre l'application --------------------------
  await ouvrirParLaPhrase(session.page);
  const premier = await demarrerLApplication(session.page);
  await testInfo.attach("premier-demarrage.json", {
    body: JSON.stringify(premier, null, 2),
    contentType: "application/json",
  });

  expect(premier.demarree).toBe(true);
  expect(premier.installation.installee, "le disque applicatif est INSTALLÉ au premier geste").toBe(
    true,
  );
  expect(premier.installation.ecrits).toBe(premier.installation.octets);
  // Rails a réellement booté DANS la coquille : il a servi l'invariant, il a écrit des blocs dans
  // OPFS, et au moins une barrière de durabilité a été acquittée après le flush (`SEC-DURABLE-001`).
  expect(premier.invariantStatut).toBe(200);
  expect(premier.invariantVerdict.status).toBe("conforming");
  expect(premier.enregistrementObserve).toBe(contrat.record.id);
  expect(premier.pieceJointeObservee).toBe(contrat.attachment.sha256);
  expect(premier.counts.write, "Rails a écrit des blocs dans OPFS").toBeGreaterThan(0);
  expect(premier.counts.flush, "une barrière fsync a atteint OPFS").toBeGreaterThan(0);
  expect(premier.counts["flush-ack"], "chaque barrière est acquittée").toBe(premier.counts.flush);
  expect(premier.pannes, "aucune panne de support absorbée").toBe(0);
  // La boucle d'ordonnancement qui a fait tourner ce boot est celle de Vault, et v86 l'a empruntée
  // (#74). Sans cette exigence, la mesure pourrait être publiée sur une horloge et le produit
  // tourner sur une autre.
  expect(premier.boucleOrdonnancement.source).toMatch(/^vault/);
  expect(premier.boucleOrdonnancement.appels).toBeGreaterThan(0);
  // Les barrières du GUEST entrent dans le compte que la coquille publie à l'application : c'est
  // l'étape 5 du cycle de vie, et elle cesse d'être un banc.
  expect(premier.barrieres).toBeGreaterThan(1);

  // LE JOURNAL, RELU APRÈS LE BOOT. L'étape 3 est RÉVISÉE — elle ne reste pas `differee` sur un
  // geste qui a eu lieu —, l'étape 5 est franchie parce qu'un guest a réellement acquitté une
  // barrière, et l'étape 8 dit que ce démarrage n'a rien repris : il vient d'installer.
  const apresDemarrage = await releve(session.page);
  const etapesApresBoot = new Map(apresDemarrage.cycle.map((i) => [i.etape, i]));
  expect(etapesApresBoot.get("backendPuisVm").issue).toBe(ISSUES_DETAPE.franchie);
  expect(etapesApresBoot.get("backendPuisVm").revision).toBe(true);
  expect(etapesApresBoot.get("ecritureEtBarriere").issue).toBe(ISSUES_DETAPE.franchie);
  expect(etapesApresBoot.get("exportEtMigration").issue).toBe(ISSUES_DETAPE.banc);
  expect(etapesApresBoot.get("reprise").issue).toBe(ISSUES_DETAPE.differee);
  expect(etapesApresBoot.get("reprise").motif).toBe("installation-initiale");

  // Le RELEVÉ reste BORNÉ après un compte rendu de boot : la liste de `compteRenduPublie` est
  // fermée, et le journal du guest n'y entre pas. C'est la seule mesure de ce plafond APRÈS un vrai
  // boot — `tests/browser/coquille-frontiere.spec.mjs` le mesure avant tout démarrage.
  const tailleApresBoot = (await session.page.locator("#coquille-rapport").textContent()).length;
  await testInfo.attach("releve-apres-boot.txt", {
    body: `caractères : ${tailleApresBoot}`,
    contentType: "text/plain",
  });
  expect(
    tailleApresBoot,
    "le relevé porte un compte rendu BORNÉ, pas le journal du guest",
  ).toBeLessThan(16_384);

  // --- 4. Le VERROUILLAGE : arrêt de la VM, instantané, `close()`, `terminate()`, rechargement ---
  //
  // Le geste s'appelle « Verrouiller », et c'est le seul mot (#169, ADR 0031, décision 1). Ce qu'il
  // fait n'a pas changé d'un appel depuis #163 ; ce qui a changé est qu'il est NOMMÉ, qu'un délai
  // d'inactivité emprunte le même chemin, et qu'il RECHARGE la coquille pour retirer le cadre.
  await session.page.click("#verrouiller-le-coffre");
  await expect
    .poll(async () => session.page.evaluate((cle) => sessionStorage.getItem(cle), CLE_DE_CAPTURE), {
      timeout: 300_000,
    })
    .not.toBeNull();
  const ferme = JSON.parse(
    await session.page.evaluate((cle) => sessionStorage.getItem(cle), CLE_DE_CAPTURE),
  );
  await testInfo.attach("verrouillage.json", {
    body: JSON.stringify(
      {
        verrouillage: ferme.verrouillage,
        fermeture: ferme.fermeture,
        workerMort: ferme.workerMort,
        verrouillageMs: ferme.mesures.verrouillageMs,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });
  // Le `terminate()` vient APRÈS le `close()`, et la coquille se constate elle-même morte : c'est
  // la troisième cause de `CAUSES_DE_MORT`, et la conduite est celle des deux autres.
  expect(ferme.workerMort.cause).toBe("terminaison");
  expect(ferme.workerMort.kekRetenue).toBe(false);
  expect(ferme.etat).toBe("verrouille");
  expect(ferme.fermeture.capture, "le verrouillage rend un compte rendu de capture").not.toBeNull();
  expect(ferme.verrouillage.declencheur).toBe("geste");
  expect(ferme.verrouillage.workerTermine).toBe(true);
  expect(ferme.verrouillage.instantaneRetire).toBe(false);
  expect(typeof ferme.mesures.verrouillageMs).toBe("number");
  // LE JOURNAL, RELU APRÈS LE VERROUILLAGE : l'étape 7 est révisée de `differee` à `franchie`.
  const etapesApresFermeture = new Map(ferme.cycle.map((i) => [i.etape, i]));
  expect(etapesApresFermeture.get("fermeture").issue).toBe(ISSUES_DETAPE.franchie);
  expect(etapesApresFermeture.get("fermeture").revision).toBe(true);

  // LE RECHARGEMENT, observé. Il est le fait de la coquille elle-même — aucun bouton n'est cliqué —
  // et c'est ce qui retire le cadre applicatif : les pixels du cadre sont le dernier clair de la
  // session. Ce n'est PAS une réouverture : la coquille revient `verrouille`, l'interface de
  // déverrouillage est remontée, et aucune dérivation n'a lieu sans geste.
  await expect(session.page.locator("html")).toHaveAttribute("data-coquille", "prete", {
    timeout: 120_000,
  });
  const rechargee = await releve(session.page);
  expect(rechargee.etat).toBe("verrouille");
  expect(rechargee.workerMort, "la coquille rechargée n'est pas une coquille morte").toBeNull();
  expect(rechargee.verrouillage, "le relevé de la session verrouillée ne survit pas").toBeNull();
  expect(rechargee.mesures.deverrouillageMs, "rien n'a été dérivé sans geste").toBeNull();
  await expect(session.page.locator("#deverrouillage")).toBeVisible();
  // LE CYCLE est relu APRÈS le verrouillage : il repart de l'étape 1.
  expect(rechargee.cycle.map(({ etape }) => etape)).toEqual([
    "identites",
    "exclusiviteEtCanal",
    "backendPuisVm",
    "cadreEtPort",
  ]);

  // --- 5. L'INSTANTANÉ SURVIT au verrouillage, constaté sur l'OPFS RÉEL ---------------------------
  //
  // C'est la révision datée de l'ADR 0024 décision 8 (ADR 0031, décision 3), et elle se mesure ici
  // plutôt qu'ailleurs : la ligne « verrouillage : oui » de cette table était une position par
  // défaut, jamais un comportement. Le fichier `<volume>.instantane` est scellé sous la DEK, comme
  // le volume qui reste, lui, sur l'appareil sans que personne n'appelle cela un défaut.
  const opfsApresVerrouillage = await inventaireOpfs(session.page);
  await testInfo.attach("opfs-apres-verrouillage.json", {
    body: JSON.stringify(opfsApresVerrouillage, null, 2),
    contentType: "application/json",
  });
  const instantanes = opfsApresVerrouillage.filter(({ nom }) =>
    nom.endsWith(INSTANTANE_SIDECAR_SUFFIX),
  );
  expect(
    instantanes.length,
    "aucun instantané sur l'OPFS après le verrouillage : la révision de l'ADR 0024 déc. 8 ne tient pas",
  ).toBeGreaterThan(0);
  expect(instantanes.every(({ octets }) => octets > 0)).toBe(true);

  // La PAGE est fermée : le Worker meurt avec elle, ses handles et sa mémoire s'en vont.
  await session.page.close();
  expect(session.erreurs, "aucune erreur de page pendant la première session").toEqual([]);

  // --- 6. Réouverture : un NOUVEAU geste, volume RETROUVÉ, invariant retrouvé ---------------------
  //
  // Jamais de réouverture automatique : ce que l'utilisateur paie, il décide de le payer. Ce qu'il
  // paie, en revanche, est ce que la décision 3 de l'ADR 0031 lui promet — l'instantané que le
  // verrouillage a laissé, et non un boot à froid.
  session = await ouvrirLaCoquille(context);
  expect((await releve(session.page)).etat, "la coquille rouvre VERROUILLÉE").toBe("verrouille");
  await ouvrirParLaPhrase(session.page);
  const second = await demarrerLApplication(session.page);
  await testInfo.attach("second-demarrage.json", {
    body: JSON.stringify(second, null, 2),
    contentType: "application/json",
  });

  // LE POINT DU SCÉNARIO : l'application n'est PAS réinstallée. Le volume de cinq cents mébioctets,
  // son manifeste et son enveloppe ont survécu à la fermeture complète, et la même phrase — dérivée
  // à neuf, sur une page neuve, dans un Worker neuf — a suffi à les rouvrir.
  expect(second.demarree).toBe(true);
  expect(second.installation.installee, "le disque applicatif n'est pas réinstallé").toBe(false);
  expect(second.invariantVerdict.status).toBe("conforming");
  expect(second.enregistrementObserve).toBe(contrat.record.id);
  expect(second.pieceJointeObservee).toBe(contrat.attachment.sha256);
  // Ce que deux chemins de boot doivent rendre IDENTIQUE pour que « retrouvé » veuille dire quelque
  // chose (#65, ADR 0024) : le statut, l'enregistrement et l'empreinte de la pièce jointe. Le
  // verdict entier ne franchit pas le canal — sa forme appartient au guest, et la liste publiée est
  // fermée en profondeur autant qu'en largeur.
  expect(second.invariantVerdict.status).toBe(premier.invariantVerdict.status);
  expect(second.enregistrementObserve).toBe(premier.enregistrementObserve);
  expect(second.pieceJointeObservee).toBe(premier.pieceJointeObservee);
  // L'ouverture a CONFRONTÉ ce qu'elle a relu : le rapport de récupération existe, et il n'est pas
  // inventé. Ce que ce boot en a fait — instantané repris ou boot à froid — est publié plus bas.
  expect(second.recuperation, "le rapport d'ouverture est publié").not.toBeNull();

  // LE JOURNAL, RELU À LA RÉOUVERTURE : l'étape 8 est FRANCHIE, et son motif dit par quel chemin —
  // instantané repris, ou boot à froid. C'est la seule preuve par exécution de cette étape.
  const cycleALaReprise = (await releve(session.page)).cycle;
  const etapesReprise = new Map(cycleALaReprise.map((i) => [i.etape, i]));
  expect(etapesReprise.get("reprise").issue).toBe(ISSUES_DETAPE.franchie);
  expect(["instantane", "boot-froid"]).toContain(etapesReprise.get("reprise").motif);
  expect(etapesReprise.get("backendPuisVm").issue).toBe(ISSUES_DETAPE.franchie);
  // LE PRIX DE LA RÉOUVERTURE, et le point de la décision 3 : le chemin emprunté est celui de
  // l'INSTANTANÉ, celui que le verrouillage a laissé sur le support. Un verrouillage qui coûterait
  // 125,9 s de boot à froid par réouverture est un verrouillage qu'on désactive — l'écart est
  // publié plus bas, sans seuil, par `secondDemarrage.bootMs` et `secondDemarrage.instantane`.
  expect(
    second.instantaneUtilise,
    "la réouverture n'a pas repris l'instantané que le verrouillage a laissé",
  ).toBe(true);
  expect(etapesReprise.get("reprise").motif).toBe("instantane");

  await session.page.close();
  expect(session.erreurs, "aucune erreur de page pendant la seconde session").toEqual([]);

  // --- Mesures, publiées sans seuil ---------------------------------------------------------------
  const mesures = {
    mesureLe: new Date().toISOString(),
    environnement: {
      navigateur: testInfo.project.name,
      plateforme: `${process.platform} ${process.arch}`,
      node: process.versions.node,
    },
    coquille: {
      origineCoquille: E2E_ORIGIN_COQUILLE,
      origineApplicative: E2E_ORIGIN_COQUILLE_APP,
      canalPrivilegieMs: initial.mesures.canalPrivilegieMs,
      cadreApplicatifMs: initial.mesures.cadreApplicatifMs,
      cycle: initial.cycle,
    },
    premierDemarrage: {
      installation: premier.installation,
      bootMs: premier.bootMs,
      santeMs: premier.santeMs,
      instantaneUtilise: premier.instantaneUtilise,
      decomposition: premier.decomposition,
      rythme: premier.rythme,
      counts: premier.counts,
      generation: premier.generation,
    },
    fermeture: ferme.fermeture,
    // Le VERROUILLAGE, publié SANS SEUIL (#169, ADR 0031) : ce qu'il a coûté, ce qu'il a atteint, et
    // ce qu'il a laissé sur le support.
    verrouillage: {
      ...ferme.verrouillage,
      verrouillageMs: ferme.mesures.verrouillageMs,
      opfsApresVerrouillage,
      instantanesRestants: instantanes,
    },
    cycleApresFermeture: ferme.cycle,
    cycleApresRechargement: rechargee.cycle,
    // Relevé AVANT la fermeture de la page : une mesure prise après elle n'existerait plus.
    cycleALaReprise,
    secondDemarrage: {
      bootMs: second.bootMs,
      santeMs: second.santeMs,
      instantaneUtilise: second.instantaneUtilise,
      instantane: second.instantane,
      decomposition: second.decomposition,
      recuperation: second.recuperation,
      counts: second.counts,
    },
  };
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(
    join(DOSSIER_RAPPORTS, "reprise-coquille.json"),
    `${JSON.stringify(mesures, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("reprise-coquille.json", {
    body: JSON.stringify(mesures, null, 2),
    contentType: "application/json",
  });
});
