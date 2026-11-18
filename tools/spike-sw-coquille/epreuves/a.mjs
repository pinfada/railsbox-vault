// A — ACTIVATION ET PLUSIEURS ONGLETS (constat HIGH 1). Règle éprouvée : pas de skipWaiting, pas de
// claim ; la mise à jour s'applique quand TOUS les clients de l'ancienne version ont disparu.
// Invariant vérifié à chaque étape : une page, son contrôleur et ses Workers sont de la MÊME version.
import { jusqua, attendre, ORIGINE_COQUILLE } from "../banc/cadre.mjs";
import { attendreEtat, cachesDe, majDepuisLaPage, v1, v2 } from "./aide.mjs";

export const epreuves = [];
const ajouter = (id, titre, run, extra = {}) => epreuves.push({ id, titre, run, ...extra });

async function session(t, contexte, nom) {
  const page = await t.bancControle(contexte);
  await page.evaluate(() => window.banc.surveillerLesChangements());
  // La page ouvre le portail (spike) puis tient une « session » : un Worker et une clé non extractible.
  const portail = await page.evaluate(async () => {
    const r = await window.banc.portail.ouvrirLePortail({
      sequencePage: window.banc.SEQUENCE,
      creerLeTravailleur: () => window.banc.creerTravailleur(),
    });
    if (!r.autorise) return { autorise: false, code: r.code, cause: r.cause };
    window.__w = r.travailleur;
    const cle = await window.banc.dialogue(r.travailleur, { type: "cle" });
    return { autorise: true, cle, fraicheur: r.fraicheur.id };
  });
  t.verifier(
    portail.autorise === true && portail.cle?.extractible === false,
    `${nom} : portail franchi, session ouverte avec une clé non extractible`,
  );
  return page;
}
const etat = (page) =>
  page.evaluate(async () => {
    const ctrl = await window.banc.interroger("version");
    const tardif = window.__w
      ? await window.banc.dialogue(window.__w, { type: "import-tardif" })
      : null;
    const cle = window.__w
      ? await window.banc.dialogue(window.__w, { type: "utiliser-cle" })
      : null;
    const neuf = window.banc.creerTravailleur();
    const bonjour = await window.banc.dialogue(neuf, { type: "bonjour" });
    neuf.terminate();
    return {
      pageSeq: window.banc.SEQUENCE,
      ctrlSeq: ctrl?.sequence,
      tardif,
      cleOk: cle?.ok,
      workerNeuf: bonjour.sequence,
      changements: window.banc.journalDesChangements.length,
    };
  });
const coherent = (e) =>
  e.pageSeq === e.ctrlSeq &&
  e.workerNeuf === e.pageSeq &&
  (e.tardif === null || e.tardif.sequence === e.pageSeq);

ajouter(
  "A1",
  "PROTOCOLE : deux onglets, mise à jour publiée, import tardif → aucun mélange ; la v2 ne s'applique qu'après la fermeture de TOUS les clients",
  async (t) => {
    const origine = await t.origineDe(v1());
    const contexte = await t.contexte();
    await t.installer(contexte);
    const onglet1 = await session(t, contexte, "onglet 1");
    const onglet2 = await t.bancControle(contexte);
    await onglet2.evaluate(() => window.banc.surveillerLesChangements());
    origine.publier(v2());
    await majDepuisLaPage(onglet2);
    t.verifier(
      await attendreEtat(onglet2, "waiting", "installed"),
      "la v2 est installée et attend",
    );
    await attendre(500);
    const e1 = await etat(onglet1);
    const e2 = await etat(onglet2);
    t.mesure("avecAttente", { onglet1: e1, onglet2: e2 });
    t.verifier(
      e1.changements === 0 && e2.changements === 0,
      "aucun controllerchange dans aucun onglet",
    );
    t.verifier(
      coherent(e1) && e1.pageSeq === 1 && e1.tardif?.lib === "tardive-v1" && e1.cleOk === true,
      "onglet 1 : import tardif en v1, clé de session intacte, Worker neuf en v1",
    );
    t.verifier(
      coherent(e2) && e2.pageSeq === 1,
      "onglet 2 (navigation neuve APRÈS la publication) : toujours v1, cohérent",
    );
    // Fermer l'onglet 2 seulement : l'onglet 1 retient la v1, l'attente demeure.
    await onglet2.close();
    const onglet3 = await t.bancControle(contexte);
    const e3 = await onglet3.evaluate(async () => ({
      seq: window.banc.SEQUENCE,
      ctrl: (await window.banc.interroger("version")).sequence,
      insc: await window.banc.etatDInscription(),
    }));
    t.mesure("ongletFerme", e3);
    t.verifier(
      e3.seq === 1 && e3.ctrl === 1 && e3.insc.waiting === "installed",
      "tant qu'UN client de la v1 vit, la v2 reste en attente (règle : tous les clients)",
    );
    // Fermer TOUS les clients, puis navigation neuve.
    await onglet1.close();
    await onglet3.close();
    const final = await t.bancControle(contexte);
    const appliquee = await jusqua(
      async () => {
        await final.reload();
        await jusqua(() => final.evaluate(() => document.documentElement.dataset.banc === "pret"));
        const r = await final.evaluate(async () => ({
          seq: window.banc.SEQUENCE,
          ctrl: (await window.banc.interroger("version"))?.sequence,
          insc: await window.banc.etatDInscription(),
        }));
        return r.ctrl === 2 ? r : null;
      },
      { delaiMs: 20000, pasMs: 500 },
    );
    t.mesure("toutesFermees", appliquee);
    t.verifier(
      Boolean(appliquee) && appliquee.seq === 2 && appliquee.insc.waiting === null,
      "après la fermeture de tous les clients : la page ET le contrôleur sont en v2",
    );
    const noms = await cachesDe(final);
    t.mesure("cachesApres", noms);
    t.verifier(
      JSON.stringify(noms) === JSON.stringify(["reserve-pub-0002"]),
      "le cache de la v1 est supprimé à l'activation de la v2",
    );
    void ORIGINE_COQUILLE;
  },
);

ajouter(
  "A2",
  "MUTANT skipWaiting : le même scénario MÉLANGE les versions dans l'onglet 1 (l'épreuve A1 le tue)",
  async (t) => {
    const origine = await t.origineDe(v1());
    const contexte = await t.contexte();
    await t.installer(contexte);
    const onglet1 = await session(t, contexte, "onglet 1");
    const onglet2 = await t.bancControle(contexte);
    origine.publier(v2({ variante: { skipWaiting: true } }));
    await majDepuisLaPage(onglet2);
    await jusqua(
      () =>
        onglet1.evaluate(
          async () =>
            (
              await window.banc.interroger(
                "version",
                800,
                (await navigator.serviceWorker.getRegistration("/")).active,
              )
            )?.sequence === 2,
        ),
      { delaiMs: 15000 },
    );
    await attendre(500);
    const e1 = await etat(onglet1);
    t.mesure("avecSkipWaiting", e1);
    t.verifier(
      !coherent(e1),
      "MÉLANGE : l'onglet 1 (page v1, clé ouverte) voit un contrôleur ou un Worker d'une autre version",
    );
    t.verifier(
      e1.changements >= 1,
      "le mélange est précédé d'un controllerchange (observable par la page)",
    );
  },
);

ajouter(
  "A3",
  "Pas de claim : la page qui enregistre le SW n'est PAS contrôlée ; MUTANT claim : elle l'est, en cours de vie",
  async (t) => {
    for (const [nom, variante] of [
      ["nominal", {}],
      ["mutant-claim", { claim: true }],
    ]) {
      const origine = await t.origineDe(v1({ variante }));
      const contexte = await t.contexte();
      const page = await contexte.newPage();
      await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
      await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
      await page.evaluate(() => window.banc.enregistrer());
      await attendre(600);
      const controlee = await page.evaluate(() => navigator.serviceWorker.controller !== null);
      t.mesure(`controleeApresEnregistrement-${nom}`, controlee);
      t.verifier(
        controlee === (nom === "mutant-claim"),
        nom === "nominal"
          ? "sans claim, la page qui enregistre reste NON contrôlée (premier contrôle = navigation suivante)"
          : "MUTANT : avec claim, la page non contrôlée le devient en cours de vie",
      );
      await contexte.close();
      await origine.arreter();
      t.origines.length = 0;
      t.origine = null;
    }
  },
);

ajouter(
  "A4",
  "Un seul onglet : navigation vers autre chose puis retour — le contrôleur et la page restent d'accord",
  async (t) => {
    const origine = await t.origineDe(v1());
    const contexte = await t.contexte();
    await t.installer(contexte);
    const page = await t.bancControle(contexte);
    origine.publier(v2());
    await majDepuisLaPage(page);
    await attendreEtat(page, "waiting", "installed");
    const mesures = [];
    for (const [nom, aller] of [
      ["rechargement", () => page.reload()],
      [
        "aller-retour via about:blank",
        async () => {
          await page.goto("about:blank");
          await page.goto(ORIGINE_COQUILLE + "/spike/banc.html");
        },
      ],
    ]) {
      await aller();
      await jusqua(() => page.evaluate(() => document.documentElement.dataset.banc === "pret"));
      const r = await page.evaluate(async () => ({
        page: window.banc.SEQUENCE,
        ctrl: (await window.banc.interroger("version"))?.sequence,
      }));
      mesures.push({ nom, ...r });
      t.verifier(
        r.page === r.ctrl,
        `${nom} : page et contrôleur de même version (${r.page}/${r.ctrl})`,
      );
    }
    t.mesure("navigations", mesures);
    t.note(
      "Selon le moteur, quitter la page peut laisser le client « en vie » (v1 conservée) ou le libérer (v2 appliquée) : l'invariant tient dans les deux cas ; la RÈGLE écrite est « tous les clients fermés », pas « une navigation ».",
    );
  },
);
