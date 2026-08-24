# ADR 0006 — La coquille ne promet jamais une durabilité qu'elle ne tient pas

- Statut : accepté
- Date : 2026-08-24
- Issue : #42 · Invariant : `VAULT-PERSIST-001` · Jalon 1

## Contexte

L'issue #9 a livré la couche de **diagnostic** de budget : elle estime l'espace, demande la
persistance quand l'API existe, et transforme refus, indisponibilité, espace faible et quota dépassé
en diagnostics stables. Elle **détecte et qualifie** ; elle a explicitement laissé à #42 la
**conduite produit** — quand demander la persistance, ce que la coquille affiche, et quelle promesse
de durabilité elle fait.

Trois faits établis encadrent cette conduite :

- #2 a mesuré que `navigator.storage.persist()` est **refusé sans geste utilisateur** (verdict
  `denied`, jamais `error`) sur Chromium et Firefox. Firefox laisse en outre la promesse
  **pendante** derrière une invite : la réponse n'est pas connue au moment où le code la lit ;
- l'[ADR 0002](0002-topologie-origine-de-confiance.md) confie à la coquille de confiance le recueil
  du **consentement utilisateur**, distinct du territoire applicatif hostile ;
- `SECURITY.md` (invariant `SEC-DURABLE-001`) et `docs/quality-attributes.md` interdisent d'annoncer
  une durabilité non tenue : « aucun succès silencieux », jamais de promesse fausse.

Le diagnostic de #9 ne suffit donc pas : un booléen « durable oui/non » ne saurait distinguer un
refus tranché (pas de durabilité) d'une invite encore pendante (durabilité **inconnue**), ni dire à
la coquille quoi afficher. Il manque une décision.

## Décision

**Une couche de conduite pure se pose au-dessus du diagnostic de #9. À partir d'un verdict de
persistance et du contexte (geste utilisateur, choix de l'utilisateur), elle produit un état de
coquille explicite et une promesse de durabilité à trois valeurs — jamais un booléen, jamais une
promesse fausse.** Elle vit dans `src/vm/persistence-conduct.mjs` ; son rendu accessible (rôle
ARIA + texte) dans `src/vm/persistence-conduct-messages.mjs`. Elle **réutilise**
`storage-budget.mjs` et `storage-budget-messages.mjs` de #9 (import, pas copie) et ne les modifie
pas.

### Quand demander la persistance

La demande n'est légitime que **derrière un geste utilisateur explicite** — jamais au chargement,
puisque #2 a montré qu'une demande sans geste est refusée d'office. `shouldRequestPersistence`
l'énonce : au chargement, la coquille lit `persisted()` (lecture sans geste) ; si le stockage n'est
pas déjà persistant, elle **attend** un geste avant d'appeler `persist()`. La coquille de confiance
recueille ce geste dans le cadre du consentement décidé par l'ADR 0002.

### Ce que la coquille affiche, et la promesse qu'elle fait

La promesse de durabilité prend **trois valeurs** : `GARANTIE`, `NON_GARANTIE`, `INCONNUE`. Un
booléen les réduirait à deux et écraserait la distinction entre « le moteur a refusé » et « le
moteur n'a pas encore répondu ». À chaque verdict correspond un état de coquille explicite :

| Verdict de persistance               | État de coquille               | Promesse de durabilité | Ce que la coquille dit                                                   |
| ------------------------------------ | ------------------------------ | ---------------------- | ------------------------------------------------------------------------ |
| aucune demande, aucun geste          | `CONSENTEMENT_REQUIS`          | `INCONNUE`             | la persistance sera demandée à la suite d'un geste ; rien n'est promis   |
| `granted` / `already`                | `DURABLE_GARANTI`              | `GARANTIE`             | le stockage est durable, non évincé sans action de l'utilisateur         |
| `pending` (Firefox)                  | `ATTENTE_RESOLUTION`           | `INCONNUE`             | l'invite n'a pas répondu ; ni durabilité promise, ni poursuite décidée   |
| `denied` / `unsupported` + poursuite | `POURSUITE_VOLATILE_QUALIFIEE` | `NON_GARANTIE`         | poursuite possible SANS garantie, l'état volatile affiché sans ambiguïté |
| `denied` / `unsupported` + arrêt     | `ARRET`                        | `NON_GARANTIE`         | l'utilisateur s'arrête plutôt que d'écrire sans garantie                 |

Au moins trois états portent une promesse de durabilité — `DURABLE_GARANTI`,
`POURSUITE_VOLATILE_QUALIFIEE`, `ARRET` — conformément à l'exigence de l'issue. Deux autres
encadrent le cycle de la demande. Chaque état est déterministe et éprouvé.

### L'invariant central

**Une durabilité `GARANTIE` n'existe que derrière une persistance réellement accordée** (`granted`
ou `already`). C'est la traduction produit de `SEC-DURABLE-001`. Le test unitaire l'éprouve sur
**toutes** les combinaisons de verdict × geste × choix : aucune ne rend `GARANTIE` sans octroi réel,
et aucune ne rend l'état `DURABLE_GARANTI` sans octroi réel.

### L'attente pendante est traitée comme non accordée

Un verdict `pending` (l'invite Firefox non tranchée) ne franchit **jamais** le seuil de la
durabilité. Il ne devient ni `DURABLE_GARANTI` (le moteur n'a rien accordé), ni
`POURSUITE_VOLATILE_QUALIFIEE` (proposer une poursuite volatile devancerait une réponse que l'invite
peut encore rendre positive). Il produit `ATTENTE_RESOLUTION` : la décision est **haltée** jusqu'à
ce que le navigateur réponde, puis la conduite est réévaluée avec le verdict résolu. C'est un
`arrêt` de la décision, pas du produit.

## Ce qui est explicitement refusé

- **Annoncer « durable » sans persistance accordée.** Aucun état, aucune promesse, aucun message ne
  déclare la durabilité tenue quand le verdict n'est pas `granted`/`already`. Un refus, une attente
  ou une absence d'API ne produisent jamais `GARANTIE`.
- **Demander la persistance au chargement.** La demande est gatée derrière un geste explicite.
- **Un booléen de durabilité.** La promesse est à trois valeurs ; l'exposer en `true`/`false`
  effacerait l'état `INCONNUE`.
- **Poursuivre en volatile sur une attente pendante.** Tant que l'invite n'a pas répondu, la
  conduite halte au lieu de trancher à la place du navigateur.
- **Un succès silencieux.** Un état volatile est toujours affiché comme tel, avec un message
  accessible ; il n'est jamais confondu avec un état durable.

Hors périmètre, comme l'exige l'issue : la détection et le diagnostic (déjà faits par #9), l'achat
de stockage, le nettoyage automatique, l'export, le bail d'écriture (#8), le chiffrement, et la
construction d'une UI produit complète — il n'existe pas encore de coquille finale. Cet ADR fixe une
frontière de promesse, pas une interface.

## Preuves

- `tests/unit/vm-persistence-conduct.test.mjs` (rattaché à `npm run check`) : chaque verdict, la
  règle de demande derrière un geste, l'invariant éprouvé sur toutes les combinaisons, l'attente
  pendante traitée comme non durable, la réutilisation réelle du diagnostic #9, le refus typé d'un
  verdict inconnu, et l'absence de toute action de suppression.
- `tests/browser/persistence-conduct.spec.mjs` (rattaché à `npm run check`) : le rendu accessible
  dans un vrai DOM — rôle ARIA, état de coquille et promesse de durabilité posés et relus — et
  l'invariant vérifié sur le verdict **réel** rendu par le vrai `navigator.storage` sans geste.

La preuve rouge/verte figure dans la description de la pull request.

## Risques et conditions d'abandon

Risques résiduels :

1. **La détection de l'attente pendante appartient à l'appelant.** `requestPersistence()` de #9
   attend la promesse ; obtenir un verdict `pending` suppose que la coquille oppose `persist()` à un
   délai. Le mécanisme du délai (durée, réémission après résolution) reste à la coquille finale
   (#24) et n'est pas figé ici.
2. **La distinction poursuite/arrêt est un choix utilisateur.** La couche la modélise (`stance`),
   mais l'ergonomie du recueil de ce choix appartient à la coquille finale.
3. **`unsupported` est rangé avec `denied`** (poursuite volatile qualifiée). Un moteur sans API de
   persistance n'offre aucune durabilité : le traiter comme un refus est prudent, mais suppose que
   la coquille sait le distinguer d'un vrai refus dans son message — ce que le code de diagnostic #9
   conservé (`VAULT_BUDGET_PERSIST_UNSUPPORTED` vs `VAULT_BUDGET_PERSIST_DENIED`) permet.

Cette décision est révisée par un nouvel ADR si l'un de ces faits est établi :

- un moteur de la matrice cible rend `persist()` **durable sans geste**, ou expose un quatrième état
  que ces cinq n'absorbent pas ;
- la coquille finale (#24) exige une promesse de durabilité plus fine que ces trois valeurs ;
- une exigence produit impose de demander la persistance au chargement — auquel cas la mesure de #2
  devrait d'abord être infirmée.

## Alternatives rejetées

- **Un booléen `durable`.** Rejeté : il confond refus tranché et attente pendante, deux conduites
  différentes. La distinction `NON_GARANTIE` / `INCONNUE` est la moitié de la décision.
- **Demander la persistance au chargement.** Rejeté sur la mesure de #2 : la demande sans geste est
  refusée d'office, et l'ADR 0002 confie le consentement à un geste dans la coquille.
- **Poursuivre en volatile dès qu'une attente est pendante.** Rejeté : cela trancherait à la place
  du navigateur une invite qui peut encore accorder la persistance, et pourrait afficher « volatile
  » juste avant que le moteur rende « durable ».
- **Étendre les codes de diagnostic de #9 pour porter la conduite.** Rejeté : #9 diagnostique, #42
  décide. Mélanger les deux dans un même module brouillerait la frontière que cet ADR trace.
