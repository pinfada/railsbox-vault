import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  MARQUEUR_SERIE_DU_GUEST,
  creerChronologie,
  extraireLaSerieDuGuest,
  nomDeFichierDuScenario,
} from "../e2e/chronologie.mjs";
import {
  PLAFOND_SERIE_DU_GUEST,
  serieDeDiagnostic,
} from "../../src/vm/reference-guest-session.mjs";

// Épreuve de l'ENREGISTREUR de chronologie des scénarios de bout en bout (#165) et de la série du
// guest qu'un délai de boot joint à son erreur.
//
// Ce qu'elle garde, et pourquoi chaque point a coûté quelque chose :
//
//  - la chronologie est déposée à CHAQUE étape. C'est la seule propriété qui la rende utile : les
//    relevés actuels sont écrits à la dernière ligne du scénario, si bien que l'artefact d'un run
//    rouge contient le relevé des huit scénarios VERTS et pas celui du neuvième ;
//  - la série du guest est extraite du MESSAGE, seul champ qu'une erreur conserve en traversant
//    `page.evaluate`, et elle est écrite dans son PROPRE fichier ;
//  - `serieDeDiagnostic` garde la TÊTE quand elle doit couper. La version d'avant gardait la fin,
//    et la fin ne montre que les sondes de santé qui rebondissent sur le shell de secours.

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Journal d'écritures : une chronologie n'a pas besoin d'un vrai disque pour être éprouvée. */
function supportDeTest() {
  const fichiers = new Map();
  const dossiersCrees = [];
  const depots = [];
  return {
    fichiers,
    dossiersCrees,
    depots,
    ecrireFichier(chemin, contenu) {
      fichiers.set(chemin, contenu);
      depots.push(chemin);
    },
    creerDossier(chemin) {
      dossiersCrees.push(chemin);
    },
  };
}

function horlogeDeTest(debutMs = 1_000_000) {
  let courant = debutMs;
  return {
    maintenant: () => new Date(courant),
    avancer: (ms) => {
      courant += ms;
    },
  };
}

test("un nom de scénario devient un nom de fichier, et ne peut pas sortir de son dossier", () => {
  assert.equal(
    nomDeFichierDuScenario("migration-volume-versionne.spec.mjs"),
    "migration-volume-versionne",
  );
  assert.equal(nomDeFichierDuScenario("instantane-reprise.spec.mjs"), "instantane-reprise");
  // Un nom porteur d'un séparateur de chemin écrirait AILLEURS : il est neutralisé, pas refusé.
  assert.equal(nomDeFichierDuScenario("../../etc/passwd"), "etc-passwd");
  assert.equal(nomDeFichierDuScenario("..."), "scenario-sans-nom");
});

test("chaque étape DÉPOSE le relevé : un scénario interrompu en laisse un qui s'arrête là", () => {
  const support = supportDeTest();
  const horloge = horlogeDeTest();
  const chronologie = creerChronologie({
    scenario: "instantane-reprise.spec.mjs",
    dossier: "/relevés",
    maintenant: horloge.maintenant,
    ecrireFichier: support.ecrireFichier,
    creerDossier: support.creerDossier,
  });

  chronologie.etape("préparation", { octets: 512 });
  horloge.avancer(4_000);
  chronologie.etape("boot", { santeMs: 93 });

  // DEUX dépôts pour deux étapes : rien n'attend la fin du scénario.
  assert.equal(support.depots.length, 2);

  const releve = JSON.parse(
    support.fichiers.get(join("/relevés", "chronologie-instantane-reprise.json")),
  );
  assert.equal(releve.statut, "en-cours", "un relevé déposé en chemin le dit");
  assert.deepEqual(
    releve.etapes.map((etape) => etape.nom),
    ["préparation", "boot"],
  );
  assert.equal(releve.etapes[0].octets, 512);
  assert.equal(releve.etapes[1].depuisLeDebutMs, 4_000, "chaque étape est datée depuis le début");
  assert.equal(releve.echec, null);
});

test("une chronologie close sur un échec porte le message, et la série du guest va dans SON fichier", () => {
  const support = supportDeTest();
  const chronologie = creerChronologie({
    scenario: "migration-volume-versionne.spec.mjs",
    dossier: "/relevés",
    maintenant: horlogeDeTest().maintenant,
    ecrireFichier: support.ecrireFichier,
    creerDossier: support.creerDossier,
  });
  chronologie.etape("boot à froid");

  const serie = chronologie.clore({
    statut: "failed",
    message: `Rails n'a pas répondu à /vault/health en 300 s\n${MARQUEUR_SERIE_DU_GUEST} ---\n[    0.000000] Linux version 6.1\n(initramfs) \n`,
  });

  assert.equal(serie, "[    0.000000] Linux version 6.1\n(initramfs) \n");
  assert.equal(
    support.fichiers.get(join("/relevés", "serie-guest-migration-volume-versionne.txt")),
    "[    0.000000] Linux version 6.1\n(initramfs) \n",
    "la série est écrite ENTIÈRE, hors du JSON",
  );

  const releve = JSON.parse(
    support.fichiers.get(join("/relevés", "chronologie-migration-volume-versionne.json")),
  );
  assert.equal(releve.statut, "failed");
  assert.match(releve.echec.message, /Rails n'a pas répondu/);
  assert.doesNotMatch(
    releve.echec.message,
    /initramfs/,
    "le relevé RENVOIE à la série, il ne la recopie pas",
  );
  assert.equal(
    releve.echec.serieDuGuest,
    "serie-guest-migration-volume-versionne.txt",
    "le relevé nomme son voisin, il ne porte pas un chemin d'exécutant",
  );
  assert.equal(releve.echec.serieDuGuestCaracteres, serie.length);
});

test("un échec SANS série du guest n'écrit aucun fichier de série", () => {
  const support = supportDeTest();
  const chronologie = creerChronologie({
    scenario: "instantane-reprise.spec.mjs",
    dossier: "/relevés",
    maintenant: horlogeDeTest().maintenant,
    ecrireFichier: support.ecrireFichier,
    creerDossier: support.creerDossier,
  });

  assert.equal(chronologie.clore({ statut: "failed", message: "Expected: 0\nReceived: 21" }), null);
  assert.equal(support.fichiers.has(join("/relevés", "serie-guest-instantane-reprise.txt")), false);
  const releve = JSON.parse(
    support.fichiers.get(join("/relevés", "chronologie-instantane-reprise.json")),
  );
  assert.equal(releve.echec.serieDuGuest, null);
  assert.match(releve.echec.message, /Received: 21/);
});

test("le marqueur cherché est bien CELUI que la coquille du banc écrit", () => {
  // Les deux vivent dans des contextes d'exécution différents — navigateur et Node — et ne peuvent
  // pas partager une constante importée. Sans cette épreuve, renommer le marqueur d'un côté ferait
  // taire l'extraction de l'autre SANS rougir : la série disparaîtrait de l'artefact en silence.
  const banc = readFileSync(join(RACINE, "public", "vm", "reference-banc.mjs"), "utf8");
  assert.ok(
    banc.includes(`\n${MARQUEUR_SERIE_DU_GUEST} ---\n`),
    `« ${MARQUEUR_SERIE_DU_GUEST} » ne se trouve plus dans public/vm/reference-banc.mjs`,
  );
});

test("la série de diagnostic est ENTIÈRE tant qu'elle tient sous le plafond", () => {
  const serie = `[    0.000000] Linux version\n${"ligne\n".repeat(1000)}(initramfs) `;
  assert.ok(serie.length < PLAFOND_SERIE_DU_GUEST);
  assert.equal(serieDeDiagnostic(serie), serie);
});

test("au-delà du plafond, la série garde la TÊTE — et NOMME ce qu'elle omet", () => {
  // La tête est le seul endroit où le mode de #165 se lit : le boot du noyau, le montage du rootfs,
  // le basculement vers l'init. Garder la fin, c'est garder les sondes qui rebondissent.
  const tete = "[    0.000000] Linux version 6.1 AMORCE";
  const serie = tete + "X".repeat(PLAFOND_SERIE_DU_GUEST) + "FIN-DE-LA-SÉRIE";
  const extrait = serieDeDiagnostic(serie, { plafond: 200, tete: 150 });

  assert.ok(extrait.startsWith(tete.slice(0, 39)), "la tête est gardée");
  assert.ok(
    extrait.endsWith("FIN-DE-LA-SÉRIE"),
    "et la fin le reste aussi, dans ce qui lui revient",
  );
  assert.match(extrait, /caractères omis/, "ce qui manque est NOMMÉ");
  assert.match(extrait, new RegExp(`la série pesait ${serie.length} caractères`));
});

test("une série absente ou non textuelle rend une chaîne vide, jamais une exception", () => {
  // Un diagnostic qui LÈVE pendant qu'il décrit une panne remplace la panne : c'est la leçon du
  // 23 août 2026 écrite dans `tools/build-reference-image/guest/guest-init.sh`.
  assert.equal(serieDeDiagnostic(undefined), "");
  assert.equal(serieDeDiagnostic(null), "");
  assert.equal(serieDeDiagnostic(42), "");
});

test("extraire une série d'un message qui n'en porte pas rend `null`", () => {
  assert.equal(extraireLaSerieDuGuest("expect(received).toBe(expected)"), null);
  assert.equal(extraireLaSerieDuGuest(null), null);
  assert.equal(
    extraireLaSerieDuGuest(`${MARQUEUR_SERIE_DU_GUEST} ---`),
    null,
    "sans ligne suivante, rien à extraire",
  );
});
