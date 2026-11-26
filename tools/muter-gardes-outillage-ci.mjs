#!/usr/bin/env node
// CAMPAGNE DE MUTATION de l'outillage de CI (#328, relecture 3 de #329) : un mutant par garde de
// `tools/attestations-ci.mjs` (le vérificateur des lots et des tranches), du refus des tranches et des
// tables vides (`tools/moteur-de-mutation.mjs`) et du refus des sélections et campagnes vides
// (`tools/rejouer-les-campagnes.mjs`). Un vérificateur que rien ne fait rougir, ce n'est pas un garde.
//
//     node tools/muter-gardes-outillage-ci.mjs [--json]

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const ATTESTATIONS = "tools/attestations-ci.mjs";
const MOTEUR = "tools/moteur-de-mutation.mjs";
const LANCEUR = "tools/rejouer-les-campagnes.mjs";
const E_ATTESTATIONS = "tests/unit/attestations-ci.test.mjs";
const LIMITES = "tools/publier-limites-hebergeur.mjs";
const ENVOI = "tools/publier-envoi.mjs";
const IMAGE = "tools/publier-image.mjs";
const PUBLIER = "tools/publier.mjs";
const E_LIMITES = "tests/unit/publication-limites-hebergeur.test.mjs";
const E_ENVOI = "tests/unit/publication-envoi.test.mjs";
const E_IMAGE = "tests/unit/publication-image.test.mjs";
const E_REPARTITION = "tests/unit/campagnes-de-mutation-repartition.test.mjs";

/** `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier (le moteur refuse sinon). */
export const MUTATIONS = Object.freeze([
  {
    nom: "un lot hors de 1..N est inattendu",
    garde: "verifierMutations — la borne haute du numéro de lot",
    fichier: ATTESTATIONS,
    avant: " || a.lot > LOTS.length || a.sur !== LOTS.length",
    apres: " || a.sur !== LOTS.length",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "un lot absent est un écart",
    garde: "verifierMutations — attestation absente",
    fichier: ATTESTATIONS,
    avant: "if (trouvees.length === 0) ecarts.push(`lot ${i} : attestation absente.`);",
    apres: "if (false) ecarts.push(`lot ${i} : attestation absente.`);",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "un lot en double est un écart",
    garde: "verifierMutations — attestation présente plusieurs fois",
    fichier: ATTESTATIONS,
    avant: "if (trouvees.length > 1)\n      ecarts.push(`lot ${i} :",
    apres: "if (trouvees.length > 99)\n      ecarts.push(`lot ${i} :",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "un lot qui n'a pas joué ses entrées est refusé",
    garde: "verifierMutations — entrées jouées égales à LOTS",
    fichier: ATTESTATIONS,
    avant: "if (JSON.stringify(a.entrees) !== JSON.stringify(LOTS[i - 1])) {",
    apres: "if (false) {",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "un lot sans aucun mutant est vide",
    garde: "verifierMutations — compte du lot non vide",
    fichier: ATTESTATIONS,
    avant: "const vide = !(a.mutants > 0) || ",
    apres: "const vide = ",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "une campagne sans mutant dans un lot non vide est vide",
    garde: "verifierMutations — compte de CHAQUE entrée non vide",
    fichier: ATTESTATIONS,
    avant: " || (a.campagnes ?? []).some((c) => !(c.mutants > 0));",
    apres: ";",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "le `ok` global d'un lot en échec est refusé",
    garde: "verifierMutations — a.ok",
    fichier: ATTESTATIONS,
    avant: "if (a.ok !== true) ecarts.push(`lot ${i} : en échec.`);",
    apres: "if (false) ecarts.push(`lot ${i} : en échec.`);",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "un survivant est refusé",
    garde: "verifierMutations — survivants",
    fichier: ATTESTATIONS,
    avant: "if (a.survivants > 0 || (a.campagnes ?? []).some((c) => c.survivants > 0)) {",
    apres: "if (false) {",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "les tués du lot égalent ses mutants",
    garde: "verifierMutations — tués ≠ mutants du lot",
    fichier: ATTESTATIONS,
    avant: "if (a.tues !== a.mutants) ecarts.push(",
    apres: "if (false) ecarts.push(",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "chaque campagne doit avoir réussi",
    garde: "verifierMutations — c.ok de chaque campagne",
    fichier: ATTESTATIONS,
    avant: "if (c.ok !== true) ecarts.push(",
    apres: "if (false) ecarts.push(",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "chaque campagne a tué tous ses mutants",
    garde: "verifierMutations — tués ≠ mutants par campagne",
    fichier: ATTESTATIONS,
    avant: "if (c.tues !== c.mutants) {",
    apres: "if (false) {",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "les comptes d'une campagne se tiennent",
    garde: "verifierMutations — tués + survivants = mutants par campagne",
    fichier: ATTESTATIONS,
    avant: "if (c.mutants !== c.tues + c.survivants) {",
    apres: "if (false) {",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "les comptes du lot égalent la somme des campagnes",
    garde: "verifierMutations — somme des comptes par campagne",
    fichier: ATTESTATIONS,
    avant:
      'a.mutants !== somme("mutants") ||\n      a.tues !== somme("tues") ||\n      a.survivants !== somme("survivants")',
    apres: "false",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "une tranche navigateur hors de 1..N est inattendue",
    garde: "verifierNavigateur — la borne haute du numéro de tranche",
    fichier: ATTESTATIONS,
    avant: "      a.tranche > TRANCHES_NAVIGATEUR ||\n",
    apres: "",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "une tranche navigateur absente est un écart",
    garde: "verifierNavigateur — attestation absente",
    fichier: ATTESTATIONS,
    avant: "if (trouvees.length === 0) ecarts.push(`tranche ${i} : attestation absente.`);",
    apres: "if (false) ecarts.push(`tranche ${i} : attestation absente.`);",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "une tranche navigateur en double est un écart",
    garde: "verifierNavigateur — attestation présente plusieurs fois",
    fichier: ATTESTATIONS,
    avant: "if (trouvees.length > 1)\n      ecarts.push(`tranche ${i} :",
    apres: "if (trouvees.length > 99)\n      ecarts.push(`tranche ${i} :",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "une tranche navigateur sans épreuve réussie est vide",
    garde: "verifierNavigateur — attendus > 0",
    fichier: ATTESTATIONS,
    avant: "if (!(a.attendus > 0)) ecarts.push(",
    apres: "if (false) ecarts.push(",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "une épreuve navigateur en échec est refusée",
    garde: "verifierNavigateur — inattendus",
    fichier: ATTESTATIONS,
    avant: "if (a.inattendus > 0) ecarts.push(",
    apres: "if (false) ecarts.push(",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "une reprise navigateur est refusée",
    garde: "verifierNavigateur — flaky",
    fichier: ATTESTATIONS,
    avant: "if (a.flaky > 0) ecarts.push(",
    apres: "if (false) ecarts.push(",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "un rapport Playwright sans stats est refusé",
    garde: "attestationNavigateur — pas de `stats`",
    fichier: ATTESTATIONS,
    avant: 'if (!stats) throw new Error("rapport Playwright illisible : pas de `stats`.");',
    apres: "",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "un dossier d'attestations illisible fait échouer le CLI",
    garde: "principal — le catch de lireDossier",
    fichier: ATTESTATIONS,
    avant:
      "console.error(`Dossier d'attestations illisible : ${erreur.message}`);\n      return 1;",
    apres:
      "console.error(`Dossier d'attestations illisible : ${erreur.message}`);\n      return 0;",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "des écarts font sortir le CLI en code 1",
    garde: "principal — le code de sortie de verifier",
    fichier: ATTESTATIONS,
    avant: "return ecarts.length === 0 ? 0 : 1;",
    apres: "return 0;",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "une table de mutations vide est refusée",
    garde: "filtrerParTranche — table vide",
    fichier: MOTEUR,
    avant: 'if (mutations.length === 0) throw new Error("table de mutations vide',
    apres: 'if (false) throw new Error("table de mutations vide',
    epreuves: [E_REPARTITION],
  },
  {
    nom: "une tranche i > n est invalide",
    garde: "filtrerParTranche — i ≤ n",
    fichier: MOTEUR,
    avant: "if (!lue || i > n) {",
    apres: "if (!lue) {",
    epreuves: [E_REPARTITION],
  },
  {
    nom: "une tranche valide mais vide est refusée",
    garde: "filtrerParTranche — tranche vide",
    fichier: MOTEUR,
    avant: "if (retenues.length === 0) {",
    apres: "if (false) {",
    epreuves: [E_REPARTITION],
  },
  {
    nom: "une liste de campagnes vide est refusée",
    garde: "selectionner — --campagnes vide",
    fichier: LANCEUR,
    avant: "if (noms.length === 0) throw",
    apres: "if (false) throw",
    epreuves: [E_REPARTITION],
  },
  {
    nom: "une campagne qui ne rend aucun mutant échoue",
    garde: "jouer — résultats vides",
    fichier: LANCEUR,
    avant: "if (resultats.length === 0) {",
    apres: "if (false) {",
    epreuves: [E_ATTESTATIONS],
  },
  {
    nom: "limites — 25 Mio pile passe (borne par fichier)",
    garde: "mesurerLesLimites — octets par fichier",
    fichier: LIMITES,
    avant: "      if (octets > profil.octetsParFichier) {",
    apres: "      if (octets >= profil.octetsParFichier) {",
    epreuves: [E_LIMITES],
  },
  {
    nom: "limites — 20 000 fichiers pile passe",
    garde: "mesurerLesLimites — nombre de fichiers",
    fichier: LIMITES,
    avant: "fichiers.length > profil.fichiers",
    apres: "fichiers.length >= profil.fichiers",
    epreuves: [E_LIMITES],
  },
  {
    nom: "limites — 100 règles pile passe",
    garde: "mesurerLesLimites — règles _headers",
    fichier: LIMITES,
    avant: "regles.length > profil.reglesHeaders",
    apres: "regles.length >= profil.reglesHeaders",
    epreuves: [E_LIMITES],
  },
  {
    nom: "limites — les en-têtes indentés ne sont pas des règles",
    garde: "reglesDuFichierHeaders — lignes indentées",
    fichier: LIMITES,
    avant: " && !/^\\s/.test(ligne)",
    apres: "",
    epreuves: [E_LIMITES],
  },
  {
    nom: "limites — une ligne _headers trop longue dépasse",
    garde: "mesurerLesLimites — longueur de ligne",
    fichier: LIMITES,
    avant: "if (ligne.length > profil.longueurLigneHeaders) {",
    apres: "if (false) {",
    epreuves: [E_LIMITES],
  },
  {
    nom: "limites — netlify avertit au-delà de 10 Mio",
    garde: "mesurerLesLimites — avertissement",
    fichier: LIMITES,
    avant: "if (octets > profil.avertirAuDela) {",
    apres: "if (false) {",
    epreuves: [E_LIMITES],
  },
  {
    nom: "--verifier rend 7 sur un dépassement",
    garde: "verdictDesLimites — code dédié",
    fichier: PUBLIER,
    avant: "if (resultat.depassements.length === 0) return CODES.conforme;",
    apres: "return CODES.conforme;",
    epreuves: [E_LIMITES],
  },
  {
    nom: "--verifier transmet le profil à la vérification",
    garde: "principal — profil de --verifier",
    fichier: PUBLIER,
    avant: "return verifier(resolve(aVerifier), { tolererIncomplet, profil });",
    apres: "return verifier(resolve(aVerifier), { tolererIncomplet, profil: null });",
    epreuves: [E_LIMITES],
  },
  {
    nom: "envoi — des secrets absents n'envoient pas",
    garde: "decider — secrets manquants",
    fichier: ENVOI,
    avant: "if (manquants.length > 0) {",
    apres: "if (false) {",
    epreuves: [E_ENVOI],
  },
  {
    nom: "envoi — --repetition n'envoie jamais",
    garde: "decider — répétition demandée",
    fichier: ENVOI,
    avant: "if (!envoyer) {",
    apres: "if (false) {",
    epreuves: [E_ENVOI],
  },
  {
    nom: "envoi — un dépassement refuse l'envoi réel",
    garde: "principal — refus avant wrangler",
    fichier: ENVOI,
    avant: "  if (depassements > 0) {\n    process.stderr.write(",
    apres: "  if (false) {\n    process.stderr.write(",
    epreuves: [E_ENVOI],
  },
  {
    nom: "envoi — wrangler est épinglé à une version exacte",
    garde: "VERSION_DE_WRANGLER",
    fichier: ENVOI,
    avant: 'export const VERSION_DE_WRANGLER = "4.168.0";',
    apres: 'export const VERSION_DE_WRANGLER = "latest";',
    epreuves: [E_ENVOI],
  },
  {
    nom: "envoi — un nom de projet douteux est refusé",
    garde: "commandeDeWrangler — nom de projet",
    fichier: ENVOI,
    avant: 'if (!NOM_DE_PROJET.test(projet ?? "")) {',
    apres: "if (false) {",
    epreuves: [E_ENVOI],
  },
  {
    nom: "image — une taille qui diverge du descripteur est refusée",
    garde: "copierLImage — taille",
    fichier: IMAGE,
    avant: "if (metadonnees.size !== fichier.octets) {",
    apres: "if (false) {",
    epreuves: [E_IMAGE],
  },
  {
    nom: "image — une empreinte de boot qui diverge est refusée",
    garde: "copierLImage — empreinte",
    fichier: IMAGE,
    avant: "if (mesure !== fichier.sha256) {",
    apres: "if (false) {",
    epreuves: [E_IMAGE],
  },
  {
    nom: "image — un artefact nommé et absent est refusé",
    garde: "copierLImage — présence",
    fichier: IMAGE,
    avant: "if (!metadonnees?.isFile()) {",
    apres: "if (false) {",
    epreuves: [E_IMAGE],
  },
]);

function principal() {
  const { resultats } = campagneDeMutation({ mutations: MUTATIONS, etiquette: "outillage-ci" });
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
