// Le RELAIS HTTP de la coquille (#192, ADR 0038) : les décisions, et rien de leur branchement.
//
// Ce module dit ce qu'une requête relayée a le droit d'être, ce qu'une réponse relayée a le droit de
// montrer, et ce que le guest reçoit de l'appelant. Il ne poste rien, n'ouvre rien, ne connaît ni le
// Worker de confiance, ni le cadre, ni le Service Worker : il est vérifiable par
// `tests/unit/coquille-relais-http.test.mjs` sans démarrer de machine.
//
// ## La règle qui gouverne tout le reste
//
// **Rien ne traverse qui n'ait été NOMMÉ ici.** Ni une méthode, ni un en-tête de requête, ni un
// en-tête de réponse. C'est l'inverse de ce qu'un proxy fait d'ordinaire — recopier ce qu'il reçoit
// et retirer ce qui gêne —, et l'inversion est le point : une liste de retraits est une liste qu'on
// oublie d'allonger, une liste d'admissions est une liste qu'il faut allonger pour se tromper.
//
// ## Ce que le document ne voit JAMAIS
//
//  - **le cookie de session.** `Set-Cookie` n'est pas rendu au cadre ; le BOCAL vit du côté du
//    Worker de confiance, il meurt avec lui, et il n'est jamais posté nulle part. Le document
//    obtient donc une session Rails qui fonctionne et un `document.cookie` vide — ce qu'un cookie
//    `HttpOnly` promet, obtenu ici par construction plutôt que par un attribut que le serveur
//    demande poliment au navigateur d'honorer ;
//  - **l'hôte du guest.** Rails rend des `Location` ABSOLUES (`http://127.0.0.1:3000/notes/…`).
//    Ce qui repart au cadre est le CHEMIN seul : l'adresse où l'application écoute dans la machine
//    virtuelle n'est l'affaire de personne, et la rendre ferait fuiter la topologie du guest dans le
//    territoire du guest — sans utilité, puisque le cadre ne peut pas l'atteindre ;
//  - **tout en-tête que ce module ne nomme pas.** `Server`, `X-Runtime`, `X-Request-Id` et les
//    autres décrivent l'exécutant, pas la réponse.
//
// ## Ce que le guest ne reçoit JAMAIS
//
//  - **`Origin` et `Referer`.** Ce n'est pas un oubli : Rails compare `Origin` à sa propre
//    `base_url` quand la protection anti-CSRF est armée (`forgery_protection_origin_check`), et
//    l'origine applicative du navigateur — `http://localhost:4180` — n'est pas celle sous laquelle
//    l'application se croit servie. Transmettre ferait échouer toute soumission ; forger ferait
//    mentir le relais à l'application. Aucun des deux n'est acceptable, et l'absence est exactement
//    ce qu'une navigation de même origine produit ;
//  - **un en-tête choisi par le document.** Trois seulement sont RELAYÉS, et leur valeur est bornée.

import { cheminSansDetour } from "./origines-de-la-coquille.mjs";

/**
 * Les MÉTHODES relayées. Trois, et le motif de chacune :
 *
 *  - `GET` — une page, un actif, une navigation ;
 *  - `POST` — un formulaire ;
 *  - `HEAD` — ce que les moteurs émettent d'eux-mêmes sur certaines ressources, et qu'un relais qui
 *    le refuserait ferait échouer sans que personne l'ait demandé.
 *
 * `PUT`, `PATCH` et `DELETE` sont ÉCARTÉS tant qu'aucun usage ne les demande : l'application de
 * référence n'en émet aucun, et la règle de l'ADR 0028 vaut ici comme ailleurs — un geste sans usage
 * n'entre pas. Les admettre le jour où un formulaire les emploie est une ligne ; les admettre
 * d'avance est une surface qu'aucune épreuve ne mesure.
 */
export const METHODES_RELAYEES = Object.freeze(["GET", "POST", "HEAD"]);

/** Longueur maximale d'un chemin relayé, requête comprise. */
export const TAILLE_MAXIMALE_DU_CHEMIN = 2048;

/**
 * Ce qu'un corps de REQUÊTE a le droit de peser. Un mébioctet : dix fois la plus grosse soumission
 * qu'un formulaire de l'application de référence produise, et assez peu pour qu'un guest ne puisse
 * pas être noyé par le cadre qu'il sert lui-même.
 */
export const PLAFOND_CORPS_DE_REQUETE_OCTETS = 1024 * 1024;

/**
 * Ce qu'un corps de RÉPONSE a le droit de peser. Huit mébioctets : la mesure du 12 septembre 2026
 * publie 1 083 octets pour la page d'accueil et 2 053 pour le plus lourd de ses actifs, si bien que
 * le plafond est à quatre mille fois le cas réel. Il n'est pas là pour économiser — il est là pour
 * qu'une réponse pathologique du guest soit REFUSÉE plutôt que recopiée trois fois en mémoire, une
 * par port franchi.
 */
export const PLAFOND_CORPS_DE_REPONSE_OCTETS = 8 * 1024 * 1024;

/**
 * Les en-têtes de REQUÊTE que le document a le droit de choisir. Trois, et rien d'autre :
 * l'appelant dit ce qu'il ACCEPTE et sous quel type il envoie son corps. Tout le reste — l'hôte,
 * l'agent, la longueur du corps, le cookie — est posé par le relais, qui le sait mieux que lui.
 */
export const ENTETES_DE_REQUETE_RELAYEES = Object.freeze([
  "accept",
  "accept-language",
  "content-type",
]);

/** Longueur maximale d'une valeur d'en-tête relayée, dans un sens comme dans l'autre. */
export const TAILLE_MAXIMALE_DUNE_VALEUR_DENTETE = 1024;

/**
 * Les en-têtes de RÉPONSE rendus au cadre. Huit, tous nécessaires au rendu :
 *
 *  - `content-type` — sans lui le navigateur n'exécute pas un script et n'applique pas une feuille ;
 *  - `content-language`, `content-disposition` — ce que la réponse EST, et comment la présenter ;
 *  - `location` — la redirection, dont le chemin est réécrit (voir `emplacementRendu`) ;
 *  - `cache-control`, `etag`, `last-modified`, `vary` — la fraîcheur, que l'application décide.
 *
 * `set-cookie` n'y est PAS, et c'est la décision centrale de ce module : la session Rails vit dans
 * le bocal du Worker de confiance, jamais dans le bocal du navigateur. Un `Set-Cookie` rendu depuis
 * un Service Worker serait d'ailleurs ignoré par les moteurs — mais s'appuyer sur cela reviendrait à
 * faire tenir une propriété de sécurité par un détail d'implémentation du navigateur.
 */
export const ENTETES_DE_REPONSE_RENDUES = Object.freeze([
  "content-type",
  "content-language",
  "content-disposition",
  "location",
  "cache-control",
  "etag",
  "last-modified",
  "vary",
]);

/**
 * Les chemins que la COQUILLE DE CADRE occupe sur l'origine applicative, et que le relais ne
 * transmet donc jamais au guest.
 *
 * Ils existent parce que le Service Worker a pour portée l'origine ENTIÈRE : sans cette liste, il
 * relaierait au guest le document qui le porte, le module qui l'enregistre et le contrat qu'ils
 * importent — c'est-à-dire qu'il se couperait la branche sur laquelle il est assis.
 *
 * Trois familles, et chacune a son motif :
 *
 *  - **la coquille de cadre elle-même** — le courtier, ses modules, le contrat qu'ils importent ;
 *  - **ce que l'ARBRE APPLICATIF publie d'autre** : la place tenante (`/index.html`), l'inventaire
 *    de publication et le fichier d'en-têtes. Ce sont des fichiers de CE DÉPÔT, pas des pages que le
 *    guest rend — et le témoin d'en-têtes de l'ADR 0017 mesure justement la place tenante. Sans
 *    cette famille, il a mesuré un 504 du relais au lieu des en-têtes du serveur : mesuré le
 *    12 septembre 2026, et c'est ce qui l'a fait entrer ici ;
 *  - **les BANCS et les ÉPREUVES** que ce dépôt sert sur la même origine en local : un Service
 *    Worker qui relaierait `/coquille-epreuve/hostile.html` ferait rougir des suites qui n'ont rien
 *    demandé.
 *
 * **Ce que cette liste COÛTE, et il faut l'écrire** : une application qui servirait elle-même l'un
 * de ces chemins ne serait pas relayée là. Aucune n'a de raison de servir `/cadre/` ou
 * `/document-applicatif.html` ; `/index.html`, en revanche, est un chemin qu'une application
 * pourrait vouloir — et elle ne l'obtiendrait pas. Rails sert `/`, que le relais transmet. Ce que
 * le cadre OBTIENT alors n'est pas un échec silencieux : le Service Worker lui rend la page de refus
 * `CADRE_CHEMIN_RESERVE` (revue d'intégration de la PR #203, constat 5), et jamais un document de la
 * coquille.
 *
 * **Une entrée qui finit par `/` est un RÉPERTOIRE, toute autre est un FICHIER exact.** La liste était
 * un préfixe sans frontière, et `/compat` avalait `/compatibilite-des-notes` ; `/document-applicatif`,
 * `/document-applicatifs-de-mon-app` (même constat).
 */
export const CHEMINS_DE_LA_COQUILLE_DE_CADRE = Object.freeze([
  "/document-applicatif.html",
  "/document-applicatif.mjs",
  "/service-worker-du-cadre.mjs",
  "/cadre/",
  "/src/",
  "/index.html",
  "/inventaire.json",
  "/_headers",
  "/vm/",
  "/compat.html",
  "/compat.mjs",
  "/compat-worker.mjs",
  "/coquille-epreuve/",
  "/spike/",
]);

/**
 * Le chemin du COURTIER : le seul chemin réservé qu'une navigation de cadre obtient toujours du
 * réseau, parce que c'est le document que la coquille encadre.
 */
export const CHEMIN_DU_COURTIER = "/document-applicatif.html";

/**
 * Borne d'une requête RELAYÉE côté COQUILLE, en millisecondes.
 *
 * Les trois bornes d'une requête relayée s'emboîtent, et la plus EXTÉRIEURE attend le plus
 * longtemps (revue d'intégration de la PR #203, constat 6) : le pont série s'accorde 120 s et rend
 * alors un refus TYPÉ ; la coquille, 150 s ; le Service Worker, 180 s (`DELAI_DU_COURTIER_MS`). Une
 * borne intérieure qui expire rend donc toujours son refus AVANT que la suivante ne se taise, et le
 * cadre lit la cause la plus précise. `tests/unit/coquille-relais-http.test.mjs` mesure l'ordre.
 */
export const DELAI_RELAIS_COQUILLE_MS = 150_000;

/**
 * Les en-têtes de POLITIQUE que l'hébergeur pose sur le territoire applicatif, et que le Service
 * Worker REJOUE sur ce qu'il sert lui-même (revue de sécurité de la PR #203, constat 7).
 *
 * Une réponse fabriquée par un Service Worker ne porte aucun en-tête de l'hébergeur : sans ce
 * rejeu, tout ce que le relais sert perdait `nosniff`, CORP et `Cache-Control`. La source reste
 * `tools/serve-headers.mjs` ; cette table en est l'EXTRAIT pour le rôle `app`, et
 * `tests/unit/coquille-relais-http.test.mjs` exige qu'ils soient égaux — une recopie qui
 * divergerait rougirait.
 */
export const ENTETES_DE_L_HEBERGEUR_APPLICATIF = Object.freeze({
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "cross-origin",
});

/**
 * Un texte porte-t-il un caractère de CONTRÔLE ?
 *
 * La question est posée code par code plutôt que par une expression régulière, et ce n'est pas une
 * concession à un linter : ce que le refus vise est l'injection d'une seconde ligne dans la requête
 * HTTP que le pont série composera, et une boucle explicite dit exactement quels codes elle refuse
 * — les trente-deux premiers et le caractère de suppression — là où une classe de caractères se
 * relit mal et se recopie encore plus mal.
 *
 * @param {string} texte
 */
function porteUnCaractereDeControle(texte) {
  for (let index = 0; index < texte.length; index += 1) {
    const code = texte.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** @param {string} chemin */
export function estUnCheminDeLaCoquilleDeCadre(chemin) {
  return CHEMINS_DE_LA_COQUILLE_DE_CADRE.some((entree) =>
    entree.endsWith("/") ? chemin.startsWith(entree) : chemin === entree,
  );
}

/**
 * Un chemin relayable, ou `null`.
 *
 * La règle est celle de `cheminApplicatifAdmis` (ADR 0028) élargie à la REQUÊTE : ce qui est refusé
 * est ce qui cesserait d'être un chemin — une URL relative au schéma, une URL absolue, un chemin qui
 * porte une barre inversée — parce qu'un tel « chemin » déplacerait ce que le guest sert.
 *
 * @param {unknown} valeur
 * @returns {string | null}
 */
export function cheminRelayable(valeur) {
  if (typeof valeur === "string" && valeur.length > TAILLE_MAXIMALE_DU_CHEMIN) return null;
  // La règle entière — séparateurs, segments repliables, encodages, contrôles et espace — est
  // celle de `cheminSansDetour`, la même que pour le chemin du document encadré : deux gardes
  // écrites deux fois sont deux gardes qui divergent.
  return cheminSansDetour(valeur);
}

/**
 * Les en-têtes qu'une requête du cadre a le droit de porter, filtrés et bornés.
 *
 * Un en-tête hors liste n'est pas un refus : il est LAISSÉ. Refuser rendrait le relais fragile au
 * premier moteur qui ajoute un en-tête de son cru, et la propriété qui compte — le guest ne reçoit
 * que ce qui est nommé — est tenue par le filtre, pas par le refus. Une VALEUR illisible, elle, est
 * un refus : elle ne peut pas être « à peu près » transmise.
 *
 * @param {unknown} valeur
 * @returns {{ ok: true, entetes: [string, string][] } | { ok: false }}
 */
export function entetesDeRequeteRelayees(valeur) {
  if (valeur === undefined || valeur === null) return { ok: true, entetes: [] };
  if (typeof valeur !== "object" || Array.isArray(valeur)) return { ok: false };
  const entetes = [];
  for (const [nom, contenu] of Object.entries(valeur)) {
    const minuscule = String(nom).toLowerCase();
    if (!ENTETES_DE_REQUETE_RELAYEES.includes(minuscule)) continue;
    if (typeof contenu !== "string") return { ok: false };
    if (contenu.length > TAILLE_MAXIMALE_DUNE_VALEUR_DENTETE) return { ok: false };
    if (porteUnCaractereDeControle(contenu)) return { ok: false };
    entetes.push([minuscule, contenu]);
  }
  return { ok: true, entetes };
}

/**
 * Les en-têtes qu'une réponse du guest a le droit de montrer au cadre.
 *
 * @param {Record<string, string>} entetes
 * @returns {Record<string, string>}
 */
export function entetesDeReponseRendues(entetes) {
  const rendus = {};
  for (const nom of ENTETES_DE_REPONSE_RENDUES) {
    const valeur = entetes?.[nom];
    if (typeof valeur !== "string") continue;
    if (valeur.length > TAILLE_MAXIMALE_DUNE_VALEUR_DENTETE) continue;
    // Une valeur à caractère de contrôle n'est pas rendue : `Headers` la refuserait en JETANT dans
    // le Service Worker, et le cadre verrait la page d'échec du navigateur au lieu d'une réponse.
    if (porteUnCaractereDeControle(valeur)) continue;
    rendus[nom] = valeur;
  }
  return rendus;
}

/**
 * Ce que le cadre lit d'un `Location` : un CHEMIN, jamais une adresse.
 *
 * Trois cas, trois issues :
 *
 *  - une URL absolue vers le guest (`http://127.0.0.1:3000/notes/42`) rend son chemin. C'est le cas
 *    ordinaire : Rails rend des `Location` absolues, et l'hôte y est celui que le relais a posé ;
 *  - un chemin (`/notes/42`) se rend tel quel ;
 *  - une URL absolue vers AILLEURS (`https://exemple.test/`) rend `null` : le relais ne suit pas une
 *    application hors de sa machine, et il ne demande pas au cadre de le faire non plus. Rendre une
 *    telle redirection ferait naviguer le cadre vers le web ouvert sur l'ordre du guest.
 *
 * @param {string | undefined} emplacement
 * @param {string} baseDuGuest origine sous laquelle le relais a émis la requête
 * @returns {string | null}
 */
export function emplacementRendu(emplacement, baseDuGuest) {
  if (typeof emplacement !== "string" || emplacement.length === 0) return null;
  let url;
  try {
    url = new URL(emplacement, baseDuGuest);
  } catch {
    return null;
  }
  if (url.origin !== new URL(baseDuGuest).origin) return null;
  // Le chemin NORMALISÉ est rejugé : `/..//evil.test/` est de la bonne origine et se normalise en
  // `//evil.test/`, que le cadre lirait comme une autre origine (revue de sécurité #203, constat 4).
  if (cheminSansDetour(`${url.pathname}${url.search}`) === null) return null;
  return `${url.pathname}${url.search}${url.hash}`;
}

/** Ce que `n` octets pèsent une fois encodés en base64, remplissage compris. */
export function tailleEnBase64(octets) {
  return Math.ceil(octets / 3) * 4;
}

/**
 * Le base64 CANONIQUE : des quadruplets de l'alphabet standard, le remplissage en fin seulement.
 *
 * L'alphabet seul ne suffit pas, et la revue de sécurité de la PR #203 (constat 3) l'a mesuré : `A`
 * et `AAAA=` sont faits de caractères admis, et `atob` les refuse. Une garde qui admet ce que le
 * décodeur refuse fait JETER le Worker de confiance après l'admission, c'est-à-dire là où plus
 * personne ne rend de refus. La garde exige donc ce que le décodeur exige, et un peu plus : la
 * longueur multiple de quatre, que `btoa` produit toujours.
 */
const BASE64_ADMIS = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * ÉVALUE une requête relayée reçue du cadre.
 *
 * Elle est appelée APRÈS `evaluerRequete` (`admission-applicative.mjs`), qui a déjà jugé
 * l'enveloppe, le type, la corrélation et la clôture des champs. Ce qui reste est la sémantique
 * HTTP, et elle est jugée ici, dans le module qui la possède.
 *
 * Le corps est une CHAÎNE base64 et non un tampon, et ce n'est pas une commodité d'encodage :
 * `sansCapacite` refuse toute vue sur un tampon à l'enveloppe de chaque message, dans les deux sens.
 * Le relais ne demande donc AUCUNE dérogation à la règle qui garde le port restreint — il paie un
 * tiers d'octets pour ne pas y toucher. Le coût est mesuré et publié.
 *
 * @param {Record<string, unknown>} message
 * @returns {{ ok: true, methode: string, chemin: string, entetes: [string, string][],
 *             corps: string | null }
 *          | { ok: false }}
 */
export function evaluerRequeteRelayee(message) {
  const methode = typeof message.methode === "string" ? message.methode.toUpperCase() : null;
  if (methode === null || !METHODES_RELAYEES.includes(methode)) return { ok: false };
  const chemin = cheminRelayable(message.chemin);
  if (chemin === null) return { ok: false };
  const entetes = entetesDeRequeteRelayees(message.entetes);
  if (!entetes.ok) return { ok: false };
  const corps = message.corps ?? null;
  if (corps !== null) {
    if (typeof corps !== "string") return { ok: false };
    if (corps.length > tailleEnBase64(PLAFOND_CORPS_DE_REQUETE_OCTETS)) return { ok: false };
    if (!BASE64_ADMIS.test(corps)) return { ok: false };
    // Un corps sur une méthode qui n'en porte pas est refusé : une requête qui dit une chose et en
    // fait une autre ne doit pas être arbitrée par le guest.
    if (methode === "GET" || methode === "HEAD") return { ok: false };
  }
  return { ok: true, methode, chemin, entetes: entetes.entetes, corps };
}

/**
 * Le BOCAL À COOKIES de la session relayée.
 *
 * Il vit du côté de confiance, il ne franchit aucun port, et il meurt avec le Worker qui le tient —
 * donc au verrouillage, à la mort du Worker et à la fermeture de l'onglet, sans qu'aucun code n'ait
 * à s'en souvenir. C'est la même propriété que la KEK de la session (ADR 0029), obtenue de la même
 * façon : ce qui n'est écrit nulle part n'a pas besoin d'être effacé.
 *
 * Ce qu'il N'EST PAS : un bocal de navigateur. Il ignore `Domain`, `Path`, `Secure`, `SameSite` et
 * l'expiration, et c'est une décision plutôt qu'une paresse — il ne sert QU'UNE origine, celle du
 * guest, pour la durée d'UNE session de coffre, et les attributs d'un cookie décrivent des
 * frontières (domaine, chemin, site tiers) qui n'existent pas dans un bocal à un seul habitant.
 * La limite est écrite dans l'ADR : une application qui s'appuierait sur l'expiration d'un cookie
 * pour se déconnecter ne serait pas déconnectée par ce relais.
 *
 * L'ORDRE est celui de la dernière pose : un cookie réécrit remplace sa valeur sans changer de rang,
 * ce qui rend l'en-tête `Cookie` stable d'une requête à l'autre.
 */
export function creerBocalDeCookies({ plafond = 32 } = {}) {
  /** @type {Map<string, string>} */
  const cookies = new Map();

  return {
    /**
     * DÉPOSE ce qu'une réponse a posé. `entetesRepetees` est la LISTE, avec ses doublons : un
     * serveur qui pose deux cookies le fait par deux en-têtes, que la table des en-têtes écraserait.
     *
     * @param {[string, string][]} entetesRepetees
     * @returns {number} le nombre de cookies posés par cette réponse
     */
    deposer(entetesRepetees) {
      let poses = 0;
      for (const [nom, valeur] of entetesRepetees ?? []) {
        if (nom !== "set-cookie") continue;
        const paire = valeur.split(";", 1)[0];
        const separation = paire.indexOf("=");
        if (separation <= 0) continue;
        const cle = paire.slice(0, separation).trim();
        const contenu = paire.slice(separation + 1).trim();
        if (cle.length === 0) continue;
        // Un bocal BORNÉ : un guest qui poserait mille cookies ne fait pas grossir la mémoire de la
        // base de confiance. Le plus ancien part, et le compte est publié.
        if (!cookies.has(cle) && cookies.size >= plafond) {
          const premier = cookies.keys().next().value;
          cookies.delete(premier);
        }
        cookies.delete(cle);
        cookies.set(cle, contenu);
        poses += 1;
      }
      return poses;
    },

    /** L'en-tête `Cookie` à renvoyer au guest, ou `null` quand le bocal est vide. */
    entete() {
      if (cookies.size === 0) return null;
      return [...cookies].map(([cle, valeur]) => `${cle}=${valeur}`).join("; ");
    },

    /** Combien de cookies le bocal tient. Un COMPTE, jamais leur contenu. */
    compte() {
      return cookies.size;
    },

    /** VIDE le bocal. Appelé à la fermeture, avec le reste des clés de la session. */
    vider() {
      cookies.clear();
    },
  };
}

/**
 * La coquille a-t-elle CESSÉ DE SERVIR ? C'est la garde d'ABANDON du relais (#192, ADR 0031 appliquée
 * au chemin neuf), sortie de sa clôture pour être éprouvée et mutée (revue de sécurité de la PR #203,
 * constat 6).
 *
 * Deux causes, et chacune suffit : le relais a été ABANDONNÉ — le verrouillage, réussi ou refusé, et
 * les fins d'onglet retirent le cadre —, ou le Worker de confiance est MORT. Une réponse arrivée
 * après l'une ou l'autre n'est jamais postée : elle dessinerait une page métier dans un cadre retiré,
 * ou sur un coffre que plus rien ne sert. Une annonce de barrière non plus.
 *
 * @param {{ relaisAbandonne: boolean, workerMort: boolean }} etat
 * @returns {boolean}
 */
export function relaisAbandonne({ relaisAbandonne: abandonne, workerMort }) {
  return abandonne === true || workerMort === true;
}
