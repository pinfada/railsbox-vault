// Worker du banc de débit OPFS (#247, lot D, étape 0 de D1).
//
// Il mesure ce que D1 fera : lire un fichier de la taille du disque système depuis l'OPFS par
// `FileSystemSyncAccessHandle.read(cible, { at })`, par blocs de 4 096 octets (le bloc de v86),
// séquentiellement puis à des offsets aléatoires, et le hacher par tranches de 8 Mio avec
// `crypto.subtle.digest`. Il n'écrit rien d'autre que son fichier d'essai, qu'il supprime.

const BLOC = 4096;
const BLOC_TEMOIN = 64 * 1024;
const TRANCHE = 8 * 1024 * 1024;
const NOM = "banc-debit-opfs.bin";

const mio = (octets) => octets / (1024 * 1024);
const debit = (octets, ms) => (ms > 0 ? Math.round((mio(octets) / (ms / 1000)) * 10) / 10 : null);
const arrondi = (ms) => Math.round(ms * 10) / 10;

// Générateur pseudo-aléatoire déterministe : deux moteurs lisent les mêmes offsets.
function melanger(n, graine) {
  const ordre = new Uint32Array(n);
  for (let i = 0; i < n; i += 1) ordre[i] = i;
  let etat = graine >>> 0;
  for (let i = n - 1; i > 0; i -= 1) {
    etat = (Math.imul(etat, 1664525) + 1013904223) >>> 0;
    const j = etat % (i + 1);
    const t = ordre[i];
    ordre[i] = ordre[j];
    ordre[j] = t;
  }
  return ordre;
}

function lireParBlocs(handle, ordre, taille = BLOC) {
  const bloc = new Uint8Array(taille);
  let lus = 0;
  const debut = performance.now();
  for (let i = 0; i < ordre.length; i += 1) {
    lus += handle.read(bloc, { at: ordre[i] * taille });
  }
  return { octets: lus, ms: performance.now() - debut };
}

async function hacherParTranches(handle, taille) {
  const tampon = new Uint8Array(TRANCHE);
  const empreintes = [];
  const debut = performance.now();
  for (let at = 0; at < taille; at += TRANCHE) {
    const n = handle.read(tampon, { at });
    empreintes.push(await crypto.subtle.digest("SHA-256", tampon.subarray(0, n)));
  }
  return { tranches: empreintes.length, ms: performance.now() - debut };
}

function ecrire(handle, taille) {
  handle.truncate(0);
  const tampon = new Uint8Array(TRANCHE);
  for (let i = 0; i < TRANCHE; i += 4) tampon[i] = (i * 2654435761) >>> 24;
  const debut = performance.now();
  for (let at = 0; at < taille; at += TRANCHE) {
    handle.write(tampon.subarray(0, Math.min(TRANCHE, taille - at)), { at });
  }
  handle.flush();
  return { octets: taille, ms: performance.now() - debut };
}

const sequence = (n) => Uint32Array.from({ length: n }, (_, i) => i);
const resume = ({ octets, ms }) => ({ ms: arrondi(ms), mioParS: debit(octets, ms) });

async function mesurer({ taille }) {
  const racine = await navigator.storage.getDirectory();
  const fichier = await racine.getFileHandle(NOM, { create: true });
  if (typeof fichier.createSyncAccessHandle !== "function") {
    return { accesSynchrone: false };
  }
  const handle = await fichier.createSyncAccessHandle();
  try {
    const ecriture = ecrire(handle, taille);
    const blocs = Math.ceil(taille / BLOC);
    const sequentiel = lireParBlocs(handle, sequence(blocs));
    const aleatoire = lireParBlocs(handle, melanger(blocs, 0x5eed));
    // Témoin : le même parcours séquentiel par blocs de 64 Kio sépare le coût par appel du débit.
    const sequentiel64 = lireParBlocs(
      handle,
      sequence(Math.ceil(taille / BLOC_TEMOIN)),
      BLOC_TEMOIN,
    );
    const empreintes = await hacherParTranches(handle, taille);
    return {
      accesSynchrone: true,
      tailleMio: mio(taille),
      ecriture: resume(ecriture),
      lectureSequentielle4k: resume(sequentiel),
      lectureAleatoire4k: resume(aleatoire),
      lectureSequentielle64k: resume(sequentiel64),
      empreintes8Mio: {
        tranches: empreintes.tranches,
        ...resume({ octets: taille, ms: empreintes.ms }),
      },
    };
  } finally {
    handle.close();
    await racine.removeEntry(NOM).catch(() => {});
  }
}

self.addEventListener("message", (event) => {
  mesurer(event.data ?? {}).then(
    (report) => self.postMessage({ ok: true, report }),
    (error) =>
      self.postMessage({ ok: false, error: { name: error?.name, message: error?.message } }),
  );
});
