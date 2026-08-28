import { expect, test } from "@playwright/test";

import { CRASH_KINDS } from "../../src/vm/crash-plan.mjs";
import { FAULT_KINDS } from "../../src/vm/fault-plan.mjs";
import { VERDICTS } from "../../src/vm/crash-oracle.mjs";
import { BARRIERES } from "../../src/vm/crash-scenario.mjs";

// Preuve de niveau **résilience** de #19 (ADR 0019), sur OPFS RÉEL sous Chromium.
//
// La matrice de #15 est rejouée telle quelle par `resilience-arrets.spec.mjs` — elle n'a pas bougé
// d'un point, et c'est délibéré : l'ADR 0019 ajoute deux VOISINS au volume, et leur plan de fautes
// est séparé de celui du guest précisément pour que les huit points de #15 restent comparables.
//
// Ce fichier ajoute les DEUX plans de panne que #19 introduit, et eux seuls :
//
//  1. **coupure pendant l'empreinte de région** — le support rend une lecture courte pendant le
//     hachage de la région d'authentification, à l'OUVERTURE ;
//  2. **coupure entre la racine et le témoin** — à la première barrière du guest, la racine est
//     durable et sa barrière est franchie, mais le témoin de séquence n'atteint jamais le support.
//
// **Les verdicts sont écrits d'avance**, et ils ne sont pas symétriques — c'est tout l'intérêt :
//
//  - dans le premier cas, la confrontation de région a lieu AVANT toute lecture de secteur et avant
//    toute écriture. Le volume ne s'ouvre donc pas du tout, rien n'est déposé, et la relecture
//    retrouve l'ANCIEN état entier. Une coupure sur un contrôle de sécurité ne doit rien coûter, et
//    surtout rien effacer ;
//  - dans le second, la racine est DURABLE avant que le témoin ne soit tenté. La génération est donc
//    validée sur le support même si le guest n'a pas reçu son acquittement, et la réouverture la
//    REJOUE. Le témoin, lui, reste en arrière — et un témoin en retard SOUS-DÉTECTE, il ne refuse
//    jamais à tort. C'est la propriété que l'ordre « racine, barrière, puis témoin » achète, et
//    cette épreuve est ce qui l'établit plutôt que de l'affirmer.
//
// **Où tombe exactement chaque occurrence, et pourquoi c'est dérivé et non deviné.** L'empreinte de
// région n'est recalculée que si le volume a été écrit depuis la dernière : la session en fait donc
// UNE seule lecture, à l'ouverture, quand la racine qui fait autorité est confrontée. Le témoin,
// lui, est écrit à chaque racine : la première écriture est celle du VIDAGE qui clôt la
// récupération, la seconde celle de la première barrière du guest — et c'est la seconde qui ouvre
// la fenêtre « racine durable, témoin absent ».

async function ouvrirBanc(page) {
  await page.goto("/vm/resilience.html");
  await expect(page.locator("#etat")).toHaveText("Banc de résilience prêt.");
}

/**
 * Point de coupure NEUTRE pour le plan du volume : une écriture bien au-delà de ce que le scénario
 * émet. Il ne se tire jamais, et c'est exactement ce qu'on veut — la seule coupure de ces deux
 * épreuves doit venir du plan de FRAÎCHEUR, sans quoi le verdict serait attribuable aux deux.
 */
const POINT_NEUTRE = Object.freeze({
  graine: 19,
  index: 0,
  kind: CRASH_KINDS.abrupt,
  operation: "write",
  occurrence: 10_000,
  bytes: null,
});

test("une coupure PENDANT l'empreinte de région refuse et ne coûte rien : le volume est intact", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);

  // Une lecture courte pendant le hachage est un support qui se dérobe : `empreinteDeRegion` refuse
  // de hacher une région partielle, et l'ADR 0019 dit pourquoi — une empreinte calculée sur moins
  // d'octets ne concorderait avec rien, et le refus qui suivrait désignerait un adversaire là où
  // c'est le support qui a lâché.
  const resultat = await page.evaluate(
    ({ point, fraicheur }) => globalThis.bancResilience.executerPoint(point, fraicheur),
    {
      point: POINT_NEUTRE,
      fraicheur: [{ kind: FAULT_KINDS.shortRead, operation: "read", occurrence: 1, bytes: 64 }],
    },
  );
  await testInfo.attach("vm-fraicheur-empreinte.json", {
    body: JSON.stringify(resultat, null, 2),
    contentType: "application/json",
  });

  // La faute a bien été TIRÉE, et c'est celle du plan de fraîcheur — pas celle du volume.
  expect(resultat.fraicheurTirees.length).toBe(1);
  expect(resultat.fraicheurNonTirees).toEqual([]);
  expect(resultat.fautesTirees).toEqual([]);

  // Elle s'est dite par une erreur TYPÉE du stockage, et par la bonne : une lecture courte.
  expect(resultat.arret).not.toBeNull();
  expect(resultat.arret.code).toBe("VAULT_STORAGE_SHORT_READ");

  // Ni écriture ni barrière : la coupure tombe à l'OUVERTURE, avant que le volume ne soit ouvert.
  expect(resultat.ecritures).toBe(0);
  expect(resultat.barrieres).toBe(0);

  // VERDICT ÉCRIT D'AVANCE : le volume porte l'ancien état, entier. Une coupure sur un contrôle de
  // fraîcheur ne coûte pas un octet — elle ne dépose rien, elle n'écarte rien, elle refuse.
  expect(resultat.verdict).toBe(VERDICTS.ancien);
  expect(resultat.atomique).toBe(true);
  expect(resultat.classes.dechire).toBe(0);
  expect(resultat.classes.corrompu).toBe(0);
  // La réouverture de classement, elle, se fait SANS faute : elle retrouve un volume propre, sans
  // génération en attente, et la fraîcheur y est vérifiée. Un refus qui laisserait le volume
  // irouvrable ensuite serait pire que la panne qu'il signale.
  expect(resultat.recuperation.etat).toBe("aucune");
  expect(resultat.recuperation.fraicheurRegion).toBe("verifiee");
  expect(resultat.reouverture.essais).toBe(1);
});

test("une coupure ENTRE la racine et le témoin laisse un témoin en retard, jamais un refus", async ({
  page,
}, testInfo) => {
  await ouvrirBanc(page);

  // Le témoin est écrit APRÈS la racine et sa barrière. La faute vise la SECONDE écriture de témoin
  // de la session — la première est celle du vidage qui clôt la récupération —, c'est-à-dire celle
  // de la première barrière du guest. Elle tombe donc dans la fenêtre exacte que l'ADR 0019 nomme :
  // la racine est durable, le témoin ne l'est pas. L'ordre inverse — témoin d'abord — laisserait un
  // témoin EN AVANCE, c'est-à-dire un volume intact refusé à la réouverture.
  const resultat = await page.evaluate(
    ({ point, fraicheur }) => globalThis.bancResilience.executerPoint(point, fraicheur),
    {
      point: POINT_NEUTRE,
      fraicheur: [{ kind: FAULT_KINDS.lostHandle, operation: "write", occurrence: 2 }],
    },
  );
  await testInfo.attach("vm-fraicheur-temoin.json", {
    body: JSON.stringify(resultat, null, 2),
    contentType: "application/json",
  });

  expect(resultat.fraicheurTirees.length).toBe(1);
  expect(resultat.fraicheurNonTirees).toEqual([]);
  expect(resultat.fautesTirees).toEqual([]);
  expect(resultat.arret).not.toBeNull();
  expect(resultat.arret.code).toBe("VAULT_STORAGE_HANDLE_LOST");
  // Le guest a bien écrit avant de tomber : sans cela, il n'y aurait aucune génération à valider et
  // la fenêtre visée n'aurait pas été atteinte.
  expect(resultat.ecritures).toBeGreaterThan(0);

  // VERDICT ÉCRIT D'AVANCE : la racine de la PREMIÈRE génération est durable — elle a été écrite et
  // sa barrière franchie avant que le témoin ne soit tenté —, donc la réouverture la REJOUE. Le
  // volume porte exactement la première génération du scénario, ni plus, ni moins.
  expect(resultat.verdict).toBe("generation-1");
  expect(resultat.atomique).toBe(true);
  expect(resultat.classes.dechire).toBe(0);
  expect(resultat.classes.corrompu).toBe(0);
  expect(resultat.recuperation.etat).toBe("rejouee");
  expect(resultat.recuperation.enregistrementsRejoues).toBeGreaterThan(0);
  // La génération du VOLUME, pas de la session : la préparation de l'ancien état en a déjà validé
  // `BARRIERES`, et la coupure en ajoute une seule.
  expect(resultat.recuperation.generation).toBe(BARRIERES + 1);

  // ET SURTOUT : la réouverture n'a PAS été refusée. Un témoin en retard sous-détecte — il ne
  // refuse jamais un volume que rien n'a fait reculer. Sans cette ligne, l'ordre des deux écritures
  // pourrait s'inverser sans que rien ne le voie.
  expect(resultat.recuperation.fraicheurRegion).toBe("verifiee");
});
