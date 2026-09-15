# Direction visuelle du parcours

Pour P3 (#194), le mainteneur a choisi le 14 septembre 2026 sa proposition utilitaire : une carte
blanche, des angles droits, des bordures sombres et une ombre franche de six pixels. L'harmonisation
de l'application de référence a ensuite été autorisée comme complément après l'essai réel dans
Chrome.

**Écart à la Definition of Ready.** La DoR demandait deux propositions sur une page, dont une
retenue avec le mainteneur. Aucune des deux n'est versionnée : le mainteneur a choisi directement la
direction utilitaire en réalisant lui-même la tranche, et ce document consigne ce choix et ce qui a
suivi l'essai réel, pas l'alternative écartée.

## Améliorations après l'essai dans Chrome — 14 septembre 2026

L'essai réel a montré que les instructions repoussaient l'application vers le bas de la fenêtre et
que le bouton de démarrage restait ambigu après le boot. Quand Rails annonce être prêt, les conseils
sont maintenant repliés dans « Aide pour cette étape ». Ils restent disponibles au clavier. Le
message de réussite reste annoncé et le bouton de démarrage est retiré de la présentation. Avant le
démarrage, les instructions et la progression restent visibles. Les refus restent toujours visibles
et annoncés.

Hors de ce moment, l'aide n'est pas un repli : c'est un conteneur neutre. Le branchement la
transforme en `details` nommé « Aide pour cette étape » quand Rails est prêt, et la rend neutre
ensuite ; un repli dont le résumé serait masqué exposerait un groupe sans nom aux lecteurs d'écran
(revue de la PR #216, constat 7).

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
largeur est limitée à 68 caractères pour faciliter la lecture sur les grands écrans. Les messages de
conduite — refus, attente, réussite — sont à la taille du texte courant, 16 pixels : le message le
plus important de l'écran n'est plus le plus petit (revue de la PR #216, constat 10). Le rang et «
Étape suivante » restent petits.

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
sont regroupés dans un élément `details` accessible au clavier. Le document du relais définit son
fond et sa couleur en clair et en sombre (`public/cadre/document-applicatif.css`) : aucune bande de
fond du navigateur n'apparaît sous la page Rails.

« J'ai oublié ma phrase » est un bouton actif sans aplat : son contour est en `--secondaire` (7,56:1
en clair, 9,94:1 en sombre), et non plus en `--separateur` (1,47:1). Le bouton désactivé garde sa
bordure en `--separateur` (1,34:1 / 2,81:1) : une bordure de composant inactif est exemptée par les
critères 1.4.3 et 1.4.11, son texte passe (6,87:1 / 8,47:1), et l'état se lit aussi par l'aplat pâle
et par `disabled`.

Sous `forced-colors: active`, l'ombre est retirée, les bordures sont conservées et le contour de
focus prend la couleur système `Highlight`. Sous `prefers-reduced-motion: reduce`, la barre de
progression indéterminée devient une barre pleine et immobile, qui ne se distingue pas d'une barre
terminée : c'est admis, parce que le texte de l'attente (« Démarrage en cours depuis N seconde(s)…
») porte l'information et est annoncé.

## Vérifications reproductibles

`npm run test:apparence` exécute 38 scénarios et produit les captures et rapports axe dans
`reports/apparence`. Chaque écran vérifié passe axe, l'absence de débordement horizontal, puis une
capture pointeur écarté. Chaque contexte créé est surveillé : aucune requête hors des deux origines
servies, aucune violation de CSP dans aucun de ses documents.

| Écrans                                                                                                                                              | Moteurs                   | Thèmes        | Largeurs             |
| --------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- | ------------- | -------------------- |
| Créer, Choisir, Restaurer une sauvegarde (appareil vierge)                                                                                          | Chromium, Firefox, WebKit | clair, sombre | 320, 768, 1024, 1440 |
| Annonce du code, Confirmer, refus de recopie, étape 4 avant démarrage ; impression                                                                  | Chromium, Firefox         | clair, sombre | une (1440)           |
| Feuille de récupération                                                                                                                             | Chromium, Firefox         | clair, sombre | 320, 768, 1024, 1440 |
| Étape 4 avant démarrage, avec la limite de Firefox                                                                                                  | Firefox                   | clair, sombre | 320                  |
| Refus du moteur (aucun coffre ne se crée)                                                                                                           | WebKit                    | clair, sombre | 1280, 320            |
| Étape 4 PRÊTE — **état simulé**                                                                                                                     | Chromium                  | clair, sombre | 320, 768, 1024, 1440 |
| Verrouiller, Rouvrir, Sauvegarder, sauvegarde refusée, Restaurer sur un autre appareil, Récupérer (préparer), Récupérer, Révoquer, Parcours terminé | Chromium                  | clair, sombre | 320, 1024            |
| Vérifier votre code (après un rechargement)                                                                                                         | Chromium                  | clair, sombre | 320, 1024            |
| Création, choix, étape 4 prête simulée, focus — sous `forced-colors: active`                                                                        | Chromium                  | système       | 1280                 |
| Démarrage en cours, barre indéterminée, mouvement non réduit — **état simulé**                                                                      | Chromium                  | clair         | 1280                 |

L'étape 4 prête et le démarrage en cours sont des SIMULATIONS de l'état publié : l'épreuve pose la
ligne d'état du cycle (`cycle:application-demarree`, `cycle:demarrage-en-cours`) que le module du
cycle de vie publie d'ordinaire, et aucune machine virtuelle ne tourne. La preuve réelle de l'étape
4 prête — aide repliée, bloc de démarrage retiré, cadre à moins de 380 px, focus — reste l'E2E
clavier.

Ne sont PAS capturés : l'étape 4 pendant un vrai démarrage et avec Rails affiché dans le cadre ; le
message « Sauvegarde prête » et la restauration réelle d'une archive, puis l'écran qui la suit (un
coffre jamais démarré n'a rien à sauvegarder, et la suite ne démarre rien) ; les écrans des étapes 5
à 9 sous Firefox et WebKit ; les écrans de refus d'inventaire (« Ce coffre ne peut pas être ouvert
ici »). L'E2E clavier traverse les étapes réelles sans capture ni axe.

Les contrastes mesurés depuis les styles calculés des composants sont :

| Composant                                                  |         Clair |        Sombre |              Minimum vérifié |
| ---------------------------------------------------------- | ------------: | ------------: | ---------------------------: |
| Texte principal                                            |       17,74:1 |       15,16:1 |                        4,5:1 |
| Texte secondaire                                           |        7,56:1 |        9,94:1 |                        4,5:1 |
| Texte du bouton principal                                  |       17,74:1 |       16,88:1 |                        4,5:1 |
| Bordure du champ sur son fond                              |       16,98:1 |       15,01:1 |                          3:1 |
| Contour de « J'ai oublié ma phrase » (`--secondaire`)      |        7,56:1 |        9,94:1 |                          3:1 |
| Texte sur `--support` (refus, attente, réussite)           |       16,12:1 |       12,91:1 |                            — |
| Texte du bouton désactivé (`--secondaire` sur `--support`) |        6,87:1 |        8,47:1 |                            — |
| Lien d'évitement                                           |       17,74:1 |       16,88:1 |                            — |
| Texte sur `--survol`                                       |       14,33:1 |       10,24:1 |                            — |
| Contour de focus sur `--fond` / `--fond-page`              | 17,74 / 16,98 | 13,47 / 15,01 |                            — |
| Bordure du bouton désactivé sur son fond                   |        1,34:1 |        2,81:1 | exemptée par 1.4.3 et 1.4.11 |

Les quatre premières lignes sont recalculées à chaque exécution et versées dans
`reports/apparence/*-contrastes.json` ; la cinquième est exigée ≥ 3:1 par l'épreuve. Les autres sont
les mesures du relecteur de la PR #216 (15/09/2026, styles calculés sous Chromium), reprises ici ;
la dernière ligne est une bordure de composant inactif.

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
