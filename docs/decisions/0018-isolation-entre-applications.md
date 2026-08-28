# ADR 0018 — Le navigateur ne cloisonne que par origine : une origine par application, et le MVP reste mono-application

- Statut : accepté
- Date : 2026-08-28
- Issue : #46 · Invariant : `SEC-ORIGIN-001` · Jalon 5

## Contexte

L'[ADR 0002](0002-topologie-origine-de-confiance.md) a fait de la frontière coquille / application
une frontière d'**origine**, et a laissé un risque résiduel n°1 :

> **Une seule origine applicative pour toutes les applications.** Deux applications Rails publiées
> sur la même origine se lisent mutuellement OPFS, IndexedDB et cookies. Une origine par
> application, ou un partitionnement explicite, reste à décider — travail découvert, suivi par #46.

Trois options étaient ouvertes :

- **(a) une origine par application** — un sous-domaine par application, que l'ADR 0017 rend
  possible en exigeant déjà un domaine propre chez un hébergeur capable d'en-têtes ;
- **(b) un partitionnement explicite dans une même origine** — préfixe de chemin, portée de Service
  Worker, convention de nommage OPFS et IndexedDB ;
- **(c) accepter la limite pour le MVP**, qui ne publie qu'une application.

L'[ADR 0017](0017-chaine-de-publication.md) a par ailleurs établi un fait qui pèse ici : sur un
domaine propre, `vault.exemple` et `app.vault.exemple` sont deux **origines** mais le **même site**,
et les cookies ne sont donc **pas** cloisonnés entre elles. Elle en a tiré une règle réservée à #24
: « aucun cookie de la coquille n'est posé sur le domaine parent ».

## Ce que l'expérience a établi

Protocole, environnement, commandes et mesures brutes :
[`docs/spikes/0046-isolation-entre-applications.md`](../spikes/0046-isolation-entre-applications.md).
Dix-sept sondes, trois topologies, trois moteurs (Chromium 151, Firefox 153, WebKit 26.5). Les faits
qui portent la décision :

1. **Un préfixe de chemin ne cloisonne aucun stockage.** Sur une même origine, l'application B lit
   le secret de A dans l'OPFS, IndexedDB, `localStorage`, `Cache Storage` ; elle voit le verrou
   d'écrivain que A tient, capte ses diffusions, énumère ses bases, ses caches et ses inscriptions
   de Service Worker. Quatorze sondes sur dix-sept aboutissent, à l'identique sur les trois moteurs.

2. **La convention de nommage n'y change rien, et c'est ce qui condamne l'option (b).** Le
   répertoire OPFS `app-a/` et la base `vault-app-a` sont ouverts par B d'un simple
   `getDirectoryHandle("app-a")`. Un préfixe est une convention que le code coopératif respecte ; un
   script hostile — ou bogué — l'ignore, et rien dans le navigateur ne le lui interdit.

3. **Lire n'est pas le pire.** `removeEntry(…, { recursive: true })` efface le répertoire de A, et
   `registration.unregister()` retire son Service Worker, donc son mode hors ligne. Les deux
   aboutissent, sur les trois moteurs.

4. **Le seul mécanisme borné par chemin est la portée d'un Service Worker, et elle ne borne que le
   réseau.** B ne peut pas inscrire son script sur la portée de A — refus `SecurityError` sur les
   trois moteurs — et les requêtes de B ne sont pas interceptées par le Service Worker de A. Mais B
   **énumère** et **désinscrit** celui de A : l'inscription appartient à l'origine, pas au chemin.
   L'attribut `Path` d'un cookie ne vaut pas mieux : il retient le cookie hors du répertoire de B,
   et un simple cadre de même origine ouvert sur un document du répertoire de A le rend de nouveau
   lisible — mesuré, sur les trois moteurs.

5. **Une origine par application ferme tout.** Sur deux hôtes distincts, **aucune** des dix-sept
   sondes n'aboutit, sur les trois moteurs.

6. **Le port fait partie de l'origine et ne fait pas partie du bocal de cookies.** Sur deux origines
   qui ne diffèrent que par le port, tout est refusé **sauf** le cookie posé avec `Path=/`. La voie
   la moins chère vers « une origine par application » isolerait donc tout sauf la session Rails.

7. **La coquille ne distingue pas deux applications de la même origine.** `evaluateAppHello()` admet
   sur trois critères — type, **origine**, fenêtre émettrice — dont aucun ne porte d'identité
   d'application. La coquille encadre tour à tour `app-a/` et `app-b/` servis par la même origine :
   les deux obtiennent le port restreint, sans un seul refus journalisé. La liste d'admission est
   **par origine, jamais par application**.

8. **Ajouter une origine applicative oblige à republier la COQUILLE.**
   `shellContentSecurityPolicy()` rend `frame-src 'self' <UNE origine applicative>` et
   `tools/publier.mjs` n'accepte qu'un seul `--origine-application`. Une coquille servie pour une
   origine qui tente d'en encadrer une autre produit une violation `frame-src` sur les trois
   moteurs.

## Décision

### 1. L'isolation entre applications est une frontière d'ORIGINE. L'option (b) est écartée

Le navigateur ne cloisonne le stockage que par origine. Aucun partitionnement par chemin, par nom de
répertoire OPFS, par nom de base IndexedDB ou par préfixe de clé n'est opposable à un script hostile
: ce sont des conventions, et le fait 2 les mesure inopérantes.

**L'option (b) est écartée**, et pas comme un compromis insuffisant : comme une non-frontière.
L'écrire dans la documentation reviendrait à publier une garantie que le code ne tient pas.

Le corollaire à écrire, parce qu'il est contre-intuitif : la portée d'un Service Worker **est**
bornée par le chemin (fait 4), et c'est la seule chose qui le soit. Cette borne est réelle, elle
protège l'interception réseau, et elle **ne protège aucun stockage**. Personne ne doit la citer
comme preuve qu'un préfixe de chemin isole.

### 2. Dès qu'il y a plus d'une application, chacune a son origine

C'est l'option (a), et c'est la seule isolation mesurée (fait 5). L'ADR 0017 la rend possible sans
travail supplémentaire de topologie : la chaîne de publication exige déjà un **domaine propre** chez
un hébergeur capable d'en-têtes, et un sous-domaine de plus par application y est un enregistrement
DNS et un arbre publié de plus.

Deux conséquences que cette décision fige :

- **le sous-domaine, pas le port.** Une seconde origine obtenue en changeant le port n'est pas
  admise : elle isolerait tout sauf les cookies (fait 6), c'est-à-dire tout sauf la session Rails.
  Le même raisonnement écarte les chemins d'un hôte unique ;
- **la coquille est republiée à chaque application ajoutée** (fait 8). `frame-src` doit nommer les
  origines applicatives. Un joker (`frame-src https://*.app.exemple`) rendrait cette republication
  inutile, et cet ADR le **refuse** : il autoriserait à encadrer n'importe quel sous-domaine, y
  compris un sous-domaine non prévu, ce qui remplacerait une liste vérifiable par une famille.

### 3. Pour le MVP, l'option (c) est acceptée EXPLICITEMENT — une seule application

Vault ne publie aujourd'hui qu'une application ; `SOURCES_APPLICATION` est même une liste vide
(`tools/publier-arborescences.mjs`), l'arbre applicatif publié n'étant encore qu'une place tenante.
Avec une seule application, aucun des faits 1 à 4 n'a de victime : il n'y a personne à lire.

L'acceptation est explicite, datée et bornée. Elle ne dit pas « le risque est faible ». Elle dit **«
la condition d'exposition n'existe pas encore »**.

**Le signal qui impose la règle 2 : une seconde application publiée.** Il n'est pas graduel, il n'a
pas de seuil à interpréter, et il est observable dans la chaîne de publication elle-même — une
seconde entrée dans le catalogue d'applications de #45. À ce moment-là, et pas avant, chaque
application prend son sous-domaine.

### 4. Ce que la coquille devra apprendre en même temps

Le fait 7 dit que l'identité d'application n'existe pas aujourd'hui dans le contrat de la coquille.
Sous la règle 2, elle n'a plus besoin d'exister comme champ : **l'origine devient l'identité**. La
coquille encadre une origine applicative, en attend l'annonce, et n'a rien à distinguer de plus.

Cet ADR ne fige donc aucune notion d'« identifiant d'application » dans le protocole. Ce serait
inventer un critère dont la mesure vient de montrer qu'il ne sépare rien tant que l'origine ne
sépare pas — et qui deviendrait redondant dès qu'elle sépare.

### 5. Ce que la contrainte de cookies impose à #24 — à écrire, pas à résoudre ici

L'ADR 0017 a établi que sur un domaine propre les deux origines de l'ADR 0002 sont le **même site**,
et que les cookies ne sont donc pas cloisonnés entre elles. La règle 2 multiplie les sous-domaines
et donc l'étendue de ce constat. Trois contraintes en découlent pour #24, énoncées ici comme
**contraintes**, et laissées à #24 :

| Contrainte                                                                                 | Motif                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Aucun cookie de la coquille sur le domaine parent**, et si possible aucun cookie du tout | un cookie posé sur `vault.exemple` avec `Domain=vault.exemple` est envoyé à `a.app.vault.exemple` comme à `b.app.vault.exemple`. C'est déjà la règle de l'ADR 0017 ; la règle 2 en fait une règle à N branches                  |
| **Préfixe `__Host-` pour tout cookie que la coquille poserait**                            | il interdit l'attribut `Domain` et impose `Path=/` et `Secure` : le cookie reste attaché à l'hôte exact qui l'a posé. C'est le seul mécanisme qui rend l'absence de partage vérifiable côté navigateur plutôt que par relecture |
| **`SameSite` ne sépare pas deux sous-domaines d'un même site**                             | mesuré au spike #45 (fait 2) : `SameSite` gouverne le contexte de première partie, pas la relation entre sous-domaines. Ne pas le compter comme une frontière                                                                   |

La question de fond — le contrat coquille ↔ application a-t-il besoin de cookies ? — reste ouverte,
et l'ADR 0002 l'avait explicitement réservée à #24 (« l'allocation des cookies et du bocal de
session entre les deux origines »). Cet ADR ne la tranche pas ; il dit ce que la réponse devra
respecter.

## Matrice de décision

| Critère                           | (a) une origine par application                                                                                      | (b) partitionnement dans une origine                                                 | **(c) MVP mono-application (retenue aujourd'hui)**               |
| --------------------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| Sécurité mesurée                  | **0 sonde sur 17 aboutit**                                                                                           | **14 sur 17 aboutissent** — dont l'effacement des données et la désinscription du SW | sans objet : une seule application, donc aucune victime          |
| Ce que la borne de chemin apporte | —                                                                                                                    | la portée d'un Service Worker et l'attribut `Path`, contournable par cadre imbriqué  | —                                                                |
| Coût d'hébergement                | un sous-domaine, un enregistrement DNS, un certificat et un arbre publié **par application**                         | nul                                                                                  | nul                                                              |
| Coût sur la coquille              | `frame-src` énumère les origines ; **republication de la coquille** à chaque ajout                                   | nul                                                                                  | nul                                                              |
| Ergonomie utilisateur             | une URL par application, lisible                                                                                     | une seule URL                                                                        | une seule URL                                                    |
| Mode hors ligne                   | un Service Worker par application, indépendants                                                                      | portées voisines sur une même origine, désinscriptibles l'une par l'autre            | un seul Service Worker                                           |
| Vérifiabilité                     | `tests/browser/apps-frontiere.spec.mjs`, trois moteurs                                                               | rien à vérifier : il n'y a pas de frontière à éprouver                               | la même épreuve garde le témoin négatif vivant                   |
| Réversibilité                     | un changement d'origine rend l'OPFS de l'ancienne inatteignable (ADR 0002) : c'est une migration, pas un déploiement | —                                                                                    | passer à (a) est une migration pour l'application déjà installée |

Motif factuel d'élimination :

- **(b)** — mesurée inopérante. Ce n'est pas une frontière faible, c'est une convention. Quatorze
  sondes sur dix-sept la traversent, y compris la destruction de données.
- **(a) tout de suite** — écartée comme **prématurée**, pas comme mauvaise : elle coûte un
  sous-domaine, un certificat, un arbre publié et une republication de la coquille par application,
  pour protéger d'une application qui n'existe pas. Elle devient la règle au signal de la § 3.
- **une origine par PORT** — écartée sur mesure : elle laisse passer les cookies (fait 6).

## Risques résiduels

1. **Le signal peut être franchi sans être vu.** « Une seconde application publiée » est un fait de
   la chaîne de publication ; rien dans l'outillage ne l'oppose aujourd'hui. `SOURCES_APPLICATION`
   étant une liste vide, une seconde application ne peut pas encore y apparaître — mais le jour où
   #45 la peuplera, une garde y sera nécessaire. **Travail découvert, non traité ici.**
2. **La règle 2 ne protège pas de deux applications servies par la même origine par erreur.** Elle
   est une règle de publication, pas un contrôle du navigateur. La seule preuve reste
   `tests/browser/apps-frontiere.spec.mjs`, qui mesure la propriété, non son application au produit.
3. **Le WebKit mesuré n'expose pas l'OPFS.** Trois sondes y sont `indisponible`. La frontière
   d'origine y est confirmée sur les quatorze autres, mais le mécanisme le plus lourd du produit n'y
   est pas éprouvé. Il s'agit du WebKit de Playwright, pas de Safari (#2).
4. **Les sous-domaines ne sont pas mesurés directement.** Le spike les modélise par deux hôtes de
   bouclage. Le fait de cookies qui les distingue vient du spike #45, pas de #46.
5. **Le partitionnement de stockage par site tiers ne sépare pas A de B.** Les deux applications
   sont encadrées par la MÊME coquille : le site de premier niveau est identique, donc la partition
   l'est aussi. Aucune protection à en attendre.

## Conditions de réouverture

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- **une seconde application est publiée** — c'est le signal de la § 3, et il fait passer la règle 2
  de « règle applicable » à « règle appliquée » sans nouvel ADR ; l'ADR n'est rouvert que si la § 2
  s'avère impraticable dans la chaîne de #45 ;
- un moteur de la matrice cible cloisonne le stockage par un autre critère que l'origine, rendant
  l'option (b) mesurable — la réouverture exige alors un relevé, pas une annonce de plateforme ;
- une exigence produit impose deux applications sur une origine unique et sans isolation possible :
  il faudrait alors décider si la coquille refuse de les servir, plutôt que promettre une frontière
  absente ;
- l'ADR 0017 change d'hébergement pour un service incapable de sous-domaines, ce qui rendrait la
  règle 2 inapplicable et exigerait un nouvel arbitrage entre (a) et un refus de publier plus d'une
  application.

## Alternatives rejetées

- **Convention de nommage OPFS et IndexedDB** (`app-a/`, `vault-app-a`) : mesurée traversée. Elle
  reste utile comme **hygiène** — elle rend lisible à qui appartient quoi — jamais comme frontière.
- **Attribut `Path` des cookies** : retient un cookie hors d'un répertoire, et le rend de nouveau
  lisible dès qu'un cadre de même origine est ouvert sur ce répertoire. Mesuré.
- **Portée de Service Worker comme frontière** : borne réelle mais bornée au réseau, et contournable
  par la désinscription, mesurée aboutie.
- **Identifiant d'application dans le contrat de la coquille** : inventerait un critère que la
  coquille ne peut pas vérifier. Deux documents d'une même origine peuvent revendiquer le même
  identifiant ; l'origine est le seul discriminant que le navigateur atteste.
- **`frame-src` avec joker de sous-domaine** : remplacerait une liste vérifiable d'origines par une
  famille, y compris ses membres non prévus.
- **Une origine applicative par PORT** : mesurée perméable aux cookies.
