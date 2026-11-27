/**
 * Les LIMITES de l'hébergeur dans la chaîne de publication (#45, étape 3 de l'objectif du 26/11).
 *
 * Deux niveaux : la mesure pure sur des relevés fabriqués, aux BORNES (la limite elle-même passe, un
 * octet de plus refuse), et la COMMANDE `publier.mjs --verifier <arbre> --profil <hébergeur>` sur un
 * arbre jetable — une mesure correcte que `principal()` n'appelle pas ne garde rien.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import * as limites from "../../tools/publier-limites-hebergeur.mjs";
import { construireInventaire } from "../../tools/publier-inventaire.mjs";
import { CODES } from "../../tools/publier.mjs";

const MIO = 1024 * 1024;
const PUBLIER = fileURLToPath(new URL("../../tools/publier.mjs", import.meta.url));
const cloudflare = () => limites.profilNomme("cloudflare-pages");
const fichier = (chemin, octets) => ({ chemin, octets });

test("le code de sortie dédié existe et ne recoupe aucun autre", () => {
  assert.equal(CODES.limitesHebergeur, 7);
  assert.equal(new Set(Object.values(CODES)).size, Object.values(CODES).length);
});

test("cloudflare-pages : 25 Mio par fichier, 20 000 fichiers, 100 règles — chacun à sa borne", () => {
  const profil = cloudflare();
  assert.equal(profil.octetsParFichier, 25 * MIO);
  assert.equal(profil.fichiers, 20_000);
  assert.equal(profil.reglesHeaders, 100);

  const pile = limites.mesurerLesLimites({
    fichiers: [fichier("a", 25 * MIO)],
    headers: null,
    profil,
  });
  assert.deepEqual(pile.depassements, [], "25 Mio exactement passe");
  const trop = limites.mesurerLesLimites({
    fichiers: [fichier("a", 25 * MIO + 1)],
    headers: null,
    profil,
  });
  assert.deepEqual(
    trop.depassements.map(({ regle, chemin }) => [regle, chemin]),
    [["octets-par-fichier", "a"]],
  );

  const nombre = (n) => Array.from({ length: n }, (_, i) => fichier(`f${i}`, 1));
  assert.deepEqual(
    limites.mesurerLesLimites({ fichiers: nombre(20_000), headers: null, profil }).depassements,
    [],
  );
  assert.equal(
    limites.mesurerLesLimites({ fichiers: nombre(20_001), headers: null, profil }).depassements[0]
      .regle,
    "nombre-de-fichiers",
  );

  const regles = (n) =>
    `# commentaire\n${Array.from({ length: n }, (_, i) => `/r${i}\n  X-A: 1\n  X-B: 2`).join("\n")}\n`;
  assert.deepEqual(
    limites.mesurerLesLimites({ fichiers: [], headers: regles(100), profil }).depassements,
    [],
  );
  assert.equal(
    limites.mesurerLesLimites({ fichiers: [], headers: regles(101), profil }).depassements[0].regle,
    "regles-headers",
  );
});

test("les règles d'un _headers sont les lignes de motif : ni les en-têtes indentés, ni les commentaires", () => {
  assert.deepEqual(limites.reglesDuFichierHeaders("# c\n/*\n  A: 1\n  B: 2\n\n/x/*\n  C: 3\n"), [
    "/*",
    "/x/*",
  ]);
});

test("cloudflare-pages : une ligne de _headers de plus de 2000 caractères dépasse, 2000 passe", () => {
  const profil = cloudflare();
  const ligne = (n) => `/*\n  X-Long: ${"a".repeat(n - "  X-Long: ".length)}\n`;
  assert.deepEqual(
    limites.mesurerLesLimites({ fichiers: [], headers: ligne(2000), profil }).depassements,
    [],
  );
  assert.equal(
    limites.mesurerLesLimites({ fichiers: [], headers: ligne(2001), profil }).depassements[0].regle,
    "longueur-ligne-headers",
  );
});

test("netlify : aucune limite par fichier, un avertissement au-delà de 10 Mio, jamais un refus", () => {
  const profil = limites.profilNomme("netlify");
  const resultat = limites.mesurerLesLimites({
    fichiers: [fichier("petit", 10 * MIO), fichier("gros", 134 * MIO)],
    headers: null,
    profil,
  });
  assert.deepEqual(resultat.depassements, []);
  assert.deepEqual(
    resultat.avertissements.map(({ chemin }) => chemin),
    ["gros"],
  );
});

test("un profil inconnu est refusé en nommant les profils connus", () => {
  assert.throws(
    () => limites.profilNomme("autre"),
    /cloudflare-pages.*netlify|netlify.*cloudflare-pages/,
  );
});

async function arbreAvecUnGrosFichier(octets) {
  const racine = await mkdtemp(join(tmpdir(), "limites-"));
  await mkdir(join(racine, "artifacts"), { recursive: true });
  await writeFile(join(racine, "_headers"), "/*\n  X-Content-Type-Options: nosniff\n");
  await writeFile(join(racine, "artifacts", "gros.bin"), Buffer.alloc(octets, 1));
  const inventaire = await construireInventaire({
    arbre: "banc",
    role: "épreuve",
    racine,
    origine: "http://localhost:1",
    commit: {
      reference: "HEAD",
      empreinte: null,
      date: null,
      arbreGit: null,
      arbreDeTravailPropre: true,
    },
    complet: true,
    banc: true,
    absentes: [],
    enTetes: {},
    exclusions: [],
  });
  await writeFile(join(racine, "inventaire.json"), `${JSON.stringify(inventaire, null, 2)}\n`);
  return racine;
}
const verifier = (racine, ...options) =>
  spawnSync(process.execPath, [PUBLIER, "--verifier", racine, ...options], { encoding: "utf8" });

test("--verifier --profil cloudflare-pages rend 7 et NOMME le fichier en dépassement ; sans profil, 0", async (t) => {
  const racine = await arbreAvecUnGrosFichier(25 * MIO + 1);
  t.after(() => rm(racine, { recursive: true, force: true }));

  assert.equal(verifier(racine).status, 0, "sans profil, l'arbre est conforme à son inventaire");
  const refus = verifier(racine, "--profil", "cloudflare-pages");
  assert.equal(refus.status, CODES.limitesHebergeur, refus.stderr);
  assert.match(refus.stdout, /DÉPASSEMENT\s+octets-par-fichier\s+artifacts\/gros\.bin/);
  assert.match(refus.stderr, /LIMITE D'HÉBERGEUR/);

  const accepte = verifier(racine, "--profil", "netlify");
  assert.equal(accepte.status, 0);
  assert.match(accepte.stdout, /avertissement\s+octets-par-fichier\s+artifacts\/gros\.bin/);
});

test("--verifier --profil : un fichier à la borne passe, un profil inconnu est un usage invalide (3)", async (t) => {
  const racine = await arbreAvecUnGrosFichier(25 * MIO);
  t.after(() => rm(racine, { recursive: true, force: true }));
  assert.equal(verifier(racine, "--profil", "cloudflare-pages").status, 0);
  assert.equal(verifier(racine, "--profil", "inconnu").status, CODES.usage);
});

test("un arbre ALTÉRÉ rend 1 avant les limites : il n'est pas jugé sur sa taille", async (t) => {
  const racine = await arbreAvecUnGrosFichier(26 * MIO);
  t.after(() => rm(racine, { recursive: true, force: true }));
  await writeFile(join(racine, "artifacts", "gros.bin"), Buffer.alloc(26 * MIO, 2));
  assert.equal(verifier(racine, "--profil", "cloudflare-pages").status, CODES.ecart);
});
