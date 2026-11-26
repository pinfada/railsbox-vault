# Conduire la séance de relecture — pour le mainteneur (#195)

Cette page est pour vous. Elle suppose que vous avez désigné une personne non technique. Ce qu'elle
reçoit est dans [`consignes.md`](consignes.md), ce que vous remplissez est dans
[`grille.md`](grille.md), ce qu'elle lit à chaque écran est dans
[`../relecture-p2.md`](../relecture-p2.md).

**Ce que la séance peut établir, et ce qu'elle ne peut pas.** Elle établit si UNE personne comprend
le parcours sans aide. Elle n'établit rien de la sécurité du produit, et elle ne lève aucun palier :
`docs/vision.md` et `SECURITY.md` (§ « Gates d'utilisation ») font foi. Le critère « une personne
non technique a parcouru le chemin nominal et ses trois échecs sans aide » de #195 n'est coché **que
par vous**, après la séance, sur la grille remplie.

## Le matériel

- Un ordinateur **avec Chrome ou Edge récent**, un profil neuf (aucune extension, aucun coffre
  existant à cette adresse).
- **L'adresse publiée**, ouverte à la main. Tant qu'aucune adresse n'est publiée, la séance ne peut
  pas se tenir : ne la faire ni sur `localhost` ni sur une version de développement.
- Une connexion qui supporte environ 200 Mo, et de la mémoire libre : le navigateur a dépassé 1,5 Go
  au plus fort du démarrage (`docs/limites-de-cette-version.md`). Fermez les autres onglets et
  applications lourdes.
- **Aucune donnée réelle** : ni la vôtre, ni celle de la personne. Elle invente sa phrase. Aucun
  gestionnaire de mots de passe qui enregistre la phrase (désactivez-le).
- Papier et stylo, pour la feuille du code de récupération.
- La grille imprimée (ou ouverte à part), un chronomètre.
- **Pour l'échec 3** : une sauvegarde altérée (voir plus bas). Un **second profil** de navigateur
  (ou une fenêtre privée, ou un second navigateur) pour l'étape 7 : restaurer exige un endroit sans
  coffre.
- Un second écran ou un enregistrement d'écran **si la personne y consent**. Sinon, des notes
  seulement. N'enregistrez jamais l'écran de l'étape 3, qui affiche le code.

## Avant la séance (vous, seul, une demi-heure)

1. Ouvrez l'adresse dans le profil neuf. Vérifiez que l'écran d'entrée dit les sept limites.
2. Faites vous-même les neuf étapes une fois, sur un coffre à vous (un autre profil), pour constater
   que le parcours aboutit. Si le démarrage de l'application échoue, **ne tenez pas la séance** :
   ouvrez une issue (un défaut du chemin nominal sous Chromium se corrige avant).
3. À l'étape 6, gardez la sauvegarde. Fabriquez-en une copie altérée (un octet retourné, dans le
   contenu) :

   ```sh
   node -e '
   const fs = require("node:fs");
   const [entree, sortie] = process.argv.slice(1);
   const o = fs.readFileSync(entree);
   const a = Buffer.from(o);
   a[12 + o.readUInt32BE(8) + 700] ^= 0x01;
   fs.writeFileSync(sortie, a);
   ' coffre-saine.rbvault coffre-alteree.rbvault
   ```

   C'est le décalage qu'utilise l'épreuve `tests/e2e/parcours-utilisateur.spec.mjs`. Une archive
   très petite pourrait ne pas atteindre cet octet : vérifiez en la choisissant vous-même à l'étape
   7 (le message doit dire « abîmée ou modifiée »).

4. Effacez ce coffre d'essai (réglages du navigateur : effacer les données du site).

## Le déroulé

Comptez environ **une heure et quart** (estimation, jamais mesurée), plus quinze minutes de marge.

1. **Accueil (5 min).** Remettez-lui `consignes.md` (ou lisez-la ensemble). Redites : on observe le
   logiciel, pas vous ; aucune donnée réelle ; vous pouvez arrêter à tout moment. Demandez si elle
   accepte vos notes (et un enregistrement d'écran).
2. **Consigne unique.** « Ouvrez cette page et allez jusqu'au bout du parcours. Pensez à voix haute.
   » Rien de plus.
3. **Étapes 1 à 9 (environ une heure).** Remplissez la grille au fur et à mesure : une case, le
   temps, ses mots exacts. Ne remplissez pas pour elle ce qu'elle n'a pas dit.
   - À l'étape 1, laissez-la lire l'écran d'entrée **sans le commenter** ; notez ce qu'elle dit des
     limites.
   - À l'étape 3, **échec 1** : quand elle retape son code, demandez-lui de changer volontairement
     un symbole, puis de corriger.
   - À l'étape 4, l'attente dure environ deux minutes : ne la meublez pas. Notez ce qu'elle fait.
   - À l'étape 5, **échec 2** : demandez-lui de taper une phrase **fausse**, puis la bonne.
   - À l'étape 7, ouvrez le second profil pour elle, puis laissez-la choisir le fichier. **Échec 3**
     : donnez-lui d'abord `coffre-alteree.rbvault`, sans rien dire du fichier, puis la sauvegarde
     saine.
   - À l'étape 9, ne l'orientez ni vers « révoquer » ni vers « terminer sans révoquer ».
4. **Questions (10 min).** Seulement à la fin : ce qui l'a arrêtée, ce qu'elle a trouvé clair, un
   mot qu'elle n'a pas compris. Notez ses mots.
5. **Clôture (5 min).** Remerciez. Effacez le coffre d'essai devant elle (données du site). Rappelez
   que ses remarques sont notées sans son nom.

## Si elle est bloquée

- Attendez **30 secondes** en silence : un blocage apparent est souvent de la lecture.
- Puis une relance **neutre** : « Que pensez-vous qu'il faut faire ? » Cochez « avec aide ».
- Après une relance sans effet, débloquez-la (montrez le bouton), cochez « bloqué », notez l'écran,
  et continuez : une séance ne s'arrête pas sur un blocage.
- **Si une donnée risque d'être perdue**, ou si le logiciel se comporte de façon inattendue (page
  blanche, erreur technique) : arrêtez, notez l'écran et l'heure, ne rechargez pas avant d'avoir
  noté ce qui s'affiche. Ce cas n'est pas un retour de relecture : c'est un défaut, à signaler à
  part.

## Ce qu'il ne faut pas dire

- **Ne pas expliquer** un écran, un mot, un bouton, ni dire « c'est normal », « bien », « presque ».
- **Ne pas montrer du doigt** le bouton à cliquer avant le temps d'attente.
- **Ne pas dire que le logiciel est « sécurisé »**, ni « fiable ». La séance n'établit rien de tel,
  et le palier d'usage est réservé aux données non sensibles.
- **Ne pas excuser** le logiciel (« c'est un prototype », « on va corriger »).
- **Ne pas juger la personne** (« vous auriez dû lire »). Ni évaluer sa vitesse.
- **Ne pas annoncer** à l'avance qu'un fichier est abîmé, ou qu'une phrase est fausse, sauf pour
  donner la consigne de se tromper volontairement aux échecs 1 et 2.
- **Ne pas la laisser saisir de donnée réelle.** Si elle commence, arrêtez-la et recommencez avec
  une phrase d'essai.

## Après la séance (le jour même)

1. Complétez la grille tant que c'est frais, **sans modifier** les cases déjà cochées. Ajoutez en
   marge ce que vous n'aviez pas eu le temps de noter, daté.
2. Relisez la **synthèse** : combien d'écrans compris sans aide, combien d'échecs conduits compris
   sans aide.
3. **Transformez la grille en issues** (étape 7) :
   - **une issue par constat** (une phrase pas comprise = une issue), pas par écran ;
   - titre : `Parcours, écran N : <ce qui n'est pas compris>` ;
   - corps : les champs de la fin de `grille.md` (écran, texte exact affiché, verbatim, gravité,
     compréhension, ce que la personne a compris à la place, navigateur et version) ;
   - labels : `lot:parcours-restes`, et `accessibility` ou `documentation` selon le cas ;
   - les gravités 0 ne donnent pas d'issue (on les garde dans la grille) ; les gravités 1 à 3 en
     donnent une ; une gravité 3 ou une perte de données possible est signalée à part, d'abord ;
   - ne pas y mettre le nom de la personne, ni la phrase qu'elle a choisie, ni aucun code de
     récupération ;
   - les textes affichés sont dans `src/coquille/textes-du-parcours.mjs` ; un texte corrigé passe
     par le cliquet des textes et par `node tools/relecture-parcours.mjs`.
4. Conservez la grille remplie **hors du dépôt public** si elle contient des éléments qui
   identifient la personne ; n'en publiez que la synthèse anonymisée.
5. Commentez #195 avec la synthèse et les liens des issues ouvertes. **Ne cochez le critère du gate
   qu'après avoir lu la grille** : c'est votre décision, pas celle d'une épreuve automatique.
