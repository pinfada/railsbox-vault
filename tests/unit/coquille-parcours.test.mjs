/**
 * Le PARCOURS GUIDÉ (#193, ADR 0040) : quel écran, dans quel ordre, et où mène chaque geste.
 *
 * Tout ce qui est éprouvé ici est pur : `src/coquille/parcours.mjs` ne touche ni au DOM ni à un
 * stockage. La page qui l'applique est éprouvée par l'E2E « utilisateur »
 * (`tests/e2e/parcours-utilisateur.spec.mjs`).
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  encoderCode,
  tirerCodeDeRecuperation,
} from "../../src/vm/derivation/code-de-recuperation.mjs";
import { DERIVATION_ERROR_CODES } from "../../src/vm/derivation/derivation-errors.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import {
  BLOCS,
  COFFRE,
  ECRANS,
  ETAPES,
  SOUS_ETATS_DU_CODE,
  attenteDeLaPhrase,
  codeEnFinDeTexte,
  coffreObserve,
  confirmerLaRecopie,
  ecranCourant,
  etapeApres,
  etapeDeLURL,
  etapeSuivante,
  lireLigneDEtat,
  ouSuisJe,
  progressionDuDemarrage,
} from "../../src/coquille/parcours.mjs";

const ouvert = (reste) => ({ coffre: COFFRE.ouvert, aRecuperation: true, ...reste });

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
});

test("sans coffre : créer, choisir, ou restaurer selon l'étape atteinte", () => {
  assert.equal(ecranCourant({ pointeur: null, coffre: COFFRE.absent }), "creer");
  assert.equal(ecranCourant({ pointeur: 2, coffre: COFFRE.absent }), "choisir");
  assert.equal(ecranCourant({ pointeur: 7, coffre: COFFRE.absent }), "restaurer");
  assert.equal(ecranCourant({ pointeur: 5, coffre: COFFRE.absent }), "creer");
  assert.equal(ecranCourant({ pointeur: null, coffre: COFFRE.inconnu }), "chargement");
});

test("un coffre ouvert SANS moyen de récupération ramène toujours à l'étape 3", () => {
  for (const pointeur of [null, 1, 2, 3, 4, 5, 6, 7, 8, 9]) {
    assert.equal(
      ecranCourant(ouvert({ pointeur, aRecuperation: false })),
      "code-annonce",
      `étape ${pointeur}`,
    );
  }
  assert.equal(
    ecranCourant(ouvert({ pointeur: 3, sousEtatDuCode: SOUS_ETATS_DU_CODE.confirmation })),
    "code-confirmation",
    "un code créé mais pas confirmé ne laisse pas avancer",
  );
});

test("un coffre ouvert suit l'étape atteinte, de 4 à 9", () => {
  assert.equal(ecranCourant(ouvert({ pointeur: null })), "travailler");
  assert.equal(ecranCourant(ouvert({ pointeur: 4 })), "travailler");
  assert.equal(ecranCourant(ouvert({ pointeur: 5 })), "verrouiller");
  assert.equal(ecranCourant(ouvert({ pointeur: 6 })), "sauvegarder");
  assert.equal(ecranCourant(ouvert({ pointeur: 7 })), "restaurer-ailleurs");
  assert.equal(ecranCourant(ouvert({ pointeur: 8 })), "recuperer-preparer");
  assert.equal(ecranCourant(ouvert({ pointeur: 9 })), "revoquer");
  assert.equal(ecranCourant(ouvert({ pointeur: 9, revocationFaite: true })), "termine");
});

test("un coffre verrouillé : rouvrir par la phrase, ou récupérer par le code", () => {
  const verrouille = (reste) => ({ coffre: COFFRE.verrouille, ...reste });
  assert.equal(ecranCourant(verrouille({ pointeur: 5, moyens: ["phrase"] })), "rouvrir");
  assert.equal(ecranCourant(verrouille({ pointeur: 8, moyens: ["phrase"] })), "recuperer");
  assert.equal(ecranCourant(verrouille({ pointeur: 6, moyens: ["webauthn-prf"] })), "rouvrir");
  assert.equal(
    ecranCourant(verrouille({ pointeur: 5, moyens: ["recuperation"] })),
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
  assert.equal(etapeApres("travailler", "continuer", 4), 5);
  assert.equal(etapeApres("rouvrir", "ouverture", 5), 6);
  assert.equal(etapeApres("rouvrir", "ouverture", 3), 3, "rouvrir ne saute pas la confirmation");
  assert.equal(etapeApres("rouvrir", "perdu", 5), 8);
  assert.equal(etapeApres("sauvegarder", "continuer", 6), 7);
  assert.equal(etapeApres("restaurer-ailleurs", "continuer", 7), 8);
  assert.equal(etapeApres("restaurer", "restauree", 7), 8);
  assert.equal(etapeApres("recuperer", "ouverture", 8), 9);
  assert.equal(etapeApres("code-feuille", "ouverture", 3), null);
  assert.equal(etapeApres("travailler", "inconnu", 4), null);
});

test("l'étape se lit de l'URL, et rien d'autre qu'un chiffre de 1 à 9 n'y est une étape", () => {
  assert.equal(etapeDeLURL("5"), 5);
  for (const texte of [null, undefined, "", "0", "10", "5a", " 5", "-1"]) {
    assert.equal(etapeDeLURL(texte), null, String(texte));
  }
});

test("« où suis-je » et l'étape suivante", () => {
  const releve = ouSuisJe("sauvegarder");
  assert.equal(releve.length, 9);
  assert.deepEqual(
    releve.map((ligne) => ligne.statut),
    ["passee", "passee", "passee", "passee", "passee", "en-cours", "a-venir", "a-venir", "a-venir"],
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
  assert.equal(confirmerLaRecopie(libre, feuille).confirme, true);
});

test("la progression d'un démarrage dit le temps écoulé et les signes de vie réels", () => {
  assert.equal(
    progressionDuDemarrage({ ecouleMs: 45_400, signesDeVie: 9 }),
    "Démarrage en cours depuis 45 seconde(s), sur environ deux minutes. Le coffre travaille : 9 signe(s) de vie reçu(s).",
  );
  assert.match(progressionDuDemarrage({ ecouleMs: -5, signesDeVie: 0 }), /depuis 0 seconde/);
  assert.match(progressionDuDemarrage({ ecouleMs: 0, signesDeVie: 0 }), /premier signe de vie/);
});
