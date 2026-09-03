// Mémoire RÉSIDENTE d'un processus, demandée au SYSTÈME et non au moteur JavaScript (#67).
//
// Ce module ne sait rien du navigateur : il rend, pour une liste d'identifiants de processus, ce que
// le système d'exploitation dit qu'ils occupent réellement en mémoire vive. C'est la seule grandeur
// qui voit les 512 Mio de RAM invitée de v86 — allouée dans la mémoire linéaire d'un module
// WebAssembly, à l'intérieur d'un Worker, et donc invisible au tas JS de la page.
//
// ## Deux grandeurs, et pourquoi les deux sont publiées
//
//  - **Résident** (« working set » sous Windows, `VmRSS` sous Linux, `rss` sous macOS) : les pages
//    physiquement en RAM pour ce processus, PARTAGÉES COMPRISES. Sommée sur un arbre de processus
//    qui partagent leur image exécutable, elle SURCOMPTE — c'est la borne haute.
//  - **Privé** (`PrivatePageCount` sous Windows, `RssAnon` sous Linux) : ce que ce processus est
//    seul à détenir. Sommé sur l'arbre, il ne surcompte pas, mais il ignore ce que le navigateur
//    occupe en pages partagées — c'est la borne basse.
//
// La vérité est entre les deux, et aucune des deux ne se déduit de l'autre. Publier une seule
// laisserait le lecteur choisir la sienne sans le savoir. macOS ne rend pas la part privée par ce
// chemin : elle y vaut `null`, jamais zéro.
//
// ## Coût de la sonde
//
// Sous Windows, chaque relevé lance un `powershell.exe` — de l'ordre de quelques centaines de
// millisecondes de CPU. C'est pourquoi le banc échantillonne à la seconde, pas à la milliseconde :
// une sonde qui pèse sur la machine qu'elle mesure fausse la mesure. Sous Linux, le relevé lit
// `/proc` sans lancer de processus et ne coûte rien.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

/** Un relevé pour un processus. `prive` vaut `null` là où la plateforme ne le rend pas. */
/** @typedef {{ residentOctets: number, priveOctets: number | null }} ReleveProcessus */

const KIO = 1024;

/** Relevé Windows : `Win32_Process` en un seul appel, filtré sur les identifiants demandés. */
function releverWindows(pids) {
  const script = [
    `$ids = @(${pids.join(",")})`,
    "Get-CimInstance Win32_Process |",
    "  Where-Object { $ids -contains $_.ProcessId } |",
    '  ForEach-Object { "{0} {1} {2}" -f $_.ProcessId, $_.WorkingSetSize, $_.PrivatePageCount }',
  ].join("\n");

  const sortie = execFileSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );

  const releves = new Map();
  for (const ligne of sortie.split("\n")) {
    const champs = ligne.trim().split(/\s+/u);
    if (champs.length !== 3) continue;
    const [pid, resident, prive] = champs.map(Number);
    if (!Number.isFinite(pid)) continue;
    releves.set(pid, { residentOctets: resident, priveOctets: prive });
  }
  return releves;
}

/** Relevé Linux : `/proc/<pid>/status`, sans lancer le moindre processus. */
function releverLinux(pids) {
  const releves = new Map();
  for (const pid of pids) {
    let statut;
    try {
      statut = readFileSync(`/proc/${pid}/status`, "utf8");
    } catch {
      // Un processus qui vient de mourir n'est pas une erreur de mesure : il ne compte plus.
      continue;
    }
    const lire = (champ) => {
      const trouve = new RegExp(`^${champ}:\\s+(\\d+) kB$`, "mu").exec(statut);
      return trouve === null ? null : Number(trouve[1]) * KIO;
    };
    const resident = lire("VmRSS");
    if (resident === null) continue;
    releves.set(pid, { residentOctets: resident, priveOctets: lire("RssAnon") });
  }
  return releves;
}

/** Relevé macOS : `ps` rend le résident en kibioctets ; la part privée n'y est pas accessible. */
function releverDarwin(pids) {
  const sortie = execFileSync("ps", ["-o", "pid=,rss=", "-p", pids.join(",")], {
    encoding: "utf8",
  });
  const releves = new Map();
  for (const ligne of sortie.split("\n")) {
    const champs = ligne.trim().split(/\s+/u);
    if (champs.length !== 2) continue;
    const [pid, kio] = champs.map(Number);
    if (!Number.isFinite(pid)) continue;
    releves.set(pid, { residentOctets: kio * KIO, priveOctets: null });
  }
  return releves;
}

/** Plateformes sur lesquelles ce module sait relever une empreinte. */
export const PLATEFORMES = Object.freeze(["win32", "linux", "darwin"]);

/**
 * Relève la mémoire résidente des processus demandés.
 *
 * Un processus disparu entre la demande et le relevé est simplement absent du résultat : un
 * navigateur ferme et ouvre des processus de rendu en permanence, et c'est un fait normal de la
 * mesure, pas une panne.
 *
 * @param {number[]} pids identifiants de processus
 * @returns {Map<number, ReleveProcessus>}
 */
export function relever(pids) {
  if (pids.length === 0) return new Map();
  if (process.platform === "win32") return releverWindows(pids);
  if (process.platform === "linux") return releverLinux(pids);
  if (process.platform === "darwin") return releverDarwin(pids);
  throw new Error(
    `Plateforme « ${process.platform} » non couverte : ce banc sait relever ${PLATEFORMES.join(", ")}.`,
  );
}
