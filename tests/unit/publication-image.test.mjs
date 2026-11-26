/**
 * Le mode `--avec-image` (#45) : le descripteur ET tout ce qu'il nomme entrent dans l'arbre publié, et rien
 * d'autre — après avoir vérifié l'IDENTITÉ de chaque artefact : l'empreinte DÉCOMPRESSÉE du rootfs, du paquet,
 * de la graine et du paquet PRÉCÉDENT, et celle du noyau, de l'initrd et des deux BIOS.
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { gzipSync } from "node:zlib";

import * as image from "../../tools/publier-image.mjs";
import { descripteurDEpreuve } from "./support-coffre-de-la-coquille.mjs";

const sha = (octets) => createHash("sha256").update(octets).digest("hex");
const OCTETS = 4096;
const MORCEAUX = ["rootfs", "paquet", "graine", "precedent"];

/**
 * Un descripteur VALIDE dont chaque artefact existe sur un disque jetable. `alterer` remplace le contenu d'un
 * morceau gzip par un AUTRE contenu de même taille décompressée (et `transfertOctets` suit le fichier réel) :
 * seule l'empreinte décompressée peut le voir.
 */
async function racineDEpreuve({ corrompre = null, alterer = null } = {}) {
  const racine = await mkdtemp(join(tmpdir(), "image-"));
  const descripteur = descripteurDEpreuve();
  descripteur.prefixeDesArtefacts = "/artifacts/reference-image/";
  descripteur.application.version = "1.1.0";
  const dossier = join(racine, "artifacts", "reference-image");
  await mkdir(dossier, { recursive: true });
  const morceau = async (cle, nom) => {
    const brut = Buffer.alloc(OCTETS, cle.length);
    const servi = gzipSync(cle === alterer ? Buffer.alloc(OCTETS, 99) : brut);
    await writeFile(join(dossier, nom), servi);
    return {
      nom,
      octets: OCTETS,
      sha256: sha(brut),
      compression: "gzip",
      transfertOctets: servi.byteLength,
    };
  };
  for (const cle of ["rootfs", "paquet", "graine"]) {
    descripteur[cle] = { ...(await morceau(cle, `${cle}.ext4.gz`)) };
  }
  descripteur.graine.disqueOctets = OCTETS;
  descripteur.precedent = {
    application: {
      id: descripteur.application.id,
      version: "1.0.0",
      schema: descripteur.application.schema,
    },
    paquet: await morceau("precedent", "precedent.ext4.gz"),
  };
  for (const [role, nom] of [
    ["kernel", "vmlinuz"],
    ["initrd", "initrd"],
    ["bios", "seabios.bin"],
    ["vgaBios", "vgabios.bin"],
  ]) {
    const contenu = Buffer.from(`boot ${role}`);
    descripteur.boot[role] = nom;
    descripteur.boot.empreintes[role] = { sha256: sha(contenu), octets: contenu.byteLength };
    await writeFile(
      join(dossier, nom),
      role === corrompre ? Buffer.from(`boot ${role}`.replace(/.$/, "X")) : contenu,
    );
  }
  await writeFile(join(dossier, "intrus.ext4"), "image brute que le descripteur ne nomme pas");
  await writeFile(join(racine, "artifacts", "application.json"), JSON.stringify(descripteur));
  return racine;
}

async function copier(t, options) {
  const racine = await racineDEpreuve(options);
  const destination = await mkdtemp(join(tmpdir(), "arbre-"));
  t.after(() =>
    Promise.all([rm(racine, { recursive: true }), rm(destination, { recursive: true })]),
  );
  return { racine, destination, copie: () => image.copierLImage({ racine, destination }) };
}

test("fichiersDeLImage : huit artefacts nommés, une fois chacun, précédent compris", () => {
  const descripteur = descripteurDEpreuve();
  descripteur.precedent = { paquet: { nom: "p", octets: 1, sha256: "d".repeat(64) } };
  const fichiers = image.fichiersDeLImage(descripteur);
  assert.equal(fichiers.length, 8);
  assert.equal(new Set(fichiers.map(({ nom }) => nom)).size, 8);
});

test("copierLImage copie le descripteur et ce qu'il nomme à l'adresse annoncée — et RIEN d'autre", async (t) => {
  const { destination, copie } = await copier(t);
  const { chemins } = await copie();
  const presents = (await readdir(destination, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(destination.length + 1))
    .sort();
  assert.deepEqual(presents, chemins.slice().sort());
  assert.ok(presents.includes("artifacts/application.json"));
  assert.ok(presents.includes("artifacts/reference-image/precedent.ext4.gz"));
  assert.ok(
    !presents.some((chemin) => chemin.includes("intrus")),
    "un fichier non nommé n'est pas publié",
  );
});

test("un artefact nommé et absent du disque est un refus « source absente », pas un arbre amputé", async (t) => {
  const { racine, copie } = await copier(t);
  await rm(join(racine, "artifacts", "reference-image", "rootfs.ext4.gz"));
  await assert.rejects(copie(), (erreur) => {
    assert.equal(erreur.sourceAbsente, true);
    assert.match(erreur.message, /rootfs\.ext4\.gz/);
    return true;
  });
});

test("un descripteur absent ou une empreinte de boot qui ne correspond pas sont refusés", async (t) => {
  const vide = await mkdtemp(join(tmpdir(), "vide-"));
  t.after(() => rm(vide, { recursive: true }));
  await assert.rejects(
    image.copierLImage({ racine: vide, destination: vide }),
    /Descripteur applicatif absent/,
  );
  const { copie } = await copier(t, { corrompre: "kernel" });
  await assert.rejects(copie(), /vmlinuz/);
});

test("une taille qui ne correspond pas au descripteur est refusée : deux fabrications mêlées", async (t) => {
  const { racine, copie } = await copier(t);
  await writeFile(join(racine, "artifacts", "reference-image", "rootfs.ext4.gz"), "tronqué");
  await assert.rejects(copie(), /rootfs\.ext4\.gz.*octets sur le disque/s);
});

for (const cle of MORCEAUX) {
  test(`une altération de MÊME TAILLE du ${cle} (gzip valide, autre contenu) est refusée par l'empreinte décompressée`, async (t) => {
    const { destination, copie } = await copier(t, { alterer: cle });
    await assert.rejects(copie(), (erreur) => {
      assert.equal(erreur.sourceAbsente, true);
      assert.match(erreur.message, /empreinte décompressée/);
      return true;
    });
    const arbre = await readdir(destination, { recursive: true }).catch(() => []);
    assert.ok(
      !arbre.some((chemin) => String(chemin).endsWith(`${cle}.ext4.gz`)),
      "rien n'est publié avant le refus",
    );
  });
}

test("un gzip tronqué ou illisible est refusé en le nommant, pas par une erreur nue", async (t) => {
  const { racine, copie } = await copier(t);
  const chemin = join(racine, "artifacts", "reference-image", "graine.ext4.gz");
  const servi = gzipSync(Buffer.alloc(OCTETS, 5)).subarray(0, 20);
  await writeFile(chemin, servi);
  const descripteur = JSON.parse(
    await (
      await import("node:fs/promises")
    ).readFile(join(racine, "artifacts", "application.json"), "utf8"),
  );
  descripteur.graine.transfertOctets = servi.byteLength;
  await writeFile(join(racine, "artifacts", "application.json"), JSON.stringify(descripteur));
  await assert.rejects(copie(), /graine\.ext4\.gz/);
});
