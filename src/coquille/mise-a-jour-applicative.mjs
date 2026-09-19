// La MISE À JOUR d'une application, côté Worker de confiance (#236 T2, ADR 0042).
//
// `dephasage.mjs` DÉCIDE, sans rien lire ; ce module LIT ce que la décision demande — le manifeste du
// volume `application`, après le déverrouillage —, choisit le paquet à booter, et fait SUIVRE le
// manifeste une fois que le guest a dit ce qu'il a fait. Il vit hors de `public/runtime-worker.mjs`,
// qui est sous dérogation de taille (#191) : le Worker l'importe et ne l'allonge pas.
//
// ## Ce qui est écrit, et quand
//
// RIEN avant le boot. Après un boot à froid RÉUSSI, et seulement alors, le manifeste suit le constat
// du guest : sa version devient celle du paquet booté, son schéma celui que le marqueur des données
// porte désormais. Le guest n'imprime « migration jouee » qu'APRÈS le `sync` qui a validé la
// génération portant la base migrée et le marqueur : le manifeste ne passe donc jamais à N avant que
// les données y soient, sous une génération validée. Une coupure entre les deux laisse un manifeste
// en retard sur des données à N — l'état que `schema-du-volume.sh` reconnaît (V = P) et que la
// prochaine ouverture rattrape.

import {
  ISSUES_DU_DEPHASAGE,
  PAQUETS_SERVIS,
  deciderLeDephasage,
  paquetADemarrer,
} from "./dephasage.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { MOTIFS_DE_SCHEMA } from "../vm/constat-de-schema.mjs";
import { PHASES_DU_BOOT, autoriserLaPhaseDesDonnees, poserLaPhase } from "../vm/phase-du-boot.mjs";
import { readVolumeManifest, writeVolumeManifest } from "../vm/opfs-volume-open.mjs";
import {
  SCHEMA_APPLICATIF,
  manifesteAvecApplication,
  manifesteAvecIntention,
  parseManifest,
} from "../vm/volume-manifest.mjs";

/** Le paramètre de noyau qui porte le schéma que le manifeste du coffre ATTEND. */
export const PARAMETRE_DE_SCHEMA = "vault.schema";

/**
 * Le paramètre de noyau qui AUTORISE le guest à migrer, posé par le Worker sous le seul geste « Mettre
 * à jour » (revue de sécurité de la PR #249, constat 4). Sans lui, un paquet qui dépasse les données est
 * refusé par le guest : une migration ne se joue jamais sur la foi d'un schéma DÉCLARÉ. L'espace
 * « vault.* » est refusé dans la ligne SERVIE (descripteur-applicatif.mjs) : seul le Worker l'écrit.
 */
export const PARAMETRE_DE_MIGRATION = "vault.migrer=1";

/** Un boot qui migre charge Rails DEUX fois : son délai est doublé, et le dit. */
export const FACTEUR_DU_DELAI_DE_MIGRATION = 2;

/**
 * LIT le manifeste du volume `application`, ou rend `null` s'il n'y en a pas — ou s'il est illisible :
 * ces deux cas appartiennent à la voie d'installation (`installerSiNecessaire`), qui les refuse ou
 * les installe selon ses propres règles (ADR 0030, ADR 0037). La décision de déphasage n'a rien à
 * dire d'un volume qui ne se déclare pas.
 *
 * @param {string} nom @param {{ lire?: typeof readVolumeManifest }} [primitives]
 */
export async function lireLeManifesteDuCoffre(nom, { lire = readVolumeManifest } = {}) {
  let octets;
  try {
    octets = await lire(nom);
  } catch {
    return null;
  }
  if (octets === null) return null;
  try {
    return parseManifest(octets);
  } catch {
    return null;
  }
}

/**
 * Le DESCRIPTEUR du paquet choisi : le courant tel quel, ou le précédent substitué au courant.
 *
 * La substitution ne touche que l'application et son paquet : le rootfs, la graine et le boot sont
 * communs (la rétention 1 est celle de l'APPLICATION). Tout ce qui suit — adresses, empreinte
 * d'image de l'instantané, manifeste attendu — lit ce descripteur-là et n'a rien à savoir de plus.
 *
 * @param {object} descripteur @param {string} paquet
 */
export function descripteurDuPaquet(descripteur, paquet) {
  if (paquet !== PAQUETS_SERVIS.precedent) return descripteur;
  const { precedent, ...courant } = descripteur;
  return {
    ...courant,
    application: { id: descripteur.application.id, ...precedent.application },
    paquet: precedent.paquet,
  };
}

/**
 * La LIGNE DE COMMANDE du guest, augmentée du schéma attendu quand le coffre le connaît.
 *
 * Elle est composée ICI, après le contrôle du descripteur : la valeur ajoutée est un nombre que ce
 * module a lu dans un manifeste parsé (`SCHEMA_APPLICATIF`), jamais une chaîne servie.
 */
export function ligneDeCommande(cmdline, schemaAttendu, { migrer = false } = {}) {
  const parties = [cmdline];
  if (typeof schemaAttendu === "string" && SCHEMA_APPLICATIF.test(schemaAttendu)) {
    parties.push(`${PARAMETRE_DE_SCHEMA}=${schemaAttendu}`);
  }
  if (migrer === true) parties.push(PARAMETRE_DE_MIGRATION);
  return parties.join(" ");
}

/**
 * Ce que la décision PUBLIE sur le canal privilégié : des valeurs simples, rien du descripteur servi
 * au-delà des versions et des schémas qu'une personne doit lire pour décider.
 *
 * @param {ReturnType<typeof deciderLeDephasage>} decision
 */
export function decisionPubliee(decision) {
  const simple = (partie) =>
    partie === null || partie === undefined
      ? null
      : { id: partie.id ?? null, version: partie.version ?? null, schema: partie.schema ?? null };
  return {
    issue: decision.issue,
    code: decision.code ?? null,
    coffre: simple(decision.coffre),
    servie: simple(decision.servie),
    migration: decision.migration === true,
    plusTard: decision.plusTard === true,
    reprise: decision.reprise === true,
    // La CIBLE d'une mise à jour commencée : ce que la sauvegarde exigera pour se rouvrir (QA, Q8).
    cible: simple(decision.coffre?.migration),
  };
}

/**
 * CONSTATE le déphasage : le descripteur lu, le manifeste du coffre lu, la décision prise. Rien n'est
 * écrit, rien n'est booté.
 *
 * @param {{ lu: { present: boolean, descripteur?: object }, nom: string,
 *           lireManifeste?: typeof lireLeManifesteDuCoffre }} entrees
 */
export async function constaterLeDephasage({ lu, nom, lireManifeste = lireLeManifesteDuCoffre }) {
  const manifeste = await lireManifeste(nom);
  const decision = deciderLeDephasage({
    manifeste,
    descripteur: lu.present ? lu.descripteur : null,
  });
  return { manifeste, decision };
}

/**
 * PRÉPARE un démarrage : le paquet à booter, sa ligne de commande, son délai — ou le refus.
 *
 * @param {{ lu: object, nom: string, miseAJour?: boolean, delaiMs: number,
 *           lireManifeste?: Function }} entrees
 */
export async function preparerLeDemarrage({ lu, nom, miseAJour = false, delaiMs, lireManifeste }) {
  poserLaPhase(PHASES_DU_BOOT.telechargement);
  const { manifeste, decision } = await constaterLeDephasage({ lu, nom, lireManifeste });
  if (decision.issue === ISSUES_DU_DEPHASAGE.installer && !lu.present) {
    return { sansApplication: true, motif: lu.motif };
  }
  const choix = paquetADemarrer(decision, { miseAJour });
  if (choix.refus !== undefined) {
    return {
      refus: choix.refus,
      dephasage: decisionPubliee(decision),
    };
  }
  const descripteur = descripteurDuPaquet(lu.descripteur, choix.paquet);
  const migration = choix.miseAJour && decision.migration === true;
  return {
    descripteur,
    manifeste,
    miseAJour: choix.miseAJour,
    migration,
    // Le schéma DÉDUIT d'un coffre de T1, que l'intention inscrira (revue de #249, constat 5).
    schemaDeduit: decision.coffre?.schemaDeduit === true ? decision.coffre.schema : null,
    cmdline: ligneDeCommande(descripteur.boot.cmdline, decision.coffre?.schema ?? null, {
      migrer: migration,
    }),
    delaiMs: choix.miseAJour ? delaiMs * FACTEUR_DU_DELAI_DE_MIGRATION : delaiMs,
    dephasage: decisionPubliee(decision),
  };
}

/**
 * INSCRIT l'INTENTION de migrer, AVANT le boot qui migre (#236 T2, ADR 0042) : le manifeste porte
 * `app.migration` = le schéma visé, et toute ouverture suivante — tant que le manifeste n'a pas suivi
 * — ne proposera que la REPRISE. Rails commite migration par migration ; sans cette intention, une
 * coupure entre deux laisserait un schéma intermédiaire que « Plus tard » rouvrirait avec l'ancien code.
 *
 * Seul geste d'écriture avant le boot, et seulement sous le geste « Mettre à jour » : un refus n'écrit
 * jamais rien.
 *
 * Rend le CROCHET `avantLeBoot` de `bootEtVerifier`, qui ne l'appelle qu'une fois le disque système
 * ACQUIS et VÉRIFIÉ (recette QA de la PR #249, Q1) : inscrite avant le téléchargement, l'intention
 * faisait perdre « Plus tard » à une coupure pendant laquelle rien n'avait été migré. Une coupure
 * AVANT le crochet ne change donc rien au coffre ; une coupure APRÈS ne laisse que la reprise.
 *
 * @param {{ nom: string, prepare: object, inscrire?: typeof writeVolumeManifest }} entrees
 */
export function avantLeBootDuPaquet({ nom, prepare, inscrire = writeVolumeManifest }) {
  return async () => {
    poserLaPhase(PHASES_DU_BOOT.demarrage);
    // « Mise à jour de vos données » ne s'affiche que sous le geste qui migre (contre-recette, 1).
    autoriserLaPhaseDesDonnees(prepare.migration === true);
    await inscrireLIntention({ nom, prepare, inscrire });
  };
}

/**
 * INSCRIT l'intention (voir `avantLeBootDuPaquet`, seul appelant du chemin de produit).
 *
 * @param {{ nom: string, prepare: object, inscrire?: typeof writeVolumeManifest }} entrees
 */
export async function inscrireLIntention({ nom, prepare, inscrire = writeVolumeManifest }) {
  if (prepare.migration !== true || prepare.manifeste === null) return false;
  const cible = {
    version: prepare.descripteur.application.version,
    schema: prepare.descripteur.application.schema,
  };
  const deja = prepare.manifeste.app.migration;
  if (deja?.version === cible.version && deja?.schema === cible.schema) return false;
  await inscrire(
    nom,
    manifesteAvecIntention(prepare.manifeste, cible, prepare.schemaDeduit ?? null),
  );
  return true;
}

/**
 * TRADUIT le refus imprimé par le guest en code de la coquille, ou rend `null` si l'erreur n'en est
 * pas un. `src/vm/` ne nomme aucun code : c'est ici, côté coquille, qu'il reçoit le sien.
 *
 * @param {unknown} erreur
 */
export function codeDuRefusDuGuest(erreur) {
  const motif = erreur?.motifDeSchema;
  if (motif === undefined) return null;
  return CODES_DES_MOTIFS[motif] ?? CODES_REFUS_COQUILLE.schemaDivergent;
}

/** Le code de coquille de chaque motif de refus du guest ; un motif inconnu reste « divergent ». */
const CODES_DES_MOTIFS = Object.freeze({
  [MOTIFS_DE_SCHEMA.migrationEchouee]: CODES_REFUS_COQUILLE.migrationEchouee,
  [MOTIFS_DE_SCHEMA.marqueurInvalide]: CODES_REFUS_COQUILLE.marqueurDeSchemaInvalide,
  [MOTIFS_DE_SCHEMA.parametreDouble]: CODES_REFUS_COQUILLE.parametreDuGuestRefuse,
  [MOTIFS_DE_SCHEMA.migrationNonAutorisee]: CODES_REFUS_COQUILLE.migrationNonAutorisee,
});

/**
 * Le SCHÉMA que les données portent au sortir du boot, selon le constat du guest — ou `null` si le
 * guest n'a rien dit (reprise par instantané) ou a refusé.
 */
function schemaConstate(constat) {
  if (constat === null || constat === undefined || constat.refus !== null) return null;
  if (constat.migration?.jouee === true) return constat.migration.vers ?? null;
  return constat.volume ?? null;
}

/**
 * Fait SUIVRE le manifeste du coffre après un boot RÉUSSI : sa version devient celle du paquet booté,
 * son schéma celui que les données portent. Rend ce qui a été écrit, ou pourquoi rien ne l'a été.
 *
 * Trois gardes, et chacune dit « ne rien écrire » plutôt que deviner :
 *  - aucun constat (reprise par instantané) : rien n'a été rejoué, rien n'a changé ;
 *  - un schéma constaté qui n'est pas celui du paquet booté : les données ne sont pas dans l'état que
 *    ce code attend, et le manifeste ne l'affirmera pas ;
 *  - rien à changer : la version et le schéma sont déjà ceux-là.
 *
 * @param {{ nom: string, manifeste: object | null, application: { version: string, schema: string },
 *           constat: object | null, inscrire?: typeof writeVolumeManifest,
 *           lireManifeste?: typeof lireLeManifesteDuCoffre }} entrees
 */
export async function suivreLeConstat({
  nom,
  manifeste,
  application,
  constat,
  inscrire = writeVolumeManifest,
  lireManifeste = lireLeManifesteDuCoffre,
}) {
  const schema = schemaConstate(constat);
  if (schema === null) return { ecrit: false, motif: "aucun constat du guest" };
  if (schema !== application.schema) {
    return { ecrit: false, motif: `schéma constaté ${schema}, paquet ${application.schema}` };
  }
  // Le manifeste d'avant le boot, ou — pour une installation qui vient d'avoir lieu — celui qu'elle a
  // inscrit : c'est lui qu'on fait suivre, jamais un manifeste reconstruit de rien.
  const avant = manifeste ?? (await lireManifeste(nom));
  if (avant === null) return { ecrit: false, motif: "aucun manifeste à faire suivre" };
  if (
    avant.app.version === application.version &&
    avant.app.schema === schema &&
    avant.app.migration === undefined
  ) {
    return { ecrit: false, motif: "déjà à jour" };
  }
  await inscrire(nom, manifesteAvecApplication(avant, { version: application.version, schema }));
  return {
    ecrit: true,
    de: { version: avant.app.version, schema: avant.app.schema ?? null },
    vers: { version: application.version, schema },
  };
}

/**
 * La RÉPONSE d'un démarrage qui n'a pas démarré, telle que le Worker de confiance la poste.
 *
 * Extraite de `public/runtime-worker.mjs` (#191, dérogation de taille) quand le déphasage l'a
 * enrichie : le CODE distingue « rien à servir » (défaut, aucune application) du refus « sans
 * manifeste » (#173), qui porte la SIGNATURE — la page ne peut décider d'offrir le bouton de reprise
 * qu'en lisant `installationInterrompue`, jamais en devinant depuis le code seul —, et des refus de
 * déphasage, qui portent la DÉCISION publiée (#236 T2).
 *
 * @param {{ motif?: string, code?: string, installationInterrompue?: boolean, installee?: boolean,
 *           motifDeLaSignature?: string | null, dephasage?: object }} demarrage
 */
export function reponseDeDemarrageRefuse(demarrage) {
  return {
    demarree: false,
    motif: demarrage.motif,
    code: demarrage.code ?? CODES_REFUS_COQUILLE.applicationAbsente,
    ...(demarrage.installationInterrompue === undefined
      ? {}
      : {
          installationInterrompue: demarrage.installationInterrompue,
          motifDeLaSignature: demarrage.motifDeLaSignature ?? null,
        }),
    // Un volume INSTALLÉ dont le premier boot n'a pas abouti (#250) : la reprise redémarre.
    ...(demarrage.installee === true ? { installee: true } : {}),
    ...(demarrage.dephasage === undefined ? {} : { dephasage: demarrage.dephasage }),
  };
}

/**
 * Ce que la mise à jour d'un démarrage RÉUSSI publie : des valeurs simples, à plat (#236 T2). Le
 * relevé de la page et les épreuves de bout en bout y lisent si une migration a été jouée, de quel
 * schéma à quel schéma, en combien de temps, et si le manifeste a suivi.
 *
 * @param {object | undefined} miseAJour @param {object | null | undefined} constat
 */
export function miseAJourPubliee(miseAJour, constat) {
  if (miseAJour === undefined) return null;
  const migration = constat?.migration ?? null;
  return {
    issue: miseAJour.issue ?? null,
    geste: miseAJour.jouee === true,
    versionDuCoffre: miseAJour.coffre?.version ?? null,
    schemaDuCoffre: miseAJour.coffre?.schema ?? null,
    versionServie: miseAJour.servie?.version ?? null,
    schemaServi: miseAJour.servie?.schema ?? null,
    constatDuGuest: constat !== null && constat !== undefined,
    schemaDesDonnees: constat?.volume ?? null,
    migrationJouee: migration?.jouee === true,
    migrationDe: migration?.de ?? null,
    migrationVers: migration?.vers ?? null,
    migrationMs: migration?.ms ?? null,
    manifesteEcrit: miseAJour.manifeste?.ecrit === true,
  };
}
