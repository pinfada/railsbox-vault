// Amorce du spike : enregistre le SW. Dans le produit, cet appel est dans la coquille ; ici il est à
// part pour que le BOOT RÉEL (index.html, main.mjs du produit) tourne octet pour octet sans la moindre
// modification du produit.
//
// L'attente de l'activation SONDE l'état (50 ms) au lieu de n'écouter que `statechange` : sous Firefox
// l'événement `activated` peut être émis entre la résolution de `register()` et la pose de l'écouteur
// (mesuré : `load` bloqué indéfiniment). Elle est BORNÉE (25 s) — le produit ne doit jamais bloquer le
// chargement de la page sur une installation.
const attendre = (ms) => new Promise((r) => setTimeout(r, ms));
try {
  const registration = await navigator.serviceWorker.register("/sw-coquille.mjs", { scope: "/", updateViaCache: "none" });
  const ver = registration.installing ?? registration.waiting ?? registration.active;
  const limite = Date.now() + 25000;
  while (ver && ver.state !== "activated" && ver.state !== "redundant" && Date.now() < limite) await attendre(50);
  if (!ver || ver.state === "redundant") throw new Error("installation rejetée");
  if (ver.state !== "activated") throw new Error("délai d'activation");
  document.documentElement.dataset.enregistrement = "actif";
} catch (erreur) {
  document.documentElement.dataset.enregistrement = "echec:" + erreur?.name + ":" + String(erreur?.message).slice(0, 80);
}
