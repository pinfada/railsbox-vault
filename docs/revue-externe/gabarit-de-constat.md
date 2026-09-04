# Gabarit de constat — revue externe du format de volume v3

Un constat par fichier ou par message. Les cinq rubriques sont attendues ; une rubrique vide se
laisse vide plutôt que de se remplir approximativement.

Ce gabarit sert la moitié 2 de [#20](https://github.com/pinfada/railsbox-vault/issues/20). Chaque
constat reçu devient une issue portant l'étiquette `revue-externe`, et une ligne du
[registre](registre.md). Aucun constat n'est écarté sans réponse écrite.

---

## Titre

Une phrase qui dit ce qui ne va pas, pas ce qu'il faudrait faire. « L'en-tête v3 n'est pas
authentifié » plutôt que « authentifier l'en-tête v3 ».

## Sévérité

Une valeur, et une seule :

| Sévérité     | Ce qu'elle veut dire                                                                             | Ce que le dépôt en fait                                   |
| ------------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| **CRITICAL** | confidentialité ou intégrité perdue, ou perte de données, sans que rien ne le signale            | corrigé avant la fermeture de #20                         |
| **HIGH**     | une propriété annoncée par la spécification ne tient pas, ou tient sous une hypothèse non écrite | corrigé avant la fermeture de #20                         |
| **MEDIUM**   | la propriété tient, mais son coût, sa portée ou sa conduite d'échec sont mal décrits             | corrigé, ou accepté par amendement daté de l'ADR concerné |
| **LOW**      | formulation, lisibilité, redondance, renvoi périmé                                               | corrigé, ou accepté par amendement daté de l'ADR concerné |

Si l'échelle ne va pas, écrire la sévérité qui va et dire pourquoi : une échelle imposée qui ne
correspond pas au constat produit une sévérité fausse.

## Reproduction

Ce qu'il faut faire pour observer le fait. Trois formes sont acceptées, et la première est la
meilleure :

1. **une commande** — `node tools/verifier-vecteurs.mjs`, `node --test tests/unit/…`, un extrait de
   script autonome ;
2. **une suite d'octets** — les octets présentés et le verdict obtenu, en hexadécimal minuscule ;
3. **un raisonnement** — quand le fait ne s'exécute pas (une hypothèse manquante, un adversaire que
   le modèle de menace n'admet pas). Nommer alors explicitement l'hypothèse et l'endroit de la
   spécification qui la porte, ou son absence.

Un constat qui ne se reproduit pas reste recevable ; il est traité, et le registre dit que la
reproduction n'a pas été obtenue plutôt que de le classer sans suite.

## Impact

Ce qu'un adversaire obtient, sous quelles capacités. Les capacités comptent autant que le résultat :
« lecture du fichier de volume », « écriture dans l'OPFS de l'origine de confiance », « une copie
antérieure du volume et de son journal », « la clé de volume ». Le modèle de menace du dépôt est
dans [`SECURITY.md`](../../SECURITY.md) et
l'[ADR 0002](../decisions/0002-topologie-origine-de-confiance.md).

Dire aussi ce que l'adversaire n'obtient PAS, quand c'est connu : un déni de service et une lecture
de clair n'appellent pas le même remède.

## Proposition

Facultative, et sa présence ne change pas la sévérité. Si elle existe, dire son coût : une version
de format, un ADR, une dépendance nouvelle, un surcoût d'espace ou de temps.

---

## Où envoyer

Une issue sur le dépôt, ou tout canal que le mainteneur aura indiqué dans l'issue `help wanted` de
sollicitation. Aucun accord de confidentialité n'est demandé et aucun n'est offert : le dépôt est
public, ses vecteurs sont publics, et sa clé de test l'est aussi.

## Ce que le relecteur peut exécuter

```sh
node tools/verifier-vecteurs.mjs   # les vecteurs figés, vérifiés sans une ligne du produit
npm run test:unit                  # les épreuves unitaires, dont celles que la spécification cite
npm run check                      # lint, format, épreuves, compatibilité, chaîne de publication
```
