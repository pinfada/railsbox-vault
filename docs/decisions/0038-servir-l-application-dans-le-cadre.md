# ADR 0038 — Servir l'application dans le cadre : le relais HTTP et la coquille de cadre

- Statut : accepté
- Date : 2026-09-12
- Issue : #192 (tranche P1 de l'épique #195) · Invariant : `SEC-ORIGIN-001` · Jalon 5
- **Lève la limite écrite de l'[ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md)** : « le
  document encadré n'est pas encore servi par le guest ; le proxy qui relaierait ce que Rails rend
  n'est pas dans cette tranche. »

## Contexte

Le cycle de vie était assemblé depuis #163 : un coffre s'ouvre par une phrase, installe un disque
applicatif chiffré, boote Rails dans un Worker de confiance, acquitte ses barrières, se verrouille,
se rouvre. Tout cela fonctionnait, et **aucune page métier n'apparaissait jamais**. L'étape 4
encadrait `public/document-applicatif.html` — un document de démonstration servi par l'origine
applicative — qui s'annonçait, recevait un port restreint, demandait l'état du coffre et affichait
un `<pre>`. Un utilisateur non technique n'avait rien à regarder.

La question de la tranche est donc étroite et lourde à la fois : **comment les octets que Rails rend
dans la machine virtuelle deviennent-ils des pixels dans le cadre**, sans que le document applicatif
obtienne autre chose que des réponses HTTP, et sans qu'une seule ligne de l'ADR 0028 soit relâchée.

Trois mécanismes étaient candidats, et l'issue les nommait. Ils n'ont pas été départagés par
préférence : ils ont été instruits contre une MESURE, prise avant la décision, et contre la
frontière.

## La mesure, prise AVANT la décision

Le dépôt mesurait le BOOT — p95 = 125,9 s — et deux requêtes JSON de quelques centaines d'octets.
Une page HTML avec ses actifs, un formulaire et une redirection est un autre régime, et personne
n'avait le chiffre. `tests/vm/mesure-pont-serie-http.spec.mjs` le prend, sur le guest réel, à
travers le pont série `@VLT1`, depuis un Worker de navigateur.

Il a fallu d'abord donner à l'application de référence une surface à mesurer : elle n'avait que deux
routes JSON, « sans session, sans cookie, sans gabarit et sans une ligne de JavaScript ». Elle porte
désormais un document, une feuille de style, un script, une image, un formulaire protégé par un
jeton anti-CSRF, une redirection 303 et un cookie de session
(`apps/reference/app/controllers/pages_controller.rb`). C'est le plus petit terrain qui porte les
quatre natures de requête qu'un relais doit franchir.

**Relevé du 12 septembre 2026, Chromium** (`reports/mesures/pont-serie-http-chromium.json`) :

| Geste                                      | Durée                         | Octets reçus |
| ------------------------------------------ | ----------------------------- | ------------ |
| page d'accueil (document HTML)             | 351,5 ms                      | 1 083        |
| `/vault.css`                               | 50,8 ms                       | 402          |
| `/vault.js`                                | 75,4 ms                       | 396          |
| `/vault.png`                               | 63,3 ms                       | 2 053        |
| les trois actifs demandés **en parallèle** | 186,9 ms                      | —            |
| page suivante (session chaude)             | 281,8 ms                      | 1 083        |
| soumission du formulaire (POST, 303)       | 380,2 ms                      | 0            |
| redirection suivie (la note créée)         | 112,4 ms                      | 1 102        |
| **total du parcours**                      | **1 315,4 ms** sur 7 requêtes | **6 119**    |

Trois faits sortent de cette table, et ils décident :

1. **une page complète coûte environ 540 ms** — document plus trois actifs —, soit dix fois moins
   que le seuil de cinq secondes que l'issue pose comme condition d'abandon. Le pont série n'est pas
   le goulot ;
2. **le parallélisme n'achète rien** : trois actifs demandés ensemble coûtent 186,9 ms contre 189,5
   ms en série. Le fil série les sérialise de toute façon. Un relais n'a donc aucune raison d'être
   malin sur la concurrence, et sa borne d'en-vol est une borne de MÉMOIRE, pas de débit ;
3. **la session Rails traverse** : le cookie a fait l'aller-retour (le compteur de vues de la page
   avance), et le jeton anti-CSRF du formulaire s'apparie.

**Firefox : la mesure n'a PAS pu être prise, et c'est écrit plutôt que tu.** Rails n'a jamais
répondu à `/vault/health` dans le guest sous ce moteur, deux fois, sous deux budgets — 300 s (« le
pont a refusé la requête : application-injoignable (code 7) ») puis 900 s (« aucune réponse à GET
/vault/health en 5000 ms »). Le pont série répond d'abord, puis se tait ; Puma n'écoute jamais.
C'est cohérent avec la position déjà écrite du dépôt (`playwright.vm.config.mjs` : « Chromium porte
TOUTE la suite ; Firefox et WebKit ne portent que le TÉMOIN de démarrage »), et ce n'est pas un
défaut du relais — rien de ce que cette tranche livre n'a pu être exécuté sous ce moteur, puisque le
boot n'y aboutit pas. **La cause n'est pas établie par #192, et l'affirmer serait deviner.**
`docs/compatibility.md` le porte, et l'épreuve s'ignore en NOMMANT sa cause au lieu de passer au
vert par vacuité.

**WebKit : impossible**, et c'est un fait antérieur — il n'expose pas l'OPFS sous Playwright
(`VAULT_STORAGE_UNSUPPORTED`), donc aucun volume ne s'y ouvre et aucun guest n'y boote sur un
disque.

## Décision 1 — Le mécanisme : un Service Worker sur l'origine APPLICATIVE

### Les trois candidats, instruits un par un

**(1) Service Worker sur l'origine applicative**, relayant vers la coquille par un client.

- _ce qu'il relaie_ : **tout**. La navigation de haut niveau du cadre, les sous-ressources
  (`<link>`, `<script>`, `<img>`, `url()` d'une feuille de style), un `<form>` natif en POST, les
  redirections 3xx que le navigateur suit lui-même, les URL relatives résolues par le moteur ;
- _ce qu'il ne relaie pas_ : WebSocket et `EventSource` (aucun usage ; le pont série n'a pas de
  canal montant persistant), et tout ce que la page demande à une AUTRE origine — qu'il laisse au
  réseau, comme il se doit ;
- _ce qu'il expose_ : c'est la question de fond, et elle est traitée à la décision 4 ;
- _son coût mesuré_ : celui de la table ci-dessus, plus un aller-retour `postMessage` par requête,
  sous la milliseconde.

**(2) Shim de `fetch`, `XMLHttpRequest` et navigation, injecté dans le document applicatif.**

- _ce qu'il relaie_ : ce que le code applicatif appelle explicitement, et ce que le shim sait
  intercepter — un clic sur un lien, un `submit` d'événement ;
- _ce qu'il ne relaie pas_, et c'est **rédhibitoire** : les SOUS-RESSOURCES. Une page Rails qui
  écrit `<link rel="stylesheet" href="/vault.css">` fait demander cette adresse par le MOTEUR, pas
  par du JavaScript ; un shim ne la voit pas, et le serveur statique de l'origine applicative
  rend 404. Pour y remédier il faudrait RÉÉCRIRE le HTML et le CSS rendus par le guest —
  c'est-à-dire écrire un moteur de réécriture d'URL, et servir à l'utilisateur un document que
  l'application n'a pas écrit. Il ne relaie pas davantage `form.submit()` appelé en JavaScript (qui
  ne déclenche aucun événement `submit`), ni `location.assign` ;
- _est-il contournable par le code applicatif ?_ **Oui, trivialement** : un `fetch` repris d'une
  iframe fraîche échappe au patch. Ce n'est pas ce qui le disqualifie — un shim n'est pas une
  frontière, et le contourner ne donne rien d'autre qu'un 404 du serveur statique. Ce qui le
  disqualifie est qu'il ne SERT pas une page réelle ;
- _son coût_ : le même que (1), plus une réécriture dont personne ne sait dire quand elle est
  complète.

**(3) Réseau virtuel v86 (`network_adapter`) relayé en page.**

- _ce qu'il relaierait_ : tout, au niveau IP, y compris ce que (1) laisse de côté ;
- _ce qu'il exige_ : une image de référence dotée d'une carte réseau émulée, d'une configuration
  d'adresse et d'une route — l'image actuelle n'en a aucune, et c'est la raison d'être du pont série
  (« le guest de l'image de référence n'a pas de réseau émulé ») —, plus une pile TCP/IP **dans la
  page** pour terminer les connexions du guest. C'est un composant de plusieurs milliers de lignes,
  qui remplacerait un pont MESURÉ par un pont qui ne l'est pas ;
- _ce qu'il expose_ : une pile réseau complète dans le territoire de confiance, avec ce qu'une pile
  réseau implique — fragmentation, temporisations, états de connexion — là où le pont série n'a que
  des lignes ASCII acquittées une par une ;
- _son coût_ : hors du périmètre de cette tranche, et **refusé pour cette raison-là**, pas pour son
  mérite. Il reste la voie à instruire le jour où le débit du pont série deviendra le goulot — ce
  que la mesure ci-dessus dit qu'il n'est pas.

### La décision, et ce qu'elle refuse

**Le mécanisme retenu est (1).** Ce qu'il refuse, nommément :

- il refuse (2) parce qu'une application n'est pas servie quand ses actifs manquent ;
- il refuse (3) parce qu'il faudrait reconstruire l'image et écrire une pile réseau pour gagner un
  débit dont la mesure dit qu'il n'est pas nécessaire ;
- il refuse **de suivre les redirections lui-même** : une redirection est rendue au navigateur, qui
  la suit et met à jour l'URL du cadre. La suivre dans le relais rendrait la bonne page sous la
  mauvaise adresse, et un lien relatif de la page d'arrivée se résoudrait contre le chemin du
  formulaire ;
- il refuse **de mettre quoi que ce soit en cache**. Aucun `caches.open`, aucun stockage, aucune
  persistance : le Service Worker ne retient rien d'une session de coffre après son verrouillage —
  non parce qu'on l'efface, mais parce que rien n'a été écrit.

**Si aucun des trois n'avait tenu la page d'accueil sous cinq secondes après le boot**, l'issue
demandait de le dire et de proposer le pas suivant au lieu de forcer. Le cas ne s'est pas présenté :
541 ms, mesurés, pour la page et ses trois actifs.

## Décision 2 — Un TROISIÈME canal, et aucun type neuf sur le canal privilégié

Le trafic d'une application doit atteindre le Worker de confiance, seul à tenir la session guest.
Trois voies étaient possibles, et deux sont refusées :

- **ajouter des types au canal PRIVILÉGIÉ** — refusé. Ce canal porte les clés, les enveloppes et les
  gestes de l'utilisateur ; c'est la surface la plus sensible du produit, et lui apprendre à porter
  le trafic d'une application l'élargirait pour toujours. Il est en outre traité **en série** : une
  requête HTTP y retarderait un déverrouillage, et une requête qui n'aboutirait pas ferait déclarer
  mort un Worker parfaitement vivant ;
- **un second message sur le canal GLOBAL du Worker** — refusé. Ce canal n'accepte aujourd'hui qu'UN
  message, d'UN type, UNE seule fois ; lui en ajouter un second élargirait cette porte-là ;
- **un TROISIÈME canal, établi dans la MÊME poignée de main** — retenu. La coquille crée un
  `MessageChannel` de plus et en transfère le port dans le message d'établissement existant :
  `worker.postMessage(canal, [privilegie.port2, relais.port2])`. Le canal global accepte toujours un
  message, un type, une fois. Les deux ports sont EXIGÉS — une coquille qui n'en transférerait qu'un
  promettrait un service qu'elle ne peut pas rendre.

**Trois vocabulaires, trois canaux, et aucun ne se parle sur celui d'un autre.** `TYPES_RELAIS` ne
porte que deux types et un refus ; un type privilégié posé sur le canal de relais est refusé
(`VAULT_COQUILLE_PORT_PRIVILEGIE_REFUSE`), et un type de relais posé sur le port restreint l'est
aussi, sous son propre code (`VAULT_COQUILLE_CANAL_DE_RELAIS_REFUSE`). Ce dernier existe pour la
même raison que le premier : l'épreuve de l'application malveillante doit pouvoir distinguer « la
coquille refuse ce geste-là » d'une faute de frappe.

## Décision 3 — Le port restreint gagne UN type, et rien d'autre

`vault.coquille.requete-http` est le premier type neuf du port restreint depuis #161. Il est arrivé
par le chemin que l'ADR 0028 exige : cet ADR, le § 10.5 de la spécification, et le cliquet
d'exhaustivité de `tests/unit/dossier-de-revue.test.mjs` qui les relie. La liste d'admission passe
de deux gestes à trois, et `tests/unit/coquille-admission.test.mjs` la borne toujours à trois.

**Ce qui est relayé, et ce qui ne l'est jamais** (`src/coquille/relais-http.mjs`) :

| Sens          | Ce qui traverse                                                                                                                                          | Ce qui ne traverse jamais                                                                                         |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| cadre → guest | `GET`, `POST`, `HEAD` ; un chemin ; `accept`, `accept-language`, `content-type` ; un corps en base64                                                     | `Origin`, `Referer`, `Cookie`, `Host`, tout autre en-tête, toute autre méthode, toute URL absolue                 |
| guest → cadre | le statut ; `content-type`, `content-language`, `content-disposition`, `location`, `cache-control`, `etag`, `last-modified`, `vary` ; le corps en base64 | `set-cookie`, l'hôte du guest dans une `Location`, tout en-tête non nommé (`server`, `x-runtime`, `x-request-id`) |

Trois points méritent leur phrase :

- **le corps est une CHAÎNE base64, et non un tampon.** `sansCapacite` refuse toute vue sur un
  tampon à l'enveloppe de chaque message, dans les deux sens. Le relais ne demande donc AUCUNE
  dérogation à la règle qui garde le port restreint : il paie un tiers d'octets pour ne pas y
  toucher. Sur la page mesurée, ce tiers représente environ deux kibioctets ;
- **`Origin` et `Referer` ne sont pas transmis, et ce n'est pas un oubli.** Rails compare `Origin` à
  sa propre `base_url` quand la protection anti-CSRF est armée ; transmettre l'origine applicative
  du navigateur ferait échouer toute soumission, et en forger une ferait mentir le relais à
  l'application. L'absence est exactement ce qu'une navigation de même origine produit ;
- **la liste est une liste d'ADMISSIONS, jamais de retraits.** C'est l'inverse de ce qu'un proxy
  fait d'ordinaire, et l'inversion est le point : une liste de retraits est une liste qu'on oublie
  d'allonger ; une liste d'admissions est une liste qu'il faut allonger pour se tromper.

## Décision 4 — Le Service Worker applicatif N'EST PAS un second chemin vers la coquille

L'[ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md) décision 4 refuse un Service Worker sur
l'origine de CONFIANCE, et le refus est de fond : il interposerait du code privilégié entre
l'hébergeur et la coquille, verrait passer chaque requête, survivrait à la fermeture de l'onglet et
se mettrait à jour par un chemin distinct du reste. **Ce refus n'est pas relâché d'un mot.** La
question posée par l'issue — le motif vaut-il aussi pour l'origine APPLICATIVE ? — reçoit une
réponse argumentée, et elle est non.

- **la portée.** Un Service Worker n'a de portée que sur SON origine (ADR 0002, ADR 0018 § 4 : la
  portée d'un Service Worker **est** l'origine plus un préfixe de chemin). Celui-ci ne peut prendre
  aucune portée sur l'origine de confiance, et le spike #35 le mesure depuis 2026 ;
- **le chemin vers la coquille.** Le Service Worker ne parle à personne d'autre qu'à un CLIENT de sa
  propre origine — le courtier. Tout ce qu'il obtient passe donc par le port restreint, sous le
  contrat strict de l'ADR 0028, avec ses dix refus inchangés, sa corrélation exigée et ses bornes.
  **Le supprimer n'enlèverait rien à la frontière ; l'ajouter ne lui ajoute rien non plus** ;
- **ce qu'il détient.** Rien. Ni clé, ni cookie — le bocal vit dans le Worker de confiance —, ni
  cache, ni port privilégié. Il ne connaît même pas l'origine de la coquille ;
- **sa persistance.** Il survit à la fermeture de l'onglet, comme tout Service Worker. Ce qu'il peut
  faire alors : rien. Sans courtier joignable, il LAISSE PASSER au réseau, et le réseau est le
  serveur statique. C'est aussi ce qui le rend inoffensif partout où la coquille n'est pas ;
- **son installation est GARDÉE.** `origineDistincteDuParent` refuse d'installer quoi que ce soit
  quand le document encadré est de MÊME origine que celui qui l'encadre — c'est-à-dire sous le
  témoin positif en même origine de `tests/browser/coquille-frontiere.spec.mjs`, la seule topologie
  où l'origine de confiance encadre elle-même le document applicatif. La mesure est la seule dont
  dispose un document qui ne connaît pas l'origine de sa coquille : lire `location.origin` du
  parent, et laisser le NAVIGATEUR dire « origines distinctes » en jetant.

**Ce qui est vrai et assumé** : le cadre imbriqué où vit la page Rails est de MÊME ORIGINE que le
courtier. La page servie peut donc lire ses variables et atteindre le port restreint par `parent`.
C'est la conséquence directe de l'ADR 0018 § 4 — l'origine EST l'identité, et tout le territoire
applicatif est UN seul domaine de confiance. Ce que la page y gagne est exactement ce que le port
admet : demander l'état du coffre, et relayer une requête vers son propre guest. Elle n'obtient pas
un second port (`VAULT_COQUILLE_ANNONCE_FENETRE` : la coquille refuse toute annonce venue d'une
fenêtre qui n'est pas le cadre qu'elle a créé — contrôle écrit en #161 pour exactement ce cas, et
#192 est la première tranche où il existe une iframe imbriquée pour l'exercer).

## Décision 4 bis — La sandbox du cadre gagne `allow-forms`, et rien d'autre

Le cadre applicatif portait `sandbox="allow-scripts allow-same-origin"` depuis l'ADR 0002 (topologie
T2). Ces deux jetons suffisaient tant que le cadre ne portait qu'une place tenante ; ils ne
suffisent plus, et c'est le scénario de bout en bout qui l'a **mesuré** le 12 septembre 2026 : le
formulaire de l'application de référence ne produisait **aucune requête** — ni interception, ni
relais, ni refus. Le moteur bloque en amont : « Blocked form submission … because the form's frame
is sandboxed and the 'allow-forms' permission is not set ». Le relais était correct de bout en bout,
et il n'était jamais appelé.

**Ce que `allow-forms` ajoute, exactement** : soumettre un formulaire. Rien d'autre. Il n'ajoute ni
popup, ni navigation du sommet, ni modale, ni téléchargement, ni verrouillage du pointeur.

**Ce qu'il n'ajoute PAS, et c'est le point** : une capacité d'atteindre quoi que ce soit. Un
document qui porte `allow-scripts` peut déjà émettre un `fetch` vers toute adresse que la CSP lui
laisse — et le territoire applicatif est servi sans CSP (ADR 0002 : lui en imposer une reviendrait à
mesurer notre propre politique au lieu de la frontière d'origine). Ce que ce jeton rend possible
n'est donc pas une capacité neuve : c'est la capacité de l'exercer **comme une application ordinaire
l'écrit**, par un `<form>` que le guest rend.

**Ce qui reste refusé, et qui compte** : `allow-top-navigation` — le cadre ne déplace pas la
coquille —, `allow-popups` (ADR 0002 : « ouvrir une popup » est dans la colonne « ne peut pas »),
`allow-downloads` et `allow-modals`. La liste est EXACTE et surveillée :
`tests/browser/coquille-service-applicatif.spec.mjs` exige les trois jetons, dans l'ordre, et rougit
sur un quatrième.

## Décision 5 — La session Rails vit dans le Worker, jamais dans le navigateur

Le bocal à cookies est tenu par `public/relais-du-worker.mjs`. Il ne franchit aucun port, n'est
écrit nulle part, et **meurt avec le Worker** — donc au verrouillage, à la mort du Worker et à la
fermeture de l'onglet. C'est la propriété de la KEK de session (ADR 0029), obtenue de la même façon
: ce qui n'est écrit nulle part n'a pas besoin d'être effacé.

Le document obtient donc une session Rails qui FONCTIONNE et un `document.cookie` VIDE — ce qu'un
cookie `HttpOnly` promet, obtenu ici par construction plutôt que par un attribut que le serveur
demande poliment au navigateur d'honorer. `tests/e2e/parcours-page-rails.spec.mjs` le mesure aux
trois endroits qui comptent : dans la coquille, dans le courtier, dans la page servie, et dans le
bocal du CONTEXTE du navigateur — cette dernière mesure n'étant pas redondante, puisque
`document.cookie` ne voit pas un cookie `HttpOnly`.

**Ce que ce bocal n'est PAS** : un bocal de navigateur. Il ignore `Domain`, `Path`, `Secure`,
`SameSite` et l'expiration. Ce n'est pas une paresse — il ne sert QU'UNE origine, celle du guest,
pour la durée d'UNE session de coffre, et les attributs d'un cookie décrivent des frontières qui
n'existent pas dans un bocal à un seul habitant. **La limite est écrite** : une application qui
s'appuierait sur l'expiration d'un cookie pour déconnecter son utilisateur ne serait pas déconnectée
par ce relais.

## Décision 5 bis — L'attente de la première page est réveillée par l'ANNONCE, pas par une horloge

L'ordre du cycle de vie crée une fenêtre : la coquille encadre le document applicatif à l'étape 4,
et l'application ne DÉMARRE qu'au geste de l'utilisateur qui suit. Entre les deux, le relais répond
`VAULT_COQUILLE_APPLICATION_NON_DEMARREE` — c'est la vérité —, et le cadre doit REDEMANDER.

**La première rédaction redemandait toutes les deux secondes. Le scénario de bout en bout l'a
réfutée**, et c'est la mesure la plus instructive de la tranche : une centaine de navigations du
cadre imbriqué pendant un boot qui dure cent dix secondes, et le Worker de confiance a été déclaré
**MORT PAR SILENCE** — `workerMort.cause: "silence"`, sa borne de trente secondes expirant faute de
battement. Trois exécutions de suite, là où deux venaient de passer, sur un produit inchangé. Le
scénario EXISTANT (`reprise-coquille-boot-froid.spec.mjs`) passait pendant ce temps : ce n'était ni
l'environnement, ni le boot, ni le relais — c'était la CHARGE que l'attente ajoutait au processus
pendant que la machine virtuelle démarrait.

**Ce qui réveille l'attente est donc l'ANNONCE DE BARRIÈRE.** C'est le second geste admis du port
restreint depuis #161, et c'est une POUSSÉE : la coquille annonce qu'une barrière de durabilité a
été acquittée, et le démarrage de l'application en acquitte une. Le cadre redemande sa page dans la
milliseconde qui suit le démarrage, sans rien interroger en boucle — exactement le motif pour lequel
cette annonce avait été admise : « l'application n'a rien à demander, donc rien à interroger en
boucle » (ADR 0028, liste d'admission).

Le repli d'horloge subsiste, à **dix secondes** et borné à trente essais : il est le seul recours si
aucune annonce ne vient. Ce que la mesure dit du changement, sur le chemin servi :

| Grandeur                             | Horloge de 2 s   | Réveil par l'annonce |
| ------------------------------------ | ---------------- | -------------------- |
| première page après le démarrage     | 924 ms, 1 913 ms | 249 ms               |
| navigations du cadre pendant le boot | ~100             | une poignée          |
| exécutions du scénario vertes        | 2 sur 5          | 3 sur 3              |

**Ce que cet incident dit du produit, et qu'il faut garder** : la borne de trente secondes du Worker
de confiance (ADR 0030, décision 3) mesure un SIGNE DE VIE, et un signe de vie dépend du processeur.
Une attente qui interroge en boucle pendant le geste le plus long du produit peut donc faire
déclarer mort un Worker parfaitement vivant. Ce n'est pas un défaut de la borne — c'est la raison
pour laquelle une poussée vaut mieux qu'une interrogation, et cette tranche l'a payé pour
l'apprendre.

## Décision 6 — Le verrouillage retire le cadre, et abandonne ce qui est en vol

Le verrouillage se terminait déjà par un rechargement de la coquille, qui emportait le cadre (ADR
0031). Tant que le cadre ne portait qu'une place tenante, l'écart entre le geste et le rechargement
ne se voyait pas. Depuis qu'il porte ce que Rails rend, il vaut une page métier affichée après le
verrouillage. **Le retrait du cadre devient donc un geste DU verrouillage**, posé avant le
rechargement et non plus obtenu par lui.

Et la garde de la RÉPONSE est contrôlée **à l'instant de poster**, jamais à l'instant de demander :
entre les deux il y a le guest, et c'est justement là que le geste de l'utilisateur tombe. Une
réponse qui revient après coup est ABANDONNÉE et COMPTÉE (`VAULT_COQUILLE_RELAIS_ABANDONNE`), jamais
rendue.

## Modèle de menace

| Ce qu'un adversaire tente depuis le territoire applicatif                     | Ce qu'il obtient                                                                                       |
| ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| relayer vers une autre machine (`GET https://exemple.test/`)                  | `VAULT_COQUILLE_REQUETE_HTTP_REFUSEE` — un chemin qui cesse d'être un chemin est refusé                |
| écrire une seconde ligne dans la requête HTTP (`accept: …\r\nX-Injecte: oui`) | `VAULT_COQUILLE_REQUETE_HTTP_REFUSEE` — aucun caractère de contrôle ne franchit                        |
| poser son propre `Cookie`, `Host` ou `Origin`                                 | l'en-tête est LAISSÉ : le guest ne reçoit que ce que le relais pose lui-même                           |
| faire porter un corps à un `GET`                                              | `VAULT_COQUILLE_REQUETE_HTTP_REFUSEE` — une requête qui dit une chose et en fait une autre est refusée |
| parler au Worker dans le vocabulaire du canal de relais                       | `VAULT_COQUILLE_CANAL_DE_RELAIS_REFUSE`                                                                |
| rejouer une RÉPONSE relayée vers la coquille                                  | `VAULT_COQUILLE_TYPE_INCONNU` — une réponse n'est pas une requête                                      |
| ajouter un champ à une requête relayée                                        | `VAULT_COQUILLE_MESSAGE_MALFORME` — la clôture des champs vaut pour le type neuf comme pour l'ancien   |
| noyer le guest sous les requêtes                                              | `VAULT_COQUILLE_TROP_DE_REQUETES` — seize en vol au plus, côté Worker ; trente-deux côté coquille      |
| faire rendre une réponse énorme                                               | `VAULT_COQUILLE_REPONSE_HTTP_TROP_GRANDE` — refusée ENTIÈRE, jamais tronquée                           |
| demander une page après le verrouillage                                       | `VAULT_COQUILLE_APPLICATION_NON_DEMARREE`, et le cadre n'existe plus                                   |
| faire annoncer la page Rails imbriquée pour obtenir son propre port           | `VAULT_COQUILLE_ANNONCE_FENETRE`                                                                       |
| les dix gestes de l'issue #24                                                 | leurs dix codes, inchangés, mesurés dans le MÊME relevé que les huit sondes de relais                  |

## Les épreuves, et leurs témoins

| Ce qui est prouvé                                                        | Où                                                                      |
| ------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| l'ÉPREUVE ROUGE : le cadre demande `/` et reçoit le refus JUSTE          | `tests/browser/coquille-service-applicatif.spec.mjs`, **trois moteurs** |
| les six façons d'écrire mal une requête relayée, chacune sous son code   | idem                                                                    |
| les dix refus de #24, INCHANGÉS sur le chemin neuf                       | idem, dans le même relevé que les huit sondes de relais                 |
| le relevé de la coquille reste BORNÉ : des comptes, aucun octet relayé   | idem                                                                    |
| les décisions du relais : méthodes, chemins, en-têtes, bocal, `Location` | `tests/unit/coquille-relais-http.test.mjs` (20 épreuves)                |
| le Service Worker n'est publié que par l'origine APPLICATIVE             | `tests/unit/coquille-sans-service-worker.test.mjs`                      |
| la garde d'installation refuse la même origine                           | idem                                                                    |
| une page Rails RÉELLE rendue, cliquée, soumise, relue à froid            | `tests/e2e/parcours-page-rails.spec.mjs`, Chromium                      |
| le coût du pont série sur une page réelle                                | `tests/vm/mesure-pont-serie-http.spec.mjs`, Chromium (Firefox déclaré)  |
| l'application elle-même : HTML, actifs, formulaire, 303, session         | `apps/reference/test/controllers/pages_controller_test.rb`              |

Le TÉMOIN POSITIF du relais est dans le même relevé que ses refus : la question d'état, seul geste
admis depuis #161, continue d'aboutir, et quatre requêtes concurrentes reçoivent quatre réponses
appariées. Un port cassé refuserait tout, y compris ce qu'il doit servir.

## Campagne de mutation

`tools/muter-gardes-coquille.mjs` porte les gardes du relais. Chaque mutant remplace UNE garde par
son contraire et exige que la suite rougisse :

| Garde mutée                                 | Ce qu'un mutant survivant voudrait dire                   |
| ------------------------------------------- | --------------------------------------------------------- |
| `set-cookie` rendu au cadre                 | le cookie de session Rails franchirait la frontière       |
| `Location` absolue rendue telle quelle      | l'hôte du guest fuiterait dans le territoire du guest     |
| toute méthode admise                        | `PUT`, `DELETE` et le reste passeraient sans usage        |
| tout en-tête de requête relayé              | le document choisirait `Cookie`, `Host` et `Origin`       |
| caractères de contrôle admis dans un chemin | une seconde ligne s'écrirait dans la requête HTTP du pont |
| garde d'abandon retirée                     | une réponse arrivée après le verrouillage serait rendue   |

## Mesures publiées

Sans seuil, comme celles de #161 à #173. Elles vivent dans `docs/quality-attributes.md` et dans
`reports/mesures/pont-serie-http-chromium.json`.

## Limites, dites plutôt que tues

- **la mesure Firefox n'existe pas**, et la cause n'est pas établie (voir ci-dessus). Ce que le
  relais fait sous ce moteur n'est donc PAS mesuré de bout en bout ; seule sa frontière l'est ;
- **le bocal à cookies ignore les attributs** : ni expiration, ni `Path`, ni `Domain`, ni
  `SameSite`. Une application qui s'appuierait sur l'expiration pour déconnecter ne le serait pas ;
- **WebSocket et `EventSource` ne sont pas relayés.** Aucun usage ne les demande, et le pont série
  n'a pas de canal montant persistant. Une application qui en dépendrait ne fonctionnerait pas ;
- **les en-têtes RÉPÉTÉS, autres que `Set-Cookie`, sont écrasés** par la table du découpeur de
  réponse. Seul `set-cookie` est lu depuis la liste. Aucune application de référence n'en émet
  d'autre ;
- **le cadre REDEMANDE la première page** tant que l'application n'est pas démarrée : réveillé par
  l'annonce de barrière, et à défaut toutes les dix secondes, trente fois au plus (décision 5 bis).
  C'est une attente, pas un parcours : ce que l'utilisateur LIT pendant cette attente appartient à
  P2. Et si aucune annonce ne venait jamais — une application qui n'écrit rien au démarrage —,
  l'attente coûterait jusqu'à dix secondes de plus que nécessaire ;
- **la coquille de cadre est publiée par l'origine applicative**, ce que l'ADR 0017 n'avait pas
  prévu. Voir les impacts ;
- **rien n'est mesuré d'une application autre que celle de référence.** Ce que ce relais fait d'une
  application Rails ordinaire — Turbo, ActionCable, ActiveStorage servi par redirection — n'est pas
  su, et prétendre le contraire serait deviner.

## Impacts sur les décisions antérieures

- **[ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md)** — la limite « le document encadré
  n'est pas encore servi par le guest » est LEVÉE. La décision 4 (aucun Service Worker sur l'origine
  de confiance) est **inchangée**, et la question qu'elle laissait ouverte pour le territoire
  applicatif est tranchée ici, décision 4 ;
- **[ADR 0028](0028-coquille-de-produit-et-frontiere.md)** — la liste d'admission passe de deux
  gestes à trois, par le chemin que l'ADR 0028 exige lui-même. La liste des dix refus, l'ordre des
  cinq conditions de l'annonce, la corrélation et `sansCapacite` sont inchangés ;
- **[ADR 0017](0017-chaine-de-publication.md)** — « le territoire applicatif ne publie AUCUN
  artefact de ce dépôt » devient « il publie le PROXY, et rien de ce que le guest rend ». Le
  raisonnement d'origine reste juste ; il lui manquait sa conclusion — un proxy doit bien être servi
  par quelqu'un, et ce quelqu'un ne peut être que cette origine-là. Ce qui y est publié est nommé
  fichier par fichier dans `tools/publier-arborescences.mjs`, et `Service-Worker-Allowed` reste
  délibérément absent : c'est ce qui oblige le Service Worker à vivre à la RACINE de cet arbre ;
- **[ADR 0002](0002-topologie-origine-de-confiance.md)** — la ligne « le document applicatif peut
  enregistrer un Service Worker sur SA portée » cesse d'être une possibilité écrite pour devenir un
  mécanisme du produit. La SANDBOX de la topologie T2 gagne `allow-forms` (décision 4 bis) : le
  tableau de l'ADR 0002 porte deux jetons, le produit en porte trois, et c'est ici qu'il faut le
  lire. Rien d'autre n'y est réécrit ;
- **[ADR 0031](0031-verrouiller-le-worker-meurt-l-instantane-survit.md)** — le verrouillage RETIRE
  le cadre explicitement, avant le rechargement qui l'emportait déjà.

## Alternatives rejetées

- **suivre les redirections dans le relais** — la bonne page sous la mauvaise adresse ;
- **rendre `Set-Cookie` au navigateur et laisser son bocal tenir la session** — les deux origines de
  l'ADR 0002 sont le même SITE sur un domaine propre, et `SameSite` ne sépare pas deux sous-domaines
  (ADR 0018 § 5, ADR 0028 décision 3). Un cookie de session Rails posé dans le navigateur serait un
  cookie que la coquille et l'application partagent ;
- **une dérogation à `sansCapacite` pour transporter le corps en `Uint8Array`** — elle aurait
  économisé un tiers d'octets et rendu la garde du port restreint aussi large que ce qu'elle prétend
  interdire. Deux kibioctets sur la page mesurée ne valent pas cela ;
- **une page d'attente rendue par le Service Worker** pendant que l'application démarre — ce serait
  du texte et de la mise en forme inventés par le relais, c'est-à-dire P2 et P3 de l'épique #195
  faits en douce. Le refus rend un texte brut qui NOMME son code, et le cadre redemande ;
- **désinscrire le Service Worker au verrouillage** — inutile : sans courtier joignable il laisse
  passer au réseau, et il ne retient rien. Une désinscription serait un geste qui promet un
  effacement là où il n'y a rien à effacer.

## Conditions d'abandon

- si une application réelle exige WebSocket, `EventSource` ou un en-tête répété autre que
  `Set-Cookie`, le relais ne suffit plus et le candidat (3) doit être instruit pour de bon ;
- si le débit du pont série devient le goulot — une page au-delà de cinq secondes, mesurée —, la
  même conclusion s'applique ;
- si un moteur refuse un Service Worker de module dans une iframe encadrée, le mécanisme ne s'y
  installe pas : le courtier le DIT dans son relevé (`serviceWorker: "refuse:…"`) et le cadre reste
  ce qu'il était. Ce n'est pas une panne de la coquille, c'est un moteur qui ne veut pas.
