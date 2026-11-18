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
- **Relecture de #308 (REFUSÉ `0b15250`), deux défauts corrigés.** (1) _La confirmation disait «
  rien ne sera retiré » à tort._ `lesAutresRetires` ne voyait que les TYPES de moyens, dédoublonnés
  : avec deux feuilles, ouvert par l'une, l'autre feuille partait sans être dite. Le compte de
  codes, que la page connaît déjà (`nombreDeCodes`), est transmis : « vos autres codes de
  récupération » est dit, sans liste exacte ; l'avertissement écrit au-dessus du bouton suit. (2)
  _Une révocation en vol pouvait être « annulée » ou renvoyée._ Après « Oui », la demande est EN VOL
  jusqu'à la réponse du Worker : le geste est `aria-disabled`, la confirmation ne se rouvre pas («
  Annuler » n'existe plus : la demande est partie), aucun second message ne part, et l'état dit « en
  cours… ne peut plus être annulée ». Les issues : succès (le parcours dit « N moyen(s) retiré(s) »)
  ; **tout échec reçu après l'envoi** — refus typé, Worker mort (aucune réponse), Worker rompu,
  erreur sans code — se dit de la MÊME façon : « la révocation a peut-être eu lieu, rouvrez le
  coffre pour vérifier ». Un refus typé peut en effet survenir APRÈS `revoquerToutSauf`
  (l'effacement et la copie résiduelle ne sont pas atomiques avec la publication, ADR 0026) et le
  Worker n'atteste pas la phase : « refusée » ou « rien n'a changé » seraient des affirmations que
  la page ne peut pas tenir (relecture de #308, REFUSÉ `5feee19`). Une attestation du Worker (« rien
  n'a été publié ») permettrait de dire « refusée » : c'est un changement du Worker, hors de ce lot
  « page seule », non fait. La page ne dit jamais « rien n'a été révoqué » d'une demande partie.
- **Relecture de #308 (REFUSÉ `25254ab`) : réglée par CONCEPTION, pas par un correctif de plus.**
  Les deux défauts — une sortie pressée que `disabled` n'arrête pas, un avertissement qui disparaît
  avec la navigation — avaient la même cause : l'état de la révocation était lu dans le rendu. (A)
  **Un état unique** (`src/coquille/etat-de-la-revocation.mjs`, trois phases : repos, en vol,
  incertaine), posé de façon SYNCHRONE, dans le tour de boucle de « Oui », AVANT l'envoi, et lu de
  façon synchrone AU DÉBUT du gestionnaire de chaque geste du parcours (`geste-du-parcours.mjs`). En
  vol, tous sont fermés ; après une issue incertaine, « Terminer sans révoquer » — le seul qui
  dirait « rien n'a été révoqué » — reste fermé, « Revenir à mon application » est permis.
  `disabled` reste, pour la personne, mais ne garde rien : un `click` retenu par un rendu différé
  pendant un appui (`pression-du-bouton.mjs`) ou un `dispatchEvent()` synthétique atteignent le
  gestionnaire, qui décide. (B) **Un avertissement hors du bloc** : `#parcours-incertitude`
  (`role="alert"`), une région persistante de la carte, que le nettoyage des messages au clic
  n'efface pas (`messages-de-geste.mjs`). Elle dit « en cours… ne peut plus être annulée » en vol,
  puis « a peut-être eu lieu — rouvrez votre coffre pour vérifier » ; elle ne se lève que par une
  révocation qui aboutit ou la réouverture du coffre (le document se recharge). Un échec reçu après
  l'envoi n'appelle plus `refuser` : aucune conduite « refusé », le code reste au relevé, dans la
  ligne d'état et en console. Un refus typé peut survenir après la publication (ADR 0026) et le
  Worker n'atteste pas la phase : une attestation permettrait de dire « refusée » ; c'est un
  changement du Worker, hors de ce lot « page seule », non fait. _Limite_ : l'état est celui du
  document ; rechargé, il n'est pas persisté (la personne a été invitée à rouvrir son coffre pour
  vérifier). **Écart à accepter par le propriétaire** : cette non-persistance n'est pas acceptée à
  ce jour (voir la PR #308), pas plus que l'absence du repli « Sécurité » à l'accueil et de la liste
  exacte des moyens retirés.
- **Relecture de #308 (REFUSÉ `aefe2d1`), deux points.** (1) _Annuler une NOUVELLE confirmation
  contredisait une révocation incertaine_ (« Rien n'a été révoqué » à côté d'un « a peut-être eu
  lieu »). Choix, le plus sûr : pendant l'état `incertaine`, **aucune nouvelle révocation n'est
  offerte** avant la vérification — la réouverture du coffre, qui recharge le document et donc
  l'état. Il n'y a ainsi pas de nouvelle confirmation à annuler ; le geste se dit fermé
  (`aria-disabled`) et un clic dit pourquoi (« une révocation précédente n'a pas été confirmée…
  rouvrez votre coffre pour le vérifier avant d'en demander une autre »). Rien de l'ADR 0026 ne
  l'interdit : la révocation reste rejouable (elle garde l'emplacement de la séance et retire les
  autres) ; c'est la page qui refuse d'empiler une demande sur un doute, et le texte de
  l'incertitude dit déjà de « refaire la révocation » après avoir rouvert. Conséquence : l'état
  incertain ne se lève plus que par la réouverture (plus par une seconde révocation dans le même
  document). (2) _Une relecture d'inventaire échouée après une révocation CONFIRMÉE laissait des
  moyens et un constat de feuille périmés._ Le succès tient (l'acquittement du Worker le justifie) ;
  mais l'interface INVALIDE son relevé (`inventaireRelu: false`, moyens et compte de codes
  inconnus), le constat `rapport.feuilleEprouvee` est remis à faux, le parcours n'utilise plus
  aucune de ces données comme garde et montre l'écran « Votre coffre doit être relu »
  (`ecranCourant`, paramètre `inventaireRelu`), et la région persistante dit « La révocation a été
  faite, mais l'affichage des moyens n'a pas pu être mis à jour. Rouvrez votre coffre pour le
  relire. » La reprise est la réouverture ; une relecture qui réussit ensuite rend l'inventaire
  relu.
- **Non prouvé.** L'annonce par un vrai lecteur d'écran (seules la description et le nom accessibles
  sont éprouvés, sous Chromium) ; le parcours clavier E2E sur Rails réel (il tourne en CI).
