// CONVERSION d'un volume v2 en volume v3, sur place (#101, ADR 0016, décision 8).
//
// C'est la première migration du dépôt qui touche les OCTETS. Les deux précédentes réécrivaient un
// manifeste ; celle-ci doit agrandir le fichier de sa région d'authentification, décaler la charge
// entière, et sceller chaque secteur. Elle se fait EN PLACE — pas par un fichier voisin — pour ne
// pas exiger le double du quota au moment précis où l'utilisateur migre un volume de 512 Mio.
//
// ## Deux gestes, et leur ordre est le contrat
//
//  1. **DÉPLACER** — la charge v2 est recopiée de `a` vers `chargeOffset + a`, du DERNIER secteur au
//     premier. Il n'est PAS rejouable depuis le début : la zone d'arrivée recouvre la zone de départ
//     dès que `chargeOffset < L`, si bien qu'un second passage relirait des octets déjà déplacés.
//     Cette épreuve l'a montré avant que le module ne parte, et la POSITION atteinte est donc
//     journalisée après chaque tour.
//  2. **SCELLER** — chaque secteur est relu à sa nouvelle place, scellé, réécrit, et son sceau posé
//     dans la région. Ce geste n'est pas idempotent — rescéller un secteur déjà scellé chiffrerait
//     du chiffré — mais il est **reprenable sans compteur** : un secteur déjà converti s'OUVRE, un
//     secteur encore en clair ne s'ouvre pas, et la région est à zéro avant conversion.
//
// **L'ordre est indispensable, et pas seulement souhaitable** : la région d'authentification vit
// dans `[512, chargeOffset)`, c'est-à-dire DANS la zone d'où le déplacement lit. Sceller avant
// d'avoir fini de déplacer détruirait la source du déplacement. C'est pourquoi l'étape franchie est
// inscrite dans le journal de migration : une reprise doit savoir lequel des deux gestes refaire.

import assert from "node:assert/strict";
import test from "node:test";

import { SECTOR_SIZE } from "../../src/vm/block-geometry.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { VolumeChiffre } from "../../src/vm/volume-chiffre.mjs";
import { ETAPES_CONVERSION, convertirEnV3 } from "../../src/vm/migration-v3.mjs";
import {
  decoderEnTeteV3,
  dispositionV3,
  identifiantVolumeEnTexte,
  offsetDeCharge,
} from "../../src/vm/volume-chiffre-format.mjs";

const TAILLE_LOGIQUE = 16 * SECTOR_SIZE;
/**
 * Lot d'E/S RÉDUIT, pour que les coupures tombent au milieu d'un geste et non entre les deux.
 *
 * Le lot de production traite 512 secteurs par tour : sur un volume d'épreuve de seize secteurs, le
 * déplacement tiendrait en UNE écriture, et « couper pendant le déplacement » serait impossible à
 * exprimer. Quatre secteurs par tour donnent quatre écritures de déplacement puis deux par secteur
 * scellé, c'est-à-dire des points de coupure qu'on peut nommer.
 */
const SECTEURS_PAR_TOUR = 4;
const IDENTIFIANT = "0123456789abcdef0123456789abcdef";

/** Contenu déterministe d'un volume v2 : chaque secteur porte un motif qui le nomme. */
function contenuV2() {
  const octets = new Uint8Array(TAILLE_LOGIQUE);
  for (let secteur = 0; secteur * SECTOR_SIZE < TAILLE_LOGIQUE; secteur += 1) {
    for (let index = 0; index < SECTOR_SIZE; index += 1) {
      octets[secteur * SECTOR_SIZE + index] = (index * 7 + secteur * 29 + 3) % 256;
    }
  }
  return octets;
}

/**
 * Support BRUT en mémoire, à la forme de `opfs-volume-brut.mjs`, plus le retaillage.
 *
 * `couperApres` arme une coupure : la N-ième écriture jette, et le support garde exactement ce qui
 * a été écrit avant. C'est ce qu'une mort d'onglet laisse, et c'est le seul moyen d'éprouver une
 * reprise sur un état réellement atteignable.
 */
function supportBrut(initial) {
  const etat = { octets: Uint8Array.from(initial), ecritures: 0, couperApres: null };
  return {
    get octets() {
      return etat.octets;
    },
    /** Écritures acceptées depuis le dernier armement. L'épreuve des coupures s'en sert de borne. */
    get ecritures() {
      return etat.ecritures;
    },
    armerCoupure(apres) {
      etat.couperApres = apres;
      etat.ecritures = 0;
    },
    name: "migre",
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
    async retailler(taille) {
      const neuf = new Uint8Array(taille);
      neuf.set(etat.octets.subarray(0, Math.min(taille, etat.octets.byteLength)));
      etat.octets = neuf;
    },
    async flush() {},
  };
}

function scellement() {
  return Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: 3,
  });
}

/** Relit le volume converti PAR LE CHEMIN DE PRODUCTION, et rend son clair. */
async function relireClair(support) {
  const disposition = dispositionV3(TAILLE_LOGIQUE);
  const volume = new VolumeChiffre({
    volume: "migre",
    scellement: await scellement(),
    disposition,
    lireSupport: (offset, longueur) => support.octets.slice(offset, offset + longueur),
    ecrireSupport: () => {
      throw new Error("la relecture n'écrit pas");
    },
  });
  return volume.lireSecteurs(0, TAILLE_LOGIQUE);
}

test("un volume v2 converti en v3 rend EXACTEMENT le même clair, par le chemin de production", async () => {
  const attendu = contenuV2();
  const support = supportBrut(attendu);

  const rapport = await convertirEnV3({
    brut: support,
    scellement: await scellement(),
    tailleLogique: TAILLE_LOGIQUE,
    identifiantVolume: IDENTIFIANT,
    depuis: ETAPES_CONVERSION.deplacement,
    marquerEtape: async () => {},
    secteursParTour: SECTEURS_PAR_TOUR,
  });

  const disposition = dispositionV3(TAILLE_LOGIQUE);
  assert.equal(support.size(), disposition.tailleSupport, "le fichier a grandi de sa région");
  assert.equal(rapport.secteursScelles, disposition.secteurs);
  assert.deepEqual([...(await relireClair(support))], [...attendu]);
});

test("l'en-tête v3 est écrit, et il décrit le volume qu'on vient de convertir", async () => {
  const support = supportBrut(contenuV2());
  await convertirEnV3({
    brut: support,
    scellement: await scellement(),
    tailleLogique: TAILLE_LOGIQUE,
    identifiantVolume: IDENTIFIANT,
    depuis: ETAPES_CONVERSION.deplacement,
    marquerEtape: async () => {},
  });

  const lu = decoderEnTeteV3(await support.read(0, SECTOR_SIZE));
  assert.equal(lu.valide, true, lu.raison ?? "");
  assert.equal(lu.enTete.tailleLogique, TAILLE_LOGIQUE);
  assert.equal(identifiantVolumeEnTexte(lu.enTete.identifiantVolume), IDENTIFIANT);
  // La MARQUE de scellement complet, sans laquelle l'ouvreur refuserait le volume qu'on vient de
  // migrer par `VAULT_STORAGE_VOLUME_INCOMPLET` — un refus juste pour une création interrompue, et
  // absurde pour une migration achevée. Elle est posée SÉPARÉMENT, en dernier geste : l'en-tête,
  // lui, part dès la fin du déplacement, pour donner à la reprise un second témoin de l'identifiant.
  assert.equal(lu.enTete.scellementComplet, true);
});

test("l'étape franchie est MARQUÉE : une reprise doit savoir lequel des deux gestes refaire", async () => {
  const support = supportBrut(contenuV2());
  const marques = [];
  await convertirEnV3({
    brut: support,
    scellement: await scellement(),
    tailleLogique: TAILLE_LOGIQUE,
    identifiantVolume: IDENTIFIANT,
    depuis: ETAPES_CONVERSION.deplacement,
    marquerEtape: async (etape) => marques.push(etape),
    secteursParTour: SECTEURS_PAR_TOUR,
  });
  // Le déplacement journalise sa position tour par tour, puis l'étape bascule sur « scellement » —
  // et le scellement journalise À SON TOUR sa position, ce qui donne au fail-closed de la reprise
  // la zone que le journal déclare déjà convertie.
  const deplacements = marques.filter((m) => m.etape === ETAPES_CONVERSION.deplacement);
  const scellements = marques.filter((m) => m.etape === ETAPES_CONVERSION.scellement);
  assert.ok(deplacements.length > 1, "chaque tour de déplacement journalise sa position");
  assert.ok(scellements.length > 1, "chaque suite scellée journalise la sienne");
  assert.equal(
    marques.indexOf(scellements[0]),
    deplacements.length,
    "aucun déplacement n'est journalisé après le premier scellement",
  );
  assert.equal(scellements.at(-1).position, TAILLE_LOGIQUE, "la dernière position est la fin");
});

test("une coupure PENDANT le déplacement se reprend à la POSITION journalisée", async () => {
  // Le défaut que cette épreuve a trouvé : rejouer le déplacement depuis le début relit, dans le bas
  // du fichier, des octets DÉJÀ déplacés — la zone d'arrivée recouvre la zone de départ. La reprise
  // repart donc de la position journalisée, et refaire au plus un tour déjà fait reste sûr.
  const attendu = contenuV2();
  const support = supportBrut(attendu);
  const avancement = [];
  const marquerEtape = async (marque) => avancement.push(marque);

  // Trois écritures : le déplacement en fait quatre, donc la coupure tombe DEDANS.
  support.armerCoupure(3);
  const premierScellement = await scellement();
  await assert.rejects(() =>
    convertirEnV3({
      brut: support,
      scellement: premierScellement,
      tailleLogique: TAILLE_LOGIQUE,
      identifiantVolume: IDENTIFIANT,
      depuis: ETAPES_CONVERSION.deplacement,
      marquerEtape,
      secteursParTour: SECTEURS_PAR_TOUR,
    }),
  );
  const derniere = avancement.at(-1);
  assert.equal(derniere.etape, ETAPES_CONVERSION.deplacement, "le déplacement n'était pas fini");
  assert.ok(derniere.position > 0, "et il restait des octets à déplacer");

  support.armerCoupure(null);
  await convertirEnV3({
    brut: support,
    scellement: await scellement(),
    tailleLogique: TAILLE_LOGIQUE,
    identifiantVolume: IDENTIFIANT,
    depuis: derniere.etape,
    position: derniere.position,
    marquerEtape: async () => {},
    secteursParTour: SECTEURS_PAR_TOUR,
  });
  assert.deepEqual([...(await relireClair(support))], [...attendu]);
});

test("REPRENDRE le déplacement depuis le DÉBUT corrompt le volume — le contre-exemple est gardé", async () => {
  // Le contre-exemple qui a fait exister la position journalisée. Il est conservé plutôt qu'effacé :
  // sans lui, la prochaine simplification remettrait « le déplacement est idempotent », et le défaut
  // reviendrait sans que rien ne rougisse.
  const attendu = contenuV2();
  const support = supportBrut(attendu);
  support.armerCoupure(3);
  const premierScellement = await scellement();
  await assert.rejects(() =>
    convertirEnV3({
      brut: support,
      scellement: premierScellement,
      tailleLogique: TAILLE_LOGIQUE,
      identifiantVolume: IDENTIFIANT,
      depuis: ETAPES_CONVERSION.deplacement,
      marquerEtape: async () => {},
      secteursParTour: SECTEURS_PAR_TOUR,
    }),
  );

  support.armerCoupure(null);
  await convertirEnV3({
    brut: support,
    scellement: await scellement(),
    tailleLogique: TAILLE_LOGIQUE,
    identifiantVolume: IDENTIFIANT,
    depuis: ETAPES_CONVERSION.deplacement,
    // AUCUNE position : la reprise repart du haut du fichier, comme le faisait la première version.
    marquerEtape: async () => {},
    secteursParTour: SECTEURS_PAR_TOUR,
  });
  assert.notDeepEqual(
    [...(await relireClair(support))],
    [...attendu],
    "sans position journalisée, la reprise NE rend PAS le volume d'origine",
  );
});

test("une coupure PENDANT le scellement se reprend sans rescéller ce qui l'est déjà", async () => {
  // Le scellement n'est pas idempotent — rescéller chiffrerait du chiffré —, mais il est
  // REPRENABLE sans compteur : un secteur déjà converti s'ouvre, un secteur encore en clair non.
  const attendu = contenuV2();
  const support = supportBrut(attendu);

  // Première tentative : le déplacement aboutit, le scellement est coupé en chemin.
  let coupures = 0;
  const avancement = [];
  const marquerEtape = async (marque) => {
    coupures += 1;
    avancement.push(marque);
  };
  // Quatre écritures de déplacement, puis l'en-tête, puis deux par tour de scellement — les sceaux
  // du tour, puis ses charges. Couper après la septième laisse le PREMIER tour converti et les trois
  // autres intacts : la reprise doit donc en sauter quatre et en convertir douze.
  support.armerCoupure(7);
  const premierScellement = await scellement();
  await assert.rejects(() =>
    convertirEnV3({
      brut: support,
      scellement: premierScellement,
      tailleLogique: TAILLE_LOGIQUE,
      identifiantVolume: IDENTIFIANT,
      depuis: ETAPES_CONVERSION.deplacement,
      marquerEtape,
      secteursParTour: SECTEURS_PAR_TOUR,
    }),
  );
  assert.equal(
    avancement.at(-1).etape,
    ETAPES_CONVERSION.scellement,
    "l'étape « scellement » avait bien été marquée avant la coupure",
  );
  assert.ok(coupures > 1, "le déplacement avait journalisé son avancement, tour par tour");

  // Reprise : le journal dit « scellement », donc le déplacement n'est PAS refait — le refaire
  // écraserait la charge déjà scellée par du clair relu d'une zone désormais occupée par la région.
  support.armerCoupure(null);
  const rapport = await convertirEnV3({
    brut: support,
    scellement: await scellement(),
    tailleLogique: TAILLE_LOGIQUE,
    identifiantVolume: IDENTIFIANT,
    depuis: ETAPES_CONVERSION.scellement,
    marquerEtape: async () => {},
    secteursParTour: SECTEURS_PAR_TOUR,
  });

  assert.ok(rapport.secteursDejaScelles > 0, "des secteurs étaient déjà convertis");
  assert.ok(rapport.secteursScelles > 0, "et d'autres restaient à convertir");
  assert.equal(
    rapport.secteursScelles + rapport.secteursDejaScelles,
    dispositionV3(TAILLE_LOGIQUE).secteurs,
  );
  assert.deepEqual([...(await relireClair(support))], [...attendu]);
});

// ------------------------------------- toute coupure, à n'importe quelle écriture, se reprend

/**
 * REPREND la conversion depuis le dernier avancement journalisé, sans coupure.
 *
 * C'est exactement ce que fait `volume-migration.mjs` : il relit `progress` du journal et le passe
 * à la conversion. L'épreuve ne devine donc rien de l'état du fichier — elle rejoue le contrat.
 */
async function reprendre(support, avancement) {
  support.armerCoupure(null);
  return convertirEnV3({
    brut: support,
    scellement: await scellement(),
    tailleLogique: TAILLE_LOGIQUE,
    identifiantVolume: IDENTIFIANT,
    depuis: avancement?.etape ?? ETAPES_CONVERSION.deplacement,
    position: avancement?.position ?? null,
    marquerEtape: async () => {},
    secteursParTour: SECTEURS_PAR_TOUR,
  });
}

test("une coupure à N'IMPORTE QUELLE écriture se reprend, et le clair d'origine est rendu", async () => {
  // L'épreuve précédente n'armait qu'une coupure : la douzième. C'était le seul motif pour lequel
  // elle passait — douze écritures tombent sur une frontière de secteur entière. La revue de #110 a
  // montré que les coupures IMPAIRES perdaient le clair des secteurs déjà chiffrés : le scellement
  // écrivait la charge chiffrée PUIS le sceau, si bien qu'une coupure entre les deux laissait un
  // secteur chiffré sans sceau valide — que la reprise classait « pas encore converti » et
  // RECHIFFRAIT, sans qu'aucune erreur ne soit levée.
  //
  // Une épreuve qui choisit ses points de coupure choisit son verdict. Celle-ci les prend TOUS :
  // pour chaque rang d'écriture, elle coupe, reprend depuis le journal, et exige le clair d'origine.
  const attendu = contenuV2();

  // Combien d'écritures une conversion complète demande-t-elle ? On le MESURE plutôt que de le
  // supposer : le nombre change avec la mise en œuvre, et une borne fausse ferait passer l'épreuve
  // en n'éprouvant rien.
  const temoin = supportBrut(attendu);
  await convertirEnV3({
    brut: temoin,
    scellement: await scellement(),
    tailleLogique: TAILLE_LOGIQUE,
    identifiantVolume: IDENTIFIANT,
    depuis: ETAPES_CONVERSION.deplacement,
    marquerEtape: async () => {},
    secteursParTour: SECTEURS_PAR_TOUR,
  });
  const ecrituresCompletes = temoin.ecritures;
  assert.ok(ecrituresCompletes > 8, `une conversion écrit plus que ${ecrituresCompletes} fois`);

  for (let rang = 1; rang < ecrituresCompletes; rang += 1) {
    const support = supportBrut(attendu);
    const avancement = [];
    const scelle = await scellement();
    support.armerCoupure(rang);
    await assert.rejects(
      () =>
        convertirEnV3({
          brut: support,
          scellement: scelle,
          tailleLogique: TAILLE_LOGIQUE,
          identifiantVolume: IDENTIFIANT,
          depuis: ETAPES_CONVERSION.deplacement,
          marquerEtape: async (marque) => {
            avancement.push(marque);
          },
          secteursParTour: SECTEURS_PAR_TOUR,
        }),
      `la coupure au rang ${rang} devait interrompre la conversion`,
    );

    await reprendre(support, avancement.at(-1) ?? null);
    assert.deepEqual(
      [...(await relireClair(support))],
      [...attendu],
      `coupure au rang ${rang} : la reprise doit rendre le clair d'origine`,
    );
  }
});

test("un secteur SOUS la position déjà scellée qui ne s'ouvre pas fait REFUSER la reprise", async () => {
  // La reprise saute ce qui est déjà converti, et ce saut repose sur `dejaScelle`. Si un secteur que
  // l'avancement déclare converti ne s'ouvre PAS, deux lectures sont possibles : « il reste du
  // clair » — et le rescéller est juste — ou « il porte du chiffré qu'on ne sait plus ouvrir » — et
  // le rescéller le détruit. Rien ne les distingue, donc on refuse. C'est ce que la contre-revue
  // de #110 appelle le fail-closed, et il attrape aussi l'écriture déchirée d'un secteur de charge,
  // que l'ordre sceau-puis-charge ne couvre pas.
  const attendu = contenuV2();
  const support = supportBrut(attendu);
  const avancement = [];
  const scelle = await scellement();

  // Couper au troisième tour de scellement : deux tours sont convertis et journalisés.
  support.armerCoupure(9);
  await assert.rejects(() =>
    convertirEnV3({
      brut: support,
      scellement: scelle,
      tailleLogique: TAILLE_LOGIQUE,
      identifiantVolume: IDENTIFIANT,
      depuis: ETAPES_CONVERSION.deplacement,
      marquerEtape: async (marque) => {
        avancement.push(marque);
      },
      secteursParTour: SECTEURS_PAR_TOUR,
    }),
  );
  const dernier = avancement.at(-1);
  assert.equal(dernier.etape, ETAPES_CONVERSION.scellement);
  assert.ok(dernier.position > 0, "des secteurs ont été scellés et la position le dit");

  // Un secteur SOUS cette position est abîmé : il ne s'ouvrira plus.
  const disposition = dispositionV3(TAILLE_LOGIQUE);
  support.octets[offsetDeCharge(disposition, 0) + 10] ^= 0x01;

  support.armerCoupure(null);
  const secondScellement = await scellement();
  await assert.rejects(
    () =>
      convertirEnV3({
        brut: support,
        scellement: secondScellement,
        tailleLogique: TAILLE_LOGIQUE,
        identifiantVolume: IDENTIFIANT,
        depuis: dernier.etape,
        position: dernier.position,
        marquerEtape: async () => {},
        secteursParTour: SECTEURS_PAR_TOUR,
      }),
    (erreur) => {
      assert.equal(erreur.code, "VAULT_MIGRATION_CONVERSION_INCOHERENTE", erreur.message);
      assert.match(erreur.message, /déjà converti/i);
      return true;
    },
  );
});
