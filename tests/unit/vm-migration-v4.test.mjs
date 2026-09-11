// CONVERSION d'un volume v3 en volume v4, sur place (#182, ADR 0033, décision 5).
//
// C'est le geste le plus lourd que ce dépôt ait tenté : chaque secteur est RESCELLÉ, parce qu'aucune
// clé ne traverse une version de format. La géométrie, elle, ne bouge pas — il n'y a donc rien à
// déplacer, contrairement à v2 → v3.
//
// ## Ce que ces épreuves mesurent, et pourquoi la coupure est le sujet
//
// En v2 → v3, l'un des deux états d'un secteur — le clair — se rescellait à l'infini. Ici les deux
// états sont des chiffrés sous deux clés différentes, et le sceau et la charge doivent changer
// ENSEMBLE : aucun ordre d'écriture ne suffit à lui seul, et c'est l'ÉCRITURE ANTICIPÉE des sceaux
// v3 dans le journal qui rend la suite en vol rattrapable.
//
// Les épreuves coupent donc à CHAQUE écriture, une par une, et exigent à chaque fois la même chose :
// que la reprise aboutisse et que le volume converti rende, secteur par secteur, EXACTEMENT le clair
// que le v3 portait. Une reprise qui « marche » sans rendre les mêmes octets n'a rien réparé.

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { Scellement, RANG_SECTEUR_DE_VOLUME } from "../../src/vm/scellement.mjs";
import { ETAPES_V4, convertirEnV4 } from "../../src/vm/migration-v4.mjs";
import { MIGRATION_ERROR_CODES } from "../../src/vm/migration-errors.mjs";
import {
  FORMAT_VOLUME_V3,
  FORMAT_VOLUME_V4,
  SCEAU_OCTETS,
  decoderEnTeteV4,
  decoderSceau,
  dispositionDuVolume,
  encoderEnTeteV3,
  encoderSceau,
  identifiantVolumeEnTexte,
  offsetDeCharge,
  offsetDeSceau,
} from "../../src/vm/volume-chiffre-format.mjs";

const TAILLE_LOGIQUE = 16 * SECTOR_SIZE;
/** Lot réduit : sur seize secteurs, quatre suites donnent des points de coupure qu'on peut nommer. */
const SECTEURS_PAR_TOUR = 4;
const IDENTIFIANT = "0123456789abcdef0123456789abcdef";
/** Génération sous laquelle le volume v3 d'épreuve a été scellé. Elle doit SURVIVRE à la conversion. */
const GENERATION = 5;

/** Contenu logique déterministe : chaque secteur porte un motif qui le nomme. */
function clairDuVolume() {
  const octets = new Uint8Array(TAILLE_LOGIQUE);
  for (let secteur = 0; secteur * SECTOR_SIZE < TAILLE_LOGIQUE; secteur += 1) {
    for (let index = 0; index < SECTOR_SIZE; index += 1) {
      octets[secteur * SECTOR_SIZE + index] = (index * 11 + secteur * 37 + 5) % 256;
    }
  }
  return octets;
}

/**
 * Support BRUT en mémoire, à la forme de `opfs-volume-brut.mjs`.
 *
 * `armerCoupure` fait jeter la N-ième écriture : le support garde exactement ce qui a été écrit
 * avant. C'est ce qu'une mort d'onglet laisse, et le seul moyen d'éprouver une reprise sur un état
 * réellement atteignable.
 */
function supportBrut(initial) {
  const etat = { octets: Uint8Array.from(initial), ecritures: 0, couperApres: null };
  return {
    get octets() {
      return etat.octets;
    },
    get ecritures() {
      return etat.ecritures;
    },
    armerCoupure(apres) {
      etat.couperApres = apres;
      etat.ecritures = 0;
    },
    name: "migre-v4",
    size: () => etat.octets.byteLength,
    async read(offset, longueur) {
      return etat.octets.slice(offset, offset + longueur);
    },
    async write(offset, source) {
      etat.ecritures += 1;
      if (etat.couperApres !== null && etat.ecritures > etat.couperApres) {
        throw new Error("coupure programmée");
      }
      etat.octets.set(source, offset);
    },
    async flush() {},
  };
}

function scellementV3() {
  return Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V3,
  });
}

function scellementV4() {
  return Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: FORMAT_VOLUME_V4,
  });
}

/** FABRIQUE un volume v3 complet : en-tête v3, région scellée, charge chiffrée sous la DEK. */
async function volumeV3() {
  const disposition = dispositionDuVolume(TAILLE_LOGIQUE);
  const fichier = new Uint8Array(disposition.tailleSupport);
  fichier.set(
    encoderEnTeteV3({
      tailleLogique: TAILLE_LOGIQUE,
      identifiantVolume: IDENTIFIANT,
      scellementComplet: true,
    }),
    0,
  );
  const clair = clairDuVolume();
  const scellement = await scellementV3();
  for (let adresse = 0; adresse < TAILLE_LOGIQUE; adresse += SECTOR_SIZE) {
    const scelle = await scellement.scellerBloc(
      {
        generation: GENERATION,
        rang: RANG_SECTEUR_DE_VOLUME,
        adresse,
        longueur: SECTOR_SIZE,
      },
      clair.subarray(adresse, adresse + SECTOR_SIZE),
    );
    fichier.set(scelle.chiffre, offsetDeCharge(disposition, adresse));
    fichier.set(
      encoderSceau({
        nonce: scelle.nonce,
        etiquette: scelle.etiquette,
        generation: GENERATION,
      }),
      offsetDeSceau(disposition, adresse),
    );
  }
  return { fichier, clair, disposition };
}

/**
 * RELIT un volume converti sous la clé v4, secteur par secteur, et rend le clair obtenu.
 *
 * C'est la seule vérification qui compte : une conversion qui « aboutit » sans rendre les mêmes
 * octets n'a rien converti, elle a détruit.
 */
async function relireEnV4(brut, disposition) {
  const scellement = await scellementV4();
  const rendu = new Uint8Array(disposition.tailleLogique);
  for (let adresse = 0; adresse < disposition.tailleLogique; adresse += SECTOR_SIZE) {
    const sceau = decoderSceau(await brut.read(offsetDeSceau(disposition, adresse), SCEAU_OCTETS));
    const clair = await scellement.ouvrirBloc(
      {
        generation: sceau.generation,
        rang: RANG_SECTEUR_DE_VOLUME,
        adresse,
        longueur: SECTOR_SIZE,
      },
      {
        nonce: sceau.nonce,
        etiquette: sceau.etiquette,
        chiffre: await brut.read(offsetDeCharge(disposition, adresse), SECTOR_SIZE),
      },
    );
    rendu.set(clair, adresse);
  }
  return rendu;
}

/** Un JOURNAL de migration en mémoire : il retient le dernier avancement, comme le vrai. */
function journal() {
  const etat = { avancement: null, ecritures: 0 };
  return {
    get avancement() {
      return etat.avancement;
    },
    get ecritures() {
      return etat.ecritures;
    },
    marquerEtape: async (progress) => {
      etat.ecritures += 1;
      etat.avancement = progress;
    },
  };
}

async function convertir(brut, suivi, options = {}) {
  return convertirEnV4({
    brut,
    scellementV3: await scellementV3(),
    scellementV4: await scellementV4(),
    tailleLogique: TAILLE_LOGIQUE,
    identifiantVolume: IDENTIFIANT,
    marquerEtape: suivi.marquerEtape,
    secteursParTour: SECTEURS_PAR_TOUR,
    ...options,
  });
}

test("la conversion rescelle chaque secteur et rend, octet pour octet, ce que le v3 portait", async () => {
  const { fichier, clair, disposition } = await volumeV3();
  const brut = supportBrut(fichier);
  const suivi = journal();

  const compte = await convertir(brut, suivi);

  assert.equal(compte.secteursRescelles, TAILLE_LOGIQUE / SECTOR_SIZE);
  assert.equal(compte.secteursDejaConvertis, 0);
  assert.equal(compte.tailleSupport, disposition.tailleSupport);
  assert.deepEqual(await relireEnV4(brut, disposition), clair);

  // L'EN-TÊTE est v4, marque comprise, et il est le DERNIER geste.
  const enTete = decoderEnTeteV4(await brut.read(0, 512));
  assert.equal(enTete.valide, true, enTete.raison ?? "");
  assert.equal(enTete.enTete.formatVersion, FORMAT_VOLUME_V4);
  assert.equal(enTete.enTete.scellementComplet, true);
  assert.equal(identifiantVolumeEnTexte(enTete.enTete.identifiantVolume), IDENTIFIANT);
  assert.equal(suivi.avancement.etape, ETAPES_V4.enTete);
});

test("la GÉNÉRATION de chaque secteur SURVIT à la conversion : la clé change, l'histoire non", async () => {
  const { fichier, disposition } = await volumeV3();
  const brut = supportBrut(fichier);
  await convertir(brut, journal());

  for (let adresse = 0; adresse < TAILLE_LOGIQUE; adresse += SECTOR_SIZE) {
    const sceau = decoderSceau(await brut.read(offsetDeSceau(disposition, adresse), SCEAU_OCTETS));
    assert.equal(sceau.generation, GENERATION, `secteur ${adresse}`);
  }
});

test("un volume converti ne s'ouvre PLUS sous la clé v3 : aucune clé ne traverse une version", async () => {
  const { fichier, disposition } = await volumeV3();
  const brut = supportBrut(fichier);
  await convertir(brut, journal());

  const v3 = await scellementV3();
  const sceau = decoderSceau(await brut.read(offsetDeSceau(disposition, 0), SCEAU_OCTETS));
  const chiffre = await brut.read(offsetDeCharge(disposition, 0), SECTOR_SIZE);
  await assert.rejects(() =>
    v3.ouvrirBloc(
      { generation: sceau.generation, rang: RANG_SECTEUR_DE_VOLUME, adresse: 0, longueur: 512 },
      { nonce: sceau.nonce, etiquette: sceau.etiquette, chiffre },
    ),
  );
});

test("COUPURE à chaque écriture : la reprise aboutit, et le volume rend les MÊMES octets", async () => {
  const { fichier, clair, disposition } = await volumeV3();

  // Une première conversion complète donne le nombre d'écritures à couvrir. La borne est MESURÉE,
  // pas supposée : la supposer laisserait un rang non couvert le jour où la conversion en gagne un.
  const temoin = supportBrut(fichier);
  await convertir(temoin, journal());
  const ecrituresTotales = temoin.ecritures;
  assert.ok(ecrituresTotales >= 8, `la conversion écrit ${ecrituresTotales} fois`);

  // `armerCoupure(n)` fait jeter la (n+1)-ième écriture : couvrir les écritures 1 à N demande donc
  // d'armer 0 à N−1. Aucune n'est sautée, et c'est le sujet de cette épreuve.
  for (let coupure = 0; coupure < ecrituresTotales; coupure += 1) {
    const brut = supportBrut(fichier);
    const suivi = journal();
    brut.armerCoupure(coupure);

    await assert.rejects(
      () => convertir(brut, suivi),
      /coupure programmée/,
      `l'écriture ${coupure + 1} doit être coupée`,
    );

    // REPRISE : elle ne reçoit du monde que le journal — l'étape, la position, et l'écriture
    // anticipée de la suite qui était en vol.
    brut.armerCoupure(null);
    const avancement = suivi.avancement;
    await convertir(brut, journal(), {
      depuis: avancement.etape,
      position: avancement.position,
      tampon: avancement.tampon ?? null,
    });

    assert.deepEqual(
      await relireEnV4(brut, disposition),
      clair,
      `après coupure de l'écriture ${coupure + 1}, le volume converti ne rend pas ce que le v3 portait`,
    );
    const enTete = decoderEnTeteV4(await brut.read(0, 512));
    assert.equal(
      enTete.valide,
      true,
      `après coupure de l'écriture ${coupure + 1} : ${enTete.raison ?? ""}`,
    );
  }
});

test("COUPURE du JOURNAL à chaque inscription : ce qu'il porte encore suffit toujours", async () => {
  const { fichier, clair, disposition } = await volumeV3();

  const temoin = journal();
  await convertir(supportBrut(fichier), temoin);
  const inscriptions = temoin.ecritures;
  assert.ok(inscriptions >= 8, `la conversion inscrit ${inscriptions} avancements`);

  // Une coupure du JOURNAL est l'autre moitié du contrat, et elle est distincte : le volume, lui,
  // est intact jusqu'à l'écriture qui suit. Ce que la reprise reçoit est donc l'avancement
  // PRÉCÉDENT — celui que le journal portait encore —, et il doit suffire.
  for (let coupure = 0; coupure < inscriptions; coupure += 1) {
    const brut = supportBrut(fichier);
    let vues = 0;
    let dernier = null;
    const suivi = {
      marquerEtape: async (progress) => {
        if (vues === coupure) throw new Error("coupure du journal");
        vues += 1;
        dernier = progress;
      },
    };
    await assert.rejects(
      () => convertir(brut, suivi),
      /coupure du journal/,
      `l'inscription ${coupure + 1} doit être coupée`,
    );

    await convertir(brut, journal(), {
      depuis: dernier?.etape ?? ETAPES_V4.rescellement,
      position: dernier?.position ?? null,
      tampon: dernier?.tampon ?? null,
    });
    assert.deepEqual(
      await relireEnV4(brut, disposition),
      clair,
      `après coupure du journal à l'inscription ${coupure + 1}, le volume ne rend pas ce que le v3 portait`,
    );
  }
});

test("la reprise ne relit PAS le volume entier : elle repart du rang journalisé", async () => {
  const { fichier } = await volumeV3();
  const brut = supportBrut(fichier);
  const suivi = journal();

  // On coupe au milieu : deux suites de quatre secteurs sont passées, la troisième est en vol.
  brut.armerCoupure(5);
  await assert.rejects(() => convertir(brut, suivi));
  const avancement = suivi.avancement;
  assert.equal(avancement.etape, ETAPES_V4.rescellement);
  assert.ok(avancement.position >= SECTEURS_PAR_TOUR, `position ${avancement.position}`);

  brut.armerCoupure(null);
  const compte = await convertir(brut, journal(), {
    depuis: avancement.etape,
    position: avancement.position,
    tampon: avancement.tampon ?? null,
  });

  // Ce que « ne pas relire le volume entier » VEUT DIRE, mesuré : la reprise ne touche que les
  // secteurs au-dessus du rang journalisé. Ceux d'en dessous ne sont ni ouverts, ni rescellés, ni
  // recopiés — et la somme le prouve.
  assert.equal(
    compte.secteursRescelles + compte.secteursDejaConvertis,
    TAILLE_LOGIQUE / SECTOR_SIZE - avancement.position,
    "la reprise a touché des secteurs que le journal déclarait déjà convertis",
  );
});

test("un secteur DÉCHIRÉ est refusé, jamais rescellé au hasard : c'est la sauvegarde ou rien", async () => {
  const { fichier, disposition } = await volumeV3();
  const brut = supportBrut(fichier);
  // Une déchirure DANS la charge : la moitié du secteur porte autre chose. Aucun des trois états ne
  // l'explique, et le rescéller détruirait ce qu'il porte encore.
  const octets = brut.octets;
  octets.fill(
    0xa5,
    offsetDeCharge(disposition, 2 * SECTOR_SIZE),
    offsetDeCharge(disposition, 2 * SECTOR_SIZE) + 64,
  );

  await assert.rejects(
    () => convertir(brut, journal()),
    (cause) => cause.code === MIGRATION_ERROR_CODES.conversionIncoherente,
  );
});

test("un identifiant qui contredit l'en-tête fait REFUSER avant le premier octet écrit", async () => {
  const { fichier } = await volumeV3();
  const brut = supportBrut(fichier);
  const avant = Uint8Array.from(brut.octets);

  const v3 = await scellementV3();
  const v4 = await scellementV4();
  await assert.rejects(
    () =>
      convertirEnV4({
        brut,
        scellementV3: v3,
        scellementV4: v4,
        tailleLogique: TAILLE_LOGIQUE,
        identifiantVolume: "ffffffffffffffffffffffffffffffff",
        marquerEtape: async () => {},
        secteursParTour: SECTEURS_PAR_TOUR,
      }),
    (cause) => cause.code === MIGRATION_ERROR_CODES.conversionIncoherente,
  );
  assert.deepEqual(brut.octets, avant, "un refus d'identifiant n'écrit RIEN");
});

test("la conversion d'un fichier d'une autre taille est refusée : la v4 ne retaille rien", async () => {
  const { fichier } = await volumeV3();
  const brut = supportBrut(fichier.subarray(0, fichier.byteLength - SECTOR_SIZE));
  await assert.rejects(
    () => convertir(brut, journal()),
    (cause) => cause.code === MIGRATION_ERROR_CODES.conversionIncoherente,
  );
});

test("l'écriture anticipée du journal porte les SCEAUX v3 de la suite en vol, et rien d'autre", async () => {
  const { fichier, disposition } = await volumeV3();
  const brut = supportBrut(fichier);
  const sceauxAvant = await brut.read(
    offsetDeSceau(disposition, 0),
    SECTEURS_PAR_TOUR * SCEAU_OCTETS,
  );

  const vus = [];
  await convertir(brut, {
    marquerEtape: async (progress) => {
      if (progress.tampon !== null && progress.tampon !== undefined) vus.push(progress.tampon);
    },
  });

  assert.equal(vus.length, TAILLE_LOGIQUE / SECTOR_SIZE / SECTEURS_PAR_TOUR);
  assert.equal(vus[0].rang, 0);
  assert.equal(vus[0].secteurs, SECTEURS_PAR_TOUR);
  assert.equal(
    vus[0].sceauxV3,
    [...sceauxAvant].map((octet) => octet.toString(16).padStart(2, "0")).join(""),
    "le tampon de la première suite est la région v3 telle qu'elle était avant d'être écrasée",
  );
});
