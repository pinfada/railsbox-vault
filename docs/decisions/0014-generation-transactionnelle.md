# ADR 0014 — Une génération est un journal d'intention voisin, scellé par une racine d'un seul secteur

- Statut : accepté
- Date : 2026-08-27
- Issue : #16 · Invariant : `SEC-DURABLE-001` · Jalon 3

## Contexte

#14 a fermé la barrière de durabilité de bout en bout : le backend attend le
`FileSystemSyncAccessHandle.flush()` avant d'enregistrer l'acquittement, si bien qu'aucune écriture
n'est annoncée durable au guest avant que le support ait rendu la main.

#15 a livré l'instrument qui mesure ce qu'une coupure laisse : un injecteur d'arrêts à graine, un
oracle qui classe chaque bloc relu, un compte rendu qui publie le taux de coupures laissant « ancien
ou nouveau ». Sa première mesure — graine 2026, huit points, OPFS réel sous Chromium — donne **12,5
%**, contre le budget de **100 %** de `docs/quality-attributes.md`.

Le guest n'émet aucune transaction : le seul point observable est la barrière. Une génération est
donc l'ensemble des écritures comprises entre deux barrières acquittées, et l'acquittement est le
point de validation. Cette tranche doit rendre cette frontière RÉELLE : avant l'acquittement, aucune
écriture de la génération en cours n'est visible d'un lecteur qui rouvre le volume ; après, toutes
le sont.

## L'oracle de #15 ne savait pas nommer une génération intermédiaire

Avant de choisir un mécanisme, il a fallu constater un défaut de la MESURE, et le corriger — mais
pas là où cette tranche l'a d'abord cru.

Le scénario de #15 écrit vingt-quatre blocs DISTINCTS avec une barrière tous les huit : trois
générations, dont chacune ne touche qu'un tiers du volume. Or l'oracle de #15 ne connaissait que
deux états de référence — « tout l'ancien » et « tout le nouveau ». Une génération intermédiaire
VALIDÉE y était donc, par construction, un `melange`, et le « 100 % » demandé était hors d'atteinte
de TOUT mécanisme : la borne supérieure valait 50 % sur la graine 2026, 37,5 % sur les graines 7
et 424242.

### La première réponse était fausse, et c'est une mutation qui l'a montré

Cette tranche a d'abord changé la CHARGE MESURÉE : huit blocs réécrits trois fois avec le MÊME
contenu, de sorte que toute génération validée soit l'un des deux états que l'oracle savait juger.
Les trois nombres qui décident de la matrice restaient inchangés, la matrice aussi, et le taux
montait à 100 % sur les trois graines.

**La revue l'a réfutée par mutation, et le contre-exemple mérite d'être conservé.** À contenu
identique d'une passe à l'autre, les générations 2 et 3 ne publient RIEN de nouveau : le volume
final est le même qu'elles aient été validées ou perdues. Un magasin muté qui les acquitte au guest
— la barrière du support est franchie, le `flush-ack` remonte — puis ne les scelle jamais laisse
donc exactement le même volume qu'un magasin correct. **La matrice restait à 100 %, et la suite
unitaire entière restait verte.** La mesure ne mesurait plus rien.

### La bonne réponse : apprendre à l'oracle à juger le scénario

Le remède n'est pas de fabriquer un scénario que l'oracle sait juger — c'est déplacer la barre —
mais d'apprendre à l'oracle à juger le scénario. `classerVolume` reçoit désormais la **suite des
générations attendues** : pour ce scénario, `[∅, {0..7}, {0..15}, {0..23}]`. Un volume relu est
accepté si, et seulement si, l'ensemble des blocs PUBLIÉS est **exactement** l'un de ces états. Les
verdicts intermédiaires sont nommés — `generation-1`, `generation-2` — au lieu d'être rangés dans
`melange`.

Trois propriétés en font un juge **strictement plus discriminant** que celui de #15, et non un juge
plus indulgent :

1. **La suite est dérivée du SCÉNARIO**, jamais du mécanisme : quels blocs chaque écriture touche,
   où tombent les barrières. Elle ne demande pas au magasin ce qu'il a fait, elle énumère ce qu'il
   devait faire.
2. **L'oracle refuse une suite qui ne croît pas strictement** — elle doit partir de l'ensemble vide,
   croître par inclusion stricte, et finir sur la totalité des blocs suivis. Ces trois règles
   n'admettent qu'une seule suite par scénario : un appelant ne peut pas y glisser l'état que son
   mécanisme produit pour faire passer un mélange pour une génération.
3. **Tout ce que #15 refusait est encore refusé** : bloc non rattachable, bloc déchiré, et surtout
   écriture acquittée puis franchie par une barrière qui aurait disparu du support.

Le scénario, lui, **revient à vingt-quatre blocs distincts** avec une barrière tous les huit — celui
de #15, à l'identique.

`tests/unit/vm-crash-mutation.test.mjs` tient la démonstration dans les deux sens : le magasin sain
rend 100 % sur les trois graines ; le mutant qui perd les générations acquittées tombe à 0,875 /
0,75 / 0,75, et celui qui les perd toutes à 0,5 / 0,375 / 0,375, avec des blocs `corrompu` nommés
par la règle `SEC-DURABLE-001`. La borne de l'épreuve est dite aussi : un point coupé avant la
première barrière n'a rien fait promettre au mutant, et rend le même verdict qu'un magasin correct —
ce n'est pas un trou de l'oracle, c'est qu'il n'y a rien à trahir.

### Ce que la matrice ne peut pas exercer

Le verdict `nouveau` — les vingt-quatre blocs publiés — est **inatteignable par la matrice**, sur
les trois graines, à huit comme à douze points. La génération 3 n'est validée qu'à l'acquittement de
la troisième barrière, qui suit la vingt-quatrième écriture ; or les trois genres de coupure de
`crash-plan.mjs` tombent tous avant cet acquittement. Ajouter un genre « après barrière » changerait
le nombre de genres, donc la suite pseudo-aléatoire, donc la matrice entière.

L'extrême haut est donc exercé par un **témoin positif** explicite : le même scénario sans aucune
faute armée doit rendre `nouveau` sur les vingt-quatre blocs. Sans lui, un oracle devenu incapable
de rendre ce verdict passerait inaperçu. Le fait est épinglé plutôt que tu :
`tests/unit/vm-crash-cadence.test.mjs` rougit si un jour un genre de coupure postérieur à la
dernière barrière est ajouté.

## Les trois candidats, mesurés

`tools/mesurer-generations.mjs` fait passer le MÊME travail par trois modèles qui écrivent
réellement dans le double calibré de `FileSystemSyncAccessHandle`. Les octets comptés sont ceux que
le support a acceptés, pas une estimation.

Relevé du 2026-08-27, volume logique de 512 Kio (1024 blocs de 512 octets), 128 générations de 32
écritures, soit 2 Mio écrits par le guest :

| Mécanisme                                     | Surcoût d'écriture | Barrières par génération | Espace en plus | Octets relus |
| --------------------------------------------- | -----------------: | -----------------------: | -------------: | -----------: |
| (a) Journal d'intention, racine alternée      |              ×2,06 |                      2,1 |       34 816 o |  2 162 688 o |
| (b) Copie-sur-écriture, table à double racine |              ×1,12 |                      2,0 |       41 984 o |          0 o |
| (c) Ombre par génération                      |             ×33,03 |                      2,0 |    1 049 088 o | 67 108 864 o |

Sur une charge plus courte (128 Kio logiques, 16 générations de 32 écritures, sans point de
contrôle) : (a) ×2,07 et 271 360 o d'espace, (b) ×1,07 et 35 840 o, (c) ×9,03 et 262 656 o. Le
surcoût de (c) croît avec la TAILLE DU VOLUME, pas avec le travail : sur le volume applicatif de 512
Mio, une seule génération coûterait 512 Mio de recopie. Il est écarté sans autre examen.

Restent (a) et (b). **(b) écrit moins**, et c'est réel. Ce qui l'élimine tout de même :

1. **Il change la disposition du VOLUME.** Une table logique → physique signifie que le fichier du
   volume n'est plus l'image du disque du guest. Or `docs/architecture.md` pose que « les octets du
   volume sont servis tels quels à v86 » ; l'export (#11) diffuse ce fichier en flux et empreinte ce
   qu'il lit, la restauration (#12) le réécrit tel quel et vérifie l'empreinte relue, la migration
   (#13) le relit pour l'attester. Les trois reposent sur l'identité entre le fichier et l'image.
   Passer à (b) serait donc un **format de VOLUME v3**, avec réécriture du format d'archive
   (ADR 0008) pour qu'il exporte une image reconstruite, et invalidation des preuves de #11, #12 et
   #13.
2. **Il demande un allocateur.** Blocs libres, réemploi, ramasse-miettes des blocs d'une génération
   abandonnée : autant de code dont aucune ligne n'est exigée par le résultat de #16.
3. **Sa table doit être relue à l'ouverture.** Quatre octets par bloc logique, doublés : 4 Mio de
   table pour le volume applicatif de 512 Mio, contre les seuls octets en attente pour (a). Le
   budget « dernière génération valide trouvée en ≤ 60 s » n'est menacé par aucun des deux, mais (a)
   lit moins.

Le surcoût de (a) est un facteur deux sur les octets ÉCRITS entre deux barrières. Ce que ce facteur
coûte réellement est borné par une mesure existante : l'ADR 0005 a décomposé la reprise et conclut
que « le backend OPFS n'est pas le goulot — le montage du disque applicatif adossé à OPFS coûte ~65
ms » sur un boot de ~92 s dominé à 79 % par le CPU émulé de Rails. Doubler des octets qui ne pèsent
pas 0,1 % du budget ne le déplace pas.

## Décision

**Une génération est déposée dans un fichier VOISIN du volume, `<volume>.gen`, et validée par
l'écriture d'une RACINE d'un seul secteur.**

Le volume, lui, ne change ni de format ni de disposition : il reste l'image que v86 lit. Aucun
format v3 n'est introduit — ni pour le volume, ni pour le manifeste (voir plus bas).

### Le protocole, et son ordre

1. **DÉPOSER.** Une écriture du guest va dans le journal : un en-tête de 16 octets — offset logique,
   longueur — suivi de la charge. Le volume n'est pas touché. Un index en mémoire, à la granularité
   du secteur, permet à l'écrivain de se relire : v86 exige cette cohérence de session, et un guest
   qui ne relirait pas ce qu'il vient d'écrire ne monterait aucun système de fichiers.
2. **VALIDER**, à la barrière. La charge est franchie par une barrière du support, PUIS la racine
   est écrite, PUIS une seconde barrière. L'ordre est le contrat : sans la première barrière, un
   support pourrait rendre la racine durable avant les octets qu'elle scelle, et la relecture
   REFUSERAIT une génération que rien n'obligeait à perdre. C'est au retour de ce geste, et pas
   avant, que la barrière du guest est acquittée.
3. **POINT DE CONTRÔLE.** La charge validée est recopiée dans le volume, franchie par une barrière,
   puis le journal est vidé. Ce geste ne valide rien et ne promet rien de neuf — les octets étaient
   déjà durables. Il est amorti : il n'a lieu qu'au-delà de 8 Mio de charge, et à la fermeture
   propre du volume.

   Il est APRÈS l'acquittement, et il n'est **pas attendu**. La nuance vient de la revue de cette
   PR, qui a relevé qu'une première version disait vrai de la mauvaise chose : le rangement était
   bien après l'acquittement de la DURABILITÉ, mais il courait dans la promesse de `flush()` — donc
   avant que `v86-buffer-adapter` ne lève `BSY` et n'émette l'IRQ. Le guest restait bloqué pendant
   la relecture, la réécriture de plusieurs mébioctets et la barrière du volume. Le rangement est
   donc lancé et laissé courir ; toute E/S ultérieure l'attend, parce qu'il tronque le journal et
   vide l'index — deux choses qu'une écriture concurrente ne survivrait pas. Sa durée maximale est
   mesurée et publiée (`dureeRangementMaxMs`) : un coût que personne ne mesure finit par être
   supposé nul.

   Son échec, enfin, ne remonte pas au guest : la barrière a abouti, les octets sont durables dans
   le journal, et la prochaine ouverture les rejouera. Le dire au guest signifierait « ta barrière a
   échoué » alors qu'elle a réussi — un mensonge dans le sens inverse de celui que `SEC-DURABLE-001`
   interdit, et qui tuerait la session pour un geste de rangement. L'échec est journalisé, publié
   par `dernierRangement`, et se signale de lui-même : un journal qui ne se vide plus atteint son
   plafond.

4. **RÉCUPÉRER**, à l'ouverture. Voir plus bas.

Ce mécanisme se distingue explicitement de l'alternative que l'ADR 0003 avait déjà rejetée — «
émuler la durabilité par un `flush` implicite après chaque écriture » : ici aucune barrière n'est
émise que le guest n'ait demandée, et le nombre de barrières du GUEST est inchangé. Ce qui double,
c'est le nombre de barrières du SUPPORT par barrière du guest, de une à deux.

### La commutation tient dans un secteur, et l'atomicité sectorielle n'est pas supposée

La racine occupe 512 octets, la plus petite unité que le matériel émulé adresse. Une écriture d'un
seul secteur est le geste le plus proche de l'atomicité que le support offre — mais **rien dans la
spécification de `FileSystemSyncAccessHandle` ne garantit qu'une écriture de 512 octets est
indivisible.** C'est une hypothèse, elle est écrite ici, et elle n'est pas subie :

- la racine porte la somme de contrôle de son propre en-tête. Une racine écrite à moitié est
  DÉTECTÉE et n'est pas une racine ;
- **les racines alternent.** Chaque écriture de racine porte un numéro de séquence monotone et
  occupe l'emplacement `sequence % 2`. Valider la génération suivante n'écrase donc **pas** la
  racine qui fait autorité, et une validation interrompue laisse intacte celle qu'elle remplaçait —
  sans quoi une écriture acquittée pourrait disparaître, c'est-à-dire une violation de
  `SEC-DURABLE-001`.

  **« Pas », et non « jamais ».** La propriété repose sur une HYPOTHÈSE, et la revue a eu raison de
  refuser qu'elle reste implicite : refuser l'atomicité sectorielle tout en plaçant les deux racines
  dans la même page hôte de 4 Kio aurait supposé gratuitement qu'une écriture ne peut pas abîmer le
  secteur voisin de sa propre page — ce que rien ne garantit sur un support qui réécrit une page
  entière pour modifier un secteur. Les deux emplacements sont donc séparés par **une page hôte**
  (`PAGE_HOTE_OCTETS`, 4096 octets), et non par un secteur. L'hypothèse qui reste — _deux pages
  hôtes distinctes ne sont pas abîmées par la même écriture_ — est écrite ici. Ce qui est ÉPROUVÉ,
  c'est l'écart des emplacements (`tests/unit/vm-generation-store.test.mjs`) ; la propriété du
  support, elle, ne peut pas l'être depuis JavaScript, et ce format ne prétend pas le contraire ;

- au-delà de l'en-tête, le secteur est une réserve de zéros. Une déchirure qui n'atteint que cette
  réserve ne fait rien perdre, et `tests/unit/vm-generation-format.test.mjs` l'écrit plutôt que de
  le laisser découvrir en production.

La somme de contrôle est un CRC-32. Elle détecte la déchirure et l'octet retourné ; elle ne prétend
RIEN contre un altérateur volontaire, qui la recalculerait sans difficulté. L'authentification d'un
bloc (`SEC-BLOCK-001`, #18) et le refus de rejeu (`SEC-GEN-001`, #19) sont du jalon 4. Ce format
leur laisse la place — un enregistrement porte déjà son offset et sa longueur, et la racine porte
déjà un numéro de génération —, il ne la prend pas.

### La récupération a quatre issues, et aucune n'est muette

À l'ouverture, la racine valide de plus haute séquence fait autorité.

| Ce qui est trouvé                                 | Ce qui est fait                                           | Ce qui est publié                       |
| ------------------------------------------------- | --------------------------------------------------------- | --------------------------------------- |
| Journal vierge et vide                            | RIEN — pas même une écriture (voir plus bas)              | `etat: "aucune"`                        |
| Une charge que nulle racine ne scelle             | elle est ÉCARTÉE, le volume n'est pas touché              | `VAULT_STORAGE_GENERATION_DISCARDED`    |
| Une charge scellée et concordante                 | elle est REJOUÉE dans le volume, puis le journal est vidé | `etat: "rejouee"`, sa génération        |
| Une charge scellée dont la somme ne concorde plus | l'ouverture est REFUSÉE                                   | `VAULT_STORAGE_GENERATION_CORRUPT`      |
| Aucune racine LISIBLE, mais au moins une ABÎMÉE   | l'ouverture est REFUSÉE                                   | `VAULT_STORAGE_GENERATION_ROOT_CORRUPT` |

La dernière ligne est un ajout de la revue, et elle comble un trou réel : le magasin jetait la
distinction VIERGE / ABÎMÉE que `decoderRacine` fournit pourtant, si bien que deux racines
illisibles au-dessus d'une charge donnaient `ecartee` — présenté comme « l'issue normale d'une
coupure ». Or l'une de ces racines a pu sceller une génération ACQUITTÉE : ce qui a été validé est
alors **inconnu**, et l'écarter perdrait peut-être une écriture durable. Un secteur jamais écrit,
lui, n'est pas une avarie : c'est l'état normal du second emplacement tant qu'aucune alternance n'a
eu lieu.

**Une ouverture qui n'a rien à récupérer n'écrit RIEN**, pas même la racine initiale. Cette
précision-là n'est pas cosmétique : tout ouvreur passe par la récupération, y compris les chemins
purement LECTEURS — l'export (#11) et le calcul d'empreinte. Une racine vide écrite à chaque
ouverture aurait fait échouer un export sur un support saturé, c'est-à-dire le geste même par lequel
l'utilisateur libère de la place. La racine initiale est écrite au premier dépôt, quand une écriture
a réellement lieu. Ce que les chemins lecteurs écrivent tout de même, et qu'il faut assumer : une
génération validée EN ATTENTE est rejouée dans le volume avant toute lecture — c'est précisément ce
qui fait que l'export porte la dernière génération validée, et cela vaut aussi pour un volume
anonyme.

Le cas de la charge incohérente mérite d'être dit en clair : une génération VALIDÉE dont les octets
manquent ou ne concordent plus n'est pas réparable par déduction. La rejouer à moitié écrirait dans
le volume un état que personne ne sait cohérent ; l'ignorer perdrait une écriture acquittée. Le
refus nomme le volume, la génération et la raison exacte, et renvoie vers la restauration d'une
sauvegarde (#12) — **pas** vers une réparation devinée.

Aucune génération validée n'est jamais réécrite sans nouvelle barrière : le rejeu écrit le volume,
franchit sa barrière, PUIS seulement vide le journal.

### Où vit la récupération, et pourquoi pas seulement dans `openVolumeForWrite`

La Definition of Ready de #16 la plaçait dans `openVolumeForWrite`, au titre du « point unique » de
l'ADR 0009. Elle est en réalité dans **`openOpfsVolume`**, et `openVolumeForWrite` en hérite.

La raison est celle que l'ADR 0009 énonce lui-même : « treize appels directs subsistent dans le code
de production, et rien dans l'outillage n'empêche un nouveau chemin d'en ajouter un […] c'est une
discipline de revue, pas une contrainte du code ». Poser la récupération au seul ouvreur en écriture
aurait laissé douze chemins — dont l'export et le calcul d'empreinte — lire un volume dont la
dernière génération validée n'est pas encore appliquée. L'export aurait alors exporté un état
ANTÉRIEUR à la dernière barrière acquittée, silencieusement. `openOpfsVolume` est le point que
personne ne contourne ; la règle de l'ADR 0009 n'est ni affaiblie ni élargie par ce choix.

### Trois chemins n'ouvrent PAS de génération, et le disent

La préparation d'un volume depuis l'image de référence et la restauration d'une archive (#12)
écrivent un volume ENTIER, bloc après bloc, avec une seule barrière à la fin. Ce ne sont pas des
générations du guest, et elles portent déjà leur propre atomicité : le manifeste est révoqué avant
la première mutation et n'est inscrit qu'après relecture depuis le support, si bien qu'une opération
interrompue laisse un volume NON IDENTIFIÉ que le boot refuse (ADR 0009). Empiler le journal
par-dessus doublerait les écritures de plusieurs centaines de mébioctets et buterait sur le plafond
de charge, sans rien garantir de plus.

Ces chemins ouvrent donc avec `transactionnel: false`, et `describe().transactionnel` le publie : un
banc ne peut pas se croire transactionnel sans l'être. Ils RETIRENT en revanche le journal voisin
avant d'écrire — y laisser la génération du volume d'avant ferait rejouer, au premier boot suivant,
des octets qui n'appartiennent pas au volume restauré.

La MIGRATION (#13), elle, reste transactionnelle : elle conserve le contenu du volume, et un journal
en attente doit y être rejoué avant toute mutation, sous peine de perdre une écriture acquittée.

### Le manifeste reste en format v2

La Definition of Ready demandait que « la génération validée soit nommable », et posait qu'un
nouveau champ du manifeste vaudrait format v3. **Le manifeste ne bouge pas**, et la génération
validée est nommée par la racine du journal — publiée par `describe().generation` et par le compte
rendu de récupération.

Trois raisons, dont deux sont déjà écrites dans le dépôt :

1. l'ADR 0011 pose que « le manifeste décrit l'IDENTITÉ du volume — format, runtime, application,
   géométrie, empreinte —, pas l'HISTOIRE des gestes qu'on lui a appliqués ». Un compteur qui
   changerait à chaque barrière est exactement une histoire ;
2. l'ADR 0009 pose que `identity.digest` « atteste l'état restauré, c'est-à-dire la provenance […]
   Il n'atteste pas l'état courant », et qu'une évolution le comparant au contenu « supposerait
   d'abord un moyen de le mettre à jour à chaque barrière » ;
3. le coût. Inscrire la génération dans le manifeste ajouterait, à CHAQUE barrière du guest, une
   réécriture complète d'un fichier voisin et sa barrière — et surtout un risque nouveau : un
   manifeste déchiré rend le volume NON IDENTIFIÉ, donc non bootable. Faire dépendre l'identité du
   volume du chemin le plus chaud échangerait une garantie contre une fragilité.

Aucun format v3 n'est donc introduit, ni pour le manifeste ni pour le volume. `MIN_READABLE` et
`MIN_WRITER` sont inchangés, la chaîne de migration de #13 n'a pas de nouvelle étape, et aucun
volume existant n'est refusé. Le journal de génération, lui, porte sa PROPRE version de format —
`GENERATION_FORMAT = 1` —, indépendante de celle du manifeste comme l'est déjà celle du journal de
migration ; une racine d'un format inconnu n'est pas une racine, et la génération qu'elle scellerait
est écartée.

### Le nommage réserve un suffixe court, et ne rétrécit pas les noms de volume

`<volume>.gen` rejoint `.manifest` et `.migration` dans `RESERVED_SIDECAR_SUFFIXES`. Le suffixe est
délibérément court : `MAX_VOLUME_NAME` se déduit du PLUS LONG suffixe réservé, et `.migration` fait
déjà dix caractères. Un suffixe plus long aurait rétréci les noms de volume admissibles —
c'est-à-dire cassé une compatibilité de nommage pour un fichier interne. `MAX_VOLUME_NAME` reste
à 54.

`removeOpfsVolume` retire désormais le journal de génération avec le volume. Ce n'est pas une
commodité : un journal survivant décrirait un volume qui n'existe plus, et l'ouverture d'un volume
du même nom y rejouerait une génération validée qui ne lui appartient pas.

## Erreurs ajoutées

| Code                                    | Quand                                                              | Remède                              |
| --------------------------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| `VAULT_STORAGE_GENERATION_DISCARDED`    | une génération déposée sans validation a été écartée à l'ouverture | aucun : c'est l'issue normale       |
| `VAULT_STORAGE_GENERATION_CORRUPT`      | une génération validée dont la charge ne concorde plus             | restaurer une sauvegarde (#12)      |
| `VAULT_STORAGE_GENERATION_OVERFLOW`     | la génération en cours dépasse le plafond du journal               | le guest doit franchir une barrière |
| `VAULT_STORAGE_GENERATION_PENDING`      | un point de contrôle demandé sur une génération non validée        | faute de programmation              |
| `VAULT_STORAGE_GENERATION_ROOT_CORRUPT` | aucune racine lisible, au moins une abîmée                         | restaurer une sauvegarde (#12)      |

Le premier n'est pas levé : il est PUBLIÉ dans le compte rendu de récupération. Une mise au rebut
est le résultat normal d'une coupure, pas une panne — mais elle doit être nommée, sans quoi elle
serait le succès silencieux que `docs/quality-attributes.md` refuse.

## Mesures

Matrice de #15, avant et après, **sur la même cadence et la même matrice** — vingt-quatre blocs
distincts, une barrière tous les huit, huit points de coupure. Ce qui change entre les deux colonnes
n'est pas le travail mesuré mais le mécanisme, et l'ORACLE, qui sait désormais nommer les
générations intermédiaires au lieu de les ranger dans `melange` :

| Support                              | Avant (#15) | Après (#16) |
| ------------------------------------ | ----------: | ----------: |
| Double calibré (Node), graine 2026   |      12,5 % |   **100 %** |
| Double calibré (Node), graine 7      |         n/a |   **100 %** |
| Double calibré (Node), graine 424242 |         n/a |   **100 %** |

Répartition des verdicts après, huit points :

| Graine   | `ancien` | `generation-1` | `generation-2` | `nouveau` | `melange` | `corrompu` |
| -------- | -------: | -------------: | -------------: | --------: | --------: | ---------: |
| `2026`   |        4 |              3 |              1 |         0 |         0 |          0 |
| `7`      |        3 |              3 |              2 |         0 |         0 |          0 |
| `424242` |        3 |              3 |              2 |         0 |         0 |          0 |

Aucun bloc déchiré, aucun bloc non rattachable, sur aucune des trois graines. L'extrême bas et les
DEUX générations intermédiaires sont exercés sur chacune ; le zéro de la colonne `nouveau` n'est pas
un manque du mécanisme mais une propriété de la matrice, démontrée plus haut, et l'extrême haut est
couvert par un témoin positif.

**Ce que la mesure vaut est établi par mutation**, et c'est le point le plus important de cette
section. Un taux de 100 % ne prouve rien tant qu'on n'a pas montré qu'il sait descendre :

| Magasin                                         | Graine 2026 | Graine 7 | Graine 424242 |
| ----------------------------------------------- | ----------: | -------: | ------------: |
| Sain                                            |       **1** |    **1** |         **1** |
| Mutant : perd les générations après la première |       0,875 |     0,75 |          0,75 |
| Mutant : les perd toutes                        |         0,5 |    0,375 |         0,375 |

Les deux mutants acquittent au guest — la barrière du support est franchie, le `flush-ack` remonte —
puis ne scellent rien. Les points qu'ils trahissent tombent en `corrompu` par la règle
`SEC-DURABLE-001`, avec les blocs nommés. Les points qu'ils ne trahissent PAS — ceux coupés avant la
barrière qu'ils honorent encore — rendent le même verdict qu'un magasin sain, et c'est pourquoi le
taux ne tombe pas à zéro : il n'y a rien à trahir quand rien n'a été promis. Cette borne est écrite
dans l'épreuve elle-même.

## Limites

1. **La perte de cache volatil n'est pas couverte.** `Worker.terminate()` ne tue ni le processus du
   navigateur ni la machine ; le double calibré, lui, matérialise chaque octet accepté. Ni l'un ni
   l'autre ne produit la perte d'une écriture non barriérée. C'est la limite que #15 avait déjà
   inscrite ; #16 ne la lève pas. Ce que #16 change, c'est qu'une telle perte ne PEUT plus produire
   un mélange : les octets non validés sont dans le journal, et une charge incomplète est écartée.
2. **L'écriture concurrente reste hors périmètre.** Le bail de #8 garantit un unique écrivain, et le
   journal de génération n'est protégé que par l'exclusivité du handle.
3. **Ni chiffrement ni authentification.** Le journal est en clair, comme le manifeste et le journal
   de migration. Un altérateur qui a accès à OPFS peut fabriquer une racine valide.
4. **La récupération n'est pas bornée en mémoire, et sa durée n'est pas mesurée.** `#relireCharge`
   lit la charge validée d'un seul tenant : au plafond, une récupération alloue jusqu'à ~128 Mio —
   la charge entière plus les tranches rejouées. Aucun relevé n'en approche (90 304 octets mesurés
   de bout en bout), mais rien ne le borne, et le budget « dernière génération valide trouvée en ≤
   60 s » de `docs/quality-attributes.md` n'est **mesuré nulle part**. Suivi : **issue #91**.
5. **Le plafond de charge est un refus, pas une dégradation.** Un guest qui n'émettrait jamais de
   barrière verrait ses écritures refusées au-delà de 64 Mio. Le chiffre reste un garde-fou choisi
   par analogie avec la surmémoire de streaming, **pas un seuil calibré** : le scénario Bout en bout
   a mesuré **90 304 octets** déposés entre la première barrière acquittée de Rails et la coupure,
   soit près de trois ordres de grandeur sous le plafond — mais treize écritures d'un boot ne sont
   pas la plus grande génération que l'image de référence puisse produire, et personne n'a mesuré
   celle-là. Travail découvert.
6. **Le surcoût d'écriture n'est pas mesuré de bout en bout sur l'image de référence.** Le ×2 est
   mesuré sur le banc ; ce qu'il devient sur un boot Rails complet dépend de la cadence réelle des
   `fsync` du guest, et le bruit de mesure de la machine de développement (~16-17 % d'étendue
   intra-série, `docs/quality-attributes.md`) ne permet pas de conclure sur `test:rythme`.

## Ce qui est explicitement réservé

- Le bloc authentifié (`SEC-BLOCK-001`, #18) et le refus de rejeu (`SEC-GEN-001`, #19), jalon 4. La
  racine porte déjà un numéro de génération monotone ; un enregistrement porte déjà son adresse. Les
  deux invariants du jalon 4 s'y greffent en remplaçant le CRC par une authentification, sans
  changer le protocole des quatre gestes.
- L'instantané de reprise (#65), qui exigera de lier une capture mémoire à une génération nommée :
  `describe().generation` la nomme désormais.
- La « migration sur une nouvelle génération copy-on-write » de `docs/release-policy.md` reste
  ouverte. Cet ADR ne la fournit pas : la migration mute toujours en place, et son atomicité reste
  celle de l'ADR 0011.

## Alternatives rejetées

- **Ombre par génération.** Écartée par la mesure : le coût croît avec la taille du volume et non
  avec le travail. ×33 sur un banc de 512 Kio, 512 Mio de recopie par barrière sur le volume
  applicatif.
- **Copie-sur-écriture à table de blocs et double racine.** Écrit moins (×1,12 contre ×2,06), et
  c'est réel. Écartée parce qu'elle change la disposition du volume, ce dont dépendent l'export
  (#11), la restauration (#12) et la migration (#13) : elle imposerait un format de volume v3 et la
  réécriture du format d'archive de l'ADR 0008. Ce coût de compatibilité n'est pas exigé par le
  résultat de #16. Elle reste le candidat naturel si un jour le surcoût d'écriture devient un goulot
  mesuré.
- **Inscrire la génération validée dans le manifeste.** Écartée : le manifeste décrit une identité,
  pas une histoire (ADR 0011), et une réécriture par barrière ferait dépendre l'identité du volume
  du chemin le plus chaud.
- **Changer la charge de travail mesurée plutôt que l'oracle.** C'est ce que cette tranche a essayé
  d'abord — huit blocs réécrits trois fois —, et c'est **rejeté**. Le raisonnement paraissait sûr :
  laisser le juge intact semblait la seule façon de ne pas déplacer la barre. Il était faux, et une
  mutation l'a montré : à contenu identique d'une passe à l'autre, un magasin qui acquitte les
  générations 2 et 3 puis les perd laisse le même volume qu'un magasin correct, et la matrice reste
  à 100 %. Un juge inchangé sur une charge appauvrie ne mesure pas moins qu'un juge élargi — il ne
  mesure plus rien. L'alternative RETENUE est donc l'inverse : étendre l'oracle à la suite des
  générations attendues du scénario, en le rendant strictement plus discriminant, et garder les
  vingt-quatre blocs distincts de #15.
- **Un `flush` implicite après chaque écriture.** Déjà rejetée par l'ADR 0003 — « coûteux, et faux
  ». Ce mécanisme ne l'introduit pas : le nombre de barrières demandées par le GUEST est inchangé.

## Risques et conditions d'abandon

- Si une mesure de bout en bout sur l'image de référence montre que le ×2 d'écriture dégrade la
  reprise au-delà du bruit, la copie-sur-écriture redevient le candidat, avec son coût de
  compatibilité assumé et un format de volume v3.
- Si un support rend durable une racine avant sa charge malgré la barrière intermédiaire, la
  récupération refusera des générations qu'elle aurait pu rejouer. Le refus reste sûr ; sa fréquence
  serait le signal.
- Si le plafond de charge est atteint sur une charge réelle, le refus est bruyant mais bloquant pour
  le guest. Une mesure de la taille réelle d'une génération de l'image de référence est du travail
  découvert.
