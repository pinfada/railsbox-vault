# ADR 0025 — Un code de récupération est GÉNÉRÉ, rendu une fois, et rien du produit ne le retrouve

- Statut : accepté
- Date : 2026-09-06
- Issue : #147 (tranche 1 de #23) · Invariants : `SEC-RECOVERY-001`, `SEC-KEY-001` · Jalon 5

## Contexte

L'[ADR 0020](0020-enveloppe-de-cle.md) a livré la SERRURE,
l'[ADR 0021](0021-derivation-des-cles-de-deverrouillage.md) les CLÉS. Il en reste une conséquence
que ni l'une ni l'autre ne ferme, et `SECURITY.md` l'écrivait sans détour : **perdre ses moyens de
déverrouillage, aujourd'hui, c'est perdre le volume.** Une phrase s'oublie, un appareil qui porte la
passkey se perd, et l'ADR 0020 refuse — à juste titre — de révoquer le dernier emplacement. Le
coffre reste alors parfaitement fermé, y compris pour son propriétaire.

`SEC-RECOVERY-001` demande, depuis l'origine du dépôt, que « chaque moyen de récupération annoncé
possède un test de succès, de révocation et de perte définitive ». Il était **non exercé** parce
qu'aucun moyen de récupération n'existait : il n'y avait rien à éprouver.

Cette tranche en pose un, et un seul : **un code GÉNÉRÉ par le produit, rendu une seule fois,
persisté nulle part.** Elle ne fait rien d'autre — pas d'interface (#24), pas de geste composé «
révoquer tout sauf celui que je tiens » (#148), pas d'archive qui l'emporterait (#149, tranche 3 de
#23), pas de séquestre.

## Décision 1 — Un QUATRIÈME type de clé, `recuperation` = 4, dérivé par HKDF SEUL

`TYPES_KEK` reçoit `recuperation: 4`. Le type porte son encodage de paramètres publics — étiquette
`railsbox-vault/derivation/v1/recuperation`, version sur un octet, sel HKDF de trente-deux octets
tiré par emplacement —, son dérivateur (`src/vm/derivation/derivateur-recuperation.mjs`), et il
entre dans le catalogue que le Worker de confiance pose. Un catalogue qui ne sert pas un type le
refuse déjà par `VAULT_DERIVATION_TYPE_INCONNU` (ADR 0021, décision 6) : rien n'est deviné.

**Ce n'est pas un changement de format.** Le champ `typeKek` existe depuis #21, sur un octet, et
l'ADR 0020 a réservé avec lui le plafond de 512 octets des paramètres publics — les paramètres du
type 4 en occupent 78. Une valeur de plus dans une énumération est une ENTRÉE de ce format, pas une
version nouvelle ; un lecteur plus ancien la rencontre et la refuse par le refus que le point 5 du
contrat de #22 prévoyait exactement pour ce jour-là.

### Pourquoi un type DISTINCT, et non un emplacement `phrase`

Réutiliser `phrase` aurait coûté zéro ligne. Il est refusé pour deux raisons, et la première est
structurelle :

1. **trois tranches à venir doivent DISTINGUER cet emplacement.** La tranche 3 de #23 fera porter à
   l'archive l'emplacement de récupération SEUL — il faut donc savoir lequel c'est. #148 (« révoquer
   tout sauf celui que je tiens ») doit énumérer les moyens par nature. #24 doit annoncer « ce
   volume s'ouvre par une phrase, une passkey ou un code de récupération » et dire l'attente que
   chacun coûte. Un code rangé sous `phrase` serait indiscernable d'une phrase dans l'inventaire
   public, et les trois travaux devraient inventer une marque ailleurs ;
2. **il paierait un étirement qu'il n'a rien à compenser.** Un emplacement `phrase` est dérivé par
   Argon2id calibré, soit **2 136 ms sur Firefox** (mesures de l'ADR 0021). Ce prix existe pour
   rattraper la faiblesse d'une phrase humaine ; un code de récupération n'en a aucune.

### La contrainte de l'ADR 0021 est HONORÉE, pas contournée

L'ADR 0021 fait étirer la phrase, et sa décision 3 dit pourquoi : le plancher de la RFC 9106 est ce
qui rend une recherche hors ligne coûteuse **à l'échelle de la faiblesse d'une phrase**. Le
raisonnement se transpose plutôt qu'il ne s'annule :

| Secret                                  | Espace        | Avec l'étirement calibré | Sans étirement |
| --------------------------------------- | ------------- | ------------------------ | -------------- |
| Une phrase humaine, disons 25 bits      | 2²⁵ ≈ 3 · 10⁷ | ≈ 2⁴⁶                    | 2²⁵            |
| Un code de récupération, 128 bits TIRÉS | 2¹²⁸          | ≈ 2¹⁴⁹                   | **2¹²⁸**       |

**L'étirement n'est pas ce qui fait la force d'un secret : c'est ce qui rattrape son absence.**
Multiplier 2¹²⁸ par 2²¹ ne change rien à un nombre déjà hors de portée de tout adversaire physique ;
le payer coûterait en revanche deux secondes sur le moteur le plus lent, à chaque fois qu'un
utilisateur ouvre son coffre par le SEUL moyen qui lui reste. Le chiffre est écrit ici pour que la
décision se relise : 128 bits, mesurés comme le nombre d'octets demandés à `crypto.getRandomValues`,
et non comme une « force » qu'on affirmerait.

### Le canal auxiliaire de l'ADR 0020 s'élargit d'un cran, et c'est RÉ-ASSUMÉ par écrit

L'ADR 0020 a assumé que `<volume>.cles` révèle, en clair, le NOMBRE de clés d'un volume et leur
NATURE. Le type 4 ajoute une phrase à ce que le fichier raconte : **« un code de récupération existe
pour ce volume »**.

C'est un renseignement réel, et il ne se minimise pas : il dit à qui tient une copie du fichier
qu'un secret de vingt-huit symboles, imprimable, existe quelque part hors de l'appareil —
c'est-à-dire où chercher. Ce que l'adversaire n'apprend pas, en revanche, est la VALEUR : les
paramètres publics ne portent qu'une étiquette de domaine, une version et un sel tiré, et 2¹²⁸ reste
hors de portée.

L'alternative — chiffrer les paramètres publics — est écartée pour la raison que l'ADR 0021 donnait
déjà : un dérivateur DOIT lire ses paramètres avant de dériver, et un paramètre chiffré serait un
paramètre qu'il faudrait avoir déverrouillé pour lire.

## Décision 2 — 128 bits tirés, base 32 de Crockford, deux symboles de somme de contrôle

### Le tirage

**Exactement seize octets de `crypto.getRandomValues`.** Le code n'est dérivé de rien : ni du
volume, ni d'un identifiant, ni d'un compteur. La campagne de mutation retire la moitié du tirage et
l'épreuve rougit — la largeur seule ne suffisait pas à le voir, chaque rang du tampon doit VARIER.

### La table octets ↔ symboles

L'alphabet base 32 de Douglas Crockford écarte `I`, `L`, `O` et `U` : les trois premières se
confondent à l'œil avec `1` et `0` sur une feuille imprimée, la quatrième est écartée pour ne pas
composer de mot malheureux.

| Valeur | 0   | 1   | 2   | 3   | 4   | 5   | 6   | 7   | 8   | 9   | 10  | 11  | 12  | 13  | 14  | 15  |
| ------ | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Signe  | `0` | `1` | `2` | `3` | `4` | `5` | `6` | `7` | `8` | `9` | `A` | `B` | `C` | `D` | `E` | `F` |

| Valeur | 16  | 17  | 18  | 19  | 20  | 21  | 22  | 23  | 24  | 25  | 26  | 27  | 28  | 29  | 30  | 31  |
| ------ | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Signe  | `G` | `H` | `J` | `K` | `M` | `N` | `P` | `Q` | `R` | `S` | `T` | `V` | `W` | `X` | `Y` | `Z` |

Les cent vingt-huit bits sont lus **du poids fort au poids faible, cinq bits à la fois**. Vingt-six
symboles en portent cent trente ; les deux qui restent sont un BOURRAGE, valent zéro, et sont
**RELUS comme tels** — un bourrage non nul décrit une suite de symboles qui n'est pas un code de ce
produit, et il est refusé plutôt que rogné. Rogner accepterait quatre écritures distinctes du même
code, et la somme de contrôle cesserait d'être une fonction des octets.

Deux symboles de somme de contrôle suivent. Le tout est rendu en **sept groupes de quatre**, séparés
par des tirets. Trois vecteurs figés donnent la table à l'octet :

| Seize octets  | Code rendu                           |
| ------------- | ------------------------------------ |
| `202122…2e2f` | `40GJ-48S4-4MK2-EA19-58NJ-RB9E-5W9H` |
| `00000000…00` | `0000-0000-0000-0000-0000-0000-0001` |
| `ffffffff…ff` | `ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZZZZ-ZWDD` |

### La somme de contrôle : ISO 7064, système PUR, M = 1021 et r = 32

C'est la construction du système pur de l'ISO 7064 — celle de MOD 97-10, dont les deux chiffres de
contrôle d'un IBAN sont l'usage le plus répandu — instanciée en base 32 avec le plus grand nombre
premier sous 32² :

```
V = Σ  symbole_i · 32^(25−i)   (mod 1021)     sur les VINGT-SIX symboles de données
C = (1021 + 1 − (V · 1024 mod 1021)) mod 1021 écrit en DEUX symboles base 32
vérifier : Σ symbole_i · 32^(27−i) ≡ 1 (mod 1021)  sur les VINGT-HUIT symboles
```

**Les deux propriétés exigées se DÉMONTRENT**, et ne sont pas seulement observées. 1021 est premier,
donc les entiers modulo 1021 forment un corps, où un produit de facteurs non nuls est non nul :

- **toute substitution d'un symbole est détectée.** Remplacer le symbole de rang `k` change la somme
  de δ · 32^(27−k), avec δ ∈ [−31, 31] \ {0}. Ni δ ni 32^(27−k) n'est nul modulo 1021, donc la somme
  change. Les DEUX symboles de contrôle sont couverts au même titre que les vingt-six autres : ils
  ont le même poids ;
- **toute transposition de deux symboles adjacents est détectée.** Échanger `a` et `b` de rangs
  consécutifs change la somme de −(a − b) · 31 · 32^k. Aucun des trois facteurs n'est nul modulo
  1021 quand `a ≠ b`. Deux symboles ÉGAUX échangés ne changent pas la chaîne : ce n'est pas une
  erreur, et rien n'a à la détecter.

La démonstration ne dispense de rien : `tests/unit/vm-derivation-recuperation.test.mjs` refait les
deux propriétés **exhaustivement** sur les vecteurs figés — les trente et une substitutions de
chacun des vingt-huit rangs, pour chaque code, et toutes les transpositions adjacentes —, et
`tools/verifier-vecteurs.mjs` les refait une seconde fois, sans importer une ligne du produit.

### Elle n'est PAS un oracle, et il faut le dire précisément

Un oracle serait une garde qui, en refusant, dirait à qui essaie des secrets lequel mérite d'être
essayé encore. Celle-ci ne le peut pas, pour une raison structurelle :

- **elle ne dépend NI du volume NI de l'enveloppe.** C'est une fonction du code seul. Le module qui
  la porte n'importe rien d'autre que ses refus, et une épreuve d'inspection de source le tient ;
- **elle ne réduit pas l'espace de force brute.** Les deux symboles de contrôle sont une FONCTION
  déterministe et publique des cent vingt-huit bits : ils n'en ajoutent aucun et n'en retirent
  aucun. Un adversaire qui énumère des codes calcule lui-même ses sommes et n'essaie que des codes
  bien formés — ce qu'il aurait fait de toute façon, puisque la règle est publiée ici. L'espace
  reste 2¹²⁸.

Ce qu'elle sépare, en revanche, est utile et il est nommé : **« mal recopié » n'est pas « mauvais
code ».**

| Situation                                                                 | Refus                               |
| ------------------------------------------------------------------------- | ----------------------------------- |
| Absent, mauvaise longueur, signe étranger, somme fausse, bourrage non nul | `VAULT_DERIVATION_CODE_MAL_RECOPIE` |
| Bien formé, mais ce n'est pas le code de ce coffre                        | `VAULT_ENVELOPPE_CLE_REFUSEE`       |
| Le code a déjà été rendu                                                  | `VAULT_DERIVATION_CODE_DEJA_RENDU`  |

Le deuxième est le refus UN de l'ADR 0020 : **indiscernable d'une clé inconnue et d'une clé
révoquée**, message compris. Le premier ne consulte ni le volume ni l'enveloppe, et son remède est
de relire la feuille.

### La saisie : NFC, majuscule, séparateurs, repli

Dans cet ordre, et l'ordre compte :

1. **NFC** — la normalisation de l'ADR 0021, la même que pour la phrase ;
2. **majuscule** ;
3. **retrait des séparateurs** — tiret, tirets longs, espace, espace insécable, espace fine
   insécable, tabulation, fins de ligne ;
4. **repli de Crockford** — `O` → `0`, `I` et `L` → `1` ;
5. **tout autre signe est REFUSÉ**, jamais ignoré ni ramené sur une valeur par défaut.

Les vecteurs figés NOMMENT la forme plutôt que de la supposer. Sont ACCEPTÉES : la chaîne rendue
telle quelle, sans séparateurs, en minuscules avec des espaces, avec les replis (`o` pour `0`, `l`
pour `1`), avec une espace insécable et une tabulation. Sont REFUSÉES : un chiffre et une lettre
PLEINE CHASSE (U+FF10, U+FF21), qu'aucune forme canonique ne replie ; un `é` posé là où un repli par
défaut rendrait le code valide ; un `U`, que l'alphabet écarte sans repli ; un symbole de moins.

**Le vecteur du signe KELVIN (U+212A) est celui qui fige la normalisation**, et il vient de la
campagne de mutation : retirer la NFC ne cassait rien d'observable, parce que l'alphabet base 32 ne
porte aucun caractère composable. U+212A a une décomposition canonique SINGLETON vers `K` : les
quatre formes le ramènent dans l'alphabet, et une saisie non normalisée le refuserait. Il est donc
ACCEPTÉ, et c'est ce qui rend la garde mesurable.

### Le matériau remis à HKDF : SHA-256 des seize octets

`deriverKek` exige trente-deux octets — c'est la garde n° 11 de la campagne de mutation de l'ADR
0021, et elle n'est pas affaiblie ici. Le code en fait seize. Le matériau est donc `SHA-256(code)`.

**Cet élargissement n'ajoute AUCUNE entropie**, et le dire est la moitié du travail : l'image de
2¹²⁸ codes par SHA-256 compte au plus 2¹²⁸ valeurs. Ce qu'il achète est la conformité à la LARGEUR
du contrat, sans le toucher. Le reste est celui de l'ADR 0021, inchangé : le sel HKDF est celui de
l'emplacement, l'info est `infoDeLEmplacement` — elle lie le volume ET l'emplacement, et son
encodage n'est pas modifié d'un octet.

### Aucune liste de mots

**Refusée.** Une liste de mots (BIP-39 et ses semblables) rendrait le code plus facile à recopier et
à dicter. Elle est écartée pour deux raisons :

- **le coût de chaîne d'approvisionnement.** Une liste est un ARTEFACT : il faudrait la vendre dans
  le dépôt, la porter au manifeste, vérifier son empreinte deux fois comme l'ADR 0017 l'exige de
  l'artefact Argon2, et la figer pour toujours — une liste qui change d'un mot rend illisibles tous
  les codes émis avant ;
- **il n'y a rien à gagner à 128 bits.** Douze mots d'une liste de 2048 portent 132 bits, soit
  exactement ce que vingt-huit symboles portent déjà. La comparaison ne se joue pas sur la sécurité,
  elle se joue sur l'ergonomie — et l'ergonomie d'un code de récupération est l'affaire de #24, qui
  pourra AFFICHER les vingt-huit symboles comme il veut sans changer ce que le produit tire.

**256 bits (52 symboles) est écarté pour la même raison**, prise dans l'autre sens : doubler la
longueur d'un secret déjà hors de portée double le risque de recopie fautive sans rien acheter.

## Décision 3 — Rendu une seule fois, après que l'enveloppe est écrite

`creerMoyenDeRecuperation` (`src/vm/moyen-de-recuperation.mjs`) tire le code, pose l'emplacement de
type 4 par `ajouterEmplacement` — version + 1, page libre, barrière —, et rend un objet dont
`rendre()` livre la chaîne **une fois**. Un second appel rend `VAULT_DERIVATION_CODE_DEJA_RENDU`,
jamais la chaîne et jamais une valeur vide. La chaîne n'est pas un champ de l'objet : elle vit dans
la fermeture, n'apparaît donc dans aucune sérialisation, et est relâchée au premier rendu.

### Pourquoi `ajouterEmplacement` et non une création

Un moyen de récupération est par définition un SECOND moyen : il existe pour le jour où le premier a
disparu. Une enveloppe créée directement sur un code de récupération n'aurait pas de premier moyen à
secourir — ce serait un volume ouvert par un code, c'est-à-dire un autre produit et une autre
décision. Les pièces existent (`preparerEmplacementDerive` puis `creerEnveloppe`) ; ce module n'en
fait pas la promesse.

### L'ORDRE, et pourquoi il n'est pas symétrique

**L'enveloppe est écrite et sa barrière franchie AVANT le rendu.** Les deux coupures possibles ne se
valent pas :

- **coupure entre l'écriture et le rendu** — l'enveloppe porte un emplacement dont personne ne tient
  le code. C'est inoffensif : il n'ouvre rien pour personne, il occupe une place sur huit, et il se
  révoque comme n'importe quel autre ;
- **coupure entre le rendu et l'écriture**, si l'ordre était inversé — l'utilisateur tiendrait un
  code qui n'ouvre rien et le croirait valable. C'est le sinistre, parce qu'il ne se découvre qu'au
  moment où le code devait servir, c'est-à-dire quand plus rien d'autre n'ouvre.

C'est l'ordre de `preparerEnveloppeDeVolume` (ADR 0020) transposé : ce qui est DURABLE vient avant
ce qui est ANNONCÉ. Il est tenu par la STRUCTURE et non par une consigne — le porteur du code est
fabriqué à partir de ce que l'ajout a rendu, il ne peut donc pas exister avant lui —, et la campagne
de mutation retire l'attente pour vérifier que l'épreuve rougit.

### Le chemin de rendu, nommé

Le code est fabriqué **dans le Worker de confiance** et passe **une fois** vers la page de l'origine
de confiance. C'est le CANAL DE RENDU, symétrique de la phrase qui passe en sens inverse (ADR 0021,
limite 4) : une frontière INTERNE à l'origine de confiance, et non celle que `SEC-ORIGIN-001`
protège. Il ne franchit jamais le port vers l'origine applicative.

La sonde de `tests/browser/deverrouillage-frontiere.spec.mjs` est étendue en conséquence, et elle
AFFIRME ce canal positivement avant de mesurer toutes les absences : le code s'y trouve, et nulle
part ailleurs. Sont cherchés dans les six stockages, dans l'OPFS entier en texte ET en hexadécimal,
et dans les deux sens du port : la chaîne rendue, la même sans tirets, l'hexadécimal des seize
octets, et l'hexadécimal de leur SHA-256. L'appât est déposé d'abord, comme pour la phrase : une
fouille qui ne trouve jamais rien pourrait n'être qu'une fouille cassée.

### Ce qui est effacé, et ce qui ne peut pas l'être

La conduite de la décision 7 de l'ADR 0021, appliquée mot pour mot :

- **FAIT, non garanti** — les seize octets tirés sont mis à zéro dès que la KEK existe, et le tampon
  décodé par le dérivateur l'est dès que son SHA-256 est calculé. Le moteur a pu en copier le
  contenu ; c'est une fenêtre refermée, pas une garantie ;
- **IMPOSSIBLE** — effacer la CHAÎNE. C'est une `string` JavaScript : immuable, copiée par le
  moteur, ramassée quand il le décide. Rien dans le langage ne permet de faire mieux, exactement
  comme pour la phrase ;
- **HORS DE PORTÉE DU PRODUIT** — l'IMPRESSION. Un code imprimé sort de l'appareil par un chemin que
  Vault ne maîtrise pas : spouleur, PDF intermédiaire, disque d'une imprimante réseau. `SECURITY.md`
  l'écrit ; rien ici ne le promet.

## Décision 7 — Ce que le moyen COUVRE, et ce qu'il ne couvre pas

`SECURITY.md` porte désormais une liste à deux entrées, au même niveau. Elle est relue par
`tests/unit/dossier-de-revue.test.mjs`, qui exige la présence des huit entrées et leur vocabulaire —
à la manière dont il relit la table des statuts.

**Couvert** : passkey perdue ; appareil perdu avec archive et code (en renvoyant à la tranche 3 pour
l'archive : aujourd'hui l'archive n'emporte PAS l'enveloppe, décision 6 de l'ADR 0020, et cela n'est
pas maquillé) ; phrase oubliée ; emplacement compromis, par révocation (#148 pour le geste composé).

**Non couvert** : tous les moyens perdus, code compris — **aucun séquestre, et c'est délibéré** ;
archive perdue ; copie du code prise avant révocation ; retour arrière complet du support.

`SEC-RECOVERY-001` passe **exercé**, avec ses trois épreuves nommées comme preuve : succès,
révocation, perte définitive.

## La note que la Definition of Ready demandait : une ancre externe porterait DEUX compteurs

Si le dépôt se dote un jour d'une ancre externe pour fermer le rejeu du fichier — la limite que
l'ADR 0020 laisse ouverte —, **elle porte les DEUX compteurs, celui du volume et celui de
l'enveloppe, jamais deux ancres.** Deux ancres distinctes pourraient être restaurées séparément, et
un adversaire choisirait alors le couple qui l'arrange : une enveloppe ancienne avec un volume
récent, c'est-à-dire un emplacement révoqué remis en service sur des données à jour. Un compteur
unique qui porte les deux rend ce couple invalide par construction. Ce n'est pas décidé ici — rien
de cette tranche n'ancre quoi que ce soit — mais écrit pour que la question ne se rouvre pas.

## La campagne de mutation

Chaque garde neuve a été RÉELLEMENT retirée du texte source par
`tools/muter-gardes-recuperation.mjs`, l'épreuve relancée, puis le fichier restauré. **Quatorze
mutations, quatorze tuées** — mais une seulement au second passage, et c'est elle qui a le plus
appris.

| #   | Garde mutée                                          | Verdict | Ce qui la tue                                                         |
| --- | ---------------------------------------------------- | ------- | --------------------------------------------------------------------- |
| 1   | seize octets réellement TIRÉS                        | tuée    | « chacun des seize octets varie » sur 64 tirages                      |
| 2   | les deux bits de bourrage sont RELUS                 | tuée    | « un bourrage non nul est refusé »                                    |
| 3   | somme de contrôle vérifiée AVANT toute dérivation    | tuée    | « mal recopié ≠ mauvais code », et le refus typé du dérivateur        |
| 4   | l'alphabet écarte `I`, `L`, `O` et `U`               | tuée    | « vingt-huit symboles Crockford, sept groupes de quatre »             |
| 5   | le repli `O` → `0`                                   | tuée    | « la saisie humaine rend le MÊME code »                               |
| 6   | la NFC appliquée à la saisie                         | tuée\*  | le vecteur du signe KELVIN (U+212A)                                   |
| 7   | un signe étranger REFUSÉ, jamais replié par défaut   | tuée    | les vecteurs de saisie refusés (pleine chasse, `é`)                   |
| 8   | les séparateurs retirés, tiret compris               | tuée    | « aller-retour : encoder puis décoder rend les mêmes octets »         |
| 9   | la version du moyen relue STRICTEMENT                | tuée    | « une version inconnue est refusée à la LECTURE »                     |
| 10  | la largeur du sel HKDF relue DANS LE FICHIER         | tuée    | des paramètres au sel court, posés à la main                          |
| 11  | seize octets effacés dès que le MATÉRIAU existe      | tuée    | « le matériau est le SHA-256, et les octets sont effacés »            |
| 12  | seize octets TIRÉS effacés dès que la KEK existe     | tuée    | « les seize octets tirés sont EFFACÉS »                               |
| 13  | enveloppe écrite et barrière franchie AVANT le rendu | tuée    | 2 épreuves, dont « une coupure avant la barrière ne rend aucun code » |
| 14  | le code n'est rendu QU'UNE fois                      | tuée    | « un second appel rend un refus typé, jamais la chaîne »              |

**\* La seule qui a survécu au premier passage, et ce qu'elle a appris.** La NFC ne change RIEN pour
un alphabet base 32 : il ne porte aucun caractère composable, donc normaliser ou non ne modifiait
aucune saisie que le dépôt éprouvait. Ce n'était pas une garde inutile — c'était une garde qu'aucune
épreuve n'atteignait. Le vecteur du signe KELVIN la rend mesurable, et la mutation meurt depuis.
C'est le second service d'une campagne de mutation, celui que l'ADR 0024 avait déjà nommé : elle dit
parfois « l'épreuve que vous avez écrite ne touche pas la garde ».

Deux gardes ont exigé une épreuve NEUVE pour être atteintes, et les deux valaient d'être écrites :
la largeur du sel relue dans le FICHIER (n° 10), et le refus d'un signe étranger dans le cas où un
repli par défaut rendrait le code valide (n° 7).

**Ce que la campagne ne couvre PAS** : la garde du catalogue elle-même, qui est celle de l'ADR 0021
(mutation n° 19 de sa campagne) et n'est pas rejouée ici ; et l'inscription du type 4 dans le
catalogue que le Worker de confiance pose, qui n'est pas atteignable par une mutation unitaire — ce
qui la tient est le bout en bout sur les trois moteurs.

## Mesures

`VAULT_MESURER_DERIVATION=20 npm run test:deverrouillage`, sur les trois moteurs de la matrice #2,
Windows 11, machine de développement. Vingt dérivations par moteur, **deux exécutions**.

| Moteur       | phrase — exéc. 1 (p50 / p95) | phrase — exéc. 2 | **code** — exéc. 1 (p50 / p95) | **code** — exéc. 2 |
| ------------ | ---------------------------: | ---------------: | -----------------------------: | -----------------: |
| Chromium 151 |                 364 / 427 ms |     345 / 414 ms |               **0,1 / 0,4 ms** |     **0 / 0,4 ms** |
| WebKit 26.5  |                 315 / 354 ms |     310 / 376 ms |                   **1 / 2 ms** |       **0 / 1 ms** |
| Firefox 153  |             2 098 / 2 274 ms | 2 094 / 2 175 ms |                   **0 / 1 ms** |       **0 / 1 ms** |

**La CONDITION de la décision 1 est tenue, et elle est mesurée plutôt que supposée.** Le
déverrouillage par code coûte l'ordre de grandeur du PRF WebAuthn — « instantané » plutôt que «
visible », pour reprendre les mots de l'ADR 0021 —, soit **de deux à plus de trois ordres de
grandeur de moins que la phrase calibrée sur le même moteur**. L'épreuve de mesure porte l'assertion
: le p95 du code multiplié par dix doit rester sous le p50 de la phrase, faute de quoi la décision 1
ne tient plus.

**La dispersion entre les deux exécutions est inférieure à 7 % pour la phrase**, et le code est en
dessous de ce que ce banc sait mesurer : `performance.now` est bridé à la milliseconde sur WebKit et
Firefox, si bien qu'un p50 de 0 ou 1 ms est le PLANCHER de l'instrument, pas une valeur. Ce que la
mesure établit est un ordre de grandeur ; elle n'établit pas que le coût est de 0,1 ms partout.

Ce que ces nombres ne disent pas, et qu'il ne faut pas leur prêter : une seule machine, un seul
système, aucun téléphone. La limite est celle de l'ADR 0021, inchangée.

## Limites

1. **Rien ne garde le code une fois qu'il a quitté l'appareil.** C'est le sujet de ce moyen, et sa
   faiblesse : un code écrit sur une feuille se photographie. Le produit ne peut ni le savoir, ni
   l'empêcher, ni le détecter. Ce qu'il offre en regard est la RÉVOCATION, et l'ADR 0020 la rend
   indiscernable d'une clé inconnue ;
2. **L'IMPRESSION n'est pas maîtrisée.** Voir la décision 3. Aucune ligne de ce dépôt ne touche au
   chemin d'impression, et aucune ne le promet ;
3. **L'archive n'emporte pas l'enveloppe.** La décision 6 de l'ADR 0020 tient : `<volume>.cles`
   n'est pas dans l'archive d'export. Un appareil perdu avec son archive n'est donc pas encore
   récupérable par le seul code — c'est la tranche 3 de #23, et `SECURITY.md` le dit sans l'arrondir
   ;
4. **Le geste composé n'existe pas.** « Révoquer tout sauf celui que je tiens » demande plusieurs
   opérations, chacune sous une KEK valable, et une coupure entre deux laisse un état intermédiaire.
   C'est #148 ;
5. **Aucune interface.** Rien n'AFFICHE le code, rien n'aide à le noter, rien n'annonce l'attente
   d'un déverrouillage. C'est #24. Un code rendu par une fonction qu'aucune interface n'appelle est
   un mécanisme, pas encore un produit ;
6. **La sonde de non-persistance ne mesure pas d'origine APPLICATIVE.** Le banc de déverrouillage
   n'en a pas : il vit entièrement dans l'origine de confiance. Ce qui est mesuré est donc les six
   stockages de cette origine, l'OPFS entier, et les deux sens du port page ↔ Worker. La frontière
   que `SEC-ORIGIN-001` protège est éprouvée ailleurs (`tests/browser/apps-frontiere.spec.mjs`), et
   aucun code de récupération ne l'approche aujourd'hui, faute d'interface ;
7. **Le dépôt ne mesure pas le temps d'horloge d'un refus.** Comme l'ADR 0020 et l'ADR 0021 : deux
   échecs restent indiscernables par le nombre d'invocations AEAD, pas par la durée. Le refus « mal
   recopié » tombe en revanche BEAUCOUP plus tôt qu'un refus d'enveloppe, et c'est visible à
   l'horloge — ce n'est pas un oracle pour autant, puisqu'il ne dépend que de la saisie et qu'un
   adversaire le calcule lui-même hors ligne ;
8. **Un seul code par appel, et le plafond de huit emplacements est partagé.** Rien n'empêche d'en
   créer plusieurs, rien ne les compte, et rien n'avertit avant que `VAULT_ENVELOPPE_PLEINE` ne
   tombe. C'est un travail d'interface (#24) ;
9. **Le BANC garde le code en mémoire, et le produit n'a pas cet endroit-là.** La coquille de
   `deverrouillage.html` conserve toutes les réponses du Worker pour que la sonde puisse les
   fouiller ; le code y séjourne donc dans un tableau JavaScript, pour la durée de la page. C'est un
   artefact d'ÉPREUVE, nécessaire au témoin de la fouille, et il n'existe dans aucun chemin de
   production — il est nommé ici pour qu'un relecteur qui lit le banc ne le prenne pas pour une
   conduite du produit ;
10. **`crypto.getRandomValues` est cru sur parole.** Le produit demande seize octets au moteur et ne
    juge pas ce qu'il reçoit. Aucun test statistique n'est fait, et il n'en existe pas qui vaudrait
    sur seize octets. La qualité de ce tirage est celle du moteur, et le dépôt ne peut pas mieux.

## Impacts sur les ADR antérieurs

Aucun ADR n'est réécrit.

- **[ADR 0020](0020-enveloppe-de-cle.md)** — inchangée. Le type 4 est une ENTRÉE du format qu'elle a
  posé, pas un changement : le champ `typeKek` et le plafond de 512 octets étaient réservés. Son
  canal auxiliaire est RÉ-ASSUMÉ ici d'un cran plus large (décision 1). Sa décision 6 — l'archive
  n'emporte pas l'enveloppe — n'est pas touchée, et la limite 3 ci-dessus la nomme ;
- **[ADR 0021](0021-derivation-des-cles-de-deverrouillage.md)** — étendue, non modifiée : le
  catalogue de sa décision 6 sert un quatrième type, et la contrainte d'entropie de sa décision 3
  est honorée avec son chiffre (décision 1 ci-dessus). Une note datée d'une ligne est ajoutée à son
  paragraphe du catalogue ; le reste de l'ADR 0021 n'est pas retouché ;
- **[ADR 0017](0017-chaine-de-publication.md)** — inchangée, et c'est le point de l'alternative
  rejetée : aucune liste de mots n'entre dans la chaîne de publication.

## Alternatives rejetées

- **Réutiliser le type `phrase`.** Voir la décision 1 : l'emplacement serait indiscernable, et il
  paierait deux secondes d'Argon2id pour un secret qui n'a rien à compenser ;
- **Une liste de mots (BIP-39 ou semblable).** Un artefact vendu de plus, un manifeste, une
  empreinte à vérifier deux fois, et une liste figée pour toujours — pour zéro bit gagné à 128. Voir
  la décision 2 ;
- **256 bits, soit 52 symboles.** Doubler la longueur d'un secret déjà hors de portée double le
  risque de recopie fautive sans rien acheter ;
- **Un séquestre, même chiffré.** Il faudrait le confier à quelqu'un, ou l'écrire quelque part. Les
  deux contredisent la promesse du produit — un coffre que son propriétaire seul ouvre — et la
  décision 7 l'écrit comme un NON COUVERT délibéré plutôt que comme un manque ;
- **Dériver le code d'un secret existant** (de la phrase, du volume, d'un identifiant). Il ne serait
  alors plus un moyen INDÉPENDANT : perdre l'un perdrait l'autre, ce qui est exactement ce qu'un
  moyen de récupération doit empêcher ;
- **Un compteur d'essais sur le code.** Même réponse que l'ADR 0021 sur la phrase : il faudrait
  persister une trace des tentatives sur un disque dont l'adversaire dispose, et il ralentirait
  l'utilisateur légitime sans gêner celui qui recopie le fichier et essaie ailleurs ;
- **Une somme de contrôle plus longue, ou cryptographique.** Trois symboles détecteraient davantage
  d'erreurs multiples ; un HMAC tronqué serait inforgeable. Ni l'un ni l'autre n'achète quoi que ce
  soit ici : la somme ne défend contre AUCUN adversaire — elle sépare un accident de recopie d'un
  code étranger —, et deux symboles tiennent déjà les deux propriétés que l'ADR exige.

## Risques et conditions d'abandon

- **Si la mesure du déverrouillage par code s'écartait de l'ordre du PRF** sur un moteur de la
  matrice, la décision 1 tomberait avec elle : c'est une CONDITION écrite, et l'épreuve de mesure la
  porte en assertion. Le remède ne serait pas d'arrondir la mesure, mais de rouvrir la décision ;
- **Si un usage montrait que vingt-huit symboles sont trop pénibles à recopier**, ce qui change est
  l'INTERFACE (#24) — la découpe affichée, l'aide à la saisie, un contrôle en direct par la somme —
  et non le tirage. Le jour où ce serait le tirage, ce serait une version du moyen (`version` est
  dans les paramètres publics, relue strictement, et un lecteur qui ne la connaît pas refuse) ;
- **Si l'alphabet devait changer**, tous les codes déjà émis cesseraient de se relire. C'est un
  changement de `version`, un ADR, et une période où les deux versions coexistent — pas une
  correction ;
- **Si le canal auxiliaire élargi devenait inacceptable** pour un usage donné, la sortie n'est pas
  de masquer le type : ce serait de ne pas créer d'emplacement de récupération sur ce volume, ce que
  rien n'oblige à faire.
