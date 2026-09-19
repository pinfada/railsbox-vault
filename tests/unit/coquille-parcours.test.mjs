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
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { etatDeLaSaisie } from "../../src/coquille/saisie-du-code.mjs";
import {
  BLOCS,
  COFFRE,
  ECRANS,
  ECRANS_AVEC_RETOUR,
  ECRANS_DE_L_APPLICATION,
  ETAPES,
  FORMAT_DE_PROGRESSION,
  GESTES_LONGS,
  LIBELLES_DES_BLOCS,
  LIMITE_DE_FIREFOX,
  MESSAGES,
  ORIGINES_DU_COFFRE,
  PROGRESSION_INITIALE,
  SOUS_ETATS_DU_CODE,
  STATUTS,
  annonceDeLaSaisie,
  attenteDeLaPhrase,
  codeEnFinDeTexte,
  coffreObserve,
  ecranCourant,
  ecrireProgression,
  etapeAdmise,
  etapeApres,
  etapeDeLURL,
  etapeSuivante,
  lireLigneDEtat,
  lireProgression,
  ouSuisJe,
  progressionApres,
  progressionDuDemarrage,
  rangAffiche,
  refusDeRelaisAAnnoncer,
  texteSansCode,
  unGesteEstEnCours,
} from "../../src/coquille/parcours.mjs";

const lire = (chemin) => readFile(new URL(`../../${chemin}`, import.meta.url), "utf8");

const creee = progressionApres(PROGRESSION_INITIALE, "coffre-cree");
const rendue = progressionApres(creee, "code-rendu", 2);
// La feuille éprouvée : ce que le Worker a CONSTATÉ, recopié en indice (#239).
const eprouvee = progressionApres(rendue, "feuille", true);
const MOYENS_DE_A = ["phrase", "recuperation"];

const ouvert = (reste) => ({
  coffre: COFFRE.ouvert,
  moyens: MOYENS_DE_A,
  progression: eprouvee,
  feuilleEprouvee: true,
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
  const branchement =
    (await lire("public/coquille/parcours-de-la-page.mjs")) +
    (await lire("public/coquille/observateurs-du-parcours.mjs"));
  const pageSansBlancs = page.replace(/\s+/g, " ");
  for (const [bloc, libelles] of Object.entries(LIBELLES_DES_BLOCS)) {
    for (const libelle of libelles) {
      for (const [, nom] of libelle.matchAll(/« ([^»]+) »/g)) {
        if (nom.endsWith(":")) continue;
        assert.ok(
          pageSansBlancs.includes(`>${nom}<`) ||
            pageSansBlancs.includes(`> ${nom} <`) ||
            branchement.includes(`"${nom}"`) ||
            // Un libellé que le bloc de mise à jour pose lui-même, depuis les textes (QA de #249).
            Object.values(MESSAGES).includes(nom),
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
  // #242, défaut 13 : « moins d'une seconde » annonçait la dérivation seule ; le geste en prend deux.
  assert.match(attenteDeLaPhrase(446), /environ 2 secondes/);
  assert.match(attenteDeLaPhrase(2207), /environ 4 secondes/);
  assert.doesNotMatch(attenteDeLaPhrase(446), /moins d'une seconde/);
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

// --- La PROGRESSION (revue de la PR #213, constats 1 et 2 ; #239) ----------------------------------

test("la progression se relit, et tout ce qui n'a pas exactement sa forme vaut la progression initiale", () => {
  const termine = progressionApres(eprouvee, "visite-terminee");
  assert.deepEqual(lireProgression(ecrireProgression(termine)), {
    ...termine,
    code: PROGRESSION_INITIALE.code,
  });
  const valide = JSON.parse(ecrireProgression(eprouvee));
  assert.equal(valide.version, FORMAT_DE_PROGRESSION);
  const abimees = [
    null,
    "",
    "{",
    "[]",
    JSON.stringify({ ...valide, version: 3 }),
    JSON.stringify({ ...valide, etapeAtteinte: 10 }),
    JSON.stringify({ ...valide, etapeAtteinte: 0 }),
    JSON.stringify({ ...valide, etapeAtteinte: "9" }),
    JSON.stringify({ ...valide, origine: "ailleurs" }),
    JSON.stringify({ ...valide, feuilleEprouvee: "oui" }),
    JSON.stringify({ ...valide, visiteTerminee: 1 }),
    JSON.stringify({ ...valide, code: { ...valide.code, version: 0 } }),
    JSON.stringify({ ...valide, code: { ...valide.code, valeur: "ABCD-EFGH" } }),
    JSON.stringify({ ...valide, code: { ...valide.code, confirme: true } }),
    JSON.stringify({ ...valide, code: null }),
    JSON.stringify({ ...valide, phrase: "x" }),
  ];
  for (const texte of abimees) {
    assert.deepEqual(lireProgression(texte), PROGRESSION_INITIALE, String(texte));
  }
});

test("un fichier du format 1 (avant #239) se relit : l'étape et l'origine, jamais une feuille éprouvée", () => {
  const ancien = {
    version: 1,
    etapeAtteinte: 9,
    origine: "creation",
    code: { rendu: true, version: 2, confirme: true },
  };
  assert.deepEqual(lireProgression(JSON.stringify(ancien)), {
    ...PROGRESSION_INITIALE,
    etapeAtteinte: 9,
  });
  const faux = { ...ancien, code: { rendu: true, version: 2 } };
  assert.deepEqual(lireProgression(JSON.stringify(faux)), PROGRESSION_INITIALE);
});

test("la progression écrite ne porte que ses champs : jamais le code, jamais la phrase", () => {
  const avecIntrus = { ...eprouvee, code: { ...eprouvee.code, valeur: "SECRET" }, phrase: "x" };
  const ecrite = JSON.parse(ecrireProgression(avecIntrus));
  assert.deepEqual(Object.keys(ecrite).sort(), [
    "code",
    "etapeAtteinte",
    "feuilleEprouvee",
    "origine",
    "version",
    "visiteTerminee",
  ]);
  assert.deepEqual(Object.keys(ecrite.code).sort(), ["rendu", "version"]);
  assert.doesNotMatch(JSON.stringify(ecrite), /SECRET/);
});

test("chaque pas rend une NOUVELLE progression, et un coffre neuf n'hérite d'aucune feuille éprouvée", () => {
  assert.equal(creee.etapeAtteinte, 3);
  assert.deepEqual(rendue.code, { rendu: true, version: 2 });
  assert.equal(rendue.feuilleEprouvee, false);
  assert.equal(eprouvee.feuilleEprouvee, true);
  assert.equal(eprouvee.etapeAtteinte, 4, "une feuille éprouvée ouvre l'étape 4");
  assert.ok(Object.isFrozen(eprouvee) && Object.isFrozen(eprouvee.code));
  assert.notEqual(eprouvee, rendue);
  const retiree = progressionApres(progressionApres(eprouvee, "etape", 7), "feuille", false);
  assert.equal(retiree.feuilleEprouvee, false, "le Worker ne la constate plus : l'indice tombe");
  assert.equal(retiree.etapeAtteinte, 7, "l'étape atteinte ne recule pas");
  assert.equal(progressionApres(rendue, "feuille", "oui").feuilleEprouvee, false);
  const recommence = progressionApres(progressionApres(eprouvee, "etape", 9), "coffre-cree");
  assert.equal(recommence.feuilleEprouvee, false, "un coffre recréé exige une nouvelle preuve");
  assert.equal(recommence.visiteTerminee, false);
  assert.equal(recommence.etapeAtteinte, 3);
  assert.equal(progressionApres(eprouvee, "visite-terminee").visiteTerminee, true);
  assert.equal(
    progressionApres(eprouvee, "etape", 2).etapeAtteinte,
    4,
    "on n'atteint pas en reculant",
  );
  const restauree = progressionApres(progressionApres(eprouvee, "visite-terminee"), "restauree");
  assert.equal(restauree.origine, ORIGINES_DU_COFFRE.restauration);
  assert.equal(restauree.etapeAtteinte, 8);
  assert.equal(restauree.feuilleEprouvee, false, "la preuve ne voyage pas dans l'archive");
  assert.equal(restauree.visiteTerminee, false);
  assert.throws(() => progressionApres(eprouvee, "inconnu"), /inconnu/);
  assert.throws(() => progressionApres(eprouvee, "code-confirme"), /inconnu/);
});

test("ORDRE : vers l'avant, une étape demandée est ramenée à l'étape atteinte ; vers l'arrière, tout est admis", () => {
  assert.equal(etapeAdmise(4, creee), 3);
  assert.equal(etapeAdmise(9, rendue), 3);
  assert.equal(etapeAdmise(2, eprouvee), 2, "revenir en arrière reste permis");
  assert.equal(etapeAdmise(4, progressionApres(eprouvee, "etape", 9)), 4);
  assert.equal(etapeAdmise(null, eprouvee), 4, "sans demande, on reprend là où on en était");
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
      ecranCourant(
        ouvert({ pointeur, moyens: ["phrase"], progression: creee, feuilleEprouvee: false }),
      ),
      "code-annonce",
      `étape ${pointeur}`,
    );
  }
});

test("#239 : un code rendu et jamais éprouvé fait d'abord ÉPROUVER la feuille que l'on a", () => {
  for (const pointeur of [null, 3, 4, 5, 6, 7, 8, 9]) {
    const ouvertSansPreuve = ecranCourant(
      ouvert({ pointeur, progression: rendue, feuilleEprouvee: false }),
    );
    assert.equal(ouvertSansPreuve, "code-a-verifier", `ouvert, étape ${pointeur}`);
    const ferme = ecranCourant({
      pointeur,
      coffre: COFFRE.verrouille,
      moyens: MOYENS_DE_A,
      progression: rendue,
    });
    assert.equal(
      ferme,
      pointeur === 8 ? "recuperer" : "code-verifier",
      `verrouillé, étape ${pointeur}`,
    );
  }
  // Un coffre dont la progression est perdue, mais qui porte un code : vérifier, pas recréer.
  const perdue = {
    coffre: COFFRE.verrouille,
    moyens: MOYENS_DE_A,
    progression: PROGRESSION_INITIALE,
  };
  assert.equal(ecranCourant({ ...perdue, pointeur: 1 }), "code-verifier");
  for (const id of ["code-verifier", "code-a-verifier", "code-a-verrouiller"]) {
    // Aucun ne CRÉE un code d'un clic : le geste reste derrière l'annonce, qui dit de préparer une
    // feuille avant que le code ne s'affiche (une seule fois).
    assert.ok(
      !ECRANS[id].blocs.includes("feuille-annonce"),
      `${id} n'offre pas d'afficher un code`,
    );
  }
  assert.match(ECRANS["code-verifier"].attendu, /effacez les données de ce site/);
  assert.match(ECRANS["code-verifier"].attendu, /afficher un nouveau code/);
  assert.match(ECRANS["code-verifier"].ceQuiVaSePasser, /qu'une fois/);
  assert.match(ECRANS["code-a-verifier"].attendu, /afficher un nouveau code/);
  assert.match(ECRANS["code-a-verifier"].attendu, /Révoquer tous les autres moyens/);
  assert.doesNotMatch(ECRANS["code-a-verifier"].attendu, /effacez les données de ce site/);
});

test("#239, VULN-04 : l'indice de parcours.json ne choisit que le premier formulaire, jamais un écran de travail", () => {
  // Un fichier falsifié qui dit « éprouvée » et « étape 9 » : verrouillé, il montre « Rouvrir »
  // au lieu de « Vérifier » — un détour d'un écran. Ouvert, sans le constat du Worker, rien de 4 à 9.
  const falsifiee = progressionApres(progressionApres(rendue, "etape", 9), "feuille", true);
  const verrouille = { coffre: COFFRE.verrouille, moyens: MOYENS_DE_A, progression: falsifiee };
  assert.equal(ecranCourant({ ...verrouille, pointeur: 9 }), "rouvrir");
  for (const pointeur of [4, 5, 6, 7, 8, 9]) {
    assert.equal(
      ecranCourant(ouvert({ pointeur, progression: falsifiee, feuilleEprouvee: false })),
      "code-a-verifier",
      `étape ${pointeur}`,
    );
  }
  // Et l'inverse : le constat du Worker suffit, quel que soit le fichier.
  assert.equal(
    ecranCourant(ouvert({ pointeur: 6, progression: PROGRESSION_INITIALE })),
    "sauvegarder",
  );
});

test("« je n'ai plus cette feuille » ramène à l'annonce, et un SECOND code s'y crée (#214)", () => {
  const sansLaFeuille = ouvert({
    pointeur: 3,
    progression: rendue,
    feuilleEprouvee: false,
    nouveauCodeDemande: true,
  });
  assert.equal(ecranCourant(sansLaFeuille), "code-annonce");
  assert.equal(
    ecranCourant({ ...sansLaFeuille, nouveauCodeDemande: false }),
    "code-a-verifier",
    "sans la demande, on éprouve la feuille que l'on a",
  );
  // La demande ne fait rien sauter : le code reste à recopier puis à éprouver.
  assert.equal(
    ecranCourant({ ...sansLaFeuille, sousEtatDuCode: SOUS_ETATS_DU_CODE.feuille }),
    "code-feuille",
  );
  assert.ok(ECRANS["code-a-verifier"].blocs.includes("nouveau-code"), "la sortie est sur l'écran");
  // L'annonce offre de revenir, et la révocation qui fait de la place (#239, enveloppe pleine).
  assert.ok(ECRANS["code-annonce"].blocs.includes("feuille-revenir"));
  assert.ok(ECRANS["code-annonce"].blocs.includes("revocation"));
  assert.match(MESSAGES.codesDejaRendus(1), /Revenir : j'ai toujours ma feuille/);
});

test("coffre VERROUILLÉ : « je n'ai plus cette feuille » fait d'abord ouvrir par la phrase (#214)", () => {
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
  assert.equal(
    ecranCourant({ ...verrouille, moyens: ["recuperation"], nouveauCodeDemande: true }),
    "recuperer",
    "un coffre qui n'a QUE le code reste à « Récupérer »",
  );
});

test("le COMPTE des feuilles remplace « il y en a une » (#214)", () => {
  const deux = ouvert({
    pointeur: 3,
    progression: rendue,
    nombreDeCodes: 2,
    feuilleEprouvee: false,
  });
  assert.equal(ecranCourant(deux), "code-a-verifier");
  assert.equal(
    ecranCourant(
      ouvert({
        pointeur: 3,
        progression: creee,
        nombreDeCodes: 0,
        moyens: ["phrase"],
        feuilleEprouvee: false,
      }),
    ),
    "code-annonce",
    "zéro code : le premier se crée",
  );
  assert.match(MESSAGES.codesDejaRendus(1), /déjà un code/);
  assert.match(MESSAGES.codesDejaRendus(3), /déjà 3 codes/);
  assert.match(MESSAGES.codesDejaRendus(2), /n'efface aucun des précédents/);
});

test("#239 : la feuille affichée DANS la page se recopie, puis s'éprouve en verrouillant", () => {
  const feuille = ouvert({
    pointeur: 3,
    progression: rendue,
    feuilleEprouvee: false,
    sousEtatDuCode: SOUS_ETATS_DU_CODE.feuille,
  });
  assert.equal(ecranCourant(feuille), "code-feuille");
  const recopiee = { ...feuille, sousEtatDuCode: SOUS_ETATS_DU_CODE.recopie };
  assert.equal(ecranCourant(recopiee), "code-a-verrouiller");
  assert.deepEqual(ECRANS["code-a-verrouiller"].blocs, ["revoir", "verrouiller"]);
  assert.match(ECRANS["code-a-verrouiller"].ceQuiVaSePasser, /verrouillez votre coffre/);
  assert.match(ECRANS["code-a-verrouiller"].ceQuiVaSePasser, /votre phrase le rouvre/);
  assert.equal(ECRANS["code-a-verrouiller"].etape, 3);
  assert.equal(ECRANS["code-confirmation"], undefined, "la recopie au DOM a disparu");
  assert.deepEqual(Object.keys(SOUS_ETATS_DU_CODE).sort(), ["annonce", "feuille", "recopie"]);
});

test("#239 : aucun écran de travail sans feuille éprouvée ; la récupération permet de l'éprouver", () => {
  const ecransDeTravail = new Set(
    Object.entries(ECRANS)
      .filter(([id, ecran]) => id !== "recuperer" && ecran.etape !== null && ecran.etape >= 4)
      .map(([id]) => id),
  );
  for (const progression of [creee, rendue, eprouvee, PROGRESSION_INITIALE]) {
    for (const pointeur of [4, 5, 6, 7, 8, 9]) {
      for (const coffre of [COFFRE.ouvert, COFFRE.verrouille]) {
        const id = ecranCourant({
          pointeur,
          coffre,
          moyens: MOYENS_DE_A,
          progression,
          feuilleEprouvee: false,
        });
        assert.ok(
          !ecransDeTravail.has(id) || id === "rouvrir",
          `${coffre}, étape ${pointeur} : ${id}`,
        );
      }
    }
  }
});

test("un coffre ouvert et éprouvé suit l'étape montrée, de 4 à 9", () => {
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

test("#239 : après « Parcours terminé », l'étape 4 est l'ACCUEIL, avec les gestes du quotidien", () => {
  const finie = progressionApres(progressionApres(eprouvee, "etape", 9), "visite-terminee");
  assert.equal(ecranCourant(ouvert({ pointeur: 4, progression: finie })), "accueil");
  assert.equal(ecranCourant(ouvert({ pointeur: null, progression: finie })), "accueil");
  assert.equal(ecranCourant(ouvert({ pointeur: 6, progression: finie })), "sauvegarder");
  const accueil = ECRANS.accueil;
  assert.equal(accueil.etape, 4);
  assert.match(accueil.ceQuiVaSePasser, /La visite est finie/);
  for (const bloc of [
    "application",
    "espace-de-travail",
    "verrouiller",
    "sauvegarde",
    "revocation",
  ]) {
    assert.ok(accueil.blocs.includes(bloc), bloc);
  }
  assert.ok(!accueil.blocs.includes("continuer"), "plus rien à continuer");
  assert.deepEqual(ECRANS_DE_L_APPLICATION, ["travailler", "accueil"]);
  assert.equal(
    ecranCourant(ouvert({ pointeur: 4, progression: finie, moteur: "firefox" })),
    "travailler-sans-application",
  );
});

test("#239 : les écrans 5 à 9 et « Parcours terminé » portent « Revenir à mon application »", () => {
  const avecRetour = Object.entries(ECRANS)
    .filter(([, ecran]) => ecran.blocs.includes("retour"))
    .map(([id]) => id)
    .sort();
  assert.deepEqual(avecRetour, [...ECRANS_AVEC_RETOUR].sort());
  for (const id of ECRANS_AVEC_RETOUR) {
    assert.ok(ECRANS[id].etape >= 5, id);
    assert.equal(etapeApres(id, "retour", ECRANS[id].etape, 9), 4, id);
  }
  for (const id of ["travailler", "rouvrir", "recuperer", "code-verifier", "code-annonce"]) {
    assert.equal(etapeApres(id, "retour", 4, 9), null, id);
  }
  assert.match(ECRANS.termine.attendu, /ci-dessous/);
  assert.doesNotMatch(ECRANS.termine.attendu, /ci-dessus/);
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

test("un coffre verrouillé et éprouvé : rouvrir par la phrase, ou récupérer par le code", () => {
  const verrouille = (reste) => ({ coffre: COFFRE.verrouille, progression: eprouvee, ...reste });
  assert.equal(ecranCourant(verrouille({ pointeur: 5, moyens: MOYENS_DE_A })), "rouvrir");
  assert.equal(ecranCourant(verrouille({ pointeur: 9, moyens: MOYENS_DE_A })), "rouvrir");
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
  assert.equal(
    etapeApres("code-verifier", "ouverture", 3),
    4,
    "la feuille éprouvée ouvre l'étape 4",
  );
  assert.equal(etapeApres("travailler", "continuer", 4, 4), 5);
  assert.equal(etapeApres("rouvrir", "ouverture", 5), 6, "l'exercice de l'étape 5 avance");
  assert.equal(
    etapeApres("rouvrir", "perdu", 5),
    null,
    "la phrase oubliée ne déplace pas la visite",
  );
  assert.equal(etapeApres("sauvegarder", "continuer", 6), 7);
  assert.equal(etapeApres("restaurer-ailleurs", "continuer", 7), 8);
  assert.equal(etapeApres("restaurer", "restauree", 7), 8);
  assert.equal(etapeApres("recuperer", "ouverture", 8), 9, "l'exercice de l'étape 8 avance");
  assert.equal(etapeApres("code-feuille", "ouverture", 3), null);
  assert.equal(etapeApres("code-confirmation", "code-confirme", 3), null);
  assert.equal(etapeApres("travailler-sans-application", "continuer", 4), null);
  assert.equal(etapeApres("travailler", "inconnu", 4), null);
  assert.equal(etapeApres("accueil", "continuer", 4, 9), null, "l'accueil ne continue rien");
});

test("#239 : une ouverture de ROUTINE mène à l'application, quelle que soit l'étape mémorisée", () => {
  for (const pointeur of [null, 1, 3, 4, 6, 7, 8, 9]) {
    assert.equal(etapeApres("rouvrir", "ouverture", pointeur), 4, `rouvrir, étape ${pointeur}`);
  }
  for (const pointeur of [null, 3, 4, 6, 7, 8, 9]) {
    assert.equal(etapeApres("code-verifier", "ouverture", pointeur), 4, `vérifier, ${pointeur}`);
  }
  assert.equal(etapeApres("code-verifier", "ouverture", 5), 6);
  for (const pointeur of [null, 4, 5, 6, 7, 9]) {
    // Le cas de la QA : une origine RESTAURÉE ne s'ouvre que par « Récupérer », qui menait toujours à
    // l'étape 9 — `?etape=4` n'y changeait rien.
    assert.equal(etapeApres("recuperer", "ouverture", pointeur), 4, `récupérer, ${pointeur}`);
  }
});

test("#239 : « Continuer » depuis l'application mène à la prochaine étape NON jouée", () => {
  assert.equal(etapeApres("travailler", "continuer", 4, 4), 5);
  assert.equal(etapeApres("travailler", "continuer", 4, 5), 5);
  assert.equal(etapeApres("travailler", "continuer", 4, 7), 7);
  assert.equal(etapeApres("travailler", "continuer", 4, 9), 9);
  assert.equal(etapeApres("travailler", "continuer", null, 3), 5);
});

test("« où suis-je » ne compte plus d'écran de recopie ; l'ouverture par le code est l'affaire du Worker", () => {
  assert.equal(ECRANS["code-verifier"].etape, 3);
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

test("QA de #244 : « J'ai oublié ma phrase » est une ouverture de ROUTINE, jamais un saut vers 8 ou 9", () => {
  const verrouille = (pointeur, progression) => ({
    pointeur,
    coffre: COFFRE.verrouille,
    moyens: MOYENS_DE_A,
    progression,
    phrasePerdue: true,
  });
  // Étape 3 (feuille mal recopiée), étape 4, étape 5, après la visite : le formulaire du code.
  for (const [pointeur, progression] of [
    [3, rendue],
    [4, eprouvee],
    [5, eprouvee],
    [9, progressionApres(eprouvee, "visite-terminee")],
  ]) {
    assert.equal(ecranCourant(verrouille(pointeur, progression)), "recuperer", `étape ${pointeur}`);
    // Ouvrir par le code depuis là mène à l'application, et ne marque aucune étape jouée.
    assert.equal(etapeApres("recuperer", "ouverture", pointeur), 4, `étape ${pointeur}`);
  }
  assert.equal(etapeApres("rouvrir", "perdu", 4), null);
  // Seule l'étape 8 atteinte PAR LA VISITE avance vers 9.
  assert.equal(etapeApres("recuperer", "ouverture", 8), 9);
});

test("décision du 19/09 : l'étape 9 est FACULTATIVE, et sa conséquence est dite", () => {
  assert.equal(ecranCourant(ouvert({ pointeur: 9 })), "revoquer");
  assert.equal(ecranCourant(ouvert({ pointeur: 9, sansRevoquer: true })), "termine-sans-revoquer");
  assert.equal(ecranCourant(ouvert({ pointeur: 9, revocationFaite: true })), "termine");
  assert.deepEqual(ECRANS.revoquer.blocs, ["revocation", "sans-revoquer", "retour"]);
  assert.match(ECRANS.revoquer.ceQuiVaSePasser, /facultative/);
  assert.match(ECRANS.revoquer.ceQuiVaSePasser, /écrit au-dessus du bouton/);
  assert.match(ECRANS.revoquer.attendu, /Terminer sans révoquer/);
  assert.match(ECRANS.accueil.ceQuiVaSePasser, /écrit au-dessus du bouton/);
  assert.match(ECRANS["termine-sans-revoquer"].ceQuiVaSePasser, /ouvrent toujours/);
  assert.ok(ECRANS_AVEC_RETOUR.includes("termine-sans-revoquer"));
  // L'écran 3 ne promet plus ce que la révocation retirerait.
  assert.match(ECRANS["code-verifier"].ceQuiVaSePasser, /tant que vous ne l'avez pas révoquée/);
});

test("QA de #244 : « Où suis-je ? » dit la vérité — pendant la visite et après elle", () => {
  const atteinte7 = progressionApres(eprouvee, "etape", 7);
  assert.deepEqual(
    ouSuisJe("travailler", ORIGINES_DU_COFFRE.creation, atteinte7).map((ligne) => ligne.statut),
    ["passee", "passee", "passee", "en-cours", "passee", "passee", "a-venir", "a-venir", "a-venir"],
  );
  const finie = progressionApres(progressionApres(eprouvee, "etape", 9), "visite-terminee");
  assert.ok(
    ouSuisJe("accueil", ORIGINES_DU_COFFRE.creation, finie).every(
      (ligne) => ligne.statut === "passee",
    ),
    "la visite finie : aucune étape en cours ni à venir",
  );
  assert.deepEqual(
    ouSuisJe("accueil", ORIGINES_DU_COFFRE.restauration, finie).map((ligne) => ligne.statut),
    [...Array(6).fill("non-jouee"), "passee", "passee", "passee"],
  );
  assert.equal(STATUTS.passee, "étape passée");
});

test("QA de #244 : hors de la visite, un titre ne porte pas de numéro d'étape", () => {
  assert.equal(rangAffiche("rouvrir", 5, eprouvee), 5, "l'exercice de l'étape 5");
  assert.equal(rangAffiche("rouvrir", 9, eprouvee), null, "une réouverture de routine");
  assert.equal(rangAffiche("recuperer", 8, eprouvee), 8);
  assert.equal(rangAffiche("recuperer", 4, eprouvee), null, "la phrase oubliée");
  assert.equal(rangAffiche("sauvegarder", 6, eprouvee), 6);
  const finie = progressionApres(eprouvee, "visite-terminee");
  assert.equal(rangAffiche("sauvegarder", 6, finie), null);
  assert.equal(rangAffiche("accueil", 4, eprouvee), null);
  assert.equal(rangAffiche("chargement", null, eprouvee), null);
});

test("contre-recette de #244 : l'avertissement de révocation dit ce que retire le moyen de la SÉANCE", () => {
  const phrase = MESSAGES.avertissementDeRevocation("phrase");
  assert.match(phrase, /— votre phrase — continuera de l'ouvrir/);
  assert.match(
    phrase,
    /votre feuille de récupération ne servira plus à rien, créez-en une nouvelle/,
  );
  const passkey = MESSAGES.avertissementDeRevocation("webauthn-prf");
  assert.match(passkey, /— votre passkey — continuera/);
  assert.match(passkey, /Votre phrase et vos codes de récupération ne fonctionneront plus/);
  const code = MESSAGES.avertissementDeRevocation("recuperation");
  assert.match(code, /— le code de votre feuille — continuera/);
  assert.match(code, /Votre phrase et votre passkey ne fonctionneront plus/);
  assert.doesNotMatch(code, /feuille de récupération ne servira plus/);
  assert.match(MESSAGES.avertissementDeRevocation(null), /tous les autres ne fonctionneront plus/);
});

test("contre-recette de #244 : ouvrir avec le code de la feuille dont on disait « je ne l'ai plus » vaut preuve", () => {
  // Coffre ouvert PAR CE CODE : le Worker constate la feuille, la demande tombe, étape 4.
  assert.equal(
    ecranCourant(ouvert({ pointeur: 3, progression: rendue, nouveauCodeDemande: true })),
    "travailler",
  );
  // Ouvert par la phrase, sans preuve : la demande tient, l'annonce crée le nouveau code.
  assert.equal(
    ecranCourant(
      ouvert({
        pointeur: 3,
        progression: rendue,
        nouveauCodeDemande: true,
        feuilleEprouvee: false,
      }),
    ),
    "code-annonce",
  );
});
