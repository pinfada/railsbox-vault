// Service Worker de la fixture malveillante (#161).
//
// Il fait la seule chose qui compte pour la mesure : RÉPONDRE À LA PLACE DU SERVEUR sur la ressource
// témoin, dans la portée qu'il a obtenue. Sur l'origine applicative, c'est ce que l'ADR 0002 accorde
// à l'application — sa propre portée, et rien d'autre. Sur l'origine de la coquille, ce serait du
// code applicatif servant les octets de l'origine de confiance : le témoin positif le montre en
// même origine, et c'est ce qui donne son sens au « témoin authentique » relevé de l'autre côté.
//
// Script CLASSIQUE et constantes RECOPIÉES, comme celui du spike #35 et pour la même raison : les
// Service Workers de type module ne sont pas offerts par les trois moteurs de la matrice #2, et
// l'épreuve ne doit pas confondre « attaque impossible » avec « attaque écrite dans une syntaxe non
// supportée ». Les deux valeurs sont relues par `tests/unit/coquille-fixture.test.mjs`, qui les
// confronte à `marqueurs.mjs` — une recopie que rien ne relit finit toujours par diverger.

const TEMOIN_CHEMIN = "/coquille-epreuve/temoin.txt";
const TEMOIN_INTERCEPTE = "temoin-intercepte";

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin || url.pathname !== TEMOIN_CHEMIN) return;
  event.respondWith(
    new Response(TEMOIN_INTERCEPTE, { headers: { "Content-Type": "text/plain; charset=utf-8" } }),
  );
});
