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

## Ce que la cadence de mesure de #15 rendait impossible

Avant de choisir un mécanisme, il a fallu constater un défaut de la MESURE, et le dire.

Le scénario de #15 écrit vingt-quatre blocs DISTINCTS avec une barrière tous les huit : trois
générations, dont chacune ne touche qu'un tiers du volume. Or l'oracle ne connaît que deux états de
référence — « tout l'ancien » et « tout le nouveau ». Une génération intermédiaire VALIDÉE y est
donc, par construction, un `melange`.

La conséquence n'est pas une opinion, elle se calcule. `tests/unit/vm-crash-cadence.test.mjs`
applique à la matrice réelle un mécanisme PARFAIT — un mécanisme qui rendrait visible toute
génération dont la barrière est acquittée, et rien d'autre — et obtient la borne SUPÉRIEURE de ce
que #16 pouvait atteindre :

| Graine | Borne supérieure, cadence de #15 | Borne supérieure, cadence retenue |
| ------ | -------------------------------: | --------------------------------: |
| 2026   |                         **50 %** |                         **100 %** |
| 7      |                       **37,5 %** |                         **100 %** |
| 424242 |                       **37,5 %** |                         **100 %** |

Le « 100 % sur la même matrice » demandé par #16 était donc **inatteignable** avec cette cadence,
non par faiblesse d'un mécanisme mais parce que `SEC-DURABLE-001` OBLIGE à publier les générations
intermédiaires — les huit premiers blocs sont acquittés ET franchis par une barrière —, et que
l'oracle ne sait ni les nommer « ancien » ni les nommer « nouveau ».

**L'oracle n'est pas modifié.** Le juge reste identique, et il reste sévère : c'est lui qui refuse
un bloc non rattachable, lui qui classe `corrompu` une écriture acquittée puis barriérée qui aurait
disparu, lui qui exige le journal de la session morte. Le rendre plus généreux aurait été la seule
façon de faire mentir la mesure.

C'est la CHARGE DE TRAVAIL mesurée qui change : le scénario suit désormais **huit blocs réécrits
trois fois**, de sorte que toute génération validée porte l'état complet, c'est-à-dire l'un des deux
états que l'oracle sait juger. Les trois nombres qui décident de la matrice de coupures —
vingt-quatre écritures, trois barrières, blocs de 512 octets — sont **inchangés** : la matrice est
identique point pour point, et `tests/unit/vm-crash-cadence.test.mjs` l'épingle.

La nouvelle cadence est aussi plus exigeante sur un point : elle réécrit le MÊME bloc d'une
génération à l'autre, c'est-à-dire le régime que l'en-tête de `crash-oracle.mjs` désigne comme « le
régime même de #16 ». Une génération qui écrit, franchit sa barrière, puis réécrit le même bloc sans
barrière est précisément le cas où un mécanisme bâclé perdrait une écriture acquittée.

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
   déjà durables. Il est donc APRÈS l'acquittement, jamais sur son chemin, et amorti : il n'a lieu
   qu'au-delà de 8 Mio de charge, et à la fermeture propre du volume.
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
  occupe l'emplacement `sequence % 2`. Valider la génération suivante n'écrase donc jamais la racine
  qui fait autorité. Une validation interrompue laisse intacte celle qu'elle remplaçait — sans quoi
  une écriture acquittée pourrait disparaître, c'est-à-dire une violation de `SEC-DURABLE-001` ;
- au-delà de l'en-tête, le secteur est une réserve de zéros. Une déchirure qui n'atteint que cette
  réserve ne fait rien perdre, et `tests/unit/vm-generation-format.test.mjs` l'écrit plutôt que de
  le laisser découvrir en production.

La somme de contrôle est un CRC-32. Elle détecte la déchirure et l'octet retourné ; elle ne prétend
RIEN contre un altérateur volontaire, qui la recalculerait sans difficulté. L'authentification d'un
bloc (`SEC-BLOCK-001`, #18) et le refus de rejeu (`SEC-GEN-001`, #19) sont du jalon 4. Ce format
leur laisse la place — un enregistrement porte déjà son offset et sa longueur, et la racine porte
déjà un numéro de génération —, il ne la prend pas.

### La récupération a trois issues, et aucune n'est muette

À l'ouverture, la racine valide de plus haute séquence fait autorité.

| Ce qui est trouvé                                 | Ce qui est fait                                           | Ce qui est publié                    |
| ------------------------------------------------- | --------------------------------------------------------- | ------------------------------------ |
| Aucune charge en attente                          | rien ; le volume EST la dernière génération validée       | `etat: "aucune"`                     |
| Une charge que nulle racine ne scelle             | elle est ÉCARTÉE, le volume n'est pas touché              | `VAULT_STORAGE_GENERATION_DISCARDED` |
| Une charge scellée et concordante                 | elle est REJOUÉE dans le volume, puis le journal est vidé | `etat: "rejouee"`, sa génération     |
| Une charge scellée dont la somme ne concorde plus | l'ouverture est REFUSÉE                                   | `VAULT_STORAGE_GENERATION_CORRUPT`   |

Le dernier cas mérite d'être dit en clair : une génération VALIDÉE dont les octets manquent ou ne
concordent plus n'est pas réparable par déduction. La rejouer à moitié écrirait dans le volume un
état que personne ne sait cohérent ; l'ignorer perdrait une écriture acquittée. Le refus nomme le
volume, la génération et la raison exacte, et renvoie vers la restauration d'une sauvegarde (#12) —
**pas** vers une réparation devinée.

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

| Code                                 | Quand                                                              | Remède                              |
| ------------------------------------ | ------------------------------------------------------------------ | ----------------------------------- |
| `VAULT_STORAGE_GENERATION_DISCARDED` | une génération déposée sans validation a été écartée à l'ouverture | aucun : c'est l'issue normale       |
| `VAULT_STORAGE_GENERATION_CORRUPT`   | une génération validée dont la charge ne concorde plus             | restaurer une sauvegarde (#12)      |
| `VAULT_STORAGE_GENERATION_OVERFLOW`  | la génération en cours dépasse le plafond du journal               | le guest doit franchir une barrière |
| `VAULT_STORAGE_GENERATION_PENDING`   | un point de contrôle demandé sur une génération non validée        | faute de programmation              |

Le premier n'est pas levé : il est PUBLIÉ dans le compte rendu de récupération. Une mise au rebut
est le résultat normal d'une coupure, pas une panne — mais elle doit être nommée, sans quoi elle
serait le succès silencieux que `docs/quality-attributes.md` refuse.

## Mesures

Matrice de #15, avant et après, sur la même graine et le même nombre de points :

| Support                              | Avant (#15) | Après (#16) |
| ------------------------------------ | ----------: | ----------: |
| Double calibré (Node), graine 2026   |      12,5 % |   **100 %** |
| Double calibré (Node), graine 7      |         n/a |   **100 %** |
| Double calibré (Node), graine 424242 |         n/a |   **100 %** |

Répartition des verdicts après, huit points : graine 2026 — 4 `ancien`, 4 `nouveau`, 0 `melange`, 0
`corrompu` ; graines 7 et 424242 — 3 `ancien`, 5 `nouveau`. Aucun bloc déchiré, aucun bloc non
rattachable, sur aucune des trois graines. Les DEUX issues sont exercées sur chacune : une matrice
qui ne rendrait que « ancien » serait satisfaite par un backend qui n'écrirait rien du tout.

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
4. **Le plafond de charge est un refus, pas une dégradation.** Un guest qui n'émettrait jamais de
   barrière verrait ses écritures refusées au-delà de 64 Mio. Aucune mesure n'a été prise sur une
   génération de l'image de référence : le chiffre est un garde-fou choisi par analogie avec la
   surmémoire de streaming, pas un seuil calibré. C'est du travail découvert.
5. **Le surcoût d'écriture n'est pas mesuré de bout en bout sur l'image de référence.** Le ×2 est
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
- **Rendre l'oracle de #15 conscient des générations.** Écartée sans hésitation. C'était la solution
  la plus courte, et elle aurait consisté à élargir le juge pour qu'il accepte ce que le mécanisme
  produit. Changer la charge de travail mesurée, en laissant le juge intact et la matrice identique,
  est le seul chemin qui ne déplace pas la barre.
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
