#!/usr/bin/env node
// CAMPAGNE DE MUTATION des gardes du DÉMARRAGE HORS CONNEXION (#247, lot D1g ; ADR 0044 § 6, ADR 0045).
//
//     node tools/muter-gardes-hors-ligne.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs`, partagé avec les autres campagnes. Ce fichier
// ne tient que sa TABLE.
//
// ## Pourquoi une campagne à part de `magasin`
//
// `magasin` tient les gardes du CACHE : rien n'est servi sans vérification. Celle-ci tient les gardes
// de la DÉCISION de démarrer sans l'origine — qui peut ruiner l'ADR 0042 sans qu'aucune tranche ne soit
// altérée : un repli ouvert par une réponse HTTP, un descripteur accepté sans sceau, une version
// antérieure admise, un descripteur rangé sur une réserve incomplète. Chaque garde ci-dessous est
// RETIRÉE du source ; l'épreuve qui la porte doit rougir.
//
// ## Ce que la campagne ne mesure pas
//
// Que le démarrage hors connexion aboutisse réellement, réseau coupé, sur les trois moteurs, relève de
// `tests/browser/descripteur-scelle-opfs.spec.mjs` (WebCrypto et OPFS réels) et de
// `tests/e2e/hors-ligne.spec.mjs` (image réelle). Le câblage de `public/runtime-worker.mjs` et de
// `demarrerLaVm` n'est mesuré que par l'E2E.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const SCELLE = "src/coquille/descripteur-scelle.mjs";
const HORS = "src/coquille/hors-connexion.mjs";
const APPLICATIF = "src/coquille/descripteur-applicatif.mjs";
const PREPARATION = "src/coquille/preparation-du-demarrage.mjs";
const ARTEFACTS = "src/vm/acquisition-des-artefacts.mjs";
const DISQUE = "src/vm/acquisition-du-disque-systeme.mjs";
const MAGASIN = "src/vm/magasin-d-artefacts.mjs";
const OPFS = "src/vm/magasin-opfs.mjs";
const CLE = "src/vm/derivation/cle-du-descripteur-scelle.mjs";
const BOOT = "src/vm/boot-de-reference.mjs";
const MAJ = "src/coquille/mise-a-jour-applicative.mjs";

const T = {
  scelle: "tests/unit/coquille-descripteur-scelle.test.mjs",
  hors: "tests/unit/coquille-hors-connexion.test.mjs",
  redirections: "tests/unit/coquille-descripteur-redirections.test.mjs",
  cle: "tests/unit/vm-cle-du-descripteur-scelle.test.mjs",
  demarrage: "tests/unit/coquille-demarrage-hors-connexion.test.mjs",
  preparation: "tests/unit/coquille-preparation-du-demarrage.test.mjs",
  petits: "tests/unit/vm-acquisition-des-petits-artefacts.test.mjs",
  disque: "tests/unit/vm-acquisition-disque-systeme.test.mjs",
  magasin: "tests/unit/vm-magasin-d-artefacts.test.mjs",
  opfs: "tests/unit/vm-magasin-opfs.test.mjs",
  empreintes: "tests/unit/coquille-empreintes-du-boot.test.mjs",
  intention: "tests/unit/coquille-intention-apres-acquisition.test.mjs",
};

/** `avant` doit apparaître EXACTEMENT UNE FOIS dans son fichier. */
export const MUTATIONS = Object.freeze([
  // --- « Injoignable » : un TypeError de fetch, et rien d'autre ----------------------------------
  {
    nom: "injoignable = un TypeError de fetch, pas n'importe quelle erreur",
    garde: "estInjoignable",
    fichier: APPLICATIF,
    avant: "export const estInjoignable = (erreur) => erreur instanceof TypeError;\n",
    apres: "export const estInjoignable = () => true;\n",
    epreuves: [T.hors],
  },
  {
    nom: "injoignable n'est pas « toute instance d'Error »",
    garde: "estInjoignable — l'erreur ordinaire",
    fichier: APPLICATIF,
    avant: "export const estInjoignable = (erreur) => erreur instanceof TypeError;\n",
    apres: "export const estInjoignable = (erreur) => erreur instanceof Error;\n",
    epreuves: [T.hors],
  },
  {
    nom: "une réponse HTTP en échec (5xx) n'ouvre pas le repli",
    garde: "lireLeDescripteur — !reponse.ok",
    fichier: APPLICATIF,
    avant:
      "  if (!reponse.ok) {\n    return { present: false, motif: `aucun descripteur servi (${reponse.status})` };\n",
    apres:
      "  if (!reponse.ok) {\n    if (repliHorsConnexion !== undefined) return repliHorsConnexion();\n    return { present: false, motif: `aucun descripteur servi (${reponse.status})` };\n",
    epreuves: [T.hors],
  },
  {
    nom: "du HTML de portail captif n'ouvre pas le repli",
    garde: "lireLeDescripteur — le JSON illisible",
    fichier: APPLICATIF,
    avant: '  } catch {\n    return { present: false, motif: "descripteur illisible" };\n',
    apres:
      '  } catch {\n    if (repliHorsConnexion !== undefined) return repliHorsConnexion();\n    return { present: false, motif: "descripteur illisible" };\n',
    epreuves: [T.hors],
  },
  // --- Une redirection est une réponse de l'origine (revue de #298, constat 1) ------------------
  {
    nom: "le descripteur est demandé en `redirect: manual` : une boucle de 302 n'est pas un TypeError",
    garde: "lireLeDescripteur — redirect: manual",
    fichier: APPLICATIF,
    avant: '{ cache: "no-store", redirect: "manual" }',
    apres: '{ cache: "no-store" }',
    epreuves: [T.redirections],
  },
  {
    nom: "une redirection est classée « redirigé », jamais lue ni confondue avec le réseau",
    garde: "lireLeDescripteur — estUneRedirection",
    fichier: APPLICATIF,
    avant: "  if (estUneRedirection(reponse)) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.redirections],
  },
  {
    nom: "une redirection opaque (navigateur, statut 0) est reconnue",
    garde: "estUneRedirection — opaqueredirect",
    fichier: APPLICATIF,
    avant: '  reponse.type === "opaqueredirect" || (reponse.status',
    apres: "  false || (reponse.status",
    epreuves: [T.redirections],
  },
  {
    nom: "une redirection 3xx (Node) est reconnue",
    garde: "estUneRedirection — statut 3xx",
    fichier: APPLICATIF,
    avant: "(reponse.status >= 300 && reponse.status < 400)",
    apres: "false",
    epreuves: [T.redirections],
  },
  // --- Le sceau : ni fabriqué, ni modifié, ni d'un autre coffre, ni d'une autre version ----------
  {
    nom: "le sceau HMAC est vérifié",
    garde: "ouvrirLeDescripteurScelle — authentique",
    fichier: SCELLE,
    avant: '  if (!authentique) throw new DescripteurRangeRefuse("sceau");\n',
    apres: "",
    epreuves: [T.scelle, T.hors],
  },
  {
    nom: "le sceau couvre la date : la magie, la date et la longueur sont sous le HMAC",
    garde: "ouvrirLeDescripteurScelle — avantLeSceau",
    fichier: SCELLE,
    avant: "  const avantLeSceau = octets.subarray(0, EN_TETE_OCTETS + longueur);\n",
    apres: "  const avantLeSceau = octets.subarray(EN_TETE_OCTETS, EN_TETE_OCTETS + longueur);\n",
    epreuves: [T.scelle],
  },
  {
    nom: "l'étiquette de domaine du scellement entre dans le MAC",
    garde: "donneesScellees — l'étiquette",
    fichier: SCELLE,
    avant: "  concatener(chainePrefixee(ETIQUETTE_DU_SCELLEMENT), avantLeSceau);\n",
    apres: "  avantLeSceau;\n",
    epreuves: [T.scelle],
  },
  {
    nom: "une autre version de format (magie) est refusée",
    garde: "ouvrirLeDescripteurScelle — la magie",
    fichier: SCELLE,
    avant: '  if (!porteLaMagie(octets)) throw new DescripteurRangeRefuse("format");\n',
    apres: "",
    epreuves: [T.scelle],
  },
  {
    nom: "la charge démesurée est refusée avant le sceau",
    garde: "ouvrirLeDescripteurScelle — TAILLE_MAX_DE_LA_CHARGE",
    fichier: SCELLE,
    avant: "    longueur > TAILLE_MAX_DE_LA_CHARGE ||\n",
    apres: "",
    epreuves: [T.scelle],
  },
  {
    nom: "la longueur annoncée doit être exactement celle du fichier",
    garde: "ouvrirLeDescripteurScelle — octets.byteLength",
    fichier: SCELLE,
    avant: "    octets.byteLength !== EN_TETE_OCTETS + longueur + TAILLE_DU_SCEAU\n",
    apres: "    false\n",
    epreuves: [T.scelle],
  },
  {
    nom: "la forme du descripteur scellé est contrôlée même sous un sceau juste",
    garde: "ouvrirLeDescripteurScelle — formeDuDescripteur",
    fichier: SCELLE,
    avant: "    !formeDuDescripteur(charge?.descripteur).valide ||\n",
    apres: "",
    epreuves: [T.scelle],
  },
  {
    nom: "la forme du manifeste v86 scellé est contrôlée",
    garde: "ouvrirLeDescripteurScelle — formeDuManifesteV86",
    fichier: SCELLE,
    avant: "    !formeDuManifesteV86(charge?.manifesteV86)\n",
    apres: "    false\n",
    epreuves: [T.scelle],
  },
  {
    nom: "la date doit être un entier sûr",
    garde: "ouvrirLeDescripteurScelle — rangeLe",
    fichier: SCELLE,
    avant: "    !Number.isSafeInteger(rangeLe) ||\n",
    apres: "",
    epreuves: [T.scelle],
  },
  // --- La clé : dans son domaine, non extractible, jamais la DEK directement ---------------------
  {
    nom: "la clé de scellement n'est pas extractible",
    garde: "deriverCleDeScellementDuDescripteur — extractable",
    fichier: CLE,
    avant: '    false,\n    ["sign", "verify"],\n',
    apres: '    true,\n    ["sign", "verify"],\n',
    epreuves: [T.cle],
  },
  {
    nom: "le domaine « descripteur » entre dans l'info HKDF",
    garde: "encoderInfoDuDescripteur — le domaine",
    fichier: CLE,
    avant: "    chainePrefixee(DOMAINE_DU_DESCRIPTEUR),\n",
    apres: "",
    epreuves: [T.cle],
  },
  {
    nom: "l'identifiant du coffre entre dans l'info HKDF",
    garde: "encoderInfoDuDescripteur — l'identifiant",
    fichier: CLE,
    avant: "    chainePrefixee(identifiantVolume),\n",
    apres: "",
    epreuves: [T.cle],
  },
  {
    nom: "la version du format entre dans l'info HKDF",
    garde: "encoderInfoDuDescripteur — la version",
    fichier: CLE,
    avant: "    entierEnOctets(versionDeFormat, 4),\n",
    apres: "",
    epreuves: [T.cle],
  },
  // --- Le repli : refus typés, clé effacée, rien « au mieux » -------------------------------------
  {
    nom: "une panne autre qu'un refus du descripteur se propage",
    garde: "repliHorsConnexion — le type de l'erreur",
    fichier: HORS,
    avant: "      if (!(erreur instanceof DescripteurRangeRefuse)) throw erreur;\n",
    apres: "",
    epreuves: [T.hors],
  },
  {
    nom: "la clé du coffre est effacée après la dérivation",
    garde: "cleDeScellement — dek.fill(0)",
    fichier: HORS,
    avant: "    dek.fill(0);\n",
    apres: "",
    epreuves: [T.hors],
  },
  {
    nom: "sans descripteur rangé, refus typé « sans copie »",
    garde: "repliHorsConnexion — octets absents",
    fichier: HORS,
    avant:
      "    if (octets === null || octets === undefined) return sansDescripteur(C.horsLigneSansCopie);\n",
    apres: "",
    epreuves: [T.hors, T.demarrage],
  },
  {
    nom: "le descripteur n'est rangé qu'après une acquisition COMPLÈTE",
    garde: "rangerLeDescripteur — complet",
    fichier: HORS,
    avant: "    if (complet !== true) {\n",
    apres: "    if (false) {\n",
    epreuves: [T.hors, T.preparation],
  },
  {
    nom: "« complet » doit être vrai, pas seulement « vrai-ish »",
    garde: "rangerLeDescripteur — complet !== true",
    fichier: HORS,
    avant: "    if (complet !== true) {\n",
    apres: "    if (complet === false) {\n",
    epreuves: [T.hors],
  },
  {
    nom: "hors connexion sans volume : refus typé, jamais « installer »",
    garde: "refusDuRepli — manifeste null",
    fichier: HORS,
    avant: "  return manifeste === null ? C.horsLigneSansCoffre : null;\n",
    apres: "  return null;\n",
    epreuves: [T.demarrage, T.preparation],
  },
  {
    nom: "un rangé refusé ou absent est un refus du repli",
    garde: "refusDuRepli — lu.present === false",
    fichier: HORS,
    avant: "  if (lu.present === false) return lu.code;\n",
    apres: "",
    epreuves: [T.demarrage],
  },
  {
    nom: "la page n'affiche une date que pour un rangé ACCEPTÉ",
    garde: "horsConnexionPublie — !lu.present",
    fichier: HORS,
    avant:
      "  if (lu.horsConnexion === undefined || lu.horsConnexion === true || !lu.present) return null;\n",
    apres: "  if (lu.horsConnexion === undefined) return null;\n",
    epreuves: [T.demarrage],
  },
  // --- La préparation : l'ordre des refus avant tout boot ----------------------------------------
  {
    nom: "injoignable sans rangé accepté : refus avant toute lecture du volume",
    garde: "lireEtPreparer — lu.horsConnexion && !lu.present",
    fichier: PREPARATION,
    avant: "  if (lu.horsConnexion === true && lu.present === false) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.preparation],
  },
  {
    nom: "hors connexion sans volume : le démarrage s'arrête avant l'installation",
    garde: "lireEtPreparer — refusDuRepli",
    fichier: PREPARATION,
    avant: "  if (refus !== null) return { rendu: refusDeDemarrage(refus, prepare) };\n",
    apres: "",
    epreuves: [T.preparation],
  },
  {
    nom: "la page : un refus du repli remplace toute décision de déphasage",
    garde: "constaterPourLaPage — refusDuRepli",
    fichier: PREPARATION,
    avant: "  if (refus !== null) return refusPublieHorsConnexion(refus);\n",
    apres: "",
    epreuves: [T.demarrage],
  },
  {
    nom: "hors connexion, le descripteur n'est pas re-rangé",
    garde: "rangementAvantLIntention — horsConnexion",
    fichier: PREPARATION,
    avant: "    if (horsConnexion !== null) return;\n",
    apres: "",
    epreuves: [T.preparation],
  },
  {
    nom: "le rangement reçoit ce que la réserve tient, pas toujours « vrai »",
    garde: "rangementAvantLIntention — complet: reserveComplete",
    fichier: PREPARATION,
    avant: "      complet: reserveComplete,\n",
    apres: "      complet: true,\n",
    epreuves: [T.preparation],
  },
  {
    nom: "le refus d'un artefact absent hors connexion est celui du registre",
    garde: "refusDeLArtefactAbsent",
    fichier: PREPARATION,
    avant: "  return erreur?.code === C.horsLigneArtefactAbsent ? erreur.code : null;\n",
    apres: "  return erreur?.code ?? null;\n",
    epreuves: [T.preparation],
  },
  {
    nom: "le rangement du descripteur précède l'intention de migrer",
    garde: "avantLeBootDuPaquet — avantLIntention",
    fichier: MAJ,
    avant: "    await avantLIntention?.(acquisition);\n",
    apres: "",
    epreuves: [T.intention],
  },
  {
    nom: "le crochet apprend si la réserve tient tout",
    garde: "preparerLeBoot — reserveComplete",
    fichier: BOOT,
    avant: "  await avantLeBoot?.({ reserveComplete: acquis.reserveComplete === true });\n",
    apres: "  await avantLeBoot?.({ reserveComplete: true });\n",
    epreuves: [T.intention],
  },
  // --- Les artefacts du démarrage : épinglés, servis par le magasin, jamais téléchargés hors ligne
  {
    nom: "hors connexion, un petit artefact absent est un refus, jamais un téléchargement",
    garde: "acquerirUnPetit — horsConnexion",
    fichier: ARTEFACTS,
    avant: "  if (horsConnexion) {\n    throw artefactAbsentHorsConnexion(",
    apres: "  if (false) {\n    throw artefactAbsentHorsConnexion(",
    epreuves: [T.petits],
  },
  {
    nom: "hors connexion, un morceau du disque absent est un refus, jamais un téléchargement",
    garde: "servirOuTelecharger — horsConnexion",
    fichier: DISQUE,
    avant: "  if (horsConnexion) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.disque],
  },
  {
    nom: "un petit artefact reçu est confronté à l'empreinte épinglée",
    garde: "verifierContreLEpingle — sha256",
    fichier: ARTEFACTS,
    avant: "  if (mesure !== pin.sha256) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.petits],
  },
  {
    nom: "un petit artefact reçu est confronté à la taille épinglée",
    garde: "verifierContreLEpingle — octets",
    fichier: ARTEFACTS,
    avant: "  if (octets.byteLength !== pin.octets) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.petits],
  },
  {
    nom: "sans empreinte épinglée, un artefact n'entre pas au magasin",
    garde: "acquerirUnPetit — pin null",
    fichier: ARTEFACTS,
    avant:
      '  if (pin === null) return { octets, transfere: octets.byteLength, magasin: "sans-empreinte" };\n',
    apres: "",
    epreuves: [T.petits],
  },
  {
    nom: "la réserve n'est complète que si TOUT y est",
    garde: "reserveTientTout",
    fichier: ARTEFACTS,
    avant: "  return petits.complet && Object.values(disque.magasin).every(dansLaReserve);\n",
    apres: "  return petits.complet;\n",
    epreuves: [T.preparation],
  },
  {
    nom: "un statut hors « servi/admis » n'est pas dans la réserve",
    garde: "DANS_LA_RESERVE",
    fichier: ARTEFACTS,
    avant: 'const DANS_LA_RESERVE = new Set(["servi", "admis"]);\n',
    apres: 'const DANS_LA_RESERVE = new Set(["servi", "admis", "sans-empreinte", "absent"]);\n',
    epreuves: [T.petits, T.preparation],
  },
  {
    nom: "les empreintes du boot sont tout-ou-rien, bien formées et bornées",
    garde: "formeDesEmpreintesDuBoot — l'empreinte",
    fichier: APPLICATIF,
    avant:
      '    if (!EMPREINTE.test(String(pin.sha256 ?? ""))) return `empreinte du boot mal formée : ${cle}`;\n',
    apres: "",
    epreuves: [T.empreintes],
  },
  {
    nom: "la taille d'un artefact du boot est bornée",
    garde: "formeDesEmpreintesDuBoot — octets",
    fichier: APPLICATIF,
    avant:
      "    if (!entierBorne(pin.octets, ARTEFACT_DE_BOOT_MAX))\n      return `taille du boot hors bornes : ${cle}`;\n",
    apres: "",
    epreuves: [T.empreintes],
  },
  {
    nom: "un artefact du boot inconnu est refusé",
    garde: "formeDesEmpreintesDuBoot — clés",
    fichier: APPLICATIF,
    avant: "  if (Object.keys(empreintes).some((cle) => !cles.includes(cle))) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.empreintes],
  },
  // --- Le magasin : le descripteur rangé remplace, ne s'ajoute pas, et survit à la purge ---------
  {
    nom: "le descripteur rangé est remplacé, sans reste de l'ancien",
    garde: "ecrireLeDescripteurScelle — supprimer avant renommer",
    fichier: MAGASIN,
    avant: "  await primitives.supprimer(NOM_DU_DESCRIPTEUR_SCELLE);\n  await primitives.renommer(",
    apres: "  await primitives.renommer(",
    epreuves: [T.opfs],
  },
  {
    nom: "un partiel de descripteur résiduel est repris à zéro",
    garde: "ecrireLeDescripteurScelle — supprimer le partiel",
    fichier: MAGASIN,
    avant: "  await primitives.supprimer(partiel);\n  if (jeton.annule) return false;\n",
    apres: "  if (jeton.annule) return false;\n",
    epreuves: [T.opfs],
  },
  {
    nom: "un rangement annulé avant écriture n'écrit rien",
    garde: "ecrireLeDescripteurScelle — jeton avant l'écriture",
    fichier: MAGASIN,
    avant: "  if (jeton.annule) return false;\n  await primitives.ecrire(partiel, 0, octets);\n",
    apres: "  await primitives.ecrire(partiel, 0, octets);\n",
    epreuves: [T.opfs],
  },
  {
    nom: "un rangement annulé après écriture ne remplace pas le descripteur rangé",
    garde: "ecrireLeDescripteurScelle — jeton avant le remplacement",
    fichier: MAGASIN,
    avant:
      "  if (jeton.annule) {\n    await primitives.supprimer(partiel);\n    return false;\n  }\n",
    apres: "",
    epreuves: [T.magasin],
  },
  {
    nom: "la purge ne retire pas le descripteur rangé",
    garde: "purger — NOM_DU_DESCRIPTEUR_SCELLE",
    fichier: MAGASIN,
    avant: "  const gardees = new Set([...garder, NOM_DU_DESCRIPTEUR_SCELLE]);\n",
    apres: "  const gardees = new Set(garder);\n",
    epreuves: [T.magasin, T.opfs],
  },
  {
    nom: "la rétention garde les petits artefacts courants",
    garde: "retenir — autres",
    fichier: OPFS,
    avant:
      "  return magasin.purger([rootfs, ...paquets, ...autres, JOURNAL_DE_RETENTION], jeton);\n",
    apres: "  return magasin.purger([rootfs, ...paquets, JOURNAL_DE_RETENTION], jeton);\n",
    epreuves: [T.opfs],
  },
  {
    nom: "une lecture courte du descripteur rangé le rend vide",
    garde: "lireLeDescripteurScelle — la longueur lue",
    fichier: MAGASIN,
    avant:
      "  if ((await primitives.lire(NOM_DU_DESCRIPTEUR_SCELLE, 0, octets)) !== taille) {\n    return new Uint8Array(0);\n  }\n",
    apres: "  await primitives.lire(NOM_DU_DESCRIPTEUR_SCELLE, 0, octets);\n",
    epreuves: [T.magasin, T.opfs],
  },
  {
    nom: "un descripteur rangé démesuré n'est pas chargé",
    garde: "lireLeDescripteurScelle — TAILLE_MAX_DU_DESCRIPTEUR_RANGE",
    fichier: MAGASIN,
    avant: "  if (taille > TAILLE_MAX_DU_DESCRIPTEUR_RANGE) return new Uint8Array(0);\n",
    apres: "",
    epreuves: [T.magasin],
  },
  {
    nom: "un magasin lent est « sans descripteur » : le démarrage hors connexion cède",
    garde: "borneDansLeTemps — lireLeDescripteurScelle",
    fichier: OPFS,
    avant:
      "      avantLEcheance(\n        () => magasin.lireLeDescripteurScelle(),\n        delaiMs,\n        () => null,\n      );\n",
    apres: "      magasin.lireLeDescripteurScelle();\n",
    epreuves: [T.opfs],
  },
  {
    nom: "le rangement du descripteur est borné par un jeton d'échéance",
    garde: "borneDansLeTemps — ecrireLeDescripteurScelle",
    fichier: OPFS,
    avant: "        (jeton) => magasin.ecrireLeDescripteurScelle(octets, jeton),\n",
    apres: "        () => magasin.ecrireLeDescripteurScelle(octets),\n",
    epreuves: [T.opfs],
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
    campagneDeMutation({ mutations: MUTATIONS, etiquette: "hors-ligne" }),
    process.argv.includes("--json"),
  );
  process.exitCode = resultats.every(({ tue }) => tue) ? 0 : 1;
}
