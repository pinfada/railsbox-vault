/**
 * L'ANNULATION est tenue APRÈS CHAQUE ATTENTE (#247, D1g ; revue de sécurité de #298, constat 4).
 *
 * Une opération du magasin qui dépasse son délai est ABANDONNÉE : l'appelant a repris la main (il
 * télécharge, ou il écrit autre chose), et son jeton est annulé. Une opération abandonnée ne doit
 * plus RIEN écrire, renommer ni supprimer — sinon elle remplace ce qu'un plus récent vient de poser.
 * Le jeton testé AVANT une attente ne dit rien de ce qui se passe PENDANT elle : il se teste de
 * nouveau après chaque attente, avant tout geste qui modifie le magasin.
 *
 * ## La méthode : un balayage, pas un scénario
 *
 * Pour chaque opération, on compte ses attentes (primitives de stockage, hachage, budget) à vide,
 * puis on la rejoue N fois en SUSPENDANT la k-ième — le jeton est annulé pendant qu'elle est
 * suspendue, puis elle reprend. Après l'annulation, AUCUN geste modificateur ne doit PARTIR :
 *
 *  - un appel déjà lancé (la k-ième primitive) va à son terme : un `move` en vol n'est pas annulable,
 *    et ce test ne le prétend pas ;
 *  - seule exception : une admission ou un rangement abandonnés retirent LEUR partiel (le nom du
 *    partiel est partagé entre sessions — limite écrite, ADR 0046 : le pire est un téléchargement de
 *    plus, jamais un octet servi non vérifié).
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import {
  TRANCHE_OCTETS,
  creerMagasinDArtefacts,
  empreintesDeTranches,
  hacherParWebCrypto,
  racineDesTranches,
} from "../../src/vm/magasin-d-artefacts.mjs";
import { primitivesEnMemoire } from "./magasin-en-memoire.mjs";

const MODIFIE = new Set(["ecrire", "renommer", "supprimer"]);
const TAILLE = TRANCHE_OCTETS + 777; // deux tranches : la boucle de tranches est jouée

function artefact(marque = 7) {
  const octets = new Uint8Array(TAILLE);
  for (let index = 0; index < TAILLE; index += 1) octets[index] = (marque + index) % 251;
  return { octets, sha256: createHash("sha256").update(octets).digest("hex") };
}

/**
 * Un magasin sur des primitives en mémoire dont chaque appel est compté ; le `pause`-ième est
 * SUSPENDU avant de s'exécuter, jusqu'à `liberer()`. `appels` garde, pour chaque appel, si le jeton
 * était déjà annulé AU MOMENT OÙ IL PART.
 */
function banc({ jeton, pause = null, preparer = () => {} }) {
  const memoire = primitivesEnMemoire();
  preparer(memoire);
  const appels = [];
  let rang = 0;
  let atteint;
  let liberer;
  const estAtteint = new Promise((resoudre) => (atteint = resoudre));
  const estLibere = new Promise((resoudre) => (liberer = resoudre));
  const attente = async (nom, cible, agir) => {
    rang += 1;
    appels.push({ nom, cible, apresAnnulation: jeton.annule, rang });
    if (rang === pause) {
      atteint();
      await estLibere;
    }
    return agir();
  };
  const primitives = {
    taille: (nom) => attente("taille", nom, () => memoire.taille(nom)),
    lire: (nom, ...reste) => attente("lire", nom, () => memoire.lire(nom, ...reste)),
    ecrire: (nom, ...reste) => attente("ecrire", nom, () => memoire.ecrire(nom, ...reste)),
    renommer: (de, vers) => attente("renommer", de, () => memoire.renommer(de, vers)),
    supprimer: (nom) => attente("supprimer", nom, () => memoire.supprimer(nom)),
    lister: () => attente("lister", "", () => memoire.lister()),
  };
  const magasin = creerMagasinDArtefacts({
    primitives,
    hacher: (octets) => attente("hacher", "", () => hacherParWebCrypto(octets)),
    peutAdmettre: () => attente("peutAdmettre", "", async () => true),
  });
  return { magasin, memoire, appels, atteint: estAtteint, liberer };
}

/**
 * Le balayage. `lancer(magasin, jeton)` est l'opération ; `autorise(appel)` dit si un geste
 * modificateur après l'annulation est permis (le nettoyage de SON partiel) ; `apres(contexte)`
 * contrôle d'autres invariants.
 */
async function balayer({ preparer, lancer, autorise = () => false, apres = () => {} }) {
  const aVide = banc({ jeton: { annule: false }, preparer });
  await lancer(aVide.magasin, { annule: false }, aVide);
  const attentes = aVide.appels.length;
  assert.ok(attentes > 0, "l'opération attend au moins une fois");

  const fautes = [];
  for (let pause = 1; pause <= attentes; pause += 1) {
    const jeton = { annule: false };
    const b = banc({ jeton, pause, preparer });
    const operation = lancer(b.magasin, jeton, b);
    await b.atteint;
    const instantane = apres.instantane?.(b);
    jeton.annule = true; // l'échéance tombe PENDANT cette attente
    b.liberer();
    await operation.catch(() => {});
    for (const appel of b.appels) {
      if (appel.apresAnnulation && MODIFIE.has(appel.nom) && !autorise(appel)) {
        fautes.push(
          `annulé pendant l'attente n° ${pause} : ${appel.nom}(${appel.cible}) part APRÈS`,
        );
      }
    }
    apres.verifier?.(b, instantane, fautes, pause);
  }
  assert.deepEqual(fautes, [], "une opération abandonnée a continué à modifier le magasin");
}

const partielDe = (nom) => (appel) => appel.nom === "supprimer" && appel.cible === nom;

// --- admettre --------------------------------------------------------------------------------------

test("admettre : annulée pendant N'IMPORTE quelle attente, plus aucun geste modificateur ne part", async () => {
  const { octets, sha256 } = artefact();
  await balayer({
    lancer: (magasin, jeton) => magasin.admettre({ sha256, octets }, jeton),
    autorise: partielDe(`${sha256}.partiel`),
  });
});

test("admettre, racine fausse : annulée pendant N'IMPORTE quelle attente, rien ne part après", async () => {
  const { octets, sha256 } = artefact();
  await balayer({
    lancer: (magasin, jeton) => magasin.admettre({ sha256, octets, racine: "0".repeat(64) }, jeton),
    autorise: partielDe(`${sha256}.partiel`),
  });
});

test("admettre, l'ancienne entrée est oubliée AVANT l'écriture : annulée pendant ces suppressions, aucune suivante ne part", async () => {
  const { octets, sha256 } = artefact();
  await balayer({
    preparer: (memoire) => {
      memoire.fichiers.set(sha256, new Uint8Array(3));
      memoire.fichiers.set(`${sha256}.tranches`, new Uint8Array(3));
    },
    lancer: (magasin, jeton) => magasin.admettre({ sha256, octets }, jeton),
    autorise: partielDe(`${sha256}.partiel`),
  });
});

// --- ecrireLeDescripteurScelle ---------------------------------------------------------------------

test("ecrireLeDescripteurScelle : annulée pendant N'IMPORTE quelle attente, rien ne part après — le renommage en tête", async () => {
  await balayer({
    preparer: (memoire) => memoire.fichiers.set("descripteur.scelle", new Uint8Array(5).fill(1)),
    lancer: (magasin, jeton) =>
      magasin.ecrireLeDescripteurScelle(new Uint8Array(100).fill(2), jeton),
    autorise: partielDe("descripteur.scelle.partiel"),
  });
});

test("ecrireLeDescripteurScelle : annulée pendant la suppression de l'ancien, le renommage n'a PAS lieu et le retour est `false`", async () => {
  // La reproduction de la revue : suspendre `supprimer(descripteur.scelle)`, annuler, reprendre.
  const jeton = { annule: false };
  const memoire = primitivesEnMemoire();
  memoire.fichiers.set("descripteur.scelle", new Uint8Array(5).fill(1));
  const appels = [];
  let suspendre;
  const reprise = new Promise((resoudre) => (suspendre = resoudre));
  let atteint;
  const enSuspens = new Promise((resoudre) => (atteint = resoudre));
  const primitives = {
    ...memoire,
    async supprimer(nom) {
      appels.push(`supprimer ${nom}`);
      if (nom === "descripteur.scelle") {
        atteint();
        await reprise;
      }
      return memoire.supprimer(nom);
    },
    async renommer(de, vers) {
      appels.push(`renommer ${de}`);
      return memoire.renommer(de, vers);
    },
  };
  const magasin = creerMagasinDArtefacts({ primitives });
  const operation = magasin.ecrireLeDescripteurScelle(new Uint8Array(100).fill(2), jeton);
  await enSuspens;
  jeton.annule = true;
  suspendre();

  assert.equal(await operation, false, "l'opération abandonnée n'annonce pas un rangement");
  assert.ok(!appels.some((appel) => appel.startsWith("renommer")), appels.join(" ; "));
  assert.equal(
    memoire.fichiers.has("descripteur.scelle"),
    false,
    "aucun descripteur, jamais un demi-neuf",
  );
});

// --- servir ----------------------------------------------------------------------------------------

/** Un artefact rangé par une vraie admission, dans la mémoire d'un banc neuf. */
async function rangerAvant(memoire, { octets, sha256 }) {
  const magasin = creerMagasinDArtefacts({ primitives: memoire });
  const { racine } = await magasin.admettre({ sha256, octets });
  return racine;
}

for (const [titre, avecRacine] of [
  ["avec la racine du descripteur", true],
  ["sans racine (chemin lent)", false],
]) {
  test(`servir ${titre} : annulée pendant N'IMPORTE quelle attente, plus rien n'est copié ni supprimé`, async () => {
    const a = artefact();
    const memoireModele = primitivesEnMemoire();
    const racine = await rangerAvant(memoireModele, a);
    const cibles = [];
    await balayer({
      preparer: (memoire) => {
        for (const [nom, octets] of memoireModele.fichiers)
          memoire.fichiers.set(nom, octets.slice());
      },
      lancer: (magasin, jeton) => {
        const cible = new Uint8Array(TAILLE);
        cibles.push(cible);
        return magasin.servir(
          { sha256: a.sha256, octets: TAILLE, ...(avecRacine ? { racine } : {}) },
          cible,
          jeton,
        );
      },
      apres: {
        instantane: () => cibles.at(-1).slice(),
        verifier: (b, avant, fautes, pause) => {
          const cible = cibles.at(-1);
          if (Buffer.compare(Buffer.from(cible), Buffer.from(avant)) !== 0) {
            fautes.push(`annulé pendant l'attente n° ${pause} : la cible a été modifiée APRÈS`);
          }
        },
      },
    });
  });
}

test("servir : une entrée corrompue, annulée pendant N'IMPORTE quelle attente, n'est pas oubliée (elle n'a rien jugé)", async () => {
  const a = artefact();
  const memoireModele = primitivesEnMemoire();
  const racine = await rangerAvant(memoireModele, a);
  // La liste de tranches est altérée : la racine recalculée ne tient plus, l'entrée serait oubliée.
  const liste = JSON.parse(
    new TextDecoder().decode(memoireModele.fichiers.get(`${a.sha256}.tranches`)),
  );
  liste.tranches[0] = "f".repeat(64);
  memoireModele.fichiers.set(
    `${a.sha256}.tranches`,
    new TextEncoder().encode(JSON.stringify(liste)),
  );
  await balayer({
    preparer: (memoire) => {
      for (const [nom, octets] of memoireModele.fichiers) memoire.fichiers.set(nom, octets.slice());
    },
    lancer: (magasin, jeton) =>
      magasin.servir({ sha256: a.sha256, octets: TAILLE, racine }, new Uint8Array(TAILLE), jeton),
  });
});

test("servir : une taille rangée fausse, annulée pendant N'IMPORTE quelle attente, rien n'est supprimé", async () => {
  const a = artefact();
  await balayer({
    preparer: (memoire) => memoire.fichiers.set(a.sha256, new Uint8Array(12)),
    lancer: (magasin, jeton) =>
      magasin.servir({ sha256: a.sha256, octets: TAILLE }, new Uint8Array(TAILLE), jeton),
  });
});

// --- purger et oublier -----------------------------------------------------------------------------

test("purger : annulée pendant N'IMPORTE quelle attente, plus aucune suppression ne part", async () => {
  const [un, deux] = ["1", "2"].map((c) => c.repeat(64));
  await balayer({
    preparer: (memoire) => {
      for (const sha of [un, deux]) {
        memoire.fichiers.set(sha, new Uint8Array(3));
        memoire.fichiers.set(`${sha}.tranches`, new Uint8Array(3));
        memoire.fichiers.set(`${sha}.partiel`, new Uint8Array(3));
      }
    },
    lancer: (magasin, jeton) => magasin.purger([], jeton),
  });
});

test("oublierLeDescripteurScelle : annulée pendant N'IMPORTE quelle attente, plus aucune suppression ne part", async () => {
  await balayer({
    preparer: (memoire) => {
      memoire.fichiers.set("descripteur.scelle", new Uint8Array(3));
      memoire.fichiers.set("descripteur.scelle.partiel", new Uint8Array(3));
    },
    lancer: (magasin, jeton) => magasin.oublierLeDescripteurScelle(jeton),
  });
});

// Garde-fou du balayage lui-même : sans annulation, tout va à son terme.
test("sans annulation, les opérations vont à leur terme (le balayage ne dit pas n'importe quoi)", async () => {
  const { octets, sha256 } = artefact();
  const b = banc({ jeton: { annule: false } });
  const admis = await b.magasin.admettre({ sha256, octets }, { annule: false });
  assert.deepEqual(admis.racine, await racineDesTranches(await empreintesDeTranches(octets)));
  assert.equal(b.memoire.fichiers.has(sha256), true);
});
