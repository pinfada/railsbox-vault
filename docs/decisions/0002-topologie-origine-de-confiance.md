# ADR 0002 — La frontière coquille / application est une frontière d'origine

- Statut : accepté
- Date : 2026-08-23
- Issue : #35 · Invariant : `SEC-ORIGIN-001` · Jalon 0

## Contexte

`SECURITY.md` traite le JavaScript rendu par l'application Rails comme une entrée hostile. La
coquille de confiance doit pourtant vivre dans le même navigateur : elle détient la clé de volume en
mémoire, le handle OPFS exclusif et le canal privilégié vers le Worker runtime.

`docs/architecture.md` laissait la topologie ouverte et interdisait de figer une interface de ports
avant cette décision. RailsBox Live avait déjà buté sur la question et conclu, dans son ADR 0008,
que son durcissement de realm est « du durcissement, pas de l'isolation », la séparation d'origine
restant « la seule issue de fond » — décision qu'il n'a pas prise, faute de pouvoir payer une
seconde origine pour chaque sandbox publiée.

Vault n'a pas la même contrainte : il distribue un logiciel installé, pas une démonstration jetable,
et son ADR 0001 lui reconnaît explicitement le droit d'« adopter une topologie d'origines différente
».

## Cartographie des canaux

```text
                    ORIGINE DE CONFIANCE                        │      ORIGINE APPLICATIVE
  https://vault.exemple                                         │  https://app.vault.exemple
                                                                │
  ┌──────────────────────────────┐                              │   ┌───────────────────────┐
  │ Document coquille            │   window.postMessage         │   │ Document applicatif   │
  │  · clé de volume (fermeture) │◄────── annonce ─────────────►│   │  (HTML rendu par Rails)│
  │  · consentement utilisateur  │   MessagePort restreint      │   │  · hostile par principe│
  │  · CSP stricte               │──────► (une requête) ───────►│   │                       │
  └───────┬──────────────────────┘                              │   └──────────┬────────────┘
          │ MessagePort privilégié                              │              │
          │ (créé avant tout contenu applicatif)                │              │ fetch
          ▼                                                     │              ▼
  ┌──────────────────────────────┐                              │   ┌───────────────────────┐
  │ Worker runtime               │                              │   │ Service Worker appli. │
  │  · v86 + backend OPFS        │                              │   │  portée : origine     │
  │  · createSyncAccessHandle    │                              │   │  applicative seulement│
  │  · SharedArrayBuffer si isolé│                              │   └───────────────────────┘
  └───────┬──────────────────────┘                              │
          │                                                     │
          ▼                                                     │
  ┌──────────────────────────────┐                              │   ┌───────────────────────┐
  │ Partition de stockage        │                              │   │ Partition applicative │
  │  OPFS · IndexedDB · Locks    │   ── AUCUN canal implicite ──│   │  OPFS · IndexedDB     │
  │  BroadcastChannel · Storage  │                              │   │  Locks · Storage      │
  │  Cache · cookies             │                              │   │  Cache · cookies      │
  └──────────────────────────────┘                              │   └───────────────────────┘
                                                                │
  export utilisateur ──► fichier choisi par l'utilisateur ──────┴──► autre origine / appareil
```

Les canaux mesurés sont : DOM et realm du parent, `window.postMessage`, `MessagePort`, OPFS,
IndexedDB, Web Locks, `BroadcastChannel`, `localStorage`/`sessionStorage`, Service Worker et sa
portée, navigation du sommet, fenêtres auxiliaires, et l'isolation cross-origin.

## Options comparées et prototypées

| Identifiant | Origine du document applicatif | Attribut `sandbox`                |
| ----------- | ------------------------------ | --------------------------------- |
| T1a         | celle de la coquille           | aucun                             |
| T1b         | celle de la coquille           | `allow-scripts` (origine opaque)  |
| T2          | une autre origine              | `allow-scripts allow-same-origin` |
| T3          | une autre origine              | `allow-scripts` (origine opaque)  |

Une cinquième option, **T4 — sans document applicatif**, a été écartée sans prototype : le runtime
parlerait à Rails par API et rendrait lui-même l'interface. Elle supprime la frontière parce qu'elle
supprime le problème, mais elle supprime aussi le produit : RailsBox Vault promet d'exécuter des
applications Rails existantes, dont le HTML et le JavaScript doivent être rendus par le navigateur.
Elle est notée ici pour mémoire, pas comme une alternative viable.

## Décision

**Le document applicatif vit sur une origine distincte de la coquille, encadré par
`sandbox="allow-scripts allow-same-origin"` (topologie T2).**

Conséquences immédiates :

1. la publication de Vault comporte **deux origines** : une pour la coquille et son runtime, une
   pour les documents applicatifs ;
2. la coquille impose une CSP stricte à ses propres documents et n'en impose aucune au territoire
   applicatif, dont le HTML provient du guest ;
3. `allow-same-origin` est conservé : sur une iframe **inter-origine** il ne rend pas la sandbox
   contournable — il rend seulement à l'application son propre stockage, sans lequel ni les cookies
   de session Rails, ni son Service Worker, ni son cache ne peuvent exister ;
4. l'absence de `allow-top-navigation` et de `allow-popups` reste voulue : elle ajoute, par-dessus
   la frontière d'origine, le confinement de la navigation et des fenêtres auxiliaires ;
5. aucune interface durable de ports n'est figée ici : voir « Interfaces à ne pas figer ».

## Capacités autorisées par composant

| Composant                             | Peut                                                                                                          | Ne peut pas                                                                                                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Document coquille                     | déverrouiller, recueillir le consentement, créer le Worker, courtier le port restreint, exporter et restaurer | héberger du code applicatif, exécuter de l'inline (CSP), être encadré (`frame-ancestors 'none'`)                                                         |
| Worker runtime                        | détenir la clé de session, ouvrir le handle OPFS exclusif, exécuter v86, servir les E/S authentifiées         | rendre la clé à quiconque, accepter une commande hors du port privilégié                                                                                 |
| Port privilégié coquille ↔ Worker     | transporter déverrouillage, E/S, verrouillage, export                                                         | être obtenu par le document applicatif ni par un document tiers                                                                                          |
| Port restreint coquille ↔ application | transporter les seules requêtes de la liste d'admission (aujourd'hui l'état)                                  | transporter une clé, un handle, un descripteur de fichier ou une capacité transférable                                                                   |
| Document applicatif                   | rendre l'interface Rails, utiliser le stockage de SON origine, enregistrer un Service Worker sur SA portée    | lire l'OPFS, l'IndexedDB, les verrous ou les diffusions de la coquille ; naviguer le sommet ; ouvrir une popup ; intercepter les requêtes de la coquille |
| Service Worker applicatif             | servir hors ligne les documents de l'origine applicative                                                      | prendre une portée sur l'origine de la coquille                                                                                                          |
| Hébergement statique                  | distribuer les artefacts publics des deux origines                                                            | détenir une clé, observer un contenu déchiffré                                                                                                           |

## Diagramme de menace

```text
Adversaire : script hostile exécuté DANS le document applicatif
(dépendance Rails compromise, XSS applicatif, publication applicative altérée)

  ① référence au canal privilégié ──► realm inaccessible (SecurityError)
  ② message forgé sur window ───────► refusé : type, origine ET fenêtre émettrice vérifiés
  ③ second port réclamé ────────────► refusé : émission unique
  ④ commande privilégiée sur le port► refus typé « requete-non-admise »
  ⑤ iframe imbriquée usurpatrice ───► refusée : event.source ≠ cadre applicatif
  ⑥ lecture d'un secret du realm ───► SecurityError (parent inter-origine)
  ⑦ lecture OPFS / IndexedDB ───────► partition d'origine : base vide, fichier absent
  ⑧ persistance silencieuse ────────► atterrit dans SA partition, vérifié depuis la coquille
  ⑨ verrous et diffusions ──────────► invisibles : partitionnés par origine
  ⑩ navigation du sommet, popup ────► refusés par la sandbox
  ⑪ Service Worker interceptant ────► portée bornée à l'origine applicative

Hors de portée de cette décision :
  · compromission de la publication de la coquille elle-même (→ #45, SEC-UPDATE-001)
  · extension navigateur ou profil compromis
  · attaques sur le format de volume (→ SEC-BLOCK-001, SEC-GEN-001)
```

## Preuves

Le protocole complet, l'environnement et les mesures brutes sont dans
[`docs/spikes/0035-topologie-origine-de-confiance.md`](../spikes/0035-topologie-origine-de-confiance.md).
Les prototypes sont dans `public/spike/origin/`, les épreuves dans
`tests/browser/origin-*.spec.mjs`.

Dix-neuf sondes sont exécutées par le document applicatif dans chaque topologie. `R` signifie que la
tentative aboutit, `B` qu'elle est refusée, `I` que le moteur ne fournit pas la capacité. Relevé
Chromium 151 (Firefox 153 est identique ; WebKit 26.5 aussi, à l'exception des deux sondes OPFS qui
y sont `I`) :

| Sonde                          | Cible          | T1a | T1b | T2  | T3  |
| ------------------------------ | -------------- | :-: | :-: | :-: | :-: |
| obtention-port-restreint       | contrat        |  R  |  R  |  R  |  R  |
| message-forge-fenetre          | coquille       |  B  |  B  |  B  |  B  |
| second-canal-reclame           | coquille       |  B  |  B  |  B  |  B  |
| commande-privilegiee-sur-port  | coquille       |  B  |  B  |  B  |  B  |
| usurpation-iframe-imbriquee    | coquille       |  B  |  B  |  B  |  B  |
| acces-dom-coquille             | coquille       |  R  |  B  |  B  |  B  |
| lecture-appat-realm            | coquille       |  R  |  B  |  B  |  B  |
| lecture-stockage-cle-valeur    | coquille       |  R  |  B  |  B  |  B  |
| reference-worker-runtime       | coquille       |  B  |  B  |  B  |  B  |
| empoisonnement-prototype-port  | coquille       |  R  |  B  |  B  |  B  |
| navigation-top-fragment        | coquille       |  R  |  B  |  B  |  B  |
| ouverture-popup                | coquille       |  R  |  B  |  B  |  B  |
| lecture-opfs-coquille          | coquille       |  R  |  B  |  B  |  B  |
| ecriture-opfs-silencieuse      | origine propre |  R  |  B  |  R  |  B  |
| lecture-indexeddb-coquille     | coquille       |  R  |  B  |  B  |  B  |
| ecriture-indexeddb-silencieuse | origine propre |  R  |  B  |  R  |  B  |
| observation-verrous-web        | coquille       |  R  |  B  |  B  |  B  |
| ecoute-canal-controle          | coquille       |  R  |  B  |  B  |  B  |
| enregistrement-service-worker  | origine propre |  R  |  B  |  R  |  B  |

Les sondes marquées « origine propre » ne se jugent pas depuis l'application, qui ne sait pas de
quelle partition elle parle. Elles sont arbitrées depuis la coquille :

| Vérification menée depuis la coquille               | T1a                                | T1b         | T2          | T3          |
| --------------------------------------------------- | ---------------------------------- | ----------- | ----------- | ----------- |
| `hostile.marker` présent dans l'OPFS de la coquille | **oui**                            | non         | non         | non         |
| enregistrement hostile présent dans son IndexedDB   | **oui**                            | non         | non         | non         |
| ressource témoin servie à un client neuf            | **`canary-intercepte`**            | authentique | authentique | authentique |
| `top.location.replace()` depuis l'application       | **sommet navigué (`about:blank`)** | refusé      | refusé      | refusé      |

Le témoin positif est essentiel : en T1a les onze tentatives aboutissent, la clé appât est lue en
clair, le jeton de session est capté par remplacement de `MessagePort.prototype.postMessage`, un
fichier hostile est écrit dans l'OPFS de la coquille et un Service Worker applicatif répond à la
place du serveur. Sans cette démonstration, les colonnes vertes des autres topologies ne
prouveraient que des sondes cassées.

## Matrice de décision

| Critère                         | T1a                                                              | T1b                                                                      | **T2 (retenue)**                                         | T3                                                          |
| ------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- | ----------------------------------------------------------- |
| Surface de confiance            | totale : tout l'origine                                          | réduite, mais la coquille doit ouvrir CORS à `null`                      | coquille + son Worker uniquement                         | idem T2 plus l'ouverture CORS `null`                        |
| Résistance aux attaques         | **11 tentatives sur 19 aboutissent**                             | aucune n'aboutit                                                         | aucune n'aboutit                                         | aucune n'aboutit                                            |
| Compatibilité navigateur        | identique partout                                                | identique partout                                                        | identique sur les trois moteurs mesurés                  | identique partout                                           |
| Ergonomie d'installation        | une seule origine, une seule URL                                 | une seule origine                                                        | **deux origines à publier et à faire coïncider**         | deux origines                                               |
| Mode hors ligne                 | un Service Worker sert tout                                      | **impossible : une origine opaque n'est cliente d'aucun Service Worker** | deux Service Workers, un par origine                     | **impossible, comme T1b**                                   |
| Application Rails fonctionnelle | oui                                                              | **non : ni cookies, ni stockage, ni Service Worker pour l'application**  | oui                                                      | **non, comme T1b**                                          |
| Testabilité                     | facile                                                           | facile                                                                   | exige deux serveurs, fourni par `tools/serve.mjs --role` | exige deux serveurs                                         |
| Coût de maintenance             | faible, mais durcissement de realm permanent et jamais suffisant | faible                                                                   | deux publications, deux CSP, une vérification d'origine  | deux publications plus les contraintes des origines opaques |

Motif factuel d'élimination :

- **T1a** — mesurée compromise : lecture de l'OPFS et de l'IndexedDB de la coquille, capture du
  jeton de session par remplacement de prototype, écriture persistante et interception réseau par
  Service Worker. Le durcissement de realm à la manière de Live la réduit sans la fermer : il
  n'énumère que les intrinsèques connus et laisse intactes l'OPFS, l'IndexedDB, les verrous et la
  portée Service Worker de l'origine.
- **T1b** — sûre mais inutilisable : l'origine opaque prive l'application de `localStorage`, d'
  IndexedDB, de l'OPFS, des Web Locks et de `navigator.serviceWorker` (messages exacts au spike).
  Une application Rails y perdrait sa session et le mode hors ligne. Elle impose en outre au serveur
  de la coquille d'émettre `Access-Control-Allow-Origin: null` pour que le document opaque puisse
  seulement charger ses modules — c'est-à-dire d'ouvrir ces ressources à **tout** document sandboxé,
  `null` ne désignant personne.
- **T3** — cumule le coût de la seconde origine et l'infirmité fonctionnelle de l'origine opaque,
  sans gain mesuré sur T2 : les deux relevés sont identiques sur toutes les sondes visant la
  coquille.
- **T4** — supprime le rendu du HTML applicatif, donc le produit.

## Contraintes d'environnement relevées

### CSP

La coquille est servie avec une politique réellement appliquée, pas décorative :

```text
default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self';
worker-src 'self'; frame-src 'self' <origine applicative>; frame-ancestors 'none';
base-uri 'none'; form-action 'none'; object-src 'none'
```

Une sonde encadre volontairement une origine absente de `frame-src` : les trois moteurs émettent un
`securitypolicyviolation` avec `effectiveDirective: "frame-src"`. La CSP ne s'applique pas au
territoire applicatif — le HTML de l'application vient du guest, et la lui imposer reviendrait à
mesurer notre propre politique plutôt que la frontière. Injecter une CSP applicative depuis le proxy
reste un durcissement possible ; ce n'est pas une frontière, et cet ADR ne le compte pas.

### COOP/COEP et SharedArrayBuffer

Sans en-tête, `crossOriginIsolated` vaut `false` et le constructeur `SharedArrayBuffer` est absent,
en page comme en Worker, sur les trois moteurs. Avec `Cross-Origin-Opener-Policy: same-origin` et
`Cross-Origin-Embedder-Policy: require-corp`, la page et son Worker deviennent isolés et allouent un
`SharedArrayBuffer` (Chromium et Firefox mesurés ; WebKit isole la page mais refuse le module
importé par le Worker, voir le spike). Trois conséquences :

- l'isolation doit être portée par **chaque** artefact du runtime, le script du Worker compris :
  sans elle le Worker ne démarre pas ;
- sous `require-corp`, une iframe inter-origine qui n'a pas opté pour COEP est refusée
  (`net::ERR_BLOCKED_BY_RESPONSE`) : l'origine applicative doit donc servir COEP elle aussi ;
- `cross-origin-isolated` est une fonctionnalité pilotée par permission dont la liste par défaut est
  `self` : sous Chromium l'iframe applicative charge mais **n'hérite pas** de l'isolation et
  n'obtient pas `SharedArrayBuffer`. La coquille garde donc la mémoire partagée pour son runtime et
  la refuse au code applicatif sans effort particulier — propriété désirable qu'il faudra
  reconfirmer par moteur.

L'isolation n'est pas rendue obligatoire par cet ADR : v86 fonctionne sans mémoire partagée, et la
décision d'exiger COOP/COEP appartient au spike v86 #4 et à la matrice #2.

### Service Workers

La portée maximale d'un Service Worker est le répertoire de son script, sauf en-tête
`Service-Worker-Allowed` — que le serveur n'émet jamais. Une demande de portée `/` est refusée sur
les trois moteurs. Cela ne suffit pas : en T1a, la portée par défaut couvre déjà le répertoire de la
coquille et l'interception a été démontrée. En T2, la portée obtenue est
`http://localhost:4174/spike/origin/`, c'est-à-dire l'origine applicative seule ; la ressource
témoin de la coquille reste authentique.

Le mode hors ligne demande donc **deux** Service Workers : celui de la coquille sert la coquille et
le runtime ; celui de l'origine applicative sert les documents de l'application. C'est un coût réel
et c'est aussi une propriété : la panne de l'un ne compromet pas l'autre.

### Hébergement statique

GitHub Pages sert une seule origine par compte, `<compte>.github.io` ; les sites de projet en sont
des chemins et partagent donc cette origine. `github.io` figurant à la Public Suffix List, aucun
sous-domaine supplémentaire n'est obtenable par dépôt. Deux origines exigent donc l'une de ces
options :

| Option                                    | Coût                                                                          |
| ----------------------------------------- | ----------------------------------------------------------------------------- |
| domaine propre + sous-domaine applicatif  | un nom de domaine, deux enregistrements DNS, deux certificats gérés par Pages |
| second compte ou organisation GitHub      | gratuit, mais deux comptes à maintenir et deux publications à synchroniser    |
| autre hébergeur statique pour une origine | dépendance supplémentaire, à peser dans #45                                   |

Aucune n'est bloquante ; la première est recommandée parce qu'elle rend la relation entre les deux
origines lisible pour l'utilisateur. Le choix appartient à la publication (#45) et n'est pas figé
ici. En développement, `tools/serve.mjs --role app --host localhost --port 4174` fournit la seconde
origine sans DNS.

### Restauration inter-origine

La séparation d'origine ne change pas #12 mais la rend explicite : **aucun canal implicite ne relie
deux origines**. Un export produit par la coquille traverse la frontière comme un fichier choisi par
l'utilisateur, jamais par un stockage partagé. Cela vaut aussi pour un changement d'origine de la
coquille elle-même — passage à un domaine propre, changement de compte : l'OPFS de l'ancienne
origine devient inatteignable. L'export doit donc précéder tout déménagement d'origine, et #45 doit
traiter ce cas comme une migration, pas comme un détail de publication.

## Interfaces à ne pas figer avant #24

Le spike prototype un contrat volontairement pauvre. Sont **hors décision** et ne doivent pas être
reprises telles quelles :

- la forme des messages (`vault.app-hello`, `vault.channel-grant`, `vault.status`) et leur
  sérialisation ;
- la liste d'admission des requêtes applicatives, qui devra être dérivée des besoins réels de
  l'application, pas devinée ;
- le protocole d'établissement du canal privilégié coquille ↔ Worker, qui dépendra du spike v86 #4 ;
- la stratégie de reprise après perte du cadre applicatif ou du Worker ;
- l'allocation des cookies et du bocal de session entre les deux origines ;
- la géométrie du backend OPFS et les codes d'erreur, réservés à #6.

Ce que la décision fige, et seulement cela : **l'application n'a pas l'origine de la coquille**, et
le port qui les relie est un objet transféré, non une adresse devinable.

## Risques résiduels

1. **Une seule origine applicative pour toutes les applications.** Deux applications Rails publiées
   sur la même origine se lisent mutuellement OPFS, IndexedDB et cookies. Une origine par
   application, ou un partitionnement explicite, reste à décider — travail découvert, suivi par #46.
2. **Le port restreint reste une capacité.** Une fois transféré, il est joignable par tout script du
   document applicatif. Sa surface doit rester minimale et ne jamais transporter de handle.
3. **Compromission de la coquille elle-même.** La frontière ne protège pas d'une publication
   coquille altérée : `SEC-UPDATE-001` et #45 restent la seule réponse.
4. **Deux publications à faire coïncider.** Une origine applicative en retard sur la coquille est un
   risque de compatibilité ; la vérification d'identité des artefacts (#45) doit couvrir les deux.
5. **Écarts moteurs sur COOP/COEP.** WebKit refuse le module importé par un Worker tant que ce
   module ne porte pas lui-même la politique, et accorde l'isolation à l'iframe inter-origine que
   Chromium lui refuse ; Firefox n'a pas chargé l'iframe applicative sous `require-corp` dans nos
   conditions. Si l'isolation devient obligatoire, la matrice #2 devra trancher moteur par moteur.
6. **`Access-Control-Allow-Origin: null`** est employé par le serveur de test pour rendre les
   topologies opaques mesurables. Il ne doit jamais atteindre une publication réelle ; T2 ne l'exige
   pas.

## Conditions d'abandon

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- une preuve reproductible qu'un script du document applicatif franchit la frontière en T2 sur un
  moteur de la matrice cible ;
- l'impossibilité démontrée de publier deux origines dans le parcours d'installation visé, sans
  option acceptable pour l'utilisateur ;
- une exigence d'isolation cross-origin qui rendrait l'iframe applicative inutilisable sur un moteur
  obligatoire ;
- un changement de plateforme rendant le partitionnement de stockage par origine inopérant.

## Alternatives rejetées

- **Durcir le realm en même origine** (approche de Live, ADR 0008) : mesurée insuffisante ici. Elle
  ne couvre ni l'OPFS, ni l'IndexedDB, ni les verrous, ni la portée Service Worker. Elle reste utile
  en défense en profondeur, pas comme frontière.
- **Filtrer l'émetteur des messages** par URL du client : Live a montré que le critère répond à une
  autre question ; un script injecté dans la coquille émet avec l'URL de la coquille.
- **Origine opaque** (`sandbox` sans `allow-same-origin`, `srcdoc`, `blob:`) : détruit le stockage,
  les cookies et le Service Worker de l'application.
- **Runtime sans document applicatif** : supprime le rendu Rails.
- **Confiner par CSP seule** : la CSP borne le chargement, pas la lecture du stockage d'une origine
  déjà atteinte.
