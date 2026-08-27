# Spike #45 — protocole et mesures : où publier les deux origines, et comment vérifier ce qui est servi ?

Ce document est le compte rendu d'expérience du spike #45. La décision qu'il porte est dans
l'[ADR 0017](../decisions/0017-chaine-de-publication.md) ; ici ne figurent que les questions,
l'environnement, les commandes, les résultats bruts et leur lecture.

## Questions

L'[ADR 0002](../decisions/0002-topologie-origine-de-confiance.md) impose **deux origines** et
renvoie explicitement le choix de leur hébergement à #45.
L'[ADR 0010](../decisions/0010-isolation-multi-origine.md) y ajoute une **exigence différée** —
servir `Cross-Origin-Opener-Policy: same-origin` sur l'origine de confiance — en demandant à #45 «
de trancher explicitement l'une des deux voies, ou de consigner qu'elle renonce à COOP et pourquoi
», avec pour preuve attendue un témoin `window.opener === null`. `docs/release-policy.md` exige
enfin un « inventaire des artefacts et empreintes de contenu », une « procédure de rollback testée »
et l'exclusion des surfaces de mesure, en notant que « la liste des chemins publiés est une décision
de publication, tranchée par #45 ».

Quatre questions, donc :

1. **Un `<meta http-equiv>` peut-il porter la CSP de l'ADR 0013 ?** Si oui, GitHub Pages — qui ne
   sert aucun en-tête personnalisé — reste en course sans contorsion.
2. **Deux origines chez un hébergeur à suffixe public sont-elles deux origines, ou deux SITES ?** La
   distinction gouverne le partitionnement, les cookies et `SameSite`.
3. **Que faut-il inscrire dans l'inventaire pour que `SEC-UPDATE-001` ait prise sur ce qui est servi
   ?** L'invariant exige que « runtime et application soient identifiés et vérifiés ».
4. **COOP tient-il sa promesse, et sur quels moteurs ?**

## Environnement

| Élément    | Valeur                                                          |
| ---------- | --------------------------------------------------------------- |
| Système    | Windows 11 Famille 10.0.26200, x64                              |
| Node       | v24.14.0 (dépôt : `engines >=22.13 <25`, CI en 22)              |
| Playwright | 1.62.1                                                          |
| Chromium   | 151.0.7922.34                                                   |
| Firefox    | 153.0                                                           |
| WebKit     | 26.5                                                            |
| Émulateur  | `v86@0.5.432`, amont `847e34d5499b17b90d2783d5342ddd243c753497` |
| Réseau     | relevés d'hébergement du 2026-08-27 (heure UTC dans le rapport) |
| Commit     | `b2f4225` pour les empreintes citées ci-dessous                 |

Comme partout dans ce dépôt, les deux origines de test sont `127.0.0.1` et `localhost` : deux
origines distinctes au sens du navigateur, toutes deux contextes sécurisés, sans DNS ni certificat.

## Montage

```text
tools/publier-arborescences.mjs      ce qui est publié par origine, et ce qui en est retiré
tools/publier-en-tetes.mjs           en-têtes de production, dérivés de tools/serve-headers.mjs
tools/publier-sources.mjs            arbre de travail ou commit ; épinglage v86
tools/publier-inventaire.mjs         empreintes, empreinte de racine, comparaison
tools/publier.mjs                    construction et vérification (CLI)
tools/publier-servir.mjs             sert un arbre publié EN APPLIQUANT son `_headers`
tools/publier-temoin.mjs             témoin d'en-têtes et de `window.opener`
tools/publier-sonde-meta-csp.mjs     ce qu'un <meta http-equiv> applique, et ce qu'il ignore
tools/publier-sonde-hebergement.mjs  en-têtes réellement servis, Public Suffix List
tests/unit/publication-*.test.mjs    épreuves de l'inventaire et des décisions de publication
.github/workflows/publication.yml    chaîne complète, `workflow_dispatch` seulement
```

## Relevé 1 — ce qu'un `<meta http-equiv>` CSP peut et ne peut pas

```sh
VAULT_MOTEURS=chromium,firefox,webkit node tools/publier-sonde-meta-csp.mjs
```

Chaque relevé porte son témoin. Un cadre est tenu pour chargé quand le document encadré **annonce**
lui-même son chargement par `postMessage` : l'ADR 0010 a relevé que trois moteurs rendent trois
signatures de refus différentes, et que Firefox n'en rend aucune que Playwright puisse voir.
L'absence d'annonce, elle, se lit partout de la même façon.

Relevé **identique sur les trois moteurs** :

| Sonde                                             | Résultat                                                   | Lecture                                                            |
| ------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------ |
| `frame-ancestors 'none'` dans un `<meta>`         | **cadre CHARGÉ**                                           | la directive est **ignorée**                                       |
| `frame-ancestors 'none'` en en-tête (même page)   | cadre refusé                                               | témoin : la sonde de cadre fonctionne                              |
| `<meta http-equiv="Cross-Origin-Opener-Policy">`  | **`window.opener` survit**                                 | COOP n'est pas exprimable par `<meta>`                             |
| `script-src 'self'` — script en ligne             | refusé                                                     | un `<meta>` CSP applique bien cette directive-là                   |
| `script-src 'self'` — script externe de l'origine | exécuté                                                    | témoin : la page n'est pas simplement morte                        |
| script placé **AVANT** le `<meta>`                | **exécuté**                                                | un `<meta>` ne couvre pas ce qui le précède dans le flux d'analyse |
| script placé après le `<meta>`                    | refusé                                                     | la politique s'applique à partir de son analyse                    |
| `sandbox allow-scripts` dans un `<meta>`          | origine `http://127.0.0.1:4196`, `localStorage` accessible | la directive est ignorée : l'origine ne devient pas opaque         |

Trois conséquences, et elles sont décisives pour la question 1 :

- la CSP de la coquille contient `frame-ancestors 'none'`. C'est **elle** qui rend la coquille non
  encadrable — l'ADR 0010 a corrigé l'attribution erronée à CORP. Un hébergement qui ne peut poser
  la politique qu'en `<meta>` **ne peut pas** obtenir cette propriété ;
- COOP n'est pas exprimable du tout par `<meta>`. Le témoin `window.opener` survit là où il est nul
  sous l'en-tête (relevé 4). La recommandation de l'ADR 0010 est donc hors de portée d'un `<meta>` ;
- même sur les directives qu'il applique, un `<meta>` est **ordre-dépendant** : ce qui précède la
  balise s'exécute. Une politique de sécurité qui dépend de la position d'une balise dans un
  document rendu par un outil de construction n'est pas une frontière.

## Relevé 2 — en-têtes réellement servis, et suffixes publics

```sh
node tools/publier-sonde-hebergement.mjs        # rapport : reports/publication/sonde-hebergement.json
node tools/publier-sonde-hebergement.mjs --hors-ligne
```

### En-têtes servis par des sites témoins (2026-08-27)

| Hébergeur (site témoin)                        | CSP                               | COOP   | CORP   | `nosniff` | HSTS    |
| ---------------------------------------------- | --------------------------------- | ------ | ------ | --------- | ------- |
| GitHub Pages (`squidfunk.github.io`, 200)      | absente                           | absent | absent | absent    | absent  |
| GitHub Pages (404 du service)                  | `default-src 'none'; style-src …` | absent | absent | absent    | absent  |
| Netlify (`docs.netlify.com`)                   | absente                           | absent | absent | absent    | présent |
| Cloudflare Pages (`developers.cloudflare.com`) | présente, propre au site          | absent | absent | `nosniff` | présent |
| Vercel (`vercel.com/docs`)                     | présente, propre au site          | absent | absent | `nosniff` | présent |

Ce que ce relevé établit est **étroit**, et il faut le dire : qu'un site témoin ne serve pas COOP
prouve que son propriétaire ne l'a pas configuré, pas que l'hébergeur en soit incapable. Ce qu'il
établit tout de même :

- Cloudflare Pages, Netlify et Vercel servent des CSP **propres à chaque site** — la preuve
  observable qu'ils exposent un mécanisme de configuration d'en-têtes (`_headers` pour les deux
  premiers, `vercel.json` pour le troisième) ;
- la CSP relevée sur un **404** de GitHub Pages est celle du service, identique pour tous les
  dépôts, et aucune page servie en 200 ne porte d'en-tête de sécurité. Pages ne propose aucun
  mécanisme de configuration : un `_headers` déposé à la racine y est servi comme un fichier
  ordinaire. Ce fait n'est pas neuf — l'ADR 0010 le porte déjà — et le relevé le confirme sans le
  découvrir.

### Public Suffix List

La liste est **téléchargée** (`https://publicsuffix.org/list/public_suffix_list.dat`) et les entrées
cherchées littéralement, ligne exacte :

| Suffixe           | Inscrit à la PSL |
| ----------------- | ---------------- |
| `github.io`       | **oui**          |
| `pages.dev`       | **oui**          |
| `netlify.app`     | **oui**          |
| `vercel.app`      | **oui**          |
| `web.app`         | **oui**          |
| `firebaseapp.com` | **oui**          |

C'est le fait qui décide la question 2, et il coupe dans les deux sens :

- sur un domaine à suffixe public, `coquille.pages.dev` et `app.pages.dev` sont deux **sites**
  distincts (`eTLD+1` différents), donc a fortiori deux origines. Le partitionnement de stockage par
  site, les cookies `SameSite=Lax` et le partitionnement des cookies tiers les séparent aussi ;
- sur un **domaine propre**, `vault.exemple` et `app.vault.exemple` sont deux origines mais **le
  même site**. Les conséquences, qui doivent être écrites parce qu'elles ne sont pas intuitives :
  - **OPFS, IndexedDB, Web Locks, `BroadcastChannel`, Cache** restent cloisonnés par **origine** —
    c'est la mesure de l'ADR 0002, et elle ne change pas. La frontière `SEC-ORIGIN-001` tient ;
  - **les cookies, eux, ne le sont pas.** Un cookie posé sur `.vault.exemple` par l'un est envoyé à
    l'autre, et `SameSite=Lax` ou `Strict` ne les sépare pas : ils raisonnent en sites. Une session
    Rails posée sur le domaine parent serait donc visible de la coquille — et réciproquement ;
  - le **partitionnement des cookies tiers** et les heuristiques anti-pistage traitent les deux
    comme un seul site, ce qui est un confort ici plutôt qu'un risque.

Cette dernière ligne est du travail découvert : l'ADR 0002 avait laissé « l'allocation des cookies
et du bocal de session entre les deux origines » explicitement **hors décision**, réservée à #24. Le
choix d'un domaine propre lui donne une contrainte de plus, écrite dans l'ADR 0017.

## Relevé 3 — inventaire, altération, retour arrière

### Construction

```sh
npm run vm:fetch
node tools/publier.mjs --commit HEAD
```

```text
Commit publié : b2f42259deb5a9397d5c07fb607abb47ca4b67f9 (HEAD)
Arbre « coquille »
  origine        https://vault.exemple
  fichiers       77
  racine         4592da46ac741b014fb1ea0cb883ab4103053b541afc8abd79c5df8bd6147008
  complet        oui
  épinglage v86  conforme au MANIFEST
Arbre « application »
  origine        https://app.vault.exemple
  fichiers       2
  racine         293a7899cb9417fa54d61f7a70795350e26216844fe3638250b240c1a8c54277
  complet        oui
```

Sans `npm run vm:fetch`, la même commande rend 72 fichiers, `complet NON` et nomme la source absente
: une publication incomplète est **déclarée**, jamais silencieuse.

L'origine applicative porte **deux** fichiers : son `_headers` et une place tenante déclarée. Ce
n'est pas un oubli — l'ADR 0002 dit que « le HTML applicatif est produit par le guest et relayé par
le proxy ». Ce que cette origine publie aujourd'hui, c'est sa **configuration**.

### Détection d'une altération

```sh
cp -r artifacts/publication/coquille artifacts/altere
echo "// injection" >> artifacts/altere/main.mjs
node tools/publier.mjs --verifier artifacts/altere   # code de sortie 1
```

```text
ÉCARTS :
  ALTÉRÉ    main.mjs
            attendu bea3c62e8034a1307c2428fe2ec88f0c593701ed76018032e4d29fc617e5e2fd (686 o)
            mesuré  f8bc316df56c55ce7e0596ff1cce5099558e6d5f2534248e2608864d47c9c974 (699 o)
  RACINE    attendue 4592da46ac741b014fb1ea0cb883ab4103053b541afc8abd79c5df8bd6147008
            mesurée  57fe9a791d1d31db19c18d18fc05494313c383843779bfdd3891e9558d9a1ef5
```

Les trois natures d'écart — altéré, ajouté, manquant — et le cas du **renommage** (contenu total
inchangé, empreinte de racine changée) sont éprouvées en unitaire par
`tests/unit/publication-inventaire.test.mjs`, sur des arbres jetables.

### Retour arrière

```sh
node tools/publier.mjs --commit HEAD~1 --sortie artifacts/pub-precedent
node tools/publier.mjs --commit HEAD~1 --sortie artifacts/pub-precedent-bis
```

| Reconstruction            | Empreinte de racine de la coquille                                 |
| ------------------------- | ------------------------------------------------------------------ |
| `HEAD~1` (`41dfe10`), 1ʳᵉ | `3f13158f5994cd9958968968a2c96bdf6d3b94f271fa87ea09cce3eee58ef6bb` |
| `HEAD~1` (`41dfe10`), 2ᵉ  | `3f13158f5994cd9958968968a2c96bdf6d3b94f271fa87ea09cce3eee58ef6bb` |
| `HEAD` (`b2f4225`)        | `4592da46ac741b014fb1ea0cb883ab4103053b541afc8abd79c5df8bd6147008` |

Deux reconstructions du même commit rendent la **même** empreinte de racine, au bit près, et une
version différente en rend une différente. C'est ce qui fait de « republier la version précédente »
une opération définie plutôt qu'une intention. `--commit` lit les octets par `git show` : un outil
qui recopierait l'arbre de travail en changeant l'étiquette republierait la version défaillante sous
le nom de la précédente.

### Ce que l'inventaire donne à `SEC-UPDATE-001`

L'invariant exige que « runtime et application soient identifiés et vérifiés avant d'ouvrir le
volume en écriture ». Le manifeste de volume (ADR 0007) nomme déjà les trois identités, mais il
nomme des **versions**, pas des octets. La publication ajoute deux liens :

- `inventaire.json` porte l'empreinte de **chaque** fichier servi, plus l'empreinte de racine de
  l'arbre, liée au commit ;
- la construction relit `vendor/v86/MANIFEST.json` **dans l'arbre publié** et confronte chaque
  artefact v86 copié à son empreinte épinglée (`épinglage v86 conforme au MANIFEST` ci-dessus). Le
  runtime servi au navigateur est donc vérifié comme tel, et pas seulement dans le dépôt.

Ce que le code **ne** décide pas ici, et qui est posé à l'ADR 0017 : faut-il inscrire l'empreinte de
racine de la coquille **dans** le manifeste de volume, pour qu'un volume porte la trace du runtime
qui l'a écrit ? C'est une question de format persistant ; elle ne se tranche pas dans un outil de
construction.

## Relevé 4 — témoin d'en-têtes, et COOP

```sh
node tools/publier.mjs --origine-application http://localhost:4194
VAULT_MOTEURS=chromium,firefox,webkit node tools/publier-temoin.mjs
```

Le témoin sert les **arbres publiés** — pas le dépôt — par un serveur qui applique le `_headers`
qu'ils portent, et confronte les en-têtes reçus à ceux que l'inventaire déclare. Le témoin
**négatif** sert le **même** arbre sur un troisième port, COOP retiré : la seule variable est
l'en-tête.

Relevé **identique sur les trois moteurs** :

| Relevé                                           | Chromium 151 | Firefox 153 | WebKit 26.5 |
| ------------------------------------------------ | ------------ | ----------- | ----------- |
| en-têtes de la coquille conformes à l'inventaire | oui          | oui         | oui         |
| en-têtes de l'origine applicative conformes      | oui          | oui         | oui         |
| CSP absente de l'origine applicative (ADR 0002)  | oui          | oui         | oui         |
| la coquille démarre (`worker:ready`)             | oui          | oui         | oui         |
| `window.opener` **avec** COOP                    | **`null`**   | **`null`**  | **`null`**  |
| `window.opener` **sans** COOP (témoin négatif)   | survit       | survit      | survit      |

La fenêtre est ouverte par `window.open` depuis un document de **l'autre origine** : c'est
exactement la relation que COOP gouverne et que `frame-ancestors` ne couvre pas. La preuve que l'ADR
0010 avait nommée est donc produite, et sur les trois moteurs — davantage que ce qu'il demandait.

Le témoin ne rejoue **pas** la frontière de CSP : `tests/browser/csp-frontiere.spec.mjs` la mesure
déjà sur les trois moteurs à chaque `npm run check`, et la dupliquer ferait deux vérités.

## Relevé 5 — la chaîne, rejouée à la main

`.github/workflows/publication.yml` est en `workflow_dispatch`, et GitHub **ne dispatche que les
workflows présents sur la branche par défaut** : tant que ce spike n'est pas fusionné,
`gh workflow run publication.yml --ref spike/chaine-de-publication` rend un
`HTTP 404: workflow publication.yml not found on the default branch`. Le workflow n'a donc **pas**
de run à montrer, et c'est une limite de la plateforme, pas du travail.

À défaut, sa séquence d'étapes est rejouée à l'identique en local, commandes comprises :

```text
=== Construction ===
=== Vérification ===
Arbre « coquille » — 77 fichiers, commit 47869aa
Conforme. Empreinte de racine 4592da46ac741b014fb1ea0cb883ab4103053b541afc8abd79c5df8bd6147008
Arbre « application » — 2 fichiers, commit 47869aa
Conforme. Empreinte de racine 293a7899cb9417fa54d61f7a70795350e26216844fe3638250b240c1a8c54277
=== Empreintes de racine ===
coquille    4592da46ac741b014fb1ea0cb883ab4103053b541afc8abd79c5df8bd6147008
application 293a7899cb9417fa54d61f7a70795350e26216844fe3638250b240c1a8c54277
=== Retour arrière (vers 3700177) ===
reconstruction A : 4592da46ac741b014fb1ea0cb883ab4103053b541afc8abd79c5df8bd6147008
reconstruction B : 4592da46ac741b014fb1ea0cb883ab4103053b541afc8abd79c5df8bd6147008
ROLLBACK REPRODUCTIBLE
```

Une observation à ne pas prendre pour une erreur : le retour arrière vers `3700177` rend **la même**
empreinte de racine que `47869aa`. C'est correct, et c'est une propriété. Le commit intermédiaire ne
touche que `docs/`, `.github/` et `eslint.config.mjs` — rien de publié. **Un changement qui ne
modifie aucun octet servi ne change pas l'arbre publié**, et deux versions du dépôt peuvent donc
partager une empreinte de racine. Le commit, lui, diffère dans l'inventaire : l'identité de la
version n'est pas confondue avec celle des octets.

## Comparatif — mesuré et documentaire

Ce qui est **mesuré** est marqué comme tel ; le reste est documentaire et cité.

| Critère                                            | GitHub Pages                                                | Cloudflare Pages / Netlify (`_headers`)                  | Vercel (`vercel.json`)                    | Hébergeur statique + reverse proxy, domaine propre |
| -------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------- | ----------------------------------------- | -------------------------------------------------- |
| CSP de l'ADR 0013 servie en en-tête                | **non** (mesuré : aucun en-tête de sécurité sur un 200)     | oui (mesuré : CSP propre au site)                        | oui (mesuré)                              | oui                                                |
| … par `<meta>` à défaut                            | **non** : `frame-ancestors` ignoré (mesuré, 3 moteurs)      | sans objet                                               | sans objet                                | sans objet                                         |
| COOP `same-origin` sur la coquille                 | **non** (inexprimable en `<meta>`, mesuré)                  | oui                                                      | oui                                       | oui                                                |
| CORP par origine                                   | non                                                         | oui                                                      | oui                                       | oui                                                |
| Deux origines distinctes                           | oui, au prix d'un domaine propre ou d'un second compte      | oui                                                      | oui                                       | oui                                                |
| Deux **sites** distincts sur le domaine par défaut | oui — `github.io` à la PSL (mesuré)                         | oui — `pages.dev` / `netlify.app` à la PSL (mesuré)      | oui — `vercel.app` à la PSL (mesuré)      | **non** : sous-domaines d'un même site             |
| Cookies séparés entre les deux origines            | oui (sites distincts)                                       | oui                                                      | oui                                       | **non** : à traiter par #24                        |
| Coût                                               | gratuit ; domaine propre en sus                             | gratuit en offre de base ; domaine propre en sus         | gratuit en offre de base                  | hébergement + domaine + exploitation du proxy      |
| Retour arrière                                     | redéployer une branche                                      | redéploiement d'une version antérieure, natif            | idem                                      | redéposer l'arbre + recharger le proxy             |
| Verrouillage fournisseur                           | faible (fichiers statiques)                                 | faible : `_headers` est une convention partagée par deux | moyen : `vercel.json` est propre à Vercel | nul                                                |
| Dépendance ajoutée à la frontière de confiance     | **oui si Service Worker injectant les en-têtes** (ADR 0010) | non                                                      | non                                       | non                                                |

Motifs factuels d'élimination :

- **GitHub Pages pour l'origine de confiance** — éliminé sur mesure. La coquille doit
  `frame-ancestors 'none'` (ADR 0013, ADR 0010) et cette directive est **ignorée** dans un `<meta>`
  sur les trois moteurs. Le seul contournement connu, un Service Worker qui réécrit les en-têtes,
  ajoute du code privilégié **dans** la frontière que #24 doit prouver, et n'isole pas le premier
  chargement. Pages reste en revanche parfaitement viable pour le **territoire applicatif**, qui ne
  reçoit aucune CSP par décision de l'ADR 0002 — mais y publier l'application ferait perdre le
  bénéfice de la lisibilité du domaine propre.
- **Vercel** — non éliminé, mais classé après : `vercel.json` n'a pas d'équivalent ailleurs, là où
  `_headers` est lu à l'identique par deux hébergeurs indépendants. Un fichier de configuration
  portable est, pour une chaîne de publication, une propriété de retour arrière.

## Limites de ce spike

1. **Aucun déploiement réel n'a été fait.** Les en-têtes de production sont éprouvés sur un serveur
   local qui applique le `_headers` produit. Que Cloudflare Pages ou Netlify servent exactement ces
   en-têtes à partir du même fichier est **documentaire**, pas mesuré : il faudrait un compte, un
   domaine et un déploiement, qui sont hors du périmètre de #45.
2. **Les sites témoins du relevé 2 ne nous appartiennent pas.** L'absence d'un en-tête y prouve un
   choix de leur propriétaire, pas une incapacité de l'hébergeur — sauf pour GitHub Pages, dont
   l'absence de mécanisme de configuration est un fait établi par ailleurs.
3. **`Cache-Control: no-store` est publié tel que le serveur de test le sert**, et c'est un problème
   nommé mais non résolu : il interdit toute mise en cache, alors que l'ADR 0002 prévoit **deux**
   Service Workers pour le mode hors ligne. Le sujet est du travail découvert, écrit dans
   l'ADR 0017.
4. **L'inventaire n'est pas signé.** Un adversaire qui réécrit un fichier de l'arbre réécrit
   l'inventaire qui l'accompagne. L'empreinte de racine n'a de valeur que **comparée hors bande** —
   d'où son dépôt en artefact séparé par `publication.yml`.
5. **Une seule machine.** Les témoins tournent sur les trois moteurs, mais sur un seul système.
6. **Le workflow n'a pas de run à montrer** tant qu'il n'est pas sur la branche par défaut (relevé
   5). Sa séquence est rejouée localement ; l'exécuter sur un exécutant GitHub — avec `npm ci`,
   `npm run vm:fetch` et les trois moteurs — reste à faire à la fusion.
