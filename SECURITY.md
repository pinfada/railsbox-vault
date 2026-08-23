# Modèle de menace initial

Ce document décrit les frontières visées. Il ne constitue pas encore une
garantie de sécurité : RailsBox Vault est au stade expérimental et ne doit
contenir aucune donnée réelle.

## Actifs à protéger

- le volume applicatif et ses sauvegardes ;
- les pièces jointes et les bases SQLite ou PostgreSQL ;
- les clés de chiffrement et moyens de récupération ;
- les données en clair pendant une session déverrouillée ;
- l'intégrité et la version du runtime chargé par le navigateur.

## Adversaires considérés

- copie ou inspection du profil navigateur lorsque le coffre est verrouillé ;
- altération, rejeu ou remplacement de blocs persistés ;
- relais de stockage ou de synchronisation curieux ou compromis ;
- publication compromise d'une nouvelle version de l'application ;
- code applicatif ou dépendance exécutant du JavaScript hostile ;
- perte d'un appareil, d'une passkey ou d'une origine web.

## Ce que le chiffrement au repos ne résout pas

Le chiffrement d'un volume ne protège pas les données déjà déverrouillées contre
du code exécuté dans la même autorité web. Une séparation d'origine entre la
coquille de confiance et l'application doit être étudiée avant tout usage avec
des données sensibles.

L'authentification indépendante de chaque bloc ne protège pas à elle seule
contre le rejeu d'un ancien bloc, le déplacement d'un bloc valide, la
troncature ou la restauration complète d'une ancienne génération. Le format de
volume devra fournir une intégrité transactionnelle globale.

## Propriétés exigées avant une version utilisable

- aucune clé maîtresse persistée en clair ;
- hiérarchie séparant clé de déverrouillage et clé aléatoire du volume ;
- récupération documentée et testée ;
- export portable, authentifié et restaurable ;
- résistance aux écritures partielles et arrêts brutaux ;
- liaison vérifiable entre volume, application et runtime ;
- politique explicite de mise à jour et de retour à une version antérieure ;
- tests de séparation d'origine et d'exfiltration ;
- audit externe du format cryptographique avant toute promesse de production.

## Signaler une vulnérabilité

Tant qu'aucun canal privé propre à RailsBox Vault n'est publié, utilisez les
avis de sécurité privés du dépôt GitHub. N'ouvrez pas d'issue publique contenant
une procédure d'exploitation ou des données personnelles.
