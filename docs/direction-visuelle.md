# Direction visuelle du parcours

Pour P3 (#194), le mainteneur a choisi le 14 septembre 2026 sa proposition utilitaire : une carte
blanche, des angles droits, des bordures sombres et une ombre franche de six pixels. L'harmonisation
de l'application de référence a ensuite été autorisée comme complément après l'essai réel dans
Chrome.

## Améliorations après l'essai dans Chrome — 14 septembre 2026

L'essai réel a montré que les instructions repoussaient l'application vers le bas de la fenêtre et
que le bouton de démarrage restait ambigu après le boot. Quand Rails annonce être prêt, les conseils
sont maintenant repliés dans « Aide pour cette étape ». Ils restent disponibles au clavier. Le
message de réussite reste annoncé et le bouton de démarrage est retiré de la présentation. Avant le
démarrage, les instructions et la progression restent visibles. Les refus restent toujours visibles
et annoncés.

Le cadre applicatif reste à sa place dans le DOM : ouvrir ou fermer l'aide ne recharge pas Rails et
ne perd pas le port restreint. Le test du parcours au clavier contrôle la disponibilité de la même
session après ces bascules et la position du cadre à moins de 380 pixels du haut de la page. Lorsque
le bouton de démarrage avait le focus, celui-ci revient au titre dès que Rails est prêt. Les autres
éléments déjà utilisés conservent leur focus.

Le premier essai du test a révélé que la désactivation du bouton pendant le boot rendait déjà le
focus au document. La correction conserve donc la provenance du dernier focus sur un contrôle, au
lieu de se fier uniquement à l'élément actif au moment de la réussite. L'assertion de focus du
parcours au clavier couvre ce cas.

L'action de continuation utilise un bouton secondaire. Les conseils passent à 14 pixels et leur
largeur est limitée à 68 caractères pour faciliter la lecture sur les grands écrans.

En complément de la coquille P3, la feuille locale de l'application de référence harmonise les
champs, boutons, liens, focus et thèmes. Son icône existante devient monochrome par CSS. Le
formulaire Rails, ses libellés, la pièce jointe et les ressources servies par le relais restent les
mêmes. Le fond clair historique est conservé comme témoin de la bonne application de la feuille CSS
dans les E2E. Ces changements sont intégrés en reconstruisant l'image de référence ; recharger
uniquement la coquille ne suffit pas.

## Composants et ressources

La feuille locale `public/coquille/parcours.css` centralise les couleurs, l'espacement et les
polices. Inter est utilisée si elle est déjà installée ; sinon le navigateur emploie sa police
système. Le code de récupération utilise une police monospace. Aucun téléchargement de police, CDN
ou image distante n'est nécessaire. Le thème sombre suit la préférence du système.

Les boutons et champs ont une hauteur minimale de 48 pixels. Les attentes et refus utilisent des
blocs sobres, avec leur annonce accessible existante. Un lien d'évitement conduit au titre du
parcours. Le focus clavier porte un contour de trois pixels ; la préférence de réduction des
mouvements supprime les transitions et l'animation de progression.

La feuille de récupération ressemble à un ticket à bordure pointillée. L'impression utilise le même
élément contenant le code, avec sa consigne de version. Elle ne crée aucune copie du secret. Après
confirmation, cet élément reste masqué à l'écran et à l'impression. Les détails du relais applicatif
sont regroupés dans un élément `details` accessible au clavier.

## Vérifications reproductibles

`npm run test:apparence` exécute 33 scénarios sur Chromium, Firefox et WebKit, en clair et sombre,
aux largeurs 320, 768, 1024 et 1440 pixels. Il produit les captures et rapports axe dans
`reports/apparence`. Il vérifie les écrans de création, choix, restauration, récupération, refus et
impression, selon les capacités réelles de chaque moteur. Quand WebKit refuse le stockage
nécessaire, le test contrôle ce refus explicite plutôt que de simuler une récupération. Il contrôle
aussi l'absence de débordement horizontal et de requête distante.

Les contrastes mesurés depuis les styles calculés des composants sont :

| Composant                     |   Clair |  Sombre | Minimum vérifié |
| ----------------------------- | ------: | ------: | --------------: |
| Texte principal               | 17,74:1 | 15,16:1 |           4,5:1 |
| Texte secondaire              |  7,56:1 |  9,94:1 |           4,5:1 |
| Texte du bouton principal     | 17,74:1 | 16,88:1 |           4,5:1 |
| Bordure du champ sur son fond | 16,98:1 | 15,01:1 |             3:1 |

Ces seuils viennent des [WCAG 2.2](https://www.w3.org/TR/WCAG22/). Les scans axe ciblent les règles
A et AA disponibles jusqu'à WCAG 2.2. Le rapport conserve aussi les résultats `incomplete` pour
examen humain : l'absence de violation automatique ne constitue pas une certification. Une
vérification avec NVDA ou VoiceOver reste à réaliser pour confirmer la lecture des changements
d'étape, des attentes et des refus.

Le scénario `tests/e2e/parcours-clavier.spec.mjs` traverse les neuf étapes avec Tabulation, Entrée
et la saisie au clavier, y compris une mutation Rails réelle, le verrouillage, la sauvegarde, la
restauration et la révocation. Seule la sélection du fichier de sauvegarde utilise l'API Playwright
après avoir atteint le champ au clavier, car le sélecteur natif du système ne relève pas du DOM. Le
scénario nominal P2 `parcours-utilisateur.spec.mjs` reste inchangé.

La CI publie les captures et mesures dans l'artefact `apparence-parcours` et exécute le parcours au
clavier dans le lot de reprise MVP. `npm run check` inclut les contrôles d'apparence, ainsi que les
vérifications existantes.
