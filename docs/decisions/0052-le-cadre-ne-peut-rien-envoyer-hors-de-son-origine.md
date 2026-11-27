# ADR 0052 — Le cadre ne peut rien envoyer hors de son origine : une CSP injectée, sans liste blanche

- Statut : proposé (relecture du mainteneur demandée)
- Date : 2026-11-27
- Issue : [#341](https://github.com/pinfada/railsbox-vault/issues/341) · lot
  `lot:applications-tierces` · Invariant : `SEC-ORIGIN-001`
- **Complète** l'[ADR 0038](0038-servir-l-application-dans-le-cadre.md) (le relais servait sans CSP)
  et lève la « piste » de l'[ADR 0002](0002-topologie-origine-de-confiance.md) (« le durcissement
  par CSP injectée »). **Ne touche pas** la CSP de la coquille
  ([ADR 0013](0013-csp-de-la-coquille-et-boucle-de-v86.md)) : `tools/serve-headers.mjs` sert la même
  politique au rôle `shell`, octet pour octet.
- Reprend : `pinfada/railsbox`, `APP_DOCUMENT_CSP` et `prepareProxyHeaders`
  (`public/shared/proxy-logic.js`), leurs épreuves (`tests/proxy-logic.test.mjs`) et la ligne « XSS
  dans l'application → exfiltration réseau » de son `SECURITY.md`.

## Contexte

Le relais sert les documents de l'application dans un cadre de l'origine applicative (ADR 0038). Ils
n'avaient aucune CSP, et `ENTETES_DE_REPONSE_RENDUES` ne rend pas celle de Rails. Une application —
la référence, ou demain une application tierce (#236, #272) — pouvait donc envoyer le clair du
coffre où elle voulait : `fetch`, `<img>`, formulaire, `WebSocket`, `sendBeacon`. Mesuré avant ce
changement, sur les trois moteurs : **quinze voies sur quinze** atteignent une origine tierce
(`tests/browser/coquille-sorties-du-cadre.spec.mjs`, commit rouge de la PR).

Décision du mainteneur (27/11/2026) : **le cadre ne peut RIEN envoyer hors de son origine**. Ni
liste blanche, ni exception, pour l'instant.

## Décisions

1. **Une politique du cadre, posée par le Service Worker du cadre sur TOUT ce qu'il sert.**
   `POLITIQUE_DU_CADRE` (`src/coquille/relais-http.mjs`) :

   ```text
   default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
   img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self'; form-action 'self';
   base-uri 'self'; object-src 'none'
   ```

   C'est celle de RailsBox, à **un écart près** : RailsBox laisse `img-src *` (fonds de carte) et
   l'écrit comme un canal résiduel assumé. Ici, aucun canal assumé. `imposerLesEntetesDuCadre` la
   pose avec les en-têtes de l'hébergeur, sur la page relayée, ses sous-ressources, les refus et la
   page d'attente. Elle est posée quel que soit le `Content-Type` — RailsBox la réserve au HTML ; un
   document SVG ou XHTML s'exécute aussi, et le type est ce que le guest dit de sa réponse.

2. **Une CSP de Rails ne l'élargit pas.** Deux lignes : l'en-tête de Rails n'est pas rendu
   (`ENTETES_DE_REPONSE_RENDUES` est inchangé), et s'il l'était, la pose est INCONDITIONNELLE (`set`
   après ceux du guest). C'est le défaut que RailsBox a corrigé : sa pose conditionnelle laissait
   une application à CSP permissive désactiver la sienne. Un `<meta>` écrit par Rails dans sa page
   ne peut que restreindre : plusieurs politiques s'appliquent toutes (CSP niveau 3). L'épreuve rend
   la page hostile avec une CSP permissive en en-tête ET en `<meta>`.

3. **Le courtier porte sa propre politique, par `<meta>`.** C'est l'écart de structure avec
   RailsBox, et la mesure l'a imposé : avec la seule politique du cadre, trois voies restaient
   ouvertes sur les trois moteurs — `parent.fetch`, une image insérée dans le document du courtier,
   et la navigation du cadre vers le tiers. Le courtier est de même origine que l'application
   (ADR 0038) ; son royaume était la porte dérobée de la décision 1, et c'est son `frame-src` —
   celui du PARENT — qui juge la navigation du cadre imbriqué. `POLITIQUE_DU_COURTIER` :

   ```text
   default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self';
   worker-src 'self'; frame-src 'self'; form-action 'none'; base-uri 'none'; object-src 'none'
   ```

   Par `<meta>` et non par en-tête : le courtier est servi par l'hébergeur, avant tout Service
   Worker, et l'hébergeur ne pose pas toujours d'en-tête (ADR 0010). Aucune de ces directives n'est
   de celles qu'un `<meta>` ignore (`frame-ancestors`, `report-uri`, `sandbox`).

4. **Pas de `frame-ancestors`.** Le cadre est encadré par la coquille, d'une autre origine, et
   `frame-ancestors 'self'` juge tous les ancêtres : il interdirait le cadre lui-même.

5. **`'unsafe-inline'` reste sur les scripts et les styles du cadre**, comme dans RailsBox. Une
   application Rails ordinaire en émet (importmap, Turbo) ; il dit ce qui s'exécute, pas ce qui est
   atteint, et n'ouvre aucune sortie. L'application de référence n'en a pas besoin.

6. **Ce que la sandbox ferme reste à la sandbox.** `window.open` et la navigation du sommet sont
   fermés par la sandbox de la coquille (ni `allow-popups`, ni `allow-top-navigation`, ADR 0038).
   L'épreuve les tente dans les deux montages et exige qu'ils restent fermés.

## Preuves

- `tests/browser/coquille-sorties-du-cadre.spec.mjs`, trois moteurs : le VRAI courtier et le VRAI
  Service Worker du cadre, une coquille simulée qui tient aussi le rôle du guest. L'origine tierce
  compte ce qu'elle reçoit. Le **témoin positif** (même page, même sandbox, sans politique) reçoit
  chaque voie ; le **contre-témoin** vérifie que `fetch`, image et formulaire vers l'origine
  applicative sont relayés.
- `tests/unit/coquille-politique-du-cadre.test.mjs` juge le SENS des politiques, replis de CSP
  niveau 3 compris, et dix mutants de la campagne `coquille` (`tools/muter-gardes-coquille.mjs`)
  sont tués par elle. Le BRANCHEMENT dans le Service Worker, qu'aucune épreuve Node n'exécute, est
  tenu par l'épreuve navigateur : retiré, douze voies rouvrent sur les trois moteurs (mesuré).
- `form-action` est doublé par `frame-src` dans ce montage (un formulaire navigue un cadre) : le
  retirer ne rougit pas l'épreuve navigateur, il rougit l'épreuve unitaire.

## Conséquences et limites

- **Hors périmètre** (issue) : une liste de sorties déclarée par l'application ; une origine par
  application (ADR 0018). Une application qui a besoin d'un service tiers ne fonctionne pas.
- **WebSocket de même origine** (ActionCable) : `'self'` couvre `ws:` de même hôte selon CSP niveau
  3 ; non mesuré, et le relais ne relaie de toute façon pas de WebSocket.
- **Non couvert par une CSP, et non prouvé** : la pré-résolution DNS (`<link rel=dns-prefetch>`,
  `preconnect`) et WebRTC (`RTCPeerConnection` vers un serveur STUN/TURN tiers). Aucun moteur de la
  matrice n'applique la directive `webrtc`. Ce sont des canaux connus de contournement de CSP ; ils
  ne sont pas tentés par l'épreuve, faute d'une origine tierce qui sache les relever.
- **RÉSIDUEL MESURÉ, OUVERT : la désinscription du Service Worker.** L'application est de même
  origine que le Service Worker du cadre : `navigator.serviceWorker.getRegistrations()` puis
  `unregister()` lui sont permis. Les navigations suivantes partent alors à l'HÉBERGEUR, qui sert
  ses fichiers (n'importe lequel : un module, une page 404) sans politique ; un cadre de même
  origine sur un tel fichier prête son royaume, et son `fetch` sort. Mesuré le 27/11/2026 : **ouvert
  sous Chromium et WebKit, fermé sous Firefox**. L'épreuve tente la voie, la publie en annotation
  (`residuel`) et ne l'exige pas. La fermer demande une CSP **posée par l'hébergeur** sur toute
  réponse de l'origine applicative — `tools/serve-headers.mjs` (rôle `app`) et le `_headers` de
  l'arbre applicatif — ce que l'ADR 0002 écartait, ce que GitHub Pages ne sait pas faire (ADR 0010)
  et dont l'effet sur les pages 404 de l'hébergeur n'est pas mesuré. **Décision du mainteneur** ;
  elle n'est pas prise ici.
