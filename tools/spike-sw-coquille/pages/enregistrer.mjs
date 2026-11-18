// Amorce du spike : enregistre le SW. Dans le produit, cet appel est dans la coquille ; ici il est à
// part pour que le BOOT RÉEL (index.html, main.mjs du produit) tourne octet pour octet sans la moindre
// modification du produit.
try {
  const registration = await navigator.serviceWorker.register("/sw-coquille.mjs", { scope: "/", updateViaCache: "none" });
  const ver = registration.installing ?? registration.waiting ?? registration.active;
  if (ver && ver.state !== "activated") {
    await new Promise((ok, ko) => {
      const sur = () => {
        if (ver.state === "activated") ok();
        if (ver.state === "redundant") ko(new Error("installation rejetée"));
      };
      ver.addEventListener("statechange", sur);
      sur();
    });
  }
  document.documentElement.dataset.enregistrement = "actif";
} catch (erreur) {
  document.documentElement.dataset.enregistrement = "echec:" + erreur?.name + ":" + String(erreur?.message).slice(0, 80);
}
