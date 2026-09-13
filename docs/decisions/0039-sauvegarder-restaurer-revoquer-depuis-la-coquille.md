# ADR 0039 — Sauvegarder, restaurer et révoquer depuis la coquille : un coffre, une identité

- **Statut** : accepté
- **Date** : 2026-09-13
- **Issue** : [#207](https://github.com/pinfada/railsbox-vault/issues/207) (épique #195, débloque
  #193)
- **Complète** : [ADR 0028](0028-coquille-de-produit-et-frontiere.md) (contrat strict : trois types
  privilégiés neufs, une dérogation d'archive),
  [ADR 0026](0026-revocation-d-urgence-et-page-libre.md) (la révocation d'urgence, désormais
  atteignable depuis la coquille), [ADR 0027](0027-archive-et-ancre-de-version.md) (l'archive et sa
  page de récupération), [ADR 0034](0034-archive-authentifiee-et-racine-initiale.md) (l'engagement
  d'archive), [ADR 0037](0037-reprendre-une-installation-interrompue.md) (une naissance coupée se
  répare par un geste, jamais d'elle-même).
- **Amende par note datée** : [ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md) (« Deux
  volumes, un seul coffre » : l'identifiant du volume applicatif) ;
  [ADR 0029](0029-deverrouillage-dans-la-coquille.md) (limite 9, levée).
- **Ne traite pas** : l'ordre et les écrans du parcours (#193), leur mise en forme (#194), la
  migration des coffres de développement antérieurs (refusés, voir décision 8).

## Contexte

L'épique #195 affirmait « les gestes existent (… exporter, restaurer, révoquer) ». C'était vrai du
dépôt — `writeArchive`, `importArchive`, `revoquerToutSauf` — et faux de la coquille : le canal
privilégié ne portait aucun des trois, et l'ADR 0029 le disait à sa limite 9.

Les brancher a fait apparaître un conflit que la lecture seule ne montrait pas, et qu'une sonde
d'exécution a établi le 13/09/2026 (`tests/unit/coquille-identite-du-coffre.test.mjs`, rouge sur le
code d'avant) :

- le coffre de la coquille tient **deux volumes** sous la même clé (ADR 0030) : `coquille` (trente-
  deux secteurs) et `application` (le disque de Rails) ;
- l'**enveloppe** était liée à l'identifiant du volume `coquille`, une constante ; le volume
  `application` naissait sous un identifiant **tiré** ;
- une **archive** porte UN volume et la page de récupération qui l'ouvre, et cette page doit
  authentifier l'identifiant de CE volume (`assertEnveloppeDuMemeVolume`, ADR 0027). La KEK du code
  est elle-même liée à l'identifiant par son info HKDF (ADR 0021).

L'archive utile — le disque de Rails — n'emportait donc aucune enveloppe ouvrable ailleurs
(`VAULT_ARCHIVE_RECUPERATION_REFUSEE`), et la page reconstruite sous son identifiant était refusée
(`VAULT_ENVELOPPE_IDENTITE`). Le superviseur a retenu l'option « un coffre, une identité ».

## Décision

### 1. Un coffre = une identité

Le volume `application` **naît** sous l'identifiant que l'enveloppe authentifie,
`IDENTIFIANT_DU_COFFRE` (`src/coquille/identites-du-coffre.mjs`) — la constante que le Worker de
confiance posait depuis #161, qui ne change pas de valeur mais de portée. Le volume `coquille`
reçoit une constante **distincte**, `IDENTIFIANT_DU_VOLUME_COQUILLE`.

- **Pourquoi l'identifiant applicatif était tiré.** L'ADR 0016 fait de l'identifiant la propriété
  d'un volume, lue de son en-tête et de son manifeste, jamais réinventée ; l'ouvreur le tire à la
  naissance quand l'appelant n'en déclare pas. #163 n'en déclarait pas, et rien n'exigeait alors
  qu'il soit celui de l'enveloppe : aucune archive ne sortait du coffre.
- **Pourquoi il devient l'identité de l'enveloppe.** C'est la seule forme qui laisse `src/vm/`, le
  format d'archive et le déverrouillage intacts : la page que `construireEnveloppeDeRecuperation`
  scelle sous `IDENTIFIANT_DU_COFFRE` authentifie alors exactement le volume archivé, et
  `importArchive` l'accepte sans qu'aucune garde ne soit contournée.
- **Pourquoi la distinction de l'ADR 0015 est TENUE.** Les données associées d'un secteur portent
  l'identifiant de son volume ; deux volumes sous la même clé et le même identifiant se rejoueraient
  l'un dans l'autre. `application` et `coquille` gardent **deux** identifiants, comme avant — ils
  ont échangé leurs rôles, ils ne se sont pas confondus. L'épreuve
  `coquille-identite-du-coffre.test.mjs` exige les deux constantes distinctes.
- **Pourquoi une constante partagée par tous les coffres est sans effet.** Un identifiant n'est pas
  un secret et ne sépare pas deux coffres : la **clé** le fait, tirée par coffre
  (`tirerCleDeVolume`). Deux coffres de deux appareils portent le même identifiant sous deux clés
  différentes, exactement comme le volume `coquille` depuis #161. La seule chose qu'un identifiant
  commun permettrait — greffer le secteur d'un coffre dans un autre — échoue à l'authentification
  sous l'autre clé.

### 2. Le contrat : trois demandes, trois réponses, une dérogation

| Demande (page → Worker)                | Réponse (Worker → page)                        |
| -------------------------------------- | ---------------------------------------------- |
| `vault.coquille.sauvegarder-le-coffre` | `vault.coquille.sauvegarder-le-coffre-reponse` |
| `vault.coquille.restaurer-le-coffre`   | `vault.coquille.restaurer-le-coffre-reponse`   |
| `vault.coquille.revoquer-en-urgence`   | `vault.coquille.revoquer-en-urgence-reponse`   |

Toutes trois ne franchissent que le canal privilégié ; `REPONSES_PRIVILEGIEES` apparie les trois
réponses (elles sont dérivées par leur nom).

**`sansCapacite` refuse `File` et `Blob`, et il a raison de le faire par défaut** : sur le port
restreint, un `File` serait un octet du coffre franchissant la frontière. Or une archive EST un
fichier, et la seule forme qui ne la charge pas en mémoire. D'où `CHAMP_DE_L_ARCHIVE`, écrit à côté
de la dérogation de la KEK et borné comme elle : un seul champ, `archive` ; deux types seulement,
`sauvegarder-le-coffre-reponse` et `restaurer-le-coffre` ; un `File` ou un `Blob` seulement — un
tampon, un flux ou un handle restent refusés partout. Un `File` n'est pas une capacité au sens de
l'ADR 0002 : il donne ses propres octets, figés, et n'ouvre rien d'autre.

Six codes neufs, tous au § 10.5 : `VAULT_COQUILLE_COFFRE_ANTERIEUR`,
`VAULT_COQUILLE_EMPLACEMENT_OCCUPE`, `VAULT_COQUILLE_RESTAURATION_INTERROMPUE`,
`VAULT_COQUILLE_ARCHIVE_SANS_RECUPERATION`, `VAULT_COQUILLE_APPLICATION_NON_INSTALLEE`,
`VAULT_COQUILLE_GESTE_EN_COURS`. Une archive altérée ou tronquée garde le code de sa famille —
`VAULT_ARCHIVE_DIGEST_MISMATCH`, `VAULT_ARCHIVE_TRUNCATED` — que la page traduit en conduite : ce
sont deux remèdes distincts (une autre copie, un nouveau téléchargement), et un code de coquille qui
les recouvrirait les confondrait.

### 3. Sauvegarder

- **Exige** un coffre **ouvert** (la KEK de la session construit la page de récupération et la clé
  de volume scelle l'engagement) et une application **installée** (un manifeste). Sinon
  `VAULT_COQUILLE_VOLUME_VERROUILLE` ou `VAULT_COQUILLE_APPLICATION_NON_INSTALLEE`.
- **Le point de contrôle.** Une sauvegarde pendant que Rails écrit n'est cohérente qu'à un point où
  aucune écriture n'est en vol. Si l'application tourne, la sauvegarde l'**arrête** d'abord : VM
  arrêtée, instantané capturé, volume fermé par `close()` qui attend toute E/S acceptée (#132) — le
  chemin de la fermeture, sans perdre la clé. Puis le disque est rouvert transactionnellement, ce
  qui rejoue la dernière génération validée, refermé, et lu sous l'accès brut exclusif. La cohérence
  inscrite est `CONSISTENCY_KINDS.exclusiveHandle`, avec son détail, et la réponse la porte avec
  `applicationArretee`. L'utilisateur redémarre l'application s'il le veut.
- **L'archive** est au format courant (v3), avec la page de récupération seule emportée (ADR 0027)
  et l'engagement authentifié (ADR 0034). Elle est écrite en flux dans le fichier OPFS
  `coquille-sauvegarde`, qui reste jusqu'à la sauvegarde suivante, et rendue à la **page** sous la
  forme d'un `File` adossé à ce fichier. La page la remet au navigateur par un lien de
  téléchargement. La réponse porte la taille, l'empreinte et la cohérence, jamais un octet.
- **Sans moyen de récupération**, la page le DIT avant de demander l'archive
  (`AVERTISSEMENT_SANS_RECUPERATION` : « une archive prise maintenant ne s'ouvrira nulle part
  ailleurs ») ; le Worker ne refuse pas, et la réponse dit `recuperationEmportee: false`.
- **Pourquoi le chemin v4 de `ouvrirPourExport` est réécrit côté coquille** plutôt qu'importé :
  `export-du-fichier.mjs` importe le lecteur de la migration pour solder un volume v3, et aucun
  chemin servi ne doit l'atteindre (`vm-perimetre-du-sans-racine.test.mjs`, ADR 0037). La coquille
  n'écrit que du v4 ; elle reprend la moitié v4 — récupérer, refermer, reprendre un handle brut,
  constater taille et identifiant — et refuse un manifeste d'un autre format comme coffre antérieur.

### 4. Restaurer

- **Exige** un emplacement **vide** : ni enveloppe `coquille.cles`, ni volume `application`, ni
  manifeste, ni volume `coquille`, et aucun coffre ouvert dans ce Worker. Un coffre présent rend
  `VAULT_COQUILLE_EMPLACEMENT_OCCUPE` : on ne restaure jamais par-dessus.
- **Avant tout clair et toute écriture** : l'en-tête de l'archive est lu (préambule, en-tête JSON
  borné à 1 Mio) pour une seule question — emporte-t-elle une récupération ? Sinon
  `VAULT_COQUILLE_ARCHIVE_SANS_RECUPERATION`, rien n'est écrit. Puis `importArchive` VÉRIFIE
  l'archive entière (marqueur, version lue, empreinte, identité, page, engagement) avant d'ouvrir la
  cible ; une archive altérée ou tronquée est refusée sous son code et la cible reste vierge.
- **L'ordre de naissance est celui de `importArchive`, inchangé** : disque recopié, flushé et
  **relu** ; puis l'enveloppe — posée par `cibleDuCoffre` sur `coquille.cles`, là où le Worker la
  lit, et non à côté du disque ; puis l'engagement ; puis le manifeste, **en dernier**. Aucune garde
  n'est contournée : `assertEnveloppeDuMemeVolume` juge la page contre le manifeste de l'archive
  comme partout ailleurs. Les attentes d'application (`expectations.app`) sont celles du descripteur
  servi quand il y en a un.
- **Une restauration coupée se RÉPARE par le même geste.** Coupée avant le manifeste, elle laisse
  soit un disque sans enveloppe, soit un disque à côté d'une enveloppe dont la page est encore du
  domaine `recuperation` — la page d'une archive, qu'aucune mutation n'a réécrite. Ces deux
  signatures sont `restaurationInterrompue` (`constaterLEmplacement`). Rien ne s'y ouvre : le
  déverrouillage et l'inventaire rendent `VAULT_COQUILLE_RESTAURATION_INTERROMPUE`, et aucun coffre
  neuf ne peut être créé par-dessus. Restaurer de nouveau retire les volumes `application` et
  `coquille` avec leurs voisins, puis restaure. Ce n'est pas une destruction de données : ce qui est
  retiré ne s'ouvre par rien, et l'utilisateur tient l'archive qui le redonne. Une installation
  coupée (enveloppe du domaine `enveloppe`) n'est pas réclamée : elle reste à la reprise de #173.
- **Le volume `coquille` d'une origine qui restaure** n'est pas restauré : il naît **neuf** au
  premier déverrouillage, sous sa constante, avec la même enveloppe. Son contenu n'est qu'un secteur
  de barrière ; le compte de barrières est celui du Worker, qui repart de zéro à chaque chargement.
  La réponse le dit : `etat: "verrouille"`, `volumeCoquille: "a-naitre"`, `barrieres`.
- **Puis** le coffre s'ouvre par le code de récupération et l'ancre de version saisie, par les
  gestes existants. Rien n'est ajouté au déverrouillage.

### 5. Révoquer en urgence

- **Exige** un coffre ouvert. `revoquerToutSauf` garde l'emplacement que la KEK de la session ouvre
  — celui qui vient d'ouvrir — et retire tous les autres : une version, une barrière, la page libre
  effacée (ADR 0026). Aucun identifiant n'est fourni par la page.
- **Ce qui est publié** : la réponse et l'état privilégié (`revocation`) portent `restants` et
  `retires` par NOM de moyen, `nombreRestants`, `nombreRetires` et la version d'enveloppe. Jamais un
  identifiant d'emplacement, jamais un octet de clé. Le moyen de récupération retenu pour la session
  est oublié : s'il a été retiré, le recréer en rend un neuf.

### 6. Pendant un boot ou une installation : refusé, pas mis en attente

Le Worker sert ses gestes en série. Un geste de portabilité mis en file derrière un boot de deux
minutes attendrait sans le dire ; une révocation d'urgence qui attend n'est plus une urgence. Les
gestes LONGS — démarrer, reprendre l'installation, sauvegarder, restaurer — sont comptés dès leur
**arrivée**, et un geste de portabilité arrivé pendant l'un d'eux est refusé **hors de la file**
sous `VAULT_COQUILLE_GESTE_EN_COURS`.

### 7. La frontière ne bouge pas

Aucun des trois types n'est admis sur le port restreint : `evaluerRequete` les refuse comme types du
canal privilégié (`VAULT_COQUILLE_PORT_PRIVILEGIE_REFUSE`), calculé sur le type seul. La fixture
hostile gagne trois sondes qui les posent avec une corrélation valable (`NOMBRE_DE_SONDES` : 49).
Aucun octet d'archive ne franchit le port restreint, et le Service Worker de la coquille de cadre
(ADR 0038) ne voit rien de ces gestes : il relaie du HTTP, et l'archive ne passe jamais par HTTP.

### 8. Les coffres de développement antérieurs sont REFUSÉS, jamais migrés

Un coffre créé avant le 13/09/2026 porte l'identité du coffre dans l'en-tête de son volume
`coquille`, ou un manifeste applicatif sous un identifiant tiré. Il est reconnu **dès l'inventaire**
et refusé sous `VAULT_COQUILLE_COFFRE_ANTERIEUR`, avant qu'aucune phrase ne soit dérivée, avec sa
conduite : supprimer les données du site et recréer le coffre. Aucune migration n'est offerte : rien
n'est publié, le gate « données sensibles » est fermé, et une migration serait du code de sécurité
écrit pour des coffres de développement.

## Conséquences

- Le Worker de confiance importe `public/portabilite-du-worker.mjs` ; le battement en est sorti
  (`public/battement-du-worker.mjs`) pour qu'il reste sous son plafond de lignes. Les décisions
  vivent dans `src/coquille/portabilite-du-coffre.mjs`, mutées par la campagne de la coquille.
- `public/index.html` gagne une section sémantique de trois gestes ; P2 (#193) les ordonnera.
- La table des types de la coquille entre au § 10.5, sous un cliquet neuf
  (`coquille-types-documentes.test.mjs`) : les codes avaient le leur, les types n'en avaient pas.

## Limites

1. **La sauvegarde arrête l'application.** C'est le prix du point de contrôle ; une sauvegarde à
   chaud exigerait une barrière du guest coordonnée avec la lecture, que ce dépôt n'a pas.
2. **L'archive occupe l'OPFS de l'origine** jusqu'à la sauvegarde suivante : le quota paie deux fois
   la taille du disque le temps de l'enregistrer.
3. **La réparation d'une restauration coupée repose sur deux signatures**, dont le domaine de la
   page. Une restauration coupée puis mutée à la main — impossible par la coquille, qui refuse tout
   déverrouillage entre-temps — ne serait plus reconnue, et l'emplacement serait dit occupé.
4. **Le téléchargement est un geste du navigateur** : ce que l'hôte fait du fichier enregistré
   (synchronisation, sauvegarde système) sort du produit, comme la feuille de récupération imprimée.
5. **La constante d'identité est publique**, comme elle l'était pour le volume `coquille` : ce qui
   protège un coffre est sa clé, pas son nom.

## Ce que la revue doit attaquer

1. le **rejeu inter-volumes** après l'échange d'identités (`application` ↔ `coquille`) ;
2. l'**enveloppe copiée en clair** sur `coquille.cles` : des octets publics, scellés — à démontrer ;
3. la **restauration coupée** : chaque rang de coupure, et ce que le déverrouillage en fait ;
4. le **refus des coffres antérieurs** : qu'aucun ne soit ouvert, écrasé ou migré en silence.
