// Service Worker enregistré par le document applicatif. Il ne détourne qu'une ressource témoin
// afin que l'interception soit prouvée sans rendre la page inutilisable : si la coquille récupère
// `canary-intercepte` au lieu de `canary-authentique`, c'est l'application qui a répondu à sa
// place, donc qui contrôle son réseau.
//
// Script CLASSIQUE et constantes recopiées volontairement : les Service Workers de type module ne
// sont pas disponibles sur tous les moteurs mesurés, et le spike ne doit pas confondre « attaque
// impossible » avec « attaque écrite dans une syntaxe non supportée ».

const CANARY_PATH = "/spike/origin/canary.txt";
const CANARY_INTERCEPTED = "canary-intercepte";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== CANARY_PATH) return;
  event.respondWith(
    new Response(CANARY_INTERCEPTED, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
  );
});
