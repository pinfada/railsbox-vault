import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { REPERES_SERIE } from "../../src/vm/decomposition-du-boot.mjs";

// Les repères de la décomposition du boot (#60) sont des lignes que `guest-init.sh` IMPRIME. Un
// repère que l'init n'imprime plus ne lève aucune erreur : son jalon reste `null`, et la mesure
// perd une durée sans que personne ne le voie. C'est arrivé avec T1 (#236) : l'init a renommé
// « montage du disque applicatif » en « montage du paquet applicatif » et « montage du disque de
// donnees », et `noyauVersMontageMs` est resté `null` dans les rapports de la recette.

const RACINE = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const INIT = readFileSync(
  join(RACINE, "tools", "build-reference-image", "guest", "guest-init.sh"),
  "utf8",
);

/** Les lignes que l'init écrit sur la console par `echo "…"`. */
const LIGNES_IMPRIMEES = [...INIT.matchAll(/^\s*echo "([^"]*)"/gm)].map(([, ligne]) => ligne);

test("chaque repère de la décomposition du boot est une ligne que l'init imprime", () => {
  assert.ok(REPERES_SERIE.length > 0);
  for (const [cle, aiguille] of REPERES_SERIE) {
    assert.ok(
      LIGNES_IMPRIMEES.some((ligne) => ligne.startsWith(aiguille)),
      `le repère ${cle} (« ${aiguille} ») n'est imprimé par aucune ligne de guest-init.sh`,
    );
  }
});
