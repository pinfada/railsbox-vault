// Le script de SCHÉMA du guest, joué sous `dash` dans l'image de base du guest (#236 T2, ADR 0042 ;
// revue de sécurité de la PR #249, constats 2, 3, 4 et 6).
//
// `schema-du-volume.sh` décide, avant Rails, s'il migre, s'il refuse, ou s'il ne fait rien. Ses gardes
// sont des comparaisons de `dash` — qui rend « Illegal number », évalué FAUX, sur un nombre illisible ou
// trop long : c'est ce qui les avait désarmées. L'épreuve le joue donc sous le VRAI `dash`, dans
// `i386/debian:bookworm-slim` épinglé par `sources.json` (la base du rootfs), avec un `bundle` simulé et
// une ligne du noyau fournie par `VAULT_CMDLINE`. Un seul conteneur joue tous les cas.
//
// Ce qui est exigé, cas par cas : le code de sortie, la ligne de refus ou de constat, et que RIEN ne
// soit migré ni réécrit quand le script refuse. Les deux points de coupure que l'épreuve VM ne place
// pas — entre l'intention et `db:migrate`, entre le marqueur et le retrait de l'intention — sont joués
// ici par l'état qu'ils laissent sur le disque.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

import { RACINE_DEPOT } from "../../tools/vm/boot-reference.mjs";

const SOURCES = JSON.parse(
  readFileSync(join(RACINE_DEPOT, "tools", "build-reference-image", "sources.json"), "utf8"),
);
const IMAGE = `${SOURCES.images.rootfs.reference}@${SOURCES.images.rootfs.digest}`;
const SCRIPT = join(RACINE_DEPOT, "tools", "build-reference-image", "guest", "schema-du-volume.sh");

const M = "20260101000002";
const N = "20260919000002";
const BASE = "root=/dev/sda1 init=/opt/vault/guest-init.sh";

/**
 * Les CAS : l'état du disque avant, la ligne du noyau, et ce qui est exigé après. `null` = marqueur
 * absent ; une chaîne est écrite TELLE QUELLE (sans fin de ligne ajoutée si elle en porte déjà une).
 */
const CAS = [
  // — la migration exige l'AUTORISATION du Worker (constat 4) —
  {
    nom: "non-autorisee",
    V: M,
    P: N,
    I: null,
    cmd: `vault.schema=${M}`,
    sortie: 3,
    ligne: /REFUS migration-non-autorisee/,
    apres: { V: M, I: null },
    rails: false,
  },
  {
    nom: "autorisee",
    V: M,
    P: N,
    I: null,
    cmd: `vault.schema=${M} vault.migrer=1`,
    sortie: 0,
    ligne: new RegExp(`migration jouee de=${M} vers=${N}`),
    apres: { V: N, I: null },
    rails: true,
  },
  // — marqueurs invalides : refus, rien migré ni réécrit (constat 3) —
  ...[
    ["non-numerique", "abc"],
    ["espaces", ` ${M}`],
    ["signe", `-${M}`],
    ["zeros-de-tete", `0${M.slice(1)}`],
    ["quinze-chiffres", "202601010000021"],
    ["vingt-chiffres", "99999999999999999999"],
    ["deux-nombres", `${M} ${M}`],
  ].map(([nom, valeur]) => ({
    nom: `volume-${nom}`,
    V: valeur,
    P: N,
    I: null,
    cmd: "vault.migrer=1",
    sortie: 3,
    ligne: /REFUS marqueur-invalide nom=volume/,
    apres: { V: valeur, I: null },
    rails: false,
  })),
  {
    nom: "volume-vide",
    V: "",
    P: N,
    I: null,
    cmd: "vault.migrer=1",
    sortie: 3,
    ligne: /REFUS divergent volume=absent/,
    apres: { V: "", I: null },
    rails: false,
  },
  {
    nom: "paquet-vingt-chiffres",
    V: M,
    P: "99999999999999999999",
    I: null,
    cmd: "vault.migrer=1",
    sortie: 3,
    ligne: /REFUS marqueur-invalide nom=paquet/,
    apres: { V: M, I: null },
    rails: false,
  },
  {
    nom: "intention-invalide",
    V: N,
    P: N,
    I: "zz",
    cmd: "",
    sortie: 3,
    ligne: /REFUS marqueur-invalide nom=intention/,
    apres: { V: N, I: "zz" },
    rails: false,
  },
  // — l'espace vault.* : un double est refusé, une valeur invalide aussi (constat 2) —
  {
    nom: "schema-en-double",
    V: M,
    P: N,
    I: null,
    cmd: `vault.schema=${N} vault.schema=${M} vault.migrer=1`,
    sortie: 3,
    ligne: /REFUS parametre-double/,
    apres: { V: M, I: null },
    rails: false,
  },
  {
    nom: "migrer-en-double",
    V: M,
    P: N,
    I: null,
    cmd: "vault.migrer=1 vault.migrer=1",
    sortie: 3,
    ligne: /REFUS parametre-double/,
    apres: { V: M, I: null },
    rails: false,
  },
  {
    nom: "schema-attendu-invalide",
    V: M,
    P: N,
    I: null,
    cmd: "vault.schema=abc vault.migrer=1",
    sortie: 3,
    ligne: /REFUS marqueur-invalide/,
    apres: { V: M, I: null },
    rails: false,
  },
  // — les gardes de fond —
  {
    nom: "donnees-plus-recentes",
    V: N,
    P: M,
    I: null,
    cmd: "vault.migrer=1",
    sortie: 3,
    ligne: /REFUS anterieur/,
    apres: { V: N, I: null },
    rails: false,
  },
  {
    nom: "intention-au-dela-du-paquet",
    V: M,
    P: M,
    I: N,
    cmd: "vault.migrer=1",
    sortie: 3,
    ligne: /REFUS anterieur .*intention=/,
    apres: { V: M, I: N },
    rails: false,
  },
  {
    nom: "divergent",
    V: M,
    P: N,
    I: null,
    cmd: "vault.schema=20250101000001 vault.migrer=1",
    sortie: 3,
    ligne: /REFUS divergent/,
    apres: { V: M, I: null },
    rails: false,
  },
  // — les DEUX points de coupure que l'épreuve VM ne place pas (constat 6) —
  {
    nom: "coupe-apres-intention-avant-migration",
    V: M,
    P: N,
    I: N,
    cmd: `vault.schema=${M} vault.migrer=1`,
    sortie: 0,
    ligne: /migration jouee/,
    apres: { V: N, I: null },
    rails: true,
  },
  {
    nom: "coupe-apres-marqueur-avant-retrait",
    V: N,
    P: N,
    I: N,
    cmd: `vault.schema=${M}`,
    sortie: 0,
    ligne: new RegExp(`migration aucune schema=${N}`),
    apres: { V: N, I: null },
    rails: false,
  },
  {
    nom: "rien-a-faire",
    V: N,
    P: N,
    I: null,
    cmd: `vault.schema=${N}`,
    sortie: 0,
    ligne: /migration aucune/,
    apres: { V: N, I: null },
    rails: false,
  },
];

/** Écrit le script de conduite : chaque cas pose son disque, joue le script, et dit ce qu'il reste. */
function conduite() {
  const marqueur = (chemin, valeur) =>
    valeur === null ? `rm -f ${chemin}` : `printf '%s\\n' '${valeur}' > ${chemin}`;
  const lignes = [
    "set -u",
    "mkdir -p /app/var /app/db /opt/vault /run /var/log",
    "printf '#!/bin/sh\\ntouch /tmp/rails\\necho \"== 20260919000001 AjouterUneNote: migrated (0.1s)\"\\nexit 0\\n' > /usr/local/bin/bundle",
    "chmod +x /usr/local/bin/bundle",
  ];
  for (const cas of CAS) {
    lignes.push(
      "rm -f /tmp/rails /app/var/.vault-schema /app/var/.vault-migration /app/db/.vault-schema",
      cas.V === "" ? ": > /app/var/.vault-schema" : marqueur("/app/var/.vault-schema", cas.V),
      marqueur("/app/db/.vault-schema", cas.P),
      marqueur("/app/var/.vault-migration", cas.I),
      `printf '%s\\n' '${BASE} ${cas.cmd}' > /tmp/cmdline`,
      "sortie=$(VAULT_CMDLINE=/tmp/cmdline dash /script/schema-du-volume.sh 2>&1); code=$?",
      `printf '@@%s|%s|%s|%s|%s\\n' '${cas.nom}' "$code" "$(cat /app/var/.vault-schema 2>/dev/null || echo @absent)" "$(cat /app/var/.vault-migration 2>/dev/null || echo @absent)" "$(test -e /tmp/rails && echo oui || echo non)"`,
      `printf '%s\\n' "$sortie" | sed 's/^/## ${cas.nom} /'`,
    );
  }
  return lignes.join("\n");
}

function dockerDisponible() {
  const sonde = spawnSync("docker", ["version", "--format", "{{.Server.Version}}"], {
    encoding: "utf8",
  });
  return sonde.status === 0;
}

test(
  "schema-du-volume.sh sous dash : marqueurs invalides, vault.* en double, migration non autorisée et coupures",
  {
    skip: dockerDisponible() ? false : "Docker indisponible : l'épreuve joue le vrai dash du guest",
    timeout: 600_000,
  },
  () => {
    const dossier = mkdtempSync(join(tmpdir(), "vault-schema-"));
    try {
      writeFileSync(join(dossier, "conduite.sh"), conduite());
      writeFileSync(join(dossier, "schema-du-volume.sh"), readFileSync(SCRIPT));
      const jeu = spawnSync(
        "docker",
        [
          "run",
          "--rm",
          "--platform",
          "linux/386",
          "-v",
          `${dossier}:/script:ro`,
          IMAGE,
          "dash",
          "/script/conduite.sh",
        ],
        { encoding: "utf8", maxBuffer: 1 << 24 },
      );
      assert.equal(jeu.status, 0, jeu.stderr);
      const sorties = new Map();
      for (const ligne of jeu.stdout.split("\n")) {
        const trouve = ligne.match(/^## (\S+) (.*)$/);
        if (trouve) sorties.set(trouve[1], `${sorties.get(trouve[1]) ?? ""}${trouve[2]}\n`);
      }
      const resultats = jeu.stdout
        .split("\n")
        .filter((ligne) => ligne.startsWith("@@"))
        .map((ligne) => ligne.slice(2).split("|"));
      assert.equal(resultats.length, CAS.length);
      for (const [nom, code, V, I, rails] of resultats) {
        const cas = CAS.find((candidat) => candidat.nom === nom);
        const dit = sorties.get(nom) ?? "";
        assert.equal(Number(code), cas.sortie, `${nom} : sortie ${code}\n${dit}`);
        assert.match(dit, cas.ligne, `${nom} : ce que le script a dit\n${dit}`);
        assert.equal(
          V,
          cas.apres.V === null ? "@absent" : cas.apres.V,
          `${nom} : marqueur des données`,
        );
        assert.equal(I, cas.apres.I === null ? "@absent" : cas.apres.I, `${nom} : intention`);
        assert.equal(
          rails === "oui",
          cas.rails,
          `${nom} : db:migrate ${rails === "oui" ? "joué" : "non joué"}`,
        );
      }
    } finally {
      rmSync(dossier, { recursive: true, force: true });
    }
  },
);
