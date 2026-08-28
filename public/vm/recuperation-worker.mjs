// Worker du banc de RÉCUPÉRATION (#91). Il ne prouve aucune atomicité : il CHRONOMÈTRE.
//
// `docs/quality-attributes.md` demande que la dernière génération valide soit retrouvée en ≤ 60 s.
// Ce budget n'était mesuré nulle part : aucune épreuve ne chronométrait une récupération, et aucune
// ne la faisait porter sur une charge réaliste. Ce banc remplit un journal de génération jusqu'aux
// abords du plafond sur OPFS RÉEL, ferme, rouvre, et publie le temps que l'ouverture a pris.
//
// Ce qu'il mesure exactement : `GenerationStore.ouvrir` sur un journal portant une génération
// VALIDÉE et non rangée — deux passes de relecture du journal, la recopie dans le volume, la
// barrière du volume, puis le vidage du journal. C'est le chemin qu'un boot à froid emprunte après
// une coupure.
//
// Ce qu'il ne mesure PAS, et qu'il ne faut pas lui faire dire :
//
//  - le temps de boot de la VM, explicitement hors budget ;
//  - une coupure réelle. La session de préparation FERME proprement son handle au lieu d'être tuée.
//    La sémantique d'une coupure est la promesse de #16, et c'est `resilience-arrets.spec.mjs` qui
//    l'éprouve sur ce même support ; ici, seule la DURÉE compte, et le journal laissé derrière est
//    octet pour octet le même.
//  - la machine de l'utilisateur. Un relevé est daté, situé, et publié avec son étendue.

import {
  GenerationStore,
  PLAFOND_CHARGE_OCTETS,
  TAMPON_RELECTURE_OCTETS,
} from "/src/vm/generation-store.mjs";
import { Scellement } from "/src/vm/scellement.mjs";
import { cleDuBanc, poserCleDuBanc } from "./cle-du-banc.mjs";
import {
  generationJournalName,
  openOpfsSyncAccess,
  removeOpfsVolume,
} from "/src/vm/opfs-sync-access.mjs";
import { TRANCHE_REGION_OCTETS, empreinteDeRegion } from "/src/vm/generation-fraicheur.mjs";
import { dispositionV3 } from "/src/vm/volume-chiffre-format.mjs";

/** Volume jetable du banc. Il est retiré avant et après chaque répétition. */
const VOLUME = "recuperation-banc";

/**
 * Identifiant de volume du banc. FIXE : il entre dans les données associées de chaque
 * enregistrement, et un identifiant tiré à chaque répétition ferait refuser la charge que la
 * préparation vient de sceller (ADR 0015).
 */
const IDENTIFIANT = "1ec0de1ec0de1ec0de1ec0de1ec0de11";

/** Motif déterministe : le contenu n'a pas d'importance, sa reproductibilité si. */
function motif(octets, graine) {
  const tampon = new Uint8Array(octets);
  for (let index = 0; index < octets; index += 1) {
    tampon[index] = (index * 31 + graine * 97 + 11) & 0xff;
  }
  return tampon;
}

async function nettoyer() {
  await removeOpfsVolume(VOLUME);
}

/** Ouvre les deux fichiers du banc : le volume et son journal voisin. */
async function ouvrirFichiers(tailleVolume) {
  const volume = await openOpfsSyncAccess(VOLUME);
  if (volume.getSize() !== tailleVolume) volume.truncate(tailleVolume);
  const journal = await openOpfsSyncAccess(generationJournalName(VOLUME));
  return { volume, journal };
}

async function magasinSur({ volume, journal }, tailleVolume, plafondOctets) {
  return GenerationStore.ouvrir({
    // La fraîcheur de l'ADR 0019 est DÉCLARÉE absente ici, jamais oubliée : ce banc n'ouvre pas
    // un volume v3 complet, il n'a ni région d'authentification ni voisin où poser un témoin. Le
    // magasin écrit alors des racines sans empreinte, et son rapport le publie.
    fraicheur: null,
    volume: VOLUME,
    handle: journal,
    tailleVolume,
    // Le scellement du produit, sous la clé de TEST du harnais. Ce banc mesure la DURÉE d'une
    // récupération : depuis #18 elle comprend l'ouverture de chaque enregistrement, et la mesurer
    // sans elle ne dirait plus rien du produit.
    scellement: await Scellement.ouvrir({
      volume: IDENTIFIANT,
      cleOctets: cleDuBanc(),
      formatVersion: 3,
    }),
    // Le plafond est EXPLICITE : un profil témoin doit pouvoir dépasser celui de production pour
    // mesurer ce qu'il coûtait, sans quoi le chiffre qui a fait bouger le plafond deviendrait
    // irreproductible dès que le plafond bouge.
    plafondOctets,
    async lireVolume(offset, longueur) {
      const cible = new Uint8Array(longueur);
      volume.read(cible, { at: offset });
      return cible;
    },
    ecrireVolume: async (offset, octets) => volume.write(octets, { at: offset }),
    barriereVolume: () => volume.flush(),
    // Le rangement automatique est DÉSARMÉ : un point de contrôle viderait le journal, et la
    // réouverture n'aurait plus rien à rejouer — c'est-à-dire plus rien à chronométrer.
    seuilPointDeControle: Number.MAX_SAFE_INTEGER,
  });
}

/**
 * Dépose une charge jusqu'aux abords de `chargeCible`, la valide, puis ferme proprement.
 * @returns {Promise<{ octets: number, enregistrements: number, preparationMs: number }>}
 */
async function preparer({ tailleVolume, chargeCible, enregistrementOctets, plafondOctets }) {
  const debut = performance.now();
  const fichiers = await ouvrirFichiers(tailleVolume);
  const magasin = await magasinSur(fichiers, tailleVolume, plafondOctets);
  let enregistrements = 0;
  let offset = 0;
  while (magasin.octetsDeCharge + enregistrementOctets + 16 <= chargeCible) {
    await magasin.deposer(offset, motif(enregistrementOctets, enregistrements + 1));
    offset += enregistrementOctets;
    enregistrements += 1;
  }
  const octets = magasin.octetsDeCharge;
  await magasin.valider();
  // Fermeture PROPRE, sans point de contrôle : la génération validée reste dans le journal, et la
  // prochaine ouverture devra la rejouer. Voir l'en-tête sur ce que cela ne prouve pas.
  magasin.close();
  fichiers.volume.close();
  return { octets, enregistrements, preparationMs: performance.now() - debut };
}

/** Rouvre, et CHRONOMÈTRE la récupération. Rien d'autre n'est dans la fenêtre mesurée. */
async function recuperer(tailleVolume, plafondOctets) {
  const fichiers = await ouvrirFichiers(tailleVolume);
  const debut = performance.now();
  const magasin = await magasinSur(fichiers, tailleVolume, plafondOctets);
  const dureeMs = performance.now() - debut;
  const rapport = magasin.rapport;
  magasin.close();
  fichiers.volume.close();
  return { dureeMs, rapport };
}

/** Centile d'une série TRIÉE, par interpolation linéaire. Six échantillons ne font pas un p95 fin. */
function centile(triees, rang) {
  if (triees.length === 0) return null;
  const position = (triees.length - 1) * rang;
  const bas = Math.floor(position);
  const haut = Math.ceil(position);
  if (bas === haut) return triees[bas];
  return triees[bas] + (triees[haut] - triees[bas]) * (position - bas);
}

function resumer(durees) {
  const triees = [...durees].sort((a, b) => a - b);
  const min = triees[0];
  const max = triees[triees.length - 1];
  const moyenne = triees.reduce((somme, valeur) => somme + valeur, 0) / triees.length;
  return {
    echantillons: triees.length,
    p50Ms: centile(triees, 0.5),
    p95Ms: centile(triees, 0.95),
    minMs: min,
    maxMs: max,
    moyenneMs: moyenne,
    // BRUIT : l'étendue rapportée à la médiane. Publier un p95 sans lui laisserait croire à une
    // précision que six répétitions sur une machine de développement n'ont pas.
    etendueRelative: moyenne === 0 ? 0 : (max - min) / moyenne,
  };
}

/**
 * Rejoue `repetitions` fois le cycle « remplir, fermer, rouvrir, chronométrer ».
 *
 * @param {{ chargeCible?: number, enregistrementOctets?: number, repetitions?: number }} options
 */
async function mesurer({
  chargeCible = PLAFOND_CHARGE_OCTETS,
  enregistrementOctets = 64 * 1024,
  repetitions = 7,
  plafondOctets = chargeCible,
} = {}) {
  const tailleVolume = Math.ceil(chargeCible / enregistrementOctets) * enregistrementOctets;
  const releves = [];
  for (let rang = 0; rang < repetitions; rang += 1) {
    await nettoyer();
    const prepare = await preparer({
      tailleVolume,
      chargeCible,
      enregistrementOctets,
      plafondOctets,
    });
    const { dureeMs, rapport } = await recuperer(tailleVolume, plafondOctets);
    releves.push({
      rang,
      dureeMs,
      preparationMs: prepare.preparationMs,
      etat: rapport.etat,
      enregistrementsRejoues: rapport.enregistrementsRejoues,
      octetsRejoues: rapport.octetsRejoues,
      surmemoireMaxOctets: rapport.surmemoireMaxOctets,
      chargeDeposeeOctets: prepare.octets,
      enregistrementsDeposes: prepare.enregistrements,
    });
  }
  await nettoyer();
  return {
    profil: {
      chargeCibleOctets: chargeCible,
      enregistrementOctets,
      tailleVolumeOctets: tailleVolume,
      plafondOctets,
      plafondProductionOctets: PLAFOND_CHARGE_OCTETS,
      tamponRelectureOctets: TAMPON_RELECTURE_OCTETS,
    },
    recuperation: resumer(releves.map((releve) => releve.dureeMs)),
    preparation: resumer(releves.map((releve) => releve.preparationMs)),
    releves,
  };
}

/**
 * Coût de l'EMPREINTE DE RÉGION sur OPFS RÉEL, à l'échelle du volume applicatif (#19, ADR 0019).
 *
 * Ce que ce mode mesure : les lectures OPFS de la région, tranche par tranche, et le hachage
 * incrémental qui les absorbe — c'est-à-dire exactement `empreinteDeRegion`, par le chemin de
 * production, sur le vrai support.
 *
 * Ce qu'il ne fait PAS, et pourquoi : il ne SCELLE pas le volume. Un scellement complet de 512 Mio
 * coûte 87,6 s (ADR 0016) et ne changerait pas d'une milliseconde le coût mesuré ici — le hachage
 * ne dépend pas de ce que la région contient, seulement de sa taille. Le fichier est donc alloué à
 * sa taille support et sa région remplie d'un motif déterministe. Le dire vaut mieux que de laisser
 * croire à une mesure de bout en bout.
 */
async function mesurerFraicheur({ tailleLogique = 512 * 1024 * 1024, repetitions = 3 } = {}) {
  const disposition = dispositionV3(tailleLogique);
  await nettoyer();
  const handle = await openOpfsSyncAccess(VOLUME);
  const releves = [];
  try {
    handle.truncate(disposition.tailleSupport);
    const tranche = motif(TRANCHE_REGION_OCTETS, 7);
    for (let ecrit = 0; ecrit < disposition.regionOctets; ecrit += TRANCHE_REGION_OCTETS) {
      const longueur = Math.min(TRANCHE_REGION_OCTETS, disposition.regionOctets - ecrit);
      handle.write(tranche.subarray(0, longueur), { at: disposition.regionOffset + ecrit });
    }
    handle.flush();

    const lireRegion = async (offset, longueur) => {
      const cible = new Uint8Array(longueur);
      const lus = handle.read(cible, { at: offset });
      return lus === longueur ? cible : cible.subarray(0, lus);
    };
    for (let rang = 0; rang < repetitions; rang += 1) {
      const debut = performance.now();
      await empreinteDeRegion({
        lireRegion,
        volume: VOLUME,
        regionOffset: disposition.regionOffset,
        regionOctets: disposition.regionOctets,
      });
      releves.push(performance.now() - debut);
    }
  } finally {
    handle.close();
    await nettoyer();
  }
  return {
    mode: "fraicheur",
    profil: {
      tailleLogiqueOctets: tailleLogique,
      regionOctets: disposition.regionOctets,
      tailleSupportOctets: disposition.tailleSupport,
      trancheOctets: TRANCHE_REGION_OCTETS,
    },
    empreinte: resumer(releves),
    releves: releves.map((dureeMs, rang) => ({ rang, dureeMs })),
  };
}

self.addEventListener("message", async (event) => {
  const { id, options } = event.data ?? {};
  let relacher = () => {};
  try {
    // La clé du harnais vaut pour la durée de la mesure, et pour elle seule (ADR 0016).
    relacher = poserCleDuBanc(options?.jetonCle);
    const rapport =
      options?.mode === "fraicheur" ? await mesurerFraicheur(options) : await mesurer(options);
    self.postMessage({ id, ok: true, rapport });
  } catch (cause) {
    try {
      await nettoyer();
    } catch {
      // L'hygiène de secours ne doit jamais masquer la raison du refus.
    }
    self.postMessage({
      id,
      ok: false,
      error: { code: cause?.code ?? null, message: cause?.message ?? String(cause) },
    });
  } finally {
    relacher();
  }
});
