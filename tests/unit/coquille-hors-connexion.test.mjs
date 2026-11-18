/**
 * Le DÉMARRAGE HORS CONNEXION (#247, D1g ; ADR 0044 § 6, ADR 0046), au niveau le plus bas qui le prouve.
 *
 * Décisions du superviseur (04/10/2026) : « injoignable » est UNIQUEMENT un `TypeError` de `fetch` ;
 * le descripteur rangé est scellé sous la clé du coffre ; il n'est rangé qu'après une acquisition
 * complète ; il n'est pas accepté s'il est antérieur à la version déjà migrée dans le volume.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { estInjoignable, lireLeDescripteur } from "../../src/coquille/descripteur-applicatif.mjs";
import { ISSUES_DU_DEPHASAGE as I, deciderLeDephasage } from "../../src/coquille/dephasage.mjs";
import { sceller } from "../../src/coquille/descripteur-scelle.mjs";
import { rangerLeDescripteur, repliHorsConnexion } from "../../src/coquille/hors-connexion.mjs";
import { IDENTIFIANT_DU_COFFRE } from "../../src/coquille/identites-du-coffre.mjs";
import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import { deriverCleDeScellementDuDescripteur } from "../../src/vm/derivation/cle-du-descripteur-scelle.mjs";
import { creerMagasinDArtefacts } from "../../src/vm/magasin-d-artefacts.mjs";
import { primitivesEnMemoire } from "./magasin-en-memoire.mjs";
import { descripteurDEpreuve } from "./support-coffre-de-la-coquille.mjs";

const DEK = new Uint8Array(32).fill(1);
const MANIFESTE_V86 = { artifacts: [{ name: "v86.wasm", bytes: 10, sha256: "8".repeat(64) }] };
const MAINTENANT = Date.UTC(2026, 10, 7, 16, 0, 0);

/** Une clé de volume qui rend une COPIE neuve, que l'appelant efface — et qui le prouve. */
function cleDeVolumeDe(dek = DEK) {
  const rendues = [];
  const cleDeVolume = async () => {
    const copie = dek.slice();
    rendues.push(copie);
    return copie;
  };
  return { cleDeVolume, rendues };
}

const reseauCoupe = async () => {
  throw new TypeError("Failed to fetch");
};
const reponse =
  (statut, corps, { json = true } = {}) =>
  async () => ({
    ok: statut >= 200 && statut < 300,
    status: statut,
    json: async () => {
      if (!json) throw new SyntaxError("Unexpected token '<'");
      return corps;
    },
  });

/** Un magasin en mémoire, et le moyen d'y ranger ce qu'un démarrage en ligne y aurait rangé. */
async function magasinAvecDescripteur({ dek = DEK, descripteur = descripteurDEpreuve() } = {}) {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  const { cleDeVolume } = cleDeVolumeDe(dek);
  const issue = await rangerLeDescripteur({
    magasin,
    cleDeVolume,
    descripteur,
    manifesteV86: MANIFESTE_V86,
    complet: true,
    maintenant: () => MAINTENANT,
  });
  assert.equal(issue, "range");
  return { magasin, primitives };
}

function lire({ recuperer, magasin, cle = cleDeVolumeDe(), journal = [] }) {
  return lireLeDescripteur({
    recuperer,
    repliHorsConnexion: repliHorsConnexion({
      magasin,
      cleDeVolume: cle.cleDeVolume,
      signaler: (m) => journal.push(m),
    }),
  });
}

// --- « Injoignable » = un TypeError de fetch, et rien d'autre -------------------------------------

test("estInjoignable : un TypeError, jamais une autre erreur", () => {
  assert.equal(estInjoignable(new TypeError("Failed to fetch")), true);
  for (const autre of [
    new Error("réseau"),
    new RangeError("x"),
    Object.assign(new Error("délai"), { name: "AbortError" }),
    new DOMException("délai", "TimeoutError"),
    { name: "TypeError", message: "imitation" },
    null,
  ]) {
    assert.equal(estInjoignable(autre), false);
  }
});

test("réseau coupé (TypeError) et descripteur rangé valide : le rangé fait foi, avec sa date", async () => {
  const { magasin } = await magasinAvecDescripteur();
  const lu = await lire({ recuperer: reseauCoupe, magasin });
  assert.equal(lu.present, true);
  assert.deepEqual(lu.descripteur, descripteurDEpreuve());
  assert.equal(lu.horsConnexion.rangeLe, MAINTENANT);
  assert.deepEqual(lu.horsConnexion.manifesteV86, MANIFESTE_V86);
});

test("la clé du coffre est EFFACÉE dès la clé de scellement dérivée", async () => {
  const { magasin } = await magasinAvecDescripteur();
  const cle = cleDeVolumeDe();
  await lire({ recuperer: reseauCoupe, magasin, cle });
  assert.equal(cle.rendues.length, 1);
  assert.ok(cle.rendues[0].every((octet) => octet === 0));
});

test("réseau coupé et AUCUN descripteur rangé : refus typé, sans repli", async () => {
  const magasin = creerMagasinDArtefacts({ primitives: primitivesEnMemoire() });
  const lu = await lire({ recuperer: reseauCoupe, magasin });
  assert.equal(lu.present, false);
  assert.equal(lu.code, C.horsLigneSansCopie);
  assert.equal(lu.horsConnexion, true);
  assert.equal(
    (await lire({ recuperer: reseauCoupe, magasin: null })).code,
    C.horsLigneSansCopie,
    "sans OPFS non plus",
  );
});

test("un magasin qui échoue à lire vaut « aucune copie » : jamais une panne du démarrage", async () => {
  const magasin = { lireLeDescripteurScelle: async () => Promise.reject(new Error("OPFS")) };
  assert.equal((await lire({ recuperer: reseauCoupe, magasin })).code, C.horsLigneSansCopie);
});

for (const [titre, recuperer] of [
  ["HTTP 500", reponse(500, {})],
  ["HTTP 503", reponse(503, {})],
  ["HTTP 404", reponse(404, {})],
  ["HTTP 200 portail captif (HTML, JSON illisible)", reponse(200, null, { json: false })],
  [
    "délai (AbortError)",
    async () => {
      throw new DOMException("délai", "AbortError");
    },
  ],
  [
    "erreur ordinaire de fetch",
    async () => {
      throw new Error("boom");
    },
  ],
]) {
  test(`${titre} : PAS de repli hors connexion — l'origine fait foi, le rangé n'est ni lu ni cru`, async () => {
    const { magasin } = await magasinAvecDescripteur();
    let lectures = 0;
    const espion = {
      ...magasin,
      lireLeDescripteurScelle: async () => ((lectures += 1), magasin.lireLeDescripteurScelle()),
    };
    const cle = cleDeVolumeDe();
    const lu = await lire({ recuperer, magasin: espion, cle });
    assert.equal(lu.present, false);
    assert.equal(lu.horsConnexion, undefined, "aucune marque de repli");
    assert.equal(lu.code, undefined);
    assert.equal(lectures, 0, "le descripteur rangé n'est même pas lu");
    assert.equal(cle.rendues.length, 0, "la clé du coffre n'est pas demandée");
  });
}

test("un descripteur différent servi par l'origine : il est utilisé, le rangé est ignoré", async () => {
  const { magasin } = await magasinAvecDescripteur();
  const servi = descripteurDEpreuve();
  servi.application.version = "9.9.9";
  const lu = await lire({ recuperer: reponse(200, servi), magasin });
  assert.equal(lu.present, true);
  assert.equal(lu.descripteur.application.version, "9.9.9");
  assert.equal(lu.horsConnexion, undefined);
});

// --- Les contre-épreuves : un rangé qui ne passe pas la vérification n'est JAMAIS utilisé ----------

async function refuse(magasin, journal = []) {
  const lu = await lire({ recuperer: reseauCoupe, magasin, journal });
  assert.equal(lu.present, false);
  assert.equal(lu.code, C.horsLigneDescripteurRefuse);
  assert.equal(lu.descripteur, undefined, "aucun descripteur n'est rendu");
  return lu;
}

test("descripteur rangé ALTÉRÉ : refus typé, journalisé, pas de démarrage hors ligne", async () => {
  const { magasin, primitives } = await magasinAvecDescripteur();
  const fichier = primitives.fichiers.get("descripteur.scelle");
  fichier[fichier.byteLength >> 1] ^= 0x20;
  const journal = [];
  await refuse(magasin, journal);
  assert.match(journal[0], /HORS_LIGNE_DESCRIPTEUR_REFUSE/);
});

test("descripteur rangé FABRIQUÉ sans la clé du coffre : refusé", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  const forge = descripteurDEpreuve();
  forge.application.version = "9.9.9";
  const cleAdversaire = await deriverCleDeScellementDuDescripteur({
    cleMaitresse: new Uint8Array(32).fill(66),
    identifiantVolume: IDENTIFIANT_DU_COFFRE,
  });
  await magasin.ecrireLeDescripteurScelle(
    await sceller({
      descripteur: forge,
      manifesteV86: MANIFESTE_V86,
      rangeLe: 1,
      cle: cleAdversaire,
    }),
  );
  await refuse(magasin);
});

test("descripteur rangé par un AUTRE COFFRE : refusé", async () => {
  const { magasin } = await magasinAvecDescripteur({ dek: new Uint8Array(32).fill(7) });
  await refuse(magasin);
});

test("descripteur rangé NON SCELLÉ (le JSON servi) : refusé", async () => {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  primitives.fichiers.set(
    "descripteur.scelle",
    new TextEncoder().encode(JSON.stringify(descripteurDEpreuve())),
  );
  await refuse(magasin);
});

test("la conduite d'un refus ne démarre rien : pas de descripteur, un code", async () => {
  const { magasin, primitives } = await magasinAvecDescripteur();
  primitives.fichiers.get("descripteur.scelle")[0] ^= 1;
  const lu = await refuse(magasin);
  assert.equal(typeof lu.motif, "string");
  assert.ok(lu.motif.length > 0);
});

// --- Anti-retour : le rangé repasse par la décision de l'ADR 0042 ---------------------------------

const coffre = (version, schema = "20260815120000") => ({
  app: { id: "railsbox-vault-reference", version, schema },
});

test("anti-retour : un rangé ANTÉRIEUR à la version déjà migrée dans le volume est refusé", async () => {
  const { magasin } = await magasinAvecDescripteur(); // 1.0.0
  const lu = await lire({ recuperer: reseauCoupe, magasin });
  const decision = deciderLeDephasage({ manifeste: coffre("1.1.0"), descripteur: lu.descripteur });
  assert.equal(decision.issue, I.refus);
  assert.equal(decision.code, C.applicationAnterieure);
});

test("anti-retour : le rangé de la MÊME version que le volume ouvre, sans rien proposer", async () => {
  const { magasin } = await magasinAvecDescripteur();
  const lu = await lire({ recuperer: reseauCoupe, magasin });
  const decision = deciderLeDephasage({ manifeste: coffre("1.0.0"), descripteur: lu.descripteur });
  assert.equal(decision.issue, I.ouvrir);
});

test("anti-retour : même schéma égal, version inférieure — refusé aussi (retour arrière à schéma égal)", async () => {
  const ancien = descripteurDEpreuve();
  ancien.application.version = "0.9.0";
  const { magasin } = await magasinAvecDescripteur({ descripteur: ancien });
  const lu = await lire({ recuperer: reseauCoupe, magasin });
  const decision = deciderLeDephasage({ manifeste: coffre("1.0.0"), descripteur: lu.descripteur });
  assert.equal(decision.code, C.applicationAnterieure);
});

// --- Le rangement : après une acquisition complète, ou pas du tout --------------------------------

function contexteDeRangement(surcharge = {}) {
  const primitives = primitivesEnMemoire();
  const magasin = creerMagasinDArtefacts({ primitives });
  return {
    primitives,
    magasin,
    args: {
      magasin,
      cleDeVolume: cleDeVolumeDe().cleDeVolume,
      descripteur: descripteurDEpreuve(),
      manifesteV86: MANIFESTE_V86,
      maintenant: () => MAINTENANT,
      signaler: () => {},
      ...surcharge,
    },
  };
}

test("acquisition complète : le descripteur est rangé, scellé, daté", async () => {
  const { args, primitives } = contexteDeRangement();
  assert.equal(await rangerLeDescripteur({ ...args, complet: true }), "range");
  assert.ok(primitives.fichiers.has("descripteur.scelle"));
});

test("acquisition INCOMPLÈTE : rien n'est rangé", async () => {
  for (const complet of [false, undefined, "oui", 1]) {
    const { args, primitives } = contexteDeRangement();
    const issue = await rangerLeDescripteur({ ...args, complet });
    assert.equal(issue, "oublie");
    assert.equal(primitives.fichiers.size, 0);
  }
});

test("acquisition incomplète : le descripteur PRÉCÉDENT est oublié — il promettait des artefacts retirés", async () => {
  const { args, primitives } = contexteDeRangement();
  await rangerLeDescripteur({ ...args, complet: true });
  assert.equal(await rangerLeDescripteur({ ...args, complet: false }), "oublie");
  assert.equal(primitives.fichiers.has("descripteur.scelle"), false);
});

test("un rangement qui échoue ne lève jamais : le cache ne fait pas échouer un boot", async () => {
  const { args, magasin } = contexteDeRangement();
  const journal = [];
  magasin.ecrireLeDescripteurScelle = async () => {
    throw new Error("quota");
  };
  const issue = await rangerLeDescripteur({
    ...args,
    complet: true,
    signaler: (m) => journal.push(m),
  });
  assert.equal(issue, "echec");
  assert.match(journal[0], /DESCRIPTEUR-NON-RANGE/);
  assert.equal(await rangerLeDescripteur({ ...args, magasin: null, complet: true }), "absent");
});

test("la clé du coffre est effacée après le rangement aussi", async () => {
  const cle = cleDeVolumeDe();
  const { args } = contexteDeRangement({ cleDeVolume: cle.cleDeVolume });
  await rangerLeDescripteur({ ...args, complet: true });
  assert.ok(cle.rendues[0].every((octet) => octet === 0));
});

test("la date rangée est l'instant du rangement (celle que la personne lira)", async () => {
  const { args, magasin } = contexteDeRangement();
  await rangerLeDescripteur({ ...args, complet: true });
  const lu = await lire({ recuperer: reseauCoupe, magasin });
  assert.equal(lu.horsConnexion.rangeLe, MAINTENANT);
});

test("une panne de la clé du coffre n'est PAS un refus du descripteur : elle se propage", async () => {
  const { magasin } = await magasinAvecDescripteur();
  const verrouille = Object.assign(new Error("coffre verrouillé"), {
    code: "VAULT_COQUILLE_VOLUME_VERROUILLE",
  });
  await assert.rejects(
    lire({
      recuperer: reseauCoupe,
      magasin,
      cle: {
        cleDeVolume: async () => {
          throw verrouille;
        },
      },
    }),
    verrouille,
  );
});

test("un sceau faux journalise le motif mais ne montre que le code", async () => {
  const { magasin, primitives } = await magasinAvecDescripteur();
  const fichier = primitives.fichiers.get("descripteur.scelle");
  fichier[fichier.byteLength - 1] ^= 1;
  const journal = [];
  const lu = await lire({ recuperer: reseauCoupe, magasin, journal });
  assert.equal(lu.code, C.horsLigneDescripteurRefuse);
  assert.match(journal[0], /sceau/);
  assert.doesNotMatch(lu.motif, /sceau|HMAC/i);
});

test("une erreur INATTENDUE de l'ouverture n'est pas prise pour un refus du descripteur : elle se propage", async () => {
  // Un proxy d'octets : lire `byteLength` lève un TypeError natif, que l'ouverture ne type pas.
  const octets = new Proxy(new Uint8Array(100), {});
  const magasin = { lireLeDescripteurScelle: async () => octets };
  await assert.rejects(
    lire({ recuperer: reseauCoupe, magasin }),
    (erreur) => erreur instanceof TypeError && /incompatible receiver/.test(erreur.message),
    "l'erreur native, intacte",
  );
});
