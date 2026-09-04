import { expect, test } from "@playwright/test";

import { CRASH_KINDS } from "../../src/vm/crash-plan.mjs";
import { TAMPON_RELECTURE_OCTETS } from "../../src/vm/generation-store.mjs";
import { VERDICTS, estVerdictConnu } from "../../src/vm/crash-oracle.mjs";
import { BARRIERES, BLOCS_SUIVIS } from "../../src/vm/crash-scenario.mjs";
import { exigerReouvertureDansLeBudget, releveDeReouverture } from "./budget-reouverture.mjs";

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

  // Le COÛT de la réouverture, joint AVANT toute assertion : c'est la mesure qui remplace l'ancienne
  // valeur figée, et une exécution qui rougirait plus bas doit tout de même la publier.
  await testInfo.attach("vm-resilience-reouverture.json", {
    body: JSON.stringify(
      releveDeReouverture(
        resultats.map((resultat) => ({
          ou: JSON.stringify(resultat.point),
          reouverture: resultat.reouverture,
        })),
      ),
      null,
      2,
    ),
    contentType: "application/json",
  });

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
    expect(estVerdictConnu(resultat.verdict), ou).toBe(true);
    expect(resultat.blocs.length).toBe(BLOCS_SUIVIS);
    const total = Object.values(resultat.classes).reduce((somme, compte) => somme + compte, 0);
    expect(total).toBe(BLOCS_SUIVIS);
    // Aucun bloc non rattachable, et aucun bloc DÉCHIRÉ. Le premier zéro dit que l'oracle a su
    // classer chaque bloc ; le second est la garantie de #16 elle-même — une génération n'atteint le
    // volume qu'entière.
    expect(resultat.classes.corrompu, ou).toBe(0);
    expect(resultat.classes.dechire, ou).toBe(0);

    // Le volume rouvert porte EXACTEMENT une génération validée — l'ancien état, la génération 1,
    // la génération 2 ou le nouveau —, jamais un mélange.
    expect(resultat.atomique, `${ou} — ${resultat.raison ?? "sans raison"}`).toBe(true);

    // Et la RÉCUPÉRATION s'est dite — pas « l'un des trois états possibles », ce qui serait une
    // tautologie, mais celui que le POINT détermine. Une coupure qui n'a acquitté aucune barrière ne
    // peut rien laisser à rejouer ; dès qu'une barrière a été acquittée, la génération est encore
    // dans le journal — la charge du scénario est très en deçà du seuil de rangement — et elle DOIT
    // être rejouée.
    expect(resultat.recuperation, ou).not.toBeNull();
    // Le numéro de génération est un compteur du VOLUME, pas de la session : la préparation de
    // l'ancien état en a déjà validé `BARRIERES` avant que la coupure ne commence. Le rang attendu
    // est donc DÉRIVÉ du protocole, pas deviné.
    if (resultat.barrieres === 0) {
      expect(resultat.recuperation.etat, ou).toBe("ecartee");
      expect(resultat.recuperation.code, ou).toBe("VAULT_STORAGE_GENERATION_DISCARDED");
      expect(resultat.recuperation.generation, ou).toBe(BARRIERES);
    } else {
      expect(resultat.recuperation.etat, ou).toBe("rejouee");
      expect(resultat.recuperation.generation, ou).toBe(BARRIERES + resultat.barrieres);
      expect(resultat.recuperation.enregistrementsRejoues, ou).toBeGreaterThan(0);
      // Et la charge rejouée est COMPTÉE, pas seulement dénombrée en enregistrements (#91).
      expect(resultat.recuperation.octetsRejoues, ou).toBeGreaterThan(0);
    }

    // La SURMÉMOIRE de la récupération est publiée à chaque ouverture, et bornée par le tampon de
    // relecture. C'est la même propriété que le double calibré épingle en unitaire, vérifiée ici sur
    // le vrai support : `docs/quality-attributes.md` exige ce régime de flux de l'export et de la
    // restauration, et la récupération ne le tenait pas avant #91.
    expect(resultat.recuperation.surmemoireMaxOctets, ou).toBeGreaterThan(0);
    expect(resultat.recuperation.surmemoireMaxOctets, ou).toBeLessThanOrEqual(
      TAMPON_RELECTURE_OCTETS,
    );

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

    // Le volume a bien été rouvert après la mort du Worker, DANS LA BORNE. Le nombre d'essais n'est
    // pas figé : une session v3 tient trois handles exclusifs (#16, #19), un seul encore tenu suffit
    // à rendre `busy`, et c'est le moteur qui décide quand il les rend. Ce qui est exigé, c'est que
    // la réouverture aboutisse dans le budget et que son coût soit publié — voir le relevé joint
    // `vm-resilience-reouverture.json` et `tests/unit/vm-reouverture-handles.test.mjs`.
    exigerReouvertureDansLeBudget(resultat.reouverture, ou);
  }

  // Le point 2 de cette graine est une coupure sur la TROISIÈME barrière : les vingt-quatre
  // écritures ont eu lieu et les deux premières barrières ont été acquittées. Les huit blocs suivis
  // sont donc DURABLES — un chiffre épinglé pour que la règle SEC-DURABLE ne devienne pas
  // silencieusement inapplicable, ce qui ferait monter le taux atomique sans raison.
  const surLaDerniereBarriere = resultats[2];
  expect(surLaDerniereBarriere.point.operation).toBe("flush");
  expect(surLaDerniereBarriere.barrieres).toBe(2);
  // SEIZE blocs durables sur vingt-quatre — un chiffre DISCRIMINANT, qui distingue les seize premiers
  // des huit derniers. Avec un scénario où toutes les générations publieraient les mêmes blocs, ce
  // témoin ne pourrait plus rougir : c'est exactement le défaut que la revue de #90 a démontré.
  expect(surLaDerniereBarriere.blocs.filter((bloc) => bloc.durable === true).length).toBe(16);
  expect(surLaDerniereBarriere.verdict).toBe("generation-2");
  expect(surLaDerniereBarriere.classes.nouveau).toBe(16);
  expect(surLaDerniereBarriere.classes.ancien).toBe(8);

  // LA MESURE. `docs/quality-attributes.md` demande que 100 % des points de coupure donnent ancien
  // état, nouvel état ou erreur explicite ; #15 l'a mesurée à 12,5 %, #16 la porte à 100 % — avec un
  // oracle qui NOMME les états intermédiaires au lieu de les ranger dans « melange ».
  expect(resume.tauxAtomique).toBe(1);
  expect(resume.verdicts.melange + resume.verdicts.corrompu).toBe(0);
  expect(resume.classes.dechire).toBe(0);
  expect(resume.classes.corrompu).toBe(0);
  expect(resume.generationsAttendues).toBe(4);
  // L'extrême bas ET les deux générations intermédiaires sont exercés. L'extrême haut, lui, est hors
  // d'atteinte de cette matrice — aucun genre de coupure ne tombe après la troisième barrière
  // acquittée (`tests/unit/vm-crash-cadence.test.mjs` le démontre) —, et ce zéro l'inscrit noir sur
  // blanc plutôt que de le laisser deviner. Le témoin positif est au niveau unitaire.
  expect(resume.verdicts.ancien).toBeGreaterThan(0);
  expect(resume.verdicts["generation-1"]).toBeGreaterThan(0);
  expect(resume.verdicts["generation-2"]).toBeGreaterThan(0);
  expect(resume.verdicts.nouveau).toBe(0);

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

    // Le coût de la réouverture est publié pour CHAQUE graine, et joint avant les assertions : seize
    // points de plus que la graine publiée, c'est-à-dire de quoi voir si le moteur traîne sur une
    // séquence de coupures particulière ou sur toutes.
    await testInfo.attach(`vm-resilience-reouverture-graine-${graine}.json`, {
      body: JSON.stringify(
        releveDeReouverture(
          resultats.map((resultat) => ({
            ou: `graine ${graine} — ${JSON.stringify(resultat.point)}`,
            reouverture: resultat.reouverture,
          })),
        ),
        null,
        2,
      ),
      contentType: "application/json",
    });

    expect(resume.graine, `graine ${graine}`).toBe(graine);
    expect(resume.tauxAtomique, `graine ${graine}`).toBe(1);
    expect(resume.verdicts.melange + resume.verdicts.corrompu, `graine ${graine}`).toBe(0);
    expect(resume.classes.dechire, `graine ${graine}`).toBe(0);
    expect(resume.classes.corrompu, `graine ${graine}`).toBe(0);
    // L'extrême bas et les DEUX générations intermédiaires. `nouveau` est hors d'atteinte de la
    // matrice — voir `tests/unit/vm-crash-cadence.test.mjs` —, et ce zéro est épinglé, pas subi.
    expect(resume.verdicts.ancien, `graine ${graine}`).toBeGreaterThan(0);
    expect(resume.verdicts["generation-1"], `graine ${graine}`).toBeGreaterThan(0);
    expect(resume.verdicts["generation-2"], `graine ${graine}`).toBeGreaterThan(0);
    expect(resume.verdicts.nouveau, `graine ${graine}`).toBe(0);

    for (const resultat of resultats) {
      const ou = `graine ${graine} — ${JSON.stringify(resultat.point)}`;
      // La coupure a réellement eu lieu à chaque point, et elle s'est dite.
      expect(resultat.fautesNonTirees, ou).toEqual([]);
      expect(resultat.arret, ou).not.toBeNull();
      expect(resultat.arret.code, ou).toMatch(/^VAULT_STORAGE_/);
      expect(resultat.journalConsulte, ou).toBe(true);
      expect(resultat.recuperation, ou).not.toBeNull();
      // La réouverture aboutit dans le budget ici AUSSI. Le premier point de la matrice n'a rien de
      // particulier : ces deux graines coupent ailleurs, et le moteur y rend l'exclusivité de la
      // même façon.
      exigerReouvertureDansLeBudget(resultat.reouverture, ou);
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
