import assert from "node:assert/strict";
import test from "node:test";

import {
  ENVELOPPE_ERROR_CODES,
  isEnveloppeError,
} from "../../src/vm/enveloppe/enveloppe-errors.mjs";
import {
  ajouterEmplacement,
  creerEnveloppe,
  inventorierEnveloppe,
  ouvrirEnveloppe,
  remplacerEmplacement,
  revoquerEmplacement,
  revoquerToutSauf,
} from "../../src/vm/enveloppe-de-cle.mjs";
import {
  CoupureSimulee,
  identifiantDeVolume,
  supportDouble,
  suiteDOctets,
} from "./support-enveloppe-double.mjs";

// ATOMICITÉ de l'enveloppe : une coupure à CHAQUE RANG de CHAQUE opération (#21, ADR 0020 ; #148,
// ADR 0026).
//
// La promesse à tenir est celle de l'ADR 0014, transposée aux clés : « une coupure à n'importe quel
// geste laisse l'ancien état valide ou le nouveau, jamais ni l'un ni l'autre ». Ce fichier
// l'éprouve exhaustivement plutôt que sur un cas heureux : pour chacune des CINQ mutations — la
// révocation d'urgence de #148 comprise —, pour chacun des gestes qu'elle porte au support, et sous
// les QUATRE sinistres que le double sait produire — coupure avant l'effet, coupure après l'effet,
// et deux points de déchirure.
//
// Depuis #148, une mutation qui RETIRE une clé porte QUATRE gestes et non deux : écrire la page
// neuve, barrière, effacer la page libérée, barrière. Les deux derniers sont éprouvés à part, parce
// qu'ils ne posent pas la même question — après la barrière qui publie, une coupure ne peut plus
// rien retirer, et c'est exactement ce que l'ordre de l'ADR 0026 achète.
//
// Deux exigences rendent la matrice honnête, et sans elles elle serait décorative :
//
//  1. **chaque coupure programmée doit AVOIR LIEU.** Un rang jamais atteint ne prouve rien, et une
//     matrice qui compterait des coupures muettes se croirait exhaustive en ne mesurant rien.
//     `FaultPlan.unfired()` fait la même chose pour le backend de blocs depuis #6 ;
//  2. **l'état d'après est CLASSÉ, pas seulement « pas une erreur ».** Dire « l'enveloppe s'ouvre
//     encore » ne distingue pas l'ancien état du nouveau ; c'est précisément la distinction que
//     l'atomicité promet, donc c'est elle qu'il faut nommer à chaque coupure.

const VOLUME = identifiantDeVolume(0x0a);
const DEK = suiteDOctets(0x20, 32);
const KEK_A = suiteDOctets(0x80, 32);
const KEK_B = suiteDOctets(0xa0, 32);
const KEK_C = suiteDOctets(0xc0, 32);
const KEK_D = suiteDOctets(0x40, 32);

/**
 * Les QUATRE sinistres, nommés, chacun avec la façon dont il arme le double.
 *
 * Deux déchirures et non une, parce que le point de coupure décide de ce qui est mesuré : à
 * mi-page, la liste d'une enveloppe ordinaire est déjà entièrement écrite et la déchirure devient
 * un synonyme de « coupure après » — c'est une mutation de garde qui l'a établi. Une déchirure DANS
 * l'en-tête laisse la version neuve au-dessus de la liste ancienne, l'état le plus hostile que ce
 * format puisse rencontrer.
 */
const SINISTRES = Object.freeze([
  { nom: "coupure-avant", armer: (rang) => ({ couperAvant: rang }) },
  { nom: "coupure-apres", armer: (rang) => ({ couperApres: rang }) },
  { nom: "dechirure-entete", armer: (rang) => ({ dechirerA: rang, octetsDeDechirure: 40 }) },
  { nom: "dechirure-moitie", armer: (rang) => ({ dechirerA: rang }) },
]);

/** Ouvre, ou rend le code du refus. Jamais les deux, jamais un `null` qui vaudrait « peut-être ». */
async function etatSous(octets, kek) {
  const support = supportDouble({ octets });
  try {
    const ouverte = await ouvrirEnveloppe({ support, identifiantVolume: VOLUME, kek });
    return { ouvre: true, version: ouverte.version, code: null };
  } catch (cause) {
    if (!isEnveloppeError(cause)) throw cause;
    return { ouvre: false, version: null, code: cause.code };
  }
}

/**
 * Rejoue `operation` sur l'état initial, coupée au rang `rang` sous le sinistre `sinistre`.
 *
 * Rend les octets laissés sur le support, et si la coupure a réellement eu lieu. Une opération qui
 * aboutit malgré la coupure programmée est un rang HORS de la matrice — le geste n'existait pas —,
 * et l'appelant s'en sert pour borner l'exploration au lieu de deviner le nombre de gestes.
 */
async function couper({ octets, rang, sinistre, operation }) {
  const support = supportDouble({ octets, ...sinistre.armer(rang) });
  let coupee = false;
  try {
    await operation(support);
  } catch (cause) {
    if (!(cause instanceof CoupureSimulee)) throw cause;
    coupee = true;
  }
  return { coupee, octets: support.contenu, gestes: support.gestes };
}

/**
 * Balaie TOUS les rangs de TOUS les sinistres pour une opération, et fait juger chaque état obtenu.
 *
 * @param {{ initial: Uint8Array | null, operation: Function, juger: Function }} plan
 * @returns {Promise<number>} le nombre de coupures réellement produites
 */
async function balayer({ initial, operation, juger }) {
  let produites = 0;
  for (const sinistre of SINISTRES) {
    for (let rang = 1; rang <= 8; rang += 1) {
      const { coupee, octets } = await couper({ octets: initial, rang, sinistre, operation });
      if (!coupee) continue;
      produites += 1;
      await juger({ octets, rang, sinistre: sinistre.nom });
    }
  }
  return produites;
}

/** Enveloppe à un emplacement (KEK_A), version 1. */
async function initialUn() {
  const support = supportDouble();
  const creee = await creerEnveloppe({ support, identifiantVolume: VOLUME, dek: DEK, kek: KEK_A });
  return { octets: support.contenu, ...creee };
}

/** Enveloppe à deux emplacements (KEK_A puis KEK_B), version 2. */
async function initialDeux() {
  const support = supportDouble();
  const creee = await creerEnveloppe({ support, identifiantVolume: VOLUME, dek: DEK, kek: KEK_A });
  await ajouterEmplacement({
    support,
    identifiantVolume: VOLUME,
    kek: KEK_A,
    kekNouvelle: KEK_B,
  });
  return { octets: support.contenu, ...creee };
}

/** Enveloppe à QUATRE emplacements (KEK_A, puis B, C, D), version 4. */
async function initialQuatre() {
  const support = supportDouble();
  const creee = await creerEnveloppe({ support, identifiantVolume: VOLUME, dek: DEK, kek: KEK_A });
  for (const kekNouvelle of [KEK_B, KEK_C, KEK_D]) {
    await ajouterEmplacement({ support, identifiantVolume: VOLUME, kek: KEK_A, kekNouvelle });
  }
  return { octets: support.contenu, ...creee };
}

test("CRÉER : une coupure laisse une enveloppe qui s'ouvre, ou aucune enveloppe exploitable", async () => {
  const produites = await balayer({
    initial: null,
    operation: (support) =>
      creerEnveloppe({ support, identifiantVolume: VOLUME, dek: DEK, kek: KEK_A }),
    juger: async ({ octets, rang, sinistre }) => {
      const oui =
        octets === null
          ? { ouvre: false, code: ENVELOPPE_ERROR_CODES.absente }
          : await etatSous(octets, KEK_A);
      const admis = oui.ouvre
        ? true
        : [ENVELOPPE_ERROR_CODES.absente, ENVELOPPE_ERROR_CODES.illisible].includes(oui.code);
      assert.ok(admis, `${sinistre}@${rang} : état ${oui.code} — ni une enveloppe, ni rien`);
      if (oui.ouvre) assert.equal(oui.version, 1, `${sinistre}@${rang} : version inattendue`);
    },
  });
  // Trois gestes portent la création — allouer, écrire, barrière — et deux d'entre eux se
  // déchirent. Une matrice qui en produirait moins n'aurait pas couvert l'opération.
  assert.ok(produites >= 6, `seulement ${produites} coupure(s) produites sur la création`);
});

test("AJOUTER : à chaque rang, une clé ouvre — l'ancienne seule, ou l'ancienne et la neuve", async () => {
  const { octets: initial } = await initialUn();
  const produites = await balayer({
    initial,
    operation: (support) =>
      ajouterEmplacement({ support, identifiantVolume: VOLUME, kek: KEK_A, kekNouvelle: KEK_B }),
    juger: async ({ octets, rang, sinistre }) => {
      const ancienne = await etatSous(octets, KEK_A);
      const neuve = await etatSous(octets, KEK_B);
      assert.ok(
        ancienne.ouvre,
        `${sinistre}@${rang} : la clé d'origine n'ouvre plus (${ancienne.code})`,
      );
      const etat = neuve.ouvre ? "nouveau" : "ancien";
      assert.equal(
        ancienne.version,
        etat === "nouveau" ? 2 : 1,
        `${sinistre}@${rang} : état ${etat} et version ${ancienne.version} ne concordent pas`,
      );
    },
  });
  assert.ok(produites >= 4, `seulement ${produites} coupure(s) produites sur l'ajout`);
});

test("REMPLACER : la clé intacte ouvre toujours, et exactement une des deux autres", async () => {
  const { octets: initial } = await initialDeux();
  const support = supportDouble({ octets: initial });
  const cible = (await inventorierEnveloppe({ support, identifiantVolume: VOLUME })).emplacements[1]
    .identifiantEmplacement;

  const produites = await balayer({
    initial,
    operation: (courant) =>
      remplacerEmplacement({
        support: courant,
        identifiantVolume: VOLUME,
        kek: KEK_A,
        identifiantEmplacement: cible,
        kekNouvelle: KEK_C,
      }),
    juger: async ({ octets, rang, sinistre }) => {
      const intacte = await etatSous(octets, KEK_A);
      const ancienne = await etatSous(octets, KEK_B);
      const neuve = await etatSous(octets, KEK_C);
      assert.ok(
        intacte.ouvre,
        `${sinistre}@${rang} : la clé intacte n'ouvre plus (${intacte.code})`,
      );
      assert.notEqual(
        ancienne.ouvre,
        neuve.ouvre,
        `${sinistre}@${rang} : les deux clés ouvrent, ou aucune — le remplacement est à moitié fait`,
      );
      assert.equal(
        intacte.version,
        neuve.ouvre ? 3 : 2,
        `${sinistre}@${rang} : version incohérente`,
      );
    },
  });
  assert.ok(produites >= 4, `seulement ${produites} coupure(s) produites sur le remplacement`);
});

test("RÉVOQUER : la clé conservée ouvre toujours, la révoquée ouvre ou non — jamais un entre-deux", async () => {
  const { octets: initial } = await initialDeux();
  const support = supportDouble({ octets: initial });
  const cible = (await inventorierEnveloppe({ support, identifiantVolume: VOLUME })).emplacements[1]
    .identifiantEmplacement;

  const produites = await balayer({
    initial,
    operation: (courant) =>
      revoquerEmplacement({
        support: courant,
        identifiantVolume: VOLUME,
        kek: KEK_A,
        identifiantEmplacement: cible,
      }),
    juger: async ({ octets, rang, sinistre }) => {
      const conservee = await etatSous(octets, KEK_A);
      const revoquee = await etatSous(octets, KEK_B);
      assert.ok(conservee.ouvre, `${sinistre}@${rang} : la clé conservée n'ouvre plus`);
      assert.equal(
        conservee.version,
        revoquee.ouvre ? 2 : 3,
        `${sinistre}@${rang} : la version ne dit pas le même état que les clés`,
      );
      if (!revoquee.ouvre) {
        assert.equal(revoquee.code, ENVELOPPE_ERROR_CODES.cleRefusee, `${sinistre}@${rang}`);
      }
    },
  });
  assert.ok(produites >= 4, `seulement ${produites} coupure(s) produites sur la révocation`);
});

test("RÉVOQUER TOUT SAUF : à chaque rang, la clé conservée ouvre ; les autres ouvrent TOUTES ou AUCUNE, jamais un sous-ensemble", async () => {
  // Le geste composé de #148 tient en UNE version et UNE barrière, et c'est précisément ce que la
  // matrice mesure : trois révocations enchaînées offriraient trois rangs où DEUX clés sur trois
  // sont retirées — l'état partiel que l'urgence ne peut pas se permettre.
  const { octets: initial } = await initialQuatre();
  const produites = await balayer({
    initial,
    operation: (support) => revoquerToutSauf({ support, identifiantVolume: VOLUME, kek: KEK_A }),
    juger: async ({ octets, rang, sinistre }) => {
      const conservee = await etatSous(octets, KEK_A);
      assert.ok(
        conservee.ouvre,
        `${sinistre}@${rang} : la clé conservée n'ouvre plus (${conservee.code})`,
      );
      const autres = [];
      for (const kek of [KEK_B, KEK_C, KEK_D]) autres.push((await etatSous(octets, kek)).ouvre);
      assert.equal(
        new Set(autres).size,
        1,
        `${sinistre}@${rang} : un SOUS-ENSEMBLE des clés a été retiré (${autres.join(", ")})`,
      );
      assert.equal(
        conservee.version,
        autres[0] ? 4 : 5,
        `${sinistre}@${rang} : la version ne dit pas le même état que les clés`,
      );
    },
  });
  assert.ok(
    produites >= 4,
    `seulement ${produites} coupure(s) produites sur la révocation d'urgence`,
  );
});

test("EFFACEMENT : une coupure PENDANT l'effacement de la page libérée n'empêche jamais l'ouverture par la clé conservée", async () => {
  // L'effacement de #156 vient APRÈS la barrière qui publie, et cette épreuve mesure ce que cela
  // achète : aux rangs de l'effacement, la page neuve est déjà complète et durable, donc une coupure
  // ne peut plus rien retirer. Elle laisse au pire une page déchirée que `lireEtat` écarte.
  const { octets: initial } = await initialDeux();
  const support = supportDouble({ octets: initial });
  const cible = (await inventorierEnveloppe({ support, identifiantVolume: VOLUME })).emplacements[1]
    .identifiantEmplacement;

  const revoquer = (courant) =>
    revoquerEmplacement({
      support: courant,
      identifiantVolume: VOLUME,
      kek: KEK_A,
      identifiantEmplacement: cible,
    });

  // Le nombre de gestes est MESURÉ, pas supposé : sans lui, les rangs de l'effacement seraient une
  // convention que le premier remaniement démentirait en silence.
  const entier = supportDouble({ octets: initial });
  await revoquer(entier);
  assert.equal(
    entier.gestes,
    4,
    "une révocation porte quatre gestes : écrire la page neuve, barrière, effacer l'ancienne, barrière",
  );

  let produites = 0;
  for (const sinistre of SINISTRES) {
    for (const rang of [3, 4]) {
      const { coupee, octets } = await couper({
        octets: initial,
        rang,
        sinistre,
        operation: revoquer,
      });
      if (!coupee) continue;
      produites += 1;
      const conservee = await etatSous(octets, KEK_A);
      const revoquee = await etatSous(octets, KEK_B);
      assert.ok(
        conservee.ouvre,
        `${sinistre.nom}@${rang} : l'effacement a emporté l'état publié (${conservee.code})`,
      );
      assert.equal(conservee.version, 3, `${sinistre.nom}@${rang} : la révocation a reculé`);
      assert.equal(
        revoquee.ouvre,
        false,
        `${sinistre.nom}@${rang} : la clé révoquée ouvre encore après la barrière qui publie`,
      );
    }
  }
  assert.ok(produites >= 4, `seulement ${produites} coupure(s) produites sur l'effacement`);
});

test("une coupure ne réduit ni n'agrandit JAMAIS le fichier", async () => {
  // Un fichier qui changerait de taille pendant une écriture offrirait un troisième état, que rien
  // ne relirait. C'est la raison pour laquelle l'allocation est faite une fois, à la création.
  const { octets: initial } = await initialDeux();
  await balayer({
    initial,
    operation: (support) =>
      ajouterEmplacement({ support, identifiantVolume: VOLUME, kek: KEK_A, kekNouvelle: KEK_C }),
    juger: ({ octets, rang, sinistre }) => {
      assert.equal(octets.byteLength, initial.byteLength, `${sinistre}@${rang} : taille changée`);
    },
  });
});

test("la matrice MORD : une écriture qui viserait la page en cours d'autorité serait vue", async () => {
  // Mutation de la garde, exécutée plutôt que décrite. On rejoue l'ajout en écrivant délibérément
  // sur la page qui FAIT autorité, puis on coupe : l'ancien état est détruit avant que le nouveau
  // ne soit durable, et le déchirement laisse un fichier qu'aucune clé n'ouvre.
  const { octets: initial } = await initialUn();
  const support = supportDouble({ octets: initial, dechirerA: 1, octetsDeDechirure: 40 });
  const originale = support.ecrire;
  support.ecrire = (offset, octets) => originale(0, octets); // page 0 : celle qui fait autorité

  await assert.rejects(
    ajouterEmplacement({ support, identifiantVolume: VOLUME, kek: KEK_A, kekNouvelle: KEK_B }),
    (cause) => cause instanceof CoupureSimulee,
  );
  const apres = await etatSous(support.contenu, KEK_A);
  assert.equal(
    apres.ouvre,
    false,
    "écrire sur la page qui fait autorité devrait détruire l'état courant : si cette épreuve " +
      "passe, la matrice ci-dessus ne mesure plus rien",
  );
});
