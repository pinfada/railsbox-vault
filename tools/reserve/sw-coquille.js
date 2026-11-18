// SQUELETTE NAÏF du Service Worker de la coquille (#299) : il ne vérifie rien, laisse tout partir au
// réseau et s'active tout de suite. C'est l'état « sans la garde » que les épreuves rouges mesurent.
"use strict";

const CONFIG = /*__CONFIG__*/ null;

self.addEventListener("install", (evenement) => {
  evenement.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (evenement) => {
  evenement.waitUntil(self.clients.claim());
});
self.addEventListener("fetch", (evenement) => {
  evenement.respondWith(fetch(evenement.request));
});
void CONFIG;
