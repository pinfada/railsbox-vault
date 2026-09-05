# ADR 0023 — la politique de cache est décidée par nature d'artefact, et une seule dimension varie selon le chemin

- Statut : accepté
- Date : 2026-09-04
- Issue : #103 · Invariants : `VAULT-DIST-001`, `SEC-UPDATE-001` · Jalon 2

## Contexte

Le risque résiduel n°1 de l'[ADR 0017](0017-chaine-de-publication.md) est écrit ainsi :

> **`Cache-Control: no-store` est publié tel que le serveur de test le sert.** C'est la conséquence
> directe de la règle « la production sert les mêmes en-têtes », et c'est un problème : `no-store`
> interdit toute mise en cache, alors que l'ADR 0002 prévoit **deux** Service Workers pour le mode
> hors ligne. Le conflit est nommé ici plutôt que résolu en douce ; le résoudre demande de décider
> une politique de cache par nature d'artefact — immuable pour le runtime épinglé, volatile pour la
> coquille — ce qui touche `tools/serve-headers.mjs`, hors périmètre de ce spike.

Cet ADR le résout, et suit pour cela l'ordre que l'[ADR 0022](0022-entetes-de-durcissement.md) a
établi pour les en-têtes de durcissement : la décision est posée **dans** `tools/serve-headers.mjs`,
la source de vérité de l'ADR 0017 § 2, donc servie d'abord en développement et mesurée par les
épreuves qui existent ; la publication l'en dérive sans écrire une politique à la main.

Il diffère de l'ADR 0022 sur un point, et c'est tout son intérêt : `Referrer-Policy` et
`Permissions-Policy` se décidaient **par rôle**, et l'arborescence pouvait rester sous une politique
unique. Une politique de cache, non : le même arbre porte 9,9 Mio d'ensemble v86 épinglé — les cinq
artefacts de `vendor/v86/MANIFEST.json`, `linux4.iso` compris, soit 10 351 229 octets — et 40 Kio de
coquille qui change à chaque version. La décider par rôle serait la décider une fois de trop.

## Ce qui a été établi, et comment

1. **La règle « politique uniforme » interdisait mécaniquement toute politique par nature.**
   `cheminsHorsPolitiqueUniforme()` refusait tout chemin dont `securityHeaders()` rendrait autre
   chose que la racine, et `rendreFichierHeaders()` n'émettait qu'un bloc `/*`. Rendre
   `Cache-Control` dépendant du chemin faisait donc échouer `construireArbre` sur « le fichier
   `_headers` annoncerait une politique uniforme que ces chemins ne reçoivent pas ». Le cliquet
   n'était pas un obstacle à contourner : il tenait une propriété réelle — ce qui est annoncé est ce
   qui est servi — qu'il fallait reconduire sous une forme plus fine, pas retirer.

2. **Aucune URL publiée ne nomme son empreinte.** `tools/publier-arborescences.mjs` copie
   `vendor/v86/artefacts/` tel quel : après une montée de version de l'émulateur,
   `/vendor/v86/artefacts/v86.wasm` rend d'autres octets **à la même adresse**. L'ADR 0003 épingle
   par SHA-256 dans `vendor/v86/MANIFEST.json`, pas dans le chemin. C'est le fait qui interdit
   `immutable`, dont la sémantique est « ces octets ne changeront jamais à cette URL ».

3. **L'épinglage v86 change d'un bloc.** Les octets, le manifeste qui les épingle et les licences du
   code redistribué proviennent tous de la même montée de version : `npm run vm:fetch` les remplace
   ensemble et `npm run vm:check` échoue si l'un ne correspond plus. Leur donner deux fenêtres de
   fraîcheur différentes reviendrait à autoriser un écart d'âge **arbitrairement grand** entre le
   manifeste et les octets qu'il décrit ; une seule fenêtre le borne à la durée de cette fenêtre.

   Elle ne fait que le **borner**, et la nuance est celle que HTTP impose : la fraîcheur se calcule
   par réponse, à partir de la date à laquelle CETTE réponse a été reçue. Un même `max-age` donne la
   même DURÉE de fraîcheur, jamais une expiration commune. Manifeste chargé à T0, émulateur demandé
   plus tard, montée de version à T0 + 1 h : le navigateur tient alors des octets frais devant un
   manifeste d'hier, et cela jusqu'à T0 + 24 h. Ce que la cohérence manifeste ↔ octets demande
   vraiment, c'est une vérification d'**empreinte au chargement** — travail découvert, **#123**.

4. **Le format `_headers` n'est pas un standard, et sa sémantique de fusion n'est garantie par
   personne.** Cloudflare Pages et Netlify cumulent les règles qui correspondent, la dernière
   l'emportant — c'est ce que `tools/publier-servir.mjs` reproduit. Le spike #45 relève déjà ce
   format comme une **convention partagée** et non comme une norme. Un bloc précis réduit au seul
   en-tête qui change dépendrait donc d'un comportement non spécifié, chez un hébergeur que ce dépôt
   n'a jamais mesuré.

5. **`no-store` n'interdit pas exactement ce que l'ADR 0017 lui prête.** La phrase « `no-store`
   interdit toute mise en cache » est trop forte : le stockage d'un Service Worker (`Cache`, « Cache
   Storage ») est un magasin **géré par le développeur**, que les directives HTTP de cache ne
   gouvernent pas — un `cache.put()` d'une réponse `no-store` est permis. La correction ne sauve pas
   `no-store` pour autant, et pour trois raisons qui tiennent toutes :
   - il ferme le **cache HTTP**, c'est-à-dire la seule couche qui travaille avant qu'un Service
     Worker soit installé, et celle qui reste quand il est cassé ou désinscrit ;
   - il est lu comme une **déclaration d'intention** par des tiers que ce dépôt ne contrôle pas —
     hébergeur, CDN, proxy d'entreprise. Publier `_headers` pour un hébergeur statique, c'est
     précisément parler à ces tiers-là ;
   - il fait re-télécharger l'ensemble épinglé à chaque visite, y compris quand rien n'a changé :
     2,4 Mio pour le seul émulateur, et jusqu'à 9,9 Mio si l'image de référence est demandée.

   Ce point est **lu dans les spécifications, non mesuré ici** : voir « Ce que cette décision ne
   prouve pas ».

## Décision

### 1. Trois natures d'artefact, trois politiques

La nature est décidée par le **chemin et le rôle**, jamais par l'origine seule : le territoire
applicatif reste le territoire du guest même servi par le rôle `shell`, comme le fait le banc du
spike #35.

| Nature                   | Motif `_headers`   | `Cache-Control`         | Ce qui la définit                                                          |
| ------------------------ | ------------------ | ----------------------- | -------------------------------------------------------------------------- |
| Coquille et ses modules  | `/*` (coquille)    | `no-cache`              | change à chaque version, et son URL ne nomme pas la version                |
| Épinglage v86 (ADR 0003) | `/vendor/v86/*`    | `public, max-age=86400` | ne change qu'à la montée de version de l'émulateur, et alors **d'un bloc** |
| Territoire applicatif    | `/*` (application) | `no-store`              | ce que cette origine sert porte les cookies de session du guest (ADR 0002) |

`no-cache` **autorise le stockage** — c'est exactement ce que `no-store` interdisait — et impose la
revalidation avant réemploi. C'est la politique correcte pour une coquille dont l'URL est stable :
elle permet à un cache, HTTP ou Service Worker, de garder une copie, et elle interdit de la servir
sans avoir demandé si elle vaut encore.

### 2. Le préfixe de l'épinglage est `/vendor/v86/`, et pas `/vendor/v86/artefacts/`

Le manifeste et les licences relèvent de la même règle que les octets qu'ils décrivent (fait 3). Un
manifeste revalidé toutes les heures devant des artefacts vieux d'un jour décrirait un runtime que
le navigateur n'exécute pas — et l'ADR 0003 fait de ce manifeste la pièce qui rend la provenance
**vérifiable**. Une seule fenêtre pour tout le sous-arbre leur donne la **même durée de fraîcheur**,
ce qui **borne l'écart à vingt-quatre heures**.

C'est une borne, pas une cohérence : HTTP calcule la fraîcheur par réponse, à partir de sa propre
date de réception, si bien que deux réponses portant le même `max-age` n'expirent pas ensemble (fait
3). La cohérence manifeste ↔ octets, elle, sera tenue par une vérification d'empreinte au chargement
— **#123**. Aucun code navigateur de ce dépôt ne lit `vendor/v86/MANIFEST.json` aujourd'hui : la
portée de cet écart est nulle tant qu'il en est ainsi, et c'est précisément pourquoi la phrase est
requalifiée maintenant, avant qu'un Service Worker ne s'en réclame.

Accorder la classe par EMPLACEMENT a un revers, relevé par la revue de cet ADR et fermé depuis.
`tools/publier-arborescences.mjs` copie `vendor/v86/artefacts/` en bloc, et ce répertoire est ignoré
par git : tout fichier qui y traîne — une trace de débogage sur le poste qui publie — partait chez
l'hébergeur avec vingt-quatre heures de cache **partagé** et sans révocation, là où il recevait
`no-store` avant cette décision. `verifierEpinglageV86` confronte désormais le manifeste et le
disque dans les **deux** sens : un fichier présent que `vendor/v86/MANIFEST.json` ne déclare pas est
un écart d'épinglage — code 5, publication refusée. L'ADR 0003 dit ce qui a le droit d'être là, et
le refus est bruyant plutôt que silencieux, parce que ce qui traîne sur le disque du poste qui
publie est précisément ce qu'un exploitant doit voir.

Ce choix a un effet secondaire mesuré et voulu : le manifeste est **publié dans tous les cas**,
alors que `vendor/v86/artefacts/` est absent d'un clone vierge. C'est ce qui permet au témoin
d'en-têtes de relever cette nature **sur du HTTP réel** à chaque `npm run publier:check`, plutôt que
sur un chemin qui n'existe qu'après `npm run vm:fetch`.

### 3. `immutable` est REFUSÉ, et 86 400 secondes n'est pas un chiffre de confort

`immutable` promet que les octets à cette URL ne changeront jamais. Le fait 2 dit que c'est faux
aujourd'hui : un navigateur qui l'aurait reçu refuserait de revalider et continuerait d'exécuter un
émulateur périmé, en désaccord avec le manifeste que l'ADR 0003 publie comme vérité de provenance.
`docs/vision.md` refuse les promesses non tenues ; celle-ci le serait deux fois, puisqu'elle ferait
échouer une mise à jour de sécurité du runtime.

La borne retenue est **86 400 s**, et elle est empruntée : c'est celle que la plate-forme s'impose
déjà au **script** d'un Service Worker, dont l'algorithme de mise à jour ignore le cache au-delà de
vingt-quatre heures. C'est donc la plus longue péremption que le navigateur tolère pour le code qui
gouvernera le mode hors ligne ; aligner dessus les artefacts les plus lourds tient tout l'arbre dans
une seule fenêtre, au lieu d'en inventer une.

Le cache long et immuable reste **souhaitable** ; il est conditionné à des URL qui nomment leur
empreinte. C'est du travail découvert, écrit ci-dessous et suivi par **#123**.

### 4. `no-store` reste sur l'origine applicative, mais comme une DÉCISION

Il y était par héritage ; il y est désormais parce que ce que cette origine sert en production porte
les cookies de session Rails et vient du **guest**. Deux conséquences, et la seconde est la ligne de
l'ADR 0002 :

- ce que **nous** servons de cette origine — la place tenante, l'inventaire — ne doit pas s'attarder
  dans un cache partagé ;
- ce que le **guest** sert de la sienne reste gouverné par ses propres en-têtes. En production le
  HTML applicatif est produit par le guest et relayé par le proxy : il ne traverse pas le `_headers`
  de l'hébergeur statique, et cette décision ne prétend pas le gouverner.

### 5. `Cache-Control` est la SEULE dimension autorisée à varier selon le chemin

C'est la moitié de la décision qui protège l'autre. `securityHeaders()` compte désormais un en-tête
dont la valeur dépend du chemin ; une seconde ferait de « la politique publiée » une notion floue,
et le cliquet de l'ADR 0017 y perdrait ses dents.

Le cliquet unique devient donc **deux cliquets**, dont la réunion garde le nom que
`tools/publier.mjs` appelle :

- **`cheminsHorsUniformite`** compare exactement le même jeu d'en-têtes qu'avant, **moins un**. Une
  divergence de CSP, de COOP, de `Referrer-Policy` ou de `Permissions-Policy` entre deux chemins
  d'un même arbre est refusée comme elle l'était. `compat.html`, qui perd trois de ces en-têtes par
  `isShellDocument`, est encore refusé — et il est refusé **pour eux**, puisque sa politique de
  cache est celle de la racine ;
- **`cheminsHorsFideliteDuFichier`** relit le fichier `_headers` **produit** avec l'analyseur qui le
  sert, et exige qu'il rende à chaque chemin exactement ce que la source de vérité y servirait.
  C'est lui qui attrape un bloc manquant, un motif mal écrit, ou une nature apparue sans être
  déclarée dans la table. Il ne vérifie qu'un sens — chaque en-tête servi doit être rendu ; l'autre
  sens est tenu par le premier cliquet, qui refuse qu'un chemin reçoive une politique autre que
  celle de la racine.

### 6. Chaque bloc du `_headers` porte TOUS les en-têtes

Le fait 4 l'impose. Un bloc `/vendor/v86/*` réduit à `Cache-Control` serait correct chez Cloudflare
et chez Netlify, et retirerait la CSP, COOP et le durcissement de l'ADR 0022 aux artefacts v86 chez
un hébergeur qui n'appliquerait que la règle la plus précise. Le fichier rend donc le **même**
résultat sous les deux sémantiques, au prix de quelques lignes répétées. Une épreuve refuse un bloc
incomplet.

La nature de chaque bloc est écrite dans un **octet servi** (`# nature: …`), comme l'origine de
l'arbre l'est depuis la revue de sécurité de #45 : elle entre dans l'empreinte du fichier, donc dans
l'empreinte de racine, et un exploitant qui relit le fichier peut dire pourquoi il y a deux blocs.

### 7. Ce que le témoin en mesure

`tools/publier-temoin.mjs` relève la politique **réellement reçue** sur **trois natures** et **deux
origines**, par un `fetch` émis depuis la page — donc par la pile réseau du moteur, pas par le
client HTTP du harnais. Son verdict refuse en outre un relevé qui ne porterait pas au moins deux
natures de politiques **distinctes** : sans cela, un témoin vert pourrait n'avoir jamais mesuré ce
que cette décision a de propre, qui est de distinguer.

## Ce que cette politique permet et interdit aux deux Service Workers de l'ADR 0002

L'ADR 0002 prévoit deux Service Workers : celui de la coquille sert la coquille et le runtime, celui
de l'origine applicative sert les documents de l'application. Aucun des deux n'existe. Cette section
écrit ce que la politique retenue leur laisse, pour qu'elle soit un cadre et non une surprise.

**Ce qu'elle PERMET au Service Worker de la coquille :**

- **précharger la coquille et ses modules à l'installation**, et les servir depuis son magasin hors
  ligne. `no-cache` n'interdit pas le stockage, et le magasin d'un Service Worker n'est de toute
  façon pas gouverné par les directives HTTP (fait 5) ;
- **précharger l'épinglage v86 une fois** et le garder. Le cache HTTP en garde aussi une copie
  jusqu'à vingt-quatre heures, si bien qu'une seconde visite antérieure à l'installation du Service
  Worker ne re-télécharge pas ce qu'elle a déjà — 2,4 Mio pour l'émulateur seul, jusqu'à 9,9 Mio
  avec l'image de référence ;
- **revalider à bas coût**. Un `fetch` de mise à jour sur la coquille part au réseau et revient en
  `304` si rien n'a changé : la stratégie « réseau d'abord, magasin en secours » ne coûte pas un
  téléchargement complet par visite ;
- **se mettre à jour lui-même sans délai imposé**. Le script du Service Worker de la coquille relève
  de la nature « coquille », donc de `no-cache` : le navigateur ne peut pas lui servir une version
  périmée depuis son cache HTTP.

**Ce qu'elle INTERDIT, ou lui laisse à sa charge :**

- **elle ne donne pas le mode hors ligne**. `no-cache` impose une revalidation, et une revalidation
  hors ligne échoue : servir la coquille sans réseau passera par le magasin du Service Worker, pas
  par le cache HTTP. Cette politique rend le mode hors ligne **possible** ; elle ne le réalise pas ;
- **il ne doit pas traiter les URL de `/vendor/v86/` comme immuables**. Elles ne nomment pas leur
  empreinte (fait 2). Une stratégie « magasin d'abord » sur ce préfixe doit prévoir une invalidation
  explicite à la montée de version — et l'ADR 0003 lui donne de quoi la décider : le manifeste, dont
  la fenêtre de fraîcheur a la même DURÉE que celle des octets, ce qui borne leur écart d'âge à
  vingt-quatre heures sans les faire expirer ensemble. Un Service Worker qui voudrait la cohérence
  elle-même doit **vérifier l'empreinte au chargement** plutôt que se fier à cette borne (#123) ;
- **il ne doit pas s'en remettre à la fenêtre de vingt-quatre heures pour se rafraîchir**. Le cache
  HTTP revalide après 86 400 s ; le magasin d'un Service Worker, lui, n'expire pas. L'éviction à la
  montée de version est son travail, pas celui de cet en-tête.

**Ce qu'elle dit au Service Worker de l'origine applicative :**

- **rien de ce qu'il doit cacher, et c'est délibéré.** Les documents qu'il servira viennent du guest
  et portent leurs propres en-têtes ; le `_headers` de cette origine ne gouverne que la place
  tenante et l'inventaire. Le `no-store` qu'il y lit vaut pour ce que **nous** y servons ;
- **il ne prendra jamais portée sur la coquille** : la portée maximale d'un Service Worker est le
  répertoire de son script, `Service-Worker-Allowed` n'est jamais émis, et l'ADR 0002 a mesuré la
  frontière. Rien ici ne change cela ;
- **une réponse `no-store` reste déposable dans son magasin** (fait 5). Si le guest en décide ainsi,
  c'est sa responsabilité et celle de sa politique de session — pas une propriété que cette décision
  tient à sa place.

## Ce que cette décision ne prouve pas

- **Le comportement des moteurs face à `no-store` et au magasin de Service Worker n'est pas mesuré
  ici.** Le fait 5 est lu dans les spécifications ; aucune épreuve de ce dépôt ne dépose une réponse
  `no-store` dans un `Cache` pour vérifier qu'un moteur l'accepte. La décision n'en dépend pas —
  elle tient par les trois raisons qui suivent le fait —, mais l'affirmation, elle, est **non
  mesurée**. C'est du travail découvert, qui appartient à la tranche qui livrera les Service
  Workers, et il est suivi par **#125**.
- **La borne de 86 400 s est citée, pas mesurée.** Elle vient de l'algorithme de mise à jour du
  Service Worker ; ce dépôt n'a pas d'épreuve qui l'observe, faute de Service Worker (**#125**).
- **Aucun effet de cache n'est mesuré dans un navigateur.** Ce qui est éprouvé est que la politique
  est **servie**, par nature, sur les deux origines et par la pile réseau du moteur — pas qu'un
  moteur garde effectivement l'épinglage v86 vingt-quatre heures. Une sonde honnête demanderait deux
  visites séparées et un témoin négatif ; c'est un banc que cette tranche n'a pas construit
  (**#125**).
- **La cohérence entre le manifeste et les octets n'est tenue par aucun code.** Une même fenêtre
  BORNE leur écart d'âge à vingt-quatre heures (décision 2) ; elle ne les fait pas expirer ensemble,
  puisque HTTP calcule la fraîcheur par réponse à partir de sa propre date de réception. Rien dans
  le dépôt ne relit le manifeste au chargement du runtime, si bien que la portée de cet écart est
  aujourd'hui nulle. La propriété qui la tiendra est une vérification d'empreinte, suivie par
  **#123**.
- **Mesuré sous Chromium seulement, et sous la version 141.** Firefox et WebKit n'étaient pas
  installables dans l'environnement où #103 a été conduit (politique réseau bloquant le CDN de
  Playwright). **Non exécuté : moteur indisponible.** La CI du dépôt installe les trois.
- **Aucun hébergement réel n'a été mesuré.** Le risque résiduel n°4 de l'ADR 0017 vaut ici sans
  changement, et il est aggravé sur ce point précis : le spike #45 a relevé que GitHub Pages impose
  `max-age=600` quoi qu'on écrive. Un hébergeur qui réécrit `Cache-Control` rendrait cette décision
  inopérante, et rien dans la chaîne ne peut le détecter avant une mise en service (**#124**).

## Risques résiduels

1. **Le cache long sur des URL non adressées par contenu laisse une fenêtre de vingt-quatre
   heures.** Un navigateur peut exécuter un émulateur d'hier avec un manifeste d'hier, en retard
   d'une version — et, la fraîcheur se calculant par réponse, les deux ne sont pas nécessairement du
   même hier : la fenêtre commune BORNE leur écart à vingt-quatre heures, elle ne les aligne pas
   (décision 2). Pour une mise à jour de **sécurité** du runtime, ce retard est réel et il est le
   prix payé pour ne pas re-télécharger l'ensemble épinglé — jusqu'à 9,9 Mio — à chaque visite. Le
   fermer demande des URL qui nomment leur empreinte : **travail découvert**, suivi par **#123**.
2. **Un hébergeur peut réécrire `Cache-Control`.** GitHub Pages le fait (`max-age=600`), et l'ADR
   0017 l'écarte déjà pour d'autres en-têtes. La sonde d'hébergement existante relève ce que des
   sites tiers servent, ce qui prouve le choix de leur propriétaire et non la capacité de
   l'hébergeur ; elle ne suit d'ailleurs pas encore `Cache-Control`. Aucune origine de ce projet
   n'existe encore. Suivi par **#124**.
3. **Le mode hors ligne n'existe pas.** Cette décision lève l'obstacle que `no-store` posait ; elle
   ne construit rien. La section « ce qu'elle permet et interdit » est un cadre écrit à l'avance, et
   un cadre écrit à l'avance peut se révéler faux — c'est la tranche des Service Workers qui le
   dira, éclairée par les relevés de **#125**.
4. **Une seconde dimension non uniforme demanderait un ADR, et rien ne l'empêche d'être ajoutée par
   inadvertance ailleurs.** Le cliquet la refuserait à la publication, mais un en-tête qui varierait
   par chemin dans `securityHeaders()` sans être servi par la publication — sur un banc, par exemple
   — ne serait vu de personne.
5. **La fidélité n'est vérifiée que dans un sens** (décision 5). Un `_headers` qui rendrait un
   en-tête que la source de vérité ne sert pas à ce chemin n'est refusé que si le chemin est par
   ailleurs non uniforme. Sur le fichier **généré**, le cas ne peut pas se produire ; sur un fichier
   édité à la main, il le pourrait — et le fichier porte l'avertissement « ne pas éditer à la main
   ».

## Amendement du 2026-09-05 — l'adressage par empreinte, et `immutable` (#123)

La première condition de réouverture est remplie : **les URL des artefacts épinglés nomment leur
empreinte**. La décision 3 est donc reprise, et avec elle la décision 2. Le reste de cet ADR — les
trois natures, la dimension unique non uniforme, les deux cliquets, les blocs complets — tient sans
changement.

### La mesure qui autorise `immutable`

`immutable` promet « ces octets ne changeront jamais à cette URL ». Le fait 2 la rendait fausse,
parce que la publication copiait `vendor/v86/artefacts/` tel quel. Elle est désormais TENUE par
l'adresse : `src/v86-adresses.mjs` dérive `<base>-<sha256 tronqué à 16 hex>.<ext>` du manifeste, et
un ré-épinglage DÉPLACE l'artefact — un navigateur qui garderait l'ancienne adresse pour toujours ne
la demanderait plus jamais.

Ce n'est pas une intention : `verifierEpinglageV86` le MESURE sur l'arbre publié, avant qu'il ne
parte, et un écart y est un code 5. Trois passes, dont chacune ferme un mode de panne :

1. **chaque adresse dérivée du manifeste est servie** — sinon l'hébergeur rendrait un 404 ;
2. **chaque octet servi sous le préfixe est DÉCLARÉ** — c'est le cliquet de la revue de #103, dont
   l'enjeu monte d'un cran : un fichier oublié là partirait pour un an de cache partagé sans
   révocation, au lieu de vingt-quatre heures ;
3. **chaque empreinte est RECALCULÉE sur les octets**, puis confrontée à celle que le manifeste
   épingle — donc à celle que le nom annonce. Un fichier renommé pour porter l'adresse d'un autre
   est refusé.

`tests/unit/v86-reepinglage.test.mjs` déroule en outre un ré-épinglage complet sur des arbres réels
: l'ancienne adresse n'est plus servie, la nouvelle l'est, l'artefact INCHANGÉ garde la sienne,
l'empreinte de racine de l'ADR 0017 change, et le retour arrière la retrouve au bit près.

### Ce qui change dans la table

| Nature                                                      | Motif `_headers`          | `Cache-Control`                       |
| ----------------------------------------------------------- | ------------------------- | ------------------------------------- |
| Coquille, ses modules, **le manifeste et les licences v86** | `/*` (coquille)           | `no-cache`                            |
| **Artefacts v86 adressés par empreinte**                    | `/vendor/v86/artefacts/*` | `public, max-age=31536000, immutable` |
| Territoire applicatif                                       | `/*` (application)        | `no-store`                            |

### Le préfixe se resserre, et le manifeste SORT de la classe épinglée

La décision 2 accordait la classe à `/vendor/v86/` pour donner au manifeste la MÊME durée de
fraîcheur que les octets, et borner ainsi leur écart d'âge à vingt-quatre heures. Cette borne n'a
plus d'objet : la cohérence est dans l'adresse. Le manifeste ne peut d'ailleurs PAS être immuable —
il est l'**indirection** par laquelle un chargeur apprend les adresses, et une copie périmée en
désignerait qui ne sont plus servies. Le mode de panne serait un 404 franc plutôt qu'une exécution
périmée ; il n'en reste pas moins un mode de panne, et `no-cache` l'écarte pour le prix d'un
aller-retour de cinq kibioctets par visite, au lieu des 9,9 Mio que ce manifeste décrit.

Le resserrement conserve la propriété que la décision 2 défendait vraiment : **le défaut de la table
reste le SÛR.** Un fichier qui apparaîtrait demain sous `/vendor/v86/` reçoit `no-cache`, et non un
an de cache partagé. C'est l'inverse qui aurait été vrai d'un préfixe large corrigé par des règles
d'exception — lesquelles auraient en outre reposé sur une sémantique de fusion que le format
`_headers` ne spécifie pas (fait 4).

L'alternative « un préfixe `/vendor/v86/artefacts/` » est donc RETENUE, contre ce que le tableau des
alternatives rejetées disait de son second motif : « la nature ne serait mesurable qu'après
`npm run vm:fetch` ». Ce motif était juste, et il fallait le refermer autrement. La publication
dépose désormais sous ce préfixe la **copie du manifeste adressée par sa propre empreinte**
(`MANIFEST-<empreinte>.json`). Elle dérive d'un fichier versionné, donc elle est présente dans TOUT
arbre publié, y compris construit depuis un clone vierge ; le témoin d'en-têtes relève donc
`immutable` sur du HTTP réel à chaque `npm run publier:check`, à une adresse DÉRIVÉE du manifeste
servi — si bien que ce relevé mesure aussi la dérivation.

Cette copie a une raison d'être qui ne doit rien au témoin. Une adresse d'artefact dit quels octets
elle sert ; elle ne dit pas QUEL épinglage les a nommés. `vendor/v86/MANIFEST.json` répond « ce qui
est épinglé aujourd'hui » — c'est son rôle d'indirection. La copie répond « l'épinglage qui a
produit ces adresses-là », à une adresse qui ne bougera plus, et le retour arrière de l'ADR 0017 a
besoin du manifeste d'hier au bit près.

### 31 536 000 s, et pourquoi la durée cesse d'être le sujet

La borne de 86 400 s était empruntée à l'algorithme de mise à jour du Service Worker. Elle reste
celle de la coquille, où elle est sans objet puisque la coquille est `no-cache`. Sous `immutable`,
la durée ne décide plus de rien d'important : l'adresse d'un artefact périmé n'est plus jamais
demandée. Un an est la valeur conventionnelle, et la borne supérieure que RFC 9111 § 1.2.2
recommande.

### La vérification d'empreinte AU CHARGEMENT est LIVRÉE par cette tranche

**Cette section a été écrite une première fois pour REPORTER cette vérification, et la revue de
sécurité de #123 a montré que l'argument était faux.** Il disait : « ce qu'elle attraperait encore,
elle ne l'attrape pas, puisque l'empreinte attendue vient du manifeste servi par la même origine —
c'est le raisonnement que `tools/publier-sources.mjs` tient déjà pour Argon2id ». Or ce module tient
le raisonnement INVERSE, à la docstring de `verifierEpinglageArgon2` : « deux vérifications
indépendantes couvrent le même octet à deux moments, et **aucune ne remplace l'autre** […] ce que la
vérification du navigateur couvre est un chemin ISOLÉ : un cache qui garde une version d'un binaire
à côté d'un module d'une autre, un déploiement partiel qui n'a poussé qu'une moitié de l'arbre. **Ce
sont les incidents qu'on rencontre.** » Et le code suit ce raisonnement-là depuis #22.

Ce que la vérification au chargement attrape n'est pas le MENSONGE, c'est l'**accident** — et un
cache d'un an le rend plus probable, pas moins : ce qui est corrompu une fois est gardé un an, sans
revalidation, `immutable` supprimant jusqu'au rechargement forcé comme geste de récupération. La
décision est donc reprise : **elle est livrée ici.**

- `src/v86-adresses.mjs` confronte les octets reçus aux **256 bits** du manifeste — l'adresse n'en
  nomme que seize caractères — et refuse par une erreur typée, `VAULT_V86_EMPREINTE`, sérialisable
  comme celles de `src/vm/runtime-errors.mjs` ;
- les chargeurs du dépôt passent tous par cette porte, et une épreuve d'inspection de source exige
  qu'ils le fassent. Le module de l'émulateur est vérifié avant d'être importé — `import()` ne rend
  pas d'octets, la vérification passe donc par une récupération préalable à la même adresse, servie
  par le cache ;
- **le coût est mesuré sur le chemin de boot réel** et publié dans la décomposition (#60) sous
  `empreintesV86Ms`. Un prix qu'on ne relève pas ne se discute pas. La première estimation de la PR
  — 9,2 ms pour 9,9 Mio sous Chromium 141 — était prise en contexte de page, et elle ne justifiait
  déjà pas le report.

**Ce qu'elle ne couvre toujours pas, et qui reste ouvert.** Une origine qui ment aux deux du même
geste : l'empreinte attendue vient du manifeste servi par cette même origine. Cette défense-là est
`verifierEpinglageV86`, sur l'arbre construit à partir d'un commit. Et entre la vérification du
module et son `import()`, une origine hostile pourrait servir d'autres octets — un accident, lui, ne
change pas de réponse entre deux requêtes. Enfin, le magasin d'un Service Worker est géré par le
développeur et n'est PAS gouverné par l'URL (fait 5) : un Service Worker qui rangerait un artefact
sous une clé de requête et le rendrait pour une autre briserait la garantie que l'adresse porte.
C'est ce cas résiduel, et lui seul, que **#151** garde ouvert.

### Une ADRESSE QUI N'EXISTE PAS relève elle aussi de la règle immuable

C'est le bord neuf de la promesse, relevé par la revue de sécurité, et il ne se confond avec aucune
des réserves déjà écrites. `Cache-Control` gouverne une **réponse** ; le format `_headers` associe
des en-têtes à un **chemin**. Sous `/vendor/v86/artefacts/*`, une adresse qui n'existe pas encore —
ou qui n'existe plus — reçoit donc l'annonce d'un an d'`immutable` comme si elle existait. Or un 404
est stockable par défaut (RFC 9111 § 3), un `max-age` explicite le rend frais, et `immutable`
(RFC 8246) supprime la revalidation **y compris au rechargement**. Un client qui demanderait une
adresse pendant la fenêtre où elle n'est pas encore déposée garderait son 404 pendant un an, sans
geste de récupération de son côté. Le passage de vingt-quatre heures à un an aggrave ce cas d'un
facteur 365.

Deux réponses, et la seconde n'est pas de notre ressort :

- **les serveurs de ce dépôt rendent toute absence en `no-store`**, sur tous les chemins et pas sous
  ce seul préfixe — il n'existe aucun cas où garder l'absence d'un octet nous serve, et une règle
  conditionnelle serait une occasion de plus de se tromper de condition. Le témoin d'en-têtes relève
  cette politique sur du HTTP réel, à une adresse délibérément absente, et refuse un 404 cachable
  comme il refuse une nature mal servie ;
- **chez un hébergeur, c'est une obligation d'exploitant**, au même titre que celle de ne pas
  réécrire `Cache-Control` : **le dépôt d'un arbre doit être atomique, ou déposer les artefacts
  AVANT le manifeste qui les nomme.** L'ordre inverse ouvre précisément cette fenêtre. L'ADR 0017
  écrit « republier consiste à redéposer cet arbre », et un redépôt n'est pas nécessairement
  atomique. Aucune origine réelle n'a été mesurée : **#124**, et cette obligation y est ajoutée.

### Ce que cet amendement ne prouve toujours pas

Les réserves de la section « Ce que cette décision ne prouve pas » valent sans changement. Deux se
déplacent d'un cran :

- **aucun effet de cache n'est mesuré dans un navigateur** (#125). Ce qui est éprouvé reste que la
  politique est SERVIE, par nature, sur les deux origines et par la pile réseau du moteur. Qu'un
  moteur garde effectivement un artefact un an, et ne redemande jamais une adresse retirée, n'est
  pas mesuré ici — et l'enjeu de cette lacune monte, puisque la fenêtre passe de vingt-quatre heures
  à un an ;
- **aucun hébergement réel n'a été mesuré** (#124). Un hébergeur qui réécrit `Cache-Control` —
  GitHub Pages impose `max-age=600` — rend cette décision inopérante, comme il rendait la précédente
  inopérante. S'y ajoute désormais l'obligation d'**atomicité du dépôt** écrite ci-dessus : ce que
  fait un hébergeur d'une réponse d'absence sous un chemin annoncé `immutable` n'est ni mesuré ni
  mesurable par ce dépôt, dont les deux serveurs rendent l'absence en `no-store`.

Une réserve TOMBE, et deux fois plutôt qu'une : la cohérence manifeste ↔ octets n'est plus « tenue
par aucun code ». Elle est tenue par l'adresse, mesurée par `verifierEpinglageV86` avant que l'arbre
ne parte, et confrontée aux 256 bits **au chargement** par `src/v86-adresses.mjs`.

## Conditions de réouverture

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- ~~**les URL des artefacts épinglés nomment leur empreinte** (**#123**)~~ — **REMPLIE le
  2026-09-05**, voir l'amendement ci-dessus, qui reprend les décisions 2 et 3 ;
- les Service Workers de l'ADR 0002 sont livrés, et l'un d'eux a besoin d'une politique que celle-ci
  ne lui laisse pas — auquel cas la section « ce qu'elle permet et interdit » cesse d'être un cadre
  pour devenir un relevé ;
- **l'effet du cache est mesuré dans un navigateur** (**#125**) et contredit l'un des deux faits de
  plate-forme que cet ADR cite sans les mesurer ;
- une origine réelle est mise en service et son hébergeur réécrit `Cache-Control` (**#124**) : il
  faudra alors dire si la chaîne refuse cet hébergeur, comme elle refuse déjà GitHub Pages pour les
  en-têtes de l'ADR 0017 ;
- un besoin de cache apparaît sur l'origine applicative pour ce que **nous** y servons — ce qui
  n'arrivera pas tant qu'elle ne sert qu'une place tenante ;
- une **seconde** dimension d'en-tête doit varier selon le chemin : le cliquet est écrit pour une,
  et le passage à deux est une décision, pas une extension.

## Alternatives rejetées

| Alternative                                                            | Pourquoi elle est écartée                                                                                                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public, max-age=31536000, immutable` sur les artefacts v86            | Promesse fausse : l'URL ne nomme pas l'empreinte (fait 2). Un navigateur refuserait de revalider et exécuterait un émulateur périmé, en désaccord avec le manifeste de l'ADR 0003 |
| Garder `no-store` partout et laisser les Service Workers s'en arranger | Ferme le cache HTTP, seule couche qui travaille avant l'installation d'un Service Worker et quand il est cassé ; et parle en « ne pas conserver » à des tiers non contrôlés       |
| Une politique par ORIGINE, comme l'ADR 0022 a décidé le durcissement   | Le même arbre porte 9,9 Mio d'ensemble v86 épinglé et une coquille qui change à chaque version : décider par origine, c'est décider une fois de trop                              |
| Un préfixe `/vendor/v86/artefacts/` plutôt que `/vendor/v86/`          | Séparerait le manifeste des octets qu'il épingle, donc leurs fenêtres de fraîcheur ; et la nature ne serait mesurable qu'après `npm run vm:fetch`                                 |
| Un bloc précis ne portant que `Cache-Control`                          | Dépendrait d'une sémantique de fusion que le format `_headers` ne spécifie pas (fait 4), et retirerait la CSP aux artefacts v86 chez un hébergeur qui ne l'appliquerait pas       |
| Retirer le cliquet « politique uniforme » plutôt que le remplacer      | Il tenait une propriété réelle — ce qui est annoncé est ce qui est servi. Le retirer aurait payé la politique par nature du prix d'une garantie de sécurité                       |
| `max-age=0, must-revalidate` au lieu de `no-cache` sur la coquille     | Équivalent en effet, plus long à lire, et `no-cache` est la formulation dont le nom dit ce qu'elle fait                                                                           |
