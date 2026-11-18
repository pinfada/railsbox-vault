// Choix du constructeur Docker pour les images i386 (#295).
//
// Pourquoi ce module existe. Depuis le 29/10/2026 `ubuntu-latest` est ubuntu-26.04, qui embarque
// Docker 29.4.2 et libseccomp 2.6.0. Le profil seccomp par défaut y a été resserré (moby#52494,
// CVE-2026-31431) et le constructeur INTÉGRÉ renvoie ENOSYS à `socket` pour les binaires 32 bits :
// la glibc i386 n'obtient aucune socket, et `apt-get update` dit « Temporary failure resolving »
// — un DNS qui semble cassé et ne l'est pas. Le profil du démon (`daemon.json`) ne s'applique pas
// aux étapes `RUN`, que BuildKit exécute sous son propre profil.
//
// Ce que le module fait : il SONDE le constructeur par défaut (un `RUN` i386 qui crée une socket,
// sans réseau), le garde s'il convient, et sinon bascule sur un constructeur BuildKit isolé
// (`docker-container`), épinglé par empreinte dans `sources.json` (`images.buildkit`), dont le
// profil laisse passer les sockets 32 bits. Si ce constructeur-là échoue aussi, la construction
// s'arrête AVANT les vingt minutes de compilation, avec la cause en clair.
//
// Limite écrite : le constructeur isolé exécute les `RUN` sous le profil de BuildKit, moins strict
// que celui de Docker 29.4.2 (un filtre seccomp ne lit pas les arguments de `socketcall`, qui sont
// en mémoire : on ne peut pas y bloquer `AF_ALG`). Acceptable pour des sources épinglées par
// empreinte, un exécutant éphémère et aucun secret ; à ne pas étendre à du code non fiable.
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..");
const sources = JSON.parse(
  readFileSync(join(RACINE, "tools", "build-reference-image", "sources.json"), "utf8"),
);
const i386 = sources.images.rootfs;
const buildkit = sources.images.buildkit;

export const NOM_CONSTRUCTEUR = "railsbox-vault-buildkit";

/** Dockerfile de la sonde : une socket peut-elle se créer dans un `RUN` 32 bits ? */
export const DOCKERFILE_SONDE = `FROM ${i386.reference}@${i386.digest}
SHELL ["linux32", "/bin/sh", "-c"]
RUN out=$(bash -c 'exec 3<>/dev/tcp/127.0.0.1/9' 2>&1 || true); \\
    case "$out" in \\
      *"Function not implemented"*|*"Operation not permitted"*) echo "sonde: $out"; exit 1 ;; \\
    esac
`;

/**
 * Arguments de `docker build` pour un constructeur donné. `--load` : un constructeur
 * `docker-container` ne range pas l'image dans le démon sans lui, et l'outillage la relit ensuite
 * par `docker create` / `docker export`.
 *
 * @param {string | null} constructeur nom du constructeur, ou `null` pour celui du démon
 * @param {string[]} args arguments propres à la construction
 * @returns {string[]}
 */
export function argumentsDeBuild(constructeur, args) {
  return [
    "build",
    ...(constructeur === null ? [] : ["--builder", constructeur]),
    "--load",
    ...args,
  ];
}

/**
 * @param {string | null} constructeur
 * @returns {{ ok: boolean, sortie: string }}
 */
function sonder(constructeur) {
  const resultat = spawnSync(
    "docker",
    argumentsDeBuild(constructeur, [
      "--platform",
      "linux/386",
      "--no-cache",
      "--progress=plain",
      "-",
    ]),
    { input: DOCKERFILE_SONDE, encoding: "utf8" },
  );
  return {
    ok: resultat.error === undefined && resultat.status === 0,
    sortie: `${resultat.stdout ?? ""}\n${resultat.stderr ?? ""}${resultat.error?.message ?? ""}`,
  };
}

function creerLeConstructeur() {
  const existe = spawnSync("docker", ["buildx", "inspect", NOM_CONSTRUCTEUR], {
    encoding: "utf8",
  });
  if (existe.status !== 0) {
    const creation = spawnSync(
      "docker",
      [
        "buildx",
        "create",
        "--name",
        NOM_CONSTRUCTEUR,
        "--driver",
        "docker-container",
        "--driver-opt",
        `image=${buildkit.reference}@${buildkit.digest}`,
      ],
      { encoding: "utf8" },
    );
    if (creation.status !== 0) {
      throw new Error(`création du constructeur BuildKit refusée : ${creation.stderr}`);
    }
  }
  const demarrage = spawnSync("docker", ["buildx", "inspect", "--bootstrap", NOM_CONSTRUCTEUR], {
    encoding: "utf8",
  });
  if (demarrage.status !== 0) {
    throw new Error(`démarrage du constructeur BuildKit refusé : ${demarrage.stderr}`);
  }
}

/** @type {{ constructeur: string | null, argumentsDeBuild: (args: string[]) => string[] } | null} */
let memo = null;

/**
 * Choisit le constructeur pour les images i386, une fois par processus.
 *
 * @returns {{ constructeur: string | null, argumentsDeBuild: (args: string[]) => string[] }}
 */
export function obtenirConstructeur() {
  if (memo !== null) return memo;

  // `VAULT_CONSTRUCTEUR_ISOLE=1` force le constructeur isolé, sans sonder celui du démon : pour
  // rejouer sur un hôte sain le chemin que prend Docker ≥ 29.4.2, ou comparer les deux constructeurs.
  const force = process.env.VAULT_CONSTRUCTEUR_ISOLE === "1";
  const parDefaut = force
    ? { ok: false, sortie: "(non sondé : constructeur isolé forcé)" }
    : sonder(null);
  if (parDefaut.ok) {
    memo = { constructeur: null, argumentsDeBuild: (args) => argumentsDeBuild(null, args) };
    return memo;
  }

  console.warn(
    "→ le constructeur Docker par défaut refuse les sockets 32 bits (seccomp de Docker ≥ 29.4.2,\n" +
      "  moby#52494, voir #295) : bascule sur un constructeur BuildKit isolé, épinglé par empreinte.",
  );
  creerLeConstructeur();
  const isole = sonder(NOM_CONSTRUCTEUR);
  if (!isole.ok) {
    throw new Error(
      "Aucun constructeur Docker ne laisse un processus 32 bits créer une socket : la\n" +
        "construction de l'image i386 échouerait plus tard sur « Temporary failure resolving »\n" +
        `(#295).\n--- constructeur par défaut ---\n${parDefaut.sortie}\n` +
        `--- ${NOM_CONSTRUCTEUR} ---\n${isole.sortie}`,
    );
  }
  memo = {
    constructeur: NOM_CONSTRUCTEUR,
    argumentsDeBuild: (args) => argumentsDeBuild(NOM_CONSTRUCTEUR, args),
  };
  return memo;
}
