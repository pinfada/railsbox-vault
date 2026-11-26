#!/usr/bin/env node
// LES ATTESTATIONS de lot de la CI (#328, refus de la relecture 2 de #329).
//
// Le résultat AGRÉGÉ d'une matrice GitHub (`needs.<job>.result`) ne prouve pas que chaque entrée a été
// jouée : GitHub ne garantit pas de décompte par entrée. Chaque lot de mutation et chaque tranche
// navigateur dépose donc une ATTESTATION distincte (son numéro, ce qu'il a joué, ses comptes), et le job
// agrégé télécharge tout et EXIGE exactement les attendus, chacun une seule fois, non vide, sans échec.
//
//     node tools/attestations-ci.mjs attester mutations <lot> <rapport.json>        # réécrit le rapport
//     node tools/attestations-ci.mjs attester navigateur <tranche> <rapport-playwright.json> <sortie.json>
//     node tools/attestations-ci.mjs verifier mutations|navigateur <dossier>        # code 1 au moindre écart

import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { LOTS } from "./rejouer-les-campagnes.mjs";

/** Nombre de tranches Playwright de `check-navigateur` ; `ci.yml` le garde (matrice `shard`). */
export const TRANCHES_NAVIGATEUR = 2;

const nomEntree = ({ nom, tranche }) => (tranche ? `${nom}@${tranche}` : nom);

export function attestationMutations(lot, rapport) {
  const campagnes = (rapport.campagnes ?? []).map((c) => ({
    nom: c.nom,
    ...(c.tranche ? { tranche: c.tranche } : {}),
    ok: c.ok === true,
    mutants: c.mutants ?? 0,
    tues: c.tues ?? 0,
    survivants: c.survivants ?? 0,
  }));
  return {
    type: "mutations",
    lot,
    sur: LOTS.length,
    ok: rapport.ok === true,
    entrees: campagnes.map(nomEntree),
    mutants: campagnes.reduce((s, c) => s + c.mutants, 0),
    tues: campagnes.reduce((s, c) => s + c.tues, 0),
    survivants: campagnes.reduce((s, c) => s + c.survivants, 0),
    campagnes,
  };
}

export function attestationNavigateur(tranche, rapport) {
  const stats = rapport?.stats;
  if (!stats) throw new Error("rapport Playwright illisible : pas de `stats`.");
  return {
    type: "navigateur",
    tranche,
    sur: TRANCHES_NAVIGATEUR,
    attendus: stats.expected ?? 0,
    inattendus: stats.unexpected ?? 0,
    flaky: stats.flaky ?? 0,
    ignores: stats.skipped ?? 0,
  };
}

/** Rend les écarts, un par ligne ; tableau vide = tout est présent, une fois, non vide et vert. */
export function verifierMutations(attestations) {
  const ecarts = [];
  const lus = attestations.filter((a) => a?.type === "mutations");
  for (const a of lus) {
    if (!Number.isInteger(a.lot) || a.lot < 1 || a.lot > LOTS.length || a.sur !== LOTS.length) {
      ecarts.push(`lot ${a.lot} inattendu (sur ${a.sur}, attendu 1..${LOTS.length}).`);
    }
  }
  for (let i = 1; i <= LOTS.length; i += 1) {
    const trouvees = lus.filter((a) => a.lot === i);
    if (trouvees.length === 0) ecarts.push(`lot ${i} : attestation absente.`);
    if (trouvees.length > 1)
      ecarts.push(`lot ${i} : attestation présente ${trouvees.length} fois.`);
    if (trouvees.length !== 1) continue;
    const [a] = trouvees;
    if (JSON.stringify(a.entrees) !== JSON.stringify(LOTS[i - 1])) {
      ecarts.push(`lot ${i} : entrées jouées différentes de LOTS (${JSON.stringify(a.entrees)}).`);
    }
    const vide = !(a.mutants > 0) || (a.campagnes ?? []).some((c) => !(c.mutants > 0));
    if (vide) ecarts.push(`lot ${i} : vide (0 mutant dans au moins une entrée).`);
    if (a.ok !== true) ecarts.push(`lot ${i} : en échec.`);
    if (a.survivants > 0 || (a.campagnes ?? []).some((c) => c.survivants > 0)) {
      ecarts.push(`lot ${i} : ${a.survivants} survivant(s).`);
    }
    if (a.tues !== a.mutants) ecarts.push(`lot ${i} : ${a.tues} tués ≠ ${a.mutants} mutants.`);
  }
  return ecarts;
}

export function verifierNavigateur(attestations) {
  const ecarts = [];
  const lus = attestations.filter((a) => a?.type === "navigateur");
  for (const a of lus) {
    if (
      !Number.isInteger(a.tranche) ||
      a.tranche < 1 ||
      a.tranche > TRANCHES_NAVIGATEUR ||
      a.sur !== TRANCHES_NAVIGATEUR
    ) {
      ecarts.push(`tranche ${a.tranche} inattendue (sur ${a.sur}).`);
    }
  }
  for (let i = 1; i <= TRANCHES_NAVIGATEUR; i += 1) {
    const trouvees = lus.filter((a) => a.tranche === i);
    if (trouvees.length === 0) ecarts.push(`tranche ${i} : attestation absente.`);
    if (trouvees.length > 1)
      ecarts.push(`tranche ${i} : attestation présente ${trouvees.length} fois.`);
    if (trouvees.length !== 1) continue;
    const [a] = trouvees;
    if (!(a.attendus > 0)) ecarts.push(`tranche ${i} : vide (0 épreuve réussie).`);
    if (a.inattendus > 0) ecarts.push(`tranche ${i} : ${a.inattendus} épreuve(s) en échec.`);
    if (a.flaky > 0) ecarts.push(`tranche ${i} : ${a.flaky} reprise(s), la règle en attend zéro.`);
  }
  return ecarts;
}

function lireDossier(dossier) {
  const lues = [];
  const parcourir = (chemin) => {
    for (const entree of readdirSync(chemin, { withFileTypes: true })) {
      const complet = join(chemin, entree.name);
      if (entree.isDirectory()) parcourir(complet);
      else if (entree.name.endsWith(".json")) lues.push(JSON.parse(readFileSync(complet, "utf8")));
    }
  };
  parcourir(dossier);
  return lues;
}

function principal([commande, type, ...reste]) {
  if (commande === "attester" && type === "mutations") {
    const [lot, rapport] = reste;
    const contenu = JSON.parse(readFileSync(rapport, "utf8"));
    writeFileSync(
      rapport,
      JSON.stringify({ ...contenu, ...attestationMutations(Number(lot), contenu) }, null, 2),
    );
    return 0;
  }
  if (commande === "attester" && type === "navigateur") {
    const [tranche, rapport, sortie] = reste;
    const attestation = attestationNavigateur(
      Number(tranche),
      JSON.parse(readFileSync(rapport, "utf8")),
    );
    writeFileSync(sortie, JSON.stringify(attestation, null, 2));
    return 0;
  }
  if (commande === "verifier" && (type === "mutations" || type === "navigateur")) {
    let attestations;
    try {
      attestations = lireDossier(reste[0]);
    } catch (erreur) {
      console.error(`Dossier d'attestations illisible : ${erreur.message}`);
      return 1;
    }
    const ecarts = (type === "mutations" ? verifierMutations : verifierNavigateur)(attestations);
    for (const ecart of ecarts) console.error(ecart);
    if (ecarts.length === 0)
      console.log(`Attestations ${type} : toutes présentes, une fois, non vides, vertes.`);
    return ecarts.length === 0 ? 0 : 1;
  }
  console.error(
    "usage : attester mutations|navigateur … | verifier mutations|navigateur <dossier>",
  );
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = principal(process.argv.slice(2));
}
