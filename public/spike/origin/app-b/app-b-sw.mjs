// Service Worker de l'application B (spike #46). L'application B tente de l'inscrire sur la
// PORTÉE de l'application A : c'est la seule voie par laquelle un préfixe de chemin serait
// contourné du côté réseau. Le script ne fait rien d'utile — ce qui est mesuré est l'inscription
// elle-même, aboutie ou refusée.

const CANARY_CHEMIN = "/spike/origin/app-a/canary.txt";
const CANARY_INTERCEPTE = "canary-intercepte-par-app-b";

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
