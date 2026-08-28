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
  });
  assert.equal(marques.at(-1).etape, ETAPES_CONVERSION.scellement);
  assert.ok(
    marques.slice(0, -1).every((marque) => marque.etape === ETAPES_CONVERSION.deplacement),
    "chaque tour de déplacement journalise sa position avant que le scellement ne commence",
  );
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
  // Quatre écritures de déplacement, puis huit de scellement : la coupure tombe dans le second
  // geste, une fois l'étape marquée.
  support.armerCoupure(12);
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
