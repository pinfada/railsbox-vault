import { expect, test } from "@playwright/test";

import { CRASH_KINDS } from "../../src/vm/crash-plan.mjs";
import { VERDICTS } from "../../src/vm/crash-oracle.mjs";
import { BLOCS_SUIVIS } from "../../src/vm/crash-scenario.mjs";

// Preuve de niveau **résilience** de #15, sur OPFS RÉEL sous Chromium.
//
// Le Worker runtime du produit écrit une suite de blocs connus sur un volume OPFS ; l'injecteur
// coupe à un point tiré d'une graine ; la PAGE tue le Worker — `Worker.terminate()`, handle exclusif
// encore ouvert, sans fermeture et sans barrière — ; un autre Worker rouvre le volume et le classe.
//
// Ce que cette suite affirme :
//
//  - la coupure est ATTEINTE à chaque point (aucune faute programmée ne reste non tirée) ;
//  - chaque point est classé, et aucun bloc n'échappe au classement ;
//  - la même graine rejoue la même matrice sur le vrai support ;
//  - le taux « ancien ou nouveau » est MESURÉ et publié.
//
// Ce qu'elle n'affirme PAS, et qui appartient à #16 : qu'une coupure laisse le volume atomique. Les
// états non atomiques sont ATTENDUS ici — le test les enregistre et les publie, il ne rougit pas
// dessus. Quand #16 fermera la garantie, les lignes qui épinglent ces états devront changer : c'est
// voulu, et c'est le rouge que #16 aura à produire.
//
// Ce qu'elle ne fait pas non plus : faire tourner un guest v86. Le scénario écrit depuis le Worker
// runtime sur le volume OPFS, sans émulateur. La chaîne guest → pont ATA → backend est prouvée
// ailleurs (`opfs-barrier.spec.mjs`, `opfs-persistence.spec.mjs`) ; l'y adjoindre ici coûterait un
// boot de guest par point de coupure, pour une matrice qui en rejoue huit.

const GRAINE = 2026;
const POINTS = 8;

async function ouvrirBanc(page) {
  await page.goto("/vm/resilience.html");
  await expect(page.locator("#etat")).toHaveText("Banc de résilience prêt.");
}

test("une matrice de coupures est rejouée, classée et publiée sur un volume OPFS réel", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);

  const compteRendu = await page.evaluate(
    (options) => globalThis.bancResilience.executerMatrice(options),
    { graine: GRAINE, points: POINTS },
  );
  await testInfo.attach("vm-resilience-matrice.json", {
    body: JSON.stringify(compteRendu, null, 2),
    contentType: "application/json",
  });

  const { resume, resultats } = compteRendu;
  expect(resume.graine).toBe(GRAINE);
  expect(resume.pointsRejoues).toBe(POINTS);
  expect(resume.support).toBe("OPFS réel (Chromium)");

  for (const resultat of resultats) {
    // La coupure a bien eu lieu : une faute programmée jamais tirée ne prouverait rien.
    expect(resultat.fautesNonTirees, JSON.stringify(resultat.point)).toEqual([]);
    expect(resultat.fautesTirees.length).toBe(1);
    // Elle s'est traduite par une erreur TYPÉE du stockage, jamais par un succès.
    expect(resultat.arret).not.toBeNull();
    expect(resultat.arret.code).toMatch(/^VAULT_STORAGE_/);
    // Chaque bloc suivi est classé : aucun n'est ignoré.
    expect(Object.values(VERDICTS)).toContain(resultat.verdict);
    expect(resultat.blocs.length).toBe(BLOCS_SUIVIS);
    const total = Object.values(resultat.classes).reduce((somme, compte) => somme + compte, 0);
    expect(total).toBe(BLOCS_SUIVIS);
    // Le volume a bien été rouvert après la mort du Worker, et le coût de la reprise est publié.
    expect(resultat.reouverture.essais).toBeGreaterThanOrEqual(1);
  }

  // La MESURE, publiée telle qu'elle est. `docs/quality-attributes.md` demande que 100 % des points
  // de coupure donnent ancien état, nouvel état ou erreur explicite ; #15 mesure ce taux, #16 le
  // garantira. L'épingler ici évite qu'un futur « c'est déjà atomique » passe sans preuve.
  expect(resume.tauxAtomique).toBeGreaterThanOrEqual(0);
  expect(resume.tauxAtomique).toBeLessThan(1);
  expect(resume.verdicts.melange + resume.verdicts.corrompu).toBeGreaterThan(0);

  // Chaque ligne du compte rendu se rejoue seule.
  for (const ligne of resume.rejeu) {
    expect(ligne.graine).toBe(GRAINE);
    expect(ligne.point.occurrence).toBeGreaterThanOrEqual(1);
  }
});

test("la même graine rejoue exactement la même matrice sur le vrai support", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);

  const executer = () =>
    page.evaluate((options) => globalThis.bancResilience.executerMatrice(options), {
      graine: GRAINE,
      points: POINTS,
    });

  const premiere = await executer();
  const seconde = await executer();
  await testInfo.attach("vm-resilience-rejeu.json", {
    body: JSON.stringify({ premiere: premiere.resume, seconde: seconde.resume }, null, 2),
    contentType: "application/json",
  });

  const empreinte = (compteRendu) =>
    compteRendu.resultats.map((resultat) => [resultat.point, resultat.verdict, resultat.classes]);

  expect(empreinte(seconde)).toEqual(empreinte(premiere));
  expect(seconde.resume.tauxAtomique).toBe(premiere.resume.tauxAtomique);
});

test("une écriture déchirée laisse, sur OPFS réel, un bloc qui n'est ni l'ancien ni le nouveau", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);

  // Point nommé explicitement : une matrice ne garantit pas qu'une déchirure sera tirée, et c'est
  // l'état le plus intéressant à montrer — celui qu'aucune relecture ne peut rattraper.
  const point = {
    graine: GRAINE,
    index: 0,
    kind: CRASH_KINDS.torn,
    operation: "write",
    occurrence: 5,
    bytes: 192,
  };
  const resultat = await page.evaluate(
    (choisi) => globalThis.bancResilience.executerPoint(choisi),
    point,
  );
  await testInfo.attach("vm-resilience-dechirure.json", {
    body: JSON.stringify(resultat, null, 2),
    contentType: "application/json",
  });

  expect(resultat.arret.code).toBe("VAULT_STORAGE_PARTIAL_WRITE");
  expect(resultat.classes.dechire).toBe(1);
  const abime = resultat.blocs.find((bloc) => bloc.classe === "dechire");
  expect(abime.index).toBe(4);
  expect(abime.diagnostic).toMatch(/octet/);
  // Le volume n'est donc ni l'ancien état ni le nouveau. C'est le rouge que #16 fermera.
  expect(resultat.atomique).toBe(false);
  expect(resultat.verdict).toBe(VERDICTS.corrompu);
});
