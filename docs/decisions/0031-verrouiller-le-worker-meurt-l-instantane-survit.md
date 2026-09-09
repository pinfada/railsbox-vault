# ADR 0031 — Verrouiller : le Worker meurt, l'instantané survit

- **Statut** : accepté
- **Date** : 2026-09-08
- **Issue** : [#169](https://github.com/pinfada/railsbox-vault/issues/169), tranche 1 de
  [#25](https://github.com/pinfada/railsbox-vault/issues/25)
- **RÉVISE** : [ADR 0024](0024-instantane-de-reprise.md), décision 8 — la ligne « verrouillage »
  passe de « oui » à « non », et la note datée est posée DANS l'ADR 0024, jamais par une édition
  silencieuse (même forme que l'[ADR 0027](0027-archive-et-ancre-de-version.md) pour l'ADR 0020
  décision 6).
- **Complète** : [ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md) (le cycle assemblé, et
  la fermeture propre que cette tranche NOMME), [ADR 0029](0029-deverrouillage-dans-la-coquille.md)
  (la KEK retenue, dont la limite 2 est ici bornée),
  [ADR 0028](0028-coquille-de-produit-et-frontiere.md) (la frontière et son contrat strict),
  [ADR 0021](0021-derivation-des-cles-de-deverrouillage.md) (ce qu'on peut promettre, décision 7).
- **Ne traite pas** : les fins d'onglet mesurées par moteur — c'est la tranche 2
  ([#170](https://github.com/pinfada/railsbox-vault/issues/170)).

## Contexte

Deux phrases du dossier attendaient cette tranche, et elles étaient écrites bien avant elle.

`SECURITY.md`, § « Ce que la coquille RETIENT pendant qu'un coffre est ouvert » : « c'est un endroit
de plus où un secret existe, et **il dure aussi longtemps que la session** : le verrouillage après
inactivité (#25) est ce qui bornera cette durée ». Et l'ADR 0029, limite 2, dans les mêmes termes :
la KEK vit dans le tas du Worker de confiance « aussi longtemps que l'onglet ». Ni l'une ni l'autre
n'était fausse ; toutes deux nommaient une issue à la place d'une borne.

L'[ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md) a ensuite assemblé ce qu'il fallait
pour la poser. Sa décision 1 étape 7 a écrit la **fermeture propre** — arrêt de la VM, capture de
l'instantané, `await backend.close()`, `terminate()` par la page —, et sa décision 3 a partagé le
travail avec cette tranche-ci en toutes lettres : « **#163 possède la DÉTECTION et la CONDUITE**,
**#25 possède l'ÉTAT et la RÈGLE** ». Elle a même écrit la position qui en découle : «
**verrouiller, c'est atteindre volontairement l'état que la mort du Worker atteint par accident.**
Un seul état, deux chemins ».

Il ne restait donc pas grand-chose à inventer, et beaucoup à **nommer** : le geste, son déclencheur
automatique, ce que le verrouillage retire de l'écran, ce qu'il laisse sur le support, et ce qu'il
ne promet pas.

## Décision 1 — Verrouiller EST la fermeture propre, suivie du rechargement

### Un seul chemin, et un seul mot

Le chemin est celui de #163, sans une ligne de plus : `fermerLeCoffre` du Worker de confiance arrête
la VM, capture l'instantané dans l'ordre des six gestes de l'ADR 0024 décision 6,
`await backend.close()`, puis la page appelle `terminate()`. **L'ordre est le contrat, et il ne se
réordonne pas.**

**Son MOTIF, en revanche, était faux, et il est réécrit ici.** De #163 à la première rédaction de
cette tranche, quatre endroits du dépôt affirmaient que terminer avant `close()` laisserait le
handle exclusif « tenu par un objet que plus personne ne référence », si bien que l'ouverture
suivante rendrait `VAULT_STORAGE_BUSY` (constat 6 de la revue de la PR #167). **La revue de sécurité
de la PR #174 a mesuré le contraire**, sur Chromium et sur Firefox, avec témoin positif ; le dépôt
en a fait une épreuve — `tests/browser/opfs-block-backend.spec.mjs` › « le moteur rend l'exclusivité
du handle à la MORT du Worker qui le tenait » — et `docs/compatibility.md` l'inscrit comme un **fait
de moteur** : tant que le détenteur vit, un second demandeur reçoit `VAULT_STORAGE_BUSY` ; après
`terminate()` SANS `close()`, l'ouverture réussit **au premier essai**. Le moteur relâche
l'exclusivité avec le contexte du Worker. Le dépôt le disait d'ailleurs déjà à l'endroit même que
l'ancien motif citait comme preuve (`tests/unit/vm-reouverture-handles.test.mjs` : « ce que le
double ne peut PAS mesurer, c'est le DÉLAI que Chromium met à rendre l'exclusivité après la mort
d'un Worker »).

**Ce que `close()` apporte vraiment**, et c'est plus fort que ce qu'on lui prêtait :

- **il attend les E/S déjà ACCEPTÉES** (#132). Terminer avant lui perd des écritures que le guest
  croit acquittées — ce que `SEC-DURABLE-001` interdit, et qui n'a rien à voir avec l'exclusivité ;
- **il laisse le volume dans l'état que la CAPTURE vient de décrire.** L'instantané est scellé dans
  `relacherTout`, juste AVANT le `close()` : sur un volume dont les dernières écritures manquent, il
  décrirait un état qui n'existe pas. Un tel instantané est écarté à l'ouverture suivante (ADR 0024,
  décision 4) — donc un boot à FROID, c'est-à-dire la décision 3 de cet ADR défaite.

Le mutant n° 18 tue désormais par cette propriété-là, et non par un `VAULT_STORAGE_BUSY` qui
n'arrive pas : il déplace `apresVerrouillage()` avant l'attente, et
`tests/unit/coquille-verrouillage.test.mjs` › « le geste de VERROUILLAGE attend la fermeture du
Worker avant de le terminer » rougit.

**Un seul bouton, et un seul mot.** « Fermer le coffre » disparaît de la coquille ; le geste
s'appelle « Verrouiller ». Un coffre fermé et un coffre verrouillé sont la même chose, et deux mots
pour une chose sont un mensonge en attente. Le TYPE de message, lui, ne bouge pas : le canal
privilégié porte toujours `vault.coquille.fermer-le-coffre`. Renommer un type ajoute et retire une
entrée d'une liste tenue par un cliquet (ADR 0028, contrat strict) pour un nom qu'aucun utilisateur
ne lit ; ce qui doit être unique est le mot que la coquille MONTRE, et il l'est. **Aucun type neuf**
n'est ajouté, ni sur le port restreint, ni sur le canal privilégié ; **aucun code de refus neuf**
non plus — le `VAULT_COQUILLE_VOLUME_VERROUILLE` que les gestes privilégiés rendent sur un volume
fermé existe depuis #162.

### Le cadre est retiré par RECHARGEMENT, et la coquille se le donne à elle-même

Les pixels du cadre applicatif sont le **dernier clair de la session** : un coffre verrouillé n'a
jamais un cadre affiché. Le retirer entre en collision avec une garde de #161 —
`VAULT_COQUILLE_ANNONCE_UNIQUE` refuse un second octroi de port, et cette garde a été mutée (ADR
0028, campagne n° 5, TUÉ). Deux issues, et la Definition of Ready de #25 exigeait d'en écrire une :
reformuler l'unicité en « un port par CADRE » et re-muter la garde, ou **recharger la coquille**.

C'est le rechargement, pour trois raisons qui vont dans le même sens :

- **la base de confiance est plus petite.** Reformuler l'unicité ajouterait un compteur dans le code
  qui tient le handle exclusif du volume ; le rechargement n'ajoute rien du tout ;
- **l'unicité du port de #161 reste intacte**, avec sa garde et son mutant ;
- **c'est déjà le chemin de #163.** Le bouton « Rouvrir le coffre » de la mort recharge, et l'ADR
  0030 décision 3 l'écrivait comme tel : « c'est déjà le chemin que la Definition of Ready de #25
  retient pour retirer le cadre au verrouillage : **un seul chemin pour deux conduites** ».

**Ce que le rechargement PERD**, dit plutôt que tu : l'attente annoncée en cours (#162) et le relevé
de mesures de la session — `annonceApresLeGesteMs`, `deverrouillageMs`, et `verrouillageMs`
lui-même. Le document qui revient est neuf, et son relevé recommence à zéro. C'est le prix, et il
est assumé : ce qui se perd est une trace d'interface, pas une donnée.

### L'ASYMÉTRIE avec la mort, assumée et écrite

| Événement                 | Ce que la coquille fait de son écran                                    | Pourquoi                                                                              |
| ------------------------- | ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| MORT du Worker (imprévue) | elle RESTE affichée : relevé, cause, et le bouton « Rouvrir le coffre » | il s'est passé quelque chose, et l'utilisateur doit pouvoir le voir                   |
| VERROUILLAGE (voulu)      | elle RECHARGE d'elle-même ; aucun bouton n'est offert                   | l'utilisateur vient de le demander ; il n'y a rien à lui apprendre                    |
| RETOUR depuis le bfcache  | elle RECHARGE d'elle-même, par ce même chemin                           | c'est lui qui navigue, et le document restauré porte un cadre dont le Worker est mort |

> **Ligne ajoutée le 2026-09-09 (#170,
> [ADR 0032](0032-les-fins-d-onglet-ce-que-le-moteur-livre.md))** : le retour depuis le bfcache
> rejoint le VERROUILLAGE et non la MORT, et le motif est celui de la colonne — la conduite « page
> conservée + Rouvrir » de #163 est pour l'imprévu que l'utilisateur doit VOIR ; ici c'est lui qui
> navigue. Aucun moteur ne restaure un document sous le harnais de ce dépôt : cette ligne est une
> garde éprouvée en unitaire et mutée, pas un comportement observé.

**Ce n'est PAS une réouverture automatique.** Après le rechargement, la coquille est en
`verrouille`, l'interface de déverrouillage est remontée, **aucune dérivation ne part sans geste**,
et **aucune KEK n'est gardée**. C'est la conduite de l'ADR 0030 décision 3, tenue par le même code :
remonter l'interface n'est pas redemander.

### Un verrouillage REFUSÉ : ce qui arrive quand la fermeture propre échoue

C'est le constat 3 de la revue de sécurité de la PR #174, et il était sévère parce qu'il était
silencieux. La première rédaction rendait la main sans rien dire : un verrouillage refusé laissait
**exactement l'état que le verrouillage existe pour quitter** — le coffre `ouvert`, le cadre
applicatif affiché, et AUCUN délai, la surveillance s'étant désarmée avant d'appeler le geste sans
que rien ne la ré-arme. Le coffre restait ouvert pour toujours sans que personne l'ait décidé. Ce
qui empêchait d'en faire un CRITICAL : le `finally` de `relacherTout` lâche la KEK quoi qu'il arrive
(correction du constat 10 de la PR #171). Restaient faux l'état publié, le cadre non retiré, le
délai mort — et la divergence des deux côtés, le Worker se croyant verrouillé pendant que la
coquille publiait « ouvert ».

**Un verrouillage refusé ne laisse JAMAIS le coffre ouvert.** La conduite, dans son ordre :

1. **le refus et sa cause sont PUBLIÉS**, avant toute autre chose : c'est la seule chose que
   l'utilisateur ait à apprendre ;
2. **le Worker est TERMINÉ**, sous la cause `terminaison` — la table de l'ADR 0030 décision 3 ne
   gagne pas de quatrième cause. Sa KEK est déjà partie ; le garder en vie ne rendrait que
   l'illusion d'un coffre ouvert ;
3. **la conduite après la mort de #163 s'applique** : page conservée, interface de déverrouillage
   remontée, bouton « Rouvrir le coffre » offert ;
4. **le CADRE applicatif est retiré du DOM.** Laisser ses pixels sur un coffre dont l'utilisateur
   vient de demander le verrouillage est le contraire de la promesse. **Aucun port n'est
   re-octroyé** : `rapport.portOctroye` reste vrai, si bien que `VAULT_COQUILLE_ANNONCE_UNIQUE`
   (garde de #161, mutant n° 5 de l'ADR 0028) continue de refuser un second octroi — l'unicité du
   port n'est pas reformulée pour autant, et le cadre ne revient qu'au rechargement ;
5. **la coquille NE recharge PAS**, et c'est la seule différence avec un verrouillage réussi : un
   rechargement effacerait le refus de l'écran ;
6. **le délai est désarmé**, au refus comme au succès.

**Ce que la réouverture coûtera est ANNONCÉ** : un boot à FROID si la capture n'a pas eu lieu. Le
refus étant survenu quelque part dans la fermeture propre, l'instantané peut manquer ou décrire un
état que le volume n'a pas, et une ouverture qui l'écarte le retire (ADR 0024, décision 4). Le
relevé publie `instantaneGaranti: false` plutôt que de laisser croire.

**Deux refus, et ils ne se confondent pas.** Celui de l'ORDRE — un verrouillage demandé pendant
qu'un DÉMARRAGE est en vol — ne tue rien : le geste n'a jamais atteint le Worker, le coffre est
légitimement ouvert, et ce qu'il faut est ré-armer le délai. Il porte
`VAULT_COQUILLE_ETAPE_HORS_ORDRE`, le code de l'ordre existant depuis #163, et non un code de
support. Le motif du refus : ce geste arriverait au Worker derrière un boot de deux minutes — la
coquille attendrait sans rien dire, puis capturerait l'instantané d'une machine qui vient de
démarrer. Le drapeau du vol retombe dans un `finally`, sans quoi un boot qui échoue refuserait tout
verrouillage jusqu'au rechargement : un coffre qu'on ne peut plus fermer. Un scénario de bout en
bout n'est pas exigé pour ce cas ; une épreuve unitaire et deux mutants le tiennent.

### Entre la fermeture propre et le rechargement, l'état EXISTE et se mesure

Ce que la coquille publie dans cette fenêtre est son dernier mot, et il est complet : `etat` à
`verrouille`, `workerMort.cause` à `terminaison`, `workerMort.pousseeDeBarriere` à `false`,
`workerMort.kekRetenue` à `false`, `fermeture.capture` non nul, `verrouillage.declencheur`, et
`mesures.verrouillageMs`. La fenêtre dure une tâche — le rechargement est posé sur la suivante, pour
que le navigateur peigne l'état publié —, et l'épreuve la capture par un `MutationObserver` posé par
`addInitScript`, dont le rappel est une microtâche : **la capture est ordonnée par la plate-forme,
pas gagnée par une course**. L'instrumentation est du côté de l'ÉPREUVE, jamais du produit, pour le
motif de la sonde de #162 : rendre au produit une poignée de test rouvrirait la porte que #162 a
fermée.

Après le rechargement, ce que le CADRE lit par son geste-requête est `verrouille` — ou
`indisponible` sur un moteur qui n'a jamais rien pu ouvrir. Le geste ADMIS reste admis et rend
l'état : répondre par un refus là où l'état existe ferait perdre au cadre la seule chose qu'il ait
le droit de savoir.

**Les dix refus sont IDENTIQUES**, et c'est mesuré plutôt qu'affirmé :
`tests/browser/coquille-frontiere.spec.mjs` › « les DIX refus sont identiques sur un coffre
verrouillé, ouvert, puis verrouillé par le geste » relève les dix codes dans les trois états, depuis
le cadre, sur les trois moteurs. Une différence en ferait un ORACLE — un document applicatif
apprendrait, sans y avoir droit, si un volume est ouvert. `evaluerRequete` ne prend aucun état en
argument (ADR 0028, décision 2), et cette épreuve montre que la propriété porte sur quelque chose.

### Le vocabulaire, et la phrase qui ne s'écrit pas

Partout — code, relevé, documents — le vocabulaire est celui de l'ADR 0021 décision 7 : **garanti**,
**fait mais non garanti**, **impossible**. Ce qui s'écrit est « **le Worker qui détenait les clés
est mort** ». « Les clés sont effacées » ne s'écrit pas. `interne.kek = null` reste une hygiène du
Worker de confiance ; effacer une `string` est IMPOSSIBLE en JavaScript, et le relevé publie
`workerTermine: true`, jamais `clesEffacees`.

C'est le même argument que l'ADR 0029 décision 5 emploie pour le Worker de dérivation — « il meurt
après usage ; son tas, la phrase comprise, s'en va avec lui : c'est plus franc qu'un effacement, que
le langage ne permet pas ».

## Décision 2 — Le délai d'inactivité : ce que la coquille observe SANS faire confiance à l'application

### La valeur, et ses bornes

`DELAI_INACTIVITE_MS` = **dix minutes**, nommé dans `src/coquille/verrouillage.mjs` avec son motif —
au même endroit du dépôt que `DELAI_PASSKEY_MS` et `DELAI_WORKER_MORT_MS`, et pour la même raison :
une durée que le produit tient se lit à côté de son motif, jamais au milieu d'un appel.

Dix minutes, et le chiffre se justifie dans les deux sens. Plus court, le délai coupe une lecture,
un appel téléphonique, un aller-retour à la machine à café — et **un verrouillage qui coupe le
travail est un verrouillage que l'utilisateur allonge jusqu'à ne plus l'avoir**. Plus long, il cesse
de borner quoi que ce soit : l'appareil laissé ouvert et l'onglet oublié se comptent en dizaines de
minutes, pas en heures.

Les **bornes sont tenues par le code** : `delaiDInactivite(valeur)` refuse tout ce qui n'est pas un
entier de millisecondes entre **une minute** et **une heure**, et la surveillance passe sa valeur
par cette porte à sa CONSTRUCTION — une borne posée seulement dans une fonction que personne
n'appelle serait décorative (mutants n° 6, 7 et 8).

Le délai est réglable **par session seulement**. **Rien n'est rangé sur l'appareil** : ni OPFS, ni
`localStorage`, ni cookie. Le motif est l'ADR 0019 § 6.9, repris par le modèle de menace de l'ADR
0028 — ce qu'on range dans l'OPFS de l'origine de confiance, l'adversaire qui y écrit l'ALLONGE, et
un délai allongé par un adversaire est un verrouillage désactivé sans que personne le voie. Les
cookies sont écartés par ailleurs (ADR 0028, décision 3, éprouvée).

**Aucune interface de réglage dans cette tranche**, et c'est un YAGNI écrit : la fonction et ses
bornes suffisent à ce que le produit ait une règle. Une interface demanderait de décider où le
réglage vit entre deux sessions — c'est-à-dire précisément la question que l'ADR 0019 § 6.9 tranche
par la négative.

### Ce qui compte, ce qui ne compte pas, et pourquoi

| Signal                                  | Remet le délai à zéro | Motif                                                                       |
| --------------------------------------- | --------------------- | --------------------------------------------------------------------------- |
| pointeur (`pointerdown`, `pointermove`) | **oui**               | une personne bouge, sur le document de la COQUILLE                          |
| clavier (`keydown`)                     | **oui**               | idem                                                                        |
| focus (`focusin`)                       | **oui**               | idem                                                                        |
| compte de barrières                     | **non**               | un guest qui écrit en boucle n'est pas une personne                         |
| tout message du cadre                   | **non**               | le contrat n'admet aucun « je suis là » ; l'origine applicative est hostile |
| visibilité (`visibilitychange`)         | **non**               | le temps continue de courir quand l'onglet est caché, et à son retour       |
| un signal inconnu                       | **non**               | la liste est FERMÉE ; ouverte, elle accueillerait le premier signal commode |

Les trois signaux **sans effet** sont NOMMÉS plutôt qu'omis : une liste d'exclusion vide est
indiscernable d'une liste d'exclusion oubliée, et une épreuve doit pouvoir les présenter un par un
pour montrer qu'ils n'ont pas d'effet. La page les PRÉSENTE donc à la surveillance — une barrière
acquittée, une requête du cadre, un changement de visibilité —, et c'est la surveillance qui les
refuse. Mettre le refus là où il se mute vaut mieux qu'une absence d'appel que rien ne peut rougir.

Le refus des messages du cadre repose sur une seconde propriété, moins visible : `armer` est
**IDEMPOTENT**. La page ré-arme à chaque réponse d'état, y compris celles que le document applicatif
provoque en posant sa question ; un ré-armement qui repousserait l'échéance rendrait le délai infini
pour qui interroge en boucle (mutant n° 2).

**DEUX limites, écrites plutôt que tues, et elles vont en sens contraire.**

La première est celle qu'on voit : un onglet au premier plan devant un bureau vide ne se distingue
pas d'un onglet devant quelqu'un. Le produit n'invente pas de substitut de présence.

**La seconde est la plus coûteuse, et elle borne le choix de dix minutes lui-même** (constat 4 de la
revue de sécurité de la PR #174). Le motif écrit plus haut — « un verrouillage qui coupe le travail
est un verrouillage que l'utilisateur allonge jusqu'à ne plus l'avoir » — suppose que le produit
sache quand on travaille. **Il ne le sait pas dans le cas NOMINAL.** La revue l'a mesuré sur les
trois moteurs, avec témoin positif : un clic réel, vingt frappes réelles et cinquante mouvements de
pointeur DANS le cadre inter-origine produisent **zéro `focusin`, zéro `pointerdown`, zéro
`keydown`** sur le document de la coquille ; un focus forcé depuis le cadre et des événements
synthétiques ne franchissent rien non plus. C'est exactement ce que la décision voulait — le délai
n'est ni tenu ni allongé par l'origine applicative —, et c'est aussi ce qui fait qu'**une personne
qui travaille dans l'application est comptée comme absente, et se fait verrouiller à dix minutes
exactement, en pleine frappe.**

Ce qui l'atténue, et il faut le peser honnêtement : la réouverture coûte **une seconde** par
l'instantané (décision 3, 1 038,2 ms mesurés), pas deux minutes ; et le volume tient tout ce que le
guest a fait ACQUITTER. Ce qui ne l'atténue pas : ce qui n'était pas acquitté est perdu, comme à
toute coupure ([ADR 0014](0014-generation-transactionnelle.md)) ; et il n'existe aujourd'hui **aucun
signal de présence que le cadre ne puisse pas forger**. La question est ouverte — issue
[#176](https://github.com/pinfada/railsbox-vault/issues/176) — et référencée depuis #25. Tant
qu'elle l'est, dix minutes est un compromis entre deux limites, et non un chiffre confortable.

**Aucun événement de fin d'onglet n'est écouté** — ni `pagehide`, ni `freeze`, ni `beforeunload` —,
et rien n'est promis à leur sujet. C'est #170, et une épreuve unitaire refuse leur entrée dans la
table des événements d'activité.

> **Note datée du 2026-09-09 (#170, [ADR 0032](0032-les-fins-d-onglet-ce-que-le-moteur-livre.md))**
> : trois d'entre eux le sont désormais, et deux ne le seront jamais. `pagehide` termine le Worker
> sur un coffre ouvert, `pageshow` restauré recharge, le gel n'est qu'inscrit, `resume` et le retour
> à la visibilité VÉRIFIENT l'échéance ; `beforeunload` et `unload` restent nommés comme jamais
> branchés, et un cliquet balaie la page et `src/coquille/` pour qu'aucun ne s'y glisse. **Ce
> paragraphe-ci reste vrai sur le point qui compte** : aucune fin d'onglet n'est un signal
> d'ACTIVITÉ, l'épreuve unitaire qui refuse leur entrée dans cette table-là est inchangée, et la
> décision 2 ci-dessous n'est pas révisée.

### Ce que le déclencheur mesure, et comment on l'éprouve sans attendre dix minutes

La surveillance reçoit son **horloge** et son **ordonnanceur** en paramètres. Sans cette injection,
la décision la plus importante de la tranche serait hors de portée de toute campagne de mutation, et
une épreuve qui la mesurerait coûterait dix minutes.

Le verdict ne vient pas du RÉVEIL d'une minuterie, il vient de l'HORLOGE : un onglet en arrière-plan
voit ses minuteries étirées, un onglet au premier plan les voit parfois se déclencher tôt, et
verrouiller sur un réveil ferait dépendre le coffre d'un détail d'ordonnancement. À chaque réveil,
le temps écoulé depuis le dernier signe est comparé au délai ; s'il n'y est pas, la minuterie se
replanifie pour le reste (mutant n° 9).

**Le geste explicite est le TÉMOIN POSITIF du délai.** Sans lui, une suite verte pourrait n'être
qu'une suite qui ne déclenche jamais rien : les épreuves prouvent d'abord que le bouton verrouille,
puis que le délai fait EXACTEMENT la même chose — même relevé, même état, même rechargement, au
déclencheur près.

**Ce qui est mesuré, et SUR QUOI** — la table le dit exactement, parce que le dossier a un moment
écrit « les deux sur les trois moteurs » alors que le délai n'était joué que sur Chromium (constat 1
de la revue de sécurité de la PR #174) :

| Propriété                                                       | Moteurs                   |
| --------------------------------------------------------------- | ------------------------- |
| le GESTE verrouille, recharge, et le cadre neuf lit l'état      | Chromium, Firefox, WebKit |
| un verrouillage REFUSÉ tue, retire le cadre, et ne recharge pas | Chromium, Firefox, WebKit |
| les dix refus identiques sur trois états du coffre              | Chromium, Firefox, WebKit |
| le DÉLAI verrouille tout seul, en temps réel                    | Chromium, Firefox         |
| le témoin négatif : un coffre tenu éveillé ne se verrouille pas | Chromium, Firefox         |
| la sonde d'exfiltration après le GESTE                          | Chromium, Firefox, WebKit |
| la sonde d'exfiltration après le DÉLAI                          | Chromium                  |

Les deux épreuves de temps réel paient **une minute** et **une minute et demie**, et elles sont
jouées sur DEUX moteurs. Le motif a changé avec elles : la première rédaction n'en jouait qu'un, en
écrivant qu'« une minuterie ne dépend pas du moteur ». C'est faux dans sa seconde moitié, et la
revue le mesure — la livraison du focus diffère d'un moteur à l'autre sur la même séquence. Ce qui
est mesuré ici est la LIVRAISON d'événements de document et l'étirement des minuteries, deux
comportements de moteur.

**WebKit est hors de portée du délai, et pas par économie** : rien ne s'y ouvre, donc aucune
surveillance ne s'y arme, donc il n'y a rien à mesurer. La suite le DÉCLARE au lieu de s'ignorer.

## Décision 3 — L'INSTANTANÉ SURVIT au verrouillage (révision de l'ADR 0024 décision 8)

L'ADR 0024 décision 8 écrivait la position par défaut — « oui, un verrouillage retire l'instantané »
— et invitait #25 à la rouvrir « avec un argument, pas par omission ». **Voici l'argument.**

- **Il est scellé sous la DEK**, en un seul AES-256-GCM par capture (ADR 0024, décision 3) —
  **exactement comme le volume**, qui reste, lui, sur l'appareil sans que personne n'appelle cela un
  défaut du verrouillage. L'adversaire nommé par `SECURITY.md` — « copie ou inspection du profil
  navigateur lorsque le coffre est verrouillé » — n'obtient pas davantage de l'un que de l'autre ;
- **le prix du retrait est un boot à froid par réouverture**, mesuré à **p95 = 125,9 s** et déclaré
  **hors budget** par `docs/quality-attributes.md`, contre **252 ms** par instantané dans le
  scénario de bout en bout de #163. C'est un facteur de plusieurs centaines, et il a une conséquence
  de produit qui décide la question : **un verrouillage qui coûte deux minutes est un verrouillage
  dont l'utilisateur allonge le délai jusqu'à ne plus l'avoir.** Une protection qu'on désactive ne
  protège de rien ;
- **la condition de l'ADR 0024 est tenue** : la capture au verrouillage suit les six gestes de la
  décision 6, dans leur ordre, parce que c'est le même code — celui de la fermeture propre de #163.
  La décision 6 nommait d'ailleurs déjà l'« inactivité mesurée au-delà d'un seuil » comme second
  moment de capture, laissé en attente d'« une interface (#24) qui puisse le justifier à
  l'utilisateur » : elle existe depuis #162.

**L'ASYMÉTRIE, écrite comme LIMITE et non passée sous silence** : l'instantané porte la **RAM
invitée**, donc du clair que le volume n'a **jamais reçu**, sous la même clé. C'est le seul argument
sérieux de l'autre côté, et il est réel. Il ne l'emporte pas, parce que ce clair est chiffré sous la
même DEK que le reste et que ce qui protège les deux est identique — mais il est nommé ici pour
qu'un relecteur externe puisse le peser lui-même.

**Ce qui retire l'instantané n'a pas bougé** : la suppression du volume, la restauration (#12), la
migration (#13) et toute ouverture qui l'écarte. Les épreuves existantes de ces trois lignes sont
rejouées telles quelles.

| Geste                                 | Retire l'instantané  | Depuis                                    |
| ------------------------------------- | -------------------- | ----------------------------------------- |
| suppression du volume                 | **oui**              | ADR 0024, décision 8 — inchangé           |
| restauration depuis une archive (#12) | **oui**              | ADR 0024, décision 8 — inchangé           |
| migration de format (#13)             | **oui**              | ADR 0024, décision 8 — inchangé           |
| ouverture qui écarte l'instantané     | **oui**              | ADR 0024, décision 8 — inchangé           |
| **verrouillage**                      | **non**              | **RÉVISÉ ici** (était « oui » par défaut) |
| changement de bail d'écriture (#79)   | non — par la liaison | ADR 0024, décision 8 — inchangé           |
| écriture validée pendant la session   | non — par la liaison | ADR 0024, décision 8 — inchangé           |

La révision est **constatée sur l'OPFS RÉEL**, et pas seulement dans une table : le scénario de bout
en bout inventorie l'OPFS de l'origine de confiance après le verrouillage et exige un
`<volume>.instantane` non vide, puis la réouverture par un NOUVEAU geste reprend cet instantané —
l'étape 8 du cycle est conclue `franchie` avec le motif `instantane`.

## Décision 4 — Modèle de menace, `SEC-KEY-001`, et le gate

### Ce que le verrouillage DÉFEND

- **l'appareil laissé ouvert** et **l'onglet oublié** : c'est ce que le délai borne ;
- **la copie ou l'inspection du profil navigateur lorsque le coffre est VERROUILLÉ** — le premier
  adversaire de la liste de `SECURITY.md`, qui n'a de sens que si quelque chose fait repasser un
  coffre ouvert à verrouillé. C'est désormais le cas, par un geste et par une durée.

### Ce qu'il ne défend PAS, au même niveau

- **la mémoire du processus et le fichier d'échange.** « Aucun code JavaScript ne verrouille une
  page en mémoire » (ADR 0021, décision 7). Tuer le Worker rend son tas au ramasse-miettes ; il ne
  le réécrit pas, et rien ne dit quand le système l'aura repris ;
- **un navigateur ou une extension compromis**, comme partout ailleurs dans ce dossier ;
- **l'adversaire qui écrit dans l'OPFS de l'origine de confiance** (ADR 0019 § 6.9). C'est la raison
  pour laquelle le délai n'est rangé nulle part ;
- **l'épaule** ;
- **la copie du volume DÉJÀ prise. Verrouiller ne rechiffre pas**, pas plus que révoquer
  (`SECURITY.md`, `SEC-RECOVERY-001`). Qui détenait une copie avant le verrouillage la détient
  encore après, et la clé qui l'ouvre est celle qui l'ouvrait.

### `SEC-KEY-001` : une promesse devient une propriété éprouvée

L'invariant n'est pas rouvert — cette tranche ne change ni dérivation, ni enveloppe, ni hiérarchie
de clés. Ce qui change est la phrase qui l'accompagnait : « il dure aussi longtemps que la session :
le verrouillage après inactivité (#25) est ce qui bornera cette durée » cesse d'être une promesse.
La durée est bornée **par le geste et par le délai**, et les deux sont mesurés sur trois moteurs.
L'ADR 0029 limite 2 reçoit sa note datée dans les mêmes termes.

### Le gate « données sensibles » : le QUATRIÈME est livré, et le gate reste FERMÉ

Le gate 2 de `SECURITY.md` exige quatre choses : le format chiffré (livré, #18), la séparation
d'origine (implémentée depuis #161), la récupération (offerte depuis #162) et **le verrouillage**.
Avec cette tranche, **quatre des quatre sont livrés**.

**Et le gate reste FERMÉ.** Ce n'est pas une précaution rhétorique : c'est ce que ses propres
critères disent. Le § qui précède la liste des gates écrit que « le registre de la revue externe
(`docs/revue-externe/registre.md`) est **vide** : aucun tiers n'a été sollicité, et le gate «
données sensibles » ci-dessous reste fermé ». Deux conditions coexistent donc dans le dossier — les
quatre briques, et une revue externe non sollicitée (#20) —, et **on ne déclare pas un gate ouvert
parce qu'une de ses conditions vient d'être remplie**. « Trois des quatre sont livrés : c'est un
compte, pas une autorisation » ; quatre des quatre est un compte aussi.

## Frontières

- **avec #163 (ADR 0030)** : #163 possède la DÉTECTION de la mort du Worker et la CONDUITE ; cette
  tranche n'y touche pas, sinon pour **nommer l'asymétrie** de l'écran (décision 1) et pour désarmer
  la surveillance d'inactivité quand une mort est constatée — un coffre dont le Worker est mort n'a
  plus rien à verrouiller ;
- **avec #170 (tranche 2)** : les fins d'onglet. Rien ici n'écoute `pagehide`, `freeze` ni
  `beforeunload`, et rien ne promet quoi que ce soit sur ce que chaque moteur livre à la fermeture
  ou à la mise en veille d'un onglet ;
- **avec #79** : le bail d'écriture n'existe pas dans le chemin de produit (relevé de la DoR de #25,
  fait 2). Ce que le verrouillage rend est le **handle exclusif**, par `close()`. Il n'y a rien à
  mesurer ici, et le dire vaut mieux que laisser croire.

## Mesures

Publiées **sans seuil**, comme celles de #161, #162 et #163.

| Grandeur                                                           | Où elle est lue                                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| geste de verrouillage → coffre `verrouille` (VM, capture, `close`) | `#coquille-rapport` › `mesures.verrouillageMs`, trois moteurs                 |
| déclencheur employé, et délai retenu                               | `#coquille-rapport` › `verrouillage.declencheur`, `.delaiDInactiviteMs`       |
| état lu par le CADRE après le rechargement                         | `tests/browser/coquille-cycle-de-vie.spec.mjs`, trois moteurs                 |
| délai réel jusqu'au verrouillage automatique                       | pièce jointe `inactivite-*.json`, Chromium (une minute réelle)                |
| instantané présent sur l'OPFS après verrouillage                   | `reports/e2e/reprise-coquille.json` › `verrouillage.instantanesRestants`      |
| prix de la réouverture (instantané vs boot à froid)                | `reports/e2e/reprise-coquille.json` › `secondDemarrage.bootMs`, `.instantane` |

**Ce que le scénario de bout en bout a RELEVÉ**, sur une machine ordinaire (4 vCPU, 16 Gio), le 8
septembre 2026 — sans seuil, comme le reste :

| Grandeur                                           | Relevé             |
| -------------------------------------------------- | ------------------ |
| geste « Verrouiller » → coffre `verrouille`        | **1 859,5 ms**     |
| dont la capture de l'instantané                    | 1 854,6 ms         |
| instantané laissé sur l'OPFS après le verrouillage | 256 332 524 octets |
| premier démarrage, boot à FROID                    | 114 119 ms         |
| réouverture après verrouillage, PAR L'INSTANTANÉ   | **1 038,2 ms**     |

**Le rapport est de cent dix pour un**, et c'est lui qui décide la décision 3 : verrouiller coûte
deux secondes, rouvrir en coûte une. Retirer l'instantané aurait fait de chaque réouverture deux
minutes.

**WebKit est DÉCLARÉ `indisponible`** : rien ne s'y verrouille parce que rien ne s'y ouvre — l'OPFS
synchrone manque au Worker. Ce que la suite y mesure est l'ordre, les refus et l'état publié, et
elle le **déclare** au lieu de passer au vert par vacuité.

## Limites, dites plutôt que tues

- **le délai est un PLANCHER, pas une ponctualité.** Le contrôle de la surveillance rattrape un
  réveil trop TÔT — il replanifie le reste — et jamais un réveil trop TARD. Sur un onglet CACHÉ,
  dont le moteur étire les minuteries à la minute ou davantage, le verrouillage arrive donc APRÈS
  son échéance, jusqu'au prochain réveil que le moteur consent. Aucune épreuve de ce dépôt ne mesure
  cet étirement : il demanderait plus de dix minutes d'attente réelle, et le mesurer sous un délai
  abaissé mesurerait autre chose. Ce que la coquille peut affirmer est qu'elle ne verrouille jamais
  AVANT son délai. **Depuis #170 ([ADR 0032](0032-les-fins-d-onglet-ce-que-le-moteur-livre.md),
  décision 1), c'est un plancher HONORÉ au retour** : sur `resume` et sur un retour à la visibilité,
  l'échéance est relue sur l'horloge et le verrouillage est immédiat si elle est dépassée, au lieu
  d'attendre le réveil d'une minuterie étirée ;
- **le travail dans le cadre est invisible.** Voir la décision 2 : c'est la limite qui borne le
  choix de dix minutes, et elle est écrite là où le chiffre se justifie ;
- **un verrouillage PENDANT un boot est refusé, pas différé.** Le geste rend
  `VAULT_COQUILLE_ETAPE_HORS_ORDRE` et le délai se ré-arme ; il n'est pas mis en file pour être
  servi après les deux minutes du boot. Un utilisateur qui clique « Verrouiller » pendant un
  démarrage doit donc recliquer. C'est assumé : la file du canal privilégié aurait fait attendre la
  coquille sans rien dire, puis capturé l'instantané d'une machine qui vient de démarrer. **Note
  datée du 2026-09-09 (#170, [ADR 0032](0032-les-fins-d-onglet-ce-que-le-moteur-livre.md),
  décision 5)** : cette limite reste vraie du GESTE, et cesse de l'être du DÉLAI. Un verrouillage
  par inactivité refusé pour cause d'ordre est désormais noté **DÛ** et joué à la conclusion du
  boot, succès ou échec — la personne qui clique est là et recliquera ; le délai, lui, n'a personne
  pour le faire. Sans cela, chaque retour d'onglet pendant un boot repoussait l'échéance de dix
  minutes (constat 3 de la revue de sécurité de la PR #177) ;
- **le SCELLEMENT de l'instantané est constaté par l'absence de marqueurs connus**, et non par une
  vérification cryptographique : le scénario de bout en bout n'a ni la DEK ni rien qui y mène. Il
  exige de ne retrouver dans le corps aucun des marqueurs que le guest a écrits en clair. Ce que
  l'en-tête révèle est assumé et écrit ailleurs (ADR 0024, limite 3) ;

- **ce que la sonde d'exfiltration mesure**, et il faut le redire ici : elle mesure ce qui n'est pas
  **persisté**, pas ce qui est **effacé d'un tas**. Elle fouille six stockages, l'OPFS entier en
  texte et en hexadécimal, le DOM et les deux sens des deux ports ; elle ne peut rien dire de la
  mémoire d'un processus, d'un fichier d'échange, ni des octets d'une `CryptoKey` — que, par
  construction, aucun code de cette origine ne peut lire. Ce que la tranche affirme est que le
  Worker qui détenait les clés est mort et qu'aucun geste ne réussit plus sans une nouvelle
  dérivation ;
- **ce que Playwright ne simule pas** : ni une mise en veille du système, ni une éviction d'onglet
  sous pression mémoire, ni un `freeze` livré par le moteur, ni la mort du processus. Le
  verrouillage est déclenché par un bouton et par une minuterie — deux chemins réels, et l'aveu que
  ce ne sont pas tous les chemins. **#170 a mesuré cette liste au lieu de la supposer** : le gel
  demandé par le protocole ne gèle rien et aucun onglet ne devient jamais caché ; le bfcache, lui,
  se mesure — Chromium FENÊTRÉ restaure les documents de la coquille, Firefox et WebKit ne
  restaurent rien sous ce harnais ([ADR 0032](0032-les-fins-d-onglet-ce-que-le-moteur-livre.md),
  décision 3 et § Limites) ;
- **la présence n'est pas mesurable.** Un onglet au premier plan devant un bureau vide ne se
  distingue pas d'un onglet devant quelqu'un (décision 2) ;
- **`terminate()` avant `close()` n'est pas éprouvé dans un NAVIGATEUR.** L'ordre est tenu par un
  `await`, éprouvé par une épreuve unitaire et par un mutant ; ce que l'inverse coûterait est mesuré
  par `tests/unit/vm-reouverture-handles.test.mjs` sur les handles eux-mêmes. Provoquer un vrai
  `terminate()` en vol depuis une épreuve de navigateur demanderait au produit une poignée qu'il n'a
  pas, et qu'il ne doit pas avoir ;
- **les NOMS restent sur le support.** Le volume et son instantané portent des noms de fichiers, et
  l'en-tête d'un instantané n'est pas confidentiel (ADR 0024, limite 3). Ce que le verrouillage
  promet n'est pas l'absence de traces, c'est l'absence de ce qui les OUVRE ;
- **le voisin d'un volume sans VM est un fichier VIDE.** La coquille ouvre deux volumes — le sien et
  celui de l'application —, et interroger l'instantané du premier le crée à zéro octet
  (`src/vm/instantane/support-opfs.mjs`). Le scénario exige donc qu'il en RESTE un qui porte quelque
  chose, et non que tous en portent : la seconde exigence rougirait sur un fichier qui ne promet
  rien ;
- **la fenêtre d'avant le rechargement dure une tâche.** Ce que la coquille y publie est capturé par
  une instrumentation d'ÉPREUVE ; un utilisateur, lui, ne la lit pas. C'est assumé : ce qu'il doit
  voir est le résultat — une coquille verrouillée, sans cadre —, pas la mesure.

## Impacts sur les décisions antérieures

- **[ADR 0024](0024-instantane-de-reprise.md)** — la décision 8 est **RÉVISÉE** : la ligne «
  verrouillage (#25) » passe de « oui » à « **non** », par la décision 3 ci-dessus. La note datée
  est posée dans l'ADR 0024 lui-même. Le reste de la table est **inchangé**, et ses épreuves sont
  rejouées ;
- **[ADR 0029](0029-deverrouillage-dans-la-coquille.md)** — la **limite 2** est bornée : la KEK
  retenue ne dure plus « aussi longtemps que l'onglet », mais jusqu'au geste ou au délai. La limite
  9 (« rien du cycle de vie n'est assemblé […] pas de verrouillage ») perd sa dernière mention ;
- **[ADR 0030](0030-cycle-de-vie-assemble-dans-la-coquille.md)** — le § Impacts disait « la décision
  8 [de l'ADR 0024] n'est **pas** rouverte ici : elle appartient à #25 ». Elle l'est désormais, et
  la note datée le dit. Son § Limites disait que la sonde d'exfiltration serait rejouée par #25
  après un verrouillage : elle l'est ;
- **[ADR 0028](0028-coquille-de-produit-et-frontiere.md)** — la coquille gagne **un geste nommé** et
  **UN code de refus neuf**, `VAULT_COQUILLE_GESTE_ROMPU` : le repli du Worker sur un jet non typé
  rendait `VAULT_COQUILLE_TYPE_INCONNU` — « Requête hors de la liste d'admission » — pour un geste
  qui était, lui, parfaitement admis, et il le rendait là où le message compte le plus, sur
  l'inattendu (constat 5 de la revue de la PR #174). Le code est inscrit au § 10.5 de
  `docs/format-de-volume-v3.md` et tenu par le cliquet d'exhaustivité de
  `tests/unit/dossier-de-revue.test.mjs`. Il ne remplace aucun code TYPÉ. Le bouton « Fermer le
  coffre » devient « Verrouiller » : un bouton remplacé, pas un de plus. Le contrat de messages est
  **inchangé** : aucun type neuf, ni sur le port restreint ni sur le canal privilégié ;
- **[ADR 0021](0021-derivation-des-cles-de-deverrouillage.md)** — la décision 7 est **appliquée**,
  pas révisée : le relevé publie `workerTermine`, jamais `clesEffacees` ;
- **[ADR 0019](0019-fraicheur-du-volume.md)** — le § 6.9 (adversaire OPFS-écriture) fournit le motif
  pour lequel le délai n'est rangé nulle part. Rien n'y change.

## Campagne de mutation

Vingt-huit gardes, chacune retirée du source dans un atelier temporaire, l'épreuve rejouée
(`tools/muter-gardes-verrouillage.mjs`, moteur partagé avec les cinq campagnes précédentes).

| #   | Garde retirée                                                                      | Verdict |
| --- | ---------------------------------------------------------------------------------- | ------- |
| 1   | `armer` — la condition d'ÉTAT : jamais armé sur un coffre non ouvert               | TUÉ     |
| 2   | `armer` — l'IDEMPOTENCE, sur laquelle repose « le cadre ne compte pas »            | TUÉ     |
| 3   | `SIGNAUX_DACTIVITE` — les barrières ne comptent pas                                | TUÉ     |
| 4   | `SIGNAUX_SANS_EFFET` — aucun message du cadre ne compte                            | TUÉ     |
| 5   | `estUnSignalDActivite` — un document caché ne remet pas à zéro                     | TUÉ     |
| 6   | `delaiDInactivite` — la borne BASSE                                                | TUÉ     |
| 7   | `delaiDInactivite` — la borne HAUTE                                                | TUÉ     |
| 8   | `surveillanceDInactivite` — la borne tenue à la CONSTRUCTION                       | TUÉ     |
| 9   | `verifier` — la replanification du reste : l'horloge décide, pas le réveil         | TUÉ     |
| 10  | `signaler` — un signal sur une surveillance désarmée ne l'arme pas                 | TUÉ     |
| 11  | `conduiteApresLeVerrouillage` — le rechargement de la coquille                     | TUÉ     |
| 12  | `conduiteApresLeVerrouillage` — le geste qui rouvre n'est PAS offert               | TUÉ     |
| 13  | `conduiteApresLeVerrouillage` — jamais de réouverture automatique                  | TUÉ     |
| 14  | `conduiteApresLeVerrouillage` — aucune dérivation permise                          | TUÉ     |
| 15  | `conduiteApresLeVerrouillage` — aucune KEK gardée                                  | TUÉ     |
| 16  | `conduiteApresLeVerrouillage` — l'instantané n'est PAS retiré                      | TUÉ     |
| 17  | `conduiteApresLeVerrouillage` — `indisponible` n'est pas `verrouille`              | TUÉ     |
| 18  | `verrouiller` — l'`await` : la capture et les E/S ACCEPTÉES avant le `terminate()` | TUÉ     |
| 19  | `verrouiller` — le rappel de la branche de refus                                   | TUÉ     |
| 20  | `conduiteApresUnRefusDeVerrouillage` — un refus TERMINE le Worker                  | TUÉ     |
| 21  | `conduiteApresUnRefusDeVerrouillage` — un refus RETIRE le cadre                    | TUÉ     |
| 22  | `conduiteApresUnRefusDeVerrouillage` — un refus ne recharge PAS                    | TUÉ     |
| 23  | `refusDOrdre` — la garde d'ordre sur le démarrage en vol                           | TUÉ     |
| 24  | `demarrer` — le `finally` qui rend le verrouillage de nouveau possible             | TUÉ     |
| 25  | `exigerUnDeclencheur` — la table close des deux déclencheurs                       | TUÉ     |
| 26  | `EVENEMENTS_DACTIVITE` — ce que la coquille compte comme une personne              | TUÉ     |
| 27  | `brancherLesSignauxDActivite` — le branchement RÉEL, et sa passivité               | TUÉ     |
| 28  | `brancherLesGestesDuCycle` — le bouton unique, « verrouiller »                     | TUÉ     |

**28/28.** Les dix derniers (n° 19 à 28) sont ceux de la revue de sécurité de la PR #174 : sept pour
le verrouillage refusé, la garde d'ordre et le déclencheur (constats 3 et 8), deux pour la table
d'événements et son branchement (constat 6) — « la garde qui décide ce que la coquille compte comme
une personne était la seule que la campagne ne regardait pas ». Le mutant n° 18 a changé de MOTIF
sans changer de forme : il tue désormais par la capture et les E/S acceptées, et non par un
`VAULT_STORAGE_BUSY` qui n'arrive jamais (constat 2).

Ce que la campagne ne peut PAS mesurer se dit au même endroit : qu'un `pointerdown` soit livré au
document de la coquille, qu'une minuterie d'un onglet en arrière-plan atteigne son échéance, qu'un
`location.reload()` rejoue le cycle, que `close()` libère réellement un handle exclusif. Cela relève
de `tests/browser/coquille-cycle-de-vie.spec.mjs` sur les trois moteurs — dont deux épreuves paient
une minute réelle d'inactivité — et de `tests/e2e/reprise-coquille-boot-froid.spec.mjs` en
intégration continue.

## Alternatives rejetées

- **GELER la VM au lieu de l'arrêter.** Une VM gelée en mémoire tient de la RAM invitée en clair
  dans le processus ; un volume dit verrouillé avec une VM gelée n'est pas verrouillé. La DoR de #25
  le posait déjà en ces termes, et cela s'écrit plutôt que cela se suppose ;
- **garder la KEK « pour plus tard »**, pour épargner à l'utilisateur les deux secondes d'Argon2id à
  la réouverture. C'est exactement la durée que cette tranche est écrite pour borner ; l'épargner
  serait ne rien faire ;
- **admettre un « je suis là » du cadre.** Le délai passerait entre les mains de l'origine dont
  l'ADR 0028 suppose le code hostile. Une application malveillante n'aurait qu'à battre pour
  empêcher tout verrouillage — et une application loyale mais bavarde ferait la même chose sans le
  vouloir ;
- **compter les barrières comme de l'activité.** Un guest qui écrit en boucle n'est pas une
  personne. L'activité qu'on borne est celle de l'utilisateur, pas celle de la machine ;
- **ranger le délai sur l'appareil**, pour qu'il survive à la session. L'adversaire OPFS-écriture de
  l'ADR 0019 § 6.9 l'allongerait, et un délai allongé par un adversaire est un verrouillage
  désactivé sans que personne le voie ;
- **retirer le cadre sans recharger**, en reformulant l'unicité du port de #161 en « un port par
  cadre ». Un compteur de plus dans la base de confiance, contre un rechargement qui n'ajoute rien
  et qui est déjà le chemin de #163 (décision 1) ;
- **retirer l'instantané au verrouillage** — la position par défaut de l'ADR 0024 décision 8. Elle
  est rejetée par la décision 3, avec son argument et son asymétrie assumée ;
- **remonter l'interface ET redemander la phrase automatiquement.** C'est l'autre option de la DoR
  de #24, déjà rejetée par l'ADR 0030 décision 3 : les deux secondes se paient dans les deux cas, et
  la seule question est qui décide de les payer.
