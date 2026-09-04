// REPRISE PAR INSTANTANÉ : le protocole d'un essai, et le support de fichier qu'il emploie
// (#65, ADR 0024).
//
// Il vit à côté de `mesurer-boot.mjs` plutôt qu'en lui pour deux raisons : le boot à froid reste
// mesurable seul — c'est la référence à laquelle la reprise se compare —, et un essai de reprise
// enchaîne six gestes dont l'ORDRE est le sujet.
//
// ## Ce que ce relevé mesure, et ce qu'il ne mesure PAS
//
// Il mesure le COÛT de la voie : boot à froid, capture, taille de l'instantané, reprise, et
// l'ÉQUIVALENCE de l'invariant applicatif (ADR 0004) entre les deux chemins, comparée octet pour
// octet sur le corps de la réponse HTTP.
//
// Il ne mesure PAS la LIAISON. Le harnais Node sert des disques en lecture depuis des fichiers, avec
// les écritures du guest en mémoire : il n'y a ici ni volume OPFS, ni journal de génération, ni
// région d'authentification. La liaison est donc DÉCLARÉE inerte — séquence et génération à zéro,
// empreinte de région à zéro — et le relevé le dit dans son rapport plutôt que de la simuler. Ce que
// la liaison refuse est éprouvé par la suite unitaire et par la campagne de mutation ; ce que la
// voie coûte est éprouvé ici.
//
// L'empreinte d'IMAGE, elle, est RÉELLE : c'est l'empreinte SHA-256 de la suite des empreintes que
// le manifeste de l'image de référence publie (ADR 0007). Un instantané pris sur une autre image ne
// s'ouvrirait donc pas, et c'est la seule garde de liaison que ce banc exerce vraiment.

import { createHash } from "node:crypto";
import {
  existsSync,
  openSync,
  closeSync,
  readSync,
  writeSync,
  fstatSync,
  ftruncateSync,
  fsyncSync,
  rmSync,
} from "node:fs";

import {
  capturerInstantane,
  ouvrirInstantaneDeReprise,
} from "../../src/vm/instantane-de-reprise.mjs";

/** Identifiant de volume du relevé. Public, fixe, et sans rapport avec un volume réel. */
export const VOLUME_DU_RELEVE = "6d6573757265722d726570726973652d";

/**
 * SUPPORT DE FICHIER pour l'instantané du relevé.
 *
 * Il tient le même contrat que le support OPFS de `src/vm/instantane/support-opfs.mjs` — `etat`,
 * `lire`, `allouer`, `ecrire`, `barriere`, `retirer` —, ce qui permet au CHEMIN DE PRODUCTION d'être
 * mesuré tel quel, sans double ni raccourci. C'est aussi ce qui rend la mesure honnête : ce sont les
 * mêmes octets, le même scellement et le même ordre de gestes que dans le navigateur.
 */
export function supportInstantaneFichier(chemin) {
  let descripteur = null;
  const saisir = () => (descripteur ??= openSync(chemin, existsSync(chemin) ? "r+" : "w+"));
  const fermer = () => {
    if (descripteur === null) return;
    closeSync(descripteur);
    descripteur = null;
  };

  return {
    chemin,
    async etat() {
      const taille = fstatSync(saisir()).size;
      return { present: taille > 0, taille };
    },
    async lire(offset, longueur) {
      const cible = Buffer.alloc(longueur);
      const lus = readSync(saisir(), cible, 0, longueur, offset);
      const octets = new Uint8Array(cible.buffer, cible.byteOffset, lus);
      return lus === longueur ? octets : octets.subarray(0, lus);
    },
    async allouer(taille) {
      ftruncateSync(saisir(), taille);
    },
    async ecrire(offset, octets) {
      return writeSync(saisir(), octets, 0, octets.byteLength, offset);
    },
    async barriere() {
      fsyncSync(saisir());
    },
    async retirer() {
      fermer();
      rmSync(chemin, { force: true });
      return true;
    },
    fermer,
  };
}

/**
 * Empreinte de l'IMAGE DE RÉFÉRENCE : SHA-256 de la suite des empreintes que le manifeste publie.
 *
 * Elle est dérivée du manifeste, jamais recalculée sur les fichiers : le manifeste EST le contrat
 * d'identité de l'image (ADR 0007), et recalculer donnerait une seconde source de vérité qui
 * finirait par diverger.
 */
export function empreinteDeLImage(manifeste) {
  const empreinte = createHash("sha256");
  for (const artefact of manifeste.artifacts) {
    empreinte.update(`${artefact.name}:${artefact.sha256}\n`);
  }
  return new Uint8Array(empreinte.digest());
}

/**
 * L'ÉTAT PRÉSENT déclaré au chemin de production.
 *
 * Séquence, génération et empreinte de région sont à ZÉRO, et ce n'est pas une valeur par défaut :
 * c'est la déclaration explicite qu'aucun volume transactionnel n'accompagne ce relevé. La règle du
 * dépôt vaut ici comme ailleurs — une valeur pour contrôler, ou une valeur déclarée inerte, mais
 * jamais un oubli.
 */
export function etatPresentDuReleve(manifeste) {
  return {
    formatVolume: 3,
    sequence: 0,
    generation: 0,
    empreinteRegion: new Uint8Array(32),
    empreinteImage: empreinteDeLImage(manifeste),
  };
}

/** Interroge l'invariant applicatif et rend les octets BRUTS de la réponse. */
async function lireInvariant(vm) {
  const reponse = await vm.requete("GET", "/vault/invariant");
  if (reponse.statut !== 200) throw new Error(`/vault/invariant a répondu ${reponse.statut}`);
  return Buffer.from(reponse.corps);
}

/**
 * UN essai complet : boot à froid, capture, reprise, et confrontation des deux invariants.
 *
 * L'ordre des gestes est le protocole, et il porte tout ce que le relevé prétend :
 *
 *  1. boot à FROID jusqu'à la santé de Rails — c'est la référence à laquelle la reprise se compare ;
 *  2. invariant relu sur ce boot : les octets de référence ;
 *  3. l'émulateur est ARRÊTÉ, puis l'état capturé. Capturer un émulateur qui bat donnerait un état
 *     que rien ne décrit — c'est la quiescence de l'ADR 0024, ici obtenue par l'arrêt lui-même ;
 *  4. l'instantané est scellé et écrit par le CHEMIN DE PRODUCTION, marque de complétude comprise ;
 *  5. un émulateur NEUF est construit sans autostart, l'instantané est relu, ouvert, restauré, et
 *     seulement alors la boucle est lancée ;
 *  6. invariant relu sur la reprise, et comparé octet pour octet à celui du boot à froid.
 */
export async function essaiDeReprise({
  manifeste,
  demarrerVm,
  scellement,
  support,
  budgetMs,
  essai,
}) {
  const etatPresent = etatPresentDuReleve(manifeste);

  const froid = await demarrerVm({ manifeste });
  let invariantFroid;
  let capture;
  let captureMs;
  let bootFroidMs;
  try {
    ({ dureeMs: bootFroidMs } = await froid.attendreSante({ delaiTotalMs: budgetMs }));
    invariantFroid = await lireInvariant(froid);
    const debutCapture = performance.now();
    const etat = await froid.capturerEtat();
    capture = await capturerInstantane({
      scellement,
      volume: "releve",
      etatPresent,
      etat,
      support,
    });
    captureMs = performance.now() - debutCapture;
  } finally {
    await froid.arreter();
  }

  const debutReprise = performance.now();
  const chaud = await demarrerVm({ manifeste, autostart: false });
  let invariantChaud;
  let repriseMs;
  let ouvertureMs;
  let rapport;
  try {
    await chaud.attendrePret();
    const debutOuverture = performance.now();
    rapport = await ouvrirInstantaneDeReprise({
      scellement,
      volume: "releve",
      etatPresent,
      support,
    });
    if (!rapport.utilise) {
      throw new Error(
        `l'instantané a été écarté au motif « ${rapport.motif} » : ${rapport.message}`,
      );
    }
    ouvertureMs = performance.now() - debutOuverture;
    await chaud.restaurerEtat(rapport.etat);
    await chaud.attendreSante({ delaiTotalMs: budgetMs });
    repriseMs = performance.now() - debutReprise;
    invariantChaud = await lireInvariant(chaud);
  } finally {
    await chaud.arreter();
  }

  return {
    essai,
    bootFroidMs: Math.round(bootFroidMs),
    repriseMs: Math.round(repriseMs),
    captureMs: Math.round(captureMs),
    ouvertureInstantaneMs: Math.round(ouvertureMs),
    instantaneOctets: capture.octets,
    etatV86Octets: capture.liaison.longueurEtat,
    // ÉQUIVALENCE : les octets de l'invariant SQLite (ADR 0004), tels que Rails les rend, comparés
    // entre les deux chemins. Ce n'est pas un résumé : ce sont les mêmes octets, ou ce n'en sont pas.
    invariantIdentique: invariantFroid.equals(invariantChaud),
    invariantFroidSha256: createHash("sha256").update(invariantFroid).digest("hex"),
    invariantRepriseSha256: createHash("sha256").update(invariantChaud).digest("hex"),
  };
}
