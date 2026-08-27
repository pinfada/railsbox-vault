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
// `mesurerDansUnProcessusNeuf` pour la mesure qui l'a imposé). Le parent
// enchaîne les essais, agrège, et publie p50, p95, min, max et l'étendue.
//
// USAGE
//   node tools/mesurer-attribution-boot.mjs --essais=5 --etiquette=avant
//
// Le rapport est écrit dans `reports/perf/attribution-<etiquette>.json`.
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { validerManifeste } from "./build-reference-image/manifest-contract.mjs";
import {
  CHEMIN_MANIFESTE,
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
 * @param {string[]} arguments_
 * @returns {{ essais: number, etiquette: string, journalComplet: boolean, essaiInterne: boolean }}
 */
function analyserArguments(arguments_) {
  let essais = 5;
  let etiquette = "releve";
  let journalComplet = false;
  let essaiInterne = false;

  for (const argument of arguments_) {
    if (argument.startsWith("--essais=")) essais = Number.parseInt(argument.slice(9), 10);
    else if (argument.startsWith("--etiquette=")) etiquette = argument.slice(12);
    else if (argument === "--journal-complet") journalComplet = true;
    else if (argument === "--essai-interne") essaiInterne = true;
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
  return { essais, etiquette, journalComplet, essaiInterne };
}

/**
 * Un boot à froid, instrumenté.
 *
 * @param {Record<string, any>} manifeste
 * @param {{ journalComplet: boolean }} reglages
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
 * percentiles, et pourquoi un écart plus petit que l'étendue ne prouve rien.
 *
 * @param {number} numero
 * @param {{ etiquette: string, journalComplet: boolean }} options
 * @returns {Promise<Record<string, any>>}
 */
function mesurerDansUnProcessusNeuf(numero, options) {
  const arguments_ = ["--essai-interne", `--etiquette=${options.etiquette}`];
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
        rejeter(new Error(`l'essai ${numero} a échoué (code ${code})`));
        return;
      }
      const ligne = sortie.split("\n").find((candidate) => candidate.startsWith(PREFIXE_RELEVE));
      if (ligne === undefined) {
        rejeter(new Error(`l'essai ${numero} n'a rendu aucun relevé`));
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
 * Charge le manifeste et refuse de mesurer si l'image n'est pas celle décrite.
 *
 * @returns {Promise<Record<string, any>>}
 */
async function chargerManifeste() {
  const raison = raisonDIndisponibilite();
  if (raison !== null) {
    console.error(`mesure impossible : ${raison}`);
    process.exit(1);
  }
  const manifeste = JSON.parse(await readFile(CHEMIN_MANIFESTE, "utf8"));
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
 * @param {{ journalComplet: boolean }} options
 */
async function essaiIsole(options) {
  const manifeste = await chargerManifeste();
  const releve = await mesurerUnBoot(manifeste, options);
  process.stdout.write(`${PREFIXE_RELEVE}${JSON.stringify(releve)}\n`);
}

async function principal() {
  const options = analyserArguments(process.argv.slice(2));
  if (options.essaiInterne) {
    await essaiIsole(options);
    return;
  }

  const manifeste = await chargerManifeste();

  const essais = [];
  for (let numero = 1; numero <= options.essais; numero += 1) {
    const releve = await mesurerDansUnProcessusNeuf(numero, options);
    essais.push({ essai: numero, ...releve });
    console.log(
      `essai ${numero}/${options.essais} : total ${secondes(releve.jalons.santeMs)} · ` +
        `boot Rails ${secondes(releve.etapes.bootRails)}`,
    );
    await pause(PAUSE_ENTRE_ESSAIS_MS);
  }

  /** @type {Record<string, any>} */
  const resume = {};
  for (const etape of ETAPES) {
    resume[etape.clef] = resumer(essais.map((releve) => releve.etapes[etape.clef]));
  }

  const rapport = {
    etiquette: options.etiquette,
    mesureLe: new Date().toISOString(),
    banc: "tools/mesurer-attribution-boot.mjs",
    protocole: {
      essaiParProcessusNeuf: true,
      intervalleSondeMs: INTERVALLE_SONDE_MS,
      pauseEntreEssaisMs: PAUSE_ENTRE_ESSAIS_MS,
      disques: "servis depuis la mémoire de Node (pas OPFS)",
    },
    environnement: {
      node: process.versions.node,
      platform: `${process.platform} ${process.arch}`,
      cpus: cpus().length,
      memoireTotaleOctets: totalmem(),
    },
    manifeste: {
      generatedAt: manifeste.generatedAt,
      totalByteSize: manifeste.totals.byteSize,
      artefacts: manifeste.artifacts.map((artefact) => ({
        name: artefact.name,
        byteSize: artefact.byteSize,
        sha256: artefact.sha256,
      })),
    },
    definitionDesEtapes: ETAPES,
    essais,
    resume,
  };

  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  const chemin = join(DOSSIER_RAPPORTS, `attribution-${options.etiquette}.json`);
  writeFileSync(chemin, `${JSON.stringify(rapport, null, 2)}\n`, "utf8");

  console.log(
    `\nAttribution (${essais.length} essais à froid) — étiquette « ${options.etiquette} »`,
  );
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
  console.log(`\nrapport : ${chemin}`);
}

principal().catch((erreur) => {
  console.error(erreur instanceof Error ? erreur.message : String(erreur));
  process.exit(1);
});
