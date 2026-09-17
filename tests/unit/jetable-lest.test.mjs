import assert from "node:assert/strict";
import test from "node:test";

// Épreuve JETABLE (suivi d'audit, remarque 2) : charge les modules sans appeler aucune de leurs
// fonctions, pour constater le chemin NÉGATIF du contrôle requis « Qualité et tests » — une
// « Couverture unitaire » qui échoue pendant que les autres contrôles restent verts.
// NE PAS FUSIONNER.
test("les modules jetables se chargent, sans qu'aucune de leurs fonctions soit appelée", async () => {
  for (let f = 0; f < 8; f++) {
    const module = await import(`../../src/jetable/lest-${f}.mjs`);
    assert.equal(typeof module[`lest${f * 45}`], "function");
  }
});
