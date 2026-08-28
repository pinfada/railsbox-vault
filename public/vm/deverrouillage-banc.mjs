// Coquille du banc de DÉVERROUILLAGE (#22, ADR 0021).
//
// Elle démarre le Worker de confiance, lui transmet des demandes, et fait **une chose de plus** que
// la coquille de #21 : elle porte la dérivation `webauthn-prf`, parce que `navigator.credentials`
// n'existe que dans un document. La sortie PRF brute ne quitte pas cette page ; ce qui franchit le
// port vers le Worker est la `CryptoKey` non extractible, par clone structuré.
//
// Elle ne détient AUCUNE clé de volume, n'ouvre aucune enveloppe et n'obtient aucun handle : c'est
// ce que la sonde de page et la fouille du port vérifient, au lieu de le croire sur parole.

import {
  derivateurWebauthnPrf,
  enregistrerEmplacementPrf,
} from "/src/vm/derivation/derivateur-webauthn-prf.mjs";
import { preparerEmplacementDerive } from "/src/vm/derivation/emplacement-derive.mjs";
import { decoderParametresPublics } from "/src/vm/derivation/parametres-publics.mjs";
import { TYPES_KEK } from "/src/vm/enveloppe/identite-enveloppe.mjs";

const etat = document.querySelector("#etat");
const rapport = document.querySelector("#rapport");

const worker = new Worker("/vm/deverrouillage-worker.mjs", {
  type: "module",
  name: "vault-deverrouillage",
});
const enCours = new Map();
let compteur = 0;

/** TOUTES les réponses reçues du Worker, conservées pour être FOUILLÉES par l'épreuve. */
const reponses = [];

/** Tout ce que la PAGE a envoyé au Worker, conservé pour la même raison, dans l'autre sens. */
const envois = [];

worker.addEventListener("message", (event) => {
  reponses.push(event.data);
  const { id, ok, report, error } = event.data ?? {};
  const attente = enCours.get(id);
  if (!attente) return;
  enCours.delete(id);
  if (ok) attente.resolve(report);
  else
    attente.reject(
      Object.assign(new Error(`${error?.code ?? "sans code"} — ${error?.message ?? "échec"}`), {
        code: error?.code ?? null,
      }),
    );
});

worker.addEventListener("error", (event) => {
  for (const attente of enCours.values()) {
    attente.reject(new Error(`Erreur du Worker de déverrouillage : ${event.message}`));
  }
  enCours.clear();
});

function executer(payload) {
  compteur += 1;
  const id = compteur;
  etat.textContent = `Exécution du scénario « ${payload.scenario} »…`;
  // Ce qui est ENVOYÉ est journalisé sous une forme fouillable. Une `CryptoKey` n'a pas de
  // représentation textuelle — c'est précisément la propriété mesurée : elle passe sans se lire.
  envois.push(
    JSON.stringify(payload, (_cle, valeur) =>
      valeur instanceof CryptoKey ? "[CryptoKey]" : valeur,
    ),
  );
  return new Promise((resolve, reject) => {
    enCours.set(id, {
      resolve: (report) => {
        etat.textContent = "Terminé.";
        rapport.textContent = JSON.stringify(report, null, 2);
        resolve(report);
      },
      reject: (erreur) => {
        etat.textContent = `Échec : ${erreur.message}`;
        reject(erreur);
      },
    });
    worker.postMessage({ id, type: "run", payload });
  });
}

/**
 * Dérive une KEK de passkey DANS LA PAGE, puis fait poser ou ouvrir l'enveloppe par le Worker.
 *
 * L'épreuve pilote un authentificateur virtuel par CDP ; ici, rien ne le sait : le chemin est celui
 * du produit, `navigator.credentials` compris.
 */
async function passkey(geste) {
  const enregistre = await enregistrerEmplacementPrf({
    rpId: location.hostname,
    nomUtilisateur: "vault",
    identifiantUtilisateur: crypto.getRandomValues(new Uint8Array(16)),
  });
  const derivateur = derivateurWebauthnPrf();
  const prepare = await preparerEmplacementDerive({
    identifiantVolume: geste.identifiantVolume,
    derivateur,
    parametres: enregistre.parametres,
    geste: {},
  });
  const creee = await executer({
    scenario: "prf-creer",
    kek: prepare.kek,
    parametres: enregistre.parametres,
    identifiantEmplacement: prepare.identifiantEmplacement,
  });
  // Seconde assertion : c'est elle qui prouve que la KEK se REFAIT, et non qu'on a gardé la
  // première. Deux appels distincts à l'authentificateur, deux dérivations, une seule enveloppe.
  const seconde = await derivateur.deriver({
    parametres: enregistre.parametres,
    identite: {
      identifiantVolume: geste.identifiantVolume,
      identifiantEmplacement: creee.identifiantEmplacement,
    },
    geste: {},
  });
  const ouverte = await executer({ scenario: "prf-ouvrir", kek: seconde });
  let parametresHex = "";
  for (const octet of enregistre.parametres) parametresHex += octet.toString(16).padStart(2, "0");
  return {
    creation: creee,
    ouverture: ouverte,
    parametresHex,
    parametres: decoderParametresPublics(TYPES_KEK["webauthn-prf"], enregistre.parametres),
  };
}

/** Le geste PRF, en isolant le REFUS : l'épreuve veut le code, pas une trace de pile. */
async function tenterPasskey(geste) {
  try {
    return { rapport: await passkey(geste), code: null };
  } catch (erreur) {
    return {
      rapport: null,
      code: erreur?.code ?? null,
      message: erreur?.message ?? String(erreur),
    };
  }
}

/**
 * Le seul geste d'ASSERTION, sous des paramètres publics déjà enregistrés.
 *
 * Il existe pour mesurer les conduites (b) et (c) de l'ADR 0021 séparément de l'enregistrement :
 * l'épreuve transplante la créance dans un authentificateur SANS PRF, ou coupe la simulation de
 * présence, puis appelle ceci. L'enregistrement, lui, a déjà eu lieu et a réussi.
 */
async function tenterAssertion({ parametresHex, identifiantVolume, identifiantEmplacement }) {
  const parametres = Uint8Array.from(
    parametresHex.match(/../g).map((paire) => Number.parseInt(paire, 16)),
  );
  try {
    await derivateurWebauthnPrf().deriver({
      parametres,
      identite: { identifiantVolume, identifiantEmplacement },
      geste: { delaiMs: 2000 },
    });
    return { code: null };
  } catch (erreur) {
    return { code: erreur?.code ?? null, message: erreur?.message ?? String(erreur) };
  }
}

/** CHRONOMÈTRE la dérivation par passkey. Un aller-retour d'authentificateur, puis un HKDF. */
async function mesurerAssertion({
  parametresHex,
  identifiantVolume,
  identifiantEmplacement,
  tours,
}) {
  const parametres = Uint8Array.from(
    parametresHex.match(/../g).map((paire) => Number.parseInt(paire, 16)),
  );
  const derivateur = derivateurWebauthnPrf();
  const identite = { identifiantVolume, identifiantEmplacement };
  const echantillons = [];
  for (let tour = 0; tour < tours; tour += 1) {
    const debut = performance.now();
    await derivateur.deriver({ parametres, identite, geste: {} });
    echantillons.push(performance.now() - debut);
  }
  echantillons.sort((gauche, droite) => gauche - droite);
  const rang = (part) =>
    echantillons[Math.min(echantillons.length - 1, Math.floor(part * echantillons.length))];
  return {
    tours,
    p50Ms: Math.round(rang(0.5)),
    p95Ms: Math.round(rang(0.95)),
    maxMs: Math.round(echantillons.at(-1)),
  };
}

/** Le seul geste d'ENREGISTREMENT, pour mesurer la conduite (a) sans rien créer ensuite. */
async function tenterEnregistrement() {
  try {
    const enregistre = await enregistrerEmplacementPrf({
      rpId: location.hostname,
      nomUtilisateur: "vault",
      identifiantUtilisateur: crypto.getRandomValues(new Uint8Array(16)),
    });
    return { code: null, octets: enregistre.parametres.byteLength };
  } catch (erreur) {
    return { code: erreur?.code ?? null, message: erreur?.message ?? String(erreur) };
  }
}

/**
 * Mesure ce que la PAGE peut faire du fichier d'enveloppes. Le module d'accès doit la refuser :
 * la coquille n'obtient jamais de handle exclusif (ADR 0002), pas plus sur les clés que sur le
 * volume.
 */
async function sondePage(nomEnveloppe) {
  const { openOpfsSyncAccess } = await import("/src/vm/opfs-sync-access.mjs");
  let code = null;
  let ouvert = false;
  try {
    const handle = await openOpfsSyncAccess(nomEnveloppe);
    ouvert = true;
    handle.close();
  } catch (erreur) {
    code = typeof erreur.code === "string" ? erreur.code : null;
  }
  return { nomEnveloppe, code, ouvert, getDirectory: typeof navigator.storage?.getDirectory };
}

/**
 * SONDE DE NON-PERSISTANCE : elle fouille TOUS les stockages de l'origine, et le port.
 *
 * Elle rend du TEXTE, pas un verdict. Le verdict est l'affaire de l'épreuve, qui y cherche des
 * marqueurs qu'elle connaît — et qui vérifie d'abord, par un appât, que la fouille TROUVE ce qui
 * s'y trouve. Une recherche qui ne trouve jamais rien peut n'être qu'une recherche cassée.
 *
 * @param {{ appat?: string }} [options] dépose un appât dans chaque stockage avant de fouiller
 */
async function sondeStockages({ appat } = {}) {
  const morceaux = [];
  const note = (ou, texte) => morceaux.push({ ou, texte });

  if (appat !== undefined) await deposerLAppat(appat);

  note("localStorage", lireStockageWeb(globalThis.localStorage));
  note("sessionStorage", lireStockageWeb(globalThis.sessionStorage));
  note("cookies", document.cookie);
  note("indexedDB", await lireIndexedDb());
  note("cacheStorage", await lireCacheStorage());
  note("opfs", await lireOpfs());
  note("port", JSON.stringify(reponses));
  note("envois", envois.join("\n"));

  return morceaux;
}

/** Dépose la MÊME chaîne dans chaque stockage : c'est le témoin positif de la fouille. */
async function deposerLAppat(appat) {
  try {
    localStorage.setItem("vault-appat", appat);
    sessionStorage.setItem("vault-appat", appat);
  } catch {
    /* un stockage refusé n'invalide pas les autres */
  }
  document.cookie = `vault-appat=${encodeURIComponent(appat)}; path=/`;
  try {
    const cache = await caches.open("vault-appat");
    await cache.put(new Request("/vault-appat"), new Response(appat));
  } catch {
    /* Cache Storage peut manquer : la sonde le dira par une chaîne vide */
  }
  await deposerDansIndexedDb(appat);
  try {
    const racine = await navigator.storage.getDirectory();
    const fichier = await racine.getFileHandle("vault-appat.txt", { create: true });
    const flux = await fichier.createWritable();
    await flux.write(appat);
    await flux.close();
  } catch {
    /* OPFS peut manquer (WebKit) : la sonde le dira */
  }
}

function deposerDansIndexedDb(appat) {
  return new Promise((resolve) => {
    if (!globalThis.indexedDB) return resolve();
    const requete = indexedDB.open("vault-appat", 1);
    requete.onupgradeneeded = () => requete.result.createObjectStore("appat");
    requete.onsuccess = () => {
      const base = requete.result;
      const transaction = base.transaction("appat", "readwrite");
      transaction.objectStore("appat").put(appat, "cle");
      transaction.oncomplete = () => {
        base.close();
        resolve();
      };
      transaction.onerror = () => resolve();
    };
    requete.onerror = () => resolve();
  });
}

function lireStockageWeb(stockage) {
  if (!stockage) return "";
  const morceaux = [];
  for (let index = 0; index < stockage.length; index += 1) {
    const cle = stockage.key(index);
    morceaux.push(`${cle}=${stockage.getItem(cle)}`);
  }
  return morceaux.join("\n");
}

async function lireIndexedDb() {
  if (!globalThis.indexedDB?.databases) return "";
  const morceaux = [];
  for (const { name } of await indexedDB.databases()) {
    if (!name) continue;
    morceaux.push(name, await lireUneBase(name));
  }
  return morceaux.join("\n");
}

function lireUneBase(nom) {
  return new Promise((resolve) => {
    const requete = indexedDB.open(nom);
    requete.onsuccess = () => {
      const base = requete.result;
      const magasins = [...base.objectStoreNames];
      if (magasins.length === 0) {
        base.close();
        return resolve("");
      }
      const transaction = base.transaction(magasins, "readonly");
      const lus = [];
      for (const magasin of magasins) {
        const tout = transaction.objectStore(magasin).getAll();
        tout.onsuccess = () => lus.push(JSON.stringify(tout.result));
      }
      transaction.oncomplete = () => {
        base.close();
        resolve(lus.join("\n"));
      };
      transaction.onerror = () => resolve("");
    };
    requete.onerror = () => resolve("");
  });
}

async function lireCacheStorage() {
  if (!globalThis.caches) return "";
  const morceaux = [];
  for (const nom of await caches.keys()) {
    const cache = await caches.open(nom);
    for (const requete of await cache.keys()) {
      morceaux.push(requete.url, await (await cache.match(requete)).text());
    }
  }
  return morceaux.join("\n");
}

/** Lit TOUT l'OPFS, fichiers de volume et d'enveloppes compris, en texte ET en hexadécimal. */
async function lireOpfs() {
  if (!navigator.storage?.getDirectory) return "";
  const morceaux = [];
  const racine = await navigator.storage.getDirectory();
  for await (const [nom, poignee] of racine.entries()) {
    morceaux.push(nom);
    if (poignee.kind !== "file") continue;
    const octets = new Uint8Array(await (await poignee.getFile()).arrayBuffer());
    morceaux.push(new TextDecoder("latin1").decode(octets));
    let hex = "";
    for (const octet of octets) hex += octet.toString(16).padStart(2, "0");
    morceaux.push(hex);
  }
  return morceaux.join("\n");
}

globalThis.bancDeverrouillage = Object.freeze({
  executer,
  passkey: tenterPasskey,
  assertion: tenterAssertion,
  mesurerAssertion,
  enregistrement: tenterEnregistrement,
  sondePage,
  sondeStockages,
});
etat.textContent = "Worker de déverrouillage prêt.";
