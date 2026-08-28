// Contrat partagé du spike #46 : les deux « applications » mesurées, les deux topologies
// comparées et les noms des actifs déposés par l'application A. Ce module est chargé tel quel par
// les documents applicatifs dans le navigateur, par les épreuves Playwright et par
// `playwright.config.mjs` sous Node : les trois raisonnent sur la même table.
//
// Il ne dépend d'AUCUN autre module. `src/spike/origin-topology.mjs` — le contrat du spike #35 —
// est importé par les documents servis sous la forme « /src/spike/… », une URL absolue que Node ne
// résout pas. Un module partagé par les deux mondes doit donc se suffire à lui-même ; l'épreuve
// `apps-frontiere.spec.mjs` vérifie que l'origine applicative déclarée ici est bien celle de
// l'ADR 0002, faute de quoi les deux contrats divergeraient en silence.

/**
 * Origine applicative de l'ADR 0002 (`APP_ORIGIN` du spike #35). Les DEUX applications y vivent
 * dans la topologie « même origine », distinguées par un simple préfixe de chemin.
 */
export const ORIGINE_APPLICATIVE = "http://localhost:4174";

/**
 * Seconde origine applicative, pour la topologie « une origine par application ».
 *
 * L'hôte change, et pas seulement le port : **les cookies ignorent le port**. Deux origines qui ne
 * différeraient que par lui partageraient leur bocal de cookies, et la mesure conclurait à une
 * isolation que la topologie visée — `a.app.exemple` / `b.app.exemple` — n'aurait pas non plus.
 * `127.0.0.2` appartient à `127.0.0.0/8`, donc à la plage de bouclage que les trois moteurs
 * traitent comme contexte sécurisé : l'OPFS et les Service Workers y restent disponibles.
 */
export const ORIGINE_APPLICATIVE_B_HOTE = "127.0.0.2";
export const ORIGINE_APPLICATIVE_B_PORT = 4175;
export const ORIGINE_APPLICATIVE_B = `http://${ORIGINE_APPLICATIVE_B_HOTE}:${ORIGINE_APPLICATIVE_B_PORT}`;

/**
 * Troisième origine, sur le MÊME hôte que A et n'en différant que par le PORT.
 *
 * Elle n'est pas un doublon de la précédente : elle mesure l'écart entre la frontière d'ORIGINE,
 * qui compte le port, et la frontière de COOKIES, qui ne le compte pas. « Une origine par
 * application » obtenue par le port seul est la solution que l'on propose d'abord parce qu'elle ne
 * coûte ni DNS ni certificat ; cette topologie dit ce qu'elle laisse passer.
 */
export const ORIGINE_APPLICATIVE_C_HOTE = "localhost";
export const ORIGINE_APPLICATIVE_C_PORT = 4176;
export const ORIGINE_APPLICATIVE_C = `http://${ORIGINE_APPLICATIVE_C_HOTE}:${ORIGINE_APPLICATIVE_C_PORT}`;

/** Répertoires des deux documents applicatifs. Ils commencent par `/spike/origin/app`, donc ils
 * sont servis comme territoire applicatif : sans CSP, comme le HTML rendu par un guest. */
export const CHEMIN_APP_A = "/spike/origin/app-a/";
export const CHEMIN_APP_B = "/spike/origin/app-b/";

/**
 * Les deux topologies comparées.
 *
 * - `meme-origine-prefixe-de-chemin` : ce que l'ADR 0002 publie aujourd'hui, avec la convention de
 *   partitionnement par chemin proposée comme option (b) par l'issue #46 ;
 * - `origine-par-application` : l'option (a), une origine par application.
 *
 * La première est le **témoin négatif** : si les lectures croisées n'y aboutissaient pas, les
 * refus de la seconde ne prouveraient rien — ils pourraient venir de sondes cassées.
 */
export const TOPOLOGIES_APPS = Object.freeze({
  "meme-origine-prefixe-de-chemin": Object.freeze({
    origineA: ORIGINE_APPLICATIVE,
    origineB: ORIGINE_APPLICATIVE,
    resume: "les deux applications partagent l'origine applicative, séparées par un préfixe",
    croisementAttendu: "lu",
  }),
  "origine-par-application": Object.freeze({
    origineA: ORIGINE_APPLICATIVE,
    origineB: ORIGINE_APPLICATIVE_B,
    resume: "chaque application a son origine, sur un hôte distinct",
    croisementAttendu: "invisible",
  }),
  "origine-par-port": Object.freeze({
    origineA: ORIGINE_APPLICATIVE,
    origineB: ORIGINE_APPLICATIVE_C,
    resume: "deux origines qui ne diffèrent que par le port",
    croisementAttendu: "invisible sauf les cookies",
  }),
});

export const TOPOLOGIES_APPS_IDS = Object.freeze(Object.keys(TOPOLOGIES_APPS));

/** Actifs déposés par l'application A, et cherchés par l'application B. */
export const ACTIFS_A = Object.freeze({
  /** Fichier déposé à la RACINE de l'OPFS, comme le ferait une application sans convention. */
  opfsFichier: "app-a.marker",
  /** Répertoire OPFS préfixé au nom de l'application : la convention de l'option (b). */
  opfsRepertoire: "app-a",
  opfsFichierDansRepertoire: "donnees.txt",
  idbNom: "vault-app-a",
  idbStore: "donnees",
  idbCle: "secret",
  storageCle: "vault.app-a.secret",
  /** Cookie posé avec `Path=/` : joignable depuis tout chemin de l'origine. */
  cookieGlobal: "vault_app_a_global",
  /** Cookie laissé à son chemin par défaut, c'est-à-dire au répertoire du document de A. */
  cookieChemin: "vault_app_a_chemin",
  verrou: "vault.app-a.ecrivain",
  canal: "vault.app-a.canal",
  cache: "vault-app-a",
  cacheRequete: "/spike/origin/app-a/ressource-en-cache",
});

/** Valeur déposée par A dans chacun de ses actifs. La retrouver ailleurs, c'est la lire. */
export const SECRET_A = "secret-application-a";

/** Ressource témoin de chaque application, interceptée par SON Service Worker. */
export const CANARY_NOM = "canary.txt";
export const CANARY_AUTHENTIQUE = "canary-authentique";
export const CANARY_INTERCEPTE_PAR_A = "canary-intercepte-par-app-a";

/** URL du document applicatif d'une application dans une topologie donnée. */
export function urlApplication(topologieId, application, parametres = {}) {
  const topologie = TOPOLOGIES_APPS[topologieId];
  if (!topologie) {
    throw new Error(
      `Topologie inconnue : ${topologieId}. Valeurs admises : ${TOPOLOGIES_APPS_IDS.join(", ")}.`,
    );
  }
  const base = application === "a" ? topologie.origineA : topologie.origineB;
  const chemin = application === "a" ? CHEMIN_APP_A : CHEMIN_APP_B;
  const url = new URL(chemin, base);
  url.searchParams.set("app", application);
  for (const [nom, valeur] of Object.entries(parametres)) url.searchParams.set(nom, valeur);
  return url.toString();
}
