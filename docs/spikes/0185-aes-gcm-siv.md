# Spike #185 — AES-GCM-SIV : disponibilité, coût par secteur, et ce qu'il apporte une fois les clés séparées

Ce document est le compte rendu d'expérience du spike
[#185](https://github.com/pinfada/railsbox-vault/issues/185). Le **verdict** qu'il porte est une
note datée sous la décision 7 de
l'[ADR 0033](../decisions/0033-hierarchie-de-cles-derivees-par-domaine.md) ; ici figurent la
question, l'environnement, les commandes, les résultats bruts et leur lecture.

**Ce spike ne rend aucun code de produit, aucun octet de format et aucune dépendance.** Rien de ce
qu'il écrit ne vit sous `src/`, rien n'entre dans `package.json`, et la candidate évaluée n'est pas
versionnée dans le dépôt.

## Question

La question n° 1 du § 13 de la spécification — « AES-GCM-SIV vaut-il sa dépendance, en défense en
profondeur ? » — a été **rouverte** par la revue externe du 10 septembre 2026, et pour la raison
exacte que la question elle-même avait écrite d'avance : « un argument montrant que la probabilité
de collision de 2^-35 au budget retenu est mal bornée ». Le constat
[#182](https://github.com/pinfada/railsbox-vault/issues/182) est cet argument.

La décision 7 de l'ADR 0033 fixe le périmètre en quatre points, et rien d'autre : la
**disponibilité** mesurée moteur par moteur, le **coût par secteur** rapporté aux budgets du dépôt,
**ce que SIV apporte une fois les clés séparées** — c'est-à-dire depuis les ADR 0035 et 0036 —, et
un **verdict écrit**.

## Environnement

| Élément    | Valeur                                                                                                                                                         |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Système    | Windows 11 Famille 10.0.26200, x64                                                                                                                             |
| Machine    | Intel i7-14700HX, 28 fils logiques, 32 Gio                                                                                                                     |
| Node       | v24.14.0                                                                                                                                                       |
| Playwright | 1.62.1                                                                                                                                                         |
| Moteurs    | Chromium 151.0.7922.34, Firefox 153.0, WebKit 26.5 (révisions Playwright)                                                                                      |
| Forme      | secteur de 512 octets, nonce de 12 octets, données associées de **118** — largeur réelle d'un secteur v4 —, AES-256                                            |
| Protocole  | neuf blocs chronométrés par série ; lot calibré par série pour qu'un bloc dure ≥ 150 ms ; un lot entier jeté d'abord ; médiane des neuf valeurs par scellement |

Le protocole est celui de `tools/mesurer-scellement.mjs`, dont sortent les chiffres publiés par
`quality-attributes.md` : un LOT chronométré puis divisé, et non un appel isolé. Une première
rédaction de ce banc chronométrait chaque appel séparément et rendait des étendues de plusieurs
milliers de pour cent — elle mesurait l'ordonnanceur.

Cette machine n'est **pas** l'environnement de référence de
[`quality-attributes.md`](../quality-attributes.md). Le relevé porte en outre une réserve qui doit
être écrite avant les chiffres et non après : **trois autres chantiers du dépôt occupaient la
machine** pendant toute la séance, à une charge processeur allant de 11 % à 99 % selon le moment. Le
banc a donc été joué huit fois ; le § 2.6 donne la dispersion des trois exécutions publiées. Tout ce
que ce document conclut repose sur des **rapports mesurés dans le même processus, sur les mêmes
octets, à la suite** — la règle que `quality-attributes.md` s'est déjà donnée pour la migration v3 →
v4 : « le RAPPORT est le chiffre à retenir, pas la seconde ».

## Commandes

```bash
# 1. Disponibilité, sur les trois moteurs.
npx playwright test --config playwright.compat.config.mjs tests/compat/gcm-siv-probe.spec.mjs

# 2. La candidate : récupérée, confrontée à son manifeste, déposée hors du dépôt versionné.
node tools/spike-gcm-siv/preparer-candidate.mjs

# 3. Correction : les vecteurs de la RFC 8452, sur les trois implémentations.
node tools/spike-gcm-siv/verifier.mjs

# 4. Ce que la voie composée CONSERVE : la clé de domaine ne quitte pas CryptoKey.
node tools/spike-gcm-siv/epreuve-cle-non-extractible.mjs

# 5. Coût, sur les trois moteurs. Les variables SONT la cadence du relevé publié ; sans elles le
#    banc tourne à sept blocs de 60 ms, ce qui suffit aux rapports mais pas à la précision annoncée.
VAULT_SPIKE_ESSAIS=9 VAULT_SPIKE_CIBLE_MS=150 npx playwright test --config tools/spike-gcm-siv/playwright.spike.config.mjs

# 6. Ce qu'un appel à crypto.subtle coûte, forme par forme, et les 39 blocs sous trois écritures.
node tools/spike-gcm-siv/cout-par-appel.mjs

# 7. Le banc Node de contrôle.
node tools/spike-gcm-siv/banc-node.mjs
```

Les rapports bruts vivent dans `reports/compat/gcm-siv-*.json` et `reports/spike-gcm-siv/*.json`.

## 1. Disponibilité : absente partout, et le refus est publié tel quel

L'ADR 0033 écrivait « AES-GCM-SIV n'est exposé par WebCrypto sur aucun des trois moteurs » et
demandait de le **constater** plutôt que de le supposer. `tests/compat/gcm-siv-probe.spec.mjs` le
demande à WebCrypto de trois façons — un nom d'algorithme nu, un objet d'algorithme complet, puis un
chiffrement de bout en bout —, **dans la page et dans un Worker**, et publie l'exception telle
qu'elle vient.

Relevé du **2026-09-12**. Les trois moteurs refusent, **dans les deux contextes**, avec le même nom
d'exception — `NotSupportedError`, c'est-à-dire « cet algorithme n'existe pas ici », et non un refus
d'usage ou une clé mal formée.

| Capacité                                       | Contexte      | Chromium 151.0.7922.34                                                                              | Firefox 153.0                                    | WebKit 26.5                                           |
| ---------------------------------------------- | ------------- | --------------------------------------------------------------------------------------------------- | ------------------------------------------------ | ----------------------------------------------------- |
| `importKey` sous le nom `"AES-GCM-SIV"`        | page + worker | `NotSupportedError : Failed to execute 'importKey' on 'SubtleCrypto': Algorithm: Unrecognized name` | `NotSupportedError : Operation is not supported` | `NotSupportedError : The operation is not supported.` |
| `importKey` sous `{ name, length: 256 }`       | page + worker | idem                                                                                                | idem                                             | idem                                                  |
| `encrypt` de bout en bout                      | page + worker | idem — le refus tombe dès l'import                                                                  | idem                                             | idem                                                  |
| **`AES-CTR` sur un bloc isolé** (la primitive) | page + worker | **supported**                                                                                       | **supported**                                    | **supported**                                         |

Rapports bruts : `reports/compat/gcm-siv-chromium.json`, `-firefox.json`, `-webkit.json`.

La sonde interroge une quatrième capacité, qui n'est pas un ornement : **AES-CTR sur un bloc
isolé**. C'est la seule primitive par laquelle un AES-GCM-SIV conforme peut être composé sans une
ligne de code tiers, et sa présence conditionne tout le § 2.

L'épreuve **rougit si un moteur se met à exposer SIV**. C'est le signal qui rouvrirait la question,
et il est câblé plutôt que confié à une veille.

## 2. Le coût par secteur

### 2.1 La voie SANS dépendance existe, et elle est conforme

`tools/spike-gcm-siv/gcm-siv-webcrypto.mjs` compose un AES-GCM-SIV conforme à la RFC 8452 sur les
seules primitives que les trois moteurs exposent : POLYVAL écrit à la main
(`tools/spike-gcm-siv/polyval.mjs`, par la conversion POLYVAL ↔ GHASH de l'annexe A de la RFC), et
AES-ECB obtenu d'AES-CTR — un bloc de clair nul sous le compteur `B` rend `E_K(B)`.

`node tools/spike-gcm-siv/verifier.mjs` la rejoue sur les **vingt-six vecteurs AES-256 de la RFC
8452** (annexes C.2 et C.3, débordement de compteur compris), dans les deux sens, chacun avec son
témoin négatif — une étiquette abîmée d'un bit doit être refusée. **235 vérifications, aucun échec**
sur trois implémentations : la composition à la file, la même **en vagues** — qui doit rendre
exactement les mêmes octets —, et la candidate tierce, écrite indépendamment. Une mesure de coût
prise sur une implémentation fausse ne mesurerait rien : c'est la barrière du banc, pas son décor.

La multiplication de corps fini de `polyval.mjs` a été **remplacée** après la revue de la PR #202 :
la première rédaction reconstruisait `H · x^i` pas à pas à chaque produit, en allouant cent
vingt-huit tableaux, et coûtait à elle seule plus de deux fois le plancher d'appels qu'elle
accompagnait — le document la désavouait lui-même comme « écrite pour être relue et non pour courir
», et le verdict s'appuyait pourtant sur elle. La forme actuelle précalcule les cent vingt-huit
multiples **une fois par message** — dans SIV la clé POLYVAL est dérivée à chaque nonce —, ne fait
plus aucune allocation, et rend les mêmes octets sur les mêmes vecteurs. Elle passe de 440 µs à 3,5
µs par secteur sous Chromium.

**Et elle n'ajoute aucune surface de temporisation**, ce qui n'allait pas de soi : la table est
indexée par la POSITION du bit, de 0 à 127, et parcourue dans un ordre fixe ; ce qui dépend du
secret reste le OU-exclusif conditionnel, exactement comme dans la version bit à bit. La forme
classique dite de Shoup, indexée par un QUARTET de l'opérande, irait plus vite encore et ajouterait,
elle, une dépendance d'adresse au secret. Le spike s'en abstient, et le facteur cent vingt-cinq est
obtenu sans cet arbitrage.

### 2.2 Ce qui rend cette voie chère, et ce n'est pas AES

**Quarante appels à `crypto.subtle` par secteur de 512 octets, là où AES-GCM en demande un.** Ce
nombre n'est pas un défaut d'implémentation, il est imposé par la RFC : les **deux** suites de
compteurs d'AES-GCM-SIV — les six blocs de dérivation des clés de message et les blocs de flot —
incrémentent leurs **quatre premiers octets en petit-boutiste**, tandis qu'AES-CTR de WebCrypto
incrémente ses **derniers bits en gros-boutiste**. Aucune des deux suites ne se replie donc sur un
appel unique. Le compte, pour un secteur de 512 octets sous une clé de 256 bits : six blocs de
dérivation, un import de la clé de chiffrement du message, un bloc d'étiquette, trente-deux blocs de
flot. La revue de la PR #202 a cherché à le réfuter et ne l'a pas pu : aucune valeur de `length`,
aucun usage d'AES-CBC à IV nul — qui chaîne, donc sérialise — ni aucun `deriveBits` — qui est HMAC,
pas AES — ne groupe des blocs ECB arbitraires en un appel.

C'est exactement le mécanisme que `quality-attributes.md` a déjà nommé une fois : « le chiffre qui
décide n'est pas le débit d'AES, c'est le coût par APPEL » — un facteur 32,5 entre 8 192 appels et
un seul, sur les mêmes 4 Mio.

Une variante de SIV dont les compteurs incrémenteraient les derniers octets en gros-boutiste se
replierait, elle, sur deux appels. Elle ne serait pas AES-GCM-SIV, et inventer un AEAD est hors de
tout périmètre que ce dépôt puisse s'accorder. La remarque est ici pour qu'on n'ait pas à la
redécouvrir.

### 2.3 Ce que le nombre d'appels NE dit pas : deux corrections d'écriture, mesurées

Deux propriétés du banc — et non de la voie composée — pesaient plus lourd que la voie elle-même
dans une première rédaction de ce document. La revue de la PR #202 les a isolées, et
`node tools/spike-gcm-siv/cout-par-appel.mjs` les mesure désormais **une variable à la fois**, 300
appels par forme.

**Première : sous WebKit, une enveloppe `async` autour d'un appel coûte un tour de reprise
complet.** Ce que la première rédaction attribuait à « la matérialisation des octets » était faux,
et la forme décisive est celle qui n'en lit aucun :

| Forme de l'appel, AES-CTR sur un bloc de 16 octets | Chromium |  Firefox |        WebKit |
| -------------------------------------------------- | -------: | -------: | ------------: |
| promesse rendue telle quelle, résultat **jeté**    |   3,7 µs |  53,3 µs |    **120 µs** |
| enveloppe `async`, **rien de lu**                  |   3,7 µs |  66,7 µs | **15 393 µs** |
| enveloppe `async`, copie par `new Uint8Array`      |   3,7 µs |  73,3 µs |     15 217 µs |
| enveloppe `async`, lecture par `DataView`          |   3,7 µs | 193,3 µs |     15 230 µs |
| aucune cryptographie : `await Promise.resolve()`   |   0,3 µs |   6,7 µs |        6,7 µs |

**La deuxième ligne ne lit rien et coûte ce que coûte la troisième.** Les 15,3 ms ne sont pas le
prix des octets : c'est le prix d'un tour de reprise après une promesse résolue depuis le fil de
cryptographie de WebKit, de l'ordre du tic d'horloge de Windows. Le module du spike enveloppait
chacun de ses trente-neuf appels ; il ne le fait plus.

**Seconde : les blocs d'une même suite sont indépendants, et les émettre en une vague retire des
tours d'attente sans changer un octet.** Les octets identiques sont vérifiés par `verifier.mjs`, qui
rejoue les vingt-six vecteurs sur la variante en vagues.

| Les 39 blocs d'un secteur            | Chromium |  Firefox |     WebKit |
| ------------------------------------ | -------: | -------: | ---------: |
| enveloppe `async` interne, à la file |   310 µs | 2 700 µs | 601 100 µs |
| promesse brute, à la file            |   130 µs | 2 500 µs |  16 000 µs |
| une seule vague                      |   150 µs |   300 µs |  15 100 µs |

Ce que cela corrige dans le verdict : la phrase « ce coût-là est inévitable » est **retirée**, et la
phrase « aucun effort d'implémentation ne peut déplacer ce plancher » est **restreinte à Chromium**,
où elle reste vraie — le gain de la vague y est nul parce que le coût y est du calcul, pas de
l'attente. Sous Firefox la vague gagne un facteur 8 sur les trente-neuf blocs nus — et 3,8 sur la
voie composée entière (§ 2.4), qui ne groupe que ses deux suites indépendantes ; sous WebKit, le
passage à la promesse brute en gagne 38, et la vague n'ajoute plus rien après lui.

**Et Chromium reste le moteur qui décide**, pour une raison qui n'est pas la vitesse : c'est, avec
Firefox, l'un des deux moteurs dont OPFS est `supported` (`compatibility.md`), et le seul sur lequel
les scénarios de bout en bout du dépôt s'exécutent. WebKit y est `refusé (OPFS absent)` : ses
chiffres décrivent l'ordonnanceur de WebKit sous Playwright et Windows, pas un chemin que le produit
emprunterait.

### 2.4 Les mesures

Huit séries, dans le même processus, sur les mêmes octets, à la suite. Les deux du milieu
**décomposent** la voie composée ; les deux variantes « vagues » mesurent ce que l'émission groupée
retire.

Médiane de **trois exécutions** du 12 septembre 2026, en microsecondes par scellement d'un secteur
de 512 octets. Chaque exécution : neuf blocs chronométrés par série, lot calibré pour qu'un bloc
dure au moins 150 ms, un lot entier jeté avant de chronométrer.

| Série                                        | Chromium |  Firefox |    WebKit | Ce qu'elle mesure                                   |
| -------------------------------------------- | -------: | -------: | --------: | --------------------------------------------------- |
| `aes-gcm-webcrypto` — ce que le produit fait |  **4,8** | **56,6** | **102,0** | un appel, clé importée une fois                     |
| `gcm-siv-compose-webcrypto`                  |    252,3 |  3 073,5 |    31 400 | la voie sans dépendance, à la file                  |
| `gcm-siv-compose-vagues`                     |    279,8 |    803,8 |    30 833 | la même, suites indépendantes groupées              |
| `plancher-appels-subtle`                     |    212,8 |  1 880,0 |    15 667 | 39 des 40 appels, sans POLYVAL ni import de message |
| `plancher-appels-vagues`                     |    205,0 |    607,7 |    15 357 | les mêmes 39, en une vague                          |
| `polyval-seul`                               |  **3,5** |     27,6 |       2,4 | notre POLYVAL, après correction                     |
| `gcm-siv-candidate`                          | **44,1** |  1 062,5 |      63,5 | `@noble/ciphers`, AES-GCM-SIV logiciel              |
| `aes-gcm-candidate`                          |     40,6 |  1 016,0 |      48,0 | la même bibliothèque, en AES-GCM                    |

Rapports bruts : `reports/spike-gcm-siv/banc-<moteur>.json`, cadence et lot calibré compris.

| Rapport au `aes-gcm-webcrypto` du même moteur |   Chromium |    Firefox | WebKit |
| --------------------------------------------- | ---------: | ---------: | -----: |
| voie composée, à la file                      |   **× 53** |       × 54 |  × 308 |
| son plancher d'appels seul                    |       × 44 |       × 33 |  × 154 |
| gain de l'émission en vagues                  | **× 0,90** | **× 3,82** | × 1,02 |
| candidate logicielle                          |  **× 9,2** |     × 18,8 | × 0,62 |

**Quatre lectures.**

1. **La voie sans dépendance coûte de 43 à 56 fois le scellement natif sous Chromium** — c'est
   l'étendue des trois exécutions ; la médiane vaut × 53. La revue de la PR #202, sur la même
   machine avec une autre multiplication de corps fini, avait mesuré × 39 à × 63 : les deux
   fourchettes se recouvrent. **Le plancher des appels en porte × 44 à lui seul** : c'est la part
   qu'aucune écriture ne déplace sur ce moteur-là, et la correction de POLYVAL — de 440 µs à 3,5 µs
   — l'a rendue visible.
2. **SIV ne coûte presque rien de plus que GCM, dans la même implémentation.** Les deux dernières
   lignes portent la même bibliothèque, le même AES logiciel, la même matière : sur les trois
   exécutions, le rapport `gcm-siv-candidate / aes-gcm-candidate` s'est tenu entre **0,96 et 1,10**
   sous Chromium. Les deux passages de SIV sur le clair et sa dérivation par message ne coûtent
   presque rien. **Ce n'est pas SIV qui est cher.**
3. **Ce qui est cher, c'est de quitter WebCrypto, et cela dépend entièrement du moteur.** Sous
   Chromium — le moteur qui décide — la candidate coûte neuf fois l'appel natif. Sous WebKit elle
   est plus rapide que lui. Le facteur qu'il faudrait accepter est donc celui de Chromium, pas le
   plus favorable des trois.
4. **Une série n'a pas pu être stabilisée, et il faut le dire plutôt que choisir** : la candidate
   sous **Firefox**. Sur cinq exécutions de la journée elle a rendu 64, 111, 952, 1 063 et 1 325 µs
   — un facteur vingt —, avec une étendue interne de 10 à 29 % à chaque fois. Aucune de nos
   variables ne l'explique : la largeur des données associées ne change rien sous Node (32 à 51 µs
   de 0 à 128 octets), et le plafond de lot n'y touche pas. Le tableau porte la médiane des trois
   dernières exécutions ; le verdict ne s'appuie sur aucune d'elles, puisqu'il s'appuie sur
   Chromium.

### 2.5 Projection sur les budgets du dépôt

Aucun de ces chiffres n'est un budget, et la règle de #16 s'applique telle quelle : « un seuil posé
sans mesure opposable serait une promesse, pas un budget ». Deux projections sont publiées, parce
qu'elles ne disent pas la même chose et que **le verdict ne dépend d'aucune des deux**.

**Ce que la machine du relevé donne**, directement, à partir de ses microsecondes. Une génération au
plafond de charge de 16 Mio — le plafond vient de
[#91](https://github.com/pinfada/railsbox-vault/issues/91) — porte au plus 32 768 enregistrements de
512 octets ; la reprise les ouvre et le point de contrôle rescelle secteur par secteur (§ 7.2), soit
**65 536 opérations AEAD** en prenant le coût de scellement pour les deux. Les 17,1 s de p95 au pire
cas qui servent de base sont, elles, le relevé v4 de `quality-attributes.md` — deux sources
distinctes, et une première rédaction les attribuait toutes deux à #91.

| Voie                              | Part cryptographique | Reprise projetée (17,1 s − part actuelle + part projetée) | Budget 60 s |
| --------------------------------- | -------------------: | --------------------------------------------------------: | ----------- |
| aujourd'hui, AES-GCM de WebCrypto |            **0,3 s** |                                                    17,1 s | tenu        |
| voie composée, à la file          |           **16,5 s** |                                                **33,3 s** | **tenu**    |
| son plancher d'appels             |               13,9 s |                                                    30,7 s | tenu        |
| candidate logicielle              |                2,9 s |                                                    19,7 s | tenu        |

**Ce que l'environnement de RÉFÉRENCE donnerait**, projeté par rapports comme le § 2.6 s'en donne la
règle. C'est une **projection et non une mesure** : aucun relevé de ce spike n'y a été pris. La base
est le seul chiffre de scellement que le dépôt y publie — 19,1 s pour 1 048 576 secteurs
(`quality-attributes.md`), soit **18,2 µs par scellement**, un facteur **2,3** au-dessus des 7,9 µs
que cette machine rendait au relevé précédent et **3,8** au-dessus des 4,8 µs d'aujourd'hui.

| Voie                     | Part cryptographique projetée | Reprise projetée | Budget 60 s |
| ------------------------ | ----------------------------: | ---------------: | ----------- |
| aujourd'hui              |                     **1,2 s** |           17,1 s | tenu        |
| voie composée, à la file |                 **51 à 67 s** |    **67 à 83 s** | **dépassé** |
| candidate logicielle     |                        11,0 s |           26,9 s | tenu        |

**Les deux projections ne s'accordent pas, et le spike ne tranche pas entre elles.** Selon que l'on
projette avec les microsecondes de la machine du banc ou avec le rapport appliqué au coût de
scellement de l'environnement de référence, la voie composée tient largement ou dépasse. Une
première rédaction de ce document écrivait « fermée par le budget de reprise » ; c'était choisir la
projection défavorable et une multiplication de corps fini que le document désavouait lui-même. Ce
que le banc établit et qui ne dépend d'aucune projection est **le facteur : × 43 à × 56 par
scellement sous Chromium**, et il s'applique à chaque scellement du produit — création, rescellement
de point de contrôle, migration, export.

**Sur un volume applicatif de 512 Mio, soit 1 048 576 secteurs**, projeté par rapports depuis les
18,2 µs de l'environnement de référence :

| Voie                 | Surcoût par secteur | Sur un volume de 512 Mio | À la migration (deux appels par secteur) |
| -------------------- | ------------------: | -----------------------: | ---------------------------------------: |
| composée, à la file  |             +946 µs |   **+ 16,5 min** (992 s) |                   **+ 33 min** (1 984 s) |
| candidate logicielle |             +149 µs |    **+ 2,6 min** (156 s) |                    **+ 5,2 min** (313 s) |

Pour mémoire, le dépôt mesure 19,1 s pour le scellement initial d'un volume de 512 Mio sur OPFS
réel, et la migration v3 → v4 coûte 1,89 fois le scellement initial du même volume.

### 2.6 Ce que la charge de la machine a fait, et pourquoi c'est écrit

Le banc a été joué **huit fois** au long de la journée, à des charges de machine allant de 11 % à 99
% — trois autres chantiers du dépôt tournaient à côté. Les trois dernières exécutions, celles que le
§ 2.4 publie, sont postérieures aux corrections et ont été prises à charge modérée.

| Grandeur, sous Chromium     | Exécution 1 | Exécution 2 | Exécution 3 |
| --------------------------- | ----------: | ----------: | ----------: |
| `aes-gcm-webcrypto`         |      4,8 µs |      5,2 µs |      4,5 µs |
| `gcm-siv-compose-webcrypto` |    255,7 µs |    224,1 µs |    252,3 µs |
| **rapport entre les deux**  |    **× 53** |    **× 43** |    **× 56** |
| plancher d'appels / natif   |        × 44 |        × 41 |        × 51 |
| candidate / natif           |       × 9,2 |       × 8,3 |      × 10,0 |

Les rapports tiennent en dix pour cent ; c'est sur eux que ce document conclut, et c'est la même
règle que `quality-attributes.md` s'est donnée pour la migration v3 → v4 : « le RAPPORT est le
chiffre à retenir, pas la seconde ».

**Le protocole publié est celui que la commande publiée exécute**, et il a fallu le corriger : une
première rédaction annonçait neuf blocs de 150 ms quand le défaut du banc en posait sept de 60 ms,
et promettait « une quantification au-dessous de un pour cent » que les blocs réellement
chronométrés — 21 à 61 ms sous un `performance.now` d'une milliseconde — ne tenaient pas. Le §
Commandes pose désormais les variables, et le plafond de lot a été relevé : sans lui, la série
`polyval-seul`, tombée à 3,5 µs, le saturait et ne chronométrait plus que des blocs de 29 ms.

`performance.now` a une résolution de 100 µs sous Chromium et de **1 ms** sous Firefox comme sous
WebKit (mesurée, `reports/spike-gcm-siv/cout-par-appel.json`). À 150 ms par bloc, la quantification
reste au-dessous de un pour cent sur les trois moteurs.

## 3. Ce que SIV apporte une fois les clés séparées

C'est la vraie question, et elle est plus étroite qu'avant l'ADR 0033. Ce paragraphe ne mesure rien
: il écrit le **résidu**, au vocabulaire de la décision 7 de l'ADR 0021.

### 3.1 Le résidu d'aujourd'hui, écrit précisément

Depuis les ADR 0035 et 0036, chaque scellement du produit se fait sous une clé dérivée par
HKDF-SHA-256, propre à un **domaine**, à un **volume** et à une **version de format**. Une collision
de nonce coûte donc, et seulement :

- la **confidentialité de deux clairs** du domaine où elle survient, par `C1 ⊕ C2 = P1 ⊕ P2` ;
- la **clé d'authentification `H` de cette clé-là** (SP 800-38D § 8.1 ; Joux 2006), donc la forgerie
  d'objets de **ce domaine, de ce volume, de cette version de format** ;
- et **rien d'autre** : ni la DEK maîtresse, ni les cinq autres domaines, ni l'autre volume, ni les
  artefacts de la version de format voisine.

**Quatre domaines sur six sont hors d'atteinte par construction.** `instantane`, `enveloppe`,
`archive` et `recuperation` tirent une clé neuve par artefact — sel de trente-deux octets, ADR 0033
décision 3 — et `tests/unit/vm-budget-par-domaine.test.mjs` mesure qu'aucun n'a jamais deux
scellements sous la même clé. Leur budget est de **1** : une collision de nonce y est impossible, et
SIV ne leur apporte **strictement rien**. Ce n'est pas une nuance de bord : c'est les deux tiers des
domaines.

Restent les deux domaines à compteur, `volume` et `journal`.

### 3.2 La borne, et ce que le recul lui fait

Sur 96 bits, `N` tirages entrent en collision avec une probabilité majorée par `N² / 2^97` :
**2^-35** au budget retenu de 2^31, 2^-33 au plafond NIST de 2^32.

**Le recul de racine ne réémet aucun nonce**, et c'est le premier point à écrire parce qu'il est
contre-intuitif. Ce sont les § 4.5 et § 4.2 de la spécification qui disent que les compteurs vivent
dans la racine et reculent avec elle ([#144](https://github.com/pinfada/railsbox-vault/issues/144))
— le § 9.1, lui, traite du retour arrière COMPLET du support, qui est autre chose ; la première
rédaction de l'ADR 0015 dérivait le nonce de `(génération, rang)`, et un recul l'aurait alors réémis
— une fermeture propre y suffisait, sans aucune panne. Ce n'est plus le cas depuis la réfutation par
exécution rappelée au § 4.2 : **douze octets de `crypto.getRandomValues`, stockés avec chaque objet,
qui ne dérivent de rien**. `src/vm/format-chiffre/identite-logique.mjs` le tient et
`tests/unit/vm-source-de-nonce.test.mjs` garde la source. Un nonce **tiré** n'est pas rejoué par un
recul ; un nonce **dérivé** l'aurait été, et c'est précisément la raison pour laquelle il ne l'est
plus.

Ce que le recul casse n'est donc pas le nonce, c'est la **comptabilité** : le nombre réel
d'invocations sous une clé à compteur n'est pas borné par 2^31, et l'écart n'est pas borné non plus.
La borne publiée se dégrade alors **quadratiquement** avec le facteur d'excès `k` :

```text
P ≤ (k · 2^31)² / 2^97 = k² · 2^-35
```

Ce que cela demande, en grandeurs que ce dépôt a mesurées — au rythme de ≈ 17,9 µs par scellement
sur le chemin de production (`quality-attributes.md`, relevé du 2026-08-27), soit au plus ≈ 56 000
scellements par seconde et par Worker :

| Borne `P` atteinte       | Invocations réelles `N` | Facteur d'excès `k` | Scellement ininterrompu | Octets scellés |
| ------------------------ | ----------------------: | ------------------: | ----------------------: | -------------: |
| 2^-35 — la borne publiée |                    2^31 |                   1 |                ≈ 10,7 h |      ≈ 1,0 Tio |
| 2^-30                    |                  2^33,5 |               ≈ 5,7 |                ≈ 2,51 j |      ≈ 5,7 Tio |
| 2^-20                    |                  2^38,5 |               ≈ 181 |                ≈ 80,4 j |      ≈ 181 Tio |
| 2^-10                    |                  2^43,5 |             ≈ 5 793 |               ≈ 7,1 ans |      ≈ 5,7 Pio |

Ces lignes sont une arithmétique sur des grandeurs mesurées ailleurs, et non une mesure : elles
disent l'ORDRE de l'effort qu'un excès non borné devrait atteindre pour que la borne cesse d'être
confortable. Un volume applicatif fait 512 Mio, soit 1 048 576 secteurs.

### 3.3 Ce que SIV apporterait, exactement

- **La comptabilité cesserait d'être un nombre de sécurité.** C'est le seul apport de fond, et il
  est réel. La RFC 8452 **§ 9** — les considérations de sécurité, et non le § 6 qui définit
  `AEAD_AES_256_GCM_SIV` — donne, pour des nonces tirés au hasard, **2^64 messages d'au plus 128 Kio
  par clé** à un avantage d'adversaire de 2^-32, contre 2^31 messages aujourd'hui, soit 2^33 fois
  plus de marge. Le secteur du produit fait 512 octets : le budget deviendrait inatteignable par
  construction, et la moitié restante de la question n° 4 — l'EMPLACEMENT du compteur, qui recule
  avec la racine et qui « n'a pas de meilleur candidat dans un navigateur » — perdrait sa
  conséquence. **Cette borne vient avec une condition que le produit ne remplit pas**, et il faut la
  citer avec elle : « this assumes a short additional authenticated data (AAD), i.e., less than 64
  bytes ». Les données associées du produit valent **118 octets** pour un secteur de volume et
  **128** pour un enregistrement de journal, soit le double. L'ordre de grandeur de l'apport ne
  bouge pas — les bornes de la RFC décroissent avec la taille du MESSAGE, et sa ligne la plus
  défavorable reste à 2^25 messages —, mais le chiffre ne peut pas être transporté hors de son
  hypothèse sans le dire.
- **Une collision de nonce cesserait d'être fatale.** Le dommage tomberait de « `C1 ⊕ C2 = P1 ⊕ P2`
  et la clé `H` » à « deux clairs IDENTIQUES produisent deux chiffrés identiques » (RFC 8452 § 9).
  Sur un volume de secteurs, cette fuite d'égalité n'est pas nulle — deux secteurs égaux se
  reconnaîtraient — mais elle n'est pas du même ordre que la perte de `H`, qui ouvre la forgerie.

### 3.4 Ce qu'il n'apporterait PAS

- **Il ne rend pas le budget exhaustif ni la mesure vraie.** Le relecteur l'écrit lui-même : SIV «
  ne dispense toutefois pas de séparer les clés par domaine ». La séparation était la correction ;
  SIV n'en est pas une seconde, il est une réduction de dommage.
- **Il ne détecte pas le retour arrière du support** (§ 9.1). Un état antérieur cohérent reste
  authentique sous n'importe quel AEAD ; c'est la question n° 3, et elle demande une ancre monotone
  hors de portée de l'adversaire.
- **Il n'apporte rien aux quatre domaines à usage unique** (§ 3.1), dont le budget est de 1.
- **Il ne change rien au cas nominal**, celui où le nonce ne se répète pas — c'est-à-dire tous les
  scellements que ce produit a jamais faits.
- **Il ne réduit ni la surface d'un adversaire qui écrit dans l'origine de confiance, ni celle d'un
  hébergeur compromis.** Ce sont les limites de l'ADR 0021 décision 3 et du § 9.1, et elles sont
  inchangées.

## 4. La règle de dépendances, appliquée telle quelle

La règle est celle de l'[ADR 0021](../decisions/0021-derivation-des-cles-de-deverrouillage.md)
décision 3, et le dépôt n'en a qu'un précédent : `vendor/argon2/argon2.wasm`. Quatre exigences, et
elles tiennent ensemble : **artefact VENDU** (pas de CDN, pas de récupération à l'exécution),
**empreinte vérifiée AVANT instanciation**, **aucune ligne de colle tierce importée**, et une
**justification écrite** — licence, taille, auditabilité, activité.

### 4.1 La candidate retenue, et pourquoi celle-là

**`@noble/ciphers@2.4.0`**, export `gcmsiv`. Le choix est motivé, et il l'est comme celui d'argon2
l'a été — par ce qu'on peut en vérifier, pas par la popularité :

| Critère      | Ce que la candidate rend                                                                                                                                |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Référence    | RFC 8452 implémentée nommément ; les vingt-six vecteurs AES-256 passent, et l'implémentation concorde octet pour octet avec la nôtre, écrite séparément |
| Licence      | MIT                                                                                                                                                     |
| Dépendances  | **zéro**                                                                                                                                                |
| Taille       | 127 kio de JavaScript non minifié pour les trois fichiers nécessaires (`aes.js` 79,9 kio, `utils.js` 34,0 kio, `_polyval.js` 13,1 kio)                  |
| Audit        | cure53, septembre 2024, portée « everything » — **sur la version 1.0.0**, pas sur la 2.4.0 évaluée ici                                                  |
| Activité     | publication par CI sans jeton, commits signés, provenance npm ; le mainteneur documente ses limites plutôt que de les taire                             |
| Auto-déclaré | « The library uses T-tables for AES, which leak access timings »                                                                                        |

La recherche d'une candidate **WebAssembly** — la forme qu'argon2 a prise — n'a rien rendu
d'équivalent : aucun artefact `.wasm` publié n'implémente la RFC 8452 avec la surface d'importation
étroite qui permet d'écrire la colle soi-même. En construire un depuis Rust ou C ajouterait une
chaîne de compilation à la chaîne de publication du dépôt : c'est une décision, pas un spike.

### 4.2 La règle, appliquée : ce que le spike a réellement fait

`node tools/spike-gcm-siv/preparer-candidate.mjs` transpose la règle à l'évaluation elle-même, pour
voir où elle casse : il récupère l'archive par `npm pack`, **confronte son empreinte SHA-256 au
manifeste**, extrait les quatre fichiers retenus, **confronte l'empreinte de chacun**, et refuse de
déposer quoi que ce soit au moindre écart. Le dépôt se fait sous `reports/spike-gcm-siv/candidate/`,
ignoré par git : **aucun octet tiers n'entre dans l'arbre versionné**, et `package.json` n'est pas
touché. `candidate/charger.mjs` recalcule les empreintes une seconde fois, juste avant l'import.

Cela marche — et c'est en le faisant marcher qu'on voit ce qui ne marchera pas.

### 4.3 Deux empêchements, et ils ne sont pas le coût

**Premier : en JavaScript, l'empreinte ne peut pas être vérifiée AVANT exécution.** Le précédent
argon2 tient parce que `WebAssembly.instantiate` prend des **octets**, que l'on peut hacher avant de
les instancier. Un module JavaScript, lui, est exécuté par `import` : la vérification arrive après.
Il n'existe aucun chemin de contournement sous la CSP du produit, qui est
`script-src 'self' 'wasm-unsafe-eval'` (ADR 0013) — le jeton `'wasm-unsafe-eval'` a été choisi
précisément parce qu'il « n'ouvre ni `eval` ni `new Function` ». La seconde confrontation
d'empreinte du § 4.2 est donc, dans un navigateur, une **cérémonie** : elle s'exécute après le
module qu'elle prétend contrôler. Il resterait la vérification de `publier:check`, sur l'arbre
publié — celle dont l'ADR 0021 dit qu'elle est la vraie défense contre l'hébergeur —, mais le dépôt
adopterait alors sa première dépendance sous un régime d'intégrité **strictement plus faible** que
son unique précédent.

**Second : une implémentation LOGICIELLE COMPLÈTE a besoin des octets bruts de la clé — et la voie
composée, elle, ne les demande PAS.**

> Une première rédaction de ce paragraphe écrivait « tout AEAD hors WebCrypto exige les octets bruts
> de la clé », et en faisait l'empêchement structurel du verdict. La revue de la PR #202 l'a
> **réfuté par exécution**. La phrase était fausse, elle est retirée, et ce qui suit est ce que la
> mesure soutient. Ce n'est pas un détail de formulation : le verdict ne repose plus dessus.

Aujourd'hui, `src/vm/derivation/cle-de-domaine.mjs` appelle `crypto.subtle.deriveKey` et rend une
`CryptoKey` AES-GCM **non extractible** ; la DEK est importée en matériau `HKDF` avec le seul usage
`deriveKey`, si bien que « la DEK ne peut pas chiffrer » est un **GARANTI** au sens de l'ADR 0021
décision 7 — tenu par la plate-forme, pas par une revue (ADR 0033 décision 6, ADR 0035). Le cliquet
anti-DEK de l'ADR 0036 décision 5 lit les appels et nomme la matière de chaque clé importée.

**La voie composée conserve ce garanti intégralement**, et
`node tools/spike-gcm-siv/epreuve-cle-non-extractible.mjs` l'exécute :

```text
✓ la DEK est un matériau HKDF, et rien d'autre       algorithme HKDF, extractable false, usages ["deriveKey"]
✓ la clé de domaine du produit est une AES-GCM non extractible
✓ deriveKey rend une clé AES-CTR NON extractible     extractable false, usages ["encrypt"]
✓ exportKey sur la clé de domaine est REFUSÉ         InvalidAccessException : key is not extractable
✓ AES-GCM-SIV scelle et rouvre sous cette CryptoKey  528 octets scellés, clair restitué à l'identique
```

Le seul argument de `deriveKey` qui change est le type de clé demandé — `AES-CTR` au lieu de
`AES-GCM` —, et `gcm-siv-webcrypto.mjs` scelle dessus sans que les octets de la clé de domaine
existent jamais. Ce qui existe en octets est la clé de chiffrement **par message**, que la RFC 8452
§ 4 impose de dériver à chaque nonce : éphémère, jamais la clé de domaine. Le cliquet devrait
apprendre à nommer une matière `AES-CTR` — une révision de son inventaire, pas l'abandon de la
plate-forme qui le tient.

**Ce qui exige les octets bruts est l'implémentation logicielle complète** — POLYVAL **et** AES en
JavaScript ou en WebAssembly, c'est-à-dire la candidate. Pour elle, `deriveKey` deviendrait
`deriveBits`, et **deux** clés de domaine — `volume` et `journal`, les seules que SIV intéresse (§
3.1) — deviendraient des `Uint8Array` dans le tas ou dans la mémoire linéaire d'un module. Pour
elle, et pour elle seule, l'échange d'un GARANTI contre un FAIT non garanti est réel.

**Troisième, et il ne décide pas seul mais il compte** : la candidate emploie des **T-tables** pour
AES, et le dit. Le produit fait aujourd'hui tourner AES dans l'implémentation du moteur, accélérée
par le matériel et à temps constant. Remplacer cela par un AES logiciel documenté comme fuyant ses
temps d'accès, pour les clés qui protègent le volume entier, dans un navigateur où d'autres
contextes s'exécutent, n'est pas un détail d'optimisation.

## 5. Verdict

**Non — pas maintenant**, et le verdict tient sur **trois bases, et trois seulement**.

> Une première rédaction de ce paragraphe en donnait deux autres : la voie sans dépendance serait «
> fermée par le budget de reprise », et tout AEAD hors WebCrypto exigerait les octets bruts de la
> clé. La revue de la PR #202 a réfuté les deux par exécution. Elles sont retirées ; ce qui suit est
> ce que le banc soutient.

1. **AES-GCM-SIV est absent de WebCrypto sur les trois moteurs** (§ 1), dans la page et dans le
   Worker, et l'épreuve affirme cette absence plutôt que de l'enregistrer.
2. **La voie sans dépendance coûte de 43 à 56 fois le scellement natif sous Chromium** (§ 2.4), dont
   un facteur 44 pour les seuls appels, qu'aucune écriture ne déplace sur ce moteur. Elle ne ferme
   aucun budget — la part cryptographique d'une reprise passe de 0,3 s à 16,5 s sur la machine du
   banc, soit 33 s contre 60 s, et la projection sur l'environnement de référence la met au budget
   ou un peu au-dessus (§ 2.5). Ce que le spike retient est le **facteur**, pas le seuil, et il
   s'applique à chaque scellement du produit.
3. **Le résidu que SIV couvrirait est nul sur quatre domaines et borné sur les deux autres** (§ 3.1,
   § 3.2) : budget de 1 pour les quatre domaines à usage unique, `k² · 2^-35` pour `volume` et
   `journal`, nonces tirés donc non réémis par un recul. Le seul apport réel — 2^64 messages par clé
   au lieu de 2^31 — ne justifie ni ce facteur, ni une dépendance auditée dont aucune forme vendable
   n'existe.

**Ce que le verdict ne dit PAS, et qui a changé.** Il ne dit plus que SIV oblige à rendre les clés
de domaine en octets bruts : la voie composée conserve intégralement le garanti de plate-forme, et
le § 4.3 l'exécute. Cet empêchement-là est réel pour la candidate **logicielle**, et pour elle seule
— avec deux autres qui ne valent qu'elle : l'empreinte d'un module JavaScript ne se vérifie pas
avant exécution sous la CSP du produit, et son AES emploie des T-tables.

**Ce qui tient donc réellement le « non ».** SIV n'achète, sur deux domaines sur six, qu'une
réduction de dommage pour un événement à 2^-35. Le seul chemin qui préserve le régime coûte quarante
à soixante fois l'AES du moteur sur le moteur qui décide. Et celui qui ne coûte presque rien demande
de rendre deux clés de domaine en octets bruts à du code tiers dont l'AES fuit ses temps d'accès,
sous un régime d'intégrité plus faible que l'unique précédent du dépôt. C'est un « non — pas
maintenant » qui n'a besoin d'aucune des phrases que la revue a réfutées.

## 6. Ce que ce spike n'a pas mesuré

- **Safari réel.** WebKit de Playwright n'est pas une qualification Safari (`compatibility.md`), et
  la ligne SIV hérite de cette réserve comme les autres.
- **Le coût d'une implémentation WebAssembly de SIV**, puisqu'aucune candidate vendable n'existe. Ce
  que le banc mesure d'une implémentation logicielle — la série de la candidate — en donne l'ordre,
  pas la valeur : un module WebAssembly n'aurait ni le coût d'entrée de JavaScript ni son JIT.
- **Le coût d'ouverture**, mesuré seulement par le scellement. AES-GCM-SIV ouvre en recalculant
  l'étiquette, donc au même ordre : la voie composée y paie les mêmes quarante appels.
- **Une campagne de mutation sur la composition**, qui n'est pas du code de produit et n'entre dans
  aucune suite du gate.
- **Le coût d'un POLYVAL tabulé par quartet**, la forme dite de Shoup. Celui de ce spike est indexé
  par position de bit et n'ajoute donc aucune dépendance d'adresse au secret (§ 2.1) ; la forme plus
  rapide en ajouterait une, et le spike n'a pas mesuré ce qu'elle gagnerait. À 3,5 µs par secteur,
  POLYVAL ne pèse plus rien devant les 213 µs d'appels : la question n'a plus d'enjeu.
- **La projection sur l'environnement de référence** (§ 2.5) : aucune mesure n'y a été prise, ni par
  ce spike ni par sa revue. C'est une projection par rapports, marquée comme telle.
- **Pourquoi la candidate est vingt fois plus lente sous Firefox d'une exécution à l'autre** (§
  2.4). Ni la largeur des données associées ni le plafond de lot ne l'expliquent ; la cause n'a pas
  été trouvée, et le verdict ne s'appuie pas sur ce moteur.
