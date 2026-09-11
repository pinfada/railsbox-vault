#!/usr/bin/env node
// VÉRIFICATEUR INDÉPENDANT des vecteurs du format de volume (#20, moitié 1 ; #182 pour la v4).
//
//     node tools/verifier-vecteurs.mjs
//
// Une commande, aucune dépendance, aucun navigateur : Node et `node:crypto` suffisent.
//
// ## Ce qu'il est, et pourquoi il ne ressemble à rien d'autre dans ce dépôt
//
// Ce fichier RÉIMPLÉMENTE, à partir de `docs/format-de-volume-v3.md`, de
// `docs/decisions/0025-moyen-de-recuperation.md`, de
// `docs/decisions/0027-archive-et-ancre-de-version.md` et de rien d'autre, les
// encodages que le format emploie : les données associées d'un bloc du volume, celles d'un
// ENREGISTREMENT du journal — distinctes depuis le constat #143 —, celles d'une racine, l'encodage
// canonique de la suite des entrées, le sceau de 34 octets, l'en-tête v3, la racine sur disque, le
// témoin — et, depuis #147, le CODE DE RÉCUPÉRATION : sa forme base 32, sa somme de contrôle et ses
// deux propriétés, sa relecture, son matériau et sa KEK —, et, depuis #149, la DISPOSITION D'UNE
// ARCHIVE V2 : son préambule, son en-tête, l'arithmétique de ses sections, ses deux empreintes, et
// la propriété qui donne son sens à la tranche — la page embarquée ne porte que des emplacements de
// type 4. **Depuis #182, il redérive en outre la HIÉRARCHIE DE CLÉS du format v4** : l'ancrage de la
// primitive sur le cas 3 de la RFC 5869, l'info de chaque domaine champ par champ, les trente-deux
// octets que HKDF en tire, et l'ouverture — sous SA propre clé — de ce que le produit a scellé. Il
// les confronte ensuite aux octets FIGÉS de `tests/vectors/`.
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

/**
 * La version de format de volume que #182 introduit, et celle du journal qui l'accompagne.
 *
 * Ils sont ÉPINGLÉS ici, comme `FORMAT_JOURNAL` : un vérificateur qui lirait ces nombres dans le
 * document qu'il vérifie ne vérifierait rien.
 */
const FORMAT_VOLUME_V4 = 4;
const FORMAT_JOURNAL_DEUX_COMPTEURS = 5;

/** Largeur de l'en-tête d'une racine qui publie DEUX compteurs : 202 + 8. */
const RACINE_ENTETE_V5_OCTETS = 210;

/** Marqueur de l'en-tête d'un volume v4, en ASCII. Le premier discriminant est celui qu'on lit. */
const MARQUEUR_V4 = "VLTVOL04";

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
  scellementsCumulesVolume,
  scellementsCumulesJournal,
}) {
  // **DIX champs jusqu'à la v3, ONZE à partir de la v4** (ADR 0033, décision 5). Le nombre suit la
  // VERSION DE FORMAT, qui est elle-même le champ 3 : une racine v3 relue comme une racine v4 ne
  // vérifie donc pas, et réciproquement. Le nom du premier compteur change aussi — il devient celui
  // du domaine `volume` —, et ce vérificateur accepte les deux écritures parce que les vecteurs v3
  // sont FIGÉS et nomment encore l'ancien.
  const duVolume = scellementsCumulesVolume ?? scellementsCumules;
  const morceaux = [
    chainePrefixee(DOMAINE_RACINE),
    chainePrefixee(ALGORITHME),
    be(formatVersion, 4),
    chainePrefixee(volume),
    be(sequence, 8),
    be(generation, 8),
    be(tailleVolume, 8),
    be(nombreEntrees, 4),
    be(longueurCharge, 8),
    be(duVolume, 8),
  ];
  if (formatVersion >= FORMAT_VOLUME_V4) morceaux.push(be(scellementsCumulesJournal, 8));
  return concat(...morceaux);
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

/**
 * La TABLE CLOSE des signes acceptés, construite depuis le § « La saisie » de l'ADR 0025 : les
 * trente-deux symboles, leur minuscule ASCII, et les six formes des trois replis.
 *
 * Elle est écrite en boucle sur des BORNES ASCII plutôt qu'en appelant `toLowerCase` ou
 * `toUpperCase`, et ce n'est pas un détail de style. La revue de crypto de #155 a relevé que la
 * première rédaction de cette section transcrivait la boucle du produit ligne pour ligne : elle
 * rendait donc vert sur un défaut que le produit avait — `ſ` et `ı` acceptés par la mise en
 * majuscule d'Unicode — au lieu de le voir. Une réimplémentation qui recopie ne vérifie rien.
 */
const SIGNES_RECUPERATION = (() => {
  const table = new Map();
  const minuscule = (point) => (point >= 0x41 && point <= 0x5a ? point + 0x20 : point);
  for (let valeur = 0; valeur < CROCKFORD.length; valeur += 1) {
    const point = CROCKFORD.codePointAt(valeur);
    table.set(point, valeur);
    table.set(minuscule(point), valeur);
  }
  for (const [ecarte, imite] of [
    [0x4f, "0"],
    [0x49, "1"],
    [0x4c, "1"],
  ]) {
    const valeur = CROCKFORD.indexOf(imite);
    table.set(ecarte, valeur);
    table.set(minuscule(ecarte), valeur);
  }
  return table;
})();

/**
 * RELIT une saisie : NFC, majuscule, retrait des séparateurs, repli, somme de contrôle, bourrage.
 *
 * Rend les seize octets, ou `null` pour tout refus. La distinction entre les motifs de refus n'est
 * pas l'affaire de ce vérificateur : ce qu'il mesure est qu'une forme est acceptée ou ne l'est pas.
 */
function relireSaisieDeRecuperation(texte) {
  const symboles = [];
  for (const signe of texte.normalize("NFC")) {
    const point = signe.codePointAt(0);
    if (SEPARATEURS_RECUPERATION.has(point)) continue;
    const valeur = SIGNES_RECUPERATION.get(point);
    if (valeur === undefined) return null;
    symboles.push(valeur);
  }
  if (symboles.length !== SYMBOLES_TOTAL_RECUPERATION) return null;
  if (residuDeRecuperation(symboles) !== 1) return null;
  return octetsDeRecuperation(symboles.slice(0, SYMBOLES_DONNEES_RECUPERATION));
}

/** HKDF-SHA-256 tel que la RFC 5869 le définit, par `node:crypto`. */
async function hkdf(materiau, sel, infoOctets, octets = 32) {
  const base = await webcrypto.subtle.importKey("raw", materiau, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(
    await webcrypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: sel, info: infoOctets },
      base,
      octets * 8,
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
  // La table est CLOSE, et le vérificateur le mesure plutôt que de le croire : sur tout le plan de
  // base, seuls les soixante signes déclarés — et U+212A, que la NFC ramène à « K » — passent.
  const declares = new Set([...SIGNES_RECUPERATION.keys(), 0x212a]);
  const admis = [];
  for (let point = 0; point <= 0xffff; point += 1) {
    if (point >= 0xd800 && point <= 0xdfff) continue;
    const normalise = String.fromCodePoint(point).normalize("NFC");
    if (normalise.length === 1 && SIGNES_RECUPERATION.has(normalise.codePointAt(0))) {
      admis.push(point);
    }
  }
  verifier(
    "récupération : la table des signes acceptés est CLOSE sur tout le plan de base",
    admis.length === declares.size && admis.every((point) => declares.has(point)),
    `${admis.length} points admis, ${declares.size} déclarés`,
  );
  verifier(
    "récupération : « ſ » (U+017F) et « ı » (U+0131) sont REFUSÉS — la mise en majuscule d'Unicode n'est pas un filtre",
    !admis.includes(0x017f) && !admis.includes(0x0131),
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
// L'ARCHIVE V3, son ENGAGEMENT et son enveloppe de récupération (#181, ADR 0033 ; #149, ADR 0027).
//
// Ce que ce bloc établit, depuis le seul texte de l'ADR 0027 et de l'ADR 0008 amendé : la
// disposition `[RBVAULT1][longueur d'en-tête][en-tête JSON][contenu N][récupération R]`, son
// arithmétique `12 + H + N + R`, les deux empreintes que l'en-tête déclare, et la propriété qui
// donne son sens à toute la tranche — la page embarquée ne porte QUE des emplacements de type 4.
//
// Il ne vérifie AUCUNE étiquette AES-GCM de l'enveloppe : la racine d'une page n'est vérifiable que
// sous la clé de volume, qui ne se trouve nulle part dans un fichier. Les vecteurs de l'ADR 0020
// tiennent cette part-là ; celui-ci tient le CONTENEUR, et le dit.
//
// **L'ENGAGEMENT, lui, est vérifié de bout en bout**, et c'est possible parce que la DEK du vecteur
// est PUBLIÉE : ce fichier redérive la clé du domaine `archive` par HKDF-SHA-256 depuis l'ADR 0033,
// reconstruit les données associées depuis la décision 2 de la Definition of Ready de #181, et
// OUVRE l'étiquette GCM. Un vecteur d'engagement qui ne se relit pas ne prouverait que l'accord de
// deux encodeurs.
// ---------------------------------------------------------------------------------------------

/** La disposition de l'archive, transcrite depuis l'ADR 0027 § « Format d'archive ». */
const ARCHIVE_MARQUEUR = "RBVAULT1";
const ARCHIVE_PREAMBULE_OCTETS = 12;
const ARCHIVE_VERSION = 3;
const ARCHIVE_EN_TETE_MARQUEUR = "railsbox-vault/volume-archive";

/** L'engagement de #181, transcrit depuis l'ADR 0033 (décision 3) et la DoR de #181 (décision 2). */
const ENGAGEMENT_MARQUEUR = "VLTENG01";
const ENGAGEMENT_FICHIER_VERSION = 1;
const ENGAGEMENT_FICHIER_OCTETS = 180;
const ETIQUETTE_SCHEMA_DE_DOMAINE = "railsbox-vault/derivation-de-domaine/v1";
const DOMAINE_ARCHIVE = "archive";
const ETIQUETTE_DOMAINE_ENGAGEMENT = "railsbox-vault/archive/engagement/v1";
const ALGORITHME_AEAD = "aes-256-gcm";

/** La disposition d'une PAGE d'enveloppe, transcrite depuis l'ADR 0020 § « Décision 2 ». */
const ENVELOPPE_MARQUEUR = "VLTKEY01";
const ENVELOPPE_PAGE_OCTETS = 8192;
const ENVELOPPE_ENTETE_PAGE_OCTETS = 108;
const ENVELOPPE_CRC_OFFSET = 104;
const ENVELOPPE_EMPLACEMENT_FIXE_OCTETS = 72;

/** Le seul type de clé de déverrouillage qu'une archive emporte (ADR 0027, décision 2). */
const TYPE_KEK_RECUPERATION = 4;

/** CRC-32 (polynôme 0xedb88320), transcrit ici comme le reste de la disposition. */
function crc32(octets) {
  let valeur = 0xffffffff;
  for (const octet of octets) {
    let terme = (valeur ^ octet) & 0xff;
    for (let bit = 0; bit < 8; bit += 1) {
      terme = terme & 1 ? (0xedb88320 ^ (terme >>> 1)) >>> 0 : terme >>> 1;
    }
    valeur = (terme ^ (valeur >>> 8)) >>> 0;
  }
  return (valeur ^ 0xffffffff) >>> 0;
}

/** Entier non signé GROS-BOUTISTE relu depuis des octets : la convention du préambule d'archive. */
function lireBe(octets, position, longueur) {
  let valeur = 0;
  for (let index = 0; index < longueur; index += 1) {
    valeur = valeur * 256 + octets[position + index];
  }
  return valeur;
}

/**
 * Relit la LISTE d'emplacements d'une page et rend le type de chacun, ou `null` si la liste ne se
 * décompose pas exactement sur sa fin déclarée. Rien n'est complété ni arrondi.
 */
function typesDesEmplacements(page, longueurListe) {
  const fin = ENVELOPPE_ENTETE_PAGE_OCTETS + longueurListe;
  const types = [];
  let curseur = ENVELOPPE_ENTETE_PAGE_OCTETS;
  while (curseur < fin) {
    if (fin - curseur < ENVELOPPE_EMPLACEMENT_FIXE_OCTETS) return null;
    const longueurParametres = lireLe(page, curseur + 10, 2);
    const total = ENVELOPPE_EMPLACEMENT_FIXE_OCTETS + longueurParametres;
    if (fin - curseur < total) return null;
    types.push(page[curseur + 8]);
    curseur += total;
  }
  return curseur === fin ? types : null;
}

/** La page EMBARQUÉE : marqueur, somme de contrôle, version, et types de ses emplacements. */
function verifierLaPageEmbarquee(page, declare) {
  memesOctets(
    "archive : la section de récupération commence par le marqueur d'enveloppe",
    texteAscii(ENVELOPPE_MARQUEUR),
    octetsEnHex(page.subarray(0, 8)),
  );
  verifier(
    "archive : la section de récupération fait exactement une page",
    page.byteLength === ENVELOPPE_PAGE_OCTETS,
    `${page.byteLength} octets`,
  );
  const nombre = lireLe(page, 12, 2);
  const version = lireLe(page, 16, 8);
  const longueurListe = lireLe(page, 40, 4);

  const utiles = page.slice(0, ENVELOPPE_ENTETE_PAGE_OCTETS + longueurListe);
  utiles.fill(0, ENVELOPPE_CRC_OFFSET, ENVELOPPE_CRC_OFFSET + 4);
  verifier(
    "archive : la somme de contrôle de la page embarquée vérifie",
    crc32(utiles) === lireLe(page, ENVELOPPE_CRC_OFFSET, 4),
  );

  const types = typesDesEmplacements(page, longueurListe);
  if (
    !verifier("archive : la liste de la page embarquée se décompose exactement", types !== null)
  ) {
    return;
  }
  verifier(
    "archive : le compte authentifié de la page est celui de sa liste",
    types.length === nombre,
    `${types.length} trouvés, ${nombre} déclarés`,
  );
  // LA propriété de l'ADR 0027 : le coffre et sa clé ne voyagent pas ensemble. Un emplacement de
  // type 1 (phrase) ou 2 (passkey) dans une archive serait une phrase secrète sortie de l'appareil.
  verifier(
    "archive : TOUS les emplacements embarqués sont de type 4 — ni phrase, ni passkey, ni harnais",
    types.every((type) => type === TYPE_KEK_RECUPERATION),
    `types trouvés : ${[...new Set(types)].join(", ")}`,
  );
  verifier(
    "archive : l'en-tête dit de la page la vérité — version et nombre d'emplacements",
    declare.envelopeVersion === version && declare.slots === types.length,
    `déclaré v${declare.envelopeVersion}/${declare.slots}, porté v${version}/${types.length}`,
  );
}

/** L'archive v2 entière : préambule, en-tête, arithmétique des sections, empreintes. */
/**
 * L'INFO de la dérivation d'un domaine, transcrite depuis l'ADR 0033, décision 3.
 *
 *     info = LP("railsbox-vault/derivation-de-domaine/v1") ‖ LP(domaine) ‖ LP(identifiantVolume)
 *          ‖ U32BE(versionDeFormatDuDomaine) ‖ LP("aes-256-gcm")
 */
function infoDeDomaine({ domaine, identifiantVolume, versionDeFormat }) {
  return concat(
    chainePrefixee(ETIQUETTE_SCHEMA_DE_DOMAINE),
    chainePrefixee(domaine),
    chainePrefixee(identifiantVolume),
    be(versionDeFormat, 4),
    chainePrefixee(ALGORITHME_AEAD),
  );
}

/** Les DONNÉES ASSOCIÉES de l'engagement, transcrites depuis la DoR de #181, décision 2. */
function donneesAssocieesDeLEngagement(d) {
  return concat(
    chainePrefixee(ETIQUETTE_DOMAINE_ENGAGEMENT),
    chainePrefixee(ALGORITHME_AEAD),
    be(d.versionDArchive, 4),
    chainePrefixee(d.identifiantVolume),
    be(d.tailleSupport, 8),
    be(d.tailleLogique, 8),
    be(d.tailleDeSecteur, 4),
    be(d.versionDeRecuperation, 4),
    be(d.longueurDuContenu, 8),
    be(d.longueurDeLaRecuperation, 8),
  );
}

/**
 * VÉRIFIE l'engagement de bout en bout : l'info, les données associées, la clé dérivée, l'étiquette
 * GCM, et le voisin de cent quatre-vingts octets que la restauration dépose.
 *
 * C'est le seul endroit de ce fichier qui OUVRE un scellement du produit, et il le peut parce que la
 * DEK du vecteur est publiée. Un engagement qui ne se relit pas ne prouverait rien.
 */
async function verifierLEngagement(vecteurs, enTete) {
  const engagement = vecteurs.engagement;
  const d = engagement.descripteur;

  const info = infoDeDomaine({
    domaine: DOMAINE_ARCHIVE,
    identifiantVolume: d.identifiantVolume,
    versionDeFormat: d.versionDArchive,
  });
  memesOctets(
    "engagement : l'info HKDF est celle de l'ADR 0033, champ par champ",
    info,
    engagement.info,
  );
  memesOctets(
    "engagement : les données associées sont celles de la décision 2 de #181",
    donneesAssocieesDeLEngagement(d),
    engagement.donneesAssociees,
  );
  verifier(
    "engagement : le domaine est « archive » et sa version de format est celle de l'archive",
    engagement.domaine === DOMAINE_ARCHIVE &&
      engagement.versionDeFormatDuDomaine === ARCHIVE_VERSION,
  );
  verifier(
    "engagement : le sel du domaine à usage unique fait trente-deux octets",
    hexEnOctets(engagement.sel).byteLength === 32,
  );

  // La clé du domaine, redérivée depuis la DEK PUBLIÉE. HKDF-SHA-256, RFC 5869.
  const octetsDeLaCle = await hkdf(
    hexEnOctets(vecteurs.cles.dek.hex),
    hexEnOctets(engagement.sel),
    info,
  );
  const cle = await webcrypto.subtle.importKey("raw", octetsDeLaCle, "AES-GCM", false, ["decrypt"]);
  const clair = await ouvrir(
    cle,
    hexEnOctets(engagement.nonce),
    donneesAssocieesDeLEngagement(d),
    hexEnOctets(engagement.chiffre),
    hexEnOctets(engagement.etiquette),
  );
  verifier(
    "engagement : l'étiquette VÉRIFIE sous la clé du domaine « archive » dérivée de la DEK",
    clair !== null,
  );
  if (clair !== null) {
    memesOctets(
      "engagement : le clair scellé est le SHA-256 du fichier chiffré ENTIER",
      clair,
      vecteurs.archive.empreinteDuContenu,
    );
  }

  // Ce que l'engagement scelle et ce que l'ARCHIVE déclare doivent se recouper : sans quoi
  // l'engagement s'accorderait à lui-même, c'est-à-dire à rien.
  verifier(
    "engagement : la géométrie scellée est celle que le manifeste de l'archive déclare",
    d.tailleLogique === enTete.manifest.geometry.volumeSize &&
      d.tailleDeSecteur === enTete.manifest.geometry.sectorSize &&
      d.longueurDuContenu === enTete.content.length &&
      d.longueurDeLaRecuperation === enTete.recovery.length &&
      d.versionDeRecuperation === enTete.recovery.envelopeVersion &&
      d.identifiantVolume === enTete.manifest.volume.id,
  );
  memesOctets(
    "engagement : l'en-tête de l'archive porte le sel, le nonce, le chiffré et l'étiquette publiés",
    concat(
      hexEnOctets(enTete.engagement.salt),
      hexEnOctets(enTete.engagement.nonce),
      hexEnOctets(enTete.engagement.ciphertext),
      hexEnOctets(enTete.engagement.tag),
    ),
    engagement.sel + engagement.nonce + engagement.chiffre + engagement.etiquette,
  );

  // Le VOISIN `<volume>.engagement` : cent quatre-vingts octets à largeur fixe.
  const voisin = hexEnOctets(engagement.voisin);
  verifier(
    "voisin d'engagement : cent quatre-vingts octets, ni plus ni moins",
    voisin.byteLength === ENGAGEMENT_FICHIER_OCTETS,
    `${voisin.byteLength}`,
  );
  memesOctets(
    "voisin d'engagement : les huit octets de tête sont le marqueur VLTENG01",
    texteAscii(ENGAGEMENT_MARQUEUR),
    octetsEnHex(voisin.subarray(0, 8)),
  );
  verifier(
    "voisin d'engagement : sa version de fichier est 1, distincte de la version d'archive",
    lireBe(voisin, 8, 4) === ENGAGEMENT_FICHIER_VERSION &&
      lireBe(voisin, 12, 4) === ARCHIVE_VERSION,
  );
  memesOctets(
    "voisin d'engagement : il porte le descripteur EN CLAIR, puis sel, nonce, chiffré, étiquette",
    concat(
      texteAscii(d.identifiantVolume),
      be(d.tailleSupport, 8),
      be(d.tailleLogique, 8),
      be(d.tailleDeSecteur, 4),
      be(d.versionDeRecuperation, 4),
      be(d.longueurDuContenu, 8),
      be(d.longueurDeLaRecuperation, 8),
      hexEnOctets(engagement.sel),
      hexEnOctets(engagement.nonce),
      hexEnOctets(engagement.chiffre),
      hexEnOctets(engagement.etiquette),
    ),
    octetsEnHex(voisin.subarray(16)),
  );
}

async function verifierArchive() {
  const vecteurs = lire("tests/vectors/archive-v3.json");
  const archive = hexEnOctets(vecteurs.archive.hex);

  memesOctets(
    "archive : les huit octets de tête sont le marqueur RBVAULT1",
    texteAscii(ARCHIVE_MARQUEUR),
    octetsEnHex(archive.subarray(0, 8)),
  );
  const longueurEnTete = lireBe(archive, 8, 4);
  verifier(
    "archive : la longueur d'en-tête est un uint32 GROS-BOUTISTE, à l'offset 8",
    longueurEnTete === vecteurs.archive.longueurEnTete,
    `${longueurEnTete} lu, ${vecteurs.archive.longueurEnTete} publié`,
  );

  const enTete = JSON.parse(
    new TextDecoder().decode(
      archive.subarray(ARCHIVE_PREAMBULE_OCTETS, ARCHIVE_PREAMBULE_OCTETS + longueurEnTete),
    ),
  );
  verifier(
    "archive : l'en-tête porte le marqueur textuel",
    enTete.magic === ARCHIVE_EN_TETE_MARQUEUR,
  );
  verifier(
    "archive : la version de format d'archive est 3",
    enTete.archiveFormatVersion === ARCHIVE_VERSION,
    `${enTete.archiveFormatVersion}`,
  );

  const offsetContenu = ARCHIVE_PREAMBULE_OCTETS + longueurEnTete;
  const offsetRecuperation = offsetContenu + enTete.content.length;
  verifier(
    "archive : offset du contenu = 12 + H",
    offsetContenu === vecteurs.archive.offsetDuContenu,
  );
  verifier(
    "archive : offset de la récupération = 12 + H + N",
    offsetRecuperation === vecteurs.archive.offsetDeLaRecuperation,
  );
  verifier(
    "archive : taille de l'archive = 12 + H + N + R",
    archive.byteLength === offsetRecuperation + enTete.recovery.length,
    `${archive.byteLength} octets pour ${offsetRecuperation} + ${enTete.recovery.length}`,
  );

  const contenu = archive.subarray(offsetContenu, offsetRecuperation);
  memesOctets(
    "archive : l'empreinte inscrite est le SHA-256 du contenu",
    await empreinte(contenu),
    enTete.content.digest,
  );
  verifier(
    "archive : le manifeste et l'en-tête portent la MÊME empreinte de contenu",
    enTete.manifest.identity.digest === enTete.content.digest,
  );

  await verifierLEngagement(vecteurs, enTete);

  const page = archive.subarray(offsetRecuperation);
  memesOctets(
    "archive : l'empreinte de la section de récupération est le SHA-256 de ses octets",
    await empreinte(page),
    enTete.recovery.digest,
  );
  verifierLaPageEmbarquee(page.slice(), enTete.recovery);

  // Et le CONTENU n'est pas une enveloppe : le marqueur ne doit apparaître qu'à l'offset déclaré.
  const marqueur = octetsEnHex(texteAscii(ENVELOPPE_MARQUEUR));
  verifier(
    "archive : le marqueur d'enveloppe n'apparaît qu'à l'offset de la section de récupération",
    octetsEnHex(contenu).includes(marqueur) === false,
  );
}

/**
 * L'ARCHIVE v3 d'un volume ANTÉRIEUR à v3 : `engagement` NUL, `recovery` NUL, manifeste v2.
 *
 * Elle est dérivée du § 7.5 de `docs/format-de-volume-v3.md` et de rien d'autre, comme le reste de
 * ce fichier. Ce qu'elle fige est une FORME, et il faut le dire : cette archive n'est **pas
 * authentifiée**. Un volume antérieur à v3 n'est pas chiffré et n'a pas d'identifiant : il n'y a
 * rien à engager, et la restauration ne dépose aucun voisin d'engagement. Le volume posé est refusé
 * à l'ouverture tant que la migration v2 → v3 ne l'a pas rechiffré.
 *
 * Sans ce vecteur, cette forme n'avait AUCUN contrat d'octets, alors que le produit l'écrit ET
 * l'exige — un champ `engagement` absent est refusé, un champ non nul aussi (constat 2 de la revue
 * de format de la PR #184).
 */
async function verifierArchiveDeVolumeAnterieur() {
  const vecteurs = lire("tests/vectors/archive-v3.json");
  const publie = vecteurs.archiveDeVolumeAnterieur;
  const archive = hexEnOctets(publie.hex);

  memesOctets(
    "archive antérieure : les huit octets de tête sont le MÊME marqueur RBVAULT1",
    texteAscii(ARCHIVE_MARQUEUR),
    octetsEnHex(archive.subarray(0, 8)),
  );
  const longueurEnTete = lireBe(archive, 8, 4);
  verifier(
    "archive antérieure : la longueur d'en-tête est un uint32 GROS-BOUTISTE, à l'offset 8",
    longueurEnTete === publie.longueurEnTete,
    `${longueurEnTete} lu, ${publie.longueurEnTete} publié`,
  );

  const enTete = JSON.parse(
    new TextDecoder().decode(
      archive.subarray(ARCHIVE_PREAMBULE_OCTETS, ARCHIVE_PREAMBULE_OCTETS + longueurEnTete),
    ),
  );
  verifier(
    "archive antérieure : la version de CONTENEUR est 3, comme toute archive que ce runtime lit",
    enTete.magic === ARCHIVE_EN_TETE_MARQUEUR && enTete.archiveFormatVersion === ARCHIVE_VERSION,
    `${enTete.archiveFormatVersion}`,
  );
  verifier(
    "archive antérieure : le manifeste décrit un volume ANTÉRIEUR à v3",
    enTete.manifest.formatVersion < 3,
    `${enTete.manifest.formatVersion}`,
  );
  verifier(
    "archive antérieure : le manifeste ne DÉCLARE aucun identifiant de volume — v2 n'en a pas",
    enTete.manifest.volume === undefined || enTete.manifest.volume === null,
  );
  // Le cœur du vecteur : le champ est PRÉSENT et NUL. Un champ absent ne dit pas la même chose —
  // il laisserait croire à un en-tête d'une autre version —, et le produit le REFUSE.
  verifier(
    "archive antérieure : « engagement » est PRÉSENT et NUL, jamais absent",
    Object.hasOwn(enTete, "engagement") && enTete.engagement === null,
    `${JSON.stringify(enTete.engagement)}`,
  );
  verifier(
    "archive antérieure : « recovery » suit la même règle — présent et nul",
    Object.hasOwn(enTete, "recovery") && enTete.recovery === null,
  );

  const offsetContenu = ARCHIVE_PREAMBULE_OCTETS + longueurEnTete;
  verifier(
    "archive antérieure : offset du contenu = 12 + H",
    offsetContenu === publie.offsetDuContenu,
  );
  verifier(
    "archive antérieure : taille de l'archive = 12 + H + N, et RIEN ne suit le contenu",
    archive.byteLength === offsetContenu + enTete.content.length,
    `${archive.byteLength} octets pour ${offsetContenu} + ${enTete.content.length}`,
  );

  const contenu = archive.subarray(offsetContenu);
  memesOctets(
    "archive antérieure : l'empreinte inscrite est le SHA-256 du contenu",
    await empreinte(contenu),
    enTete.content.digest,
  );
  verifier(
    "archive antérieure : le manifeste et l'en-tête portent la MÊME empreinte de contenu",
    enTete.manifest.identity.digest === enTete.content.digest,
  );
  // Et le contenu est un fichier BRUT : ni en-tête v3, ni région d'authentification. C'est ce qui
  // rend vraie la phrase « il n'y a rien à engager ».
  verifier(
    "archive antérieure : le contenu ne porte AUCUN en-tête de volume v3",
    octetsEnHex(contenu).includes(octetsEnHex(texteAscii("VLTVOL03"))) === false,
  );
  verifier(
    "archive antérieure : le fichier EST le volume — taille de fichier et taille logique coïncident",
    enTete.content.length === enTete.manifest.geometry.volumeSize,
    `${enTete.content.length} contre ${enTete.manifest.geometry.volumeSize}`,
  );
}

// ---------------------------------------------------------------------------------------------
// 5. Le format de volume v4 et sa HIÉRARCHIE DE CLÉS (#182, ADR 0033).
//
// C'est la section qui mesure ce que les précédentes ne pouvaient plus mesurer : depuis la v4, les
// octets d'un secteur ne suffisent pas, parce que la clé sous laquelle ils sont scellés n'est plus
// la DEK. Elle redérive donc tout, depuis l'ADR seul, et OUVRE avec sa propre clé ce que le produit
// a scellé. La clé du produit n'est jamais extraite — elle est NON EXTRACTIBLE —, et pourtant
// l'égalité est établie : c'est la seule mesure qui vaille.
// ---------------------------------------------------------------------------------------------

/** L'en-tête v4 d'un volume, posé depuis le § 6.2 de la spécification. Petit-boutiste. */
function enTeteDeVolumeV4({ tailleLogique, identifiantVolume, scellementComplet }) {
  const octets = new Uint8Array(512);
  const secteurs = tailleLogique / SECTEUR;
  const regionOctets = Math.ceil((secteurs * SCEAU_OCTETS) / SECTEUR) * SECTEUR;
  octets.set(texteAscii(MARQUEUR_V4), 0);
  octets.set(le(FORMAT_VOLUME_V4, 4), 8);
  octets.set(le(SECTEUR, 4), 12);
  octets.set(le(tailleLogique, 8), 16);
  octets.set(le(512, 8), 24);
  octets.set(le(regionOctets, 8), 32);
  octets.set(le(512 + regionOctets, 8), 40);
  octets.set(hexEnOctets(identifiantVolume), 48);
  if (scellementComplet) octets.set(texteAscii("VLTSEAL1"), 64);
  return octets;
}

/** La racine SUR DISQUE au format de journal 5 : 210 octets utiles, la réserve à zéro. */
function racineSurDisqueV5(racine, fraicheurHex) {
  const octets = new Uint8Array(512);
  octets.set(texteAscii("VLTGEN01"), 0);
  octets.set(le(FORMAT_JOURNAL_DEUX_COMPTEURS, 4), 8);
  octets.set(le(SECTEUR, 4), 12);
  octets.set(le(racine.entete.sequence, 8), 16);
  octets.set(le(racine.entete.generation, 8), 24);
  octets.set(le(racine.entete.tailleVolume, 8), 32);
  octets.set(le(racine.entete.nombreEntrees, 4), 40);
  octets.set(le(racine.entete.longueurCharge, 8), 44);
  octets.set(hexEnOctets(racine.entete.volume), 52);
  octets.set(le(racine.entete.scellementsCumulesVolume, 8), 68);
  octets.set(hexEnOctets(racine.nonce), 76);
  octets.set(hexEnOctets(racine.chiffre), 88);
  octets.set(hexEnOctets(racine.etiquette), 120);
  octets.set(hexEnOctets(fraicheurHex), 136);
  octets.set(le(racine.entete.scellementsCumulesJournal, 8), 202);
  return octets;
}

/** Importe une clé AES-GCM depuis les trente-deux octets qu'HKDF a rendus. */
async function cleDepuisOkm(okm) {
  return webcrypto.subtle.importKey("raw", okm, "AES-GCM", false, ["decrypt"]);
}

async function verifierVolumeV4() {
  const v = lire("tests/vectors/volume-v4.json");

  verifier(
    "v4 : le document annonce le format de volume 4 et le format de journal 5",
    v.formatVolume === FORMAT_VOLUME_V4 && v.formatJournal === FORMAT_JOURNAL_DEUX_COMPTEURS,
    `annoncés ${v.formatVolume} et ${v.formatJournal}`,
  );
  verifier(
    "v4 : l'en-tête d'une racine à deux compteurs fait 210 octets",
    v.racineEnteteOctets === RACINE_ENTETE_V5_OCTETS,
    `annoncé ${v.racineEnteteOctets}`,
  );

  // --- L'ANCRAGE : le cas 3 de la RFC 5869, sel vide et info vide. -------------------------
  //
  // Il vient AVANT tout le reste, et c'est délibéré : il dit que l'HKDF de ce vérificateur est
  // celui du document normatif. Sans lui, redériver les clés du format ne prouverait que l'accord
  // de ce fichier avec lui-même.
  const ancrage = v.ancrage;
  const okmAncrage = await hkdf(hexEnOctets(ancrage.ikm), new Uint8Array(0), new Uint8Array(0), 42);
  memesOctets(
    "v4 : ancrage RFC 5869 cas 3 — sel VIDE, info VIDE, l'OKM est celui que la RFC publie",
    okmAncrage,
    ancrage.attenduParLaRfc,
  );
  verifier(
    "v4 : le document publie bien l'OKM que la RFC attend, et non le sien",
    ancrage.okm === ancrage.attenduParLaRfc,
  );

  // --- L'INFO de chaque domaine, champ par champ, et l'OKM qui en sort. ---------------------
  const dek = hexEnOctets(v.cleMaitresse.hex);
  const cles = {};
  for (const [nom, domaine] of Object.entries(v.derivation.domaines)) {
    const info = infoDeDomaine({
      domaine: nom,
      identifiantVolume: v.derivation.identifiantVolume,
      versionDeFormat: domaine.versionDeFormatDuDomaine,
    });
    memesOctets(
      `v4 : l'info HKDF du domaine « ${nom} » est celle de l'ADR 0033`,
      info,
      domaine.info,
    );
    verifier(
      `v4 : le domaine « ${nom} » est à COMPTEUR, donc son sel est VIDE`,
      domaine.regime === "compteur" && domaine.sel === "" && domaine.selOctets === 0,
    );
    const okmDuDomaine = await hkdf(dek, new Uint8Array(0), info, 32);
    memesOctets(
      `v4 : l'OKM du domaine « ${nom} » est celui que le document publie`,
      okmDuDomaine,
      domaine.okm,
    );
    cles[nom] = await cleDepuisOkm(okmDuDomaine);
  }
  verifier(
    "v4 : les deux domaines d'un MÊME volume tirent des clés DISTINCTES — le cœur de #182",
    v.derivation.domaines.volume.okm !== v.derivation.domaines.journal.okm,
  );

  // --- L'EN-TÊTE du fichier. ----------------------------------------------------------------
  memesOctets(
    "v4 : l'en-tête de volume est celui du § 6.2, marqueur VLTVOL04 compris",
    enTeteDeVolumeV4({
      tailleLogique: v.volume.tailleLogique,
      identifiantVolume: v.volume.identifiant,
      scellementComplet: v.enTete.scellementComplet,
    }),
    v.enTete.hex,
  );
  verifier(
    "v4 : le marqueur du fichier DIT v4 — un runtime d'avant #182 ne le prend pas pour un v3",
    octetsEnHex(texteAscii(MARQUEUR_V4)) === v.enTete.hex.slice(0, 16),
  );

  // --- LE SECTEUR, sous la clé du domaine « volume ». ---------------------------------------
  const secteur = v.secteur;
  memesOctets(
    "v4 : les données associées du secteur sont celles d'un BLOC du volume",
    donneesAssocieesDeBloc(secteur.identite),
    secteur.donneesAssociees,
  );
  memesOctets(
    "v4 : le clair publié suit la règle que le document annonce",
    contenuAttendu(secteur.clair.longueur, secteur.clair.graine),
    secteur.clair.hex,
  );
  const clairDuSecteur = await ouvrir(
    cles.volume,
    hexEnOctets(secteur.nonce),
    donneesAssocieesDeBloc(secteur.identite),
    hexEnOctets(secteur.chiffre),
    hexEnOctets(secteur.etiquette),
  );
  verifier(
    "v4 : le secteur OUVRE sous la clé que CE fichier a dérivée — celle du produit reste non extractible",
    clairDuSecteur !== null,
  );
  if (clairDuSecteur !== null) {
    memesOctets("v4 : et il rend exactement le clair publié", clairDuSecteur, secteur.clair.hex);
  }
  const secteurSousLaDek = await ouvrir(
    await importerCle(v.cleMaitresse.hex),
    hexEnOctets(secteur.nonce),
    donneesAssocieesDeBloc(secteur.identite),
    hexEnOctets(secteur.chiffre),
    hexEnOctets(secteur.etiquette),
  );
  verifier(
    "v4 : le secteur ne s'ouvre PAS sous la DEK — elle ne scelle plus rien (ADR 0033, décision 1)",
    secteurSousLaDek === null,
  );
  const secteurSousLaCleDuJournal = await ouvrir(
    cles.journal,
    hexEnOctets(secteur.nonce),
    donneesAssocieesDeBloc(secteur.identite),
    hexEnOctets(secteur.chiffre),
    hexEnOctets(secteur.etiquette),
  );
  verifier(
    "v4 : le secteur ne s'ouvre PAS sous la clé du JOURNAL — une collision de nonce ne traverse plus",
    secteurSousLaCleDuJournal === null,
  );
  memesOctets(
    "v4 : le sceau du secteur est celui de 34 octets, génération petit-boutiste",
    encoderSceau({
      nonce: hexEnOctets(secteur.nonce),
      etiquette: hexEnOctets(secteur.etiquette),
      generation: secteur.identite.generation,
    }),
    secteur.sceauHex,
  );

  // --- L'ENREGISTREMENT, sous la clé du domaine « journal ». --------------------------------
  const enregistrement = v.enregistrement;
  memesOctets(
    "v4 : les données associées de l'enregistrement sont celles d'un ENREGISTREMENT (#143)",
    donneesAssocieesDEnregistrement(enregistrement.identite),
    enregistrement.donneesAssociees,
  );
  const clairDeLEnregistrement = await ouvrir(
    cles.journal,
    hexEnOctets(enregistrement.nonce),
    donneesAssocieesDEnregistrement(enregistrement.identite),
    hexEnOctets(enregistrement.chiffre),
    hexEnOctets(enregistrement.etiquette),
  );
  verifier(
    "v4 : l'enregistrement OUVRE sous la clé du domaine « journal », et sous elle seule",
    clairDeLEnregistrement !== null,
  );
  const enregistrementSousLaCleDuVolume = await ouvrir(
    cles.volume,
    hexEnOctets(enregistrement.nonce),
    donneesAssocieesDEnregistrement(enregistrement.identite),
    hexEnOctets(enregistrement.chiffre),
    hexEnOctets(enregistrement.etiquette),
  );
  verifier(
    "v4 : l'enregistrement ne s'ouvre PAS sous la clé du VOLUME — deux magasins, deux clés",
    enregistrementSousLaCleDuVolume === null,
  );

  // --- LA RACINE, à onze champs. -------------------------------------------------------------
  const racine = v.racine;
  const associeesDeLaRacine = donneesAssocieesDeRacine(racine.entete);
  memesOctets(
    "v4 : les données associées de la racine sont celles du § 5.2, ONZE champs",
    associeesDeLaRacine,
    racine.donneesAssociees,
  );
  verifier(
    "v4 : elles font 144 octets pour un identifiant de trente-deux caractères",
    associeesDeLaRacine.byteLength === 144 &&
      racine.donneesAssocieesOctets === associeesDeLaRacine.byteLength,
    `${associeesDeLaRacine.byteLength} octets`,
  );
  verifier(
    "v4 : la racine publie DEUX compteurs, et le second est celui du journal",
    Number.isInteger(racine.entete.scellementsCumulesVolume) &&
      Number.isInteger(racine.entete.scellementsCumulesJournal),
  );
  memesOctets(
    "v4 : l'empreinte des entrées est celle de l'encodage canonique de la suite",
    await empreinte(encoderEntrees(racine.entrees)),
    racine.empreinteEntrees,
  );
  const empreinteAuthentique = await ouvrir(
    cles.volume,
    hexEnOctets(racine.nonce),
    associeesDeLaRacine,
    hexEnOctets(racine.chiffre),
    hexEnOctets(racine.etiquette),
  );
  verifier(
    "v4 : la racine OUVRE sous la clé du domaine « volume » — c'est elle, l'autorité du volume",
    empreinteAuthentique !== null,
  );
  if (empreinteAuthentique !== null) {
    memesOctets(
      "v4 : et elle scelle l'empreinte des entrées, pas autre chose",
      empreinteAuthentique,
      racine.empreinteEntrees,
    );
  }

  // La MUTATION qui donne son prix aux onze champs : la même racine relue comme une racine de v3 —
  // dix champs — ne vérifie pas. Le nombre de champs suit la version, et la version est scellée.
  const commeUneV3 = await ouvrir(
    cles.volume,
    hexEnOctets(racine.nonce),
    donneesAssocieesDeRacine({ ...racine.entete, formatVersion: 3 }),
    hexEnOctets(racine.chiffre),
    hexEnOctets(racine.etiquette),
  );
  verifier(
    "v4 : la même racine relue à DIX champs ne vérifie pas — le second compteur est authentifié",
    commeUneV3 === null,
  );

  memesOctets(
    "v4 : la racine SUR DISQUE est celle du § 6.7, second compteur à l'offset 202",
    racineSurDisqueV5(racine, racine.fraicheurHex),
    racine.surDisqueHex,
  );
}

// ---------------------------------------------------------------------------------------------
// La PAGE D'ENVELOPPE v2 et ses DEUX DOMAINES (#182, T2b ; ADR 0020, ADR 0027, ADR 0033).
//
// C'est le seul endroit de ce fichier qui refasse une CHAÎNE COMPLÈTE d'un bout à l'autre : l'info
// d'un domaine, la clé de trente-deux octets que HKDF en tire, le scellement de la racine sous cette
// clé, et la disposition de la page qui la porte. Il le peut parce que la DEK du vecteur est
// publiée, et il le doit : le domaine `recuperation` scelle ce qu'une ARCHIVE emporte, c'est-à-dire
// le seul artefact du produit qu'un tiers aura un jour à relire sans le produit.
//
// La disposition v2 est transcrite depuis l'ADR 0020 tel que #182 l'amende : l'en-tête passe de 108
// à 140 octets, le SEL de trente-deux octets s'ajoute à l'offset 104 — là où la v1 s'arrêtait —, la
// somme de contrôle recule à 136, et l'octet 14, qui était du remplissage, porte le DOMAINE.

/** Disposition d'une page v2, transcrite depuis l'ADR 0020 amendé par #182. */
const ENVELOPPE_V2_ENTETE_OCTETS = 140;
const ENVELOPPE_V2_DOMAINE_OFFSET = 14;
const ENVELOPPE_V2_SEL_OFFSET = 104;
const ENVELOPPE_V2_SEL_OCTETS = 32;
const ENVELOPPE_V2_CRC_OFFSET = 136;

/** Étiquettes de domaine de l'enveloppe, transcrites depuis l'ADR 0020, décision 2. */
const ENVELOPPE_DOMAINE_RACINE = "railsbox-vault/enveloppe/v1/racine";
const ENVELOPPE_DOMAINE_EMPLACEMENTS = "railsbox-vault/enveloppe/v1/emplacements";

/**
 * Données associées de la RACINE d'une page, transcrites depuis l'ADR 0020.
 *
 * Le COMPTE des emplacements y est, la LONGUEUR de la liste n'y est pas : c'est cet écart qui rend
 * une troncature détectable, et le vérifier ici le confirme depuis le texte seul.
 */
function enteteDeRacineDEnveloppe({
  identifiantVolume,
  formatVersion,
  version,
  nombreEmplacements,
}) {
  return concat(
    chainePrefixee(ENVELOPPE_DOMAINE_RACINE),
    chainePrefixee(ALGORITHME_AEAD),
    be(formatVersion, 4),
    chainePrefixee(identifiantVolume),
    be(version, 8),
    be(nombreEmplacements, 2),
  );
}

/** Encodage canonique de la suite ORDONNÉE des emplacements, transcrit depuis l'ADR 0020. */
function encodageCanoniqueDesEmplacements(emplacements) {
  const morceaux = [chainePrefixee(ENVELOPPE_DOMAINE_EMPLACEMENTS), be(emplacements.length, 2)];
  for (const emplacement of emplacements) {
    const parametres = hexEnOctets(emplacement.parametres);
    morceaux.push(
      chainePrefixee(emplacement.identifiantEmplacement),
      be(emplacement.typeKek, 1),
      be(parametres.byteLength, 2),
      parametres,
      hexEnOctets(emplacement.nonce),
      hexEnOctets(emplacement.etiquette),
    );
  }
  return concat(...morceaux);
}

/** Octets d'UN emplacement sur disque, transcrits depuis la table de l'ADR 0020. */
function emplacementSurDisque(emplacement) {
  const parametres = hexEnOctets(emplacement.parametres);
  const octets = new Uint8Array(ENVELOPPE_EMPLACEMENT_FIXE_OCTETS + parametres.byteLength);
  octets.set(hexEnOctets(emplacement.identifiantEmplacement), 0);
  octets[8] = emplacement.typeKek;
  poserLe(octets, 10, parametres.byteLength, 2);
  octets.set(hexEnOctets(emplacement.nonce), 12);
  octets.set(hexEnOctets(emplacement.dekEnveloppee), 24);
  octets.set(hexEnOctets(emplacement.etiquette), 56);
  octets.set(parametres, ENVELOPPE_EMPLACEMENT_FIXE_OCTETS);
  return octets;
}

/** Écrit un entier PETIT-BOUTISTE : la convention de la disposition d'une page. */
function poserLe(cible, position, valeur, longueur) {
  let reste = valeur;
  for (let index = 0; index < longueur; index += 1) {
    cible[position + index] = reste % 256;
    reste = Math.floor(reste / 256);
  }
}

/** Octets d'une PAGE v2 entière, transcrits depuis la table amendée par #182. */
function pageV2SurDisque(figee, identifiantVolume) {
  const octets = new Uint8Array(ENVELOPPE_PAGE_OCTETS);
  const liste = figee.emplacements.map(emplacementSurDisque);
  const longueurListe = liste.reduce((somme, morceau) => somme + morceau.byteLength, 0);
  octets.set(texteAsciiEnOctets(ENVELOPPE_MARQUEUR), 0);
  poserLe(octets, 8, 2, 4);
  poserLe(octets, 12, figee.emplacements.length, 2);
  octets[ENVELOPPE_V2_DOMAINE_OFFSET] = figee.octetDeDomaine;
  poserLe(octets, 16, figee.version, 8);
  octets.set(hexEnOctets(identifiantVolume), 24);
  poserLe(octets, 40, longueurListe, 4);
  octets.set(hexEnOctets(figee.racine.nonce), 44);
  octets.set(hexEnOctets(figee.racine.chiffre), 56);
  octets.set(hexEnOctets(figee.racine.etiquette), 88);
  octets.set(hexEnOctets(figee.sel), ENVELOPPE_V2_SEL_OFFSET);
  let curseur = ENVELOPPE_V2_ENTETE_OCTETS;
  for (const morceau of liste) {
    octets.set(morceau, curseur);
    curseur += morceau.byteLength;
  }
  poserLe(octets, ENVELOPPE_V2_CRC_OFFSET, crc32(octets.subarray(0, curseur)), 4);
  return octets;
}

/** Les octets ASCII d'un texte. Le marqueur est posé ainsi, comme partout dans ce fichier. */
function texteAsciiEnOctets(valeur) {
  return new TextEncoder().encode(valeur);
}

/** La chaîne entière, pour UNE page figée : info, clé, racine, disposition. */
async function verifierUnePageV2(nom, figee, identifiantVolume, dek) {
  const info = infoDeDomaine({
    domaine: figee.domaine,
    identifiantVolume,
    versionDeFormat: figee.versionDeFormatDuDomaine,
  });
  memesOctets(`enveloppe v2 : l'info du domaine « ${figee.domaine} »`, info, figee.info);

  const octetsDeLaCle = await hkdf(dek, hexEnOctets(figee.sel), info, 32);
  memesOctets(
    `enveloppe v2 : les 32 octets que HKDF tire pour « ${figee.domaine} »`,
    octetsDeLaCle,
    figee.cleDerivee,
  );

  // La RACINE, refaite : l'empreinte de la suite ordonnée est le CLAIR, l'en-tête les données
  // associées. Sceller sous le même nonce doit rendre exactement les octets publiés.
  const empreinte = new Uint8Array(
    await webcrypto.subtle.digest("SHA-256", encodageCanoniqueDesEmplacements(figee.emplacements)),
  );
  memesOctets(
    `enveloppe v2 : l'empreinte de la suite ordonnée de « ${nom} »`,
    empreinte,
    figee.racine.empreinte,
  );
  const scelle = await sceller(
    await importerCle(figee.cleDerivee),
    hexEnOctets(figee.racine.nonce),
    enteteDeRacineDEnveloppe({
      identifiantVolume,
      formatVersion: 2,
      version: figee.version,
      nombreEmplacements: figee.emplacements.length,
    }),
    empreinte,
  );
  memesOctets(
    `enveloppe v2 : le chiffré de la racine de « ${nom} »`,
    scelle.chiffre,
    figee.racine.chiffre,
  );
  memesOctets(
    `enveloppe v2 : l'étiquette de la racine de « ${nom} »`,
    scelle.etiquette,
    figee.racine.etiquette,
  );

  memesOctets(
    `enveloppe v2 : la PAGE de « ${nom} » sur disque, en-tête de 140 octets et sel en clair`,
    pageV2SurDisque(figee, identifiantVolume),
    figee.page,
  );
}

/**
 * La page d'enveloppe v2, ses DEUX domaines, et ce qui les sépare.
 *
 * La propriété centrale tient en une ligne : les deux pages ont la même version de format et le même
 * volume, et pourtant leurs clés diffèrent — parce que l'info porte le NOM DU DOMAINE. Si ces deux
 * clés devenaient une seule, la page qu'une archive emporte partagerait sa clé avec la serrure
 * restée sur l'appareil, ce que l'ADR 0033, décision 2, refuse.
 */
async function verifierEnveloppeV2() {
  const vecteurs = lire("tests/vectors/enveloppe-v2.json");
  const identifiantVolume = vecteurs.volume.identifiantVolume;
  const dek = hexEnOctets(vecteurs.cles.dek.hex);

  verifier(
    "enveloppe v2 : l'en-tête fait 140 octets, la somme recule à 136, le sel occupe 104 à 135",
    vecteurs.specification.enTetePageOctets === ENVELOPPE_V2_ENTETE_OCTETS &&
      vecteurs.specification.crcOffset === ENVELOPPE_V2_CRC_OFFSET &&
      vecteurs.specification.selOffset === ENVELOPPE_V2_SEL_OFFSET &&
      vecteurs.specification.selOctets === ENVELOPPE_V2_SEL_OCTETS,
    JSON.stringify(vecteurs.specification),
  );
  verifier(
    "enveloppe v2 : l'octet 14, remplissage en v1, porte le DOMAINE de la racine",
    vecteurs.specification.domaineOffset === ENVELOPPE_V2_DOMAINE_OFFSET,
    `offset ${vecteurs.specification.domaineOffset}`,
  );

  for (const [nom, figee] of Object.entries(vecteurs.pages)) {
    await verifierUnePageV2(nom, figee, identifiantVolume, dek);
  }

  verifier(
    "enveloppe v2 : deux domaines, deux infos, deux clés — pour le MÊME volume et la MÊME version",
    vecteurs.pages.complete.info !== vecteurs.pages.embarquee.info &&
      vecteurs.pages.complete.cleDerivee !== vecteurs.pages.embarquee.cleDerivee &&
      vecteurs.pages.complete.versionDeFormatDuDomaine ===
        vecteurs.pages.embarquee.versionDeFormatDuDomaine,
  );
  verifier(
    "enveloppe v2 : la page EMBARQUÉE ne porte que des emplacements de type 4 (ADR 0027)",
    vecteurs.pages.embarquee.emplacements.every(
      (emplacement) => emplacement.typeKek === TYPE_KEK_RECUPERATION,
    ),
  );
  verifier(
    "enveloppe v2 : les deux SELS diffèrent — une clé à usage unique par page",
    vecteurs.pages.complete.sel !== vecteurs.pages.embarquee.sel,
  );
  // Et le TÉMOIN NÉGATIF : la clé de l'autre domaine n'ouvre PAS cette racine. Sans lui, « deux
  // clés distinctes » ne dirait pas que la séparation opère.
  const croisee = await ouvrir(
    await importerCle(vecteurs.pages.complete.cleDerivee),
    hexEnOctets(vecteurs.pages.embarquee.racine.nonce),
    enteteDeRacineDEnveloppe({
      identifiantVolume,
      formatVersion: 2,
      version: vecteurs.pages.embarquee.version,
      nombreEmplacements: vecteurs.pages.embarquee.emplacements.length,
    }),
    hexEnOctets(vecteurs.pages.embarquee.racine.chiffre),
    hexEnOctets(vecteurs.pages.embarquee.racine.etiquette),
  );
  verifier(
    "enveloppe v2 : la clé du domaine `enveloppe` n'ouvre PAS la racine du domaine `recuperation`",
    croisee === null,
  );
}

// ---------------------------------------------------------------------------------------------

async function main() {
  await verifierModele();
  await verifierDisposition();
  await verifierRecuperation();
  await verifierArchive();
  await verifierArchiveDeVolumeAnterieur();
  await verifierVolumeV4();
  await verifierEnveloppeV2();

  const total = vertes + rouges.length;
  if (rouges.length === 0) {
    process.stdout.write(
      `VERT — ${vertes} vérifications vertes sur ${total}, sans importer une ligne du produit.\n` +
        `Les octets figés de tests/vectors/ sont ceux que docs/format-de-volume-v3.md,\n` +
        `docs/decisions/0025-moyen-de-recuperation.md,\n` +
        `docs/decisions/0027-archive-et-ancre-de-version.md et\n` +
        `docs/decisions/0033-hierarchie-de-cles-derivees-par-domaine.md décrivent.\n`,
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
