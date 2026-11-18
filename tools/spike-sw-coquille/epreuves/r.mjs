// R — RETRAIT (constat MEDIUM 5) : script de retrait publié à la MÊME URL (installé, ATTEND, puis
// activé quand les clients disparaissent), onglets actifs, réseau coupé, interruption entre
// désinscription et suppression des caches, caches du produit SEULS supprimés, page courante contrôlée
// jusqu'à sa navigation, geste de la personne.
import { attendre, jusqua, ORIGINE_COQUILLE } from "../banc/cadre.mjs";
import { attendreEtat, cachesDe, majDepuisLaPage, v1, v2 } from "./aide.mjs";

export const epreuves = [];
const ajouter = (id, titre, run, extra = {}) => epreuves.push({ id, titre, run, ...extra });
const portail = (page, options = {}) => page.evaluate((o) => window.banc.ouvrirLePortail(o), options);
const attendreBanc = (page) => jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
const etatLocal = (page) => page.evaluate(async () => ({ regs: (await navigator.serviceWorker.getRegistrations()).length, caches: await caches.keys(), ctrl: navigator.serviceWorker.controller !== null }));

async function pret(t, generation = v1()) {
  const origine = await t.origineDe(generation);
  const contexte = await t.contexte();
  await t.installer(contexte);
  const page = await t.bancControle(contexte);
  await page.evaluate(async () => (await caches.open("autre-cache-sans-rapport")).put("/x", new Response("x")));
  return { origine, contexte, page };
}

ajouter("R1", "RETRAIT avec onglets actifs : installé puis EN ATTENTE ; l'onglet de session continue en v1 ; un nouvel onglet voit la révocation connue et REFUSE ; tous fermés → désinscription + caches du produit supprimés, autre cache conservé", async (t) => {
  const { origine, contexte, page: onglet1 } = await pret(t);
  const session = await onglet1.evaluate(async () => {
    const r = await window.banc.ouvrirLePortail();
    return { autorise: r.autorise };
  });
  t.verifier(session.autorise === true, "onglet 1 : session ouverte");
  origine.publier(v1({ retrait: true, sequence: 3 })); // MÊME URL /sw-coquille.mjs
  const onglet2 = await t.bancControle(contexte);
  await majDepuisLaPage(onglet2);
  t.verifier(await attendreEtat(onglet2, "waiting", "installed"), "le script de retrait s'installe et ATTEND (il n'a pas d'activation forcée)");
  const refus = await portail(onglet2, { delaiVerificationMs: 6000 });
  t.mesure("refusOnglet2", refus);
  t.verifier(refus.autorise === false && refus.code === "VAULT_COQUILLE_RESERVE_PERIMEE" && refus.crees === 0 && refus.fraicheur === "revocation-connue", "onglet 2 : retrait connu → REFUS PERIMEE, aucun Worker");
  const tardif = await onglet1.evaluate(() => window.banc.dialogue(window.__w, { type: "import-tardif" }));
  t.verifier(tardif.ok === true && tardif.lib === "tardive-v1", "onglet 1 : la session ouverte continue sans mélange (import tardif v1)");
  t.verifier((await cachesDe(onglet2)).includes("reserve-pub-0001"), "tant que des clients vivent, les caches ne sont pas supprimés (retrait en attente)");
  await onglet1.close();
  await onglet2.close();
  const onglet3 = await contexte.newPage();
  await onglet3.goto(ORIGINE_COQUILLE + "/spike/sans-coop.html");
  const fini = await jusqua(async () => (await etatLocal(onglet3)).regs === 0, { delaiMs: 20000 });
  const apres = await etatLocal(onglet3);
  t.mesure("apresRetrait", apres);
  t.verifier(Boolean(fini) && !apres.caches.some((n) => n.startsWith("reserve-")), "tous les clients fermés : désinscription et suppression des caches du produit");
  t.verifier(apres.caches.includes("autre-cache-sans-rapport"), "un cache qui n'appartient pas au produit est CONSERVÉ");
  t.mesure("pageCouranteEncoreControlee", apres.ctrl);
  t.note("La page ouverte pendant l'activation du retrait peut rester contrôlée jusqu'à sa prochaine navigation (valeur de pageCouranteEncoreControlee par moteur).");
});

ajouter("R2", "RETRAIT et réseau coupé : le script de retrait n'est jamais vu ; l'ancienne version reste servie et le dit (« non vérifiable ») — aucun retrait immédiat n'est promis", async (t) => {
  const { origine, page } = await pret(t);
  origine.publier(v1({ retrait: true, sequence: 3 }));
  await origine.arreter();
  const r = await portail(page, { delaiVerificationMs: 3000 });
  t.mesure("portail", r);
  t.verifier(r.autorise === true && r.fraicheur === "version-courante-non-verifiable", "réseau coupé : version servie, état « non vérifiable » (le retrait est invisible hors connexion : limite écrite)");
});

ajouter("R3", "INTERRUPTION ordre nominal (caches d'abord, désinscription ensuite) coupée au milieu : le SW de retrait reste actif, la page le reconnaît (PERIMEE, retrait) et le geste termine", async (t) => {
  const { origine, contexte, page } = await pret(t);
  origine.publier(v1({ retrait: true, sequence: 3, faute: { interrompreRetraitApresDesinscription: true } }));
  await majDepuisLaPage(page);
  await attendreEtat(page, "waiting", "installed");
  await page.close();
  const p = await contexte.newPage();
  await p.goto(ORIGINE_COQUILLE + "/spike/banc.html");
  await attendreBanc(p);
  const etat = await jusqua(async () => {
    const e = await etatLocal(p);
    return !e.caches.some((n) => n.startsWith("reserve-")) ? e : null;
  }, { delaiMs: 20000 });
  t.mesure("apresInterruption", etat);
  t.verifier(Boolean(etat) && etat.regs === 1, "interruption : caches supprimés, inscription RESTÉE (retrait inachevé)");
  await p.reload();
  await attendreBanc(p);
  const r = await portail(p, { delaiVerificationMs: 2000 });
  t.mesure("portailApres", r);
  t.verifier(r.autorise === false && r.code === "VAULT_COQUILLE_RESERVE_PERIMEE" && r.cause === "retrait" && r.crees === 0, "le portail reconnaît le SW de retrait actif (par le contrôleur, ou par l'inscription active quand le moteur ne donne pas de contrôleur : Firefox) : PERIMEE (retrait), aucun Worker");
  const fin = await p.evaluate(() => window.banc.retirerLaCopie());
  const apres = await etatLocal(p);
  t.mesure("apresGeste", { fin, apres });
  t.verifier(apres.regs === 0, "le geste « Retirer la copie » termine le retrait inachevé (idempotent)");
});

ajouter("R4", "INTERRUPTION ordre inverse (désinscription d'abord) : caches orphelins SANS inscription ; jamais servis ; nettoyés à la prochaine activation (version suivante)", async (t) => {
  const { origine, contexte, page } = await pret(t);
  origine.publier(v1({ retrait: true, sequence: 3, variante: { retraitDesinscritAvant: true }, faute: { interrompreRetraitApresDesinscription: true } }));
  await majDepuisLaPage(page);
  await attendreEtat(page, "waiting", "installed");
  await page.close();
  const p = await contexte.newPage();
  await p.goto(ORIGINE_COQUILLE + "/spike/sans-coop.html");
  const etat = await jusqua(async () => ((await etatLocal(p)).regs === 0 ? await etatLocal(p) : null), { delaiMs: 20000 });
  t.mesure("apresInterruption", etat);
  t.verifier(Boolean(etat) && etat.caches.includes("reserve-pub-0001"), "interruption : inscription supprimée, cache orphelin RESTÉ");
  // Firefox : une nouvelle inscription sur une portée dont l'ancienne est « en cours de désinstallation »
  // attend la fin de ses clients (mesuré : `load` bloqué 30 s si la page reste ouverte). On ferme d'abord.
  await p.close();
  // Reprise : l'origine republie une version normale suivante ; l'orphelin est supprimé à l'activation.
  origine.publier(v2());
  const q = await contexte.newPage();
  q.goto(ORIGINE_COQUILLE + "/spike/enregistrer.html", { waitUntil: "commit" }).catch(() => {}); // Firefox : `goto` ne rend pas la main alors que la page a chargé (mesuré) ; on sonde l'état
  await jusqua(() => q.evaluate(() => document.documentElement.dataset.enregistrement === "actif"), { delaiMs: 30000 });
  const noms = await cachesDe(q);
  t.mesure("apresReprise", noms);
  t.verifier(!noms.includes("reserve-pub-0001") && noms.includes("reserve-pub-0002"), "l'orphelin est supprimé à l'activation de la version suivante (préfixe du produit)");
});

ajouter("R5", "GESTE « Retirer la copie » : unregister ET caches du produit ; la page courante reste contrôlée jusqu'à sa navigation ; MUTANTS (sans caches / tous les caches) tués", async (t) => {
  for (const [nom, mutants, attenduCaches, attenduAutre] of [["nominal", {}, false, true], ["mutant-sans-caches", { sansCaches: true }, true, true], ["mutant-tous-les-caches", { toutLesCaches: true }, false, false]]) {
    const { origine, contexte, page } = await pret(t);
    const r = await page.evaluate((m) => window.banc.retirerLaCopie(m), mutants);
    const apres = await etatLocal(page);
    t.mesure(`geste-${nom}`, { r, apres });
    if (nom === "nominal") {
      t.verifier(apres.regs === 0 && !apres.caches.some((n) => n.startsWith("reserve-")) && apres.caches.includes("autre-cache-sans-rapport"), "désinscrit, caches du produit supprimés, autre cache conservé");
      t.verifier(apres.ctrl === true, "la page courante reste contrôlée jusqu'à sa navigation");
      await page.reload();
      await attendreBanc(page).catch(() => {});
      const p2 = await page.evaluate(() => navigator.serviceWorker.controller === null);
      t.verifier(p2, "après navigation : plus de contrôleur (le portail refusera : aucun-controleur)");
    } else if (nom === "mutant-sans-caches") {
      t.verifier(attenduCaches && apres.caches.some((n) => n.startsWith("reserve-")), "MUTANT : sans suppression, le cache du produit reste (S12)");
    } else {
      t.verifier(!attenduAutre && !apres.caches.includes("autre-cache-sans-rapport"), "MUTANT : supprimer tous les caches efface aussi ceux qui ne sont pas au produit");
    }
    await contexte.close();
    await origine.arreter();
    t.origines.length = 0;
    t.origine = null;
  }
});

ajouter("R6", "404/410 ne retirent rien (S8) ; le retrait se publie à la MÊME URL ; la règle écrite : attendre la fermeture de tous les clients", async (t) => {
  const { origine, page } = await pret(t);
  for (const statut of [404, 410]) {
    origine.regler("/sw-coquille.mjs", { statut });
    await majDepuisLaPage(page);
  }
  origine.regler("/sw-coquille.mjs", null);
  t.verifier((await etatLocal(page)).regs === 1, "l'absence du script n'est pas un kill-switch : l'inscription survit");
  await attendre(0);
});
