#!/usr/bin/env node
// Campagne de mutation des gardes PostgreSQL (#343, ADR 0056) : la configuration durable du guest
// et la lecture de la base que l'application déclare.
//
// Chaque mutant RETIRE ou AFFAIBLIT une garde ; il doit faire rougir au moins une épreuve. Un
// survivant est une garde que rien ne prouve : une configuration `fsync = off` qui passerait la
// construction, ou une application MySQL empaquetée comme si elle était SQLite.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const DURABLE = "tools/build-reference-image/postgresql-durable.mjs";
const EPINGLAGE = "tools/build-reference-image/verify-pinning.mjs";
const BASE = "tools/paquet/base-de-donnees.mjs";

const EPREUVE_DURABLE = "tests/unit/postgresql-durable.test.mjs";
const EPREUVE_BASE = "tests/unit/paquet-base-de-donnees.test.mjs";

export const MUTATIONS = Object.freeze([
  {
    nom: "un réglage de durabilité à « off » est refusé",
    garde: "analyserConfigurationPostgresql — la valeur doit être vraie",
    fichier: DURABLE,
    avant: "    } else if (!VRAI.test(reglage.valeur)) {\n",
    apres: "    } else if (false) {\n",
    epreuves: [EPREUVE_DURABLE],
  },
  {
    nom: "un réglage de durabilité ABSENT est refusé",
    garde: "analyserConfigurationPostgresql — la valeur par défaut ne décide pas",
    fichier: DURABLE,
    avant: "    if (reglage === undefined) {\n      anomalies.push({\n",
    apres: "    if (reglage === undefined) {\n      ({\n",
    epreuves: [EPREUVE_DURABLE],
  },
  {
    nom: "la DERNIÈRE affectation fait foi, pas la première",
    garde: "lireLesReglages — une affectation ultérieure remplace la précédente",
    fichier: DURABLE,
    avant: "    valeurs.set(nom, {",
    apres: "    if (!valeurs.has(nom)) valeurs.set(nom, {",
    epreuves: [EPREUVE_DURABLE],
  },
  {
    nom: "synchronous_commit n'accepte que « on », pas « local »",
    garde: "VRAI — les seules graphies de vrai",
    fichier: DURABLE,
    avant: "const VRAI = /^(on|true|yes|1)$/i;",
    apres: "const VRAI = /^(on|true|yes|1|local|remote_write)$/i;",
    epreuves: [EPREUVE_DURABLE],
  },
  {
    nom: "une inclusion est refusée",
    garde: "analyserConfigurationPostgresql — les directives include",
    fichier: DURABLE,
    avant: "  const anomalies = inclusions.map(({ directive, ligne }) => ({\n",
    apres: "  const anomalies = [].map(({ directive, ligne }) => ({\n",
    epreuves: [EPREUVE_DURABLE],
  },
  {
    nom: "un contrôle d'intégrité désarmé est refusé",
    garde: "analyserConfigurationPostgresql — ignore_checksum_failure et ses voisins",
    fichier: DURABLE,
    avant: "    if (reglage !== undefined && VRAI.test(reglage.valeur)) {\n",
    apres: "    if (false) {\n",
    epreuves: [EPREUVE_DURABLE],
  },
  {
    nom: "un initdb sans sommes de contrôle est refusé",
    garde: "analyserLanceurPostgresql — --data-checksums",
    fichier: DURABLE,
    avant: "  if (!avecSommes) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_DURABLE],
  },
  {
    nom: "une surcharge en ligne de commande qui affaiblit est refusée",
    garde: "analyserLanceurPostgresql — -c fsync=off et voisins",
    fichier: DURABLE,
    avant: '      if (!(nom === "synchronous_commit" ? /^on$/i : VRAI).test(valeur)) {\n',
    apres: "      if (false) {\n",
    epreuves: [EPREUVE_DURABLE],
  },
  {
    nom: "ALTER SYSTEM est refusé dans le lanceur",
    garde: "analyserLanceurPostgresql — ALTER SYSTEM",
    fichier: DURABLE,
    avant: "    if (/ALTER\\s+SYSTEM/i.test(contenu)) {\n",
    apres: "    if (false) {\n",
    epreuves: [EPREUVE_DURABLE],
  },
  {
    nom: "une autre majeure de PostgreSQL que celle de sources.json est refusée",
    garde: "analyserVersionPostgresql — la majeure de chaque paquet installé",
    fichier: DURABLE,
    avant: "    if (majeure !== String(version)) {\n",
    apres: "    if (false) {\n",
    epreuves: [EPREUVE_DURABLE],
  },
  {
    nom: "la garde PostgreSQL est branchée sur la vérification d'épinglage",
    garde: "verifierEpinglage — anomaliesDePostgresql",
    fichier: EPINGLAGE,
    avant: "  anomalies.push(...anomaliesDePostgresql(sources, options));\n",
    apres: "",
    epreuves: [EPREUVE_DURABLE],
  },
  {
    nom: "c'est la PRODUCTION qui décide, pas la première section venue",
    garde: "adaptateursDeProduction — la section production",
    fichier: BASE,
    avant: '  const production = racine.find((noeud) => noeud.cle === "production");\n',
    apres: "  const production = racine.find((noeud) => noeud.enfants.length > 0);\n",
    epreuves: [EPREUVE_BASE],
  },
  {
    nom: "un adaptateur hérité par fusion est lu",
    garde: "adaptateurEffectif — les fusions `<<: *ancre`",
    fichier: BASE,
    avant: "    if (herite !== null) return herite;\n",
    apres: "",
    epreuves: [EPREUVE_BASE],
  },
  {
    nom: "un moteur non pris en charge est refusé",
    garde: "baseDeDonneesDeLApplication — BASES_PRISES_EN_CHARGE",
    fichier: BASE,
    avant: "  if (inconnus.length > 0) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_BASE],
  },
  {
    nom: "un mélange de moteurs est refusé",
    garde: "baseDeDonneesDeLApplication — un moteur par application",
    fichier: BASE,
    avant: "  if (lisibles.length > 1) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_BASE],
  },
  {
    nom: "une production illisible est refusée, pas devinée",
    garde: "baseDeDonneesDeLApplication — base-de-donnees-indeterminee",
    fichier: BASE,
    avant: "  if (lisibles.length === 0 || lisibles.length !== adaptateurs.length) {\n",
    apres: "  if (lisibles.length === 0) {\n",
    epreuves: [EPREUVE_BASE],
  },
]);

function rapporter({ resultats }, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify({ resultats }, null, 2)}\n`);
    return resultats;
  }
  for (const resultat of resultats) {
    const verdict = resultat.tue ? "TUÉ" : resultat.applicable ? "SURVIVANT" : "NON APPLICABLE";
    process.stdout.write(`[${verdict}] ${resultat.nom}\n        garde : ${resultat.garde}\n`);
    if (resultat.raison) process.stdout.write(`        ${resultat.raison}\n`);
  }
  const tues = resultats.filter(({ tue }) => tue).length;
  process.stdout.write(`\n${tues}/${resultats.length} mutants tués.\n`);
  return resultats;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const resultats = rapporter(
    campagneDeMutation({ mutations: MUTATIONS, etiquette: "postgresql" }),
    process.argv.includes("--json"),
  );
  process.exitCode = resultats.every(({ tue }) => tue) ? 0 : 1;
}
