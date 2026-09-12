/**
 * Récupère la candidate du spike #185 et REFUSE de la déposer si une empreinte diffère.
 *
 *     node tools/spike-gcm-siv/preparer-candidate.mjs
 *
 * C'est la règle de dépendances du dépôt (ADR 0021, décision 3) appliquée telle quelle à une
 * évaluation : artefact récupéré par son gestionnaire, empreinte du paquet et de CHAQUE fichier
 * confrontées au manifeste avant que quoi que ce soit ne soit importé, aucun CDN, aucune exécution
 * hors épreuve. Rien n'entre dans `package.json` ni dans l'arbre versionné : le dépôt final est
 * `reports/spike-gcm-siv/candidate/`, ignoré par git.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { MANIFESTE, RACINE_CANDIDATE } from "./candidate/emplacement.mjs";

const executer = promisify(execFile);

function empreinte(octets) {
  return createHash("sha256").update(octets).digest("hex");
}

async function principal() {
  const manifeste = JSON.parse(await readFile(MANIFESTE, "utf8"));
  const paquet = manifeste.pins.npmPackage;

  const atelier = await mkdtemp(join(tmpdir(), "spike-gcm-siv-"));
  try {
    // `npm.cmd` sous Windows plutôt que `shell: true` : passer des arguments à un interpréteur de
    // commandes les concatène sans échappement.
    const npm = process.platform === "win32" ? "npm.cmd" : "npm";
    await executer(npm, ["pack", paquet, "--silent"], { cwd: atelier });
    const [archive] = (await readdir(atelier)).filter((nom) => nom.endsWith(".tgz"));
    if (!archive) throw new Error(`npm pack n'a produit aucune archive pour ${paquet}`);

    const octetsArchive = await readFile(join(atelier, archive));
    const empreinteArchive = empreinte(octetsArchive);
    if (empreinteArchive !== manifeste.pins.npmTarballSha256) {
      throw new Error(
        `empreinte de l'archive ${paquet} : ${empreinteArchive}, attendue ${manifeste.pins.npmTarballSha256}`,
      );
    }

    await executer("tar", ["xzf", archive], { cwd: atelier });

    await rm(RACINE_CANDIDATE, { recursive: true, force: true });
    await mkdir(RACINE_CANDIDATE, { recursive: true });

    for (const artefact of manifeste.artifacts) {
      const octets = await readFile(join(atelier, ...artefact.entry.split("/")));
      const obtenue = empreinte(octets);
      if (octets.length !== artefact.bytes || obtenue !== artefact.sha256) {
        throw new Error(
          `empreinte de ${artefact.name} : ${obtenue} (${octets.length} o), attendue ${artefact.sha256} (${artefact.bytes} o)`,
        );
      }
      await writeFile(join(RACINE_CANDIDATE, artefact.name), octets);
    }

    await writeFile(
      join(RACINE_CANDIDATE, "VERIFIE.json"),
      `${JSON.stringify({ paquet, empreinteArchive, verifieLe: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
    console.log(`candidate ${paquet} vérifiée et déposée sous reports/spike-gcm-siv/candidate/`);
  } finally {
    await rm(atelier, { recursive: true, force: true });
  }
}

await principal();
