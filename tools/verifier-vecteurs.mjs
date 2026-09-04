#!/usr/bin/env node
// VÉRIFICATEUR INDÉPENDANT des vecteurs du format de volume v3 (#20, moitié 1).
//
//     node tools/verifier-vecteurs.mjs
//
// Une commande, aucune dépendance, aucun navigateur : Node et `node:crypto` suffisent.
//
// ## Ce qu'il est, et pourquoi il ne ressemble à rien d'autre dans ce dépôt
//
// Ce fichier RÉIMPLÉMENTE, à partir de `docs/format-de-volume-v3.md` et de rien d'autre, les
// encodages que le format emploie : les données associées d'un bloc et d'une racine, l'encodage
// canonique de la suite des entrées, le sceau de 34 octets, l'en-tête v3, la racine sur disque, le
// témoin. Il les confronte ensuite aux octets FIGÉS de `tests/vectors/`.
//
// **Il n'importe RIEN de `src/`, et c'est toute sa valeur.** Un vérificateur qui appellerait le
// modèle de référence emprunterait précisément les encodages qu'il prétend contrôler : il
// prouverait que le code est d'accord avec lui-même, ce que personne n'a jamais mis en doute. En
// réécrivant les encodages depuis la spécification écrite, il mesure autre chose — que la
// SPÉCIFICATION suffit à reproduire les octets. C'est ce dont un relecteur externe a besoin, et
// c'est ce que `tests/unit/dossier-de-revue.test.mjs` garde par inspection de source.
//
// Ce qu'il ne fait PAS, et qu'il ne faut pas lui prêter : il ne juge pas la solidité du format, il
// ne cherche aucune faiblesse, il ne remplace aucune revue. Il établit un fait étroit — les octets
// publiés sont ceux que la spécification décrit — et rien de plus.
//
// ## Ce qu'un verdict ROUGE veut dire
//
// Soit les vecteurs ont bougé (un format persistant a changé sans version ni ADR), soit la
// spécification et le code ont divergé. Les deux sont des défauts, et aucun des deux ne se corrige
// en régénérant les vecteurs.

import { webcrypto } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const RACINE = fileURLToPath(new URL("../", import.meta.url));

/** Les étiquettes de domaine, telles que la spécification les fixe. Aucune n'est devinable. */
const DOMAINE_BLOC = "railsbox-vault/format-chiffre/v1/bloc";
const DOMAINE_RACINE = "railsbox-vault/format-chiffre/v1/racine";
const DOMAINE_ENTREES = "railsbox-vault/format-chiffre/v1/entrees";
const ALGORITHME = "aes-256-gcm";

const NONCE_OCTETS = 12;
const ETIQUETTE_OCTETS = 16;
const GENERATION_OCTETS = 6;
const SCEAU_OCTETS = NONCE_OCTETS + ETIQUETTE_OCTETS + GENERATION_OCTETS;
const EMPREINTE_OCTETS = 32;
const SECTEUR = 512;

/** Rangs réservés de la fraîcheur (ADR 0019) : les deux plus grands rangs représentables, 2^40 − 1. */
const RANG_MAX = 2 ** 40 - 1;
const RANG_EMPREINTE_REGION = RANG_MAX;
const RANG_TEMOIN = RANG_MAX - 1;
const RANG_SECTEUR_DE_VOLUME = 0;

// ---------------------------------------------------------------------------------------------
// Octets : les mêmes conventions que la spécification, réécrites ici plutôt qu'importées.
// ---------------------------------------------------------------------------------------------

function hexEnOctets(hex) {
  if (typeof hex !== "string" || hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) {
    throw new TypeError(`Hexadécimal minuscule de longueur paire attendu : ${hex}`);
  }
  const octets = new Uint8Array(hex.length / 2);
  for (let index = 0; index < octets.length; index += 1) {
    octets[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return octets;
}

function octetsEnHex(octets) {
  let rendu = "";
  for (const octet of octets) rendu += octet.toString(16).padStart(2, "0");
  return rendu;
}

function concat(...morceaux) {
  const total = morceaux.reduce((somme, morceau) => somme + morceau.byteLength, 0);
  const rendu = new Uint8Array(total);
  let curseur = 0;
  for (const morceau of morceaux) {
    rendu.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  return rendu;
}

/** Entier non signé, GROS-BOUTISTE : la convention des DONNÉES ASSOCIÉES. */
function be(valeur, octets) {
  const rendu = new Uint8Array(octets);
  let reste = valeur;
  for (let index = octets - 1; index >= 0; index -= 1) {
    rendu[index] = reste % 256;
    reste = Math.floor(reste / 256);
  }
  if (reste !== 0) throw new RangeError(`${valeur} ne tient pas sur ${octets} octets.`);
  return rendu;
}

/** Entier non signé, PETIT-BOUTISTE : la convention des EN-TÊTES SUR DISQUE. Les deux coexistent. */
function le(valeur, octets) {
  const rendu = new Uint8Array(octets);
  let reste = valeur;
  for (let index = 0; index < octets; index += 1) {
    rendu[index] = reste % 256;
    reste = Math.floor(reste / 256);
  }
  if (reste !== 0) throw new RangeError(`${valeur} ne tient pas sur ${octets} octets.`);
  return rendu;
}

function lireLe(octets, position, longueur) {
  let valeur = 0;
  for (let index = longueur - 1; index >= 0; index -= 1) {
    valeur = valeur * 256 + octets[position + index];
  }
  return valeur;
}

/** Chaîne UTF-8 précédée de sa longueur sur DEUX octets gros-boutistes. */
function chainePrefixee(valeur) {
  const utf8 = new TextEncoder().encode(valeur);
  return concat(be(utf8.byteLength, 2), utf8);
}

function texteAscii(valeur) {
  return new TextEncoder().encode(valeur);
}

// ---------------------------------------------------------------------------------------------
// Les encodages du format, réécrits depuis la spécification.
// ---------------------------------------------------------------------------------------------

/** Données associées d'un bloc : l'identité logique complète, chaque champ fixe ou préfixé. */
function donneesAssocieesDeBloc({ volume, formatVersion, generation, rang, adresse, longueur }) {
  return concat(
    chainePrefixee(DOMAINE_BLOC),
    chainePrefixee(ALGORITHME),
    be(formatVersion, 4),
    chainePrefixee(volume),
    be(generation, 8),
    be(rang, 8),
    be(adresse, 8),
    be(longueur, 4),
  );
}

/** Données associées d'une racine : son en-tête, dans l'ordre que la spécification fixe. */
function donneesAssocieesDeRacine({
  volume,
  formatVersion,
  sequence,
  generation,
  tailleVolume,
  nombreEntrees,
  longueurCharge,
  scellementsCumules,
}) {
  return concat(
    chainePrefixee(DOMAINE_RACINE),
    chainePrefixee(ALGORITHME),
    be(formatVersion, 4),
    chainePrefixee(volume),
    be(sequence, 8),
    be(generation, 8),
    be(tailleVolume, 8),
    be(nombreEntrees, 4),
    be(longueurCharge, 8),
    be(scellementsCumules, 8),
  );
}

/** Encodage canonique de la SUITE des entrées d'une génération. L'ordre y est significatif. */
function encoderEntrees(entrees) {
  const morceaux = [chainePrefixee(DOMAINE_ENTREES), be(entrees.length, 4)];
  for (const entree of entrees) {
    morceaux.push(
      be(entree.adresse, 8),
      be(entree.longueur, 4),
      be(entree.rang, 8),
      hexEnOctets(entree.etiquette),
    );
  }
  return concat(...morceaux);
}

/** Le sceau de 34 octets : nonce, étiquette, génération PETIT-BOUTISTE sur six octets. */
function encoderSceau({ nonce, etiquette, generation }) {
  return concat(nonce, etiquette, le(generation, GENERATION_OCTETS));
}

/** Le contenu déterministe que les vecteurs publient : `octet i = (i × 7 + 13 + graine) mod 256`. */
function contenuAttendu(longueur, graine) {
  return Uint8Array.from({ length: longueur }, (_, index) => (index * 7 + 13 + graine) % 256);
}

// ---------------------------------------------------------------------------------------------
// Le banc : chaque contrôle est nommé, et son échec dit ce qui a bougé.
// ---------------------------------------------------------------------------------------------

let vertes = 0;
const rouges = [];

function verifier(nom, condition, detail = "") {
  if (condition) {
    vertes += 1;
    return true;
  }
  rouges.push(detail ? `${nom} — ${detail}` : nom);
  return false;
}

function memesOctets(nom, obtenus, attendus) {
  const gauche = octetsEnHex(obtenus);
  const droite = typeof attendus === "string" ? attendus : octetsEnHex(attendus);
  return verifier(nom, gauche === droite, gauche === droite ? "" : ecart(gauche, droite));
}

/**
 * Dit OÙ deux suites d'octets divergent, et non seulement qu'elles divergent.
 *
 * Un aperçu tronqué à soixante-quatre caractères montrerait deux fois les mêmes octets de tête
 * quand la différence est au milieu — c'est-à-dire qu'il n'apprendrait rien. L'offset du premier
 * écart, lui, désigne le champ.
 */
function ecart(obtenu, attendu) {
  if (obtenu.length !== attendu.length) {
    return `longueurs différentes : attendu ${attendu.length / 2} octets, obtenu ${obtenu.length / 2}`;
  }
  for (let index = 0; index < attendu.length; index += 2) {
    if (obtenu[index] !== attendu[index] || obtenu[index + 1] !== attendu[index + 1]) {
      return `premier écart à l'octet ${index / 2} : attendu 0x${attendu.slice(index, index + 2)}, obtenu 0x${obtenu.slice(index, index + 2)}`;
    }
  }
  return "aucun écart trouvé, et pourtant les chaînes diffèrent";
}

function toutAZero(octets) {
  return octets.every((octet) => octet === 0);
}

function lire(relatif) {
  return JSON.parse(
    readFileSync(new URL(relatif, `file://${RACINE.replaceAll("\\", "/")}`), "utf8"),
  );
}

async function importerCle(hex) {
  return webcrypto.subtle.importKey("raw", hexEnOctets(hex), { name: "AES-GCM" }, false, [
    "encrypt",
    "decrypt",
  ]);
}

/** Scelle et rend `{ chiffre, etiquette }` séparés, comme le format les range. */
async function sceller(cle, nonce, donneesAssociees, clair) {
  const brut = new Uint8Array(
    await webcrypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce, additionalData: donneesAssociees, tagLength: 128 },
      cle,
      clair,
    ),
  );
  return {
    chiffre: brut.slice(0, brut.byteLength - ETIQUETTE_OCTETS),
    etiquette: brut.slice(brut.byteLength - ETIQUETTE_OCTETS),
  };
}

/** Ouvre, ou rend `null` si l'étiquette ne vérifie pas. Un refus n'est pas une panne. */
async function ouvrir(cle, nonce, donneesAssociees, chiffre, etiquette) {
  try {
    return new Uint8Array(
      await webcrypto.subtle.decrypt(
        { name: "AES-GCM", iv: nonce, additionalData: donneesAssociees, tagLength: 128 },
        cle,
        concat(chiffre, etiquette),
      ),
    );
  } catch {
    return null;
  }
}

async function empreinte(octets) {
  return new Uint8Array(await webcrypto.subtle.digest("SHA-256", octets));
}

// ---------------------------------------------------------------------------------------------
// 1. Les vecteurs du MODÈLE (ADR 0015) : blocs et racines, en mémoire.
// ---------------------------------------------------------------------------------------------

async function verifierModele() {
  const vecteurs = lire("tests/vectors/format-chiffre-v1.json");
  const cle = await importerCle(vecteurs.cle.hex);

  verifier(
    "modèle : l'algorithme annoncé est le seul que la spécification admette",
    vecteurs.specification.algorithme === ALGORITHME,
    `annoncé ${vecteurs.specification.algorithme}`,
  );
  verifier(
    "modèle : le nonce fait douze octets et l'étiquette seize",
    vecteurs.specification.nonceOctets === NONCE_OCTETS &&
      vecteurs.specification.etiquetteOctets === ETIQUETTE_OCTETS,
  );

  const nonces = new Set();
  for (const bloc of vecteurs.blocs) {
    const clair = hexEnOctets(bloc.contenu.hex);
    memesOctets(
      `bloc « ${bloc.nom} » : le clair suit la règle publiée`,
      contenuAttendu(bloc.contenu.longueur, bloc.contenu.graine),
      bloc.contenu.hex,
    );
    const aad = donneesAssocieesDeBloc(bloc.identite);
    const nonce = hexEnOctets(bloc.attendu.nonce);
    const scelle = await sceller(cle, nonce, aad, clair);
    memesOctets(`bloc « ${bloc.nom} » : le chiffré`, scelle.chiffre, bloc.attendu.chiffre);
    memesOctets(`bloc « ${bloc.nom} » : l'étiquette`, scelle.etiquette, bloc.attendu.etiquette);
    const rendu = await ouvrir(
      cle,
      nonce,
      aad,
      hexEnOctets(bloc.attendu.chiffre),
      hexEnOctets(bloc.attendu.etiquette),
    );
    verifier(
      `bloc « ${bloc.nom} » : il se rouvre sous SON identité et rend le clair`,
      rendu !== null && octetsEnHex(rendu) === bloc.contenu.hex,
    );
    // Le déplacement doit être refusé : une adresse voisine, et rien d'autre, suffit.
    const ailleurs = await ouvrir(
      cle,
      nonce,
      donneesAssocieesDeBloc({ ...bloc.identite, adresse: bloc.identite.adresse + SECTEUR }),
      hexEnOctets(bloc.attendu.chiffre),
      hexEnOctets(bloc.attendu.etiquette),
    );
    verifier(`bloc « ${bloc.nom} » : relu à une AUTRE adresse, il est refusé`, ailleurs === null);
    verifier(
      `bloc « ${bloc.nom} » : son nonce n'apparaît qu'une fois dans le document`,
      !nonces.has(bloc.attendu.nonce),
    );
    nonces.add(bloc.attendu.nonce);
  }

  for (const racine of vecteurs.racines) {
    const entrees = racine.entrees;
    const nombreEntrees = entrees.length;
    const longueurCharge = entrees.reduce((somme, entree) => somme + entree.longueur, 0);
    verifier(
      `racine « ${racine.nom} » : le compte et la longueur sont DÉRIVÉS des entrées`,
      nombreEntrees === racine.attendu.nombreEntrees &&
        longueurCharge === racine.attendu.longueurCharge,
      `dérivé ${nombreEntrees}/${longueurCharge}, publié ${racine.attendu.nombreEntrees}/${racine.attendu.longueurCharge}`,
    );
    const empreinteEntrees = await empreinte(encoderEntrees(entrees));
    memesOctets(
      `racine « ${racine.nom} » : l'empreinte de la suite ordonnée des entrées`,
      empreinteEntrees,
      racine.attendu.empreinteEntrees,
    );
    const aad = donneesAssocieesDeRacine({
      ...racine.racine,
      nombreEntrees,
      longueurCharge,
    });
    const nonce = hexEnOctets(racine.attendu.nonce);
    const scelle = await sceller(cle, nonce, aad, empreinteEntrees);
    memesOctets(`racine « ${racine.nom} » : le chiffré`, scelle.chiffre, racine.attendu.chiffre);
    memesOctets(
      `racine « ${racine.nom} » : l'étiquette`,
      scelle.etiquette,
      racine.attendu.etiquette,
    );
    // Une entrée retirée doit changer l'empreinte : c'est la troncature, et elle se voit.
    if (nombreEntrees > 1) {
      const tronquee = await empreinte(encoderEntrees(entrees.slice(0, -1)));
      verifier(
        `racine « ${racine.nom} » : retirer une entrée CHANGE l'empreinte`,
        octetsEnHex(tronquee) !== racine.attendu.empreinteEntrees,
      );
    }
  }
}

// ---------------------------------------------------------------------------------------------
// 2. Les vecteurs de DISPOSITION (ADR 0016 et 0019) : ce que le disque porte.
// ---------------------------------------------------------------------------------------------

async function verifierDisposition() {
  const vecteurs = lire("tests/vectors/disposition-v3.json");
  const cle = await importerCle(vecteurs.cle.hex);
  const volume = vecteurs.volume.identifiant;
  const formatVersion = vecteurs.specification.formatVolume;
  const disposition = vecteurs.volume.disposition;

  verifier(
    "disposition : l'identifiant de volume est trente-deux hexadécimaux minuscules",
    /^[0-9a-f]{32}$/.test(volume),
  );
  verifier(
    "disposition : un sceau fait 34 octets",
    vecteurs.specification.sceauOctets === SCEAU_OCTETS,
  );

  // La disposition se DÉDUIT de la taille logique : rien n'est cru sur parole.
  const secteurs = vecteurs.volume.tailleLogique / SECTEUR;
  const regionOctets = Math.ceil((secteurs * SCEAU_OCTETS) / SECTEUR) * SECTEUR;
  verifier(
    "disposition : la région est alignée VERS LE HAUT sur un secteur",
    disposition.secteurs === secteurs &&
      disposition.regionOffset === SECTEUR &&
      disposition.regionOctets === regionOctets &&
      disposition.chargeOffset === SECTEUR + regionOctets &&
      disposition.tailleSupport === SECTEUR + regionOctets + vecteurs.volume.tailleLogique,
    JSON.stringify(disposition),
  );

  // --- L'en-tête v3 ---------------------------------------------------------------------------
  const enTete = new Uint8Array(SECTEUR);
  enTete.set(texteAscii("VLTVOL03"), 0);
  enTete.set(le(formatVersion, 4), 8);
  enTete.set(le(SECTEUR, 4), 12);
  enTete.set(le(vecteurs.volume.tailleLogique, 8), 16);
  enTete.set(le(disposition.regionOffset, 8), 24);
  enTete.set(le(disposition.regionOctets, 8), 32);
  enTete.set(le(disposition.chargeOffset, 8), 40);
  enTete.set(hexEnOctets(volume), 48);
  enTete.set(texteAscii("VLTSEAL1"), vecteurs.specification.scellementCompletOffset);
  memesOctets(
    "en-tête v3 : les 512 octets, marque de scellement complet comprise",
    enTete,
    vecteurs.enTete.hex,
  );
  verifier(
    "en-tête v3 : la réserve après la marque est à ZÉRO",
    toutAZero(hexEnOctets(vecteurs.enTete.hex).subarray(72)),
  );

  // --- Les enregistrements du journal ---------------------------------------------------------
  for (const enregistrement of vecteurs.enregistrements) {
    const nom = enregistrement.nom;
    const identite = enregistrement.identite;
    verifier(
      `enregistrement « ${nom} » : son identité porte le volume et la version du vecteur`,
      identite.volume === volume && identite.formatVersion === formatVersion,
    );
    memesOctets(
      `enregistrement « ${nom} » : le clair suit la règle publiée`,
      contenuAttendu(enregistrement.clair.longueur, enregistrement.clair.graine),
      enregistrement.clair.hex,
    );
    const entete = concat(le(identite.adresse, 8), le(identite.longueur, 4), le(0, 4));
    memesOctets(
      `enregistrement « ${nom} » : l'en-tête de 16 octets — offset, longueur, réserve`,
      entete,
      enregistrement.attendu.enteteHex,
    );
    const aad = donneesAssocieesDeBloc(identite);
    const nonce = hexEnOctets(enregistrement.attendu.nonce);
    const scelle = await sceller(cle, nonce, aad, hexEnOctets(enregistrement.clair.hex));
    memesOctets(
      `enregistrement « ${nom} » : le chiffré`,
      scelle.chiffre,
      enregistrement.attendu.chiffre,
    );
    memesOctets(
      `enregistrement « ${nom} » : l'étiquette`,
      scelle.etiquette,
      enregistrement.attendu.etiquette,
    );
    const sceau = encoderSceau({
      nonce,
      etiquette: scelle.etiquette,
      generation: identite.generation,
    });
    memesOctets(
      `enregistrement « ${nom} » : le sceau de 34 octets porte SA génération`,
      sceau,
      enregistrement.attendu.sceauHex,
    );
    memesOctets(
      `enregistrement « ${nom} » : les octets complets — en-tête, sceau, chiffré`,
      concat(entete, sceau, scelle.chiffre),
      enregistrement.attendu.octetsHex,
    );
  }

  // --- La région d'authentification -----------------------------------------------------------
  const region = new Uint8Array(disposition.regionOctets);
  for (const secteur of vecteurs.region.secteurs) {
    const nom = `secteur ${secteur.adresse}`;
    verifier(
      `région, ${nom} : le rang d'un secteur de volume est ÉPINGLÉ à zéro`,
      secteur.identite.rang === RANG_SECTEUR_DE_VOLUME,
    );
    memesOctets(
      `région, ${nom} : le clair suit la règle publiée`,
      contenuAttendu(secteur.clair.longueur, secteur.clair.graine),
      secteur.clair.hex,
    );
    const nonce = hexEnOctets(secteur.attendu.nonce);
    const scelle = await sceller(
      cle,
      nonce,
      donneesAssocieesDeBloc(secteur.identite),
      hexEnOctets(secteur.clair.hex),
    );
    memesOctets(`région, ${nom} : le chiffré`, scelle.chiffre, secteur.attendu.chiffre);
    const sceau = encoderSceau({
      nonce,
      etiquette: scelle.etiquette,
      generation: secteur.identite.generation,
    });
    memesOctets(`région, ${nom} : son sceau`, sceau, secteur.attendu.sceauHex);
    region.set(sceau, (secteur.adresse / SECTEUR) * SCEAU_OCTETS);
  }
  memesOctets(
    "région : les sceaux rangés par adresse croissante, le reste à zéro",
    region,
    vecteurs.region.hex,
  );
  verifier(
    "région : le REMBOURRAGE au-delà des sceaux utiles est à zéro",
    toutAZero(region.subarray(vecteurs.region.utiles)),
  );
  const empreinteRegion = await empreinte(region);
  memesOctets(
    "région : son empreinte SHA-256 porte sur la région ENTIÈRE, rembourrage compris",
    empreinteRegion,
    vecteurs.region.empreinte,
  );

  // --- La fraîcheur scellée dans la racine ----------------------------------------------------
  const fraicheur = hexEnOctets(vecteurs.racine.attendu.fraicheurHex);
  verifier(
    "fraîcheur : 66 octets — un sceau de 34, puis l'empreinte chiffrée de 32",
    fraicheur.byteLength === SCEAU_OCTETS + EMPREINTE_OCTETS,
  );
  const generationFraicheur = lireLe(fraicheur, NONCE_OCTETS + ETIQUETTE_OCTETS, GENERATION_OCTETS);
  verifier(
    "fraîcheur : elle est RESCELLÉE sous la génération de sa racine",
    generationFraicheur === vecteurs.racine.entete.generation,
    `sceau ${generationFraicheur}, racine ${vecteurs.racine.entete.generation}`,
  );
  const empreinteOuverte = await ouvrir(
    cle,
    fraicheur.subarray(0, NONCE_OCTETS),
    donneesAssocieesDeBloc({
      volume,
      formatVersion,
      generation: generationFraicheur,
      rang: RANG_EMPREINTE_REGION,
      adresse: 0,
      longueur: EMPREINTE_OCTETS,
    }),
    fraicheur.subarray(SCEAU_OCTETS),
    fraicheur.subarray(NONCE_OCTETS, NONCE_OCTETS + ETIQUETTE_OCTETS),
  );
  verifier(
    "fraîcheur : ouverte sous le rang réservé de la région, elle rend l'empreinte de la région",
    empreinteOuverte !== null && octetsEnHex(empreinteOuverte) === vecteurs.region.empreinte,
  );

  // --- La racine sur disque -------------------------------------------------------------------
  const entete = vecteurs.racine.entete;
  const entrees = vecteurs.racine.entrees;
  const empreinteEntrees = await empreinte(encoderEntrees(entrees));
  memesOctets(
    "racine : l'empreinte de la suite ordonnée de ses entrées",
    empreinteEntrees,
    vecteurs.racine.attendu.empreinteEntrees,
  );
  const scelleRacine = await sceller(
    cle,
    hexEnOctets(vecteurs.racine.attendu.nonce),
    donneesAssocieesDeRacine(entete),
    empreinteEntrees,
  );
  memesOctets("racine : le chiffré", scelleRacine.chiffre, vecteurs.racine.attendu.chiffre);
  memesOctets("racine : l'étiquette", scelleRacine.etiquette, vecteurs.racine.attendu.etiquette);

  const secteurRacine = new Uint8Array(SECTEUR);
  secteurRacine.set(texteAscii("VLTGEN01"), 0);
  secteurRacine.set(le(vecteurs.specification.formatJournal, 4), 8);
  secteurRacine.set(le(SECTEUR, 4), 12);
  secteurRacine.set(le(entete.sequence, 8), 16);
  secteurRacine.set(le(entete.generation, 8), 24);
  secteurRacine.set(le(entete.tailleVolume, 8), 32);
  secteurRacine.set(le(entete.nombreEntrees, 4), 40);
  secteurRacine.set(le(entete.longueurCharge, 8), 44);
  secteurRacine.set(hexEnOctets(volume), 52);
  secteurRacine.set(le(entete.scellementsCumules, 8), 68);
  secteurRacine.set(hexEnOctets(vecteurs.racine.attendu.nonce), 76);
  secteurRacine.set(hexEnOctets(vecteurs.racine.attendu.chiffre), 88);
  secteurRacine.set(hexEnOctets(vecteurs.racine.attendu.etiquette), 120);
  secteurRacine.set(fraicheur, vecteurs.specification.racineEnteteV2Octets);
  memesOctets(
    "racine : les 512 octets du secteur, aux offsets que la spécification fixe",
    secteurRacine,
    vecteurs.racine.attendu.hex,
  );
  verifier(
    "racine : la réserve au-delà de 202 octets est à zéro",
    toutAZero(
      hexEnOctets(vecteurs.racine.attendu.hex).subarray(vecteurs.specification.racineEnteteOctets),
    ),
  );

  // La longueur PHYSIQUE de la charge se DÉDUIT ; elle n'est stockée nulle part.
  const physique =
    entete.longueurCharge + entete.nombreEntrees * vecteurs.specification.surcoutEnregistrement;
  const mesuree = vecteurs.enregistrements.reduce(
    (somme, enregistrement) => somme + enregistrement.attendu.octetsHex.length / 2,
    0,
  );
  verifier(
    "racine : la longueur PHYSIQUE de la charge se déduit de ce que la racine authentifie",
    physique === mesuree,
    `déduite ${physique}, mesurée sur les enregistrements ${mesuree}`,
  );

  // --- Le témoin -------------------------------------------------------------------------------
  const temoin = hexEnOctets(vecteurs.temoin.hex);
  verifier(
    "témoin : 60 octets — en-tête 16, nonce 12, étiquette 16, chiffré 16",
    temoin.byteLength === vecteurs.specification.temoinOctets && temoin.byteLength === 60,
  );
  memesOctets("témoin : son marqueur", temoin.subarray(0, 8), octetsEnHex(texteAscii("VLTTEM01")));
  verifier(
    "témoin : sa version de format est celle que la spécification publie",
    lireLe(temoin, 8, 4) === vecteurs.specification.temoinFormat,
  );
  const clairTemoin = await ouvrir(
    cle,
    temoin.subarray(16, 16 + NONCE_OCTETS),
    donneesAssocieesDeBloc({
      volume,
      formatVersion,
      generation: 0,
      rang: RANG_TEMOIN,
      adresse: 0,
      longueur: 16,
    }),
    temoin.subarray(44, 60),
    temoin.subarray(28, 44),
  );
  if (
    verifier(
      "témoin : ouvert sous le rang réservé du témoin, il rend seize octets de clair",
      clairTemoin !== null && clairTemoin.byteLength === 16,
    )
  ) {
    verifier(
      "témoin : il porte la séquence, la génération et l'état de la fraîcheur",
      lireLe(clairTemoin, 0, 8) === vecteurs.temoin.sequence &&
        lireLe(clairTemoin, 8, 6) === vecteurs.temoin.generation &&
        (clairTemoin[14] === 1) === vecteurs.temoin.fraicheurActive,
      `séquence ${lireLe(clairTemoin, 0, 8)}, génération ${lireLe(clairTemoin, 8, 6)}, fraîcheur ${clairTemoin[14]}`,
    );
    verifier(
      "témoin : l'identité du témoin n'est PAS celle d'un secteur — un témoin ne se lit pas comme un bloc",
      RANG_TEMOIN !== RANG_SECTEUR_DE_VOLUME,
    );
  }
}

// ---------------------------------------------------------------------------------------------

async function main() {
  await verifierModele();
  await verifierDisposition();

  const total = vertes + rouges.length;
  if (rouges.length === 0) {
    process.stdout.write(
      `VERT — ${vertes} vérifications vertes sur ${total}, sans importer une ligne du produit.\n` +
        `Les octets figés de tests/vectors/ sont ceux que docs/format-de-volume-v3.md décrit.\n`,
    );
    return;
  }
  process.stdout.write(`ROUGE — ${rouges.length} vérification(s) en échec sur ${total} :\n`);
  for (const rouge of rouges) process.stdout.write(`  - ${rouge}\n`);
  process.stdout.write(
    `${vertes} vérifications vertes par ailleurs. Un vecteur qui bouge est un format persistant qui change : il exige une version et un ADR, jamais une régénération.\n`,
  );
  process.exitCode = 1;
}

await main();
