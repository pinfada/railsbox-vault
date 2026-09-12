/**
 * Cœur de mesure du spike #185, partagé par le banc Node et le banc navigateur.
 *
 * Aucune API propre à Node ni au DOM : ce module s'exécute tel quel dans les trois moteurs, servi
 * par la spécification Playwright du spike. La candidate tierce lui est INJECTÉE, parce que son
 * chemin de chargement diffère entre Node et le navigateur — et parce qu'un banc qui importe
 * lui-même une dépendance ne peut plus mesurer son absence.
 */

import * as compose from "./gcm-siv-webcrypto.mjs";
import { polyval } from "./polyval.mjs";

/** Ce que le produit scelle : un secteur de 512 octets, nonce de 12, données associées de 112. */
export const FORME = Object.freeze({ secteur: 512, nonce: 12, donneesAssociees: 112 });

/**
 * Médiane, extrêmes et étendue relative, en microsecondes par scellement.
 *
 * Le protocole est celui de `tools/mesurer-scellement.mjs`, dont sortent les 17,3 µs publiés : un
 * LOT de scellements chronométré d'un bloc, divisé par le nombre de scellements, et l'opération
 * répétée. Chronométrer un appel isolé mesurerait surtout le bruit de l'ordonnanceur — c'est ce que
 * montrait une première rédaction de ce banc, avec des étendues de plusieurs milliers de pour cent.
 */
function resumer(parScellement) {
  const triees = [...parScellement].sort((a, b) => a - b);
  const mediane = triees[Math.floor(triees.length / 2)];
  return {
    essais: triees.length,
    mediane,
    min: triees[0],
    max: triees[triees.length - 1],
    etendueRelative: mediane === 0 ? 0 : (triees[triees.length - 1] - triees[0]) / mediane,
  };
}

/**
 * Choisit le LOT de sorte qu'un bloc chronométré dure au moins `cibleMs`, et sert d'échauffement.
 *
 * Un lot fixe ne convient pas aux trois moteurs : `performance.now` a une résolution de 100 µs sous
 * Chromium et de **1 ms** sous Firefox comme sous WebKit (mesurée par
 * `tools/spike-gcm-siv/cout-par-appel.mjs`). À lot fixe, les séries rapides de ces deux moteurs ne
 * rendaient que des multiples de la résolution divisés par le lot — des valeurs qui ont l'air
 * précises et qui ne le sont pas. Un bloc de soixante millisecondes ramène la quantification
 * au-dessous de deux pour cent partout.
 */
async function calibrerLeLot(action, cibleMs, lotMaximum) {
  const depart = performance.now();
  let faits = 0;
  do {
    await action();
    faits += 1;
  } while (performance.now() - depart < 20 && faits < lotMaximum);
  const parAppel = Math.max((performance.now() - depart) / faits, 1e-4);
  return Math.max(1, Math.min(lotMaximum, Math.ceil(cibleMs / parAppel)));
}

async function chronometrer(nom, sceller, { essais, cibleMs, lotMaximum }) {
  const lot = await calibrerLeLot(sceller, cibleMs, lotMaximum);
  // Un lot entier JETÉ avant de chronométrer. La calibration ne dure que vingt millisecondes, ce
  // qui ne suffit pas à chauffer le compilateur de Firefox : sans cet échauffement-ci, sa série du
  // plancher est ressortie PLUS CHÈRE que la voie composée qui l'englobe — une impossibilité, donc
  // un bruit, et un relevé qu'il aurait fallu publier en le désavouant.
  for (let rang = 0; rang < lot; rang += 1) await sceller();
  const parScellement = [];
  for (let essai = 0; essai < essais; essai += 1) {
    const depart = performance.now();
    for (let rang = 0; rang < lot; rang += 1) await sceller();
    parScellement.push(((performance.now() - depart) * 1000) / lot);
  }
  return { nom, lot, ...resumer(parScellement) };
}

/**
 * Exécute les quatre séries du banc sur un même moteur, dans un même processus, avec les mêmes
 * octets. La comparaison est donc INTERNE : elle ne suppose rien d'un relevé pris ailleurs.
 *
 * @param {{ essais?: number, cibleMs?: number, lotMaximum?: number, candidate?: object|null }} options
 */
export async function mesurer({
  essais = 7,
  cibleMs = 60,
  lotMaximum = 8192,
  candidate = null,
} = {}) {
  const cadence = { essais, cibleMs, lotMaximum };
  const cle = crypto.getRandomValues(new Uint8Array(32));
  const nonce = crypto.getRandomValues(new Uint8Array(FORME.nonce));
  const clair = crypto.getRandomValues(new Uint8Array(FORME.secteur));
  const donneesAssociees = crypto.getRandomValues(new Uint8Array(FORME.donneesAssociees));

  const series = [];

  // 1. Ce que le produit fait aujourd'hui : AES-256-GCM par WebCrypto, clé importée UNE fois.
  const cleGcm = await crypto.subtle.importKey("raw", cle, "AES-GCM", false, ["encrypt"]);
  series.push(
    await chronometrer(
      "aes-gcm-webcrypto",
      () =>
        crypto.subtle.encrypt(
          { name: "AES-GCM", iv: nonce, additionalData: donneesAssociees, tagLength: 128 },
          cleGcm,
          clair,
        ),
      cadence,
    ),
  );

  // 2. AES-GCM-SIV composé sur WebCrypto, sans une ligne de code tiers.
  const cleMaitresse = await compose.preparerCleMaitresse(cle);
  compose.remettreCompteurAZero();
  await compose.sceller(cleMaitresse, nonce, clair, donneesAssociees);
  const appelsParScellement = compose.totalAppels();
  series.push(
    await chronometrer(
      "gcm-siv-compose-webcrypto",
      () => compose.sceller(cleMaitresse, nonce, clair, donneesAssociees),
      cadence,
    ),
  );

  // 3. Le PLANCHER de la voie composée : les seuls appels à `crypto.subtle`, sans POLYVAL. Il rend
  // le verdict indépendant de la qualité de notre multiplication de corps fini.
  series.push(
    await chronometrer(
      "plancher-appels-subtle",
      () => compose.plancherDAppels(cleMaitresse, appelsParScellement - 1),
      cadence,
    ),
  );

  // 4. Et POLYVAL seul, sur la même matière : l'autre moitié de la décomposition.
  const matiereDePolyval = new Uint8Array(
    Math.ceil((FORME.secteur + FORME.donneesAssociees) / 16) * 16 + 16,
  );
  const cleDePolyval = crypto.getRandomValues(new Uint8Array(16));
  series.push(
    await chronometrer(
      "polyval-seul",
      async () => polyval(cleDePolyval, matiereDePolyval),
      cadence,
    ),
  );

  // 5 et 6. La candidate tierce : SIV, et son propre AES-GCM. La seconde série sépare ce que SIV
  // coûte de ce que coûte le fait de QUITTER WebCrypto — sans elle, les deux sont confondus.
  if (candidate) {
    series.push(
      await chronometrer(
        "gcm-siv-candidate",
        () => candidate.gcmsiv(cle, nonce, donneesAssociees).encrypt(clair),
        cadence,
      ),
    );
    series.push(
      await chronometrer(
        "aes-gcm-candidate",
        () => candidate.gcm(cle, nonce, donneesAssociees).encrypt(clair),
        cadence,
      ),
    );
  }

  return {
    forme: FORME,
    cadence,
    appelsSubtleParScellementSiv: appelsParScellement,
    series,
  };
}
