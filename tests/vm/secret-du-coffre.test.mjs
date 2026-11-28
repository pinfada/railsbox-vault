// Le `secret_key_base` FOURNI PAR LE COFFRE, joué sous `dash` dans l'image de base du guest (#351).
//
// `secret-du-coffre.sh` tire 64 octets au premier démarrage, les garde sur le disque de données, et
// rend la MÊME valeur ensuite. Il remplace un fichier mal formé, et rend une valeur éphémère — en le
// disant — quand le disque refuse l'écriture. L'épreuve le joue sous le VRAI `dash` et les vrais
// `od`, `tr` et `sync` de `i386/debian:bookworm-slim` épinglé par `sources.json`, comme
// `schema-du-volume.test.mjs`.

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RACINE_DEPOT } from "../../tools/vm/boot-reference.mjs";

const SOURCES = JSON.parse(
  readFileSync(join(RACINE_DEPOT, "tools", "build-reference-image", "sources.json"), "utf8"),
);
const IMAGE = `${SOURCES.images.rootfs.reference}@${SOURCES.images.rootfs.digest}`;
const SCRIPT = join(RACINE_DEPOT, "tools", "build-reference-image", "guest", "secret-du-coffre.sh");

/**
 * La conduite jouée dans le conteneur : chaque cas imprime `@@<cas>|<sortie>|<valeur>|<fichier>|<mode>`
 * et ce que le script a dit sur sa sortie d'erreur, préfixé `## <cas>`.
 */
const CONDUITE = String.raw`
set -u
jouer() {
  cas="$1"; dossier="$2"
  valeur="$(sh /script/secret-du-coffre.sh "$dossier" 2> /tmp/dit)"; code=$?
  sed "s/^/## $cas /" /tmp/dit
  if [ -f "$dossier/.vault-secret-key-base" ]; then
    fichier="$(cat "$dossier/.vault-secret-key-base")"; mode="$(stat -c %a "$dossier/.vault-secret-key-base")"
  else
    fichier=@absent; mode=@absent
  fi
  echo "@@$cas|$code|$valeur|$fichier|$mode"
}
mkdir -p /neuf /mal
jouer premier /neuf
jouer second /neuf
printf 'pas-un-secret\n' > /mal/.vault-secret-key-base
jouer mal-forme /mal
jouer lecture-seule /ro
jouer lecture-seule-bis /ro
`;

/**
 * Docker, joué de façon ASYNCHRONE. Playwright charge aussi ce fichier (`testDir: tests/vm`), et ses
 * épreuves tournent alors dans le processus qui pilote le navigateur : un `spawnSync` y bloquait la
 * boucle d'événements pendant la première épreuve navigateur (`boot-trois-moteurs`, expirée à 300 s
 * au premier essai des deux runs de la branche de #351, jamais sur main).
 */
const executer = promisify(execFile);

async function docker(argumentsDocker) {
  try {
    const { stdout, stderr } = await executer("docker", argumentsDocker, {
      encoding: "utf8",
      maxBuffer: 1 << 24,
    });
    return { status: 0, stdout, stderr };
  } catch (erreur) {
    return {
      status: typeof erreur.code === "number" ? erreur.code : 1,
      stdout: erreur.stdout ?? "",
      stderr: erreur.stderr ?? String(erreur),
    };
  }
}

test(
  "secret-du-coffre.sh sous dash : tiré une fois, stable, remplacé s'il est mal formé, éphémère en lecture seule",
  { timeout: 600_000 },
  async (t) => {
    if ((await docker(["version", "--format", "{{.Server.Version}}"])).status !== 0) {
      t.skip("Docker indisponible : l'épreuve joue le vrai dash du guest");
      return;
    }
    const dossier = mkdtempSync(join(tmpdir(), "vault-secret-"));
    const lectureSeule = mkdtempSync(join(tmpdir(), "vault-secret-ro-"));
    try {
      writeFileSync(join(dossier, "conduite.sh"), CONDUITE);
      writeFileSync(join(dossier, "secret-du-coffre.sh"), readFileSync(SCRIPT));
      const jeu = await docker([
        "run",
        "--rm",
        "--platform",
        "linux/386",
        "-v",
        `${dossier}:/script:ro`,
        "-v",
        `${lectureSeule}:/ro:ro`,
        IMAGE,
        "dash",
        "/script/conduite.sh",
      ]);
      assert.equal(jeu.status, 0, jeu.stderr);
      const cas = new Map(
        jeu.stdout
          .split("\n")
          .filter((ligne) => ligne.startsWith("@@"))
          .map((ligne) => ligne.slice(2).split("|"))
          .map(([nom, code, valeur, fichier, mode]) => [nom, { code, valeur, fichier, mode }]),
      );
      const dit = (nom) =>
        jeu.stdout
          .split("\n")
          .filter((ligne) => ligne.startsWith(`## ${nom} `))
          .join("\n");
      const SECRET = /^[0-9a-f]{128}$/;

      const premier = cas.get("premier");
      assert.equal(premier.code, "0");
      assert.match(premier.valeur, SECRET);
      assert.equal(premier.fichier, premier.valeur, "gardé sur le disque de données");
      assert.equal(premier.mode, "600", "lisible du seul propriétaire");
      assert.match(dit("premier"), /tire pour ce coffre/);

      const second = cas.get("second");
      assert.equal(second.valeur, premier.valeur, "la MÊME valeur au boot suivant");
      assert.equal(dit("second"), "", "rien à dire quand il existe");

      const malForme = cas.get("mal-forme");
      assert.match(malForme.valeur, SECRET, "un fichier mal formé n'est jamais servi");
      assert.equal(malForme.fichier, malForme.valeur);

      const ro = cas.get("lecture-seule");
      assert.equal(ro.code, "0", "l'application démarre quand même");
      assert.match(ro.valeur, SECRET);
      assert.equal(ro.fichier, "@absent");
      assert.match(dit("lecture-seule"), /EPHEMERE/);
      assert.notEqual(
        cas.get("lecture-seule-bis").valeur,
        ro.valeur,
        "éphémère : tiré à chaque fois",
      );
    } finally {
      rmSync(dossier, { recursive: true, force: true });
      rmSync(lectureSeule, { recursive: true, force: true });
    }
  },
);
