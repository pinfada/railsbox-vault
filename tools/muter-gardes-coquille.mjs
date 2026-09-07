#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes de la coquille de produit (#161, ADR 0028).
//
//     node tools/muter-gardes-coquille.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs` : recopie du dépôt dans un atelier
// temporaire, `NODE_TEST_CONTEXT` retiré de l'enfant, épreuve jouée SANS mutation d'abord, `node
// --check` sur le fichier muté, arrêt sans verdict compté NON CONCLUANT. Ce fichier ne tient que sa
// TABLE.
//
// ## Pourquoi la campagne porte sur `src/coquille/` et non sur la page
//
// Les gardes de la frontière sont des FONCTIONS PURES : `evaluerAnnonce`, `evaluerRequete`,
// `decoderMessage`, `sansCapacite`, `cheminApplicatifAdmis`, `chargeUtileDEtat`. La page et le
// Worker ne font que les appeler. Ce partage est délibéré, et la campagne est la raison : une garde
// écrite dans `public/main.mjs` ne serait éprouvable que par un navigateur, donc jamais par un
// enfant borné — et une garde qu'aucune mutation ne peut atteindre est une garde qu'on croit sur
// parole.
//
// ## Ce que la campagne ne peut PAS mesurer, et il faut le dire
//
// Elle ne mesure pas ce que le NAVIGATEUR fait de ces décisions : que `postMessage` transfère
// réellement un port, que la sandbox refuse réellement la navigation du sommet, que l'OPFS soit
// réellement partitionné. Cela relève de `tests/browser/coquille-frontiere.spec.mjs`, sur les trois
// moteurs, avec son témoin positif en même origine. Les deux se complètent : la campagne dit que la
// décision sait rougir, le navigateur dit qu'elle porte sur quelque chose.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const ADMISSION = "src/coquille/admission-applicative.mjs";
const CONTRAT = "src/coquille/contrat-de-messages.mjs";
const ORIGINES = "src/coquille/origines-de-la-coquille.mjs";
const ETAT = "src/coquille/etat-de-la-coquille.mjs";

/** Les gardes de #162 (ADR 0029), dans `src/coquille/` pour le motif exact de celles de #161. */
const ATTENTE = "src/coquille/attente-annoncee.mjs";
const SAISIE = "src/coquille/saisie-du-code.mjs";
const FEUILLE = "src/coquille/feuille-de-recuperation.mjs";
const MOYENS = "src/coquille/moyens-de-deverrouillage.mjs";
const INTERFACE = "src/coquille/interface-de-deverrouillage.mjs";

const EPREUVE_ADMISSION = "tests/unit/coquille-admission.test.mjs";
const EPREUVE_CONTRAT = "tests/unit/coquille-contrat.test.mjs";
const EPREUVE_DEVERROUILLAGE = "tests/unit/coquille-deverrouillage.test.mjs";

/**
 * Les gardes de #161, et la façon exacte de les retirer.
 *
 * `avant` doit apparaître EXACTEMENT UNE FOIS dans le fichier : deux occurrences voudraient dire
 * que la mutation ne décrit pas ce qu'elle croit décrire, et l'outil refuse plutôt que d'en muter
 * une au hasard.
 */
export const MUTATIONS = Object.freeze([
  {
    nom: "aucun port n'est octroyé avant le canal privilégié",
    garde: "evaluerAnnonce — la condition d'ORDRE, contrôlée la première",
    fichier: ADMISSION,
    avant:
      "  if (!canalPrivilegiePret) {\n" +
      "    return { accepte: false, code: CODES_REFUS_COQUILLE.canalAbsent };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "l'annonce doit porter LE type de l'annonce",
    garde: "evaluerAnnonce — la vérification du type",
    fichier: ADMISSION,
    avant:
      "  if (type !== TYPES_APPLICATIFS.annonce) {\n" +
      "    return { accepte: false, code: CODES_REFUS_COQUILLE.annonceType };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "l'annonce doit venir de l'origine ATTENDUE",
    garde: "evaluerAnnonce — la vérification de l'origine",
    fichier: ADMISSION,
    avant:
      "  if (origine !== origineAttendue) {\n" +
      "    return { accepte: false, code: CODES_REFUS_COQUILLE.annonceOrigine };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "l'annonce doit venir du CADRE, pas d'une iframe qu'il aurait créée",
    garde: "evaluerAnnonce — la vérification de la fenêtre émettrice",
    fichier: ADMISSION,
    avant:
      "  if (!fenetreEstLeCadre) {\n" +
      "    return { accepte: false, code: CODES_REFUS_COQUILLE.annonceFenetre };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "le port restreint n'est transféré qu'UNE fois",
    garde: "evaluerAnnonce — l'unicité",
    fichier: ADMISSION,
    avant:
      "  if (dejaOctroye) {\n" +
      "    return { accepte: false, code: CODES_REFUS_COQUILLE.annonceUnique };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "chaque geste de la liste de refus reçoit SON code",
    garde: "evaluerRequete — la consultation de la liste de refus",
    fichier: ADMISSION,
    avant:
      "  if (REFUSES.has(type)) {\n" +
      "    return { admise: false, code: REFUSES.get(type), recu: typeRendu(type), correlation };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "un type du canal privilégié n'est pas servi sur le port restreint",
    garde: "evaluerRequete — la reconnaissance des types privilégiés",
    fichier: ADMISSION,
    avant:
      "  if (estTypePrivilegie(type)) {\n" +
      "    return {\n" +
      "      admise: false,\n" +
      "      code: CODES_REFUS_COQUILLE.portPrivilegie,\n" +
      "      recu: typeRendu(type),\n" +
      "      correlation,\n" +
      "    };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "la liste d'admission est une LISTE, pas un accueil",
    garde: "evaluerRequete — le filtre `REQUETES_ADMISES`",
    fichier: ADMISSION,
    avant:
      "  if (!REQUETES_ADMISES.has(type)) {\n" +
      "    return {\n" +
      "      admise: false,\n" +
      "      code: CODES_REFUS_COQUILLE.typeInconnu,\n" +
      "      recu: typeRendu(type),\n" +
      "      correlation,\n" +
      "    };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "un message d'un AUTRE contrat est refusé",
    garde: "decoderMessage — la comparaison de l'identifiant de contrat",
    fichier: CONTRAT,
    avant:
      "  if (message.contrat !== CONTRAT_COQUILLE.id) {\n" +
      "    return { ok: false, code: CODES_REFUS_COQUILLE.contratRefuse };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_CONTRAT],
  },
  {
    nom: "une version étrangère n'est jamais servie « au mieux »",
    garde: "decoderMessage — la comparaison de version",
    fichier: CONTRAT,
    avant:
      "  if (message.version !== CONTRAT_COQUILLE.version) {\n" +
      "    return { ok: false, code: CODES_REFUS_COQUILLE.contratRefuse };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_CONTRAT],
  },
  {
    nom: "aucune capacité ne franchit le port restreint",
    garde: "sansCapacite — la liste des constructeurs interdits et les vues sur tampon",
    fichier: CONTRAT,
    avant:
      "  if (nom && INTERDITS.has(nom)) throw refusDeCapacite(nom);\n" +
      '  if (ArrayBuffer.isView(valeur)) throw refusDeCapacite("vue sur un tampon");\n',
    apres: "",
    epreuves: [EPREUVE_CONTRAT],
  },
  {
    nom: "le corps d'un message passe par le contrôle avant d'être enveloppé",
    garde: "enveloppeDeMessage — l'appel à `sansCapacite`",
    fichier: CONTRAT,
    avant: "  sansCapacite(corps);\n",
    apres: "",
    epreuves: [EPREUVE_CONTRAT],
  },
  {
    nom: "un chemin relatif au SCHÉMA n'est pas un chemin",
    garde: "cheminApplicatifAdmis — le refus de `//`",
    fichier: ORIGINES,
    avant: '  if (chemin.startsWith("//")) return null;\n',
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "une origine déjà applicative ne se dérive pas en `app.app.…`",
    garde: "origineApplicativeDe — le refus d'un hôte déjà préfixé",
    fichier: ORIGINES,
    avant: "  if (url.hostname.startsWith(PREFIXE_APPLICATIF)) return null;\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "un chemin qui n'est pas un chemin n'en est pas un",
    garde: "cheminApplicatifAdmis — l'exigence d'une barre oblique initiale",
    fichier: ORIGINES,
    avant: '  if (!chemin.startsWith("/")) return null;\n',
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "un séparateur inversé ne fabrique pas un chemin",
    garde: "cheminApplicatifAdmis — le refus de la barre oblique inversée",
    fichier: ORIGINES,
    avant: '  if (chemin.includes("\\\\")) return null;\n',
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "un type qui n'est pas une chaîne n'est pas un type",
    garde: "decoderMessage — la nature du type",
    fichier: CONTRAT,
    avant:
      '  if (typeof message.type !== "string" || message.type.length === 0) {\n' +
      "    return { ok: false, code: CODES_REFUS_COQUILLE.messageMalforme };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_CONTRAT],
  },
  {
    nom: "un type au-delà de la borne est une charge utile déguisée",
    garde: "decoderMessage — la borne de longueur du type",
    fichier: CONTRAT,
    avant:
      "  if (message.type.length > TAILLE_MAXIMALE_DU_TYPE) {\n" +
      "    return { ok: false, code: CODES_REFUS_COQUILLE.messageMalforme };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_CONTRAT],
  },
  {
    nom: "une requête admise ne porte aucun champ hors du contrat",
    garde: "evaluerRequete — le contrôle de forme exacte",
    fichier: ADMISSION,
    avant:
      "  if (!formeExacte(message)) {\n" +
      "    return {\n" +
      "      admise: false,\n" +
      "      code: CODES_REFUS_COQUILLE.messageMalforme,\n" +
      "      recu: typeRendu(type),\n" +
      "      correlation,\n" +
      "    };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "une requête sans corrélation ne peut pas recevoir SA réponse",
    garde: "evaluerRequete — l'exigence d'un identifiant de corrélation",
    fichier: ADMISSION,
    avant:
      "  if (correlation === null) {\n" +
      "    return {\n" +
      "      admise: false,\n" +
      "      code: CODES_REFUS_COQUILLE.correlationAbsente,\n" +
      "      recu: typeRendu(type),\n" +
      "      correlation: null,\n" +
      "    };\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "un identifiant de corrélation est borné et clos",
    garde: "correlationAdmise — l'alphabet et la longueur",
    fichier: CONTRAT,
    avant: "  return CORRELATION_ADMISE.test(valeur) ? valeur : null;\n",
    apres: "  return valeur;\n",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "un type refusé est rendu TRONQUÉ, jamais entier",
    garde: "typeRendu — la borne de ce qui repart",
    fichier: CONTRAT,
    avant:
      "  return type.length <= TAILLE_MAXIMALE_DU_TYPE_RENDU\n" +
      "    ? type\n" +
      "    : `${type.slice(0, TAILLE_MAXIMALE_DU_TYPE_RENDU)}…`;\n",
    apres: "  return type;\n",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "la coquille ne publie que ses quatre états",
    garde: "chargeUtileDEtat — la table des états connus",
    fichier: ETAT,
    avant:
      "  if (!ETATS_CONNUS.has(etat)) {\n" +
      "    throw new Error(\n" +
      "      `État de volume inconnu : ${etat}. La coquille ne publie que ses quatre états.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_CONTRAT],
  },

  // --- #162 : les gardes du déverrouillage dans la coquille (ADR 0029) --------------------------
  {
    nom: "un corps de message ne recouvre jamais l'identité du contrat",
    garde: "enveloppeDeMessage — `exigerCorpsSansIdentite`, appelée AVANT l'étalement du corps",
    fichier: CONTRAT,
    avant: "  exigerCorpsSansIdentite(corps);\n",
    apres: "",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "une capacité ne franchit le port que sur le canal PRIVILÉGIÉ",
    garde: "enveloppePrivilegiee — la vérification du canal, contrôlée la première",
    fichier: CONTRAT,
    avant:
      "  if (!estTypePrivilegie(type)) {\n" +
      "    throw new Error(\n" +
      "      `« ${type} » n'est pas un type du canal privilégié : seul celui-ci peut porter une capacité.`,\n" +
      "    );\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "une KEK EXTRACTIBLE ne franchit aucun port",
    garde: "exigerKekOpaque — la vérification de `extractable`",
    fichier: CONTRAT,
    avant:
      "  if (kek.extractable !== false) {\n" +
      '    throw refusDeCapacite("une CryptoKey EXTRACTIBLE, dont les octets se relisent");\n' +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "la somme de contrôle est vérifiée AVANT que la saisie ne devienne envoyable",
    garde: "etatDeLaSaisie — le contrôle en direct, qui garde le Worker d'un code mal recopié",
    fichier: SAISIE,
    avant:
      "  if (!sommeDeControleValide(symboles)) return sommeFausse(symboles.length, decoupe);\n",
    apres: "",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "une saisie plus longue que le code est refusée, jamais tronquée",
    garde: "etatDeLaSaisie — la borne HAUTE du nombre de symboles",
    fichier: SAISIE,
    avant:
      "  if (symboles.length > SYMBOLES_TOTAL) return saisieTropLongue(symboles.length, decoupe);\n",
    apres: "",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "un signe hors de l'alphabet ferme l'envoi",
    garde: "etatDeLaSaisie — le refus du premier signe que la table close ne connaît pas",
    fichier: SAISIE,
    avant:
      "  if (signeRefuse !== null) return refusDUnSigne(symboles.length, decoupe, signeRefuse);\n",
    apres: "",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "SEULE la phrase annonce une attente",
    garde: "annonceDAttente — la liste CLOSE des moyens qui annoncent",
    fichier: ATTENTE,
    avant: "  if (!MOYENS_ANNONCES.includes(moyen)) return null;\n",
    apres: "",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "un moteur inconnu retombe sur le PLUS LENT, jamais sur le plus rapide",
    garde: "annonceDAttente — le repli sur `MOTEUR_PAR_DEFAUT`",
    fichier: ATTENTE,
    avant: "  const mesure = ATTENTE_MESUREE[moteur] ?? ATTENTE_MESUREE[MOTEUR_PAR_DEFAUT];\n",
    apres: "  const mesure = ATTENTE_MESUREE[moteur] ?? ATTENTE_MESUREE.chromium;\n",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "l'annonce retient le p95 le plus HAUT, jamais une médiane",
    garde: "annonceDAttente — le choix du quantile annoncé",
    fichier: ATTENTE,
    avant: "  const attenteMs = Math.max(...mesure.p95Ms);\n",
    apres: "  const attenteMs = Math.max(...mesure.p50Ms);\n",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "une feuille de récupération porte une VERSION, ou n'existe pas",
    garde: "feuilleDeRecuperation — la vérification de la version d'enveloppe",
    fichier: FEUILLE,
    avant:
      "  if (!Number.isInteger(version) || version < 1) {\n" +
      `    throw new Error("Une feuille de récupération porte une version d'enveloppe entière et ≥ 1.");\n` +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "un champ de version VIDE rend l'AVEU, jamais un silence",
    garde: "ancreSaisie — le cas du champ vide, qui n'est pas une erreur mais un CHOIX",
    fichier: INTERFACE,
    avant: '  if (brut === "") return { version: null, valide: true, aveu: AVEU_SANS_ANCRE };\n',
    apres: '  if (brut === "") return { version: null, valide: true, aveu: "" };\n',
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "une version qui n'est pas un entier est REFUSÉE, jamais corrigée",
    garde: "ancreSaisie — le motif de l'ancre, et sa borne basse",
    fichier: INTERFACE,
    avant: "  if (!/^\\d{1,15}$/.test(brut) || Number(brut) < 1) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "un type d'emplacement INCONNU est dit, jamais confondu avec un moyen servi",
    garde: "moyensProposes — la branche des types que le catalogue ne sert pas",
    fichier: MOYENS,
    avant: "    if (servi === undefined) {\n",
    apres: "    if (servi === undefined && false) {\n",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "un moyen inconnu n'est jamais servi par approximation",
    garde: "moyenParNom — l'égalité stricte du nom, et son `null`",
    fichier: MOYENS,
    avant: "  return Object.values(MOYENS_SERVIS).find((moyen) => moyen.nom === nom) ?? null;\n",
    apres:
      "  return (\n" +
      "    Object.values(MOYENS_SERVIS).find((moyen) => moyen.nom === nom) ??\n" +
      "    Object.values(MOYENS_SERVIS)[0]\n" +
      "  );\n",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "une KEK qui ARRIVE au Worker de confiance est une CryptoKey",
    garde: "exigerKekDeLaPage — la moitié ARRIVANTE de la dérogation à `sansCapacite`",
    fichier: MOYENS,
    avant:
      '  if (kek?.constructor?.name !== "CryptoKey") {\n' +
      "    throw refusDeLaKek(`ce n'est pas une CryptoKey (${kek?.constructor?.name ?? typeof kek})`);\n" +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "une KEK qui ARRIVE n'est jamais EXTRACTIBLE",
    garde: "exigerKekDeLaPage — la seconde condition, qui se manque autrement que la première",
    fichier: MOYENS,
    avant:
      "  if (kek.extractable !== false) {\n" +
      '    throw refusDeLaKek("cette CryptoKey est EXTRACTIBLE : ses octets se relisent");\n' +
      "  }\n",
    apres: "",
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  {
    nom: "les réponses APPARIÉES sont dérivées de la table, jamais recopiées",
    garde: "REPONSES_PRIVILEGIEES — le filtre qui les nomme",
    fichier: CONTRAT,
    avant:
      '      .filter(([nom]) => nom.endsWith("Reponse") || nom === "recuperationRendue" || nom === "refus")\n',
    apres: '      .filter(([nom]) => nom.endsWith("Reponse"))\n',
    epreuves: [EPREUVE_DEVERROUILLAGE],
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
    campagneDeMutation({ mutations: MUTATIONS, etiquette: "coquille" }),
    process.argv.includes("--json"),
  );
  process.exitCode = resultats.every(({ tue }) => tue) ? 0 : 1;
}
