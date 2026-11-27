// Le MODE `--avec-image` de la publication : le descripteur applicatif ET tout ce qu'il nomme sous
// `/artifacts/` (#45, ADR 0030 § Limites, ADR 0017).
//
// Sans lui, l'arbre publié porte au mieux le descripteur : la coquille publiée reçoit un 404 sur le
// rootfs, le paquet, le noyau, l'initrd et les BIOS, et ne démarre pas. Il n'est PAS le mode par
// défaut : la chaîne recopie et hache tout ce qu'elle émet, et l'image pèse plus de 200 Mio —
// `npm run check` garderait son budget (`publication.yml` seul passe `--avec-image`).
//
// Ce qui est copié se déduit du DESCRIPTEUR, jamais d'une liste de répertoire : `artifacts/
// reference-image/` peut porter les images brutes (environ 1 Gio) que l'origine ne sert pas. Un nom
// que le descripteur ne cite pas n'entre donc pas dans l'arbre, et un nom qu'il cite et que le disque
// n'a pas est un refus (code 4 de `publier.mjs`), pas un arbre amputé en silence.
//
// Les octets viennent toujours du DISQUE (`image:build` ne versionne rien), y compris sous
// `--commit` : c'est la même exception nommée que `vendor/v86/artefacts` (`publier-sources.mjs`).
// Leur IDENTITÉ est vérifiée AVANT d'être publiée : la taille de chaque fichier, l'empreinte du noyau, de
// l'initrd et des deux BIOS, et l'empreinte DÉCOMPRESSÉE du rootfs, du paquet, de la graine et du paquet
// précédent (`precedent.paquet`), recalculée en flux. Un fichier de même taille et d'un autre contenu est
// refusé (code 4). L'E2E `tests/e2e/publie-seul.spec.mjs` le prouve ensuite de bout en bout.

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { copyFile, mkdir, readFile, stat } from "node:fs/promises";
import { Writable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { dirname, join } from "node:path";

import { formeDuDescripteur } from "../src/coquille/descripteur-applicatif.mjs";

/** Empreinte et taille d'un fichier gzip DÉCOMPRESSÉ, en flux (l'image du rootfs fait plus de 400 Mio). */
async function empreinteDecompressee(chemin) {
  const hachage = createHash("sha256");
  let octets = 0;
  await pipeline(
    createReadStream(chemin),
    createGunzip(),
    new Writable({
      write(morceau, _encodage, suite) {
        hachage.update(morceau);
        octets += morceau.byteLength;
        suite();
      },
    }),
  );
  return { octets, sha256: hachage.digest("hex") };
}

export const CHEMIN_DU_DESCRIPTEUR = "artifacts/application.json";

/** Erreur portant le code « source obligatoire absente » de `publier.mjs`. */
function sourceAbsente(message) {
  const erreur = new Error(message);
  erreur.sourceAbsente = true;
  return erreur;
}

/**
 * Les fichiers que le descripteur nomme, avec la taille TRANSFÉRÉE attendue (et l'empreinte, quand
 * elle porte sur les octets servis).
 *
 * @param {Record<string, any>} descripteur déjà validé
 * @returns {{ nom: string, octets: number, sha256: string | null,
 *            decompresse: { octets: number, sha256: string } | null }[]}
 */
export function fichiersDeLImage(descripteur) {
  const servi = (morceau) => ({
    nom: morceau.nom,
    octets: morceau.transfertOctets ?? morceau.octets,
    // Sans compression, `sha256` décrit les octets servis ; sinon il décrit l'image DÉCOMPRESSÉE, que
    // `copierLImage` recalcule en flux (`decompresse`) : le publieur ne se fie ni au nom ni à la taille.
    sha256: morceau.compression === undefined ? morceau.sha256 : null,
    decompresse:
      morceau.compression === undefined ? null : { octets: morceau.octets, sha256: morceau.sha256 },
  });
  const boot = descripteur.boot;
  const brut = (cle) => ({
    nom: boot[cle],
    octets: boot.empreintes[cle].octets,
    sha256: boot.empreintes[cle].sha256,
    decompresse: null,
  });
  const liste = [
    servi(descripteur.rootfs),
    servi(descripteur.paquet),
    servi(descripteur.graine),
    brut("kernel"),
    brut("initrd"),
    brut("bios"),
    brut("vgaBios"),
  ];
  if (descripteur.precedent !== undefined) liste.push(servi(descripteur.precedent.paquet));
  // Un NOM désigne UN fichier : deux déclarations du même nom doivent être IDENTIQUES (taille servie, empreinte,
  // taille et empreinte décompressées). Le dédoublonnage par le seul nom laissait un paquet courant et un
  // paquet précédent de même nom, d'empreintes différentes, ne vérifier que le premier — alors que le
  // descripteur les accepte. C'est le publieur qui refuse.
  const vus = new Map();
  for (const fichier of liste) {
    const signature = JSON.stringify([fichier.octets, fichier.sha256, fichier.decompresse]);
    const deja = vus.get(fichier.nom);
    if (deja !== undefined && deja !== signature) {
      throw sourceAbsente(
        `Descripteur applicatif : déclarations contradictoires pour ${fichier.nom} (même nom, tailles ou ` +
          "empreintes différentes). Un nom désigne un seul fichier.",
      );
    }
    vus.set(fichier.nom, signature);
  }
  return liste.filter(({ nom }, index) => liste.findIndex((f) => f.nom === nom) === index);
}

/**
 * COPIE le descripteur et ses artefacts dans l'arbre `destination`, à l'adresse que le descripteur
 * annonce (`prefixeDesArtefacts`).
 *
 * @param {{ racine: string, destination: string }} o
 * @returns {Promise<{ chemins: string[], octets: number }>}
 */
export async function copierLImage({ racine, destination }) {
  const source = join(racine, CHEMIN_DU_DESCRIPTEUR);
  let texte;
  try {
    texte = await readFile(source, "utf8");
  } catch {
    throw sourceAbsente(
      `Descripteur applicatif absent (${CHEMIN_DU_DESCRIPTEUR}) : --avec-image l'exige. ` +
        "« npm run image:build » le produit.",
    );
  }
  const descripteur = JSON.parse(texte);
  const forme = formeDuDescripteur(descripteur);
  if (!forme.valide) {
    throw sourceAbsente(
      `Descripteur applicatif refusé (${forme.motif}) : « npm run image:manifest ».`,
    );
  }
  const dossier = descripteur.prefixeDesArtefacts.slice("/artifacts/".length);
  const chemins = [CHEMIN_DU_DESCRIPTEUR];
  await mkdir(join(destination, "artifacts"), { recursive: true });
  await copyFile(source, join(destination, CHEMIN_DU_DESCRIPTEUR));
  let octets = Buffer.byteLength(texte);

  for (const fichier of fichiersDeLImage(descripteur)) {
    const depuis = join(racine, "artifacts", dossier, fichier.nom);
    const metadonnees = await stat(depuis).catch(() => null);
    if (!metadonnees?.isFile()) {
      throw sourceAbsente(
        `Artefact de l'image absent : ${depuis}, nommé par le descripteur. « npm run image:build » le produit.`,
      );
    }
    if (metadonnees.size !== fichier.octets) {
      throw sourceAbsente(
        `Artefact de l'image ${fichier.nom} : ${metadonnees.size} octets sur le disque, ` +
          `le descripteur en annonce ${fichier.octets}. Le descripteur et l'image ne sont pas de la même fabrication.`,
      );
    }
    if (fichier.sha256 !== null) {
      const mesure = createHash("sha256")
        .update(await readFile(depuis))
        .digest("hex");
      if (mesure !== fichier.sha256) {
        throw sourceAbsente(
          `Artefact de l'image ${fichier.nom} : empreinte ${mesure}, le descripteur déclare ${fichier.sha256}.`,
        );
      }
    }
    if (fichier.decompresse !== null) {
      const mesure = await empreinteDecompressee(depuis).catch((erreur) => {
        throw sourceAbsente(
          `Artefact de l'image ${fichier.nom} : gzip illisible (${erreur.message}).`,
        );
      });
      if (
        mesure.octets !== fichier.decompresse.octets ||
        mesure.sha256 !== fichier.decompresse.sha256
      ) {
        throw sourceAbsente(
          `Artefact de l'image ${fichier.nom} : empreinte décompressée ${mesure.sha256} (${mesure.octets} octets), ` +
            `le descripteur déclare ${fichier.decompresse.sha256} (${fichier.decompresse.octets} octets).`,
        );
      }
    }
    const vers = join(destination, "artifacts", dossier, fichier.nom);
    await mkdir(dirname(vers), { recursive: true });
    await copyFile(depuis, vers);
    chemins.push(`artifacts/${dossier}${fichier.nom}`);
    octets += metadonnees.size;
  }
  return { chemins, octets };
}
