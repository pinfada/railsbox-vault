// Disposition du fichier de volume au format v3 (#18, ADR 0016).
//
// Ce module ne chiffre rien et ne touche à aucun support : il dit OÙ les octets vivent. Il est la
// seule pièce qui connaisse l'écart entre l'adresse LOGIQUE d'un secteur — celle que v86 présente —
// et sa position sur le support. Tout le reste du dépôt continue de raisonner en adresses logiques,
// et c'est ce qui permet à `block-geometry.mjs`, au contrat de tampon de v86 et à l'oracle de #15 de
// n'avoir pas bougé d'une ligne.
//
//     [ en-tête v3, 1 secteur ][ région d'authentification, R secteurs ][ charge chiffrée, N secteurs ]
//
// La région porte, pour chaque secteur logique, un SCEAU de 34 octets : nonce 12, étiquette 16,
// génération 6. C'est la même forme que le sceau d'un enregistrement de journal
// (`generation-format.mjs`) — une seule fonction d'encodage pour les deux endroits, parce que deux
// encodages du même objet finissent toujours par diverger.
//
// **Rien ici n'est authentifié.** L'en-tête LOCALISE et la région TRANSPORTE ; l'autorité est
// ailleurs, dans l'étiquette que `crypto.subtle` vérifie sous les données associées du secteur.
// L'ADR 0016 en tire la conséquence et l'écrit : une altération de l'en-tête produit un REFUS de
// lecture, jamais un clair erroné, parce que l'identifiant de volume et la version de format entrent
// dans les données associées de chaque secteur.

import { SECTOR_SIZE, assertBlockGeometry } from "./block-geometry.mjs";
import {
  ETIQUETTE_OCTETS,
  IDENTIFIANT_VOLUME_OCTETS,
  NONCE_OCTETS,
  identifiantVolumeEnTexte,
} from "./format-chiffre/identite-logique.mjs";

export { IDENTIFIANT_VOLUME_OCTETS, identifiantVolumeEnTexte };

/** Version du FORMAT DE VOLUME que cette disposition sert. Distincte de la version du modèle. */
export const FORMAT_VOLUME_V3 = 3;

/** Largeur du champ de génération dans un sceau. Six octets, comme les données associées l'exigent. */
export const GENERATION_OCTETS = 6;

/** Un sceau : nonce, étiquette, génération. La même forme dans la région et dans le journal. */
export const SCEAU_OCTETS = NONCE_OCTETS + ETIQUETTE_OCTETS + GENERATION_OCTETS;

/** L'en-tête v3 occupe un secteur entier : c'est la plus petite unité que le support adresse. */
export const EN_TETE_OCTETS = SECTOR_SIZE;

/** Marqueur de l'en-tête v3. Huit octets, jamais modifiés. */
export const MARQUEUR_V3 = Uint8Array.from([0x56, 0x4c, 0x54, 0x56, 0x4f, 0x4c, 0x30, 0x33]); // "VLTVOL03"

/**
 * Où loge la marque de SCELLEMENT COMPLET, dans la réserve de l'en-tête.
 *
 * L'en-tête est posé et flushé AVANT que le volume ne soit scellé — il faut bien connaître la
 * disposition pour savoir où écrire les sceaux. Entre les deux s'ouvre une fenêtre qui dure le
 * temps de sceller tout le volume (87,6 s pour 512 Mio), et une coupure qui y tombe laisse un
 * fichier qui a l'exacte apparence d'un volume. La marque referme cette fenêtre : elle n'est posée
 * qu'après le dernier secteur, et son absence dit « cette création n'a pas abouti ».
 */
export const SCELLEMENT_COMPLET_OFFSET = 64;

/**
 * Marque de scellement complet. HUIT octets d'un motif fixe, et non un bit.
 *
 * Un bit, ou un octet non nul, serait posé par accident : une page jamais écrite que le support
 * rend en `0xff`, un octet retourné, un reliquat d'un autre format suffiraient à faire passer un
 * volume inachevé pour un volume complet — et le seul état qu'on veut interdire est précisément
 * celui-là. Huit octets d'un motif choisi ne se rencontrent pas par hasard.
 *
 * Elle n'est PAS authentifiée, comme le reste de l'en-tête : c'est un localisateur, pas une preuve.
 * Ce qu'elle protège est une erreur d'exploitation — une création interrompue —, pas un adversaire,
 * et le paragraphe correspondant de l'ADR 0016 le dit sans le maquiller.
 */
export const MARQUEUR_SCELLEMENT_COMPLET = Uint8Array.from([
  0x56, 0x4c, 0x54, 0x53, 0x45, 0x41, 0x4c, 0x31,
]); // "VLTSEAL1"

/** Plus grande génération représentable dans un sceau (2^48 − 1). */
export const GENERATION_MAX = 2 ** (GENERATION_OCTETS * 8) - 1;

function alignerHaut(valeur) {
  return Math.ceil(valeur / SECTOR_SIZE) * SECTOR_SIZE;
}

/**
 * Calcule la disposition d'un volume v3 à partir de sa taille LOGIQUE.
 *
 * La région est alignée VERS LE HAUT sur un secteur : la tronquer priverait les derniers secteurs de
 * leur sceau, c'est-à-dire les rendrait illisibles. Pour le volume applicatif de 512 Mio elle tombe
 * juste — 1 048 576 × 34 = 35 651 584 octets, soit 69 632 secteurs exactement.
 *
 * @param {number} tailleLogique multiple de `SECTOR_SIZE`, strictement positif
 * @returns {{ tailleLogique: number, secteurs: number, enTeteOctets: number, regionOffset: number,
 *             regionOctets: number, chargeOffset: number, tailleSupport: number }}
 */
export function dispositionV3(tailleLogique) {
  assertBlockGeometry(tailleLogique);
  const secteurs = tailleLogique / SECTOR_SIZE;
  const regionOctets = alignerHaut(secteurs * SCEAU_OCTETS);
  const chargeOffset = EN_TETE_OCTETS + regionOctets;
  return Object.freeze({
    tailleLogique,
    secteurs,
    enTeteOctets: EN_TETE_OCTETS,
    regionOffset: EN_TETE_OCTETS,
    regionOctets,
    chargeOffset,
    tailleSupport: chargeOffset + tailleLogique,
  });
}

/** Taille du FICHIER qu'un volume logique occupe en v3. Publiee pour l'ouverture et le quota. */
export function tailleSupportV3(tailleLogique) {
  return dispositionV3(tailleLogique).tailleSupport;
}

/**
 * Taille du FICHIER d'un volume, selon son format.
 *
 * Elle existe parce que l'ARCHIVE porte un fichier, pas un volume logique (ADR 0016, décision 7) :
 * jusqu'à v2 les deux coïncidaient et personne n'avait à les distinguer ; en v3 le fichier porte en
 * plus l'en-tête et la région d'authentification. La fonction est DÉRIVÉE du format et de la
 * géométrie, jamais reçue d'un appelant : deux sources de vérité divergeraient, et c'est l'archive
 * qui deviendrait invérifiable.
 *
 * @param {{ formatVersion: number, tailleLogique: number }} volume
 */
export function tailleDeFichier({ formatVersion, tailleLogique }) {
  return formatVersion < FORMAT_VOLUME_V3 ? tailleLogique : tailleSupportV3(tailleLogique);
}

function exigerAdresse(disposition, adresse) {
  if (
    !Number.isInteger(adresse) ||
    adresse < 0 ||
    adresse % SECTOR_SIZE !== 0 ||
    adresse >= disposition.tailleLogique
  ) {
    throw new RangeError(
      `Adresse logique invalide : ${adresse}. Un multiple de ${SECTOR_SIZE} strictement inférieur à ${disposition.tailleLogique} est exigé.`,
    );
  }
  return adresse;
}

/** Position, sur le support, du secteur CHIFFRÉ d'adresse logique `adresse`. */
export function offsetDeCharge(disposition, adresse) {
  return disposition.chargeOffset + exigerAdresse(disposition, adresse);
}

/** Position, sur le support, du SCEAU du secteur d'adresse logique `adresse`. */
export function offsetDeSceau(disposition, adresse) {
  return (
    disposition.regionOffset + (exigerAdresse(disposition, adresse) / SECTOR_SIZE) * SCEAU_OCTETS
  );
}

/** Tire un identifiant de volume : seize octets, rendus en trente-deux hexadécimaux minuscules. */
export function nouvelIdentifiantDeVolume() {
  return identifiantVolumeEnTexte(
    crypto.getRandomValues(new Uint8Array(IDENTIFIANT_VOLUME_OCTETS)),
  );
}

/** Relit un identifiant textuel en ses seize octets. Toute forme approchante est un refus. */
export function identifiantVolumeEnOctets(texte) {
  if (typeof texte !== "string" || !/^[0-9a-f]{32}$/.test(texte)) {
    throw new RangeError(
      `Identifiant de volume invalide : ${JSON.stringify(texte)}. Trente-deux hexadécimaux minuscules sont exigés.`,
    );
  }
  const octets = new Uint8Array(IDENTIFIANT_VOLUME_OCTETS);
  for (let index = 0; index < octets.length; index += 1) {
    octets[index] = Number.parseInt(texte.slice(index * 2, index * 2 + 2), 16);
  }
  return octets;
}

function ecrireEntier(vue, position, valeur, octets) {
  if (!Number.isSafeInteger(valeur) || valeur < 0 || valeur > 2 ** (octets * 8) - 1) {
    throw new RangeError(`${valeur} ne tient pas sur ${octets} octet(s).`);
  }
  let reste = valeur;
  for (let index = 0; index < octets; index += 1) {
    vue.setUint8(position + index, reste % 256);
    reste = Math.floor(reste / 256);
  }
}

function lireEntier(vue, position, octets) {
  let valeur = 0;
  for (let index = octets - 1; index >= 0; index -= 1) {
    valeur = valeur * 256 + vue.getUint8(position + index);
  }
  return valeur;
}

/**
 * Encode un sceau : nonce, étiquette, génération. Exactement `SCEAU_OCTETS` octets.
 *
 * @param {{ nonce: Uint8Array, etiquette: Uint8Array, generation: number }} sceau
 */
export function encoderSceau({ nonce, etiquette, generation }) {
  if (!(nonce instanceof Uint8Array) || nonce.byteLength !== NONCE_OCTETS) {
    throw new RangeError(`Un nonce fait ${NONCE_OCTETS} octets.`);
  }
  if (!(etiquette instanceof Uint8Array) || etiquette.byteLength !== ETIQUETTE_OCTETS) {
    throw new RangeError(`Une étiquette fait ${ETIQUETTE_OCTETS} octets.`);
  }
  const octets = new Uint8Array(SCEAU_OCTETS);
  octets.set(nonce, 0);
  octets.set(etiquette, NONCE_OCTETS);
  ecrireEntier(
    new DataView(octets.buffer),
    NONCE_OCTETS + ETIQUETTE_OCTETS,
    generation,
    GENERATION_OCTETS,
  );
  return octets;
}

/**
 * Relit un sceau. Il n'y a RIEN à refuser ici, et c'est délibéré : un sceau entièrement à zéro se
 * décode comme n'importe quel autre, et c'est l'ÉTIQUETTE qui le refusera. Le distinguer rendrait un
 * secteur zéroté « vierge » plutôt que « refusé » — exactement l'attaque que l'ADR 0015 nomme quand
 * il écrit qu'un secteur jamais écrit ne peut pas exister en v3.
 */
export function decoderSceau(octets) {
  if (!(octets instanceof Uint8Array) || octets.byteLength < SCEAU_OCTETS) {
    throw new RangeError(`Un sceau fait ${SCEAU_OCTETS} octets, reçu ${octets?.byteLength}.`);
  }
  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  return Object.freeze({
    nonce: octets.slice(0, NONCE_OCTETS),
    etiquette: octets.slice(NONCE_OCTETS, NONCE_OCTETS + ETIQUETTE_OCTETS),
    generation: lireEntier(vue, NONCE_OCTETS + ETIQUETTE_OCTETS, GENERATION_OCTETS),
  });
}

/**
 * Encode l'en-tête v3 dans un secteur complet. La réserve reste à ZÉRO : elle est réservée, pas
 * remplie de reliquats.
 *
 * `scellementComplet` vaut FAUX par défaut, et ce défaut est le bon : l'en-tête est écrit avant que
 * le volume ne soit scellé, donc au moment où il est écrit la création n'a pas abouti. Poser la
 * marque ici, « puisqu'on va sceller juste après », rendrait le contrôle décoratif.
 *
 * @param {{ tailleLogique: number, identifiantVolume: Uint8Array | string,
 *           scellementComplet?: boolean }} entete
 */
export function encoderEnTeteV3({ tailleLogique, identifiantVolume, scellementComplet = false }) {
  const disposition = dispositionV3(tailleLogique);
  const identifiant =
    typeof identifiantVolume === "string"
      ? identifiantVolumeEnOctets(identifiantVolume)
      : identifiantVolume;
  if (
    !(identifiant instanceof Uint8Array) ||
    identifiant.byteLength !== IDENTIFIANT_VOLUME_OCTETS
  ) {
    throw new RangeError(`Un identifiant de volume fait ${IDENTIFIANT_VOLUME_OCTETS} octets.`);
  }

  const octets = new Uint8Array(EN_TETE_OCTETS);
  const vue = new DataView(octets.buffer);
  octets.set(MARQUEUR_V3, 0);
  vue.setUint32(8, FORMAT_VOLUME_V3, true);
  vue.setUint32(12, SECTOR_SIZE, true);
  ecrireEntier(vue, 16, disposition.tailleLogique, 8);
  ecrireEntier(vue, 24, disposition.regionOffset, 8);
  ecrireEntier(vue, 32, disposition.regionOctets, 8);
  ecrireEntier(vue, 40, disposition.chargeOffset, 8);
  octets.set(identifiant, 48);
  if (scellementComplet) octets.set(MARQUEUR_SCELLEMENT_COMPLET, SCELLEMENT_COMPLET_OFFSET);
  return octets;
}

function marqueurPresent(octets) {
  return MARQUEUR_V3.every((attendu, position) => octets[position] === attendu);
}

/** Vrai si la marque de scellement complet est présente, à l'octet près. */
export function scellementCompletMarque(octets) {
  return MARQUEUR_SCELLEMENT_COMPLET.every(
    (attendu, position) => octets[SCELLEMENT_COMPLET_OFFSET + position] === attendu,
  );
}

/**
 * Relit l'en-tête v3. Tout doute est un refus : un en-tête « probablement bon » n'existe pas, et un
 * en-tête qui mentirait sur l'endroit où la charge commence ferait lire des sceaux comme des données.
 *
 * @param {Uint8Array} octets le premier secteur du fichier
 * @returns {{ valide: boolean, raison: string | null, enTete: object | null }}
 */
export function decoderEnTeteV3(octets) {
  const refus = (raison) => ({ valide: false, raison, enTete: null });
  if (!(octets instanceof Uint8Array) || octets.byteLength < EN_TETE_OCTETS) {
    return refus("Secteur d'en-tête trop court.");
  }
  if (!marqueurPresent(octets)) return refus("Marqueur d'en-tête v3 absent.");

  const vue = new DataView(octets.buffer, octets.byteOffset, octets.byteLength);
  const formatVersion = vue.getUint32(8, true);
  if (formatVersion !== FORMAT_VOLUME_V3) {
    return refus(`Format de volume inconnu dans l'en-tête : ${formatVersion}.`);
  }
  if (vue.getUint32(12, true) !== SECTOR_SIZE) {
    return refus("En-tête écrit avec une autre taille de secteur.");
  }

  const tailleLogique = lireEntier(vue, 16, 8);
  let disposition;
  try {
    disposition = dispositionV3(tailleLogique);
  } catch (cause) {
    return refus(`Taille logique inadmissible dans l'en-tête : ${cause.message}`);
  }
  const declares = [lireEntier(vue, 24, 8), lireEntier(vue, 32, 8), lireEntier(vue, 40, 8)];
  const attendus = [disposition.regionOffset, disposition.regionOctets, disposition.chargeOffset];
  if (declares.some((valeur, index) => valeur !== attendus[index])) {
    return refus(
      `Disposition incohérente : l'en-tête place la charge et la région à ${declares.join(", ")} là où la taille logique impose ${attendus.join(", ")}.`,
    );
  }

  return {
    valide: true,
    raison: null,
    enTete: Object.freeze({
      formatVersion,
      tailleSecteur: SECTOR_SIZE,
      tailleLogique,
      regionOffset: disposition.regionOffset,
      regionOctets: disposition.regionOctets,
      chargeOffset: disposition.chargeOffset,
      identifiantVolume: octets.slice(48, 48 + IDENTIFIANT_VOLUME_OCTETS),
      // Un en-tête VALIDE dont la marque manque décrit un volume dont la création n'a pas abouti.
      // Le décodeur ne tranche pas : il rapporte, et c'est l'ouvreur qui refuse.
      scellementComplet: scellementCompletMarque(octets),
    }),
  };
}
