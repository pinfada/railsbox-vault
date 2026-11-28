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
// #342 ajoute les gardes de la SOURCE, jouées avant le premier `docker build` : un lien symbolique
// n'entre pas (la copie le suivrait), un secret écrit dans le contenu d'un fichier non plus, et la
// directive `ruby` du Gemfile doit accepter le seul Ruby du guest. Les mutants des liens ne rougissent
// que là où un lien se pose : sous Windows sans privilège, l'épreuve les SAUTE, et la campagne y
// compte ces deux mutants survivants. La CI (Linux) les tue.
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

// Les gardes de la SOURCE (#342) : liens symboliques, Ruby demandé, secrets par contenu.
const FABRIQUE = "tools/paquet/fabriquer-paquet.mjs";
const GARDES = "tools/paquet/gardes-de-la-source.mjs";
const LIENS = "tools/paquet/liens-de-la-source.mjs";
const RUBY = "tools/paquet/ruby-demande.mjs";
const BALAYAGE_DU_CONTENU = "tools/paquet/secrets-du-contenu.mjs";

const EPREUVE_GARDES = "tests/unit/paquet-gardes-de-la-source.test.mjs";
const EPREUVE_RUBY = "tests/unit/paquet-ruby-demande.test.mjs";
const EPREUVE_CONTENU = "tests/unit/paquet-secrets-du-contenu.test.mjs";

// Les gardes d'une application EXTÉRIEURE (#351, ADR 0055).
const IDENTIFIANTS_CHIFFRES = "tools/paquet/identifiants-chiffres.mjs";
const FINS_DE_LIGNE = "tools/paquet/fins-de-ligne.mjs";
const SCHEMA = "tools/paquet/schema-de-l-application.mjs";
const DOCKERFILE = "tools/build-reference-image/guest.Dockerfile";
const SONDE = "src/vm/sonde-de-demarrage.mjs";
const APPLICATION = "src/coquille/installation-interrompue.mjs";
const DEPHASAGE = "src/coquille/dephasage.mjs";

const EPREUVE_EXTERIEURE = "tests/unit/paquet-application-exterieure.test.mjs";
const EPREUVE_SONDE = "tests/unit/vm-sonde-de-demarrage.test.mjs";
const EPREUVE_EN_ECHEC = "tests/unit/coquille-application-en-echec.test.mjs";
const EPREUVE_DEPHASAGE = "tests/unit/coquille-dephasage.test.mjs";

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
  // --- #342 : les gardes de la source, avant le premier `docker build` ---
  {
    nom: "une source qui porte une anomalie de liens, de Ruby ou de secrets n'est pas construite",
    garde: "examinerLaSource — le refus quand les gardes de la source rendent une anomalie",
    fichier: FABRIQUE,
    avant: "  if (anomalies.length > 0) throw erreurDeRefus(source, anomalies);\n",
    apres: "",
    epreuves: [EPREUVE_GARDES],
  },
  {
    nom: "un lien symbolique est reconnu comme tel, sans être suivi",
    garde: "estUnLien — le `lstat` du chemin retenu",
    fichier: LIENS,
    avant: "    return lstatSync(join(source, relatif)).isSymbolicLink();\n",
    apres: "    return false;\n",
    epreuves: [EPREUVE_GARDES],
  },
  {
    nom: "un lien n'est jamais LU : ni par le Ruby demandé, ni par le balayage des secrets",
    garde: "gardesDeLaSource — les liens retirés des fichiers lisibles",
    fichier: GARDES,
    avant: "  const lisibles = fichiers.filter((relatif) => !sontDesLiens.has(relatif));\n",
    apres: "  const lisibles = fichiers;\n",
    epreuves: [EPREUVE_GARDES],
  },
  {
    nom: "une directive `ruby` que le Ruby du guest ne satisfait pas est refusée",
    garde: "confronterLeRubyDemande — le verdict de Gem::Requirement",
    fichier: RUBY,
    avant:
      "  if (satisfaitLaContrainteRuby(rubyDuGuest, contrainte.contraintes) !== false) return [];\n",
    apres: "  return [];\n",
    epreuves: [EPREUVE_GARDES],
  },
  {
    nom: "`~>` a une borne haute : la série suivante ne satisfait pas la contrainte",
    garde: "satisfaitUne — la borne pessimiste",
    fichier: RUBY,
    avant:
      "        comparaison >= 0 && comparerSegments(version, bornePessimiste(contrainte.segments)) < 0\n",
    apres: "        comparaison >= 0\n",
    epreuves: [EPREUVE_RUBY],
  },
  {
    nom: "`ruby file:` qui désigne un fichier absent du paquet est refusé",
    garde: "confronterLeRubyDemande — la présence du fichier désigné parmi les retenus",
    fichier: RUBY,
    avant: "    if (!fichiers.includes(designe)) {\n",
    apres: "    if (false) {\n",
    epreuves: [EPREUVE_GARDES],
  },
  {
    nom: "une valeur à forme de jeton est refusée partout, quel que soit le nom",
    garde: "constatDeLaLigne — la clé PEM et les motifs de jetons",
    fichier: BALAYAGE_DU_CONTENU,
    avant:
      "  if (CLE_PRIVEE_PEM.test(ligne) || valeursCandidates(ligne, yaml).some(ressembleAUnJeton)) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_CONTENU],
  },
  {
    nom: "une clé au nom de secret, valeur écrite en clair, est refusée sous config/ et dans les graines",
    garde: "constatDeLaLigne — les clés au nom de secret",
    fichier: BALAYAGE_DU_CONTENU,
    avant:
      "  const cle = clesSecretes(ligne, yaml).find((c) => !assumeePublique(assumesPublics, chemin, c));\n",
    apres: "  const cle = undefined;\n",
    epreuves: [EPREUVE_CONTENU],
  },
  {
    nom: "une valeur lue dans l'environnement (ERB, ENV) n'est pas un secret écrit",
    garde: "valeurEcrite — l'exception des références à l'environnement",
    fichier: BALAYAGE_DU_CONTENU,
    avant: "  return !/<%|#\\{|\\bENV\\b/.test(valeur);\n",
    apres: "  return true;\n",
    epreuves: [EPREUVE_CONTENU],
  },
  {
    nom: "la dérogation nomme son FICHIER : elle ne couvre pas la même clé ailleurs",
    garde: "assumeePublique — la comparaison exacte du fichier et de la clé",
    fichier: BALAYAGE_DU_CONTENU,
    avant: "    (entree) => entree?.fichier === fichier && entree?.cle === cle,\n",
    apres: "    (entree) => entree?.cle === cle,\n",
    epreuves: [EPREUVE_CONTENU],
  },
  // --- #351 : une application extérieure, non modifiée, se fabrique et démarre -----------------
  {
    nom: "un chiffré Rails AVEC sa clé n'est pas exclu : la paire reste refusée",
    garde: "identifiantsChiffresSansCle — la présence de la clé",
    fichier: IDENTIFIANTS_CHIFFRES,
    avant: "    return cle !== null && !presents.has(cle);\n",
    apres: "    return cle !== null;\n",
    epreuves: [EPREUVE_EXTERIEURE],
  },
  {
    nom: "un chiffré Rails sans sa clé n'entre pas dans le paquet",
    garde: "examinerLaSource — le retrait des identifiants exclus",
    fichier: FABRIQUE,
    avant: "  const fichiers = retenus.filter((relatif) => !exclus.includes(relatif));\n",
    apres: "  const fichiers = retenus;\n",
    epreuves: [EPREUVE_EXTERIEURE],
  },
  {
    nom: "un fichier binaire n'est jamais normalisé",
    garde: "finsDeLigneNormalisees — le critère du texte",
    fichier: FINS_DE_LIGNE,
    avant:
      "  if (!estDuTexte(octets) || !octets.includes(CRLF)) return { octets, normalise: false };\n",
    apres: "  if (!octets.includes(CRLF)) return { octets, normalise: false };\n",
    epreuves: [EPREUVE_EXTERIEURE],
  },
  {
    nom: "un CR isolé n'est pas une fin de ligne",
    garde: "finsDeLigneNormalisees — seul le CR suivi d'un LF est retiré",
    fichier: FINS_DE_LIGNE,
    avant: "    if (octets[rang] === CR && octets[rang + 1] === LF) continue;\n",
    apres: "    if (octets[rang] === CR) continue;\n",
    epreuves: [EPREUVE_EXTERIEURE],
  },
  {
    nom: "un schema.rb à soulignés est lu en entier",
    garde: "schemaLu — le retrait des soulignés",
    fichier: SCHEMA,
    avant: '  if (dump !== null) return dump[1].replaceAll("_", "");\n',
    apres: "  if (dump !== null) return dump[1];\n",
    epreuves: [EPREUVE_EXTERIEURE],
  },
  {
    nom: "une application sans migration a le schéma 0",
    garde: "schemaLu — le schéma d'une base sans migration",
    fichier: SCHEMA,
    avant: "  if (versions.length === 0) return SCHEMA_SANS_MIGRATION;\n",
    apres: "",
    epreuves: [EPREUVE_EXTERIEURE],
  },
  {
    nom: "le verrou gagne la plateforme `ruby` avant `bundle install`",
    garde: "guest.Dockerfile — `bundle lock --add-platform ruby`",
    fichier: DOCKERFILE,
    avant: "    BUNDLE_FROZEN=false linux32 bundle lock --add-platform ruby; \\\n",
    apres: "",
    epreuves: [EPREUVE_EXTERIEURE],
  },
  {
    nom: "`storage/` du paquet est un lien vers le disque de données",
    garde: "guest.Dockerfile — `ln -sfn var/storage storage` avant `db:migrate`",
    fichier: DOCKERFILE,
    avant: "    ln -sfn var/storage storage; \\\n",
    apres: "",
    epreuves: [EPREUVE_EXTERIEURE],
  },
  {
    nom: "la durabilité SQLite est chargée dans tout processus Ruby du guest",
    garde: "guest.Dockerfile — `RUBYOPT` dans `env.sh`",
    fichier: DOCKERFILE,
    avant: "      echo 'export RUBYOPT=-r/opt/vault/durabilite-rails.rb'; \\\n",
    apres: "",
    epreuves: [EPREUVE_EXTERIEURE],
  },
  {
    nom: "toute réponse de Rails vaut « prêt », pas seulement un 200",
    garde: "attendreQueRailsReponde — la réponse, quel que soit son statut",
    fichier: SONDE,
    avant:
      "      return { durationMs: maintenant() - debut, sante: santeDe(reponse), statut: reponse.statut };\n",
    apres:
      "      if (reponse.statut === 200) {\n" +
      "        return { durationMs: maintenant() - debut, sante: santeDe(reponse), statut: 200 };\n" +
      "      }\n",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "une application arrêtée fait échouer tout de suite",
    garde: "attendreQueRailsReponde — la marque d'arrêt du guest",
    fichier: SONDE,
    avant: "    if (estArretee()) {\n",
    apres: "    if (false) {\n",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "une cause en clair devient un démarrage refusé typé",
    garde: "applicationEnEchec — la réponse typée de la coquille",
    fichier: APPLICATION,
    avant: '  if (typeof cause !== "string" || cause === "") return null;\n',
    apres: "  return null;\n",
    epreuves: [EPREUVE_EN_ECHEC],
  },
  {
    nom: "l'installation dit aussi l'identité servie",
    garde: "deciderLeDephasage — `servie.id` à l'installation",
    fichier: DEPHASAGE,
    avant:
      "        : { id: descripteur.application.id, ...versionEtSchema(descripteur.application) };\n",
    apres: "        : versionEtSchema(descripteur.application);\n",
    epreuves: [EPREUVE_DEPHASAGE],
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
