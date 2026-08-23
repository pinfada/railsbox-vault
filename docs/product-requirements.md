# Exigences produit

## Proposition

RailsBox Vault distribue une application Rails par des fichiers statiques, puis exécute son runtime
et conserve son volume sur l'appareil de l'utilisateur. Le serveur de publication distribue le
logiciel ; il n'est ni l'autorité sur les données ni un prérequis permanent d'utilisation.

## Utilisateurs prioritaires

1. **Gardien d'archives personnelles** — conserve durablement généalogie, documents ou collections
   sans remettre les originaux à un SaaS.
2. **Éditeur d'une application Rails personnelle** — distribue une vraie application Rails sans
   exploiter une base pour chaque utilisateur.
3. **Proche invité** — reçoit plus tard une sélection chiffrée et conserve son propre coffre ; ce
   profil est hors du MVP initial.

## Parcours du MVP

Le MVP est réussi lorsqu'un gardien peut, avec des données synthétiques :

1. installer l'application de référence depuis une publication statique ;
2. créer une donnée et une pièce jointe dans Rails ;
3. fermer tous les contextes du navigateur ;
4. rouvrir hors ligne et retrouver exactement cette mutation ;
5. exporter un point cohérent du volume ;
6. restaurer cet export depuis une autre origine ;
7. recevoir un refus explicite si application, runtime ou format sont incompatibles.

Le chiffrement et la collaboration sont les étapes suivantes. Tant que leurs gates de sécurité ne
sont pas franchis, le projet n'autorise aucune donnée personnelle réelle.

## Exigences traçables

| Identifiant            | Exigence                                                                                  | Preuve principale   | Issues      |
| ---------------------- | ----------------------------------------------------------------------------------------- | ------------------- | ----------- |
| `VAULT-DIST-001`       | Une publication statique suffit à installer le runtime et l'application.                  | navigateur E2E      | #3, #5      |
| `VAULT-PERSIST-001`    | Une écriture acquittée par Rails survit à la fermeture complète.                          | VM + E2E            | #6, #7, #14 |
| `VAULT-PERSIST-002`    | Un seul écrivain détient le volume ; les autres clients reçoivent un état explicite.      | multi-onglets       | #8          |
| `VAULT-PORT-001`       | L'utilisateur exporte un point cohérent, complet et vérifiable.                           | E2E                 | #10, #11    |
| `VAULT-PORT-002`       | L'export se restaure depuis une autre origine compatible.                                 | E2E inter-origine   | #12         |
| `VAULT-COMPAT-001`     | Runtime, application et format sont identifiés avant toute mutation.                      | contrat + E2E       | #10, #13    |
| `VAULT-RESILIENCE-001` | Une coupure ouvre l'ancienne ou la nouvelle génération valide, jamais un mélange accepté. | injection de fautes | #15, #16    |
| `VAULT-SEC-001`        | Le code applicatif ne détient ni clé de volume ni capacité arbitraire sur le coffre.      | tests offensifs     | #24, #35    |
| `VAULT-SEC-002`        | Le stockage verrouillé ne révèle pas les données et détecte altération et rejeu.          | vecteurs crypto     | #17–#20     |
| `VAULT-RECOVERY-001`   | La perte d'un moyen de déverrouillage possède une issue documentée et testée.             | E2E récupération    | #21–#23     |
| `VAULT-SHARE-001`      | Un relais transporte un paquet sans le lire, le modifier ou le rejouer silencieusement.   | vecteurs + E2E      | #26–#28     |

## Non-objectifs du MVP

- collaboration temps réel ;
- synchronisation transparente multi-appareil ;
- compatibilité universelle avec toute gem ou tout navigateur ;
- exécution de tâches quand tous les appareils sont éteints ;
- remplacement d'un SaaS multi-tenant ;
- snapshot mémoire sur un disque mutable ;
- données personnelles ou médicales réelles.

## Hypothèses et critères de pivot

- v86 accepte un backend durable sans fork impossible à maintenir ;
- le boot local respecte le budget prototype de `quality-attributes.md` ;
- les navigateurs cibles fournissent les primitives requises ;
- l'export inter-origine ne dépend pas d'une autorité centrale ;
- la séparation d'origine garde un parcours d'installation compréhensible.

Une hypothèse qui échoue déclenche un ADR : réduire la compatibilité, changer de runtime ou arrêter
la voie concernée vaut mieux que masquer le coût dans les issues suivantes.
