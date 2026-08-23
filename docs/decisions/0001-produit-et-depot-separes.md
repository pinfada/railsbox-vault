# ADR 0001 — RailsBox Vault est un produit et un dépôt séparés

- Statut : accepté
- Date : 2026-08-23

## Contexte

RailsBox Live transforme une application Rails en démonstration publique et
jetable. Sa sécurité repose notamment sur l'absence de données réelles et de
persistance durable.

RailsBox Vault vise au contraire des logiciels personnels dont les données
survivent au navigateur, peuvent être sensibles et doivent rester accessibles
indépendamment de l'éditeur. Cette promesse déplace les frontières de sécurité,
le cycle de vie du stockage et les critères d'acceptation du produit.

## Décision

RailsBox Vault vit dans un dépôt indépendant de RailsBox Live.

Le projet part d'une documentation et de prototypes propres. Il peut réutiliser
du code sous sa licence et en conserver l'attribution, mais aucun composant
partagé n'est extrait avant que son interface soit stable dans les deux
produits.

## Conséquences

- RailsBox Live conserve son contrat simple de démonstration jetable.
- Vault possède son propre modèle de menace et peut adopter une topologie
  d'origines différente.
- Les régressions et publications de Vault n'affectent pas les sandboxes Live.
- Les corrections communes devront temporairement être reportées explicitement.
- Une bibliothèque de runtime partagée pourra être créée plus tard sur la base
  de besoins mesurés, pas d'une abstraction supposée.
