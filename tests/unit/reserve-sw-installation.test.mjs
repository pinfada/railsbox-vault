/**
 * L'INSTALLATION, l'ACTIVATION et l'IDENTITÉ DE CACHE du Service Worker de la coquille (#299, ADR 0048
 * §§ 3, 5, 6 et 11).
 *
 * Gardes éprouvées : 2 (taille, à l'installation), 3 (un écart n'est pas accepté), 4 (`no-store`),
 * 5 (le cache partiel d'UNE installation en échec est supprimé, et lui seul), 6 (`skipWaiting`),
 * 7 (`clients.claim`), 8 (nom de cache dérivé du CONTENU), 9 (jamais de `caches.delete` d'un cache
 * existant à l'installation), 10 (l'activation ne supprime que les `reserve-*` d'une autre identité),
 * 16 (`redirect: "error"`), 30 (migration : anciens préfixes NOMMÉS).
 *
 * Les quatre cas de l'ADR § 5 : (a) collision, (b) même contenu et plancher relevé, (c) retour arrière,
 * (d) installation interrompue.
 */

import assert from "node:assert/strict";
import test from "node:test";

import {
  FICHIERS,
  ORIGINE,
  configurer,
  installe,
  instancier,
  octets,
  texteDe,
} from "./support-sw-reserve.mjs";

const reseauDe = (fichiers) => {
  const reseau = {};
  for (const [chemin, texte] of Object.entries(fichiers)) reseau[chemin] = { corps: texte };
  return reseau;
};

test("l'installation télécharge chaque fichier en no-store, sans identifiants, SANS suivre une redirection (gardes 4 et 16)", async () => {
  const config = configurer(FICHIERS);
  const sw = instancier(config, { reseau: reseauDe(FICHIERS) });
  assert.equal(await sw.installer(), null);
  assert.equal(sw.appels.length, Object.keys(FICHIERS).length);
  for (const appel of sw.appels) {
    assert.equal(appel.cache, "no-store", `${appel.chemin} : ni cache HTTP ni réemploi`);
    assert.equal(appel.credentials, "omit", appel.chemin);
    assert.equal(appel.redirect, "error", appel.chemin);
    assert.equal(appel.methode, "GET");
  }
});

test("un écart d'EMPREINTE à l'installation la fait échouer, et rien n'est gardé (garde 3)", async () => {
  const config = configurer(FICHIERS);
  const trompe = { ...reseauDe(FICHIERS), "/main.mjs": { corps: "export const MAIN = 2;\n" } };
  assert.equal(
    trompe["/main.mjs"].corps.length,
    FICHIERS["/main.mjs"].length,
    "même taille : seule l'empreinte voit l'écart",
  );
  const sw = instancier(config, { reseau: trompe });
  const erreur = await sw.installer();
  assert.ok(erreur instanceof Error, "l'installation est rejetée");
  assert.equal(
    sw.caches.has(sw.nomDuCache),
    false,
    "le cache que CETTE installation a créé est supprimé (garde 5)",
  );
});

test("un écart de TAILLE à l'installation est refusé AVANT tout hachage (garde 2)", async () => {
  const config = configurer(FICHIERS);
  const sw = instancier(config, {
    reseau: {
      ...reseauDe(FICHIERS),
      "/main.mjs": { corps: `${FICHIERS["/main.mjs"]}// en plus\n` },
    },
  });
  const avant = sw.compteurs.digest;
  assert.ok((await sw.installer()) instanceof Error);
  // Les fichiers installés AVANT `/main.mjs` ont été hachés ; celui-ci ne l'a pas été.
  const attendus = Object.keys(config.liste).indexOf("/main.mjs");
  assert.equal(
    sw.compteurs.digest - avant,
    attendus,
    "l'entrée de taille anormale n'est pas hachée",
  );
});

test("un statut autre que 200 fait échouer l'installation", async () => {
  const sw = instancier(configurer(FICHIERS), {
    reseau: { ...reseauDe(FICHIERS), "/main.mjs": { statut: 500, corps: "x" } },
  });
  assert.ok((await sw.installer()) instanceof Error);
  assert.equal(sw.caches.has(sw.nomDuCache), false);
});

test("une redirection pendant l'installation la fait échouer : `redirect: error` lève, l'origine ne choisit pas l'octet (garde 16)", async () => {
  const sw = instancier(configurer(FICHIERS), {
    reseau: {
      ...reseauDe(FICHIERS),
      "/main.mjs": new TypeError("redirect mode is set to error"),
    },
  });
  assert.ok((await sw.installer()) instanceof Error);
  assert.equal(sw.caches.has(sw.nomDuCache), false);
});

test("ni `skipWaiting()` ni `clients.claim()` : la mise à jour attend la disparition de TOUS les clients (gardes 6 et 7)", async () => {
  const sw = await installe(FICHIERS);
  assert.equal(sw.compteurs.skipWaiting, 0);
  assert.equal(sw.compteurs.claim, 0);
});

test("le NOM du cache dérive du CONTENU : même séquence, contenu différent, deux noms (garde 8, cas a)", async () => {
  const v1 = configurer(FICHIERS, { sequence: 7 });
  const v1bis = configurer(
    { ...FICHIERS, "/main.mjs": "export const MAIN = 2;\n" },
    { sequence: 7 },
  );
  assert.equal(v1.sequence, v1bis.sequence);
  assert.notEqual(v1.identite, v1bis.identite);
  const a = instancier(v1, { reseau: reseauDe(FICHIERS) });
  const b = instancier(v1bis, {
    reseau: reseauDe({ ...FICHIERS, "/main.mjs": "export const MAIN = 2;\n" }),
  });
  assert.notEqual(a.nomDuCache, b.nomDuCache);
  assert.equal(a.nomDuCache, `reserve-${v1.identite}`);
  // Le SW lui-même nomme son cache d'après `identite`, jamais d'après la séquence.
  assert.equal(await a.installer(), null);
  assert.deepEqual([...a.caches.keys()], [`reserve-${v1.identite}`]);
  assert.ok(
    ![...a.caches.keys()].some(
      (nom) => nom.includes(`-${v1.sequence}`) && !nom.includes(v1.identite),
    ),
  );
});

test("COLLISION : un script de même séquence et de contenu différent, installé pendant que des clients utilisent le cache actif, laisse l'actif INTACT (garde 9, cas a)", async () => {
  const actif = await installe(FICHIERS, { sequence: 7 });
  const autres = { ...FICHIERS, "/main.mjs": "export const MAIN = 2;\n" };
  // Le nouveau SW partage le stockage de caches de l'origine : on lui donne ceux de l'actif.
  const nouveau = instancier(configurer(autres, { sequence: 7 }), {
    reseau: reseauDe(autres),
    caches: Object.fromEntries(
      [...actif.caches].map(([nom, entrees]) => [nom, Object.fromEntries(entrees)]),
    ),
  });
  assert.equal(await nouveau.installer(), null);
  assert.ok(nouveau.caches.has(actif.nomDuCache), "le cache actif existe encore");
  assert.ok(nouveau.caches.has(nouveau.nomDuCache), "le nouveau a son propre cache");
  assert.ok(
    !nouveau.operations.some(
      ([operation, nom]) => operation === "delete" && nom === actif.nomDuCache,
    ),
    "aucun `caches.delete` du cache actif",
  );
  // Et l'actif est servi sans erreur depuis ce que les clients en attendent.
  const servi = new Map(actif.caches.get(actif.nomDuCache));
  assert.deepEqual([...nouveau.caches.get(actif.nomDuCache)], [...servi]);
});

test("MÊME CONTENU, plancher relevé : même cache, rien n'est supprimé ni réinstallé (garde 8, cas b)", async () => {
  const actif = await installe(FICHIERS, { sequence: 7, plancher: 0 });
  const releve = configurer(FICHIERS, { sequence: 7, plancher: 7 });
  assert.equal(releve.identite, actif.config.identite, "le plancher n'entre pas dans l'identité");
  const nouveau = instancier(releve, {
    reseau: reseauDe(FICHIERS),
    caches: Object.fromEntries(
      [...actif.caches].map(([nom, entrees]) => [nom, Object.fromEntries(entrees)]),
    ),
  });
  assert.equal(await nouveau.installer(), null);
  assert.deepEqual(
    nouveau.operations.filter(([operation]) => operation === "delete" || operation === "put"),
    [],
    "ni suppression ni écriture : les entrées vérifiées sont conservées",
  );
  assert.equal(nouveau.appels.length, 0, "rien n'est retéléchargé");
});

test("RETOUR ARRIÈRE : l'origine republie un contenu ancien, il s'installe dans SON cache, jamais celui de l'actif (cas c)", async () => {
  const ancien = await installe(FICHIERS, { sequence: 3 });
  const recent = { ...FICHIERS, "/main.mjs": "export const MAIN = 9;\n" };
  const actifRecent = instancier(configurer(recent, { sequence: 9 }), {
    reseau: reseauDe(recent),
    caches: Object.fromEntries(
      [...ancien.caches].map(([nom, entrees]) => [nom, Object.fromEntries(entrees)]),
    ),
  });
  assert.equal(await actifRecent.installer(), null);
  await actifRecent.activer();
  // L'origine republie le contenu ancien (séquence 3) : un troisième script.
  const retour = instancier(configurer(FICHIERS, { sequence: 3 }), {
    reseau: reseauDe(FICHIERS),
    caches: Object.fromEntries(
      [...actifRecent.caches].map(([nom, entrees]) => [nom, Object.fromEntries(entrees)]),
    ),
  });
  assert.equal(await retour.installer(), null);
  assert.ok(retour.caches.has(actifRecent.nomDuCache), "le cache du récent n'a pas été touché");
  assert.equal(retour.nomDuCache, ancien.nomDuCache, "le contenu ancien retrouve SON nom");
});

test("un échec d'installation ne supprime QUE le cache que cette installation a créé : l'actif et un reste préexistant survivent (garde 5, cas d)", async () => {
  const actif = await installe(FICHIERS, { sequence: 7 });
  const autres = { ...FICHIERS, "/main.mjs": "export const MAIN = 2;\n" };
  const reste = configurer(autres, { sequence: 8 });
  const caches = Object.fromEntries(
    [...actif.caches].map(([nom, entrees]) => [nom, Object.fromEntries(entrees)]),
  );
  // Un reste d'installation interrompue, de l'identité de CE script : il existait déjà.
  caches[`reserve-${reste.identite}`] = { [`${ORIGINE}/index.html`]: autres["/index.html"] };
  const nouveau = instancier(reste, {
    reseau: { ...reseauDe(autres), "/runtime-worker.mjs": new TypeError("Failed to fetch") },
    caches,
  });
  assert.ok((await nouveau.installer()) instanceof Error);
  assert.ok(nouveau.caches.has(actif.nomDuCache), "l'actif est intact");
  assert.ok(
    nouveau.caches.has(`reserve-${reste.identite}`),
    "un cache qui préexistait n'est jamais supprimé par l'échec",
  );
  assert.ok(
    !nouveau.operations.some(
      ([operation, nom]) => operation === "delete" && nom === `reserve-${reste.identite}`,
    ),
  );
});

test("INSTALLATION INTERROMPUE : coupure en cours de route — l'actif est servi, le reste est complété à la reprise (cas d)", async () => {
  const actif = await installe(FICHIERS, { sequence: 7 });
  const autres = { ...FICHIERS, "/main.mjs": "export const MAIN = 2;\n" };
  const config = configurer(autres, { sequence: 8 });
  const caches = Object.fromEntries(
    [...actif.caches].map(([nom, entrees]) => [nom, Object.fromEntries(entrees)]),
  );
  const reseau = {
    ...reseauDe(autres),
    "/runtime-worker.mjs": new TypeError("Failed to fetch"),
  };
  const premier = instancier(config, { reseau, caches });
  assert.ok((await premier.installer()) instanceof Error);
  // Reprise : le réseau est revenu, l'installation suivante reprend sur un cache vide (supprimé par l'échec).
  const reprise = instancier(config, {
    reseau: reseauDe(autres),
    caches: Object.fromEntries(
      [...premier.caches].map(([nom, entrees]) => [nom, Object.fromEntries(entrees)]),
    ),
  });
  assert.equal(await reprise.installer(), null);
  assert.equal(reprise.caches.get(reprise.nomDuCache).size, Object.keys(autres).length);
  await reprise.activer();
  assert.ok(!reprise.caches.has(actif.nomDuCache), "à l'activation, l'ancien cache disparaît");
});

test("l'installation sur un cache de même identité ne le supprime PAS : les entrées sont vérifiées, la manquante et l'altérée refaites (garde 9)", async () => {
  const sw = await installe(FICHIERS);
  const nom = sw.nomDuCache;
  const entrees = sw.caches.get(nom);
  entrees.delete(`${ORIGINE}/main.mjs`);
  const abimee = Buffer.from(entrees.get(`${ORIGINE}/runtime-worker.mjs`));
  abimee[0] ^= 1;
  entrees.set(`${ORIGINE}/runtime-worker.mjs`, abimee);
  const ensuite = instancier(sw.config, {
    reseau: reseauDe(FICHIERS),
    caches: Object.fromEntries([...sw.caches].map(([n, e]) => [n, Object.fromEntries(e)])),
  });
  assert.equal(await ensuite.installer(), null);
  assert.ok(
    !ensuite.operations.some(([operation, n]) => operation === "delete" && n === nom),
    "jamais de caches.delete",
  );
  assert.deepEqual(
    ensuite.appels.map((appel) => appel.chemin).sort(),
    ["/main.mjs", "/runtime-worker.mjs"],
    "seules les entrées manquantes ou altérées sont retéléchargées",
  );
  assert.equal(
    await texteDe(new Response(ensuite.caches.get(nom).get(`${ORIGINE}/main.mjs`))),
    FICHIERS["/main.mjs"],
  );
});

test("l'ACTIVATION supprime les caches `reserve-*` d'une AUTRE identité, et rien d'autre (garde 10)", async () => {
  const config = configurer(FICHIERS);
  const sw = instancier(config, {
    reseau: reseauDe(FICHIERS),
    caches: {
      "reserve-ancienne": { [`${ORIGINE}/x`]: "x" },
      "reserve-encore-une-autre": {},
      "autre-cache-de-l-origine": { [`${ORIGINE}/y`]: "y" },
      reserve: {},
      "mon-reserve-": {},
    },
  });
  assert.equal(await sw.installer(), null);
  await sw.activer();
  assert.deepEqual(
    [...sw.caches.keys()].sort(),
    [sw.nomDuCache, "autre-cache-de-l-origine", "mon-reserve-", "reserve"].sort(),
    "seuls les `reserve-` d'une autre identité sont supprimés",
  );
});

test("MIGRATION de préfixe : les anciens préfixes NOMMÉS sont supprimés à l'activation, un préfixe non listé jamais (garde 30)", async () => {
  const config = configurer(FICHIERS, { prefixesAnciens: ["coquille-v1-"] });
  const sw = instancier(config, {
    reseau: reseauDe(FICHIERS),
    caches: {
      "coquille-v1-abc": {},
      "coquille-v2-abc": {},
      "autre-abc": {},
      "reserve-ancienne": {},
    },
  });
  assert.equal(await sw.installer(), null);
  await sw.activer();
  assert.deepEqual(
    [...sw.caches.keys()].sort(),
    [sw.nomDuCache, "autre-abc", "coquille-v2-abc"].sort(),
  );
});

test("l'installation SANS aucune entrée dans la liste (script de retrait) n'installe rien", async () => {
  const sw = instancier(configurer(FICHIERS, { retrait: true }), { reseau: reseauDe(FICHIERS) });
  assert.equal(await sw.installer(), null);
  assert.equal(sw.appels.length, 0);
  assert.equal(sw.caches.size, 0);
});

test("une entrée d'un contenu pire que sa liste n'est jamais installée même si le statut est 200", async () => {
  const sw = instancier(configurer(FICHIERS), {
    reseau: {
      ...reseauDe(FICHIERS),
      "/src/coquille/a.mjs": { corps: octets("MAUVAIS").toString() },
    },
  });
  assert.ok((await sw.installer()) instanceof Error);
});
