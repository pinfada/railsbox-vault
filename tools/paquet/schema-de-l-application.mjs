// Le SCHÉMA d'une application : la dernière migration qu'elle porte (#236, ADR 0041).
//
// C'est la grandeur qui décidera, en T2, si un paquet peut ouvrir un coffre : le manifeste du volume
// portera le schéma CONSTATÉ, `paquet.json` le schéma SERVI, et la coquille comparera les deux
// AVANT le boot — jamais après avoir lancé du vieux code sur des données récentes.
//
// Deux sources, dans cet ordre :
//
//   1. `db/schema.rb`, quand l'application en dépose un : `ActiveRecord::Schema[8.0].define(version:
//      "20260101000002")` porte exactement ce que la base migrée déclare ;
//   2. le plus grand préfixe de `db/migrate/*.rb`, sinon. L'application de référence est dans ce cas
//      — son `schema.rb` n'est pas commité — et c'est aussi le cas de toute application dont le
//      dépôt ignore le dump.
//
// Ce module ne lit aucun fichier : on lui donne le texte et la liste des noms. C'est ce qui permet
// de l'exercer sur une application qui n'existe pas.

/**
 * Le numéro de version d'un `schema.rb` : `define(version: "20260101000002")`, ou — c'est ce que
 * Rails écrit depuis 5.0 — un littéral Ruby à SOULIGNÉS, `define(version: 2026_08_18_213000)`. Le
 * motif s'arrêtait au premier souligné, et l'essai réel de #351 avait retenu le schéma « 2026 ».
 */
const VERSION_DU_DUMP = /\bdefine\s*\(\s*version:\s*["']?(\d[\d_]*)["']?/;

/**
 * Le schéma d'une application SANS migration : `0`, la version qu'ActiveRecord donne à une base
 * dont `schema_migrations` est vide. C'est l'état de toute application que `rails new` vient d'écrire
 * (#351) ; la refuser obligeait l'application à inventer une migration pour l'outil.
 */
export const SCHEMA_SANS_MIGRATION = "0";

/** Le préfixe d'un nom de migration : `20260101000002_create_records.rb`. */
const VERSION_DE_MIGRATION = /^(\d{3,})_/;

/**
 * REND le schéma de l'application, ou lève s'il n'a pas la forme que le guest compare.
 *
 * Une application sans migration avait été refusée : sa graine « ne dirait pas ce qu'elle
 * contient ». Elle le dit pourtant, comme ActiveRecord : une base vide, au schéma `0`, que la
 * première migration d'une version suivante fera avancer par le chemin ordinaire de l'ADR 0042
 * (#351, ADR 0055).
 *
 * @param {{ schemaRb?: string | null, migrations?: string[] }} sources
 * @returns {string}
 */
export function schemaDeLApplication(sources) {
  const schema = schemaLu(sources);
  // La forme que le guest et le manifeste exigent : quatorze chiffres au plus, sans zéro de tête
  // (revue de sécurité de la PR #249, constat 3). Hors de cette forme, `dash` ne compare plus.
  if (!/^(0|[1-9][0-9]{0,13})$/.test(schema)) {
    throw new Error(
      `Schéma refusé : « ${schema} ». Une version de migration de quatorze chiffres au plus, ` +
        "sans zéro de tête, est exigée.",
    );
  }
  return schema;
}

/** Le schéma tel que la source le déclare, avant le contrôle de sa forme. */
function schemaLu({ schemaRb = null, migrations = [] }) {
  const dump = typeof schemaRb === "string" ? schemaRb.match(VERSION_DU_DUMP) : null;
  if (dump !== null) return dump[1].replaceAll("_", "");

  const versions = migrations
    .map((nom) => nom.match(VERSION_DE_MIGRATION)?.[1])
    .filter((version) => version !== undefined);
  if (versions.length === 0) return SCHEMA_SANS_MIGRATION;
  // Comparaison LEXICOGRAPHIQUE sur des horodatages de même longueur, et NUMÉRIQUE sinon : les
  // versions d'ActiveRecord sont des entiers, et `9` vient avant `20260101000002`.
  return versions.reduce((plusGrande, version) =>
    comparerVersions(version, plusGrande) > 0 ? version : plusGrande,
  );
}

/** Compare deux versions de migration comme ActiveRecord les compare : en nombres. */
function comparerVersions(gauche, droite) {
  if (gauche.length !== droite.length) return gauche.length - droite.length;
  return gauche < droite ? -1 : gauche > droite ? 1 : 0;
}
