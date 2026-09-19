// Ce que l'ACCUEIL dit d'une mise à jour (recette QA de la PR #249, Q1 à Q3, Q7, Q8) : le module pur
// `accueil-de-la-mise-a-jour.mjs`, et la phase que le guest fait commencer (`phase-du-boot.mjs`).

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHEMINS_DU_DEMARRAGE as CH,
  attenduSousLeDephasage,
  attenteDuDephasage,
  cheminDuDemarrage,
  demarrerEstPossible,
  progressionDuChemin,
  refusQuiTient,
  repriseSeule,
  texteDeDemarrage,
  texteDeLaPhase,
  texteDeSauvegardePrete,
  versionAffichee,
} from "../../src/coquille/accueil-de-la-mise-a-jour.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import {
  ATTENTE_DE_LA_MISE_A_JOUR,
  DUREE_DE_LA_MISE_A_JOUR,
  DUREE_DE_PLUS_TARD,
  MESSAGES,
} from "../../src/coquille/textes-du-parcours.mjs";
import {
  PHASES_DU_BOOT,
  phaseDeLaLigne,
  phaseDuBoot,
  poserLaPhase,
} from "../../src/vm/phase-du-boot.mjs";
import { creerVeilleurDeSchema } from "../../src/vm/constat-de-schema.mjs";

const proposee = (autres = {}) => ({
  issue: "mettre-a-jour",
  coffre: { version: "1.0.0" },
  servie: { version: "1.1.0" },
  migration: true,
  plusTard: true,
  reprise: false,
  cible: null,
  ...autres,
});

test("Q1 : la reprise seule est reconnue, et « Démarrer » n'y est pas un geste", () => {
  const reprise = proposee({ plusTard: false, reprise: true, cible: { version: "1.1.0" } });
  assert.equal(repriseSeule(reprise), true);
  assert.equal(repriseSeule(proposee()), false);
  assert.equal(demarrerEstPossible({ dephasage: reprise }), false);
  assert.equal(demarrerEstPossible({ dephasage: proposee() }), true);
  assert.equal(attenduSousLeDephasage({ dephasage: reprise }), MESSAGES.attenduDeLaReprise);
  assert.match(MESSAGES.miseAJourAReprendre, /commencée et n'est pas terminée/);
  assert.doesNotMatch(MESSAGES.miseAJourAReprendre, /ne sert plus/);
});

test("Q8 : sous la reprise, la sauvegarde dit ce qu'elle contiendra et avec quoi elle se rouvre", () => {
  const texte = MESSAGES.miseAJourSauvegardeAvantReprise("1.1.0");
  assert.match(texte, /mise à jour inachevée comprise/);
  assert.match(texte, /version 1\.1\.0 de l'application ou une plus récente/);
  assert.doesNotMatch(texte, /tel qu'il est aujourd'hui/);
});

test("Q2 : UNE durée par chemin, et la phase dite", () => {
  assert.equal(cheminDuDemarrage({ dephasage: null }), CH.ordinaire);
  assert.equal(cheminDuDemarrage({ dephasage: proposee() }), CH.plusTard);
  assert.equal(cheminDuDemarrage({ dephasage: proposee(), miseAJourDemandee: true }), CH.miseAJour);
  assert.equal(cheminDuDemarrage({ dephasage: proposee({ plusTard: false }) }), CH.ordinaire);
  const maj = progressionDuChemin({ chemin: CH.miseAJour, secondes: 42, phase: "donnees" });
  assert.match(maj, new RegExp(DUREE_DE_LA_MISE_A_JOUR));
  assert.match(maj, /mise à jour de vos données/);
  assert.doesNotMatch(maj, /deux minutes/);
  const tard = progressionDuChemin({ chemin: CH.plusTard, secondes: 3, phase: "telechargement" });
  assert.match(tard, new RegExp(DUREE_DE_PLUS_TARD));
  assert.match(tard, /téléchargement/);
  assert.equal(progressionDuChemin({ chemin: CH.ordinaire, secondes: 1, phase: null }), null);
  assert.equal(texteDeLaPhase("inconnue"), "");
  assert.equal(texteDeLaPhase("__proto__"), "");
  // Le bloc, la ligne d'attente et la « Durée » de l'écran disent la MÊME durée.
  assert.match(
    MESSAGES.miseAJourProposee("1.0.0", "1.1.0", true),
    new RegExp(DUREE_DE_LA_MISE_A_JOUR),
  );
  assert.match(MESSAGES.miseAJourEnCours, new RegExp(DUREE_DE_LA_MISE_A_JOUR));
  assert.match(MESSAGES.miseAJourPlusTard, new RegExp(DUREE_DE_PLUS_TARD));
  assert.equal(attenteDuDephasage(proposee()), ATTENTE_DE_LA_MISE_A_JOUR);
  assert.equal(attenteDuDephasage({ issue: "ouvrir" }), null);
  assert.match(ATTENTE_DE_LA_MISE_A_JOUR, /retéléchargé/);
});

test("Q3 : la version est toujours dite, et la réussite de la mise à jour aussi", () => {
  assert.equal(versionAffichee({}), "");
  assert.equal(
    versionAffichee({
      dephasage: { issue: "installer", coffre: null, servie: { version: "1.1.0" } },
    }),
    MESSAGES.versionDeLApplication("1.1.0"),
  );
  assert.equal(versionAffichee({ dephasage: proposee() }), MESSAGES.versionDeLApplication("1.0.0"));
  const apres = {
    dephasage: proposee(),
    application: {
      demarree: true,
      miseAJour: { geste: true, versionDuCoffre: "1.0.0", versionServie: "1.1.0" },
    },
  };
  assert.equal(versionAffichee(apres), MESSAGES.versionDeLApplication("1.1.0"));
  assert.equal(texteDeDemarrage(apres), MESSAGES.miseAJourFaite("1.1.0"));
  const plusTard = {
    application: {
      demarree: true,
      miseAJour: { geste: false, versionDuCoffre: "1.0.0", versionServie: "1.1.0" },
    },
  };
  assert.equal(versionAffichee(plusTard), MESSAGES.versionDeLApplication("1.0.0"));
  assert.equal(texteDeDemarrage(plusTard), MESSAGES.applicationDemarree);
});

test("Q7 : un refus qui tient retire « Démarrer », change l'attendu, et la sauvegarde ne ment pas", () => {
  const refus = { dephasage: { issue: "refus", code: C.applicationAnterieure } };
  assert.equal(refusQuiTient(refus), C.applicationAnterieure);
  assert.equal(refusQuiTient({ dephasage: proposee() }), null);
  assert.equal(demarrerEstPossible(refus), false);
  assert.equal(attenduSousLeDephasage(refus), MESSAGES.attenduSousUnRefus);
  assert.doesNotMatch(MESSAGES.attenduSousUnRefus, /Démarrer l'application/);
  assert.doesNotMatch(texteDeSauvegardePrete(false), /redémarrer/);
  assert.match(texteDeSauvegardePrete(true), /redémarrer/);
});

test("Q2 : la phase suit la série du guest — données pendant db:migrate, démarrage après", () => {
  assert.equal(
    phaseDeLaLigne("[schema] rails : == 20260919000001 AjouterUneNote: migrating"),
    PHASES_DU_BOOT.donnees,
  );
  assert.equal(
    phaseDeLaLigne("[schema] migration jouee de=1 vers=2 ms=3"),
    PHASES_DU_BOOT.demarrage,
  );
  assert.equal(phaseDeLaLigne("[schema] volume=1 paquet=2 attendu=1 intention=absent"), null);
  poserLaPhase(PHASES_DU_BOOT.demarrage);
  const veilleur = creerVeilleurDeSchema();
  veilleur.ingererSerie("[schema] rails : == 20260919000001 AjouterUneNote: migrating\n");
  assert.equal(phaseDuBoot(), PHASES_DU_BOOT.donnees);
  veilleur.ingererSerie("[schema] migration jouee de=1 vers=2 ms=3\n");
  assert.equal(phaseDuBoot(), PHASES_DU_BOOT.demarrage);
  poserLaPhase("n'importe quoi");
  assert.equal(phaseDuBoot(), null);
});
