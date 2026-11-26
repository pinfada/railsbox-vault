#!/usr/bin/env node
// CAMPAGNE DE MUTATION de la RÉSERVE du Service Worker de la coquille (#299, lot D1h-b ; ADR 0048, annexe A).
//
//     node tools/muter-gardes-reserve.mjs [--json]
//
// Le moteur est celui de `tools/moteur-de-mutation.mjs`, partagé avec les autres campagnes. Ce fichier ne
// tient que sa TABLE : les 34 gardes de l'annexe A de l'ADR 0048, chacune RETIRÉE (ou inversée) DANS LE SOURCE
// DU PRODUIT — le script `tools/reserve/sw-coquille.js` que la publication instancie, les modules
// `src/coquille/reserve-*.mjs` que la page exécute, le générateur `tools/publier-reserve.mjs` — et l'épreuve
// NOMMÉE qui la porte doit rougir. Aucune épreuve textuelle de source n'est comptée ici : chaque mutant est tué
// par une épreuve qui EXÉCUTE le chemin de production (le SW dans un `vm`, le portail avec un
// `navigator.serviceWorker` factice).
//
// ## Règle des mutants (ADR 0048, annexe A)
//
// Zéro mutant pertinent survivant sur le source. Un mutant est tué s'il rougit une épreuve NOMMÉE. Un mutant
// allégué ÉQUIVALENT exige une preuve spécifique ; il n'y en a AUCUN dans cette table : tous sont tués.
//
// ## Ce que la campagne ne mesure pas
//
// Que ces gardes tiennent dans un VRAI navigateur relève des projets `reserve-*` de `playwright.config.mjs`
// (trois moteurs) et de `tests/e2e/hors-ligne.spec.mjs`. La garde « client `window` » (mutants de la
// vérification de source) est inatteignable depuis un Worker dédié sous Chromium, qui n'expose pas
// `navigator.serviceWorker` aux Workers dédiés : son épreuve navigateur rougit sous Firefox et WebKit
// (`tests/browser/reserve-messages.spec.mjs`), son épreuve unitaire — qui est l'épreuve NOMMÉE ici — rougit
// quel que soit le moteur.

import { fileURLToPath } from "node:url";

import { campagneDeMutation } from "./moteur-de-mutation.mjs";

const SW = "tools/reserve/sw-coquille.js";
const PORTAIL = "src/coquille/reserve-portail.mjs";
const DECISION = "src/coquille/reserve-decision.mjs";
const FRAICHEUR = "src/coquille/reserve-fraicheur.mjs";
const ETAT = "src/coquille/reserve-etat-partage.mjs";
const OBSERVATEUR = "src/coquille/reserve-observateur.mjs";
const INSTALLATION = "src/coquille/reserve-installation.mjs";
const IDENTITE = "src/coquille/reserve-identite.mjs";
const RETRAIT = "src/coquille/reserve-retrait.mjs";
const GENERATEUR = "tools/publier-reserve.mjs";
const CADRE = "public/coquille/cycle-de-la-page.mjs";

const T = {
  decision: "tests/unit/reserve-decision.test.mjs",
  service: "tests/unit/reserve-sw-service.test.mjs",
  installation: "tests/unit/reserve-sw-installation.test.mjs",
  garde: "tests/unit/reserve-sw-garde.test.mjs",
  messages: "tests/unit/reserve-sw-messages-et-retrait.test.mjs",
  portail: "tests/unit/reserve-portail.test.mjs",
  fraicheur: "tests/unit/reserve-fraicheur.test.mjs",
  etat: "tests/unit/reserve-etat-partage.test.mjs",
  retrait: "tests/unit/reserve-retrait.test.mjs",
  generateur: "tests/unit/reserve-generateur.test.mjs",
  bandeau: "tests/unit/reserve-bandeau.test.mjs",
  liste: "tests/unit/coquille-sans-service-worker.test.mjs",
};

/** `avant` doit apparaître EXACTEMENT UNE FOIS dans son fichier. Le numéro est celui de l'annexe A. */
export const MUTATIONS = Object.freeze([
  // --- 1 à 3 : vérifier, au service et à l'installation ---------------------------------------------
  {
    nom: "1 · le service ne recalcule pas le SHA-256",
    garde: "lireVerifiee — empreinte",
    fichier: SW,
    avant:
      '  if ((await sha256(octets)) !== entree.sha256) return { etat: "alteree", cause: "empreinte" };\n',
    apres: "",
    epreuves: [T.service],
  },
  {
    nom: "2a · la taille n'est pas comparée au service (effet observable : le hachage est appelé)",
    garde: "lireVerifiee — taille",
    fichier: SW,
    avant:
      '  if (octets.byteLength !== entree.taille) return { etat: "alteree", cause: "taille" };\n',
    apres: "",
    epreuves: [T.service],
  },
  {
    nom: "2b · la taille n'est pas comparée à l'installation",
    garde: "telechargerVerifie — taille",
    fichier: SW,
    avant:
      '  if (octets.byteLength !== entree.taille) throw new Error("taille différente pour " + chemin);\n',
    apres: "",
    epreuves: [T.installation],
  },
  {
    nom: "3 · l'installation accepte un écart d'empreinte",
    garde: "telechargerVerifie — empreinte",
    fichier: SW,
    avant:
      '  if ((await sha256(octets)) !== entree.sha256)\n    throw new Error("empreinte différente pour " + chemin);\n',
    apres: "",
    epreuves: [T.installation],
  },
  {
    nom: "4 · l'installation lit le cache HTTP (`no-store` retiré)",
    garde: "telechargerVerifie — cache no-store",
    fichier: SW,
    avant: '    cache: "no-store",\n',
    apres: "",
    epreuves: [T.installation],
  },
  {
    nom: "16 · l'installation suit les redirections (`redirect: error` → `follow`)",
    garde: "telechargerVerifie — redirect",
    fichier: SW,
    avant: '    redirect: "error",\n',
    apres: '    redirect: "follow",\n',
    epreuves: [T.installation],
  },
  {
    nom: "4b · l'installation envoie les identifiants",
    garde: "telechargerVerifie — credentials",
    fichier: SW,
    avant: '    credentials: "omit",\n',
    apres: "",
    epreuves: [T.installation],
  },
  // --- 5 à 10 : installation, identité de cache, activation ---------------------------------------
  {
    nom: "5 · un échec ne supprime pas le cache que CETTE installation a créé",
    garde: "installer — nettoyage après échec",
    fichier: SW,
    avant: "    if (!existait) await caches.delete(NOM_DU_CACHE);\n",
    apres: "",
    epreuves: [T.installation],
  },
  {
    nom: "5b · un échec supprime aussi un cache qui préexistait",
    garde: "installer — nettoyage après échec",
    fichier: SW,
    avant: "    if (!existait) await caches.delete(NOM_DU_CACHE);\n",
    apres: "    await caches.delete(NOM_DU_CACHE);\n",
    epreuves: [T.installation],
  },
  {
    nom: "6 · `skipWaiting()` automatique à l'installation",
    garde: "install — skipWaiting",
    fichier: SW,
    avant: "  evenement.waitUntil(installer());\n",
    apres: "  self.skipWaiting();\n  evenement.waitUntil(installer());\n",
    epreuves: [T.installation, T.messages],
  },
  {
    nom: "7 · `clients.claim()` à l'activation",
    garde: "activate — claim",
    fichier: SW,
    avant: "  evenement.waitUntil(CONFIG.retrait ? retirer() : nettoyer());\n",
    apres:
      "  self.clients.claim();\n  evenement.waitUntil(CONFIG.retrait ? retirer() : nettoyer());\n",
    epreuves: [T.installation],
  },
  {
    nom: "8 · le nom du cache n'est pas dérivé du contenu (nommé par la séquence)",
    garde: "NOM_DU_CACHE",
    fichier: SW,
    avant: "const NOM_DU_CACHE = PREFIXE_DE_CACHE + CONFIG.identite;",
    apres: "const NOM_DU_CACHE = PREFIXE_DE_CACHE + CONFIG.sequence;",
    epreuves: [T.installation],
  },
  {
    nom: "9 · `caches.delete` d'un cache existant à l'installation",
    garde: "installer — jamais d'écrasement",
    fichier: SW,
    avant: "  const existait = await caches.has(NOM_DU_CACHE);\n",
    apres:
      "  const existait = await caches.has(NOM_DU_CACHE);\n  await caches.delete(NOM_DU_CACHE);\n",
    epreuves: [T.installation],
  },
  {
    nom: "10a · l'activation supprime son propre cache",
    garde: "nettoyer — nom !== NOM_DU_CACHE",
    fichier: SW,
    avant: "    if (nom !== NOM_DU_CACHE && estDuProduit(nom)) await caches.delete(nom);\n",
    apres: "    if (estDuProduit(nom)) await caches.delete(nom);\n",
    epreuves: [T.installation],
  },
  {
    nom: "10b · l'activation supprime tout cache d'un autre préfixe",
    garde: "nettoyer — estDuProduit",
    fichier: SW,
    avant: "    if (nom !== NOM_DU_CACHE && estDuProduit(nom)) await caches.delete(nom);\n",
    apres: "    if (nom !== NOM_DU_CACHE) await caches.delete(nom);\n",
    epreuves: [T.installation],
  },
  // --- 11 à 17 : la garde fermée --------------------------------------------------------------------
  {
    nom: "11 · `/artifacts/**` servi par le SW (réponse fabriquée au lieu du passage)",
    garde: "fetch — passage des artefacts",
    fichier: SW,
    avant:
      '      requete.method === "GET" ? passer(requete, url) : refus("PASSAGE_METHODE", requete.method),\n',
    apres:
      '      requete.method === "GET" ? servir(chemin) : refus("PASSAGE_METHODE", requete.method),\n',
    epreuves: [T.garde],
  },
  {
    nom: "12a · le passage ne contrôle pas la destination",
    garde: "passer — destination exécutable",
    fichier: SW,
    avant: "  if (DESTINATIONS_EXECUTABLES.has(requete.destination)) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.garde],
  },
  {
    nom: "12b · le passage ne contrôle pas le chemin (%2e, %2f, %5c, %00)",
    garde: "passer — chemin suspect",
    fichier: SW,
    avant:
      '  if (cheminSuspect(url.pathname)) return refus("PASSAGE_CHEMIN_SUSPECT", url.pathname);\n',
    apres: "",
    epreuves: [T.garde],
  },
  {
    nom: "12c · le passage suit les redirections",
    garde: "passer — redirect manual",
    fichier: SW,
    avant: '    reponse = await fetch(new Request(requete, { redirect: "manual" }));',
    apres: '    reponse = await fetch(new Request(requete, { redirect: "follow" }));',
    epreuves: [T.garde],
  },
  {
    nom: "12d · le passage rend une redirection au lieu de la refuser",
    garde: "passer — redirection refusée",
    fichier: SW,
    avant:
      '  if (reponse.type === "opaqueredirect" || (reponse.status >= 300 && reponse.status < 400)) {\n',
    apres: "  if (false) {\n",
    epreuves: [T.garde],
  },
  {
    nom: "12e · le passage ne contrôle pas le type de la réponse",
    garde: "passer — type exécutable",
    fichier: SW,
    avant: '  if (interdit.test(type)) return refus("PASSAGE_TYPE_EXECUTABLE", type);\n',
    apres: "",
    epreuves: [T.garde],
  },
  {
    nom: "12f · sous `/artifacts/`, le type wasm n'est plus refusé",
    garde: "TYPES_REFUSES_SOUS_ARTIFACTS — wasm",
    fichier: SW,
    avant: "const TYPES_REFUSES_SOUS_ARTIFACTS = /(javascript|ecmascript|wasm|html|xml|css)/i;",
    apres: "const TYPES_REFUSES_SOUS_ARTIFACTS = /(javascript|ecmascript|html|xml|css)/i;",
    epreuves: [T.garde],
  },
  {
    nom: "12g · le passage nommé refuse aussi le wasm (v86.wasm n'est plus servi)",
    garde: "TYPES_REFUSES_EN_PASSAGE_NOMME — wasm",
    fichier: SW,
    avant: "const TYPES_REFUSES_EN_PASSAGE_NOMME = /(javascript|ecmascript|html|xml|css)/i;",
    apres: "const TYPES_REFUSES_EN_PASSAGE_NOMME = /(javascript|ecmascript|wasm|html|xml|css)/i;",
    epreuves: [T.garde],
  },
  {
    nom: "12h · un échec réseau du passage devient une réponse fabriquée (la sonde « injoignable » mentirait)",
    garde: "passer — Response.error()",
    fichier: SW,
    avant:
      "    return Response.error(); // réseau coupé : l'échec reste un échec RÉSEAU (`TypeError` côté page)\n",
    apres: '    return refus("PASSAGE_RESEAU", url.pathname);\n',
    epreuves: [T.garde],
  },
  {
    nom: "13 · « hors liste → réseau »",
    garde: "fetch — HORS_LISTE",
    fichier: SW,
    avant: '  evenement.respondWith(refus("HORS_LISTE", chemin));\n',
    apres: "  return;\n",
    epreuves: [T.garde],
  },
  {
    nom: "14 · « hors origine → réseau »",
    garde: "fetch — HORS_ORIGINE",
    fichier: SW,
    avant: '    evenement.respondWith(refus("HORS_ORIGINE", url.origin));\n',
    apres: "",
    epreuves: [T.garde],
  },
  {
    nom: "15 · les en-têtes d'une page ne viennent plus de la liste (CSP omise)",
    garde: "entetesDe — profil embarqué",
    fichier: SW,
    avant: "  const entetes = new Headers(CONFIG.profils[entree.profil]);\n",
    apres: "  const entetes = new Headers();\n",
    epreuves: [T.service],
  },
  {
    nom: "17 · la clé de la liste inclut la chaîne de requête",
    garde: "fetch — clé = chemin exact",
    fichier: SW,
    avant: "  const chemin = url.pathname;\n",
    apres: "  const chemin = url.pathname + url.search;\n",
    epreuves: [T.service],
  },
  {
    nom: "17b · la méthode n'est pas contrôlée sur une entrée listée",
    garde: "fetch — GET seulement",
    fichier: SW,
    avant: '      requete.method === "GET" ? servir(cible) : refus("METHODE", requete.method),\n',
    apres: "      servir(cible),\n",
    epreuves: [T.garde],
  },
  // --- 18 : messages ---------------------------------------------------------------------------------
  {
    nom: "18a · messages acceptés de tous les clients (le type de la source n'est pas contrôlé)",
    garde: "messageValide — source.type === window",
    fichier: SW,
    avant: '    source.type === "window" &&\n',
    apres: "",
    epreuves: [T.messages],
  },
  {
    nom: "18b · messages acceptés d'un cadre (frameType non contrôlé)",
    garde: "messageValide — frameType top-level",
    fichier: SW,
    avant: '    source.frameType === "top-level" &&\n',
    apres: "",
    epreuves: [T.messages],
  },
  {
    nom: "18c · le vocabulaire n'est plus fermé : `activer` est admis",
    garde: "TYPES_DE_MESSAGE",
    fichier: SW,
    avant: 'const TYPES_DE_MESSAGE = ["version", "verifier", "reparer", "clients", "journal"];',
    apres:
      'const TYPES_DE_MESSAGE = ["version", "verifier", "reparer", "clients", "journal", "activer"];',
    epreuves: [T.messages],
  },
  {
    nom: "18d · un champ de plus est admis dans un message",
    garde: "messageValide — champs fermés",
    fichier: SW,
    avant: '    Object.keys(donnees).every((cle) => cle === "type" || cle === "id") &&\n',
    apres: "",
    epreuves: [T.messages],
  },
  {
    nom: "18e · un `id` de plus de 64 caractères est admis",
    garde: "messageValide — id borné",
    fichier: SW,
    avant:
      '    (donnees.id === undefined || (typeof donnees.id === "string" && donnees.id.length <= 64)) &&\n',
    apres: "",
    epreuves: [T.messages],
  },
  {
    nom: "18f · un message sans port (ou avec deux) est admis",
    garde: "messageValide — un seul port",
    fichier: SW,
    avant: "    evenement.ports?.length === 1\n",
    apres: "    true\n",
    epreuves: [T.messages],
  },
  {
    nom: "18g · un message mal formé n'est plus compté",
    garde: "message — messagesRefuses",
    fichier: SW,
    avant: "    journal.messagesRefuses += 1;\n",
    apres: "",
    epreuves: [T.messages],
  },
  // --- 29, 30, 31 : retrait, migration, réparation -----------------------------------------------------
  {
    nom: "29a · le script de retrait ne vide pas les caches",
    garde: "retirer — caches",
    fichier: SW,
    avant:
      "  for (const nom of await caches.keys()) if (estDuProduit(nom)) await caches.delete(nom);\n  await self.registration.unregister();",
    apres: "  await self.registration.unregister();",
    epreuves: [T.messages],
  },
  {
    nom: "29b · le script de retrait désinscrit AVANT de vider les caches (ordre inversé)",
    garde: "retirer — ordre caches puis désinscription",
    fichier: SW,
    avant:
      "  for (const nom of await caches.keys()) if (estDuProduit(nom)) await caches.delete(nom);\n  await self.registration.unregister();",
    apres:
      "  await self.registration.unregister();\n  for (const nom of await caches.keys()) if (estDuProduit(nom)) await caches.delete(nom);",
    epreuves: [T.messages],
  },
  {
    nom: "29c · le script de retrait vide TOUS les caches de l'origine",
    garde: "retirer — préfixe",
    fichier: SW,
    avant:
      "  for (const nom of await caches.keys()) if (estDuProduit(nom)) await caches.delete(nom);\n  await self.registration.unregister();",
    apres:
      "  for (const nom of await caches.keys()) await caches.delete(nom);\n  await self.registration.unregister();",
    epreuves: [T.messages],
  },
  {
    nom: "29d · le geste de la personne vide TOUS les caches de l'origine",
    garde: "retirerLaCopie — préfixe",
    fichier: RETRAIT,
    avant:
      "    if ([PREFIXE_DE_CACHE, ...prefixesAnciens].some((prefixe) => nom.startsWith(prefixe))) {\n",
    apres: "    if (true) {\n",
    epreuves: [T.retrait],
  },
  {
    nom: "29e · le geste désinscrit l'inscription de la racine sans vérifier son script",
    garde: "retirerLaCopie — scriptURL",
    fichier: RETRAIT,
    avant: "    inscription !== undefined && estLInscriptionDeLaCoquille(inscription)\n",
    apres: "    inscription !== undefined\n",
    epreuves: [T.retrait],
  },
  {
    nom: "29f · le geste désinscrit toute inscription de l'origine (`getRegistrations`)",
    garde: "retirerLaCopie — bornée à la coquille",
    fichier: RETRAIT,
    avant:
      '  const inscription = await conteneur.getRegistration("/").catch(() => undefined);\n  const supprimes = [];',
    apres:
      '  const inscription = await conteneur.getRegistration("/").catch(() => undefined);\n  for (const autre of await conteneur.getRegistrations()) await autre.unregister();\n  const supprimes = [];',
    epreuves: [T.retrait],
  },
  {
    nom: "29g · le geste ne vérifie pas que l'inscription est à la racine",
    garde: "estLInscriptionDeLaCoquille — portée",
    fichier: RETRAIT,
    avant: '    if (new URL(inscription.scope).pathname !== "/") return false;\n',
    apres: "",
    epreuves: [T.retrait],
  },
  {
    nom: "30 · la migration supprime un cache d'un préfixe NON listé",
    garde: "estDuProduit — anciens préfixes nommés",
    fichier: SW,
    avant: "CONFIG.prefixesAnciens.some((prefixe) => nom.startsWith(prefixe))",
    apres: 'nom.startsWith("coquille-")',
    epreuves: [T.installation],
  },
  {
    nom: "31a · `reparer` écrit une entrée sans la vérifier",
    garde: "completer — telechargerVerifie",
    fichier: SW,
    avant: "      const octets = await telechargerVerifie(chemin);\n",
    apres: "      const octets = await (await fetch(chemin)).arrayBuffer();\n",
    epreuves: [T.messages],
  },
  {
    nom: "31b · `reparer` active une version (`skipWaiting`)",
    garde: "message reparer — n'active rien",
    fichier: SW,
    avant: "        .then((cache) => completer(cache, true))\n",
    apres:
      "        .then((cache) => {\n          self.skipWaiting();\n          return completer(cache, true);\n        })\n",
    epreuves: [T.messages],
  },
  // --- 19 à 23 : le portail --------------------------------------------------------------------------
  {
    nom: "19 · portail sans test de l'API",
    garde: "ouvrirLePortail — « serviceWorker » in navigator",
    fichier: PORTAIL,
    avant:
      '  if (!("serviceWorker" in navigateur)) return refuser(C.reserveAbsente, "api-absente");\n',
    apres: "",
    epreuves: [T.portail],
  },
  {
    nom: "20a · le portail n'attend pas `update()`",
    garde: "verifier — update()",
    fichier: OBSERVATEUR,
    avant: '  let issue = await Promise.race([miseAJour, apresUnDelai(delaiMs, "delai")]);\n',
    apres: '  let issue = "ok";\n',
    epreuves: [T.portail],
  },
  {
    nom: "20b · le portail n'attend pas l'installation que `update()` a déclenchée",
    garde: "verifier — installation réglée",
    fichier: OBSERVATEUR,
    avant: '  if (issue === "ok" && ctx.registration.installing) {\n',
    apres: "  if (false) {\n",
    epreuves: [T.portail],
  },
  {
    nom: "21a · portail sans re-contrôle du contrôleur avant la création",
    garde: "dernière garde — contrôleur",
    fichier: PORTAIL,
    avant:
      '  if (conteneur.controller !== controleur || etatPartage.controleurChange()) {\n    return refuser(C.reserveDivergente, "controleur-change", { fraicheur: fraiche.etat });\n  }\n',
    apres: "",
    epreuves: [T.portail],
  },
  {
    nom: "21b · portail sans poignée de main de séquence",
    garde: "apresLaCreation — séquence annoncée",
    fichier: PORTAIL,
    avant: "  if (annonce.sequence !== sequencePage) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.portail],
  },
  {
    nom: "21c · portail sans vérification complète de la réserve (entrées manquantes)",
    garde: "decider — manquants",
    fichier: DECISION,
    avant: "  if (verification.manquants?.length > 0) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.decision, T.portail],
  },
  {
    nom: "21d · portail sans vérification complète de la réserve (entrées altérées)",
    garde: "decider — alteres",
    fichier: DECISION,
    avant: "  if (verification.alteres?.length > 0) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.decision, T.portail],
  },
  {
    nom: "21e · portail ignorant la révocation connue",
    garde: "decider — fraicheur révoquée",
    fichier: DECISION,
    avant: "  if (fraicheur === E.REVOCATION_CONNUE) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.decision, T.portail],
  },
  {
    nom: "21f · portail contourné sans SW (aucun contrôleur → autorisé)",
    garde: "ouvrirLePortail — contrôleur",
    fichier: PORTAIL,
    avant: "  if (!controleur) return sansControleur({ conteneur, etatPartage, delais: ctx.d });\n",
    apres:
      "  if (!controleur) return { autorise: true, travailleur: branchement.creerLeTravailleur() };\n",
    epreuves: [T.portail],
  },
  {
    nom: "21g · portail sans la poignée de séquence du contrôleur (identité ignorée)",
    garde: "decider — séquence du contrôleur",
    fichier: DECISION,
    avant:
      '  if (identite.sequence !== sequencePage) return refuser(C.reserveDivergente, "sequence");\n',
    apres: "",
    epreuves: [T.decision, T.portail],
  },
  {
    nom: "21h · un SW muet est tenu pour sain (silence ignoré)",
    garde: "decider — identité absente",
    fichier: DECISION,
    avant:
      '  if (identite === null || identite === undefined)\n    return refuser(C.reserveAbsente, "silence-du-sw");\n',
    apres: "",
    epreuves: [T.decision, T.portail],
  },
  {
    nom: "21i · le portail ne tente pas la première installation (aucune inscription → refus muet)",
    garde: "premiereInstallation — register",
    fichier: INSTALLATION,
    avant:
      '      existante ?? (await conteneur.register(URL_DU_SW, { scope: "/", updateViaCache: "none" }));',
    apres: "      existante;",
    epreuves: [T.portail],
  },
  {
    nom: "21j · un script de retrait actif sans contrôleur n'est pas reconnu (dit « absente »)",
    garde: "sansControleur — retrait",
    fichier: INSTALLATION,
    avant: "    if (identite?.retrait === true) {\n",
    apres: "    if (false) {\n",
    epreuves: [T.portail],
  },
  {
    nom: "22 · portail évalué UNE SEULE fois par page",
    garde: "ouvrirLePortail — à chaque création",
    fichier: PORTAIL,
    avant: "    ouvrirLePortail: (branchement) => ouvrirLePortail(ctx, branchement),\n",
    apres:
      "    ouvrirLePortail: (branchement) => (ctx.premier ??= ouvrirLePortail(ctx, branchement)),\n",
    epreuves: [T.portail],
  },
  {
    nom: "23 · observateur de fraîcheur retiré après la décision du portail",
    garde: "suivre — observateur permanent",
    fichier: OBSERVATEUR,
    avant: "function suivre(ctx, worker) {\n  if (!worker) return Promise.resolve();\n",
    apres:
      'function suivre(ctx, worker) {\n  if (!worker) return Promise.resolve();\n  if (ctx.maj !== "non-tentee" && ctx.maj !== "en-cours") return Promise.resolve();\n',
    epreuves: [T.portail],
  },
  // --- 24, 25 : fraîcheur ------------------------------------------------------------------------------
  {
    nom: "24a · une attente MUETTE est classée « prête »",
    garde: "etatDeFraicheur — attente muette",
    fichier: FRAICHEUR,
    avant: "  if (attente && attente.muet === true) return E.ATTENTE_MUETTE;\n",
    apres: "  if (attente && attente.muet === true) return E.MISE_A_JOUR_PRETE;\n",
    epreuves: [T.fraicheur, T.portail],
  },
  {
    nom: "24b · l'observateur donne une identité fictive « prête » à une attente muette",
    garde: "identifierLAttente — muet",
    fichier: OBSERVATEUR,
    avant: "      : { muet: true };\n",
    apres:
      "      : { muet: false, sequence: ctx.sequenceCourante + 1, plancher: 0, retrait: false };\n",
    epreuves: [T.portail],
  },
  {
    nom: "25a · une version plus ancienne ou égale est classée « prête »",
    garde: "etatDeFraicheur — séquence supérieure",
    fichier: FRAICHEUR,
    avant: "attente.sequence > sequenceCourante ? E.MISE_A_JOUR_PRETE : E.VERSION_DIFFERENTE",
    apres: "E.MISE_A_JOUR_PRETE",
    epreuves: [T.fraicheur, T.portail],
  },
  {
    nom: "25b · une version de séquence ÉGALE est classée « prête » (`>` → `>=`)",
    garde: "etatDeFraicheur — séquence strictement supérieure",
    fichier: FRAICHEUR,
    avant: "attente.sequence > sequenceCourante ? E.MISE_A_JOUR_PRETE",
    apres: "attente.sequence >= sequenceCourante ? E.MISE_A_JOUR_PRETE",
    epreuves: [T.fraicheur, T.portail],
  },
  {
    nom: "24c · la révocation connue ne passe plus avant l'incertitude (priorité)",
    garde: "etatDeFraicheur — priorité",
    fichier: FRAICHEUR,
    avant:
      "  if (causeDeLaRevocation(attente, sequenceCourante) !== null) return E.REVOCATION_CONNUE;\n",
    apres: "",
    epreuves: [T.fraicheur, T.portail],
  },
  {
    nom: "24d · un plancher égal à la séquence courante est une révocation (`>` → `>=`)",
    garde: "causeDeLaRevocation — plancher",
    fichier: FRAICHEUR,
    avant: '  return attente.plancher > sequenceCourante ? "plancher" : null;\n',
    apres: '  return attente.plancher >= sequenceCourante ? "plancher" : null;\n',
    epreuves: [T.fraicheur],
  },
  // --- 26, 27, 28 : noms, liste blanche, enregistrement ------------------------------------------------
  {
    nom: "26 · le nom du script du SW change",
    garde: "URL_DU_SW",
    fichier: IDENTITE,
    avant: 'export const URL_DU_SW = "/sw-coquille.mjs";',
    apres: 'export const URL_DU_SW = "/sw.mjs";',
    epreuves: [T.bandeau],
  },
  {
    nom: "26b · le préfixe de cache change dans le modèle du SW",
    garde: "PREFIXE_DE_CACHE (SW)",
    fichier: SW,
    avant: 'const PREFIXE_DE_CACHE = "reserve-";',
    apres: 'const PREFIXE_DE_CACHE = "coquille-";',
    epreuves: [T.bandeau],
  },
  {
    nom: "27 · la liste blanche d'enregistrement est élargie (un second appelant)",
    garde: "liste blanche — un seul appelant de register",
    fichier: CADRE,
    avant: "export function creerCycle({",
    apres: 'navigator.serviceWorker.register("/autre-sw.js");\nexport function creerCycle({',
    epreuves: [T.liste],
  },
  {
    nom: "28a · `updateViaCache` laissé par défaut",
    garde: "register — updateViaCache none",
    fichier: INSTALLATION,
    avant: '{ scope: "/", updateViaCache: "none" }',
    apres: '{ scope: "/" }',
    epreuves: [T.portail],
  },
  {
    nom: "28b · la portée de l'enregistrement n'est plus la racine",
    garde: "register — scope",
    fichier: INSTALLATION,
    avant: '{ scope: "/", updateViaCache: "none" }',
    apres: '{ scope: "/coquille/", updateViaCache: "none" }',
    epreuves: [T.portail],
  },
  // --- 32, 33, 34 : l'état de révocation monotone ------------------------------------------------------
  {
    nom: "32a · l'état de révocation est remis à « inconnue » par un recalcul sans révocation",
    garde: "noter — monotone",
    fichier: ETAT,
    avant: "      if (cause === null && CAUSES.includes(nouvelle)) cause = nouvelle;\n",
    apres: "      cause = CAUSES.includes(nouvelle) ? nouvelle : null;\n",
    epreuves: [T.etat, T.portail],
  },
  {
    nom: "32b · une seconde cause remplace la première",
    garde: "noter — première cause gardée",
    fichier: ETAT,
    avant: "      if (cause === null && CAUSES.includes(nouvelle)) cause = nouvelle;\n",
    apres: "      if (CAUSES.includes(nouvelle)) cause = nouvelle;\n",
    epreuves: [T.etat],
  },
  {
    nom: "32c · une cause quelconque rend l'état « connu »",
    garde: "noter — causes nommées",
    fichier: ETAT,
    avant: "      if (cause === null && CAUSES.includes(nouvelle)) cause = nouvelle;\n",
    apres: "      if (cause === null && nouvelle) cause = nouvelle;\n",
    epreuves: [T.etat],
  },
  {
    nom: "32d · l'état de révocation est propre à chaque portail",
    garde: "ouvrirLePortail — état partagé",
    fichier: PORTAIL,
    avant: "  const { etatPartage, navigateur } = ctx;\n",
    apres: "  const { navigateur } = ctx;\n  const etatPartage = creerEtatPartage();\n",
    epreuves: [T.portail],
  },
  {
    nom: "33a · dernière garde absente (révocation connue pendant l'attente)",
    garde: "dernière garde — état de révocation",
    fichier: PORTAIL,
    avant:
      "  if (etatPartage.connue()) {\n    return refuser(C.reservePerimee, etatPartage.cause(), { fraicheur: E.REVOCATION_CONNUE });\n  }\n",
    apres: "",
    epreuves: [T.portail],
  },
  {
    nom: "33b · un `await` entre la lecture de l'état et `new Worker`",
    garde: "dernière garde — même tour",
    fichier: PORTAIL,
    avant: "  const travailleur = branchement.creerLeTravailleur();\n",
    apres: "  await Promise.resolve();\n  const travailleur = branchement.creerLeTravailleur();\n",
    epreuves: [T.portail],
  },
  {
    nom: "34 · l'observateur n'écrit pas dans l'état partagé (le bandeau change, pas l'état)",
    garde: "recalculer — noter",
    fichier: OBSERVATEUR,
    avant: "  ctx.etatPartage.noter(causeDeLaRevocation(ctx.attente, ctx.sequenceCourante));\n",
    apres: "",
    epreuves: [T.portail],
  },
  // --- Le générateur : liste = arbre − exclusions, identité = contenu -------------------------------------
  {
    nom: "G1 · l'identité de cache inclut la séquence",
    garde: "fabriquerLaReserve — identité",
    fichier: GENERATEUR,
    avant: "  const identite = sha256(JSON.stringify(lignes));\n",
    apres: "  const identite = sha256(JSON.stringify([lignes, sequence]));\n",
    epreuves: [T.generateur],
  },
  {
    nom: "G2 · l'identité de cache inclut le plancher",
    garde: "fabriquerLaReserve — identité",
    fichier: GENERATEUR,
    avant: "  const identite = sha256(JSON.stringify(lignes));\n",
    apres: "  const identite = sha256(JSON.stringify([lignes, plancher]));\n",
    epreuves: [T.generateur],
  },
  {
    nom: "G3 · l'identité ignore les en-têtes servis",
    garde: "fabriquerLaReserve — identité",
    fichier: GENERATEUR,
    avant:
      "    lignes.push([chemin, liste[chemin].taille, liste[chemin].sha256, liste[chemin].type, cle]);\n",
    apres:
      "    lignes.push([chemin, liste[chemin].taille, liste[chemin].sha256, liste[chemin].type]);\n",
    epreuves: [T.generateur],
  },
  {
    nom: "G4 · une surprise (fichier publié ni listé ni exclu) n'est plus refusée",
    garde: "fabriquerLaReserve — inconnus",
    fichier: GENERATEUR,
    avant: "  if (classes.inconnus.length > 0) {\n",
    apres: "  if (false) {\n",
    epreuves: [T.generateur],
  },
  {
    nom: "G5 · `/inventaire.json` n'est plus exclu de la réserve",
    garde: "EXCLUS_DE_LA_RESERVE — inventaire",
    fichier: GENERATEUR,
    avant: '    chemin: "/inventaire.json",\n',
    apres: '    chemin: "/inventaire-exclu-autre.json",\n',
    epreuves: [T.generateur],
  },
  {
    nom: "G6 · le script du SW lui-même entre dans la liste",
    garde: "EXCLUS_DE_LA_RESERVE — script du SW",
    fichier: GENERATEUR,
    avant: "    chemin: CHEMIN_DU_SW,\n",
    apres: '    chemin: "/sw-autre.mjs",\n',
    epreuves: [T.generateur],
  },
  {
    nom: "G7 · `/` n'est plus un alias de la page d'index",
    garde: "fabriquerLaReserve — alias",
    fichier: GENERATEUR,
    avant: '  const alias = liste["/index.html"] === undefined ? {} : { "/": "/index.html" };\n',
    apres: "  const alias = {};\n",
    epreuves: [T.generateur],
  },
  {
    nom: "G8 · un préfixe ancien non conforme (le préfixe produit) est admis",
    garde: "exigerLesPrefixes",
    fichier: GENERATEUR,
    avant:
      "      !/^[a-z0-9]+(-[a-z0-9]+)*-$/.test(prefixe) ||\n      prefixe === PREFIXE_DE_CACHE\n",
    apres: "      !/^[a-z0-9]+(-[a-z0-9]+)*-$/.test(prefixe)\n",
    epreuves: [T.generateur],
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
    campagneDeMutation({ mutations: MUTATIONS, etiquette: "reserve" }),
    process.argv.includes("--json"),
  );
  process.exitCode = resultats.every(({ tue }) => tue) ? 0 : 1;
}
