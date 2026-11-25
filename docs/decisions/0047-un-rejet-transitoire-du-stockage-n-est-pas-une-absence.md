# ADR 0047 — Un rejet « transitoire » du stockage n'est pas une absence : état et refus indéterminés, réessayables

- Statut : accepté
- Date : 2026-11-18
- Issues : #231 · revue de la PR #305 (trois refus, 18/11/2026) · suite : #306, #309
- Amende : la décision 6 de l'[ADR 0029](0029-deverrouillage-dans-la-coquille.md) (le DÉTECTEUR de
  l'absence d'OPFS) ; complète l'[ADR 0028](0028-coquille-de-produit-et-frontiere.md) (les états que
  la coquille publie : quatre deviennent cinq)

## Contexte

Depuis WebKit 26.6, `navigator.storage.getDirectory` est une fonction, et son appel **rejette**
`UnknownError` dans un contexte éphémère, page comme Worker. Mesuré le 18/11/2026 sous Playwright
1.63.0 (WebKit 26.6), 1.64.0 et 1.65.0 (WebKit 27.2) ; nom `UnknownError`, message « The operation
failed for an unknown transient reason (e.g. out of memory). », rejet immédiat (0 à 1 ms), constant
(8 essais sur 8, étalés sur 800 ms). Le produit ne testait que `typeof` : la coquille passait en
`erreur` (76 épreuves WebKit rouges, #231).

Une première correction rangeait ce rejet sous `VAULT_STORAGE_UNSUPPORTED` et l'état `indisponible`.
La revue l'a refusée, à raison : le **message du moteur parle d'une raison transitoire** ; il ne
permet pas de distinguer le contexte éphémère d'une vraie panne d'un contexte persistant. L'affirmer
« absent » figeait `PEUT_OUVRIR` à faux pour la session et faisait dire au geste « Ce navigateur
n'offre pas… », avec le conseil de changer de navigateur : une affirmation que rien ne prouve.

## Décision

1. **La sonde réessaie un nombre borné de fois** (`src/vm/sonde-du-stockage.mjs`) :
   `ESSAIS_DE_LA_SONDE = 3`, `DELAI_ENTRE_ESSAIS_MS = 100`, pas de délai après le dernier essai.
   Coût MESURÉ dans le cas éphémère : chaque appel rend en 0 à 1 ms, le coût est donc le seul délai,
   **200 ms** au démarrage, une fois. Une réussite, à n'importe quel essai, rend `atteignable` :
   rien n'est figé.
2. **Trois verdicts, et une panne.** `absente` : la fonction manque, ou un refus de capacité DÉJÀ
   rangé `unsupported` par la table de `opfs-error-mapping.mjs` (`SecurityError`,
   `TypeMismatchError`) — seule absence établie. `indetermine` : `UnknownError` persistant après les
   essais — **jamais « absente »**. `panne` : tout autre rejet (quota, état invalide, erreur
   inconnue) : ni absence ni indétermination, un échec que le vrai geste signale sous son code
   précis.
3. **La capacité est une machine explicite, non un booléen**
   (`src/coquille/capacite-du-stockage.mjs`) : `inconnu` → `disponible` | `indetermine` | `absent` |
   `panne:<code>`. Seules les transitions écrites existent, toute autre lève : `absent` est terminal
   (une absence établie ne se resonde pas), `disponible` n'est pas resondé par la sonde (mais voir 5
   ter), `indetermine` et `panne` sont **réessayables** et peuvent mener à tout état. Une première
   rédaction retombait à `stockageIndetermine = false` sur la première panne rencontrée au réessai,
   sans rétablir la capacité : « trois `UnknownError`, puis `QuotaExceededError` » rendait
   `VAULT_STORAGE_UNSUPPORTED` et plus aucune sonde ne partait (revue de la PR #305). **L'état
   publié** : `verrouille` pour `disponible`, `indisponible` pour `absent`, et **`indetermine`**
   (cinquième état) pour `indetermine` ET `panne` — pour la personne, le stockage ne répond pas pour
   l'instant ; le refus d'un geste dit le détail. La mort du Worker et le verrouillage conservent
   `indisponible` et `indetermine`.
4. **Un code de refus neuf, `VAULT_STORAGE_INDETERMINE`**, inscrit au registre des codes du stockage
   (`src/vm/storage-errors.mjs`, § 10.2 de `docs/format-de-volume-v3.md`) et à la table des
   conduites du parcours (`CONDUITES`, classe `recommencer`, cliquet
   `coquille-parcours-conduites.test.mjs`), avec le texte exact : « Le stockage du navigateur est
   inaccessible pour l'instant, cause non établie. Rien n'a été tenté sur le coffre : réessayez dans
   un instant. Si cela dure, essayez une autre fenêtre ou un autre navigateur. Rien n'a été perdu. »
   Il n'affirme aucune absence, n'envoie pas au changement de navigateur d'emblée, et dit que rien
   n'a été tenté. Distinct de `unsupported` (absence) et de `supportFailure` (échec d'une opération
   sur un volume atteint). § 10.5 (famille de la COQUILLE, `VAULT_COQUILLE_*`) n'est pas touchée :
   le code est du stockage.
5. **Rien n'est figé : un geste, ou une demande d'inventaire, lève l'indétermination sans
   rechargement.** Tout message du canal privilégié autre que l'état, reçu tant que la capacité est
   réessayable, relance la sonde (une seule à la fois). Si elle aboutit, l'état redevient
   `verrouille` et le message suit son cours ; sinon le geste reçoit `VAULT_STORAGE_INDETERMINE` —
   ou, après une panne, SON code précis (`VAULT_STORAGE_QUOTA_EXCEEDED`, …), **jamais
   `UNSUPPORTED`**, qui n'est rendu que pour `absent`. 5 bis. **L'inventaire d'un stockage qui ne
   répond pas est INCONNU, pas vide.** Le Worker répond `inconnu: true` avec le refus typé
   `VAULT_STORAGE_INDETERMINE` (jamais `present: false` nu, qui se lisait « Aucun coffre sur cet
   appareil »). La coquille ne propose alors NI la création (la politique de phrase de création ne
   s'applique pas), NI un moyen d'ouverture : l'écran du parcours `inaccessible` — « Le stockage du
   navigateur ne répond pas pour l'instant » — n'offre que « Réessayer ». Ce bouton relance la
   sonde, puis l'inventaire, puis l'état publié, **sans recharger la page** ; l'inventaire relu
   efface l'inconnu et le parcours rend l'écran du coffre EXISTANT (`Vérifier votre code`,
   `Rouvrir votre coffre`), jamais `Créer votre coffre`. **Ce qui est mesuré, par moteur**
   (`tests/browser/coquille-stockage-indetermine.spec.mjs`, moteur lu de la FIXTURE, jamais de ce
   que la page affiche) : **Chromium et Firefox** — un coffre EXISTANT, le rejet posé dans le Worker
   (au démarrage, ou APRÈS une sonde réussie), l'écran inaccessible sans création ni moyen, la
   reprise sans rechargement, l'ouverture par le code puis par la phrase ; si l'écran devient
   inaccessible là où il ne doit pas, l'épreuve échoue. **WebKit** — dans le contexte ÉPHÉMÈRE de la
   fixture, le rejet est naturel et constant et aucun coffre ne s'y crée : l'épreuve vérifie la
   seule conduite de l'écran (ni création, ni moyen, « Réessayer » qui ne peut pas aboutir). **La
   reprise d'un coffre existant n'est PAS mesurée sous WebKit** : un contexte WebKit persistant, qui
   a l'OPFS, la permettrait ; ce dépôt ne le mesure pas. Les scénarios qui exigent l'écran de
   création sont `test.skip(browserName === "webkit", …)`, visibles au rapport. 5 ter. **Une panne
   APRÈS une sonde réussie.** `disponible` n'est pas terminal : il peut repasser en `indetermine` ou
   en `panne:<code>` quand une LECTURE réelle rejette (`apresUnEchecDeLecture`,
   `classerLaLectureEnEchec`) — l'inventaire, jamais un refus privé qui finirait le démarrage en
   erreur, ou un geste. Le classement est conservateur : l'`UnknownError` (brut, ou traduit en
   `SUPPORT_FAILURE` avec son nom dans `context.cause`) est indéterminé ; `QuotaExceededError`,
   `InvalidStateError`, `NotReadableError` et les codes de support typés sont des pannes à leur code
   ; **toute erreur du domaine** (refus d'enveloppe, coffre refusé, exclusivité tenue, bug) remonte
   telle quelle et n'est jamais avalée. Un volume OUVERT n'est pas touché. Éprouvé avec le Worker
   réel : lectures successives (lue, en panne, relue), panne après une reprise, geste dont la
   lecture rejette ; mutants sur le chemin réel.
6. **Tout ce qui dépend de la capacité attend la sonde** : `surMessagePrivilegie` (inventaire,
   gestes) et `publierLEtat` (qui attend puis lit l'état — la première rédaction lisait avant son
   `await` et publiait un `verrouille` périmé). Pas d'`await` de module : un Worker module qui en
   fait un perd ses premiers messages, sur les trois moteurs (`docs/compatibility.md`).
7. **Les témoins de frontière ne perdent jamais un témoin sur un `UnknownError`.** Le spike
   (`public/spike/origin/racine-opfs.mjs`) rend `indetermine` (jamais `indisponible`), `panne` pour
   tout autre rejet ; la fouille du banc de déverrouillage rend `impossible`, jamais un texte vide
   muet ; une panne lève. La comparaison (`tests/support/temoins-opfs.mjs`) n'exempte que l'API
   ABSENTE et, dans le seul contexte éphémère WebKit que **l'épreuve connaît par sa propre fixture**
   (jamais par le nom de l'erreur), un témoin OPFS indéterminé quand A n'a rien pu déposer non plus
   — la limite est écrite. Un témoin déjà déposé qui disparaît reste rouge, sur les trois moteurs.

## Conséquences

- Les épreuves « le moteur le refuse typé » acceptent `VAULT_STORAGE_UNSUPPORTED` **ou**
  `VAULT_STORAGE_INDETERMINE` (`tests/support/refus-de-capacite.mjs`), et les états `indisponible`
  ou `indetermine` pour un moteur sans volume : sous WebKit ≥ 26.6 éphémère, ce sont les seconds.
- Le port restreint peut désormais publier `indetermine` au document applicatif : un état de plus,
  sans champ de plus.
- Un coût de 200 ms au démarrage de la coquille, dans ce seul cas, et 200 ms par geste présenté tant
  que l'indétermination dure.

## Limites écrites

- **Aucune mesure sur un vrai Safari** (#40). L'assimilation « contexte éphémère de Playwright =
  navigation privée de Safari » est une hypothèse. Le produit ne dépend pas d'elle : il ne dit rien
  du contexte, seulement ce qu'il a vu.
- **Un `UnknownError` n'est pas distinguable d'une panne mémoire** : le moteur ne le permet pas. Le
  produit le tient pour indéterminé, réessayable ; si la panne dure, l'utilisateur lit « essayez une
  autre fenêtre ou un autre navigateur », sans que ce soit affirmé comme cause.
- **La sonde de capacités** (`src/compat/`) range ce rejet en `error`, donc le verdict Vault de
  WebKit en `candidat` : suivi par #306. Le produit et la sonde ne se contredisent pas, mais ne se
  recoupent pas non plus.
- **Muté, et ce qui ne l'est pas, dit** : la garde de l'interface de déverrouillage sur un
  inventaire refusé ou INCONNU (`ouvrirParLaPhrase`) est mutée, et tuée par
  `tests/unit/coquille-interface-inventaire-refuse.test.mjs`, qui monte la VRAIE `monterLInterface`
  sur un document minimal et exécute le geste (phrase présentée, clic) : aucune dérivation ne part,
  le champ de phrase n'est pas vidé, le refus d'inventaire prime sur la politique de création. Un
  second mutant porte sur la condition qui choisit la politique de création
  (`!present && inconnu !== true`) : un inventaire inconnu n'a ni `minLength` de création, ni
  `new-password`, ni constat, ni conseil de choix. **Non mutés** : `app-inter.mjs` et le banc
  (branchement DOM, navigateur seul) ; les deux AUTRES gardes de même forme de l'interface
  (`ouvrirPar`, `ouvrirParLaPasskey`), dont celle d'`ouvrirPar` masque la première pour la seule
  dérivation. Le geste qui ATTEINT l'OPFS à la levée est éprouvé par le Worker chargé tel quel (un
  double de racine dont l'accès est compté) et par ses mutants. **Le passkey** n'est pas rejoué
  après une panne : l'inventaire relu propose les moyens du coffre par le même chemin que la phrase
  et le code (`moyensProposes`), mais aucun authentificateur virtuel n'est piloté ici.

## Alternatives rejetées

- **Garder `unsupported`.** Rejeté par la revue : il affirme une absence durable que le message du
  moteur contredit, et fige la session.
- **Réutiliser `VAULT_STORAGE_SUPPORT_FAILURE`.** Rejeté : il nomme l'échec d'une opération sur un
  volume atteint, et sa conduite dit « le navigateur n'a pas pu lire ou écrire les données du coffre
  » ; ici rien n'a été tenté sur le coffre.
- **Ne pas ajouter d'état (rester `verrouille`).** Rejeté : l'interface inviterait à une phrase,
  dérivée pour rien, avant de refuser.
- **Une sonde sans borne, ou attendre « jusqu'à ce que ça passe ».** Rejeté : le démarrage resterait
  suspendu sur un contexte où le rejet est constant.
