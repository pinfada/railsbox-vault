// La FERMETURE et la RÉENTRANCE du magasin de la révocation (#310, #315, revue de sécurité de 8925e04).
//
// Le défaut : pendant le pré-vol, `masquer()` appelait `terminer()` puis rendait `true` ; le magasin
// affectait V et appelait `envoyer` sur une instance terminée. La sémantique écrite dans l'ADR 0049 :
//  - tout appel PUBLIC (`terminer`, `appliquer`, `modifier`, `definirLIndice`, `demarrer`) depuis un
//    exécuteur, pendant une transition, est REFUSÉ (TypeError) ;
//  - ET il INTERROMPT la transition en cours, même si l'exécuteur avale l'erreur : aucun lanceur
//    d'enveloppe (`envoyer`, `lancer`) ne part ensuite ; avant l'affectation, c'est un masquage non
//    établi (bascule e22) ; après, la modification renonce et relit (l'envoi ne peut pas suivre) ;
//  - `terminer()` hors transition est effectif et idempotent.
// Chaque cas : ZÉRO envoi, ZÉRO lancement.

import assert from "node:assert/strict";
import { test } from "node:test";

import { amener, fabriquer, tourner } from "./support-magasin-revocation.mjs";

/** Un magasin dont `masquer` et `oublier` sont pilotés par l'épreuve (qui tient le magasin). */
function piloter() {
  const pilote = { masquer: () => true, oublier: () => {}, f: null };
  pilote.f = fabriquer({ masquer: () => pilote.masquer(), oublier: () => pilote.oublier() });
  return pilote;
}

/** Les cinq appels publics qu'un exécuteur ne doit jamais pouvoir faire pendant une transition. */
const ATTAQUES = Object.freeze([
  ["terminer", (m) => m.terminer()],
  ["appliquer", (m) => m.appliquer({ type: "verrouiller" })],
  ["modifier", (m) => m.modifier(() => Promise.resolve())],
  ["definirLIndice", (m) => m.definirLIndice(true)],
  ["demarrer", (m) => m.demarrer()],
]);

/** Une attaque PROPAGÉE (l'exécuteur lève) ou AVALÉE (il rend quand même `true` / continue). */
const MANIERES = Object.freeze([
  ["propagée", (attaque, m) => attaque(m)],
  [
    "avalée",
    (attaque, m) => {
      try {
        attaque(m);
      } catch {
        // l'exécuteur ignore le refus : c'est exactement le cas que la revue a reproduit
      }
    },
  ],
]);

const SOURCES = Object.freeze([
  ["FL", "FE"],
  ["FC", "FE"],
  ["SL", "SE"],
  ["RL", "RE"],
  ["P", "SE"],
  ["C", "SE"],
  ["K", "RE"],
]);

for (const [nomAttaque, attaque] of ATTAQUES) {
  for (const [nomManiere, maniere] of MANIERES) {
    test(`[I23″] « Oui » : masquer appelle ${nomAttaque} (${nomManiere}) puis rend vrai → zéro envoi, état fermé`, async () => {
      const p = piloter();
      await amener(p.f, "C");
      p.masquer = () => {
        maniere(attaque, p.f.magasin);
        return true;
      };
      p.f.magasin.appliquer({ type: "oui" });
      await tourner();
      assert.equal(p.f.noms("envoyer").length, 0, "une révocation est partie malgré la violation");
      assert.equal(p.f.magasin.etat().phase, "SE", "l'état doit être l'état fermé de la bascule");
      assert.ok(!p.f.appels.some(([nom, phase]) => nom === "envoyer" && phase === "V"));
    });

    for (const [source, ferme] of SOURCES) {
      test(`[I23″] modification depuis ${source} : masquer appelle ${nomAttaque} (${nomManiere}) puis rend vrai → zéro lancement, ${ferme}`, async () => {
        const p = piloter();
        await amener(p.f, source);
        p.masquer = () => {
          maniere(attaque, p.f.magasin);
          return true;
        };
        let lances = 0;
        p.f.magasin.modifier(() => {
          lances += 1;
          return Promise.resolve();
        });
        await tourner();
        assert.equal(lances, 0, "une modification d'enveloppe est partie malgré la violation");
        assert.equal(p.f.magasin.etat().phase, ferme);
      });
    }

    test(`[I23″] C → SM [oublier, lancer] : oublier appelle ${nomAttaque} (${nomManiere}) → zéro lancement, la modification renonce et relit`, async () => {
      const p = piloter();
      await amener(p.f, "C");
      p.oublier = () => maniere(attaque, p.f.magasin);
      let lances = 0;
      p.f.magasin.modifier(() => {
        lances += 1;
        return Promise.resolve();
      });
      await tourner();
      assert.equal(lances, 0, "`lancer` est parti après un `oublier` qui a violé le verrou");
      assert.equal(
        p.f.magasin.etat().phase,
        "SL",
        "la modification doit renoncer et relire, pas rester en SM",
      );
      assert.equal(
        p.f.magasin.etat().lecture,
        p.f.magasin.etat().sequence,
        "la relecture n'a pas été lancée",
      );
    });
  }
}

test("[I23″] une violation ne CONTAMINE pas la transition suivante : un lancement légitime part ensuite", async () => {
  const p = piloter();
  await amener(p.f, "C");
  p.oublier = () => ATTAQUES[1][1](p.f.magasin);
  p.f.magasin.modifier(() => Promise.resolve());
  await tourner();
  p.oublier = () => {};
  const lecture = p.f.magasin.etat().lecture;
  await import("./support-magasin-revocation.mjs").then(({ lire }) => lire(p.f, lecture));
  assert.equal(p.f.magasin.etat().phase, "P");
  let lances = 0;
  p.f.magasin.modifier(() => {
    lances += 1;
    return Promise.resolve();
  });
  assert.equal(lances, 1, "la violation précédente a désarmé les lanceurs");
});

test("[terminer] hors transition : effectif et idempotent ; refusé et SANS effet sur l'instance pendant une transition", async () => {
  const f = fabriquer();
  let refus = null;
  const g = fabriquer({
    publier: () => {
      try {
        g.magasin.terminer();
      } catch (erreur) {
        refus = erreur;
      }
    },
  });
  await amener(g, "FC");
  assert.ok(refus instanceof TypeError, "`terminer` depuis un exécuteur doit être refusé");
  assert.equal(
    g.magasin.appliquer({ type: "verrouiller" }).accepte,
    true,
    "l'instance a été terminée par un refus",
  );
  f.magasin.terminer();
  f.magasin.terminer();
  assert.throws(() => f.magasin.demarrer(), TypeError);
});
