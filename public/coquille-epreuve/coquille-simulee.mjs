// La COQUILLE SIMULÉE de #341 (ADR 0052) : coquille et guest à la fois, pour une seule épreuve.
//
//   /coquille-epreuve/coquille-simulee.html?mode=relais&tiers=<origine>
//   /coquille-epreuve/coquille-simulee.html?mode=temoin&tiers=<origine>
//
// `relais` encadre le VRAI courtier (`/document-applicatif.html`), lui octroie un port restreint, et
// répond aux requêtes relayées par la page hostile — avec, en plus, ce qu'une application Rails
// PERMISSIVE poserait : un en-tête `Content-Security-Policy` et un `<meta>` qui ouvrent tout. Aucun
// des deux ne doit élargir la politique du cadre.
//
// `temoin` encadre `temoin-courtier.html`, qui sert la même page hostile par l'hébergeur, sans relais
// et sans politique : le témoin positif.
//
// La sandbox est celle de la coquille de produit (`public/coquille/frontiere-applicative.mjs`), jeton
// pour jeton : un témoin sous une sandbox plus large mesurerait une autre frontière.

import {
  TYPES_APPLICATIFS,
  decoderMessage,
  enveloppeDeMessage,
} from "/src/coquille/contrat-de-messages.mjs";
import { APP_ORIGIN } from "/src/spike/origin-topology.mjs";

const SANDBOX_DE_LA_COQUILLE = "allow-scripts allow-same-origin allow-forms";

/** Ce qu'une application Rails permissive poserait, en en-tête comme en `<meta>`. */
const CSP_PERMISSIVE_DU_GUEST =
  "default-src * ws: wss: data: blob: 'unsafe-inline' 'unsafe-eval'; form-action *; frame-src *";

/** Les fichiers de la page hostile que le « guest » rend, par chemin relayé. */
const RENDUS = Object.freeze({
  "/": { fichier: "sorties-hostiles.html", type: "text/html; charset=utf-8" },
  "/sorties-hostiles.mjs": { fichier: "sorties-hostiles.mjs", type: "text/javascript" },
  "/sorties-du-cadre.mjs": { fichier: "sorties-du-cadre.mjs", type: "text/javascript" },
});

const parametres = new URL(location.href).searchParams;
const mode = parametres.get("mode");
const origineTierce = parametres.get("tiers");

function base64Depuis(texte) {
  let binaire = "";
  for (const octet of new TextEncoder().encode(texte)) binaire += String.fromCharCode(octet);
  return btoa(binaire);
}

async function rendre(chemin) {
  const rendu = RENDUS[chemin];
  if (!rendu) return { statut: 404, entetes: { "content-type": "text/plain" }, corps: "" };
  let texte = await (await fetch(new URL(rendu.fichier, location.href))).text();
  if (rendu.fichier.endsWith(".html")) {
    texte = texte
      .replace("__ORIGINE_TIERS__", origineTierce)
      .replace(
        "<!--CSP-DU-GUEST-->",
        `<meta http-equiv="Content-Security-Policy" content="${CSP_PERMISSIVE_DU_GUEST}" />`,
      );
  }
  return {
    statut: 200,
    entetes: { "content-type": rendu.type, "content-security-policy": CSP_PERMISSIVE_DU_GUEST },
    corps: base64Depuis(texte),
  };
}

function servirLeRelais(port) {
  port.addEventListener("message", async (event) => {
    const decode = decoderMessage(event.data);
    if (!decode.ok || decode.type !== TYPES_APPLICATIFS.requeteHttp) return;
    const reponse = await rendre(decode.message.chemin);
    port.postMessage(
      enveloppeDeMessage(TYPES_APPLICATIFS.requeteHttpReponse, {
        correlation: decode.message.correlation,
        ...reponse,
      }),
    );
  });
  port.start();
}

const cadre = document.createElement("iframe");
cadre.id = "document-applicatif";
cadre.setAttribute("sandbox", SANDBOX_DE_LA_COQUILLE);
cadre.setAttribute("width", "100%");
cadre.setAttribute("height", "600");

if (mode === "relais") {
  window.addEventListener("message", (event) => {
    if (event.origin !== APP_ORIGIN || event.source !== cadre.contentWindow) return;
    const decode = decoderMessage(event.data);
    if (!decode.ok || decode.type !== TYPES_APPLICATIFS.annonce) return;
    const canal = new MessageChannel();
    servirLeRelais(canal.port1);
    cadre.contentWindow.postMessage(enveloppeDeMessage(TYPES_APPLICATIFS.octroi), APP_ORIGIN, [
      canal.port2,
    ]);
    document.documentElement.dataset.coquilleSimulee = "port-octroye";
  });
  cadre.src = new URL("/document-applicatif.html", APP_ORIGIN).href;
} else {
  const temoin = new URL("/coquille-epreuve/temoin-courtier.html", APP_ORIGIN);
  temoin.searchParams.set("tiers", origineTierce);
  cadre.src = temoin.href;
}
document.querySelector("#emplacement").append(cadre);
