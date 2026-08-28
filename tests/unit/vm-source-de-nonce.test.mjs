// La SOURCE DE NONCE d'un scellement, et pourquoi sa porte est gardée (#18, ADR 0016, décision 6).
//
// `Scellement.ouvrir` accepte une source de nonce pour une seule raison : confronter le produit aux
// vecteurs figés de l'ADR 0015, qui fixent des nonces précis. C'est une porte étroite et son usage
// est légitime — mais elle ouvrait sans rien demander, là où la CLÉ, à deux lignes de distance,
// exige un jeton de harnais.
//
// L'asymétrie n'était pas exploitable au moment où elle a été relevée : l'ouvreur construit le
// scellement lui-même et ne transmet jamais de source. Elle a été corrigée pour ce qu'elle est —
// une garde manquante sur le paramètre le plus dangereux du format — et parce que #101 ajoute des
// appelants à `Scellement.ouvrir`.
//
// La deuxième épreuve de ce fichier dit ce que la garde protège, en le faisant.

import assert from "node:assert/strict";
import test from "node:test";

import { CLE_DE_TEST } from "../../src/vm/cle-de-volume.mjs";
import { HARNAIS_NONCE_JETON, Scellement } from "../../src/vm/scellement.mjs";

const VOLUME = "d".repeat(32);
const NONCE_CONSTANT = () => new Uint8Array(12).fill(0x2a);

function identite(rang) {
  return { generation: 1, rang, adresse: 0, longueur: 32 };
}

test("une source de nonce ne s'installe PAS sans le jeton du harnais", async () => {
  await assert.rejects(
    () =>
      Scellement.ouvrir({
        volume: VOLUME,
        cleOctets: CLE_DE_TEST,
        formatVersion: 3,
        tirerNonce: NONCE_CONSTANT,
      }),
    (erreur) => {
      assert.match(erreur.message, /jeton/i, "le refus dit ce qui manque");
      assert.match(erreur.message, /nonce/i);
      return true;
    },
  );

  // Un jeton APPROCHANT n'ouvre rien : la comparaison est exacte.
  await assert.rejects(() =>
    Scellement.ouvrir({
      volume: VOLUME,
      cleOctets: CLE_DE_TEST,
      formatVersion: 3,
      tirerNonce: NONCE_CONSTANT,
      jetonNonce: `${HARNAIS_NONCE_JETON} `,
    }),
  );
});

test("sans source, le scellement s'ouvre : la garde ne pèse que sur la porte dérobée", async () => {
  const scellement = await Scellement.ouvrir({
    volume: VOLUME,
    cleOctets: CLE_DE_TEST,
    formatVersion: 3,
  });
  const premier = await scellement.scellerBloc(identite(0), new Uint8Array(32).fill(1));
  const second = await scellement.scellerBloc(identite(1), new Uint8Array(32).fill(1));
  assert.notDeepEqual(premier.nonce, second.nonce, "les nonces sont TIRÉS, jamais répétés");
});

test("ce que la garde protège : un nonce constant rend le clair récupérable", async () => {
  // La démonstration passe PAR la porte, avec le jeton, parce que c'est la seule manière d'obtenir
  // l'état qu'on veut interdire. Deux blocs scellés sous la même clé, la même identité logique et
  // le MÊME nonce donnent c1 ⊕ c2 = p1 ⊕ p2 : quiconque connaît l'un des deux clairs lit l'autre,
  // et la confidentialité du volume tombe sans qu'aucune étiquette n'ait été forgée.
  const scellement = await Scellement.ouvrir({
    volume: VOLUME,
    cleOctets: CLE_DE_TEST,
    formatVersion: 3,
    tirerNonce: NONCE_CONSTANT,
    jetonNonce: HARNAIS_NONCE_JETON,
  });

  const premierClair = new Uint8Array(32).fill(0x11);
  const secondClair = Uint8Array.from({ length: 32 }, (_, index) => index);
  const premier = await scellement.scellerBloc(identite(0), premierClair);
  const second = await scellement.scellerBloc(identite(0), secondClair);

  assert.deepEqual(premier.nonce, second.nonce, "le nonce n'a pas varié : c'est l'hypothèse");
  const chiffresXor = premier.chiffre.map((octet, index) => octet ^ second.chiffre[index]);
  const clairsXor = premierClair.map((octet, index) => octet ^ secondClair[index]);
  assert.deepEqual(
    chiffresXor,
    clairsXor,
    "le flux de clé s'annule : le clair de l'un révèle celui de l'autre",
  );
});
