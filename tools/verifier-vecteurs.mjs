#!/usr/bin/env node
// VÉRIFICATEUR INDÉPENDANT des vecteurs du format de volume v3 (#20, moitié 1).
//
//     node tools/verifier-vecteurs.mjs
//
// Une commande, aucune dépendance, aucun navigateur : Node et `node:crypto` suffisent.
//
// ## Ce qu'il est, et pourquoi il ne ressemble à rien d'autre dans ce dépôt
//
// Ce fichier RÉIMPLÉMENTE, à partir de `docs/format-de-volume-v3.md`, de
// `docs/decisions/0025-moyen-de-recuperation.md` et de rien d'autre, les
// encodages que le format emploie : les données associées d'un bloc du volume, celles d'un
// ENREGISTREMENT du journal — distinctes depuis le constat #143 —, celles d'une racine, l'encodage
// canonique de la suite des entrées, le sceau de 34 octets, l'en-tête v3, la racine sur disque, le
// témoin — et, depuis #147, le CODE DE RÉCUPÉRATION : sa forme base 32, sa somme de contrôle et ses
// deux propriétés, sa relecture, son matériau et sa KEK. Il les confronte ensuite aux octets FIGÉS
// de `tests/vectors/`.
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
/** Celle d'un ENREGISTREMENT du journal, distincte de celle d'un bloc du volume depuis #143. */
const DOMAINE_ENREGISTREMENT = "railsbox-vault/format-chiffre/v1/enregistrement";
const DOMAINE_RACINE = "railsbox-vault/format-chiffre/v1/racine";
const DOMAINE_ENTREES = "railsbox-vault/format-chiffre/v1/entrees";
const ALGORITHME = "aes-256-gcm";

const NONCE_OCTETS = 12;
const ETIQUETTE_OCTETS = 16;
const GENERATION_OCTETS = 6;
const SCEAU_OCTETS = NONCE_OCTETS + ETIQUETTE_OCTETS + GENERATION_OCTETS;
const EMPREINTE_OCTETS = 32;
const SECTEUR = 512;

/**
 * Format du journal de génération que la spécification décrit (§ 6.7). Épinglé ICI plutôt que lu
 * dans les vecteurs : un vérificateur qui croirait le document qu'il vérifie ne vérifierait rien.
 */
const FORMAT_JOURNAL = 4;

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

/**
 * Données associées d'un objet ADRESSÉ, sous l'étiquette de domaine de SON magasin : l'identité
 * logique complète, chaque champ fixe ou préfixé.
 *
 * L'étiquette est le premier champ, et c'est elle qui sépare les magasins depuis le constat #143 :
 * un secteur du volume et le premier enregistrement d'une charge partagent les six champs suivants
 * dans le cas nominal, et ne rendent pourtant pas la même chaîne.
 */
function donneesAssocieesAdressees(
  domaine,
  { volume, formatVersion, generation, rang, adresse, longueur },
) {
  return concat(
    chainePrefixee(domaine),
    chainePrefixee(ALGORITHME),
    be(formatVersion, 4),
    chainePrefixee(volume),
    be(generation, 8),
    be(rang, 8),
    be(adresse, 8),
    be(longueur, 4),
  );
}

/** Données associées d'un BLOC DU VOLUME : secteur de la charge, empreinte de région, témoin. */
function donneesAssocieesDeBloc(identite) {
  return donneesAssocieesAdressees(DOMAINE_BLOC, identite);
}

/** Données associées d'un ENREGISTREMENT du journal de génération (#143). */
function donneesAssocieesDEnregistrement(identite) {
  return donneesAssocieesAdressees(DOMAINE_ENREGISTREMENT, identite);
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
  verifier(
    `disposition : le journal est annoncé au format ${FORMAT_JOURNAL}`,
    vecteurs.specification.formatJournal === FORMAT_JOURNAL,
    `annoncé ${vecteurs.specification.formatJournal}`,
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
    // L'étiquette de domaine d'un ENREGISTREMENT, et non celle d'un bloc du volume : c'est ce que
    // le constat #143 a imposé, et c'est ce que ce contrôle rend opposable.
    const aad = donneesAssocieesDEnregistrement(identite);
    verifier(
      `enregistrement « ${nom} » : ses données associées ne sont PAS celles du secteur homologue`,
      octetsEnHex(aad) !== octetsEnHex(donneesAssocieesDeBloc(identite)),
      "les deux magasins partagent encore leur étiquette de domaine.",
    );
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
    // LA REPRODUCTION DU CONSTAT #143, retournée en contrôle vert. Ces octets-là sont exactement
    // ceux qu'un adversaire épisserait dans la région et la charge du volume : les présenter sous
    // l'identité d'un SECTEUR doit ne rien rendre. Le contrôle ne coûte qu'un déchiffrement, et il
    // dit la propriété que la seule inégalité des chaînes ne dit pas — que le refus est celui du
    // moteur, pas celui d'une comparaison de ce script.
    verifier(
      `enregistrement « ${nom} » : présenté comme un SECTEUR du volume, il ne s'ouvre pas`,
      (await ouvrir(
        cle,
        nonce,
        donneesAssocieesDeBloc(identite),
        hexEnOctets(enregistrement.attendu.chiffre),
        hexEnOctets(enregistrement.attendu.etiquette),
      )) === null,
      "un enregistrement du journal s'ouvre encore dans l'espace d'identités du volume.",
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
// 3. Le MOYEN DE RÉCUPÉRATION (ADR 0025) : le code, sa somme de contrôle, son matériau, sa KEK.
// ---------------------------------------------------------------------------------------------
//
// Cette section est réécrite depuis le SEUL texte de `docs/decisions/0025-moyen-de-recuperation.md`,
// comme les deux précédentes le sont depuis `docs/format-de-volume-v3.md`. Elle n'importe rien du
// produit, et c'est toute sa valeur : elle mesure que la SPÉCIFICATION suffit à reproduire les
// octets, pas que le code est d'accord avec lui-même.
//
// Les constantes ci-dessous sont ÉPINGLÉES ici plutôt que lues dans les vecteurs. Un vérificateur
// qui croirait le document qu'il vérifie ne vérifierait rien : l'alphabet, le module de la somme de
// contrôle, les largeurs et l'étiquette de domaine viennent de l'ADR, pas du JSON.

/** L'alphabet base 32 de Crockford, tel que l'ADR 0025 le fixe : sans I, L, O ni U. */
const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** Le module PREMIER de la somme de contrôle : le plus grand sous 32². */
const MODULE_RECUPERATION = 1021;

/** Vingt-six symboles de données, deux de contrôle, seize octets tirés. */
const SYMBOLES_DONNEES_RECUPERATION = 26;
const SYMBOLES_TOTAL_RECUPERATION = 28;
const CODE_OCTETS_RECUPERATION = 16;

/** L'étiquette de domaine des paramètres publics du type 4, et la largeur de son sel. */
const DOMAINE_RECUPERATION = "railsbox-vault/derivation/v1/recuperation";
const SEL_RECUPERATION_OCTETS = 32;

/** L'étiquette de domaine de l'info HKDF, celle de l'ADR 0021 — le type 4 ne la change pas. */
const DOMAINE_DERIVATION = "railsbox-vault/derivation/v1/kek";

/** Les symboles de seize octets : cinq bits à la fois, deux bits de bourrage nuls pour finir. */
function symbolesDeRecuperation(octets) {
  let bits = "";
  for (const octet of octets) bits += octet.toString(2).padStart(8, "0");
  bits += "00";
  const symboles = [];
  for (let debut = 0; debut < bits.length; debut += 5) {
    symboles.push(Number.parseInt(bits.slice(debut, debut + 5), 2));
  }
  return symboles;
}

/** Les seize octets de vingt-six symboles, ou `null` si le bourrage n'est pas nul. */
function octetsDeRecuperation(symboles) {
  let bits = "";
  for (const symbole of symboles) bits += symbole.toString(2).padStart(5, "0");
  if (bits.slice(-2) !== "00") return null;
  const octets = new Uint8Array(CODE_OCTETS_RECUPERATION);
  for (let index = 0; index < octets.length; index += 1) {
    octets[index] = Number.parseInt(bits.slice(index * 8, index * 8 + 8), 2);
  }
  return octets;
}

/** Le résidu modulo 1021 d'une suite de symboles lue en base 32. */
function residuDeRecuperation(symboles) {
  let reste = 0;
  for (const symbole of symboles) reste = (reste * 32 + symbole) % MODULE_RECUPERATION;
  return reste;
}

/** Les deux symboles de contrôle : système pur de l'ISO 7064, M = 1021, r = 32. */
function controleDeRecuperation(donnees) {
  const decale = (residuDeRecuperation(donnees) * 1024) % MODULE_RECUPERATION;
  const controle = (MODULE_RECUPERATION + 1 - decale) % MODULE_RECUPERATION;
  return [Math.floor(controle / 32), controle % 32];
}

/** La chaîne rendue : vingt-huit symboles en sept groupes de quatre. */
function chaineDeRecuperation(symboles) {
  const lettres = symboles.map((symbole) => CROCKFORD[symbole]).join("");
  return (lettres.match(/.{4}/g) ?? []).join("-");
}

/** Points de code que la saisie retire, tels que l'ADR 0025 les énumère. */
const SEPARATEURS_RECUPERATION = new Set([
  0x2d, 0x2013, 0x2014, 0x20, 0xa0, 0x202f, 0x09, 0x0a, 0x0d,
]);

/** Les replis de Crockford : les signes écartés sont ramenés sur celui qu'ils imitent. */
const REPLIS_RECUPERATION = new Map([
  ["O", "0"],
  ["I", "1"],
  ["L", "1"],
]);

/**
 * RELIT une saisie : NFC, majuscule, retrait des séparateurs, repli, somme de contrôle, bourrage.
 *
 * Rend les seize octets, ou `null` pour tout refus. La distinction entre les motifs de refus n'est
 * pas l'affaire de ce vérificateur : ce qu'il mesure est qu'une forme est acceptée ou ne l'est pas.
 */
function relireSaisieDeRecuperation(texte) {
  const symboles = [];
  for (const signe of texte.normalize("NFC")) {
    if (SEPARATEURS_RECUPERATION.has(signe.codePointAt(0))) continue;
    const majuscule = signe.toUpperCase();
    const replie = REPLIS_RECUPERATION.get(majuscule) ?? majuscule;
    const valeur = replie.length === 1 ? CROCKFORD.indexOf(replie) : -1;
    if (valeur === -1) return null;
    symboles.push(valeur);
  }
  if (symboles.length !== SYMBOLES_TOTAL_RECUPERATION) return null;
  if (residuDeRecuperation(symboles) !== 1) return null;
  return octetsDeRecuperation(symboles.slice(0, SYMBOLES_DONNEES_RECUPERATION));
}

/** HKDF-SHA-256 tel que la RFC 5869 le définit, par `node:crypto`. */
async function hkdf(materiau, sel, infoOctets) {
  const base = await webcrypto.subtle.importKey("raw", materiau, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await webcrypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: sel, info: infoOctets },
      base,
      256,
    ),
  );
}

async function verifierRecuperation() {
  const vecteurs = lire("tests/vectors/derivation-v1.json");
  const moyen = vecteurs.recuperation;
  verifier(
    "récupération : l'alphabet publié est celui de Crockford, sans I, L, O ni U",
    moyen.alphabet === CROCKFORD,
    `publié ${moyen.alphabet}`,
  );
  verifier(
    "récupération : le module de la somme de contrôle est le premier que l'ADR fixe",
    moyen.moduleDeControle === MODULE_RECUPERATION,
    `publié ${moyen.moduleDeControle}`,
  );

  await verifierLesCodes(moyen);
  verifierLesProprietesDeControle(moyen);
  verifierLesSaisies(moyen);
  await verifierLaDerivationDeRecuperation(moyen);
  verifierLesParametresDeRecuperation(vecteurs);
}

/** Chaque code figé : symboles, bourrage, somme de contrôle, chaîne rendue, matériau. */
async function verifierLesCodes(moyen) {
  for (const cas of moyen.codes) {
    const octets = hexEnOctets(cas.octetsHex);
    verifier(
      `récupération : « ${cas.nom} » porte exactement ${CODE_OCTETS_RECUPERATION} octets`,
      octets.byteLength === CODE_OCTETS_RECUPERATION,
      `${octets.byteLength} octets`,
    );
    const donnees = symbolesDeRecuperation(octets);
    verifier(
      `récupération : « ${cas.nom} » — les vingt-six symboles sont ceux de la spécification`,
      JSON.stringify(donnees) === JSON.stringify(cas.symboles),
      `${JSON.stringify(donnees)} attendu ${JSON.stringify(cas.symboles)}`,
    );
    verifier(
      `récupération : « ${cas.nom} » — les deux bits de bourrage sont NULS`,
      donnees[SYMBOLES_DONNEES_RECUPERATION - 1] % 4 === 0,
    );
    const controle = controleDeRecuperation(donnees);
    verifier(
      `récupération : « ${cas.nom} » — la somme de contrôle est celle de la spécification`,
      JSON.stringify(controle) === JSON.stringify(cas.sommeDeControle),
      `${JSON.stringify(controle)} attendu ${JSON.stringify(cas.sommeDeControle)}`,
    );
    verifier(
      `récupération : « ${cas.nom} » — la chaîne rendue fait sept groupes de quatre`,
      chaineDeRecuperation([...donnees, ...controle]) === cas.codeRendu,
      `obtenu ${chaineDeRecuperation([...donnees, ...controle])}, figé ${cas.codeRendu}`,
    );
    verifier(
      `récupération : « ${cas.nom} » — la chaîne se relit en ses seize octets`,
      octetsEnHex(relireSaisieDeRecuperation(cas.codeRendu) ?? new Uint8Array(0)) === cas.octetsHex,
    );
    memesOctets(
      `récupération : « ${cas.nom} » — le matériau HKDF est le SHA-256 des seize octets`,
      await empreinte(octets),
      cas.materiauHex,
    );
  }
}

/**
 * Les DEUX propriétés que l'ADR 0025 promet de la somme de contrôle, refaites ici EXHAUSTIVEMENT.
 *
 * C'est le contrôle qui vaut le plus dans cette section : il ne compare pas des octets figés, il
 * refait la démonstration. Un relecteur qui doute de la construction n'a pas à la croire.
 */
function verifierLesProprietesDeControle(moyen) {
  let substitutions = 0;
  let transpositions = 0;
  let ratees = 0;
  for (const cas of moyen.codes) {
    const donnees = symbolesDeRecuperation(hexEnOctets(cas.octetsHex));
    const symboles = [...donnees, ...controleDeRecuperation(donnees)];
    for (let rang = 0; rang < SYMBOLES_TOTAL_RECUPERATION; rang += 1) {
      for (let valeur = 0; valeur < 32; valeur += 1) {
        if (valeur === symboles[rang]) continue;
        const mute = [...symboles];
        mute[rang] = valeur;
        if (residuDeRecuperation(mute) === 1) ratees += 1;
        substitutions += 1;
      }
    }
    for (let rang = 0; rang < SYMBOLES_TOTAL_RECUPERATION - 1; rang += 1) {
      if (symboles[rang] === symboles[rang + 1]) continue;
      const mute = [...symboles];
      [mute[rang], mute[rang + 1]] = [mute[rang + 1], mute[rang]];
      if (residuDeRecuperation(mute) === 1) ratees += 1;
      transpositions += 1;
    }
  }
  verifier(
    "récupération : TOUTE substitution d'un symbole est détectée, exhaustivement",
    ratees === 0 && substitutions === moyen.codes.length * SYMBOLES_TOTAL_RECUPERATION * 31,
    `${ratees} non détectée(s) sur ${substitutions} substitutions`,
  );
  verifier(
    "récupération : TOUTE transposition de deux symboles adjacents est détectée",
    ratees === 0 && transpositions >= 25,
    `${transpositions} transpositions mesurées`,
  );
}

/** Les formes de saisie : les acceptées rendent les mêmes octets, les refusées sont refusées. */
function verifierLesSaisies(moyen) {
  const saisies = moyen.saisies;
  verifier(
    "récupération : la forme de normalisation FIGÉE est NFC, jamais une forme de compatibilité",
    saisies.forme === "NFC",
    `figée ${saisies.forme}`,
  );
  for (const forme of saisies.acceptees) {
    const texte = String.fromCodePoint(...forme.pointsSaisis);
    const octets = relireSaisieDeRecuperation(texte);
    verifier(
      `récupération : la saisie « ${forme.nom} » rend les mêmes seize octets`,
      octets !== null && octetsEnHex(octets) === saisies.octetsHex,
      octets === null ? "refusée" : octetsEnHex(octets),
    );
  }
  for (const forme of saisies.refusees) {
    const texte = String.fromCodePoint(...forme.pointsSaisis);
    verifier(
      `récupération : la saisie « ${forme.nom} » est REFUSÉE`,
      relireSaisieDeRecuperation(texte) === null,
    );
  }
  // Le témoin de la garde : si `relireSaisieDeRecuperation` refusait tout, les contrôles ci-dessus
  // seraient à moitié vides. Les acceptées viennent de le démentir ; celui-ci le dit à voix haute.
  verifier(
    "récupération : la relecture de la saisie ACCEPTE au moins trois formes distinctes",
    saisies.acceptees.length >= 3,
    `${saisies.acceptees.length} formes acceptées`,
  );
}

/** L'info HKDF et l'OKM : le type 4 emploie l'encodage de l'ADR 0021, sans le changer. */
async function verifierLaDerivationDeRecuperation(moyen) {
  const cas = moyen.derivation;
  const info = concat(
    chainePrefixee(DOMAINE_DERIVATION),
    chainePrefixee(cas.identifiantVolume),
    chainePrefixee(cas.identifiantEmplacement),
    be(cas.version, 4),
  );
  memesOctets("récupération : l'info HKDF est celle de l'ADR 0021, inchangée", info, cas.infoHex);
  const materiau = hexEnOctets(cas.materiauHex);
  verifier(
    "récupération : le matériau remis à HKDF fait trente-deux octets",
    materiau.byteLength === 32,
    `${materiau.byteLength} octets`,
  );
  memesOctets(
    "récupération : l'OKM est HKDF-SHA-256(SHA-256(code), sel de l'emplacement, info)",
    await hkdf(materiau, hexEnOctets(cas.sel), info),
    cas.okmHex,
  );
}

/** Les paramètres publics du type 4 : étiquette, version, sel de trente-deux octets. */
function verifierLesParametresDeRecuperation(vecteurs) {
  const cas = vecteurs.parametres.find((entree) => entree.type === "recuperation");
  if (
    !verifier(
      "récupération : les vecteurs portent les paramètres publics du type 4",
      cas !== undefined,
    )
  ) {
    return;
  }
  const sel = hexEnOctets(cas.valeurs.sel);
  verifier(
    "récupération : le sel HKDF de l'emplacement fait trente-deux octets",
    sel.byteLength === SEL_RECUPERATION_OCTETS,
    `${sel.byteLength} octets`,
  );
  memesOctets(
    "récupération : les paramètres publics sont étiquette ‖ version ‖ longueur ‖ sel",
    concat(
      chainePrefixee(DOMAINE_RECUPERATION),
      be(cas.valeurs.version, 1),
      be(sel.byteLength, 2),
      sel,
    ),
    cas.octetsHex,
  );
}

// ---------------------------------------------------------------------------------------------

async function main() {
  await verifierModele();
  await verifierDisposition();
  await verifierRecuperation();

  const total = vertes + rouges.length;
  if (rouges.length === 0) {
    process.stdout.write(
      `VERT — ${vertes} vérifications vertes sur ${total}, sans importer une ligne du produit.\n` +
        `Les octets figés de tests/vectors/ sont ceux que docs/format-de-volume-v3.md et\n` +
        `docs/decisions/0025-moyen-de-recuperation.md décrivent.\n`,
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
