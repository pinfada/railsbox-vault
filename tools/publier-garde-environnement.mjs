#!/usr/bin/env node
// La GARDE de l'environnement GitHub `production` (#45) : refuse l'envoi sans relecteur requis.
//
//   gh api repos/<dépôt>/environments/production | node tools/publier-garde-environnement.mjs
//
// `environment: production` ne protège rien en soi : GitHub CRÉE un environnement absent, sans aucune règle,
// et le job part sans approbation. Le jeton du workflow, avec `contents: read`, peut lire l'environnement
// (mesuré le 26/11/2026, run 45886188409) ; cette garde lit donc ses règles AVANT l'étape qui reçoit les
// secrets, et refuse s'il n'y a aucun relecteur requis. Elle échoue FERMÉE : réponse absente, illisible ou
// d'une autre forme = refus.
//
// Ce qu'elle ne prouve pas : que les secrets soient limités à l'environnement et qu'aucun secret de dépôt
// du même nom n'existe (le jeton du workflow ne lit pas les secrets : `docs/release-policy.md`), ni la forme
// exacte de la réponse pour un environnement protégé réel — elle n'a pas été vue sur un tel environnement.

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

async function lireEntree() {
  const morceaux = [];
  for await (const morceau of process.stdin) morceaux.push(morceau);
  return Buffer.concat(morceaux).toString("utf8");
}

if (process.argv[1]?.endsWith("publier-garde-environnement.mjs")) {
  let environnement = null;
  try {
    environnement = JSON.parse(await lireEntree());
  } catch {
    /* illisible : refus ci-dessous */
  }
  if (relecteursRequis(environnement) < 1) {
    process.stderr.write(
      "Envoi REFUSÉ : l'environnement `production` n'a aucun relecteur requis (ou sa réponse est illisible). " +
        "GitHub crée un environnement absent SANS protection : configurez-le avant tout envoi " +
        "(docs/release-policy.md).\n",
    );
    process.exitCode = 1;
  } else {
    process.stdout.write("Environnement `production` : relecteur requis présent.\n");
  }
}
