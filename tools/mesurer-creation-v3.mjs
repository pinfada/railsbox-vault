// Mesure du SCELLEMENT INITIAL d'un volume v3 (#18, ADR 0016).
//
// « Un secteur jamais écrit n'existe pas en v3 » (ADR 0015) : la création d'un volume scelle TOUS
// ses secteurs, y compris ceux qui ne portent que des zéros. L'ADR 0015 estimait ce coût à 18,7 s
// pour 512 Mio, à partir du coût par scellement mesuré sur le modèle. Cet outil le mesure sur le
// CHEMIN RÉEL — `VolumeChiffre.scellerTout`, celui que `openOpfsVolume` appelle.
//
// **Ce que cette mesure n'est pas.** Elle tourne sous Node, dont l'ADR 0015 a mesuré qu'il est
// ~2,8 fois plus lent par appel à `crypto.subtle` que Chromium. Le chiffre rendu est donc une BORNE
// SUPÉRIEURE pour le navigateur, pas le relevé du navigateur. Le support est en MÉMOIRE, pour
// isoler le calcul du coût d'OPFS — ce qu'on veut savoir ici est ce que le chiffrement coûte, pas
// ce que le support coûte.
//
// Elle n'est pas rattachée à `npm run check` : c'est une mesure, pas une épreuve, et son verdict
// dépend de la machine. Son relevé est publié dans `docs/quality-attributes.md`.
//
//   node tools/mesurer-creation-v3.mjs [--mio=512] [--essais=3]

import { CLE_DE_TEST } from "../src/vm/cle-de-volume.mjs";
import { Scellement } from "../src/vm/scellement.mjs";
import { VolumeChiffre } from "../src/vm/volume-chiffre.mjs";
import { dispositionV3 } from "../src/vm/volume-chiffre-format.mjs";

const IDENTIFIANT = "0123456789abcdef0123456789abcdef";

function argument(nom, defaut) {
  const brut = process.argv.find((valeur) => valeur.startsWith(`--${nom}=`));
  return brut === undefined ? defaut : Number(brut.slice(nom.length + 3));
}

/** Support en mémoire : il accepte tout, et n'apprend rien sur OPFS. C'est voulu. */
function supportEnMemoire(taille) {
  const octets = new Uint8Array(taille);
  return {
    lireSupport: (offset, longueur) => octets.slice(offset, offset + longueur),
    ecrireSupport: (offset, source) => octets.set(source, offset),
  };
}

async function mesurerUnEssai(tailleLogique) {
  const disposition = dispositionV3(tailleLogique);
  const support = supportEnMemoire(disposition.tailleSupport);
  const volume = new VolumeChiffre({
    volume: "mesure",
    scellement: await Scellement.ouvrir({
      volume: IDENTIFIANT,
      cleOctets: CLE_DE_TEST,
      formatVersion: 3,
    }),
    disposition,
    lireSupport: support.lireSupport,
    ecrireSupport: support.ecrireSupport,
  });

  const depart = performance.now();
  const secteurs = await volume.scellerTout(0);
  const dureeMs = performance.now() - depart;
  return { secteurs, dureeMs, disposition };
}

const mio = argument("mio", 512);
const essais = argument("essais", 3);
const tailleLogique = mio * 1024 * 1024;

const durees = [];
let dernier = null;
for (let essai = 0; essai < essais; essai += 1) {
  dernier = await mesurerUnEssai(tailleLogique);
  durees.push(dernier.dureeMs);
}
durees.sort((gauche, droite) => gauche - droite);

const mediane = durees[Math.floor(durees.length / 2)];
const rendu = {
  moteur: `Node ${process.versions.node}`,
  tailleLogiqueOctets: tailleLogique,
  tailleSupportOctets: dernier.disposition.tailleSupport,
  surcoutRelatif: dernier.disposition.tailleSupport / tailleLogique - 1,
  secteursScelles: dernier.secteurs,
  essais,
  minMs: Math.round(durees[0]),
  medianeMs: Math.round(mediane),
  maxMs: Math.round(durees.at(-1)),
  microsecondesParSecteur: Number(((mediane * 1000) / dernier.secteurs).toFixed(2)),
};
process.stdout.write(`${JSON.stringify(rendu, null, 2)}\n`);
