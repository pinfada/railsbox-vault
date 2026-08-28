// Banc de mesure des trois mécanismes de génération candidats (#16, ADR 0014).
//
// Il ne prouve AUCUNE atomicité : il compte des octets et des barrières. C'est ce qu'il faut pour
// choisir, parce que les trois candidats tiennent la même promesse — une génération n'atteint le
// volume qu'entière — et se distinguent par ce qu'ils coûtent.
//
// Les trois modèles écrivent RÉELLEMENT dans le double calibré de `FileSystemSyncAccessHandle` :
// les octets comptés sont ceux que le support a acceptés, pas une estimation. Deux d'entre eux
// (copie-sur-écriture, ombre) sont des maquettes de COÛT : elles font les mêmes écritures et les
// mêmes barrières que le mécanisme qu'elles représentent, sans en implémenter la récupération. Ce
// que l'ADR en tire est donc un coût mesuré et une sémantique RAISONNÉE — c'est dit dans l'ADR, et
// c'est suffisant pour trancher, puisque le mécanisme retenu est celui dont le coût est le plus bas.
//
// Usage : node tools/mesurer-generations.mjs [--blocs N] [--barrieres B] [--par-barriere P]

import { SECTOR_SIZE } from "../src/vm/block-geometry.mjs";
import {
  ENTETE_OCTETS,
  RACINE_OCTETS,
  ZONE_ENREGISTREMENTS,
} from "../src/vm/generation-format.mjs";
import { GenerationStore } from "../src/vm/generation-store.mjs";
import { createSyncAccessStore } from "../src/vm/sync-access-double.mjs";

function options(argv) {
  const lu = (nom, defaut) => {
    const index = argv.indexOf(`--${nom}`);
    return index === -1 ? defaut : Number(argv[index + 1]);
  };
  return {
    blocs: lu("blocs", 256),
    barrieres: lu("barrieres", 16),
    parBarriere: lu("par-barriere", 32),
  };
}

/** Suite d'écritures déterministe : le même travail pour les trois modèles. */
function* travail({ blocs, barrieres, parBarriere }) {
  let graine = 1;
  for (let barriere = 0; barriere < barrieres; barriere += 1) {
    const ecritures = [];
    for (let rang = 0; rang < parBarriere; rang += 1) {
      graine = (graine * 1103515245 + 12345) >>> 0;
      ecritures.push(graine % blocs);
    }
    yield ecritures;
  }
}

function contenu(bloc, generation) {
  const octets = new Uint8Array(SECTOR_SIZE);
  for (let index = 0; index < SECTOR_SIZE; index += 1) {
    octets[index] = (index + bloc * 7 + generation * 13) % 256;
  }
  return octets;
}

/** Compteurs d'un modèle. `octetsEcrits` compte ce que le SUPPORT a accepté. */
function compteurs() {
  return { octetsEcrits: 0, barrieres: 0, octetsLus: 0 };
}

function handleMesure(handle, compte) {
  return {
    getSize: () => handle.getSize(),
    read(tampon, position) {
      compte.octetsLus += tampon.byteLength;
      return handle.read(tampon, position);
    },
    write(octets, position) {
      compte.octetsEcrits += octets.byteLength;
      return handle.write(octets, position);
    },
    truncate: (taille) => handle.truncate(taille),
    flush() {
      compte.barrieres += 1;
      return handle.flush();
    },
    close: () => handle.close(),
  };
}

/** (a) Journal d'intention : le mécanisme réellement implémenté par `generation-store.mjs`. */
async function mesurerJournal(config) {
  const magasin = createSyncAccessStore();
  const compte = compteurs();
  const volume = new Uint8Array(config.blocs * SECTOR_SIZE);
  const handle = handleMesure(await magasin.openHandle("v.gen"), compte);
  const store = await GenerationStore.ouvrir({
    // La fraîcheur de l'ADR 0019 est DÉCLARÉE absente ici, jamais oubliée : ce banc n'ouvre pas
    // un volume v3 complet, il n'a ni région d'authentification ni voisin où poser un témoin. Le
    // magasin écrit alors des racines sans empreinte, et son rapport le publie.
    fraicheur: null,
    volume: "v",
    handle,
    tailleVolume: volume.byteLength,
    lireVolume: (offset, longueur) => volume.slice(offset, offset + longueur),
    ecrireVolume: (offset, octets) => {
      compte.octetsEcrits += octets.byteLength;
      volume.set(octets, offset);
    },
    barriereVolume: async () => {
      compte.barrieres += 1;
    },
    seuilPointDeControle: 1024 * 1024,
  });

  let generation = 0;
  for (const ecritures of travail(config)) {
    generation += 1;
    for (const bloc of ecritures)
      await store.deposer(bloc * SECTOR_SIZE, contenu(bloc, generation));
    await store.valider();
    if (store.pointDeControleDu) await store.pointDeControle();
  }
  const pic = magasin.sizeOf("v.gen");
  await store.pointDeControle();
  return { compte, espaceVoisin: pic };
}

/**
 * (b) Copie-sur-écriture à table de blocs et double racine. Maquette de COÛT.
 *
 * Chaque écriture va dans un bloc LIBRE ; la table associe bloc logique → bloc physique. À la
 * barrière, les pages de table modifiées sont écrites et franchies, puis une racine d'un secteur
 * commute la table. La table pèse quatre octets par bloc logique, et elle est doublée.
 */
async function mesurerCopieSurEcriture(config) {
  const magasin = createSyncAccessStore();
  const compte = compteurs();
  const OCTETS_PAR_ENTREE = 4;
  const ENTREES_PAR_PAGE = SECTOR_SIZE / OCTETS_PAR_ENTREE;
  const handle = handleMesure(await magasin.openHandle("v"), compte);
  const pagesDeTable = Math.ceil(config.blocs / ENTREES_PAR_PAGE);
  const zoneTable = 2 * RACINE_OCTETS;
  const zoneDonnees = zoneTable + 2 * pagesDeTable * SECTOR_SIZE;
  // Réserve de blocs physiques : le logique plus une provision d'écritures en vol par génération.
  const blocsPhysiques = config.blocs + config.parBarriere * 2;
  handle.truncate(zoneDonnees + blocsPhysiques * SECTOR_SIZE);

  let libre = config.blocs;
  let generation = 0;
  let racine = 0;
  for (const ecritures of travail(config)) {
    generation += 1;
    const pages = new Set();
    for (const bloc of ecritures) {
      const physique = libre;
      libre = (libre + 1) % blocsPhysiques;
      handle.write(contenu(bloc, generation), { at: zoneDonnees + physique * SECTOR_SIZE });
      pages.add(Math.floor(bloc / ENTREES_PAR_PAGE));
    }
    // Les pages de table modifiées sont écrites dans la moitié INACTIVE, puis franchies.
    for (const page of pages) {
      const base = zoneTable + (racine ^ 1) * pagesDeTable * SECTOR_SIZE;
      handle.write(new Uint8Array(SECTOR_SIZE), { at: base + page * SECTOR_SIZE });
    }
    await handle.flush();
    racine ^= 1;
    handle.write(new Uint8Array(RACINE_OCTETS), { at: racine * RACINE_OCTETS });
    await handle.flush();
  }
  return {
    compte,
    espaceVoisin: 0,
    espaceInterne: zoneDonnees + config.parBarriere * 2 * SECTOR_SIZE,
  };
}

/** (c) Ombre par génération : le volume entier est recopié à chaque génération. Maquette de COÛT. */
async function mesurerOmbre(config) {
  const magasin = createSyncAccessStore();
  const compte = compteurs();
  const handle = handleMesure(await magasin.openHandle("v"), compte);
  const octetsVolume = config.blocs * SECTOR_SIZE;
  handle.truncate(2 * octetsVolume + RACINE_OCTETS);

  let generation = 0;
  let ombre = 1;
  for (const ecritures of travail(config)) {
    generation += 1;
    const base = ombre * octetsVolume;
    // Recopier l'état d'avant dans l'ombre : c'est ce que coûte une ombre par génération.
    for (let bloc = 0; bloc < config.blocs; bloc += 1) {
      const source = new Uint8Array(SECTOR_SIZE);
      handle.read(source, { at: (ombre ^ 1) * octetsVolume + bloc * SECTOR_SIZE });
      handle.write(source, { at: base + bloc * SECTOR_SIZE });
    }
    for (const bloc of ecritures) {
      handle.write(contenu(bloc, generation), { at: base + bloc * SECTOR_SIZE });
    }
    await handle.flush();
    handle.write(new Uint8Array(RACINE_OCTETS), { at: 2 * octetsVolume });
    await handle.flush();
    ombre ^= 1;
  }
  return { compte, espaceVoisin: 0, espaceInterne: 2 * octetsVolume + RACINE_OCTETS };
}

const config = options(process.argv.slice(2));
const octetsDuGuest = config.barrieres * config.parBarriere * SECTOR_SIZE;

const mesures = [
  ["Journal d'intention (a)", await mesurerJournal(config)],
  ["Copie-sur-écriture, double racine (b)", await mesurerCopieSurEcriture(config)],
  ["Ombre par génération (c)", await mesurerOmbre(config)],
];

const octetsLogiques = config.blocs * SECTOR_SIZE;
process.stdout.write(
  `Volume logique ${octetsLogiques} o (${config.blocs} blocs de ${SECTOR_SIZE}), ` +
    `${config.barrieres} générations de ${config.parBarriere} écritures — ` +
    `${octetsDuGuest} o écrits par le guest.\n` +
    `En-tête d'enregistrement ${ENTETE_OCTETS} o, racine ${RACINE_OCTETS} o, ` +
    `zone des enregistrements à ${ZONE_ENREGISTREMENTS} o.\n\n` +
    "| Mécanisme | Surcoût d'écriture | Barrières par génération | Espace en plus | Octets relus |\n" +
    "| --- | ---: | ---: | ---: | ---: |\n",
);
for (const [nom, { compte, espaceVoisin, espaceInterne = 0 }] of mesures) {
  const amplification = (compte.octetsEcrits / octetsDuGuest).toFixed(2);
  const parGeneration = (compte.barrieres / config.barrieres).toFixed(1);
  const espace = espaceVoisin + espaceInterne;
  process.stdout.write(
    `| ${nom} | ×${amplification} | ${parGeneration} | ${espace} o | ${compte.octetsLus} o |\n`,
  );
}
