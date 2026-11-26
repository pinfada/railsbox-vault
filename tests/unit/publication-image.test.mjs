/**
 * Le mode `--avec-image` (#45) : le descripteur ET tout ce qu'il nomme entrent dans l'arbre publié,
 * et rien d'autre. Sans lui la coquille publiée ne démarre pas (404 sur le rootfs, le noyau…).
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import * as image from "../../tools/publier-image.mjs";
import { descripteurDEpreuve } from "./support-coffre-de-la-coquille.mjs";

const sha = (octets) => createHash("sha256").update(octets).digest("hex");

/** Un descripteur VALIDE dont chaque artefact existe sur un disque jetable, à sa taille et son empreinte. */
async function racineDEpreuve({ corrompre = null } = {}) {
  const racine = await mkdtemp(join(tmpdir(), "image-"));
  const descripteur = descripteurDEpreuve();
  descripteur.prefixeDesArtefacts = "/artifacts/reference-image/";
  const dossier = join(racine, "artifacts", "reference-image");
  await mkdir(dossier, { recursive: true });
  const poser = async (nom, contenu) => writeFile(join(dossier, nom), contenu);
  for (const cle of ["rootfs", "paquet", "graine"]) {
    const contenu = Buffer.from(`image ${cle}`);
    descripteur[cle].nom = `${cle}.ext4.gz`;
    descripteur[cle].octets = 4096;
    descripteur[cle].compression = "gzip";
    descripteur[cle].transfertOctets = contenu.byteLength;
    if (cle === "graine") descripteur.graine.disqueOctets = 4096;
    await poser(descripteur[cle].nom, contenu);
  }
  for (const [role, nom] of [["kernel", "vmlinuz"], ["initrd", "initrd"], ["bios", "seabios.bin"], ["vgaBios", "vgabios.bin"]]) {
    const contenu = Buffer.from(`boot ${role}`);
    descripteur.boot[role] = nom;
    descripteur.boot.empreintes[role] = { sha256: sha(contenu), octets: contenu.byteLength };
    await poser(nom, role === corrompre ? Buffer.from("autre chose!") : contenu);
  }
  await poser("intrus.ext4", Buffer.from("image brute que le descripteur ne nomme pas"));
  await writeFile(join(racine, "artifacts", "application.json"), JSON.stringify(descripteur));
  return racine;
}

test("fichiersDeLImage : les sept artefacts nommés, une fois chacun, taille servie pour les gzip", async () => {
  const racine = await racineDEpreuve();
  const fichiers = image.fichiersDeLImage(descripteurDEpreuve());
  assert.equal(fichiers.length, 7);
  assert.equal(new Set(fichiers.map(({ nom }) => nom)).size, 7);
  await rm(racine, { recursive: true });
});

test("copierLImage copie le descripteur et ce qu'il nomme à l'adresse annoncée — et RIEN d'autre", async (t) => {
  const racine = await racineDEpreuve();
  const destination = await mkdtemp(join(tmpdir(), "arbre-"));
  t.after(() => Promise.all([rm(racine, { recursive: true }), rm(destination, { recursive: true })]));
  const { chemins } = await image.copierLImage({ racine, destination });
  const presents = (await readdir(destination, { recursive: true, withFileTypes: true }))
    .filter((e) => e.isFile())
    .map((e) => join(e.parentPath, e.name).slice(destination.length + 1))
    .sort();
  assert.deepEqual(presents, chemins.slice().sort());
  assert.ok(presents.includes("artifacts/application.json"));
  assert.ok(presents.includes("artifacts/reference-image/rootfs.ext4.gz"));
  assert.ok(!presents.some((chemin) => chemin.includes("intrus")), "un fichier non nommé n'est pas publié");
});

test("un artefact nommé et absent du disque est un refus « source absente », pas un arbre amputé", async (t) => {
  const racine = await racineDEpreuve();
  const destination = await mkdtemp(join(tmpdir(), "arbre-"));
  t.after(() => Promise.all([rm(racine, { recursive: true }), rm(destination, { recursive: true })]));
  await rm(join(racine, "artifacts", "reference-image", "rootfs.ext4.gz"));
  await assert.rejects(image.copierLImage({ racine, destination }), (erreur) => {
    assert.equal(erreur.sourceAbsente, true);
    assert.match(erreur.message, /rootfs\.ext4\.gz/);
    return true;
  });
});

test("un descripteur absent ou une empreinte de boot qui ne correspond pas sont refusés", async (t) => {
  const destination = await mkdtemp(join(tmpdir(), "arbre-"));
  const vide = await mkdtemp(join(tmpdir(), "vide-"));
  const corrompu = await racineDEpreuve({ corrompre: "kernel" });
  t.after(() => Promise.all([rm(destination, { recursive: true }), rm(vide, { recursive: true }), rm(corrompu, { recursive: true })]));
  await assert.rejects(image.copierLImage({ racine: vide, destination }), /Descripteur applicatif absent/);
  await assert.rejects(image.copierLImage({ racine: corrompu, destination }), /vmlinuz/);
});
