import assert from "node:assert/strict";
import test from "node:test";

import { buildPattern } from "../../src/vm/block-fixture.mjs";
import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { ZONE_ENREGISTREMENTS } from "../../src/vm/generation-format.mjs";
import { GenerationStore } from "../../src/vm/generation-store.mjs";
import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { Scellement } from "../../src/vm/scellement.mjs";
import { createSyncAccessStore } from "../../src/vm/sync-access-double.mjs";

// Le nonce contre le CHEMIN DE REPRISE RÉEL (#17, ADR 0015 ; #18, ADR 0016).
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
//
// **Ce que #18 change ici.** L'épreuve de #17 devait SIMULER ce que le produit ferait, avec un
// scelleur parallèle : le magasin ne scellait rien. Il scelle désormais lui-même, et les nonces
// observés sont ceux que le PRODUIT émet — plus ceux qu'une épreuve suppose qu'il émettrait. C'est
// strictement plus fort, et c'est ce que la réfutation méritait.

const VOLUME = "vol";
const IDENTIFIANT = "0123456789abcdef0123456789abcdef";
const TAILLE_VOLUME = 32 * 512;

function creerSupport() {
  const magasin = createSyncAccessStore();
  const volume = new Uint8Array(TAILLE_VOLUME);
  return {
    magasin,
    volume,
    lireVolume: async (offset, longueur) => volume.slice(offset, offset + longueur),
    ecrireVolume: async (offset, octets) => {
      volume.set(octets, offset);
      return octets.byteLength;
    },
    barriereVolume: async () => {},
  };
}

/**
 * Enveloppe le scellement du PRODUIT pour consigner ce qu'il scelle, sans rien changer à son
 * comportement.
 *
 * Un `Proxy` plutôt qu'une sous-classe : `Scellement` porte des champs privés, et une sous-classe
 * qui redéclarerait ses méthodes n'y aurait pas accès. Chaque méthode est liée à la CIBLE, si bien
 * que les champs privés restent lisibles par elle.
 */
function scellementObserve(reel, releve) {
  return new Proxy(reel, {
    get(cible, propriete) {
      const valeur = Reflect.get(cible, propriete, cible);
      if (typeof valeur !== "function") return valeur;
      if (propriete !== "scellerBloc" && propriete !== "scellerRacine") return valeur.bind(cible);
      return async (...arguments_) => {
        const scelle = await valeur.apply(cible, arguments_);
        releve.push({
          quoi: propriete,
          contenu: propriete === "scellerBloc" ? Uint8Array.from(arguments_[1]) : null,
          scelle,
        });
        return scelle;
      };
    },
  });
}

async function ouvrirMagasin(support, releve) {
  const reel = await Scellement.ouvrir({
    volume: IDENTIFIANT,
    cleOctets: CLE_DE_TEST,
    formatVersion: 3,
  });
  return GenerationStore.ouvrir({
    volume: VOLUME,
    handle: await support.magasin.openHandle(`${VOLUME}.gen`),
    tailleVolume: TAILLE_VOLUME,
    scellement: scellementObserve(reel, releve),
    lireVolume: support.lireVolume,
    ecrireVolume: support.ecrireVolume,
    barriereVolume: support.barriereVolume,
  });
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
  if (premier.contenu === null || second.contenu === null) return false;
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

/** Aucun nonce répété, et aucun couple qui se démasque. Les deux, parce qu'ils ne disent pas la même chose. */
function exigerAucuneCollision(releve) {
  assert.ok(releve.length > 0, "l'épreuve doit avoir observé des scellements");
  const double = nonceEnDouble(releve);
  assert.equal(
    double,
    null,
    double === null
      ? ""
      : `nonce ${double.nonce} réémis par les scellements ${double.premier} et ${double.second} — sous GCM, le XOR des deux clairs et la clé d'authentification sont livrés`,
  );
  for (const [index, gauche] of releve.entries()) {
    for (const droite of releve.slice(index + 1)) {
      assert.equal(fuiteParXor(gauche, droite), false, "aucun couple ne doit se démasquer");
    }
  }
}

test("FERMETURE PROPRE d'un dépôt non validé : la reprise ne réémet aucun nonce", async () => {
  const support = creerSupport();
  const releve = [];

  // Génération 1, validée puis rangée.
  const premier = await ouvrirMagasin(support, releve);
  await premier.deposer(0, buildPattern(512, 1000));
  await premier.valider();
  await premier.pointDeControle();
  premier.close();

  // Génération 2 déposée, JAMAIS validée, et l'onglet se ferme PROPREMENT. Aucune panne.
  const second = await ouvrirMagasin(support, releve);
  await second.deposer(0, buildPattern(512, 2000));
  second.close();

  // Réouverture : la génération 2 est écartée, la validée reste 1. Le dépôt suivant repart donc
  // sous la MÊME génération et le MÊME rang que celui qui vient d'être écarté — ce qui suffisait à
  // réémettre un nonce dérivé, et ne suffit à rien contre un nonce tiré.
  const troisieme = await ouvrirMagasin(support, releve);
  assert.equal(troisieme.generationValidee, 1);
  await troisieme.deposer(0, buildPattern(512, 3000));
  troisieme.close();

  exigerAucuneCollision(releve);
});

test("RACINES VIERGES au-dessus d'une charge : la reprise repart de zéro sans réémettre de nonce", async () => {
  const support = creerSupport();
  const releve = [];

  // Génération 1, déposée et validée normalement.
  const premier = await ouvrirMagasin(support, releve);
  await premier.deposer(0, buildPattern(512, 1000));
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
  // Des octets AU-DELÀ de la zone des racines : ce qu'ils portent n'a aucune importance, seule leur
  // PRÉSENCE décide de la branche. Aucune racine ne les déclare, donc rien ne les relira.
  brut.write(buildPattern(512, 4000), { at: ZONE_ENREGISTREMENTS });
  brut.flush();
  brut.close();

  const second = await ouvrirMagasin(support, releve);
  assert.equal(second.generationValidee, 0, "la génération est bien revenue à zéro");
  await second.deposer(0, buildPattern(512, 5000));
  second.close();

  exigerAucuneCollision(releve);
});
