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
// **Depuis #196, le banc ouvre EN V4, avec une fraîcheur RÉELLE (ADR 0019, ADR 0033, ADR 0035).**
// #186 a fait passer `FORMAT_VOLUME_COURANT` à 4, et `formatEcritSousFraicheur` REFUSE désormais
// d'écrire une racine sans fraîcheur pour ce format — c'est la garde de `generation-format.mjs` :
// « un volume v4 qui ne tiendrait aucune fraîcheur est REFUSÉ ». Le banc déclarait `fraicheur: null`
// pour une raison qui n'existe plus : mesurer sans elle reproduisait le constat #143 pour les octets
// qu'il écrivait, et le chemin du produit (`opfs-volume-ouverture.mjs`) ne l'a jamais fait. Il ouvre
// donc désormais sa propre région d'authentification et son propre témoin, sur les MÊMES fonctions
// (`GardeDeFraicheur`, `construireGarde`) que l'ouvreur du produit — voir `sourceDeFraicheurDuBanc`.
// Le SEUL écart avec `opfs-generation-voisins.mjs` est que ce banc tient ses handles lui-même, faute
// d'`OpfsBlockBackend` : il ne chiffre pas la charge qu'il rejoue, ce qui n'a jamais été son sujet.
//
// Ce que ce changement AJOUTE à la durée mesurée : le hachage de la région d'authentification de CE
// volume-ci (`empreinteDeRegion`, proportionnelle à sa taille — 34 octets par secteur logique), et
// l'écriture du témoin après chaque racine. C'est un coût RÉEL du chemin de production qu'aucune
// mesure précédente ne portait ; `docs/quality-attributes.md` republie le relevé en v4 en face de
// celui d'avant #186 pour que la comparaison reste possible.
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
import { autorisationDeCreation } from "/src/vm/generation-recuperation.mjs";
import { Scellement } from "/src/vm/scellement.mjs";
import { cleDuBanc, poserCleDuBanc } from "./cle-du-banc.mjs";
import {
  generationJournalName,
  openOpfsSyncAccess,
  removeOpfsVolume,
  temoinSequenceName,
} from "/src/vm/opfs-sync-access.mjs";
import {
  TEMOIN_OCTETS,
  TRANCHE_REGION_OCTETS,
  empreinteDeRegion,
} from "/src/vm/generation-fraicheur.mjs";
import { FORMAT_VOLUME_COURANT, dispositionDuVolume } from "/src/vm/volume-chiffre-format.mjs";

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

/**
 * Ouvre les TROIS fichiers du banc : le volume (en-tête + région + charge, disposition de
 * `dispositionDuVolume`), son journal voisin, et son témoin de séquence (#19).
 *
 * Le fichier de volume est alloué à sa taille SUPPORT — celle du produit, en-tête et région
 * d'authentification compris — et non à la taille logique de la charge : c'est ce qui donne au banc
 * une vraie région à sceller, à l'échelle de CE volume-ci plutôt qu'à celle du disque applicatif
 * (que `mesurerFraicheur` mesure séparément, à l'échelle de production).
 */
async function ouvrirFichiers(tailleVolume) {
  const disposition = dispositionDuVolume(tailleVolume);
  const volume = await openOpfsSyncAccess(VOLUME);
  if (volume.getSize() !== disposition.tailleSupport) volume.truncate(disposition.tailleSupport);
  const journal = await openOpfsSyncAccess(generationJournalName(VOLUME));
  const temoin = await openOpfsSyncAccess(temoinSequenceName(VOLUME));
  return { volume, journal, temoin, disposition };
}

/**
 * SOURCE de fraîcheur du banc (#19, ADR 0019, ADR 0033), sur le même contrat que
 * `sourceDeFraicheur` d'`opfs-generation-voisins.mjs` — la région d'authentification et le témoin.
 * Le seul écart est que ce banc tient ses propres handles au lieu de ceux d'un `OpfsBlockBackend` :
 * il n'a pas de couche chiffrée à traverser pour lire la région, qui vit dans le MÊME fichier que la
 * charge qu'il rejoue.
 */
function sourceDeFraicheurDuBanc({ volume, temoin, disposition }) {
  return {
    regionOffset: disposition.regionOffset,
    regionOctets: disposition.regionOctets,
    lireRegion: async (offset, longueur) => {
      const cible = new Uint8Array(longueur);
      volume.read(cible, { at: offset });
      return cible;
    },
    // Un témoin ABSENT est une PREMIÈRE OUVERTURE, jamais une preuve de rien — voir
    // `generation-fraicheur.mjs`. Un fichier tout juste créé par `openOpfsSyncAccess` est vide.
    lireTemoin: async () => {
      if (temoin.getSize() === 0) return null;
      const octets = new Uint8Array(TEMOIN_OCTETS);
      const lus = temoin.read(octets, { at: 0 });
      return lus === TEMOIN_OCTETS ? octets : octets.subarray(0, lus);
    },
    ecrireTemoin: async (octets) => {
      temoin.truncate(0);
      temoin.write(octets, { at: 0 });
      temoin.flush();
    },
    fermer: () => temoin.close(),
  };
}

async function magasinSur({ volume, journal, temoin, disposition }, tailleVolume, plafondOctets) {
  return GenerationStore.ouvrir({
    sansRacine: autorisationDeCreation(),
    // La fraîcheur RÉELLE du produit (#196) : voir l'en-tête du fichier. `GenerationStore.close()`
    // rend le handle du témoin par `garde.fermer()`, comme il rend celui du journal.
    fraicheur: sourceDeFraicheurDuBanc({ volume, temoin, disposition }),
    volume: VOLUME,
    handle: journal,
    tailleVolume,
    // Le scellement du produit, sous la clé de TEST du harnais. Ce banc mesure la DURÉE d'une
    // récupération : depuis #18 elle comprend l'ouverture de chaque enregistrement, et la mesurer
    // sans elle ne dirait plus rien du produit.
    scellement: await Scellement.ouvrir({
      volume: IDENTIFIANT,
      cleOctets: cleDuBanc(),
      formatVersion: FORMAT_VOLUME_COURANT,
    }),
    // Le plafond est EXPLICITE : un profil témoin doit pouvoir dépasser celui de production pour
    // mesurer ce qu'il coûtait, sans quoi le chiffre qui a fait bouger le plafond deviendrait
    // irreproductible dès que le plafond bouge.
    plafondOctets,
    // La charge vit APRÈS l'en-tête et la région, comme sur le vrai support : deux tailles, et il
    // ne faut jamais les confondre (`opfs-volume-ouverture.mjs`). `offset` reste l'adresse LOGIQUE
    // que le magasin manipule ; ce décalage est le seul endroit qui la traduit en position support.
    async lireVolume(offset, longueur) {
      const cible = new Uint8Array(longueur);
      volume.read(cible, { at: offset + disposition.chargeOffset });
      return cible;
    },
    ecrireVolume: async (offset, octets) =>
      volume.write(octets, { at: offset + disposition.chargeOffset }),
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
  const disposition = dispositionDuVolume(tailleLogique);
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
