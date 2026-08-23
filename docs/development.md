# Développement

## Prérequis

- Git ;
- Node 22, version déclarée dans `.node-version` et `.nvmrc` ;
- les trois moteurs Playwright — Chromium, Firefox et WebKit — requis par `npm run check`.

Aucun secret et aucune donnée personnelle ne sont nécessaires. Les futurs artefacts VM devront être
récupérables par un script versionné ; un fichier transmis manuellement ne sera jamais un prérequis
accepté.

## Installation

```sh
git clone https://github.com/pinfada/railsbox-vault.git
cd railsbox-vault
npm ci
npx playwright install chromium firefox webkit
```

Sous Linux CI ou sur une machine vierge, Playwright peut installer les dépendances système avec :

```sh
npx playwright install --with-deps chromium firefox webkit
```

Chromium seul suffit pour `npm run test:browser`. Les trois moteurs sont nécessaires à
`npm run test:compat`, et donc à `npm run check`.

## Boucle rapide

```sh
npm run test:unit
npm run lint
npm run format:check
```

## Navigateur

```sh
npm start
```

La page est servie sur `http://127.0.0.1:4173`. Le serveur ne sert que `public/` et les modules de
contrat sous `src/` ; il refuse toute traversée hors de ces racines.

Pour observer la sonde de capacités à la main, il faut un contexte isolé multi-origine, sans quoi
`SharedArrayBuffer` disparaît :

```sh
node tools/serve.mjs --port 4180 --cross-origin-isolated
```

La sonde est alors visible sur `http://127.0.0.1:4180/compat.html`, avec un tableau des verdicts.
Elle est exemptée de la CSP de la coquille : une politique qui lui refuserait WebAssembly lui ferait
rendre « capacité absente » sur un moteur qui la possède.

### Deux origines

L'ADR 0002 sépare la coquille de confiance et le document applicatif par une frontière d'origine. Le
serveur de test prend donc un rôle :

```sh
node tools/serve.mjs --role shell --host 127.0.0.1 --port 4173   # coquille, CSP stricte
node tools/serve.mjs --role app   --host localhost  --port 4174   # territoire applicatif
```

`127.0.0.1` et `localhost` sont deux origines distinctes au sens du navigateur et deux contextes
sécurisés : la frontière est réelle sans DNS ni certificat. Le rôle `shell` sert une CSP stricte à
ses propres documents et n'en impose aucune sous `/spike/origin/app*`, territoire applicatif. Le
paramètre `?isolation=require-corp` ajoute COOP/COEP à une réponse, pour mesurer l'isolation
cross-origin. `playwright.config.mjs` démarre les deux serveurs.

La coquille du spike s'ouvre à l'adresse
`http://127.0.0.1:4173/spike/origin/shell.html?topologie=T2-origine-distincte-sandbox` ; les
topologies disponibles sont listées dans `src/spike/origin-topology.mjs`.

## Vérification avant une PR

```sh
npm run check
```

Cette commande est la référence locale et CI. Une nouvelle suite stable doit y être rattachée ou
documenter explicitement pourquoi elle reste périodique.
