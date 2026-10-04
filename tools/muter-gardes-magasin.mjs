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

/** `avant` doit apparaître EXACTEMENT UNE FOIS dans son fichier. */
export const MUTATIONS = Object.freeze([
  {
    nom: "aucun octet n'est servi avant vérification",
    garde: "servir — le verdict de verserEtVerifier",
    fichier: MAGASIN,
    avant: "  if (await verserEtVerifier(contexte, morceau, cible, tranches)) return true;\n",
    apres: "  await verserEtVerifier(contexte, morceau, cible, tranches);\n  return true;\n",
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
      "      avantLEcheance(magasin.servir(morceau, cible), delaiMs, () => false),\n",
    apres: "    servir: (morceau, cible) => magasin.servir(morceau, cible),\n",
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
