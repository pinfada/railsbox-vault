import assert from "node:assert/strict";
import test from "node:test";

import { buildPattern } from "../../src/vm/block-fixture.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import {
  SURCOUT_ENREGISTREMENT,
  ZONE_ENREGISTREMENTS,
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
import { libererVolume } from "../../src/vm/opfs-volume-registry.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { STORAGE_ERROR_CODES, isStorageError } from "../../src/vm/storage-errors.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";
import { identifiantVolumeEnOctets } from "../../src/vm/volume-chiffre-format.mjs";

// Machine d'état d'une génération (#16, ADR 0014 ; #18, ADR 0016).
//
// Le magasin ne connaît ni OPFS ni v86 : il reçoit le handle du journal voisin, un SCELLEMENT, et
// deux fonctions qui lisent et écrivent le VOLUME. C'est ce qui permet d'éprouver ici, sous Node,
// exactement le code que le Worker exécute sur le vrai support.
//
// Depuis #18, le volume que ces épreuves simulent est le volume DÉCHIFFRÉ : la couche chiffrée vit
// au-dessus (`volume-chiffre.mjs`, éprouvée par `vm-volume-chiffre.test.mjs`), et ce qui est mesuré
// ici reste la machine d'état — dépôt, validation, rangement, récupération.

const TAILLE_VOLUME = 32 * 512;
const IDENTIFIANT = "0123456789abcdef0123456789abcdef";

/** Un scellement neuf sous la clé de TEST. Chaque magasin a le sien, comme en production. */
function scellementDEpreuve(volume = IDENTIFIANT) {
  return Scellement.ouvrir({ volume, cleOctets: CLE_DE_TEST, formatVersion: 3 });
}

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
    lireVolume: async (offset, longueur) => volume.slice(offset, offset + longueur),
    ecrireVolume: async (offset, octets) => {
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
    // La fraîcheur de l'ADR 0019 est DÉCLARÉE absente : ce banc n'ouvre pas un volume v3 complet et
    // n'a donc ni région d'authentification ni voisin où poser un témoin. Elle est éprouvée sur le
    // chemin de production par `vm-generation-fraicheur.test.mjs`.
    fraicheur: null,
    scellement: await scellementDEpreuve(),
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
  assert.deepEqual([...(await magasin.lire(0, 512))], [...nouveau]);
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

  // Un octet du CHIFFRÉ du premier enregistrement est retourné : la racine reste décodable, son
  // étiquette aussi — c'est celle de l'enregistrement qui ne vérifie plus. Depuis #18 le refus est
  // donc `VAULT_STORAGE_SCEAU_REFUSE` et non `GENERATION_CORRUPT` : la cause n'est pas établie, et
  // le message le dit plutôt que d'inventer un diagnostic (ADR 0015, ADR 0016 décision 9).
  const handle = await support.magasin.openHandle("vol.gen");
  const octet = new Uint8Array(1);
  const cible = ZONE_ENREGISTREMENTS + SURCOUT_ENREGISTREMENT + 32;
  handle.read(octet, { at: cible });
  octet[0] ^= 0xff;
  handle.write(octet, { at: cible });
  handle.close();

  await assert.rejects(
    () => ouvrirMagasin(support),
    (erreur) => {
      assert.ok(isStorageError(erreur, STORAGE_ERROR_CODES.sceauRefuse), erreur.code);
      assert.match(erreur.message, /aucun clair n'est rendu/i);
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
  const relu = await magasin.lire(0, 512);
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
    scellement: await scellementDEpreuve(),
    fraicheur: null,
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
  //
  // Les deux racines sont réellement SCELLÉES sous la clé de TEST : une racine forgée à la main
  // serait refusée par son étiquette avant que la séquence n'ait eu à départager quoi que ce soit,
  // et l'épreuve mesurerait alors le refus, pas l'autorité.
  const support = creerSupport();
  const handle = await support.magasin.openHandle("vol.gen");
  const scellement = await scellementDEpreuve();
  const racine = async (sequence, generation) => {
    const scelle = await scellement.scellerRacine(
      { sequence, generation, tailleVolume: TAILLE_VOLUME },
      [],
      { sequencePrecedente: null },
    );
    return encoderRacine({
      sequence,
      generation,
      tailleVolume: TAILLE_VOLUME,
      nombreEntrees: 0,
      longueurCharge: 0,
      identifiantVolume: identifiantVolumeEnOctets(IDENTIFIANT),
      scellementsCumules: scelle.entete.scellementsCumules,
      nonce: scelle.nonce,
      chiffre: scelle.chiffre,
      etiquette: scelle.etiquette,
      // Ces racines ne répondent que d'une question — laquelle des deux séquences fait autorité —
      // et ce banc n'a pas de région d'authentification. Elles n'en scellent donc aucune, et le
      // DÉCLARENT : `null` est une décision, `undefined` serait un oubli que l'encodeur refuse.
      fraicheur: null,
    });
  };
  handle.truncate(ZONE_ENREGISTREMENTS);
  handle.write(await racine(8, 4), { at: offsetDeRacine(0) });
  handle.write(await racine(9, 5), { at: offsetDeRacine(1) });
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
  const ouvrirVolume = (options) =>
    openOpfsVolume({
      ...options,
      cle: CLE_DE_TEST,
      openHandle: magasin.openHandle,
      // Un seuil hors de portée : la barrière VALIDE la génération sans la ranger, ce qui est
      // exactement l'état que la migration doit trouver.
      seuilPointDeControle: 1024 * 1024,
    });

  // Une session valide une génération puis MEURT sans point de contrôle : les octets ne sont que
  // dans le journal voisin. Pas de fermeture propre, donc pas de rangement.
  const premier = await ouvrirVolume({ name: nom, size: octetsVolume });
  await premier.write(0, nouveau);
  await premier.flush();
  magasin.abandon(nom);
  magasin.abandon(`${nom}.gen`);
  // Le TÉMOIN de séquence (#19) est un voisin de plus, tenu par la session : une machine qui meurt
  // le relâche comme les deux autres, et l'oublier ici ferait échouer la réouverture sur une
  // exclusivité que plus personne ne détient.
  magasin.abandon(`${nom}.temoin`);
  libererVolume(nom);

  // La cible de migration ouvre le volume. La récupération doit rejouer la génération validée.
  const cible = createOpfsMigrationTarget(nom, {
    stat: () => Promise.resolve({ present: true, size: octetsVolume }),
    openVolume: ouvrirVolume,
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
const ENREGISTREMENTS_BANC = Math.floor(
  PLAFOND_BANC / (ENREGISTREMENT_BANC + SURCOUT_ENREGISTREMENT),
);

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

  // LE NOMBRE D'APPELS AU SUPPORT est borné par la TAILLE de la charge, pas par le nombre
  // d'enregistrements. Ce n'est pas une élégance : la première version en flux lisait l'en-tête puis
  // les octets de chaque enregistrement séparément, soit quatre appels par enregistrement sur les
  // deux passes. Mesuré sur OPFS réel, un appel synchrone coûte ~290 µs, et une charge de 64 Mio
  // découpée en enregistrements de 512 octets demandait 201 s — 3,4 fois le budget de 60 s de
  // `docs/quality-attributes.md`. La fenêtre glissante ramène les lectures à deux passes sur la
  // charge, et laisse la recopie du volume seule à croître avec le nombre d'enregistrements.
  const passes = 2;
  const marge = 4; // racines relues, tranches à cheval sur une fenêtre.
  const plafondLectures = passes * (Math.ceil(charge / TAMPON_RELECTURE_OCTETS) + marge);
  assert.ok(
    compte.lectures <= plafondLectures,
    `${compte.lectures} lecture(s) du support ≤ ${plafondLectures} pour ${ENREGISTREMENTS_BANC} enregistrement(s)`,
  );

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

test("un enregistrement PLUS GRAND que le tampon est LU par tranches, et sa borne a changé", async () => {
  // Le cas que la fenêtre glissante doit tenir : un seul enregistrement dépasse le tampon, si bien
  // qu'il est relu EN PLUSIEURS FOIS. Rien dans le format ne borne la taille d'un enregistrement —
  // c'est la taille d'une écriture du guest —, et un magasin qui supposerait qu'un enregistrement
  // tient dans son tampon échouerait sur la première écriture groupée un peu large.
  //
  // **Ce que #18 change, et qu'il faut écrire plutôt que laisser découvrir.** Une étiquette
  // AES-GCM couvre l'enregistrement ENTIER : on ne peut pas en ouvrir la moitié, et rendre des
  // octets avant d'avoir vérifié l'étiquette serait exactement le clair partiel que le format
  // refuse. La LECTURE du journal reste donc bornée par le tampon, mais le CLAIR d'un
  // enregistrement est tenu entier le temps de son rejeu, et l'écriture du volume l'est aussi. La
  // borne de la récupération n'est plus « le tampon », elle est « le plus grand ENREGISTREMENT ».
  //
  // C'est une limite nommée par l'ADR 0016 (limite 6) et non une régression découverte : au plafond
  // de charge de 64 Mio, un enregistrement unique de cette taille tiendrait 128 Mio en mémoire
  // (chiffré et clair), au-delà du budget de surmémoire de `docs/quality-attributes.md`. Le relevé
  // de bout en bout mesure des écritures de guest de 512 o à 64 Kio ; borner la taille d'un
  // enregistrement — ou le découper — relève de #91, pas de cette tranche.
  const grand = TAMPON_RELECTURE_OCTETS + 512 * 1024;
  const support = creerSupport(VOLUME_BANC);
  const premier = await ouvrirMagasin(support, "vol.gen", OPTIONS_BANC);
  await premier.deposer(0, buildPattern(grand, 42));
  // Un second enregistrement, petit, DERRIÈRE le grand : il oblige la fenêtre à se recharger sur un
  // en-tête qui ne commence pas à une frontière de tampon.
  await premier.deposer(VOLUME_BANC - 512, buildPattern(512, 43));
  await premier.valider();
  support.magasin.abandon("vol.gen");

  const compte = { plusGrandeLecture: 0, lectures: 0 };
  support.plusGrandeEcritureVolume = 0;
  const second = await ouvrirMagasin(support, "vol.gen", {
    ...OPTIONS_BANC,
    enveloppe: (handle) => handleComptant(handle, compte),
  });

  assert.equal(second.rapport.etat, GENERATION_ETATS.rejouee);
  assert.equal(second.rapport.enregistrementsRejoues, 2);
  // La LECTURE du journal reste bornée par le tampon : la fenêtre glissante fait son travail.
  assert.ok(
    compte.plusGrandeLecture <= TAMPON_RELECTURE_OCTETS,
    `plus grande lecture ${compte.plusGrandeLecture}`,
  );
  // L'ÉCRITURE du volume, elle, est bornée par le plus grand ENREGISTREMENT — pas par la charge.
  // La distinction compte : la première borne est une constante du magasin, la seconde suit la
  // demande du guest, et c'est celle-là qu'il faut surveiller (limite 6 de l'ADR 0016).
  assert.equal(
    support.plusGrandeEcritureVolume,
    grand,
    "le rejeu écrit un enregistrement entier à la fois",
  );
  assert.ok(support.plusGrandeEcritureVolume < premier.chargeMaxDeposeeOctets);
  assert.deepEqual([...support.volume.subarray(0, grand)], [...buildPattern(grand, 42)]);
  assert.deepEqual([...support.volume.subarray(VOLUME_BANC - 512)], [...buildPattern(512, 43)]);
  second.close();
});

test("la plus grande génération validée est retenue, même après un point de contrôle", async () => {
  // La HAUTE EAU de #91. Sans elle, la taille de la plus grande génération d'un boot ne serait
  // lisible nulle part : le point de contrôle remet la charge validée à zéro à chaque rangement, et
  // seule la DERNIÈRE génération survivrait — dans le rapport de la prochaine ouverture.
  //
  // C'est cette mesure qui doit calibrer le plafond sur la demande RÉELLE du guest ; l'épreuve la
  // fait donc porter sur une suite de générations INÉGALES, dont la plus grande n'est pas la
  // dernière. Une implémentation qui rendrait « la dernière » passerait un témoin monotone.
  const support = creerSupport(VOLUME_BANC);
  const magasin = await ouvrirMagasin(support, "vol.gen", OPTIONS_BANC);
  assert.equal(magasin.chargeMaxValideeOctets, 0, "rien de validé, rien à déclarer");

  // Génération 1 : deux enregistrements.
  await magasin.deposer(0, buildPattern(ENREGISTREMENT_BANC, 1));
  await magasin.deposer(ENREGISTREMENT_BANC, buildPattern(ENREGISTREMENT_BANC, 2));
  await magasin.valider();
  const grande = magasin.chargeMaxValideeOctets;
  assert.equal(grande, 2 * (ENREGISTREMENT_BANC + SURCOUT_ENREGISTREMENT));

  // Le rangement remet la charge validée à zéro. La haute eau, elle, ne bouge pas.
  await magasin.pointDeControle();
  assert.equal(magasin.octetsDeCharge, 0, "le journal est vidé");
  assert.equal(magasin.chargeMaxValideeOctets, grande, "la haute eau survit au point de contrôle");

  // Génération 2, PLUS PETITE : elle ne doit pas faire baisser la mesure.
  await magasin.deposer(0, buildPattern(ENREGISTREMENT_BANC, 3));
  await magasin.valider();
  assert.equal(
    magasin.chargeMaxValideeOctets,
    grande,
    "une génération plus petite ne l'abaisse pas",
  );

  // Génération 3, PLUS GRANDE : elle, la relève.
  await magasin.pointDeControle();
  for (let rang = 0; rang < 3; rang += 1) {
    await magasin.deposer(rang * ENREGISTREMENT_BANC, buildPattern(ENREGISTREMENT_BANC, rang + 4));
  }
  await magasin.valider();
  assert.equal(magasin.chargeMaxValideeOctets, 3 * (ENREGISTREMENT_BANC + SURCOUT_ENREGISTREMENT));
  magasin.close();
});

test("la charge DÉPOSÉE a sa propre haute eau, et c'est elle que le plafond borne", async () => {
  // La distinction qui a manqué de fausser la calibration de #91. `deposer` refuse quand la charge
  // DÉPOSÉE depuis le dernier point de contrôle dépasse le plafond — barrière ou pas —, alors que la
  // plus grande GÉNÉRATION ne compte que ce qu'une barrière a scellé.
  //
  // Le relevé de bout en bout du 2026-08-27 a mesuré un boot Rails à 68 écritures OPFS pour UNE
  // barrière : les deux grandeurs y diffèrent d'un facteur vingt. Calibrer le plafond sur la seconde
  // le calibrerait sur la mauvaise. Cette épreuve reproduit exactement cette forme.
  const support = creerSupport(VOLUME_BANC);
  const magasin = await ouvrirMagasin(support, "vol.gen", OPTIONS_BANC);

  // Une seule barrière, TÔT : la génération validée ne vaut qu'un enregistrement.
  await magasin.deposer(0, buildPattern(ENREGISTREMENT_BANC, 1));
  await magasin.valider();
  const uneGeneration = ENREGISTREMENT_BANC + SURCOUT_ENREGISTREMENT;
  assert.equal(magasin.chargeMaxValideeOctets, uneGeneration);

  // Puis neuf écritures SANS barrière. Rien de plus n'est validé ; le journal, lui, enfle.
  for (let rang = 1; rang < 10; rang += 1) {
    await magasin.deposer(rang * ENREGISTREMENT_BANC, buildPattern(ENREGISTREMENT_BANC, rang + 1));
  }
  assert.equal(magasin.chargeMaxValideeOctets, uneGeneration, "aucune barrière, aucune génération");
  assert.equal(magasin.chargeMaxDeposeeOctets, 10 * uneGeneration, "le journal, lui, a enflé");
  // C'est bien la charge déposée que le plafond regarde.
  assert.equal(magasin.octetsDeCharge, magasin.chargeMaxDeposeeOctets);
  magasin.close();
});

test("une validation REFUSÉE par le support n'entre pas dans la plus grande génération", async () => {
  // La haute eau est posée APRÈS le succès de la racine. La poser avant ferait entrer dans la
  // statistique une charge que le support a refusée — et le plafond serait calibré sur une
  // génération qui n'a jamais existé.
  const support = creerSupport(VOLUME_BANC);
  const magasin = await ouvrirMagasin(support, "vol.gen", OPTIONS_BANC);
  await magasin.deposer(0, buildPattern(ENREGISTREMENT_BANC, 1));
  support.magasin.starve("vol.gen");

  await assert.rejects(() => magasin.valider());
  assert.equal(magasin.chargeMaxValideeOctets, 0, "rien n'a été scellé, rien n'est compté");
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
