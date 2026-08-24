# ADR 0005 — La reprise se qualifiera par un instantané lié à une génération arrêtée, et le gate reste fermé d'ici là

- Statut : accepté
- Date : 2026-08-24
- Issue : #60 · Invariant : `VAULT-PERSIST-001` · Jalon 1

## Contexte

`docs/quality-attributes.md` fixe une **cible de reprise locale au MVP : p95 ≤ 60 s**, et pose que
tout dépassement « exige un ADR avant qualification produit » plutôt qu'un abaissement silencieux du
seuil. La première mesure sur le backend OPFS (#7) a relevé, sur la machine de développement, **p50
94,5 s et p95 162,1 s** — un dépassement franc. Le troisième essai de #7 (162 s) était un point
isolé, attribué à une contention machine ou à un ramasse-miettes, que le protocole à dix essais de
l'environnement de référence devait départager.

Cet ADR tranche la qualification. Il ne demande pas d'atteindre la cible ici : il établit **d'où
vient le temps de reprise**, quelle voie peut le ramener sous 60 s, à quelles conditions de sûreté,
et **il maintient le gate fermé** tant que cette voie n'est pas construite et mesurée sur
l'environnement de référence.

## Décomposition mesurée

La décomposition n'est pas un modèle : c'est une instrumentation additionnelle du banc de reprise
(`public/vm/reference-worker.mjs`, `src/vm/reference-guest-session.mjs`) qui horodate des événements
**réellement observés** — jalons `performance.now()` côté hôte et repères lus dans le flux série
brut du guest (les lignes que `guest-init.sh` imprime avant le pont `@VLT1`). Un jalon jamais
atteint reste `null` ; aucune valeur n'est estimée. Le brut est publié dans
`reports/e2e/reprise-boot-froid.json` (champ `repriseTimeline`, un objet par reprise).

**Relevé du 2026-08-24, `npm run test:e2e`, Chromium sous Playwright.** Comme le relevé de #7, **ce
n'est pas l'environnement de référence** (`docs/quality-attributes.md` : 4 cœurs, 16 Gio, dix essais
après échauffement) mais la machine de développement (Windows 11, Node 24.14.0, win32 x64), trois
reprises à froid. Les proportions sont l'acquis transférable ; les valeurs absolues valent comme
ordre de grandeur. Sur la machine de référence, plus lente, on attend des durées **plus longues**,
pas plus courtes.

Reprise à froid, décomposition depuis l'instant où v86 démarre (`emulator.run()`) jusqu'à la
première réponse `200` de `/vault/health`. Valeurs représentatives des trois essais (min–max) :

| Étape                                                    |     Durée | Part de la reprise |
| -------------------------------------------------------- | --------: | -----------------: |
| Instanciation v86 + WebAssembly + contrôleur IDE         |   ~130 ms |             ~0,1 % |
| BIOS (SeaBIOS) → premier octet série                     |    ~3,4 s |             ~3,7 % |
| Boot noyau → init en espace utilisateur (montage `/app`) |   ~15,5 s |              ~17 % |
| Montage du disque applicatif OPFS (`/dev/sdb`)           |    ~65 ms |             ~0,1 % |
| Lancement de l'app → pont série actif                    |     ~3 ms |           ~0,003 % |
| **Boot Puma/Rails → première réponse `/vault/health`**   | **~73 s** |          **~79 %** |
| **Total reprise (`healthMilliseconds`)**                 | **~92 s** |          **100 %** |

Trois faits portent la décision :

1. **Le boot de Puma/Rails domine, à ~79 % du temps.** C'est l'i386 émulé qui exécute le démarrage
   de Ruby, le chargement anticipé de Rails et l'ouverture de SQLite/ActiveStorage — sur un seul
   cœur émulé, sans accélération matérielle. Le noyau lui-même ne « voit » que ~5 s s'écouler
   (`noyauDmesgDernierSec` ≈ 4,8), là où l'horloge murale en compte ~15 : l'émulation dilate le
   temps CPU du guest.

2. **Le backend OPFS n'est pas le goulot.** Le montage du disque applicatif adossé à OPFS coûte ~65
   ms. L'hypothèse de #7 (« le surcoût vient de ce que le disque est servi depuis OPFS et non depuis
   la RAM ») est ainsi **infirmée pour la part dominante** : le rootfs porteur de Ruby et des gemmes
   est un tampon en RAM (`hda`), seul le disque applicatif (`hdb` : SQLite, pièce jointe) est sur
   OPFS, et les lectures OPFS du boot Rails sont noyées dans un coût qui reste avant tout du CPU
   émulé. Optimiser OPFS ne déplacerait donc pas l'aiguille.

3. **Aucune optimisation de boot à froid ne peut à elle seule atteindre 60 s.** Le boot Rails, à lui
   seul (~73 s), dépasse déjà la cible. Même en réduisant BIOS, noyau et montage à zéro, la reprise
   resterait au-dessus de 60 s tant que Rails démarre en ~73 s. Passer sous 60 s par le boot à froid
   exigerait de **diviser par plus de deux** le seul démarrage de Rails, ce qu'aucun levier connu ne
   garantit sur i386 émulé.

Note importante sur le périmètre de la mesure : `healthMilliseconds` **exclut** l'acquisition du
runtime (import de la classe V86 et téléchargement des ~437 Mio de tampons), volontairement acquise
en ligne dans la phase `resume-arm` pour prouver que la reprise à froid ne touche pas le réseau
(#7). Une reprise utilisateur réelle rechargera ce runtime depuis le cache HTTP ou le réseau : la
phase « à chaud » l'a mesurée à ~1,6 s depuis le serveur local, davantage sur un cache froid. Le
plan de mesure ci-dessous en tient compte.

## Options comparées

| Option                                          | Plafond de gain plausible                          | Coût       | Risque de sûreté               | Retenue                                     |
| ----------------------------------------------- | -------------------------------------------------- | ---------- | ------------------------------ | ------------------------------------------- |
| Instantané mémoire lié à une génération arrêtée | reprise en quelques secondes (saute noyau + Rails) | élevé      | élevé (cohérence) — encadrable | **oui, comme voie de qualification**        |
| Accélération du boot sans instantané            | quelques dizaines de % sur les ~73 s de Rails      | moyen      | faible                         | oui, en atténuation, **insuffisante seule** |
| Révision du budget                              | nulle (ne change pas le temps réel)                | faible     | nul                            | non                                         |
| Changement de runtime (hors v86)                | inconnu                                            | très élevé | inconnu                        | non                                         |

### Instantané mémoire lié à une génération arrêtée

C'est la seule option dont le plafond passe nettement sous 60 s : un `get_state`/`set_state` de v86
restaure une VM **déjà bootée, Puma en écoute**, sautant d'un coup le boot noyau (~15 s) et le boot
Rails (~73 s). La reprise devient une restauration mémoire de quelques secondes plus l'acquisition
du runtime.

Cette voie a été **écartée au prototype**, et il faut dire pourquoi et si le motif est levé.
`docs/architecture.md` (« Ordre des preuves ») pose : « La restauration d'un instantané mémoire
pré-calculé sur un disque mutable est écartée du premier prototype. Le boot à froid constitue la
référence de cohérence jusqu'à ce qu'un snapshot puisse être **lié à une génération exacte et
proprement arrêtée du volume**. » L'ADR 0003 en tire la conséquence côté adaptateur : `get_state`,
`set_state` et `get_buffer` lèvent `VAULT_STORAGE_UNSUPPORTED`.

Le motif du rejet était **conditionnel**, pas définitif : il tenait à l'absence d'une définition
opposable de « génération proprement arrêtée ». Cette condition est aujourd'hui **plus proche d'être
remplie** qu'au prototype : #6 fournit la persistance OPFS réelle et #14 la barrière de durabilité
dont l'acquittement marque un état de volume cohérent. On dispose donc de la matière pour définir
une génération arrêtée : un volume mis au repos (plus d'E/S en vol), dont la dernière barrière est
acquittée, et dont l'instantané mémoire est capturé **après** cette quiescence. Le rejet peut donc
être **levé comme direction**, sous conditions de sûreté strictes (ci-dessous). Il n'est pas levé
comme implémentation : rien n'est encore construit ni mesuré.

### Accélération du boot sans instantané

Leviers plausibles sur les ~73 s de Rails : `bootsnap` (cache de chargement Ruby), réduction du
chargement anticipé, image applicative plus petite, Puma préchauffé, et sur les ~15 s de noyau un
noyau et un initrd allégés. Gains plausibles : quelques dizaines de pour cent sur la part Rails.
Utile — pour réduire le coût de repli quand l'instantané est indisponible, et pour abaisser le
plancher — mais **insuffisant seul** : le fait 3 ci-dessus montre que même un boot Rails divisé par
deux (~37 s) plus le reste (~19 s) frôlerait 60 s sans marge, sur une machine plus rapide que la
référence.

### Révision du budget

Abaisser la cible ne change pas le temps réel de reprise et n'apporte rien à l'usage « logiciel
personnel » : rouvrir son coffre en 94 s reste une friction réelle. Surtout, une voie technique
crédible existe (l'instantané) pour tenir 60 s, voire bien moins. Réviser le budget reviendrait à
renoncer à cette voie avant de l'avoir tentée. Rejetée : la cible reste 60 s.

### Changement de runtime

Mentionné pour mémoire. L'ADR 0003 a déjà écarté le pivot hors v86 sans prototype (aucun autre
émulateur x86 WebAssembly n'a la maturité de v86 avec un point d'extension disque public). Rien dans
la décomposition ne le rouvre : le coût est du CPU émulé, qu'un autre émulateur paierait aussi.

## Décision

**La voie retenue pour qualifier la cible de reprise ≤ 60 s est l'instantané mémoire lié à une
génération proprement arrêtée du volume. La cible reste inchangée à p95 ≤ 60 s, et le gate de
qualification produit reste FERMÉ tant que cette voie n'est pas implémentée puis mesurée sur
l'environnement de référence de `docs/quality-attributes.md`.**

Conséquences :

- La reprise à froid actuelle **fonctionne** (#7) mais **ne qualifie pas** le produit : p95 mesuré
  ~94 s (sans l'aberration de #7) contre 60 s. Le budget de `docs/quality-attributes.md` renvoie
  désormais à cet ADR ; il n'est pas abaissé.
- L'accélération du boot est poursuivie **en parallèle et en atténuation**, pas comme voie de
  qualification. Elle réduit le coût de repli et le plancher, sans prétendre atteindre 60 s seule.
- La décomposition est désormais **outillée et publiée** à chaque exécution de `test:e2e`
  (`repriseTimeline`), de sorte qu'un futur gain soit attribuable à une étape précise et non à du
  bruit.
- L'ADR 0003 et `docs/architecture.md` ne sont **pas** amendés par le présent ADR : l'adaptateur
  continue de refuser `get_state`/`set_state` (`VAULT_STORAGE_UNSUPPORTED`) et le boot à froid reste
  la référence de cohérence. Leur amendement est le contenu de l'issue d'implémentation de
  l'instantané, sous les conditions ci-dessous.

## Conditions de sûreté

Un instantané ne devient une reprise qualifiante qu'aux conditions suivantes, non négociables :

1. **Il ne lève pas le boot à froid comme référence de cohérence** tant qu'il n'est pas lié à une
   génération **exacte et proprement arrêtée** du volume (`docs/architecture.md`, « Ordre des
   preuves »). Une génération arrêtée est un volume au repos — aucune E/S en vol — dont la dernière
   barrière de durabilité est **acquittée** (#14) avant la capture de l'instantané.
2. **Un instantané ne masque jamais une incohérence du volume.** À la restauration, l'état durable
   du volume OPFS et l'état mémoire restauré doivent être vérifiés mutuellement cohérents ; à
   défaut, la reprise **retombe sur un boot à froid** plutôt que de servir un état douteux. Un
   instantané pris sur un volume non quiescé, ou dont la génération ne correspond pas à celle du
   volume au moment de la restauration, est **refusé**, pas rattrapé silencieusement.
3. **L'instantané est validé contre le boot à froid** avant d'être digne de confiance : pour une
   même génération, l'invariant servi après restauration doit être byte-identique à celui servi
   après boot à froid (`observed.record.id`, `observed.attachment.sha256`). Le témoin négatif de #7
   (un volume vide ne rend jamais l'invariant) reste exigé.
4. **Aucune promesse de durabilité n'est déplacée.** L'instantané accélère la **lecture** d'un état
   déjà rendu durable ; il n'anticipe aucun acquittement. `SEC-DURABLE-001` reste porté par la
   barrière, pas par l'instantané.

## Plan de mesure

La qualification se mesure sur l'**environnement de référence** de `docs/quality-attributes.md`, et
pas seulement sur la machine de développement :

- poste 4 cœurs physiques, 16 Gio, profil navigateur neuf, secteur, réseau 100 Mbit/s pour le
  premier chargement ; **dix essais après échauffement**, p50 et p95 publiés ;
- la mesure inclut, pour être honnête sur l'expérience réelle, **l'acquisition du runtime** depuis
  le cache HTTP (une reprise utilisateur recharge les tampons v86), en plus de `healthMilliseconds`
  ;
- la décomposition (`repriseTimeline`) est publiée à chaque relevé, pour attribuer tout gain à une
  étape ;
- le job CI `reprise.yml` continue de rejouer le scénario ; il ne **qualifie** pas (exécutant
  partagé, hors environnement de référence) mais détecte les régressions et publie le brut.

Le gate ne s'ouvre que lorsque, sur cet environnement, **p95 ≤ 60 s** est mesuré par la voie
retenue, conditions de sûreté tenues.

## Risques résiduels

1. **La quiescence n'est pas gratuite.** Mettre le volume au repos et acquitter la dernière barrière
   avant capture ajoute un coût à la fermeture ; il faudra qu'il reste très inférieur au boot à
   froid évité, sinon l'instantané ne gagne rien.
2. **La taille de l'instantané.** Une VM de 512 Mio de RAM produit un instantané du même ordre à
   stocker dans OPFS ; son écriture et sa relecture pourraient rogner le gain. À mesurer avant de
   conclure — c'est une condition d'abandon.
3. **L'invalidation.** Un instantané doit être invalidé dès que le volume change hors de sa
   génération (autre onglet écrivain, migration, restauration d'export). Le bail d'écriture (#8) et
   la notion de génération (#16) sont les points d'ancrage ; un instantané orphelin doit être
   refusé, jamais servi.
4. **La part Rails reste le coût de fond.** Si l'instantané est indisponible (première ouverture,
   invalidation, incompatibilité de version v86), la reprise **est** un boot à froid de ~94 s. D'où
   l'atténuation par accélération du boot : elle borne le pire cas.

## Conditions d'abandon

La voie « instantané » est abandonnée, et le budget rouvert à la révision, si l'un de ces faits est
établi :

- la capture ou la restauration d'un instantané cohérent coûte, mesures à l'appui, un temps du même
  ordre que le boot à froid qu'elle évite ;
- aucune définition de « génération proprement arrêtée » ne peut être rendue opposable sans réécrire
  la barrière de #14 ou la géométrie de #6 ;
- une montée de v86 rend `get_state`/`set_state` inutilisables ou incohérents avec le tampon disque
  de l'adaptateur ;
- l'accélération du boot atteint, seule, un p95 ≤ 60 s sur l'environnement de référence — auquel cas
  l'instantané devient superflu et le présent ADR est remplacé par un ADR de clôture.

## Alternatives rejetées

- **Abaisser silencieusement la cible** — interdit par `docs/quality-attributes.md` ; c'est la
  raison d'être de cet ADR.
- **Déclarer la cible atteinte parce que l'aberration de 162 s ne s'est pas reproduite** — le p95
  propre (~94 s) dépasse toujours 60 s de ~57 %. Un point aberrant en moins ne qualifie pas.
- **Optimiser le backend OPFS pour gagner du temps de reprise** — la décomposition montre ~65 ms de
  montage : il n'y a rien à y gagner. Ce serait optimiser ce qui n'est pas le coût.
- **Implémenter l'instantané dans cet ADR** — la décision de direction n'est pas l'implémentation.
  La construire ici, sans TDD ni preuve sur l'environnement de référence, contredirait le dépôt et
  masquerait le gate encore fermé.
- **Précharger un instantané fabriqué à la construction de l'image** (comme un rootfs pré-booté) —
  ce serait un instantané **non lié à la génération de l'utilisateur**, exactement ce que
  `docs/architecture.md` refuse : il masquerait l'état réel du volume.
