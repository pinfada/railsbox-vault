// Le TÉLÉCHARGEMENT ANTICIPÉ des artefacts du premier démarrage (#348).
//
// Le premier démarrage téléchargeait, vérifiait et décompressait ses artefacts — wasm, BIOS, VGA BIOS,
// noyau, initrd, rootfs, paquet : 207 Mio servis — au clic sur « Démarrer », à l'étape 4. Ce module fait
// ce travail PLUS TÔT, pendant que la personne choisit sa phrase et recopie son code, et le range au
// magasin d'artefacts (#247, ADR 0044). L'étape 4 n'y gagne rien d'autre qu'un magasin rempli : elle
// relit, revérifie et sert, par le chemin qui existait déjà.
//
// ## Ce qu'il ne fait PAS
//
//  - Il ne crée ni n'ouvre aucun coffre, ne lit ni n'écrit aucun volume, et ne touche aucune clé : ses
//    seules écritures sont celles du magasin, sous `vault-artefacts/`.
//  - Il ne juge rien que l'étape 4 croirait sur parole : un artefact n'est rangé qu'après la même
//    vérification qu'au boot (épingle, taille, empreinte), et le boot le revérifie en le servant.
//  - Il ne télécharge pas « pour rien » : sans magasin, sans place pour tout ranger, ou si tout y est
//    déjà, il ne demande aucun octet au réseau. L'étape 4 fait alors ce qu'elle faisait avant.
//  - Il ne prend pas la place d'une autre acquisition : sous le verrou des artefacts, PRIS seulement
//    s'il est libre (`verrou-des-artefacts.mjs`).
//
// ## Reprise
//
// Il travaille artefact par artefact, et chacun n'est rangé qu'ENTIER (le `.partiel` est renommé en
// dernier, ADR 0044). Interrompu — onglet fermé, rechargement de l'étape 3 —, il laisse au magasin ce
// qu'il a fini ; la fois suivante, `contient` le voit et il passe à l'artefact suivant. L'artefact en
// cours recommence depuis le début : il n'y a pas de reprise à l'octet.

import {
  PETITS_ARTEFACTS,
  acquerirUnPetit,
  epinglesDuRuntime,
} from "./acquisition-des-artefacts.mjs";
import { servirOuTelecharger } from "./acquisition-du-disque-systeme.mjs";
import { siLeVerrouEstLibre } from "./verrou-des-artefacts.mjs";

/** Ce que le téléchargement anticipé a fait, en un mot. */
export const ISSUES_DU_PRECHARGEMENT = Object.freeze({
  fait: "fait",
  dejaPresent: "deja-present",
  sansMagasin: "sans-magasin",
  stockageIndisponible: "stockage-indisponible",
  placeInsuffisante: "place-insuffisante",
  occupe: "occupe",
});

/** Les sept artefacts, dans l'ordre où le boot les lit, avec ce que leur acquisition demande. */
function artefactsAPrecharger(runtime, pins) {
  const petits = PETITS_ARTEFACTS.filter(
    (nom) => pins[nom] !== null && pins[nom] !== undefined,
  ).map((nom) => ({ nom, sha256: pins[nom].sha256, octets: pins[nom].octets, url: runtime[nom] }));
  const disque = ["rootfs", "paquet"].map((nom) => ({ nom, ...runtime.disqueSysteme[nom] }));
  return [...petits, ...disque];
}

/** Un artefact acquis, et ce que le magasin en a fait ; son échec n'arrête pas les suivants. */
async function precharger(artefact, { pins, magasin, recuperer }) {
  try {
    if (PETITS_ARTEFACTS.includes(artefact.nom)) {
      const acquis = await acquerirUnPetit({
        nom: artefact.nom,
        url: artefact.url,
        pin: pins[artefact.nom],
        magasin,
        recuperer,
      });
      return acquis.magasin;
    }
    const tampon = new Uint8Array(artefact.octets);
    const acquis = await servirOuTelecharger({
      tampon,
      debut: 0,
      morceau: artefact,
      nom: artefact.nom,
      recuperer,
      magasin,
    });
    return acquis.magasin;
  } catch {
    // Refusé, coupé, altéré : rien n'est rangé, et l'étape 4 le redemandera — et dira, elle, pourquoi.
    return "echec";
  }
}

async function manquants(artefacts, magasin) {
  const absents = [];
  for (const artefact of artefacts) {
    if (!(await magasin.contient(artefact))) absents.push(artefact);
  }
  return absents;
}

/**
 * PRÉCHARGE au magasin les artefacts que le descripteur nomme, sous le verrou s'il est libre.
 *
 * @param {{ runtime: Record<string, any>, manifeste: { artifacts: object[] },
 *           magasin: object | null, peutAdmettre: (octets: number) => Promise<boolean>,
 *           recuperer?: typeof fetch, verrous?: LockManager | null }} entrees
 * @returns {Promise<{ issue: string, artefacts?: Record<string, string> }>}
 */
export async function prechargerLesArtefacts({
  runtime,
  manifeste,
  magasin,
  peutAdmettre,
  recuperer = globalThis.fetch,
  verrous = globalThis.navigator?.locks ?? null,
}) {
  if (magasin === null) return { issue: ISSUES_DU_PRECHARGEMENT.sansMagasin };
  const bilan = await siLeVerrouEstLibre(
    () => prechargerSousLeVerrou({ runtime, manifeste, magasin, peutAdmettre, recuperer }),
    { verrous },
  );
  return bilan ?? { issue: ISSUES_DU_PRECHARGEMENT.occupe };
}

async function prechargerSousLeVerrou({ runtime, manifeste, magasin, peutAdmettre, recuperer }) {
  const pins = epinglesDuRuntime(runtime, manifeste);
  let absents;
  try {
    absents = await manquants(artefactsAPrecharger(runtime, pins), magasin);
  } catch {
    // Le stockage ne répond pas (refusé, éphémère, en panne) : rien ne serait rangé, rien n'est demandé.
    return { issue: ISSUES_DU_PRECHARGEMENT.stockageIndisponible };
  }
  if (absents.length === 0) return { issue: ISSUES_DU_PRECHARGEMENT.dejaPresent };
  // La place pour TOUT ranger, demandée avant le premier octet : télécharger ce que le budget refuserait
  // de garder serait payer deux fois — maintenant, puis à l'étape 4.
  const total = absents.reduce((somme, artefact) => somme + artefact.octets, 0);
  if (!(await peutAdmettre(total).catch(() => false))) {
    return { issue: ISSUES_DU_PRECHARGEMENT.placeInsuffisante };
  }
  const artefacts = {};
  for (const artefact of absents) {
    artefacts[artefact.nom] = await precharger(artefact, { pins, magasin, recuperer });
  }
  return { issue: ISSUES_DU_PRECHARGEMENT.fait, artefacts };
}
