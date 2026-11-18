# ADR 0046 — Le descripteur scellé et le démarrage hors connexion

- Statut : **proposé** — format persistant et cryptographie : la fusion attend l'accord du
  propriétaire, et une revue de sécurité distincte
- Date : 2026-11-17 · amendé le 2026-11-18 (revue de sécurité de #298 : redirections, empreintes du
  boot obligatoires, `libv86`, annulation)
- Numéro : 0046 — le 0045 est pris par le lot CI-0 (#296)
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
  coupure entre les deux laisse « aucun descripteur ». Le renommage n'est atomique que si l'OPFS
  offre `move` ; à défaut (`magasin-opfs.mjs`), le fichier est COPIÉ puis l'ancien supprimé, et une
  coupure pendant la copie peut laisser un fichier incomplet : la garantie n'est pas l'atomicité,
  c'est que le sceau — vérifié avant toute lecture du contenu — **refuse un fichier incomplet ou
  altéré**, quel qu'en soit le motif. La purge du magasin ne retire jamais ce nom.

### 3. « Injoignable » = un `TypeError` levé par `fetch` sur le descripteur, et rien d'autre

Un délai (`AbortError`), une réponse HTTP — **5xx comprise** —, un descripteur différent, du HTML de
portail captif (JSON illisible) : la décision de l'ADR 0042 s'applique, l'origine fait foi, et le
descripteur rangé **n'est même pas lu** ni la clé du coffre demandée. Une origine qui répond mal ne
donne à personne un droit au repli : sans cela, une réponse d'erreur forgée suffirait à faire
démarrer l'ancien code.

**Une redirection est une réponse de l'origine** (amendement du 18/11, constat 1 de la revue de
#298). `fetch` suit les redirections par défaut, et une BOUCLE de redirections lève un `TypeError` —
le même signal que « pas de réseau » : une origine qui répondait par une boucle de 302 ouvrait le
repli. Le descripteur est donc demandé en `redirect: "manual"` : toute redirection (statut 3xx côté
Node, `opaqueredirect` de statut 0 côté navigateur) est classée « descripteur redirigé », **jamais
suivie** — un 301 vers une autre origine n'est plus lu —, et n'ouvre pas le repli. Conséquence
assumée : le descripteur doit être servi à son adresse, sans redirection ; un hébergement qui
redirige `/artifacts/application.json` est, pour la coquille, une origine sans application. Mesuré
avec un vrai serveur sur Chromium, Firefox et WebKit.

### 4. Anti-retour : le rangé repasse par la décision de déphasage

Le descripteur rangé est traité comme un descripteur servi par `deciderLeDephasage` : une version
**antérieure** à celle déjà migrée dans le volume est refusée (`APPLICATION_ANTERIEURE`), même à
schéma égal (garde de l'ADR 0042). Sa date est publiée (`horsConnexion: { rangeLe, version }`) pour
que la personne lise « Hors connexion, version du <date> » (§ 7). **Pas de durée maximale** avant la
signature des paquets (jalon 6) : limite écrite (§ « Ce qui n'est pas protégé »).

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

### 6. Les artefacts du démarrage passent par le magasin, épinglés — `libv86` a la confiance de l'origine

**Invariant : aucun octet n'atteint le guest sans empreinte épinglée** (amendement du 18/11, constat
2 de la revue de #298).

- **wasm, BIOS, VGA BIOS, noyau, initrd** : servis par le magasin s'ils y sont et vérifiés (chemin
  lent : `sha256` du fichier entier, une seule tranche), sinon téléchargés, **confrontés à leur
  empreinte et à leur taille épinglées**, puis rangés. L'épingle du wasm vient du manifeste v86,
  celles des quatre autres du descripteur : `boot.empreintes: { kernel, initrd, bios, vgaBios }`,
  chacune `{ sha256, octets }`.
- **Changement de format du descripteur servi.** `boot.empreintes` est **OBLIGATOIRE** et
  tout-ou-rien. Un descripteur qui n'en porte pas n'est pas une application : `formeDuDescripteur`
  le refuse (« empreintes du boot absentes »), avant tout boot, en ligne comme à la réouverture d'un
  descripteur scellé (la forme est rejouée : un descripteur scellé avant cette règle est refusé sur
  son contenu, et remplacé par le démarrage en ligne suivant). `image:manifest` les produit TOUJOURS
  : un manifeste d'image qui ne décrit pas l'un des quatre artefacts fait échouer la fabrication au
  lieu de produire un descripteur dégradé. **`descripteurVersion` passe à 3** (revue du second tour
  de #298, constat 1). Garder le numéro 2 laissait un ancien lecteur — un onglet resté ouvert, une
  coquille en cache — accepter le nouveau descripteur en ignorant `boot.empreintes`, donc démarrer
  sans la vérification que le contrat exige : « le descripteur et la coquille partent ensemble » ne
  démontre pas que les anciens lecteurs ont disparu. Le lecteur de `86ae8dc` (celui de `main` avant
  cette PR) refuse une v3 par `version de descripteur inconnue : 3` — aucune application n'est
  démarrée —, et le nouveau lecteur ne lit QUE la v3 : la v2 est refusée de la même façon
  (`version de descripteur inconnue : 2`), même complète.
  `tests/unit/coquille-compatibilite-ancien-lecteur.test.mjs` importe l'ancien lecteur tel quel
  (`tests/support/lecteur-de-main-86ae8dc/`) et éprouve les deux sens ; deux mutants gardent le
  numéro (lecteur et fabrication). **Ce que devient un descripteur v2 rangé et scellé avant la
  règle** : le sceau porte la v2, l'ouverture rejoue `formeDuDescripteur` et le refuse sur son
  contenu (`HORS_LIGNE_DESCRIPTEUR_REFUSE`, raison `contenu`), sans repli ; le démarrage en ligne
  suivant range un v3. Aucun fichier de cette sorte n'existe hors développement : le hors ligne
  n'était pas implémenté avant la PR. Un retour arrière (revert) rend à l'ancien lecteur son
  descripteur v2 : l'origine doit servir celui d'avant, ce que la publication fait avec le code.
- **Défense en profondeur** : `acquerirLesPetitsArtefacts` refuse AVANT tout téléchargement une
  épingle absente (`null` ou clé manquante) — y compris celle du wasm, qui ne se trouverait pas au
  manifeste v86 —, quel que soit l'appelant : les bancs de bout en bout reçoivent leurs empreintes
  du manifeste d'image (`tests/support/image-de-reference.mjs`). Hors connexion, ce refus est le
  code typé `HORS_LIGNE_ARTEFACT_ABSENT` ; en ligne, une erreur d'acquisition marquée, comme un
  artefact altéré. Hors connexion, un artefact absent ou altéré est un refus typé : **rien n'est
  téléchargé**. Retenue : les cinq courants sont gardés par la rétention, et `descripteur.scelle`
  n'est jamais purgé.
- **`libv86` NE passe PAS par le magasin, et ses octets ne sont PAS liés à ce qui s'exécute.** Un
  module ES ne s'exécute pas depuis l'OPFS sous la CSP du Worker :
  `script-src 'self' 'wasm-unsafe-eval'` (ni `blob:`, ni `unsafe-eval` ; ADR 0013 refuse d'y ajouter
  `blob:`). Il est chargé par `import()`, donc par le cache HTTP du navigateur — adressé par
  empreinte, `immutable` (ADR 0023), comme tout le code de la coquille. Le produit le hachait par un
  `fetch`, puis l'important par une SECONDE requête : **rien ne liait les deux**. Le spike
  `tools/spike-liaison-libv86.mjs` (mesuré le 18/11/2026 sur Chromium 151, Firefox 153, WebKit 26.5)
  a cherché un mécanisme qui lie les octets, dans un Worker module sous la CSP de la coquille :

  | essai                                                                                                                      | Chromium                                     | Firefox                        | WebKit                                     |
  | -------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------ | ------------------------------------------ |
  | E1 `fetch(url, {integrity})` puis `import(url)`, origine qui répond « bon » au fetch et « mauvais » à l'import, sans cache | exécute « mauvais »                          | exécute « mauvais »            | exécute « mauvais »                        |
  | E1 idem avec les en-têtes du produit (`immutable`)                                                                         | exécute « bon » (cache partagé, non garanti) | idem                           | exécute « mauvais » (pas de cache partagé) |
  | E2 `import(url, { with: { integrity } })`                                                                                  | refusé : clé inconnue                        | refusé : attribut non supporté | refusé : attribut non supporté             |
  | E3a carte d'import avec `integrity`, dans un Worker                                                                        | inexistante (spécificateur nu non résolu)    | idem                           | idem                                       |
  | E3b carte d'import avec `integrity`, dans une fenêtre                                                                      | vérifie (refuse l'écart)                     | vérifie                        | vérifie                                    |
  | E4 `cache: "only-if-cached"` sur une adresse jamais chargée                                                                | échoue, 0 requête                            | échoue, 0 requête              | **IGNORÉ : 200 par le réseau, 1 requête**  |
  | E4 `cache: "force-cache"` sur une adresse jamais chargée                                                                   | **va au réseau** (1 requête)                 | idem                           | idem                                       |
  | E5 `only-if-cached` d'un module déjà importé, Worker neuf                                                                  | 200, 0 requête                               | 200, 0 requête                 | 200 mais **réseau touché**                 |

  **Aucun mécanisme ne lie les octets sous la CSP actuelle.** La seule liaison existante (E3b, la
  carte d'import avec `integrity`) vit dans la FENÊTRE, où `libv86` ne tourne pas : l'émulateur
  s'exécute dans un Worker — un Worker n'a pas de carte d'import, et rien n'est hérité de la page.
  Les autres voies (`blob:`, `data:`, `eval`, `new Function`) sont refusées par la CSP ; un Service
  Worker est exclu de cette session. **`libv86` a donc la confiance de l'origine, comme tout le code
  de la coquille** : la confrontation de ses octets au manifeste qui précède l'import — conservée,
  elle vient de #123 — est une défense contre l'ACCIDENT (un cache qui garde une version à côté du
  manifeste d'une autre, un octet retourné), **pas une liaison, et elle ne prouve pas ce qui
  s'exécute**. Une origine hostile qui répond autrement à `import()` qu'à `fetch` l'emporte (E1).
  Hors connexion, `libv86` est lu du cache HTTP en `only-if-cached` (jamais `force-cache`, qui va au
  réseau sur un cache vide — E4), confronté au manifeste scellé, puis importé ; absent du cache,
  refus typé. **WebKit ignore `only-if-cached`** : « ne touche jamais le réseau » n'est établi que
  sur Chromium et Firefox ; hors connexion réelle, la requête de WebKit échoue et le refus typé est
  le même. **Conséquence : le hors ligne dépend du cache HTTP du navigateur pour `libv86`, non
  garanti** (éviction possible). La décision — accepter, ou payer une liaison (Service Worker, CSP
  élargie, émulateur en fenêtre) — revient au propriétaire : options, coût et frontière touchée dans
  #299.

**Constat de l'E2E sur l'image réelle (lot 5, 18/11/2026) : le démarrage hors connexion n'a pas lieu
avec les en-têtes de production.** Le code de la coquille est servi `no-cache` (ADR 0023) : un
Worker NEUF, créé réseau coupé, ne peut pas importer ses modules (`/src/vm/boot-de-reference.mjs`),
et le démarrage échoue en `VAULT_COQUILLE_GESTE_ROMPU` — avant de lire la réserve. C'est la moitié «
code de la coquille » de #299, plus dure que « non garantie » : **tant que le code n'est pas servi
avec une fraîcheur, ou par un Service Worker, il n'y a pas de démarrage hors connexion en
production.** Cette tranche livre la DÉCISION (repli sur le descripteur scellé, lecture de la
réserve, refus typés) ; la condition qu'elle suppose — le code de la coquille disponible sans réseau
— relève de #299. L'E2E la modélise par un harnais : `VAULT_E2E_CODE_MAX_AGE` (`tools/serve.mjs`,
seul endroit où elle est lue) donne au code (hors `/artifacts/`, qui reste `no-cache` : c'est
l'origine « injoignable ») une fraîcheur, et le scénario l'exige en préalable. **Le harnais est
borné au banc** : il exige la variable ET le drapeau `--harnais-e2e-hors-ligne`, que seul
`playwright.e2e.config.mjs` passe au serveur de la coquille ; l'un sans l'autre, le serveur refuse
de démarrer (un `npm start` dont l'environnement porterait la variable ne change jamais d'en-têtes
en silence ; `tests/unit/serve-harnais-hors-ligne.test.mjs`). Avec lui, le scénario passe sur
l'image réelle : premier boot en ligne, redémarrage réseau coupé depuis la réserve sans un octet
d'image par le réseau, descripteur altéré / HTTP 500 / portail captif sans repli.

### 7. Ce que la personne voit

La coquille publie `horsConnexion: { rangeLe, version }` dans le constat de la page et dans le
compte rendu du démarrage (`null` quand l'origine a répondu) : la ligne de réussite dit alors « Hors
connexion, version du <date>. » (`texteDeDemarrage`, la date en toutes lettres, au fuseau de
l'appareil) — la date de la dernière vérification, qui dit l'âge de la version sans le borner ; une
date illisible est omise, jamais inventée. En ligne, la page ne parle pas de connexion. Le texte est
au registre des messages du parcours et à la relecture (`docs/parcours/relecture-p2.md`, régénérée).
Les quatre codes de refus ont leur conduite en langage humain (`conduites-du-dephasage.mjs`),
enregistrés dans le registre des codes et la spécification (§ 10 de `docs/format-de-volume-v3.md`).

### 8. L'annulation est tenue APRÈS CHAQUE ATTENTE (amendement du 18/11, constat 4 de la revue de #298)

Une opération du magasin qui dépasse son délai (20 s) est **abandonnée** : l'appelant a repris la
main — il télécharge, ou il range autre chose — et son jeton est annulé (`avantLEcheance`). Le jeton
n'était testé qu'AVANT certaines attentes : annulé PENDANT une suppression, une opération reprenait
et renommait quand même — remplaçant un descripteur plus récent — ou continuait des suppressions
après un seul contrôle.

**Règle** : le jeton est testé après chaque attente, avant tout geste qui modifie le magasin
(écriture, renommage, suppression). **Opérations en vol** : un appel de primitive déjà lancé — un
`move`, une suppression — va à son terme ; il n'est pas annulable, et rien ici ne le prétend. Ce qui
est garanti est qu'**aucun geste modificateur NE PART après l'annulation**, sauf le nettoyage de SON
propre partiel (`<sha256>.partiel`, `descripteur.scelle.partiel`). Concrètement : `oublier` teste le
jeton avant chacune de ses trois suppressions ; `admettre` après le budget (avant d'oublier
l'ancienne entrée), au début de chaque tranche, après chaque hachage de tranche (avant de l'écrire)
et après le hachage de la racine — et une admission abandonnée ne hache plus une tranche de plus ;
`ecrireLeDescripteurScelle` à l'entrée et après la suppression de l'ancien descripteur, avant de
renommer ; `servir`, `purger` et l'oubli du descripteur transmettent le jeton à `oublier`. Un
rangement abandonné après la suppression de l'ancien descripteur laisse « aucun descripteur » —
l'état sûr que ce module annonçait déjà pour une coupure.

**Collisions entre sessions.** Le nom d'un partiel est partagé : deux onglets qui admettent la même
empreinte, ou une opération abandonnée suivie d'une nouvelle sur la même empreinte, écrivent sous le
même `<sha256>.partiel`. Le nettoyage tardif d'une opération abandonnée peut donc retirer le partiel
d'une plus récente ; une écriture concurrente peut échouer sur la poignée exclusive de l'OPFS. Le
pire est un téléchargement de plus : jamais un octet servi non vérifié, puisque `servir` revérifie
tout. Des noms de partiel uniques par opération élimineraient la collision ; ils compliquent la
purge (retrouver les partiels d'une empreinte) et ne sont pas pris ici. La rétention (`retenir`) a
le même régime : jeton testé avant chaque geste visible.

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
- **`libv86` et le code de la coquille** viennent du cache HTTP ou du réseau (§ 6) : **leurs octets
  ne sont pas liés à ce qui s'exécute** — `libv86` a la confiance de l'origine, comme tout le code
  de la coquille. La page ne se recharge pas hors connexion sans Service Worker, ce qui n'est pas
  l'objet de cette tranche.
- **Les redirections ne sont pas suivies** (§ 3) : un hébergement qui redirige le descripteur est
  une origine sans application.
- **Une opération du magasin déjà lancée n'est pas annulable** (§ 8) ; les partiels portent un nom
  partagé entre sessions.
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
- **Présenter la confrontation de `libv86` comme une vérification de ce qui s'exécute** : le spike
  (§ 6) n'a trouvé aucun mécanisme qui lie les octets dans un Worker sous cette CSP.
- **`redirect: "error"`** pour les redirections : il lève un `TypeError`, indiscernable d'un réseau
  coupé — exactement le défaut. `manual` rend une réponse que l'on peut classer.
- **Vérifier les octets de boot contre `vendor/v86/artefacts/MANIFEST-*.json`** : ce manifeste ne
  décrit que les artefacts v86 (`libv86`, wasm, BIOS, Linux d'essai), pas le noyau ni l'initrd de
  l'image de référence ; l'obligation d'un `boot.empreintes` dans le descripteur est la seule source
  commune aux quatre.

## Preuves

- **Unitaires** (Node) : `vm-cle-du-descripteur-scelle` (vecteur `node:crypto`, séparation),
  `coquille-descripteur-scelle` (format, un octet changé n'importe où, fabriqué, autre coffre, non
  scellé, autre magie sous sceau juste, charge démesurée, date hors entier sûr),
  `coquille-hors-connexion` (« injoignable » = `TypeError`, HTTP 500/503/404, portail captif, délai
  : aucun repli ; anti-retour ; rangement), `coquille-demarrage-hors-connexion` et
  `coquille-preparation-du-demarrage` (ordre des refus avant tout boot),
  `vm-acquisition-des-petits-artefacts` et `vm-acquisition-disque-systeme` (hors connexion : fetch
  jamais appelé), `coquille-empreintes-du-boot`.
- **Mutation** (rejouée le 18/11/2026) : la campagne `hors-ligne`
  (`tools/muter-gardes-hors-ligne.mjs`) tient 69 gardes, 69 tuées ; la campagne `magasin` en tient
  32, 32 tuées (dont les restes de la revue de #292 et le jeton testé après chaque attente, § 8).
  Les deux sont dans le job requis « Campagnes de mutation ».
- **Intégration navigateur, trois moteurs** (Chromium, Firefox et WebKit exécutés le 18/11/2026) :
  `tests/browser/descripteur-scelle.spec.mjs` — le HMAC non extractible sur le vrai WebCrypto, le
  descripteur rangé et relu dans le vrai OPFS, remplacé sans reste, altéré refusé ; avec un VRAI
  serveur : boucle de 302, 301 inter-origines et connexion refusée (§ 3), lecture de `libv86` sans
  requête sur cache vide (§ 6 ; WebKit : une requête, limite mesurée).
- **Spike** : `node tools/spike-liaison-libv86.mjs` rejoue la mesure du § 6 sur les trois moteurs.
- **Bout en bout** : `tests/e2e/hors-ligne.spec.mjs` — réseau coupé, démarrage depuis la réserve,
  aucune réponse pour l'image ; descripteur altéré, HTTP 500 et portail captif sans repli. **Non
  exécuté dans cette session** : l'image de référence n'est pas fabriquée dans le sandbox de
  l'agent, et la fabrication en CI est réparée par un autre lot (CI-0).

## Ce qui n'est pas prouvé

- Le démarrage hors connexion **sur l'image réelle** (E2E ci-dessus) : écrit, relu, non exécuté.
- **Que `libv86` reste dans le cache HTTP** hors connexion en conditions réelles (éviction) : non
  mesuré ; le spike montre la lecture du cache après un `import()` sur les trois moteurs, pas sa
  durée de vie.
- **Un `move` déjà lancé** n'est pas annulable (§ 8) ; collisions de partiels entre onglets :
  écrites, non éprouvées avec deux vrais onglets.
- Le **coût** des empreintes de cinq artefacts de plus au premier démarrage, et la taille du magasin
  : non mesurés (image absente). `docs/quality-attributes.md` garde « non mesuré ».
- Le retour arrière (rangé antérieur au volume) **sur l'image réelle** : prouvé au niveau unitaire
  par la vraie décision de déphasage, pas en bout en bout.
