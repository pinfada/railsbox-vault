# ADR 0012 — Les scénarios de bout en bout s'exécutent sur un profil de navigateur persistant, donc sur un OPFS adossé au disque

- Statut : accepté
- Date : 2026-08-26
- Issue : #73 · Invariant : `VAULT-PERSIST-001` · Jalon 1

## Contexte

Le job CI **Reprise MVP** échouait par intermittence, sur les exécutants GitHub et jamais en local,
avec un `FileSystemSyncAccessHandle.write()` qui rendait `4294967288` au lieu des 4 194 304 octets
demandés pendant l'écriture d'une archive de 512 Mio.

L'issue #73 proposait deux pistes : le quota OPFS ou le disque de l'exécutant saturés, ou un défaut
de Chromium. Les deux sont partiellement vraies, mais aucune ne se tenait telle quelle. Il a fallu
mesurer.

## Ce que la mesure a établi

**`4294967288 = 2³² − 8`.** C'est l'entier signé `−8` lu comme non signé sur 32 bits. Dans
l'énumération `base::File::Error` de Chromium (`base/files/file.h`), `−8` est `FILE_ERROR_NO_SPACE`.
La spécification WHATWG, elle, n'admet **aucune** valeur de retour supérieure à la longueur demandée
: `write()` doit lever (`QuotaExceededError`, `InvalidStateError`…) plutôt que rendre un code. Une
telle valeur est donc, quel que soit le composant qui la produit, un échec présenté comme un compte.

**Le disque de l'exécutant n'était pas plein.** Instrumentation ajoutée par cette issue, run
`32903478142` :

| Étape                         | Espace disponible    |
| ----------------------------- | -------------------- |
| départ                        | 85,47 Gio sur 144,26 |
| après construction de l'image | 83,88 Gio            |
| avant les scénarios           | 83,87 Gio            |
| après les scénarios           | **83,84 Gio**        |

Trente mébioctets de variation pendant douze minutes de scénarios qui écrivent près d'un gibioctet
dans OPFS. La piste « disque saturé » est **réfutée**.

**Le quota d'origine annoncé ne l'était pas non plus.** Au moment exact du refus,
`navigator.storage.estimate()` rendait `quota = 4 152 412 142`, `usage = 931 186 670`, soit **3 Gio
disponibles** — pour une écriture de 4 Mio. La piste « quota d'origine épuisé » est réfutée elle
aussi, du moins telle que le navigateur la rapporte.

**Les octets d'OPFS ne touchaient pas le disque.** Sonde d'échantillonnage locale, pendant le
scénario d'export, le 26/08/2026 :

| Contexte                                      | Écrit dans OPFS | Variation du disque pendant le scénario |
| --------------------------------------------- | --------------- | --------------------------------------- |
| `browser.newContext()` (défaut de Playwright) | > 1 Gio         | **< 1 Mio**                             |
| `chromium.launchPersistentContext()`          | > 1 Gio         | **≈ 1,0 Gio**, rendue à la fin          |

Playwright fabrique ses contextes par `browser.newContext()`, qui crée un profil **hors
enregistrement**. Chromium n'adosse alors pas OPFS à un disque : il l'adosse à un système de
fichiers **en mémoire**. La mesure ci-dessus l'établit de l'extérieur ; côté moteur, Chromium sert
ces profils par un délégué distinct
(`third_party/blink/renderer/modules/file_system_access/file_system_access_incognito_file_delegate.cc`)
de celui qui écrit sur disque (`…_regular_file_delegate.cc`).

Ce fait réconcilie les mesures précédentes : **le support qui refusait n'était pas celui que
`estimate()` décrivait**, ni celui que mesurait `statfs`. Reste une inférence, et elle est signalée
comme telle sous « Limites » : que la ressource épuisée soit la mémoire est déduit du support et du
code d'erreur, non mesuré directement.

**`estimate()` ne pouvait de toute façon pas servir de garde.** Les valeurs relevées sont des
constantes rondes — `available` valait exactement 3 Gio puis 4 Gio en CI, exactement 10 Gio en local
avec 393 Gio réellement libres. Chromium arrondit ce qu'il publie là (une valeur exacte
renseignerait une empreinte de machine). L'estimation n'est donc pas une mesure du support : c'est
une indication grossière, utile à un diagnostic, inutilisable comme seuil.

## Décision

**Les quatre scénarios de `tests/e2e/` s'exécutent sur un contexte à profil persistant**
(`tests/e2e/contexte-persistant.mjs`), donc sur un OPFS adossé au disque. Un profil par test, dans
le répertoire de sortie que Playwright nettoie déjà.

Deux raisons, dans cet ordre.

**La première est une question de justesse, pas de stabilité.** `VAULT-PERSIST-001` promet une
reprise depuis un volume OPFS, et un utilisateur exécute Vault dans un profil de navigateur
**ordinaire**, dont l'OPFS est sur disque. Prouver la reprise contre un système de fichiers en
mémoire est une promesse plus étroite que celle qu'on affiche. Ce que les scénarios établissaient
reste vrai — la donnée survit à la fermeture de la page, du Worker et des handles — mais le support
n'était pas celui du produit. Le corriger **renforce** la preuve du jalon 1 ; il ne l'assouplit pas.

**La seconde est la cause de #73.** Sur un support en mémoire, c'est la mémoire de l'exécutant qui
tient lieu de quota, et elle n'a aucun rapport avec ce que le produit rencontrera. Le job mesurait
une contrainte qui n'existe pas chez l'utilisateur.

**Aucune assertion n'est modifiée**, aucun scénario n'est allégé, aucun volume n'est réduit : le
disque applicatif de référence reste à 512 Mio. Seul le support change.

## Ce que le code fait désormais d'une telle valeur de retour

Indépendamment du support, toute valeur rendue par un `read`/`write` OPFS est INTERPRÉTÉE plutôt que
comparée à la va-vite (`src/vm/opfs-error-mapping.mjs`) :

- `rendu == demandé` → succès ;
- `0 ≤ rendu < demandé` → écriture réellement partielle, lecture réellement courte ;
- `rendu > demandé` → ce n'est pas un compte. Décodé en entier signé 32 bits, nommé quand la table
  `base::File::Error` le connaît, puis classé : `FILE_ERROR_NO_SPACE` devient
  `VAULT_STORAGE_QUOTA_EXCEEDED`, **tout autre errno reste un échec de support NON classé**.

Le contexte — demandé, rendu, errno, offset, quota, usage — accompagne l'erreur jusqu'au journal de
CI. Aucun réessai, aucun repli : une écriture refusée reste refusée.

## Conséquences

- Les scénarios écrivent réellement sur le disque de l'exécutant : environ **1 Gio par scénario** en
  pic, rendu à la fin. `docs/testing.md` documente cette empreinte comme une précondition du job.
- Le lancement d'un navigateur par test coûte quelques secondes ; négligeable devant des scénarios
  qui se comptent en minutes.
- La capture de trace n'est pas reprise à la main : Playwright instrumente tout contexte créé
  pendant un test, `trace: "retain-on-failure"` continue donc de s'appliquer.
- Le cloisonnement d'OPFS par origine (ADR 0002) est celui du navigateur ; il n'est pas touché, et
  la restauration inter-origine (#12) continue de reposer dessus.

## Limites

- **La preuve porte sur Chromium.** Le comportement d'un profil hors enregistrement — et donc la
  nature du support d'OPFS — appartient au moteur. Rien ici n'établit ce que font Firefox ou WebKit,
  et le dépôt ne mesure pas leurs profils privés.
- **Aucun ticket Chromium correspondant n'a été trouvé**, et le suivi `issues.chromium.org` exige
  une authentification que l'analyse n'avait pas. L'affirmation « c'est un défaut connu de Chromium
  » n'est donc **pas** faite : ce qui est établi, c'est la valeur, sa décomposition, et le support
  sur lequel elle apparaît.
- **La cause immédiate du refus — la mémoire — n'est pas mesurée directement.** Ce qui est mesuré,
  c'est que les octets ne vont pas sur le disque, que le disque et le quota annoncé étaient tous
  deux amples, et que l'errno est `NO_SPACE`. Un relevé de `MemAvailable` pendant les scénarios est
  désormais publié, mais aucun échec n'a encore été observé avec ce relevé en main.
- **Le passage au disque ne rend pas le scénario insensible à la saturation** : il déplace la
  contrainte vers une ressource bien plus ample et, surtout, vers celle que le produit rencontre. Un
  exécutant réellement plein ferait de nouveau échouer le job — et le dirait alors correctement.

## Alternatives rejetées

- **Réduire le volume de référence sous 512 Mio.** Aurait diminué la pression sans corriger le
  support, et affaibli le scénario : la taille du disque applicatif est un choix de l'image #5, lié
  à la place laissée aux écritures du guest.
- **Marquer les scénarios instables, ou réessayer.** Aurait effacé le symptôme et la cause avec lui.
  `retries` reste à 0.
- **S'en remettre à `navigator.storage.estimate()` pour refuser avant d'écrire.** L'estimation ne
  décrivait pas le support qui refusait : elle annonçait 3 Gio disponibles au moment du refus. Une
  garde fondée sur elle n'aurait rien vu venir.
