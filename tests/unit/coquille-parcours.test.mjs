/**
 * Le PARCOURS GUIDÉ (#193, ADR 0040) : quel écran, dans quel ordre, où mène chaque geste, et ce que la
 * progression en retient.
 *
 * Tout ce qui est éprouvé ici est pur : `src/coquille/parcours.mjs` ne touche ni au DOM ni à un
 * stockage. La page qui l'applique est éprouvée par `tests/browser/coquille-parcours.spec.mjs` (l'ordre
 * attaqué, sans machine virtuelle) et par l'E2E « utilisateur » (`tests/e2e/parcours-utilisateur.spec.mjs`).
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  encoderCode,
  tirerCodeDeRecuperation,
} from "../../src/vm/derivation/code-de-recuperation.mjs";
import { DERIVATION_ERROR_CODES } from "../../src/vm/derivation/derivation-errors.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { etatDeLaSaisie } from "../../src/coquille/saisie-du-code.mjs";
import {
  BLOCS,
  COFFRE,
  ECRANS,
  ETAPES,
  GESTES_LONGS,
  LIBELLES_DES_BLOCS,
  LIMITE_DE_FIREFOX,
  MESSAGES,
  ORIGINES_DU_COFFRE,
  PROGRESSION_INITIALE,
  SOUS_ETATS_DU_CODE,
  annonceDeLaSaisie,
  attenteDeLaPhrase,
  codeEnFinDeTexte,
  coffreObserve,
  confirmerLaRecopie,
  ecranCourant,
  ecrireProgression,
  etapeAdmise,
  etapeApres,
  etapeDeLURL,
  etapeSuivante,
  lireLigneDEtat,
  lireProgression,
  ouSuisJe,
  ouvertureParLeCode,
  progressionApres,
  progressionDuDemarrage,
  refusDeRelaisAAnnoncer,
  texteSansCode,
  unGesteEstEnCours,
} from "../../src/coquille/parcours.mjs";

const lire = (chemin) => readFile(new URL(`../../${chemin}`, import.meta.url), "utf8");

const creee = progressionApres(PROGRESSION_INITIALE, "coffre-cree");
const rendue = progressionApres(creee, "code-rendu", 2);
const confirmee = progressionApres(rendue, "code-confirme");
const MOYENS_DE_A = ["phrase", "recuperation"];

const ouvert = (reste) => ({
  coffre: COFFRE.ouvert,
  moyens: MOYENS_DE_A,
  progression: confirmee,
  ...reste,
});

test("les neuf étapes de la DoR, dans l'ordre, et chaque écran appartient à l'une d'elles", () => {
  assert.deepEqual(
    ETAPES.map((etape) => etape.rang),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  const rangs = new Set(Object.values(ECRANS).map((ecran) => ecran.etape));
  for (const rang of [1, 2, 3, 4, 5, 6, 7, 8, 9]) assert.ok(rangs.has(rang), `étape ${rang}`);
  for (const [id, ecran] of Object.entries(ECRANS)) {
    assert.ok(ecran.titre.length > 0, `${id} : titre`);
    assert.ok(ecran.ceQuiVaSePasser.length > 0, `${id} : ce qui va se passer`);
    assert.ok(ecran.attendu.length > 0, `${id} : ce qui est attendu`);
    for (const bloc of ecran.blocs) assert.ok(BLOCS.includes(bloc), `${id} : bloc ${bloc}`);
  }
});

test("les blocs de la page sont ceux du parcours, dans l'ordre du document, et chacun a ses libellés", async () => {
  const page = await lire("public/index.html");
  const dansLeDocument = [...page.matchAll(/data-bloc="([^"]+)"/g)].map((trouve) => trouve[1]);
  assert.deepEqual(dansLeDocument, [...BLOCS]);
  assert.deepEqual(Object.keys(LIBELLES_DES_BLOCS).sort(), [...BLOCS].sort());
  // Chaque nom cité entre guillemets est un texte du document, ou un nom que la page lui donne.
  const branchement = await lire("public/coquille/parcours-de-la-page.mjs");
  const pageSansBlancs = page.replace(/\s+/g, " ");
  for (const [bloc, libelles] of Object.entries(LIBELLES_DES_BLOCS)) {
    for (const libelle of libelles) {
      for (const [, nom] of libelle.matchAll(/« ([^»]+) »/g)) {
        if (nom.endsWith(":")) continue;
        assert.ok(
          pageSansBlancs.includes(`>${nom}<`) ||
            pageSansBlancs.includes(`> ${nom} <`) ||
            branchement.includes(`"${nom}"`),
          `${bloc} : « ${nom} » n'est ni dans la page, ni nommé par le parcours`,
        );
      }
    }
  }
});

test("les attentes longues sont annoncées AVANT : démarrage, sauvegarde, restauration, verrouillage", () => {
  assert.match(ECRANS.travailler.attente, /environ deux minutes/);
  assert.match(ECRANS.travailler.attente, /figé/);
  assert.match(ECRANS.sauvegarder.attente, /minutes/);
  assert.match(ECRANS.restaurer.attente, /minutes/);
  assert.match(ECRANS.verrouiller.attente, /secondes/);
  assert.match(attenteDeLaPhrase(446), /moins d'une seconde/);
  assert.match(attenteDeLaPhrase(2207), /environ 2 seconde/);
  assert.match(attenteDeLaPhrase(446), /figé/);
});

test("l'écran de la feuille dit AVANT de la montrer qu'elle ne s'affiche qu'une fois, et pourquoi", () => {
  const annonce = ECRANS["code-annonce"].ceQuiVaSePasser;
  assert.match(annonce, /QU'UNE SEULE FOIS/);
  assert.match(annonce, /une phrase oubliée est un coffre perdu, et personne ne peut vous aider/);
});

test("l'écran de révocation dit que les sauvegardes déjà faites restent ouvrables", () => {
  assert.match(ECRANS.revoquer.ceQuiVaSePasser, /sauvegardes déjà faites restent ouvrables/);
  assert.match(ECRANS.termine.ceQuiVaSePasser, /sauvegardes déjà faites restent ouvrables/);
  assert.doesNotMatch(
    ECRANS.termine.attendu,
    /créez-en un nouveau/,
    "aucun geste ne le permet ici",
  );
});

// --- La PROGRESSION (revue de la PR #213, constats 1 et 2) -----------------------------------------

test("la progression se relit, et tout ce qui n'a pas exactement sa forme vaut la progression initiale", () => {
  assert.deepEqual(lireProgression(ecrireProgression(confirmee)), confirmee);
  const valide = JSON.parse(ecrireProgression(confirmee));
  const abimees = [
    null,
    "",
    "{",
    "[]",
    JSON.stringify({ ...valide, version: 2 }),
    JSON.stringify({ ...valide, etapeAtteinte: 10 }),
    JSON.stringify({ ...valide, etapeAtteinte: 0 }),
    JSON.stringify({ ...valide, etapeAtteinte: "9" }),
    JSON.stringify({ ...valide, origine: "ailleurs" }),
    JSON.stringify({ ...valide, code: { ...valide.code, confirme: "oui" } }),
    JSON.stringify({ ...valide, code: { ...valide.code, version: 0 } }),
    JSON.stringify({ ...valide, code: { ...valide.code, valeur: "ABCD-EFGH" } }),
    JSON.stringify({ ...valide, code: null }),
    JSON.stringify({ ...valide, phrase: "x" }),
  ];
  for (const texte of abimees) {
    assert.deepEqual(lireProgression(texte), PROGRESSION_INITIALE, String(texte));
  }
});

test("la progression écrite ne porte que ses champs : jamais le code, jamais la phrase", () => {
  const avecIntrus = { ...confirmee, code: { ...confirmee.code, valeur: "SECRET" }, phrase: "x" };
  const ecrite = JSON.parse(ecrireProgression(avecIntrus));
  assert.deepEqual(Object.keys(ecrite).sort(), ["code", "etapeAtteinte", "origine", "version"]);
  assert.deepEqual(Object.keys(ecrite.code).sort(), ["confirme", "rendu", "version"]);
  assert.doesNotMatch(JSON.stringify(ecrite), /SECRET/);
});

test("chaque pas rend une NOUVELLE progression, et un coffre neuf n'hérite d'aucune confirmation", () => {
  assert.equal(creee.etapeAtteinte, 3);
  assert.deepEqual(rendue.code, { rendu: true, version: 2, confirme: false });
  assert.equal(rendue.code.confirme, false);
  assert.deepEqual(confirmee.code, { rendu: true, version: 2, confirme: true });
  assert.equal(confirmee.etapeAtteinte, 4);
  assert.ok(Object.isFrozen(confirmee) && Object.isFrozen(confirmee.code));
  assert.notEqual(confirmee, rendue);
  const recommence = progressionApres(progressionApres(confirmee, "etape", 9), "coffre-cree");
  assert.equal(recommence.code.confirme, false, "un coffre recréé exige une nouvelle confirmation");
  assert.equal(recommence.etapeAtteinte, 3);
  assert.equal(
    progressionApres(confirmee, "etape", 2).etapeAtteinte,
    4,
    "on n'atteint pas en reculant",
  );
  const restauree = progressionApres(confirmee, "restauree");
  assert.equal(restauree.origine, ORIGINES_DU_COFFRE.restauration);
  assert.equal(restauree.etapeAtteinte, 8);
  assert.equal(restauree.code.confirme, false);
  assert.throws(() => progressionApres(confirmee, "inconnu"), /inconnu/);
});

test("ORDRE : une étape demandée au-delà de la progression est ramenée à l'étape atteinte", () => {
  assert.equal(etapeAdmise(4, creee), 3);
  assert.equal(etapeAdmise(9, rendue), 3);
  assert.equal(etapeAdmise(2, confirmee), 2, "revenir en arrière reste permis");
  assert.equal(etapeAdmise(null, confirmee), 4, "sans demande, on reprend là où on en était");
  assert.equal(etapeAdmise(null, PROGRESSION_INITIALE), 1);
});

// --- Les écrans -------------------------------------------------------------------------------------

test("sans coffre : créer, choisir, ou restaurer selon l'étape atteinte", () => {
  assert.equal(ecranCourant({ pointeur: null, coffre: COFFRE.absent }), "creer");
  assert.equal(ecranCourant({ pointeur: 2, coffre: COFFRE.absent }), "choisir");
  assert.equal(ecranCourant({ pointeur: 7, coffre: COFFRE.absent }), "restaurer");
  assert.equal(ecranCourant({ pointeur: 5, coffre: COFFRE.absent }), "creer");
  assert.equal(ecranCourant({ pointeur: null, coffre: COFFRE.inconnu }), "chargement");
});

test("un coffre ouvert SANS moyen de récupération ramène toujours à la création du code", () => {
  for (const pointeur of [null, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(
      ecranCourant(ouvert({ pointeur, moyens: ["phrase"], progression: creee })),
      "code-annonce",
      `étape ${pointeur}`,
    );
  }
});

test("CONSTAT 1 : un code rendu et non confirmé fait d'abord VÉRIFIER la feuille que l'on a", () => {
  for (const pointeur of [null, 3, 4, 5, 6, 7, 8, 9]) {
    const ouvertSansFeuille = ecranCourant(ouvert({ pointeur, progression: rendue }));
    assert.equal(ouvertSansFeuille, "code-a-verifier", `ouvert, étape ${pointeur}`);
    const ferme = ecranCourant({
      pointeur,
      coffre: COFFRE.verrouille,
      moyens: MOYENS_DE_A,
      progression: rendue,
    });
    assert.equal(ferme, "code-verifier", `verrouillé, étape ${pointeur}`);
  }
  // Un coffre dont la progression est perdue, mais qui porte un code : vérifier, pas recréer.
  const perdue = {
    coffre: COFFRE.verrouille,
    moyens: MOYENS_DE_A,
    progression: PROGRESSION_INITIALE,
  };
  assert.equal(ecranCourant({ ...perdue, pointeur: 1 }), "code-verifier");
  for (const id of ["code-verifier", "code-a-verifier"]) {
    // Aucun des deux ne CRÉE un code d'un clic : le geste reste derrière l'annonce, qui dit de
    // préparer une feuille avant que le code ne s'affiche (une seule fois).
    assert.ok(
      !ECRANS[id].blocs.includes("feuille-annonce"),
      `${id} n'offre pas d'afficher un code`,
    );
  }
  // Coffre VERROUILLÉ : afficher un code exige un coffre ouvert, et le dire est la seule conduite
  // honnête. Coffre OUVERT : la sortie existe, et l'écran nomme AUSSI la révocation (#214).
  assert.match(ECRANS["code-verifier"].attendu, /effacez les données de ce site/);
  assert.match(ECRANS["code-verifier"].attendu, /afficher un nouveau code/);
  assert.match(ECRANS["code-a-verifier"].attendu, /afficher un nouveau code/);
  assert.match(ECRANS["code-a-verifier"].attendu, /étape 9/);
  assert.doesNotMatch(ECRANS["code-a-verifier"].attendu, /effacez les données de ce site/);
});

test("« je n'ai plus cette feuille » ramène à l'annonce, et un SECOND code s'y crée (#214)", () => {
  const sansLaFeuille = ouvert({ pointeur: 3, progression: rendue, nouveauCodeDemande: true });
  assert.equal(ecranCourant(sansLaFeuille), "code-annonce");
  assert.equal(
    ecranCourant(ouvert({ pointeur: 3, progression: rendue })),
    "code-a-verifier",
    "sans la demande, on vérifie la feuille que l'on a",
  );
  // La demande ne fait rien sauter : le code reste à recopier et à confirmer.
  assert.equal(
    ecranCourant({ ...sansLaFeuille, sousEtatDuCode: SOUS_ETATS_DU_CODE.feuille }),
    "code-feuille",
  );
  assert.equal(
    ecranCourant({ ...sansLaFeuille, progression: confirmee }),
    "travailler",
    "une fois le code confirmé, la demande n'a plus de prise",
  );
  assert.ok(ECRANS["code-a-verifier"].blocs.includes("nouveau-code"), "la sortie est sur l'écran");
  assert.ok(BLOCS.includes("nouveau-code"), "le bloc est déclaré");
});

test("coffre VERROUILLÉ : « je n'ai plus cette feuille » fait d'abord ouvrir par la phrase (#214)", () => {
  // Un coffre verrouillé n'affiche aucun code — le Worker n'a pas de clé. La sortie mène donc à
  // « Rouvrir », d'où le coffre ouvert ramène à l'annonce du code. L'ordre n'est pas sauté : le
  // code reste à recopier et à confirmer avant l'étape 4.
  const verrouille = {
    pointeur: 3,
    coffre: COFFRE.verrouille,
    moyens: MOYENS_DE_A,
    progression: rendue,
  };
  assert.equal(ecranCourant(verrouille), "code-verifier");
  assert.equal(ecranCourant({ ...verrouille, nouveauCodeDemande: true }), "rouvrir");
  assert.ok(ECRANS["code-verifier"].blocs.includes("nouveau-code"), "la sortie est sur l'écran");
  assert.match(ECRANS["code-verifier"].attendu, /ouvrirez donc d'abord avec votre phrase/);
  // Une fois le coffre OUVERT, la demande mène à l'annonce, où le geste d'avant crée le code.
  assert.equal(
    ecranCourant(ouvert({ pointeur: 3, progression: rendue, nouveauCodeDemande: true })),
    "code-annonce",
  );
  // Un coffre qui n'a QUE le code reste à « Récupérer » : il n'y a pas de phrase pour l'ouvrir.
  assert.equal(
    ecranCourant({
      ...verrouille,
      moyens: ["recuperation"],
      nouveauCodeDemande: true,
    }),
    "recuperer",
  );
});

test("le COMPTE des feuilles remplace « il y en a une » (#214)", () => {
  // Deux codes posés : la ligne des moyens dit toujours « recuperation » une fois, et c'est le
  // compte, non la ligne, qui apprend au parcours combien de feuilles ouvrent ce coffre.
  const deux = ouvert({ pointeur: 3, progression: rendue, nombreDeCodes: 2 });
  assert.equal(ecranCourant(deux), "code-a-verifier");
  assert.equal(
    ecranCourant(ouvert({ pointeur: 3, progression: creee, nombreDeCodes: 0, moyens: ["phrase"] })),
    "code-annonce",
    "zéro code : le premier se crée",
  );
  assert.match(MESSAGES.codesDejaRendus(1), /déjà un code/);
  assert.match(MESSAGES.codesDejaRendus(3), /déjà 3 codes/);
  assert.match(MESSAGES.codesDejaRendus(2), /n'efface aucun des précédents/);
});

test("CONSTAT 1 : la feuille affichée DANS la page se recopie et se confirme, sans quitter l'étape 3", () => {
  const feuille = ouvert({
    pointeur: 3,
    progression: rendue,
    sousEtatDuCode: SOUS_ETATS_DU_CODE.feuille,
  });
  assert.equal(ecranCourant(feuille), "code-feuille");
  const confirmation = { ...feuille, sousEtatDuCode: SOUS_ETATS_DU_CODE.confirmation };
  assert.equal(ecranCourant(confirmation), "code-confirmation");
  assert.equal(ecranCourant({ ...confirmation, pointeur: 9 }), "code-confirmation");
});

test("CONSTAT 2 : aucune étape de 4 à 9 n'est montrée tant que le code n'est pas confirmé", () => {
  const ecransDeTravail = new Set(
    Object.entries(ECRANS)
      .filter(([, ecran]) => ecran.etape !== null && ecran.etape >= 4)
      .map(([id]) => id),
  );
  for (const progression of [creee, rendue, PROGRESSION_INITIALE]) {
    for (const pointeur of [4, 5, 6, 7, 8, 9]) {
      for (const coffre of [COFFRE.ouvert, COFFRE.verrouille]) {
        const id = ecranCourant({ pointeur, coffre, moyens: MOYENS_DE_A, progression });
        assert.ok(!ecransDeTravail.has(id), `${coffre}, étape ${pointeur} : ${id}`);
      }
    }
  }
});

test("un coffre ouvert et confirmé suit l'étape atteinte, de 4 à 9", () => {
  assert.equal(ecranCourant(ouvert({ pointeur: null })), "travailler");
  assert.equal(ecranCourant(ouvert({ pointeur: 3 })), "travailler");
  assert.equal(ecranCourant(ouvert({ pointeur: 4 })), "travailler");
  assert.equal(ecranCourant(ouvert({ pointeur: 5 })), "verrouiller");
  assert.equal(ecranCourant(ouvert({ pointeur: 6 })), "sauvegarder");
  assert.equal(ecranCourant(ouvert({ pointeur: 7 })), "restaurer-ailleurs");
  assert.equal(ecranCourant(ouvert({ pointeur: 8 })), "recuperer-preparer");
  assert.equal(ecranCourant(ouvert({ pointeur: 9 })), "revoquer");
  assert.equal(ecranCourant(ouvert({ pointeur: 9, revocationFaite: true })), "termine");
});

test("CONSTAT 9 : sous Firefox, l'étape 4 dit sa limite et n'offre pas « Démarrer »", () => {
  assert.equal(
    ecranCourant(ouvert({ pointeur: 4, moteur: "firefox" })),
    "travailler-sans-application",
  );
  assert.equal(ecranCourant(ouvert({ pointeur: 4, moteur: "chromium" })), "travailler");
  const limite = ECRANS["travailler-sans-application"];
  assert.equal(limite.etape, 4);
  assert.deepEqual(
    limite.blocs,
    [],
    "ni Démarrer, ni Continuer vers une étape qui exige l'application",
  );
  assert.equal(limite.attente, null, "aucune attente annoncée : il n'y en a pas");
  assert.match(LIMITE_DE_FIREFOX, /ne démarre pas dans Firefox/);
  assert.match(LIMITE_DE_FIREFOX, /Chrome ou Edge/);
});

test("un coffre verrouillé et confirmé : rouvrir par la phrase, ou récupérer par le code", () => {
  const verrouille = (reste) => ({ coffre: COFFRE.verrouille, progression: confirmee, ...reste });
  assert.equal(ecranCourant(verrouille({ pointeur: 5, moyens: MOYENS_DE_A })), "rouvrir");
  assert.equal(ecranCourant(verrouille({ pointeur: 8, moyens: MOYENS_DE_A })), "recuperer");
  assert.equal(
    ecranCourant(verrouille({ pointeur: 6, moyens: ["webauthn-prf", "recuperation"] })),
    "rouvrir",
  );
  assert.equal(
    ecranCourant({ coffre: COFFRE.verrouille, pointeur: 8, moyens: ["recuperation"] }),
    "recuperer",
    "un coffre restauré ne s'ouvre que par le code",
  );
});

test("un refus d'inventaire montre le refus ; une restauration coupée montre la restauration", () => {
  const refus = (code) => ({ pointeur: null, coffre: COFFRE.refuse, refus: code });
  assert.equal(ecranCourant(refus(CODES_REFUS_COQUILLE.coffreAnterieur)), "refuse");
  assert.equal(ecranCourant(refus(CODES_REFUS_COQUILLE.coffreServiSansManifeste)), "refuse");
  assert.equal(ecranCourant(refus(CODES_REFUS_COQUILLE.restaurationInterrompue)), "restaurer");
});

test("où mènent les gestes : le chemin nominal, de A à B", () => {
  assert.equal(etapeApres("creer", "commencer", null), 2);
  assert.equal(etapeApres("creer", "j-ai-une-sauvegarde", null), 7);
  assert.equal(etapeApres("choisir", "ouverture", 2), 3);
  assert.equal(etapeApres("code-confirmation", "code-confirme", 3), 4);
  assert.equal(etapeApres("code-verifier", "ouverture", 3), 4);
  assert.equal(etapeApres("travailler", "continuer", 4), 5);
  assert.equal(etapeApres("rouvrir", "ouverture", 5), 6);
  assert.equal(etapeApres("rouvrir", "ouverture", 3), 3, "rouvrir ne saute pas la confirmation");
  assert.equal(etapeApres("rouvrir", "perdu", 5), 8);
  assert.equal(etapeApres("sauvegarder", "continuer", 6), 7);
  assert.equal(etapeApres("restaurer-ailleurs", "continuer", 7), 8);
  assert.equal(etapeApres("restaurer", "restauree", 7), 8);
  assert.equal(etapeApres("recuperer", "ouverture", 8), 9);
  assert.equal(etapeApres("code-feuille", "ouverture", 3), null);
  assert.equal(etapeApres("travailler-sans-application", "continuer", 4), null);
  assert.equal(etapeApres("travailler", "inconnu", 4), null);
});

test("seule une ouverture depuis un écran qui n'offre que le code vaut confirmation du code", () => {
  assert.equal(ouvertureParLeCode("code-verifier"), true);
  assert.equal(ouvertureParLeCode("recuperer"), true);
  for (const id of ["rouvrir", "choisir", "code-a-verifier", "travailler"]) {
    assert.equal(ouvertureParLeCode(id), false, id);
  }
  // Ce que l'invariant exige est qu'aucun AUTRE moyen d'ouvrir n'y soit offert : la sortie « je
  // n'ai plus cette feuille » (#214) n'ouvre rien, elle mène à l'écran qui ouvre par la phrase.
  assert.deepEqual(ECRANS["code-verifier"].blocs, ["code", "nouveau-code"]);
  for (const bloc of ["phrase", "passkey", "perdu", "ancre"]) {
    assert.ok(!ECRANS["code-verifier"].blocs.includes(bloc), bloc);
  }
  assert.ok(
    !ECRANS.recuperer.blocs.includes("phrase") && !ECRANS.recuperer.blocs.includes("passkey"),
  );
});

test("l'étape se lit de l'URL, et rien d'autre qu'un chiffre de 1 à 9 n'y est une étape", () => {
  assert.equal(etapeDeLURL("5"), 5);
  for (const texte of [null, undefined, "", "0", "10", "5a", " 5", "-1"]) {
    assert.equal(etapeDeLURL(texte), null, String(texte));
  }
});

test("« où suis-je » et l'étape suivante ; un coffre restauré n'a pas joué ses six premières étapes ici", () => {
  const releve = ouSuisJe("sauvegarder");
  assert.equal(releve.length, 9);
  assert.deepEqual(
    releve.map((ligne) => ligne.statut),
    ["passee", "passee", "passee", "passee", "passee", "en-cours", "a-venir", "a-venir", "a-venir"],
  );
  assert.deepEqual(
    ouSuisJe("revoquer", ORIGINES_DU_COFFRE.restauration).map((ligne) => ligne.statut),
    [
      "non-jouee",
      "non-jouee",
      "non-jouee",
      "non-jouee",
      "non-jouee",
      "non-jouee",
      "passee",
      "passee",
      "en-cours",
    ],
  );
  assert.equal(etapeSuivante("sauvegarder").titre, "Restaurer sur un autre appareil");
  assert.equal(etapeSuivante("revoquer"), null);
  assert.equal(etapeSuivante("chargement"), null);
});

test("l'état du coffre se lit des relevés publiés", () => {
  assert.equal(coffreObserve({ etat: "ouvert", texteDesMoyens: "" }), COFFRE.ouvert);
  assert.equal(coffreObserve({ etat: "verrouille", texteDesMoyens: "" }), COFFRE.inconnu);
  assert.equal(
    coffreObserve({ etat: "verrouille", texteDesMoyens: "Aucun coffre sur cet appareil." }),
    COFFRE.absent,
  );
  assert.equal(
    coffreObserve({
      etat: "verrouille",
      texteDesMoyens: "Ce coffre s'ouvre par : une phrase de déverrouillage (version 1).",
      moyensProposes: ["phrase"],
    }),
    COFFRE.verrouille,
  );
  const refuse = {
    etat: "verrouille",
    texteDesMoyens: "Ce coffre ne peut pas être ouvert par cette coquille.",
    dernierRefus: CODES_REFUS_COQUILLE.coffreAnterieur,
  };
  assert.equal(coffreObserve(refuse), COFFRE.refuse);
  assert.equal(
    coffreObserve({ ...refuse, dernierRefus: "VAULT_ENVELOPPE_CLE_REFUSEE" }),
    COFFRE.absent,
    "un refus de GESTE n'est pas un refus d'inventaire",
  );
});

test("les lignes d'état publiées se lisent, code compris", () => {
  assert.deepEqual(lireLigneDEtat("cycle:demarrage-refuse:VAULT_COQUILLE_GESTE_EN_COURS"), {
    famille: "cycle",
    evenement: "demarrage-refuse",
    code: "VAULT_COQUILLE_GESTE_EN_COURS",
    detail: "VAULT_COQUILLE_GESTE_EN_COURS",
  });
  assert.deepEqual(lireLigneDEtat("portabilite:sauvegarde-prete:1024"), {
    famille: "portabilite",
    evenement: "sauvegarde-prete",
    code: null,
    detail: "1024",
  });
  assert.equal(lireLigneDEtat("cycle:application-demarree").detail, null);
  assert.equal(
    lireLigneDEtat("portabilite:revoque:2-retires:1-restant").detail,
    "2-retires:1-restant",
  );
  for (const texte of ["", "cycle", ":x", "cycle:", null]) {
    assert.equal(lireLigneDEtat(texte), null, String(texte));
  }
  assert.equal(
    codeEnFinDeTexte("Ce moyen n'ouvre pas ce coffre. (VAULT_ENVELOPPE_CLE_REFUSEE)"),
    "VAULT_ENVELOPPE_CLE_REFUSEE",
  );
  assert.equal(codeEnFinDeTexte("Choisissez d'abord le fichier de sauvegarde à restaurer."), null);
  assert.equal(codeEnFinDeTexte("(VAULT_X) suivi d'autre chose"), null);
});

// --- Ce que la page laisse, et ce qu'elle ferme ------------------------------------------------------

test("CONSTAT 3 : aucun texte écrit par le parcours ne porte un code en clair", () => {
  const code = encoderCode(tirerCodeDeRecuperation());
  assert.equal(texteSansCode(`Code complet (${code}).`), `Code complet (${MESSAGES.codeMasque}).`);
  assert.equal(
    texteSansCode(`${code} et ${code}`),
    `${MESSAGES.codeMasque} et ${MESSAGES.codeMasque}`,
  );
  assert.equal(texteSansCode("Étape 3 sur 9"), "Étape 3 sur 9");
  // L'annonce d'une saisie dit un COMPTE, jamais les symboles — ni complets, ni en partie.
  for (const saisie of [code, code.slice(0, 14), code.replaceAll("-", " ")]) {
    const annonce = annonceDeLaSaisie(etatDeLaSaisie(saisie));
    assert.ok(!annonce.includes(code.slice(0, 4)), `« ${annonce} » répète la saisie`);
  }
  assert.equal(annonceDeLaSaisie(etatDeLaSaisie("")), "");
  assert.equal(annonceDeLaSaisie(etatDeLaSaisie(code)), MESSAGES.saisieComplete);
  assert.equal(annonceDeLaSaisie(etatDeLaSaisie(code.slice(0, 9))), "8 symbole(s) sur 28.");
});

test("CONSTAT 8 : un geste est en cours tant qu'une ligne publiée le dit, et ses boutons se ferment", () => {
  assert.equal(unGesteEstEnCours({ ligneDuCycle: "cycle:demarrage-en-cours" }), true);
  assert.equal(unGesteEstEnCours({ ligneDuCycle: "cycle:verrouillage-en-cours" }), true);
  assert.equal(unGesteEstEnCours({ ligneDePortabilite: "portabilite:sauvegarde-en-cours" }), true);
  assert.equal(unGesteEstEnCours({ attenteDuDeverrouillage: "Comptez 2 s." }), true);
  assert.equal(
    unGesteEstEnCours({
      ligneDuCycle: "cycle:application-demarree",
      ligneDePortabilite: "portabilite:au-repos",
      attenteDuDeverrouillage: " ",
    }),
    false,
  );
  assert.equal(unGesteEstEnCours({}), false);
  assert.ok(GESTES_LONGS.includes("demarrer-application"));
  assert.ok(!GESTES_LONGS.includes("ouvrir-par-code"), "l'interface tient ce bouton-là");
});

test("CONSTAT 6 : aucun refus du relais n'est annoncé avant qu'un démarrage ait abouti", () => {
  const comptes = { VAULT_COQUILLE_APPLICATION_NON_DEMARREE: 4 };
  assert.deepEqual(refusDeRelaisAAnnoncer({ comptes, reference: null }), []);
  assert.deepEqual(refusDeRelaisAAnnoncer({ comptes, reference: { ...comptes } }), []);
  assert.deepEqual(
    refusDeRelaisAAnnoncer({
      comptes: { ...comptes, VAULT_COQUILLE_RELAIS_ABANDONNE: 1 },
      reference: { ...comptes },
    }),
    ["VAULT_COQUILLE_RELAIS_ABANDONNE"],
  );
});

test("la recopie du code : incomplète, mal recopiée, étrangère, confirmée", () => {
  const feuille = encoderCode(tirerCodeDeRecuperation());
  const autre = encoderCode(tirerCodeDeRecuperation());
  assert.deepEqual(confirmerLaRecopie("", feuille), {
    confirme: false,
    code: null,
    message: "Il manque des symboles : 0 sur 28.",
  });
  assert.equal(confirmerLaRecopie(feuille.slice(0, 9), feuille).confirme, false);
  // Un symbole changé : la somme de contrôle le voit, et la conduite est celle de la recopie.
  const symboles = feuille.replaceAll("-", "").split("");
  symboles[3] = symboles[3] === "0" ? "1" : "0";
  const fautif = confirmerLaRecopie(symboles.join(""), feuille);
  assert.equal(fautif.confirme, false);
  assert.equal(fautif.code, DERIVATION_ERROR_CODES.codeMalRecopie);
  assert.match(fautif.message, /faute de recopie/);
  const etranger = confirmerLaRecopie(autre, feuille);
  assert.equal(etranger.confirme, false);
  assert.equal(etranger.code, null);
  assert.match(etranger.message, /ce n'est pas celui qui vient d'être affiché/);
  // Casse, espaces et tirets sont libres : c'est le code, pas sa typographie, qui est confirmé.
  const libre = feuille.toLowerCase().replaceAll("-", " ");
  assert.deepEqual(confirmerLaRecopie(libre, feuille), {
    confirme: true,
    code: null,
    message: MESSAGES.codeConfirme,
  });
});

test("la progression d'un démarrage dit le temps écoulé et les signes de vie réels", () => {
  assert.equal(
    progressionDuDemarrage({ ecouleMs: 45_400, signesDeVie: 9 }),
    "Démarrage en cours depuis 45 seconde(s), sur environ deux minutes. Le coffre travaille : 9 signe(s) de vie reçu(s).",
  );
  assert.match(progressionDuDemarrage({ ecouleMs: -5, signesDeVie: 0 }), /depuis 0 seconde/);
  assert.match(progressionDuDemarrage({ ecouleMs: 0, signesDeVie: 0 }), /premier signe de vie/);
});

test("une seconde révocation qui ne retire rien ne fait pas noter un numéro pour rien", () => {
  assert.match(MESSAGES.revoque(2, 5), /Nouveau numéro de version/);
  assert.doesNotMatch(MESSAGES.revoqueSansRien, /numéro/);
});
