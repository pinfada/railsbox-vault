// Coquille du banc de débit OPFS (#247). Elle démarre le Worker, lui transmet la taille du fichier
// d'essai et publie son compte rendu dans `window.__debitOpfs` pour `tools/mesurer-debit-opfs.mjs`.

const TAILLE_PAR_DEFAUT_MIO = 522;

const etat = document.querySelector("#etat");
const rapport = document.querySelector("#rapport");
const mio = Number(new URLSearchParams(location.search).get("mio")) || TAILLE_PAR_DEFAUT_MIO;

const worker = new Worker("/vm/debit-opfs-worker.mjs", { type: "module", name: "debit-opfs" });

window.__debitOpfs = new Promise((resolve) => {
  worker.addEventListener("message", (event) => resolve(event.data));
  worker.addEventListener("error", (event) =>
    resolve({ ok: false, error: { name: "WorkerError", message: event.message } }),
  );
});

window.__debitOpfs.then((resultat) => {
  etat.textContent = resultat.ok ? "Terminé." : "Échec.";
  rapport.textContent = JSON.stringify(resultat, null, 2);
});

etat.textContent = `Mesure sur ${mio} Mio…`;
worker.postMessage({ taille: mio * 1024 * 1024 });
