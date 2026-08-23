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
  vert ne prouverait rien ;
- `SEC-KEY-001` — une clé de déverrouillage enveloppe une DEK aléatoire sans servir directement au
  chiffrement des blocs ;
- `SEC-BLOCK-001` — un bloc est authentifié avec volume, adresse, format et génération ;
- `SEC-GEN-001` — rejeu, troncature et mélange de générations sont refusés ;
- `SEC-DURABLE-001` — aucune écriture n'est annoncée durable avant le flush effectif. Le spike #4 a
  établi que l'émulateur amont rend cet invariant **inatteignable** : son disque n'annonce pas de
  cache d'écriture, le guest n'émet donc jamais de barrière, et la commande FLUSH CACHE serait de
  toute façon acquittée sans atteindre le stockage.
  L'[ADR 0003](docs/decisions/0003-backend-de-blocs-v86.md) pose le pont qui rétablit la barrière ;
  l'ordre écriture → flush → acquittement est prouvé par `tests/vm/durability-barrier.spec.mjs`,
  avec son témoin négatif. L'invariant n'est pas pour autant tenu : le backend éprouvé est en
  mémoire et déclare `durable: false`. La durabilité réelle appartient à #6 ;
- `SEC-UPDATE-001` — runtime et application sont identifiés et vérifiés avant d'ouvrir le volume en
  écriture ;
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

La CSP de la coquille autorise depuis l'ADR 0003 le jeton `'wasm-unsafe-eval'` dans `script-src` :
le runtime instancie un module WebAssembly. Ce jeton n'ouvre ni `eval` ni `new Function` ;
`'unsafe-eval'` et `'unsafe-inline'` restent interdits, ce que vérifie
`tests/unit/origin-topology.test.mjs`.

## Analyse de secrets

Chaque pull request est analysée par GuardRails (statut de commit `guardrails/scan`). L'analyse
couvre les secrets codés en dur, les bibliothèques vulnérables et les motifs de code dangereux.

Deux emplacements en sont explicitement exclus, parce qu'ils portent des valeurs **publiques et
déterministes** que les moteurs d'entropie confondent avec des secrets :

- `apps/reference/config/application.rb`, la ligne qui définit `VAULT_SYNTHETIC_SECRET_SOURCE` —
  constat « Secret Keyword », écarté par un commentaire `guardrails-disable-line` sur cette ligne
  seule. Le nom de la constante contient « SECRET » ; sa valeur est une chaîne publiée dans
  `apps/reference/vault-invariant.json` (`secretKeyBase.derivation`). La clé de signature de la
  fixture en est le SHA-512 : elle ne protège rien, la fixture ne porte ni session ni donnée réelle,
  et `SECRET_KEY_BASE` reste surchargeable par l'environnement.
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
