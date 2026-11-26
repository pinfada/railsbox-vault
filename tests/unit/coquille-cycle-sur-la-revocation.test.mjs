// La LIAISON du cycle sur la table de la révocation (#265, C2-2 ; revue de #321, point 2) : le verrouillage
// consulte la table, et la décision est OBLIGATOIRE — un receveur qui ne la reçoit pas refuse de se brancher,
// et seul un `true` franc laisse passer. La liaison est construite dans `src/` pour que la campagne la mute.

import assert from "node:assert/strict";
import { test } from "node:test";

import { brancherLesGestesDuCycle } from "../../src/coquille/gestes-du-cycle.mjs";
import { brancherLeCycleSurLaRevocation } from "../../src/coquille/cycle-sur-la-revocation.mjs";
import { DECLENCHEURS } from "../../src/coquille/verrouillage.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";
import { monterLeCablage, SUCCES, tourner } from "./support-cablage.mjs";

function liaison() {
  const demandes = [];
  const racine = { querySelector: () => ({ addEventListener() {}, textContent: "" }) };
  return {
    demandes,
    liaison: {
      racine,
      demander: async (type) => {
        demandes.push(type);
        return { etat: "verrouille", barrieres: 0, capture: null };
      },
      cycle: { issueDe: () => null, conclure: () => {}, releve: () => [] },
      rapport: {},
      publier: () => {},
      avantVerrouillage: () => {},
      apresRefusDOrdre: () => {},
      apresRefusDeVerrouillage: () => {},
      apresVerrouillage: () => {},
      apresDemarrage: () => {},
    },
  };
}

test("[obligatoire] sans décision de la table, le cycle REFUSE de se brancher (aucune valeur par défaut permissive)", () => {
  const { liaison: l } = liaison();
  assert.throws(() => brancherLesGestesDuCycle(l), TypeError);
  assert.throws(() => brancherLesGestesDuCycle({ ...l, accepteLeVerrouillage: true }), TypeError);
  assert.throws(
    () => brancherLesGestesDuCycle({ ...l, accepteLeVerrouillage: undefined }),
    TypeError,
  );
});

test("[obligatoire] seul un `true` franc laisse passer : faux, indéfini, texte, objet refusent", async () => {
  for (const reponse of [false, undefined, null, "oui", 1, {}]) {
    const { liaison: l, demandes } = liaison();
    const gestes = brancherLesGestesDuCycle({ ...l, accepteLeVerrouillage: () => reponse });
    const rendu = await gestes.verrouillerLeCoffre(DECLENCHEURS.geste);
    assert.equal(rendu.verrouille, false, `${String(reponse)} : refusé`);
    assert.equal(rendu.code, CODES_REFUS_COQUILLE.etapeHorsOrdre);
    assert.deepEqual(demandes, [], "le Worker n'est pas sollicité");
  }
  const { liaison: l } = liaison();
  const gestes = brancherLesGestesDuCycle({ ...l, accepteLeVerrouillage: () => true });
  assert.equal((await gestes.verrouillerLeCoffre(DECLENCHEURS.geste)).verrouille, true);
});

test("[liaison] la table de la révocation REELLE ferme le verrouillage pendant l'envoi, l'ouvre ailleurs", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  const { liaison: l, demandes } = liaison();
  const gestes = brancherLeCycleSurLaRevocation({ ...l, revocation: p.cablage });
  assert.equal(
    (await gestes.verrouillerLeCoffre(DECLENCHEURS.geste)).verrouille,
    true,
    "en P : ouvert",
  );
  p.clic("revoquer-en-urgence");
  await tourner();
  p.clic("revocation-oui");
  assert.equal(p.cablage.etat().phase, "V");
  demandes.length = 0;
  const refuse = await gestes.verrouillerLeCoffre(DECLENCHEURS.geste);
  assert.equal(refuse.verrouille, false, "en V : refusé");
  assert.equal(refuse.horsOrdre, true);
  assert.deepEqual(demandes, [], "la fermeture n'est jamais demandée au Worker pendant l'envoi");
  p.attentes.revoquerEnUrgence[0].resoudre(SUCCES);
  await tourner();
});

test("[liaison] pendant une MODIFICATION de l'enveloppe, le verrouillage est refusé de même", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  p.cablage.modifier(() => new Promise(() => {}));
  assert.equal(p.cablage.etat().phase, "SM");
  const { liaison: l, demandes } = liaison();
  const gestes = brancherLeCycleSurLaRevocation({ ...l, revocation: p.cablage });
  assert.equal((await gestes.verrouillerLeCoffre(DECLENCHEURS.geste)).verrouille, false);
  assert.deepEqual(demandes, []);
});

test("[liaison] une `accepteLeVerrouillage` passée par l'appelant ne contourne pas la table", async () => {
  const p = monterLeCablage();
  await p.jusquAP();
  p.cablage.modifier(() => new Promise(() => {}));
  const { liaison: l } = liaison();
  const gestes = brancherLeCycleSurLaRevocation({
    ...l,
    revocation: p.cablage,
    accepteLeVerrouillage: () => true,
  });
  assert.equal((await gestes.verrouillerLeCoffre(DECLENCHEURS.geste)).verrouille, false);
});
