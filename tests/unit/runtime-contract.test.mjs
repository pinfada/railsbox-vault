import assert from "node:assert/strict";
import test from "node:test";

import { RUNTIME_CONTRACT } from "../../src/runtime-contract.mjs";

test("le contrat du harnais possède une version et un identifiant stables", () => {
  assert.deepEqual(RUNTIME_CONTRACT, {
    id: "railsbox-vault-browser-harness",
    version: 1,
  });
});
