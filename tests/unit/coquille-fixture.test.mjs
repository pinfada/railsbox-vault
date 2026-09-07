/**
 * Ce qui tient la FIXTURE malveillante et la porte du harnais (#161, ADR 0028).
 *
 * Trois propriétés, et chacune a déjà été fausse quelque part dans ce dépôt :
 *
 *  - **les recopies de la fixture disent la vérité.** L'adversaire connaît la géométrie du produit
 *    parce que la source est publique ; il ne l'apprend pas de nous, et la fixture la RECOPIE
 *    plutôt que de l'importer. Une recopie que rien ne relit finit toujours par diverger — et une
 *    sonde qui cherche au mauvais endroit conclut « absent » partout, y compris là où le fichier
 *    existe. Le témoin positif serait alors vert pour une mauvaise raison ;
 *  - **la fixture n'est jamais publiée.** Elle est l'adversaire ; la servir depuis l'une des deux
 *    origines de l'ADR 0002 reviendrait à publier l'attaque avec la défense ;
 *  - **aucun fichier publié ne porte la valeur du jeton du harnais.** La coquille ne LIT ce jeton
 *    que d'un paramètre d'URL, et le Worker de confiance le confronte à la garde de
 *    `src/vm/cle-de-volume.mjs`. Un fichier publié qui contiendrait sa valeur transformerait une
 *    porte de harnais en chemin de production.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ENVELOPPE_DE_LA_COQUILLE,
  REPERTOIRE_DES_VOLUMES,
  TEMOIN_CHEMIN,
  TEMOIN_INTERCEPTE,
  VOLUME_DE_LA_COQUILLE,
} from "../../public/coquille-epreuve/marqueurs.mjs";
import { VOLUME_DIRECTORY } from "../../src/vm/opfs-sync-access.mjs";
import { HARNAIS_CLE_JETON } from "../../src/vm/cle-de-volume.mjs";
import {
  EXCLUSIONS,
  SOURCES_COQUILLE,
  estPublie,
  motifDExclusion,
} from "../../tools/publier-arborescences.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function lire(relatif) {
  return readFile(path.join(REPO_ROOT, relatif), "utf8");
}

test("la fixture cherche le volume LÀ OÙ le produit le range", async () => {
  assert.equal(REPERTOIRE_DES_VOLUMES, VOLUME_DIRECTORY);
  const worker = await lire("public/runtime-worker.mjs");
  assert.match(
    worker,
    new RegExp(`const VOLUME = "${VOLUME_DE_LA_COQUILLE}";`),
    "le nom de volume recopié par la fixture n'est plus celui du Worker de confiance.",
  );
  assert.equal(ENVELOPPE_DE_LA_COQUILLE, `${VOLUME_DE_LA_COQUILLE}.cles`);
});

test("le Service Worker de la fixture recopie fidèlement le chemin et le contenu du témoin", async () => {
  // Il est CLASSIQUE et recopie ses constantes, comme celui du spike #35 : les Service Workers de
  // type module ne sont pas offerts par les trois moteurs, et l'épreuve ne doit pas confondre
  // « attaque impossible » avec « attaque écrite dans une syntaxe non supportée ».
  const source = await lire("public/coquille-epreuve/hostile-sw.mjs");
  assert.ok(!/^\s*import\s/m.test(source), "un Service Worker de module ne tourne pas partout.");
  assert.match(source, new RegExp(`"${TEMOIN_CHEMIN}"`));
  assert.match(source, new RegExp(`"${TEMOIN_INTERCEPTE}"`));
});

test("le fichier témoin existe et porte le contenu AUTHENTIQUE", async () => {
  const { TEMOIN_AUTHENTIQUE } = await import("../../public/coquille-epreuve/marqueurs.mjs");
  assert.equal(
    (await lire(TEMOIN_CHEMIN.slice(1).replace(/^/, "public/"))).trim(),
    TEMOIN_AUTHENTIQUE,
  );
});

test("la fixture malveillante n'est publiée sur AUCUNE des deux origines", () => {
  for (const chemin of [
    "public/coquille-epreuve/hostile.html",
    "public/coquille-epreuve/hostile.mjs",
    "public/coquille-epreuve/hostile-sw.mjs",
    "public/coquille-epreuve/hostile-topologie.mjs",
    "public/coquille-epreuve/marqueurs.mjs",
    "public/coquille-epreuve/temoin.txt",
  ]) {
    assert.equal(estPublie(chemin), false, `${chemin} est publié`);
    const motif = motifDExclusion(chemin);
    assert.ok(motif !== null, `${chemin} n'est retiré par aucun motif`);
    assert.ok(motif.length > 40, `le motif de ${chemin} n'explique rien`);
  }
});

test("le document applicatif de DÉVELOPPEMENT n'est publié nulle part non plus", () => {
  // L'ADR 0002 le refuse des deux côtés : sur l'origine de confiance ce serait un document
  // applicatif, sur l'origine applicative un artefact de ce dépôt.
  for (const chemin of ["public/document-applicatif.html", "public/document-applicatif.mjs"]) {
    assert.equal(estPublie(chemin), false);
    assert.match(motifDExclusion(chemin), /ADR 0002|Même motif/);
  }
});

/**
 * Le SEUL fichier publié qui porte la valeur du jeton du harnais, et le seul qui ait le droit.
 *
 * Il la DÉFINIT, et sans étape de construction une constante que le produit compare existe
 * forcément dans le code servi : la cacher demanderait un minifieur, c'est-à-dire une promesse qui
 * dépend d'un outil plutôt que d'une frontière. Ce que le dépôt promet est donc autre chose, et
 * c'est ce que `tests/browser/coquille-frontiere.spec.mjs` › « le jeton du harnais est PUBLIC,
 * lisible d'ici, et ne sert à rien d'ici » mesure : la connaître ne donne rien depuis l'origine
 * applicative, parce que le port privilégié où elle s'emploie n'y est pas atteignable.
 */
const PORTEUR_DU_JETON = "src/vm/cle-de-volume.mjs";

test("UN SEUL fichier publié porte la valeur du jeton du harnais, et c'est celui qui la définit", async () => {
  // La version d'avant s'EXCLUAIT du balayage : elle sautait `src/vm/cle-de-volume.mjs`, c'est-à-dire
  // le seul fichier publié qui porte le jeton, et elle était donc verte par construction. C'est le
  // constat 1 de la revue de la PR #166. Le balayage EXIGE désormais de le trouver là — un témoin de
  // fouille — et rougit sur un second porteur.
  const porteurs = [];
  for (const source of SOURCES_COQUILLE) {
    if (source.optionnel) continue;
    for (const chemin of await fichiersDe(source.depuis)) {
      let contenu;
      try {
        contenu = await lire(chemin);
      } catch {
        continue;
      }
      if (contenu.includes(HARNAIS_CLE_JETON)) porteurs.push(chemin);
    }
  }
  assert.deepEqual(
    porteurs,
    [PORTEUR_DU_JETON],
    "Le jeton du harnais doit se trouver dans EXACTEMENT un fichier publié : celui qui le définit.",
  );
});

test("la coquille ne LIT plus aucun jeton : le paramètre de #161 a disparu (#162)", async () => {
  // #161 lisait le jeton d'un paramètre nommé, et l'épreuve d'alors EXIGEAIT ce paramètre : « la
  // coquille doit LIRE le jeton d'un paramètre nommé, et non le porter ». La décision 1 de
  // l'ADR 0029 le retire, et l'exigence s'inverse — c'est désormais la PRÉSENCE du paramètre qui
  // rougit. Une épreuve qui aurait seulement cessé de l'exiger n'aurait rien empêché.
  for (const chemin of ["public/main.mjs", "public/runtime-worker.mjs", "public/index.html"]) {
    const contenu = await lire(chemin);
    assert.ok(
      !contenu.includes(HARNAIS_CLE_JETON),
      `${chemin} fige la valeur du jeton du harnais.`,
    );
    assert.ok(
      !contenu.includes("deverrouillage-harnais"),
      `${chemin} lit encore le paramètre de harnais de #161 : le déverrouillage est un geste de l'utilisateur.`,
    );
  }
});

test("la PAGE et le Worker s'accordent sur l'identifiant du volume de la coquille", async () => {
  // La page RECOPIE cet identifiant : elle en a besoin AVANT que le coffre existe, pour lier la KEK
  // d'une passkey neuve à l'identité de son emplacement, c'est-à-dire à un moment où l'inventaire
  // ne peut rien lui apprendre. Une recopie que rien ne relit finit toujours par diverger — et ici
  // la divergence produirait une passkey qui n'ouvre rien, sans qu'aucun refus ne dise pourquoi.
  const empreinte =
    /Uint8Array\.from\(\{ length: 16 \}, \(_, index\) => \(0x21 \+ index \* 0x07\) % 256\)/;
  assert.match(await lire("public/runtime-worker.mjs"), empreinte);
  assert.match(await lire("public/main.mjs"), empreinte);
});

/** Liste les fichiers `.mjs`, `.html` et `.json` d'une source de publication. */
async function fichiersDe(depuis) {
  const { readdir, stat } = await import("node:fs/promises");
  const absolu = path.join(REPO_ROOT, depuis);
  let information;
  try {
    information = await stat(absolu);
  } catch {
    return [];
  }
  if (!information.isDirectory()) return [depuis];
  const trouves = [];
  for (const entree of await readdir(absolu, { withFileTypes: true, recursive: true })) {
    if (entree.isDirectory()) continue;
    const relatif = path
      .relative(REPO_ROOT, path.join(entree.parentPath ?? entree.path, entree.name))
      .split(path.sep)
      .join("/");
    trouves.push(relatif);
  }
  return trouves;
}

test("chaque exclusion neuve retire une surface qui existe encore", async () => {
  const neuves = EXCLUSIONS.filter(({ prefixe }) =>
    /coquille-epreuve|document-applicatif/.test(prefixe),
  );
  assert.equal(neuves.length, 3, "#161 retire trois surfaces : la fixture et les deux documents.");
});
