# ADR 0041 — Le paquet applicatif : partition 2 d'un `hda` composé, données sur `hdb`, descripteur v2

- **Statut** : accepté
- **Date** : 2026-09-17
- **Issue** : [#236](https://github.com/pinfada/railsbox-vault/issues/236), tranche T1
- **Amende, sans changer leur format** : l'[ADR 0024](0024-instantane-du-boot.md) (le paquet entre
  dans l'empreinte d'image d'une liaison d'instantané), l'[ADR 0004](0004-image-de-reference.md)
  (l'image ne cuit plus l'application dans un disque unique),
  l'[ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md) et
  l'[ADR 0038](0038-servir-l-application-dans-le-cadre.md) (le descripteur servi passe en v2).
- **Ne rouvre pas** : le format de volume v4 et la hiérarchie de clés (ADR 0033–0036), le contrat de
  messages (ADR 0028), « un coffre = une identité » (ADR 0039), la durabilité par le commit (#209 :
  `synchronous = extra`, ext4 journalisé, barrières), la garde de mémoire partagée (ADR 0010), le
  cache immuable par empreinte (ADR 0023), la chaîne de publication (#45).
- **Ne traite pas** (T2, #236) : le déphasage de versions — comparaison des schémas avant le boot,
  geste « Mettre à jour », refus `VAULT_APPLICATION_ANTERIEURE` et `VAULT_APPLICATION_ABSENTE`,
  rétention du paquet précédent, second paquet de démonstration. Hors périmètre de l'épique : le
  redimensionnement du disque de données (rouvrirait l'ADR 0035) et la signature de l'auteur d'un
  paquet (jalon 6).

## Contexte

L'application Rails était **cuite dans l'image** : l'étage `disque-app` copiait `apps/reference/`,
compilait le bundle i386, migrait la base et créait l'invariant dans le **même** disque
`reference-app.ext4` (`hdb`) que le coffre installe et que Rails écrit ensuite. Code et données
partageaient donc un disque : remplacer l'application, c'était perdre les données. Aucun geste «
installer une application » n'existait hors de l'image de référence, et le descripteur servi (v1) ne
portait aucune empreinte — seule la taille du disque était vérifiée à l'installation.

Le défi d'architecture du 17/09/2026 (rapport `ck-paquet-applicatif-236`) a écarté l'intention
initiale — le paquet en ISO 9660 sur le lecteur `cdrom` de v86 — sur trois coûts mesurés dans le
dépôt :

- `isofs` n'est chargeable ni par le rootfs (ses modules sont supprimés à la construction) ni sans
  reconstruire l'initramfs ;
- l'état IDE d'un `cdrom` v86 est un `SyncBuffer` dont `get_state` rend **le disque entier** :
  chaque instantané aurait gagné 120 à 150 Mio ;
- un support en lecture seule casse Bootsnap, `tmp/` et `log/` pour toute application tierce.

## Décision

### 1. Le paquet est une image ext4 sans journal, seconde partition d'un `hda` composé

Un **paquet** est fait de trois pièces, servies séparément sous leur empreinte :

| Pièce               | Nature                                                | Où elle vit                                                                             |
| ------------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `image` (le paquet) | ext4 **sans journal**, marge +5 % + 16 Mio            | partition 2 de `hda`, montée sur `/app`                                                 |
| `graine`            | ext4 **journalisé**, taille fixe (512 Mio par défaut) | versée dans le volume `application` du coffre, vue par le guest en `hdb` sur `/app/var` |
| `paquet.json`       | contrat versionné (`contractVersion: 1`)              | à côté des images, relu par le manifeste d'image                                        |

La coquille **compose** `hda` (`src/vm/disque-compose.mjs`,
`src/vm/acquisition-du-disque-systeme.mjs`) : table MBR calculée (512 octets), partition 1 = le
rootfs **à l'octet près**, partition 2 = le paquet, aux décalages alignés sur 1 Mio d'un tampon
**préalloué une fois**. Chaque morceau est téléchargé directement à son décalage et **haché en
passant** : un écart d'empreinte ou de taille refuse le disque avant le premier battement du guest.
Le tampon est ensuite adopté par `creerTamponRootfs` (ADR 0024) : l'instantané ne publie toujours
que le **delta**. `boot.cmdline` devient `root=/dev/sda1`. Le `cdrom` n'est pas utilisé.

**Pourquoi composer plutôt que fabriquer un disque partitionné** : un disque partitionné serait un
seul artefact ; mettre à jour l'application retéléchargerait le rootfs entier (385 Mio) pour changer
140 Mio de code, et changerait l'empreinte de tout. Chaque morceau garde donc son adresse par
empreinte (ADR 0023), et seuls 512 octets sont calculés.

**Le noyau sait lire cette table** : `CONFIG_MSDOS_PARTITION=y` et `CONFIG_PARTITION_ADVANCED=y`,
lus dans `/boot/config-6.1.0-52-686` du rootfs réel (Debian bookworm, `linux-image-686`). C'était la
première vérification de la tranche, et la condition du repli ISO ; elle est positive.

### 2. Le code est ÉPHÉMÈRE, les données sont DURABLES

`guest-init.sh` monte `/dev/sda2` sur `/app` en lecture-écriture, puis un tmpfs sur `/app/log`, puis
`/dev/sdb` sur `/app/var` avec **exactement** les options de #209
(`barrier=1,data=ordered,errors=remount-ro`, journal), et relève l'état ext4 du disque de données
comme auparavant.

Les écritures dans `/app` (hors `/app/var`) vivent dans le delta en RAM du tampon du disque système
: elles survivent à une reprise par instantané, **et sont perdues au boot à froid, sans erreur**.
C'est une **exigence de compatibilité du paquet** (#210), écrite dans `SECURITY.md` : une
application qui doit conserver quelque chose l'écrit sous `/app/var`. Le montage en lecture seule —
qui ferait échouer franchement au lieu de perdre en silence — reste possible plus tard ; il
casserait aujourd'hui Bootsnap et `tmp/` de toute application tierce.

Le journal du paquet est **retiré** parce qu'il ne serait jamais rejoué : rien de ce qui y est écrit
ne survit à un boot à froid. Il coûterait des mébioctets à chaque visiteur et de la RAM sous une
cible de 1,2 Gio (#67).

### 3. L'installation verse la GRAINE, sans ses zéros, et vérifie son empreinte

Le volume `application` naît à la taille du disque de données (`graine.disqueOctets`) et reçoit la
graine :

- **les blocs nuls de 4 Kio ne sont pas écrits.** Un volume neuf est **entièrement scellé à zéro à
  sa naissance** (`scellerLeVolumeNeuf`, `src/vm/opfs-volume-ouverture.mjs` : « un secteur jamais
  écrit n'existe pas en v3 », ADR 0015) : un bloc nul de la graine se relit donc déjà à zéro, et
  l'écrire reviendrait à chiffrer des zéros pour obtenir ce que la lecture rend. Ce saut n'est
  demandé que par l'installation, sur un volume qu'elle vient de créer ; appliqué à un volume
  habité, il laisserait en place ce que la source veut effacer ;
- **l'empreinte de la source est confrontée pendant le versement**, avant la barrière et avant la
  datation. Un écart refuse l'installation, et le volume reste ANONYME donc non ouvrable. Jusqu'ici,
  l'empreinte du fichier écrit était rendue et relue par la datation, mais rien ne comparait jamais
  les octets reçus à ce que l'origine déclare.

### 4. Le descripteur servi passe en v2, et la v1 n'est pas portée

`artifacts/application.json` porte `descripteurVersion: 2`, `application { id, version, schema }`,
`runtime { version }`, `rootfs { nom, octets, sha256 }`, `paquet { … }`,
`graine { …, disqueOctets }`, `boot { cmdline, memoireOctets, kernel, initrd, bios, vgaBios }` et
`prefixeDesArtefacts`. Les bornes de taille et de mémoire, le refus de `..` et l'alphabet clos de la
ligne de commande sont conservés ; chaque morceau exige désormais une empreinte bien formée.

**Aucune compatibilité v1 n'est portée**, et c'est une décision : aucun déploiement réel n'existe,
et un lecteur qui accepterait les deux formes garderait un chemin d'installation sans empreinte.

### 5. `apps/reference` est le premier paquet, fabriqué par le chemin des applications tierces

`npm run app:paquet -- --source <dossier> [--id …] [--version …] [--taille-donnees=<Mio>]` fabrique
un paquet depuis n'importe quel dossier Rails. Un dossier **hors du dépôt** entre par un contexte de
construction nommé BuildKit (`--build-context application=<dossier>`, `COPY --from=application`) :
le contexte principal reste la racine du dépôt, et rien n'est copié dans l'arbre.

L'identité vient des options, puis de `vault-app.json` à la racine de l'application, puis — pour la
référence seule, par continuité — de `vault-invariant.json`. Le `secret_key_base` se dérive d'une
chaîne publique : `config/master.key`, `config/credentials.yml.enc` et
`config/credentials/production.key` font **refuser la fabrication**, avant le premier `docker build`
et de nouveau dans le Dockerfile — une application extérieure n'est pas dans l'arbre que
`verify-pinning.mjs` inspecte.

`npm run image:build` appelle ce même outil pour `apps/reference` : un second chemin de fabrication
pour la référence aurait divergé au premier correctif, et aurait surtout laissé le chemin des
applications tierces sans preuve.

### 6. Le paquet entre dans la liaison d'un instantané (ADR 0024 amendé, format inchangé)

`ARTEFACTS_DE_L_IMAGE` gagne `paquet` : l'empreinte d'image d'une liaison couvre désormais le code
de l'application. Un instantané pris sous un AUTRE paquet est écarté par le motif typé existant
(`ECART_IMAGE`), au même titre qu'un instantané pris sous une autre image. Le format de la liaison —
32 octets — ne change pas.

## Ce qui est écarté, et pourquoi

- **L'ISO 9660 sur le `cdrom`** : trois coûts nommés ci-dessus, dont un CRITICAL (l'instantané
  gonflé de 120–150 Mio) et une exigence de compatibilité de plus pour les tiers.
- **Ne pas séparer, et faire copier `/app` par le guest depuis un nouveau paquet** : le code
  cesserait d'être immuable et vérifiable par empreinte, il faudrait copier 200 à 400 Mio sur un
  i386 émulé à chaque mise à jour, et une coupure pendant la copie mêlerait deux versions dans une
  génération validée.
- **Publier les artefacts de l'image par la chaîne de publication** : la décision de l'ADR 0030 §
  Limites tient — la chaîne recopie et hache tout ce qu'elle émet, et un arbre d'un gibioctet ferait
  passer `npm run check` de deux minutes à des dizaines. Déposer les artefacts sur l'origine de
  confiance reste une obligation d'exploitant. Ce que #236 change : les noms du paquet et de la
  graine **portent leur empreinte** (`<id>-<version>-<sha256 tronqué>.ext4`), donc supportent un
  cache immuable dès qu'ils sont déposés, comme les artefacts v86 (#123).

## Limites, mesurées

- Le paquet s'ajoute au rootfs **en RAM** : le disque système pèse rootfs + paquet, et le budget de
  mémoire du boot est relevé dans `docs/quality-attributes.md`. Une lecture à la demande du paquet
  (empreintes par bloc, requêtes `Range`, nouvelle définition de l'empreinte d'image) est un
  chantier d'intégrité à part, à ouvrir si la mesure dépasse la cible de 1,2 Gio (#67).
- La marge du paquet (+5 % + 16 Mio) borne ce qu'une session peut écrire dans `/app` : au-delà, le
  système de fichiers se remplit. Les journaux sont donc sur tmpfs.
- `db:migrate` n'est **pas** joué au boot : la graine naît migrée, et le marqueur `.vault-schema`
  qu'elle porte est ce que T2 comparera au schéma du paquet.
