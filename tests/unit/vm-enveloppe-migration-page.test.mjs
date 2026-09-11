import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import {
  DOMAINE_OFFSET,
  PAGES,
  PAGE_OCTETS,
  TAILLE_FICHIER_ENVELOPPE,
  decoderPage,
  encoderPage,
  offsetDePage,
} from "../../src/vm/enveloppe/fichier-enveloppe.mjs";
import {
  EMPLACEMENT_FORMAT_V1,
  ENVELOPPE_FORMAT_V1,
  ENVELOPPE_FORMAT_V2,
  TYPES_KEK,
} from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import {
  envelopperSousNonce,
  importerCleDeDeverrouillage,
} from "../../src/vm/enveloppe/modele-reference.mjs";
import { lireEtat } from "../../src/vm/enveloppe/etat-de-lenveloppe.mjs";
import {
  ajouterEmplacement,
  ouvrirEnveloppe,
  revoquerEmplacement,
} from "../../src/vm/enveloppe-de-cle.mjs";
import {
  CoupureSimulee,
  composerPageAlaMain,
  identifiantDeVolume,
  supportDouble,
  suiteDOctets,
} from "./support-enveloppe-double.mjs";

// LA MIGRATION D'UNE PAGE D'ENVELOPPE v1 → v2, à CHAQUE RANG DE COUPURE (#182, T2b ; ADR 0033).
//
// « Perdre une enveloppe, c'est perdre le volume. » C'est la phrase de la Definition of Ready de
// #182, et c'est ce que ce fichier existe pour rendre théorique. Le geste qu'il éprouve est le plus
// risqué des deux tranches du format v4 : une page dont la racine est scellée sous la DEK est
// RESCELLÉE sous une clé dérivée, à la première ouverture réussie, sur un fichier qui est la SERRURE
// du volume.
//
// ## Ce qui est mesuré, et pourquoi ce n'est pas « ça ne lève pas »
//
// À CHAQUE rang de CHAQUE sinistre, trois choses, et les trois ensemble :
//
//  1. **les QUATRE clés de déverrouillage ouvrent encore.** Pas « une », pas « celle qui a servi à
//     migrer » : les quatre. La migration recopie la liste TELLE QUELLE et ne demande aucune KEK ;
//     si elle en perdait une, ce serait ici, et ce serait un volume dont un appareil a perdu
//     l'accès sans que personne ne l'ait décidé ;
//  2. **l'état est CLASSÉ** — v1 à la version N, ou v2 à la version N + 1. Jamais un entre-deux,
//     jamais « ça s'ouvre » sans dire lequel des deux états on tient ;
//  3. **la LISTE est identique**, identifiant par identifiant, dans l'ordre. Une migration qui
//     réordonnerait ferait échouer l'empreinte de la racine au premier déverrouillage suivant.
//
// ## Pourquoi la coupure ne se voit pas par une exception
//
// `ouvrirEnveloppe` ne fait PAS échouer un déverrouillage parce qu'une migration de FORMAT n'a pas
// pu s'écrire : le volume s'ouvre sous sa page v1, et la migration sera retentée. Le refus est
// RENDU dans `migration.refus`, jamais avalé. La matrice s'en sert donc comme signal : une coupure
// qui a eu lieu est une migration `faite: false` portant sa raison.
//
// ## D'où vient la page v1 de ces épreuves
//
// Le produit n'en écrit plus. Elle est composée par le MODÈLE DE RÉFÉRENCE de l'ADR 0020 — la
// spécification exécutable dont `tests/vectors/enveloppe-v1.json` fige les octets — et par
// `encoderPage`, l'encodeur du produit, en version 1. C'est le même chemin qui a écrit toutes les
// pages v1 en service. `vm-enveloppe-vecteurs.test.mjs` migre en plus les QUATRE pages FIGÉES du
// contrat, qui, elles, ne doivent rien à ce fichier.

const VOLUME = identifiantDeVolume(0x0a);
const DEK = suiteDOctets(0x20, 32);
const KEKS = Object.freeze({
  A: suiteDOctets(0x80, 32),
  B: suiteDOctets(0xa0, 32),
  C: suiteDOctets(0xc0, 32),
  D: suiteDOctets(0x40, 32),
});
const NOMS_DE_KEK = Object.keys(KEKS);

/** Les quatre sinistres de `vm-enveloppe-coupures.test.mjs`, repris tels quels. */
const SINISTRES = Object.freeze([
  { nom: "coupure-avant", armer: (rang) => ({ couperAvant: rang }) },
  { nom: "coupure-apres", armer: (rang) => ({ couperApres: rang }) },
  { nom: "dechirure-entete", armer: (rang) => ({ dechirerA: rang, octetsDeDechirure: 40 }) },
  { nom: "dechirure-moitie", armer: (rang) => ({ dechirerA: rang }) },
]);

/**
 * Les coupures que la matrice produit RÉELLEMENT, énumérées plutôt que comptées.
 *
 * Quatre sinistres et quatre rangs font SEIZE cellules, et six seulement coupent quelque chose. Ce
 * n'est pas un défaut de la matrice, c'est une conséquence du geste : la migration ne porte que DEUX
 * gestes de support — écrire la page neuve, franchir la barrière —, donc les rangs 3 et 4 n'ont rien
 * à interrompre, et la barrière n'écrit aucun octet qu'une déchirure puisse couper en deux.
 *
 * La revue de la PR #187 (constat 7 de la revue de format) a relevé que l'épreuve se contentait d'un
 * PLANCHER — `produites >= 4` — qui serait resté vert si la couverture tombait de six à quatre. Le
 * plancher est remplacé par cette liste : la matrice doit produire ces six coupures-là, ni plus, ni
 * moins, et un geste ajouté au chemin de migration fera rougir l'épreuve au lieu de passer inaperçu.
 */
const COUPURES_REELLES = Object.freeze([
  "coupure-avant@1",
  "coupure-avant@2",
  "coupure-apres@1",
  "coupure-apres@2",
  "dechirure-entete@1",
  "dechirure-moitie@1",
]);

/** Version que porte la page v1 d'épreuve. Quatre emplacements, comme une enveloppe bien remplie. */
const VERSION_V1 = 7;

/** UN emplacement scellé sous une KEK, par le modèle de référence de l'ADR 0020. */
async function emplacementSousKek(nom, rang) {
  const parametres = suiteDOctets(0xe0 + rang, 8);
  const scelle = await envelopperSousNonce({
    kek: await importerCleDeDeverrouillage(KEKS[nom]),
    emplacement: {
      identifiantVolume: VOLUME,
      identifiantEmplacement: `${rang}${rang}`.repeat(8).slice(0, 16),
      formatVersion: EMPLACEMENT_FORMAT_V1,
      typeKek: TYPES_KEK.harnais,
      parametres,
    },
    dek: DEK,
    nonce: suiteDOctets(0x10 * (rang + 1), 12),
  });
  return {
    identifiantEmplacement: `${rang}${rang}`.repeat(8).slice(0, 16),
    typeKek: TYPES_KEK.harnais,
    parametres,
    nonce: scelle.nonce,
    dekEnveloppee: scelle.chiffre,
    etiquette: scelle.etiquette,
  };
}

/** Un fichier d'enveloppe portant une page **v1** à quatre emplacements en page 0. */
async function fichierV1() {
  const emplacements = [];
  for (const [rang, nom] of NOMS_DE_KEK.entries()) {
    emplacements.push(await emplacementSousKek(nom, rang));
  }
  const page = await composerPageAlaMain({
    identifiantVolume: VOLUME,
    version: VERSION_V1,
    dek: DEK,
    emplacements,
    nonce: suiteDOctets(0x99, 12),
    formatVersion: ENVELOPPE_FORMAT_V1,
  });
  const fichier = new Uint8Array(TAILLE_FICHIER_ENVELOPPE);
  fichier.set(page, 0);
  return { fichier, emplacements };
}

/**
 * L'ÉTAT d'un fichier sous une clé, SANS déclencher de migration.
 *
 * `ouvrirEnveloppe` migre ; c'est son travail, et ce serait un juge qui change ce qu'il mesure. Le
 * juge passe donc par `lireEtat`, qui lit et classe sans jamais écrire.
 */
async function etatSansMigration(octets, kek) {
  const support = supportDouble({ octets });
  try {
    const etat = await lireEtat({
      support,
      identifiantVolume: VOLUME,
      kek: await importerCleDeDeverrouillage(kek),
    });
    return {
      ouvre: true,
      version: etat.version,
      formatVersion: etat.page.formatVersion,
      emplacements: etat.page.emplacements.map((e) => e.identifiantEmplacement),
      code: null,
    };
  } catch (cause) {
    if (!isEnveloppeError(cause)) throw cause;
    return {
      ouvre: false,
      version: null,
      formatVersion: null,
      emplacements: null,
      code: cause.code,
    };
  }
}

/** Ouvre sous KEK_A avec la coupure armée, et rend ce que le support porte après. */
async function couperLaMigration({ octets, rang, sinistre }) {
  const support = supportDouble({ octets, ...sinistre.armer(rang) });
  let migration;
  try {
    migration = (await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: KEKS.A }))
      .migration;
  } catch (cause) {
    // Une coupure pendant la LECTURE initiale, s'il en existait une, remonterait telle quelle : elle
    // n'a rien écrit, et la traiter comme un refus de migration masquerait un geste non compté.
    if (!(cause instanceof CoupureSimulee)) throw cause;
    return { coupee: true, migration: null, octets: support.contenu };
  }
  return { coupee: migration !== null && !migration.faite, migration, octets: support.contenu };
}

test("le geste de MIGRATION porte exactement DEUX écritures, et elles sont mesurées", async () => {
  // Le nombre de gestes borne la matrice : sans lui, les rangs seraient une convention que le
  // premier remaniement démentirait en silence. DEUX, et pas quatre : la page v1 n'est PAS effacée,
  // et c'est elle qui fait la sûreté du geste.
  const { fichier } = await fichierV1();
  const support = supportDouble({ octets: fichier });
  const ouverte = await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: KEKS.A });

  assert.equal(ouverte.migration.faite, true);
  assert.equal(
    support.gestes,
    2,
    "écrire la page neuve, puis la barrière qui publie — rien de plus",
  );

  const pages = [0, 1].map((index) =>
    decoderPage(support.contenu.subarray(offsetDePage(index), offsetDePage(index) + PAGE_OCTETS)),
  );
  assert.deepEqual(
    pages.map((lue) => (lue.valide ? lue.page.formatVersion : null)),
    [ENVELOPPE_FORMAT_V1, ENVELOPPE_FORMAT_V2],
    "la v1 est CONSERVÉE en page 0 ; la v2 est publiée sur la page libre",
  );
});

test("MIGRER : à CHAQUE rang, les QUATRE clés ouvrent, et l'état est v1@N ou v2@N+1", async () => {
  const { fichier, emplacements } = await fichierV1();
  const attendus = emplacements.map((e) => e.identifiantEmplacement);
  const produites = [];

  for (const sinistre of SINISTRES) {
    for (let rang = 1; rang <= 4; rang += 1) {
      const { coupee, octets } = await couperLaMigration({ octets: fichier, rang, sinistre });
      if (!coupee) continue;
      produites.push(`${sinistre.nom}@${rang}`);

      const etats = [];
      for (const nom of NOMS_DE_KEK) etats.push(await etatSansMigration(octets, KEKS[nom]));

      for (const [index, etat] of etats.entries()) {
        assert.ok(
          etat.ouvre,
          `${sinistre.nom}@${rang} : la clé ${NOMS_DE_KEK[index]} n'ouvre plus (${etat.code})`,
        );
        assert.deepEqual(
          etat.emplacements,
          attendus,
          `${sinistre.nom}@${rang} : la liste a bougé sous la clé ${NOMS_DE_KEK[index]}`,
        );
      }

      const classes = new Set(etats.map((etat) => `v${etat.formatVersion}@${etat.version}`));
      assert.equal(
        classes.size,
        1,
        `${sinistre.nom}@${rang} : les clés ne voient pas le même état (${[...classes].join(", ")})`,
      );
      const [classe] = classes;
      assert.ok(
        classe === `v${ENVELOPPE_FORMAT_V1}@${VERSION_V1}` ||
          classe === `v${ENVELOPPE_FORMAT_V2}@${VERSION_V1 + 1}`,
        `${sinistre.nom}@${rang} : état inattendu ${classe}`,
      );
    }
  }
  assert.deepEqual(
    produites,
    [...COUPURES_REELLES],
    "la matrice doit produire EXACTEMENT ces six coupures : un plancher laisserait la couverture baisser en silence",
  );
});

/** Le fichier tel qu'une migration RÉUSSIE le laisse : `v1@7` en page 0, `v2@8` en page 1. */
async function fichierApresMigration() {
  const { fichier, emplacements } = await fichierV1();
  const support = supportDouble({ octets: fichier });
  const ouverte = await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: KEKS.A });
  assert.equal(ouverte.migration.faite, true);
  return { octets: support.contenu, emplacements };
}

/** Les octets de la page de rang `index`, en vue, modifiables en place. */
function pageDe(octets, index) {
  return octets.subarray(offsetDePage(index), offsetDePage(index) + PAGE_OCTETS);
}

/** Copie le fichier, applique `retoucher` à la copie, et rend la copie. */
function retouche(octets, retoucher) {
  const copie = octets.slice();
  retoucher(copie);
  return copie;
}

test("APRÈS la migration, à tout instant UNE page reste ouvrable — sept altérations", async () => {
  // **Le constat 7 de la revue de format**, seconde moitié : la matrice de coupure éprouve le geste
  // PENDANT qu'il s'écrit, et rien n'éprouvait ce qui vient après. Un fichier migré porte deux pages
  // de formats ET de versions différents, et c'est exactement la situation où un choix d'autorité se
  // trompe sans bruit : une page forgée plus récente que l'autre, un octet changé dans un champ que
  // l'étiquette n'authentifie pas, une page effacée.
  //
  // Les altérations sont celles que le relecteur a jouées, rejouées telles quelles. L'invariant est
  // UN, et il est le même partout : sous CHACUNE des quatre clés, il reste une page ouvrable, c'est
  // celle que le tableau nomme, et la liste des emplacements n'a bougé d'aucun identifiant.
  //
  // Les deux cas restants du relecteur vivent dans les deux épreuves suivantes, parce qu'ils
  // mesurent autre chose qu'une autorité : ce que le décodeur DIT d'un domaine inconnu, et ce que la
  // mutation suivante fait de la page v1.
  const { octets: migre, emplacements } = await fichierApresMigration();
  const attendus = emplacements.map((e) => e.identifiantEmplacement);

  // Une v1 FORGÉE par qui détient la DEK : la racine y est réellement scellée sur la version
  // annoncée, donc rien ne la distingue d'une page légitime sinon sa version. C'est la forme forte
  // de l'attaque — une v1 dont l'étiquette échouerait ne prouverait que le scellement.
  const v1Forgee = async (version) =>
    await composerPageAlaMain({
      identifiantVolume: VOLUME,
      version,
      dek: DEK,
      emplacements,
      nonce: suiteDOctets(0x77, 12),
      formatVersion: ENVELOPPE_FORMAT_V1,
    });
  const V1_A_999 = await v1Forgee(999);
  const V1_A_8 = await v1Forgee(VERSION_V1 + 1);

  const LA_V2 = `v${ENVELOPPE_FORMAT_V2}@${VERSION_V1 + 1}`;
  const LA_V1 = `v${ENVELOPPE_FORMAT_V1}@${VERSION_V1}`;
  const CAS = [
    {
      nom: "la page v1 est EFFACÉE à côté d'une v2 valide",
      octets: retouche(migre, (copie) => pageDe(copie, 0).fill(0)),
      attendu: LA_V2,
    },
    {
      nom: "une v1 FORGÉE à la version 999 réclame l'autorité",
      octets: retouche(migre, (copie) => copie.set(V1_A_999, offsetDePage(0))),
      attendu: LA_V2,
    },
    {
      nom: "une v1 forgée à la version 8 — ÉGALITÉ, pas infériorité",
      octets: retouche(migre, (copie) => copie.set(V1_A_8, offsetDePage(0))),
      attendu: LA_V2,
    },
    {
      nom: "un octet de l'ÉTIQUETTE de racine de la v2 est changé",
      octets: retouche(migre, (copie) => {
        pageDe(copie, 1)[88] ^= 0x01;
      }),
      attendu: LA_V1,
    },
    {
      nom: "le SEL de la v2 est changé d'un bit",
      octets: retouche(migre, (copie) => {
        pageDe(copie, 1)[104] ^= 0x01;
      }),
      attendu: LA_V1,
    },
    {
      nom: "l'octet de domaine de la v2 passe à 2 (`recuperation`) sur une page `enveloppe`",
      octets: retouche(migre, (copie) => {
        pageDe(copie, 1)[DOMAINE_OFFSET] = 2;
      }),
      attendu: LA_V1,
    },
    {
      nom: "l'octet de domaine de la v2 passe à 9, qui ne désigne AUCUN domaine",
      octets: retouche(migre, (copie) => {
        pageDe(copie, 1)[DOMAINE_OFFSET] = 9;
      }),
      attendu: LA_V1,
    },
  ];

  for (const cas of CAS) {
    const classes = new Set();
    for (const nom of NOMS_DE_KEK) {
      const etat = await etatSansMigration(cas.octets, KEKS[nom]);
      assert.ok(etat.ouvre, `${cas.nom} : la clé ${nom} n'ouvre plus rien (${etat.code})`);
      assert.deepEqual(etat.emplacements, attendus, `${cas.nom} : la liste a bougé sous ${nom}`);
      classes.add(`v${etat.formatVersion}@${etat.version}`);
    }
    assert.deepEqual([...classes], [cas.attendu], `${cas.nom} : ce n'est pas la page attendue`);
  }
});

test("le domaine inconnu est REFUSÉ en le NOMMANT, et le sel est couvert par la somme", async () => {
  // Le relecteur note, sans en faire un constat, que le sel et l'octet de domaine ne sont pas
  // AUTHENTIFIÉS — le § 6.11 le dit — mais qu'ils sont COUVERTS par la somme de contrôle de la page.
  // Les deux refus ne se ressemblent donc pas, et l'ORDRE que le § annonce est vérifiable : le
  // domaine est jugé AVANT la somme, et c'est pourquoi un domaine inconnu se refuse en se nommant
  // là où un sel altéré se refuse en somme.
  const { octets: migre } = await fichierApresMigration();

  const domaineInconnu = decoderPage(
    retouche(migre, (copie) => {
      pageDe(copie, 1)[DOMAINE_OFFSET] = 9;
    }).subarray(offsetDePage(1), offsetDePage(1) + PAGE_OCTETS),
  );
  assert.equal(domaineInconnu.valide, false, "une page de domaine inconnu n'est pas une page");
  assert.match(String(domaineInconnu.raison), /9/, "le refus NOMME la valeur qu'il a lue");

  const selAltere = decoderPage(
    retouche(migre, (copie) => {
      pageDe(copie, 1)[104] ^= 0x01;
    }).subarray(offsetDePage(1), offsetDePage(1) + PAGE_OCTETS),
  );
  assert.equal(
    selAltere.valide,
    false,
    "le sel entre dans l'assiette de la somme, donc un bit compte",
  );
  assert.match(
    String(selAltere.raison),
    /[Ss]omme/,
    "et c'est la SOMME qui le refuse, pas le domaine",
  );
});

test("une page v2 DÉCHIRÉE laisse l'autorité à la page v1, et la seconde tentative aboutit", async () => {
  // « Une page v1 reste lisible tant que la v2 n'est pas écrite ET relue » : voici le rang où cela
  // se joue, puis la reprise. Rien n'est à refaire du côté de l'utilisateur — il rouvre son coffre.
  //
  // Le sinistre choisi est la DÉCHIRURE DANS L'EN-TÊTE, et le choix a une raison : le double tient
  // ses octets en mémoire, si bien qu'une « coupure avant la barrière » y laisse une page COMPLÈTE
  // mais non durable — état qu'il ne sait pas distinguer d'une page publiée. La déchirure, elle,
  // laisse des octets réellement partiels, ce que la somme de contrôle de la page écarte. C'est donc
  // le seul des quatre sinistres qui produise ici un v2 INVALIDE, et c'est celui qu'il faut.
  const { fichier } = await fichierV1();
  const coupe = await couperLaMigration({
    octets: fichier,
    rang: 1,
    sinistre: SINISTRES[2],
  });
  assert.equal(coupe.coupee, true, "la déchirure de la page neuve doit avoir lieu");
  assert.equal(coupe.migration.faite, false);
  assert.equal(coupe.migration.refus, "CoupureSimulee", "le refus est RENDU, jamais avalé");

  const avant = await etatSansMigration(coupe.octets, KEKS.D);
  assert.deepEqual(
    { formatVersion: avant.formatVersion, version: avant.version },
    { formatVersion: ENVELOPPE_FORMAT_V1, version: VERSION_V1 },
    "avant la barrière, l'autorité est la page v1",
  );

  const support = supportDouble({ octets: coupe.octets });
  const reprise = await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: KEKS.A });
  assert.equal(reprise.migration.faite, true, "la seconde tentative aboutit");
  assert.equal(reprise.version, VERSION_V1 + 1);

  const apres = await etatSansMigration(support.contenu, KEKS.D);
  assert.deepEqual(
    { formatVersion: apres.formatVersion, version: apres.version },
    { formatVersion: ENVELOPPE_FORMAT_V2, version: VERSION_V1 + 1 },
    "et toutes les clés voient la page v2",
  );
});

test("la migration ne demande AUCUNE clé de déverrouillage : elle recopie la liste", async () => {
  // La propriété qui rend le geste possible : les données associées d'un emplacement portent une
  // version de format d'EMPLACEMENT, qui vaut 1 et ne suit pas celle de la page. Sans elle, migrer
  // exigerait de réenvelopper la DEK sous chacune des huit clés — c'est-à-dire de les détenir.
  const { fichier, emplacements } = await fichierV1();
  const support = supportDouble({ octets: fichier });
  await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: KEKS.A });

  const migree = decoderPage(
    support.contenu.subarray(offsetDePage(1), offsetDePage(1) + PAGE_OCTETS),
  ).page;
  assert.equal(migree.formatVersion, ENVELOPPE_FORMAT_V2);
  for (const [rang, attendu] of emplacements.entries()) {
    assert.deepEqual(
      {
        identifiantEmplacement: migree.emplacements[rang].identifiantEmplacement,
        nonce: Array.from(migree.emplacements[rang].nonce),
        dekEnveloppee: Array.from(migree.emplacements[rang].dekEnveloppee),
        etiquette: Array.from(migree.emplacements[rang].etiquette),
      },
      {
        identifiantEmplacement: attendu.identifiantEmplacement,
        nonce: Array.from(attendu.nonce),
        dekEnveloppee: Array.from(attendu.dekEnveloppee),
        etiquette: Array.from(attendu.etiquette),
      },
      `l'emplacement ${rang} a été rescellé alors qu'il devait être recopié`,
    );
  }
});

test("la page v2 PORTE son sel en clair, et deux migrations n'ont pas le même", async () => {
  // Le régime à usage unique de l'ADR 0033, décision 3, sur le seul artefact où il se voit : deux
  // pages du même volume, sous la même DEK, ne partagent pas leur clé de racine.
  const { fichier } = await fichierV1();
  const sels = [];
  for (let essai = 0; essai < 2; essai += 1) {
    const support = supportDouble({ octets: fichier });
    await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: KEKS.A });
    const page = decoderPage(
      support.contenu.subarray(offsetDePage(1), offsetDePage(1) + PAGE_OCTETS),
    ).page;
    assert.equal(
      page.sel.byteLength,
      32,
      "le sel fait trente-deux octets, en clair dans l'en-tête",
    );
    sels.push(Array.from(page.sel).join(","));
  }
  assert.notEqual(sels[0], sels[1], "un sel constant rendrait la clé de racine constante");
});

test("RÉTROGRADATION : une page v1 forgée à une version haute ne reprend PAS l'autorité", async () => {
  // Qui peut écrire dans l'origine peut composer une page v1 portant n'importe quelle version et en
  // recalculer la somme. Sans refus, elle passerait devant la v2 et l'ouverture se ferait sous une
  // racine scellée directement sous la DEK : un format rétrogradé par une écriture, sans décision.
  const { fichier, emplacements } = await fichierV1();
  const support = supportDouble({ octets: fichier });
  await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: KEKS.A });
  const migre = support.contenu;

  const forgee = await composerPageAlaMain({
    identifiantVolume: VOLUME,
    version: VERSION_V1 + 1000,
    dek: DEK,
    emplacements,
    nonce: suiteDOctets(0x77, 12),
    formatVersion: ENVELOPPE_FORMAT_V1,
  });
  // La page v1 forgée remplace la v1 d'origine : le fichier porte donc une v1 « plus récente » que
  // la v2, ce qui est exactement l'état que la règle doit refuser.
  const attaque = Uint8Array.from(migre);
  attaque.set(forgee, offsetDePage(0));

  const etat = await etatSansMigration(attaque, KEKS.A);
  assert.deepEqual(
    { formatVersion: etat.formatVersion, version: etat.version },
    { formatVersion: ENVELOPPE_FORMAT_V2, version: VERSION_V1 + 1 },
    "la page v2 garde l'autorité, quelle que soit la version que la v1 s'attribue",
  );

  // Et le TÉMOIN POSITIF, sans lequel le refus ne prouverait rien : la même page forgée, SEULE dans
  // le fichier, s'ouvre parfaitement. Ce qui est refusé est la rétrogradation, pas la page v1.
  const seule = new Uint8Array(TAILLE_FICHIER_ENVELOPPE);
  seule.set(forgee, 0);
  const isolee = await etatSansMigration(seule, KEKS.A);
  assert.deepEqual(
    { formatVersion: isolee.formatVersion, version: isolee.version },
    { formatVersion: ENVELOPPE_FORMAT_V1, version: VERSION_V1 + 1000 },
  );
});

test("après la migration, une MUTATION efface la dernière page v1 du fichier", async () => {
  // Le repli que la migration laisse derrière elle n'est pas éternel : la mutation suivante écrit
  // sur la page libre, c'est-à-dire sur elle. Aucun geste n'est ajouté pour cela — en ajouter un
  // retirerait au rang 2 de la matrice le repli qui fait toute la sûreté du geste.
  //
  // C'est aussi le dernier des cas ajoutés par la revue de la PR #187 (constat 7 de la revue de
  // format). Plutôt qu'une épreuve jumelle, il RENFORCE celle-ci : les VERSIONS des deux pages sont
  // désormais nommées — v2@9 par-dessus v2@8 —, et le coffre est rouvert après coup pour constater
  // qu'il porte bien ses cinq emplacements. Une paire de pages « toutes deux en v2 » resterait vraie
  // si la mutation avait écrasé la mauvaise des deux.
  const { fichier } = await fichierV1();
  const support = supportDouble({ octets: fichier });
  await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: KEKS.A });

  await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: KEKS.A,
    kekNouvelle: suiteDOctets(0x55, 32),
  });

  const etats = [];
  for (let index = 0; index < PAGES; index += 1) {
    const lue = decoderPage(
      support.contenu.subarray(offsetDePage(index), offsetDePage(index) + PAGE_OCTETS),
    );
    etats.push(lue.valide ? `v${lue.page.formatVersion}@${lue.page.version}` : null);
  }
  assert.deepEqual(
    etats,
    [`v${ENVELOPPE_FORMAT_V2}@${VERSION_V1 + 2}`, `v${ENVELOPPE_FORMAT_V2}@${VERSION_V1 + 1}`],
    "les deux pages sont en v2 : plus aucune racine du fichier n'est scellée sous la DEK",
  );

  const etat = await etatSansMigration(support.contenu, KEKS.A);
  assert.equal(etat.ouvre, true);
  assert.equal(etat.emplacements.length, 5, "cinq emplacements, et le coffre s'ouvre toujours");
});

test("une page v2 dont le DOMAINE est retouché est REFUSÉE, et la page v1 la couvre", async () => {
  // Le domaine n'est pas authentifié, comme le sel, et il se protège par sa CONSÉQUENCE : le
  // retoucher fait dériver une autre clé, donc échouer l'étiquette. Ce qui compte est que le refus
  // n'emporte pas le volume avec lui — la page v1 conservée reste ouvrable.
  const { fichier } = await fichierV1();
  const support = supportDouble({ octets: fichier });
  await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: KEKS.A });

  const octets = support.contenu;
  const page = octets.subarray(offsetDePage(1), offsetDePage(1) + PAGE_OCTETS);
  const lue = decoderPage(page).page;
  const retouchee = encoderPage({
    identifiantVolume: VOLUME,
    version: lue.version,
    formatVersion: ENVELOPPE_FORMAT_V2,
    racine: lue.racine,
    sel: lue.sel,
    domaine: 2,
    emplacements: lue.emplacements,
  });
  octets.set(retouchee, offsetDePage(1));

  const etat = await etatSansMigration(octets, KEKS.A);
  assert.deepEqual(
    { formatVersion: etat.formatVersion, version: etat.version },
    { formatVersion: ENVELOPPE_FORMAT_V1, version: VERSION_V1 },
    "le volume reste ouvrable par sa page v1 : une racine refusée est un repli, pas une perte",
  );
});

test("REVOQUER après migration : une révocation efface bien la page libérée, v1 comprise", async () => {
  // La migration ne change pas la conduite des mutations qui RETIRENT une clé : la page libérée est
  // effacée après la barrière (ADR 0026). L'éprouver ici évite qu'un repli de migration devienne, par
  // inadvertance, un point de reprise vers un état où la clé révoquée ouvre encore.
  const { fichier, emplacements } = await fichierV1();
  const support = supportDouble({ octets: fichier });
  await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek: KEKS.A });

  await revoquerEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: KEKS.A,
    identifiantEmplacement: emplacements[3].identifiantEmplacement,
  });

  const revoquee = await etatSansMigration(support.contenu, KEKS.D);
  assert.equal(revoquee.ouvre, false, "la clé révoquée n'ouvre plus, par aucune page");
  assert.equal(revoquee.code, ENVELOPPE_ERROR_CODES.cleRefusee);
  const conservee = await etatSansMigration(support.contenu, KEKS.A);
  assert.equal(conservee.ouvre, true, "et la clé conservée ouvre toujours");
});
