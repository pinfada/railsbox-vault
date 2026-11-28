// La SONDE DE DÉMARRAGE : prêt = Rails répond, quelle que soit sa réponse (#351).
//
// La coquille attendait `/vault/health` en 200 et en JSON, une route que seule l'application de
// référence possède : une application extérieure n'était jamais « prête », et la personne lisait
// après cinq minutes « sans cause identifiée ». Ici, toute réponse HTTP rendue par Rails vaut
// « prêt » ; le pont série, lui, dit par une ERREUR qu'il n'a rien joint. Et un échec dit sa cause.

import assert from "node:assert/strict";
import test from "node:test";

import {
  CHEMIN_DE_LA_SONDE,
  MARQUE_D_ARRET,
  attendreQueRailsReponde,
  causeDuDemarrage,
} from "../../src/vm/sonde-de-demarrage.mjs";

const texte = (objet) => new TextEncoder().encode(JSON.stringify(objet));
const sansPause = () => Promise.resolve();

/** Une requête simulée qui rend, dans l'ordre, les issues données (erreur ou réponse). */
function requeteSimulee(issues) {
  const demandes = [];
  return {
    demandes,
    requete: async (methode, chemin) => {
      demandes.push(`${methode} ${chemin}`);
      const issue = issues[Math.min(demandes.length - 1, issues.length - 1)];
      if (issue instanceof Error) throw issue;
      return issue;
    },
  };
}

test("une réponse 404 de Rails vaut « prêt » : la sonde ne dépend d'aucune route", async () => {
  const { requete, demandes } = requeteSimulee([
    new Error("le pont a refusé la requête : application-injoignable (code 7)"),
    { statut: 404, entetes: { "content-type": "text/html" }, corps: new Uint8Array() },
  ]);
  const rendu = await attendreQueRailsReponde({
    requete,
    totalTimeoutMs: 2_000,
    pause: sansPause,
    lignes: () => [],
  });
  assert.equal(rendu.sante, null);
  assert.equal(demandes.length, 2);
  assert.equal(demandes[0], `GET ${CHEMIN_DE_LA_SONDE}`);
});

test("la référence garde sa santé : un 200 JSON est rendu tel quel", async () => {
  const { requete } = requeteSimulee([
    { statut: 200, entetes: {}, corps: texte({ app: { id: "reference" } }) },
  ]);
  const rendu = await attendreQueRailsReponde({
    requete,
    totalTimeoutMs: 60_000,
    pause: sansPause,
    lignes: () => [],
  });
  assert.deepEqual(rendu.sante, { app: { id: "reference" } });
});

test("un 200 qui n'est pas du JSON est une réponse, sans santé", async () => {
  const { requete } = requeteSimulee([
    { statut: 200, entetes: {}, corps: new TextEncoder().encode("<html>") },
  ]);
  const rendu = await attendreQueRailsReponde({
    requete,
    totalTimeoutMs: 60_000,
    pause: sansPause,
    lignes: () => [],
  });
  assert.equal(rendu.sante, null);
});

test(
  "une application ARRÊTÉE fait échouer tout de suite, avec sa cause en clair",
  { timeout: 10_000 },
  async () => {
    const lignes = [
      "bin/rails:4: ArgumentError: Missing `secret_key_base` for 'production' environment",
      `${MARQUE_D_ARRET} (code 1)`,
    ];
    const { requete } = requeteSimulee([
      new Error("le pont a refusé la requête : application-injoignable (code 7)"),
    ]);
    // Une horloge SIMULÉE : chaque pause avance le temps de l'intervalle, sans rien attendre.
    let instant = 0;
    await assert.rejects(
      attendreQueRailsReponde({
        requete,
        totalTimeoutMs: 300_000,
        intervalMs: 2_000,
        pause: async (ms) => {
          instant += ms;
        },
        maintenant: () => instant,
        lignes: () => lignes,
      }),
      (erreur) => {
        assert.match(erreur.causeEnClair, /s'est arrêtée pendant son démarrage/);
        assert.match(erreur.causeEnClair, /secret_key_base/);
        return true;
      },
    );
    assert.equal(instant, 0, "sans attendre le délai : aucune pause après l'arrêt");
  },
);

test("le délai dépassé dit la dernière erreur de la sonde et la dernière ligne du guest", async () => {
  const { requete } = requeteSimulee([
    new Error("le pont a refusé la requête : application-injoignable (code 7)"),
  ]);
  await assert.rejects(
    attendreQueRailsReponde({
      requete,
      totalTimeoutMs: 1,
      intervalMs: 5,
      pause: (ms) => new Promise((resoudre) => setTimeout(resoudre, ms)),
      lignes: () => ["Puma starting in single mode...", "* Booting Rails"],
    }),
    (erreur) => {
      assert.match(erreur.causeEnClair, /n'a pas répondu/);
      assert.match(erreur.causeEnClair, /rien n'écoutait/);
      assert.match(erreur.causeEnClair, /Booting Rails/);
      return true;
    },
  );
});

test("la cause reconnaît les fins de ligne Windows et le verrou sans la plateforme", () => {
  assert.match(
    causeDuDemarrage({ arretee: true, lignes: ["/usr/bin/env: 'ruby\r': No such file"] }),
    /fins de ligne Windows/,
  );
  assert.match(
    causeDuDemarrage({
      arretee: true,
      lignes: ["Could not find nokogiri-1.18.9 in locally installed gems (Bundler::GemNotFound)"],
    }),
    /gemme/,
  );
});

test("la cause est bornée et ne porte aucun caractère de contrôle", () => {
  const cause = causeDuDemarrage({
    arretee: true,
    lignes: [`RuntimeError: ${"x".repeat(5_000)}\u0007\u001b[31m`],
  });
  assert.ok(cause.length <= 600, `${cause.length} caractères`);
  // eslint-disable-next-line no-control-regex
  assert.doesNotMatch(cause, /[\u0000-\u001f\u007f]/);
});
