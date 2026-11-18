// Le MAGASIN de la révocation (#310, ADR 0049) : l'ordre état → effets (I2), le pré-vol fermé pour tout
// lanceur d'enveloppe (I23″), les issues possédées par le magasin (R-c), les échecs d'effets par classe
// (I19′, E3a-g), `vue-a-rendre` à chaque changement d'occurrence, `noter` et la progression (M-a à M-f).

import assert from "node:assert/strict";
import { test } from "node:test";

import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { creerLaRevocation } from "../../src/coquille/magasin-de-la-revocation.mjs";
import { lireLeConstat, lirePublic } from "../../src/coquille/vue-de-la-revocation.mjs";
import {
  SUCCES,
  amener,
  differe,
  fabriquer,
  lire,
  tourner,
} from "./support-magasin-revocation.mjs";

test("[création] tous les exécuteurs sont obligatoires, validés à la création ; `indice` booléen obligatoire", () => {
  const { executeurs } = fabriquer();
  assert.throws(() => creerLaRevocation(), TypeError);
  assert.throws(() => creerLaRevocation({ executeurs }), TypeError, "indice absent");
  assert.throws(() => creerLaRevocation({ executeurs, indice: "non" }), TypeError);
  for (const nom of Object.keys(executeurs)) {
    const incomplet = { ...executeurs, [nom]: undefined };
    assert.throws(
      () => creerLaRevocation({ executeurs: incomplet, indice: false }),
      TypeError,
      nom,
    );
    assert.throws(
      () => creerLaRevocation({ executeurs: { ...executeurs, [nom]: 3 }, indice: false }),
      TypeError,
      nom,
    );
  }
});

test("[I1] deux instances sont indépendantes ; une instance terminée refuse tout", async () => {
  const a = fabriquer();
  const b = fabriquer({ indice: true });
  a.magasin.demarrer();
  assert.equal(a.magasin.etat().phase, "FL");
  assert.equal(b.magasin.etat().phase, "F0");
  assert.equal(b.magasin.etat().indice, true);
  a.magasin.terminer();
  assert.throws(() => a.magasin.demarrer(), TypeError);
  assert.throws(() => a.magasin.appliquer({ type: "verrouiller" }), TypeError);
  assert.throws(() => a.magasin.modifier(() => {}), TypeError);
  assert.throws(() => a.magasin.definirLIndice(true), TypeError);
  a.lectures.get(1).resoudre({});
  await tourner();
  assert.equal(
    a.magasin.etat().phase,
    "FL",
    "une issue tardive d'une instance terminée est ignorée",
  );
});

test("[R-b] `montage` : F0 → FL à vue identique ne masque pas, mais notifie `vue-a-rendre` et lance la lecture 1", () => {
  const f = fabriquer();
  const resultat = f.magasin.demarrer();
  assert.deepEqual(resultat, { accepte: true, annonce: null });
  assert.equal(f.magasin.etat().phase, "FL");
  assert.equal(f.magasin.occurrence(), 1);
  assert.deepEqual(
    f.appels.map(([n]) => n),
    ["relire", "vue-a-rendre"],
  );
  assert.deepEqual(f.appels[0], ["relire", 1, "FL"]);
  assert.equal(f.noms("masquer").length, 0, "la vue n'a pas changé : rien à masquer");
});

test("[T8] une lecture réussie : l'état est affecté AVANT `publier`, qui voit déjà les portes ouvertes", async () => {
  const f = fabriquer();
  await amener(f, "FC");
  const publication = f.noms("publier")[0];
  assert.deepEqual(
    publication,
    ["publier", 1, "FC", true],
    "publier avant l'affectation, ou sur un autre instantané",
  );
  assert.equal(f.magasin.etat().phase, "FC");
  assert.notEqual(lirePublic(f.magasin.etat()), null);
  assert.equal(lireLeConstat(f.magasin.etat()), null, "coffre fermé : aucun constat");
  const ordre = f.appels.map(([n]) => n);
  assert.ok(
    ordre.indexOf("publier") < ordre.lastIndexOf("vue-a-rendre"),
    "vue-a-rendre est le dernier effet",
  );
});

test("[I19] une lecture qui ÉCHOUE ferme : rejet, exception synchrone, réponse hors contrat → FE ; portes nulles", async () => {
  const rejet = fabriquer();
  rejet.magasin.demarrer();
  rejet.lectures.get(1).rejeter(Object.assign(new Error("x"), { code: "VAULT_TEST" }));
  await tourner();
  const sync = fabriquer({
    relire: () => {
      throw new Error("synchrone");
    },
  });
  sync.magasin.demarrer();
  await tourner();
  const horsContrat = fabriquer();
  horsContrat.magasin.demarrer();
  horsContrat.lectures.get(1).resoudre({ type: "autre" });
  await tourner();
  for (const [nom, f, evenement] of [
    ["rejet", rejet, "relecture-echouee"],
    ["synchrone", sync, "relecture-echouee"],
    ["hors contrat", horsContrat, "normalisation-echouee"],
  ]) {
    assert.equal(f.magasin.etat().phase, "FE", nom);
    assert.equal(lirePublic(f.magasin.etat()), null, `${nom} : porte ouverte`);
    assert.equal(f.consignes.at(-1).evenement, evenement, nom);
  }
  assert.equal(rejet.consignes.at(-1).code, "VAULT_TEST");
  assert.equal(
    horsContrat.noms("publier").length,
    0,
    "rien n'est publié d'une réponse hors contrat",
  );
});

test("[I13] une réponse d'une lecture ABANDONNÉE est ignorée, dans les DEUX ordres de réponse", async () => {
  for (const ordre of ["ancienne-d-abord", "neuve-d-abord"]) {
    const f = fabriquer();
    f.magasin.demarrer(); // lecture 1
    f.magasin.appliquer({ type: "coffre-ouvert", moyen: "phrase" }); // abandonne 1, lance 2
    assert.equal(f.magasin.etat().lecture, 2);
    if (ordre === "ancienne-d-abord") {
      await lire(f, 1, { codes: 5 });
      assert.equal(f.magasin.etat().phase, "SL", "la lecture 1 abandonnée a été acceptée");
      await lire(f, 2, { codes: 1 });
    } else {
      await lire(f, 2, { codes: 1 });
      await lire(f, 1, { codes: 5 });
    }
    const etat = f.magasin.etat();
    assert.equal(etat.phase, "P");
    assert.equal(
      lirePublic(etat).nombreDeCodes,
      1,
      `[${ordre}] l'ancienne lecture a écrasé la neuve`,
    );
    assert.equal(
      f.noms("publier").length,
      1,
      `[${ordre}] publier appelé pour une lecture non courante`,
    );
  }
});

test("[I13] une mutation entre deux lectures abandonne la première ; le doublon d'une réponse acceptée est ignoré", async () => {
  const f = fabriquer();
  await amener(f, "P");
  const avant = f.magasin.etat();
  f.magasin.modifier(() => differe().promesse); // e19 : P → SM
  assert.equal(f.magasin.etat().phase, "SM");
  assert.equal(f.magasin.etat().lecture, null);
  const doublon = f.lectures.get(2);
  doublon.resoudre(reponseDOuverture());
  await tourner();
  assert.equal(
    f.magasin.etat().phase,
    "SM",
    "une lecture périmée a été acceptée pendant la modification",
  );
  assert.notEqual(f.magasin.etat(), avant);
});

function reponseDOuverture() {
  return {
    type: "vault.coquille.inventaire-prive-reponse",
    refus: null,
    present: true,
    feuilleEprouvee: true,
    versionEnveloppe: 3,
    emplacements: [],
  };
}

test("[I2] la révocation : l'état V est affecté AVANT l'envoi ; `masquer` vérifié AVANT l'affectation ; un seul envoi", async () => {
  const f = fabriquer();
  await amener(f, "C");
  f.appels.length = 0;
  assert.deepEqual(f.magasin.appliquer({ type: "oui" }), { accepte: true, annonce: null });
  assert.deepEqual(
    f.appels.map(([n]) => n),
    ["masquer", "envoyer", "vue-a-rendre"],
  );
  assert.deepEqual(
    f.appels[0],
    ["masquer", "C"],
    "masquer doit précéder l'affectation de V (I23″)",
  );
  assert.deepEqual(f.appels[1], ["envoyer", "V"], "l'envoi doit trouver V (I2)");
  assert.equal(f.noms("envoyer").length, 1);
  assert.equal(
    f.magasin.appliquer({ type: "oui" }).accepte,
    false,
    "un second « Oui » envoie un second message",
  );
  assert.equal(f.noms("envoyer").length, 1);
});

test("[succès → K] l'acquit d'un envoi valide : RL, `noter` puis `relire`, K à la lecture ; l'indice suit `noter`", async () => {
  const f = fabriquer();
  await amener(f, "V");
  f.appels.length = 0;
  f.envois[0].resoudre({ ...SUCCES });
  await tourner();
  assert.equal(f.magasin.etat().phase, "RL");
  assert.deepEqual(
    f.appels.map(([n]) => n).filter((n) => ["noter", "relire"].includes(n)),
    ["noter", "relire"],
  );
  assert.equal(f.magasin.projection().affirmations.revoque, true);
  assert.equal(f.magasin.etat().indice, false, "l'indice n'est écrit qu'à la réussite de `noter`");
  f.notes[0].resoudre();
  await tourner();
  assert.equal(f.magasin.etat().indice, true);
  await lire(f, f.magasin.etat().lecture);
  assert.equal(f.magasin.etat().phase, "K");
  assert.equal(lireLeConstat(f.magasin.etat()).feuilleEprouvee, true);
});

const ECHECS_DE_L_ENVOI = Object.freeze([
  [
    "rejet avec code",
    () => Promise.reject(Object.assign(new Error("x"), { code: "VAULT_REFUS" })),
    "refus-type",
    "VAULT_REFUS",
  ],
  ["rejet sans code", () => Promise.reject(new Error("x")), "erreur-sans-code", null],
  [
    "Worker mort",
    () => Promise.reject(Object.assign(new Error("x"), { code: CODES_REFUS_COQUILLE.workerMort })),
    "worker-mort",
    CODES_REFUS_COQUILLE.workerMort,
  ],
  [
    "Worker rompu",
    () => Promise.reject(Object.assign(new Error("x"), { code: CODES_REFUS_COQUILLE.gesteRompu })),
    "worker-rompu",
    CODES_REFUS_COQUILLE.gesteRompu,
  ],
  ["réponse malformée", () => Promise.resolve({ type: "autre" }), "reponse-malformee", null],
  [
    "exception synchrone",
    () => {
      throw new Error("synchrone");
    },
    "erreur-sans-code",
    null,
  ],
]);

for (const [nom, envoyer, evenement, codeAttendu] of ECHECS_DE_L_ENVOI) {
  test(`[E3a] échec d'envoi (${nom}) → I, un SEUL appel, jamais P ni C, diagnostic au rapport`, async () => {
    const f = fabriquer({ envoyer });
    await amener(f, "C");
    f.magasin.appliquer({ type: "oui" });
    await tourner();
    assert.equal(f.magasin.etat().phase, "I");
    assert.equal(f.noms("envoyer").length, 1, "l'envoi a été rejoué");
    assert.equal(f.consignes.at(-1).evenement, evenement);
    assert.equal(f.consignes.at(-1).code, codeAttendu, "le code du Worker est perdu");
    assert.equal(f.magasin.projection().affirmations.peutEtreRevoque, true);
    assert.equal(
      f.magasin.accepte("demander-la-revocation"),
      false,
      "aucune nouvelle demande après un doute",
    );
  });
}

test("[E3b] échec de lecture depuis FL, SL, RL : FE, SE, RE ; portes nulles ; cause conservée", async () => {
  const fl = fabriquer();
  await amener(fl, "FL");
  fl.lectures.get(1).rejeter(new Error("x"));
  const sl = fabriquer();
  await amener(sl, "SL");
  sl.lectures.get(2).rejeter(new Error("x"));
  const rl = fabriquer();
  await amener(rl, "RL");
  rl.lectures.get(rl.magasin.etat().lecture).rejeter(new Error("x"));
  await tourner();
  assert.equal(fl.magasin.etat().phase, "FE");
  assert.equal(sl.magasin.etat().phase, "SE");
  assert.equal(rl.magasin.etat().phase, "RE");
  for (const f of [fl, sl, rl]) assert.equal(lirePublic(f.magasin.etat()), null);
});

test("[E3c] échec de PUBLICATION (exception, rejet, écriture partielle) : l'état et les portes NEUVES tiennent", async () => {
  for (const [nom, publier] of [
    [
      "exception",
      () => {
        throw new Error("publier");
      },
    ],
    ["rejet", () => Promise.reject(new Error("publier"))],
    [
      "partielle",
      () => {
        throw new Error("écrit à moitié");
      },
    ],
  ]) {
    const f = fabriquer({ publier });
    await amener(f, "P");
    await tourner();
    assert.equal(f.magasin.etat().phase, "P", nom);
    assert.equal(lirePublic(f.magasin.etat()).nombreDeCodes, 1, nom);
    assert.ok(
      f.magasin.echecs().entrees.some((e) => e.effet === "publier"),
      `${nom} : échec non consigné`,
    );
  }
});

test("[E3d] échec de navigation (`oublier`, `terminer`, `revenir`) : aucune transition de plus, échec consigné", async () => {
  const f = fabriquer({
    oublier: () => {
      throw new Error("oublier");
    },
    terminer: () => {
      throw new Error("terminer");
    },
    revenir: () => Promise.reject(new Error("revenir")),
  });
  await amener(f, "P");
  f.magasin.appliquer({ type: "demander-la-revocation" });
  f.magasin.appliquer({ type: "annuler" });
  assert.equal(f.magasin.etat().phase, "P");
  f.magasin.appliquer({ type: "terminer-sans-revoquer" });
  f.magasin.appliquer({ type: "revenir-a-l-application" });
  await tourner();
  assert.equal(f.magasin.etat().phase, "P");
  const effets = new Set(f.magasin.echecs().entrees.map((e) => e.effet));
  for (const nom of ["oublier", "terminer", "revenir"])
    assert.ok(effets.has(nom), `${nom} non consigné`);
});

test("[E3e] échec d'AFFICHAGE non gardé (`masquer` faux ou levée, `vueARendre` levée) : ni l'état ni les portes ne bougent", async () => {
  for (const reglage of [
    { masquer: () => false },
    {
      masquer: () => {
        throw new Error("m");
      },
    },
    {
      vueARendre: () => {
        throw new Error("v");
      },
    },
  ]) {
    const f = fabriquer(reglage);
    await amener(f, "P");
    await tourner();
    assert.equal(f.magasin.etat().phase, "P");
    assert.equal(lirePublic(f.magasin.etat()).nombreDeCodes, 1);
    assert.ok(f.magasin.echecs().entrees.length > 0);
  }
});

test("[M-a] succès acquitté puis `masquer` en échec : `noter` et `relire` sont exécutés, état RL, échec consigné", async () => {
  let masquer = true;
  const f = fabriquer({ masquer: () => masquer });
  await amener(f, "V");
  masquer = false;
  f.appels.length = 0;
  f.envois[0].resoudre({ ...SUCCES });
  await tourner();
  assert.equal(f.magasin.etat().phase, "RL");
  assert.equal(f.noms("noter").length, 1, "`noter` a été sauté : le fait acquis serait perdu");
  assert.equal(f.noms("relire").length, 1, "la relecture a été empêchée par un défaut d'affichage");
  assert.ok(f.magasin.echecs().entrees.some((e) => e.effet === "masquer"));
});

test("[M-b] `noter` en échec : RL reste, la relecture est lancée, l'échec est consigné (« indice non écrit »)", async () => {
  const f = fabriquer({ noter: () => Promise.reject(new Error("écriture")) });
  await amener(f, "V");
  const lecturesAvant = f.noms("relire").length;
  f.envois[0].resoudre({ ...SUCCES });
  await tourner();
  assert.equal(f.magasin.etat().phase, "RL");
  assert.equal(f.magasin.etat().indice, false);
  assert.equal(f.noms("relire").length, lecturesAvant + 1, "la relecture n'est pas partie");
  assert.ok(f.magasin.echecs().entrees.some((e) => e.effet === "noter"));
});

test("[M-c] une remise à zéro DEMANDÉE pendant un `noter` en vol l'emporte : l'indice reste faux", async () => {
  const f = fabriquer();
  await amener(f, "V");
  f.envois[0].resoudre({ ...SUCCES });
  await tourner();
  f.magasin.definirLIndice(false); // rang +1 pendant que `noter` est en vol
  f.notes[0].resoudre();
  await tourner();
  assert.equal(f.magasin.etat().indice, false, "noter a rétabli l'indice malgré la remise à zéro");
});

test("[M-d] la remise à zéro PUIS `noter` : l'indice final est vrai", async () => {
  const f = fabriquer();
  f.magasin.definirLIndice(false);
  await amener(f, "V");
  f.envois[0].resoudre({ ...SUCCES });
  await tourner();
  f.notes[0].resoudre();
  await tourner();
  assert.equal(f.magasin.etat().indice, true);
});

test("[M-c] une demande invalide de `definirLIndice` ne touche pas au rang : `noter` en vol reste valide", async () => {
  const f = fabriquer();
  await amener(f, "V");
  f.envois[0].resoudre({ ...SUCCES });
  await tourner();
  assert.throws(() => f.magasin.definirLIndice("oui"), TypeError);
  f.notes[0].resoudre();
  await tourner();
  assert.equal(f.magasin.etat().indice, true, "un appel invalide a invalidé le `noter` en vol");
});

test("[e21] `definirLIndice` : booléen obligatoire ; en P il masque et notifie, ailleurs il notifie seulement", async () => {
  const f = fabriquer();
  await amener(f, "P");
  f.appels.length = 0;
  f.magasin.definirLIndice(true);
  assert.deepEqual(
    f.appels.map(([n]) => n),
    ["masquer", "vue-a-rendre"],
  );
  assert.equal(f.magasin.projection().finDisponible, "termine-sans-attestation");
  f.appels.length = 0;
  f.magasin.definirLIndice(true);
  assert.equal(f.appels.length, 0, "aucun changement : aucun effet");
  assert.throws(() => f.magasin.definirLIndice("oui"), TypeError);
  assert.throws(() => f.magasin.definirLIndice(), TypeError);
});

const SOURCES_DE_MODIFICATION = Object.freeze([
  ["FL", "FE"],
  ["FC", "FE"],
  ["SL", "SE"],
  ["RL", "RE"],
  ["P", "SE"],
  ["C", "SE"],
  ["K", "RE"],
]);

for (const [source, ferme] of SOURCES_DE_MODIFICATION) {
  for (const [nomDuMasquage, masquer] of [
    ["faux", () => false],
    [
      "exception",
      () => {
        throw new Error("masquer");
      },
    ],
    ["non booléen", () => undefined],
    ["chaîne « vrai »", () => "true"],
  ]) {
    test(`[I23″] pré-vol de ${source} : masquer ${nomDuMasquage} → le lanceur n'est JAMAIS appelé, ${source} → ${ferme}`, async () => {
      let ouvert = true;
      const f = fabriquer({ masquer: () => (ouvert ? true : masquer()) });
      await amener(f, source);
      ouvert = false;
      let appele = 0;
      const resultat = f.magasin.modifier(() => {
        appele += 1;
        return Promise.resolve();
      });
      await tourner();
      assert.equal(
        appele,
        0,
        "le lanceur de modification d'enveloppe a été appelé sans masquage établi",
      );
      assert.deepEqual(resultat, { accepte: false, annonce: "lancement-annule-affichage" });
      assert.equal(f.magasin.etat().phase, ferme);
      assert.equal(f.consignes.at(-1).evenement, "masquage-impossible");
      assert.equal(lirePublic(f.magasin.etat()), null, "une porte reste ouverte");
    });
  }
}

test("[I23″] pré-vol de la révocation : masquer faux/exception/non booléen → SE, `envoyer` jamais appelé, V jamais affecté", async () => {
  for (const masquer of [
    () => false,
    () => {
      throw new Error("m");
    },
    () => undefined,
  ]) {
    let ouvert = true;
    const f = fabriquer({ masquer: () => (ouvert ? true : masquer()) });
    await amener(f, "C");
    ouvert = false;
    const resultat = f.magasin.appliquer({ type: "oui" });
    await tourner();
    assert.deepEqual(resultat, { accepte: false, annonce: "envoi-annule-affichage" });
    assert.equal(f.noms("envoyer").length, 0);
    assert.equal(f.magasin.etat().phase, "SE");
    assert.equal(
      f.magasin.projection().affirmations.aucunGesteDansCetteSeance,
      true,
      "rien n'est parti : le fait négatif tient",
    );
    assert.ok(
      !f.appels.some(([n, p]) => n === "vue-a-rendre" && p === "V"),
      "V a été affecté puis annulé",
    );
  }
});

test("[I23″] masquage établi : `masquer` voit encore la phase SOURCE ; le lanceur voit la phase CIBLE", async () => {
  for (const [source, cible] of [
    ["P", "SM"],
    ["C", "SM"],
    ["FC", "FM"],
    ["K", "RM"],
    ["SL", "SM"],
    ["RL", "RM"],
    ["FL", "FM"],
  ]) {
    const f = fabriquer();
    await amener(f, source);
    f.appels.length = 0;
    let phaseDuLanceur = null;
    f.magasin.modifier(() => {
      phaseDuLanceur = f.magasin.etat().phase;
      return new Promise(() => {});
    });
    assert.deepEqual(
      f.appels.find(([n]) => n === "masquer"),
      ["masquer", source],
      `${source} : masquer après l'affectation`,
    );
    assert.equal(phaseDuLanceur, cible, `${source} : le lanceur n'a pas trouvé l'état cible`);
  }
});

test("[e20] la modification : toute issue relance la lecture ; une MORT du Worker ferme (e7) ; la restauration depuis FC aussi", async () => {
  const f = fabriquer();
  await amener(f, "P");
  f.magasin.modifier(() => Promise.resolve());
  await tourner();
  assert.equal(f.magasin.etat().phase, "SL");
  assert.equal(f.magasin.etat().lecture, 3);
  const refus = fabriquer();
  await amener(refus, "FC");
  refus.magasin.modifier(() =>
    Promise.reject(Object.assign(new Error("x"), { code: "VAULT_REFUS" })),
  );
  await tourner();
  assert.equal(refus.magasin.etat().phase, "FL", "un refus de la modification relit quand même");
  const mort = fabriquer();
  await amener(mort, "K");
  mort.magasin.modifier(() =>
    Promise.reject(Object.assign(new Error("x"), { code: CODES_REFUS_COQUILLE.workerMort })),
  );
  await tourner();
  assert.equal(mort.magasin.etat().phase, "RE");
});

test("[R-c] les événements de RÉPONSE ne sont pas appelables de l'extérieur : succès, lectures, fin de modification, e21, e22, montage", () => {
  const f = fabriquer();
  // Charges utiles VALIDES : sans la liste blanche, ces événements seraient simplement traités.
  const charges = {
    "relecture-reussie": { lecture: 1, donnees: {} },
    "relecture-echouee": { lecture: 1 },
    "indice-change": { valeur: true },
    "masquage-impossible": { action: "envoi" },
  };
  for (const type of [
    "reponse-de-succes",
    "refus-type",
    "worker-rompu",
    "reponse-malformee",
    "erreur-sans-code",
    "delai-depasse",
    "relecture-reussie",
    "relecture-echouee",
    "modification-terminee",
    "indice-change",
    "masquage-impossible",
    "montage",
    "inconnu",
  ]) {
    assert.throws(() => f.magasin.appliquer({ type, ...charges[type] }), TypeError, type);
  }
  assert.throws(() => f.magasin.appliquer(null), TypeError);
  assert.throws(() => f.magasin.modifier("pas une fonction"), TypeError);
});

test("[réentrance] un exécuteur qui rappelle le magasin reçoit une TypeError, consignée ; l'état tient", async () => {
  let reentree = null;
  const f = fabriquer({
    oublier: () => {
      try {
        f.magasin.appliquer({ type: "verrouiller" });
      } catch (erreur) {
        reentree = erreur;
      }
    },
  });
  await amener(f, "P");
  f.magasin.appliquer({ type: "demander-la-revocation" });
  f.magasin.appliquer({ type: "annuler" });
  assert.ok(reentree instanceof TypeError, "la réentrance n'a pas été refusée");
  assert.equal(f.magasin.etat().phase, "P");
});

test("[E3g/I20′] `consigner` qui échoue : UN appel par arête, aucune récursion, journal borné à 64 + compteur de pertes", async () => {
  const f = fabriquer({
    consigner: () => {
      throw new Error("consigner");
    },
  });
  await amener(f, "P");
  f.magasin.appliquer({ type: "worker-mort" }); // P → SE : consigner lève
  assert.equal(f.noms("consigner").length, 1, "consigner a été rappelé pour son propre échec");
  assert.equal(f.magasin.etat().phase, "SE");
  assert.ok(f.magasin.echecs().entrees.some((e) => e.effet === "consigner"));
  const g = fabriquer({
    vueARendre: () => {
      throw new Error("v");
    },
  });
  for (let i = 0; i < 100; i += 1) g.magasin.definirLIndice(i % 2 === 0);
  const { entrees, perdus } = g.magasin.echecs();
  assert.equal(entrees.length, 64, "journal non borné");
  assert.equal(perdus, 36, "compteur de pertes");
  const rangs = entrees.map((e) => e.rang);
  assert.ok(
    rangs.every((rang, i) => i === 0 || rang === rangs[i - 1] + 1),
    "rangs du journal non consécutifs",
  );
  assert.equal(rangs.at(-1), 100, "le dernier rang doit compter toutes les défaillances");
});

test("[I22′] chaque transition acceptée qui change l'occurrence appelle `vueARendre` EXACTEMENT une fois", async () => {
  const f = fabriquer();
  await amener(f, "K");
  assert.equal(f.noms("vue-a-rendre").length, f.magasin.occurrence());
  f.magasin.appliquer({ type: "verrouiller" });
  f.magasin.appliquer({ type: "revenir-a-l-application" });
  assert.equal(
    f.noms("vue-a-rendre").length,
    f.magasin.occurrence(),
    "une cellule « = » a notifié",
  );
});

test("[API] la projection, l'empreinte et l'occurrence suivent l'état ; `accepte` est celui de la table", async () => {
  const f = fabriquer();
  await amener(f, "P");
  assert.equal(f.magasin.projection().ecranImpose, null);
  assert.equal(f.magasin.accepte("demander-la-revocation"), true);
  assert.equal(f.magasin.accepte("oui"), false);
  assert.equal(f.magasin.empreinte(), f.magasin.projection().empreinte);
  assert.equal(f.magasin.occurrence(), f.magasin.etat().occurrence);
});

test("[envoi] les erreurs d'`envoyer` ne sont jamais des rejets non gérés (aucun unhandledRejection)", async () => {
  let non_gere = 0;
  const ecoute = () => {
    non_gere += 1;
  };
  process.on("unhandledRejection", ecoute);
  try {
    const f = fabriquer({
      envoyer: () => Promise.reject(new Error("x")),
      publier: () => Promise.reject(new Error("p")),
      consigner: () => Promise.reject(new Error("c")),
    });
    await amener(f, "C");
    f.magasin.appliquer({ type: "oui" });
    await tourner();
    assert.equal(f.magasin.etat().phase, "I");
  } finally {
    process.off("unhandledRejection", ecoute);
  }
  assert.equal(non_gere, 0);
});
