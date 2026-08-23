# Spike #4 — protocole et mesures : backend de blocs inscriptible pour v86

Ce document est le compte rendu d'expérience du spike #4. La décision qu'il porte est dans
l'[ADR 0003](../decisions/0003-backend-de-blocs-v86.md) ; ici ne figurent que la question,
l'environnement, les commandes, les résultats bruts et leur lecture.

## Question

Sur une version épinglée de v86, comment fournir un backend inscriptible dont `read`, `write`,
`flush`, `size` et les erreurs respectent le contrat de `docs/architecture.md` — et faut-il pour
cela un adaptateur, une contribution amont, un fork maintenu, ou un changement de runtime ?

## Environnement

| Élément             | Valeur                                                                  |
| ------------------- | ----------------------------------------------------------------------- |
| Système             | Windows 11 Famille 10.0.26200, x64, 28 cœurs logiques                   |
| Node                | v24.14.0 (dépôt : `engines >=22.13 <25`, CI en 22)                      |
| Playwright          | 1.62.1                                                                  |
| Chromium            | 151.0.7922.34 (`HeadlessChrome`, révision Playwright)                   |
| Émulateur           | `v86@0.5.432`, amont `847e34d5499b17b90d2783d5342ddd243c753497`         |
| Guest               | `linux4.iso` — Linux 4 / Buildroot i386, BusyBox, `libata` + `ata_piix` |
| Mémoire de la VM    | 128 Mio                                                                 |
| Volume mesuré       | 16 Mio, disque IDE maître (`hda` → `/dev/sda`)                          |
| Backend             | mémoire, `durable: false`, barrière simulée à 5 ms                      |
| Contexte navigateur | Worker dédié de type module, origine de confiance, CSP de la coquille   |

Cette machine n'est **pas** l'environnement de référence de `docs/quality-attributes.md` (4 cœurs
physiques, 16 Gio). Les mesures ci-dessous sont publiées comme les siennes, séparément, et ne s'y
substituent pas.

## Épinglage des artefacts

Aucun binaire n'est versionné. `vendor/v86/MANIFEST.json` fixe les empreintes, `npm run vm:fetch`
récupère, `npm run vm:check` vérifie. Total transféré au premier usage : **10 351 229 octets** (9,87
Mio), dont 7 731 200 pour l'image de guest.

| Artefact      |    Octets | SHA-256 (préfixe) | Licence               | Source                                                      |
| ------------- | --------: | ----------------- | --------------------- | ----------------------------------------------------------- |
| `libv86.mjs`  |   356 131 | `408b0969…`       | BSD-2-Clause          | paquet npm `v86@0.5.432`, entrée `package/build/libv86.mjs` |
| `v86.wasm`    | 2 096 474 | `8a969d64…`       | BSD-2-Clause          | même paquet npm                                             |
| `seabios.bin` |   131 072 | `73e3f359…`       | LGPL-3.0-or-later     | `raw.githubusercontent.com/copy/v86/847e34d…/bios/`         |
| `vgabios.bin` |    36 352 | `a4bc0d80…`       | LGPL-3.0-or-later     | idem                                                        |
| `linux4.iso`  | 7 731 200 | `a8ea434a…`       | GPL-2.0-only et amont | `i.copy.sh/linux4.iso`                                      |

L'archive npm elle-même est vérifiée avant extraction
(`de9379ee1ccc118903558faed9ff577a66d486c5551b9e5ef359f0d388c40ebb`).

`linux4.iso` est l'une des images que l'intégration continue de v86 utilise pour ses propres tests.
Elle a été retenue après un échec instructif : `buildroot-bzimage68.bin`, l'image d'amorçage directe
d'amont, démarre en 2,6 s mais **son noyau ne contient aucun pilote ATA** — `/proc/partitions` reste
vide et le disque n'est jamais touché. Une image « minimale » n'est pas nécessairement une image qui
sait écrire.

## Montage

```text
vendor/v86/MANIFEST.json           empreintes, licences et sources des cinq artefacts
tools/fetch-v86.mjs                récupération vérifiée (+ lecteur tar minimal)
tools/vm-protocol.mjs              protocole de mesure sous Node

src/vm/storage-errors.mjs          codes d'erreur contractuels
src/vm/block-journal.mjs           journal ordonné + audit des barrières
src/vm/fault-plan.mjs              injection déterministe de fautes
src/vm/memory-block-backend.mjs    backend conforme au contrat de docs/architecture.md
src/vm/v86-buffer-adapter.mjs      traduction contrat Vault → tampon disque v86
src/vm/v86-flush-bridge.mjs        observation ATA + pont de durabilité
src/vm/guest-session.mjs           pilotage du guest par la console série
src/vm/guest-scenarios.mjs         scénarios partagés Node / navigateur

public/vm/index.html + banc.mjs    coquille du banc, sans accès à l'émulateur
public/vm/runtime-worker.mjs       Worker runtime : v86 + backend (ADR 0002)
tests/vm/durability-barrier.spec.mjs   preuve d'ordre, avec témoin négatif
tests/vm/premier-boot.spec.mjs     mesure de premier boot dans le navigateur
```

Le pilotage passe par la console série. Un piège mérite d'être noté : l'écho du terminal renvoie la
commande envoyée, jeton de fin compris. Attendre naïvement le jeton fait donc terminer la mesure
**avant** que la commande s'exécute, et lire l'écho comme un résultat. Le jeton est écrit `R""B<n>`
dans la commande : les guillemets apparaissent dans l'écho, jamais dans la sortie.

## Commandes

```sh
npm run vm:fetch                  # 5 artefacts, empreintes vérifiées
npm run test:unit                 # contrats du backend, du journal, des fautes et du pont
npm run test:vm                   # preuve « intégration VM » sous Chromium
npm run vm:protocol -- --boots 5  # protocole complet sous Node → reports/vm/protocole.json
```

## Le point d'extension est public

`src/browser/starter.js` accepte n'importe quel objet portant `get`, `set` et `load` comme image
disque :

```js
if (file.get && file.set && file.load) {
  files_to_load.push({ name, loadable: file });
  return;
}
```

Aucun patch n'est nécessaire pour brancher un backend. Le noyau du guest voit un vrai disque :

```text
ata1.00: ATA-0: v86 ATA HD, 1.00, max MWDMA2
sd 0:0:0:0: [sda] 32768 512-byte logical blocks: (16.8 MB/16.0 MiB)
sd 0:0:0:0: [sda] Write cache: disabled, read cache: enabled, doesn't support DPO or FUA
```

La troisième ligne est le début du problème de durabilité.

## Sémantiques observées

Protocole identique dans les deux colonnes : `dd` brut, `dd conv=fsync`, `mke2fs`, `mount`, écriture
d'un fichier suivie de `sync`, `umount`, remontage et relecture. Le contenu écrit est bien relu
après remontage dans les deux modes.

| Propriété                       | Observation                                                                                                         |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| Commandes ATA vues              | `0xC8` READ DMA, `0xCA` WRITE DMA, `0x35` WRITE DMA EXT, `0xE7` FLUSH CACHE                                         |
| Granularité des lectures        | 1 024, 2 048, 4 096, 7 168, 8 192, 20 480, 21 504, 22 528, 23 552 octets (varie avec la lecture anticipée du noyau) |
| Granularité des écritures       | 1 024, 6 144, 16 384, 270 336, 282 624 octets                                                                       |
| Alignement                      | offsets et longueurs multiples de 512 ; jamais de fraction de secteur                                               |
| Taille maximale d'un appel      | 282 624 octets — 552 secteurs en un seul `set`                                                                      |
| Appels par commande ATA         | exactement un `get` ou un `set` ; v86 ne découpe pas en blocs de 256 octets                                         |
| Lectures pendant l'amorçage     | 3 (secteur d'amorçage puis examen des partitions), aucune écriture                                                  |
| Ordre                           | séquentiel ; aucun `get`/`set` concurrent observé sur ce guest                                                      |
| Vue passée à `set`              | chemin PIO : vue du tampon interne d'`ide.js`, réutilisée ensuite — copie exigée                                    |
| Acquittement d'une écriture PIO | `ide.js` lève l'interruption AVANT le callback du tampon : l'écriture n'est pas attendue                            |
| Acquittement d'une écriture DMA | le callback conditionne l'interruption : l'écriture est attendue                                                    |
| Canal d'erreur de `get` / `set` | **aucun** ; les callbacks n'expriment que le succès                                                                 |
| `get` court                     | impossible à signaler ; l'adaptateur n'acquitte pas et remonte l'erreur typée                                       |
| `set` au callback retardé       | supporté : le guest reste occupé jusqu'à l'acquittement (chemin DMA)                                                |
| Signal d'annulation             | `get` reçoit `{ signal }` ; le callback doit rester appelé, `ide.js` filtre lui-même                                |

Le détail par étape, mode amont à gauche, pont de durabilité à droite :

| Étape         | ATA amont            | ATA avec pont                    | `get` | `set` | barrières |
| ------------- | -------------------- | -------------------------------- | ----: | ----: | --------: |
| `cache-type`  | —                    | —                                |     0 |     0 |         0 |
| `write-raw`   | `0xCA`×1             | `0xCA`×1                         |     0 |     1 |         0 |
| `write-fsync` | `0xCA`×1             | `0xCA`×1, **`0xE7`×1**           |     0 |     1 |     **1** |
| `mkfs`        | `0xC8`×135, `0x35`×2 | `0xC8`×135, `0x35`×2             |   135 |     2 |         0 |
| `mount`       | `0xC8`×7, `0xCA`×1   | `0xC8`×8, `0xCA`×1, **`0xE7`×1** |   7-8 |     1 |     **1** |
| `file-sync`   | `0xC8`×4, `0xCA`×3   | `0xC8`×4, `0xCA`×3, **`0xE7`×1** |     4 |     3 |     **1** |
| `umount`      | `0xCA`×1             | `0xCA`×1, **`0xE7`×2**           |     0 |     1 |     **2** |
| `remount`     | `0xC8`×9, `0xCA`×3   | `0xC8`×9, `0xCA`×3, **`0xE7`×3** |     9 |     3 |     **3** |

Totaux : **176 commandes ATA en mode amont, dont zéro `0xE7` et zéro `0xEA`**, contre 185 avec le
pont, dont 8 barrières, toutes acquittées.

## La barrière de durabilité : deux ruptures, pas une

Le contexte du spike annonçait une rupture : `src/ide.js` traite `ATA_CMD_FLUSH_CACHE` (0xE7) et
`ATA_CMD_FLUSH_CACHE_EXT` (0xEA) en posant `DRDY|DSC` et en levant l'interruption, sans appeler le
tampon. C'est exact, et c'est la seconde.

La première est en amont de celle-là. `create_identify_packet` construit le mot 82 ainsi :

```js
const feat_82 = this.is_atapi ? (1 << 14) | (1 << 9) | (1 << 5) : 1 << 14;
```

Le bit 5 — « cache d'écriture supporté » — n'est armé que pour l'ATAPI. Le mot 85, « fonctions
activées », est une copie du mot 82. Un disque dur v86 déclare donc n'avoir aucun cache d'écriture,
Linux le classe en écriture immédiate, et **n'émet jamais de barrière** :

```text
$ cat /sys/block/sda/device/scsi_disk/*/cache_type
write through
```

Conséquence directe, mesurée : sur les 176 commandes ATA du protocole complet en mode amont, aucune
n'est un FLUSH CACHE. Corriger `ata_command` seul n'aurait rien changé — le correctif n'aurait
jamais été atteint. C'est le résultat le plus important du spike.

Un seul bit armé change tout :

```text
$ cat /sys/block/sda/device/scsi_disk/*/cache_type
write back
$ dd if=/dev/urandom of=/dev/sda bs=4096 count=4 seek=64 conv=fsync
→ ata 0xCA, ata 0xE7
```

En mode « IDENTIFY corrigé mais `ata_command` intact », le guest émet bien ses huit FLUSH CACHE et
le backend n'en voit **aucune** : la démonstration expérimentale que la commande est acquittée sans
atteindre le stockage.

Avec le pont complet, le journal du backend donne, pour `write-then-flush` :

```json
{ "seq": 22, "operation": "write", "offset": 0, "length": 16384 }
{ "seq": 23, "operation": "flush", "barrier": 0 }
{ "seq": 24, "operation": "flush-ack", "barrier": 0 }
```

`auditDurabilityBarriers` vérifie cette propriété sur tout le journal : chaque barrière suit au
moins une écriture, chaque acquittement suit sa barrière, aucune barrière ne reste en suspens.

## Prototype du correctif et coût d'un fork

`vendor/v86/patches/0001-flush-cache-vers-le-buffer.patch` applique les deux corrections à
`src/ide.js` au commit épinglé : **17 lignes ajoutées, 6 retirées**, dont 6 lignes utiles hors
commentaires. Il n'introduit aucune dépendance, reste rétrocompatible — un tampon sans `flush`
conserve le comportement actuel — et suit le style d'`ide.js` (accolades sur leur ligne, quatre
espaces, commentaire justifiant le comportement). Il est contribuable en l'état.

Ce que coûterait un fork, en revanche :

- le correctif ne touche que du JavaScript, donc `v86.wasm` pourrait rester celui du paquet npm et
  la chaîne Rust (`rustup target add wasm32-unknown-unknown`, `clang` pour `softfloat.o` et
  `zstddeclib.o`) serait évitable ;
- mais `build/libv86.mjs` est produit par **Closure Compiler v20210601**, jar téléchargé depuis
  Maven, exécuté par une JVM, avec des options que l'amont épingle explicitement à cette version («
  don't upgrade until closure-compiler#3972 is fixed ») ;
- il faudrait donc ajouter Java à la CI, vérifier un jar non publié par le projet, maintenir une
  branche rebasée à chaque montée de version, et publier un artefact que personne d'autre ne
  vérifie.

L'alternative retenue coûte un fichier de 112 lignes. Les artefacts publiés sont compilés en niveau
Closure `SIMPLE`, qui **ne renomme pas les propriétés** : `IDEInterface.prototype.ata_command`,
`create_identify_packet`, `push_irq` et `cpu.devices.ide.primary.master` sont accessibles tels
quels. Les instances sont scellées par v86 — d'où une greffe sur le prototype, filtrée sur
l'identité du tampon pour ne pas toucher le CD-ROM.

## Injection de fautes : ce que le guest observe

Chaque cas rejoue un plan de fautes déterministe (`src/vm/fault-plan.mjs`) sur un guest fraîchement
démarré. Les rangs visent la première opération de la commande, l'amorçage consommant exactement
trois lectures et aucune écriture.

| Faute injectée                        | Erreur remontée au runtime        | Ce que le guest observe                                 |        Durée |
| ------------------------------------- | --------------------------------- | ------------------------------------------------------- | -----------: |
| Lecture courte, une fois              | `VAULT_STORAGE_SHORT_READ`        | **succès** après reprise : `8+0 records out`, `rc=0`    |    30 851 ms |
| Écriture partielle, une fois          | `VAULT_STORAGE_PARTIAL_WRITE`     | **succès** après reprise : `4+0 records out`, `rc=0`    |    30 763 ms |
| Écriture partielle, six fois de suite | 4 × `VAULT_STORAGE_PARTIAL_WRITE` | **blocage** : aucune sortie au bout de 120 s            | > 120 000 ms |
| Échec de barrière, une fois           | `VAULT_STORAGE_FLUSH_FAILED`      | **succès** après reprise : `rc=0`                       |       295 ms |
| Échec de barrière, six fois de suite  | 6 × `VAULT_STORAGE_FLUSH_FAILED`  | **erreur** : `dd: /dev/sda: Input/output error`, `rc=1` |       285 ms |
| Handle perdu à la première écriture   | 4 × `VAULT_STORAGE_HANDLE_LOST`   | **blocage** : aucune sortie au bout de 120 s            | > 120 000 ms |

Quatre lectures s'imposent, et elles pèsent lourd pour #14 et #15.

**Une faute transitoire est invisible pour le guest.** Le noyau attend son délai de garde ATA,
réinitialise le lien, rejoue la commande — qui réussit puisque le plan de fautes ne visait qu'une
occurrence — et l'application voit un succès :

```text
res 40/00:00:00:00:00/00:00:00:00:00/00 Emask 0x4 (timeout)
ata1.00: status: { DRDY }
ata1: soft resetting link
ata1.00: configured for MWDMA2
ata1: EH complete
```

Seul le runtime sait qu'une erreur a eu lieu. **Toute décision de verrouillage doit donc se prendre
côté runtime, jamais sur le retour du guest.**

**Le prix de l'absence de canal d'erreur se compte en secondes.** Trente et une, ici, pour une seule
lecture courte : c'est le délai de garde de `libata`, pas une latence du backend. Une panne de
support ne peut pas être signalée à `get` ou `set`, donc le seul signal disponible est le silence.

**La barrière, elle, sait échouer vite.** Le pont dispose d'un canal d'erreur — les registres ATA —
et abandonne explicitement la commande : `ABRT`, 295 ms au lieu de 31 s. Répétée, la faute devient
une erreur d'E/S franche que l'application reçoit :

```text
sd 0:0:0:0: [sda] tag#0 Add. Sense: Unaligned write command
sd 0:0:0:0: [sda] tag#0 CDB: Synchronize Cache(10) 35 00 00 00 00 00 00 00 00 00
print_req_error: I/O error, dev sda, sector 0
```

C'est le comportement souhaitable, et il n'est atteignable que là où l'émulateur offre un canal
d'erreur. Le contraste avec les 31 s de la lecture courte est la mesure exacte de ce qui manque à
`get` et `set`.

**Une panne persistante du support bloque le périphérique.** Écriture partielle répétée et handle
perdu laissent le guest en attente indéfinie : le noyau rejoue, la faute revient, aucune borne
n'existe. Le runtime, lui, a reçu ses erreurs typées dès la première occurrence — c'est à lui
d'arrêter la VM plutôt que de laisser un guest tourner dans le vide.

## Mesures

### Premier boot

Cinq essais après un échauffement écarté, guest complet jusqu'à l'invite du shell. Série de
référence : le **navigateur**, puisque c'est là que le produit s'exécute
(`reports/vm/premier-boot-chromium.json`).

| Série                      | Essais (ms)                  |  p50 |  p95 |
| -------------------------- | ---------------------------- | ---: | ---: |
| Chromium 151, Worker dédié | 3300, 3285, 3264, 3391, 3336 | 3300 | 3391 |
| Node 24, machine au repos  | 3480, 3361, 3327, 3544, 3575 | 3480 | 3575 |
| Node 24, machine chargée   | 8433, 5717, 5406, 4545, 4633 | 5407 | 8433 |

La troisième série est publiée telle quelle : elle montre la dispersion réelle d'une mesure prise
sur un poste de travail occupé, et pourquoi les deux premières ne valent que pour leurs conditions.
Le budget de `docs/quality-attributes.md` — p95 ≤ 15 min pour un premier boot de preuve — est
respecté de trois ordres de grandeur, sur un guest qui n'est pas encore une application Rails. La
fixture qui donnera un chiffre comparable au budget appartient à #5.

### Mémoire

| Mesure                                      | Valeur                                   |
| ------------------------------------------- | ---------------------------------------- |
| `process.memoryUsage().rss` (Node, 6 boots) | 364 072 960 octets, soit 347 Mio         |
| `performance.memory` (Chromium)             | `usedJSHeapSize` = 10 000 000 exactement |

La mesure navigateur est **inutilisable** et il faut le dire : hors contexte isolé multi-origine,
Chromium quantifie grossièrement `performance.memory`, et la valeur rendue est une constante. La
mesure fine (`performance.measureUserAgentSpecificMemory`) exige `crossOriginIsolated`, que le
runtime n'utilise pas. Le chiffre Node est donc le seul réel, et il porte six VM successives dans un
processus dont le ramasse-miettes n'a pas été forcé : il majore, il ne mesure pas un pic par VM. Le
budget de 1,5 Gio de `docs/quality-attributes.md` ne peut pas être vérifié sérieusement avec ces
instruments ; l'outillage de mesure mémoire est un travail découvert.

### Taille transférée

| Poste                         |                    Octets |
| ----------------------------- | ------------------------: |
| `linux4.iso` (image de guest) |                 7 731 200 |
| `v86.wasm`                    |                 2 096 474 |
| `libv86.mjs`                  |                   356 131 |
| `seabios.bin` + `vgabios.bin` |                   167 424 |
| **Total**                     | **10 351 229** (9,87 Mio) |

Très en deçà des 500 Mio par application du budget d'artefacts — mais ce total ne contient ni Ruby,
ni Rails, ni base de données. Il mesure le coût du runtime, pas celui d'une application.

## Contraintes d'environnement

### CSP de la coquille

Le runtime vit sur l'origine de confiance, donc sous la CSP de l'ADR 0002. Deux directives l'ont
arrêté.

`script-src 'self'` refuse l'instanciation d'un module WebAssembly sous Chromium. Le jeton
`'wasm-unsafe-eval'` est ajouté : il autorise WebAssembly sans ouvrir `eval` ni `new Function`.
`'unsafe-eval'` et `'unsafe-inline'` restent interdits, ce que vérifie
`tests/unit/origin-topology.test.mjs`.

`worker-src 'self'` refuse le Worker imbriqué que v86 crée depuis une URL `blob:` pour cadencer sa
boucle principale :

```text
Creating a worker from 'blob:http://127.0.0.1:4177/f8b804af-…' violates the following
Content Security Policy directive: "worker-src 'self'". The action has been blocked.
```

Le symptôme est traître : aucune exception ne remonte à la page, l'émulateur ne bat simplement
jamais et le guest paraît ne pas démarrer. v86 offre une porte de sortie — il choisit
`scheduler.postTask` lorsque l'URL de son contexte contient `use-scheduling-api`. Le Worker runtime
est donc chargé ainsi, et vérifie la condition au démarrage plutôt que de retomber silencieusement
sur le chemin bloqué.

Disponibilité de `scheduler.postTask`, mesurée le même jour sur les trois moteurs Playwright :

| Moteur       | `scheduler.postTask` en page | Worker `blob:` sous `worker-src 'self'` |
| ------------ | ---------------------------- | --------------------------------------- |
| Chromium 151 | présent                      | refusé                                  |
| Firefox 153  | présent                      | refusé                                  |
| WebKit 26.5  | **absent**                   | refusé                                  |

Un moteur sans `scheduler.postTask` imposerait `worker-src blob:` dans la CSP de la coquille, ou une
boucle d'ordonnancement fournie par nous. La matrice #2 devra en tenir compte avant d'annoncer
Safari.

### Isolation multi-origine

Le guest démarre et écrit avec `crossOriginIsolated` à `false`, donc **sans `SharedArrayBuffer`**.
L'écart d'héritage d'isolation relevé par le spike #35 ne bloque pas le runtime.

## Conclusion

Le point d'extension disque de v86 est public, suffisant et stable ; un backend conforme au contrat
de `docs/architecture.md` s'y branche sans patch. Ce qui manque n'est pas l'écriture mais la
**barrière** : l'émulateur ne demande jamais au guest de lui en envoyer une, et n'en ferait rien
s'il en recevait. Les deux corrections tiennent en six lignes de JavaScript et s'obtiennent à
l'exécution sur les artefacts publiés, ce qui rend un fork inutile.

Reste un écart que ce spike ne referme pas : `get` et `set` n'ont aucun canal d'erreur, si bien
qu'une panne de support ne peut être signalée au guest que par un délai de garde. C'est le principal
travail découvert, et il appartient à #14.

La décision est dans l'[ADR 0003](../decisions/0003-backend-de-blocs-v86.md).
