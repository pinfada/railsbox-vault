# ADR 0048 — Le Service Worker de la coquille sert la réserve hors connexion

- Statut : **accepté, EN VIGUEUR depuis la fusion de D1h-b** (#299 ; voir l'amendement en fin de
  document). La rédaction ci-dessous du statut est celle de D1h-a : « NON EN VIGUEUR — aucun Service
  Worker n'existe tant que D1h-b n'est pas fusionnée. Jusque-là, la règle « aucun Service Worker sur
  l'origine de confiance » de `SECURITY.md` (ADR 0030, décision 4) reste celle qui s'applique. » La
  fusion de cette PR suit la délégation en vigueur (mainteneur, 18/11/2026 au soir) : revue de
  sécurité complète **APPROUVÉE au SHA exact**, contrôles requis verts, limites écrites.
- Date : 2026-11-18
- Numéro : 0048 — le 0046 est porté par la PR #298 (pas encore fusionnée), le 0047 par la PR #305
- **Révise** : `SECURITY.md` § « Aucun Service Worker sur l'origine de confiance » et la décision 4
  de l'[ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md). **Complète** :
  l'[ADR 0002](0002-topologie-origine-de-confiance.md) (la topologie prévoyait déjà un Service
  Worker par origine), l'[ADR 0023](0023-politique-de-cache-par-nature-d-artefact.md) (ce que la
  politique de cache laisse au Service Worker de la coquille) et
  l'[ADR 0038](0038-servir-l-application-dans-le-cadre.md) (le Service Worker applicatif). **Ne
  touche pas** : l'[ADR 0013](0013-csp-de-la-coquille-et-boucle-de-v86.md) — `worker-src 'self'`,
  jamais `blob:`.
- Issue : [#299](https://github.com/pinfada/railsbox-vault/issues/299) (lot `lot:artefacts`, tranche
  D1h-a ; **cette PR ne ferme pas l'issue** : D1h-b la ferme)
- Décisions acquises, qui ne sont pas rouvertes ici : **option (b)** du mainteneur
  ([18/11/2026](https://github.com/pinfada/railsbox-vault/issues/299#issuecomment-6971533886)) ; Q1,
  Q2, Q3, Q5 tranchées par l'orchestrateur sous délégation du mainteneur (18/11/2026, au soir) ; Q4
  deux PR, Q6 D1h-b après la fusion de #298

## Contexte

La PR #298 (ADR 0046) a rendu le démarrage hors connexion décidable : un descripteur scellé, un
magasin OPFS, des refus typés. Elle a laissé deux trous, que l'issue #299 suit :

1. **`libv86` n'est lié à rien.** C'est un module ES, inexécutable depuis l'OPFS sous la CSP du
   Worker (`script-src 'self'`, pas de `blob:`). Il est importé par une requête, donc lue du cache
   HTTP, et **aucun mécanisme ne lie les octets vérifiés aux octets exécutés** dans un Worker, sur
   les trois moteurs (`tools/spike-liaison-libv86.mjs`, ADR 0046 § 6). `libv86` a la confiance de
   l'origine, comme tout le code de la coquille.
2. **La page et le code de la coquille ne se rechargent pas hors connexion.** Le code est servi
   `no-cache` (ADR 0023) : un Worker neuf, créé réseau coupé, ne peut pas importer ses modules, et
   le démarrage échoue avant d'avoir lu la réserve. Avec les en-têtes de production, **il n'y a pas
   de démarrage hors connexion**. #298 l'éprouve sous un harnais qui donne une fraîcheur au code.

Le mainteneur a tranché le 18/11/2026 : **un Service Worker de la coquille sert la réserve hors
connexion** — `libv86`, la page, le code de la coquille —, chaque artefact vérifié contre son
empreinte épinglée. Ce n'est ni accepter la limite (option a), ni élargir la CSP (option c).

C'est une **surface de confiance neuve et persistante**. Elle a eu son défi C-K
([rapport](https://github.com/pinfada/railsbox-vault/issues/299#issuecomment-6972005400)), deux
contre-examens de sécurité
([1er](https://github.com/pinfada/railsbox-vault/issues/299#issuecomment-6972078799), refusé ;
[2e](https://github.com/pinfada/railsbox-vault/issues/299#issuecomment-6975807330), cinq exigences
ajoutées), une révision
([#299](https://github.com/pinfada/railsbox-vault/issues/299#issuecomment-6975729596)) et un banc
rejouable, conservé avec cette ADR sous `tools/spike-sw-coquille/`. Cet ADR fige **ce qui est
décidé** ; l'annexe A gèle la définition de prêt (DoR) de D1h-b.

## Décisions

### 1. Un seul Service Worker, classique, à une URL stable

- **Un fichier**, `/sw-coquille.mjs`, **classique** (pas de module, **aucun `import`**), à la
  **racine**, portée `/`. `Service-Worker-Allowed` n'est jamais émis (ADR 0038) : le script doit
  vivre à la racine pour couvrir la page. Un SW de module n'est pas retenu (Firefox : non mesuré en
  deçà de 153 ; la comparaison des modules importés lors d'une mise à jour est une dépendance de
  plus).
- Enregistrement : `register("/sw-coquille.mjs", { scope: "/", updateViaCache: "none" })`.
  `updateViaCache: "none"` est une ceinture contre un hébergeur qui poserait un `max-age` sur le
  script (mesuré, S9 : le script est vu même servi `max-age=1 an`).
- **La page ne s'enregistre que dans l'arbre publié.** Un module généré à la publication
  (`reserve-publiee.mjs`, stub `null` dans le dépôt vivant) le dit ; sans lui, `tools/serve.mjs` et
  `public/` restent sans Service Worker, et aucune spec existante n'est exposée à un cache de code.
- **URL et préfixe stables.** Le script (`/sw-coquille.mjs`) et le préfixe de cache (`reserve-`)
  sont **stables, pas irréversibles** : déplacer le script **orpheline** les inscriptions
  existantes, qui ne seraient plus jamais mises à jour. La procédure pour les faire évoluer est
  écrite en § 11 ; **elle n'est pas éprouvée** à ce jour, et sa preuve est une exigence de D1h-b.

### 2. Le périmètre servi, et ce qui ne l'est jamais

**Servi** (réponses fabriquées depuis la réserve) : **l'arbre publié `coquille`, moins une liste
d'exclusions nommée**. Ce que `tools/publier-arborescences.mjs` publie — page, `main.mjs`,
`public/coquille/`, `src/`, Workers, `vendor/argon2/*`, `libv86` adressé, manifestes v86, licences,
favicon. Mesuré sur `main` (`f619be5`) : **204 fichiers, 2 870 203 octets** (+ le module de version
généré), le script du SW ≈ 51 ko. Le défi avait compté 210 fichiers sur la branche de #298 : l'écart
n'est pas rapproché et ne conditionne rien (la liste est calculée, pas écrite).

Raison de la voie « tout l'arbre moins des exclusions » : « tout ce qui est publié est dans la liste
» ne demande **aucun graphe d'imports** à maintenir. Un parcours depuis `index.html` ne voit pas les
`import()` calculés (`libv86`, adresses du manifeste) : une réserve **partielle par construction**.

**`EXCLUS_DE_LA_RESERVE`** est une table nommée, une raison par entrée : `_headers`,
`inventaire.json`, `artifacts/application.json` et les quatre artefacts de VM. Une épreuve échoue
sur toute surprise (fichier publié ni listé ni exclu).

**Jamais servi par le SW** — aucune réponse fabriquée depuis la réserve :

| Quoi                                                                               | Pourquoi                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/artifacts/**` (descripteur, rootfs, paquet, noyau, initrd)                       | le descripteur est **la** sonde « origine injoignable » de l'ADR 0046 § 3 : un SW qui le servirait la ferait mentir. La réserve de l'application reste le magasin OPFS |
| `v86.wasm`, `seabios.bin`, `vgabios.bin`, `linux4.iso`                             | artefacts de VM : magasin OPFS de #298, vérifiés par le descripteur. Le SW n'en est que le **passage de données** (§ 4)                                                |
| `inventaire.json`, `_headers`                                                      | décrivent l'hébergeur, ne sont pas du code                                                                                                                             |
| **le script du SW lui-même**                                                       | le navigateur le récupère **sans passer par le SW** (destination `serviceworker`) : un SW altéré ne peut pas empêcher son propre remplacement                          |
| toute l'origine **applicative** (ADR 0038)                                         | autre origine, autre inscription : le SW de la coquille n'en voit aucune requête (S13, trois moteurs)                                                                  |
| les volumes (OPFS, pas HTTP) ; toute méthode autre que `GET` ; toute autre origine | refusés (§ 4)                                                                                                                                                          |

**La clé de la liste est le chemin exact, sans la chaîne de requête.** Le Worker de confiance est
créé avec `?use-scheduling-api` : une liste indexée par URL complète le laisse partir au réseau
(mesuré). Servir le même fichier quelle que soit la requête est sans effet de sécurité (contenu
statique). La **casse** et `//` sont significatifs (G4 : refusés).

### 3. Vérifier avant de servir, et la liaison

**D'où vient l'empreinte.** D'une **liste embarquée dans le script du SW**, générée à la publication
: chemin, taille, SHA-256, type, **profil d'en-têtes**. Une seule racine de confiance ; le
navigateur compare déjà les octets du script du SW à chaque mise à jour, donc **la version du SW est
la version de la réserve** ; l'installation est atomique ; la racine d'inventaire (ADR 0017) peut y
être inscrite et comparée hors bande. Écartés : un manifeste séparé épinglé par hash (un saut de
plus, aucun gain), le descripteur scellé de #298 (mauvaise couche : sa clé n'existe qu'après
déverrouillage, or la page de déverrouillage doit s'ouvrir hors connexion), `inventaire.json` lu à
l'installation (fourni par l'origine, non épinglé : ne vérifie rien).

**Qui vérifie, quand.**

1. **À l'installation** : chaque URL est téléchargée (`cache: "no-store"`, `credentials: "omit"`,
   `redirect: "error"`), sa taille et son SHA-256 comparés à la liste, et rangée. **Tout ou rien** :
   un seul écart fait échouer l'installation, l'ancien SW est conservé.
2. **À chaque service** : le SW relit l'entrée, **recalcule le SHA-256**, puis rend
   `new Response(octetsVerifies, { headers })`. **Les octets hachés sont les octets rendus** : aucun
   second accès. Mémoïser la vérification pour la durée de vie du SW est **écarté** : un écrivain de
   même origine peut altérer le `Cache` entre deux services (S5). Coût mesuré : 2–7 ms pour `libv86`
   (356 131 octets), hachage compris.
3. **Au portail** (§ 7) : un message `verifier` fait vérifier **toute** la réserve (40–205 ms) avant
   la création du Worker de confiance.

**La liaison existe, et elle est relative à la liste.** La `Response` construite par le SW depuis
des octets vérifiés est ce que `import()` exécute dans un Worker, sur les trois moteurs, **y compris
quand l'origine répond « MAUVAIS » à tout le reste** (S3). C'est le mécanisme qui manquait à #299.
**Relative** : la liste est dans le script que l'origine sert — voir « Ce que le Service Worker
protège, et ce qu'il ne protège PAS ».

**En-têtes de la page rendue.** Une `Response` fabriquée ne porte aucun en-tête du serveur : CSP,
COOP, X-Frame-Options, Referrer-Policy et Permissions-Policy d'une navigation viennent de **cette**
réponse. Elles sont **embarquées dans la liste et générées depuis `securityHeaders()`** (source de
vérité, ADR 0017 § 2), **jamais recopiées du réseau** ; une épreuve exige **l'égalité** avec ce que
le serveur sert, chemin par chemin (S2 : les 8 en-têtes de production identiques, CSP effective —
script inline refusé, violation émise —, 0 requête réseau).

**Conséquence sur #298** : `libv86` passe par le SW, donc la liaison existe. `lireDuCacheHttp` et le
chemin `only-if-cached` deviennent du code mort et sont supprimés par D1h-b (annexe A). La
confrontation `verifierLeModuleV86` est **conservée** comme recoupement « `libv86` de la réserve ↔
manifeste v86 scellé du descripteur » : elle protège contre une réserve plus récente que le
`v86.wasm` rangé au magasin.

### 4. La garde est fermée, et la promesse est bornée

**Promesse écrite : « bootstrap de confiance, puis clients effectivement contrôlés ».** Elle
remplace « chaque octet exécuté est vérifié ».

- **Le bootstrap n'est pas vérifié.** `public/index.html` charge `main.mjs` et ses imports **avant**
  toute prise de contrôle. À la **première visite**, ou si la page est servie **sans contrôleur**
  (rechargement forcé, moteur ou mode qui interdit le SW), ces octets viennent de l'origine, sans
  vérification : **confiance à la première utilisation** (TOFU). Un `main.mjs` hostile peut sauter
  le portail. Le portail y refuse (`RESERVE_ABSENTE`) mais **ne garantit rien d'une page déjà
  hostile** (G1).
- **La garantie commence au premier client contrôlé.** Sans `clients.claim()`, la page qui vient
  d'enregistrer le SW n'est pas contrôlée : le premier contrôle est la navigation suivante (G2 :
  l'origine répond « MAUVAIS » à tout code, la vraie coquille est prête, 0 requête de code à
  l'origine).

**Garde fermée.** Toute requête d'un client contrôlé est **refusée** (503, `X-Vault-Refus`) sauf :

1. **la liste épinglée** : chemin exact, sans la chaîne de requête, `GET` seulement ;
2. **`/artifacts/**` en passage de données seulement** : destination exécutable refusée (`script`,
   `worker`, `sharedworker`, `serviceworker`, `audioworklet`, `paintworklet`, `style`, `iframe`,
   `frame`, `object`, `embed`, `manifest`, `xslt`) ; chemin contenant `%2e`, `%2f`, `%5c`, `\`,
   `%00` refusé ; **redirection jamais suivie** (`redirect: "manual"`) ; réponse de type script,
   wasm, HTML, XML ou CSS refusée ; en réseau coupé, l'échec reste un échec **réseau** (`TypeError`
   côté page, ce que lit la sonde « injoignable » de l'ADR 0046) ;
3. **passage nommé** des artefacts de VM (`v86-<hash>.wasm`, `seabios-`, `vgabios-`, `linux4-`),
   `fetch` de données seulement.

Hors origine, méthode autre que `GET` sur une entrée listée, `POST` sous `/artifacts/` : refusés.
Une **épreuve** garde la fermeture (toute requête de la coquille hors `/artifacts/` est servie par
le SW, `response.fromServiceWorker()`), parce qu'une liste de refus fabriqués ne serait jamais
complète. Mesuré (G3–G6, L1, L2, trois moteurs) : `fetch`, `import()`, `new Worker`,
`WebAssembly.compile`, `<script>`, `importScripts` d'un fichier que l'origine sert mais que la liste
n'épingle pas : **aucun exécuté**, **0** requête à l'origine ; 18 variantes de requête : aucune n'a
rendu d'octets de l'origine hostile.

**Ce que la garde ne ferme pas.** Des octets **récupérés comme données puis exécutés par la page** :
`v86.wasm` (passage nommé) et ce que `/artifacts/` porte. Leur liaison est celle du **produit**, pas
du SW : empreinte épinglée d'Argon2 (`verifierEmpreinte`, D1b), magasin scellé de #298 pour
`v86.wasm`. Faire servir `v86.wasm` (2,1 Mio) par le SW fermerait cette lacune au prix de **+72 %**
de réserve : **non retenu, non mesuré**.

**Argon2** : le chemin du produit est `fetch` + `WebAssembly.instantiate(octets)`
(`argon2-vendu.mjs`), pas `instantiateStreaming` ; ni `importScripts` ni `instantiateStreaming` ne
figurent dans `src/` ou `public/` publiés. Ils sont **hors périmètre**, non revendiqués ; la garde
fermée s'y applique néanmoins (G3). Double barrière mesurée : entrée altérée → refus du SW (503) ;
SW sans contrôle de hachage (mutant) → le **produit** refuse par son empreinte épinglée (D1b).

### 5. Identité de cache par contenu publié ; jamais d'écrasement du cache actif

Le prototype nommait le cache par la **séquence** (`reserve-<version>`) et supprimait ce nom
**avant** l'installation et **en cas d'échec** : un script modifié qui réutilise la séquence active
effacerait la réserve que des clients ouverts utilisent (2e contre-examen, constat 4). Règle :

- **Nom** : `reserve-<empreinte du contenu>`, l'empreinte étant le SHA-256 de la **liste épinglée
  canonique** (chemin, taille, SHA-256, type, profil d'en-têtes), **à l'exclusion** de la séquence,
  du plancher et de l'indicateur de retrait. Deux scripts de même contenu partagent donc un cache
  (une révocation qui relève le plancher d'un contenu inchangé ne réinstalle rien) ; deux contenus
  différents ne se partagent **jamais** un nom, même sous la même séquence.
- **Jamais de `caches.delete` d'un cache existant à l'installation.** Un cache déjà présent sous ce
  nom n'est ni supprimé ni écrasé : ses entrées sont **vérifiées** ; les entrées manquantes ou
  altérées sont **refaites depuis le réseau, vérifiées, puis écrites** (par le message `reparer`,
  voir § 13) (une entrée n'est écrite qu'**après** vérification contre la liste de la même
  identité).
- **En cas d'échec, le SW ne supprime que le cache que CETTE installation a créé.** Un cache qui
  préexistait (actif, ou reste d'une installation interrompue) est laissé : il n'est jamais servi
  tant qu'aucun SW de cette identité n'est actif, et la vérification à chaque service ne le croit
  pas.
- **À l'activation** : suppression des caches `reserve-*` **d'une autre identité** que la sienne — à
  ce moment-là, tous les clients de l'ancienne version ont disparu (§ 6). Au plus trois caches
  coexistent (actif, en attente, reste d'une installation interrompue) : **borne écrite**.
- **Les cas à couvrir par épreuve** : (a) _collision_ — un script de même séquence, contenu
  différent, installé pendant que des clients utilisent le cache actif : le cache actif est intact
  et servi sans erreur ; (b) _même contenu, plancher relevé_ : même cache, rien n'est supprimé ni
  réinstallé ; (c) _retour arrière_ — l'origine republie un contenu ancien : il s'installe dans son
  propre cache, jamais dans celui de l'actif ; (d) _installation interrompue_ (coupure, fermeture du
  navigateur) : l'actif reste servi, le reste est complété à la reprise ou supprimé à l'activation
  suivante.

### 6. La mise à jour s'applique quand TOUS les clients de l'ancienne version ont disparu (Q3)

**Règle, écrite comme règle et non comme préférence.** Une nouvelle version devient active **quand
tous les clients — fenêtres et leurs Workers — contrôlés par l'ancienne ont disparu**, et pas avant.
Ni `skipWaiting()` (même « conditionnel »), ni `clients.claim()`, ni message « activer » : le
vocabulaire des messages du SW est **fermé** (`version`, `verifier`, `reparer`, `clients`,
`journal`) ; `activer` et `skipWaiting` restent sans réponse. « La page demande l'activation puis
recharge » est retiré : c'était un `skipWaiting` déguisé.

**Pourquoi** : `skipWaiting` en cours de session **mélange les versions** sur les trois moteurs
(S6b, A2 : page v1, Worker neuf v2). Appliquer une mise à jour en session exigerait que le SW sache
la version de chaque client et serve chacun depuis **son** cache : une refonte et une surface neuve,
non retenues.

**Invariant, vérifié à chaque étape : page, contrôleur et Worker de confiance sont de la même
séquence de publication.**

- la page porte sa séquence dans `reserve-publiee.mjs` ; le portail compare celle du contrôleur ;
- **poignée de main** : le Worker de confiance annonce la séquence qu'il exécute ; la page la
  compare **avant tout secret** ; différente : le Worker est terminé (`RESERVE_DIVERGENTE`) ;
- un `controllerchange` pendant une session est une **anomalie** : plus aucun Worker n'est créé, la
  page dit « La coquille a changé pendant l'ouverture. Rechargez la page. ».

**Ce que la personne lit** : « Une version plus récente est prête. Fermez **toutes** les fenêtres du
coffre, puis rouvrez-le. » La session ouverte n'est jamais interrompue par une mise à jour.

**Mesuré (A1, trois moteurs)** : onglet 1 en session (clé non extractible), onglet 2 en navigation
neuve, v2 publiée : v2 `installed` **en attente**, **0** `controllerchange` ; import tardif dans
l'onglet 1 : v1 ; fermeture de l'onglet 2 seul : **toujours v1** ; fermeture de **tous** : v2 et le
cache de la v1 est supprimé à l'activation.

**Différence de moteurs à ne pas écrire dans le produit** (A4) : après un aller-retour par
`about:blank`, Firefox et WebKit appliquent la v2, Chromium garde la v1. La règle est donc « tous
les clients fermés », **jamais** « une navigation ». bfcache : non mesuré.

**Limite écrite** : une fenêtre ouverte pendant des semaines reste sur sa version. Elle **affiche sa
version et son statut de vérification** (§ 8), sans prétendre connaître une révocation inaccessible.

### 7. Le portail : tout ou rien, avant tout Worker et toute clé

Le portail s'exécute avant **chaque** création du Worker de confiance — pas une fois par chargement
de page : un coffre verrouillé puis rouvert dans la même fenêtre repasse par lui, et une révocation
connue entre-temps le refuse.

Ordre :

1. **L'API existe ?** `"serviceWorker" in navigator`. Absente (navigateur ou mode qui retire l'objet
   lui-même) : `RESERVE_ABSENTE`, cause `api-absente` — **sans lire `.controller`**, sans Worker,
   sans clé. (Le prototype lisait `navigator.serviceWorker.controller` sans cette garde ; G7
   bloquait les inscriptions en gardant l'objet API : l'absence réelle de l'API n'était pas
   couverte.)
2. **Contrôleur ?** Sinon, l'**inscription active** : un script de retrait → `PERIMEE` ; sinon
   `ABSENTE`, cause `inscription-sans-controle` ou `aucun-controleur`. (Sous Firefox, un SW de
   retrait actif ne donne **aucun** contrôleur : sans cette lecture, le message dirait « sans SW »
   au lieu de « retiré ».)
3. **En parallèle**, chacun borné : identité (`version`), vérification complète (`verifier`),
   fraîcheur (§ 8). Chaque question au SW borne sa réponse à `DELAI_REPONSE_SW_MS`.
4. **Décision pure** : retrait → `PERIMEE` ; contrôleur changé ou séquence ≠ page → `DIVERGENTE` ;
   SW muet → `ABSENTE` (`silence-du-sw`) ; entrées manquantes → `INCOMPLETE` ; altérées → `ALTEREE`
   ; révocation connue → `PERIMEE`.
5. **Dernière garde, synchrone** (voir « État de révocation monotone » ci-dessous) : **dans le même
   tour** de la boucle d'événements, immédiatement avant `new Worker`, relire l'état de révocation
   partagé **et** le contrôleur (identité d'objet, drapeau `controllerchange`), **sans aucun `await`
   entre cette lecture et la création du Worker**.
6. **Poignée de main** de séquence (§ 6).
7. Un Worker qui ne se charge pas : **re-vérification** pour nommer `ALTEREE` ou `INCOMPLETE` —
   **jamais** depuis l'événement `error`, que **Firefox n'émet pas** quand le graphe de modules d'un
   Worker est refusé.

**État de révocation monotone (constat de la revue de #312).** La fraîcheur tourne en parallèle des
autres vérifications ; un portail qui en prend une décision puis attend (vérification complète,
re-contrôle) peut laisser passer une révocation connue **entre la décision et la création**. Règle :

- **un seul état de révocation par page**, partagé par l'observateur (§ 8) et par **tous** les
  portails (premier démarrage, réouverture après verrouillage, tout autre point de création d'un
  Worker de confiance). Il est **monotone** : il passe de « inconnue » à « connue » (avec sa cause :
  `plancher` ou `retrait`) et **ne revient jamais** en arrière pendant la vie de la page — ni par un
  recalcul de fraîcheur, ni par un nouveau portail, ni par la disparition du Worker en attente. Tout
  calcul de l'état 1 l'écrit ; rien ne l'efface ;
- **relu dans le même tour**, juste avant `new Worker`, à l'étape 5 : si elle est « connue », aucun
  Worker n'est créé, aucune clé n'existe, le refus est `PERIMEE`. Comme JavaScript n'exécute aucun
  gestionnaire d'événement entre deux instructions synchrones, ce qui a été **observé** avant cette
  lecture est **vu** ; l'absence d'`await` entre la garde et la création est donc **la** garde, pas
  un détail de style ;
- la décision pure de l'étape 4 reste utile (elle nomme le refus), mais **elle ne suffit pas** : une
  décision « autorise » prise avant une attente est périmée à la reprise.

**Ce que cette garde ne ferme pas** : la fraîcheur est non signée, donc bornée aux révocations
**CONNUES** (§ 9). Une révocation que la page n'a pas encore observée (script de retrait pas encore
récupéré, installation non terminée, réseau coupé) n'est pas dans l'état et ne peut pas être refusée
; une révocation connue **après** la création n'interrompt pas la session (§ 8).

Valeurs de départ, **à calibrer en D1h-b** sans jamais être abaissées sans mesure :
`DELAI_REPONSE_SW_MS` 3 000, `DELAI_VERIFICATION_MS` 5 000 (serré sous Firefox, où l'installation
nominale prend 2 à 3,4 s : le dépassement est sans danger), installation initiale bornée à 25 s (une
page qui attend l'activation sans borne bloque son `load` sous Firefox : mesuré).

**Messages** (liste fermée, validés comme la liste d'admission de l'ADR 0028) : seuls les clients de
type fenêtre de premier niveau **de la coquille** sont écoutés ; `null`, tableau, type inconnu,
champ en plus, `id` de plus de 64 caractères, absence de port, `__proto__` : **aucune réponse**,
refus comptés. **Chromium n'expose pas `navigator.serviceWorker` aux Workers dédiés** : la garde «
client `window` » y est inatteignable par cette épreuve et son mutant n'y est pas tué (écrit, «
Preuves »).

**Sans SW, la coquille refuse de démarrer (Q1).** Il n'y a **qu'un** chemin de code : le mode « en
ligne, sans réserve » aurait été un second mode du produit (indication permanente, garde séparée,
une épreuve de plus par moteur, la liaison de `libv86` redevenant celle, limitée, de #298). Le
**coût d'accès est écrit** en § 10.

**Premier démarrage** : ce n'est **pas** un refus. « Préparation hors connexion, une seule fois »
(installation, puis un rechargement automatique), bornée ; un échec (quota, refus du navigateur)
devient `RESERVE_ABSENTE`. Le démarrage n'a pas lieu sur une réserve partielle.

### 8. Les états de fraîcheur, et leur effet sur le portail

`registration.update()` **résout avant la fin de l'installation** (mesuré : 9 ms contre 1 882 ms
sous Chromium ; Firefox 1 047 ms contre 5 081 ms). Le portail attend donc **`installing` réglé**,
pas `update()`. Une installation rejetée laisse `update()` **résolue sans erreur et sans nouveau
Worker** (S7). Et `update()` rejette en `TypeError` pour un 404, un 410, un 500 **comme** pour un
réseau coupé (S8) : le navigateur ne distingue pas, on ne l'invente pas. `update()` est lancé
**explicitement à chaque démarrage** : le navigateur ne redemande le script qu'inégalement (S10, non
garanti : Chromium a relevé `[2,1,0,1]` requêtes par navigation successive).

Fonction pure `etatDeFraicheur`. **Priorité : le fait connu avant l'incertitude.** L'état affiché
est le premier de la table ; le journal du portail garde les autres.

| #   | État                                               | Observation                                                                                                         | Ce que la personne lit                                                                                                                                                           | Effet sur le portail                                                                         |
| --- | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | **révocation connue**                              | un Worker en attente **identifié** porte un `plancher` > séquence courante, ou est un script de retrait             | « Cette version a été retirée par son éditeur. Fermez toutes les fenêtres du coffre, puis rouvrez-le. »                                                                          | **REFUSE** `PERIMEE`, avant tout Worker et toute clé                                         |
| 2   | **attente muette — non vérifiable**                | un Worker `waiting` existe mais ne répond pas à `version` dans `DELAI_REPONSE_SW_MS` : son plancher est **inconnu** | « Une autre version de la coquille est en attente, mais elle n'a pas pu être identifiée. Impossible de savoir si cette version a été retirée. »                                  | autorise, avertissement permanent. **Jamais** « plus récente »                               |
| 3   | **mise à jour prête**                              | attente identifiée, **séquence > courante**, plancher ≤ courante                                                    | « L'éditeur annonce une version plus récente, prête à s'ouvrir. Fermez toutes les fenêtres du coffre, puis rouvrez-le. »                                                         | autorise, bandeau permanent                                                                  |
| 4   | **version en attente différente ou plus ancienne** | attente identifiée, contenu **différent**, **séquence ≤ courante**                                                  | « Une version différente de celle-ci est en attente, et elle n'est pas plus récente. Ce n'est pas une mise à jour : à vérifier auprès de l'éditeur avant de rouvrir le coffre. » | autorise, avertissement permanent. **Jamais** « plus récente »                               |
| 5   | **vérification échouée**                           | une version **différente** est apparue et son installation a été **rejetée**                                        | « L'éditeur a publié une version que cette copie n'a pas pu installer. Cette version n'est peut-être plus la bonne. »                                                            | autorise, avertissement permanent                                                            |
| 6   | **version courante non vérifiable**                | `update()` rejetée (réseau, 4xx, 5xx) **ou** délai dépassé                                                          | « Impossible de savoir si cette version a été retirée (hors connexion, ou éditeur injoignable). »                                                                                | autorise (le hors connexion est la fonction), avertissement permanent, **jamais « à jour »** |
| 7   | **vérification en cours**                          | `update()` ou installation non réglée, dans `DELAI_VERIFICATION_MS`                                                 | « Vérification de la version en cours… »                                                                                                                                         | **attend**, au plus le délai, puis bascule en 6 (jamais de blocage)                          |
| —   | _(nominal)_ **version vérifiée**                   | `update()` résolue, rien de nouveau, rien de rejeté                                                                 | « Version vérifiée auprès de l'éditeur à l'instant (preuve non signée). »                                                                                                        | autorise                                                                                     |

Les textes sont **indicatifs** : leur rédaction finale passe par la relecture du parcours
(`docs/parcours/relecture-p2.md`). Ce qui est **gelé** est le niveau de promesse : le texte d'un
état dit ce qui a été **observé**, jamais plus. « Plus récente » n'est dit que pour l'état 3, et
encore comme une **annonce de l'origine** — la séquence est publiée par l'origine, pas authentifiée.
Une attente muette et une version différente ou plus ancienne ne sont **jamais** présentées comme
une mise à jour (2e contre-examen, constat 2 ; F8 avait mesuré qu'une version plus ancienne recevait
l'état « prête »).

**Observation tardive (2e contre-examen, constat 1).** La fraîcheur n'est pas un instantané du
portail. **La page garde, pour toute sa vie, un observateur** : `updatefound` sur l'inscription,
`statechange` de chaque Worker `installing`, et, à chaque `installed`, une question `version` bornée
au Worker en attente ; l'état est recalculé par la même fonction pure et **le bandeau est mis à
jour**. Une révocation connue **après** le délai du portail (installation lente) ou **après**
l'ouverture de la session est donc **annoncée de façon visible** (région `role="alert"`), **sans
interrompre la session** : le Worker de confiance n'est pas terminé, la clé reste utilisable, aucun
`controllerchange` n'est émis. Ce qu'elle change : **plus aucun Worker n'est créé** (§ 7 :
l'observateur écrit l'état de révocation monotone, que chaque portail relit dans le même tour avant
`new Worker`). Le prototype calculait l'état une fois puis retirait son écouteur (F7 le recalculait
à la main, sans bandeau) : **c'est un écart du banc à la décision**, listé en « Preuves ».

**Réponse au critère du mainteneur** (« aucun SW ancien ne doit servir un code périmé ou révoqué
sans le dire ») : le SW ancien **dit ce qu'il sait** — révocation connue, mise à jour prête, version
différente — et, **quand il ne peut pas savoir**, il dit qu'il ne peut pas (états 2, 5, 6). Il ne
promet jamais « à jour ». Ce n'est pas une garantie de fraîcheur : voir § 9.

**Une mise à jour (ou une révocation) qui ne passe pas l'installation n'est PAS connue** : état 5,
pas de refus. Hors connexion, une révocation est **invisible** (R2).

### 9. Le plancher non signé est un signal de révocation CONNUE, rien de plus (Q2)

Le nouveau SW porte un `plancher` (séquence minimale) ; si un Worker en attente **identifié**
annonce un plancher supérieur à la séquence courante, la page **refuse de déverrouiller**
(`RESERVE_PERIMEE`), active la mise à jour par la règle du § 6, et dit pourquoi.

**Il n'est pas, et le texte ne le dit nulle part, une protection** :

- **contre une origine hostile** : elle peut **refuser** (plancher abusif → refus : déni de service,
  déjà à portée d'une origine qui cesse de servir) et peut **publier une version plus ancienne**,
  présentée en état 4 sans aucun refus (F8) ;
- **contre le gel** : une réserve ancienne reste servie hors connexion, indéfiniment si l'origine
  disparaît ;
- **contre le retour arrière** ;
- **ni une promesse de fraîcheur** : sans réseau, ou si l'origine cache une révocation, un ancien SW
  ne peut pas savoir qu'il est révoqué ; la date de sa réserve ne le dit pas.

Il n'y a **aucune durée maximale hors connexion** avant le jalon 6 (inchangé depuis l'ADR 0046).

### 10. Le coût d'accès du refus sans SW (Q1), écrit

Refuser de démarrer sans SW **coûte l'accès** à ceux dont le navigateur ou le mode ne l'offre pas.
Ce que l'on sait, avec ses limites :

- **Navigation privée de Firefox** : le SW y est annoncé corrigé depuis Firefox 138 selon le
  [bug 1320796](https://bugzilla.mozilla.org/show_bug.cgi?id=1320796) (**lu, non mesuré**). Le spike
  a posé une préférence de navigation privée sur Firefox : le SW s'est activé, mais OPFS restait
  disponible, ce qui n'est pas une vraie navigation privée — **rien n'est rapporté de mesuré sur ce
  mode**. Le coffre exige déjà l'OPFS (`docs/compatibility.md`) : là où l'OPFS manque, il y avait
  déjà refus (`VAULT_STORAGE_UNSUPPORTED`) ; ce qui s'ajoute est le cas où l'OPFS existe et le SW
  non.
- **Modes sans SW** : stratégies d'entreprise ou préférences qui désactivent les Service Workers
  (`dom.serviceWorkers.enabled`), navigateurs sans l'API, contextes non sécurisés.
- **Quota insuffisant ou refus d'installation** : la réserve pèse ≈ 2,9 Mio (+ le script, ≈ 51 ko).
- **WebKit** : voir § 14 ; l'éviction de la réserve y est un cas **normal**.

**Conduite** (au registre, en langage humain) : « Ce navigateur ne peut pas garder la coquille sur
cet appareil. Ouvrez le coffre dans une fenêtre normale d'un navigateur à jour. » Aucun
contournement (« démarrer quand même ») n'est offert : un seul chemin de code, une liaison
inconditionnelle. Le coût est **assumé** et sera revu si une mesure montre qu'une population
significative est exclue (issue de suivi : voir « Preuves »).

### 11. Retrait, et évolution de l'URL et du préfixe (Q5)

**Retirer le SW — par l'origine (kill-switch).** Publier **à la même URL** (`/sw-coquille.mjs`) un
**script de retrait** : désinscription, suppression des caches `reserve-*`, message aux clients.
**Un 404 ou un 410 ne retire rien** (S8 : l'inscription survit) ; **l'absence n'est pas un
kill-switch**. Le script de retrait suit **la même règle d'activation** que toute version (§ 6) :
installé, il **attend** la disparition de tous les clients — aucun retrait « immédiat » n'est
promis. Pendant l'attente, un onglet nouveau voit « révocation connue » (état 1) et **refuse** ;
l'onglet en session continue sans mélange (R1).

- **Ordre : caches d'abord, désinscription ensuite.** Coupé entre les deux, le SW de retrait reste
  actif **sans cache** : la page le reconnaît (`PERIMEE`, cause `retrait`) et le geste de la
  personne achève l'opération (idempotent). L'ordre inverse laisserait des caches **orphelins**,
  jamais servis, supprimés par la version suivante. Aucun des deux n'est une panne (R3, R4).
- **Réseau coupé** : le script de retrait n'est jamais vu ; l'ancienne version est servie et dit «
  non vérifiable » : **limite écrite** (R2).

**Retirer le SW — par la personne.** Un geste « Retirer la copie hors connexion » : `unregister()`
**et** suppression des caches, puis rechargement (S12 : `unregister()` seul laisse le cache ; la
page courante reste contrôlée jusqu'à sa navigation).

**Le retrait est borné à la coquille (2e contre-examen, constat 5).** Il ne touche **que** :

- **l'inscription de la coquille** : celle dont le `scope` est la racine de l'origine **et** dont le
  `scriptURL` d'un des Workers (actif, en attente, installant) est `/sw-coquille.mjs`, retrouvée par
  `getRegistration("/")` puis **vérifiée sur son `scriptURL` avant `unregister()`**. **Jamais**
  `getRegistrations()` suivi d'une désinscription de toutes ;
- **les caches dont le nom commence par `reserve-`** (et, à la migration d'un préfixe, les anciens
  préfixes **nommés** — ci-dessous).

Une inscription distincte (autre portée, autre script) et un cache d'un autre nom de la même origine
**survivent** : une épreuve les crée et le vérifie. Le prototype désinscrivait toutes les
inscriptions de l'origine (`portail.mjs`, `retirer`) ; R5 ne vérifiait que la conservation d'un
autre **cache**. Ce sont des écarts du banc (« Preuves »). Mutants « tous les caches » et « toutes
les inscriptions » : tués dans D1h-b.

**Fichier du SW altéré par l'origine.** Il s'installe comme une mise à jour (voir « Ce que le
Service Worker protège »). Il ne peut en revanche pas empêcher son propre remplacement : la requête
du script ne passe pas par le SW.

**Faire évoluer le préfixe ou l'URL — procédure écrite, non éprouvée.**

1. **Préfixe de cache.** La version qui change de préfixe embarque la liste **fermée** des anciens
   préfixes du produit (`PREFIXES_ANCIENS`) ; à son activation elle supprime, **par nom**, les
   caches des anciens préfixes en plus des siens. Jamais « tout ce qui n'est pas à moi ».
2. **URL du script.** À l'**ancienne** URL, publier un **script de migration** — le script de
   retrait du § 11, mêmes règles d'activation. Une fois tous les clients disparus, il supprime les
   caches et se désinscrit ; la navigation suivante n'a plus de contrôleur, la page (servie par le
   réseau, donc **un nouveau bootstrap de confiance**, § 4) enregistre la **nouvelle** URL. Le
   script de migration reste publié **tant que des clients peuvent porter l'ancienne inscription**,
   sans date de fin connue ; y mettre fin est une **décision du mainteneur, inscrite dans un
   amendement de cet ADR**, avec une date annoncée : après quoi un 404 ne retire rien, et les
   inscriptions orphelines gardent leur réserve (limite écrite).
3. **Retirer le mécanisme entier** (renoncer au SW) suit le même chemin : script de retrait publié à
   l'URL stable, durée de rétention décidée par le mainteneur, puis `SECURITY.md` rétabli dans sa
   rédaction du 07/09/2026 par un nouvel ADR.
4. **Écarté** : un SW « d'ancien nom » éternel qui redirige vers le nouveau (plus de surface, à
   garder pour toujours).

**Exigence de D1h-b** : éprouver les points 1 et 2 sur les trois moteurs (au moins le point 2 sous
Chromium et Firefox), faute de quoi cette procédure reste **« écrite, non prouvée »** (« Preuves »).

### 12. Interaction avec le SW applicatif (ADR 0038) et l'ADR 0002

Deux origines, deux inscriptions, deux scripts, **aucun canal implicite**. Mesuré (S13, trois
moteurs) : le SW de la coquille ne voit **aucune** requête vers l'origine applicative (navigation du
cadre comprise) ; le SW applicatif ne voit que ses clients ; le cadre applicatif ne peut pas
enregistrer de SW sur l'origine de la coquille (`SecurityError`). Règles :

- le SW de la coquille n'écoute que les clients (fenêtres et Workers) de **son** origine ; messages
  en liste fermée (§ 7) ; **aucune donnée du volume n'y transite** (les messages page ↔ Worker de
  confiance ne passent pas par lui, et le SW ne voit **aucune clé**) ;
- ni `clients.matchAll` vers l'extérieur, ni `postMessage` vers le cadre ; la CSP (`frame-src`) ne
  change pas ;
- **une requête inter-origine du propre client** du SW (une page contrôlée, un Worker contrôlé qui
  vise l'origine applicative) est **refusée** (`HORS_ORIGINE`) : l'autre origine reçoit **0**
  requête (L1, avec une page de la réserve **sans CSP**, client contrôlé réel). La CSP de la
  coquille (`connect-src 'self'`) est la première barrière, le SW la seconde — **et rien ne prouve
  qu'il ne reçoit jamais d'événement** pour une telle requête : il en reçoit, et il refuse ;
- COOP posé sur la réponse fabriquée : `window.opener === null` depuis une origine tierce, cadrage
  tiers refusé (S14).

L'ADR 0002 **prévoyait déjà deux Service Workers** ; sa partition sépare deux **origines** et ne dit
rien d'un tiers installé **dans** l'une d'elles : ce que cet ADR ajoute, en le disant (voir « Ce que
le Service Worker protège »). Le SW de la coquille **n'élargit pas** ce que l'origine hostile peut
déjà faire (servir le code de la coquille) ; il **prolonge sa durée** et la **rend moins visible**.

### 13. Refus typés

Cinq codes au registre `refus-de-coquille.mjs`, chacun avec une **cause** de diagnostic, une
conduite en langage humain et une ligne dans `docs/format-de-volume-v3.md` § 10 :

| Code `VAULT_COQUILLE_…` | Cas (causes)                                                                                                                                                                                          | Conduite                                                                                                                                                                                                                                                                                                                                     |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RESERVE_ABSENTE`       | pas d'API (`api-absente`), pas de contrôleur (`aucun-controleur`, `inscription-sans-controle`), SW muet (`silence-du-sw`), installation impossible (quota, refus), jamais installée et hors connexion | « Ce navigateur ne peut pas garder la coquille sur cet appareil. Ouvrez le coffre dans une fenêtre normale d'un navigateur à jour. »                                                                                                                                                                                                         |
| `RESERVE_INCOMPLETE`    | entrées manquantes (`entrees-manquantes` : éviction, installation interrompue)                                                                                                                        | en ligne : le SW **refait** la réserve (message `reparer` : seules les entrées manquantes ou altérées sont retéléchargées, chacune écrite **après** vérification ; il n'active rien), puis on réessaie ; hors connexion : « Reconnectez-vous une fois : la copie gardée sur cet appareil est incomplète. Vos données ne sont pas touchées. » |
| `RESERVE_ALTEREE`       | taille ou empreinte différente (`entrees-alterees`)                                                                                                                                                   | même conduite ; l'entrée abîmée est supprimée                                                                                                                                                                                                                                                                                                |
| `RESERVE_DIVERGENTE`    | contrôleur d'une autre version que la page (`sequence`, `controleur-change`, `worker-d-une-autre-version`) ; ou `libv86` de la réserve ≠ manifeste v86 scellé                                         | « La coquille a changé pendant l'ouverture. Rechargez la page. »                                                                                                                                                                                                                                                                             |
| `RESERVE_PERIMEE`       | révocation connue (`plancher`) ou retrait (`retrait`)                                                                                                                                                 | « Cette version a été retirée par son éditeur. Elle se remplace ; fermez toutes les fenêtres du coffre, puis rouvrez-le. »                                                                                                                                                                                                                   |

**Aucun démarrage sur une réserve partielle** : le portail (tout ou rien) et la vérification de
chaque service (une entrée altérée **après** le portail est refusée : S5, P4). Un `import()` refusé
par le SW échoue de façon **générique** côté Worker (`Failed to fetch dynamically imported module`)
: **le code typé ne passe donc pas par l'import**, il passe par le portail. Les refus fabriqués
(503, `X-Vault-Refus`) ne servent qu'au diagnostic. Un refus **n'efface aucune donnée** : le magasin
OPFS et la réserve du SW **s'évincent indépendamment** ; un coffre peut avoir l'un sans l'autre, et
chaque cas a son refus typé (`HORS_LIGNE_SANS_COPIE` côté magasin, `RESERVE_*` côté SW).

### 14. Les trois moteurs

Mesuré le 18/11/2026 (Linux arm64, Playwright 1.62.1, headless) : **Chromium 151.0.7922.34, Firefox
153.0, WebKit 26.5** — le build Playwright, **pas Safari**. 208 couples épreuve × moteur au vert sur
le banc ; la table est dans `docs/mesures/spike-sw-coquille-d1h/` et dans
[#299](https://github.com/pinfada/railsbox-vault/issues/299#issuecomment-6975729596).

| Moteur       | Particularités mesurées                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Chromium** | `setOffline` se comporte comme attendu (coupe ce que le SW ne sert pas). Installation 0,4–0,6 s. Seul moteur où le boot Rails est **prouvé** derrière le SW (152 s, page de référence rendue). Garde « client `window` » inatteignable depuis un Worker dédié.                                                                                                                                                                                                                                                                                |
| **Firefox**  | **`setOffline` sans effet** quand un SW est installé : « réseau coupé » s'obtient en **arrêtant le serveur**. Installation la plus lente (1,3–3,4 s). Un Worker dont le graphe est refusé **n'émet aucun `error`**. Un SW de retrait actif **ne donne aucun contrôleur**. Déverrouillage prouvé ; boot Rails **non prouvé** (baseline du dépôt : Rails n'y a jamais répondu, ADR 0038 ; témoin sans SW : même blocage).                                                                                                                       |
| **WebKit**   | SW (classique et module), `Cache` et prise de contrôle fonctionnent en contexte éphémère. **`setOffline` coupe aussi ce que le SW sert.** Deux `updatefound` sur une installation en échec. **Pas d'`navigator.storage` ni d'OPFS dans ce build** : quota non mesurable, **déverrouillage non prouvable**, **boot non prouvable**. `only-if-cached` y est ignoré (donc inutile : le SW répond). Le cadre tiers y est chargé depuis le réseau (stockage tiers partitionné) : COOP honoré, le refus de cadrage vient des en-têtes de l'origine. |

**Lu, non mesuré, sources datées — à ne pas citer comme mesure.** WebKit plafonne à 7 jours
d'inactivité les stockages « scriptables » ; la `Cache API` n'est pas listée explicitement dans les
sources trouvées, les inscriptions de SW le sont
([bug WebKit 211775](https://bugs.webkit.org/show_bug.cgi?id=211775) ;
[synthèse Safari 13.1](https://mjtsai.com/blog/2020/03/26/safari-13-1-third-party-cookie-blocking-and-7-day-script-writeable-storage/))
; les applications ajoutées à l'écran d'accueil ont leur propre compteur (contesté). **Conséquence
de conception** : l'éviction est un cas **normal**, pas exceptionnel — d'où `RESERVE_INCOMPLETE`
avec réparation en ligne. **Safari macOS/iOS réel n'est mesuré nulle part** : aucune annonce
publique sur Safari n'est autorisée par cet ADR (cf. `docs/compatibility.md`).

### 15. Révision de `SECURITY.md` § « Aucun Service Worker sur l'origine de confiance »

La section est **réécrite et datée** ; l'ancienne rédaction est **conservée en historique** dans
`SECURITY.md`. **La règle ne change d'état « en vigueur » qu'avec D1h-b** : à la fusion de cette PR
documentaire, la phrase « aucun Service Worker n'existe sur l'origine de confiance » reste vraie, et
`tests/unit/coquille-sans-service-worker.test.mjs` reste inchangé (il rougirait si un appel
d'enregistrement apparaissait). D1h-b le transforme en **liste blanche**.

Les motifs de l'ADR 0030 (décision 4), repris un à un :

| Motif du refus (ADR 0030)                                                              | Ce que cet ADR en fait                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| du code **privilégié** interposé entre l'hébergeur et la coquille, voit chaque requête | **vrai, et accepté** : **un seul** SW, **généré**, **épinglé dans la publication**, éprouvé, qui n'écoute que son origine et ne voit aucune clé                                                       |
| survit à la fermeture de l'onglet                                                      | **vrai, et c'est la fonction** (S22 : navigateur fermé puis rouvert, origine morte, page et Worker servis) ; la durée de vie est bornée par la procédure de retrait (§ 11) et le geste de la personne |
| se met à jour par un chemin distinct                                                   | **vrai, et encadré** : version = contenu, jamais en cours de session, racine d'inventaire comparable hors bande, `update()` explicite, états de fraîcheur affichés                                    |
| « l'hébergeur à en-têtes est exigé de toute façon, le SW ne résoudrait rien »          | **faux pour le hors connexion et pour la liaison**, qu'aucun en-tête n'apporte. L'hébergeur à en-têtes reste exigé ; le SW n'est **pas** une substitution (ADR 0017)                                  |
| un `<meta>` ne porte ni COOP ni `frame-ancestors` : pas de troisième voie              | inchangé : le SW **n'est pas** une réponse à l'hébergeur sans en-têtes ; il les **rejoue** depuis `securityHeaders()`, il ne les invente pas                                                          |

Le refus devient : **« aucun autre Service Worker que celui-ci »**, surveillé par la liste blanche
(un appelant d'enregistrement dans l'arbre `coquille`, un script SW publié ; côté `application`,
uniquement `service-worker-du-cadre.mjs`).

## Ce que le Service Worker protège, et ce qu'il ne protège PAS

**Protège** (mesuré sur le banc) :

- l'**accident** : cache qui garde une version à côté d'une autre, octet retourné, installation
  interrompue, éviction partielle (portail + vérification à chaque service) ;
- une **origine qui répond autrement selon la requête** (la classe E1 de #298) **après
  l'installation** : les octets exécutés sont ceux de la réserve (S3) ;
- un **écrivain de même origine dans le `Cache`** (extension, bogue) : détecté au service (S5) ;
- le **mélange de versions** en cours de session (§ 6) ;
- la **disponibilité hors connexion**, y compris après fermeture du navigateur (S22) et sous les
  en-têtes de production (S18).

**Ne protège pas** — et personne ne doit l'écrire autrement :

- **l'origine hostile qui sert un SW hostile.** Un SW altéré s'installe comme une mise à jour
  légitime ; la liste d'empreintes est dans le script qu'elle contrôle. **Rien n'y répond avant la
  signature des paquets (jalon 6)** ; la liaison est **relative** à la liste du SW, pas à une racine
  extérieure ;
- **la première installation** et tout chargement **sans contrôleur** : TOFU ; le bootstrap n'est
  pas vérifié (§ 4) ;
- le **gel de version** : une réserve ancienne reste servie hors connexion, indéfiniment si
  l'origine disparaît ; une révocation publiée pendant la coupure n'est pas vue ; **aucune durée
  maximale hors connexion** ;
- le **retour arrière** : une origine peut publier une version plus ancienne (état 4 : elle est
  **dite**, pas empêchée) ;
- **la persistance d'un SW altéré** : il reste actif jusqu'à ce que le navigateur voie un script
  différent. Borne **mesurée mais non garantie** : une navigation redemande le script (la
  spécification n'exige que 24 h ; Chromium a relevé des navigations sans redemande, S10) ; le
  script ne passe pas par le SW altéré, donc l'origine redevenue saine le remplace — mais **il peut
  servir du code hostile pendant l'intervalle** ;
- une **fenêtre ouverte depuis longtemps** reste sur sa version ;
- **`v86.wasm`** et ce que porte `/artifacts/` : liés par le magasin de #298, pas par ce SW ;
- l'**éviction réelle**, **Safari réel**, la **navigation privée réelle**, l'**hébergeur réel**
  (`_headers`) : non mesurés.

**Ce que le SW ne change pas** : il ne voit aucune clé ; il **ne donne pas plus de pouvoir** à
l'origine hostile, qui sert déjà le code de la coquille. Il **prolonge sa durée** et la rend moins
visible. C'est le coût réel, écrit tel quel.

## Ce qui est écarté, et pourquoi

| Écarté                                                                                                     | Pourquoi                                                                                                                  |
| ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Option (a), accepter la limite ; option (c), `blob:` dans la CSP ; (d) émulateur en fenêtre ; (e) attendre | décision du mainteneur (b) ; (c) refusée par l'ADR 0013 ; (d) inapplicable : l'OPFS synchrone n'existe que dans un Worker |
| `skipWaiting`, même conditionnel ; `clients.claim()` ; message d'activation                                | mélange de versions (S6b, A2) ; la page ne doit s'exécuter que sous le SW dont elle porte la version                      |
| « hors liste → réseau »                                                                                    | le code de l'origine hostile s'exécute (G3, mutant tué) ; promesse de couverture impossible                               |
| Réserve calculée depuis le graphe d'imports ; préfixes (`/src/`, `/vendor/`)                               | partielle par construction ; sert ce qui n'est pas épinglé                                                                |
| Cache nommé par la séquence, supprimé avant installation                                                   | écrase le cache actif sous collision (2e contre-examen, constat 4)                                                        |
| Mémoïser la vérification pour la durée de vie du SW                                                        | un écrivain de même origine altère le `Cache` entre deux services (S5)                                                    |
| Mode « en ligne, sans réserve » sans SW                                                                    | second mode du produit ; liaison de `libv86` redevenue limitée ; une garde et une épreuve de plus par moteur (Q1)         |
| SW de module ; `Service-Worker-Allowed` ; `importScripts` ; `instantiateStreaming`                         | dépendance de plus, non mesuré en deçà de Firefox 153 ; hors périmètre ; non revendiqués                                  |
| Faire servir `v86.wasm` par le SW                                                                          | +72 % de réserve, non mesuré ; la liaison existe côté magasin de #298                                                     |
| Un SW « d'ancien nom » éternel                                                                             | plus de surface, à garder pour toujours (Q5)                                                                              |
| Présenter le plancher comme une protection                                                                 | il est non signé : une origine hostile peut le refuser ou publier plus ancien (F8)                                        |

## Preuves, et ce que le banc ne démontre PAS

**Le banc** (`tools/spike-sw-coquille/`, README de rejeu) : 70 épreuves × 3 moteurs, **208/208** au
vert à la révision du 18/11/2026 ; sorties brutes datées sous `docs/mesures/spike-sw-coquille-d1h/`.
Ce que le banc **prouve** : la liaison (S3), la garde fermée (G), le protocole multi-onglets (A1),
la mise à jour sans mélange, les refus du portail et leurs courses (P), le retrait (R), les en-têtes
(S2), le déverrouillage et le boot Rails sous Chromium (B1), les refus sans boot (B2).

**Ce que le banc ne prouve PAS, et que D1h-b doit livrer** — écarts nommés entre le prototype et les
décisions ci-dessus (**les cinq exigences du 2e contre-examen**) :

| #   | Exigence                                                                                                                  | État du banc                                                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | révocation connue **après** le délai : observée en session, annoncée visiblement, session non interrompue (§ 8)           | **non satisfait** : le portail retire son écouteur après sa décision ; F7 recalcule à la main, sans bandeau                                        |
| 2   | attente **muette** non vérifiable ; version en attente **différente ou plus ancienne** : texte exact (§ 8)                | **non satisfait** : l'attente muette reçoit une identité fictive et l'état « prête » ; F8 constate qu'une version plus ancienne est dite « prête » |
| 3   | absence de **l'API** `navigator.serviceWorker` : refus typé sans Worker ni clé (§ 7)                                      | **non satisfait** : le portail lit `navigator.serviceWorker.controller` sans garde ; G7 bloque les inscriptions et garde l'objet API               |
| 4   | **identité de cache par contenu** ; cache actif jamais écrasé ; collision, retour arrière, installation interrompue (§ 5) | **non satisfait** : cache nommé par la séquence, supprimé avant l'installation et en cas d'échec                                                   |
| 5   | **retrait borné à l'inscription de la coquille** ; inscription distincte conservée et éprouvée (§ 11)                     | **non satisfait** : le geste désinscrit **toutes** les inscriptions de l'origine ; R5 ne vérifie que la conservation d'un autre **cache**          |

**Autres limites du banc.** (a) Les **mutants** sont des interrupteurs dans le code du banc, **pas**
une campagne de mutation du source : la campagne `reserve` de `tools/rejouer-les-campagnes.mjs`
n'existe pas. (b) **Survivants du banc, dits et NON présumés équivalents** : _taille non comparée_
(M2) a survécu au banc ; l'hypothèse « le hachage la couvre » **n'est pas une preuve d'équivalence**
(le contrôle de taille borne le coût avant de hacher : effet observable), et D1h-b doit le tuer ou
prouver son équivalence ; _installation lisant le cache HTTP_ (M4) n'est tué que sous Chromium ; la
garde « client `window` » (P2) n'est pas tuée sous Chromium. **Les survivants du prototype et les
limites de moteur ne remplacent pas la règle des mutants de l'annexe A** (zéro survivant pertinent
sur le source). Une épreuve qui ne rougit pas sous son mutant est écrite comme telle. (c) **la
réparation en ligne** (`reparer`, § 13) n'est **pas prototypée** : le banc nomme `INCOMPLETE` et
`ALTEREE` mais ne refait rien ; (d) **S10 non garanti** : la redemande du script à la navigation
varie d'une exécution à l'autre ; d'où `update()` explicite. (e) Le portail typé, l'enregistrement
par la page, la liste générée à la publication et les codes au registre **n'existent pas** : c'est
D1h-b. (f) La preuve est celle d'**un** banc, sur Linux arm64, headless.

**Pas prouvé du tout** (à écrire dans `SECURITY.md` et à suivre par issue) :

- **Safari réel** (macOS, iOS), éviction réelle, règle des 7 jours, navigation privée réelle,
  **hébergeur réel** ;
- **boot Rails sous Firefox** (baseline du dépôt) ; **déverrouillage et boot sous WebKit** (OPFS
  absent de ce build) ;
- **rechargement forcé** (Ctrl+Maj+R), **bfcache**, installation sous un **vrai** réseau lent, quota
  **réel** hors Chromium (injection seulement), la règle des 24 h du navigateur ;
- **la procédure de migration** (§ 11), décrite, **non éprouvée** ;
- l'origine exacte des 503 vus en console pendant le vrai boot (`refus: []` côté SW ;
  vraisemblablement la page d'attente du SW de cadre applicatif) : non vérifiée.

## Compatibilité persistante

- L'**inscription du SW est persistante** et survit à la fermeture du navigateur : c'est la
  fonction.
- **`/sw-coquille.mjs`, la portée `/` et le préfixe `reserve-` sont stables**, évolutifs **par la
  procédure du § 11** (non éprouvée).
- **Le format de la liste embarquée n'est pas un format persistant** : elle vit dans le script, qui
  est remplacé par le navigateur. Le **nom de cache** (`reserve-<empreinte>`) est, lui, persistant
  jusqu'à l'activation suivante.
- Aucun format de volume, d'archive ou de descripteur ne change.
- **Retour arrière de D1h-b** : publier un script de retrait (§ 11) ; la PR D1h-b est annulable
  seule (elle supprime le harnais de #298 : l'annuler le rétablit).

## Annexe A — DoR gelée de D1h-b

D1h-b est la **seule** PR qui ferme #299. Elle démarre **après la fusion de #298** (Q6). **Règle de
fusion** : la délégation en vigueur (mainteneur, 18/11/2026 au soir) — revue de sécurité complète
**APPROUVÉE au SHA exact**, contrôles requis verts, limites écrites ; aucun accord écrit
supplémentaire n'est exigé. La décision d'option (b) n'est pas rouverte.

**Résultat.** Sans réseau, la coquille publiée s'ouvre, déverrouille et démarre le coffre depuis la
réserve (SW + magasin OPFS de #298), sous les en-têtes de production, **sans harnais**. **Pour tout
client contrôlé**, chaque octet de **code** exécuté (script, module, Worker, `libv86`,
`argon2.wasm`) est celui que le SW a vérifié contre sa liste embarquée, et toute requête hors liste
et hors passage nommé est **refusée**. La première visite et toute page sans contrôleur relèvent du
**bootstrap de confiance**. Une réserve absente, incomplète, altérée, divergente, périmée ou retirée
produit un **refus typé** en langage humain et **aucun démarrage**.

**Dépendances.** #298 fusionnée (ADR 0046, magasin, descripteur scellé) ; cet ADR fusionné ; les
réponses Q1, Q2, Q3, Q5 (acquises).

**Périmètre.** § 2 à § 4 ; clé = chemin exact ; réserve présente **uniquement** dans l'arbre publié
; `/artifacts/**` jamais servi. Livrables : générateur pur de la réserve
(`tools/publier-reserve.mjs`, liste = arbre − `EXCLUS_DE_LA_RESERVE`, **épreuve qui échoue sur toute
surprise**, patron de `publication-arborescences.test.mjs`) ; modèle du SW (un fichier, sans import)
; portail et enregistrement (`public/coquille/reserve-de-la-page.mjs`) ; module généré
`reserve-publiee.mjs` ; observateur de fraîcheur (§ 8) ; bandeau ; codes au registre, conduites,
`docs/format-de-volume-v3.md` § 10 ; `_headers` du script du SW (`no-cache`, nature `coquille`) ;
script de retrait écrit, éprouvé et mis dans `docs/` ; geste « Retirer la copie hors connexion » ;
`coquille-sans-service-worker.test.mjs` transformé en liste blanche.

**Retiré de #298 par D1h-b** (noms de la branche `lot-d1g-hors-ligne`, à re-vérifier sur `main`
après la fusion) : `lireDuCacheHttp` et le chemin `only-if-cached`
(`src/vm/acquisition-des-artefacts.mjs`) ; `tests/unit/vm-lecture-de-libv86-hors-connexion.test.mjs`
et les épreuves de `lireDuCacheHttp` dans `tests/browser/descripteur-scelle.spec.mjs` ; le mutant
correspondant de `tools/muter-gardes-hors-ligne.mjs` ; **le harnais** : `--harnais-e2e-hors-ligne`
(`tools/serve.mjs`), `VAULT_E2E_CODE_MAX_AGE` (`playwright.e2e.config.mjs`), la matrice
`code_en_cache` de `.github/workflows/reprise.yml`, `tests/unit/serve-harnais-hors-ligne.test.mjs` ;
l'amendement de l'ADR 0046 § 6 (le texte « `libv86` n'est PAS lié » devient historique, daté).
**Conservée** : `verifierLeModuleV86` (recoupement réserve ↔ manifeste v86 scellé).

**Critères d'acceptation automatisables** (chacun a son prototype dans le banc, sauf mention) :

1. hors connexion, après fermeture et réouverture du navigateur, la coquille démarre (trois moteurs,
   serveur **arrêté** ; E2E Chromium) ;
2. l'origine qui répond « MAUVAIS » n'est jamais exécutée par un client contrôlé ;
3. entrée altérée, supprimée, SW absent, **API absente**, SW muet → refus typé, **aucun Worker,
   aucune clé, aucune requête de boot** ; en ligne, `INCOMPLETE` et `ALTEREE` déclenchent la
   **réparation vérifiée** (`reparer`) puis un réessai, hors connexion le refus reste ;
4. **deux onglets** : mise à jour sans mélange, application après fermeture de **tous** les clients,
   aucun `controllerchange` ;
5. les **sept états + nominal** et leurs effets, dont les courses `update()`/installation,
   l'installation rejetée, **l'attente muette**, **la version différente ou plus ancienne**, et **la
   révocation arrivée après le délai** (annonce visible, session non interrompue, aucun Worker
   neuf), et **la course à la création** : « vérification suspendue → révocation connue avant la
   reprise → **zéro Worker, zéro clé** » (la vérification complète est suspendue, la révocation est
   observée pendant l'attente, la vérification reprend et rend « tout est bon » : le portail refuse
   `PERIMEE`), puis la même épreuve sur un **second portail** de la même page (verrouillage,
   réouverture), l'état de révocation n'ayant pas reculé ;
6. garde fermée : URL inattendue, variantes, redirections, types, destinations, hors origine,
   méthodes ;
7. retrait par script (onglets actifs, attente, interruption entre caches et désinscription, réseau
   coupé) et par geste, **borné à l'inscription et aux caches de la coquille** ; **une inscription
   distincte et un cache d'un autre nom survivent** ;
8. **identité de cache par contenu** : collision (même séquence, contenu différent, clients ouverts
   : l'actif intact), même contenu et plancher relevé, retour arrière, installation interrompue ;
9. égalité des en-têtes servis par le SW et par le serveur, chemin par chemin ;
10. liste blanche d'enregistrement ;
11. deux origines sans canal, requête inter-origine du propre client refusée ;
12. **migration** : préfixe de cache (anciens préfixes nommés supprimés, autres caches intacts) et
    URL (script de migration à l'ancienne URL, nouvelle inscription après retrait) ;
13. **E2E sur l'arbre publié, en-têtes de production, sans harnais**
    (`tests/e2e/hors-ligne.spec.mjs`, `tools/publier-servir.mjs` appliquant le `_headers` produit,
    les deux rôles) : (a) première visite en ligne → installation → navigation → déverrouillage →
    boot Rails → page rendue ; (b) origine **arrêtée** (+ magasin de #298) → **nouvelle navigation**
    → déverrouillage → boot depuis la réserve ; (c) refus **sans boot**, chacun avec **zéro requête
    de boot** (image, `v86.wasm`) : entrée altérée, supprimée, SW absent, API absente, SW muet,
    version périmée, retrait, changement de contrôleur, avec les **codes typés du portail**.
    Chromium pour le boot ; Firefox et WebKit pour ce qui ne dépend pas du guest. Repli si l'E2E ne
    peut pas servir l'arbre publié avec les deux rôles : `serve.mjs --arbre`, **à décider en
    D1h-b**.

**Preuve.** Unitaires (générateur ; décision pure ; **le script du SW exécuté dans un `vm`** avec
`caches`/`fetch`/`crypto` factices : altération, manque, installation en échec, activation,
collision) + navigateur trois moteurs (`playwright.config.mjs`, projets `reserve-*` ; « réseau coupé
» = **arrêt du serveur**, jamais `setOffline` — Firefox et WebKit, S21) + E2E ; **campagne
`reserve`** de `tools/rejouer-les-campagnes.mjs` **sur le source** ; rouge/vert documentés ; revue
de sécurité distincte, complète, APPROUVÉE au SHA exact (règle de fusion ci-dessus) ; **zéro mutant
pertinent survivant sur le source** (règle ci-dessous).

**Règle des mutants (constat de la revue de #312).** D1h-b exige **zéro mutant pertinent survivant
sur le source**. Un mutant est **tué** s'il rougit une épreuve **nommée**, sur le source du produit
(campagne `reserve`), dans au moins un projet où la garde est atteignable. Un mutant allégué
**équivalent** exige une **preuve d'équivalence spécifique** à ce mutant (argument écrit et, quand
c'est possible, épreuve qui le montre) : ni les **survivants du prototype**, ni une **limite de
moteur** (garde inatteignable sous un moteur, comportement qui diffère), ni « le hachage couvre déjà
» ne remplacent cette preuve. Sans elle, le mutant est un survivant et **bloque la fusion**. Un
mutant qu'aucun projet n'atteint est lui aussi un survivant, tant qu'il n'est pas prouvé équivalent.

**Gardes à muter** (chaque ligne rougit une épreuve nommée ; aucune n'est dispensée par la règle
ci-dessus) :

1. service sans recalcul du SHA-256
2. taille non comparée (service **et** installation) — **non présumée équivalente** : le contrôle de
   taille a un effet observable (refus avant tout hachage, borne du coût, cause nommée). À tuer par
   une épreuve (une entrée de taille anormale est refusée **sans appel au hachage**), ou à prouver
   équivalente par une preuve spécifique ; « le hachage la couvre » ne suffit pas
3. installation qui accepte un écart
4. installation lisant le cache HTTP (`no-store` retiré)
5. cache partiel non supprimé après un échec **que cette installation a créé**
6. `skipWaiting` automatique
7. `clients.claim()`
8. nom de cache **non dérivé du contenu** (nommé par la séquence)
9. **`caches.delete` d'un cache existant à l'installation**
10. activation qui supprime tout cache, ou un cache d'un autre préfixe
11. `/artifacts/**` servi par le SW
12. passage sans contrôle de destination, de chemin, de redirection ou de type
13. « hors liste → réseau »
14. « hors origine → réseau »
15. en-têtes lus du réseau au lieu d'être embarqués, ou CSP omise sur la navigation
16. `redirect: "error"` → `follow` (installation)
17. clé incluant la chaîne de requête
18. messages acceptés de tous les clients
19. **portail sans test de l'API**
20. portail qui n'attend pas `update()` / l'installation
21. portail sans re-contrôle, sans poignée de main, sans vérification, ignorant la révocation,
    contourné sans SW
22. **portail évalué une seule fois par page**
23. **observateur de fraîcheur retiré après la décision du portail**
24. **attente muette classée « prête »**
25. **version plus ancienne classée « prête »**
26. nom du script du SW changé
27. liste blanche d'enregistrement élargie
28. `updateViaCache` laissé par défaut
29. script de retrait qui ne vide pas les caches ; geste qui vide tout ; **geste ou retrait qui
    désinscrit toute inscription de l'origine**
30. migration qui supprime un cache d'un préfixe non listé
31. **`reparer` qui écrit une entrée sans la vérifier**, ou qui active une version
32. **état de révocation non monotone** (recalculé, remis à « inconnue », ou propre à chaque
    portail)
33. **dernière garde absente**, ou **un `await` entre la lecture de l'état de révocation et
    `new Worker`**
34. **observateur qui n'écrit pas dans l'état partagé** (le bandeau change, pas l'état)

**Ce qui ne se mute pas** (limites écrites, **pas** des mutants du source) : le comportement des
moteurs réels face à l'éviction ; l'hébergeur réel. La garde « client `window` » sous Chromium est
inatteignable depuis un Worker dédié : le mutant correspondant doit rougir son épreuve sous Firefox
et WebKit, et cette inatteignabilité sous Chromium est écrite — elle ne dispense pas du kill.

**Sécurité et compatibilité persistante qualifiées** : ce document et `SECURITY.md`. **Taille** :
D1h-a ≈ 0,5–1 j (cette PR) ; D1h-b ≈ 3,5 j (≈ 2 200 lignes ajoutées, ≈ 450 retirées, estimation du
défi).

**Hors périmètre.** Signature des paquets (jalon 6), lecture par tranches (D2), mise à jour
périodique d'une fenêtre ouverte, `Service-Worker-Allowed`, SW de module, SW applicatif,
`importScripts`, `instantiateStreaming`, `v86.wasm` servi par le SW.

## Amendement D1h-b (24/11/2026) — ce que l'implémentation a décidé, mesuré ou écarté

D1h-b livre l'annexe A. Ce qui suit est ce que l'implémentation a **ajouté ou précisé** ; rien de la
décision n'est rouvert.

1. **Le contrôleur actif porte lui-même un plancher.** Si le contrôleur **actif** annonce un
   plancher supérieur à la séquence de la page, la page est révoquée : `RESERVE_PERIMEE`
   (`plancher`). Cas réel : une version en attente révoquante s'active après la fermeture de tous
   les clients, puis sert une page de séquence plus ancienne. Mesuré par l'E2E (l'attente devenue
   active passait le portail), éprouvé en unitaire.
2. **Délai de grâce de 400 ms** (`delaiDeGraceMs`) après un `update()` résolu sans Worker installant
   visible. **Mesuré sous Chromium** : `update()` résout _avant_ `updatefound`, et
   `registration.waiting` n'est pas encore à jour quand `statechange` annonce `installed` ;
   l'observateur identifie donc le Worker qui vient de passer `installed` **par lui-même**, et le
   portail attend un instant l'apparition d'une version. Sans cela, le portail décidait avant de
   voir une révocation déjà publiée (l'observateur permanent l'annonçait alors après coup, sans
   refuser). Les délais de départ (§ 7 : 3 000, 5 000, 25 000 ms) sont **inchangés** ; ajoutés :
   réparation 60 000 ms, poignée de main 8 000 ms, grâce 400 ms. Aucun n'a été abaissé.
3. **`reparer` est implémenté et éprouvé** (n'était pas prototypé) : les entrées manquantes ou
   altérées sont retéléchargées (`no-store`, `redirect: error`, sans identifiants), **vérifiées**,
   puis écrites ; il n'active rien ; le portail le déclenche **une seule fois**, puis réessaie.
4. **Séquence de publication.** `tools/publier.mjs` prend `--sequence <n>` et `--plancher <n>` ; par
   défaut, la séquence est le **nombre de commits** de la référence (monotone sur `main`). Un dépôt
   superficiel retombe sur 1, avec un avertissement pour une publication de production. Le module
   `/coquille/reserve-publiee.mjs` (stub `null` dans le dépôt vivant) est **généré** et fait partie
   de la liste épinglée.
5. **Points d'implémentation.** La page ne crée le Worker de confiance **que** par le portail ; le
   Worker annonce sa séquence par son **dernier import** (`reserve-annonce-du-worker.mjs`), donc
   seulement une fois tout son graphe évalué ; la CSP et les en-têtes sont rejoués depuis la liste,
   jamais copiés du réseau.
6. **E2E : repli `serve.mjs --arbre` non retenu.** `tools/publier-servir.mjs` sert l'arbre publié
   sous son `_headers`, avec les **deux rôles**, un répertoire `--artefacts` pour `/artifacts/**`
   (l'image est une obligation d'exploitant, jamais publiée) et un crochet de **surcharge** pour
   faire mentir une origine ; l'épreuve démarre et **arrête** ses origines pour de vrai.
7. **Preuves** : unitaire (SW dans un `vm`, portail, générateur), 3 moteurs (`reserve-*`), E2E
   Chromium, campagne `reserve` du lanceur (`tools/muter-gardes-reserve.mjs`). Ajoutées après la
   première relecture, **vertes d'emblée** (elles servent de garde de non-régression) : redémarrage
   du navigateur sur **profil persistant**, origine arrêtée, déverrouillage et boot (E2E, critère 1)
   ; après un changement de contrôleur, dans la même page, zéro nouveau Worker (sonde de comptage à
   **témoin positif** et **témoin de mordant**) et zéro requête de démarrage (E2E, critère 13c) —
   **la « nouvelle ouverture dans la même page » n'existe pas dans le produit : écart déclaré, point
   9** ; retrait **interrompu entre la suppression des caches et la désinscription**, puis geste
   suivant (unitaire et 3 moteurs, critère 7). **Limite écrite** : la sonde est désactivée pendant
   les vrais boots (elle fait mourir le Worker de confiance pendant un boot réel, cause non
   cherchée).
8. **Limites inchangées et écrites** : Safari réel, éviction réelle, navigation privée réelle,
   hébergeur réel ; boot Rails Chromium seul ; l'origine applicative n'est pas dans la réserve ;
   TOFU et origine hostile avant le jalon 6 ; `tests/browser/reserve-messages.spec.mjs` ignorée sous
   Chromium (exception par projet, raison mesurée).
9. **ÉCART DÉCLARÉ au critère 5 (« second portail de la même page ») et au critère 13c — en attente
   de la décision du mainteneur.** Le produit n'appelle le portail **qu'une fois par document** ; il
   n'existe aucun parcours de seconde ouverture dans la même page, donc l'E2E ne peut pas en
   emprunter un. Preuve (code, hors commentaires) : le Worker de confiance n'est construit qu'à
   `public/coquille/canal-de-confiance.mjs:65`, par `creerCanalDeConfiance`, dont le seul appelant
   est le rappel de `public/main.mjs:211` ; le portail (`ouvrirLePortail`,
   `public/coquille/reserve-de-la-page.mjs:84`) n'est ouvert que par `public/main.mjs:213`
   (`pont.canal = await reserve.ouvrir();`, au niveau du module, évalué une fois par document).
   Verrouiller, rouvrir après la mort du Worker et la préparation de la première visite
   **rechargent** la page (`public/coquille/verrouillage-et-fins-d-onglet.mjs:44`,
   `public/coquille/cycle-de-la-page.mjs:168`, `public/coquille/reserve-de-la-page.mjs:52` et `:92`
   ; ADR 0031, décision 1 : verrouiller EST la fermeture propre suivie du rechargement) : un nouveau
   document, un nouvel état — l'anomalie de contrôleur, par page, n'y survit pas. Les gestes de
   réessai (phrase ou code faux, déverrouillage) passent par le canal déjà établi
   (`demanderAuWorker`), jamais par le portail ; aucun autre `new Worker` n'est un Worker de
   confiance (`src/coquille/derivation-dans-la-page.mjs:104` est le Worker de dérivation, sans clé
   de volume). La phrase du § 7, « un coffre verrouillé puis rouvert dans la même fenêtre repasse
   par lui », se lit donc « dans un nouveau document de la même fenêtre ». L'invariant « tous les
   portails partagent un état de révocation monotone et une anomalie de contrôleur qui ne se défait
   pas » reste **éprouvé en unitaire** (`reserve-portail.test.mjs` : second portail, état non
   reculé, anomalie de contrôleur) et sert de garde à tout parcours futur ;
   `tests/unit/reserve-un-seul-portail.test.mjs` est un **cliquet de l'accident, pas une preuve** :
   il balaie un périmètre de fichiers et des formes textuelles sur une seule ligne (`.ouvrir()`,
   `ouvrirLePortail(`, `creerCanalDeConfiance(`), exige que l'unique ouverture soit à la colonne 0
   (niveau du module, sans analyse syntaxique), et rougit si un nouvel appelant ÉVIDENT apparaît —
   il faudra alors l'éprouver en E2E. Il ne voit pas un appel renommé, coupé sur plusieurs lignes,
   dynamique ou hors périmètre : l'absence de tout second appelant repose sur la lecture du code
   ci-dessus. Aucun crochet de test n'est ajouté à la production. **Modification proposée au critère
   13c** : « après un changement de contrôleur, zéro nouveau Worker et zéro requête de démarrage
   dans la même page (éprouvé) ; une nouvelle ouverture dans la même page n'existant pas, le critère
   porte sur le rechargement, qui repasse par le portail normal ».
