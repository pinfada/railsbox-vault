// Mesure le boot à froid de l'image de référence : durée jusqu'à la route de
// santé et pic de mémoire du processus hôte, sur plusieurs essais.
//
// `docs/quality-attributes.md` exige qu'une mesure publie machine, navigateur,
// volume, nombre d'essais et percentile — une moyenne seule ne suffit pas. Ce
// script produit donc p50 et p95, et écrit l'environnement avec les chiffres.
//
//   node tools/vm/mesurer-boot.mjs [--essais=3]
//
// Deux modes, et le second ne remplace pas le premier :
//
//   (defaut)     BOOT A FROID seul — la reference historique de #7 et #60 ;
//   --reprise    REPRISE PAR INSTANTANE (#65, ADR 0024) — chaque essai boote a froid, capture, puis
//                reprend depuis l'instantane, et publie les DEUX temps cote a cote. Les publier
//                separement aurait laisse comparer deux releves faits sur deux machines, deux jours
//                ou deux versions de l'image.
//
//   node tools/vm/mesurer-boot.mjs --reprise --essais=4
//
// Le mode « reprise » exige la cle de volume du HARNAIS — VAULT_HARNAIS_CLE_DE_VOLUME=cle-de-test
// dans l'environnement du processus —, comme tools/mesurer-creation-v3.mjs. Aucun chemin du produit
// ne la transmet, et un banc qui la fabriquerait serait un chiffrement sans secret.
import { mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { validerManifeste } from "../build-reference-image/manifest-contract.mjs";
import { cleDeVolumeDuHarnais } from "../../src/vm/cle-de-volume.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { FORMAT_VOLUME_V3 } from "../../src/vm/volume-chiffre-format.mjs";
import {
  CHEMIN_MANIFESTE,
  RACINE_DEPOT,
  demarrerVm,
  pause,
  raisonDIndisponibilite,
} from "./boot-reference.mjs";
import { VOLUME_DU_RELEVE, essaiDeReprise, supportInstantaneFichier } from "./mesurer-reprise.mjs";

const DOSSIER_RAPPORTS = join(RACINE_DEPOT, "reports", "vm");
const BUDGET_MS = Number.parseInt(process.env.VAULT_VM_BUDGET_MS ?? "1200000", 10);

/** Le budget de reprise de `docs/quality-attributes.md`, et le seul seuil que le gate connaisse. */
export const BUDGET_REPRISE_MS = 60_000;

/**
 * @param {number[]} valeurs
 * @param {number} centile
 * @returns {number}
 */
export function percentile(valeurs, centile) {
  if (valeurs.length === 0) throw new Error("aucune valeur à résumer");
  const triees = [...valeurs].sort((gauche, droite) => gauche - droite);
  // Méthode du plus proche rang : avec trois essais, p95 est la valeur la plus
  // haute. C'est volontairement conservateur, et ce que le petit nombre
  // d'essais permet d'affirmer honnêtement.
  const rang = Math.ceil((centile / 100) * triees.length);
  return triees[Math.min(rang, triees.length) - 1];
}

/** Lit `--essais=N`, ou refuse. Un nombre d'essais invalide fausse un percentile en silence. */
function nombreDEssais(defaut) {
  const essais = Number.parseInt(
    process.argv.find((argument) => argument.startsWith("--essais="))?.slice(9) ?? String(defaut),
    10,
  );
  if (!Number.isInteger(essais) || essais < 1) {
    console.error("nombre d'essais invalide");
    process.exit(64);
  }
  return essais;
}

/** Charge le manifeste de l'image, et refuse s'il ne tient pas son propre contrat. */
async function manifesteValide() {
  const manifeste = JSON.parse(await readFile(CHEMIN_MANIFESTE, "utf8"));
  const anomalies = validerManifeste(manifeste);
  if (anomalies.length > 0) {
    console.error(`manifeste invalide :\n${anomalies.map((a) => `  · ${a.message}`).join("\n")}`);
    process.exit(1);
  }
  return manifeste;
}

/**
 * L'environnement du relevé, publié avec les chiffres.
 *
 * `docs/quality-attributes.md` l'exige : « toute mesure publie machine, navigateur, volume, nombre
 * d'essais et percentile ; une moyenne seule ne suffit pas ». Un relevé sans machine ne se compare
 * à rien.
 */
async function environnement() {
  const os = await import("node:os");
  return {
    node: process.versions.node,
    platform: `${process.platform} ${process.arch}`,
    cpus: os.cpus().length,
    modeleCpu: os.cpus()[0]?.model ?? null,
    memoireTotaleOctets: os.totalmem(),
  };
}

/** UN essai de boot à froid, avec le pic de RSS du processus hôte. */
async function essaiDeBootFroid({ manifeste, essai, essais }) {
  const rssAvant = process.memoryUsage().rss;
  let rssPic = rssAvant;
  const surveillance = setInterval(() => {
    rssPic = Math.max(rssPic, process.memoryUsage().rss);
  }, 500);

  const vm = await demarrerVm({ manifeste });
  try {
    const { dureeMs, sante } = await vm.attendreSante({ delaiTotalMs: BUDGET_MS });
    const reponse = await vm.requete("GET", "/vault/invariant");
    const verdict = JSON.parse(new TextDecoder().decode(reponse.corps));
    if (reponse.statut !== 200 || verdict.status !== "conforming") {
      throw new Error(`invariant non conforme à l'essai ${essai} : ${verdict.status}`);
    }
    console.log(
      `essai ${essai}/${essais} : ${Math.round(dureeMs / 1000)} s, ` +
        `pic RSS ${(rssPic / 1024 / 1024).toFixed(0)} Mio`,
    );
    return {
      essai,
      bootFroidMs: dureeMs,
      rssPicOctets: rssPic,
      rssAvantOctets: rssAvant,
      rails: sante.rails,
    };
  } finally {
    clearInterval(surveillance);
    await vm.arreter();
  }
}

/**
 * Résume une série : p50, p95, et l'ÉTENDUE RELATIVE.
 *
 * L'étendue n'est pas décorative. Le relevé de #60 a montré des séries de trois essais dont
 * l'étendue interne atteignait 17 %, ce qui rend un p95 pris sur quatre essais lisible seulement
 * accompagné de sa dispersion.
 */
export function resumer(valeurs) {
  const min = Math.min(...valeurs);
  const max = Math.max(...valeurs);
  return {
    n: valeurs.length,
    p50: percentile(valeurs, 50),
    p95: percentile(valeurs, 95),
    min,
    max,
    etendueRelative: min === 0 ? null : Number(((max - min) / min).toFixed(3)),
  };
}

function ecrireRapport(nom, rapport) {
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  const chemin = join(DOSSIER_RAPPORTS, nom);
  writeFileSync(chemin, `${JSON.stringify(rapport, null, 2)}\n`, "utf8");
  return chemin;
}

async function mesurerBootFroid(manifeste, essais) {
  const releves = [];
  for (let essai = 1; essai <= essais; essai += 1) {
    releves.push(await essaiDeBootFroid({ manifeste, essai, essais }));
    // Laisse le ramasse-miettes libérer la mémoire de l'émulateur précédent : sans cette pause, le
    // pic du second essai inclut le premier.
    await pause(5_000);
  }

  const durees = releves.map((releve) => releve.bootFroidMs);
  const pics = releves.map((releve) => releve.rssPicOctets);
  const rapport = {
    mesureLe: new Date().toISOString(),
    environnement: await environnement(),
    manifeste: {
      generatedAt: manifeste.generatedAt,
      totalByteSize: manifeste.totals.byteSize,
      memoireVmMiB: manifeste.boot.memoryMiB,
    },
    essais: releves,
    resume: {
      nombreDEssais: releves.length,
      bootFroidP50Ms: percentile(durees, 50),
      bootFroidP95Ms: percentile(durees, 95),
      rssPicP50Octets: percentile(pics, 50),
      rssPicP95Octets: percentile(pics, 95),
    },
  };
  const chemin = ecrireRapport("mesures-boot.json", rapport);

  console.log(
    `\np50 ${Math.round(rapport.resume.bootFroidP50Ms / 1000)} s · p95 ${Math.round(rapport.resume.bootFroidP95Ms / 1000)} s`,
  );
  console.log(
    `pic RSS p95 ${(rapport.resume.rssPicP95Octets / 1024 / 1024).toFixed(0)} Mio — rapport : ${chemin}`,
  );
}

/**
 * Ce que cet outil peut dire du gate « reprise ≤ 60 s » — et ce qu'il ne peut PAS dire.
 *
 * Il constate DEUX conditions mesurables : le p95 de reprise sous le budget, ET l'équivalence de
 * l'invariant applicatif verte sur TOUS les essais. Un p95 tenu sans équivalence ne décrit pas une
 * reprise : il décrit une machine qui redémarre vite sur un état que personne n'a vérifié.
 *
 * **Il ne dit PAS que le gate est ouvert, et il ne le dira jamais.** `docs/quality-attributes.md`
 * exige que la mesure soit prise sur l'ENVIRONNEMENT DE RÉFÉRENCE — quatre cœurs, 16 Gio, profil
 * neuf —, et un programme ne sait pas s'il tourne dessus : il lit le nombre de cœurs de la machine,
 * pas l'intention de celui qui l'a lancé. Le verdict d'ouverture appartient donc au document, qui
 * confronte ces chiffres à l'environnement dans lequel ils ont été pris. C'est délibérément un
 * geste humain : un outil qui se déclarerait conforme à son propre protocole n'aurait aucun juge.
 */
export function verdictDuGate({ repriseP95Ms, equivalences, essais }) {
  const budgetTenu = repriseP95Ms <= BUDGET_REPRISE_MS;
  const equivalenceVerte = equivalences === essais && essais > 0;
  return {
    budgetMs: BUDGET_REPRISE_MS,
    budgetTenu,
    equivalenceVerte,
    conditionsMesurablesReunies: budgetTenu && equivalenceVerte,
    environnementDeReference:
      "NON ATTESTÉ par cet outil : docs/quality-attributes.md tranche l'ouverture du gate",
    raison: budgetTenu
      ? equivalenceVerte
        ? "p95 sous le budget ET équivalence de l'invariant verte sur tous les essais"
        : "p95 sous le budget, mais l'équivalence de l'invariant n'est pas verte sur tous les essais"
      : "p95 au-dessus du budget",
  };
}

/**
 * Déroule la SÉRIE d'essais, et retire le fichier d'instantané quoi qu'il arrive.
 *
 * Le `finally` n'est pas décoratif : le fichier pèse un quart de gibioctet, et une mesure
 * interrompue le laisserait dans `reports/` sans que personne sache d'où il vient.
 */
async function serieDeReprises({ manifeste, scellement, essais }) {
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  const support = supportInstantaneFichier(join(DOSSIER_RAPPORTS, "releve.instantane"));
  const releves = [];
  try {
    for (let essai = 1; essai <= essais; essai += 1) {
      const releve = await essaiDeReprise({
        manifeste,
        demarrerVm,
        scellement,
        support,
        budgetMs: BUDGET_MS,
        essai,
      });
      releves.push(releve);
      console.log(
        `essai ${essai}/${essais} : froid ${Math.round(releve.bootFroidMs / 1000)} s · ` +
          `reprise ${(releve.repriseMs / 1000).toFixed(1)} s · ` +
          `instantané ${(releve.instantaneOctets / 1048576).toFixed(1)} Mio · ` +
          `invariant ${releve.invariantIdentique ? "IDENTIQUE" : "DIFFÉRENT"}`,
      );
      await pause(5_000);
    }
  } finally {
    await support.retirer();
  }
  return releves;
}

/** Publie le relevé sur la sortie standard. Aucune décision ici : le verdict est déjà calculé. */
function publierLeReleve(rapport, chemin) {
  const reprises = rapport.resume.reprise;
  console.log(
    `\nboot à froid p95 ${(rapport.resume.bootFroid.p95 / 1000).toFixed(1)} s · ` +
      `reprise p95 ${(reprises.p95 / 1000).toFixed(1)} s ` +
      `(étendue relative ${reprises.etendueRelative})`,
  );
  console.log(
    `capture p95 ${(rapport.resume.capture.p95 / 1000).toFixed(1)} s · ` +
      `instantané ${(rapport.resume.instantaneOctets / 1048576).toFixed(1)} Mio · ` +
      `invariant identique sur ${rapport.resume.invariantIdentiqueSur}`,
  );
  console.log(
    `conditions mesurables du gate « reprise ≤ 60 s » : ` +
      `${rapport.gate.conditionsMesurablesReunies ? "RÉUNIES" : "NON RÉUNIES"} — ${rapport.gate.raison}`,
  );
  console.log(
    "l'ouverture du gate ne se décide pas ici : elle exige l'environnement de référence de docs/quality-attributes.md",
  );
  console.log(`rapport : ${chemin}`);
}

async function mesurerReprise(manifeste, essais) {
  const scellement = await Scellement.ouvrir({
    volume: VOLUME_DU_RELEVE,
    cleOctets: cleDeVolumeDuHarnais(),
    formatVersion: FORMAT_VOLUME_V3,
  });
  const releves = await serieDeReprises({ manifeste, scellement, essais });

  const equivalences = releves.filter((releve) => releve.invariantIdentique).length;
  const reprises = resumer(releves.map((releve) => releve.repriseMs));
  const rapport = {
    mesureLe: new Date().toISOString(),
    environnement: await environnement(),
    // CE QUE CE RELEVÉ NE MESURE PAS, écrit dans le rapport plutôt que dans un commentaire : le
    // harnais Node n'a ni volume OPFS, ni journal de génération, ni région d'authentification.
    liaison: {
      empreinteImage: "réelle, dérivée du manifeste de l'image (ADR 0007)",
      sequence: "déclarée inerte (0) : aucun volume transactionnel n'accompagne ce relevé",
      generation: "déclarée inerte (0)",
      empreinteRegion: "déclarée inerte (32 octets nuls)",
    },
    manifeste: {
      generatedAt: manifeste.generatedAt,
      memoireVmMiB: manifeste.boot.memoryMiB,
    },
    essais: releves,
    resume: {
      nombreDEssais: releves.length,
      bootFroid: resumer(releves.map((releve) => releve.bootFroidMs)),
      reprise: reprises,
      capture: resumer(releves.map((releve) => releve.captureMs)),
      ouvertureInstantane: resumer(releves.map((releve) => releve.ouvertureInstantaneMs)),
      instantaneOctets: releves[0]?.instantaneOctets ?? null,
      etatV86Octets: releves[0]?.etatV86Octets ?? null,
      invariantIdentiqueSur: `${equivalences}/${releves.length}`,
    },
    gate: verdictDuGate({ repriseP95Ms: reprises.p95, equivalences, essais: releves.length }),
  };
  publierLeReleve(rapport, ecrireRapport("mesures-reprise.json", rapport));
}

async function principal() {
  const reprise = process.argv.includes("--reprise");
  const essais = nombreDEssais(reprise ? 4 : 3);

  const raison = raisonDIndisponibilite();
  if (raison !== null) {
    console.error(`mesure impossible : ${raison}`);
    process.exit(1);
  }

  const manifeste = await manifesteValide();
  if (reprise) await mesurerReprise(manifeste, essais);
  else await mesurerBootFroid(manifeste, essais);
}

principal().catch((erreur) => {
  console.error(erreur instanceof Error ? erreur.message : String(erreur));
  process.exit(1);
});
