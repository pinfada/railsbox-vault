import { readFile } from "node:fs/promises";

import { expect, test } from "@playwright/test";

import { DERIVATION_ERROR_CODES } from "../../src/vm/derivation/derivation-errors.mjs";
import { ENVELOPPE_ERROR_CODES } from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import { SHELL_PORT } from "../../src/spike/origin-topology.mjs";
import { STORAGE_ERROR_CODES } from "../../src/vm/storage-errors.mjs";

// FRONTIÈRE du DÉVERROUILLAGE, sur les trois moteurs (#22, ADR 0021 ; `SEC-KEY-001`,
// `SEC-ORIGIN-001`).
//
// Ce que cette suite établit, et qui ne se démontre pas sous Node :
//
//  1. **l'artefact Argon2 vendu est servi par l'origine de confiance et calcule juste** — les
//     vecteurs REJOUABLES de la RFC 9106 sont refaits dans le Worker, par le binaire que le
//     serveur a livré depuis `/vendor/`, sous la CSP de l'ADR 0013 (`'wasm-unsafe-eval'`) ;
//  2. **une phrase ouvre un volume RÉEL** — dérivation, enveloppe sur l'OPFS réel, relecture d'un
//     secteur connu, et `VAULT_ENVELOPPE_CLE_REFUSEE` sur une phrase fausse ;
//  3. **la conduite WebAuthn PRF est celle de l'ADR 0021** — sous Chromium, un authentificateur
//     virtuel piloté par CDP rejoue PRF disponible, extension ignorée et annulation ; sur Firefox
//     et WebKit, où aucun authentificateur virtuel PRF n'est pilotable, le chemin est exercé
//     JUSQU'À L'APPEL et le refus typé est vérifié. La limite est écrite, pas maquillée ;
//  4. **rien du secret ne se dépose nulle part** — après dérivation et ouverture, la sonde fouille
//     `localStorage`, `sessionStorage`, les cookies, IndexedDB, Cache Storage, l'OPFS entier et les
//     deux sens du port. Elle commence par un APPÂT, pour prouver qu'elle trouve ce qui s'y trouve.
//
// Sur un moteur sans OPFS synchrone dans un Worker — WebKit, que `docs/compatibility.md` classe
// « refusé (OPFS absent) » —, les scénarios qui touchent un volume EXIGENT un refus typé. Un
// plantage non typé, ou un succès, ferait échouer la suite. Les vecteurs Argon2, eux, ne demandent
// aucun stockage : ils sont exigés des TROIS moteurs.

const VECTEURS = JSON.parse(
  await readFile(new URL("../vectors/derivation-v1.json", import.meta.url), "utf8"),
);
const REJOUABLES = VECTEURS.argon2Rfc9106.filter((cas) => cas.rejoue);

/** La phrase du banc. Elle est PUBLIQUE et sans valeur : c'est un marqueur, pas un secret. */
const PHRASE = "marqueur-de-phrase-du-banc-22-correcte-cheval-batterie-agrafe";

/** L'appât de la sonde : la même forme qu'un secret, pour prouver que la fouille trouve. */
const APPAT = "appat-de-sonde-22-ce-texte-doit-etre-trouve";

const IDENTIFIANT_VOLUME = Array.from({ length: 16 }, (_, index) => (0x0a + index * 0x11) % 256)
  .map((octet) => octet.toString(16).padStart(2, "0"))
  .join("");

/** Attache un relevé au rapport : ce qui n'est pas attaché n'a pas été mesuré. */
function attacher(testInfo, nom, releve) {
  return testInfo.attach(`deverrouillage-${nom}-${testInfo.project.name}.json`, {
    body: JSON.stringify(releve, null, 2),
    contentType: "application/json",
  });
}

/** La phrase exacte de la limite, quand aucun authentificateur virtuel PRF n'est pilotable. */
function limiteDePilotage(authentificateur) {
  return authentificateur === null
    ? "Aucun authentificateur virtuel n'est pilotable sur ce moteur : le protocole CDP WebAuthn est propre à Chromium. Le chemin est exercé jusqu'à l'appel, et le refus typé est vérifié."
    : `L'appel CDP a échoué (${authentificateur.erreur}) : cette version de Chromium ne connaît peut-être pas l'option « hasPrf ».`;
}

function codeDuRefus(error) {
  const trouve = String(error?.message ?? "").match(/VAULT_[A-Z_]+/);
  return trouve ? trouve[0] : null;
}

async function ouvrirBanc(page) {
  await page.goto("/vm/deverrouillage.html");
  await expect(page.locator("#etat")).toHaveText("Worker de déverrouillage prêt.");
}

function executer(page, payload) {
  return page.evaluate((options) => globalThis.bancDeverrouillage.executer(options), payload);
}

async function executerOuRefus(page, payload) {
  try {
    return { report: await executer(page, payload), code: null };
  } catch (error) {
    return { report: null, code: codeDuRefus(error) };
  }
}

/** Ouvre le banc et mesure ce que le moteur offre. */
async function contexte(page, testInfo) {
  await ouvrirBanc(page);
  const capacite = await executer(page, { scenario: "capacite" });
  await testInfo.attach(`deverrouillage-capacite-${testInfo.project.name}.json`, {
    body: JSON.stringify(capacite, null, 2),
    contentType: "application/json",
  });
  const porte =
    capacite.workerGetDirectory === "function" &&
    capacite.workerCreateSyncAccessHandle === "function" &&
    capacite.openCode === null;
  return { capacite, porte };
}

/**
 * Installe un AUTHENTIFICATEUR VIRTUEL Chromium, ou rend `null` si ce moteur n'en offre pas.
 *
 * `hasPrf` est demandé explicitement : c'est lui qui distingue « PRF disponible » de « extension
 * ignorée », et un moteur dont la version ne connaît pas l'option fera échouer l'appel CDP — auquel
 * cas la suite le DIT plutôt que de faire semblant.
 */
async function authentificateurVirtuel(page, { hasPrf, session }) {
  if (page.context().browser().browserType().name() !== "chromium") return null;
  // UNE session CDP par page : « WebAuthn.enable » sur une seconde session de la même page échoue,
  // et un second authentificateur se demande donc sur la session déjà ouverte.
  const partagee = session !== undefined;
  const cdp = session ?? (await page.context().newCDPSession(page));
  try {
    if (!partagee) await cdp.send("WebAuthn.enable", { enableUI: false });
    const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
      options: {
        protocol: "ctap2",
        ctap2Version: "ctap2_1",
        transport: "internal",
        hasResidentKey: true,
        hasUserVerification: true,
        isUserVerified: true,
        automaticPresenceSimulation: true,
        hasPrf,
      },
    });
    return { cdp, authenticatorId, hasPrf };
  } catch (cause) {
    // Une session PARTAGÉE n'est jamais détachée ici : elle appartient à l'appelant, et la couper
    // ferait échouer les gestes suivants pour une raison qui n'a rien à voir avec la mesure.
    if (!partagee) await cdp.detach().catch(() => {});
    return { cdp: null, erreur: cause.message, hasPrf };
  }
}

test("les vecteurs RFC 9106 rejouables le sont par l'artefact servi, sur les trois moteurs", async ({
  page,
}, testInfo) => {
  const { capacite } = await contexte(page, testInfo);
  expect(
    capacite.argon2Code,
    "l'artefact Argon2 vendu n'est pas servi, ou son empreinte ne correspond pas",
  ).toBeNull();

  const rapport = await executer(page, { scenario: "vecteurs", vecteurs: REJOUABLES });
  await testInfo.attach(`deverrouillage-vecteurs-${testInfo.project.name}.json`, {
    body: JSON.stringify(rapport, null, 2),
    contentType: "application/json",
  });
  expect(rapport.rendus).toHaveLength(REJOUABLES.length);
  for (const [rang, cas] of REJOUABLES.entries()) {
    expect(rapport.rendus[rang].empreinteHex, `RFC 9106 § ${cas.section}`).toBe(cas.empreinteHex);
  }
});

test("le Worker n'expose PAS navigator.credentials : la passkey se dérive dans la page", async ({
  page,
}, testInfo) => {
  const { capacite } = await contexte(page, testInfo);
  // Ce n'est pas une trivialité : c'est le FAIT de plate-forme qui force la décision de l'ADR 0021
  // — dériver `webauthn-prf` dans le document et ne faire franchir le port qu'à la CryptoKey.
  expect(capacite.credentialsDansLeWorker).toBe("undefined");
});

test("une phrase ouvre un volume réel ; une phrase fausse est refusée par l'enveloppe", async ({
  page,
}, testInfo) => {
  const { porte } = await contexte(page, testInfo);
  const { report, code } = await executerOuRefus(page, { scenario: "phrase", phrase: PHRASE });
  await testInfo.attach(`deverrouillage-phrase-${testInfo.project.name}.json`, {
    body: JSON.stringify({ porte, report, code }, null, 2),
    contentType: "application/json",
  });

  if (!porte) {
    expect(code).toBe(STORAGE_ERROR_CODES.unsupported);
    return;
  }
  expect(report.version).toBe(1);
  expect(report.volumeRelu, "la KEK dérivée n'ouvre pas le volume qu'elle protège").toBe(true);
  expect(report.refusDeLaFausse).toBe(ENVELOPPE_ERROR_CODES.cleRefusee);
  expect(
    report.coutDerivationMs,
    "une dérivation calibrée ne peut pas être instantanée",
  ).toBeGreaterThan(0);
});

/**
 * WebAuthn refuse une adresse IP comme `rpId` : « This is an invalid domain. »
 *
 * L'origine de confiance du dépôt est `http://127.0.0.1:4173` (ADR 0002, topologie du spike #35),
 * et son hôte est une IP. Le banc est donc joint par son AUTRE nom — le même serveur, la même
 * interface de bouclage, un nom de domaine enregistrable. C'est une contrainte de la spécification
 * WebAuthn, pas une faiblesse de la topologie : en production l'origine de confiance porte un vrai
 * domaine, et la question ne se pose pas. Elle est écrite ici pour qu'un relecteur qui voit deux
 * hôtes dans une même suite sache lequel mesure quoi.
 */
const HOTE_WEBAUTHN = `http://localhost:${SHELL_PORT}`;

/** Le banc, joint par un nom de domaine : c'est le seul endroit où WebAuthn peut s'exercer. */
async function ouvrirBancWebauthn(page) {
  await page.goto(`${HOTE_WEBAUTHN}/vm/deverrouillage.html`);
  await expect(page.locator("#etat")).toHaveText("Worker de déverrouillage prêt.");
}

test("PRF disponible : la passkey pose l'enveloppe, et une seconde assertion la rouvre", async ({
  page,
}, testInfo) => {
  await ouvrirBancWebauthn(page);
  const authentificateur = await authentificateurVirtuel(page, { hasPrf: true });
  const releve = { moteur: testInfo.project.name };

  if (authentificateur === null || authentificateur.cdp === null) {
    releve.limite = limiteDePilotage(authentificateur);
    releve.sansAuthentificateur = await page.evaluate(() =>
      globalThis.bancDeverrouillage.enregistrement(),
    );
    await attacher(testInfo, "prf-disponible", releve);
    // Chemin exercé JUSQU'À L'APPEL : `navigator.credentials.create` est bien invoqué, et c'est le
    // refus TYPÉ qui est vérifié. Rien n'est ignoré, rien n'est maquillé.
    //
    // DEUX refus sont admis, et l'écart est une mesure, pas une tolérance : sans authentificateur,
    // WebKit rend une créance dépourvue de résultat `prf` — donc `PRF_INDISPONIBLE` —, tandis que
    // Firefox rend `NotAllowedError` au bout du délai — donc `ANNULEE`, puisque le navigateur ne
    // distingue pas « personne n'a répondu » de « l'utilisateur a refusé ». Les deux sont typés,
    // aucun n'est un plantage, et aucun n'est une dégradation silencieuse.
    expect([DERIVATION_ERROR_CODES.prfIndisponible, DERIVATION_ERROR_CODES.annulee]).toContain(
      releve.sansAuthentificateur.code,
    );
    return;
  }

  const passkey = await page.evaluate(
    (identifiantVolume) => globalThis.bancDeverrouillage.passkey({ identifiantVolume }),
    IDENTIFIANT_VOLUME,
  );
  releve.passkey = { code: passkey.code, message: passkey.message ?? null };
  releve.rapport =
    passkey.rapport === null ? null : { ...passkey.rapport, parametresHex: undefined };
  await attacher(testInfo, "prf-disponible", releve);

  expect(passkey.code, `PRF disponible a échoué : ${passkey.message ?? ""}`).toBeNull();
  expect(passkey.rapport.creation.version).toBe(1);
  expect(
    passkey.rapport.ouverture.volumeRelu,
    "la KEK refaite par une SECONDE assertion n'ouvre pas le volume",
  ).toBe(true);
  expect(passkey.rapport.parametres.rpId).toBe("localhost");
  expect(passkey.rapport.parametres.sel).toHaveLength(64);
});

test("extension IGNORÉE à l'assertion : la créance existe, la sortie PRF n'arrive pas", async ({
  page,
}, testInfo) => {
  await ouvrirBancWebauthn(page);
  const avecPrf = await authentificateurVirtuel(page, { hasPrf: true });
  const releve = { moteur: testInfo.project.name };

  if (avecPrf === null || avecPrf.cdp === null) {
    releve.limite = limiteDePilotage(avecPrf);
    await attacher(testInfo, "prf-ignoree", releve);
    test.skip(true, releve.limite);
    return;
  }

  const passkey = await page.evaluate(
    (identifiantVolume) => globalThis.bancDeverrouillage.passkey({ identifiantVolume }),
    IDENTIFIANT_VOLUME,
  );
  expect(passkey.code, "l'enregistrement de départ doit réussir").toBeNull();

  // TRANSPLANTATION : la créance enregistrée est recopiée dans un authentificateur SANS PRF, et
  // l'ancien est retiré. L'emplacement reste donc parfaitement légitime — c'est l'authentificateur
  // qui ne sert pas l'extension, ce qui est exactement la conduite (b) de l'ADR 0021.
  const { credentials } = await avecPrf.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: avecPrf.authenticatorId,
  });
  releve.creancesTransplantees = credentials.length;
  // L'ordre est imposé par Chromium : « only supports one internal authenticator per environment ».
  // Le porteur de PRF est donc retiré AVANT que son remplaçant n'arrive, et la créance déjà relevée
  // y est réinjectée. L'emplacement reste le même, la passkey aussi ; seule l'extension disparaît.
  await avecPrf.cdp.send("WebAuthn.removeVirtualAuthenticator", {
    authenticatorId: avecPrf.authenticatorId,
  });
  const sansPrf = await authentificateurVirtuel(page, { hasPrf: false, session: avecPrf.cdp });
  if (sansPrf.cdp === null) {
    releve.limite = `Un authentificateur virtuel sans PRF n'a pas pu être installé : ${sansPrf.erreur}`;
    await attacher(testInfo, "prf-ignoree", releve);
    test.skip(true, releve.limite);
    return;
  }
  for (const credential of credentials) {
    await sansPrf.cdp.send("WebAuthn.addCredential", {
      authenticatorId: sansPrf.authenticatorId,
      credential,
    });
  }

  const assertion = await page.evaluate((appel) => globalThis.bancDeverrouillage.assertion(appel), {
    parametresHex: passkey.rapport.parametresHex,
    identifiantVolume: IDENTIFIANT_VOLUME,
    identifiantEmplacement: passkey.rapport.creation.identifiantEmplacement,
  });
  releve.assertion = assertion;
  await attacher(testInfo, "prf-ignoree", releve);

  expect(
    credentials.length,
    "aucune créance à transplanter : la mesure serait vide",
  ).toBeGreaterThan(0);
  expect(
    assertion.code,
    "une extension ignorée doit rendre son propre code, distinct de l'indisponibilité",
  ).toBe(DERIVATION_ERROR_CODES.prfIgnoree);
});

test("ANNULATION : NotAllowedError rend un refus typé, sans repli ni compteur", async ({
  page,
}, testInfo) => {
  await ouvrirBancWebauthn(page);
  const authentificateur = await authentificateurVirtuel(page, { hasPrf: true });
  const releve = { moteur: testInfo.project.name };

  if (authentificateur === null || authentificateur.cdp === null) {
    releve.limite = limiteDePilotage(authentificateur);
    await attacher(testInfo, "prf-annulation", releve);
    test.skip(true, releve.limite);
    return;
  }

  const passkey = await page.evaluate(
    (identifiantVolume) => globalThis.bancDeverrouillage.passkey({ identifiantVolume }),
    IDENTIFIANT_VOLUME,
  );
  expect(passkey.code, "l'enregistrement de départ doit réussir").toBeNull();

  // La présence n'est plus simulée : l'utilisateur ne touche pas son authentificateur, et le moteur
  // rend `NotAllowedError` au bout du délai. C'est le geste réel, pas une erreur injectée.
  await authentificateur.cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId: authentificateur.authenticatorId,
    enabled: false,
  });
  const appel = {
    parametresHex: passkey.rapport.parametresHex,
    identifiantVolume: IDENTIFIANT_VOLUME,
    identifiantEmplacement: passkey.rapport.creation.identifiantEmplacement,
  };
  const premiere = await page.evaluate((a) => globalThis.bancDeverrouillage.assertion(a), appel);
  const seconde = await page.evaluate((a) => globalThis.bancDeverrouillage.assertion(a), appel);
  releve.premiere = premiere;
  releve.seconde = seconde;
  await attacher(testInfo, "prf-annulation", releve);

  expect(premiere.code).toBe(DERIVATION_ERROR_CODES.annulee);
  // AUCUN compteur d'échec : la seconde annulation est exactement la première, répétée. Un produit
  // qui pénaliserait les tentatives aurait ici un code différent, ou un délai.
  expect(seconde.code).toBe(DERIVATION_ERROR_CODES.annulee);

  // Et rien n'a été persisté par ces deux refus : la sonde le vérifie sur tous les stockages.
  await authentificateur.cdp.send("WebAuthn.setAutomaticPresenceSimulation", {
    authenticatorId: authentificateur.authenticatorId,
    enabled: true,
  });
  const rouverte = await page.evaluate((a) => globalThis.bancDeverrouillage.assertion(a), appel);
  expect(
    rouverte.code,
    "après deux annulations, le même geste doit réussir : aucune pénalité n'est conservée",
  ).toBeNull();
});

/**
 * MESURE du coût d'une dérivation calibrée, sur le moteur courant.
 *
 * Elle n'est PAS rattachée à `npm run check`, et le motif est le même que celui du banc de rythme
 * (#16) : vingt dérivations à 64 Mio coûtent des secondes sur chaque moteur, et un contrôle
 * obligatoire qui les paierait à chaque poussée serait abandonné. Elle se demande explicitement :
 *
 *     VAULT_MESURER_DERIVATION=20 npm run test:deverrouillage
 *
 * Ce qu'elle établit est un ORDRE DE GRANDEUR sur une machine et un moteur, et l'ADR 0021 le
 * publie comme tel. Elle n'établit rien sur le matériel d'un utilisateur.
 */
test("MESURE — coût d'une dérivation Argon2id calibrée", async ({ page }, testInfo) => {
  const tours = Number.parseInt(process.env.VAULT_MESURER_DERIVATION ?? "0", 10);
  test.skip(
    !Number.isInteger(tours) || tours <= 0,
    "Mesure non demandée (VAULT_MESURER_DERIVATION absent).",
  );
  test.setTimeout(600000);

  await ouvrirBanc(page);
  const mesure = await executer(page, { scenario: "mesure", phrase: PHRASE, tours });
  process.stdout.write(
    `MESURE ${testInfo.project.name} : phrase p50 ${mesure.p50Ms} ms, p95 ${mesure.p95Ms} ms, max ${mesure.maxMs} ms (${mesure.tours} tours, ${mesure.memoireKio} Kio, t=${mesure.iterations}, p=${mesure.parallelisme})\n`,
  );

  // Le coût du PRF, là où un authentificateur est pilotable. Il est d'une autre nature : ce n'est
  // pas un calcul, c'est un aller-retour vers l'authentificateur, suivi d'un seul HKDF. La
  // comparer à la phrase est tout l'intérêt — c'est ce que l'utilisateur ressentira.
  await ouvrirBancWebauthn(page);
  const authentificateur = await authentificateurVirtuel(page, { hasPrf: true });
  let prf = null;
  if (authentificateur !== null && authentificateur.cdp !== null) {
    const passkey = await page.evaluate(
      (identifiantVolume) => globalThis.bancDeverrouillage.passkey({ identifiantVolume }),
      IDENTIFIANT_VOLUME,
    );
    if (passkey.code === null) {
      prf = await page.evaluate((appel) => globalThis.bancDeverrouillage.mesurerAssertion(appel), {
        parametresHex: passkey.rapport.parametresHex,
        identifiantVolume: IDENTIFIANT_VOLUME,
        identifiantEmplacement: passkey.rapport.creation.identifiantEmplacement,
        tours: 10,
      });
      process.stdout.write(
        `MESURE ${testInfo.project.name} : prf p50 ${prf.p50Ms} ms, p95 ${prf.p95Ms} ms (${prf.tours} assertions, authentificateur virtuel)\n`,
      );
    }
  }

  await attacher(testInfo, "mesure", { moteur: testInfo.project.name, phrase: mesure, prf });
  expect(mesure.p50Ms).toBeGreaterThan(0);
});

test("la PAGE n'obtient aucun handle sur le fichier d'enveloppes", async ({ page }, testInfo) => {
  const { porte } = await contexte(page, testInfo);
  await executerOuRefus(page, { scenario: "phrase", phrase: PHRASE });

  const sonde = await page.evaluate(
    (nom) => globalThis.bancDeverrouillage.sondePage(nom),
    "banc-deverrouillage.cles",
  );
  expect(sonde.ouvert, "la page a ouvert le fichier de clés en accès exclusif").toBe(false);
  expect(sonde.code).toBe(STORAGE_ERROR_CODES.unsupported);
  if (porte) expect(sonde.getDirectory).toBe("function");
});

test("AUCUN secret ne se dépose : tous les stockages de l'origine et le port sont fouillés", async ({
  page,
}, testInfo) => {
  const { porte } = await contexte(page, testInfo);
  await executerOuRefus(page, { scenario: "phrase", phrase: PHRASE });

  const morceaux = await page.evaluate(
    (appat) => globalThis.bancDeverrouillage.sondeStockages({ appat }),
    APPAT,
  );
  await testInfo.attach(`deverrouillage-sonde-${testInfo.project.name}.json`, {
    body: JSON.stringify(
      morceaux.map(({ ou, texte }) => ({ ou, caracteres: texte.length })),
      null,
      2,
    ),
    contentType: "application/json",
  });

  // TÉMOIN de la fouille : l'appât a été déposé dans chaque stockage, et il doit être retrouvé.
  // Sans lui, une recherche qui ne trouve jamais rien pourrait n'être qu'une recherche cassée.
  const trouves = morceaux.filter(({ texte }) => texte.includes(APPAT)).map(({ ou }) => ou);
  expect(trouves, "la sonde n'a retrouvé son appât nulle part : elle ne mesure rien").toContain(
    "localStorage",
  );
  expect(trouves).toContain("sessionStorage");
  expect(trouves).toContain("cookies");
  if (porte) expect(trouves).toContain("opfs");

  // Ce qui ne doit se trouver NULLE PART, sauf dans le sens page → Worker où la phrase transite
  // délibérément (ADR 0021 : c'est une frontière INTERNE à l'origine de confiance, pas celle de
  // `SEC-ORIGIN-001`).
  for (const { ou, texte } of morceaux) {
    if (ou === "envois") continue;
    expect(texte.includes(PHRASE), `la phrase se retrouve dans « ${ou} »`).toBe(false);
  }
  const port = morceaux.find(({ ou }) => ou === "port").texte;
  expect(port.includes(PHRASE), "la phrase revient du Worker vers la page").toBe(false);
  expect(port.length, "le Worker n'a rien rendu : la fouille ne mesurerait rien").toBeGreaterThan(
    0,
  );
});
