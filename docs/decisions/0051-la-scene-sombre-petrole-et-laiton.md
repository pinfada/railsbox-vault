# ADR 0051 — La scène : une direction sombre, pétrole et laiton, et le thème clair retiré

- Statut : proposé
- Date : 2026-11-26
- Remplace : la direction utilitaire de `docs/direction-visuelle.md` (#194) pour les couleurs, les
  formes et la typographie. Complète l'[ADR 0043](0043-l-application-d-abord.md), dont les cinq
  décisions restent en vigueur.

## Contexte

Décision du mainteneur, le 26/11/2026, après un essai du parcours dans Chrome et la revue d'une
maquette des huit écrans : la carte blanche à angles droits et à ombre franche ne dit rien du
produit. Il demande une direction de haut niveau, validée sur maquette, et donne son accord pour
l'appliquer.

Constats de l'essai du même jour, sur `main` (`2fb373b`) :

- à l'entrée, sept paragraphes de limites précèdent « Commencer », qui est hors de l'écran à
  l'ouverture sur un écran de 1050 px de haut ;
- la feuille de récupération, le moment le plus grave du parcours, a l'aspect des autres écrans ;
- le rang « Étape x sur 9 » est une ligne de texte, sans repère visuel de l'avancement.

## Décision

1. **Une scène, une plaque.** La page est une scène sombre, bleu pétrole, éclairée par un dégradé.
   Les gestes de l'écran sont posés sur une plaque aux angles arrondis, coiffée d'un filet de
   laiton, large de 520 px au plus.
2. **Le laiton désigne le geste principal.** Le bouton principal de l'écran (`PRINCIPAL_DE_L_ECRAN`,
   ADR 0043) est en laiton, texte sombre. Le secondaire reste un contour. Le laiton sert aussi au
   focus, au filet de la plaque et aux crans. Le laiton du bouton est UNI : un dégradé, essayé
   d'abord, coûtait des à-coups d'affichage sous WebKit Linux à chaque apparition du bouton. À
   l'épreuve de calibrage du rendeur, la médiane des pires cas passait de 16 à 31 ms, avec des
   pointes de 138 à 336 ms au-delà du seuil de 200 ms. L'ombre portée et le `color-mix()` du bouton
   de danger ont été mesurés sans effet (bissection de la feuille, 27/11/2026, 25 essais par
   variante).
3. **La plaque est du papier.** À partir de 1024 px, la plaque des gestes est une feuille claire
   posée sur la scène : la palette est redéfinie pour tout ce qu'elle porte, et chaque composant la
   suit. Un champ de saisie est clair partout, à l'encre sombre. La feuille de récupération est une
   feuille blanche, bordée de pointillés et posée de biais ; son bouton est à l'encre, parce que le
   laiton y manquerait de contraste.
4. **Neuf crans.** Sous la ligne « Étape x sur 9 », neuf segments disent l'avancement. La page pose
   le rang sur le document (`data-rang`) à l'instant où elle écrit la ligne ; la feuille de style en
   tire les crans. Ils sont décoratifs : le rang reste dit par le texte.
5. **Le cadran.** Derrière la plaque, deux couronnes dessinées en CSS évoquent le cadran d'un
   coffre. Elles sont immobiles : leur rotation lente, essayée d'abord, coûtait des à-coups
   d'affichage sous WebKit (jusqu'à 405 ms à l'épreuve de calibrage du rendeur, pour 13 ms sans
   elle). Elles sont hors du flux, ne portent aucun contenu, et disparaissent quand l'application
   occupe l'écran, à l'impression et sous `forced-colors`.
6. **La scène occupe la fenêtre.** À partir de 1024 px, hors de l'application, la page n'est plus
   une carte au milieu du vide. À gauche, ce que l'écran dit : le titre en très grand, l'explication
   et ce qui est attendu. À droite, la plaque et ses gestes. À l'entrée, la promesse, les garanties
   et les limites tiennent le volet de gauche, et l'étape rejoint « Commencer » sur la plaque,
   visible sans défiler. Rien n'est déplacé dans le document : chaque enfant de `main` reçoit une
   rangée de la grille dans l'ordre du fichier, donc l'ordre de lecture et celui du clavier ne
   changent pas. Sous 1024 px, la page reste une seule plaque. La règle de #266 m7 (pas de carte de
   1024 px à moitié vide à l'étape 4) est tenue autrement : la plaque des gestes garde 520 px.
7. **Le thème clair est retiré.** La scène n'a qu'un thème, sombre (`color-scheme: dark`). La
   maquette validée n'en a pas d'autre, et une variante claire serait un second dessin, pas une
   inversion. L'impression reste en noir sur blanc.
8. **Aucune ressource distante, toujours.** Ni police téléchargée, ni image : la CSP de la coquille
   ne change pas. Les titres demandent « Bricolage Grotesque » si elle est installée, puis Inter,
   puis la police du système.

9. **Rouvrir a sa propre composition.** C'est l'écran de tous les jours : un verrou de laiton, le
   titre en très grand, une seule colonne. La promesse s'y réduit à une ligne, et les garanties
   comme les limites, lues à la création, n'y sont plus montrées. Derrière, une silhouette floue
   d'application : un décor fixe de la feuille de style, qui ne lit ni ne montre rien du coffre.
10. **La sauvegarde est un objet.** L'annonce de sa taille est écrite sur une plaque sombre, à côté
    d'un petit cadran. Le geste qui retire (`data-danger`) porte un bord épais et un fond teinté.
11. **Pendant le démarrage, un cadran tourne** autour de la phrase d'attente. C'est un décor : la
    durée et l'avancement restent dits par le texte et par la barre de progression.
12. **L'application garde son thème.** Le cadre applicatif déclare `color-scheme: light dark` : sans
    cela, il hériterait du thème sombre de la scène, et une application claire deviendrait sombre.

## Ce qui ne change pas

Les textes, l'ordre des étapes (ADR 0040), les identifiants, les gestes et leur ordre dans le
document. Les places réservées qui empêchent un bouton de bouger sous la main (#251, #266) sont
conservées telles quelles. Aucun module de `src/` n'est touché.

## Ce qui n'est pas dans cette tranche

La maquette validée va plus loin. Chaque point ci-dessous change un comportement ou un texte, et
demande sa propre tranche, avec ses épreuves :

- les groupes du code que l'on coche au fur et à mesure de la recopie, et la jauge de la phrase ;
- la réouverture qui ramène à l'application au lieu de passer à l'étape 6 ;
- le temps écoulé et les phases nommées pendant le démarrage ;
- la révocation à glisser (modèle de récupération : accord du mainteneur requis) ;
- des textes plus courts, dont le titre de la réouverture ;
- sur un petit écran, « Commencer » avant les limites, ce qui demande de changer l'ordre du document
  ;
- la page d'attente servie dans le cadre applicatif, qui reste sans mise en forme.

## Conséquences

- Les personnes qui ont besoin d'un fond clair le perdent. C'est le coût assumé de la décision 7 ;
  `forced-colors` reste pris en charge, et l'impression est claire.
- Les mesures de contraste de `docs/direction-visuelle.md` sont à refaire sur la nouvelle palette.
  Les quatre premières le sont à chaque exécution de `npm run test:apparence`.
- Le cadran du démarrage (décision 11) tourne pendant le démarrage de la machine virtuelle. Son coût
  a été mesuré le 27 novembre 2026, sur `00c475c`, avant que les cadrans de fond soient immobilisés
  : huit démarrages à froid par côté, alternés, sous Chromium sans carte graphique. Le p50 passe de
  168,0 s à 168,5 s, pour un bruit de 7 à 8 s : l'écart n'est pas mesurable. Le processus graphique
  consomme 2,9 s de calcul en plus sur 360. Ni Firefox, ni WebKit, ni un poste plus lent ne sont
  mesurés, et un écart de 1 à 2 s ne peut être ni affirmé ni exclu.
- La scène ne vaut qu'à l'écran. À l'impression, quelle que soit la largeur de la page, il ne reste
  que la feuille claire, droite, en noir sur blanc.
- Les captures de référence des deux thèmes deviennent identiques ; les épreuves restent jouées dans
  les deux, parce que le moteur continue d'annoncer la préférence du système.
