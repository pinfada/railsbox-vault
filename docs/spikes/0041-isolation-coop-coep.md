# Spike #41 — protocole et mesures : l'isolation multi-origine est-elle exigée par la distribution ?

Ce document est le compte rendu d'expérience du spike #41. La décision qu'il porte est dans
l'[ADR 0010](../decisions/0010-isolation-multi-origine.md) ; ici ne figurent que la question,
l'environnement, les commandes, les résultats bruts et leur lecture.

## Question

`SharedArrayBuffer` et `Atomics.wait` n'existent qu'en contexte `crossOriginIsolated`. Le runtime
v86 épinglé par l'ADR 0003 en dépend-il ? Fonctionne-t-il sans, et à quel coût — premier boot, débit
disque, temps processeur ? Et qui, dans ce dépôt, exigerait l'isolation si on ne la posait pas ?

La question n'est pas rhétorique : `docs/compatibility.md` affirmait, sans mesure à l'appui, que «
la distribution de Vault devra donc imposer cette isolation ». Cette affirmation venait de la
disponibilité d'une primitive, non de son usage.

## Environnement

| Élément             | Valeur                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| Système             | Windows 11 Famille 10.0.26200, x64                                      |
| Node                | v24.14.0 (dépôt : `engines >=22.13 <25`, CI en 22)                      |
| Playwright          | 1.62.1                                                                  |
| Chromium            | 151.0.7922.34 (`HeadlessChrome`, révision Playwright)                   |
| Firefox             | révision Playwright, relevé dans le rapport                             |
| WebKit              | révision Playwright, build Windows                                      |
| Émulateur           | `v86@0.5.432`, amont `847e34d5499b17b90d2783d5342ddd243c753497`         |
| Guest               | `linux4.iso` — Linux 4 / Buildroot i386, BusyBox, `libata` + `ata_piix` |
| Mémoire de la VM    | 128 Mio                                                                 |
| Volume mesuré       | 16 Mio, disque IDE maître (`hda` → `/dev/sda`), backend **en mémoire**  |
| Contexte navigateur | Worker dédié de type module, origine de confiance, CSP de la coquille   |

Cette machine n'est **pas** l'environnement de référence de `docs/quality-attributes.md`. Les
mesures ci-dessous sont publiées comme celles du spike #4 : séparément, et sans s'y substituer.

Le backend est en mémoire et non sur OPFS, délibérément. Un backend OPFS ferait entrer la latence du
système de fichiers de l'hôte dans la mesure ; sa variance masquerait l'écart cherché, qui est
justement petit. La conséquence est déclarée : ce spike ne mesure pas le coût de l'isolation **sur
le chemin OPFS**. Il n'y a aucune raison connue qu'il diffère — OPFS et `FileSystemSyncAccessHandle`
ne dépendent pas de l'isolation, ce que `npm run test:vm` démontre déjà sur un serveur nu — mais ce
n'est pas mesuré ici.

## Les deux conditions

La seule variable est l'en-tête de réponse. La même page, le même Worker, les mêmes artefacts, le
même code de `src/vm/` sont servis par deux serveurs simultanés :

| Condition | Commande                                                                                 | En-têtes ajoutés                                                                                                    |
| --------- | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `nu`      | `node tools/serve.mjs --role shell --host 127.0.0.1 --port 4184`                         | aucun                                                                                                               |
| `isole`   | `node tools/serve.mjs --role shell --host 127.0.0.1 --port 4185 --cross-origin-isolated` | `Cross-Origin-Opener-Policy: same-origin`, `Cross-Origin-Embedder-Policy: require-corp` sur **toutes** les réponses |

L'option globale est nécessaire, et le spike #35 explique pourquoi : le paramètre
`?isolation=require-corp` ne pose la politique que sur la réponse qui la porte, et un module de
Worker chargé sans elle est refusé. Poser la politique partout est aussi la condition de production
qu'il faudrait tenir.

## Montage

```text
tools/isolation-inventaire.mjs             inventaire du code et des artefacts v86 épinglés
src/spike/mesure-memoire.mjs               instrument mémoire, partagé page ↔ Worker
public/spike/isolation/index.html + banc.mjs   coquille du banc, sans accès à l'émulateur
public/spike/isolation/runtime-worker.mjs  Worker runtime : v86 + backend, étapes chronométrées
playwright.isolation.config.mjs            deux serveurs simultanés, trois moteurs
tests/isolation/cout-isolation.spec.mjs    campagne entrelacée, témoins et relevés
```

Le Worker importe `src/vm/block-journal.mjs`, `fault-plan.mjs`, `guest-session.mjs`,
`memory-block-backend.mjs`, `v86-buffer-adapter.mjs` et `v86-flush-bridge.mjs` — c'est-à-dire le
runtime livré, sans réplique ni variante. Le banc du spike #4 (`public/vm/`) n'a pas été réutilisé
tel quel pour une seule raison : il rend des compteurs, pas des durées par étape, et la question
posée ici est un coût.

## Commandes

```sh
npm ci
npx playwright install chromium firefox webkit
npm run vm:fetch              # 5 artefacts v86, empreintes vérifiées
npm run isolation:inventaire  # → reports/isolation/inventaire.json
npm run test:isolation        # → reports/isolation/cout-isolation-<moteur>.json
```

`npm run test:isolation` est **hors** de `npm run check` : elle démarre de vrais guests Linux et
exige des artefacts tiers téléchargés, comme `npm run test:vm`.

Le nombre d'essais se règle par `VAULT_ISOLATION_ESSAIS` (défaut 4, plus un essai d'échauffement par
condition), les moteurs par `VAULT_MOTEURS`, et `VAULT_ISOLATION_ENTRELACEMENT=non` rejoue le
protocole en blocs dont la section suivante donne le résultat.

## Étapes chronométrées

Chaque essai démarre un guest neuf, puis exécute ces commandes dans l'ordre. La durée est prise côté
hôte, autour de l'aller-retour complet par la console série.

| Étape               | Commande du guest                                          | Ce qu'elle exerce                                                             |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------- |
| `ecriture-disque`   | `dd if=/dev/zero of=/dev/sda bs=65536 count=64 conv=fsync` | 4 Mio : adaptateur v86, backend, barrière                                     |
| `purge-caches`      | `sync; echo 3 > /proc/sys/vm/drop_caches`                  | non mesurée ; sans elle la lecture serait servie par le cache du noyau invité |
| `lecture-disque`    | `dd if=/dev/sda of=/dev/null bs=65536 count=64`            | 4 Mio : adaptateur v86, backend                                               |
| `cpu-copie-memoire` | `dd if=/dev/zero of=/dev/null bs=1048576 count=32`         | 32 Mio : émulation pure, bande passante                                       |
| `cpu-md5`           | `dd if=/dev/zero bs=65536 count=128 \| md5sum`             | 8 Mio : émulation pure, calcul entier                                         |

## Le protocole en blocs ne mesure pas ce qu'il croit mesurer

La première version du harnais mesurait les conditions **en blocs** : trois essais nus, puis trois
essais isolés. Elle a rendu, sous Chromium, un écart net, ample et cohérent — tout ce qu'un résultat
doit avoir pour être cru :

| Métrique            | Écart `isole` − `nu`, blocs, campagne du 19 h 26 |
| ------------------- | -----------------------------------------------: |
| Premier boot (p50)  |                                      **+17,6 %** |
| `lecture-disque`    |                                      **+28,8 %** |
| `cpu-copie-memoire` |                                      **+65,2 %** |
| `cpu-md5`           |                                      **+38,2 %** |

Le protocole en blocs n'a pas été jeté : il est **reproductible à la demande**, un témoin négatif
qu'on ne peut plus rejouer n'étant qu'une anecdote.

```sh
VAULT_MOTEURS=chromium VAULT_ISOLATION_ENTRELACEMENT=non npm run test:isolation
# → reports/isolation/cout-isolation-blocs-chromium.json
```

Rejoué ainsi, quatre essais par bloc, sur une machine cette fois occupée par un autre travail — ce
qui est déclaré parce que c'est le sujet même de cette section :

| Métrique            | Blocs, 19 h 26 | Blocs, rejeu | Entrelacé, campagne retenue |
| ------------------- | -------------: | -----------: | --------------------------: |
| Premier boot (p50)  |        +17,6 % |   **−3,0 %** |                  **+0,6 %** |
| Temps processeur    |     non relevé |   **−9,1 %** |                  **−0,5 %** |
| `cpu-md5`           |        +38,2 % |  **−20,1 %** |                  **−4,2 %** |
| `cpu-copie-memoire` |        +65,2 % |  **−19,6 %** |                  **+2,8 %** |

Le protocole en blocs **change de signe d'une exécution à l'autre**, et sur des amplitudes de vingt
à soixante-cinq points. Il ne mesure pas l'isolation : il mesure ce que la machine faisait pendant
la campagne, attribué à celle des deux conditions qui passait à ce moment-là. Le boot passe de 3 600
ms à 4 725 ms entre les deux exécutions en blocs, ce qui dit assez d'où vient l'« effet ».

Le harnais définitif **entrelace** les deux conditions et **inverse leur ordre un tour sur deux**.
L'ordre effectif et le protocole employé sont publiés dans `ordreEssais` et `protocole` de chaque
rapport. Les chiffres retenus, ci-dessous, sont ceux de la campagne entrelacée sur machine au repos.

## Inventaire : qui dépend de l'isolation ?

`npm run isolation:inventaire` lit deux sources : le code du dépôt (`src/`, `public/`, `tools/`,
`tests/`, `apps/`, configurations racine) et les artefacts v86 épinglés.

### Code du dépôt

**93 occurrences réparties sur 20 fichiers** au 2026-08-25. Toutes appartiennent à l'une de ces
trois catégories, et à aucune autre :

| Catégorie                    | Fichiers                                                                                                                                         | Nature                                     |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| Sonde de capacités (#2)      | `src/compat/capability-contract.mjs`, `page-probe.mjs`, `worker-probe.mjs`, `host-api.mjs`, `tests/compat/`, fixtures                            | **mesure**                                 |
| Sondes des spikes #35 et #41 | `public/spike/origin/isolation-probe.mjs`, `public/spike/isolation/*`, `tests/browser/origin-isolation.spec.mjs`, `tests/isolation/`             | **mesure**                                 |
| Serveur de test et journal   | `tools/serve.mjs`, `tools/serve-headers.mjs`, `tools/isolation-inventaire.mjs`, `public/vm/runtime-worker.mjs`, `tests/vm/premier-boot.spec.mjs` | **en-têtes servis, ou valeur journalisée** |

**Aucun module de production n'alloue de `SharedArrayBuffer`, n'appelle `Atomics`, ni ne branche un
comportement sur `crossOriginIsolated`.** Les trois occurrences de `crossOriginIsolated` dans
`public/vm/runtime-worker.mjs` sont des champs de compte rendu : le runtime consigne la valeur, il
n'en dépend pas.

### v86 épinglé

| Artefact     | Constat                                                                                                     |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `libv86.mjs` | `SharedArrayBuffer` : **0** · `Atomics` : **0** · `crossOriginIsolated` : **0**                             |
| `v86.wasm`   | une seule mémoire déclarée, drapeaux **`0x00`** — donc **non partagée** —, 146 pages minimum, aucun maximum |
| `v86.wasm`   | mémoires **importées : 0**                                                                                  |

Le second constat est le décisif, et il n'est pas textuel. Un module WebAssembly ne peut recevoir un
`SharedArrayBuffer` que s'il déclare ou importe une mémoire `shared` : c'est le bit 1 du drapeau de
limites qui le dit. Il vaut zéro. `v86@0.5.432` est donc **structurellement incapable** d'utiliser
l'isolation, quels que soient les en-têtes servis. Un `grep` seul n'aurait pas établi cela ; c'est
pourquoi l'inventaire analyse le binaire.

L'analyseur est écrit à la main — le dépôt n'a pas de dépendance WebAssembly — et son relevé est
donc recoupé avec le moteur lui-même :

```sh
node -e "const b=require('fs').readFileSync('vendor/v86/artefacts/v86.wasm');
WebAssembly.compile(b).then(m=>console.log(
  WebAssembly.Module.imports(m).length,
  WebAssembly.Module.imports(m).filter(i=>i.kind==='memory').length))"
→ 22 0
```

Vingt-deux imports, dont **zéro** de genre `memory` : c'est exactement ce que rend
`isolation-inventaire.mjs`. La taille de la section `memory` le confirme aussi arithmétiquement — 4
octets, soit un compteur, un drapeau et un minimum de 146 sur deux octets LEB128 : il n'y a pas la
place pour un maximum, donc pas de drapeau `shared`, qui l'exigerait.

## Résultats

Campagne du **2026-08-25**, quatre essais par condition après un essai d'échauffement, conditions
entrelacées. Rapports bruts : `reports/isolation/cout-isolation-<moteur>.json`.

### Témoin d'isolation — les trois moteurs

Ce tableau ne mesure pas v86 : il vérifie que les deux conditions sont bien deux conditions. Il est
relevé même là où le runtime ne démarre pas, et c'est justement ce qui permet de dire que le trou de
mesure est ailleurs.

| Moteur                | Contexte | `crossOriginIsolated` nu / isolé | `SharedArrayBuffer` nu / isolé   |
| --------------------- | -------- | -------------------------------- | -------------------------------- |
| Chromium 151 headless | document | `false` / `true`                 | absent / constructeur présent    |
| Chromium 151 headless | Worker   | `false` / `true`                 | constructeur absent / **alloue** |
| Firefox 153           | document | `false` / `true`                 | absent / constructeur présent    |
| Firefox 153           | Worker   | `false` / `true`                 | constructeur absent / **alloue** |
| WebKit 26.5           | document | `false` / `true`                 | absent / constructeur présent    |
| WebKit 26.5           | Worker   | `false` / `true`                 | constructeur absent / **alloue** |

L'isolation est donc réellement obtenue, page **et** Worker, sur les trois moteurs — y compris ceux
où le guest ne tourne pas. Le résultat du spike n'est pas « nous n'avons pas su isoler ».

### Coût mesuré — Chromium 151 headless

`HeadlessChrome/151.0.7922.34`. Ordre effectif des essais comptés :
`isole, nu, nu, isole, isole, nu, nu, isole`.

| Métrique                             |                            Condition nue | Condition isolée | Écart isolé − nu |
| ------------------------------------ | ---------------------------------------: | ---------------: | ---------------: |
| Premier boot, p50                    |                               3 600,3 ms |       3 620,6 ms |       **+0,6 %** |
| Premier boot, p95                    |                               3 621,1 ms |       3 629,3 ms |                — |
| Temps processeur du rendu, p50 (CDP) |                                   21,4 s |           21,3 s |       **−0,5 %** |
| Chargement des artefacts, p50        |                                  51,3 ms |          58,1 ms |          +13,3 % |
| `ecriture-disque` 4 Mio, p50         |                                 301,6 ms |         344,2 ms |          +14,1 % |
| `ecriture-disque`, débit p50         |                               12,4 Mio/s |       11,1 Mio/s |                — |
| `lecture-disque` 4 Mio, p50          |                                 122,9 ms |         140,7 ms |          +14,5 % |
| `lecture-disque`, débit p50          |                               28,4 Mio/s |       28,4 Mio/s |                — |
| `cpu-copie-memoire` 32 Mio, p50      |                                  60,6 ms |          62,3 ms |           +2,8 % |
| `cpu-md5` 8 Mio, p50                 |                                 480,2 ms |         460,1 ms |       **−4,2 %** |
| Compteurs du journal de blocs        | `read 36, write 8, flush 1, flush-ack 1` |       identiques |            **0** |

Essais bruts, pour que la dispersion soit lisible :

| Métrique            | Essais nus (ms)                   | Essais isolés (ms)                |
| ------------------- | --------------------------------- | --------------------------------- |
| Premier boot        | 3564,8 · 3600,3 · 3621,1 · 3605,5 | 3629,3 · 3620,6 · 3469,3 · 3622,9 |
| `ecriture-disque`   | 321,6 · 300,6 · 341,0 · 301,6     | 301,3 · 344,2 · 361,0 · 362,9     |
| `lecture-disque`    | 141,0 · 141,7 · 121,9 · 122,9     | 140,7 · 121,7 · 140,7 · 180,8     |
| `cpu-copie-memoire` | 61,7 · 60,6 · 60,1 · 80,3         | 65,2 · 80,6 · 60,8 · 62,3         |
| `cpu-md5`           | 420,7 · 521,4 · 480,2 · 521,6     | 480,3 · 446,5 · 460,1 · 520,1     |

### La résolution des étapes est de 20 ms, et cela suffit à expliquer les écarts à deux chiffres

Une durée d'étape est prise autour d'un aller-retour par la console série, et
`src/vm/guest-session.mjs` scrute cette console toutes les **20 ms** (`POLL_INTERVAL_MS`). Les
durées observées le montrent sans ambiguïté : 300,6 · 301,3 · 301,6 · 321,6 · 341,0 · 344,2 · 361,0
· 362,9 — des paliers de 20 ms.

Sur `ecriture-disque`, +14,1 % vaut **42 ms**, soit deux paliers. Sur `lecture-disque`, +14,5 % en
vaut **18**, soit un. Ces écarts sont **sous la résolution utile de l'instrument**, et le signe le
confirme : la campagne précédente, également entrelacée, donnait −12 % sur la même étape
`ecriture-disque`. Un effet qui change de signe d'une campagne à l'autre n'est pas un effet.

Les deux métriques qui ne subissent pas cette quantification disent la même chose plus proprement :

- le **premier boot** dure cent quatre-vingts paliers, donc un palier y pèse 0,6 % : l'écart mesuré
  (+0,6 %) vaut exactement un palier ;
- le **temps processeur** vient du protocole DevTools et n'est pas quantifié du tout : **−0,5 %**.

### L'instrument de mesure mémoire, dans les quatre combinaisons

C'était le seul gain identifié à poser l'isolation — le spike #4 avait échoué à mesurer la mémoire
faute de `performance.measureUserAgentSpecificMemory`. Relevé sous Chromium 151 headless :

| Contexte | Condition | Résultat                                                                                          |
| -------- | --------- | ------------------------------------------------------------------------------------------------- |
| document | nue       | `measureUserAgentSpecificMemory absente de ce contexte`                                           |
| document | isolée    | **exposée, mais** `SecurityError: … performance.measureUserAgentSpecificMemory is not available.` |
| Worker   | nue       | absente                                                                                           |
| Worker   | isolée    | **absente**                                                                                       |

Deux lectures, et la seconde est la plus utile. L'isolation **expose** bien la méthode au document,
ce qui confirme qu'elle est bien la condition d'accès. Mais elle ne la rend pas utilisable ici, et
surtout elle ne la fait pas apparaître **dans le Worker**, c'est-à-dire là où le runtime vit et où
la mémoire de la VM se trouve. Poser l'isolation n'aurait donc rien rendu au budget mémoire de
`docs/quality-attributes.md`.

`performance.memory`, de son côté, rend `usedJSHeapSize: 10 000 000` exactement — dans les deux
conditions. La quantification grossière de Chromium n'est pas levée par l'isolation.

## Ce qui n'a pas pu être mesuré, et pourquoi

### Firefox 153 — le thread du Worker ne rend plus la main

Firefox charge le Worker, expose `scheduler.postTask`, obtient l'isolation dans les deux contextes
et alloue un `SharedArrayBuffer` sous COOP/COEP. Puis le guest ne rend rien pendant 180 s, **dans
les deux conditions**.

Le pouls du Worker tranche le diagnostic. Le Worker émet un battement toutes les 250 ms depuis
l'instant où le boot commence ; la page les compte. Relevé :

| Condition | Battements reçus en 180 s |
| --------- | ------------------------: |
| nue       |                     **0** |
| isolée    |                     **0** |

Zéro. Pas même le premier, ni le délai de garde interne de `guest-session.mjs` (240 s), qui repose
lui aussi sur un `setInterval`. Ce n'est donc pas un guest lent : **le thread du Worker cesse
entièrement de rendre la main dès que v86 démarre sous Firefox**. Le défaut est identique avec et
sans isolation ; il n'a rien à voir avec la question de ce spike, et il rejoint la case « non mesuré
(#4) » de `docs/compatibility.md`. Il vaut une issue à lui seul.

### WebKit 26.5 — pas de boucle d'ordonnancement sous la CSP de la coquille

Raison typée, rendue par le Worker avant tout démarrage :

```text
scheduler.postTask est absent de ce moteur : sous la CSP de la coquille (worker-src 'self'),
v86 n'a aucune boucle d'ordonnancement disponible. Voir l'ADR 0003 et docs/compatibility.md.
```

C'est exactement le constat du spike #4, et c'est l'objet de #52 — pas de #41. Le témoin
d'isolation, lui, est relevé : WebKit isole et alloue un `SharedArrayBuffer` comme les deux autres.

### Le chemin OPFS

Le backend mesuré est en mémoire, pour la raison donnée plus haut. Le coût de l'isolation **sur le
chemin OPFS** n'est donc pas mesuré ici. Ce que l'on sait par ailleurs : `npm run test:vm` fait lire
et écrire un vrai guest sur un volume OPFS, avec barrière de durabilité acquittée, sur un serveur
**sans** en-tête d'isolation — `playwright.vm.config.mjs` ne passe pas `--cross-origin-isolated`.
L'absence d'isolation ne bloque donc pas OPFS ; son éventuel coût sur ce chemin reste à mesurer si
la question se pose.

### `Cross-Origin-Embedder-Policy: credentialless` et l'injection par Service Worker

Ni l'un ni l'autre n'a été prototypé. Ce sont deux mécanismes pour **poser** l'isolation, et la
décision est de ne pas la poser ; les mesurer aurait été produire une preuve sans décision à
soutenir. L'ADR 0010 les compare sur leurs propriétés connues et l'issue de suivi dit ce qu'il
faudrait mesurer si l'isolation redevenait nécessaire.

### L'iframe applicative sous `require-corp`

Déjà mesurée par le spike #35 et non refaite ici : sous `require-corp`, une iframe inter-origine
sans COEP est refusée (`net::ERR_BLOCKED_BY_RESPONSE`) sur les trois moteurs ; Chromium ne transmet
pas l'isolation au cadre, WebKit la lui accorde, et Firefox n'a pas chargé le cadre dans ces
conditions. Voir `docs/spikes/0035-topologie-origine-de-confiance.md`.

## Lecture

**Personne n'utilise l'isolation.** L'inventaire ne trouve aucun consommateur dans le dépôt, et v86
épinglé est structurellement incapable d'en être un : sa mémoire WebAssembly n'est pas partagée.

**Le runtime complet fonctionne sans elle**, et pas seulement « démarre » : il boote un vrai guest
Linux, écrit 4 Mio sur un disque IDE adossé au backend Vault, franchit sa barrière de durabilité et
la voit acquittée, avec des compteurs de blocs identiques à ceux de la condition isolée.

**Le coût de la poser n'est pas mesurable avec cet instrument.** +0,6 % sur le boot, −0,5 % sur le
temps processeur. Les écarts à deux chiffres sur les étapes valent un ou deux paliers de 20 ms et
changent de signe d'une campagne à l'autre. Ce n'est pas « l'isolation est gratuite » : c'est «
aucun coût de premier ordre n'apparaît ici ».

**Le seul bénéfice attendu ne se matérialise pas.** L'instrument de mesure mémoire reste
inutilisable dans le document et absent du Worker, isolation ou non.

**Un protocole négligent aurait conclu n'importe quoi**, avec des chiffres nets et une histoire
plausible — +17,6 % une fois, −3,0 % la fois suivante, sur la même question. C'est le second
résultat de ce spike, et il ne concerne pas COOP/COEP.

La décision est dans l'[ADR 0010](../decisions/0010-isolation-multi-origine.md).
