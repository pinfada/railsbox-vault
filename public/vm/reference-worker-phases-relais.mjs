// Phase de MESURE du pont série HTTP sur une page Rails réelle (#192).
//
// Elle existe pour une raison et une seule : la tranche doit CHOISIR le mécanisme qui sert
// l'application dans le cadre, et ce choix dépend d'un chiffre que personne n'avait. Le dépôt
// mesurait jusqu'ici le BOOT — p95 = 125,9 s — et deux requêtes JSON, `/vault/health` et
// `/vault/invariant`, qui pèsent quelques centaines d'octets. Une page HTML avec ses actifs, un
// formulaire et une redirection est un autre régime : d'autres tailles, d'autres comptes, d'autres
// concurrences. Décider sans l'avoir mesuré aurait été deviner.
//
// Ce qu'elle mesure, et ce qu'elle ne mesure pas :
//
//  - elle mesure ce que coûte une requête ALLER-RETOUR à travers `@VLT1` — descripteur, tranches
//    base64, acquittements, réponse réassemblée — depuis un Worker de navigateur, sur le guest réel.
//    C'est le coût que TOUS les mécanismes candidats paient, sauf celui qui remplace le pont ;
//  - elle ne mesure NI le rendu, NI l'interception, NI le coût du relais lui-même : ceux-là
//    dépendent du mécanisme, et le mécanisme n'est pas encore choisi. Les mêmes grandeurs sont
//    reprises APRÈS, sur le chemin servi, par le scénario de bout en bout.
//
// Aucune assertion ici : la phase rend ce qu'elle a observé, et `tests/e2e/` juge.

import { bootEtVerifier } from "/src/vm/boot-de-reference.mjs";
import { openVolumeForWrite } from "/src/vm/opfs-volume-open.mjs";
import { cleDuBanc } from "./cle-du-banc.mjs";

/** L'ouvreur du BANC, identique à celui des phases de boot : le jeton du harnais (ADR 0016). */
function ouvrirLeVolumeDuBanc({ name, journal, expectations }) {
  return openVolumeForWrite({ name, journal, cle: cleDuBanc(), expectations });
}

/**
 * Les en-têtes qu'un NAVIGATEUR poserait sur une navigation ordinaire, et que la mesure pose donc
 * aussi : mesurer sous `Accept: application/json` rendrait une page que personne ne demande.
 */
const ENTETES_DE_PAGE = Object.freeze([
  ["Host", "127.0.0.1"],
  ["Accept", "text/html,application/xhtml+xml"],
  ["User-Agent", "railsbox-vault-mesure"],
]);

/** Une requête, chronométrée, avec ce qu'elle a coûté en octets DANS LES DEUX SENS. */
async function chronometrer(requeteHttp, methode, chemin, { cookie = null, corps = null } = {}) {
  const entetes = ENTETES_DE_PAGE.map((paire) => [...paire]);
  if (cookie !== null) entetes.push(["Cookie", cookie]);
  if (corps !== null) {
    entetes.push(["Content-Type", "application/x-www-form-urlencoded"]);
    entetes.push(["Content-Length", String(corps.byteLength)]);
  }
  const debut = performance.now();
  const reponse = await requeteHttp(methode, chemin, { headers: entetes, body: corps });
  const millisecondes = Math.round((performance.now() - debut) * 10) / 10;
  return {
    methode,
    chemin,
    statut: reponse.statut,
    millisecondes,
    octetsEmis: corps === null ? 0 : corps.byteLength,
    octetsRecus: reponse.corps.byteLength,
    typeDeContenu: reponse.entetes["content-type"] ?? null,
    emplacement: reponse.entetes.location ?? null,
    reponse,
  };
}

/** Le cookie de session, tel que la réponse le pose. Le premier attribut suffit à le renvoyer. */
function cookieDeSession(reponse, courant) {
  const poses = reponse.entetesRepetees
    .filter(([nom]) => nom === "set-cookie")
    .map(([, valeur]) => valeur.split(";", 1)[0]);
  return poses.length === 0 ? courant : poses.join("; ");
}

/** Le jeton anti-CSRF que le formulaire porte. Une mesure qui l'omettrait mesurerait un 422. */
function jetonDuFormulaire(octets) {
  const html = new TextDecoder().decode(octets);
  return html.match(/name="authenticity_token" value="([^"]+)"/)?.[1] ?? null;
}

/** Les trois sous-ressources de la page, dans l'ordre où le document les nomme. */
const SOUS_RESSOURCES = Object.freeze(["/vault.css", "/vault.js", "/vault.png"]);

/**
 * LE PARCOURS MESURÉ, en cinq temps. Il est écrit comme un utilisateur le vit, et non comme une
 * série de sondes : première page et ses actifs, puis les mêmes actifs DEMANDÉS ENSEMBLE, puis une
 * seconde page, puis un formulaire et la redirection qu'il rend.
 */
async function mesurerUnParcours(requeteHttp) {
  const premierDocument = await chronometrer(requeteHttp, "GET", "/");
  let cookie = cookieDeSession(premierDocument.reponse, null);
  const jeton = jetonDuFormulaire(premierDocument.reponse.corps);

  const actifs = await mesurerLesActifs(requeteHttp, cookie);
  const secondDocument = await chronometrer(requeteHttp, "GET", "/", { cookie });
  cookie = cookieDeSession(secondDocument.reponse, cookie);

  const formulaire = await mesurerLeFormulaire(requeteHttp, { cookie, jeton });

  return {
    // Le cookie lui-même n'est PAS publié : ce qui compte est qu'il ait existé et qu'il ait tenu.
    sessionRails: {
      cookiePose: cookie !== null,
      jetonAntiCsrfTrouve: jeton !== null,
      // Le compteur de vues de la page est la preuve la plus courte que le cookie a fait l'aller-
      // retour : sans lui, chaque page rendrait « 1 ».
      vuesRelues: lireLesVues(formulaire.pageApresRedirection ?? secondDocument),
    },
    premierePage: sansReponse(premierDocument),
    actifsEnSerie: actifs.enSerie.map(sansReponse),
    actifsEnParallele: {
      totalMs: actifs.paralleleMs,
      requetes: actifs.enParallele.map(sansReponse),
    },
    pageSuivante: sansReponse(secondDocument),
    soumission: sansReponse(formulaire.soumission),
    pageApresRedirection:
      formulaire.pageApresRedirection === null
        ? null
        : sansReponse(formulaire.pageApresRedirection),
    total: totaliser([
      premierDocument,
      ...actifs.enSerie,
      secondDocument,
      formulaire.soumission,
      ...(formulaire.pageApresRedirection === null ? [] : [formulaire.pageApresRedirection]),
    ]),
  };
}

/**
 * Les TROIS sous-ressources, mesurées deux fois : en série, puis ensemble.
 *
 * L'écart entre les deux est la grandeur qui décide si un relais doit sérialiser ou non — et la
 * réponse du 12 septembre 2026 est qu'il n'a pas à s'en soucier : le fil série sérialise de toute
 * façon, et le parallélisme n'achète rien.
 */
async function mesurerLesActifs(requeteHttp, cookie) {
  const enSerie = [];
  for (const chemin of SOUS_RESSOURCES) {
    enSerie.push(await chronometrer(requeteHttp, "GET", chemin, { cookie }));
  }
  const depart = performance.now();
  const enParallele = await Promise.all(
    SOUS_RESSOURCES.map((chemin) => chronometrer(requeteHttp, "GET", chemin, { cookie })),
  );
  return {
    enSerie,
    enParallele,
    paralleleMs: Math.round((performance.now() - depart) * 10) / 10,
  };
}

/**
 * La SOUMISSION du formulaire et la redirection qu'elle rend.
 *
 * La redirection est SUIVIE à la main : le pont ne la suit pas, et c'est précisément ce qu'un relais
 * devra faire — ou déléguer au navigateur, ce que l'ADR 0038 tranche.
 */
async function mesurerLeFormulaire(requeteHttp, { cookie, jeton }) {
  const charge = new TextEncoder().encode(
    `libelle=${encodeURIComponent("note mesuree par le banc")}` +
      (jeton === null ? "" : `&authenticity_token=${encodeURIComponent(jeton)}`),
  );
  const soumission = await chronometrer(requeteHttp, "POST", "/notes", { cookie, corps: charge });
  const suivant = cookieDeSession(soumission.reponse, cookie);
  const chemin =
    soumission.emplacement === null
      ? null
      : new URL(soumission.emplacement, "http://127.0.0.1/").pathname;
  const pageApresRedirection =
    chemin === null ? null : await chronometrer(requeteHttp, "GET", chemin, { cookie: suivant });
  return { soumission, pageApresRedirection };
}

/** Le compteur de vues, tel que la page l'affiche. `null` quand la page ne le porte pas. */
function lireLesVues(mesure) {
  const html = new TextDecoder().decode(mesure.reponse.corps);
  const trouve = html.match(/vues dans cette session : (\d+)/);
  return trouve === null ? null : Number.parseInt(trouve[1], 10);
}

/**
 * Retire la réponse BRUTE : elle porte des octets, et un compte rendu ne transporte que des faits.
 *
 * Le champ est retiré par DESTRUCTURATION nommée puis ignoré ; `void` le dit au lecteur autant
 * qu'au linter — ce n'est pas un oubli, c'est le but de la fonction.
 */
function sansReponse(mesure) {
  const { reponse, ...faits } = mesure;
  void reponse;
  return faits;
}

/** Ce que le parcours a coûté en tout : requêtes, octets, millisecondes. */
function totaliser(mesures) {
  return {
    requetes: mesures.length,
    octetsRecus: mesures.reduce((somme, mesure) => somme + mesure.octetsRecus, 0),
    octetsEmis: mesures.reduce((somme, mesure) => somme + mesure.octetsEmis, 0),
    millisecondes:
      Math.round(mesures.reduce((somme, mesure) => somme + mesure.millisecondes, 0) * 10) / 10,
  };
}

/**
 * Boote l'image de référence, mesure un parcours de page réelle, puis ferme.
 *
 * La session est GARDÉE OUVERTE — c'est la seule façon d'émettre une requête après le boot — et la
 * fermeture est dans un `finally` : une mesure qui échoue ne doit pas laisser une VM tourner.
 */
export async function phaseMesureRelais(options) {
  const { fermer, requeteHttp, ...compte } = await bootEtVerifier({
    ...options,
    phase: "mesure-relais",
    garderLaSessionOuverte: true,
    ouvrirLeVolumeDuGuest: ouvrirLeVolumeDuBanc,
  });
  try {
    return { ...compte, relais: await mesurerUnParcours(requeteHttp) };
  } finally {
    await fermer({ capturer: false });
  }
}
