// F — FRAÎCHEUR ET RÉVOCATION (constat HIGH 2). Les six états, leur effet sur le portail, les courses
// et les échecs d'installation. Le plancher non signé est un signal de révocation CONNUE, rien de plus.
import { ETATS, decider, etatDeFraicheur } from "../pages/portail.mjs";
import { attendreEtat, v1, v2 } from "./aide.mjs";
import { fabriquerGeneration } from "../banc/reserve.mjs";

export const epreuves = [];
const ajouter = (id, titre, run, extra = {}) => epreuves.push({ id, titre, run, ...extra });

async function pret(t, generation = v1()) {
  const origine = await t.origineDe(generation);
  const contexte = await t.contexte();
  await t.installer(contexte);
  const page = await t.bancControle(contexte);
  return { origine, contexte, page };
}
const portail = (page, options = {}) =>
  page.evaluate((o) => window.banc.ouvrirLePortail(o), options);

ajouter(
  "F0",
  "TABLE des états (fonction pure) : état de fraîcheur et décision du portail pour chaque combinaison d'observations",
  async (t) => {
    const attente = (sequence, plancher, retrait = false) => ({ sequence, plancher, retrait });
    const cas = [
      ["maj en cours", { maj: "en-cours", attente: null }],
      ["maj terminée, rien de nouveau", { maj: "ok", attente: null }],
      ["update() rejetée (réseau ou HTTP)", { maj: "echec", attente: null }],
      ["délai dépassé", { maj: "delai", attente: null }],
      ["non tentée (pas d'inscription)", { maj: "non-tentee", attente: null }],
      ["installation rejetée", { maj: "rejetee", attente: null }],
      ["attente, plancher ≤ courante", { maj: "ok", attente: attente(2, 1) }],
      ["attente, plancher > courante", { maj: "ok", attente: attente(2, 2) }],
      ["attente = script de retrait", { maj: "ok", attente: attente(3, 0, true) }],
      ["attente ET délai (le fait connu l'emporte)", { maj: "delai", attente: attente(2, 2) }],
      ["attente plus ANCIENNE (retour arrière)", { maj: "ok", attente: attente(0, 0) }],
    ];
    const table = cas.map(([nom, o]) => {
      const etat = etatDeFraicheur({ ...o, sequenceCourante: 1 });
      const decision = decider({
        controleur: true,
        sequencePage: 1,
        identite: { sequence: 1, retrait: false },
        verification: { manquants: [], alteres: [] },
        fraicheur: etat,
        controleurChange: false,
      });
      return { cas: nom, etat: etat.id, autorise: decision.autorise, code: decision.code };
    });
    t.mesure("table", table);
    t.mesure(
      "etats",
      Object.fromEntries(
        Object.values(ETATS).map((e) => [e.id, { texte: e.texte, portail: e.portail }]),
      ),
    );
    const par = Object.fromEntries(table.map((l) => [l.cas, l]));
    t.verifier(par["maj en cours"].etat === "verification-en-cours", "en cours");
    t.verifier(
      par["installation rejetée"].etat === "verification-echouee" &&
        par["installation rejetée"].autorise,
      "installation rejetée → vérification échouée, portail autorise avec avertissement",
    );
    t.verifier(
      par["update() rejetée (réseau ou HTTP)"].etat === "version-courante-non-verifiable" &&
        par["délai dépassé"].etat === "version-courante-non-verifiable",
      "update() rejetée ou délai → version courante non vérifiable",
    );
    t.verifier(
      par["attente, plancher ≤ courante"].etat === "mise-a-jour-prete" &&
        par["attente, plancher ≤ courante"].autorise,
      "mise à jour prête → autorise, bandeau",
    );
    t.verifier(
      [
        "attente, plancher > courante",
        "attente = script de retrait",
        "attente ET délai (le fait connu l'emporte)",
      ].every(
        (k) =>
          par[k].etat === "revocation-connue" &&
          !par[k].autorise &&
          par[k].code === "VAULT_COQUILLE_RESERVE_PERIMEE",
      ),
      "révocation connue (plancher ou retrait, même avec délai) → REFUS PERIMEE",
    );
    t.verifier(
      par["attente plus ANCIENNE (retour arrière)"].etat === "mise-a-jour-prete",
      "un retour arrière publié n'est PAS reconnu comme tel (pas d'anti-retour sans signature) : écrit comme limite",
    );
  },
);

ajouter(
  "F1",
  "Nominal : rien de nouveau → « version vérifiée », le portail autorise",
  async (t) => {
    const { page } = await pret(t);
    const r = await portail(page);
    t.mesure("portail", r);
    t.verifier(
      r.autorise === true && r.fraicheur === "version-verifiee" && r.crees === 1,
      "autorise, état « version-verifiee », un Worker créé",
    );
  },
);

ajouter(
  "F2",
  "COURSE : révocation publiée, script lent. Le portail qui ATTEND refuse ; celui qui ne bloque pas (mutant) autorise avant de savoir",
  async (t) => {
    const { origine, page } = await pret(t);
    origine.publier(v2({ plancher: 2 }));
    origine.regler("/sw-coquille.mjs", {
      delaiMs: 1200,
      corps: v2({ plancher: 2 }).script,
      type: "text/javascript",
    });
    const nominal = await portail(page, { delaiVerificationMs: 6000 });
    t.mesure("nominal", nominal);
    t.verifier(
      nominal.autorise === false &&
        nominal.code === "VAULT_COQUILLE_RESERVE_PERIMEE" &&
        nominal.crees === 0 &&
        nominal.fraicheur === "revocation-connue",
      "portail qui attend update() + installation : REFUS PERIMEE, aucun Worker créé",
    );
    t.verifier(
      nominal.ms >= 1000,
      `le refus a effectivement attendu la vérification (${nominal.ms} ms)`,
    );
    // Même scénario, portail qui lance update() sans l'attendre (délai 0) : la course est perdue.
    const { origine: o2, page: p2 } = await (async () => {
      t.origines.length = 0;
      await origine.arreter();
      t.origine = null;
      return pret(t);
    })();
    o2.regler("/sw-coquille.mjs", {
      delaiMs: 1200,
      corps: v2({ plancher: 2 }).script,
      type: "text/javascript",
    });
    o2.publier(v2({ plancher: 2 }));
    const mutant = await portail(p2, { delaiVerificationMs: 0 });
    t.mesure("mutantSansAttente", mutant);
    t.verifier(
      mutant.autorise === true && mutant.fraicheur === "version-courante-non-verifiable",
      "MUTANT (update() non attendue) : le portail autorise une version révoquée — la garde « attendre » est nécessaire",
    );
  },
);

ajouter(
  "F3",
  "Installation rejetée : update() résolue SANS nouveau Worker ; état « vérification échouée » ; le portail n'annonce jamais « à jour »",
  async (t) => {
    const { origine, page } = await pret(t);
    origine.publier(v2());
    origine.regler("/spike/lib.mjs", { corps: 'export const LIB = "trafique";\n' });
    const r = await portail(page, { delaiVerificationMs: 8000 });
    t.mesure("portail", r);
    t.verifier(
      r.maj === "rejetee" && r.fraicheur === "verification-echouee" && r.autorise === true,
      "installation rejetée détectée → vérification échouée, autorisé avec avertissement",
    );
    t.verifier(
      r.fraicheur !== "version-verifiee",
      "jamais « version vérifiée » sur update() résolue seule",
    );
  },
);

ajouter(
  "F3b",
  "Installation LENTE : update() résout avant ou après la fin de l'installation ? (chronologie brute), puis état « mise à jour prête »",
  async (t) => {
    const { origine, page } = await pret(t);
    origine.publier(v2({ faute: { ralentirInstallationMs: 1500 } }));
    const r = await portail(page, { delaiVerificationMs: 10000 });
    t.mesure("portail", r);
    t.verifier(
      r.fraicheur === "mise-a-jour-prete" && r.autorise === true,
      "après l'installation lente : « mise à jour prête » (le portail a attendu la fin d'installation, pas seulement update())",
    );
  },
);

ajouter(
  "F4",
  "Origine qui PEND (script du SW sans réponse) : le portail rend la main au délai, « non vérifiable », jamais un blocage",
  async (t) => {
    const { origine, page } = await pret(t);
    origine.regler("/sw-coquille.mjs", { pendre: true });
    const r = await portail(page, { delaiVerificationMs: 1500 });
    t.mesure("portail", r);
    t.verifier(
      r.autorise === true && r.fraicheur === "version-courante-non-verifiable" && r.maj === "delai",
      "autorise après le délai, état « non vérifiable » (cause : délai)",
    );
    t.verifier(
      r.ms >= 1400 && r.ms < 4000,
      `borné par DELAI_VERIFICATION_MS (${r.ms} ms pour 1500)`,
    );
  },
);

ajouter(
  "F5",
  "Réseau coupé (serveur arrêté) : update() rejetée, « non vérifiable », le portail autorise sans attendre le délai",
  async (t) => {
    const { origine, page } = await pret(t);
    await origine.arreter();
    const r = await portail(page, { delaiVerificationMs: 5000 });
    t.mesure("portail", r);
    t.verifier(
      r.autorise === true && r.fraicheur === "version-courante-non-verifiable" && r.maj === "echec",
      "hors connexion : non vérifiable, jamais « à jour »",
    );
    t.verifier(r.ms < 3000, `l'échec réseau est immédiat, pas le délai (${r.ms} ms)`);
  },
);

ajouter(
  "F6",
  "Révocation CONNUE : plancher > version courante → REFUS ; plancher ≤ courante → autorise ; script de retrait en attente → REFUS",
  async (t) => {
    const cas = [
      ["plancher-superieur", () => v2({ plancher: 2 }), false, "revocation-connue"],
      ["plancher-egal", () => v2({ plancher: 1 }), true, "mise-a-jour-prete"],
      ["retrait", () => v1({ retrait: true, sequence: 3 }), false, "revocation-connue"],
    ];
    for (const [nom, generation, autorise, etat] of cas) {
      const { origine, page, contexte } = await pret(t);
      origine.publier(generation());
      const r = await portail(page, { delaiVerificationMs: 8000 });
      t.mesure(nom, r);
      t.verifier(
        r.autorise === autorise &&
          r.fraicheur === etat &&
          (autorise || r.code === "VAULT_COQUILLE_RESERVE_PERIMEE") &&
          (autorise || r.crees === 0),
        `${nom} : ${etat}, ${autorise ? "autorisé" : "REFUS PERIMEE sans Worker"}`,
      );
      await contexte.close();
      await origine.arreter();
      t.origines.length = 0;
      t.origine = null;
    }
  },
);

ajouter(
  "F7",
  "Révocation connue APRÈS le déverrouillage : la session n'est pas tuée (écrit), l'état passe en « révocation connue »",
  async (t) => {
    const { origine, page } = await pret(t);
    origine.regler("/sw-coquille.mjs", {
      delaiMs: 1500,
      corps: v2({ plancher: 2 }).script,
      type: "text/javascript",
    });
    origine.publier(v2({ plancher: 2 }));
    const r = await portail(page, { delaiVerificationMs: 200 });
    t.verifier(
      r.autorise === true && r.fraicheur === "version-courante-non-verifiable",
      "délai court : session ouverte en « non vérifiable »",
    );
    await page.evaluate(() => window.banc.dialogue(window.__w, { type: "cle" }));
    await attendreEtat(page, "waiting", "installed", 20000);
    const plus = await page.evaluate(async () => {
      const reg = await navigator.serviceWorker.getRegistration("/");
      await window.banc.attendre(100);
      const attente = reg.waiting
        ? await window.banc.interroger("version", 2000, reg.waiting)
        : null;
      const etat = window.banc.portail.etatDeFraicheur({
        maj: "ok",
        attente,
        sequenceCourante: window.banc.SEQUENCE,
      });
      const cle = await window.banc.dialogue(window.__w, { type: "utiliser-cle" });
      return { etat: etat.id, cleOk: cle.ok };
    });
    t.mesure("plusTard", plus);
    t.verifier(
      plus.etat === "revocation-connue" && plus.cleOk === true,
      "l'état bascule en « révocation connue » (bandeau), la session ouverte n'est pas interrompue",
    );
  },
);

ajouter(
  "F8",
  "LIMITES du plancher non signé : une origine hostile peut REFUSER (plancher 99 = déni de service) et PUBLIER UN RETOUR ARRIÈRE (non reconnu)",
  async (t) => {
    const { origine, page, contexte } = await pret(t);
    origine.publier(v2({ plancher: 99 }));
    const deni = await portail(page, { delaiVerificationMs: 8000 });
    t.mesure("deniDeService", deni);
    t.verifier(
      deni.autorise === false && deni.code === "VAULT_COQUILLE_RESERVE_PERIMEE",
      "plancher 99 publié par l'origine : refus (le pire effet : déni de service, déjà à portée de l'origine qui cesse de servir)",
    );
    await contexte.close();
    await origine.arreter();
    t.origines.length = 0;
    t.origine = null;
    const p2 = await pret(t, v1({ sequence: 5 }));
    p2.origine.publier(fabriquerGeneration({ sequence: 2, plancher: 0 }));
    // page v5 (SEQUENCE 5) : le banc lit SEQUENCE du module servi ; l'origine propose la v2 (plus ANCIENNE)
    const retour = await portail(p2.page, { delaiVerificationMs: 8000 });
    t.mesure("retourArriere", retour);
    t.verifier(
      retour.autorise === true && retour.fraicheur === "mise-a-jour-prete",
      "une version PLUS ANCIENNE publiée par l'origine est présentée comme « prête » et ne déclenche aucun refus : aucune protection contre le retour arrière ni le gel sans racine de confiance indépendante",
    );
  },
);
