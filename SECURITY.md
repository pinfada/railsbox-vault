# Modèle de menace initial

Ce document décrit les frontières visées. Il ne constitue pas encore une garantie de sécurité :
RailsBox Vault est au stade expérimental et ne doit contenir aucune donnée réelle.

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

## Frontières de confiance

| Composant               | Autorité maximale admise                                      |
| ----------------------- | ------------------------------------------------------------- |
| Coquille Vault          | courtage du canal, déverrouillage et consentement utilisateur |
| Worker runtime          | clé de volume en session et E/S authentifiées                 |
| VM et application Rails | données nécessaires à l'usage, jamais la clé ni OPFS direct   |
| Hébergement statique    | distribution d'artefacts publics vérifiables                  |
| Relais optionnel        | transport de ciphertext et métadonnées minimales              |

Le code applicatif, les dépendances Rails, l'hébergement et le relais restent des entrées
potentiellement hostiles. La coquille et son Worker forment la base de confiance minimale à réduire
et tester.

## Invariants vérifiables

- `SEC-ORIGIN-001` — un script applicatif ne peut acquérir le canal privilégié ou lire une clé de
  volume ;
- `SEC-KEY-001` — une clé de déverrouillage enveloppe une DEK aléatoire sans servir directement au
  chiffrement des blocs ;
- `SEC-BLOCK-001` — un bloc est authentifié avec volume, adresse, format et génération ;
- `SEC-GEN-001` — rejeu, troncature et mélange de générations sont refusés ;
- `SEC-DURABLE-001` — aucune écriture n'est annoncée durable avant le flush effectif ;
- `SEC-UPDATE-001` — runtime et application sont identifiés et vérifiés avant d'ouvrir le volume en
  écriture ;
- `SEC-RECOVERY-001` — chaque moyen de récupération annoncé possède un test de succès, de révocation
  et de perte définitive.

Chaque invariant devra être relié à un test automatisé ou, pour une revue externe, à un constat
public et sa disposition.

## Ce que le chiffrement au repos ne résout pas

Le chiffrement d'un volume ne protège pas les données déjà déverrouillées contre du code exécuté
dans la même autorité web. Une séparation d'origine entre la coquille de confiance et l'application
doit être étudiée avant tout usage avec des données sensibles.

L'authentification indépendante de chaque bloc ne protège pas à elle seule contre le rejeu d'un
ancien bloc, le déplacement d'un bloc valide, la troncature ou la restauration complète d'une
ancienne génération. Le format de volume devra fournir une intégrité transactionnelle globale.

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

## Gates d'utilisation

1. **Données synthétiques uniquement** jusqu'à la persistance transactionnelle,
   l'export/restauration et le refus d'incompatibilité.
2. **Données sensibles interdites** jusqu'à l'implémentation de la séparation d'origine, du
   verrouillage, de la récupération et du format chiffré.
3. **Qualification produit interdite** jusqu'à la revue externe, la résolution des constats
   critiques et élevés et la publication de la matrice navigateur.

Une démonstration réussie ne lève jamais seule un gate.

## Chaîne d'approvisionnement

Les dépendances sont verrouillées. Les workflows ont des permissions minimales et leurs actions
seront épinglées avant la première publication. Les images VM publiées devront fournir empreinte,
provenance de build et SBOM. Aucun secret de signature ne réside dans un artefact servi au
navigateur.

## Signaler une vulnérabilité

Tant qu'aucun canal privé propre à RailsBox Vault n'est publié, utilisez les avis de sécurité privés
du dépôt GitHub. N'ouvrez pas d'issue publique contenant une procédure d'exploitation ou des données
personnelles.
