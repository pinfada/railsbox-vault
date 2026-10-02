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
   confirmation en deux temps reste à #265.
5. L'ombre du thème sombre n'est plus claire (#266 m10).

## Ce qui ne change pas

L'**ordre** des étapes de l'ADR 0040, les identifiants des boutons et les gestes. Seule la place des
étapes à l'écran change autour de l'application.

## Conséquences

- Menu fermé, le panneau est `visibility: hidden` : hors de l'ordre de tabulation, sauf les gestes
  de la barre, l'attente, les refus et « Rouvrir le coffre », montrés en bandeau.
- Les épreuves qui mesuraient la position du cadre restent valables : il est désormais à 52 px du
  haut.
- Risque : les positions de la barre sont fixées en pixels ; un libellé plus long devra les revoir.
