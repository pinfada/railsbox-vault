// Épreuve d'intégration : boote réellement l'image de référence sous v86 et
// vérifie l'invariant durable après un boot À FROID, sans instantané.
//
// Deux règles gouvernent ce fichier :
//
//   1. il ne réussit jamais sans avoir booté. Si les artefacts ne sont pas là,
//      il se déclare `skipped` avec la raison exacte ; il ne rend jamais un
//      succès qui n'a rien mesuré ;
//   2. un artefact présent mais différent du manifeste est un ÉCHEC, pas une
//      indisponibilité : le manifeste est la référence versionnée, et booter
//      autre chose que ce qu'il décrit ne prouverait rien.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import {
  comparerArtefacts,
  validerManifeste,
} from "../../tools/build-reference-image/manifest-contract.mjs";
import {
  CHEMIN_MANIFESTE,
  DOSSIER_ARTEFACTS,
  RACINE_DEPOT,
  demarrerVm,
  empreintesObservees,
  raisonDIndisponibilite,
} from "../../tools/vm/boot-reference.mjs";

/** Budget de boot à froid. `docs/quality-attributes.md` vise p95 ≤ 15 min. */
const BUDGET_BOOT_MS = Number.parseInt(process.env.VAULT_VM_BUDGET_MS ?? "1200000", 10);

/** Marge au-delà du budget pour laisser la suite rendre un diagnostic. */
const DELAI_EPREUVE_MS = BUDGET_BOOT_MS + 300_000;

const DOSSIER_RAPPORTS = join(RACINE_DEPOT, "reports", "vm");

/**
 * @returns {Promise<{ manifeste: Record<string, any> } | { raison: string }>}
 */
async function preparer() {
  const raison = raisonDIndisponibilite();
  if (raison !== null) return { raison };

  const manifeste = JSON.parse(await readFile(CHEMIN_MANIFESTE, "utf8"));
  const anomalies = validerManifeste(manifeste);
  assert.deepEqual(
    anomalies,
    [],
    `manifeste invalide :\n${anomalies.map((a) => `  · ${a.message}`).join("\n")}`,
  );

  const absents = manifeste.artifacts
    .map((artefact) => artefact.name)
    .filter((nom) => !existsSync(join(DOSSIER_ARTEFACTS, nom)));
  if (absents.length > 0) {
    return { raison: `artefacts absents (${absents.join(", ")}) : « npm run image:build »` };
  }

  const differences = comparerArtefacts(manifeste, await empreintesObservees(manifeste));
  assert.deepEqual(
    differences,
    [],
    `les artefacts sur disque ne sont pas ceux du manifeste :\n${differences
      .map((difference) => `  · ${difference.message}`)
      .join("\n")}`,
  );

  return { manifeste };
}

test(
  "l'image de référence boote à froid, expose sa santé et rend un invariant conforme",
  { timeout: DELAI_EPREUVE_MS },
  async (t) => {
    const prepare = await preparer();
    if ("raison" in prepare) {
      t.skip(prepare.raison);
      return;
    }
    const { manifeste } = prepare;

    const journal = [];
    const vm = await demarrerVm({
      manifeste,
      surJournal: (ligne) => {
        journal.push(ligne);
        if (process.env.VAULT_VM_VERBEUX === "1") console.log(`[guest] ${ligne}`);
      },
    });

    try {
      const { dureeMs, sante } = await vm.attendreSante({ delaiTotalMs: BUDGET_BOOT_MS });

      assert.equal(sante.app.id, manifeste.application.id);
      assert.equal(sante.app.version, manifeste.application.version);
      assert.equal(sante.ruby, manifeste.toolchain.ruby);
      assert.equal(sante.rails, manifeste.toolchain.rails);
      assert.equal(sante.database.adapter, "sqlite");
      assert.match(sante.database.version, /^\d+\.\d+/);
      assert.match(sante.schema.version, /^\d{14}$/);

      const reponse = await vm.requete("GET", "/vault/invariant");
      assert.equal(reponse.statut, 200, `/vault/invariant a répondu ${reponse.statut}`);
      const verdict = JSON.parse(new TextDecoder().decode(reponse.corps));
      assert.equal(verdict.status, "conforming");
      assert.deepEqual(verdict.differences, []);
      assert.equal(verdict.observed.record.id, manifeste.application.invariantRecordId);
      assert.equal(verdict.observed.attachment.sha256, manifeste.application.attachmentSha256);
      assert.equal(verdict.expected.attachment.sha256, manifeste.application.attachmentSha256);

      // Deux appels, même verdict : la vérification ne modifie pas ce qu'elle
      // observe.
      const second = await vm.requete("GET", "/vault/invariant");
      assert.equal(second.statut, 200);
      assert.deepEqual(
        JSON.parse(new TextDecoder().decode(second.corps)).observed,
        verdict.observed,
      );

      assert.ok(
        dureeMs <= BUDGET_BOOT_MS,
        `boot à froid en ${Math.round(dureeMs / 1000)} s, budget ${Math.round(BUDGET_BOOT_MS / 1000)} s`,
      );

      mkdirSync(DOSSIER_RAPPORTS, { recursive: true });
      writeFileSync(
        join(DOSSIER_RAPPORTS, "reference-boot.json"),
        `${JSON.stringify(
          {
            mesureLe: new Date().toISOString(),
            manifeste: {
              generatedAt: manifeste.generatedAt,
              totalByteSize: manifeste.totals.byteSize,
            },
            environnement: {
              node: process.versions.node,
              platform: `${process.platform} ${process.arch}`,
            },
            bootFroidMs: dureeMs,
            sante,
            invariant: verdict.status,
            lignesDeJournal: journal.length,
          },
          null,
          2,
        )}\n`,
        "utf8",
      );
      console.log(`boot à froid mesuré : ${Math.round(dureeMs / 1000)} s`);
    } finally {
      await vm.arreter();
    }
  },
);
