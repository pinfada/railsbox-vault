/**
 * Épreuves des EN-TÊTES DE DURCISSEMENT génériques servis par `tools/serve-headers.mjs`
 * (#104, ADR 0022 — risque résiduel n°7 de l'ADR 0017).
 *
 * Trois en-têtes y sont tranchés, et la décision n'est pas la même pour les trois. Ces épreuves
 * tiennent les trois décisions, y compris celle qui ÉCARTE : une absence décidée qu'aucune épreuve
 * ne garde redeviendrait une absence par défaut à la tranche suivante, exactement ce que le risque
 * résiduel n°7 reprochait à l'état antérieur.
 *
 * Elles portent sur `securityHeaders()` — la SOURCE DE VÉRITÉ de l'ADR 0017 § 2 — et non sur la
 * publication : celle-ci en dérive, et `tests/unit/publication-arborescences.test.mjs` vérifie
 * qu'elle en dérive sans rien recopier ni rien ajouter.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { APP_ORIGIN } from "../../src/spike/origin-topology.mjs";
import { CAPABILITY_PROBE_PREFIX, securityHeaders } from "../../tools/serve-headers.mjs";

/** Chemin d'un document de la coquille, c'est-à-dire de la base de confiance elle-même. */
const DOCUMENT_DE_COQUILLE = "/index.html";
/** Territoire applicatif servi par le rôle `shell` : son HTML vient du guest (ADR 0002). */
const TERRITOIRE_APPLICATIF = "/spike/origin/app.html";
const SONDE_DE_CAPACITES = `${CAPABILITY_PROBE_PREFIX}.html`;

function enTetes(role, pathname) {
  return securityHeaders({ role, pathname, isolation: null, appOrigin: APP_ORIGIN });
}

// --- Referrer-Policy ---------------------------------------------------------------------------

test("la coquille sert `Referrer-Policy: no-referrer` sur ses propres documents", () => {
  // La seule requête inter-origine que la CSP de la coquille autorise est le CADRE du territoire
  // applicatif. Sous la politique par défaut des moteurs, cette requête porte l'origine de la
  // coquille jusqu'à une origine dont le contenu vient du guest. `no-referrer` la retire.
  assert.equal(enTetes("shell", DOCUMENT_DE_COQUILLE)["Referrer-Policy"], "no-referrer");
});

test("le territoire applicatif ne reçoit pas le `Referrer-Policy` de la coquille", () => {
  // Même motif que pour la CSP : ce document est rendu par le guest, et `Referrer-Policy` gouverne
  // ce qu'il ÉMET. La lui imposer serait la politique que l'ADR 0002 s'interdit.
  assert.equal(enTetes("shell", TERRITOIRE_APPLICATIF)["Referrer-Policy"], undefined);
});

test("la sonde de capacités ne reçoit pas le `Referrer-Policy` de la coquille", () => {
  // La sonde mesure le moteur, pas notre politique : elle est exemptée des politiques de la
  // coquille en bloc, comme elle l'est déjà de sa CSP.
  assert.equal(enTetes("shell", SONDE_DE_CAPACITES)["Referrer-Policy"], undefined);
});

test("l'origine applicative ne reçoit AUCUN `Referrer-Policy` (ADR 0022, décidé et non oublié)", () => {
  assert.equal(enTetes("app", DOCUMENT_DE_COQUILLE)["Referrer-Policy"], undefined);
  assert.equal(enTetes("app", TERRITOIRE_APPLICATIF)["Referrer-Policy"], undefined);
});

// --- Permissions-Policy ------------------------------------------------------------------------

test("la coquille refuse caméra, micro et géolocalisation, et les nomme un par un", () => {
  assert.equal(
    enTetes("shell", DOCUMENT_DE_COQUILLE)["Permissions-Policy"],
    "camera=(), microphone=(), geolocation=()",
  );
});

test("la liste des capacités refusées est un CLIQUET : l'élargir demande un ADR", () => {
  // Le risque nommé par #104 n'est pas d'en refuser trop peu, c'est d'en refuser trop : une
  // politique large casserait une capacité dont le runtime a besoin sans qu'aucune épreuve ne le
  // dise. La liste est donc figée ici, et non « vérifiée non vide ».
  const politique = enTetes("shell", DOCUMENT_DE_COQUILLE)["Permissions-Policy"] ?? "";
  const capacites = politique.split(",").map((refus) => refus.trim().replace("=()", ""));
  assert.deepEqual(capacites, ["camera", "microphone", "geolocation"]);
});

test("la politique de permissions n'est pas un refus en bloc", () => {
  const politique = enTetes("shell", DOCUMENT_DE_COQUILLE)["Permissions-Policy"] ?? "";
  // `*=()` ou une liste fourre-tout refuserait des capacités que ce dépôt n'a jamais mesurées —
  // plein écran de la console VM, presse-papiers vers le guest, lecture audio de v86.
  assert.ok(!politique.includes("*"), "un joker refuserait des capacités non mesurées");
  for (const capacite of ["fullscreen", "clipboard-read", "clipboard-write", "autoplay"]) {
    assert.ok(
      !politique.includes(capacite),
      `${capacite} n'a été mesurée par personne : la refuser serait supposer, pas décider`,
    );
  }
});

test("le territoire applicatif et la sonde ne reçoivent pas la `Permissions-Policy`", () => {
  assert.equal(enTetes("shell", TERRITOIRE_APPLICATIF)["Permissions-Policy"], undefined);
  assert.equal(enTetes("shell", SONDE_DE_CAPACITES)["Permissions-Policy"], undefined);
});

test("l'origine applicative ne reçoit AUCUNE `Permissions-Policy` (ADR 0022)", () => {
  assert.equal(enTetes("app", DOCUMENT_DE_COQUILLE)["Permissions-Policy"], undefined);
});

// --- Strict-Transport-Security : écarté, et l'absence est gardée --------------------------------

test("aucun rôle ne sert `Strict-Transport-Security` : ce dépôt ne le mesure nulle part", () => {
  // L'ADR 0022 l'écarte, et pas par oubli : tout ce que ce dépôt sait servir est en `http:`, où
  // RFC 6797 § 7.2 exige du navigateur qu'il IGNORE l'en-tête. Le poser dans la source de vérité y
  // mettrait une politique inerte partout où elle est mesurée. C'est une obligation d'EXPLOITANT.
  for (const role of ["shell", "app"]) {
    for (const chemin of [DOCUMENT_DE_COQUILLE, TERRITOIRE_APPLICATIF, SONDE_DE_CAPACITES]) {
      assert.equal(
        enTetes(role, chemin)["Strict-Transport-Security"],
        undefined,
        `${role} sert HSTS sur ${chemin} : l'ADR 0022 l'écarte, un nouvel ADR est requis`,
      );
    }
  }
});

// --- Ce que le durcissement ne doit PAS déplacer -------------------------------------------------

test("le durcissement ne touche ni la CSP, ni CORP, ni la politique de cache", () => {
  const coquille = enTetes("shell", DOCUMENT_DE_COQUILLE);
  assert.match(coquille["Content-Security-Policy"], /worker-src 'self';/);
  assert.equal(coquille["Cross-Origin-Resource-Policy"], "same-origin");
  assert.equal(coquille["Cache-Control"], "no-store");
  assert.equal(coquille["X-Content-Type-Options"], "nosniff");
  assert.equal(
    enTetes("app", DOCUMENT_DE_COQUILLE)["Cross-Origin-Resource-Policy"],
    "cross-origin",
  );
});
