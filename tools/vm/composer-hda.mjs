// COMPOSE le disque système sur le disque de l'hôte, pour le harnais Node (#236, ADR 0041).
//
// Dans le navigateur, la coquille compose `hda` EN MÉMOIRE : elle télécharge le rootfs et le paquet
// aux décalages d'un tampon, et v86 le lit là. Sous Node, `tools/vm/boot-reference.mjs` sert ses
// disques par URL de fichier, en lecture asynchrone : il n'y a pas de tampon à remplir, il faut un
// FICHIER. Ce module l'écrit — table de partitions comprise —, avec le MÊME module pur que la
// coquille (`src/vm/disque-compose.mjs`), afin que le harnais et le produit ne puissent pas
// diverger sur la géométrie.
//
// Le fichier est REFAIT quand l'un de ses morceaux a changé, et seulement alors : le composer pèse
// un demi-gibioctet d'écriture, et `npm run test:vm:reference` boote plusieurs fois.

import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";

import { composerDisqueSysteme, ecrireTableDePartitions } from "../../src/vm/disque-compose.mjs";

/**
 * Empreinte d'un fichier, lu par tranches : un demi-gibioctet ne passe pas par un seul tampon.
 *
 * @param {string} chemin
 */
function empreinteDuFichier(chemin) {
  const flux = createHash("sha256");
  const descripteur = openSync(chemin, "r");
  try {
    const tranche = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (;;) {
      const lus = readSync(descripteur, tranche, 0, tranche.byteLength, null);
      if (lus === 0) break;
      flux.update(tranche.subarray(0, lus));
    }
  } finally {
    closeSync(descripteur);
  }
  return flux.digest("hex");
}

/** Nom du disque composé, et de la marque qui dit de quoi il est fait. */
export const NOM_DU_DISQUE_COMPOSE = "reference-hda-composee.img";
const NOM_DE_LA_MARQUE = "reference-hda-composee.json";

/**
 * COMPOSE le disque, ou rend celui qui est déjà là quand rien n'a changé.
 *
 * @param {{ manifeste: Record<string, any>, dossierArtefacts: string }} options
 * @returns {Promise<{ chemin: string, octets: number, recompose: boolean, plan: object }>}
 */
export async function composerLeDisqueSysteme({ manifeste, dossierArtefacts }) {
  const morceau = (role) => {
    const nom = manifeste.boot[role];
    const artefact = manifeste.artifacts.find((candidat) => candidat.name === nom);
    if (artefact === undefined) {
      throw new Error(`artefact « ${nom} » absent du manifeste : rien à composer pour ${role}`);
    }
    return { nom, chemin: join(dossierArtefacts, nom), ...artefact };
  };
  const rootfs = morceau("rootfs");
  const paquet = morceau("paquet");
  const plan = composerDisqueSysteme({
    rootfsOctets: rootfs.byteSize,
    paquetOctets: paquet.byteSize,
  });
  const chemin = join(dossierArtefacts, NOM_DU_DISQUE_COMPOSE);
  const cheminMarque = join(dossierArtefacts, NOM_DE_LA_MARQUE);
  const marque = {
    rootfs: rootfs.sha256,
    paquet: paquet.sha256,
    octets: plan.octets,
    cmdline: manifeste.boot.cmdline,
  };

  if (existsSync(chemin) && existsSync(cheminMarque) && statSync(chemin).size === plan.octets) {
    const ancienne = JSON.parse(readFileSync(cheminMarque, "utf8"));
    const memeSource =
      ancienne.rootfs === marque.rootfs &&
      ancienne.paquet === marque.paquet &&
      ancienne.octets === marque.octets;
    // Le marqueur dit de QUOI le fichier a été composé ; il ne dit pas ce que le fichier CONTIENT
    // aujourd'hui. Les octets sont donc relus et confrontés à l'empreinte inscrite (revue de
    // sécurité de la PR #237, constat 9) : sans cela, un disque modifié depuis — par une autre
    // suite, par un outil, par une écriture ratée — serait booté sur la foi d'un JSON. Le coût est
    // une lecture de 548 Mio, quelques secondes, contre une recomposition entière.
    if (memeSource && ancienne.empreinte === empreinteDuFichier(chemin)) {
      return { chemin, octets: plan.octets, recompose: false, plan };
    }
  }

  const fichier = await open(chemin, "w+");
  try {
    // Le fichier est d'abord porté à sa TAILLE, sans écrire ses zéros : sur un système de fichiers
    // qui gère les fichiers creux, seuls les morceaux réellement écrits occupent de la place.
    await fichier.truncate(plan.octets);
    await fichier.write(ecrireTableDePartitions(plan), 0, 512, 0);
    for (const [role, source] of [
      ["rootfs", rootfs],
      ["paquet", paquet],
    ]) {
      const octets = readFileSync(source.chemin);
      const empreinte = createHash("sha256").update(octets).digest("hex");
      if (empreinte !== source.sha256) {
        throw new Error(
          `${role} refusé : ${source.nom} a pour empreinte ${empreinte}, le manifeste déclare ${source.sha256}.`,
        );
      }
      await fichier.write(octets, 0, octets.byteLength, plan[role].debut);
    }
  } finally {
    await fichier.close();
  }
  // L'empreinte du disque COMPOSÉ, inscrite après l'écriture : c'est elle que la réutilisation
  // confronte au fichier trouvé, et non la seule concordance des sources.
  writeFileSync(
    cheminMarque,
    `${JSON.stringify({ ...marque, empreinte: empreinteDuFichier(chemin) }, null, 2)}\n`,
    "utf8",
  );
  return { chemin, octets: plan.octets, recompose: true, plan };
}
