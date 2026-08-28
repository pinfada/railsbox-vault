// Banc d'attribution du boot à froid de l'image de référence.
//
// POURQUOI CE BANC PLUTÔT QUE `tools/vm/mesurer-boot.mjs`. Ce dernier ne rend
// qu'un total (`bootFroidMs`). L'ADR 0005 exige d'attribuer tout gain à une
// étape précise « et non à du bruit » : optimiser le boot de Rails sans savoir
// quelle étape a bougé, c'est déplacer un chiffre sans savoir ce qu'on a fait.
// Ce banc reproduit sous Node l'attribution que `repriseTimeline` publie côté
// navigateur (#60), pour que l'issue #66 puisse mesurer levier par levier sans
// toucher au banc du navigateur (`public/vm`, `tests/e2e`).
//
// CE QU'IL MESURE, ET CE QU'IL N'ESTIME PAS. Chaque jalon est un événement
// RÉELLEMENT OBSERVÉ : un octet reçu sur le port série, une ligne imprimée par
// `guest-init.sh`, une ligne de `puma.log` relayée par le pont, une réponse
// `200` de `/vault/health`. Un jalon jamais atteint reste `null` — il n'est
// jamais interpolé, et l'essai le dit.
//
// LA CAMPAGNE DOIT TOURNER SEULE. Une construction Docker lancée pendant une
// campagne fausse les essais qu'elle recouvre — constaté sur le premier relevé
// de #66, où deux essais ont été mesurés pendant un `npm run app:test` et ont dû
// être jetés. L'émulateur v86 tient sur un seul fil d'exécution : ce n'est pas
// le nombre de cœurs qui le protège, c'est l'absence de concurrent.
//
// TROIS BIAIS CONNUS, à ne pas oublier en lisant les chiffres :
//
//   1. le jalon « Puma prêt » vient de `puma.log`, que le pont série relit
//      toutes les secondes (`LOG_POLL_SECONDS`). Il porte donc un retard
//      pouvant aller jusqu'à ~1 s, plus la latence série. C'est négligeable
//      devant les dizaines de secondes du boot Rails, pas devant une seconde ;
//   2. la sonde `/vault/health` s'exécute toutes les 5 s. `santeMs` est donc
//      quantifié à 5 s près ; c'est `pumaPretMs` qui est l'instrument fin ;
//   3. les disques sont ici servis depuis la MÉMOIRE de Node, pas depuis OPFS.
//      La décomposition de #60 a établi que le montage OPFS coûte ~65 ms, donc
//      l'écart est petit — mais ce banc ne mesure pas la même chose que le banc
//      navigateur, et ses totaux ne s'y substituent pas.
//
// PROTOCOLE. Un essai = un PROCESSUS NODE NEUF (voir
// `mesurerDansUnProcessusNeuf`). Avec deux BRAS, les essais sont ENTRELACÉS
// (avant, après, avant, après…) et DEUX verdicts sont publiés côte à côte :
//
//   · le verdict MARGINAL, règle du gabarit de #86 — un écart de p50 ne compte
//     que s'il dépasse la plus grande étendue intra-série ;
//   · le verdict APPARIÉ — l'essai n de chaque bras est joué coup sur coup, la
//     dérive de la machine s'annule donc à l'intérieur d'une paire, et un gain
//     n'est affirmé que si TOUTES les paires vont dans le même sens.
//
// Les deux sont publiés parce qu'ils ne disent pas la même chose et qu'aucun
// des deux ne remplace l'autre : le marginal borne ce que la campagne entière
// permet d'affirmer, l'apparié voit un effet que l'étendue globale noierait.
//
// USAGE
//   # un seul relevé, sur l'image construite dans artifacts/reference-image/
//   node tools/mesurer-attribution-boot.mjs --essais=5 --etiquette=avant
//
//   # comparaison entrelacée de deux images, chacune avec son manifest.json
//   node tools/mesurer-attribution-boot.mjs --essais=5 --etiquette=bootsnap \
//     --bras=avant=artifacts/reference-image-avant \
//     --bras=apres=artifacts/reference-image
//
//   # rejuger un relevé déjà mesuré, sans rien remesurer
//   node tools/mesurer-attribution-boot.mjs --rejuger=reports/perf/attribution-bootsnap.json
//
// Le rapport est écrit dans `reports/perf/attribution-<etiquette>.json`.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { validerManifeste } from "./build-reference-image/manifest-contract.mjs";
import {
  CHEMIN_MANIFESTE,
  DOSSIER_ARTEFACTS,
  RACINE_DEPOT,
  demarrerVm,
  pause,
  raisonDIndisponibilite,
} from "./vm/boot-reference.mjs";
const DOSSIER_RAPPORTS = join(RACINE_DEPOT, "reports", "perf");
const BUDGET_MS = Number.parseInt(process.env.VAULT_VM_BUDGET_MS ?? "1200000", 10);
const INTERVALLE_SONDE_MS = 5_000;
const PAUSE_ENTRE_ESSAIS_MS = 5_000;

/** Préfixe de la ligne par laquelle un essai isolé rend son relevé au parent. */
const PREFIXE_RELEVE = "@ATTRIBUTION ";

/** Règle du gabarit de #86 : elle compare les p50 marginaux à l'étendue globale. */
const REGLE_MARGINALE =
  "|p50(après) − p50(avant)| > max(étendue intra-série des deux bras) ⇒ au-delà du bruit";

/** Règle appariée : elle exploite le fait que les essais sont joués coup sur coup. */
const REGLE_APPARIEE =
  "écart(essai n) = après(n) − avant(n) ; un gain n'est affirmé que si toutes les paires " +
  "vont dans le même sens (cinq paires : une chance sur trente-deux sous le seul hasard de signe)";

/**
 * Jalons cherchés dans le flux série, dans l'ordre où le guest les produit.
 *
 * Chaque motif vise une ligne que le guest imprime DÉJÀ : ce banc n'ajoute
 * aucune trace au guest, il lit ce qui existe. Le premier appariement gagne,
 * pour qu'un redémarrage de Puma en fin de boot ne réécrive pas le jalon.
 *
 * @type {{ clef: string, motif: RegExp, libelle: string }[]}
 */
const JALONS_SERIE = [
  {
    clef: "initMontageAppMs",
    motif: /^\[init\] montage du disque applicatif/,
    libelle: "init : montage du disque applicatif /dev/sdb",
  },
  {
    clef: "initLancementAppMs",
    motif: /^\[init\] lancement de l'application/,
    libelle: "init : lancement de start-app.sh",
  },
  {
    clef: "pontSeriePretMs",
    motif: /pont serie pret/,
    libelle: "pont série @VLT1 opérationnel",
  },
  {
    clef: "pumaBanniereMs",
    motif: /Puma starting in|\* Puma version/,
    libelle: "Puma : bannière imprimée",
  },
  {
    clef: "pumaEcouteMs",
    motif: /\* Listening on/,
    libelle: "Puma : socket en écoute",
  },
  {
    clef: "pumaPretMs",
    motif: /Use Ctrl-C to stop/,
    libelle: "Puma : boot terminé (prêt à servir)",
  },
];

/**
 * Étapes dérivées des jalons. Une étape dont l'une des bornes est `null` reste
 * `null` : mieux vaut un trou déclaré qu'une soustraction inventée.
 *
 * @type {{ clef: string, de: string | null, a: string, libelle: string }[]}
 */
const ETAPES = [
  {
    clef: "instanciationV86",
    de: null,
    a: "instanciationMs",
    libelle: "chargement du module v86, WebAssembly et contrôleur IDE",
  },
  {
    clef: "bios",
    de: "instanciationMs",
    a: "premierOctetSerieMs",
    libelle: "BIOS → premier octet série",
  },
  {
    clef: "noyauEtInit",
    de: "premierOctetSerieMs",
    a: "initMontageAppMs",
    libelle: "boot noyau → init (montage /app)",
  },
  {
    clef: "montageEtLancement",
    de: "initMontageAppMs",
    a: "initLancementAppMs",
    libelle: "montage /app → lancement de l'app",
  },
  {
    clef: "bootRails",
    de: "initLancementAppMs",
    a: "pumaPretMs",
    libelle: "boot Puma/Rails (part dominante, ADR 0005)",
  },
  {
    clef: "detectionSante",
    de: "pumaPretMs",
    a: "santeMs",
    libelle: "détection par la sonde (quantifiée à 5 s)",
  },
  { clef: "total", de: null, a: "santeMs", libelle: "total jusqu'à la première 200 /vault/health" },
];

/**
 * Un bras de mesure : un nom et le dossier d'artefacts qu'il boote. Le dossier
 * porte les six artefacts ET son propre `manifest.json` — sans quoi on ne
 * saurait pas ce qu'on a booté, et l'ADR 0004 pose le manifeste comme la seule
 * attestation de ce qui a été construit.
 *
 * @typedef {{ nom: string, dossier: string }} Bras
 */

/**
 * @param {string[]} arguments_
 * @returns {{ essais: number, etiquette: string, journalComplet: boolean,
 *   essaiInterne: boolean, bras: Bras[] }}
 */
function analyserArguments(arguments_) {
  let essais = 5;
  let etiquette = "releve";
  let journalComplet = false;
  let essaiInterne = false;
  let rapportARejuger = null;
  /** @type {Bras[]} */
  const bras = [];

  for (const argument of arguments_) {
    if (argument.startsWith("--essais=")) essais = Number.parseInt(argument.slice(9), 10);
    else if (argument.startsWith("--etiquette=")) etiquette = argument.slice(12);
    else if (argument === "--journal-complet") journalComplet = true;
    else if (argument === "--essai-interne") essaiInterne = true;
    else if (argument.startsWith("--rejuger=")) rapportARejuger = resolve(argument.slice(10));
    else if (argument.startsWith("--bras=")) bras.push(analyserBras(argument.slice(7)));
    else {
      console.error(`option inconnue : ${argument}`);
      process.exit(64);
    }
  }
  if (!Number.isInteger(essais) || essais < 1) {
    console.error(`nombre d'essais invalide : ${essais}`);
    process.exit(64);
  }
  if (!/^[a-z0-9-]+$/.test(etiquette)) {
    console.error(`étiquette invalide (a-z0-9-) : ${etiquette}`);
    process.exit(64);
  }
  if (bras.length === 0) bras.push({ nom: etiquette, dossier: DOSSIER_ARTEFACTS });
  return { essais, etiquette, journalComplet, essaiInterne, bras, rapportARejuger };
}

/**
 * @param {string} valeur `nom=chemin`
 * @returns {Bras}
 */
function analyserBras(valeur) {
  const separateur = valeur.indexOf("=");
  if (separateur <= 0) {
    console.error(`bras invalide (attendu « nom=chemin ») : ${valeur}`);
    process.exit(64);
  }
  const nom = valeur.slice(0, separateur);
  if (!/^[a-z0-9-]+$/.test(nom)) {
    console.error(`nom de bras invalide (a-z0-9-) : ${nom}`);
    process.exit(64);
  }
  return { nom, dossier: resolve(valeur.slice(separateur + 1)) };
}

/**
 * Un boot à froid, instrumenté.
 *
 * @param {Record<string, any>} manifeste
 * @param {{ journalComplet: boolean, dossier: string }} reglages
 */
async function mesurerUnBoot(manifeste, reglages) {
  /** @type {Record<string, number | null>} */
  const jalons = {
    instanciationMs: null,
    premierOctetSerieMs: null,
    santeMs: null,
  };
  for (const jalon of JALONS_SERIE) jalons[jalon.clef] = null;

  /** @type {{ ms: number, texte: string }[]} */
  const journal = [];
  const depart = Date.now();
  /** @returns {number} */
  const maintenant = () => Date.now() - depart;

  /** @param {string} clef */
  const poser = (clef) => {
    if (jalons[clef] === null) jalons[clef] = maintenant();
  };

  const vm = await demarrerVm({
    manifeste,
    dossierArtefacts: reglages.dossier,
    surJournal: (ligne) => {
      const ms = maintenant();
      journal.push({ ms, texte: ligne });
      for (const jalon of JALONS_SERIE) {
        if (jalons[jalon.clef] === null && jalon.motif.test(ligne)) jalons[jalon.clef] = ms;
      }
    },
  });
  jalons.instanciationMs = maintenant();

  // Le premier octet série arrive du BIOS, avant toute ligne complète : il faut
  // l'écouter à l'octet, pas à la ligne. v86 accepte plusieurs auditeurs sur le
  // même événement, celui de `demarrerVm` continue donc de fonctionner.
  vm.emulateur.add_listener("serial0-output-byte", () => poser("premierOctetSerieMs"));

  try {
    while (maintenant() < BUDGET_MS) {
      try {
        const reponse = await vm.requete("GET", "/vault/health", {
          delaiMs: INTERVALLE_SONDE_MS,
        });
        if (reponse.statut === 200) {
          jalons.santeMs = maintenant();
          const invariant = await vm.requete("GET", "/vault/invariant");
          const verdict = JSON.parse(new TextDecoder().decode(invariant.corps));
          if (invariant.statut !== 200 || verdict.status !== "conforming") {
            throw new Error(`invariant non conforme : ${verdict.status}`);
          }
          const sante = JSON.parse(new TextDecoder().decode(reponse.corps));
          return {
            jalons,
            etapes: deriverEtapes(jalons),
            sante: { rails: sante.rails, ruby: sante.ruby, schema: sante.schema?.version ?? null },
            invariant: verdict.status,
            lignesDeJournal: journal.length,
            journal: reglages.journalComplet ? journal : journal.slice(0, 80),
          };
        }
      } catch {
        // Sonde refusée tant que Puma n'écoute pas : c'est le cas nominal
        // pendant tout le boot de Rails, et non une anomalie.
      }
      await pause(INTERVALLE_SONDE_MS);
    }
    throw new Error(
      `aucune réponse 200 de /vault/health en ${Math.round(BUDGET_MS / 1000)} s ; ` +
        `dernier jalon atteint : ${JSON.stringify(jalons)}`,
    );
  } finally {
    await vm.arreter();
  }
}

/**
 * @param {Record<string, number | null>} jalons
 * @returns {Record<string, number | null>}
 */
function deriverEtapes(jalons) {
  /** @type {Record<string, number | null>} */
  const etapes = {};
  for (const etape of ETAPES) {
    const fin = jalons[etape.a];
    const debut = etape.de === null ? 0 : jalons[etape.de];
    etapes[etape.clef] = fin === null || debut === null ? null : fin - debut;
  }
  return etapes;
}

/**
 * Percentile par la méthode du plus proche rang — la même que
 * `tools/vm/mesurer-boot.mjs`, volontairement recopiée plutôt qu'importée :
 * ce module-là est un SCRIPT qui appelle `principal()` au chargement, et
 * l'importer pour six lignes déclencherait une campagne de mesure.
 *
 * @param {number[]} valeurs
 * @param {number} centile
 * @returns {number}
 */
function percentile(valeurs, centile) {
  if (valeurs.length === 0) throw new Error("aucune valeur à résumer");
  const triees = [...valeurs].sort((gauche, droite) => gauche - droite);
  const rang = Math.ceil((centile / 100) * triees.length);
  return triees[Math.min(rang, triees.length) - 1];
}

/**
 * Résume une série de valeurs. L'étendue est publiée avec les percentiles :
 * `docs/quality-attributes.md` refuse une moyenne seule, et l'ADR 0005 exige
 * qu'un gain soit distingué du bruit — ce que seul l'écart entre essais dit.
 *
 * @param {(number | null)[]} valeurs
 * @returns {Record<string, number | null> | null}
 */
function resumer(valeurs) {
  const retenues = valeurs.filter((valeur) => typeof valeur === "number");
  if (retenues.length === 0) return null;
  const min = Math.min(...retenues);
  const max = Math.max(...retenues);
  const p50 = percentile(retenues, 50);
  return {
    n: retenues.length,
    manquants: valeurs.length - retenues.length,
    p50,
    p95: percentile(retenues, 95),
    min,
    max,
    etendueMs: max - min,
    etendueRelative: p50 === 0 ? null : Number(((max - min) / p50).toFixed(4)),
  };
}

/**
 * Exécute UN essai dans un processus Node neuf, et en rapporte le relevé.
 *
 * POURQUOI UN PROCESSUS PAR ESSAI. Les essais enchaînés dans un même processus
 * ne sont pas indépendants : `tools/vm/mesurer-boot.mjs` le documente déjà pour
 * la mémoire — « les essais suivants du même processus héritent de la mémoire
 * non encore rendue par le ramasse-miettes ; seul le premier essai est propre ».
 * Un émulateur de 512 Mio par essai rend ce confond difficile à borner. On
 * l'élimine plutôt que de le supposer négligeable : le prix est un démarrage de
 * Node par essai, de l'ordre de 50 ms sur un total de ~90 s.
 *
 * CE QUE CELA NE CORRIGE PAS, et il faut le dire : le bruit de la MACHINE. Le
 * premier relevé de #66 (cinq essais dans un même processus, sur une image
 * inchangée) a rendu 100,7 s, 105,8 s, 128,4 s, 113,5 s et 103,6 s — une étendue
 * de 27,7 s, soit 26 % du p50, sans dérive monotone. Aucune isolation de
 * processus ne réduit cela : c'est pourquoi le résumé publie l'étendue à côté des
 * percentiles, pourquoi la règle MARGINALE refuse de conclure en deçà, et
 * pourquoi le verdict APPARIÉ existe — c'est l'entrelacement, non l'isolation,
 * qui rend un écart lisible sous cette étendue-là.
 *
 * @param {number} numero
 * @param {Bras} bras
 * @param {{ journalComplet: boolean }} options
 * @returns {Promise<Record<string, any>>}
 */
function mesurerDansUnProcessusNeuf(numero, bras, options) {
  const arguments_ = ["--essai-interne", `--bras=${bras.nom}=${bras.dossier}`];
  if (options.journalComplet) arguments_.push("--journal-complet");

  return new Promise((resoudre, rejeter) => {
    const enfant = spawn(process.execPath, [fileURLToPath(import.meta.url), ...arguments_], {
      stdio: ["ignore", "pipe", "inherit"],
    });
    let sortie = "";
    enfant.stdout.setEncoding("utf8");
    enfant.stdout.on("data", (morceau) => {
      sortie += morceau;
    });
    enfant.on("error", rejeter);
    enfant.on("close", (code) => {
      if (code !== 0) {
        rejeter(new Error(`l'essai ${numero} du bras « ${bras.nom} » a échoué (code ${code})`));
        return;
      }
      const ligne = sortie.split("\n").find((candidate) => candidate.startsWith(PREFIXE_RELEVE));
      if (ligne === undefined) {
        rejeter(new Error(`l'essai ${numero} du bras « ${bras.nom} » n'a rendu aucun relevé`));
        return;
      }
      resoudre(JSON.parse(ligne.slice(PREFIXE_RELEVE.length)));
    });
  });
}

/**
 * @param {number | null} millisecondes
 * @returns {string}
 */
function secondes(millisecondes) {
  if (millisecondes === null) return "   —   ";
  return `${(millisecondes / 1000).toFixed(1).padStart(6)} s`;
}

/**
 * Charge le manifeste d'un bras et refuse de mesurer si l'image n'est pas celle
 * qu'il décrit. Un bras qui n'est pas le dossier par défaut porte son PROPRE
 * manifeste : l'image de référence n'est pas reproductible bit à bit (ADR 0004
 * épingle les ENTRÉES), deux constructions du même code n'ont donc pas les mêmes
 * empreintes, et un manifeste partagé ferait mentir l'un des deux bras.
 *
 * @param {Bras} bras
 * @returns {Promise<Record<string, any>>}
 */
async function chargerManifeste(bras) {
  const cheminManifeste =
    bras.dossier === DOSSIER_ARTEFACTS ? CHEMIN_MANIFESTE : join(bras.dossier, "manifest.json");
  const raison = raisonDIndisponibilite({ dossierArtefacts: bras.dossier, cheminManifeste });
  if (raison !== null) {
    console.error(`mesure impossible (bras « ${bras.nom} ») : ${raison}`);
    process.exit(1);
  }
  const manifeste = JSON.parse(await readFile(cheminManifeste, "utf8"));
  const anomalies = validerManifeste(manifeste);
  if (anomalies.length > 0) {
    console.error(`manifeste invalide :\n${anomalies.map((a) => `  · ${a.message}`).join("\n")}`);
    process.exit(1);
  }
  return manifeste;
}

/**
 * Mode enfant : un seul boot, un seul relevé rendu sur la sortie standard.
 *
 * @param {{ journalComplet: boolean, bras: Bras[] }} options
 */
async function essaiIsole(options) {
  const [bras] = options.bras;
  const manifeste = await chargerManifeste(bras);
  const releve = await mesurerUnBoot(manifeste, {
    journalComplet: options.journalComplet,
    dossier: bras.dossier,
  });
  process.stdout.write(`${PREFIXE_RELEVE}${JSON.stringify(releve)}\n`);
}

/**
 * Compare deux bras étape par étape, selon la règle du gabarit de #86 : un écart
 * de p50 ne compte que s'il dépasse le bruit, et le bruit est la plus grande
 * étendue intra-série des deux bras. Sous cette barre, la seule affirmation
 * honnête est « dans le bruit de cette machine » — ce qui n'est pas « nul ».
 *
 * @param {Record<string, any>} reference
 * @param {Record<string, any>} candidat
 * @returns {Record<string, any>}
 */
function comparerBras(reference, candidat) {
  /** @type {Record<string, any>} */
  const verdict = {};
  for (const etape of ETAPES) {
    const avant = reference[etape.clef];
    const apres = candidat[etape.clef];
    if (avant === null || apres === null) {
      verdict[etape.clef] = null;
      continue;
    }
    const ecartMs = apres.p50 - avant.p50;
    const bruitMs = Math.max(avant.etendueMs, apres.etendueMs);
    verdict[etape.clef] = {
      p50AvantMs: avant.p50,
      p50ApresMs: apres.p50,
      ecartMs,
      ecartRelatif: avant.p50 === 0 ? null : Number((ecartMs / avant.p50).toFixed(4)),
      bruitMs,
      auDelaDuBruit: Math.abs(ecartMs) > bruitMs,
    };
  }
  return verdict;
}

/**
 * Compare deux bras PAR PAIRES. C'est la lecture que le protocole entrelacé
 * autorise et que la comparaison des p50 marginaux jette : l'essai n du bras
 * « avant » et l'essai n du bras « après » sont joués COUP SUR COUP, sur la même
 * machine dans le même état. Leur différence n'a donc pas à franchir l'étendue
 * de toute la campagne — cette étendue mesure la dérive de la machine ENTRE les
 * paires, dérive qui s'annule à l'intérieur d'une paire.
 *
 * Ce que la fonction rend, et rien de plus : le signe de chaque différence
 * appariée, leur médiane, la plus petite en valeur absolue. Un gain n'est
 * affirmé que si TOUTES les paires vont dans le même sens — avec cinq paires,
 * c'est une chance sur trente-deux sous l'hypothèse nulle du seul hasard de
 * signe. C'est peu de paires : le fait est publié pour ce qu'il vaut, et la
 * comparaison marginale reste publiée à côté.
 *
 * @param {Record<string, any>[]} avant
 * @param {Record<string, any>[]} apres
 * @returns {Record<string, any>}
 */
function comparerParPaires(avant, apres) {
  const paires = Math.min(avant.length, apres.length);
  /** @type {Record<string, any>} */
  const verdict = {};

  for (const etape of ETAPES) {
    /** @type {number[]} */
    const ecarts = [];
    for (let index = 0; index < paires; index += 1) {
      const gauche = avant[index].etapes[etape.clef];
      const droite = apres[index].etapes[etape.clef];
      if (typeof gauche === "number" && typeof droite === "number") ecarts.push(droite - gauche);
    }
    if (ecarts.length === 0) {
      verdict[etape.clef] = null;
      continue;
    }
    const negatifs = ecarts.filter((ecart) => ecart < 0).length;
    const positifs = ecarts.filter((ecart) => ecart > 0).length;
    const memeSens = negatifs === ecarts.length || positifs === ecarts.length;
    verdict[etape.clef] = {
      ecartsMs: ecarts,
      pairesRetenues: ecarts.length,
      pairesEnGain: negatifs,
      pairesEnPerte: positifs,
      medianeMs: percentile(ecarts, 50),
      plusPetitEcartAbsoluMs: Math.min(...ecarts.map((ecart) => Math.abs(ecart))),
      plusGrandEcartAbsoluMs: Math.max(...ecarts.map((ecart) => Math.abs(ecart))),
      toutesLesPairesDansLeMemeSens: memeSens,
    };
  }
  return verdict;
}

/**
 * Enchaîne les essais en ENTRELAÇANT les bras (avant, après, avant, après…).
 * Une machine qui ralentit au milieu d'une campagne pénalise alors les deux bras
 * également ; deux séries jouées l'une après l'autre, non.
 *
 * @param {{ essais: number, journalComplet: boolean, bras: Bras[] }} options
 * @returns {Promise<Record<string, Record<string, any>[]>>}
 */
async function campagneEntrelacee(options) {
  /** @type {Record<string, Record<string, any>[]>} */
  const parBras = Object.fromEntries(options.bras.map((bras) => [bras.nom, []]));

  for (let numero = 1; numero <= options.essais; numero += 1) {
    for (const bras of options.bras) {
      const releve = await mesurerDansUnProcessusNeuf(numero, bras, options);
      parBras[bras.nom].push({ essai: numero, ...releve });
      console.log(
        `essai ${numero}/${options.essais} · ${bras.nom.padEnd(12)} ` +
          `total ${secondes(releve.jalons.santeMs)} · boot Rails ${secondes(releve.etapes.bootRails)}`,
      );
      await pause(PAUSE_ENTRE_ESSAIS_MS);
    }
  }
  return parBras;
}

/**
 * @param {Record<string, any>[]} essais
 * @returns {Record<string, any>}
 */
function resumerCampagne(essais) {
  /** @type {Record<string, any>} */
  const resume = {};
  for (const etape of ETAPES) {
    resume[etape.clef] = resumer(essais.map((releve) => releve.etapes[etape.clef]));
  }
  return resume;
}

/**
 * @param {Record<string, any>} resume
 * @param {string} titre
 */
function afficherResume(resume, titre) {
  console.log(`\n${titre}`);
  console.log(
    `${"étape".padEnd(22)} ${"p50".padStart(8)} ${"p95".padStart(8)} ${"min".padStart(8)} ${"max".padStart(8)}`,
  );
  for (const etape of ETAPES) {
    const bilan = resume[etape.clef];
    if (bilan === null) {
      console.log(`${etape.clef.padEnd(22)} jalon jamais atteint`);
      continue;
    }
    console.log(
      `${etape.clef.padEnd(22)} ${secondes(bilan.p50)} ${secondes(bilan.p95)} ` +
        `${secondes(bilan.min)} ${secondes(bilan.max)}`,
    );
  }
}

/**
 * @param {Record<string, any>} verdict
 * @param {string} titre
 */
function afficherVerdictApparie(verdict, titre) {
  console.log(`\n${titre}`);
  console.log(
    `${"étape".padEnd(22)} ${"médiane".padStart(10)} ${"plus petit".padStart(10)}  paires  conclusion`,
  );
  for (const etape of ETAPES) {
    const ligne = verdict[etape.clef];
    if (ligne === null) {
      console.log(`${etape.clef.padEnd(22)} jalon jamais atteint`);
      continue;
    }
    const sens = ligne.medianeMs < 0 ? "gain" : "perte";
    const conclusion = ligne.toutesLesPairesDansLeMemeSens
      ? `${sens} sur TOUTES les paires`
      : "paires partagées : rien à conclure";
    console.log(
      `${etape.clef.padEnd(22)} ${secondes(ligne.medianeMs)} ` +
        `${secondes(ligne.medianeMs < 0 ? -ligne.plusPetitEcartAbsoluMs : ligne.plusPetitEcartAbsoluMs)}  ` +
        `${String(ligne.pairesEnGain).padStart(2)}/${ligne.pairesRetenues}   ${conclusion}`,
    );
  }
}

/**
 * @param {Record<string, any>} verdict
 * @param {string} titre
 */
function afficherVerdict(verdict, titre) {
  console.log(`\n${titre}`);
  console.log(
    `${"étape".padEnd(22)} ${"écart p50".padStart(10)} ${"bruit".padStart(10)}  conclusion`,
  );
  for (const etape of ETAPES) {
    const ligne = verdict[etape.clef];
    if (ligne === null) {
      console.log(`${etape.clef.padEnd(22)} jalon jamais atteint`);
      continue;
    }
    const conclusion = ligne.auDelaDuBruit
      ? `${ligne.ecartMs < 0 ? "GAIN" : "PERTE"} au-delà du bruit`
      : "dans le bruit de cette machine";
    console.log(
      `${etape.clef.padEnd(22)} ${secondes(ligne.ecartMs)} ${secondes(ligne.bruitMs)}  ${conclusion}`,
    );
  }
}

async function principal() {
  const options = analyserArguments(process.argv.slice(2));
  if (options.rapportARejuger !== null) {
    await rejuger(options.rapportARejuger);
    return;
  }
  if (options.essaiInterne) {
    await essaiIsole(options);
    return;
  }

  /** @type {Record<string, any>} */
  const manifestes = {};
  for (const bras of options.bras) manifestes[bras.nom] = await chargerManifeste(bras);

  const parBras = await campagneEntrelacee(options);

  /** @type {Record<string, any>} */
  const bras = {};
  for (const declaration of options.bras) {
    const essais = parBras[declaration.nom];
    const manifeste = manifestes[declaration.nom];
    bras[declaration.nom] = {
      dossier: declaration.dossier,
      manifeste: {
        generatedAt: manifeste.generatedAt,
        totalByteSize: manifeste.totals.byteSize,
        artefacts: manifeste.artifacts.map((artefact) => ({
          name: artefact.name,
          byteSize: artefact.byteSize,
          sha256: artefact.sha256,
        })),
      },
      essais,
      resume: resumerCampagne(essais),
    };
  }

  const noms = options.bras.map((declaration) => declaration.nom);
  const { verdict, verdictApparie } = juger(bras, noms);

  const rapport = {
    etiquette: options.etiquette,
    mesureLe: new Date().toISOString(),
    banc: "tools/mesurer-attribution-boot.mjs",
    protocole: {
      essaiParProcessusNeuf: true,
      brasEntrelaces: noms,
      essaisParBras: options.essais,
      intervalleSondeMs: INTERVALLE_SONDE_MS,
      pauseEntreEssaisMs: PAUSE_ENTRE_ESSAIS_MS,
      disques: "servis depuis la mémoire de Node (pas OPFS)",
      regleDuVerdict: REGLE_MARGINALE,
      regleDuVerdictApparie: REGLE_APPARIEE,
    },
    environnement: {
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      cpus: cpus().length,
      memoireTotaleOctets: totalmem(),
    },
    definitionDesEtapes: ETAPES,
    bras,
    verdict,
    verdictApparie,
  };

  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  const chemin = join(DOSSIER_RAPPORTS, `attribution-${options.etiquette}.json`);
  writeFileSync(chemin, `${JSON.stringify(rapport, null, 2)}\n`, "utf8");
  publier(rapport, chemin);
}

/**
 * @param {Record<string, any>} bras
 * @param {string[]} noms
 * @returns {{ verdict: Record<string, any> | null, verdictApparie: Record<string, any> | null }}
 */
function juger(bras, noms) {
  if (noms.length !== 2) return { verdict: null, verdictApparie: null };
  return {
    verdict: comparerBras(bras[noms[0]].resume, bras[noms[1]].resume),
    verdictApparie: comparerParPaires(bras[noms[0]].essais, bras[noms[1]].essais),
  };
}

/**
 * @param {Record<string, any>} rapport
 * @param {string} chemin
 */
function publier(rapport, chemin) {
  const noms = rapport.protocole.brasEntrelaces ?? Object.keys(rapport.bras);
  for (const nom of noms) {
    const essais = rapport.bras[nom].essais.length;
    afficherResume(rapport.bras[nom].resume, `Bras « ${nom} » — ${essais} essais à froid`);
  }
  if (rapport.verdict !== null) {
    afficherVerdict(rapport.verdict, `Verdict marginal « ${noms[0]} » → « ${noms[1]} »`);
  }
  if (rapport.verdictApparie != null) {
    afficherVerdictApparie(rapport.verdictApparie, `Verdict APPARIÉ (essai n contre essai n)`);
  }
  console.log(`\nrapport : ${chemin}`);
}

/**
 * Rejuge un rapport DÉJÀ MESURÉ, sans rien remesurer.
 *
 * Le brut est publié (`bras[*].essais`) précisément pour qu'une règle de verdict
 * puisse être corrigée sans qu'une campagne de vingt minutes soit rejouée — et
 * pour qu'on ne soit jamais tenté de garder une règle fausse parce que la
 * remesurer coûterait cher. C'est ce chemin qui a ajouté le verdict apparié au
 * relevé bootsnap de #66.
 *
 * @param {string} chemin
 */
async function rejuger(chemin) {
  const rapport = JSON.parse(await readFile(chemin, "utf8"));
  const noms = rapport.protocole?.brasEntrelaces ?? Object.keys(rapport.bras ?? {});
  const juge = juger(rapport.bras, noms);
  rapport.verdict = juge.verdict;
  rapport.verdictApparie = juge.verdictApparie;
  rapport.protocole.regleDuVerdict = REGLE_MARGINALE;
  rapport.protocole.regleDuVerdictApparie = REGLE_APPARIEE;
  rapport.rejugeLe = new Date().toISOString();
  writeFileSync(chemin, `${JSON.stringify(rapport, null, 2)}\n`, "utf8");
  publier(rapport, chemin);
}

principal().catch((erreur) => {
  console.error(erreur instanceof Error ? erreur.message : String(erreur));
  process.exit(1);
});
