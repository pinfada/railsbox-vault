import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { platform, release } from "node:os";
import { fileURLToPath } from "node:url";

import { expect, test } from "../support/test.mjs";

/**
 * Sonde du spike #185 : AES-GCM-SIV est-il exposé par WebCrypto, sur l'un des trois moteurs ?
 *
 * L'ADR 0033, décision 7, écrit que « AES-GCM-SIV n'est exposé par WebCrypto sur aucun des trois
 * moteurs » et demande de le CONSTATER plutôt que de le supposer. C'est ce que fait ce fichier, et
 * il publie le refus TEL QUEL — nom et message de l'exception, moteur par moteur, dans la page et
 * dans le Worker. Un refus recopié de mémoire n'est pas une mesure ; un moteur qui se mettrait à
 * l'exposer ferait rougir l'assertion finale, ce qui est exactement le signal attendu.
 *
 * La sonde interroge aussi AES-CTR, qui n'est pas un ornement : c'est la seule primitive par
 * laquelle un AES-GCM-SIV conforme peut être COMPOSÉ sans dépendance tierce (voir
 * `tools/spike-gcm-siv/gcm-siv-webcrypto.mjs`). Sa présence conditionne la seule voie sans
 * dépendance, et son absence quelque part changerait le verdict du spike.
 *
 * Elle ne touche à aucun module de `src/` : la matrice de capacités du produit reste ce qu'elle
 * est, et cette mesure-ci vit à côté, avec son propre rapport.
 */

const playwrightVersion = createRequire(import.meta.url)("@playwright/test/package.json").version;
const dossierDeRapport = fileURLToPath(new URL("../../reports/compat/", import.meta.url));

/**
 * Le corps de la sonde, exécuté tel quel dans la page et dans le Worker. Il est défini comme une
 * chaîne parce qu'un Worker ne reçoit pas une fonction : les deux contextes doivent exécuter le
 * MÊME texte, sans quoi ils ne mesureraient pas la même chose.
 */
const CORPS_DE_SONDE = `
async (contexte) => {
  const cle = new Uint8Array(32);
  const nonce = new Uint8Array(12);
  const clair = new Uint8Array(512);

  const tenter = async (nom, action) => {
    try {
      await action();
      return { id: nom, verdict: "supported", detail: "accepté" };
    } catch (erreur) {
      const nomErreur = erreur && erreur.name ? erreur.name : "Error";
      const message = erreur && erreur.message ? erreur.message : String(erreur);
      const verdict = nomErreur === "NotSupportedError" ? "unsupported" : "error";
      return { id: nom, verdict, detail: nomErreur + " : " + message };
    }
  };

  const capacites = [];

  capacites.push(
    await tenter("aesGcmSivImportKey", () =>
      crypto.subtle.importKey("raw", cle, "AES-GCM-SIV", false, ["encrypt", "decrypt"]),
    ),
  );

  // Le nom alternatif que la proposition WICG emploie, demandé séparément : un moteur pourrait
  // exposer l'un sans l'autre, et supposer les deux équivalents masquerait le cas.
  capacites.push(
    await tenter("aesGcmSivAlgorithmeObjet", () =>
      crypto.subtle.importKey("raw", cle, { name: "AES-GCM-SIV", length: 256 }, false, ["encrypt"]),
    ),
  );

  capacites.push(
    await tenter("aesGcmSivEncrypt", async () => {
      const importee = await crypto.subtle.importKey("raw", cle, "AES-GCM-SIV", false, ["encrypt"]);
      await crypto.subtle.encrypt({ name: "AES-GCM-SIV", iv: nonce }, importee, clair);
    }),
  );

  // La primitive de la seule voie SANS dépendance : un bloc isolé chiffré par AES-CTR.
  capacites.push(
    await tenter("aesCtrBlocIsole", async () => {
      const importee = await crypto.subtle.importKey("raw", cle, "AES-CTR", false, ["encrypt"]);
      const sortie = await crypto.subtle.encrypt(
        { name: "AES-CTR", counter: new Uint8Array(16), length: 32 },
        importee,
        new Uint8Array(16),
      );
      if (sortie.byteLength !== 16) throw new Error("AES-CTR : sortie de " + sortie.byteLength + " octets");
    }),
  );

  return { contexte, capacites };
}
`;

async function sonder(page) {
  const enPage = await page.evaluate(`(${CORPS_DE_SONDE})("page")`);
  const enWorker = await page.evaluate(`
    new Promise((resoudre, rejeter) => {
      const source = "self.onmessage = async () => { self.postMessage(await (" + ${JSON.stringify(CORPS_DE_SONDE)} + ")('worker')); };";
      const worker = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
      worker.onmessage = (evenement) => { worker.terminate(); resoudre(evenement.data); };
      worker.onerror = (evenement) => { worker.terminate(); rejeter(new Error(evenement.message || "worker en échec")); };
      worker.postMessage("va");
    })
  `);
  return [enPage, enWorker];
}

test.describe("spike #185 — AES-GCM-SIV dans WebCrypto", () => {
  test("aucun moteur n'expose AES-GCM-SIV, et le refus est publié tel quel", async ({
    page,
    browser,
    browserName,
  }, testInfo) => {
    // La page de la sonde de capacités sert d'hôte : même origine, même contexte sécurisé, mêmes
    // en-têtes. Ce spike n'ajoute aucun document servi.
    await page.goto("/compat.html");

    const contextes = await sonder(page);
    const rapport = {
      contrat: { id: "railsbox-vault-spike-gcm-siv-disponibilite", version: 1 },
      issue: 185,
      moteur: browserName,
      versionMoteur: browser.version(),
      playwright: playwrightVersion,
      systeme: `${platform()} ${release()}`,
      node: process.version,
      releveLe: new Date().toISOString(),
      contextes,
    };
    const serialise = `${JSON.stringify(rapport, null, 2)}\n`;

    await mkdir(dossierDeRapport, { recursive: true });
    await writeFile(`${dossierDeRapport}gcm-siv-${browserName}.json`, serialise, "utf8");
    await testInfo.attach(`gcm-siv-${browserName}.json`, {
      body: serialise,
      contentType: "application/json",
    });

    for (const { contexte, capacites } of contextes) {
      const par = new Map(capacites.map((entree) => [entree.id, entree]));

      // Le constat du spike, asserté dans les deux contextes : SIV est refusé, et refusé par
      // absence — pas par une clé mal formée ni par un refus d'usage.
      for (const identifiant of [
        "aesGcmSivImportKey",
        "aesGcmSivAlgorithmeObjet",
        "aesGcmSivEncrypt",
      ]) {
        const entree = par.get(identifiant);
        expect(entree, `${identifiant} absent du rapport (${contexte})`).toBeDefined();
        expect(entree.detail.trim(), `détail vide pour ${identifiant} (${contexte})`).not.toBe("");
        // `unsupported` et non « pas supported » : le tableau publié affirme que le refus est de
        // la BONNE NATURE — `NotSupportedError`, c'est-à-dire « cet algorithme n'existe pas ici ».
        // Une assertion en négatif laissait passer un `error`, donc un moteur qui implémenterait
        // SIV en refusant à l'import pour une autre raison (revue de la PR #202, LOW 4).
        expect(
          entree.verdict,
          `${identifiant} sous ${browserName} (${contexte}) : ${entree.detail} — si le refus n'est plus un NotSupportedError, le verdict du spike #185 est à rouvrir`,
        ).toBe("unsupported");
      }

      // Et la voie sans dépendance reste ouverte : AES-CTR est là, partout.
      expect(
        par.get("aesCtrBlocIsole").verdict,
        `AES-CTR sur un bloc isolé sous ${browserName} (${contexte}) : ${par.get("aesCtrBlocIsole").detail}`,
      ).toBe("supported");
    }
  });
});
