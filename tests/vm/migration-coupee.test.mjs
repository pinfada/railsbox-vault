// La MISE À JOUR du paquet, jouée sur l'image réelle sous Node — et COUPÉE entre deux migrations
// (#236 T2, ADR 0042 ; amendement D du superviseur).
//
// Le paquet 1.1.0 porte DEUX migrations. Rails les commite une à une : une coupure entre les deux
// laisse la base à un schéma INTERMÉDIAIRE, que le marqueur `.vault-schema` ne dit pas (il n'avance
// qu'à la fin). Ce que l'épreuve exige, sur trois boots d'un même disque de données :
//
//   A. la graine 1.0.0, bootée sous le paquet 1.1.0 : l'intention `.vault-migration` est écrite et
//      rendue durable, la première migration est commise — et la machine est ARRÊTÉE net, sans rien
//      synchroniser, à l'instant où le guest le dit. Ce que le tampon du disque porte alors est ce
//      qu'une coupure de courant laisserait ;
//   B. le même disque, bootée sous le paquet 1.0.0 (le « Plus tard » qu'on aurait pu tenter) : le guest
//      REFUSE de lancer Rails — « REFUS anterieur … intention=N » —, l'ancien code ne touche pas des
//      données peut-être intermédiaires ;
//   C. le même disque, sous 1.1.0 : la mise à jour REPREND, le schéma final est N, l'intention a
//      disparu, et l'invariant écrit à la construction de la graine est relu intact.
//
// L'arrêt est celui de l'émulateur, dans le rappel même qui reçoit l'octet de fin de ligne : aucune
// instruction du guest ne s'exécute après. C'est une coupure franche, plus dure que l'injecteur de
// fautes du support (ADR 0014), qui coupe entre deux ÉCRITURES acquittées.

import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { creerVeilleurDeSchema } from "../../src/vm/constat-de-schema.mjs";
import {
  CHEMIN_MANIFESTE,
  DOSSIER_ARTEFACTS,
  demarrerVm,
  raisonDIndisponibilite,
} from "../../tools/vm/boot-reference.mjs";

/** Budget d'un boot qui MIGRE : Rails se charge deux fois. */
const BUDGET_BOOT_MS = Number.parseInt(process.env.VAULT_VM_BUDGET_MS ?? "1500000", 10);

/** Un boot qui refuse le dit avant Rails : il n'a pas besoin du budget d'un boot entier. */
const BUDGET_REFUS_MS = 600_000;

function preparer() {
  const raison = raisonDIndisponibilite();
  if (raison !== null) return { raison };
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  if (manifeste.precedent === undefined) {
    return { raison: "aucun paquet précédent dans le manifeste : « npm run image:build »" };
  }
  const graine = join(DOSSIER_ARTEFACTS, manifeste.precedent.graine);
  if (!existsSync(graine)) return { raison: `graine précédente absente (${graine})` };
  return { manifeste, graine };
}

/** Boote, guette le constat de schéma, et rend le veilleur et la VM. */
async function booter({ manifeste, paquet, donnees, schemaAttendu, surLigne = () => {} }) {
  const veilleur = creerVeilleurDeSchema();
  let vm = null;
  vm = await demarrerVm({
    manifeste,
    paquet,
    donnees,
    cmdlineEnPlus: `vault.schema=${schemaAttendu}`,
    surSerie: (fragment) => {
      veilleur.ingererSerie(fragment);
      surLigne(veilleur.constat(), vm);
      if (process.env.VAULT_VM_VERBEUX === "1") process.stdout.write(fragment);
    },
  });
  return { vm, veilleur };
}

/** Attend qu'un prédicat sur le constat devienne vrai, borné. */
async function attendre(veilleur, predicat, delaiMs, libelle) {
  const debut = Date.now();
  while (!predicat(veilleur.constat())) {
    if (Date.now() - debut > delaiMs) {
      throw new Error(
        `${libelle} : rien en ${delaiMs} ms ; constat ${JSON.stringify(veilleur.constat())}`,
      );
    }
    await new Promise((resoudre) => setTimeout(resoudre, 500));
  }
}

const prepare = preparer();

test(
  "mise à jour COUPÉE entre deux migrations : l'ancien paquet est refusé, la reprise aboutit à N",
  { skip: prepare.raison ?? false, timeout: 3 * BUDGET_BOOT_MS + BUDGET_REFUS_MS },
  async () => {
    const { manifeste } = prepare;
    const M = manifeste.precedent.application.schema;
    const N = manifeste.application.schema;
    assert.ok(N > M, `le paquet courant (${N}) doit dépasser le précédent (${M})`);
    const donnees = new Uint8Array(readFileSync(prepare.graine));

    // A — la coupure, dans le rappel qui reçoit la ligne « migrated » de la PREMIÈRE migration.
    let coupeA = null;
    const a = await booter({
      manifeste,
      paquet: manifeste.boot.paquet,
      donnees,
      schemaAttendu: M,
      surLigne: (constat, vm) => {
        if (coupeA !== null || vm === null || (constat?.commises.length ?? 0) < 1) return;
        vm.emulateur.stop();
        coupeA = { ...constat };
      },
    });
    try {
      await attendre(
        a.veilleur,
        () => coupeA !== null,
        BUDGET_BOOT_MS,
        "A : aucune migration commise",
      );
    } finally {
      await a.vm.arreter();
    }
    assert.equal(coupeA.volume, M, "la graine 1.0.0 part du schéma M");
    assert.equal(coupeA.intention, null, "aucune intention avant la mise à jour");
    assert.equal(coupeA.migration, null, "coupé AVANT la fin : aucune migration « jouée »");

    // B — l'ancien paquet sur ces données : REFUS, Rails n'est pas lancé.
    const b = await booter({
      manifeste,
      paquet: manifeste.precedent.paquet,
      donnees,
      schemaAttendu: M,
    });
    try {
      await assert.rejects(
        Promise.race([
          b.veilleur.refus,
          new Promise((_, rejeter) =>
            setTimeout(() => rejeter(new Error("B : aucun refus")), BUDGET_REFUS_MS),
          ),
        ]),
        (erreur) => erreur.motifDeSchema === "anterieur",
      );
    } finally {
      await b.vm.arreter();
    }
    assert.equal(b.veilleur.constat().intention, N, "l'intention a survécu à la coupure");
    assert.equal(b.veilleur.constat().volume, M, "le marqueur n'avance qu'à la fin");

    // C — le paquet 1.1.0 REPREND : schéma final N, données relues.
    const c = await booter({
      manifeste,
      paquet: manifeste.boot.paquet,
      donnees,
      schemaAttendu: M,
    });
    try {
      const { sante } = await c.vm.attendreSante({ delaiTotalMs: BUDGET_BOOT_MS });
      assert.equal(sante.schema.version, N);
      assert.equal(sante.app.version, manifeste.application.version);
      const constat = c.veilleur.constat();
      assert.equal(constat.intention, N, "la reprise voit l'intention laissée par la coupure");
      assert.equal(constat.migration?.jouee, true);
      assert.equal(constat.migration.vers, N);
      const reponse = await c.vm.requete("GET", "/vault/invariant");
      assert.equal(reponse.statut, 200);
      const verdict = JSON.parse(new TextDecoder().decode(reponse.corps));
      assert.equal(verdict.observed.record.id, manifeste.application.invariantRecordId);
      assert.equal(verdict.observed.attachment.sha256, manifeste.application.attachmentSha256);
      console.log(
        `coupure après ${coupeA.commises.length} migration(s) commise(s) ; ` +
          `reprise en ${constat.migration.ms} ms`,
      );
    } finally {
      await c.vm.arreter();
    }
  },
);
