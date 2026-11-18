# ADR 0043 — L'application d'abord

- Statut : accepté
- Date : 2026-10-03
- Remplace en partie : la mise en page de `docs/direction-visuelle.md` ; complète l'ADR 0040

## Contexte

Décision du mainteneur, le 03/10/2026 :

> « Je ne suis pas convaincu par le design : nous sommes censés lancer une application, et
> l'application lancée fait un tiers de la page ; le reste n'a rien à voir. Il faut rappeler quel
> est l'objectif et la promesse, et mettre le design et le parcours client sur la promesse, pour que
> l'on comprenne rapidement de quoi il s'agit. »

Mesure sur `main` (4e1bab4) : `main` limité à 1024 px, cadre de 640 px de haut sous l'en-tête, le
rang, les textes d'étape et les gestes ; un en-tête qui ne dit que « RailsBox Vault » ; un bouton
principal noir par défaut, avec une liste d'exceptions par identifiant dans la CSS (#266 M1).

## La promesse

« Votre application, chez vous » (`docs/vision.md`) : une application qui s'ouvre comme un site mais
tourne entièrement sur l'appareil ; ses données y restent, chiffrées ; elle marche hors ligne ; on
peut la sauvegarder et la déplacer sans serveur.

## Décision

1. **La promesse à l'entrée.** Les écrans `creer` et `rouvrir` commencent par une phrase et trois
   garanties avec leur fondement (`PROMESSE`, `ECRANS_DE_L_ENTREE` dans
   `src/coquille/textes-du-parcours.mjs`), sans jargon technique.
2. **L'application occupe l'écran.** Dès le début du démarrage (`data-travail-pret="true"`, #251),
   le cadre prend toute la fenêtre sous une **barre de coffre** fixe de 52 px : titre, état « Sur
   cet appareil · chiffré », « Sauvegarder », « Verrouiller » (ou « Continuer » pendant la visite),
   et un menu « Coffre » (`details`/`summary`) qui ouvre le reste de la page en panneau latéral :
   aide, « Où suis-je ? », révocation, détails techniques. Sous 641 px, la barre se replie sur «
   Coffre ». **Rien n'est déplacé dans le document** : le cadre resterait sinon rechargé et privé de
   son port restreint (ADR 0038). Seules la mise en forme et la visibilité changent.
3. **L'attente parle la promesse** : « Votre application démarre sur cet appareil. Rien n'est envoyé
   sur Internet. », à la place de l'application, avec la progression existante ; « signe(s) de vie »
   devient « le coffre a répondu N fois » (#266 m8).
4. **Un seul bouton principal par écran** (#266 M1). Le secondaire est le style par défaut ; le
   principal est désigné par `PRINCIPAL_DE_L_ECRAN`, à côté des écrans, et marqué `data-principal`
   par la page. La révocation porte `data-danger` et passe en dernier dans sa section ; sa
   confirmation en deux temps est livrée par #265 (note du 18/11/2026, en fin de document).
5. L'ombre du thème sombre n'est plus claire (#266 m10).

## Ce qui ne change pas

L'**ordre** des étapes de l'ADR 0040, les identifiants des boutons et les gestes. Seule la place des
étapes à l'écran change autour de l'application.

## Conséquences

- Menu fermé, le panneau est `visibility: hidden` : hors de l'ordre de tabulation, sauf les gestes
  de la barre, l'attente, les refus et « Rouvrir le coffre », montrés en bandeau.
- Les épreuves qui mesuraient la position du cadre restent valables : il est désormais à 52 px du
  haut.
- ~~Risque : les positions de la barre sont fixées en pixels ; un libellé plus long devra les
  revoir.~~ Levé par R1-bis : la barre est une rangée flexible.

### R1-bis (03/10/2026, recette réelle dans Chrome)

- **Application démarrée, toutes étapes.** La mise en page « application d'abord » dépend de l'état
  « application démarrée » (`data-travail-pret`), plus du numéro d'étape : aux étapes 5 à 9, le
  cadre garde la fenêtre et les textes de l'étape vont dans le panneau du menu « Coffre ». Seule
  l'ATTENTE du démarrage reste propre aux écrans de l'application.
- **Gestes de la barre.** « Sauvegarder », « Verrouiller » et « Continuer » sont DÉPLACÉS dans
  `#gestes-de-la-barre` tant que l'application tourne, puis rendus à leur place : mêmes boutons,
  mêmes identifiants. L'ordre du DOM suit l'ordre visuel (titre, Sauvegarder, Verrouiller,
  Continuer, Coffre), donc celui du clavier. « Continuer » reste caché si son bloc d'étape l'est. Le
  cadre, lui, ne bouge jamais.
- **Titre de la barre** : le nom du coffre (`h1`), pas l'étape ; le titre de l'étape reste la cible
  du focus, masqué visuellement menu fermé.
- **Évitement** : le lien mène au cadre une fois l'application démarrée, au titre du parcours avant.
  Avant le démarrage, l'iframe est `inert` : plus d'arrêt de focus invisible.
- **Document applicatif** : `html`, `body` à 100 % et l'iframe Rails en flex ; une seule barre de
  défilement, celle de l'application. La frontière (en-têtes, CSP, port) ne change pas.

### Note du 18/11/2026 (#265) : la révocation se confirme, et suit « Terminer sans révoquer » dans le DOM

Le § 4 renvoyait la confirmation en deux temps à #265 et mettait la révocation « en dernier » par
une règle CSS (`order: 1`). Les deux sont livrés, sur la page seule : **aucun changement du Worker,
de l'enveloppe, de `src/vm/` ni des codes de refus.**

- **Deux temps.** « Révoquer tous les autres moyens d'ouvrir ce coffre » ne révoque plus : il ouvre
  une confirmation (`#revocation-confirmation`, `aria-expanded` sur le geste). Elle dit que révoquer
  est irréversible, ce qui sera retiré et ce qui reste selon le moyen de la séance
  (`MESSAGES.avertissementDeRevocation`, déjà écrit au-dessus du bouton), que les sauvegardes déjà
  faites ne changent pas, et que rien n'est retiré avant « Oui, révoquer les autres moyens ». «
  Annuler » a le focus à l'ouverture et la lit (`aria-describedby`) ; « Annuler » ou Échap referme,
  rend le focus au geste qui avait demandé et dit « Rien n'a été révoqué ». Seul « Oui » appelle le
  Worker, une fois par ouverture. La demande est oubliée quand son bloc quitte l'écran. Le composant
  (`src/coquille/confirmation-en-deux-temps.mjs`) ne porte aucun texte : #218 le réutilise.
- **La confirmation est une aide à la personne, PAS une garde de sécurité.** Un script de même
  origine envoie `revoquer-en-urgence` sans elle : le message n'a pas de paramètre (ADR 0039, § 5).
  La garde reste dans le Worker, inchangée, et c'est elle qui est éprouvée comme garde
  (`SECURITY.md`). Ce que la confirmation garantit, et que la campagne de mutation `coquille`
  éprouve : la page n'appelle pas le Worker sans demande ouverte.
- **Ordre.** « Terminer sans révoquer » (le principal de l'étape, § 4) précède la révocation dans le
  document : l'ordre de tabulation est celui de l'écran. Le `order` CSS qui les inversait est retiré
  ; la liste `BLOCS` suit le document.
- **Retenu hors de la tranche.** La liste exacte « sera retiré : votre phrase, 2 feuilles »
  demanderait que le Worker publie le type de l'emplacement de la séance : Worker touché, reporté.
  La saisie d'un mot à retaper (« REVOQUER ») est écartée : un geste de plus sans information de
  plus.
- **Non prouvé.** L'annonce par un vrai lecteur d'écran (seules la description et le nom accessibles
  sont éprouvés, sous Chromium) ; le parcours clavier E2E sur Rails réel (il tourne en CI).
