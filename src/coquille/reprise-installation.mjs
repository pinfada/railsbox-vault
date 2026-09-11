// REPREND une installation interrompue (#173) : retire le volume orphelin et ses voisins, puis
// réinstalle par le chemin ORDINAIRE de #163.
//
// Un SEUL cas déclenche ce geste : la SIGNATURE d'une installation interrompue
// (`application-de-reference.mjs`, `signatureDInstallationInterrompue`) — jamais un simple refus
// « sans manifeste », qui couvre aussi « autre chose ». La coquille ne le lance JAMAIS d'elle-même :
// c'est un bouton, un geste explicite de l'utilisateur (ADR 0037), sur le modèle du bouton
// « Rouvrir le coffre » de #171 — jamais automatique, pour la même raison : redemander le geste à
// la place de l'utilisateur est l'option que l'ADR 0030 range dans les alternatives rejetées.
//
// DEUX fonctions, à deux niveaux de confiance : `reprendreLInstallation` EXÉCUTE, sans rien vérifier
// — elle sert de brique à qui a déjà vérifié ; `reprendreSiSignatureConfirmee` est le SEUL point
// d'entrée que le Worker de confiance atteint depuis le canal privilégié (#173, ADR 0037), et elle
// revérifie la signature elle-même, sous sa propre exclusivité, juste avant d'agir : un clic n'est
// pas une preuve que rien n'a changé depuis que le bouton a été montré.

import {
  NOM_DU_VOLUME_APPLICATIF,
  installerSiNecessaire,
  manifesteEstLisible,
  signatureDInstallationInterrompue,
} from "./application-de-reference.mjs";
import {
  manifestSidecarName,
  openOpfsSyncAccess,
  removeOpfsVolume,
  statOpfsVolume,
} from "../vm/opfs-sync-access.mjs";
import { readVolumeManifest } from "../vm/opfs-volume-open.mjs";

/**
 * REPREND une installation interrompue : retire le volume orphelin ET SES VOISINS
 * (`removeOpfsVolume`, ADR 0020 déc. 1), puis réinstalle par le chemin ordinaire.
 *
 * ## Ce que ce geste DÉTRUIT, et pourquoi il ne peut pas détruire autre chose
 *
 * Il détruit le volume applicatif ANONYME et SES SEULS voisins — journal de génération, témoin de
 * séquence, enveloppe de clé, instantané ; la liste vit dans `voisinsDunVolume`
 * (`opfs-sync-access.mjs`), en un seul endroit, et ce module ne la recopie pas. Il ne touche :
 *
 *  - **ni le coffre** — le volume `coquille` (#161) est un nom distinct, jamais nommé ici ;
 *  - **ni son enveloppe** — `coquille.cles` n'est le voisin d'aucun nom que ce module retire ;
 *  - **ni un AUTRE volume** — `removeOpfsVolume` retire par NOM, et `NOM_DU_VOLUME_APPLICATIF` en
 *    est un seul, fixe.
 *
 * ## Ce qu'il ne fait JAMAIS
 *
 * Il ne MESURE pas lui-même la signature. Il EXÉCUTE une décision déjà prise, par
 * `signatureDInstallationInterrompue` d'abord, par le clic de l'utilisateur ensuite : l'appelant est
 * celui qui doit avoir vérifié les deux AVANT d'invoquer ce geste. Un appel sur un volume qui n'a
 * pas cette signature retire quand même — c'est un geste de RETRAIT, pas un second contrôle — et
 * c'est pourquoi rien de ce module n'est atteignable sans le clic que #173 exige.
 *
 * @param {{ descripteur: object, cleDeVolume: () => Promise<Uint8Array>, retirer?: Function,
 *           observer?: Function, ouvrir?: Function, dater?: Function, verser?: Function,
 *           revoquer?: Function, inscrire?: Function, openHandle?: Function }} options
 * @returns {Promise<object>} le compte rendu de `installerSiNecessaire`, sur le volume neuf
 */
export async function reprendreLInstallation({
  descripteur,
  cleDeVolume,
  retirer = removeOpfsVolume,
  ...primitives
}) {
  await retirer(NOM_DU_VOLUME_APPLICATIF);
  return installerSiNecessaire({ descripteur, cleDeVolume, ...primitives });
}

/**
 * REVÉRIFIE la signature d'une installation interrompue, puis REPREND si — et seulement si — elle
 * tient encore. Point d'entrée UNIQUE du geste depuis le canal privilégié (#173).
 *
 * Deux refus SANS retrait, dans l'ordre :
 *
 *  1. un manifeste est présent ET LISIBLE → l'application est déjà installée, rien à reprendre.
 *     Un manifeste présent mais ILLISIBLE — la coupure la plus tardive qu'une installation puisse
 *     subir, au milieu de ce dernier geste — n'est PAS pris pour une installation achevée (#188,
 *     revue de sécurité, MEDIUM-2) : il tombe au contrôle suivant, comme « autre chose » ;
 *  2. la signature ne tient pas (`signatureDInstallationInterrompue`) → « autre chose », et ce
 *     module ne le devine pas : refuser est le seul geste sûr.
 *
 * Aucun des deux ne touche un octet. `reprendreLInstallation` n'est appelée qu'au troisième cas, le
 * seul où la signature est confirmée.
 *
 * @param {{ descripteur: object, cleDeVolume: () => Promise<Uint8Array>, observer?: Function,
 *           openHandle?: Function, retirer?: Function, ouvrir?: Function, dater?: Function,
 *           verser?: Function, revoquer?: Function, inscrire?: Function,
 *           lireLeManifeste?: Function }} options
 * @returns {Promise<{ reprise: boolean, motif?: string, installation?: object }>}
 */
export async function reprendreSiSignatureConfirmee({
  descripteur,
  cleDeVolume,
  observer = statOpfsVolume,
  openHandle = openOpfsSyncAccess,
  lireLeManifeste = readVolumeManifest,
  ...primitives
}) {
  const nom = NOM_DU_VOLUME_APPLICATIF;
  const manifesteExistant = await observer(manifestSidecarName(nom));
  if (manifesteExistant.present && (await manifesteEstLisible(nom, lireLeManifeste))) {
    return { reprise: false, motif: "l'application est déjà installée : rien à reprendre" };
  }
  const signature = await signatureDInstallationInterrompue({
    nom,
    octetsAnnonces: descripteur.disque.octets,
    observer,
    openHandle,
  });
  if (!signature.interrompue) {
    return {
      reprise: false,
      motif: `ce n'est pas la signature d'une installation interrompue : ${signature.motif}`,
    };
  }
  const installation = await reprendreLInstallation({
    descripteur,
    cleDeVolume,
    observer,
    openHandle,
    lireLeManifeste,
    ...primitives,
  });
  return { reprise: true, installation };
}
