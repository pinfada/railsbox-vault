// LE TÉLÉCHARGEMENT ANTICIPÉ du premier démarrage (#348).
//
// Constat de départ : les artefacts du boot — wasm, BIOS, VGA BIOS, noyau, initrd, rootfs, paquet —
// n'étaient demandés qu'au clic sur « Démarrer l'application », à l'étape 4. Pendant les étapes 1 à 3,
// la personne choisit sa phrase et recopie son code : ce temps était perdu.
//
// Ce que cette épreuve mesure, dans Chromium et sans machine virtuelle :
//
//  1. dès l'OUVERTURE du parcours, avant le moindre geste — donc avant la création du coffre —, chaque
//     artefact est demandé UNE fois, vérifié, et rangé au magasin sous son empreinte ;
//  2. au clic sur « Démarrer », l'étape 4 n'en redemande AUCUN : elle sert ce qui est déjà vérifié.
//
// Le module v86 et son wasm sont ceux d'un manifeste d'ÉPREUVE (le module refuse de construire une
// machine) : le démarrage va jusqu'au bout de l'acquisition, puis échoue avant tout boot. C'est
// l'acquisition qui est mesurée ici, pas le boot.

import { createHash } from "node:crypto";

import { expect, test } from "../support/test.mjs";

import { SHELL_ORIGIN } from "../../src/spike/origin-topology.mjs";
import { adresseDe } from "../../src/v86-adresses.mjs";

const DELAI = 90_000;
const PHRASE = "marqueur-de-phrase-du-parcours-348-une-phrase-assez-longue";
const FORME_DU_CODE = /^[0-9A-HJKMNP-TV-Z]{4}(-[0-9A-HJKMNP-TV-Z]{4}){6}$/;
const PREFIXE = "/artifacts/telechargement-anticipe/";

const ecran = (page, titre) => page.getByRole("heading", { level: 2, name: titre, exact: true });
const bouton = (page, nom) => page.getByRole("button", { name: nom, exact: true });

const sha256 = (octets) => createHash("sha256").update(octets).digest("hex");
const octetsDe = (taille, motif) => Buffer.alloc(taille, motif);

/** Un module v86 d'ÉPREUVE : il s'importe, et refuse de construire une machine. */
const LIBV86 = Buffer.from(
  'export class V86 { constructor() { throw new Error("V86 d\'épreuve : aucun boot (#348)."); } }\n',
);
const WASM = octetsDe(4096, 0x57);

/** Les artefacts servis par l'origine, sous leur nom, et leur empreinte. */
const ARTEFACTS = Object.freeze({
  kernel: { nom: "k.bin", octets: octetsDe(6000, 0x11) },
  initrd: { nom: "i.bin", octets: octetsDe(9000, 0x22) },
  bios: { nom: "seabios.bin", octets: octetsDe(1310, 0x33) },
  vgaBios: { nom: "vgabios.bin", octets: octetsDe(389, 0x44) },
  rootfs: { nom: "r.ext4", octets: octetsDe(8192, 0x55) },
  paquet: { nom: "p.ext4", octets: octetsDe(8192, 0x66) },
});
const GRAINE = octetsDe(8 * 4096, 0x42);

const epingle = ({ octets }) => ({ sha256: sha256(octets), octets: octets.byteLength });

/** Le manifeste v86 d'épreuve : deux artefacts, épinglés sur les octets ci-dessus. */
const MANIFESTE_V86 = {
  contract: { id: "railsbox-vault-vendor-v86", version: 1 },
  artifacts: [
    { name: "libv86.mjs", bytes: LIBV86.byteLength, sha256: sha256(LIBV86) },
    { name: "v86.wasm", bytes: WASM.byteLength, sha256: sha256(WASM) },
  ],
};
const ADRESSE_LIBV86 = adresseDe("libv86.mjs", sha256(LIBV86));
const ADRESSE_WASM = adresseDe("v86.wasm", sha256(WASM));

function descripteurDEpreuve() {
  const morceau = (cle) => ({ nom: ARTEFACTS[cle].nom, ...epingle(ARTEFACTS[cle]) });
  return {
    descripteurVersion: 3,
    application: { id: "telechargement-anticipe", version: "1.0.0", schema: "20260101000002" },
    runtime: { version: "0.1.0" },
    rootfs: morceau("rootfs"),
    paquet: morceau("paquet"),
    graine: {
      nom: "graine.ext4",
      octets: GRAINE.byteLength,
      sha256: sha256(GRAINE),
      disqueOctets: GRAINE.byteLength,
    },
    boot: {
      cmdline: "root=/dev/sda1 rw console=ttyS0 init=/opt/vault/guest-init.sh",
      memoireOctets: 33554432,
      kernel: ARTEFACTS.kernel.nom,
      initrd: ARTEFACTS.initrd.nom,
      bios: ARTEFACTS.bios.nom,
      vgaBios: ARTEFACTS.vgaBios.nom,
      empreintes: {
        kernel: epingle(ARTEFACTS.kernel),
        initrd: epingle(ARTEFACTS.initrd),
        bios: epingle(ARTEFACTS.bios),
        vgaBios: epingle(ARTEFACTS.vgaBios),
      },
    },
    prefixeDesArtefacts: PREFIXE,
  };
}

/**
 * Sert le descripteur, le manifeste v86, le module, le wasm, la graine et les six artefacts, et COMPTE
 * les demandes de chacun. Rend le compte, que l'épreuve lit à chaque instant.
 */
async function servirLOrigine(page) {
  const demandes = {};
  const compter = (nom) => (demandes[nom] = (demandes[nom] ?? 0) + 1);
  const servir =
    (corps, type = "application/octet-stream") =>
    (route) =>
      route.fulfill({ status: 200, contentType: type, body: corps });
  const contexte = page.context();
  await contexte.route(
    "**/artifacts/application.json",
    servir(JSON.stringify(descripteurDEpreuve()), "application/json"),
  );
  await contexte.route(
    "**/vendor/v86/MANIFEST.json",
    servir(JSON.stringify(MANIFESTE_V86), "application/json"),
  );
  await contexte.route(`**${ADRESSE_LIBV86}`, servir(LIBV86, "text/javascript"));
  await contexte.route(`**${ADRESSE_WASM}`, (route) => {
    compter("wasm");
    return servir(WASM, "application/wasm")(route);
  });
  await contexte.route(`**${PREFIXE}graine.ext4`, servir(GRAINE));
  for (const [cle, { nom, octets }] of Object.entries(ARTEFACTS)) {
    await contexte.route(`**${PREFIXE}${nom}`, (route) => {
      compter(cle);
      return servir(octets)(route);
    });
  }
  return demandes;
}

/** Les empreintes rangées au magasin d'artefacts de l'origine (`vault-artefacts/`). */
async function empreintesRangees(page) {
  return page.evaluate(async () => {
    try {
      const racine = await navigator.storage.getDirectory();
      const dossier = await racine.getDirectoryHandle("vault-artefacts");
      const noms = [];
      for await (const [nom, entree] of dossier.entries()) {
        if (entree.kind === "file" && /^[0-9a-f]{64}$/.test(nom)) noms.push(nom);
      }
      return noms.sort();
    } catch {
      return [];
    }
  });
}

const TOUS = ["wasm", ...Object.keys(ARTEFACTS)].sort();
const UNE_FOIS_CHACUN = Object.fromEntries(TOUS.map((nom) => [nom, 1]));
const EMPREINTES_ATTENDUES = [
  sha256(WASM),
  ...Object.values(ARTEFACTS).map((a) => sha256(a.octets)),
].sort();

/** Crée le coffre par la phrase, éprouve la feuille par son code : mène à l'étape 4. */
async function jusquALEtape4(page) {
  await bouton(page, "Commencer").click();
  await page.getByLabel("Votre phrase", { exact: true }).fill(PHRASE);
  await bouton(page, "Créer mon coffre").click();
  await bouton(page, "Afficher mon code de récupération").click({ timeout: DELAI });
  const code = ((await page.getByText(FORME_DU_CODE).textContent()) ?? "").trim();
  await bouton(page, "J'ai recopié mon code").click();
  const recharge = page.waitForEvent("load");
  await bouton(page, "Verrouiller mon coffre").click();
  await recharge;
  await page.getByLabel("Code de récupération", { exact: true }).fill(code, { timeout: DELAI });
  await bouton(page, "Ouvrir mon coffre avec le code").click();
  await expect(ecran(page, "Travailler dans l'application")).toBeVisible({ timeout: DELAI });
}

test("#348 : les artefacts sont téléchargés dès l'ouverture du parcours, et l'étape 4 ne les redemande pas", async ({
  page,
  browserName,
}) => {
  test.skip(browserName !== "chromium", "requêtes HTTP et OPFS réels : un moteur suffit");
  test.setTimeout(240_000);
  const demandes = await servirLOrigine(page);
  await page.goto(new URL("/index.html", SHELL_ORIGIN).toString(), { waitUntil: "commit" });
  await expect(ecran(page, "Créer votre coffre")).toBeVisible({ timeout: DELAI });

  // AVANT tout geste — aucune phrase, aucun coffre : chaque artefact est demandé une fois, vérifié et
  // rangé sous son empreinte. Relevé SANS arrêter l'épreuve : la suite dit ce que fait l'étape 4.
  await expect
    .soft(async () => expect(await empreintesRangees(page)).toEqual(EMPREINTES_ATTENDUES), {
      message: "les artefacts doivent être rangés au magasin dès l'ouverture du parcours",
    })
    .toPass({ timeout: 30_000 });
  const avantLePremierGeste = { ...demandes };
  await expect(ecran(page, "Créer votre coffre")).toBeVisible();

  await jusquALEtape4(page);
  const avantLeClic = { ...demandes };

  // L'étape 4 va au bout de l'acquisition, puis le module d'épreuve refuse de construire la machine.
  await bouton(page, "Démarrer l'application").click();
  await expect(page.locator("#cycle-etat")).not.toHaveText(/demarrage-en-cours|^$/, {
    timeout: DELAI,
  });
  // Les trois relevés ENSEMBLE. Sans le téléchargement anticipé, les deux premiers sont vides et le
  // troisième porte une demande par artefact : tout part au clic de l'étape 4.
  expect({ avantLePremierGeste, avantLeClic, apresLeClic: { ...demandes } }).toEqual({
    avantLePremierGeste: UNE_FOIS_CHACUN,
    avantLeClic: UNE_FOIS_CHACUN,
    apresLeClic: UNE_FOIS_CHACUN,
  });
});
