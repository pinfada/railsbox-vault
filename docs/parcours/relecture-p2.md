# Relecture du parcours guidé (P2, #193)

<!-- Page GÉNÉRÉE par tools/relecture-parcours.mjs depuis les textes servis : ne pas la modifier à la main. -->

Cette page est destinée à **une personne non technique**, désignée par le mainteneur, pour une
relecture d'environ trois quarts d'heure. Elle reproduit, **mot pour mot**, ce que RailsBox Vault
affiche à chaque étape — elle est produite à partir des mêmes textes que la page elle-même —, puis
pose trois questions par étape. Il n'y a pas de bonne réponse : ce qui compte est ce que vous
comprenez en lisant, et ce qui vous arrête.

**Comment répondre** : sous chaque question, écrivez librement (quelques mots suffisent). Signalez
aussi tout mot inconnu, toute phrase trop longue, et tout moment où vous ne sauriez pas quoi faire.
Vos retours seront consignés dans la PR, sans votre nom.

## Ce que chaque écran affiche

Dans cet ordre : « Étape N sur 9 », le titre, ce qui va se passer, « Ce que vous avez à faire : … »,
« Durée : … » quand le geste dure, les boutons, « Étape suivante : titre de l'étape. », puis un
repli « Où suis-je ? » qui liste les neuf étapes. Le bouton qui fait passer à l'étape suivante
s'appelle « Continuer : … ». Si un code de récupération devait apparaître ailleurs que sur sa
feuille, il serait remplacé par « (code masqué) ».

Au clavier, le premier appui sur la touche Tab fait apparaître en haut de la page un lien « Aller au
parcours », qui mène directement au titre de l'étape.

Dans « Où suis-je ? », chaque étape porte l'une de ces mentions :

- étape précédente
- vous êtes ici
- à venir
- non jouée sur cet appareil : le coffre y a été restauré

### Écran : Préparation

> RailsBox Vault vérifie ce que cet appareil contient déjà.
>
> Ce que vous avez à faire : Rien : patientez quelques secondes.

## Étape 1 sur 9 — Créer votre coffre

### Écran : Ce coffre ne peut pas être ouvert ici

> RailsBox Vault a trouvé sur cet appareil un coffre qu'il ne peut pas ouvrir. Rien n'a été modifié.
> Lisez le message ci-dessous : il dit quoi faire.
>
> Ce que vous avez à faire : Suivez les indications du message.

### Écran : Créer votre coffre

> Votre coffre garde une application et ses données sur cet appareil, dans ce navigateur, protégées
> par votre secret. Cette version est expérimentale : utilisez uniquement des données d'essai. La
> protection dépend aussi du navigateur et de la version de RailsBox Vault que vous utilisez.
>
> Ce que vous avez à faire : Cliquez sur « Commencer ». Si vous avez déjà une sauvegarde d'un
> coffre, choisissez plutôt « J'ai déjà une sauvegarde ».

Boutons et champs : « Commencer », « J'ai déjà une sauvegarde ».

Messages qui peuvent s'afficher sur cet écran :

- Dans cette version de RailsBox Vault, l'application ne démarre pas dans Firefox : elle y
  fonctionne environ six fois plus lentement, et son démarrage n'a jamais abouti. Pour travailler
  dans l'application, utilisez Chrome ou Edge récents. (seulement dans Firefox)

**Questions**

1. Après avoir lu cet écran, pouvez-vous dire avec vos mots ce qu'est « un coffre » ?

   _Votre réponse :_

2. Savez-vous sur quel bouton cliquer si vous avez déjà une sauvegarde ?

   _Votre réponse :_

3. Un mot vous a-t-il arrêté ou inquiété ? Lequel ?

   _Votre réponse :_

## Étape 2 sur 9 — Choisir comment l'ouvrir

### Écran : Choisir comment l'ouvrir

> Vous choisissez le secret qui ouvrira votre coffre. Le plus simple est une phrase : plusieurs
> mots, faciles à retenir pour vous et difficiles à deviner pour les autres. Le coffre est créé dès
> que vous cliquez.
>
> Ce que vous avez à faire : Tapez votre phrase, puis cliquez sur « Créer mon coffre ».
>
> Durée : Après votre clic, le coffre fait un calcul volontairement lent, pour qu'on ne puisse pas
> deviner votre phrase en essayant. Comptez moins d'une seconde (dans Firefox : « environ 2
> seconde(s) ») sur ce navigateur ; sur un appareil très occupé, cela peut aller jusqu'à une minute
> et demie. L'onglet peut sembler figé : ne le fermez pas.

Boutons et champs : « Votre phrase » (champ), « Créer mon coffre » ou « Ouvrir mon coffre », « Créer
mon coffre avec une passkey » ou « Ouvrir mon coffre avec ma passkey ».

Messages qui peuvent s'afficher sur cet écran :

- Dans cette version de RailsBox Vault, l'application ne démarre pas dans Firefox : elle y
  fonctionne environ six fois plus lentement, et son démarrage n'a jamais abouti. Pour travailler
  dans l'application, utilisez Chrome ou Edge récents. (seulement dans Firefox)
- Ce navigateur connaît les passkeys (empreinte, visage, code de l'appareil ou clé de sécurité).
  Toutes ne savent pas protéger un coffre : si la vôtre ne le sait pas, RailsBox Vault vous le dira,
  et vous pourrez utiliser une phrase.
- Ouverture en cours… Ne fermez pas l'onglet.
- Votre coffre est ouvert.

**Questions**

1. Comprenez-vous que le coffre est créé dès le clic, et qu'il faudra retenir la phrase ?

   _Votre réponse :_

2. L'annonce de durée (« l'onglet peut sembler figé ») vous aurait-elle évité de fermer la page ?

   _Votre réponse :_

3. La phrase sur les passkeys est-elle claire, ou vaudrait-il mieux ne pas en parler ?

   _Votre réponse :_

## Étape 3 sur 9 — Recevoir et confirmer votre code de récupération

### Écran : Recevoir votre code de récupération

> Si vous oubliez votre phrase, seul un code de récupération pourra rouvrir votre coffre. Sans lui,
> une phrase oubliée est un coffre perdu, et personne ne peut vous aider. Ce code ne s'affichera
> QU'UNE SEULE FOIS : préparez une feuille de papier et un stylo avant de cliquer.
>
> Ce que vous avez à faire : Quand vous êtes prêt à écrire, cliquez sur « Afficher mon code de
> récupération ».

Boutons et champs : « Afficher mon code de récupération ».

Messages qui peuvent s'afficher sur cet écran :

- Ce coffre porte déjà N codes de récupération. En afficher un nouveau n'efface aucun des précédents
  : tous ouvrent ce coffre tant que vous n'en retirez aucun. Une sauvegarde faite avant ce nouveau
  code ne le connaît pas : refaites-en une à l'étape 6.

### Écran : Recopier votre code de récupération

> Voici votre code. Il ne sera plus jamais affiché, et rien sur cet appareil n'en garde de copie.
> Recopiez-le à la main, avec le numéro de version, et rangez la feuille ailleurs que près de cet
> appareil.
>
> Ce que vous avez à faire : Recopiez le code et le numéro de version, puis cliquez sur « J'ai
> recopié mon code ».

Boutons et champs : « J'ai recopié mon code ».

Messages qui peuvent s'afficher sur cet écran :

- Numéro de version à noter à côté du code : N. Recopiez les 7 groupes de 4 symboles exactement. Ce
  code ne sera plus jamais affiché.

### Écran : Confirmer votre code de récupération

> Le code n'est plus affiché. Pour être sûr que votre feuille est juste, retapez-le en le lisant sur
> votre papier. Vous ne pourrez pas continuer tant qu'il n'est pas confirmé.
>
> Ce que vous avez à faire : Tapez les 28 symboles de votre feuille (les tirets et les espaces sont
> libres), puis cliquez sur « Confirmer mon code ». Vous pouvez aussi appuyer sur Entrée.

Boutons et champs : « Code recopié depuis votre feuille » (champ), « Confirmer mon code », « Revoir
mon code ».

Messages qui peuvent s'afficher sur cet écran :

- Il manque des symboles : N sur 28.
- Ce code est bien formé, mais ce n'est pas celui qui vient d'être affiché. Relisez votre feuille :
  vous avez peut-être recopié un autre code. Si vous ne l'avez pas noté, cliquez sur « Revoir mon
  code ».
- Code confirmé. Gardez bien votre feuille, loin de cet appareil.

### Écran : Vérifier votre code de récupération

> Un code de récupération a déjà été affiché pour ce coffre, et il ne sera plus jamais réaffiché :
> il n'existe que sur votre feuille. Pour continuer, ouvrez votre coffre avec ce code, en le lisant
> sur votre feuille — c'est ainsi que l'on vérifie que votre feuille est juste.
>
> Ce que vous avez à faire : Si vous avez votre feuille : tapez le code, puis cliquez sur « Ouvrir
> mon coffre avec le code ». Si vous n'avez plus cette feuille, cliquez sur « Je n'ai plus cette
> feuille — afficher un nouveau code » : un coffre VERROUILLÉ n'affiche aucun code, vous l'ouvrirez
> donc d'abord avec votre phrase, et un nouveau code vous sera proposé ensuite. L'ancien code
> continue d'ouvrir ce coffre tant que personne ne le retire. Si vous n'avez ni la feuille ni la
> phrase et que vous n'avez encore rien mis dans ce coffre, abandonnez-le : dans les réglages du
> navigateur, effacez les données de ce site, rechargez la page, puis créez un nouveau coffre. Si
> vous avez déjà mis des données dans ce coffre, n'effacez rien et demandez de l'aide.

Boutons et champs : « Code de récupération » (champ), « Ouvrir mon coffre avec le code », « Je n'ai
plus cette feuille — afficher un nouveau code ».

Messages qui peuvent s'afficher sur cet écran :

- N symbole(s) sur 28.
- Code complet : aucune faute de recopie détectée.
- Ouverture en cours… Ne fermez pas l'onglet.
- Votre coffre est ouvert.

### Écran : Vérifier votre code de récupération

> Un code de récupération a déjà été affiché pour ce coffre, et il ne sera plus jamais réaffiché :
> il n'existe que sur votre feuille. Pour continuer, ouvrez votre coffre avec ce code, en le lisant
> sur votre feuille — c'est ainsi que l'on vérifie que votre feuille est juste.
>
> Ce que vous avez à faire : Si vous avez votre feuille : cliquez sur « Verrouiller mon coffre »,
> puis ouvrez le coffre avec le code que vous y avez recopié. Si vous n'avez plus cette feuille,
> cliquez sur « Je n'ai plus cette feuille — afficher un nouveau code » : un nouveau code sera
> affiché, une seule fois, et vous le recopierez sur une feuille neuve. L'ancien code continue
> d'ouvrir ce coffre tant que personne ne le retire. Si quelqu'un d'autre a vu votre feuille, c'est
> un autre geste : allez à l'étape 9 et révoquez les autres moyens d'ouvrir ce coffre.
>
> Durée : Le verrouillage prend quelques secondes.

Boutons et champs : « Je n'ai plus cette feuille — afficher un nouveau code », « Verrouiller mon
coffre ».

Messages qui peuvent s'afficher sur cet écran :

- Verrouillage en cours… Ne fermez pas l'onglet.
- Ce coffre porte déjà N codes de récupération. En afficher un nouveau n'efface aucun des précédents
  : tous ouvrent ce coffre tant que vous n'en retirez aucun. Une sauvegarde faite avant ce nouveau
  code ne le connaît pas : refaites-en une à l'étape 6.

**Questions**

1. Avant de cliquer, avez-vous compris que le code ne s'affichera qu'une fois ?

   _Votre réponse :_

2. Savez-vous ce qu'il faut recopier (le code ET le numéro de version) et où ranger la feuille ?

   _Votre réponse :_

3. Si la page se recharge avant la confirmation, l'écran « Vérifier votre code » vous dit-il quoi
   faire — y compris demander une nouvelle feuille si vous avez perdu la vôtre, et comprenez-vous
   que l'ancienne continue d'ouvrir le coffre ?

   _Votre réponse :_

## Étape 4 sur 9 — Travailler dans l'application

### Écran : Travailler dans l'application

> L'application s'exécute entièrement dans votre navigateur. Ce que vous y écrivez est enregistré
> dans votre coffre, sur cet appareil.
>
> Ce que vous avez à faire : Cliquez sur « Démarrer l'application », attendez qu'elle s'affiche,
> puis utilisez-la. Quand vous avez fini, passez à l'étape suivante.
>
> Durée : Le premier démarrage installe l'application : comptez environ deux minutes, parfois
> davantage sur un appareil lent ou occupé. Les démarrages suivants sont plus courts. Pendant ce
> temps, l'onglet peut sembler figé : ne le fermez pas. La progression s'affiche sous le bouton.

Boutons et champs : « Démarrer l'application », « Reprendre l'installation » (seulement si une
installation a été interrompue), l'application elle-même, une fois démarrée, « Continuer : » suivi
du titre de l'étape suivante.

Quand l'application est démarrée, les explications ci-dessus se replient sous « Aide pour cette
étape » (un clic ou la touche Entrée les rouvre), le bouton « Démarrer l'application » disparaît, et
l'application remonte près du haut de la page. Au-dessus d'elle, un repli « Détails du relais
applicatif » contient des informations techniques, qu'il n'est pas utile d'ouvrir.

Messages qui peuvent s'afficher sur cet écran :

- Démarrage en cours depuis N seconde(s), sur environ deux minutes. Le coffre travaille : N signe(s)
  de vie reçu(s).
- Le coffre travaille : N signe(s) de vie reçu(s).
- En attente du premier signe de vie du coffre.
- L'application est démarrée : elle s'affiche ci-dessous.
- Reprise de l'installation en cours… Ne fermez pas l'onglet.

### Écran : Travailler dans l'application

> Dans cette version de RailsBox Vault, l'application ne démarre pas dans Firefox : elle y
> fonctionne environ six fois plus lentement, et son démarrage n'a jamais abouti. Pour travailler
> dans l'application, utilisez Chrome ou Edge récents.
>
> Ce que vous avez à faire : Ouvrez RailsBox Vault dans Chrome ou Edge récents et créez-y votre
> coffre. Le coffre créé dans ce navigateur-ci est encore vide : vous pouvez l'abandonner en
> effaçant les données de ce site dans les réglages du navigateur.

**Questions**

1. L'attente de deux minutes est-elle annoncée assez clairement pour que vous patientiez ?

   _Votre réponse :_

2. La progression affichée pendant le démarrage vous rassure-t-elle ?

   _Votre réponse :_

3. Comprenez-vous que ce que vous écrivez reste sur cet appareil ?

   _Votre réponse :_

## Étape 5 sur 9 — Verrouiller et rouvrir

### Écran : Verrouiller votre coffre

> Verrouiller arrête l'application, enregistre tout, et referme le coffre : plus rien n'est lisible
> sans votre secret. La page se recharge ensuite. Le coffre se verrouille aussi tout seul après un
> moment sans activité.
>
> Ce que vous avez à faire : Cliquez sur « Verrouiller mon coffre », puis rouvrez-le avec votre
> phrase.
>
> Durée : Le verrouillage prend quelques secondes.

Boutons et champs : « Verrouiller mon coffre », l'application elle-même, une fois démarrée.

Messages qui peuvent s'afficher sur cet écran :

- Verrouillage en cours… Ne fermez pas l'onglet.

### Écran : Rouvrir votre coffre

> Votre coffre est verrouillé. Il s'ouvre avec la phrase que vous avez choisie. Si vous avez noté un
> numéro de version sur votre feuille, tapez-le : il empêche qu'on vous rende une copie plus
> ancienne de votre coffre sans que vous le sachiez.
>
> Ce que vous avez à faire : Tapez votre phrase, puis cliquez sur « Ouvrir mon coffre ».
>
> Durée : Après votre clic, le coffre fait un calcul volontairement lent, pour qu'on ne puisse pas
> deviner votre phrase en essayant. Comptez moins d'une seconde (dans Firefox : « environ 2
> seconde(s) ») sur ce navigateur ; sur un appareil très occupé, cela peut aller jusqu'à une minute
> et demie. L'onglet peut sembler figé : ne le fermez pas.

Boutons et champs : « Numéro de version noté sur votre feuille (facultatif) » (champ), « Votre
phrase » (champ), « Créer mon coffre » ou « Ouvrir mon coffre », « Créer mon coffre avec une passkey
» ou « Ouvrir mon coffre avec ma passkey », « J'ai oublié ma phrase : utiliser mon code de
récupération ».

Messages qui peuvent s'afficher sur cet écran :

- Ce coffre s'ouvre aussi avec votre passkey.
- Ouverture en cours… Ne fermez pas l'onglet.
- Votre coffre est ouvert.

**Questions**

1. Savez-vous ce que « verrouiller » change, et que la page va se recharger ?

   _Votre réponse :_

2. Le champ « numéro de version » vous paraît-il utile, ou déroutant ?

   _Votre réponse :_

3. Si la phrase est refusée, le message vous rassure-t-il (rien de perdu, essais illimités) ?

   _Votre réponse :_

## Étape 6 sur 9 — Sauvegarder votre coffre

### Écran : Sauvegarder votre coffre

> Une sauvegarde est un fichier qui contient tout votre coffre, toujours protégé. L'application est
> arrêtée le temps de la sauvegarde. Le fichier est enregistré par votre navigateur, comme un
> téléchargement : gardez-en une copie ailleurs que sur cet appareil (clé USB, autre ordinateur).
>
> Ce que vous avez à faire : Cliquez sur « Sauvegarder mon coffre ». Si le navigateur ne
> l'enregistre pas tout seul, cliquez sur « Enregistrer la sauvegarde ».
>
> Durée : La sauvegarde prend de quelques secondes à quelques minutes, selon la taille du coffre et
> l'appareil. Ne fermez pas l'onglet.

Boutons et champs : « Sauvegarder mon coffre », « Enregistrer la sauvegarde » (lien), « Continuer :
» suivi du titre de l'étape suivante.

Messages qui peuvent s'afficher sur cet écran :

- Sauvegarde en cours… Ne fermez pas l'onglet.
- Sauvegarde prête. Votre navigateur l'enregistre sous le nom « coffre.rbvault » ; si rien ne s'est
  enregistré, cliquez sur « Enregistrer la sauvegarde ». Pensez à redémarrer l'application si vous
  voulez continuer à l'utiliser.

**Questions**

1. Comprenez-vous que la sauvegarde est un fichier téléchargé, à copier ailleurs ?

   _Votre réponse :_

2. Savez-vous que l'application est arrêtée pendant la sauvegarde ?

   _Votre réponse :_

3. Que feriez-vous si le téléchargement ne démarrait pas ?

   _Votre réponse :_

## Étape 7 sur 9 — Restaurer sur un autre appareil

### Écran : Restaurer sur un autre appareil

> Votre sauvegarde permet de retrouver votre coffre sur un autre appareil, dans un autre navigateur
> ou à une autre adresse. Il s'y ouvrira avec votre code de récupération. On ne restaure jamais
> par-dessus un coffre existant : faites-le là où il n'y en a pas encore.
>
> Ce que vous avez à faire : Sur l'autre appareil, ouvrez RailsBox Vault, choisissez « J'ai déjà une
> sauvegarde » et donnez le fichier. Pour continuer ici, cliquez sur le bouton ci-dessous.

Boutons et champs : « Continuer : » suivi du titre de l'étape suivante.

### Écran : Restaurer une sauvegarde

> Le coffre contenu dans la sauvegarde est recopié sur cet appareil, puis vérifié. Rien n'est écrit
> si le fichier est abîmé. Le coffre restauré s'ouvre ensuite avec votre code de récupération.
>
> Ce que vous avez à faire : Choisissez le fichier de sauvegarde, puis cliquez sur « Restaurer ma
> sauvegarde sur cet appareil ».
>
> Durée : La restauration prend de quelques secondes à quelques minutes, selon la taille du coffre
> et l'appareil. Ne fermez pas l'onglet.

Boutons et champs : « Fichier de sauvegarde » (champ), « Restaurer ma sauvegarde sur cet appareil ».

Messages qui peuvent s'afficher sur cet écran :

- Restauration en cours… Ne fermez pas l'onglet.
- Sauvegarde restaurée et vérifiée. Ouvrez maintenant le coffre avec votre code — avec un code qui
  existait quand la sauvegarde a été faite.

**Questions**

1. Comprenez-vous qu'on ne restaure pas là où il y a déjà un coffre ?

   _Votre réponse :_

2. Si le fichier est abîmé, le message vous dit-il quoi faire ?

   _Votre réponse :_

3. Savez-vous avec quoi le coffre restauré s'ouvrira ensuite ?

   _Votre réponse :_

## Étape 8 sur 9 — Récupérer votre coffre avec le code

### Écran : Récupérer votre coffre avec le code

> Si vous avez oublié votre phrase, le code de récupération rouvre votre coffre. Pour vous
> entraîner, verrouillez d'abord le coffre : vous le rouvrirez avec le code.
>
> Ce que vous avez à faire : Cliquez sur « Verrouiller mon coffre ».
>
> Durée : Le verrouillage prend quelques secondes.

Boutons et champs : « Verrouiller mon coffre ».

Messages qui peuvent s'afficher sur cet écran :

- Verrouillage en cours… Ne fermez pas l'onglet.

### Écran : Récupérer votre coffre avec le code

> Le code de récupération de votre feuille rouvre votre coffre, même sans la phrase. Le numéro de
> version noté à côté du code protège contre une copie plus ancienne : tapez-le aussi.
>
> Ce que vous avez à faire : Tapez le numéro de version et le code de votre feuille, puis cliquez
> sur « Ouvrir mon coffre avec le code ».

Boutons et champs : « Numéro de version noté sur votre feuille (facultatif) » (champ), « Code de
récupération » (champ), « Ouvrir mon coffre avec le code ».

Messages qui peuvent s'afficher sur cet écran :

- N symbole(s) sur 28.
- Code complet : aucune faute de recopie détectée.
- Ouverture en cours… Ne fermez pas l'onglet.
- Votre coffre est ouvert.

**Questions**

1. Comprenez-vous que le code sert quand la phrase est oubliée ?

   _Votre réponse :_

2. Savez-vous où trouver le numéro de version à taper ?

   _Votre réponse :_

3. Si vous faites une faute de recopie, le message vous aide-t-il à la trouver ?

   _Votre réponse :_

## Étape 9 sur 9 — Révoquer en urgence

### Écran : Révoquer en urgence

> Si vous pensez que quelqu'un connaît votre phrase ou a trouvé votre feuille, révoquez : tout ce
> qui ouvre ce coffre est retiré, SAUF le moyen que vous venez d'utiliser. Attention : les
> sauvegardes déjà faites restent ouvrables par les anciens moyens. Détruisez-les si elles risquent
> de tomber entre de mauvaises mains, puis faites une nouvelle sauvegarde.
>
> Ce que vous avez à faire : Seulement si c'est nécessaire : cliquez sur « Révoquer tous les autres
> moyens d'ouvrir ce coffre ». Notez ensuite le nouveau numéro de version sur votre feuille.

Boutons et champs : « Révoquer tous les autres moyens d'ouvrir ce coffre ».

Messages qui peuvent s'afficher sur cet écran :

- N moyen(s) retiré(s). Nouveau numéro de version à noter sur votre feuille : V.
- Aucun autre moyen n'ouvrait ce coffre : rien n'a été retiré, et votre feuille reste juste.

### Écran : Parcours terminé

> Seul le moyen que vous avez utilisé pour ouvrir ce coffre l'ouvre désormais. Les sauvegardes déjà
> faites restent ouvrables par les anciens moyens : détruisez-les si elles risquent de tomber entre
> de mauvaises mains, puis faites une nouvelle sauvegarde.
>
> Ce que vous avez à faire : Notez sur votre feuille le numéro de version indiqué ci-dessus. Il n'y
> a rien d'autre à faire.

**Questions**

1. Savez-vous QUAND il faut révoquer (et quand il ne le faut pas) ?

   _Votre réponse :_

2. Comprenez-vous que les sauvegardes déjà faites restent ouvrables par les anciens moyens ?

   _Votre réponse :_

3. Savez-vous quoi faire après la révocation (noter la version, refaire une sauvegarde) ?

   _Votre réponse :_

## Messages quand quelque chose ne va pas

Voici les messages qu'une personne peut lire quand une opération est refusée, regroupés par ce
qu'ils demandent de faire. Signalez ceux que vous ne comprenez pas, ou qui ne vous disent pas quoi
faire.

### Ce qu'il faut faire : recommencer

- Un coffre existe déjà sur cet appareil : rien n'a été écrasé. Rechargez la page, et ouvrez le
  coffre existant.
- La demande a été annulée, ou personne n'y a répondu à temps. Rien n'a été perdu. Vous pouvez
  recommencer.
- Ce coffre est déjà ouvert dans un autre onglet ou une autre fenêtre. Fermez l'autre onglet, puis
  réessayez ici.
- Il n'y a plus assez de place pour ce coffre dans ce navigateur. Libérez de l'espace sur
  l'appareil, puis réessayez.
- La restauration de ce coffre n'est pas allée jusqu'au bout. Restaurez à nouveau la sauvegarde,
  puis ouvrez le coffre tout de suite après.
- L'installation n'a pas pu être vérifiée sur cet appareil. Rien n'est déclaré installé :
  recommencez.
- Le coffre doit d'abord être ouvert pour faire cela. Rouvrez-le, puis recommencez.
- La préparation des données de ce coffre a été interrompue avant la fin : rien de ce que vous aviez
  enregistré n'a été touché. Rechargez la page puis réessayez ; si le bouton « Reprendre
  l'installation » apparaît, utilisez-le.
- Le coffre doit d'abord être ouvert pour faire cela. Ouvrez-le, puis recommencez.
- Une restauration a été interrompue avant la fin : le coffre n'est pas prêt. Choisissez de nouveau
  le même fichier de sauvegarde et relancez la restauration.
- Le coffre a cessé de répondre. Par sécurité, il ne fait plus rien tant que vous ne l'avez pas
  rouvert. Ce qui a été enregistré avant reste enregistré. Cliquez sur « Rouvrir le coffre ».
- L'opération n'a pas abouti, sans cause identifiée. Rechargez la page puis réessayez. Si cela se
  reproduit, notez le détail technique ci-dessous et demandez de l'aide.
- Une installation précédente a été interrompue avant la fin. Rien n'a été écrasé. Si le bouton «
  Reprendre l'installation » apparaît, utilisez-le.
- L'application s'est arrêtée. Cliquez de nouveau sur « Démarrer l'application ».
- L'application a demandé quelque chose que le coffre ne transmet pas. Revenez à la page précédente
  de l'application et réessayez.
- La page n'a pas été affichée parce que le coffre venait d'être verrouillé. Rouvrez le coffre pour
  continuer.
- Le coffre a refusé une lecture ou une écriture incohérente : rien n'a été écrit à moitié.
  Rechargez la page puis réessayez. Si cela se reproduit, notez le détail technique ci-dessous et
  demandez de l'aide.
- Le navigateur n'a pas pu relire toutes les données du coffre. Rechargez la page puis réessayez. Si
  cela se reproduit, notez le détail technique ci-dessous et demandez de l'aide.
- Le navigateur n'a pas pu enregistrer toutes les données du coffre : ce qui avait été confirmé est
  conservé. Libérez de l'espace sur l'appareil, puis rechargez la page.
- Le coffre a été refermé pendant l'opération. Rouvrez-le, puis recommencez.
- Le navigateur n'a pas pu lire ou écrire les données du coffre. Rechargez la page puis réessayez.
  Si cela se reproduit, notez le détail technique ci-dessous et demandez de l'aide.
- Les dernières modifications, qui n'avaient pas été confirmées avant une coupure, n'ont pas été
  gardées. Ce qui avait été confirmé est conservé : continuez normalement.
- L'application a voulu enregistrer trop de choses d'un seul coup : rien n'a été enregistré à
  moitié. Rechargez la page puis réessayez. Si cela se reproduit, notez le détail technique
  ci-dessous et demandez de l'aide.
- Le coffre n'a été ouvert ici que pour être lu, et cette opération doit écrire. Rechargez la page,
  rouvrez le coffre, puis recommencez.
- Le coffre n'a pas pu confirmer l'enregistrement de vos dernières modifications. Par sécurité, il
  est arrêté. Rouvrez-le : ce qui avait été confirmé est conservé.
- Le navigateur a retiré au coffre l'accès à ses données. Par sécurité, il est arrêté. Rouvrez-le.
- Il n'y a encore rien à sauvegarder : démarrez l'application une première fois.
- Ce fichier n'est pas une sauvegarde de coffre RailsBox Vault. Rien n'a été écrit. Choisissez le
  fichier enregistré par « Sauvegarder mon coffre ».
- Ce fichier n'est pas une sauvegarde lisible. Rien n'a été écrit. Choisissez le fichier enregistré
  par « Sauvegarder mon coffre ».
- Ce fichier de sauvegarde est incomplet, souvent à cause d'un téléchargement ou d'une copie
  interrompus. Rien n'a été écrit. Enregistrez ou copiez de nouveau la sauvegarde.
- Cette sauvegarde a été abîmée ou modifiée depuis qu'elle a été faite : son contenu ne correspond
  plus. Rien n'a été écrit. Utilisez une autre copie de la sauvegarde.
- Cette sauvegarde est incohérente. Rien n'a été écrit. Utilisez une autre copie de la sauvegarde.
- La partie de cette sauvegarde qui permet de l'ouvrir par le code a été abîmée. Rien n'a été écrit.
  Utilisez une autre copie de la sauvegarde.
- Cette sauvegarde ne permet pas de vérifier que son contenu est intact. Rien n'a été écrit.
  Utilisez une sauvegarde faite par « Sauvegarder mon coffre ».
- Il n'y a pas assez de place dans ce navigateur pour restaurer cette sauvegarde. Rien n'a été
  écrit. Libérez de l'espace sur l'appareil, puis réessayez.
- La sauvegarde a été copiée, mais la vérification de la copie a échoué. Le coffre n'est pas prêt :
  relancez la restauration avec le même fichier.
- Ce moyen n'ouvre déjà plus ce coffre : rien n'a été retiré. Rechargez la page.

### Ce qu'il faut faire : recopier

- Ce que vous avez présenté n'ouvre pas ce coffre : la phrase est peut-être mal tapée (majuscules,
  accents, espaces), ou ce n'est pas le bon code. Rien n'a été perdu. Réessayez tranquillement : il
  n'y a pas de nombre d'essais limité.
- Le numéro de version que vous avez tapé est plus grand que celui de ce coffre. Relisez le numéro
  sur votre feuille. Si vous n'êtes pas sûr, videz ce champ et réessayez : le coffre s'ouvrira, mais
  sans vérifier qu'on ne lui a pas remis une copie plus ancienne.
- Le champ de la phrase est vide. Tapez une phrase de plusieurs mots, facile à retenir pour vous et
  difficile à deviner pour les autres.
- Le code a une faute de recopie : une lettre ou un chiffre est mal lu, ou deux sont inversés.
  Relisez votre feuille, symbole par symbole. Les tirets, les espaces et les majuscules n'ont pas
  d'importance.
- Le code de récupération ne s'affiche qu'une fois, et celui-ci a déjà été affiché. Ouvrez le coffre
  avec le code de votre feuille pour le vérifier ; si vous ne l'avez pas noté, demandez un NOUVEAU
  code : l'ancien ouvrira ce coffre tant que personne ne le retire.
- Ce qui a été saisi ou choisi n'a pas la forme attendue : le numéro de version est un nombre
  entier, et une restauration demande un fichier de sauvegarde. Corrigez, puis réessayez.
- Le numéro de version se tape en chiffres, à partir de 1, tel qu'il est noté sur votre feuille. Si
  vous n'en avez pas noté, laissez ce champ vide.
- Aucun fichier n'est choisi. Cliquez sur « Fichier de sauvegarde », choisissez le fichier
  enregistré par « Sauvegarder mon coffre », puis recommencez.

### Ce qu'il faut faire : attendre

- Une autre opération est en cours, ou le coffre n'est pas encore ouvert. Attendez la fin de
  l'opération en cours, puis recommencez.
- Une opération longue est déjà en cours (démarrage, sauvegarde ou restauration). Attendez qu'elle
  se termine, puis recommencez.
- Le coffre termine un enregistrement. Attendez quelques secondes, puis recommencez.
- Le coffre enregistre son état en ce moment. Attendez quelques secondes, puis recommencez.

### Ce qu'il faut faire : autre appareil ou autre navigateur

- Le fichier qui protège ce coffre sur cet appareil est abîmé. N'effacez rien. Si vous avez une
  sauvegarde, restaurez-la dans un autre navigateur ou à une autre adresse.
- Le fichier qui protège ce coffre ne correspond pas à ce coffre. N'effacez rien. Si vous avez une
  sauvegarde, restaurez-la dans un autre navigateur ou à une autre adresse.
- Le fichier qui protège ce coffre est incomplet sur cet appareil. N'effacez rien. Si vous avez une
  sauvegarde, restaurez-la dans un autre navigateur ou à une autre adresse.
- Le fichier qui protège ce coffre a été assemblé à partir de deux copies différentes. N'effacez
  rien. Si vous avez une sauvegarde, restaurez-la dans un autre navigateur ou à une autre adresse.
- Le fichier qui protège ce coffre n'est pas lisible. N'effacez rien. Si vous avez une sauvegarde,
  restaurez-la dans un autre navigateur ou à une autre adresse.
- Ce coffre ne peut pas prouver que son contenu est intact. Ne l'utilisez pas. N'effacez rien. Si
  vous avez une sauvegarde, restaurez-la dans un autre navigateur ou à une autre adresse.
- Ce navigateur ne peut pas faire le calcul qui protège le coffre. Essayez un autre navigateur
  récent : Chrome ou Edge.
- Ce navigateur ne sait pas garder un coffre. Essayez un autre navigateur récent : Chrome ou Edge.
  Rien n'a été perdu.
- Le contenu de ce coffre ne correspond pas à sa sauvegarde : il a été modifié. Ne l'utilisez pas ;
  restaurez une sauvegarde en laquelle vous avez confiance.
- Les données de ce coffre ne lui appartiennent pas. N'effacez rien. Si vous avez une sauvegarde,
  restaurez-la dans un autre navigateur ou à une autre adresse.
- Les données de ce coffre sur cet appareil ont été abîmées ou modifiées : rien n'en a été lu. Ne
  l'utilisez pas. N'effacez rien. Si vous avez une sauvegarde, restaurez-la dans un autre navigateur
  ou à une autre adresse.
- Ce navigateur n'offre pas tout ce dont le coffre a besoin. Essayez un autre navigateur récent :
  Chrome ou Edge.
- Les données de ce coffre sur cet appareil n'ont pas la taille attendue : rien n'a été modifié.
  N'effacez rien. Si vous avez une sauvegarde, restaurez-la dans un autre navigateur ou à une autre
  adresse.
- Une partie des données de ce coffre sur cet appareil est abîmée : rien n'a été deviné ni réparé.
  Ne l'utilisez pas. N'effacez rien. Si vous avez une sauvegarde, restaurez-la dans un autre
  navigateur ou à une autre adresse.
- Le coffre ne peut plus savoir quel est son dernier état enregistré sur cet appareil : rien n'a été
  deviné. Ne l'utilisez pas. N'effacez rien. Si vous avez une sauvegarde, restaurez-la dans un autre
  navigateur ou à une autre adresse.
- Cet appareil a déjà un coffre à cette adresse. On ne restaure jamais par-dessus un coffre existant
  : restaurez à une autre adresse, dans un autre navigateur, ou sur un autre appareil.
- Cet appareil a déjà un coffre à cette adresse : rien n'a été écrit. Restaurez à une autre adresse,
  dans un autre navigateur, ou sur un autre appareil.

### Ce qu'il faut faire : autre conduite, dite dans le message

- Il n'y a pas de coffre sur cet appareil. Si vous en avez créé un ailleurs, restaurez sa sauvegarde
  ici.
- Ce coffre a déjà le nombre maximal de moyens de l'ouvrir : rien n'a été ajouté. Rien n'a été
  perdu.
- Ce coffre a été fermé par une version plus récente de RailsBox Vault. Mettez l'application à jour,
  puis réessayez. Rien n'a été perdu.
- Les réglages enregistrés pour ouvrir ce coffre ne sont pas acceptables : ce coffre a peut-être été
  modifié. Rien n'a été perdu. Ouvrez-le par votre code de récupération, ou restaurez votre
  sauvegarde.
- Cette passkey ne sait pas protéger un coffre. Utilisez une phrase, ou une autre passkey.
- L'appareil a reconnu votre passkey mais n'a pas rendu ce qu'il fallait pour ouvrir le coffre.
  Utilisez une phrase, ou une autre passkey.
- Ce coffre a un format que cette version de RailsBox Vault ne sait pas utiliser pour cette
  opération. Rien n'a été perdu. Notez le détail technique ci-dessous et demandez de l'aide.
- Ce coffre date d'avant le 13 septembre 2026. Sa mise à niveau n'est pas encore disponible.
  N'effacez pas les données de ce site. Gardez vos moyens d'ouverture et toute sauvegarde. Essayez
  la sauvegarde dans un autre navigateur compatible, avec une version qui sait la lire ; sinon,
  demandez de l'aide en conservant ce coffre.
- L'application enregistrée n'appartient pas à ce coffre. Rien n'a été modifié. N'effacez pas les
  données de ce site. Essayez votre sauvegarde dans un autre navigateur compatible. Sans sauvegarde
  utilisable, demandez de l'aide en conservant ce coffre.
- Ce coffre a été utilisé après sa restauration, puis une partie de ses informations a disparu. Le
  réparer effacerait ce que vous y avez écrit depuis : rien n'a été touché. N'effacez pas les
  données de ce site, gardez votre sauvegarde, et demandez de l'aide.
- Aucune application n'est livrée avec ce coffre à cette adresse : il n'y a rien à démarrer.
- La page demandée à l'application est trop volumineuse pour être affichée ici.
- Ce coffre a atteint une limite de sécurité que cette version de RailsBox Vault ne sait pas encore
  renouveler. Rien n'a été perdu. Faites une sauvegarde, puis demandez de l'aide.
- Cette sauvegarde a été faite sans code de récupération : elle ne peut s'ouvrir nulle part
  ailleurs. Rien n'a été écrit.
- Cette sauvegarde ne s'ouvre pas par un code de récupération. Rien n'a été écrit.
- Cette sauvegarde a été faite par une version différente de RailsBox Vault, que celle-ci ne sait
  pas lire. Rien n'a été écrit.
- Cette sauvegarde ne correspond pas à ce que cet appareil attend. Rien n'a été écrit.
- Il ne reste qu'un seul moyen d'ouvrir ce coffre : il n'y a rien d'autre à retirer.

### Quand la cause n'est pas connue

- L'opération a été refusée. Rechargez la page puis réessayez. Si cela se reproduit, notez le détail
  technique ci-dessous et demandez de l'aide.
