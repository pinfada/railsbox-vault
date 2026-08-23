# Développement

## Prérequis

- Git ;
- Node 22, version déclarée dans `.node-version` et `.nvmrc` ;
- un navigateur Chromium installé par Playwright.

Aucun secret et aucune donnée personnelle ne sont nécessaires. Les futurs artefacts VM devront être
récupérables par un script versionné ; un fichier transmis manuellement ne sera jamais un prérequis
accepté.

## Installation

```sh
git clone https://github.com/pinfada/railsbox-vault.git
cd railsbox-vault
npm ci
npx playwright install chromium
```

Sous Linux CI ou sur une machine vierge, Playwright peut installer les dépendances système avec :

```sh
npx playwright install --with-deps chromium
```

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

## Vérification avant une PR

```sh
npm run check
```

Cette commande est la référence locale et CI. Une nouvelle suite stable doit y être rattachée ou
documenter explicitement pourquoi elle reste périodique.
