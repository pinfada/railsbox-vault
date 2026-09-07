// Le CYCLE DE VIE ASSEMBLÉ, mesuré dans un navigateur (#163, tranche 3 de #24, ADR 0030).
//
// `tests/unit/coquille-cycle-de-vie.test.mjs` montre que les gardes savent rougir ; cette
// suite-ci montre qu'elles portent sur quelque chose. Les deux se complètent, et le partage est
// celui que `tools/muter-gardes-coquille.mjs` a écrit pour #161 : la campagne dit que la décision
// sait rougir, le navigateur dit qu'elle s'applique.
//
// Trois moteurs, et pour un motif qui appartient à cette tranche : ce qu'un moteur fait d'un Worker
// qui meurt — quel événement il livre, dans quel ordre, et s'il en livre un — n'est écrit nulle part
// dans une norme que trois implémentations liraient pareil. Un relevé mono-moteur publierait une
// conduite que les deux autres ne tiendraient peut-être pas.
//
// ## Ce que cette suite ne mesure PAS, et il faut le dire
//
// Elle ne démarre AUCUNE machine virtuelle : les artefacts de l'image de référence pèsent un demi
// gibioctet et un boot Rails se compte en dizaines de secondes. Le boot dans la coquille est le
// sujet de `tests/e2e/reprise-coquille-boot-froid.spec.mjs`, en intégration continue. Ce qui est
// mesuré ici est l'ORDRE — et l'ordre se prouve par le refus de son inverse, qui ne demande aucun
// artefact.

import { expect, test } from "@playwright/test";

import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { ETAPES_DU_CYCLE, ISSUES_DETAPE } from "../../src/coquille/cycle-de-vie.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";

/** Le délai des gestes de cette suite. La borne de mort du Worker est de trente secondes. */
const DELAI = 90_000;

/** Le relevé public de la coquille, tel que le nœud le publie. */
async function releve(page) {
  return JSON.parse(await page.locator("#coquille-rapport").textContent());
}

/** Ouvre la coquille et attend qu'elle se déclare prête. */
async function ouvrirLaCoquille(page) {
  await page.goto(`${SHELL_ORIGIN}/index.html`);
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });
}

/**
 * Remplace le module du Worker de confiance par celui qu'on lui donne, AVANT toute navigation.
 *
 * C'est la seule façon de tuer le Worker sans que la coquille expose quoi que ce soit pour cela :
 * #162 a retiré le jeton de harnais du chemin de produit, et lui rendre une poignée de test — un
 * `globalThis.tuerLeWorker` — reviendrait à rouvrir cette porte pour la commodité d'une épreuve.
 * L'interception est du côté du RÉSEAU, où le produit n'a rien à dire.
 */
async function substituerLeWorker(page, corps) {
  // Le motif porte une étoile finale : le Worker de confiance est chargé avec
  // `?use-scheduling-api` (v86 choisit sa boucle en inspectant `location.href`), et un motif sans
  // elle n'intercepterait plus rien — l'épreuve mesurerait alors le vrai Worker en croyant mesurer
  // un mort.
  await page.context().route("**/runtime-worker.mjs*", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: corps,
    }),
  );
}

/** Un Worker qui JETTE à l'évaluation de son module : la coquille reçoit `error`. */
const WORKER_QUI_JETTE = `throw new Error("worker de confiance en panne (épreuve #163)");\n`;

/**
 * Un Worker MUET : il vit, il reçoit le port, et il ne répond jamais. C'est le cas le plus dur —
 * aucun événement n'est livré, et seule la borne de temps le distingue d'un Worker lent.
 */
const WORKER_MUET = `self.addEventListener("message", () => {});\n`;

/** Ce qu'un Worker LENT met à répondre : plus que la borne de mort, moins que le budget d'un boot. */
const REPONSE_LENTE_MS = 40_000;

/**
 * Un Worker VIVANT mais LENT : il répond tout de suite à l'état et à l'inventaire, et met quarante
 * secondes à répondre au démarrage — pendant lesquelles il BAT.
 *
 * C'est le cas que la première rédaction de cette tranche traitait comme une mort : la borne de
 * trente secondes portait sur l'ABSENCE DE RÉPONSE, et le dossier publie p95 = 125,9 s pour un boot
 * Rails. Un Worker parfaitement vivant était donc déclaré mort exactement pendant le geste le plus
 * long que la coquille porte, et la fermeture propre devenait inatteignable dans le cas même pour
 * lequel elle est écrite (constat 1 de la revue de sécurité de la PR #171).
 *
 * Il parle le contrat pour de bon — il importe le module que la coquille importe —, sans quoi
 * l'épreuve mesurerait un double au lieu de la frontière.
 */
const WORKER_LENT = `
import { TYPES_PRIVILEGIES, decoderMessage, enveloppeDeMessage } from "/src/coquille/contrat-de-messages.mjs";
import { DELAI_BATTEMENT_MS } from "/src/coquille/moyens-de-deverrouillage.mjs";

let port = null;
const repondre = (type, corps) => port.postMessage(enveloppeDeMessage(type, corps));

self.addEventListener("message", (event) => {
  const decode = decoderMessage(event.data);
  if (!decode.ok || decode.type !== TYPES_PRIVILEGIES.canal) return;
  port = event.ports[0];
  port.addEventListener("message", (message) => {
    const recu = decoderMessage(message.data);
    if (!recu.ok) return;
    const correlation = recu.message.correlation;
    if (recu.type === TYPES_PRIVILEGIES.etat) {
      repondre(TYPES_PRIVILEGIES.etatReponse, {
        etat: "ouvert",
        barrieres: 0,
        correlation,
        exclusivite: { verdict: "disponible", volume: "coquille", code: null },
        application: "arretee",
      });
      return;
    }
    if (recu.type === TYPES_PRIVILEGIES.inventaire) {
      repondre(TYPES_PRIVILEGIES.inventaireReponse, {
        present: false,
        versionEnveloppe: null,
        emplacements: [],
        correlation,
      });
      return;
    }
    if (recu.type === TYPES_PRIVILEGIES.application) {
      // Il BAT pendant tout le geste, puis répond. Sans le battement, la coquille aurait déjà
      // constaté une mort dix secondes plus tôt.
      const battement = setInterval(
        () => repondre(TYPES_PRIVILEGIES.battement, { correlation }),
        DELAI_BATTEMENT_MS,
      );
      setTimeout(() => {
        clearInterval(battement);
        repondre(TYPES_PRIVILEGIES.applicationReponse, {
          demarree: false,
          motif: "worker lent de l'épreuve",
          correlation,
        });
      }, ${REPONSE_LENTE_MS});
    }
  });
  port.start();
});
`;

// --- L'ORDRE des huit étapes, mesuré ---------------------------------------------------------------

test("le relevé publie les étapes du cycle, datées et dans l'ordre du dossier", async ({
  page,
}, info) => {
  await ouvrirLaCoquille(page);
  const rapport = await releve(page);
  await info.attach(`cycle-${info.project.name}.json`, {
    body: JSON.stringify(rapport.cycle, null, 2),
    contentType: "application/json",
  });

  const noms = rapport.cycle.map(({ etape }) => etape);
  expect(noms).toEqual(["identites", "exclusiviteEtCanal", "backendPuisVm", "cadreEtPort"]);

  // L'ordre est MESURÉ, pas affirmé : chaque étape porte l'instant où elle a été conclue, et la
  // suite des instants est croissante. Une inscription hors d'ordre serait refusée avant d'exister.
  const instants = rapport.cycle.map(({ instantMs }) => instantMs);
  for (let rang = 1; rang < instants.length; rang += 1) {
    expect(instants[rang]).toBeGreaterThanOrEqual(instants[rang - 1]);
  }
  // Et les rangs sont ceux du dossier : `docs/architecture.md` § « Cycle de vie de référence ».
  for (let rang = 1; rang < noms.length; rang += 1) {
    expect(ETAPES_DU_CYCLE.indexOf(noms[rang])).toBeGreaterThan(
      ETAPES_DU_CYCLE.indexOf(noms[rang - 1]),
    );
  }
});

test("l'étape 3 est CONCLUE avant que le cadre existe, et son issue dit ce qui n'a pas eu lieu", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  const rapport = await releve(page);
  const parEtape = new Map(rapport.cycle.map((inscrite) => [inscrite.etape, inscrite]));

  // `differee`, et non « franchie » ni rien du tout : au démarrage ordinaire le volume est
  // verrouillé, donc il n'y a ni backend ni VM. Sauter l'étape rendrait le journal muet là où il
  // doit parler ; la conclure `differee` dit ce qui manque — un geste — et pourquoi le cadre suit.
  expect(parEtape.get("backendPuisVm").issue).toBe(ISSUES_DETAPE.differee);
  expect(parEtape.get("backendPuisVm").instantMs).toBeLessThanOrEqual(
    parEtape.get("cadreEtPort").instantMs,
  );
  // Le CHARGEMENT du cadre est un événement du navigateur, postérieur à sa création : il est
  // attendu, jamais supposé. La création, elle, est déjà inscrite au cycle ci-dessus.
  await expect
    .poll(async () => (await releve(page)).cadreApplicatif, { timeout: DELAI })
    .toBe("charge");
  expect((await releve(page)).portOctroye).toBe(true);
});

test("les capacités sont mesurées DANS la coquille, sous la CSP servie", async ({ page }, info) => {
  await ouvrirLaCoquille(page);
  const rapport = await releve(page);
  await info.attach(`capacites-${info.project.name}.json`, {
    body: JSON.stringify(rapport.capacites, null, 2),
    contentType: "application/json",
  });

  // WebAssembly est celle qui compte : la CSP de la coquille ne l'autorise que par
  // `'wasm-unsafe-eval'` (ADR 0013), et la mesurer ici — plutôt que dans la sonde `public/compat.html`,
  // qui en est EXEMPTÉE — est exactement ce que la décision 1 de l'ADR 0030 demande.
  expect(rapport.capacites.presentes).toContain("webassembly");
  expect(rapport.capacites.suffisante).toBe(true);
  // Ce qui manque est NOMMÉ, jamais deviné ni remplacé par un repli.
  for (const nom of rapport.capacites.manquantes) {
    expect(typeof nom).toBe("string");
  }
});

test("l'exclusivité du volume est CONSTATÉE avant qu'un document applicatif existe", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  const rapport = await releve(page);
  // Le constat est relevé par le Worker à SON évaluation, et il arrive dans la réponse d'état qui
  // établit le canal — donc avant le cadre, par une dépendance et non par une convention.
  expect(["disponible", "sans-volume", "indisponible", "refusee", "inconnue"]).toContain(
    rapport.exclusivite.verdict,
  );
  const parEtape = new Map(rapport.cycle.map((inscrite) => [inscrite.etape, inscrite]));
  expect(parEtape.get("exclusiviteEtCanal").motif).toBe(rapport.exclusivite.verdict);
  expect(parEtape.get("exclusiviteEtCanal").instantMs).toBeLessThanOrEqual(
    parEtape.get("cadreEtPort").instantMs,
  );

  // Le port RESTREINT n'en apprend rien : l'exclusivité ne franchit que le canal privilégié.
  const cadre = page.frameLocator("#document-applicatif");
  const vueDuCadre = JSON.parse(await cadre.locator("#document-applicatif-rapport").textContent());
  expect(JSON.stringify(vueDuCadre)).not.toContain("exclusivite");
});

// --- La preuve par l'ÉCHEC de l'inverse : un boot avant le backend -----------------------------------

test("un démarrage demandé AVANT l'ouverture du backend est refusé, et le refus nomme l'ordre", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  // Aucun déverrouillage : le volume est verrouillé (ou `indisponible` sur un moteur sans OPFS
  // synchrone). Dans les deux cas il n'y a pas de backend, et la VM démarre APRÈS lui.
  const rapport = await releve(page);
  expect([ETATS_DU_VOLUME.verrouille, ETATS_DU_VOLUME.indisponible]).toContain(rapport.etat);

  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).toHaveText(
    `cycle:demarrage-refuse:${CODES_REFUS_COQUILLE.etapeHorsOrdre}`,
    { timeout: DELAI },
  );

  // Le refus porte le code de l'ORDRE, et non un code de SUPPORT : ce n'est pas le stockage qui a
  // échoué, c'est l'étape 3 qui a été demandée à l'envers. La distinction n'est pas décorative —
  // un code de support enverrait chercher un défaut de disque là où il n'y en a pas.
  const apres = await releve(page);
  expect(apres.application.demarree).toBe(false);
  expect(apres.application.code).toBe(CODES_REFUS_COQUILLE.etapeHorsOrdre);
  // Et l'étape 3 reste conclue `differee` : un refus n'inscrit rien.
  const parEtape = new Map(apres.cycle.map((inscrite) => [inscrite.etape, inscrite]));
  expect(parEtape.get("backendPuisVm").issue).toBe(ISSUES_DETAPE.differee);
});

// --- La MORT du Worker de confiance : détection et conduite -----------------------------------------

/** Ce que la conduite doit rendre, quelle que soit la cause. */
async function exigerLaConduite(page, cause) {
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "worker-mort", {
    timeout: DELAI,
  });
  const rapport = await releve(page);
  expect(rapport.workerMort.cause).toBe(cause);
  expect(rapport.workerMort.code).toBe(CODES_REFUS_COQUILLE.workerMort);
  // Le code est le SIEN. Il portait `VAULT_COQUILLE_TYPE_INCONNU`, dont le message dit « Requête
  // hors de la liste d'admission » — un refus qui décrivait un autre événement que le sien.
  expect(rapport.workerMort.code).not.toBe(CODES_REFUS_COQUILLE.typeInconnu);
  expect(rapport.workerMort.derivationPermise).toBe(false);
  expect(rapport.workerMort.pousseeDeBarriere).toBe(false);
  expect(rapport.workerMort.kekRetenue).toBe(false);
  // L'état est celui que #25 NOMME. #163 y arrive ; #25 dit ce qu'il veut dire.
  expect([ETATS_DU_VOLUME.verrouille, ETATS_DU_VOLUME.indisponible]).toContain(rapport.etat);
  // L'interface de déverrouillage est REMONTÉE — montrée, pas actionnée.
  await expect(page.locator("#deverrouillage")).toBeVisible();
  return rapport;
}

test("un Worker qui JETTE est constaté, et la coquille refuse tout service", async ({
  page,
}, info) => {
  await substituerLeWorker(page, WORKER_QUI_JETTE);
  await page.goto(`${SHELL_ORIGIN}/index.html`);
  const rapport = await exigerLaConduite(page, "erreur");
  await info.attach(`mort-erreur-${info.project.name}.json`, {
    body: JSON.stringify(rapport.workerMort, null, 2),
    contentType: "application/json",
  });

  // Aucun cadre : l'étape 3 n'a jamais rien conclu, donc `peutEncadrer` refuse. Une coquille dont
  // le Worker est mort n'ouvre pas une frontière vers le territoire du guest.
  expect(rapport.cadreApplicatif).toBe("non-cree");
  expect(rapport.portOctroye).toBe(false);
});

test("un geste présenté après la mort ne DÉRIVE rien : il reçoit le refus, tout de suite", async ({
  page,
}) => {
  await substituerLeWorker(page, WORKER_QUI_JETTE);
  await page.goto(`${SHELL_ORIGIN}/index.html`);
  await exigerLaConduite(page, "erreur");

  // Argon2id coûte deux secondes sur le moteur le plus lent (ADR 0021, § Mesures). Le refus arrive
  // en bien moins que cela, et c'est la mesure qui distingue « refusé avant de dériver » de
  // « dérivé puis refusé ». La borne est large pour ne pas mesurer la lenteur de l'exécutant.
  await page.fill("#saisie-phrase", "une phrase qui ne sera jamais dérivée");
  const debut = Date.now();
  await page.click("#ouvrir-par-phrase");
  await expect(page.locator("#deverrouillage-refus")).toContainText(
    CODES_REFUS_COQUILLE.workerMort,
    { timeout: DELAI },
  );
  expect(Date.now() - debut, "le refus arrive avant qu'une dérivation ait pu tourner").toBeLessThan(
    1500,
  );
});

test("un Worker MUET est constaté par la borne, et non attendu pour toujours", async ({ page }) => {
  test.setTimeout(180_000);
  await substituerLeWorker(page, WORKER_MUET);
  await page.goto(`${SHELL_ORIGIN}/index.html`);
  // La borne est `DELAI_WORKER_MORT_MS` — trente secondes, nommées dans
  // `src/coquille/moyens-de-deverrouillage.mjs` avec leur motif. C'est la seule des trois causes
  // qu'aucun événement ne signale : un Worker qui vit et se tait est indistinguable d'un Worker
  // lent, et seule une borne les sépare.
  await exigerLaConduite(page, "silence");
});

test("la FERMETURE PROPRE est la troisième cause, et la coquille se la donne à elle-même", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  await page.click("#fermer-le-coffre");
  const rapport = await exigerLaConduite(page, "terminaison");

  // La fermeture a bien eu lieu AVANT le `terminate()` : les étapes 5, 6 et 7 sont conclues, et
  // l'étape 6 est inscrite `banc` plutôt que passée sous silence — l'export et la migration vivent
  // encore dans `public/vm/`.
  const parEtape = new Map(rapport.cycle.map((inscrite) => [inscrite.etape, inscrite]));
  // L'étape 5 est `differee`, et NON `franchie` : aucune application n'a démarré, donc aucun guest
  // n'a écrit et aucune barrière n'a été acquittée. Elle était conclue `franchie` à toute fermeture
  // — le journal affirmait le faux, et cette épreuve gravait le défaut (constat 3 de la revue de la
  // PR #171). L'E2E, lui, la lit `franchie` : c'est là qu'un guest écrit.
  expect(parEtape.get("ecritureEtBarriere").issue).toBe(ISSUES_DETAPE.differee);
  expect(parEtape.get("exportEtMigration").issue).toBe(ISSUES_DETAPE.banc);
  expect(parEtape.get("fermeture").issue).toBe(ISSUES_DETAPE.franchie);
  expect(parEtape.get("reprise").issue).toBe(ISSUES_DETAPE.differee);
  expect(parEtape.get("fermeture").instantMs).toBeGreaterThanOrEqual(
    parEtape.get("cadreEtPort").instantMs,
  );

  // LE CADRE LIT L'ÉTAT PAR SON GESTE-REQUÊTE. C'est la moitié de la conduite que le document
  // applicatif peut observer : il ne reçoit ni refus nouveau, ni silence — le geste ADMIS reste
  // admis et rend l'état, parce que répondre par un refus là où l'état existe ferait perdre au
  // cadre la seule chose qu'il ait le droit de savoir.
  //
  // Ce qu'il lit est `verrouille` — ou `indisponible` sur un moteur qui n'a jamais rien pu ouvrir.
  // La mort n'invente pas un verrou sur WebKit, et la suite le DÉCLARE au lieu de passer au vert
  // par vacuité : `rapport.etat` ci-dessus dit lequel des deux ce moteur a rendu.
  const cadre = page.frameLocator("#document-applicatif");
  await cadre.locator("#document-applicatif-demander").click();
  await expect
    .poll(
      async () =>
        JSON.parse(await cadre.locator("#document-applicatif-rapport").textContent()).etat,
      { timeout: DELAI },
    )
    .toBe(rapport.etat);
  expect([ETATS_DU_VOLUME.verrouille, ETATS_DU_VOLUME.indisponible]).toContain(rapport.etat);
});

// --- Le BATTEMENT : un Worker qui répond n'est jamais déclaré mort ---------------------------------

test("un Worker VIVANT mais lent n'est jamais déclaré mort, et la fermeture reste atteignable", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await substituerLeWorker(page, WORKER_LENT);
  await ouvrirLaCoquille(page);

  // Quarante secondes de geste, sous une borne de trente. C'est le battement — et lui seul — qui
  // sépare « il ne répond pas encore » de « il ne répondra plus ».
  const debut = Date.now();
  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).toContainText("cycle:sans-application", {
    timeout: 120_000,
  });
  const ecoule = Date.now() - debut;
  await info.attach(`battement-${info.project.name}.json`, {
    body: JSON.stringify({ ecouleMs: ecoule, releve: (await releve(page)).workerMort }, null, 2),
    contentType: "application/json",
  });
  expect(ecoule, "le geste a bien duré plus que la borne de mort").toBeGreaterThan(30_000);

  const rapport = await releve(page);
  expect(rapport.workerMort, "aucune mort constatée sur un Worker qui bat").toBeNull();
  await expect(page.locator("html")).not.toHaveAttribute("data-coquille", "worker-mort");

  // Et la FERMETURE PROPRE reste atteignable — c'est ce que la mort à tort rendait impossible dans
  // le cas même pour lequel la fermeture est écrite.
  await page.click("#fermer-le-coffre");
  await expect(page.locator("#cycle-etat")).not.toHaveText("cycle:fermeture-en-cours", {
    timeout: 120_000,
  });
});

// --- Le geste qui ROUVRE ---------------------------------------------------------------------------

test("un geste explicite ROUVRE la coquille après la mort, et rejoue le cycle", async ({
  page,
}) => {
  await ouvrirLaCoquille(page);
  await page.click("#fermer-le-coffre");
  await exigerLaConduite(page, "terminaison");

  // Le bouton n'existe visiblement QU'APRÈS une mort : la coquille ne propose pas de se recharger
  // à qui n'en a pas besoin.
  const rouvrir = page.locator("#rouvrir-la-coquille");
  await expect(rouvrir).toBeVisible();
  await rouvrir.click();

  // Le cycle est REJOUÉ depuis l'étape 1 : c'est ce que « refuser tout service jusqu'à un geste
  // explicite » promet, et ce qu'aucun geste ne tenait avant (constat 5 de la revue de la PR #171).
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });
  const rapport = await releve(page);
  expect(rapport.workerMort).toBeNull();
  expect(rapport.cycle.map(({ etape }) => etape)).toEqual([
    "identites",
    "exclusiviteEtCanal",
    "backendPuisVm",
    "cadreEtPort",
  ]);
});

test("le bouton de réouverture reste CACHÉ tant qu'aucune mort n'a été constatée", async ({
  page,
}) => {
  // Un témoin négatif : sans lui, « visible après la mort » passerait aussi bien sur un bouton
  // toujours visible.
  await ouvrirLaCoquille(page);
  await expect(page.locator("#rouvrir-la-coquille")).toBeHidden();
});

// --- Le DESCRIPTEUR d'application, contre le serveur RÉEL ------------------------------------------

test("sans descripteur servi, le démarrage rend `applicationAbsente` et le journal le dit", async ({
  page,
}, info) => {
  test.setTimeout(180_000);
  await ouvrirLaCoquille(page);
  const initial = await releve(page);
  // Sur un moteur qui n'atteint aucun volume, rien ne s'ouvre : l'ordre refuse avant le descripteur,
  // et la suite le DÉCLARE plutôt que de passer au vert par vacuité.
  test.skip(
    initial.etat === ETATS_DU_VOLUME.indisponible,
    "ce moteur n'atteint aucun volume : le backend ne s'ouvre pas, donc l'étape 3 refuse avant de lire le descripteur",
  );

  // Un vrai déverrouillage : c'est la seule façon d'atteindre `lireLeDescripteur` contre le serveur
  // réel, puisque l'ordre refuse tout démarrage sur un backend fermé.
  await page.fill("#saisie-phrase", "une phrase de scenario assez longue pour la calibration");
  await page.click("#ouvrir-par-phrase");
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: 120_000 })
    .toBe(ETATS_DU_VOLUME.ouvert);

  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).toContainText("cycle:sans-application", {
    timeout: 120_000,
  });
  const rapport = await releve(page);
  await info.attach(`descripteur-${info.project.name}.json`, {
    body: JSON.stringify(rapport.application, null, 2),
    contentType: "application/json",
  });

  // `npm run check` tourne sans les artefacts de l'image de référence : l'origine ne sert AUCUN
  // descripteur, et la coquille le dit au lieu d'échouer. C'est le seul chemin par lequel
  // `lireLeDescripteur` est exercé contre un serveur, et non contre un double.
  expect(rapport.application.demarree).toBe(false);
  expect(rapport.application.code).toBe(CODES_REFUS_COQUILLE.applicationAbsente);
  expect(rapport.application.motif).toMatch(/404|descripteur/);

  // Et l'étape 3 est RÉVISÉE : elle ne reste pas `differee` sur un geste qui a eu lieu.
  const inscrites = rapport.cycle.filter(({ etape }) => etape === "backendPuisVm");
  expect(inscrites).toHaveLength(2);
  expect(inscrites[0].issue).toBe(ISSUES_DETAPE.differee);
  expect(inscrites[1].issue).toBe(ISSUES_DETAPE.indisponible);
  expect(inscrites[1].revision).toBe(true);
});
