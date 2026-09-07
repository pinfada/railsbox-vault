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

### Ce que la coquille de PRODUIT défend, et ce qu'elle ne défend pas (#161, ADR 0028)

Depuis #161, cette base de confiance existe dans le produit et non plus seulement dans un banc :
`public/index.html` et `public/main.mjs` sont la coquille, `public/runtime-worker.mjs` est le Worker
de confiance, et le contrat qui les relie est versionné (`src/coquille/`). Les deux moitiés du
modèle de menace s'écrivent au même niveau.

**Ce qu'elle défend.** Le code applicatif hostile servi par Rails, avec ses dépendances, son
hébergement et son relais. Concrètement : une application servie par l'origine applicative n'obtient
qu'un `MessagePort` transféré **une fois**, après vérification de l'ordre, du type, de l'origine et
de la fenêtre émettrice ; ce port n'accepte qu'un geste (l'état du volume) et refuse les dix gestes
de la liste de #24 par un code **typé**, jamais par un silence — chaque requête admise porte un
identifiant de corrélation, si bien que N requêtes en vol reçoivent N réponses appariées ; il ne
transporte, **dans aucun sens**, ni clé, ni handle, ni descripteur, ni capacité transférable ; le
canal privilégié coquille ↔ Worker n'est atteignable par aucun message, **même en présentant le
jeton du harnais** — qui est public, que la fixture lit chez elle, et qu'elle tente ensuite
d'employer par tous les chemins qu'elle a ; et l'origine EST l'identité — aucun champ du contrat ne
nomme une application (ADR 0018 § 4).

**Ce qu'elle ne défend pas**, et qui compte autant :

- **une publication compromise de la coquille elle-même** (`SEC-UPDATE-001`, #45). La frontière
  suppose que la coquille servie est celle qu'on a écrite ;
- **un navigateur ou une extension compromis.** Tout ce qui précède s'appuie sur la partition
  d'origine du moteur ;
- **l'adversaire qui ÉCRIT dans l'OPFS de l'origine de confiance** — celui de l'ADR 0019 § 6.9, qui
  peut déjà détruire le volume, et que la limite 7 de l'ADR 0027 retrouve avec la page d'archive
  installée à la place de la page vivante. C'est un DÉNI, pas une exposition ;
- **l'épaule qui lit le code de récupération à l'écran**, et plus généralement ce qui sort de
  l'appareil par un chemin que le produit ne maîtrise pas ;
- **deux applications partageant l'origine applicative** : mesuré par #46 (quatorze sondes sur
  dix-sept aboutissent, effacement des données et désinscription du Service Worker compris), accepté
  tant qu'une seule application est publiée (ADR 0018 décision 3) ;
- **le TEMPS de la coquille.** Un document applicatif hostile peut poster autant de messages qu'il
  veut, et chacun est décodé et compté : le fil d'exécution que la coquille partage avec lui n'est
  pas défendu, et ne peut pas l'être — un document encadré occupe de toute façon le processus qui
  l'héberge. Ce que la coquille borne est sa MÉMOIRE, et cette moitié-là est fermée et éprouvée : le
  relevé ne recopie rien du guest, la file d'appariement a une borne nommée, et un type au-delà de
  128 caractères est refusé au décodage (revue de sécurité de la PR #166, ADR 0028).

**Aucun cookie.** La coquille n'en pose aucun, et c'est une propriété éprouvée plutôt qu'une
abstention : après un cycle complet, le bocal du contexte est vide, `document.cookie` est vide sur
les deux origines, et aucune réponse servie ne porte `Set-Cookie`. Le motif est celui de l'ADR 0018
§ 5 : sur un domaine propre les deux origines de l'ADR 0002 sont le même **site** (ADR 0017 fait 1),
et **`SameSite` ne sépare pas deux sous-domaines d'un même site**. Si un cookie devenait un jour
nécessaire, l'ADR 0028 fixe la forme — préfixe `__Host-`, rien sur le domaine parent.

## Invariants vérifiables

- `SEC-ORIGIN-001` — un script applicatif ne peut acquérir le canal privilégié ou lire une clé de
  volume. La topologie qui le garantit est arrêtée par l'ADR 0002 ; la preuve de frontière est
  `tests/browser/origin-topology.spec.mjs`, rattachée à `npm run check`. **Depuis #161, cette preuve
  a une jumelle sur le chemin du PRODUIT** : `tests/browser/coquille-frontiere.spec.mjs` rejoue la
  même question sur les ports réels de la coquille de produit, contre une application malveillante
  servie par l'origine applicative, sur les trois moteurs. Les deux statuts sont distingués dans la
  table plus bas, parce qu'ils ne portent pas sur la même coquille. Elle comporte un témoin positif
  qui exige que les mêmes tentatives ABOUTISSENT en même origine, sans quoi un relevé tout vert ne
  prouverait rien. Depuis #6 la frontière porte aussi sur le stockage local : le handle OPFS
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
  `tests/e2e/restauration-inter-origine.spec.mjs` éprouve — scénario suspendu par la tranche (a) de
  #18, **rétabli par #101** : le `File` remis porte désormais un volume CHIFFRÉ, et la borne du
  marqueur `RBVAULT1` est inchangée. Dans l'autre sens, une archive n'entre dans une origine que par
  un champ de fichier ouvert par l'utilisateur : aucun canal inter-origines n'est ajouté et aucune
  directive de CSP n'est assouplie — le cloisonnement OPFS par origine reste ce qui rend la
  restauration significative, et le même scénario le vérifie avant d'importer. **Depuis #21 la
  frontière porte aussi sur l'ENVELOPPE DE CLÉ**, et de deux côtés : une vingtième sonde du spike
  #35 tente de lire un appât `vault-volume.cles` déposé dans l'OPFS de la coquille — elle ABOUTIT en
  même origine (le témoin l'exige) et échoue sur la topologie retenue —, et
  `tests/browser/enveloppe-frontiere.spec.mjs` fait tourner l'enveloppe sur l'OPFS RÉEL dans un
  Worker dédié sur les **trois moteurs**, en vérifiant que la page n'obtient aucun handle sur
  `<volume>.cles` et surtout que **rien de ce que le Worker rend par `postMessage` ne contient une
  clé** : tout le relevé des réponses est FOUILLÉ, en hexadécimal et en tableau d'octets, à la
  recherche des clés de TEST. Une frontière qui protégerait les octets chiffrés sans protéger la clé
  qui les ouvre ne protégerait rien. **Depuis #22 la frontière porte aussi sur le SECRET
  D'UTILISATEUR** — le premier que ce dépôt manipule —, et elle est mesurée dans les deux sens du
  port : `tests/browser/deverrouillage-frontiere.spec.mjs` fouille, sur les trois moteurs,
  `localStorage`, `sessionStorage`, les cookies, IndexedDB, Cache Storage, l'**OPFS entier** (en
  texte et en hexadécimal) et le relevé complet des messages, à la recherche de la phrase employée.
  La fouille commence par déposer un APPÂT dans chaque stockage et EXIGE de le retrouver : une
  fouille qui ne trouve jamais rien pourrait n'être qu'une fouille cassée. Deux frontières internes
  sont assumées et écrites plutôt que découvertes : la phrase franchit le port page → Worker —
  l'origine de CONFIANCE, pas celle que cet invariant sépare — parce qu'Argon2id calibré gèlerait
  l'interface s'il tournait sur le fil de la page, et la dérivation WebAuthn a lieu **dans le
  document** parce que `navigator.credentials` n'existe pas dans un Worker, auquel cas seule la
  `CryptoKey` non extractible franchit le port et jamais la sortie PRF ;
- `SEC-KEY-001` — une clé de déverrouillage enveloppe une DEK aléatoire sans servir directement au
  chiffrement des blocs. **Depuis #22 un humain obtient réellement sa clé**, et la réserve que #21
  portait ici est levée : deux dérivateurs
  ([ADR 0021](docs/decisions/0021-derivation-des-cles-de-deverrouillage.md)) rendent une KEK
  `CryptoKey` **non extractible**, dont les octets ne sont atteignables par aucun code de cette
  origine. `phrase` étire la phrase par **Argon2id (RFC 9106)** calculé par un artefact WebAssembly
  VENDU dans le dépôt — implémentation de référence `phc-winner-argon2`, version épinglée, empreinte
  SHA-256 recalculée **avant instanciation** dans le navigateur et vérifiée une seconde fois sur
  l'arbre publié par `publier:check` ; les vecteurs de la RFC sont rejoués sur les trois moteurs par
  le binaire réellement servi. Le **plancher de coût est celui de la RFC** — 64 Mio, trois passes,
  quatre voies — et il est vérifié à l'écriture ET à la lecture des paramètres, parce que
  l'affaiblissement de ces octets par un adversaire qui garde une copie du volume est exactement
  l'attaque que l'ADR 0020 avait nommée en les authentifiant. `webauthn-prf` évalue l'extension
  `prf` sur un sel de trente-deux octets propre à l'emplacement, exige `residentKey` et
  `userVerification`, et **ne lit pas `signCount`** (facultatif en CTAP2, ADR 0015). Les deux
  passent par HKDF-SHA-256 dont l'info lie identifiant de volume, identifiant d'emplacement et
  version — sans quoi une passkey enregistrée pour un emplacement ouvrirait le voisin, sur un autre
  volume. **Ce qui est décidé et mesuré quand la plate-forme ne peut pas** : PRF absent à
  l'enregistrement, extension ignorée à l'assertion, annulation — trois codes distincts, aucun repli
  automatique, **aucun compteur d'échec persisté**, et un type d'emplacement qu'aucun dérivateur ne
  sert refusé sans qu'un octet du fichier ne bouge. **Ce que JavaScript ne garantit pas est écrit**
  : les tampons de matériau sont mis à zéro dès que la clé existe, du côté JavaScript comme dans le
  tas WebAssembly — fenêtre refermée, pas garantie, puisque le moteur a pu les copier —, la chaîne
  PHC d'Argon2, qui porterait le matériau en base64, n'est **pas demandée du tout** plutôt que
  demandée puis effacée, et une phrase est une `string`, donc impossible à effacer ; aucun code
  JavaScript ne verrouille non plus une page en mémoire contre un fichier d'échange. Le coût est
  borné des DEUX côtés : sous le plancher un volume volé serait cassable, au-delà du plafond un
  adversaire qui écrit le fichier ferait calculer le Worker de confiance pendant des heures à chaque
  tentative. Vingt-trois gardes ont été RÉELLEMENT mutées, vingt-trois tuées, dont cinq seulement
  après l'écriture de l'épreuve qui manquait — l'une d'elles a révélé que le plancher de coût
  n'était éprouvé qu'à l'écriture. La disposition de l'enveloppe est
  l'[ADR 0020](docs/decisions/0020-enveloppe-de-cle.md) : un quatrième voisin de volume
  `<volume>.cles` dans l'origine de CONFIANCE, hors du fichier de volume et hors du manifeste, deux
  pages de 8192 octets alternées, jusqu'à huit emplacements portant chacun l'identifiant
  d'emplacement, le type de clé, les paramètres publics du dérivateur et la **DEK enveloppée par
  AES-256-GCM** dont les données associées lient identifiant de volume, identifiant d'emplacement,
  version de format, type et paramètres — **jamais `AES-KW`**, qui n'authentifie aucune donnée
  associée et laisserait donc déplacer une DEK d'un emplacement ou d'un volume à l'autre. Le fichier
  entier porte une **racine authentifiée sous la DEK** — étiquette sur la liste ORDONNÉE des
  emplacements, compteur de version monotone — vérifiée AVANT que la clé de volume n'atteigne quoi
  que ce soit d'autre que la vérification. Ce que le produit tient, mesuré et non affirmé : ajouter,
  remplacer ou révoquer une clé laisse le fichier de volume **identique à l'octet** (empreinte avant
  et après) ; une coupure à chaque rang de chaque opération, sous quatre sinistres — avant l'effet,
  après l'effet, et deux points de déchirure —, laisse l'ancien état ou le nouveau, jamais ni l'un
  ni l'autre ; une clé RÉVOQUÉE et une clé INCONNUE rendent le **même** refus
  (`VAULT_ENVELOPPE_CLE_REFUSEE`), avec le même message, le même contexte et le même nombre
  d'invocations AEAD — ce qui est mesuré est ce nombre, **pas le temps d'horloge**, que ce dépôt ne
  maîtrise pas et ne promet pas ; un volume sans enveloppe est refusé par un code DISTINCT
  (`VAULT_ENVELOPPE_ABSENTE`), parce que « clé invalide » enverrait chercher une clé qui n'existe
  pas. Les vecteurs figés `tests/vectors/enveloppe-v1.json` sont reproduits OCTET POUR OCTET par le
  chemin de production, et l'outil qui les fige pose les octets lui-même au lieu d'appeler
  l'encodeur du produit. Treize gardes ont été RÉELLEMENT mutées, treize tuées — dont une qui a
  d'abord survécu et a corrigé le raisonnement de l'ADR plutôt que le code. **Ce que l'enveloppe ne
  couvre pas** : le retour arrière complet du SUPPORT n'est pas détecté. Le retour arrière du seul
  FICHIER d'enveloppes, lui, l'est **depuis #149** — effacer la page courante fait retomber sur la
  précédente, donc ressuscite une clé révoquée, et `versionMinimale` refuse désormais cette page par
  `VAULT_ENVELOPPE_REJEU` **sous la version que l'utilisateur note sur sa feuille de récupération**
  à chaque révocation. L'aveu est éprouvé à la ligne suivante de la même épreuve : **sans la
  feuille, la page antérieure est acceptée** et la clé révoquée ouvre. Décision :
  [ADR 0027](docs/decisions/0027-archive-et-ancre-de-version.md), et un chemin de production — le
  Worker de confiance — l'alimente enfin. **L'archive emporte désormais une enveloppe de
  RÉCUPÉRATION SEULE** : la décision 6 de l'ADR 0020 est révisée, l'archive porte une page ne
  portant que des emplacements de type 4, jamais une phrase, jamais une passkey, **jamais le code**
  ;
- `SEC-BLOCK-001` — un bloc est authentifié avec volume, adresse, format, génération **et magasin**.
  Le dernier mot est une correction, pas une précision : jusqu'au format de journal 4, un
  enregistrement du journal et un secteur du volume à la même adresse sous la même génération
  partageaient leur étiquette de domaine, si bien que le sceau de l'un s'ouvrait à la place de
  l'autre — constat HIGH [#143](https://github.com/pinfada/railsbox-vault/issues/143), corrigé par
  la [PR #146](https://github.com/pinfada/railsbox-vault/pull/146), et ce que la correction laisse
  ouvert pour les journaux déjà écrits est nommé au § 9.6 de
  [`docs/format-de-volume-v3.md`](docs/format-de-volume-v3.md). **Depuis #18 le PRODUIT l'exerce**,
  et il faut dire aussitôt sous quelle réserve : le format de volume v3 scelle chaque secteur,
  chaque enregistrement de journal et chaque racine, mais la clé de volume n'est aujourd'hui
  distribuée que par le HARNAIS, sous jeton — aucun chemin du produit n'en fabrique ni n'en
  persiste, et un volume v3 présenté sans clé est refusé par `VAULT_STORAGE_CLE_REQUISE` avant toute
  lecture. L'invariant est donc tenu par le FORMAT et éprouvé de bout en bout, sous une clé de TEST
  ; la confidentialité en exploitation attend #21. La disposition sur disque est
  l'[ADR 0016](docs/decisions/0016-format-de-volume-v3-dispositions.md) : en-tête v3 d'un secteur,
  région d'authentification portant 34 octets par secteur logique — nonce 12, étiquette 16,
  génération 6 —, charge chiffrée, racine de 202 octets sans CRC-32 (136 au format de journal 2 ;
  voir le § 6.7 de la spécification, qui fait foi). Les vecteurs figés de #17 sont reproduits OCTET
  POUR OCTET par le chemin de production (`tests/unit/vm-volume-chiffre.test.mjs`), et sept refus y
  sont éprouvés sur ce même chemin : modification, déplacement d'adresse, autre volume, autre
  format, autre génération, secteur en clair, racine altérée — plus le refus sans clé. Deux défauts
  du modèle de référence ont été trouvés PAR EXÉCUTION en l'implémentant, et l'ADR 0016 les porte :
  le rescellement du point de contrôle n'avait pas de porte d'injection de nonce, donc échappait aux
  vecteurs ; et l'encodage canonique des entrées débordait la pile d'appel au plafond de charge de
  l'ADR 0014. **Un troisième constat porte sur l'ARCHIVE, et il est de sécurité** : le chemin
  d'export lisait le volume par la lecture autorisée, qui déchiffre. Exporter un volume v3 par ce
  chemin aurait produit une archive **en clair** — le chiffrement au repos annulé dès que le fichier
  quitte l'appareil, par omission et sans message. La tranche (a) l'a REFUSÉ plutôt que rendu ;
  **depuis #101, l'export passe par un accès BRUT au fichier** (`src/vm/opfs-volume-brut.mjs`), qui
  n'a ni clé ni géométrie logique et ne rend donc que du chiffré. Une épreuve le montre au lieu de
  l'affirmer : le clair d'un secteur connu n'apparaît nulle part dans le fichier exporté. **Une
  archive v3 se restaure sans clé et ne s'OUVRE pas sans elle** : la sauvegarde d'un volume chiffré
  est la sauvegarde de deux choses, et ce dépôt n'en gère qu'une avant #21 — perdre la clé, c'est
  perdre l'archive, et il faut le dire à l'utilisateur plutôt que le lui laisser découvrir.
  L'[ADR 0015](docs/decisions/0015-proprietes-cryptographiques-du-format.md) le définit ainsi : un
  bloc est scellé par AES-256-GCM (étiquette de 128 bits) dont les **données associées portent
  l'identité logique complète** — identifiant de volume, adresse logique, version de format,
  génération, rang de l'entrée, longueur, nom de l'algorithme —, encodée de façon injective (chaque
  champ de largeur fixe ou préfixé de sa longueur). Le nonce de 96 bits est **tiré de
  `crypto.getRandomValues`** et conservé avec chaque objet scellé. Il l'est depuis une révision de
  l'ADR, et le motif vaut d'être retenu : une revue a réfuté PAR EXÉCUTION la version précédente, où
  il était dérivé de (génération, rang). Le chemin de reprise de `generation-store.mjs` le
  réémettait — la génération ne progresse qu'à la validation, la récupération la remet à celle de la
  racine, et une fermeture PROPRE avec un dépôt non validé suffisait à réémettre un nonce. Sous GCM,
  cela livre le XOR des clairs et la clé d'authentification. La leçon est plus large que le défaut :
  dans un système conçu pour survivre aux coupures et exposé au retour arrière du support, tout
  nonce dérivé d'un état DURABLE est réémis dès que cet état recule. Ce que la propriété ne garantit
  pas est écrit dans l'ADR et non résumé ici : rien contre un détenteur de la clé, rien sur la
  taille du volume ni le motif d'accès, rien sur le **retour arrière d'un secteur** — un secteur
  ramené à une version antérieure authentique n'est pas détecté, parce que le lecteur lit sa
  génération dans la région d'authentification voisine, c'est-à-dire au même endroit que le sceau.
  Modification et déplacement partagent d'ailleurs un seul code de refus
  (`VAULT_CRYPTO_SCEAU_REFUSE`) : ils sont cryptographiquement indiscernables, et le modèle refuse
  sans prétendre les distinguer. Le budget de scellements par clé est fixé à **2^31**, la moitié du
  plafond du § 8.3 de NIST SP 800-38D, parce que le compteur qui le suit vit dans la racine et
  RECULE avec un retour arrière du support. Preuves : `tests/unit/vm-format-chiffre-*.test.mjs` —
  dont `vm-format-chiffre-reprise.test.mjs`, qui rejoue la réfutation ci-dessus sur le magasin RÉEL
  de l'ADR 0014 — et les vecteurs figés `tests/vectors/format-chiffre-v1.json`, que #18 devra
  reproduire octet pour octet. La borne de forgerie est calculée, pas qualifiée : ≈ 2^-122,6 par
  tentative ;
- `SEC-GEN-001` — rejeu, troncature et mélange de générations sont refusés. **EXERCÉ par le produit
  depuis #19** ([ADR 0019](docs/decisions/0019-fraicheur-du-volume.md)), pour ce qui peut l'être —
  et ce qui ne le peut pas est nommé plus bas, pas masqué. #18 en avait posé la moitié matérielle :
  la racine v3 authentifie séquence, génération, nombre d'entrées, longueur de charge et empreinte
  de la suite ordonnée. Ce qui manquait était l'autre moitié, et elle manquait en silence — les
  contrôles de SÉQUENCE n'étaient présentés par AUCUN chemin, `generationMinimale` et
  `sequenceMinimale` valant `null` partout, si bien que les refus de rejeu étaient du code mort. #19
  les arme. Quatre propriétés, chacune avec son refus typé :

  **Rejeu, en session.** L'ouvreur unique lit la dernière racine validée et PRÉSENTE le plancher de
  séquence à chaque vérification de racine, ainsi qu'un plancher de génération à chaque
  enregistrement relu. Une racine ou un enregistrement authentiques mais antérieurs sont refusés
  (`VAULT_CRYPTO_REJEU`), après vérification de l'étiquette, donc sur des valeurs authentiques.
  Aucun chemin de production ne passe plus `null` pour une racine ni pour un enregistrement ; le
  seul `null` restant — l'ouverture du témoin lui-même — est justifié dans l'ADR 0019 plutôt que
  remplacé par un contrôle décoratif. Preuve : `tests/unit/vm-generation-sequence.test.mjs`, avec
  témoin positif et mutation de chaque garde.

  **Troncature et augmentation.** L'en-tête authentifié porte le nombre d'entrées et la longueur de
  charge, dérivés des entrées au moment de sceller ; une génération incomplète — ou augmentée — est
  refusée (`VAULT_CRYPTO_TRONCATURE`), et le refus traverse la couche de stockage avec sa cause.

  **Mélange.** La racine scelle l'empreinte SHA-256 de la **suite ordonnée** de ses entrées
  (adresse, longueur, rang, étiquette du bloc), si bien qu'une entrée authentique d'une autre
  génération, ou un simple réordonnancement, est refusé (`VAULT_CRYPTO_MELANGE`).

  **Fraîcheur de la région d'authentification.** La racine scelle en outre, depuis #19, une
  empreinte de la région d'authentification du volume, rescellée sous sa propre génération à chaque
  écriture de racine. À l'ouverture, la région relue est confrontée à cette empreinte **avant toute
  lecture de secteur**. Un secteur ramené à une version antérieure — quadruplet complet remis en
  place, donc authentique, ce que l'ADR 0015 nommait comme non détecté — est désormais refusé.
  Preuve : `tests/unit/vm-generation-fraicheur.test.mjs`, qui montre les deux moitiés du fait — le
  secteur s'ouvre encore par le chemin non transactionnel, et l'ouverture transactionnelle le
  refuse.

  **Ce qui reste NON DÉTECTÉ, et qu'aucune formulation ne doit laisser croire couvert :**

  - le **retour arrière complet du support** entre deux sessions. Un témoin de dernière séquence vue
    vit à côté du volume (`<volume>.temoin`, scellé, écrit après la racine et sa barrière) et refuse
    un volume dont la séquence est inférieure : cela ferme le retour arrière **partiel**, celui qui
    ne l'emporte pas. Le témoin est dans la MÊME ORIGINE que le volume ; il ne renforce pas la
    frontière de l'ADR 0002, il rend visibles les reculs partiels. **L'effort n'est pas symétrique,
    et il faut le dire** : reculer le volume AU-DELÀ d'une génération suppose d'en détenir une copie
    antérieure cohérente avec son journal, alors que neutraliser le témoin ne suppose rien — **le
    supprimer ou le tronquer suffit, sans la clé**. Reculer d'**une** génération ne suppose rien non
    plus, et ce dossier l'a longtemps nié
    ([#144](https://github.com/pinfada/railsbox-vault/issues/144), corrigé par la
    [PR #153](https://github.com/pinfada/railsbox-vault/pull/153)) : l'alternance des racines garde
    `s − 1` lisible sur le support. **Le témoin tranche ce recul-là, SAUF contre un adversaire qui
    en détient une copie antérieure** — celui de
    [#142](https://github.com/pinfada/railsbox-vault/issues/142) : contre qui **neutralise** le
    témoin, le recul est refusé (`VAULT_STORAGE_GENERATION_ROOT_CORRUPT`,
    `docs/format-de-volume-v3.md` § 6.9) ; contre qui le **rejoue**, il ne l'est pas. Le **rejeu**
    d'un témoin authentique reste possible et n'est pas détecté — le sceau achète la non-forgerie,
    pas la non-fongibilité (#142, accepté, ADR 0019 amendé le 5 septembre 2026) —, et **en
    composition avec #144 il fait perdre des octets** : un témoin de `s − 1` archivé à l'avance (62
    octets), la racine `s` abîmée, la copie remise, et les écritures **acquittées** de la génération
    `s` disparaissent sous un rapport déclarant la fraîcheur `verifiee`, **sans qu'aucun refus ne
    soit levé**. C'est le retour arrière complet de ce paragraphe, obtenu à moindre coût. Seul, le
    rejeu ne fait perdre aucun octet : il fabrique un refus permanent d'un volume sain, et le
    message de ce refus nomme le geste qui en sort avec sa condition. Épreuve :
    `tests/unit/vm-recul-generation.test.mjs`. Un fichier absent, vide ou trop court n'est pas un
    témoin, l'ouverture repart sur « première ouverture », et la fenêtre du retour arrière complet
    est **réarmée** pour qui détient déjà une copie antérieure de volume + journal. Le comportement
    est délibéré et n'est pas changé — refuser tout volume sans témoin rendrait irouvrable un volume
    neuf, restauré, ou dont le témoin a été perdu par un incident de support. Ce qui manque est une
    **ancre monotone hors du support**, renvoyée nommément à **#23** ; d'ici là, le recul complet
    reste couvert par le seul partitionnement d'origine de l'ADR 0002. Cette limite est **exécutée**
    par la dernière assertion de `tests/unit/vm-generation-fraicheur.test.mjs` : le volume, son
    journal et son témoin reculent ensemble, et le volume rouvre ;
  - le contenu du volume **entre deux points de contrôle** : la région ne change qu'au rangement, et
    l'empreinte date cet état-là ;
  - la **version du journal** n'est pas dans les données associées de la racine. Un octet retourné y
    ferait passer une racine porteuse d'empreinte pour une racine d'avant #19 ; le décodeur refuse
    ce cas par cohérence (réserve non vierge sous un format qui la dit vide) et le témoin ferme le
    reste, mais c'est une garde, pas une authentification ;
  - un volume scellé par #18 s'ouvre **une fois** sans fraîcheur, le temps que sa première racine
    neuve la pose. Le rapport d'ouverture publie cet état (`fraicheurRegion: "migree"`) au lieu de
    le taire ;

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

  **#18 change ce que la barrière rend durable : des octets CHIFFRÉS.** Le journal de génération
  scelle chaque enregistrement, la racine porte une étiquette au lieu d'un CRC-32, et le point de
  contrôle rescelle chaque secteur du volume sous un nonce neuf (ADR 0016). L'invariant lui-même
  n'est pas modifié — l'ordre écriture → flush → acquittement, la validation par racine et la
  récupération d'ouverture sont ceux de #16 —, et la mesure le confirme : la matrice de coupures de
  #15 rejouée sur le format v3, sur OPFS réel, rend **100 %** sur trois graines, sans bloc déchiré
  ni bloc non rattachable (`tests/vm/resilience-arrets.spec.mjs`). L'oracle de #15 n'a pas bougé
  d'une ligne, et c'est délibéré : il compare l'ancien et le nouveau contenu d'un secteur sur le
  CLAIR obtenu par le chemin autorisé, jamais sur les octets du support — un oracle qui comparerait
  du chiffré classerait « autre » chaque réécriture d'un même contenu, puisque le nonce change, et
  mesurerait le nonce au lieu de la reprise. Ce que #18 ajoute au registre des refus : une écriture
  DÉCHIRÉE laisse désormais un chiffré tronqué, donc un secteur REFUSÉ à la relecture
  (`VAULT_STORAGE_SCEAU_REFUSE`) là où la v2 y laissait des octets clairs plausibles.

  Reste hors de cet invariant la perte d'un cache d'écriture VOLATIL — mort du processus du
  navigateur, coupure de courant : `Worker.terminate()` ne la produit pas, aucun des deux supports
  éprouvés ne la produit, et #16 ne la mesure donc pas. Reste également hors périmètre la reprise
  complète après fermeture (#7) ;

  **#91 abaisse le plafond de charge d'une génération de 64 à 16 Mio, et cet invariant n'en est pas
  affaibli.** Un guest qui écrirait plus de 16 Mio sans jamais franchir de barrière reçoit
  `VAULT_STORAGE_GENERATION_OVERFLOW`, qui devient une erreur d'E/S ATA : un REFUS, bruyant et typé.
  C'est le contraire d'une promesse non tenue — `SEC-DURABLE-001` interdit d'annoncer durable ce qui
  ne l'est pas, et une écriture refusée n'est annoncée durable à personne. Ce qui change est la
  SURFACE du refus, pas la promesse ; le plafond est désormais calibré sur le budget de récupération
  de `docs/quality-attributes.md` et confronté à ce que l'image de référence demande réellement
  (amendement du 2026-08-27 de l'ADR 0014) ;

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
  volume sans manifeste est refusé, jamais complété par une identité devinée. **Depuis #18 et #101,
  cette identité n'est plus seulement déclarée : elle est OPPOSABLE.** Le manifeste v3 porte
  `volume.id`, un identifiant opaque tiré à la création — ou à la migration, puisqu'un v2 n'en a pas
  —, immuable ensuite ; l'ouvreur le confronte à celui que l'en-tête du fichier porte et refuse
  l'écart par `VAULT_STORAGE_IDENTITE_VOLUME`. Et il entre dans les **données associées** de chaque
  secteur : présenter un autre fichier sous le même manifeste ne produit donc pas une lecture
  plausible, mais un sceau refusé. Avant v3, deux volumes de la même application n'étaient séparés
  par rien. La portée du contrôle, elle, ne change pas : l'en-tête n'est **pas** authentifié — c'est
  un localisateur —, et ce qui est opposable est le sceau, pas l'en-tête. **Portée exacte du
  contrôle** : `openOpfsVolume` reste appelable directement, et treize sites de production le font
  encore (énumérés et justifiés dans
  [l'ADR 0009](docs/decisions/0009-restauration-inter-origine.md)). Rien dans l'outillage n'empêche
  un nouveau chemin d'en ajouter un sans passer par l'ouvreur : c'est une **discipline de revue, pas
  une contrainte du code**. Fermer `openOpfsVolume` derrière un module privé reste du travail
  découvert. Preuves : `tests/unit/vm-opfs-volume-open.test.mjs` (le refus précède l'ouverture) et
  un témoin Bout en bout où le manifeste d'un volume restauré est retiré, puis le boot refusé
  (`tests/e2e/restauration-inter-origine.spec.mjs`, rétabli par #101). **Depuis #13**, un troisième
  état est couvert par le même contrôle : un volume dont la **migration de format** a été
  interrompue. La migration révoque le manifeste avant de muter et ne le réinscrit qu'après l'avoir
  relu depuis le support ; entre les deux, le volume est **non identifié** et le boot le refuse par
  `VAULT_MANIFEST_UNIDENTIFIED` avant même que v86 ne soit construit — une migration inachevée ne
  peut pas se faire passer pour un volume valide. Le **journal de reprise** `<volume>.migration`,
  nouveau voisin persistant, porte le manifeste source et la preuve de sauvegarde retenue ; il n'est
  **ni chiffré ni authentifié** (jalon 4, comme le manifeste), si bien qu'un support hostile
  pourrait faire reprendre une migration depuis une identité forgée : la confiance repose ici encore
  sur le partitionnement OPFS par origine (ADR 0002). Son suffixe est **réservé** — aucun volume ne
  peut le porter — pour que migrer un volume ne puisse jamais détruire un volume légitime homonyme.
  Preuves : `tests/unit/vm-volume-migration.test.mjs` (cinq points de rupture, volume jamais valide
  à moitié) et un témoin Bout en bout où la migration est coupée après la révocation, puis le boot
  refusé (`tests/e2e/migration-volume-versionne.spec.mjs`, rétabli par #101, qui fournit la
  migration v2 → v3 dont la tranche (a) n'avait déclaré que le chemin). Décision :
  [ADR 0011](docs/decisions/0011-migration-de-format-et-reprise.md). **Depuis #16**, un TROISIÈME
  voisin persistant existe : le **journal de génération** `<volume>.gen`, qui porte les écritures
  d'une génération en cours et la racine qui la valide. Il n'est **ni chiffré ni authentifié** — sa
  somme de contrôle est un CRC-32, qui détecte la déchirure et l'octet retourné mais qu'un
  altérateur ayant accès à OPFS recalculerait sans difficulté. Le remède est celui du jalon 4
  (`SEC-BLOCK-001`, `SEC-GEN-001`) ; jusque-là, la confiance repose ici encore sur le
  partitionnement OPFS par origine (ADR 0002). Son suffixe est **réservé**, et il est retiré avec le
  volume qu'il décrit : un journal survivant ferait rejouer, sur un volume homonyme, une génération
  qui ne lui appartient pas. Décision :
  [ADR 0014](docs/decisions/0014-generation-transactionnelle.md) ; Depuis **#21**, un QUATRIÈME
  voisin persistant existe : l'**enveloppe de clé** `<volume>.cles`, qui porte les DEK enveloppées.
  Elle est chiffrée et authentifiée, elle — c'est tout son objet — mais elle est aussi le seul
  chemin vers le volume : **sa perte vaut la perte des données**, et sa somme de contrôle de page ne
  protège contre AUCUN adversaire (elle sépare l'accident de l'écriture complète, pas plus). Son
  suffixe est **réservé**, et il est retiré avec le volume qu'il décrit. Décision :
  [ADR 0020](docs/decisions/0020-enveloppe-de-cle.md). **Depuis #147**, un MÉCANISME existe pour que
  la perte des clés ne soit plus la perte du volume — un code de récupération, s'il a été créé
  AVANT, ouvre encore. **Depuis #162
  ([ADR 0029](docs/decisions/0029-deverrouillage-dans-la-coquille.md)), la coquille de produit OFFRE
  ce code** : un geste le crée, il est rendu une fois avec la version d'enveloppe, et il rouvre le
  coffre depuis la même coquille. Une réserve demeure, et ce n'en est pas une petite : un volume
  dont le propriétaire n'a jamais créé de moyen de récupération se perd toujours avec ses clés — le
  produit l'AVERTIT dès qu'un coffre ouvert n'en porte aucun, il ne le crée pas à sa place. **Depuis
  #149 (tranche 3 de #23), l'archive emporte la capacité d'ouvrir** : un volume chiffré restauré sur
  un autre appareil s'ouvre par le code, et le code n'entre jamais dans l'archive. La perte du
  FICHIER reste la perte du volume ;
- `SEC-RECOVERY-001` — chaque moyen de récupération annoncé possède un test de succès, de révocation
  et de perte définitive. **EXERCÉ depuis #162 ; il l'était SOUS RÉSERVE depuis #147.** #21 en avait
  posé la moitié mécanique — révoquer un emplacement est éprouvé, et révoquer le DERNIER est refusé,
  parce qu'un volume sans issue n'est pas un état acceptable — mais aucun moyen de RÉCUPÉRATION
  n'existait : perdre toutes ses clés de déverrouillage revenait à perdre le volume. #147 (tranche 1
  de #23) pose le premier : un **code de récupération GÉNÉRÉ par le produit**, cent vingt-huit bits
  tirés de `crypto.getRandomValues`, rendu en vingt-huit symboles base 32 de Crockford avec une
  somme de contrôle, **rendu une seule fois** et persisté nulle part. Décision :
  [ADR 0025](docs/decisions/0025-moyen-de-recuperation.md). Les trois épreuves que l'invariant exige
  sont nommées : succès, révocation et perte définitive dans
  `tests/unit/vm-derivation-recuperation.test.mjs`, et le cycle complet sur l'OPFS réel des trois
  moteurs dans `tests/browser/deverrouillage-frontiere.spec.mjs`. **Depuis #148, la RÉVOCATION
  D'URGENCE est éprouvée elle aussi** : « retirer tous les emplacements sauf celui que la clé
  présentée ouvre » tient en une version et une barrière, la matrice de coupures le classe à chaque
  rang (tous les emplacements, ou le seul retenu, jamais un sous-ensemble), et plus AUCUN octet d'un
  emplacement retiré ne subsiste dans les 16 384 du fichier —
  `tests/unit/vm-enveloppe-revocation-urgence.test.mjs`,
  `tests/unit/vm-enveloppe-coupures.test.mjs`, et le geste sur l'OPFS réel dans
  `tests/browser/enveloppe-frontiere.spec.mjs`. Ce que cela ne rattrape pas est l'entrée 12 de la
  liste « non couvert » : révoquer ne rechiffre pas. **Depuis #149, la tranche 3 ferme le
  transport** : une archive emporte une enveloppe de RÉCUPÉRATION SEULE, et un volume chiffré
  restauré sur une autre origine **s'ouvre par le code** — le cycle est mesuré au niveau unitaire
  (`tests/unit/vm-restauration-recuperation.test.mjs`) et joué de bout en bout, deux origines
  réelles et boot Rails compris, par `tests/e2e/archive-recuperation-inter-origine.spec.mjs`.
  Décision : [ADR 0027](docs/decisions/0027-archive-et-ancre-de-version.md). **La réserve écrite ici
  est LEVÉE depuis #162** ([ADR 0029](docs/decisions/0029-deverrouillage-dans-la-coquille.md)) : la
  coquille de produit OFFRE le moyen de récupération à un utilisateur — un geste le crée, le code
  est rendu une fois avec la version d'enveloppe, et il rouvre le coffre depuis la même coquille,
  saisi sous sa forme humaine. Le Worker des bancs n'est plus le seul appelant hors épreuves.

  Ce qui n'est PAS couvert, et n'est pas une réserve de l'invariant : la RÉVOCATION depuis la
  coquille appartient au cycle de vie assemblé (#163), et l'impression de la feuille sort par un
  chemin que le produit ne maîtrise pas — pilote, file d'attente, parfois un PDF sur le disque. La
  coquille affiche ; elle n'imprime pas, et ne le promet pas.

### Ce que la coquille RETIENT pendant qu'un coffre est ouvert

Le Worker de confiance garde, pour la durée de la session ouverte, la **clé de déverrouillage**
(KEK) qui a servi à ouvrir. Ce n'est pas un effet de bord : ajouter un emplacement — créer un moyen
de récupération — exige de détenir une clé qui ouvre déjà (ADR 0020), et sans rétention la coquille
devrait redemander la phrase, donc la faire vivre une seconde fois et payer une seconde dérivation,
pour un geste que l'utilisateur vient de rendre possible.

Elle vit du même côté de la frontière que la clé de volume développée, ne franchit aucun port, et
disparaît avec l'onglet. **C'est un endroit de plus où un secret existe, et il dure aussi longtemps
que la session** : le verrouillage après inactivité (#25) est ce qui bornera cette durée. Voir
l'[ADR 0029](docs/decisions/0029-deverrouillage-dans-la-coquille.md), limite 2.

### Ce que le moyen de récupération COUVRE, et ce qu'il ne couvre pas

Les deux listes sont au même niveau, et la seconde n'est pas une liste de travaux à venir : c'est ce
que le produit ne promet pas. `tests/unit/dossier-de-revue.test.mjs` relit leurs huit entrées.

**Couvert.**

1. **Passkey perdue** — l'appareil qui portait la créance a disparu, l'emplacement `webauthn-prf`
   n'ouvre plus rien. Le code ouvre, et un emplacement neuf se recrée sous lui.
2. **Appareil perdu, avec l'archive et le code** — l'archive restaure les données, **et le code
   rouvre l'enveloppe**. **VRAI depuis #149**
   ([ADR 0027](docs/decisions/0027-archive-et-ancre-de-version.md)) : l'archive emporte une page
   d'enveloppe ne portant que des emplacements de type 4, la restauration écrit `<volume>.cles` à
   partir d'elle, et le volume restauré s'ouvre par le code sur un appareil qui n'a jamais vu la
   moindre autre clé. La réserve qui figurait ici — « l'archive n'emporte PAS `<volume>.cles` »,
   décision 6 de [l'ADR 0020](docs/decisions/0020-enveloppe-de-cle.md) — est LEVÉE, et cette
   décision-là est révisée.

   **Ce que ce service coûte, et il est dit ici plutôt que découvert** : une archive volée offre au
   code une cible hors ligne — l'adversaire essaie des codes contre la DEK enveloppée sans qu'aucun
   système ne compte ses essais. Ce qui rend ce profil acceptable est que le code porte **128 bits
   TIRÉS** et n'est le choix de personne. C'est pourquoi une **phrase secrète ne voyage jamais** :
   elle porte l'entropie qu'un humain a bien voulu lui donner.

3. **Phrase oubliée** — le code ouvre, et une phrase neuve se recrée sous lui. C'est exactement le
   cycle que le bout en bout des trois moteurs joue.
4. **Emplacement compromis** — il se **révoque**, et un adversaire qui en tenait la clé retrouve le
   refus d'une clé inconnue, indiscernable. **Depuis #148**, le geste composé existe : « révoquer
   tout sauf celui que je tiens » retire tous les emplacements en UNE version et UNE barrière, et
   l'emplacement conservé est celui que la clé présentée OUVRE — jamais un identifiant fourni, qu'un
   inventaire public livre à qui le demande. Décision :
   [ADR 0026](docs/decisions/0026-revocation-d-urgence-et-page-libre.md). **Réserve, et elle porte
   sur toutes les révocations** : révoquer NE RECHIFFRE PAS — voir l'entrée 12.

5. **Une archive porte l'enveloppe de récupération** — qui détient **l'archive ET le code** ouvre le
   volume, où qu'il soit ; **l'archive seule n'ouvre rien**, et le code seul n'ouvre rien non plus
   puisqu'il n'y a pas de données. C'est le service que #149 rend, et sa contrepartie est l'entrée 2
   ci-dessus. L'archive ne porte **jamais** un emplacement `phrase` ni `webauthn-prf`, et **jamais**
   le code : `tests/unit/vm-archive-recuperation.test.mjs` décode la page embarquée et vérifie les
   types, et cherche le code sous ses trois formes.

**Non couvert.**

6. **Tous les moyens perdus, code compris** — le volume est PERDU, définitivement. Il n'existe
   **aucun séquestre**, aucune copie de secours, aucun moyen pour l'éditeur de rouvrir un coffre, et
   **c'est délibéré** : un séquestre serait une clé de plus, chez quelqu'un d'autre.
7. **Archive perdue** — le code ouvre une enveloppe, pas un volume disparu. La sauvegarde reste
   l'affaire de l'exploitant.
8. **Copie du code prise avant la révocation** — qui a photographié la feuille tient la clé jusqu'à
   la révocation, et rien ne dit qu'une copie a été prise. La révocation est le seul remède, et elle
   n'est pas rétroactive.
9. **La SUBSTITUTION de la page embarquée d'une archive à l'enveloppe vivante, à version ÉGALE** —
   depuis #149, chaque archive porte une page d'enveloppe AUTHENTIQUE du volume, signée sous sa clé
   et portant sa version du jour de l'export. Un adversaire qui peut ÉCRIRE dans l'OPFS de l'origine
   de confiance — le même que celui de l'ADR 0019 § 6.9, qui détruit déjà le volume s'il le veut —
   peut l'installer à la place de `<volume>.cles`. Les phrases et les passkeys cessent alors
   d'ouvrir, sans qu'aucune révocation ait eu lieu.

   **L'effet est un DÉNI, pas une exposition** : rien n'est lu, rien n'est perdu, et le code ouvre
   encore — c'est même la seule chose qui ouvre. **`versionMinimale` ne le voit pas, par
   construction** : la page substituée porte la MÊME version que la vivante, et une ancre qui
   compare des versions ne distingue pas deux pages authentiques de même rang. Ce que #149 change
   n'est pas la capacité de l'adversaire mais la PROVENANCE de la page : elle ne réside plus
   seulement sur l'appareil, elle est dans chaque archive.

   Ce qui le fermerait est nommé, et **non décidé** : une marque « page d'archive » dans les données
   associées de la racine, refusée comme page vivante. Elle n'empêcherait pas l'installation — elle
   n'achèterait qu'un diagnostic —, et elle invaliderait les vecteurs figés
   `tests/vectors/enveloppe-v1.json`. Le prix dépasse le gain tant qu'aucune mesure ne montre le
   contraire.

10. **Retour arrière COMPLET du support** — remettre en place une copie entière et cohérente du
    volume et de son enveloppe ramène un emplacement révoqué. C'est la limite que
    [l'ADR 0020](docs/decisions/0020-enveloppe-de-cle.md) nomme, et le code de récupération ne la
    ferme pas.
11. **Ce que le SUPPORT garde de l'emplacement retiré, entre les deux barrières d'une révocation** —
    `<volume>.cles` porte DEUX pages en alternance, et une révocation n'en réécrivait qu'une : les
    octets de l'emplacement retiré — identifiant, paramètres publics, sel, **DEK enveloppée et
    étiquette** — subsistaient dans l'autre jusqu'au geste d'enveloppe suivant. C'est le constat
    [#156](https://github.com/pinfada/railsbox-vault/issues/156), et **#148 le corrige** : toute
    mutation qui RETIRE une clé écrit 8192 zéros sur la page libérée, après la barrière qui publie
    ([ADR 0026](docs/decisions/0026-revocation-d-urgence-et-page-libre.md)).

    **La promesse exacte, et elle est bornée en deux endroits.** La page libre est effacée après
    chaque retrait ; **si une coupure survient entre la barrière qui publie et la seconde, la page
    ancienne reste lisible JUSQU'À LA MUTATION SUIVANTE, qui la réécrit ; aucune réparation n'est
    jouée à l'ouverture** — ouvrir une enveloppe est une lecture, et un ouvreur qui écrirait
    déplacerait la fenêtre sans la fermer, puisque la réparation elle-même peut être coupée. Ce que
    la coupure ne touche pas est la SERRURE : aucune clé retirée n'ouvre, et c'est mesuré.

    **Et le support, dans tous les cas.** La promesse porte sur le FICHIER tel que le produit le
    relit, jamais sur les blocs sous-jacents : un système de fichiers à copie sur écriture, un SSD
    qui remappe, un instantané pris entre les deux barrières peuvent conserver les anciens octets,
    et le produit ne peut ni l'empêcher ni l'observer. C'est un « fait, non garanti », dans les
    termes de la décision 7 de
    [l'ADR 0021](docs/decisions/0021-derivation-des-cles-de-deverrouillage.md).

12. **Toute copie prise AVANT une révocation, code ou fichier** — **révoquer ne RECHIFFRE PAS.** Une
    révocation retire une clé de déverrouillage ; elle ne change pas la clé de volume. Qui détient
    `<volume>` et une page ANTÉRIEURE de `<volume>.cles` développe toujours la même DEK et lit
    toujours le volume tel qu'il était. La révocation protège le fichier À VENIR, pas la copie déjà
    prise. La seule parade est la **rotation de la clé de volume**, hors périmètre : rechiffrer 512
    Mio coûte 87,6 s ([ADR 0015](docs/decisions/0015-proprietes-cryptographiques-du-format.md),
    [ADR 0016](docs/decisions/0016-format-de-volume-v3-dispositions.md)), et aucun chemin du produit
    ne l'offre.

**Ce qui sort de l'appareil sort du périmètre.** Un code imprimé passe par un spouleur, parfois par
un fichier PDF intermédiaire, parfois par le disque d'une imprimante réseau. Vault ne maîtrise aucun
de ces chemins, ne les observe pas, et ne promet rien à leur sujet.

Chaque invariant devra être relié à un test automatisé ou, pour une revue externe, à un constat
public et sa disposition.

### Table des statuts, au 6 septembre 2026

Le vocabulaire est FERMÉ — **exercé**, **exercé sous réserve**, **non exercé** — et il porte sur le
CODE du jour, pas sur l'intention. « Exercé sous réserve » veut dire : un chemin de production
l'exerce, et une condition écrite en limite la portée. Aucun invariant « à venir » n'est présenté
comme tenu. La table est relue par `tests/unit/dossier-de-revue.test.mjs`, qui exige une ligne par
invariant, un statut du vocabulaire, et une épreuve qui existe.

**`SEC-ORIGIN-001` porte DEUX lignes depuis #161, et c'est une décision.** Il était « exercé »
contre la coquille du SPIKE — une page de banc, écrite « compétente, PAS durcie », qui plante des
appâts délibérés et dont le secret est `SHELL_SECRET`. Un statut unique aurait donc couvert une
coquille que personne n'avait écrite. Les deux lignes disent ce qui est prouvé de laquelle : le banc
reste le témoin des quatre topologies de l'ADR 0002, et la coquille de produit a désormais sa propre
épreuve, sur ses ports réels, contre une application malveillante servie par l'origine applicative.

**La ligne de la coquille de PRODUIT passe « exercé » avec #163**, et il faut dire sur quoi. La
partition d'origine est démontrée par la topologie — pas par COOP, pas par COEP (ADR 0010) —, et
elle l'était déjà depuis #161. Ce qui manquait était le CYCLE : la frontière était éprouvée sur une
coquille qui n'ouvrait aucun volume applicatif et ne bootait aucune machine. Elle l'est désormais
sur une coquille qui installe une application, ouvre son volume sous la clé développée de son
enveloppe, boote Rails dans son Worker de confiance, se referme proprement et rouvre — pendant que
le document applicatif encadré, sur l'autre origine, n'obtient toujours qu'un état et un compte de
barrières. Les réserves qui restent ne portent plus sur la partition, et elles sont nommées dans la
colonne.

| Invariant                              | Statut                  | Réserve, quand il y en a une                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Épreuve                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------- | ----------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SEC-ORIGIN-001` — coquille du SPIKE   | **exercé**              | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/browser/origin-topology.spec.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `SEC-ORIGIN-001` — coquille de PRODUIT | **exercé**              | la frontière est éprouvée sur les ports RÉELS de la coquille de produit ; le geste de DÉVERROUILLAGE est celui d'un UTILISATEUR depuis #162 ; le CYCLE DE VIE est assemblé depuis #163 — l'ordre des huit étapes est daté, publié et tenu par une garde, et un scénario de bout en bout boote Rails DANS la coquille sur deux origines réelles. Ce qui n'est pas encore couvert n'est pas une réserve sur la partition : le document encadré n'est pas servi par le guest (le proxy vient plus tard), et le verrouillage après inactivité est #25 | `tests/browser/coquille-frontiere.spec.mjs` (application malveillante, dix gestes refusés, témoin positif en même origine, trois moteurs), `tests/browser/coquille-deverrouillage.spec.mjs` (les trois moyens depuis la coquille, trois moteurs), `tests/browser/coquille-cycle-de-vie.spec.mjs` (l'ordre des huit étapes, le refus d'un boot avant le backend, la mort du Worker sur ses trois causes, trois moteurs), `tests/e2e/reprise-coquille-boot-froid.spec.mjs` (deux origines réelles, boot Rails dans la coquille, fermeture propre, réouverture), `tests/unit/coquille-admission.test.mjs`, `tests/unit/coquille-contrat.test.mjs`, `tests/unit/coquille-cycle-de-vie.test.mjs`                                                                                                                                                                                                                                                                                                                                                                 |
| `SEC-KEY-001`                          | **exercé**              | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `tests/browser/enveloppe-frontiere.spec.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `SEC-BLOCK-001`                        | **exercé sous réserve** | le format scelle tout, de bout en bout — mais la clé du chemin de BOOT vient encore du harnais, sous jeton                                                                                                                                                                                                                                                                                                                                                                                                                                        | `tests/unit/vm-volume-chiffre.test.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SEC-GEN-001`                          | **exercé sous réserve** | rejeu, troncature, mélange et retour arrière d'un secteur sont refusés ; le retour arrière COMPLET ne l'est pas                                                                                                                                                                                                                                                                                                                                                                                                                                   | `tests/unit/vm-generation-sequence.test.mjs` (rejeu, troncature), `tests/unit/vm-format-chiffre-modele.test.mjs` (troncature, mélange), `tests/unit/vm-generation-fraicheur.test.mjs` (retour arrière d'un secteur, témoin)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `SEC-DURABLE-001`                      | **exercé**              | hors périmètre : la perte d'un cache d'écriture VOLATIL, qu'aucun support éprouvé ne produit                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `tests/vm/opfs-barrier.spec.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SEC-UPDATE-001`                       | **exercé sous réserve** | l'ouvreur unique est une discipline de revue, pas une contrainte du code : l'ouverture de bas niveau reste appelable                                                                                                                                                                                                                                                                                                                                                                                                                              | `tests/unit/vm-opfs-volume-open.test.mjs`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `SEC-RECOVERY-001`                     | **exercé**              | le mécanisme est éprouvé de bout en bout, **transport de la capacité d'ouvrir compris depuis #149**, et **offert à un UTILISATEUR par la coquille de produit depuis #162** (ADR 0029)                                                                                                                                                                                                                                                                                                                                                             | `tests/browser/coquille-deverrouillage.spec.mjs` (le code créé, rendu une fois avec sa version, repris sous sa forme humaine, depuis le chemin de produit, trois moteurs), `tests/unit/vm-derivation-recuperation.test.mjs` (succès, révocation, perte définitive), `tests/browser/deverrouillage-frontiere.spec.mjs` (le cycle complet sur l'OPFS réel des trois moteurs), `tests/unit/vm-enveloppe-operations.test.mjs` (révoquer le DERNIER est refusé), `tests/unit/vm-enveloppe-revocation-urgence.test.mjs` et `tests/unit/vm-enveloppe-coupures.test.mjs` (la révocation d'urgence de #148), `tests/browser/enveloppe-frontiere.spec.mjs` (le geste sur l'OPFS réel des trois moteurs), `tests/unit/vm-archive-recuperation.test.mjs` et `tests/unit/vm-restauration-recuperation.test.mjs` (l'archive v2 et le cycle export → restauration → ouverture par le code), `tests/unit/vm-enveloppe-ancre-version.test.mjs` (l'ancre de version et son aveu), `tests/e2e/archive-recuperation-inter-origine.spec.mjs` (deux origines réelles, boot Rails) |

Les deux « sous réserve » du format de volume, la conduite de chaque refus et ce que le format ne
protège pas sont détaillés dans [`docs/format-de-volume-v3.md`](docs/format-de-volume-v3.md), la
spécification autonome soumise à la revue externe (#20). Le registre de cette revue
([`docs/revue-externe/registre.md`](docs/revue-externe/registre.md)) est **vide** : aucun tiers n'a
été sollicité, et le gate « données sensibles » ci-dessous reste fermé.

## Ce que le chiffrement au repos ne résout pas

Le chiffrement d'un volume ne protège pas les données déjà déverrouillées contre du code exécuté
dans la même autorité web. La séparation d'origine entre la coquille de confiance et l'application
est décidée (ADR 0002), sa frontière est éprouvée sur les quatre topologies comparées, et elle est
**implémentée dans le produit depuis #161** (ADR 0028) : une coquille, un Worker de confiance, un
port restreint mis à l'épreuve par une application malveillante sur les trois moteurs. Le gate «
données sensibles » ci-dessous reste fermé pour une autre raison — le verrouillage après inactivité
(#25) n'est pas ouvert.

Ce que la frontière d'origine ne couvre pas :

- une publication compromise de la coquille elle-même (`SEC-UPDATE-001`, #45) ;
- deux applications partageant l'origine applicative, qui se lisent — et s'effacent — mutuellement.
  Le point est désormais **mesuré et tranché** par
  l'[ADR 0018](docs/decisions/0018-isolation-entre-applications.md) : sur une même origine, quatorze
  sondes sur dix-sept aboutissent d'une application à l'autre sur les trois moteurs, y compris
  l'effacement du répertoire OPFS et la désinscription du Service Worker. Aucun partitionnement par
  chemin, par nom de répertoire OPFS ou par nom de base IndexedDB n'y change quoi que ce soit : **le
  navigateur ne cloisonne que par origine**. La règle décidée est donc **une origine par
  application** — un sous-domaine, jamais un port ni un chemin — et le MVP accepte explicitement la
  limite parce qu'il ne publie **qu'une** application, donc sans victime possible. **Condition de
  réouverture : une seconde application publiée.** La seule borne réelle par chemin est la portée
  d'un Service Worker, elle ne couvre que le réseau, et elle ne doit jamais être citée comme une
  isolation de stockage ;
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
  exigerait un ancrage monotone hors de portée de l'attaquant. Le seul candidat qu'une API de
  navigateur expose est `authenticatorData.signCount` de WebAuthn, et il ne suffit pas : CTAP2 le
  rend facultatif, la plupart des authentificateurs de plateforme rendent zéro, et son emploi
  supposerait une décision de #21. Une piste best-effort contre le retour arrière PARTIEL est nommée
  dans l'ADR — garder la dernière séquence connue hors du fichier de volume — sans être exigée. Le
  retour arrière complet reste donc couvert par le seul partitionnement OPFS par origine de
  l'ADR 0002.

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

## Aucun Service Worker sur l'origine de confiance

C'est une décision, pas une abstention (#163,
[ADR 0030](docs/decisions/0030-cycle-de-vie-assemble-dans-la-coquille.md), décision 4). La question
était ouverte : l'ADR 0010 la posait nommément — « #24 doit dire si un Service Worker injectant COOP
est admissible DANS la frontière » —, parce qu'un hébergeur sans en-têtes laisserait cette porte
comme seule façon de servir la politique.

Le refus tient en trois points :

- un Service Worker sur l'origine de confiance interpose du code **privilégié** entre l'hébergeur et
  la coquille. Il voit passer chaque requête, survit à la fermeture de l'onglet, et se met à jour
  par un chemin distinct de celui du reste. La partition de l'ADR 0002 sépare deux **origines** ;
  elle ne dit rien d'un tiers installé **dans** l'une d'elles ;
- l'hébergeur à en-têtes est de toute façon **exigé des deux côtés** (ADR 0017 § 3 bis) : le Service
  Worker ne résoudrait rien qu'un hébergeur ne résolve, et ajouterait un composant privilégié ;
- un `<meta>` ne porte ni COOP ni `frame-ancestors` (ADR 0017, fait 1) : il n'y a pas de troisième
  voie.

L'absence est **surveillée** plutôt qu'affirmée : `tests/unit/coquille-sans-service-worker.test.mjs`
rougit si un appel d'enregistrement apparaît dans ce que l'origine de confiance sert. Le territoire
**applicatif** en porte un dans le banc du spike #35, et c'est son droit : ce que le guest sert lui
appartient.

`Cross-Origin-Opener-Policy: same-origin` est, lui, **servi** sur l'origine de confiance depuis
#163, et attesté par `window.opener === null` sur les trois moteurs. Il ferme une relation de
**fenêtres** ; il ne cloisonne aucun stockage, et `SEC-ORIGIN-001` reste démontré par la partition
d'origine.

## Gates d'utilisation

1. **Données synthétiques uniquement** jusqu'à la persistance transactionnelle,
   l'export/restauration et le refus d'incompatibilité.
2. **Données sensibles interdites** jusqu'à l'implémentation de la séparation d'origine, du
   verrouillage, de la récupération et du format chiffré. **Où en sont les quatre, au 7 septembre
   2026** : le format chiffré est livré (#18, ADR 0015 et 0016) ; la séparation d'origine est
   **implémentée depuis #161** — une coquille de produit, un Worker de confiance, un port restreint
   éprouvé contre une application malveillante sur les trois moteurs ; la récupération est **OFFERTE
   depuis #162** — la coquille crée le moyen, rend le code une fois avec la version d'enveloppe, et
   le reprend sous sa forme humaine ; le verrouillage après inactivité (#25) n'est pas ouvert. Le
   gate reste donc **fermé**, et il le restera tant que le quatrième manquera. Trois des quatre sont
   livrés : c'est un compte, pas une autorisation. **#163 ne change pas ce compte** — il assemble le
   cycle de vie et écrit la conduite à la mort du Worker de confiance, ce qui donne à #25 le chemin
   de fermeture propre qu'elle réemploiera, mais ni le déclencheur, ni le délai, ni le sens de «
   verrouillé ». Une conduite sur un accident n'est pas une règle sur une durée.
3. **Qualification produit interdite** jusqu'à la revue externe, la résolution des constats
   critiques et élevés et la publication de la matrice navigateur.

Une démonstration réussie ne lève jamais seule un gate.

## Chaîne d'approvisionnement

Les dépendances sont verrouillées. Les workflows ont des permissions minimales et leurs actions sont
**épinglées par SHA de commit** depuis #105 : une étiquette `vN` est déplaçable par son
propriétaire, un SHA nomme un contenu. L'exécutant qui rend cet épinglage nécessaire est celui de
`.github/workflows/publication.yml`, qui calcule et affiche l'empreinte de racine de l'arborescence
publiée — une action amont substituée y publierait l'arbre de son choix ET l'empreinte qui va avec,
si bien que la comparaison hors bande de l'ADR 0017 confirmerait l'altération au lieu de la révéler.
Chaque `uses:` porte l'étiquette figée en commentaire, ce qui donne son mécanisme de mise à jour
(`.github/dependabot.yml`, lot hebdomadaire relu comme une PR ordinaire) ;
`tests/unit/workflows-actions-epinglees.test.mjs` refuse toute action qui perdrait l'une des deux
moitiés. Les images VM publiées devront fournir empreinte, provenance de build et SBOM. Aucun secret
de signature ne réside dans un artefact servi au navigateur.

Les artefacts de la machine virtuelle ne sont pas versionnés mais **épinglés** :
`vendor/v86/MANIFEST.json` fixe pour chacun son nom, sa taille, son empreinte SHA-256, sa licence et
son URL source, avec le commit amont exact. `npm run vm:check` échoue si un fichier manque ou
diffère. Deux limites subsistent, inscrites comme risques dans l'ADR 0003 : l'image de guest
provient d'un hôte tiers qui ne publie pas d'empreinte de son côté — la nôtre protège de
l'altération, pas de la disparition — et aucune de ces sources ne fournit encore de provenance de
build vérifiable.

**Depuis #22 un second artefact tiers est vendu, et il est traité plus sévèrement que le premier.**
`vendor/argon2/argon2.wasm` — l'implémentation de référence d'Argon2 (`phc-winner-argon2`) compilée
en WebAssembly, publiée par `argon2-browser@1.18.0` — est **versionné dans le dépôt**, contrairement
aux artefacts v86 : il fait vingt-cinq kilo-octets et il est chargé à chaque déverrouillage par
phrase, si bien qu'un artefact récupéré à la construction ferait dépendre l'ouverture d'un coffre
d'une étape de construction, et un artefact récupéré à l'exécution serait un CDN, que l'ADR 0013
interdit. `vendor/argon2/MANIFEST.json` en fixe la taille, l'empreinte SHA-256, l'empreinte du
tarball npm, le commit amont, les licences et jusqu'aux noms minifiés de ses exportations.

Son empreinte est confrontée **deux fois, à deux moments, et aucune ne remplace l'autre** : par
`publier:check` sur l'arbre publié avant qu'il ne parte, et par `src/vm/derivation/argon2-vendu.mjs`
dans le navigateur, sur les octets réellement reçus, **avant d'instancier le module**. La raison de
cette sévérité tient en une phrase : ce binaire étire un secret d'utilisateur, et un binaire
substitué en chemin pourrait rendre une étiquette prévisible sans que rien ne le dise — la phrase de
chacun ouvrirait alors un coffre que l'adversaire ouvre aussi.

**Aucune ligne de la colle Emscripten publiée avec ce binaire n'est importée** : le module exige
deux importations, elles tiennent en quinze lignes écrites ici, et l'artefact tiers se réduit donc à
un binaire vérifiable par empreinte plutôt qu'à cent pages de code. **Ce qui reste non établi, et
qui doit être dit** : personne dans ce dépôt n'a recompilé ce binaire depuis ses sources. Ce qui est
prouvé est qu'il reproduit deux des trois vecteurs de la RFC 9106 à l'octet, sur les trois moteurs ;
ce n'est pas la même chose qu'un audit de son code. Le troisième vecteur (Argon2i) n'est pas rejoué
parce que cette variante, juste dans ce binaire, y est **mesurée cinq ordres de grandeur trop
lente** — elle n'est donc pas servie, et le produit n'emploie qu'Argon2id.

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

## Le durcissement générique de la coquille, et ce qu'il n'est pas (#104)

L'[ADR 0022](docs/decisions/0022-entetes-de-durcissement.md) ajoute deux en-têtes à ce que
`tools/serve-headers.mjs` sert aux documents de la **coquille**, et en écarte un troisième. La
décision est prise **par rôle**, et la raison tient en une phrase : `frame-ancestors` est une
propriété de l'hébergement — qui a le droit d'encadrer ce document —, alors que `Referrer-Policy` et
`Permissions-Policy` gouvernent ce que le document **émet** et ce qu'il **peut**. Ce sont des
politiques de contenu, et le contenu du territoire applicatif vient du guest (ADR 0002).

- **`Referrer-Policy: no-referrer`** ferme une fuite réelle, relevée et non déduite : la seule
  requête inter-origine que la CSP ci-dessus laisse sortir est le **cadre** du territoire
  applicatif, et sous la politique par défaut des moteurs elle portait l'origine de la coquille
  jusqu'à une origine dont le contenu vient du guest. `tests/browser/entetes-durcissement.spec.mjs`
  le mesure, avec son témoin négatif — la même manipulation depuis un document du rôle `app`, où le
  `Referer` survit. **Mesuré sous Chromium seulement** dans la tranche qui l'a livré ;
- **`Permissions-Policy: camera=(), microphone=(), geolocation=()`** refuse trois capacités que
  personne n'appelle dans ce dépôt, à liste d'autorisation vide — `()` ne désigne personne, pas même
  `self`. Elle est délibérément **courte** : un refus en bloc fermerait des capacités jamais
  mesurées, et la panne serait silencieuse et dans le guest. Ce qui est éprouvé est qu'elle est
  **servie** ; son effet sur un moteur ne l'est pas, et l'ADR le dit ;
- **`Strict-Transport-Security` est écarté du code**, et gardé absent par des épreuves sur les deux
  rôles et les deux arbres. Tout ce que ce dépôt sait servir est en `http:`, où RFC 6797 § 7.2 exige
  du navigateur qu'il l'ignore ; et HSTS engage un **domaine**, y compris le sous-domaine applicatif
  si `includeSubDomains` est posé sur un domaine propre. C'est une obligation d'exploitant, inscrite
  dans [`docs/release-policy.md`](docs/release-policy.md) — donc tenue par un humain, pas par un
  cliquet.

Aucune de ces trois décisions n'est posée sur l'origine applicative : `tools/publier-temoin.mjs`
relève leur **absence** sur cette origine, comme il relève leur présence sur la coquille.

## La politique de cache est décidée par nature d'artefact (#103)

L'[ADR 0023](docs/decisions/0023-politique-de-cache-par-nature-d-artefact.md) remplace le
`Cache-Control: no-store` uniforme par trois politiques, décidées dans `tools/serve-headers.mjs` et
dérivées par la publication. Deux points touchent le modèle de menace, et un troisième une propriété
de mise à jour.

- **Les octets de la coquille deviennent conservables sur le disque de l'utilisateur.** `no-cache`
  autorise le stockage et impose la revalidation ; `no-store` l'interdisait. Ce qui est ainsi
  conservé est du **logiciel public** — la coquille, ses modules, l'émulateur épinglé —, jamais un
  volume, jamais une clé : le volume vit dans OPFS et l'enveloppe de clé hors du volume (ADR 0020),
  ni l'un ni l'autre ne passant par le cache HTTP. L'adversaire qui lit le cache HTTP d'un poste
  partagé y apprend que Vault a été ouvert, ce que l'historique de navigation lui disait déjà ;
- **`no-store` est CONSERVÉ sur l'origine applicative, et c'est maintenant une décision.** Ce que
  cette origine sert en production porte les cookies de session Rails et vient du guest : ni la
  place tenante ni un document de session n'ont à s'attarder dans un cache partagé. Le corollaire
  est la ligne de l'ADR 0002 : ce que le **guest** sert de sa propre origine reste gouverné par ses
  propres en-têtes, et cette décision ne prétend pas le gouverner ;
- **`immutable` est SERVI, et ce qui l'autorise est l'adresse (#123).** Chaque artefact v86 est
  publié à une URL qui NOMME son empreinte — `libv86-<empreinte>.mjs` —, si bien qu'un ré-épinglage
  le DÉPLACE : un navigateur qui garderait l'ancienne adresse pour toujours ne la demanderait plus
  jamais, et une mise à jour de **sécurité** du runtime n'est plus retardée par le cache. La
  politique est `public, max-age=31536000, immutable` sur `/vendor/v86/artefacts/*`, et sur ce
  préfixe seulement. Ce n'est pas une intention : `verifierEpinglageV86` le mesure sur l'arbre
  publié avant qu'il ne parte — chaque adresse dérivée est servie, chaque octet servi est déclaré,
  chaque empreinte est recalculée sur les octets — et refuse en code 5 sinon ;
- **le MANIFESTE n'est pas immuable, et c'est la condition de tout le reste.** Il reste `no-cache`,
  hors du préfixe épinglé, parce qu'il est l'**indirection** par laquelle un chargeur apprend les
  adresses : une copie périmée en désignerait qui ne sont plus servies. Le coût d'une montée de
  version est un aller-retour de cinq kibioctets par visite, au lieu des 9,9 Mio qu'il décrit ;
- **les octets reçus sont confrontés aux 256 bits du manifeste AU CHARGEMENT.** L'adresse n'en nomme
  que seize caractères hexadécimaux. `src/v86-adresses.mjs` est publié et lu par les chargeurs du
  dépôt ; il refuse par une erreur typée (`VAULT_V86_EMPREINTE`) des octets dont l'empreinte pleine
  ne correspond pas. Ce que cette vérification attrape est l'**accident** — un cache qui garde un
  artefact à côté d'un manifeste d'une autre version, un dépôt partiel, un octet retourné en chemin
  —, que le cache d'un an rend plus probable et non moins. Ce qu'elle n'attrape pas est une origine
  qui ment aux deux du même geste : cette défense-là est la vérification de publication, sur l'arbre
  construit à partir d'un commit ;
- **la classe de cache longue est accordée par EMPLACEMENT, et la publication borne cet
  emplacement.** Tout ce qui relève de `/vendor/v86/artefacts/` reçoit un an de cache **partagé** et
  non revalidable ; or ce répertoire est ignoré par git et peuplé par `npm run vm:fetch`. Un fichier
  qui y traînerait sur le poste qui publie serait donc distribué sous cette politique, sans
  empreinte épinglée et sans révocation. `verifierEpinglageV86` confronte le manifeste et le disque
  dans les **deux** sens : un fichier présent que `vendor/v86/MANIFEST.json` ne déclare pas est un
  écart d'épinglage, et la publication est refusée (code 5) ;
- **une ABSENCE n'est jamais cachable.** `Cache-Control` gouverne une réponse ; le format `_headers`
  associe des en-têtes à un CHEMIN. Sous le préfixe immuable, une adresse qui n'existe pas encore
  relève donc de la règle d'un an comme si elle existait, et un 404 est stockable par défaut. Les
  serveurs de ce dépôt rendent toute absence en `no-store`, sur tous les chemins. Chez un hébergeur
  réel, cela reste une **obligation d'exploitant** : dépôt atomique, ou artefacts déposés AVANT le
  manifeste qui les nomme. Non mesuré ici (#124).

Une seule dimension d'en-tête varie selon le chemin, et le cliquet de publication refuse qu'une
seconde s'y ajoute : une divergence de CSP, de COOP, de `Referrer-Policy` ou de `Permissions-Policy`
entre deux chemins d'un même arbre reste refusée comme elle l'était avant #103.

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

## L'instantané de reprise contient la RAM invitée (#65)

L'[ADR 0024](docs/decisions/0024-instantane-de-reprise.md) ajoute un sixième voisin de volume,
`<volume>.instantane`, et il faut dire sans détour ce qu'il porte : **l'état v86 complet, donc la
mémoire du guest** — des pages de la base SQLite en cache, des tampons de Puma, et potentiellement
du matériel de session. C'est l'objet le plus sensible que ce dépôt écrive après le volume lui-même,
et les quatre règles qui suivent découlent de ce seul fait.

- **Il est CHIFFRÉ sous la DEK**, la même clé que le volume, développée par l'enveloppe de
  l'ADR 0020. Un instantané en clair à côté d'un volume chiffré serait un contournement complet du
  jalon 4 : il suffirait de le lire pour lire le volume. Un seul scellement AES-256-GCM par capture,
  dont les données associées sont la liaison entière — identifiant de volume, séquence, génération,
  empreinte de région, empreinte d'image, longueur.
- **Il ne sort JAMAIS de l'origine de confiance.** Il n'entre dans aucune archive d'export (ADR
  0008, ADR 0024 § 1) : l'archive reste sans clé et sans état mémoire. Il ne traverse aucun port,
  aucun `postMessage` et aucune frontière d'origine ; seul le Worker runtime le lit et l'écrit, par
  la même porte OPFS que le volume.
- **Il est RETIRÉ dès qu'il ne décrit plus l'état présent** : suppression du volume, restauration
  (#12), migration (#13), et toute ouverture qui l'écarte. Position par défaut écrite pour #25 : un
  **verrouillage le retire aussi**, parce qu'un instantané qui survivrait laisserait sur le support
  la RAM invitée chiffrée sous une clé que l'utilisateur vient de mettre hors d'atteinte — ce n'est
  pas une fuite, mais ce n'est pas ce que « verrouiller » promet.
- **`SEC-DURABLE-001` est INCHANGÉ.** L'instantané n'est jamais une source de vérité et ne porte
  aucune promesse de durabilité : celle-ci est tenue par le journal de génération, comme depuis #14.
  Un instantané perdu, refusé ou retiré ne perd aucune donnée — il coûte un boot à froid. La
  quiescence de l'adaptateur va dans le même sens : pendant une capture, aucune E/S n'est acquittée,
  parce qu'un acquittement pendant une capture serait exactement le mensonge que cet invariant
  interdit.

**Le TRANSCRIT SÉRIE sort du Worker, et c'est le seul canal par lequel du contenu du guest le
fait.** Quand un boot dépasse son délai de garde, l'erreur emporte la fin du journal série — quatre
mille caractères — pour que la panne soit diagnosticable : sans elle, un boot qui n'aboutit pas
arrive en CI réduit à « délai dépassé ». Ce transcrit est la sortie console du guest, donc
potentiellement des lignes de journal de l'application. Trois bornes l'encadrent : il ne part que
sur un ÉCHEC, il est tronqué, et il ne quitte jamais l'origine — il va au banc, qui l'attache à un
artefact de test. Il n'entre dans aucun instantané, dans aucune archive et dans aucune télémétrie,
puisqu'il n'y en a pas. Une conduite produit qui exposerait ce transcrit à un utilisateur devrait le
décider explicitement ; ce dépôt ne le fait qu'en banc.

**Ce que l'instantané NE protège pas, et il faut l'écrire.** Son en-tête est en clair : il révèle
l'identifiant du volume, la séquence, la génération et deux empreintes. C'est le canal auxiliaire
que l'ADR 0015 assume déjà pour la racine, à ceci près que la séquence d'un instantané date la
dernière FERMETURE. Et un retour arrière complet du support — volume, journal, témoin et instantané
ensemble — reste hors de portée exactement comme l'ADR 0019 l'écrit : la liaison de l'instantané est
dérivée du même support, elle n'ajoute ni ne retire rien à cette limite.

## Analyse de secrets

Chaque pull request est analysée par GuardRails (statut de commit `guardrails/scan`). L'analyse
couvre les secrets codés en dur, les bibliothèques vulnérables et les motifs de code dangereux.

Un constat a été résolu à la racine, sans suppression, et un second est exclu parce qu'il porte des
valeurs **publiques et déterministes** qu'un moteur d'entropie confond avec des secrets :

**Ce que #162 a levé** ([ADR 0029](docs/decisions/0029-deverrouillage-dans-la-coquille.md)) : la
réserve écrite était « aucun chemin de production ne l'offre à un UTILISATEUR (#24) ». La coquille
de produit l'offre désormais, et les trois épreuves que l'ADR 0025 demandait sont atteintes par ce
chemin-là : le code est CRÉÉ depuis la coquille et rendu UNE fois avec la version d'enveloppe
(`tests/browser/coquille-deverrouillage.spec.mjs`), un second geste rend
`VAULT_DERIVATION_CODE_DEJA_RENDU`, et le code saisi sous une forme HUMAINE — minuscules, espaces,
replis de Crockford — rouvre le coffre. La sonde de non-persistance est étendue à ce chemin : six
stockages, l'OPFS en texte et en hexadécimal, et les DEUX SENS du port privilégié comme du port
restreint, pour la phrase, le code sous ses deux formes, ses seize octets et son matériau HKDF — sur
les trois moteurs.

**Ce qui reste vrai et n'est pas une réserve de l'invariant** : la RÉVOCATION depuis la coquille
appartient au cycle de vie assemblé (#163), et l'impression de la feuille sort par un chemin que le
produit ne maîtrise pas — pilote, file d'attente, parfois un PDF sur le disque. La coquille affiche
; elle n'imprime pas, et ne le promet pas.

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
