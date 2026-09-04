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
unique. Une politique de cache, non : le même arbre porte 2,4 Mio d'émulateur épinglé et 40 Kio de
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
   ensemble et `npm run vm:check` échoue si l'un ne correspond plus. Ils ne peuvent donc pas relever
   de deux fenêtres de fraîcheur différentes sans qu'un navigateur puisse tenir un manifeste frais
   devant des octets d'hier.

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
   - il fait re-télécharger 2,4 Mio d'émulateur à chaque visite, y compris quand rien n'a changé.

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
manifeste revalidé devant des artefacts vieux d'un jour décrirait un runtime que le navigateur
n'exécute pas — et l'ADR 0003 fait de ce manifeste la pièce qui rend la provenance **vérifiable**.
Une seule fenêtre pour tout le sous-arbre garde le manifeste et les octets cohérents entre eux.

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
empreinte. C'est du travail découvert, écrit ci-dessous.

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
  Worker ne re-télécharge pas 2,4 Mio ;
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
  explicite à la montée de version — et l'ADR 0003 lui donne de quoi la décider : le manifeste, qui
  vieillit dans la même fenêtre que les octets ;
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
  Workers.
- **La borne de 86 400 s est citée, pas mesurée.** Elle vient de l'algorithme de mise à jour du
  Service Worker ; ce dépôt n'a pas d'épreuve qui l'observe, faute de Service Worker.
- **Aucun effet de cache n'est mesuré dans un navigateur.** Ce qui est éprouvé est que la politique
  est **servie**, par nature, sur les deux origines et par la pile réseau du moteur — pas qu'un
  moteur garde effectivement l'épinglage v86 vingt-quatre heures. Une sonde honnête demanderait deux
  visites séparées et un témoin négatif ; c'est un banc que cette tranche n'a pas construit.
- **Mesuré sous Chromium seulement, et sous la version 141.** Firefox et WebKit n'étaient pas
  installables dans l'environnement où #103 a été conduit (politique réseau bloquant le CDN de
  Playwright). **Non exécuté : moteur indisponible.** La CI du dépôt installe les trois.
- **Aucun hébergement réel n'a été mesuré.** Le risque résiduel n°4 de l'ADR 0017 vaut ici sans
  changement, et il est aggravé sur ce point précis : le spike #45 a relevé que GitHub Pages impose
  `max-age=600` quoi qu'on écrive. Un hébergeur qui réécrit `Cache-Control` rendrait cette décision
  inopérante, et rien dans la chaîne ne peut le détecter avant une mise en service.

## Risques résiduels

1. **Le cache long sur des URL non adressées par contenu laisse une fenêtre de vingt-quatre
   heures.** Un navigateur peut exécuter un émulateur d'hier avec un manifeste d'hier — cohérents
   entre eux (décision 2), mais en retard d'une version. Pour une mise à jour de **sécurité** du
   runtime, ce retard est réel et il est le prix payé pour ne pas re-télécharger 2,4 Mio à chaque
   visite. Le fermer demande des URL qui nomment leur empreinte : **travail découvert**.
2. **Un hébergeur peut réécrire `Cache-Control`.** GitHub Pages le fait (`max-age=600`), et l'ADR
   0017 l'écarte déjà pour d'autres en-têtes. La sonde d'hébergement existante relève ce que des
   sites tiers servent, ce qui prouve le choix de leur propriétaire et non la capacité de
   l'hébergeur. Aucune origine de ce projet n'existe encore.
3. **Le mode hors ligne n'existe pas.** Cette décision lève l'obstacle que `no-store` posait ; elle
   ne construit rien. La section « ce qu'elle permet et interdit » est un cadre écrit à l'avance, et
   un cadre écrit à l'avance peut se révéler faux — c'est la tranche des Service Workers qui le
   dira.
4. **Une seconde dimension non uniforme demanderait un ADR, et rien ne l'empêche d'être ajoutée par
   inadvertance ailleurs.** Le cliquet la refuserait à la publication, mais un en-tête qui varierait
   par chemin dans `securityHeaders()` sans être servi par la publication — sur un banc, par exemple
   — ne serait vu de personne.
5. **La fidélité n'est vérifiée que dans un sens** (décision 5). Un `_headers` qui rendrait un
   en-tête que la source de vérité ne sert pas à ce chemin n'est refusé que si le chemin est par
   ailleurs non uniforme. Sur le fichier **généré**, le cas ne peut pas se produire ; sur un fichier
   édité à la main, il le pourrait — et le fichier porte l'avertissement « ne pas éditer à la main
   ».

## Conditions de réouverture

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- **les URL des artefacts épinglés nomment leur empreinte** — par un chemin ou un paramètre dérivé
  du SHA-256 de `vendor/v86/MANIFEST.json`. `immutable` et un `max-age` d'un an deviennent alors
  corrects, et la décision 3 doit être reprise ;
- les Service Workers de l'ADR 0002 sont livrés, et l'un d'eux a besoin d'une politique que celle-ci
  ne lui laisse pas — auquel cas la section « ce qu'elle permet et interdit » cesse d'être un cadre
  pour devenir un relevé ;
- une origine réelle est mise en service et son hébergeur réécrit `Cache-Control` : il faudra alors
  dire si la chaîne refuse cet hébergeur, comme elle refuse déjà GitHub Pages pour les en-têtes de
  l'ADR 0017 ;
- un besoin de cache apparaît sur l'origine applicative pour ce que **nous** y servons — ce qui
  n'arrivera pas tant qu'elle ne sert qu'une place tenante ;
- une **seconde** dimension d'en-tête doit varier selon le chemin : le cliquet est écrit pour une,
  et le passage à deux est une décision, pas une extension.

## Alternatives rejetées

| Alternative                                                            | Pourquoi elle est écartée                                                                                                                                                         |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `public, max-age=31536000, immutable` sur les artefacts v86            | Promesse fausse : l'URL ne nomme pas l'empreinte (fait 2). Un navigateur refuserait de revalider et exécuterait un émulateur périmé, en désaccord avec le manifeste de l'ADR 0003 |
| Garder `no-store` partout et laisser les Service Workers s'en arranger | Ferme le cache HTTP, seule couche qui travaille avant l'installation d'un Service Worker et quand il est cassé ; et parle en « ne pas conserver » à des tiers non contrôlés       |
| Une politique par ORIGINE, comme l'ADR 0022 a décidé le durcissement   | Le même arbre porte 2,4 Mio d'émulateur épinglé et une coquille qui change à chaque version : décider par origine, c'est décider une fois de trop                                 |
| Un préfixe `/vendor/v86/artefacts/` plutôt que `/vendor/v86/`          | Séparerait le manifeste des octets qu'il épingle, donc leurs fenêtres de fraîcheur ; et la nature ne serait mesurable qu'après `npm run vm:fetch`                                 |
| Un bloc précis ne portant que `Cache-Control`                          | Dépendrait d'une sémantique de fusion que le format `_headers` ne spécifie pas (fait 4), et retirerait la CSP aux artefacts v86 chez un hébergeur qui ne l'appliquerait pas       |
| Retirer le cliquet « politique uniforme » plutôt que le remplacer      | Il tenait une propriété réelle — ce qui est annoncé est ce qui est servi. Le retirer aurait payé la politique par nature du prix d'une garantie de sécurité                       |
| `max-age=0, must-revalidate` au lieu de `no-cache` sur la coquille     | Équivalent en effet, plus long à lire, et `no-cache` est la formulation dont le nom dit ce qu'elle fait                                                                           |
