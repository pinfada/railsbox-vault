#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes du magasin d'artefacts (#247, ADR 0044).
//
//     node tools/muter-gardes-magasin.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs`, partagé avec les autres campagnes. Ce
// fichier ne tient que sa TABLE.
//
// ## Pourquoi ces gardes-là
//
// Le magasin sert des octets au démarrage À LA PLACE de l'origine. Tout son poids tient dans six
// refus : rien n'est servi avant vérification, rien de partiel n'est servi, la vérification se fait
// contre la racine du DESCRIPTEUR (et non contre la liste rangée), une admission sous budget est
// refusée, la purge garde la rétention, et un magasin lent cède au bout de 20 s.
//
// ## Ce que la campagne ne mesure pas
//
// Le hors-ligne (« seulement si l'origine est injoignable », ADR 0044 § 6) n'est pas encore
// implémenté : sa garde sera ajoutée ici avec lui. Que le magasin serve réellement au démarrage
// relève de `tests/e2e/magasin-d-artefacts.spec.mjs`.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const MAGASIN = "src/vm/magasin-d-artefacts.mjs";
const OPFS = "src/vm/magasin-opfs.mjs";

const EPREUVE_MAGASIN = "tests/unit/vm-magasin-d-artefacts.test.mjs";
const EPREUVE_OPFS = "tests/unit/vm-magasin-opfs.test.mjs";
const EPREUVE_ANNULATION = "tests/unit/vm-magasin-annulation-a-chaque-attente.test.mjs";

/** `avant` doit apparaître EXACTEMENT UNE FOIS dans son fichier. */
export const MUTATIONS = Object.freeze([
  {
    nom: "aucun octet n'est servi avant vérification",
    garde: "servir — le verdict de verserEtVerifier",
    fichier: MAGASIN,
    avant:
      "  if (await verserEtVerifier(contexte, morceau, cible, tranches, jeton)) return true;\n",
    apres: "  await verserEtVerifier(contexte, morceau, cible, tranches, jeton);\n  return true;\n",
    epreuves: [EPREUVE_MAGASIN],
  },
  {
    nom: "aucun partiel n'est servi : une lecture courte refuse",
    garde: "verserEtVerifier — la longueur lue",
    fichier: MAGASIN,
    avant:
      "    if ((await primitives.lire(morceau.sha256, debut, vue)) !== vue.byteLength) return false;\n",
    apres: "    await primitives.lire(morceau.sha256, debut, vue);\n",
    epreuves: [EPREUVE_MAGASIN],
  },
  {
    nom: "la vérification se fait contre la racine du DESCRIPTEUR, pas contre la liste rangée",
    garde: "servir — la racine recalculée confrontée à morceau.racine",
    fichier: MAGASIN,
    avant:
      "    if (tranches === null || (await racineDesTranches(tranches, hacher)) !== morceau.racine) {\n",
    apres: "    if (tranches === null) {\n",
    epreuves: [EPREUVE_MAGASIN],
  },
  {
    nom: "une admission sous budget est refusée",
    garde: "admettre — peutAdmettre consulté avant la première écriture",
    fichier: MAGASIN,
    avant: "  if (!(await peutAdmettre(octets.byteLength))) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_MAGASIN],
  },
  {
    nom: "la purge garde la rétention",
    garde: "purger — les empreintes à garder",
    fichier: MAGASIN,
    avant: "    if (!gardees.has(sha256) && !oubliees.has(sha256)) {\n",
    apres: "    if (!oubliees.has(sha256)) {\n",
    epreuves: [EPREUVE_MAGASIN, EPREUVE_OPFS],
  },
  {
    nom: "un magasin lent cède au bout de 20 s",
    garde: "DELAI_DU_MAGASIN_MS",
    fichier: OPFS,
    avant: "export const DELAI_DU_MAGASIN_MS = 20_000;\n",
    apres: "export const DELAI_DU_MAGASIN_MS = 200_000;\n",
    epreuves: [EPREUVE_OPFS],
  },
  {
    nom: "un magasin lent cède : servir est borné dans le temps",
    garde: "borneDansLeTemps — servir",
    fichier: OPFS,
    avant:
      "    servir: (morceau, cible) =>\n" +
      "      avantLEcheance(\n" +
      "        (jeton) => magasin.servir(morceau, cible, jeton),\n" +
      "        delaiMs,\n" +
      "        () => false,\n" +
      "      ),\n",
    apres: "    servir: (morceau, cible) => magasin.servir(morceau, cible),\n",
    epreuves: [EPREUVE_OPFS],
  },
  // Revue de sécurité du 04/10/2026.
  {
    nom: "une tranche n'est copiée dans la cible qu'après vérification",
    garde: "verserEtVerifier — la copie après le hachage",
    fichier: MAGASIN,
    avant: "    const vue = prive.subarray(0, fin - debut);\n    if ((await primitives.lire(",
    apres: "    const vue = cible.subarray(debut, fin);\n    if ((await primitives.lire(",
    epreuves: [EPREUVE_MAGASIN],
  },
  {
    nom: "le jeton d'annulation est testé avant chaque copie",
    garde: "verserEtVerifier — jeton.annule avant cible.set",
    fichier: MAGASIN,
    avant: "    if (jeton.annule) return false;\n    cible.set(vue, debut);\n",
    apres: "    cible.set(vue, debut);\n",
    epreuves: [EPREUVE_MAGASIN],
  },
  {
    nom: "l'échéance annule le jeton",
    garde: "avantLEcheance — jeton.annule = true",
    fichier: OPFS,
    avant: "      jeton.annule = true;\n",
    apres: "",
    epreuves: [EPREUVE_MAGASIN, EPREUVE_OPFS],
  },
  {
    nom: "la racine est confrontée à l'admission",
    garde: "admettre — racine calculée contre racine du descripteur",
    fichier: MAGASIN,
    avant: "  if (racine !== undefined && calculee !== racine) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_MAGASIN],
  },
  {
    nom: "la rétention est bornée dans le temps",
    garde: "borneDansLeTemps — retenir",
    fichier: OPFS,
    avant:
      "      avantLEcheance(\n" +
      "        (jeton) => magasin.retenir(courants, jeton),\n" +
      "        delaiMs,\n" +
      '        magasinLent("rétention"),\n' +
      "      );\n",
    apres: "      magasin.retenir(courants);\n",
    epreuves: [EPREUVE_OPFS],
  },
  // Revue de #292 (lot D1g) : le jeton testé avant chaque geste visible, et les restes d'un abandon.
  {
    nom: "le jeton est testé avant le renommage définitif",
    garde: "admettre — jeton.annule avant renommer",
    fichier: MAGASIN,
    avant:
      "  if (jeton.annule) {\n    await primitives.supprimer(partiel);\n    return null;\n  }\n  await primitives.renommer(partiel, sha256);\n",
    apres: "  await primitives.renommer(partiel, sha256);\n",
    epreuves: [EPREUVE_MAGASIN],
  },
  {
    nom: "le jeton est testé avant chaque tranche écrite",
    garde: "ecrireLePartiel — jeton.annule au début du tour",
    fichier: MAGASIN,
    avant:
      "    if (jeton.annule) return null;\n    const vue = prive.subarray(0, fin - debut);\n    vue.set(",
    apres: "    const vue = prive.subarray(0, fin - debut);\n    vue.set(",
    epreuves: [EPREUVE_MAGASIN, EPREUVE_ANNULATION],
  },
  {
    nom: "le jeton est testé après la dernière tranche",
    garde: "ecrireLePartiel — jeton.annule à la sortie",
    fichier: MAGASIN,
    avant: "  return jeton.annule ? null : tranches;\n",
    apres: "  return tranches;\n",
    epreuves: [EPREUVE_MAGASIN, EPREUVE_ANNULATION],
  },
  {
    nom: "une admission abandonnée retire son partiel",
    garde: "admettre — le partiel de l'abandon",
    fichier: MAGASIN,
    avant:
      "    // Abandonnée à l'échéance : son partiel n'a plus d'auteur qui le renommera (revue de #292).\n    await primitives.supprimer(partiel);\n",
    apres: "",
    epreuves: [EPREUVE_MAGASIN],
  },
  {
    nom: "la purge s'arrête au jeton annulé",
    garde: "purger — jeton.annule",
    fichier: MAGASIN,
    avant: "    if (jeton.annule) break;\n",
    apres: "",
    epreuves: [EPREUVE_MAGASIN, EPREUVE_ANNULATION],
  },
  {
    nom: "la rétention reçoit le jeton de l'échéance",
    garde: "borneDansLeTemps — retenir(courants, jeton)",
    fichier: OPFS,
    avant: "        (jeton) => magasin.retenir(courants, jeton),\n",
    apres: "        () => magasin.retenir(courants),\n",
    epreuves: [EPREUVE_OPFS],
  },
  {
    nom: "la rétention abandonnée n'efface pas le journal",
    garde: "retenir — jeton testé avant de supprimer le journal",
    fichier: OPFS,
    avant: "  if (jeton.annule) return [];\n  await primitives.supprimer(JOURNAL_DE_RETENTION);\n",
    apres: "  await primitives.supprimer(JOURNAL_DE_RETENTION);\n",
    epreuves: [EPREUVE_OPFS],
  },
  {
    nom: "la rétention abandonnée n'écrit pas le journal",
    garde: "retenir — jeton testé avant d'écrire le journal",
    fichier: OPFS,
    avant: "  if (jeton.annule) return [];\n  await primitives.ecrire(\n",
    apres: "  await primitives.ecrire(\n",
    epreuves: [EPREUVE_OPFS],
  },
  // Revue de #298, constat 4 : le jeton est testé APRÈS CHAQUE ATTENTE, avant tout geste modificateur.
  {
    nom: "oublier teste le jeton avant CHAQUE suppression de l'entrée",
    garde: "oublier — jeton.annule avant chaque supprimer",
    fichier: MAGASIN,
    avant: "    if (jeton.annule) return; // avant chaque suppression de l'entrée\n",
    apres: "",
    epreuves: [EPREUVE_ANNULATION],
  },
  {
    nom: "le rangement du descripteur abandonné d'emblée ne supprime rien",
    garde: "ecrireLeDescripteurScelle — jeton avant la première suppression",
    fichier: MAGASIN,
    avant: "  if (jeton.annule) return false; // avant toute suppression : abandonnée d'emblée\n",
    apres: "",
    epreuves: [EPREUVE_ANNULATION],
  },
  {
    nom: "le jeton est testé de NOUVEAU après la suppression de l'ancien descripteur, avant de renommer",
    garde: "ecrireLeDescripteurScelle — jeton après supprimer(ancien)",
    fichier: MAGASIN,
    avant:
      "  // La suppression de l'ancien a pu durer : le jeton est testé DE NOUVEAU avant de renommer. Un\n  // renommage déjà lancé n'est pas annulable ; celui-ci ne part pas (revue de #298, constat 4).\n  if (jeton.annule) {\n    await primitives.supprimer(partiel);\n    return false;\n  }\n  await primitives.renommer(partiel, NOM_DU_DESCRIPTEUR_SCELLE);\n",
    apres: "  await primitives.renommer(partiel, NOM_DU_DESCRIPTEUR_SCELLE);\n",
    epreuves: [EPREUVE_ANNULATION],
  },
  {
    nom: "une tranche hachée n'est pas écrite si le jeton a été annulé pendant le hachage",
    garde: "ecrireLePartiel — jeton après hacher, avant ecrire",
    fichier: MAGASIN,
    avant:
      "    if (jeton.annule) return null; // après le hachage de la tranche, avant de l'écrire\n",
    apres: "",
    epreuves: [EPREUVE_ANNULATION],
  },
  {
    nom: "une admission annulée pendant le budget n'oublie rien",
    garde: "admettre — jeton après peutAdmettre",
    fichier: MAGASIN,
    avant:
      "  if (jeton.annule) return null; // après le budget, avant d'oublier l'ancienne entrée\n",
    apres: "",
    epreuves: [EPREUVE_ANNULATION],
  },
  {
    nom: "une admission annulée pendant le hachage de la racine n'écrit ni liste ni nom définitif",
    garde: "admettre — jeton après racineDesTranches",
    fichier: MAGASIN,
    avant:
      "  if (jeton.annule) {\n    // Après le hachage de la racine : ni le refus de racine, ni la liste, ni le nom définitif.\n    await primitives.supprimer(partiel);\n    return null;\n  }\n",
    apres: "",
    epreuves: [EPREUVE_ANNULATION],
  },
  {
    nom: "l'oubli du descripteur rangé reçoit le jeton",
    garde: "oublierLeDescripteurScelle — jeton transmis",
    fichier: MAGASIN,
    avant: "{ nomSeul: true, jeton }",
    apres: "{ nomSeul: true }",
    epreuves: [EPREUVE_ANNULATION],
  },
  {
    nom: "servir : l'oubli d'une taille fausse reçoit le jeton",
    garde: "servir — oublier(restes) avec jeton",
    fichier: MAGASIN,
    avant: "    if (restes) await oublier(contexte, morceau.sha256, { jeton });\n",
    apres: "    if (restes) await oublier(contexte, morceau.sha256);\n",
    epreuves: [EPREUVE_ANNULATION],
  },
  {
    nom: "servir : l'oubli d'une racine fausse reçoit le jeton",
    garde: "servir — oublier(racine) avec jeton",
    fichier: MAGASIN,
    avant:
      "      await oublier(contexte, morceau.sha256, { jeton });\n      return false;\n    }\n  }\n",
    apres: "      await oublier(contexte, morceau.sha256);\n      return false;\n    }\n  }\n",
    epreuves: [EPREUVE_ANNULATION],
  },
  {
    nom: "servir : une opération abandonnée n'oublie pas l'entrée qu'elle n'a pas jugée",
    garde: "servir — oublier(verdict) avec jeton",
    fichier: MAGASIN,
    avant: "  await oublier(contexte, morceau.sha256, { jeton });\n  return false;\n}\n",
    apres: "  await oublier(contexte, morceau.sha256);\n  return false;\n}\n",
    epreuves: [EPREUVE_ANNULATION],
  },
  {
    nom: "purger transmet le jeton à chaque oubli (trois suppressions par entrée)",
    garde: "purger — oublier avec jeton",
    fichier: MAGASIN,
    avant: "      await oublier(contexte, sha256, { jeton });\n",
    apres: "      await oublier(contexte, sha256);\n",
    epreuves: [EPREUVE_ANNULATION],
  },
  {
    nom: "l'oubli du descripteur est borné par un jeton d'échéance",
    garde: "borneDansLeTemps — oublierLeDescripteurScelle",
    fichier: OPFS,
    avant: "        (jeton) => magasin.oublierLeDescripteurScelle(jeton),\n",
    apres: "        () => magasin.oublierLeDescripteurScelle(),\n",
    epreuves: [EPREUVE_OPFS],
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
    campagneDeMutation({ mutations: MUTATIONS, etiquette: "magasin" }),
    process.argv.includes("--json"),
  );
  process.exitCode = resultats.every(({ tue }) => tue) ? 0 : 1;
}
