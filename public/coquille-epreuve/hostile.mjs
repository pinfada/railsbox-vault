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

function surMessageDuPort(event) {
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
  return new Promise((rendre) => {
    const attente = { rendre, servi: false };
    attentes.push(attente);
    portRestreint.postMessage(brut);
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

/** Le geste ADMIS. C'est le témoin positif du contrat : sans lui, tout refuser ne prouverait rien. */
const SONDE_ADMISE = {
  nom: "geste-admis-etat",
  cible: "contrat",
  intention: "obtenir l'état du volume, seul geste de la liste d'admission",
  async run() {
    if (portRestreint === null) return { resultat: "sans-port", detail: "aucun port octroyé" };
    const reponse = await poster(enveloppeDeMessage(TYPES_APPLICATIFS.etat));
    const decode = decoderMessage(reponse);
    if (!decode.ok || decode.type !== TYPES_APPLICATIFS.etatReponse) {
      return { resultat: "refuse", detail: JSON.stringify(reponse) };
    }
    return { resultat: "aboutit", detail: JSON.stringify(decode.message) };
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
  const releve = [
    {
      nom: "obtention-port-restreint",
      cible: "contrat",
      intention: "obtenir le port restreint prévu par le contrat",
      resultat: portRestreint ? "aboutit" : "refuse",
      detail: portRestreint ? "port restreint reçu" : `aucun port en ${DELAI_SONDE_MS} ms`,
    },
    await executer(SONDE_ADMISE),
  ];
  for (const sonde of [...SONDES_INTERDITES, ...SONDES_DE_CONTRAT, ...SONDES_DE_TOPOLOGIE]) {
    releve.push(await executer(sonde));
  }
  noeudRapport.textContent = JSON.stringify(releve, null, 2);
  noeudEtat.textContent = `hostile:sondes-terminees:${releve.length}`;
  document.documentElement.dataset.hostile = "sondes-terminees";
  if (releve.length !== NOMBRE_DE_SONDES) {
    document.documentElement.dataset.hostile = "releve-incomplet";
  }
  return releve;
}

globalThis.__releveHostile = toutTenter();
