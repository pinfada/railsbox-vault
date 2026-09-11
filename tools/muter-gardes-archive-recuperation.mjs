#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes de l'archive v3, de son ENGAGEMENT, et de l'ancre de version
// (#181, ADR 0033 ; #149, ADR 0027).
//
//     node tools/muter-gardes-archive-recuperation.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs` : recopie du dépôt dans un atelier
// temporaire, `NODE_TEST_CONTEXT` retiré de l'enfant, `node --check` sur chaque fichier muté,
// épreuve jouée SANS mutation d'abord, arrêt sans verdict compté NON CONCLUANT. Ce fichier ne tient
// que sa TABLE.
//
// ## Ce que la campagne mesure ici, et pourquoi ces gardes-là
//
// L'ADR 0027 révise une décision de sécurité : l'archive emporte désormais la capacité d'ouvrir le
// volume. Ce qui la sépare d'un renoncement tient en quelques lignes de code, et une campagne de
// mutation est la seule façon de savoir si ces lignes sont réellement TENUES par une épreuve — ou
// si elles pourraient disparaître sans qu'aucune suite ne rougisse :
//
//  - le FILTRE de la construction et sa RELECTURE à l'import (types 1, 2, 3 refusés). Sans eux,
//    une phrase secrète voyagerait dans l'archive ;
//  - l'empreinte de la section, vérifiée AVANT toute écriture ;
//  - la CONFRONTATION de l'en-tête à la page : un en-tête qui ment sur la version ferait passer
//    une sauvegarde antérieure à la feuille sans consentement ;
//  - l'ORDRE contenu → enveloppe → manifeste, qui interdit un volume déclaré complet que personne
//    n'ouvre ;
//  - la TRANSMISSION de `versionMinimale` par l'ouvreur de production, sans quoi l'ancre resterait
//    ce qu'elle était avant cette tranche : un paramètre que personne ne passe ;
//  - le CONSENTEMENT nommé, et la LECTURE d'une archive v1, qui est la compatibilité promise ;
//  - depuis les revues de la PR #160 : l'IDENTITÉ du volume que la page authentifie confrontée à
//    celle du manifeste, la PRÉSENCE du champ `recovery` dans un en-tête v2, le refus d'une queue
//    au-delà de l'archive, et la garde de forme À L'ÉCRITURE — la moitié qui manquait ;
//  - depuis #181 : ce que l'ENGAGEMENT scelle et sous quelle clé, la confrontation de l'empreinte
//    du fichier à celle qu'il scelle, le refus d'un voisin ABSENT, le refus d'un volume sans racine
//    que rien n'autorise, et la RACINE INITIALE que la création écrit. Ce sont les six lignes qui
//    séparent la correction du CRITICAL d'une déclaration d'intention ;
//  - depuis les revues de la PR #184 : la confrontation de l'empreinte que le VERSEMENT a rendue,
//    l'exigence de la racine de naissance avant de dater, l'ORDRE des trois gestes de
//    `#recupererSansRacine` — deux mutants, parce qu'il y a deux inversions possibles —, la
//    CONSOMMATION du voisin, le TIRAGE du sel de domaine, et la racine initiale de la MIGRATION.
//    Sept propriétés que la PR déclarait non négociables et que rien ne défendait.
//
// ## Ce que la campagne ne peut PAS mesurer
//
// Que la page embarquée s'ouvre réellement sous le code une fois restaurée sur un vrai support :
// c'est le scénario de bout en bout `tests/e2e/archive-recuperation-inter-origine.spec.mjs` qui
// l'établit, et aucune mutation jouée sous Node ne le remplace.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const RECUPERATION = "src/vm/enveloppe-de-recuperation.mjs";
const SECTION = "src/vm/archive-recuperation.mjs";
const EXPORT = "src/vm/volume-export.mjs";
const IMPORT = "src/vm/volume-import.mjs";
const OUVERTURE = "src/vm/ouverture-par-enveloppe.mjs";
const ENGAGEMENT = "src/vm/archive-engagement.mjs";
const DOMAINE = "src/vm/derivation/cle-de-domaine.mjs";
const OUVREUR = "src/vm/opfs-volume-ouverture.mjs";
const RECUPERATION_GENERATION = "src/vm/generation-recuperation.mjs";
const RACINE = "src/vm/opfs-racine-initiale.mjs";
const MAGASIN = "src/vm/generation-store.mjs";
const MIGRATION = "src/vm/volume-migration.mjs";

const ARCHIVE = "tests/unit/vm-archive-recuperation.test.mjs";
const RESTAURATION = "tests/unit/vm-restauration-recuperation.test.mjs";
const ANCRE = "tests/unit/vm-enveloppe-ancre-version.test.mjs";
const VECTEURS = "tests/unit/vm-archive-vecteurs.test.mjs";
const IMPORT_EPREUVE = "tests/unit/vm-volume-import.test.mjs";
const MELANGE = "tests/unit/vm-archive-melange-etats.test.mjs";
const GENERATION = "tests/unit/vm-generation-store.test.mjs";
const COQUILLE = "tests/unit/coquille-application.test.mjs";
const MIGRATION_RACINE = "tests/unit/vm-migration-racine-initiale.test.mjs";

/**
 * Les gardes de #149, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire que
 * la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter une au
 * hasard.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "la construction FILTRE aux seuls emplacements de type 4",
    garde: "construireEnveloppeDeRecuperation — le filtre sur `typeKek`",
    fichier: RECUPERATION,
    avant:
      "  const emplacements = etat.page.emplacements.filter(\n" +
      "    (emplacement) => emplacement.typeKek === TYPE_EMBARQUE,\n" +
      "  );",
    apres: "  const emplacements = etat.page.emplacements;",
    epreuves: [ARCHIVE, VECTEURS],
  },
  {
    nom: "la page embarquée est RELUE, et un type étranger la fait refuser",
    garde: "exigerEnveloppeDeRecuperationSeule — le relevé des emplacements étrangers",
    fichier: RECUPERATION,
    avant:
      "  const etrangers = lue.page.emplacements.filter(\n" +
      "    (emplacement) => emplacement.typeKek !== TYPE_EMBARQUE,\n" +
      "  );",
    apres: "  const etrangers = [];",
    epreuves: [ARCHIVE, RESTAURATION],
  },
  {
    nom: "la page 1 du voisin restauré est à ZÉRO",
    garde: "fichierDEnveloppeDepuisLaPage — l'absence de seconde copie",
    fichier: RECUPERATION,
    avant: "  const fichier = new Uint8Array(PAGE_OCTETS * PAGES);\n  fichier.set(page, 0);",
    apres:
      "  const fichier = new Uint8Array(PAGE_OCTETS * PAGES);\n" +
      "  fichier.set(page, 0);\n" +
      "  fichier.set(page, PAGE_OCTETS);",
    epreuves: [RESTAURATION],
  },
  {
    nom: "l'empreinte de la section est CONFRONTÉE à celle que l'en-tête déclare",
    garde: "lireEtVerifierLaRecuperation — la comparaison des deux empreintes",
    fichier: SECTION,
    avant: "  if (calculee !== descripteur.digest) {",
    apres: "  if (calculee === null) {",
    epreuves: [ARCHIVE, RESTAURATION],
  },
  {
    nom: "les archives v1 et v2 sont REFUSÉES : elles ne portent aucun engagement",
    garde: "ARCHIVE_FORMAT_VERSIONS_LUES — le refus de #181",
    fichier: EXPORT,
    avant: "export const ARCHIVE_FORMAT_VERSIONS_LUES = Object.freeze([3]);",
    apres: "export const ARCHIVE_FORMAT_VERSIONS_LUES = Object.freeze([1, 2, 3]);",
    epreuves: [ARCHIVE],
  },
  {
    nom: "l'en-tête est CONFRONTÉ à la page, jamais cru",
    garde: "accorderLeDescripteurEtLaPage — la comparaison version/emplacements",
    fichier: SECTION,
    avant:
      "  if (descripteur.envelopeVersion === porte.envelopeVersion && descripteur.slots === porte.slots) {\n" +
      "    return;\n" +
      "  }",
    apres: "  return;",
    epreuves: [ARCHIVE, RESTAURATION],
  },
  {
    nom: "l'enveloppe embarquée décrit LE MÊME VOLUME que le manifeste",
    garde: "assertEnveloppeDuMemeVolume — la confrontation des deux identifiants",
    fichier: IMPORT,
    avant: "  if (page.identifiantVolume === declare) return;",
    apres: "  if (page.identifiantVolume !== null) return;",
    epreuves: [RESTAURATION],
  },
  {
    nom: "une archive qui emporte une enveloppe DÉCLARE son volume",
    garde: "assertEnveloppeDuMemeVolume — le refus d'un manifeste sans identifiant",
    fichier: IMPORT,
    avant: "  const declare = verdict.manifest.volume?.id ?? null;\n  if (declare === null) {",
    apres: "  const declare = verdict.manifest.volume?.id ?? null;\n  if (false) {",
    epreuves: [RESTAURATION],
  },
  {
    nom: "une archive v3 DÉCLARE toujours son engagement, et une v2 le déclare NUL",
    garde: "lireLEngagementDeLArchive — la présence du champ, et la nullité explicite (#181)",
    fichier: ENGAGEMENT,
    avant: '  if (!Object.hasOwn(header, "engagement")) {',
    apres: "  if (false) {",
    epreuves: [RESTAURATION],
  },
  {
    nom: "un en-tête v2 DÉCLARE toujours « recovery », fût-ce à null",
    garde: "assertChampDeRecuperation — la présence du champ suit la version",
    fichier: SECTION,
    avant: "  if (porteLeChamp === attenduAvecChamp) return;",
    apres: "  if (porteLeChamp === attenduAvecChamp || attenduAvecChamp) return;",
    epreuves: [ARCHIVE],
  },
  {
    nom: "rien ne suit une archive : la queue est refusée",
    garde: "assertRienEnQueue — la longueur totale confrontée à la disposition",
    fichier: SECTION,
    avant: "  if (byteLength === archiveLength) return;",
    apres: "  return;",
    epreuves: [ARCHIVE],
  },
  {
    nom: "la FORME de la section est gardée À L'ÉCRITURE aussi",
    garde: "normaliserRecuperation — la garde partagée, côté export",
    fichier: SECTION,
    avant:
      "  const page = exigerEnveloppeDeRecuperationSeule(octets);\n" +
      "  accorderLeDescripteurEtLaPage(page, {\n" +
      "    envelopeVersion: recovery.version,\n" +
      "    slots: recovery.emplacements,\n" +
      "  });",
    apres: "",
    epreuves: [ARCHIVE],
  },
  {
    nom: "l'ORDRE est contenu, puis enveloppe, puis manifeste",
    garde: "poserLEnveloppePuisLeManifeste — l'ordre des deux derniers gestes",
    fichier: IMPORT,
    avant:
      "  await target.commitEngagement(\n" +
      "    verdict.engagement === null ? null : encoderFichierDEngagement(verdict.engagement),\n" +
      "  );\n" +
      "  await target.commitManifest(serializeManifest(verdict.manifest));",
    apres:
      "  await target.commitManifest(serializeManifest(verdict.manifest));\n" +
      "  await target.commitEngagement(\n" +
      "    verdict.engagement === null ? null : encoderFichierDEngagement(verdict.engagement),\n" +
      "  );",
    epreuves: [RESTAURATION, IMPORT_EPREUVE],
  },
  {
    nom: "une archive plus ANCIENNE que la feuille exige un consentement",
    garde: "exigerLAncre — le refus quand la version embarquée est en deçà",
    fichier: IMPORT,
    avant: "  if (embarquee >= versionMinimale || consentement !== null) return consentement;",
    apres: "  return consentement;",
    epreuves: [RESTAURATION],
  },
  {
    nom: "`versionMinimale` traverse l'ouvreur de production sans se perdre",
    garde: "ouvrirVolumeParKek — la feuille passée à `ouvrirEnveloppe`",
    fichier: OUVERTURE,
    avant:
      "  const ouverte = await ouvrirEnveloppe({\n" +
      "    support: support ?? supportEnveloppeOpfs(name),\n" +
      "    identifiantVolume,\n" +
      "    kek,\n" +
      "    versionMinimale,\n" +
      "  });",
    apres:
      "  const ouverte = await ouvrirEnveloppe({\n" +
      "    support: support ?? supportEnveloppeOpfs(name),\n" +
      "    identifiantVolume,\n" +
      "    kek,\n" +
      "  });",
    epreuves: [ANCRE],
  },
  {
    nom: "`ouvrirVolumeParDerivateur` transmet la feuille à `ouvrirVolumeParKek`",
    garde: "ouvrirVolumeParDerivateur — la feuille passée d'un ouvreur à l'autre",
    fichier: OUVERTURE,
    avant: "    size,\n    expectations,\n    versionMinimale,\n    support: supportEmploye,",
    apres: "    size,\n    expectations,\n    support: supportEmploye,",
    epreuves: [ANCRE],
  },

  // --- Les gardes de #181 : l'ENGAGEMENT, le chemin d'OUVERTURE, et la CRÉATION ----------------
  //
  // Elles sont ce qui sépare la correction du CRITICAL de la revue externe d'une déclaration
  // d'intention. Chacune est retirée pour de vrai, et l'épreuve qui devrait la couvrir doit rougir.

  {
    nom: "l'engagement scelle la GÉOMÉTRIE : retirer un champ des données associées se voit",
    garde: "donneesAssocieesDeLEngagement — la taille logique dans les données associées",
    fichier: ENGAGEMENT,
    avant: "    entierEnOctets(champs.tailleLogique, 8),\n",
    apres: "",
    epreuves: [VECTEURS],
  },
  {
    nom: "l'INFO de la dérivation lie le DOMAINE : le retirer ferait tirer la même clé partout",
    garde: "encoderInfoDeDomaine — l'étiquette de domaine dans l'info HKDF",
    fichier: DOMAINE,
    avant: "    chainePrefixee(domaine),\n",
    apres: "",
    epreuves: [VECTEURS],
  },
  {
    nom: "l'EMPREINTE du fichier est confrontée à celle que l'engagement scelle",
    garde: "verifierLEngagementDepose — la comparaison des deux empreintes",
    fichier: RACINE,
    avant: "  if (octetsEnHex(scellee) !== empreinte) {",
    apres: "  if (false) {",
    epreuves: [MELANGE],
  },
  {
    nom: "un engagement ABSENT n'autorise rien : le volume est refusé",
    garde: "verifierLEngagementDepose — le refus d'un voisin absent",
    fichier: RACINE,
    avant: "  if (octets === null) return null;",
    apres:
      "  if (octets === null) return { motif: MOTIFS_DE_RACINE_INITIALE.engagement, consommer: async () => {} };",
    epreuves: [MELANGE],
  },
  {
    nom: "un volume sans racine que RIEN n'autorise est REFUSÉ",
    garde: "remedeSansRacine — le refus de #181",
    fichier: RECUPERATION_GENERATION,
    avant: "  if (!autorisee) throw volumeSansRacine(volume, { chargePresente });",
    apres: "",
    epreuves: [MELANGE, GENERATION],
  },
  {
    nom: "la CRÉATION écrit sa racine initiale, et elle seule s'y autorise",
    garde: "openOpfsVolume — le motif « creation » d'une naissance",
    fichier: OUVREUR,
    avant: "  const motif = saisi.naissance ? MOTIFS_DE_RACINE_INITIALE.creation : creation;",
    apres: "  const motif = creation;",
    epreuves: [MELANGE],
  },

  // --- Les gardes ajoutées par les revues de la PR #184 -----------------------------------------
  //
  // Les deux revues ont relevé la même chose de deux côtés : ce que la PR déclarait « le contrat, et
  // il n'est pas négociable » n'était tenu par AUCUN mutant. Ces sept-là le tiennent, et chacun est
  // tué par une épreuve qui MESURE — l'ordre des gestes, le compte d'un tirage, une racine relue sur
  // le support — jamais par une épreuve qui relit une intention.

  {
    nom: "la DATATION d'une création confronte l'empreinte que le versement a rendue",
    garde: "confronterLEmpreinteVersee — la comparaison des deux empreintes",
    fichier: RACINE,
    avant: "  if (empreinte !== empreinteVersee) {",
    apres: "  if (false) {",
    epreuves: [COQUILLE],
  },
  {
    nom: "un journal SANS racine n'est pas une création à dater : c'est une restauration",
    garde: "exigerCreationSeule — l'exigence de la racine de naissance",
    fichier: RACINE,
    avant: "    racine === null ||\n",
    apres: "",
    epreuves: [MELANGE],
  },
  {
    nom: "une racine ABÎMÉE refuse AVANT que l'autorisation ne soit demandée",
    garde: "#recupererSansRacine — l'ordre « racine lisible, puis autorisation »",
    fichier: MAGASIN,
    avant:
      "    exigerRacineLisible({ volume: this.#volume, abimees, chargePresente });\n" +
      "    const autorisation = this.#sansRacine === null ? null : await this.#sansRacine.autoriser();",
    apres:
      "    const autorisation = this.#sansRacine === null ? null : await this.#sansRacine.autoriser();\n" +
      "    exigerRacineLisible({ volume: this.#volume, abimees, chargePresente });",
    epreuves: [MELANGE],
  },
  {
    nom: "l'engagement n'est CONSOMMÉ qu'une fois la racine initiale durable",
    garde: "#recupererSansRacine — l'ordre « racine initiale, puis consommation »",
    fichier: MAGASIN,
    avant:
      "    await this.#vider({ sequence: SEQUENCE_AVANT_LA_PREMIERE_RACINE, generation: 0 });\n" +
      "    await autorisation.consommer();",
    apres:
      "    await autorisation.consommer();\n" +
      "    await this.#vider({ sequence: SEQUENCE_AVANT_LA_PREMIERE_RACINE, generation: 0 });",
    epreuves: [MELANGE],
  },
  {
    nom: "l'engagement EST consommé : un voisin relu à chaque ouverture serait une fenêtre de plus",
    garde: "#recupererSansRacine — l'appel à `consommer`",
    fichier: MAGASIN,
    avant: "    await autorisation.consommer();\n",
    apres: "",
    epreuves: [MELANGE],
  },
  {
    nom: "le SEL du domaine « archive » est TIRÉ, un par archive",
    garde: "scellerEngagement — le tirage du sel de domaine",
    fichier: ENGAGEMENT,
    avant: "  sel = tirerSelDeDomaine(),",
    apres: "  sel = new Uint8Array(32).fill(7),",
    epreuves: [VECTEURS],
  },
  {
    nom: "la MIGRATION v2 → v3 écrit sa racine initiale",
    garde: "migrateVolume — l'appel à `daterLeVolumeMigre`",
    fichier: MIGRATION,
    avant: "  await daterLeVolumeMigre({ target, backend, manifest, cle });\n",
    apres: "",
    epreuves: [MIGRATION_RACINE],
  },
]);

function principal() {
  const { resultats } = campagneDeMutation({
    mutations: MUTATIONS,
    etiquette: "archive-recuperation",
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
