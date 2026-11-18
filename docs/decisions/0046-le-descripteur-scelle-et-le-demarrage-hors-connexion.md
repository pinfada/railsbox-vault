# ADR 0045 — Le descripteur scellé et le démarrage hors connexion

- Statut : **proposé** — format persistant et cryptographie : la fusion attend l'accord du
  propriétaire, et une revue de sécurité distincte
- Date : 2026-11-17
- Complète : l'ADR 0044 (§ 6, le hors-ligne « arrêté mais pas implémenté »), l'ADR 0042 (la décision
  de déphasage et son amendement du 04/10 sur le gel de version), l'ADR 0033 (la hiérarchie de clés)
- Issues : #247 (lot D1, `lot:artefacts`, ne la ferme pas : D2 suit), #236
- Décisions du superviseur, par délégation du mainteneur : commentaire du 04/10/2026 sur #247

## Contexte

L'ADR 0044 a arrêté que le dernier descripteur vérifié, rangé au magasin, fait foi quand l'origine
est injoignable — et ne l'a pas implémenté. La revue de sécurité du 04/10/2026 a constaté deux
choses :

1. **un descripteur rangé dans l'OPFS n'est authentifié par rien d'extérieur à l'OPFS.** Qui y écrit
   fabriquerait le document qui décide de ce que la machine démarre — noyau, ligne de commande,
   paquet ;
2. **seuls le rootfs et le paquet passaient par le magasin.** Wasm, BIOS, VGA BIOS, noyau et initrd
   étaient retéléchargés à chaque démarrage : sans eux, pas de hors ligne.

Cet ADR décide comment le hors ligne devient possible sans donner à l'OPFS un pouvoir qu'il n'a pas.

## Décisions

### 1. Le descripteur rangé est SCELLÉ, sous une clé du coffre, dans un domaine dédié

HMAC-SHA-256, sous une clé **dérivée de la clé du coffre** par HKDF-SHA-256, **non extractible**
(`sign` et `verify` seulement), **jamais la DEK directement**
(`src/vm/derivation/cle-du-descripteur-scelle.mjs`).

```text
info = LP("railsbox-vault/derivation-de-domaine/v1")   le schéma de l'ADR 0033, inchangé
     ‖ LP("descripteur")                               le domaine
     ‖ LP(identifiantVolume)                           IDENTIFIANT_DU_COFFRE, 32 hexadécimaux
     ‖ U32BE(1)                                        la version du FORMAT du descripteur scellé
     ‖ LP("hmac-sha-256")                              l'algorithme
sel  = chaîne vide                                     RFC 5869 § 2.2 : la clé est la même d'une
                                                       écriture à l'autre, sans quoi le fichier
                                                       rangé hier ne se vérifierait pas aujourd'hui
```

**Pourquoi un domaine hors de la liste de l'ADR 0033.** Cette liste est close parce que chacun de
ses six domaines porte un **budget de clé** : les nonces d'AES-GCM (ADR 0015). Un HMAC n'a pas de
nonce, il est déterministe : lui donner un septième rang dans la liste ferait compter un compteur
qui n'existe pas, et ferait bouger les vecteurs et les épreuves de budget sans rien prouver. Le
domaine `descripteur` emploie donc le MÊME mécanisme (même schéma d'info, même HKDF, même
non-extractibilité) dans son propre module. La séparation avec les clés AEAD tient à trois
différences indépendantes : le champ de domaine de l'info, son champ d'algorithme, et le type de la
clé importée (HMAC, qui ne chiffre pas). Un vecteur, calculé par `node:crypto` avec une info écrite
à la main, la fige (`tests/unit/vm-cle-du-descripteur-scelle.test.mjs`).

**L'identifiant** est `IDENTIFIANT_DU_COFFRE`, constante partagée par tous les coffres : ce qui
sépare deux coffres est la CLÉ (tirée par coffre), pas l'identifiant (ADR 0039). Un descripteur
scellé par un autre coffre est donc refusé par son sceau.

### 2. Le format persistant, version 1 (`src/coquille/descripteur-scelle.mjs`)

Fichier `vault-artefacts/descripteur.scelle`, gros-boutiste :

| offset | taille | champ                                                                                  |
| -----: | -----: | -------------------------------------------------------------------------------------- |
|      0 |      8 | magie `VLTDSC01` (ASCII) — « 01 » est la version du format                             |
|      8 |      8 | `rangeLe` : U64, millisecondes Unix — la date de la dernière vérification              |
|     16 |      4 | longueur `L` de la charge, U32, au plus 1 Mio                                          |
|     20 |    `L` | charge : JSON UTF-8 `{ "descripteur": …, "manifesteV86": … }`                          |
|   20+L |     32 | sceau : HMAC-SHA-256( LP(`railsbox-vault/descripteur-scelle/v1`) ‖ octets[0 .. 20+L) ) |

- **Données authentifiées : tout ce qui précède le sceau** — la magie (donc la version), la date, la
  longueur, la charge —, sous une étiquette de domaine propre au scellement. Rien n'est lu comme
  décision avant la vérification, sauf la longueur, qui n'est jamais crue au-delà de la taille du
  fichier : elle doit en être exactement le complément, et au plus 1 Mio.
- **Aucune canonicalisation** : les octets scellés sont ceux du JSON écrit au scellement, jamais
  re-sérialisés à la vérification.
- **La charge** : le descripteur applicatif ACQUIS (celui dont le boot vient de lire tous les
  artefacts, `descripteurDuPaquet` appliqué — donc le paquet précédent quand « Plus tard » a démarré
  l'ancienne version) et le **manifeste v86 réduit** (`{ artifacts: [{ name, bytes, sha256 }] }`) :
  les adresses et empreintes du wasm et de `libv86` que le boot ne peut pas relire hors connexion.
- **La vérification** : forme du fichier → sceau (`crypto.subtle.verify`, temps constant) → lecture
  du JSON → `formeDuDescripteur` et forme du manifeste v86. **Le sceau dit QUI a écrit, pas que le
  contenu est sain** : un contenu de forme refusée est refusé même sous un sceau juste (raison
  `contenu`).
- **Refus typé** : `VAULT_COQUILLE_HORS_LIGNE_DESCRIPTEUR_REFUSE`, avec une raison fermée —
  `format`, `sceau`, `contenu` — **journalisée, jamais montrée**. Le refus ne porte ni clé ni
  contenu.
- **Un fichier d'une autre version, ou non scellé** (le JSON servi, tel quel ; une magie `VLTDSC00`,
  `VLTDSC02`, autre) est **REFUSÉ** (`format`), jamais lu « au mieux », jamais accepté. Aucun
  fichier de cette sorte n'a existé avant ce lot (le hors ligne n'était pas implémenté) ; la règle
  vaut pour la suite : une version 2 du format changera la magie, et un lecteur v2 décidera
  explicitement s'il lit la v1 — il n'y a pas de migration silencieuse. Un fichier refusé est
  remplacé par le démarrage EN LIGNE suivant.
- **Écriture** : sous `descripteur.scelle.partiel`, écrite ENTIÈRE, puis le nom définitif est
  remplacé (suppression de l'ancien, renommage). Les primitives n'ont pas de troncature ; une
  coupure entre les deux laisse « aucun descripteur » — jamais un fichier à moitié neuf, que le
  sceau refuserait de toute façon. La purge du magasin ne retire jamais ce nom.

### 3. « Injoignable » = un `TypeError` levé par `fetch` sur le descripteur, et rien d'autre

Un délai (`AbortError`), une réponse HTTP — **5xx comprise** —, un descripteur différent, du HTML de
portail captif (JSON illisible) : la décision de l'ADR 0042 s'applique, l'origine fait foi, et le
descripteur rangé **n'est même pas lu** ni la clé du coffre demandée. Une origine qui répond mal ne
donne à personne un droit au repli : sans cela, une réponse d'erreur forgée suffirait à faire
démarrer l'ancien code.

### 4. Anti-retour : le rangé repasse par la décision de déphasage

Le descripteur rangé est traité comme un descripteur servi par `deciderLeDephasage` : une version
**antérieure** à celle déjà migrée dans le volume est refusée (`APPLICATION_ANTERIEURE`), même à
schéma égal (garde de l'ADR 0042). Sa date est publiée (`horsConnexion: { rangeLe, version }`) pour
que la personne lise « hors connexion, version du <date> » (affichage : dernier commit du lot, après
la fusion du lot B2). **Pas de durée maximale** avant la signature des paquets (jalon 6) : limite
écrite (§ « Ce qui n'est pas protégé »).

**Sans volume, pas de hors ligne** : si le coffre n'a pas de volume `application`, installer demande
la graine, que le magasin ne garde pas, et la garde « pas antérieur à la version migrée » n'a rien à
comparer. Refus typé `HORS_LIGNE_SANS_COFFRE`.

### 5. Le descripteur n'est rangé qu'après une acquisition complète — et que si la réserve la tient

Le rangement a lieu dans le crochet `avantLeBoot`, une fois le runtime acquis ET vérifié, **avant**
l'inscription de l'intention de migrer. Il n'a lieu que si la réserve tient TOUT ce que le boot a lu
: les cinq petits artefacts, le rootfs et le paquet, chacun « servi » ou « admis »
(`reserveTientTout`). Sinon — pas d'empreinte épinglée, budget refusé, OPFS absent —, **le
descripteur précédent est oublié** : il promettrait un démarrage hors connexion que la réserve ne
tient plus (la rétention retire les artefacts d'une autre version). Un rangement manqué ne fait
jamais échouer un boot : il coûte le hors ligne. Hors connexion, rien n'est re-rangé : il vient
d'être lu.

### 6. Les artefacts du démarrage passent par le magasin, épinglés — avec une limite sur `libv86`

- **wasm, BIOS, VGA BIOS, noyau, initrd** : servis par le magasin s'ils y sont et vérifiés (chemin
  lent : `sha256` du fichier entier, une seule tranche), sinon téléchargés, **confrontés à leur
  empreinte et à leur taille épinglées**, puis rangés. L'épingle du wasm vient du manifeste v86,
  celles des quatre autres du descripteur : `boot.empreintes: { kernel, initrd, bios, vgaBios }`,
  chacune `{ sha256, octets }`, **facultatif et tout-ou-rien**, ajouté par `image:manifest` (un
  champ de plus au descripteur v2, sans changer sa version : un descripteur sans ce bloc reste
  lisible, sans hors ligne). Hors connexion, un artefact absent, altéré ou sans épingle est un refus
  typé (`HORS_LIGNE_ARTEFACT_ABSENT`) : **rien n'est téléchargé**. Retenue : les cinq courants sont
  gardés par la rétention, et `descripteur.scelle` n'est jamais purgé.
- **`libv86` NE passe PAS par le magasin — écart à la décision n° 1 du superviseur, à trancher.** Un
  module ES ne s'exécute pas depuis l'OPFS sous la CSP du Worker :
  `script-src 'self' 'wasm-unsafe-eval'` (ni `blob:`, ni `unsafe-eval` ; ADR 0013 refuse d'y ajouter
  `blob:`). Le ranger au magasin n'aurait servi à rien. Il est chargé par `import()`, donc par le
  **cache HTTP** du navigateur — adressé par empreinte, `immutable` (ADR 0023), comme tout le code
  de la coquille. Hors connexion, ses octets sont lus du cache (`force-cache`), vérifiés contre le
  manifeste scellé, puis importés ; absent du cache, refus typé. **Conséquence : le hors ligne
  dépend du cache HTTP du navigateur pour `libv86`, non garanti** (éviction possible). Deux voies
  s'ouvrent et ne sont pas prises ici : un Service Worker qui sert la réserve (surface de confiance
  neuve, ADR propre), ou l'élargissement de la CSP (refusé par l'ADR 0013).

### 7. Ce que la personne voit

La coquille publie `horsConnexion: { rangeLe, version }` dans le constat de la page et dans le
compte rendu du démarrage (`null` quand l'origine a répondu). Les quatre codes de refus ont leur
conduite en langage humain (`conduites-du-dephasage.mjs`), enregistrés dans le registre des codes et
la spécification (§ 10 de `docs/format-de-volume-v3.md`).

## Modèle d'adversaire

**Adversaire A — écrit dans l'OPFS de l'origine de confiance, SANS la clé du coffre** (extension
hostile sur la même origine, bogue d'un autre module, outil local). Il **ne peut ni fabriquer, ni
modifier un descripteur accepté** : le sceau couvre tout. Il peut supprimer le fichier (déni du hors
ligne, pas de démarrage) ou **rejouer un descripteur scellé plus ancien** : voir ci-dessous.

**Adversaire B — contrôle le réseau.** Il peut rendre l'origine injoignable (`TypeError`) : le hors
ligne s'ouvre, sur la dernière version vérifiée — le **gel de version**. Il ne peut pas l'ouvrir par
une réponse (5xx, portail captif, timeout) : ces cas relèvent de l'ADR 0042.

**Adversaire C — contrôle l'origine** : hors de la portée de cet ADR, comme de l'ADR 0042. Seule la
signature des paquets (jalon 6, TUF 1.0.x : version monotone, `expires`) y répondra.

## Ce qui n'est pas protégé

- **Le gel de version.** Une révocation, un correctif de sécurité publiés pendant la coupure ne sont
  pas vus. **Aucune durée maximale** avant le jalon 6 : une date d'expiration non signée ne protège
  de rien (ADR 0042 § « écarté »). La date affichée dit l'âge, elle ne l'impose pas.
- **Le rejeu d'un ancien descripteur scellé VALIDE** (adversaire A, ayant copié le fichier plus tôt)
  : il est accepté s'il n'est pas antérieur à la version du volume. Sa date n'est pas une garantie :
  elle est authentifiée, mais rejouable. Si la version est la même, c'est la même application ; si
  elle est plus récente que le volume, la décision propose une mise à jour dont les artefacts sont
  ceux de la réserve, vérifiés un à un.
- **Le retour arrière COMPLET de l'OPFS ET du volume ensemble** (restauration d'un instantané disque
  du profil) : le volume recule avec le descripteur, l'anti-retour n'a plus de référence. L'ancrage
  monotone est la question n° 3 de l'ADR 0033 (#23), non traitée ici.
- **L'adversaire qui détient la clé du coffre** (donc le coffre ouvert) peut sceller ce qu'il veut :
  c'est inhérent, la clé sert à ouvrir le coffre.
- **`libv86` et le code de la coquille** viennent du cache HTTP ou du réseau (§ 6) : la page ne se
  recharge pas hors connexion sans Service Worker, ce qui n'est pas l'objet de cette tranche.
- **La date `rangeLe` vient de l'horloge de l'appareil** : informative, jamais utilisée pour
  décider.
- **Le stockage** : le descripteur rangé, le manifeste v86 et les noms d'artefacts ne sont pas des
  secrets (ils viennent d'un fichier public) ; le sceau ne chiffre rien.

## Ce qui est écarté, et pourquoi

- **Un septième domaine AEAD dans la liste de l'ADR 0033** : budget de nonces sans objet pour un
  HMAC.
- **Un sel tiré, écrit en clair dans le fichier** (le régime « usage unique ») : une clé neuve par
  écriture n'apporterait rien contre le rejeu et ajouterait un champ à authentifier.
- **Une durée maximale du hors ligne** : sans signature, elle ne protège de rien (ADR 0042).
- **Authentifier par le `sha256` du descripteur** : l'empreinte du descripteur ne vient que de
  lui-même.
- **Ranger `libv86` au magasin** : inexécutable sous la CSP (§ 6).

## Preuves

- **Unitaires** (Node) : `vm-cle-du-descripteur-scelle` (vecteur `node:crypto`, séparation),
  `coquille-descripteur-scelle` (format, un octet changé n'importe où, fabriqué, autre coffre, non
  scellé, autre magie sous sceau juste, charge démesurée, date hors entier sûr),
  `coquille-hors-connexion` (« injoignable » = `TypeError`, HTTP 500/503/404, portail captif, délai
  : aucun repli ; anti-retour ; rangement), `coquille-demarrage-hors-connexion` et
  `coquille-preparation-du-demarrage` (ordre des refus avant tout boot),
  `vm-acquisition-des-petits-artefacts` et `vm-acquisition-disque-systeme` (hors connexion : fetch
  jamais appelé), `coquille-empreintes-du-boot`.
- **Mutation** : la campagne `hors-ligne` (`tools/muter-gardes-hors-ligne.mjs`) tient 53 gardes, 53
  tuées ; la campagne `magasin` en tient 20, 20 tuées (dont les restes de la revue de #292 : jeton
  d'annulation de `retenir`, `.partiel` orphelin, jeton testé avant `renommer`). Les deux sont dans
  le job requis « Campagnes de mutation ».
- **Intégration navigateur, trois moteurs** : `tests/browser/descripteur-scelle.spec.mjs` — le HMAC
  non extractible sur le vrai WebCrypto, le descripteur rangé et relu dans le vrai OPFS, remplacé
  sans reste, altéré refusé.
- **Bout en bout** : `tests/e2e/hors-ligne.spec.mjs` — réseau coupé, démarrage depuis la réserve,
  aucune réponse pour l'image ; descripteur altéré, HTTP 500 et portail captif sans repli. **Non
  exécuté dans cette session** : l'image de référence n'est pas fabriquée dans le sandbox de
  l'agent, et la fabrication en CI est réparée par un autre lot (CI-0).

## Ce qui n'est pas prouvé

- Le démarrage hors connexion **sur l'image réelle** (E2E ci-dessus) : écrit, relu, non exécuté.
- Le comportement sous **WebKit** de l'épreuve d'intégration : non exécutable dans le sandbox de
  l'agent (dépendances système) ; Chromium et Firefox, oui.
- **Que `libv86` reste dans le cache HTTP** hors connexion, sur chaque moteur : non mesuré.
- Le **coût** des empreintes de cinq artefacts de plus au premier démarrage, et la taille du magasin
  : non mesurés (image absente). `docs/quality-attributes.md` garde « non mesuré ».
- Le retour arrière (rangé antérieur au volume) **sur l'image réelle** : prouvé au niveau unitaire
  par la vraie décision de déphasage, pas en bout en bout.
