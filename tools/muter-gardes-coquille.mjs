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

/** Les gardes de #265 : la révocation d'urgence se confirme en deux temps (aide, pas garde du Worker). */
const CONFIRMATION = "src/coquille/confirmation-en-deux-temps.mjs";
const TEXTES = "src/coquille/textes-de-la-revocation.mjs";
const EPREUVE_CONFIRMATION = "tests/unit/coquille-confirmation-revocation.test.mjs";
/** Relecture de #308 : plusieurs feuilles, révocation en vol et ses issues, demande périmée. */
const EPREUVE_EN_VOL = "tests/unit/coquille-revocation-en-vol.test.mjs";
const GESTES_PORTABILITE = "src/coquille/gestes-de-portabilite.mjs";
const MOYENS_NOMMES = "src/coquille/moyens-nommes.mjs";
const CONFIRMEE = "src/coquille/confirmation-de-la-revocation.mjs";
const BLOCS_MONTRES = "src/coquille/blocs-montres.mjs";
const EPREUVE_BLOCS = "tests/unit/coquille-blocs-montres.test.mjs";
const PREUVE = "src/coquille/preuve-de-la-feuille.mjs";
const EPREUVE_PREUVE = "tests/unit/coquille-preuve-de-la-feuille.test.mjs";
const DEVERROUILLAGE = "public/runtime-worker-deverrouillage.mjs";

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
      "      await prim.retirer(VOLUME_DE_LA_COQUILLE);\n      await prim.retirer(NOM_DU_VOLUME_APPLICATIF);\n",
    apres:
      "      await prim.retirer(NOM_DU_VOLUME_APPLICATIF);\n      await prim.retirer(VOLUME_DE_LA_COQUILLE);\n",
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
    avant: "    await ouvrirLeVolume(ouverte.dek);\n",
    apres:
      "    interne.eprouves = await constaterALOuverture(interne.backend, ouverte.identifiantEprouve);\n    await ouvrirLeVolume(ouverte.dek);\n",
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
    nom: "un clic sur « Révoquer… » ne révoque pas : il demande (#265)",
    garde: "brancherUneConfirmation — la demande n'accomplit rien",
    fichier: CONFIRMATION,
    avant: "    noeud(annuler)?.focus();\n    demandee();\n",
    apres: "    noeud(annuler)?.focus();\n    demandee();\n    confirmee();\n",
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "« Annuler » n'envoie rien (#265)",
    garde: "brancherUneConfirmation — renoncer n'appelle jamais le geste",
    fichier: CONFIRMATION,
    avant: "    refermer();\n    annulee();\n",
    apres: "    refermer();\n    annulee();\n    confirmee();\n",
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "« Oui » ne part que d'une confirmation OUVERTE, une fois par ouverture (#265)",
    garde: "brancherUneConfirmation — accomplir exige le panneau ouvert",
    fichier: CONFIRMATION,
    avant: "    if (!ouverte()) return;\n    refermer();\n    enVol = true;\n",
    apres: "    refermer();\n    enVol = true;\n",
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "la confirmation s'ouvre sur « Annuler », le geste sûr (#265)",
    garde: "brancherUneConfirmation — le focus à l'ouverture",
    fichier: CONFIRMATION,
    avant: "    noeud(annuler)?.focus();\n",
    apres: "",
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "refermer rend le focus au geste qui avait demandé (#265)",
    garde: "brancherUneConfirmation — le focus ne tombe pas au document",
    fichier: CONFIRMATION,
    avant: "    dire(false);\n    noeud(declencheur)?.focus();\n",
    apres: "    dire(false);\n",
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "Échap annule (#265)",
    garde: "brancherUneConfirmation — la touche d'annulation",
    fichier: CONFIRMATION,
    avant: '    if (evenement.key !== "Escape") return;\n',
    apres: "    return;\n",
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "une demande dont le geste a quitté l'écran est oubliée (#265)",
    garde: "oublierLaConfirmation — le panneau se referme",
    fichier: CONFIRMATION,
    avant: "  cible.hidden = true;\n  noeud(declencheur)?.setAttribute",
    apres: "  noeud(declencheur)?.setAttribute",
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "la confirmation dit l'irréversible (#265)",
    garde: "MESSAGES.confirmationDeRevocation — la première phrase",
    fichier: TEXTES,
    avant: '    "Révoquer est irréversible : ce qui est retiré ne pourra pas être rendu. " +\n',
    apres: '    "" +\n',
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "la confirmation dit ce qui est retiré et ce qui reste (#265)",
    garde: "MESSAGES.confirmationDeRevocation — l'avertissement propre au moyen d'ouverture",
    fichier: TEXTES,
    avant:
      "    `${TEXTES_DE_LA_REVOCATION.avertissementDeRevocation(moyen, moyens, options)} Vos sauvegardes",
    apres: "    ` Vos sauvegardes",
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "la confirmation dit que les sauvegardes déjà faites ne changent pas (#265)",
    garde: "MESSAGES.confirmationDeRevocation — les sauvegardes",
    fichier: TEXTES,
    avant:
      "    \"pas : elles restent ouvrables par les anciens moyens. Rien n'est retiré tant que vous n'avez \" +\n",
    apres: "    \"pas. Rien n'est retiré tant que vous n'avez \" +\n",
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "l'ordre du DOM est l'ordre de l'écran : « Terminer sans révoquer » avant « Révoquer » (#265)",
    garde: "BLOCS — l'ordre des blocs du document",
    fichier: PARCOURS,
    avant: '  "sans-revoquer",\n  "revocation",\n',
    apres: '  "revocation",\n  "sans-revoquer",\n',
    epreuves: [EPREUVE_PARCOURS],
  },
  {
    nom: "le second geste de la révocation se ferme pendant un geste long (#265)",
    garde: "GESTES_LONGS — `revoquer-confirmer`",
    fichier: PARCOURS,
    avant: '  "revoquer-confirmer",\n',
    apres: "",
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "le premier bouton ne branche JAMAIS directement le geste (#265, relecture de #308)",
    garde: "brancherLesGestesDePortabilite — « Révoquer… » demande, il ne révoque pas",
    fichier: GESTES_PORTABILITE,
    avant: "  return Object.freeze({ sauvegarder, restaurer, revoquer });\n",
    apres:
      '  noeud("revoquer-en-urgence")?.addEventListener("click", () => void revoquer());\n  return Object.freeze({ sauvegarder, restaurer, revoquer });\n',
    epreuves: [EPREUVE_CONFIRMATION],
  },
  {
    nom: "une seule demande en vol : la confirmation ne se rouvre pas avant la réponse (#308)",
    garde: "brancherUneConfirmation — la garde de `demander`",
    fichier: CONFIRMATION,
    avant: "    if (ouverte() || enVol) return;\n",
    apres: "    if (ouverte()) return;\n",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "la demande est EN VOL dès « Oui » (#308)",
    garde: "brancherUneConfirmation — l'état « en vol » posé",
    fichier: CONFIRMATION,
    avant: "    enVol = true;\n",
    apres: "",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "la demande n'est plus en vol une fois la réponse connue (#308)",
    garde: "brancherUneConfirmation — l'état « en vol » levé",
    fichier: CONFIRMATION,
    avant: "      enVol = false;\n",
    apres: "",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "la demande reste en vol jusqu'à la RÉPONSE du Worker, pas jusqu'au retour du clic (#308)",
    garde: "brancherUneConfirmation — la promesse attendue",
    fichier: CONFIRMATION,
    avant: "      await confirmee();\n",
    apres: "      confirmee();\n",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "le geste en vol se dit désactivé (#308)",
    garde: "brancherUneConfirmation — `aria-disabled` posé",
    fichier: CONFIRMATION,
    avant: '    noeud(declencheur)?.setAttribute("aria-disabled", "true");\n',
    apres: "",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "la page dit « en cours » dès que la demande part (#308)",
    garde: "revoquerEnUrgence — l'état « en cours »",
    fichier: GESTES_PORTABILITE,
    avant: '  dire("revocation-etat", MESSAGES.revocationEnCours);\n',
    apres: "",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "le succès efface « en cours » (#308)",
    garde: "revoquerEnUrgence — l'état levé au succès",
    fichier: GESTES_PORTABILITE,
    avant:
      '    dire("revocation-etat", ""); // la réussite se dit par le parcours : « N moyen(s) retiré(s) »\n',
    apres: "",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "la confirmation compte les feuilles : l'autre feuille part avec le reste (#308)",
    garde: "lesAutresRetires — les autres feuilles ajoutées à la liste",
    fichier: MOYENS_NOMMES,
    avant: '  if (autresFeuilles) noms.push("vos autres codes de récupération");\n',
    apres: "",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "deux feuilles suffisent pour que la seconde parte (#308)",
    garde: "lesAutresRetires — le seuil du compte de codes",
    fichier: MOYENS_NOMMES,
    avant: 'typeof codes === "number" && codes > 1;',
    apres: 'typeof codes === "number" && codes > 2;',
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "une feuille de la SÉANCE n'est pas « autre » quand la séance est ouverte par la phrase (#308)",
    garde: "lesAutresRetires — l'autre feuille ne vaut que pour une séance ouverte par un code",
    fichier: MOYENS_NOMMES,
    avant: '  const autresFeuilles = moyen === "recuperation" && typeof',
    apres: "  const autresFeuilles = typeof",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "la page transmet le nombre de codes à la confirmation (#308)",
    garde: "suivreLaConfirmationDeRevocation — `nombreDeCodes`",
    fichier: CONFIRMEE,
    avant: "  const options = { codes: releve.nombreDeCodes ?? null };\n",
    apres: "  const options = { codes: null };\n",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "la demande de révocation dont le bloc a disparu est oubliée — l'APPEL de `oublierLaConfirmation` (#308)",
    garde: "suivreLaConfirmationDeRevocation — l'oubli d'une demande périmée",
    fichier: CONFIRMEE,
    avant:
      '  if (noeud("revocation-confirmation")?.closest("[data-bloc]")?.hidden !== true) return;\n',
    apres: "  return;\n",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "une demande dont le bloc est visible n'est pas oubliée (#308)",
    garde: "suivreLaConfirmationDeRevocation — la condition de l'oubli",
    fichier: CONFIRMEE,
    avant: "?.hidden !== true) return;",
    apres: "?.hidden === true) return;",
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "tout échec reçu après l'envoi dit « a peut-être eu lieu », refus typé compris (#308)",
    garde: "revoquerEnUrgence — l'issue d'un échec",
    fichier: GESTES_PORTABILITE,
    avant: '    dire("revocation-etat", MESSAGES.revocationIncertaine);\n',
    apres: '    dire("revocation-etat", "");\n',
    epreuves: [EPREUVE_EN_VOL],
  },
  {
    nom: "montrer les blocs oublie la demande dont le bloc a disparu — l'APPEL de `suivreLaConfirmationDeRevocation` (#308)",
    garde: "montrerLesBlocs — l'oubli d'une demande périmée",
    fichier: BLOCS_MONTRES,
    avant: "  suivreLaConfirmationDeRevocation({ noeud, dire, releve });\n",
    apres: "",
    epreuves: [EPREUVE_BLOCS],
  },
  {
    nom: "l'oubli lit l'état des blocs APRÈS les avoir posés, pas avant (#308)",
    garde: "montrerLesBlocs — l'ordre de l'appel",
    fichier: BLOCS_MONTRES,
    avant:
      'export function montrerLesBlocs({ doc, noeud, visibles, vueComplete, dire, releve }) {\n  for (const element of doc.querySelectorAll("[data-bloc]")) {\n    element.hidden = !vueComplete && !visibles.includes(element.dataset.bloc);\n  }\n  for (const id of SECTIONS) {\n    const section = noeud(id);\n    if (section === null) continue;\n    section.hidden =\n      !vueComplete && ![...section.querySelectorAll("[data-bloc]")].some((bloc) => !bloc.hidden);\n  }\n  suivreLaConfirmationDeRevocation({ noeud, dire, releve });\n}\n',
    apres:
      'export function montrerLesBlocs({ doc, noeud, visibles, vueComplete, dire, releve }) {\n  suivreLaConfirmationDeRevocation({ noeud, dire, releve });\n  for (const element of doc.querySelectorAll("[data-bloc]")) {\n    element.hidden = !vueComplete && !visibles.includes(element.dataset.bloc);\n  }\n  for (const id of SECTIONS) {\n    const section = noeud(id);\n    if (section === null) continue;\n    section.hidden =\n      !vueComplete && ![...section.querySelectorAll("[data-bloc]")].some((bloc) => !bloc.hidden);\n  }\n}\n',
    epreuves: [EPREUVE_BLOCS],
  },
  {
    nom: "un bloc non listé est caché hors vue complète, montré en vue complète (#308)",
    garde: "montrerLesBlocs — la vue complète du harnais",
    fichier: BLOCS_MONTRES,
    avant: "    element.hidden = !vueComplete && !visibles.includes(element.dataset.bloc);\n",
    apres: "    element.hidden = !visibles.includes(element.dataset.bloc);\n",
    epreuves: [EPREUVE_BLOCS],
  },
  {
    nom: "un code du chemin rend SA conduite, jamais la phrase générique",
    garde: "conduiteHumaine — la lecture de la table",
    fichier: "src/coquille/conduites-du-parcours.mjs",
    avant: "  if (conduite !== undefined) return conduite;\n",
    apres: "",
    epreuves: [EPREUVE_PARCOURS_CONDUITES],
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
