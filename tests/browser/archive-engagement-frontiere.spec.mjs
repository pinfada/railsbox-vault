import { expect, test } from "../support/test.mjs";

import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

// FRONTIÈRE de l'ENGAGEMENT D'ARCHIVE, sur les trois moteurs (#181, ADR 0034 ; `SEC-GEN-001`).
//
// Ce que cette suite établit, et qui ne se démontre pas sous Node :
//
//  1. **le mélange A/C de la revue externe est refusé sur l'OPFS RÉEL**, dans un Worker dédié, par
//     le même code typé que sur le double. Les six étapes du relecteur sont rejouées telles quelles,
//     et l'adversaire n'a PAS la clé : il reprend l'archive légitime de C, y remplace le contenu par
//     le mélange, et recalcule les seules empreintes SHA-256 publiques ;
//  2. **le voisin `<volume>.engagement` est un fichier de l'OPFS**, et sa CONSOMMATION en est une
//     suppression — un fait qu'aucun double en mémoire ne peut établir ;
//  3. **le retirer fait REFUSER**, et non ouvrir. C'est la seconde épreuve rouge de la Definition of
//     Ready de #181 : sans elle, la correction serait contournable par une commande `rm` ;
//  4. **le témoin positif** : l'archive intacte se restaure, s'ouvre, écrit sa racine initiale et
//     rend l'état qu'elle porte. Sans lui, un refus universel passerait pour une correction.
//
// Elle tourne sur les trois moteurs de la matrice #2, comme les autres frontières de stockage : une
// propriété d'ouverture ne s'applique pas de la même façon d'un moteur à l'autre, et la mesurer sur
// le seul moteur par défaut publierait une garantie que les deux autres ne tiennent peut-être pas.
//
// Sur un moteur sans OPFS synchrone dans un Worker — WebKit, que `docs/compatibility.md` classe déjà
// « refusé (OPFS absent) » — la suite n'est pas ignorée : elle EXIGE un refus typé. Un plantage non
// typé, ou pire un succès, la ferait échouer.

function codeDuRefus(error) {
  const trouve = String(error?.message ?? "").match(/VAULT_[A-Z_]+/);
  return trouve ? trouve[0] : null;
}

async function ouvrirBanc(page) {
  await page.goto("/vm/engagement.html");
  await expect(page.locator("#etat")).toHaveText("Worker d'engagement prêt.");
}

function executer(page, payload) {
  return page.evaluate((options) => globalThis.bancEngagement.executer(options), payload);
}

async function executerOuRefus(page, payload) {
  try {
    return { report: await executer(page, payload), code: null };
  } catch (error) {
    return { report: null, code: codeDuRefus(error), message: String(error?.message ?? error) };
  }
}

/** Ouvre le banc et mesure ce que le moteur offre au Worker. */
async function contexte(page, testInfo) {
  await ouvrirBanc(page);
  const capacite = await executer(page, { scenario: "capacite" });
  await testInfo.attach(`engagement-capacite-${testInfo.project.name}.json`, {
    body: JSON.stringify(capacite, null, 2),
    contentType: "application/json",
  });
  const porte =
    capacite.workerGetDirectory === "function" &&
    capacite.workerCreateSyncAccessHandle === "function" &&
    capacite.openCode === null;
  return { capacite, porte };
}

test("le mélange A/C est REFUSÉ sur l'OPFS réel, ou le moteur refuse typé", async ({
  page,
}, testInfo) => {
  const { capacite, porte } = await contexte(page, testInfo);

  if (testInfo.project.name.endsWith("chromium")) {
    // Chromium est le moteur du contrôle obligatoire : perdre la capacité doit bloquer une PR.
    expect(capacite.workerGetDirectory).toBe("function");
    expect(capacite.openCode).toBeNull();
  }

  const resultat = await executerOuRefus(page, { scenario: "melange" });
  const { report, code } = resultat;
  await testInfo.attach(`engagement-melange-${testInfo.project.name}.json`, {
    body: JSON.stringify({ porte, report, code }, null, 2),
    contentType: "application/json",
  });

  if (!porte) {
    expect(code).toBe(STORAGE_ERROR_CODES.unsupported);
    return;
  }
  expect(report, `le scénario a échoué : ${resultat.message}`).not.toBeNull();
  // 1. LE MÉLANGE. La restauration passe — elle n'a pas la clé, et c'est une propriété qu'on garde ;
  //    l'OUVERTURE refuse, avant qu'aucun secteur ne soit déchiffré.
  expect(report.melangeRestaure, "la restauration ne juge pas ce qu'elle ne peut pas juger").toBe(
    true,
  );
  expect(report.melangeVoisinPose, "la restauration DÉPOSE l'engagement de l'archive").toBe(180);
  expect(report.melangeCode).toBe(STORAGE_ERROR_CODES.engagementInvalide);

  // 2. LE TÉMOIN POSITIF. Sans lui, un refus universel passerait pour une correction.
  expect(report.temoinEtat).toBe("initialisee");
  expect(report.temoinRacineInitiale, "une ouverture qui ÉCRIT le publie").toBe(true);
  expect(report.temoinMotif).toBe("engagement");
  expect(report.temoinSecteur1Nouveau, "le volume restauré rend l'état que l'archive porte").toBe(
    true,
  );

  // 3. LA CONSOMMATION. Le voisin est VIDÉ — zéro octet —, et non supprimé : un Worker dédié n'a pas
  //    de handle de répertoire, donc pas de suppression d'entrée, et la troncature est de toute
  //    façon le geste sûr sous coupure. Un fichier de zéro octet EST absent pour tout ce qui le lit,
  //    et c'est exactement ce que cette mesure constate sur l'OPFS RÉEL (§ 6.9 bis).
  expect(report.voisinApresOuverture, "l'engagement est CONSOMMÉ une fois").toBe(0);
  expect(report.ouvertureNormale, "la seconde ouverture passe par le chemin normal").toBe(true);

  // 4. LE VOISIN RETIRÉ. Le geste de l'adversaire, et il ne demande aucune clé.
  expect(report.voisinRetireCode).toBe(STORAGE_ERROR_CODES.volumeSansRacine);
});

test("rien de ce qui franchit le port ne porte la clé de volume", async ({ page }, testInfo) => {
  // La même mesure que la frontière d'enveloppe, sur ce banc-ci : le Worker rend des données JSON,
  // et l'épreuve FOUILLE tout ce qu'il a rendu depuis le chargement de la page. Un rapport trop
  // bavard, ou une erreur qui recopierait son contexte, ferait rougir cette assertion.
  const { porte } = await contexte(page, testInfo);
  await executerOuRefus(page, { scenario: "melange" });
  const tout = await page.evaluate(() => globalThis.bancEngagement.toutCeQuiAFranchiLePort());
  await testInfo.attach(`engagement-port-${testInfo.project.name}.json`, {
    body: JSON.stringify({ porte, octets: tout.length }, null, 2),
    contentType: "application/json",
  });

  const cle = Uint8Array.from({ length: 32 }, (_, index) => index % 256);
  const enHex = [...cle].map((octet) => octet.toString(16).padStart(2, "0")).join("");
  const enJson = [...cle].join(",");
  expect(tout.includes(enHex), "la clé de volume de TEST a franchi le port, en hexadécimal").toBe(
    false,
  );
  expect(tout.includes(enJson), "la clé de volume de TEST a franchi le port, en JSON").toBe(false);
});

test("le COÛT de la vérification d'engagement est PUBLIÉ, moteur par moteur", async ({
  page,
}, testInfo) => {
  // Le seul geste coûteux du chemin de #181, et il ne se paie qu'à la PREMIÈRE ouverture d'un volume
  // restauré : le SHA-256 du fichier chiffré entier. Il est mesuré dans le Worker parce que le
  // hachage est en JavaScript PORTABLE — `sha256-stream.mjs`, faute d'un hachage incrémental dans
  // WebCrypto —, si bien que sa vitesse est celle du moteur.
  //
  // **AUCUN SEUIL n'est posé.** Le chiffre est publié en pièce jointe, pas jugé : poser un seuil sur
  // une machine de développement publierait une garantie que l'environnement de référence ne tient
  // pas. Ce que l'épreuve exige est que la mesure EXISTE et soit strictement positive.
  await ouvrirBanc(page);
  const { report, code } = await executerOuRefus(page, { scenario: "cout" });
  await testInfo.attach(`engagement-cout-${testInfo.project.name}.json`, {
    body: JSON.stringify({ report, code }, null, 2),
    contentType: "application/json",
  });

  expect(code, "le hachage ne dépend d'aucune capacité de stockage").toBeNull();
  expect(report.fichierOctets).toBe(512 * 1024 * 1024);
  expect(report.fichierMs).toBeGreaterThan(0);
  expect(report.regionMs).toBeGreaterThan(0);
});
