# Gouvernance de développement

Cette gouvernance reste légère : elle vise à rendre les décisions prévisibles, pas à multiplier les
cérémonies.

## Responsabilités

Tant que le projet ne compte qu'un mainteneur, `@pinfada` tient provisoirement les responsabilités
produit, runtime, stockage et sécurité. Lorsqu'une équipe se forme, chaque responsabilité reçoit un
titulaire et un suppléant dans ce document et dans `CODEOWNERS` :

- **produit** — priorités, exigences et acceptation du MVP ;
- **runtime** — v86, Workers, application Rails de référence ;
- **stockage** — OPFS, durabilité, formats et migrations ;
- **sécurité** — frontières de confiance, cryptographie et revues ;
- **expérience** — installation, sauvegarde, restauration et accessibilité.

Personne n'approuve seul une évolution dont il est l'auteur lorsque l'équipe permet matériellement
une seconde revue. Les formats persistants, la cryptographie et les frontières d'origine exigent
alors deux regards, dont le responsable sécurité ou son suppléant.

## Cadence et flux

- Triage hebdomadaire des nouvelles issues et des blocages.
- Au plus deux PR d'implémentation simultanées par personne.
- Première réponse attendue sur une PR sous deux jours ouvrés.
- Une issue sans Definition of Ready ne reçoit pas d'assignation.
- Une décision structurante passe par un ADR dans la PR qui l'applique.

## Blocages et escalade

Une issue reçoit le label `status:blocked` lorsqu'une dépendance, une décision ou un accès extérieur
empêche tout progrès utile. Le commentaire de blocage nomme le responsable de la levée et le
prochain événement attendu.

Après deux cycles de triage sans résolution, le responsable produit tranche entre : réduire le
périmètre, lancer un spike borné, changer de dépendance ou retirer l'issue du chemin critique.

## Fusion et exception

La fusion normale utilise une PR, des contrôles obligatoires verts, les conversations résolues et un
historique linéaire. Le squash est préféré pour qu'une tranche corresponde à un commit de `main`.

Une exception urgente doit être documentée dans une issue après l'intervention, avec cause, portée,
validation et action empêchant sa répétition. Elle ne permet jamais de contourner la règle
interdisant secrets et données personnelles.
