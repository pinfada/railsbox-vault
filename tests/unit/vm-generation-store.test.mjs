import assert from "node:assert/strict";
import test from "node:test";

import { buildPattern } from "../../src/vm/block-fixture.mjs";
import {
  ZONE_ENREGISTREMENTS,
  crc32,
  encoderRacine,
  offsetDeRacine,
} from "../../src/vm/generation-format.mjs";
import { GENERATION_ETATS, GenerationStore } from "../../src/vm/generation-store.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

// Machine d'état d'une génération (#16, ADR 0014).
//
// Le magasin ne connaît ni OPFS ni v86 : il reçoit le handle du journal voisin et une fonction qui
// lit et écrit le VOLUME. C'est ce qui permet d'éprouver ici, sous Node, exactement le code que le
// Worker exécute sur le vrai support.

const TAILLE_VOLUME = 32 * 512;

/** Support jetable : un volume en mémoire et un handle de journal issu du double calibré. */
function creerSupport() {
  const magasin = createSyncAccessStore();
  const volume = new Uint8Array(TAILLE_VOLUME);
  const support = {
    magasin,
    volume,
    /** Armé par un test pour couper le point de contrôle APRÈS la recopie et AVANT le vidage. */
    echouerBarriereVolume: false,
    lireVolume: (offset, longueur) => volume.slice(offset, offset + longueur),
    ecrireVolume: (offset, octets) => {
      volume.set(octets, offset);
      return octets.byteLength;
    },
    barriereVolume: async () => {
      if (support.echouerBarriereVolume) throw new DOMException("Barrière refusée", "AbortError");
    },
  };
  return support;
}

/**
 * Handle dont l'ÉCRITURE échoue tant que `refuse` est armé. Le double calibré sait affamer un
 * fichier, mais définitivement : un test qui doit rouvrir ensuite a besoin d'une panne qu'on désarme.
 */
function handleRefusant(handle, etat) {
  return {
    getSize: () => handle.getSize(),
    read: (tampon, position) => handle.read(tampon, position),
    write(octets, position) {
      if (etat.refuse) throw new DOMException("Plus de place", "QuotaExceededError");
      return handle.write(octets, position);
    },
    truncate: (taille) => handle.truncate(taille),
    flush: () => handle.flush(),
    close: () => handle.close(),
  };
}

async function ouvrirMagasin(support, nom = "vol.gen", { enveloppe = (h) => h } = {}) {
  const handle = enveloppe(await support.magasin.openHandle(nom));
  return GenerationStore.ouvrir({
    volume: "vol",
    handle,
    tailleVolume: TAILLE_VOLUME,
    lireVolume: support.lireVolume,
    ecrireVolume: support.ecrireVolume,
    barriereVolume: support.barriereVolume,
  });
}

test("un journal vierge n'annonce aucune génération en attente et laisse le volume intact", async () => {
  const support = creerSupport();
  support.volume.set(buildPattern(512, 1), 0);
  const magasin = await ouvrirMagasin(support);

  assert.equal(magasin.rapport.etat, GENERATION_ETATS.aucune);
  assert.equal(magasin.generationValidee, 0);
  assert.deepEqual([...support.volume.subarray(0, 512)], [...buildPattern(512, 1)]);
});

test("une écriture déposée n'atteint pas le volume avant la validation, mais se relit d'elle-même", async () => {
  const support = creerSupport();
  const ancien = buildPattern(512, 1000);
  const nouveau = buildPattern(512, 2000);
  support.volume.set(ancien, 0);

  const magasin = await ouvrirMagasin(support);
  await magasin.deposer(0, nouveau);

  // Le VOLUME porte encore l'ancien état : la génération n'est pas validée.
  assert.deepEqual([...support.volume.subarray(0, 512)], [...ancien]);
  // Mais l'écrivain relit ce qu'il vient d'écrire : v86 attend cette cohérence de session.
  assert.deepEqual([...magasin.lire(0, 512)], [...nouveau]);
});

test("la validation rend la génération visible, et elle seule", async () => {
  const support = creerSupport();
  const nouveau = buildPattern(512, 2000);
  const magasin = await ouvrirMagasin(support);

  await magasin.deposer(0, nouveau);
  assert.equal(magasin.generationValidee, 0);
  await magasin.valider();
  assert.equal(magasin.generationValidee, 1);

  await magasin.pointDeControle();
  assert.deepEqual([...support.volume.subarray(0, 512)], [...nouveau]);
});

test("une génération déposée mais jamais validée est ÉCARTÉE à la réouverture, et le dit", async () => {
  const support = creerSupport();
  const ancien = buildPattern(512, 1000);
  support.volume.set(ancien, 0);

  const premier = await ouvrirMagasin(support);
  await premier.deposer(0, buildPattern(512, 2000));
  // Aucune validation : la machine meurt ici.
  support.magasin.abandon("vol.gen");

  const second = await ouvrirMagasin(support);
  assert.equal(second.rapport.etat, GENERATION_ETATS.ecartee);
  assert.equal(second.rapport.code, "VAULT_STORAGE_GENERATION_DISCARDED");
  assert.ok(second.rapport.octetsEcartes > 0);
  assert.deepEqual([...support.volume.subarray(0, 512)], [...ancien]);
});

test("une génération validée est REJOUÉE à la réouverture même si le point de contrôle a manqué", async () => {
  const support = creerSupport();
  const nouveau = buildPattern(512, 2000);

  const premier = await ouvrirMagasin(support);
  await premier.deposer(0, nouveau);
  await premier.valider();
  // Mort avant le point de contrôle : les octets ne sont que dans le journal.
  support.magasin.abandon("vol.gen");
  assert.notDeepEqual([...support.volume.subarray(0, 512)], [...nouveau]);

  const second = await ouvrirMagasin(support);
  assert.equal(second.rapport.etat, GENERATION_ETATS.rejouee);
  assert.equal(second.rapport.generation, 1);
  assert.deepEqual([...support.volume.subarray(0, 512)], [...nouveau]);
});

test("une génération validée dont la charge est abîmée est REFUSÉE, jamais devinée", async () => {
  const support = creerSupport();
  const premier = await ouvrirMagasin(support);
  await premier.deposer(0, buildPattern(512, 2000));
  await premier.valider();
  support.magasin.abandon("vol.gen");

  // Un octet de la charge du journal est retourné : la racine reste valide, la charge non.
  const handle = await support.magasin.openHandle("vol.gen");
  const octet = new Uint8Array(1);
  handle.read(octet, { at: ZONE_ENREGISTREMENTS + 32 });
  octet[0] ^= 0xff;
  handle.write(octet, { at: ZONE_ENREGISTREMENTS + 32 });
  handle.close();

  await assert.rejects(
    () => ouvrirMagasin(support),
    (erreur) => {
      assert.ok(isStorageError(erreur, STORAGE_ERROR_CODES.generationCorrupt));
      assert.match(erreur.message, /génération/i);
      return true;
    },
  );
});

test("la racine alterne : une validation déchirée ne détruit pas la génération qu'elle remplace", async () => {
  const support = creerSupport();
  const g1 = buildPattern(512, 2000);
  const premier = await ouvrirMagasin(support);
  await premier.deposer(0, g1);
  await premier.valider();

  // La génération 1 fait autorité ici. La suivante ira, par construction, sur l'AUTRE emplacement.
  const emplacementAutoritaire = premier.racineOffset;
  const emplacementSuivant = premier.prochaineRacineOffset;
  assert.notEqual(emplacementSuivant, emplacementAutoritaire);

  await premier.deposer(512, buildPattern(512, 3000));
  support.magasin.abandon("vol.gen");

  // La deuxième validation est écrite à moitié : son secteur est brouillé, celui de la première non.
  const handle = await support.magasin.openHandle("vol.gen");
  handle.write(new Uint8Array(200).fill(0xa5), { at: emplacementSuivant });
  handle.close();

  const second = await ouvrirMagasin(support);
  assert.equal(second.generationValidee, 1);
  assert.equal(second.rapport.etat, GENERATION_ETATS.rejouee);
  assert.deepEqual([...support.volume.subarray(0, 512)], [...g1]);
});

test("une écriture non alignée sur le secteur est complétée par relecture, pas refusée en silence", async () => {
  const support = creerSupport();
  const ancien = buildPattern(512, 1000);
  support.volume.set(ancien, 0);
  const magasin = await ouvrirMagasin(support);

  await magasin.deposer(100, Uint8Array.from([1, 2, 3, 4]));
  const relu = magasin.lire(0, 512);
  assert.deepEqual([...relu.subarray(100, 104)], [1, 2, 3, 4]);
  assert.deepEqual([...relu.subarray(0, 100)], [...ancien.subarray(0, 100)]);
  assert.deepEqual([...relu.subarray(104)], [...ancien.subarray(104)]);
});

test("une validation dont la racine échoue ne rend pas la génération rangeable", async () => {
  // Le support refuse la barrière qui scelle la racine : la génération n'est PAS validée, et le guest
  // reçoit l'échec. Le magasin ne doit pas se croire scellé pour autant — sinon la fermeture propre
  // rangerait dans le volume un état que personne n'a acquitté. C'est un ordre, pas une intention :
  // les compteurs de validation ne bougent qu'APRÈS le succès de la racine.
  const support = creerSupport();
  const ancien = buildPattern(512, 1000);
  support.volume.set(ancien, 0);
  const magasin = await ouvrirMagasin(support);

  await magasin.deposer(0, buildPattern(512, 2000));
  support.magasin.starve("vol.gen");

  await assert.rejects(() => magasin.valider());
  assert.equal(magasin.generationValidee, 0, "aucune génération n'a été validée");
  assert.equal(magasin.rangeable, false, "rien n'est rangeable");
  await magasin.pointDeControle();
  assert.deepEqual(
    [...support.volume.subarray(0, 512)],
    [...ancien],
    "le volume porte encore l'état d'avant",
  );
});

test("un point de contrôle interrompu ne rend pas le volume irouvrable", async () => {
  // Le point de contrôle recopie la charge validée dans le volume, PUIS vide le journal. S'il est
  // interrompu entre les deux — quota, handle perdu, mort de l'onglet —, les octets sont dans le
  // volume ET la racine les déclare encore dans le journal. La réouverture doit alors les REJOUER
  // une seconde fois, ce qui est sans effet, et surtout PAS refuser le volume.
  //
  // C'est l'ordre qui le garantit : la racine vide est rendue durable AVANT la troncature. L'ordre
  // inverse retirerait du fichier des octets qu'une racine autoritaire déclare toujours, et la
  // réouverture lèverait `VAULT_STORAGE_GENERATION_CORRUPT` sur une donnée pourtant intacte.
  const support = creerSupport();
  const nouveau = buildPattern(512, 2000);

  const etat = { refuse: false };
  const premier = await ouvrirMagasin(support, "vol.gen", {
    enveloppe: (handle) => handleRefusant(handle, etat),
  });
  await premier.deposer(0, nouveau);
  await premier.valider();

  // Le support refuse d'écrire au moment PRÉCIS où le point de contrôle vide le journal : les octets
  // sont déjà dans le volume, la racine les déclare encore dans le journal. C'est la fenêtre où
  // l'ordre des gestes décide du sort du volume.
  etat.refuse = true;
  await assert.rejects(() => premier.pointDeControle());
  support.magasin.abandon("vol.gen");

  // La session suivante retrouve un support sain — l'exploitant a libéré de la place, ou rouvert
  // l'onglet. Le volume doit alors S'OUVRIR, et sa génération être rejouée une seconde fois, ce qui
  // est sans effet. Avec l'ordre inverse — troncature avant racine —, la racine autoritaire
  // déclarerait une charge que le fichier ne porte plus, et l'ouverture lèverait
  // `VAULT_STORAGE_GENERATION_CORRUPT` sur une donnée pourtant intacte.
  const second = await ouvrirMagasin(support);
  assert.equal(second.rapport.etat, GENERATION_ETATS.rejouee, second.rapport.raison ?? "");
  assert.equal(second.generationValidee, 1);
  assert.deepEqual([...support.volume.subarray(0, 512)], [...nouveau]);
});

test("le journal borné refuse la génération démesurée au lieu de la publier à moitié", async () => {
  const support = creerSupport();
  const handle = await support.magasin.openHandle("vol.gen");
  const magasin = await GenerationStore.ouvrir({
    volume: "vol",
    handle,
    tailleVolume: TAILLE_VOLUME,
    lireVolume: support.lireVolume,
    ecrireVolume: support.ecrireVolume,
    barriereVolume: support.barriereVolume,
    plafondOctets: 1024,
  });

  await magasin.deposer(0, buildPattern(512, 2000));
  await assert.rejects(
    () => magasin.deposer(512, buildPattern(512, 2001)),
    (erreur) => isStorageError(erreur, STORAGE_ERROR_CODES.generationOverflow),
  );
});

test("deux racines ABÎMÉES au-dessus d'une charge sont un REFUS, pas une mise au rebut", async () => {
  // Défaut HIGH-1 de la revue de #90. `decoderRacine` distingue le secteur VIERGE — jamais écrit —
  // du secteur ABÎMÉ, et le magasin jetait cette distinction : deux racines illisibles au-dessus
  // d'une charge donnaient `ecartee`, présenté comme « l'issue normale d'une coupure ». Or une de
  // ces racines a pu sceller une génération ACQUITTÉE : ce qui a été validé est inconnu, et
  // l'écarter perdrait peut-être une écriture durable.
  const support = creerSupport();
  const nouveau = buildPattern(512, 2000);
  const premier = await ouvrirMagasin(support);
  await premier.deposer(0, nouveau);
  await premier.valider();
  support.magasin.abandon("vol.gen");

  // Les DEUX secteurs de racine sont brouillés — ni vierges, ni lisibles.
  const handle = await support.magasin.openHandle("vol.gen");
  handle.write(new Uint8Array(64).fill(0xa5), { at: offsetDeRacine(0) });
  handle.write(new Uint8Array(64).fill(0x5a), { at: offsetDeRacine(1) });
  handle.close();

  await assert.rejects(
    () => ouvrirMagasin(support),
    (erreur) => {
      assert.ok(isStorageError(erreur, STORAGE_ERROR_CODES.generationRootCorrupt), erreur.code);
      assert.match(erreur.message, /INCONNU/);
      return true;
    },
  );
});

test("un journal VIERGE et vide n'est pas une avarie, et n'écrit RIEN", async () => {
  // Deux propriétés en une. La première : des secteurs jamais écrits ne sont pas des racines
  // abîmées — sans quoi tout premier volume serait refusé. La seconde (MEDIUM-3 de la revue) : une
  // ouverture qui n'a rien à récupérer ne doit rien écrire, faute de quoi un EXPORT sur un support
  // saturé échouerait — c'est-à-dire le geste même par lequel l'utilisateur libère de la place.
  const support = creerSupport();
  const magasin = await ouvrirMagasin(support);
  assert.equal(magasin.rapport.etat, GENERATION_ETATS.aucune);
  assert.equal(support.magasin.sizeOf("vol.gen"), 0, "aucun octet écrit par l'ouverture");
  assert.equal(support.magasin.flushCount("vol.gen"), 0, "aucune barrière franchie");
});

test("entre deux racines VALIDES, la séquence la plus haute fait autorité", async () => {
  // MEDIUM-4 de la revue : la règle était jusqu'ici attrapée par accident, via la longueur de charge.
  // Ici les deux racines sont valides et scellent la MÊME charge ; seule la séquence les départage.
  const support = creerSupport();
  const handle = await support.magasin.openHandle("vol.gen");
  const charge = new Uint8Array(0);
  const racine = (sequence, generation) =>
    encoderRacine({
      sequence,
      generation,
      tailleVolume: TAILLE_VOLUME,
      enregistrements: 0,
      longueurCharge: 0,
      sommeCharge: crc32(charge),
    });
  handle.truncate(ZONE_ENREGISTREMENTS);
  handle.write(racine(8, 4), { at: offsetDeRacine(0) });
  handle.write(racine(9, 5), { at: offsetDeRacine(1) });
  handle.close();

  const magasin = await ouvrirMagasin(support);
  assert.equal(magasin.generationValidee, 5, "la séquence 9 l'emporte sur la séquence 8");
});

test("les deux racines ne partagent aucune page de 4 Kio du support", async () => {
  // Défaut HIGH-2 de la revue de #90. Refuser l'atomicité sectorielle — la racine porte sa propre
  // somme de contrôle — tout en supposant gratuitement qu'une écriture ne peut pas abîmer un secteur
  // voisin dans la MÊME page hôte serait incohérent. Les deux emplacements sont donc écartés d'une
  // page entière. L'hypothèse qui reste — deux pages distinctes tombent indépendamment — est écrite
  // dans l'ADR 0014, pas supposée en silence.
  assert.equal(offsetDeRacine(0), 0);
  assert.ok(offsetDeRacine(1) >= 4096, `écart de ${offsetDeRacine(1)} octets`);
  assert.equal(offsetDeRacine(1) % 4096, 0);
  assert.ok(ZONE_ENREGISTREMENTS >= 2 * 4096);
});
