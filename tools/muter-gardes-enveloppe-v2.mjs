#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes de la PAGE D'ENVELOPPE v2 et de la CLÔTURE PAR RACINE (#182, T2b).
//
//     node tools/muter-gardes-enveloppe-v2.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs` : recopie du dépôt dans un atelier
// temporaire, `node --check` sur chaque fichier muté, épreuve jouée SANS mutation d'abord, arrêt
// sans verdict compté NON CONCLUANT. Ce fichier ne tient que sa TABLE.
//
// ## Ce que la campagne mesure ici, et pourquoi ces gardes-là
//
// La tranche T2b touche la SERRURE d'un volume, et sa Definition of Ready le dit sans détour :
// « perdre une enveloppe, c'est perdre le volume ». Les gardes qui l'entourent ne valent donc que si
// leur retrait fait rougir quelque chose. Cinq familles :
//
//  - **le SEL tiré**, qui porte l'unicité de la clé de racine. Un sel constant rendrait la clé
//    constante, c'est-à-dire ramènerait le régime que la décision 4 de l'ADR 0033 refuse — et aucun
//    compteur ne le dirait, puisque ce domaine n'en a pas ;
//  - **la MIGRATION de page**, geste par geste : son nombre d'écritures, la page v1 qu'elle
//    CONSERVE, la version qu'elle avance, et le fait qu'elle ne s'applique qu'à une page v1 ;
//  - **le refus de RÉTROGRADATION**, sans lequel une page v1 forgée à une version haute ramènerait
//    l'ouverture sous une racine scellée directement sous la DEK ;
//  - **la CLÔTURE PAR RACINE** du troisième chemin hors transaction, et les deux gestes dont elle
//    dépend : tenir le magasin, et lui déclarer que la région a changé ;
//  - **l'EXPORT d'un v3**, qui ouvre le seul lecteur de v3 du produit : il doit refuser un fichier
//    dont l'en-tête n'est pas celui qu'on lui annonce, AVANT de solder quoi que ce soit.
//
// ## Le CLIQUET est muté lui aussi, et il est le seul « source » qui soit une épreuve
//
// Le cliquet anti-DEK est une inspection de source : sa garde EST son balayage. Le muter revient
// donc à muter `tests/unit/vm-cliquet-anti-dek.test.mjs`, et l'épreuve qui doit rougir est la
// sienne — « le cliquet MORD ». C'est exactement ce qu'une garde décorative ne survivrait pas : un
// balayage qui ne relève rien passerait la CI sans un mot si personne ne le confrontait à ce qu'il
// doit refuser.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const ENVELOPPE = "src/vm/enveloppe-de-cle.mjs";
const ETAT = "src/vm/enveloppe/etat-de-lenveloppe.mjs";
const FICHIER = "src/vm/enveloppe/fichier-enveloppe.mjs";
const MAGASIN = "src/vm/generation-store.mjs";
const BACKEND = "src/vm/opfs-block-backend.mjs";
const OUVERTURE = "src/vm/opfs-volume-ouverture.mjs";
const EXPORT = "src/vm/export-du-fichier.mjs";
const CLIQUET = "tests/unit/vm-cliquet-anti-dek.test.mjs";

const MIGRATION = "tests/unit/vm-enveloppe-migration-page.test.mjs";
const VECTEURS_V2 = "tests/unit/vm-enveloppe-v2-vecteurs.test.mjs";
const CLOTURE = "tests/unit/vm-cloture-par-racine.test.mjs";
const EXPORT_EPREUVE = "tests/unit/vm-export-du-fichier.test.mjs";
const BUDGET = "tests/unit/vm-budget-par-domaine.test.mjs";

/**
 * Les gardes de T2b, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire que
 * la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter une au
 * hasard.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "le SEL d'une page v2 est TIRÉ, et non constant",
    garde: "ALEAS_REELS — `tirerSel`",
    fichier: ENVELOPPE,
    avant: "  tirerSel: tirerSelDeDomaine,",
    apres: "  tirerSel: () => new Uint8Array(32),",
    epreuves: [MIGRATION, BUDGET],
  },
  {
    nom: "la migration de page CONSERVE la page v1 au lieu de l'effacer",
    garde: "migrerLaPageV1 — deux écritures, et pas quatre",
    fichier: ENVELOPPE,
    avant: "    await publier(support, etat.pageLibre, octets);\n    const relu = await lireEtat(",
    apres:
      "    await publier(support, etat.pageLibre, octets);\n" +
      "    await effacerLaPageLiberee(support, etat.index);\n" +
      "    const relu = await lireEtat(",
    epreuves: [MIGRATION],
  },
  {
    nom: "la migration de page FAIT AVANCER la version, sans quoi deux pages se valent",
    garde: "migrerLaPageV1 — `versionSuivante`",
    fichier: ENVELOPPE,
    avant: `function versionSuivante(etat) {
  return etat.version + 1;
}`,
    apres: `function versionSuivante(etat) {
  return etat.version;
}`,
    epreuves: [MIGRATION],
  },
  {
    nom: "une page DÉJÀ en v2 n'est pas remigrée à chaque ouverture",
    garde: "migrerLaPageV1 — le discriminant de version de page",
    fichier: ENVELOPPE,
    avant: "  if (etat.page.formatVersion !== ENVELOPPE_FORMAT_V1) return null;",
    apres: "  if (false) return null;",
    epreuves: [VECTEURS_V2],
  },
  {
    nom: "une page v1 ne reprend PAS l'autorité au-dessus d'une page v2",
    garde: "pagesDeLaPlusRecente — `refuserLaRetrogradation`",
    fichier: ETAT,
    avant:
      "  return refuserLaRetrogradation(\n" +
      "    lues\n" +
      "      .filter((lue) => lue.valide)\n" +
      "      .sort((a, b) => b.page.version - a.page.version || a.index - b.index),\n" +
      "  );",
    apres:
      "  return lues\n" +
      "    .filter((lue) => lue.valide)\n" +
      "    .sort((a, b) => b.page.version - a.page.version || a.index - b.index);",
    epreuves: [MIGRATION],
  },
  {
    nom: "un octet de DOMAINE que rien ne désigne fait REFUSER la page",
    garde: "relireEnteteDePage — le refus d'un domaine inconnu",
    fichier: FICHIER,
    avant: "  if (domaine !== null && nomDuDomaineDeRacine(domaine) === null) {",
    apres: "  if (false) {",
    epreuves: [VECTEURS_V2],
  },
  {
    nom: "une session hors transaction CLÔT par une racine qui publie ses compteurs",
    garde: "GenerationStore.cloturerParRacine — l'écriture de la racine",
    fichier: MAGASIN,
    avant:
      "    await this.#vider({ sequence: this.#sequence, generation: this.#generation });\n    return true;",
    apres: "    return true;",
    epreuves: [CLOTURE],
  },
  {
    nom: "une écriture DIRECTE déclare au magasin de clôture que la région a changé",
    garde: "#ecrireDansLeVolume — l'appel à `marquerRegionSale`",
    fichier: BACKEND,
    avant: "    this.#clotureHorsTransaction?.marquerRegionSale();\n",
    apres: "",
    epreuves: [CLOTURE],
  },
  {
    nom: "une RÉOUVERTURE hors transaction TIENT son magasin pour clore",
    garde: "etablirLaGeneration — `tenirLaClotureHorsTransaction`",
    fichier: OUVERTURE,
    avant: "  return tenirLaClotureHorsTransaction(backend, generation, clotureParDatation);",
    apres: "  return undefined;",
    epreuves: [CLOTURE],
  },
  {
    nom: "l'export d'un v3 REFUSE un fichier dont l'en-tête n'est pas un en-tête v3",
    garde: "ouvrirUnV3PourExport — le contrôle de l'en-tête avant tout solde",
    fichier: EXPORT,
    avant: "    if (!lu.valide) {",
    apres: "    if (false) {",
    epreuves: [EXPORT_EPREUVE],
  },
  {
    nom: "le CLIQUET anti-DEK relève l'appel de la porte nommée",
    garde: "vm-cliquet-anti-dek — le motif `APPEL_DE_LA_PORTE`",
    fichier: CLIQUET,
    avant: "const APPEL_DE_LA_PORTE = /\\bimporterCleDeVolume\\s*\\(/;",
    apres: "const APPEL_DE_LA_PORTE = /\\bjamaisRien\\s*\\(/;",
    epreuves: [CLIQUET],
  },
  {
    nom: "le CLIQUET anti-DEK relève l'importation DIRECTE d'une clé AES-GCM",
    garde: "vm-cliquet-anti-dek — le motif `importationsAesGcm`",
    fichier: CLIQUET,
    avant: "    if (/AES-GCM|ALGORITHME_WEBCRYPTO/.test(arguments_)) releves.push(arguments_);",
    apres: "    if (false) releves.push(arguments_);",
    epreuves: [CLIQUET],
  },
]);

function principal() {
  const { resultats } = campagneDeMutation({ mutations: MUTATIONS, etiquette: "enveloppe-v2" });
  if (process.argv.includes("--json")) {
    console.log(JSON.stringify({ resultats }, null, 2));
  } else {
    for (const resultat of resultats) {
      console.log(`${resultat.tue ? "TUÉ    " : "SURVIT "} ${resultat.nom} — ${resultat.garde}`);
      if (resultat.raison !== null) console.log(`         ${resultat.raison}`);
    }
    const survivants = resultats.filter((resultat) => !resultat.tue).length;
    console.log(`\n${resultats.length - survivants}/${resultats.length} mutants tués.`);
  }
  process.exit(resultats.some((resultat) => !resultat.tue) ? 1 : 0);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) principal();
