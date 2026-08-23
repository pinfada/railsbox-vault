// Harnais d'intégration : boote l'image de référence sous Node avec v86 et
// parle à Rails par le port série.
//
// Il n'y a pas de réseau émulé : le seul canal est ttyS0, et le protocole est
// celui de `tools/build-reference-image/guest/serial-bridge.py`. Le codec est
// partagé avec `tools/vm/serial-protocol.mjs`, dont la suite unitaire couvre le
// réassemblage — ce qui laisse à ce module la seule responsabilité du démarrage
// de la machine.
import { existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

import {
  construireTramesRequete,
  creerAssembleurLignes,
  creerAssembleurReponses,
  decouperReponseHttp,
} from "./serial-protocol.mjs";

export const RACINE_DEPOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const DOSSIER_ARTEFACTS = join(RACINE_DEPOT, "artifacts", "reference-image");
export const CHEMIN_MANIFESTE = join(
  RACINE_DEPOT,
  "tools",
  "build-reference-image",
  "manifest.json",
);

const DELAI_REQUETE_MS = 120_000;
const INTERVALLE_SONDE_MS = 5_000;

/**
 * Décrit ce qui manque pour booter. Rend `null` quand tout est là.
 *
 * @param {{ dossierArtefacts?: string, cheminManifeste?: string }} [options]
 * @returns {string | null}
 */
export function raisonDIndisponibilite(options = {}) {
  const cheminManifeste = options.cheminManifeste ?? CHEMIN_MANIFESTE;
  const dossierArtefacts = options.dossierArtefacts ?? DOSSIER_ARTEFACTS;

  if (!existsSync(cheminManifeste)) {
    return `manifeste absent (${cheminManifeste}) : construire l'image avec « npm run image:build »`;
  }
  if (!existsSync(dossierArtefacts)) {
    return `artefacts absents (${dossierArtefacts}) : construire l'image avec « npm run image:build »`;
  }
  return null;
}

/**
 * @param {Record<string, any>} manifeste
 * @param {string} [dossierArtefacts]
 * @returns {Map<string, { byteSize: number, sha256: string }>}
 */
export async function empreintesObservees(manifeste, dossierArtefacts = DOSSIER_ARTEFACTS) {
  /** @type {Map<string, { byteSize: number, sha256: string }>} */
  const observes = new Map();
  for (const artefact of manifeste.artifacts) {
    const chemin = join(dossierArtefacts, artefact.name);
    if (!existsSync(chemin)) continue;
    const contenu = await readFile(chemin);
    observes.set(artefact.name, {
      byteSize: statSync(chemin).size,
      sha256: createHash("sha256").update(contenu).digest("hex"),
    });
  }
  return observes;
}

/**
 * Démarre la VM et rend un client HTTP série.
 *
 * @param {{
 *   manifeste: Record<string, any>,
 *   dossierArtefacts?: string,
 *   surJournal?: (ligne: string) => void,
 * }} options
 */
export async function demarrerVm({
  manifeste,
  dossierArtefacts = DOSSIER_ARTEFACTS,
  surJournal = () => {},
}) {
  const { V86 } = await import("v86");
  const chemin = (nom) => join(dossierArtefacts, nom);
  const disque = (nom) => ({ url: chemin(nom), size: statSync(chemin(nom)).size, async: true });

  const emulateur = new V86({
    wasm_path: join(RACINE_DEPOT, "node_modules", "v86", "build", "v86.wasm"),
    memory_size: manifeste.boot.memoryMiB * 1024 * 1024,
    vga_memory_size: 2 * 1024 * 1024,
    bios: { url: chemin(manifeste.boot.bios) },
    vga_bios: { url: chemin(manifeste.boot.vgaBios) },
    bzimage: { url: chemin(manifeste.boot.kernel) },
    initrd: { url: chemin(manifeste.boot.initrd) },
    cmdline: manifeste.boot.cmdline,
    hda: disque(manifeste.boot.hda),
    hdb: disque(manifeste.boot.hdb),
    autostart: true,
    disable_speaker: true,
    disable_keyboard: true,
    disable_mouse: true,
  });

  const assembleurReponses = creerAssembleurReponses();
  /** @type {Map<string, { resoudre: (valeur: any) => void, rejeter: (erreur: Error) => void }>} */
  const enAttente = new Map();
  /** @type {Map<string, () => void>} */
  const acquittements = new Map();

  const assembleurLignes = creerAssembleurLignes((ligne) => {
    const evenement = assembleurReponses.traiterLigne(ligne);
    if (evenement === null) return;
    if (evenement.type === "journal") {
      surJournal(evenement.texte);
      return;
    }
    if (evenement.type === "ack") {
      acquittements.get(evenement.id)?.();
      return;
    }
    const attente = enAttente.get(evenement.id);
    if (attente === undefined) return;
    enAttente.delete(evenement.id);
    if (evenement.type === "erreur") {
      attente.rejeter(
        new Error(`le pont a refusé la requête : ${evenement.libelle} (code ${evenement.code})`),
      );
    } else {
      attente.resoudre(decouperReponseHttp(evenement.octets));
    }
  });

  const decodeur = new TextDecoder("utf-8", { fatal: false });
  emulateur.add_listener("serial0-output-byte", (octet) => {
    assembleurLignes.ajouter(decodeur.decode(new Uint8Array([octet]), { stream: true }));
  });

  let compteur = 0;

  /**
   * @param {string} methode
   * @param {string} chemin_
   * @param {{ delaiMs?: number }} [reglages]
   */
  async function requete(methode, chemin_, reglages = {}) {
    const identifiant = `r${(compteur += 1)}`;
    const trames = construireTramesRequete(identifiant, {
      method: methode,
      path: chemin_,
      headers: [
        ["Host", "127.0.0.1"],
        ["Accept", "application/json"],
        ["User-Agent", "railsbox-vault-vm-harness"],
      ],
    });

    const promesse = new Promise((resoudre, rejeter) => {
      const minuterie = setTimeout(() => {
        enAttente.delete(identifiant);
        rejeter(
          new Error(
            `aucune réponse à ${methode} ${chemin_} en ${reglages.delaiMs ?? DELAI_REQUETE_MS} ms`,
          ),
        );
      }, reglages.delaiMs ?? DELAI_REQUETE_MS);
      enAttente.set(identifiant, {
        resoudre: (valeur) => {
          clearTimeout(minuterie);
          resoudre(valeur);
        },
        rejeter: (erreur) => {
          clearTimeout(minuterie);
          rejeter(erreur);
        },
      });
    });

    emulateur.serial0_send(`${trames.ouverture}\n`);
    for (const tranche of trames.tranches) {
      const acquitte = new Promise((resoudre) => acquittements.set(identifiant, resoudre));
      emulateur.serial0_send(`${tranche}\n`);
      await acquitte;
      acquittements.delete(identifiant);
    }
    emulateur.serial0_send(`${trames.cloture}\n`);
    return promesse;
  }

  /**
   * Attend que la route de santé réponde. Sonde le vrai service : la VM est
   * « prête » quand Rails répond, pas quand le noyau a démarré.
   *
   * @param {{ delaiTotalMs: number }} reglages
   * @returns {Promise<{ dureeMs: number, sante: Record<string, any> }>}
   */
  async function attendreSante({ delaiTotalMs }) {
    const debut = Date.now();
    let derniereErreur = null;
    while (Date.now() - debut < delaiTotalMs) {
      try {
        const reponse = await requete("GET", "/vault/health", { delaiMs: INTERVALLE_SONDE_MS });
        if (reponse.statut === 200) {
          return {
            dureeMs: Date.now() - debut,
            sante: JSON.parse(new TextDecoder().decode(reponse.corps)),
          };
        }
        derniereErreur = new Error(`/vault/health a répondu ${reponse.statut}`);
      } catch (erreur) {
        derniereErreur = erreur instanceof Error ? erreur : new Error(String(erreur));
      }
      await pause(INTERVALLE_SONDE_MS);
    }
    throw new Error(
      `la route de santé n'a pas répondu en ${Math.round(delaiTotalMs / 1000)} s ; ` +
        `dernière erreur : ${derniereErreur?.message ?? "aucune"}`,
    );
  }

  async function arreter() {
    if (typeof emulateur.destroy === "function") await emulateur.destroy();
    else emulateur.stop();
  }

  return { emulateur, requete, attendreSante, arreter };
}

/**
 * @param {number} millisecondes
 * @returns {Promise<void>}
 */
export function pause(millisecondes) {
  return new Promise((resoudre) => setTimeout(resoudre, millisecondes));
}
