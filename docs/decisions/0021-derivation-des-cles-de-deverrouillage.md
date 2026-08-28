# ADR 0021 — Une clé de déverrouillage se dérive d'une phrase Argon2id ou d'un PRF WebAuthn, et rien d'autre ne descend d'elle

- Statut : accepté
- Date : 2026-08-28
- Issue : #22 · Invariants : `SEC-KEY-001`, `SEC-ORIGIN-001` · Jalon 5

## Contexte

L'[ADR 0020](0020-enveloppe-de-cle.md) a livré la SERRURE : un fichier `<volume>.cles` où une ou
plusieurs KEK enveloppent la DEK, avec ses cinq opérations et ses douze refus. Elle a réservé trois
types de clé de déverrouillage — `phrase`, `webauthn-prf`, `harnais` — et un champ de PARAMÈTRES
PUBLICS de 512 octets qu'elle transporte et authentifie sans le lire. Elle a nommé la limite qui
restait : « la KEK n'existe que sous harnais », c'est-à-dire que le mécanisme était réel et que la
façon dont un humain obtient sa clé ne l'était pas.

#22 pose les CLÉS. C'est la première fois qu'un secret d'utilisateur entre dans le Worker de
confiance, et c'est ce qui change la nature des questions : il ne s'agit plus de savoir si des
octets sont bien liés, mais **où le secret existe, combien de temps, et ce qui reste après**.

Cet ADR décide donc quatre choses, dans cet ordre : quelle fonction étire quoi, quels octets entrent
dans l'étirement, ce que le produit fait quand la plate-forme ne peut pas, et ce que le dépôt promet
— ou refuse de promettre — sur l'effacement.

**Trois de ses décisions ont été corrigées par l'exécution**, et elles sont écrites ici comme telles
plutôt que reconduites en silence : le lieu de la dérivation par passkey (§ « Deux dérivations, deux
contextes »), la traduction des échecs de plate-forme (§ « Ce que les trois moteurs ont rendu »), et
l'ordre du tirage de l'identifiant d'emplacement (§ « L'amendement à l'ADR 0020 »).

## Décision 1 — Le contrat commun, et une KEK qui n'a pas d'octets

Un dérivateur est un objet à deux membres :

```js
{ type: number, deriver({ parametres, identite, geste }) → Promise<CryptoKey> }
```

`type` est une valeur de `TYPES_KEK` (ADR 0020) ; `parametres` sont les octets publics que
l'emplacement porte en clair et que sa DEK enveloppée AUTHENTIFIE ; `identite` est
`{ identifiantVolume, identifiantEmplacement }`, l'un venu du MANIFESTE et l'autre du fichier
d'enveloppes ; `geste` porte ce que l'utilisateur fournit — une phrase, ou rien du tout quand c'est
l'authentificateur qui parle.

**La KEK rendue est une `CryptoKey` non extractible, jamais trente-deux octets.** #21 recevait des
octets parce que le harnais les posait ; #22 les fabrique à partir d'un secret, et le contrat change
avec eux. `crypto.subtle.deriveKey` garde la valeur du côté du moteur : `exportKey` rejette, et il
n'existe aucune autre voie normative pour la lire. C'est la seule barrière de cette tranche qui ne
repose pas sur la discipline de celui qui écrit le code.

Le prix est un amendement à l'ADR 0020, décrit plus bas : `importerCleDeDeverrouillage` laisse
passer une `CryptoKey` **vérifiée** — algorithme, largeur, usage — au lieu d'exiger des octets. Lui
faire exiger des octets aurait obligé à passer par `deriveBits`, c'est-à-dire à fabriquer exprès la
valeur que toute la tranche s'attache à ne pas fabriquer.

## Décision 2 — HKDF-SHA-256 entre le secret et la serrure, et ce que son info lie

Les deux dérivateurs produisent un MATÉRIAU de trente-deux octets — une étiquette Argon2id, ou la
sortie de l'extension `prf` — et **aucun des deux ne devient une KEK directement**. Les deux passent
par HKDF-SHA-256 :

```
sel  = le sel public de l'emplacement (16 o pour une phrase, 32 o pour une passkey)
info = "railsbox-vault/derivation/v1/kek" ‖ identifiantVolume ‖ identifiantEmplacement ‖ version
KEK  = HKDF-SHA-256(materiau, sel, info) → CryptoKey AES-256-GCM non extractible
```

Chaque champ de l'info est préfixé de sa longueur, pour la raison de l'ADR 0020 : sans préfixe, un
signe glissé d'un champ à l'autre laisserait les octets inchangés et deux identités distinctes
tireraient la même clé. **Ici la conséquence serait pire qu'ailleurs** : une passkey enregistrée
pour un emplacement ouvrirait l'emplacement voisin, sur un autre volume. `vm-derivation-modele`
mesure l'injectivité sur quatre identités qui ne diffèrent que d'un champ.

**Pourquoi HKDF alors que le matériau fait déjà la bonne largeur.** Trois raisons, et aucune n'est
esthétique :

1. **la séparation de domaine.** La sortie PRF d'une passkey ne dépend que de la créance et du sel.
   Sans info, la même passkey et le même sel rendraient la même clé pour deux volumes — et le sel
   vit dans un fichier qu'un adversaire peut recopier d'un volume à l'autre ;
2. **l'uniformité.** Argon2id rend une étiquette uniforme, mais rien dans la spécification WebAuthn
   n'exige que la sortie PRF le soit ; HKDF extrait avant d'étendre, et le coût est nul devant les
   64 Mio qui précèdent ;
3. **`deriveKey` plutôt que `deriveBits`.** C'est l'appel qui rend une clé non extractible sans
   jamais matérialiser ses octets. HKDF est ce qui permet d'y arriver en un seul geste.

**Le sel public sert aussi de sel HKDF.** Il est déjà propre à l'emplacement ; en tirer un second
n'ajouterait aucune entropie et ajouterait un champ à authentifier.

Le modèle de référence de cette dérivation vit sous `tests/unit/modele-derivation.mjs` et non sous
`src/` — contrairement à celui de l'ADR 0020. Ce qu'il transcrit n'est pas un format sur disque mais
deux appels de WebCrypto ; le seul service qu'il rend est d'être une SECONDE transcription, écrite à
la main, entier par entier. L'accord entre les deux se prouve sans jamais extraire la clé de
production : on scelle sous l'une, on ouvre sous l'autre.

## Décision 3 — `phrase` : Argon2id RFC 9106, par un artefact VENDU et vérifié

### Ce qui est vendu, et pourquoi ce binaire-là

`vendor/argon2/argon2.wasm` — 25 725 octets, empreinte
`0c2149886c13e4eae4a6ca25ee71d47423c5c8740a874cf04ff816d1b2c901d7` — est l'implémentation de
RÉFÉRENCE d'Argon2 (`phc-winner-argon2`, celle de la RFC 9106) compilée en WebAssembly, telle que la
publie `argon2-browser@1.18.0`. Le manifeste `vendor/argon2/MANIFEST.json` en porte la provenance
complète : version npm, empreinte du tarball, chemin de l'entrée, et jusqu'aux noms minifiés de ses
exportations.

**Le critère de choix a été les VECTEURS, et il a écarté le candidat le plus évident.** Les trois
vecteurs de la RFC 9106 emploient un SECRET et des DONNÉES ASSOCIÉES ; une bibliothèque qui n'expose
ni l'un ni l'autre ne peut pas les rejouer, et le dépôt aurait dû se contenter de vecteurs de
seconde main. `hash-wasm` — plus récent, mieux entretenu, bien plus téléchargé — expose le secret
mais pas les données associées, et a été écarté pour cela seul.

**Il est VERSIONNÉ, contrairement aux artefacts v86.** Ces derniers font deux méga-octets et
`npm run vm:fetch` les récupère ; celui-ci fait vingt-cinq kilo-octets et il est chargé à chaque
déverrouillage par phrase. Un artefact récupéré à la construction ferait dépendre l'ouverture d'un
coffre d'une étape de construction ; récupéré à l'exécution, ce serait un CDN, que l'ADR 0013
interdit.

### Aucune ligne de colle Emscripten n'est importée

Le module tiers exige exactement DEUX importations — `emscripten_memcpy_big` et
`emscripten_resize_heap` — et elles tiennent en quinze lignes. La colle publiée avec le binaire fait
cent pages, cherche son `.wasm` par `fetch` ou par `require("fs")` selon un environnement qu'elle
devine, et serait en volume la plus grosse dépendance tierce du dépôt. Les écrire nous-mêmes réduit
l'artefact tiers à **un binaire vérifiable par empreinte**, sans code tiers autour.

**Un défaut trouvé par exécution, et il vaut d'être écrit** : la première version de
`emscripten_resize_heap` faisait croître la mémoire jusqu'à la taille exactement demandée. À 64 Mio
— la calibration retenue —, l'allocateur du module réclame le tas par petits pas, chaque
`Memory.grow` recopie le tampon, et la dérivation ne rendait plus la main en deux minutes. La même
mesure prise à 19 Mio passait en 72 ms et ne montrait rien. Doubler à chaque fois, comme le fait la
colle d'Emscripten, ramène la dérivation calibrée à quelques centaines de millisecondes.

### L'empreinte est vérifiée AVANT instanciation, et deux fois plutôt qu'une

`SEC-UPDATE-001` demande un runtime « identifié et vérifié ». Un manifeste que personne ne relit à
l'exécution n'identifie rien. L'empreinte est donc confrontée à deux moments, et aucun ne remplace
l'autre :

- **dans `publier:check`**, sur l'arbre publié, avant qu'il ne parte chez l'hébergeur — au même
  titre que celle de v86, par le même code ;
- **dans `src/vm/derivation/argon2-vendu.mjs`**, dans le navigateur, sur les octets réellement
  reçus, avant d'instancier quoi que ce soit. Un écart rend `VAULT_DERIVATION_ARGON2_INDISPONIBLE`.

Un binaire substitué en chemin — chez l'hébergeur, dans un cache, par un intermédiaire — pourrait
rendre une étiquette prévisible sans que rien ne le dise, et la phrase de chacun ouvrirait alors un
coffre que l'adversaire ouvre aussi. C'est la raison pour laquelle cette vérification-ci compte plus
que celle de v86.

### La calibration EST le plancher, et le plancher est celui de la RFC

La RFC 9106 § 4 publie deux jeux recommandés. **Le second — m = 64 Mio, t = 3, p = 4 — est retenu
tel quel, et il sert à la fois de calibration et de PLANCHER.** Ce n'est pas de la paresse : un
plancher que le dépôt inventerait plus bas que la RFC serait un plancher choisi pour aller plus
vite, c'est-à-dire exactement ce que le contrat de #22 interdit.

Les mesures (§ « Mesures ») ont confirmé que ce coût tient dans un déverrouillage interactif sur les
trois moteurs. **Si elles ne l'avaient pas fait, c'est le produit qui aurait dû changer, pas le
plancher** — par exemple en déportant la dérivation dans un Worker dédié plutôt qu'en abaissant le
coût.

Le plancher est vérifié à DEUX moments, et le second est celui qui compte :

- à l'ÉCRITURE des paramètres, pour qu'un emplacement ne puisse pas naître affaibli ;
- à la LECTURE, avant de dériver — parce que ces octets viennent d'un fichier. L'ADR 0020 les
  authentifie, donc une altération sera vue ; mais l'ordre des vérifications de l'ADR 0015 vaut ici
  aussi : on ne dérive pas sous des paramètres qu'on n'a pas encore jugés admissibles. **La campagne
  de mutation a montré que seul le premier était éprouvé** (mutation n° 6, § « La campagne de
  mutation »), et l'épreuve manquante a été écrite.

### La NFC est appliquée, et le dire est la moitié du travail

« é » s'écrit de deux façons qu'aucun clavier ne distingue à l'œil. Sans normalisation, une phrase
tapée sur un clavier de macOS n'ouvrirait pas ce qu'une phrase tapée sur un clavier de Windows a
fermé, et le produit dirait « clé refusée » à quelqu'un qui a tapé la bonne phrase. NFC est donc
appliquée — et écrite, parce qu'une normalisation silencieuse est une transformation du secret que
l'utilisateur ne peut pas prévoir.

Ce qui n'est PAS fait, et qui est hors périmètre par le contrat : aucune espace n'est rognée, aucune
casse n'est modifiée, et la « force » de la phrase n'est pas évaluée. Rogner une espace finale
changerait le secret sans le dire ; l'évaluer est l'affaire de l'interface (#24).

### Argon2i n'est pas servi, et c'est MESURÉ

Le binaire calcule Argon2d et Argon2id à la vitesse attendue et reproduit leurs vecteurs RFC 9106 à
l'octet. Argon2**i** est juste, et pathologiquement lent : **14,9 s pour m = 32 Kio, t = 1, p = 1**,
là où Argon2id coûte 2 ms sur les mêmes paramètres — cinq ordres de grandeur. Le vecteur de la RFC
9106 § 5.2 (m = 32 Kio, t = 3, p = 4) ne rend pas la main dans un budget d'épreuve.

`hacher` refuse donc la variante `i` : la laisser passer offrirait un chemin qui paraît normal et
gèle l'onglet. Le vecteur reste dans `tests/vectors/derivation-v1.json` avec `rejoue: false` et son
motif écrit — un vecteur écarté sans mesure serait un vecteur passé sous silence —, et une épreuve
vérifie à la fois que le motif y est et que la variante est refusée. Le produit n'emploie
qu'Argon2id, que la RFC 9106 recommande par défaut.

## Décision 4 — `webauthn-prf` : l'extension, un sel par emplacement, et `signCount` ignoré

L'extension `prf` évalue une fonction pseudo-aléatoire propre à la créance sur une entrée que le
site choisit. Cette entrée — le SEL — est tirée à l'enregistrement, trente-deux octets, et vit dans
les paramètres publics. Deux emplacements de la même passkey ont donc deux sels, et HKDF y ajoute
l'identité de l'emplacement : même un authentificateur qui ignorerait le sel ne rendrait pas deux
fois la même KEK. Une épreuve unitaire le mesure en dérivant deux emplacements distincts de la même
sortie PRF et en vérifiant que la première clé n'ouvre pas ce que la seconde a scellé.

**`residentKey: "required"` et `userVerification: "required"`**, tranchés ici plutôt que laissés au
défaut du moteur :

- une créance DÉCOUVRABLE rend le volume ouvrable depuis un appareil neuf qui a la même passkey
  synchronisée. Sans elle, déverrouiller exigerait de connaître d'avance l'identifiant de créance ;
  il est justement dans le fichier d'enveloppes, c'est-à-dire dans quelque chose qu'on peut perdre
  avec l'appareil ;
- la vérification d'utilisateur exige un geste (biométrie, code). Une simple présence rendrait la
  clé dérivable par quiconque tient l'appareil déverrouillé, ce qui reviendrait à ranger la clé à
  côté du coffre.

**`signCount` n'est pas une fraîcheur, et ce module ne le lit pas.** L'ADR 0015 l'avait déjà écrit :
le compteur de signatures est facultatif en CTAP2, et la plupart des authentificateurs de plateforme
le laissent à zéro. Refuser une assertion dont le compteur n'a pas augmenté refuserait la majorité
des passkeys modernes ; l'accepter comme preuve de fraîcheur serait croire tenir une garantie
qu'aucun authentificateur ne promet. L'épreuve le montre en dérivant deux fois sous des compteurs
DÉCROISSANTS et en vérifiant que les deux KEK sont la même. Ce qui tient lieu de fraîcheur est
ailleurs, et c'est celui de l'ADR 0020 : la KEK n'ouvre que si elle développe la DEK de son
emplacement.

**Ce module ne vérifie ni la signature de l'assertion, ni l'origine, ni le défi**, et ce n'est pas
un oubli. Vault n'est pas un serveur qui AUTHENTIFIE un utilisateur, c'est un coffre qui DÉRIVE une
clé. La question n'est pas « ce navigateur dit-il vrai ? » mais « la clé développe-t-elle la DEK ?
», et à celle-là c'est l'étiquette AES-GCM de l'enveloppe qui répond, sans faire confiance à
personne. Un attaquant capable de forger une assertion sans l'authentificateur n'obtiendrait pas
pour autant la sortie PRF, qui est la seule chose dont la clé dépend.

## Décision 5 — Deux dérivations, deux contextes, et c'est la plate-forme qui l'impose

`navigator.credentials` **n'existe pas dans un Worker** : l'appel WebAuthn doit partir d'un
document. Ce fait — mesuré par l'épreuve de frontière, sur les trois moteurs, plutôt que supposé —
décide du partage :

- **`phrase` est dérivée dans le WORKER.** Argon2id calibré coûte quelques centaines de
  millisecondes de calcul continu ; le faire sur le fil de la page gèlerait l'interface à chaque
  tentative. La phrase franchit donc le port page → Worker, **à l'intérieur de l'origine de
  confiance**. Ce n'est pas la frontière que `SEC-ORIGIN-001` protège : celle-là sépare l'origine
  applicative de celle-ci, et rien de ce message ne la traverse ;
- **`webauthn-prf` est dérivée dans la PAGE**, et seule la `CryptoKey` non extractible franchit le
  port, par clone structuré. Ce qui passe est un handle opaque, pas un secret ; la sortie PRF brute
  ne quitte jamais le document.

La première rédaction de cette tranche plaçait les deux dérivations dans le Worker, par symétrie.
Elle était irréalisable, et l'écrire ainsi aurait publié une architecture que le code ne pouvait pas
tenir.

## Décision 6 — La conduite quand la plate-forme ne peut pas

Quatre situations, quatre codes, et aucun ne se dégrade en un autre.

| Situation                                                        | Code                                   | Remède                                 |
| ---------------------------------------------------------------- | -------------------------------------- | -------------------------------------- |
| (a) pas de WebAuthn, ou `prf` absent / `enabled` faux à `create` | `VAULT_DERIVATION_PRF_INDISPONIBLE`    | créer l'emplacement sur un AUTRE moyen |
| (b) sortie `prf` absente ou mal dimensionnée à `get`             | `VAULT_DERIVATION_PRF_IGNOREE`         | un autre authentificateur              |
| (c) `NotAllowedError` — refus, fermeture, temps écoulé           | `VAULT_DERIVATION_ANNULEE`             | recommencer le geste                   |
| (d) type d'emplacement qu'aucun dérivateur ne sert               | `VAULT_DERIVATION_TYPE_INCONNU`        | mettre à jour, jamais essayer une clé  |
| paramètres inadmissibles, ou coût sous le plancher               | `VAULT_DERIVATION_PARAMETRES_REFUSES`  | restaurer une sauvegarde du fichier    |
| aucune phrase présentée                                          | `VAULT_DERIVATION_PHRASE_REFUSEE`      | en taper une                           |
| artefact Argon2 absent ou non conforme                           | `VAULT_DERIVATION_ARGON2_INDISPONIBLE` | réparer l'installation                 |

**(a) et (b) sont deux codes et non un**, parce que les remèdes n'ont rien de commun : dans le
premier cas l'emplacement n'a jamais pu être créé ici, dans le second il est parfaitement légitime
et c'est l'authentificateur du moment qui ne sert pas l'extension.

**(c) ne persiste RIEN.** Aucun compteur d'échec, aucune mémoire d'une annulation, aucun repli
automatique : le dérivateur est sans état, et deux annulations de suite sont exactement la première,
répétée. L'épreuve de navigateur le mesure en annulant deux fois puis en réussissant.

**(d) ne modifie pas le fichier**, et l'épreuve compare son empreinte avant et après le refus. Une
enveloppe qui porte un emplacement d'un type inconnu ET un emplacement servable s'ouvre par le
second : le refus ne tombe que si aucun n'est servable. C'est la compatibilité que #23 exigera quand
il ajoutera des codes de secours.

**Le repli vers `phrase` n'est jamais automatique.** Ce n'est pas une règle de code, c'est une
propriété de structure : un dérivateur ne connaît que son type, et la couche d'ouverture ne dérive
que l'emplacement qu'elle a choisi. Il n'existe aucun chemin qui essaierait un second moyen — et
c'est bien ainsi, puisque le second moyen est un autre emplacement, créé explicitement (#23).

**Ce qu'aucun de ces codes ne fait : dire qu'un secret est faux.** Le dérivateur est une FONCTION.
Il rend une clé pour tout geste qu'il accepte, et c'est l'enveloppe qui tranche ensuite, par
`VAULT_ENVELOPPE_CLE_REFUSEE`. Un code « mauvaise phrase » ici serait un oracle : il dirait à qui
essaie des phrases laquelle mérite d'être essayée encore.

### Ce que les trois moteurs ont rendu, et ce que cela a changé

Sans authentificateur, **Firefox rend `UnknownError`** (« The operation failed for an unknown
transient reason ») là où **WebKit rend une créance dépourvue de résultat `prf`**. La première
rédaction ne traduisait que `NotAllowedError` : une `DOMException` brute sortait donc du produit,
avec un `code` numérique hérité que rien dans ce dépôt ne sait lire — et un refus de sécurité qui se
perd en route est un refus qui n'existe pas.

Tout échec de plate-forme est désormais traduit : l'annulation d'un côté, l'indisponibilité de
l'autre, en NOMMANT l'erreur du moteur dans le contexte. Prétendre distinguer davantage reviendrait
à inventer une cause que le navigateur ne donne pas.

## Décision 7 — Ce qui n'est jamais persisté, et ce que JavaScript ne garantit pas

**Jamais écrit** : la phrase, la sortie PRF, la KEK dérivée, le matériau HKDF — ni dans OPFS, ni
dans IndexedDB, `localStorage`, `sessionStorage`, Cache Storage, les cookies, ni dans un
`postMessage` vers l'origine applicative. La sonde de `deverrouillage-frontiere.spec.mjs` fouille
les six stockages, l'OPFS entier (en texte ET en hexadécimal) et les DEUX SENS du port, sur les
trois moteurs. Elle commence par déposer un APPÂT et exige de le retrouver : une fouille qui ne
trouve jamais rien pourrait n'être qu'une fouille cassée.

**Ce que le dépôt fait, et ce qu'il ne peut pas promettre.** Le contrat de #22 demande que ce soit
écrit, et le voici sans arrondi :

- **GARANTI** — les octets d'une `CryptoKey` non extractible ne sont pas atteignables depuis le
  langage. `exportKey` rejette, et il n'existe aucune autre voie normative ;
- **FAIT, mais non garanti** — les tampons de matériau (`Uint8Array`) sont remplis de zéros dès que
  la clé existe, et le tampon d'étiquette d'Argon2 est mis à zéro dans le tas WebAssembly avant
  d'être rendu à l'allocateur. Le moteur a pu en copier le contenu lors d'un `importKey`, d'une
  promotion de génération ou d'un déplacement de tas. **C'est une fenêtre refermée, pas une
  garantie** ;
- **IMPOSSIBLE** — effacer la phrase. C'est une `string` JavaScript : immuable, copiée par le
  moteur, ramassée quand il le décide, impossible à écraser. Rien dans le langage ne permet de faire
  mieux ;
- **IMPOSSIBLE aussi** — empêcher la mémoire du processus de partir dans un fichier d'échange ou un
  vidage de plantage. Aucun code JavaScript ne verrouille une page en mémoire.

## L'amendement à l'ADR 0020, et pourquoi il était inévitable

L'info d'HKDF lie l'identifiant d'EMPLACEMENT (décision 2). Une KEK ne peut donc pas être dérivée
avant que l'emplacement n'ait un identifiant — or #21 tirait cet identifiant à l'INTÉRIEUR de
`creerEnveloppe`, au moment de sceller. Les deux ne tiennent pas ensemble, et **le défaut est apparu
en écrivant la première épreuve, pas en relisant l'ADR**.

L'ADR 0020 est donc amendé d'une ligne : `creerEnveloppe`, `ajouterEmplacement` et
`remplacerEmplacement` acceptent un `identifiantEmplacement` FOURNI. Le défaut ne change pas — il
est toujours tiré à l'intérieur —, et l'unicité reste celle du tirage. Ce qui change est seulement
QUI tire, et il fallait que ce soit celui qui dérive.

La porte ainsi ouverte est refermée par une garde que #21 n'avait pas besoin d'écrire : **un
identifiant déjà présent est refusé**. Deux tirages de huit octets ne se rencontrent pas, mais deux
identifiants fournis, si — et deux emplacements de même nom rendraient toute révocation ambiguë. La
campagne de mutation a d'abord laissé cette garde survivre, faute d'épreuve ; celle-ci a été écrite.

**Une conséquence à dire plutôt qu'à découvrir : remplacer une clé RE-DÉRIVE.** L'ADR 0020 fait déjà
changer l'identifiant d'emplacement à chaque remplacement, pour que le même nom ne désigne pas deux
secrets successifs ; la KEK étant liée à cet identifiant, elle change forcément avec lui. Ce n'est
pas un coût nouveau : remplacer une clé, c'est justement en fabriquer une autre.

## La campagne de mutation

Chaque garde a été RÉELLEMENT retirée ou affaiblie par un outil qui réécrit le fichier, relance les
quatre suites unitaires, puis restaure. **Vingt-trois mutations, vingt-trois tuées** — mais cinq
seulement au second passage, et ce sont elles qui ont le plus appris.

| #   | Garde mutée                                           | Verdict | Ce qui la tue                                                     |
| --- | ----------------------------------------------------- | ------- | ----------------------------------------------------------------- |
| 1   | empreinte de l'artefact vérifiée avant instanciation  | tuée    | « un artefact dont l'empreinte diffère d'un bit est REFUSÉ »      |
| 2   | taille de l'artefact vérifiée                         | tuée\*  | « un artefact TRONQUÉ est refusé en NOMMANT la taille »           |
| 3   | variante Argon2i refusée                              | tuée    | « le vecteur NON rejoué porte son motif »                         |
| 4   | chargement raté rendu comme refus typé                | tuée    | « un artefact absent rend un refus TYPÉ, jamais un repli »        |
| 5   | plancher RFC 9106 à l'ÉCRITURE                        | tuée    | « des paramètres sous le plancher sont refusés »                  |
| 6   | plancher RFC 9106 à la LECTURE                        | tuée\*  | « des paramètres AFFAIBLIS lus dans le fichier sont refusés »     |
| 7   | NFC appliquée à la phrase                             | tuée    | « deux écritures Unicode rendent la même KEK »                    |
| 8   | phrase vide refusée                                   | tuée    | « une phrase vide est refusée par un code distinct »              |
| 9   | info HKDF liant l'EMPLACEMENT                         | tuée    | 3 épreuves, dont « deux emplacements, deux KEK »                  |
| 10  | info HKDF liant le VOLUME                             | tuée    | 2 épreuves, dont l'injectivité                                    |
| 11  | largeur du matériau remis à HKDF                      | tuée    | « un matériau de mauvaise largeur est refusé »                    |
| 12  | KEK NON EXTRACTIBLE                                   | tuée    | 2 épreuves, unitaire et navigateur                                |
| 13  | matériau mis à zéro après dérivation                  | tuée    | « scellée sous l'une, ouverte sous l'autre »                      |
| 14  | extension `prf` ACTIVÉE exigée à l'enregistrement     | tuée    | « PRF indisponible : refus TYPÉ, jamais une dégradation »         |
| 15  | sortie PRF exigée à l'assertion                       | tuée    | « l'extension IGNORÉE rend un refus DISTINCT »                    |
| 16  | largeur de 32 octets de la sortie PRF                 | tuée    | « une sortie qui ne fait pas 32 octets est refusée »              |
| 17  | `NotAllowedError` traduite en ANNULATION              | tuée    | « l'ANNULATION rend son propre code, sans repli »                 |
| 18  | l'assertion vise la créance des paramètres publics    | tuée\*  | « PRF disponible : la KEK est une CryptoKey non extractible »     |
| 19  | type de KEK non servi refusé par le catalogue         | tuée    | 2 épreuves, dont « le fichier n'est pas modifié »                 |
| 20  | décodeur STRICT : aucune queue tolérée                | tuée    | « le décodeur REFUSE plutôt que de compléter »                    |
| 21  | plafond de 512 octets des paramètres publics          | tuée    | « des paramètres au-delà du plafond sont refusés »                |
| 22  | identifiant d'emplacement fourni refusé s'il est pris | tuée\*  | « un identifiant DÉJÀ pris est refusé : deux noms, deux secrets » |
| 23  | `CryptoKey` présentée vérifiée (algorithme, largeur)  | tuée\*  | « une CryptoKey qui n'est pas une clé de déverrouillage »         |

**\* Les cinq qui ont survécu au premier passage, et ce qu'elles ont appris.**

- **n° 6** est la plus importante des cinq. Le plancher n'était éprouvé qu'à l'ÉCRITURE, si bien que
  retirer sa vérification à la LECTURE ne cassait rien — alors que c'est le côté qui compte, et
  précisément l'attaque que l'ADR 0020 nomme : un adversaire ramène le coût à rien, l'utilisateur
  tape la même phrase, et le volume volé devient cassable hors ligne pour trois fois rien. Deux
  épreuves ont été écrites, dont une sur la variante ;
- **n° 22 et n° 23** couvrent les deux portes que l'amendement à l'ADR 0020 vient d'ouvrir. Aucune
  n'était éprouvée, pour une raison simple : elles n'existaient pas avant cette tranche ;
- **n° 2** a survécu pour une raison INSTRUCTIVE : un artefact d'une autre taille a de toute façon
  une autre empreinte, et le contrôle de taille n'achète donc aucune sécurité de plus. Ce qu'il
  achète est un DIAGNOSTIC — « il en manque des octets » envoie vérifier un déploiement, «
  l'empreinte ne correspond pas » envoie soupçonner une substitution —, et c'est ce diagnostic qui
  est désormais mesuré, contexte compris ;
- **n° 18** n'a pas survécu : la mutation était mal formée et ne mutait rien. Refaite, elle meurt.
  Une mutation qui survit doit d'abord être soupçonnée elle-même — la leçon est celle de l'ADR 0020.

## Mesures

`VAULT_MESURER_DERIVATION=20 npm run test:deverrouillage`, sur les trois moteurs de la matrice #2,
Windows 11, machine de développement. Vingt dérivations calibrées par moteur, **deux exécutions**.

| Moteur       | exéc. 1 — p50 |     p95 | exéc. 2 — p50 |     p95 |
| ------------ | ------------: | ------: | ------------: | ------: |
| Chromium 151 |        364 ms |  443 ms |        363 ms |  446 ms |
| WebKit 26.5  |        329 ms |  458 ms |        324 ms |  418 ms |
| Firefox 153  |      2 141 ms | 2205 ms |      2 136 ms | 2207 ms |

**La dispersion entre les deux exécutions est inférieure à 2 % partout** ; celle entre les MOTEURS
ne l'est pas, et c'est le résultat qui compte : **Firefox paie près de six fois le prix de Chromium
pour le même travail**. Ce n'est ni un défaut de la calibration ni une erreur de mesure — c'est le
rendement de son moteur WebAssembly sur une boucle qui écrit 64 Mio en mémoire trois fois.

**Ce que cela décide, et ce que cela ne décide pas.** Deux secondes sont à la limite haute de ce
qu'un déverrouillage interactif peut demander, et c'est le moteur le plus lent qui fixe la borne. La
calibration reste celle de la RFC : abaisser le coût pour Firefox reviendrait à affaiblir le coffre
de tous. Ce que la mesure appelle est un travail d'INTERFACE (#24) — annoncer l'attente plutôt que
la subir —, pas un travail de cryptographie.

**Coût du PRF**, sur Chromium avec un authentificateur virtuel : **p50 1 ms, p95 1 à 2 ms** (dix
assertions). Ce n'est pas un calcul, c'est un aller-retour vers l'authentificateur suivi d'un seul
HKDF, et le chiffre le dit : la comparaison utile n'est pas 1 ms contre 364 ms, mais « instantané »
contre « visible ». **Sur un authentificateur RÉEL, le coût dominant sera le geste humain** —
toucher un lecteur, taper un code — que ce banc ne mesure pas et ne prétend pas mesurer.

## Limites

1. **L'authentificateur virtuel PRF n'est pilotable que sous Chromium.** Le protocole CDP est propre
   à ce moteur. Sur Firefox et WebKit, le chemin est exercé JUSQU'À L'APPEL et le refus typé est
   vérifié ; les conduites (b) et (c) y sont explicitement IGNORÉES, avec leur motif écrit dans le
   relevé de l'épreuve. Ce que le dépôt sait de PRF sur ces deux moteurs, il le sait par la matrice
   de `docs/compatibility.md`, pas par une mesure de bout en bout ;
2. **Aucun authentificateur RÉEL n'est mesuré.** Un authentificateur virtuel répond instantanément
   et accepte tout ; il ne dit rien de la disponibilité de `prf` sur un Touch ID, une YubiKey ou un
   Android. La matrice de compatibilité ne promet donc rien là où rien n'est mesuré ;
3. **WebAuthn refuse une adresse IP comme `rpId`.** L'origine de confiance du dépôt est
   `http://127.0.0.1:4173` ; le banc est joint par le nom `localhost` sur le même serveur pour les
   trois épreuves PRF. C'est une contrainte de la spécification, pas une faiblesse de la topologie —
   en production l'origine porte un vrai domaine —, mais cela veut dire que la mesure PRF est prise
   sur une origine qui n'est pas exactement celle des autres épreuves ;
4. **La phrase franchit un port.** Page → Worker, à l'intérieur de l'origine de confiance. C'est une
   frontière INTERNE, pas celle de `SEC-ORIGIN-001`, et la sonde vérifie que le sens Worker → page
   n'en porte rien. Elle reste un endroit de plus où le secret existe, et le seul moyen de
   l'éliminer serait de dériver dans la page — au prix d'une interface figée pendant deux secondes ;
5. **La synchronisation de passkeys entre appareils n'est pas mesurée.** `residentKey: "required"`
   est ce qui la rend possible, et le contrat de #22 la classe hors périmètre : elle est nommée ici,
   pas éprouvée ;
6. **La mesure porte sur une machine.** Un ordinateur de développement sous Windows. Le matériel
   d'un utilisateur — et surtout un téléphone — n'est pas dans ces nombres ;
7. **Le dépôt ne mesure pas le temps d'horloge d'un refus.** Comme l'ADR 0020 : deux ÉCHECS restent
   indiscernables par le nombre d'invocations AEAD, pas par la durée, et une dérivation de phrase
   coûte le même prix qu'elle réussisse ou non — puisque c'est l'enveloppe, ensuite, qui tranche ;
8. **L'artefact Argon2 est un binaire tiers.** Son empreinte est vérifiée deux fois et sa provenance
   est publiée, mais **personne dans ce dépôt ne l'a recompilé depuis les sources**. Ce qui est
   établi est qu'il reproduit deux vecteurs de la RFC 9106 à l'octet ; ce n'est pas la même chose
   qu'un audit de son code.

## Impacts sur les ADR antérieurs

Aucun ADR n'est réécrit.

- **[ADR 0020](0020-enveloppe-de-cle.md)** — amendée : un `identifiantEmplacement` peut être FOURNI
  aux trois opérations qui créent un emplacement, et une `CryptoKey` vérifiée tient lieu de KEK. La
  limite 4 (« la KEK n'existe que sous harnais ») est LEVÉE ; les limites 1, 2, 3, 5, 6 et 7 restent
  ;
- **[ADR 0015](0015-proprietes-cryptographiques-du-format.md)** — sa phrase sur `signCount` est
  appliquée : il n'est pas lu, et une épreuve le mesure ;
- **[ADR 0013](0013-csp-de-la-coquille-et-boucle-de-v86.md)** — inchangée. `'wasm-unsafe-eval'`, qui
  existait pour v86, sert aussi Argon2 ; `connect-src 'self'` suffit à charger l'artefact ;
- **[ADR 0017](0017-chaine-de-publication.md)** — étendue : un second manifeste vendu entre dans la
  vérification d'épinglage, par le même code.

## Alternatives rejetées

- **PBKDF2, que WebCrypto offre nativement.** Il aurait évité tout artefact tiers. Il est rejeté
  parce qu'il n'est pas coûteux en MÉMOIRE : une carte graphique le calcule des milliers de fois en
  parallèle, et la RFC 9106 existe précisément pour cela. Économiser vingt-cinq kilo-octets au prix
  de la résistance au parallélisme serait un mauvais marché ;
- **scrypt.** Meilleur que PBKDF2, mais aucun moteur ne l'offre nativement — il aurait donc fallu un
  artefact tiers de toute façon —, et la RFC 9106 est plus récente et mieux paramétrée ;
- **Argon2 en JavaScript pur.** Aucun artefact à vendre, aucun binaire à vérifier. Rejeté sur le
  coût : un ordre de grandeur au-dessus du WebAssembly, ce qui aurait obligé à baisser la
  calibration sous le plancher de la RFC pour rester utilisable ;
- **`hash-wasm`.** Voir la décision 3 : il ne sert pas les données associées, et ne peut donc pas
  rejouer les vecteurs de la RFC 9106 ;
- **La colle Emscripten publiée avec le binaire.** Cent pages de code tiers, un `fetch` implicite,
  une détection d'environnement. Écrire quinze lignes d'importations à la place réduit l'artefact
  tiers à ce qu'il doit être ;
- **Chiffrer les paramètres publics.** Ils seraient alors illisibles avant déverrouillage — or un
  dérivateur DOIT lire les siens pour dériver. C'est le canal auxiliaire que l'ADR 0020 a déjà
  assumé ;
- **Un compteur d'échecs de déverrouillage.** Il aurait fallu l'écrire quelque part, c'est-à-dire
  persister une trace des tentatives sur un poste dont l'adversaire tient le disque. Il aurait
  ralenti l'utilisateur légitime sans gêner un adversaire qui recopie le fichier et essaie ailleurs.

## Risques et conditions d'abandon

- **Si PRF reste indisponible sur un moteur majeur**, `phrase` porte tout le déverrouillage. Ce
  n'est pas une panne : c'est la conduite (a), et elle est explicite. La matrice de compatibilité
  dit ce qui est mesuré ;
- **Si la calibration devient insoutenable sur un matériel visé** — un téléphone, par exemple —, la
  réponse n'est PAS d'abaisser le coût sous la RFC. Ce serait de déporter la dérivation, d'annoncer
  l'attente, ou de restreindre la cible. L'ADR sera modifié en le disant ;
- **Si l'artefact vendu se révélait défectueux**, la sortie est ouverte : le loader est à nous, le
  contrat `hacher` est à nous, et changer de binaire est un changement de manifeste et d'empreinte,
  pas une réécriture. La lenteur d'Argon2i, mesurée ici, est un premier signal qu'un tel changement
  finira peut-être par s'imposer.
