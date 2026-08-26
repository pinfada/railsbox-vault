# ADR 0010 — La distribution de Vault n'impose pas l'isolation multi-origine ; COOP seul reste recommandé

- Statut : accepté
- Date : 2026-08-25
- Issue : #41 · Invariants : `SEC-ORIGIN-001`, `VAULT-DIST-001` · Jalon 0

## Contexte

`SharedArrayBuffer` et `Atomics.wait` n'existent qu'en contexte `crossOriginIsolated`, obtenu en
servant `Cross-Origin-Opener-Policy: same-origin` et `Cross-Origin-Embedder-Policy: require-corp`.
La matrice #2 a mesuré ces primitives, et `docs/compatibility.md` en avait tiré une affirmation qui
n'avait jamais été démontrée : « la distribution de Vault devra donc imposer cette isolation ».

Cette affirmation a un prix. Sous `require-corp`, une iframe inter-origine qui n'a pas opté pour
COEP est refusée — or l'ADR 0002 fait vivre le document applicatif sur une **autre origine**,
encadré par la coquille. GitHub Pages, l'hébergement statique de référence, ne permet aucun en-tête
de réponse personnalisé. Et le seul contournement connu — un Service Worker qui réécrit les en-têtes
— ajoute du code privilégié à l'intérieur même de la frontière de confiance.

Une exigence de cette portée ne se déduit pas d'une primitive disponible : elle se déduit d'un
consommateur. Le spike #41 devait donc établir qui, dans ce dépôt et dans le v86 épinglé par l'ADR
0003, a réellement besoin de l'isolation — et ce qu'elle coûte lorsqu'on la pose.

## Ce que l'expérience a établi

Protocole, environnement, commandes et mesures brutes :
[`docs/spikes/0041-isolation-coop-coep.md`](../spikes/0041-isolation-coop-coep.md). Les faits qui
portent la décision :

1. **Aucun consommateur.** `npm run isolation:inventaire` recense chaque occurrence de
   `SharedArrayBuffer`, `Atomics`, `crossOriginIsolated` et des deux en-têtes dans le code du dépôt
   — **96 occurrences sur 21 fichiers**, `apps/` et son Ruby compris. Toutes appartiennent à du code
   qui **mesure** l'isolation — sonde de capacités #2, sondes du spike #35, harnais du présent spike
   —, qui **sert** les en-têtes, ou qui **journalise** la valeur observée. Aucune n'est un usage :
   pas une allocation de mémoire partagée, pas un `Atomics.wait`, dans aucun module de production.
   La liste exhaustive est dans le spike.

2. **v86 épinglé ne demande rien.** `libv86.mjs` de `v86@0.5.432` contient **zéro** occurrence de
   `SharedArrayBuffer`, `Atomics` ou `crossOriginIsolated`. Et le fait décisif n'est pas textuel :
   `v86.wasm` déclare **une seule mémoire, non partagée** — drapeaux `0x00`, 146 pages minimum,
   aucun maximum — et **n'importe aucune mémoire**. Un module WebAssembly ne peut recevoir un
   `SharedArrayBuffer` que s'il déclare ou importe une mémoire `shared` ; celui-ci ne le fait pas.
   L'émulateur épinglé est donc structurellement incapable d'utiliser l'isolation, quoi qu'on serve.

3. **Le runtime complet fonctionne sans isolation, et c'est mesuré, pas déduit.** La même page
   servie par deux serveurs — l'un nu, l'autre sous COOP/COEP — boote un vrai guest Linux, écrit 4
   Mio sur un disque IDE adossé au backend Vault, franchit sa barrière de durabilité et la voit
   acquittée. Les compteurs du journal de blocs sont identiques dans les deux conditions. Le backend
   traversé est celui **en mémoire** (`openMemoryVolume`,
   `public/spike/isolation/runtime-worker.mjs:158`), choisi pour que la latence du disque hôte
   n'écrase pas un écart petit : **le chemin OPFS n'est donc pas mesuré ici** — risque résiduel n°6.

4. **Aucun coût de premier ordre n'apparaît.** Sous Chromium 151, conditions entrelacées et ordre
   inversé un tour sur deux : **+0,6 % sur le premier boot** (3 600 ms contre 3 621 ms) et **−0,5 %
   sur le temps processeur du rendu** mesuré par le protocole DevTools. Les étapes du guest
   affichent des écarts à deux chiffres qui n'en sont pas : leur durée est quantifiée par la
   scrutation à 20 ms de la console série, +14 % y valant un ou deux paliers — moins que la
   dispersion observée à l'intérieur d'une même condition. Une première version du harnais, qui
   mesurait les conditions **en blocs successifs**, rendait +17,6 % sur le boot et +65,2 % sur la
   copie mémoire ; rejouée, la même mesure en blocs rend **−3,0 %** et **−19,6 %**. Un protocole
   dont le signe s'inverse ne mesure pas l'isolation, il mesure la dérive de la machine pendant la
   campagne. Le protocole fautif est conservé et rejouable (`VAULT_ISOLATION_ENTRELACEMENT=non`), et
   son résultat publié dans le spike : un témoin négatif qu'on ne peut plus reproduire n'est qu'une
   anecdote.

5. **Poser COEP `require-corp` coûte, en revanche, cher à la topologie.** Le spike #35 a mesuré que
   sous `require-corp` une iframe inter-origine sans COEP n'est pas chargée sur les trois moteurs —
   mais avec **trois signatures distinctes**, et une seule est celle qu'on cite d'ordinaire :
   `net::ERR_BLOCKED_BY_RESPONSE` n'est relevé que sur **Chromium** ; WebKit rend un refus typé («
   Refused to display … because of Cross-Origin-Embedder-Policy », puis « Load request cancelled »)
   ; Firefox n'expose à Playwright ni requête en échec ni message de console, et son refus n'est
   constaté que par l'**absence** du cadre. L'origine applicative devrait donc servir COEP elle
   aussi — c'est-à-dire qu'une décision de la coquille imposerait un en-tête au territoire
   applicatif, exactement ce que l'ADR 0002 s'interdit ailleurs. S'ajoutent deux écarts moteurs déjà
   relevés : Firefox n'a pas chargé le cadre applicatif sous `require-corp` dans ces conditions, et
   WebKit **accorde** l'isolation à l'iframe applicative là où Chromium la lui refuse — donc
   `SharedArrayBuffer` deviendrait accessible au code hostile sur un moteur et pas sur l'autre.

6. **Le seul bénéfice attendu ne s'est pas matérialisé.** Le spike #4 avait échoué à mesurer la
   mémoire faute de `performance.measureUserAgentSpecificMemory`, réputée réservée au contexte
   isolé. Le spike #41 la relève dans les quatre combinaisons possibles. Résultat : **absente du
   Worker runtime dans les deux conditions** — c'est-à-dire là où le runtime vit ; et dans le
   document, l'isolation l'**expose** sans la rendre utilisable, l'appel échouant en
   `SecurityError: … is not available` sous le Chromium headless de Playwright. Poser l'isolation
   n'aurait donc rien rendu au budget mémoire ici. C'était le seul gain identifié, et il alimente
   #67 plutôt que cet ADR.

7. **Deux moteurs sur trois ne portent pas le runtime, pour des raisons étrangères à l'isolation.**
   WebKit 26.5 n'expose pas `scheduler.postTask` : sous la CSP de la coquille (`worker-src 'self'`)
   v86 n'a aucune boucle d'ordonnancement (ADR 0003, #52). Firefox 153 charge le Worker et l'isole,
   mais **son thread cesse entièrement de rendre la main** dès que v86 démarre : zéro battement de
   pouls en 180 s, dans les deux conditions — **#74**. Le témoin d'isolation, lui, est relevé sur
   les **trois** moteurs, page et Worker : la question posée par cet ADR ne dépend d'aucun de ces
   deux trous.

## Décision

**La distribution de RailsBox Vault n'exige pas le contexte isolé multi-origine.** Aucun en-tête
`Cross-Origin-Embedder-Policy` n'est posé, ni sur l'origine de confiance ni sur l'origine
applicative, et `crossOriginIsolated` reste `false` partout. Sur ce point, le mécanisme retenu est
**l'absence**.

### COOP n'est pas COEP, et n'est pas rejeté avec lui

Une première rédaction de cet ADR décidait « aucun COOP ni COEP ». C'était une contagion : toute la
démonstration qui précède — les faits 1, 2 et 5, la table des mécanismes, les alternatives rejetées
— ne vise que **COEP `require-corp`**. Aucune ligne de preuve ne porte sur COOP servi **seul**.

`Cross-Origin-Opener-Policy: same-origin` posé **sans** COEP a trois propriétés que cette
démonstration n'atteint pas :

- il ne confère **pas** `crossOriginIsolated` : l'isolation exige les deux en-têtes. COOP seul ne
  rend disponibles ni `SharedArrayBuffer` ni `Atomics.wait`, et ne change donc rien aux faits 1 et 2
  ;
- il ne s'applique qu'aux **contextes de navigation de plus haut niveau**. Une iframe n'en est pas
  un : COOP est sans effet sur le cadre applicatif, donc **sans effet sur la topologie T2** de l'ADR
  0002 ;
- il n'exige **rien de l'origine applicative**. L'application Rails n'a aucun en-tête à servir pour
  que la coquille porte COOP.

Des trois motifs qui écartent `require-corp`, deux ne l'atteignent donc pas : ni la dépendance
imposée au territoire applicatif, ni le refus du cadre inter-origine. Le troisième — GitHub Pages ne
sert aucun en-tête de réponse personnalisé — l'atteint, et c'est précisément ce qui fait de COOP une
exigence **différée** plutôt qu'immédiate.

### Ce que COOP protège, et que rien d'autre ne couvre ici

La coquille de confiance est destinée à détenir les clés du volume (#24, jalon 5). Un document qui
ne porte pas COOP reste dans le même groupe de contextes de navigation que celui qui l'a ouvert et
que ceux qu'il ouvre : `window.opener` survit à travers les origines, et avec lui une poignée de
canaux inter-fenêtres — référence de fenêtre conservée, navigations observables, XS-Leaks — dont la
coquille n'a aucun usage.

`frame-ancestors 'none'` (`tools/serve-headers.mjs:38`) couvre l'**encadrement** : personne ne met
la coquille dans une iframe. Il ne couvre pas l'**ouverture**. Ce sont deux relations distinctes, et
seule la seconde est du ressort de COOP.

### Décision sur COOP

**`Cross-Origin-Opener-Policy: same-origin` est RECOMMANDÉ sur l'origine de confiance** — ou
`same-origin-allow-popups` si la coquille doit un jour ouvrir une fenêtre et en garder la référence.
Cette recommandation est une **exigence différée**, portée par la chaîne de publication **#45** :

1. elle n'est pas applicable sur GitHub Pages, qui ne sert aucun en-tête personnalisé. #45 doit donc
   la compter parmi les critères qui départagent un hébergement capable d'en-têtes d'un hébergement
   qui ne l'est pas — ou décider d'un Service Worker, au prix cette fois de code privilégié dans la
   frontière de confiance, prix qui se pèse avec **#24** et non ici ;
2. elle n'est **pas** posée par le serveur de test de ce dépôt, et cet ADR ne le modifie pas :
   `tools/serve.mjs` ne sert jamais COOP autrement qu'accompagné de COEP
   (`tools/serve-headers.mjs:101-104`), sous `--cross-origin-isolated` ou `?isolation=require-corp`.
   Savoir servir COOP seul est un travail de #45, pas du présent spike ;
3. elle sera **vérifiable**. Quand l'hébergement le permettra, un témoin `window.opener === null`,
   relevé depuis une fenêtre ouverte par un document d'une autre origine, s'ajoute à la sonde
   d'origine au même titre que les témoins d'isolation déjà relevés sur les trois moteurs. Une
   recommandation non mesurée ne vaudrait pas mieux que l'affirmation de `docs/compatibility.md` que
   ce spike a dû corriger.

Cette recommandation ne rouvre pas la question de l'isolation et ne l'approche pas : COOP seul ne
rend `crossOriginIsolated` à personne. Décider COEP resterait un ADR entier à écrire, sous les
conditions de réouverture ci-dessous.

### Trois précisions, pour que l'absence de COEP ne se lise pas comme un oubli

1. l'option `--cross-origin-isolated` de `tools/serve.mjs` **reste** et n'est pas dépréciée. Elle a
   quatre consommateurs, tous de mesure, et **aucun chemin de production** :
   `playwright.compat.config.mjs:22` — la sonde de capacités #2, qui doit servir ses pages isolées
   pour pouvoir mesurer `SharedArrayBuffer` et `Atomics.wait` ; `playwright.isolation.config.mjs:43`
   — le harnais du présent spike, qui en fait sa condition « isolée » ; et les deux procédures
   manuelles de `docs/development.md:93` et `docs/development.md:168`.
   `tests/unit/origin-topology.test.mjs:188` en vérifie l'analyse d'argument. Mesurer une primitive
   n'est pas en dépendre ;
2. `Cross-Origin-Resource-Policy` reste servi tel qu'il l'est aujourd'hui — `same-origin` sur la
   coquille, `cross-origin` sur le territoire applicatif — mais **pas pour la raison qu'une première
   rédaction lui prêtait**. Sans COEP, CORP ne gouverne **pas** le chargement d'un document dans une
   iframe : il gouverne les récupérations de **sous-ressources** en mode `no-cors`. Ce qui rend la
   coquille non encadrable est `frame-ancestors 'none'` dans sa CSP (`tools/serve-headers.mjs:38`),
   pas CORP. Ce que CORP fait réellement ici, et qui reste utile : il empêche une autre origine de
   charger les ressources de la coquille comme sous-ressources `no-cors`, et il laisse celles du
   territoire applicatif chargeables. Le commentaire de `tools/serve-headers.mjs:83` porte encore
   l'attribution erronée : il est signalé comme dette dans la PR et n'est pas corrigé ici, ce
   fichier étant hors du périmètre du spike ;
3. le harnais du spike est conservé et exécutable : `npm run test:isolation` remesure le coût de
   l'isolation à la demande, et `npm run isolation:inventaire` rejoue l'inventaire — sous
   `--exiger-v86` il **échoue** sur une mémoire WebAssembly partagée (code 2) comme sur des
   artefacts absents (code 3). Une décision de ne rien faire doit rester falsifiable.

## Mécanismes comparés

| Mécanisme                                     | Ce qu'il exige                                                                          | Effet sur l'iframe applicative (ADR 0002)                             | Hébergement statique                      | Retenu  |
| --------------------------------------------- | --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------- | ------- |
| **Absence d'isolation**                       | rien                                                                                    | aucun : le cadre charge tel quel                                      | GitHub Pages convient                     | **oui** |
| En-têtes serveur COOP + COEP `require-corp`   | maîtrise des en-têtes des **deux** origines                                             | cadre refusé tant que l'origine applicative ne sert pas COEP          | GitHub Pages exclu (aucun en-tête custom) | non     |
| En-têtes serveur COOP + COEP `credentialless` | idem, plus un comportement non mesuré ici                                               | cadre chargé sans opt-in, mais requêtes sans identifiants             | GitHub Pages exclu                        | non     |
| Service Worker injectant les en-têtes         | un SW privilégié sur l'origine de confiance, un rechargement avant le premier isolement | ne peut rien pour l'autre origine : le SW n'a de portée que la sienne | fonctionne, au prix du code ajouté        | non     |

`credentialless` et l'injection par Service Worker n'ont **pas** été prototypés. C'est assumé : la
décision retenue est l'absence, et prototyper deux mécanismes d'une contrainte qu'on ne pose pas
serait du travail sans preuve à produire. Si l'isolation redevenait nécessaire, les mesurer serait
le premier travail — c'est l'objet de **#76**, ouverte comme conditionnelle : elle ne devient du
travail que si une condition de réouverture ci-dessous se réalise.

Cette table compare des mécanismes pour **obtenir l'isolation**. COOP servi **seul** n'y figure pas
parce qu'il n'en obtient aucune : il est décidé plus haut, sur ses propres motifs, et aucune ligne
de cette table ne s'applique à lui.

`require-corp` est écarté avant `credentialless` pour un motif qui n'est pas de commodité :
`require-corp` fait dépendre le chargement du territoire applicatif d'un en-tête que **l'application
Rails** devrait servir. La frontière de l'ADR 0002 vaut parce que la coquille n'impose rien au
territoire applicatif et n'attend rien de lui ; une isolation `require-corp` créerait précisément
cette dépendance.

## Conséquences

### Sur la topologie (#35, ADR 0002)

Aucune. La topologie T2 — document applicatif sur une origine distincte,
`sandbox="allow-scripts allow-same-origin"` — est inchangée, et le risque résiduel n°5 de l'ADR 0002
(« écarts moteurs sur COOP/COEP … si l'isolation devient obligatoire, la matrice #2 devra trancher
moteur par moteur ») **ne se réalise pas**. Il reste ouvert au conditionnel, pas au présent.

### Sur l'isolation de la coquille (#24)

L'isolation multi-origine n'entre pas dans la preuve de frontière. Elle ne doit pas non plus y
entrer par accident : `SEC-ORIGIN-001` est démontré par la partition d'origine, pas par COOP/COEP,
et une épreuve de #24 qui ne passerait qu'en contexte isolé mesurerait autre chose que ce qu'elle
prétend. Corollaire utile : la propriété « le code applicatif n'obtient pas `SharedArrayBuffer` »
est aujourd'hui obtenue **gratuitement**, puisque personne n'est isolé.

COOP, lui, entre dans le périmètre de #24 — et par la porte opposée. Il ne démontre aucune
frontière, mais il retire à la future détentrice de clés une surface que la partition d'origine ne
couvre pas : la relation d'ouverture inter-fenêtres. #24 décidera si cette surface compte assez pour
peser dans le choix d'hébergement de #45, et si un Service Worker injectant COOP est acceptable
**dans** la frontière qu'elle doit prouver. Cet ADR ne tranche pas ce second point : il constate
seulement que le prix se paie là, et pas ici.

### Sur la CSP de v86 dans la coquille (#52)

#52 garde son espace de décision entier et indépendant. `'wasm-unsafe-eval'`, le sort du Worker
imbriqué `blob:` et l'éventuel `worker-src blob:` pour un moteur sans `scheduler.postTask` se
tranchent sans avoir à composer avec COEP. Un point à ne pas perdre de vue en la traitant : la
raison pour laquelle WebKit n'est pas mesurable dans le présent spike est exactement celle de #52,
et non l'isolation.

### Sur l'hébergement statique et la publication (#45)

C'est le gain principal. GitHub Pages, qui n'autorise aucun en-tête de réponse personnalisé, reste
un hébergement viable pour les deux origines de l'ADR 0002. Les options d'origine comparées par
l'ADR 0002 — domaine propre, second compte, hébergeur distinct — restent départagées par leurs
propres critères, sans qu'une contrainte d'en-têtes **d'isolation** n'en élimine aucune.

#45 hérite en revanche d'une **exigence différée** : servir
`Cross-Origin-Opener-Policy: same-origin` sur l'origine de confiance, décidé plus haut. C'est une
recommandation, pas un couperet — aucune capacité du produit n'en dépend, et un hébergement qui ne
sait pas la servir reste viable. Elle change seulement le poids relatif des options : un hébergement
capable d'en-têtes personnalisés l'obtient sans code ; GitHub Pages ne l'obtient qu'au prix d'un
Service Worker, dont #24 doit dire s'il est admissible dans la frontière de confiance. #45 doit donc
trancher explicitement l'une des deux voies, ou consigner qu'elle renonce à COOP et pourquoi. Le
témoin `window.opener === null` est la preuve attendue de son application.

### Sur les budgets de qualité

Le budget mémoire de `docs/quality-attributes.md` n'est toujours pas vérifiable avec un instrument
portable, et le fait 6 montre que l'isolation ne l'aurait pas rendu vérifiable non plus :
`performance.memory` est propriétaire et grossièrement quantifié — 10 000 000 exactement, dans les
deux conditions —, et `measureUserAgentSpecificMemory` reste inutilisable là où le runtime vit.
Cette décision ne referme donc pas cet écart, mais elle établit qu'il n'était pas refermé par COOP
et COEP. C'est un résultat pour **#67**, qui porte la mesure de l'empreinte mémoire réelle : cette
issue ne peut pas compter sur l'isolation pour obtenir son instrument.

## Risques résiduels

1. **Une capacité future exigeant la mémoire partagée.** Un backend OPFS synchrone piloté par
   `Atomics.wait`, une montée de v86 vers un cœur multi-thread, une bibliothèque de chiffrement
   compilée avec les threads WebAssembly : chacune rouvrirait la question. Le harnais existe pour la
   remesurer, l'inventaire pour détecter l'arrivée d'un consommateur.
2. **Le fait 2 est daté.** Il vaut pour `v86@0.5.432`, commit `847e34d5`. Une montée de version doit
   rejouer `npm run isolation:inventaire` : une mémoire `shared` apparue dans `v86.wasm`
   invaliderait la décision sans aucun autre signal. L'instrument existe et sait refuser
   (`--exiger-v86`, codes 2 et 3), et **depuis #75 le contrôle est automatique dans
   `npm run vm:check`** : le seul point par lequel un artefact v86 entre dans le dépôt refuse
   désormais une mémoire partagée (code 2) sans attendre qu'on pense à rejouer l'inventaire.
3. **L'absence d'isolation n'est pas une protection.** Elle ne referme aucune brèche ; elle n'ouvre
   simplement pas une contrainte inutile. Aucune propriété de sécurité de `SECURITY.md` ne repose
   sur elle, et aucune frontière ne change.
4. **La mesure de coût n'a été possible que sur un moteur.** Chromium 151 headless, sur un poste de
   bureau Windows. Elle établit qu'aucun coût de premier ordre n'apparaît là, pas qu'aucun coût
   n'existe partout. Le témoin d'isolation, lui, vaut sur les trois moteurs. L'instrument a en outre
   une résolution de 20 ms par étape du guest : il ne réfuterait pas un coût de quelques pour cent
   sur une commande courte. À noter, sans conséquence ici : `performance.now()` n'est pas grossi de
   la même manière dans les deux conditions — de l'ordre de 100 µs en contexte nu contre 5 µs en
   contexte isolé sous Chromium, l'isolation étant précisément ce qui autorise le navigateur à
   rendre l'horloge plus fine. Les deux conditions ne sont donc pas chronométrées avec la même
   graduation. L'écart est de trois à quatre ordres de grandeur sous les grandeurs comparées — 20 ms
   par palier d'étape, 3 600 ms de boot —, et il jouerait de toute façon en faveur de la condition
   isolée, celle qui n'exhibe aucun surcoût.
5. **Spectre et exécution spéculative.** L'isolation multi-origine est aussi une défense de
   plateforme contre les attaques par canal auxiliaire. Ne pas la poser laisse Vault dans le régime
   par défaut du navigateur, sans mémoire partagée ni minuteur de haute résolution — c'est-à-dire
   sans les primitives qui rendent ces attaques praticables. C'est un arbitrage assumé, pas un
   oubli. La recommandation COOP ci-dessus retire par ailleurs, quand #45 l'appliquera, la relation
   d'ouverture inter-fenêtres, qui est l'autre moitié de ce que l'isolation aurait couvert.
6. **Le chemin OPFS n'est pas mesuré.** Le fait 3 fait traverser au guest le backend **en mémoire**
   (`openMemoryVolume`), choisi pour que la latence du disque hôte n'écrase pas un écart petit. Le
   coût de l'isolation **sur le chemin OPFS** reste donc inconnu. Ce qui est su par ailleurs :
   `npm run test:vm` fait lire et écrire un vrai guest sur un volume OPFS, barrière de durabilité
   acquittée, sur un serveur **sans** en-tête d'isolation (`playwright.vm.config.mjs` ne passe pas
   `--cross-origin-isolated`). L'absence d'isolation ne bloque donc pas OPFS ; son éventuel coût sur
   ce chemin reste à mesurer si la question se pose, et le harnais du spike sait le faire.

## Conditions de réouverture

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- un module de production du dépôt, ou une version épinglée de v86, déclare ou importe une mémoire
  WebAssembly partagée, ou appelle `SharedArrayBuffer` ou `Atomics` hors code de mesure ;
- une mesure reproductible montre un coût de premier ordre — boot, débit disque ou CPU — imputable à
  l'absence d'isolation, et non à sa présence ;
- une capacité obligatoire de `docs/compatibility.md` devient conditionnée à `crossOriginIsolated`
  sur un moteur de la matrice cible ;
- `performance.measureUserAgentSpecificMemory` devient utilisable dans un Worker isolé sur un moteur
  de la matrice, et le budget mémoire de `docs/quality-attributes.md` devient un critère de
  fermeture d'une tranche produit — auquel cas l'isolation du seul banc de mesure, et non de la
  distribution, doit être décidée explicitement.

## Retour arrière

Poser l'isolation reste peu coûteux et entièrement réversible : `tools/serve.mjs` sait déjà servir
COOP/COEP (`--cross-origin-isolated`, ou `?isolation=require-corp` par réponse), et
`npm run test:isolation` mesure les deux conditions côte à côte. Ce qui coûterait cher n'est pas le
changement d'en-tête mais ses conséquences — opt-in COEP de l'origine applicative, hébergement
capable d'en-têtes personnalisés — et c'est précisément ce que cette décision évite d'engager tant
qu'aucun consommateur ne l'exige.

## Alternatives rejetées

- **Poser l'isolation « par précaution », pour ne pas avoir à y revenir.** Elle éliminerait
  aujourd'hui GitHub Pages et imposerait un en-tête au territoire applicatif, pour une capacité que
  personne n'utilise. Une contrainte de distribution ne se prend pas d'avance.
- **Poser l'isolation seulement sur la coquille, pas sur l'origine applicative.** Mesuré impossible
  par le spike #35 : sous `require-corp`, le cadre applicatif sans COEP est refusé. « Seulement sur
  la coquille » n'est pas une option, c'est une coquille sans application.
- **Injecter les en-têtes par Service Worker (`coi-serviceworker`).** Elle survivrait à GitHub
  Pages, mais ajoute du code privilégié dans la frontière de confiance, ne peut pas isoler le
  premier chargement, et ne fait rien pour la seconde origine. À reconsidérer seulement si
  l'isolation redevient nécessaire.
- **Attendre #52 pour trancher.** #52 porte sur la CSP, pas sur les en-têtes d'isolation, et les
  deux décisions sont indépendantes. Une version antérieure de cet ADR justifiait en outre l'urgence
  par « #41 bloquait #6 » : c'est faux au moment où il est écrit. #6 (« Écrire et relire des blocs
  v86 dans un fichier OPFS ») est **fermée depuis le 23/08/2026**, donc livrée **sans** cette
  décision — et sans dommage, puisque son chemin n'utilise ni `SharedArrayBuffer` ni `Atomics`. Ce
  n'est pas un détail de date : c'est la confirmation empirique du fait 1. Une tranche entière du
  chemin critique a franchi la ligne pendant que la question restait ouverte, ce qui montre que
  l'isolation n'était bloquante pour personne.
