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
| Forme      | secteur de 512 octets, nonce de 12 octets, données associées de 112, AES-256                                                                                   |
| Protocole  | neuf blocs chronométrés par série ; lot calibré par série pour qu'un bloc dure ≥ 150 ms ; un lot entier jeté d'abord ; médiane des neuf valeurs par scellement |

Le protocole est celui de `tools/mesurer-scellement.mjs`, dont sortent les chiffres publiés par
`quality-attributes.md` : un LOT chronométré puis divisé, et non un appel isolé. Une première
rédaction de ce banc chronométrait chaque appel séparément et rendait des étendues de plusieurs
milliers de pour cent — elle mesurait l'ordonnanceur.

Cette machine n'est **pas** l'environnement de référence de
[`quality-attributes.md`](../quality-attributes.md). Le relevé porte en outre une réserve qui doit
être écrite avant les chiffres et non après : **trois autres chantiers du dépôt occupaient la
machine** pendant toute la séance, à une charge processeur qui est passée de 23 % à 99 % selon le
moment. Le banc a donc été joué trois fois ; le § 2.5 donne les trois et dit lequel est publié et
pourquoi. Tout ce que ce document conclut repose sur des **rapports mesurés dans le même processus,
sur les mêmes octets, à la suite** — la règle que `quality-attributes.md` s'est déjà donnée pour la
migration v3 → v4 : « le RAPPORT est le chiffre à retenir, pas la seconde ».

## Commandes

```bash
# 1. Disponibilité, sur les trois moteurs.
npx playwright test --config playwright.compat.config.mjs tests/compat/gcm-siv-probe.spec.mjs

# 2. La candidate : récupérée, confrontée à son manifeste, déposée hors du dépôt versionné.
node tools/spike-gcm-siv/preparer-candidate.mjs

# 3. Correction : les vecteurs de la RFC 8452, sur les deux implémentations.
node tools/spike-gcm-siv/verifier.mjs

# 4. Coût, sur les trois moteurs — puis le banc Node de contrôle.
npx playwright test --config tools/spike-gcm-siv/playwright.spike.config.mjs
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
témoin négatif — une étiquette abîmée d'un bit doit être refusée. **157 vérifications, aucun
échec**, et la composition rend octet pour octet ce que rend la candidate tierce, indépendamment.
Une mesure de coût prise sur une implémentation fausse ne mesurerait rien : c'est la barrière du
banc, pas son décor.

### 2.2 Ce qui rend cette voie chère, et ce n'est pas AES

**Quarante appels à `crypto.subtle` par secteur de 512 octets, là où AES-GCM en demande un.** Ce
nombre n'est pas un défaut d'implémentation, il est imposé par la RFC : les **deux** suites de
compteurs d'AES-GCM-SIV — les six blocs de dérivation des clés de message et les blocs de flot —
incrémentent leurs **quatre premiers octets en petit-boutiste**, tandis qu'AES-CTR de WebCrypto
incrémente ses **derniers bits en gros-boutiste**. Aucune des deux suites ne se replie donc sur un
appel unique. Le compte, pour un secteur de 512 octets sous une clé de 256 bits : six blocs de
dérivation, un import de la clé de chiffrement du message, un bloc d'étiquette, trente-deux blocs de
flot.

C'est exactement le mécanisme que `quality-attributes.md` a déjà nommé une fois : « le chiffre qui
décide n'est pas le débit d'AES, c'est le coût par APPEL » — un facteur 32,5 entre 8 192 appels et
un seul, sur les mêmes 4 Mio.

Une variante de SIV dont les compteurs incrémenteraient les derniers octets en gros-boutiste se
replierait, elle, sur deux appels. Elle ne serait pas AES-GCM-SIV, et inventer un AEAD est hors de
tout périmètre que ce dépôt puisse s'accorder. La remarque est ici pour qu'on n'ait pas à la
redécouvrir.

### 2.3 Les mesures

Six séries, dans le même processus, sur les mêmes octets, à la suite. Les deux du milieu
**décomposent** la voie composée, pour que le verdict ne dépende pas de la qualité de notre
multiplication de corps fini : `plancher-appels-subtle` ne fait que les trente-neuf chiffrements de
bloc, sans POLYVAL ; `polyval-seul` ne fait que POLYVAL, sur la même matière.

Relevé du **2026-09-12**, neuf blocs par série, lot calibré pour que chaque bloc dure au moins 150
ms. Microsecondes par scellement d'un secteur de 512 octets.

| Série                                        | Chromium |  Firefox |      WebKit | Ce qu'elle mesure                                      |
| -------------------------------------------- | -------: | -------: | ----------: | ------------------------------------------------------ |
| `aes-gcm-webcrypto` — ce que le produit fait |  **7,9** | **65,8** |   **138,7** | un appel, clé importée une fois                        |
| `gcm-siv-compose-webcrypto`                  |  1 041,9 |  3 950,0 | **598 000** | la voie sans dépendance, entière                       |
| `plancher-appels-subtle`                     |    236,3 |  2 689,7 |     599 000 | ses 39 chiffrements de bloc, sans POLYVAL              |
| `polyval-seul`                               |    460,6 |    666,7 |       316,7 | notre POLYVAL, écrit pour être relu et non pour courir |
| `gcm-siv-candidate`                          | **64,9** | **64,1** |    **43,6** | `@noble/ciphers`, AES-GCM-SIV logiciel                 |
| `aes-gcm-candidate`                          |     73,2 |     54,4 |        52,8 | la même bibliothèque, en AES-GCM                       |

Rapports bruts : `reports/spike-gcm-siv/banc-<moteur>.json`, cadence et lot calibré compris.

**Les rapports, qui sont ce que ce relevé établit :**

| Rapport au `aes-gcm-webcrypto` du même moteur |  Chromium |    Firefox |      WebKit |
| --------------------------------------------- | --------: | ---------: | ----------: |
| voie composée sur WebCrypto                   | **× 132** |   **× 60** | **× 4 311** |
| son plancher d'appels seul                    |      × 30 |       × 41 |     × 4 318 |
| candidate logicielle                          | **× 8,2** | **× 0,97** |  **× 0,31** |

**Quatre lectures, dans l'ordre de ce qu'elles coûtent au dépôt.**

1. **La voie sans dépendance est fermée par son plancher, pas par notre POLYVAL.** Sous Chromium,
   les trente-neuf chiffrements de bloc coûtent à eux seuls **trente fois** un AES-GCM entier. Une
   multiplication de corps fini idéale — tables précalculées, zéro allocation — ferait disparaître
   les 460 µs de `polyval-seul`, et laisserait quand même un facteur trente. Le plancher est imposé
   par la RFC (§ 2.2), pas par notre écriture : c'est la seule ligne de ce tableau qu'aucun effort
   d'implémentation ne peut déplacer.
2. **SIV ne coûte presque rien de plus que GCM, dans la même implémentation.** Les deux dernières
   lignes portent la même bibliothèque, le même AES logiciel, la même matière : sur les trois
   relevés pris ce jour-là, le rapport `gcm-siv-candidate / aes-gcm-candidate` s'est tenu entre
   **0,89 et 1,35**, médiane ≈ 1,15. Les deux passages de SIV sur le clair et sa dérivation par
   message coûtent **de l'ordre de dix à vingt pour cent**. Ce n'est pas SIV qui est cher.
3. **Ce qui est cher, c'est de quitter WebCrypto — et cela dépend entièrement du moteur.** Sous
   Chromium, dont le `crypto.subtle` est de loin le plus rapide des trois, la candidate coûte huit
   fois l'appel natif. Sous Firefox et WebKit, elle est **au niveau ou au-dessous** : leurs appels à
   `crypto.subtle` sont si chers qu'un AES logiciel les rattrape. Le moteur qui décide est Chromium
   — c'est lui que `quality-attributes.md` mesure —, et c'est donc un facteur huit qu'il faudrait
   accepter, pas un facteur un.
4. **WebKit : 598 ms par secteur, et la cause n'est pas AES.**
   `node tools/spike-gcm-siv/cout-par-appel.mjs` l'isole, et le résultat mérite d'être écrit parce
   qu'il n'était pas prévisible.

| Sous WebKit 26.5, un appel `AES-CTR` sur un bloc de 16 octets | Coût            |
| ------------------------------------------------------------- | --------------- |
| résultat **jeté**                                             | **83,3 µs**     |
| résultat lu par `new Uint8Array(sortie)`                      | **15 316,7 µs** |
| résultat lu par `new DataView(sortie).getUint8(0)`            | **15 253,3 µs** |

Ce n'est donc ni le constructeur de vue ni AES : c'est le fait de **matérialiser les octets** du
résultat, que WebKit paie quinze millisecondes. Trente-neuf blocs lus font les 598 ms mesurées. La
voie composée doit lire chaque bloc de flot ; ce coût-là lui est **inévitable**. Les deux autres
moteurs ne montrent rien de tel (Chromium : 3,7 µs jeté, 4,7 µs lu). WebKit reste par ailleurs
`refusé (OPFS absent)` dans la matrice : ce relevé ne change aucun statut, il explique un chiffre.

### 2.4 Projection sur les budgets du dépôt

Aucun de ces chiffres n'est un budget, et la règle de #16 s'applique telle quelle : « un seuil posé
sans mesure opposable serait une promesse, pas un budget ». Ce sont des projections d'un coût par
secteur mesuré, multiplié par des nombres de secteurs que le dépôt connaît. Elles emploient les
valeurs **Chromium** du relevé ci-dessus.

**Un volume applicatif de 512 Mio, soit 1 048 576 secteurs**, et le SURCOÛT que SIV ajoute au
scellement de chacun :

| Voie                              | Surcoût par secteur | Sur un volume de 512 Mio | À la migration (deux appels par secteur) |
| --------------------------------- | ------------------: | -----------------------: | ---------------------------------------: |
| composée sur WebCrypto            |         +1 034,0 µs |   **+ 18 min** (1 084 s) |                   **+ 36 min** (2 168 s) |
| son plancher seul (POLYVAL idéal) |           +228,4 µs |      **+ 4 min** (239 s) |                      **+ 8 min** (479 s) |
| candidate logicielle              |            +57,0 µs |      **+ 60 s** (59,8 s) |                      **+ 120 s** (120 s) |

Pour mémoire, le dépôt mesure aujourd'hui 19,1 s pour le scellement initial d'un volume de 512 Mio
sur OPFS réel, et la migration v3 → v4 coûte 1,89 fois le scellement initial du même volume.

**Le budget de reprise, et c'est lui qui tranche pour la voie composée.** Le budget est « dernière
génération valide trouvée en ≤ 60 s hors temps de boot VM », et il est tenu aujourd'hui à **17,1 s
de p95 au pire cas** (#91), au plafond de charge de 16 Mio. Une génération à ce plafond porte au
plus 32 768 enregistrements de 512 octets ; la reprise les OUVRE, et le point de contrôle RESCELLE
secteur par secteur (§ 7.2) — **65 536 opérations AEAD**, en prenant le coût de scellement pour les
deux, ce qui surestime légèrement les deux colonnes de la même façon.

| Voie                              | Part cryptographique de la reprise | Reprise projetée (17,1 s − part actuelle + part projetée) | Budget 60 s |
| --------------------------------- | ---------------------------------: | --------------------------------------------------------: | ----------- |
| aujourd'hui, AES-GCM de WebCrypto |                          **0,5 s** |                                                    17,1 s | tenu        |
| composée sur WebCrypto            |                         **68,3 s** |                                                **84,9 s** | **dépassé** |
| son plancher seul                 |                             15,5 s |                                                    32,1 s | tenu        |
| candidate logicielle              |                              4,3 s |                                                    20,9 s | tenu        |

**La voie sans dépendance dépasse le budget de reprise, et elle le dépasse dans les trois relevés
pris ce jour-là** — la part cryptographique projetée y vaut 45,3 s, 68,3 s et 152,5 s selon la
charge de la machine, contre 42,9 s de marge disponible. C'est la seule conclusion de coût que ce
spike tire, et elle ne porte que sur cette voie-là : **la candidate, elle, reste largement dans le
budget**.

### 2.5 Ce que la charge de la machine a fait, et pourquoi c'est écrit

Le banc a été joué **trois fois** sur les trois moteurs, à des charges de machine différentes — de
23 % à 59 % de processeur, trois autres chantiers du dépôt tournant à côté. Ce que cela donne mérite
d'être publié, parce que c'est la raison pour laquelle ce document conclut sur des rapports et non
sur des secondes :

| Grandeur, sous Chromium     |  Relevé 1 |   Relevé 2 | Relevé 3 (publié) |
| --------------------------- | --------: | ---------: | ----------------: |
| `aes-gcm-webcrypto`         |    4,6 µs |    16,5 µs |            7,9 µs |
| `gcm-siv-compose-webcrypto` |  691,5 µs | 2 327,3 µs |        1 041,9 µs |
| **rapport entre les deux**  | **× 150** |  **× 141** |         **× 132** |
| plancher d'appels / natif   |      × 34 |       × 35 |              × 30 |
| candidate / natif           |     × 8,9 |      × 9,9 |             × 8,2 |

**Les valeurs absolues varient d'un facteur trois et demi ; les rapports varient de dix pour cent.**
C'est la même leçon que `quality-attributes.md` a tirée de ses deux exécutions de migration à
quarante pour cent d'écart, et c'est pourquoi le § 2.4 projette à partir des rapports.

Le relevé publié est le troisième, et non le plus favorable : c'est le seul dont **l'ordre des
séries est cohérent sur les trois moteurs** — le plancher d'appels y est partout moins cher que la
voie composée qui l'englobe. Les deux premiers rendaient, sous Firefox, un plancher PLUS cher que la
voie complète, ce qui est impossible : c'était le compilateur de Firefox qui n'était pas chaud. Le
banc exécute depuis un lot entier jeté avant de chronométrer, et l'inversion a disparu.

Une dernière réserve, qui ne se corrige pas : `performance.now` a une résolution de 100 µs sous
Chromium et de **1 ms** sous Firefox comme sous WebKit (mesurée,
`reports/spike-gcm-siv/cout-par-appel.json`). Le lot de chaque série est calibré pour qu'un bloc
chronométré dure au moins 150 ms, ce qui met la quantification au-dessous de un pour cent — mais une
première rédaction de ce banc, à lot fixe, publiait des valeurs qui n'étaient que des multiples de
la résolution divisés par le lot. Elles avaient l'air précises.

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
contre-intuitif. Le § 9.1 dit que les compteurs reculent avec la racine
([#144](https://github.com/pinfada/railsbox-vault/issues/144)) ; la première rédaction de l'ADR 0015
dérivait le nonce de `(génération, rang)`, et un recul l'aurait alors réémis — une fermeture propre
y suffisait, sans aucune panne. Ce n'est plus le cas depuis la réfutation par exécution rappelée au
§ 4.2 : **douze octets de `crypto.getRandomValues`, stockés avec chaque objet, qui ne dérivent de
rien**. `src/vm/format-chiffre/identite-logique.mjs` le tient et
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
| 2^-30                    |                  2^33,5 |               ≈ 5,7 |                 ≈ 2,4 j |      ≈ 5,7 Tio |
| 2^-20                    |                  2^38,5 |               ≈ 181 |                ≈ 80,4 j |      ≈ 181 Tio |
| 2^-10                    |                  2^43,5 |             ≈ 5 793 |               ≈ 7,1 ans |      ≈ 5,7 Pio |

Ces lignes sont une arithmétique sur des grandeurs mesurées ailleurs, et non une mesure : elles
disent l'ORDRE de l'effort qu'un excès non borné devrait atteindre pour que la borne cesse d'être
confortable. Un volume applicatif fait 512 Mio, soit 1 048 576 secteurs.

### 3.3 Ce que SIV apporterait, exactement

- **La comptabilité cesserait d'être un nombre de sécurité.** C'est le seul apport de fond, et il
  est réel. La RFC 8452 § 6 donne, pour des nonces tirés au hasard, **2^64 messages d'au plus 128
  Kio par clé** à un avantage d'adversaire de 2^-32 — contre 2^31 messages aujourd'hui, soit 2^33
  fois plus de marge. Le secteur du produit fait 512 octets : le budget deviendrait inatteignable
  par construction, et la moitié restante de la question n° 4 — l'EMPLACEMENT du compteur, qui
  recule avec la racine et qui « n'a pas de meilleur candidat dans un navigateur » — perdrait sa
  conséquence.
- **Une collision de nonce cesserait d'être fatale.** Le dommage tomberait de « `C1 ⊕ C2 = P1 ⊕ P2`
  et la clé `H` » à « deux clairs IDENTIQUES produisent deux chiffrés identiques » (RFC 8452 § 6).
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

**Second, et il est structurel : la clé cesserait d'être une `CryptoKey` non extractible.** C'est
l'empêchement qui ne dépend pas du langage, et il vaut aussi pour une candidate WebAssembly.

Aujourd'hui, `src/vm/derivation/cle-de-domaine.mjs` appelle `crypto.subtle.deriveKey` et rend une
`CryptoKey` AES-GCM **non extractible** ; la DEK est importée en matériau `HKDF` avec le seul usage
`deriveKey`, si bien que « la DEK ne peut pas chiffrer » est un **GARANTI** au sens de l'ADR 0021
décision 7 — tenu par la plate-forme, pas par une revue (ADR 0033 décision 6, ADR 0035). Le cliquet
anti-DEK de l'ADR 0036 décision 5 lit les appels et nomme la matière de chaque clé importée ;
dix-huit mutants, dix-huit tués.

Une implémentation d'AEAD en JavaScript ou en WebAssembly a besoin des **octets bruts** de la clé.
`deriveKey` deviendrait `deriveBits` ; les six clés de domaine deviendraient six `Uint8Array` dans
le tas JavaScript ou dans la mémoire linéaire d'un module ; le cliquet perdrait la plate-forme qui
le tenait et redeviendrait une discipline relue. **Adopter SIV aujourd'hui, c'est échanger un
GARANTI contre un FAIT non garanti** — c'est-à-dire défaire, au sens exact du vocabulaire du dépôt,
la propriété que la correction de #182 venait d'établir.

**Troisième, et il ne décide pas seul mais il compte** : la candidate emploie des **T-tables** pour
AES, et le dit. Le produit fait aujourd'hui tourner AES dans l'implémentation du moteur, accélérée
par le matériel et à temps constant. Remplacer cela par un AES logiciel documenté comme fuyant ses
temps d'accès, pour les clés qui protègent le volume entier, dans un navigateur où d'autres
contextes s'exécutent, n'est pas un détail d'optimisation.

## 5. Verdict

**Non — pas maintenant.** La note datée du 12 septembre 2026 sous la décision 7 de l'ADR 0033 le
porte ; ce paragraphe dit sur quoi elle s'appuie, dans l'ordre où le spike l'a appris.

**Ce n'est pas la disponibilité qui décide.** Elle est nulle, c'est mesuré, mais une absence de
WebCrypto n'est qu'un prix à payer, pas un argument.

**Ce n'est pas le coût qui décide non plus, et c'est le résultat le plus inattendu du spike.** La
voie sans dépendance, elle, est bien fermée par le coût : quarante appels à `crypto.subtle` par
secteur, imposés par la RFC et non par notre écriture, mettent la reprise d'une génération au
plafond hors du budget de 60 s. Mais une implémentation LOGICIELLE de SIV coûte, par secteur, du
même ordre que l'AES-GCM du moteur — au-dessous sous Firefox, un ordre de grandeur au-dessus sous
Chromium, dont le `crypto.subtle` est le plus rapide des trois. Et **SIV par-dessus GCM ne coûte que
20 % dans la même implémentation** : le surcoût mesuré n'est pas celui de SIV, c'est celui de
quitter WebCrypto.

**Ce qui décide est la règle de dépendances, et l'empêchement structurel du § 4.3.** Adopter un AEAD
hors WebCrypto oblige à sortir les six clés de domaine de `CryptoKey` pour les donner en octets
bruts à du code tiers. Le dépôt échangerait alors un **GARANTI** tenu par la plate-forme — « la DEK
ne peut pas chiffrer », le cliquet anti-DEK, les clés non extractibles — contre un **FAIT non
garanti** tenu par une revue. C'est exactement la nature de la correction que #182 vient d'obtenir,
et la défaire pour gagner autre chose n'est pas un progrès net.

**Et ce que l'on achèterait est étroit.** SIV n'apporte rien à quatre domaines sur six. Sur les deux
autres, il ne corrige pas le compteur, ne détecte pas le recul, et ne change rien au cas nominal :
il borne le dommage d'un événement — la collision de nonce — dont la probabilité publiée est 2^-35
et dont la dégradation par excès de comptabilité est quadratique et lente à l'échelle des grandeurs
mesurées (§ 3.2). Le seul apport de fond, réel, est de rendre la comptabilité cryptographiquement
sans objet : 2^64 messages par clé au lieu de 2^31.

**Le spike n'a donc pas trouvé d'argument de coût contre SIV ; il a trouvé un argument de régime.**
Ce n'est pas la même chose, et la distinction est ce qui rend les conditions de réouverture
utilisables : elles portent sur le régime, pas sur la vitesse.

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
