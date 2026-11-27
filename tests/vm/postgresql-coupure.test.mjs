// E2, au niveau du GUEST (#343) : un COMMIT que Rails a acquitté sur PostgreSQL survit à une coupure
// FRANCHE de la machine, puis le disque rouvert accepte l'écriture suivante.
//
// ## Ce que l'épreuve fait
//
// L'application témoin (`apps/rails-new-postgresql`, générée par `rails new -d postgresql`, non
// modifiée) reçoit une note par son formulaire. La machine est ARRÊTÉE dans le rappel même qui reçoit
// la première trame de la réponse (`@VLT1 RSB`) : Rails a rendu sa redirection, donc le COMMIT est
// acquitté, et aucune instruction du guest ne s'exécute plus. Le disque de données est un tampon en
// mémoire dans lequel v86 écrit directement : ce qu'il porte à l'arrêt est ce qu'une coupure de
// courant laisserait — ce qui est encore dans le cache de pages du guest est PERDU. Le même tampon
// reboote à froid, la note est relue, et une nouvelle note est écrite et coupée à son tour.
//
// ## Ce qu'elle prouve, et ce qu'elle ne prouve pas
//
// Elle prouve la moitié GUEST de la chaîne : PostgreSQL configuré par l'outil (ADR 0056) a poussé
// le WAL du commit jusqu'au disque AVANT que Rails réponde, et la reprise sur crash de PostgreSQL
// rend un cluster qui s'ouvre et qui écrit. Elle ne prouve PAS la moitié NAVIGATEUR — la barrière
// FLUSH CACHE devenue génération OPFS, le verrouillage, l'instantané écarté : c'est
// `tests/e2e/durabilite-postgresql.spec.mjs`, sur le modèle de `durabilite-du-commit.spec.mjs`.
// Sous Node, une barrière ne coûte rien et ne protège rien de plus : tout ce que le guest a écrit
// est déjà dans le tampon.

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
  attendreLesNotes,
  noteListee,
  pause,
  preparerUneNote,
} from "../../tools/vm/postgresql-temoin.mjs";

const BUDGET_BOOT_MS = Number.parseInt(process.env.VAULT_VM_BUDGET_MS ?? "1200000", 10);
const TOURS = 3;

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

/** Boote le tampon de données ; `coupure.armee` arrête la machine sur la première trame RSB. */
async function booter(manifeste, donnees, coupure) {
  const journal = [];
  let serie = "";
  let vm = null;
  vm = await demarrerVm({
    manifeste,
    donnees,
    surJournal: (ligne) => {
      journal.push(ligne);
      if (process.env.VAULT_VM_VERBEUX === "1") console.log(`[guest] ${ligne}`);
    },
    surSerie: (fragment) => {
      if (!coupure.armee || coupure.faite) return;
      serie = `${serie}${fragment}`.slice(-64);
      if (serie.includes("@VLT1 RSB ")) {
        vm.emulateur.stop();
        coupure.faite = true;
      }
    },
  });
  return { vm, journal };
}

const prepare = preparer();

test(
  "E2 (guest) : une note acquittée sur PostgreSQL survit à une coupure franche, puis le disque rouvert écrit",
  { skip: prepare.raison ?? false, timeout: (TOURS + 1) * (BUDGET_BOOT_MS + 120_000) },
  async () => {
    const { manifeste } = prepare;
    const donnees = new Uint8Array(readFileSync(join(DOSSIER_ARTEFACTS, manifeste.boot.graine)));
    const tableau = [];
    let precedente = null;

    for (let rang = 0; rang <= TOURS; rang += 1) {
      const coupure = { armee: false, faite: false };
      const { vm, journal } = await booter(manifeste, donnees, coupure);
      const ligne = { rang };
      try {
        ligne.attenteMs = await attendreLesNotes(vm, { delaiMs: BUDGET_BOOT_MS, journal });
        ligne.disque = journal.filter((texte) =>
          /disque de donnees : (erreurs|alertes)=/.test(texte),
        );
        if (precedente !== null) ligne.relue = await noteListee(vm, precedente);
        if (rang === TOURS) {
          tableau.push(ligne);
          break;
        }
        const libelle = `note durable PostgreSQL du tour ${rang} (#343)`;
        const soumission = await preparerUneNote(vm, libelle);
        coupure.armee = true;
        // La réponse ne reviendra jamais : la machine est arrêtée sur sa première trame.
        vm.requete("POST", "/notes", { ...soumission, delaiMs: 600_000 }).catch(() => {});
        const debut = Date.now();
        while (!coupure.faite) {
          if (Date.now() - debut > 300_000) throw new Error("POST /notes sans réponse en 300 s");
          await pause(50);
        }
        ligne.coupeeApresMs = Date.now() - debut;
        precedente = libelle;
      } finally {
        await vm.arreter();
      }
      tableau.push(ligne);
      assert.ok(
        journal.includes("[postgresql] reglages conformes"),
        `tour ${rang} : PostgreSQL n'a pas dit des réglages conformes`,
      );
    }

    process.stdout.write(`\n[postgresql-coupure] ${JSON.stringify(tableau)}\n`);
    assert.deepEqual(
      tableau.filter((ligne) => ligne.rang > 0 && ligne.relue !== true).map(({ rang }) => rang),
      [],
      "chaque note acquittée est relue après la coupure et le boot à froid",
    );
    for (const ligne of tableau) {
      assert.deepEqual(
        ligne.disque,
        ["[init] disque de donnees : erreurs=0", "[init] disque de donnees : alertes=0"],
        `tour ${ligne.rang} : le disque de données est monté sans erreur`,
      );
    }
  },
);
