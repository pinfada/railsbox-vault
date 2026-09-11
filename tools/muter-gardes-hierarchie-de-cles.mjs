#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes de la HIÉRARCHIE DE CLÉS et du format v4 (#182, ADR 0033, 0035).
//
//     node tools/muter-gardes-hierarchie-de-cles.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs` : recopie du dépôt dans un atelier
// temporaire, `NODE_TEST_CONTEXT` retiré de l'enfant, `node --check` sur chaque fichier muté,
// épreuve jouée SANS mutation d'abord, arrêt sans verdict compté NON CONCLUANT. Ce fichier ne tient
// que sa TABLE.
//
// ## Ce que la campagne mesure ici, et pourquoi ces gardes-là
//
// La revue externe du 10 septembre 2026 n'a pas trouvé un bogue : elle a trouvé une PROMESSE que
// rien ne tenait. Le § 4.5 affirmait compter « toutes les invocations sous une clé », et comptait
// par instance de scellement. Une tranche qui corrige cela en écrit une autre — « chaque domaine a
// sa clé », « une session qui ne peut pas publier ses compteurs ne scelle pas » —, et rien ne dit
// qu'elle sera mieux tenue que la première. C'est ce que cette campagne mesure :
//
//  - **l'INJECTIVITÉ de l'info HKDF.** Le préfixe de longueur de chaque champ est ce qui rend
//    l'encodage injectif ; sans lui, deux identités de clé distinctes collisionnent. C'est le
//    patron de #18 sur l'identité d'un bloc, appliqué à l'identité d'une CLÉ ;
//  - **chaque CHAMP de l'info**, retiré un à un. Un champ qui disparaîtrait sans qu'aucune épreuve
//    ne rougisse serait un champ décoratif — et l'ADR 0033 en fait dépendre une propriété par champ ;
//  - **le RÉGIME de sel**, qui décide de la fraîcheur d'une clé. Un domaine à compteur dont le sel
//    serait tiré rendrait l'artefact illisible ; un domaine à usage unique dont le sel serait vide
//    rendrait la même clé pour tous ses artefacts ;
//  - **la SÉPARATION des deux compteurs**, sans laquelle les deux budgets redeviennent un seul ;
//  - **la RÈGLE DE CLÔTURE** : une session qui ne peut pas écrire de racine ne scelle pas, et les
//    compteurs d'une racine écartée sont REPORTÉS. Les deux moitiés, parce que la seconde a été
//    trouvée en écrivant l'épreuve de la première ;
//  - **l'ÉCRITURE ANTICIPÉE de la migration**, et le fail-closed qui la borne. Sans le premier, une
//    coupure entre les sceaux et les charges coûte jusqu'à 512 secteurs ; sans le second, un
//    secteur déchiré est rescellé au hasard ;
//  - **le palier déjà franchi**, qui n'est pas une garde de format mais de CHAÎNE : sans lui, une
//    reprise refait le pas v2 → v3 sur un volume déjà converti.
//
// ## Ce que la campagne ne peut PAS mesurer
//
// Que WebCrypto refuse réellement de chiffrer sous un matériau HKDF : cela ne se retire pas d'une
// ligne, c'est la plate-forme. `tests/unit/vm-hierarchie-de-cles.test.mjs` l'exécute, et
// `tests/browser/` le rejoue sur les trois moteurs.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const DOMAINE = "src/vm/derivation/cle-de-domaine.mjs";
const HIERARCHIE = "src/vm/derivation/hierarchie-de-volume.mjs";
const SCELLEMENT = "src/vm/scellement.mjs";
const IDENTITE = "src/vm/format-chiffre/identite-logique.mjs";
const FORMAT_JOURNAL = "src/vm/generation-format.mjs";
const MIGRATION_V4 = "src/vm/migration-v4.mjs";
const CHAINE = "src/vm/volume-migration.mjs";
const OUVREUR = "src/vm/opfs-volume-ouverture.mjs";
const RACINE = "src/vm/opfs-racine-initiale.mjs";

const HIERARCHIE_EPREUVE = "tests/unit/vm-hierarchie-de-cles.test.mjs";
const CLOTURE = "tests/unit/vm-cloture-par-racine.test.mjs";
const MIGRATION_EPREUVE = "tests/unit/vm-migration-v4.test.mjs";
const CHAINE_EPREUVE = "tests/unit/vm-volume-migration.test.mjs";
const FORMAT_EPREUVE = "tests/unit/vm-generation-format.test.mjs";
const INJECTIVITE = "tests/unit/vm-derivation-injectivite.test.mjs";
const VECTEURS_V4 = "tests/unit/vm-volume-v4-vecteurs.test.mjs";

/**
 * Les gardes de #182, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire que
 * la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter une au
 * hasard.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "l'info HKDF PRÉFIXE chaque champ de sa longueur",
    garde: "encoderInfoDeDomaine — les préfixes de longueur",
    fichier: DOMAINE,
    avant:
      "  return concatenerListe([\n" +
      "    chainePrefixee(ETIQUETTE_SCHEMA_DE_DOMAINE),\n" +
      "    chainePrefixee(domaine),\n" +
      "    chainePrefixee(identifiantVolume),\n" +
      "    entierEnOctets(versionDeFormat, 4),\n" +
      "    chainePrefixee(ALGORITHME),\n" +
      "  ]);",
    apres:
      "  const texte = new TextEncoder();\n" +
      "  return concatenerListe([\n" +
      "    texte.encode(ETIQUETTE_SCHEMA_DE_DOMAINE),\n" +
      "    texte.encode(domaine),\n" +
      "    texte.encode(identifiantVolume),\n" +
      "    entierEnOctets(versionDeFormat, 4),\n" +
      "    texte.encode(ALGORITHME),\n" +
      "  ]);",
    epreuves: [INJECTIVITE, VECTEURS_V4],
  },
  {
    nom: "l'info porte le DOMAINE, sans quoi deux domaines partagent leur clé",
    garde: "encoderInfoDeDomaine — le champ `domaine`",
    fichier: DOMAINE,
    avant: "    chainePrefixee(domaine),\n    chainePrefixee(identifiantVolume),",
    apres: "    chainePrefixee(identifiantVolume),",
    epreuves: [HIERARCHIE_EPREUVE, INJECTIVITE],
  },
  {
    nom: "l'info porte l'IDENTIFIANT DE VOLUME, sans quoi deux volumes partagent leur clé",
    garde: "encoderInfoDeDomaine — le champ `identifiantVolume`",
    fichier: DOMAINE,
    avant: "    chainePrefixee(identifiantVolume),\n    entierEnOctets(versionDeFormat, 4),",
    apres: "    entierEnOctets(versionDeFormat, 4),",
    epreuves: [HIERARCHIE_EPREUVE, INJECTIVITE],
  },
  {
    nom: "l'info porte la VERSION DE FORMAT, sans quoi une clé traverse une migration",
    garde: "encoderInfoDeDomaine — le champ `versionDeFormatDuDomaine`",
    fichier: DOMAINE,
    avant: "    entierEnOctets(versionDeFormat, 4),\n    chainePrefixee(ALGORITHME),",
    apres: "    chainePrefixee(ALGORITHME),",
    epreuves: [MIGRATION_EPREUVE, INJECTIVITE],
  },
  {
    nom: "le RÉGIME de sel du domaine est vérifié avant toute dérivation",
    garde: "deriverCleDeDomaine — la largeur de sel admise par le régime",
    fichier: DOMAINE,
    avant: "  if (!(sel instanceof Uint8Array) || sel.byteLength !== largeur) {",
    apres: "  if (false) {",
    epreuves: [HIERARCHIE_EPREUVE],
  },
  {
    nom: "un domaine à COMPTEUR a le sel VIDE, un domaine à usage unique un sel TIRÉ",
    garde: "selDuDomaine — le choix du régime",
    fichier: DOMAINE,
    avant:
      "  return REGIMES_DE_DOMAINE[exigerDomaine(domaine)] === REGIMES.compteur\n" +
      "    ? SEL_VIDE\n" +
      "    : tirerSelDeDomaine();",
    apres: "  exigerDomaine(domaine);\n  return tirerSelDeDomaine();",
    epreuves: [HIERARCHIE_EPREUVE],
  },
  {
    nom: "la clé maîtresse est importée en MATÉRIAU HKDF, jamais en clé AES",
    garde: "importerMateriauMaitre — l'algorithme et les usages",
    fichier: DOMAINE,
    avant: '  return crypto.subtle.importKey("raw", cleMaitresse, "HKDF", false, ["deriveKey"]);',
    apres:
      '  return crypto.subtle.importKey("raw", cleMaitresse, { name: "AES-GCM" }, false, [\n' +
      '    "encrypt",\n' +
      '    "decrypt",\n' +
      "  ]);",
    epreuves: [HIERARCHIE_EPREUVE],
  },
  {
    nom: "le JOURNAL a sa propre clé : elle ne retombe pas sur celle du volume",
    garde: "hierarchieDeVolume — la dérivation du domaine `journal`",
    fichier: HIERARCHIE,
    avant:
      "    cleDeDomaineDuVolume({\n" +
      "      materiau,\n" +
      "      domaine: DOMAINES.journal,\n" +
      "      identifiantVolume,\n" +
      "      versionDeFormat: formatVersion,\n" +
      "    }),",
    apres:
      "    cleDeDomaineDuVolume({\n" +
      "      materiau,\n" +
      "      domaine: DOMAINES.volume,\n" +
      "      identifiantVolume,\n" +
      "      versionDeFormat: formatVersion,\n" +
      "    }),",
    epreuves: [HIERARCHIE_EPREUVE],
  },
  {
    nom: "les DEUX compteurs sont distincts : le journal ne consomme pas le budget du volume",
    garde: "Scellement.ouvrir — le second budget",
    fichier: SCELLEMENT,
    avant:
      "    const budgetJournal = new Budget();\n    budgetJournal.reprendre(scellementsCumulesJournal);",
    apres: "    const budgetJournal = budgetVolume;",
    epreuves: [HIERARCHIE_EPREUVE],
  },
  {
    nom: "une session en LECTURE SEULE ne scelle rien",
    garde: "Scellement#exigerLeDroitDeSceller — le refus",
    fichier: SCELLEMENT,
    avant: "    if (this.#peutSceller) return;",
    apres: "    if (true) return;",
    epreuves: [CLOTURE],
  },
  {
    nom: "une ouverture hors transaction sans naissance PERD le droit de sceller",
    garde: "etablirLaGeneration — l'appel à `interdireDeSceller`",
    fichier: OUVREUR,
    avant: "  scellement.interdireDeSceller();\n",
    apres: "",
    epreuves: [CLOTURE],
  },
  {
    nom: "les compteurs de la racine ÉCARTÉE sont REPORTÉS sur celle qui la remplace",
    garde: "ecarterLeJournalDeCreation — le report des compteurs",
    fichier: RACINE,
    avant: "    compteurs = compteursDeLaRacineEcartee(constat.racine);",
    apres: "    compteurs = null;",
    epreuves: [CLOTURE],
  },
  {
    nom: "la racine v4 publie le SECOND compteur dans ses données associées",
    garde: "encoderEnteteRacine — le onzième champ",
    fichier: IDENTITE,
    avant: "    champs.push(entierEnOctets(scellementsCumulesJournal, 8));",
    apres: "    entierEnOctets(scellementsCumulesJournal, 8);",
    epreuves: [VECTEURS_V4],
  },
  {
    nom: "le BUDGET du journal est vérifié quand la racine le publie",
    garde: "verifierObligationsDeRacine — le second `verifierBudgetDeCle`",
    fichier: "src/vm/format-chiffre/modele-reference.mjs",
    avant:
      "  if (racinePorteDeuxCompteurs(racine?.formatVersion)) {\n" +
      "    verifierBudgetDeCle(\n" +
      '      exigerAttente("scellementsCumulesJournal", racine?.scellementsCumulesJournal),\n' +
      "    );\n" +
      "  }",
    apres: "",
    epreuves: [HIERARCHIE_EPREUVE],
  },
  {
    nom: "une racine de format 4 dont la place du second compteur n'est pas nulle est refusée",
    garde: "incoherenceDuFormat — le miroir de la garde de #19",
    fichier: FORMAT_JOURNAL,
    avant: "  if (!racinePorteDeuxCompteurs(format) && !placeDuSecondCompteurVierge(octets)) {",
    apres: "  if (false) {",
    epreuves: [FORMAT_EPREUVE],
  },
  {
    nom: "un volume v4 EXIGE le second compteur de la racine qu'il relit",
    garde: "Scellement#compteurDeJournalDeLaRacine — le refus d'une racine à un compteur",
    fichier: SCELLEMENT,
    avant: '    if (typeof compteur === "number") return { scellementsCumulesJournal: compteur };',
    apres: "    return { scellementsCumulesJournal: compteur ?? 0 };",
    epreuves: [FORMAT_EPREUVE],
  },
  {
    nom: "la migration JOURNALISE les sceaux v3 avant d'écrire le premier octet",
    garde: "rescellerUneSuite — l'écriture anticipée",
    fichier: MIGRATION_V4,
    avant:
      "  await marquerEtape({\n" +
      "    etape: ETAPES_V4.rescellement,\n" +
      "    position: rang,\n" +
      "    tampon: encoderTampon({ rang, secteurs, sceaux: sceauxV3 }),\n" +
      "  });",
    apres:
      "  await marquerEtape({\n" +
      "    etape: ETAPES_V4.rescellement,\n" +
      "    position: rang,\n" +
      "    tampon: null,\n" +
      "  });",
    epreuves: [MIGRATION_EPREUVE],
  },
  {
    nom: "la reprise relit les sceaux v3 du JOURNAL, et non de la région déjà écrasée",
    garde: "sceauxV3DeLaSuite — la priorité du tampon",
    fichier: MIGRATION_V4,
    avant: "  if (tampon !== null) return tampon.sceaux;",
    apres: "  if (false) return tampon.sceaux;",
    epreuves: [MIGRATION_EPREUVE],
  },
  {
    nom: "un secteur DÉCHIRÉ fait REFUSER, jamais rescéller au hasard",
    garde: "octetsV4DuSecteur — le fail-closed",
    fichier: MIGRATION_V4,
    avant: "  if (etat === null) throw secteurIndechiffrable(adresse);",
    apres: "  if (etat === null) return { dejaConverti: true, charge: null, sceau: null };",
    epreuves: [MIGRATION_EPREUVE],
  },
  {
    nom: "la migration RECOUPE l'identifiant du manifeste avec celui de l'en-tête",
    garde: "convertirEnV4 — l'appel à `recouperLIdentifiant`",
    fichier: MIGRATION_V4,
    avant:
      "  recouperLIdentifiant({ octets: await brut.read(0, EN_TETE_OCTETS), identifiantVolume });",
    apres: "",
    epreuves: [MIGRATION_EPREUVE],
  },
  {
    nom: "un palier de format DÉJÀ FRANCHI ne se refait pas",
    garde: "appliquerLaChaine — le discriminant `dejaFranchi`",
    fichier: CHAINE,
    avant: "      dejaFranchi: avancement !== null && etape.to <= avancement.from,",
    apres: "      dejaFranchi: false,",
    epreuves: [CHAINE_EPREUVE],
  },
]);

function principal() {
  const { resultats } = campagneDeMutation({
    mutations: MUTATIONS,
    etiquette: "hierarchie-de-cles",
  });
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
