// Les trois GESTES de portabilité, côté PAGE de confiance (#207, ADR 0039).
//
// Sauvegarder, restaurer, révoquer en urgence : trois boutons, pour la raison qui a fait des autres
// gestes des boutons — ce que la coquille fait du coffre appartient à qui l'ouvre. Ce module ne
// décide d'aucun refus : le Worker de confiance tranche, et la page DIT ce qu'il a tranché. Il ne
// met rien en forme non plus : les écrans et leur ordre sont P2 (#193), la mise en forme P3 (#194).
//
// ## Ce que la page fait de l'archive, et ce qu'elle n'en fait jamais
//
// Elle reçoit un `File` du Worker de confiance et le remet au NAVIGATEUR, par un lien de
// téléchargement : l'archive quitte l'origine par le système de fichiers de l'hôte, jamais par un
// `postMessage`. Elle ne la lit pas, ne la recopie pas, ne la range dans aucun stockage, et le relevé
// public n'en porte que la taille, l'empreinte et la cohérence. Le document applicatif n'en voit
// rien : aucun de ces trois types n'existe sur le port restreint.

import { AVERTISSEMENT_SANS_RECUPERATION } from "./feuille-de-recuperation.mjs";
import { CODES_REFUS_COQUILLE } from "./refus-de-coquille.mjs";
import { moyensProposes } from "./moyens-de-deverrouillage.mjs";
import { ARCHIVE_ERROR_CODES } from "../vm/archive-errors.mjs";
import { IMPORT_ERROR_CODES } from "../vm/import-errors.mjs";

/** Le nom proposé au fichier enregistré. L'extension ne prouve rien : c'est le contenu qui décide. */
export const NOM_DU_FICHIER_DE_SAUVEGARDE = "coffre.rbvault";

/**
 * Ce que la page dit d'un refus de portabilité. Les codes de la famille COQUILLE portent déjà leur
 * conduite dans `refus-de-coquille.mjs` ; ceux de l'ARCHIVE et de la RESTAURATION, qui parlent à un
 * exploitant, reçoivent ici la phrase qu'un utilisateur peut suivre.
 */
export const CONDUITES_DE_PORTABILITE = Object.freeze({
  [ARCHIVE_ERROR_CODES.digestMismatch]:
    "Cette archive a été ALTÉRÉE : son contenu ne correspond plus à l'empreinte qu'elle déclare. Rien n'a été écrit. Utilisez une autre copie de la sauvegarde.",
  [ARCHIVE_ERROR_CODES.truncated]:
    "Cette archive est TRONQUÉE : elle est plus courte que ce qu'elle annonce, souvent un téléchargement interrompu. Rien n'a été écrit. Enregistrez-la de nouveau.",
  [ARCHIVE_ERROR_CODES.malformed]:
    "Ce fichier n'est pas une archive de coffre lisible. Rien n'a été écrit.",
  [ARCHIVE_ERROR_CODES.recuperationAlteree]:
    "L'enveloppe de récupération de cette archive a été altérée. Rien n'a été écrit.",
  [IMPORT_ERROR_CODES.spaceInsufficient]:
    "L'espace de ce navigateur ne suffit pas à restaurer cette archive. Rien n'a été écrit.",
});

/** @param {{ code?: string, message?: string } | null} erreur */
export function conduiteDePortabilite(erreur) {
  const code = erreur?.code ?? CODES_REFUS_COQUILLE.gesteRompu;
  const conduite = CONDUITES_DE_PORTABILITE[code] ?? erreur?.message ?? "Le geste a été refusé.";
  return `${conduite} (${code})`;
}

/**
 * Branche les trois gestes et rend de quoi les déclencher sans passer par le document.
 *
 * @param {{ racine: Document, demander: (type: string, corps?: object) => Promise<any>,
 *           rapport: Record<string, unknown>, publier: () => void,
 *           enregistrer?: (fichier: Blob, nom: string) => void,
 *           apresRestauration?: () => Promise<void> | void,
 *           apresRevocation?: () => Promise<void> | void }} liaison
 */
export function brancherLesGestesDePortabilite(liaison) {
  const noeud = (id) => liaison.racine.querySelector(`#${id}`);
  const contexte = {
    ...liaison,
    noeud,
    dire: (id, texte) => {
      const cible = noeud(id);
      if (cible !== null) cible.textContent = texte;
    },
  };
  liaison.rapport.portabilite = { sauvegarde: null, restauration: null, revocation: null };
  const sauvegarder = () => sauvegarderLeCoffre(contexte);
  const restaurer = (fichier) => restaurerLeCoffre(contexte, fichier);
  const revoquer = () => revoquerEnUrgence(contexte);
  noeud("sauvegarder-le-coffre")?.addEventListener("click", () => void sauvegarder());
  noeud("restaurer-le-coffre")?.addEventListener("click", () => {
    void restaurer(noeud("archive-a-restaurer")?.files?.[0] ?? null);
  });
  noeud("revoquer-en-urgence")?.addEventListener("click", () => void revoquer());
  return Object.freeze({ sauvegarder, restaurer, revoquer });
}

/**
 * SAUVEGARDER. L'absence de moyen de récupération est DITE avant l'archive, jamais refusée : c'est
 * le choix de l'utilisateur, et une archive locale reste une archive.
 */
async function sauvegarderLeCoffre(contexte) {
  const { demander, rapport, publier, dire } = contexte;
  dire("portabilite-refus", "");
  dire("portabilite-avertissement", "");
  try {
    const inventaire = await demander("inventaire", {});
    if (inventaire.present && !moyensProposes(inventaire).aUnMoyenDeRecuperation) {
      dire("portabilite-avertissement", AVERTISSEMENT_SANS_RECUPERATION);
    }
    dire("portabilite-etat", "portabilite:sauvegarde-en-cours");
    const rendu = await demander("sauvegarder", {});
    rapport.portabilite.sauvegarde = {
      taille: rendu.taille,
      empreinte: rendu.empreinte,
      coherence: rendu.coherence,
      recuperationEmportee: rendu.recuperationEmportee,
      versionEnveloppe: rendu.versionEnveloppe,
      applicationArretee: rendu.applicationArretee,
    };
    if (rendu.applicationArretee) rapport.application = null;
    offrirLeFichier(contexte, rendu.archive);
    dire("portabilite-etat", `portabilite:sauvegarde-prete:${rendu.taille}`);
    return rapport.portabilite.sauvegarde;
  } catch (erreur) {
    return refuser(contexte, "sauvegarde", erreur);
  } finally {
    publier();
  }
}

/** Remet l'archive au navigateur : un lien de téléchargement, cliqué une fois, gardé visible. */
function offrirLeFichier(contexte, archive) {
  if (contexte.enregistrer !== undefined) {
    contexte.enregistrer(archive, NOM_DU_FICHIER_DE_SAUVEGARDE);
    return;
  }
  const lien = contexte.noeud("sauvegarde-lien");
  if (lien === null) return;
  if (lien.href.startsWith("blob:")) URL.revokeObjectURL(lien.href);
  lien.href = URL.createObjectURL(archive);
  lien.download = NOM_DU_FICHIER_DE_SAUVEGARDE;
  lien.hidden = false;
  lien.click();
}

/** RESTAURER le fichier choisi par l'utilisateur, dans un emplacement vide. */
async function restaurerLeCoffre(contexte, fichier) {
  const { demander, rapport, publier, dire } = contexte;
  dire("portabilite-refus", "");
  if (fichier === null) {
    dire("portabilite-refus", "Choisissez d'abord le fichier de sauvegarde à restaurer.");
    return null;
  }
  dire("portabilite-etat", "portabilite:restauration-en-cours");
  try {
    const rendu = await demander("restaurer", { archive: fichier });
    rapport.portabilite.restauration = {
      taille: rendu.taille,
      empreinte: rendu.empreinte,
      empreinteRelue: rendu.empreinteRelue,
      coherence: rendu.coherence,
      versionEnveloppe: rendu.versionEnveloppe,
      reparee: rendu.reparee,
      volumeCoquille: rendu.volumeCoquille,
      barrieres: rendu.barrieres,
    };
    rapport.etat = rendu.etat;
    dire("portabilite-etat", `portabilite:restauree:version-${rendu.versionEnveloppe ?? "aucune"}`);
    await contexte.apresRestauration?.();
    return rapport.portabilite.restauration;
  } catch (erreur) {
    return refuser(contexte, "restauration", erreur);
  } finally {
    publier();
  }
}

/** RÉVOQUER EN URGENCE : tout ce qui ouvre ce coffre, sauf ce qui vient de l'ouvrir. */
async function revoquerEnUrgence(contexte) {
  const { demander, rapport, publier, dire } = contexte;
  dire("portabilite-refus", "");
  try {
    const rendu = await demander("revoquerEnUrgence", {});
    rapport.portabilite.revocation = {
      versionEnveloppe: rendu.versionEnveloppe,
      restants: rendu.restants,
      retires: rendu.retires,
      nombreRetires: rendu.nombreRetires,
      nombreRestants: rendu.nombreRestants,
    };
    dire(
      "portabilite-etat",
      `portabilite:revoque:${rendu.nombreRetires}-retires:${rendu.nombreRestants}-restant`,
    );
    await contexte.apresRevocation?.();
    return rapport.portabilite.revocation;
  } catch (erreur) {
    return refuser(contexte, "revocation", erreur);
  } finally {
    publier();
  }
}

/** Un refus est PUBLIÉ par son code, et DIT par sa conduite. Jamais avalé. */
function refuser({ rapport, dire }, geste, erreur) {
  const code = erreur?.code ?? CODES_REFUS_COQUILLE.gesteRompu;
  rapport.portabilite[geste] = { refus: code };
  dire("portabilite-refus", conduiteDePortabilite(erreur));
  dire("portabilite-etat", `portabilite:${geste}-refusee:${code}`);
  return rapport.portabilite[geste];
}
