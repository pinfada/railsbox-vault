// CRÉER un moyen de récupération : tirer le code, poser son emplacement, le rendre UNE fois
// (#147, ADR 0025, décision 3).
//
// C'est une couche AU-DESSUS des opérations de l'ADR 0020, et pas une modification d'entre elles :
// ce module ne connaît ni la page, ni la racine, ni le scellement. Il assemble trois gestes qui
// existent déjà — tirer un code (ADR 0025), préparer un emplacement dérivé (ADR 0021), ajouter cet
// emplacement à l'enveloppe (ADR 0020) — et il ajoute la seule chose qui lui appartienne : le
// RENDU UNIQUE.
//
// ## L'ORDRE, qui est le sujet de ce module
//
// L'enveloppe est écrite et sa BARRIÈRE franchie AVANT que le code ne soit rendu. Les deux
// coupures possibles ne sont pas symétriques, et c'est ce qui décide :
//
//  - **coupure entre l'écriture et le rendu** — l'enveloppe porte un emplacement dont personne ne
//    tient le code. C'est inoffensif : il n'ouvre rien pour personne, il occupe une place sur huit,
//    et il se révoque comme n'importe quel autre ;
//  - **coupure entre le rendu et l'écriture**, si l'ordre était inversé — l'utilisateur tiendrait
//    un code qui n'ouvre rien, et le croirait valable. C'est le sinistre, parce qu'il ne se voit
//    qu'au moment où le code devait servir, c'est-à-dire quand plus rien d'autre n'ouvre.
//
// L'ordre est donc celui de `preparerEnveloppeDeVolume` (ADR 0020) transposé : ce qui est DURABLE
// vient avant ce qui est ANNONCÉ.
//
// ## Pourquoi `ajouterEmplacement`, et pas la création d'une enveloppe
//
// Un moyen de récupération est par définition un SECOND moyen : il existe pour le jour où le
// premier a disparu. Une enveloppe créée directement sur un code de récupération n'aurait pas de
// premier moyen à secourir — ce serait un volume ouvert par un code, ce qui est un autre produit et
// une autre décision. Les pièces sont là si un tel usage se justifie un jour
// (`preparerEmplacementDerive` puis `creerEnveloppe`) ; ce module n'en fait pas la promesse.
//
// ## Ce qui est effacé, et ce qui ne peut pas l'être
//
// Les seize octets tirés sont mis à ZÉRO dès que la KEK existe, et le tampon décodé par le
// dérivateur l'est aussi de son côté. La CHAÎNE, elle, ne s'efface pas : c'est une `string`
// JavaScript — immuable, copiée par le moteur, ramassée quand il le décide. C'est **impossible**,
// exactement comme l'ADR 0021 le dit de la phrase, et le prétendre serait une promesse fausse.
//
// L'IMPRESSION sort de l'appareil par un chemin que le produit ne maîtrise pas — le spouleur, un
// fichier PDF intermédiaire, le disque d'une imprimante réseau. `SECURITY.md` l'écrit ; rien ici ne
// le promet.

import { encoderCode, tirerCodeDeRecuperation } from "./derivation/code-de-recuperation.mjs";
import { effacer } from "./derivation/derivateur.mjs";
import {
  derivateurRecuperation,
  parametresDeRecuperation,
  tirerSelDeRecuperation,
} from "./derivation/derivateur-recuperation.mjs";
import { codeDejaRendu } from "./derivation/derivation-errors.mjs";
import { preparerEmplacementDerive } from "./derivation/emplacement-derive.mjs";
import { ajouterEmplacement } from "./enveloppe-de-cle.mjs";
import { TYPES_KEK } from "./enveloppe/identite-enveloppe.mjs";

/**
 * Le porteur du code : il le livre UNE fois, puis ne le livre plus.
 *
 * Le second appel rend un refus TYPÉ, jamais la chaîne et jamais `undefined` — un rendu vide
 * laisserait croire que le code est vide. La chaîne n'est pas un champ de l'objet : elle vit dans
 * la fermeture, elle n'apparaît donc ni dans une sérialisation, ni dans un journal qui afficherait
 * l'objet, et elle est relâchée dès le premier rendu.
 */
function porteurDuCode(identite, chaine) {
  let restant = chaine;
  return Object.freeze({
    ...identite,
    rendre() {
      if (restant === null) throw codeDejaRendu({ ...identite });
      const valeur = restant;
      restant = null;
      return valeur;
    },
  });
}

/**
 * CRÉE un moyen de récupération sur une enveloppe existante.
 *
 * Il faut détenir une KEK VALABLE pour ajouter — l'enveloppe n'est pas un trousseau ouvert en
 * écriture (ADR 0020) —, et c'est ce qui rend ce geste possible seulement à qui peut déjà ouvrir.
 *
 * @param {{ support: object, identifiantVolume: string, kek: Uint8Array | CryptoKey,
 *           derivateur?: object, tirerCode?: Function, tirerSel?: Function, aleas?: object }} appel
 * @returns {Promise<{ identifiantEmplacement: string, typeKek: number, version: number,
 *                     rendre: () => string }>}
 */
export async function creerMoyenDeRecuperation({
  support,
  identifiantVolume,
  kek,
  derivateur = derivateurRecuperation(),
  tirerCode = tirerCodeDeRecuperation,
  tirerSel = tirerSelDeRecuperation,
  aleas,
}) {
  const octets = tirerCode();
  // La chaîne est écrite AVANT que les octets ne soient effacés : c'est le seul endroit du produit
  // où le code existe sous sa forme lisible, et il n'y en aura pas d'autre.
  const chaine = encoderCode(octets);
  const parametres = parametresDeRecuperation({ sel: tirerSel() });
  let prepare;
  try {
    prepare = await preparerEmplacementDerive({
      identifiantVolume,
      derivateur,
      parametres,
      geste: { code: chaine },
    });
  } finally {
    effacer(octets);
  }

  const pose = await ajouterEmplacement({
    support,
    identifiantVolume,
    kek,
    kekNouvelle: prepare.kek,
    typeKek: TYPES_KEK.recuperation,
    parametres,
    identifiantEmplacement: prepare.identifiantEmplacement,
    ...(aleas === undefined ? {} : { aleas }),
  });

  // `pose` n'existe qu'une fois la barrière franchie : le porteur du code ne peut donc pas exister
  // avant elle. C'est l'ordre, et il est tenu par la structure plutôt que par une consigne.
  return porteurDuCode(
    {
      identifiantEmplacement: prepare.identifiantEmplacement,
      typeKek: TYPES_KEK.recuperation,
      version: pose.version,
    },
    chaine,
  );
}
