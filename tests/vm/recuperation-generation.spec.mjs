import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "@playwright/test";

import { PLAFOND_CHARGE_OCTETS, TAMPON_RELECTURE_OCTETS } from "../../src/vm/generation-store.mjs";

// Preuve de niveau **résilience** de #91, sur OPFS RÉEL sous Chromium.
//
// `docs/quality-attributes.md` demande que la dernière génération valide soit retrouvée en ≤ 60 s
// hors temps de boot VM. Ce budget n'était mesuré NULLE PART : aucune épreuve ne chronométrait une
// récupération, et aucune ne la faisait porter sur une charge réaliste. Le plafond de charge, lui,
// était un garde-fou choisi par analogie (ADR 0014, § Limites) : personne n'avait mesuré ce qu'il
// coûtait de rejouer une génération de cette taille.
//
// Ce que cette suite affirme :
//
//  - la récupération d'une charge portée au PLAFOND tient dans le budget, à toutes les granularités
//    d'enregistrement que le guest peut produire — jusqu'au secteur de 512 octets ;
//  - sa surmémoire de pointe reste bornée par le tampon de relecture, sur le vrai support et pas
//    seulement sur le double calibré ;
//  - la charge rejouée est bien celle qui a été déposée. Sans cette ligne, un journal vidé par
//    accident rendrait des durées flatteuses et vides de sens.
//
// Elle publie en plus un TÉMOIN hors budget : la même charge à l'ancien plafond de 64 Mio. C'est le
// relevé qui a fait bouger le plafond, et le garder mesuré est ce qui distingue une décision d'une
// opinion. Il n'est volontairement pas confronté au budget — l'y confronter ferait de cette suite un
// rouge permanent, et l'en dispenser sans le publier ferait disparaître la raison du changement.
//
// Ce qu'elle n'affirme PAS : que la même durée s'observera ailleurs. Une mesure de durée est celle
// d'une machine, d'un moteur et d'un jour ; le relevé est daté, situé et rejouable, et l'étendue
// relative de la série dit ce que le p95 vaut.

const RACINE = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOSSIER_RAPPORTS = join(RACINE, "reports", "vm");

/** Budget de `docs/quality-attributes.md`, hors temps de boot VM. */
const BUDGET_RECUPERATION_MS = 60_000;

/** Ancien plafond, mesuré une dernière fois comme témoin. */
const PLAFOND_AVANT_91 = 64 * 1024 * 1024;

/**
 * Profils du relevé, à charge égale et à GRANULARITÉ différente.
 *
 * La durée d'un rejeu suit le nombre d'enregistrements autant que les octets : chaque enregistrement
 * coûte au moins une écriture du volume, et un appel synchrone OPFS se paie en centaines de
 * microsecondes. Un seul profil laisserait croire le contraire. 64 Kio est l'ordre de grandeur d'une
 * écriture groupée ; 4 Kio celui d'un bloc de système de fichiers ; 512 octets est le PIRE cas — un
 * secteur, ce qu'une écriture ATA peut valoir.
 */
const PROFILS = [
  { nom: "plafond, enregistrements de 64 Kio", enregistrementOctets: 64 * 1024, repetitions: 7 },
  { nom: "plafond, enregistrements de 4 Kio", enregistrementOctets: 4 * 1024, repetitions: 7 },
  { nom: "plafond, enregistrements de 512 o", enregistrementOctets: 512, repetitions: 5 },
];

/** Le témoin hors budget : l'ancien plafond, à la granularité la plus fine. */
const TEMOIN = {
  nom: "TÉMOIN — ancien plafond de 64 Mio, enregistrements de 512 o",
  chargeCible: PLAFOND_AVANT_91,
  enregistrementOctets: 512,
  repetitions: 1,
  horsBudget: true,
};

async function ouvrirBanc(page) {
  await page.goto("/vm/recuperation.html");
  await expect(page.locator("#etat")).toHaveText("Banc de récupération prêt.");
}

/** Vérifie qu'une série a bien rejoué la charge annoncée, et qu'elle est restée dans sa surmémoire. */
function verifierReleves(mesure, ou) {
  for (const releve of mesure.releves) {
    expect(releve.etat, ou).toBe("rejouee");
    expect(releve.octetsRejoues, ou).toBeGreaterThan(mesure.profil.chargeCibleOctets * 0.95);
    expect(releve.enregistrementsRejoues, ou).toBe(releve.enregistrementsDeposes);
    // La borne de surmémoire tient sur le VRAI support, pas seulement sur le double calibré.
    expect(releve.surmemoireMaxOctets, ou).toBeLessThanOrEqual(TAMPON_RELECTURE_OCTETS);
  }
}

test("une génération portée au plafond est retrouvée dans le budget, sur OPFS réel", async ({
  page,
}, testInfo) => {
  // Quatre séries dont une au pire cas, sur des charges de 16 à 64 Mio : la préparation seule écrit
  // plusieurs centaines de Mio sur OPFS. Le budget du harnais VM ne suffit pas.
  testInfo.setTimeout(2_400_000);
  await ouvrirBanc(page);

  const profils = [];
  for (const profil of [...PROFILS, TEMOIN]) {
    const mesure = await page.evaluate((options) => globalThis.bancRecuperation.mesurer(options), {
      chargeCible: profil.chargeCible ?? PLAFOND_CHARGE_OCTETS,
      enregistrementOctets: profil.enregistrementOctets,
      repetitions: profil.repetitions,
    });
    profils.push({ nom: profil.nom, horsBudget: profil.horsBudget === true, ...mesure });

    verifierReleves(mesure, profil.nom);
    // LA MESURE, confrontée au budget — sauf pour le témoin, qui est publié pour ce qu'il est.
    if (profil.horsBudget !== true) {
      expect(mesure.recuperation.p95Ms, `${profil.nom} — p95`).toBeLessThanOrEqual(
        BUDGET_RECUPERATION_MS,
      );
    }
  }

  const mesures = {
    mesureLe: new Date().toISOString(),
    environnement: {
      navigateur: testInfo.project.name,
      plateforme: `${process.platform} ${process.arch}`,
      node: process.versions.node,
    },
    support: "OPFS réel (Chromium)",
    budgetRecuperationMs: BUDGET_RECUPERATION_MS,
    plafondChargeOctets: PLAFOND_CHARGE_OCTETS,
    plafondAvant91Octets: PLAFOND_AVANT_91,
    tamponRelectureOctets: TAMPON_RELECTURE_OCTETS,
    profils,
  };
  mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
  writeFileSync(
    join(DOSSIER_RAPPORTS, "recuperation-generation.json"),
    `${JSON.stringify(mesures, null, 2)}\n`,
    "utf8",
  );
  await testInfo.attach("recuperation-generation.json", {
    body: JSON.stringify(mesures, null, 2),
    contentType: "application/json",
  });
});
