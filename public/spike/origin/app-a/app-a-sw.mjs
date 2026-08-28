// Service Worker de l'application A (spike #46). Il intercepte SA ressource témoin, et rien
// d'autre : la portée obtenue est celle de son répertoire, et la question mesurée est de savoir si
// une autre application de la même origine la voit, la réclame ou la retire.
//
// Script CLASSIQUE et constantes recopiées, pour la même raison que `app-hostile-sw.mjs` du spike
// #35 : les Service Workers de type module ne sont pas disponibles sur les trois moteurs, et une
// mesure ne doit pas confondre « refusé » avec « écrit dans une syntaxe non supportée ».

const CANARY_CHEMIN = "/spike/origin/app-a/canary.txt";
const CANARY_INTERCEPTE = "canary-intercepte-par-app-a";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== CANARY_CHEMIN) return;
  event.respondWith(
    new Response(CANARY_INTERCEPTE, {
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    }),
  );
});
