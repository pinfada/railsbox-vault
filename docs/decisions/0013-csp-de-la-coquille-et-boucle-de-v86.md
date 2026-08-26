# ADR 0013 — La CSP de la coquille garde `worker-src 'self'` ; la boucle de v86 est nommée, jamais devinée

- Statut : accepté
- Date : 2026-08-26 · amendé le 2026-08-26 (§ « Mise en œuvre par #74 »)
- Issue : #52, amendé par #74 · Invariants : `SEC-ORIGIN-001` · Jalon 5

## Contexte

L'[ADR 0002](0002-topologie-origine-de-confiance.md) sert à la coquille de confiance une CSP
stricte, dont chaque directive doit nommer une capacité. L'[ADR 0003](0003-backend-de-blocs-v86.md)
y a ajouté un seul jeton, `'wasm-unsafe-eval'`, et a laissé une question ouverte : v86 choisit sa
boucle d'ordonnancement à l'évaluation de son module, et son second chemin passe par un Worker
imbriqué créé depuis une URL `blob:` que `worker-src 'self'` refuse. Le spike #4 avait relevé que ce
refus est **silencieux** : l'émulateur ne bat jamais, sans erreur visible.

Deux faits rendaient la question non tranchable jusqu'ici :

1. **rien ne mesurait la CSP.** `tests/unit/origin-topology.test.mjs` vérifiait la CHAÎNE servie,
   jamais son effet dans un navigateur. Retirer `'wasm-unsafe-eval'` ne faisait rougir aucun test ;
2. **rien ne mesurait le démarrage sous une autre politique.** L'affirmation « `worker-src blob:`
   serait nécessaire à un moteur sans `scheduler.postTask` » n'avait jamais été éprouvée, ni dans un
   sens ni dans l'autre.

## Comment v86 choisit sa boucle

Lu dans l'artefact épinglé `v86@0.5.432` (`vendor/v86/artefacts/libv86.mjs`), à l'évaluation du
module et **une seule fois** :

```text
process défini                                        → setImmediate / setTimeout   (Node)
scheduler.postTask est une fonction
  ET location.href contient « use-scheduling-api »     → scheduler.postTask
Worker défini                                          → Worker imbriqué depuis blob:
sinon                                                  → setTimeout
```

Trois conséquences que la décision doit intégrer :

- le test porte sur `location.href` **du contexte qui importe le module**, par recherche de
  sous-chaîne : ce n'est pas la lecture d'un paramètre de requête ;
- dans un navigateur, `Worker` est toujours défini : le dernier repli `setTimeout` est **mort**.
  Faute de `postTask`, v86 va au Worker `blob:`, jamais ailleurs ;
- `register_yield()` est appelé **dans le constructeur** de la boucle, lui-même exécuté dans la
  chaîne asynchrone d'initialisation de `V86`. Un refus n'atteint donc aucun `try` de notre code.

## Ce que l'expérience a établi

Protocole : `npm run test:csp` (`playwright.csp.config.mjs`). Deux serveurs servent le **même**
contenu, leur CSP ne diffère que par une directive ; quatre configurations du contexte du Worker
sont croisées avec les deux politiques, sur les trois moteurs. Le Worker de mesure ne vérifie
**aucun** prérequis — il démarre v86 quoi qu'il arrive, pour observer la panne au lieu de la
postuler — et publie le compteur de tours `tick_counter` de v86, ce qui distingue un guest **lent**
d'un émulateur qui **ne bat pas**. Rapports bruts : `reports/csp/<moteur>.json`.

Mesures du **2026-08-26**, Windows 11, Chromium 151 / Firefox 153 / WebKit 26.5 (Playwright 1.62.1),
guest Linux 4 / Buildroot i386, délai de garde du boot 60 s, garde de la page 120 s.

### Sous `worker-src 'self'` — la politique servie

| Configuration du contexte du Worker           | Chromium 151                       | Firefox 153                                        | WebKit 26.5                        |
| --------------------------------------------- | ---------------------------------- | -------------------------------------------------- | ---------------------------------- |
| `?use-scheduling-api` (servie aujourd'hui)    | **invite à 3 461 ms**, 2 150 tours | **aucun compte rendu en 120 s**, thread monopolisé | **aucun progrès**, 1 tour, 60 s    |
| sans le marqueur (boucle de secours `blob:`)  | **aucun progrès**, 1 tour, 60 s    | **aucun progrès**, 1 tour, 60 s                    | **aucun progrès**, 1 tour, 60 s    |
| cale Vault posée si l'API manque              | invite à 3 508 ms (cale non posée) | aucun compte rendu en 120 s (cale non posée)       | **invite à 5 006 ms**, 1 031 tours |
| cale Vault posée même par-dessus l'API native | **invite à 3 644 ms**, 1 331 tours | **invite à 21 508 ms**, 2 042 tours                | **invite à 4 848 ms**, 1 012 tours |

### Sous `worker-src 'self' blob:` — la politique élargie

| Configuration du contexte du Worker          | Chromium 151          | Firefox 153                 | WebKit 26.5           |
| -------------------------------------------- | --------------------- | --------------------------- | --------------------- |
| `?use-scheduling-api`                        | invite à 3 418 ms     | aucun compte rendu en 120 s | invite à 4 917 ms     |
| sans le marqueur (boucle de secours `blob:`) | **invite à 3 601 ms** | **invite à 21 786 ms**      | **invite à 5 193 ms** |
| cale Vault posée si l'API manque             | invite à 3 560 ms     | aucun compte rendu en 120 s | invite à 4 670 ms     |
| cale Vault posée toujours                    | invite à 3 490 ms     | invite à 21 254 ms          | invite à 4 804 ms     |

Les deux relevés décisifs de Firefox ont été **reproduits** par une seconde exécution complète du
harnais : 21 719 ms pour la cale forcée sous `worker-src 'self'` (contre 21 508 ms), 21 612 ms pour
le Worker imbriqué sous `worker-src 'self' blob:` (contre 21 786 ms). Les quatre silences sont
reproduits à l'identique. L'écart entre les deux exécutions reste sous 1,5 %, et aucune conclusion
de cet ADR ne dépend d'une différence de cet ordre.

Quatre faits, dont trois n'étaient pas connus avant cette mesure :

1. **le refus d'un Worker `blob:` ne lève aucune exception.** `new Worker(blobUrl)` sous
   `worker-src 'self'` rend un objet, et cet objet ne fait rien. Le refus reste observable, mais par
   deux canaux qui n'interrompent pas l'appelant : un événement `securitypolicyviolation` sur le
   document et un événement `error` sur le Worker. C'est la cause mécanique du « sans erreur visible
   » de #52, et la raison pour laquelle un contrôle par `try/catch` conclurait « autorisé » ;
2. **v86 privé de boucle laisse un compteur figé à 1.** Il construit son contrôleur IDE, appelle
   `next_tick(0)` une fois, et s'arrête là. La seule erreur produite arrive au bout du délai de
   garde du guest — 240 s en configuration de production — et elle nomme « invite du guest non
   atteinte », c'est-à-dire une cause qui n'est pas la bonne ;
3. **`worker-src blob:` n'est pas la seule façon de couvrir la matrice.** Une boucle
   `scheduler.postTask` fournie par Vault, sur `MessageChannel`, fait battre v86 sur les **trois**
   moteurs sous la politique servie aujourd'hui, sans toucher à la CSP ;
4. **le blocage de Firefox (#74) n'a rien à voir avec la CSP.** C'est l'implémentation **native** de
   `scheduler.postTask` qui monopolise le thread du Worker : la remplacer par la cale de Vault fait
   démarrer le guest en 21,5 s, sous `worker-src 'self'` comme sous `worker-src 'self' blob:`. Le
   spike #41 avait le symptôme ; cette mesure a la cause.

## Ce que `blob:` dans `worker-src` ouvrirait, exactement

La question n'est pas « `blob:` est-il dangereux » — un `blob:` créé par la coquille est de **même
origine** — mais « quelle propriété la CSP tient-elle aujourd'hui et que perdrait-elle ».

Ce que la politique servie tient, **mesuré** par `tests/browser/csp-frontiere.spec.mjs` sur les
trois moteurs : sous `script-src 'self' 'wasm-unsafe-eval'`, un script `blob:`, un script `data:` et
un script inline ne s'exécutent pas. Le seul code JavaScript qui s'exécute sur l'origine de
confiance est donc celui que l'origine a **servi**. C'est une propriété d'**intégrité du code**,
distincte de la partition d'origine.

Ce que `worker-src 'self' blob:` retirerait : un script qui parviendrait à s'exécuter sur l'origine
de confiance pourrait alors faire tourner du code **qu'il compose lui-même** dans un Worker, au lieu
d'être réduit à enchaîner les modules déjà servis. Ce Worker est précisément le contexte qui détient
le handle OPFS exclusif, et qui détiendra la clé de volume en session.

Contre le modèle de menace de `SEC-ORIGIN-001`, la distinction compte :

- l'adversaire nommé — **du JavaScript hostile servi par Rails** — vit sur l'origine applicative. Il
  ne peut créer aucun `blob:` dans l'origine de confiance, et n'y exécute rien. `worker-src` ne
  change **rien** à sa portée : la frontière qui l'arrête est la partition d'origine de l'ADR 0002,
  mesurée par `tests/browser/origin-topology.spec.mjs` ;
- l'adversaire que `blob:` concerne est une **injection sur la coquille elle-même** — publication
  compromise (#45), ou défaut dans le code de la coquille. Il est explicitement hors du périmètre de
  l'ADR 0002 et relève de `SEC-UPDATE-001`.

Élargir `worker-src` ne rouvre donc aucune brèche fermée par #35, et ce serait malhonnête de le
prétendre. Ce que cela retirerait est une **défense en profondeur** sur l'adversaire suivant, celui
que #24 et #45 doivent encore traiter. C'est un coût réel mais borné, à mettre en regard d'un gain
réel : il faut donc peser, pas invoquer.

Deux garde-fous s'appliquent quelle que soit la décision, et sont éprouvés :

1. `blob:` ne doit **jamais** entrer dans `script-src`. `tests/browser/csp-frontiere.spec.mjs` exige
   qu'un script `blob:`, `data:` ou inline reste non exécuté sur les trois moteurs ;
2. la politique servie par défaut ne contient **aucune** occurrence de `blob:` tant que cet ADR le
   décide ainsi, ce que la même suite vérifie sur l'en-tête réellement servi, et
   `tests/unit/origin-topology.test.mjs` sur la chaîne produite.

## Décision

**La CSP de la coquille reste celle de l'ADR 0002 amendée par l'ADR 0003 :
`script-src 'self' 'wasm-unsafe-eval'` et `worker-src 'self'`. `blob:` n'entre ni dans `worker-src`,
ni — a fortiori — dans `script-src`.**

Parce que l'élargissement n'est pas nécessaire : le fait 3 montre qu'une boucle d'ordonnancement
fournie par Vault couvre les trois moteurs sous la politique actuelle. Entre deux options qui
couvrent la même matrice, la plus étroite l'emporte, et celle-ci ne coûte aucune directive.

**Et un refus cesse d'être silencieux.** Le Worker runtime contrôle son contexte AVANT de construire
l'émulateur et rend un code de `src/vm/runtime-errors.mjs` :

| Code                                   | Ce qu'il nomme                                                             |
| -------------------------------------- | -------------------------------------------------------------------------- |
| `VAULT_RUNTIME_WASM_REFUSED`           | la CSP du contexte ne nomme pas WebAssembly                                |
| `VAULT_RUNTIME_WORKER_REFUSED`         | v86 emprunterait sa boucle `blob:`, et ce Worker ne donne pas signe de vie |
| `VAULT_RUNTIME_SCHEDULING_UNAVAILABLE` | aucun des deux chemins d'ordonnancement n'existe dans ce contexte          |
| `VAULT_RUNTIME_NO_TICK`                | l'émulateur est construit et sa boucle n'a pas avancé en 20 s              |

Le contrôle **constate** au lieu d'affirmer : quand v86 emprunterait sa boucle de secours, il sonde
un Worker `blob:` réel et n'accuse la CSP que si ce Worker se tait. Sous une politique qui
admettrait `blob:`, il ne refuserait rien — son message ne peut donc pas mentir sur la politique
servie.

## Options comparées

| Option                                               | Chromium | Firefox | WebKit | Coût                                                                       | Retenue                                 |
| ---------------------------------------------------- | :------: | :-----: | :----: | -------------------------------------------------------------------------- | --------------------------------------- |
| 1. `worker-src 'self'` + `?use-scheduling-api`       |   oui    |   non   |  non   | nul                                                                        | **oui, pour la CSP**                    |
| 2. ajouter `blob:` à `worker-src`                    |   oui    |   oui   |  oui   | retire l'intégrité du code dans le contexte qui détiendra la clé de volume | non                                     |
| 3. cale Vault posée si l'API manque                  |   oui    |   non   |  oui   | un module, aucune directive de CSP touchée                                 | non (ne couvre pas Firefox)             |
| 3′. cale Vault posée toujours                        |   oui    |   oui   |  oui   | idem, plus le remplacement d'une API native par la nôtre                   | **oui, mais pas ici** — voir ci-dessous |
| 4. Worker imbriqué servi depuis un fichier de `self` |    —     |    —    |   —    | impossible sans reconstruire v86                                           | non                                     |

L'option 4 est écartée par une lecture de l'artefact épinglé, pas par principe : `register_yield()`
est appelé **dans le constructeur** de la boucle de v86, et ce constructeur s'exécute dans la chaîne
d'initialisation asynchrone de `V86`. Le prototype n'est donc atteignable qu'**après** que l'appel a
eu lieu, et il n'existe aucun réglage public pour l'URL du Worker imbriqué. Y toucher exigerait de
reconstruire l'émulateur, ce que l'ADR 0003 refuse.

L'option 2 est écartée parce qu'elle achète, au prix d'une directive de sécurité permanente, un
résultat que l'option 3′ obtient sans elle. Ce prix est décrit plus haut : il ne rouvre aucune
brèche fermée par #35, mais il retire une défense en profondeur dans le Worker qui détiendra la clé
de volume. Payer cela pour contourner un défaut d'ordonnancement d'un émulateur serait un mauvais
échange.

## Ce que cette décision ne fait PAS, et pourquoi

**L'option 3′ n'est pas implémentée par cette tranche.** Elle est mesurée, pas livrée. Poser une
boucle d'ordonnancement à la place de celle de v86 change le **rythme de tout l'émulateur** : le
chemin de la barrière de durabilité (`SEC-DURABLE-001`), les délais de garde ATA, la reprise de #7
et les quatre scénarios de `npm run test:e2e` s'exécuteraient sur une horloge différente. Cela se
revalide avec `npm run test:vm` et `npm run test:e2e`, pas avec la suite de #52.

Cette tranche livre donc **la décision de CSP et le diagnostic**. L'implémentation de la cale
revient à **#74**, qui possède déjà le symptôme Firefox et à qui cette mesure apporte la cause. Tant
que #74 n'est pas fermée, la matrice de `docs/compatibility.md` reste ce qu'elle était : sous la CSP
servie, **seul Chromium fait battre le runtime**. Cette tranche ne l'améliore pas et ne la dégrade
pas — elle la rend dicible, mesurée et diagnostiquée.

> **#74 a été fermée le 2026-08-26.** Le paragraphe ci-dessus décrit l'état laissé par #52 et reste
> tel quel : c'est ce que cette tranche-là ne faisait pas. Ce que #74 a livré, décidé et mesuré est
> consigné dans la section « Mise en œuvre par #74 » plus bas.

## Mise en œuvre par #74 — la boucle est posée TOUJOURS, et seulement dans les Workers

Amendement du **2026-08-26**, issue #74. Il ne révise aucune décision de cet ADR : la CSP servie ne
change pas, et l'option 3′ que cette section met en œuvre est celle que la table des options
retenait déjà. Il inscrit ce que l'implémentation a tranché, et ce qu'elle a mesuré.

### « Toujours », et non « seulement si l'API native est absente »

La boucle de `src/vm/scheduling-loop.mjs` est posée **inconditionnellement** dans les Workers
runtime, y compris par-dessus une implémentation native.

Le fait qui décide est mesuré, et il ne laisse pas le choix : **Firefox EXPOSE
`scheduler.postTask`**. « Poser si l'API manque » ne poserait donc rien sous Firefox — la ligne «
cale Vault posée si l'API manque » du tableau ci-dessus le montre : _aucun compte rendu en 120 s_,
cale non posée. C'est bien l'implémentation **native** qu'il faut remplacer, et non une absence
qu'il suffirait de compléter.

Deux bornes, parce que remplacer une API du moteur n'est pas anodin :

- **dans les Workers de Vault uniquement, jamais dans une page.** v86 vit dans le Worker (ADR 0002),
  et remplacer l'ordonnanceur d'un document changerait le rythme de code étranger pour un gain nul.
  `installerBoucleOrdonnancement` **refuse** de se poser sur un contexte portant `document`, ce
  qu'une épreuve unitaire fige ;
- **`postTask` seulement.** Les autres membres de l'ordonnanceur natif — `scheduler.yield` là où le
  moteur l'expose — restent atteignables et relayés au natif.

La pose est **vérifiée** : si l'écriture de `scheduler` restait sans effet, l'installation lève au
lieu de rendre un succès. Sans ce contrôle, v86 emprunterait la boucle du moteur en silence — la
panne de #74 — pendant que le compte rendu affirmerait le contraire.

Le mode `siNatifAbsent` existe toujours : c'est celui que le harnais `npm run test:csp` compare, et
la ligne « cale Vault posée si l'API manque » ne se rejouerait pas sans lui. Il n'est **pas** ce que
le produit utilise. Depuis #74, ce harnais n'écrit plus sa propre cale : il appelle le module livré,
si bien que la mesure de cet ADR porte désormais sur le code du produit et non sur une réplique qui
pourrait en diverger.

### Ce que devient le diagnostic

La boucle est posée **avant** le contrôle préalable, qui observe donc un contexte où
`scheduler.postTask` est toujours une fonction. Trois conséquences, qu'il vaut mieux écrire que
laisser découvrir :

1. `VAULT_RUNTIME_SCHEDULING_UNAVAILABLE` **ne peut plus être produit par un Worker qui a posé la
   boucle** : il nomme le cas où aucun des deux chemins n'existe, et l'un des deux existe désormais
   toujours. Le code reste dans `runtime-errors.mjs` et reste éprouvé sur contexte injecté — le
   contrôle préalable reçoit son environnement en paramètre et n'a pas à supposer qu'une boucle a
   été posée. Il n'est pas retiré : un contexte sans constructeur `Worker` le produirait encore ;
2. `VAULT_RUNTIME_WORKER_REFUSED` **change de sens et gagne en précision**. Sa raison ne peut plus
   être « le moteur n'expose pas `scheduler.postTask` » ; il n'en reste qu'une, la même sur les
   trois moteurs : **l'URL du Worker ne porte pas `use-scheduling-api`**. C'est une faute de la
   coquille, pas une limite du moteur, et `tests/browser/runtime-diagnostic.spec.mjs` l'exige
   désormais sans nommer aucun moteur ;
3. `VAULT_RUNTIME_NO_TICK` reste le filet, et devient plus utile : son contexte porte la boucle
   posée et le **nombre de tâches qu'elle a reçues**. Zéro tâche avec un compteur figé dit « v86
   n'emprunte pas notre boucle » ; des tâches reçues avec un compteur figé dit « il l'emprunte, la
   panne est ailleurs ». Deux épreuves unitaires figent les deux moitiés.

Le risque résiduel 2 de cet ADR — _le chien de garde ne couvre pas un thread monopolisé_ — reste
exact et n'est pas levé. Il devient seulement moins probable : la cause mesurée du seul cas connu,
l'ordonnanceur natif de Firefox, n'est plus sur le chemin.

### Ce que la boucle change au rythme de l'émulateur

C'est la question que cet ADR posait en refusant de livrer l'option 3′, et elle se mesure en deux
endroits : le guest de mesure de `npm run test:vm`, et l'**image de référence** de
`npm run test:e2e` — celle qui porte Rails, SQLite et la barrière durable. Mesures du 2026-08-26,
Windows 11, machine de développement (28 threads, 32 Gio), Chromium 151 de Playwright.

**Guest de mesure, Chromium** (`tests/vm/premier-boot.spec.mjs`, cinq essais après échauffement) :

| Boucle         | Boot p50   | Boot p95   |
| -------------- | ---------- | ---------- |
| native (avant) | 4 724,5 ms | 4 907,1 ms |
| Vault (après)  | 4 700,5 ms | 5 069,0 ms |

Écart p50 −0,5 %, p95 +3,3 %, pour cinq essais dont l'étendue interne est de 8 % : rien n'est
distinguable du bruit de cette machine.

**Image de référence, Chromium** (`npm run test:e2e`, scénario de reprise de #7 : un boot à chaud et
trois reprises à froid, Rails sur SQLite, disque applicatif de 512 Mio dans OPFS) :

| Mesure                                   | Boucle native | Boucle de Vault |   Écart |
| ---------------------------------------- | ------------: | --------------: | ------: |
| Boot à chaud jusqu'à `/vault/health` (1) |     99 475 ms |      110 465 ms | +11,0 % |
| Reprise à froid, p50 (3 essais)          |     94 870 ms |       97 568 ms |  +2,8 % |
| Reprise à froid, p95 (3 essais)          |    109 412 ms |      110 140 ms |  +0,7 % |
| Reprise à froid, moyenne des 3           |     99 170 ms |      100 928 ms |  +1,8 % |
| Boot après migration de format (1)       |     97 173 ms |      105 293 ms |  +8,4 % |
| Tours par seconde au boot à chaud        |         694,5 |           629,5 |  −9,4 % |
| Barrières durables émises et acquittées  |         1 / 1 |           1 / 1 |       — |

**Ce que cette mesure permet d'affirmer, et ce qu'elle ne permet pas.** L'étendue **à l'intérieur
d'une même série** de trois reprises atteint 17,4 % avant et 15,8 % après : sur cette machine, un
écart de 3 % entre deux séries n'est pas distinguable du bruit, et un point unique ne l'est pas
davantage. Le boot à chaud « +11,0 % » est un point unique dont le journal montre en outre **60
écritures OPFS contre 40** — deux boots qui n'ont pas fait le même travail. Il serait donc faux de
présenter ces chiffres comme une absence de coût prouvée ; ils ne montrent aucun coût **mesurable**
sur cette machine, ce qui n'est pas la même chose.

Ce qu'ils établissent en revanche sans ambiguïté :

- **aucun budget de `docs/quality-attributes.md` n'est franchi** — le premier boot de preuve reste
  deux ordres de grandeur sous son p95 de 15 min ;
- **la barrière durable est intacte** : `npm run test:vm` et les quatre scénarios de
  `npm run test:e2e` passent, barrière émise et acquittée comprise (`SEC-DURABLE-001`) ;
- **le gate de reprise de l'[ADR 0005](0005-qualification-de-la-reprise.md) reste fermé**, pour la
  même raison qu'avant et sans que cette tranche l'ait déplacé : la cible est p95 ≤ 60 s, le mesuré
  reste autour de 100 s, et la voie de qualification retenue est l'instantané de #65.

La condition de réouverture « dérive du temps de boot au-delà des budgets » posée plus bas n'est
donc **pas** réalisée.

**Comparaison des tours, et pourquoi ils ne se comparent pas.** Sur le même guest, la boucle du
moteur produisait 2 144 tours en 3 943 ms (544 tours/s), la nôtre 1 368 en 3 716 ms (368 tours/s) :
**moins de tours, et un boot un peu plus court**. Un tour ne porte donc pas la même quantité de
travail d'une boucle à l'autre — v86 choisit le délai de son prochain tour selon ce qui lui reste à
faire. Le compteur de tours sert à distinguer « bat » de « ne bat pas », ce pour quoi il a été
introduit ; il ne mesure pas une vitesse d'émulation, et cet ADR ne lui fait pas dire cela.

## Conséquences immédiates

- `tools/serve-headers.mjs` sert la même politique qu'avant. Le seul changement de comportement est
  le drapeau de mesure `--worker-src-blob`, **refusé au démarrage** hors du harnais : il exige
  `VAULT_HARNAIS_CSP=mesure-worker-src`, que seul `playwright.csp.config.mjs` pose. Un
  `npm start -- --worker-src-blob` échoue donc bruyamment au lieu de servir la politique élargie en
  silence, ce qu'une épreuve unitaire fige ; deux autres vérifient que la politique par défaut ne
  contient aucune occurrence de `blob:` ;
- le commentaire erroné de `serve-headers.mjs` relevé par l'ADR 0010 est corrigé : la
  non-encadrabilité de la coquille vient de `frame-ancestors 'none'`, pas de
  `Cross-Origin-Resource-Policy` ;
- `tests/browser/csp-frontiere.spec.mjs` et `tests/browser/runtime-diagnostic.spec.mjs` sont
  rattachées à `npm run check` et exécutées sur les trois moteurs. La CSP a désormais des épreuves
  dans les deux sens : ce qu'elle admet et ce qu'elle refuse ;
- `src/vm/runtime-errors.mjs` ouvre la série `VAULT_RUNTIME_*`, distincte de `VAULT_STORAGE_*` : la
  première accuse la coquille qui sert le runtime, la seconde le volume ;
- `npm run test:csp` reste exécutable pour rejouer la mesure. Une décision de ne rien élargir doit
  rester falsifiable.

## Risques résiduels

1. **Le diagnostic dépend d'un nom conservé par la compilation Closure.** `tick_counter` rejoint
   `ata_command`, `create_identify_packet` et `push_irq` dans la liste des noms dont dépend notre
   outillage — mais il ne casse pas de la même façon : les trois premiers font échouer
   l'installation du pont **bruyamment**, celui-ci rendrait seulement le chien de garde aveugle. Un
   compteur jamais lisible ne fait donc **pas** échouer le boot : il est consigné en
   `VAULT_RUNTIME_TICKS_UNREADABLE` dans `observationsRuntime` du compte rendu, et deux épreuves
   unitaires figent les deux moitiés — compteur figé fatal, compteur illisible non fatal. La
   checklist de montée de version de l'ADR 0003 et de `docs/development.md` demande de vérifier ce
   champ.
2. **Le chien de garde ne couvre pas un thread monopolisé.** Quand le thread du Worker cesse de
   rendre la main, aucune minuterie de ce Worker ne s'exécute — pas même la nôtre. C'est exactement
   le cas de Firefox (#74), et c'est la garde de l'appelant qui borne alors l'attente. Aucun code de
   `VAULT_RUNTIME_*` n'est émis dans ce cas, et il serait faux de laisser croire le contraire.

   Ce que la garde couvre, en revanche, est une **phase** et non une attente : sur le chemin de
   l'image de référence, `boot()` rend la main juste après `emulator.run()`, avant que le guest ait
   rien dit. Une garde arrêtée là n'aurait pas eu le temps de prendre deux échantillons, et un
   émulateur qui ne bat pas serait retombé sur `awaitHealth`, dont l'expiration accuse le GUEST — la
   cause fausse que cette issue combat. `executerSousGarde` couvre donc le boot **et** l'attente de
   santé sur ce chemin, ce qu'une épreuve unitaire à deux phases fige.

3. **La sonde de Worker `blob:` coûte jusqu'à 1,5 s** au démarrage — uniquement lorsque v86
   emprunterait ce chemin, donc jamais dans la configuration servie.
4. **Les mesures viennent d'une seule machine.** Les rapports `reports/csp/<moteur>.json` sont
   reproductibles par `npm run test:csp` ; ils ne sont pas encore archivés par la CI.

## Conditions de réouverture

Cet ADR est révisé par un nouvel ADR si l'un de ces faits est établi :

- l'option 3′ se révèle impraticable à l'usage — régression de la barrière de durabilité, dérive du
  temps de boot au-delà des budgets de `docs/quality-attributes.md`, ou instabilité sous #74 ;
- une montée de v86 supprime la condition `use-scheduling-api` ou change son chemin de secours ;
- un moteur obligatoire de la matrice #2 refuse `'wasm-unsafe-eval'` — la condition d'abandon déjà
  inscrite dans l'ADR 0003, qui n'est **pas** réalisée : les trois moteurs l'acceptent, et les trois
  refusent WebAssembly sans lui ;
- l'hébergement retenu par #45 ne sait pas servir cette CSP.

## Alternatives rejetées

- **Exempter `/vm/` de la CSP**, comme l'est la sonde de capacités : déjà rejeté par l'ADR 0003, et
  pour la même raison — la sonde mesure ce qu'un moteur sait faire, le runtime est le produit.
- **Ajouter `'unsafe-eval'` plutôt que `'wasm-unsafe-eval'`** : strictement plus large, pour aucun
  gain. Les trois moteurs acceptent le jeton étroit.
- **Poser `blob:` dans `worker-src` « en attendant » #74** : une directive de sécurité posée à titre
  temporaire ne se retire jamais. Si l'option 3′ échoue, cet ADR sera rouvert avec la mesure qui
  l'aura fait échouer.
- **Laisser le Worker runtime refuser sur une condition devinée**, comme il le faisait : le message
  affirmait un refus de CSP qu'il n'avait pas observé, et il aurait continué de l'affirmer sous une
  politique qui l'admet.
