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
//  - depuis #16, le taux « ancien ou nouveau » vaut 100 %, sans bloc déchiré ni bloc non
//    rattachable, et la récupération d'ouverture NOMME ce qu'elle a fait.
//
// C'est ici que #15 et #16 se distinguent. #15 ATTENDAIT des états non atomiques et les publiait
// tels quels ; les lignes qui les épinglaient sont inversées ci-dessous, et c'est le rouge que cette
// tranche a dû produire avant de passer au vert.
//
// Ce que la suite n'affirme toujours PAS : qu'une coupure du PROCESSUS — perte du cache volatil du
// navigateur, mort de l'onglet, coupure de courant — laisse le même état. `Worker.terminate()` ne
// tue ni le processus du navigateur ni la machine. Cette limite est celle de #15, et #16 ne la lève
// pas : elle est réinscrite dans `docs/testing.md`.
//
// Ce qu'elle ne fait pas non plus : faire tourner un guest v86. Le scénario écrit depuis le Worker
// runtime sur le volume OPFS, sans émulateur. La chaîne guest → pont ATA → backend est prouvée
// ailleurs (`opfs-barrier.spec.mjs`, `opfs-persistence.spec.mjs`) ; l'y adjoindre ici coûterait un
// boot de guest par point de coupure, pour une matrice qui en rejoue huit.

const GRAINE = 2026;
const POINTS = 8;

/** Deux graines de contrôle : elles n'ont jamais servi à mettre le mécanisme au point. */
const AUTRES_GRAINES = [7, 424242];

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
    const ou = JSON.stringify(resultat.point);
    // La coupure a bien eu lieu : une faute programmée jamais tirée ne prouverait rien.
    expect(resultat.fautesNonTirees, ou).toEqual([]);
    expect(resultat.fautesTirees.length).toBe(1);
    // Elle s'est traduite par une erreur TYPÉE du stockage, jamais par un succès.
    expect(resultat.arret).not.toBeNull();
    expect(resultat.arret.code).toMatch(/^VAULT_STORAGE_/);
    // Chaque bloc suivi est classé : aucun n'est ignoré.
    expect(Object.values(VERDICTS)).toContain(resultat.verdict);
    expect(resultat.blocs.length).toBe(BLOCS_SUIVIS);
    const total = Object.values(resultat.classes).reduce((somme, compte) => somme + compte, 0);
    expect(total).toBe(BLOCS_SUIVIS);
    // Aucun bloc non rattachable, et aucun bloc DÉCHIRÉ. Le premier zéro dit que l'oracle a su
    // classer chaque bloc ; le second est la garantie de #16 elle-même — une génération n'atteint le
    // volume qu'entière.
    expect(resultat.classes.corrompu, ou).toBe(0);
    expect(resultat.classes.dechire, ou).toBe(0);

    // Le volume rouvert porte l'ancien état ou le nouveau, jamais un mélange.
    expect(resultat.atomique, `${ou} — ${resultat.raison ?? "sans raison"}`).toBe(true);

    // Et la RÉCUPÉRATION s'est dite. Une génération écartée ou rejouée en silence serait le succès
    // muet que `docs/quality-attributes.md` refuse ; le compte rendu la nomme.
    expect(resultat.recuperation, ou).not.toBeNull();
    expect(["aucune", "ecartee", "rejouee"], ou).toContain(resultat.recuperation.etat);

    // L'oracle a bien eu le journal de la session morte SOUS LES YEUX. Sans lui, la règle
    // `SEC-DURABLE-001` serait inerte et le taux atomique monterait sans raison.
    expect(resultat.journalConsulte, ou).toBe(true);
    expect(resultat.entreesJournal, ou).toBeGreaterThan(0);

    // Et la règle a de quoi mordre : dès qu'une barrière a été acquittée, au moins un bloc est
    // DURABLE. Sans cette ligne, un journal relayé mais vide de barrières passerait inaperçu.
    const durables = resultat.blocs.filter((bloc) => bloc.durable === true);
    if (resultat.barrieres >= 1) {
      expect(
        durables.length,
        `${ou} — ${resultat.barrieres} barrière(s) acquittée(s)`,
      ).toBeGreaterThan(0);
    }

    // Le volume a bien été rouvert après la mort du Worker. Un seul essai suffit : Chromium rend
    // l'exclusivité avec le Worker terminé, avant que la page n'ait démarré le suivant. La reprise
    // borne l'attente jusqu'à soixante essais, mais mesurer qu'elle n'en consomme qu'un est ce qui
    // rend le relevé comparable d'une exécution à l'autre.
    expect(resultat.reouverture.essais, ou).toBe(1);
  }

  // Le point 2 de cette graine est une coupure sur la TROISIÈME barrière : les vingt-quatre
  // écritures ont eu lieu et les deux premières barrières ont été acquittées. Les huit blocs suivis
  // sont donc DURABLES — un chiffre épinglé pour que la règle SEC-DURABLE ne devienne pas
  // silencieusement inapplicable, ce qui ferait monter le taux atomique sans raison.
  const surLaDerniereBarriere = resultats[2];
  expect(surLaDerniereBarriere.point.operation).toBe("flush");
  expect(surLaDerniereBarriere.barrieres).toBe(2);
  expect(surLaDerniereBarriere.blocs.filter((bloc) => bloc.durable === true).length).toBe(8);
  expect(surLaDerniereBarriere.verdict).toBe(VERDICTS.nouveau);

  // LA MESURE. `docs/quality-attributes.md` demande que 100 % des points de coupure donnent ancien
  // état, nouvel état ou erreur explicite ; #15 l'a mesurée à 12,5 %, #16 la porte à 100 %.
  expect(resume.tauxAtomique).toBe(1);
  expect(resume.verdicts.melange + resume.verdicts.corrompu).toBe(0);
  expect(resume.classes.dechire).toBe(0);
  expect(resume.classes.corrompu).toBe(0);
  // Les DEUX issues sont exercées : une matrice qui ne rendrait que « ancien » serait satisfaite par
  // un backend qui n'écrirait rien du tout.
  expect(resume.verdicts.ancien).toBeGreaterThan(0);
  expect(resume.verdicts.nouveau).toBeGreaterThan(0);

  // Chaque ligne du compte rendu se rejoue seule.
  for (const ligne of resume.rejeu) {
    expect(ligne.graine).toBe(GRAINE);
    expect(ligne.point.occurrence).toBeGreaterThanOrEqual(1);
  }
});

test("deux AUTRES graines rendent elles aussi 100 % sur le vrai support", async ({
  page,
}, testInfo) => {
  // Une garantie qui ne tiendrait que sur la graine publiée n'en serait pas une : la graine 2026 est
  // celle dont #15 a publié le relevé, et elle a servi à écrire cette tranche. Ces deux-là tirent
  // d'autres genres de coupure à d'autres rangs, et n'ont jamais servi à mettre au point le
  // mécanisme.
  await ouvrirBanc(page);

  const releves = [];
  for (const graine of AUTRES_GRAINES) {
    const compteRendu = await page.evaluate(
      (options) => globalThis.bancResilience.executerMatrice(options),
      { graine, points: POINTS },
    );
    releves.push(compteRendu.resume);

    const { resume, resultats } = compteRendu;
    expect(resume.graine, `graine ${graine}`).toBe(graine);
    expect(resume.tauxAtomique, `graine ${graine}`).toBe(1);
    expect(resume.verdicts.melange + resume.verdicts.corrompu, `graine ${graine}`).toBe(0);
    expect(resume.classes.dechire, `graine ${graine}`).toBe(0);
    expect(resume.classes.corrompu, `graine ${graine}`).toBe(0);
    expect(resume.verdicts.ancien, `graine ${graine}`).toBeGreaterThan(0);
    expect(resume.verdicts.nouveau, `graine ${graine}`).toBeGreaterThan(0);

    for (const resultat of resultats) {
      const ou = `graine ${graine} — ${JSON.stringify(resultat.point)}`;
      // La coupure a réellement eu lieu à chaque point, et elle s'est dite.
      expect(resultat.fautesNonTirees, ou).toEqual([]);
      expect(resultat.arret, ou).not.toBeNull();
      expect(resultat.arret.code, ou).toMatch(/^VAULT_STORAGE_/);
      expect(resultat.journalConsulte, ou).toBe(true);
      expect(resultat.recuperation, ou).not.toBeNull();
    }
  }

  await testInfo.attach("vm-resilience-autres-graines.json", {
    body: JSON.stringify(releves, null, 2),
    contentType: "application/json",
  });
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

test("sur OPFS réel, une écriture déchirée n'entame plus le volume", async ({ page }, testInfo) => {
  await ouvrirBanc(page);

  // Point nommé explicitement : une matrice ne garantit pas qu'une déchirure sera tirée, et c'était
  // l'état le plus intéressant de #15 — celui qu'aucune relecture ne pouvait rattraper. C'est
  // exactement celui que #16 supprime : la déchirure a bien lieu, mais dans le journal de
  // génération, et cette génération n'est jamais validée.
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

  // La coupure a bien eu lieu, et elle s'est dite par une erreur typée du stockage.
  expect(resultat.arret.code).toBe("VAULT_STORAGE_PARTIAL_WRITE");
  expect(resultat.classes.dechire).toBe(0);
  expect(resultat.classes.corrompu).toBe(0);
  expect(resultat.atomique).toBe(true);
  expect(resultat.verdict).toBe(VERDICTS.ancien);
  // La génération déposée a été ÉCARTÉE, et le compte rendu la NOMME.
  expect(resultat.recuperation.etat).toBe("ecartee");
  expect(resultat.recuperation.code).toBe("VAULT_STORAGE_GENERATION_DISCARDED");
  expect(resultat.recuperation.octetsEcartes).toBeGreaterThan(0);
});

test("sur le vrai support, une écriture barriérée disparue est une corruption — témoin négatif", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);

  // La règle « acquitté + barriéré, mais l'ancien état sur le support » ne se déclenche sur aucun
  // point de la matrice. C'est une bonne nouvelle, pas une preuve qu'elle fonctionne : sans ce
  // témoin, elle pourrait être morte depuis longtemps et la matrice n'en dirait rien — pire, sa
  // mort ferait MONTER le taux atomique.
  //
  // La relecture reste RÉELLE : une vraie coupure à la cinquième écriture a laissé le bloc 10 à
  // l'ancien état sur OPFS. Seul le journal est trafiqué, pour prétendre que ce bloc-là avait été
  // écrit puis franchi par une barrière.
  const reel = await page.evaluate((choisi) => globalThis.bancResilience.executerPoint(choisi), {
    graine: GRAINE,
    index: 0,
    kind: CRASH_KINDS.abrupt,
    operation: "write",
    occurrence: 5,
  });
  expect(reel.verdict).toBe(VERDICTS.ancien);
  expect(reel.classes.corrompu).toBe(0);
  const avant = reel.blocs.find((bloc) => bloc.index === 3);
  expect(avant.classe).toBe("ancien");
  expect(avant.durable).toBe(false);

  const rejuge = await page.evaluate((offset) => {
    const journal = [
      { seq: 0, operation: "write", offset, length: 512 },
      { seq: 1, operation: "flush", barrier: 0 },
      { seq: 2, operation: "flush-ack", barrier: 0 },
    ];
    return globalThis.bancResilience.reclasserAvec(journal);
  }, 3 * 512);
  await testInfo.attach("vm-resilience-temoin-sec-durable.json", {
    body: JSON.stringify({ reel, rejuge }, null, 2),
    contentType: "application/json",
  });

  const apres = rejuge.blocs.find((bloc) => bloc.index === 3);
  expect(apres.durable).toBe(true);
  expect(apres.classe).toBe("corrompu");
  expect(apres.diagnostic).toMatch(/barrière/i);
  expect(rejuge.verdict).toBe(VERDICTS.corrompu);
  expect(rejuge.atomique).toBe(false);
});
