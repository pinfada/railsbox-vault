// La FEUILLE DE RÉCUPÉRATION, et l'ANCRE de version qu'elle porte (#162, ADR 0029).
//
// L'[ADR 0027](../../docs/decisions/0027-archive-et-ancre-de-version.md) décision 3 a tranché avant
// que quiconque ait à l'implémenter : « la feuille de récupération porte, à côté du code, la VERSION
// D'ENVELOPPE, à re-noter à chaque RÉVOCATION » et « l'ancre est une SAISIE de l'utilisateur dans la
// coquille, jamais une valeur lue d'un stockage de l'appareil ». Ce module porte les deux moitiés :
// ce qui s'écrit sur la feuille, et ce que la coquille dit autour.
//
// ## Pourquoi les PHRASES sont ici, et pas dans la page
//
// Ce sont des décisions, pas de la présentation. « Sans version notée, le plancher de rejeu n'est
// pas opposé » est l'AVEU de la décision 3, et il doit être éprouvable sans démarrer un navigateur.
// Une phrase écrite dans `public/main.mjs` ne serait relue par personne, et l'aveu — qui ne coûte
// rien à supprimer et que rien ne réclame — serait le premier à disparaître d'une refonte
// d'interface.
//
// ## Ce que la coquille ne promet pas
//
// **Elle n'imprime pas.** Le bouton d'impression d'un navigateur écrit vers un pilote, une file
// d'attente, parfois un PDF déposé sur le disque — un chemin que le produit ne maîtrise ni ne voit.
// La feuille est un geste de l'utilisateur : la coquille affiche, il recopie. `SECURITY.md` le dit
// dans ces termes, et rien ici ne suggère le contraire.
//
// **Elle n'écrit le code nulle part.** Pas de presse-papiers automatique — un presse-papiers est
// lisible par tout ce qui tourne sur la machine, et le remplir sans qu'on le demande déplace le
// secret hors du seul endroit où il devait vivre. Pas de stockage, pas de journal, pas de second
// rendu : `VAULT_DERIVATION_CODE_DEJA_RENDU` tombe au second appel (ADR 0025, décision 3).

import { GROUPES, SEPARATEUR, decouper } from "./saisie-du-code.mjs";
import { SYMBOLES_PAR_GROUPE, balayerSaisie } from "../vm/derivation/code-de-recuperation.mjs";

/**
 * La FEUILLE : le code, sa découpe, et la version d'enveloppe du jour où il a été créé.
 *
 * Les deux vont ensemble et c'est tout l'objet de ce module. Un code sans version laisse l'ancre
 * vide et le plancher de rejeu inopposable ; une version sans code ne secourt rien. Les afficher
 * séparément aurait fait noter l'un et oublier l'autre.
 *
 * @param {{ code: string, version: number }} appel
 * @returns {{ code: string, decoupe: string, version: number, groupes: string[], consigne: string }}
 */
export function feuilleDeRecuperation({ code, version }) {
  if (typeof code !== "string" || code.length === 0) {
    throw new Error("Une feuille de récupération porte un code non vide.");
  }
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("Une feuille de récupération porte une version d'enveloppe entière et ≥ 1.");
  }
  const decoupe = decouper(balayerSaisie(code).symboles);
  return Object.freeze({
    code,
    decoupe,
    version,
    groupes: Object.freeze(decoupe.split(SEPARATEUR)),
    consigne:
      `Recopiez ces ${GROUPES} groupes de ${SYMBOLES_PAR_GROUPE} symboles sur un papier, et ` +
      `NOTEZ À CÔTÉ la version d'enveloppe : ${version}. Ce code ne vous sera pas rendu une ` +
      `seconde fois, et rien dans cet appareil n'en garde de copie — le perdre, c'est perdre ce ` +
      `moyen de récupération. Gardez le papier ailleurs que sur cet appareil.`,
  });
}

/**
 * Ce que la coquille affiche APRÈS une opération qui change la version d'enveloppe.
 *
 * « À chaque RÉVOCATION — pas à chaque ouverture, ni à chaque ajout », dit la décision 3. Le
 * distinguo est celui du bruit : une consigne affichée à chaque ouverture cesse d'être lue avant
 * la troisième, et le jour où elle compte vraiment elle est invisible. La création du moyen de
 * récupération y entre parce qu'elle FONDE la feuille — c'est le moment où l'on écrit les deux.
 *
 * @param {{ version: number, geste: string }} appel
 */
export function versionANoter({ version, geste }) {
  if (!Number.isInteger(version) || version < 1) {
    throw new Error("La version à noter est un entier ≥ 1.");
  }
  return (
    `${geste} : la version d'enveloppe est désormais ${version}. Corrigez-la sur votre feuille de ` +
    `récupération, à côté du code. C'est cette version — et elle seule — qui empêchera qu'une page ` +
    `d'enveloppe ANTÉRIEURE, réinstallée par quelqu'un d'autre, ressuscite une clé que vous venez ` +
    `de révoquer.`
  );
}

/**
 * L'AVEU, quand aucune version n'est saisie. Il est AFFICHÉ, jamais tu.
 *
 * « Un utilisateur qui ne note rien n'est pas puni : sans feuille, rien n'est exigé — **et rien
 * n'est promis** » (ADR 0027, décision 3). La seconde moitié est celle qui disparaît des interfaces,
 * parce qu'elle n'apporte rien à qui veut juste ouvrir son coffre. Elle est donc écrite ici, et
 * l'épreuve la cherche à l'écran.
 */
export const AVEU_SANS_ANCRE =
  "Aucune version notée : le plancher de rejeu n'est PAS opposé. Si quelqu'un a remis en place une " +
  "page d'enveloppe plus ancienne sur cet appareil, une clé que vous aviez révoquée peut encore " +
  "ouvrir ce coffre, et rien ici ne le verra. C'est le prix d'une ancre que vous seul tenez.";

/** Ce que la coquille dit quand une version EST saisie : ce qu'elle promet, et son étendue. */
export function ancreOpposee(version) {
  return (
    `Version ${version} exigée : une page d'enveloppe antérieure sera refusée par ` +
    `VAULT_ENVELOPPE_REJEU. Cela ferme le retour arrière du SEUL fichier d'enveloppes ; un retour ` +
    `arrière complet du support — volume et voisins remis ensemble — reste indétectable.`
  );
}

/**
 * Le REPLI que `VAULT_ENVELOPPE_REJEU` doit nommer, écrit une fois.
 *
 * « Une version recopiée TROP HAUT refuse une enveloppe saine, et le refus doit dire quoi faire »
 * (ADR 0027, limite 4). Le second repli est un geste EXPLICITE et DISTINCT — vider le champ de
 * version puis rouvrir —, jamais une case à décocher ni un repli automatique après échec : un
 * contournement qui s'obtient par insistance n'est plus un aveu, c'est une formalité.
 */
export const REPLI_DU_REJEU =
  "Cette enveloppe est ANTÉRIEURE à la version que vous avez notée. Deux causes, deux remèdes : " +
  "relisez la version sur votre feuille — un chiffre recopié trop haut refuse une enveloppe saine ; " +
  "à défaut, videz le champ de version et rouvrez SANS plancher, en sachant que vous renoncez " +
  "alors à la protection contre le rejeu pour cette ouverture.";

/**
 * Le CONSENTEMENT NOMMÉ d'une restauration antérieure à la feuille (ADR 0027, décision 3).
 *
 * Le texte dit ce que l'utilisateur ACCEPTE, et non ce que le produit exige : c'est la différence
 * entre un consentement et une case obligatoire. La citation de l'ADR est reprise mot pour mot,
 * parce qu'elle a été pesée là-bas.
 */
export const TEXTE_DU_CONSENTEMENT =
  "Cette sauvegarde date d'avant votre dernière révocation : une clé révoquée depuis pourrait y " +
  "être encore valable. En restaurant, vous l'acceptez. Votre nom sera inscrit dans le compte rendu " +
  "de la restauration, et la version restaurée deviendra la nouvelle référence à noter sur votre " +
  "feuille.";

/**
 * L'AVERTISSEMENT de `recovery: null`, qui doit PRÉCÉDER le geste d'export (ADR 0027, limite 6).
 *
 * « Le compte rendu de l'export ET celui de la vérification le portent ; c'est à l'interface de #24
 * de le DIRE, et rien ici ne l'y oblige. » Cette tranche n'offre pas l'export — c'est le cycle de
 * vie assemblé de #163 —, mais le message existe, il est éprouvé, et la coquille le montre déjà où
 * elle le peut : dès qu'un volume ouvert n'a AUCUN emplacement de récupération. Un avertissement qui
 * n'apparaîtrait qu'au moment de l'export arriverait après que l'archive a été prise.
 */
export const AVERTISSEMENT_SANS_RECUPERATION =
  "Ce coffre n'a AUCUN moyen de récupération. Une archive prise maintenant ne s'ouvrira nulle part " +
  "ailleurs : elle ne porte que les clés de cet appareil. Si vous perdez votre phrase ou votre " +
  "passkey, rien — ni ici, ni dans la sauvegarde — ne rouvrira ce coffre.";

/**
 * Ce que la coquille dit d'un emplacement dont elle ne sait rien faire.
 *
 * Le catalogue de dérivateurs rend `VAULT_DERIVATION_TYPE_INCONNU` (ADR 0021, point 5 du contrat de
 * #22) ; ce message est ce que l'utilisateur en lit. Il ne DEVINE pas : un emplacement d'un type
 * inconnu vient forcément d'une version postérieure du produit, et la seule conduite honnête est de
 * le dire.
 */
export const TEXTE_TROP_ANCIEN =
  "Ce Vault a été fermé par une version du produit plus récente que celle-ci : l'un de ses moyens " +
  "de déverrouillage porte un type que cette coquille ne sait pas servir. Mettez le produit à jour. " +
  "Rien n'a été tenté, et rien n'a été modifié.";
