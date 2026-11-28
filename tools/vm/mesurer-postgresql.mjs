#!/usr/bin/env node
// Les MESURES E6 de #343, sous Node, sur l'image réelle et l'application témoin PostgreSQL :
//
//   node tools/vm/mesurer-postgresql.mjs [--ecritures=5]
//
// Ce qu'elle mesure, et comment :
//
//  - la MÉMOIRE du guest, par `guest/mesure-memoire.sh` (armé par `vault.mesure-memoire=1`) : PSS et
//    RSS des processus `postgres`, PSS de Rails, mémoire utilisée du guest, au repos puis sous les
//    premières requêtes ;
//  - le DÉMARRAGE à froid : du lancement de l'émulateur au serveur prêt (`[postgresql] pret`), puis à
//    la première réponse 200 de `/notes` ;
//  - les BARRIÈRES par écriture : les commandes FLUSH CACHE que le guest adresse au disque de données
//    pendant un POST acquitté. Le pont de durabilité est posé en mode `identify` : le disque annonce
//    un cache d'écriture, donc le noyau du guest émet ses FLUSH exactement comme dans le navigateur,
//    où chacun devient UNE génération validée dans l'OPFS (mode `full`, ADR 0004). Sous Node, la
//    barrière est acquittée par v86 sans rien coûter : on compte, on ne chronomètre pas l'OPFS.
//
// Elle ne mesure PAS l'onglet : le pic mémoire du navigateur se lit dans la coquille réelle, ce que
// `tests/e2e/durabilite-postgresql.spec.mjs` ne peut faire qu'avec #351.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { BlockJournal, JOURNAL_OPERATIONS } from "../../src/vm/block-journal.mjs";
import { ATA, BRIDGE_MODES, installDurabilityBridge } from "../../src/vm/v86-flush-bridge.mjs";
import {
  CHEMIN_MANIFESTE,
  DOSSIER_ARTEFACTS,
  RACINE_DEPOT,
  demarrerVm,
} from "./boot-reference.mjs";
import {
  GESTE_DU_TEMOIN,
  ID_DU_TEMOIN,
  attendreLesNotes,
  noteListee,
  pause,
  preparerUneNote,
} from "./postgresql-temoin.mjs";

const ecritures = Number.parseInt(
  process.argv.find((argument) => argument.startsWith("--ecritures="))?.split("=")[1] ?? "5",
  10,
);

/** Les relevés `[mesure] memoire …`, en nombres. */
function relevesDeMemoire(journal) {
  return journal
    .filter((ligne) => ligne.includes("[mesure] memoire"))
    .map((ligne) =>
      Object.fromEntries(
        [...ligne.matchAll(/(\w+)=([\d.]+)/g)].map(([, cle, valeur]) => [cle, Number(valeur)]),
      ),
    );
}

const maximum = (releves, cle) => Math.max(...releves.map((releve) => releve[cle] ?? 0));

/** Les FLUSH CACHE adressés au disque de données depuis l'entrée `depuis` du journal. */
function barrieresDepuis(journalDeBlocs, depuis) {
  return journalDeBlocs
    .entries()
    .filter(
      (entree) =>
        entree.seq >= depuis &&
        entree.operation === JOURNAL_OPERATIONS.ata &&
        (entree.command === ATA.cmdFlushCache || entree.command === ATA.cmdFlushCacheExt),
    ).length;
}

async function mesurer() {
  const manifeste = JSON.parse(readFileSync(CHEMIN_MANIFESTE, "utf8"));
  if (manifeste.application?.id !== ID_DU_TEMOIN) {
    throw new Error(`le paquet servi n'est pas le témoin PostgreSQL : ${GESTE_DU_TEMOIN}`);
  }
  const journal = [];
  const horodatages = new Map();
  const donnees = new Uint8Array(readFileSync(join(DOSSIER_ARTEFACTS, manifeste.boot.graine)));
  const vm = await demarrerVm({
    manifeste,
    donnees,
    autostart: false,
    cmdlineEnPlus: "vault.mesure-memoire=1",
    surJournal: (ligne) => {
      journal.push(ligne);
      for (const repere of ["[postgresql] pret", "[init] lancement de l'application"]) {
        if (ligne.startsWith(repere) && !horodatages.has(repere)) {
          horodatages.set(repere, Date.now());
        }
      }
      if (process.env.VAULT_VM_VERBEUX === "1") console.log(`[guest] ${ligne}`);
    },
  });
  await vm.attendrePret();
  const ide = vm.emulateur.v86.cpu.devices.ide;
  const journalDeBlocs = new BlockJournal({ limit: 5_000_000 });
  installDurabilityBridge({
    ideController: ide,
    adapter: ide.primary.slave.buffer,
    journal: journalDeBlocs,
    mode: BRIDGE_MODES.identify,
  });
  const depart = Date.now();
  vm.emulateur.run();
  try {
    const attenteMs = await attendreLesNotes(vm, { delaiMs: 1_200_000, journal });
    const pret = Date.now();
    const pretLigne = journal.find((ligne) => ligne.startsWith("[postgresql] pret"));
    // Au REPOS : trente secondes sans requête, après la première réponse.
    await pause(30_000);
    const auRepos = relevesDeMemoire(journal).at(-1);
    const barrieres = [];
    for (let rang = 0; rang < ecritures; rang += 1) {
      const libelle = `note de mesure ${rang} (#343)`;
      const soumission = await preparerUneNote(vm, libelle);
      const depuis = journalDeBlocs.length;
      const debut = Date.now();
      const reponse = await vm.requete("POST", "/notes", soumission);
      barrieres.push({
        rang,
        statut: reponse.statut,
        flush: barrieresDepuis(journalDeBlocs, depuis),
        ms: Date.now() - debut,
      });
      if (!(await noteListee(vm, libelle))) throw new Error(`note ${rang} non relue`);
    }
    await pause(10_000);
    const releves = relevesDeMemoire(journal);
    return {
      mesureLe: new Date().toISOString(),
      environnement: {
        node: process.versions.node,
        platform: `${process.platform} ${process.arch}`,
      },
      guestMemoireMiB: manifeste.boot.memoryMiB,
      demarrage: {
        jusquAuServeurPretMs: (horodatages.get("[postgresql] pret") ?? NaN) - depart,
        serveurPret: pretLigne ?? null,
        jusquALApplicationLanceeMs:
          (horodatages.get("[init] lancement de l'application") ?? NaN) - depart,
        jusquAPremiereReponseMs: pret - depart,
        attenteDeLaSondeMs: attenteMs,
      },
      memoireKio: {
        auRepos,
        pic: {
          guest_utilise: maximum(releves, "guest_utilise"),
          postgres_pss: maximum(releves, "postgres_pss"),
          postgres_rss: maximum(releves, "postgres_rss"),
          rails_pss: maximum(releves, "rails_pss"),
        },
        releves: releves.length,
      },
      barrieresParEcriture: barrieres,
    };
  } finally {
    await vm.arreter();
  }
}

const rapport = await mesurer();
mkdirSync(join(RACINE_DEPOT, "reports", "vm"), { recursive: true });
writeFileSync(
  join(RACINE_DEPOT, "reports", "vm", "mesures-postgresql.json"),
  `${JSON.stringify(rapport, null, 2)}\n`,
);
process.stdout.write(`${JSON.stringify(rapport, null, 2)}\n`);
