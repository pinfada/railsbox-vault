# ADR 0033 — La DEK est une clé maîtresse : chaque domaine scelle sous sa propre clé dérivée

- **Statut** : accepté
- **Date** : 2026-09-10
- **Issue** : [#182](https://github.com/pinfada/railsbox-vault/issues/182) (HIGH),
  [#181](https://github.com/pinfada/railsbox-vault/issues/181) (CRITICAL),
  [#20](https://github.com/pinfada/railsbox-vault/issues/20) moitié 2 · Invariants : `SEC-KEY-001`,
  `SEC-BLOCK-001`, `SEC-GEN-001`, `SEC-RECOVERY-001`
- **Révise** : [ADR 0015](0015-proprietes-cryptographiques-du-format.md) (le budget de clé, la clé
  de volume « reçue »), [ADR 0016](0016-format-de-volume-v3-dispositions.md) (les dispositions v3),
  [ADR 0020](0020-enveloppe-de-cle.md) (décision 3, la racine de page scellée sous la DEK),
  [ADR 0021](0021-derivation-des-cles-de-deverrouillage.md) (« rien d'autre ne descend d'elle » —
  quelque chose en descend désormais), [ADR 0024](0024-instantane-de-reprise.md) (l'unique
  scellement d'une capture), [ADR 0027](0027-archive-et-ancre-de-version.md) (la racine rescellée à
  l'export), [ADR 0008](0008-format-d-archive-d-export.md) et
  [ADR 0009](0009-restauration-inter-origine.md) (l'archive et sa restauration),
  [ADR 0011](0011-migration-de-format-et-reprise.md) (le refus de version, la migration reprenable),
  [ADR 0019](0019-fraicheur-du-volume.md) (le témoin, l'empreinte de région).
- **Ne traite pas** : AES-GCM-SIV (question ouverte n° 1, périmètre du spike écrit plus bas) ;
  l'ancrage monotone (question n° 3, [#23](https://github.com/pinfada/railsbox-vault/issues/23)) ;
  la rotation de la clé maîtresse.
- **Ne livre aucun code.** Cet ADR est une tranche de DÉCISION. Le format v3 reste le format du
  produit jusqu'à ce que #181 puis #182 le changent.

## Contexte

La revue externe du format v3 a été reçue le 10 septembre 2026
([texte intégral](../revue-externe/revue-2026-09-10.md)). Elle rend deux constats, et le second
défait une phrase que la spécification écrivait depuis l'ADR 0015 :

> La limite 2^31 n'est donc pas une limite par clé, mais une collection de limites locales, dont
> certaines ne sont pas persistées et d'autres n'existent pas.

Le fait, tel que le relecteur l'a exécuté, tient en une ligne de JSON :

```json
{ "memeCle": true, "compteurVolumeA": 1, "compteurVolumeB": 1, "sommeReelle": 2 }
```

Le § 4.5 de la spécification affirme compter « toutes les invocations sous une clé », et c'est bien
l'exigence du § 8.3 de NIST SP 800-38D — « all instances of the authenticated encryption function »
employant la MÊME clé. Le produit, lui, compte par **instance de `Scellement`** : les volumes
`coquille` et `application` partagent explicitement la même DEK, chaque instance repart de zéro, la
coquille et l'installation initiale s'ouvrent hors transaction — donc sans racine où déposer un
compteur —, et les deux rescellements de racine d'enveloppe (mutation d'enveloppe, export avec
récupération) se font directement sous la DEK, hors de tout compteur.

**Ce que ce constat n'est PAS.** Ce n'est pas une réutilisation de nonce observée : les nonces sont
tirés (ADR 0015, § 4.2), et un compteur faux ne fait réémettre aucun nonce. Ce qui tombe est la
**borne** : la probabilité de collision de 2^-35 que la spécification publie était calculée pour
2^31 invocations sous une clé, et rien dans le mécanisme implémenté ne borne le nombre réel
d'invocations sous la DEK. Le dépôt annonçait une propriété qu'il ne tenait pas — c'est-à-dire, au
barème du gabarit, un HIGH.

**Deux réparations existaient, et le relecteur a nommé la bonne.** Un compteur global, durable et
atomique partagé par tous les consommateurs — l'enveloppe, l'instantané, l'archive, deux volumes,
deux sessions — supposerait une transaction commune à des fichiers qui n'en ont aucune, et un état
de plus qui recule avec le support. Ou bien : **cesser de partager la clé**. C'est ce que cet ADR
décide.

Le premier constat, #181, tient au même endroit : le relecteur demande que l'engagement de l'archive
soit scellé « sous une clé dérivée de la DEK, réservée au domaine archive ». Les deux constats
partagent donc une seule décision, et c'est celle-ci. C'est pourquoi elle est prise AVANT les deux
corrections plutôt qu'inventée deux fois.

## Décision 1 — Un régime de clés, et un seul : la DEK ne chiffre plus rien

**La DEK devient une clé MAÎTRESSE.** Elle n'est plus jamais passée à AES-GCM. Chaque scellement du
produit se fait sous une clé AEAD de 256 bits **dérivée** de la DEK par HKDF-SHA-256, propre à un
**domaine**, à un **volume** et à une **version de format**.

```text
cleDeDomaine = HKDF-SHA-256(IKM = DEK, sel, info) → CryptoKey AES-256-GCM non extractible
```

Le dépôt sait déjà faire exactement cela : l'ADR 0021, décision 2, dérive les KEK par HKDF-SHA-256
avec une info à champs préfixés, et `tests/unit/modele-derivation.mjs` en tient une seconde
transcription écrite à la main. Rien de neuf n'entre ici — ni primitive, ni dépendance, ni artefact
vendu. C'est le même geste, appliqué un étage plus bas.

**Ce n'est pas un raffinement de séparation logique.** Les données associées séparaient déjà les
domaines (§ 5.1, § 5.1 bis, § 5.2) ; le relecteur écrit pourquoi cela ne suffisait pas, et il faut
le reprendre mot pour mot : « les données associées séparent les domaines logiques, mais ne
protègent pas AES-GCM contre la réutilisation du même couple clé/nonce ». Une collision de nonce est
fatale sous la clé où elle survient — perte de confidentialité des deux clairs par
`C1 ⊕ C2 = P1 ⊕ P2`, et récupération de la clé d'authentification `H` (SP 800-38D § 8.1 ; Joux
2006). Séparer les clés ne rend pas la collision moins fatale : elle rend son **rayon** égal à un
domaine d'un volume, au lieu de tout ce qui vit sous la DEK.

## Décision 2 — Les six domaines, et pourquoi le journal a le sien

Un domaine = **un consommateur de scellement**. Six, pas cinq :

| Domaine        | Ce qu'il scelle                                                                 | Régime de clé    |
| -------------- | ------------------------------------------------------------------------------- | ---------------- |
| `volume`       | les secteurs de la charge, l'empreinte de région, le témoin, **et les racines** | compteur         |
| `journal`      | les enregistrements de `<volume>.gen`                                           | compteur         |
| `instantane`   | l'unique scellement d'une capture de reprise (ADR 0024, décision 3)             | **usage unique** |
| `enveloppe`    | la racine d'une page de `<volume>.cles` (ADR 0020, décision 3)                  | **usage unique** |
| `archive`      | l'engagement d'une archive (#181)                                               | **usage unique** |
| `recuperation` | la racine rescellée de la page embarquée à l'export (ADR 0027)                  | **usage unique** |

**Le volume `coquille` et le volume `application` sont deux volumes**, donc deux identifiants, donc
deux jeux de clés — par construction, sans qu'aucun appelant ait à y penser. C'est le premier point
du constat #182, et il se ferme ici sans compteur ni discipline : la DEK partagée cesse d'être une
clé AEAD partagée. Le partage lui-même n'est pas jugé ici ; il devient sans conséquence
cryptographique.

**Le journal a sa propre clé, et c'est une décision, pas une symétrie.** Trois raisons :

1. **le relecteur les sépare** — sa liste est « volume, journal, instantané, enveloppe et archive »
   — et la raison est bonne : le journal est le seul magasin dont les objets sont scellés au DÉPÔT,
   c'est-à-dire sous une génération EN VOL, celle-là même dont l'ADR 0015 a montré qu'elle peut
   reculer. C'est le magasin où le format a déjà eu tort une fois ;
2. **le budget devient lisible.** Un dépôt et un rescellement de point de contrôle n'ont pas le même
   profil de consommation : une barrière du guest écrit un enregistrement, une racine, une empreinte
   de région et un témoin — trois de ces quatre relèvent du domaine `volume` et un seul du domaine
   `journal`. Deux compteurs disent ce qu'un compteur unique moyennait ;
3. **rien ne traverse la frontière sans être rescellé.** Le point de contrôle ouvre chaque
   enregistrement et rescelle secteur par secteur sous un nonce neuf (§ 7.2) : le passage du journal
   au volume était déjà un rescellement. Il devient un rescellement sous une AUTRE clé, et le coût
   est nul.

**Ce que le second compteur coûte, écrit ici :** huit octets de plus dans l'en-tête authentifié de
la racine, un second refus `VAULT_CRYPTO_BUDGET_DE_CLE` à câbler, et un vecteur de racine v4 qui ne
ressemble pas à celui de v3. C'est le prix, et il est payé par T2a.

**Pourquoi les racines sont du domaine `volume` et non du domaine `journal`**, alors qu'elles
authentifient la suite des entrées du journal. Une racine vit dans le fichier de VOLUME, à
l'emplacement `séquence mod 2` (§ 6.6), et c'est elle qui porte les compteurs des deux domaines : la
faire dépendre de la clé du journal ferait dépendre le compteur du volume d'une clé que le journal
peut vider. La racine est l'autorité du volume ; elle est scellée sous la clé du volume.

## Décision 3 — Le sel porte l'unicité, l'info porte la séparation

**`info`, octet par octet.** Chaque champ est de largeur fixe ou **préfixé de sa longueur sur deux
octets gros-boutistes**, comme les données associées du § 5.1 et l'info des KEK de l'ADR 0021 :

```text
info = LP("railsbox-vault/derivation-de-domaine/v1")   étiquette du SCHÉMA de dérivation
     ‖ LP(domaine)                                      « volume », « journal », …
     ‖ LP(identifiantVolume)                            32 hexadécimaux MINUSCULES
     ‖ U32BE(versionDeFormatDuDomaine)                  la version du format que ce domaine scelle
     ‖ LP("aes-256-gcm")                                l'algorithme, comme dans les données associées

LP(s)    = longueur UTF-8 de s sur 2 octets gros-boutistes, puis les octets UTF-8 de s
U32BE(n) = n sur 4 octets gros-boutistes
```

**Le brief du superviseur proposait une info jointe par des barres obliques**
(`"railsbox-vault/v4/" ‖ domaine ‖ "/" ‖ identifiantVolume ‖ "/" ‖ version`) ; elle est écartée, et
la raison est celle que l'ADR 0015 a déjà écrite sur les données associées : **une concaténation non
préfixée n'est pas injective**. Elle ne l'est ici que tant que les domaines ne contiennent pas de
barre oblique — c'est-à-dire par une propriété du contenu et non de l'encodage. Le dépôt refuse ce
genre de sûreté depuis #18 : le préfixe de longueur est ce qui rend l'encodage injectif, et il est
éprouvé par mutation plutôt qu'affirmé. Ce qui vaut pour l'identité d'un bloc vaut a fortiori pour
l'identité d'une CLÉ.

**Les cinq champs, et ce que chacun ferme :**

| Champ                        | Ce qu'il empêche                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| étiquette du schéma          | qu'une future hiérarchie v2 tire les mêmes clés que celle-ci sous la même DEK                           |
| domaine                      | qu'un secteur et une racine d'enveloppe partagent une clé — le cœur de #182                             |
| identifiant de volume        | que la coquille et l'application partagent une clé, et qu'un artefact migre d'un volume à l'autre       |
| version de format du domaine | qu'un artefact v3 et un artefact v4 se lisent sous la même clé, ce qui rendrait la migration réversible |
| algorithme                   | qu'un second AEAD, s'il arrive un jour, réinterprète un chiffré produit par le premier (ADR 0015)       |

**La version est celle du format DU DOMAINE, pas celle du volume.** Un même volume a plusieurs
formats sous lui : le volume v4, la page d'enveloppe v2, l'instantané, l'archive v3. Lier chaque clé
à la version du volume ferait bouger la clé d'enveloppe à chaque version de volume — et rendrait
donc `<volume>.cles` illisible par une migration qui n'a pas encore la clé.

| Domaine        | `versionDeFormatDuDomaine` après T1 et T2 | Ce que le champ désigne                  |
| -------------- | ----------------------------------------: | ---------------------------------------- |
| `volume`       |                                         4 | version du format de volume              |
| `journal`      |                                         4 | version du format de volume              |
| `instantane`   |                                         2 | version du fichier d'instantané          |
| `enveloppe`    |                                         2 | version de la page d'enveloppe           |
| `archive`      |                                         3 | version du format d'archive              |
| `recuperation` |                                         2 | version de la page d'enveloppe embarquée |

**`sel`, et le critère qui le décide.** Le sel ne sert pas ici à séparer — l'info le fait. Il sert à
rendre une clé **fraîche**. D'où deux régimes, et un seul critère : _la clé est-elle réemployée ?_

- **domaine à compteur** (`volume`, `journal`) — la clé DOIT être la même entre deux gestes, sans
  quoi un secteur écrit hier ne se relirait pas aujourd'hui. **Sel = chaîne VIDE**, zéro octet. Le §
  2.2 de la RFC 5869 dit ce que cela vaut : un sel absent est traité comme `HashLen` octets nuls, et
  l'extraction reste correcte parce que l'IKM — la DEK — est déjà uniformément aléatoire sur 256
  bits. Un sel constant n'aurait rien ajouté et aurait ajouté un champ à authentifier. Le cas 3 de
  la RFC 5869 est précisément le vecteur d'un sel vide : la dérivation reste **vectorisable sans une
  ligne du produit**, ce que `tools/verifier-vecteurs.mjs` exige ;
- **domaine à usage unique** (`instantane`, `enveloppe`, `archive`, `recuperation`) — l'artefact est
  RÉÉCRIT ENTIER à chaque geste, et il ne porte qu'**un** scellement sous la DEK. **Sel = 32 octets
  TIRÉS de `crypto.getRandomValues`, écrits EN CLAIR dans l'artefact.** Une clé neuve par artefact,
  un scellement sous cette clé, et c'est tout.

**Que ces quatre artefacts ne portent QU'UN scellement sous la DEK est un fait vérifié, pas une
hypothèse** : les emplacements d'une page d'enveloppe enveloppent la DEK sous les **KEK** (ADR 0020)
et non l'inverse — seule la racine de la page est scellée sous la DEK ; l'ADR 0024, décision 3,
impose « un seul scellement par capture » ; l'export rescelle **une** racine ; l'engagement de #181
est **un** scellement. Si une tranche à venir devait en ajouter un second sous la même clé, elle
devrait d'abord changer cette décision : c'est la condition qui rend le régime valable, et elle est
écrite pour être relue.

**Le sel en clair n'est pas authentifié, et il n'a pas à l'être.** Un adversaire qui le change
obtient une clé différente, donc une ouverture qui échoue : le sel se protège par sa conséquence,
comme le nonce. Le dire vaut mieux que d'ajouter un champ aux données associées pour rassurer.

## Décision 4 — Le budget, domaine par domaine, exhaustif

C'est la question n° 4 de la § 13, et le relecteur a répondu « ni son emplacement ni sa portée
actuelle ne conviennent ». Voici les deux, pour chaque domaine.

| Domaine        | Compteur ? | Où il est persisté et AUTHENTIFIÉ                                                 | Au plafond                                              |
| -------------- | ---------- | --------------------------------------------------------------------------------- | ------------------------------------------------------- |
| `volume`       | oui        | `scellementsCumulesVolume`, en-tête authentifié de la racine v4 (comme v3, § 6.7) | `VAULT_CRYPTO_BUDGET_DE_CLE` avant de produire un octet |
| `journal`      | oui        | `scellementsCumulesJournal`, **le même** en-tête de racine v4                     | idem, distingué par son contexte `domaine`              |
| `instantane`   | **non**    | aucun — une clé, une capture                                                      | inatteignable : 1 devant 2^31                           |
| `enveloppe`    | **non**    | aucun — une clé, une page                                                         | inatteignable                                           |
| `archive`      | **non**    | aucun — une clé, une archive                                                      | inatteignable                                           |
| `recuperation` | **non**    | aucun — une clé, une page embarquée                                               | inatteignable                                           |

**Pourquoi quatre domaines sur six n'ont PAS de compteur, et pourquoi c'est plus sûr que d'en avoir
un.** Le brief laissait le choix ouvert entre compter et tirer un sel. Compter suppose un état
durable, atomique et partagé ; ces quatre domaines n'en ont aucun — c'est exactement le reproche du
relecteur, « certaines ne sont pas persistées et d'autres n'existent pas ». Un sel tiré ne suppose
rien : il ne recule pas avec le support, il ne se perd pas à la fermeture d'un onglet, il ne dépend
d'aucune transaction. **Le budget d'une clé à usage unique est de 1, et aucune mesure ne peut le
rendre faux.** C'est la leçon de l'ADR 0015 sur le nonce, appliquée à la clé : dans un système
exposé au retour arrière, tout ce qui se compte finit par reculer, et l'aléa est la seule
construction dont l'unicité ne dépend d'aucun état.

**Les deux compteurs restants sont enfin ceux que la spécification annonce.**
`scellementsCumulesVolume` compte les secteurs, les empreintes de région, les témoins et les racines
d'UN volume, et **plus rien d'autre ne scelle sous cette clé** : ni l'autre volume, ni l'enveloppe,
ni l'export, ni l'instantané. La phrase du § 4.5 — « toutes les invocations sous une clé » — devient
vraie.

**Ce que le comptage ne gagne PAS, et le dire est la moitié du travail.** Les deux compteurs vivent
toujours dans la racine, donc ils **reculent** encore avec un retour arrière du support ou avec une
racine plus ancienne faisant autorité (§ 9.1, constat #144). L'écart entre le compteur et le nombre
réel d'invocations reste non borné, et la moitié du plafond NIST — 2^31 devant 2^32 — reste la marge
choisie devant cet écart. **La séparation des clés ne corrige pas la question n° 4 : elle en retire
la moitié qui n'était pas une question de recul, la PORTÉE.** L'emplacement reste discutable ; il
n'a pas de meilleur candidat dans un navigateur.

### Les ouvertures hors transaction, nommées et fermées

Le § 4.5 admet aujourd'hui que « le compteur est sous-estimé hors transaction » : un volume ouvert
sans journal n'écrit aucune racine, donc ne dépose aucun compteur. Deux chemins de production sont
dans ce cas, et le relecteur les nomme : l'ouverture du volume de coquille, et l'installation
initiale du volume applicatif. La création d'un volume est le pire des trois : elle scelle **tous**
les secteurs — 2^20 pour 512 Mio, soit un deux-millième du budget en un geste — et son dernier geste
est la marque `VLTSEAL1`, pas une racine (§ 7.1).

**Règle v4 :** _toute session qui scelle sous une clé à compteur clôt par une RACINE qui publie les
deux compteurs ; une ouverture qui ne peut pas écrire de racine n'a pas le droit de sceller — elle
est en LECTURE seule, et un scellement demandé sous ce régime est refusé._ La création écrit donc
une racine initiale avant `VLTSEAL1`, et l'ouverture hors transaction de la coquille en écrit une à
la fermeture. C'est du travail de T2a, mesuré là-bas ; l'alternative — laisser l'aveu du § 4.5 en
place — n'est pas retenue, parce que le constat #182 est précisément qu'un budget avoué faux reste
un budget faux.

## Décision 5 — La version de format v4 : ce qui change, ce qui ne change pas

**Ce qui change :**

1. **la version**, partout où elle est écrite : le champ de version de l'en-tête de volume (§ 6.2),
   celui de l'en-tête de racine (§ 6.7), le champ 3 des données associées (§ 5.1, 5.1 bis, 5.2) et
   le manifeste (§ 6.10) portent **4** ;
2. **l'en-tête de racine** gagne son second compteur : `scellementsCumulesJournal`, huit octets
   gros-boutistes, à la suite de `scellementsCumules` qui devient `scellementsCumulesVolume`. Les
   données associées d'une racine passent donc de dix à onze champs, et de 136 à **144 octets** pour
   un identifiant de trente-deux caractères ;
3. **les artefacts des quatre domaines à usage unique** gagnent leur sel de 32 octets en clair : la
   page d'enveloppe passe en v2, le fichier d'instantané en v2, l'archive en v3 (#181), la section
   de récupération suit la page d'enveloppe ;
4. **la clé importée dans le Worker change de nature** — décision 6.

**Ce qui ne change PAS**, et le dire évite une migration inutile : la géométrie (secteurs de 512
octets, taille support, région d'authentification), la disposition du journal `<volume>.gen` et son
format 4, le témoin `<volume>.temoin` et son sceau, la marque de scellement complet `VLTSEAL1`, le
tirage du nonce sur douze octets, l'algorithme `aes-256-gcm`, l'ordre des vérifications à la
réouverture (§ 7.3), et **la forme des données associées** — huit champs pour un bloc, dix pour une
racine plus le nouveau compteur ; seul le champ de version bouge.

**Pourquoi les données associées ne gagnent PAS de champ « domaine ».** Le domaine sépare désormais
les CLÉS ; le répéter dans les données associées suggérerait que ce sont elles qui font le travail —
c'est la confusion que #182 vient précisément de corriger. L'étiquette de domaine du champ 1 reste
ce qu'elle a toujours été : ce qui empêche un objet d'être relu comme un autre **sous la même clé**,
et il n'y en a plus qu'un par clé.

### La migration v3 → v4, reprenable

Le dépôt a un précédent, et il est le seul modèle admis : la migration v2 → v3
([#13](https://github.com/pinfada/railsbox-vault/issues/13),
[#18](https://github.com/pinfada/railsbox-vault/issues/18), ADR 0011), avec son journal de migration
`<volume>.migration` et sa reprise après coupure. La v3 → v4 est de la même nature et plus lourde :
**chaque secteur est rescellé** sous la clé du domaine `volume` de la v4, parce qu'aucune clé ne
traverse une version de format (décision 3, champ 4 de l'info).

Quatre points fixés ici, pour que T2a n'ait pas à les rejuger :

1. **reprenable après coupure**, par le journal de migration existant : l'avancement est un rang de
   secteur, la reprise relit le journal et repart de là. La migration est le seul geste du produit
   qui tient les DEUX clés — celle de v3 et celle de v4 — en mémoire en même temps ;
2. **un volume v3 n'est JAMAIS lu par le produit v4 en lecture directe.** Il est lu par la
   migration, et par elle seule. Un chemin de lecture v3 laissé ouvert dans le produit v4 serait
   exactement le mécanisme de rétrogradation que l'ADR 0011 refuse : il rendrait le format v3 — dont
   on sait désormais que son budget est faux — accessible sans décision ;
3. **les vecteurs v3 restent dans `tests/vectors/`**, et changent de rôle : ils deviennent des
   vecteurs de **MIGRATION**. Rien n'y bouge, et `tools/verifier-vecteurs.mjs` continue de les
   rejouer sans une ligne du produit. Les vecteurs **v4** sont à produire par T2a, sur le même
   contrat ;
4. **la migration se joue en Reprise MVP**, de bout en bout, coupure comprise : c'est là que
   `docs/testing.md` place déjà la v2 → v3.

## Décision 6 — La DEK est importée en clé HKDF, et WebCrypto refuse alors de chiffrer avec

La règle « ne jamais employer la DEK directement » serait une discipline si rien ne la tenait. Elle
est tenue **par la plate-forme** :

```js
// Aujourd'hui : la DEK est importée en clé AES-GCM, et « encrypt » lui est ouvert.
importKey("raw", dek, "AES-GCM", false, ["encrypt", "decrypt"]);

// En v4 : la DEK est importée en matériau HKDF, et « encrypt » n'existe pas pour elle.
importKey("raw", dek, "HKDF", false, ["deriveKey"]);
```

Une `CryptoKey` dont les usages ne portent pas `encrypt` fait **rejeter** `crypto.subtle.encrypt`
par la spécification WebCrypto elle-même. Le vocabulaire de la décision 7 de l'ADR 0021 s'applique :
c'est un **GARANTI**, pas un « fait, non garanti ». Un appelant distrait ne peut pas sceller sous la
DEK ; il obtient une exception, pas un chiffré.

**Le cliquet reste utile en plus, et T2b le pose** : une épreuve d'inspection de source qui refuse
que la DEK soit passée en argument de clé à un scellement, sur le modèle de
`tests/unit/harnais-portes.test.mjs`. Sa liste d'exceptions comporte **un seul nom** — le module de
migration v3 → v4, qui a besoin des deux clés, avec sa raison écrite à côté. Une garde à exception
non nommée est une garde qu'on désarme par inadvertance.

## Décision 7 — AES-GCM-SIV n'est pas décidé ici, et voici ce que le spike doit rendre

Le relecteur rouvre sa réponse à la question n° 1 : « AES-GCM-SIV mérite désormais une
expérimentation sérieuse. Le RFC le recommande précisément lorsque plusieurs chiffreurs partagent
une clé ou que l'état garantissant l'unicité ne peut être assuré (RFC 8452). Cela ne dispense
toutefois pas de séparer les clés par domaine. »

La question reste **OUVERTE**. Cet ADR ne la tranche pas, et il refuse de la trancher par défaut
dans un sens ou dans l'autre. Ce qu'il fixe est le périmètre du spike **T3**, dont l'issue reste à
ouvrir :

1. **la disponibilité.** AES-GCM-SIV n'est exposé par WebCrypto sur aucun des trois moteurs — le
   constater, moteur par moteur, plutôt que le supposer. À défaut : une implémentation WebAssembly
   ou JavaScript, avec la règle de dépendances du dépôt appliquée telle quelle (artefact VENDU,
   empreinte vérifiée avant instanciation, aucune ligne de colle importée — ADR 0021, décision 3) ;
2. **le coût par secteur.** Le point de comparaison est mesuré : ≈ 17,3 µs par appel AES-GCM sur 512
   octets sous Chromium, dont ≈ 0,5 µs de calcul. SIV impose par construction deux passages sur le
   clair ; ce qui compte est ce que cela fait au **budget de reprise**, pas le ratio brut ;
3. **ce que SIV apporte UNE FOIS les clés séparées.** C'est la vraie question, et elle est plus
   étroite qu'avant cet ADR : une collision de nonce ne coûte plus que la confidentialité de deux
   clairs **d'un domaine d'un volume**, et non la clé `H` de tout ce qui vit sous la DEK. Le spike
   doit dire si le résidu justifie une dépendance auditée ;
4. **ce qu'il ne rend pas** : aucun code de produit, aucune version de format. Un spike rend une
   mesure et un verdict écrit.

## Modèle de menace : ce que la séparation garantit, et ce qu'elle ne garantit pas

Au vocabulaire de la décision 7 de l'ADR 0021.

**GARANTI :**

- **deux domaines, deux volumes ou deux versions de format ne partagent JAMAIS une clé AEAD.** C'est
  la séparation de domaine d'HKDF sur une info injective (décision 3), et elle se mesure comme celle
  des KEK : des identités qui ne diffèrent que d'un champ tirent des clés distinctes ;
- **une collision de nonce dans un domaine ne touche pas les autres.** Le rayon d'une collision est
  un (domaine × volume), au lieu de la DEK entière ;
- **la DEK ne peut pas chiffrer** (décision 6) : la plate-forme le refuse, pas une revue ;
- **le budget d'une clé à compteur est celui de CETTE clé**, et plus une somme de compteurs locaux.

**FAIT, mais non garanti :**

- **les deux compteurs restants sont exacts tant que le support n'a pas reculé.** Ils vivent dans la
  racine et reculent avec elle (§ 9.1, #144). L'écart n'est pas borné ; la marge de 2^31 devant 2^32
  est ce qui lui est opposé, et c'est un choix, pas un calcul.

**IMPOSSIBLE :**

- **détecter le retour arrière COMPLET du support** (§ 9.1). Rien de cet ADR ne le change : deux
  captures cohérentes du même volume restent interchangeables sans ancre monotone (question n° 3) ;
- **effacer la DEK maîtresse de la mémoire du processus** (ADR 0021, décision 7). Elle devient un
  matériau HKDF non extractible, ce qui réduit la surface — mais un `importKey` a pu la copier, et
  aucun code JavaScript ne verrouille une page en mémoire.

**Ce que cet ADR ne prétend PAS résoudre :** #181. La séparation des clés lui donne son domaine
`archive` ; elle ne fabrique pas l'engagement. C'est le travail de T1.

## Impacts sur les ADR antérieurs

Chacun de ces ADR reçoit **une note d'une ligne, datée du 10 septembre 2026**, qui annonce la
révision et renvoie ici. Aucun n'est récrit : un ADR ne change qu'avec le code qui le tient, et le
code viendra avec T1 et T2. Ce que la tranche qui livre devra y amender :

| ADR                                                   | Amendement attendu, et par qui                                                                                               |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| [0008](0008-format-d-archive-d-export.md)             | l'archive porte un engagement authentifié ; la version d'archive passe à 3 ; le SHA-256 n'est plus la seule intégrité (T1)   |
| [0009](0009-restauration-inter-origine.md)            | la restauration DÉPOSE l'engagement à côté du volume ; une archive sans engagement est refusée (T1)                          |
| [0011](0011-migration-de-format-et-reprise.md)        | le refus de version d'archive ; la migration v3 → v4 reprenable et son journal (T1, T2a)                                     |
| [0015](0015-proprietes-cryptographiques-du-format.md) | § budget : deux compteurs, quatre domaines sans compteur ; § « la clé de volume : reçue » : elle est désormais DÉRIVÉE (T2a) |
| [0016](0016-format-de-volume-v3-dispositions.md)      | les dispositions v4 : en-tête, racine à onze champs, version 4 dans les données associées (T2a)                              |
| [0019](0019-fraicheur-du-volume.md)                   | le témoin et l'empreinte de région passent sous la clé du domaine `volume` (T2a)                                             |
| [0020](0020-enveloppe-de-cle.md)                      | décision 3 : la racine d'une page est scellée sous la clé du domaine `enveloppe`, à usage unique ; page v2 (T2b)             |
| [0021](0021-derivation-des-cles-de-deverrouillage.md) | « rien d'autre ne descend d'elle » : la DEK développée n'est plus une clé de scellement, c'est un matériau HKDF (T2a)        |
| [0024](0024-instantane-de-reprise.md)                 | l'unique scellement d'une capture se fait sous une clé à usage unique ; fichier d'instantané v2 avec sel (T2a)               |
| [0027](0027-archive-et-ancre-de-version.md)           | la racine rescellée à l'export passe sous la clé du domaine `recuperation`, à usage unique (T2b)                             |

## Le plan, et ce que chaque tranche livre

Accepté par le mainteneur le 10 septembre 2026, dans cet ordre :

| Tranche | Objet                                                                                  | Estimation | Revues |
| ------- | -------------------------------------------------------------------------------------- | ---------: | -----: |
| **T0**  | cet ADR, les deux DoR, le dossier au présent                                           |    ≈ 300 k |      1 |
| **T1**  | #181 — l'archive authentifiée ; introduit la dérivation pour le SEUL domaine `archive` |      ≈ 1 M |      2 |
| **T2a** | #182 — hiérarchie, domaines `volume`, `journal` et `instantane`, en-tête v4, migration |      ≈ 1 M |      2 |
| **T2b** | #182 — domaines `enveloppe` et `recuperation`, budgets exhaustifs, cliquet anti-DEK    |    ≈ 800 k |      2 |
| **T3**  | spike AES-GCM-SIV — une mesure et un verdict, aucun code de produit                    |    ≈ 400 k |      1 |

**T1 ne change pas le format de volume.** Il introduit la dérivation par domaine pour l'archive
seule ; le volume reste v3, et sa clé reste la DEK jusqu'à T2a. C'est une entorse assumée à la
décision 1 pendant deux tranches, et elle est écrite ici plutôt que découverte à la revue de T1 :
corriger un CRITICAL avant un HIGH est le bon ordre, et faire dépendre le CRITICAL d'une version de
format complète l'aurait retardé d'une tranche entière.

**T1 ANTICIPE pour v3 la règle de la racine initiale de la décision 5**, et c'est la revue de cette
tranche T0 qui l'a établi : sans elle, l'engagement de #181 ne peut pas être exigé. « Sans racine »
est aujourd'hui aussi l'état LÉGITIME d'une création (§ 7.1 : la création finit par `VLTSEAL1`, pas
par une racine), si bien qu'un adversaire qui retire le voisin d'engagement après une restauration
rend un volume indiscernable d'un volume neuf — et le mélange repasse. T1 pose donc dès la v3 ce que
la décision 5 réservait à la v4 : **aucun volume légitime n'est sans racine.** La création et la
migration v2 → v3 écrivent une racine initiale ; une ouverture sans racine et sans engagement est un
REFUS. Cela ferme du même geste, pour la v3 déjà, les 2^20 scellements qu'une création ne publiait
pas (décision 4). L'estimation de T1 passe de 800 k à ≈ 1 M pour ce travail.

Les Definition of Ready sont dans les issues :
[DoR de #181](https://github.com/pinfada/railsbox-vault/issues/181) ·
[DoR de #182](https://github.com/pinfada/railsbox-vault/issues/182).

> **Note du 11 septembre 2026 — T1 et T2a sont LIVRÉES, et voici ce qu'elles ont changé à cet ADR.**
> T1 a livré le domaine `archive` et la racine initiale
> ([ADR 0034](0034-archive-authentifiee-et-racine-initiale.md)) ; T2a a livré la hiérarchie, les
> trois domaines du volume, l'en-tête v4 et la migration
> ([ADR 0035](0035-format-de-volume-v4-et-migration.md)). Trois points de cet ADR ont dû être
> tranchés autrement que ce qu'il annonçait, et les trois sont écrits là-bas :
>
> 1. **la décision 5 range « le format 4 du journal » parmi ce qui ne change pas ; il passe à 5.**
>    La DISPOSITION du journal, elle, ne bouge pas d'un octet — ce que l'ADR voulait dire est tenu.
>    Mais la RACINE gagne huit octets, et le dépôt tient une règle plus ancienne que cet ADR : un
>    numéro de format dit ce que porte la racine. Laisser les deux sous le numéro 4 aurait fait deux
>    racines différentes sous un seul nom (ADR 0035, décision 1) ;
> 2. **la décision 5 ne dit pas comment une coupure de la migration se rattrape, et le modèle de v2
>    → v3 n'y suffit pas.** Les deux états d'un secteur y sont des chiffrés sous deux clés, si bien
>    que le sceau et la charge doivent changer ENSEMBLE : aucun ordre d'écriture ne suffit seul. Une
>    ÉCRITURE ANTICIPÉE des sceaux v3 de la suite en vol est journalisée, pour 6,6 % de ce que la
>    conversion réécrit (ADR 0035, décision 3) ;
> 3. **la décision 4 ne dit pas ce qui arrive quand une racine est ÉCARTÉE.** Dater une création
>    écarte la racine de naissance, et repartait donc de zéro : le geste qui fermait la
>    sous-estimation la rouvrait. Les compteurs sont désormais reportés (ADR 0035).
>
> Ce qui reste de cet ADR à livrer est la tranche **T2b** : les domaines `enveloppe` et
> `recuperation`, et le cliquet anti-DEK. Jusqu'à elle, la phrase « la DEK n'est plus jamais passée
> à AES-GCM » est VRAIE des domaines du volume et FAUSSE de la page d'enveloppe et de la section de
> récupération. Elle est écrite ainsi partout.

## Alternatives rejetées

**Un compteur global, durable et atomique.** C'est l'alternative que le relecteur nomme en second, «
sensiblement plus difficile ». Elle suppose une transaction commune à `<volume>`, `<volume>.gen`,
`<volume>.cles`, `<volume>.instantane` et à un fichier d'archive qui n'est même pas sur le support ;
elle ajoute un état durable de plus, donc un état de plus qui recule ; et elle ne dit rien du cas où
deux origines ouvrent deux volumes sous la même DEK. Rejetée pour la raison de l'ADR 0015 : un
compteur partagé entre des magasins sans transaction commune est une supposition, pas un mécanisme.

**Diviser le budget par le nombre de consommateurs** (forme 3 de
[#172](https://github.com/pinfada/railsbox-vault/issues/172)). Réfutée par le relecteur en une
phrase : « Diviser simplement le budget par deux volumes ne couvre ni les enveloppes, ni les
exports, ni les sessions hors transaction. » Elle divise un nombre sans rendre le compte exhaustif.
#172 est absorbée par #182.

**Une clé par volume, sans séparation par domaine** (forme 2 de #172). C'est la moitié de la
recommandation, et elle laisse l'enveloppe, l'instantané et l'export sous la clé du volume, donc
hors compteur — exactement les trois consommateurs que le relecteur relève.

**Un compteur pour les quatre domaines à usage unique.** Rejeté par la décision 4 : compter suppose
un état que ces quatre artefacts n'ont pas, et un sel tiré rend le comptage sans objet. Ajouter un
compteur là où l'aléa suffit, c'est ajouter la seule chose qui puisse devenir fausse.

**Attendre AES-GCM-SIV plutôt que séparer les clés.** Le relecteur écrit lui-même que SIV « ne
dispense toutefois pas de séparer les clés par domaine ». SIV borne le dommage d'une collision ; il
ne rend pas le budget exhaustif ni la mesure vraie.

**Récrire les ADR 0015, 0016, 0020, 0021, 0024 et 0027 maintenant.** Rejeté : le dépôt n'amende un
ADR qu'avec le code qui le tient. Six ADR récrits avant une ligne de code décriraient un produit qui
n'existe pas — c'est le défaut que la pré-revue interne a déjà relevé sous le nom « trois textes
disaient ce que le code ne faisait pas ».

## Risques et conditions d'abandon

- **La migration v3 → v4 est le geste le plus lourd que le dépôt ait tenté** : 2^20 secteurs
  rescellés pour un volume de 512 Mio, soit ≈ 87,6 s de scellement mesuré, doublés par l'ouverture
  sous la clé v3. Condition d'abandon de la reprenabilité : si le journal de migration ne suffit pas
  à reprendre après coupure sans relire le volume entier, la tranche s'arrête et la question revient
  au mainteneur ;
- **le sel en clair des quatre artefacts à usage unique élargit leur en-tête** de 32 octets. Pour la
  page d'enveloppe de 8 192 octets, cela peut coûter un emplacement dans le pire cas — à mesurer par
  T2b, et à écrire si c'est le cas ;
- **T1 introduit une dérivation sans version de format**, donc un état intermédiaire où le domaine
  `archive` est dérivé et les cinq autres non. Si cet état se révèle intenable à la revue de T1, le
  repli est de livrer T1 et T2a ensemble, plus cher et plus lent ;
- **rien de cet ADR ne ferme le gate « données sensibles »**, qui reste FERMÉ jusqu'à la résolution
  des deux constats et à la décision du mainteneur sur la nature du relecteur (`SECURITY.md`).

## Note datée du 11 septembre 2026 — le PLAN est exécuté : les six domaines sont livrés

Les deux tranches que cet ADR annonçait sont faites. **T2a** (PR #186, ADR 0035) a livré la
dérivation par domaine, le format de volume v4 et sa migration ; **T2b**
([ADR 0036](0036-page-d-enveloppe-v2-et-budgets-exhaustifs.md)) a livré les deux domaines qui
restaient — `enveloppe` et `recuperation` —, la clôture du troisième chemin hors transaction, et le
cliquet définitif.

**Ce que la décision 4 promettait est désormais MESURÉ** :
`tests/unit/vm-budget-par-domaine.test.mjs` compte les invocations de `encrypt` PAR CLÉ sur une
session complète, et les quatre domaines à usage unique n'en ont jamais deux sous la même clé. La
condition « écrite pour être relue » de la décision 3 est donc relue par une épreuve, et non par un
lecteur.

**Un risque que cet ADR inscrivait ne s'est PAS réalisé** : « le sel en clair élargit quatre
artefacts de 32 octets ; pour la page d'enveloppe de 8 192 octets, cela peut coûter un emplacement
dans le pire cas ». Le calcul est au § 6.11 de la spécification — il reste 3 380 octets libres au
pire tarif, soit cinq emplacements de plus.

**Un écart demeure, et il n'est pas de ceux que cet ADR avait prévus** : ouvrir un volume **v3** —
pour le migrer, ou pour l'exporter avant de le migrer — fait écrire au magasin une racine v3 et
rescelle la charge acquittée, c'est-à-dire **3 + N scellements** sous la clé de volume elle-même :
l'empreinte de région, la racine de clôture et le témoin, plus un par secteur rejoué. Le nombre est
MESURÉ depuis le 11 septembre 2026 (`tests/unit/vm-migration-source-v3.test.mjs`), et les 3 + N sont
tous comptés dans la racine v3. C'est le régime que la v4 remplace, et c'est l'unique exception du
cliquet anti-DEK. Voir la décision 4 de l'ADR 0036 et le § 7.4 de la spécification.

## Note datée du 12 septembre 2026 — la nature de la revue est décidée

Le mainteneur reconnaît la revue adverse du 10 septembre comme tierce pour #20 : le relecteur était
distinct des auteurs, n'avait pas participé au format, et a découvert un CRITICAL et un HIGH que le
dossier ne portait pas. Cette décision clôt #20 après correction des deux constats. Elle ne qualifie
pas la revue d'audit humain ou de cabinet et, conformément à la décision ci-dessus, n'ouvre pas le
gate « données sensibles » à elle seule.

## Note datée du 12 septembre 2026 — le spike T3 a rendu : AES-GCM-SIV, PAS MAINTENANT

Le spike que la décision 7 commandait est fait
([#185](https://github.com/pinfada/railsbox-vault/issues/185)). Son compte rendu, avec
l'environnement, les commandes, les mesures brutes et leur lecture, est
[`docs/spikes/0185-aes-gcm-siv.md`](../spikes/0185-aes-gcm-siv.md). La question n° 1 du § 13 reste
**ouverte** ; la réponse du dépôt, elle, est écrite, datée, et elle est **non — pas maintenant**.

> Cette note a été **récrite le 12 septembre 2026** après la revue crypto de la
> [PR #202](https://github.com/pinfada/railsbox-vault/pull/202), qui a rejoué le banc sur les trois
> moteurs et **réfuté par exécution** deux des arguments de la première rédaction : la voie sans
> dépendance n'est pas « fermée par le budget de reprise » — elle l'était par une multiplication de
> corps fini que le spike avait écrite pour être relue et non pour courir —, et elle n'exige pas les
> octets bruts de la clé. Le verdict n'a pas changé ; ses bases, si. Ce qui suit est ce que la
> mesure soutient, et rien d'autre.

**Le verdict tient sur TROIS bases, et sur trois seulement.**

1. **AES-GCM-SIV est absent de WebCrypto sur les trois moteurs.** Ce que cet ADR supposait est
   désormais constaté par `tests/compat/gcm-siv-probe.spec.mjs`, dans la page et dans un Worker,
   sous trois formes de demande, avec le refus publié tel quel — `NotSupportedError` partout.
   L'épreuve **affirme cette absence** : un moteur qui exposerait SIV la ferait rougir. C'est la
   première condition de réouverture, câblée plutôt que confiée à une veille.
2. **La voie sans dépendance coûte de 43 à 56 fois le scellement natif, par secteur, sous
   Chromium.** Elle existe et elle est conforme — AES-GCM-SIV composé sur AES-CTR, vérifié sur les
   vingt-six vecteurs AES-256 de la RFC 8452 —, mais elle demande **quarante appels à
   `crypto.subtle` par secteur de 512 octets** là où AES-GCM en demande un : les deux suites de
   compteurs de la RFC incrémentent leurs quatre premiers octets en petit-boutiste, quand AES-CTR de
   WebCrypto incrémente ses derniers bits en gros-boutiste. Le secteur passe de 4,8 µs à 252,3 µs,
   dont 212,8 µs pour les seuls appels — la multiplication de corps fini, corrigée, ne pèse plus que
   3,5 µs. **Ce facteur ne ferme aucun budget** : la part cryptographique d'une reprise au plafond
   de charge passe de 0,3 s à 16,5 s sur la machine du relevé, soit 33 s de reprise contre 60 s de
   budget ; projetée par rapports sur l'environnement de référence (§ 2.4 du compte rendu), elle
   atterrit au budget ou un peu au-dessus. Le spike ne tranche pas entre les deux projections et
   n'en a pas besoin : ce qu'il établit est un **facteur de 43 à 56 sur CHAQUE scellement** —
   création, rescellement de point de contrôle, migration, export —, pour un résidu déjà borné.
3. **Le résidu que SIV couvrirait est nul sur quatre domaines et borné sur les deux autres.**
   `instantane`, `enveloppe`, `archive` et `recuperation` tirent une clé neuve par artefact : leur
   budget est de 1, et SIV ne leur apporte **rien**. Pour `volume` et `journal`, le recul de racine
   **ne réémet aucun nonce** — ils sont tirés, pas dérivés (§ 4.2 et § 4.5 de la spécification) —
   mais il casse la COMPTABILITÉ, et la borne se dégrade en `k² · 2^-35` avec le facteur d'excès. Le
   seul apport réel de SIV est de rendre cette comptabilité cryptographiquement sans objet : la RFC
   8452 § 9 autorise, à nonces tirés, **2^64 messages par clé** contre 2^31 aujourd'hui. Cela ne
   justifie ni le facteur du point 2, ni une dépendance auditée dont aucune forme vendable n'existe.

**Ce que cette note ne dit PLUS, parce que c'était faux.** Elle n'écrit plus que « tout AEAD hors
WebCrypto exige les octets bruts de la clé ». **La voie composée conserve le garanti de
plate-forme** : la DEK reste un matériau HKDF `deriveKey` seul, `deriveKey` rend une `CryptoKey`
**AES-CTR non extractible**, `exportKey` la refuse, et le scellement SIV tourne dessus sans que les
octets de la clé de domaine existent jamais. C'est exécuté par
`node tools/spike-gcm-siv/epreuve-cle-non-extractible.mjs`, cinq constats sur cinq. Le cliquet
anti-DEK de l'ADR 0036 décision 5 devrait apprendre à nommer une matière `AES-CTR` — une révision de
son inventaire, pas l'abandon de la plate-forme qui le tient.

Ce qui exige les octets bruts est l'implémentation **logicielle complète** — POLYVAL _et_ AES en
JavaScript ou en WebAssembly, c'est-à-dire la candidate. Pour elle, et pour elle seule, `deriveKey`
deviendrait `deriveBits`, **deux** clés de domaine sur six deviendraient des tampons dans le tas, et
l'échange d'un GARANTI contre un FAIT non garanti serait réel. S'y ajoutent, pour elle encore, deux
choses que le compte rendu détaille : l'empreinte d'un module JavaScript **ne peut pas être vérifiée
avant exécution** sous la CSP du produit (`script-src 'self' 'wasm-unsafe-eval'`, ADR 0013, qui
n'ouvre ni `eval` ni `new Function`), et son AES emploie des **T-tables**, qui fuient leurs temps
d'accès là où le moteur exécute un AES à temps constant accéléré par le matériel.

**Ce que cette note ne dit pas non plus.** Elle ne dit pas que SIV est inutile : l'apport du point 3
est réel et, si le mainteneur juge un jour que l'excès non borné de la comptabilité est intolérable,
c'est le bon remède. Elle dit que le prix demandé aujourd'hui — un facteur quarante à soixante sur
chaque scellement, ou une dépendance dont aucune forme vendable n'existe — est plus élevé que ce
qu'il achète : une réduction de dommage sur deux domaines sur six, pour un événement à 2^-35 qui ne
s'est jamais produit.

**Les conditions qui rouvriraient la question, écrites pour être relues :**

- **WebCrypto expose AES-GCM-SIV sur les trois moteurs.** Il n'y a alors ni dépendance, ni surcoût
  d'appels, ni T-tables, et la réponse se retourne. `tests/compat/gcm-siv-probe.spec.mjs` rougira ce
  jour-là ;
- **une implémentation vendable apparaît** — empreinte vérifiable avant exécution, licence, audit
  couvrant la version vendue — **et elle est mesurée sous un facteur 2** du scellement natif, par le
  banc de ce spike, sur le moteur qui décide ;
- **le produit a besoin de dépasser 2^31 scellements sous une clé à compteur**, ou le mainteneur
  juge que l'excès non borné de la comptabilité porte `k² · 2^-35` au-dessus d'un seuil qu'il nomme.
  Le spike donne la forme de la courbe et l'ordre de l'effort correspondant ; il ne fixe pas le
  seuil, qui n'est pas à lui.
