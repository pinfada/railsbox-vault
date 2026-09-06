/**
 * Le CONTRAT DE MESSAGES de la coquille de produit (#161, ADR 0028).
 *
 * Ce que ces épreuves tiennent, et que rien d'autre ne tient :
 *
 *  - l'identifiant du contrat n'est plus celui d'un harnais. `railsbox-vault-browser-harness`
 *    disait ce qu'il était ; le produit ne doit pas continuer de le dire ;
 *  - l'encodage est refusé STRICTEMENT, avec un code par nature de refus. L'issue #24 l'exige mot
 *    pour mot : « un refus typé, jamais un silence » ;
 *  - `sansCapacite` refuse ce qui n'est pas une donnée. C'est la contrainte de forme héritée de
 *    l'ADR 0002 — le port restreint « ne peut transporter une clé, un handle, un descripteur de
 *    fichier ou une capacité transférable » —, et elle ne vaut que si quelque chose la MESURE.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  CONTRAT_COQUILLE,
  TYPES_APPLICATIFS,
  TYPES_PRIVILEGIES,
  decoderMessage,
  enveloppeDeMessage,
  estTypePrivilegie,
  sansCapacite,
} from "../../src/coquille/contrat-de-messages.mjs";
import { ETATS_DU_VOLUME, chargeUtileDEtat } from "../../src/coquille/etat-de-la-coquille.mjs";
import {
  CODES_REFUS_COQUILLE,
  TOUS_LES_CODES_DE_COQUILLE,
  messageDeRefus,
} from "../../src/coquille/refus-de-coquille.mjs";

test("le contrat de la coquille est celui d'un PRODUIT, versionné, et non celui d'un harnais", () => {
  assert.deepEqual(CONTRAT_COQUILLE, { id: "railsbox-vault-coquille", version: 1 });
  assert.ok(
    !CONTRAT_COQUILLE.id.includes("harness"),
    "l'identifiant du harnais de #24 ne doit plus décrire la coquille de produit.",
  );
});

test("les deux canaux ne partagent AUCUN type : un type privilégié n'est pas un type applicatif", () => {
  const prives = new Set(Object.values(TYPES_PRIVILEGIES));
  const communs = Object.values(TYPES_APPLICATIFS).filter((type) => prives.has(type));
  assert.deepEqual(
    communs,
    [],
    "un type commun aux deux canaux rendrait indiscernables une requête d'application et une " +
      "commande privilégiée — c'est exactement la confusion que la frontière doit empêcher.",
  );
  assert.equal(estTypePrivilegie(TYPES_PRIVILEGIES.deverrouiller), true);
  assert.equal(estTypePrivilegie(TYPES_APPLICATIFS.etat), false);
  assert.equal(estTypePrivilegie(undefined), false);
});

test("un message enveloppé porte le contrat, sa version et son type, et il est gelé", () => {
  const message = enveloppeDeMessage(TYPES_APPLICATIFS.etatReponse, { etat: "ouvert", barrieres: 1 });
  assert.deepEqual({ ...message }, {
    contrat: "railsbox-vault-coquille",
    version: 1,
    type: TYPES_APPLICATIFS.etatReponse,
    etat: "ouvert",
    barrieres: 1,
  });
  assert.ok(Object.isFrozen(message));
});

test("le décodeur refuse ce qui n'est pas un objet, et le dit par un code", () => {
  for (const valeur of [42, "vault.coquille.etat", null, undefined, [1, 2], true]) {
    const verdict = decoderMessage(valeur);
    assert.equal(verdict.ok, false, `${JSON.stringify(valeur) ?? "undefined"} a été décodé`);
    assert.equal(verdict.code, CODES_REFUS_COQUILLE.messageMalforme);
  }
});

test("le décodeur refuse un AUTRE contrat avant de regarder la version", () => {
  // L'ordre compte : un objet venu d'un autre logiciel ne doit pas recevoir un diagnostic de
  // version, qui lui apprendrait quelque chose de nous sans rien nous apprendre de lui.
  const verdict = decoderMessage({ contrat: "autre-logiciel", version: 99, type: "x" });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES_REFUS_COQUILLE.contratRefuse);
});

test("le décodeur refuse une version étrangère, et ne sert JAMAIS « au mieux »", () => {
  const verdict = decoderMessage({
    contrat: CONTRAT_COQUILLE.id,
    version: CONTRAT_COQUILLE.version + 1,
    type: TYPES_APPLICATIFS.etat,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.code, CODES_REFUS_COQUILLE.contratRefuse);
});

test("le décodeur refuse un type absent ou qui n'est pas une chaîne", () => {
  for (const type of [undefined, null, 7, "", {}]) {
    const verdict = decoderMessage({ contrat: CONTRAT_COQUILLE.id, version: 1, type });
    assert.equal(verdict.ok, false);
    assert.equal(verdict.code, CODES_REFUS_COQUILLE.messageMalforme);
  }
});

test("un message bien formé se décode, et rend son type", () => {
  const verdict = decoderMessage(enveloppeDeMessage(TYPES_APPLICATIFS.etat));
  assert.equal(verdict.ok, true);
  assert.equal(verdict.type, TYPES_APPLICATIFS.etat);
});

test("`sansCapacite` laisse passer des données et REFUSE tout ce qui est une capacité", () => {
  assert.deepEqual(sansCapacite({ etat: "ouvert", barrieres: 3, liste: ["a", 1, true, null] }), {
    etat: "ouvert",
    barrieres: 3,
    liste: ["a", 1, true, null],
  });

  const interdits = [
    ["un tampon", new ArrayBuffer(8)],
    ["une vue sur un tampon", new Uint8Array([1, 2, 3])],
    ["une fonction", () => 1],
    ["une capacité imbriquée", { charge: { profond: new ArrayBuffer(4) } }],
  ];
  for (const [quoi, valeur] of interdits) {
    assert.throws(
      () => sansCapacite(valeur),
      (erreur) => erreur.code === CODES_REFUS_COQUILLE.capaciteDansUnMessage,
      `${quoi} a franchi le contrôle`,
    );
  }
});

test("`sansCapacite` refuse un objet trop profond plutôt que de le parcourir sans fin", () => {
  let valeur = { fond: true };
  for (let niveau = 0; niveau < 12; niveau += 1) valeur = { valeur };
  assert.throws(
    () => sansCapacite(valeur),
    (erreur) => erreur.code === CODES_REFUS_COQUILLE.capaciteDansUnMessage,
  );
});

test("`enveloppeDeMessage` passe le corps par `sansCapacite` : rien ne s'enveloppe en douce", () => {
  assert.throws(
    () => enveloppeDeMessage(TYPES_APPLICATIFS.etatReponse, { cle: new Uint8Array(32) }),
    (erreur) => erreur.code === CODES_REFUS_COQUILLE.capaciteDansUnMessage,
  );
});

test("chaque code de refus porte un message, et aucun code n'est en double", () => {
  const codes = Object.values(CODES_REFUS_COQUILLE);
  assert.equal(new Set(codes).size, codes.length, "deux entrées partagent le même code.");
  for (const code of codes) {
    assert.match(code, /^VAULT_COQUILLE_[A-Z0-9_]+[A-Z0-9]$/);
    assert.ok(messageDeRefus(code).length > 10, `le message de ${code} n'explique rien`);
  }
  assert.deepEqual(TOUS_LES_CODES_DE_COQUILLE, [...codes].sort());
});

test("un code inconnu ne reçoit pas de message par défaut : la table refuse plutôt que d'inventer", () => {
  assert.throws(() => messageDeRefus("VAULT_COQUILLE_INVENTE"), /inconnu/);
});

test("l'état publié ne porte QUE l'état et le compte de barrières", () => {
  const charge = chargeUtileDEtat({ etat: ETATS_DU_VOLUME.ouvert, barrieres: 2 });
  assert.deepEqual(Object.keys(charge).sort(), ["barrieres", "etat"]);
  assert.ok(Object.isFrozen(charge));
});

test("l'état publié refuse une valeur hors des quatre états, et un compte qui n'en est pas un", () => {
  assert.throws(() => chargeUtileDEtat({ etat: "presque-ouvert", barrieres: 0 }), /inconnu/);
  assert.throws(() => chargeUtileDEtat({ etat: ETATS_DU_VOLUME.ouvert, barrieres: -1 }), /entier/);
  assert.throws(() => chargeUtileDEtat({ etat: ETATS_DU_VOLUME.ouvert, barrieres: 1.5 }), /entier/);
});

test("« indisponible » et « verrouillé » sont deux états distincts, et ce n'est pas cosmétique", () => {
  // L'un dit « il faut un geste », l'autre dit « ce moteur ne sait pas ». Les confondre ferait
  // redemander à l'utilisateur une phrase qui n'ouvrirait rien — c'est la conduite, pas le mot.
  assert.notEqual(ETATS_DU_VOLUME.indisponible, ETATS_DU_VOLUME.verrouille);
  assert.equal(Object.keys(ETATS_DU_VOLUME).length, 4);
});
