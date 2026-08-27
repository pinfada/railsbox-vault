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
import {
  generationJournalName,
  openOpfsSyncAccess,
  removeOpfsVolume,
} from "/src/vm/opfs-sync-access.mjs";

/** Volume jetable du banc. Il est retiré avant et après chaque répétition. */
const VOLUME = "recuperation-banc";

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

function magasinSur({ volume, journal }, tailleVolume, plafondOctets) {
  return GenerationStore.ouvrir({
    volume: VOLUME,
    handle: journal,
    tailleVolume,
    // Le plafond est EXPLICITE : un profil témoin doit pouvoir dépasser celui de production pour
    // mesurer ce qu'il coûtait, sans quoi le chiffre qui a fait bouger le plafond deviendrait
    // irreproductible dès que le plafond bouge.
    plafondOctets,
    lireVolume(offset, longueur) {
      const cible = new Uint8Array(longueur);
      volume.read(cible, { at: offset });
      return cible;
    },
    ecrireVolume: (offset, octets) => volume.write(octets, { at: offset }),
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

self.addEventListener("message", async (event) => {
  const { id, options } = event.data ?? {};
  try {
    self.postMessage({ id, ok: true, rapport: await mesurer(options) });
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
  }
});
