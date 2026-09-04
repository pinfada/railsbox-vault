/**
 * Le dérivateur `webauthn-prf`, et sa CONDUITE quand PRF n'est pas là (#22, ADR 0021).
 *
 * WebAuthn n'existe pas sous Node : ce fichier éprouve la conduite contre un DOUBLE de
 * `navigator.credentials` qui rejoue exactement les quatre situations que l'ADR 0021 tranche, et
 * l'épreuve de navigateur (`tests/browser/deverrouillage-frontiere.spec.mjs`) les rejoue contre un
 * authentificateur virtuel réel. Les deux sont nécessaires : le double établit la CONDUITE — quel
 * code, quel geste suivant, quelle absence de repli —, l'authentificateur virtuel établit que
 * l'appel réel emprunte bien ces chemins.
 *
 * Le double n'invente rien : il rend les formes que la spécification WebAuthn décrit, et **il
 * JOURNALISE chaque appel**. C'est ce journal qui permet d'affirmer ce que le contrat de #22 exige
 * et qu'aucune assertion sur un code d'erreur ne prouverait : après une annulation, il n'y a **pas
 * de seconde tentative**, pas de repli automatique, et **rien n'est écrit nulle part**.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  DERIVATION_ERROR_CODES,
  isDerivationError,
} from "../../src/vm/derivation/derivation-errors.mjs";
import {
  derivateurWebauthnPrf,
  enregistrerEmplacementPrf,
} from "../../src/vm/derivation/derivateur-webauthn-prf.mjs";
import { decoderParametresPublics } from "../../src/vm/derivation/parametres-publics.mjs";
import { TYPES_KEK } from "../../src/vm/enveloppe/identite-enveloppe.mjs";
import { octetsEnHex } from "../../src/vm/format-chiffre/octets.mjs";
import { identifiantDeVolume, suiteDOctets } from "./support-enveloppe-double.mjs";

const VOLUME = identifiantDeVolume(0x30);
const EMPLACEMENT = "7071727374757677";
const IDENTITE = { identifiantVolume: VOLUME, identifiantEmplacement: EMPLACEMENT };
const RP_ID = "localhost";
const CREDENTIAL = suiteDOctets(0x90, 20);

/** Erreur `NotAllowedError`, telle qu'un navigateur la rend sur annulation ou temps écoulé. */
function notAllowed(message) {
  const erreur = new Error(message);
  erreur.name = "NotAllowedError";
  return erreur;
}

/**
 * DOUBLE de `navigator.credentials`. `create` et `get` rendent ce que la conduite doit distinguer,
 * et `journal` garde la trace de chaque appel — c'est lui qui prouve l'absence de seconde tentative.
 *
 * @param {{ creation?: object, assertion?: object | (() => never) }} conduite
 */
function credentialsDouble({ creation, assertion } = {}) {
  const journal = [];
  return {
    journal,
    create: async (options) => {
      journal.push({ appel: "create", options });
      if (typeof creation === "function") return creation();
      return creation;
    },
    get: async (options) => {
      journal.push({ appel: "get", options });
      if (typeof assertion === "function") return assertion();
      return assertion;
    },
  };
}

/** Une créance rendue par `create`, avec le résultat d'extension `prf` demandé. */
function creanceCreee(prf) {
  return {
    rawId: CREDENTIAL.buffer.slice(CREDENTIAL.byteOffset, CREDENTIAL.byteOffset + 20),
    type: "public-key",
    getClientExtensionResults: () => (prf === undefined ? {} : { prf }),
  };
}

/** Une assertion rendue par `get`, avec sa sortie PRF et un `signCount` que rien ne doit lire. */
function assertionRendue({ prf, signCount = 0 }) {
  return {
    rawId: CREDENTIAL.buffer.slice(CREDENTIAL.byteOffset, CREDENTIAL.byteOffset + 20),
    type: "public-key",
    response: { signature: new Uint8Array(64), signCount },
    getClientExtensionResults: () => (prf === undefined ? {} : { prf }),
  };
}

const SORTIE_PRF = suiteDOctets(0xc0, 32);

function sortiePrf(premier = SORTIE_PRF) {
  return { results: { first: premier.buffer.slice(premier.byteOffset, premier.byteOffset + 32) } };
}

/** Enregistrement RÉUSSI, dont les épreuves d'assertion ont besoin sans avoir à le mesurer. */
function enregistrer() {
  return enregistrerEmplacementPrf({
    credentials: credentialsDouble({ creation: creanceCreee({ enabled: true }) }),
    rpId: RP_ID,
    nomUtilisateur: "vault",
    identifiantUtilisateur: suiteDOctets(0x01, 16),
  });
}

test("l'enregistrement demande l'extension prf et rend des paramètres publics relisibles", async () => {
  const credentials = credentialsDouble({ creation: creanceCreee({ enabled: true }) });
  const enregistre = await enregistrerEmplacementPrf({
    credentials,
    rpId: RP_ID,
    nomUtilisateur: "vault",
    identifiantUtilisateur: suiteDOctets(0x01, 16),
  });

  const demande = credentials.journal[0].options.publicKey;
  assert.deepEqual(demande.extensions.prf, {}, "l'extension prf doit être DEMANDÉE à la création");
  assert.equal(demande.rp.id, RP_ID);

  const relus = decoderParametresPublics(TYPES_KEK["webauthn-prf"], enregistre.parametres);
  assert.equal(relus.rpId, RP_ID);
  assert.equal(relus.identifiantCredential, octetsEnHex(CREDENTIAL));
  assert.equal(relus.sel.length, 64, "le sel d'emplacement fait trente-deux octets");
});

test("PRF indisponible à l'enregistrement : refus TYPÉ, jamais une dégradation silencieuse", async () => {
  for (const [nom, prf] of [
    ["résultat d'extension absent", undefined],
    ["extension rendue mais désactivée", { enabled: false }],
    ["extension rendue sans verdict", {}],
  ]) {
    const credentials = credentialsDouble({ creation: creanceCreee(prf) });
    await assert.rejects(
      () =>
        enregistrerEmplacementPrf({
          credentials,
          rpId: RP_ID,
          nomUtilisateur: "vault",
          identifiantUtilisateur: suiteDOctets(0x01, 16),
        }),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.prfIndisponible),
      `« ${nom} » aurait dû être refusé`,
    );
    assert.equal(credentials.journal.length, 1, "aucune seconde tentative n'est permise");
  }
});

test("une annulation à l'ENREGISTREMENT est typée elle aussi, et ne prétend pas connaître sa cause", async () => {
  // Mesuré sur Firefox par `tests/browser/deverrouillage-frontiere.spec.mjs` : sans
  // authentificateur, `create` rend `NotAllowedError` au bout du délai. Le laisser remonter brut
  // ferait sortir une `DOMException` du produit, avec un `code` numérique que rien ne sait lire.
  const credentials = credentialsDouble({
    creation: () => {
      throw notAllowed("Aucun authentificateur n'a répondu.");
    },
  });
  await assert.rejects(
    () =>
      enregistrerEmplacementPrf({
        credentials,
        rpId: RP_ID,
        nomUtilisateur: "vault",
        identifiantUtilisateur: suiteDOctets(0x01, 16),
      }),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.annulee),
  );
  assert.equal(credentials.journal.length, 1, "une annulation ne se retente pas toute seule");
});

test("WebAuthn absent du moteur : le même refus typé, et aucun appel tenté", async () => {
  await assert.rejects(
    () =>
      enregistrerEmplacementPrf({
        credentials: null,
        rpId: RP_ID,
        nomUtilisateur: "vault",
        identifiantUtilisateur: suiteDOctets(0x01, 16),
      }),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.prfIndisponible),
  );
});

test("PRF disponible à l'assertion : la KEK est une CryptoKey AES-GCM non extractible", async () => {
  const credentials = credentialsDouble({ assertion: assertionRendue({ prf: sortiePrf() }) });
  const enregistre = await enregistrer();

  const derivateur = derivateurWebauthnPrf({ credentials });
  const kek = await derivateur.deriver({
    parametres: enregistre.parametres,
    identite: IDENTITE,
    geste: {},
  });
  assert.equal(kek instanceof CryptoKey, true);
  assert.equal(kek.extractable, false);
  assert.equal(kek.algorithm.name, "AES-GCM");

  const demande = credentials.journal[0].options.publicKey;
  const sel = new Uint8Array(demande.extensions.prf.eval.first);
  assert.equal(sel.byteLength, 32, "le sel PRF évalué fait trente-deux octets");
  assert.deepEqual(
    new Uint8Array(demande.allowCredentials[0].id),
    CREDENTIAL,
    "l'assertion vise la créance des paramètres publics, jamais n'importe laquelle",
  );
});

test("l'extension IGNORÉE à l'assertion rend un refus DISTINCT de l'indisponibilité", async () => {
  const enregistre = await enregistrer();

  for (const [nom, prf] of [
    ["aucun résultat d'extension", undefined],
    ["résultat sans « results »", {}],
    ["résultat sans « first »", { results: {} }],
  ]) {
    const credentials = credentialsDouble({ assertion: assertionRendue({ prf }) });
    const derivateur = derivateurWebauthnPrf({ credentials });
    await assert.rejects(
      () =>
        derivateur.deriver({ parametres: enregistre.parametres, identite: IDENTITE, geste: {} }),
      (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.prfIgnoree),
      `« ${nom} » aurait dû rendre « extension ignorée »`,
    );
    assert.equal(credentials.journal.length, 1, "aucun repli, donc aucune seconde tentative");
  }
});

test("une sortie PRF qui ne fait pas trente-deux octets est refusée, jamais complétée", async () => {
  const enregistre = await enregistrer();
  const courte = new Uint8Array(16).fill(0xc0);
  const credentials = credentialsDouble({
    assertion: assertionRendue({
      prf: { results: { first: courte.buffer.slice(0, 16) } },
    }),
  });
  await assert.rejects(
    () =>
      derivateurWebauthnPrf({ credentials }).deriver({
        parametres: enregistre.parametres,
        identite: IDENTITE,
        geste: {},
      }),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.prfIgnoree),
  );
});

test("l'ANNULATION rend son propre code, sans repli et sans rien persister", async () => {
  const enregistre = await enregistrer();
  const credentials = credentialsDouble({
    assertion: () => {
      throw notAllowed("L'opération a été annulée ou le temps est écoulé.");
    },
  });
  const derivateur = derivateurWebauthnPrf({ credentials });

  await assert.rejects(
    () => derivateur.deriver({ parametres: enregistre.parametres, identite: IDENTITE, geste: {} }),
    (erreur) =>
      isDerivationError(erreur, DERIVATION_ERROR_CODES.annulee) &&
      erreur.code !== DERIVATION_ERROR_CODES.prfIgnoree,
  );
  assert.equal(credentials.journal.length, 1, "une annulation ne se retente pas toute seule");
  // Aucun compteur d'échec : le dérivateur est SANS ÉTAT, et deux annulations de suite sont
  // exactement la première, répétée.
  await assert.rejects(
    () => derivateur.deriver({ parametres: enregistre.parametres, identite: IDENTITE, geste: {} }),
    (erreur) => isDerivationError(erreur, DERIVATION_ERROR_CODES.annulee),
  );
  assert.equal(credentials.journal.length, 2);
  assert.deepEqual(Object.keys(derivateur).sort(), ["deriver", "type"]);
});

test("le signCount n'est PAS une fraîcheur : deux assertions décroissantes ouvrent pareil", async () => {
  const enregistre = await enregistrer();
  const appel = { parametres: enregistre.parametres, identite: IDENTITE, geste: {} };

  const haute = await derivateurWebauthnPrf({
    credentials: credentialsDouble({
      assertion: assertionRendue({ prf: sortiePrf(), signCount: 42 }),
    }),
  }).deriver(appel);
  const basse = await derivateurWebauthnPrf({
    credentials: credentialsDouble({
      assertion: assertionRendue({ prf: sortiePrf(), signCount: 0 }),
    }),
  }).deriver(appel);

  const nonce = suiteDOctets(0x66, 12);
  const clair = new TextEncoder().encode("signCount");
  const scelle = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, haute, clair);
  const ouvert = await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, basse, scelle);
  assert.deepEqual(new Uint8Array(ouvert), clair);
});

test("deux emplacements distincts tirent DEUX KEK distinctes de la même sortie PRF", async () => {
  const credentials = () => credentialsDouble({ assertion: assertionRendue({ prf: sortiePrf() }) });
  const enregistre = await enregistrer();
  const appel = { parametres: enregistre.parametres, geste: {} };

  const premiere = await derivateurWebauthnPrf({ credentials: credentials() }).deriver({
    ...appel,
    identite: IDENTITE,
  });
  const seconde = await derivateurWebauthnPrf({ credentials: credentials() }).deriver({
    ...appel,
    identite: { ...IDENTITE, identifiantEmplacement: "7071727374757678" },
  });

  const nonce = suiteDOctets(0x55, 12);
  const scelle = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce },
    premiere,
    new TextEncoder().encode("emplacement"),
  );
  await assert.rejects(
    () => crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, seconde, scelle),
    "l'info HKDF ne lie pas l'emplacement : la même passkey ouvrirait tous les emplacements",
  );
});

test("un rpId que le moteur refuse rend le refus des PARAMÈTRES, pas « PRF ignorée »", async () => {
  // Le `rpId` est lu dans les paramètres publics, donc dans le fichier : un adversaire qui écrit
  // `<volume>.cles` y met le domaine qu'il veut. `SecurityError` dit que le moteur refuse ce
  // domaine pour cette origine — elle ne dit PAS que l'extension n'a rien rendu. La traduire en
  // `VAULT_DERIVATION_PRF_IGNOREE`, dont le message affirme « l'emplacement est légitime »,
  // enverrait changer d'authentificateur pour un emplacement qu'il faut au contraire regarder.
  const enregistre = await enregistrer();
  const credentials = credentialsDouble({
    assertion: () => {
      throw new DOMException("The relying party ID is not a registrable domain.", "SecurityError");
    },
  });
  await assert.rejects(
    () =>
      derivateurWebauthnPrf({ credentials }).deriver({
        parametres: enregistre.parametres,
        identite: IDENTITE,
        geste: {},
      }),
    (erreur) =>
      isDerivationError(erreur, DERIVATION_ERROR_CODES.parametresRefuses) &&
      erreur.context.rpId === RP_ID &&
      erreur.context.nom === "SecurityError",
  );
});

test("aucun refus ne transporte la sortie PRF dans son contexte : la FORME, jamais le résultat", async () => {
  // Un contexte d'erreur voyage — journal, port, `toJSON`. Y poser `resultats.prf` entier ferait
  // sortir du dérivateur l'objet même où la sortie PRF se trouve, sur le seul chemin où on est sûr
  // que quelque chose s'est mal passé.
  const enregistre = await enregistrer();
  const appel = { parametres: enregistre.parametres, identite: IDENTITE, geste: {} };
  const sortie = octetsEnHex(SORTIE_PRF);

  const refusDAssertion = await derivateurWebauthnPrf({
    credentials: credentialsDouble({
      // Une sortie de mauvaise LARGEUR : le refus tombe, et la sortie existe bel et bien.
      assertion: assertionRendue({ prf: { results: { first: SORTIE_PRF.slice(0, 16) } } }),
    }),
  })
    .deriver(appel)
    .then(
      () => null,
      (erreur) => erreur,
    );
  assert.ok(isDerivationError(refusDAssertion, DERIVATION_ERROR_CODES.prfIgnoree));
  assert.equal(refusDAssertion.context.rpId, RP_ID);

  const refusDEnregistrement = await enregistrerEmplacementPrf({
    credentials: credentialsDouble({ creation: creanceCreee({ enabled: false, autre: SORTIE_PRF }) }),
    rpId: RP_ID,
    nomUtilisateur: "vault",
    identifiantUtilisateur: suiteDOctets(0x01, 16),
  }).then(
    () => null,
    (erreur) => erreur,
  );
  assert.ok(isDerivationError(refusDEnregistrement, DERIVATION_ERROR_CODES.prfIndisponible));
  assert.equal(refusDEnregistrement.context.forme, "object");

  for (const refus of [refusDAssertion, refusDEnregistrement]) {
    const transporte = JSON.stringify(refus.toJSON());
    assert.equal(
      transporte.includes(sortie.slice(0, 32)),
      false,
      "un refus transporte des octets de la sortie PRF dans son contexte",
    );
    assert.equal(Object.hasOwn(refus.context, "resultat"), false);
  }
});

test("le tampon de sortie PRF rendu par le moteur est mis à zéro après la copie", async () => {
  const enregistre = await enregistrer();
  const tampon = SORTIE_PRF.slice();
  assert.ok(tampon.some((octet) => octet !== 0), "le tampon est déjà nul : rien à mesurer");

  const kek = await derivateurWebauthnPrf({
    credentials: credentialsDouble({ assertion: assertionRendue({ prf: { results: { first: tampon } } }) }),
  }).deriver({ parametres: enregistre.parametres, identite: IDENTITE, geste: {} });

  assert.ok(kek, "la KEK doit exister : c'est l'effacement qui est mesuré, pas un échec");
  assert.deepEqual(
    tampon,
    new Uint8Array(32),
    "le tampon rendu par le moteur garde la sortie PRF après la dérivation",
  );
});

test("une identité malformée refuse AVANT de déranger l'authentificateur", async () => {
  // L'identifiant vient du MANIFESTE, donc d'un fichier. Tant que son refus tombait après
  // l'assertion, il tombait sur une sortie PRF déjà obtenue — et sur un geste humain déjà demandé
  // pour rien. L'info est désormais calculée avant que quoi que ce soit n'existe.
  const enregistre = await enregistrer();
  const credentials = credentialsDouble({ assertion: assertionRendue({ prf: sortiePrf() }) });
  await assert.rejects(() =>
    derivateurWebauthnPrf({ credentials }).deriver({
      parametres: enregistre.parametres,
      identite: { ...IDENTITE, identifiantVolume: "pas-un-identifiant" },
      geste: {},
    }),
  );
  assert.deepEqual(credentials.journal, [], "l'authentificateur a été appelé pour rien");
});
