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

import { MUTATIONS_DE_LA_REVOCATION } from "./mutants-de-la-revocation.mjs";
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

/** Les gardes de #192 (ADR 0038) : les décisions du relais HTTP, pures elles aussi. */
const RELAIS = "src/coquille/relais-http.mjs";
const REFUS = "src/coquille/refus-de-coquille.mjs";
const ROUTAGE = "src/coquille/routage-du-cadre.mjs";
const RELAIS_DU_WORKER = "public/relais-du-worker.mjs";

const EPREUVE_ADMISSION = "tests/unit/coquille-admission.test.mjs";
const EPREUVE_CONTRAT = "tests/unit/coquille-contrat.test.mjs";
const EPREUVE_DEVERROUILLAGE = "tests/unit/coquille-deverrouillage.test.mjs";
const EPREUVE_RELAIS = "tests/unit/coquille-relais-http.test.mjs";
const EPREUVE_ROUTAGE = "tests/unit/coquille-routage-du-cadre.test.mjs";
const EPREUVE_RELAIS_DU_WORKER = "tests/unit/coquille-relais-du-worker.test.mjs";

/** Les gardes de #207 (ADR 0039) : sauvegarder, restaurer, révoquer depuis la coquille. */
const PORTABILITE = "src/coquille/portabilite-du-coffre.mjs";
const EPREUVE_PORTABILITE = "tests/unit/coquille-portabilite.test.mjs";
const EPREUVE_PORTABILITE_DU_WORKER = "tests/unit/coquille-portabilite-du-worker.test.mjs";
const EPREUVE_IDENTITE = "tests/unit/coquille-identite-du-coffre.test.mjs";
const PARCOURS = "src/coquille/parcours.mjs";
const EPREUVE_PARCOURS = "tests/unit/coquille-parcours.test.mjs";
const OUVERTURE_PAR_LE_CODE = "src/coquille/ouverture-par-le-code.mjs";
const EPREUVE_OUVERTURE_PAR_LE_CODE = "tests/unit/coquille-ouverture-par-le-code.test.mjs";
const EPREUVE_PARCOURS_CONDUITES = "tests/unit/coquille-parcours-conduites.test.mjs";
const PREUVE = "src/coquille/preuve-de-la-feuille.mjs";
const EPREUVE_PREUVE = "tests/unit/coquille-preuve-de-la-feuille.test.mjs";
const DEVERROUILLAGE = "public/runtime-worker-deverrouillage.mjs";
const OPFS_SYNC = "src/vm/opfs-sync-access.mjs";
const EPREUVE_GETDIRECTORY = "tests/unit/vm-opfs-getdirectory-refuse.test.mjs";
const EPREUVE_WORKER_SONDE = "tests/unit/coquille-worker-sonde-opfs.test.mjs";
const RUNTIME_WORKER = "public/runtime-worker.mjs";
const SONDE_DU_STOCKAGE = "src/vm/sonde-du-stockage.mjs";
const CAPACITE = "src/coquille/capacite-du-stockage.mjs";
const CAPACITE_DU_WORKER = "public/capacite-du-worker.mjs";
const EPREUVE_CAPACITE = "tests/unit/coquille-capacite-du-stockage.test.mjs";
const EPREUVE_SONDE = "tests/unit/vm-sonde-du-stockage.test.mjs";
const RACINE_OPFS = "public/spike/origin/racine-opfs.mjs";
const TEMOINS_OPFS = "tests/support/temoins-opfs.mjs";
const EPREUVE_TEMOINS = "tests/unit/temoins-opfs.test.mjs";
const EPREUVE_INTERFACE_INVENTAIRE = "tests/unit/coquille-interface-inventaire-refuse.test.mjs";
const REVALIDATION = "src/coquille/revalidation-sous-le-handle.mjs";
const OUVERTURE_DU_VOLUME = "src/vm/opfs-volume-ouverture.mjs";
const EPREUVE_REVALIDATION = "tests/unit/coquille-revalidation-sous-le-handle.test.mjs";
const EPREUVE_WORKER_DEVERROUILLAGE = "tests/unit/coquille-worker-deverrouillage.test.mjs";
const EPREUVE_COURSE_PORTABILITE = "tests/unit/coquille-portabilite-course.test.mjs";
const PORTABILITE_DU_WORKER = "public/portabilite-du-worker.mjs";
const EPREUVE_SOUS_LE_HANDLE = "tests/unit/vm-ouverture-sous-le-handle.test.mjs";

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
    garde: "refusDuType — la consultation de la liste de refus, en premier",
    fichier: ADMISSION,
    avant: "  if (REFUSES.has(type)) return REFUSES.get(type);\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "un type du canal privilégié n'est pas servi sur le port restreint",
    garde: "refusDuType — la reconnaissance des types privilégiés",
    fichier: ADMISSION,
    avant: "  if (estTypePrivilegie(type)) return CODES_REFUS_COQUILLE.portPrivilegie;\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "le canal de RELAIS n'est pas atteignable depuis le port restreint",
    garde: "refusDuType — la reconnaissance des types du canal de relais (#192)",
    fichier: ADMISSION,
    avant: "  if (estTypeDeRelais(type)) return CODES_REFUS_COQUILLE.canalDeRelaisRefuse;\n",
    apres: "",
    epreuves: [EPREUVE_ADMISSION],
  },
  {
    nom: "la liste d'admission est une LISTE, pas un accueil",
    garde: "refusDuType — le filtre `REQUETES_ADMISES`",
    fichier: ADMISSION,
    avant: "  if (!REQUETES_ADMISES.has(type)) return CODES_REFUS_COQUILLE.typeInconnu;\n",
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
    garde: "cheminSansDetour — le refus d'un segment VIDE, donc de `//` n'importe où (#203)",
    fichier: ORIGINES,
    avant: '    if (segment === "" && rang !== segments.length - 1) return null;\n',
    apres: "",
    epreuves: [EPREUVE_ADMISSION, EPREUVE_RELAIS],
  },
  {
    nom: "un chemin qui REMONTE se normalise ailleurs, et n'est pas un chemin",
    garde:
      "cheminSansDetour — le refus des segments `.` et `..` (revue de sécurité #203, constat 4)",
    fichier: ORIGINES,
    avant: '    if (segment === "." || segment === "..") return null;\n',
    apres: "",
    epreuves: [EPREUVE_RELAIS],
  },
  {
    nom: "un détour ENCODÉ reste un détour",
    garde: "cheminSansDetour — le refus de `%2F`, `%5C` et `%2E` dans le chemin",
    fichier: ORIGINES,
    avant: "  if (ENCODAGES_DE_DETOUR.test(chemin)) return null;\n",
    apres: "",
    epreuves: [EPREUVE_RELAIS],
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
    garde: "refusDuType — le contrôle de forme exacte, jugé en dernier",
    fichier: ADMISSION,
    avant: "  if (!formeExacte(message)) return CODES_REFUS_COQUILLE.messageMalforme;\n",
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
    nom: "la coquille ne publie que ses cinq états",
    garde: "chargeUtileDEtat — la table des états connus",
    fichier: ETAT,
    avant:
      "  if (!ETATS_CONNUS.has(etat)) {\n" +
      "    throw new Error(`État de volume inconnu : ${etat}. La coquille ne publie que ses cinq états.`);\n" +
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
  // --- Les gardes du RELAIS HTTP (#192, ADR 0038) ------------------------------------------------
  //
  // Elles sont dans `src/coquille/relais-http.mjs` pour le motif exact des précédentes : ce sont
  // des fonctions PURES, que le Worker, la coquille et le Service Worker se contentent d'appeler.
  // Une garde écrite dans le Worker ne serait éprouvable que par un navigateur.
  {
    nom: "le cookie de session ne franchit JAMAIS la frontière",
    garde: "ENTETES_DE_REPONSE_RENDUES — la liste qui ne nomme pas `set-cookie`",
    fichier: RELAIS,
    avant: '  "content-type",\n  "content-language",\n',
    apres: '  "content-type",\n  "set-cookie",\n  "content-language",\n',
    epreuves: [EPREUVE_RELAIS],
  },
  {
    nom: "une `Location` absolue ne rend jamais l'hôte du guest",
    garde: "emplacementRendu — la comparaison d'origine, puis le chemin seul",
    fichier: RELAIS,
    avant: "  if (url.origin !== new URL(baseDuGuest).origin) return null;\n",
    apres: "",
    epreuves: [EPREUVE_RELAIS],
  },
  {
    nom: "seules TROIS méthodes sont relayées",
    garde: "METHODES_RELAYEES — la liste close",
    fichier: RELAIS,
    avant: 'export const METHODES_RELAYEES = Object.freeze(["GET", "POST", "HEAD"]);',
    apres:
      'export const METHODES_RELAYEES = Object.freeze(["GET", "POST", "HEAD", "PUT", "PATCH", "DELETE"]);',
    epreuves: [EPREUVE_RELAIS],
  },
  {
    nom: "le document ne choisit que TROIS en-têtes de requête",
    garde: "entetesDeRequeteRelayees — le filtre par la liste d'admission",
    fichier: RELAIS,
    avant: "    if (!ENTETES_DE_REQUETE_RELAYEES.includes(minuscule)) continue;\n",
    apres: "",
    epreuves: [EPREUVE_RELAIS],
  },
  {
    nom: "aucun caractère de contrôle ne franchit dans un chemin",
    garde: "cheminSansDetour — le refus d'une seconde ligne de requête HTTP, espace comprise",
    fichier: ORIGINES,
    avant: "    if (code <= 0x20 || code === 0x7f) return null;\n",
    apres: "",
    epreuves: [EPREUVE_RELAIS],
  },
  {
    nom: "une `Location` qui se normalise en `//…` n'est pas rendue",
    garde: "emplacementRendu — le chemin NORMALISÉ rejugé (revue de sécurité #203, constat 4)",
    fichier: RELAIS,
    avant: "  if (cheminSansDetour(`${url.pathname}${url.search}`) === null) return null;\n",
    apres: "",
    epreuves: [EPREUVE_RELAIS],
  },
  {
    nom: "un corps que le décodeur refuserait est refusé AVANT l'admission",
    garde: "BASE64_ADMIS — le base64 canonique, pas seulement son alphabet (#203, constat 3)",
    fichier: RELAIS,
    avant:
      "const BASE64_ADMIS = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;",
    apres: "const BASE64_ADMIS = /^[A-Za-z0-9+/]*={0,2}$/;",
    epreuves: [EPREUVE_RELAIS],
  },
  {
    nom: "un refus construit depuis une erreur étrangère ne jette jamais",
    garde: "codeDeRefusAdmis — l'ensemble CLOS des codes (revue de sécurité #203, constats 3 et 9)",
    fichier: REFUS,
    avant:
      '  return typeof code === "string" && Object.hasOwn(MESSAGES, code)\n' +
      "    ? code\n" +
      "    : CODES_REFUS_COQUILLE.gesteRompu;\n",
    apres: "  return code;\n",
    epreuves: [EPREUVE_RELAIS],
  },
  {
    nom: "une valeur d'en-tête de réponse à caractère de contrôle n'est pas rendue",
    garde: "entetesDeReponseRendues — le refus que `Headers` aurait JETÉ (#203, constat 11)",
    fichier: RELAIS,
    avant: "    if (porteUnCaractereDeControle(valeur)) continue;\n",
    apres: "",
    epreuves: [EPREUVE_RELAIS],
  },
  {
    nom: "un corps sur une méthode qui n'en porte pas est refusé",
    garde: "evaluerRequeteRelayee — la cohérence entre la méthode et le corps",
    fichier: RELAIS,
    avant: '    if (methode === "GET" || methode === "HEAD") return { ok: false };\n',
    apres: "",
    epreuves: [EPREUVE_RELAIS],
  },
  // --- Le ROUTAGE du Service Worker (revue de sécurité de la PR #203, constats 1 et 2) ------------
  {
    nom: "le Service Worker ne prend jamais le PREMIER courtier venu",
    garde: "routerLaRequete — le refus d'une navigation quand plusieurs courtiers sont joignables",
    fichier: ROUTAGE,
    avant: "  if (courtiers.length + incertains > 1) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_ROUTAGE],
  },
  {
    nom: "un document SANS port n'est pas un courtier",
    garde: "routerLaRequete — seul un candidat qui dit détenir un port est un courtier",
    fichier: ROUTAGE,
    avant:
      "  const courtiers = presences.filter((presence) => presence.porte === true).map(({ id }) => id);\n",
    apres: "  const courtiers = presences.map(({ id }) => id);\n",
    epreuves: [EPREUVE_ROUTAGE],
  },
  {
    nom: "une sous-ressource est servie par le courtier de SON client, et nul autre",
    garde: "routerLaRequete — la liaison client → courtier",
    fichier: ROUTAGE,
    avant: "      return { issue: ISSUES_DU_ROUTAGE.relayer, courtier: lie };\n",
    apres: "      return { issue: ISSUES_DU_ROUTAGE.relayer, courtier: courtiers[0] };\n",
    epreuves: [EPREUVE_ROUTAGE],
  },
  {
    nom: "un client sans liaison n'emprunte pas le courtier d'un autre coffre",
    garde: "routerLaRequete — l'exigence d'une liaison avant de relayer une sous-ressource",
    fichier: ROUTAGE,
    avant: "    if (lie !== undefined && courtiers.includes(lie)) {\n",
    apres: "    if (courtiers.length > 0) {\n",
    epreuves: [EPREUVE_ROUTAGE],
  },
  {
    nom: "une navigation de premier rang n'est jamais relayée",
    garde: "routerLaRequete — le filtre sur la destination `iframe`",
    fichier: ROUTAGE,
    avant: '  if (destination !== "iframe") return { issue: ISSUES_DU_ROUTAGE.reseau };\n',
    apres: "",
    epreuves: [EPREUVE_ROUTAGE],
  },
  // --- Le relais côté WORKER DE CONFIANCE (revues de la PR #203 : sécurité 3, intégration 7) ------
  //
  // `public/relais-du-worker.mjs` n'est pas une fonction pure, mais son épreuve le charge TEL QUEL
  // sous Node, avec un port et une session doubles : ses gardes se mutent donc comme les autres.
  {
    nom: "un refus du Worker ne JETTE jamais sur un code étranger",
    garde: "refuser — le code réduit à l'ensemble clos avant d'être posté",
    fichier: RELAIS_DU_WORKER,
    avant: "    const code = codeDeRefusAdmis(codeRecu);\n",
    apres: "    const code = codeRecu;\n",
    epreuves: [EPREUVE_RELAIS_DU_WORKER],
  },
  {
    nom: "une réponse au-delà du plafond est refusée entière",
    garde: "relayer — le plafond du corps de RÉPONSE",
    fichier: RELAIS_DU_WORKER,
    avant: "    if (reponse.corps.byteLength > PLAFOND_CORPS_DE_REPONSE_OCTETS) {\n",
    apres: "    if (false) {\n",
    epreuves: [EPREUVE_RELAIS_DU_WORKER],
  },
  {
    nom: "une rafale au-delà de la borne en vol n'atteint pas le guest",
    garde: "relayer — la borne `RELAIS_EN_VOL_MAXIMUM`",
    fichier: RELAIS_DU_WORKER,
    avant: "    if (enVol >= RELAIS_EN_VOL_MAXIMUM) {\n",
    apres: "    if (false) {\n",
    epreuves: [EPREUVE_RELAIS_DU_WORKER],
  },
  {
    nom: "une réponse arrivée après le verrouillage n'est jamais rendue",
    garde: "relaisAbandonne — le relais retiré suffit, sans attendre la mort du Worker (#203, 6)",
    fichier: RELAIS,
    avant: "  return abandonne === true || workerMort === true;\n",
    apres: "  return workerMort === true;\n",
    epreuves: [EPREUVE_RELAIS],
  },
  // --- L'ATTENTE du démarrage et le BATTEMENT pendant l'installation (revue d'intégration #203, 1) --
  {
    nom: "pendant un boot, le cadre ne pose aucune requête sur le port restreint",
    garde: "brancherLeCourtier — la réponse « en attente » tant que l'application ne tourne pas",
    fichier: "public/cadre/courtier-du-cadre.mjs",
    avant: "    if (application === APPLICATION.enAttente) {\n",
    apres: "    if (false) {\n",
    epreuves: ["tests/unit/coquille-courtier-du-cadre.test.mjs"],
  },
  {
    nom: "le versement d'un disque rend la main au Worker, et son battement ne se tait pas",
    garde: "verserFluxDansVolume — la cession entre deux tranches d'écriture",
    fichier: "src/vm/versement-de-disque.mjs",
    avant: "      await cederLaMain();\n",
    apres: "",
    epreuves: ["tests/unit/vm-ceder-la-main.test.mjs"],
  },
  // --- SAUVEGARDER, RESTAURER, RÉVOQUER depuis la coquille (#207, ADR 0039) ----------------------
  {
    nom: "le volume application naît sous l'identité que l'enveloppe authentifie",
    garde: "verserLeDisque — l'identité du coffre déclarée à la naissance",
    fichier: "src/coquille/application-de-reference.mjs",
    avant: "      identifiantVolume: IDENTIFIANT_DU_COFFRE,\n",
    apres: "",
    epreuves: [EPREUVE_IDENTITE],
  },
  {
    nom: "un coffre antérieur est reconnu à l'en-tête de son volume coquille",
    garde: "constaterLEmplacement — l'identité du coffre dans le volume coquille",
    fichier: PORTABILITE,
    avant: "  if (coquille && (await volumeCoquilleAnterieur(lireEnTete)))\n",
    apres: "  if (false)\n",
    epreuves: [EPREUVE_PORTABILITE],
  },
  {
    nom: "un disque d'un autre coffre est reconnu au manifeste qu'il porte",
    garde: "constaterLEmplacement — le volume déclaré par le manifeste applicatif",
    fichier: PORTABILITE,
    avant: "  if (manifeste !== null && !declareLeVolumeDuCoffre(manifeste)) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_PORTABILITE],
  },
  {
    nom: "le volume du coffre se juge à son identifiant",
    garde: "declareLeVolumeDuCoffre — l'identifiant (revue #208, constat 5)",
    fichier: PORTABILITE,
    avant: "    manifeste?.volume?.id === IDENTIFIANT_DU_COFFRE &&\n",
    apres: "",
    epreuves: [EPREUVE_PORTABILITE, EPREUVE_PORTABILITE_DU_WORKER],
  },
  {
    nom: "le volume du coffre se juge à son format",
    garde: "declareLeVolumeDuCoffre — le format courant (revue #208, constat 5)",
    fichier: PORTABILITE,
    avant:
      "    manifeste?.volume?.id === IDENTIFIANT_DU_COFFRE &&\n    manifeste.formatVersion === FORMAT_VOLUME_COURANT\n",
    apres: "    manifeste?.volume?.id === IDENTIFIANT_DU_COFFRE\n",
    epreuves: [EPREUVE_PORTABILITE],
  },
  {
    nom: "le Worker refuse une archive d'un autre coffre AVANT toute écriture",
    garde: "restaurer — le refus d'identité sur l'en-tête (revue #208, constat 5)",
    fichier: "public/portabilite-du-worker.mjs",
    avant:
      "  if (tete.lisible && !tete.duCoffre) throw refus(CODES_REFUS_COQUILLE.archiveDUnAutreCoffre);\n",
    apres: "",
    epreuves: [EPREUVE_PORTABILITE_DU_WORKER],
  },
  {
    nom: "une installation coupée n'est jamais prise pour une restauration coupée",
    garde: "enveloppeRestaureeIntacte — le domaine `recuperation` de la page",
    fichier: PORTABILITE,
    avant: "  return lue.valide && lue.page.domaine === OCTET_DOMAINE_RECUPERATION;\n",
    apres: "  return lue.valide;\n",
    epreuves: [EPREUVE_PORTABILITE],
  },
  {
    nom: "on ne restaure jamais par-dessus un coffre",
    garde: "decisionDeRestauration — seul l'emplacement vide se restaure sans réparer",
    fichier: PORTABILITE,
    avant: "  if (etat === ETATS_DE_L_EMPLACEMENT.vide) return { code: null, reparer: false };\n",
    apres: "  if (true) return { code: null, reparer: false };\n",
    epreuves: [EPREUVE_PORTABILITE, EPREUVE_PORTABILITE_DU_WORKER],
  },
  {
    nom: "un geste de portabilité pendant un geste long est refusé, pas mis en file",
    garde: "refusPendantUnGesteLong — le compte des gestes longs",
    fichier: PORTABILITE,
    avant: "  return gestesLongsEnCours > 0 ? CODES_REFUS_COQUILLE.gesteEnCours : null;\n",
    apres: "  return null;\n",
    epreuves: [EPREUVE_PORTABILITE, EPREUVE_PORTABILITE_DU_WORKER],
  },
  {
    nom: "une archive qui ne déclare aucune récupération est reconnue avant d'écrire",
    garde: "enTeteDArchive — `recovery: null`",
    fichier: PORTABILITE,
    avant: "      emporteUneRecuperation: entete.recovery !== null,\n",
    apres: "      emporteUneRecuperation: true,\n",
    epreuves: [EPREUVE_PORTABILITE, EPREUVE_PORTABILITE_DU_WORKER],
  },
  {
    nom: "le Worker refuse une archive sans récupération AVANT toute écriture",
    garde: "restaurer — le refus anticipé sur l'en-tête",
    fichier: "public/portabilite-du-worker.mjs",
    avant: "  if (tete.lisible && !tete.emporteUneRecuperation) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_PORTABILITE_DU_WORKER],
  },
  {
    nom: "la réparation retire l'enveloppe avant le disque, jamais l'inverse",
    garde: "restaurer — l'ordre des retraits de la réparation (revue #208, constat 3)",
    fichier: "public/portabilite-du-worker.mjs",
    avant:
      "      for (const voisin of voisinsDunVolume(VOLUME_DE_LA_COQUILLE)) await prim.retirer(voisin);\n" +
      "      await prim.viderLeVolume(verrou);\n" +
      "      await prim.retirer(NOM_DU_VOLUME_APPLICATIF);\n",
    apres:
      "      await prim.retirer(NOM_DU_VOLUME_APPLICATIF);\n" +
      "      for (const voisin of voisinsDunVolume(VOLUME_DE_LA_COQUILLE)) await prim.retirer(voisin);\n" +
      "      await prim.viderLeVolume(verrou);\n",
    epreuves: [EPREUVE_PORTABILITE_DU_WORKER],
  },
  {
    nom: "la copie de sauvegarde est retirée quand le geste aboutit",
    garde: "ecrireSansLaisserDeCopie — le retrait après succès (revue #208, constat 4)",
    fichier: "public/portabilite-du-worker.mjs",
    avant: "  await prim.retirer(FICHIER_DE_SAUVEGARDE);\n  return rendu;\n",
    apres: "  return rendu;\n",
    epreuves: [EPREUVE_PORTABILITE_DU_WORKER],
  },
  {
    nom: "la copie de sauvegarde est retirée quand le geste échoue",
    garde: "ecrireSansLaisserDeCopie — le retrait après échec (revue #208, constat 4)",
    fichier: "public/portabilite-du-worker.mjs",
    avant: "    await prim.retirer(FICHIER_DE_SAUVEGARDE).catch(() => false);\n",
    apres: "",
    epreuves: [EPREUVE_PORTABILITE_DU_WORKER],
  },
  {
    nom: "la révocation d'urgence retire une copie de sauvegarde résiduelle",
    garde: "revoquer — le retrait du résidu avant l'acquittement (revue #208, constat 4)",
    fichier: "public/portabilite-du-worker.mjs",
    avant: "  if (copieDeSauvegardeRetiree) await prim.retirer(FICHIER_DE_SAUVEGARDE);\n",
    apres: "",
    epreuves: [EPREUVE_PORTABILITE_DU_WORKER],
  },
  {
    nom: "un coffre qui a servi n'est jamais pris pour une restauration coupée",
    garde: "constaterLEmplacement — la trace de service (revue #208, constat 6)",
    fichier: PORTABILITE,
    avant: "  if (disque && (await aServiDepuisLaRestauration(observer, coquille))) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_PORTABILITE, EPREUVE_PORTABILITE_DU_WORKER],
  },
  {
    nom: "le volume coquille né au déverrouillage est une trace de service",
    garde: "aServiDepuisLaRestauration — le volume coquille (revue #208, constat 6)",
    fichier: PORTABILITE,
    avant: "  if (coquille) return true;\n",
    apres: "",
    epreuves: [EPREUVE_PORTABILITE],
  },
  {
    nom: "le journal de génération du disque est une trace de service",
    garde: "TRACES_DE_SERVICE — le journal de génération (revue #208, constat 6)",
    fichier: PORTABILITE,
    avant: "  generationJournalName(NOM_DU_VOLUME_APPLICATIF),\n",
    apres: "",
    epreuves: [EPREUVE_PORTABILITE],
  },
  {
    nom: "le témoin du disque est une trace de service",
    garde: "TRACES_DE_SERVICE — le témoin (revue #208, constat 6)",
    fichier: PORTABILITE,
    avant: "  temoinSequenceName(NOM_DU_VOLUME_APPLICATIF),\n",
    apres: "",
    epreuves: [EPREUVE_PORTABILITE],
  },
  {
    nom: "la cible du coffre refuse une archive sans enveloppe",
    garde: "cibleDuCoffre — `commitRecoveryEnvelope(null)`",
    fichier: PORTABILITE,
    avant: "      if (octets === null) {\n",
    apres: "      if (false) {\n",
    epreuves: [EPREUVE_PORTABILITE],
  },
  {
    nom: "une archive ne franchit le canal privilégié que sur ses deux types",
    garde: "exigerArchiveAdmise — les types porteurs d'archive",
    fichier: CONTRAT,
    avant: "  if (!TYPES_PORTEURS_D_ARCHIVE.has(type)) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_PORTABILITE],
  },
  {
    nom: "le champ d'archive ne porte qu'un File ou un Blob",
    garde: "exigerArchiveAdmise — la nature de la valeur",
    fichier: CONTRAT,
    avant: "  if (!estUneArchive(archive)) {\n",
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_PORTABILITE],
  },
  {
    nom: "une archive se juge à ce qu'elle EST, pas au nom de son constructeur",
    garde: "estUneArchive — `instanceof Blob` (revue #208, constat 8)",
    fichier: CONTRAT,
    avant: '  return typeof Blob === "function" && valeur instanceof Blob;\n',
    apres:
      '  return valeur?.constructor?.name === "File" || valeur?.constructor?.name === "Blob";\n',
    epreuves: [EPREUVE_PORTABILITE],
  },
  {
    nom: "le Worker ne lit jamais un objet déguisé en archive",
    garde: "restaurer — la nature de l'archive reçue (revue #208, constat 8)",
    fichier: "public/portabilite-du-worker.mjs",
    avant: "  if (!estUneArchive(archive)) throw refus(CODES_REFUS_COQUILLE.messageMalforme);\n",
    apres: "",
    epreuves: [EPREUVE_PORTABILITE_DU_WORKER],
  },
  // --- Le PARCOURS GUIDÉ (#193, ADR 0040) : ses gardes d'ORDRE et sa table des conduites ----------
  {
    nom: "un coffre ouvert sans moyen de récupération ramène toujours à la création du code",
    garde: "ecranOuvert — le premier moyen de récupération se crée à l'étape 3",
    fichier: PARCOURS,
    avant:
      '  if (nombreDeCodes === 0 || (nouveauCodeDemande && !feuilleEprouvee)) return "code-annonce";\n',
    apres: '  if (nouveauCodeDemande && !feuilleEprouvee) return "code-annonce";\n',
    epreuves: [EPREUVE_PARCOURS],
  },
  // #214 : l'ouverture par le code ESSAIE chaque emplacement de type 4, et la coquille les COMPTE.
  {
    nom: "le second code de récupération ouvre le coffre comme le premier",
    garde: "ouvrirParLeCode — tous les emplacements de type 4, et non le premier",
    fichier: OUVERTURE_PAR_LE_CODE,
    avant:
      "  return emplacements.filter((candidat) => candidat.typeKek === TYPES_KEK.recuperation);\n",
    apres:
      "  return emplacements\n" +
      "    .filter((candidat) => candidat.typeKek === TYPES_KEK.recuperation)\n" +
      "    .slice(0, 1);\n",
    epreuves: [EPREUVE_OUVERTURE_PAR_LE_CODE],
  },
  {
    nom: "le coût d'une ouverture par code ne désigne pas la feuille employée",
    garde: "ouvrirParLeCode — l'absence de court-circuit après un succès",
    fichier: OUVERTURE_PAR_LE_CODE,
    avant:
      "      if (ouverte === null) {\n" +
      "        ouverte = Object.freeze({ ...essai, kek });\n" +
      "        kek = null;\n" +
      "      } else essai.dek.fill(0);\n",
    apres:
      "      ouverte = Object.freeze({ ...essai, kek });\n" +
      "      kek = null;\n" +
      "      break;\n",
    epreuves: [EPREUVE_OUVERTURE_PAR_LE_CODE],
  },
  // Revue de sécurité de la PR #219 : aucun refus ne sort de la boucle (constats 1 et 2).
  {
    nom: "le coût d'un REJEU ne désigne pas la feuille employée",
    garde: "ouvrirParLeCode — aucun refus levé dans la boucle (revue #219, constat 1)",
    fichier: OUVERTURE_PAR_LE_CODE,
    avant: "    } catch (cause) {\n      retenirLeRefus(refus, cause);\n",
    apres:
      "    } catch (cause) {\n" +
      "      if (!isEnveloppeError(cause, ENVELOPPE_ERROR_CODES.cleRefusee)) throw cause;\n" +
      "      retenirLeRefus(refus, cause);\n",
    epreuves: [EPREUVE_OUVERTURE_PAR_LE_CODE],
  },
  {
    nom: "un emplacement de type 4 illisible ne masque pas le code valable qui le suit",
    garde:
      "ouvrirParLeCode — la dérivation dans le même try que l'ouverture (revue #219, constat 2)",
    fichier: OUVERTURE_PAR_LE_CODE,
    avant:
      "    let kek = null;\n" +
      "    try {\n" +
      "      kek = await derivateur.deriver({\n" +
      "        parametres: emplacement.parametres,\n" +
      "        identite: {\n" +
      "          identifiantVolume,\n" +
      "          identifiantEmplacement: emplacement.identifiantEmplacement,\n" +
      "        },\n" +
      "        geste: { code },\n" +
      "      });\n",
    apres:
      "    let kek = await derivateur.deriver({\n" +
      "      parametres: emplacement.parametres,\n" +
      "      identite: {\n" +
      "        identifiantVolume,\n" +
      "        identifiantEmplacement: emplacement.identifiantEmplacement,\n" +
      "      },\n" +
      "      geste: { code },\n" +
      "    });\n" +
      "    try {\n",
    epreuves: [EPREUVE_OUVERTURE_PAR_LE_CODE],
  },
  {
    nom: "la coquille COMPTE les feuilles au lieu de dire qu'il y en a une",
    garde: "moyensProposes — nombreDeCodes",
    fichier: "src/coquille/moyens-de-deverrouillage.mjs",
    avant:
      "    nombreDeCodes: emplacements.filter(\n" +
      "      (emplacement) => emplacement.typeKek === TYPES_KEK.recuperation,\n" +
      "    ).length,\n",
    apres: '    nombreDeCodes: vus.has("recuperation") ? 1 : 0,\n',
    epreuves: [EPREUVE_DEVERROUILLAGE],
  },
  // Revue de la PR #213 : la progression PERSISTÉE tient l'ordre (constats 1 et 2), le code ne reste
  // pas dans la page (3), les gardes de la page sont des fonctions pures (6, 8, 9), et le cliquet des
  // conduites est construit depuis les tables exportées (4, 5).
  {
    nom: "une étape demandée par l'URL au-delà de la progression est ramenée à l'étape atteinte",
    garde: "etapeAdmise — le minimum entre la demande et l'étape atteinte (constat 2)",
    fichier: PARCOURS,
    avant: "  return Math.min(demandee, progression.etapeAtteinte);\n",
    apres: "  return demandee;\n",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "aucune étape de 4 à 9 tant que la feuille n'est pas ÉPROUVÉE par le Worker (#239)",
    garde: "ecranOuvert — le constat `feuilleEprouvee`, et non l'existence d'un moyen",
    fichier: PARCOURS,
    avant: '  if (!feuilleEprouvee) return "code-a-verifier";\n',
    apres: "",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "l'indice de parcours.json ne remplace pas le constat du Worker (#239, VULN-04)",
    garde: "ecranOuvert — la garde lit le relevé, jamais la progression",
    fichier: PARCOURS,
    avant: '  if (!feuilleEprouvee) return "code-a-verifier";\n',
    apres: '  if (!feuilleEprouvee && !progression.feuilleEprouvee) return "code-a-verifier";\n',
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "un coffre verrouillé sans feuille éprouvée se rouvre par le code, une fois",
    garde: "ecranVerrouille — « Vérifier votre code », jamais un second code (constat 1, #239)",
    fichier: PARCOURS,
    avant:
      '  if (moyens.includes("recuperation") && !progression.feuilleEprouvee && !nouveauCodeDemande) {\n    return "code-verifier";\n  }\n',
    apres: "",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "un coffre neuf n'hérite d'aucune confirmation",
    garde: "progressionApres — la remise à zéro du code à la création du coffre (constat 1)",
    fichier: PARCOURS,
    avant: "    return figerProgression({ ...PROGRESSION_INITIALE, etapeAtteinte: 3 });\n",
    apres: "    return figerProgression({ ...progression, etapeAtteinte: 3 });\n",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "une progression mal formée ne fait sauter aucune étape",
    garde: "lireProgression — la forme exacte, sinon la progression initiale (constat 2)",
    fichier: PARCOURS,
    avant: "  if (!progressionBienFormee(brut)) return PROGRESSION_INITIALE;\n",
    apres: "",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "la progression écrite ne porte que ses champs, jamais le code",
    garde: "ecrireProgression — la recopie champ par champ (constat 1)",
    fichier: PARCOURS,
    avant: "  return JSON.stringify(figerProgression(progression));\n",
    apres: "  return JSON.stringify(progression);\n",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "une ouverture de ROUTINE mène à l'application, pas à l'étape mémorisée (#239)",
    garde: "etapeApres — `rouvrir:ouverture` hors de l'étape 5",
    fichier: PARCOURS,
    avant: '    "rouvrir:ouverture": pointeur === 5 ? 6 : 4,\n',
    apres: '    "rouvrir:ouverture": pointeur === 5 ? 6 : pointeur,\n',
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "une origine restaurée rouverte par le code hors de l'étape 8 revient à l'application (#239)",
    garde: "etapeApres — `recuperer:ouverture`, la cause de « ?etape=4 mène à 9 »",
    fichier: PARCOURS,
    avant: '    "recuperer:ouverture": pointeur === 8 ? 9 : 4,\n',
    apres: '    "recuperer:ouverture": 9,\n',
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "« Continuer » depuis l'application mène à la prochaine étape non jouée (#239)",
    garde: "prochaineEtapeNonJouee — l'étape atteinte, et non 5",
    fichier: PARCOURS,
    avant: "  return Math.min(Math.max(etapeAtteinte, 5), ETAPES.length);\n",
    apres: "  return 5;\n",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "le fichier ne prouve rien du code : ses faits sont remis à l'initiale (17/09, gardé)",
    garde: "lireProgression — `code` relu à l'initiale",
    fichier: PARCOURS,
    avant: "    ...brut,\n    code: PROGRESSION_INITIALE.code,\n",
    apres: "    ...brut,\n",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "seul le booléen vrai du Worker devient l'indice d'une feuille éprouvée (#239)",
    garde: "progressionApres — `feuille`, lu strictement",
    fichier: PARCOURS,
    avant: "    const feuilleEprouvee = valeur === true;\n",
    apres: "    const feuilleEprouvee = Boolean(valeur);\n",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "seul un emplacement de TYPE 4 encore présent éprouve la feuille (#239)",
    garde: "feuilleEprouvee — le filtre des emplacements de récupération",
    fichier: PREUVE,
    avant: "      .filter((emplacement) => emplacement.typeKek === TYPES_KEK.recuperation)\n",
    apres: "",
    epreuves: [EPREUVE_PREUVE],
  },
  {
    nom: "une feuille retirée de l'enveloppe fait tomber la preuve (#239)",
    garde: "feuilleEprouvee — la présence dans l'enveloppe du moment",
    fichier: PREUVE,
    avant: "  return identifiants.some((identifiant) => codes.has(identifiant));\n",
    apres: "  return identifiants.length > 0;\n",
    epreuves: [EPREUVE_PREUVE],
  },
  {
    nom: "un secteur jamais écrit se lit « vierge », jamais comme une preuve ni une erreur (#239)",
    garde: "lireLaPreuve — le secteur de zéros",
    fichier: PREUVE,
    avant: "  if (secteur.every((octet) => octet === 0)) return vide(ETATS_DE_LA_PREUVE.vierge);\n",
    apres: "",
    epreuves: [EPREUVE_PREUVE],
  },
  {
    nom: "« J'ai oublié ma phrase » montre le code sans déplacer la visite (QA de #244)",
    garde: "ecranVerrouille — la phrase perdue, hors de l'étape 8",
    fichier: PARCOURS,
    avant: '  if (pointeur === 8 || phrasePerdue) return "recuperer";\n',
    apres: '  if (pointeur === 8) return "recuperer";\n',
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "l'étape 9 est facultative : « Terminer sans révoquer » (décision du 19/09)",
    garde: "ecranOuvert — la fin de visite sans révocation",
    fichier: PARCOURS,
    avant:
      '    9: revocationFaite ? "termine" : sansRevoquer ? "termine-sans-revoquer" : "revoquer",\n',
    apres: '    9: revocationFaite ? "termine" : "revoquer",\n',
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "« Où suis-je ? » ne dit rien « en cours » ni « à venir » après la visite (QA de #244)",
    garde: "ouSuisJe — la visite finie",
    fichier: PARCOURS,
    avant: "  const courante = finie ? 0 : (ECRANS[ecranId]?.etape ?? 0);\n",
    apres: "  const courante = ECRANS[ecranId]?.etape ?? 0;\n",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "hors de la visite, un titre ne porte pas de numéro d'étape (QA de #244)",
    garde: "rangAffiche — rouvrir et récupérer hors de leur exercice",
    fichier: PARCOURS,
    avant:
      '  if ((ecranId === "rouvrir" || ecranId === "recuperer") && pointeur !== rang) return null;\n',
    apres: "",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "une feuille qui vient d'ouvrir abandonne la demande de nouveau code (contre-recette de #244)",
    garde: "ecranOuvert — `nouveauCodeDemande` sans preuve seulement",
    fichier: PARCOURS,
    avant:
      '  if (nombreDeCodes === 0 || (nouveauCodeDemande && !feuilleEprouvee)) return "code-annonce";\n',
    apres: '  if (nombreDeCodes === 0 || nouveauCodeDemande) return "code-annonce";\n',
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "l'inscription garde les identifiants déjà éprouvés (revue de sécurité de la PR #244)",
    garde: "constaterALOuverture — inscrire sur la liste LUE, jamais sur une liste vide",
    fichier: PREUVE,
    avant:
      "    const identifiants = await inscrireLaPreuve(backend, lue.identifiants, identifiant);\n",
    apres: "    const identifiants = await inscrireLaPreuve(backend, [], identifiant);\n",
    epreuves: [EPREUVE_PREUVE],
  },
  {
    nom: "une inscription qui échoue rend son erreur, jamais un silence (revue de la PR #244)",
    garde: "constaterALOuverture — l'erreur rendue au Worker, qui la publie",
    fichier: PREUVE,
    avant: "    return Object.freeze({ identifiants: lue.identifiants, erreur });\n",
    apres: "    return Object.freeze({ identifiants: lue.identifiants, erreur: null });\n",
    epreuves: [EPREUVE_PREUVE],
  },
  {
    nom: "le Worker n'inscrit la preuve qu'APRÈS l'ouverture du volume (#239)",
    garde: "deverrouiller — l'ordre ouvrir, constater, barrière",
    fichier: DEVERROUILLAGE,
    avant: "    await ouvrirLeVolume(ouverte);\n",
    apres:
      "    interne.eprouves = await constaterALOuverture(interne.backend, ouverte.identifiantEprouve);\n    await ouvrirLeVolume(ouverte);\n",
    epreuves: [EPREUVE_PREUVE],
  },
  {
    nom: "seul un CODE éprouve une feuille, jamais une phrase ni une passkey (#239)",
    garde: "ouvrirLExistante — `identifiantEprouve` nul hors du code",
    fichier: DEVERROUILLAGE,
    avant:
      '    identifiantEprouve: moyen.derivePar === "page" ? null : ouverte.identifiantEmplacement,\n',
    apres: "    identifiantEprouve: ouverte.identifiantEmplacement,\n",
    epreuves: [EPREUVE_PREUVE],
  },
  {
    nom: "seul le booléen true d'une réponse vaut preuve ; l'inconnu est refusé (#239)",
    garde: "feuilleEprouveeDuMessage — l'égalité stricte",
    fichier: "src/coquille/contrat-de-messages.mjs",
    avant: "  return corps?.[CHAMP_DE_LA_FEUILLE] === true;\n",
    apres: "  return Boolean(corps?.[CHAMP_DE_LA_FEUILLE]);\n",
    epreuves: [EPREUVE_CONTRAT],
  },
  {
    nom: "aucun code en clair n'est écrit par le parcours",
    garde: "texteSansCode — le masquage de tout code sur toute écriture de la page (constat 3)",
    fichier: PARCOURS,
    avant: '  return String(texte ?? "").replace(CODE_EN_CLAIR, MESSAGES.codeMasque);\n',
    apres: '  return String(texte ?? "");\n',
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "une ligne « en cours » ferme les boutons d'un geste long",
    garde: "unGesteEstEnCours — les lignes du cycle et de la portabilité (constat 8)",
    fichier: PARCOURS,
    avant: "  if (enCours(ligneDuCycle) || enCours(ligneDePortabilite)) return true;\n",
    apres: "",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "aucun refus du relais n'est annoncé avant un démarrage abouti",
    garde: "refusDeRelaisAAnnoncer — l'absence de référence (constat 6)",
    fichier: PARCOURS,
    avant: "  if (reference === null) return [];\n",
    apres: "  if (reference === null) return Object.keys(comptes);\n",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "sous Firefox, l'étape 4 dit sa limite au lieu d'offrir « Démarrer »",
    garde: "ecranOuvert — l'écran de la limite connue (constat 9)",
    fichier: PARCOURS,
    avant: '  if (moteur === "firefox" && (choisi === "travailler" || choisi === "accueil")) {\n',
    apres: "  if (false) {\n",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "chaque code d'une famille exportée a sa conduite, ou le cliquet rougit",
    garde: "TABLE — une conduite retirée, relevée par le cliquet PAR CONSTRUCTION (constat 4)",
    fichier: "src/coquille/conduites-du-parcours.mjs",
    avant:
      "  [S.quiesce]: [\n" +
      "    K.attendre,\n" +
      '    "Le coffre enregistre son état en ce moment. Attendez quelques secondes, puis recommencez.",\n' +
      "  ],\n",
    apres: "",
    epreuves: [EPREUVE_PARCOURS_CONDUITES],
  },
  {
    nom: "une exclusion dit pourquoi le code est inatteignable",
    garde: "CODES_HORS_DU_CHEMIN — le motif exigé (constat 4)",
    fichier: "src/coquille/conduites-du-parcours.mjs",
    avant: 'const INATTEIGNABLE = "inatteignable depuis le parcours parce que ";\n',
    apres: 'const INATTEIGNABLE = "";\n',
    epreuves: [EPREUVE_PARCOURS_CONDUITES],
  },
  {
    nom: "un refus sans code reconnu reçoit sa conduite, jamais le texte technique",
    garde: "conduiteDUnRefusSansCodeConnu — la conduite de la table (constat 5)",
    fichier: "src/coquille/conduites-du-parcours.mjs",
    avant: "  return connu === undefined ? null : connu.conduite;\n",
    apres: "  return connu === undefined ? null : brut;\n",
    epreuves: [EPREUVE_PARCOURS_CONDUITES],
  },
  {
    nom: "une phrase trop courte reçoit SA conduite, pas la phrase générique (#240)",
    garde: "TABLE — la conduite de `VAULT_PHRASE_TROP_FAIBLE`",
    fichier: "src/coquille/conduites-du-parcours.mjs",
    avant: "    CODE_PHRASE_FAIBLE,\n    S.unsupported,\n",
    apres: "    S.unsupported,\n",
    epreuves: [EPREUVE_PARCOURS_CONDUITES],
  },
  {
    nom: "un refus de GESTE n'est pas un refus d'inventaire",
    garde: "coffreObserve — la ligne des moyens d'un refus d'inventaire",
    fichier: PARCOURS,
    avant:
      '  if (REFUS_D_INVENTAIRE.includes(dernierRefus) && texte.startsWith("Ce coffre ne peut pas")) {\n',
    apres: '  if (texte.startsWith("Ce coffre ne peut pas")) {\n',
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "un code du chemin rend SA conduite, jamais la phrase générique",
    garde: "conduiteHumaine — la lecture de la table",
    fichier: "src/coquille/conduites-du-parcours.mjs",
    avant: "  if (conduite !== undefined) return conduite;\n",
    apres: "",
    epreuves: [EPREUVE_PARCOURS_CONDUITES],
  },
  // #231 : WebKit 26.6+ expose `getDirectory` mais le REJETTE (`UnknownError`, que le moteur dit
  // « transitoire ») en contexte éphémère. Cinq familles de gardes. (1) La SONDE du stockage
  // (`src/vm/sonde-du-stockage.mjs`) : essais bornés, délai, classement — `indetermine` jamais
  // `absente`. (2) La traduction du rejet en `VAULT_STORAGE_INDETERMINE` (`opfs-sync-access.mjs`).
  // (3) Le BRANCHEMENT dans `public/runtime-worker.mjs`, chargé TEL QUEL par
  // `coquille-worker-sonde-opfs.test.mjs` (sonde suspendue, demandes reçues pendant elle) : attente,
  // ordre « attendre puis lire », état indéterminé, relance par un geste, refus typés. (4) La racine
  // des témoins du spike et de la fouille du banc (`racine-opfs.mjs`) : un `UnknownError` n'est jamais
  // `indisponible`, une panne lève. (5) La comparaison des témoins (`tests/support/temoins-opfs.mjs`) :
  // la tolérance du seul contexte éphémère mesuré. Non muté, et dit : le branchement DOM du spike
  // (`app-inter.mjs`) et du banc, éprouvé par le seul navigateur (`apps-frontiere`,
  // `deverrouillage-frontiere`) ; et `PEUT_OUVRIR = true` à la levée de l'indétermination, que le double
  // du Worker ne distingue pas d'un refus tiers.
  {
    nom: "le rejet de racine non transitoire garde son classement précis, jamais INDETERMINE",
    garde: "volumeDirectory — `throw cause` pour tout autre nom (#231)",
    fichier: OPFS_SYNC,
    avant:
      "    if (classerLeRejetDeRacine(cause) !== VERDICTS_DU_STOCKAGE.indetermine) throw cause;\n",
    apres: "",
    epreuves: [EPREUVE_GETDIRECTORY],
  },
  {
    nom: "le rejet transitoire de racine rend INDETERMINE, jamais UNSUPPORTED",
    garde: "volumeDirectory — le code du refus (#231)",
    fichier: OPFS_SYNC,
    avant:
      "      STORAGE_ERROR_CODES.indeterminate,\n      `Le stockage du navigateur est inaccessible",
    apres:
      "      STORAGE_ERROR_CODES.unsupported,\n      `Le stockage du navigateur est inaccessible",
    epreuves: [EPREUVE_GETDIRECTORY],
  },
  {
    nom: "la racine des témoins : un UnknownError n'est PAS « indisponible »",
    garde: "racineDeLOpfs — le verdict du rejet transitoire (#231, revue de la PR #305)",
    fichier: RACINE_OPFS,
    avant: '          resultat: "indetermine",\n',
    apres: '          resultat: "indisponible",\n',
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "la racine des témoins : seul le nom transitoire est indéterminé, tout autre rejet est une panne",
    garde: "racineDeLOpfs — le nom du rejet (#231)",
    fichier: RACINE_OPFS,
    avant: "    if (erreur?.name === NOM_DU_REJET_TRANSITOIRE) {\n",
    apres: "    if (erreur) {\n",
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "la fouille impossible LÈVE sur une panne : jamais un texte vide muet",
    garde: "fouilleImpossible — la levée (#231, revue de la PR #305)",
    fichier: RACINE_OPFS,
    avant: '  if (absent.resultat === "panne") throw new Error(absent.detail);\n',
    apres: "",
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "la fouille impossible se DIT : `impossible` est rendu",
    garde: "fouilleImpossible — le marqueur (#231)",
    fichier: RACINE_OPFS,
    avant: '  return { texte: "", impossible: absent.resultat };\n',
    apres: '  return { texte: "" };\n',
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "la tolérance des témoins ne vaut que pour le contexte éphémère connu de l'épreuve",
    garde: "estToleree — `contexteEphemereMesure` (#231)",
    fichier: TEMOINS_OPFS,
    avant: "    contexteEphemereMesure === true &&\n",
    apres: "",
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "la tolérance ne vaut que si A n'a RIEN déposé : un témoin déjà déposé qui disparaît reste rouge",
    garde: "estToleree — le dépôt de A (#231)",
    fichier: TEMOINS_OPFS,
    avant: '    depots.opfs.startsWith("indetermine: ") &&\n',
    apres: "",
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "la tolérance ne vaut que pour un témoin OPFS",
    garde: "estToleree — le mécanisme (#231)",
    fichier: TEMOINS_OPFS,
    avant: '    sonde.mecanisme === "OPFS" &&\n    sonde.resultat === "indetermine" &&\n',
    apres: '    sonde.resultat === "indetermine" &&\n',
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "la tolérance ne vaut que pour le détail MESURÉ",
    garde: "estToleree — le détail (#231)",
    fichier: TEMOINS_OPFS,
    avant: "    sonde.detail === DETAIL_MESURE\n",
    apres: "    true\n",
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "seule une API ABSENTE sort de la comparaison parmi les `indisponible`",
    garde: "estIndisponibleEtablie — le motif (#231)",
    fichier: TEMOINS_OPFS,
    avant: "const INDISPONIBILITE_ETABLIE = /(^| )absent$/;",
    apres: "const INDISPONIBILITE_ETABLIE = /.*/;",
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "une isolation n'est prouvée que par des témoins OPFS MESURÉS : indeterminé ou panne ne comptent pas",
    garde: "opfsNonMesures — les résultats admis (#231)",
    fichier: TEMOINS_OPFS,
    avant: '      !["lu", "invisible"].includes(sonde.resultat) &&\n',
    apres: '      !["lu", "invisible", "indetermine", "panne"].includes(sonde.resultat) &&\n',
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "une fouille impossible est une PANNE sur un moteur qui ouvre un volume",
    garde: "fouilleOpfsAdmise — la branche `porte` (#231)",
    fichier: TEMOINS_OPFS,
    avant: "    if (porte || contexteEphemereMesure !== true) {\n",
    apres: "    if (contexteEphemereMesure !== true) {\n",
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "une fouille impossible n'est tolérée que dans le contexte éphémère connu de l'épreuve",
    garde: "fouilleOpfsAdmise — `contexteEphemereMesure` (#231, revue complète de la PR #305)",
    fichier: TEMOINS_OPFS,
    avant: "    if (porte || contexteEphemereMesure !== true) {\n",
    apres: "    if (porte) {\n",
    epreuves: [EPREUVE_TEMOINS],
  },
  {
    nom: "un UnknownError PERSISTANT n'est pas une absence : indéterminé, jamais « absente »",
    garde: "classerLeRejetDeRacine — le nom transitoire mesuré donne `indetermine` (#231)",
    fichier: SONDE_DU_STOCKAGE,
    avant:
      "  if (cause?.name === REJET_TRANSITOIRE_MESURE) return VERDICTS_DU_STOCKAGE.indetermine;\n",
    apres: "  if (cause?.name === REJET_TRANSITOIRE_MESURE) return VERDICTS_DU_STOCKAGE.absente;\n",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "la sonde réessaie un nombre BORNÉ de fois — pas un de moins, pas un de plus",
    garde: "sonderLeStockageEnDetail — la borne des essais (#231)",
    fichier: SONDE_DU_STOCKAGE,
    avant: "      if (verdict !== VERDICTS_DU_STOCKAGE.indetermine || essai >= essais) {\n",
    apres: "      if (verdict !== VERDICTS_DU_STOCKAGE.indetermine || essai > essais) {\n",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "seul l'indéterminé est réessayé : une panne ou une absence ne le sont pas",
    garde: "sonderLeStockageEnDetail — le réessai conditionné au verdict (#231)",
    fichier: SONDE_DU_STOCKAGE,
    avant: "      if (verdict !== VERDICTS_DU_STOCKAGE.indetermine || essai >= essais) {\n",
    apres: "      if (essai >= essais) {\n",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "la sonde ATTEND entre deux essais",
    garde: "sonderLeStockageEnDetail — le délai (#231)",
    fichier: SONDE_DU_STOCKAGE,
    avant: "    await attendre(delaiMs);\n",
    apres: "",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "le délai entre essais reste court : le coût du démarrage est borné",
    garde: "DELAI_ENTRE_ESSAIS_MS (#231)",
    fichier: SONDE_DU_STOCKAGE,
    avant: "export const DELAI_ENTRE_ESSAIS_MS = 100;",
    apres: "export const DELAI_ENTRE_ESSAIS_MS = 5000;",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "la sonde réessaie : un UnknownError transitoire suivi d'une réussite n'est pas figé",
    garde: "ESSAIS_DE_LA_SONDE (#231)",
    fichier: SONDE_DU_STOCKAGE,
    avant: "export const ESSAIS_DE_LA_SONDE = 3;",
    apres: "export const ESSAIS_DE_LA_SONDE = 1;",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "une fonction getDirectory absente est une absence établie",
    garde: "sonderLeStockageEnDetail — la garde `typeof` (#231)",
    fichier: SONDE_DU_STOCKAGE,
    avant:
      '  if (typeof storage?.getDirectory !== "function") {\n    return { verdict: VERDICTS_DU_STOCKAGE.absente, code: null };\n  }\n',
    apres:
      '  if (typeof storage?.getDirectory !== "function") {\n    return { verdict: VERDICTS_DU_STOCKAGE.atteignable, code: null };\n  }\n',
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "les refus de capacité déjà typés restent des absences",
    garde: "classerLeRejetDeRacine — le renvoi à la table des codes (#231)",
    fichier: SONDE_DU_STOCKAGE,
    avant: "    ? VERDICTS_DU_STOCKAGE.absente\n    : VERDICTS_DU_STOCKAGE.panne;",
    apres: "    ? VERDICTS_DU_STOCKAGE.panne\n    : VERDICTS_DU_STOCKAGE.panne;",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "la reprise est possible depuis une PANNE : panne → disponible",
    garde: "TRANSITIONS — la ligne `panne` (#231, revue de la PR #305)",
    fichier: CAPACITE,
    avant: "  [E.panne]: Object.freeze([V.atteignable, V.absente, V.indetermine, V.panne]),",
    apres: "  [E.panne]: Object.freeze([V.absente, V.indetermine, V.panne]),",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "une panne au réessai d'un stockage indéterminé est une transition ÉCRITE",
    garde: "TRANSITIONS — la ligne `indetermine` (#231, revue de la PR #305)",
    fichier: CAPACITE,
    avant: "  [E.indetermine]: Object.freeze([V.atteignable, V.absente, V.indetermine, V.panne]),",
    apres: "  [E.indetermine]: Object.freeze([V.atteignable, V.absente, V.indetermine]),",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "`absent` est terminal : une absence établie ne se lève pas",
    garde: "TRANSITIONS — la ligne `absent` (#231)",
    fichier: CAPACITE,
    avant: "  [E.absent]: Object.freeze([]),",
    apres: "  [E.absent]: Object.freeze([V.atteignable]),",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "`disponible` n'est pas resondé : aucune transition n'en sort",
    garde: "TRANSITIONS — la ligne `disponible` (#231)",
    fichier: CAPACITE,
    avant: "  [E.disponible]: Object.freeze([]),",
    apres: "  [E.disponible]: Object.freeze([V.indetermine]),",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "un verdict `atteignable` pose `disponible`",
    garde: "ETAT_DU_VERDICT — la reprise (#231, revue de la PR #305)",
    fichier: CAPACITE,
    avant: "  [V.atteignable]: E.disponible,",
    apres: "  [V.atteignable]: E.indetermine,",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "une panne porte son code PRÉCIS",
    garde: "apresLaSonde — le code exigé (#231)",
    fichier: CAPACITE,
    avant:
      "  if (!TRANSITIONS[capacite.etat]?.includes(verdict)) {\n" +
      "    throw new Error(`Transition de capacité non écrite : ${capacite.etat} ← ${verdict}.`);\n" +
      "  }\n" +
      "  if (verdict === V.panne) {\n" +
      '    if (typeof code !== "string" || code === "") {\n',
    apres:
      "  if (!TRANSITIONS[capacite.etat]?.includes(verdict)) {\n" +
      "    throw new Error(`Transition de capacité non écrite : ${capacite.etat} ← ${verdict}.`);\n" +
      "  }\n" +
      "  if (verdict === V.panne) {\n" +
      "    if (false) {\n",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "seule la capacité `disponible` ouvre",
    garde: "peutOuvrir (#231)",
    fichier: CAPACITE,
    avant: "export const peutOuvrir = (capacite) => capacite.etat === E.disponible;",
    apres: "export const peutOuvrir = (capacite) => capacite.etat !== E.absent;",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "une panne se RÉESSAIE, comme l'indéterminé",
    garde: "reessayable — la panne (#231)",
    fichier: CAPACITE,
    avant:
      "export const reessayable = (capacite) =>\n  capacite.etat === E.indetermine || capacite.etat === E.panne;",
    apres: "export const reessayable = (capacite) => capacite.etat === E.indetermine;",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "une panne se publie `indetermine`, jamais `verrouille`",
    garde: "etatPublie — la panne (#231)",
    fichier: CAPACITE,
    avant:
      "  if (capacite.etat === E.indetermine || capacite.etat === E.panne) {\n    return ETATS_DU_VOLUME.indetermine;",
    apres: "  if (capacite.etat === E.indetermine) {\n    return ETATS_DU_VOLUME.indetermine;",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "UNSUPPORTED n'est rendu que pour une absence ÉTABLIE",
    garde: "refusDeCapacite — la branche absente (#231, revue de la PR #305)",
    fichier: CAPACITE,
    avant:
      "  if (capacite.etat === E.absent) {\n    return { code: STORAGE_ERROR_CODES.unsupported, message: MESSAGE_ABSENT };",
    apres:
      "  if (capacite.etat !== E.disponible && capacite.etat !== E.inconnu) {\n    return { code: STORAGE_ERROR_CODES.unsupported, message: MESSAGE_ABSENT };",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "une panne rend SON code, non celui de l'indétermination",
    garde: "refusDeCapacite — le code de la panne (#231)",
    fichier: CAPACITE,
    avant: "    return {\n      code: capacite.code,",
    apres: "    return {\n      code: STORAGE_ERROR_CODES.indeterminate,",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "la sonde rend le code PRÉCIS d'une panne",
    garde: "sonderLeStockageEnDetail — le code (#231, revue de la PR #305)",
    fichier: SONDE_DU_STOCKAGE,
    avant:
      '            ? toStorageError(cause, { operation: "open-directory", volume: "-" }).code\n            : null;',
    apres: "            ? null\n            : null;",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "un stockage inaccessible n'est pas un coffre absent : le refus typé le reconnaît",
    garde: "coffreObserve — `COFFRE.inaccessible` (#231, revue de la PR #305)",
    fichier: PARCOURS,
    avant:
      "  if (dernierRefus === STORAGE_ERROR_CODES.indeterminate) return COFFRE.inaccessible;\n",
    apres: "",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "l'écran d'un stockage inaccessible est celui du réessai, non « chargement »",
    garde: "ecranCourant — `inaccessible` (#231)",
    fichier: PARCOURS,
    avant: '  if (coffre === COFFRE.inaccessible) return "inaccessible";\n',
    apres: "",
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "le canal privilégié attend la sonde avant l'inventaire et avant tout geste",
    garde: "surMessagePrivilegie — `await premiereSonde` (#231, revue de la PR #305)",
    fichier: RUNTIME_WORKER,
    avant: "  await capaciteDuWorker.premiereSonde;\n  const decode",
    apres: "  const decode",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "la poignée d'état ATTEND la sonde puis LIT l'état — jamais l'inverse",
    garde: "publierLEtat — l'ordre « attendre, lire » (#231, revue de la PR #305)",
    fichier: RUNTIME_WORKER,
    avant:
      "  const exclusivite = await exclusiviteConstatee;\n  repondre(TYPES_PRIVILEGIES.etatReponse, correlation, {\n    ...chargeUtileDEtat({ etat: interne.etat, barrieres: interne.barrieres }),\n    exclusivite,\n",
    apres:
      "  repondre(TYPES_PRIVILEGIES.etatReponse, correlation, {\n    ...chargeUtileDEtat({ etat: interne.etat, barrieres: interne.barrieres }),\n    exclusivite: await exclusiviteConstatee,\n",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "le constat d'exclusivité dépend de la sonde, et la première réponse d'état avec lui",
    garde: "exclusiviteConstatee — `premiereSonde.then` (#231)",
    fichier: RUNTIME_WORKER,
    avant:
      "const exclusiviteConstatee = capaciteDuWorker.premiereSonde.then(() =>\n  constaterLExclusivite({ volume: VOLUME, peutOuvrir: capaciteDuWorker.peutOuvrir() }),\n);\n",
    apres:
      "const exclusiviteConstatee = constaterLExclusivite({ volume: VOLUME, peutOuvrir: capaciteDuWorker.peutOuvrir() });\n",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "un geste présenté pendant l'indétermination RELANCE la sonde : rien n'est figé",
    garde: "surMessagePrivilegie — la relance (#231)",
    fichier: RUNTIME_WORKER,
    avant: "  if (capaciteDuWorker.reessayable() && decode.type !== TYPES_PRIVILEGIES.etat) {",
    apres: "  if (false && decode.type !== TYPES_PRIVILEGIES.etat) {",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "une demande d'INVENTAIRE relance aussi la sonde : la reprise relit l'inventaire",
    garde:
      "surMessagePrivilegie — l'inventaire n'est pas exempté de la relance (#231, revue de la PR #305)",
    fichier: RUNTIME_WORKER,
    avant: "  if (capaciteDuWorker.reessayable() && decode.type !== TYPES_PRIVILEGIES.etat) {",
    apres:
      "  if (\n    capaciteDuWorker.reessayable() &&\n    decode.type !== TYPES_PRIVILEGIES.etat &&\n    decode.type !== TYPES_PRIVILEGIES.inventaire\n  ) {",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "le refus d'un geste est celui de la CAPACITÉ : UNSUPPORTED seulement pour une absence établie",
    garde: "exigerUnVolumeAtteignable — `refus` de la capacité (#231, revue de la PR #305)",
    fichier: RUNTIME_WORKER,
    avant: "  const refus = capaciteDuWorker.refus();\n  if (refus === null) return;\n",
    apres: "  return;\n",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "l'inventaire d'un stockage indéterminé est INCONNU, jamais vide",
    garde: "lireLInventaire — la branche inconnue (#231, revue de la PR #305)",
    fichier: RUNTIME_WORKER,
    avant:
      "    if (capaciteDuWorker.reessayable()) return capaciteDuWorker.corpsDInventaireInconnu();\n",
    apres: "",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "une lecture d'inventaire qui rejette APRÈS une sonde réussie donne un inventaire INCONNU, non un refus privé",
    garde:
      "publierLInventaire — la conversion de l'échec de lecture (#231, revue complète de la PR #305)",
    fichier: RUNTIME_WORKER,
    avant: "    if (!capaciteDuWorker.noterUnEchecDeLecture(erreur)) throw erreur;\n",
    apres: "    throw erreur;\n",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "un geste dont la lecture rejette retire `verrouille` : l'échec est NOTÉ",
    garde: "la chaîne du canal — `noterUnEchecDeLecture` (#231, revue complète de la PR #305)",
    fichier: RUNTIME_WORKER,
    avant: "        capaciteDuWorker.noterUnEchecDeLecture(erreur);\n",
    apres: "",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "le résultat de la sonde est APPLIQUÉ à la capacité",
    garde: "appliquerLaSonde — la transition (#231, revue de la PR #305)",
    fichier: CAPACITE_DU_WORKER,
    avant: "    capacite = apresLaSonde(capacite, { verdict, code });\n",
    apres: "    apresLaSonde(capacite, { verdict, code });\n",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "la sonde publie l'état de la capacité : `indetermine`, puis `verrouille` à la levée",
    garde: "appliquerLaSonde — l'état publié (#231)",
    fichier: CAPACITE_DU_WORKER,
    avant:
      "    capacite = apresLaSonde(capacite, { verdict, code });\n    interne.etat = etatPublie(capacite);\n",
    apres: "    capacite = apresLaSonde(capacite, { verdict, code });\n",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "l'inventaire inconnu se DIT : `inconnu: true` et le refus typé",
    garde: "corpsDInventaireInconnu — le marqueur (#231)",
    fichier: CAPACITE_DU_WORKER,
    avant: "      inconnu: true,\n",
    apres: "",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "l'échec d'une lecture est APPLIQUÉ à la capacité : `disponible` n'est pas un cul-de-sac",
    garde: "noterUnEchecDeLecture — la transition (#231, revue complète de la PR #305)",
    fichier: CAPACITE_DU_WORKER,
    avant: "    capacite = apresUnEchecDeLecture(capacite, echec);\n",
    apres: "    apresUnEchecDeLecture(capacite, echec);\n",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "l'échec d'une lecture retire `verrouille` de l'état publié",
    garde: "noterUnEchecDeLecture — l'état publié (#231, revue complète de la PR #305)",
    fichier: CAPACITE_DU_WORKER,
    avant: "    interne.etat = etatPublie(capacite);\n    return true;",
    apres: "    return true;",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "seule une erreur du STOCKAGE est notée : une erreur du domaine remonte telle quelle",
    garde: "noterUnEchecDeLecture — `echec === null` (#231, revue complète de la PR #305)",
    fichier: CAPACITE_DU_WORKER,
    avant: "    if (echec === null || interne.etat === ETATS_DU_VOLUME.ouvert) return false;\n",
    apres: "    if (interne.etat === ETATS_DU_VOLUME.ouvert) return false;\n",
    epreuves: [EPREUVE_WORKER_SONDE],
  },
  {
    nom: "`disponible` peut repasser en `indetermine` ou en `panne` sur une lecture réelle",
    garde: "TRANSITIONS_DE_LECTURE — la ligne `disponible` (#231, revue complète de la PR #305)",
    fichier: CAPACITE,
    avant: "  [E.disponible]: Object.freeze([V.indetermine, V.panne]),",
    apres: "  [E.disponible]: Object.freeze([]),",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "une lecture en échec depuis `indetermine` ou `panne` reste une transition écrite",
    garde: "TRANSITIONS_DE_LECTURE — les lignes `indetermine` et `panne` (#231)",
    fichier: CAPACITE,
    avant:
      "  [E.indetermine]: Object.freeze([V.indetermine, V.panne]),\n  [E.panne]: Object.freeze([V.indetermine, V.panne]),\n",
    apres:
      "  [E.indetermine]: Object.freeze([V.indetermine]),\n  [E.panne]: Object.freeze([V.indetermine]),\n",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "une lecture en échec ne fait jamais repasser une capacité `inconnue` ni `absente`",
    garde: "TRANSITIONS_DE_LECTURE — la garde des états (#231)",
    fichier: CAPACITE,
    avant: "  if (!TRANSITIONS_DE_LECTURE[capacite.etat]?.includes(verdict)) {",
    apres: "  if (false) {",
    epreuves: [EPREUVE_CAPACITE],
  },
  {
    nom: "l'UnknownError déjà traduit garde son nom dans `context.cause` : il reste indéterminé",
    garde: "classerLaLectureEnEchec — `context.cause` (#231, revue complète de la PR #305)",
    fichier: SONDE_DU_STOCKAGE,
    avant: "    cause.context?.cause === REJET_TRANSITOIRE_MESURE ||\n",
    apres: "",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "une erreur du DOMAINE n'est jamais avalée en panne de stockage",
    garde: "classerLaLectureEnEchec — les codes de panne (#231, revue complète de la PR #305)",
    fichier: SONDE_DU_STOCKAGE,
    avant:
      "    return PANNES_DE_LECTURE_PAR_CODE.has(code)\n" +
      "      ? { verdict: VERDICTS_DU_STOCKAGE.panne, code }\n" +
      "      : null;\n",
    apres: "    return { verdict: VERDICTS_DU_STOCKAGE.panne, code };\n",
    epreuves: [EPREUVE_SONDE],
  },
  {
    nom: "un échec de lecture de type `QuotaExceededError` rend le code précis",
    garde: "classerLaLectureEnEchec — le nom du DOMException (#231)",
    fichier: SONDE_DU_STOCKAGE,
    avant:
      "  const parNom = PANNES_DE_LECTURE_PAR_NOM[cause.name];\n  return parNom === undefined ? null : { verdict: VERDICTS_DU_STOCKAGE.panne, code: parNom };",
    apres: "  return null;",
    epreuves: [EPREUVE_SONDE],
  },
  // #231, revue de la PR #305 (relecteur 2) : la garde de l'interface sur un inventaire refusé ou INCONNU,
  // éprouvée en exécutant `monterLInterface` sur un document minimal. Les deux autres lignes identiques
  // (`ouvrirPar`, `ouvrirParLaPasskey`) ne sont PAS mutées ici, et la garde de `ouvrirPar` MASQUE celle-ci
  // pour la dérivation : ce qui les distingue est le champ de phrase conservé et la priorité du refus
  // d'inventaire sur la politique de création.
  {
    nom: "un inventaire refusé ou inconnu ne juge aucune phrase et ne vide pas le champ",
    garde:
      "ouvrirParLaPhrase — la garde sur `inventaire.refus`, avant la politique de phrase (#231)",
    fichier: INTERFACE,
    avant:
      "  // politique de phrase de CRÉATION ne s'applique qu'à un coffre dont l'inventaire dit qu'il n'existe pas.\n" +
      "  if (contexte.inventaire.refus) return montrerLeRefus(contexte, contexte.inventaire.refus);\n",
    apres:
      "  // politique de phrase de CRÉATION ne s'applique qu'à un coffre dont l'inventaire dit qu'il n'existe pas.\n",
    epreuves: [EPREUVE_INTERFACE_INVENTAIRE],
  },
  // #231, revue de la PR #305 (relecteur 2, seconde passe) : la condition qui CHOISIT la politique de
  // création dans `relireLaPhrase`. Un inventaire INCONNU a `present: false` : sans `inconnu !== true`, la
  // politique de création (longueur minimale, `new-password`, constat et conseil de choix) revient dès
  // la relecture d'un inventaire dont on ne sait rien.
  {
    nom: "un inventaire INCONNU n'est pas un coffre à créer : aucune politique de création",
    garde: "relireLaPhrase — `inventaire.inconnu !== true` dans le choix de la création (#231)",
    fichier: INTERFACE,
    avant: "  const creation = !inventaire.present && inventaire.inconnu !== true;\n",
    apres: "  const creation = !inventaire.present;\n",
    epreuves: [EPREUVE_INTERFACE_INVENTAIRE],
  },
  // Le modèle d'état de la révocation (#310, ADR 0049) : sa table est séparée.
  ...MUTATIONS_DE_LA_REVOCATION,
  // --- #311, tranche C5 : la course entre onglets au déverrouillage ------------------------------
  {
    nom: "la revalidation exige le MÊME emplacement (#311)",
    garde: "revaliderSousLeHandle — la comparaison de `identifiantEmplacement`",
    fichier: REVALIDATION,
    avant:
      "    sous.identifiantEmplacement !== ouverte.identifiantEmplacement ||\n" +
      "    !memesOctets(sous.dek, ouverte.dek)\n",
    apres: "    !memesOctets(sous.dek, ouverte.dek)\n",
    epreuves: [EPREUVE_REVALIDATION],
  },
  {
    nom: "la revalidation exige la MÊME clé de volume (#311)",
    garde: "revaliderSousLeHandle — la comparaison des octets de la DEK",
    fichier: REVALIDATION,
    avant:
      "    sous.identifiantEmplacement !== ouverte.identifiantEmplacement ||\n" +
      "    !memesOctets(sous.dek, ouverte.dek)\n",
    apres: "    sous.identifiantEmplacement !== ouverte.identifiantEmplacement\n",
    epreuves: [EPREUVE_REVALIDATION],
  },
  {
    nom: "une divergence est REFUSÉE, jamais acceptée en silence (#311)",
    garde: "revaliderSousLeHandle — le `throw cleRefusee`",
    fichier: REVALIDATION,
    avant: "    throw cleRefusee({ volume: identifiantVolume });\n",
    apres: "",
    epreuves: [EPREUVE_REVALIDATION],
  },
  {
    nom: "l'ancre de version tient en passe 2 (#311)",
    garde: "revaliderSousLeHandle — `versionMinimale` passée à l'ouverture",
    fichier: REVALIDATION,
    avant: "kek: ouverte.kek, versionMinimale: ouverte.versionMinimale };",
    apres: "kek: ouverte.kek, versionMinimale: null };",
    epreuves: [EPREUVE_REVALIDATION],
  },
  {
    nom: "la clé de volume de la passe 2 est effacée (#311)",
    garde: "revaliderSousLeHandle — le `fill(0)` du `finally`",
    fichier: REVALIDATION,
    avant: "    for (const dek of rendues) dek.fill(0);\n",
    apres: "",
    epreuves: [EPREUVE_REVALIDATION],
  },
  {
    nom: "la version publiée est celle de la passe 2, l'autoritaire (#311)",
    garde: "revaliderSousLeHandle — `ouverte.version = sous.version`",
    fichier: REVALIDATION,
    avant: "    ouverte.version = sous.version;\n",
    apres: "",
    epreuves: [EPREUVE_REVALIDATION],
  },
  {
    nom: "la passe 1 n'écrit RIEN : l'écriture est refusée (#311)",
    garde: "enLectureSeule — le refus de `ecrire`",
    fichier: REVALIDATION,
    avant: "allouer: refuser, ecrire: refuser, barriere: refuser",
    apres: "allouer: refuser, barriere: refuser",
    epreuves: [EPREUVE_REVALIDATION],
  },
  {
    nom: "la comparaison des clés ne s'arrête pas à la longueur commune (#311)",
    garde: "memesOctets — l'écart de longueur",
    fichier: REVALIDATION,
    avant: "  let ecart = a.length ^ b.length;\n",
    apres: "  let ecart = 0;\n",
    epreuves: [EPREUVE_REVALIDATION],
  },
  {
    nom: "le Worker ouvre l'enveloppe en LECTURE SEULE avant le handle, chemin phrase et passkey (#311)",
    garde: "ouvrirSousLaPage — `enLectureSeule(support())`",
    fichier: DEVERROUILLAGE,
    avant:
      "    support: enLectureSeule(support()),\n    identifiantVolume: IDENTIFIANT_VOLUME,\n    kek,\n",
    apres: "    support: support(),\n    identifiantVolume: IDENTIFIANT_VOLUME,\n    kek,\n",
    epreuves: [EPREUVE_WORKER_DEVERROUILLAGE],
  },
  {
    nom: "le Worker ouvre l'enveloppe en LECTURE SEULE avant le handle, chemin code (#311)",
    garde: "ouvrirSousLeCode — `enLectureSeule(support())`",
    fichier: DEVERROUILLAGE,
    avant: "  return ouvrirParLeCode({\n    support: enLectureSeule(support()),\n",
    apres: "  return ouvrirParLeCode({\n    support: support(),\n",
    epreuves: [EPREUVE_WORKER_DEVERROUILLAGE],
  },
  {
    nom: "le Worker passe la revalidation à l'ouvreur (#311)",
    garde: "ouvrirLeVolume — `sousLeHandle`",
    fichier: DEVERROUILLAGE,
    avant:
      "    sousLeHandle: () =>\n" +
      "      revaliderSousLeHandle({ support: support(), identifiantVolume: IDENTIFIANT_VOLUME, ouverte }),\n",
    apres: "",
    epreuves: [EPREUVE_WORKER_DEVERROUILLAGE],
  },
  {
    nom: "l'ouvreur appelle le crochet sous le handle (#311)",
    garde: "saisirLireEtAllouer — `await sousLeHandle?.()`",
    fichier: OUVERTURE_DU_VOLUME,
    avant: "    await sousLeHandle?.();\n",
    apres: "",
    epreuves: [EPREUVE_SOUS_LE_HANDLE],
  },
  {
    nom: "un refus du crochet RENDS le handle (#311)",
    garde: "saisirLireEtAllouer — le crochet est DANS le `try` qui abandonne le handle",
    fichier: OUVERTURE_DU_VOLUME,
    avant:
      "    await sousLeHandle?.();\n" +
      "  } catch (refus) {\n" +
      "    throw abandonHandle(saisi.handle, name, refus);\n" +
      "  }\n",
    apres:
      "  } catch (refus) {\n" +
      "    throw abandonHandle(saisi.handle, name, refus);\n" +
      "  }\n" +
      "  await sousLeHandle?.();\n",
    epreuves: [EPREUVE_SOUS_LE_HANDLE],
  },
  {
    nom: "le crochet précède la naissance : aucun en-tête posé sur un refus (#311)",
    garde: "saisirLireEtAllouer — le crochet avant `poserEnTeteOuRendre`",
    fichier: OUVERTURE_DU_VOLUME,
    avant:
      "    await sousLeHandle?.();\n" +
      "  } catch (refus) {\n" +
      "    throw abandonHandle(saisi.handle, name, refus);\n" +
      "  }\n" +
      "  if (!saisi.naissance) return { ...saisi, voisinsRetires: Object.freeze([]) };\n" +
      "  poserEnTeteOuRendre(saisi.handle, name, saisi.disposition, saisi.identifiantVolume);\n",
    apres:
      "  } catch (refus) {\n" +
      "    throw abandonHandle(saisi.handle, name, refus);\n" +
      "  }\n" +
      "  if (!saisi.naissance) {\n" +
      "    await sousLeHandle?.();\n" +
      "    return { ...saisi, voisinsRetires: Object.freeze([]) };\n" +
      "  }\n" +
      "  poserEnTeteOuRendre(saisi.handle, name, saisi.disposition, saisi.identifiantVolume);\n" +
      "  await sousLeHandle?.();\n",
    epreuves: [EPREUVE_SOUS_LE_HANDLE],
  },
  {
    nom: "la passe 2 s'ouvre d'abord en LECTURE SEULE : un refus n'écrit jamais (#311, PR #314 constat 2)",
    garde: "revaliderSousLeHandle — `enLectureSeule(support)` de la première ouverture",
    fichier: REVALIDATION,
    avant: "    let sous = await ouvrir({ ...appel, support: enLectureSeule(support) });\n",
    apres: "    let sous = await ouvrir({ ...appel, support });\n",
    epreuves: [EPREUVE_REVALIDATION],
  },
  {
    nom: "la migration se joue sous le handle, une fois l'identité confirmée (#311)",
    garde: "revaliderSousLeHandle — la seconde ouverture quand `migration` n'est pas nul",
    fichier: REVALIDATION,
    avant: "    if (sous.migration !== null) {\n",
    apres: "    if (false) {\n",
    epreuves: [EPREUVE_REVALIDATION],
  },
  {
    nom: "l'identité est confrontée AUSSI après la migration (#311)",
    garde: "revaliderSousLeHandle — la seconde comparaison",
    fichier: REVALIDATION,
    avant:
      "      rendues.push(sous.dek);\n" +
      "      exigerLaMemeIdentite(sous, ouverte, identifiantVolume);\n" +
      "    }\n",
    apres: "      rendues.push(sous.dek);\n    }\n",
    epreuves: [EPREUVE_REVALIDATION],
  },
  {
    nom: "la restauration prend le verrou du volume `coquille` avant d'écrire (#311, PR #314 constat 1)",
    garde: "restaurerSousLeVerrou — `prim.prendreLeVolume()`",
    fichier: PORTABILITE_DU_WORKER,
    avant: "  const verrou = await prim.prendreLeVolume();\n",
    apres: "  const verrou = { close() {} };\n",
    epreuves: [EPREUVE_COURSE_PORTABILITE],
  },
  {
    nom: "la restauration REVALIDE l'emplacement sous le verrou (#311)",
    garde: "restaurerSousLeVerrou — le second constat et son refus",
    fichier: PORTABILITE_DU_WORKER,
    avant:
      "    const decision = decisionDeRestauration(await constaterLEmplacement(prim));\n" +
      "    if (decision.code !== null) throw refus(decision.code);\n" +
      "    // La RÉPARATION",
    apres: "    const decision = { code: null, reparer: false };\n    // La RÉPARATION",
    epreuves: [EPREUVE_COURSE_PORTABILITE],
  },
  {
    nom: "la restauration relâche le verrou APRÈS l'import, jamais avant ni jamais (#311)",
    garde: "restaurerSousLeVerrou — le `finally` qui ferme le verrou",
    fichier: PORTABILITE_DU_WORKER,
    avant: "  } finally {\n    verrou.close();\n  }\n",
    apres: "  } finally {\n  }\n",
    epreuves: [EPREUVE_COURSE_PORTABILITE],
  },
  {
    nom: "la réparation vide le volume `coquille` TENU par son handle (#311)",
    garde: "restaurerSousLeVerrou — `prim.viderLeVolume(verrou)`",
    fichier: PORTABILITE_DU_WORKER,
    avant: "      await prim.viderLeVolume(verrou);\n",
    apres: "",
    epreuves: [EPREUVE_COURSE_PORTABILITE],
  },
  {
    nom: "un fichier `coquille` de taille nulle n'est pas un volume (#311)",
    garde: "constaterLEmplacement — `size > 0`",
    fichier: "src/coquille/portabilite-du-coffre.mjs",
    avant: "  const coquille = observeCoquille.present && observeCoquille.size > 0;\n",
    apres: "  const coquille = observeCoquille.present;\n",
    epreuves: [EPREUVE_COURSE_PORTABILITE],
  },
  {
    nom: "la création prend le handle du volume AVANT d'écrire l'enveloppe (#311, #313)",
    garde: "creerLeCoffre — `ouvrirLeHandle(volume)` avant `creerEnveloppe`",
    fichier: DEVERROUILLAGE,
    avant: "    verrou = await ouvrirLeHandle(volume);\n",
    apres: "    verrou = { close() {} };\n",
    epreuves: [EPREUVE_WORKER_DEVERROUILLAGE],
  },
  {
    nom: "la création PASSE son handle à l'ouvreur, sans trou avant la naissance (#311, #313)",
    garde: "ouvrirLeVolume — `openHandle` rend le verrou de la création",
    fichier: DEVERROUILLAGE,
    avant: "      ouverte.verrou = null;\n      return verrou;\n",
    apres: "      return ouvrirLeHandle(nom);\n",
    epreuves: [EPREUVE_WORKER_DEVERROUILLAGE],
  },
  {
    nom: "un refus de la création rend le handle (#311)",
    garde: "creerLeCoffre — `verrou.close()` du `catch`",
    fichier: DEVERROUILLAGE,
    avant: "    verrou?.close();\n    dek.fill(0);\n    throw cause;\n",
    apres: "    dek.fill(0);\n    throw cause;\n",
    epreuves: [EPREUVE_WORKER_DEVERROUILLAGE],
  },
  {
    nom: "un verrou de création que l'ouvreur n'a pas reçu est rendu par `deverrouiller` (#311)",
    garde: "deverrouiller — `ouverte.verrou?.close()` du `finally`",
    fichier: DEVERROUILLAGE,
    avant: "    ouverte.verrou?.close();\n",
    apres: "",
    epreuves: [EPREUVE_WORKER_DEVERROUILLAGE],
  },
  {
    nom: "la création REFAIT le constat de l'emplacement sous le verrou (#311, PR #314 constat 1)",
    garde: "creerLeCoffre — `constaterLaPortabilite()` et le refus de `refusDOuverture`",
    fichier: DEVERROUILLAGE,
    avant: "    const refusDuCoffre = refusDOuverture(etat);\n" + "    if (refusDuCoffre !== null)",
    apres: "    const refusDuCoffre = null;\n" + "    if (refusDuCoffre !== null)",
    epreuves: [EPREUVE_WORKER_DEVERROUILLAGE],
  },
  {
    nom: "la création refuse un emplacement qui n'est plus vide et sans enveloppe (#311)",
    garde: "creerLeCoffre — la branche `emplacementOccupe`",
    fichier: DEVERROUILLAGE,
    avant: "    if (etat !== ETATS_DE_L_EMPLACEMENT.vide && !(await support().etat()).present) {\n",
    apres: "    if (false) {\n",
    epreuves: [EPREUVE_WORKER_DEVERROUILLAGE],
  },
  {
    nom: "la clé tirée est effacée même quand la prise du handle est rejetée (#311, PR #314 constat 3)",
    garde: "creerLeCoffre — la prise du handle DANS le `try` qui efface la clé",
    fichier: DEVERROUILLAGE,
    avant:
      "  let verrou = null;\n" +
      "  // La clé tirée et le verrou sont rendus sur TOUT échec, y compris celui de la prise du handle : le\n" +
      "  // `try` commence donc AVANT l'attente (revue de la PR #314, constat 3).\n" +
      "  try {\n" +
      "    verrou = await ouvrirLeHandle(volume);\n",
    apres: "  const verrou = await ouvrirLeHandle(volume);\n" + "  try {\n",
    epreuves: [EPREUVE_WORKER_DEVERROUILLAGE],
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
