// ACQUISITION du disque système : deux artefacts servis, un seul disque partitionné (#236, ADR 0041).
//
// Le guest boote sur `hda`. Jusqu'à cette tranche, `hda` était UN artefact — le rootfs nu, 385 Mio,
// monté par `root=/dev/sda`. Le paquet applicatif en devient la seconde partition, et ce module est
// l'endroit — le seul — où les octets venus du réseau deviennent ce disque.
//
// ## Un seul tampon, rempli aux décalages
//
// Les tailles sont connues du descripteur : le tampon est donc alloué UNE fois, à la taille du plan,
// et chaque morceau est écrit directement à son décalage. Télécharger dans un tampon intermédiaire
// puis recopier ferait cohabiter deux fois le rootfs — 770 Mio transitoires — sous un budget de
// 1,2 Gio (#67), et pour rien.
//
// ## L'empreinte avant l'usage, morceau par morceau
//
// Chaque morceau est haché PENDANT sa réception et confronté à ce que le descripteur déclare. Le
// refus est la règle du dépôt (ADR 0023, #123) et il a ici une conséquence propre : un rootfs
// substitué, c'est un noyau qui exécute autre chose ; un paquet substitué, c'est une application
// qui lit les données du coffre. L'empreinte du BLOC est prise à part, artefact par artefact, parce
// que c'est celle-là que la liaison de l'instantané porte (ADR 0024, `ARTEFACTS_DE_L_IMAGE`).

import {
  DISQUE_SYSTEME_MAX_OCTETS,
  composerDisqueSysteme,
  ecrireTableDePartitions,
} from "./disque-compose.mjs";
import { ouvrirLeFluxDArtefact } from "./flux-d-artefact.mjs";
import { createSha256Stream } from "./sha256-stream.mjs";

/**
 * TÉLÉCHARGE un morceau directement dans le tampon, à son décalage, en le hachant au passage.
 *
 * Un morceau COMPRESSÉ (gzip, #236 T2) est décompressé en flux par `ouvrirLeFluxDArtefact` : ce qui
 * est borné, rangé et haché ici est l'image DÉCOMPRESSÉE, comme avant. Rend les octets TRANSFÉRÉS.
 *
 * @param {{ tampon: Uint8Array, debut: number, morceau: { url: string, octets: number, sha256: string,
 *           compression?: string, transfertOctets?: number },
 *           nom: string, recuperer: typeof fetch }} parametres
 */
async function verserLeMorceau({ tampon, debut, morceau, nom, recuperer }) {
  const { lecteur, clore } = await ouvrirLeFluxDArtefact(morceau, { nom, recuperer });
  const empreinte = createSha256Stream();
  let recu = 0;
  for (;;) {
    const { value, done } = await lecteur.read();
    if (done) break;
    if (value.byteLength === 0) continue;
    if (recu + value.byteLength > morceau.octets) {
      throw new Error(
        `Artefact ${nom} refusé : plus de ${morceau.octets} octets reçus — le descripteur annonce ${morceau.octets} octets.`,
      );
    }
    empreinte.update(value);
    tampon.set(value, debut + recu);
    recu += value.byteLength;
  }
  if (recu !== morceau.octets) {
    throw new Error(
      `Artefact ${nom} refusé : ${recu} octets reçus, le descripteur en annonce ${morceau.octets}.`,
    );
  }
  const obtenue = empreinte.digestHex();
  if (obtenue !== morceau.sha256) {
    throw new Error(
      `Artefact ${nom} refusé : empreinte ${obtenue}, le descripteur déclare ${morceau.sha256}.`,
    );
  }
  return clore(recu);
}

/**
 * PLAN du disque, REFUSÉ s'il dépasse le budget de mémoire.
 *
 * Le contrôle vit ici et pas seulement dans la forme du descripteur : ce tampon est alloué sur des
 * tailles ANNONCÉES, avant le premier octet reçu, et il vit en RAM pour toute la session. Sans cette
 * borne, un descripteur ou un appelant fautif rendait un `RangeError` nu, hors de tout budget
 * (#67, ADR 0010 ; revue de sécurité de la PR #237, constat 4).
 */
function planSousBudget({ rootfs, paquet }) {
  const plan = composerDisqueSysteme({
    rootfsOctets: rootfs.octets,
    paquetOctets: paquet.octets,
  });
  if (plan.octets > DISQUE_SYSTEME_MAX_OCTETS) {
    throw new Error(
      `Disque système refusé : ${plan.octets} octets dépassent le plafond de ${DISQUE_SYSTEME_MAX_OCTETS} octets (budget de mémoire, #67).`,
    );
  }
  return plan;
}

/**
 * ACQUIERT le disque système entier : rootfs et paquet rangés, table de partitions écrite.
 *
 * Rend le tampon, le plan, et des VUES sur chaque morceau — des vues, jamais des copies : elles
 * servent à hacher l'image (`empreinteDeLImage`) sans doubler un seul octet.
 *
 * @param {{ rootfs: { url: string, octets: number, sha256: string },
 *           paquet: { url: string, octets: number, sha256: string },
 *           recuperer?: typeof fetch }} options
 */
export async function acquerirLeDisqueSysteme({ rootfs, paquet, recuperer = globalThis.fetch }) {
  const debut = Date.now();
  const plan = planSousBudget({ rootfs, paquet });
  const tampon = new Uint8Array(plan.octets);

  // En SÉRIE, et non en parallèle : deux flux concurrents doublent la mémoire des morceaux en vol
  // sans rien accélérer sur une origine unique, et le rootfs pèse à lui seul 385 Mio.
  let transfereOctets = 0;
  transfereOctets += await verserLeMorceau({
    tampon,
    debut: plan.rootfs.debut,
    morceau: rootfs,
    nom: "rootfs",
    recuperer,
  });
  transfereOctets += await verserLeMorceau({
    tampon,
    debut: plan.paquet.debut,
    morceau: paquet,
    nom: "paquet",
    recuperer,
  });

  // La table vient EN DERNIER : écrite d'abord, elle décrirait un disque dont les partitions ne
  // sont pas encore là, et un refus en cours d'acquisition laisserait un disque à demi vrai.
  ecrireTableDePartitions(plan, tampon);

  return {
    tampon,
    plan,
    vues: {
      rootfs: tampon.subarray(plan.rootfs.debut, plan.rootfs.debut + rootfs.octets),
      paquet: tampon.subarray(plan.paquet.debut, plan.paquet.debut + paquet.octets),
    },
    mesures: {
      transfereOctets,
      disqueOctets: tampon.byteLength,
      acquisitionMs: Date.now() - debut,
    },
  };
}
