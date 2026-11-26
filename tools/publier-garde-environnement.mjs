#!/usr/bin/env node
// La GARDE de l'environnement GitHub `production` (#45) : refuse l'envoi sans relecteur requis ET sans
// approbation de CE run.
//
//   gh api repos/<dépôt>/environments/production                > environnement.json
//   gh api repos/<dépôt>/actions/runs/<run_id>/approvals        > approbations.json
//   node tools/publier-garde-environnement.mjs environnement.json approbations.json
//
// `environment: production` ne protège rien en soi : GitHub CRÉE un environnement absent, sans aucune règle,
// et le job part sans approbation. Deux contrôles, tous deux nécessaires :
//
//  1. la CONFIGURATION : l'environnement exige au moins un relecteur ;
//  2. l'APPROBATION de CE run : `approvals` contient une approbation `approved` pour `production`. Une règle
//     ajoutée APRÈS le démarrage du job satisfait le premier contrôle sans que ce run ait attendu personne ;
//     seul le second le voit.
//
// Le jeton du workflow, avec `contents: read` seul, lit les deux (mesuré le 26/11/2026, runs 45886188409 et
// la sonde des approbations) : le job n'a aucune permission de plus. Elle échoue FERMÉE : fichier absent,
// illisible ou d'une autre forme = refus, et elle s'exécute AVANT l'étape qui reçoit les secrets.
//
// Ce qu'elle ne prouve pas : que les secrets soient limités à l'environnement et qu'aucun secret de dépôt du
// même nom n'existe (le jeton du workflow ne lit pas les secrets : `docs/release-policy.md`) ; la forme exacte
// des réponses pour un environnement protégé réel et une approbation réelle — elle n'a pas été vue (la sonde
// n'a rendu que `[]`) : la forme lue est celle de la documentation de l'API.

import { readFileSync } from "node:fs";

/** Nombre de relecteurs requis par les règles de protection de l'environnement. */
export function relecteursRequis(environnement) {
  const regles = Array.isArray(environnement?.protection_rules)
    ? environnement.protection_rules
    : [];
  return regles
    .filter((regle) => regle?.type === "required_reviewers")
    .reduce(
      (somme, regle) => somme + (Array.isArray(regle.reviewers) ? regle.reviewers.length : 0),
      0,
    );
}

/** Ce run a-t-il reçu une approbation `approved` pour cet environnement ? */
export function approbationDeCeRun(approbations, nomDEnvironnement) {
  return (
    Array.isArray(approbations) &&
    approbations.some(
      (approbation) =>
        approbation?.state === "approved" &&
        Array.isArray(approbation.environments) &&
        approbation.environments.some(({ name }) => name === nomDEnvironnement),
    )
  );
}

const lireJson = (chemin) => {
  try {
    return JSON.parse(readFileSync(chemin, "utf8"));
  } catch {
    return null; /* absent ou illisible : refus ci-dessous */
  }
};

if (process.argv[1]?.endsWith("publier-garde-environnement.mjs")) {
  const [fichierEnvironnement, fichierApprobations] = process.argv.slice(2);
  const environnement = fichierEnvironnement === undefined ? null : lireJson(fichierEnvironnement);
  const approbations = fichierApprobations === undefined ? null : lireJson(fichierApprobations);
  const refus = [];
  if (relecteursRequis(environnement) < 1) {
    refus.push(
      "l'environnement `production` n'a aucun relecteur requis (ou sa réponse est illisible) : GitHub crée un " +
        "environnement absent SANS protection",
    );
  }
  if (!approbationDeCeRun(approbations, "production")) {
    refus.push(
      "ce run n'a reçu aucune approbation `approved` pour `production` (ou la réponse est illisible) : une règle " +
        "ajoutée après le démarrage ne vaut pas approbation",
    );
  }
  if (refus.length > 0) {
    process.stderr.write(
      `Envoi REFUSÉ : ${refus.join(" ; ")}. Configurez l'environnement avant le lancement (docs/release-policy.md).\n`,
    );
    process.exitCode = 1;
  } else {
    process.stdout.write(
      "Environnement `production` : relecteur requis présent, approbation de ce run reçue.\n",
    );
  }
}
