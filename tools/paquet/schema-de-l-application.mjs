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

/** Le numéro de version d'un `schema.rb` : `define(version: "20260101000002")`. */
const VERSION_DU_DUMP = /\bdefine\s*\(\s*version:\s*["']?(\d{3,})["']?/;

/** Le préfixe d'un nom de migration : `20260101000002_create_records.rb`. */
const VERSION_DE_MIGRATION = /^(\d{3,})_/;

/**
 * REND le schéma de l'application, ou lève si elle n'en porte aucun.
 *
 * Une application sans migration n'est pas empaquetable : sa graine serait une base vide dont rien
 * ne dit ce qu'elle contient, et aucune mise à jour ne pourrait jamais être décidée.
 *
 * @param {{ schemaRb?: string | null, migrations?: string[] }} sources
 * @returns {string}
 */
export function schemaDeLApplication({ schemaRb = null, migrations = [] }) {
  const dump = typeof schemaRb === "string" ? schemaRb.match(VERSION_DU_DUMP) : null;
  if (dump !== null) return dump[1];

  const versions = migrations
    .map((nom) => nom.match(VERSION_DE_MIGRATION)?.[1])
    .filter((version) => version !== undefined);
  if (versions.length === 0) {
    throw new Error(
      "Schéma introuvable : l'application n'a ni db/schema.rb portant une version, ni migration " +
        "dans db/migrate. Un paquet sans schéma ne peut être ni installé ni mis à jour.",
    );
  }
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
