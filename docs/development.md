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
node tools/serve.mjs --port 4174 --cross-origin-isolated
```

La sonde est alors visible sur `http://127.0.0.1:4174/compat.html`, avec un tableau des verdicts.

## Vérification avant une PR

```sh
npm run check
```

Cette commande est la référence locale et CI. Une nouvelle suite stable doit y être rattachée ou
documenter explicitement pourquoi elle reste périodique.
