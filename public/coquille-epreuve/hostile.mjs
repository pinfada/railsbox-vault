// L'APPLICATION MALVEILLANTE de la tranche 1 de #24 (#161, ADR 0028).
//
// Elle est servie sur l'ORIGINE APPLICATIVE par `tools/serve.mjs --role app`, encadrée par la
// coquille de produit comme un document Rails le serait, et elle connaît le contrat aussi bien que
// la coquille : elle s'annonce normalement, obtient son port restreint, puis tente la LISTE COMPLÈTE
// des gestes que l'issue #24 interdit, plus les tentatives de topologie de l'ADR 0002.
//
// Elle n'est JAMAIS publiée : `tools/publier-arborescences.mjs` retire `public/coquille-epreuve/`
// avec son motif, et `tests/unit/publication-arborescences.test.mjs` le relit.
//
// ## Ce que la fixture ne décide pas
//
// Aucune sonde ne rend « réussi » ou « échoué » : elle rend ce qu'elle a OBSERVÉ, et l'épreuve
// juge. C'est la discipline des bancs du dépôt, et elle a une conséquence utile ici : la même
// fixture sert d'attaquant sur l'origine applicative et de TÉMOIN POSITIF sur l'origine de
// confiance, sans une ligne de différence. Un relevé tout vert obtenu par une sonde cassée se voit
// alors immédiatement — le témoin, lui, ne serait pas vert.

import {
  TYPES_APPLICATIFS,
  TYPES_PRIVILEGIES,
  decoderMessage,
  enveloppeDeMessage,
} from "/src/coquille/contrat-de-messages.mjs";
import { GESTES_REFUSES } from "/src/coquille/admission-applicative.mjs";
import SONDES_DE_TOPOLOGIE from "./hostile-topologie.mjs";
import { DELAI_SONDE_MS, NOMBRE_DE_SONDES } from "./marqueurs.mjs";

const noeudEtat = document.querySelector("#hostile-etat");
const noeudRapport = document.querySelector("#hostile-rapport");

/** Délai d'attente d'une réponse sur le port. Court : la coquille répond ou elle ne répond pas. */
const DELAI_PORT_MS = 1000;

let portRestreint = null;
/** @type {{ rendre: (valeur: unknown) => void, servi: boolean }[]} */
const attentes = [];

/**
 * TOUT ce qui franchit le port, dans les deux sens, sérialisé.
 *
 * L'attaquant enregistre : c'est ce qu'un attaquant fait, et c'est ce qui permet à l'épreuve de
 * FOUILLER le trafic à la recherche des octets des clés au lieu de croire la coquille sur parole.
 * `deverrouillage-frontiere.spec.mjs` a cette discipline depuis #22 ; la revue de la PR #166 a
 * relevé qu'elle manquait ici.
 */
const journalDuPort = [];

/** Borne du journal : l'attaquant enregistre, il ne fait pas exploser sa propre page. */
const JOURNAL_MAXIMUM = 200;

function journaliser(sens, valeur) {
  if (journalDuPort.length >= JOURNAL_MAXIMUM) return;
  try {
    journalDuPort.push(`${sens} ${JSON.stringify(valeur)}`);
  } catch {
    journalDuPort.push(`${sens} <non sérialisable>`);
  }
}

function surMessageDuPort(event) {
  journaliser("reçu", event.data);
  const attente = attentes.find((candidate) => !candidate.servi);
  if (!attente) return;
  attente.servi = true;
  attente.rendre(event.data);
}

/** Réclame le port restreint par une annonce en règle, et attend l'octroi. */
function obtenirLePort() {
  return new Promise((rendre) => {
    window.addEventListener("message", (event) => {
      const decode = decoderMessage(event.data);
      if (!decode.ok || decode.type !== TYPES_APPLICATIFS.octroi || !event.ports[0]) return;
      const port = event.ports[0];
      port.addEventListener("message", surMessageDuPort);
      port.start();
      rendre(port);
    });
    parent.postMessage(enveloppeDeMessage(TYPES_APPLICATIFS.annonce), "*");
    setTimeout(() => rendre(null), DELAI_SONDE_MS);
  });
}

/** Poste un message BRUT sur le port et rend la réponse, ou un constat de silence. */
function poster(brut) {
  return posterAvecTransfert(brut, []);
}

/** Le même, en TRANSFÉRANT des objets : c'est la sonde qui mesure ce que le port accepte. */
function posterAvecTransfert(brut, transferes) {
  return new Promise((rendre) => {
    const attente = { rendre, servi: false };
    attentes.push(attente);
    journaliser("émis", brut);
    portRestreint.postMessage(brut, transferes);
    setTimeout(() => {
      if (attente.servi) return;
      attente.servi = true;
      rendre({ type: "vault.coquille.aucune-reponse" });
    }, DELAI_PORT_MS);
  });
}

/**
 * Tente un geste sur le port et rend le CODE reçu. Un silence est un résultat à part : l'issue #24
 * exige « un refus typé, jamais un silence », et confondre les deux ferait passer un silence pour
 * une frontière.
 */
async function tenter(brut) {
  if (portRestreint === null) return { resultat: "sans-port", code: null };
  const reponse = await poster(brut);
  const decode = decoderMessage(reponse);
  if (!decode.ok) return { resultat: "silence", code: null, detail: JSON.stringify(reponse) };
  if (decode.type === TYPES_APPLICATIFS.refus) {
    return { resultat: "refuse", code: decode.message.code, detail: decode.message.message };
  }
  return { resultat: "aboutit", code: null, detail: JSON.stringify(decode.message) };
}

// --- Sondes du PORT -------------------------------------------------------------------------------

let compteurDeCorrelation = 0;

/** Une requête d'état en règle, avec un identifiant de corrélation neuf. */
function requeteDEtat() {
  compteurDeCorrelation += 1;
  return enveloppeDeMessage(TYPES_APPLICATIFS.etat, {
    correlation: `hostile-${compteurDeCorrelation}`,
  });
}

/** Le geste ADMIS. C'est le témoin positif du contrat : sans lui, tout refuser ne prouverait rien. */
const SONDE_ADMISE = {
  nom: "geste-admis-etat",
  cible: "contrat",
  intention: "obtenir l'état du volume, seul geste de la liste d'admission",
  async run() {
    if (portRestreint === null) return { resultat: "sans-port", detail: "aucun port octroyé" };
    const reponse = await poster(requeteDEtat());
    const decode = decoderMessage(reponse);
    if (!decode.ok || decode.type !== TYPES_APPLICATIFS.etatReponse) {
      return { resultat: "refuse", detail: JSON.stringify(reponse) };
    }
    return { resultat: "aboutit", detail: JSON.stringify(decode.message) };
  },
};

/**
 * N requêtes en vol EN MÊME TEMPS, chacune avec sa corrélation. Elle mesure ce que la revue de la
 * PR #166 a trouvé : deux requêtes en vol, une seule réponse, l'autre muette. Le geste ADMIS était
 * le seul à rester silencieux, sur une frontière qui écrit quatre fois « jamais un silence ».
 *
 * Elle n'attend pas ses réponses une par une : ce serait exactement le cas que l'ancien code
 * servait, et la sonde ne mesurerait rien.
 */
const SONDE_CONCURRENTE = {
  nom: "gestes-admis-concurrents",
  cible: "contrat",
  intention: "poster plusieurs requêtes d'état EN VOL et exiger autant de réponses appariées",
  async run() {
    if (portRestreint === null) return { resultat: "sans-port", detail: "aucun port octroyé" };
    const envoyees = [requeteDEtat(), requeteDEtat(), requeteDEtat(), requeteDEtat()];
    const reponses = await Promise.all(envoyees.map((requete) => poster(requete)));
    const rendues = reponses
      .map((reponse) => decoderMessage(reponse))
      .filter((decode) => decode.ok && decode.type === TYPES_APPLICATIFS.etatReponse)
      .map((decode) => decode.message.correlation);
    const appariees = envoyees.every((requete) => rendues.includes(requete.correlation));
    return {
      resultat: appariees && rendues.length === envoyees.length ? "aboutit" : "silence",
      detail: `${rendues.length}/${envoyees.length} réponses ; appariées : ${appariees}`,
    };
  },
};

/** Les dix gestes de la liste de refus, tentés un par un, dans l'ordre de la liste. */
const SONDES_INTERDITES = GESTES_REFUSES.map((refuse) => ({
  nom: `refus-${refuse.type.replace("vault.coquille.", "")}`,
  cible: "coquille",
  intention: refuse.geste,
  codeAttendu: refuse.code,
  run: () => tenter(enveloppeDeMessage(refuse.type)),
}));

// --- Le JETON DU HARNAIS : public, lisible, et inutilisable d'ici -------------------------------
//
// Le jeton n'est pas un secret. C'est une porte de DISCIPLINE (`tests/unit/harnais-portes.test.mjs`)
// et, sans étape de construction, une constante que le produit compare existe forcément dans le code
// servi : `src/vm/cle-de-volume.mjs` la porte, et les deux origines la servent. La revue de la PR
// #166 l'a relevé, et la réponse n'est pas de la cacher — c'est de MONTRER que la connaître ne sert
// à rien depuis l'origine applicative, parce que le port privilégié où elle s'emploie n'y est pas
// atteignable.
//
// La fixture le lit donc chez elle, puis tente de s'en servir par tous les chemins qu'elle a.

/** Le jeton, tel que la fixture l'a lu dans le fichier servi. `null` tant qu'elle ne l'a pas. */
let jetonDuHarnais = null;

const SONDES_DU_HARNAIS = [
  {
    nom: "lecture-du-jeton-du-harnais",
    cible: "origine-propre",
    intention: "lire le jeton du harnais dans le module servi par sa propre origine",
    async run() {
      const source = await (await fetch("/src/vm/cle-de-volume.mjs")).text();
      const [, valeur] = source.match(/HARNAIS_CLE_JETON = "([^"]+)"/) ?? [];
      if (!valeur) return { resultat: "refuse", detail: "jeton introuvable dans le module servi" };
      jetonDuHarnais = valeur;
      // C'est un ABOUTISSEMENT, et c'est voulu : le jeton est public. Ce que les sondes suivantes
      // mesurent, c'est qu'il ne sert à rien de le connaître.
      return { resultat: "aboutit", detail: `jeton lu (${valeur.length} caractères)` };
    },
  },
  {
    nom: "jeton-du-harnais-sur-le-port-restreint",
    cible: "coquille",
    intention: "déverrouiller le volume en présentant le VRAI jeton sur le port restreint",
    run: () =>
      tenter(
        enveloppeDeMessage(TYPES_PRIVILEGIES.deverrouiller, { jeton: jetonDuHarnais ?? "absent" }),
      ),
  },
  {
    nom: "jeton-du-harnais-sur-window",
    cible: "coquille",
    intention: "déverrouiller le volume en présentant le VRAI jeton sur `window`",
    async run() {
      // La coquille n'accepte QUE l'annonce sur `window` ; tout le reste est compté et jeté. Le
      // verdict se rend depuis la coquille : son état doit rester celui d'avant.
      parent.postMessage(
        enveloppeDeMessage(TYPES_PRIVILEGIES.deverrouiller, { jeton: jetonDuHarnais ?? "absent" }),
        "*",
      );
      await new Promise((rendre) => setTimeout(rendre, DELAI_PORT_MS));
      return { resultat: "refuse", detail: "aucun canal n'écoute ce type sur `window`" };
    },
  },
  {
    nom: "url-de-la-coquille-inconnue",
    cible: "coquille",
    intention: "apprendre l'URL de la coquille pour y rejouer le jeton en paramètre",
    run() {
      // `Referrer-Policy: no-referrer` (ADR 0022) est servi sur les documents de la coquille : le
      // document encadré ne sait même pas d'où il est encadré. Ce n'est pas la frontière — la
      // sandbox l'est —, c'est une porte de moins.
      const referent = document.referrer;
      return referent
        ? { resultat: "aboutit", detail: `referrer : ${referent}` }
        : {
            resultat: "refuse",
            detail: "aucun referrer : l'URL de la coquille est inconnue d'ici",
          };
    },
  },
];

/** Les cinq tentatives contre l'ENCODAGE du contrat, et la tentative de canal privilégié. */
const SONDES_DE_CONTRAT = [
  {
    nom: "type-privilegie-sur-port-restreint",
    cible: "coquille",
    intention: "réclamer le canal privilégié par le port de l'application",
    run: () => tenter(enveloppeDeMessage(TYPES_PRIVILEGIES.deverrouiller, { jeton: "forge" })),
  },
  {
    nom: "message-non-objet",
    cible: "coquille",
    intention: "poster un message qui n'est pas un objet",
    run: () => tenter(42),
  },
  {
    nom: "champ-en-trop",
    cible: "coquille",
    intention: "faire servir une requête admise portant un champ que le contrat ne nomme pas",
    run: () =>
      tenter({
        ...requeteDEtat(),
        charge: "x".repeat(4096),
        imbrique: { a: [1, 2] },
      }),
  },
  {
    nom: "correlation-absente",
    cible: "coquille",
    intention: "poster une requête admise sans identifiant de corrélation",
    run: () => tenter(enveloppeDeMessage(TYPES_APPLICATIFS.etat)),
  },
  {
    nom: "correlation-dupliquee",
    cible: "coquille",
    intention: "réemployer un identifiant de corrélation déjà en vol",
    async run() {
      if (portRestreint === null) return { resultat: "sans-port", detail: "aucun port octroyé" };
      const requete = requeteDEtat();
      // Les deux partent SANS attendre : sinon la première serait servie et rendue avant que la
      // seconde arrive, et il n'y aurait jamais deux fois le même identifiant EN VOL.
      //
      // Les DEUX réponses sont examinées, et non « la seconde » : le refus est rendu tout de suite,
      // l'état après un aller-retour vers le Worker, si bien que le refus arrive le PREMIER. Une
      // sonde qui supposerait l'ordre d'émission mesurerait sa propre file d'attente.
      const reponses = await Promise.all([poster(requete), poster({ ...requete })]);
      const refus = reponses
        .map((reponse) => decoderMessage(reponse))
        .filter((decode) => decode.ok && decode.type === TYPES_APPLICATIFS.refus);
      if (refus.length === 1) {
        return {
          resultat: "refuse",
          code: refus[0].message.code,
          detail: refus[0].message.message,
        };
      }
      return { resultat: "aboutit", detail: JSON.stringify(reponses) };
    },
  },
  {
    nom: "transferable-sur-le-port-restreint",
    cible: "coquille",
    intention: "TRANSFÉRER un port et un tampon à la coquille sur le port restreint",
    async run() {
      if (portRestreint === null) return { resultat: "sans-port", detail: "aucun port octroyé" };
      const canal = new MessageChannel();
      const reponse = await posterAvecTransfert(requeteDEtat(), [canal.port2, new ArrayBuffer(8)]);
      const decode = decoderMessage(reponse);
      if (decode.ok && decode.type === TYPES_APPLICATIFS.refus) {
        return { resultat: "refuse", code: decode.message.code, detail: decode.message.message };
      }
      return { resultat: "aboutit", detail: JSON.stringify(reponse) };
    },
  },
  {
    nom: "contrat-etranger",
    cible: "coquille",
    intention: "poster un message d'un autre contrat",
    run: () => tenter({ contrat: "autre-logiciel", version: 1, type: TYPES_APPLICATIFS.etat }),
  },
  {
    nom: "version-etrangere",
    cible: "coquille",
    intention: "poster une version du contrat que la coquille ne parle pas",
    run: () =>
      tenter({ contrat: "railsbox-vault-coquille", version: 99, type: TYPES_APPLICATIFS.etat }),
  },
  {
    nom: "type-inconnu",
    cible: "coquille",
    intention: "poster un type que ni l'admission ni la liste de refus ne nomment",
    run: () => tenter(enveloppeDeMessage("vault.coquille.geste-invente")),
  },
  {
    nom: "second-port-reclame",
    cible: "coquille",
    intention: "obtenir un second port en rejouant l'annonce",
    async run() {
      const second = await new Promise((rendre) => {
        const ecoute = (event) => {
          const decode = decoderMessage(event.data);
          if (decode.ok && decode.type === TYPES_APPLICATIFS.octroi && event.ports[0]) rendre(true);
        };
        window.addEventListener("message", ecoute);
        parent.postMessage(enveloppeDeMessage(TYPES_APPLICATIFS.annonce), "*");
        setTimeout(() => {
          window.removeEventListener("message", ecoute);
          rendre(false);
        }, DELAI_PORT_MS);
      });
      return second
        ? { resultat: "aboutit", detail: "un second port a été octroyé" }
        : { resultat: "refuse", detail: "annonce rejouée sans nouveau port" };
    },
  },
  {
    nom: "usurpation-iframe-imbriquee",
    cible: "coquille",
    intention: "faire annoncer une iframe imbriquée pour obtenir un port à sa place",
    async run() {
      const imbriquee = document.createElement("iframe");
      imbriquee.id = "iframe-usurpatrice";
      imbriquee.title = "iframe imbriquée usurpatrice";
      imbriquee.srcdoc = gabaritDUsurpation();
      const verdict = await new Promise((rendre) => {
        const ecoute = (event) => {
          if (event.data?.type !== "usurpation") return;
          window.removeEventListener("message", ecoute);
          rendre(event.data.obtenu);
        };
        window.addEventListener("message", ecoute);
        document.body.append(imbriquee);
        setTimeout(() => rendre(false), DELAI_SONDE_MS);
      });
      imbriquee.remove();
      return verdict
        ? { resultat: "aboutit", detail: "port octroyé à une iframe imbriquée" }
        : { resultat: "refuse", detail: "annonce d'une iframe imbriquée refusée" };
    },
  },
];

/**
 * Document de l'iframe usurpatrice. Elle porte la MÊME origine que la fixture — c'est tout l'intérêt
 * de la sonde : seule la vérification de la fenêtre émettrice peut la distinguer du cadre.
 */
function gabaritDUsurpation() {
  const annonce = JSON.stringify(enveloppeDeMessage(TYPES_APPLICATIFS.annonce));
  const octroi = TYPES_APPLICATIFS.octroi;
  return (
    `<!doctype html><meta charset="utf-8"><script>` +
    `window.addEventListener("message", (e) => {` +
    `  if (e.data && e.data.type === ${JSON.stringify(octroi)}) {` +
    `    parent.postMessage({ type: "usurpation", obtenu: true }, "*");` +
    `  }` +
    `});` +
    `top.postMessage(${annonce}, "*");` +
    `setTimeout(() => parent.postMessage({ type: "usurpation", obtenu: false }, "*"), 600);` +
    `</${"script"}>`
  );
}

// --- Exécution ------------------------------------------------------------------------------------

function avecDelai(promesse) {
  return Promise.race([
    promesse,
    new Promise((rendre) =>
      setTimeout(
        () => rendre({ resultat: "refuse", detail: `aucune réponse en ${DELAI_SONDE_MS} ms` }),
        DELAI_SONDE_MS,
      ),
    ),
  ]);
}

async function executer(sonde) {
  const identite = { nom: sonde.nom, cible: sonde.cible, intention: sonde.intention };
  if (sonde.codeAttendu) identite.codeAttendu = sonde.codeAttendu;
  try {
    return { ...identite, ...(await avecDelai(sonde.run())) };
  } catch (error) {
    return {
      ...identite,
      resultat: "refuse",
      detail: `${error?.name ?? "Error"}: ${error?.message ?? String(error)}`,
    };
  }
}

async function toutTenter() {
  portRestreint = await obtenirLePort();
  // Le port est exposé pour que l'épreuve puisse le PILOTER au-delà du relevé — mille messages
  // d'affilée, par exemple, ce qu'aucune sonde ne ferait sans faire exploser son propre rapport.
  globalThis.__portHostile = portRestreint;
  const releve = [
    {
      nom: "obtention-port-restreint",
      cible: "contrat",
      intention: "obtenir le port restreint prévu par le contrat",
      resultat: portRestreint ? "aboutit" : "refuse",
      detail: portRestreint ? "port restreint reçu" : `aucun port en ${DELAI_SONDE_MS} ms`,
    },
    await executer(SONDE_ADMISE),
    await executer(SONDE_CONCURRENTE),
  ];
  for (const sonde of [
    ...SONDES_INTERDITES,
    ...SONDES_DU_HARNAIS,
    ...SONDES_DE_CONTRAT,
    ...SONDES_DE_TOPOLOGIE,
  ]) {
    releve.push(await executer(sonde));
  }
  // Le JOURNAL du port est publié à part : l'épreuve le FOUILLE à la recherche des octets des clés,
  // au lieu de croire la coquille sur parole. Il n'est pas une sonde et ne se compte pas comme telle.
  document.querySelector("#hostile-journal").textContent = JSON.stringify(journalDuPort, null, 2);
  noeudRapport.textContent = JSON.stringify(releve, null, 2);
  noeudEtat.textContent = `hostile:sondes-terminees:${releve.length}`;
  document.documentElement.dataset.hostile = "sondes-terminees";
  if (releve.length !== NOMBRE_DE_SONDES) {
    document.documentElement.dataset.hostile = "releve-incomplet";
  }
  return releve;
}

globalThis.__releveHostile = toutTenter();
