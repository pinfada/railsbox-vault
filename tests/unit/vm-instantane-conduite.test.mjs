import assert from "node:assert/strict";
import test from "node:test";

import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import {
  EN_TETE_OCTETS,
  MARQUEUR_COMPLET,
  tailleDeFichier,
} from "../../src/vm/instantane/fichier-instantane.mjs";
import { INSTANTANE_ERROR_CODES } from "../../src/vm/instantane/instantane-errors.mjs";
import {
  capturerInstantane,
  ouvrirInstantaneDeReprise,
} from "../../src/vm/instantane-de-reprise.mjs";
import { CoupureDeCapture, supportInstantaneDouble } from "./support-instantane-double.mjs";

// CONDUITE de l'instantané de reprise (#65, ADR 0024, décisions 2 et 4).
//
// C'est le chemin de PRODUCTION : il écrit le fichier, le relit, confronte sa liaison à l'état
// présent, et — c'est le point de l'ADR — **écarte et RETIRE** dès qu'un écart apparaît, sans jamais
// laisser croire à une reprise.
//
// Chaque garde est éprouvée avec son TÉMOIN POSITIF : le même fichier, sous l'état qui l'a produit,
// doit rendre l'état v86. Sans témoin, une garde qui refuserait TOUT passerait pour une garde qui
// refuse ce qu'il faut.

const VOLUME_TEXTE = "0123456789abcdef0123456789abcdef";
const REGION = Uint8Array.from({ length: 32 }, (_, index) => (index * 3 + 1) % 256);
const IMAGE = Uint8Array.from({ length: 32 }, (_, index) => (index * 5 + 7) % 256);
const ETAT = Uint8Array.from({ length: 8192 }, (_, index) => (index * 11 + 3) % 256);

function etatPresent(remplacements = {}) {
  return {
    sequence: 42,
    generation: 17,
    empreinteRegion: REGION,
    empreinteImage: IMAGE,
    formatVolume: 3,
    ...remplacements,
  };
}

async function scellement() {
  return Scellement.ouvrir({
    volume: VOLUME_TEXTE,
    cleOctets: CLE_DE_TEST,
    formatVersion: 3,
  });
}

/** Capture un instantané nominal et rend le support qui le porte. */
async function supportAvecInstantane(options = {}) {
  const support = supportInstantaneDouble(options);
  const capture = await capturerInstantane({
    scellement: await scellement(),
    volume: "donnees",
    etatPresent: etatPresent(),
    etat: ETAT,
    support,
  });
  return { support, capture };
}

function ouvrir(support, remplacements = {}) {
  return scellement().then((scelle) =>
    ouvrirInstantaneDeReprise({
      scellement: scelle,
      volume: "donnees",
      etatPresent: etatPresent(remplacements),
      support,
    }),
  );
}

test("une capture écrit l'en-tête, le corps, PUIS la marque — et dans cet ordre", async () => {
  const { support, capture } = await supportAvecInstantane();
  assert.equal(capture.octets, tailleDeFichier(ETAT.byteLength));
  assert.equal(support.contenu.byteLength, tailleDeFichier(ETAT.byteLength));
  assert.equal(
    octetsEnHex(support.contenu.subarray(EN_TETE_OCTETS + ETAT.byteLength)),
    octetsEnHex(MARQUEUR_COMPLET),
  );

  const gestes = support.journal.map((entree) => entree.geste);
  const derniereBarriereAvantMarque = gestes.lastIndexOf("barriere", gestes.lastIndexOf("ecrire"));
  assert.ok(
    derniereBarriereAvantMarque !== -1,
    "une barrière doit précéder l'écriture de la marque : une marque posée avant attesterait d'un état qui n'est peut-être jamais arrivé au disque",
  );
  assert.equal(gestes[gestes.length - 1], "barriere", "la marque est elle-même rendue durable");
});

test("TÉMOIN POSITIF : l'instantané capturé se rouvre et rend l'état v86", async () => {
  const { support } = await supportAvecInstantane();
  const rapport = await ouvrir(support);
  assert.equal(rapport.motif, null, rapport.motif ?? "");
  assert.equal(rapport.utilise, true);
  assert.equal(octetsEnHex(rapport.etat), octetsEnHex(ETAT));
  assert.equal((await support.etat()).present, true, "un instantané valide n'est PAS retiré");
});

test("le CORPS est lu dans UN SEUL tampon, étiquette comprise", async () => {
  // Correction de revue : la lecture allouait un tampon de `longueurEtat` pour le corps, puis
  // `assembler` en allouait un second de `longueurEtat + 16` pour y recopier corps ET étiquette.
  // Sur 253 Mo, c'était une copie entière de plus, au moment précis où la RAM invitée et le tampon
  // de rootfs sont déjà en mémoire. L'appelant alloue désormais UN tampon et y fait tomber le corps.
  const { support } = await supportAvecInstantane();
  const avant = support.journal.length;
  const rapport = await ouvrir(support);
  assert.equal(rapport.utilise, true, rapport.message ?? "");

  const lectures = support.journal.slice(avant).filter((e) => e.geste.startsWith("lire"));
  const duCorps = lectures.filter((e) => e.longueur >= ETAT.byteLength);
  assert.deepEqual(
    duCorps.map((e) => ({ geste: e.geste, longueur: e.longueur })),
    [{ geste: "lireDans", longueur: ETAT.byteLength }],
    "une seule lecture porte le corps, et elle se fait DANS un tampon déjà alloué — jamais par un « lire » qui en allouerait un second",
  );
});

test("un support vide n'est pas un refus : c'est l'absence, et elle se dit", async () => {
  const support = supportInstantaneDouble();
  const rapport = await ouvrir(support);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, "absent");
  assert.equal(rapport.etat, null);
});

test("une séquence qui AVANCE n'écarte rien : toute ouverture en écrit une racine vide", async () => {
  // C'est la correction que l'exécution a imposée (ADR 0024, décision 4) : la séquence compte les
  // écritures de RACINE, vidage de récupération compris. Elle avance donc à chaque ouverture, avant
  // que le guest ait battu. Une garde d'égalité aurait périmé l'instantané à sa première
  // réouverture — c'est-à-dire qu'il n'aurait jamais servi une seule fois.
  const { support } = await supportAvecInstantane();
  const rapport = await ouvrir(support, { sequence: 43 });
  assert.equal(rapport.motif, null, rapport.message ?? "");
  assert.equal(rapport.utilise, true);
  assert.equal((await support.etat()).present, true, "il n'est pas retiré non plus");
});

test("une séquence qui RECULE écarte l'instantané : le journal a été ramené en arrière", async () => {
  const { support } = await supportAvecInstantane();
  const rapport = await ouvrir(support, { sequence: 41 });
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.ecartSequence);
  assert.equal((await support.etat()).present, false);
});

test("chaque ÉCART de liaison écarte l'instantané, le RETIRE, et nomme son motif", async () => {
  const ecarts = [
    [{ generation: 18 }, INSTANTANE_ERROR_CODES.ecartGeneration],
    [{ generation: 16 }, INSTANTANE_ERROR_CODES.ecartGeneration],
    [
      { empreinteRegion: Uint8Array.from(REGION, (octet) => octet ^ 1) },
      INSTANTANE_ERROR_CODES.ecartRegion,
    ],
    [
      { empreinteImage: Uint8Array.from(IMAGE, (octet) => octet ^ 1) },
      INSTANTANE_ERROR_CODES.ecartImage,
    ],
  ];

  for (const [remplacement, code] of ecarts) {
    const { support } = await supportAvecInstantane();
    const rapport = await ouvrir(support, remplacement);
    assert.equal(rapport.utilise, false, `${code} : l'instantané ne doit pas être utilisé`);
    assert.equal(rapport.motif, code);
    assert.equal(rapport.etat, null, "aucun état n'est rendu");
    assert.equal((await support.etat()).present, false, `${code} : le fichier doit être RETIRÉ`);
  }
});

test("un instantané d'un AUTRE FORMAT DE VOLUME est écarté et retiré", async () => {
  // La version de format entre dans les données associées (ADR 0024, décision 3), et `scellement.mjs`
  // promet depuis #18 qu'un objet scellé sous une autre version ne s'ouvre pas. Sans confrontation
  // AVANT le sceau, ce refus existait dans les octets et jamais dans un message : un instantané d'un
  // volume v3 présenté à une session v2 tombait sur un SCEAU_REFUSE, qui ne nomme pas la cause.
  const { support } = await supportAvecInstantane();
  const rapport = await ouvrir(support, { formatVolume: 4 });
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.ecartFormat);
  assert.equal((await support.etat()).present, false, "il est RETIRÉ comme les autres écarts");
});

test("TÉMOIN POSITIF du format : la version qui a scellé ouvre", async () => {
  const { support } = await supportAvecInstantane();
  const rapport = await ouvrir(support, { formatVolume: 3 });
  assert.equal(rapport.motif, null, rapport.message ?? "");
  assert.equal(rapport.utilise, true);
});

test("un instantané d'un AUTRE volume est écarté et retiré", async () => {
  const { support } = await supportAvecInstantane();
  const autre = await Scellement.ouvrir({
    volume: "fedcba9876543210fedcba9876543210",
    cleOctets: CLE_DE_TEST,
    formatVersion: 3,
  });
  const rapport = await ouvrirInstantaneDeReprise({
    scellement: autre,
    volume: "donnees",
    etatPresent: etatPresent(),
    support,
  });
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.ecartVolume);
  assert.equal((await support.etat()).present, false);
});

test("une coupure AVANT la marque laisse un instantané INCOMPLET, écarté et retiré", async () => {
  // Gestes de la capture, dans l'ordre : 1 allouer, 2 écrire l'en-tête, 3 écrire le corps,
  // 4 barrière, 5 écrire la MARQUE, 6 barrière. Couper avant le cinquième laisse donc exactement
  // l'état que le plan de panne doit produire : le corps sur le support, et pas de marque.
  const coupe = supportInstantaneDouble({ couperAvant: 5 });
  await assert.rejects(
    capturerInstantane({
      scellement: await scellement(),
      volume: "donnees",
      etatPresent: etatPresent(),
      etat: ETAT,
      support: coupe,
    }),
    (erreur) => erreur instanceof CoupureDeCapture && erreur.rang === 5,
  );
  assert.equal(
    (await coupe.etat()).present,
    true,
    "le fichier reste sur le support, sans sa marque",
  );

  const rapport = await ouvrir(coupe);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.incomplet);
  assert.equal((await coupe.etat()).present, false, "un instantané incomplet est RETIRÉ");
});

test("une capture PLUS GRANDE coupée avant sa marque ne se sert pas de celle de la précédente", async () => {
  // `allouer` est un TRUNCATE : agrandir un fichier conserve son préfixe. Une seconde capture plus
  // grande laisse donc en place, quelque part au milieu, la marque de complétude de la première.
  // Si la seconde est coupée avant d'écrire la sienne, le fichier porte une marque VALIDE — à la
  // mauvaise place. C'est le mélange de deux captures que l'ADR 0024 nomme, et la marque doit être
  // cherchée à l'offset que l'EN-TÊTE déclare, jamais « quelque part ».
  const petit = ETAT.subarray(0, 1024);
  const support = supportInstantaneDouble();
  await capturerInstantane({
    scellement: await scellement(),
    volume: "donnees",
    etatPresent: etatPresent(),
    etat: petit,
    support,
  });
  const marqueDeLAncienne = support.contenu.slice(EN_TETE_OCTETS + petit.byteLength);
  assert.equal(octetsEnHex(marqueDeLAncienne), octetsEnHex(MARQUEUR_COMPLET));

  // Seconde capture, PLUS GRANDE, coupée avant l'écriture de son CORPS (geste 3 : allouer, en-tête,
  // corps). Le fichier porte alors l'en-tête NEUF — qui déclare 8192 octets d'état — au-dessus des
  // octets de l'ANCIENNE capture, marque de complétude comprise, à l'ancien offset.
  support.couperAvant(3);
  await assert.rejects(
    capturerInstantane({
      scellement: await scellement(),
      volume: "donnees",
      etatPresent: etatPresent(),
      etat: ETAT,
      support,
    }),
    (erreur) => erreur instanceof CoupureDeCapture,
  );
  assert.equal(
    octetsEnHex(
      support.contenu.subarray(
        EN_TETE_OCTETS + petit.byteLength,
        EN_TETE_OCTETS + petit.byteLength + 8,
      ),
    ),
    octetsEnHex(MARQUEUR_COMPLET),
    "la marque de la PREMIÈRE capture est toujours là, au milieu du corps de la seconde",
  );

  const rapport = await ouvrir(support);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.incomplet);
});

test("un octet du corps retourné refuse le sceau, et l'instantané est retiré", async () => {
  const { support } = await supportAvecInstantane();
  const octets = support.contenu;
  octets[EN_TETE_OCTETS + 100] ^= 1;
  const abime = supportInstantaneDouble({ octets });

  const rapport = await ouvrir(abime);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.sceauRefuse);
  assert.equal((await abime.etat()).present, false);
});

test("un fichier qui n'est pas un instantané est écarté sans être interprété", async () => {
  const support = supportInstantaneDouble({
    octets: new Uint8Array(tailleDeFichier(64)).fill(0xaa),
  });
  const rapport = await ouvrir(support);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.malforme);
  assert.equal((await support.etat()).present, false);
});

test("un fichier plus court que son en-tête est écarté", async () => {
  const support = supportInstantaneDouble({ octets: new Uint8Array(EN_TETE_OCTETS - 8) });
  const rapport = await ouvrir(support);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.malforme);
});

test("un corps plus court que la longueur DÉCLARÉE est INCOMPLET, jamais complété de zéros", async () => {
  const { support } = await supportAvecInstantane();
  const tronque = supportInstantaneDouble({
    octets: support.contenu.subarray(0, EN_TETE_OCTETS + ETAT.byteLength - 512),
  });
  const rapport = await ouvrir(tronque);
  assert.equal(rapport.utilise, false);
  assert.equal(rapport.motif, INSTANTANE_ERROR_CODES.incomplet);
});

test("la capture consomme EXACTEMENT un scellement du budget de clé", async () => {
  const scelle = await scellement();
  const avant = scelle.scellementsCumules;
  await capturerInstantane({
    scellement: scelle,
    volume: "donnees",
    etatPresent: etatPresent(),
    etat: ETAT,
    support: supportInstantaneDouble(),
  });
  assert.equal(scelle.scellementsCumules, avant + 1, "un scellement par capture, ADR 0024 § 3");
});

// LE QUOTA, DEMANDÉ AVANT DE RÉSERVER (#65, revue de la PR #133).
//
// `allouer` réserve la taille entière du fichier — 253 Mo sur l'image de référence — d'un seul
// `truncate`. Sans question préalable, la capture découvrait le quota épuisé EN COURS d'écriture :
// le fichier restait alors sur le support, alloué et sans marque, c'est-à-dire une place prise pour
// un instantané que la prochaine ouverture écartera de toute façon. Et le scellement, lui, avait
// déjà été consommé.
//
// La question passe par la couche budget de #9 : elle a déjà les états `known` / `unknown` et les
// diagnostics. Une estimation INDISPONIBLE n'est pas une capacité nulle — la capture passe.

/** Couche budget réduite au geste que la capture utilise, avec la réponse qu'on veut éprouver. */
function budgetQuiRepond(reponse) {
  let demande = null;
  return {
    get demande() {
      return demande;
    },
    reserve: async (requiredBytes) => {
      demande = requiredBytes;
      return { ...reponse, requiredBytes };
    },
  };
}

test("une capture est REFUSÉE quand l'espace estimé ne la couvre pas", async () => {
  const support = supportInstantaneDouble();
  const scelle = await scellement();
  const avant = scelle.scellementsCumules;
  const budget = budgetQuiRepond({
    operation: "reserve",
    state: "known",
    available: 1024,
    sufficient: false,
    diagnostic: { code: "VAULT_BUDGET_SPACE_LOW" },
  });

  await assert.rejects(
    capturerInstantane({
      scellement: scelle,
      volume: "donnees",
      etatPresent: etatPresent(),
      etat: ETAT,
      support,
      budget,
    }),
    (erreur) => {
      assert.equal(erreur.code, INSTANTANE_ERROR_CODES.captureRefusee);
      assert.equal(erreur.context.diagnostic, "VAULT_BUDGET_SPACE_LOW");
      assert.equal(erreur.context.disponible, 1024);
      return true;
    },
  );

  assert.equal(budget.demande, tailleDeFichier(ETAT.byteLength), "on demande la taille du FICHIER");
  assert.deepEqual(support.journal, [], "pas un geste sur le support : rien n'est alloué");
  assert.equal(scelle.scellementsCumules, avant, "et pas un scellement consommé");
});

test("une estimation INDISPONIBLE ne bloque pas la capture : l'inconnu n'est pas zéro", async () => {
  const support = supportInstantaneDouble();
  const budget = budgetQuiRepond({
    operation: "reserve",
    state: "unknown",
    available: null,
    sufficient: null,
    diagnostic: { code: "VAULT_BUDGET_ESTIMATE_UNAVAILABLE" },
  });

  const capture = await capturerInstantane({
    scellement: await scellement(),
    volume: "donnees",
    etatPresent: etatPresent(),
    etat: ETAT,
    support,
    budget,
  });
  assert.equal(capture.octets, tailleDeFichier(ETAT.byteLength));
});

test("un espace SUFFISANT laisse la capture aboutir, et le fichier se relit", async () => {
  const support = supportInstantaneDouble();
  const budget = budgetQuiRepond({
    operation: "reserve",
    state: "known",
    available: 1024 * 1024,
    sufficient: true,
    diagnostic: null,
  });

  await capturerInstantane({
    scellement: await scellement(),
    volume: "donnees",
    etatPresent: etatPresent(),
    etat: ETAT,
    support,
    budget,
  });

  const rapport = await ouvrir(support);
  assert.equal(rapport.utilise, true);
  assert.deepEqual(rapport.etat, ETAT);
});
