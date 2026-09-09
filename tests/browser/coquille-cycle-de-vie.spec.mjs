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

import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { ETAPES_DU_CYCLE, ISSUES_DETAPE } from "../../src/coquille/cycle-de-vie.mjs";
import { ETATS_DU_VOLUME } from "../../src/coquille/etat-de-la-coquille.mjs";
import { DELAI_INACTIVITE_MINIMUM_MS } from "../../src/coquille/verrouillage.mjs";

/** Le délai des gestes de cette suite. La borne de mort du Worker est de trente secondes. */
const DELAI = 90_000;

/** Le relevé public de la coquille, tel que le nœud le publie. */
async function releve(page) {
  return JSON.parse(await page.locator("#coquille-rapport").textContent());
}

/**
 * Ouvre la coquille et attend qu'elle se déclare prête.
 *
 * `commit` plutôt que le `load` par défaut : le `load` du document attend le cadre applicatif, créé
 * dynamiquement sur une autre origine, alors que le signal qui compte est celui que le PRODUIT écrit
 * — la ligne suivante. Le couplage a produit des expirations sur Firefox (revue de la PR #177).
 */
async function ouvrirLaCoquille(page) {
  await page.goto(`${SHELL_ORIGIN}/index.html`, { waitUntil: "commit" });
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

/**
 * La CLÉ sous laquelle l'épreuve range le relevé qu'elle a capturé avant le rechargement. Elle
 * appartient à l'ÉPREUVE — le produit n'écrit rien dans `sessionStorage`, et la sonde
 * d'exfiltration de `coquille-deverrouillage.spec.mjs` le mesure.
 */
const CLE_DE_CAPTURE = "epreuve-verrouillage-169";

/**
 * ARME la capture du relevé publié JUSTE AVANT le rechargement (#169, ADR 0031).
 *
 * ## Pourquoi une instrumentation, et pourquoi du côté de l'ÉPREUVE
 *
 * Un verrouillage se termine par un rechargement de la coquille : le document qui porte le relevé
 * disparaît une tâche après l'avoir publié, et une lecture par sondage arriverait après la
 * navigation. Ce qui est mesuré ici — l'état atteint, le déclencheur, la mesure — n'existe que dans
 * cette fenêtre-là, et elle est réelle : c'est le dernier mot de la session.
 *
 * L'instrumentation est celle de la sonde de #162, et pour le même motif : « la sonde est
 * instrumentée par l'ÉPREUVE, jamais par le produit ». Rendre au produit une poignée de test — un
 * `globalThis.__dernierVerrouillage` — reviendrait à rouvrir la porte que #162 a fermée pour la
 * commodité d'une épreuve. Un `MutationObserver` posé par `addInitScript` observe l'attribut que la
 * coquille écrit ; son rappel est un MICROTÂCHE, donc il s'exécute avant le `setTimeout` qui porte
 * le rechargement. La capture n'est pas une course : elle est ordonnée par la plate-forme.
 *
 * `sessionStorage` est employé parce qu'il est le seul stockage qui SURVIT au rechargement dans le
 * même onglet et meurt avec lui.
 */
async function armerLaCapture(page) {
  await page.addInitScript((cle) => {
    // Le script d'initialisation s'exécute dans CHAQUE document du contexte, à l'instant où il
    // commence — la coquille, le cadre applicatif inter-origine, et les documents vides que le
    // navigateur crée en chemin. Dans certains d'entre eux, `document.documentElement` n'existe pas
    // encore, et `observe()` y jette « parameter 1 is not of type 'Node' » : une erreur de PAGE, que
    // le scénario de bout en bout compte et refuse à juste titre. Le branchement est donc DIFFÉRÉ
    // jusqu'à ce qu'il y ait un élément racine à observer, et il ne jette jamais.
    const brancher = () => {
      const racine = document?.documentElement;
      if (!racine) return false;
      new MutationObserver(() => {
        if (racine.dataset.coquille !== "verrouille") return;
        const noeud = document.querySelector("#coquille-rapport");
        if (noeud !== null) sessionStorage.setItem(cle, noeud.textContent);
      }).observe(racine, { attributes: true, attributeFilter: ["data-coquille"] });
      return true;
    };
    try {
      if (brancher()) return;
    } catch {
      /* un document qui refuse l'observation n'est pas celui de la coquille */
    }
    addEventListener(
      "DOMContentLoaded",
      () => {
        try {
          brancher();
        } catch {
          /* idem */
        }
      },
      { once: true },
    );
  }, CLE_DE_CAPTURE);
}

/**
 * Ce que l'épreuve a capturé, ou `null` si la coquille ne s'est pas encore verrouillée.
 *
 * L'évaluation est GARDÉE, et ce n'est pas une commodité : le verrouillage se termine par un
 * rechargement, et une évaluation posée pendant la navigation voit son contexte d'exécution détruit.
 * WebKit le rend comme une erreur là où Chromium l'absorbe. L'échec n'est pas un défaut — c'est
 * exactement ce que l'épreuve mesure —, et la question se repose au tour suivant, sur le document
 * qui revient.
 */
async function riendeCapture(page) {
  try {
    return await page.evaluate((cle) => sessionStorage.getItem(cle), CLE_DE_CAPTURE);
  } catch {
    return null;
  }
}

/**
 * Attend, puis rend, le relevé capturé avant le rechargement.
 *
 * La valeur est retenue PAR le sondage, et non relue après lui : entre le tour qui l'a vue et une
 * seconde lecture, la navigation du rechargement peut détruire le contexte, et la relecture rendrait
 * `null` sur un relevé pourtant capturé. C'est le défaut que WebKit a montré ; Chromium l'absorbait.
 */
async function captureDuVerrouillage(page, budgetMs = DELAI) {
  let capture = null;
  await expect
    .poll(
      async () => {
        capture = await riendeCapture(page);
        return capture;
      },
      { timeout: budgetMs },
    )
    .not.toBeNull();
  return JSON.parse(capture);
}

/**
 * SERT le module de verrouillage avec un délai d'inactivité COURT, pris entre les bornes que le
 * produit tient lui-même.
 *
 * Le délai est réglable par SESSION et n'a aucune interface dans cette tranche (YAGNI écrit,
 * ADR 0031 décision 2) : il n'y a donc pas de bouton par lequel une épreuve pourrait l'abaisser.
 * L'interception est du côté du RÉSEAU, exactement comme la substitution du Worker de confiance —
 * là où le produit n'a rien à dire. Ce qui est servi est le fichier RÉEL du dépôt, avec une seule
 * constante remplacée par une valeur que `delaiDInactivite` accepte : l'épreuve mesure donc le
 * produit, et non un double.
 */
async function servirUnDelaiCourt(page, delaiMs) {
  const source = await readFile(
    new URL("../../src/coquille/verrouillage.mjs", import.meta.url),
    "utf8",
  );
  const abaisse = source.replace(
    "export const DELAI_INACTIVITE_MS = 600_000;",
    `export const DELAI_INACTIVITE_MS = ${delaiMs};`,
  );
  expect(
    abaisse,
    "la constante du délai n'a pas été trouvée : l'épreuve mesurerait dix minutes",
  ).not.toBe(source);
  await page.context().route("**/src/coquille/verrouillage.mjs", (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/javascript; charset=utf-8",
      body: abaisse,
    }),
  );
}

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

test("un Worker MUET est constaté par la borne, et non attendu pour toujours", async ({
  page,
  browserName,
}) => {
  // UN moteur, et c'est une décision de COÛT assumée : ce que cette épreuve mesure est une BORNE
  // DE TEMPS — trente secondes d'attente —, et une minuterie ne dépend pas du moteur. Ce qui en
  // dépend est la LIVRAISON d'un événement, et c'est mesuré sur les trois moteurs par les épreuves
  // de l'erreur et de la terminaison, qui ne coûtent rien. Trois fois trente secondes dans
  // `npm run check` seraient trois fois le même verdict, payé sur le seul gate obligatoire.
  test.skip(
    browserName !== "chromium",
    "borne de temps : un moteur suffit, les trois coûtent 90 s",
  );
  test.setTimeout(180_000);
  await substituerLeWorker(page, WORKER_MUET);
  await page.goto(`${SHELL_ORIGIN}/index.html`);
  // La borne est `DELAI_WORKER_MORT_MS` — trente secondes, nommées dans
  // `src/coquille/moyens-de-deverrouillage.mjs` avec leur motif. C'est la seule des trois causes
  // qu'aucun événement ne signale : un Worker qui vit et se tait est indistinguable d'un Worker
  // lent, et seule une borne les sépare.
  await exigerLaConduite(page, "silence");
});

test("le VERROUILLAGE est la troisième cause, et la coquille se la donne à elle-même", async ({
  page,
}) => {
  await armerLaCapture(page);
  await ouvrirLaCoquille(page);
  await page.click("#verrouiller-le-coffre");
  const rapport = await captureDuVerrouillage(page);
  expect(rapport.workerMort.cause).toBe("terminaison");
  expect(rapport.workerMort.code).toBe(CODES_REFUS_COQUILLE.workerMort);
  expect(rapport.workerMort.derivationPermise).toBe(false);
  // LA POUSSÉE DE BARRIÈRE A CESSÉ. Il n'y a plus personne pour en acquitter une, et annoncer
  // celles d'avant ferait dire « enregistré » à une application sur un coffre qui ne l'est plus.
  expect(rapport.workerMort.pousseeDeBarriere).toBe(false);
  expect(rapport.workerMort.kekRetenue).toBe(false);
  expect([ETATS_DU_VOLUME.verrouille, ETATS_DU_VOLUME.indisponible]).toContain(rapport.etat);

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

  // LA MESURE, publiée SANS SEUIL et dans la seule fenêtre où elle existe.
  expect(typeof rapport.mesures.verrouillageMs).toBe("number");
  expect(rapport.verrouillage.declencheur).toBe("geste");
  expect(rapport.verrouillage.workerTermine).toBe(true);
  expect(rapport.verrouillage.rechargerLaCoquille).toBe(true);
  expect(rapport.verrouillage.instantaneRetire).toBe(false);
  expect(rapport.verrouillage.reouvertureAutomatique).toBe(false);
});

// --- Le RECHARGEMENT, et ce que le cadre lit ensuite -----------------------------------------------

test("le verrouillage RECHARGE la coquille, qui revient VERROUILLÉE sans que rien ait été dérivé", async ({
  page,
}, info) => {
  await armerLaCapture(page);
  await ouvrirLaCoquille(page);
  // « Prête » dit que le cadre est CRÉÉ ; son chargement est une suite d'allers-retours entre deux
  // origines, et l'attendre est ce qui distingue une mesure d'une course.
  await expect
    .poll(async () => (await releve(page)).cadreApplicatif, { timeout: DELAI })
    .toBe("charge");

  await page.click("#verrouiller-le-coffre");
  const auVerrouillage = await captureDuVerrouillage(page);

  // LE RECHARGEMENT. Il est le fait de la coquille elle-même, et c'est ce qui retire le cadre : les
  // pixels du cadre applicatif sont le dernier clair de la session. Aucun bouton n'est cliqué ici —
  // l'asymétrie avec la mort est exactement là.
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });
  const apres = await releve(page);
  await info.attach(`verrouillage-${info.project.name}.json`, {
    body: JSON.stringify(
      {
        auVerrouillage: auVerrouillage.verrouillage,
        mesures: auVerrouillage.mesures,
        apres: apres.etat,
      },
      null,
      2,
    ),
    contentType: "application/json",
  });

  // Le cycle est REJOUÉ depuis l'étape 1, et la session précédente n'a rien laissé dans le relevé.
  expect(apres.cycle.map(({ etape }) => etape)).toEqual([
    "identites",
    "exclusiviteEtCanal",
    "backendPuisVm",
    "cadreEtPort",
  ]);
  expect(apres.workerMort, "la coquille rechargée n'est pas une coquille morte").toBeNull();
  expect(apres.verrouillage, "le relevé de la session verrouillée ne survit pas").toBeNull();

  // CE N'EST PAS UNE RÉOUVERTURE : l'état est `verrouille` (ou `indisponible` sur un moteur qui ne
  // sait rien ouvrir), l'interface de déverrouillage est là, et AUCUNE dérivation n'a eu lieu — le
  // relevé de #162 ne porte ni annonce ni déverrouillage mesuré.
  expect([ETATS_DU_VOLUME.verrouille, ETATS_DU_VOLUME.indisponible]).toContain(apres.etat);
  await expect(page.locator("#deverrouillage")).toBeVisible();
  expect(apres.mesures.deverrouillageMs).toBeNull();
  expect(apres.mesures.annonceApresLeGesteMs).toBeNull();
  // Le bouton « Rouvrir le coffre » reste caché : il appartient à la MORT, pas au verrouillage.
  await expect(page.locator("#rouvrir-la-coquille")).toBeHidden();

  // LE CADRE LIT L'ÉTAT PAR SON GESTE-REQUÊTE. C'est la moitié de la conduite que le document
  // applicatif peut observer : il ne reçoit ni refus nouveau, ni silence — le geste ADMIS reste
  // admis et rend l'état, parce que répondre par un refus là où l'état existe ferait perdre au
  // cadre la seule chose qu'il ait le droit de savoir.
  //
  // Ce qu'il lit est `verrouille` — ou `indisponible` sur un moteur qui n'a jamais rien pu ouvrir.
  // Le verrouillage n'invente pas un verrou sur WebKit, et la suite le DÉCLARE au lieu de passer au
  // vert par vacuité : `apres.etat` ci-dessus dit lequel des deux ce moteur a rendu.
  const cadre = page.frameLocator("#document-applicatif");
  await cadre.locator("#document-applicatif-demander").click();
  await expect
    .poll(
      async () =>
        JSON.parse(await cadre.locator("#document-applicatif-rapport").textContent()).etat,
      { timeout: DELAI },
    )
    .toBe(apres.etat);
});

// --- Le BATTEMENT : un Worker qui répond n'est jamais déclaré mort ---------------------------------

test("un Worker VIVANT mais lent n'est jamais déclaré mort, et la fermeture reste atteignable", async ({
  page,
  browserName,
}, info) => {
  // UN moteur, pour le motif de l'épreuve précédente : quarante secondes d'attente mesurent une
  // borne et un battement, non un comportement de moteur.
  test.skip(
    browserName !== "chromium",
    "borne de temps : un moteur suffit, les trois coûtent 120 s",
  );
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

  // Et le VERROUILLAGE reste atteignable — c'est ce que la mort à tort rendait impossible dans le
  // cas même pour lequel il est écrit.
  await page.click("#verrouiller-le-coffre");
  await expect(page.locator("#cycle-etat")).not.toHaveText("cycle:verrouillage-en-cours", {
    timeout: 120_000,
  });
});

// --- Le geste qui ROUVRE ---------------------------------------------------------------------------

test("un geste explicite ROUVRE la coquille après la mort, et rejoue le cycle", async ({
  page,
}) => {
  // La MORT, et non le verrouillage : le bouton « Rouvrir le coffre » appartient au chemin
  // ACCIDENTEL. Un verrouillage voulu recharge de lui-même, et c'est l'asymétrie de l'ADR 0031.
  await substituerLeWorker(page, WORKER_QUI_JETTE);
  await page.goto(`${SHELL_ORIGIN}/index.html`);
  await exigerLaConduite(page, "erreur");

  // Le bouton n'existe visiblement QU'APRÈS une mort : la coquille ne propose pas de se recharger
  // à qui n'en a pas besoin.
  const rouvrir = page.locator("#rouvrir-la-coquille");
  await expect(rouvrir).toBeVisible();
  await rouvrir.click();

  // Le cycle est REJOUÉ depuis l'étape 1 : c'est ce que « refuser tout service jusqu'à un geste
  // explicite » promet, et ce qu'aucun geste ne tenait avant (constat 5 de la revue de la PR #171).
  // Le RECHARGEMENT doit servir le VRAI Worker, sans quoi la coquille rouvrirait sur le module qui
  // vient de la tuer. La substitution n'est pas RETIRÉE — `unrouteAll` ne dit pas ce qu'il advient
  // d'une requête déjà interceptée, et une requête laissée en suspens fait attendre la coquille sur
  // un Worker qui ne sera jamais chargé. Elle est RECOUVERTE : la règle posée en dernier l'emporte,
  // et celle-ci laisse simplement passer.
  await page.context().route("**/runtime-worker.mjs*", (route) => route.continue());
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
//
// Ces deux épreuves sont les SEULES qui atteignent `lireLeDescripteur` autrement que par un double :
// partout ailleurs, un `recuperer` injecté tient la place du réseau. Elles ouvrent donc un coffre
// pour de bon — l'ordre refuse tout démarrage sur un backend fermé — et paient une dérivation
// Argon2id pour cela.
//
// **Ce que la réponse du serveur est, elles la DÉCIDENT.** Une première rédaction s'en remettait à
// l'absence du fichier sur le disque, et cette absence a cessé d'être vraie dès qu'une machine a
// construit l'image de référence : la coquille s'est mise à installer un demi-gibioctet et à booter
// Rails **à l'intérieur de `npm run check`**. Une épreuve dont le verdict dépend de ce qui traîne
// sur le disque de qui la joue n'est pas une épreuve.
//
// **Un seul moteur, et c'est une décision de coût** : ce qu'elles mesurent est une REQUÊTE HTTP et
// une FORME, non un comportement de moteur — et elles coûtent chacune un déverrouillage complet.
// Ce qui dépend du moteur, l'ordre et son refus, est mesuré sur les trois juste au-dessus.

/** Substitue la réponse du serveur au descripteur d'application, quelle que soit la machine. */
async function servirLeDescripteur(page, reponse) {
  await page.context().route("**/artifacts/application.json", (route) => route.fulfill(reponse));
}

/** OUVRE le coffre par la phrase, seul chemin qui mène à l'étape 3. */
async function ouvrirParLaPhrase(page) {
  await page.fill("#saisie-phrase", "une phrase de scenario assez longue pour la calibration");
  await page.click("#ouvrir-par-phrase");
  await expect
    .poll(async () => (await releve(page)).etat, { timeout: 120_000 })
    .toBe(ETATS_DU_VOLUME.ouvert);
}

/** Ouvre, déverrouille, démarre, et rend le relevé — ou déclare pourquoi ce moteur ne peut pas. */
async function demarrerSurUnCoffreOuvert(page, browserName, reponse) {
  test.skip(
    browserName !== "chromium",
    "requête HTTP et forme : un moteur suffit, trois coûtent trois déverrouillages",
  );
  test.setTimeout(180_000);
  await servirLeDescripteur(page, reponse);
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  await page.click("#demarrer-application");
  await expect(page.locator("#cycle-etat")).toContainText("cycle:sans-application", {
    timeout: 120_000,
  });
  return releve(page);
}

test("un descripteur ABSENT rend `applicationAbsente`, et le journal révise l'étape 3", async ({
  page,
  browserName,
}, info) => {
  const rapport = await demarrerSurUnCoffreOuvert(page, browserName, { status: 404, body: "" });
  await info.attach(`descripteur-absent-${info.project.name}.json`, {
    body: JSON.stringify(rapport.application, null, 2),
    contentType: "application/json",
  });

  // L'origine ne sert aucun descripteur : la coquille le DIT au lieu d'échouer. C'est le seul
  // chemin par lequel `lireLeDescripteur` est exercé contre un serveur, et non contre un double.
  expect(rapport.application.demarree).toBe(false);
  expect(rapport.application.code).toBe(CODES_REFUS_COQUILLE.applicationAbsente);
  expect(rapport.application.motif).toMatch(/404/);

  // Et l'étape 3 est RÉVISÉE : elle ne reste pas `differee` sur un geste qui a eu lieu.
  const inscrites = rapport.cycle.filter(({ etape }) => etape === "backendPuisVm");
  expect(inscrites).toHaveLength(2);
  expect(inscrites[0].issue).toBe(ISSUES_DETAPE.differee);
  expect(inscrites[1].issue).toBe(ISSUES_DETAPE.indisponible);
  expect(inscrites[1].revision).toBe(true);
});

test("un descripteur MALFORMÉ est refusé sur sa forme, et le motif nomme le champ", async ({
  page,
  browserName,
}) => {
  // La version seule ne suffisait pas : un descripteur d'une version connue fournit six URL, une
  // ligne de commande de noyau et deux grandeurs d'allocation au Worker de confiance. Celui-ci
  // porte un préfixe qui sort du chemin servi — la CSP le refuserait ensuite, mais une frontière
  // qui ne tient que par la seconde ligne de défense n'est pas une frontière.
  const rapport = await demarrerSurUnCoffreOuvert(page, browserName, {
    status: 200,
    contentType: "application/json",
    body: JSON.stringify({
      descripteurVersion: 1,
      application: { id: "railsbox-vault-reference", version: "1.0.0" },
      runtime: { version: "0.1.0" },
      disque: { nom: "reference-app.ext2", octets: 536870912 },
      boot: {
        cmdline: "root=/dev/sda rw",
        memoireOctets: 536870912,
        kernel: "reference-rootfs-vmlinuz",
        initrd: "reference-rootfs-initrd",
        rootfs: "reference-rootfs.ext4",
        bios: "seabios.bin",
        vgaBios: "vgabios.bin",
      },
      prefixeDesArtefacts: "https://ailleurs.test/",
    }),
  });

  expect(rapport.application.demarree).toBe(false);
  expect(rapport.application.code).toBe(CODES_REFUS_COQUILLE.applicationAbsente);
  expect(rapport.application.motif).toMatch(/préfixe/);
});

// --- Le DÉLAI D'INACTIVITÉ, mesuré pour de bon dans un navigateur ---------------------------------
//
// Les épreuves unitaires de `tests/unit/coquille-verrouillage.test.mjs` pilotent une horloge feinte,
// et c'est ce qui rend la règle éprouvable sans attendre dix minutes. Ce qu'elles ne peuvent pas
// dire est que la règle est BRANCHÉE : que le document de la coquille livre bien les événements
// nommés, qu'une minuterie du navigateur atteigne son échéance, et qu'un verrouillage déclenché par
// le temps fasse EXACTEMENT ce que le bouton fait. C'est ce que les deux épreuves suivantes
// mesurent, et elles paient du temps RÉEL pour cela.
//
// **Deux, et pas trois.** Une troisième vérifiait que la valeur PAR DÉFAUT de dix minutes n'était pas
// atteinte plus tôt ; elle a été retirée, et il faut dire pourquoi plutôt que de la laisser tomber
// en silence. Ce qu'elle affirmait de la CONSTANTE, l'unitaire l'affirme sans attendre (« le délai
// par défaut est de DIX MINUTES ») ; ce qu'elle affirmait du BRANCHEMENT, le témoin négatif
// ci-dessous l'affirme mieux — il montre qu'une minuterie réelle court ET se remet à zéro. Elle
// coûtait soixante-quinze secondes de plus sur le seul gate obligatoire, et une épreuve dont chaque
// affirmation est déjà tenue ailleurs n'achète que du temps d'attente.
//
// **Sur DEUX moteurs, et le motif a changé** (constat 1 de la revue de sécurité de la PR #174). La
// première rédaction ne les jouait que sur Chromium, en écrivant qu'une minuterie « ne dépend pas du
// moteur » — pendant que le dossier affirmait ailleurs que le délai était mesuré sur trois. Les deux
// ne pouvaient pas être vrais ensemble, et c'est le MOTIF qui était faux : ce qui est mesuré ici
// n'est pas une minuterie abstraite, c'est la LIVRAISON d'événements de document et l'étirement des
// minuteries par le moteur — et la revue relève des écarts réels de livraison du focus entre les
// trois. Elles sont donc jouées sur Chromium ET Firefox.
//
// WebKit reste hors de portée, non par économie mais parce que rien ne s'y OUVRE : sans coffre
// ouvert, aucune surveillance ne s'arme, et il n'y aurait rien à mesurer. La suite le DÉCLARE.

test("un coffre LAISSÉ se verrouille tout seul, et il le fait comme le bouton", async ({
  page,
  browserName,
}, info) => {
  // DEUX moteurs : ce qui est mesuré ici DÉPEND du moteur — la livraison des événements de document
  // et l'étirement des minuteries. WebKit est écarté parce que rien ne s'y ouvre, donc rien ne s'y
  // arme : c'est la limite du moteur, pas une économie de temps.
  test.skip(browserName === "webkit", "rien ne s'y verrouille : rien ne s'y ouvre");
  test.setTimeout(300_000);
  await servirUnDelaiCourt(page, DELAI_INACTIVITE_MINIMUM_MS);
  await armerLaCapture(page);
  await ouvrirLaCoquille(page);
  // LE DÉLAI N'EST ARMÉ QUE SUR UN COFFRE OUVERT : sans ce geste, l'épreuve attendrait une minuterie
  // qui n'a jamais été posée, et son échec dirait « rien ne s'est verrouillé » là où la règle dit
  // « il n'y avait rien à verrouiller ».
  await ouvrirParLaPhrase(page);

  // RIEN n'est fait pendant la minute : ni clic, ni frappe, ni focus. Le seul trafic est celui que
  // le cadre applicatif produit de lui-même — et il ne compte pas.
  const debut = Date.now();
  const rapport = await captureDuVerrouillage(page, 180_000);
  const ecoule = Date.now() - debut;
  await info.attach(`inactivite-${info.project.name}.json`, {
    body: JSON.stringify({ ecouleMs: ecoule, verrouillage: rapport.verrouillage }, null, 2),
    contentType: "application/json",
  });

  // LE MÊME RELEVÉ QUE LE GESTE, au déclencheur près. C'est tout ce que cette tranche promet : deux
  // déclencheurs, un seul chemin.
  expect(rapport.verrouillage.declencheur).toBe("inactivite");
  expect(rapport.verrouillage.delaiDInactiviteMs).toBe(DELAI_INACTIVITE_MINIMUM_MS);
  expect(rapport.verrouillage.workerTermine).toBe(true);
  expect(rapport.verrouillage.kekRetenue).toBe(false);
  expect(rapport.verrouillage.instantaneRetire).toBe(false);
  expect(rapport.workerMort.cause).toBe("terminaison");
  expect([ETATS_DU_VOLUME.verrouille, ETATS_DU_VOLUME.indisponible]).toContain(rapport.etat);
  expect(ecoule, "le verrouillage est arrivé avant son échéance").toBeGreaterThan(
    DELAI_INACTIVITE_MINIMUM_MS / 2,
  );

  // Et le rechargement suit, comme après le geste.
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "prete", { timeout: DELAI });
  expect((await releve(page)).verrouillage).toBeNull();
});

test("un coffre TENU ÉVEILLÉ par des gestes ne se verrouille pas — le témoin négatif du délai", async ({
  page,
  browserName,
}) => {
  // Sans ce témoin, l'épreuve précédente passerait aussi bien sur une coquille qui se verrouille
  // quoi qu'il arrive : « il s'est verrouillé après une minute » ne dit rien tant que « il ne s'est
  // pas verrouillé pendant qu'on travaillait » n'est pas mesuré. Sur les deux mêmes moteurs, et pour
  // le même motif.
  test.skip(browserName === "webkit", "rien ne s'y verrouille : rien ne s'y ouvre");
  test.setTimeout(300_000);
  await servirUnDelaiCourt(page, DELAI_INACTIVITE_MINIMUM_MS);
  await armerLaCapture(page);
  await ouvrirLaCoquille(page);
  await ouvrirParLaPhrase(page);
  // Le témoin n'a de valeur que si le délai est ARMÉ : sur un coffre qui n'est pas ouvert, il n'y a
  // rien à tenir éveillé, et l'épreuve serait verte par vacuité.
  expect((await releve(page)).etat).toBe(ETATS_DU_VOLUME.ouvert);

  // Une frappe toutes les six secondes pendant une minute et demie — c'est-à-dire une fois et demie
  // le délai. Un délai qui ne se remettrait pas à zéro aurait verrouillé au milieu.
  for (let tour = 0; tour < 15; tour += 1) {
    await page.locator("#saisie-phrase").press("a");
    await page.waitForTimeout(6_000);
  }
  expect(
    await riendeCapture(page),
    "la coquille s'est verrouillée pendant qu'on tapait",
  ).toBeNull();
  expect((await releve(page)).etat, "le coffre est resté ouvert").toBe(ETATS_DU_VOLUME.ouvert);
});

// --- Un verrouillage REFUSÉ (#169, ADR 0031 ; constat 3 de la revue de la PR #174) -----------------
//
// Le défaut que ces deux épreuves ferment était sévère et silencieux : un verrouillage refusé rendait
// la main sans rien dire, si bien que le coffre restait `ouvert`, le cadre applicatif affiché, et la
// surveillance désarmée — elle s'était désarmée AVANT d'appeler le geste, et rien ne la ré-armait.
// Le coffre restait ouvert pour toujours, sans que personne l'ait décidé.

/**
 * Un Worker qui parle le contrat et REFUSE la fermeture, par un refus TYPÉ.
 *
 * Il répond normalement à l'état et à l'inventaire — sans quoi la coquille ne se monterait pas —,
 * puis rend un refus sur le geste de fermeture. Le module est substitué au niveau du RÉSEAU, comme
 * les trois autres doubles de cette suite : le produit n'expose aucune poignée pour cela.
 */
const WORKER_QUI_REFUSE_LA_FERMETURE = `
import { TYPES_PRIVILEGIES, decoderMessage, enveloppeDeMessage } from "/src/coquille/contrat-de-messages.mjs";

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
    if (recu.type === TYPES_PRIVILEGIES.fermeture) {
      repondre(TYPES_PRIVILEGIES.refus, {
        code: "VAULT_STORAGE_CLOSED",
        message: "le volume était déjà fermé (double de l'épreuve #169)",
        correlation,
      });
    }
  });
  port.start();
});
`;

test("un verrouillage REFUSÉ ne laisse pas le coffre ouvert : il tue, il retire, et il le dit", async ({
  page,
}, info) => {
  await substituerLeWorker(page, WORKER_QUI_REFUSE_LA_FERMETURE);
  await ouvrirLaCoquille(page);
  await expect
    .poll(async () => (await releve(page)).cadreApplicatif, { timeout: DELAI })
    .toBe("charge");
  expect((await releve(page)).etat, "le double doit publier un coffre OUVERT").toBe(
    ETATS_DU_VOLUME.ouvert,
  );

  await page.click("#verrouiller-le-coffre");
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "verrouillage-refuse", {
    timeout: DELAI,
  });
  const rapport = await releve(page);
  await info.attach(`verrouillage-refuse-${info.project.name}.json`, {
    body: JSON.stringify({ verrouillage: rapport.verrouillage, etat: rapport.etat }, null, 2),
    contentType: "application/json",
  });

  // LE REFUS EST PUBLIÉ, avec sa cause, et c'est la première chose que le relevé porte.
  expect(rapport.verrouillage.refuse).toBe(true);
  expect(rapport.verrouillage.codeDuRefus).toBe("VAULT_STORAGE_CLOSED");
  // LE WORKER EST TERMINÉ quand même : il ne sert plus rien, et sa KEK est déjà partie par le
  // `finally` de `relacherTout`. La cause reste la TROISIÈME de la table de #163.
  expect(rapport.verrouillage.workerTermine).toBe(true);
  expect(rapport.workerMort.cause).toBe("terminaison");
  expect(rapport.workerMort.kekRetenue).toBe(false);
  expect([ETATS_DU_VOLUME.verrouille, ETATS_DU_VOLUME.indisponible]).toContain(rapport.etat);

  // LE CADRE EST RETIRÉ DU DOM. Laisser ses pixels sur un coffre dont l'utilisateur vient de
  // demander le verrouillage est le contraire de la promesse.
  expect(rapport.cadreApplicatif).toBe("retire");
  await expect(page.locator("#document-applicatif")).toHaveCount(0);
  // Et AUCUN port n'a été re-octroyé : la garde `VAULT_COQUILLE_ANNONCE_UNIQUE` de #161 reste
  // intacte, et le compteur d'octroi le dit.
  expect(rapport.portOctroye).toBe(true);

  // LA COQUILLE NE RECHARGE PAS : il s'est passé quelque chose, et cela doit se lire. Le bouton
  // « Rouvrir le coffre » de #163 est offert, et l'interface de déverrouillage est remontée.
  expect(rapport.verrouillage.rechargerLaCoquille).toBe(false);
  await expect(page.locator("#rouvrir-la-coquille")).toBeVisible();
  await expect(page.locator("#deverrouillage")).toBeVisible();

  // Et le relevé ANNONCE ce que la réouverture coûtera : la capture n'a peut-être pas eu lieu.
  expect(rapport.verrouillage.instantaneGaranti).toBe(false);
});

test("après un verrouillage refusé, plus aucun geste n'aboutit : la coquille est déjà morte", async ({
  page,
}) => {
  // Le témoin qui manquait : le délai est désarmé au refus COMME au succès, et le Worker est parti.
  // Une surveillance qui survivrait rechargerait la coquille sous les yeux de qui vient de lire
  // « le verrouillage a été refusé ».
  await substituerLeWorker(page, WORKER_QUI_REFUSE_LA_FERMETURE);
  await ouvrirLaCoquille(page);
  await page.click("#verrouiller-le-coffre");
  await expect(page.locator("html")).toHaveAttribute("data-coquille", "verrouillage-refuse", {
    timeout: DELAI,
  });

  // Un geste présenté après le refus reçoit le refus de la MORT, tout de suite : rien n'est dérivé.
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
