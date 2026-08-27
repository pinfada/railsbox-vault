import assert from "node:assert/strict";
import test from "node:test";

import { buildPattern } from "../../src/vm/block-fixture.mjs";
import {
  ENTETE_OCTETS,
  ZONE_ENREGISTREMENTS,
  encoderEnteteEnregistrement,
} from "../../src/vm/generation-format.mjs";
import { GenerationStore } from "../../src/vm/generation-store.mjs";
import { importerCleDeVolume, scellerBloc } from "../../src/vm/format-chiffre/modele-reference.mjs";
import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

// Le nonce contre le CHEMIN DE REPRISE RÉEL (#17, ADR 0015).
//
// Cette épreuve existe parce qu'une revue a réfuté par EXÉCUTION la justification centrale de la
// première version de l'ADR 0015. Celle-ci affirmait qu'un nonce dérivé de (génération, rang) était
// sûr « parce qu'une reprise ouvre une génération NEUVE ». C'est faux contre `generation-store.mjs`
// et non contre une lecture pessimiste :
//
//  - la génération n'avance que dans `valider()` ;
//  - `#recuperer()` la remet à celle de la racine qui fait autorité ;
//  - `#vider()` incrémente la SÉQUENCE et CONSERVE la génération ;
//  - la branche « racines vierges au-dessus d'une charge » remet génération ET séquence à ZÉRO.
//
// Or les octets sont scellés au DÉPÔT, sous la génération EN VOL. Une génération déposée puis
// écartée rend donc son numéro à la tentative suivante, les rangs repartant de zéro. Le pire cas ne
// demande aucune panne : une FERMETURE PROPRE avec un dépôt non validé suffit.
//
// Ce que la collision coûte n'est pas théorique : sous AES-GCM, deux scellements sous le même nonce
// et la même clé livrent le XOR des deux clairs — et la clé d'authentification H, donc la capacité
// de forger (NIST SP 800-38D § 8.1 ; « forbidden attack », Joux 2006). Les propriétés P1, P2, P4 et
// P5 tomberaient sur tout le volume. L'épreuve mesure les deux : l'unicité des nonces, et l'absence
// de la fuite qu'une collision produirait.

/** Clé de TEST, publique et volontairement sans entropie : 0x00 à 0x1f. Jamais un secret. */
const CLE_DE_TEST = Uint8Array.from({ length: 32 }, (_, index) => index);

const VOLUME = "vol";
const TAILLE_VOLUME = 32 * 512;

function creerSupport() {
  const magasin = createSyncAccessStore();
  const volume = new Uint8Array(TAILLE_VOLUME);
  return {
    magasin,
    volume,
    lireVolume: (offset, longueur) => volume.slice(offset, offset + longueur),
    ecrireVolume: (offset, octets) => {
      volume.set(octets, offset);
      return octets.byteLength;
    },
    barriereVolume: async () => {},
  };
}

async function ouvrirMagasin(support) {
  return GenerationStore.ouvrir({
    volume: VOLUME,
    handle: await support.magasin.openHandle(`${VOLUME}.gen`),
    tailleVolume: TAILLE_VOLUME,
    lireVolume: support.lireVolume,
    ecrireVolume: support.ecrireVolume,
    barriereVolume: support.barriereVolume,
  });
}

/**
 * Ce que #18 fera : sceller au DÉPÔT, sous la génération en vol et le rang de l'entrée dans le
 * journal de cette génération. Le rang repart de zéro à chaque génération neuve, comme le journal.
 */
function creerScelleur(cle) {
  const scellements = [];
  let rang = 0;
  return {
    scellements,
    async deposer(magasin, offset, contenu) {
      const generation = magasin.generationValidee + 1;
      // Le rang est la POSITION de l'enregistrement dans le journal de sa génération. Un journal
      // vide — ouverture neuve, génération écartée, point de contrôle — rend donc le rang zéro.
      if (magasin.octetsDeCharge === 0) rang = 0;
      const identite = {
        volume: VOLUME,
        formatVersion: 3,
        generation,
        rang,
        adresse: offset,
        longueur: contenu.byteLength,
      };
      rang += 1;
      const scelle = await scellerBloc({
        cle,
        identite,
        contenu,
        attentes: { scellementsCumules: scellements.length },
      });
      scellements.push({ identite, contenu, scelle });
      await magasin.deposer(offset, contenu);
      return scelle;
    },
  };
}

function xor(gauche, droite) {
  return Uint8Array.from(gauche, (octet, index) => octet ^ droite[index]);
}

/**
 * Le dommage exact d'une réutilisation de nonce : `C1 ⊕ C2 == P1 ⊕ P2`. GCM chiffre en flux, donc
 * deux clairs masqués par le même flot se démasquent l'un l'autre. Vrai ⟹ la confidentialité des
 * deux écritures est perdue par la seule observation du support.
 */
function fuiteParXor(premier, second) {
  const taille = Math.min(premier.scelle.chiffre.byteLength, second.scelle.chiffre.byteLength);
  return (
    octetsEnHex(
      xor(premier.scelle.chiffre.subarray(0, taille), second.scelle.chiffre.subarray(0, taille)),
    ) === octetsEnHex(xor(premier.contenu.subarray(0, taille), second.contenu.subarray(0, taille)))
  );
}

function nonceEnDouble(scellements) {
  const vus = new Map();
  for (const [index, scellement] of scellements.entries()) {
    const nonce = octetsEnHex(scellement.scelle.nonce);
    if (vus.has(nonce)) return { nonce, premier: vus.get(nonce), second: index };
    vus.set(nonce, index);
  }
  return null;
}

test("FERMETURE PROPRE d'un dépôt non validé : la reprise ne réémet aucun nonce", async () => {
  const cle = await importerCleDeVolume(CLE_DE_TEST);
  const support = creerSupport();
  const scelleur = creerScelleur(cle);

  // Génération 1, validée puis rangée.
  const premier = await ouvrirMagasin(support);
  await scelleur.deposer(premier, 0, buildPattern(512, 1000));
  await premier.valider();
  await premier.pointDeControle();
  premier.close();

  // Génération 2 déposée, JAMAIS validée, et l'onglet se ferme PROPREMENT. Aucune panne.
  const second = await ouvrirMagasin(support);
  await scelleur.deposer(second, 0, buildPattern(512, 2000));
  second.close();

  // Réouverture : la génération 2 est écartée, la validée reste 1. Le dépôt suivant repart donc
  // sous la MÊME génération et le MÊME rang que celui qui vient d'être écarté.
  const troisieme = await ouvrirMagasin(support);
  assert.equal(troisieme.generationValidee, 1);
  await scelleur.deposer(troisieme, 0, buildPattern(512, 3000));
  troisieme.close();

  const double = nonceEnDouble(scelleur.scellements);
  assert.equal(
    double,
    null,
    double === null
      ? ""
      : `nonce ${double.nonce} réémis par les scellements ${double.premier} et ${double.second} — sous GCM, le XOR des deux clairs et la clé d'authentification sont livrés`,
  );

  for (const [index, gauche] of scelleur.scellements.entries()) {
    for (const droite of scelleur.scellements.slice(index + 1)) {
      assert.equal(fuiteParXor(gauche, droite), false, "aucun couple ne doit se démasquer");
    }
  }
});

test("RACINES VIERGES au-dessus d'une charge : la reprise repart de zéro sans réémettre de nonce", async () => {
  const cle = await importerCleDeVolume(CLE_DE_TEST);
  const support = creerSupport();
  const scelleur = creerScelleur(cle);

  // Génération 1, déposée et validée normalement.
  const premier = await ouvrirMagasin(support);
  await scelleur.deposer(premier, 0, buildPattern(512, 1000));
  await premier.valider();
  premier.close();

  // Un support hostile — ou une déchirure des DEUX emplacements — laisse une charge sans racine
  // lisible. `#recuperer` prend alors la branche `#vider({ sequence: 0, generation: 0 })`, et la
  // génération repart à ZÉRO : le prochain dépôt reprend le numéro de la toute première.
  const brut = await support.magasin.openHandle(`${VOLUME}.gen`);
  // Secteur par secteur : le double calibré peut rendre une écriture COURTE, et une zone de racines
  // à moitié effacée produirait une racine ABÎMÉE — donc un refus d'ouverture, pas la branche que
  // cette épreuve vise.
  for (let position = 0; position < ZONE_ENREGISTREMENTS; position += 512) {
    let ecrits = 0;
    while (ecrits < 512) {
      ecrits += brut.write(new Uint8Array(512 - ecrits), { at: position + ecrits });
    }
  }
  const charge = buildPattern(512, 4000);
  brut.write(encoderEnteteEnregistrement({ offset: 0, longueur: charge.byteLength }), {
    at: ZONE_ENREGISTREMENTS,
  });
  brut.write(charge, { at: ZONE_ENREGISTREMENTS + ENTETE_OCTETS });
  brut.flush();
  brut.close();

  const second = await ouvrirMagasin(support);
  assert.equal(second.generationValidee, 0, "la génération est bien revenue à zéro");
  await scelleur.deposer(second, 0, buildPattern(512, 5000));
  second.close();

  const double = nonceEnDouble(scelleur.scellements);
  assert.equal(
    double,
    null,
    `nonce réémis après un retour de la génération à zéro : ${double?.nonce}`,
  );
});
