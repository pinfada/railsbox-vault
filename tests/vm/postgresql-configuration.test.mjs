// E1 (#343), sur l'image RÉELLE : la configuration de PostgreSQL relue sur la connexion de
// l'application, dans le guest, après un boot à froid.
//
// L'épreuve unitaire (`tests/unit/postgresql-durable.test.mjs`) lit des FICHIERS. Celle-ci lit ce que
// le serveur APPLIQUE : le guest se connecte avec le `DATABASE_URL` que l'outil fournit à Rails — le
// même rôle, la même base, donc les mêmes `ALTER ROLE … SET` et `ALTER DATABASE … SET` —, demande
// `SHOW fsync, synchronous_commit, full_page_writes, wal_sync_method, data_checksums`, et le dit sur
// la série. Un `postgresql.auto.conf` écrit dans le volume, un réglage par rôle ou un cluster
// initialisé sans sommes de contrôle se verraient ici, et nulle part ailleurs.
//
// Elle exige que le paquet SERVI soit l'application témoin `apps/rails-new-postgresql` ; sinon elle
// se déclare ignorée et dit le geste qui manque. Elle n'a pas besoin que Rails réponde : la ligne est
// dite AVANT le lancement de l'application, qui n'a lieu que si elle est conforme.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import {
  CHEMIN_MANIFESTE,
  DOSSIER_ARTEFACTS,
  demarrerVm,
  raisonDIndisponibilite,
} from "../../tools/vm/boot-reference.mjs";
import {
  GESTE_DU_TEMOIN,
  ID_DU_TEMOIN,
  METHODES_DURABLES,
  REGLAGES_ATTENDUS,
  attendreLigne,
  reglagesLus,
} from "../../tools/vm/postgresql-temoin.mjs";

const BUDGET_MS = Number.parseInt(process.env.VAULT_VM_BUDGET_MS ?? "900000", 10);

function preparer() {
  const raison = raisonDIndisponibilite();
  if (raison !== null) return { raison };
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  if (manifeste.application?.id !== ID_DU_TEMOIN) {
    return {
      raison: `le paquet servi est ${manifeste.application?.id ?? "inconnu"}, pas le témoin PostgreSQL : ${GESTE_DU_TEMOIN}`,
    };
  }
  return { manifeste };
}

const prepare = preparer();

test(
  "E1 : PostgreSQL tourne avec fsync, synchronous_commit, full_page_writes et sommes de contrôle, relus sur la connexion réelle",
  { skip: prepare.raison ?? false, timeout: BUDGET_MS + 60_000 },
  async () => {
    const { manifeste } = prepare;
    const journal = [];
    const donnees = new Uint8Array(readFileSync(join(DOSSIER_ARTEFACTS, manifeste.boot.graine)));
    const vm = await demarrerVm({
      manifeste,
      donnees,
      surJournal: (ligne) => {
        journal.push(ligne);
        if (process.env.VAULT_VM_VERBEUX === "1") console.log(`[guest] ${ligne}`);
      },
    });
    try {
      await attendreLigne(journal, /^\[postgresql\] (reglages conformes|REFUS)/, BUDGET_MS);
      const lus = reglagesLus(journal);
      assert.notEqual(lus, null, "le guest n'a pas dit les réglages relus par SHOW");
      for (const [nom, attendu] of Object.entries(REGLAGES_ATTENDUS)) {
        assert.equal(lus[nom], attendu, `SHOW ${nom}`);
      }
      assert.ok(
        METHODES_DURABLES.includes(lus.wal_sync_method),
        `SHOW wal_sync_method = ${lus.wal_sync_method}`,
      );
      assert.ok(
        journal.includes("[postgresql] reglages conformes"),
        journal.filter((ligne) => ligne.startsWith("[postgresql]")).join("\n"),
      );
      await attendreLigne(journal, /^\[init\] lancement de l'application$/, 60_000);
    } finally {
      await vm.arreter();
    }
  },
);
