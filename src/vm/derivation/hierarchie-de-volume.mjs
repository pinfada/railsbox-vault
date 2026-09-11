// La HIÉRARCHIE DE CLÉS D'UN VOLUME v4 (#182, ADR 0033, décisions 1, 2 et 6).
//
// Une DEK, un identifiant de volume, une version de format : de là descendent les clés sous
// lesquelles ce volume-là scelle. Ce module ne connaît ni support, ni format sur disque, ni
// compteur — il ne fait que DÉRIVER, et c'est ce qui permet de le confronter au modèle écrit à la
// main de `tests/unit/modele-derivation.mjs` sans monter un volume.
//
// ## Ce que la hiérarchie rend, et pourquoi deux clés et non une
//
//     DEK ──HKDF──┬─→ cleVolume   (domaine « volume »)   secteurs, empreinte de région, témoin, RACINES
//                 ├─→ cleJournal  (domaine « journal »)  enregistrements de <volume>.gen
//                 └─→ cleInstantane (domaine « instantane », sel TIRÉ, une par capture)
//
// Le journal a sa propre clé, et c'est une DÉCISION, pas une symétrie (ADR 0033, décision 2) : il
// est le seul magasin dont les objets sont scellés au DÉPÔT, c'est-à-dire sous une génération EN
// VOL — celle-là même dont l'ADR 0015 a montré qu'elle peut reculer. Deux compteurs disent alors ce
// qu'un compteur unique moyennait : une barrière du guest écrit un enregistrement, une racine, une
// empreinte de région et un témoin, dont trois relèvent du volume et un seul du journal.
//
// **Les RACINES sont du domaine `volume`**, bien qu'elles authentifient la suite des entrées du
// journal. Une racine vit dans le fichier de volume, à l'emplacement `séquence mod 2`, et c'est elle
// qui porte les compteurs des DEUX domaines : la faire dépendre de la clé du journal ferait dépendre
// le compteur du volume d'une clé que le journal peut vider.
//
// ## La clé maîtresse est importée UNE fois, et ses octets ne sont pas conservés
//
// `hierarchieDeVolume` importe la DEK en matériau HKDF (décision 6) et rend ce matériau avec les
// deux clés. L'appelant le garde pour dériver l'instantané à la capture ; il ne garde jamais les
// octets. C'est la différence entre « on s'interdit de chiffrer sous la DEK » et « on ne peut pas ».

import {
  DOMAINES,
  VERSIONS_DE_FORMAT_DE_DOMAINE,
  deriverCleDeDomaine,
  encoderInfoDeDomaine,
  importerMateriauMaitre,
  selDuDomaine,
} from "./cle-de-domaine.mjs";

/**
 * Dérive la clé d'un domaine de CE volume. Le sel est celui que le régime du domaine impose.
 *
 * @param {{ materiau: CryptoKey, domaine: string, identifiantVolume: string,
 *           versionDeFormat: number, sel?: Uint8Array }} appel
 *   `sel` n'est fourni que par un domaine à usage unique qui RELIT un artefact : le sel y est écrit
 *   en clair, et c'est lui qu'il faut présenter. À l'écriture, il est tiré ici.
 */
export async function cleDeDomaineDuVolume({
  materiau,
  domaine,
  identifiantVolume,
  versionDeFormat,
  sel = selDuDomaine(domaine),
}) {
  return deriverCleDeDomaine({
    cleMaitresse: materiau,
    domaine,
    sel,
    info: encoderInfoDeDomaine({ domaine, identifiantVolume, versionDeFormat }),
  });
}

/**
 * Les clés à COMPTEUR d'un volume v4, plus le matériau maître qui les a produites.
 *
 * @param {{ cleMaitresse: Uint8Array | CryptoKey, identifiantVolume: string,
 *           formatVersion: number }} appel
 *   `formatVersion` est la version du format de VOLUME, qui est aussi celle des domaines `volume` et
 *   `journal` (ADR 0033, décision 3) : ces deux domaines scellent le volume, et rien d'autre.
 * @returns {Promise<{ materiau: CryptoKey, cleVolume: CryptoKey, cleJournal: CryptoKey }>}
 */
export async function hierarchieDeVolume({ cleMaitresse, identifiantVolume, formatVersion }) {
  const materiau =
    cleMaitresse instanceof Uint8Array ? await importerMateriauMaitre(cleMaitresse) : cleMaitresse;
  const [cleVolume, cleJournal] = await Promise.all([
    cleDeDomaineDuVolume({
      materiau,
      domaine: DOMAINES.volume,
      identifiantVolume,
      versionDeFormat: formatVersion,
    }),
    cleDeDomaineDuVolume({
      materiau,
      domaine: DOMAINES.journal,
      identifiantVolume,
      versionDeFormat: formatVersion,
    }),
  ]);
  return Object.freeze({ materiau, cleVolume, cleJournal });
}

/**
 * La clé d'UNE capture d'instantané : sel TIRÉ, usage unique, aucun compteur (ADR 0024, décision 3).
 *
 * Le sel est rendu avec la clé parce qu'il doit être ÉCRIT EN CLAIR dans le fichier d'instantané :
 * sans lui, la capture ne se rouvre pas. À la relecture, il est présenté par l'appelant.
 *
 * **Le budget d'une clé à usage unique est de 1, et aucune mesure ne peut le rendre faux.** C'est la
 * leçon de l'ADR 0015 sur le nonce, appliquée à la clé : dans un système exposé au retour arrière,
 * tout ce qui se compte finit par reculer, et l'aléa est la seule construction dont l'unicité ne
 * dépend d'aucun état.
 *
 * @param {{ materiau: CryptoKey, identifiantVolume: string, sel?: Uint8Array }} appel
 * @returns {Promise<{ sel: Uint8Array, cle: CryptoKey }>}
 */
export async function cleDInstantane({
  materiau,
  identifiantVolume,
  sel = selDuDomaine(DOMAINES.instantane),
}) {
  const cle = await cleDeDomaineDuVolume({
    materiau,
    domaine: DOMAINES.instantane,
    identifiantVolume,
    versionDeFormat: VERSIONS_DE_FORMAT_DE_DOMAINE[DOMAINES.instantane],
    sel,
  });
  return Object.freeze({ sel, cle });
}
