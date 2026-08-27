# Modèle de menace initial

Ce document décrit les frontières visées. Il ne constitue pas encore une garantie de sécurité :
RailsBox Vault est au stade expérimental et ne doit contenir aucune donnée réelle.

## Actifs à protéger

- le volume applicatif et ses sauvegardes ;
- les pièces jointes et les bases SQLite ou PostgreSQL ;
- les clés de chiffrement et moyens de récupération ;
- les données en clair pendant une session déverrouillée ;
- l'intégrité et la version du runtime chargé par le navigateur.

## Adversaires considérés

- copie ou inspection du profil navigateur lorsque le coffre est verrouillé ;
- altération, rejeu ou remplacement de blocs persistés ;
- relais de stockage ou de synchronisation curieux ou compromis ;
- publication compromise d'une nouvelle version de l'application ;
- code applicatif ou dépendance exécutant du JavaScript hostile ;
- perte d'un appareil, d'une passkey ou d'une origine web.

## Frontières de confiance

Depuis l'[ADR 0002](docs/decisions/0002-topologie-origine-de-confiance.md), cette frontière est une
frontière d'**origine web** : la coquille et son Worker vivent sur l'origine de confiance, le
document applicatif sur une origine distincte, encadré par
`sandbox="allow-scripts allow-same-origin"`.

| Composant               | Origine     | Autorité maximale admise                                           |
| ----------------------- | ----------- | ------------------------------------------------------------------ |
| Coquille Vault          | confiance   | courtage du canal, déverrouillage et consentement utilisateur      |
| Worker runtime          | confiance   | clé de volume en session et E/S authentifiées                      |
| Port restreint accordé  | frontière   | requêtes de la liste d'admission ; jamais une clé ni un handle     |
| VM et application Rails | applicative | données nécessaires à l'usage, et le stockage de SA propre origine |
| Hébergement statique    | les deux    | distribution d'artefacts publics vérifiables                       |
| Relais optionnel        | —           | transport de ciphertext et métadonnées minimales                   |

La partition d'origine sépare OPFS, IndexedDB, Web Locks, `BroadcastChannel`, stockage clé-valeur,
cookies et portée des Service Workers. C'est ce que le spike #35 a mesuré : en même origine, onze
tentatives sur dix-neuf aboutissent, dont la lecture de l'OPFS de la coquille, la capture d'un jeton
par remplacement de `MessagePort.prototype.postMessage` et l'interception du réseau de la coquille
par un Service Worker applicatif. Sur une origine distincte, aucune n'aboutit.

Le durcissement du realm — capture des intrinsèques, `Reflect.apply` — reste utile en défense en
profondeur. Il ne remplace pas la frontière : il n'atteint ni le stockage, ni les verrous, ni la
portée des Service Workers.

Le code applicatif, les dépendances Rails, l'hébergement et le relais restent des entrées
potentiellement hostiles. La coquille et son Worker forment la base de confiance minimale à réduire
et tester.

## Invariants vérifiables

- `SEC-ORIGIN-001` — un script applicatif ne peut acquérir le canal privilégié ou lire une clé de
  volume. La topologie qui le garantit est arrêtée par l'ADR 0002 ; la preuve de frontière est
  `tests/browser/origin-topology.spec.mjs`, rattachée à `npm run check`. Elle comporte un témoin
  positif qui exige que les mêmes tentatives ABOUTISSENT en même origine, sans quoi un relevé tout
  vert ne prouverait rien. Depuis #6 la frontière porte aussi sur le stockage local : le handle OPFS
  exclusif ne s'ouvre que dans un Worker dédié, la page reçoit `VAULT_STORAGE_UNSUPPORTED`, et
  `tests/browser/opfs-block-backend.spec.mjs` vérifie qu'aucun objet du système de fichiers n'est
  atteignable depuis le backend ni depuis l'adaptateur v86 rendu à l'émulateur. Depuis #12, la
  restauration inter-origine ajoute **une exception étroite et délibérée**, décrite par
  l'[ADR 0009](docs/decisions/0009-restauration-inter-origine.md) : pour qu'une archive puisse
  quitter l'origine par un téléchargement, le Worker remet à la coquille un `File` en **lecture
  seule**, adossé au support, portant l'**archive** — jamais le volume, jamais une clé, jamais le
  handle exclusif, qui reste dans le Worker. Cette borne est tenue **par le code, non par une
  convention de nom** : le Worker lit les huit premiers octets du fichier demandé et exige le
  marqueur d'archive `RBVAULT1` (ADR 0008) avant de remettre quoi que ce soit ; demander le fichier
  d'un VOLUME est refusé par `VAULT_ARCHIVE_MALFORMED`, ce qu'un témoin négatif de
  `tests/e2e/restauration-inter-origine.spec.mjs` éprouve. Dans l'autre sens, une archive n'entre
  dans une origine que par un champ de fichier ouvert par l'utilisateur : aucun canal inter-origines
  n'est ajouté et aucune directive de CSP n'est assouplie — le cloisonnement OPFS par origine reste
  ce qui rend la restauration significative, et le même scénario le vérifie avant d'importer ;
- `SEC-KEY-001` — une clé de déverrouillage enveloppe une DEK aléatoire sans servir directement au
  chiffrement des blocs ;
- `SEC-BLOCK-001` — un bloc est authentifié avec volume, adresse, format et génération. **Depuis #17
  cet invariant a une définition opposable et des vecteurs, mais AUCUN chemin du produit ne
  l'exerce** : il est spécifié, pas encore tenu, et #18 est la tranche qui le tiendra.
  L'[ADR 0015](docs/decisions/0015-proprietes-cryptographiques-du-format.md) le définit ainsi : un
  bloc est scellé par AES-256-GCM (étiquette de 128 bits) dont les **données associées portent
  l'identité logique complète** — identifiant de volume, adresse logique, version de format,
  génération, rang de l'entrée, longueur, nom de l'algorithme —, encodée de façon injective (chaque
  champ de largeur fixe ou préfixé de sa longueur). Le nonce de 96 bits est déterministe et dérivé
  de (domaine, génération, rang) ; il ne porte **pas** l'adresse, parce que l'ADR 0014 autorise la
  réécriture d'un même bloc dans une même génération et qu'un nonce répété sous une même clé livre,
  sous GCM, le XOR des clairs et la clé d'authentification. Ce que la propriété ne garantit pas est
  écrit dans l'ADR et non résumé ici : rien contre un détenteur de la clé, rien sur la taille du
  volume ni le motif d'accès, rien sur le **retour arrière d'un secteur** — un secteur ramené à une
  version antérieure authentique n'est pas détecté, parce que le lecteur lit sa génération dans le
  nonce, c'est-à-dire au même endroit que le sceau. Modification et déplacement partagent d'ailleurs
  un seul code de refus (`VAULT_CRYPTO_SCEAU_REFUSE`) : ils sont cryptographiquement indiscernables,
  et le modèle refuse sans prétendre les distinguer. Preuves :
  `tests/unit/vm-format-chiffre-*.test.mjs` et les vecteurs figés
  `tests/vectors/format-chiffre-v1.json`, que #18 devra reproduire octet pour octet. La borne de
  forgerie est calculée, pas qualifiée : ≈ 2^-122,6 par tentative ;
- `SEC-GEN-001` — rejeu, troncature et mélange de générations sont refusés. **Même statut : spécifié
  par #17, non exercé par le produit, tenu par #19.** L'ADR 0015 le décompose en trois propriétés
  distinctes, chacune avec son refus typé. **Rejeu** : la séquence et la génération sont
  authentifiées dans l'en-tête de la racine, et une racine ou un bloc antérieurs sont refusés
  (`VAULT_CRYPTO_REJEU`) — mais seulement au regard d'un minimum de séquence que l'appelant
  présente, et ce minimum ne peut venir, entre deux sessions, que du support lui-même : **le retour
  arrière complet d'un support cohérent n'est pas détectable** et reste couvert par le seul
  partitionnement d'origine de l'ADR 0002. **Troncature** : l'en-tête authentifié porte le nombre
  d'entrées et la longueur de charge, dérivés des entrées au moment de sceller ; une génération
  incomplète — ou augmentée — est refusée (`VAULT_CRYPTO_TRONCATURE`). **Mélange** : la racine
  scelle l'empreinte SHA-256 de la **suite ordonnée** de ses entrées (adresse, longueur, rang,
  étiquette du bloc), si bien qu'une entrée authentique d'une autre génération, ou un simple
  réordonnancement, est refusé (`VAULT_CRYPTO_MELANGE`). Ces trois classements sont posés **après**
  vérification de l'étiquette, donc sur un en-tête authentique : c'est pourquoi l'en-tête est les
  données associées et l'empreinte le clair. Ce qu'ils ne couvrent pas : le volume au-delà du
  journal — après un point de contrôle, un volume porte légitimement des secteurs de générations
  différentes, et ce n'est pas un mélange ;
- `SEC-DURABLE-001` — aucune écriture n'est annoncée durable avant le flush effectif. Le spike #4 a
  établi que l'émulateur amont rend cet invariant **inatteignable** : son disque n'annonce pas de
  cache d'écriture, le guest n'émet donc jamais de barrière, et la commande FLUSH CACHE serait de
  toute façon acquittée sans atteindre le stockage.
  L'[ADR 0003](docs/decisions/0003-backend-de-blocs-v86.md) pose le pont qui rétablit la barrière ;
  l'ordre écriture → flush → acquittement est prouvé par `tests/vm/durability-barrier.spec.mjs`,
  avec son témoin négatif. Depuis #6 le support n'est plus la mémoire : le backend OPFS déclare
  `durable: true` et son acquittement de barrière suit un `FileSystemSyncAccessHandle.flush()` réel,
  ce que prouvent `tests/browser/opfs-block-backend.spec.mjs` et
  `tests/vm/opfs-persistence.spec.mjs` — un guest écrit, l'hôte ferme le handle, rouvre et retrouve
  les octets. #14 ferme enfin la barrière de bout en bout : le backend **attend** le
  `FileSystemSyncAccessHandle.flush()` avant d'enregistrer l'acquittement, si bien qu'aucune
  écriture n'est annoncée durable au guest avant que le flush OPFS ait rendu la main. Le contrat
  complet figure dans [`docs/architecture.md`](docs/architecture.md) (§ « Contrat de barrière de
  durabilité »), et ses cinq propriétés — ordre causal, flush retardé sans succès anticipé, échec ou
  fermeture pendant le flush, deux barrières à vide, RPO 0 après acquittement — sont prouvées de
  façon déterministe par `tests/unit/vm-durability-barrier.test.mjs` (chaîne complète moins
  l'émulateur, avec son témoin de barrière retardée) et rejouées sur le vrai support par
  `tests/vm/opfs-barrier.spec.mjs`. **#16 change ce que « durable » recouvre : ce n'est plus une
  écriture isolée, c'est une GÉNÉRATION.** L'ensemble des écritures comprises entre deux barrières
  acquittées est déposé dans un journal voisin `<volume>.gen` et n'atteint le volume qu'ENTIER ; la
  barrière valide la génération en scellant sa charge par une racine d'un seul secteur
  ([ADR 0014](docs/decisions/0014-generation-transactionnelle.md)). L'acquittement au guest reste ce
  qu'il était — il suit un flush réel du support —, mais il porte désormais sur un état complet :
  une coupure laisse **une génération validée, jamais un mélange**. La récupération d'ouverture
  écarte une génération non validée (`VAULT_STORAGE_GENERATION_DISCARDED`, publié et jamais tu),
  rejoue une génération validée, et REFUSE plutôt que de deviner dans deux cas — une charge scellée
  devenue incohérente (`VAULT_STORAGE_GENERATION_CORRUPT`) et un journal dont aucune racine n'est
  lisible alors qu'au moins une est abîmée (`VAULT_STORAGE_GENERATION_ROOT_CORRUPT`), où ce qui a
  été validé est inconnu. **La formulation exacte compte** : le volume porte la dernière génération
  validée qu'un CHEMIN D'ÉCRITURE TRANSACTIONNEL a produite ; la préparation d'image et la
  restauration écrivent un volume entier sans génération, et écartent explicitement le journal du
  volume écrasé, après avoir révoqué son manifeste (ADR 0014).

  **La mesure, et ce qu'elle a coûté.** Le taux de coupures laissant une génération validée passe de
  12,5 % (#15) à 100 % sur trois graines, sur OPFS réel (`tests/vm/resilience-arrets.spec.mjs`),
  avec zéro bloc déchiré et zéro bloc non rattachable. La cadence mesurée est celle de #15 —
  vingt-quatre blocs distincts, une barrière tous les huit — et la matrice de coupures est identique
  point pour point. Ce qui a changé pour rendre la comparaison honnête, c'est **l'oracle** : il
  connaît désormais la suite des générations attendues du scénario et n'accepte un volume que si les
  blocs publiés en forment EXACTEMENT une, ce qui le rend strictement plus discriminant que celui de
  #15. Une première version de cette tranche avait appauvri la charge mesurée au lieu d'étendre le
  juge ; une mutation a montré que la mesure ne mesurait alors plus rien, et
  `tests/unit/vm-crash-mutation.test.mjs` conserve le contre-exemple.

  Reste hors de cet invariant la perte d'un cache d'écriture VOLATIL — mort du processus du
  navigateur, coupure de courant : `Worker.terminate()` ne la produit pas, aucun des deux supports
  éprouvés ne la produit, et #16 ne la mesure donc pas. Restent également hors périmètre
  l'authentification des blocs (`SEC-BLOCK-001`, jalon 4) et la reprise complète après fermeture
  (#7) ;

- `SEC-UPDATE-001` — runtime et application sont identifiés et vérifiés avant d'ouvrir le volume en
  écriture. #10 en a écrit la règle — `assertVolumeWritable` refuse un volume sans manifeste
  identifiable (`VAULT_MANIFEST_UNIDENTIFIED`) — mais aucun chemin de production ne l'appelait :
  l'invariant était énoncé, pas exercé. Depuis #12 il l'est, et voici exactement dans quelle mesure.
  Un volume **identifié** ne s'ouvre en écriture que par `openVolumeForWrite`
  (`src/vm/opfs-volume-open.mjs`), qui lit le manifeste posé à côté du volume, le soumet à
  `assertVolumeWritable` et n'ouvre qu'ensuite ; **le boot y passe**, et un volume sans manifeste y
  est refusé avant même la construction de v86. Un volume **anonyme** n'est ouvrable que par le
  chemin qui va l'identifier — préparation depuis l'image de référence, restauration — et reste
  refusé au boot tant que son manifeste n'est pas inscrit. Les bancs #4/#6/#14 et les phases de
  mesure n'ouvrent aucun volume applicatif. Les deux moitiés de l'invariant existent donc enfin : la
  restauration (et toute création de volume) **écrit** le manifeste, en dernier geste et après avoir
  relu le volume entier, et le boot **l'exige**. Il n'existe **aucune période de transition** : un
  volume sans manifeste est refusé, jamais complété par une identité devinée. **Portée exacte du
  contrôle** : `openOpfsVolume` reste appelable directement, et treize sites de production le font
  encore (énumérés et justifiés dans
  [l'ADR 0009](docs/decisions/0009-restauration-inter-origine.md)). Rien dans l'outillage n'empêche
  un nouveau chemin d'en ajouter un sans passer par l'ouvreur : c'est une **discipline de revue, pas
  une contrainte du code**. Fermer `openOpfsVolume` derrière un module privé reste du travail
  découvert. Preuves : `tests/unit/vm-opfs-volume-open.test.mjs` (le refus précède l'ouverture) et
  un témoin Bout en bout où le manifeste d'un volume restauré est retiré, puis le boot refusé
  (`tests/e2e/restauration-inter-origine.spec.mjs`). **Depuis #13**, un troisième état est couvert
  par le même contrôle : un volume dont la **migration de format** a été interrompue. La migration
  révoque le manifeste avant de muter et ne le réinscrit qu'après l'avoir relu depuis le support ;
  entre les deux, le volume est **non identifié** et le boot le refuse par
  `VAULT_MANIFEST_UNIDENTIFIED` avant même que v86 ne soit construit — une migration inachevée ne
  peut pas se faire passer pour un volume valide. Le **journal de reprise** `<volume>.migration`,
  nouveau voisin persistant, porte le manifeste source et la preuve de sauvegarde retenue ; il n'est
  **ni chiffré ni authentifié** (jalon 4, comme le manifeste), si bien qu'un support hostile
  pourrait faire reprendre une migration depuis une identité forgée : la confiance repose ici encore
  sur le partitionnement OPFS par origine (ADR 0002). Son suffixe est **réservé** — aucun volume ne
  peut le porter — pour que migrer un volume ne puisse jamais détruire un volume légitime homonyme.
  Preuves : `tests/unit/vm-volume-migration.test.mjs` (cinq points de rupture, volume jamais valide
  à moitié) et un témoin Bout en bout où la migration est coupée après la révocation, puis le boot
  refusé (`tests/e2e/migration-volume-versionne.spec.mjs`). Décision :
  [ADR 0011](docs/decisions/0011-migration-de-format-et-reprise.md). **Depuis #16**, un TROISIÈME
  voisin persistant existe : le **journal de génération** `<volume>.gen`, qui porte les écritures
  d'une génération en cours et la racine qui la valide. Il n'est **ni chiffré ni authentifié** — sa
  somme de contrôle est un CRC-32, qui détecte la déchirure et l'octet retourné mais qu'un
  altérateur ayant accès à OPFS recalculerait sans difficulté. Le remède est celui du jalon 4
  (`SEC-BLOCK-001`, `SEC-GEN-001`) ; jusque-là, la confiance repose ici encore sur le
  partitionnement OPFS par origine (ADR 0002). Son suffixe est **réservé**, et il est retiré avec le
  volume qu'il décrit : un journal survivant ferait rejouer, sur un volume homonyme, une génération
  qui ne lui appartient pas. Décision :
  [ADR 0014](docs/decisions/0014-generation-transactionnelle.md) ;
- `SEC-RECOVERY-001` — chaque moyen de récupération annoncé possède un test de succès, de révocation
  et de perte définitive.

Chaque invariant devra être relié à un test automatisé ou, pour une revue externe, à un constat
public et sa disposition.

## Ce que le chiffrement au repos ne résout pas

Le chiffrement d'un volume ne protège pas les données déjà déverrouillées contre du code exécuté
dans la même autorité web. La séparation d'origine entre la coquille de confiance et l'application
est désormais décidée (ADR 0002) et sa frontière est éprouvée sur les quatre topologies comparées ;
elle n'est pas encore implémentée dans le produit, ce que fera #24. Le gate « données sensibles »
ci-dessous reste donc fermé.

Ce que la frontière d'origine ne couvre pas :

- une publication compromise de la coquille elle-même (`SEC-UPDATE-001`, #45) ;
- deux applications partageant l'origine applicative, qui se lisent mutuellement tant qu'une origine
  par application ou un partitionnement explicite n'est pas décidé ;
- le port restreint une fois transféré : il est joignable par tout script du document applicatif, et
  sa liste d'admission doit rester minimale.

L'authentification indépendante de chaque bloc ne protège pas à elle seule contre le rejeu d'un
ancien bloc, le déplacement d'un bloc valide, la troncature ou la restauration complète d'une
ancienne génération. Le format de volume devra fournir une intégrité transactionnelle globale.

Depuis #17, cette phrase a une suite chiffrée plutôt qu'une intention.
L'[ADR 0015](docs/decisions/0015-proprietes-cryptographiques-du-format.md) montre que la liaison de
l'identité logique au bloc (`SEC-BLOCK-001`) et l'authentification de la racine d'une génération
(`SEC-GEN-001`) couvrent **quatre** des cinq menaces et **une partie** de la cinquième — et il nomme
ce qui reste dehors au lieu de le laisser deviner :

- **le retour arrière d'un SECTEUR** du volume — un secteur authentique ramené à une version
  antérieure, à la bonne adresse, dans le bon volume — n'est **pas** détecté. Le remède connu est un
  arbre de Merkle sur les 2^20 secteurs du volume applicatif, chiffré dans l'ADR à 20 hachages par
  écriture et 64 Mio d'état. Il n'est pas fourni, et c'est une question posée à la revue externe ;
- **le retour arrière COMPLET du support** entre deux sessions — volume, journal, racine et
  manifeste ramenés ensemble à un état antérieur cohérent — n'est pas détectable par un format. Il
  exigerait un ancrage monotone hors de portée de l'attaquant, qu'aucune API de navigateur n'offre.
  Il reste couvert par le seul partitionnement OPFS par origine de l'ADR 0002.

Ces deux résidus sont **assumés et écrits**, pas résolus. Le gate « données sensibles » reste fermé,
et le gate « qualification produit » exige de toute façon la revue externe (#20), à laquelle l'ADR
0015 fournit ses huit questions.

## Propriétés exigées avant une version utilisable

- aucune clé maîtresse persistée en clair ;
- hiérarchie séparant clé de déverrouillage et clé aléatoire du volume ;
- récupération documentée et testée ;
- export portable, authentifié et restaurable ;
- résistance aux écritures partielles et arrêts brutaux ;
- liaison vérifiable entre volume, application et runtime ;
- politique explicite de mise à jour et de retour à une version antérieure ;
- tests de séparation d'origine et d'exfiltration ;
- audit externe du format cryptographique avant toute promesse de production.

## Gates d'utilisation

1. **Données synthétiques uniquement** jusqu'à la persistance transactionnelle,
   l'export/restauration et le refus d'incompatibilité.
2. **Données sensibles interdites** jusqu'à l'implémentation de la séparation d'origine, du
   verrouillage, de la récupération et du format chiffré.
3. **Qualification produit interdite** jusqu'à la revue externe, la résolution des constats
   critiques et élevés et la publication de la matrice navigateur.

Une démonstration réussie ne lève jamais seule un gate.

## Chaîne d'approvisionnement

Les dépendances sont verrouillées. Les workflows ont des permissions minimales et leurs actions
seront épinglées avant la première publication. Les images VM publiées devront fournir empreinte,
provenance de build et SBOM. Aucun secret de signature ne réside dans un artefact servi au
navigateur.

Les artefacts de la machine virtuelle ne sont pas versionnés mais **épinglés** :
`vendor/v86/MANIFEST.json` fixe pour chacun son nom, sa taille, son empreinte SHA-256, sa licence et
son URL source, avec le commit amont exact. `npm run vm:check` échoue si un fichier manque ou
diffère. Deux limites subsistent, inscrites comme risques dans l'ADR 0003 : l'image de guest
provient d'un hôte tiers qui ne publie pas d'empreinte de son côté — la nôtre protège de
l'altération, pas de la disparition — et aucune de ces sources ne fournit encore de provenance de
build vérifiable.

## La CSP de la coquille est une frontière

La CSP servie à la coquille de confiance n'est pas un durcissement décoratif : elle tient une
propriété d'**intégrité du code**, distincte de la partition d'origine. Le seul JavaScript qui
s'exécute sur l'origine de confiance est celui que cette origine a **servi**.

Politique servie, inchangée par #52 et arrêtée par
l'[ADR 0013](docs/decisions/0013-csp-de-la-coquille-et-boucle-de-v86.md) :

```text
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self';
connect-src 'self'; worker-src 'self'; frame-src 'self' <origine applicative>;
frame-ancestors 'none'; base-uri 'none'; form-action 'none'; object-src 'none'
```

`'wasm-unsafe-eval'` est là depuis l'ADR 0003 parce que le runtime instancie un module WebAssembly.
C'est le jeton le plus étroit qui l'autorise : il n'ouvre ni `eval` ni `new Function`, à la
différence de `'unsafe-eval'`, qui reste interdit avec `'unsafe-inline'`.

**Ce que #52 change** n'est pas la politique mais sa **preuve**, et le diagnostic de son refus.
Jusqu'ici, seul `tests/unit/origin-topology.test.mjs` vérifiait la chaîne servie : retirer
`'wasm-unsafe-eval'` ne faisait rougir aucun test. Depuis, `tests/browser/csp-frontiere.spec.mjs`
mesure l'**effet** de la politique sur les trois moteurs de la matrice, à chaque `npm run check`,
dans les deux sens :

- **admis** — `WebAssembly.instantiate` réussit ; un Worker servi par l'origine vit. Ce sont les
  témoins positifs, sans lesquels un relevé « tout refusé » ne prouverait qu'un banc cassé ;
- **refusé** — un script `blob:`, un script `data:` et un script inline ne s'exécutent pas ; un
  Worker créé depuis une URL `blob:` ne donne pas signe de vie ; et sous une politique additionnelle
  `script-src 'self'`, l'instanciation WebAssembly est refusée sur les trois moteurs, ce qui rend le
  jeton falsifiable.

`blob:` n'entre **ni** dans `script-src`, **ni** dans `worker-src`. L'ADR 0013 a pesé l'ajout de
`blob:` à `worker-src` — v86 en aurait besoin pour sa boucle d'ordonnancement de secours — et l'a
refusé : la mesure montre qu'une boucle fournie par Vault couvre les trois moteurs sans élargir la
politique. Ce que l'élargissement aurait retiré est précisé dans l'ADR : il ne rouvre aucune brèche
fermée par #35 — l'adversaire de `SEC-ORIGIN-001` vit sur une autre origine et n'y crée aucun
`blob:` — mais il aurait permis à une injection **sur la coquille elle-même** (#45,
`SEC-UPDATE-001`) d'exécuter du code arbitraire dans le Worker qui détient le handle OPFS exclusif
et détiendra la clé de volume.

Un contexte qui ne peut pas exécuter le runtime le **dit** désormais, dans un délai borné et avec un
code stable de la série `VAULT_RUNTIME_*` (`src/vm/runtime-errors.mjs`) : WebAssembly refusé, Worker
imbriqué refusé, aucune boucle d'ordonnancement, aucun tour de boucle. Le contrôle **observe** avant
d'accuser — il sonde un Worker `blob:` réel plutôt que de postuler le refus —, ce qui l'empêche de
mentir sur la politique servie. La limite est nommée dans l'ADR : quand le thread du Worker cesse
entièrement de rendre la main, aucune minuterie de ce Worker ne s'exécute et aucun code n'est émis ;
c'est alors la garde de l'appelant qui borne l'attente. **Cette limite demeure**, et #74 en a
déplacé la frontière dans les deux sens :

- le cas connu de thread entièrement monopolisé — l'ordonnanceur natif de Firefox — n'est plus sur
  le chemin : la boucle d'ordonnancement de v86 est fournie par Vault (`src/vm/scheduling-loop.mjs`)
  et non plus par le moteur ;
- **un cas voisin a été mesuré et traité** : sous WebKit, une boucle serrée de messages de canal
  affame les minuteries du Worker — `setInterval` et `setTimeout` ne s'exécutent pas tant qu'elle
  dure, alors que les messages venus de la page passent
  (`tests/browser/ordonnancement-famine.spec.mjs`, les trois moteurs). Un chien de garde posé sur
  une minuterie seule n'aurait donc pas pu expirer pendant la plage qu'il borne. Le chien de garde
  du premier tour et les délais de garde des sessions de guest se cadencent désormais **aussi sur
  les battements de la boucle**, si bien qu'ils tranchent que la boucle tourne ou non ;
- ce qui reste non couvert est le cas où le thread ne rend la main à **personne** : ni minuterie, ni
  message de canal. Aucun code `VAULT_RUNTIME_*` n'est alors émis, et c'est la garde de l'appelant
  qui borne l'attente.

La barrière durable elle-même n'est pas touchée par ces changements — elle reste prouvée par les
mêmes suites, exécutées à nouveau.

Enfin, `tools/serve.mjs` porte un drapeau de MESURE `--worker-src-blob` qui sert la politique
élargie. Trois propriétés le tiennent, et chacune est vérifiée plutôt qu'affirmée : il n'est
déclenchable que par un argument de ligne de commande, jamais par une URL ni par une variable seule
; il est **refusé au démarrage** si le processus ne porte pas `VAULT_HARNAIS_CSP=mesure-worker-src`,
que seul `playwright.csp.config.mjs` pose — un `npm start -- --worker-src-blob` échoue donc
bruyamment au lieu de servir la politique élargie en silence, et une épreuve unitaire fige ce refus
; et deux épreuves — une unitaire sur la chaîne produite, une de navigateur sur l'en-tête réellement
servi — vérifient que la politique par défaut ne contient aucune occurrence de `blob:`.

## Injecteur d'arrêts et d'écritures partielles (#15)

L'issue #15 ajoute au dépôt un instrument qui FABRIQUE des pannes de stockage : handle perdu,
écriture tronquée, barrière qui n'aboutit pas. Il vit dans `src/vm/crash-plan.mjs`, donc dans du
code servi à l'origine de la coquille. Trois faits, et leurs limites :

- **il ne s'arme que par une porte, et cette porte est gardée.** `armerInjecteur` appelle
  `exigerHarnaisResilience` (`src/vm/crash-harness.mjs`) avant de rendre le moindre plan de fautes.
  Sous Node, le processus doit porter `VAULT_HARNAIS_RESILIENCE=mesure-arrets` ; le refus hors
  harnais est figé par `tests/unit/vm-crash-harnais.test.mjs`, qui s'exécute dans son propre
  processus et ne pose jamais la variable ;
- **dans un Worker de navigateur, il n'y a pas d'environnement de processus.** La garde exige alors
  le JETON exact du harnais, que seul `public/vm/resilience-banc.mjs` transmet — et seulement au
  Worker qui coupe, jamais à celui qui prépare l'ancien état ni à celui qui relit. Aucun chemin du
  produit ne le FABRIQUE : ni `public/vm/banc.mjs`, ni les scénarios `barrier`, `filesystem`,
  `opfs-persistence` et `opfs-barrier` du Worker runtime. Le Worker runtime, lui, RELAIE le jeton
  que son appelant lui présente — c'est le sens exact de la garde, et la page de résilience du
  harnais est la seule à le présenter. Cette phrase est **tenue par une inspection des sources**
  (`tests/unit/vm-crash-armement.test.mjs`, qui balaye tout `src/` et `public/`) : le jeton n'est
  nommé que par la garde et par le banc de résilience, `armerInjecteur` n'est appelé que par la
  machine jetable et par `public/vm/resilience-scenarios.mjs`, et `runtime-worker.mjs` ne nomme
  l'injecteur nulle part. Une inspection de sources **interdit la dérive accidentelle** ; elle ne
  résiste pas à un contournement délibéré — un nom construit à l'exécution y échapperait —, et ce
  cas relève de la frontière d'origine de l'ADR 0002 ;
- **cette seconde garde est plus faible que la première, et elle est donnée pour ce qu'elle est.**
  Un appelant déjà présent dans le Worker peut nommer le jeton, qui est une constante de source.
  Elle interdit l'armement ACCIDENTEL et rend l'intention explicite ; elle ne prétend pas résister à
  du code hostile qui exécuterait déjà dans le Worker de la coquille — ce cas est traité par la
  frontière d'origine de l'ADR 0002, pas par un jeton.

**Le volume de résilience est figé, et c'est une dette qu'il faut nommer.** `runResiliencePreparer`
commence par EFFACER son volume, et cette suppression est en amont de tout armement : elle ne
présente aucun jeton. Le nom du volume est donc une constante du module (`VOLUME_RESILIENCE`),
jamais une valeur reçue par `postMessage`, et une épreuve d'inspection le fige. Deux portes
PRÉEXISTANTES restent ouvertes à côté : les scénarios `opfs-persistence` et `opfs-barrier` du Worker
runtime acceptent, eux, un nom de volume de leur appelant et l'effacent (`removeOpfsVolume`) avant
de l'ouvrir. Elles datent de #6 et #14, cette tranche ne les élargit pas, et elles restent bornées
par la frontière d'origine de l'ADR 0002 — seul du code de l'origine coquille peut adresser ce
Worker. Les refermer relève d'une tranche à elle, avec sa propre preuve.

`SEC-DURABLE-001` n'est pas modifié par cette tranche : aucune promesse de durabilité ne change, le
backend acquitte ses barrières exactement comme depuis #14, et les volumes de résilience sont
jetables et nommés à part. L'instrument MESURE le budget « coupures injectées » de
`docs/quality-attributes.md` ; il ne le déplace pas. Il en surveille même le respect à l'envers : un
bloc acquitté, franchi par une barrière et pourtant absent du support serait classé `corrompu`, et
un témoin négatif vérifie que cette règle sait se déclencher.

## Analyse de secrets

Chaque pull request est analysée par GuardRails (statut de commit `guardrails/scan`). L'analyse
couvre les secrets codés en dur, les bibliothèques vulnérables et les motifs de code dangereux.

Un constat a été résolu à la racine, sans suppression, et un second est exclu parce qu'il porte des
valeurs **publiques et déterministes** qu'un moteur d'entropie confond avec des secrets :

- `apps/reference/config/application.rb` — constat « Secret Keyword ». La constante s'appelait
  `VAULT_SYNTHETIC_SECRET_SOURCE` ; le mot « SECRET » dans son nom déclenchait la règle alors que la
  valeur n'est pas un secret mais l'entrée publique d'une dérivation, publiée dans
  `apps/reference/vault-invariant.json` (`secretKeyBase.derivation`). Elle est **renommée**
  `VAULT_SYNTHETIC_SIGNING_SOURCE` : un nom exact, qui n'induit en erreur ni un lecteur ni un
  analyseur. Aucune suppression n'est employée ici — la suppression inline de GuardRails n'est de
  toute façon pas honorée par le moteur de secrets. `config.secret_key_base` reste analysé, et un
  vrai secret y serait détecté.
- `tools/build-reference-image/manifest.json` — constat « Hex High Entropy String », écarté par une
  entrée nommée dans `.guardrails/ignore`. Le format JSON n'admet pas de commentaire, donc pas de
  suppression à la ligne. Ce fichier est généré par `tools/build-reference-image/manifest.mjs` et ne
  contient que des noms d'artefacts, des tailles, des licences, des origines et les empreintes
  SHA-256 d'une construction reproductible.

Ces exclusions sont **étroites par construction** : une ligne d'un côté, un fichier généré de
l'autre. Aucune règle n'est désactivée, aucun répertoire n'est exclu. Un vrai secret introduit
ailleurs — dans `apps/`, `src/`, `tools/`, `tests/` ou `.github/` — reste détecté. Le premier gate
d'utilisation interdit de toute façon d'en placer un avant la fermeture des gates de sécurité, et
`apps/reference/test/lib/no_secret_test.rb` échoue si un fichier de credentials ou une clé maîtresse
apparaît dans l'application de référence.

Élargir cette liste exige la même justification écrite qu'une nouvelle dépendance, dans la pull
request qui l'introduit.

Les constats de **bibliothèque vulnérable** ne sont jamais écartés de cette façon : ils se corrigent
par une montée de version dans `Gemfile`/`Gemfile.lock` ou `package.json`/`package-lock.json`. C'est
ce qui a été fait pour Puma, monté de 6.6.1 à 8.0.2 (CVE-2026-47736 et CVE-2026-47737, analyseur
PROXY protocol v1).

## Signaler une vulnérabilité

Tant qu'aucun canal privé propre à RailsBox Vault n'est publié, utilisez les avis de sécurité privés
du dépôt GitHub. N'ouvrez pas d'issue publique contenant une procédure d'exploitation ou des données
personnelles.
