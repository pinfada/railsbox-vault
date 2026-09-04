# ADR 0022 — La coquille sert `Referrer-Policy` et `Permissions-Policy` ; HSTS est écarté du code et confié à l'exploitant

- Statut : accepté
- Date : 2026-09-04
- Issue : #104 · Invariants : `SEC-ORIGIN-001`, `VAULT-DIST-001` · Jalon 2

## Contexte

Le risque résiduel n°7 de l'[ADR 0017](0017-chaine-de-publication.md) est écrit ainsi :

> **Aucun en-tête de durcissement générique n'est publié** — ni `Referrer-Policy`, ni
> `Permissions-Policy`, ni `Strict-Transport-Security`. Ce n'est pas un choix positif : c'est la
> conséquence mécanique de la règle « rien de plus que ce que sert le serveur de test », qui n'en
> sert aucun. La règle a une bonne raison — que les épreuves de frontière mesurent ce qui est publié
> — mais elle transforme ici une absence en décision par défaut.

Cet ADR ne change pas la règle : il la remonte d'un cran. Les en-têtes retenus sont posés **dans**
`tools/serve-headers.mjs`, la source de vérité de l'ADR 0017 § 2, donc servis d'abord en
développement et mesurés par les épreuves de frontière existantes ; la publication les en dérive
sans une ligne de plus. L'ordre inverse — les ajouter à `EN_TETES_AJOUTES_PAR_LA_PUBLICATION` —
aurait recréé exactement la divergence que l'ADR 0017 s'emploie à éviter : une politique servie en
production que rien ne mesure en développement.

**La décision est prise par RÔLE**, et pas une fois pour toutes les deux origines. C'est la ligne de
l'[ADR 0002](0002-topologie-origine-de-confiance.md) : le HTML du territoire applicatif vient du
**guest**, et lui imposer une politique reviendrait à mesurer la nôtre au lieu de la frontière. La
distinction que l'ADR 0017 § 3 bis a établie pour `frame-ancestors` s'applique ici et rend un
résultat **inverse** : `frame-ancestors` est une propriété de l'**hébergement** — qui a le droit
d'encadrer ce document —, alors que `Referrer-Policy` et `Permissions-Policy` gouvernent ce que le
document **émet** et ce qu'il **peut**. Ce sont des politiques de contenu, et elles s'arrêtent donc
à la frontière du territoire applicatif.

## Ce qui a été établi, et comment

1. **La coquille livrait son origine au territoire applicatif.** Relevé, pas déduit : avec la
   coquille servie sur `http://127.0.0.1:4173` et le territoire applicatif sur
   `http://localhost:4174`, la requête du **cadre** — la seule requête inter-origine que la CSP de
   l'ADR 0013 laisse sortir, `connect-src 'self'` et `img-src 'self'` fermant les autres — portait
   `Referer: http://127.0.0.1:4173/`. C'est le relevé rouge de la boucle TDD de #104, reproduit par
   `tests/browser/entetes-durcissement.spec.mjs`. Sous `no-referrer`, l'en-tête disparaît. Le
   **témoin négatif** est la même manipulation émise depuis un document servi par le rôle `app`, qui
   ne reçoit pas de `Referrer-Policy` : le `Referer` y survit, ce qui montre que la sonde en voit un
   quand il y en a un. **Mesuré sous Chromium 141 seulement** — voir « Ce que cette décision ne
   prouve pas ».

2. **Aucune ligne de ce dépôt n'appelle la caméra, le micro ni la géolocalisation.** Vérifié par
   balayage de `public/`, `src/` et `apps/` sur `getUserMedia`, `mediaDevices`, `geolocation`,
   `clipboard`, `requestFullscreen`, `AudioContext`, `getGamepads`, `navigator.serial`, `midi`,
   `Notification`, `requestPointerLock` : **zéro occurrence**. La coquille courtise le
   déverrouillage et le consentement de l'utilisateur ; elle ne capte rien.

3. **Refuser ces trois capacités ne retire rien au territoire applicatif encadré.** Leur liste
   d'autorisation par défaut est `self` : un cadre d'une **autre** origine, sans attribut `allow`,
   ne les obtient déjà pas. La `Permissions-Policy` de la coquille ne fait donc que rendre explicite
   et non-réoctroyable ce qui était implicite — c'est un durcissement, pas une amputation. La
   conséquence à écrire est l'autre moitié : une capacité refusée dans le conteneur **ne peut plus**
   être accordée au cadre par un `allow=` ; le jour où le produit voudrait en accorder une, il
   faudra rouvrir cet ADR.

4. **`Strict-Transport-Security` est inerte partout où ce dépôt sait mesurer.** Le serveur de test
   sert en `http:` (4173/4174), le témoin d'en-têtes aussi (4193/4194/4195), et RFC 6797 § 7.2 exige
   du navigateur qu'il **ignore** un en-tête STS reçu sur un transport non sécurisé. Le poser dans
   la source de vérité y mettrait une politique dont l'effet ne serait vérifiable par aucune épreuve
   de ce dépôt — une promesse non mesurée, ce que `docs/vision.md` refuse.

## Décision

### 1. `Referrer-Policy: no-referrer` sur les documents de la COQUILLE

La coquille n'a aucune raison de faire connaître son URL à qui que ce soit. Le cas qui compte n'est
pas hypothétique : sous la politique par défaut des moteurs, le chargement du cadre applicatif porte
l'origine de la coquille jusqu'à une origine dont le contenu vient du guest (fait 1). `no-referrer`
est retenu plutôt que `same-origin` ou `strict-origin-when-cross-origin` parce que la coquille
n'émet **aucune** requête qui aurait besoin d'un référent : elle ne parle qu'à elle-même
(`connect-src 'self'`) et au cadre qu'elle encadre.

### 2. `Referrer-Policy` est ÉCARTÉ sur l'origine applicative, et c'est une décision

Deux motifs, dont le second suffirait seul :

- il gouverne ce que le document **émet** — donc le contenu rendu par le guest. Une application
  Rails s'appuie sur `Referer` (`redirect_back`, navigations Turbo) ; lui imposer `no-referrer`
  serait décider à sa place, ce que l'ADR 0002 s'interdit ;
- **il n'y protégerait rien de nôtre.** Le référent qu'émet le document applicatif est le sien, pas
  celui de la coquille : l'URL de la coquille ne voyage jamais par ce canal-là. La fuite qui
  existait était gouvernée par la politique de la coquille, et elle est fermée par la décision 1.

Servir la valeur par défaut des moteurs « pour la figer » a été envisagé et écarté : ce serait
inscrire dans la source de vérité une politique dont l'effet est nul aujourd'hui et qui deviendrait
un **assouplissement** le jour où un moteur durcirait son défaut.

### 3. `Permissions-Policy: camera=(), microphone=(), geolocation=()` sur la coquille

Trois refus nommés un par un, liste d'autorisation **vide** — `()` ne désigne personne, pas même
`self`.

**Ce qui n'est pas retenu importe autant.** Un refus en bloc (`*=()`, ou une liste recopiée d'un
guide de durcissement) fermerait des capacités que ce dépôt n'a jamais mesurées et dont le runtime
pourrait avoir besoin : plein écran de la console VM, presse-papiers vers le guest, sortie audio de
v86. Le risque de cet en-tête n'est pas d'en refuser trop peu, c'est d'en refuser trop — et de le
découvrir par une panne silencieuse dans le guest. La liste est donc un **cliquet** mesuré
(`tests/unit/entetes-de-durcissement.test.mjs`) : l'élargir fait échouer `npm run check` tant qu'un
ADR ne l'a pas décidé, et une épreuve refuse explicitement le joker et les quatre capacités
ci-dessus.

### 4. `Permissions-Policy` est ÉCARTÉ sur l'origine applicative

Même motif que la décision 2, premier tiret : elle gouverne ce que le document **peut**, donc le
contenu du guest. Une application Rails qui voudrait légitimement la géolocalisation n'a pas à en
être privée par une politique décidée dans le dépôt de la coquille.

### 5. Ces politiques s'arrêtent aux documents de la COQUILLE

`isShellDocument()` nomme une fois la condition que la CSP portait déjà : ni **territoire
applicatif** (`/spike/origin/app…`), ni **sonde de capacités** (`/compat…`). Les deux exemptions ont
chacune leur raison, et les deux valent mot pour mot pour les politiques ajoutées ici : le premier
est du contenu de guest, la seconde mesure ce que le moteur sait faire et rendrait « capacité
absente » pour un navigateur qui la possède si notre politique la lui refusait. Regrouper la
condition évite qu'une troisième politique soit posée demain sur le territoire du guest par simple
oubli d'un `&&`.

### 6. `Strict-Transport-Security` est ÉCARTÉ du code, et devient une obligation d'exploitant

C'est la décision la moins intuitive de cet ADR, et elle a trois motifs :

1. **Il serait inerte partout où ce dépôt mesure** (fait 4). Une politique que ni le serveur de
   test, ni le témoin d'en-têtes ne peuvent éprouver n'a rien à faire dans la source de vérité :
   elle y serait une chaîne de caractères comparée à elle-même.
2. **Il engage un DOMAINE, pas une arborescence.** `max-age` lie les visiteurs pour des mois, et
   `includeSubDomains` posé sur le domaine parent d'un déploiement à domaine propre lierait
   **aussi** le sous-domaine applicatif — le fait 2 de l'ADR 0017 rappelle que les deux origines y
   sont le même site. La coquille imposerait alors une politique de transport au territoire
   applicatif : la ligne de l'ADR 0002, une fois de plus. Le rendre par rôle depuis un module qui
   ignore le domaine réel n'est pas possible sans deviner.
3. **Ce que #45 a relevé ne dit pas ce qu'on croit.** Le spike a observé que Netlify, Cloudflare et
   Vercel servent HSTS ; c'est un relevé sur des **sites tiers**, et le risque résiduel n°4 de l'ADR
   0017 le qualifie déjà : la présence ou l'absence d'un en-tête y prouve le choix de leur
   propriétaire, pas la capacité de l'hébergeur. **Aucun hébergement n'a été mesuré par #104.**

La conséquence n'est pas « HSTS n'est pas souhaitable » — il l'est. C'est qu'il appartient à la
**mise en service**, et il est donc écrit comme obligation d'exploitant dans
[`docs/release-policy.md`](../release-policy.md), avec la valeur recommandée et l'avertissement sur
`includeSubDomains` et `preload`.

**L'absence est gardée, des deux côtés.** Une décision d'écarter que rien ne relève redevient un
oubli : `securityHeaders()` est éprouvé sans HSTS sur les deux rôles et les trois natures de chemin,
la publication l'est sur les deux arbres, et `tools/publier-temoin.mjs` le cherche dans ce qui est
**réellement servi** par les deux origines de l'artefact.

### 7. Ce que la publication et le témoin en font

`tools/publier-en-tetes.mjs` n'est pas touché : la table `EN_TETES_AJOUTES_PAR_LA_PUBLICATION` garde
ses **deux** entrées, et une épreuve exige que ni `Referrer-Policy` ni `Permissions-Policy` n'y
figure — ils viennent de la source de vérité, pas de la publication. `tools/publier-temoin.mjs`
relève désormais les deux moitiés de la décision sur les deux origines : les valeurs servies à la
coquille par comparaison littérale, et l'absence décidée sur l'origine applicative par
`confronterAbsences`.

## Ce que cette décision ne prouve pas

- **L'effet de `Referrer-Policy` n'est mesuré que sous Chromium 141.** Firefox et WebKit n'étaient
  pas installables dans l'environnement où #104 a été conduit (politique réseau bloquant le CDN de
  Playwright) : l'épreuve est écrite pour les trois et rattachée aux projets par défaut de
  `playwright.config.mjs`, mais seul Chromium l'a exécutée ici, et sous la version 141 au lieu de la
  151 de la matrice. **Non exécuté : moteur indisponible.** La CI du dépôt installe les trois.
- **L'effet de `Permissions-Policy` n'est mesuré nulle part.** Ce qui est éprouvé est qu'elle est
  **servie**, sur la bonne origine et avec la bonne valeur — pas qu'un moteur refuse effectivement
  `getUserMedia` sous elle. Une sonde honnête demanderait un témoin négatif que le sans-tête ne
  fournit pas : caméra et micro échouent de toute façon dans ce contexte, et une sonde qui verrait «
  refusé » des deux côtés ne prouverait rien. `document.featurePolicy` n'existe que sur un moteur.
  C'est du **travail découvert**, suivi par **#126**, pas une propriété acquise. Ce que #126 vise en
  premier n'est d'ailleurs pas « la caméra est refusée à la coquille » — la coquille n'appelle rien,
  et un balayage le vérifie — mais le risque résiduel n°1 ci-dessous : la non-réoctroyabilité par
  `allow=` au cadre applicatif, qui n'est aujourd'hui qu'une lecture de la spécification.
- **Le balayage du fait 2 porte sur le dépôt, pas sur le v86 épinglé.** `vendor/v86/artefacts/`
  n'est pas versionné et était absent ici : `libv86.mjs` n'a pas été relu à la recherche d'API de
  capture. L'ADR 0010 l'a inspecté pour `SharedArrayBuffer`, pas pour celles-ci. Ce que #104 a
  vérifié à la place est plus faible et plus direct : sous les nouveaux en-têtes, la coquille
  publiée démarre et son Worker s'annonce (`worker:ready`, témoin d'en-têtes). Les bancs de boot
  complet (`npm run test:vm`) exigent Docker et les artefacts, hors de portée de cette tranche.
- **Aucun hébergement n'a été mesuré.** Voir décision 6, motif 3.

## Risques résiduels

1. **La `Permissions-Policy` de la coquille ferme une porte qu'un `allow=` ne rouvrira plus** (fait
   3). Aucune capacité n'est perdue aujourd'hui ; le jour où le produit voudra accorder l'une des
   trois au cadre applicatif, il faudra rouvrir cet ADR plutôt que poser un `allow=` qui resterait
   sans effet — et le mode de panne serait silencieux. Cette phrase est une lecture de la
   spécification, non une mesure : **#126** porte le protocole qui la vérifierait, témoin positif
   compris.
2. **Le durcissement générique s'arrête à trois en-têtes.** `X-Frame-Options` (redondant avec
   `frame-ancestors`), `Cross-Origin-Embedder-Policy` (écarté sur mesure par l'ADR 0010, hors
   périmètre de #104) et `Clear-Site-Data` ne sont pas examinés ici.
3. **HSTS dépend d'un humain.** Une obligation écrite dans `docs/release-policy.md` n'est pas un
   cliquet : rien dans la chaîne ne peut vérifier une propriété d'un domaine qui n'existe pas
   encore. Le jour où une origine réelle est servie, une sonde d'hébergement pourrait la relever —
   c'est du travail découvert.
4. **L'effet de `Permissions-Policy` reste non mesuré** (voir ci-dessus).

## Conditions de réouverture

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- le produit acquiert un besoin de caméra, de micro ou de géolocalisation — dans la coquille ou dans
  le cadre applicatif, la seconde étant fermée par la première (fait 3) ;
- le produit acquiert un besoin de référent sortant depuis la coquille — un lien externe dont la
  cible aurait besoin de savoir d'où vient le visiteur ;
- une origine réelle est mise en service, ce qui rend HSTS mesurable : la décision 6 devra alors
  dire si l'en-tête revient dans la chaîne, et sous quelle forme, plutôt que rester une consigne ;
- un moteur de la matrice cible n'applique pas `no-referrer` comme mesuré, ou applique
  `Permissions-Policy` d'une façon qui casse un usage du runtime.

## Alternatives rejetées

| Alternative                                                        | Pourquoi elle est écartée                                                                                                                                                                   |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Ajouter les trois en-têtes à `EN_TETES_AJOUTES_PAR_LA_PUBLICATION` | Ils seraient servis en production sans l'être en développement : la divergence exacte que l'ADR 0017 § 2 interdit, et les épreuves de frontière deviendraient muettes sur ce qui est publié |
| Une valeur unique de `Referrer-Policy` pour les deux origines      | Confort de rédaction, pas décision : elle imposerait au territoire du guest une politique de son propre contenu (ADR 0002)                                                                  |
| `Permissions-Policy: *=()` sur la coquille                         | Refuserait des capacités que personne n'a mesurées ; la panne serait silencieuse et dans le guest                                                                                           |
| Servir `Strict-Transport-Security` quand même                      | Inerte sur `http:` (RFC 6797 § 7.2), donc non mesurable ici ; et il engage un domaine, y compris le sous-domaine applicatif, ce que ce module ne peut pas décider                           |
| Figer la valeur par défaut des moteurs sur l'origine applicative   | Sans effet aujourd'hui, et assouplissement le jour où un moteur durcirait son défaut                                                                                                        |
