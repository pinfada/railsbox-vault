# Spike #35 — protocole et mesures : topologie d'origine de confiance

Ce document est le compte rendu d'expérience du spike #35. La décision qu'il porte est dans
l'[ADR 0002](../decisions/0002-topologie-origine-de-confiance.md) ; ici ne figurent que la question,
l'environnement, les commandes, les résultats bruts et leur lecture.

## Question

Quelle topologie empêche le code applicatif Rails, traité comme hostile, d'obtenir une clé de volume
ou une capacité OPFS privilégiée, tout en conservant un parcours distribuable statiquement ?

## Environnement

| Élément             | Valeur                                                    |
| ------------------- | --------------------------------------------------------- |
| Système             | Windows 11 Famille 10.0.26200, x64                        |
| Node                | 24.14.0 (dépôt : `engines >=22.13 <25`, CI en 22)         |
| npm                 | 11.9.0                                                    |
| Playwright          | 1.62.1                                                    |
| Chromium            | 151.0.7922.34 (révision Playwright 1234)                  |
| Firefox             | 153.0 (révision Playwright 1538)                          |
| WebKit              | 26.5 (révision Playwright 2336, build Windows Playwright) |
| Origine coquille    | `http://127.0.0.1:4173`                                   |
| Origine applicative | `http://localhost:4174`                                   |

`127.0.0.1` et `localhost` sont deux origines distinctes au sens du navigateur et deux contextes
sécurisés : la frontière est réelle, sans DNS, sans certificat et sans second hébergeur. Le serveur
de test prend un rôle (`--role shell|app`), un hôte (`--host`) et un port (`--port`).

Le WebKit livré par Playwright sous Windows n'est pas Safari : les écarts relevés plus bas lui sont
propres et ne valent pas pour la matrice produit, qui reste l'objet de l'issue #2.

## Montage

```text
tools/serve.mjs --role shell --host 127.0.0.1 --port 4173   → coquille, CSP stricte
tools/serve.mjs --role app   --host localhost  --port 4174   → territoire applicatif, sans CSP

public/spike/origin/shell.html + shell.mjs        coquille de confiance
public/spike/origin/runtime-worker.mjs            Worker runtime, détenteur de la clé
public/spike/origin/shell-state.mjs               dépôt de l'état de la coquille et des appâts
public/spike/origin/app.html + app-probe.mjs      document applicatif hostile
public/spike/origin/app-probes-realm.mjs          sondes de realm
public/spike/origin/app-probes-storage.mjs        sondes de stockage et de canaux
public/spike/origin/app-hostile-sw.mjs            Service Worker applicatif interceptant
public/spike/origin/canary.txt                    ressource témoin d'interception
src/spike/origin-topology.mjs                     table des topologies et règles d'admission
```

La coquille est écrite comme une coquille **compétente mais non durcie** : elle n'immobilise pas les
intrinsèques de son realm à la manière de RailsBox Live. Le choix est délibéré et il est défavorable
à la topologie retenue plutôt que l'inverse : il mesure ce que la frontière d'origine apporte
**sans** durcissement.

Trois précautions rendent le relevé opposable :

1. **Témoin positif.** La topologie la plus permissive (T1a) fait l'objet d'une épreuve qui exige
   que les tentatives RÉUSSISSENT. Sans elle, un tableau tout vert ne prouverait que des sondes
   cassées.
2. **Arbitrage côté coquille.** Une sonde qui écrit ne peut pas juger dans quelle partition elle a
   écrit. La présence du marqueur hostile est donc vérifiée depuis la coquille, et l'interception
   réseau est constatée en chargeant la ressource témoin depuis un client neuf.
3. **Troisième résultat.** Une capacité absente du moteur rend `indisponible`, jamais `bloque` :
   confondre les deux ferait passer pour sûre une topologie que le navigateur n'a pas pu mettre à
   l'épreuve.

## Commandes

```sh
npm ci
npx playwright install chromium
npx playwright install firefox webkit   # facultatif, pour les écarts moteurs

npm run test:spike:origin               # les deux suites du spike, Chromium
npm run test:browser                    # harnais + spike
npm run check                           # lint, format, unitaires, navigateur, compatibilité
npm run test:browser:moteurs -- chromium,firefox,webkit
```

### Où lire les relevés bruts

Chaque épreuve **joint** ses mesures au rapport Playwright ; aucune n'écrit sur la sortie standard,
qui resterait polluée à chaque exécution de `npm run check` :

| Attachement                            | Contenu                                                              |
| -------------------------------------- | -------------------------------------------------------------------- |
| `releve-<moteur>-<topologie>.json`     | les dix-neuf sondes, le relevé de la coquille, canary, contamination |
| `navigation-<moteur>-<topologie>.json` | tentative de navigation du sommet et URL finale                      |
| `violations-csp-<moteur>.json`         | violations CSP observées                                             |
| `isolation-<moteur>.json`              | isolation en page et en Worker, avec et sans COOP/COEP               |
| `coep-refus-<moteur>.json`             | échecs réseau et console d'une iframe sans COEP                      |
| `coep-cadre-<moteur>.json`             | isolation mesurée dans le cadre applicatif                           |

```sh
npx playwright test tests/browser/origin-topology.spec.mjs --reporter=html
npx playwright show-report
```

Ces attachements ne sont pas archivés systématiquement en CI : le dépôt n'y publie le rapport
Playwright qu'en cas d'échec, ce qui suffit à diagnostiquer une régression. La reproductibilité du
spike ne dépend pas de cet archivage — les mesures de référence sont figées ci-dessous, et la
commande ci-dessus les régénère à l'identique.

## Résultat de `npm run check`

```text
> railsbox-vault@0.1.0 check
> npm run lint && npm run format:check && npm test && npm run test:compat
…
ℹ tests 60
ℹ pass 60
ℹ fail 0
…
  16 passed (57.7s)   ← harnais + frontière d'origine, Chromium
  6 passed (16.2s)    ← sonde de capacités #2, trois moteurs
```

## Résultat des trois moteurs

```text
> node tools/run-moteurs.mjs chromium,firefox,webkit
  6 skipped
  42 passed (1.5m)
```

Les six épreuves ignorées sont les trois épreuves COOP/COEP sous Firefox et WebKit : elles mesurent
toujours et publient leur relevé, mais n'assertent que sous Chromium. Les écarts sont consignés
ci-dessous.

## Relevé des dix-neuf sondes

`R` = la tentative aboutit · `B` = elle est refusée · `I` = capacité absente du moteur.

### Chromium 151 et Firefox 153 (relevés identiques)

| Sonde                          | Cible          | T1a | T1b | T2  | T3  |
| ------------------------------ | -------------- | :-: | :-: | :-: | :-: |
| obtention-port-restreint       | contrat        |  R  |  R  |  R  |  R  |
| message-forge-fenetre          | coquille       |  B  |  B  |  B  |  B  |
| second-canal-reclame           | coquille       |  B  |  B  |  B  |  B  |
| commande-privilegiee-sur-port  | coquille       |  B  |  B  |  B  |  B  |
| usurpation-iframe-imbriquee    | coquille       |  B  |  B  |  B  |  B  |
| acces-dom-coquille             | coquille       |  R  |  B  |  B  |  B  |
| lecture-appat-realm            | coquille       |  R  |  B  |  B  |  B  |
| lecture-stockage-cle-valeur    | coquille       |  R  |  B  |  B  |  B  |
| reference-worker-runtime       | coquille       |  B  |  B  |  B  |  B  |
| empoisonnement-prototype-port  | coquille       |  R  |  B  |  B  |  B  |
| navigation-top-fragment        | coquille       |  R  |  B  |  B  |  B  |
| ouverture-popup                | coquille       |  R  |  B  |  B  |  B  |
| lecture-opfs-coquille          | coquille       |  R  |  B  |  B  |  B  |
| ecriture-opfs-silencieuse      | origine propre |  R  |  B  |  R  |  B  |
| lecture-indexeddb-coquille     | coquille       |  R  |  B  |  B  |  B  |
| ecriture-indexeddb-silencieuse | origine propre |  R  |  B  |  R  |  B  |
| observation-verrous-web        | coquille       |  R  |  B  |  B  |  B  |
| ecoute-canal-controle          | coquille       |  R  |  B  |  B  |  B  |
| enregistrement-service-worker  | origine propre |  R  |  B  |  R  |  B  |

### WebKit 26.5

Relevé identique, à l'exception des deux sondes OPFS : `I` dans les quatre topologies, motif
`navigator.storage.getDirectory absent`. Ce build ne fournit pas l'OPFS.

### Arbitrage depuis la coquille

| Vérification                                  | T1a                             | T1b         | T2          | T3          |
| --------------------------------------------- | ------------------------------- | ----------- | ----------- | ----------- |
| `hostile.marker` dans l'OPFS de la coquille   | `empreinte-application-hostile` | absent      | absent      | absent      |
| enregistrement hostile dans son IndexedDB     | `empreinte-application-hostile` | absent      | absent      | absent      |
| ressource témoin servie à un client neuf      | `canary-intercepte`             | authentique | authentique | authentique |
| `top.location.replace()` depuis l'application | sommet navigué                  | refusé      | refusé      | refusé      |

## Extraits bruts significatifs

### T1a — même origine, sans sandbox (Chromium)

```text
acces-dom-coquille            | reussi | titre lu : « Coquille de confiance — spike #35 », attribut hostile posé
lecture-appat-realm           | reussi | secret lu : cle-de-volume-synthetique-spike-35
lecture-stockage-cle-valeur   | reussi | localStorage=cle-de-volume-synthetique-spike-35 sessionStorage=…
empoisonnement-prototype-port | reussi | jeton de session capté : jeton-x5ouf7aw
lecture-opfs-coquille         | reussi | marqueur lu : cle-de-volume-synthetique-spike-35
lecture-indexeddb-coquille    | reussi | enregistrement lu : cle-de-volume-synthetique-spike-35
observation-verrous-web       | reussi | verrou vault.volume.exclusive visible ; disponible immédiatement : false
ecoute-canal-controle         | reussi | diffusion captée : {"type":"vault.control.heartbeat","jeton":"jeton-x5ouf7aw"}
enregistrement-service-worker | reussi | portée obtenue : http://127.0.0.1:4173/spike/origin/ ;
                                         portée racine : SecurityError: … not under the max scope allowed ('/spike/origin/')
```

`empoisonnement-prototype-port` mérite d'être lu deux fois : l'application remplace
`parent.MessagePort.prototype.postMessage`, puis déclenche une requête d'état parfaitement légitime.
Le jeton que la coquille destinait à son Worker lui arrive en clair. Aucune faute n'a été commise
par la coquille — elle a simplement appelé une fonction de son propre realm.

### T2 — origine distincte (Chromium)

```text
acces-dom-coquille            | bloque | SecurityError: Failed to read a named property 'document' from 'Window':
                                         Blocked a frame with origin "http://localhost:4174" from accessing a cross-origin frame.
empoisonnement-prototype-port | bloque | SecurityError: Failed to read a named property 'MessagePort' from 'Window': …
navigation-top-fragment       | bloque | SecurityError: Failed to set a named property 'hash' on 'Location': …
ouverture-popup               | bloque | window.open a rendu null
lecture-opfs-coquille         | bloque | NotFoundError: A requested file or directory could not be found …
lecture-indexeddb-coquille    | bloque | base ouverte mais vide : partition d'origine
observation-verrous-web       | bloque | verrou de la coquille invisible ; nom acquis sur l'origine applicative : true
ecoute-canal-controle         | bloque | aucune diffusion reçue en 1 s
enregistrement-service-worker | reussi | portée obtenue : http://localhost:4174/spike/origin/ ; …
commande-privilegiee-sur-port | bloque | refus typé reçu :
                                         {"type":"vault.refus","motif":"requete-non-admise","recu":"vault.export-key"}
```

Relevé publié par la coquille elle-même dans la même exécution :

```json
{
  "origineCoquille": "http://127.0.0.1:4173",
  "origineAttendue": "http://localhost:4174",
  "etatDepose": { "opfs": "depose", "indexedDb": "depose", "storage": "depose", "lock": "tenu" },
  "annoncesRefusees": [
    {
      "motif": "type-inattendu",
      "origine": "http://localhost:4174",
      "type": "vault.grant-volume-key"
    },
    { "motif": "port-deja-emis", "origine": "http://localhost:4174", "type": "vault.app-hello" },
    {
      "motif": "fenetre-emettrice-inattendue",
      "origine": "http://localhost:4174",
      "type": "vault.app-hello"
    }
  ],
  "requetesRefusees": ["vault.export-key"],
  "portEmis": true,
  "cadreApplicatif": "charge"
}
```

Les trois motifs de refus correspondent aux trois conditions cumulées d'admission : le type ne
suffit pas, l'origine ne suffit pas, l'identité de la fenêtre émettrice est nécessaire — c'est elle
qui distingue l'iframe applicative d'une iframe imbriquée qu'elle a elle-même créée, laquelle porte
pourtant la même origine.

### Origines opaques (T1b et T3) — le coût caché

Un document d'origine opaque récupère ses modules ES en mode CORS avec `Origin: null`. Sans
autorisation explicite du serveur, il ne charge aucun script :

```text
Access to script at 'http://127.0.0.1:4173/spike/origin/app-probe.mjs' from origin 'null'
has been blocked by CORS policy: No 'Access-Control-Allow-Origin' header is present …
```

Le rendre mesurable a exigé d'émettre `Access-Control-Allow-Origin: null` quand la requête porte
`Origin: null` — c'est-à-dire d'ouvrir ces ressources à **tout** document sandboxé, puisque `null`
ne désigne personne. Ce n'est pas une commodité de développement : c'est le prix réel de la
topologie, et il est porté par l'origine de la coquille.

Une fois les sondes chargées, l'origine opaque bloque tout, y compris ce dont l'application a besoin
:

```text
lecture-stockage-cle-valeur   | bloque | SecurityError: … The document is sandboxed and lacks the 'allow-same-origin' flag.
observation-verrous-web       | bloque | SecurityError: Failed to execute 'query' on 'LockManager':
                                         Access to the Locks API is denied in this context.
enregistrement-service-worker | bloque | SecurityError: … Service worker is disabled because the context is
                                         sandboxed and lacks the 'allow-same-origin' flag.
```

Sans `localStorage`, sans IndexedDB, sans Web Locks et surtout sans Service Worker, une application
Rails perd sa session et son mode hors ligne. Le transfert du port doit en outre être diffusé avec
`targetOrigin: "*"`, une origine opaque n'étant pas adressable.

## Contraintes d'environnement

### CSP

En-tête réellement servi sur `/spike/origin/shell.html` :

```text
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self';
worker-src 'self'; frame-src 'self' http://localhost:4174; frame-ancestors 'none';
base-uri 'none'; form-action 'none'; object-src 'none'
```

Sonde d'encadrement d'une origine hors liste, sur les trois moteurs :

```text
violations-csp-chromium.json  [{"directive":"frame-src","ressource":"http://127.0.0.1:4199"}]
violations-csp-firefox.json   [{"directive":"frame-src","ressource":"http://127.0.0.1:4199"}]
violations-csp-webkit.json    [{"directive":"frame-src","ressource":"http://127.0.0.1:4199"}]
```

`/spike/origin/app.html` est servi **sans** `Content-Security-Policy`, dans les deux topologies : en
production le HTML applicatif vient du guest, et lui imposer notre politique reviendrait à mesurer
notre propre politique plutôt que la frontière.

### COOP/COEP et SharedArrayBuffer

Sans en-tête, sur les trois moteurs, page et Worker :

```json
{ "crossOriginIsolated": false, "sharedArrayBuffer": "constructeur-absent", "secureContext": true }
```

Avec `Cross-Origin-Opener-Policy: same-origin` et `Cross-Origin-Embedder-Policy: require-corp` :

| Moteur   | Page coquille                             | Worker runtime                                        |
| -------- | ----------------------------------------- | ----------------------------------------------------- |
| Chromium | `crossOriginIsolated: true`, SAB `alloue` | `crossOriginIsolated: true`, SAB `alloue`             |
| Firefox  | `crossOriginIsolated: true`, SAB `alloue` | `crossOriginIsolated: true`, SAB `alloue`             |
| WebKit   | `crossOriginIsolated: true`, SAB `alloue` | **jamais démarré** : module importé sans COEP, refusé |

Message WebKit :

```text
Refused to load 'http://127.0.0.1:4173/spike/origin/isolation-probe.mjs' worker
because of Cross-Origin-Embedder-Policy.
```

Le script du Worker doit lui-même porter la politique : sans elle, il ne démarre sur aucun moteur.
Sous WebKit, la contrainte va plus loin et atteint le module **importé** par le Worker : ici, le
spike ne pose la politique que sur la réponse qui la demande (`?isolation=require-corp`), et
`isolation-probe.mjs` ne la portait pas. La sonde de capacités #2 ne rencontre pas ce refus parce
que son serveur pose COOP/COEP sur **toutes** ses réponses — et y mesure `Atomics.wait` avec succès
sous WebKit. Les deux mesures disent donc la même chose : la politique doit être portée par chaque
artefact du graphe du runtime, pas seulement par la page.

Iframe inter-origine **sans** COEP, sous une coquille en `require-corp` :

```text
coep-refus-chromium.json  ["http://localhost:4174/spike/origin/app.html → net::ERR_BLOCKED_BY_RESPONSE"]
coep-refus-webkit.json    ["… Refused to display 'http://localhost:4174/spike/origin/app.html' in a frame
                            because of Cross-Origin-Embedder-Policy.", "… → Load request cancelled"]
coep-refus-firefox.json   []
```

Firefox refuse aussi le cadre — l'épreuve constate son absence — mais n'expose ni requête en échec
ni message de console à Playwright dans nos conditions. L'assertion reste donc chromium.

Iframe inter-origine **avec** COEP :

```text
coep-cadre-chromium.json  {"crossOriginIsolated":false,"sharedArrayBuffer":"constructeur-absent",…}
coep-cadre-webkit.json    {"crossOriginIsolated":true,"sharedArrayBuffer":"alloue",…}
coep-cadre-firefox.json   {"chargement":"Error: cadre non chargé","journal":[]}
```

Écart notable : sous Chromium, `cross-origin-isolated` étant une fonctionnalité pilotée par
permission dont la liste par défaut est `self`, l'application n'hérite pas de l'isolation et
n'obtient pas `SharedArrayBuffer` — propriété désirable. WebKit la lui accorde. Firefox n'a pas
chargé le cadre. Si l'isolation devient obligatoire pour v86 (#4), la matrice #2 devra trancher
moteur par moteur.

### Service Workers

Portée maximale = répertoire du script, sauf en-tête `Service-Worker-Allowed` que le serveur n'émet
jamais. Une demande de portée `/` est refusée partout :

```text
Chromium : SecurityError: … The path of the provided scope ('/') is not under the max scope
           allowed ('/spike/origin/').
WebKit   : SecurityError: Scope URL should start with the given script URL
```

Cette borne ne suffit pas : en T1a, la portée par défaut couvre déjà le répertoire de la coquille,
et la ressource témoin revient `canary-intercepte`. En T2, la portée obtenue est
`http://localhost:4174/spike/origin/` et la ressource témoin de la coquille reste authentique.

## Conclusion

La frontière d'origine est la seule des quatre topologies qui ferme les onze tentatives visant la
coquille **et** laisse l'application fonctionner. Elle est retenue par l'ADR 0002. Son coût est
d'hébergement — deux origines à publier — et non de navigateur.

Travail découvert, à ouvrir en issues par la supervision :

1. décider si toutes les applications partagent l'origine applicative ou si chacune reçoit la sienne
   : sur une origine partagée, deux applications se lisent mutuellement ;
2. choisir l'option d'hébergement des deux origines dans le parcours de publication (#16) et traiter
   le changement d'origine comme une migration exigeant un export préalable (#12) ;
3. reconfirmer par moteur, dans #2, l'héritage de `cross-origin-isolated` par l'iframe applicative
   et le comportement du Worker sous `require-corp` si l'isolation devient obligatoire.
