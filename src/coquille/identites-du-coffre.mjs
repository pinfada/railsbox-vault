// Les IDENTITÉS du coffre de la coquille (#207, ADR 0039).
//
// ## Un coffre = une identité
//
// Le coffre de la coquille tient DEUX volumes sous la même clé de volume (ADR 0030) : `application`,
// le disque que Rails écrit, et `coquille`, trente-deux secteurs où le Worker de confiance franchit
// sa propre barrière. Jusqu'au 13/09/2026, l'enveloppe était liée à l'identifiant du volume
// `coquille` — une constante — et le volume `application` naissait sous un identifiant TIRÉ à
// l'installation. C'était juste tant qu'aucune archive ne sortait du coffre : une archive porte UN
// volume et la page de récupération qui l'ouvre, et cette page doit authentifier l'identifiant de CE
// volume (`assertEnveloppeDuMemeVolume`, ADR 0027). Sous deux identités, l'archive du disque de Rails
// n'emportait aucune enveloppe ouvrable ailleurs — l'épreuve `coquille-identite-du-coffre.test.mjs`
// le rejoue.
//
// Depuis l'ADR 0039, le volume `application` NAÎT sous l'identifiant que l'enveloppe authentifie, et
// le volume `coquille` reçoit une constante DISTINCTE. Deux propriétés tiennent, et elles sont la
// raison d'être de ce fichier :
//
//  - **jamais deux volumes sous la même clé ET le même identifiant** (ADR 0015) : les données
//    associées d'un secteur portent l'identifiant de son volume, et deux volumes qui le partageraient
//    se rejoueraient l'un dans l'autre. `application` et `coquille` gardent deux identifiants ;
//  - **une constante partagée par tous les coffres est sans effet** : l'identifiant n'est pas un
//    secret et ne sépare pas deux coffres — la CLÉ le fait, tirée par coffre (`tirerCleDeVolume`).
//    Le volume `coquille` était déjà sous une constante depuis #161.

import { octetsEnHex } from "../vm/format-chiffre/octets.mjs";

/** Seize octets posés par une suite arithmétique : un long littéral hexadécimal ressemble à une clé. */
function suite(depart, pas) {
  return octetsEnHex(Uint8Array.from({ length: 16 }, (_, index) => (depart + index * pas) % 256));
}

/**
 * L'identité du COFFRE : celle que l'enveloppe authentifie, et sous laquelle le volume `application`
 * naît. C'est la constante que le Worker de confiance posait sous le nom `IDENTIFIANT_VOLUME` depuis
 * #161 ; elle ne change pas de valeur, elle change de portée.
 */
export const IDENTIFIANT_DU_COFFRE = suite(0x21, 0x07);

/**
 * L'identité du petit volume `coquille`. DISTINCTE de celle du coffre (ADR 0015), et constante pour
 * la même raison que l'autre : elle n'a rien à cacher.
 *
 * Un volume `coquille` qui porte ENCORE `IDENTIFIANT_DU_COFFRE` dans son en-tête a été créé avant
 * l'ADR 0039 : c'est la signature d'un coffre de développement antérieur (`coffreAnterieur`).
 */
export const IDENTIFIANT_DU_VOLUME_COQUILLE = suite(0x5a, 0x0b);

/** Le nom du volume qui porte l'enveloppe et la barrière de la coquille. */
export const VOLUME_DE_LA_COQUILLE = "coquille";

/** La date de la décision : un coffre créé avant elle est refusé, jamais migré. */
export const DATE_DE_L_IDENTITE_UNIQUE = "13/09/2026";
