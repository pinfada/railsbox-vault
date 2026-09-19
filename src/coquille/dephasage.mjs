// Le DÉPHASAGE DE VERSIONS : la version et le schéma décident AVANT le boot (#236 T2, ADR 0042).
//
// Un coffre garde ses données d'une ouverture à l'autre ; l'origine, elle, change le code qu'elle
// sert. Ce module confronte les deux — le manifeste du volume `application`, lu par le Worker de
// confiance après le déverrouillage, et le descripteur servi — et rend une DÉCISION, sans rien lire,
// rien écrire ni rien booter. C'est ce qui permet de la mesurer par une campagne de mutation.
//
// ## La table : version (précédence SemVer 2.0.0) × schéma
//
// | version servie ↔ coffre | schéma servi <    | schéma servi =                | schéma servi >             |
// | ----------------------- | ----------------- | ----------------------------- | -------------------------- |
// | inférieure              | refus ANTÉRIEURE  | refus ANTÉRIEURE (rollback)   | refus ANTÉRIEURE           |
// | égale                   | refus DIVERGENT   | OUVRIR, rien à proposer       | refus DIVERGENT            |
// | supérieure              | refus ANTÉRIEURE  | mise à jour SANS migration    | mise à jour AVEC migration |
//
// Une version INFÉRIEURE est refusée même à schéma égal : c'est l'attaque par retour arrière
// (« rollback ») de The Update Framework, et une origine qui la sert — par erreur ou non — ne doit pas
// obtenir de la personne un clic « Mettre à jour » vers du code plus ancien. Deux paquets de même
// version et de schémas différents ne sont pas le même paquet : refus, jamais un choix.
//
// Avant la table, l'IDENTITÉ : aucune application servie → `APPLICATION_NON_SERVIE` ; une autre
// `app.id` → `APPLICATION_ETRANGERE`. Dans tous les refus : jamais de boot, jamais de migration,
// jamais de suppression proposée ; aucun octet du volume n'est écrit. Une mise à jour proposée n'est
// pas une ouverture : sans le geste, le coffre s'ouvre sur SA version si l'origine la sert encore (la
// rétention 1 du descripteur), et sinon le démarrage est refusé sous `APPLICATION_NON_SERVIE`.
//
// ## Une migration INTERROMPUE (`app.migration` au manifeste)
//
// Rails commite migration par migration : une coupure entre deux laisse un schéma INTERMÉDIAIRE, que
// l'ancien code lirait mal. Le Worker inscrit donc l'INTENTION (`app.migration` = la CIBLE, version et
// schéma) avant le boot qui migre, et l'efface quand le manifeste a suivi. Présente, elle ne laisse
// qu'une issue : la REPRISE de la mise à jour, par une version servie STRICTEMENT plus récente que celle
// du coffre ET d'un schéma au moins égal à celui de la cible — ni « Plus tard », ni le paquet précédent,
// ni un retour arrière déguisé en reprise (revue de sécurité de la PR #249, constat 1). Tout autre cas
// est refusé sous `MISE_A_JOUR_INTERROMPUE`. L'intention est lue AVANT la déduction du schéma d'un
// coffre de T1 : sa reprise ne dépend pas du paquet précédent (constat 5).
//
// ## Un coffre installé avant ce champ (T1) : la règle, écrite une fois
//
// Le manifeste d'un volume installé par T1 ne porte pas `app.schema`. Son schéma est alors INCONNU,
// et il n'est pas deviné : il vaut celui du paquet servi dont la VERSION est exactement celle du
// coffre (courant ou précédent) — c'est ce paquet-là qui l'a installé, sa graine portait ce schéma.
// Si aucun paquet servi n'a cette version — ou si la version du coffre n'est pas un SemVer —, le
// démarrage est refusé sous `SCHEMA_DU_COFFRE_INCONNU`.

import { CODES_REFUS_COQUILLE as C } from "./refus-de-coquille.mjs";

/** Les issues d'une décision de déphasage. */
export const ISSUES_DU_DEPHASAGE = Object.freeze({
  installer: "installer",
  ouvrir: "ouvrir",
  miseAJour: "mettre-a-jour",
  refus: "refus",
});

/** Les deux paquets qu'un descripteur peut servir : le courant et, en rétention 1, le précédent. */
export const PAQUETS_SERVIS = Object.freeze({ courant: "courant", precedent: "precedent" });

/**
 * Compare deux schémas comme ActiveRecord compare ses versions : en ENTIERS. `9` précède
 * `20260101000002` ; deux chaînes de même longueur se comparent caractère par caractère.
 *
 * @param {string} a @param {string} b
 * @returns {number} négatif si `a` précède `b`, nul s'ils sont égaux, positif sinon
 */
export function comparerSchemas(a, b) {
  const x = String(a).replace(/^0+(?=\d)/, "");
  const y = String(b).replace(/^0+(?=\d)/, "");
  if (x.length !== y.length) return x.length - y.length;
  return x < y ? -1 : x > y ? 1 : 0;
}

/** SemVer 2.0.0 : noyau, pré-version facultative, métadonnées de construction (ignorées). */
const SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** Vrai si la chaîne est une version SemVer 2.0.0. */
export function estUneVersion(version) {
  return typeof version === "string" && SEMVER.test(version);
}

/** Compare deux identifiants de pré-version (§ 11.4 de SemVer 2.0.0). */
function comparerIdentifiants(a, b) {
  const numA = /^\d+$/.test(a);
  const numB = /^\d+$/.test(b);
  if (numA && numB) return comparerSchemas(a, b);
  if (numA !== numB) return numA ? -1 : 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * La PRÉCÉDENCE SemVer 2.0.0 (§ 11) : le noyau en entiers, puis une pré-version PRÉCÈDE la version
 * sans pré-version, puis les identifiants de pré-version un à un. Les métadonnées de construction ne
 * comptent pas. Lève sur une chaîne qui n'est pas une version : l'appelant a contrôlé avant.
 *
 * @param {string} a @param {string} b
 */
export function comparerVersions(a, b) {
  const x = String(a).match(SEMVER);
  const y = String(b).match(SEMVER);
  if (x === null || y === null) throw new TypeError(`Version non SemVer : ${a} / ${b}.`);
  for (const rang of [1, 2, 3]) {
    const ecart = comparerSchemas(x[rang], y[rang]);
    if (ecart !== 0) return ecart;
  }
  if (x[4] === undefined || y[4] === undefined) {
    return (x[4] === undefined ? 1 : 0) - (y[4] === undefined ? 1 : 0);
  }
  const [ia, ib] = [x[4].split("."), y[4].split(".")];
  for (let rang = 0; rang < Math.min(ia.length, ib.length); rang += 1) {
    const ecart = comparerIdentifiants(ia[rang], ib[rang]);
    if (ecart !== 0) return ecart;
  }
  return ia.length - ib.length;
}

function versionEtSchema(application) {
  return { version: application.version, schema: application.schema };
}

/** Les paquets que le descripteur sert, du courant au précédent. */
function paquetsServis(descripteur) {
  const servis = [{ paquet: PAQUETS_SERVIS.courant, ...versionEtSchema(descripteur.application) }];
  if (descripteur.precedent !== undefined) {
    servis.push({
      paquet: PAQUETS_SERVIS.precedent,
      ...versionEtSchema(descripteur.precedent.application),
    });
  }
  return servis;
}

/**
 * Le SCHÉMA du coffre : celui que son manifeste déclare, ou — pour un volume de T1 — celui du paquet
 * servi de MÊME VERSION. `null` si aucun ne peut le dire.
 */
function schemaDuCoffre(app, servis) {
  if (typeof app.schema === "string") return { schema: app.schema, deduit: false };
  // Même PRÉCÉDENCE, et non même chaîne : `1.0.0+x` est la version `1.0.0` (revue de #249, LOW).
  const meme = servis.find(
    (servi) => estUneVersion(servi.version) && comparerVersions(servi.version, app.version) === 0,
  );
  return meme === undefined ? null : { schema: meme.schema, deduit: true };
}

/** @param {string} code @param {object} contexte */
function refus(code, contexte) {
  return Object.freeze({ issue: ISSUES_DU_DEPHASAGE.refus, code, ...contexte });
}

/**
 * DÉCIDE ce que l'ouverture d'un coffre peut faire, avant tout boot.
 *
 * @param {{ manifeste: { app: { id: string, version: string, schema?: string,
 *                                migration?: string } } | null,
 *           descripteur: object | null }} entrees
 *   `manifeste` est le manifeste PARSÉ du volume `application`, ou `null` s'il n'existe pas encore ;
 *   `descripteur` est le descripteur servi et ADMIS (`formeDuDescripteur`), ou `null`.
 */
export function deciderLeDephasage({ manifeste, descripteur }) {
  if (manifeste === null) return Object.freeze({ issue: ISSUES_DU_DEPHASAGE.installer });
  const app = manifeste.app;
  const coffre = { id: app.id, version: app.version, schema: app.schema ?? null };
  if (descripteur === null) return refus(C.applicationNonServie, { coffre, servie: null });
  const servie = { id: descripteur.application.id, ...versionEtSchema(descripteur.application) };
  if (app.id !== servie.id) return refus(C.applicationEtrangere, { coffre, servie });
  if (!estUneVersion(app.version)) return refus(C.schemaDuCoffreInconnu, { coffre, servie });
  if (app.migration !== undefined) {
    return deciderLaReprise({ constat: coffre, servie, cible: app.migration });
  }
  const connu = schemaDuCoffre(app, paquetsServis(descripteur));
  if (connu === null) return refus(C.schemaDuCoffreInconnu, { coffre, servie });
  const constat = { ...coffre, schema: connu.schema, schemaDeduit: connu.deduit };
  return deciderSurLaTable({ constat, servie, servis: paquetsServis(descripteur) });
}

/**
 * La TABLE version × schéma, une fois l'identité admise. Extraite de `deciderLeDephasage` pour rester
 * sous le plafond de fonction (#93).
 */
function deciderSurLaTable({ constat, servie, servis }) {
  const version = comparerVersions(servie.version, constat.version);
  const schema = comparerSchemas(servie.schema, constat.schema);
  if (version < 0 || (version > 0 && schema < 0)) {
    return refus(C.applicationAnterieure, { coffre: constat, servie });
  }
  if (version === 0) {
    if (schema !== 0) return refus(C.schemaDivergent, { coffre: constat, servie });
    return Object.freeze({
      issue: ISSUES_DU_DEPHASAGE.ouvrir,
      paquet: PAQUETS_SERVIS.courant,
      coffre: constat,
      servie,
    });
  }
  // Le coffre peut-il s'ouvrir SUR SA VERSION ? Seulement si l'origine sert encore un paquet de
  // cette version exacte ET de ce schéma exact : « Plus tard » ne doit pas devenir une mise à jour
  // déguisée, ni un retour arrière.
  const actuel = servis.find(
    (servi) =>
      servi.paquet === PAQUETS_SERVIS.precedent &&
      servi.version === constat.version &&
      comparerSchemas(servi.schema, constat.schema) === 0,
  );
  return Object.freeze({
    issue: ISSUES_DU_DEPHASAGE.miseAJour,
    coffre: constat,
    servie,
    migration: schema > 0,
    plusTard: actuel !== undefined,
    reprise: false,
  });
}

/**
 * Une migration INTERROMPUE : la seule issue est de la REPRENDRE, par une version servie STRICTEMENT
 * plus récente que celle du coffre ET d'un schéma au moins égal à celui de la cible. Ni « Plus tard »,
 * ni le précédent, ni une version égale ou plus ancienne : refus `MISE_A_JOUR_INTERROMPUE`.
 */
function deciderLaReprise({ constat, servie, cible }) {
  const plusRecente = comparerVersions(servie.version, constat.version) > 0;
  if (!plusRecente || comparerSchemas(servie.schema, cible.schema) < 0) {
    return refus(C.miseAJourInterrompue, { coffre: { ...constat, migration: cible }, servie });
  }
  return Object.freeze({
    issue: ISSUES_DU_DEPHASAGE.miseAJour,
    coffre: { ...constat, migration: cible },
    servie,
    migration: true,
    plusTard: false,
    reprise: true,
  });
}

/**
 * Le PAQUET que le démarrage doit booter, selon la décision et le GESTE reçu.
 *
 * `miseAJour` n'est vrai que si la personne a cliqué « Mettre à jour l'application » : c'est la
 * seule façon d'obtenir une migration. Sans lui, une mise à jour proposée ouvre le précédent s'il
 * est servi, et refuse sinon — jamais le courant.
 *
 * @param {ReturnType<typeof deciderLeDephasage>} decision
 * @param {{ miseAJour?: boolean }} [geste]
 * @returns {{ paquet: string, application: object | null, miseAJour: boolean } | { refus: string }}
 */
export function paquetADemarrer(decision, { miseAJour = false } = {}) {
  if (decision.issue === ISSUES_DU_DEPHASAGE.refus) return { refus: decision.code };
  if (decision.issue !== ISSUES_DU_DEPHASAGE.miseAJour) {
    return {
      paquet: PAQUETS_SERVIS.courant,
      application: decision.servie ?? null,
      miseAJour: false,
    };
  }
  if (miseAJour === true) {
    return { paquet: PAQUETS_SERVIS.courant, application: decision.servie, miseAJour: true };
  }
  if (decision.plusTard) {
    return {
      paquet: PAQUETS_SERVIS.precedent,
      application: { version: decision.coffre.version, schema: decision.coffre.schema },
      miseAJour: false,
    };
  }
  return { refus: C.applicationNonServie };
}
