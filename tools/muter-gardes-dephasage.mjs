#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes du DÉPHASAGE de versions (#236 T2, ADR 0042).
//
//     node tools/muter-gardes-dephasage.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs`, partagé avec les douze campagnes
// précédentes. Ce fichier ne tient que sa TABLE.
//
// ## Pourquoi ces gardes-là
//
// La tranche décide, AVANT le boot, ce qu'un code a le droit de faire de données qui ne sont pas les
// siennes. Chaque garde ci-dessous est la seule chose qui empêche l'un de ces cas :
//
//  - du VIEUX code sur des données récentes (schéma servi inférieur, retour arrière de version,
//    migration interrompue rouverte par le précédent) ;
//  - des données d'une AUTRE application ouvertes par celle-ci ;
//  - une migration jouée sans le geste, ou un manifeste qui affirme un schéma que le guest n'a pas
//    constaté ;
//  - un versement qui n'écrit pas les zéros sur un volume habité (constat 8 de la revue de #237) ;
//  - un artefact compressé qui se décompresse sans borne, ou dont le transfert n'est pas celui
//    annoncé ;
//  - depuis la revue de sécurité de la PR #249 : une reprise par une version égale ou plus ancienne,
//    un paramètre vault.* imposé par la ligne SERVIE, une migration non autorisée par le geste, un
//    schéma que dash ne sait pas comparer.
//
// Les gardes du SCRIPT du guest (marqueur invalide, paramètre en double, migration non autorisée)
// sont tenues par `tests/vm/schema-du-volume.test.mjs`, joué sous le vrai dash : une campagne dont
// l'épreuve exige Docker ne serait pas rejouable partout, et un mutant y survivrait par absence.
//
// ## Ce que la campagne ne peut PAS mesurer
//
// Que le guest compare réellement ses marqueurs et refuse de lancer Rails : cela relève de
// `npm run test:vm:reference` (`tests/vm/migration-coupee.test.mjs`) et des scénarios de bout en bout.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const DEPHASAGE = "src/coquille/dephasage.mjs";
const DESCRIPTEUR = "src/coquille/descripteur-applicatif.mjs";
const MISE_A_JOUR = "src/coquille/mise-a-jour-applicative.mjs";
const FLUX = "src/vm/flux-d-artefact.mjs";
const VERSEMENT = "src/vm/versement-de-disque.mjs";
const MANIFESTE = "src/vm/volume-manifest.mjs";

const EPREUVE_DEPHASAGE = "tests/unit/coquille-dephasage.test.mjs";
const EPREUVE_MISE_A_JOUR = "tests/unit/coquille-mise-a-jour.test.mjs";
const EPREUVE_FLUX = "tests/unit/vm-flux-d-artefact.test.mjs";
const EPREUVE_MANIFESTE = "tests/unit/vm-manifeste-schema.test.mjs";

/**
 * Les gardes du déphasage, et la façon exacte de les retirer. `avant` doit apparaître EXACTEMENT UNE
 * FOIS dans le fichier.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "un coffre d'une AUTRE application est refusé",
    garde: "deciderLeDephasage — la comparaison des identités",
    fichier: DEPHASAGE,
    avant:
      "  if (app.id !== servie.id) return refus(C.applicationEtrangere, { coffre, servie });\n",
    apres: "",
    epreuves: [EPREUVE_DEPHASAGE],
  },
  {
    nom: "une version servie INFÉRIEURE est refusée, même à schéma égal (retour arrière, TUF)",
    garde: "deciderSurLaTable — la précédence SemVer",
    fichier: DEPHASAGE,
    avant: "  if (version < 0 || (version > 0 && schema < 0)) {",
    apres: "  if (version > 0 && schema < 0) {",
    epreuves: [EPREUVE_DEPHASAGE],
  },
  {
    nom: "un schéma servi INFÉRIEUR sous une version supérieure est refusé",
    garde: "deciderSurLaTable — le schéma sous une version supérieure",
    fichier: DEPHASAGE,
    avant: "  if (version < 0 || (version > 0 && schema < 0)) {",
    apres: "  if (version < 0) {",
    epreuves: [EPREUVE_DEPHASAGE],
  },
  {
    nom: "deux paquets de même version et de schémas différents ne sont pas le même paquet",
    garde: "deciderSurLaTable — la divergence à version égale",
    fichier: DEPHASAGE,
    avant: "    if (schema !== 0) return refus(C.schemaDivergent, { coffre: constat, servie });\n",
    apres: "",
    epreuves: [EPREUVE_DEPHASAGE],
  },
  {
    nom: "« Plus tard » n'ouvre que la version EXACTE du coffre",
    garde: "deciderSurLaTable — le précédent doit porter la version du coffre",
    fichier: DEPHASAGE,
    avant: "      servi.version === constat.version &&\n",
    apres: "",
    epreuves: [EPREUVE_DEPHASAGE],
  },
  {
    nom: "une migration INTERROMPUE ne laisse que la reprise",
    garde: "deciderLeDephasage — l'intention au manifeste",
    fichier: DEPHASAGE,
    avant: "  if (app.migration !== undefined) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE_DEPHASAGE],
  },
  {
    nom: "la reprise exige une version STRICTEMENT plus récente que celle du coffre (revue de #249, 1)",
    garde: "deciderLaReprise — la précédence de la version servie",
    fichier: DEPHASAGE,
    avant: "  if (!plusRecente || comparerSchemas(servie.schema, cible.schema) < 0) {",
    apres: "  if (comparerSchemas(servie.schema, cible.schema) < 0) {",
    epreuves: [EPREUVE_DEPHASAGE],
  },
  {
    nom: "la reprise exige un schéma servi au moins égal à celui de la cible",
    garde: "deciderLaReprise — le schéma de la cible",
    fichier: DEPHASAGE,
    avant: "  if (!plusRecente || comparerSchemas(servie.schema, cible.schema) < 0) {",
    apres: "  if (!plusRecente) {",
    epreuves: [EPREUVE_DEPHASAGE],
  },
  {
    nom: "la ligne de commande SERVIE ne porte aucun paramètre vault.* (revue de #249, 2)",
    garde: "formeDeLaLigneDeCommande — l'espace réservé au Worker",
    fichier: DESCRIPTEUR,
    avant: '  if (parametres.some((parametre) => parametre.startsWith("vault."))) {',
    apres: "  if (false) {",
    epreuves: [EPREUVE_DEPHASAGE],
  },
  {
    nom: "le guest n'est autorisé à migrer que sous le geste (revue de #249, 4)",
    garde: "ligneDeCommande — vault.migrer=1 posé sous le seul geste",
    fichier: MISE_A_JOUR,
    avant: "  if (migrer === true) parties.push(PARAMETRE_DE_MIGRATION);",
    apres: "  parties.push(PARAMETRE_DE_MIGRATION);",
    epreuves: [EPREUVE_MISE_A_JOUR],
  },
  {
    nom: "l'intention d'un coffre de T1 inscrit le schéma déduit (revue de #249, 5)",
    garde: "inscrireLIntention — le schéma déduit gardé écrit",
    fichier: MISE_A_JOUR,
    avant: "prepare.schemaDeduit ?? null",
    apres: "null",
    epreuves: [EPREUVE_MISE_A_JOUR],
  },
  {
    nom: "un schéma de plus de quatorze chiffres, ou à zéro de tête, est malformé (revue de #249, 3)",
    garde: "SCHEMA_APPLICATIF — la forme que le guest sait comparer",
    fichier: MANIFESTE,
    avant: "export const SCHEMA_APPLICATIF = /^(0|[1-9][0-9]{0,13})$/;",
    apres: "export const SCHEMA_APPLICATIF = /^[0-9]{1,32}$/;",
    epreuves: [EPREUVE_MANIFESTE],
  },
  {
    nom: "le paquet précédent ne peut être ni la même version ni plus récent que le courant",
    garde: "formeDuPrecedent — la précédence du précédent",
    fichier: DESCRIPTEUR,
    avant:
      "  if (comparerVersions(precedent.application.version, descripteur.application.version) >= 0) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE_DEPHASAGE],
  },
  {
    nom: "l'intention n'est inscrite que sous le geste qui migre",
    garde: "inscrireLIntention — le geste et le manifeste exigés",
    fichier: MISE_A_JOUR,
    avant: "  if (prepare.migration !== true || prepare.manifeste === null) return false;",
    apres: "  if (prepare.manifeste === null) return false;",
    epreuves: [EPREUVE_MISE_A_JOUR],
  },
  {
    nom: "le manifeste ne suit que le schéma du paquet booté",
    garde: "suivreLeConstat — le schéma constaté confronté à celui du paquet",
    fichier: MISE_A_JOUR,
    avant: "  if (schema !== application.schema) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE_MISE_A_JOUR],
  },
  {
    nom: "sauter les zéros exige un volume NEUF (constat 8 de la revue de #237)",
    garde: "exigerUnVolumeNeuf — le témoin de naissance du backend",
    fichier: VERSEMENT,
    avant: "  if (sauterLesBlocsNuls && backend.naissance !== true) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE_FLUX],
  },
  {
    nom: "une bombe de décompression est arrêtée à la taille de l'image",
    garde: "lireLeFlux — la borne des octets décompressés",
    fichier: VERSEMENT,
    avant: "    if (offset + value.byteLength > octetsMax) {",
    apres: "    if (false) {",
    epreuves: [EPREUVE_FLUX],
  },
  {
    nom: "un transfert qui n'a pas la taille annoncée est refusé",
    garde: "ouvrirLeFluxDArtefact — la taille compressée exigée à l'octet",
    fichier: FLUX,
    avant: "      if (compte.vu() !== plafond) {",
    apres: "      if (false) {",
    epreuves: [EPREUVE_FLUX],
  },
  {
    nom: "sans DecompressionStream, un artefact compressé est un refus typé",
    garde: "ouvrirLeFluxDArtefact — la capacité exigée avant le réseau",
    fichier: FLUX,
    avant: '  if (compression !== null && typeof portee.DecompressionStream !== "function") {',
    apres: "  if (false) {",
    epreuves: [EPREUVE_FLUX],
  },
  {
    nom: "un schéma de manifeste qui n'est pas un entier est un manifeste malformé",
    garde: "schemaExige — la forme de `schema` et de `migration.schema`",
    fichier: MANIFESTE,
    avant: '  if (typeof valeur !== "string" || !SCHEMA_APPLICATIF.test(valeur)) {',
    apres: "    if (false) {",
    epreuves: [EPREUVE_MANIFESTE],
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
    campagneDeMutation({ mutations: MUTATIONS, etiquette: "dephasage" }),
    process.argv.includes("--json"),
  );
  process.exitCode = resultats.every(({ tue }) => tue) ? 0 : 1;
}
