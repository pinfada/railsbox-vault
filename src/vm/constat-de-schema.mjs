// Le CONSTAT DE SCHÉMA que le guest imprime sur la série avant de lancer Rails (#236 T2, ADR 0042).
//
// `/opt/vault/schema-du-volume.sh` compare, dans le guest, le marqueur `/app/var/.vault-schema` des
// DONNÉES, le marqueur `/app/db/.vault-schema` du PAQUET, le schéma que le manifeste du coffre ATTEND
// (`vault.schema=` sur la ligne de commande du noyau) et l'INTENTION d'une migration commencée
// (`/app/var/.vault-migration`). Il dit ce qu'il a fait en lignes préfixées `[schema]`, AVANT que le
// pont série ne prenne ttyS0 :
//
//     [schema] volume=M paquet=N attendu=E intention=I
//     [schema] rails : == 20260919000001 AjouterUneNote: migrated (0.0213s)
//     [schema] migration aucune schema=N
//     [schema] migration jouee de=M vers=N ms=D
//     [schema] REFUS divergent volume=V paquet=P attendu=E
//     [schema] REFUS anterieur volume=V paquet=P
//     [schema] REFUS migration-echouee de=M vers=N code=C
//     [schema] REFUS marqueur-invalide
//     [schema] REFUS parametre-double
//     [schema] REFUS migration-non-autorisee volume=V paquet=P
//
// Ce module les LIT, et il ne décide rien de la coquille : il ne connaît aucun code de refus — il
// appartient à `src/vm/`, qui ne connaît pas la coquille. Un REFUS rejette la promesse `refus` avec
// son motif (`motifDeSchema`), pour que le boot n'attende pas cinq minutes une santé que Rails, non
// lancé, ne rendra jamais ; c'est l'appelant qui traduit le motif en code.

import { phaseDeLaLigne, poserLaPhase } from "./phase-du-boot.mjs";

const PREFIXE = "[schema] ";

/** Les motifs de refus que le guest peut imprimer. Une autre valeur n'est pas un refus connu. */
export const MOTIFS_DE_SCHEMA = Object.freeze({
  divergent: "divergent",
  anterieur: "anterieur",
  migrationEchouee: "migration-echouee",
  marqueurInvalide: "marqueur-invalide",
  parametreDouble: "parametre-double",
  migrationNonAutorisee: "migration-non-autorisee",
});

/** Un schéma imprimé par le guest : des chiffres, ou `absent` quand un marqueur manque. */
const VALEUR = /^([a-z]+)=([0-9]{1,32}|absent)$/;

/** Une migration COMMITÉE par Rails, redite par le guest : « == version Nom: migrated ». */
const MIGRATION_COMMISE = /^\[schema\] rails : == (\d{1,32}) \S+: migrated\b/;

/** Lit les paires `cle=valeur` d'une ligne ; les autres mots sont rendus à part. */
function lirePaires(mots) {
  const paires = {};
  const libres = [];
  for (const mot of mots) {
    const trouve = mot.match(VALEUR);
    if (trouve === null) libres.push(mot);
    else paires[trouve[1]] = trouve[2];
  }
  return { paires, libres };
}

function pairesUtiles(paires) {
  const utiles = {};
  for (const cle of ["volume", "paquet", "attendu", "intention"]) {
    if (paires[cle] !== undefined) utiles[cle] = paires[cle] === "absent" ? null : paires[cle];
  }
  return utiles;
}

function duree(texte) {
  if (typeof texte !== "string") return null;
  const valeur = Number.parseInt(texte, 10);
  return Number.isFinite(valeur) ? valeur : null;
}

/** Le constat vierge : rien n'a encore été dit. */
function constatVierge() {
  return {
    volume: null,
    paquet: null,
    attendu: null,
    intention: null,
    migration: null,
    refus: null,
    commises: [],
  };
}

/** Ce que dit une ligne `migration …` : jouée (de, vers, durée) ou aucune (schéma). */
function migrationDite(libres, paires) {
  return libres[1] === "jouee"
    ? { jouee: true, de: paires.de ?? null, vers: paires.vers ?? null, ms: duree(paires.ms) }
    : { jouee: false, schema: paires.schema ?? null };
}

/**
 * APPLIQUE une ligne au constat, et rend le constat suivant avec le motif de refus éventuel. Pure :
 * le veilleur ne fait que garder l'état et rejeter sa promesse.
 *
 * @param {object | null} constat @param {string} ligne
 * @returns {{ constat: object | null, refus: string | null }}
 */
export function lireUneLigne(constat, ligne) {
  if (!ligne.startsWith(PREFIXE)) return { constat, refus: null };
  const courant = constat ?? constatVierge();
  const commise = ligne.match(MIGRATION_COMMISE);
  if (commise !== null) {
    return { constat: { ...courant, commises: [...courant.commises, commise[1]] }, refus: null };
  }
  const [tete, ...reste] = ligne.slice(PREFIXE.length).trim().split(/\s+/);
  if (tete === "rails") return { constat: courant, refus: null };
  if (tete === "REFUS") {
    const { paires, libres } = lirePaires(reste);
    const motif = Object.values(MOTIFS_DE_SCHEMA).includes(libres[0]) ? libres[0] : "inconnu";
    return { constat: { ...courant, refus: motif, ...pairesUtiles(paires) }, refus: motif };
  }
  const { paires, libres } = lirePaires([tete, ...reste]);
  if (libres[0] === "migration") {
    return { constat: { ...courant, migration: migrationDite(libres, paires) }, refus: null };
  }
  return { constat: { ...courant, ...pairesUtiles(paires) }, refus: null };
}

/**
 * Crée le VEILLEUR : il ingère le flux série brut, retient le constat, et rejette `refus` au
 * premier refus imprimé.
 *
 * @returns {{ ingererSerie: (fragment: string) => void, refus: Promise<never>,
 *             constat: () => object | null }}
 */
export function creerVeilleurDeSchema() {
  let tampon = "";
  let constat = null;
  let rejeter;
  const refus = new Promise((_, reject) => {
    rejeter = reject;
  });
  // Une promesse que personne n'attend encore ne doit pas se signaler comme rejet non traité : le
  // boot l'attend en course avec la santé, mais un refus peut précéder cette course.
  refus.catch(() => {});
  const lire = (ligne) => {
    // La PHASE que la page affiche (QA de #249, Q2) : les données se mettent à jour, ou c'est fini.
    const phase = phaseDeLaLigne(ligne);
    if (phase !== null) poserLaPhase(phase);
    const lu = lireUneLigne(constat, ligne);
    constat = lu.constat;
    if (lu.refus === null) return;
    const erreur = new Error(`Le guest refuse de lancer l'application : ${ligne.trim()}`);
    rejeter(Object.assign(erreur, { motifDeSchema: lu.refus }));
  };
  return {
    ingererSerie(fragment) {
      tampon += fragment;
      let fin = tampon.indexOf("\n");
      while (fin !== -1) {
        lire(tampon.slice(0, fin).replace(/\r$/, ""));
        tampon = tampon.slice(fin + 1);
        fin = tampon.indexOf("\n");
      }
      // Le flux série porte aussi le pont @VLT1 : une ligne jamais terminée ne doit pas grossir sans
      // borne. Un constat tient en moins de 200 caractères.
      if (tampon.length > 4096) tampon = tampon.slice(-256);
    },
    refus,
    constat: () => (constat === null ? null : { ...constat, commises: [...constat.commises] }),
  };
}
