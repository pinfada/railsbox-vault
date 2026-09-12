/**
 * Ce qu'un appel à `crypto.subtle` coûte, moteur par moteur — spike #185.
 *
 *     node tools/spike-gcm-siv/cout-par-appel.mjs
 *
 * Le banc principal a rendu sous WebKit un chiffre si écarté des deux autres — plus de six cents
 * millisecondes pour un secteur par la voie composée — qu'il fallait le confronter avant de le
 * publier. Ce script isole la grandeur en cause : le coût d'UN appel, sans POLYVAL, sans copie,
 * sans enveloppe, sur cinq formes d'appel. Il publie aussi la RÉSOLUTION de `performance.now` du
 * moteur, parce qu'un chiffre plus fin qu'elle ne serait pas un chiffre.
 *
 * Il n'entre dans aucune suite et n'est lancé qu'à la main.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { chromium, firefox, webkit } from "@playwright/test";

const dossierDeRapport = fileURLToPath(new URL("../../reports/spike-gcm-siv/", import.meta.url));
const ORIGINE = "https://cout-par-appel.test";
const APPELS = 300;

/** Exécuté dans le moteur. Aucune dépendance : le texte est passé tel quel à `page.evaluate`. */
async function mesurerDansLeMoteur(appels) {
  const cle = new Uint8Array(32);
  const cleGcm = await crypto.subtle.importKey("raw", cle, "AES-GCM", false, ["encrypt"]);
  const cleCtr = await crypto.subtle.importKey("raw", cle, "AES-CTR", false, ["encrypt"]);
  const nonce = new Uint8Array(12);
  const clair512 = new Uint8Array(512);
  const bloc = new Uint8Array(16);
  const zero16 = new Uint8Array(16);

  const mesurer = async (action, combien = appels) => {
    for (let i = 0; i < 20; i += 1) await action();
    const depart = performance.now();
    for (let i = 0; i < combien; i += 1) await action();
    return ((performance.now() - depart) * 1000) / combien;
  };

  const resolution = (() => {
    const debut = performance.now();
    let suivant = debut;
    while (suivant === debut) suivant = performance.now();
    return (suivant - debut) * 1000;
  })();

  return {
    resolutionPerformanceNow: resolution,
    "aes-gcm-512": await mesurer(() =>
      crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cleGcm, clair512),
    ),
    "aes-gcm-16": await mesurer(() =>
      crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, cleGcm, zero16),
    ),
    "aes-ctr-16-longueur-32": await mesurer(() =>
      crypto.subtle.encrypt({ name: "AES-CTR", counter: bloc, length: 32 }, cleCtr, zero16),
    ),
    "aes-ctr-16-longueur-128": await mesurer(() =>
      crypto.subtle.encrypt({ name: "AES-CTR", counter: bloc, length: 128 }, cleCtr, zero16),
    ),
    "aes-ctr-512": await mesurer(() =>
      crypto.subtle.encrypt({ name: "AES-CTR", counter: bloc, length: 32 }, cleCtr, clair512),
    ),
    // Les formes suivantes reproduisent, UNE DIFFÉRENCE À LA FOIS, ce que le banc faisait. La
    // première rédaction de ce fichier comparait la promesse rendue telle quelle à une enveloppe
    // `async` QUI LISAIT le résultat : deux variables changeaient ensemble, et elle en a conclu que
    // WebKit payait la lecture des octets. La revue de la PR #202 a isolé la bonne : c'est
    // l'enveloppe, pas la lecture. La forme « enveloppe sans rien lire » est ici pour que la
    // conclusion soit portée par la mesure et non par la rédaction.
    "aes-ctr-16-enveloppe-sans-lecture": await mesurer(async () => {
      const sortie = await crypto.subtle.encrypt(
        { name: "AES-CTR", counter: bloc, length: 32 },
        cleCtr,
        zero16,
      );
      return sortie === null;
    }),
    "aes-ctr-16-sans-crypto": await mesurer(async () => {
      await Promise.resolve();
    }),
    "aes-ctr-16-compteur-variable": await mesurer(
      (() => {
        let tour = 0;
        return () => {
          bloc[0] = tour++ & 0xff;
          return crypto.subtle.encrypt(
            { name: "AES-CTR", counter: bloc, length: 32 },
            cleCtr,
            zero16,
          );
        };
      })(),
    ),
    "aes-ctr-16-resultat-copie": await mesurer(async () => {
      const sortie = await crypto.subtle.encrypt(
        { name: "AES-CTR", counter: bloc, length: 32 },
        cleCtr,
        zero16,
      );
      return new Uint8Array(sortie);
    }),
    // Lire le résultat AUTREMENT, pour savoir si le coût tient au constructeur de vue ou au fait
    // de matérialiser les octets. La voie composée doit lire chaque bloc de flot : si les deux
    // formes coûtent pareil, le coût est inévitable pour elle.
    "aes-ctr-16-resultat-lu-par-dataview": await mesurer(async () => {
      const sortie = await crypto.subtle.encrypt(
        { name: "AES-CTR", counter: bloc, length: 32 },
        cleCtr,
        zero16,
      );
      return new DataView(sortie).getUint8(0);
    }),
    // Les 39 blocs d'un secteur, sous trois écritures. La différence entre les deux premières est
    // l'enveloppe `async` interne ; entre la deuxième et la troisième, l'émission en vague.
    "39-blocs-enveloppe-interne": await mesurer(async () => {
      const chiffrer = async (compteur) => {
        const sortie = await crypto.subtle.encrypt(
          { name: "AES-CTR", counter: compteur, length: 32 },
          cleCtr,
          zero16,
        );
        return new Uint8Array(sortie);
      };
      for (let rang = 0; rang < 39; rang += 1) {
        bloc[0] = rang & 0xff;
        await chiffrer(bloc);
      }
    }, 10),
    "39-blocs-promesse-brute": await mesurer(async () => {
      for (let rang = 0; rang < 39; rang += 1) {
        bloc[0] = rang & 0xff;
        const sortie = await crypto.subtle.encrypt(
          { name: "AES-CTR", counter: bloc, length: 32 },
          cleCtr,
          zero16,
        );
        if (new Uint8Array(sortie).length !== 16) throw new Error("sortie inattendue");
      }
    }, 10),
    "39-blocs-une-vague": await mesurer(async () => {
      const compteurs = [];
      for (let rang = 0; rang < 39; rang += 1) {
        const compteur = new Uint8Array(16);
        compteur[0] = rang & 0xff;
        compteurs.push(compteur);
      }
      const sorties = await Promise.all(
        compteurs.map((compteur) =>
          crypto.subtle.encrypt({ name: "AES-CTR", counter: compteur, length: 32 }, cleCtr, zero16),
        ),
      );
      if (sorties.map((s) => new Uint8Array(s)).length !== 39) throw new Error("sortie inattendue");
    }, 10),
  };
}

const rapport = {
  contrat: { id: "railsbox-vault-spike-gcm-siv-cout-par-appel", version: 1 },
  issue: 185,
  appels: APPELS,
  moteurs: {},
};

for (const [nom, lanceur] of [
  ["chromium", chromium],
  ["firefox", firefox],
  ["webkit", webkit],
]) {
  const navigateur = await lanceur.launch();
  try {
    const page = await navigateur.newPage();
    await page.route(`${ORIGINE}/**`, (route) =>
      route.fulfill({
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: '<!doctype html><html lang="fr"><head><meta charset="utf-8"><title>coût par appel</title></head><body></body></html>',
      }),
    );
    await page.goto(`${ORIGINE}/`);
    const mesures = await page.evaluate(mesurerDansLeMoteur, APPELS);
    rapport.moteurs[nom] = { version: navigateur.version(), ...mesures };
    const ligne = Object.entries(mesures)
      .map(([clef, valeur]) => `${clef} ${valeur.toFixed(1)} µs`)
      .join("   ");
    console.log(`${nom.padEnd(9)} ${ligne}`);
  } finally {
    await navigateur.close();
  }
}

await mkdir(dossierDeRapport, { recursive: true });
await writeFile(
  `${dossierDeRapport}cout-par-appel.json`,
  `${JSON.stringify(rapport, null, 2)}\n`,
  "utf8",
);
console.log("rapport : reports/spike-gcm-siv/cout-par-appel.json");
