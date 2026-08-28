// L'ORDRE des gestes d'un export : RÉCUPÉRER, puis copier (#101, ADR 0008, ADR 0014).
//
// Le défaut que ces épreuves figent a été trouvé par exécution, sur
// `tests/e2e/restauration-inter-origine.spec.mjs` : le fichier restauré sur l'origine B était
// byte-exact avec celui de A, et leurs CLAIRS différaient. La raison tient en une phrase : depuis
// #16, une génération VALIDÉE vit dans le journal voisin jusqu'à ce qu'une ouverture
// transactionnelle la rejoue dans le volume, si bien que copier le fichier tel quel dans cet
// intervalle produit une archive à laquelle il manque une écriture ACQUITTÉE — sans que rien ne le
// signale.
//
// Ce qui est mesuré ici est l'ORDRE, parce que c'est lui le contrat : une récupération faite APRÈS
// la copie ne servirait à rien, et une copie faite sans récupération est le défaut lui-même. Ce que
// la récupération produit sur les octets est mesuré ailleurs — par le scénario de bout en bout, sur
// le vrai support, avec un vrai boot Rails derrière.

import assert from "node:assert/strict";
import test from "node:test";

import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { ouvrirPourExport } from "../../src/vm/export-du-fichier.mjs";

/** Journalise les gestes dans l'ordre où ils arrivent, et rien d'autre. */
function bancDeGestes({ rapport = null, echouerALaRecuperation = null } = {}) {
  const gestes = [];
  // Le fichier d'épreuve : un en-tête v3 nul (donc sans identifiant lisible) et une taille stable.
  // Le CONSTAT qui suit la reprise du bail porte sur ces deux grandeurs — voir `ouvrirPourExport`.
  const TAILLE = 512 + 512 + 4096;
  const brut = {
    name: "app",
    ferme: false,
    size: () => TAILLE,
    read: async (offset, longueur) => new Uint8Array(longueur),
  };
  return {
    gestes,
    brut,
    recuperer: async ({ name, cle }) => {
      gestes.push(`recuperer:${name}:${cle === CLE_DE_TEST ? "avec-cle" : "sans-cle"}`);
      if (echouerALaRecuperation) throw echouerALaRecuperation;
      return {
        generation: { rapport },
        size: () => 4096,
        lireSupportBrut: async (offset, longueur) => new Uint8Array(longueur),
        close: async () => {
          gestes.push("fermer");
        },
      };
    },
    ouvrirBrut: async ({ name }) => {
      gestes.push(`brut:${name}`);
      return brut;
    },
  };
}

test("la récupération précède la copie, et le volume est REFERMÉ entre les deux", async () => {
  const banc = bancDeGestes();
  const { brut } = await ouvrirPourExport({ name: "app", cle: CLE_DE_TEST, ...banc });

  assert.deepEqual(banc.gestes, ["recuperer:app:avec-cle", "fermer", "brut:app"]);
  assert.equal(brut, banc.brut, "l'accès rendu est bien celui du fichier, pas le backend");
});

test("le rapport de récupération est PUBLIÉ : une génération rejouée est une nouvelle", async () => {
  // Une génération écartée ou rejouée change ce que l'archive contient. La taire ferait d'un export
  // un geste dont l'exploitant ne saurait pas ce qu'il a emporté.
  const rapport = { etat: "rejouee", generation: 7 };
  const banc = bancDeGestes({ rapport });
  const rendu = await ouvrirPourExport({ name: "app", cle: CLE_DE_TEST, ...banc });
  assert.deepEqual(rendu.rapport, rapport);
});

test("un volume qui n'a jamais eu de journal n'a pas de rapport, et ce n'est pas une erreur", async () => {
  const banc = bancDeGestes({ rapport: undefined });
  const rendu = await ouvrirPourExport({ name: "app", cle: CLE_DE_TEST, ...banc });
  assert.equal(rendu.rapport, null);
});

test("un volume d'un format ANTÉRIEUR est copié sans récupération, faute d'ouvreur", async () => {
  // Son fichier ne s'ouvre pas par l'ouvreur v3 : il n'a pas d'en-tête. Et il ne peut pas porter une
  // génération que ce runtime aurait validée sans l'appliquer, puisque ce runtime refuse de l'écrire
  // (`VAULT_MANIFEST_MIGRATION_REQUIRED`). C'est le cas de la SAUVEGARDE exigée avant migration.
  const banc = bancDeGestes();
  const rendu = await ouvrirPourExport({
    name: "app",
    cle: CLE_DE_TEST,
    formatVersion: 2,
    ...banc,
  });
  assert.deepEqual(banc.gestes, ["brut:app"], "aucune récupération n'est tentée");
  assert.equal(rendu.rapport, null);
});

test("une récupération qui ÉCHOUE n'ouvre pas le fichier : on n'exporte pas un état inconnu", async () => {
  // C'est la moitié la plus importante de l'ordre. Si la récupération refuse — racine abîmée,
  // sceau rejeté —, on ne sait pas quel est le dernier état validé ; copier le fichier produirait
  // une archive dont personne ne peut dire ce qu'elle contient.
  const refus = Object.assign(new Error("racine abîmée"), {
    code: "VAULT_STORAGE_GENERATION_ROOT_CORRUPT",
  });
  const banc = bancDeGestes({ echouerALaRecuperation: refus });

  await assert.rejects(
    () => ouvrirPourExport({ name: "app", cle: CLE_DE_TEST, ...banc }),
    (erreur) => erreur === refus,
  );
  assert.deepEqual(banc.gestes, ["recuperer:app:avec-cle"], "le fichier n'a même pas été ouvert");
});

test("un fichier qui a CHANGÉ entre la récupération et la copie fait refuser l'export", async () => {
  // Le bail exclusif est rompu entre `close()` et l'ouverture brute : `createSyncAccessHandle` est
  // exclusif par fichier, et le rendre est la seule façon d'en laisser prendre un autre. L'archive
  // déclare pourtant `handle-exclusif`. On ne peut pas tenir le bail ; ce qu'on peut, c'est
  // CONSTATER que le fichier repris est bien celui qu'on vient de refermer — et le refuser sinon.
  //
  // Ce contrôle attrape le remplacement et le retaillage, pas une écriture au milieu du fichier :
  // il rend le franchissement de l'intervalle VISIBLE, il ne le rend pas impossible.
  const banc = bancDeGestes();
  const retaille = {
    ...banc,
    ouvrirBrut: async ({ name }) => {
      banc.gestes.push(`brut:${name}`);
      return { ...banc.brut, size: () => 12345 };
    },
  };

  await assert.rejects(
    () => ouvrirPourExport({ name: "app", cle: CLE_DE_TEST, ...retaille }),
    (erreur) => {
      assert.equal(erreur.code, "VAULT_STORAGE_IDENTITE_VOLUME");
      assert.match(erreur.message, /a changé entre la récupération et la copie/);
      return true;
    },
  );
});
