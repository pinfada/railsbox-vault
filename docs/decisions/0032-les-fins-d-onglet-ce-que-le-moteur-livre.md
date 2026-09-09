# ADR 0032 — Les fins d'onglet : ce que le moteur livre, et ce que la coquille en fait

- **Statut** : accepté
- **Date** : 2026-09-09
- **Issue** : [#170](https://github.com/pinfada/railsbox-vault/issues/170), tranche 2 de
  [#25](https://github.com/pinfada/railsbox-vault/issues/25)
- **Complète** : [ADR 0031](0031-verrouiller-le-worker-meurt-l-instantane-survit.md) (l'état, la
  règle et le délai ; son § « Aucun événement de fin d'onglet n'est écouté » se referme ici),
  [ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md) (la mort du Worker et sa conduite),
  [ADR 0021](0021-derivation-des-cles-de-deverrouillage.md) (ce qu'on peut promettre, décision 7).
- **Ne traite pas** : le signal de présence du cadre
  ([#176](https://github.com/pinfada/railsbox-vault/issues/176)), la détection de la mort du Worker
  ([#163](https://github.com/pinfada/railsbox-vault/issues/163)).

## Contexte

L'ADR 0031 a posé le verrouillage — son état, ses deux déclencheurs, son délai — et a écrit noir sur
blanc ce qu'il ne faisait pas : « **aucun événement de fin d'onglet n'est écouté** […] C'est #170 ».
Sa décision 2 avait par ailleurs laissé une limite ouverte, et asymétrique : le contrôle de la
surveillance rattrape un réveil trop TÔT, jamais un réveil trop TARD — « le délai est un PLANCHER,
pas une ponctualité ».

Deux questions restaient donc : ce que les moteurs livrent réellement quand un onglet finit, et ce
que la coquille doit en faire. La première se **mesure**. La seconde se décide, et la mesure la
borne.

## Décision 1 — Une table : chaque événement, une action, et deux qui ne sont jamais branchés

| Événement                   | Ce que la coquille fait                                               | Pourquoi                                                                                                                       |
| --------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `pagehide`                  | sur un coffre `ouvert` : `terminate()` SYNCHRONE, délai désarmé       | rien d'asynchrone n'est garanti là ; « tenter » une capture qui n'aboutira pas serait moins honnête que ne rien tenter         |
| `pageshow` avec `persisted` | RECHARGE, par le chemin du verrouillage réussi (ADR 0031 déc. 1)      | le document restauré revient avec son cadre — le dernier clair — et un Worker mort ; le seul document propre est neuf          |
| `pageshow` sans `persisted` | **rien**                                                              | recharger sur tout `pageshow` est une boucle infinie                                                                           |
| `freeze`                    | inscrit au journal, **rien n'est tué**                                | un document gelé n'exécute rien ; tuer là ferait payer un boot à froid à chaque retour d'un onglet rangé par le moteur         |
| `resume`, retour `visible`  | **VÉRIFIE** l'échéance sur l'horloge, verrouille si elle est dépassée | la minuterie ne court pas pendant le gel ; attendre son réveil laisserait le coffre ouvert au-delà de son délai                |
| `beforeunload`, `unload`    | **jamais branchés**, et nommés comme tels                             | le premier n'offre que la boîte de dialogue qui RETIENT l'utilisateur — ce que la DoR de #25 interdit ; le second est obsolète |

**`pagehide` tue quel que soit `persisted`, et c'est un seul chemin.** La coquille ne dépend pas de
savoir si le document sera détruit ou mis en cache : s'il est détruit, le Worker mourait de toute
façon et l'avance de quelques millisecondes ne coûte rien ; s'il est mis en cache, c'est la SEULE
chose qui empêche un retour arrière de rendre un coffre ouvert sans geste.

**Le prix, écrit** : sans capture ni `close()`, ce qui n'était pas acquitté est perdu (ADR 0014,
comme à toute coupure) et la réouverture est un boot à FROID si aucun instantané cohérent n'existe
(ADR 0024, décision 4). **Fermer l'onglet n'est pas verrouiller** : le bouton « Verrouiller » reste
le chemin qui paie une seconde au lieu de cent (ADR 0031, § Mesures).

**La vérification est une VÉRIFICATION, jamais une remise à zéro.** `dernierSigneMs` n'est pas
touché, l'échéance ne bouge pas, et `visibilite` reste dans `SIGNAUX_SANS_EFFET` : la décision 2 de
l'ADR 0031 est intacte. Le délai reste un plancher ; il devient un plancher HONORÉ au premier signe
que l'onglet est revenu. Un onglet qui PART en arrière-plan ne vérifie rien — il n'y a rien à
rattraper, et le temps continue de courir de toute façon.

**La CIBLE fait partie de la décision** : `pagehide` et `pageshow` sont des événements de FENÊTRE,
`freeze`, `resume` et `visibilitychange` des événements de DOCUMENT qui ne remontent pas jusqu'à
elle. Un écouteur posé sur la mauvaise cible ne se déclenche jamais, et rien, dans un navigateur, ne
le dirait : la sonde de cette tranche a conclu « ce moteur ne gèle pas » sur cette erreur-là avant
qu'elle soit corrigée. La table nomme la cible de chacun, et un mutant la déplace.

## Décision 2 — La conclusion est écrite d'AVANCE : la garantie n'est aucun de ces écouteurs

**Aucun de ces écouteurs n'est une garantie.** La garantie est la NON-PERSISTANCE : la KEK et la DEK
ne vivent que dans le tas d'un Worker, rien n'est écrit nulle part, et un verrouillage qui
dépendrait d'un événement que le moteur peut ne pas livrer ne serait pas un verrouillage. Ce que
cette tranche ajoute est une **avance** et une **visibilité**, pas une promesse neuve.

C'est éprouvé plutôt qu'affirmé, sur les trois moteurs : un coffre ouvert, l'onglet **fermé sans
aucun verrouillage**, puis un document NEUF du même profil. Il lit `verrouille`, remonte son
interface de déverrouillage, n'a rien dérivé (`mesures.deverrouillageMs` est nul) ; et la fouille
des six stockages — OPFS entier en texte et en hexadécimal, témoin positif d'abord — ne retrouve pas
la phrase. Sur WebKit, l'épreuve **déclare** `indisponible` : rien ne s'y ouvre, donc rien ne s'y
ferme.

Le vocabulaire est celui de l'ADR 0021 décision 7 : ce qui s'écrit est « le Worker qui détenait les
clés est mort ». « Les clés sont effacées » ne s'écrit pas.

## Décision 3 — Le bfcache : mesuré, jamais exploité

La coquille **n'ajoute rien** pour se rendre inéligible au bfcache : ni Web Lock tenu, ni `unload`,
ni en-tête. C'est un YAGNI, et c'est surtout une question de nature : une inéligibilité est un
comportement de moteur, jamais une garantie du produit.

**Le piège d'outil, nommé** : Playwright lance Chromium avec `--disable-back-forward-cache`. Une
mesure « jamais restauré » prise sous cet argument mesurerait l'outil. Il est retiré par
`playwright.fins-d-onglet.config.mjs`, et là seulement. Firefox et WebKit : aucun argument retiré,
et la sonde le publie plutôt que de le supposer.

**Ce que la mesure a rendu, et il faut le lire à l'envers de ce qu'on espérait** : sous ce harnais,
**aucun document n'est jamais restauré**, sur aucun des trois moteurs — **témoin positif compris**,
c'est-à-dire une page statique sans script, sans écouteur et sans `BroadcastChannel`. Ce qui est
mesuré là est donc le HARNAIS autant que le moteur. Le chemin `pageshow` reste, écrit comme ce qu'il
est : une **garde**, ceinture et bretelles, éprouvée en unitaire avec un `persisted: true` injecté
et tenue par deux mutants. Son témoin négatif, lui, est bien mesuré dans un navigateur, sur les
trois : la coquille se charge deux fois — au départ et au retour — et pas une de plus.

## Décision 4 — Le gel, et ce que le harnais ne sait pas provoquer

Le gel devait être mesuré par `Page.setWebLifecycleState`. Il l'a été, et le résultat **contredit ce
qu'on attendait** : le protocole **accepte** la commande sans erreur et **ne gèle rien**. Le témoin
positif l'établit sans ambiguïté — un battement toutes les 200 ms compte 35 battements pendant les 6
s de gel demandé, plus grand trou 206 ms, et une minuterie de 2 s se réveille avec 6 ms de retard.
Ni `freeze` ni `resume` ne sont livrés.

La cause est mesurée elle aussi : un moteur ne gèle qu'un onglet CACHÉ, et **aucun moteur ne cache
un onglet sous Playwright** — `document.visibilityState` reste `visible` sur les trois, même après
`bringToFront()` d'un second onglet, en mode fenêtré comme en mode sans fenêtre, avec
`Emulation.setFocusEmulationEnabled: false`, avec une fenêtre minimisée par
`Browser.setWindowBounds` et dans un contexte persistant.

La décision ne change pas pour autant — **rien n'est tué au gel** —, mais ce qui la tient change :
ce sont les épreuves unitaires, avec l'horloge et l'événement injectés, et les mutants. Firefox et
WebKit n'ont pas ces événements dans le moteur : « non livré, par conception », pas « non mesuré ».

## Mesures

Relevé du **2026-09-09**, `npm run test:fins-d-onglet`, Windows 11 Home `win32` 10.0.26200, Node
v24.14.0, Playwright 1.62.1, Chromium 151.0.7922.34 / Firefox 153.0 / WebKit 26.5, serveur
`tools/serve.mjs` (COOP, CSP servie). Chiffres et canaux : `docs/compatibility.md` § « Ce que les
moteurs livrent aux FINS D'ONGLET », et `reports/fins-d-onglet/<moteur>.json`.

**Le canal d'observation fait partie de la mesure.** Un événement livré à un document qui meurt ne
se lit pas depuis ce document. Trois canaux sont posés ensemble — un document TÉMOIN joint par
`BroadcastChannel`, `page.on("console")`, et le document lui-même —, et **aucun ne suffit seul** : à
la fermeture d'un onglet, Firefox livre bien `pagehide` mais le message diffusé pendant celui-ci
n'atteint pas le témoin ; WebKit fait l'inverse et perd la console. Un événement qu'un canal ne
rapporte pas n'est pas « non livré » : il est « non observé par ce canal ».

## Limites, dites plutôt que tues

- **le gel n'est pas simulable** par ce harnais (décision 4), et un `freeze` livré SPONTANÉMENT par
  le moteur — onglet en arrière-plan depuis quelques minutes, économiseur d'énergie — l'est encore
  moins ;
- **un onglet réellement CACHÉ n'est pas simulable** : `document.hidden` reste faux sur les trois
  moteurs, quoi qu'on tente. La vérification d'échéance au retour visible s'éprouve donc en
  unitaire, avec l'horloge injectée et un `visibilitychange` synthétique ;
- **aucun document n'est jamais restauré** depuis le bfcache sous ce harnais (décision 3), témoin
  positif compris : la ligne du chemin `pageshow` est une garde éprouvée, pas un comportement
  observé ;
- **la mise en veille du système** et **l'éviction d'un onglet sous pression mémoire** ne sont pas
  simulés : rien dans Playwright ne les provoque, et les imiter par une fermeture mesurerait la
  fermeture ;
- **la mort du processus de rendu** n'est pas simulée non plus. `Page.crash` n'est pas exposé par le
  harnais, et la conclusion de la décision 2 — un document neuf lit `verrouille` — vaut pour toute
  disparition du document, quelle qu'en soit la cause ;
- **`pagehide` tue quelques millisecondes AVANT ce que la fermeture obtiendrait de toute façon**, et
  cette avance n'est observable d'aucun point extérieur : le seul cas où elle changerait quelque
  chose est la restauration depuis le bfcache, que personne ne restaure ici ;
- **ce que la sonde des stockages mesure** : ce qui n'est pas **persisté**, pas ce qui est **effacé
  d'un tas**. Elle ne peut rien dire de la mémoire d'un processus, d'un fichier d'échange, ni des
  octets d'une `CryptoKey` ;
- **WebKit reste DÉCLARÉ `indisponible`** partout où un coffre doit être ouvert : rien ne s'y ouvre,
  et l'épreuve le dit au lieu de passer au vert par vacuité.

## Impacts sur les décisions antérieures

- **[ADR 0031](0031-verrouiller-le-worker-meurt-l-instantane-survit.md)** — son § « Aucun événement
  de fin d'onglet n'est écouté » reçoit une **note datée** : ils le sont désormais, et la table
  d'asymétrie de sa décision 1 gagne une ligne « retour depuis le bfcache ». Sa **décision 2 est
  intacte** : `visibilite` reste sans effet, et la vérification d'échéance ne remet rien à zéro. Sa
  limite « le délai est un plancher, pas une ponctualité » reste vraie, et devient un plancher
  honoré au retour ;
- **[ADR 0028](0028-coquille-de-produit-et-frontiere.md)** — **rien ne change** : aucun type de
  message neuf, aucun code de refus neuf, aucun cookie, aucun format et aucun vecteur touchés ;
- **[ADR 0021](0021-derivation-des-cles-de-deverrouillage.md)** — la décision 7 est **appliquée** :
  ce qui s'écrit est « le Worker qui détenait les clés est mort » ;
- `src/coquille/verrouillage.mjs` — le commentaire « Ce que cette table ne porte PAS » **reste
  vrai** et renvoie ici : aucune fin d'onglet n'est un signal d'ACTIVITÉ ; `SECURITY.md`,
  `docs/architecture.md` étape 7 et `docs/testing.md` sont mis à jour.

## Campagne de mutation

`node tools/muter-gardes-fins-d-onglet.mjs` — **quatorze gardes, quatorze mutants tués**. Elle
compte double ici : quatre des cinq chemins ne sont atteignables par aucune épreuve de navigateur de
ce dépôt (décisions 3 et 4), et c'est elle qui dit qu'ils savent rougir.

| Mutation                                                       | Verdict |
| -------------------------------------------------------------- | ------- |
| `pagehide` ne tue pas                                          | TUÉ     |
| `pagehide` ne tue que si `persisted` est faux                  | TUÉ     |
| `pagehide` tue sur un coffre qui n'est pas ouvert              | TUÉ     |
| `pagehide` ne désarme pas le délai                             | TUÉ     |
| `pageshow` restauré ne recharge pas                            | TUÉ     |
| `pageshow` recharge quel que soit `persisted` (boucle infinie) | TUÉ     |
| le gel tue le Worker                                           | TUÉ     |
| le retour ne vérifie pas l'échéance                            | TUÉ     |
| un onglet qui part en arrière-plan vérifie quand même          | TUÉ     |
| tous les événements sont écoutés sur le document               | TUÉ     |
| `beforeunload` est branché                                     | TUÉ     |
| la vérification agit sur une surveillance désarmée             | TUÉ     |
| la vérification verrouille avant l'échéance                    | TUÉ     |
| la vérification remet l'échéance à zéro                        | TUÉ     |

## Alternatives rejetées

- **tuer au gel.** Un document gelé n'exécute rien, son Worker non plus, et les clés n'y sont ni
  plus ni moins atteignables (mémoire du processus : hors modèle de menace). Le coût, lui, serait
  réel : l'instantané perdu et un boot à froid à chaque retour d'un onglet que le navigateur gèle de
  lui-même au bout de quelques minutes. « Un verrouillage qui coûte deux minutes est un verrouillage
  qu'on désactive » ;
- **tenir un Web Lock, ou poser un `unload`, pour bloquer le bfcache.** Ce serait dépendre d'un
  effet de bord non spécifié pour obtenir une propriété de sécurité, et payer une base de confiance
  plus grande pour cela. Le chemin `pageshow` obtient la même chose sans rien ajouter ;
- **`beforeunload` avec une boîte de dialogue.** Le seul usage de l'événement est de RETENIR
  l'utilisateur, ce que la Definition of Ready de #25 interdit ; et son écouteur rend le document
  inéligible au bfcache sur certains moteurs, propriété dont la coquille ne doit pas dépendre ;
- **`unload`.** Obsolète, non livré de façon fiable par les moteurs modernes, et tout ce qu'il
  ferait, `pagehide` le fait ;
- **une capture « tentée » dans `pagehide`.** Aucune tâche asynchrone n'est garantie là. Une capture
  qui n'aboutit pas laisserait un instantané incohérent — donc écarté à la réouverture, donc un boot
  à froid (ADR 0024, décision 4) — au prix d'une promesse qui se lirait comme une garantie ;
- **recharger sur tout `pageshow`.** Une boucle infinie, et le mutant le plus coûteux de la campagne
  : un témoin négatif la compte dans un navigateur, sur les trois moteurs.
