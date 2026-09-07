/**
 * Les CLIQUETS du déverrouillage sur le DOSSIER (#162, ADR 0029).
 *
 * Ils vivent à part de `coquille-deverrouillage.test.mjs`, et la séparation n'est pas une commodité
 * de rangement : la campagne de mutation (`tools/moteur-de-mutation.mjs`) recopie `src`, `tests`,
 * `tools` et `public` dans son atelier — **pas `docs/`**, qu'elle n'a aucune raison d'emporter. Une
 * épreuve qui confronte le code à un document ne peut donc pas y tourner, et si elle vivait dans le
 * fichier que la campagne rejoue, celle-ci rendrait NON APPLICABLE sur toutes ses gardes : le
 * moteur exige que l'épreuve passe AVANT la mutation, faute de quoi elle ne mesure rien.
 *
 * Ce qui suit confronte donc trois affirmations à leur source, et rien d'autre :
 *
 *  - la table d'attente annoncée aux mesures publiées de l'ADR 0021 ;
 *  - le texte du consentement nommé à la phrase pesée dans l'ADR 0027 ;
 *  - le refus de volume verrouillé à la spécification autonome de #20.
 *
 * Les trois ont le même défaut à empêcher : une valeur que le produit affiche à un utilisateur, et
 * dont la source a bougé sans elle.
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { ATTENTE_MESUREE, MOTEURS_MESURES } from "../../src/coquille/attente-annoncee.mjs";
import { TEXTE_DU_CONSENTEMENT } from "../../src/coquille/feuille-de-recuperation.mjs";
import { CODES_REFUS_COQUILLE } from "../../src/coquille/refus-de-coquille.mjs";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

async function lire(relatif) {
  return readFile(path.join(REPO_ROOT, relatif), "utf8");
}

test("la table d'attente est RELUE de l'ADR 0021 : les deux ne peuvent pas diverger", async () => {
  // Le cliquet qui donne son sens au mot « relue ». Une annonce est une promesse faite à
  // l'utilisateur sur la foi d'une mesure : si la mesure est refaite un jour et que la table reste,
  // la coquille ment sans que personne ne l'ait décidé. Les deux se confrontent, et l'épreuve
  // rougit sur celui des deux qui bouge seul.
  const adr = await lire("docs/decisions/0021-derivation-des-cles-de-deverrouillage.md");
  const mesures = adr.slice(adr.indexOf("## Mesures"));
  assert.ok(
    mesures.length > 0,
    "le § Mesures de l'ADR 0021 est introuvable : le cliquet est cassé.",
  );

  for (const moteur of MOTEURS_MESURES) {
    const attendu = ATTENTE_MESUREE[moteur];
    assert.ok(attendu !== undefined, `${moteur} manque à la table d'attente.`);
    for (const valeur of [...attendu.p50Ms, ...attendu.p95Ms]) {
      assert.match(
        mesures,
        motifDuNombre(valeur),
        `${valeur} ms (${moteur}) n'est pas dans le § Mesures de l'ADR 0021.`,
      );
    }
  }
});

test("le cliquet de la table MORD : un nombre absent du § Mesures est relevé", async () => {
  // Un cliquet à vide passe toujours. Celui-ci est confronté à un nombre que l'ADR ne porte pas, et
  // à un qu'il porte : sans les deux moitiés, une comparaison cassée resterait verte.
  const adr = await lire("docs/decisions/0021-derivation-des-cles-de-deverrouillage.md");
  const mesures = adr.slice(adr.indexOf("## Mesures"));
  assert.match(mesures, motifDuNombre(2141), "l'ADR porte bien 2 141 ms, avec son espace.");
  assert.doesNotMatch(mesures, motifDuNombre(31337), "un nombre inventé ne doit pas être trouvé.");
});

/**
 * Le motif d'un nombre, tel que l'ADR l'ÉCRIT.
 *
 * Il y sépare les milliers par une espace — « 2 141 ms » — là où la table porte l'entier 2141. Le
 * motif accepte les deux écritures du MÊME nombre, et n'accepte rien d'autre : une comparaison
 * textuelle stricte aurait échoué sur une convention typographique, et une comparaison laxiste
 * aurait trouvé 2141 dans 12141.
 */
/**
 * Les espaces qu’un document peut poser entre les milliers, ÉCHAPPÉES plutôt que littérales.
 *
 * L’espace insécable (U+00A0) et l’espace fine insécable (U+202F) sont invisibles dans une source :
 * les y poser ferait dépendre le cliquet d’un caractère qu’aucun relecteur ne voit, et qu’un
 * éditeur peut remplacer par une espace ordinaire sans que personne ne le sache.
 */
const ESPACES = "[\\s\\u00a0\\u202f]";

function motifDuNombre(valeur) {
  const chaine = String(valeur);
  const corps = chaine.length > 3 ? `${chaine.slice(0, -3)}${ESPACES}?${chaine.slice(-3)}` : chaine;
  // Les bornes ne portent que sur les CHIFFRES, et pas sur les espaces : dans une cellule de
  // tableau, une espace précède justement le nombre, et l'exclure ferait échouer le motif sur ce
  // qu'il cherche. Ce qu'elles empêchent est de trouver 141 dans 2141.
  return new RegExp(`(?<![0-9])${corps}(?![0-9])`);
}

test("le CONSENTEMENT nommé dit ce que l'utilisateur accepte, mot pour mot avec l'ADR 0027", async () => {
  // La citation a été PESÉE dans l'ADR 0027, décision 3 : « il n'interdit rien — refuser rendrait
  // inutilisable toute sauvegarde prise avant la dernière révocation. Il exige qu'un exploitant
  // identifié assume ». Le texte affiché doit dire la même chose, sans quoi le dossier décrirait
  // deux consentements là où il n'y en a qu'un.
  const adr = await lire("docs/decisions/0027-archive-et-ancre-de-version.md");
  assert.ok(
    adr.includes("une clé révoquée depuis pourrait y être"),
    "la citation de l'ADR a bougé : le texte du consentement ne dit plus ce qui a été pesé là-bas.",
  );
  assert.match(TEXTE_DU_CONSENTEMENT, /clé révoquée depuis pourrait y être encore valable/);
  assert.match(TEXTE_DU_CONSENTEMENT, /nouvelle référence/);
});

test("le refus de volume VERROUILLÉ est nommé dans la spécification autonome", async () => {
  // `tests/unit/dossier-de-revue.test.mjs` exige déjà que tout code de la famille COQUILLE figure
  // au § 10 ; celui-ci le redit sur le code NOMMÉ, pour qu'un relecteur qui cherche cette garde la
  // trouve à côté de la décision qui l'a créée.
  const spec = await lire("docs/format-de-volume-v3.md");
  assert.ok(spec.includes(CODES_REFUS_COQUILLE.volumeVerrouille));
  assert.match(spec, /volume OUVERT/);
});

test("l'ADR 0029 existe, il est indexé, et l'ADR 0028 dit que sa décision 4 est RETIRÉE", async () => {
  const adr = await lire("docs/decisions/0029-deverrouillage-dans-la-coquille.md");
  assert.match(adr, /## Décision 1 — Le jeton de harnais QUITTE le chemin de produit/);
  assert.match(
    await lire("README.md"),
    /docs\/decisions\/0029-deverrouillage-dans-la-coquille\.md/,
    "l'index des ADR du README ne cite pas l'ADR 0029.",
  );
  // La note datée que la décision 1 exige : un ADR dont une décision est retirée doit le DIRE là où
  // un relecteur la lira, pas seulement dans l'ADR qui la retire.
  const precedent = await lire("docs/decisions/0028-coquille-de-produit-et-frontiere.md");
  assert.match(precedent, /RETIRÉE le 7 septembre 2026 par #162/);
});
