// Le RENDEUR UNIQUE (#265, ADR 0049 § C2, protocole X1.2) : un seul rendu AUTORISÉ, publication
// atomique, successeur garanti. Promesses contrôlées, horloge factice : aucun navigateur ici (le DOM
// réel rejoue les mêmes scénarios dans `tests/browser/coquille-rendeur-dom.spec.mjs`).

import assert from "node:assert/strict";
import { test } from "node:test";

import { DELAI_DU_RENDEUR_MS } from "../../src/coquille/rendeur-de-la-vue.mjs";
import { banc, vider } from "./support-banc-du-rendeur.mjs";

const lever = (message) => () => {
  throw new Error(message);
};

test("le délai du rendeur est un entier strictement positif, en millisecondes", () => {
  assert.ok(Number.isSafeInteger(DELAI_DU_RENDEUR_MS) && DELAI_DU_RENDEUR_MS > 0);
});

// --- X-a : le succès -----------------------------------------------------------------------------

test("[X-a] succès : quatre effets dans l'ordre, enVol tenu pendant tout le bloc, libéré après", async () => {
  const b = banc();
  b.rendeur.reveiller();
  assert.equal(b.lancements(), 1, "une tentative part à la première notification");
  assert.deepEqual(b.visible, [], "rien de visible avant le règlement");
  b.taches[0].ok();
  await vider();
  assert.deepEqual(b.visible, ["remplacer:1", "retirer-erreur", "demasquer", "estampe:1"]);
  for (const [nom, enVol] of b.enVolVuAuxEffets) {
    assert.equal(enVol, true, `enVol est occupé pendant « ${nom} » (autorisation tenue)`);
  }
  const d = b.rendeur.diagnostic();
  assert.equal(d.enVol, false, "libéré après l'estampille");
  assert.equal(d.occurrencePubliee, 1);
  assert.equal(d.derniereOccurrenceTraitee, 1);
});

test("[X-a] rien n'est refait pour une occurrence déjà traitée", async () => {
  const b = banc();
  b.rendeur.reveiller();
  b.taches[0].ok();
  await vider();
  b.rendeur.reveiller();
  b.rendeur.reveiller();
  assert.equal(b.lancements(), 1, "une occurrence publiée n'est jamais relancée");
});

// --- X-b : échec de publication au milieu du bloc -------------------------------------------------

test("[X-b] `demasquer` lève après `remplacer` : repli autorisé (masquer + erreur), libération, pas de boucle", async () => {
  const b = banc({ defaillances: { demasquer: lever("démasquage") } });
  b.rendeur.reveiller();
  b.taches[0].ok();
  await vider();
  assert.deepEqual(b.visible, ["remplacer:1", "retirer-erreur", "masquer", "erreur:1"]);
  assert.ok(b.consigne.includes("regler-en-echec"));
  assert.equal(b.rendeur.diagnostic().enVol, false);
  b.rendeur.reveiller();
  assert.equal(b.lancements(), 1, "l'occurrence en erreur est « traitée » : aucune boucle");
  assert.equal(b.rendeur.diagnostic().occurrencePubliee, null, "rien n'a été publié");
});

test("[X-b] si l'occurrence a changé pendant l'échec, le successeur part", async () => {
  const b = banc({ defaillances: { demasquer: lever("démasquage") } });
  b.rendeur.reveiller();
  b.taches[0].ok();
  b.occ += 1;
  await vider();
  assert.equal(
    b.lancementsDe(2),
    1,
    "le successeur de l'occurrence courante part dans le même tour",
  );
});

// --- X-c, X-d : l'expiration puis la reprise tardive ----------------------------------------------

test("[X-c] expiration : masquage et région d'erreur de l'occurrence ; la reprise tardive n'a aucun effet", async () => {
  for (const reprise of ["ok", "ko", "leve"]) {
    const b = banc();
    b.rendeur.reveiller();
    assert.equal(b.minuteries[0].ms, DELAI_DU_RENDEUR_MS, "le délai armé est celui du module");
    b.expirer();
    assert.deepEqual(b.visible, ["masquer", "erreur:1"], `${reprise} : l'expiration règle`);
    const avant = [...b.visible];
    if (reprise === "ok") b.taches[0].ok();
    if (reprise === "ko") b.taches[0].ko();
    await vider();
    assert.deepEqual(b.visible, avant, `${reprise} : aucun effet visible à la reprise tardive`);
    assert.ok(b.consigne.includes("tentative-perimee"), `${reprise} : consigné`);
  }
});

test("[X-d] reprise tardive, occurrence INCHANGÉE : la région d'erreur reste, rien n'est publié, une seule tentative", async () => {
  const b = banc();
  b.rendeur.reveiller();
  b.expirer();
  b.taches[0].ok();
  await vider();
  b.rendeur.reveiller();
  assert.deepEqual(b.visible, ["masquer", "erreur:1"]);
  assert.equal(b.lancementsDe(1), 1);
  assert.equal(b.rendeur.diagnostic().occurrencePubliee, null);
});

// --- X-e : notification pendant le règlement -------------------------------------------------------

test("[X-e] une transition synchrone pendant la publication arrête le bloc AVANT l'estampille, puis le successeur part", async () => {
  let b;
  b = banc({ defaillances: { demasquer: () => b.avancer() } });
  b.rendeur.reveiller();
  b.taches[0].ok();
  await vider();
  assert.ok(
    !b.visible.some((ligne) => ligne.startsWith("estampe")),
    "aucune estampille de l'ancienne occurrence",
  );
  assert.equal(b.lancementsDe(2), 1, "le successeur de l'occurrence courante est lancé");
});

// --- X-f : aucun rejet n'empêche le successeur ----------------------------------------------------

const DEFAILLANCES = [
  ["rendre rejette", {}, (b) => b.taches[0].ko()],
  ["rendre lève de façon synchrone", { "rendre-synchrone": lever("synchrone") }, () => {}],
  ["publier lève", { remplacer: lever("publier") }, (b) => b.taches[0].ok()],
  [
    "echouer lève",
    { masquer: lever("echouer"), remplacer: lever("publier") },
    (b) => b.taches[0].ok(),
  ],
  ["masquer lève (expiration)", { masquer: lever("masquer") }, (b) => b.expirer()],
  [
    "consigner lève",
    { consigner: lever("consigner"), demasquer: lever("demasquer") },
    (b) => b.taches[0].ok(),
  ],
  ["erreur avant le try de regler", { desarmer: lever("desarmer") }, (b) => b.taches[0].ok()],
  [
    "erreur avant le try de regler ET consigner qui lève",
    { desarmer: lever("desarmer"), consigner: lever("consigner") },
    (b) => b.taches[0].ok(),
  ],
];

for (const [nom, defaillances, regler] of DEFAILLANCES) {
  test(`[X-f] ${nom} : le successeur part si l'occurrence a changé, jamais de boucle`, async () => {
    const b = banc({ defaillances });
    b.rendeur.reveiller();
    regler(b);
    b.occ += 1;
    await vider();
    assert.equal(b.lancementsDe(2), 1, "le successeur de l'occurrence courante part");
    assert.equal(b.lancementsDe(1), 1, "l'occurrence défaillante n'est pas relancée");
  });
  test(`[X-f] ${nom} : sans changement d'occurrence, le rendeur est libre et ne boucle pas`, async () => {
    const b = banc({ defaillances });
    b.rendeur.reveiller();
    regler(b);
    await vider();
    b.rendeur.reveiller();
    await vider();
    assert.equal(b.rendeur.diagnostic().enVol, false, "aucune autorisation ne reste occupée");
    assert.equal(b.lancementsDe(1), 1, "au plus une tentative par occurrence");
  });
}

test("[X-f/O1] l'armement du délai échoue APRÈS enVol ← t : libération et convergence, sans boucle, même si consigner lève", async () => {
  const b = banc({ defaillances: { armer: lever("armer"), consigner: lever("consigner") } });
  b.rendeur.reveiller();
  await vider();
  assert.equal(b.rendeur.diagnostic().enVol, false, "enVol n'est pas resté occupé");
  assert.equal(b.lancementsDe(1), 1, "l'occurrence n'est pas relancée en boucle");
  b.occ += 1;
  b.rendeur.reveiller();
  assert.equal(b.lancementsDe(2), 1, "le rendeur n'est pas bloqué : l'occurrence suivante part");
});

// --- X-g : deux tâches, une autorisation -----------------------------------------------------------

for (const ordre of ["A puis B", "B puis A"]) {
  test(`[X-g] A abandonnée par le délai, B autorisée, règlement « ${ordre} » : seul B agit`, async () => {
    const b = banc();
    b.rendeur.reveiller();
    b.occ += 1;
    b.expirer(0);
    await vider();
    assert.equal(b.lancementsDe(2), 1, "B est lancée à la place de A");
    const avant = b.visible.length;
    if (ordre === "A puis B") {
      b.taches[0].ok();
      await vider();
      assert.equal(b.visible.length, avant, "A n'écrit rien");
      b.taches[1].ok();
    } else {
      b.taches[1].ok();
      await vider();
      b.taches[0].ok();
    }
    await vider();
    assert.deepEqual(b.visible.slice(avant), [
      "remplacer:2",
      "retirer-erreur",
      "demasquer",
      "estampe:2",
    ]);
  });
}

// --- R-a … R-h --------------------------------------------------------------------------------------

test("[R-a] l'occurrence avance (vue identique) pendant un rendu suspendu : A est jeté, le successeur part dans le même tour", async () => {
  for (const issue of ["ok", "ko"]) {
    const b = banc();
    b.rendeur.reveiller();
    b.avancer();
    assert.equal(b.lancements(), 1, "A est vivant : B n'est pas lancé");
    if (issue === "ok") b.taches[0].ok();
    else b.taches[0].ko();
    await vider();
    assert.deepEqual(b.visible, [], `${issue} : aucun effet visible de A`);
    assert.equal(b.lancementsDe(2), 1, `${issue} : le successeur de l'occurrence 2 est parti`);
    b.taches[1].ok();
    await vider();
    assert.deepEqual(b.visible, ["remplacer:2", "retirer-erreur", "demasquer", "estampe:2"]);
  }
});

test("[R-a] A ne se règle jamais : à l'expiration, le successeur part, sans erreur affichée", async () => {
  const b = banc();
  b.rendeur.reveiller();
  b.avancer();
  b.expirer(0);
  assert.deepEqual(b.visible, [], "l'occurrence courante n'a pas été tentée : aucune erreur");
  assert.equal(b.lancementsDe(2), 1);
});

test("[R-b] deux vues identiques (occurrence 0 → 1) : un rendu part, l'espace réservé ne reste pas", async () => {
  const b = banc({ occurrence: 0 });
  b.rendeur.reveiller();
  b.taches[0].ok();
  await vider();
  b.avancer();
  assert.equal(b.lancementsDe(1), 1);
  b.taches[1].ok();
  await vider();
  assert.equal(b.rendeur.diagnostic().occurrencePubliee, 1);
});

test("[R-c] (i) B n'est PAS lancé tant que A est vivant ; (ii) A abandonné, B publié, A reprend : DOM identique", async () => {
  const b = banc();
  b.rendeur.reveiller();
  b.avancer(2);
  assert.equal(b.lancements(), 1, "(i) un seul rendu en vol");
  for (const reprise of ["ok", "ko", "leve"]) {
    const c = banc();
    c.rendeur.reveiller();
    c.avancer();
    c.expirer(0);
    c.taches[1].ok();
    await vider();
    const publie = [...c.visible];
    assert.deepEqual(publie.slice(-4), ["remplacer:2", "retirer-erreur", "demasquer", "estampe:2"]);
    if (reprise === "ok") c.taches[0].ok();
    else c.taches[0].ko();
    await vider();
    assert.deepEqual(c.visible, publie, `(ii) ${reprise} : le DOM est identique`);
    assert.ok(c.consigne.includes("tentative-perimee"));
  }
});

test("[R-d] un rendu qui ne se règle jamais, occurrence inchangée : masquage + erreur, aucun relancement, puis l'occurrence suivante retire l'erreur", async () => {
  const b = banc();
  b.rendeur.reveiller();
  b.expirer();
  assert.deepEqual(b.visible, ["masquer", "erreur:1"]);
  b.rendeur.reveiller();
  assert.equal(b.lancementsDe(1), 1, "aucun relancement de la même occurrence");
  b.avancer();
  b.taches[1].ok();
  await vider();
  assert.deepEqual(b.visible.slice(2), ["remplacer:2", "retirer-erreur", "demasquer", "estampe:2"]);
});

test("[R-e] enumération : jamais deux autorisations, jamais deux tentatives par occurrence, publications croissantes", async () => {
  const OPS = ["notifier", "avancer", "regler-ok", "expirer"];
  const LONGUEUR = 6;
  const sequences = [[]];
  for (let i = 0; i < LONGUEUR; i += 1) {
    for (const s of sequences.splice(0)) for (const op of OPS) sequences.push([...s, op]);
  }
  for (const sequence of sequences) {
    const b = banc({ occurrence: 1 });
    b.rendeur.reveiller();
    let vivantes = 0;
    for (const op of sequence) {
      if (op === "notifier") b.rendeur.reveiller();
      if (op === "avancer" && b.occ < 3) b.avancer();
      const derniere = b.taches.at(-1);
      if (op === "regler-ok" && derniere && !derniere.regle) {
        derniere.regle = true;
        derniere.ok();
        await vider();
      }
      if (op === "expirer" && b.minuteries.length > 0) {
        const m = b.minuteries.findLast((x) => !x.annulee);
        if (m) {
          m.annulee = true;
          m.fonction();
          await vider();
        }
      }
      vivantes = b.rendeur.diagnostic().enVol ? 1 : 0;
      assert.ok(vivantes <= 1, `${sequence.join(",")} : au plus une autorisation`);
      for (const occ of [1, 2, 3]) {
        assert.ok(
          b.lancementsDe(occ) <= 1,
          `${sequence.join(",")} : occurrence ${occ} lancée au plus une fois`,
        );
      }
    }
    const estampilles = b.visible
      .filter((l) => l.startsWith("estampe:"))
      .map((l) => Number(l.slice(8)));
    assert.deepEqual(
      estampilles,
      [...estampilles].sort((x, y) => x - y),
      `${sequence.join(",")} : croissantes`,
    );
    assert.equal(new Set(estampilles).size, estampilles.length, "aucune publication en double");
  }
});

test("[R-f] P → C → P (occurrences 1, 2, 3) : A1 est jeté, le successeur part pour l'occurrence 3, aucune erreur tardive", async () => {
  const b = banc();
  b.rendeur.reveiller();
  b.avancer(2);
  b.taches[0].ko();
  await vider();
  assert.equal(b.lancementsDe(2), 0, "l'occurrence 2 n'est jamais rendue");
  assert.equal(b.lancementsDe(3), 1);
  assert.ok(!b.visible.some((l) => l.startsWith("erreur")), "aucune erreur affichée");
});

test("[R-g] un rendu qui répond de façon synchrone est réglé au tour SUIVANT, avec les mêmes gardes", async () => {
  const b = banc({ defaillances: { "rendre-pret": () => "pret" } });
  b.rendeur.reveiller();
  assert.deepEqual(b.visible, [], "rien de visible dans le tour de la notification");
  b.occ += 1;
  await vider();
  assert.ok(
    !b.visible.some((l) => l.startsWith("estampe:1")),
    "gardé : l'ancienne occurrence n'est pas estampillée",
  );
  assert.equal(b.lancementsDe(2), 1);
});

test("[R-h] exception dans la publication : échec de la tentative vivante, masquage + erreur, pas de boucle", async () => {
  const b = banc({ defaillances: { "retirer-erreur": lever("milieu") } });
  b.rendeur.reveiller();
  b.taches[0].ok();
  await vider();
  assert.deepEqual(b.visible.slice(-2), ["masquer", "erreur:1"]);
  assert.equal(b.lancementsDe(1), 1);
});
