# ADR 0030 — Le cycle de vie assemblé dans la coquille

- **Statut** : accepté
- **Date** : 2026-09-07
- **Issue** : [#163](https://github.com/pinfada/railsbox-vault/issues/163), tranche 3 de
  [#24](https://github.com/pinfada/railsbox-vault/issues/24)
- **Remplace** : rien. **Complète** : [ADR 0028](0028-coquille-de-produit-et-frontiere.md) (la
  coquille et sa frontière), [ADR 0029](0029-deverrouillage-dans-la-coquille.md) (le
  déverrouillage). **Referme** : la recommandation différée de
  [ADR 0010](0010-isolation-multi-origine.md) sur COOP, et la question ouverte du Service Worker
  dans la frontière.

## Contexte

`docs/architecture.md` § « Cycle de vie de référence » énumère **huit étapes** depuis l'origine du
dépôt. Jusqu'à cette tranche, elles étaient une **description** : la table d'avancement qui les
accompagne portait deux « PRODUIT depuis #161 » et six lignes qui disaient « banc », « #25 » ou «
non ouvert ». Aucune de ces étapes ne rougissait si on l'inversait, et la phrase la plus nette du
constat tenait en une ligne : « aucun scénario de `tests/e2e/` ne tourne encore sur la coquille
réelle — ils partent tous de `/vm/reference.html` ».

Trois choses manquaient, et elles ne sont pas de même nature :

- **l'ordre n'était contrôlé qu'à un seul endroit.** #161 avait posé une garde réelle — une annonce
  reçue avant l'établissement du canal privilégié est refusée par `VAULT_COQUILLE_CANAL_ABSENT` —,
  et rien d'équivalent ne tenait les six autres étapes ;
- **la VM n'était pas dans la coquille.** Le boot de v86, du guest, de Rails et du pont série vivait
  dans `public/vm/reference-worker-boot.mjs`, sous le jeton du harnais que #162 venait de retirer du
  chemin de produit ;
- **la mort du Worker de confiance n'avait ni détection ni conduite.** La seule borne existante
  rejetait sous `VAULT_COQUILLE_TYPE_INCONNU`, dont le message dit « Requête hors de la liste
  d'admission de la coquille » — c'est-à-dire tout autre chose que ce qui s'était produit. Le défaut
  a été relevé par la Definition of Ready de #25.

S'y ajoutait une décision **différée deux fois** : `Cross-Origin-Opener-Policy`, « recommandé » par
l'ADR 0010, posé par la seule chaîne de publication (ADR 0017 § 3), et jamais servi par le serveur
de test — donc jamais attesté par une épreuve.

## Décision 1 — L'ordre des huit étapes, et la preuve par l'échec de l'inverse

Les huit étapes sont **assemblées dans un chemin de produit** et leur ordre est tenu par une garde,
non par une convention. `src/coquille/cycle-de-vie.mjs` en fait une **suite contrôlée** :

| Étape | Ce que la coquille fait                                                 | Où                                            |
| ----- | ----------------------------------------------------------------------- | --------------------------------------------- |
| 1     | identités et capacités, mesurées dans son propre document               | `src/coquille/capacites-de-la-coquille.mjs`   |
| 2     | exclusivité du volume constatée, canal privilégié établi                | `src/coquille/exclusivite-du-volume.mjs`      |
| 3     | backend ouvert, **puis** VM démarrée                                    | `src/coquille/application-de-reference.mjs`   |
| 4     | document applicatif encadré, port restreint transféré                   | `public/main.mjs` (acquis de #161)            |
| 5     | le guest écrit, une barrière est acquittée, le compte remonte           | `public/runtime-worker.mjs`                   |
| 6     | export et migration                                                     | **banc** — `public/vm/`, et le journal le dit |
| 7     | fermeture propre : arrêt de la VM, instantané, `close()`, `terminate()` | `src/coquille/gestes-du-cycle.mjs`            |
| 8     | reprise : boot à froid, ou instantané lié à une génération exacte       | `src/vm/boot-de-reference.mjs`                |

**Conclure n'est pas réussir**, et c'est le point qui rend l'ordre tenable sans mentir. Une étape se
conclut avec une **issue** close : `franchie`, `differee`, `indisponible`, `banc`. Au démarrage
ordinaire le volume est verrouillé, donc il n'y a ni backend ni VM : l'étape 3 est conclue
`differee`, et non sautée. Sauter une étape rendrait le journal muet exactement là où il devrait
parler.

Le relevé publie chaque étape **datée**, en millisecondes depuis l'évaluation du module de la
coquille. L'ordre est donc **mesuré**, pas affirmé.

**Les deux preuves par l'échec de l'inverse :**

- **un cadre créé avant le canal privilégié ne reçoit aucun port.** C'est la garde de #161
  (`VAULT_COQUILLE_CANAL_ABSENT`, mutant n° 1 de l'ADR 0028, TUÉ), à laquelle #163 ajoute une
  seconde condition : `peutEncadrer()` refuse le cadre tant que l'étape 3 n'a **rien conclu** —
  quelle que soit son issue. Un cadre qui n'attendrait qu'une VM _démarrée_ n'apparaîtrait jamais
  sur un moteur sans OPFS synchrone ; ce que l'ordre exige n'est pas que la VM tourne, c'est que la
  coquille ait **dit où elle en est** avant d'ouvrir une frontière ;
- **un boot demandé avant l'ouverture du backend est refusé**, par
  `VAULT_COQUILLE_ETAPE_HORS_ORDRE`. Le refus porte le code de l'**ordre** et non un code de support
  : ce n'est pas le stockage qui a échoué, c'est l'étape 3 qui a été demandée à l'envers, et un code
  de support enverrait chercher un défaut de disque là où il n'y en a pas.

### Ce que l'étape 1 mesure, et pourquoi pas la sonde

`public/compat.html` (#2) est **exemptée de la CSP de la coquille**, délibérément : « une CSP qui
refuserait WebAssembly ferait rendre _capacité absente_ à un navigateur qui la possède ». Cette
exemption est juste pour une sonde et fausse pour un produit. La coquille mesure donc ses capacités
**dans son propre document, sous la politique qu'on lui sert réellement**, et ce qui manque est
**nommé**.

Cinq capacités sont **exigées** — WebCrypto, WebAssembly, Worker de module, `MessageChannel`,
`structuredClone` : leur absence ne laisse aucun chemin dégradé, et mener l'utilisateur jusqu'à une
phrase saisie pour lui refuser ensuite serait pire que de le dire tout de suite. Deux sont
**facultatives** :

- `navigator.credentials` — son absence retire la passkey et laisse la phrase et le code (ADR 0021)
  ;
- `navigator.storage.getDirectory` — et le classer facultatif est une **décision**, prise après
  mesure. Il manque au **document** sous WebKit. L'exiger ferait refuser le démarrage de la coquille
  sur un moteur qui la porte par ailleurs, et ferait disparaître avec elle la frontière d'origine,
  les dix refus et l'interface que #161 et #162 y mesurent. L'absence d'OPFS est déjà rendue comme
  un **état** — `indisponible` — par le Worker de confiance, et l'ADR 0029 dit pourquoi : « ce n'est
  pas le geste qui a échoué ». Deux décisions pour une même absence, dont l'une annulerait ce que
  l'autre publie.

### Ce que l'étape 2 constate, et ce qu'elle ne vaut pas

Le Worker de confiance prend le handle exclusif du volume, **puis le relâche aussitôt**, avant
qu'aucun document applicatif n'existe. C'est une **observation**, pas une réservation, et il faut le
dire tel quel :

- ce qu'elle apporte — un second détenteur est nommé sous `VAULT_STORAGE_BUSY` **avant** qu'une
  phrase ait été saisie, et non découvert au milieu d'un déverrouillage ;
- ce qu'elle ne vaut pas — entre le constat et l'ouverture réelle, un autre onglet peut prendre le
  handle. L'exclusivité **continue** est le bail d'écriture
  ([#79](https://github.com/pinfada/railsbox-vault/issues/79)), hors de cette tranche. Une
  réservation tenue jusqu'au déverrouillage ferait d'ailleurs rendre `VAULT_STORAGE_BUSY` à
  l'ouverture qui la suit : la coquille se refuserait le volume à elle-même.

Un volume **absent** n'est pas un refus : l'ouvrir pour poser la question le **créerait**.

### Deux volumes, un seul coffre

La coquille tient `coquille` depuis #161 — trente-deux secteurs, l'état et le compte de barrières.
Le disque de l'application est un **autre** volume, `application`, et ce n'est pas une commodité :

- un volume déclare sa taille à sa **naissance** et ne grandit pas, or le coffre est créé au premier
  geste de déverrouillage, bien avant qu'on sache si une application sera installée ;
- l'ADR 0018 range déjà les applications par volume, et c'est la forme vers laquelle #24 va ;
- les deux sont scellés sous la **même** clé de volume, développée de la **même** enveloppe, avec
  des identifiants de volume **distincts** — sans quoi un secteur de l'un se rejouerait dans l'autre
  (ADR 0015, données associées).

L'identifiant du volume applicatif n'est pas une constante : il est tiré à sa création et inscrit
dans son manifeste voisin, qui en est ensuite la source (ADR 0016).

### Le boot déplacé, et non recopié

`public/vm/reference-worker-boot.mjs` devient `src/vm/boot-de-reference.mjs`. Le laisser sous
`public/vm/` aurait fait importer un **banc** par un chemin de production ; le recopier en aurait
fait deux versions qui divergent au premier correctif. **Une seule chose a changé en le déplaçant**
: `ouvrirLeVolumeDuGuest` est désormais injecté — le banc ouvre sous le jeton du harnais
(`cle-du-banc.mjs`), la coquille sous la clé développée de son enveloppe. Deux provenances de clé,
un seul chemin de boot.

Le module de boot est importé **dynamiquement**, au premier démarrage d'application : il pose la
boucle d'ordonnancement de v86 à son évaluation (ADR 0013), et une coquille qui ne démarre aucune
application n'a aucune raison de la porter.

### Le descripteur d'application, et pourquoi il est servi

La coquille ne peut lire que ce que son origine sert. Le manifeste de l'image de référence vit dans
`tools/`, que rien ne sert ; sans un descripteur servi, la coquille ne saurait ni la taille du
disque à installer, ni la ligne de commande du guest, ni l'identité que le manifeste du volume doit
déclarer — elle devrait les recevoir d'un **harnais**, c'est-à-dire du chemin que #162 a précisément
fermé. `tools/build-reference-image/manifest.mjs` écrit donc `artifacts/application.json`, dérivé du
manifeste et ne portant que du public : des noms d'artefacts, des tailles, une ligne de commande.

## Décision 2 — Un scénario de bout en bout sur la coquille RÉELLE

`tests/e2e/reprise-coquille-boot-froid.spec.mjs` part de `public/index.html`, avec **deux origines
réelles** servies par les deux rôles de `tools/serve.mjs`, et joue le cycle entier : la coquille se
monte et encadre le document applicatif sur l'origine distincte ; un geste ouvre le coffre par une
phrase ; un second **installe** le disque de l'image de référence dans un volume chiffré et **boote
Rails dans le Worker de confiance** ; un troisième **ferme proprement** ; la page est fermée — ce
qui tue le Worker, ses handles et sa mémoire — puis rouverte, et une nouvelle dérivation de la même
phrase rouvre l'enveloppe. **L'application n'est pas réinstallée** : le volume, son manifeste et son
enveloppe ont survécu, et l'invariant applicatif est retrouvé à l'identique.

Le scénario sur `/vm/reference.html` **reste** : `reprise-mutation-boot-froid.spec.mjs` est le
témoin de la reprise **hors ligne**, et les deux ne se remplacent pas — l'un mesure l'assemblage,
l'autre l'indépendance au réseau.

**Deux serveurs de plus** sont ajoutés à `playwright.e2e.config.mjs`, et non les deux existants : le
scénario a besoin d'un rôle `shell` **et** d'un rôle `app`, là où A et B sont tous deux des rôles
`shell` — le rôle `shell` sert `frame-ancestors 'none'`, qui rendrait le document applicatif
**inencadrable**. Changer le rôle de B aurait déplacé les en-têtes sous trois scénarios qui n'ont
rien demandé.

Le `skip` porte sur une **condition explicite** et nommée — manifeste absent, artefacts de l'image
absents, descripteur absent, artefacts v86 absents —, jamais sur un défaut. Une suite qui se
déclarerait ignorée sans dire pourquoi passerait au vert là où elle doit parler.

**Durée** : le scénario ajoute deux boots Rails et deux dérivations Argon2id à `reprise.yml`, soit
environ **dix minutes** de plus sur une recette qui en dure soixante à soixante-dix.

## Décision 3 — La mort du Worker : détection et conduite ; l'état et la règle sont à #25

**La frontière, écrite pour qu'aucune tranche ne préempte l'autre** (commentaire de décision du 7
septembre 2026 sur #163, DoR de #25 décision 4) :

- **#163 possède la DÉTECTION et la CONDUITE** : constater qu'un Worker ne répond plus, poser la
  coquille dans l'état que #25 définit, et le dire au cadre ;
- **#25 possède l'ÉTAT et la RÈGLE** : ce que « verrouillé » veut dire, les déclencheurs, le délai.
  #163 les **cite**, et n'en choisit aucun.

La position tombe d'elle-même une fois la frontière posée : **verrouiller, c'est atteindre
volontairement l'état que la mort du Worker atteint par accident.** Un seul état, deux chemins.

**Détection — trois causes, et pas une quatrième :**

| Cause         | Ce qui la livre                                                         |
| ------------- | ----------------------------------------------------------------------- |
| `erreur`      | `error` ou `messageerror` sur le Worker : il a jeté                     |
| `silence`     | aucune réponse sous `DELAI_WORKER_MORT_MS` (trente secondes)            |
| `terminaison` | `terminate()` appelé par la coquille — le chemin de la fermeture propre |

Une cause hors table est **refusée** plutôt que rangée dans la plus proche : constater une mort par
défaut ferait verrouiller un coffre vivant.

**Conduite — refuser tout service jusqu'à un geste explicite.** Des deux options de la DoR de #24,
c'est la seconde. Elles ne diffèrent que par un point, et il faut le nommer : **remonter l'interface
de déverrouillage n'est pas « redemander automatiquement »**. La coquille l'affiche, et **ne dérive
rien** tant que personne n'a agi. Les deux secondes d'Argon2id se paient dans les deux cas ; la
seule question est qui décide de les payer, et ce n'est pas la coquille.

Concrètement : l'état passe à `verrouille` (ou reste `indisponible` — la mort n'invente pas un
verrou sur un moteur qui n'a jamais rien pu ouvrir) ; toute demande **en vol** reçoit un refus typé
plutôt qu'un silence ; la **poussée** de barrière cesse ; l'interface est remontée ; aucune KEK
n'est gardée « pour plus tard ». La garde porte sur l'entrée du **calcul** et pas seulement sur
l'entrée du canal : sans cela, une phrase présentée sur un coffre dont l'enveloppe porte déjà un
emplacement partirait droit dans Argon2id, pour une KEK que personne ne pourrait plus recevoir.

**Le code de refus est neuf** : `VAULT_COQUILLE_WORKER_MORT`, inscrit au § 10.5 de
`docs/format-de-volume-v3.md` et tenu par le cliquet d'exhaustivité de
`tests/unit/dossier-de-revue.test.mjs`. Il remplace `VAULT_COQUILLE_TYPE_INCONNU`, dont le message
décrivait un autre événement que le sien.

**Comment la mort est provoquée dans l'épreuve, et pourquoi pas par une poignée** : le module du
Worker est **substitué au niveau du réseau** (`page.route`). #162 a retiré le jeton de harnais du
chemin de produit ; lui rendre une poignée de test — un `globalThis.tuerLeWorker` — reviendrait à
rouvrir cette porte pour la commodité d'une épreuve. L'interception est du côté où le produit n'a
rien à dire.

## Décision 4 — COOP servi et attesté ; le Service Worker dans la frontière est REFUSÉ

**`Cross-Origin-Opener-Policy: same-origin` est servi sur l'origine de confiance**, par
`tools/serve-headers.mjs` — donc par la **source unique** dont `tools/publier-en-tetes.mjs` dérive
ses blocs `_headers`. Il figurait auparavant dans la table des en-têtes _ajoutés par la
publication_, et c'était précisément ce qui rendait la décision inéprouvable : aucune suite ne
pouvait attester `window.opener === null` sur une page qui ne portait pas l'en-tête. L'entrée a donc
quitté cette table : une source, deux consommateurs.

Ce qu'il ferme, et que rien d'autre ne ferme : la relation d'**ouverture** inter-fenêtres.
`frame-ancestors 'none'` interdit d'**encadrer** la coquille ; il ne dit rien d'une fenêtre qu'elle
ouvre. Une coquille qui détient la KEK de la session pour toute sa durée (#162) n'a aucune raison de
laisser vivre une référence `window.opener`.

**Attestation, sur les trois moteurs** (`tests/browser/entetes-durcissement.spec.mjs`) : une fenêtre
**inter-origine** ouverte depuis la coquille par `window.open` rend `window.opener === null`. Le
relevé est encadré par deux témoins, sans lesquels il ne prouverait rien :

- **témoin positif** — deux documents de la **même** origine, portant la même politique, restent
  liés. COOP compare deux documents avant de couper, et c'est ce que la directive dit ; ce relevé
  montre que la sonde **sait lire** un opener quand il y en a un ;
- **témoin négatif** — la **même** fenêtre inter-origine, ouverte depuis le rôle `app`, qui ne
  reçoit pas l'en-tête : l'opener est présent. La variable est l'en-tête, et rien d'autre.

Le geste est un `window.open` déclenché par un **clic**, et non une ancre `target="_blank"` : les
moteurs posent `noopener` implicitement sur celle-ci, et l'épreuve mesurerait cette convention au
lieu de l'en-tête.

**COOP est posé sur la coquille seule.** Un document **encadré** n'est pas un contexte de navigation
de plus haut niveau : l'en-tête y serait sans effet, et le poser ferait croire à une protection que
le moteur ignore. **COEP reste écarté** (ADR 0010) : il exigerait de chaque sous-ressource
inter-origine un consentement explicite, y compris du territoire du guest, ce que l'ADR 0002 refuse
de contraindre. COOP servi **seul** ne confère donc pas `crossOriginIsolated`, et ne le prétend pas.

**Rappel qui n'est pas de style** : `SEC-ORIGIN-001` est démontré par la **partition d'origine**,
jamais par COOP ni COEP. COOP ferme une relation de fenêtres ; il ne cloisonne aucun stockage.

### Un Service Worker qui injecterait COOP est INADMISSIBLE dans la frontière

L'ADR 0010 posait la question nommément — « #24 doit dire si un Service Worker injectant COOP est
admissible DANS la frontière » —, parce qu'un hébergeur sans en-têtes laisserait cette porte comme
seule façon de servir la politique. **Elle est fermée, et le refus est de fond** :

- un Service Worker sur l'origine de confiance interpose du code **privilégié** entre l'hébergeur et
  la coquille. Il voit passer chaque requête, survit à la fermeture de l'onglet, et se met à jour
  par un chemin distinct de celui du reste. La frontière de l'ADR 0002 sépare deux **origines** ;
  elle ne dit rien d'un tiers installé **dans** l'une d'elles ;
- l'hébergeur à en-têtes est de toute façon **exigé des deux côtés** : le territoire applicatif
  reçoit `Content-Security-Policy: frame-ancestors <coquille>` de la publication (ADR 0017 § 3 bis),
  et GitHub Pages est déjà écarté pour cette raison. Un Service Worker ne résoudrait donc rien qu'un
  hébergeur ne résolve, et il ajouterait un composant privilégié de plus ;
- un `<meta>` ne porte ni COOP ni `frame-ancestors` (ADR 0017, fait 1) : il n'existe pas de
  troisième voie.

L'absence est **surveillée** plutôt qu'affirmée : `tests/unit/coquille-sans-service-worker.test.mjs`
rougit si un appel d'enregistrement apparaît dans ce que l'origine de confiance sert. Le territoire
**applicatif**, lui, en porte un dans le banc du spike #35, et c'est son droit : ce que le guest
sert lui appartient.

## Mesures

Publiées sans seuil, comme celles de #161 et #162. Le relevé de la coquille porte le **cycle daté**
étape par étape ; le scénario de bout en bout écrit `reports/e2e/reprise-coquille.json`.

| Grandeur                                                       | Où elle est lue                                                 |
| -------------------------------------------------------------- | --------------------------------------------------------------- |
| instant de conclusion de chacune des huit étapes               | `#coquille-rapport` › `cycle[].instantMs`, trois moteurs        |
| établissement du canal privilégié, chargement du cadre         | `mesures.canalPrivilegieMs`, `mesures.cadreApplicatifMs` (#161) |
| installation du disque applicatif : octets écrits              | `application.installation`                                      |
| boot Rails **dans la coquille** : santé, décomposition, rythme | `application.santeMs`, `application.decomposition`              |
| boot Rails **dans le banc**, pour comparaison                  | `reports/e2e/reprise-boot-froid.json` (inchangé)                |
| capture d'instantané à la fermeture propre                     | `fermeture.capture`                                             |
| délai entre la mort du Worker et le refus d'un geste           | `tests/browser/coquille-cycle-de-vie.spec.mjs`, borne à 1,5 s   |

Le boot dans la coquille et le boot dans le banc empruntent désormais **le même code** : ce que
l'écart entre les deux relevés mesure est donc la différence de **chemin d'ouverture du volume** —
jeton du harnais d'un côté, enveloppe de clé de l'autre — et rien de plus.

## Limites, dites plutôt que tues

- **WebKit reste `indisponible`.** L'OPFS synchrone manque au Worker, et
  `navigator.storage.getDirectory` manque au document. Rien ne s'y déverrouille et rien ne s'y boote
  ; ce que la suite y mesure est l'ordre, les refus, la mort du Worker et COOP — et elle le
  **déclare** au lieu de passer au vert par vacuité ;
- **le document encadré n'est pas encore servi par le guest.** L'étape 4 encadre
  `public/document-applicatif.html`, servi par l'origine applicative ; le proxy qui relaierait ce
  que Rails rend n'est pas dans cette tranche. La VM tourne pour la durée du geste de démarrage, et
  l'ordre « étape 3 puis étape 4 » se lit comme il est écrit : le cadre n'est créé qu'une fois
  l'étape 3 **conclue**, jamais avant ;
- **ce que Playwright ne simule pas** : ni une mise en veille du système, ni une éviction d'onglet
  sous pression mémoire, ni un `freeze` livré par le moteur, ni la mort du processus. La mort du
  Worker est provoquée par un module qui jette, par un module muet, et par le `terminate()` du
  produit — trois chemins réels, et l'aveu que ce ne sont pas tous les chemins ;
- **aucun authentificateur réel** : la passkey n'est pilotable que sous Chromium (ADR 0021), et le
  scénario de bout en bout emploie la **phrase** ;
- **l'exclusivité constatée n'est pas une exclusivité tenue** (voir décision 1) ;
- **la sonde d'exfiltration de #162 n'est pas rejouée après la mort du Worker.** Elle mesure ce qui
  n'est pas persisté, et rien de nouveau n'est écrit par cette tranche ; #25 la rejouera après un
  verrouillage, où la question se pose pour de bon.

## Impacts sur les décisions antérieures

- **[ADR 0002](0002-topologie-origine-de-confiance.md)** — l'interface réservée « stratégie de
  reprise après perte du cadre ou du Worker » est **décidée** : refuser tout service jusqu'à un
  geste explicite (décision 3). C'est la dernière des six interfaces que l'ADR 0002 réservait à #24
  ;
- **[ADR 0010](0010-isolation-multi-origine.md)** — la recommandation COOP est **réalisée** et
  attestée ; l'admissibilité d'un Service Worker dans la frontière est **refusée** ; COEP reste
  écarté, inchangé ;
- **[ADR 0017](0017-chaine-de-publication.md)** — COOP quitte la table des en-têtes ajoutés par la
  publication pour la source unique. La publication continue de le poser, sans le recopier ;
- **[ADR 0024](0024-instantane-de-reprise.md)** — la capture au **point de contrôle** est réemployée
  telle quelle par la fermeture propre, dans l'ordre de sa décision 6. La décision 8 (« le
  verrouillage retire l'instantané ») n'est **pas** rouverte ici : elle appartient à #25 ;
- **[ADR 0028](0028-coquille-de-produit-et-frontiere.md)** — la coquille gagne deux gestes
  privilégiés (`demarrer-application`, `fermer-le-coffre`) et quatre codes de refus. Le relevé reste
  **borné** : le compte rendu de boot porte une trentaine de champs, et ce qui repart sur le canal
  est une liste **fermée** ;
- **[ADR 0029](0029-deverrouillage-dans-la-coquille.md)** — la KEK **retenue** trouve son second
  usage : elle développe la clé du volume applicatif à chaque geste de démarrage, sans redemander la
  phrase. Sa durée reste bornée par #25.

## Campagne de mutation

Dix-sept gardes, chacune retirée du source dans un atelier temporaire, l'épreuve rejouée
(`tools/muter-gardes-cycle-de-vie.mjs`, moteur partagé).

| #   | Garde retirée                                                               | Verdict |
| --- | --------------------------------------------------------------------------- | ------- |
| 1   | `exigerLOrdre` — la table des étapes connues                                | TUÉ     |
| 2   | `exigerLOrdre` — la table des issues                                        | TUÉ     |
| 3   | `exigerLOrdre` — l'unicité d'une étape                                      | TUÉ     |
| 4   | `exigerLOrdre` — la boucle sur les étapes antérieures, c'est-à-dire l'ORDRE | TUÉ     |
| 5   | `exigerLeBackend` — l'exigence d'un volume OUVERT                           | TUÉ     |
| 6   | `peutEncadrer` — la condition sur l'étape 3                                 | TUÉ     |
| 7   | `conduiteApresLaMort` — la table des causes                                 | TUÉ     |
| 8   | `conduiteApresLaMort` — la préservation de l'état `indisponible`            | TUÉ     |
| 9   | `conduiteApresLaMort` — le code rendu                                       | TUÉ     |
| 10  | `estUneMortDuWorker` — la comparaison de code                               | TUÉ     |
| 11  | `mesurerLesCapacites` — le filtre des capacités exigées                     | TUÉ     |
| 12  | `mesurerLesCapacites` — le `try/catch` autour de chaque sonde               | TUÉ     |
| 13  | `constaterLExclusivite` — le constat « sans-volume » avant toute ouverture  | TUÉ     |
| 14  | `constaterLExclusivite` — la fermeture du handle                            | TUÉ     |
| 15  | `constaterLExclusivite` — le court-circuit sur `peutOuvrir`                 | TUÉ     |
| 16  | `lireLeDescripteur` — le contrôle de version                                | TUÉ     |
| 17  | `lireLeDescripteur` — le contrôle du statut HTTP                            | TUÉ     |

**17/17.** Un mutant a **survécu** avant d'être tué, et c'est le service que la campagne rend : le
n° 12 — retirer le `try/catch` de la sonde de capacités laissait l'épreuve verte, parce que le
chaînage optionnel (`portee?.crypto?.subtle`) ne lève sur aucune portée amputée. Ce qui lève, c'est
un **accesseur** — et un moteur peut en poser un qui refuse : `navigator.storage` en est un, et un
navigateur qui bloque le stockage du site peut y jeter `SecurityError`. L'épreuve confronte
désormais une portée dont un accesseur jette.

Ce que la campagne ne peut pas mesurer se dit au même endroit : qu'un Worker qui jette livre bien un
événement `error`, qu'une borne de trente secondes expire, que COOP coupe une relation d'ouverture,
que Rails boote sur un volume OPFS. Cela relève du navigateur, sur les trois moteurs, et du scénario
de bout en bout.

## Alternatives rejetées

- **Un Service Worker injectant COOP sur l'origine de confiance** — voir décision 4. Il mettrait du
  code privilégié à la place de l'hébergeur, et ne résoudrait rien qu'un hébergeur à en-têtes ne
  résolve déjà.
- **Redemander automatiquement le geste de déverrouillage à la mort du Worker** — c'est l'autre
  option de la DoR de #24. Elle paie exactement le même prix — deux secondes d'Argon2id — mais le
  paie **sans que personne l'ait demandé**, et sur un événement que l'utilisateur n'a pas provoqué.
  Remonter l'interface suffit ; agir à sa place ne suffit à rien de plus.
- **Démarrer l'application automatiquement après le déverrouillage** — un boot coûte deux minutes
  sur une machine ordinaire, et décider de les payer appartient à qui ouvre le coffre. Les deux
  gestes du cycle sont donc des **boutons**, comme les quatre de #162.
- **Faire du volume `coquille` le volume de l'application** — un volume déclare sa taille à sa
  naissance et ne grandit pas (voir décision 1).
- **Passer le descripteur d'application par un paramètre d'URL** — ce serait rouvrir la porte du
  jeton de harnais que la décision 1 de l'ADR 0029 a fermée, pour une donnée qui n'est même pas un
  secret. Elle est **servie** par l'origine de confiance.
- **Recopier le chemin de boot dans la coquille** — deux versions divergent au premier correctif. Le
  module est **déplacé**, et le seul point de variation — d'où vient la clé de volume — est un
  paramètre.
