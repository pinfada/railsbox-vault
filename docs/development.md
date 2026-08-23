# Développement

## Prérequis

- Git ;
- Node 22, version déclarée dans `.node-version` et `.nvmrc` ;
- les trois moteurs Playwright — Chromium, Firefox et WebKit — requis par `npm run check`.

Aucun secret et aucune donnée personnelle ne sont nécessaires. Les artefacts VM sont récupérables
par un script versionné (`npm run vm:fetch`) et vérifiés par empreinte ; un fichier transmis
manuellement n'est jamais un prérequis accepté.

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

## Contextes d'exécution et lint

Le dépôt exécute son code dans cinq contextes qui n'offrent pas les mêmes API globales.
`eslint.config.mjs` n'accorde à chaque fichier que les globals de son contexte, afin qu'un appel
Node dans du code servi au navigateur, ou une API DOM dans un Worker, soit refusé à la première
exécution de `npm run lint` plutôt qu'à la première exécution dans le navigateur.

| Contexte           | Fichiers concernés                              | Globals accordés    |
| ------------------ | ----------------------------------------------- | ------------------- |
| Page               | `public/**`, `src/**/page-*.mjs`                | navigateur          |
| Worker dédié       | `public/**/*worker*.mjs`, `src/**/*worker*.mjs` | Worker              |
| Service Worker     | `public/**/*-sw.mjs`                            | Service Worker      |
| Module partagé     | le reste de `src/**`                            | navigateur ∩ Worker |
| Node               | `tools/**`, `tests/unit/**`, `*.config.mjs`     | Node                |
| Spécification Node | `tests/browser/**`, `tests/compat/**`           | Node et navigateur  |

Trois conséquences pour un nouveau module :

- un module de `src/` est **partagé par défaut** : il ne reçoit que les globals communs à la page et
  au Worker. S'il est réservé à la page, son nom commence par `page-` ; s'il est chargé par un
  Worker, son nom contient `worker` ;
- les spécifications Playwright cumulent Node et navigateur parce que les rappels passés à
  `page.evaluate` sont analysés dans le même fichier que le corps du test. Cette exception est
  bornée à `tests/browser/` et `tests/compat/` ; elle ne doit pas être élargie par des commentaires
  `/* global */`, qui reviendraient à désactiver la règle ;
- un module réellement partagé entre la page et le Worker doit vivre sous `src/` pour recevoir
  l'intersection. `public/spike/origin/isolation-probe.mjs`, importé par la coquille comme par son
  Worker, reste analysé comme un script de page : la configuration y est plus permissive que
  nécessaire. C'est du code de spike, et le déplacer relève d'une tranche distincte.

`tests/unit/eslint-config.test.mjs` vérifie cette répartition en lintant des chemins virtuels : une
régression de la configuration fait échouer `npm run test:unit`, pas seulement le lint du jour.

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

## Machine virtuelle et backend de blocs

Les artefacts v86 et l'image de guest ne sont pas versionnés. Ils sont décrits par
`vendor/v86/MANIFEST.json` — nom, taille, empreinte SHA-256, licence, URL source — et récupérés dans
`vendor/v86/artefacts/`, dossier ignoré par git :

```sh
npm run vm:fetch      # télécharge ce qui manque, vérifie toutes les empreintes
npm run vm:check      # vérifie seulement, sans réseau
```

`vm:check` échoue si un artefact manque ou si son empreinte diffère : une mesure de VM ne provient
jamais d'un binaire non identifié. Environ 9,9 Mio sont transférés au premier appel.

```sh
npm run test:vm       # preuve « intégration VM » sous Chromium (périodique, hors `npm run check`)
npm run vm:protocol   # protocole de mesure complet sous Node → reports/vm/protocole.json
```

Le banc s'observe aussi à la main : `npm start`, puis `http://127.0.0.1:4173/vm/`. La page ne fait
rien elle-même ; elle démarre le Worker runtime et affiche son compte rendu. La console offre
`await bancVault.executer({ scenario: "filesystem", mode: "full" })`. `scenario` vaut `barrier` ou
`filesystem` ; `mode` vaut :

| Mode       | Comportement de v86                                                     |
| ---------- | ----------------------------------------------------------------------- |
| `observe`  | amont exact ; seules les commandes ATA sont journalisées                |
| `identify` | le disque annonce un cache d'écriture, mais la barrière reste chez v86  |
| `full`     | la barrière du guest atteint le backend et n'est acquittée qu'après lui |

Les trois modes existent parce que les deux ruptures mesurées par le spike #4 sont en série : sans
le mode intermédiaire, on ne saurait pas laquelle des deux corrections produit quel effet.

## Vérification avant une PR

```sh
npm run check
```

Cette commande est la référence locale et CI. Une nouvelle suite stable doit y être rattachée ou
documenter explicitement pourquoi elle reste périodique.
