// SPIKE JETABLE (#310, Révision 2, constat 2 / L7) — hors produit, sans PR, branche `spike/c1-course-onglets`.
//
// Question : « ouvrir l'enveloppe » (qui donne la DEK) PRÉCÈDE « prendre le handle exclusif du volume »
// (`public/runtime-worker-deverrouillage.mjs:159-171, 203-215`). Un second Worker peut-il, entre les deux,
// voir sa clé révoquée par le Worker qui tient le volume, puis ouvrir le volume quand l'autre le ferme ?
//
// Ce Worker rejoue la MÊME SÉQUENCE avec les MÊMES fonctions de bibliothèque que le Worker de produit :
//   ouvrirEnveloppe(kek) → [pause contrôlée] → openOpfsVolume(dek)   (ouvrirLExistante, puis ouvrirLeVolume)
// Il n'est PAS le Worker de produit (qui dépend de l'état `interne` et du canal) : la pause est
// l'unique ajout. Ce qui est mesuré est la sémantique de la bibliothèque sur l'OPFS réel.

import { SECTOR_SIZE } from "/src/vm/block-geometry.mjs";
import { revoquerToutSauf, ajouterEmplacement, creerEnveloppe, ouvrirEnveloppe, inventorierEnveloppe } from "/src/vm/enveloppe-de-cle.mjs";
import { TYPES_KEK, tirerCleDeVolume } from "/src/vm/enveloppe/identite-enveloppe.mjs";
import { IDENTIFIANT_DU_COFFRE, IDENTIFIANT_DU_VOLUME_COQUILLE } from "/src/coquille/identites-du-coffre.mjs";
import { openOpfsVolume } from "/src/vm/opfs-block-backend.mjs";
import { removeOpfsVolume } from "/src/vm/opfs-sync-access.mjs";
import { supportEnveloppeOpfs } from "/src/vm/ouverture-par-enveloppe.mjs";

const VOLUME = "spike-course-onglets";
const TAILLE = 32 * SECTOR_SIZE;
const support = () => supportEnveloppeOpfs(VOLUME);
const hex = (s) => Uint8Array.from(s.match(/../g).map((o) => Number.parseInt(o, 16)));
const marqueur = () => Uint8Array.from({ length: SECTOR_SIZE }, (_, i) => (i * 7 + 3) & 0xff);
const code = (e) => (typeof e?.code === "string" ? e.code : `${e?.name ?? "Error"}:${e?.message ?? e}`);
const memes = (a, b) => a.byteLength === b.byteLength && a.every((v, i) => v === b[i]);

let backend = null;
let porte = null; // la pause : une promesse levée par le message « reprendre »
let leverLaPorte = null;

async function ouvrirLeVolume(dek) {
  backend = await openOpfsVolume({ name: VOLUME, size: TAILLE, cle: dek, identifiantVolume: IDENTIFIANT_DU_VOLUME_COQUILLE, transactionnel: false });
}

const operations = {
  async preparer({ kekA, kekB }) {
    await removeOpfsVolume(VOLUME);
    const dek = tirerCleDeVolume();
    await creerEnveloppe({ support: support(), identifiantVolume: IDENTIFIANT_DU_COFFRE, dek, kek: hex(kekA) });
    const b = await openOpfsVolume({ name: VOLUME, size: TAILLE, cle: dek, identifiantVolume: IDENTIFIANT_DU_VOLUME_COQUILLE, transactionnel: false });
    await b.write(0, marqueur());
    await b.flush();
    await b.close();
    await ajouterEmplacement({ support: support(), identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: hex(kekA), kekNouvelle: hex(kekB), typeKek: TYPES_KEK.recuperation, parametres: new Uint8Array(24) });
    dek.fill(0);
    const inv = await inventorierEnveloppe({ support: support(), identifiantVolume: IDENTIFIANT_DU_COFFRE });
    return { emplacements: inv.emplacements.length };
  },
  /** Séquence du produit : enveloppe → (pause) → volume. */
  async ouvrir({ kek, pause }) {
    let dek;
    try {
      const ouverte = await ouvrirEnveloppe({ support: support(), identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: hex(kek) });
      dek = ouverte.dek;
    } catch (e) {
      return { etape: "enveloppe", ok: false, code: code(e) };
    }
    self.postMessage({ evt: "enveloppe-ouverte" });
    if (pause) {
      porte = new Promise((r) => { leverLaPorte = r; });
      await porte;
    }
    try {
      await ouvrirLeVolume(dek);
    } catch (e) {
      return { etape: "volume", ok: false, code: code(e) };
    } finally {
      dek.fill(0);
    }
    const lu = await backend.read(0, SECTOR_SIZE);
    return { etape: "volume", ok: true, marqueurLu: memes(lu, marqueur()) };
  },
  /** Largeur de la fenêtre dans la séquence du produit, sans contention, et durée de la révocation. */
  async chronometrer({ kek, kekRevoque }) {
    const t0 = performance.now();
    const ouverte = await ouvrirEnveloppe({ support: support(), identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: hex(kek) });
    const t1 = performance.now();
    await ouvrirLeVolume(ouverte.dek);
    ouverte.dek.fill(0);
    const t2 = performance.now();
    await revoquerToutSauf({ support: support(), identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: hex(kek) });
    const t3 = performance.now();
    await backend.close(); backend = null;
    const t4 = performance.now();
    return { enveloppeMs: +(t1 - t0).toFixed(2), fenetreEnveloppeVersVolumeMs: +(t2 - t1).toFixed(2), revocationMs: +(t3 - t2).toFixed(2), fermetureMs: +(t4 - t3).toFixed(2) };
  },
  async reprendre() { leverLaPorte?.(); return {}; },
  async revoquer({ kek }) {
    await revoquerToutSauf({ support: support(), identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: hex(kek) });
    const inv = await inventorierEnveloppe({ support: support(), identifiantVolume: IDENTIFIANT_DU_COFFRE });
    return { emplacements: inv.emplacements.length };
  },
  async fermer() { await backend?.close(); backend = null; return {}; },
  /** Ce que la clé vaut maintenant, côté enveloppe. */
  async sonder({ kek }) {
    try { await ouvrirEnveloppe({ support: support(), identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: hex(kek) }); return { ouvre: true }; }
    catch (e) { return { ouvre: false, code: code(e) }; }
  },
  /** Après avoir ouvert le volume avec une clé révoquée : que peut faire cette session ? */
  async essayerLaRevocation({ kek }) {
    try { await revoquerToutSauf({ support: support(), identifiantVolume: IDENTIFIANT_DU_COFFRE, kek: hex(kek) }); return { ok: true }; }
    catch (e) { return { ok: false, code: code(e) }; }
  },
  async lire() { const lu = await backend.read(0, SECTOR_SIZE); return { marqueurLu: memes(lu, marqueur()) }; },
};

self.onmessage = async ({ data }) => {
  const { id, op, ...args } = data;
  try {
    const rendu = await operations[op](args);
    self.postMessage({ id, ...rendu });
  } catch (e) {
    self.postMessage({ id, erreur: code(e) });
  }
};
self.postMessage({ evt: "pret" });
