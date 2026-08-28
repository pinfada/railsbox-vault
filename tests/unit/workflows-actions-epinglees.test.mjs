/**
 * Cliquet : **aucune action de workflow n'est référencée par une étiquette mobile ; chaque `uses:`
 * porte un SHA de commit complet, suivi de l'étiquette qu'il fige en commentaire.**
 *
 * ## Ce que la règle empêche
 *
 * `uses: actions/checkout@v5` ne nomme pas un contenu, il nomme un POINTEUR. Une étiquette `vN` est
 * une référence Git ordinaire, et son propriétaire peut la déplacer sur n'importe quel commit sans
 * que rien ne change chez nous : le prochain déclenchement exécute alors du code que personne ici
 * n'a lu. Un compte amont compromis suffit — la chaîne d'approvisionnement d'Actions a déjà connu
 * ce scénario, et il ne demande aucun accès à ce dépôt.
 *
 * L'exécutant qui compte est **celui qui produit l'arborescence publiée et affiche son empreinte de
 * racine** (`.github/workflows/publication.yml`, #45). L'ADR 0017 dit que l'inventaire n'est pas
 * une signature : la seule défense contre une publication altérée est la comparaison hors bande de
 * cette empreinte. Or l'empreinte est calculée PAR l'exécutant. Une action amont substituée y
 * publie l'arbre de son choix et affiche l'empreinte qui va avec — la comparaison confirme alors
 * une altération au lieu de la révéler.
 *
 * Un SHA de commit, lui, nomme un contenu : il ne peut pas être déplacé sans changer de valeur.
 *
 * ## Ce que la règle exige, et pourquoi le commentaire n'est pas décoratif
 *
 * ```yaml
 * uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0
 * ```
 *
 * Quarante caractères hexadécimaux ne se relisent pas. Sans l'étiquette en commentaire, une revue
 * ne peut plus dire quelle version tourne, ni si une montée de version est en retard de deux ans.
 * Le commentaire est aussi le mécanisme de MISE À JOUR : Dependabot lit `# vX.Y.Z`, propose le SHA
 * de la version suivante et réécrit le commentaire avec elle (`package-ecosystem: github-actions`).
 * Sans lui, l'épinglage fige la chaîne sans donner le moyen de la faire avancer — ce que l'issue
 * #105 refusait explicitement de trancher à moitié.
 *
 * Ce cliquet vérifie donc les deux moitiés de la convention : le SHA **et** l'étiquette.
 *
 * ## Ce qui reste permis
 *
 * Une action LOCALE (`uses: ./…`) vit dans l'arbre relu par la revue et le SHA du dépôt la fige
 * déjà ; l'épingler par elle-même n'aurait pas de sens. Le dépôt n'en a aucune aujourd'hui, et la
 * règle laisse la porte ouverte plutôt que de refuser un cas qu'elle n'a pas de raison de refuser.
 *
 * ## Pourquoi une analyse textuelle plutôt qu'un analyseur YAML
 *
 * Même raison que `workflows-sans-interpolation.test.mjs` : le dépôt n'a aucune dépendance YAML, et
 * en ajouter une pour un cliquet de dix lignes mettrait une dépendance de plus dans la chaîne que
 * cette épreuve protège. L'épreuve de sensibilité ci-dessous vérifie que le balayage MORD sur des
 * cas connus, sans quoi un relevé vide ne prouverait rien.
 */

import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const DOSSIER_WORKFLOWS = path.join(REPO_ROOT, ".github", "workflows");

/** Un SHA de commit Git complet : rien de plus court ne nomme un contenu de façon non ambiguë. */
const SHA_COMPLET = /^[0-9a-f]{40}$/u;

/** L'étiquette figée, telle que Dependabot la relit et la réécrit : `# v1`, `# v1.2`, `# v1.2.3`. */
const ETIQUETTE_EN_COMMENTAIRE = /^#\s*v\d+(?:\.\d+){0,2}\S*$/u;

/**
 * Relève les `uses:` d'un workflow et le motif pour lequel chacun est refusé, s'il l'est.
 *
 * Un `uses:` se lit sur une seule ligne dans le format des workflows du dépôt : `uses: REF` suivi,
 * le cas échéant, d'un commentaire `# étiquette`. Les commentaires de ligne entière (`# …` en début
 * de ligne) ne sont pas des étapes et sont ignorés.
 *
 * @param {string} texte contenu d'un fichier de workflow
 * @returns {{ ligne: number, reference: string, motif: string }[]} les `uses:` REFUSÉS
 */
export function usesNonEpingles(texte) {
  const refuses = [];

  for (const [index, ligne] of texte.split("\n").entries()) {
    const trouve = /^\s*-?\s*uses:\s*(?<reste>\S.*)$/u.exec(ligne);
    if (trouve === null) continue;
    if (/^\s*#/u.test(ligne)) continue;

    const reste = trouve.groups.reste.trim();
    const [reference, ...commentaire] = reste.split(/\s+/u);

    // Une action locale est figée par le SHA de ce dépôt : elle n'a rien à épingler.
    if (reference.startsWith("./")) continue;

    const arobase = reference.lastIndexOf("@");
    const version = arobase === -1 ? "" : reference.slice(arobase + 1);

    if (!SHA_COMPLET.test(version)) {
      refuses.push({
        ligne: index + 1,
        reference,
        motif: "référence par étiquette mobile au lieu d'un SHA de commit de 40 hexadécimaux",
      });
      continue;
    }

    if (commentaire.length === 0 || !ETIQUETTE_EN_COMMENTAIRE.test(commentaire.join(" "))) {
      refuses.push({
        ligne: index + 1,
        reference,
        motif: "SHA sans l'étiquette en commentaire « # vX.Y.Z »",
      });
    }
  }

  return refuses;
}

async function workflows() {
  const noms = (await readdir(DOSSIER_WORKFLOWS)).filter((nom) => nom.endsWith(".yml"));
  return Promise.all(
    noms.map(async (nom) => ({
      nom,
      texte: await readFile(path.join(DOSSIER_WORKFLOWS, nom), "utf8"),
    })),
  );
}

const releve = await workflows();

test("le relevé porte bien sur les workflows du dépôt", () => {
  assert.ok(releve.length >= 4, `seulement ${releve.length} workflow(s) relevé(s)`);
  assert.ok(
    releve.some(({ nom }) => nom === "publication.yml"),
    "la chaîne de publication n'est pas couverte par ce cliquet",
  );
});

test("le relevé voit RÉELLEMENT des `uses:` : un balayage à vide ne prouverait rien", () => {
  const total = releve.reduce(
    (somme, { texte }) => somme + (texte.match(/^\s*-?\s*uses:/gmu) ?? []).length,
    0,
  );
  assert.ok(total >= 10, `seulement ${total} « uses: » relevé(s) dans les workflows`);
});

test("chaque action est épinglée par SHA de commit, étiquette en commentaire", () => {
  const fautes = releve.flatMap(({ nom, texte }) =>
    usesNonEpingles(texte).map(
      ({ ligne, reference, motif }) => `${nom}:${ligne} — « ${reference} » : ${motif}`,
    ),
  );

  assert.deepEqual(
    fautes,
    [],
    "Une étiquette « vN » est déplaçable par son propriétaire : ce qui s'exécute sur l'exécutant " +
      "n'est alors plus ce qui a été relu. Écrivez « uses: owner/action@<sha 40 hex> # vX.Y.Z » ; " +
      "le SHA se résout par « gh api repos/<owner>/<repo>/git/ref/tags/<étiquette> ».",
  );
});

test("le balayage MORD : une étiquette mobile est refusée, sur la bonne ligne", () => {
  const fautif = [
    "jobs:",
    "  publier:",
    "    steps:",
    "      - name: Récupération du dépôt",
    "        uses: actions/checkout@v5",
  ].join("\n");

  const refuses = usesNonEpingles(fautif);
  assert.equal(refuses.length, 1);
  assert.equal(refuses[0].ligne, 5);
  assert.match(refuses[0].motif, /étiquette mobile/u);
});

test("le balayage MORD sur un SHA court, qui n'est pas non plus un contenu nommé", () => {
  const fautif = "      - uses: actions/checkout@fbc6f39 # v5.1.0";
  assert.equal(usesNonEpingles(fautif).length, 1);
});

test("le balayage MORD sur un SHA nu : sans l'étiquette, la revue ne peut plus la lire", () => {
  const fautif = "      - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09";
  const refuses = usesNonEpingles(fautif);
  assert.equal(refuses.length, 1);
  assert.match(refuses[0].motif, /étiquette en commentaire/u);
});

test("le balayage ACCEPTE la forme conventionnelle, et une action locale", () => {
  const correct = [
    "      - name: Récupération du dépôt",
    "        uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5.1.0",
    "      - uses: ./.github/actions/preparer",
    "      # uses: actions/checkout@v5 — commentaire, pas une étape",
  ].join("\n");

  assert.deepEqual(usesNonEpingles(correct), []);
});
