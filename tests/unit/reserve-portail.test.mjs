/**
 * Le PORTAIL de la réserve (#299, ADR 0048 §§ 7 et 8) : tout ou rien, AVANT tout Worker et toute clé.
 * Le code éprouvé est `src/coquille/reserve-portail.mjs`, avec un `navigator.serviceWorker` factice et des
 * Service Workers factices qui répondent par `MessageChannel`.
 *
 * Gardes éprouvées : 19 (test de l'API), 20 (le portail attend `update()` ET l'installation), 21 (re-contrôle,
 * poignée de main, vérification, révocation, jamais contourné sans SW), 22 (évalué à CHAQUE création), 23
 * (observateur gardé toute la vie de la page), 24-25 (états), 32 (monotone), 33 (dernière garde synchrone),
 * 34 (l'observateur écrit l'état partagé), et les courses de l'annexe A, critère 5.
 */

import assert from "node:assert/strict";
import test from "node:test";

import { CODES_REFUS_COQUILLE as C } from "../../src/coquille/refus-de-coquille.mjs";
import { ETATS_DE_FRAICHEUR as E } from "../../src/coquille/reserve-fraicheur.mjs";
import { creerEtatPartage } from "../../src/coquille/reserve-etat-partage.mjs";
import { creerLaReserveDeLaPage } from "../../src/coquille/reserve-portail.mjs";
import {
  DELAIS,
  FauxConteneur,
  FauxSW,
  FausseInscription,
  SEQUENCE,
  attendre,
  fabriqueDeTravailleurs,
  fauxNavigateur,
  reponsesSaines,
  suspendue,
} from "./support-reserve-page.mjs";

/** Une page : un contrôleur sain, son inscription, et une réserve de page sur un `navigator` factice. */
function page({
  controleur,
  inscription,
  conteneur,
  sequencePage = SEQUENCE,
  travailleurs,
  etatPartage,
  surEtat,
} = {}) {
  const actif = controleur ?? new FauxSW({ reponses: reponsesSaines() });
  const reg = inscription ?? new FausseInscription({ active: actif });
  const cont = conteneur ?? new FauxConteneur({ controller: actif, inscription: reg });
  const fabrique = travailleurs ?? fabriqueDeTravailleurs();
  const etats = [];
  const reserve = creerLaReserveDeLaPage({
    navigateur: fauxNavigateur(cont),
    sequencePage,
    delais: DELAIS,
    etatPartage,
    surEtat: (etat) => {
      etats.push(etat);
      surEtat?.(etat);
    },
  });
  const ouvrir = () =>
    reserve.ouvrirLePortail({
      creerLeTravailleur: () => fabrique.creer(),
      annonceDuTravailleur: fabrique.annonce,
      terminerLeTravailleur: () => fabrique.terminer(),
    });
  return { reserve, ouvrir, actif, reg, cont, fabrique, etats };
}

/** Un Worker en attente, identifié, qui apparaît dans l'inscription. */
const enAttente = (reg, reponses) => {
  reg.waiting = new FauxSW({ etat: "installed", reponses });
  return reg.waiting;
};

test("NOMINAL : contrôleur sain, séquence égale à celle de la page, rien de nouveau → autorisé, un Worker, `update()` lancé explicitement", async () => {
  const p = page();
  const issue = await p.ouvrir();
  assert.equal(issue.autorise, true);
  assert.equal(p.fabrique.crees, 1);
  assert.equal(
    p.reg.misesAJour,
    1,
    "`update()` est lancé à chaque démarrage : le navigateur ne redemande pas toujours le script",
  );
  assert.equal(issue.fraicheur, E.VERIFIEE);
});

test('API ABSENTE : `"serviceWorker" in navigator` est faux → RESERVE_ABSENTE (api-absente), sans lire `.controller`, sans Worker ni clé (garde 19)', async () => {
  const fabrique = fabriqueDeTravailleurs();
  const reserve = creerLaReserveDeLaPage({
    navigateur: fauxNavigateur(undefined),
    sequencePage: SEQUENCE,
    delais: DELAIS,
  });
  const issue = await reserve.ouvrirLePortail({
    creerLeTravailleur: () => fabrique.creer(),
    annonceDuTravailleur: fabrique.annonce,
    terminerLeTravailleur: () => fabrique.terminer(),
  });
  assert.equal(issue.autorise, false);
  assert.equal(issue.code, C.reserveAbsente);
  assert.equal(issue.cause, "api-absente");
  assert.equal(fabrique.crees, 0);
});

test("PREMIÈRE VISITE : ni contrôleur ni inscription → le SW est inscrit (script stable, portée `/`, `updateViaCache: none`), la page se recharge", async () => {
  const worker = new FauxSW({ etat: "installing", reponses: reponsesSaines() });
  const inscription = new FausseInscription({ installing: worker });
  const cont = new FauxConteneur({ controller: null, inscription: null });
  cont.register = async (url, options) => {
    cont.enregistrements.push({ url, options });
    cont.inscription = inscription;
    setTimeout(() => {
      inscription.installing = null;
      inscription.active = worker;
      worker.changerEtat("activated");
    }, 10);
    return inscription;
  };
  const p = page({ conteneur: cont });
  const issue = await p.ouvrir();
  assert.deepEqual(cont.enregistrements, [
    { url: "/sw-coquille.mjs", options: { scope: "/", updateViaCache: "none" } },
  ]);
  assert.equal(issue.autorise, false);
  assert.equal(issue.recharger, true, "un rechargement automatique, une seule fois");
  assert.equal(p.fabrique.crees, 0, "aucun Worker avant d'être contrôlé");
});

test("PREMIÈRE VISITE : une installation qui échoue (redondante) ou qui ne finit pas → RESERVE_ABSENTE (installation-impossible), sans Worker", async () => {
  for (const scenario of ["redondant", "refus-d-inscription", "delai"]) {
    const worker = new FauxSW({ etat: "installing" });
    const inscription = new FausseInscription({ installing: worker });
    const cont = new FauxConteneur({ controller: null });
    cont.register = async () => {
      if (scenario === "refus-d-inscription") throw new DOMException("refusé", "SecurityError");
      cont.inscription = inscription;
      if (scenario === "redondant") setTimeout(() => worker.changerEtat("redundant"), 10);
      return inscription;
    };
    const p = page({ conteneur: cont });
    const issue = await p.ouvrir();
    assert.equal(issue.autorise, false, scenario);
    assert.equal(issue.code, C.reserveAbsente, scenario);
    assert.equal(issue.cause, "installation-impossible", scenario);
    assert.equal(p.fabrique.crees, 0, scenario);
  }
});

test("SANS CONTRÔLEUR mais avec une inscription ACTIVE : RESERVE_ABSENTE (inscription-sans-controle) — jamais contourné (garde 21)", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const p = page({
    conteneur: new FauxConteneur({
      controller: null,
      inscription: new FausseInscription({ active: actif }),
    }),
  });
  const issue = await p.ouvrir();
  assert.equal(issue.autorise, false);
  assert.equal(issue.code, C.reserveAbsente);
  assert.equal(issue.cause, "inscription-sans-controle");
  assert.equal(p.fabrique.crees, 0);
});

test("SANS CONTRÔLEUR et une inscription active qui est un script de RETRAIT (Firefox) → RESERVE_PERIMEE (retrait), et l'état de révocation l'apprend", async () => {
  const retrait = new FauxSW({ reponses: reponsesSaines({ retrait: true, sequence: 0 }) });
  const p = page({
    conteneur: new FauxConteneur({
      controller: null,
      inscription: new FausseInscription({ active: retrait }),
    }),
  });
  const issue = await p.ouvrir();
  assert.equal(issue.code, C.reservePerimee);
  assert.equal(issue.cause, "retrait");
  assert.equal(p.reserve.revocation.connue(), true);
  assert.equal(p.fabrique.crees, 0);
});

test("SW MUET (aucune réponse à `version` dans le délai) → RESERVE_ABSENTE (silence-du-sw), sans Worker", async () => {
  const p = page({ controleur: new FauxSW({ reponses: {} }) });
  const issue = await p.ouvrir();
  assert.equal(issue.code, C.reserveAbsente);
  assert.equal(issue.cause, "silence-du-sw");
  assert.equal(p.fabrique.crees, 0);
});

test("SW qui répond à `version` mais pas à `verifier` : silence-du-sw, sans Worker", async () => {
  const sain = reponsesSaines();
  const p = page({ controleur: new FauxSW({ reponses: { version: sain.version } }) });
  const issue = await p.ouvrir();
  assert.equal(issue.code, C.reserveAbsente);
  assert.equal(issue.cause, "silence-du-sw");
  assert.equal(p.fabrique.crees, 0);
});

test("SÉQUENCE du contrôleur ≠ séquence de la page → RESERVE_DIVERGENTE (sequence), sans Worker", async () => {
  const p = page({
    controleur: new FauxSW({ reponses: reponsesSaines({ sequence: SEQUENCE + 1 }) }),
  });
  const issue = await p.ouvrir();
  assert.equal(issue.code, C.reserveDivergente);
  assert.equal(issue.cause, "sequence");
  assert.equal(p.fabrique.crees, 0);
});

test("ENTRÉES MANQUANTES ou ALTÉRÉES, hors connexion (la réparation échoue) : le refus reste, sans Worker (critère 3)", async () => {
  for (const [champ, code, cause] of [
    ["manquants", C.reserveIncomplete, "entrees-manquantes"],
    ["alteres", C.reserveAlteree, "entrees-alterees"],
  ]) {
    const sain = reponsesSaines();
    const verifier = () => ({
      ...sain.verifier(),
      ok: false,
      manquants: [],
      alteres: [],
      [champ]: ["/main.mjs"],
    });
    const p = page({
      controleur: new FauxSW({
        reponses: {
          ...sain,
          verifier,
          reparer: () => ({ ok: false, reparees: [], echecs: ["/main.mjs"] }),
        },
      }),
    });
    const issue = await p.ouvrir();
    assert.equal(issue.code, code, champ);
    assert.equal(issue.cause, cause, champ);
    assert.deepEqual(issue.detail, ["/main.mjs"]);
    assert.equal(p.fabrique.crees, 0, champ);
    assert.ok(p.actif.questions.includes("reparer"), `${champ} : la réparation a été tentée`);
  }
});

test("ENTRÉES MANQUANTES, EN LIGNE : `reparer` refait la réserve, le portail RÉESSAIE une fois, puis autorise (critère 3)", async () => {
  const sain = reponsesSaines();
  let repare = false;
  const verifier = () =>
    repare
      ? sain.verifier()
      : { ...sain.verifier(), ok: false, manquants: ["/main.mjs"], alteres: [] };
  const p = page({
    controleur: new FauxSW({
      reponses: {
        ...sain,
        verifier,
        reparer: () => {
          repare = true;
          return { ok: true, reparees: ["/main.mjs"], echecs: [] };
        },
      },
    }),
  });
  const issue = await p.ouvrir();
  assert.equal(issue.autorise, true);
  assert.equal(p.fabrique.crees, 1);
  assert.equal(p.actif.questions.filter((q) => q === "reparer").length, 1);
});

test("la RÉPARATION n'est tentée qu'une fois : une réserve qui reste abîmée après `reparer` est refusée, sans boucle", async () => {
  const sain = reponsesSaines();
  const p = page({
    controleur: new FauxSW({
      reponses: {
        ...sain,
        verifier: () => ({ ...sain.verifier(), ok: false, manquants: ["/main.mjs"], alteres: [] }),
      },
    }),
  });
  const issue = await p.ouvrir();
  assert.equal(issue.code, C.reserveIncomplete);
  assert.equal(p.actif.questions.filter((q) => q === "reparer").length, 1);
});

test("RÉVOCATION CONNUE au portail : un Worker en attente au plancher supérieur → RESERVE_PERIMEE (plancher), sans Worker ni clé (garde 21)", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const reg = new FausseInscription({ active: actif });
  enAttente(reg, reponsesSaines({ sequence: SEQUENCE + 1, plancher: SEQUENCE + 1 }));
  const p = page({ controleur: actif, inscription: reg });
  const issue = await p.ouvrir();
  assert.equal(issue.code, C.reservePerimee);
  assert.equal(issue.cause, "plancher");
  assert.equal(p.fabrique.crees, 0);
  assert.equal(p.reserve.revocation.connue(), true);
});

test("un contrôleur ACTIF dont le plancher dépasse la séquence de la page : cette page est révoquée → RESERVE_PERIMEE (plancher), sans Worker", async () => {
  const controleur = new FauxSW({ reponses: reponsesSaines({ plancher: SEQUENCE + 1 }) });
  const p = page({ controleur });
  const issue = await p.ouvrir();
  assert.equal(issue.code, C.reservePerimee);
  assert.equal(issue.cause, "plancher");
  assert.equal(p.fabrique.crees, 0);
});

test("un plancher ÉGAL à la séquence de la page n'est pas une révocation (seul le supérieur l'est)", async () => {
  const controleur = new FauxSW({ reponses: reponsesSaines({ plancher: SEQUENCE }) });
  assert.equal((await page({ controleur }).ouvrir()).autorise, true);
});

test("un script de RETRAIT en attente → RESERVE_PERIMEE (retrait)", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const reg = new FausseInscription({ active: actif });
  enAttente(reg, reponsesSaines({ retrait: true, sequence: 0 }));
  const issue = await page({ controleur: actif, inscription: reg }).ouvrir();
  assert.equal(issue.code, C.reservePerimee);
  assert.equal(issue.cause, "retrait");
});

test("le portail ATTEND l'installation, pas seulement `update()` : `update()` résout avant la fin, la révocation arrive pendant l'installation → refus (garde 20)", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const installation = new FauxSW({
    etat: "installing",
    reponses: reponsesSaines({ sequence: SEQUENCE + 1, plancher: SEQUENCE + 1 }),
  });
  const reg = new FausseInscription({
    active: actif,
    maj: (r) => {
      // `update()` résout tout de suite ; l'installation, elle, dure encore.
      r.installing = installation;
      r.emettre("updatefound");
      setTimeout(() => {
        r.installing = null;
        r.waiting = installation;
        installation.changerEtat("installed");
      }, 30);
    },
  });
  const p = page({ controleur: actif, inscription: reg });
  const issue = await p.ouvrir();
  assert.equal(
    issue.code,
    C.reservePerimee,
    "le portail a attendu l'état `installed` avant de décider",
  );
  assert.equal(p.fabrique.crees, 0);
});

test("ATTENTE MUETTE : un Worker en attente qui ne répond pas à `version` → autorisé, état 2 « non vérifiable », JAMAIS « plus récente » (garde 24)", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const reg = new FausseInscription({ active: actif });
  enAttente(reg, {});
  const issue = await page({ controleur: actif, inscription: reg }).ouvrir();
  assert.equal(issue.autorise, true);
  assert.equal(issue.fraicheur, E.ATTENTE_MUETTE);
});

test("VERSION EN ATTENTE PLUS ANCIENNE ou différente : autorisé, état 4, jamais « prête » (garde 25)", async () => {
  for (const sequence of [SEQUENCE - 2, SEQUENCE]) {
    const actif = new FauxSW({ reponses: reponsesSaines() });
    const reg = new FausseInscription({ active: actif });
    enAttente(reg, reponsesSaines({ sequence, version: "b".repeat(64) }));
    const issue = await page({ controleur: actif, inscription: reg }).ouvrir();
    assert.equal(issue.autorise, true);
    assert.equal(issue.fraicheur, E.VERSION_DIFFERENTE, `séquence ${sequence}`);
  }
});

test("MISE À JOUR PRÊTE : séquence supérieure, plancher ≤ courante → autorisé, état 3 ; la session n'est pas touchée", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const reg = new FausseInscription({ active: actif });
  enAttente(
    reg,
    reponsesSaines({ sequence: SEQUENCE + 1, plancher: SEQUENCE, version: "b".repeat(64) }),
  );
  const p = page({ controleur: actif, inscription: reg });
  const issue = await p.ouvrir();
  assert.equal(issue.autorise, true);
  assert.equal(issue.fraicheur, E.MISE_A_JOUR_PRETE);
  assert.equal(p.cont.controller, actif);
});

test("`update()` rejetée (réseau, 404, 5xx) : autorisé, « version courante non vérifiable » (état 6) ; installation rejetée : état 5", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const hors = new FausseInscription({
    active: actif,
    maj: async () => Promise.reject(new TypeError("Failed to fetch")),
  });
  const a = await page({ controleur: actif, inscription: hors }).ouvrir();
  assert.equal(a.autorise, true);
  assert.equal(a.fraicheur, E.NON_VERIFIABLE);

  const rejetee = new FauxSW({ etat: "installing" });
  const reg = new FausseInscription({
    active: actif,
    maj: (r) => {
      r.installing = rejetee;
      r.emettre("updatefound");
      setTimeout(() => {
        r.installing = null;
        rejetee.changerEtat("redundant");
      }, 15);
    },
  });
  const b = await page({ controleur: actif, inscription: reg }).ouvrir();
  assert.equal(b.autorise, true);
  assert.equal(b.fraicheur, E.VERIFICATION_ECHOUEE);
});

test("`update()` qui ne se règle pas dans le délai : non vérifiable (état 6), le portail ne bloque pas", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const reg = new FausseInscription({ active: actif, maj: () => new Promise(() => {}) });
  const debut = Date.now();
  const issue = await page({ controleur: actif, inscription: reg }).ouvrir();
  assert.equal(issue.autorise, true);
  assert.equal(issue.fraicheur, E.NON_VERIFIABLE);
  assert.ok(
    Date.now() - debut < DELAIS.delaiVerificationMs * 4,
    "borné par le délai de vérification",
  );
});

test("CONTRÔLEUR CHANGÉ (événement) avant le portail → RESERVE_DIVERGENTE (controleur-change), sans Worker (garde 21)", async () => {
  const p = page();
  p.cont.emettre("controllerchange");
  const issue = await p.ouvrir();
  assert.equal(issue.code, C.reserveDivergente);
  assert.equal(issue.cause, "controleur-change");
  assert.equal(p.fabrique.crees, 0);
});

test("CONTRÔLEUR REMPLACÉ pendant les vérifications (identité d'objet) → RESERVE_DIVERGENTE, sans Worker (garde 21, re-contrôle)", async () => {
  const lenteur = suspendue();
  const sain = reponsesSaines();
  const actif = new FauxSW({ reponses: { ...sain, verifier: () => lenteur.promesse } });
  const p = page({ controleur: actif });
  const encours = p.ouvrir();
  await attendre(10);
  p.cont.controller = new FauxSW({ reponses: reponsesSaines() }); // remplacé SANS événement
  lenteur.reprendre(sain.verifier());
  const issue = await encours;
  assert.equal(issue.code, C.reserveDivergente);
  assert.equal(p.fabrique.crees, 0);
});

test("POIGNÉE DE MAIN : le Worker annonce une autre séquence → terminé, RESERVE_DIVERGENTE (worker-d-une-autre-version) (garde 21)", async () => {
  const p = page({ travailleurs: fabriqueDeTravailleurs({ sequence: SEQUENCE + 1 }) });
  const issue = await p.ouvrir();
  assert.equal(issue.code, C.reserveDivergente);
  assert.equal(issue.cause, "worker-d-une-autre-version");
  assert.equal(p.fabrique.crees, 1);
  assert.equal(p.fabrique.termines, 1, "le Worker de l'autre version est terminé");
});

test("un Worker qui ne se charge pas : le code typé vient d'une RE-VÉRIFICATION, jamais de l'événement `error` (ALTEREE, INCOMPLETE, sinon ABSENTE)", async () => {
  const sain = reponsesSaines();
  let altere = true;
  const controleur = new FauxSW({
    reponses: {
      ...sain,
      verifier: () =>
        altere && controleur.questions.filter((q) => q === "verifier").length > 1
          ? { ...sain.verifier(), ok: false, manquants: [], alteres: ["/runtime-worker.mjs"] }
          : sain.verifier(),
    },
  });
  const p = page({ controleur, travailleurs: fabriqueDeTravailleurs({ erreur: "chargement" }) });
  const issue = await p.ouvrir();
  assert.equal(issue.code, C.reserveAlteree);
  assert.deepEqual(issue.detail, ["/runtime-worker.mjs"]);
  assert.equal(p.fabrique.termines, 1);
  altere = false;
  const sans = await page({
    travailleurs: fabriqueDeTravailleurs({ erreur: "chargement" }),
  }).ouvrir();
  assert.equal(sans.code, C.reserveAbsente);
  assert.equal(sans.cause, "worker-chargement");
  const muet = await page({ travailleurs: fabriqueDeTravailleurs({ silence: true }) }).ouvrir();
  assert.equal(muet.code, C.reserveAbsente);
});

test("COURSE à la création : vérification SUSPENDUE, révocation connue avant la reprise, la vérification rend « tout est bon » → RESERVE_PERIMEE, zéro Worker (critère 5, gardes 21 33 34)", async () => {
  const lenteur = suspendue();
  const sain = reponsesSaines();
  const actif = new FauxSW({ reponses: { ...sain, verifier: () => lenteur.promesse } });
  const reg = new FausseInscription({ active: actif });
  const p = page({ controleur: actif, inscription: reg });
  const encours = p.ouvrir();
  await attendre(15);
  // Pendant l'attente : un Worker apparaît, s'installe, porte un plancher supérieur.
  const revocateur = new FauxSW({
    etat: "installing",
    reponses: reponsesSaines({ sequence: SEQUENCE + 1, plancher: SEQUENCE + 1 }),
  });
  reg.installing = revocateur;
  reg.emettre("updatefound");
  reg.installing = null;
  reg.waiting = revocateur;
  revocateur.changerEtat("installed");
  await attendre(15);
  assert.equal(
    p.reserve.revocation.connue(),
    true,
    "l'observateur a écrit l'état PARTAGÉ pendant l'attente",
  );
  lenteur.reprendre(sain.verifier());
  const issue = await encours;
  assert.equal(issue.autorise, false);
  assert.equal(issue.code, C.reservePerimee);
  assert.equal(p.fabrique.crees, 0, "zéro Worker");
});

test("SECOND PORTAIL de la même page (verrouillage, réouverture) : la révocation connue entre-temps le REFUSE ; l'état n'a pas reculé même si le Worker en attente a disparu (garde 22, 32)", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const reg = new FausseInscription({ active: actif });
  const p = page({ controleur: actif, inscription: reg });
  const premier = await p.ouvrir();
  assert.equal(premier.autorise, true);
  assert.equal(p.fabrique.crees, 1);
  // Session ouverte ; une révocation est observée, puis le Worker en attente disparaît (redondant).
  const revocateur = new FauxSW({
    etat: "installing",
    reponses: reponsesSaines({ sequence: SEQUENCE + 1, plancher: SEQUENCE + 1 }),
  });
  reg.installing = revocateur;
  reg.emettre("updatefound");
  reg.installing = null;
  reg.waiting = revocateur;
  revocateur.changerEtat("installed");
  await attendre(15);
  reg.waiting = null;
  revocateur.changerEtat("redundant");
  await attendre(15);
  assert.equal(
    p.reserve.revocation.connue(),
    true,
    "ne revient jamais en arrière : ni recalcul de fraîcheur, ni disparition du Worker",
  );
  const second = await p.ouvrir();
  assert.equal(second.autorise, false);
  assert.equal(second.code, C.reservePerimee);
  assert.equal(p.fabrique.crees, 1, "aucun second Worker");
});

test("OBSERVATION TARDIVE : l'observateur reste branché APRÈS la décision du portail ; une révocation connue ensuite est ANNONCÉE, sans interrompre la session (garde 23, 34, critère 5)", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const reg = new FausseInscription({ active: actif });
  const p = page({ controleur: actif, inscription: reg });
  const issue = await p.ouvrir();
  assert.equal(issue.autorise, true);
  assert.ok(
    reg.ecouteurs("updatefound") > 0,
    "l'écouteur `updatefound` n'a pas été retiré après la décision",
  );
  const avant = p.etats.length;
  const revocateur = new FauxSW({
    etat: "installing",
    reponses: reponsesSaines({ sequence: SEQUENCE + 1, plancher: SEQUENCE + 1 }),
  });
  reg.installing = revocateur;
  reg.emettre("updatefound");
  reg.installing = null;
  reg.waiting = revocateur;
  revocateur.changerEtat("installed");
  await attendre(20);
  assert.ok(p.etats.length > avant, "le bandeau est mis à jour");
  assert.equal(p.etats.at(-1), E.REVOCATION_CONNUE);
  assert.equal(
    p.reserve.revocation.connue(),
    true,
    "ET l'état partagé : le bandeau change, l'état aussi",
  );
  assert.equal(
    p.fabrique.termines,
    0,
    "le Worker de confiance n'est pas terminé : la session n'est pas interrompue",
  );
  assert.equal(p.cont.controller, actif, "aucun `controllerchange`");
});

test("RÉVOCATION APRÈS LE DÉLAI du portail (installation lente) : état 6 d'abord, puis annonce, sans interrompre la session", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const lent = new FauxSW({
    etat: "installing",
    reponses: reponsesSaines({ sequence: SEQUENCE + 1, plancher: SEQUENCE + 1 }),
  });
  const reg = new FausseInscription({
    active: actif,
    maj: (r) => {
      r.installing = lent;
      r.emettre("updatefound");
      setTimeout(() => {
        r.installing = null;
        r.waiting = lent;
        lent.changerEtat("installed");
      }, DELAIS.delaiVerificationMs + 60);
      return new Promise(() => {});
    },
  });
  const p = page({ controleur: actif, inscription: reg });
  const issue = await p.ouvrir();
  assert.equal(issue.autorise, true, "le délai est écoulé : le portail ne bloque pas");
  assert.equal(issue.fraicheur, E.NON_VERIFIABLE);
  await attendre(DELAIS.delaiVerificationMs + 150);
  assert.equal(p.etats.at(-1), E.REVOCATION_CONNUE);
  assert.equal(p.reserve.revocation.connue(), true);
  assert.equal(p.fabrique.termines, 0);
});

test("DERNIÈRE GARDE : l'état de révocation et le contrôleur sont relus dans le MÊME TOUR que `new Worker`, sans `await` entre les deux (garde 33)", async () => {
  const lectures = [];
  const surveille = (nom, valeur) => {
    const lecture = { nom, tickPasse: false };
    lectures.push(lecture);
    queueMicrotask(() => {
      lecture.tickPasse = true;
    });
    return valeur;
  };
  const etat = creerEtatPartage();
  const connue = etat.connue;
  etat.connue = () => surveille("revocation", connue());
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const cont = new FauxConteneur({
    controller: actif,
    inscription: new FausseInscription({ active: actif }),
  });
  let courant = actif;
  Object.defineProperty(cont, "controller", {
    get: () => surveille("controleur", courant),
    set(valeur) {
      courant = valeur;
    },
  });
  let observe = null;
  const fabrique = fabriqueDeTravailleurs();
  const reserve = creerLaReserveDeLaPage({
    navigateur: fauxNavigateur(cont),
    sequencePage: SEQUENCE,
    delais: DELAIS,
    etatPartage: etat,
  });
  await reserve.ouvrirLePortail({
    creerLeTravailleur: () => {
      // L'instantané est pris AU MOMENT de la création : plus tard, les micro-tâches ont toutes tourné.
      observe = ["revocation", "controleur"].map((nom) => {
        const lecture = lectures.findLast((candidate) => candidate.nom === nom);
        return lecture ? { nom, tickPasse: lecture.tickPasse } : null;
      });
      return fabrique.creer();
    },
    annonceDuTravailleur: fabrique.annonce,
    terminerLeTravailleur: () => fabrique.terminer(),
  });
  assert.ok(observe, "le Worker a été créé");
  for (const lecture of observe) {
    assert.ok(lecture, "la garde a lu cet élément");
    assert.equal(
      lecture.tickPasse,
      false,
      `la dernière lecture (${lecture.nom}) est dans le même tour que la création : aucun await entre les deux`,
    );
  }
});

test("une garde qui lit une révocation CONNUE dans le même tour ne crée pas de Worker, même si la décision pure avait autorisé (garde 33)", async () => {
  const etat = creerEtatPartage();
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const reg = new FausseInscription({ active: actif });
  // La révocation est écrite par un événement qui tombe pendant `verifier` (suspendu), comme ci-dessus,
  // mais ici directement dans l'état partagé : seule la relecture finale peut la voir.
  const lenteur = suspendue();
  const sain = reponsesSaines();
  actif.reponses = { ...sain, verifier: () => lenteur.promesse };
  const p = page({ controleur: actif, inscription: reg, etatPartage: etat });
  const encours = p.ouvrir();
  await attendre(10);
  etat.noter("plancher");
  lenteur.reprendre(sain.verifier());
  const issue = await encours;
  assert.equal(issue.code, C.reservePerimee);
  assert.equal(p.fabrique.crees, 0);
});

test("le changement de contrôleur pendant la session est une ANOMALIE : aucun nouveau Worker, et un portail suivant le refuse (garde 21)", async () => {
  const p = page();
  assert.equal((await p.ouvrir()).autorise, true);
  p.cont.emettre("controllerchange");
  const second = await p.ouvrir();
  assert.equal(second.code, C.reserveDivergente);
  assert.equal(second.cause, "controleur-change");
  assert.equal(p.fabrique.crees, 1);
  assert.equal(p.reserve.revocation.controleurChange(), true);
});

// CONSTAT #347 — ce n'est PAS une garantie. Le plancher et le retrait d'un Worker EN ATTENTE sont ce que ce
// Worker DÉCLARE ; l'hébergeur le sert, et rien ne l'authentifie. Une origine hostile obtient donc à volonté,
// sur la page légitime, le bandeau « révocation connue » et le refus du déverrouillage. L'épreuve fixe le
// comportement actuel pour que tout changement soit délibéré : ne pas tenir ce plancher pour une révocation
// établie toucherait la logique de révocation (ADR 0048 § 9), et reste une décision du mainteneur.
test("CONSTAT #347 : un Worker en attente NON AUTHENTIFIÉ, de même séquence, qui annonce un plancher arbitraire fait refuser la page légitime — et l'état reste connu après son départ", async () => {
  const actif = new FauxSW({ reponses: reponsesSaines() });
  const reg = new FausseInscription({ active: actif });
  enAttente(reg, reponsesSaines({ sequence: SEQUENCE, plancher: 2 ** 31 }));
  const p = page({ controleur: actif, inscription: reg });
  const issue = await p.ouvrir();
  assert.equal(issue.code, C.reservePerimee, "le déverrouillage est refusé");
  assert.equal(issue.cause, "plancher");
  assert.equal(p.fabrique.crees, 0, "aucun Worker de confiance");
  assert.ok(p.etats.includes(E.REVOCATION_CONNUE), "le bandeau dit « révocation connue »");
  // Le Worker en attente disparaît : l'état reste « connu » pour la vie de la page (monotone, § 9).
  reg.waiting = null;
  const second = await p.ouvrir();
  assert.equal(second.code, C.reservePerimee);
  assert.equal(p.fabrique.crees, 0);
});
