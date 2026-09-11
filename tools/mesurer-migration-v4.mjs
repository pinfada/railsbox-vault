// Mesure de la MIGRATION v3 → v4 (#182, ADR 0033, ADR 0035).
//
// C'est le geste le plus lourd que ce dépôt ait tenté : chaque secteur est OUVERT sous la clé v3
// puis RESCELLÉ sous la clé du domaine `volume` de la v4. Le scellement initial d'un volume v3
// coûtait 87,6 s pour 512 Mio (`tools/mesurer-creation-v3.mjs`) ; cette conversion en coûte
// davantage, parce qu'elle ouvre autant qu'elle scelle. Combien exactement, c'est ce que cet outil
// mesure plutôt que de l'estimer.
//
// **Ce que cette mesure n'est pas.** Elle tourne sous Node, dont l'ADR 0015 a mesuré qu'il est
// ~2,8 fois plus lent par appel à `crypto.subtle` que Chromium. Le chiffre rendu est donc une BORNE
// SUPÉRIEURE pour le navigateur. Le support est en MÉMOIRE, pour isoler le calcul du coût d'OPFS —
// ce qu'on veut savoir ici est ce que la conversion coûte, pas ce que le support coûte. Le journal
// de migration est feint : son écriture anticipée est PRODUITE et mesurée, mais elle n'est pas
// inscrite sur un support.
//
// Elle n'est pas rattachée à `npm run check` : c'est une mesure, pas une épreuve, et son verdict
// dépend de la machine. Son relevé est publié dans `docs/quality-attributes.md`.
//
// La clé passe par la PORTE DU HARNAIS, comme partout ailleurs.
//
//   VAULT_HARNAIS_CLE_DE_VOLUME=cle-de-test node tools/mesurer-migration-v4.mjs [--mio=512] [--essais=1]

import { SECTOR_SIZE } from "../src/vm/block-geometry.mjs";
import { cleDeVolumeDuHarnais } from "../src/vm/cle-de-volume.mjs";
import { convertirEnV4 } from "../src/vm/migration-v4.mjs";
import { RANG_SECTEUR_DE_VOLUME, Scellement } from "../src/vm/scellement.mjs";
import {
  FORMAT_VOLUME_V3,
  FORMAT_VOLUME_V4,
  dispositionDuVolume,
  encoderEnTeteV3,
  encoderSceau,
  offsetDeCharge,
  offsetDeSceau,
} from "../src/vm/volume-chiffre-format.mjs";

const IDENTIFIANT = "0123456789abcdef0123456789abcdef";
const GENERATION = 1;

function argument(nom, defaut) {
  const brut = process.argv.find((valeur) => valeur.startsWith(`--${nom}=`));
  return brut === undefined ? defaut : Number(brut.slice(nom.length + 3));
}

/** Accès BRUT en mémoire, à la forme de `opfs-volume-brut.mjs`. */
function brutEnMemoire(octets) {
  return {
    name: "mesure",
    size: () => octets.byteLength,
    read: async (offset, longueur) => octets.slice(offset, offset + longueur),
    write: async (offset, source) => octets.set(source, offset),
    flush: async () => {},
  };
}

function scellement(formatVersion) {
  return Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: cleDeVolumeDuHarnais(),
    formatVersion,
  });
}

/** FABRIQUE un volume v3 complet : l'état de DÉPART de la conversion. */
async function volumeV3(tailleLogique) {
  const disposition = dispositionDuVolume(tailleLogique);
  const fichier = new Uint8Array(disposition.tailleSupport);
  fichier.set(
    encoderEnTeteV3({ tailleLogique, identifiantVolume: IDENTIFIANT, scellementComplet: true }),
    0,
  );
  const v3 = await scellement(FORMAT_VOLUME_V3);
  const clair = new Uint8Array(SECTOR_SIZE);
  const depart = performance.now();
  for (let adresse = 0; adresse < tailleLogique; adresse += SECTOR_SIZE) {
    const scelle = await v3.scellerBloc(
      { generation: GENERATION, rang: RANG_SECTEUR_DE_VOLUME, adresse, longueur: SECTOR_SIZE },
      clair,
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
  return { fichier, disposition, scellementInitialMs: performance.now() - depart };
}

async function mesurerUnEssai(tailleLogique) {
  const prepare = await volumeV3(tailleLogique);
  const brut = brutEnMemoire(prepare.fichier);
  let inscriptions = 0;
  let octetsAnticipes = 0;

  const depart = performance.now();
  const compte = await convertirEnV4({
    brut,
    scellementV3: await scellement(FORMAT_VOLUME_V3),
    scellementV4: await scellement(FORMAT_VOLUME_V4),
    tailleLogique,
    identifiantVolume: IDENTIFIANT,
    marquerEtape: async (avancement) => {
      inscriptions += 1;
      if (avancement.tampon) octetsAnticipes += avancement.tampon.sceauxV3.length / 2;
    },
  });
  const dureeMs = performance.now() - depart;
  return { ...prepare, compte, dureeMs, inscriptions, octetsAnticipes };
}

const mio = argument("mio", 512);
const essais = argument("essais", 1);
const tailleLogique = mio * 1024 * 1024;

const durees = [];
let dernier = null;
for (let essai = 0; essai < essais; essai += 1) {
  dernier = await mesurerUnEssai(tailleLogique);
  durees.push(dernier.dureeMs);
}
durees.sort((gauche, droite) => gauche - droite);
const mediane = durees[Math.floor(durees.length / 2)];
const secteurs = dernier.compte.secteursRescelles;

process.stdout.write(
  `${JSON.stringify(
    {
      moteur: `Node ${process.versions.node}`,
      tailleLogiqueOctets: tailleLogique,
      secteursRescelles: secteurs,
      essais,
      scellementInitialV3Ms: Math.round(dernier.scellementInitialMs),
      migrationMinMs: Math.round(durees[0]),
      migrationMedianeMs: Math.round(mediane),
      migrationMaxMs: Math.round(durees.at(-1)),
      microsecondesParSecteur: Number(((mediane * 1000) / secteurs).toFixed(2)),
      rapportAuScellementInitial: Number((mediane / dernier.scellementInitialMs).toFixed(2)),
      inscriptionsAuJournal: dernier.inscriptions,
      octetsAnticipesTotal: dernier.octetsAnticipes,
      surcoutEcritureAnticipee: Number(
        (dernier.octetsAnticipes / (secteurs * SECTOR_SIZE)).toFixed(4),
      ),
    },
    null,
    2,
  )}\n`,
);
