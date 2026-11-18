import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "../support/test.mjs";

// FRONTIÈRE du DESCRIPTEUR SCELLÉ, sur les trois moteurs (#247, D1g ; ADR 0045).
//
// Le scellement s'appuie sur la PLATE-FORME : HKDF-SHA-256 puis un HMAC dont la clé est NON
// EXTRACTIBLE, que `crypto.subtle.sign` et `verify` seuls savent employer — jamais `encrypt`, jamais
// `exportKey`. Un garanti qui repose sur le moteur se mesure SUR le moteur, et sur les trois : une
// suite sous Node dirait ce que `node:crypto` fait, pas ce que le produit exécute.
//
// Le second pan est le vrai OPFS : le descripteur est rangé par renommage, relu à l'octet près, remplacé
// par un plus court sans en garder un seul octet, et un fichier ALTÉRÉ dans l'OPFS — par quelqu'un qui
// n'a pas la clé — est refusé. Sur un moteur sans OPFS, la suite n'est pas ignorée : elle exige le
// repli documenté (`ouvrirLeMagasinOpfs()` rend `null`, le démarrage télécharge), comme
// `opfs-block-backend.spec.mjs` le fait pour WebKit.
//
// Aucun artefact v86, aucun volume : les trois moteurs sont toujours exécutés, quelques secondes.
//
// Ce qu'elles ne mesurent PAS : que le démarrage hors connexion aboutisse sur l'image réelle
// (`tests/e2e/hors-ligne.spec.mjs`), ni les gardes du repli — `tools/muter-gardes-hors-ligne.mjs`.

/** Trente-deux octets publics, sans entropie : la clé de TEST du dépôt. Elle ne protège rien. */
const COFFRE_A = Array.from({ length: 32 }, (_, index) => index + 1);
const COFFRE_B = Array.from({ length: 32 }, (_, index) => 200 - index);
const IDENTIFIANT = "21282f363d444b525960676e757c838a";

test.beforeEach(async ({ page }) => {
  await page.goto("/");
  expect(
    await page.evaluate(() => globalThis.isSecureContext && typeof crypto?.subtle === "object"),
    "le contexte doit être sécurisé et offrir crypto.subtle",
  ).toBe(true);
});

/** Un descripteur v2 admis par `formeDuDescripteur`, posé à la main dans la page. */
const DESCRIPTEUR = {
  descripteurVersion: 2,
  application: { id: "railsbox-vault-reference", version: "1.0.0", schema: "20260815120000" },
  runtime: { version: "0.1.0" },
  rootfs: { nom: "r.ext4", octets: 4096, sha256: "a".repeat(64) },
  paquet: { nom: "p.ext4", octets: 4096, sha256: "b".repeat(64) },
  graine: { nom: "g.ext4", octets: 8192, sha256: "c".repeat(64), disqueOctets: 8192 },
  boot: {
    cmdline: "root=/dev/sda1 rw console=ttyS0 init=/opt/vault/guest-init.sh",
    memoireOctets: 33554432,
    kernel: "k",
    initrd: "i",
    bios: "seabios.bin",
    vgaBios: "vgabios.bin",
  },
  prefixeDesArtefacts: "/artifacts/epreuve/",
};
const MANIFESTE_V86 = { artifacts: [{ name: "v86.wasm", bytes: 10, sha256: "8".repeat(64) }] };

test("la clé de scellement est un HMAC non extractible : sign et verify, jamais encrypt ni export", async ({
  page,
}) => {
  const rendu = await page.evaluate(
    async ({ coffre, identifiant }) => {
      const { deriverCleDeScellementDuDescripteur } =
        await import("/src/vm/derivation/cle-du-descripteur-scelle.mjs");
      const cle = await deriverCleDeScellementDuDescripteur({
        cleMaitresse: new Uint8Array(coffre),
        identifiantVolume: identifiant,
      });
      const essai = async (action) => {
        try {
          await action();
          return "accepte";
        } catch (erreur) {
          return erreur.name;
        }
      };
      return {
        algorithme: cle.algorithm.name,
        hachage: cle.algorithm.hash.name,
        usages: [...cle.usages].sort(),
        extractible: cle.extractable,
        export: await essai(() => crypto.subtle.exportKey("raw", cle)),
        chiffrement: await essai(() =>
          crypto.subtle.encrypt(
            { name: "AES-GCM", iv: new Uint8Array(12) },
            cle,
            new Uint8Array(8),
          ),
        ),
        signature: await essai(() => crypto.subtle.sign("HMAC", cle, new Uint8Array(8))),
      };
    },
    { coffre: COFFRE_A, identifiant: IDENTIFIANT },
  );
  expect(rendu.algorithme).toBe("HMAC");
  expect(rendu.hachage).toBe("SHA-256");
  expect(rendu.usages).toEqual(["sign", "verify"]);
  expect(rendu.extractible).toBe(false);
  expect(rendu.export, "une clé non extractible ne sort pas de WebCrypto").not.toBe("accepte");
  expect(rendu.chiffrement, "un HMAC ne chiffre pas").not.toBe("accepte");
  expect(rendu.signature).toBe("accepte");
});

test("scellé, rouvert ; altéré, fabriqué, d'un autre coffre ou non scellé : refusé — sur le vrai WebCrypto", async ({
  page,
}) => {
  const rendu = await page.evaluate(
    async ({ coffreA, coffreB, identifiant, descripteur, manifesteV86 }) => {
      const { deriverCleDeScellementDuDescripteur } =
        await import("/src/vm/derivation/cle-du-descripteur-scelle.mjs");
      const { sceller, ouvrirLeDescripteurScelle } =
        await import("/src/coquille/descripteur-scelle.mjs");
      const cleDe = (octets) =>
        deriverCleDeScellementDuDescripteur({
          cleMaitresse: new Uint8Array(octets),
          identifiantVolume: identifiant,
        });
      const clesA = await cleDe(coffreA);
      const clesB = await cleDe(coffreB);
      const issue = async (octets, cle) => {
        try {
          const ouvert = await ouvrirLeDescripteurScelle({ octets, cle });
          return {
            ok: true,
            version: ouvert.descripteur.application.version,
            date: ouvert.rangeLe,
          };
        } catch (erreur) {
          return { ok: false, code: erreur.code, raison: erreur.contexte?.raison };
        }
      };
      const scelle = await sceller({
        descripteur,
        manifesteV86,
        rangeLe: 1_700_000_000_000,
        cle: clesA,
      });
      const altere = scelle.slice();
      altere[Math.floor(altere.byteLength / 2)] ^= 0x01;
      const dateAlteree = scelle.slice();
      new DataView(dateAlteree.buffer).setBigUint64(8, 1_700_000_000_001n);
      const fabrique = await sceller({
        descripteur: {
          ...descripteur,
          application: { ...descripteur.application, version: "9.9.9" },
        },
        manifesteV86,
        rangeLe: 1,
        cle: clesB,
      });
      const brut = new TextEncoder().encode(JSON.stringify(descripteur));
      return {
        valide: await issue(scelle, clesA),
        altere: await issue(altere, clesA),
        dateAlteree: await issue(dateAlteree, clesA),
        autreCoffre: await issue(scelle, clesB),
        fabrique: await issue(fabrique, clesA),
        nonScelle: await issue(brut, clesA),
        tronque: await issue(scelle.subarray(0, scelle.byteLength - 1), clesA),
      };
    },
    {
      coffreA: COFFRE_A,
      coffreB: COFFRE_B,
      identifiant: IDENTIFIANT,
      descripteur: DESCRIPTEUR,
      manifesteV86: MANIFESTE_V86,
    },
  );
  const REFUS = "VAULT_COQUILLE_HORS_LIGNE_DESCRIPTEUR_REFUSE";
  expect(rendu.valide).toEqual({ ok: true, version: "1.0.0", date: 1_700_000_000_000 });
  expect(rendu.altere).toEqual({ ok: false, code: REFUS, raison: "sceau" });
  expect(rendu.dateAlteree).toEqual({ ok: false, code: REFUS, raison: "sceau" });
  expect(rendu.autreCoffre).toEqual({ ok: false, code: REFUS, raison: "sceau" });
  expect(rendu.fabrique).toEqual({ ok: false, code: REFUS, raison: "sceau" });
  expect(rendu.nonScelle).toEqual({ ok: false, code: REFUS, raison: "format" });
  expect(rendu.tronque).toEqual({ ok: false, code: REFUS, raison: "format" });
});

/** Ce que le moteur offre au produit : l'OPFS, et le chemin d'écriture que le magasin y emploie. */
async function capaciteOpfs(page) {
  return page.evaluate(async () => {
    const getDirectory = typeof navigator.storage?.getDirectory === "function";
    if (!getDirectory) return { getDirectory, ecriture: false };
    try {
      const racine = await navigator.storage.getDirectory();
      const fichier = await racine.getFileHandle("sonde-descripteur", { create: true });
      const ecriture = typeof fichier.createWritable === "function";
      await racine.removeEntry("sonde-descripteur").catch(() => {});
      return { getDirectory, ecriture };
    } catch (erreur) {
      // L'OPFS existe mais refuse à la page de s'en servir : mesuré, pas deviné.
      return { getDirectory, ecriture: false, refus: erreur.name };
    }
  });
}

test("rangé dans le vrai OPFS, relu à l'octet près, remplacé sans reste ; altéré dans l'OPFS, refusé", async ({
  page,
}, testInfo) => {
  const capacite = await capaciteOpfs(page);
  await testInfo.attach(`opfs-descripteur-${testInfo.project.name}.json`, {
    body: JSON.stringify(capacite, null, 2),
    contentType: "application/json",
  });
  if (!capacite.getDirectory || !capacite.ecriture) {
    // Un moteur sans OPFS écrivable depuis la page : le repli documenté, mesuré — pas une épreuve sautée.
    const rendu = await page.evaluate(async () => {
      const { ouvrirLeMagasinOpfs } = await import("/src/vm/magasin-opfs.mjs");
      const stockage = navigator.storage?.getDirectory ? navigator.storage : {};
      return ouvrirLeMagasinOpfs({ stockage }) === null;
    });
    expect(rendu, "sans OPFS, pas de magasin : le démarrage télécharge").toBe(
      !capacite.getDirectory,
    );
    return;
  }
  const rendu = await page.evaluate(
    async ({ coffre, identifiant, descripteur, manifesteV86 }) => {
      const { deriverCleDeScellementDuDescripteur } =
        await import("/src/vm/derivation/cle-du-descripteur-scelle.mjs");
      const { sceller, ouvrirLeDescripteurScelle } =
        await import("/src/coquille/descripteur-scelle.mjs");
      const { ouvrirLeMagasinOpfs } = await import("/src/vm/magasin-opfs.mjs");
      const { DOSSIER_DU_MAGASIN } = await import("/src/vm/magasin-d-artefacts.mjs");
      const racine = await navigator.storage.getDirectory();
      await racine.removeEntry(DOSSIER_DU_MAGASIN, { recursive: true }).catch(() => {});
      const magasin = ouvrirLeMagasinOpfs();
      const cle = await deriverCleDeScellementDuDescripteur({
        cleMaitresse: new Uint8Array(coffre),
        identifiantVolume: identifiant,
      });
      const octets = await sceller({ descripteur, manifesteV86, rangeLe: 42, cle });
      const sortie = { absentAuDepart: (await magasin.lireLeDescripteurScelle()) === null };

      await magasin.ecrireLeDescripteurScelle(octets);
      const relu = await magasin.lireLeDescripteurScelle();
      sortie.identique =
        relu.byteLength === octets.byteLength && relu.every((o, i) => o === octets[i]);
      sortie.ouvert = (await ouvrirLeDescripteurScelle({ octets: relu, cle })).rangeLe;

      // Un descripteur plus COURT remplace le précédent sans en garder un seul octet.
      const court = await sceller({
        descripteur: { ...descripteur, runtime: { version: "0" } },
        manifesteV86,
        rangeLe: 43,
        cle,
      });
      await magasin.ecrireLeDescripteurScelle(court);
      const dossier = await racine.getDirectoryHandle(DOSSIER_DU_MAGASIN);
      const fichier = await (await dossier.getFileHandle("descripteur.scelle")).getFile();
      sortie.tailleApresRemplacement = fichier.size;
      sortie.tailleAttendue = court.byteLength;
      const noms = [];
      for await (const [nom] of dossier.entries()) noms.push(nom);
      sortie.noms = noms.sort();

      // Quelqu'un qui écrit dans l'OPFS sans la clé : un octet changé, refusé à l'ouverture.
      const abime = new Uint8Array(await fichier.arrayBuffer());
      abime[Math.floor(abime.byteLength / 2)] ^= 0x01;
      await magasin.ecrireLeDescripteurScelle(abime);
      try {
        await ouvrirLeDescripteurScelle({ octets: await magasin.lireLeDescripteurScelle(), cle });
        sortie.refusApresAlteration = null;
      } catch (erreur) {
        sortie.refusApresAlteration = erreur.contexte?.raison ?? erreur.message;
      }

      // La rétention ne retire pas le descripteur rangé.
      await magasin.retenir({ rootfs: "a".repeat(64), paquet: "b".repeat(64) });
      sortie.gardeApresRetention = (await magasin.lireLeDescripteurScelle()) !== null;
      await racine.removeEntry(DOSSIER_DU_MAGASIN, { recursive: true }).catch(() => {});
      return sortie;
    },
    {
      coffre: COFFRE_A,
      identifiant: IDENTIFIANT,
      descripteur: DESCRIPTEUR,
      manifesteV86: MANIFESTE_V86,
    },
  );
  expect(rendu.absentAuDepart).toBe(true);
  expect(rendu.identique).toBe(true);
  expect(rendu.ouvert).toBe(42);
  expect(rendu.tailleApresRemplacement).toBe(rendu.tailleAttendue);
  expect(rendu.noms, "aucun partiel ne reste").toEqual(["descripteur.scelle"]);
  expect(rendu.refusApresAlteration).toBe("sceau");
  expect(rendu.gardeApresRetention).toBe(true);
});

test("le constat de la page, réseau coupé : refus typés selon ce que l'OPFS garde — vrai WebCrypto, vrai OPFS", async ({
  page,
}) => {
  const capacite = await capaciteOpfs(page);
  const avecOpfs = capacite.getDirectory && capacite.ecriture;
  const rendu = await page.evaluate(
    async ({ coffre, coffreB, descripteur, manifesteV86, avecOpfs }) => {
      const { dephasagePourLaPage } = await import("/src/coquille/application-de-reference.mjs");
      const { deriverCleDeScellementDuDescripteur } =
        await import("/src/vm/derivation/cle-du-descripteur-scelle.mjs");
      const { sceller } = await import("/src/coquille/descripteur-scelle.mjs");
      const { ouvrirLeMagasinOpfs } = await import("/src/vm/magasin-opfs.mjs");
      const { DOSSIER_DU_MAGASIN } = await import("/src/vm/magasin-d-artefacts.mjs");
      const racine = avecOpfs ? await navigator.storage.getDirectory() : null;
      const repartir = () =>
        racine?.removeEntry(DOSSIER_DU_MAGASIN, { recursive: true }).catch(() => {});
      const reseauCoupe = async () => {
        throw new TypeError("Failed to fetch");
      };
      const constater = async (dek) => {
        const resultat = await dephasagePourLaPage({
          cleDeVolume: async () => new Uint8Array(dek),
          recuperer: reseauCoupe,
          magasin: avecOpfs ? ouvrirLeMagasinOpfs() : null,
          lireManifeste: async () => null, // un coffre sans volume : rien n'est installé hors connexion
        });
        return resultat.code ?? resultat.issue;
      };
      const ranger = async (dekDuScellement) => {
        const cle = await deriverCleDeScellementDuDescripteur({
          cleMaitresse: new Uint8Array(dekDuScellement),
          identifiantVolume: "00112233445566778899aabbccddeeff",
        });
        return sceller({ descripteur, manifesteV86, rangeLe: 5, cle });
      };
      const sortie = {};
      await repartir();
      sortie.sansCopie = await constater(coffre);
      // Sans OPFS, il n'y a rien à ranger : le refus « sans copie » est le seul constat possible.
      if (!avecOpfs) return sortie;
      // Un descripteur scellé par un AUTRE coffre : refusé, et le refus est typé.
      await ouvrirLeMagasinOpfs().ecrireLeDescripteurScelle(await ranger(coffreB));
      sortie.refuse = await constater(coffre);
      await repartir();
      return sortie;
    },
    {
      coffre: COFFRE_A,
      coffreB: COFFRE_B,
      descripteur: DESCRIPTEUR,
      manifesteV86: MANIFESTE_V86,
      avecOpfs,
    },
  );
  expect(rendu.sansCopie).toBe("VAULT_COQUILLE_HORS_LIGNE_SANS_COPIE");
  if (avecOpfs) expect(rendu.refuse).toBe("VAULT_COQUILLE_HORS_LIGNE_DESCRIPTEUR_REFUSE");
});

// --- Une redirection est une RÉPONSE de l'origine : jamais le repli (revue de #298, constat 1) ----
//
// Le navigateur rend `opaqueredirect` en mode manuel, et lève un `TypeError` sur une boucle quand il
// suit : seul le vrai moteur dit ce que le produit reçoit. Un VRAI serveur, dans ce processus, sert
// la coquille (`/src/`) ET répond sur `/artifacts/application.json` — même origine, comme en
// production (la CSP interdit d'ailleurs un `fetch` vers une autre) — par une boucle de 302, par un
// 301 vers une autre origine, puis ne répond plus du tout : le seul cas du repli.

const RACINE = fileURLToPath(new URL("../..", import.meta.url));

/** Un serveur HTTP local ; `reponse(req, res)` répond, sinon le serveur de fichiers de `/src/`. */
async function serveurLocal(reponse) {
  const compteur = { requetes: 0 };
  const http = createServer(async (req, res) => {
    compteur.requetes += 1;
    if (reponse(req, res) !== false) return;
    if (req.url === "/") {
      res
        .writeHead(200, { "content-type": "text/html" })
        .end("<!doctype html><title>origine</title>");
      return;
    }
    const chemin = join(RACINE, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (!req.url.startsWith("/src/") || !chemin.startsWith(join(RACINE, "src"))) {
      res.writeHead(404).end();
      return;
    }
    const octets = await readFile(chemin).catch(() => null);
    if (octets === null) res.writeHead(404).end();
    else res.writeHead(200, { "content-type": "text/javascript" }).end(octets);
  });
  await new Promise((resolve) => http.listen(0, "127.0.0.1", resolve));
  return {
    origine: `http://127.0.0.1:${http.address().port}`,
    compteur,
    arreter: () => new Promise((resolve) => (http.closeAllConnections(), http.close(resolve))),
  };
}

/** Ce que `lireLeDescripteur` rend dans la page, avec le `fetch` du navigateur et un repli espion. */
const lireLeDescripteurDeLaPage = (page) =>
  page.evaluate(async () => {
    const { lireLeDescripteur } = await import("/src/coquille/descripteur-applicatif.mjs");
    let appels = 0;
    const lu = await lireLeDescripteur({
      repliHorsConnexion: async () => {
        appels += 1;
        return { present: false, horsConnexion: true, code: "REPLI", motif: "repli" };
      },
    });
    return { present: lu.present, motif: lu.motif, repli: appels };
  });

test("une boucle de 302 ou un 301 vers une autre origine n'ouvre pas le repli ; une connexion refusée l'ouvre", async ({
  page,
}) => {
  const ailleurs = await serveurLocal((req, res) => {
    res.writeHead(200).end("{}");
  });
  let mode = "boucle";
  const origine = await serveurLocal((req, res) => {
    if (req.url !== "/artifacts/application.json") return false;
    if (mode === "boucle") res.writeHead(302, { location: req.url }).end();
    else res.writeHead(301, { location: `${ailleurs.origine}${req.url}` }).end();
  });
  try {
    await page.goto(`${origine.origine}/`); // une page vide de cette origine, rien de plus
    const enBoucle = await lireLeDescripteurDeLaPage(page);
    expect(enBoucle.repli, "une boucle de 302 est une réponse de l'origine").toBe(0);
    expect(enBoucle.present).toBe(false);
    expect(enBoucle.motif).toMatch(/redirig/);

    mode = "croisee";
    const versUneAutre = await lireLeDescripteurDeLaPage(page);
    expect(versUneAutre.repli).toBe(0);
    expect(versUneAutre.motif).toMatch(/redirig/);
    expect(ailleurs.compteur.requetes, "la redirection n'est pas suivie").toBe(0);

    await origine.arreter();
    const refusee = await lireLeDescripteurDeLaPage(page);
    expect(refusee.repli, "pas de réponse du tout : le repli").toBe(1);
  } finally {
    await Promise.all([origine.arreter(), ailleurs.arreter()]);
  }
});
