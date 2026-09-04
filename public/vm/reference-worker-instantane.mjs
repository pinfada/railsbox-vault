// CAPTURE et REPRISE par instantané, côté Worker de référence (#65, ADR 0024).
//
// Ce module tient les six gestes que le banc enchaîne, et rien d'autre : il ne boote pas, ne vérifie
// aucun invariant et ne décide d'aucune assertion. Il vit à part de `reference-worker-boot.mjs`
// parce que la capture est un PROTOCOLE — point de contrôle, liaison, quiescence, scellement,
// reprise du service — dont chaque étape a une raison d'être à sa place.
//
// ## L'ordre de la capture, et pourquoi il ne se réarrange pas
//
//  1. **POINT DE CONTRÔLE** d'abord. La charge validée est rangée dans le volume et le journal est
//     vidé, ce qui écrit une racine neuve donc AVANCE la séquence. Capturer avant lierait
//     l'instantané à une séquence que la fermeture allait périmer aussitôt.
//  2. **LIAISON ensuite**, lue APRÈS le point de contrôle. C'est le seul instant où elle décrit ce
//     que le volume porte réellement.
//  3. **ARRÊT de l'émulateur**, puis attente que l'adaptateur n'ait plus d'E/S en vol.
//  4. **QUIESCENCE**, qui refuse si une E/S est en vol — c'est le filet qui rend visible un arrêt
//     qui n'aurait pas eu lieu.
//  5. **CAPTURE et SCELLEMENT** par le chemin de production.
//  6. **REPRISE du service**, et une capture qui a vu la moindre E/S est ABANDONNÉE : le fichier est
//     retiré. Il n'y a pas de capture partielle, il n'y a pas de capture « probablement bonne ».

import { capturerInstantane, ouvrirInstantaneDeReprise } from "/src/vm/instantane-de-reprise.mjs";
import { supportInstantaneOpfs } from "/src/vm/instantane/support-opfs.mjs";
import { createSha256Stream } from "/src/vm/sha256-stream.mjs";

/** Ordre CANONIQUE des artefacts dans l'empreinte d'image. Deux ordres donneraient deux empreintes. */
const ARTEFACTS_DE_L_IMAGE = Object.freeze([
  "wasm",
  "bios",
  "vgaBios",
  "kernel",
  "initrd",
  "rootfs",
]);

/**
 * EMPREINTE de l'image de référence : SHA-256 de la suite des empreintes de ses artefacts.
 *
 * Elle est calculée sur les OCTETS RÉELLEMENT ACQUIS, pas sur un manifeste : le Worker ne reçoit
 * aucun manifeste d'image, et une empreinte déclarée par celui qui la présente ne prouverait rien.
 * Le coût est un hachage des artefacts acquis — mesuré et publié par le banc.
 *
 * L'ordre des artefacts est FIXE : deux ordres donneraient deux empreintes pour la même image, et
 * un instantané parfaitement valide serait alors écarté sans raison.
 */
export async function empreinteDeLImage(artifacts) {
  const flux = createSha256Stream();
  for (const nom of ARTEFACTS_DE_L_IMAGE) {
    const octets = artifacts[nom];
    if (!(octets instanceof Uint8Array)) {
      throw new Error(`Empreinte d'image impossible : l'artefact « ${nom} » manque.`);
    }
    const partiel = createSha256Stream();
    partiel.update(octets);
    flux.update(new TextEncoder().encode(`${nom}:`));
    flux.update(partiel.digest());
  }
  return flux.digest();
}

/**
 * L'ÉTAT PRÉSENT du volume, tel que la liaison d'un instantané le nomme.
 *
 * Il est lu APRÈS le point de contrôle, et il faut le dire : la séquence avance au vidage qui clôt
 * un point de contrôle, si bien qu'une liaison lue avant décrirait un état que la fermeture allait
 * périmer.
 */
export async function etatPresentDuVolume(backend, empreinteImage) {
  const racine = await backend.generation.racineValidee();
  if (racine.empreinteRegion === null) {
    throw new Error(
      "Instantané impossible : ce volume est ouvert SANS fraîcheur, donc sans empreinte de région. Un instantané lié à trente-deux zéros se lierait à n'importe quel volume.",
    );
  }
  return {
    formatVolume: backend.chiffre.scellement.formatVersion,
    sequence: racine.sequence,
    generation: racine.generation,
    empreinteRegion: racine.empreinteRegion,
    empreinteImage,
  };
}

/** Attend que l'adaptateur n'ait plus d'E/S en vol. Rend le compte observé, borné dans le temps. */
async function attendreLeRepos(adapter, { essais = 400, pasMs = 5 } = {}) {
  for (let essai = 0; essai < essais && adapter.status().inFlight > 0; essai += 1) {
    await new Promise((resoudre) => setTimeout(resoudre, pasMs));
  }
  return adapter.status().inFlight;
}

/**
 * CAPTURE un instantané après un point de contrôle. Rend le compte rendu, jamais un verdict.
 *
 * Aucune exception ne remonte d'ici pour un motif de capture : une capture ratée ne doit pas faire
 * échouer une fermeture par ailleurs propre — le volume est intact, et la prochaine ouverture
 * bootera à froid. Ce qui remonte, c'est le RAPPORT, et le banc le publie.
 */
export async function capturerApresPointDeControle({
  backend,
  session,
  adapter,
  volume,
  artifacts,
}) {
  const debut = performance.now();
  const support = supportInstantaneOpfs(volume);
  try {
    if (backend.generation.rangeable) await backend.generation.pointDeControle();
    const empreinteImage = await empreinteDeLImage(artifacts);
    const etatPresent = await etatPresentDuVolume(backend, empreinteImage);

    const enVol = await attendreLeRepos(adapter);
    if (enVol > 0) {
      return { capture: false, motif: "eS-en-vol", enVol, millisecondes: null, octets: null };
    }
    adapter.quiescer();
    let capture;
    let violations;
    try {
      const etat = await session.capturer();
      capture = await capturerInstantane({
        scellement: backend.chiffre.scellement,
        volume,
        etatPresent,
        etat,
        support,
      });
    } finally {
      ({ violations } = adapter.reprendre());
    }
    if (violations > 0) {
      // Il n'y a pas de capture partielle : le fichier écrit décrirait une mémoire qui a vu ce que
      // le support n'a pas reçu. Il est retiré, et le motif est publié.
      await support.retirer();
      return {
        capture: false,
        motif: "quiescence-rompue",
        violations,
        millisecondes: null,
        octets: null,
      };
    }
    return {
      capture: true,
      motif: null,
      violations: 0,
      octets: capture.octets,
      etatV86Octets: capture.liaison.longueurEtat,
      deltaRootfsOctets: session.deltaRootfsOctets(),
      sequence: etatPresent.sequence,
      generation: etatPresent.generation,
      millisecondes: Number((performance.now() - debut).toFixed(1)),
    };
  } catch (cause) {
    await support.retirer().catch(() => {});
    return {
      capture: false,
      motif: cause?.code ?? cause?.name ?? "erreur",
      message: cause?.message ?? null,
      millisecondes: null,
      octets: null,
    };
  } finally {
    support.fermer();
  }
}

/**
 * OUVRE l'instantané d'un volume, ou dit pourquoi il est écarté.
 *
 * Elle ne restaure rien : elle rend l'état v86 et le compte rendu, et c'est le boot qui décide. La
 * séparation n'est pas de la coquetterie — le banc doit pouvoir publier « écarté au motif X, boot à
 * froid » sans que le chemin de boot ait à connaître les motifs.
 */
export async function ouvrirInstantanePourReprise({ backend, volume, artifacts }) {
  const debut = performance.now();
  const support = supportInstantaneOpfs(volume);
  try {
    const empreinteImage = await empreinteDeLImage(artifacts);
    const etatPresent = await etatPresentDuVolume(backend, empreinteImage);
    const rapport = await ouvrirInstantaneDeReprise({
      scellement: backend.chiffre.scellement,
      volume,
      etatPresent,
      support,
    });
    return {
      ...rapport,
      millisecondes: Number((performance.now() - debut).toFixed(1)),
      sequence: etatPresent.sequence,
      generation: etatPresent.generation,
    };
  } finally {
    support.fermer();
  }
}
