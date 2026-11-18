// M — MATRICE DES MUTANTS du SW et du portail : pour chaque garde, un scénario dont l'invariant tient
// en nominal et se rompt sous le mutant. Les mutants sont des interrupteurs (`variante`, `mutants`)
// dans le MÊME code que celui qui est servi — pas une copie de test. La campagne de mutation du produit
// (D1h-b, `tools/rejouer-les-campagnes.mjs`, campagne `reserve`) mutera le SOURCE ; ceci prouve que les
// scénarios SAVENT distinguer. Un mutant qui survit est dit survivant et expliqué (équivalent ou trou).
import { jusqua, ORIGINE_COQUILLE } from "../banc/cadre.mjs";
import { MAUVAIS } from "../banc/serveur.mjs";
import { v1, v2 } from "./aide.mjs";

export const epreuves = [];
const ajouter = (id, titre, run, extra = {}) => epreuves.push({ id, titre, run, ...extra });

async function jouer(t, generation, scenario, { tolerant = false } = {}) {
  const origine = await t.origineDe(generation);
  origine.tolerant = tolerant;
  const contexte = await t.contexte();
  let sortie;
  try {
    sortie = await scenario({ origine, contexte });
  } finally {
    await contexte.close().catch(() => {});
    await origine.arreter();
    t.origines.length = 0;
    t.origine = null;
  }
  return sortie;
}
const installerEtControler = async (t, contexte) => {
  await t.installer(contexte);
  return t.bancControle(contexte);
};
/** nominal : l'invariant TIENT ; mutant : il se ROMPT (le scénario retourne { tient, detail }). */
async function tuer(t, nom, variante, scenario, options) {
  const nominal = await jouer(t, v1(), (ctx) => scenario(ctx, {}), options);
  const mutant = await jouer(t, v1({ variante }), (ctx) => scenario(ctx, variante), options);
  t.mesure(nom, { nominal, mutant });
  t.verifier(nominal.tient === true && mutant.tient === false, `${nom} : invariant tenu en nominal (${nominal.detail}), ROMPU sous le mutant (${mutant.detail}) → mutant TUÉ`);
}

ajouter("M1", "serviceSansHachage : une entrée altérée (même taille) n'est plus refusée", async (t) => {
  await tuer(t, "serviceSansHachage", { serviceSansHachage: true }, async ({ contexte }) => {
    const page = await installerEtControler(t, contexte);
    const r = await page.evaluate(async () => {
      const c = await caches.open("reserve-pub-0001");
      const octets = new Uint8Array(await (await c.match("/spike/lib-tardive.mjs")).arrayBuffer());
      octets[octets.length - 3] ^= 1; // même taille
      await c.put("/spike/lib-tardive.mjs", new Response(octets));
      return (await fetch("/spike/lib-tardive.mjs")).status;
    });
    return { tient: r === 503, detail: `statut ${r}` };
  });
});

ajouter("M2", "taille non comparée (service ET installation) : MUTANT SURVIVANT ÉQUIVALENT — le hachage couvre la taille ; le contrôle de taille reste un garde-fou bon marché avant de hacher", async (t) => {
  const service = await jouer(t, v1({ variante: { serviceSansTaille: true } }), async ({ contexte }) => {
    const page = await installerEtControler(t, contexte);
    return page.evaluate(async () => {
      const c = await caches.open("reserve-pub-0001");
      await c.put("/spike/lib-tardive.mjs", new Response("export const LIB_TARDIVE = 'plus long';\n"));
      return (await fetch("/spike/lib-tardive.mjs")).status;
    });
  });
  t.mesure("serviceSansTaille", service);
  t.verifier(service === 503, "sans comparaison de taille, l'entrée de taille différente est QUAND MÊME refusée (par le hachage) : le mutant survit — équivalent, à dire dans l'ADR (la taille borne le coût, ne protège rien de plus)");
});

ajouter("M3", "installAccepteUnEcart : une installation avec un fichier trafiqué n'est plus rejetée", async (t) => {
  await tuer(t, "installAccepteUnEcart", { installAccepteUnEcart: true }, async ({ origine, contexte }) => {
    origine.regler("/spike/lib.mjs", { corps: 'export const LIB = "lib-xx";\n' }); // même taille que l\'original : seul le hachage la distingue
    const page = await contexte.newPage();
    await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
    await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
    const r = await page.evaluate(() => window.banc.enregistrer().then(() => "installee", () => "rejetee"));
    return { tient: r === "rejetee", detail: r };
  });
});

ajouter("M4", "installAvecCacheHttp : v2 s'installe sur octets frais en nominal, échoue sur octets périmés sous le mutant", async (t) => {
  const execute = async (variante) => {
    const origine = await t.origineDe(v1());
    const contexte = await t.contexte();
    try {
      origine.regler("/spike/lib.mjs", { corps: 'export const LIB = "lib-v1";\n', type: "text/javascript", entetes: { "Cache-Control": "public, max-age=31536000" } });
      const page = await contexte.newPage();
      await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
      await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
      await page.evaluate(() => fetch("/spike/lib.mjs").then((r) => r.text())); // amorce le cache HTTP
      origine.regler("/spike/lib.mjs", null);
      origine.publier(v2({ variante }));
      // La v1 n'est PAS installée : la v2 est la première installation, sur un cache HTTP qui contient la v1 de lib.mjs.
      const r = await page.evaluate(() => window.banc.enregistrer().then(() => "installee", () => "rejetee"));
      return { tient: r === "installee", detail: r };
    } finally {
      await contexte.close().catch(() => {});
      await origine.arreter();
      t.origines.length = 0;
      t.origine = null;
    }
  };
  const nominal = await execute({});
  const mutant = await execute({ installAvecCacheHttp: true });
  t.mesure("installAvecCacheHttp", { nominal, mutant });
  t.verifier(nominal.tient === true, `nominal (cache: no-store) : l'installation lit des octets frais (${nominal.detail})`);
  t.verifier(mutant.tient === false, `mutant (cache HTTP) : l'installation lit des octets périmés et échoue (${mutant.detail}) → mutant TUÉ ; sous les en-têtes de production (no-cache) il survivrait — la garde protège contre un hébergeur qui poserait un max-age`);
});

ajouter("M5", "garde de passage /artifacts/** : sans contrôle de destination, de chemin, de type ; ou artefacts servis par le SW", async (t) => {
  const scenarios = {
    passageSansControleDeDestination: async ({ origine, contexte }) => {
      // Un <script> CLASSIQUE servi text/plain SANS nosniff s'exécute : seule la destination l'arrête.
      origine.regler("/artifacts/m.js", { corps: "globalThis.__MAUVAIS = 1;", type: "text/plain", entetes: { "X-Content-Type-Options": "" } });
      const page = await installerEtControler(t, contexte);
      const r = await page.evaluate(
        () =>
          new Promise((ok) => {
            const sc = document.createElement("script");
            sc.src = "/artifacts/m.js";
            sc.onload = () => ok(globalThis.__MAUVAIS === 1 ? "EXECUTE" : "charge");
            sc.onerror = () => ok("refuse");
            document.head.append(sc);
            setTimeout(() => ok("silence"), 3000);
          }),
      );
      return { tient: r !== "EXECUTE", detail: r };
    },
    passageSansControleDeChemin: async ({ origine, contexte }) => {
      // Cible NON exécutable (JSON) pour que la garde de type ne masque pas celle du chemin.
      origine.generation.fichiers.set("/spike/inconnu.json", Buffer.from('{"V":"vrai"}'));
      const page = await installerEtControler(t, contexte);
      origine.hostile = true;
      const r = await page.evaluate(async () => {
        const rep = await fetch(location.origin + "/artifacts/..%2fspike/inconnu.json");
        return (await rep.text()).slice(0, 40);
      });
      return { tient: !r.includes("MAUVAIS"), detail: r };
    },
    passageSansControleDeType: async ({ origine, contexte }) => {
      origine.regler("/artifacts/js.json", { corps: "export const V = 1;", type: "text/javascript" });
      const page = await installerEtControler(t, contexte);
      const r = await page.evaluate(async () => (await fetch("/artifacts/js.json")).headers.get("X-Vault-Refus"));
      return { tient: r === "PASSAGE_TYPE_EXECUTABLE", detail: String(r) };
    },
    artefactsServisParLeSW: async ({ contexte }) => {
      const page = await installerEtControler(t, contexte);
      const r = await page.evaluate(async () => (await fetch("/artifacts/application.json")).status);
      return { tient: r === 200, detail: `statut ${r} (le descripteur doit atteindre le réseau : c'est la sonde « origine injoignable »)` };
    },
  };
  for (const [variante, scenario] of Object.entries(scenarios)) {
    await tuer(t, variante, { [variante]: true }, scenario, { tolerant: true });
  }
});

ajouter("M6", "supprimeTout (activation) : la mise à jour supprime AUSSI les caches qui ne sont pas au produit", async (t) => {
  await tuer(t, "supprimeTout", { supprimeTout: true }, async ({ origine, contexte }, variante) => {
    const page = await installerEtControler(t, contexte);
    await page.evaluate(async () => (await caches.open("autre-cache-sans-rapport")).put("/x", new Response("x")));
    await page.close();
    origine.publier(v2({ variante }));
    const q = await contexte.newPage();
    await q.goto(ORIGINE_COQUILLE + "/spike/sans-coop.html");
    await q.evaluate(async () => (await navigator.serviceWorker.getRegistration("/")).update());
    await jusqua(async () => (await q.evaluate(async () => (await navigator.serviceWorker.getRegistration("/")).waiting?.state)) === "installed", { delaiMs: 15000 });
    await q.close();
    // Les clients ont disparu : la v2 s'active et nettoie.
    const r = await contexte.newPage();
    await r.goto(ORIGINE_COQUILLE + "/spike/sans-coop.html");
    // Chaque rechargement libère le client : l'activation de la v2 ne peut avoir lieu qu'entre deux pages.
    const noms = await jusqua(async () => {
      await r.reload();
      const k = await r.evaluate(() => caches.keys());
      return k.includes("reserve-pub-0001") ? null : k;
    }, { delaiMs: 25000, pasMs: 700 });
    return { tient: Boolean(noms) && noms.includes("autre-cache-sans-rapport"), detail: JSON.stringify(noms) };
  });
});

ajouter("M7", "portail : ignoreLaRevocation, sansVerification, contourneSansSW", async (t) => {
  const portail = (page, options) => page.evaluate((o) => window.banc.ouvrirLePortail(o), options);
  const cas = {
    ignoreLaRevocation: async ({ origine, contexte }) => {
      const page = await installerEtControler(t, contexte);
      origine.publier(v2({ plancher: 2 }));
      const r = await portail(page, { delaiVerificationMs: 8000, mutants: { ignoreLaRevocation: true } });
      return { tient: r.autorise === false, detail: `${r.autorise ? "autorise" : "refuse"} (${r.fraicheur})` };
    },
    sansVerification: async ({ contexte }) => {
      const page = await installerEtControler(t, contexte);
      await page.evaluate(async () => (await caches.open("reserve-pub-0001")).put("/spike/lib-importscripts.js", new Response("altere")));
      const r = await portail(page, { mutants: { sansVerification: true } });
      return { tient: r.autorise === false, detail: `${r.autorise ? "autorise" : "refuse"} (${r.code ?? ""})` };
    },
    contourneSansSW: async ({ contexte }) => {
      const page = await contexte.newPage();
      await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
      await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
      const r = await portail(page, { mutants: { contourneSansSW: true } });
      return { tient: r.autorise === false, detail: `${r.autorise ? "autorise" : "refuse"} (${r.cause})` };
    },
  };
  // Ici le MUTANT est dans `mutants` du portail (passé à l'appel) : le scénario nominal l'omet.
  for (const [nom, scenario] of Object.entries(cas)) {
    const nominal = await jouer(t, v1(), async (ctx) => {
      // nominal : mêmes étapes, sans le mutant
      if (nom === "ignoreLaRevocation") {
        const page = await installerEtControler(t, ctx.contexte);
        ctx.origine.publier(v2({ plancher: 2 }));
        const r = await portail(page, { delaiVerificationMs: 8000 });
        return { tient: r.autorise === false, detail: `${r.autorise ? "autorise" : "refuse"} (${r.fraicheur})` };
      }
      if (nom === "sansVerification") {
        const page = await installerEtControler(t, ctx.contexte);
        await page.evaluate(async () => (await caches.open("reserve-pub-0001")).put("/spike/lib-importscripts.js", new Response("altere")));
        const r = await portail(page, {});
        return { tient: r.autorise === false, detail: `${r.autorise ? "autorise" : "refuse"} (${r.code ?? ""})` };
      }
      const page = await ctx.contexte.newPage();
      await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
      await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
      const r = await portail(page, {});
      return { tient: r.autorise === false, detail: `${r.autorise ? "autorise" : "refuse"} (${r.cause})` };
    });
    const mutant = await jouer(t, v1(), scenario);
    t.mesure(nom, { nominal, mutant });
    t.verifier(nominal.tient === true && mutant.tient === false, `${nom} : tenu en nominal (${nominal.detail}), rompu sous le mutant (${mutant.detail}) → TUÉ`);
  }
});

void MAUVAIS;
