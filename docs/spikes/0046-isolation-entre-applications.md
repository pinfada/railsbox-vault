# Spike #46 — protocole et mesures : isolation entre applications partageant l'origine applicative

Ce document est le compte rendu d'expérience du spike #46. La décision qu'il porte est dans
l'[ADR 0018](../decisions/0018-isolation-entre-applications.md) ; ici ne figurent que la question,
l'environnement, les commandes, les résultats bruts et leur lecture.

## Question

L'[ADR 0002](../decisions/0002-topologie-origine-de-confiance.md) fait vivre le document applicatif
sur une origine distincte de la coquille, et laisse un risque résiduel n°1 : « deux applications
Rails publiées sur la même origine se lisent mutuellement OPFS, IndexedDB et cookies ».
L'affirmation est plausible, elle n'avait jamais été mesurée, et elle ne disait rien de plusieurs
mécanismes que le produit utilise déjà — Web Locks, `BroadcastChannel`, `Cache Storage` — ni de ce
qu'une application hostile peut **détruire** plutôt que lire.

Trois options étaient ouvertes : **(a)** une origine par application, **(b)** un partitionnement
explicite dans une même origine — préfixe de chemin, portée de Service Worker, convention de nommage
OPFS et IndexedDB —, **(c)** accepter la limite pour le MVP mono-application.

La question à trancher par la mesure est celle-ci. **Le navigateur cloisonne-t-il quoi que ce soit
par chemin ?**

## Environnement

| Élément                        | Valeur                                      |
| ------------------------------ | ------------------------------------------- |
| Système                        | Windows 11 Famille 10.0.26200, x64          |
| Node                           | 24.14.0 (dépôt : `engines >=22.13 <25`)     |
| Playwright                     | 1.62.1                                      |
| Chromium                       | 151.0.7922.34                               |
| Firefox                        | 153.0                                       |
| WebKit                         | 26.5 (build Windows Playwright, pas Safari) |
| Origine coquille               | `http://127.0.0.1:4173`                     |
| Origine applicative (app A)    | `http://localhost:4174`                     |
| Seconde origine, hôte distinct | `http://127.0.0.2:4175`                     |
| Seconde origine, port distinct | `http://localhost:4176`                     |

`127.0.0.2` appartient à `127.0.0.0/8` : les trois moteurs le traitent comme contexte sécurisé, et
l'OPFS comme les Service Workers y restent disponibles. Le relevé le confirme — l'application A y
dépose son état sans erreur.

Le WebKit livré par Playwright sous Windows n'est pas Safari : l'absence d'OPFS relevée plus bas lui
est propre et ne vaut pas pour la matrice produit, qui reste l'objet de l'issue #2. Elle est
d'ailleurs identique à celle qu'avait relevée le spike #35.

## Montage

Le harnais du spike #35 est **réemployé**, jamais dupliqué : mêmes serveurs, même notion de
territoire applicatif, même coquille.

```text
tools/serve.mjs --role shell --host 127.0.0.1 --port 4173    coquille, CSP stricte
tools/serve.mjs --role app   --host localhost  --port 4174   application A
tools/serve.mjs --role app   --host 127.0.0.2  --port 4175   application B, hôte distinct
tools/serve.mjs --role app   --host localhost  --port 4176   application B, port distinct

public/spike/origin/apps-topologie.mjs        contrat : origines, topologies, actifs de A
public/spike/origin/app-inter.mjs             module de sondes partagé par les deux applications
public/spike/origin/app-a/index.html          document de l'application A
public/spike/origin/app-a/vide.html           document du répertoire de A, sans script
public/spike/origin/app-a/app-a-sw.mjs        Service Worker de A, portée /spike/origin/app-a/
public/spike/origin/app-a/canary.txt          ressource témoin de A
public/spike/origin/app-b/index.html          document de l'application B
public/spike/origin/app-b/app-b-sw.mjs        Service Worker de B, candidat à la portée de A
tests/browser/apps-frontiere.spec.mjs         épreuves, trois moteurs
```

Les deux répertoires commencent par `/spike/origin/app` : ils sont donc servis **comme territoire
applicatif**, sans CSP, exactement comme le HTML rendu par un guest. Les deux documents chargent le
même module ; c'est le paramètre `?phase=` qui décide de ce qu'ils font.

### Trois précautions rendent le relevé opposable

1. **Témoin négatif.** La topologie « même origine, préfixes de chemin » fait l'objet d'une épreuve
   qui exige que les lectures croisées **aboutissent**. Sans elle, les colonnes vides des autres
   topologies ne prouveraient que des sondes cassées. La table d'attentes est explicite dans le
   fichier d'épreuve : chaque sonde y a un résultat attendu, et un écart dans **les deux sens** fait
   échouer la mesure.
2. **L'application A reste vivante.** Un verrou Web Locks se relâche avec le contexte qui le tient,
   et une diffusion n'existe que pendant qu'elle est émise. La page de A est donc laissée ouverte
   pendant que B sonde ; la fermer aurait fabriqué deux « invisible » gratuits.
3. **`indisponible` est un troisième résultat.** Une capacité absente du moteur n'est pas une
   frontière. WebKit n'expose pas `navigator.storage.getDirectory` : ses trois sondes OPFS sont des
   **trous dans la mesure**, pas des refus, et la comparaison les laisse passer sans les compter.

### Un piège de méthode, rencontré puis corrigé

La première version plaçait la sonde `indexeddb-enumeration` **après** `indexeddb-base-de-a`. Or
ouvrir une base absente la **crée**. Sur deux origines pourtant séparées, l'énumération trouvait
donc `vault-app-a` — la base que la sonde précédente venait de fabriquer — et l'épreuve concluait à
une lecture croisée. Deux corrections : l'énumération passe **avant** l'ouverture, et l'ouverture
efface la base qu'elle a créée. Sans le témoin négatif et sans une attente déclarée sonde par sonde,
ce faux positif serait passé pour une mesure.

## Commandes

```sh
npm ci
npx playwright install --with-deps chromium firefox webkit
npm run test:spike:apps      # les 18 épreuves seules, trois moteurs
npm run check                # les mêmes, dans la suite complète
```

## Relevé — dix-sept sondes, trois topologies, trois moteurs

`R` : la lecture (ou la destruction) **aboutit**. `B` : elle est refusée ou ne trouve rien. `I` : le
moteur ne fournit pas la capacité. Les trois colonnes de chaque topologie sont, dans l'ordre,
Chromium 151, Firefox 153, WebKit 26.5.

| Sonde                                 | Mécanisme        | même origine<br>préfixe de chemin | origines<br>port distinct | origines<br>hôte distinct |
| ------------------------------------- | ---------------- | :-------------------------------: | :-----------------------: | :-----------------------: |
| `opfs-fichier-de-a`                   | OPFS             |             R R **I**             |         B B **I**         |         B B **I**         |
| `opfs-repertoire-prefixe-de-a`        | OPFS             |             R R **I**             |         B B **I**         |         B B **I**         |
| `opfs-destruction-des-donnees-de-a`   | OPFS             |             R R **I**             |         B B **I**         |         B B **I**         |
| `indexeddb-enumeration`               | IndexedDB        |               R R R               |           B B B           |           B B B           |
| `indexeddb-base-de-a`                 | IndexedDB        |               R R R               |           B B B           |           B B B           |
| `localstorage-de-a`                   | localStorage     |               R R R               |           B B B           |           B B B           |
| `cookie-global-de-a`                  | cookies          |               R R R               |         **R R R**         |           B B B           |
| `cookie-de-chemin-de-a`               | cookies          |               B B B               |           B B B           |           B B B           |
| `cookie-de-chemin-par-cadre-imbrique` | cookies          |             **R R R**             |           B B B           |           B B B           |
| `verrou-de-a`                         | Web Locks        |               R R R               |           B B B           |           B B B           |
| `diffusion-de-a`                      | BroadcastChannel |               R R R               |           B B B           |           B B B           |
| `cache-storage-enumeration`           | Cache Storage    |               R R R               |           B B B           |           B B B           |
| `cache-storage-lecture-de-a`          | Cache Storage    |               R R R               |           B B B           |           B B B           |
| `service-worker-enumeration-de-a`     | Service Worker   |               R R R               |           B B B           |           B B B           |
| `service-worker-portee-de-a-reclamee` | Service Worker   |               B B B               |           B B B           |           B B B           |
| `canary-de-a-intercepte`              | Service Worker   |               B B B               |           B B B           |           B B B           |
| `service-worker-desinscription-de-a`  | Service Worker   |               R R R               |           B B B           |           B B B           |

Le dépôt de l'application A est vérifié à chaque exécution, pour que « rien n'est lu » ne se
confonde jamais avec « rien n'avait été écrit » :

```json
{
  "opfs": "depose",
  "indexedDb": "depose",
  "cacheStorage": "depose",
  "serviceWorker": "portee http://localhost:4174/spike/origin/app-a/",
  "verrou": "tenu",
  "localStorage": "depose",
  "cookies": "vault_app_a_chemin=secret-application-a; vault_app_a_global=secret-application-a",
  "diffusion": "emise"
}
```

Sous WebKit, la seule ligne qui change est
`"opfs": "indisponible: navigator.storage.getDirectory absent"`.

## Lecture des résultats

### 1. Un préfixe de chemin ne cloisonne aucun stockage

**Quatorze** sondes sur dix-sept aboutissent en même origine sous Chromium et Firefox, et onze sur
les quatorze mesurables sous WebKit — c'est-à-dire les mêmes, moins les trois que ce moteur ne peut
pas exécuter. L'application B lit le secret de A dans l'OPFS, dans IndexedDB, dans `localStorage`,
dans `Cache Storage` ; elle voit le verrou d'écrivain que A tient et capte ses diffusions ; elle
énumère ses bases, ses caches et ses inscriptions de Service Worker.

La convention de nommage — un répertoire OPFS `app-a/`, une base `vault-app-a` — n'y change rien, et
c'est le point qui condamne l'option (b) : `opfs-repertoire-prefixe-de-a` **aboutit**. Un préfixe
est une convention que le code coopératif respecte ; un script hostile appelle
`getDirectoryHandle("app-a")` et l'ouvre. Rien dans le navigateur ne le lui interdit.

### 2. Lire n'est pas le pire

`opfs-destruction-des-donnees-de-a` aboutit : `removeEntry(…, { recursive: true })` efface le
répertoire de A, et `service-worker-desinscription-de-a` aboutit également — B retire l'inscription
de A, donc son mode hors ligne. Une seconde application n'a pas besoin d'être curieuse pour être
dangereuse ; il lui suffit d'être boguée. Une convention de nommage ne protège pas davantage d'un
`removeEntry` fautif que d'un `removeEntry` malveillant.

### 3. Ce que le chemin borne réellement — trois exceptions, et ce qu'elles valent

Trois sondes rendent `B` en même origine. Aucune n'est une frontière d'application, et il faut dire
précisément pourquoi.

| Sonde                                 | Ce qui la refuse                                                                                  | Ce que cela vaut                                                                                                                         |
| ------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `cookie-de-chemin-de-a`               | l'attribut `Path` du cookie                                                                       | **rien** : `cookie-de-chemin-par-cadre-imbrique` **aboutit** — B ouvre un cadre de même origine sur `app-a/vide.html` et relit le cookie |
| `service-worker-portee-de-a-reclamee` | la portée maximale d'un script est son répertoire, et `Service-Worker-Allowed` n'est jamais servi | un vrai refus **du côté réseau**, mais il n'empêche ni l'énumération ni la désinscription, toutes deux mesurées `R`                      |
| `canary-de-a-intercepte`              | un document de B n'est contrôlé par aucun Service Worker de A                                     | un vrai cloisonnement de l'**interception**, borné au réseau ; il ne touche à aucun stockage                                             |

Les trois moteurs opposent le même refus de portée, avec trois formulations :

```text
chromium  SecurityError: … The path of the provided scope ('/spike/origin/app-a/') is not under
          the max scope allowed ('/spike/origin/app-b/'). …
firefox   SecurityError: The operation is insecure.
webkit    SecurityError: Scope URL should start with the given script URL
```

Le témoin de portée le confirme dans l'autre sens : après l'inscription de A, un client neuf reçoit
`canary-intercepte-par-app-a` sous `/spike/origin/app-a/canary.txt` et `canary-authentique` sous
`/spike/origin/app-b/canary.txt`. **La portée d'un Service Worker est le seul mécanisme du
navigateur borné par chemin** — et elle ne borne que ce qui passe par le réseau.

### 4. Une origine par application ferme tout — mais le port ne ferme pas les cookies

Sur deux hôtes distincts, **aucune** des dix-sept sondes n'aboutit, sur les trois moteurs. C'est
l'option (a), et c'est la seule qui referme la liste.

Sur deux origines qui ne diffèrent que par le **port**, une seule sonde aboutit —
`cookie-global-de-a` — toutes les autres étant refusées, ou indisponibles sous WebKit pour les trois
sondes OPFS. C'est attendu de la spécification, et ce n'était pas vérifié : **le port fait partie de
l'origine et ne fait pas partie du bocal de cookies.** Une « origine par application » obtenue par
le port seul — la voie la moins chère, sans DNS ni certificat — isolerait donc tout **sauf la
session Rails**. Le fait est mesuré sur les trois moteurs.

### 5. La coquille ne distingue pas deux applications de la même origine

`evaluateAppHello()` (spike #35) admet une annonce sur trois critères : le type du message,
l'**origine** émettrice, et l'identité de la **fenêtre** émettrice. Aucun des trois ne porte
d'identité d'application.

La mesure : la coquille encadre tour à tour `app-a/` puis `app-b/`, servis par la même origine
applicative. Les deux obtiennent le port restreint, sur les trois moteurs, sans un seul refus
journalisé, et les deux rapports portent la même `origineAttendue`.

```json
{ "application": "a", "portRestreintObtenu": true, "origine": "http://localhost:4174" }
{ "application": "b", "portRestreintObtenu": true, "origine": "http://localhost:4174" }
```

La liste d'admission du port restreint est donc **par origine, jamais par application**. Tant qu'il
n'y a qu'une application, la question ne se pose pas ; dès qu'il y en a deux sur la même origine, la
coquille accorde la même capacité aux deux sans pouvoir les nommer.

### 6. Le coût d'une seconde origine applicative touche la CSP de la COQUILLE

`shellContentSecurityPolicy()` rend `frame-src 'self' <UNE origine applicative>`, et
`tools/publier.mjs` n'accepte qu'un seul `--origine-application`. Une coquille servie pour
`http://localhost:4174` qui tente d'encadrer `http://127.0.0.2:4175` produit, sur les trois moteurs
:

```json
[{ "directive": "frame-src", "ressource": "http://127.0.0.2:4175" }]
```

Ajouter une application sous l'option (a) n'est donc **pas** seulement publier un arbre de plus : la
CSP de la coquille change, et la coquille doit être republiée. C'est un couplage réel entre le
catalogue d'applications et la publication de la coquille, et l'ADR 0018 doit le nommer.

## Ce qui n'a pas été mesuré, et pourquoi

| Non mesuré                                                        | Motif                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Deux **sous-domaines** d'un domaine propre (`a.app.exemple`)      | exige DNS et certificats ; le spike les modélise par deux hôtes de bouclage. Le fait qui manque — les cookies **ne sont pas** cloisonnés entre sous-domaines d'un même site — est établi par le spike #45 (fait 2, Public Suffix List téléchargée) et repris ici sans être remesuré |
| Le **partitionnement de stockage par site tiers** des navigateurs | il partitionne le stockage d'une iframe par le site **de premier niveau** ; ici les deux applications sont encadrées par la MÊME coquille, donc dans la même partition. Il ne sépare pas A de B                                                                                     |
| Safari réel                                                       | le WebKit de Playwright n'est pas Safari (issue #2)                                                                                                                                                                                                                                 |
| Le comportement sous COOP/COEP                                    | l'ADR 0010 n'exige pas l'isolation ; la question de #46 ne dépend d'aucun en-tête d'isolation                                                                                                                                                                                       |
| Une application Rails **réelle** dans chaque partition            | les actifs déposés sont synthétiques. Ils modélisent ce qu'une session Rails pose ; ils ne mesurent pas le volume ni la durée de vie réels                                                                                                                                          |

## Coût d'exécution

Les dix-huit épreuves durent **32,8 s** de temps mural sur la machine de référence, trois moteurs
compris, trois workers en parallèle. Elles sont rattachées à `npm run check` malgré ce coût, pour la
raison qui vaut déjà pour la frontière de CSP : une frontière de sécurité que la suite par défaut ne
vérifie pas est une frontière que personne ne vérifie. `npm run test:spike:apps` les exécute seules.

## Reproduction manuelle

```sh
npm start                                                     # coquille 127.0.0.1:4173
node tools/serve.mjs --role app --host localhost --port 4174
node tools/serve.mjs --role app --host 127.0.0.2 --port 4175
```

- `http://localhost:4174/spike/origin/app-a/?app=a&phase=poser` — l'application A dépose ses actifs
  et garde son verrou ; laisser l'onglet ouvert ;
- `http://localhost:4174/spike/origin/app-b/?app=b&phase=lire&origineA=http://localhost:4174` — le
  relevé de l'application B en même origine ;
- `http://127.0.0.2:4175/spike/origin/app-b/?app=b&phase=lire&origineA=http://localhost:4174` — le
  même relevé sur une origine distincte.

Le rapport de chaque page est dans son élément `#rapport`.
