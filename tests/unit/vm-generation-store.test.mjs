import assert from "node:assert/strict";
import test from "node:test";

import { buildPattern } from "../../src/vm/block-fixture.mjs";
import {
  ENTETE_OCTETS,
  ZONE_ENREGISTREMENTS,
  crc32,
  encoderRacine,
  offsetDeRacine,
} from "../../src/vm/generation-format.mjs";
import {
  GENERATION_ETATS,
  GenerationStore,
  PLAFOND_CHARGE_OCTETS,
  TAMPON_RELECTURE_OCTETS,
} from "../../src/vm/generation-store.mjs";
import { openOpfsVolume } from "../../src/vm/opfs-block-backend.mjs";
import { createOpfsMigrationTarget } from "../../src/vm/opfs-migration-target.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

// Machine d'état d'une génération (#16, ADR 0014).
//
// Le magasin ne connaît ni OPFS ni v86 : il reçoit le handle du journal voisin et une fonction qui
// lit et écrit le VOLUME. C'est ce qui permet d'éprouver ici, sous Node, exactement le code que le
// Worker exécute sur le vrai support.

const TAILLE_VOLUME = 32 * 512;

/** Support jetable : un volume en mémoire et un handle de journal issu du double calibré. */
function creerSupport(tailleVolume = TAILLE_VOLUME) {
  const magasin = createSyncAccessStore();
  const volume = new Uint8Array(tailleVolume);
  const support = {
    magasin,
    volume,
    tailleVolume,
    /** Plus grande écriture reçue par le VOLUME. Une récupération en flux ne le charge pas d'un coup. */
    plusGrandeEcritureVolume: 0,
    /** Armé par un test pour couper le point de contrôle APRÈS la recopie et AVANT le vidage. */
    echouerBarriereVolume: false,
    lireVolume: (offset, longueur) => volume.slice(offset, offset + longueur),
    ecrireVolume: (offset, octets) => {
      support.plusGrandeEcritureVolume = Math.max(
        support.plusGrandeEcritureVolume,
        octets.byteLength,
      );
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

/**
 * Handle qui COMPTE la plus grande lecture demandée au support.
 *
 * C'est l'instrument de la surmémoire : `#lireJournal` alloue exactement le tampon qu'il présente à
 * `read`, si bien que la plus grande lecture EST la plus grande allocation que la récupération fait
 * pour elle-même. Mesurer ici, du côté du support, évite de croire le magasin sur parole.
 */
function handleComptant(handle, compte) {
  return {
    getSize: () => handle.getSize(),
    read(tampon, position) {
      compte.plusGrandeLecture = Math.max(compte.plusGrandeLecture, tampon.byteLength);
      compte.lectures += 1;
      return handle.read(tampon, position);
    },
    write: (octets, position) => handle.write(octets, position),
    truncate: (taille) => handle.truncate(taille),
    flush: () => handle.flush(),
    close: () => handle.close(),
  };
}

async function ouvrirMagasin(support, nom = "vol.gen", { enveloppe = (h) => h, ...reste } = {}) {
  const handle = enveloppe(await support.magasin.openHandle(nom));
  return GenerationStore.ouvrir({
    volume: "vol",
    handle,
    tailleVolume: support.tailleVolume,
    ...reste,
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

test("la cible de MIGRATION ouvre transactionnellement : une génération en attente est rejouée", async () => {
  // Point 10 de la revue. La migration, contrairement à la restauration, CONSERVE le contenu du
  // volume : une génération validée encore dans le journal doit y être rejouée AVANT toute mutation,
  // sous peine de perdre une écriture acquittée. C'est pourquoi sa cible ouvre par le chemin
  // transactionnel, là où la restauration ouvre avec `transactionnel: false`.
  const magasin = createSyncAccessStore();
  const nom = "vol-migre";
  const octetsVolume = 8 * 512;
  const nouveau = buildPattern(512, 4242);

  // Une session valide une génération puis meurt sans point de contrôle : les octets ne sont que
  // dans le journal voisin. Le magasin est piloté directement pour que la mort soit RÉELLE — pas de
  // fermeture propre, donc pas de rangement.
  const handleVolume = await magasin.openHandle(nom);
  handleVolume.truncate(octetsVolume);
  const handleJournal = await magasin.openHandle(`${nom}.gen`);
  const store = await GenerationStore.ouvrir({
    volume: nom,
    handle: handleJournal,
    tailleVolume: octetsVolume,
    lireVolume: (offset, longueur) => {
      const cible = new Uint8Array(longueur);
      handleVolume.read(cible, { at: offset });
      return cible;
    },
    ecrireVolume: (offset, octets) => handleVolume.write(octets, { at: offset }),
  });
  await store.deposer(0, nouveau);
  await store.valider();
  magasin.abandon(nom);
  magasin.abandon(`${nom}.gen`);
  assert.notDeepEqual(
    [...magasin.snapshot(nom).subarray(0, 512)],
    [...nouveau],
    "le volume ne porte pas encore la génération : elle n'est que dans le journal",
  );

  // La cible de migration ouvre le volume. La récupération doit rejouer la génération validée.
  const cible = createOpfsMigrationTarget(nom, {
    stat: () => Promise.resolve({ present: true, size: octetsVolume }),
    openVolume: (options) => openOpfsVolume({ ...options, openHandle: magasin.openHandle }),
  });
  const backend = await cible.open({ size: octetsVolume });
  try {
    assert.equal(
      backend.describe().transactionnel,
      true,
      "la migration ouvre transactionnellement",
    );
    assert.equal(backend.generation.rapport.etat, GENERATION_ETATS.rejouee);
    assert.deepEqual([...(await backend.read(0, 512))], [...nouveau]);
  } finally {
    await backend.close();
  }
});

// --------------------------------------------------------- rejeu en FLUX (#91)

/** Plafond réduit du banc de flux : la propriété mesurée ne dépend pas de sa valeur. */
const PLAFOND_BANC = 4 * 1024 * 1024;
/** Volume du banc : assez large pour porter la charge à des offsets distincts. */
const VOLUME_BANC = 8 * 1024 * 1024;
/** Taille d'un enregistrement déposé. Un ordre de grandeur d'écriture de guest. */
const ENREGISTREMENT_BANC = 64 * 1024;
/** Nombre d'enregistrements que le plafond du banc laisse déposer. */
const ENREGISTREMENTS_BANC = Math.floor(PLAFOND_BANC / (ENREGISTREMENT_BANC + ENTETE_OCTETS));

/** Dépose la charge du banc dans un magasin ouvert. Rend les octets déposés. */
async function remplirLeBanc(magasin) {
  for (let rang = 0; rang < ENREGISTREMENTS_BANC; rang += 1) {
    await magasin.deposer(rang * ENREGISTREMENT_BANC, buildPattern(ENREGISTREMENT_BANC, rang + 1));
  }
  return magasin.octetsDeCharge;
}

/** Options communes du banc : plafond réduit, et aucun rangement automatique. */
const OPTIONS_BANC = { plafondOctets: PLAFOND_BANC, seuilPointDeControle: PLAFOND_BANC * 2 };

test("la récupération rejoue en FLUX : sa surmémoire de pointe ne suit pas la taille de la charge", async () => {
  // Défaut MEDIUM-2 de la revue de #90. La récupération lisait la charge validée d'un seul tenant,
  // puis en extrayait une tranche par enregistrement : au plafond de 64 Mio, elle allouait jusqu'à
  // ~128 Mio, là où `docs/quality-attributes.md` borne la surmémoire de streaming à 64 Mio et exige
  // explicitement ce régime pour l'export et la restauration.
  //
  // La propriété mesurée ici ne dépend PAS de la valeur du plafond : la plus grande allocation de la
  // récupération est bornée par une CONSTANTE du magasin, jamais par la charge. C'est pourquoi le
  // banc tourne à 4 Mio — assez pour que l'ancien code rougisse d'un ordre de grandeur, assez peu
  // pour que `npm run check` reste tenable.
  const support = creerSupport(VOLUME_BANC);
  const premier = await ouvrirMagasin(support, "vol.gen", OPTIONS_BANC);
  const charge = await remplirLeBanc(premier);
  await premier.valider();
  // La session meurt sans point de contrôle : la charge validée est encore dans le journal.
  support.magasin.abandon("vol.gen");
  assert.ok(charge > PLAFOND_BANC * 0.9, `charge ${charge} proche du plafond ${PLAFOND_BANC}`);

  const compte = { plusGrandeLecture: 0, lectures: 0 };
  support.plusGrandeEcritureVolume = 0;
  const second = await ouvrirMagasin(support, "vol.gen", {
    ...OPTIONS_BANC,
    enveloppe: (handle) => handleComptant(handle, compte),
  });

  assert.equal(second.rapport.etat, GENERATION_ETATS.rejouee);
  assert.equal(second.rapport.enregistrementsRejoues, ENREGISTREMENTS_BANC);

  // LA BORNE. Ni une lecture du journal, ni une écriture du volume ne tient la charge entière.
  assert.ok(
    compte.plusGrandeLecture <= TAMPON_RELECTURE_OCTETS,
    `plus grande lecture ${compte.plusGrandeLecture} ≤ tampon ${TAMPON_RELECTURE_OCTETS}`,
  );
  assert.ok(
    support.plusGrandeEcritureVolume <= TAMPON_RELECTURE_OCTETS,
    `plus grande écriture du volume ${support.plusGrandeEcritureVolume}`,
  );
  // Et le magasin la PUBLIE, comme l'export et la restauration publient la leur.
  assert.ok(second.rapport.surmemoireMaxOctets > 0, "la surmémoire de pointe est publiée");
  assert.ok(
    second.rapport.surmemoireMaxOctets <= TAMPON_RELECTURE_OCTETS,
    `surmémoire publiée ${second.rapport.surmemoireMaxOctets} ≤ ${TAMPON_RELECTURE_OCTETS}`,
  );
  // Le chiffre publié est une ALLOCATION, pas une lecture : le magasin alloue le tampon une fois et
  // le prête à chaque tranche. Il MAJORE donc ce que le support a vu — jamais l'inverse, sans quoi
  // la récupération tiendrait de la mémoire qu'elle ne déclare pas.
  assert.ok(
    second.rapport.surmemoireMaxOctets >= compte.plusGrandeLecture,
    `surmémoire publiée ${second.rapport.surmemoireMaxOctets} ≥ plus grande lecture ${compte.plusGrandeLecture}`,
  );
  // Et la charge validée est publiée avec elle : sans ce chiffre, le rapport dirait combien
  // d'enregistrements ont été rejoués sans jamais dire combien d'octets ils pesaient (#91, point 4).
  assert.equal(second.rapport.octetsRejoues, charge);

  // Le rejeu est EXACT : chaque enregistrement a retrouvé son offset, octet pour octet.
  for (let rang = 0; rang < ENREGISTREMENTS_BANC; rang += 1) {
    const debut = rang * ENREGISTREMENT_BANC;
    const attendu = buildPattern(ENREGISTREMENT_BANC, rang + 1);
    assert.deepEqual(
      [...support.volume.subarray(debut, debut + ENREGISTREMENT_BANC)],
      [...attendu],
      `enregistrement ${rang}`,
    );
  }
  second.close();
});

test("le tampon de relecture borne aussi la récupération au PLAFOND de production", () => {
  // Le banc ci-dessus tourne à plafond réduit : ce que la borne vaut au plafond réel n'est pas
  // mesuré par lui, il est DÉDUIT — le tampon est une constante du magasin, indépendante du plafond.
  // Cette ligne l'épingle : si le tampon redevenait proportionnel à la charge, elle rougirait avant
  // que la surmémoire ne dépasse le budget de `docs/quality-attributes.md`.
  const budgetSurmemoire = 64 * 1024 * 1024;
  assert.ok(
    TAMPON_RELECTURE_OCTETS < PLAFOND_CHARGE_OCTETS,
    "le tampon est plus petit que la charge",
  );
  assert.ok(TAMPON_RELECTURE_OCTETS <= budgetSurmemoire, "le tampon tient dans le budget");
});

test("le point de contrôle range la charge en FLUX, lui aussi", async () => {
  // Le point de contrôle emprunte le MÊME chemin que la récupération : sans borne, il allouerait
  // autant qu'elle. La mesure est ici prise sur la session vivante, avant toute mort.
  const support = creerSupport(VOLUME_BANC);
  const compte = { plusGrandeLecture: 0, lectures: 0 };
  const magasin = await ouvrirMagasin(support, "vol.gen", {
    ...OPTIONS_BANC,
    enveloppe: (handle) => handleComptant(handle, compte),
  });
  await remplirLeBanc(magasin);
  await magasin.valider();

  compte.plusGrandeLecture = 0;
  support.plusGrandeEcritureVolume = 0;
  await magasin.pointDeControle();

  assert.ok(
    compte.plusGrandeLecture <= TAMPON_RELECTURE_OCTETS,
    `plus grande lecture ${compte.plusGrandeLecture} ≤ tampon ${TAMPON_RELECTURE_OCTETS}`,
  );
  assert.ok(
    support.plusGrandeEcritureVolume <= TAMPON_RELECTURE_OCTETS,
    `plus grande écriture du volume ${support.plusGrandeEcritureVolume}`,
  );
  const dernier = (ENREGISTREMENTS_BANC - 1) * ENREGISTREMENT_BANC;
  assert.deepEqual(
    [...support.volume.subarray(dernier, dernier + ENREGISTREMENT_BANC)],
    [...buildPattern(ENREGISTREMENT_BANC, ENREGISTREMENTS_BANC)],
  );
  magasin.close();
});
