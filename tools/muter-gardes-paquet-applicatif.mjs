#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes du paquet applicatif (#236, ADR 0041).
//
//     node tools/muter-gardes-paquet-applicatif.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs`, partagé avec les onze campagnes
// précédentes : recopie du dépôt dans un atelier temporaire, épreuve jouée SANS mutation d'abord,
// `node --check` sur le fichier muté, arrêt sans verdict compté NON CONCLUANT. Ce fichier ne tient
// que sa TABLE.
//
// ## Pourquoi ces gardes-là
//
// La tranche déplace le CODE de l'application hors du volume de données, et fait de l'empreinte la
// seule chose qui dise qu'un octet vient bien de l'origine. Trois refus portent donc tout le poids :
//
//  - la TABLE DE PARTITIONS, qui doit refuser un disque qu'elle ne peut pas décrire, et poser sa
//    signature — un noyau qui ne la trouve pas ne monte rien ;
//  - l'EMPREINTE DE CHAQUE MORCEAU du disque système, confrontée avant le premier battement ;
//  - l'EMPREINTE DE LA GRAINE, confrontée pendant le versement, avant la barrière et la datation.
//
// ## Ce que la campagne ne peut PAS mesurer
//
// Que le guest monte réellement `/dev/sda2` et `/dev/sdb`, que Rails y lise sa base, que le noyau
// accepte la table : cela relève de `npm run test:vm:reference` (boot à froid réel) et des scénarios
// de bout en bout. La campagne dit que les refus savent rougir ; le boot dit qu'ils portent sur
// quelque chose.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const COMPOSE = "src/vm/disque-compose.mjs";
const ACQUISITION = "src/vm/acquisition-du-disque-systeme.mjs";
const VERSEMENT = "src/vm/versement-de-disque.mjs";
const CONTRAT = "tools/paquet/contrat-du-paquet.mjs";

const EPREUVE_COMPOSE = "tests/unit/vm-disque-compose.test.mjs";
const EPREUVE_ACQUISITION = "tests/unit/vm-acquisition-disque-systeme.test.mjs";
const EPREUVE_VERSEMENT = "tests/unit/vm-versement-graine.test.mjs";
const EPREUVE_CONTRAT = "tests/unit/paquet-contrat.test.mjs";

/**
 * Les gardes de #236, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire que
 * la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter une au
 * hasard.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "un disque que la table MBR ne peut pas décrire est refusé",
    garde: "composerDisqueSysteme — la borne des 32 bits de secteurs",
    fichier: COMPOSE,
    avant:
      "  if (octets / SECTEUR_OCTETS > SECTEURS_MAX) {\n" +
      "    throw new Error(\n" +
      "      `Disque système refusé : ${octets} octets dépassent ce qu'une table MBR peut décrire (${SECTEURS_MAX} secteurs).`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_COMPOSE],
  },
  {
    nom: "la SIGNATURE 55AA est posée : sans elle, le noyau ne voit aucune partition",
    garde: "ecrireTableDePartitions — les deux derniers octets du secteur d'amorçage",
    fichier: COMPOSE,
    avant: "  vue.setUint8(511, 0xaa);\n",
    apres: "",
    epreuves: [EPREUVE_COMPOSE],
  },
  {
    nom: "le PAQUET commence après le rootfs, jamais dedans",
    garde: "composerDisqueSysteme — l'alignement du décalage de la seconde partition",
    fichier: COMPOSE,
    avant:
      "  const debutDuPaquet = alignerVersLeHaut(rootfs.debut + rootfs.octets, alignementOctets);",
    apres: "  const debutDuPaquet = alignerVersLeHaut(rootfs.debut, alignementOctets);",
    epreuves: [EPREUVE_COMPOSE],
  },
  {
    nom: "un morceau dont l'empreinte ne correspond pas ne devient pas un disque",
    garde: "verserLeMorceau — la comparaison d'empreinte du rootfs et du paquet",
    fichier: ACQUISITION,
    avant:
      "  if (obtenue !== morceau.sha256) {\n" +
      "    throw new Error(\n" +
      "      `Artefact ${nom} refusé : empreinte ${obtenue}, le descripteur déclare ${morceau.sha256}.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ACQUISITION],
  },
  {
    nom: "un morceau tronqué est refusé, et pas complété par des zéros",
    garde: "verserLeMorceau — la comparaison du compte d'octets reçus",
    fichier: ACQUISITION,
    avant:
      "  if (recu !== morceau.octets) {\n" +
      "    throw new Error(\n" +
      "      `Artefact ${nom} refusé : ${recu} octets reçus, le descripteur en annonce ${morceau.octets}.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ACQUISITION],
  },
  {
    nom: "une GRAINE dont l'empreinte ne correspond pas n'est pas scellée dans le coffre",
    garde: "verserFluxDansVolume — la confrontation à `empreinteAttendue`, avant la barrière",
    fichier: VERSEMENT,
    avant:
      "  if (empreinteAttendue !== null && empreinteSource !== empreinteAttendue) {\n" +
      "    throw new Error(\n" +
      "      `Versement refusé : les octets reçus de ${url} ont pour empreinte ${empreinteSource}, ` +\n" +
      "        `l'origine en déclare ${empreinteAttendue}.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_VERSEMENT],
  },
  {
    nom: "les blocs NON NULS sont écrits : le saut ne saute que les zéros",
    garde: "ecrireLaTranche — le test de nullité du bloc",
    fichier: VERSEMENT,
    avant: "    if (estNul(bloc)) continue;\n",
    apres: "    continue;\n",
    epreuves: [EPREUVE_VERSEMENT],
  },
  {
    nom: "un contrat de paquet sans empreinte d'image est refusé",
    garde: "validerImage — le contrôle de la forme du sha256",
    fichier: CONTRAT,
    avant:
      '  if (!EMPREINTE.test(partie.sha256 ?? "")) ajouter(code, `${cle}.sha256 absent ou mal formé`);\n',
    apres: "",
    epreuves: [EPREUVE_CONTRAT],
  },
  {
    nom: "un contrat d'une AUTRE version est refusé, jamais deviné",
    garde: "validerPaquet — le contrôle de `contractVersion`",
    fichier: CONTRAT,
    avant:
      "  if (paquet.contractVersion !== VERSION_CONTRAT_PAQUET) {\n" +
      "    ajouter(\n" +
      '      "contrat-inconnu",\n' +
      "      `contractVersion ${JSON.stringify(paquet.contractVersion)} au lieu de ${VERSION_CONTRAT_PAQUET}`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_CONTRAT],
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
    campagneDeMutation({ mutations: MUTATIONS, etiquette: "paquet-applicatif" }),
    process.argv.includes("--json"),
  );
  process.exitCode = resultats.every(({ tue }) => tue) ? 0 : 1;
}
