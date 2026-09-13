# ADR 0029 — Le déverrouillage dans la coquille : trois moyens, une attente annoncée, une feuille

- **Statut** : accepté
- **Issue** : [#162](https://github.com/pinfada/railsbox-vault/issues/162), tranche 2 de
  [#24](https://github.com/pinfada/railsbox-vault/issues/24)
- **Précédents** : [ADR 0028](0028-coquille-de-produit-et-frontiere.md) (la coquille de produit et
  son jeton provisoire), [ADR 0021](0021-derivation-des-cles-de-deverrouillage.md) (où chaque
  dérivation se fait, et ce que le dépôt ne peut pas promettre),
  [ADR 0025](0025-moyen-de-recuperation.md) (le code rendu une fois),
  [ADR 0027](0027-archive-et-ancre-de-version.md) (l'ancre de version est une saisie),
  [ADR 0020](0020-enveloppe-de-cle.md) (l'inventaire public)

## Contexte

L'[ADR 0028](0028-coquille-de-produit-et-frontiere.md) a mis la coquille sur le chemin du produit,
avec une réserve écrite dans sa décision 4 : **le geste de déverrouillage venait du HARNAIS**, sous
le jeton de `src/vm/cle-de-volume.mjs`, lu d'un paramètre d'URL. `public/runtime-worker.mjs` était
alors le premier — et le seul — fichier de PRODUIT inscrit à `tests/unit/harnais-portes.test.mjs`,
et son inscription portait la date de sa sortie : « Provisoire : #162 le retire ».

Trois autres décisions attendaient la même tranche, chacune écrite avant que quiconque ait à
l'implémenter :

- l'[ADR 0021](0021-derivation-des-cles-de-deverrouillage.md) § « Mesures » se termine sur « ce que
  la mesure appelle est un travail d'INTERFACE (#24) — **annoncer l'attente plutôt que la subir** —,
  pas un travail de cryptographie » : Firefox paie 2 136 ms là où Chromium en paie 363 ;
- l'[ADR 0025](0025-moyen-de-recuperation.md) § « Risques » réserve à #24 « la découpe affichée,
  l'aide à la saisie, un contrôle en direct par la somme » ;
- l'[ADR 0027](0027-archive-et-ancre-de-version.md) décision 3 pose que **l'ancre est une SAISIE de
  l'utilisateur dans la coquille, jamais une valeur lue d'un stockage de l'appareil**, et que la
  feuille de récupération porte, à côté du code, la version d'enveloppe.

Et `SECURITY.md` portait, pour `SEC-RECOVERY-001`, une réserve d'une phrase : « le mécanisme est
éprouvé de bout en bout ; la réserve qui reste est qu'**aucun chemin de production ne l'offre à un
UTILISATEUR** ».

Cette tranche paie les quatre.

## Décision 1 — Le jeton de harnais QUITTE le chemin de produit

`public/main.mjs` ne lit plus de paramètre `deverrouillage-harnais` ; `public/runtime-worker.mjs`
n'appelle plus `cleDeVolumeDuHarnais` ni `clesDeDeverrouillageDuHarnais`. Le type
`vault.coquille.deverrouiller` du contrat ne connaît plus de jeton : il porte un MOYEN, son geste,
et l'ancre de version.

**Le cliquet se durcit avec le retrait, et c'est la moitié qui compte.**
`tests/unit/harnais-portes.test.mjs` exigeait « un seul appelant de PRODUIT, et il porte l'issue qui
l'en retirera » ; il exige désormais **aucun**. Ce n'est pas la même propriété : la première
tolérait qu'il en reste un. Une seconde épreuve nomme les trois fichiers du chemin de produit de la
coquille un par un — une liste peut être juste et un fichier avoir été oublié dans un balayage trop
étroit.

Symétriquement, `tests/unit/coquille-fixture.test.mjs` EXIGEAIT le paramètre (« la coquille doit
LIRE le jeton d'un paramètre nommé, et non le porter ») ; il exige désormais son ABSENCE. Une
épreuve qui aurait seulement cessé d'exiger le paramètre n'aurait rien empêché.

**Ce que le jeton reste**, et il faut le redire, parce que la revue de la PR #166 l'avait corrigé
une fois : il est PUBLIC, il est dans l'arbre servi, et un seul fichier publié le porte — celui qui
le définit. Ce qui change ici n'est pas sa visibilité, c'est qu'il n'ouvre plus **aucune** porte sur
le chemin du produit, y compris pour qui atteindrait le canal privilégié. L'épreuve de #161 qui le
lit depuis l'origine applicative reste verte, et l'affirmation qu'elle porte s'est élargie plutôt
que réduite. Les bancs, eux, le franchissent toujours, sous la même porte et avec leur motif
inscrit.

## Décision 2 — Trois moyens, trois conduites, et l'attente ANNONCÉE

### Où chaque dérivation se fait

Rien n'est réinventé : c'est la décision 5 de
l'[ADR 0021](0021-derivation-des-cles-de-deverrouillage.md), appliquée au chemin de produit.

| Moyen          | Dérivé             | Ce qui franchit le port                        | Annonce d'attente |
| -------------- | ------------------ | ---------------------------------------------- | ----------------- |
| `phrase`       | dans le **Worker** | la phrase, page → Worker, MÊME origine         | oui               |
| `webauthn-prf` | dans la **page**   | une `CryptoKey` NON EXTRACTIBLE, page → Worker | non (0 à 2 ms)    |
| `recuperation` | dans le **Worker** | le code, page → Worker, après contrôle local   | non (0 à 2 ms)    |

`src/coquille/moyens-de-deverrouillage.mjs` porte cette table, et le Worker s'en sert pour choisir :
un moyen dont `derivePar` vaut `page` EXIGE une `CryptoKey` et n'accepte aucun octet ; un moyen dont
`derivePar` vaut `worker` n'accepte aucune clé et exige un geste. Les deux gardes ne font pas double
emploi — l'une décide ce qui a le droit de PARTIR (`enveloppePrivilegiee`), l'autre ce qui a le
droit d'ARRIVER (`exigerKekDeLaPage`), et une seule des deux laisserait le canal ouvert dans le sens
qu'elle ne garde pas.

**La phrase n'est pas conservée après l'envoi.** Le champ est vidé AVANT l'appel — donc pendant les
deux secondes de la dérivation, c'est-à-dire pendant tout le temps où quelqu'un regarderait
par-dessus l'épaule — et la variable est relâchée. Ce n'est pas un effacement, et le dire ainsi est
la moitié du travail : « IMPOSSIBLE — effacer la phrase. C'est une `string` JavaScript : immuable,
copiée par le moteur, ramassée quand il le décide » (ADR 0021, décision 7). Ce qui est fait est ce
que le langage permet, ni plus, ni moins.

### L'attente annoncée, et sa table RELUE

`src/coquille/attente-annoncee.mjs` porte les mesures de l'ADR 0021 § « Mesures », et
`tests/unit/coquille-deverrouillage.test.mjs` **confronte chaque valeur au tableau de l'ADR** : les
deux ne peuvent pas diverger sans qu'une épreuve rougisse. C'est ce qui donne un sens au mot « relue
» : une annonce est une promesse faite à l'utilisateur sur la foi d'une mesure, et si la mesure est
refaite un jour sans la table, la coquille ment sans que personne ne l'ait décidé.

Trois choix, et chacun se justifie dans un seul sens :

- **le p95 le plus HAUT des deux exécutions**, jamais le p50. Ce qu'on annonce est ce que
  l'utilisateur risque d'attendre, pas ce qu'il attendra la moitié du temps : une médiane annoncée
  est fausse une fois sur deux, et toujours dans le sens qui déçoit ;
- **un moteur inconnu retombe sur le PLUS LENT.** Annoncer deux secondes pour une attente de trois
  cents millisecondes fait passer un geste pour plus lent qu'il n'est, ce qui déçoit dans le bon
  sens ; l'inverse fait croire à une panne ;
- **le code et la passkey n'annoncent RIEN.** Annoncer une attente qui n'existe pas ferait douter
  d'un geste immédiat, et diluerait l'annonce qui compte. `MOYENS_ANNONCES` est une liste close.

L'annonce est peinte AVANT que la dérivation ne prenne le fil — une seule ligne, `await peindre()`,
dont l'ordre est le sujet —, et la coquille publie les deux délais depuis le GESTE :
`annonceApresLeGesteMs` et `deverrouillageMs`. Une annonce peinte après le calcul n'est pas une
annonce ; c'est cet écart-là que la mesure ci-dessous montre.

### Le contrôle EN DIRECT du code, et ce qu'il sépare

La saisie est ramenée à la forme du produit à chaque frappe : séparateurs libres, casse libre,
replis de Crockford (`O`→`0`, `I`/`L`→`1`), découpe affichée en sept groupes de quatre. **Voir la
différence est plus utile que lire une règle de saisie.**

La somme ISO 7064 est vérifiée AVANT tout envoi, et le bouton reste fermé tant qu'elle ne vérifie
pas : **le Worker de confiance ne voit jamais un code mal recopié**, et l'utilisateur n'attend pas
une dérivation pour apprendre qu'il a mal lu un « 5 ». Les deux refus restent DISTINCTS à l'écran
comme dans le code :

- `VAULT_DERIVATION_CODE_MAL_RECOPIE` — « relisez la feuille » : rien n'a été dérivé, rien n'a été
  tenté, et le remède est entre les mains de qui lit ;
- `VAULT_ENVELOPPE_CLE_REFUSEE` — « ce code n'ouvre pas ce coffre » : la dérivation a eu lieu,
  l'enveloppe a tranché, et le remède est ailleurs.

Les confondre ferait chercher une faute de recopie là où il y a un mauvais coffre. Pour tenir UNE
seule table de signes acceptés, `code-de-recuperation.mjs` expose désormais `balayerSaisie`, que le
décodeur strict et le contrôle en direct partagent : une interface qui aurait recopié l'alphabet
pour son affichage aurait fini par accepter à l'écran ce que le décodeur refuse.

### Un seul emplacement à la fois, choisi par le TYPE

La coquille lit l'INVENTAIRE public de l'enveloppe (`inventorierEnveloppe`, canal auxiliaire assumé
de l'ADR 0020) et n'offre que les moyens présents. **Elle ne devine jamais.** Une coquille qui
offrirait les trois sans regarder ferait dériver une phrase pendant deux secondes sur un coffre qui
n'a jamais eu d'emplacement `phrase`, pour finir sur un refus qui dit « cette clé n'ouvre rien » là
où la vérité est « ce moyen n'existe pas ici ».

Un type que le catalogue ne sert pas — y compris `harnais`, désormais — est ANNONCÉ « ce Vault a été
fermé par une version du produit plus récente que celle-ci », et n'empêche pas les autres de servir
: c'est la compatibilité du point 5 du contrat de #22, avec l'aveu en plus.

Ce que la page reçoit de l'inventaire est borné à ce dont elle a besoin : les types, les
identifiants d'emplacement, la version, et — pour `webauthn-prf` SEULEMENT — les paramètres publics
en hexadécimal, parce que c'est le seul type qu'elle dérive elle-même. **Rien de cela ne franchit
jamais le port RESTREINT** : la réponse d'état du document applicatif porte toujours ses deux
champs.

## Décision 3 — Créer le moyen de récupération, et RENDRE le code une seule fois

Le geste est réservé au volume OUVERT — il faut détenir une KEK valable pour ajouter un emplacement
(ADR 0020) —, et le refus est TYPÉ : `VAULT_COQUILLE_VOLUME_VERROUILLE`. Le dire par un code plutôt
que par un bouton grisé a une raison : un bouton grisé n'apprend rien à qui l'atteint autrement, et
l'épreuve n'a rien à mesurer.

Le code est rendu UNE fois par le canal Worker → page, et le PORTEUR de l'ADR 0025 est retenu dans
le Worker : `rendre()` relâche la chaîne au premier appel et lève `VAULT_DERIVATION_CODE_DEJA_RENDU`
ensuite. Le recréer à chaque demande rendrait un code NEUF à chaque clic, ce qui est exactement le
défaut que « rendu une seule fois » prétend fermer.

Ce que la coquille affiche est **la FEUILLE** : le code en sept groupes de quatre, ET la version
d'enveloppe à côté. Les deux ensemble, jamais l'un sans l'autre — un code sans version laisse
l'ancre vide et le plancher de rejeu inopposable ; une version sans code ne secourt rien.

**La page n'écrit le code NULLE PART.** Pas de presse-papiers automatique — un presse-papiers est
lisible par tout ce qui tourne sur la machine, et le remplir sans qu'on le demande déplace le secret
hors du seul endroit où il devait vivre. Pas de stockage, pas de journal, pas de champ caché : le
relevé de l'interface porte un BOOLÉEN `codeRendu`, jamais la chaîne. Une épreuve unitaire balaye
les appels d'écriture dans les cinq fichiers du chemin, et le balayage est confronté à un dépôt
qu'on lui présente — un balayage à vide passe toujours.

**L'impression sort par un chemin que le produit ne maîtrise pas** — pilote, file d'attente, parfois
un PDF déposé sur le disque. `SECURITY.md` le dit ; la coquille ne le promet pas et n'offre pas de
bouton d'impression.

## Décision 4 — La feuille et l'ancre

**La version d'enveloppe est une SAISIE.** La coquille PROPOSE un champ, ne l'impose jamais, et
transmet `versionMinimale` au Worker qui le passe à `ouvrirEnveloppe`. Trois conduites :

- **saisie** — la coquille dit ce qu'elle ferme : « une page d'enveloppe antérieure sera refusée par
  `VAULT_ENVELOPPE_REJEU` », et **l'étendue avec la promesse** : « cela ferme le retour arrière du
  SEUL fichier d'enveloppes ; un retour arrière complet du support reste indétectable » ;
- **vide** — la coquille AVOUE, à l'écran : « le plancher de rejeu n'est PAS opposé. Si quelqu'un a
  remis en place une page d'enveloppe plus ancienne sur cet appareil, une clé que vous aviez
  révoquée peut encore ouvrir ce coffre, et rien ici ne le verra. » C'est la seconde moitié de la
  décision 3 de l'ADR 0027 — « rien n'est exigé, ET RIEN N'EST PROMIS » —, celle qui disparaît des
  interfaces parce qu'elle n'apporte rien à qui veut juste ouvrir son coffre. Elle est portée par un
  module et cherchée à l'écran par une épreuve ;
- **refusée** — une version qui n'est pas un entier ≥ 1 est refusée, jamais corrigée : « 12a » n'est
  pas 12. La garde existe des deux côtés, page et Worker, parce qu'une garde qui n'existe que du
  côté de l'interface n'est pas une garde.

**`VAULT_ENVELOPPE_REJEU` nomme SES DEUX replis** (ADR 0027, limite 4) : relire la version — un
chiffre recopié trop haut refuse une enveloppe saine —, et à défaut vider le champ et rouvrir SANS
plancher, en sachant ce qu'on abandonne. Le second est un geste EXPLICITE et DISTINCT, jamais un
repli automatique après échec : un contournement qui s'obtient par insistance n'est plus un aveu.

**Après la création du moyen de récupération**, la coquille affiche la nouvelle version « à noter
sur la feuille ». Jamais à chaque ouverture : une consigne affichée à chaque fois cesse d'être lue
avant la troisième, et le jour où elle compte vraiment elle est invisible. Les révocations
(`revoquerEmplacement`, `revoquerToutSauf`, `remplacerEmplacement`) ne sont pas offertes par cette
tranche — elles appartiennent au cycle de vie assemblé (#163) — et la fonction qui écrit la consigne
prend le nom du geste en paramètre, pour qu'elles s'y branchent sans la réécrire.

**`recovery: null` est VISIBLE.** L'export n'entre pas dans cette tranche ; le message existe dans
`feuille-de-recuperation.mjs`, il est éprouvé, et la coquille le montre déjà où elle le peut : dès
qu'un volume ouvert n'a AUCUN emplacement de récupération. C'est mieux qu'au moment de l'export — un
avertissement qui n'apparaîtrait qu'à ce moment-là arriverait après que l'archive a été prise. Quand
#163 offrira l'export, c'est ce texte-là qui précédera le geste.

Le **CONSENTEMENT NOMMÉ** de la restauration antérieure à la feuille est écrit au même endroit, mot
pour mot avec l'ADR 0027, et une épreuve confronte la citation à l'ADR. La restauration elle-même
n'est pas offerte ici.

## Décision 5 — La dérivation d'une phrase vit dans un WORKER DÉDIÉ

### Ce que la première rédaction avait manqué

Le canal privilégié est traité EN SÉRIE depuis #161, et l'ADR 0028 en donne le motif. Cette tranche
a mis dans cette file un geste qui dure **deux mille cent millisecondes** sur le moteur le plus
lent, et la coquille relaie la question d'ÉTAT pour le DOCUMENT APPLICATIF : celui-ci s'est retrouvé
à attendre derrière la phrase que l'utilisateur venait de taper. La suite de frontière de #161 l'a
mesuré en rougissant sous Firefox — le geste ADMIS, le seul que la coquille serve, dépassait le
délai d'une seconde de la fixture, et quatre requêtes concurrentes restaient muettes.

La première correction a sorti la lecture d'état de la FILE de promesses du Worker. **Elle ne
pouvait rien, et c'est la leçon de cette décision : il n'y a pas de file qui tienne quand le FIL est
pris.** `argon2Vendu` appelle le module WebAssembly de façon SYNCHRONE ; pendant tout le calcul, le
Worker ne dispatche aucun message, dans la file ou hors d'elle. La revue de sécurité de la
[PR #167](https://github.com/pinfada/railsbox-vault/pull/167) l'a établi par une sonde posée sur
`MessagePort.prototype` : état posté 400 ms après le clic, réponse en **1 777 à 2 158 ms** sous
Firefox, contre moins d'une milliseconde au repos.

C'était une FAMINE, sur exactement la propriété que « un refus typé, jamais un silence » protège, et
sur le témoin positif de `SEC-ORIGIN-001` par-dessus le marché.

### La décision

**La dérivation d'une phrase s'exécute dans un Worker DÉDIÉ** (`public/derivation-worker.mjs`), créé
par la PAGE, qui rend une `CryptoKey` NON EXTRACTIBLE. Le Worker de confiance ne dérive plus de
phrase : il reçoit un handle opaque, exactement comme il reçoit celui d'une passkey depuis le début
de la tranche.

L'ADR 0021 décision 5 dit « le faire sur le fil de la page gèlerait l'interface ». C'est vrai, et
cela ne dit pas DANS QUEL Worker : la contrainte est « dans un Worker », pas « dans CELUI-LÀ ».

**Pourquoi la PAGE le crée, et non le Worker de confiance.** Les deux étaient possibles ; trois
motifs départagent, dont un seul suffirait :

- **il ne demande aucune capacité nouvelle.** Un Worker imbriqué en exigerait une que
  `docs/compatibility.md` ne mesure sur aucun des trois moteurs, et #162 n'a pas à ajouter une ligne
  au dossier de portabilité pour un calcul. `worker-src 'self'` (ADR 0013) couvre déjà ce Worker-ci
  : il n'y a rien à élargir ;
- **il donne UNE seule forme aux deux moyens dérivés hors du Worker de confiance.** La passkey l'est
  déjà, parce que `navigator.credentials` n'existe que dans un document ; la phrase le devient, et
  le Worker de confiance reçoit dans les deux cas la même chose, par la même porte, sous la même
  garde ;
- **il RÉDUIT ce que le Worker de confiance fait.** Il gardait un calcul qui n'avait besoin d'aucun
  de ses handles : ni l'OPFS, ni l'enveloppe, ni la clé de volume n'entrent dans une dérivation.

**Ce que le Worker de dérivation ne peut pas atteindre** : il n'importe que de quoi dériver une
phrase — une épreuve unitaire relit ses imports, parce qu'une propriété qui tient à ce qu'un fichier
ne fasse pas quelque chose se relit mieux qu'elle ne se croit. Il ne touche ni l'OPFS, ni
l'enveloppe, ni le volume, ni le port privilégié, et **il meurt après usage** (`self.close()`). Son
tas — la phrase comprise — s'en va avec lui : c'est plus franc qu'un effacement, que le langage ne
permet pas sur une `string` (ADR 0021, décision 7), et c'est un effet du découpage plutôt qu'une
promesse cryptographique. La sonde d'exfiltration couvre son port dans les deux sens.

**Ce qui ne change pas** : la phrase ne quitte pas l'origine de CONFIANCE. Elle franchit un port de
plus, à l'intérieur de la même origine — la limite 4 de l'ADR 0021, inchangée dans sa nature.

### La mesure

`npm run test:coquille:deverrouillage`, épreuve « le Worker de confiance répond PENDANT une
dérivation ». Vingt questions d'état au repos, vingt pendant que la dérivation calcule.

| Moteur   |         au repos (p50 / p95 / max) | PENDANT une dérivation (p50 / p95 / max) |
| -------- | ---------------------------------: | ---------------------------------------: |
| Chromium |                 0,1 / 0,5 / 0,5 ms |                   0,2 / 0,8 / **0,8 ms** |
| Firefox  |                       0 / 1 / 1 ms |                         1 / 2 / **2 ms** |
| WebKit   | volume hors d'atteinte, refus typé |                                        — |

**Firefox passe de 1 777–2 158 ms à 2 ms.** Ce que l'épreuve AFFIRME n'est pas ce chiffre, qui
dépend de la machine, mais le seul rapport qui n'en dépende pas : le maximum observé pendant une
dérivation reste sous le budget que le document applicatif s'accorde — mille millisecondes, RELUES
de la fixture plutôt que recopiées.

### Deux corollaires, du même défaut

La coquille appariait la réponse applicative à une promesse qui, depuis #162, peut être ROMPUE —
c'est ainsi qu'un refus du Worker remonte. Deux conséquences qu'aucune épreuve ne mesurait :

- une rupture laissait le document applicatif SANS réponse. Il reçoit désormais le dernier état
  CONNU — jamais le code du Worker, qui ferait de sa réponse un oracle sur l'enveloppe. Un refus sur
  la question d'état est un défaut de la coquille, jamais une faute du document applicatif ;
- l'identifiant de corrélation n'était relâché que dans la branche du SUCCÈS, et jamais du tout si
  la promesse ne se réglait pas. Un Worker mort remplissait donc les trente-deux emplacements et
  fermait le port pour de bon — le déni de service que l'ADR 0028 déclare écarté. Il est relâché
  quoi qu'il arrive, et `DELAI_WORKER_MORT_MS` borne l'attente à trente secondes, sous un refus TYPÉ
  (constat 11 de la revue).

## Décision 6 — La coquille NOMME ses bornes, et un geste impossible rend un refus TYPÉ

Trois défauts, trouvés par la première exécution en **intégration continue** de cette tranche (run
34088213342 sur `8d09085`), et qui ne s'étaient pas montrés en local. Ils partagent une racine : le
produit laissait à d'autres — un module, un moteur, un instant — des décisions qui lui
appartiennent.

### La borne d'un geste de passkey

`derivateur-webauthn-prf.mjs` proposait `DELAI_MS`, **une minute**, et l'imposait à l'enregistrement
: le paramètre `delaiMs` n'existait que du côté de l'ASSERTION. Une coquille qui adopte ce défaut
reste MUETTE pendant soixante secondes quand aucun authentificateur ne répond, et une interface
muette pendant une minute est indiscernable d'un plantage — l'utilisateur ferme l'onglet avant que
le refus n'arrive.

**La coquille nomme sa borne : `DELAI_PASSKEY_MS`, trente secondes.** C'est largement de quoi
toucher un lecteur d'empreinte, taper un code, ou prendre une clé posée à côté de soi ; et c'est
assez court pour que le refus TYPÉ — `VAULT_DERIVATION_ANNULEE`, sans pénalité et sans compteur —
arrive pendant que l'utilisateur regarde encore l'écran. `enregistrerEmplacementPrf` accepte
désormais `delaiMs`, comme l'assertion l'acceptait déjà : c'est le même geste humain sur le même
authentificateur, et l'asymétrie ne se justifiait par rien.

**La limite** : un authentificateur qu'on va chercher dans un tiroir dépassera cette borne, et
l'utilisateur devra recommencer. C'est le prix d'un refus qui arrive.

### Un geste impossible rend un refus, pas un état

Sur un moteur sans accès synchrone à l'OPFS dans un Worker, `deverrouiller` rendait l'ÉTAT
`indisponible`. La coquille le prenait pour un succès et affichait **« Coffre ouvert »** — sur un
moteur où rien ne s'était ouvert. C'est la pire des trois issues possibles : pas un refus, pas un
silence, un mensonge.

L'absence reste un ÉTAT — `indisponible` dit « ce moteur ne sait pas » là où `verrouille` dirait «
il faut un geste ». Mais le GESTE reçoit désormais `VAULT_STORAGE_UNSUPPORTED`, le code que le dépôt
emploie déjà partout pour cette absence, et que `deverrouillage-frontiere.spec.mjs` EXIGE des
scénarios qui touchent un volume. Les deux suites nomment la même limite du même nom.

### L'état publié est DÉTERMINISTE au démarrage

C'est en lisant l'enveloppe que le Worker découvre l'absence d'OPFS et pose `indisponible`. Le
relevé de la page, lui, gardait le `verrouille` de la poignée de main et ne basculait que lorsque le
document applicatif posait SA question d'état — à un instant que personne ne contrôle. La coquille
redemande donc l'état APRÈS l'inventaire. Ce n'était pas une divergence entre moteurs : c'était une
COURSE, et elle expliquait qu'une suite verte en local rougisse en intégration continue.

### Ce que les épreuves en tirent

Aucun `test.skip` dans la suite : sur un moteur qui ne peut pas atteindre un volume, chaque scénario
EXIGE l'état `indisponible` ET le refus typé du geste suivant. C'est la convention de
`deverrouillage-frontiere.spec.mjs`, tenue ici aussi — **la limite est écrite, pas maquillée**. Le
délai de l'épreuve de passkey DÉRIVE de `DELAI_PASSKEY_MS` au lieu de le deviner : les deux ne
peuvent plus se courir après, quelle que soit la valeur choisie plus tard. C'est ce qui avait rendu
cette épreuve « flaky » — elle attendait exactement aussi longtemps que ce qu'elle mesurait.

## Ce que la coquille n'écrit JAMAIS

| Ce qui ne s'écrit nulle part | Où c'est mesuré                                                                           |
| ---------------------------- | ----------------------------------------------------------------------------------------- |
| la phrase                    | sonde des six stockages, OPFS texte + hex, deux sens des deux ports, trois moteurs        |
| le code, forme rendue        | idem ; le SEUL canal légitime est le retour du Worker, affirmé positivement               |
| le code, forme humaine       | idem ; elle n'a AUCUN canal légitime, et est cherchée partout sans exception              |
| le code sans tirets          | idem                                                                                      |
| les seize octets du code     | idem, en hexadécimal                                                                      |
| le matériau HKDF du code     | idem, SHA-256 des seize octets                                                            |
| la KEK, la DEK               | `sansCapacite` refuse les constructeurs ; la fouille du trafic cherche les octets recodés |
| un cookie                    | `tests/browser/coquille-frontiere.spec.mjs`, inchangé depuis #161                         |

**La sonde est instrumentée par l'ÉPREUVE, jamais par le produit**, et c'est un écart voulu avec le
banc de #22. Celui-ci tient lui-même un journal de ce qui franchit son port ; la coquille de produit
ne peut pas se le permettre — un journal du canal privilégié serait un endroit de plus où le code
survit, dans un tableau que personne ne pense à effacer, et il aurait fallu l'exclure de la sonde
pour que la sonde passe. L'enregistreur est donc posé par `page.addInitScript` sur
`MessagePort.prototype`, AVANT tout script de la page. Il est strictement plus fort que le journal
du banc : il voit tout ce qui franchit un port, y compris ce que le produit n'a pas retenu.

## Le défaut trouvé par exécution : un corps qui recouvrait son propre contrat

`enveloppeDeMessage` étale le corps APRÈS les trois champs d'identité — c'est ce qui la rend lisible
d'un regard. La réponse d'inventaire portait la version de l'ENVELOPPE sous le nom `version` : elle
écrasait donc la version du CONTRAT, et le décodeur d'en face refusait le message sous
`VAULT_COQUILLE_CONTRAT_REFUSE`. **Un message parfaitement formé, jeté par sa propre moitié
réceptrice, sans qu'aucune des deux ne soit fautive.**

Il ne se voyait nulle part : le corps était bien formé, le refus était typé, et le seul symptôme
était une promesse qui n'aboutissait jamais — la coquille restait en `demarrage`, sans erreur, sans
journal, sans rien. La correction est double : le champ s'appelle `versionEnveloppe`, et
`exigerCorpsSansIdentite` interdit désormais qu'un corps porte `contrat`, `version` ou `type`. La
seconde moitié est celle qui compte : renommer le champ répare ce cas, la garde ferme la classe.

Le même passage a corrigé un défaut de #161 relevé en chemin : le seul chemin d'erreur du démarrage
appelait `.push` sur `rapport.requetesRefusees`, devenu un NOMBRE quand la revue de la PR #166 a
remplacé les tableaux par des compteurs. Il levait au lieu de rendre son état, et ne se voyait qu'au
moment où quelque chose d'autre avait déjà échoué.

## Mesures

`npm run test:coquille:deverrouillage`, trois moteurs, machine de développement Windows 11. Les deux
délais sont comptés depuis le GESTE — le clic —, et non depuis le chargement de la page : ce qu'ils
mesurent est un délai RESSENTI.

| Moteur   | geste → annonce | geste → coffre ouvert | attente annoncée |
| -------- | --------------: | --------------------: | ---------------: |
| Chromium |         < 20 ms |          400 à 700 ms |           446 ms |
| Firefox  |         < 20 ms |      2 100 à 2 600 ms |         2 207 ms |
| WebKit   |         < 20 ms |   état `indisponible` |           458 ms |

Les relevés exacts sont attachés à chaque exécution
(`coquille-deverrouillage-phrase-<moteur>.json`). Ce qui est AFFIRMÉ par l'épreuve est le seul
rapport qui ne dépende pas de la machine : **l'annonce précède l'ouverture**. Aucun seuil n'est posé
— un seuil sur un exécutant partagé mesurerait la charge de l'exécutant.

Le déverrouillage par CODE ne dépasse pas quelques millisecondes sur les deux moteurs qui
l'exécutent, et n'annonce rien : c'est la condition de la décision 1 de l'ADR 0025, déjà gardée par
`deverrouillage-frontiere.spec.mjs` à chaque exécution.

## Limites

1. **L'ÉPAULE.** Rien ici ne protège de quelqu'un qui regarde l'écran. Le champ de phrase est un
   `type="password"`, le champ de code ne l'est pas — le code se recopie d'un papier et se relit à
   l'écran, le masquer rendrait l'aide à la saisie inutilisable —, et la feuille de récupération est
   affichée en clair, ce qui est tout son objet. Le seul geste que le produit fait est de vider le
   champ de phrase avant la dérivation, ce qui réduit la fenêtre sans la fermer ;
2. **la KEK est RETENUE dans le Worker de confiance** pour la durée de la session ouverte. Créer un
   moyen de récupération exige de détenir une clé qui ouvre déjà (ADR 0020) ; sans rétention, la
   coquille devrait redemander la phrase — donc la faire vivre une seconde fois, et payer une
   seconde dérivation de deux secondes — pour un geste que l'utilisateur vient de rendre possible.
   Elle vit du même côté de la frontière que la DEK et ne franchit aucun port, mais c'est un endroit
   de plus où un secret existe, et il dure aussi longtemps que l'onglet. **Note datée du 8 septembre
   2026 : cette durée est désormais BORNÉE.** #169 (tranche 1 de #25) la borne par deux déclencheurs
   — un geste « Verrouiller » et un délai d'inactivité de dix minutes — qui tuent le Worker de
   confiance après la fermeture propre des volumes. « Aussi longtemps que l'onglet » se lit donc «
   jusqu'au geste ou au délai, et au plus jusqu'à l'onglet ». Voir
   l'[ADR 0031](0031-verrouiller-le-worker-meurt-l-instantane-survit.md), décisions 1 et 2 ;
3. **l'IMPRESSION n'est pas maîtrisée.** Le bouton d'impression d'un navigateur écrit vers un
   pilote, une file d'attente, parfois un PDF déposé sur le disque. La coquille n'en offre pas et ne
   promet rien à ce sujet ;
4. **la FEUILLE reste un geste de l'utilisateur.** Le produit affiche ; il ne sait pas si quelqu'un
   a recopié, ni où. Une feuille perdue, non notée ou mal recopiée ne protège de rien, et le produit
   n'a aucun moyen de le savoir (ADR 0027, limite 4) ;
5. **la borne de passkey est de trente secondes** (décision 6). Un authentificateur qu'on va
   chercher ailleurs dans la pièce dépassera cette borne : le refus est typé, aucune pénalité n'est
   comptée, et le geste se recommence à l'identique — l'épreuve d'annulation de #22 le mesure ;
6. **le gestionnaire de mots de passe du navigateur.** Le champ porte `autocomplete="new-password"`,
   qui DEMANDE de ne pas proposer d'enregistrer ; aucun moteur ne le garantit, et un utilisateur
   peut toujours enregistrer sa phrase de son propre chef. C'est ce que le produit peut demander,
   pas ce qu'il peut garantir ;
7. **aucune esthétique.** L'interface est un HTML sémantique sans style. C'est un chemin de produit,
   pas un design, et l'apparence relève d'un travail qui n'a pas encore d'issue. Elle se lit au
   clavier et par un lecteur d'écran, et ne promet rien qu'elle ne tienne ;
8. **aucun authentificateur RÉEL n'est mesuré**, et la limite 2 de l'ADR 0021 reste entière : un
   authentificateur virtuel répond instantanément et accepte tout ;
9. **rien du cycle de vie n'est assemblé.** Pas d'export, pas de restauration, pas de révocation,
   pas de verrouillage, pas de COOP. Ce sont #163, #25 et la suite de #24. **Note datée du 8
   septembre 2026** : le cycle est assemblé depuis #163 (ADR 0030), COOP est servi et attesté, et le
   VERROUILLAGE est livré par #169 (ADR 0031). Restent hors de cette limite l'export, la
   restauration et la révocation depuis la coquille. **Note datée du 13 septembre 2026** : levée par
   l'[ADR 0039](0039-sauvegarder-restaurer-revoquer-depuis-la-coquille.md) (#207) ;
10. **une dérivation occupe le Worker de confiance pendant deux secondes.** La question d'état en
    sort (décision 5), mais tout ce qui MUTE reste derrière : un second geste posé pendant une
    dérivation attend qu'elle finisse. C'est voulu — deux ouvertures concurrentes sur la même
    enveloppe seraient pires que l'attente — et cela reste une propriété que l'interface ne montre
    pas ;
11. **le déverrouillage crée le coffre s'il n'existe pas**, sous la phrase ou la passkey présentée.
    C'est ce que faisait #161 avec les clés du harnais, et c'est ce qui rend un coffre neuf ouvrable
    ; un flux de création NOMMÉ — qui dirait « vous créez un coffre » avant de le créer — appartient
    au cycle de vie assemblé.

## Alternatives rejetées

- **Un bouton « copier le code » qui remplit le presse-papiers.** C'est l'ergonomie évidente, et
  c'est pour cela qu'elle est écartée nommément : un presse-papiers est lisible par tout ce qui
  tourne sur la machine, il survit à la fermeture de l'onglet sur plusieurs systèmes, et il est
  synchronisé entre appareils par certains. Le remplir déplacerait le secret hors du seul endroit où
  il devait vivre, sans que l'utilisateur l'ait demandé ;
- **Lire la version d'enveloppe d'un stockage local**, au lieu de la faire saisir. C'est l'ADR 0027,
  décision 3, et le motif y est écrit : « une version rangée à côté du fichier qu'elle protège est
  ramenée en arrière par le même geste que lui ». Une ancre qui vit sur l'appareil qu'elle surveille
  n'est pas une ancre ;
- **Un compte à rebours pendant la dérivation.** Il faudrait le tenir, et le produit ne le peut pas
  : Argon2id occupe le fil du Worker sans progression observable, et le nombre annoncé est un ordre
  de grandeur mesuré sur une autre machine. Un compte à rebours qui dérive est pire qu'une phrase ;
- **Un seul code de refus pour la passkey.** Les trois conduites de l'ADR 0021 — indisponible,
  ignorée, annulée — restent distinctes à l'écran comme dans le code. Les fondre en « la passkey a
  échoué » ferait chercher un autre authentificateur là où il faut un autre moyen, et l'inverse ;
- **Journaliser le trafic du port dans la coquille**, comme le banc de #22 le fait, pour que la
  sonde ait quelque chose à fouiller. Ce serait un endroit de plus où le code de récupération survit
  — et il aurait fallu l'exclure de la sonde pour que la sonde passe. L'épreuve instrumente
  `MessagePort.prototype` à la place, ce qui voit strictement plus.

## Campagne de mutation

`node tools/muter-gardes-coquille.mjs` — la table de #161 s'allonge de quatorze gardes, toutes dans
`src/coquille/`, pour le motif exact des vingt-trois premières : une garde écrite dans
`public/main.mjs` ne serait éprouvable que par un navigateur, donc jamais par un enfant borné.

| N°  | Garde retirée                                                           | Verdict |
| --- | ----------------------------------------------------------------------- | ------- |
| 24  | `exigerCorpsSansIdentite` — un corps ne recouvre pas l'identité         | TUÉ     |
| 25  | `enveloppePrivilegiee` — la capacité n'est admise que sur le privilégié | TUÉ     |
| 26  | `exigerKekOpaque` — une CryptoKey extractible est refusée               | TUÉ     |
| 27  | la somme de contrôle, vérifiée avant que la saisie soit envoyable       | TUÉ     |
| 28  | la borne haute du nombre de symboles                                    | TUÉ     |
| 29  | le refus d'un signe hors de la table close                              | TUÉ     |
| 30  | seule la phrase annonce une attente                                     | TUÉ     |
| 31  | un moteur inconnu retombe sur le plus lent                              | TUÉ     |
| 32  | l'annonce retient le p95, jamais le p50                                 | TUÉ     |
| 33  | une feuille porte une version, ou n'existe pas                          | TUÉ     |
| 34  | un champ de version vide rend l'AVEU                                    | TUÉ     |
| 35  | une version non entière est refusée, jamais corrigée                    | TUÉ     |
| 36  | un type d'emplacement inconnu est dit, jamais confondu                  | TUÉ     |
| 37  | `moyenParNom` — l'égalité stricte, et son `null`                        | TUÉ     |

## Impacts

| Document                                                        | Ce qui change                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ADR 0028](0028-coquille-de-produit-et-frontiere.md) décision 4 | RETIRÉE par cette tranche, avec sa note datée. La réserve de `SEC-ORIGIN-001` côté produit ne porte plus le jeton ; il reste le cycle de vie non assemblé (#163)                                                                                                                  |
| [ADR 0025](0025-moyen-de-recuperation.md) § Risques             | « la découpe affichée, l'aide à la saisie, un contrôle en direct par la somme » sont LIVRÉS. Le tirage n'a pas bougé, l'alphabet non plus, la version non plus                                                                                                                    |
| [ADR 0027](0027-archive-et-ancre-de-version.md) décision 3      | la SAISIE de l'ancre est livrée, avec son aveu. Le consentement nommé et `recovery: null` existent en texte, éprouvés, et attendent le geste qu'ils précéderont (#163)                                                                                                            |
| [ADR 0021](0021-derivation-des-cles-de-deverrouillage.md)       | inchangé. Les décisions 5 et 7 sont CITÉES, pas rouvertes ; le § Mesures est désormais RELU par une épreuve                                                                                                                                                                       |
| [ADR 0020](0020-enveloppe-de-cle.md)                            | inchangé. L'inventaire public est LU par un chemin de produit, ce que le point 3 de ses limites prévoyait                                                                                                                                                                         |
| [ADR 0002](0002-topologie-origine-de-confiance.md)              | inchangé. Le port restreint ne gagne aucun type, et la réponse d'état porte toujours ses deux champs                                                                                                                                                                              |
| `SECURITY.md`                                                   | `SEC-RECOVERY-001` passe **exercé** sans réserve. `SEC-ORIGIN-001` — coquille de PRODUIT garde sa réserve, réduite au seul cycle de vie                                                                                                                                           |
| `SECURITY.md`, gate « données sensibles »                       | la récupération est désormais OFFERTE par un chemin de production ; le gate reste FERMÉ, et le verrouillage après inactivité (#25) est ce qui manque. La phrase qui disait la séparation d'origine « pas encore implémentée dans le produit » est corrigée : #161 l'a implémentée |
| `docs/quality-attributes.md`                                    | l'attente annoncée entre dans le tableau des mesures, avec les deux délais publiés depuis le geste                                                                                                                                                                                |

Aucun format, aucun vecteur, aucune empreinte ne bouge : `node tools/verifier-vecteurs.mjs` reste
vert sans qu'un seul fichier de `tests/vectors/` ait été touché.
