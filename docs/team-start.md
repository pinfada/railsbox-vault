# Démarrer dans l'équipe

Ce parcours vise une première contribution sans connaissance implicite détenue par le fondateur. Il
complète `CONTRIBUTING.md`, qui reste la règle normative des changements.

## 1. Installer et vérifier

Pré requis : Git et la version de Node indiquée par `.node-version`.

```sh
git clone https://github.com/pinfada/railsbox-vault.git
cd railsbox-vault
npm ci
npx playwright install --with-deps chromium
npm run check
```

Le résultat attendu est une analyse statique verte, un test unitaire vert et un scénario Chromium
page/Worker vert. Une erreur à cette étape est un défaut d'installation à signaler ; elle ne doit
pas être contournée dans une évolution sans rapport.

## 2. Choisir une tâche

La file de travail est l'issue #31. Une tâche peut être prise seulement si elle :

- porte `status:ready` et aucun `status:blocked` ;
- satisfait la Definition of Ready de `CONTRIBUTING.md` ;
- est assignée avant le premier changement ;
- tient dans la limite de travail simultané de `docs/governance.md`.

Les issues `status:epic` expriment une direction, pas une autorisation d'implémenter leur solution
présumée. Les dépendances d'une issue priment sur son numéro ou son jalon.

## 3. Produire la preuve

Pour une implémentation, créer une branche depuis `main`, écrire le test d'acceptation le plus petit
et conserver la preuve de son échec attendu. Pour un spike, exécuter le protocole borné et conserver
environnement, mesures brutes et conclusion. Documentation et audit utilisent les preuves propres
décrites dans le modèle de PR.

Ouvrir tôt une PR en brouillon permet à l'équipe de voir le travail en cours. La description doit
fermer une issue principale, répondre à chaque critère et donner les commandes exactes.

## 4. Décider ou escalader

Un contributeur peut, sans autorisation supplémentaire :

- implémenter le contrat d'une issue prête ;
- ajouter un test plus strict qui respecte les exigences publiées ;
- corriger un défaut dans le même périmètre ;
- créer une issue pour un travail découvert.

Une décision exige un ADR et la revue du responsable concerné lorsqu'elle modifie une frontière de
confiance, un format persistant, le modèle de récupération, une promesse de compatibilité ou un
budget de qualité. Une dépendance inconnue n'autorise pas à choisir silencieusement : marquer
`status:blocked`, nommer la décision attendue et proposer un spike borné.

## 5. Livrer et transmettre

Avant passage en revue, exécuter `npm run check`, compléter le modèle de PR et relire sécurité,
compatibilité, documentation et rollback. Après fusion, vérifier la fermeture de l'issue et ne
promouvoir l'issue suivante vers `status:ready` que si toutes ses dépendances sont closes.

Le transfert à un autre membre tient dans quatre éléments : issue, branche/PR, dernière commande
exécutée et prochain résultat observable. Une conversation privée ne constitue pas la seule trace
d'une décision ou d'un blocage.
